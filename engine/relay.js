// relay.js - when the Mars relay orbiters are overhead: the link a hub uses to send EVA data to Earth and to receive
// the next day's plan. Each orbiter is flown from its published orbit (two-body Kepler orbit with the J2 drift of the
// node and of the periapsis; a sun-synchronous orbit keeps its node at a fixed local solar time) over many sols, and a
// pass is counted while it is at least `maskDeg` above the site's horizon.
//
// What this is: a coverage model. Pass rates, pass lengths and, for the sun-synchronous orbiters, the local times of
// the passes are properties of the orbit and come out right. The exact pass times on a given sol depend on where each
// spacecraft is in its orbit that day (published only as navigation ephemerides): they are not predicted here.
//
// Orbits [SRC]:
//   MRO      255 x 320 km, frozen periapsis over the south pole, ~93 deg, sun-synchronous, ascending node 3:00 pm LMST
//            (PDS MRO mission catalogue; JPL navigation: "3:00 PM +/- 15 minutes")
//   Odyssey  ~400 km, 93.1 deg, sun-synchronous; node moved to about 6 am / 6 pm in 2014 (The Planetary Society)
//            [ASSUME: still there; the exact time has drifted and propellant is nearly used up in 2026]
//   TGO      near-circular ~400 km, 74 deg, 2 h period, not sun-synchronous (ESA)
//   MEX      330 x 10,530 km, 86.9 deg, 7.0 h (ESA fact sheet)
// MAVEN is not used: contact was lost in December 2025 (planet/data/missions.json).

const MU = 42828.37;                 // km^3/s^2, Mars GM
const RM = 3396.19;                  // km, equatorial radius (the data's sphere)
const J2 = 1.96045e-3;
const W_MARS = (2 * Math.PI) / 88642.663;          // rad/s, sidereal rotation
const N_SUN = (2 * Math.PI) / (686.98 * 86400);     // rad/s, mean motion of the Sun in Mars's sky
const SOL_S = 88775.244;
const DEG = Math.PI / 180;

export const RELAY_ORBITERS = [
  { id: "mro", name: "MRO", long: "Mars Reconnaissance Orbiter (NASA)", periAltKm: 255, apoAltKm: 320, incDeg: 93.0, argPeriDeg: 270,
    frozen: true, sunSync: true, nodeLmstH: 15.0, src: "PDS MRO mission catalogue; JPL navigation (ascending node 3:00 pm +/- 15 min LMST)" },
  { id: "odyssey", name: "Odyssey", long: "2001 Mars Odyssey (NASA)", periAltKm: 400, apoAltKm: 400, incDeg: 93.1, argPeriDeg: 0,
    frozen: true, sunSync: true, nodeLmstH: 18.0, uncertain: true,
    src: "PDS Odyssey catalogue (400 km, 93.1 deg); node near 6 pm / 6 am since 2014 [ASSUME]; propellant nearly used up (2026)" },
  { id: "tgo", name: "TGO", long: "ExoMars Trace Gas Orbiter (ESA)", periAltKm: 400, apoAltKm: 400, incDeg: 74.0, argPeriDeg: 0,
    frozen: false, sunSync: false, src: "ESA: near-circular ~400 km, 74 deg, 2 h" },
  { id: "mex", name: "MEX", long: "Mars Express (ESA)", periAltKm: 330, apoAltKm: 10530, incDeg: 86.9, argPeriDeg: 0,
    frozen: false, sunSync: false, src: "ESA fact sheet: 330 x 10,530 km, 86.9 deg, 7.0 h" },
];

function elements(o) {
  const rp = RM + o.periAltKm, ra = RM + o.apoAltKm, a = (rp + ra) / 2, e = (ra - rp) / (ra + rp);
  const n = Math.sqrt(MU / a ** 3), p = a * (1 - e * e), i = o.incDeg * DEG;
  const k = 1.5 * n * J2 * (RM / p) ** 2;
  return { a, e, n, i, nodeRate: -k * Math.cos(i), periRate: o.frozen ? 0 : 0.5 * k * (5 * Math.cos(i) ** 2 - 1), periodS: (2 * Math.PI) / n };
}

function kepler(M, e) {
  let E = e < 0.8 ? M : Math.PI;
  for (let k = 0; k < 30; k++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return E;
}

// deterministic pseudo-random numbers (repeatable results for tests and reports)
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}

/**
 * Fly one orbiter over a site for `sols` sols and list its passes.
 * The frame is Mars-centred and inertial; t = 0 is local noon at the site; the mean Sun moves at N_SUN.
 * Returns [{t0, t1, durS, maxElDeg, lmst0, lmstMid}] with LMST in hours at the site.
 */
export function flyOrbiter(o, latDeg, { sols = 30, stepS = 15, maskDeg = 10, seed = 1 } = {}) {
  const el = elements(o), r = rng(seed);
  const M0 = 2 * Math.PI * r();
  const node0 = o.sunSync ? (o.nodeLmstH - 12) * 15 * DEG : 2 * Math.PI * r();
  const peri0 = o.argPeriDeg * DEG + (o.frozen ? 0 : 2 * Math.PI * r());
  const cl = Math.cos(latDeg * DEG), sl = Math.sin(latDeg * DEG), sinMask = Math.sin(maskDeg * DEG);
  const ci = Math.cos(el.i), si = Math.sin(el.i);
  const passes = [];
  let cur = null;
  const T = sols * SOL_S;
  for (let t = 0; t <= T; t += stepS) {
    // satellite: perifocal -> inertial (node, inclination, argument of periapsis)
    const E = kepler((M0 + el.n * t) % (2 * Math.PI), el.e);
    const xp = el.a * (Math.cos(E) - el.e), yp = el.a * Math.sqrt(1 - el.e * el.e) * Math.sin(E);
    const W = (o.sunSync ? node0 + N_SUN * t : node0 + el.nodeRate * t), w = peri0 + el.periRate * t;
    const cw = Math.cos(w), sw = Math.sin(w), cW = Math.cos(W), sW = Math.sin(W);
    const x1 = cw * xp - sw * yp, y1 = sw * xp + cw * yp;          // in the orbital plane, from the node
    const sx = cW * x1 - sW * ci * y1, sy = sW * x1 + cW * ci * y1, sz = si * y1;
    // site: local noon at t = 0 (its meridian faces the mean Sun), turning with Mars
    const th = (W_MARS - 0) * t;                                    // site inertial longitude relative to the noon meridian
    const lamSun = N_SUN * t;                                       // mean Sun right ascension (0 at t = 0)
    const lam = th;
    const ux = cl * Math.cos(lam), uy = cl * Math.sin(lam), uz = sl;
    const dx = sx - RM * ux, dy = sy - RM * uy, dz = sz - RM * uz;
    const d = Math.hypot(dx, dy, dz);
    const sinEl = (dx * ux + dy * uy + dz * uz) / d;
    const lmst = (((12 + (lam - lamSun) / DEG / 15) % 24) + 24) % 24;
    if (sinEl >= sinMask) {
      const e = Math.asin(sinEl) / DEG;
      if (!cur) cur = { t0: t, lmst0: lmst, maxElDeg: e };
      cur.t1 = t; cur.maxElDeg = Math.max(cur.maxElDeg, e); cur.lmst1 = lmst;
    } else if (cur) {
      passes.push(cur); cur = null;
    }
  }
  if (cur) passes.push(cur);
  for (const p of passes) {
    p.durS = p.t1 - p.t0 + stepS;
    const mid = p.lmst0 + ((((p.lmst1 - p.lmst0) % 24) + 24) % 24) / 2;
    p.lmstMid = mid % 24;
  }
  return passes;
}

// clusters of pass mid-times on the 24 h circle (sun-synchronous orbits pass at the same local times each sol)
function windows(passes) {
  if (!passes.length) return [];
  const hs = passes.map((p) => p.lmstMid).sort((a, b) => a - b);
  // split the circle at its largest gap, then cut wherever two passes are more than 2 h apart
  let gi = 0, gmax = -1;
  for (let k = 0; k < hs.length; k++) {
    const g = ((hs[(k + 1) % hs.length] - hs[k]) % 24 + 24) % 24 || 24;
    if (g > gmax) { gmax = g; gi = k; }
  }
  const ring = hs.slice(gi + 1).concat(hs.slice(0, gi + 1).map((h) => h + 24));
  const out = [];
  let grp = [ring[0]];
  for (let k = 1; k < ring.length; k++) {
    if (ring[k] - ring[k - 1] > 2) { out.push(grp); grp = []; }
    grp.push(ring[k]);
  }
  out.push(grp);
  const q = (a, f) => a[Math.min(a.length - 1, Math.max(0, Math.round(f * (a.length - 1))))];
  return out.filter((g) => g.length >= 3 && g.length / hs.length >= 0.1)
    .map((g) => ({ fromH: q(g, 0.05) % 24, toH: q(g, 0.95) % 24, centreH: q(g, 0.5) % 24, share: g.length / hs.length }));
}

/**
 * Relay coverage at a latitude: for each orbiter, passes per sol, minutes per sol, pass lengths, the share of sols
 * with at least one pass and, for sun-synchronous orbiters, the local-time windows the passes fall in.
 * Longitude does not matter for these averages. Runs `runs` independent starts (orbit phase and node) of `sols` sols.
 */
export function relayCoverage(latDeg, { maskDeg = 10, sols = 24, runs = 3, stepS = 15, orbiters = RELAY_ORBITERS } = {}) {
  const out = [];
  for (const o of orbiters) {
    const all = [];
    let solsWith = 0, nSols = 0;
    for (let k = 0; k < runs; k++) {
      const ps = flyOrbiter(o, latDeg, { sols, stepS, maskDeg, seed: 1 + 7919 * k + o.id.length * 131 });
      all.push(...ps);
      for (let s = 0; s < sols; s++) { nSols++; if (ps.some((p) => p.t0 < (s + 1) * SOL_S && p.t1 >= s * SOL_S)) solsWith++; }
    }
    const solsTot = sols * runs, durs = all.map((p) => p.durS / 60).sort((a, b) => a - b);
    const el = elements(o);
    out.push({
      id: o.id, name: o.name, long: o.long, src: o.src, uncertain: !!o.uncertain, sunSync: o.sunSync,
      periodMin: el.periodS / 60,
      passesPerSol: all.length / solsTot,
      minutesPerSol: durs.reduce((a, b) => a + b, 0) / solsTot,
      meanPassMin: durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : 0,
      maxPassMin: durs.length ? durs[durs.length - 1] : 0,
      solsWithPass: solsWith / nSols,
      // near the poles a polar orbiter passes on almost every orbit: there is no window, it is overhead all sol
      windows: !o.sunSync ? [] : all.length / solsTot > 6 ? [{ allDay: true }] : windows(all),
    });
  }
  const total = out.reduce((a, o) => a + o.minutesPerSol, 0);
  return { latDeg, maskDeg, orbiters: out, minutesPerSol: total, passesPerSol: out.reduce((a, o) => a + o.passesPerSol, 0),
    note: "Modelled from published orbits; pass rates and the local times of sun-synchronous passes are properties of the orbit, the exact "
      + "times on a given sol are not (they need the spacecraft ephemerides)." };
}

/** Format an LMST hour as hh:mm. */
export const hhmm = (h) => { const m = Math.round((((h % 24) + 24) % 24) * 60); return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
