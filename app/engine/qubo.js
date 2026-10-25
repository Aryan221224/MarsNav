// qubo.js - station selection as a QUBO (quadratic unconstrained binary optimisation), solved classically.
// Research doc 34 found no quantum algorithm that beats classical methods for EVA-sized planning problems, and no
// quantum hardware that could fly. What is useful today is the formulation: station selection with a budget and
// pairwise travel savings is a textbook QUBO, the same object a quantum annealer or QAOA circuit takes. We build it,
// solve it with simulated annealing (the classical method those devices are benchmarked against), check it against
// exact enumeration when the problem is small, and export it so it can be run on any QUBO solver later.
//
//   x_i = 1 if station i is visited (plus a few binary slack bits for the budget)
//   minimise   - sum_i v_i x_i                                     science value (team priorities)
//              - lambda * sum_{i<j} s_ij x_i x_j                    bonus for stations that share a loop
//              + P * (sum_i c_i x_i + slack - B)^2                 time budget as an equality with slack
//   c_i  = station work + out-and-back walk from the habitat - an expected shared-leg saving (s)
//   s_ij = Clarke-Wright saving T(i,0) + T(0,j) - T(i,j) of visiting i and j on one loop
// This is the quadratic knapsack problem, a standard QUBO benchmark. A pairwise model can only approximate a tour, so
// the chosen set is ordered and checked exactly afterwards, trimmed if it overruns and topped up if it has room.

import { timeField, sortieLimits } from "./sortie.js";

/** Build a QUBO { n, m, names, Q (upper triangle), offset, meta } from values, costs (s), savings (s) and a budget (s). */
export function buildSelectionQubo({ values, costs, savings, budget, penalty = null, slackBits = 6, synergy = 0.5, names = null }) {
  const m = values.length;
  const c = costs.map((x) => x / budget); // budget units keep the penalty well conditioned
  const vmax = Math.max(...values, 1e-9);
  const v = values.map((x) => x / vmax);
  const P = penalty ?? 2 * v.reduce((a, b) => a + b, 0) + 1; // any single violation costs more than all the value
  const nb = slackBits;
  const sw = Array.from({ length: nb }, (_, b) => 2 ** (nb - 1 - b) / (2 ** nb - 1)); // slack in [0, 1] budget
  const n = m + nb;
  const Q = Array.from({ length: n }, () => new Float64Array(n));
  const a = [...c, ...sw];
  // P * (sum a_k z_k - 1)^2 = P * [sum a_k^2 z_k - 2 sum a_k z_k + 2 sum_{k<l} a_k a_l z_k z_l + 1]
  for (let i = 0; i < n; i++) {
    Q[i][i] += P * (a[i] * a[i] - 2 * a[i]);
    for (let j = i + 1; j < n; j++) Q[i][j] += 2 * P * a[i] * a[j];
  }
  for (let i = 0; i < m; i++) {
    Q[i][i] -= v[i];
    for (let j = i + 1; j < m; j++) if (savings[i][j] > 0) Q[i][j] -= (synergy * savings[i][j]) / budget;
  }
  return { n, m, names: names || values.map((_, i) => `x${i}`), Q, offset: P, meta: { penalty: P, slackBits: nb, budgetS: budget, vmax, synergy } };
}

/** Energy x^T Q x (+offset) of a 0/1 vector. */
export function quboEnergy(q, x) {
  let e = q.offset;
  for (let i = 0; i < q.n; i++) {
    if (!x[i]) continue;
    e += q.Q[i][i];
    for (let j = i + 1; j < q.n; j++) if (x[j]) e += q.Q[i][j];
  }
  return e;
}

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/**
 * Simulated annealing with single-bit flips and incremental energy updates.
 * @returns { x, energy, sweeps, restarts }
 */
export function annealQubo(q, { sweeps = 2000, restarts = 8, t0 = null, t1 = 1e-3, seed = 1 } = {}) {
  const n = q.n, Q = q.Q, rand = rng(seed);
  // symmetric neighbour weights for delta computation
  const W = Array.from({ length: n }, (_, i) => Float64Array.from({ length: n }, (_, j) => (i < j ? Q[i][j] : j < i ? Q[j][i] : 0)));
  let maxAbs = 0;
  for (let i = 0; i < n; i++) for (let j = i; j < n; j++) maxAbs = Math.max(maxAbs, Math.abs(Q[i][j]));
  const T0 = t0 ?? maxAbs;
  let best = null, bestE = Infinity;
  for (let r = 0; r < restarts; r++) {
    const x = Uint8Array.from({ length: n }, () => (rand() < 0.5 ? 1 : 0));
    // field h_i = Q_ii + sum_j W_ij x_j ; flipping i changes E by (1 - 2 x_i) * h_i
    const h = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = Q[i][i]; for (let j = 0; j < n; j++) if (x[j]) s += W[i][j]; h[i] = s; }
    let E = quboEnergy(q, x);
    for (let s = 0; s < sweeps; s++) {
      const T = T0 * (t1 / T0) ** (s / Math.max(1, sweeps - 1));
      for (let k = 0; k < n; k++) {
        const i = Math.floor(rand() * n);
        const dE = (1 - 2 * x[i]) * h[i];
        if (dE <= 0 || rand() < Math.exp(-dE / T)) {
          const d = x[i] ? -1 : 1;
          x[i] ^= 1;
          E += dE;
          for (let j = 0; j < n; j++) if (W[i][j]) h[j] += d * W[i][j];
        }
      }
    }
    if (E < bestE - 1e-12) { bestE = E; best = Uint8Array.from(x); }
  }
  return { x: best, energy: bestE, sweeps, restarts };
}

/** Exact minimum by enumeration (n <= 24), for checking the annealer. */
export function bruteForceQubo(q) {
  if (q.n > 24) throw new Error("bruteForceQubo: too many variables");
  let bestE = Infinity, best = 0;
  const x = new Uint8Array(q.n);
  for (let mask = 0; mask < 1 << q.n; mask++) {
    for (let i = 0; i < q.n; i++) x[i] = (mask >> i) & 1;
    const e = quboEnergy(q, x);
    if (e < bestE) { bestE = e; best = mask; }
  }
  return { x: Uint8Array.from({ length: q.n }, (_, i) => (best >> i) & 1), energy: bestE };
}

/**
 * Export for other QUBO solvers (quantum annealers, QAOA, commercial solvers). Plain JSON with the variable names,
 * linear and quadratic biases, as dimod's BinaryQuadraticModel(linear, quadratic, offset, "BINARY") takes them.
 */
export function exportQubo(q) {
  const linear = {}, quadratic = {};
  const name = (i) => (i < q.m ? q.names[i] : `slack${i - q.m}`);
  for (let i = 0; i < q.n; i++) {
    if (q.Q[i][i]) linear[name(i)] = q.Q[i][i];
    for (let j = i + 1; j < q.n; j++) if (q.Q[i][j]) quadratic[`${name(i)}|${name(j)}`] = q.Q[i][j];
  }
  return { format: "martian-map-qubo-v1", vartype: "BINARY", variables: Array.from({ length: q.n }, (_, i) => name(i)), linear, quadratic,
    offset: q.offset, meta: q.meta,
    note: "Minimise offset + sum linear[v] x_v + sum quadratic['a|b'] x_a x_b. Python: dimod.BinaryQuadraticModel(linear, {tuple(k.split('|')): v for k, v in quadratic.items()}, offset, 'BINARY')" };
}

/**
 * Station selection for many candidates (beyond the exact enumeration in sortie.js): QUBO + annealing picks the set,
 * nearest-neighbour + 2-opt orders it, and the estimate is checked against the budget exactly as sortie.js does.
 */
export function selectStationsQubo(planner, cands, { margin = 0.85, kExpected = 3, seed = 1, sweeps = 3000, restarts = 12 } = {}) {
  const m = planner.m, pg = m.coarse, g = pg.grid;
  const nodes = [{ id: "HAB", lon: planner.base.lon, lat: planner.base.lat, value: 0, dwell_min: 0 }, ...cands];
  const idx = nodes.map((p) => planner._nearestFree(pg, g.idxOfLonLat(p.lon, p.lat)));
  const fields = idx.map((i) => timeField(m, pg, i));
  const T = nodes.map((_, a) => nodes.map((__, b) => fields[a][idx[b]]));
  const ok = cands.map((_, i) => Number.isFinite(T[0][i + 1]) && Number.isFinite(T[i + 1][0]));
  const use = cands.map((c, i) => i).filter((i) => ok[i]);
  const lim = sortieLimits(planner, margin);
  const budget = lim.effectiveT; // the tightest of time, battery and O2 as seconds of EVA
  const values = use.map((i) => cands[i].value ?? 0.3);
  const savings = use.map((i) => use.map((j) => (i === j ? 0 : Math.max(0, T[i + 1][0] + T[0][j + 1] - T[i + 1][j + 1]))));
  // expected shared-leg saving: on a k-stop loop each station shares roughly half a saving with its best neighbours
  const costs = use.map((i, a) => {
    const top = [...savings[a]].sort((x, y) => y - x).slice(0, Math.max(1, kExpected - 1));
    const share = top.length ? (0.5 * top.reduce((s, x) => s + x, 0)) / top.length : 0;
    return cands[i].dwell_min * 60 + Math.max(Math.max(T[0][i + 1], T[i + 1][0]), T[0][i + 1] + T[i + 1][0] - share);
  });
  const q = buildSelectionQubo({ values, costs, savings, budget, names: use.map((i) => cands[i].id) });
  const t0 = Date.now();
  const sa = annealQubo(q, { sweeps, restarts, seed });
  let chosen = use.filter((_, k) => sa.x[k]);
  // order: nearest neighbour from the habitat, then 2-opt on the leg-time matrix
  const tour = (set) => {
    const order = [], left = new Set(set);
    let cur = 0;
    while (left.size) {
      let bj = null, bt = Infinity;
      for (const j of left) if (T[cur][j + 1] < bt) { bt = T[cur][j + 1]; bj = j; }
      order.push(bj); left.delete(bj); cur = bj + 1;
    }
    const len = (o) => o.reduce((s, j, k) => s + T[k ? o[k - 1] + 1 : 0][j + 1], 0) + (o.length ? T[o[o.length - 1] + 1][0] : 0);
    // 2-opt (reverse a segment) and Or-opt (move a chain of 1-3 stations, either way round) until neither improves;
    // both re-price the whole tour, so they stay correct on the asymmetric leg-time matrix (uphill != downhill)
    let improved = true;
    while (improved) {
      improved = false;
      for (let a = 0; a < order.length - 1; a++) for (let b = a + 1; b < order.length; b++) {
        const o2 = [...order.slice(0, a), ...order.slice(a, b + 1).reverse(), ...order.slice(b + 1)];
        if (len(o2) < len(order) - 1e-6) { order.splice(0, order.length, ...o2); improved = true; }
      }
      for (let L = 1; L <= Math.min(3, order.length - 1); L++) for (let a = 0; a + L <= order.length; a++) {
        const chain = order.slice(a, a + L), rest = [...order.slice(0, a), ...order.slice(a + L)];
        for (const ch of L > 1 ? [chain, [...chain].reverse()] : [chain]) for (let p = 0; p <= rest.length; p++) {
          if (p === a && ch === chain) continue;
          const o2 = [...rest.slice(0, p), ...ch, ...rest.slice(p)];
          if (len(o2) < len(order) - 1e-6) { order.splice(0, order.length, ...o2); improved = true; }
        }
      }
    }
    return { order, travel: len(order) };
  };
  // repair: drop the lowest value-per-second station until the exact tour fits the budget
  let tr = tour(chosen);
  const workOf = (set) => set.reduce((s, j) => s + cands[j].dwell_min * 60, 0);
  const extraOf = (set) => set.reduce((e, j) => { const x = lim.station(cands[j]); return { o2: e.o2 + x.o2, batt: e.batt + x.batt }; }, { o2: 0, batt: 0 });
  const timeOf = (set, t) => t.travel + workOf(set);
  const fits = (set, t) => lim.fits(t.travel, workOf(set), extraOf(set));
  while (chosen.length && !fits(chosen, tr)) {
    let w = 0;
    chosen.forEach((j, k) => { if ((cands[j].value ?? 0.3) / (cands[j].dwell_min * 60 + 1) < (cands[chosen[w]].value ?? 0.3) / (cands[chosen[w]].dwell_min * 60 + 1)) w = k; });
    chosen = chosen.filter((_, k) => k !== w);
    tr = tour(chosen);
  }
  // top up: add the best remaining station while the exact tour still fits
  for (;;) {
    const rest = use.filter((j) => !chosen.includes(j)).sort((x, y) => (cands[y].value ?? 0.3) - (cands[x].value ?? 0.3));
    let added = false;
    for (const j of rest) {
      const t2 = tour([...chosen, j]);
      if (fits([...chosen, j], t2)) { chosen = [...chosen, j]; tr = t2; added = true; break; }
    }
    if (!added) break;
  }
  // swap local search on the set: trade one chosen station for one or two others while the tour still fits and the
  // science value goes up (on 15-station test instances this halves the gap to the exact optimum)
  const value = (set) => set.reduce((s, j) => s + (cands[j].value ?? 0.3), 0);
  for (let it = 0, better = true; better && it < 40; it++) {
    better = false;
    const out = use.filter((j) => !chosen.includes(j));
    for (const i of chosen) {
      for (let a = 0; a < out.length && !better; a++) {
        for (const add of [[out[a]], ...out.slice(a + 1).map((b) => [out[a], b])]) {
          const set = [...chosen.filter((x) => x !== i), ...add];
          if (value(set) <= value(chosen) + 1e-12) continue;
          const t2 = tour(set);
          if (fits(set, t2)) { chosen = set; tr = t2; better = true; break; }
        }
      }
      if (better) break;
    }
  }
  const order = tr.order;
  return {
    ids: order.map((j) => cands[j].id), value: order.reduce((s, j) => s + (cands[j].value ?? 0.3), 0), timeS: timeOf(order, tr),
    travelS: tr.travel, budgetT: lim.budgetT, o2Kg: lim.use(tr.travel, workOf(order), extraOf(order)).o2, qubo: q, energy: sa.energy, ms: Date.now() - t0, variables: q.n,
  };
}
