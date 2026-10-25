#!/usr/bin/env node
// tss_fake.mjs - a stand-in for the NASA SUITS Telemetry Stream Server, for testing without the real one.
// It flies an EVA in the simulator with a hidden "truth" (e.g. the crew working 35 % harder than planned) and answers
// TSS UDP requests exactly like TSS does: big-endian request [uint32 timestamp][uint32 command], reply = the JSON bytes.
//   TSS2027 layout (--year 2027): command 0 -> EVA.json (flat "telemetry", "imu")
//   TSS2026 layout (--year 2026): command 0 -> ROVER.json, 1 -> EVA.json (nested "telemetry.eva1", "imu.eva1")
// The position it reports is the simulated true position in TSS-like world coordinates (origin + offset, 3 m noise),
// so the app has to anchor it to the map exactly as it would with the real server.
//
//   node tools/tss_fake.mjs --stops AMAL,ISSO --truth hardwork --rate 30 --port 14141
//
// Real TSS: https://github.com/SUITS-Techteam/TSS2027 (and TSS2026); protocol in docs/09.

import dgram from "node:dgram";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { tssFrameFromSim } from "../engine/telemetry.js";
import { HR_CAL } from "../engine/estimator.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Wraps an EvaSim and produces TSS JSON for its current (true) state. */
export class FakeTss {
  constructor(sim, { origin = [-5668.5, -10045.6], year = 2027, posNoiseM = 3, seed = 11 } = {}) {
    this.sim = sim;
    this.origin = origin;
    this.year = year;
    this.posNoiseM = posNoiseM;
    let s = seed >>> 0 || 1;
    this.rand = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    this.started = true;
  }

  advance(dt) {
    let left = dt;
    while (left > 1e-9 && !this.sim.done) {
      const d = Math.min(left, 5);
      this.sim.step(d);
      left -= d;
    }
  }

  _pos() {
    const s = this.sim, [bx, by] = s.basePos, p = s.truePos || s.basePos;
    const g = () => (this.rand() + this.rand() + this.rand() + this.rand() - 2) * 1.732 * this.posNoiseM;
    return { x: this.origin[0] + (p[0] - bx) + g(), y: this.origin[1] + (p[1] - by) + g() };
  }

  /** TSS EVA.json for the current simulated second. */
  eva() {
    const s = this.sim;
    const f = tssFrameFromSim({ t: s.t, used: s.res, hw: s.m.s.hw, metW: s.metTrueW, hrCal: HR_CAL, pos: this._pos(), heading: 0,
      rand: this.rand, faults: s.faults });
    if (this.year === 2026) {
      const idle = { ...f.telemetry, heart_rate: 80 };
      return { telemetry: { eva_time: f.telemetry.eva_elapsed_time, eva1: f.telemetry, eva2: idle }, status: f.status,
        error: f.error, imu: { eva1: f.imu, eva2: { posx: this.origin[0], posy: this.origin[1], heading: 0 } } };
    }
    return f;
  }

  /** TSS2026 ROVER.json (pressurized rover block, parked at the habitat in a walking EVA). */
  rover() {
    const s = this.sim, drive = s.m.profile.kind === "vehicle", p = drive ? this._pos() : { x: this.origin[0], y: this.origin[1] };
    const batt = drive && s.m.profile.batteryWh < 1e8 ? Math.max(0, 100 * (s.m.s.hw.roverBattSOH - s.res.rbatt / s.m.profile.batteryWh)) : 100;
    return { pr_telemetry: { rover_pos_x: p.x, rover_pos_y: p.y, heading: 0, pitch: 0, roll: 0, speed: 0,
      distance_traveled: s.dist, primary_battery_level: Math.round(batt * 100) / 100, surface_incline: 0, oxygen_storage: 100,
      cabin_pressure: 14.7, lidar: [] } };
  }

  /** Reply to one TSS UDP GET command (null for an unknown command, like TSS). */
  reply(command) {
    if (this.year === 2026) return command === 0 ? this.rover() : command === 1 ? this.eva() : null;
    return command === 0 ? this.eva() : null;
  }
}

/** Build a planner, a plan and an EvaSim for a site, headless. */
export async function buildHeadless({ data = path.join(ROOT, "app/data"), profile = "foot", stops = ["AMAL", "ISSO"], truth = "nominal",
  seed = 7, sol = 2000, hour = 8.5, evaMaxH = 7 } = {}) {
  const { loadTerrain } = await import("../engine/terrain.js");
  const { nodeIO } = await import("../engine/node_io.js");
  const { Environment } = await import("../engine/environment.js");
  const { CostModel } = await import("../engine/costmodel.js");
  const { Planner } = await import("../engine/planner.js");
  const { viewshed } = await import("../engine/fields.js");
  const { EvaSim } = await import("../engine/sim.js");
  const { msFromM2020Sol } = await import("../engine/marstime.js");
  const T = await loadTerrain(nodeIO(data));
  const env = new Environment(T, JSON.parse(fs.readFileSync(path.join(data, "environment.json"), "utf8")));
  const m = new CostModel(T, env, { profile });
  const P = new Planner(m, T.site.base, { departMs: msFromM2020Sol(sol, hour), evaMaxS: evaMaxH * 3600 });
  viewshed(m.coarse, P.baseCoarse, 10);
  const f = m.coarse.factor, fg = m.fine.grid, cg = m.coarse.grid;
  for (let r = 0; r < fg.height; r++) {
    const R = Math.min(cg.height - 1, Math.floor(r / f));
    for (let c = 0; c < fg.width; c++) m.fine.los[r * fg.width + c] = m.coarse.los[R * cg.width + Math.min(cg.width - 1, Math.floor(c / f))];
  }
  const st = stops.map((id) => T.targets.find((x) => x.id === id)).filter(Boolean)
    .map((t) => ({ lon: t.lon, lat: t.lat, name: t.name, dwell_min: t.dwell_min, value: t.value, kind: t.kind }));
  const plan = P.namedSorties(st, { withFallback: false });
  if (!plan.ok) throw new Error(`no feasible plan for ${stops.join(",")}`);
  const sortie = plan.routes.balanced;
  const sim = new EvaSim(P, sortie, { seed, truth, stops: st, autoReplan: false });
  return { T, env, m, P, stops: st, sortie, sim };
}

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) o[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] == null ? true : argv[++i];
  return o;
}

async function main() {
  const a = args(process.argv.slice(2));
  if (a.help) {
    console.log("tss_fake.mjs [--port 14141] [--host 127.0.0.1] [--year 2027|2026] [--stops AMAL,ISSO] [--truth nominal|hardwork|slow|battery|softground]\n" +
      "             [--profile foot|rover] [--rate 1] [--data app/data]");
    return;
  }
  const port = Number(a.port || 14141), host = a.host || "127.0.0.1", rate = Number(a.rate || 1), year = Number(a.year || 2027);
  const { sim } = await buildHeadless({ data: a.data, profile: a.profile || "foot", stops: String(a.stops || "AMAL,ISSO").split(","),
    truth: a.truth || "nominal" });
  const fake = new FakeTss(sim, { year });
  const sock = dgram.createSocket("udp4");
  sock.on("message", (msg, rinfo) => {
    if (msg.length < 8) return;
    const command = msg.readUInt32BE(4);
    const json = fake.reply(command);
    if (!json) return;
    sock.send(Buffer.from(JSON.stringify(json)), rinfo.port, rinfo.address);
  });
  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    fake.advance(((now - last) / 1000) * rate);
    last = now;
  }, 100);
  sock.bind(port, host, () => console.log(`fake TSS${year} on udp://${host}:${port}  truth=${a.truth || "nominal"}  rate=${rate}x  (Ctrl+C to stop)`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
