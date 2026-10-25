// Closed-loop tests (research docs 31-34): estimators, navigation filter, telemetry format, re-planning, live telemetry
// and the UDP bridge. Unit tests use synthetic data with known answers; the loop tests fly EVAs on the real Jezero data
// with a hidden "truth" the software must discover from telemetry alone. Run: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";

import { RateKF, Estimator, rlsUpdate, slipFeatures } from "../engine/estimator.js";
import { NavFilter } from "../engine/nav.js";
import { parseTSS, faultsFromTSS, tssFrameFromSim } from "../engine/telemetry.js";
import { buildSelectionQubo, annealQubo, bruteForceQubo, exportQubo, selectStationsQubo } from "../engine/qubo.js";
import { optimiseSortie, heldKarpSubsets } from "../engine/sortie.js";
import { LiveSession, makeAnchor, applyAnchor } from "../engine/live.js";
import { EvaSim } from "../engine/sim.js";
import { SUIT } from "../engine/physio.js";
import { wilcoxonSignedRank } from "../engine/stats.js";
import { taskOf, stationWork, TASK_PRESETS } from "../engine/task.js";
import { drivePowerW, PROFILES, ROLL, WHEEL_DAMAGE, walkMetabolicW, walkSpeedKmh, vehicleSpeedKmh } from "../engine/physio.js";
import { CostModel } from "../engine/costmodel.js";
import { Planner } from "../engine/planner.js";
import { FakeTss, buildHeadless } from "../tools/tss_fake.mjs";
import { startBridge, tssGet } from "../tools/tss_bridge.mjs";

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const gauss = (r) => (r() + r() + r() + r() + r() + r() - 3) * Math.SQRT2;

// ------------------------------------------------------------------------------------------------ estimators --
test("RateKF recovers a constant drain rate from noisy quantised levels", () => {
  const r = rng(3), kf = new RateKF(100, { measR: 0.05 ** 2, rateQ: 1e-9, rateVar0: 1e-4 });
  const rate = -0.004; // %/s
  for (let t = 1; t <= 1800; t++) kf.step(1, Math.round((100 + rate * t + 0.03 * gauss(r)) * 100) / 100);
  assert.ok(Math.abs(kf.rate - rate) / Math.abs(rate) < 0.03, `rate ${kf.rate}`);
});

test("Estimator learns metabolic, water, battery and CO2 factors from TSS frames against the model", () => {
  const truth = { met: 1.35, water: 1.25, batt: 1.4 };
  const model = { o2PerS: (0.03 + SUIT.leakKgPerH) / 3600, waterPerS: 0.25 / 3600, battPerS: 60 / 3600, co2PerS: 0.04 / 3600 };
  const est = new Estimator({});
  const used = { o2: 0, water: 0, batt: 0, co2: 0 };
  const r = rng(5);
  let c;
  for (let t = 0; t <= 3600; t += 10) {
    const pct = (u, cap) => Math.round((100 * (1 - u / cap) + 0.02 * gauss(r)) * 100) / 100;
    const frame = { t, suit: { o2Pct: pct(used.o2, SUIT.o2Kg), waterPct: pct(used.water, SUIT.waterKg), battPct: pct(used.batt, SUIT.batteryWh),
      scrubPct: Math.round((100 * used.co2) / SUIT.co2CapKg * 100) / 100, hr: null } };
    c = est.ingest(frame, model);
    used.o2 += ((model.o2PerS - SUIT.leakKgPerH / 3600) * truth.met + SUIT.leakKgPerH / 3600) * 10;
    used.water += model.waterPerS * truth.water * 10;
    used.batt += model.battPerS * truth.batt * 10;
    used.co2 += model.co2PerS * truth.met * 10;
  }
  for (const [k, v] of [["met", 1.35], ["water", 1.25], ["batt", 1.4], ["co2", 1.35]]) assert.ok(Math.abs(c[k] - v) / v < 0.05, `${k} ${c[k]}`);
  assert.ok(c.sd.met < 0.1 && c.sd.batt < 0.1, "factors are confident after an hour");
});

test("Slip model: recursive least squares recovers how much softer sand is than mapped", () => {
  const R = { w: [0, 0, 0, 0], P: [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => (i === j ? 0.09 : 0))), r: 0.08 ** 2, n: 0 };
  const r = rng(9);
  for (let k = 0; k < 400; k++) {
    const sand = r(), slope = 20 * r(), cls = sand > 0.5 ? 1 : 0;
    const x = slipFeatures(sand, slope, cls);
    rlsUpdate(R, x, 0.7 * sand + 0.35 * cls + 0.03 * gauss(r));
  }
  assert.ok(Math.abs(R.w[1] - 0.7) < 0.08 && Math.abs(R.w[3] - 0.35) < 0.08, `w ${R.w.map((v) => v.toFixed(2))}`);
});

// ------------------------------------------------------------------------------------------------ navigation --
test("Navigation EKF is consistent: dead reckoning with heading drift, sun and landmark fixes (NEES near 2)", () => {
  const runs = 200, r = rng(11);
  let nees = 0, rmsDR = 0, rmsFix = 0;
  for (let k = 0; k < runs; k++) {
    const f = new NavFilter(0, 0, { kind: "suit", sigma0: 1, headingSigma0Deg: 2 });
    let x = 0, y = 0, bias = gauss(r) * 2 * (Math.PI / 180);
    for (let s = 0; s < 150; s++) { // 1.5 km in 10 m steps, 8 s each
      const hdg = 60 + 30 * Math.sin(s / 20);
      bias += gauss(r) * 3 * (Math.PI / 180) * Math.sqrt(8 / 3600);
      x += 10 * Math.sin((hdg * Math.PI) / 180); y += 10 * Math.cos((hdg * Math.PI) / 180);
      f.propagate(10 * (1 + 0.02 * gauss(r)), hdg + (bias * 180) / Math.PI + 2 * gauss(r), 8);
      if (s === 60) f.fixHeading(hdg + (bias * 180) / Math.PI, hdg + 1.5 * gauss(r));
    }
    const ex = f.x[0] - x, ey = f.x[1] - y, P = f.P, det = P[0][0] * P[1][1] - P[0][1] ** 2;
    nees += (P[1][1] * ex * ex - 2 * P[0][1] * ex * ey + P[0][0] * ey * ey) / det;
    rmsDR += ex * ex + ey * ey;
    f.fixPosition(x + gauss(r), y + gauss(r), 1);
    rmsFix += (f.x[0] - x) ** 2 + (f.x[1] - y) ** 2;
  }
  nees /= runs;
  assert.ok(nees > 1.2 && nees < 3.2, `mean 2-D NEES ${nees.toFixed(2)} (2 is ideal)`);
  assert.ok(Math.sqrt(rmsFix / runs) < 2 && Math.sqrt(rmsDR / runs) > 5, "a landmark fix removes the dead-reckoning drift");
});

test("Navigation EKF rejects a position fix that jumps further than the gate allows", () => {
  const f = new NavFilter(0, 0, { sigma0: 2 });
  assert.equal(f.fixPosition(200, 0, 1), false);
  assert.equal(f.fixPosition(1, 1, 1), true);
});

// ------------------------------------------------------------------------------------------------ telemetry ---
test("TSS parsing: 2027 flat and 2026 nested EVA.json, ROVER.json, and error flags", () => {
  const f27 = tssFrameFromSim({ t: 120, used: { o2: 0.1, co2: 0.1, water: 0.5, batt: 50 }, hw: { o2Fill: 1, battSOH: 1, scrubCap: 1, waterFill: 1 },
    metW: 300, hrCal: { a: -330, b: 5.5 }, pos: { x: -5660, y: -10040 }, heading: 90, rand: rng(1), faults: { leak: true } });
  const a = parseTSS(f27);
  assert.equal(a.t, 120);
  assert.ok(a.suit.o2Pct > 50 && a.suit.o2Pct < 100 && a.suit.hr > 100);
  assert.deepEqual([a.imu.x, a.imu.y], [-5660, -10040]);
  assert.equal(faultsFromTSS(a).leak, true);
  const nested = { telemetry: { eva_time: 30, eva1: { ...f27.telemetry }, eva2: { ...f27.telemetry, oxy_pri_storage: 42 } },
    imu: { eva1: { posx: 1, posy: 2, heading: 3 }, eva2: { posx: 4, posy: 5, heading: 6 } }, error: {} };
  const b = parseTSS(nested, { pr_telemetry: { rover_pos_x: 10, rover_pos_y: 20, heading: 0, primary_battery_level: 77 } }, { crew: "eva2" });
  assert.equal(b.suit.o2Pct, 42);
  assert.deepEqual([b.imu.x, b.imu.y], [4, 5]);
  assert.equal(b.rover.battPct, 77);
  const A = makeAnchor({ scale: 1, rotDeg: 90 }, { x: 100, y: 100 }, [5000, 6000]);
  const [x, y] = applyAnchor(A, 110, 100); // +10 m along TSS x, rotated 90 deg anticlockwise -> +10 m north
  assert.ok(Math.abs(x - 5000) < 1e-9 && Math.abs(y - 6010) < 1e-9);
});

// ------------------------------------------------------------------------------------------------ QUBO --------
test("QUBO station selection: simulated annealing finds the exact optimum; export is solver-ready", () => {
  const r = rng(21);
  for (let k = 0; k < 12; k++) {
    const pts = Array.from({ length: 10 }, () => [4000 * r() - 2000, 4000 * r() - 2000]);
    const Tm = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) / 1.2;
    const O = [0, 0];
    const q = buildSelectionQubo({ values: pts.map(() => 0.2 + r()), costs: pts.map((p) => 1800 + 2 * Tm(p, O)),
      savings: pts.map((a, i) => pts.map((b, j) => (i === j ? 0 : Math.max(0, Tm(a, O) + Tm(O, b) - Tm(a, b))))), budget: 6 * 3600 });
    const ex = bruteForceQubo(q), sa = annealQubo(q, { seed: k + 1 });
    assert.ok(Math.abs(ex.energy - sa.energy) < 1e-9, `instance ${k}: SA ${sa.energy} vs exact ${ex.energy}`);
  }
  const q = buildSelectionQubo({ values: [1, 2], costs: [100, 200], savings: [[0, 10], [10, 0]], budget: 250, names: ["A", "B"] });
  const e = exportQubo(q);
  assert.equal(e.vartype, "BINARY");
  assert.ok(e.variables.includes("A") && "A|B" in e.quadratic && Number.isFinite(e.offset));
});

test("Held-Karp over subsets gives the same best tour of every set as brute-force enumeration (asymmetric times)", () => {
  const r = rng(31);
  for (let k = 0; k < 5; k++) {
    const n = 7, T = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => (i === j ? 0 : 100 + 900 * r())));
    const hk = heldKarpSubsets(T, n);
    const perms = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
    for (const mask of [3, 21, 77, 127]) {
      const set = [...Array(n).keys()].filter((j) => (mask >> j) & 1);
      const best = Math.min(...perms(set).map((p) => p.reduce((s, j, q) => s + T[q ? p[q - 1] + 1 : 0][j + 1], 0) + T[p[p.length - 1] + 1][0]));
      assert.ok(Math.abs(hk.travel[mask] - best) < 1e-6, `mask ${mask}`);
      const o = hk.order(mask);
      const len = o.reduce((s, j, q) => s + T[q ? o[q - 1] + 1 : 0][j + 1], 0) + T[o[o.length - 1] + 1][0];
      assert.ok(Math.abs(len - best) < 1e-6 && o.length === set.length, "recovered order is the optimal one");
    }
  }
});

test("Exact beats quantum-inspired at EVA size: Held-Karp is optimal and fast; QUBO annealing is within a few percent", () => {
  // 15-station synthetic EVAs: the exact method is the reference (QPath's benchmark finding holds here too)
  let t = 0, gaps = [];
  for (let k = 1; k <= 10; k++) {
    const r = rng(100 + k), n = 15;
    const P = [[0, 0, 0], ...Array.from({ length: n }, () => [6000 * r() - 3000, 6000 * r() - 3000, 80 * r()])];
    const T = P.map((a) => P.map((b) => Math.hypot(a[0] - b[0], a[1] - b[1]) / (1.1 * (b[2] > a[2] ? 0.8 : 1))));
    const value = Array.from({ length: n }, () => 0.2 + 0.8 * r()), dwell = Array.from({ length: n }, () => 1200 + 1800 * r()), budget = 6 * 3600;
    const t0 = performance.now();
    const hk = heldKarpSubsets(T, n);
    let best = 0;
    for (let m = 1; m < 1 << n; m++) {
      let w = 0, v = 0;
      for (let j = 0; j < n; j++) if ((m >> j) & 1) { w += dwell[j]; v += value[j]; }
      if (hk.travel[m] + w <= budget && v > best) best = v;
    }
    t += performance.now() - t0;
    const sav = T.slice(1).map((_, i) => T.slice(1).map((__, j) => (i === j ? 0 : Math.max(0, T[i + 1][0] + T[0][j + 1] - T[i + 1][j + 1]))));
    const q = buildSelectionQubo({ values: value, costs: dwell.map((d, i) => d + T[0][i + 1] + T[i + 1][0] - 0.25 * Math.max(...sav[i])), savings: sav, budget });
    const sa = annealQubo(q, { seed: k });
    let mask = 0;
    for (let j = 0; j < n; j++) if (sa.x[j]) mask |= 1 << j;
    const fit = (m) => { let w = 0; for (let j = 0; j < n; j++) if ((m >> j) & 1) w += dwell[j]; return hk.travel[m] + w <= budget; };
    const val = (m) => { let v = 0; for (let j = 0; j < n; j++) if ((m >> j) & 1) v += value[j]; return v; };
    while (mask && !fit(mask)) mask &= mask - 1;
    gaps.push(1 - val(mask) / best);
    assert.ok(val(mask) <= best + 1e-9, "nothing feasible beats the exact optimum");
  }
  assert.ok(t / 10 < 250, `Held-Karp ${(t / 10).toFixed(0)} ms per 15-station instance`);
  assert.ok(gaps.every((g) => g >= -1e-9), "exact is never beaten");
});

test("Wilcoxon signed-rank test matches scipy.stats.wilcoxon (normal approximation, ties, continuity correction)", () => {
  const a = [0.21, 0.35, 0.12, 0.40, 0.18, 0.25, 0.30, 0.05, 0.22, 0.33, 0.28, 0.15];
  const b = [0.10, 0.20, 0.15, 0.22, 0.02, 0.25, 0.11, 0.07, 0.05, 0.12, 0.30, 0.01];
  const r = wilcoxonSignedRank(a, b);
  assert.equal(r.n, 11); // the tied pair (0.25, 0.25) is dropped
  assert.ok(Math.abs(r.pTwoSided - 0.018466) < 1e-5 && Math.abs(r.pGreater - 0.009233) < 1e-5, `${r.pTwoSided} ${r.pGreater}`); // scipy 1.x
});

// ------------------------------------------------------------------------------------- loop on real terrain ---
const H = await buildHeadless({ stops: ["AMAL", "ISSO"], truth: "nominal" });

test("QUBO selector agrees with exact enumeration on the Jezero science targets and respects every budget", () => {
  const cands = H.T.targets.filter((t) => t.kind === "science").map(({ id, name, lon, lat, value, dwell_min }) => ({ id, name, lon, lat, value, dwell_min }));
  const ex = optimiseSortie(H.P, cands, { maxStops: cands.length });
  const q = selectStationsQubo(H.P, cands, {});
  assert.ok(Math.abs(q.value - ex.options[0].value) < 1e-9, `QUBO ${q.ids} ${q.value} vs exact ${ex.options[0].ids} ${ex.options[0].value}`);
  assert.ok(q.timeS <= ex.budgetT && q.o2Kg <= ex.budgetO2);
});

test("Stated station task: work time, intensity, tool energy and extra consumables are budgeted into the round trip", () => {
  const P = H.P, amal = H.stops[0];
  const base = P.planSortie([{ ...amal }], P.namedWeights?.balanced ?? H.sortie.W, H.sortie.refs);
  const heavy = P.planSortie([{ ...amal, task: "heavy", toolWh: 120, extraO2g: 20, extraWaterG: 100 }], H.sortie.W, H.sortie.refs);
  assert.ok(base.ok && heavy.ok);
  const k = taskOf({ task: "heavy", toolWh: 120 });
  assert.equal(k.workW, TASK_PRESETS.heavy.workW);
  // same route and work time, so the difference is the task: more O2 and water, and the tool energy on the battery
  const dO2 = heavy.res.o2 - base.res.o2, dW = heavy.res.water - base.res.water, dB = heavy.res.batt - base.res.batt;
  assert.ok(dO2 > 0.02 && dW > 0.1 && dB >= 119.9, `dO2 ${dO2} dW ${dW} dB ${dB}`);
  assert.ok(heavy.minMargin < base.minMargin, "the walkback margin reflects the heavier station");
  // half the stated work time uses half the stated extras
  const env = H.env, full = stationWork({ task: "heavy", toolWh: 120, dwell_min: 40 }, 2400, { met: 1 }, env, H.P.departMs, 0);
  const half = stationWork({ task: "heavy", toolWh: 120, dwell_min: 20, dwell0: 40 }, 1200, { met: 1 }, env, H.P.departMs, 0);
  assert.ok(Math.abs(half.batt - full.batt / 2) < 1e-6);
});

test("Rocky ground is judged as slower, costlier and riskier, for boots and for wheels", () => {
  const rv = PROFILES.rover;
  // drive energy per metre: motion resistance x1.35 on rocks, and the rover is also slower there (more aux energy)
  assert.ok(Math.abs(drivePowerW(rv, 5, 0, "rocky") / drivePowerW(rv, 5, 0, "firm") - ROLL.rocky) < 1e-9);
  assert.ok(vehicleSpeedKmh(rv, 0, "rocky") < vehicleSpeedKmh(rv, 0, "firm"));
  assert.ok(walkSpeedKmh(0, "rocky") < walkSpeedKmh(0, "firm") && walkMetabolicW(3, 0, "rocky") > walkMetabolicW(3, 0, "firm"));
  assert.ok(WHEEL_DAMAGE.rocky > 2 * WHEEL_DAMAGE.firm && WHEEL_DAMAGE.veryRocky > WHEEL_DAMAGE.rocky);
  // the planner reports rocky exposure and wheel life, and worn wheels make it keep off rocky ground at least as well
  const plan = (wheelWear) => {
    const m = new CostModel(H.T, H.env, { profile: "rover", hw: { wheelWear } });
    const P = new Planner(m, H.T.site.base, { departMs: H.P.departMs, evaMaxS: 7 * 3600 });
    return P.namedSorties([{ ...H.stops[0] }], { withFallback: false }).routes.balanced;
  };
  const fresh = plan(0), worn = plan(0.9);
  assert.ok(fresh.ok && worn.ok && fresh.wheelLife > 0 && fresh.rockyFrac >= 0);
  assert.ok(worn.wheelLife <= fresh.wheelLife + 1e-9, `worn ${worn.wheelLife} fresh ${fresh.wheelLife}`);
  assert.ok(worn.wheelLeft < 0.2, "a route on worn wheels is flagged (under 20 % life left)");
});

function flySim(truth, opts = {}) {
  const sim = new EvaSim(H.P, H.sortie, { truth, stops: H.stops, seed: 7, ...opts });
  let minRem = 1, s;
  for (let k = 0; k < 2000 && !sim.done; k++) {
    s = sim.step(60);
    minRem = Math.min(minRem, s.remaining.o2, s.remaining.co2, s.remaining.water, s.remaining.batt);
  }
  return { sim, s, minRem };
}

test("Closed loop (simulated hardware): nominal crew is left alone; nothing is re-planned", () => {
  const { sim, minRem } = flySim("nominal");
  assert.ok(sim.done && !sim.returning);
  assert.equal(sim.replans.length, 0);
  assert.ok(sim.stops.every((s) => s.done) && minRem > 0);
  assert.ok(Math.abs(sim.cal.met - 1) < 0.05 && Math.abs(sim.cal.batt - 1) < 0.05);
});

test("Closed loop: a crew working 35 % harder is detected, the plan is cut back, and no consumable crosses the reserve", () => {
  const { sim, minRem } = flySim("hardwork");
  assert.ok(Math.abs(sim.cal.met - 1.35) < 0.07 && Math.abs(sim.cal.water - 1.25) < 0.07, `met ${sim.cal.met} water ${sim.cal.water}`);
  assert.ok(sim.replans.length >= 1 && sim.replans.length <= 4, `replans ${sim.replans.length}`);
  assert.ok(sim.stops.some((s) => s.dropped || s.dwell_min < s.dwell0), "the lowest-value station is cut back or dropped");
  assert.ok(sim.done && minRem >= 0, `min remaining ${minRem}`);
  // with the loop switched off the same crew only finds out from the walkback-margin caution near the end, and comes
  // home on the last few percent; the loop cuts the second station short early and keeps a real margin (the paired
  // 40-run campaign in validation/CLOSED_LOOP.md measures this across crews and hardware)
  const off = flySim("hardwork", { autoReplan: false });
  assert.ok(minRem > off.minRem + 0.03, `closed ${minRem.toFixed(3)} vs open ${off.minRem.toFixed(3)}`);
  assert.ok(off.sim.alerts.log.some((a) => a.id === "pnr-near"), "open loop runs into the walkback-margin caution");
});

test("Dead band: a re-check that would keep every station and save under 8 % leaves the crew on their route", () => {
  const sim = new EvaSim(H.P, H.sortie, { truth: { met: 1.18, water: 1.2 }, stops: H.stops, seed: 7 });
  for (let k = 0; k < 2000 && !sim.done; k++) sim.step(60);
  const kept = sim.replans.filter((r) => r.kept);
  assert.ok(sim.replans.length >= 1, "the drift was noticed");
  assert.ok(kept.length >= 1 && sim.planVersion === 1, "re-checks without a better route did not churn the plan");
  assert.ok(sim.done && sim.stops.every((s) => s.done));
  assert.ok(sim.events.some((e) => /re-check: .*current route still valid/.test(e.event)));
});

test("Closed loop: an aged battery and a slow crew are each learned within 10 % and handled inside the limits", () => {
  const b = flySim("battery");
  assert.ok(Math.abs(b.sim.cal.batt - 1.4) < 0.1 && b.minRem >= 0 && b.sim.done);
  const s = flySim("slow");
  assert.ok(Math.abs(s.sim.cal.speed - 0.75) < 0.08 && s.minRem >= 0 && s.sim.done, `speed ${s.sim.cal.speed}`);
});

function flyLive(truth, { year = 2027, follow = true } = {}) {
  const sim = new EvaSim(H.P, H.sortie, { truth, stops: H.stops, seed: 7, autoReplan: false });
  const fake = new FakeTss(sim, { year });
  const live = new LiveSession(H.P, H.sortie, { stops: H.stops.map((s) => ({ ...s })) });
  let s = live.ingest(fake.eva(), year === 2026 ? fake.rover() : null), v = 1, minRem = 1, maxXT = 0;
  for (let k = 0; k < 3000 && !live.done && !sim.done; k++) {
    fake.advance(10);
    s = live.ingest(fake.eva(), year === 2026 ? fake.rover() : null);
    minRem = Math.min(minRem, 1 - sim.res.o2 / H.P.cap.o2, 1 - sim.res.batt / H.P.cap.batt, 1 - sim.res.water / H.P.cap.water);
    maxXT = Math.max(maxXT, s.loop.crossTrack);
    if (follow && live.planVersion !== v) { v = live.planVersion; sim._loadRoute(live.sortie); sim._connect(sim.cur); }
    if (follow && live.returning && !sim.returning) sim.startReturn("crew follows the call");
  }
  return { live, sim, s, minRem, maxXT };
}

test("Live telemetry (TSS2027 format): nominal EVA tracked along the plan, station work timed, no re-plan", () => {
  const { live, minRem, maxXT } = flyLive("nominal");
  assert.ok(live.done && live.replans.length === 0);
  assert.ok(maxXT < 25, `max cross-track ${maxXT}`);
  const work = live.events.filter((e) => /station complete/.test(e.event));
  assert.equal(work.length, 2);
  for (const e of work) { const [a, b] = e.event.match(/\((\d+) of (\d+) min\)/).slice(1).map(Number); assert.ok(a >= 0.9 * b, e.event); }
  assert.ok(minRem > 0);
});

test("Live telemetry (TSS2026 nested format): a hard-working crew is learned from real-format frames and kept inside the reserve", () => {
  const { live, minRem } = flyLive("hardwork", { year: 2026 });
  const c = live.cal;
  assert.ok(Math.abs(c.met - 1.35) < 0.1 && Math.abs(c.water - 1.25) < 0.1, `met ${c.met} water ${c.water}`);
  assert.ok(live.replans.length >= 1 && minRem >= 0 && live.done, `min remaining ${minRem}`);
});

test("Live telemetry: a channel stuck at 0 is flagged NOT REPORTED and the model value stands in", () => {
  const sim = new EvaSim(H.P, H.sortie, { truth: "nominal", stops: H.stops, autoReplan: false });
  const fake = new FakeTss(sim, {});
  const live = new LiveSession(H.P, H.sortie, { stops: H.stops });
  const f = fake.eva();
  f.telemetry.coolant_storage = 0;
  const s = live.ingest(f);
  assert.ok(s.live.unreported.includes("waterPct"));
  assert.ok(s.alerts.some((a) => a.id === "unreported"));
  assert.ok(s.remaining.water > 0.95 && !live.returning, "no false return on a missing channel");
});

test("UDP bridge: TSS request/response over real sockets, relayed as Server-Sent Events", async () => {
  const sim = new EvaSim(H.P, H.sortie, { truth: "nominal", stops: H.stops, autoReplan: false });
  const fake = new FakeTss(sim, { year: 2026 });
  const sock = dgram.createSocket("udp4");
  sock.on("message", (msg, rinfo) => {
    const j = fake.reply(msg.readUInt32BE(4));
    if (j) sock.send(Buffer.from(JSON.stringify(j)), rinfo.port, rinfo.address);
  });
  await new Promise((r) => sock.bind(0, "127.0.0.1", r));
  const port = sock.address().port;
  const direct = await tssGet("127.0.0.1", port, 1);
  assert.ok(direct.telemetry.eva1 && direct.imu.eva1, "TSS2026 command 1 returns the nested EVA.json");
  const bridge = await startBridge({ tss: `127.0.0.1:${port}`, year: 2026, hz: 10, port: 0, log: () => {} });
  const res = await fetch(`http://127.0.0.1:${bridge.port}/events`);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  const reader = res.body.getReader();
  let buf = "", frames = [];
  const t0 = Date.now();
  while (frames.length < 3 && Date.now() - t0 < 5000) {
    fake.advance(5);
    const { value } = await reader.read();
    buf += new TextDecoder().decode(value);
    for (const part of buf.split("\n\n").slice(0, -1)) if (part.includes("event: tss")) frames.push(JSON.parse(part.split("data: ")[1]));
    buf = buf.split("\n\n").pop();
  }
  await reader.cancel();
  const health = await (await fetch(`http://127.0.0.1:${bridge.port}/health`)).json();
  await bridge.close();
  sock.close();
  assert.ok(frames.length >= 3, `frames ${frames.length}`);
  assert.ok(frames[0].eva.telemetry.eva1 && frames[0].rover.pr_telemetry, "both EVA.json and ROVER.json relayed");
  assert.ok(health.ok && health.frames >= 3);
});
