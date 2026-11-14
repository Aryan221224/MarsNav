// risk.js - risk measures for uncertain hazards (research doc 28).
// For a normal N(mu, sd): CVaR_alpha = mu + sd * phi(z_alpha) / (1 - alpha)  (mean of the worst 1-alpha tail).
// Endo et al. (ICRA 2023) found CVaR planning safer than expected-value and VaR planning for slip on heterogeneous terrain.

export function normPdf(z) {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

/** Inverse standard normal CDF (Acklam's rational approximation, |error| < 1.2e-9). */
export function normInv(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425, ph = 1 - pl;
  let q, r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= ph) {
    q = p - 0.5;
    r = q * q;
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

export function normCdf(z) {
  // Abramowitz-Stegun 7.1.26 via erf
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t *
    Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Tail factor k so that CVaR_alpha = mu + k * sd for a normal. k(0.9) = 1.7550. */
export function cvarFactor(alpha) {
  return normPdf(normInv(alpha)) / (1 - alpha);
}

/** Risk value of an uncertain quantity under the chosen measure. */
export function riskValue(mu, sd, risk) {
  switch (risk.kind) {
    case "mean": return mu;
    case "mvar": return mu + (risk.lambda ?? 1) * sd;
    case "var": return mu + normInv(risk.alpha ?? 0.9) * sd;
    case "cvar": default: return mu + cvarFactor(risk.alpha ?? 0.9) * sd;
  }
}

/** P(X > thr) for X ~ N(mu, sd). */
export function pExceed(mu, sd, thr) {
  if (sd <= 1e-9) return mu > thr ? 1 : 0;
  return 1 - normCdf((thr - mu) / sd);
}
