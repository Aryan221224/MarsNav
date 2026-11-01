# Requirements traceability

Each requirement, where it comes from, where it is implemented and how it is verified.

Source codes:

- **CH**: the Space Apps 2026 challenge statement.
- **SUITS**: NASA SUITS 2026-27 crew navigation requirements (research doc 17).
- **STD**: NASA-STD-3001 Vol 2 Appendix F as summarised in research docs 15 and 17. The display is informed by it, not certified to it.
- **R-nn**: our research document number.

Verification codes: **T** = automated test, **V** = validation on real data, **D** = demonstrated in the app (headless browser check), **I** = inspection.

## Challenge statement

| ID | Requirement | Source | Implementation | Verified |
|---|---|---|---|---|
| C1 | A layered, integrated view of a location or route on Mars | CH | 11 map layers + no-go, traverse, landmarks, alternatives; timeline of elevation, margin, sun and shade | D |
| C2 | Data from multiple NASA science missions | CH | MRO HiRISE, CTX, CRISM and gravity; MGS MOLA and TES; Odyssey THEMIS and GRS; Mars Express HRSC and OMEGA; Mars 2020 MEDA, traverse and images; MSL RAD, traverse and images; Viking; Apollo walking data | I (docs/04, docs/12) |
| C3 | Help a human plan a Marswalk | CH | Plan mode: stations, optimiser, five named routes under hard limits, cue card | T, D |
| C4 | Help a human carry out a Marswalk | CH | Execute mode: glance band, consumables, alerts, procedures, voice, pins, automatic and two-step return | T, D |
| C5 | Details of routes and destinations | CH | Guidance legs (heading, distance, time, climb, arrival LMST, margin); target provenance | D |
| C6 | Updates on current conditions | CH | Live Mars clock (sol, LMST, Ls, sun), sun and shade along the route, MEDA climatology by season and hour, dust τ, radio line of sight, position error | T, V |
| C7 | Complete the mission quickly and safely | CH | Multi-criteria routes with hard vetoes and a walkback guarantee | T, V |
| C8 | New science along the way | CH | Science criterion V, real sample-site targets, sortie optimiser by science value, station procedures | T, D |
| C9 | Science goals first, and a location for them (example: boxwork at Mount Sharp, Curiosity 2025) | CH 2026 | Seven science objectives ranking every candidate site; the Mount Sharp boxwork EVA site with Curiosity's drill sites (docs/12) | T, D |
| C10 | At least three kinds of data: optical, thermal, spectral, topographic, geophysical, atmospheric, radiation, chemical | CH 2026 | Whole-Mars science atlas grouped by kind: CRISM / OMEGA / TES minerals, GRS elements, MRO gravity, air pressure, cosmic-ray dose, plus optical, thermal and topographic bases | T, D |
| C11 | Space weather and the radiation environment | CH 2026 | NASA DONKI CME arrivals at Mars, particle events and flares with an EVA advisory; route dose from each step's elevation | T |
| C12 | A route that avoids obstacles for a suited crew carrying equipment | CH 2026 | Hard limits and walk-home guarantee (unchanged); cliff-bounded Mount Sharp as the hard case | T, V |
| C13 | Display formats: habitat, tablet, helmet-visor HUD | CH 2026 | Habitat console (planner), helmet visor HUD, rover dashboard and wrist cuff (`app/hud.html`), visor overlay in the drive window | D |
| C14 | Point-of-view images so the astronaut knows what to expect | CH 2026 | The rover's own photographs at each station (`tools/build_pov.py`) in the planner, station panel and cuff | D |
| C15 | Past and future missions behind the map | CH 2026 | Catalogue of 31 missions with status on 2026-10-28 and their use in MarsNav; future landing regions on the globe | T |

## SUITS 2026-27 crew navigation display

| ID | SUITS requirement | Level | Implementation | Verified |
|---|---|---|---|---|
| S1 | Suit and biomedical telemetry display | Shall | Consumables gauges (O₂, CO₂ scrub, cooling water, battery) with the walk-home need marked; O₂ in the glance band | D |
| S2 | 2D map with live asset locations | Shall | Crew position with its 2σ error, habitat, rover asset, traverse, targets | D |
| S3 | Pin dropping | Shall | "Drop pin" button and "drop pin" voice or text intent: estimated position + error circle + event log | T, D |
| S4 | Breadcrumb | Shall | Flown track drawn live; return route along the walkback tree | D |
| S5 | Procedures per point of interest | Shall | Station procedure checklist with current and completed steps | T, D |
| S6 | Natural-language voice assistance | Shall | Offline intent parser (oxygen, water, battery, time home, position, next stop, sunset, alerts, pin) with spoken replies from known state only; "not understood" otherwise | D |
| S7 | Caution and warning | Shall | Alert manager (see STD rows) | T |
| S8 | Consumables-aware maximum range prediction | Shall | "EVA range" layer from the walkback field and every tank | T, D |
| S9 | Best-path navigation | Should | Named routes, guidance legs, cue card | T |
| S10 | Points-of-interest aids | Should | Target cards with source and reason, landmarks for re-fix | D |
| S11 | 3D map | Should | 3D view: orbit and eye-height helmet modes on the real DEM, real skyline and sun, route walk-through with live margins | D |

## NASA-STD-3001 Appendix F (display and alerting)

| ID | Rule | Implementation | Verified |
|---|---|---|---|
| F1 | Three alert priorities, colour + icon + text + tone | WARNING red ▲, CAUTION amber ■, ADVISORY cyan ●, tones by level | T, D |
| F2 | Alerts latch until acknowledged; single-action silence; counts visible | Latching with a CLEARED tag, per-alert and all acknowledge, one-press silence, W/C/A counters in the top bar | T |
| F3 | A new warning always sounds | The silence flag resets on a new WARNING | T |
| F4 | Synchronised flashing, 0.8 Hz caution and 3 Hz warning | One clock drives all flashing elements | I |
| F5 | Status colours reserved | Red, amber, green, cyan only for status; violet for uncertainty; the route is white with a dark casing | I |
| F6 | Numbers with units, fixed-width digits, 24 h time or MET | IBM Plex Mono tabular digits, units on every value, LMST and MET | I |
| F7 | Critical actions take two steps | "Return now": arm, then confirm within 5 s | D |
| F8 | Show what the software is doing | Phase annunciator (PRE-EVA, EVA · SIM TLM, LIVE TLM, POST-EVA), busy states, "why this route" | D |
| F9 | Position confidence shown, never an exact dot | 2σ corridor on routes, error circle on crew and pins | D |

## Mission constraints from the research

| ID | Constraint | Source | Implementation | Verified |
|---|---|---|---|---|
| M1 | Human slope limit 20° | R-09, R-26 (NASA lunar traverse tool) | Slope veto, walking profile | T |
| M2 | Rover 25° bedrock, 12° sand | R-09, R-26 | Rover profile vetoes | I |
| M3 | Walkback rule | R-03 | Walkback field prunes every rover label | T |
| M4 | EVA 2 to 8 h, back before dark | R-03 | EVA limit input; time budget = min(limit, sunset − 30 min) | T |
| M5 | Soft soil priced by its tail, not its mean | R-26, R-28 | Slip distribution, CVaR veto at 0.7 | T |
| M6 | Planetary protection with a position buffer | R-26, R-27 | Keep-out bit 2, veto within 2σ | I |
| M7 | Mission hardware keep-out | R-27 | Sample depot (real positions, sols 653 to 690) and active rover | T |
| M8 | Suit evaporative cooling needs ≤ 7 to 8 Torr | R-03, R-06 | Site pressure envelope check at setup | T |
| M9 | Radiation dose per EVA | R-02, R-26 | Dose on route cards and the cue card at the RAD average | I |
| M10 | No GPS: position uncertainty drives the plan | R-08, R-21 | σ field in vetoes, drift and re-fix, navigation-aid scenarios | T |
| M11 | Execute must work offline (3 to 22 min light time) | R-01, R-17 | Static app, engine in a worker, offline service worker; live Earth–Mars light time in the top bar | T, D |
| M17 | Show where a plan fails, not just that it fails | R-06 (walkback geometry) | Point-of-no-return diagnosis with the limiting resource, drawn on the map and in 3D | T, D |
| M12 | Paper fallback | R-14, R-17 (Artemis practice) | Printable cue card | T |
| M13 | Defensible weights with a consistency check and sensitivity | R-27, R-28 | AHP editor with a live consistency ratio; 40-run sensitivity analysis in the validation | T, V |
| M14 | Three or more named routes (Earth navigation pattern) | R-18 to R-22 | Balanced, safest, fastest, economy, fallback | T |
| M15 | Location-agnostic software; Jezero for the demonstration | User's direction; R-30 | Site files, per-site projection, CTX-only test site, auto habitat and survey stations | T, D |
| M16 | Rover-safe is not human-safe | R-06 | Separate foot, rover and robot profiles with their own vetoes and consumables | T |

## Closed loop, hardware and task additions

| # | Need | Source | Design response | Verified by |
|---|---|---|---|---|
| M18 | Read the real suit and rover hardware during the EVA | User's direction; NASA SUITS TSS | TSS JSON (2026 and 2027 layouts) parsed natively; UDP bridge with SSE and plan uplink | T (UDP bridge test), D (run against a TSS2027 build) |
| M19 | Learn what the crew and hardware are really doing | Research docs 31, 32 | Windowed drain ratios per consumable, O₂ plus heart-rate metabolic fusion, pace from distance made good, rover slip model, wheel-current flag | T |
| M20 | Re-plan in real time from where the crew is | User's direction; research doc 34 | Forecast at learned rates, certainty test, last responsible moment, dead band, shorten-then-drop, walkback rule kept | T, V (40-run paired campaign) |
| M21 | Real-time navigation as on Mars (no GPS) | User's direction; research doc 33 | EKF with dead reckoning, sun heading, landmark map match, beacon range, constellation; chi-square gate and re-acquire | T (NEES test) |
| M22 | Crew states the work at a station and its consumables | User's direction | Per-station task: time, intensity, tool Wh, extra O₂ and water, budgeted into the round trip and shown per station | T, D |
| M23 | Rocky ground costs wheels, battery and safety | User's direction; Curiosity wheel tests | Motion resistance x1.35, slip energy, wheel-life metric, wear hazard weighted up on worn wheels, rocky share on route cards | T |
| M24 | Best station set, provably | QPath assessment | Held-Karp exact up to 15 candidates; QUBO beyond, measured against the exact optimum | T |
