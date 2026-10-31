// planner.js - constrained, risk-aware, multi-criteria route planning on real terrain.
//
// Pipeline for one leg (research docs 22 and 25, "cheap rank, then expensive check"):
//   1. coarse search on a 40 m plan grid: labels carry (cost, time, consumables); a label is pruned the moment the
//      crew could no longer walk home from that cell with what is left (walkback field) or would miss sunset;
//   2. refine at 10 m inside a corridor around the coarse route;
//   3. any-angle smoothing (string pulling) that never crosses a veto and never raises the cost;
//   4. exact re-evaluation of the smoothed route in time (Sun, shadows, temperature, consumables, position error).
// Criteria are normalised by the fastest route so weights mean "relative importance of a relative change".

import { MinHeap } from "./heap.js";
import { MOVES, MOVE_LEN, movable, walkbackField } from "./fields.js";
import { distanceTransform, lineCells, ramp } from "./util.js";
import { VETO, VETO_NAMES, gradeIndex } from "./costmodel.js";
import { MET, SUIT, THERM, o2KgPerH, co2KgPerH, suitHeat } from "./physio.js";
import { stationWork } from "./task.js";
import { WHEEL_DAMAGE } from "./physio.js";
import { namedWeightSets } from "./ahp.js";
import { G_MARS, xyToLonLat } from "./geo.js";
import { evaDoseMSv, routeDoseMSv } from "./sitecheck.js";

const RES_KEYS = ["o2", "co2", "water", "batt", "rbatt"];
const zeroRes = () => ({ o2: 0, co2: 0, water: 0, batt: 0, rbatt: 0 });
const addRes = (a, b) => ({ o2: a.o2 + b.o2, co2: a.co2 + b.co2, water: a.water + b.water, batt: a.batt + b.batt,
  rbatt: a.rbatt + b.rbatt });

export class Planner {
  /**
   * @param model CostModel
   * @param base  { lon, lat } habitat / lander (walkback target)
   * @param opts  { departMs, evaMaxS, workMet }
   */
  constructor(model, base, opts = {}) {
    this.m = model;
    this.base = base;
    this.departMs = opts.departMs;
    this.evaMaxS = opts.evaMaxS ?? SUIT.maxEvaH * 3600;
    const cg = model.coarse.grid, fg = model.fine.grid;
    this.baseCoarse = this._nearestFree(model.coarse, cg.idxOfLonLat(base.lon, base.lat));
    this.baseFine = this._nearestFree(model.fine, fg.idxOfLonLat(base.lon, base.lat));
    this.rescue = !!opts.rescue;
    this.field = walkbackField(model, model.coarse, this.baseCoarse, { rescue: this.rescue });
    const sunset = model.env.nextSunset(this.departMs);
    this.sunsetMs = sunset;
    this.timeEndS = Math.min(this.evaMaxS, (sunset - this.departMs) / 1000 - model.s.sunsetReserveMin * 60);
    // a robotic scout carries no crew: no walkback, no suit consumables, no daylight limit on a single leg
    this.uncrewed = model.profile.id === "robot";
    if (this.uncrewed) this.timeEndS = 30 * 86400;
    this.cap = model.capacity();
    if (this.uncrewed) this.cap = { o2: Infinity, co2: Infinity, water: Infinity, batt: Infinity, rbatt: Infinity };
    this.Tref = Math.max(600, this.timeEndS / 2);
    this._heur();
  }

  _nearestFree(pg, idx) {
    if (idx < 0) throw new Error("point outside the mapped area");
    if (!pg.veto[idx]) return idx;
    const g = pg.grid, [r0, c0] = g.rc(idx);
    for (let rad = 1; rad < 50; rad++) {
      for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
        const r = r0 + dr, c = c0 + dc;
        if (g.inside(r, c) && !pg.veto[g.idx(r, c)]) return g.idx(r, c);
      }
    }
    throw new Error("no traversable cell near point");
  }

  _heur() {
    // lower bounds per metre for the A* heuristic: best speed and least consumables per metre
    const tb = this.m.tables;
    let vmax = 0, cmin = Infinity;
    for (let t = 0; t < 3; t++) for (let k = 0; k < tb.N; k++) {
      const v = tb.speed[t][k];
      if (v > vmax) vmax = v;
      if (v > 0) {
        const met = this.m.profile.kind === "walk" ? tb.power[t][k] : MET.P_SEATED_W;
        const perS = (o2KgPerH(met) / SUIT.o2Kg + co2KgPerH(met) / SUIT.co2CapKg) / 3600 + SUIT.baseW / 3600 / SUIT.batteryWh;
        cmin = Math.min(cmin, perS / v);
      }
    }
    this.vmax = vmax;
    this.cminPerM = cmin;
  }

  // ------------------------------------------------------------------------------------------ label search --
  /**
   * Search one leg on plan grid pg. Returns { cells: [...], ok } or { ok:false, reason }.
   * state0 = { t (elapsed s), res }.
   */
  search(pg, s, goal, W, refs, state0, { corridor = null, penalty = null, maxLabels = 4, retLookup } = {}) {
    const g = pg.grid, Wd = g.width, m = this.m, cap = this.cap;
    const res0 = pg.grid.res;
    const [gr, gc] = g.rc(goal);
    // recoverability (walk-home time, radio line of sight to the habitat mast, position error) protects a crew; an
    // uncrewed scout relays through orbiters and has no one to walk home, so it is not weighted for the robotic profile
    const wT = (W.T || 0) / refs.T, wS = (W.S || 0) / refs.S, wC = (W.C || 0) / refs.C, wR = this.uncrewed ? 0 : (W.R || 0) / refs.R,
      wV = (W.V || 0) / refs.V;
    const hPerM = wT / this.vmax + wC * this.cminPerM;
    const heur = (i) => {
      const r = Math.floor(i / Wd), c = i - r * Wd;
      return Math.hypot(r - gr, c - gc) * res0 * hPerM;
    };
    // label pool
    let cap0 = 1 << 15;
    let L = { node: new Int32Array(cap0), prev: new Int32Array(cap0), cost: new Float64Array(cap0),
      t: new Float64Array(cap0), o2: new Float32Array(cap0), co2: new Float32Array(cap0), water: new Float32Array(cap0),
      batt: new Float32Array(cap0), rbatt: new Float32Array(cap0) };
    let nL = 0;
    const grow = () => {
      cap0 *= 2;
      for (const k of Object.keys(L)) {
        const a = new L[k].constructor(cap0);
        a.set(L[k]);
        L[k] = a;
      }
    };
    const count = new Uint8Array(pg.n);
    const bestRf = new Float32Array(pg.n).fill(Infinity);
    const heap = new MinHeap(1 << 15);
    const newLabel = (node, prev, cost, t, r) => {
      if (nL >= cap0) grow();
      L.node[nL] = node; L.prev[nL] = prev; L.cost[nL] = cost; L.t[nL] = t;
      L.o2[nL] = r.o2; L.co2[nL] = r.co2; L.water[nL] = r.water; L.batt[nL] = r.batt; L.rbatt[nL] = r.rbatt;
      return nL++;
    };
    const ret = retLookup;
    const rf = (li) => Math.max(L.o2[li] / cap.o2, L.co2[li] / cap.co2, L.water[li] / cap.water, L.batt[li] / cap.batt,
      L.t[li] / this.timeEndS);
    const l0 = newLabel(s, -1, 0, state0.t, state0.res);
    heap.push(heur(s), l0);
    let pops = 0, pruned = 0;
    const walkOnly = false;
    while (heap.size) {
      const li = heap.pop();
      const u = L.node[li];
      const r = rf(li);
      if (count[u] >= maxLabels || r > bestRf[u] - 0.01) continue;
      count[u]++;
      bestRf[u] = r;
      pops++;
      if (u === goal) {
        const cells = [];
        for (let k = li; k >= 0; k = L.prev[k]) cells.push(L.node[k]);
        cells.reverse();
        return { ok: true, cells, cost: L.cost[li], t: L.t[li], pops, pruned,
          res: { o2: L.o2[li], co2: L.co2[li], water: L.water[li], batt: L.batt[li], rbatt: L.rbatt[li] } };
      }
      const ur = Math.floor(u / Wd), uc = u - ur * Wd;
      const ms = this.departMs + L.t[li] * 1000;
      for (let mv = 0; mv < 16; mv++) {
        const v = movable(pg, ur, uc, mv, corridor);
        if (v < 0) continue;
        const d = MOVE_LEN[mv] * res0;
        const e = m.edge(pg, u, v, d, ms, walkOnly);
        if (!e) continue;
        const t = L.t[li] + e.t;
        const rr = { o2: L.o2[li] + e.res.o2, co2: L.co2[li] + e.res.co2, water: L.water[li] + e.res.water,
          batt: L.batt[li] + e.res.batt, rbatt: L.rbatt[li] + e.res.rbatt };
        // --- constraints: can still walk home from v with what is left, before the time limit ---
        const back = ret(v);
        if (!back || t + back.time > this.timeEndS || rr.o2 + back.o2 > cap.o2 || rr.co2 + back.co2 > cap.co2 ||
          rr.water + back.water > cap.water || rr.batt + back.batt > cap.batt || rr.rbatt > cap.rbatt) {
          pruned++;
          continue;
        }
        const rec = 0.5 * Math.min(1.5, back.time / this.Tref) + 0.25 * (1 - pg.los[v]) + 0.25 * ramp(pg.sigma[v], 10, 60);
        const dC = m.consFrac(e.res);
        let c = L.cost[li] + wT * e.t + wS * d * e.haz + wC * dC + wR * d * rec + wV * d * (1 - pg.sci[v]);
        if (penalty && penalty[v]) c += penalty[v] * d * (wT / this.vmax + wS * 0.5);
        const nl = newLabel(v, li, c, t, rr);
        heap.push(c + heur(v), nl);
      }
    }
    return { ok: false, pops, pruned, reason: pruned > 0 ? "consumables / walkback / daylight limit" : "no traversable path" };
  }

  /** Return-field lookup for a cell of plan grid pg (coarse field mapped to any grid). */
  _retLookup(pg) {
    if (this.uncrewed) {
      const zero = { time: 0, o2: 0, co2: 0, water: 0, batt: 0 };
      return () => zero;
    }
    const f = this.field, cg = f.pg.grid;
    if (pg === f.pg) return (v) => (Number.isFinite(f.time[v]) ? { time: f.time[v], o2: f.o2[v], co2: f.co2[v],
      water: f.water[v], batt: f.batt[v] } : null);
    const g = pg.grid, ratio = cg.res / g.res, W = g.width;
    return (v) => {
      const r = Math.floor(v / W), c = v - r * W;
      const R = Math.min(cg.height - 1, Math.floor(r / ratio)), C = Math.min(cg.width - 1, Math.floor(c / ratio));
      let j = R * cg.width + C;
      if (!Number.isFinite(f.time[j])) {
        // coarse cell vetoed: take the best finite neighbour (the fine cell itself is open)
        let best = -1;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          const RR = R + dr, CC = C + dc;
          if (RR < 0 || CC < 0 || RR >= cg.height || CC >= cg.width) continue;
          const k = RR * cg.width + CC;
          if (Number.isFinite(f.time[k]) && (best < 0 || f.time[k] < f.time[best])) best = k;
        }
        if (best < 0) return null;
        j = best;
      }
      return { time: f.time[j] + 30, o2: f.o2[j], co2: f.co2[j], water: f.water[j], batt: f.batt[j] };
    };
  }

  // --------------------------------------------------------------------------------------------- one leg ----
  planLeg(from, to, W, refs, state0, { penaltyFine = null, corridorM = 300 } = {}) {
    const m = this.m, cpg = m.coarse, fpg = m.fine, cg = cpg.grid, fg = fpg.grid;
    const sC = this._nearestFree(cpg, cg.idxOfLonLat(from.lon, from.lat));
    const gC = this._nearestFree(cpg, cg.idxOfLonLat(to.lon, to.lat));
    let penC = null;
    if (penaltyFine) {
      penC = new Float32Array(cpg.n);
      for (let i = 0; i < fpg.n; i++) if (penaltyFine[i]) {
        const [r, c] = fg.rc(i);
        const j = Math.floor(r / cpg.factor) * cg.width + Math.floor(c / cpg.factor);
        if (j < cpg.n) penC[j] = Math.max(penC[j], penaltyFine[i]);
      }
    }
    const coarse = this.search(cpg, sC, gC, W, refs, state0, { retLookup: this._retLookup(cpg), penalty: penC });
    if (!coarse.ok) return { ok: false, reason: coarse.reason, stage: "coarse" };
    // corridor on the fine grid around the coarse route
    const mask = new Uint8Array(fpg.n);
    const f = cpg.factor;
    for (let k = 0; k + 1 < coarse.cells.length; k++) {
      const [r0, c0] = cg.rc(coarse.cells[k]), [r1, c1] = cg.rc(coarse.cells[k + 1]);
      const pts = lineCells(r0 * f + f / 2, c0 * f + f / 2, r1 * f + f / 2, c1 * f + f / 2);
      for (let q = 0; q < pts.length; q += 2) {
        const i = fg.idx(Math.min(fg.height - 1, pts[q]), Math.min(fg.width - 1, pts[q + 1]));
        mask[i] = 1;
      }
    }
    const dist = distanceTransform(mask, fg.width, fg.height, fg.res);
    const blocked = new Uint8Array(fpg.n);
    for (let i = 0; i < fpg.n; i++) blocked[i] = dist[i] > corridorM ? 1 : 0;
    const sF = this._nearestFree(fpg, fg.idxOfLonLat(from.lon, from.lat));
    const gF = this._nearestFree(fpg, fg.idxOfLonLat(to.lon, to.lat));
    blocked[sF] = 0;
    blocked[gF] = 0;
    const fine = this.search(fpg, sF, gF, W, refs, state0, { corridor: blocked, penalty: penaltyFine,
      retLookup: this._retLookup(fpg), maxLabels: 3 });
    if (!fine.ok) return { ok: false, reason: fine.reason, stage: "fine", coarse };
    const smooth = this.smooth(fpg, fine.cells, blocked, W, refs, state0);
    return { ok: true, cells: smooth, rawCells: fine.cells, coarseCells: coarse.cells, pops: coarse.pops + fine.pops };
  }

  /** Any-angle string pulling on the fine grid: shortcut i->j when the straight segment is veto-free and not costlier. */
  smooth(pg, cells, blocked, W, refs, state0) {
    const g = pg.grid;
    if (cells.length < 3) return cells;
    const segCost = (a, b) => {
      const [r0, c0] = g.rc(a), [r1, c1] = g.rc(b);
      const pts = lineCells(r0, c0, r1, c1);
      let cost = 0;
      for (let q = 0; q + 2 < pts.length; q += 2) {
        const u = g.idx(pts[q], pts[q + 1]), v = g.idx(pts[q + 2], pts[q + 3]);
        if (pg.veto[v] || blocked[v]) return Infinity;
        const d = Math.hypot(pts[q + 2] - pts[q], pts[q + 3] - pts[q + 1]) * g.res;
        const e = this.m.edge(pg, u, v, d, this.departMs + state0.t * 1000, false);
        if (!e) return Infinity;
        cost += (W.T || 0) / refs.T * e.t + (W.S || 0) / refs.S * d * e.haz + (W.C || 0) / refs.C * this.m.consFrac(e.res);
      }
      return cost;
    };
    // prefix sums of the grid path's cost so pathCost(i, j) is O(1)
    const cum = new Float64Array(cells.length);
    for (let k = 1; k < cells.length; k++) cum[k] = cum[k - 1] + segCost(cells[k - 1], cells[k]);
    const pathCost = (i, j) => cum[j] - cum[i];
    const out = [cells[0]];
    let i = 0;
    while (i < cells.length - 1) {
      let best = i + 1;
      for (let j = Math.min(cells.length - 1, i + 40); j > i + 1; j--) {
        const direct = segCost(cells[i], cells[j]);
        if (direct <= pathCost(i, j) * 1.0001) {
          best = j;
          break;
        }
      }
      // expand the chosen segment into its cells so downstream evaluation stays on the grid
      const [r0, c0] = g.rc(cells[i]), [r1, c1] = g.rc(cells[best]);
      const pts = lineCells(r0, c0, r1, c1);
      for (let q = 2; q < pts.length; q += 2) out.push(g.idx(pts[q], pts[q + 1]));
      i = best;
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------ evaluation ----
  /**
   * Exact time-stepped evaluation of a route given as fine-grid cells, from state0, with station work at the end.
   * Produces the timeline the UI draws and the criteria totals.
   */
  evaluate(cells, state0, { workS = 0, label = "", stop = null } = {}) {
    const m = this.m, pg = m.fine, g = pg.grid, env = m.env;
    const ret = this._retLookup(pg);
    let t = state0.t, res = { ...state0.res }, dist = 0;
    const X = { T: 0, S: 0, C: 0, R: 0, V: 0 };
    const pts = [];
    let sigma = state0.sigma ?? m.s.posModel.sigmaFixM, sinceFix = 0;
    const lmk = m.T.f32("landmark");
    let maxSlope = 0, minMargin = Infinity, minMarginAt = null, nShade = 0, nLos = 0, maxHaz = 0;
    // data-quality flags met along the route: repaired DEM seam (keepout bit 8) and cells without 1 m data
    const keep = m.T.raw.keepout, conf = m.T.f32("conf");
    let seamCells = 0, lowConfM = 0;
    // ground met along the route: rocky / sandy distance, and wheel life a vehicle uses on it (Curiosity wear rates)
    const stepA = m.T.f32("step"), vehicle = m.profile.kind === "vehicle";
    let rockyM = 0, sandM = 0, wheelLife = 0;
    const cap = this.cap;
    const push = (i, e, d) => {
      const [x, y] = g.cellXY(...g.rc(i));
      const [lon, lat] = xyToLonLat(x, y);
      const back = ret(i) || { time: Infinity, o2: Infinity, co2: Infinity, water: Infinity, batt: Infinity };
      const margins = {
        time: this.timeEndS - (t + back.time),
        o2: 1 - (res.o2 + back.o2) / cap.o2, co2: 1 - (res.co2 + back.co2) / cap.co2,
        water: 1 - (res.water + back.water) / cap.water, batt: 1 - (res.batt + back.batt) / cap.batt,
      };
      const worst = Math.min(margins.time / this.timeEndS, margins.o2, margins.co2, margins.water, margins.batt);
      if (worst < minMargin) { minMargin = worst; minMarginAt = pts.length; }
      pts.push({ i, lon, lat, x, y, elev: pg.elev[i], t, dist, grade: e ? e.grade : 0, haz: e ? e.haz : pg.haz[i],
        shade: e ? e.shade : 0, sunEl: e ? e.sunEl : env.sun(this.departMs + t * 1000).elevation, sigma, los: pg.los[i],
        res: { ...res }, back: back.time, margins, veto: pg.veto[i], terr: pg.terr[i] });
    };
    push(cells[0], null, 0);
    for (let k = 0; k + 1 < cells.length; k++) {
      const u = cells[k], v = cells[k + 1];
      const [r0, c0] = g.rc(u), [r1, c1] = g.rc(v);
      const d = Math.hypot(r1 - r0, c1 - c0) * g.res;
      const e = m.edge(pg, u, v, d, this.departMs + t * 1000, false);
      if (!e) return { ok: false, reason: `impassable edge at step ${k}` };
      t += e.t;
      dist += d;
      res = addRes(res, e.res);
      // position error: dead reckoning drift; re-fix at a landmark within 150 m or by base-beacon ranging in line of sight
      sinceFix += d;
      sigma = m.s.posModel.sigmaFixM + m.s.posModel.driftFrac * sinceFix;
      if ((lmk[v] <= 150 && sinceFix > 100) || (m.s.posModel.beaconLOS && pg.los[v] && sigma > 15)) {
        if (lmk[v] <= 150 || pg.los[v]) { sigma = m.s.posModel.sigmaFixM + (lmk[v] <= 150 ? 0 : 5); sinceFix = 0; }
      }
      const back = ret(v);
      const rec = 0.5 * Math.min(1.5, (back ? back.time : this.Tref) / this.Tref) + 0.25 * (1 - pg.los[v]) +
        0.25 * ramp(sigma, 10, 60);
      X.T += e.t; X.S += d * e.haz; X.C += m.consFrac(e.res); X.R += d * rec; X.V += d * (1 - pg.sci[v]);
      if (keep[v] & 8) seamCells++;
      if (pg.terr[v] === 2) rockyM += d;
      else if (pg.terr[v] === 1) sandM += d;
      if (vehicle) wheelLife += (d / 1000 / (m.profile.wheelLifeKm || 500)) * (pg.terr[v] === 1 ? WHEEL_DAMAGE.sand : stepA[v] > 0.4 ? WHEEL_DAMAGE.veryRocky : pg.terr[v] === 2 ? WHEEL_DAMAGE.rocky : WHEEL_DAMAGE.firm);
      if (conf[v] < 0.5) lowConfM += d;
      maxSlope = Math.max(maxSlope, Math.abs(e.grade));
      maxHaz = Math.max(maxHaz, e.haz);
      nShade += e.shade; nLos += pg.los[v];
      push(v, e, d);
    }
    if (workS > 0) {
      const ms = this.departMs + t * 1000;
      const i = cells[cells.length - 1];
      const shade = env.shadedHz(pg.hzIdx[i], ms) ? 1 : 0;
      // the crew's stated task at this station: work time, intensity, tool energy and extra consumables (task.js)
      const w = stationWork(stop, workS, m.s.cal, env, ms, shade, this.m.profile.kind === "vehicle" ? this.m.profile.auxW : 0);
      res = addRes(res, { o2: w.o2, co2: w.co2, water: w.water, batt: w.batt, rbatt: w.rbatt });
      t += workS;
      push(i, null, 0);
      pts[pts.length - 1].work = workS;
    }
    return { ok: true, label, pts, t, res, dist, X, sigma, maxSlope, maxHaz, minMargin, minMarginAt,
      shadeFrac: nShade / Math.max(1, cells.length - 1), losFrac: nLos / Math.max(1, cells.length - 1), seamCells, lowConfM, rockyM, sandM, wheelLife };
  }

  // ------------------------------------------------------------------------------------------------ sortie --
  /**
   * Plan a whole EVA: base -> stops... -> base, carrying time and consumables across legs.
   * stops = [{ lon, lat, name, dwell_min }]
   */
  planSortie(stops, W, refs, { penaltyFine = null, start = null, state0 = null, end = "base" } = {}) {
    // start/state0: re-plan the rest of an EVA from where the crew is now, with what they have used (closed loop), or
    //   begin the sortie at a chosen point (e.g. a rover drop-off at a station) instead of the habitat.
    // end: "base" (return to the habitat, the default), "last" (finish at the last station: a one-way traverse, e.g.
    //   rover pick-up), or a point { lon, lat, name }. The walk-home guarantee to the habitat applies in every case.
    const home = { ...this.base, name: "Habitat", dwell_min: 0, isBase: true };
    const first = start ? { ...start, name: start.name || "Current position", dwell_min: 0, isStart: true } : home;
    const tail = end == null || end === "base" ? [home] : end === "last" ? [] : [{ ...end, name: end.name || "End point", dwell_min: 0, isEnd: true }];
    const seq = [first, ...stops, ...tail];
    if (seq.length < 2) return { ok: false, reason: "nothing to plan: add a station, or return to the habitat", legs: [] };
    let state = state0 ? { t: state0.t, res: { ...zeroRes(), ...state0.res }, sigma: state0.sigma ?? this.m.s.posModel.sigmaFixM }
      : { t: 0, res: zeroRes(), sigma: this.m.s.posModel.sigmaFixM };
    const legs = [];
    const X = { T: 0, S: 0, C: 0, R: 0, V: 0 };
    for (let k = 0; k + 1 < seq.length; k++) {
      const leg = this.planLeg(seq[k], seq[k + 1], W, refs, state, { penaltyFine });
      if (!leg.ok) return { ok: false, failedLeg: k, from: seq[k].name, to: seq[k + 1].name, reason: leg.reason, legs };
      const ev = this.evaluate(leg.cells, state, { workS: (seq[k + 1].dwell_min || 0) * 60, label: `${seq[k].name} -> ${seq[k + 1].name}`, stop: seq[k + 1] });
      if (!ev.ok) return { ok: false, failedLeg: k, reason: ev.reason, legs };
      // distance along the whole sortie (per-leg differences, used by guidance, are unchanged)
      const off = legs.reduce((a, l) => a + l.ev.dist, 0);
      if (off) for (const p of ev.pts) p.dist += off;
      legs.push({ from: seq[k], to: seq[k + 1], cells: leg.cells, coarseCells: leg.coarseCells, ev });
      for (const key of Object.keys(X)) X[key] += ev.X[key];
      state = { t: ev.t, res: ev.res, sigma: ev.sigma };
    }
    const all = legs.flatMap((l) => l.ev.pts);
    const minMargin = Math.min(...legs.map((l) => l.ev.minMargin));
    const endOK = state.t <= this.timeEndS + 1 && RES_KEYS.every((k) => state.res[k] <= this.cap[k] + 1e-9);
    return {
      ok: true, feasible: endOK && minMargin >= -1e-6, legs, pts: all, X, t: state.t, res: state.res,
      startAt: start ? { lon: first.lon, lat: first.lat, name: first.name } : "base",
      endAt: end == null || end === "base" ? "base" : end === "last" ? "last" : { lon: end.lon, lat: end.lat, name: end.name },
      sequence: seq.map((p) => p.name),
      dist: legs.reduce((a, l) => a + l.ev.dist, 0), minMargin,
      maxSlope: Math.max(...legs.map((l) => l.ev.maxSlope)), maxHaz: Math.max(...legs.map((l) => l.ev.maxHaz)),
      shadeFrac: legs.reduce((a, l) => a + l.ev.shadeFrac * l.ev.dist, 0) / Math.max(1, legs.reduce((a, l) => a + l.ev.dist, 0)),
      losFrac: legs.reduce((a, l) => a + l.ev.losFrac * l.ev.dist, 0) / Math.max(1, legs.reduce((a, l) => a + l.ev.dist, 0)),
      sunsetMs: this.sunsetMs, timeEndS: this.timeEndS,
      doseMSv: routeDoseMSv(all) ?? evaDoseMSv(state.t),
      seamCells: legs.reduce((a, l) => a + (l.ev.seamCells || 0), 0),
      // rocky ground: slower, costlier and riskier for boots and wheels alike; wheels also wear (share of life used)
      rockyFrac: legs.reduce((a, l) => a + (l.ev.rockyM || 0), 0) / Math.max(1, legs.reduce((a, l) => a + l.ev.dist, 0)),
      sandFrac: legs.reduce((a, l) => a + (l.ev.sandM || 0), 0) / Math.max(1, legs.reduce((a, l) => a + l.ev.dist, 0)),
      wheelLife: this.m.profile.kind === "vehicle" ? legs.reduce((a, l) => a + (l.ev.wheelLife || 0), 0) : null,
      wheelLeft: this.m.profile.kind === "vehicle" ? 1 - (this.m.s.hw.wheelWear || 0) - legs.reduce((a, l) => a + (l.ev.wheelLife || 0), 0) : null,
      lowConfFrac: legs.reduce((a, l) => a + (l.ev.lowConfM || 0), 0) / Math.max(1, legs.reduce((a, l) => a + l.ev.dist, 0)),
    };
  }

  /**
   * Why a plan is infeasible, and where: plan the fastest sortie with the crew limits switched off, then re-evaluate it
   * with the real limits and find the point of no return (the last point from which the crew can still walk home with
   * what is left) and the limiting resource. Returns { ok, pts, pnrIndex, limiting, pnrDistM, totalDistM }.
   */
  diagnose(stops, opts = {}) {
    const keep = { cap: this.cap, timeEndS: this.timeEndS, uncrewed: this.uncrewed };
    let so;
    try {
      this.cap = { o2: Infinity, co2: Infinity, water: Infinity, batt: Infinity, rbatt: Infinity };
      this.timeEndS = 30 * 86400;
      this.uncrewed = true; // walkback lookups return zero while searching
      so = this.planSortie(stops, { T: 1 }, { T: 1, S: 1, C: 1, R: 1, V: 1 }, { start: opts.start ?? null, end: opts.end ?? "base" });
    } finally {
      Object.assign(this, keep);
    }
    if (!so.ok) return { ok: false, reason: "no traversable path even without crew limits" };
    let state = { t: 0, res: zeroRes(), sigma: this.m.s.posModel.sigmaFixM };
    const pts = [];
    let off = 0;
    for (const leg of so.legs) {
      const ev = this.evaluate(leg.cells, state, { workS: (leg.to.dwell_min || 0) * 60, stop: leg.to });
      if (!ev.ok) return { ok: false, reason: ev.reason };
      for (const p of ev.pts) p.dist += off;
      off += ev.dist;
      pts.push(...ev.pts);
      state = { t: ev.t, res: ev.res, sigma: ev.sigma };
    }
    const KEYS = ["o2", "co2", "water", "batt"];
    const worst = (p) => Math.min(p.margins.time / this.timeEndS, ...KEYS.map((k) => p.margins[k]));
    const bad = pts.findIndex((p) => worst(p) < 0);
    if (bad < 0) return { ok: true, pts, pnrIndex: -1, limiting: null, totalDistM: pts[pts.length - 1].dist };
    const p = pts[bad];
    const limiting = p.margins.time / this.timeEndS <= Math.min(...KEYS.map((k) => p.margins[k])) ? "time"
      : KEYS.reduce((a, k) => (p.margins[k] < p.margins[a] ? k : a), "o2");
    const pnrIndex = Math.max(0, bad - 1);
    return { ok: true, pts, pnrIndex, limiting, pnrDistM: pts[pnrIndex].dist, totalDistM: pts[pts.length - 1].dist };
  }

  /** The four named routes plus a fallback that avoids the balanced route's corridor. */
  namedSorties(stops, { withFallback = true, balanced = null, start = null, end = "base" } = {}) {
    const ro = { start, end };
    const sets = namedWeightSets();
    if (balanced) sets.balanced = balanced;
    const unit = { T: 1, S: 1, C: 1, R: 1, V: 1 };
    const fastest = this.planSortie(stops, sets.fastest, unit, ro);
    if (!fastest.ok) return { ok: false, fastest };
    const refs = {};
    for (const k of Object.keys(unit)) refs[k] = Math.max(fastest.X[k], k === "T" ? 60 : 1e-3);
    // floors so a near-zero criterion on the fastest route cannot explode its weight
    refs.S = Math.max(refs.S, 0.02 * fastest.dist);
    refs.R = Math.max(refs.R, 0.02 * fastest.dist);
    refs.V = Math.max(refs.V, 0.02 * fastest.dist);
    const out = { ok: true, refs, routes: { fastest } };
    for (const name of ["balanced", "safest", "economy"]) out.routes[name] = this.planSortie(stops, sets[name], refs, ro);
    if (withFallback && out.routes.balanced.ok) {
      const pen = new Float32Array(this.m.fine.n);
      const g = this.m.fine.grid;
      const mask = new Uint8Array(g.n);
      for (const leg of out.routes.balanced.legs) for (const i of leg.cells) mask[i] = 1;
      const d = distanceTransform(mask, g.width, g.height, g.res);
      for (let i = 0; i < g.n; i++) if (d[i] < 60) pen[i] = 3;
      // keep the habitat and stations reachable: no penalty within 80 m of any stop or the base
      for (const p of [this.base, ...stops, ...(start ? [start] : []), ...(end && typeof end === "object" ? [end] : [])]) {
        const [r0, c0] = g.rcOfLonLat(p.lon, p.lat);
        for (let dr = -8; dr <= 8; dr++) for (let dc = -8; dc <= 8; dc++) {
          const r = Math.round(r0) + dr, c = Math.round(c0) + dc;
          if (g.inside(r, c)) pen[g.idx(r, c)] = 0;
        }
      }
      const fb = this.planSortie(stops, sets.balanced, refs, { penaltyFine: pen, ...ro });
      if (fb.ok) {
        let shared = 0, tot = 0;
        for (const leg of fb.legs) for (const i of leg.cells) { tot++; if (d[i] < 30) shared++; }
        fb.overlap = tot ? shared / tot : 1;
      }
      out.routes.fallback = fb;
    }
    // every route remembers the weights and reference scales it was scored with (re-plans reuse them)
    for (const [name, r] of Object.entries(out.routes)) if (r) { r.refs = refs; r.W = name === "fallback" ? sets.balanced : sets[name]; }
    return out;
  }
}

export { VETO_NAMES, VETO };
