#!/usr/bin/env node
// tss_check.mjs - run the live closed loop headless against a real SUITS Telemetry Stream Server, and print what it
// learns and decides. Used to verify the integration with NASA's own TSS build (docs/09, "Test against TSS").
//
//   node tools/tss_check.mjs --tss 192.168.1.20:14142 --secs 420 [--drive] [--stops AMAL,ISSO]
//
// --tss    TSS address. TSS2027 answers telemetry requests on its per-team ports 14142-14151 (team 0 = 14142).
// --drive  also play the crew position into TSS along the plan (commands 2017/2018, the TSS-Location-App path),
//          so a bench test needs no one walking. Off by default: without it this tool only reads.
// Start the EVA in the TSS web page (or POST team=0&eva.status.started=true to port 14141) before running.
// TSS processes about one datagram per team socket per second, so reads are at 0.5 Hz and positions every 8 s.

import dgram from "node:dgram";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildHeadless } from "./tss_fake.mjs";
import { startBridge } from "./tss_bridge.mjs";
import { LiveSession } from "../engine/live.js";

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) o[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] == null ? true : argv[++i];
  return o;
}

export async function tssCheck({ tss = "127.0.0.1:14142", secs = 300, drive = false, stops = ["AMAL", "ISSO"], year = 2027, log = console.log, walkMS = 1.3 } = {}) {
  const [host, port] = [tss.split(":")[0], Number(tss.split(":")[1] || 14142)];
  const { P, sortie, stops: st } = await buildHeadless({ stops });
  const live = new LiveSession(P, sortie, { stops: st });
  const bridge = await startBridge({ tss, year, hz: 0.5, port: 0, timeoutMs: 2500, log });
  const [bx, by] = live.basePos, g = P.m.fine.grid, route = sortie.legs.flatMap((l) => l.cells);
  const sock = dgram.createSocket("udp4");
  let origin = null, walk = null;
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${bridge.port}/events`);
  const reader = res.body.getReader();
  let buf = "", n = 0, snap = null;
  while (Date.now() - t0 < secs * 1000) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!chunk.includes("event: tss")) continue;
      const f = JSON.parse(chunk.split("\ndata: ")[1]);
      if (!origin && f.eva?.imu) {
        origin = [f.eva.imu.posx ?? f.eva.imu.eva1?.posx, f.eva.imu.posy ?? f.eva.imu.eva1?.posy];
        if (drive) {
          const post = (cmd, v) => { const b = Buffer.alloc(12); b.writeUInt32BE(Math.floor(Date.now() / 1000) >>> 0, 0); b.writeUInt32BE(cmd, 4); b.writeFloatBE(v, 8); sock.send(b, port, host); };
          const tw = Date.now();
          walk = setInterval(() => {
            // follow the live session's current plan (re-plans included), as a crew member would
            const cells = live.route.filter((s) => s.v != null).map((s) => s.v);
            const k = Math.min(cells.length - 1, live.k + Math.max(1, Math.round((walkMS * 8) / g.res)));
            const [x, y] = g.cellXY(...g.rc(cells[Math.max(0, k)] ?? route[0]));
            post(2017, origin[0] + (x - bx));
            post(2018, origin[1] + (y - by));
            void tw;
          }, 8000);
        }
      }
      snap = live.ingest(f.eva, f.rover ?? null, { wallS: f.wallS });
      n++;
      if (n % 10 === 1) {
        const c = snap.loop.cal, s = snap.loop.telemetry || {};
        log(`t=${Math.round(live.t)}s  O2 ${s.o2Pct?.toFixed(2)}%  batt ${s.battPct?.toFixed(2)}%  CO2 bed ${s.scrubPct?.toFixed(2)}%  | learned: O2/met x${c.met.toFixed(2)}  batt x${c.batt.toFixed(2)}  CO2 x${c.co2.toFixed(2)}  | ${live.activity}  cross-track ${snap.loop.crossTrack.toFixed(0)} m  | plan v${live.planVersion}${live.returning ? "  RETURNING" : ""}`);
      }
    }
  }
  if (walk) clearInterval(walk);
  await reader.cancel().catch(() => {});
  await bridge.close();
  sock.close();
  return { frames: n, live, snap };
}

async function main() {
  const a = args(process.argv.slice(2));
  if (a.help) { console.log("tss_check.mjs --tss host:14142 [--secs 300] [--drive] [--stops AMAL,ISSO] [--year 2027|2026]"); return; }
  const r = await tssCheck({ tss: a.tss || "127.0.0.1:14142", secs: Number(a.secs || 300), drive: !!a.drive,
    stops: String(a.stops || "AMAL,ISSO").split(","), year: Number(a.year || 2027) });
  console.log(`\nframes: ${r.frames}`);
  for (const e of r.live.events) if (!/position fix/.test(e.event)) console.log(`  ${Math.round(e.t)} s  ${e.event}`);
  console.log(`alerts: ${(r.snap?.alerts || []).map((x) => x.text).join(" | ") || "none"}`);
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
