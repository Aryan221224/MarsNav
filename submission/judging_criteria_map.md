# Judging criteria map

The five Space Apps judging criteria, and the evidence in this project for each. Criteria are from the official Judging & Awards Guide: Influence, Creativity, Validity, Relevance, Presentation.

## Influence: how much can this project matter?

- It addresses the problem NASA will face before the first crewed EVA on Mars: planning and flying a Marswalk with no GPS, a 3 to 22 minute light delay, finite suit consumables and terrain that has already trapped rovers.
- It is site-agnostic. Landing mode screens 66 candidate sites anywhere on Mars against NASA's human landing-site criteria and turns the chosen one into a full EVA site; any site with a DEM becomes plannable (docs/07).
- It is built to be adopted: a portable Windows desktop app that needs no installation, a Local mode and Mars mode that run with no internet at all, open data with SHA-256 checksums, open source, deterministic, and an engine that runs in a browser, on a server or on a rover computer.
- It connects to NASA's own hardware interface today: it reads SUITS Telemetry Stream Server frames, has been run against a TSS2027 build, and uplinks every re-plan for a helmet display.
- It also serves robotic missions today. The robotic-scout profile plans Perseverance-class drives, and the hazard layer agrees with JPL's route choices.

## Creativity: what is new?

- **Hard limits first, with a walk-home guarantee inside the search.** Every partial route is dropped the moment the crew could not walk home with what is left. That is NASA's walkback rule made into an algorithm.
- **Soft soil priced by its tail (CVaR), not its mean**, which is Spirit's failure mode.
- **Position error as a planning input.** The cliff and keep-out stand-offs grow where dead reckoning will have drifted, and navigation-aid scenarios (dead reckoning, habitat beacon, orbital constellation) change the plan.
- **Walking-scale terrain from 1 m DTMs**: the slope a boot meets, not the 20 m slope, plus an orientation-coherence detector for ripples and TARs.
- **Data honesty built in**: a DEM blunder screen, mosaic-seam repair (found and fixed a real 18 m seam), per-product noise removal, and confidence and "check on imagery" flags on every route.
- **Defensible weights**: AHP with a live consistency ratio and a 40-run sensitivity analysis, instead of an arbitrary danger score.
- **A closed loop with the hardware.** Telemetry teaches the planner how hard the crew is working and how the suit is draining; the forecast re-plans from the crew's real position, waits for certainty unless the margin or a station start forces a decision, and cuts a station short before dropping it.
- **Mars navigation, not GPS**: an extended Kalman filter fusing dead reckoning, sun heading, landmark map matching and beacon ranging, with its error ellipse on the map.
- **The crew states the work**: time, intensity, tools and extra consumables per station, budgeted into the whole round trip.
- **Science first, then the route**: objectives rank every candidate site by the catalogued minerals, ice and activity near it, and the dossier says what lies within 100 km.
- **Navigation decides access**: at Mount Sharp the same cliffs leave 17 % of the site reachable with dead reckoning and 54 % with an orbital navigation constellation; MarsNav shows why, and puts the hub where a pressurised rover can park.
- **One EVA, every display**: the planner's closed loop drives a visor HUD, a rover dashboard and a wrist cuff at once, and the cuff's commands act on the loop.
- **Every layer, any place**: one click anywhere on Mars, or on a built site, shows all the data at that point. That covers ground, ice, minerals, air, water's boiling point, dose, gravity, science and missions nearby, and the local time and sun. The crew displays carry the same facts for the ground under the crew.

## Validity: is it scientifically and technically sound?

- Validated against Perseverance's own records: sun geometry (0.086° over 5,616 samples), terrain registration (0.2 ± 0.4 m), slope vs chassis tilt (r = 0.72), false no-go (2 %), and hazard agreement with JPL's route choices (21 of 30); the same trips as the rover on 45 drives, with what MarsNav still gets wrong reported (`validation/ROVER_CASE_STUDY.md`).
- The negative result is reported: route geometry does not beat a straight line against the rover's drives.
- 118 automated tests (65 engine and loop, 53 pipeline, downloader, science atlas and place), including the planner's safety contract on real terrain, navigation-filter consistency (NEES), estimator convergence, the UDP bridge over real sockets, and exact-vs-heuristic station selection.
- A paired 40-EVA campaign with a Wilcoxon test: 0 of 40 reserve dips with the closed loop against 31 of 40 without (p < 0.001), with the science cost reported too.
- A rebuild from raw data is byte-identical.
- Every constant is tagged by origin (`[SRC]`, `[CALIB]`, `[ASSUME]`, `[PHYS]`), and the limits are stated (docs/08).

## Relevance: does it answer this challenge?

The challenge statement, point by point (docs/06 has the full trace):

| Challenge asks for | MarsNav |
|---|---|
| "a layered, integrated view of a location or route" | 11 layers, no-go map, traverse, routes with uncertainty corridors, and a timeline profile |
| "data from multiple NASA science missions" | MRO (HiRISE, CTX), MGS (MOLA datum), Mars 2020 (MEDA, traverse, tilt), MSL (RAD), Apollo (walking) |
| "details of their routes and destinations" | Guidance legs, target provenance, station procedures |
| "updates on current conditions" | Live Mars clock, sun, shade and temperature along the route, dust τ, radio line of sight, position error, and live suit and rover telemetry with learned rates |
| "complete their mission quickly and safely" | Five named routes under hard limits, walkback margins, caution and warning |
| "plan and carry out a successful Marswalk" | Plan and Execute modes, with Review after |
| "conducting new and exciting science along the way" | Real sample sites (including Cheyava Falls), science-value optimiser, procedures |
| "a location... boxwork formations... Mount Sharp" | The Mount Sharp boxwork EVA site with Curiosity's drill sites; seven science objectives ranking every candidate |
| "at least three kinds of data" | Optical, thermal, spectral, topographic, geophysical, atmospheric, radiation and chemical layers, whole planet (docs/12) |
| "include space weather data" | NASA DONKI CME arrivals at Mars, particle events, flares; EVA advisory; dose by altitude |
| "a heads-up display on the helmet visor... a tablet" | Helmet-visor HUD, rover dashboard, wrist cuff, habitat console |
| "point-of-view images" | The rover's own photographs from each station |
| "a map... tool or interface for astronauts" to know a location | Every layer at any point clicked on Mars or on a site (`/api/place`), on screen and on the visor, dashboard and cuff |

## Presentation: how well is it communicated?

- A desktop app with a mission-console display informed by NASA-STD-3001, loaded with real Jezero data and the whole planet in Landing mode. It includes a 3D view that walks the planned route at eye height against the real crater skyline, with the live walk-home margin. There is a one-click demo EVA to the delta front where Perseverance cored Mageik.
- A 55-page illustrated user guide (`MarsNav_User_Guide.pdf`), a 30-second video script and a 2-minute walkthrough (`submission/demo_script.md`).
- Focused documents: concept of operations, architecture, algorithms, data, verification, traceability, deployment, and limits.
