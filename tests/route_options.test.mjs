// Route options chosen by the crew: start point, visiting order, one-way finish. The walk-home guarantee to the
// habitat must hold on every leg whatever sequence the crew picks. Run: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadTerrain } from "../engine/terrain.js";
import { nodeIO } from "../engine/node_io.js";
import { Environment } from "../engine/environment.js";
import { CostModel } from "../engine/costmodel.js";
import { Planner } from "../engine/planner.js";
import { viewshed } from "../engine/fields.js";
import { EvaSim } from "../engine/sim.js";
import { msFromM2020Sol, M2020 } from "../engine/marstime.js";

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "app", "data");
const T = await loadTerrain(nodeIO(DATA));
const env = new Environment(T, JSON.parse(fs.readFileSync(path.join(DATA, "environment.json"))));
const HAB = { lon: M2020.lonEast, lat: M2020.lat };
const foot = new CostModel(T, env, { profile: "foot" });
const P = new Planner(foot, HAB, { departMs: msFromM2020Sol(2000, 8.5), evaMaxS: 7 * 3600 });
viewshed(foot.coarse, P.baseCoarse, 10);
// two nearby points east and south-west of the habitat
const A = { lon: HAB.lon + 0.012, lat: HAB.lat + 0.004, name: "A", dwell_min: 10 };
const B = { lon: HAB.lon - 0.006, lat: HAB.lat - 0.008, name: "B", dwell_min: 10 };
const W = { T: 1, S: 1, C: 1, R: 1, V: 1 };

test("default sortie is a round trip HAB -> stops -> HAB in list order", () => {
  const so = P.planSortie([A, B], W, W);
  assert.ok(so.ok, so.reason);
  assert.deepEqual(so.sequence, ["Habitat", "A", "B", "Habitat"]);
  assert.equal(so.endAt, "base");
});

test("order is the crew's: B then A", () => {
  const so = P.planSortie([B, A], W, W);
  assert.ok(so.ok, so.reason);
  assert.deepEqual(so.legs.map((l) => l.to.name), ["B", "A", "Habitat"]);
});

test("one-way sortie finishes at the last station and keeps the walkback guarantee", () => {
  const so = P.planSortie([A, B], W, W, { end: "last" });
  assert.ok(so.ok, so.reason);
  assert.deepEqual(so.sequence, ["Habitat", "A", "B"]);
  const last = so.pts[so.pts.length - 1];
  assert.ok(Math.abs(last.lon - B.lon) < 0.001 && Math.abs(last.lat - B.lat) < 0.001, "ends at B");
  for (const p of so.pts) if (p.margins) assert.ok(Number.isFinite(p.margins.o2), "walk-home margin evaluated at every point");
});

test("start at a station (rover drop-off): A -> B -> HAB", () => {
  const so = P.planSortie([B], W, W, { start: { lon: A.lon, lat: A.lat, name: "A" } });
  assert.ok(so.ok, so.reason);
  assert.deepEqual(so.sequence, ["A", "B", "Habitat"]);
});

test("named routes honour the chosen sequence", () => {
  const out = P.namedSorties([A, B], { withFallback: true, end: "last" });
  assert.ok(out.ok);
  for (const [name, r] of Object.entries(out.routes)) if (r?.ok) assert.equal(r.legs[r.legs.length - 1].to.name, "B", name);
});

test("simulator treats every destination except the habitat as a station, one-way included", () => {
  const so = P.planSortie([A, B], W, W, { end: "last" });
  const sim = new EvaSim(P, so, { seed: 3 });
  assert.deepEqual(sim.stops.map((s) => s.name), ["A", "B"]);
  const rt = P.planSortie([A, B], W, W);
  assert.deepEqual(new EvaSim(P, rt, { seed: 3 }).stops.map((s) => s.name), ["A", "B"]);
});
