// task.js - what the crew says they will do at a station, and what it costs.
// The crew (or the science team) states, per station: how long the work takes, how hard it is, and any consumables it
// draws beyond breathing and cooling (tool and instrument energy from the suit battery, an O2 purge, water for sample
// handling). The planner then budgets the whole out-and-back EVA with that work in it, the walkback margins are checked
// after it, and during the EVA the closed loop compares the telemetry with this stated model.

import { MET, SUIT, THERM, o2KgPerH, co2KgPerH, suitHeat } from "./physio.js";

/**
 * Work-intensity presets. Metabolic rates in the suit [SRC ranges: Apollo lunar EVA averages 234-270 W with peaks over
 * 500 W while drilling and trenching; ISS EVAs average ~250 W; research doc 12]. Values are [ASSUME] points inside them.
 */
export const TASK_PRESETS = {
  survey: { label: "Light: imaging, observation, contact science", workW: 200 },
  sampling: { label: "Moderate: sampling, instrument set-up", workW: MET.P_WORK_W },
  heavy: { label: "Heavy: drilling, trenching, hauling", workW: 400 },
};

/** The stated task of a stop, with defaults (a stop with nothing stated is moderate work, no extras). */
export function taskOf(stop = {}) {
  const preset = TASK_PRESETS[stop.task] || TASK_PRESETS.sampling;
  return {
    task: TASK_PRESETS[stop.task] ? stop.task : "sampling",
    workW: Number.isFinite(stop.workW) && stop.workW > 0 ? stop.workW : preset.workW,
    toolWh: Math.max(0, +stop.toolWh || 0), // from the suit battery over the stated work time
    extraO2Kg: Math.max(0, +stop.extraO2g || 0) / 1000,
    extraWaterKg: Math.max(0, +stop.extraWaterG || 0) / 1000,
    statedMin: stop.dwell0 ?? stop.dwell_min ?? 0, // extras are stated for this much work; a shortened station uses a share
  };
}

/**
 * Consumables of workS seconds of station work at time ms. cal = model calibration (costmodel s.cal); env = Environment;
 * shade = 0/1 at the station. Returns totals { o2, co2, water, batt, rbatt, metW, heatW }.
 */
export function stationWork(stop, workS, cal, env, ms, shade, vehicleAuxW = 0) {
  const k = taskOf(stop);
  const pw = k.workW * (cal.met ?? 1);
  const hb = suitHeat(pw, 0, env.envTempK(ms, shade), shade ? 0 : env.directBeam(ms));
  const share = k.statedMin > 0 ? Math.min(1, workS / (k.statedMin * 60)) : 1;
  return {
    o2: ((o2KgPerH(pw) + SUIT.leakKgPerH + (cal.leakKgPerH ?? 0)) * workS) / 3600 + k.extraO2Kg * share,
    co2: (co2KgPerH(pw) * workS * (cal.co2 ?? 1)) / 3600,
    water: (hb.reject * workS * (cal.water ?? 1)) / (THERM.LATENT_J_PER_KG * THERM.EVAP_EFFICIENCY) + k.extraWaterKg * share,
    batt: (((SUIT.baseW + hb.heat) * workS) / 3600) * (cal.batt ?? 1) + k.toolWh * share * (cal.batt ?? 1),
    rbatt: (vehicleAuxW * workS) / 3600,
    metW: pw,
  };
}
