// marstime.js - Mars time and Sun position, implementing NASA GISS "Mars24" algorithm
// (Allison & McEwen 2000, Planet. Space Sci. 48, 215; https://www.giss.nasa.gov/tools/mars24/help/algorithm.html).
// Validated in validation/ against Perseverance MEDA ancillary data (LMST, LTST, Ls and solar zenith angle).

import { DEG } from "./geo.js";

// TAI - UTC leap seconds (IERS), start dates in ms since epoch.
const LEAPS = [
  ["1972-01-01", 10], ["1972-07-01", 11], ["1973-01-01", 12], ["1974-01-01", 13], ["1975-01-01", 14],
  ["1976-01-01", 15], ["1977-01-01", 16], ["1978-01-01", 17], ["1979-01-01", 18], ["1980-01-01", 19],
  ["1981-07-01", 20], ["1982-07-01", 21], ["1983-07-01", 22], ["1985-07-01", 23], ["1988-01-01", 24],
  ["1990-01-01", 25], ["1991-01-01", 26], ["1992-07-01", 27], ["1993-07-01", 28], ["1994-07-01", 29],
  ["1996-01-01", 30], ["1997-07-01", 31], ["1999-01-01", 32], ["2006-01-01", 33], ["2009-01-01", 34],
  ["2012-07-01", 35], ["2015-07-01", 36], ["2017-01-01", 37],
].map(([d, s]) => [Date.parse(d + "T00:00:00Z"), s]);

export function ttMinusUtc(ms) {
  let s = 10;
  for (const [t, v] of LEAPS) if (ms >= t) s = v;
  return s + 32.184;
}

const PBS = [
  [0.0071, 2.2353, 49.409], [0.0057, 2.7543, 168.173], [0.0039, 1.1177, 191.837], [0.0037, 15.7866, 21.736],
  [0.0021, 2.1354, 15.704], [0.0020, 2.4694, 95.528], [0.0018, 32.8493, 49.095],
];

const mod = (a, n) => ((a % n) + n) % n;

/** Julian Date (TT) from JS milliseconds since 1970 UTC. */
export function jdTT(ms) {
  return 2440587.5 + ms / 8.64e7 + ttMinusUtc(ms) / 86400;
}

/** Mars Sol Date from JD(TT). */
export function msdFromJdTT(jd) {
  return (jd - 2451549.5) / 1.0274912517 + 44796.0 - 0.0009626;
}

export function jdTTFromMsd(msd) {
  return (msd - 44796.0 + 0.0009626) * 1.0274912517 + 2451549.5;
}

/** Inverse of jdTT (to ~1 ms; leap-second edge cases ignored). */
export function msFromJdTT(jd) {
  let ms = (jd - 2440587.5) * 8.64e7;
  ms -= ttMinusUtc(ms) * 1000;
  return ms;
}

/**
 * Full Mars24 state for a JD(TT).
 * Returns Ls, EOT, MTC (hours), subsolar longitude (east), solar declination, heliocentric distance.
 */
export function marsState(jd) {
  const dt = jd - 2451545.0;
  const M = mod(19.3871 + 0.52402073 * dt, 360);
  const alphaFMS = mod(270.3871 + 0.524038496 * dt, 360);
  let pbs = 0;
  for (const [A, tau, phi] of PBS) pbs += A * Math.cos(DEG * ((0.985626 * dt) / tau + phi));
  const Mr = M * DEG;
  const nuM =
    (10.691 + 3.0e-7 * dt) * Math.sin(Mr) + 0.623 * Math.sin(2 * Mr) + 0.05 * Math.sin(3 * Mr) +
    0.005 * Math.sin(4 * Mr) + 0.0005 * Math.sin(5 * Mr) + pbs;
  const Ls = mod(alphaFMS + nuM, 360);
  const Lr = Ls * DEG;
  const EOT = 2.861 * Math.sin(2 * Lr) - 0.071 * Math.sin(4 * Lr) + 0.002 * Math.sin(6 * Lr) - nuM; // deg
  const msd = msdFromJdTT(jd);
  const MTC = mod(24 * msd, 24); // hours
  const subsolarLonWest = mod(MTC * 15 + EOT + 180, 360);
  const subsolarLonEast = mod(360 - subsolarLonWest, 360);
  const decl = Math.asin(0.42565 * Math.sin(Lr)) / DEG + 0.25 * Math.sin(Lr);
  const rAU = 1.52367934 * (1.00436 - 0.09309 * Math.cos(Mr) - 0.004336 * Math.cos(2 * Mr) -
    0.00031 * Math.cos(3 * Mr) - 0.00003 * Math.cos(4 * Mr));
  return { jd, msd, M, Ls, EOT, MTC, subsolarLonEast, decl, rAU };
}

export function lmstHours(state, lonEast) {
  return mod(state.MTC + lonEast / 15, 24);
}

export function ltstHours(state, lonEast) {
  return mod(state.MTC + lonEast / 15 + state.EOT / 15, 24);
}

/** Sun elevation / azimuth (deg; azimuth clockwise from north) and zenith angle at (lonEast, lat). */
export function sunPosition(state, lonEast, lat) {
  const H = (lonEast - state.subsolarLonEast) * DEG; // local hour angle (0 at true noon)
  const d = state.decl * DEG, p = lat * DEG;
  const sinEl = Math.sin(p) * Math.sin(d) + Math.cos(p) * Math.cos(d) * Math.cos(H);
  const el = Math.asin(Math.max(-1, Math.min(1, sinEl)));
  const az = Math.atan2(-Math.cos(d) * Math.sin(H), Math.cos(p) * Math.sin(d) - Math.sin(p) * Math.cos(d) * Math.cos(H));
  return { elevation: el / DEG, zenith: 90 - el / DEG, azimuth: mod(az / DEG, 360) };
}

/** Top-of-atmosphere solar irradiance at Mars (W/m^2), from the 1361 W/m^2 solar constant at 1 AU. */
export function solarConstant(state) {
  return 1361 / (state.rAU * state.rAU);
}

// ---------------------------------------------------------------------------------------------------------------------
// Mission sols. Mars 2020 counts sols in LMST at the landing longitude; sol 0 = landing sol (18 Feb 2021).
// SOL0_MSD_M2020 is the integer local MSD of sol 0 at 77.45088572 E. It is derived from the landing time
// (2021-02-18T20:43:48Z UTC, spacecraft event time) and checked against every MEDA sample in validation/.
export const M2020 = { lonEast: 77.45088572, lat: 18.44462715, landingUTC: "2021-02-18T20:43:48Z" };

export function localMsd(msd, lonEast) {
  return msd + lonEast / 360;
}

export const SOL0_MSD_M2020 = Math.floor(
  localMsd(msdFromJdTT(jdTT(Date.parse(M2020.landingUTC))), M2020.lonEast),
);

export function m2020SolFromMs(ms) {
  const lm = localMsd(msdFromJdTT(jdTT(ms)), M2020.lonEast);
  return { sol: Math.floor(lm) - SOL0_MSD_M2020, lmstHours: mod(lm, 1) * 24 };
}

/** Earth time (ms) for a Mars 2020 sol and LMST (hours at the landing longitude). */
export function msFromM2020Sol(sol, lmstH) {
  const lm = SOL0_MSD_M2020 + sol + lmstH / 24;
  const msd = lm - M2020.lonEast / 360;
  return msFromJdTT(jdTTFromMsd(msd));
}

/**
 * A mission calendar: sols counted in LMST at a reference longitude, sol 0 = the landing sol. M2020 is one instance;
 * a crewed mission defines its own from its landing time and site (sites/<id>.json "clock").
 */
export function missionClock({ name = "M2020", landing_utc = M2020.landingUTC, lon_east = M2020.lonEast } = {}) {
  const sol0 = Math.floor(localMsd(msdFromJdTT(jdTT(Date.parse(landing_utc))), lon_east));
  return {
    name, lonEast: lon_east, landingUTC: landing_utc, sol0,
    solFromMs(ms) {
      const lm = localMsd(msdFromJdTT(jdTT(ms)), lon_east);
      return { sol: Math.floor(lm) - sol0, lmstHours: mod(lm, 1) * 24 };
    },
    msFromSol(sol, lmstH) {
      return msFromJdTT(jdTTFromMsd(sol0 + sol + lmstH / 24 - lon_east / 360));
    },
  };
}

export const M2020_CLOCK = missionClock();

/** Convenience: full context for a time at a site. */
export function marsContext(ms, lonEast, lat, clock = M2020_CLOCK) {
  const st = marsState(jdTT(ms));
  const sun = sunPosition(st, lonEast, lat);
  const m = clock.solFromMs(ms);
  return {
    ms, Ls: st.Ls, lmst: lmstHours(st, lonEast), ltst: ltstHours(st, lonEast), sun, solarConstant: solarConstant(st),
    sol: m.sol, clockName: clock.name, m2020Sol: m2020SolFromMs(ms).sol, marsYear: marsYear(st.msd, st.Ls), state: st,
  };
}

/** Mars Year numbering (Clancy et al.): MY 1 began at Ls 0 on 11 April 1955. Approximate by MSD. */
export function marsYear(msd, Ls) {
  // MY 1 Ls=0 at MSD ~ 28892.7 (1955-04-11, where marsState's Ls passes 0); a Mars year is 668.5991 sols.
  const my = Math.floor((msd - 28892.7) / 668.5991 + 1 + 1e-9);
  // correct around Ls 0 boundary
  const frac = mod((msd - 28892.7) / 668.5991, 1);
  if (frac < 0.02 && Ls > 300) return my - 1;
  if (frac > 0.98 && Ls < 60) return my + 1;
  return my;
}

export function fmtHours(h) {
  const t = Math.round(mod(h, 24) * 3600);
  const hh = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = t % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Earth-Mars distance and one-way light time, from JPL's "Keplerian Elements for Approximate Positions of the Major
// Planets" (Standish; Table 1, valid 1800-2050): heliocentric ecliptic J2000 positions of the Earth-Moon barycentre and
// Mars. Accuracy is a few thousand km in position, far below a second of light time. Research doc 01: 4 to 24 min.
const KEPLER = {
  earth: [1.00000261, 0.00000562, 0.01671123, -0.00004392, -0.00001531, -0.01294668, 100.46457166, 35999.37244981,
    102.93768193, 0.32327364, 0.0, 0.0],
  mars: [1.52371034, 0.00001847, 0.0933941, 0.00007882, 1.84969142, -0.00813131, -4.55343205, 19140.30268499,
    -23.94362959, 0.44441088, 49.55953891, -0.29257343],
};

function heliocentric(el, T) {
  const D = Math.PI / 180;
  const a = el[0] + el[1] * T, e = el[2] + el[3] * T, I = (el[4] + el[5] * T) * D;
  const L = el[6] + el[7] * T, varpi = el[8] + el[9] * T, Om = el[10] + el[11] * T;
  const w = (varpi - Om) * D, O = Om * D;
  let M = (((L - varpi) % 360) + 540) % 360 - 180;
  M *= D;
  let E = M + e * Math.sin(M);
  for (let k = 0; k < 8; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(O), sO = Math.sin(O), cI = Math.cos(I), sI = Math.sin(I);
  return [(cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
    (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
    sw * sI * xp + cw * sI * yp];
}

/** Earth-Mars distance (AU) and one-way light time (s) at a UTC time (ms). */
export function earthMarsLight(ms) {
  const T = (jdTT(ms) - 2451545.0) / 36525;
  const e = heliocentric(KEPLER.earth, T), m = heliocentric(KEPLER.mars, T);
  const au = Math.hypot(m[0] - e[0], m[1] - e[1], m[2] - e[2]);
  return { au, lightS: (au * 149597870.7) / 299792.458 };
}
