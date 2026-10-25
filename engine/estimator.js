// estimator.js - learn what the crew and the hardware are really doing from telemetry (research docs 31, 32, 34).
// Flight practice: metabolic rate from O2 tank decay and from heart rate (Apollo combined methods to 10-15 %; ISS uses
// O2 decay every 2 min and heart rate every 20 s); rover slip = 1 - visual odometry / wheel odometry (MER, MSL);
// wheel health from motor current (Spirit's failing wheel drew >2x) and wear by terrain (Curiosity km-to-failure).
// Output: calibration factors the planner uses on the next replan (costmodel `cal`), with their uncertainty.

import { o2KgPerH, SUIT } from "./physio.js";

/** Two-state Kalman filter on a slowly draining quantity: state [level, rate]. */
export class RateKF {
  constructor(level0, { rateQ = 1e-6, measR = 0.05 ** 2, rate0 = 0, rateVar0 = 1e-2 } = {}) {
    this.x = [level0, rate0];
    this.P = [[measR, 0], [0, rateVar0]];
    this.q = rateQ;
    this.r = measR;
    this.n = 0;
  }

  step(dt, z) {
    // predict
    const [l, r] = this.x;
    this.x = [l + r * dt, r];
    const P = this.P;
    const p00 = P[0][0] + dt * (P[1][0] + P[0][1]) + dt * dt * P[1][1], p01 = P[0][1] + dt * P[1][1];
    const p11 = P[1][1] + this.q * dt;
    this.P = [[p00, p01], [p01, p11]];
    if (z == null || !Number.isFinite(z)) return;
    // update on the level
    const S = this.P[0][0] + this.r, k0 = this.P[0][0] / S, k1 = this.P[1][0] / S, y = z - this.x[0];
    this.x = [this.x[0] + k0 * y, this.x[1] + k1 * y];
    const q00 = (1 - k0) * this.P[0][0], q01 = (1 - k0) * this.P[0][1], q11 = this.P[1][1] - k1 * this.P[0][1];
    this.P = [[q00, q01], [q01, q11]];
    this.n++;
  }

  get rate() { return this.x[1]; }
  get rateSd() { return Math.sqrt(Math.max(0, this.P[1][1])); }
}

/** Default per-crew heart-rate -> metabolic calibration (W = a + b * bpm) [ASSUME; NASA fits it per crew member]. */
export const HR_CAL = { a: -330, b: 5.5, sdW: 60 };

const FACTOR_BOUNDS = [0.25, 8]; // wide: a failing part (leak, dead cells, saturated bed) can be far off the model
const clampF = (v) => Math.min(FACTOR_BOUNDS[1], Math.max(FACTOR_BOUNDS[0], v));

/**
 * Closed-loop estimator. Feed it one telemetry frame at a time (normalised by telemetry.js) together with what the
 * planning model predicted for the same interval; read back calibration factors.
 */
export class Estimator {
  constructor({ capacity, hrCal = HR_CAL } = {}) {
    this.cap = capacity; // full tank amounts (kg, Wh) for % -> physical units
    this.hr = hrCal;
    this.kf = {};
    this.t = null;
    this.model = { o2: 0, water: 0, batt: 0, co2: 0, dt: 0 }; // accumulated model predictions
    this.meas = { o2: 0, water: 0, batt: 0, co2: 0 };
    this.metHist = [];
    this.fac = { met: 1, water: 1, batt: 1, co2: 1, speed: 1 };
    this.facSd = { met: 0.3, water: 0.3, batt: 0.3, co2: 0.3, speed: 0.3 };
    this.metW = null;
    this.metSd = null;
    this.speed = { planned: 0, actual: 0 };
    this.slip = { n: 0, mean: 0, last: null };
    // learned slip correction: residual (measured - map) = w . [1, sand, slope/20, sandClass], Bayesian recursive least
    // squares with a zero-mean prior (Angelova et al. 2007 / Helmick et al. 2009 learn slip from terrain features the
    // same way; MSL predicts slip per terrain class and slope, doc 32)
    this.slipReg = { w: [0, 0, 0, 0], P: [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => (i === j ? 0.3 ** 2 : 0))), r: 0.08 ** 2, n: 0 };
    this.wheel = { wearKm: 0, flagged: [] };
  }

  _kf(name, level, opts) {
    if (!this.kf[name]) this.kf[name] = new RateKF(level, opts);
    return this.kf[name];
  }

  /**
   * frame: { t (s), suit: { o2Pct, battPct, scrubPct, waterPct, hr }, walk: { plannedM, actualM },
   *          rover: { voM, wheelM, currents: [A...], terrain } }
   * model: { o2PerS, waterPerS, battPerS, co2PerS, metW } predicted by the planner model for the interval ending now
   */
  ingest(frame, model) {
    const dt = this.t == null ? 0 : frame.t - this.t;
    this.t = frame.t;
    const s = frame.suit || {};
    const R = 0.05 ** 2; // % quantisation / sensor noise [ASSUME]
    for (const [key, pct] of [["o2", s.o2Pct], ["batt", s.battPct], ["water", s.waterPct], ["co2", s.scrubPct]]) {
      if (pct == null) continue;
      const kf = this._kf(key, pct, { measR: R, rateQ: 1e-9, rateVar0: 1e-4 });
      if (dt > 0) kf.step(dt, pct);
    }
    if (dt > 0 && model) {
      for (const k of ["o2", "water", "batt", "co2"]) this.model[k] += (model[`${k}PerS`] || 0) * dt;
      this.model.dt += dt;
    }
    // --- factors: measured drain / modelled drain over the last 15 min (like with like, whatever the activity) ---
    const pctToUnit = { o2: SUIT.o2Kg / 100, water: SUIT.waterKg / 100, batt: SUIT.batteryWh / 100, co2: SUIT.co2CapKg / 100 };
    this.hist ??= [];
    this.hist.push({ t: frame.t, lvl: Object.fromEntries(Object.entries(this.kf).map(([k, f]) => [k, f.x[0]])), mod: { ...this.model } });
    const W = 900;
    while (this.hist.length > 2 && frame.t - this.hist[1].t >= W) this.hist.shift();
    const h0 = this.hist[0], h1 = this.hist[this.hist.length - 1];
    if (h1.t - h0.t >= 120) {
      for (const [k, fk] of [["o2", "met"], ["water", "water"], ["batt", "batt"], ["co2", "co2"]]) {
        if (h0.lvl[k] == null || h1.lvl[k] == null) continue;
        // 5 min of data, or 2 min once the level has moved by a full percent (a fast drain is a strong signal)
        if (h1.t - h0.t < 300 && Math.abs(h1.lvl[k] - h0.lvl[k]) < 1) continue;
        // tanks drain; the CO2 bed fills
        const used = (k === "co2" ? h1.lvl[k] - h0.lvl[k] : h0.lvl[k] - h1.lvl[k]) * pctToUnit[k];
        const modelled = h1.mod[k] - h0.mod[k];
        if (modelled <= 1e-6) continue;
        let f = used / modelled;
        if (k === "o2") f = (used - (SUIT.leakKgPerH * (h1.t - h0.t)) / 3600) / Math.max(1e-6, modelled - (SUIT.leakKgPerH * (h1.t - h0.t)) / 3600);
        f = clampF(f);
        // noise of a difference of two filtered levels (~0.05 % each) relative to the modelled drain
        const sd = Math.max(0.02, (Math.SQRT2 * 0.05 * pctToUnit[k]) / modelled);
        // the window already averages 2-15 min of data; a light 2-min smoothing only removes frame-to-frame jitter
        const a = Math.min(1, (h1.t - (this._lastFacT ?? h0.t)) / 120);
        this.fac[fk] += a * (f - this.fac[fk]);
        this.facSd[fk] = Math.max(sd, 0.5 * this.facSd[fk] + 0.5 * Math.abs(f - this.fac[fk]));
      }
      this._lastFacT = h1.t;
    }
    // --- metabolic rate: O2 channel (tank decay) fused with heart-rate channel by inverse variance ---
    let metO2 = null, sdO2 = null;
    if (this.kf.o2 && this.model.dt >= 120) {
      const kgPerH = -this.kf.o2.rate * pctToUnit.o2 * 3600 - SUIT.leakKgPerH;
      metO2 = Math.max(0, kgPerH / o2KgPerH(1)); // W
      sdO2 = Math.max(25, (this.kf.o2.rateSd * pctToUnit.o2 * 3600) / o2KgPerH(1));
    }
    let metHr = null;
    if (s.hr > 30) metHr = Math.max(0, this.hr.a + this.hr.b * s.hr);
    if (metO2 != null && metHr != null) {
      const w1 = 1 / (sdO2 * sdO2), w2 = 1 / (this.hr.sdW * this.hr.sdW);
      this.metW = (metO2 * w1 + metHr * w2) / (w1 + w2);
      this.metSd = Math.sqrt(1 / (w1 + w2));
    } else if (metO2 != null) { this.metW = metO2; this.metSd = sdO2; }
    else if (metHr != null) { this.metW = metHr; this.metSd = this.hr.sdW; }
    // --- walking speed factor: distance actually covered vs what the plan expected in the same time ---
    if (frame.walk) {
      this.speed.planned += frame.walk.plannedM || 0;
      this.speed.actual += frame.walk.actualM || 0;
      if (this.speed.planned > 150) {
        this.fac.speed = clampF(this.speed.actual / this.speed.planned);
        this.facSd.speed = Math.max(0.03, 0.3 * Math.sqrt(150 / this.speed.planned));
      }
    }
    // --- rover: slip from VO vs wheel odometry; wheel current anomaly (2x the others = Spirit's signature) ---
    const r = frame.rover;
    if (r && r.wheelM > 0.5) {
      const slip = Math.max(0, Math.min(1, 1 - r.voM / r.wheelM));
      this.slip.n++;
      this.slip.mean += (slip - this.slip.mean) / this.slip.n;
      this.slip.last = slip;
      // terrain-class slip model (MSL practice: slip is predicted per terrain class; doc 32). The residual against the
      // map's prediction tells the planner that a whole class of ground is softer (or firmer) than mapped.
      if (Number.isFinite(r.predicted) && r.features) rlsUpdate(this.slipReg, r.features, slip - r.predicted);
      const WEAR = { 0: 1 / 35, 1: 0, 2: 1 / 8 }; // km^-1 of wheel life by terrain class (Curiosity test data, doc 32)
      this.wheel.wearKm += (r.wheelM / 1000) * (WEAR[r.terrain] ?? 1 / 13.5);
      if (r.currents?.length > 2) {
        const m = r.currents.reduce((a, b) => a + b, 0) / r.currents.length;
        this.wheel.flagged = r.currents.map((c, i) => (c > 2 * ((m * r.currents.length - c) / (r.currents.length - 1)) ? i : -1)).filter((i) => i >= 0);
      }
    }
    return this.calibration();
  }

  /** Learned slip correction model (null until three slip measurements have been seen). */
  slipBias() {
    const R = this.slipReg;
    return R.n >= 3 ? { w: [...R.w], P: R.P.map((r) => [...r]), n: R.n } : null;
  }

  /** Factors for the planner (costmodel `cal`), only where enough data has been seen. */
  calibration() {
    return { met: this.fac.met, water: this.fac.water, batt: this.fac.batt, co2: this.fac.co2, speed: this.fac.speed, leakKgPerH: 0,
      sd: { ...this.facSd }, metW: this.metW, metSd: this.metSd, slip: { ...this.slip }, wheel: { ...this.wheel },
      slipBias: this.slipBias(),
      rates: Object.fromEntries(Object.entries(this.kf).map(([k, f]) => [k, f.rate * 3600])) };
  }
}

/** Terrain features for the slip model at one cell. */
export function slipFeatures(sand, slopeDeg, terrClass) {
  return [1, sand, slopeDeg / 20, terrClass === 1 ? 1 : 0];
}

/** One recursive-least-squares step (Bayesian linear regression with Gaussian noise r). */
export function rlsUpdate(R, x, y) {
  const Px = R.P.map((row) => row.reduce((a, v, j) => a + v * x[j], 0));
  const s = x.reduce((a, v, i) => a + v * Px[i], 0) + R.r;
  const K = Px.map((v) => v / s);
  const e = y - x.reduce((a, v, i) => a + v * R.w[i], 0);
  R.w = R.w.map((w, i) => w + K[i] * e);
  R.P = R.P.map((row, i) => row.map((v, j) => v - K[i] * Px[j]));
  R.n++;
  return e;
}

/**
 * Slip field for a re-plan: the map's slip corrected by the learned feature model everywhere, then sharpened near every
 * slip measurement (updateSlipField). prior: { mu, sd, sand, slope } Float32Arrays; terr: terrain class per cell.
 */
export function slipFieldFrom(prior, terr, grid, model, obs) {
  const n = prior.mu.length, mu = new Float32Array(n), sd = new Float32Array(n);
  const w = model?.w, P = model?.P;
  for (let i = 0; i < n; i++) {
    let m = prior.mu[i], v = prior.sd[i] * prior.sd[i];
    if (w) {
      const x = slipFeatures(prior.sand[i], prior.slope[i], terr[i]);
      let d = 0, q = 0;
      for (let a = 0; a < 4; a++) { d += w[a] * x[a]; for (let b = 0; b < 4; b++) q += x[a] * P[a][b] * x[b]; }
      m += d;
      v += Math.max(0, q);
    }
    mu[i] = Math.min(0.95, Math.max(0, m));
    sd[i] = Math.sqrt(v);
  }
  for (const o of obs) updateSlipField(mu, sd, grid, o.r, o.c, o.slip);
  return { mu, sd };
}

/**
 * Rover slip field update: a slip measurement at a cell pulls the slip mean of nearby cells towards it (Gaussian kernel,
 * Kalman-style gain) and narrows their spread - a local, online version of the Gaussian-process slip models (doc 32).
 * mu, sd: Float32Array on the fine grid (modified in place); returns the number of cells changed.
 */
export function updateSlipField(mu, sd, grid, r0, c0, slipObs, { radiusM = 60, measSd = 0.08 } = {}) {
  const rad = Math.ceil(radiusM / grid.res);
  let n = 0;
  for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
    const r = r0 + dr, c = c0 + dc;
    if (r < 0 || c < 0 || r >= grid.height || c >= grid.width) continue;
    const d = Math.hypot(dr, dc) * grid.res;
    if (d > radiusM) continue;
    const i = r * grid.width + c;
    const w = Math.exp(-(d * d) / (2 * (radiusM / 2) ** 2));
    const s2 = sd[i] * sd[i], R = measSd * measSd / w;
    const K = s2 / (s2 + R);
    mu[i] = mu[i] + K * (slipObs - mu[i]);
    sd[i] = Math.sqrt((1 - K) * s2);
    n++;
  }
  return n;
}
