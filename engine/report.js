// report.js - products that leave the software: the printable EVA cue card (paper fallback, research doc 17:
// Artemis crews carry paper tools) and GeoJSON for other GIS tools (MMGIS, QGIS).

import { bearing, haversine } from "./geo.js";
import { taskOf, TASK_PRESETS } from "./task.js";
import { fmtDuration } from "./util.js";
import { M2020_CLOCK, fmtHours, marsState, jdTT, lmstHours } from "./marstime.js";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Douglas-Peucker simplification on projected x/y (metres); returns kept indices. */
function douglasPeucker(pts, tol) {
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = pts[a].x, ay = pts[a].y, bx = pts[b].x, by = pts[b].y;
    const L = Math.hypot(bx - ax, by - ay) || 1e-9;
    let best = -1, dmax = 0;
    for (let k = a + 1; k < b; k++) {
      const d = Math.abs((bx - ax) * (ay - pts[k].y) - (ax - pts[k].x) * (by - ay)) / L;
      if (d > dmax) { dmax = d; best = k; }
    }
    if (dmax > tol && best > 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  const out = [];
  for (let k = 0; k < pts.length; k++) if (keep[k] || pts[k].work) out.push(k);
  return out;
}

/**
 * Guidance legs a crew can follow: headings between Douglas-Peucker vertices (tolerance ~ the position-error
 * corridor, 25 m), with legs shorter than `minLenM` merged, plus station-work rows.
 */
export function guidanceLegs(pts, tol = 25, minLenM = 120) {
  if (pts.length < 2) return [];
  let idx = douglasPeucker(pts, tol);
  // merge short legs (never across a station)
  const merged = [idx[0]];
  for (let k = 1; k < idx.length; k++) {
    const i = idx[k], prev = merged[merged.length - 1];
    const len = pts[i].dist - pts[prev].dist;
    if (len < minLenM && !pts[i].work && k < idx.length - 1) continue;
    merged.push(i);
  }
  const legs = [];
  for (let k = 1; k < merged.length; k++) {
    const a = pts[merged[k - 1]], b = pts[merged[k]];
    const d = b.dist - a.dist;
    if (d > 1) legs.push({ from: a, to: b, heading: bearing(a.lon, a.lat, b.lon, b.lat), dist: d,
      dt: b.t - a.t - (b.work || 0), climb: b.elev - a.elev, work: 0 });
    if (b.work) legs.push({ from: b, to: b, heading: 0, dist: 0, dt: b.work, climb: 0, work: b.work });
  }
  return legs;
}

export function cueCardHTML(sortie, meta) {
  const depart = meta.departMs;
  const st = marsState(jdTT(depart));
  const clock = meta.clock ?? M2020_CLOCK;
  const sol = clock.solFromMs(depart);
  const rows = [];
  let n = 1;
  for (const leg of sortie.legs) {
    rows.push(`<tr class="leghead"><td colspan="7">${esc(leg.from.name)} &rarr; ${esc(leg.to.name)}</td></tr>`);
    for (const g of guidanceLegs(leg.ev.pts)) {
      if (g.dist < 1 && !g.work) continue;
      const lmst = lmstHours(marsState(jdTT(depart + g.to.t * 1000)), meta.lon);
      // station work row carries the crew's stated task and its consumables budget
      const k = g.work ? taskOf(leg.to) : null, P = leg.ev.pts, a = P[P.length - 2], b = P[P.length - 1];
      const wb = g.work && a && b ? ` ${esc(TASK_PRESETS[k.task].label.split(":")[0])} ${k.workW} W; O2 ${((b.res.o2 - a.res.o2) * 1000).toFixed(0)} g, water ${((b.res.water - a.res.water) * 1000).toFixed(0)} g, batt ${(b.res.batt - a.res.batt).toFixed(0)} Wh${k.toolWh ? ` (tools ${k.toolWh} Wh)` : ""}` : "";
      rows.push(`<tr><td>${n++}</td><td>${g.work ? `WORK:${wb}` : String(Math.round(g.heading)).padStart(3, "0") + "&deg;"}</td>` +
        `<td>${g.work ? "-" : (g.dist / 1000).toFixed(2) + " km"}</td><td>${g.work ? fmtDuration(g.work) : fmtDuration(g.dt)}</td>` +
        `<td>${g.climb >= 0 ? "+" : ""}${g.climb.toFixed(0)} m</td><td>${fmtHours(lmst).slice(0, 5)}</td>` +
        `<td>${(100 * Math.min(...["o2", "co2", "water", "batt"].map((k) => g.to.margins[k]))).toFixed(0)} %</td></tr>`);
    }
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>EVA cue card</title><style>
  body{font-family:system-ui,Segoe UI,Roboto,sans-serif;margin:16px;color:#000}
  h1{font-size:18px;margin:0 0 4px} .sub{font-size:12px;margin-bottom:10px}
  table{border-collapse:collapse;width:100%;font-size:12px} td,th{border:1px solid #000;padding:3px 5px;text-align:left}
  th{background:#ddd} .leghead td{background:#eee;font-weight:600} .num{font-family:ui-monospace,Consolas,monospace}
  .box{border:2px solid #000;padding:6px;margin:8px 0;font-size:12px}
  </style></head><body>
  <h1>MARSNAV - EVA CUE CARD - ${esc(meta.title || "")}</h1>
  <div class="sub num">Depart ${esc(clock.name)} sol ${sol.sol} LMST ${fmtHours(sol.lmstHours).slice(0, 5)} (UTC ${new Date(depart).toISOString().slice(0, 16)}Z)
  | Ls ${st.Ls.toFixed(1)}&deg; | Profile: ${esc(meta.profile)} | Route: ${esc(meta.routeName)}</div>
  <div class="box num">PLANNED: ${fmtDuration(sortie.t)} | ${(sortie.dist / 1000).toFixed(2)} km | O2 ${sortie.res.o2.toFixed(2)} kg |
  water ${sortie.res.water.toFixed(1)} kg | battery ${sortie.res.batt.toFixed(0)} Wh | min walkback margin ${(100 * sortie.minMargin).toFixed(0)} %
  | dose ~${(sortie.doseMSv ?? 0).toFixed(2)} mSv
  | sunset LMST ${fmtHours(lmstHours(marsState(jdTT(sortie.sunsetMs)), meta.lon)).slice(0, 5)} | back by ${fmtDuration(sortie.timeEndS)} MET</div>
  <table><tr><th>#</th><th>Heading</th><th>Distance</th><th>Time</th><th>Climb</th><th>Arrive LMST</th><th>Walkback margin</th></tr>
  ${rows.join("\n")}</table>
  ${sortie.seamCells ? '<div class="box">DATA CHECK: this route crosses a repaired elevation-model seam (a join between two source DEMs). Confirm the ground on imagery or by observation before committing.</div>' : ""}
  ${sortie.lowConfFrac > 0.25 ? `<div class="box">DATA CONFIDENCE: ${(100 * sortie.lowConfFrac).toFixed(0)} % of this route is mapped from 20 m data only (no 1 m DTM). Boulders and small scarps below 20 m are not in the map.</div>` : ""}
  <div class="box">CONTINGENCY: if any consumable margin reads 0 %, or on suit fault, stop work and follow the walkback route
  (heading back to the habitat along the planned track). Position is dead-reckoned: re-fix at each landmark; report
  position error over +/-100 m. Never enter hatched keep-out zones (sample depot, active rover).</div>
  <div class="sub">Generated by MarsNav. Site: ${esc(meta.siteName || "")}. Terrain: ${esc(meta.terrainSource || "USGS DTMs")}. Not a flight product.</div>
  </body></html>`;
}

export function routeGeoJSON(routes, meta = {}) {
  const features = [];
  for (const [name, r] of Object.entries(routes)) {
    if (!r?.ok) continue;
    features.push({ type: "Feature", properties: { name, time_s: r.t, dist_m: r.dist, o2_kg: r.res.o2, min_margin: r.minMargin, ...meta },
      geometry: { type: "LineString", coordinates: r.pts.map((p) => [+p.lon.toFixed(7), +p.lat.toFixed(7), +p.elev.toFixed(1)]) } });
  }
  return { type: "FeatureCollection", features };
}
