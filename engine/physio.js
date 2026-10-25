// physio.js - how fast crew and vehicles move, what it costs them, and how long the consumables last.
// Every constant is tagged: [SRC] from a source read during research (docs 03, 11-13 of the research set),
// [CALIB] fitted to one sourced point, [ASSUME] engineering assumption (change as data arrives), [PHYS] physics.

import { G_MARS, G_EARTH, DEG } from "./geo.js";

// ------------------------------------------------------------------------------------------------ walking speed --
export const WALK = {
  APOLLO_SHORT_KMH: 3.6, // [SRC] Apollo planning speed, walks < 1 h
  APOLLO_LONG_KMH: 2.7, // [SRC] Apollo planning speed, walks > 1 h
  SLOPE_POINTS: [[0, 1.0], [7.5, 0.5], [15, 0.14]], // [SRC] Apollo 14 plan / Apollo 15 Station 6 (lunar regolith)
  SLOPE_LIMIT_DEG: 20, // [SRC] NASA lunar EVA traverse tool excludes slopes beyond +-20 deg
  LEVEL_COST_RATIO_MARS: 0.5, // [SRC-ish] review: external work at Mars g about half of Earth's
  TERRAIN: { firm: 1.0, sand: 0.7, rocky: 0.5 }, // [ASSUME] multipliers on the Apollo regolith behaviour
};

function footing(slopeAbs) {
  const pts = WALK.SLOPE_POINTS;
  if (slopeAbs <= pts[pts.length - 1][0]) {
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      if (slopeAbs <= x1) {
        const t = (slopeAbs - x0) / (x1 - x0);
        return Math.exp(Math.log(y0) + t * (Math.log(y1) - Math.log(y0)));
      }
    }
  }
  const [x0, y0] = pts[pts.length - 2], [x1, y1] = pts[pts.length - 1];
  return Math.exp(Math.log(y1) + ((slopeAbs - x1) * (Math.log(y1) - Math.log(y0))) / (x1 - x0));
}

/** Minetti et al. 2002 net cost of walking on Earth, J/(kg m), gradient i = rise/run, valid |i| <= 0.45. */
export function minettiCost(i) {
  i = Math.max(-0.45, Math.min(0.45, i));
  return 280.5 * i ** 5 - 58.7 * i ** 4 - 76.8 * i ** 3 + 51.9 * i ** 2 + 19.6 * i + 2.5;
}

/** Net walking cost on Mars, J/(kg m): level part scaled by LEVEL_COST_RATIO, gradient part by g ratio. */
export function marsWalkCost(gradeDeg) {
  const i = Math.tan(gradeDeg * DEG);
  const c0 = WALK.LEVEL_COST_RATIO_MARS * minettiCost(0);
  return Math.max(0.35 * c0, c0 + (G_MARS / G_EARTH) * (minettiCost(i) - minettiCost(0)));
}

/**
 * Suited walking speed (km/h) on a grade (signed, deg; + uphill) and terrain class.
 * The slower of a footing limit (Apollo) and a constant-metabolic-power limit; 0 beyond the slope limit.
 */
export function walkSpeedKmh(gradeDeg, terrain = "firm", longWalk = true) {
  const s = Math.abs(gradeDeg);
  if (s > WALK.SLOPE_LIMIT_DEG) return 0;
  const base = longWalk ? WALK.APOLLO_LONG_KMH : WALK.APOLLO_SHORT_KMH;
  const c0 = marsWalkCost(0);
  const met = Math.min(1.1, Math.max(0.05, c0 / marsWalkCost(gradeDeg)));
  return base * Math.min(met, footing(s)) * (WALK.TERRAIN[terrain] ?? 1);
}

// --------------------------------------------------------------------------------------------- vehicle speed ----
export const VEH = {
  CRR_LOOSE: 0.15, // [CALIB] makes the Apollo LRV power-limited at 13 km/h with eta 0.8
  ETA: 0.8, // [ASSUME]
  MU_BRAKE: 0.35, // [ASSUME]
  SIGHT_M: 15, // [ASSUME]
  TRACTION_MARS: 0.925, // [SRC] parabolic flight: traction 5-10 % lower at Mars g
  AVG_TO_MAX: 0.65, // [SRC-derived] Apollo LRV average/design speed 0.60-0.70
  LRV_DESIGN_KMH: 13, LRV_WHEEL_R: 0.409, G_MOON: 1.62,
};

export function vehicleVmaxKmh(v, gradeDeg) {
  const th = gradeDeg * DEG;
  const resist = VEH.CRR_LOOSE * Math.cos(th) + Math.sin(th);
  const vPower = resist > 0 ? ((VEH.ETA * v.powerW) / (v.massKg * G_MARS * resist)) * 3.6 : Infinity;
  const vRide = VEH.LRV_DESIGN_KMH * Math.sqrt((G_MARS / VEH.G_MOON) * (v.wheelR / VEH.LRV_WHEEL_R));
  const vBrake = 3.6 * Math.sqrt(2 * VEH.MU_BRAKE * VEH.TRACTION_MARS * G_MARS * VEH.SIGHT_M);
  return Math.min(vPower, vRide, vBrake, v.designKmh);
}

export function vehicleSpeedKmh(v, gradeDeg, terrain = "firm") {
  if (Math.abs(gradeDeg) > (terrain === "sand" ? v.slopeLimitSandDeg : v.slopeLimitDeg)) return 0;
  const f = terrain === "sand" ? 0.6 : terrain === "rocky" ? 0.5 : 1.0; // [ASSUME] hazard-avoidance slowdown
  return vehicleVmaxKmh(v, gradeDeg) * VEH.AVG_TO_MAX * f;
}

/**
 * Motion resistance by ground class, relative to the loose regolith the Apollo LRV calibration describes [ASSUME within
 * published ranges: loose sand costs 1.5-2x the motion resistance of compacted soil through sinkage and bulldozing
 * (Bekker/Wong terramechanics); on rocky ground a rover climbs, straddles and steers round obstacles, which planetary
 * rover drive logs put at 20-50 % more energy per metre]. Wheel slip adds on top (energy per metre / (1 - slip)).
 */
export const ROLL = { firm: 1.0, sand: 1.6, rocky: 1.35 };

/**
 * Relative wheel damage per km by ground class, from Curiosity's wheel-wear tests (km to failure 35 on benign ground,
 * 13.5 on rocky, 8 on very rocky; sand does not tear treads; research doc 32). A vehicle's own design life on benign
 * ground (profile.wheelLifeKm) sets the scale.
 */
export const WHEEL_DAMAGE = { firm: 1, sand: 0, rocky: 35 / 13.5, veryRocky: 35 / 8 };

/** Electrical drive power (W) to hold a speed on a grade and ground class; aero drag negligible at Mars. Can be negative downhill. */
export function drivePowerW(v, speedKmh, gradeDeg, terrain = "firm") {
  const th = gradeDeg * DEG;
  const p = (v.massKg * G_MARS * (VEH.CRR_LOOSE * (ROLL[terrain] ?? 1) * Math.cos(th) + Math.sin(th)) * (speedKmh / 3.6)) / VEH.ETA;
  return p < 0 ? p * v.regenEff : p;
}

// ------------------------------------------------------------------------------------------ metabolic model -------
export const MET = {
  BODY_KG: 80, // [ASSUME] crew member
  SUIT_KG: 104, // [SRC] Mars suit mass cap (NASA mass-requirement paper, doc 03)
  SUIT_INEFFICIENCY: 1.3, // [ASSUME] suited vs unsuited walking cost (joint torques); NASA TP-2010-216115 shows suited > unsuited
  P_REST_W: 120, // [ASSUME] standing / light work in a pressurised suit
  P_WORK_W: 250, // [ASSUME] average during station work (sampling, instrument deployment)
  P_SEATED_W: 110, // [ASSUME] riding an unpressurised rover in a suit
  MUSCLE_EFF: 0.2, // [PHYS] ~20 % of metabolic power becomes external mechanical work when climbing
  O2_KJ_PER_L: 20.1, // [PHYS] energy equivalent of O2 at RQ ~0.85
  O2_G_PER_L: 1.429, // [PHYS] O2 density at STP
  RQ: 0.85, // [PHYS] respiratory quotient
};

/** Metabolic power (W) while walking at speed v (km/h) on a signed grade (deg). */
export function walkMetabolicW(speedKmh, gradeDeg, terrain = "firm") {
  const m = MET.BODY_KG + MET.SUIT_KG;
  const terr = terrain === "sand" ? 1.35 : terrain === "rocky" ? 1.2 : 1.0; // [ASSUME] extra cost in loose sand / boulders
  return MET.P_REST_W + m * marsWalkCost(gradeDeg) * (speedKmh / 3.6) * MET.SUIT_INEFFICIENCY * terr;
}

export function o2KgPerH(metW) {
  return ((metW * 3600) / (MET.O2_KJ_PER_L * 1000)) * MET.O2_G_PER_L / 1000;
}

export function co2KgPerH(metW) {
  return o2KgPerH(metW) * MET.RQ * (44 / 32);
}

// --------------------------------------------------------------------------------------------- suit thermal -------
export const THERM = {
  UA_W_PER_K: 1.2, // [ASSUME] overall suit insulation conductance at Mars pressure (MLI does not work above 1 Torr, doc 03)
  T_INSIDE_K: 295, // [PHYS] comfortable suit interior
  SOLAR_ABS_AREA: 0.12, // [ASSUME] absorptivity 0.2 x projected area 0.6 m^2
  LATENT_J_PER_KG: 2.45e6, // [PHYS] water evaporation
  EVAP_EFFICIENCY: 0.9, // [ASSUME]
};

/**
 * Suit heat balance (W). Positive `reject` must be removed by the evaporator (water);
 * positive `heat` must be supplied electrically (battery). `sunW` = direct solar W/m^2 reaching the suit (0 in shade).
 */
export function suitHeat(metW, mechW, envTempK, sunW) {
  const gain = metW - mechW + THERM.SOLAR_ABS_AREA * sunW;
  const loss = THERM.UA_W_PER_K * (THERM.T_INSIDE_K - envTempK);
  const net = gain - loss;
  return net >= 0 ? { reject: net, heat: 0 } : { reject: 0, heat: -net };
}

// ------------------------------------------------------------------------------------------------ profiles -------
/** Suit consumables (usable, above the reserve that is never planned against). */
export const SUIT = {
  o2Kg: 0.6, // [ASSUME] usable primary O2 (EMU heritage about 0.54 kg; Mars PLSS two 3,000 psia loops, doc 03)
  waterKg: 4.5, // [ASSUME] feedwater (EMU heritage about 4.5 kg)
  co2CapKg: 1.2, // [ASSUME] CO2 removal capacity (LiOH-class 2.9 kg canister, doc 03)
  batteryWh: 450, // [ASSUME] EMU heritage about 26.6 Ah x 16.8 V
  baseW: 70, // [ASSUME] PLSS fans, pump, radio, display
  leakKgPerH: 0.005, // [ASSUME] suit leakage
  maxEvaH: 8, // [SRC] EVA length 2 to 8 h (doc 03)
};

export const PROFILES = {
  foot: {
    id: "foot", label: "Suited walk", kind: "walk",
    slopeLimitDeg: 20, // [SRC] human slope limit (NASA lunar traverse tool)
    stepLimitM: 0.8, // [ASSUME] ledge a suited person should not attempt
    radioMastM: 1.8,
  },
  rover: {
    id: "rover", label: "Unpressurised crew rover", kind: "vehicle",
    massKg: 1500, wheelR: 0.45, powerW: 3000, designKmh: 14.5, // [ASSUME]/[SRC] doc 12
    slopeLimitDeg: 25, slopeLimitSandDeg: 12, // [SRC] rover limits (one study, doc 09)
    stepLimitM: 0.35, // [ASSUME] ground clearance of an LTV-class rover
    batteryWh: 20000, // [ASSUME]
    auxW: 400, // [ASSUME] avionics, thermal, comms
    regenEff: 0.3, // [ASSUME]
    walkbackRequired: true, // NASA walkback rule: crew must be able to walk home if the rover fails
    wheelLifeKm: 500, // [ASSUME] benign-ground design life of crewed-rover tyres (Apollo LRV wire-mesh wheels were qualified for 180 km)
    radioMastM: 2.5,
  },
  robot: {
    id: "robot", label: "Robotic scout (Perseverance-class)", kind: "vehicle",
    massKg: 1025, wheelR: 0.2625, powerW: 110, designKmh: 0.152, // [SRC] Perseverance 1,025 kg, 152 m/h top speed
    slopeLimitDeg: 30, slopeLimitSandDeg: 15, // [SRC] MER avoided >30 deg; [ASSUME] sand
    stepLimitM: 0.35, // [SRC-ish] Perseverance clearance ~0.6 m; rocks < 0.35 m driveable
    batteryWh: 1e9, auxW: 0, regenEff: 0, walkbackRequired: false, radioMastM: 2.2,
    wheelLifeKm: 35, // [SRC] Curiosity-class aluminium wheels, benign ground
    autonav: { radiusM: 50, steepDeg: 15, k: 1 }, // drives itself: slows in cluttered terrain (costmodel.js _autonavFactor)
  },
};

/** Per-second consumable burn for a suited crew member at metabolic W with electrical heater load H. */
export function suitBurnPerS(metW, heaterW, rejectW) {
  return {
    o2: (o2KgPerH(metW) + SUIT.leakKgPerH) / 3600,
    co2: co2KgPerH(metW) / 3600,
    water: rejectW / (THERM.LATENT_J_PER_KG * THERM.EVAP_EFFICIENCY),
    batt: (SUIT.baseW + heaterW) / 3600,
  };
}
