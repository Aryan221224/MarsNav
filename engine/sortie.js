// sortie.js - "what can we get done on this EVA?": choose which science stations to visit, and in what order, to
// maximise science value while the whole sortie (travel + station work + walk home) stays inside the time, daylight
// and consumables budget. A small orienteering problem, solved exactly for up to 15 candidates by Held-Karp dynamic
// programming over subsets (the best tour of every subset in one pass) on a matrix of leg times from one-to-all
// searches on the coarse grid. The estimate holds back 15 % of every budget because the
// detailed plan (10 m, hazard-aware, time-dependent) is typically 5-15 % longer than the coarse time field.

import { MinHeap } from "./heap.js";
import { MOVES, MOVE_LEN, movable } from "./fields.js";
import { gradeIndex } from "./costmodel.js";
import { MET, SUIT, o2KgPerH } from "./physio.js";
import { taskOf } from "./task.js";

/** One-to-all travel time (s) on plan grid pg with the model's profile tables (time-independent). */
export function timeField(model, pg, src) {
  const g = pg.grid, n = pg.n, W = g.width;
  const tb = model.tables;
  const time = new Float32Array(n).fill(Infinity);
  const done = new Uint8Array(n);
  const heap = new MinHeap(1 << 15);
  time[src] = 0;
  heap.push(0, src);
  while (heap.size) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    const ur = Math.floor(u / W), uc = u - ur * W;
    for (let m = 0; m < 16; m++) {
      const v = movable(pg, ur, uc, m);
      if (v < 0 || done[v]) continue;
      const d = MOVE_LEN[m] * g.res;
      const k = gradeIndex((Math.atan2(pg.elev[v] - pg.elev[u], d) * 180) / Math.PI);
      const s = tb.speed[pg.terr[v]][k];
      if (!(s > 0)) continue;
      const nt = time[u] + d / s;
      if (nt < time[v]) {
        time[v] = nt;
        heap.push(nt, v);
      }
    }
  }
  return time;
}

/**
 * Held-Karp dynamic programming over subsets (Bellman 1962; Held & Karp 1962): for every set S of stations and every
 * last station j, the least travel time from the habitat through all of S ending at j. Orders that visit the same set
 * and end at the same station have the same future, so n! orders collapse into 2^n * n states. Closing each set back
 * to the habitat gives the best tour of EVERY subset at once - exactly what station selection needs.
 * T: (n+1) x (n+1) leg-time matrix, index 0 = habitat. Returns { travel: Float64Array(2^n), order(mask) }.
 */
export function heldKarpSubsets(T, n) {
  const size = 1 << n;
  const dp = new Float64Array(size * n).fill(Infinity);
  const par = new Int8Array(size * n).fill(-1);
  for (let j = 0; j < n; j++) dp[(1 << j) * n + j] = T[0][j + 1];
  for (let mask = 1; mask < size; mask++) {
    for (let j = 0; j < n; j++) {
      const c = dp[mask * n + j];
      if (!(c < Infinity) || !((mask >> j) & 1)) continue;
      const row = T[j + 1];
      for (let k = 0; k < n; k++) {
        if ((mask >> k) & 1) continue;
        const nm = mask | (1 << k), v = c + row[k + 1];
        if (v < dp[nm * n + k]) { dp[nm * n + k] = v; par[nm * n + k] = j; }
      }
    }
  }
  const travel = new Float64Array(size).fill(Infinity), last = new Int8Array(size).fill(-1);
  travel[0] = 0;
  for (let mask = 1; mask < size; mask++) {
    for (let j = 0; j < n; j++) {
      if (!((mask >> j) & 1)) continue;
      const v = dp[mask * n + j] + T[j + 1][0];
      if (v < travel[mask]) { travel[mask] = v; last[mask] = j; }
    }
  }
  const order = (mask) => {
    const out = [];
    let m = mask, j = last[mask];
    while (j >= 0 && m) { out.push(j); const p = par[m * n + j]; m ^= 1 << j; j = p; }
    return out.reverse();
  };
  return { travel, order };
}

export const EXACT_MAX_CANDIDATES = 15; // 2^15 x 15 states: a few ms in JavaScript

/**
 * Budget check shared by the exact enumeration and the QUBO selector: coarse O2 and battery use of a sortie with
 * travel and station-work seconds, against the budgets with a margin held back for the detailed plan.
 */
export function sortieLimits(planner, margin = 0.85) {
  const m = planner.m;
  const walkO2PerS = (o2KgPerH(m.profile.kind === "walk" ? 330 : MET.P_SEATED_W) + SUIT.leakKgPerH) / 3600; // [ASSUME] average
  const workO2PerS = (o2KgPerH(MET.P_WORK_W) + SUIT.leakKgPerH) / 3600;
  const battPerS = SUIT.baseW / 3600; // Wh per second; heater load is added by the detailed plan
  const budgetT = planner.timeEndS * margin, budgetO2 = planner.cap.o2 * margin, budgetBatt = planner.cap.batt * margin;
  return {
    budgetT, budgetO2, budgetBatt,
    // the tightest resource expressed as a time budget (battery is time-driven; O2 at the walking rate)
    effectiveT: Math.min(budgetT, budgetBatt / battPerS, budgetO2 / Math.max(walkO2PerS, workO2PerS)),
    // work O2 and battery come from each station's stated task when given (extra = { o2, batt } over the chosen set)
    use: (travel, work, extra = null) => ({ t: travel + work, o2: travel * walkO2PerS + (extra ? extra.o2 : work * workO2PerS),
      batt: (travel + work) * battPerS + (extra?.batt ?? 0) }),
    fits(travel, work, extra = null) { const u = this.use(travel, work, extra); return u.t <= budgetT && u.o2 <= budgetO2 && u.batt <= budgetBatt; },
    /** O2 and extra battery of one station's stated task */
    station(c) {
      const k = taskOf(c), s = (c.dwell_min || 0) * 60;
      return { o2: ((o2KgPerH(k.workW) + SUIT.leakKgPerH) * s) / 3600 + k.extraO2Kg, batt: k.toolWh };
    },
  };
}

/**
 * @param planner  Planner (for the time budget, capacities, base)
 * @param cands    [{ id, name, lon, lat, value, dwell_min }]
 * @returns ranked options [{ ids, value, timeS, o2Kg, legs: [...] }]
 */
export function optimiseSortie(planner, cands, { maxStops = 4, margin = 0.85 } = {}) {
  const m = planner.m, pg = m.coarse, g = pg.grid;
  const nodes = [{ id: "HAB", lon: planner.base.lon, lat: planner.base.lat, value: 0, dwell_min: 0 }, ...cands];
  const idx = nodes.map((p) => planner._nearestFree(pg, g.idxOfLonLat(p.lon, p.lat)));
  const fields = idx.map((i) => timeField(m, pg, i));
  const T = nodes.map((_, a) => nodes.map((__, b) => fields[a][idx[b]]));
  const lim = sortieLimits(planner, margin);
  const n = cands.length;
  if (n > EXACT_MAX_CANDIDATES) throw new Error(`optimiseSortie: ${n} candidates (exact limit ${EXACT_MAX_CANDIDATES}); use selectStationsQubo`);
  const hk = heldKarpSubsets(T, n);
  const st = cands.map((c) => lim.station(c));
  const options = [];
  for (let mask = 1; mask < 1 << n; mask++) {
    let k = 0, work = 0, value = 0;
    const extra = { o2: 0, batt: 0 };
    for (let j = 0; j < n; j++) if ((mask >> j) & 1) { k++; work += cands[j].dwell_min * 60; value += cands[j].value ?? 0.3; extra.o2 += st[j].o2; extra.batt += st[j].batt; }
    if (k > maxStops) continue;
    const travel = hk.travel[mask];
    if (!(travel < Infinity) || !lim.fits(travel, work, extra)) continue;
    const perm = hk.order(mask).map((j) => j + 1);
    options.push({ ids: perm.map((j) => nodes[j].id), stops: perm.map((j) => nodes[j]), value, timeS: travel + work, travelS: travel,
      o2Kg: lim.use(travel, work, extra).o2 });
  }
  options.sort((a, b) => b.value - a.value || a.timeS - b.timeS);
  const best = options.slice(0, 8); // one (optimal) order per set already
  const { budgetT, budgetO2 } = lim;
  return { options: best, matrix: T, nodes: nodes.map((n) => n.id), budgetT, budgetO2 };
}
