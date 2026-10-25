#!/usr/bin/env node
// tss_bridge.mjs - connects MarsNav to live suit and rover telemetry.
// Browsers cannot speak UDP, and the NASA SUITS Telemetry Stream Server (TSS) only answers UDP. This bridge polls the
// TSS once per second (its update rate) and relays each frame to the app as Server-Sent Events on localhost:
//
//   TSS (UDP :14141)  <-- [uint32 timestamp][uint32 command], big-endian --  bridge
//   TSS               --> JSON bytes (EVA.json / ROVER.json)             -->  bridge
//   bridge            --> http://localhost:8766/events (SSE)             -->  app (Execute > Telemetry: live)
//
//   node tools/tss_bridge.mjs --tss 192.168.1.20:14141 --year 2027
//   node tools/tss_bridge.mjs --demo --truth hardwork --rate 20      # built-in fake TSS, no hardware needed
//
// Endpoints: GET /events (SSE, event "tss"), GET /latest (last frame), GET /health (status JSON),
//            POST /plan (the app uplinks every re-plan), GET /plan (for a helmet display; in --demo the crew follows it).
// It never sends commands that change TSS state (only GET commands < 1000). Protocol reference: docs/09.

import dgram from "node:dgram";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMMANDS = {
  2027: [{ cmd: 0, key: "eva" }],
  2026: [{ cmd: 1, key: "eva" }, { cmd: 0, key: "rover" }],
};

/** One UDP GET: returns the parsed JSON reply, or throws on timeout / bad JSON. */
export function tssGet(host, port, command, { timeoutMs = 800 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    const req = Buffer.alloc(8);
    req.writeUInt32BE(Math.floor(Date.now() / 1000) >>> 0, 0);
    req.writeUInt32BE(command >>> 0, 4);
    const timer = setTimeout(() => { sock.close(); reject(new Error(`TSS timeout (command ${command})`)); }, timeoutMs);
    sock.once("message", (msg) => {
      clearTimeout(timer);
      sock.close();
      try { resolve(JSON.parse(msg.toString("utf8").replace(/\0+$/, ""))); } catch (e) { reject(new Error(`TSS reply is not JSON (${msg.length} bytes)`)); }
    });
    sock.once("error", (e) => { clearTimeout(timer); sock.close(); reject(e); });
    sock.send(req, port, host);
  });
}

/** The bridge itself; returns { close, state, port } once listening. */
export async function startBridge({ tss = "127.0.0.1:14141", year = 2027, hz = 1, port = 8766, host = "127.0.0.1", timeoutMs = 1500, log = console.log, onPlan = null } = {}) {
  const [tHost, tPort] = [tss.split(":")[0], Number(tss.split(":")[1] || 14141)];
  const cmds = COMMANDS[year] || COMMANDS[2027];
  const clients = new Set();
  const state = { tss: `${tHost}:${tPort}`, year, frames: 0, errors: 0, lastError: null, lastOkMs: null, latest: null, t0: Date.now() };
  let busy = false;
  const poll = async () => {
    if (busy) return;
    busy = true;
    try {
      const frame = { wallS: (Date.now() - state.t0) / 1000, year };
      for (const c of cmds) frame[c.key] = await tssGet(tHost, tPort, c.cmd, { timeoutMs });
      state.frames++;
      state.lastOkMs = Date.now();
      state.latest = frame;
      const msg = `event: tss\ndata: ${JSON.stringify(frame)}\n\n`;
      for (const res of clients) res.write(msg);
    } catch (e) {
      state.errors++;
      if (state.lastError !== e.message) log(`[bridge] ${e.message}`);
      state.lastError = e.message;
      const msg = `event: status\ndata: ${JSON.stringify({ ok: false, error: e.message })}\n\n`;
      for (const res of clients) res.write(msg);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(poll, Math.max(50, 1000 / hz));
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
    if (url.pathname === "/events") {
      res.writeHead(200, { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(`retry: 2000\nevent: status\ndata: ${JSON.stringify({ ok: true, tss: state.tss, year })}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    // plan uplink: the app posts the current plan on every re-plan; a helmet display polls GET /plan
    if (url.pathname === "/plan" && req.method === "POST") {
      let body = "";
      req.on("data", (d) => { body += d; if (body.length > 4e6) req.destroy(); });
      req.on("end", () => {
        try {
          state.plan = { ...JSON.parse(body), receivedUtc: new Date().toISOString() };
          if (onPlan) onPlan(state.plan);
          log(`[bridge] plan v${state.plan.version}${state.plan.returning ? " (RETURN)" : ""} received`);
          res.writeHead(200, { ...cors, "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) { res.writeHead(400, cors); res.end(JSON.stringify({ ok: false, error: e.message })); }
      });
      return;
    }
    if (url.pathname === "/plan") {
      res.writeHead(state.plan ? 200 : 404, { ...cors, "Content-Type": "application/json" });
      return res.end(JSON.stringify(state.plan || { error: "no plan yet" }));
    }
    if (url.pathname === "/latest") {
      res.writeHead(state.latest ? 200 : 503, { ...cors, "Content-Type": "application/json" });
      return res.end(JSON.stringify(state.latest || { error: "no frame yet" }));
    }
    if (url.pathname === "/health" || url.pathname === "/") {
      res.writeHead(200, { ...cors, "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: state.lastOkMs != null && Date.now() - state.lastOkMs < 5000, tss: state.tss, year,
        frames: state.frames, errors: state.errors, lastError: state.lastError, clients: clients.size,
        lastOkAgoS: state.lastOkMs ? (Date.now() - state.lastOkMs) / 1000 : null }));
    }
    res.writeHead(404, cors);
    res.end();
  });
  await new Promise((r) => server.listen(port, host, r));
  const actual = server.address().port;
  log(`[bridge] polling TSS${year} at udp://${state.tss} ${hz} Hz -> http://${host}:${actual}/events`);
  return {
    port: actual, state, clients: () => clients.size,
    close: () => new Promise((r) => { clearInterval(timer); for (const c of clients) c.end(); server.close(() => r()); }),
  };
}

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) o[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] == null ? true : argv[++i];
  return o;
}

async function main() {
  const a = args(process.argv.slice(2));
  if (a.help) {
    console.log("tss_bridge.mjs [--tss host:14141] [--year 2027|2026] [--hz 1] [--port 8766] [--host 127.0.0.1] [--timeout 1500]\n" +
      "               [--demo [--truth hardwork] [--rate 20] [--stops AMAL,ISSO] [--profile foot|rover]]");
    return;
  }
  let tss = a.tss || "127.0.0.1:14141", demoFollow = null, bridgeRef = null;
  const year = Number(a.year || 2027);
  if (a.demo) {
    // in-process fake TSS on a free port, flying the plan with a hidden truth
    const { FakeTss, buildHeadless } = await import("./tss_fake.mjs");
    const { sim } = await buildHeadless({ profile: a.profile || "foot", stops: String(a.stops || "AMAL,ISSO").split(","), truth: a.truth || "nominal" });
    const fake = new FakeTss(sim, { year });
    // the simulated crew follows the plan the app uplinks (POST /plan), as a real crew follows their display
    demoFollow = (plan) => {
      if (plan.returning && plan.returnCells?.length) {
        sim.route = [];
        for (let k = 0; k + 1 < plan.returnCells.length; k++) if (plan.returnCells[k] !== plan.returnCells[k + 1]) sim.route.push({ u: plan.returnCells[k], v: plan.returnCells[k + 1], ret: true });
        sim.returning = true; sim.k = 0; sim.segT = 0; sim._connect(sim.cur);
      } else if (plan.legs?.length) {
        sim._loadRoute({ legs: plan.legs.map((l) => ({ cells: l.cells, to: l.to, ev: { pts: [] } })) });
        sim._connect(sim.cur);
      }
    };
    const sock = dgram.createSocket("udp4");
    sock.on("message", (msg, r) => {
      if (msg.length < 8) return;
      const j = fake.reply(msg.readUInt32BE(4));
      if (j) sock.send(Buffer.from(JSON.stringify(j)), r.port, r.address);
    });
    await new Promise((r) => sock.bind(0, "127.0.0.1", r));
    tss = `127.0.0.1:${sock.address().port}`;
    const rate = Number(a.rate || 20);
    // the simulated EVA starts when the app connects (first /events client) and pauses while nobody is listening, so the
    // app sees it from egress at the habitat
    let last = Date.now();
    setInterval(() => {
      const now = Date.now();
      if (bridgeRef?.clients() > 0) fake.advance(((now - last) / 1000) * rate);
      last = now;
    }, 100);
    console.log(`[bridge] demo: fake TSS${year} (truth ${a.truth || "nominal"}, ${rate}x real time once the app connects) on udp://${tss}`);
  }
  bridgeRef = await startBridge({ tss, year, hz: Number(a.hz || 1), port: Number(a.port || 8766), host: a.host || "127.0.0.1", timeoutMs: Number(a.timeout || 1500),
    onPlan: (p) => demoFollow?.(p) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
