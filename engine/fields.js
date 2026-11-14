// fields.js - one-to-all fields computed from the base: the walkback map, the consumables-aware range, and radio
// line of sight. These are the Mars version of Earth routing's "distance to destination" field (research doc 22):
// one backward search gives the return time and return consumables from every cell at once.

import { MinHeap } from "./heap.js";
import { R_MARS, G_MARS } from "./geo.js";
import { gradeIndex, VETO } from "./costmodel.js";
import { MET, SUIT, THERM, o2KgPerH, co2KgPerH, suitHeat } from "./physio.js";

// 16-connected moves: 8 neighbours + 8 knight moves (reduces grid direction bias; research doc 22)
export const MOVES = [
  [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1],
  [-1, -2], [-1, 2], [1, -2], [1, 2], [-2, -1], [-2, 1], [2, -1], [2, 1],
];
export const MOVE_LEN = MOVES.map(([a, b]) => Math.hypot(a, b));

/** Can we move from (r, c) by MOVES[m] on this plan grid? (target and squeezed-through cells not vetoed) */
export function movable(pg, r, c, m, extraVeto = null) {
  const g = pg.grid;
  const [dr, dc] = MOVES[m];
  const r2 = r + dr, c2 = c + dc;
  if (r2 < 0 || c2 < 0 || r2 >= g.height || c2 >= g.width) return -1;
  const v = r2 * g.width + c2;
  if (pg.veto[v] || (extraVeto && extraVeto[v])) return -1;
  const W = g.width;
  if (Math.abs(dr) + Math.abs(dc) === 2 && Math.abs(dr) === 1) {
    // diagonal: forbid squeezing between two vetoed corners
    if (pg.veto[r * W + c2] && pg.veto[r2 * W + c]) return -1;
  } else if (Math.abs(dr) + Math.abs(dc) === 3) {
    const mr = Math.abs(dr) === 2 ? r + Math.sign(dr) : r;
    const mc = Math.abs(dc) === 2 ? c + Math.sign(dc) : c;
    const a = mr * W + mc;
    const b = (Math.abs(dr) === 2 ? mr : r2) * W + (Math.abs(dc) === 2 ? mc : c2);
    if (pg.veto[a] || pg.veto[b]) return -1;
  }
  return v;
}

/**
 * Walkback field: time (s) and consumables to walk back to `base` from every cell, on foot, along the fastest
 * return path (the NASA walkback rule: on a rover sortie the crew must be able to walk home if the rover fails).
 * Return consumables are evaluated for a conservative environment: water with the Sun at full strength, battery
 * with cold shade, both at once, so the bound is on the safe side.
 */
export function walkbackField(model, pg, baseIdx, opts = {}) {
  const g = pg.grid, n = pg.n, W = g.width;
  // rescue mode (dual-rover operations): a second rover drives out and brings the crew home; the crew waits seated.
  // The "return" then costs twice the one-way drive time in suit time, at seated metabolic rate.
  const rescue = !!opts.rescue && model.profile.kind === "vehicle";
  const cal = model.s.cal || { met: 1, speed: 1, water: 1, batt: 1, leakKgPerH: 0 };
  const tb = rescue ? model.tables : model.walkTables;
  const kFactor = rescue ? 2 : 1;
  const Thot = opts.Thot ?? 250, Tcold = opts.Tcold ?? 185, sunW = opts.sunW ?? 550;
  const time = new Float32Array(n).fill(Infinity);
  const o2 = new Float32Array(n), co2 = new Float32Array(n), water = new Float32Array(n), batt = new Float32Array(n);
  const next = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heap = new MinHeap(1 << 16);
  time[baseIdx] = 0;
  heap.push(0, baseIdx);
  // per (terrain, grade) return burn rates
  while (heap.size) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    const ur = Math.floor(u / W), uc = u - ur * W;
    for (let m = 0; m < 16; m++) {
      // edge w -> u where w = u - move; check movability from w
      const [dr, dc] = MOVES[m];
      const wr = ur - dr, wc = uc - dc;
      if (wr < 0 || wc < 0 || wr >= g.height || wc >= W) continue;
      const w = wr * W + wc;
      if (done[w] || pg.veto[w]) continue;
      if (movable(pg, wr, wc, m) !== u) continue;
      const d = MOVE_LEN[m] * g.res;
      const dz = pg.elev[u] - pg.elev[w];
      const k = gradeIndex((Math.atan2(dz, d) * 180) / Math.PI);
      const cls = pg.terr[u];
      const spd = tb.speed[cls][k] * (rescue ? 1 : cal.speed);
      if (!(spd > 0)) continue;
      const t = (d / spd) * kFactor;
      const nt = time[u] + t;
      if (nt < time[w]) {
        time[w] = nt;
        next[w] = u;
        const met = rescue ? MET.P_SEATED_W : tb.power[cls][k] * cal.met;
        const mech = !rescue && dz > 0 ? Math.min(((MET.BODY_KG + MET.SUIT_KG) * G_MARS * dz) / t, met * MET.MUSCLE_EFF) : 0;
        const hot = suitHeat(met, mech, Thot, sunW), cold = suitHeat(met, mech, Tcold, 0);
        o2[w] = o2[u] + ((o2KgPerH(met) + SUIT.leakKgPerH + cal.leakKgPerH) * t) / 3600;
        co2[w] = co2[u] + (co2KgPerH(met) * t * (cal.co2 ?? 1)) / 3600;
        water[w] = water[u] + (hot.reject * t * cal.water) / (THERM.LATENT_J_PER_KG * THERM.EVAP_EFFICIENCY);
        batt[w] = batt[u] + ((SUIT.baseW + cold.heat) * t * cal.batt) / 3600;
        heap.push(nt, w);
      }
    }
  }
  return { pg, baseIdx, time, o2, co2, water, batt, next };
}

/** Follow the walkback tree from cell i to the base (returns cell indices). */
export function walkbackPath(field, i) {
  const out = [];
  let k = i, guard = 0;
  while (k >= 0 && guard++ < 1e6) {
    out.push(k);
    if (k === field.baseIdx) break;
    k = field.next[k];
  }
  return out;
}

/**
 * Consumables-aware range from the base: a cell is in range if walking there and back (the return field doubled,
 * walking being close to symmetric), plus `workS` of station work, fits every consumable and the time budget.
 * Returns Uint8Array: 0 out of range, 1 in range, 2 in range with < 20 % margin.
 */
export function rangeMask(model, field, budget) {
  const n = field.time.length;
  const cap = model.capacity();
  const out = new Uint8Array(n);
  const work = budget.workS ?? 0;
  const workMet = MET.P_WORK_W;
  const wO2 = ((o2KgPerH(workMet) + SUIT.leakKgPerH) * work) / 3600;
  const wCO2 = (co2KgPerH(workMet) * work) / 3600;
  for (let i = 0; i < n; i++) {
    const t = field.time[i];
    if (!Number.isFinite(t)) continue;
    const fr = Math.max(
      (2 * t + work) / budget.timeS,
      (2 * field.o2[i] + wO2) / cap.o2,
      (2 * field.co2[i] + wCO2) / cap.co2,
      (2 * field.water[i]) / cap.water,
      (2 * field.batt[i] + (SUIT.baseW * work) / 3600) / cap.batt,
    );
    out[i] = fr <= 0.8 ? 1 : fr <= 1 ? 2 : 0;
  }
  return out;
}

/**
 * Radio line of sight from a mast at `baseIdx` (mast height hMast) to a receiver hRx above every cell, with Mars
 * curvature. Marks pg.los and returns it.
 */
export function viewshed(pg, baseIdx, hMast = 10, hRx = 1.8) {
  const g = pg.grid, W = g.width, H = g.height;
  const los = new Uint8Array(pg.n);
  const br = Math.floor(baseIdx / W), bc = baseIdx - br * W;
  const z0 = pg.elev[baseIdx] + hMast;
  const res = g.res;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const dr = r - br, dc = c - bc;
      const L = Math.hypot(dr, dc);
      const i = r * W + c;
      if (L < 1.5) { los[i] = 1; continue; }
      const dist = L * res;
      const zt = pg.elev[i] + hRx - (dist * dist) / (2 * R_MARS);
      const steps = Math.ceil(L * 1.5);
      let ok = 1;
      for (let s = 1; s < steps; s++) {
        const f = s / steps;
        const rr = Math.round(br + dr * f), cc = Math.round(bc + dc * f);
        const d = f * dist;
        const zline = z0 + (zt - z0) * f;
        const zg = pg.elev[rr * W + cc] - (d * d) / (2 * R_MARS);
        if (zg > zline) { ok = 0; break; }
      }
      los[i] = ok;
    }
  }
  pg.los = los;
  return los;
}
