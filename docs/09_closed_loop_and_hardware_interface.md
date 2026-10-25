# 09 Closed loop and hardware interface

This document covers how MarsNav reads suit and rover hardware during an EVA, what it learns from that data, how it tracks position without GPS, and when and how it re-plans. It is also the interface specification for connecting a real suit, rover or telemetry server. Background research is in research docs 31 to 34 (suit telemetry, rover sensors, Mars navigation, closed-loop algorithms).

## 1. The loop

```
 suit / rover hardware ──► TSS JSON frames ──► navigation filter ─────────► position + 2σ ellipse
 (or the simulator)            │                 (nav.js)
                               ├──────────────► estimators ─────────────► learned rates ± σ
                               │                 (estimator.js)             (work, water, battery, CO₂, pace, slip)
                               ▼
                         forecast of the rest of the plan at the learned rates (sim.js _monitor)
                               │ breach certain, or margin thin, or station work about to start
                               ▼
                         re-plan from the current position and state (replan.js)
                               │ same hard limits and walkback rule; shorten, then drop, the lowest-value station
                               ▼
                         new route to the crew display (and to GET /plan on the bridge)
```

The simulator and a live telemetry stream feed the same code. `EvaSim` (sim.js) holds a hidden "truth" and emits only what hardware would emit; `LiveSession` (live.js) takes frames from a real server. Everything the crew sees comes from measurements, never from the simulator's truth.

## 2. Telemetry format

The native format is the NASA SUITS Telemetry Stream Server (TSS) JSON, so the same parser reads the simulator, a TSS test instance and test-week hardware.

| Field (TSS) | Used as | Notes |
|---|---|---|
| `telemetry.oxy_pri_storage` (%) | O₂ level | Rate filtered by a two-state Kalman filter (level, rate) |
| `telemetry.primary_battery_level` (%) (`battery_level` in 2026) | Suit battery | |
| `telemetry.coolant_storage` (%) | Cooling water | A channel that reads 0 from the first frame is flagged NOT REPORTED and the model value stands in, with a caution |
| `telemetry.scrubber_a_co2_storage`, `_b_` (%) | CO₂ bed loading | The larger of the two |
| `telemetry.heart_rate` (bpm) | Metabolic rate (heart-rate channel) | W = a + b·bpm, per-crew calibration (default a = -330, b = 5.5) |
| `telemetry.eva_elapsed_time` (s) | Mission time | Falls back to bridge wall time before the EVA timer starts |
| `imu.posx`, `imu.posy`, `imu.heading` | Position fix | Mapped to the site by an anchor (below) |
| `error.oxy_error`, `fan_error`, `power_error`, `scrubber_error` | Faults | Raise the matching caution and warning |
| ROVER.json `pr_telemetry.rover_pos_x/_y`, `primary_battery_level`, `speed`, `distance_traveled` | Rover position and battery | TSS2026 layout |

Layouts: TSS2027 serves a flat `telemetry` block; TSS2026 nests it under `telemetry.eva1` and `telemetry.eva2`. `parseTSS` reads both.

**Anchor.** TSS positions are in the simulator's or the suit's own frame. The anchor maps them to the site projection: `{ tssX, tssY, x | lon, y | lat, scale, rotDeg }`. With no anchor, the first fix is taken as the habitat and TSS units as metres, east and north. Calibrate the anchor at the airlock before egress.

## 3. Transport and the bridge

Browsers cannot send UDP, and TSS only answers UDP. `tools/tss_bridge.mjs` polls TSS and relays frames to the app.

| Link | Protocol |
|---|---|
| Bridge to TSS | UDP. Request 8 bytes, big-endian: `uint32 timestamp`, `uint32 command`. Reply: the JSON file's bytes. TSS2027: command 0 = EVA.json. TSS2026: 0 = ROVER.json, 1 = EVA.json. Only GET commands (below 1000) are ever sent. |
| Ports | TSS2027 answers telemetry on its per-team sockets, 14142 to 14151 (team 0 = 14142). The main port 14141 serves the web page. |
| Rate | TSS recomputes values once per second. It handles about one datagram per team socket per second, so poll at 1 Hz or slower. |
| Bridge to app | Server-Sent Events at `GET /events` (event `tss`, one frame each), plus `GET /latest`, `GET /health`. CORS open, Private-Network-Access header set. |
| Plan uplink | The app posts every new plan to `POST /plan`; a helmet display reads it at `GET /plan`. In `--demo`, the simulated crew follows it. |

Run: `node tools/tss_bridge.mjs --tss 192.168.1.20:14142 --year 2027`, or `--demo --truth hardwork --rate 20` for a stand-in. Live mode works from the locally served app (`python3 -m http.server`); a hosted copy of the app cannot reach a local bridge.

## 4. Navigation without GPS

`NavFilter` is an extended Kalman filter on east, north and IMU heading bias. It follows what Mars rovers do.

| Source | Model | Update |
|---|---|---|
| Dead reckoning | Step or wheel distance at IMU heading, 2 % distance noise, heading bias random walk 3°/h | Propagate |
| Sun heading | Sun sensor or camera, σ 1.5° | Observes the heading bias, every 10 min with the Sun above 5° |
| Landmark map match | Orbital-map match on a distinctive landmark, σ 1 m (Perseverance Mars Global Localization class) | Position fix within 150 m of a landmark |
| Habitat beacon | Two-way radio range, σ 1 m, in line of sight | Range fix every 60 s |
| Navigation constellation (future) | Position fix σ 3 m | Every 60 s |
| Suit or rover telemetry (live) | The hardware's own navigation solution, σ 3 m | Every frame, with process noise for the fastest plausible motion |

A chi-square gate (99.9 %) rejects fixes that jump further than the filter allows; after three rejections in a row the filter re-acquires at the new position and logs it. Consistency is tested: mean 2-D NEES is near 2 over 200 Monte Carlo walks.

## 5. What is learned

| Quantity | Method |
|---|---|
| Work rate (O₂) | Measured O₂ drain over a 2 to 15 minute window divided by the model's drain for the same activity over the same time; fused with the heart-rate channel by inverse variance for the displayed metabolic rate |
| Cooling water, suit battery, CO₂ loading | The same windowed ratio per channel |
| Walking pace | Distance made good along the plan divided by what the model expected in the same time |
| Rover slip | 1 - visual odometry / wheel odometry per frame; a recursive least-squares model of slip against terrain features (sand fraction, slope, sand class), plus a local Gaussian-kernel update near each measurement |
| Wheel health | Wear by ground class (Curiosity wheel tests), and a motor-current flag at twice the other wheels' mean (Spirit's failing wheel) |

Factors are bounded to 0.25 to 8 (a leak or a dead cell can be far off the model), carry a standard deviation, and are reported against the model's pre-EVA calibration. When the plan is rebuilt, water and CO₂ factors are passed as residuals over the work-rate factor, so a hard-working crew is not counted twice.

## 6. When it re-plans

| Trigger | Rule |
|---|---|
| Forecast breach | The rest of the plan at the learned rates (walking time scaled by the learned pace, station work at its stated length, the suit leak not scaled by work rate) would use more than 99 % of a consumable's usable capacity, or overrun the time limit |
| Last responsible moment | An uncertain breach (it disappears when every factor is 2σ kinder) waits for better estimates, unless the walkback margin is under 10 % or station work is due to start within 10 minutes |
| Drift | A learned rate differs from the one the plan uses by more than 0.15 with σ under 0.1 (at most every 30 min) |
| Off route | Cross-track error over 2σ + 40 m |
| Rover slip check | Measured slip over 40 % and 20 points above the model |

The re-plan runs the full planner from the estimated position and the measured state, with the same hard limits, the same walkback rule and the reference scales of the original plan. It needs a 5 % margin to accept a plan. If the remaining stations do not fit, the lowest-value station's work is cut to half (its stated tool energy and extra consumables scale with it), and only then dropped. If nothing fits, the crew is sent home on the walkback route.

**Dead band.** A drift re-check that keeps every station and would save less than 8 % of the remaining time leaves the crew on the route they are walking; only the walkback limits are updated. Changing a crew's route for a small gain is churn.

## 7. Results

**Paired campaign** (`validation/CLOSED_LOOP.md`). 40 EVAs, each flown twice with the same random numbers: with the loop, and flying the filed plan with the caution and warning system still active.

| | Closed loop | Open loop |
|---|---|---|
| Runs that dipped into the reserve | 0 of 40 | 31 of 40 |
| Lowest usable consumable left, mean | 24.6 % | -5.1 % |
| Science done without touching the reserve | 0.64 | 0.29 |

Wilcoxon signed-rank on the lowest consumable left: p < 0.001. Raw science is lower with the loop (0.64 against 0.90), because the open-loop crew often finishes a station on reserve O₂ or battery.

**Against NASA's TSS2027 server.** The TSS2027 server was built from its public source, its EVA started through its web interface, and the crew position was played into it with the TSS-Location-App commands (2017, 2018) along the plan. `tools/tss_check.mjs` read it through the bridge. The test-week suit in that build drains its battery at 0.05 %/s and fills scrubber A at 0.13 %/s, far faster than a real EVA. Within about two minutes the loop had learned battery and CO₂ loading at the 8x bound and O₂ at about 4x, dropped both stations and sent the crew home; it also flagged the build's coolant channel (fixed at 0) as not reported rather than treating it as an empty tank. Log: `validation/results/tss2027_live_check.txt`.

## 8. Limits

The simulator and the estimators share the same physics, so the campaign measures the loop's logic, not the physics. TSS carries no wheel or visual odometry, so live rover slip learning needs a rover that publishes both. Heart-rate calibration is per crew member and the default is an assumption. Quantum algorithms were assessed (research doc 34) and none helps at this problem size; see docs/11.
