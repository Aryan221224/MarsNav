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
