// sim.js - Execute mode as a closed loop (research docs 31-34).
// The simulator holds a hidden "truth" (how hard the crew really works, how fast they really walk, how the battery
// really drains, how soft the ground really is). It flies the EVA with that truth and emits only what hardware would:
// TSS-format suit telemetry, IMU heading and step length, sun / landmark / beacon / constellation fixes, and rover
// wheel and visual odometry. Everything the crew and the software see comes from those measurements:
//   navigation EKF (nav.js) -> estimated position and error ellipse
//   estimators (estimator.js) -> learned metabolic, water, battery and speed factors; rover slip field
//   monitor + replanner (replan.js) -> a new plan from the current state when the forecast breaks a limit
//   caution & warning (alerts.js) -> NASA-style alerts, automatic walk home on critical faults

import { evaluateRules, AlertManager, LEVEL } from "./alerts.js";
import { procedureFor } from "./procedures.js";
import { walkbackPath } from "./fields.js";
import { lineCells } from "./util.js";
import { VETO_NAMES } from "./costmodel.js";
import { MET, SUIT, THERM, o2KgPerH, co2KgPerH, suitHeat } from "./physio.js";
import { xyToLonLat, lonlatToXY } from "./geo.js";
import { NavFilter } from "./nav.js";
import { Estimator, HR_CAL, slipFieldFrom, slipFeatures } from "./estimator.js";
import { tssFrameFromSim, parseTSS } from "./telemetry.js";
import { replanFrom } from "./replan.js";
import { stationWork } from "./task.js";

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Hidden-truth scenarios for demonstrating the loop [ASSUME magnitudes, chosen to be realistic]. */
export const TRUTH_SCENARIOS = {
  nominal: { label: "Crew and hardware as modelled", met: 1, speed: 1, water: 1, batt: 1, leakKgPerH: 0, slipAdd: 0 },
  hardwork: { label: "Crew working 35 % harder than modelled", met: 1.35, speed: 1, water: 1.25, batt: 1, leakKgPerH: 0, slipAdd: 0 },
  slow: { label: "Rough going: walking 25 % slower", met: 1.1, speed: 0.75, water: 1.05, batt: 1, leakKgPerH: 0, slipAdd: 0 },
  battery: { label: "Suit battery drains 40 % faster (aged cells)", met: 1, speed: 1, water: 1, batt: 1.4, leakKgPerH: 0, slipAdd: 0 },
  softground: { label: "Ground softer than mapped (rover slip)", met: 1, speed: 1, water: 1, batt: 1, leakKgPerH: 0, slipAdd: 0.35 },
};

const FRAME_S = 10; // telemetry frame period in simulated seconds (TSS updates at 1 Hz)

export class EvaSim {
  /**
   * @param planner Planner (holds model, fields, time limits)
   * @param sortie  result of planner.planSortie (legs with fine cells)
   * @param opts    { seed, truth (key or object), stops: [{lon,lat,name,dwell_min,value,kind}], autoReplan, ctx (replan context) }
   */
  constructor(planner, sortie, { seed = 7, truth = "nominal", stops = null, autoReplan = true, ctx = null } = {}) {
    this.P = planner;
    this.P0 = planner;
    this.m = planner.m;
    this.g = this.m.fine.grid;
    this.rand = rng(seed);
    this.alerts = new AlertManager();
    this.faults = {};
    this.truth = typeof truth === "string" ? { ...TRUTH_SCENARIOS[truth] } : { ...TRUTH_SCENARIOS.nominal, ...truth };
    this.autoReplan = autoReplan;
    // re-plans score routes against the same reference scales as the original plan, so costs before and after stay
    // comparable (a re-plan must not look cheaper just because its normalisation moved)
    this.ctx = ctx || { model0: planner.m, base: planner.base, departMs: planner.departMs, evaMaxS: planner.evaMaxS, rescue: planner.rescue,
      refs: sortie.refs || null, weights: sortie.W || null, end: sortie.endAt ?? "base" };
    // stations are every leg destination except the habitat (a one-way sortie ends at a station, not at the base)
    this.stops = (stops || sortie.legs.map((l) => l.to).filter((s) => !s.isBase && !s.isEnd)).map((s) => ({ ...s, dwell0: s.dwell_min, done: false }));
    this.planVersion = 1;
    this.plans = [{ v: 1, t: 0, reason: "initial plan", pts: sortie.pts.map((p) => [p.lon, p.lat]) }];
    this._loadRoute(sortie);
    this.t = 0;
    this.res = { o2: 0, co2: 0, water: 0, batt: 0, rbatt: 0 }; // true consumption (hidden)
    this.dist = 0;
    this.track = [];
    this.returning = false;
    this.done = false;
    this.cur = this.route[0]?.u ?? planner.baseFine;
    this.events = [];
    this.pins = [];
    this.losLostSince = null;
    // navigation: truth heading bias walks slowly; the EKF only sees IMU heading, step length and fixes
    const [bx, by] = lonlatToXY(planner.base.lon, planner.base.lat);
    this.basePos = [bx, by];
    const kind = this.m.profile.kind === "vehicle" ? "rover" : "suit";
    this.nav = new NavFilter(bx, by, { kind, sigma0: this.m.s.posModel.sigmaFixM });
    this.navNoise = this.nav.p;
    this.trueBias = 0;
    this.lastSun = -1e9;
    this.lastBeacon = -1e9;
    this.lastConst = -1e9;
    this.sinceLmk = 1e9;
    this.sigma = this.nav.ellipse().sigma;
    this.err = [0, 0];
    // telemetry and estimation
    this.est = new Estimator({ capacity: planner.cap });
    this.hrCal = HR_CAL;
    this.frameT = 0;
    this.modelAcc = { o2: 0, water: 0, batt: 0, co2: 0 };
    this.walkAcc = { plannedM: 0, actualM: 0 };
    this.roverAcc = { voM: 0, wheelM: 0 };
    this.lastFrame = null;
    this.cal = this.est.calibration();
    this.lastReplanT = -1e9;
    this.planCal = { met: 1, water: 1, batt: 1, co2: 1, speed: 1 }; // learned factors the current plan already uses
    this.replans = [];
    this.slipObs = []; // rover slip measurements { r, c, slip } since departure
    this.metTrueW = MET.P_REST_W;
  }

  _loadRoute(sortie) {
    this.route = [];
    for (const leg of sortie.legs) {
      const pts = leg.ev.pts;
      for (let k = 0; k + 1 < leg.cells.length; k++) this.route.push({ u: leg.cells[k], v: leg.cells[k + 1] });
      if ((leg.to.dwell_min || 0) > 0 && !leg.to.isBase) {
        this.route.push({ work: leg.to.dwell_min * 60, at: leg.cells[leg.cells.length - 1], name: leg.to.name,
          steps: procedureFor(leg.to), stop: leg.to });
      }
      void pts;
    }
    this.k = 0;
    this.segT = 0;
    this.sortie = sortie;
  }

  /** Crew pin (SUITS "pin dropping"): current estimated position, its error and a note. */
  pin(note = "") {
    const s = this.snapshot();
    const p = { t: this.t, lon: s.lon, lat: s.lat, sigma: this.sigma, note };
    this.pins.push(p);
    this.events.push({ t: this.t, event: `pin dropped${note ? `: ${note}` : ""} (+/-${Math.round(2 * this.sigma)} m)` });
    return p;
  }

  /** Crew-commanded abort: the rest of the plan becomes the walkback route home. */
  abort(reason = "crew abort") {
    this.startReturn(reason);
  }

  inject(kind) {
    this.faults[kind] = true;
    this.events.push({ t: this.t, event: `fault: ${kind}` });
    if (kind === "rover" || kind === "leak" || kind === "spe") this.startReturn(`fault: ${kind}`);
  }

  speedFactor() {
    let f = this.truth.speed;
    if (this.faults.injury) f *= 0.5;
    if (this.faults.dust) f *= 0.85;
    return f;
  }

  /** Replace the rest of the plan with the walkback route from the current cell. */
  startReturn(reason) {
    if (this.returning) return;
    this.returning = true;
    this.events.push({ t: this.t, event: `return initiated: ${reason}` });
    const P = this.P, fg = this.g, cf = P.field, cg = cf.pg.grid;
    const [r, c] = fg.rc(this.cur);
    const f = cf.pg.factor;
    const ci = Math.min(cg.height - 1, Math.floor(r / f)) * cg.width + Math.min(cg.width - 1, Math.floor(c / f));
    const coarse = walkbackPath(cf, ci);
    const cells = [this.cur];
    for (let q = 1; q < coarse.length; q++) {
      const [R, C] = cg.rc(coarse[q]);
      const [lr, lc] = fg.rc(cells[cells.length - 1]);
      const pts = lineCells(lr, lc, R * f + f / 2, C * f + f / 2);
      for (let s = 2; s < pts.length; s += 2) {
        const i = fg.idx(Math.min(fg.height - 1, pts[s]), Math.min(fg.width - 1, pts[s + 1]));
        cells.push(i);
      }
    }
    cells.push(P.baseFine);
    this.route = [];
    for (let k = 0; k + 1 < cells.length; k++) if (cells[k] !== cells[k + 1]) this.route.push({ u: cells[k], v: cells[k + 1], ret: true });
    this.k = 0;
    this.segT = 0;
    this.returnCells = cells;
  }

  // ------------------------------------------------------------------------------------------ physics step --
  _burn(seg, ms) {
    const m = this.m, g = this.g, env = m.env, T = this.truth;
    if (seg.work) {
      const shade = env.shadedHz(m.fine.hzIdx[seg.at], ms) ? 1 : 0;
      // the stated task (work intensity, tool energy, extra consumables) is the model; the hidden truth scales it
      const w = stationWork(seg.stop, seg.work, m.s.cal, env, ms, shade);
      const model = { o2: w.o2 / seg.work, co2: w.co2 / seg.work, water: w.water / seg.work, batt: w.batt / seg.work, rbatt: 0 };
      return { dur: seg.work, model, met: w.metW, metT: (w.metW / m.s.cal.met) * T.met, d: 0 };
    }
    const [r0, c0] = g.rc(seg.u), [r1, c1] = g.rc(seg.v);
    const d = Math.hypot(r1 - r0, c1 - c0) * g.res;
    const walkOnly = seg.ret && m.profile.kind === "vehicle" && this.faults.rover;
    const e = m.edge(m.fine, seg.u, seg.v, d, ms, walkOnly) || m.edge(m.fine, seg.u, seg.v, d, ms, true);
    if (!e) return null;
    const model = {};
    for (const key of Object.keys(e.res)) model[key] = e.res[key] / e.t;
    // rover: extra slip on soft ground slows progress (wheel turns that do not move the rover)
    let slipExtra = 0;
    if (m.profile.kind === "vehicle" && !walkOnly && T.slipAdd > 0) slipExtra = Math.min(0.9, T.slipAdd * m.T.get("sand", seg.v) * 2 + (m.fine.terr[seg.v] === 1 ? T.slipAdd : 0));
    const slipMap = m.profile.kind === "vehicle" ? m.T.get("slipMu", seg.v) : 0; // what the orbital map predicts here
    // truth is absolute; the model already carries the pre-EVA calibration (cal), so scale by truth / cal
    const pace = this.speedFactor() / (walkOnly || m.profile.kind === "walk" ? m.s.cal.speed : 1);
    return { dur: e.t / (pace * (1 - slipExtra)), durModel: e.t, model, met: e.met, metT: (e.met / m.s.cal.met) * T.met, d, slipExtra, slipMap };
  }

  /** Advance the simulation by dt seconds of mission time; returns a snapshot. */
  step(dt) {
    if (this.done) return this.snapshot();
    const T = this.truth;
    let left = dt;
    while (left > 0 && this.k < this.route.length) {
      const seg = this.route[this.k];
      const ms = this.P.departMs + this.t * 1000;
      const b = seg._b || (seg._b = this._burn(seg, ms));
      if (!b) { this.k++; continue; }
      const use = Math.min(left, b.dur - this.segT, FRAME_S - (this.t - this.frameT) + 1e-9);
      // true burn: the model rates scaled by hidden truth relative to the model's calibration (and faults)
      const C = this.m.s.cal, metRatio = T.met / C.met;
      const tr = {
        o2: (b.model.o2 - (SUIT.leakKgPerH + C.leakKgPerH) / 3600) * metRatio + (SUIT.leakKgPerH + T.leakKgPerH) / 3600 + (this.faults.leak ? 0.25 / 3600 : 0),
        co2: b.model.co2 * metRatio * ((T.co2 ?? 1) / (C.co2 ?? 1)), water: b.model.water * (T.water / C.water) * (this.faults.cooling ? 1.8 : 1),
        batt: b.model.batt * (T.batt / C.batt), rbatt: (b.model.rbatt || 0),
      };
      // real time passes at the true pace; the model expected the same distance to take b.durModel
      const frac = use / b.dur;
      for (const key of Object.keys(this.res)) this.res[key] += (tr[key] || 0) * use;
      // what the plan's model predicts for the same activity over the same real time (rates per second): the ratio is
      // the metabolic / water / battery factor; the pace is learned separately from distance covered
      for (const k of ["o2", "water", "batt", "co2"]) this.modelAcc[k] += (b.model[k] || 0) * use;
      this.metTrueW = b.metT;
      this.segT += use;
      this.t += use;
      left -= use;
      if (!seg.work && b.d) {
        const dd = b.d * frac;
        this.dist += dd;
        this.walkAcc.plannedM += (use / (b.durModel ?? b.dur)) * b.d; // distance the model expected in this time
        this.walkAcc.actualM += dd;
        if (this.m.profile.kind === "vehicle") {
          // wheel odometry counts the turns; visual odometry the ground actually covered (true slip = map + extra)
          const slipTrue = Math.min(0.95, (b.slipMap || 0) + (b.slipExtra || 0));
          this.roverAcc.wheelM += dd / Math.max(0.05, 1 - slipTrue);
          this.roverAcc.voM += dd;
          this.roverAcc.predD = (this.roverAcc.predD || 0) + (b.slipMap || 0) * dd;
          this.roverAcc.d = (this.roverAcc.d || 0) + dd;
          const x = slipFeatures(this.m.T.get("sand", seg.v), this.m.T.get("slopeW", seg.v), this.m.fine.terr[seg.v]);
          this.roverAcc.feat = (this.roverAcc.feat || [0, 0, 0, 0]).map((v, q) => v + x[q] * dd);
        }
        this._navStep(seg, dd, use);
      }
      if (this.segT >= b.dur - 1e-9) {
        this.cur = seg.work ? seg.at : seg.v;
        if (seg.work) {
          this.events.push({ t: this.t, event: `station complete: ${seg.name}` });
          const st = this.stops.find((s) => s.name === seg.name && !s.done);
          if (st) { st.done = true; st.frac = Math.min(1, seg.work / 60 / (st.dwell0 || seg.work / 60)); }
        }
        this.k++;
        this.segT = 0;
      }
      if (this.t - this.frameT >= FRAME_S - 1e-6) this._telemetryTick();
    }
    if (this.k >= this.route.length) {
      this.done = true;
      this.events.push({ t: this.t, event: this.returning ? "back at habitat (contingency return)" : "EVA complete" });
    }
    const snap = this.snapshot();
    const raised = this.alerts.update(evaluateRules(snap.ruleState), this.t);
    snap.raised = raised;
    snap.alerts = this.alerts.list();
    snap.counts = this.alerts.counts();
    snap.master = this.alerts.master();
    if (!this.returning && raised.some((a) => a.level === LEVEL.WARNING && ["pnr", "sunset", "spe", "leak", "rover"].includes(a.id))) {
      this.startReturn(raised[0].text);
    }
    this.track.push({ t: this.t, cur: this.cur, sigma: this.sigma, err: [...this.err], res: { ...this.res } });
    return snap;
  }

  // ------------------------------------------------------------------------------------------ navigation --
  _navStep(seg, dd, dtUse) {
    const g = this.g, m = this.m, N = this.navNoise;
    const [r0, c0] = g.rc(seg.u), [r1, c1] = g.rc(seg.v);
    const trueHeading = (Math.atan2(c1 - c0, -(r1 - r0)) * 180) / Math.PI; // clockwise from north
    this.trueBias += ((this.rand() - 0.5) * 2 * N.biasDriftDegPerH * Math.sqrt(dtUse / 3600) * Math.PI) / 180;
    const gauss = () => (this.rand() + this.rand() + this.rand() + this.rand() - 2) * 1.732;
    const measHeading = trueHeading + (this.trueBias * 180) / Math.PI + gauss() * N.headingNoiseDeg * 0.3;
    const measD = dd * (1 + gauss() * N.distFrac * 0.5);
    this.nav.propagate(measD, measHeading, dtUse);
    this.sinceLmk += dd;
    // truth position (cell centre of the next cell, interpolated)
    const f = Math.min(1, this.segT / Math.max(1e-6, seg._b.dur));
    const [xa, ya] = g.cellXY(r0, c0), [xb, yb] = g.cellXY(r1, c1);
    const tx = xa + (xb - xa) * f, ty = ya + (yb - ya) * f;
    this.truePos = [tx, ty];
    const lmk = m.T.get("landmark", seg.v), los = m.fine.los[seg.v];
    // map match on a distinctive landmark (MGL-style), once per landmark pass
    if (lmk <= 150 && this.sinceLmk > 100) {
      if (this.nav.fixPosition(tx + gauss() * N.mapFixM, ty + gauss() * N.mapFixM, N.mapFixM, "landmark map match")) {
        this.events.push({ t: this.t, event: "position fix: landmark map match" });
      }
      this.sinceLmk = 0;
    }
    // habitat beacon two-way range, every 60 s in line of sight
    if (m.s.posModel.beaconLOS && los && this.t - this.lastBeacon >= 60) {
      const [bx, by] = this.basePos;
      this.nav.fixRange(bx, by, Math.hypot(tx - bx, ty - by) + gauss() * N.beaconRangeM);
      this.lastBeacon = this.t;
    }
    // orbital navigation constellation (future scenario): a position fix every 60 s
    if (m.s.posModel.driftFrac === 0 && this.t - this.lastConst >= 60) {
      this.nav.fixPosition(tx + gauss() * 3, ty + gauss() * 3, 3, "constellation");
      this.lastConst = this.t;
    }
    // sun heading every 10 min with the Sun up
    if (this.t - this.lastSun >= 600 && m.env.sun(this.P.departMs + this.t * 1000).elevation > 5) {
      this.nav.fixHeading(measHeading, trueHeading + gauss() * N.sunSigmaDeg);
      this.lastSun = this.t;
    }
    if (los) this.losLostSince = null;
    else if (this.losLostSince == null) this.losLostSince = this.t;
    const [ex, ey] = this.nav.pos;
    this.err = [ex - tx, ey - ty];
    this.sigma = this.nav.ellipse().sigma;
  }

  // ------------------------------------------------------------------------------- telemetry and the loop --
  _telemetryTick() {
    const dt = this.t - this.frameT;
    this.frameT = this.t;
    const pos = this.nav.pos;
    const tss = tssFrameFromSim({ t: this.t, used: this.res, hw: this.m.s.hw, metW: this.metTrueW, hrCal: this.hrCal,
      pos: { x: pos[0] - this.basePos[0], y: pos[1] - this.basePos[1] }, heading: 0, rand: this.rand, faults: this.faults });
    const frame = parseTSS(tss);
    this.lastSuit = frame.suit;
    frame.walk = { ...this.walkAcc };
    if (this.m.profile.kind === "vehicle" && this.roverAcc.wheelM > 0) {
      const A = this.roverAcc, D = Math.max(1e-6, A.d);
      // VO carries ~2 % noise on a short baseline [ASSUME]
      const vo = A.voM * (1 + (this.rand() + this.rand() + this.rand() - 1.5) * 0.04);
      frame.rover = { voM: vo, wheelM: A.wheelM, predicted: A.predD / D, features: A.feat.map((v) => v / D) };
    }
    const model = {};
    for (const k of ["o2", "water", "batt", "co2"]) model[`${k}PerS`] = this.modelAcc[k] / Math.max(1e-6, dt);
    this.cal = this.est.ingest(frame, model);
    this.lastFrame = tss;
    // rover slip: update the slip field near the rover, MER-style slip check
    if (frame.rover && frame.rover.wheelM > 5) {
      const slip = Math.max(0, 1 - frame.rover.voM / frame.rover.wheelM);
      const [r, c] = this.g.rc(this.cur);
      this.slipObs.push({ r, c, slip });
      if (this.slipObs.length > 400) this.slipObs.shift();
      this.lastSlip = slip;
      // MER/MSL slip check: stop and re-plan when slip is over the limit and more than the current model expects
      const expect = this._modelSlip(this.cur, frame.rover);
      if (slip > 0.4 && slip - expect > 0.2) this._maybeReplan(`slip check: measured ${(100 * slip).toFixed(0)} % (limit 40 %, model ${(100 * expect).toFixed(0)} %)`, true);
    }
    this.modelAcc = { o2: 0, water: 0, batt: 0, co2: 0 };
    this.walkAcc = { plannedM: 0, actualM: 0 };
    this.roverAcc = { voM: 0, wheelM: 0 };
    this._monitor();
  }

  /** Forecast the rest of the plan with the learned rates; re-plan when a limit would break. */
  _monitor() {
    if (this.returning || this.done || !this.autoReplan) return;
    const c = this.cal, cap = this.P.cap, used = this._usedMeasured(), sd = c.sd || {};
    const KEYS = ["o2", "co2", "water", "batt"], FAC = { o2: "met", co2: "co2", water: "water", batt: "batt" };
    const rem = this._remainingModel();
    // forecast = used so far + the rest of the plan at the learned rates; walking takes longer at the learned pace,
    // station work takes the time it takes; the suit's baseline leak does not scale with how hard the crew works
    const forecast = (fac, speed) => {
      const sp = Math.max(0.3, speed), out = {};
      for (const k of KEYS) out[k] = used[k] + (rem.walk[k] / sp + (rem[k] - rem.walk[k])) * fac[k];
      out.o2 -= (rem.walk.leak / sp + (rem.leak - rem.walk.leak)) * (fac.o2 - 1);
      out.t = this.t + rem.walk.t / sp + (rem.t - rem.walk.t);
      return out;
    };
    const f = Object.fromEntries(KEYS.map((k) => [k, c[FAC[k]] ?? c.met]));
    const fore = forecast(f, c.speed);
    // the same forecast with every factor 2 sigma kinder: a breach even then is certain, not an estimation wobble
    const fLo = Object.fromEntries(KEYS.map((k) => [k, Math.max(0.25, f[k] - 2 * (sd[FAC[k]] ?? 0.3))]));
    const foreLo = forecast(fLo, c.speed + 2 * (sd.speed ?? 0.3));
    const over = KEYS.filter((k) => fore[k] > cap[k] * 0.99), sure = KEYS.filter((k) => foreLo[k] > cap[k] * 0.99);
    const late = fore.t > this.P.timeEndS, lateSure = foreLo.t > this.P.timeEndS;
    // decide at the last responsible moment: an uncertain breach waits for better estimates unless the walkback
    // margin is already thin or the crew is about to start station work the forecast says they cannot afford
    let urgentNow = false;
    if ((over.length || late) && !(sure.length || lateSure)) {
      const back = this.P._retLookup(this.m.fine)(this.cur);
      const margin = back ? Math.min(...KEYS.map((k) => 1 - (used[k] + back[k]) / cap[k]), (this.P.timeEndS - this.t - back.time) / 3600) : 0;
      let toWork = Infinity, acc = 0;
      for (let q = this.k; q < this.route.length && acc < 900; q++) {
        const seg = this.route[q];
        if (seg.work) { toWork = acc; break; }
        acc += seg._b?.durModel ?? 10;
      }
      urgentNow = margin < 0.1 || toWork < 600;
    }
    const act = sure.length || lateSure || urgentNow;
    const drift = ["met", "water", "batt", "co2", "speed"].filter((k) => Math.abs((c[k] ?? 1) - this.planCal[k]) > 0.15 && (sd[k] ?? 1) < 0.1);
    let reason = null;
    if (act && over.length) reason = `forecast: ${over.join(", ")} would run below the reserve`;
    else if (act && late) reason = "forecast: the plan would overrun the time limit";
    else if (drift.length && this.t - this.lastReplanT > 1800) reason = `learned rates differ from the model (${drift.map((k) => `${k} x${c[k].toFixed(2)}`).join(", ")})`;
    else if (Math.hypot(...this.err) > 2 * this.sigma + 40) reason = "off route";
    this.forecast = { fore, foreLo, over, sure, deferred: (over.length || late) && !act };
    if (reason) this._maybeReplan(reason, !!(act && (over.length || late)));
  }

  /** Consumption so far as the hardware reports it (the crew never sees the simulator's hidden truth). */
  _usedMeasured() {
    const s = this.lastSuit, hw = this.m.s.hw;
    const v = (x, fb) => (Number.isFinite(x) ? x : fb);
    return { o2: v((hw.o2Fill - s.o2Pct / 100) * SUIT.o2Kg, this.res.o2), batt: v((hw.battSOH - s.battPct / 100) * SUIT.batteryWh, this.res.batt),
      water: v((hw.waterFill - s.waterPct / 100) * SUIT.waterKg, this.res.water),
      co2: v((s.scrubPct / 100 - (1 - hw.scrubCap)) * SUIT.co2CapKg, this.res.co2),
      rbatt: Number.isFinite(this.roverBattPct) && this.m.profile.batteryWh
        ? (hw.roverBattSOH - this.roverBattPct / 100) * this.m.profile.batteryWh : this.res.rbatt };
  }

  _remainingModel() {
    // model burn of the rest of the current route (work segments included), at the model's own pace, each segment at
    // the time the crew will reach it (sun, shade and temperature change through the day)
    const out = { o2: 0, co2: 0, water: 0, batt: 0, t: 0, leak: 0, walk: { o2: 0, co2: 0, water: 0, batt: 0, t: 0, leak: 0 } };
    const ms = this.P.departMs + this.t * 1000, leakPerS = (SUIT.leakKgPerH + (this.m.s.cal.leakKgPerH || 0)) / 3600;
    for (let q = this.k; q < this.route.length; q++) {
      const seg = this.route[q];
      const b = q === this.k && seg._b ? seg._b : this._burn(seg, ms + out.t * 1000);
      if (!b) continue;
      const span = (b.durModel ?? b.dur) * (q === this.k ? Math.max(0, 1 - this.segT / b.dur) : 1);
      for (const k of ["o2", "co2", "water", "batt"]) { out[k] += (b.model[k] || 0) * span; if (!seg.work) out.walk[k] += (b.model[k] || 0) * span; }
      out.leak += leakPerS * span;
      out.t += span;
      if (!seg.work) { out.walk.leak += leakPerS * span; out.walk.t += span; }
    }
    return out;
  }

  /** Slip the current plan's model predicts at a cell. */
  _modelSlip(i, rover) {
    const o = this.P.m.s.slipMuOverride; // the current plan's model (physics stays on the pre-EVA model: factors are relative to it)
    if (o) return o[i];
    return rover?.predicted ?? this.m.T.get("slipMu", i);
  }

  /** Connect the true current cell to the start of a new route (the new plan starts at the estimated position). */
  _connect(from) {
    const to = this.route[0]?.u;
    if (to == null || to === from) return;
    const g = this.g, [r0, c0] = g.rc(from), [r1, c1] = g.rc(to);
    const pts = lineCells(r0, c0, r1, c1), cells = [];
    for (let q = 0; q < pts.length; q += 2) cells.push(g.idx(pts[q], pts[q + 1]));
    const seg = [];
    for (let q = 0; q + 1 < cells.length; q++) if (cells[q] !== cells[q + 1]) seg.push({ u: cells[q], v: cells[q + 1] });
    this.route = seg.concat(this.route);
  }

  _maybeReplan(reason, urgent) {
    if (!this.autoReplan || this.returning) return;
    if (!urgent && this.t - this.lastReplanT < 600) return;
    if (this.t - this.lastReplanT < 120) return;
    this.lastReplanT = this.t;
    const remaining = this.stops.filter((s) => !s.done && !s.dropped).map(({ done, dropped, frac, ...s }) => s);
    const [lon, lat] = xyToLonLat(...this.nav.pos);
    // the estimator's factors are totals against the pre-EVA model; the cost model already scales water and CO2 with the
    // metabolic factor, so it gets the residuals (otherwise a hard-working crew would be counted twice)
    const c = this.cal, metF = c.met;
    const env = this.m.env, ms = this.P.departMs + this.t * 1000, sh = env.shadedHz(this.m.fine.hzIdx[this.cur], ms) ? 1 : 0;
    const Te = env.envTempK(ms, sh), sun = sh ? 0 : env.directBeam(ms);
    const wr = Math.max(0.2, suitHeat(MET.P_WORK_W * metF, 0, Te, sun).reject) / Math.max(0.2, suitHeat(MET.P_WORK_W, 0, Te, sun).reject);
    const cal = { met: metF, water: c.water / Math.max(0.3, wr), batt: c.batt, co2: (c.co2 ?? metF) / metF, speed: c.speed };
    let rebuilt = null;
    if (this.slipObs.length && this.m.profile.kind === "vehicle") {
      const T = this.m.T;
      const f = slipFieldFrom({ mu: T.f32("slipMu"), sd: T.f32("slipSd"), sand: T.f32("sand"), slope: T.f32("slopeW") },
        this.m.fine.terr, this.g, this.cal.slipBias, this.slipObs);
      const M = this.m.constructor;
      rebuilt = new M(T, this.m.env, { ...this.ctx.model0.s, slipMuOverride: f.mu, slipSdOverride: f.sd });
    }
    const r = replanFrom(this.ctx, { lon, lat, t: this.t, res: this._usedMeasured(), sigma: this.sigma }, remaining, cal,
      { rebuiltModel: rebuilt, minMargin: 0.05, trace: (this.replanTrace = []) });
    // dead band (the same idea as fleet re-routing on Earth: re-route only when the route got materially worse): a
    // re-check prompted by drifting rates that keeps every station and saves under 8 % of the remaining time leaves
    // the crew on the route they are already walking, with the walkback limits recomputed from the learned rates
    if (!urgent && r.ok && !r.dropped.length && !(r.shortened || []).length) {
      const rem = this._remainingModel(), curLeft = rem.t / Math.max(0.3, c.speed), newLeft = r.sortie.t - this.t;
      if (newLeft > 0.92 * curLeft) {
        this.P = r.planner;
        this.planCal = { met: c.met, water: c.water, batt: c.batt, co2: c.co2 ?? c.met, speed: c.speed };
        this.replans.push({ t: this.t, reason, ms: r.ms, dropped: [], ok: true, kept: true, cal: { ...cal } });
        this.events.push({ t: this.t, event: `re-check: ${reason}; current route still valid (a new one would save ${Math.max(0, 100 * (1 - newLeft / curLeft)).toFixed(0)} %), limits updated (${r.ms} ms)` });
        return;
      }
    }
    for (const name of r.dropped) { const st = this.stops.find((x) => x.name === name); if (st) st.dropped = true; }
    for (const sh of r.shortened || []) { const st = this.stops.find((x) => x.name === sh.name); if (st && !r.dropped.includes(sh.name)) st.dwell_min = sh.to; }
    const rec = { t: this.t, reason, ms: r.ms, dropped: r.dropped, shortened: (r.shortened || []).filter((x) => !r.dropped.includes(x.name)), ok: r.ok, cal: { ...cal }, margin: r.sortie?.minMargin ?? null,
      used: this._usedMeasured() };
    this.replans.push(rec);
    this.planCal = { met: c.met, water: c.water, batt: c.batt, co2: c.co2 ?? c.met, speed: c.speed };
    if (r.ok) {
      this.planVersion++;
      this.P = r.planner;
      this._loadRoute(r.sortie);
      this._connect(this.cur);
      this.plans.push({ v: this.planVersion, t: this.t, reason, pts: r.sortie.pts.map((p) => [p.lon, p.lat]), dropped: r.dropped });
      const cut = (r.shortened || []).filter((x) => !r.dropped.includes(x.name));
      this.events.push({ t: this.t, event: `REPLAN v${this.planVersion}: ${reason}${cut.length ? `; shortened ${cut.map((x) => `${x.name} to ${x.to} min`).join(", ")}` : ""}${r.dropped.length ? `; dropped ${r.dropped.join(", ")}` : ""} (${r.ms} ms)` });
    } else {
      this.P = r.planner;
      this.events.push({ t: this.t, event: `replan found no feasible route (${reason}): returning home` });
      this.startReturn("no feasible re-plan");
    }
  }

  snapshot() {
    const m = this.m, P = this.P, g = this.g, i = this.cur;
    const cap = P.cap;
    const used = this.lastSuit ? this._usedMeasured() : { ...this.res };
    const back = P._retLookup(m.fine)(i) || { time: Infinity, o2: Infinity, co2: Infinity, water: Infinity, batt: Infinity };
    const margins = {
      time: P.timeEndS - (this.t + back.time),
      o2: 1 - (used.o2 + back.o2) / cap.o2, co2: 1 - (used.co2 + back.co2) / cap.co2,
      water: 1 - (used.water + back.water) / cap.water, batt: 1 - (used.batt + back.batt) / cap.batt,
    };
    const remaining = { o2: 1 - used.o2 / cap.o2, co2: 1 - used.co2 / cap.co2, water: 1 - used.water / cap.water, batt: 1 - used.batt / cap.batt };
    const ms = P.departMs + this.t * 1000;
    const los = m.fine.los[i];
    const est = this.nav.pos;
    const [lon, lat] = xyToLonLat(...est);
    const veto = m.fine.veto[i];
    let slopeAhead = 0;
    for (let q = this.k; q < Math.min(this.route.length, this.k + 6); q++) {
      const s = this.route[q];
      if (s.v != null) slopeAhead = Math.max(slopeAhead, m.T.get("slopeW", s.v));
    }
    const shade = m.env.shadedHz(m.fine.hzIdx[i], ms);
    const ruleState = {
      margins, remaining, sigma: this.sigma, crossTrack: Math.hypot(...this.err), offRoute: Math.hypot(...this.err) > 2 * this.sigma + 20,
      vetoHere: veto ? VETO_NAMES[veto] : null, sunsetMinLeft: (P.sunsetMs - ms) / 60000,
      losLostMin: los || this.losLostSince == null ? 0 : (this.t - this.losLostSince) / 60, slopeAhead,
      cold: shade && m.env.envTempK(ms, 1) < 200, spe: !!this.faults.spe, faults: this.faults,
      drain: this.cal?.sd ? Object.fromEntries(["met", "water", "batt", "co2"].filter((k) => (this.cal.sd[k] ?? 1) < 0.2).map((k) => [k, this.cal[k]])) : null,
    };
    const seg = this.route[this.k];
    const station = seg?.work && !this.returning
      ? { name: seg.name, steps: seg.steps, done: this.segT, total: seg.work, step: Math.min(seg.steps.length - 1, Math.floor((this.segT / seg.work) * seg.steps.length)) }
      : null;
    const ell = this.nav.ellipse();
    return { t: this.t, ms, cur: i, est, lon, lat, sigma: this.sigma, ellipse: ell, res: used, remaining, margins, station, pins: this.pins,
      back: back.time, dist: this.dist, returning: this.returning, done: this.done, los, shade, ruleState,
      alerts: this.alerts.list(), counts: this.alerts.counts(), master: this.alerts.master(),
      loop: { planVersion: this.planVersion, cal: this.cal, truth: this.truth, replans: this.replans.slice(-8), navFix: this.nav.lastFix,
        truthErr: Math.hypot(...this.err), lastSlip: this.lastSlip ?? null, telemetry: this.lastFrame?.telemetry ?? null } };
  }
}
