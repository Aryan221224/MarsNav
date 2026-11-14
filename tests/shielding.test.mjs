// Terrain radiation shielding (engine/shielding.js): the formula, its check against Curiosity RAD at the Murray Buttes
// (validation/results/shielding_murray_buttes.json, built by validation/shielding_murray_buttes.py from HiRISE 1 m
// terrain), the map on real sites, route dose and the solar-particle-event advice. Run: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { shieldFromHorizon, shieldGrid, shieldAt, bestCover, GCR_ZENITH_EXP, ALBEDO_SHARE, RAD_SURROUNDINGS_FACTOR, RAD_MURRAY_BUTTES }
  from "../engine/shielding.js";
import { routeDoseMSv } from "../engine/sitecheck.js";
import { speAction, evaluateRules } from "../engine/alerts.js";
import { loadTerrain } from "../engine/terrain.js";
import { nodeIO } from "../engine/node_io.js";
import { Environment } from "../engine/environment.js";
import { CostModel } from "../engine/costmodel.js";
import { Planner } from "../engine/planner.js";
import { EvaSim } from "../engine/sim.js";
import { msFromM2020Sol, M2020 } from "../engine/marstime.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VAL = JSON.parse(fs.readFileSync(path.join(ROOT, "validation", "results", "shielding_murray_buttes.json")));
const ring = (h, n = 360) => new Array(n).fill(h);
const wall = (h, share, n = 3600) => Array.from({ length: n }, (_, k) => (k < Math.round(share * n) ? h : 0));

test("open flat ground is the reference: factor 1, nothing blocked", () => {
  const s = shieldFromHorizon(ring(0));
  assert.equal(s.factor, 1);
  assert.equal(s.blockedSky, 0);
  // terrain below the horizon (negative angles) does not count as cover
  assert.equal(shieldFromHorizon(ring(-3)).factor, 1);
});

test("the formula: share of the sky hidden and downward dose lost follow from cos^n zenith weighting", () => {
  // a 30 deg ring: sky hidden = sin 30 = 0.5; downward dose lost = 0.5^(n+1)
  const s = shieldFromHorizon(ring(30));
  assert.ok(Math.abs(s.blockedSky - 0.5) < 1e-9);
  assert.ok(Math.abs(s.downLost - Math.pow(0.5, GCR_ZENITH_EXP + 1)) < 1e-9);
  assert.ok(Math.abs(s.factor - (1 - (1 - ALBEDO_SHARE) * s.downLost + ALBEDO_SHARE * s.blockedSky)) < 1e-12);
  // a person at the bottom of a 90 deg shaft keeps only the albedo share plus what the walls send back
  assert.ok(Math.abs(shieldFromHorizon(ring(90)).factor - 2 * ALBEDO_SHARE) < 1e-9);
});

test("low hills barely matter; only high walls nearby cut the dose", () => {
  for (const h of [5, 10, 15]) assert.ok(Math.abs(shieldFromHorizon(ring(h)).factor - 1) < 0.03, `ring ${h} deg`);
  let prev = Infinity;
  for (const h of [30, 40, 50, 60, 70, 80, 90]) {
    const f = shieldFromHorizon(ring(h)).factor;
    assert.ok(f < prev, `factor falls as the walls rise (${h} deg)`);
    prev = f;
  }
  assert.ok(shieldFromHorizon(ring(60)).factor < 0.7);
});

test("RAD at the Murray Buttes: for the measured 19 % of blocked sky the formula brackets the measured -4 %", () => {
  const refF = VAL.result.ref_factor;
  const change = (h, a = ALBEDO_SHARE) => shieldFromHorizon(wall(h, RAD_MURRAY_BUTTES.blockedSky / Math.sin((h * Math.PI) / 180)), GCR_ZENITH_EXP, a).factor / refF - 1;
  const lo = change(25), hi = change(60);
  assert.ok(lo > RAD_MURRAY_BUTTES.doseChange && hi < RAD_MURRAY_BUTTES.doseChange, `range ${(100 * hi).toFixed(1)} to ${(100 * lo).toFixed(1)} %`);
  assert.ok(lo > -0.04 && lo < -0.02 && hi > -0.11 && hi < -0.08);
  // without the butte's own albedo the same walls overshoot: at the height that matches with albedo (about 30 deg),
  // the no-albedo formula gives nearly twice the measured drop
  const refNoAlbedo = VAL.stops.filter((s) => !s.park).reduce((a, s) => a + shieldFromHorizon(s.horizon_deg, GCR_ZENITH_EXP, 0).factor, 0) / VAL.stops.filter((s) => !s.park).length;
  const c30NoAlbedo = shieldFromHorizon(wall(30, 0.38), GCR_ZENITH_EXP, 0).factor / refNoAlbedo - 1;
  assert.ok(Math.abs(change(30) - RAD_MURRAY_BUTTES.doseChange) < 0.01, `with albedo at 30 deg: ${(100 * change(30)).toFixed(1)} %`);
  assert.ok(c30NoAlbedo < RAD_MURRAY_BUTTES.doseChange - 0.025, `no albedo at 30 deg: ${(100 * c30NoAlbedo).toFixed(1)} %`);
  // the stored validation numbers are the ones this formula gives
  assert.deepEqual(VAL.result.published_geometry_change_range_pct.map((v) => Math.round(v)), [Math.round(100 * lo), Math.round(100 * hi)]);
});

test("the JavaScript engine and the Python validation give the same factor at every Curiosity stop", () => {
  assert.equal(VAL.model.n, GCR_ZENITH_EXP);
  assert.equal(VAL.model.a, ALBEDO_SHARE);
  assert.ok(VAL.stops.length >= 20);
  for (const s of VAL.stops) {
    const f = shieldFromHorizon(s.horizon_deg);
    assert.ok(Math.abs(f.factor - s.factor) < 2e-5, `sol ${s.sol}`);
    assert.ok(Math.abs(f.blockedSky - s.blocked_sky) < 2e-5, `sol ${s.sol}`);
  }
  // the normalisation to RAD's own surroundings is the reference stops' mean factor
  assert.ok(Math.abs(VAL.result.ref_factor - RAD_SURROUNDINGS_FACTOR) < 5e-4);
});

test("geometry from orbit is reported honestly: the HiRISE horizon at the stop is below the published 19 %", () => {
  const [lo, hi] = VAL.result.blocked_sky_within_24m_pct;
  assert.ok(lo < hi && hi < 19, "the 1 m DTM under-states the butte at this stop (conservative for dose)");
  assert.ok(VAL.findings.some((f) => /unresolved/.test(f)));
  // MarsNav's 16 one-ray sectors give the same answer as 360 directions here
  assert.ok(Math.abs(VAL.result.predicted_change_pct_16_sectors - VAL.result.predicted_change_pct) < 0.5);
});

const DATA = path.join(ROOT, "app", "data");
const T = await loadTerrain(nodeIO(DATA));

test("shielding map on the real Jezero site: finite, bounded, ordinary ground at the RAD average", () => {
  const S = shieldGrid(T);
  assert.equal(S.factor.length, T.hzGrid.n);
  const a = Float32Array.from(S.factor).sort();
  for (const v of [a[0], a[a.length - 1]]) assert.ok(Number.isFinite(v) && v > 0.5 && v < 1.1);
  const median = a[a.length >> 1] / RAD_SURROUNDINGS_FACTOR;
  assert.ok(Math.abs(median - 1) < 0.01, `median relative factor ${median.toFixed(4)}`);
  assert.equal(shieldAt(T, -1), 1);
});

test("best cover search: never worse than staying put, within the radius, with a bearing and walking time", () => {
  const [x, y] = T.hzGrid.cellXY(Math.floor(T.hzGrid.height / 2), Math.floor(T.hzGrid.width / 2));
  const c = bestCover(T, x, y, { radiusM: 800 });
  assert.ok(c.best <= c.here + 1e-9);
  assert.ok(c.distM <= 800 + 1e-6 && c.walkMin >= 0);
  assert.ok(c.bearingDeg >= 0 && c.bearingDeg < 360);
  assert.ok(Math.abs(c.cutPct - 100 * (1 - c.best / c.here)) < 1e-6);
  // the steepest-walled spot on the site gives real cover (Jezero's delta scarps)
  const S = shieldGrid(T);
  let mn = Infinity;
  for (const v of S.factor) mn = Math.min(mn, v);
  assert.ok(mn / RAD_SURROUNDINGS_FACTOR < 0.995);
  assert.equal(bestCover(T, 1e9, 1e9), null);
});

test("route dose: each step at its altitude times the terrain factor; open-sky dose without it", () => {
  const pts = [{ t: 0, elev: -2500, shield: 0.9 }, { t: 3600, elev: -2500, shield: 1.0 }, { t: 7200, elev: -2500 }];
  const open = routeDoseMSv(pts, 600, { shielding: false });
  const sh = routeDoseMSv(pts);
  assert.ok(Math.abs(sh / open - 0.95) < 1e-9);
});

test("planned routes on Jezero carry the terrain factor and both doses", () => {
  const env = new Environment(T, JSON.parse(fs.readFileSync(path.join(DATA, "environment.json"))));
  const foot = new CostModel(T, env, { profile: "foot" });
  const P = new Planner(foot, { lon: M2020.lonEast, lat: M2020.lat }, { departMs: msFromM2020Sol(2000, 8.5), evaMaxS: 7 * 3600 });
  const amal = T.targets.find((t) => t.id === "AMAL");
  const plan = P.namedSorties([{ lon: amal.lon, lat: amal.lat, name: amal.name, dwell_min: amal.dwell_min }]);
  const r = plan.routes.balanced;
  assert.ok(r?.ok, "a feasible route");
  assert.ok(r.pts.every((p) => Number.isFinite(p.shield) && p.shield > 0.5 && p.shield < 1.1));
  assert.ok(r.doseMSv > 0 && r.doseOpenMSv > 0);
  const ratio = r.doseMSv / r.doseOpenMSv;
  assert.ok(ratio > 0.9 && ratio < 1.03, `route dose ratio ${ratio}`);
  // the solar-particle-event alert, raised in the simulator, names the walk home and what the terrain can do
  const sim = new EvaSim(P, r, { seed: 3 });
  for (let k = 0; k < 20; k++) sim.step(30);
  sim.inject("spe");
  const snap = sim.step(1);
  const a = snap.alerts.find((x) => x.id === "spe");
  assert.ok(a, "SPE warning raised");
  assert.match(a.action, /Return to habitat now \(\d+ min, walkback route loaded\)/);
  assert.match(a.action, /terrain|cover/);
});

test("solar-storm advice: habitat first; terrain cover only as a fallback, and only when it is worth it", () => {
  const good = speAction({ homeMin: 42.4, cover: { cutPct: 12.3, distM: 200, walkMin: 1.7, bearingDeg: 135 } });
  assert.match(good, /^Return to habitat now \(42 min/);
  assert.match(good, /Only if the habitat cannot be reached: terrain cover 2 min SE cuts cosmic-ray dose ~12 %, less for solar protons/);
  const poor = speAction({ homeMin: 10, cover: { cutPct: 2.2, distM: 300, walkMin: 2, bearingDeg: 0 } });
  assert.match(poor, /No natural cover within reach: terrain here cuts the dose by 2 % at most/);
  assert.equal(speAction(null), "Return to habitat now (walkback route loaded)");
  const out = evaluateRules({ spe: true, speShelter: { homeMin: 5, cover: null } });
  assert.equal(out[0].id, "spe");
  assert.equal(out[0].action, "Return to habitat now (5 min, walkback route loaded)");
});
