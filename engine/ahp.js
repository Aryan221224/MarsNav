// ahp.js - Analytic Hierarchy Process (Saaty): priority weights from pairwise judgements, with a consistency check.
// Weights = principal eigenvector of the reciprocal matrix A (A w = lambda_max w); CI = (lambda_max - n)/(n - 1);
// CR = CI / RI(n); judgements are accepted when CR <= 0.10. RI(3) = 0.58 was confirmed in a source during research;
// the other RI values are the commonly published Saaty values.

export const RI = [0, 0, 0, 0.58, 0.9, 1.12, 1.24, 1.32, 1.41, 1.45, 1.49];

export function ahp(A, iters = 1000) {
  const n = A.length;
  let w = new Array(n).fill(1 / n);
  for (let it = 0; it < iters; it++) {
    const w2 = A.map((row) => row.reduce((s, a, j) => s + a * w[j], 0));
    const s = w2.reduce((a, b) => a + b, 0);
    for (let i = 0; i < n; i++) w2[i] /= s;
    const diff = Math.max(...w2.map((v, i) => Math.abs(v - w[i])));
    w = w2;
    if (diff < 1e-14) break;
  }
  const Aw = A.map((row) => row.reduce((s, a, j) => s + a * w[j], 0));
  const lambdaMax = Aw.reduce((s, v, i) => s + v / w[i], 0) / n;
  const CI = n > 2 ? (lambdaMax - n) / (n - 1) : 0;
  const CR = RI[n] > 0 ? CI / RI[n] : 0;
  return { weights: w, lambdaMax, CI, CR, consistent: CR <= 0.1 };
}

/** Build a full reciprocal matrix from the upper-triangle judgements { "i,j": a_ij }. */
export function fromUpper(n, upper) {
  const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : null)));
  for (const [k, v] of Object.entries(upper)) {
    const [i, j] = k.split(",").map(Number);
    A[i][j] = v;
    A[j][i] = 1 / v;
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (A[i][j] == null) throw new Error(`missing a[${i}][${j}]`);
  return A;
}

// ---- The team's default judgements (research doc 28): all [ASSUME]; NASA has published no Mars route weights. ----
export const L1_IDS = ["S", "C", "R", "T", "V"];
export const L1_NAMES = {
  S: "Safety", C: "Consumables & energy margin", R: "Recoverability & connectivity", T: "Time & efficiency",
  V: "Science & mission value",
};
export const L1_MATRIX = [
  [1, 2, 2, 5, 9],
  [1 / 2, 1, 1, 3, 5],
  [1 / 2, 1, 1, 3, 5],
  [1 / 5, 1 / 3, 1 / 3, 1, 3],
  [1 / 9, 1 / 5, 1 / 5, 1 / 3, 1],
];
export const L1_REASONS = {
  "S,C": [2, "Consumables are already a hard limit; the margin above it matters less than avoiding harm"],
  "S,R": [2, "Recoverability is itself a safety function, so it stays close"],
  "S,T": [5, "Time only buys EVA hours; harm ends the EVA"],
  "S,V": [9, "Science only ranks routes that are already survivable"],
  "C,R": [1, "Both decide whether a bad day is survivable"],
  "C,T": [3, "The limiting resource on an EVA is oxygen and power, not clock time"],
  "C,V": [5, ""], "R,T": [3, ""], "R,V": [5, ""], "T,V": [3, ""],
};

// Safety branch, per travel mode, and the terrain leaves (S1). Local weights of other branches are direct.
export const SAFETY_MATRICES = {
  foot: { ids: ["S1", "S3", "S4"], A: [[1, 1, 3], [1, 1, 3], [1 / 3, 1 / 3, 1]] },
  rover: { ids: ["S1", "S2", "S4"], A: [[1, 2, 3], [1 / 2, 1, 2], [1 / 3, 1 / 2, 1]] },
  robot: { ids: ["S1", "S2", "S4"], A: [[1, 2, 3], [1 / 2, 1, 2], [1 / 3, 1 / 2, 1]] },
};
export const S1_MATRIX = { ids: ["S1.1", "S1.2", "S1.3", "S1.4"], A: [[1, 2, 1 / 2, 1], [1 / 2, 1, 1 / 3, 1 / 2], [2, 3, 1, 2], [1, 2, 1 / 2, 1]] };

export const LEAF_NAMES = {
  "S1.1": "Slope (walking / wheel scale)", "S1.2": "Rocks, steps, roughness", "S1.3": "Soft soil, slip, bedforms",
  "S1.4": "Edges and cliffs", "S2.1": "Wheel wear", "S2.2": "Slip load on drivetrain", "S3.1": "Suit abrasion / dust",
  "S3.2": "Thermal (shade, cold soak)", "S3.4": "Falls (cross-slope, loose footing)", "S4.3": "Light and visibility",
};
// Direct local weights inside S2, S3, S4 for the leaves the engine computes (research doc 27; renormalised).
export const DIRECT = {
  S2: { "S2.1": 0.6, "S2.2": 0.4 },
  S3: { "S3.1": 0.3, "S3.2": 0.35, "S3.4": 0.35 },
  S4: { "S4.3": 1.0 },
};

/** Global weights of the computed safety leaves inside the Safety criterion (sum to 1) for a mode. */
export function safetyLeafWeights(mode) {
  const sm = SAFETY_MATRICES[mode] ?? SAFETY_MATRICES.foot;
  const sw = ahp(sm.A).weights;
  const s1 = ahp(S1_MATRIX.A).weights;
  const out = {};
  sm.ids.forEach((id, i) => {
    if (id === "S1") S1_MATRIX.ids.forEach((leaf, j) => (out[leaf] = sw[i] * s1[j]));
    else for (const [leaf, w] of Object.entries(DIRECT[id])) out[leaf] = sw[i] * w;
  });
  const tot = Object.values(out).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(out)) out[k] /= tot;
  return out;
}

export function defaultL1() {
  const r = ahp(L1_MATRIX);
  return Object.fromEntries(L1_IDS.map((k, i) => [k, r.weights[i]]));
}

/** Named route weight sets (research doc 27/28). */
export function namedWeightSets() {
  const l1 = defaultL1();
  return {
    fastest: { T: 1 },
    balanced: l1,
    safest: { S: 0.6, R: 0.2, C: 0.1, T: 0.1 },
    economy: { C: 0.9, T: 0.1 },
  };
}
