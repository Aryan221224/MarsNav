// headline_stats.mjs - 95 % intervals for every headline validation number, read from the result files the
// validation scripts write (never typed by hand). Writes validation/results/headline.json, which the README and the
// submission quote and tests/headline_numbers.test.mjs checks against both the source files and the documents.
//   node validation/headline_stats.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const R = (f) => JSON.parse(fs.readFileSync(path.join(HERE, "results", f)));

/** Wilson score interval for k successes in n trials (95 %). */
export function wilson(k, n, z = 1.959964) {
  const p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

// regularised incomplete beta by continued fraction (Numerical Recipes betacf), for Clopper-Pearson
function lnGamma(x) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5, ser = 1.000000000190015;
  tmp -= (x + 0.5) * Math.log(tmp);
  for (const c of g) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
function betacf(a, b, x) {
  let c = 1, d = 1 - ((a + b) * x) / (a + 1);
  d = 1 / (Math.abs(d) < 1e-30 ? 1e-30 : d);
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a - 1 + m2) * (a + m2));
    d = 1 + aa * d; d = 1 / (Math.abs(d) < 1e-30 ? 1e-30 : d); c = 1 + aa / c; c = Math.abs(c) < 1e-30 ? 1e-30 : c; h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + 1 + m2));
    d = 1 + aa * d; d = 1 / (Math.abs(d) < 1e-30 ? 1e-30 : d); c = 1 + aa / c; c = Math.abs(c) < 1e-30 ? 1e-30 : c;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < 3e-14) break;
  }
  return h;
}
function ibeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
function ibetaInv(a, b, p) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (ibeta(a, b, mid) < p) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
/** Clopper-Pearson exact interval (95 %). */
export function clopperPearson(k, n, alpha = 0.05) {
  return [k === 0 ? 0 : ibetaInv(k, n - k + 1, alpha / 2), k === n ? 1 : ibetaInv(k + 1, n - k, 1 - alpha / 2)];
}
/** Two-sided exact sign test on discordant pairs (b one way, c the other). */
export function signTestP(b, c) {
  const n = b + c, k = Math.min(b, c);
  let p = 0;
  for (let i = 0; i <= k; i++) p += Math.exp(lnGamma(n + 1) - lnGamma(i + 1) - lnGamma(n - i + 1) - n * Math.LN2);
  return Math.min(1, 2 * p);
}

export function headline() {
  const V = R("validation.json"), CL = R("closed_loop.json"), SH = R("shielding_murray_buttes.json");
  const det = V.reproduction.detour, runs = CL.summary.runs, bc = CL.summary.breaches.closed, bo = CL.summary.breaches.open;
  const slopeK = Math.round(V.slope.slopeW_ge_tilt_frac * V.slope.points);
  const fn = V.traversability.foot;
  // pairs: the closed loop never dipped, so every open-loop dip is a discordant pair in the loop's favour
  const discordant = CL.runs ? CL.runs.filter((r) => (r.open?.breach ?? false) !== (r.closed?.breach ?? false)) : null;
  const pct = (x) => Math.round(1000 * x) / 10;
  return {
    generated_from: ["validation/results/validation.json", "validation/results/closed_loop.json", "validation/results/shielding_murray_buttes.json"],
    clock: { samples: V.clock.samples, sols: V.clock.sols, sza_sd_deg: +V.clock.sza_deg.sd.toFixed(3), sza_mean_deg: +V.clock.sza_deg.mean.toFixed(3),
      sza_mean_ci95_deg: [V.clock.sza_deg.mean - 1.959964 * V.clock.sza_deg.sd / Math.sqrt(V.clock.sza_deg.n),
        V.clock.sza_deg.mean + 1.959964 * V.clock.sza_deg.sd / Math.sqrt(V.clock.sza_deg.n)].map((x) => +x.toFixed(4)) },
    slope: { k: slopeK, n: V.slope.points, pct: pct(slopeK / V.slope.points), ci95_pct: wilson(slopeK, V.slope.points).map(pct), r: +V.slope.r_slopeW.toFixed(2) },
    false_nogo: { k: fn.vetoed, n: fn.points, pct: pct(fn.vetoed / fn.points), ci95_pct: wilson(fn.vetoed, fn.points).map(pct) },
    detour: { k: det.real_safer_than_straight, n: det.n, pct: pct(det.real_safer_than_straight / det.n), ci95_pct: wilson(det.real_safer_than_straight, det.n).map(pct) },
    closed_loop: { runs, closed_dips: bc, open_dips: bo,
      closed_ci95_pct: clopperPearson(bc, runs).map(pct), open_ci95_pct: clopperPearson(bo, runs).map(pct),
      sign_test_p: discordant ? signTestP(discordant.filter((r) => r.open?.breach).length, discordant.filter((r) => r.closed?.breach).length) : signTestP(bo - bc, 0) },
    shielding: { measured_change_pct: SH.measured.dose_change_pct, blocked_sky_pct: SH.measured.blocked_sky_pct,
      model_range_pct: SH.result.published_geometry_change_range_pct, model_range_no_albedo_pct: SH.result.published_geometry_change_range_pct_no_albedo,
      orbital_blocked_sky_within_24m_pct: SH.result.blocked_sky_within_24m_pct, ref_factor: SH.result.ref_factor },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const h = headline();
  fs.writeFileSync(path.join(HERE, "results", "headline.json"), JSON.stringify(h, null, 1) + "\n");
  // the Review tab's validation table (app/data/validation.json): add / replace the radiation-shielding row
  const vpath = path.join(HERE, "..", "app", "data", "validation.json");
  if (fs.existsSync(vpath)) {
    const v = JSON.parse(fs.readFileSync(vpath, "utf8")), S = h.shielding;
    const row = `<tr><th>Terrain radiation shielding vs Curiosity RAD</th><td>By a Murray Butte that blocked ${S.blocked_sky_pct} % of the sky, RAD measured about ${S.measured_change_pct} % dose; MarsNav's formula gives ${S.model_range_pct[0].toFixed(1)} % to ${S.model_range_pct[1].toFixed(1)} % for that geometry (${S.model_range_no_albedo_pct[0].toFixed(1)} % to ${S.model_range_no_albedo_pct[1].toFixed(1)} % without ground albedo). Unresolved from orbit: 1 m terrain shows ${Math.round(S.orbital_blocked_sky_within_24m_pct[0])}-${Math.round(S.orbital_blocked_sky_within_24m_pct[1])} % of the sky blocked within 24 m of the stop, so the map under-states shelter by cliffs.</td></tr>`;
    v.html = v.html.replace(/<tr><th>Terrain radiation shielding[\s\S]*?<\/tr>/g, "").replace("</table>", row + "</table>");
    fs.writeFileSync(vpath, JSON.stringify(v));
  }
  console.log(JSON.stringify(h, null, 1));
}
