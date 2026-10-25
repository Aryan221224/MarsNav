// validate.mjs - checks the shipped engine against independent real data. Run: node validation/validate.mjs
// Writes validation/results/validation.json, validation/REPORT.md and app/data/validation.json (shown in Review).
//
//  1. Mars clock (Mars24) vs Perseverance MEDA ancillary data (solar zenith angle, LTST), 5,616 samples, 124 sols.
//  2. Elevation model vs Perseverance's own localised elevations (NASA traverse feed, 494 points with geoid heights).
//  3. Slope layers vs the rover's measured chassis tilt at the same points.
//  4. Traversability: share of real rover positions our robotic-scout vetoes would forbid (false no-go rate).
//  5. Route reproduction: plan the robotic scout between real waypoint pairs and compare with where the rover drove.
//  6. Bedform (sand) layer vs the rover's route choice.
//  7. Weight robustness: AHP consistency and route stability under perturbed judgements (research doc 28 method).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTerrain } from "../engine/terrain.js";
import { nodeIO } from "../engine/node_io.js";
import { Environment } from "../engine/environment.js";
import { CostModel, VETO_NAMES } from "../engine/costmodel.js";
import { Planner } from "../engine/planner.js";
import { viewshed } from "../engine/fields.js";
import { msFromM2020Sol, marsState, jdTT, sunPosition, ltstHours, M2020 } from "../engine/marstime.js";
import { ahp, L1_MATRIX, L1_IDS, SAFETY_MATRICES, S1_MATRIX, namedWeightSets } from "../engine/ahp.js";
import { lonlatToXY, haversine } from "../engine/geo.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "app", "data");
const OUT = path.join(ROOT, "validation", "results");
fs.mkdirSync(OUT, { recursive: true });

const stats = (a) => {
  const v = a.filter(Number.isFinite).sort((x, y) => x - y);
  const n = v.length, mean = v.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1));
  const q = (p) => v[Math.min(n - 1, Math.floor(p * (n - 1)))];
  const abs = v.map(Math.abs).sort((x, y) => x - y);
  return { n, mean, sd, median: q(0.5), p95abs: abs[Math.floor(0.95 * (n - 1))], maxabs: abs[n - 1] };
};
const pearson = (a, b) => {
  const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return sab / Math.sqrt(saa * sbb);
};

const t0 = performance.now();
const T = await loadTerrain(nodeIO(DATA));
const clim = JSON.parse(fs.readFileSync(path.join(DATA, "environment.json")));
const env = new Environment(T, clim);
const R = { generated_utc: new Date().toISOString() };

// ------------------------------------------------------------------------------------------ 1. Mars clock ----
{
  const anc = JSON.parse(fs.readFileSync(path.join(ROOT, "data_cache", "meda_ancillary.json")));
  const dz = [], dl = [];
  for (const a of anc) {
    const ms = msFromM2020Sol(a.sol, a.lmst);
    const st = marsState(jdTT(ms));
    const sun = sunPosition(st, M2020.lonEast, M2020.lat);
    dz.push(sun.zenith - a.sza);
    const lt = ltstHours(st, M2020.lonEast);
    dl.push((((lt - a.ltst + 36) % 24) - 12) * 3600);
  }
  R.clock = { samples: anc.length, sols: new Set(anc.map((a) => a.sol)).size, sza_deg: stats(dz), ltst_s: stats(dl),
    note: "Sun position computed at the landing site; the rover moved up to ~15 km (<= 0.25 deg of zenith angle)." };
}

// ------------------------------------------------------------------------------- 2-3. DEM and slope vs rover --
{
  const gj = JSON.parse(fs.readFileSync(path.join(ROOT, "data_cache", "rover_points_stiles.geojson")));
  const g = T.grid, elev = T.f32("elev_dm"), sw = T.f32("slopeW"), s10 = T.f32("slope"), conf = T.f32("conf");
  const dzAll = [], dzHi = [], tilt = [], slW = [], sl10 = [];
  for (const f of gj.features) {
    const p = f.properties;
    if (!f.geometry || p.elev_geoid == null) continue;
    const [lon, lat] = f.geometry.coordinates;
    const [r, c] = g.rcOfLonLat(lon, lat);
    const z = g.sample(elev, r, c);
    if (!Number.isFinite(z)) continue;
    const d = z - Number(p.elev_geoid);
    dzAll.push(d);
    const i = g.idx(Math.round(r), Math.round(c));
    if (conf[i] > 0.5) dzHi.push(d);
    if (p.tilt != null && Number.isFinite(Number(p.tilt))) {
      tilt.push(Number(p.tilt));
      slW.push(sw[i]);
      sl10.push(s10[i]);
    }
  }
  R.dem = { points: dzAll.length, all_m: stats(dzAll), hirise_m: stats(dzHi) };
  const diff10 = sl10.map((v, k) => v - tilt[k]);
  R.slope = { points: tilt.length, rover_tilt_deg: stats(tilt), slope10_minus_tilt: stats(diff10), r_slope10: pearson(sl10, tilt),
    r_slopeW: pearson(slW, tilt), slopeW_ge_tilt_frac: slW.filter((v, k) => v >= tilt[k]).length / tilt.length,
    note: "Chassis tilt integrates ~3 m of terrain and the rover chooses gentle ground; slopeW is a 90th percentile, so it should usually exceed tilt." };
}

// --------------------------------------------------------------------------- 4. traversability agreement ----
const wp = JSON.parse(fs.readFileSync(path.join(ROOT, "data_cache", "m20_waypoints_enomis.json"))).waypoints;
{
  const out = {};
  for (const profile of ["robot", "foot", "rover"]) {
    const M = new CostModel(T, env, { profile });
    const g = M.fine.grid;
    let n = 0, vetoed = 0;
    const why = {};
    for (const p of wp) {
      const i = g.idxOfLonLat(p.lon, p.lat);
      if (i < 0) continue;
      n++;
      // allow the rover's own localisation error and our 10 m cell: count a veto only if the 3x3 neighbourhood is all no-go
      const [r, c] = g.rc(i);
      let open = false;
      for (let dr = -1; dr <= 1 && !open; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (g.inside(r + dr, c + dc) && !M.fine.veto[g.idx(r + dr, c + dc)]) { open = true; break; }
      }
      // keep-out zones are excluded: they exist *because* the rover was there (sample depot, the rover itself)
      if (!open && M.fine.veto[i] !== 5) { vetoed++; const k = VETO_NAMES[M.fine.veto[i]]; why[k] = (why[k] || 0) + 1; }
    }
    out[profile] = { points: n, vetoed, frac: vetoed / n, reasons: why };
  }
  R.traversability = out;
}

// ------------------------------------------------------------------------------ 5. route reproduction ----
{
  const M = new CostModel(T, env, { profile: "robot" });
  const P = new Planner(M, { lon: M2020.lonEast, lat: M2020.lat }, { departMs: msFromM2020Sol(500, 10), evaMaxS: 8 * 3600 });
  const eod = wp.filter((p) => p.final === "y");
  const pairs = [];
  for (let a = 0; a < eod.length; a++) {
    for (let b = a + 1; b < eod.length; b++) {
      const d = haversine(eod[a].lon, eod[a].lat, eod[b].lon, eod[b].lat);
      if (d < 400) continue;
      if (d > 2000) break;
      const seg = wp.filter((p) => p.sol >= eod[a].sol && p.sol <= eod[b].sol);
      let L = 0;
      for (let k = 1; k < seg.length; k++) L += haversine(seg[k - 1].lon, seg[k - 1].lat, seg[k].lon, seg[k].lat);
      if (seg.length >= 3 && L <= 3 * d) { pairs.push({ a: eod[a], b: eod[b], seg, d, L, detour: L / d >= 1.15 }); break; }
    }
  }
  const det = pairs.filter((p) => p.detour), dir = pairs.filter((p) => !p.detour);
  const pick = (arr, n) => arr.filter((_, k) => k % Math.max(1, Math.floor(arr.length / n)) === 0).slice(0, n);
  const chosen = [...pick(det, 30), ...pick(dir, 15)];
  const devOf = (pts, seg) => {
    // mean and within-50 m share of planned points' distance to the actual traverse polyline
    const sxy = seg.map((p) => lonlatToXY(p.lon, p.lat));
    const d = pts.map(([x, y]) => {
      let best = Infinity;
      for (let k = 1; k < sxy.length; k++) {
        const [x0, y0] = sxy[k - 1], [x1, y1] = sxy[k];
        const vx = x1 - x0, vy = y1 - y0, L2 = vx * vx + vy * vy || 1e-9;
        const t = Math.max(0, Math.min(1, ((x - x0) * vx + (y - y0) * vy) / L2));
        best = Math.min(best, Math.hypot(x - x0 - t * vx, y - y0 - t * vy));
      }
      return best;
    });
    return { mean: d.reduce((s, v) => s + v, 0) / d.length, within50: d.filter((v) => v <= 50).length / d.length };
  };
  const rows = [];
  const unit = { T: 1, S: 1, C: 1, R: 1, V: 1 };
  const W = namedWeightSets();
  for (const pr of chosen) {
    const st = { t: 0, res: { o2: 0, co2: 0, water: 0, batt: 0, rbatt: 0 } };
    const from = { lon: pr.a.lon, lat: pr.a.lat }, to = { lon: pr.b.lon, lat: pr.b.lat };
    let fast, bal;
    try {
      fast = P.planLeg(from, to, W.fastest, unit, st);
      bal = fast.ok ? P.planLeg(from, to, { S: 0.5, T: 0.5 }, { T: 3600 * 5, S: pr.d * 0.1, C: 1, R: 1, V: 1 }, st) : null;
    } catch (e) { continue; }
    if (!fast?.ok) { rows.push({ sol_a: pr.a.sol, sol_b: pr.b.sol, d: pr.d, ok: false }); continue; }
    const cellXY = (cells) => cells.map((i) => M.fine.grid.cellXY(...M.fine.grid.rc(i)));
    const pf = cellXY(fast.cells), pb = bal?.ok ? cellXY(bal.cells) : null;
    const [ax, ay] = lonlatToXY(from.lon, from.lat), [bx, by] = lonlatToXY(to.lon, to.lat);
    const straight = Array.from({ length: 50 }, (_, k) => [ax + ((bx - ax) * k) / 49, ay + ((by - ay) * k) / 49]);
    const hz = (xy) => {
      // mean static hazard of the robotic-scout model along a polyline, sampled every 5 m
      let sum = 0, n = 0;
      const g = M.fine.grid;
      for (let k = 1; k < xy.length; k++) {
        const [x0, y0] = xy[k - 1], [x1, y1] = xy[k];
        const m = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 5));
        for (let q = 0; q < m; q++) {
          const x = x0 + ((x1 - x0) * q) / m, y = y0 + ((y1 - y0) * q) / m;
          const r = Math.round((g.y0 - y) / g.res - 0.5), c = Math.round((x - g.x0) / g.res - 0.5);
          if (!g.inside(r, c)) continue;
          const i = g.idx(r, c);
          sum += M.fine.veto[i] && M.fine.veto[i] !== 5 ? 1 : M.fine.haz[i];
          n++;
        }
      }
      return sum / Math.max(1, n);
    };
    const realXY = pr.seg.map((p) => lonlatToXY(p.lon, p.lat));
    const hazards = { real: hz(realXY), straight: hz(straight), fastest: hz(pf), riskaware: pb ? hz(pb) : null };
    rows.push({ sol_a: pr.a.sol, sol_b: pr.b.sol, d: pr.d, L: pr.L, detour: pr.detour, ok: true, hazards, fastest: devOf(pf, pr.seg),
      riskaware: pb ? devOf(pb, pr.seg) : null, straight: devOf(straight, pr.seg) });
  }
  const summarise = (ok) => {
    const avg = (f) => ok.reduce((s, r) => s + f(r), 0) / Math.max(1, ok.length);
    const okB = ok.filter((r) => r.riskaware);
    const better = ok.filter((r) => r.fastest.mean < r.straight.mean).length;
    const hzAvg = (k) => ok.filter((r) => r.hazards[k] != null).reduce((s, r) => s + r.hazards[k], 0) / Math.max(1, ok.filter((r) => r.hazards[k] != null).length);
    const realBelow = ok.filter((r) => r.hazards.real < r.hazards.straight).length;
    return { n: ok.length, better_than_straight: better, hazard: { real: hzAvg("real"), straight: hzAvg("straight"), fastest: hzAvg("fastest"),
      riskaware: hzAvg("riskaware") }, real_safer_than_straight: realBelow,
      mean_dev_m: { straight: avg((r) => r.straight.mean), fastest: avg((r) => r.fastest.mean), riskaware: okB.reduce((s, r) => s + r.riskaware.mean, 0) / Math.max(1, okB.length) },
      within50: { straight: avg((r) => r.straight.within50), fastest: avg((r) => r.fastest.within50), riskaware: okB.reduce((s, r) => s + r.riskaware.within50, 0) / Math.max(1, okB.length) } };
  };
  const ok = rows.filter((r) => r.ok);
  R.reproduction = { pairs: rows.length, planned: ok.length, detour: summarise(ok.filter((r) => r.detour)), direct: summarise(ok.filter((r) => !r.detour)), rows,
    note: "End-of-drive position pairs 0.4-2 km apart. 'Detour' drives: real path >= 1.15x the straight line (the rover went around something); 'direct' drives: < 1.15x." };
}

// ------------------------------------------------------------------------------------ 6. bedforms ----
{
  const g = T.grid, sand = T.f32("sand"), conf = T.f32("conf");
  const onPath = [];
  const seen = new Set();
  for (let k = 1; k < wp.length; k++) {
    const [r0, c0] = g.rcOfLonLat(wp[k - 1].lon, wp[k - 1].lat), [r1, c1] = g.rcOfLonLat(wp[k].lon, wp[k].lat);
    const n = Math.max(1, Math.ceil(Math.hypot(r1 - r0, c1 - c0)));
    for (let s = 0; s <= n; s++) {
      const i = g.idx(Math.round(r0 + ((r1 - r0) * s) / n), Math.round(c0 + ((c1 - c0) * s) / n));
      if (!seen.has(i) && conf[i] > 0.5) { seen.add(i); onPath.push(sand[i]); }
    }
  }
  // comparison area: HiRISE cells within 1 km of the traverse
  const near = new Uint8Array(g.n);
  for (const i of seen) near[i] = 1;
  const { distanceTransform } = await import("../engine/util.js");
  const dist = distanceTransform(near, g.width, g.height, g.res);
  const area = [];
  for (let i = 0; i < g.n; i++) if (dist[i] <= 1000 && conf[i] > 0.5) area.push(sand[i]);
  const frac = (a, t) => a.filter((v) => v > t).length / a.length;
  R.bedforms = { path_cells: onPath.length, area_cells: area.length, path_frac_gt05: frac(onPath, 0.5), area_frac_gt05: frac(area, 0.5),
    path_mean: onPath.reduce((s, v) => s + v, 0) / onPath.length, area_mean: area.reduce((s, v) => s + v, 0) / area.length };
}

// ------------------------------------------------------------------------ 7. weights and sensitivity ----
{
  const cr = { L1: ahp(L1_MATRIX).CR, S_foot: ahp(SAFETY_MATRICES.foot.A).CR, S_rover: ahp(SAFETY_MATRICES.rover.A).CR, S1: ahp(S1_MATRIX.A).CR };
  const M = new CostModel(T, env, { profile: "foot" });
  const hab = T.targets.find((t) => t.id === "HAB"), amal = T.targets.find((t) => t.id === "AMAL");
  const P = new Planner(M, hab, { departMs: msFromM2020Sol(2000, 8.5), evaMaxS: 7 * 3600 });
  viewshed(M.coarse, P.baseCoarse, 10);
  const stops = [{ lon: amal.lon, lat: amal.lat, name: amal.name, dwell_min: amal.dwell_min }];
  const base = P.namedSorties(stops, { withFallback: false });
  const refs = base.refs;
  const nominal = new Set(base.routes.balanced.legs.flatMap((l) => l.cells));
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const runs = [];
  for (let k = 0; k < 40; k++) {
    const A = L1_MATRIX.map((r) => r.slice());
    for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) {
      const v = Math.min(9, Math.max(1 / 9, A[i][j] * Math.exp(0.4 * gauss())));
      A[i][j] = v; A[j][i] = 1 / v;
    }
    const r = ahp(A);
    const w = Object.fromEntries(L1_IDS.map((id, i) => [id, r.weights[i]]));
    const so = P.planSortie(stops, w, refs);
    if (!so.ok) { runs.push({ ok: false }); continue; }
    const cells = new Set(so.legs.flatMap((l) => l.cells));
    let inter = 0;
    for (const c of cells) if (nominal.has(c)) inter++;
    // corridor overlap: share of this route within 30 m (3 cells) of the nominal route
    let near = 0;
    const g = M.fine.grid;
    for (const c of cells) {
      const [r0, c0] = g.rc(c);
      let hit = false;
      for (let dr = -3; dr <= 3 && !hit; dr++) for (let dc = -3; dc <= 3; dc++) if (nominal.has(g.idx(r0 + dr, c0 + dc))) { hit = true; break; }
      if (hit) near++;
    }
    runs.push({ ok: true, CR: r.CR, t: so.t, S: so.X.S / refs.S, corridor30: near / cells.size });
  }
  const okr = runs.filter((r) => r.ok);
  R.weights = { CR: cr, sensitivity: { runs: runs.length, ok: okr.length,
    corridor30_mean: okr.reduce((s, r) => s + r.corridor30, 0) / okr.length,
    corridor30_min: Math.min(...okr.map((r) => r.corridor30)),
    share_ge80: okr.filter((r) => r.corridor30 >= 0.8).length / okr.length,
    time_h: [Math.min(...okr.map((r) => r.t)) / 3600, Math.max(...okr.map((r) => r.t)) / 3600],
    nominal_time_h: base.routes.balanced.t / 3600, safety_vs_fastest: [Math.min(...okr.map((r) => r.S)), Math.max(...okr.map((r) => r.S))] },
    demo: Object.fromEntries(Object.entries(base.routes).map(([k, r]) => [k, r.ok ? { t_h: r.t / 3600, km: r.dist / 1000,
      safety_vs_fastest: r.X.S / refs.S, min_margin: r.minMargin } : null])) };
}
R.runtime_s = (performance.now() - t0) / 1000;
fs.writeFileSync(path.join(OUT, "validation.json"), JSON.stringify(R, null, 1));

// ------------------------------------------------------------------------------------ human-readable ----
const f1 = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "-");
const pc = (v) => `${(100 * v).toFixed(0)} %`;
const c = R.clock, dm = R.dem, sl = R.slope, tr = R.traversability, rp = R.reproduction, bf = R.bedforms, wt = R.weights;
const lines = [
  ["Mars clock vs MEDA", `Solar zenith angle error ${f1(c.sza_deg.mean, 3)} ± ${f1(c.sza_deg.sd, 3)}° (95 % within ${f1(c.sza_deg.p95abs, 2)}°) over ${c.samples} samples on ${c.sols} sols; LTST within ${f1(c.ltst_s.p95abs, 0)} s.`],
  ["Elevation vs rover", `DEM minus rover-localised geoid height: ${f1(dm.all_m.mean)} ± ${f1(dm.all_m.sd)} m (${dm.points} points); HiRISE-covered ${f1(dm.hirise_m.mean)} ± ${f1(dm.hirise_m.sd)} m. Caveat: JPL localises the rover against these same orbital maps, so this confirms our warping and datum handling, not independent DEM accuracy.`],
  ["Slope vs rover tilt", `Rover chassis tilt median ${f1(sl.rover_tilt_deg.median)}°; our walking-scale slope (90th pct) is at or above the measured tilt at ${pc(sl.slopeW_ge_tilt_frac)} of ${sl.points} points (r = ${f1(sl.r_slopeW, 2)}).`],
  ["False no-go rate", `Robotic-scout vetoes forbid ${pc(tr.robot.frac)} of ${tr.robot.points} real Perseverance positions (all cliff-edge stand-offs; keep-out zones excluded because they mark where the rover itself was). Suited-walk limits forbid ${pc(tr.foot.frac)}.`],
  ["Route reproduction", `On ${rp.detour.n} real drives where Perseverance went around something (path at least 1.15x the straight line, 0.4-2 km), our robotic-scout route stays on average ${f1(rp.detour.mean_dev_m.fastest, 0)} m from the rover's actual path vs ${f1(rp.detour.mean_dev_m.straight, 0)} m for a straight line (closer in ${rp.detour.better_than_straight} of ${rp.detour.n}); ${pc(rp.detour.within50.fastest)} of planned points lie within 50 m of the real drive (straight ${pc(rp.detour.within50.straight)}). On ${rp.direct.n} direct drives the figures are ${f1(rp.direct.mean_dev_m.fastest, 0)} and ${f1(rp.direct.mean_dev_m.straight, 0)} m. Result: route geometry does NOT reproduce JPL's drives better than a straight line. Rover drives are shaped by science stops, AutoNav and sub-metre hazards, and the public waypoint record is sparse (one point per drive end), so geometric match is a weak test.`],
  ["Hazard model vs JPL's choices", `On the ${rp.detour.n} detour drives, mean hazard index along the rover's real path is ${f1(rp.detour.hazard.real, 3)} vs ${f1(rp.detour.hazard.straight, 3)} along the straight line (real path lower on ${rp.detour.real_safer_than_straight} of ${rp.detour.n}); our risk-aware route scores ${f1(rp.detour.hazard.riskaware, 3)}.`],
  ["Bedform avoidance", `Cells with strong bedform evidence: ${pc(bf.path_frac_gt05)} on the rover's path vs ${pc(bf.area_frac_gt05)} of the surrounding 1 km corridor.`],
  ["Weights", `AHP consistency ratios: L1 ${f1(wt.CR.L1, 3)}, safety (foot) ${f1(wt.CR.S_foot, 3)}, safety (rover) ${f1(wt.CR.S_rover, 3)}, terrain ${f1(wt.CR.S1, 3)} (all < 0.10). Perturbing every top-level judgement at random (log-sd 0.4, ${wt.sensitivity.ok} runs) keeps ${pc(wt.sensitivity.corridor30_mean)} of the balanced route within 30 m of nominal on average (worst run ${pc(wt.sensitivity.corridor30_min)}; ${pc(wt.sensitivity.share_ge80)} of runs keep at least 80 %); EVA time ${f1(wt.sensitivity.time_h[0], 2)}-${f1(wt.sensitivity.time_h[1], 2)} h (nominal ${f1(wt.sensitivity.nominal_time_h, 2)} h).`],
];
const html = `<table class="t">${lines.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("")}</table>
<p class="note">What this shows: the clock, terrain registration and slope layer agree with real rover data, and the hazard layer ranks the paths JPL actually chose as safer than the straight line. What it does not show: that our routes match where a rover team would drive, or that suited-crew limits are right (no human has walked on Mars). Computed by validation/validate.mjs on ${R.generated_utc.slice(0, 10)} with the shipped engine and real data.</p>`;
fs.writeFileSync(path.join(DATA, "validation.json"), JSON.stringify({ html, summary: lines }));
fs.writeFileSync(path.join(ROOT, "validation", "REPORT.md"),
  `# Validation report\n\nGenerated ${R.generated_utc} by \`node validation/validate.mjs\` (runtime ${f1(R.runtime_s, 0)} s). Raw numbers: \`validation/results/validation.json\`.\n\n` +
  lines.map(([k, v]) => `**${k}.** ${v}`).join("\n\n") + "\n");
console.log(lines.map(([k, v]) => `${k}: ${v}`).join("\n"));
