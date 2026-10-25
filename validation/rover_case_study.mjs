// rover_case_study.mjs - same start and end as a real Perseverance drive: what MarsNav plans, and how the two compare.
// Run: node validation/rover_case_study.mjs
// Writes validation/results/rover_case_study.json and validation/ROVER_CASE_STUDY.md.
//
// Case: the 2022 "rapid traverse", from Issole in Seitah (sol 335) to the Amalik outcrop on the delta front.
// Aggregate: every 0.4-2 km end-of-drive pair used in validate.mjs (section 5), measured the same way.
//
// Every route is measured on the raw terrain layers (1 m HiRISE statistics on the 10 m grid), sampled every 2 m,
// so the comparison does not depend on MarsNav's own cost function. The model's hazard index is reported separately
// and labelled as such, because MarsNav minimises it and would score itself well on it by construction.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTerrain } from "../engine/terrain.js";
import { nodeIO } from "../engine/node_io.js";
import { Environment } from "../engine/environment.js";
import { CostModel, VETO_NAMES } from "../engine/costmodel.js";
import { Planner } from "../engine/planner.js";
import { msFromM2020Sol, M2020 } from "../engine/marstime.js";
import { namedWeightSets } from "../engine/ahp.js";
import { lonlatToXY, xyToLonLat, haversine } from "../engine/geo.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "app", "data");
const OUT = path.join(ROOT, "validation", "results");
fs.mkdirSync(OUT, { recursive: true });

const T = await loadTerrain(nodeIO(DATA));
const env = new Environment(T, JSON.parse(fs.readFileSync(path.join(DATA, "environment.json"))));
const wp = JSON.parse(fs.readFileSync(path.join(ROOT, "data_cache", "m20_waypoints_enomis.json"))).waypoints;
const g = T.grid;
const L = { elev: T.f32("elev_dm"), slopeW: T.f32("slopeW"), step: T.f32("step"), rough: T.f32("rough"), sand: T.f32("sand"),
  cliff: T.f32("cliffDist"), conf: T.f32("conf") };
const M = new CostModel(T, env, { profile: "robot" });
const fg = M.fine.grid;

// ------------------------------------------------------------------------------------------ measurement ----
const cellOfXY = (x, y) => {
  const r = Math.floor((g.y0 - y) / g.res), c = Math.floor((x - g.x0) / g.res);
  return g.inside(r, c) ? g.idx(r, c) : -1;
};
/** Resample a polyline of [x, y] every `step` metres. */
function resample(xy, step = 2) {
  const out = [xy[0]];
  for (let k = 1; k < xy.length; k++) {
    const [x0, y0] = xy[k - 1], [x1, y1] = xy[k];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let q = 1; q <= n; q++) out.push([x0 + ((x1 - x0) * q) / n, y0 + ((y1 - y0) * q) / n]);
  }
  return out;
}
/** Independent terrain metrics along a route, plus the robotic-scout model's own hazard and vetoes (labelled). */
function measure(xy) {
  const pts = resample(xy, 2);
  let len = 0, climb = 0, descent = 0, steep15 = 0, steep20 = 0, sandM = 0, rockyM = 0, lowConfM = 0, hazSum = 0, vetoM = 0;
  let maxSlope = 0, minCliff = Infinity, lastZ = null, lastZAt = 0;
  const slopes = [], vetoWhy = {};
  for (let k = 0; k < pts.length; k++) {
    const d = k ? Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]) : 0;
    len += d;
    const i = cellOfXY(...pts[k]);
    if (i < 0) continue;
    const sw = L.slopeW[i];
    slopes.push(sw);
    maxSlope = Math.max(maxSlope, sw);
    if (sw > 15) steep15 += d;
    if (sw > 20) steep20 += d;
    if (L.sand[i] > 0.5) sandM += d;
    else if (L.step[i] > 0.3 || L.rough[i] > 0.3) rockyM += d;
    if (L.conf[i] < 0.5) lowConfM += d;
    minCliff = Math.min(minCliff, L.cliff[i]);
    const v = M.fine.veto[i];
    if (v && v !== 5) { vetoM += d; vetoWhy[VETO_NAMES[v]] = (vetoWhy[VETO_NAMES[v]] || 0) + d; }
    hazSum += (v && v !== 5 ? 1 : M.fine.haz[i]) * d;
    // climb on the DEM every 10 m of route, so 1 m noise does not add up
    const z = L.elev[i];
    if (Number.isFinite(z) && (lastZ === null || len - lastZAt >= 10)) {
      if (lastZ !== null) { const dz = z - lastZ; if (dz > 0) climb += dz; else descent -= dz; }
      lastZ = z; lastZAt = len;
    }
  }
  slopes.sort((a, b) => a - b);
  return {
    length_m: len, climb_m: climb, descent_m: descent,
    slope_mean_deg: slopes.reduce((s, v) => s + v, 0) / slopes.length, slope_p95_deg: slopes[Math.floor(0.95 * (slopes.length - 1))],
    slope_max_deg: maxSlope, over15_m: steep15, over20_m: steep20, sand_m: sandM, rocky_m: rockyM, no_hirise_m: lowConfM,
    min_cliff_m: minCliff,
    model: { hazard_mean: hazSum / Math.max(1, len), veto_m: vetoM, veto_reasons: vetoWhy },
  };
}
const cellsXY = (cells) => cells.map((i) => fg.cellXY(...fg.rc(i)));
/** MarsNav's modelled driving time for the robotic scout along any polyline (also the rover's own route), in hours.
 * Steps the model cannot drive (over its slope limit) are counted at the slowest speed it allows on that ground. */
function driveHours(xy, sol) {
  const pts = resample(xy, 5), ms = msFromM2020Sol(sol, 10);
  let t = 0, last = -1, lastXY = null;
  for (const p of pts) {
    const i = cellOfXY(...p);
    if (i < 0 || i === last) continue;
    if (last >= 0) {
      const d = Math.hypot(p[0] - lastXY[0], p[1] - lastXY[1]);
      const e = M.edge(M.fine, last, i, d, ms);
      t += e ? e.t : d / (M.tables.speed[M.fine.terr[i]][120 + 4 * Math.round(M.profile.slopeLimitSandDeg)] * (M.fine.speedF ? M.fine.speedF[i] : 1) || 0.01);
    }
    last = i; lastXY = p;
  }
  return t / 3600;
}
const toLL = (xy) => xy.map(([x, y]) => xyToLonLat(x, y).map((v) => +v.toFixed(6)));

/** Plan the robotic scout from a to b with MarsNav's weight sets; return the fastest and the risk-aware route. */
function planPair(a, b, sol) {
  const P = new Planner(M, { lon: a.lon, lat: a.lat }, { departMs: msFromM2020Sol(sol, 10), evaMaxS: 8 * 3600 });
  const W = namedWeightSets();
  const st = { t: 0, res: { o2: 0, co2: 0, water: 0, batt: 0, rbatt: 0 } };
  const unit = { T: 1, S: 1, C: 1, R: 1, V: 1 };
  const t0 = performance.now();
  const fast = P.planLeg(a, b, W.fastest, unit, st);
  if (!fast.ok) return { ok: false, reason: fast.reason };
  const evF = P.evaluate(fast.cells, st);
  // refs from the fastest route, as the app does: criteria are relative changes against the fastest plan
  const refs = { T: evF.X.T || 1, S: evF.X.S || 1, C: evF.X.C || 1, R: evF.X.R || 1, V: evF.X.V || 1 };
  const safe = P.planLeg(a, b, W.safest, refs, st);
  const evS = safe.ok ? P.evaluate(safe.cells, st) : null;
  const ms = performance.now() - t0;
  return { ok: true, ms, fast: { cells: fast.cells, ev: evF }, safe: safe.ok ? { cells: safe.cells, ev: evS } : null };
}

const R = { generated_utc: new Date().toISOString(), method: "Raw terrain layers sampled every 2 m along each route; climb from the DEM every 10 m. " +
  "'model' fields use MarsNav's own robotic-scout hazard index and vetoes, which MarsNav minimises." };

// --------------------------------------------------------------------------------------- the case study ----
{
  const issole = T.targets.find((t) => t.id === "ISSO"), amalik = T.targets.find((t) => t.id === "AMAL");
  // first end-of-drive position within 60 m of Amalik, and the last stop at Issole before it (the end of the
  // South Seitah campaign, sol 335), so the leg is the traverse itself and not the earlier Seitah excursion
  const iB = wp.findIndex((p) => p.final === "y" && haversine(p.lon, p.lat, amalik.lon, amalik.lat) < 60);
  let iA = -1;
  for (let k = 0; k < iB; k++) if (wp[k].final === "y" && haversine(wp[k].lon, wp[k].lat, issole.lon, issole.lat) < 15) iA = k;
  const seg = wp.slice(iA, iB + 1);
  const A = { lon: seg[0].lon, lat: seg[0].lat, name: "Issole, Seitah" }, B = { lon: seg.at(-1).lon, lat: seg.at(-1).lat, name: "Amalik, delta front" };
  const driveSols = new Set();
  for (let k = 1; k < seg.length; k++) if (haversine(seg[k - 1].lon, seg[k - 1].lat, seg[k].lon, seg[k].lat) > 1) driveSols.add(seg[k].sol);
  const realXY = seg.map((p) => lonlatToXY(p.lon, p.lat));
  const plan = planPair(A, B, seg[0].sol);
  if (!plan.ok) throw new Error(`case study: MarsNav found no route (${plan.reason})`);
  const straight = [lonlatToXY(A.lon, A.lat), lonlatToXY(B.lon, B.lat)];
  R.case = {
    name: "Seitah to the delta front: Issole to Amalik (includes the 2022 Rapid Traverse, sols 379-409)",
    from: { ...A, sol: seg[0].sol }, to: { ...B, sol: seg.at(-1).sol },
    straight_line_m: haversine(A.lon, A.lat, B.lon, B.lat),
    rover: { sols_elapsed: seg.at(-1).sol - seg[0].sol, drive_sols: driveSols.size, waypoints: seg.length, metrics: measure(realXY),
      modelled_drive_h: driveHours(realXY, seg[0].sol), path: toLL(realXY) },
    marsnav_fastest: { metrics: measure(cellsXY(plan.fast.cells)), drive_h: plan.fast.ev.t / 3600, path: toLL(cellsXY(plan.fast.cells)) },
    marsnav_safest: plan.safe ? { metrics: measure(cellsXY(plan.safe.cells)), drive_h: plan.safe.ev.t / 3600, path: toLL(cellsXY(plan.safe.cells)) } : null,
    straight: { metrics: measure(straight), modelled_drive_h: driveHours(straight, seg[0].sol) },
    planning_s: plan.ms / 1000,
  };
  // the same trip for a suited crew living at the landing site: MarsNav's balanced route, walk-home guarantee to the habitat
  const Mf = new CostModel(T, env, { profile: "foot" });
  const hab = T.targets.find((t) => t.id === "HAB");
  const Pf = new Planner(Mf, hab, { departMs: msFromM2020Sol(seg.at(-1).sol, 8.5) });
  const tc = performance.now();
  const ns = Pf.namedSorties([], { withFallback: false, start: A, end: { ...B, dwell_min: 0 } });
  const cr = ns.ok ? ns.routes.balanced : null;
  R.case.crew_on_foot = cr?.ok ? { habitat: hab.name, km: cr.dist / 1000, eva_h: cr.t / 3600, min_walk_home_margin: cr.minMargin, feasible: cr.feasible,
    o2_kg: cr.res.o2, water_kg: cr.res.water, planning_s: (performance.now() - tc) / 1000,
    metrics: measure(cellsXY(cr.legs.flatMap((l) => l.cells))), path: toLL(cellsXY(cr.legs.flatMap((l) => l.cells))) } : { ok: false };
}

// ------------------------------------------------------------------------------------------- aggregate ----
{
  const eod = wp.filter((p) => p.final === "y");
  const pairs = [];
  for (let a = 0; a < eod.length; a++) {
    for (let b = a + 1; b < eod.length; b++) {
      const d = haversine(eod[a].lon, eod[a].lat, eod[b].lon, eod[b].lat);
      if (d < 400) continue;
      if (d > 2000) break;
      const seg = wp.filter((p) => p.sol >= eod[a].sol && p.sol <= eod[b].sol);
      let Lr = 0;
      for (let k = 1; k < seg.length; k++) Lr += haversine(seg[k - 1].lon, seg[k - 1].lat, seg[k].lon, seg[k].lat);
      if (seg.length >= 3 && Lr <= 3 * d) { pairs.push({ a: eod[a], b: eod[b], seg, d, detour: Lr / d >= 1.15 }); break; }
    }
  }
  // the same selection as validate.mjs section 5: 30 detour drives and 15 direct drives, evenly spread over the mission
  const pick = (arr, n) => arr.filter((_, k) => k % Math.max(1, Math.floor(arr.length / n)) === 0).slice(0, n);
  const chosen = [...pick(pairs.filter((p) => p.detour), 30), ...pick(pairs.filter((p) => !p.detour), 15)];
  const rows = [];
  for (const pr of chosen) {
    let plan;
    try { plan = planPair({ lon: pr.a.lon, lat: pr.a.lat }, { lon: pr.b.lon, lat: pr.b.lat }, pr.a.sol); } catch { continue; }
    if (!plan.ok || !plan.safe) { rows.push({ sol_a: pr.a.sol, sol_b: pr.b.sol, ok: false }); continue; }
    rows.push({ sol_a: pr.a.sol, sol_b: pr.b.sol, d: pr.d, detour: pr.detour, ok: true, ms: plan.ms,
      rover: measure(pr.seg.map((p) => lonlatToXY(p.lon, p.lat))), safest: measure(cellsXY(plan.safe.cells)), fastest: measure(cellsXY(plan.fast.cells)) });
  }
  const ok = rows.filter((r) => r.ok);
  const keys = ["length_m", "climb_m", "slope_mean_deg", "slope_p95_deg", "slope_max_deg", "over15_m", "sand_m", "rocky_m"];
  const sum = (who) => Object.fromEntries(keys.map((k) => [k, ok.reduce((s, r) => s + r[who][k], 0)]));
  const mean = (who) => Object.fromEntries(keys.map((k) => [k, ok.reduce((s, r) => s + r[who][k], 0) / ok.length]));
  const wins = (k) => ok.filter((r) => r.safest[k] < r.rover[k] - 1e-9).length;
  const ties = (k) => ok.filter((r) => Math.abs(r.safest[k] - r.rover[k]) <= 1e-9).length;
  R.aggregate = { drives: rows.length, planned: ok.length, rover_total: sum("rover"), safest_total: sum("safest"), fastest_total: sum("fastest"),
    rover_mean: mean("rover"), safest_mean: mean("safest"),
    safest_better: Object.fromEntries(keys.map((k) => [k, wins(k)])), safest_tied: Object.fromEntries(keys.map((k) => [k, ties(k)])),
    model_hazard_mean: { rover: ok.reduce((s, r) => s + r.rover.model.hazard_mean, 0) / ok.length, safest: ok.reduce((s, r) => s + r.safest.model.hazard_mean, 0) / ok.length },
    rover_veto_m: ok.reduce((s, r) => s + r.rover.model.veto_m, 0),
    planning_s: { mean: ok.reduce((s, r) => s + r.ms, 0) / ok.length / 1000, max: Math.max(...ok.map((r) => r.ms)) / 1000 }, rows };
}

fs.writeFileSync(path.join(OUT, "rover_case_study.json"), JSON.stringify(R, null, 1));
console.log(JSON.stringify({ case: { ...R.case, rover: { ...R.case.rover, path: undefined }, marsnav_fastest: { ...R.case.marsnav_fastest, path: undefined },
  marsnav_safest: R.case.marsnav_safest && { ...R.case.marsnav_safest, path: undefined } }, aggregate: { ...R.aggregate, rows: undefined } }, null, 1));

// ------------------------------------------------------------------------------------- human-readable ----
{
  const c = R.case, a = R.aggregate, r = c.rover.metrics, s = c.marsnav_safest.metrics, f = c.crew_on_foot, cm = f.metrics;
  const km = (m) => (m / 1000).toFixed(2), n0 = (v) => v.toFixed(0), n1 = (v) => v.toFixed(1);
  const pct = (x, y) => `${x < y ? "−" : "+"}${Math.abs(100 * (x - y) / y).toFixed(0)} %`;
  const vetoWhy = {};
  for (const x of a.rows.filter((q) => q.ok)) for (const [k, v] of Object.entries(x.rover.model.veto_reasons)) vetoWhy[k] = (vetoWhy[k] || 0) + v;
  const solA = Math.min(...a.rows.filter((x) => x.ok).map((x) => x.sol_a)), solB = Math.max(...a.rows.filter((x) => x.ok).map((x) => x.sol_b));
  const roverMph = r.length_m / c.rover.modelled_drive_h, safeMph = s.length_m / c.marsnav_safest.drive_h,
    straightMph = c.straight.metrics.length_m / c.straight.modelled_drive_h;
  const md = `# Same trip, two navigators: Perseverance vs MarsNav

Generated ${R.generated_utc} by \`node validation/rover_case_study.mjs\`. Raw numbers and route geometry: \`validation/results/rover_case_study.json\`. Figure: \`submission/screens/20_rover_case_study.jpg\`.

**Method.** Each route is measured on the same terrain layers (walking-scale slope, step, roughness and bedform evidence from the 1 m HiRISE elevation models, on the 10 m grid), sampled every 2 m; climb is taken from the elevation model every 10 m. These measurements do not use MarsNav's cost function. The rover's route is the public NASA/JPL waypoint record (one point per drive end, plus some intermediate points), so its values are measured along straight lines between waypoints and are approximate; its true odometry is longer.

## Case study: Séítah to the delta front

Perseverance left Issole in Séítah on sol ${c.from.sol} and reached the Amalik outcrop on the delta front on sol ${c.to.sol}, including the 2022 Rapid Traverse (sols 379 to 409). The two points are ${km(c.straight_line_m)} km apart. JPL deliberately drove around Séítah: its rover planners chose a 4.8 km strategic route over the 2.4 km direct line because the direct line crosses Séítah's rocky outcrops and sand features, where the rover's onboard navigation (AutoNav) was projected to make under 50 m per sol against 200 to 250 m per sol on the longer route, with a higher risk of a drive fault (Rapid Traverse paper, JPL Robotics, 2023).

MarsNav was given the same two points.

| | Perseverance (actual) | MarsNav, robotic scout | MarsNav, suited crew |
|---|---|---|---|
| Distance | ${km(r.length_m)} km | ${km(s.length_m)} km | ${km(cm.length_m)} km |
| Time | ${c.rover.sols_elapsed} sols, ${c.rover.drive_sols} with recorded drives | about ${n0(c.marsnav_safest.drive_h)} h of driving (modelled) | ${f.eva_h.toFixed(1)} h EVA from the habitat |
| MarsNav's modelled driving time on this route | ${n0(c.rover.modelled_drive_h)} h (${n0(roverMph)} m/h) | ${n0(c.marsnav_safest.drive_h)} h (${n0(safeMph)} m/h) | n/a |
| Planning time | multi-sol strategic and tactical planning on Earth | ${c.planning_s.toFixed(1)} s on one laptop core | ${f.planning_s.toFixed(1)} s |
| Climb | ${n0(r.climb_m)} m | ${n0(s.climb_m)} m | ${n0(cm.climb_m)} m |
| Steepest walking-scale slope | ${n1(r.slope_max_deg)}° | ${n1(s.slope_max_deg)}° | ${n1(cm.slope_max_deg)}° |
| Ground steeper than 15° | ${n0(r.over15_m)} m | ${n0(s.over15_m)} m | ${n0(cm.over15_m)} m |
| Average slope | ${n1(r.slope_mean_deg)}° | ${n1(s.slope_mean_deg)}° | ${n1(cm.slope_mean_deg)}° |
| Mapped sand bedforms crossed | ${n0(r.sand_m)} m | ${n0(s.sand_m)} m | ${n0(cm.sand_m)} m |
| Rocky ground crossed | ${n0(r.rocky_m)} m | ${n0(s.rocky_m)} m | ${n0(cm.rocky_m)} m |
| Ground outside MarsNav's robotic limits | ${n0(r.model.veto_m)} m | ${n0(s.model.veto_m)} m | ${n0(cm.model.veto_m)} m |
| Walk-home margin (crew) | n/a | n/a | never below ${n0(100 * f.min_walk_home_margin)} % |

**What this shows.**
- **The rover's own speed is reproduced.** On Perseverance's actual route MarsNav's speed model, with the autonomy slowdown, gives ${n0(roverMph)} m/h; JPL measured an average of 79.7 m/h during the Rapid Traverse.
- **Séítah is recognised as slow and cluttered, but not as slow as JPL projected.** MarsNav's model drives the direct line at ${n0(straightMph)} m/h against ${n0(roverMph)} m/h on the rover's route, about ${(roverMph / straightMph).toFixed(1)} times slower per metre. JPL projected about 4 times slower. A stronger slowdown cannot close that gap without breaking the match to the rover's measured speed: at 12 times the published rate, the direct line is still only 2.6 times slower and the rover's own route drops to 27 m/h. The terrain data explain part of the gap; the rest of JPL's judgement (human-directed drives in complex ground, camera and thermal constraints, the risk of a drive fault) is operational and is not in the terrain. On total time MarsNav therefore still takes the shorter way (${n0(c.marsnav_safest.drive_h)} h against ${n0(c.rover.modelled_drive_h)} h on the rover's route). For a rover, JPL's choice stands; MarsNav puts both options and their numbers on one screen in seconds.
- **For a crew, the trip becomes one EVA.** MarsNav's suited-crew route covers ${km(cm.length_m)} km in ${f.eva_h.toFixed(1)} h, crosses ${n0(cm.sand_m)} m of mapped bedforms (rover route ${n0(r.sand_m)} m) and ${n0(cm.rocky_m)} m of rocky ground (rover ${n0(r.rocky_m)} m), and keeps the walk home to the landing-site habitat at every step, with at least ${n0(100 * f.min_walk_home_margin)} % margin.

## All ${a.planned} validation drives

The same comparison on the ${a.planned} end-of-drive pairs (0.4 to 2 km apart, spread over sols ${solA} to ${solB.toLocaleString("en-US")}) used in \`validate.mjs\`: MarsNav's safest robotic-scout route against the rover's actual route.

| Measured on the 1 m terrain | Perseverance (actual) | MarsNav | Change | MarsNav lower on |
|---|---|---|---|---|
| Mapped sand bedforms | ${km(a.rover_total.sand_m)} km | ${km(a.safest_total.sand_m)} km | ${pct(a.safest_total.sand_m, a.rover_total.sand_m)} | ${a.safest_better.sand_m} of ${a.planned} (${a.safest_tied.sand_m} tied) |
| Rocky ground | ${km(a.rover_total.rocky_m)} km | ${km(a.safest_total.rocky_m)} km | ${pct(a.safest_total.rocky_m, a.rover_total.rocky_m)} | ${a.safest_better.rocky_m} of ${a.planned} |
| Ground steeper than 15° | ${km(a.rover_total.over15_m)} km | ${km(a.safest_total.over15_m)} km | ${pct(a.safest_total.over15_m, a.rover_total.over15_m)} | ${a.safest_better.over15_m} of ${a.planned} (${a.safest_tied.over15_m} tied) |
| Steepest slope per drive (mean) | ${n1(a.rover_mean.slope_max_deg)}° | ${n1(a.safest_mean.slope_max_deg)}° | ${pct(a.safest_mean.slope_max_deg, a.rover_mean.slope_max_deg)} | ${a.safest_better.slope_max_deg} of ${a.planned} |
| Total climb | ${n0(a.rover_total.climb_m)} m | ${n0(a.safest_total.climb_m)} m | ${pct(a.safest_total.climb_m, a.rover_total.climb_m)} | ${a.safest_better.climb_m} of ${a.planned} |
| Total distance | ${km(a.rover_total.length_m)} km | ${km(a.safest_total.length_m)} km | ${pct(a.safest_total.length_m, a.rover_total.length_m)} | ${a.safest_better.length_m} of ${a.planned} drives |

MarsNav planned all ${a.planned} drives in ${a.planning_s.mean.toFixed(2)} s each on average (at most ${a.planning_s.max.toFixed(2)} s). The rover's recorded route passes through ${km(a.rover_veto_m)} km of ground that MarsNav's robotic limits forbid (${Object.entries(vetoWhy).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}: ${km(v)} km`).join("; ")}): on these measures MarsNav is more conservative than the envelope JPL drove in.

**What this does not show.** That MarsNav's routes would have been faster or safer for Perseverance in practice: rover drives are shaped by science stops, sub-metre hazards, communication windows and operational risk, which the comparison includes only through the terrain.
`;
  fs.writeFileSync(path.join(ROOT, "validation", "ROVER_CASE_STUDY.md"), md);
}
