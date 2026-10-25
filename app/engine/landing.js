// landing.js - where does the lander (and so the habitat, the "hub" every EVA returns to) actually come down?
// Modelled on how NASA selects and flies Mars landing sites:
//   1. The lander class sets a landing ellipse: the 99 % touchdown dispersion from entry navigation and guidance.
//      Viking 300 x 100 km (1976), MER 150 x 20 km (2004), MSL guided entry 20 x 7 km (2012), Mars 2020 7.7 x 6.6 km
//      (2021) [SRC jatan.space/how-nasa-choses-mars-landing-sites; NASA/JPL]. A human-class lander must land within
//      50 m [SRC NASA NTRS 20205003002].
//   2. Engineering safety constraints are checked over the ellipse, at the scales that matter to the lander: slope
//      <= 15 deg over 2-5 m (lander stability), rocks <= 0.55 m, relief <= 43 m over 200-1000 m (radar altimetry),
//      slope <= 20 deg over 2-10 km, elevation <= +1 km MOLA, latitude 45 S - 45 N [SRC MSL Landing Site Selection
//      User's Guide to Engineering Constraints v4.5.1].
//   3. With Terrain-Relative Navigation (Mars 2020 Lander Vision System) the descending vehicle matches its camera
//      images to an orbital map (HiRISE-derived, 12 and 6 m/px), knows its position to < 40 m relative to the map, and
//      steers to the safest reachable point of an a-priori safe-target map; Perseverance touched down 5 m from the
//      point LVS chose [SRC JPL Robotics TRN page; NTRS 20230006986].
//   4. After touchdown the position is refined: first from the onboard navigation state (TRN: ~40 m; without TRN:
//      the ellipse), then by orbital imaging of the hardware (HiRISE, ~1 m), and on the surface by matching navigation-
//      camera panoramas to orbital maps (Mars Global Localization, ~25 cm in ~2 min) [SRC JPL news 2025].
// The touchdown dispersion is sampled by Monte Carlo over the site's real hazard layers; the probability of a safe
// landing is the fraction of touchdowns on lander-safe ground. Assumptions are tagged [ASSUME].

import { lonlatToXY, xyToLonLat, DEG } from "./geo.js";

export const LANDERS = {
  viking: { label: "Viking-class ballistic entry (1976)", major: 300000, minor: 100000, trn: null,
    src: "Viking 1/2 landing ellipses 300 x 100 km" },
  mer: { label: "MER-class (Spirit/Opportunity, 2004)", major: 150000, minor: 20000, trn: null,
    src: "MER ellipses ~150 x 20 km" },
  msl: { label: "MSL-class guided entry (Curiosity, 2012)", major: 20000, minor: 7000, trn: null,
    src: "MSL ellipse 20 x 7 km" },
  m2020: { label: "Mars 2020: guided entry + Terrain-Relative Navigation", major: 7700, minor: 6600,
    trn: { mapErrM: 40, divertM: 300, touchdownErrM: 5 }, src: "M2020 ellipse 7.7 x 6.6 km; LVS < 40 m map error; 5 m touchdown error" },
  human: { label: "Human-class precision lander (50 m requirement)", major: 150, minor: 150,
    trn: { mapErrM: 10, divertM: 100, touchdownErrM: 5 }, src: "NASA human-lander study: 50 m landing accuracy" },
};
// divertM for M2020 and every human-lander number except the 50 m accuracy are [ASSUME] within published ranges.

// lander-scale safety limits [SRC MSL engineering constraints]
export const LIMITS = { slope25m: 15, rockM: 0.55, relief1kmM: 43, slopeKmDeg: 20, maxElevM: 1000, maxAbsLat: 45,
  footprintM: 10 /* [ASSUME] lander + skycrane clearance radius */ };

/** Per-cell landing class on the fine grid: 0 unsafe, 1 safe (verified by 1 m data), 2 safe-looking but unverified
 *  (only the regional DEM there: slope and rocks below the DEM's resolution are unknown). */
export function landingSafetyMap(T) {
  const g = T.grid, n = g.n;
  const sw = T.f32("slopeW"), st = T.f32("step"), sand = T.f32("sand"), cd = T.f32("cliffDist"), conf = T.f32("conf");
  const ko = T.raw.keepout;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const hard = sw[i] > LIMITS.slope25m || cd[i] < LIMITS.footprintM || (ko[i] & (1 | 2 | 4)) || sand[i] > 0.6;
    if (hard) { out[i] = 0; continue; }
    if (conf[i] >= 0.5) out[i] = st[i] <= LIMITS.rockM ? 1 : 0;
    else out[i] = 2;
  }
  return out;
}

// small seeded PRNG (mulberry32) so a landing replay is reproducible
function rng(seed) {
  let a = seed >>> 0;
  return () => { a += 0x6d2b79f5; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (r) => { const u = Math.max(1e-12, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

/** Nearest safe cell (class wanted) to (x, y) within radius m; returns [x, y] of its centre or null. */
function nearestSafe(g, safe, x, y, radius, want = 1) {
  const [r0f, c0f] = [(g.y0 - y) / g.res - 0.5, (x - g.x0) / g.res - 0.5];
  const r0 = Math.round(r0f), c0 = Math.round(c0f), R = Math.ceil(radius / g.res);
  let best = null, bd = Infinity;
  for (let dr = -R; dr <= R; dr++) {
    const r = r0 + dr;
    if (r < 0 || r >= g.height) continue;
    for (let dc = -R; dc <= R; dc++) {
      const c = c0 + dc;
      if (c < 0 || c >= g.width) continue;
      const d = dr * dr + dc * dc;
      if (d >= bd || d > R * R) continue;
      if (safe[r * g.width + c] === want) { bd = d; best = [g.x0 + (c + 0.5) * g.res, g.y0 - (r + 0.5) * g.res]; }
    }
  }
  return best;
}

/**
 * Monte Carlo landing over a site.
 * @param T       Terrain
 * @param opts    { lander: key of LANDERS, lon, lat (ellipse centre = the guidance target), azimuthDeg (major axis,
 *                  clockwise from north; entry approach direction), n (samples), seed, safe (precomputed map) }
 * @returns { pSafe, pUnverified, pUnsafe, pOutside, samples: [{lon, lat, cls}], ellipse: [[lon, lat]...], trn, ... }
 */
export function simulateLanding(T, { lander = "m2020", lon, lat, azimuthDeg = 90, n = 2000, seed = 1, safe = null } = {}) {
  const L = LANDERS[lander] ?? LANDERS.m2020;
  const g = T.grid;
  const S = safe ?? landingSafetyMap(T);
  const [cx, cy] = lonlatToXY(lon, lat);
  const az = azimuthDeg * DEG;
  const ux = Math.sin(az), uy = Math.cos(az);          // major axis (east, north components)
  const vx = Math.cos(az), vy = -Math.sin(az);         // minor axis
  const sa = L.major / 2 / 3, sb = L.minor / 2 / 3;    // the published ellipse is the 99 % (~3 sigma) dispersion [ASSUME]
  const r = rng(seed);
  const cls = (x, y) => { const i = g.idxOfXY(x, y); return i < 0 ? -1 : S[i]; };
  let safeN = 0, unver = 0, unsafe = 0, outside = 0, diverted = 0;
  const samples = [];
  const trn = L.trn;
  for (let k = 0; k < n; k++) {
    const a = Math.max(-3, Math.min(3, gauss(r))) * sa, b = Math.max(-3, Math.min(3, gauss(r))) * sb;
    let x = cx + a * ux + b * vx, y = cy + a * uy + b * vy;
    if (trn) {
      // the vehicle's own position estimate (map-relative error), then a divert to the nearest safe target it believes
      // it can reach; the touchdown lands where the target is, plus the final touchdown error
      const ex = x + gauss(r) * trn.mapErrM / 2, ey = y + gauss(r) * trn.mapErrM / 2;   // < 40 m ~ 2 sigma [ASSUME]
      const tgt = nearestSafe(g, S, ex, ey, trn.divertM, 1) ?? nearestSafe(g, S, ex, ey, trn.divertM, 2);
      if (tgt) {
        x += tgt[0] - ex + gauss(r) * trn.touchdownErrM / 2;
        y += tgt[1] - ey + gauss(r) * trn.touchdownErrM / 2;
        diverted++;
      }
    }
    const c = cls(x, y);
    if (c === 1) safeN++; else if (c === 2) unver++; else if (c === 0) unsafe++; else outside++;
    if (samples.length < 400) { const [lo, la] = xyToLonLat(x, y); samples.push({ lon: lo, lat: la, cls: c }); }
  }
  const ellipse = [];
  for (let k = 0; k <= 72; k++) {
    const t = (k / 72) * 2 * Math.PI, a = Math.cos(t) * L.major / 2, b = Math.sin(t) * L.minor / 2;
    ellipse.push(xyToLonLat(cx + a * ux + b * vx, cy + a * uy + b * vy));
  }
  const inside = n - outside;
  return {
    lander, label: L.label, src: L.src, trn: !!trn, target: { lon, lat }, azimuthDeg, n,
    pSafe: safeN / n, pUnverified: unver / n, pUnsafe: unsafe / n, pOutside: outside / n,
    pSafeInside: inside ? safeN / inside : 0, divertFrac: diverted / n, samples, ellipse,
    majorM: L.major, minorM: L.minor,
  };
}

/** Engineering checks at the ellipse scale (the ones not captured by the per-cell safety map). */
export function ellipseChecks(T, { lander = "m2020", lon, lat, azimuthDeg = 90 } = {}) {
  const L = LANDERS[lander] ?? LANDERS.m2020;
  const g = T.grid, elev = T.f32("elev_dm");
  const [cx, cy] = lonlatToXY(lon, lat);
  const az = azimuthDeg * DEG, ux = Math.sin(az), uy = Math.cos(az), vx = Math.cos(az), vy = -Math.sin(az);
  const at = (x, y) => { const i = g.idxOfXY(x, y); return i < 0 ? NaN : elev[i]; };
  let zmax = -Infinity, reliefBad = 0, reliefN = 0, kmSlopeMax = 0, covered = 0, tot = 0;
  const A = Math.min(L.major / 2, 40000), B = Math.min(L.minor / 2, 40000);
  for (let i = -10; i <= 10; i++) for (let j = -10; j <= 10; j++) {
    const s = i / 10, t = j / 10;
    if (s * s + t * t > 1) continue;
    const x = cx + s * A * ux + t * B * vx, y = cy + s * A * uy + t * B * vy;
    tot++;
    const z = at(x, y);
    if (!Number.isFinite(z)) continue;
    covered++;
    zmax = Math.max(zmax, z);
    // relief over a 1 km baseline, both axes (radar altimetry constraint)
    for (const [dx, dy] of [[500, 0], [0, 500]]) {
      const z1 = at(x - dx, y - dy), z2 = at(x + dx, y + dy);
      if (Number.isFinite(z1) && Number.isFinite(z2)) { reliefN++; if (Math.abs(z2 - z1) > LIMITS.relief1kmM) reliefBad++; }
    }
    // slope over a 2 km baseline
    const z3 = at(x - 1000, y), z4 = at(x + 1000, y), z5 = at(x, y - 1000), z6 = at(x, y + 1000);
    if ([z3, z4, z5, z6].every(Number.isFinite)) kmSlopeMax = Math.max(kmSlopeMax, Math.atan(Math.hypot(z4 - z3, z6 - z5) / 2000) / DEG);
  }
  const checks = [
    { id: "lat", label: `Latitude within ±${LIMITS.maxAbsLat}°`, value: `${lat.toFixed(2)}°`, ok: Math.abs(lat) <= LIMITS.maxAbsLat,
      note: "EDL communications and solar power degrade poleward (MSL constraint; human missions may accept higher latitudes for ice)" },
    { id: "elev", label: `Elevation ≤ +${LIMITS.maxElevM} m (enough atmosphere to slow down)`, value: Number.isFinite(zmax) ? `${zmax.toFixed(0)} m max` : "--",
      ok: Number.isFinite(zmax) ? zmax <= LIMITS.maxElevM : null },
    { id: "relief", label: `Relief ≤ ${LIMITS.relief1kmM} m over 1 km (radar altimetry)`, value: reliefN ? `${(100 * reliefBad / reliefN).toFixed(0)} % of baselines exceed` : "--",
      ok: reliefN ? reliefBad / reliefN < 0.05 : null },
    { id: "kmslope", label: `Slope ≤ ${LIMITS.slopeKmDeg}° over 2 km`, value: `${kmSlopeMax.toFixed(1)}° max`, ok: kmSlopeMax <= LIMITS.slopeKmDeg },
    { id: "coverage", label: "Ellipse inside this site's terrain data", value: `${(100 * covered / Math.max(1, tot)).toFixed(0)} %`,
      ok: covered / Math.max(1, tot) > 0.95, note: "Larger ellipses than the site: use the Planet view to assess them" },
  ];
  return { checks, lander, label: L.label };
}

/** Best guidance target near (lon, lat): maximise the probability of a safe landing, gently preferring targets near the
 *  requested point (science access). Coarse search on a grid of candidate centres, then a full Monte Carlo on the best. */
export function optimiseTarget(T, { lander = "m2020", lon, lat, azimuthDeg = 90, searchM = 3000, stepM = 250, n = 250, seed = 7 } = {}) {
  const S = landingSafetyMap(T);
  const [cx, cy] = lonlatToXY(lon, lat);
  let best = null;
  for (let dx = -searchM; dx <= searchM; dx += stepM) for (let dy = -searchM; dy <= searchM; dy += stepM) {
    if (dx * dx + dy * dy > searchM * searchM) continue;
    const [lo, la] = xyToLonLat(cx + dx, cy + dy);
    if (T.grid.idxOfLonLat(lo, la) < 0) continue;
    const m = simulateLanding(T, { lander, lon: lo, lat: la, azimuthDeg, n, seed, safe: S });
    const score = m.pSafe + 0.5 * m.pUnverified - 0.03 * Math.hypot(dx, dy) / 1000;   // [ASSUME] 3 % per km from the wish
    if (!best || score > best.score) best = { score, lon: lo, lat: la };
  }
  if (!best) return null;
  return simulateLanding(T, { lander, lon: best.lon, lat: best.lat, azimuthDeg, n: 3000, seed: seed + 1, safe: S });
}

/** Where the hub is known to be after landing, and how well (1-sigma, m), at each localisation step. */
export function hubLocalisation(lander) {
  const L = LANDERS[lander] ?? LANDERS.m2020;
  const onboard = L.trn ? L.trn.mapErrM / 2 : Math.min(L.minor, L.major) / 6;
  return [
    { step: "onboard", label: L.trn ? "Onboard navigation at touchdown (TRN map-relative)" : "Onboard navigation + radio tracking at touchdown", sigmaM: onboard },
    { step: "orbit", label: "Orbital imaging of the landed hardware (HiRISE)", sigmaM: 1.0 },
    { step: "surface", label: "Panorama-to-orbital-map match (Mars Global Localization)", sigmaM: 0.25 },
  ];
}
