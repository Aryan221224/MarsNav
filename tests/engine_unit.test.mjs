// Unit tests for the engine's pure functions. Run: node --test tests/
// Each expected value comes from a published source or from physics, not from the code under test.
import test from "node:test";
import assert from "node:assert/strict";

import { marsState, jdTT, lmstHours, ltstHours, sunPosition, msFromM2020Sol, m2020SolFromMs, M2020, ttMinusUtc, earthMarsLight } from "../engine/marstime.js";
import { ahp, fromUpper, L1_MATRIX, SAFETY_MATRICES, S1_MATRIX, safetyLeafWeights, defaultL1, RI } from "../engine/ahp.js";
import { cvarFactor, normInv, normCdf, riskValue, pExceed } from "../engine/risk.js";
import { walkSpeedKmh, minettiCost, marsWalkCost, o2KgPerH, co2KgPerH, suitHeat, vehicleSpeedKmh, PROFILES, WALK } from "../engine/physio.js";
import { lonlatToXY, xyToLonLat, haversine, bearing, Grid } from "../engine/geo.js";
import { MinHeap } from "../engine/heap.js";
import { evaluateRules, AlertManager, LEVEL } from "../engine/alerts.js";
import { guidanceLegs } from "../engine/report.js";
import { distanceTransform, percentile, fmtDuration } from "../engine/util.js";

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b} +/- ${tol}, got ${a}`);

// --------------------------------------------------------------------------------------------- Mars clock ----
test("Mars24 worked example (Allison & McEwen 2000, 2000-01-06 00:00 UTC)", () => {
  const ms = Date.UTC(2000, 0, 6, 0, 0, 0);
  near(ttMinusUtc(ms), 64.184, 0.001, "TT-UTC");
  const st = marsState(jdTT(ms));
  near(st.Ls, 277.18758, 2e-4, "Ls");
  near(st.MTC, 23.99425, 2e-4, "MTC");
  near(st.msd, 44795.9998, 2e-4, "MSD");
});

test("Perseverance landing time is mid-afternoon LMST at Jezero (NASA: about 3:54 pm)", () => {
  const ms = Date.parse(M2020.landingUTC);
  const h = lmstHours(marsState(jdTT(ms)), M2020.lonEast);
  near(h, 15 + 54 / 60, 3 / 60, "landing LMST");
  assert.equal(m2020SolFromMs(ms).sol, 0);
});

test("M2020 sol/LMST round trip", () => {
  for (const [sol, h] of [[1, 12], [500, 6.5], [2000, 8.5]]) {
    const ms = msFromM2020Sol(sol, h);
    const back = m2020SolFromMs(ms);
    assert.equal(back.sol, sol);
    near(back.lmstHours, h, 1 / 3600, "LMST");
  }
});

test("Sun is near zenith-limited at local noon and below the horizon at local midnight", () => {
  const noon = msFromM2020Sol(1000, 12);
  const st = marsState(jdTT(noon));
  const lt = ltstHours(st, M2020.lonEast);
  near(lt, 12, 0.9, "LTST near LMST (equation of time < 50 min)");
  assert.ok(sunPosition(st, M2020.lonEast, M2020.lat).elevation > 40);
  const mid = marsState(jdTT(msFromM2020Sol(1000, 0)));
  assert.ok(sunPosition(mid, M2020.lonEast, M2020.lat).elevation < -40);
});

test("Earth-Mars light time: 11 min 22 s at Perseverance's landing (NASA), 0.415 AU at the Oct 2020 close approach", () => {
  near(earthMarsLight(Date.parse(M2020.landingUTC)).lightS, 11 * 60 + 22, 3);
  near(earthMarsLight(Date.parse("2020-10-06T14:18:00Z")).au, 0.4149, 0.001);
});

// ---------------------------------------------------------------------------------------------------- AHP ----
test("AHP: perfectly consistent matrix gives exact weights and CR 0", () => {
  const w = [0.5, 0.3, 0.2];
  const A = w.map((a) => w.map((b) => a / b));
  const r = ahp(A);
  r.weights.forEach((v, i) => near(v, w[i], 1e-9));
  near(r.lambdaMax, 3, 1e-9);
  near(r.CR, 0, 1e-9);
});

test("AHP: Saaty random index table and inconsistency detection", () => {
  assert.equal(RI[3], 0.58);
  const A = fromUpper(3, { "0,1": 9, "1,2": 9, "0,2": 1 / 9 }); // a > b > c but c > a strongly: inconsistent
  const r = ahp(A);
  assert.ok(r.CR > 0.1 && !r.consistent);
});

test("AHP: the shipped judgements are consistent and weights sum to 1", () => {
  for (const A of [L1_MATRIX, SAFETY_MATRICES.foot.A, SAFETY_MATRICES.rover.A, S1_MATRIX.A]) {
    const r = ahp(A);
    assert.ok(r.CR < 0.1, `CR ${r.CR}`);
    near(r.weights.reduce((a, b) => a + b, 0), 1, 1e-12);
  }
  const l1 = defaultL1();
  assert.ok(l1.S > l1.C && l1.S > l1.T, "safety is the top-level priority");
  for (const mode of ["foot", "rover"]) near(Object.values(safetyLeafWeights(mode)).reduce((a, b) => a + b, 0), 1, 1e-12);
});

// --------------------------------------------------------------------------------------------------- risk ----
test("CVaR factor for a normal at alpha 0.9 is 1.7550 (closed form phi(z)/(1-alpha))", () => {
  near(cvarFactor(0.9), 1.7550, 1e-3);
  near(normInv(0.975), 1.959964, 1e-5);
  near(normCdf(1.959964), 0.975, 1e-5);
  assert.equal(riskValue(0.3, 0.1, { kind: "mean" }), 0.3);
  near(riskValue(0.3, 0.1, { kind: "cvar", alpha: 0.9 }), 0.3 + 0.1755, 1e-3);
  near(pExceed(0, 1, 1.959964), 0.025, 1e-5);
});

// ----------------------------------------------------------------------------------------------- physiology --
test("Minetti 2002 walking cost: 2.5 J/kg/m level, higher uphill, minimum on a gentle downhill", () => {
  near(minettiCost(0), 2.5, 1e-12);
  assert.ok(minettiCost(0.2) > minettiCost(0));
  assert.ok(minettiCost(-0.1) < minettiCost(0));
  assert.ok(marsWalkCost(0) < minettiCost(0), "Mars gravity lowers the cost of walking");
});

test("Suited walking speed: Apollo 2.7 km/h on the level, slower on slopes, zero past the 20 deg limit", () => {
  near(walkSpeedKmh(0), WALK.APOLLO_LONG_KMH, 1e-9);
  assert.ok(walkSpeedKmh(10) < walkSpeedKmh(5) && walkSpeedKmh(5) < walkSpeedKmh(0));
  assert.ok(walkSpeedKmh(0, "sand") < walkSpeedKmh(0, "firm"));
  assert.equal(walkSpeedKmh(20.5), 0);
  assert.equal(walkSpeedKmh(-21), 0);
});

test("Metabolic gas exchange: 1 kW burns about 0.26 kg O2/h (20.1 kJ per litre O2)", () => {
  near(o2KgPerH(1000), (3600 / 20.1) * 1.429 / 1000, 1e-9);
  near(co2KgPerH(1000) / o2KgPerH(1000), 0.85 * 44 / 32, 1e-9);
});

test("Suit heat balance: hot work needs cooling water, cold rest needs heater power", () => {
  const hot = suitHeat(400, 0, 250, 500);
  assert.ok(hot.reject > 0 && hot.heat === 0);
  const cold = suitHeat(120, 0, 170, 0);
  assert.ok(cold.heat > 0 && cold.reject === 0);
});

test("Vehicles: Perseverance-class tops out near 0.1 km/h; crew rover respects its sand slope limit", () => {
  const v = vehicleSpeedKmh(PROFILES.robot, 0);
  assert.ok(v > 0 && v <= 0.152);
  assert.equal(vehicleSpeedKmh(PROFILES.rover, 13, "sand"), 0);
  assert.ok(vehicleSpeedKmh(PROFILES.rover, 13, "firm") > 0);
});

// ---------------------------------------------------------------------------------------------------- geo ----
test("Projection round trip and haversine on the Mars sphere", () => {
  const [x, y] = lonlatToXY(77.45, 18.44);
  const [lon, lat] = xyToLonLat(x, y);
  near(lon, 77.45, 1e-10);
  near(lat, 18.44, 1e-10);
  near(haversine(0, 0, 0, 1), 3396190 * Math.PI / 180, 1e-6, "1 deg of latitude");
  near(bearing(77, 18, 77, 18.1), 0, 1e-6, "due north");
  near(bearing(77, 18, 77.1, 18), 90, 0.1, "due east");
  const g = new Grid({ x0: 0, y0: 100, res: 10, width: 10, height: 10 });
  const [rf, cf] = g.rcOfLonLat(...g.cellLonLat(3, 7));
  near(rf, 3, 1e-6);
  near(cf, 7, 1e-6);
  assert.deepEqual(g.rc(g.idx(3, 7)), [3, 7]);
});

test("MinHeap pops in priority order", () => {
  const h = new MinHeap();
  const vals = [5, 1, 9, 3, 7, 2, 8];
  vals.forEach((v, i) => h.push(v, i));
  const out = [];
  while (h.size) out.push(vals[h.pop()]);
  assert.deepEqual(out, [...vals].sort((a, b) => a - b));
});

test("Chamfer distance transform is within 8 % of Euclidean", () => {
  const W = 41, H = 41, src = new Uint8Array(W * H);
  src[20 * W + 20] = 1;
  const d = distanceTransform(src, W, H, 10);
  near(d[20 * W + 40], 200, 1e-6, "straight");
  near(d[0], Math.hypot(200, 200), 0.08 * Math.hypot(200, 200), "diagonal");
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(fmtDuration(3905), "01:05:05");
});

// ------------------------------------------------------------------------------------------------- alerts ----
test("Caution & warning: walkback limit is a WARNING, low margin a CAUTION, sorted by priority", () => {
  const w = evaluateRules({ margins: { o2: -0.01, co2: 0.5, water: 0.5, batt: 0.5, time: 3600 } });
  assert.equal(w[0].id, "pnr");
  assert.equal(w[0].level, LEVEL.WARNING);
  const c = evaluateRules({ margins: { o2: 0.05, co2: 0.5, water: 0.5, batt: 0.5, time: 3600 }, sigma: 40 });
  assert.deepEqual(c.map((a) => a.id), ["pnr-near", "pos"]);
  assert.equal(evaluateRules({ margins: { o2: 0.5, co2: 0.5, water: 0.5, batt: 0.5, time: 3600 } }).length, 0);
});

test("Alert manager latches: a warning that clears unseen stays until acknowledged; new warnings unsilence", () => {
  const M = new AlertManager();
  M.update(evaluateRules({ sunsetMinLeft: 20 }), 0);
  assert.equal(M.counts()[LEVEL.WARNING], 1);
  assert.equal(M.master(), LEVEL.WARNING);
  M.silence();
  assert.equal(M.silenced, true);
  M.update([], 10); // condition gone, crew has not acknowledged: stays latched, marked cleared
  assert.equal(M.list().length, 1);
  assert.equal(M.list()[0].cleared, true);
  M.ack("sunset");
  assert.equal(M.list().length, 0);
  M.update(evaluateRules({ faults: { leak: true } }), 20);
  assert.equal(M.silenced, false, "a new warning always sounds");
  M.ackAll();
  assert.equal(M.master(), 0, "acknowledged: master alarm off, alert still listed while active");
  assert.equal(M.list().length, 1);
});

// ------------------------------------------------------------------------------------------------- report ----
test("Guidance legs: a straight 1 km track becomes one heading, station work becomes its own row", () => {
  const pts = [];
  for (let k = 0; k <= 100; k++) {
    const [lon, lat] = xyToLonLat(4.4e6, 1.1e6 + 10 * k);
    pts.push({ x: 4.4e6, y: 1.1e6 + 10 * k, lon, lat, dist: 10 * k, t: 13.3 * k, elev: -2500 + 0.1 * k, work: k === 100 ? 1800 : 0,
      margins: { o2: 0.5, co2: 0.5, water: 0.5, batt: 0.5 } });
  }
  const legs = guidanceLegs(pts);
  assert.equal(legs.length, 2);
  near(legs[0].heading, 0, 0.5, "north");
  near(legs[0].dist, 1000, 1e-9);
  assert.equal(legs[1].work, 1800);
});
