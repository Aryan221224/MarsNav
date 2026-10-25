// telemetry.js - one telemetry format for simulated and real hardware: NASA SUITS Telemetry Stream Server (TSS) JSON
// (research doc 31). The built-in simulator emits TSS-shaped frames; a live TSS (via tools/tss_bridge.mjs) is read the
// same way, so everything downstream (estimators, navigation filter, alerts, re-planning) is identical in both cases.

import { SUIT } from "./physio.js";

/** Read a TSS EVA.json (2026 nested `telemetry.eva1|eva2` or 2027 flat `telemetry`) and ROVER.json into one frame. */
export function parseTSS(eva, rover = null, { crew = "eva1", origin = null, t = null } = {}) {
  const tel = eva?.telemetry?.[crew] ?? eva?.telemetry ?? {};
  const num = (...keys) => { for (const k of keys) if (Number.isFinite(tel[k])) return tel[k]; return null; };
  const imu = eva?.imu?.[crew] ?? eva?.imu ?? null;
  const frame = {
    t: t ?? num("eva_elapsed_time", "eva_time") ?? 0,
    suit: {
      o2Pct: num("oxy_pri_storage"), o2SecPct: num("oxy_sec_storage"), o2Psi: num("oxy_pri_pressure"),
      battPct: num("primary_battery_level", "battery_level"), battSecPct: num("secondary_battery_level"),
      scrubPct: Math.max(num("scrubber_a_co2_storage") ?? 0, num("scrubber_b_co2_storage") ?? 0),
      waterPct: num("coolant_storage"), hr: num("heart_rate"), suitPsi: num("suit_pressure_total"),
      helmetCo2Psi: num("helmet_pressure_co2", "helmet_pressure_cO2"), tempC: num("temperature"),
      fanRpm: num("fan_pri_rpm"),
    },
    errors: { ...(eva?.error || {}) },
    imu: imu && Number.isFinite(imu.posx) ? { x: imu.posx - (origin?.x ?? 0), y: imu.posy - (origin?.y ?? 0), heading: imu.heading } : null,
  };
  const pr = rover?.pr_telemetry;
  if (pr) {
    frame.rover = { x: pr.rover_pos_x - (origin?.x ?? 0), y: pr.rover_pos_y - (origin?.y ?? 0), heading: pr.heading, pitch: pr.pitch,
      roll: pr.roll, speed: pr.speed, distance: pr.distance_traveled, battPct: pr.primary_battery_level ?? pr.battery_level,
      incline: pr.surface_incline, lidar: pr.lidar, o2Pct: pr.oxygen_storage, cabinPsi: pr.cabin_pressure };
  }
  return frame;
}

/** Map TSS error flags to the alert system's fault keys. */
export function faultsFromTSS(frame) {
  const e = frame.errors || {};
  const f = {};
  if (e.oxy_error) f.leak = true;
  if (e.fan_error || e.scrubber_error) f.cooling = true;
  if (e.power_error) f.power = true;
  return f;
}

/**
 * Build a TSS-2027-shaped EVA.json from the simulator's true state, with sensor noise and TSS rounding. This is what the
 * suit would send; the estimators never see the simulator's internals.
 * s = { t, used: {o2, co2, water, batt} (kg, kg, kg, Wh), hw (fills), metW, hrCal, pos: {x, y}, heading, rand }
 */
export function tssFrameFromSim(s) {
  const n = (sd) => (s.rand() + s.rand() + s.rand() - 1.5) * 2 * sd; // ~N(0, sd)
  const pct = (fill, used, cap) => Math.max(0, Math.round((100 * (fill - used / cap) + n(0.02)) * 100) / 100);
  const o2Pct = pct(s.hw.o2Fill, s.used.o2, SUIT.o2Kg);
  const hr = Math.round((s.metW - s.hrCal.a) / s.hrCal.b + n(3));
  return {
    telemetry: {
      primary_battery_level: pct(s.hw.battSOH, s.used.batt, SUIT.batteryWh), secondary_battery_level: 100,
      oxy_pri_storage: o2Pct, oxy_sec_storage: 100, oxy_pri_pressure: Math.round(o2Pct * 30), oxy_sec_pressure: 3000,
      suit_pressure_oxy: 4.0, suit_pressure_co2: 0.02, suit_pressure_other: 0, suit_pressure_total: 4.02,
      helmet_pressure_co2: 0.03, fan_pri_rpm: 30000, fan_sec_rpm: 30000,
      scrubber_a_co2_storage: Math.round(100 * (s.used.co2 / SUIT.co2CapKg + (1 - s.hw.scrubCap)) * 100) / 100, scrubber_b_co2_storage: 0,
      temperature: 21, coolant_storage: pct(s.hw.waterFill, s.used.water, SUIT.waterKg),
      coolant_gas_pressure: 0, coolant_liquid_pressure: 500, heart_rate: Math.max(50, Math.min(190, hr)),
      oxy_consumption: 0.1, co2_production: 0.1, eva_elapsed_time: Math.round(s.t),
    },
    status: { started: true },
    error: { fan_error: false, oxy_error: !!s.faults?.leak, power_error: false, scrubber_error: !!s.faults?.cooling },
    imu: { posx: Math.round(s.pos.x * 100) / 100, posy: Math.round(s.pos.y * 100) / 100, heading: Math.round(s.heading * 10) / 10 },
  };
}
