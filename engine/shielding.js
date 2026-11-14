// shielding.js - how much the terrain around a point cuts the cosmic-ray dose, and where the best natural cover is.
//
// Physics. Galactic cosmic rays reach the surface from the whole sky, most strongly from overhead: the flux falls with
// zenith angle as J ~ cos^n(theta), n = 1.18 +- 0.07, measured by Curiosity RAD at Gale (Wimmer-Schweingruber et al.
// 2015, GRL 42:10557). A hill or butte rising to elevation angle h in some direction hides the sky below h there. For a
// dose summed over all directions (a person, not a flat plate) the share of the downward dose lost in that direction is
// sin(h)^(n+1) (integral of cos^n over the hidden zenith angles). The ground also sends particles back up ("albedo"):
// about 19 % of the surface dose on flat open ground (Guo et al. 2021, GRL 48, e2021GL093912), and a butte face sends
// its own albedo towards the person, roughly in proportion to the share of the sky it covers. So, averaged over
// azimuth, relative to open flat ground:
//
//     factor = 1 - (1 - a) * mean(sin(h)^(n+1)) + a * mean(sin(h))          a = 0.19, n = 1.18
//
// Low hills change almost nothing (near the horizon the sky sends little and the hill's albedo makes up for it); only
// high walls nearby cut the dose. Checked against RAD at the Murray Buttes (validation/shielding_murray_buttes.py):
// for the measured 19 % of blocked sky the formula gives -3 % to -9 % depending on the butte's height, against about
// -4 % measured; without the albedo term it would give -7 % to -13 %.
//
// Resolution. MarsNav's horizons are on a 40 m grid in 16 directions, from the site's 10 m / 20 m elevation. A cliff
// face a few metres away is smoothed out, so the map under-states shelter right against a wall (conservative for dose).
//
// Solar particle events: their protons are softer, so the sky flux is even more concentrated overhead and terrain
// shields LESS than for cosmic rays. Terrain is never treated as a storm shelter: the habitat (or a pressurised rover)
// is. The cover search below tells the crew what the terrain can and cannot do.

export const GCR_ZENITH_EXP = 1.18; // [SRC Wimmer-Schweingruber et al. 2015, GRL 42:10557] (1.18 +- 0.07)
export const ALBEDO_SHARE = 0.19; // [SRC Guo et al. 2021, GRL 48, e2021GL093912] albedo share of flat-terrain dose
export const RAD_MURRAY_BUTTES = { blockedSky: 0.19, doseChange: -0.04 }; // [SRC Ehresmann et al. 2021, JGR Planets 126, e2021JE006851]
// RAD's surface average (0.64 mSv/day) was measured on the Gale crater floor, among low hills, not on an ideal open
// plain: the factor there is 1.0062 (mean of 25 Curiosity stops, sols 1427-1500, 360 directions on HiRISE 1 m terrain;
// validation/results/shielding_murray_buttes.json "ref_factor"). Dividing by it keeps ordinary open ground at the
// RAD average and gives cover its credit.
export const RAD_SURROUNDINGS_FACTOR = 1.0062;

/**
 * Shielding from a horizon profile.
 * @param {ArrayLike<number>} hDeg horizon elevation angles (deg), equally spaced in azimuth
 * @returns {{factor:number, blockedSky:number, downLost:number}} factor = dose relative to open flat ground
 */
export function shieldFromHorizon(hDeg, n = GCR_ZENITH_EXP, a = ALBEDO_SHARE) {
  let blocked = 0, lost = 0;
  const K = hDeg.length;
  for (let k = 0; k < K; k++) {
    const h = Math.min(90, Math.max(0, hDeg[k]));
    const s = Math.sin((h * Math.PI) / 180);
    blocked += s;
    lost += Math.pow(s, n + 1);
  }
  blocked /= K;
  lost /= K;
  return { factor: 1 - (1 - a) * lost + a * blocked, blockedSky: blocked, downLost: lost };
}

/**
 * Dose factor and blocked-sky share for every cell of the 40 m horizon grid (cached on the terrain object).
 * @returns {{factor: Float32Array, blocked: Float32Array, grid: object, min: number, max: number}}
 */
export function shieldGrid(T) {
  if (T._shield) return T._shield;
  const g = T.hzGrid, K = T.sectors;
  const factor = new Float32Array(g.n), blocked = new Float32Array(g.n);
  const h = new Float32Array(K);
  let min = Infinity, max = -Infinity;
  for (let j = 0; j < g.n; j++) {
    for (let k = 0; k < K; k++) h[k] = T.horizon(k, j);
    const s = shieldFromHorizon(h);
    factor[j] = s.factor;
    blocked[j] = s.blockedSky;
    if (s.factor < min) min = s.factor;
    if (s.factor > max) max = s.factor;
  }
  T._shield = { factor, blocked, grid: g, min, max };
  return T._shield;
}

/**
 * Cosmic-ray dose at a 40 m horizon cell relative to RAD's measured average (1 = the RAD average, below 1 = terrain
 * cover). 1 when the site has no horizon layer.
 */
export function shieldAt(T, hzIdx) {
  if (!T?.raw?.horizon || !(hzIdx >= 0)) return 1;
  return shieldGrid(T).factor[hzIdx] / RAD_SURROUNDINGS_FACTOR;
}

/**
 * Best natural cover within reach of a point: the 40 m horizon cell with the lowest dose factor within `radiusM`
 * (straight-line distance; walking time at `speedKmh` with a 1.3 detour factor). Returns the factor here, the best
 * cell, its distance, bearing and minutes on foot, and how much it cuts the cosmic-ray dose relative to here.
 */
export function bestCover(T, x, y, { radiusM = 600, speedKmh = 3, vetoAt = null } = {}) {
  if (!T?.raw?.horizon) return null;
  const S = shieldGrid(T), g = S.grid;
  const c0 = Math.floor((x - g.x0) / g.res), r0 = Math.floor((g.y0 - y) / g.res);
  if (c0 < 0 || r0 < 0 || c0 >= g.width || r0 >= g.height) return null;
  const here = S.factor[r0 * g.width + c0] / RAD_SURROUNDINGS_FACTOR;
  const rc = Math.ceil(radiusM / g.res);
  let best = { j: r0 * g.width + c0, f: here, d: 0, r: r0, c: c0 };
  for (let r = Math.max(0, r0 - rc); r <= Math.min(g.height - 1, r0 + rc); r++) {
    for (let c = Math.max(0, c0 - rc); c <= Math.min(g.width - 1, c0 + rc); c++) {
      const d = Math.hypot(r - r0, c - c0) * g.res;
      if (d > radiusM) continue;
      const j = r * g.width + c, f = S.factor[j] / RAD_SURROUNDINGS_FACTOR;
      const cx = g.x0 + (c + 0.5) * g.res, cy = g.y0 - (r + 0.5) * g.res;
      if (vetoAt && vetoAt(cx, cy)) continue;
      if (f < best.f - 1e-6 || (Math.abs(f - best.f) <= 1e-6 && d < best.d)) best = { j, f, d, r, c };
    }
  }
  const bx = g.x0 + (best.c + 0.5) * g.res, by = g.y0 - (best.r + 0.5) * g.res;
  const bearing = ((Math.atan2(bx - x, by - y) * 180) / Math.PI + 360) % 360;
  return {
    here, best: best.f, blockedSkyBest: S.blocked[best.j], x: bx, y: by, distM: best.d, bearingDeg: bearing,
    walkMin: (best.d * 1.3) / ((speedKmh * 1000) / 60), cutPct: 100 * (1 - best.f / here),
  };
}

/** Compass point for a bearing in degrees. */
export function compass(deg) {
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}
