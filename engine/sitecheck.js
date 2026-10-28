// sitecheck.js - site-level suit feasibility and exposure checks that no route choice can change.
// Research docs 03, 06 and 26: the first Mars suit's evaporative cooling assumes a site pressure at or below
// 7 to 8 Torr (NASA suit paper); the surface dose measured by Curiosity RAD averages about 0.64 mSv per day.

import { marsState, jdTT, ltstHours } from "./marstime.js";

export const SUIT_COOLING_LIMIT_PA = 1000; // 7.5 Torr, middle of the 7-8 Torr design assumption [SRC doc 03]
export const SURFACE_DOSE_MSV_PER_DAY = 0.64; // Curiosity RAD surface average [SRC doc 02/26]

/**
 * Highest and lowest air pressure over the operations area across a whole Mars year (Ls in 10 deg steps, LTST in
 * 1 h steps), from the site climatology with the hydrostatic elevation term.
 */
export function pressureEnvelope(env, T) {
  const e = T.f32("elev_dm");
  let zMin = Infinity, zMax = -Infinity;
  for (let i = 0; i < e.length; i += 7) if (Number.isFinite(e[i])) { zMin = Math.min(zMin, e[i]); zMax = Math.max(zMax, e[i]); }
  let pMax = -Infinity, pMin = Infinity;
  for (let Ls = 0; Ls < 360; Ls += 10) for (let h = 0; h < 24; h += 1) {
    pMax = Math.max(pMax, env.pressurePa(h, Ls, zMin));
    pMin = Math.min(pMin, env.pressurePa(h, Ls, zMax));
  }
  return { pMaxPa: pMax, pMinPa: pMin, zMin, zMax, limitPa: SUIT_COOLING_LIMIT_PA, coolingOK: pMax <= SUIT_COOLING_LIMIT_PA };
}

/** Pressure at a time and elevation, with its margin to the cooling limit. */
export function pressureAt(env, ms, lonEast, elevM) {
  const st = marsState(jdTT(ms));
  const p = env.pressurePa(ltstHours(st, lonEast), st.Ls, elevM);
  return { pa: p, torr: p / 133.322, marginPa: SUIT_COOLING_LIMIT_PA - p };
}

/** Dose for a stay of `seconds` on the surface at the RAD average (no storm, no shelter credit). */
export function evaDoseMSv(seconds) {
  return (SURFACE_DOSE_MSV_PER_DAY * seconds) / 86400;
}

// Galactic cosmic rays by altitude: more air overhead, less dose. RAD at Gale (Bradbury, MOLA -4501 m) measured
// 0.210 mGy/day and 0.64 mSv/day (Hassler et al. 2014); the dose falls with surface pressure at
// kappa = -(0.28 - 2.9e-4 Phi) uGy/day/Pa for solar modulation Phi in MV (Guo et al., doi:10.1002/2016JE005206).
// Measured between about 700 and 950 Pa; outside 600-1100 Pa the value is flagged as an extrapolation. Pressure from
// elevation as in the Landing-mode dossier: 610 Pa at the datum, 11.1 km scale height. Same model as planet/atlas.py.
export const RAD_GALE_UGY_PER_DAY = 210; // [SRC Hassler et al. 2014, Science 343]
const RAD_GALE_ELEV_M = -4501;
const RAD_Q = SURFACE_DOSE_MSV_PER_DAY / (RAD_GALE_UGY_PER_DAY / 1000);
export const SOLAR_MODULATION_MV = 600; // [ASSUME] RAD-era range 400-700 MV

const pressureFromElev = (elevM) => 610 * Math.exp(-elevM / 11100);

/** Cosmic-ray dose rate on the surface at an elevation. */
export function gcrDoseRate(elevM, phiMV = SOLAR_MODULATION_MV) {
  const p = pressureFromElev(elevM);
  const kappa = -(0.28 - 2.9e-4 * phiMV);
  const uGyDay = Math.max(0, RAD_GALE_UGY_PER_DAY + kappa * (p - pressureFromElev(RAD_GALE_ELEV_M)));
  return { uGyDay, mSvDay: (uGyDay * RAD_Q) / 1000, pressurePa: p, extrapolated: p < 600 || p > 1100 };
}

/** Dose along a planned route: each step at the dose rate of its own elevation (pts carry t in s and elev in m). */
export function routeDoseMSv(pts, phiMV = SOLAR_MODULATION_MV) {
  if (!pts?.length || pts.some((p) => !Number.isFinite(p.elev))) return null;
  let d = 0;
  for (let k = 0; k + 1 < pts.length; k++) d += (gcrDoseRate(pts[k].elev, phiMV).mSvDay * Math.max(0, pts[k + 1].t - pts[k].t)) / 86400;
  return d;
}
