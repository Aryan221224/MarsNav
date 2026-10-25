// util.js - small numeric helpers shared by the engine.

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/** Linear ramp: 0 at `warn`, 1 at `veto` (works for decreasing thresholds too). */
export function ramp(v, warn, veto) {
  const t = (v - warn) / (veto - warn);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * Two-pass chamfer distance transform (3-4 metric, ~2 % error) on a grid.
 * `src` is a Uint8Array mask (non-zero = feature). Returns Float32Array of distances in metres.
 */
export function distanceTransform(src, width, height, res) {
  const INF = 1e9;
  const d = new Float32Array(width * height);
  for (let i = 0; i < d.length; i++) d[i] = src[i] ? 0 : INF;
  const a = 1, b = Math.SQRT2;
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const i = r * width + c;
      let v = d[i];
      if (v === 0) continue;
      if (c > 0) v = Math.min(v, d[i - 1] + a);
      if (r > 0) {
        v = Math.min(v, d[i - width] + a);
        if (c > 0) v = Math.min(v, d[i - width - 1] + b);
        if (c < width - 1) v = Math.min(v, d[i - width + 1] + b);
      }
      d[i] = v;
    }
  }
  for (let r = height - 1; r >= 0; r--) {
    for (let c = width - 1; c >= 0; c--) {
      const i = r * width + c;
      let v = d[i];
      if (v === 0) continue;
      if (c < width - 1) v = Math.min(v, d[i + 1] + a);
      if (r < height - 1) {
        v = Math.min(v, d[i + width] + a);
        if (c < width - 1) v = Math.min(v, d[i + width + 1] + b);
        if (c > 0) v = Math.min(v, d[i + width - 1] + b);
      }
      d[i] = v;
    }
  }
  for (let i = 0; i < d.length; i++) d[i] *= res;
  return d;
}

/** Cells visited by a straight line between two cells (supercover-ish sampling at 1/3 cell). */
export function lineCells(r0, c0, r1, c1) {
  const n = Math.max(1, Math.ceil(3 * Math.max(Math.abs(r1 - r0), Math.abs(c1 - c0))));
  const out = [];
  let lr = -1, lc = -1;
  for (let k = 0; k <= n; k++) {
    const r = Math.round(r0 + ((r1 - r0) * k) / n), c = Math.round(c0 + ((c1 - c0) * k) / n);
    if (r !== lr || c !== lc) {
      out.push(r, c);
      lr = r;
      lc = c;
    }
  }
  return out;
}

export function sum(a) {
  let s = 0;
  for (const v of a) s += v;
  return s;
}

export function percentile(arr, p) {
  const a = Array.from(arr).filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const k = (a.length - 1) * p;
  const f = Math.floor(k), c = Math.min(a.length - 1, f + 1);
  return a[f] + (a[c] - a[f]) * (k - f);
}

export function fmtDuration(s) {
  const neg = s < 0;
  s = Math.abs(Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return `${neg ? "-" : ""}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}
