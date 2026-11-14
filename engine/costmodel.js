// costmodel.js - the factor tree (research doc 27) evaluated on real terrain.
//
// Layer A: hard vetoes, never traded against anything (slope, steps, soft soil, cliffs + position error, keep-outs,
//          planetary protection, user no-go, no data).
// Layer B: five weighted criteria, each a route total normalised by its value on the fastest route:
//   T time (speed model), S safety (weighted hazard leaves x distance), C consumables (fraction of each tank used),
//   R recoverability (return time, comms line of sight, position certainty), V science (1 - science value) x distance.
// Consumables and walkback are also *constraints* (planner.js), not only weights.

import { Grid, G_MARS } from "./geo.js";
import { ramp, clamp, distanceTransform } from "./util.js";
import { riskValue } from "./risk.js";
import { safetyLeafWeights } from "./ahp.js";
import {
  PROFILES, SUIT, MET, walkSpeedKmh, walkMetabolicW, vehicleSpeedKmh, drivePowerW, o2KgPerH, co2KgPerH, suitHeat, THERM,
} from "./physio.js";

export const VETO = {
  NONE: 0, SLOPE: 1, STEP: 2, SOFT_SOIL: 3, CLIFF: 4, KEEPOUT: 5, PLANETARY: 6, NO_DATA: 7, USER: 8,
};
export const VETO_NAMES = ["", "slope over limit", "step / boulder over limit", "soft soil (slip CVaR over 0.7)",
  "cliff edge (incl. 2-sigma position error)", "keep-out zone (hardware / samples)", "planetary-protection zone",
  "no reliable terrain data (unmapped or DEM blunder)", "user no-go zone"];

export const TERR = { FIRM: 0, SAND: 1, ROCKY: 2 };
const TERR_NAMES = ["firm", "sand", "rocky"];

/**
 * Navigation-aid scenarios (research docs 08, 19, 21). Mars has no GPS; the position error drives the cliff and
 * keep-out stand-offs (2 sigma) and the position alerts. sigmaFixM = error right after a fix; driftFrac = dead-reckoning
 * drift per metre walked; beaconLOS = a habitat radio beacon re-fixes the crew whenever it is in line of sight.
 */
export const NAV_SCENARIOS = {
  dr: { label: "Dead reckoning + landmarks", sigmaFixM: 5, driftFrac: 0.02, beaconLOS: false },
  beacon: { label: "Habitat beacon + landmarks", sigmaFixM: 5, driftFrac: 0.02, beaconLOS: true },
  constellation: { label: "Orbital nav constellation (studied, < 3 m)", sigmaFixM: 3, driftFrac: 0, beaconLOS: false },
};

export const DEFAULT_SETTINGS = {
  profile: "foot",
  risk: { kind: "cvar", alpha: 0.9, lambda: 1 },
  posModel: { sigmaFixM: 5, driftFrac: 0.02, beaconLOS: true },
  reserveFrac: 0.15, // [ASSUME] fraction of every consumable never planned against
  sunsetReserveMin: 30, // [ASSUME] crew back inside this long before sunset
  edgeMinM: { foot: 10, rover: 20, robot: 10 }, // [ASSUME] minimum stand-off from a cliff edge, before position error
  userNoGo: [], // [{lon, lat, radius_m}]
  // closed loop (research docs 31-34): what the crew and hardware actually do, learned from telemetry
  cal: { met: 1, speed: 1, water: 1, batt: 1, co2: 1, leakKgPerH: 0 }, // multipliers on the model (co2 = scrubber loading); leak is extra O2 kg/h
  // pre-EVA hardware state (fractions): suit tank fills and health, rover battery health, wheel life used
  hw: { o2Fill: 1, battSOH: 1, scrubCap: 1, waterFill: 1, roverBattSOH: 1, wheelWear: 0 },
  slipMuOverride: null, // Float32Array on the fine grid: slip field updated by rover measurements (null = map values)
  slipSdOverride: null,
};

export const DEFAULT_CAL = { met: 1, speed: 1, water: 1, batt: 1, co2: 1, leakKgPerH: 0 };
export const DEFAULT_HW = { o2Fill: 1, battSOH: 1, scrubCap: 1, waterFill: 1, roverBattSOH: 1, wheelWear: 0 };

/** Grade lookup tables so the hot loop never calls the physiology functions. */
function buildTables(profile) {
  const N = 241; // -30..+30 deg in 0.25 steps
  const grades = new Float32Array(N);
  const speed = [new Float32Array(N), new Float32Array(N), new Float32Array(N)]; // m/s by terrain class
  const power = [new Float32Array(N), new Float32Array(N), new Float32Array(N)]; // metabolic W (foot) or drive W (vehicle)
  for (let k = 0; k < N; k++) {
    const g = -30 + k * 0.25;
    grades[k] = g;
    for (let t = 0; t < 3; t++) {
      const cls = TERR_NAMES[t];
      if (profile.kind === "walk") {
        const v = walkSpeedKmh(g, cls, true);
        speed[t][k] = v / 3.6;
        power[t][k] = v > 0 ? walkMetabolicW(v, g, cls) : MET.P_REST_W;
      } else {
        const v = vehicleSpeedKmh(profile, g, cls);
        speed[t][k] = v / 3.6;
        power[t][k] = v > 0 ? drivePowerW(profile, v, g, cls) : 0;
      }
    }
  }
  return { grades, speed, power, N };
}

export function gradeIndex(gDeg) {
  const k = Math.round((gDeg + 30) * 4);
  return k < 0 ? 0 : k > 240 ? 240 : k;
}

/**
 * A plan grid: per-cell fields for one profile and one risk setting, at the fine (10 m) resolution or a coarsened one.
 */
export class PlanGrid {
  constructor(grid, n) {
    this.grid = grid;
    this.n = n;
    this.elev = new Float32Array(n);
    this.veto = new Uint8Array(n);
    this.haz = new Float32Array(n); // static composite safety hazard 0..1
    this.terr = new Uint8Array(n);
    this.sci = new Float32Array(n);
    this.sigma = new Float32Array(n); // planning position error (m, 1 sigma) at the cell
    this.hzIdx = new Int32Array(n); // index into the 40 m horizon grid
    this.los = new Uint8Array(n).fill(1); // radio line of sight to the base mast (set by fields.js)
    this.slopeW = new Float32Array(n);
    this.slip = new Float32Array(n); // risk-measure slip value
    this.speedF = null; // robotic scout only: onboard-autonomy speed factor 0..1 from local terrain clutter (AUTONAV)
  }
}

export class CostModel {
  /**
   * @param terrain Terrain
   * @param env     Environment
   * @param settings see DEFAULT_SETTINGS
   */
  constructor(terrain, env, settings = {}) {
    this.T = terrain;
    this.env = env;
    this.s = { ...DEFAULT_SETTINGS, ...settings, risk: { ...DEFAULT_SETTINGS.risk, ...(settings.risk || {}) },
      posModel: { ...DEFAULT_SETTINGS.posModel, ...(NAV_SCENARIOS[settings.nav] || {}), ...(settings.posModel || {}) },
      cal: { ...DEFAULT_CAL, ...(settings.cal || {}) }, hw: { ...DEFAULT_HW, ...(settings.hw || {}) } };
    this.profile = PROFILES[this.s.profile];
    this.mode = this.s.profile;
    this.tables = buildTables(this.profile);
    // walking tables are always needed: the walkback rule applies to rover sorties too
    this.walkTables = this.profile.kind === "walk" ? this.tables : buildTables(PROFILES.foot);
    this.leafW = safetyLeafWeights(this.mode === "foot" ? "foot" : "rover");
    this.fine = this._buildFine();
    this.coarse = this._coarsen(this.fine, 4);
  }

  /**
   * The same terrain model with new calibration factors (learned during an EVA): shares the plan grids, so a replan
   * costs only the search. Slip or hazard changes need a full rebuild instead.
   */
  recalibrated(cal = {}, hw = null) {
    const m = Object.create(CostModel.prototype);
    Object.assign(m, this);
    m.s = { ...this.s, cal: { ...this.s.cal, ...cal }, hw: hw ? { ...this.s.hw, ...hw } : this.s.hw };
    return m;
  }

  // ------------------------------------------------------------------------------------------ fine cell model --
  _buildFine() {
    const T = this.T, g = T.grid, n = g.n, P = this.profile, S = this.s, mode = this.mode;
    const pg = new PlanGrid(g, n);
    pg.factor = 1;
    const elev = T.f32("elev_dm"), slopeW = T.f32("slopeW"), step = T.f32("step"), rough = T.f32("rough");
    const sand = T.f32("sand"), cliff = T.f32("cliffDist");
    const mu = S.slipMuOverride || T.f32("slipMu"), sd = S.slipSdOverride || T.f32("slipSd");
    const lmk = T.f32("landmark"), sci = T.f32("science"), keep = T.raw.keepout;
    // keep-out distance so zones can be inflated by the position error
    const kmask = new Uint8Array(n);
    for (let i = 0; i < n; i++) kmask[i] = keep[i] & 1 ? 1 : 0; // bit 4 (unreliable DEM) is a plain no-data veto
    const kdist = distanceTransform(kmask, g.width, g.height, g.res);
    const pmask = new Uint8Array(n);
    let anyP = false;
    for (let i = 0; i < n; i++) if (keep[i] & 2) { pmask[i] = 1; anyP = true; }
    const pdist = anyP ? distanceTransform(pmask, g.width, g.height, g.res) : null;
    // user no-go circles
    const user = S.userNoGo || [];
    const userCells = user.map((z) => ({ rc: g.rcOfLonLat(z.lon, z.lat), rad: z.radius_m / g.res }));
    const slopeLim = P.slopeLimitDeg, slopeLimSand = P.slopeLimitSandDeg ?? P.slopeLimitDeg;
    const stepLim = P.stepLimitM, edgeMin = S.edgeMinM[mode] ?? 10;
    const W = this.leafW;
    const pm = S.posModel;
    const hz = T.hzGrid;
    const kHz = hz.res / g.res;
    for (let r = 0; r < g.height; r++) {
      const hr = Math.min(hz.height - 1, Math.floor(r / kHz));
      for (let c = 0; c < g.width; c++) {
        const i = r * g.width + c;
        const hc = Math.min(hz.width - 1, Math.floor(c / kHz));
        pg.hzIdx[i] = hr * hz.width + hc;
        pg.elev[i] = elev[i];
        const sw = slopeW[i], st = step[i], ro = rough[i], sa = sand[i];
        pg.slopeW[i] = sw;
        const cls = sa > 0.5 ? TERR.SAND : st > 0.3 || ro > 0.3 ? TERR.ROCKY : TERR.FIRM;
        pg.terr[i] = cls;
        // planning position error: drift accumulated walking from the nearest landmark [ASSUME model, doc 08]
        const sig = Math.min(80, pm.sigmaFixM + 2 * pm.driftFrac * lmk[i] + 5);
        pg.sigma[i] = sig;
        const slip = riskValue(mu[i], sd[i], S.risk);
        pg.slip[i] = slip;
        // ---- vetoes (first reason wins) ----
        let v = VETO.NONE;
        const lim = cls === TERR.SAND ? slopeLimSand : slopeLim;
        if (!Number.isFinite(elev[i]) || keep[i] & 4) v = VETO.NO_DATA;
        else if (kdist[i] <= 2 * sig) v = VETO.KEEPOUT;
        else if (pdist && pdist[i] <= 2 * sig) v = VETO.PLANETARY;
        else if (cliff[i] - 2 * sig < edgeMin) v = VETO.CLIFF;
        else if (sw > lim) v = VETO.SLOPE;
        else if (st > stepLim) v = VETO.STEP;
        else if (P.kind === "vehicle" && slip >= 0.7) v = VETO.SOFT_SOIL;
        if (!v && userCells.length) {
          for (const u of userCells) if ((r - u.rc[0]) ** 2 + (c - u.rc[1]) ** 2 <= u.rad * u.rad) v = VETO.USER;
        }
        pg.veto[i] = v;
        // ---- static hazard leaves ----
        const h11 = ramp(sw, 8, lim);
        const h12 = Math.max(ramp(st, 0.15, stepLim), ramp(ro, 0.1, 0.5));
        // soft ground: on foot, bedforms cost footing; on wheels, both slip risk and the bedform itself count, because
        // rippled sand traps wheels even where the slip map is mild (Opportunity at Purgatory 2005, Spirit at Troy 2009,
        // Curiosity backing out of Hidden Valley 2014). Onset at the same evidence as on foot, full at 0.8 [ASSUME]
        const h13 = P.kind === "walk" ? 0.6 * ramp(sa, 0.2, 1.0) : Math.max(ramp(slip, 0.2, 0.7), ramp(sa, 0.2, 0.8));
        const h14 = ramp(150 - (cliff[i] - 2 * sig), 0, 150 - edgeMin);
        let hz2 = 0;
        if (P.kind === "vehicle") {
          const wear = sa > 0.5 ? 0 : st > 0.4 ? 0.125 : st > 0.2 ? 1 / 13.5 : 1 / 35; // Curiosity km-to-failure [SRC]
          // worn wheels (Curiosity grouser breaks, doc 32) make rocky ground count up to 3x more
          hz2 = (W["S2.1"] || 0) * (wear / 0.125) * (1 + 2 * (S.hw.wheelWear || 0)) + (W["S2.2"] || 0) * ramp(mu[i], 0.1, 0.5);
        }
        let hz3 = 0;
        if (P.kind === "walk") {
          const h31 = 0.5 * ramp(st, 0.1, 0.6) + 0.5 * ramp(sa, 0.2, 0.9);
          const h34 = Math.min(1, ramp(sw, 10, lim) * (0.6 + 0.4 * sa) + 0.4 * ramp(st, 0.2, 0.8));
          hz3 = (W["S3.1"] || 0) * h31 + (W["S3.4"] || 0) * h34;
        }
        pg.haz[i] = (W["S1.1"] || 0) * h11 + (W["S1.2"] || 0) * h12 + (W["S1.3"] || 0) * h13 + (W["S1.4"] || 0) * h14 +
          hz2 + hz3;
        if (keep[i] & 8) pg.haz[i] += 0.15; // repaired DEM seam: real ground unknown at the join, mild avoidance
        pg.sci[i] = sci[i];
      }
    }
    pg.kdist = kdist;
    if (P.autonav) pg.speedF = this._autonavFactor(pg, P.autonav);
    this.tdW = { thermal: this.leafW["S3.2"] || 0, light: this.leafW["S4.3"] || 0 };
    return pg;
  }

  /**
   * Onboard-autonomy slowdown for a robotic scout. A rover driving itself (Perseverance's AutoNav) slows down where
   * its stereo hazard map is cluttered: JPL planned 200-250 m per sol of progress on benign ground during the 2022
   * Rapid Traverse, against under 50 m per sol through Seitah's rocks and sand (Rapid Traverse paper, JPL 2023), a
   * factor of about 4. The per-cell speed model already halves speed on rocky ground; this factor halves it again
   * where all the ground within `radiusM` is cluttered, so fully cluttered ground drives about 4x slower than firm open
   * ground. A cell's clutter is 1 if its 10 m terrain class is rocky or sandy or it is steeper than `steepDeg`;
   * otherwise it is the share of its 1 m blocks that show rock or ripple contrast in the 25 cm HiRISE orthomosaic
   * (layer "clutter", pipeline/build_clutter.py), which sees the decimetre rocks the elevation models cannot; 0 where
   * that layer has no data. Returns a per-cell multiplier 1 / (1 + clutter within radiusM).
   */
  _autonavFactor(pg, { radiusM = 50, steepDeg = 15, k = 1 } = {}) {
    const g = pg.grid, Wd = g.width, Hd = g.height, r = Math.max(1, Math.round(radiusM / g.res));
    const img = this.T.raw.clutter ? this.T.f32("clutter") : null; // raw 255 = no data (decodes above 1)
    // integral image of the clutter mask
    const S = new Float64Array((Wd + 1) * (Hd + 1));
    for (let y = 0; y < Hd; y++) {
      let row = 0;
      for (let x = 0; x < Wd; x++) {
        const i = y * Wd + x;
        row += pg.terr[i] !== TERR.FIRM || pg.slopeW[i] > steepDeg ? 1 : img && img[i] <= 1 ? img[i] : 0;
        S[(y + 1) * (Wd + 1) + x + 1] = S[y * (Wd + 1) + x + 1] + row;
      }
    }
    const f = new Float32Array(pg.n);
    for (let y = 0; y < Hd; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(Hd, y + r + 1);
      for (let x = 0; x < Wd; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(Wd, x + r + 1);
        const sum = S[y1 * (Wd + 1) + x1] - S[y0 * (Wd + 1) + x1] - S[y1 * (Wd + 1) + x0] + S[y0 * (Wd + 1) + x0];
        f[y * Wd + x] = 1 / (1 + k * sum / ((y1 - y0) * (x1 - x0)));
      }
    }
    return f;
  }

  // ------------------------------------------------------------------------------------------------- coarse --
  _coarsen(fine, f) {
    const g = fine.grid;
    const cg = new Grid({ x0: g.x0, y0: g.y0, res: g.res * f, width: Math.floor(g.width / f), height: Math.floor(g.height / f),
      name: `${g.name}_x${f}` });
    const pg = new PlanGrid(cg, cg.n);
    pg.factor = f;
    const hz = this.T.hzGrid, kHz = hz.res / cg.res;
    for (let R = 0; R < cg.height; R++) {
      for (let C = 0; C < cg.width; C++) {
        const I = R * cg.width + C;
        let nv = 0, hard = 0, sumE = 0, sumH = 0, nh = 0, sci = 0, sig = 0, sw = 0, slip = 0;
        const cnt = [0, 0, 0];
        let firstReason = 0;
        for (let dr = 0; dr < f; dr++) {
          for (let dc = 0; dc < f; dc++) {
            const i = (R * f + dr) * g.width + (C * f + dc);
            sumE += fine.elev[i];
            const v = fine.veto[i];
            if (v) {
              nv++;
              if (v === VETO.KEEPOUT || v === VETO.PLANETARY || v === VETO.NO_DATA || v === VETO.USER) hard++;
              if (!firstReason) firstReason = v;
            } else {
              sumH += fine.haz[i];
              nh++;
            }
            cnt[fine.terr[i]]++;
            sci = Math.max(sci, fine.sci[i]);
            sig = Math.max(sig, fine.sigma[i]);
            sw = Math.max(sw, fine.slopeW[i]);
            slip = Math.max(slip, fine.slip[i]);
          }
        }
        const nn = f * f;
        pg.elev[I] = sumE / nn;
        pg.veto[I] = hard > 0 || nv > nn / 2 ? firstReason : 0;
        pg.haz[I] = nh ? sumH / nh : 1;
        pg.terr[I] = cnt[1] >= cnt[0] && cnt[1] >= cnt[2] ? 1 : cnt[2] > cnt[0] ? 2 : 0;
        pg.sci[I] = sci;
        pg.sigma[I] = sig;
        pg.slopeW[I] = sw;
        pg.slip[I] = slip;
        const hr = Math.min(hz.height - 1, Math.floor(R / kHz)), hc = Math.min(hz.width - 1, Math.floor(C / kHz));
        pg.hzIdx[I] = hr * hz.width + hc;
      }
    }
    if (fine.speedF) {
      pg.speedF = new Float32Array(cg.n);
      for (let R = 0; R < cg.height; R++) for (let C = 0; C < cg.width; C++) {
        let s = 0;
        for (let dr = 0; dr < f; dr++) for (let dc = 0; dc < f; dc++) s += fine.speedF[(R * f + dr) * g.width + (C * f + dc)];
        pg.speedF[R * cg.width + C] = s / (f * f);
      }
    }
    return pg;
  }

  // ------------------------------------------------------------------------------------------- edge physics --
  /**
   * Physics of one move between adjacent (or knight-adjacent) cells of a plan grid, starting at Earth time ms.
   * Returns null if impossible. Result: { t (s), res: {o2, co2, water, batt, rbatt}, met, haz, shade, grade }.
   */
  edge(pg, u, v, d, ms, walkOnly = false) {
    const tb = walkOnly ? this.walkTables : this.tables;
    const kind = walkOnly ? "walk" : this.profile.kind;
    const dz = pg.elev[v] - pg.elev[u];
    const grade = (Math.atan2(dz, d) * 180) / Math.PI;
    const k = gradeIndex(grade);
    const cls = pg.terr[v];
    const cal = this.s.cal;
    const spd = tb.speed[cls][k] * (kind === "walk" ? cal.speed : 1) * (!walkOnly && pg.speedF ? pg.speedF[v] : 1);
    if (!(spd > 0)) return null;
    const t = d / spd;
    const env = this.env;
    const tm = ms + t * 500; // mid-edge time
    const shade = env.shadedHz(pg.hzIdx[v], tm) ? 1 : 0;
    const Tenv = env.envTempK(tm, shade);
    const sunW = shade ? 0 : env.directBeamCached(tm);
    let met, mech = 0, rbatt = 0;
    if (kind === "walk") {
      met = tb.power[cls][k] * cal.met;
      if (dz > 0) mech = ((MET.BODY_KG + MET.SUIT_KG) * G_MARS * dz) / t;
    } else {
      met = MET.P_SEATED_W;
      // wheels turn 1 / (1 - slip) times for each metre made good: slip costs drive energy as well as time
      const slipE = tb.power[cls][k] > 0 ? 1 / (1 - Math.min(0.8, pg.slip?.[v] ?? 0)) : 1;
      rbatt = ((Math.max(tb.power[cls][k], -1e9) * slipE + this.profile.auxW) * t) / 3600; // Wh (negative = regeneration)
    }
    const hb = suitHeat(met, Math.min(mech, met * MET.MUSCLE_EFF), Tenv, sunW);
    const res = {
      o2: ((o2KgPerH(met) + SUIT.leakKgPerH + cal.leakKgPerH) * t) / 3600,
      co2: (co2KgPerH(met) * t * (cal.co2 ?? 1)) / 3600,
      water: (hb.reject * t * cal.water) / (THERM.LATENT_J_PER_KG * THERM.EVAP_EFFICIENCY),
      batt: ((SUIT.baseW + hb.heat) * t * cal.batt) / 3600,
      rbatt,
    };
    // time-dependent safety leaves: thermal (cold soak in shade) and light / visibility
    const sunEl = env.sun(tm).elevation;
    const hT = shade ? ramp(270 - Tenv, 0, 70) : 0;
    const hL = (shade ? 0.6 : 0) + (sunEl < 15 ? 0.4 * ramp(15 - sunEl, 0, 15) : 0);
    const haz = 0.5 * (pg.haz[u] + pg.haz[v]) + this.tdW.thermal * hT + this.tdW.light * hL;
    return { t, res, met, haz, shade, grade, Tenv, sunEl };
  }

  /** Fraction of each tank a resource vector represents (the consumables criterion C). */
  consFrac(res) {
    const p = this.profile;
    let f = res.o2 / SUIT.o2Kg + res.co2 / SUIT.co2CapKg + res.water / SUIT.waterKg + res.batt / SUIT.batteryWh;
    if (p.kind === "vehicle" && p.batteryWh < 1e8) f += Math.max(0, res.rbatt) / p.batteryWh;
    return f;
  }

  /** Usable capacity after the reserve, per resource. */
  capacity() {
    const k = 1 - this.s.reserveFrac;
    const p = this.profile, h = this.s.hw;
    return {
      o2: SUIT.o2Kg * h.o2Fill * k, co2: SUIT.co2CapKg * h.scrubCap * k, water: SUIT.waterKg * h.waterFill * k,
      batt: SUIT.batteryWh * h.battSOH * k, rbatt: p.kind === "vehicle" ? p.batteryWh * h.roverBattSOH * k : Infinity,
    };
  }

  /** Explain the hazard at a fine cell (for the UI "why" panel). */
  explainCell(i) {
    const T = this.T, pg = this.fine;
    return {
      veto: VETO_NAMES[pg.veto[i]] || null,
      slopeW: T.get("slopeW", i), step: T.get("step", i), rough: T.get("rough", i), sand: T.get("sand", i),
      slipRisk: pg.slip[i], cliffDist: T.get("cliffDist", i), sigma: pg.sigma[i], hazard: pg.haz[i],
      terrain: TERR_NAMES[pg.terr[i]], confidence: T.get("conf", i), elevation: pg.elev[i], science: pg.sci[i],
      autonavSpeed: pg.speedF ? pg.speedF[i] : null,
      clutter: T.raw.clutter && T.get("clutter", i) <= 1 ? T.get("clutter", i) : null,
    };
  }
}
