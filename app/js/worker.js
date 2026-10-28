// worker.js - runs the whole engine off the UI thread. One copy of the terrain lives here; the UI gets images,
// route summaries and snapshots through messages.
import { loadTerrain, browserIO } from "../engine/terrain.js";
import { Environment } from "../engine/environment.js";
import { CostModel, VETO_NAMES, TERR } from "../engine/costmodel.js";
import { Planner } from "../engine/planner.js";
import { viewshed, rangeMask, walkbackPath } from "../engine/fields.js";
import { optimiseSortie } from "../engine/sortie.js";
import { EvaSim, TRUTH_SCENARIOS } from "../engine/sim.js";
import { LiveSession } from "../engine/live.js";
import { tssFrameFromSim } from "../engine/telemetry.js";
import { HR_CAL } from "../engine/estimator.js";
import { selectStationsQubo, exportQubo } from "../engine/qubo.js";
import { cueCardHTML, routeGeoJSON, guidanceLegs } from "../engine/report.js";
import { ahp, L1_IDS, L1_MATRIX, defaultL1, namedWeightSets } from "../engine/ahp.js";
import { marsContext, missionClock, M2020_CLOCK } from "../engine/marstime.js";
import { pressureEnvelope, pressureAt } from "../engine/sitecheck.js";
import { LANDERS, LIMITS, landingSafetyMap, simulateLanding, ellipseChecks, optimiseTarget, hubLocalisation } from "../engine/landing.js";

const S = { T: null, env: null, clim: null, models: new Map(), planner: null, plan: null, sim: null, cfg: null };
let DATA = new URL("../data/", import.meta.url);

async function init({ base } = {}) {
  if (base) DATA = new URL(base);
  const io = browserIO(DATA.href);
  S.T = await loadTerrain(io);
  S.clim = await io.json("environment.json").catch(() => null);
  S.imagery = await io.json("imagery.json");
  S.traverse = await io.json("traverse.json").catch(() => null);
  S.validation = await io.json("validation.json").catch(() => null);
  S.env = new Environment(S.T, S.clim);
  const T = S.T;
  S.clock = T.site.clock ? missionClock(T.site.clock) : M2020_CLOCK;
  return {
    site: T.site, projection: T.manifest.projection, quality: T.manifest.quality ?? null,
    grid: T.grid.toJSON(), hz: T.hzGrid.toJSON(), reg: T.regGrid.toJSON(), targets: T.targets, keepouts: T.keepouts,
    landmarks: T.landmarks, imagery: S.imagery, traverse: S.traverse, validation: S.validation, stats: T.manifest.stats,
    climSource: S.clim?.source ?? null, l1: defaultL1(), l1Matrix: L1_MATRIX, l1Ids: L1_IDS,
  };
}

function modelFor(cfg) {
  const key = JSON.stringify({ p: cfg.profile, r: cfg.risk, rf: cfg.reserveFrac, u: cfg.userNoGo, tau: cfg.tau, n: cfg.nav, hw: cfg.hw, cal: cfg.cal });
  let m = S.models.get(key);
  if (!m) {
    S.env.tau = cfg.tau ?? 0.45;
    m = new CostModel(S.T, S.env, { profile: cfg.profile, risk: cfg.risk, reserveFrac: cfg.reserveFrac, userNoGo: cfg.userNoGo,
      nav: cfg.nav || "beacon", hw: cfg.hw, cal: cfg.cal });
    S.models.set(key, m);
    if (S.models.size > 4) S.models.delete(S.models.keys().next().value);
  }
  return m;
}

function setup(cfg) {
  S.cfg = cfg;
  const m = modelFor(cfg);
  S.env.tau = cfg.tau ?? 0.45;
  const P = new Planner(m, cfg.base, { departMs: cfg.departMs, evaMaxS: cfg.evaMaxH * 3600, rescue: !!cfg.rescue && cfg.profile === "rover" });
  // radio line of sight from the habitat mast, coarse grid, then mapped onto the fine grid
  viewshed(m.coarse, P.baseCoarse, cfg.mastM ?? 10);
  const f = m.coarse.factor, fg = m.fine.grid, cg = m.coarse.grid;
  for (let r = 0; r < fg.height; r++) {
    const R = Math.min(cg.height - 1, Math.floor(r / f));
    for (let c = 0; c < fg.width; c++) m.fine.los[r * fg.width + c] = m.coarse.los[R * cg.width + Math.min(cg.width - 1, Math.floor(c / f))];
  }
  S.planner = P;
  S.plan = null;
  S.sim = null;
  const vetoCount = new Array(9).fill(0);
  for (let i = 0; i < m.fine.n; i++) vetoCount[m.fine.veto[i]]++;
  S.pEnv ??= pressureEnvelope(S.env, S.T);
  const bi = m.fine.grid.idxOfLonLat(cfg.base.lon, cfg.base.lat);
  return { timeEndS: P.timeEndS, sunsetMs: P.sunsetMs, cap: P.cap, vetoCount, vetoNames: VETO_NAMES,
    ctx: marsContext(cfg.departMs, cfg.base.lon, cfg.base.lat, S.clock), pEnv: S.pEnv,
    pNow: pressureAt(S.env, cfg.departMs, cfg.base.lon, bi >= 0 ? m.fine.elev[bi] : -2550) };
}

function terrainSource() {
  const si = S.T.site;
  return `${si.regional_dem ?? "regional DEM"}${si.hires_dtms?.length ? ` + 1 m DTMs (${si.hires_dtms.join(", ")})` : " only (no 1 m DTM)"}`;
}

function slimRoute(r) {
  if (!r?.ok) return r ? { ok: false, reason: r.reason, from: r.from, to: r.to, failedLeg: r.failedLeg } : null;
  const pts = r.pts.map((p) => ({ lon: p.lon, lat: p.lat, x: p.x, y: p.y, i: p.i, elev: p.elev, t: p.t, dist: p.dist, grade: p.grade,
    haz: p.haz, shade: p.shade, sunEl: p.sunEl, sigma: p.sigma, los: p.los, res: p.res, back: p.back, margins: p.margins,
    work: p.work || 0 }));
  // station budget: what the stated task at the end of each leg costs, and the walkback margin left after it
  const workOf = (l) => {
    const P = l.ev.pts, a = P[P.length - 2], b = P[P.length - 1];
    if (!b?.work || !a) return null;
    const m = b.margins;
    return { s: b.work, o2: b.res.o2 - a.res.o2, co2: b.res.co2 - a.res.co2, water: b.res.water - a.res.water, batt: b.res.batt - a.res.batt,
      marginAfter: m ? Math.min(m.o2, m.co2, m.water, m.batt) : null, task: l.to.task ?? null };
  };
  const legs = r.legs.map((l) => ({ from: l.from.name, to: l.to.name, toBase: !!l.to.isBase, fromBase: !!l.from.isBase, t: l.ev.t, dist: l.ev.dist, n: l.ev.pts.length, work: workOf(l),
    guidance: guidanceLegs(l.ev.pts).map((g) => ({ heading: g.heading, dist: g.dist, dt: g.dt, climb: g.climb, work: g.work,
      lon: g.to.lon, lat: g.to.lat })) }));
  return { ok: true, feasible: r.feasible, t: r.t, dist: r.dist, res: r.res, X: r.X, minMargin: r.minMargin, maxSlope: r.maxSlope,
    maxHaz: r.maxHaz, shadeFrac: r.shadeFrac, losFrac: r.losFrac, overlap: r.overlap, doseMSv: r.doseMSv, seamCells: r.seamCells, lowConfFrac: r.lowConfFrac, rockyFrac: r.rockyFrac, sandFrac: r.sandFrac,
    wheelLife: r.wheelLife, wheelLeft: r.wheelLeft, pts, legs, timeEndS: r.timeEndS, sequence: r.sequence, startAt: r.startAt, endAt: r.endAt,
    sunsetMs: r.sunsetMs };
}

function plan(stops, weights, ro = {}) {
  const P = S.planner;
  const t0 = performance.now();
  const out = P.namedSorties(stops, { balanced: weights || null, start: ro.start ?? null, end: ro.end ?? "base" });
  if (!out.ok) {
    // show where the plan breaks: the point of no return on the fastest unconstrained route
    const d = P.diagnose(stops, ro);
    const diag = d.ok ? { pnrIndex: d.pnrIndex, limiting: d.limiting, pnrDistM: d.pnrDistM, totalDistM: d.totalDistM,
      pts: d.pts.filter((_, k) => k % 2 === 0 || k === d.pnrIndex).map((p) => ({ lon: p.lon, lat: p.lat, dist: p.dist })),
      pnr: d.pnrIndex >= 0 ? { lon: d.pts[d.pnrIndex].lon, lat: d.pts[d.pnrIndex].lat } : null } : null;
    S.plan = null;
    return { ok: false, reason: out.fastest?.reason, from: out.fastest?.from, to: out.fastest?.to, diag, ms: performance.now() - t0 };
  }
  // Pareto post-selection: "fastest" and "economy" are the best feasible candidates on their own criterion
  const cand = Object.entries(out.routes).filter(([, r]) => r?.ok && r.feasible);
  const pick = (f) => cand.reduce((a, b) => (f(b[1]) < f(a[1]) ? b : a), cand[0]);
  if (cand.length) {
    const fast = pick((r) => r.t), eco = pick((r) => S.planner.m.consFrac(r.res));
    out.routes.fastest = fast[1];
    out.routes.economy = eco[1];
  }
  S.plan = { stops, routes: out.routes, refs: out.refs };
  const routes = {};
  for (const [k, r] of Object.entries(out.routes)) routes[k] = slimRoute(r);
  return { ok: true, routes, refs: out.refs, ms: performance.now() - t0 };
}

// ------------------------------------------------------------------------------------------------ overlays ----
const PAL = {
  haz: [[0, [0, 0, 0, 0]], [0.15, [110, 80, 255, 60]], [0.45, [190, 80, 255, 140]], [0.8, [255, 80, 216, 200]], [1, [255, 255, 255, 230]]],
  seq: [[0, [0, 0, 0, 0]], [0.25, [90, 110, 255, 110]], [0.6, [200, 90, 255, 170]], [1, [255, 245, 255, 230]]],
};
function ramp(pal, v) {
  if (!(v > 0)) return pal[0][1];
  for (let k = 1; k < pal.length; k++) {
    const [a, ca] = pal[k - 1], [b, cb] = pal[k];
    if (v <= b) {
      const t = (v - a) / (b - a);
      return ca.map((x, j) => x + (cb[j] - x) * t);
    }
  }
  return pal[pal.length - 1][1];
}

function overlay(name, opts = {}) {
  const m = modelFor(S.cfg), pg = m.fine, g = pg.grid, T = S.T;
  const rgba = new Uint8ClampedArray(g.n * 4);
  const put = (i, c) => { rgba[4 * i] = c[0]; rgba[4 * i + 1] = c[1]; rgba[4 * i + 2] = c[2]; rgba[4 * i + 3] = c[3]; };
  const stripes = (i, a, b) => { const r = Math.floor(i / g.width), c = i % g.width; return ((r + c) >> 2) & 1 ? a : b; };
  let legend = null;
  if (name === "veto") {
    for (let i = 0; i < g.n; i++) {
      const v = pg.veto[i];
      if (!v) continue;
      if (v === 5 || v === 6) put(i, stripes(i, [255, 198, 41, 220], [11, 15, 20, 220]));
      else put(i, stripes(i, [242, 245, 248, 150], [11, 15, 20, 150]));
    }
    legend = { kind: "veto", text: "Hatched: no-go (vetoed). Amber/black: keep-out zone." };
  } else if (name === "hazard") {
    for (let i = 0; i < g.n; i++) if (!pg.veto[i]) put(i, ramp(PAL.haz, Math.min(1, pg.haz[i] / 0.5)));
    legend = { kind: "ramp", pal: "haz", lo: "0", hi: "0.5+", text: "Composite safety hazard (factor tree, static leaves)" };
  } else if (name === "slope") {
    const a = T.f32("slopeW");
    for (let i = 0; i < g.n; i++) put(i, ramp(PAL.seq, Math.min(1, a[i] / 25)));
    legend = { kind: "ramp", pal: "seq", lo: "0 deg", hi: "25 deg", text: "Walking-scale slope, 90th percentile per 10 m cell" };
  } else if (name === "sand") {
    const a = T.f32("sand");
    for (let i = 0; i < g.n; i++) put(i, ramp(PAL.seq, a[i]));
    legend = { kind: "ramp", pal: "seq", lo: "none", hi: "strong", text: "Aeolian bedforms (ripples, TARs) detected in HiRISE 1 m DTMs" };
  } else if (name === "slip") {
    for (let i = 0; i < g.n; i++) put(i, ramp(PAL.seq, Math.min(1, pg.slip[i] / 0.7)));
    legend = { kind: "ramp", pal: "seq", lo: "0", hi: "0.7 (veto)", text: `Wheel-slip risk (${S.cfg.risk.kind.toUpperCase()}${S.cfg.risk.kind === "cvar" ? " " + S.cfg.risk.alpha : ""})` };
  } else if (name === "shade") {
    const ms = opts.ms ?? S.cfg.departMs;
    const sun = S.env.sun(ms);
    for (let i = 0; i < g.n; i++) if (S.env.shadedHz(pg.hzIdx[i], ms)) put(i, [0, 0, 0, sun.elevation > 0 ? 150 : 190]);
    legend = { kind: "text", text: `Terrain shadow at the selected time. Sun ${sun.elevation.toFixed(1)} deg elevation, az ${sun.azimuth.toFixed(0)} deg.` };
  } else if (name === "walkback") {
    const f = S.planner.field, cg = f.pg.grid, fr = f.pg.factor;
    const tf = new Float32Array(g.n).fill(Infinity);
    for (let r = 0; r < g.height; r++) for (let c = 0; c < g.width; c++) {
      if (pg.veto[r * g.width + c]) continue;
      const R = (r + 0.5) / fr - 0.5, C = (c + 0.5) / fr - 0.5;
      const r0 = Math.max(0, Math.min(cg.height - 2, Math.floor(R))), c0 = Math.max(0, Math.min(cg.width - 2, Math.floor(C)));
      const fy = Math.min(1, Math.max(0, R - r0)), fx = Math.min(1, Math.max(0, C - c0));
      let sw = 0, sv = 0;
      for (const [dr, dc, w] of [[0, 0, (1 - fy) * (1 - fx)], [0, 1, (1 - fy) * fx], [1, 0, fy * (1 - fx)], [1, 1, fy * fx]]) {
        const v = f.time[(r0 + dr) * cg.width + c0 + dc];
        if (Number.isFinite(v) && w > 0) { sw += w; sv += w * v; }
      }
      if (sw > 0.2) tf[r * g.width + c] = sv / sw / 60;
    }
    for (let r = 1; r < g.height; r++) for (let c = 1; c < g.width; c++) {
      const i = r * g.width + c, t = tf[i];
      if (!Number.isFinite(t)) continue;
      const b = Math.floor(t / 15);
      const edge = Math.floor(tf[i - 1] / 15) !== b || Math.floor(tf[i - g.width] / 15) !== b;
      put(i, edge && Number.isFinite(tf[i - 1]) && Number.isFinite(tf[i - g.width]) ? [242, 245, 248, 220] : [60, 120, 255, b % 2 ? 46 : 20]);
    }
    legend = { kind: "text", text: "Walkback time to the habitat on foot: bands and contours every 15 min (fastest return path)" };
  } else if (name === "range") {
    const mask = rangeMask(m, S.planner.field, { timeS: S.planner.timeEndS, workS: (opts.workMin ?? 30) * 60 });
    const cg = S.planner.field.pg.grid, fr = S.planner.field.pg.factor;
    for (let r = 0; r < g.height; r++) for (let c = 0; c < g.width; c++) {
      const v = mask[Math.min(cg.height - 1, Math.floor(r / fr)) * cg.width + Math.min(cg.width - 1, Math.floor(c / fr))];
      if (v === 1) put(r * g.width + c, [62, 224, 126, 55]);
      else if (v === 2) put(r * g.width + c, [255, 198, 41, 80]);
    }
    legend = { kind: "text", text: "Consumables-aware range: green = out and back with >20 % margin, amber = within budget but < 20 % margin" };
  } else if (name === "los") {
    for (let i = 0; i < g.n; i++) if (!pg.los[i]) put(i, [60, 203, 255, 70]);
    legend = { kind: "text", text: "Cyan: no radio line of sight to the 10 m habitat mast (Mars curvature included)" };
  } else if (name === "sigma") {
    for (let i = 0; i < g.n; i++) put(i, [201, 160, 255, Math.min(200, (pg.sigma[i] - 10) * 5)]);
    legend = { kind: "text", text: "Planning position error (1 sigma) from distance to the nearest landmark" };
  } else if (name === "confidence") {
    const a = T.f32("conf");
    for (let i = 0; i < g.n; i++) if (a[i] < 0.5) put(i, [11, 15, 20, 120]);
    legend = { kind: "text", text: "Darkened: no HiRISE 1 m DTM (CTX 20 m only), wider slip uncertainty applied" };
  } else if (name === "landing") {
    S.landSafe ??= landingSafetyMap(T);
    for (let i = 0; i < g.n; i++) {
      const v = S.landSafe[i];
      put(i, v === 1 ? [62, 224, 126, 70] : v === 2 ? [255, 198, 41, 70] : [255, 116, 112, 95]);
    }
    legend = { kind: "text", text: `Lander-scale safety: green safe (slope <= ${LIMITS.slope25m} deg, rocks <= ${LIMITS.rockM} m, from 1 m DTMs), amber looks safe but unverified (no 1 m data), red unsafe` };
  } else if (name === "science") {
    for (let i = 0; i < g.n; i++) if (pg.sci[i] > 0.05) put(i, [216, 165, 122, Math.round(pg.sci[i] * 160)]);
    legend = { kind: "text", text: "Science value around the named targets (team priority ranking)" };
  }
  // provenance badge on every layer (what kind of number the crew is looking at)
  const hi = S.T.site.hires_dtms?.length ? "HiRISE 1 m DTMs + CTX 20 m" : "CTX 20 m DEM";
  const PROV = {
    veto: ["DERIVED", `${hi}; limits from NASA and study values`], hazard: ["DERIVED", `${hi}; AHP team weights [ASSUME]`],
    slope: ["DERIVED", S.T.site.hires_dtms?.length ? "HiRISE 1 m DTMs; CTX-calibrated where no 1 m" : "CTX 20 m, calibrated at Jezero"],
    sand: ["DERIVED", S.T.site.hires_dtms?.length ? "HiRISE 1 m DTM bedform detector" : "prior only: no 1 m data"],
    slip: ["MODELED", "slip distribution from bedforms and slope"], shade: ["MODELED", "horizon maps + Mars24 sun"],
    walkback: ["MODELED", "suit model over the terrain"], range: ["MODELED", "suit consumables over the terrain"],
    los: ["MODELED", "10 m mast, Mars curvature"], sigma: ["MODELED", "dead-reckoning drift [ASSUME 2 %]"],
    confidence: ["OBSERVED", "HiRISE 1 m DTM coverage"], science: ["CURATED", "rover sample sites and team ranking"],
    landing: ["DERIVED", "MSL engineering constraints on the site DTMs"],
  };
  if (legend && PROV[name]) legend.prov = PROV[name];
  return { w: g.width, h: g.height, rgba, legend };
}

function cell(lon, lat) {
  const m = modelFor(S.cfg), g = m.fine.grid;
  const i = g.idxOfLonLat(lon, lat);
  if (i < 0) return null;
  const ex = m.explainCell(i);
  const f = S.planner?.field;
  let back = null;
  if (f) {
    const cg = f.pg.grid, fr = f.pg.factor, [r, c] = g.rc(i);
    back = f.time[Math.min(cg.height - 1, Math.floor(r / fr)) * cg.width + Math.min(cg.width - 1, Math.floor(c / fr))];
  }
  return { ...ex, walkbackS: back, los: m.fine.los[i] };
}

function simSnap(s) {
  const P = S.sim.P || S.planner, sim = S.sim;
  const L = s.loop || {};
  const loop = { planVersion: L.planVersion, cal: L.cal ? { met: L.cal.met, water: L.cal.water, batt: L.cal.batt, co2: L.cal.co2, speed: L.cal.speed,
      sd: L.cal.sd, metW: L.cal.metW, metSd: L.cal.metSd, slipBias: L.cal.slipBias ? { w: L.cal.slipBias.w, n: L.cal.slipBias.n } : null } : null,
    truth: s.live ? null : L.truth, replans: (L.replans || []).map((r) => ({ t: r.t, reason: r.reason, dropped: r.dropped, ms: r.ms, ok: r.ok })),
    navFix: L.navFix, truthErr: L.truthErr, crossTrack: L.crossTrack ?? null, lastSlip: L.lastSlip, telemetry: L.telemetry,
    stops: sim.stops.map((x) => ({ name: x.name, done: !!x.done, dropped: !!x.dropped })), autoReplan: sim.autoReplan };
  const cur = sim.plans?.[sim.plans.length - 1];
  return { loop, live: s.live || null, ellipse: s.ellipse, livePlan: sim.planVersion > 1 && cur ? cur.pts.filter((_, k) => k % 2 === 0) : null, t: s.t, ms: s.ms, lon: s.lon, lat: s.lat, est: s.est, sigma: s.sigma, res: s.res, remaining: s.remaining, margins: s.margins,
    back: s.back, dist: s.dist, returning: s.returning, done: s.done, los: s.los, shade: s.shade, alerts: s.alerts, counts: s.counts,
    master: s.master, raised: s.raised || [], cap: P.cap, events: S.sim.events.slice(-40), station: s.station, pins: s.pins,
    returnPts: S.sim.returnCells ? S.sim.returnCells.filter((_, k) => k % 3 === 0).map((i) => S.T.grid.cellLonLat(...S.T.grid.rc(i))) : null,
    track: S.sim.track.filter((_, k) => k % 5 === 0).map((p) => S.T.grid.cellLonLat(...S.T.grid.rc(p.cur))),
    // what the crew displays (hud.html) look ahead with
    rs: s.ruleState ? { slopeAhead: s.ruleState.slopeAhead, sunsetMinLeft: s.ruleState.sunsetMinLeft, losLostMin: s.ruleState.losLostMin,
      cold: !!s.ruleState.cold, vetoHere: s.ruleState.vetoHere, offRoute: !!s.ruleState.offRoute, crossTrack: s.ruleState.crossTrack } : null };
}

const handlers = {
  init,
  setup: ({ cfg }) => setup(cfg),
  plan: ({ stops, weights, start = null, end = "base" }) => plan(stops, weights, { start, end }),
  overlay: ({ name, opts }) => overlay(name, opts),
  cell: ({ lon, lat }) => cell(lon, lat),
  optimise: ({ cands, maxStops }) => {
    if (cands.length > 15) {
      // beyond exact enumeration: station selection as a QUBO, simulated annealing, exact tour check (engine/qubo.js)
      const q = selectStationsQubo(S.planner, cands, {});
      S.lastQubo = q.qubo;
      return { options: q.ids.length ? [{ ids: q.ids, value: q.value, timeS: q.timeS, travelS: q.travelS, o2Kg: q.o2Kg }] : [], budgetT: q.budgetT,
        method: `QUBO (${q.variables} binary variables) solved by simulated annealing in ${q.ms} ms` };
    }
    const r = optimiseSortie(S.planner, cands, { maxStops: Math.max(maxStops, cands.length) });
    return { options: r.options.map((o) => ({ ids: o.ids, value: o.value, timeS: o.timeS, travelS: o.travelS, o2Kg: o.o2Kg })),
      budgetT: r.budgetT, method: `Exact: Held-Karp dynamic programming over all ${2 ** cands.length - 1} station sets` };
  },
  ahp: ({ A }) => ahp(A),
  landers: () => Object.entries(LANDERS).map(([id, L]) => ({ id, label: L.label, major: L.major, minor: L.minor, trn: !!L.trn, src: L.src })),
  landing: ({ lander, lon, lat, azimuthDeg = 90, optimise = false, seed = 1 }) => {
    S.landSafe ??= landingSafetyMap(S.T);
    const m = optimise ? optimiseTarget(S.T, { lander, lon, lat, azimuthDeg })
      : simulateLanding(S.T, { lander, lon, lat, azimuthDeg, n: 3000, seed, safe: S.landSafe });
    if (!m) return { ok: false, reason: "no candidate target inside this site's terrain" };
    return { ok: true, ...m, checks: ellipseChecks(S.T, { lander, lon: m.target.lon, lat: m.target.lat, azimuthDeg }).checks, hub: hubLocalisation(lander) };
  },
  // one flown landing: a single Monte Carlo touchdown (the dispersion is real; where you end up is not up to you)
  landOnce: ({ lander, lon, lat, azimuthDeg = 90, seed }) => {
    S.landSafe ??= landingSafetyMap(S.T);
    const m = simulateLanding(S.T, { lander, lon, lat, azimuthDeg, n: 1, seed: seed ?? (Date.now() & 0xffffff), safe: S.landSafe });
    return { ok: true, touchdown: m.samples[0], cls: m.samples[0].cls, hub: hubLocalisation(lander) };
  },
  quboExport: ({ cands }) => {
    const q = selectStationsQubo(S.planner, cands, {});
    return { json: exportQubo(q.qubo), ids: q.ids, value: q.value, timeS: q.timeS, ms: q.ms };
  },
  simStart: ({ route, seed, truth = "nominal", autoReplan = true }) => {
    const r = S.plan.routes[route];
    S.sim = new EvaSim(S.planner, r, { seed, truth, autoReplan });
    return simSnap(S.sim.step(0));
  },
  truths: () => Object.entries(TRUTH_SCENARIOS).map(([id, t]) => ({ id, label: t.label })),
  // live suit / rover telemetry (NASA SUITS TSS JSON relayed by tools/tss_bridge.mjs)
  liveStart: ({ route, crew = "eva1", autoReplan = true, anchor = null }) => {
    const r = S.plan.routes[route];
    S.sim = new LiveSession(S.planner, r, { crew, autoReplan, anchor });
    S.uplinkKey = "1/false";
    return simSnap(S.sim.step());
  },
  liveFrame: ({ eva, rover, wallS }) => {
    const snap = simSnap(S.sim.ingest(eva, rover || null, { wallS }));
    // plan uplink: whenever the plan changes, send the crew the route they should now walk (the bridge serves it at
    // GET /plan for a helmet display; in --demo the simulated crew follows it)
    const key = `${S.sim.planVersion}/${S.sim.returning}`;
    if (key !== S.uplinkKey) {
      S.uplinkKey = key;
      snap.uplink = S.sim.returning
        ? { version: S.sim.planVersion, returning: true, returnCells: S.sim.returnCells }
        : { version: S.sim.planVersion, returning: false, legs: S.sim.sortie.legs.map((l) => ({ cells: Array.from(l.cells),
          to: { name: l.to.name, lon: l.to.lon, lat: l.to.lat, dwell_min: l.to.dwell_min, value: l.to.value } })) };
    }
    return snap;
  },
  liveStationDone: () => simSnap(S.sim.stationDone()),
  // built-in demo suit: when no NASA SUITS TSS is reachable, a simulated crew member with a hidden truth (working harder,
  // a slow leak...) flies the plan and produces TSS-format EVA.json frames, which go through exactly the same live
  // closed loop as a real suit. The simulated crew follows every re-plan the loop uplinks, as a real crew would.
  demoStart: ({ route, truth = "hardwork", seed = 11, crew = "eva1", autoReplan = true }) => {
    const r = S.plan.routes[route];
    let x = seed >>> 0 || 1;
    const rand = () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
    S.demo = { sim: new EvaSim(S.planner, r, { seed, truth, autoReplan: false }), rand, origin: [-5668.5, -10045.6], wall: 0, truth };
    S.sim = new LiveSession(S.planner, r, { crew, autoReplan, anchor: null });
    S.uplinkKey = "1/false";
    const snap = simSnap(S.sim.step());
    snap.demo = { truth: TRUTH_SCENARIOS[truth]?.label || truth };
    return snap;
  },
  demoTick: ({ dt = 1 }) => {
    const D = S.demo, s = D.sim;
    let left = dt;
    while (left > 1e-9 && !s.done) { const d = Math.min(left, 5); s.step(d); left -= d; }
    D.wall += dt;
    const g = () => (D.rand() + D.rand() + D.rand() + D.rand() - 2) * 1.732 * 3;   // ~3 m position noise, like the IMU
    const [bx, by] = s.basePos, p = s.truePos || s.basePos;
    const eva = tssFrameFromSim({ t: s.t, used: s.res, hw: s.m.s.hw, metW: s.metTrueW, hrCal: HR_CAL,
      pos: { x: D.origin[0] + (p[0] - bx) + g(), y: D.origin[1] + (p[1] - by) + g() }, heading: 0, rand: D.rand, faults: s.faults });
    const snap = handlers.liveFrame({ eva, rover: null, wallS: D.wall });
    if (snap.uplink) {       // the simulated crew follows the new plan
      const plan = snap.uplink;
      if (plan.returning && plan.returnCells?.length) {
        s.route = [];
        for (let k = 0; k + 1 < plan.returnCells.length; k++) if (plan.returnCells[k] !== plan.returnCells[k + 1]) s.route.push({ u: plan.returnCells[k], v: plan.returnCells[k + 1], ret: true });
        s.returning = true; s.k = 0; s.segT = 0; s._connect(s.cur);
      } else if (plan.legs?.length) {
        s._loadRoute({ legs: plan.legs.map((l) => ({ cells: l.cells, to: l.to, ev: { pts: [] } })) });
        s._connect(s.cur);
      }
    }
    snap.demo = { truth: TRUTH_SCENARIOS[D.truth]?.label || D.truth, done: s.done };
    return snap;
  },
  setAutoReplan: ({ on }) => { if (S.sim) S.sim.autoReplan = !!on; return { ok: true }; },
  simStep: ({ dt }) => simSnap(S.sim.step(dt)),
  simInject: ({ kind }) => { S.sim.inject(kind); return simSnap(S.sim.step(0)); },
  simAck: ({ id }) => { id ? S.sim.alerts.ack(id) : S.sim.alerts.ackAll(); return simSnap(S.sim.step(0)); },
  simSilence: () => { S.sim.alerts.silence(); return { ok: true }; },
  elevWindow: ({ r0, c0, r1, c1, step }) => {
    const g = S.T.grid, e = S.T.f32("elev_dm");
    const nr = Math.floor((r1 - r0) / step) + 1, nc = Math.floor((c1 - c0) / step) + 1;
    const z = new Float32Array(nr * nc);
    for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) z[i * nc + j] = e[(r0 + i * step) * g.width + c0 + j * step];
    return { z, nr, nc, r0, c0, step };
  },
  regionalWindow: ({ step }) => {
    const g = S.T.regGrid, e = S.T.f32("reg_elev_dm");
    const nr = Math.floor((g.height - 1) / step) + 1, nc = Math.floor((g.width - 1) / step) + 1;
    const z = new Float32Array(nr * nc);
    for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) z[i * nc + j] = e[i * step * g.width + j * step];
    return { z, nr, nc, step, grid: g.toJSON() };
  },
  simPin: ({ note }) => { S.sim.pin(note); return simSnap(S.sim.step(0)); },
  simAbort: () => { S.sim.abort("crew commanded return"); return simSnap(S.sim.step(0)); },
  cuecard: ({ route, title }) => cueCardHTML(S.plan.routes[route], { departMs: S.cfg.departMs, lon: S.cfg.base.lon, profile: S.cfg.profile,
    routeName: route, title, clock: S.clock, siteName: S.T.site.name, terrainSource: terrainSource() }),
  geojson: () => routeGeoJSON(S.plan.routes, { site: S.T.site.name, profile: S.cfg.profile }),
  simLog: () => ({ events: S.sim?.events ?? [], alerts: S.sim?.alerts.log ?? [] }),
};

self.onmessage = async (e) => {
  const { id, type, ...args } = e.data;
  try {
    const result = await handlers[type](args);
    const transfer = result?.rgba ? [result.rgba.buffer] : [];
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err), stack: String(err?.stack || "") });
  }
};
