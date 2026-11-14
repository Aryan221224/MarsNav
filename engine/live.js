// live.js - the closed loop on real telemetry (research docs 31-34).
// A LiveSession runs the same brain as the simulator (navigation filter, estimators, forecast, re-planner, caution and
// warning) but its input is a stream of NASA SUITS Telemetry Stream Server frames (EVA.json, ROVER.json) instead of a
// simulated world. tools/tss_bridge.mjs relays those frames from the TSS UDP server to the app; any suit or rover that
// publishes the same fields can drive it.
//
// What is different from the simulator:
//  - position comes from the suit/rover navigation solution in the telemetry (TSS "imu" posx/posy, or the rover's
//    pr_telemetry position), mapped into the site projection by an anchor, then filtered: a fix that jumps further
//    than the crew could have moved is rejected by the filter's chi-square gate; three rejections in a row re-acquire
//  - progress along the plan is found by matching the estimated position to the route (along-track index)
//  - activity (walking, station work, resting) is inferred from motion and the plan, and the model's predicted drain
//    for that activity is what the measured drain is compared with
//  - "off route" is the cross-track distance to the plan, not an error against a truth nobody has

import { EvaSim } from "./sim.js";
import { parseTSS, faultsFromTSS } from "./telemetry.js";
import { evaluateRules, LEVEL } from "./alerts.js";
import { MET, SUIT, THERM, o2KgPerH, co2KgPerH, suitHeat } from "./physio.js";
import { lonlatToXY } from "./geo.js";

const DEG = Math.PI / 180;

/**
 * Map telemetry coordinates to the site projection.
 * anchor = { tssX, tssY, x, y, scale (m per TSS unit), rotDeg (TSS +x axis, degrees clockwise from east... i.e. a
 * rotation applied to TSS offsets), lon/lat instead of x/y allowed }. With no anchor, the first fix is taken to be the
 * habitat and TSS units are metres with +x east, +y north.
 */
export function makeAnchor(a, first, basePos) {
  const [x, y] = a && Number.isFinite(a.lon) ? lonlatToXY(a.lon, a.lat) : a && Number.isFinite(a.x) ? [a.x, a.y] : basePos;
  return { tssX: a?.tssX ?? first.x, tssY: a?.tssY ?? first.y, x, y, scale: a?.scale ?? 1, rotDeg: a?.rotDeg ?? 0 };
}

export function applyAnchor(A, px, py) {
  const dx = (px - A.tssX) * A.scale, dy = (py - A.tssY) * A.scale, r = A.rotDeg * DEG;
  return [A.x + dx * Math.cos(r) - dy * Math.sin(r), A.y + dx * Math.sin(r) + dy * Math.cos(r)];
}

export class LiveSession extends EvaSim {
  /**
   * @param opts { stops, autoReplan, ctx, anchor, crew: "eva1"|"eva2", source: "eva"|"rover", imuSigmaM, maxSpeedMS }
   */
  constructor(planner, sortie, opts = {}) {
    super(planner, sortie, { stops: opts.stops, autoReplan: opts.autoReplan ?? true, ctx: opts.ctx, truth: "nominal" });
    this.liveOpts = { crew: opts.crew || "eva1", source: opts.source || (this.m.profile.kind === "vehicle" ? "rover" : "eva"),
      imuSigmaM: opts.imuSigmaM ?? 3, maxSpeedMS: opts.maxSpeedMS ?? (this.m.profile.kind === "vehicle" ? 5 : 2.2) };
    this.anchorIn = opts.anchor || null;
    this.anchor = null;
    this.frames = 0;
    this.rejects = 0;
    this.crossTrack = 0;
    this.moving = false;
    this.activity = "waiting";
    this.startLevels = null;
    // channels the hardware does not report (stuck at 0 from the first frame, or set by the operator): the model's
    // prediction stands in for them and a caution stays up, so nobody mistakes a model number for a measurement
    this.unreported = new Set(opts.unreported || []);
    this.modelUsed = { o2: 0, water: 0, batt: 0, co2: 0 };
    this._buildIndex();
  }

  _buildIndex() {
    const g = this.g;
    this.segXY = this.route.map((s) => g.cellXY(...g.rc(s.work ? s.at : s.v)));
    this.cumD = new Float64Array(this.route.length);
    for (let q = 1; q < this.route.length; q++) {
      const [a, b] = [this.segXY[q - 1], this.segXY[q]];
      this.cumD[q] = this.cumD[q - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
  }

  /**
   * Moving or stopped: compare the mean position over the last 30 s with the mean over the 30 s before, so a stationary
   * crew's position noise (sigma / sqrt(n)) does not read as walking.
   */
  _motion() {
    const [x, y] = this.nav.pos;
    (this.hist ??= []).push([this.t, x, y]);
    while (this.hist.length > 2 && this.t - this.hist[0][0] > 60) this.hist.shift();
    const h = this.hist, mid = this.t - 30;
    const a = h.filter((p) => p[0] <= mid), b = h.filter((p) => p[0] > mid);
    if (!a.length || !b.length) return this.moving;
    const mean = (L) => [L.reduce((s, p) => s + p[1], 0) / L.length, L.reduce((s, p) => s + p[2], 0) / L.length, L.reduce((s, p) => s + p[0], 0) / L.length];
    const [ax, ay, at] = mean(a), [bx, by, bt] = mean(b);
    const d = Math.hypot(bx - ax, by - ay), span = Math.max(1, bt - at);
    const noise = this.liveOpts.imuSigmaM * Math.sqrt(1 / a.length + 1 / b.length);
    return d / span > (this.m.profile.kind === "vehicle" ? 0.3 : 0.15) && d > 3 * noise;
  }

  _loadRoute(sortie) {
    super._loadRoute(sortie);
    if (this.g) this._buildIndex();
  }

  // a new plan starts at the estimated position, which is where the crew is: nothing to connect
  _connect() { this._buildIndex(); }

  startReturn(reason) {
    super.startReturn(reason);
    this._buildIndex();
  }

  /** No simulated physics: time and state only advance with telemetry. */
  step() {
    return this._finishSnapshot();
  }

  /** Crew marks the current station complete (the UI button; also automatic when they walk on to the next leg). */
  stationDone() {
    const seg = this.route[this.k];
    if (seg?.work) this._completeStation(this.k);
    return this._finishSnapshot();
  }

  _completeStation(k) {
    const seg = this.route[k];
    const st = this.stops.find((s) => s.name === seg.name && !s.done);
    if (st) {
      st.done = true;
      st.frac = Math.min(1, this.segT / 60 / (st.dwell0 || seg.work / 60));
      this.events.push({ t: this.t, event: `station complete: ${seg.name} (${Math.round(this.segT / 60)} of ${Math.round(seg.work / 60)} min)` });
    }
  }

  /** Model drain rates (per second) for the crew's current activity at time ms. */
  _activityRates(seg, ms) {
    if (seg && (seg.work || this.moving)) {
      // cache per segment, refreshed every 10 min of mission time (sun and shade move)
      if (!seg._b || Math.abs(seg._bMs - ms) > 600e3) { seg._b = this._burn(seg, ms); seg._bMs = ms; }
      if (seg._b) return seg._b;
    }
    // resting (stopped on a walking leg, or waiting): resting metabolism, suit base load
    const m = this.m, env = m.env, i = this.cur;
    const shade = env.shadedHz(m.fine.hzIdx[i], ms) ? 1 : 0;
    const pw = MET.P_REST_W * m.s.cal.met;
    const hb = suitHeat(pw, 0, env.envTempK(ms, shade), shade ? 0 : env.directBeam(ms));
    return { model: { o2: (o2KgPerH(pw) + SUIT.leakKgPerH + m.s.cal.leakKgPerH) / 3600, co2: (co2KgPerH(pw) * (m.s.cal.co2 ?? 1)) / 3600,
      water: hb.reject / (THERM.LATENT_J_PER_KG * THERM.EVAP_EFFICIENCY), batt: (SUIT.baseW + hb.heat) / 3600, rbatt: 0 }, d: 0 };
  }

  /**
   * One telemetry frame. eva: TSS EVA.json object; rover: TSS ROVER.json object (or null); wallS: seconds since the
   * stream started (used when the EVA timer is not running).
   */
  ingest(eva, rover = null, { wallS = null } = {}) {
    const O = this.liveOpts;
    const frame = parseTSS(eva, rover, { crew: O.crew });
    const tNew = frame.t > 0 ? frame.t : wallS ?? this.t + 1;
    const dt = this.frames ? tNew - this.t : 0;
    if (this.frames && dt <= 0) return this._finishSnapshot(); // same TSS second polled twice: nothing new
    this.frames++;
    this.t = tNew;
    if (!this.startLevels) {
      this.startLevels = { ...frame.suit };
      for (const [k, n] of [["o2Pct", "O2"], ["battPct", "battery"], ["waterPct", "cooling water"]]) {
        if (frame.suit[k] === 0 && !this.unreported.has(k)) {
          this.unreported.add(k);
          this.events.push({ t: this.t, event: `telemetry: ${n} reads 0 at the start - treated as NOT REPORTED, model value used (check the suit)` });
        }
      }
      const hw = this.m.s.hw;
      const low = [["O2", frame.suit.o2Pct, hw.o2Fill, "o2Pct"], ["battery", frame.suit.battPct, hw.battSOH, "battPct"], ["water", frame.suit.waterPct, hw.waterFill, "waterPct"]]
        .filter(([, v, f, k]) => Number.isFinite(v) && v / 100 < f - 0.03 && !this.unreported.has(k));
      for (const [n, v, f] of low) this.events.push({ t: this.t, event: `pre-EVA check: suit ${n} at ${v.toFixed(0)} %, plan assumed ${(100 * f).toFixed(0)} %` });
    }
    this.lastFrame = eva;
    // stand-in values for unreported channels: planned fill minus the model's drain so far
    const hw = this.m.s.hw, UNIT = { o2Pct: ["o2", SUIT.o2Kg, hw.o2Fill], battPct: ["batt", SUIT.batteryWh, hw.battSOH], waterPct: ["water", SUIT.waterKg, hw.waterFill] };
    for (const k of this.unreported) if (UNIT[k]) { const [r, cap, fill] = UNIT[k]; frame.suit[k] = Math.max(0, 100 * (fill - this.modelUsed[r] / cap)); frame.suit[`${k}Model`] = true; }
    this.lastSuit = frame.suit;
    if (frame.rover && Number.isFinite(frame.rover.battPct)) this.roverBattPct = frame.rover.battPct;
    // ---- position: telemetry navigation solution -> site projection -> filter ----
    const raw = O.source === "rover" && frame.rover && Number.isFinite(frame.rover.x) ? { x: frame.rover.x, y: frame.rover.y, heading: frame.rover.heading }
      : frame.imu;
    if (raw && Number.isFinite(raw.x)) {
      if (!this.anchor) this.anchor = makeAnchor(this.anchorIn, raw, this.basePos);
      const [x, y] = applyAnchor(this.anchor, raw.x, raw.y);
      if (dt > 0) this.nav.inflate((O.maxSpeedMS * dt) ** 2 / 4, dt); // could have moved up to vmax*dt (2 sigma)
      const ok = this.nav.fixPosition(x, y, O.imuSigmaM, O.source === "rover" ? "rover telemetry" : "suit telemetry");
      if (ok) this.rejects = 0;
      else if (++this.rejects >= 3) {
        this.nav.reset(x, y, O.imuSigmaM);
        this.events.push({ t: this.t, event: "navigation re-acquired after 3 rejected position fixes" });
        this.rejects = 0;
      }
      const [ex, ey] = this.nav.pos;
      const ci = this.g.idxOfXY(ex, ey);
      if (ci >= 0) this.cur = ci;
    } else if (dt > 0) this.nav.inflate((O.maxSpeedMS * dt) ** 2 / 4, dt);
    this.sigma = this.nav.ellipse().sigma;
    this.moving = this._motion();
    // ---- progress along the plan ----
    const k0 = this.k, along0 = this.cumD[k0] ?? 0;
    this._progress(dt);
    const advance = this.k >= k0 && this.route === this._routeRef ? Math.max(0, (this.cumD[this.k] ?? 0) - along0) : 0;
    this._routeRef = this.route;
    this.dist += advance;
    const seg = this.route[this.k];
    const ms = this.P.departMs + this.t * 1000;
    const b = this._activityRates(seg, ms);
    this.activity = seg?.work ? `work: ${seg.name}` : this.moving ? "traverse" : "stopped";
    if (seg?.work) this.segT += dt;
    // ---- learn: measured drain vs the model's drain for this activity; walking speed vs the model's ----
    frame.walk = null;
    // distance made good along the plan (robust to position noise) against the model's pace for this leg
    if (this.moving && seg && !seg.work && b.d) frame.walk = { plannedM: (dt * b.d) / (b.durModel ?? b.dur), actualM: advance };
    const model = {};
    for (const k of ["o2", "water", "batt", "co2"]) { model[`${k}PerS`] = b.model[k] || 0; this.modelUsed[k] += (b.model[k] || 0) * Math.max(0, dt); }
    if (dt > 0) this.cal = this.est.ingest(frame, model);
    this.frameT = this.t;
    // ---- hardware faults reported by the suit ----
    const f = faultsFromTSS(frame);
    for (const k of Object.keys(f)) if (!this.faults[k]) { this.faults[k] = true; this.events.push({ t: this.t, event: `suit reports fault: ${k}` }); }
    // ---- forecast and re-plan ----
    if (dt > 0) this._monitor();
    return this._finishSnapshot();
  }

  /**
   * Along-track progress: nearest route point among those the crew could have reached since the last frame (an
   * out-and-back route passes close to itself, so the window is in distance along the route, not in space).
   */
  _progress(dt) {
    if (!this.route.length) return;
    const [ex, ey] = this.nav.pos;
    let best = this.k, bd = Infinity;
    const c0 = this.cumD[this.k], reach = c0 + this.liveOpts.maxSpeedMS * Math.max(dt, 1) * 1.5 + 3 * this.sigma + 20;
    const atWork = !!this.route[this.k]?.work;
    // at a station the crew stays at the station until they have clearly walked on (position noise must not end it)
    const lo = atWork ? this.k : Math.max(0, this.k - 3);
    for (let q = lo; q < this.route.length && this.cumD[q] <= reach; q++) {
      const [x, y] = this.segXY[q];
      const d = Math.hypot(x - ex, y - ey);
      if (d < bd - 1e-6) { bd = d; best = q; }
    }
    this.crossTrack = bd;
    this.err = [bd, 0];
    const gate = Math.max(40, 3 * this.sigma);
    if (bd > gate) return; // off the plan: keep the index, the monitor re-plans from here
    // at a station: the arrival point and the work item share a cell; stopped there means working
    if (this.route[best + 1]?.work && !this.moving && bd < 30) best++;
    if (atWork && best > this.k) {
      // leaving needs motion and being clearly nearer the next leg than the station
      const [sx, sy] = this.segXY[this.k];
      if (!this.moving || Math.hypot(ex - sx, ey - sy) < Math.max(25, 3 * this.sigma)) best = this.k;
    }
    // arriving at a station stops the index there (the nearest point can overshoot by a cell); walking on past it,
    // clearly away from it, completes it
    for (let q = this.k; q < best; q++) {
      if (!this.route[q].work) continue;
      const [sx, sy] = this.segXY[q];
      if (!this.moving || Math.hypot(ex - sx, ey - sy) < Math.max(25, 3 * this.sigma)) { best = q; break; }
    }
    for (let q = this.k; q < best; q++) if (this.route[q].work) this._completeStation(q);
    if (best > this.k || (best < this.k && !this.route[this.k]?.work)) this.segT = 0;
    this.k = best;
    const last = this.route.length - 1;
    if (this.k >= last && !this.route[last]?.work) {
      const [bx, by] = this.basePos;
      if (Math.hypot(ex - bx, ey - by) < 30 && !this.done) {
        this.done = true;
        this.events.push({ t: this.t, event: this.returning ? "back at habitat (contingency return)" : "EVA complete" });
      }
    }
  }

  _finishSnapshot() {
    const snap = this.snapshot();
    const raised = this.alerts.update(evaluateRules(snap.ruleState), this.t);
    snap.raised = raised;
    snap.alerts = this.alerts.list();
    snap.counts = this.alerts.counts();
    snap.master = this.alerts.master();
    if (!this.returning && raised.some((a) => a.level === LEVEL.WARNING && ["pnr", "sunset", "spe", "leak", "rover"].includes(a.id))) {
      this.startReturn(raised[0].text);
    }
    if (this.frames) this.track.push({ t: this.t, cur: this.cur, sigma: this.sigma, err: [...this.err], res: { ...snap.res } });
    return snap;
  }

  snapshot() {
    const s = super.snapshot();
    s.loop.truthErr = null;
    s.loop.crossTrack = this.crossTrack;
    s.loop.telemetry = this.lastSuit ? { ...this.lastSuit } : null;
    s.live = { frames: this.frames, source: this.liveOpts.source, crew: this.liveOpts.crew, activity: this.activity,
      anchor: this.anchor, rejects: this.rejects, unreported: [...this.unreported] };
    s.ruleState.unreported = [...this.unreported];
    return s;
  }
}
