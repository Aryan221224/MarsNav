// measure.js - distances and areas on Mars for the measuring tools (Landing globe and EVA map).
// Great-circle distances on the Mars 2000 sphere (R 3 396.19 km, the radius of every MarsNav map); polygon areas from
// the spherical excess of the polygon (exact on the sphere, any size). Points are [lon, lat] in degrees, east-positive.

export const R_KM = 3396.19;
const DEG = Math.PI / 180;

export function distKm(a, b) {
  const p1 = a[1] * DEG, p2 = b[1] * DEG, dp = p2 - p1, dl = (b[0] - a[0]) * DEG;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearingDeg(a, b) {
  const p1 = a[1] * DEG, p2 = b[1] * DEG, dl = (b[0] - a[0]) * DEG;
  const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

/** Length of a polyline (km) and of each segment. */
export function pathKm(pts) {
  const seg = [];
  for (let k = 1; k < pts.length; k++) seg.push(distKm(pts[k - 1], pts[k]));
  return { total: seg.reduce((a, b) => a + b, 0), seg };
}

/**
 * Area (km^2) of a simple polygon on the sphere (Chamberlain & Duquette 2007, "Some algorithms for polygons on a
 * sphere", JPL; the form OpenLayers uses): A = R^2 / 2 |sum (l2 - l1)(2 + sin p1 + sin p2)|. Exact for boxes bounded by
 * meridians and parallels; for small polygons the difference from great-circle edges is negligible.
 */
export function areaKm2(pts) {
  if (pts.length < 3) return 0;
  let s = 0;
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k], b = pts[(k + 1) % pts.length];
    let dl = (b[0] - a[0]) * DEG;
    if (dl > Math.PI) dl -= 2 * Math.PI;
    if (dl < -Math.PI) dl += 2 * Math.PI;
    s += dl * (2 + Math.sin(a[1] * DEG) + Math.sin(b[1] * DEG));
  }
  return Math.abs((s * R_KM * R_KM) / 2);
}

/** Points every `stepKm` along a great circle from a to b (both ends included). */
export function greatCircle(a, b, stepKm = 1, maxN = 400) {
  const d = distKm(a, b), n = Math.max(1, Math.min(maxN, Math.ceil(d / stepKm)));
  const p1 = a[1] * DEG, l1 = a[0] * DEG, p2 = b[1] * DEG, l2 = b[0] * DEG;
  const v1 = [Math.cos(p1) * Math.cos(l1), Math.cos(p1) * Math.sin(l1), Math.sin(p1)];
  const v2 = [Math.cos(p2) * Math.cos(l2), Math.cos(p2) * Math.sin(l2), Math.sin(p2)];
  const om = Math.acos(Math.max(-1, Math.min(1, v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2])));
  const out = [];
  for (let k = 0; k <= n; k++) {
    const f = k / n;
    let v;
    if (om < 1e-9) v = v1;
    else { const A = Math.sin((1 - f) * om) / Math.sin(om), B = Math.sin(f * om) / Math.sin(om); v = [A * v1[0] + B * v2[0], A * v1[1] + B * v2[1], A * v1[2] + B * v2[2]]; }
    out.push([Math.atan2(v[1], v[0]) / DEG, Math.atan2(v[2], Math.hypot(v[0], v[1])) / DEG]);
  }
  return out;
}

export const fmtDist = (km) => km >= 100 ? `${km.toFixed(0)} km` : km >= 1 ? `${km.toFixed(2)} km` : `${Math.round(km * 1000)} m`;
export const fmtArea = (km2) => km2 >= 100 ? `${Math.round(km2).toLocaleString()} km²` : km2 >= 0.1 ? `${km2.toFixed(2)} km²` : `${Math.round(km2 * 1e6).toLocaleString()} m² (${(km2 * 100).toFixed(2)} ha)`;
