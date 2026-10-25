// alerts.js - caution & warning logic, modelled on NASA-STD-3001 Vol 2 Appendix F (F.6.4) as summarised in research
// docs 15 and 17: three priorities (WARNING red, CAUTION amber, ADVISORY cyan), every alert has text + icon + tone,
// alerts latch until acknowledged, one action silences the tone, the count per class is always visible.
// Thresholds are the team's assumptions [ASSUME] unless noted.

export const LEVEL = { WARNING: 3, CAUTION: 2, ADVISORY: 1 };
export const LEVEL_NAME = { 3: "WARNING", 2: "CAUTION", 1: "ADVISORY" };

/**
 * Evaluate the rule set on a crew state snapshot. Returns [{ id, level, text, action }].
 * state = { margins: {time,o2,co2,water,batt} (fraction of usable capacity left after the walk home; time in s),
 *           remaining: {o2,co2,water,batt} (fraction of usable left), sigma (m), crossTrack (m), offRoute, vetoHere,
 *           sunsetMinLeft, losLostMin, slopeAhead (deg), cold (bool), spe (bool), faults: {...} }
 */
export function evaluateRules(s) {
  const out = [];
  const add = (id, level, text, action) => out.push({ id, level, text, action });
  const m = s.margins || {};
  const worst = Math.min(m.o2 ?? 1, m.co2 ?? 1, m.water ?? 1, m.batt ?? 1);
  const worstName = ["o2", "co2", "water", "batt"].reduce((a, k) => ((m[k] ?? 1) < (m[a] ?? 1) ? k : a), "o2");
  const NAMES = { o2: "OXYGEN", co2: "CO2 SCRUBBER", water: "COOLING WATER", batt: "SUIT BATTERY" };
  if (s.spe) add("spe", LEVEL.WARNING, "SOLAR PARTICLE EVENT - TAKE SHELTER", "Return to habitat now (walkback route loaded)");
  if (worst <= 0 || (m.time ?? 1e9) <= 0) {
    add("pnr", LEVEL.WARNING, `RETURN NOW - ${worst <= 0 ? NAMES[worstName] : "TIME"} AT WALKBACK LIMIT`, "Follow the return route");
  } else if (worst < 0.1 || (m.time ?? 1e9) < 900) {
    add("pnr-near", LEVEL.CAUTION, `WALKBACK MARGIN LOW - ${worst < 0.1 ? NAMES[worstName] : "TIME"}`, "Finish task, prepare to return");
  }
  for (const k of ["o2", "co2", "water", "batt"]) {
    const r = s.remaining?.[k];
    if (r == null) continue;
    if (r < 0.1) add(`low-${k}`, LEVEL.WARNING, `${NAMES[k]} BELOW 10 %`, "Return now");
    else if (r < 0.25) add(`low-${k}`, LEVEL.CAUTION, `${NAMES[k]} BELOW 25 %`, "Check return plan");
  }
  if (s.vetoHere) add("veto", LEVEL.WARNING, `HAZARD: ${s.vetoHere.toUpperCase()}`, "Stop. Back out along your track");
  if (s.offRoute) add("offroute", LEVEL.CAUTION, `OFF ROUTE ${Math.round(s.crossTrack)} M`, "Steer back to the corridor");
  if (s.sigma > 50) add("pos", LEVEL.CAUTION, `POSITION UNCERTAIN +/-${Math.round(2 * s.sigma)} M`, "Re-fix on the next landmark");
  else if (s.sigma > 30) add("pos", LEVEL.ADVISORY, `POSITION DRIFT +/-${Math.round(2 * s.sigma)} M`, "Re-fix when convenient");
  if (s.sunsetMinLeft != null) {
    if (s.sunsetMinLeft < 30) add("sunset", LEVEL.WARNING, `SUNSET IN ${Math.max(0, Math.round(s.sunsetMinLeft))} MIN`, "Return now");
    else if (s.sunsetMinLeft < 60) add("sunset", LEVEL.CAUTION, `SUNSET IN ${Math.round(s.sunsetMinLeft)} MIN`, "Plan return");
  }
  if (s.losLostMin > 10) add("comm", LEVEL.CAUTION, `NO RADIO LINE OF SIGHT ${Math.round(s.losLostMin)} MIN`, "Move to line of sight or relay pass");
  else if (s.losLostMin > 0) add("comm", LEVEL.ADVISORY, "NO RADIO LINE OF SIGHT", "Autonomous; habitat informed at next contact");
  if (s.slopeAhead > 15) add("slope", LEVEL.ADVISORY, `STEEP GROUND AHEAD ${Math.round(s.slopeAhead)} DEG`, "Short steps, watch footing");
  if (s.cold) add("cold", LEVEL.ADVISORY, "COLD SOAK - SUIT HEATER ON", "Keep moving; limit time in shadow");
  // closed loop: a consumable draining far faster than the model says is a hardware or crew-state problem
  if (s.drain) {
    const NM = { met: "OXYGEN USE", water: "WATER USE", batt: "BATTERY DRAIN", co2: "CO2 LOADING" };
    const hot = Object.entries(s.drain).filter(([k, v]) => NM[k] && v >= 1.5).sort((a, b) => b[1] - a[1]);
    if (hot.length) add("drain", hot[0][1] >= 2.5 ? LEVEL.CAUTION : LEVEL.ADVISORY, `${NM[hot[0][0]]} ${hot[0][1].toFixed(1)}x MODEL`, "Plan re-computed with the measured rate; check the hardware");
  }
  if (s.unreported?.length) {
    const NM = { o2Pct: "O2", battPct: "BATTERY", waterPct: "COOLING WATER" };
    add("unreported", LEVEL.CAUTION, `${s.unreported.map((k) => NM[k] || k).join(", ")} NOT REPORTED - MODEL VALUE SHOWN`, "Verify the level by voice or on the suit display");
  }
  if (s.faults?.leak) add("leak", LEVEL.WARNING, "SUIT PRESSURE DECAY", "Switch to secondary O2. Return now");
  if (s.faults?.cooling) add("cooling", LEVEL.CAUTION, "COOLING DEGRADED", "Reduce workload; watch water");
  if (s.faults?.injury) add("injury", LEVEL.CAUTION, "CREW MOBILITY REDUCED", "Pace halved; return plan updated");
  if (s.faults?.rover) add("rover", LEVEL.WARNING, "ROVER FAILURE - WALKBACK", "Walk home on the walkback route");
  if (s.faults?.dust) add("dust", LEVEL.ADVISORY, "DUST RISING - VISIBILITY AND POWER DOWN", "Stay on route; expect slower pace");
  return out.sort((a, b) => b.level - a.level);
}

/** Latching alert manager: new alerts latch, acknowledge per alert, one-action silence of the tone. */
export class AlertManager {
  constructor() {
    this.active = new Map(); // id -> { ...alert, since, acked }
    this.log = [];
    this.silenced = false;
  }

  update(alerts, t) {
    const now = new Set(alerts.map((a) => a.id));
    const raised = [];
    for (const a of alerts) {
      const prev = this.active.get(a.id);
      if (!prev) {
        const rec = { ...a, since: t, acked: false };
        this.active.set(a.id, rec);
        this.log.push({ t, event: "raised", ...a });
        raised.push(rec);
        if (a.level === 3) this.silenced = false; // a new warning always sounds
      } else if (a.level > prev.level || a.text !== prev.text) {
        Object.assign(prev, a, { acked: a.level > prev.level ? false : prev.acked });
        if (a.level > prev.level) raised.push(prev);
      }
    }
    for (const [id, a] of this.active) {
      if (!now.has(id)) {
        if (!a.cleared) this.log.push({ t, event: "cleared", id, level: a.level, text: a.text });
        // latching: a condition that clears before the crew has seen it stays on the list until acknowledged
        if (a.acked) this.active.delete(id);
        else a.cleared = true;
      } else if (a.cleared) {
        a.cleared = false;
      }
    }
    return raised;
  }

  ack(id) {
    const a = this.active.get(id);
    if (!a) return;
    a.acked = true;
    if (a.cleared) this.active.delete(id);
  }

  ackAll() {
    for (const [id, a] of this.active) {
      a.acked = true;
      if (a.cleared) this.active.delete(id);
    }
  }

  silence() {
    this.silenced = true;
  }

  counts() {
    const c = { 3: 0, 2: 0, 1: 0 };
    for (const a of this.active.values()) c[a.level]++;
    return c;
  }

  /** Highest unacknowledged level (drives the master alarm and flashing). */
  master() {
    let m = 0;
    for (const a of this.active.values()) if (!a.acked) m = Math.max(m, a.level);
    return m;
  }

  list() {
    return [...this.active.values()].sort((a, b) => b.level - a.level || a.since - b.since);
  }
}
