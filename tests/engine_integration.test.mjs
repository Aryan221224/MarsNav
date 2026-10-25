// Integration tests on the real Jezero data shipped in app/data. Run: node --test tests/
// These check the safety contract of the planner, not just that it returns something:
// no route touches a no-go cell, suited-walk slopes stay within the 20 deg limit, keep-outs are never entered,
// a feasible plan never plans against the walkback reserve, and a suit leak turns the EVA around and gets the crew home.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadTerrain } from "../engine/terrain.js";
import { nodeIO } from "../engine/node_io.js";
import { Environment } from "../engine/environment.js";
import { CostModel, VETO } from "../engine/costmodel.js";
import { Planner } from "../engine/planner.js";
import { walkbackField, viewshed } from "../engine/fields.js";
import { optimiseSortie } from "../engine/sortie.js";
import { EvaSim } from "../engine/sim.js";
import { cueCardHTML, routeGeoJSON } from "../engine/report.js";
import { pressureEnvelope, SUIT_COOLING_LIMIT_PA } from "../engine/sitecheck.js";
import { NAV_SCENARIOS } from "../engine/costmodel.js";
import { msFromM2020Sol, M2020 } from "../engine/marstime.js";
import { haversine } from "../engine/geo.js";

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "app", "data");
const T = await loadTerrain(nodeIO(DATA));
const env = new Environment(T, JSON.parse(fs.readFileSync(path.join(DATA, "environment.json"))));
const HAB = { lon: M2020.lonEast, lat: M2020.lat };
const tgt = (id) => T.targets.find((t) => t.id === id);
const departMs = msFromM2020Sol(2000, 8.5);

const foot = new CostModel(T, env, { profile: "foot" });
const P = new Planner(foot, HAB, { departMs, evaMaxS: 7 * 3600 });
viewshed(foot.coarse, P.baseCoarse, 10);
const amal = tgt("AMAL");
const plan = P.namedSorties([{ lon: amal.lon, lat: amal.lat, name: amal.name, dwell_min: amal.dwell_min }]);

test("terrain loads with every layer at the documented grid size", () => {
  const g = T.grid;
  assert.equal(g.res, 10);
  assert.equal(g.width, 1968);
  assert.equal(g.height, 1188);
  for (const name of Object.keys(T.manifest.layers)) {
    const L = T.manifest.layers[name];
    if (L.grid && L.grid !== "ops10") continue;
    assert.ok(T.get(name, g.idx(600, 1000)) !== undefined, name);
  }
  assert.ok(T.targets.length >= 8 && T.keepouts.length >= 2);
});

test("all named routes plan HAB -> Amalik -> HAB and the balanced one is feasible", () => {
  assert.ok(plan.ok, plan.fastest?.reason);
  for (const k of ["fastest", "balanced", "safest", "economy"]) assert.ok(plan.routes[k].ok, `${k}: ${plan.routes[k].reason}`);
  const b = plan.routes.balanced;
  assert.ok(b.feasible);
  assert.ok(b.t <= P.timeEndS + 1, "inside the EVA / daylight window");
  assert.ok(b.minMargin >= 0, "never plans against the walkback reserve");
  assert.ok(b.dist > 2 * haversine(HAB.lon, HAB.lat, amal.lon, amal.lat) * 0.98, "at least the out-and-back distance");
});

test("no planned point lies on a no-go cell, inside a keep-out, or on a slope over the suited limit", () => {
  for (const [k, r] of Object.entries(plan.routes)) {
    if (!r?.ok) continue;
    for (const p of r.pts) {
      assert.equal(foot.fine.veto[p.i], VETO.NONE ?? 0, `${k}: vetoed cell ${p.i} (${foot.fine.veto[p.i]})`);
    }
    assert.ok(r.maxSlope <= 20 + 1e-6, `${k}: grade ${r.maxSlope}`);
  }
});

test("the safest route carries less hazard than the fastest; the fastest is not slower than the safest", () => {
  const f = plan.routes.fastest, s = plan.routes.safest;
  assert.ok(s.X.S <= f.X.S * 1.0001, `S safest ${s.X.S} vs fastest ${f.X.S}`);
  assert.ok(f.t <= s.t * 1.02, `t fastest ${f.t} vs safest ${s.t}`);
});

test("walkback field: zero at the habitat, grows with distance, finite across the reachable area", () => {
  const F = P.field;
  assert.equal(F.time[P.baseCoarse], 0);
  const g = foot.coarse.grid;
  const [r0, c0] = g.rc(P.baseCoarse);
  const t1 = F.time[g.idx(r0, c0 + 10)], t2 = F.time[g.idx(r0, c0 + 25)];
  assert.ok(Number.isFinite(t1) && Number.isFinite(t2) && t2 > t1 && t1 > 0);
  let finite = 0;
  for (let i = 0; i < g.n; i++) if (Number.isFinite(F.time[i])) finite++;
  assert.ok(finite / g.n > 0.5);
});

test("sortie optimiser only proposes plans inside the time, O2 and battery budgets", () => {
  const cands = ["ROCH", "ISSO", "AMAL", "DTOP", "CHEY", "RIM"].map(tgt).filter(Boolean);
  const out = optimiseSortie(P, cands, { maxStops: 3 });
  assert.ok(out.options.length > 0);
  for (const o of out.options) {
    assert.ok(o.timeS <= out.budgetT && o.o2Kg <= out.budgetO2);
  }
});

test("EVA simulation: nominal run ends at the habitat; a suit leak raises a WARNING and returns the crew", () => {
  const b = plan.routes.balanced;
  const nominal = new EvaSim(P, b);
  let s;
  for (let k = 0; k < 2000 && !nominal.done; k++) s = nominal.step(60);
  assert.ok(nominal.done, "nominal EVA finishes");
  assert.equal(nominal.cur, P.baseFine);

  const sim = new EvaSim(P, b);
  for (let k = 0; k < 40; k++) sim.step(60); // 40 min out
  sim.inject("leak");
  s = sim.step(1);
  assert.ok(sim.returning, "leak triggers the return");
  assert.ok(s.alerts.some((a) => a.id === "leak" && a.level === 3));
  for (let k = 0; k < 2000 && !sim.done; k++) s = sim.step(60);
  assert.ok(sim.done);
  assert.equal(sim.cur, P.baseFine, "crew is back at the habitat");
  assert.ok(sim.t < nominal.t, "contingency return is shorter than completing the plan");
});

test("rover profile: walkback rule restricts range; rescue-rover mode relaxes it", () => {
  const rover = new CostModel(T, env, { profile: "rover" });
  const strict = new Planner(rover, HAB, { departMs, evaMaxS: 7 * 3600 });
  const rescue = new Planner(rover, HAB, { departMs, evaMaxS: 7 * 3600, rescue: true });
  let a = 0, b = 0;
  for (let i = 0; i < rover.coarse.n; i++) {
    if (strict.field.time[i] <= strict.timeEndS / 2) a++;
    if (rescue.field.time[i] <= rescue.timeEndS / 2) b++;
  }
  assert.ok(b > a, `rescue reachable ${b} vs walkback ${a}`);
});

test("exports: cue card and GeoJSON are well formed", () => {
  const html = cueCardHTML(plan.routes.balanced, { departMs, lon: HAB.lon, title: "test", profile: "foot", routeName: "balanced" });
  assert.match(html, /EVA CUE CARD/);
  assert.ok((html.match(/<tr>/g) || []).length >= 4);
  const gj = routeGeoJSON(plan.routes);
  assert.equal(gj.type, "FeatureCollection");
  for (const f of gj.features) {
    assert.equal(f.geometry.type, "LineString");
    for (const [lon, lat] of f.geometry.coordinates) assert.ok(lon > 77 && lon < 78 && lat > 18 && lat < 19);
  }
});

test("crew pin, two-step abort path and station procedure are driven by the simulation", () => {
  const sim = new EvaSim(P, plan.routes.balanced);
  let s;
  for (let k = 0; k < 400 && !(s && s.station); k++) s = sim.step(60);
  assert.ok(s.station, "reaches the station and reports the procedure");
  assert.ok(s.station.steps.length >= 5 && s.station.step >= 0);
  const p = sim.pin("layered outcrop");
  assert.ok(Number.isFinite(p.lon) && p.sigma > 0);
  assert.equal(sim.snapshot().pins.length, 1);
  sim.abort();
  assert.ok(sim.returning);
  for (let k = 0; k < 2000 && !sim.done; k++) sim.step(60);
  assert.equal(sim.cur, P.baseFine);
});

test("site check: Jezero stays under the 7.5 Torr suit-cooling limit all year", () => {
  const pe = pressureEnvelope(env, T);
  assert.ok(pe.pMaxPa < SUIT_COOLING_LIMIT_PA, `max ${pe.pMaxPa} Pa`);
  assert.ok(pe.pMinPa > 500 && pe.pMaxPa > pe.pMinPa);
});

test("navigation aids: an orbital constellation shrinks position error and the cliff stand-off", () => {
  const dr = new CostModel(T, env, { profile: "foot", nav: "dr" });
  const cons = new CostModel(T, env, { profile: "foot", nav: "constellation" });
  assert.equal(cons.s.posModel.driftFrac, NAV_SCENARIOS.constellation.driftFrac);
  let sd = 0, sc = 0, vd = 0, vc = 0;
  for (let i = 0; i < dr.fine.n; i += 13) { sd += dr.fine.sigma[i]; sc += cons.fine.sigma[i]; vd += dr.fine.veto[i] === VETO.CLIFF; vc += cons.fine.veto[i] === VETO.CLIFF; }
  assert.ok(sc < sd, "smaller position error");
  assert.ok(vc < vd, "fewer cliff stand-off vetoes");
});

test("portability: the CTX-only test site loads, auto-sites a habitat and plans a survey sortie", async () => {
  const D2 = path.join(DATA, "sites", "jezero_east");
  if (!fs.existsSync(path.join(D2, "manifest.json"))) return; // site not built in this checkout
  const T2 = await loadTerrain(nodeIO(D2));
  const env2 = new Environment(T2, JSON.parse(fs.readFileSync(path.join(D2, "environment.json"))));
  assert.ok(T2.site.base.auto);
  const m2 = new CostModel(T2, env2, { profile: "foot" });
  const P2 = new Planner(m2, T2.site.base, { departMs, evaMaxS: 7 * 3600 });
  const s1 = T2.targets.find((t) => t.id === "S1");
  const r = P2.namedSorties([{ lon: s1.lon, lat: s1.lat, name: s1.name, dwell_min: 30 }], { withFallback: false });
  assert.ok(r.ok && r.routes.balanced.feasible);
  assert.ok(r.routes.balanced.lowConfFrac > 0.9, "route is flagged as 20 m data only");
  // restore the Jezero projection for any later test in this file
  await loadTerrain(nodeIO(DATA));
});

test("infeasible plan: diagnosis finds the point of no return and the limiting resource", () => {
  const chey = tgt("CHEY");
  const stops = [{ lon: chey.lon, lat: chey.lat, name: chey.name, dwell_min: 60 }];
  const out = P.namedSorties(stops, { withFallback: false });
  assert.equal(out.ok, false, "Cheyava Falls is beyond a suited walk from the landing site");
  const d = P.diagnose(stops);
  assert.ok(d.ok && d.pnrIndex > 0);
  assert.ok(["o2", "co2", "water", "batt", "time"].includes(d.limiting));
  assert.ok(d.pnrDistM > 1000 && d.pnrDistM < d.totalDistM / 2, "must turn back before the halfway point");
  const p = d.pts[d.pnrIndex];
  assert.ok(Math.min(p.margins.o2, p.margins.co2, p.margins.water, p.margins.batt) >= 0, "still walkable home at the PNR");
  for (let k = 1; k < d.pts.length; k++) assert.ok(d.pts[k].dist >= d.pts[k - 1].dist, "distance is cumulative");
  assert.equal(P.cap.o2 < Infinity, true, "crew limits restored after diagnosis");
});

// ------------------------------------------------------------------- wheels in sand, rover autonomy in clutter ----
const robot = new CostModel(T, env, { profile: "robot" });
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b} +/- ${tol}, got ${a}`);

test("wheeled profiles count bedforms themselves as soft-ground hazard, not only mapped slip", () => {
  const sand = T.f32("sand"), pg = robot.fine, w13 = robot.leafW["S1.3"];
  assert.ok(w13 > 0);
  let checked = 0;
  for (let i = 0; i < pg.n; i += 7) {
    if (pg.veto[i] || !Number.isFinite(sand[i])) continue;
    const floor = w13 * Math.min(1, Math.max(0, (sand[i] - 0.2) / 0.6));
    assert.ok(pg.haz[i] >= floor - 1e-6, `cell ${i}: hazard ${pg.haz[i]} below bedform floor ${floor}`);
    checked++;
  }
  assert.ok(checked > 10000);
});

test("robotic scout slows in cluttered terrain (AutoNav); crews and the crew rover do not use the factor", () => {
  const pg = robot.fine, f = pg.speedF;
  assert.ok(f && f.length === pg.n);
  assert.equal(foot.fine.speedF, null);
  assert.equal(new CostModel(T, env, { profile: "rover" }).fine.speedF, null);
  let lo = Infinity, hi = 0;
  for (const v of f) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  assert.ok(lo >= 0.5 - 1e-6 && hi <= 1 + 1e-6, `factor range ${lo}..${hi}`);
  // the edge time scales exactly as 1 / factor
  const g = pg.grid, ms = msFromM2020Sol(500, 10);
  let u = -1, v = -1;
  for (let i = g.width + 1; i < pg.n - 1 && u < 0; i++) if (!pg.veto[i] && !pg.veto[i + 1] && f[i + 1] < 0.75) { u = i; v = i + 1; }
  assert.ok(u >= 0, "a cluttered cell next to an open one exists");
  const e1 = robot.edge(pg, u, v, 10, ms);
  pg.speedF = null;
  const e0 = robot.edge(pg, u, v, 10, ms);
  pg.speedF = f;
  near(e1.t / e0.t, 1 / f[v], 1e-6, "time ratio");
});
