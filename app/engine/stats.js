// stats.js - paired statistics for validation campaigns (adopted from the QPath benchmark methodology: paired runs on
// identical inputs, a non-parametric paired test, and the result reported whichever way it comes out).

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 erf, |error| < 1.5e-7). */
export function normCdf(z) {
  const x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/**
 * Wilcoxon signed-rank test on paired samples a[i] vs b[i] (normal approximation with tie and continuity correction;
 * zero differences dropped, as in Wilcoxon's original procedure). Returns { n, wPlus, z, pTwoSided, pGreater } where
 * pGreater is the one-sided p-value for "a tends to be larger than b".
 */
export function wilcoxonSignedRank(a, b) {
  const d = a.map((x, i) => x - b[i]).filter((x) => x !== 0);
  const n = d.length;
  if (!n) return { n: 0, wPlus: 0, z: 0, pTwoSided: 1, pGreater: 1 };
  const idx = d.map((x, i) => [Math.abs(x), i]).sort((p, q) => p[0] - q[0]);
  const rank = new Array(n);
  let tie = 0;
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
    const r = (i + j + 2) / 2, t = j - i + 1;
    for (let k = i; k <= j; k++) rank[idx[k][1]] = r;
    tie += t * t * t - t;
    i = j + 1;
  }
  const wPlus = d.reduce((s, x, i) => s + (x > 0 ? rank[i] : 0), 0);
  const mean = (n * (n + 1)) / 4, sd = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24 - tie / 48);
  if (!(sd > 0)) return { n, wPlus, z: 0, pTwoSided: 1, pGreater: 1 };
  const z = Math.sign(wPlus - mean) * Math.max(Math.abs(wPlus - mean) - 0.5, 0) / sd; // continuity-corrected, as scipy
  return { n, wPlus, z, pTwoSided: Math.min(1, 2 * (1 - normCdf(Math.abs(z)))), pGreater: 1 - normCdf((wPlus - mean - 0.5) / sd) };
}
