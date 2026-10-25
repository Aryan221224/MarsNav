// replan.js - receding-horizon re-planning during an EVA (research doc 34).
// When telemetry shows the crew or the hardware behaving differently from the model, re-plan the rest of the EVA from
// the current estimated state with the recalibrated model. The same hard limits and the walkback guarantee apply; if
// the remaining stations no longer fit, drop the lowest-value one and try again; if none fit, go home.

import { Planner } from "./planner.js";
import { namedWeightSets } from "./ahp.js";

/**
 * @param ctx   { model0 (CostModel at pre-EVA calibration), base, departMs, evaMaxS, rescue, weights, refs }
 * @param state { lon, lat, t (s since departure), res (used so far), sigma }
 * @param stops remaining stations [{ lon, lat, name, dwell_min, value, kind }]
 * @param cal   learned calibration { met, speed, water, batt, leakKgPerH }
 * @param opts  { rebuiltModel: a model rebuilt with new terrain (slip) data, minMargin: required walkback margin }
 * @returns { ok, planner, sortie, dropped: [names], shortened: [{ name, from, to }], reason, ms }
 */
export function replanFrom(ctx, state, stops, cal, opts = {}) {
  const t0 = Date.now();
  const base = opts.rebuiltModel || ctx.model0;
  const merged = { ...base.s.cal };
  for (const k of ["met", "speed", "water", "batt", "co2"]) if (Number.isFinite(cal?.[k])) merged[k] = (base.s.cal[k] ?? 1) * cal[k];
  if (Number.isFinite(cal?.leakKgPerH)) merged.leakKgPerH = cal.leakKgPerH;
  const model = base.recalibrated(merged);
  const planner = new Planner(model, ctx.base, { departMs: ctx.departMs, evaMaxS: ctx.evaMaxS, rescue: ctx.rescue });
  const W = ctx.weights || namedWeightSets().balanced;
  const refs = ctx.refs || { T: 3600, S: 1000, C: 1, R: 1000, V: 1000 };
  const start = { lon: state.lon, lat: state.lat, name: "Current position" };
  const state0 = { t: state.t, res: state.res, sigma: state.sigma };
  let remaining = stops.map((s) => ({ ...s, dwell0: s.dwell0 ?? s.dwell_min }));
  const dropped = [], shortened = [];
  for (;;) {
    // a one-way sortie keeps its end point; with no station left, or on a safety re-plan, the crew heads home
    const end = remaining.length && ctx.end && ctx.end !== "base" && !opts.forceHome ? ctx.end : "base";
    const so = planner.planSortie(remaining, W, refs, { start, state0, end });
    if (opts.trace) opts.trace.push({ stops: remaining.map((x) => x.name), ok: so.ok, feasible: so.feasible, minMargin: so.minMargin, reason: so.reason });
    // accept only with some room left, so small estimation noise does not trigger another re-plan straight away
    if (so.ok && so.feasible && (!remaining.length || so.minMargin >= (opts.minMargin ?? 0))) {
      return { ok: true, planner, sortie: so, dropped, shortened, stops: remaining, reason: null, ms: Date.now() - t0, model };
    }
    if (!remaining.length) {
      return { ok: false, planner, sortie: so.ok ? so : null, dropped, shortened, stops: [], reason: so.reason || "cannot reach the habitat within limits",
        ms: Date.now() - t0, model };
    }
    // the lowest-value station gives way first: its work is cut to half the planned time (a shortened station still
    // returns samples and context), and only if that is not enough is it dropped
    let worst = 0;
    remaining.forEach((s, i) => { if ((s.value ?? 0.3) < (remaining[worst].value ?? 0.3)) worst = i; });
    const w = remaining[worst], half = Math.round(w.dwell0 / 2);
    if (opts.shorten !== false && w.dwell_min > half && half >= 10) {
      shortened.push({ name: w.name, from: w.dwell_min, to: half });
      remaining = remaining.map((s, i) => (i === worst ? { ...s, dwell_min: half } : s));
      continue;
    }
    dropped.push(w.name);
    remaining = remaining.filter((_, i) => i !== worst);
  }
}
