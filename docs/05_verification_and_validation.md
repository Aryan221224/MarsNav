# Verification and validation

Verification checks that the software does what it was designed to do; validation checks that the design is right about Mars. Everything below can be rerun from the repository in about a minute.

| Command | What it runs | Result |
|---|---|---|
| `node --test tests/*.test.mjs` | Engine unit tests, integration tests on real Jezero data and the CTX-only site, closed-loop, navigation and bridge tests, Mars Year | 64 pass |
| `python3 -m pytest tests -q` | Pipeline tests (including Python/JS parity), the concurrent-download test, the science atlas, and the place lookup (charts, gravity, liquid water, offline, built sites, time at the place vs the Python Mars24 port, polar ice) | 53 pass |
| `node validation/validate.mjs` | Validation against Perseverance data | `validation/REPORT.md` |
| `node validation/closed_loop_campaign.mjs` | 40 paired closed-loop vs open-loop EVAs | `validation/CLOSED_LOOP.md` |
| `MarsNav.exe --selftest` (`selftest.bat`) | The desktop server under load for 150 s: map tiles, API, a route job; a raster worker and the server itself killed on purpose | Every check passes, including from an empty data folder (first run on a new PC) |
| `python tools/smoke_exe.py dist\MarsNav\MarsNav.exe` | Starts the built program as a user would, checks 16 pages and scripts, 9 APIs (bundled catalogues found, missions, objectives, candidates, atlas, space weather) and the place and elevation lookups, then stops it | All pass |
| GitHub Actions, `.github/workflows/windows-exe.yml` | On every push: builds `MarsNav.exe` on a clean Windows machine, runs the smoke test and `--selftest` on the built program, runs both test suites and the closed-loop campaign on Linux, then publishes `MarsNav-Windows.zip` | Run 2 (29 October 2026): all pass on Windows, including 10,837 requests under load with a worker and the server killed |
| Headless browser check (Playwright) | All four sites (plan, 3D, execute, review, the place card at any point). Landing mode (screen all, a candidate's place data, the dossier, every tab). The drive window. The three crew displays fed by a running EVA (maps drawn on terrain, place data present) | 29 of 29 pass, with no console errors (the fonts are part of the app, so nothing is fetched from the internet) |

## Verification

**Safety contract of the planner (integration tests on real terrain).** No planned point of any named route lies on a no-go cell. No route enters a keep-out. No suited route has a grade over 20°. The balanced route is feasible, finishes inside the time budget and never plans against the walkback reserve. The safest route carries no more hazard than the fastest. The sortie optimiser only proposes plans within its time, O₂ and battery budgets.

**Contingency behaviour.** A nominal simulated EVA ends at the habitat. A suit leak raises a WARNING, starts the return and brings the crew home sooner than finishing the plan would. A crew-commanded abort does the same, and pins and station procedures are driven by the simulation. The alert manager latches unacknowledged alerts that have cleared, and un-silences on any new warning.

**Infeasible plans.** Cheyava Falls on foot from the landing site is correctly rejected. The diagnosis puts the point of no return before halfway, confirms the crew can still walk home from it, reports the limiting resource and restores the crew limits afterwards.

**Walkback, rover and navigation logic.** The walkback field is zero at the habitat and grows with distance. The rover walkback rule limits range, and rescue-rover mode relaxes it. An orbital navigation constellation shrinks position error and the cliff stand-off.

**Physics and methods against published values.**

- Mars24 matches the Allison and McEwen (2000) worked example: Ls 277.18758°, MTC 23.99425 h.
- Perseverance's landing time falls at about 15:54 LMST, and the Earth–Mars light time at landing is 11 min 22 s, as NASA published.
- The Python and JavaScript clocks agree to 10⁻⁶ over 1970 to 2026.
- CVaR₀.₉ factor = 1.7550.
- Minetti cost at level = 2.5 J kg⁻¹ m⁻¹.
- AHP recovers exact weights from a consistent matrix and flags an inconsistent one.

**Pipeline on synthetic ground truth.**

- The walking-slope detector recovers a 12° plane within 0.05°.
- The bedform detector gives evidence above 0.6 on a 14 m ripple field and below 0.2 on isotropic rubble of the same amplitude.
- The blunder screen flags a spike and leaves a real 25° slope alone.
- The seam repair turns an 18 m mosaic step into a ramp under 10° and does not touch a nearby crater.
- Every shipped layer decodes to its grid, and every site file is valid and indexed.

**Reproducibility.** A full rebuild of Jezero from the raw USGS files (`build_terrain`, then `build_layers`, then `build_imagery`) gives byte-identical layers (SHA-256 of every decoded layer), identical imagery pixels and an identical climatology file. The refactor to site-agnostic code was checked the same way.

## Validation against real Mars data

| Question | Method | Result | Reading |
|---|---|---|---|
| Is our Mars clock right on Mars? | Sun position and LTST from Mars24 vs MEDA's own ancillary data, 5,616 samples on 117 sols | SZA error 0.001 ± 0.086° (95 % within 0.20°); LTST within 5 s | The sun, shade and sunset model are driven by a correct clock. The residual is the rover's distance from the landing site. |
| Is the terrain registered correctly? | DEM elevation at 480 rover localisations vs the rover's geoid elevation | 0.2 ± 0.4 m | Confirms warping, datum and projection handling. **Not independent**: JPL localises the rover against these same orbital maps. |
| Does our slope see what the rover felt? | Walking-scale slope (p90 in the 10 m cell) vs the rover's measured chassis tilt | At or above the tilt at 74 % of 480 points; r = 0.72 | Mostly conservative. In the other 26 % the chassis tilted more than the cell's p90 slope, probably from rocks under single wheels or slopes shorter than the 4 m baseline (not checked point by point). |
| Does the model forbid ground the rover crossed? | Veto rate at 703 real rover positions (keep-outs excluded, since they mark the rover itself) | 2 %, all cliff stand-offs | The stand-off includes a 2σ position-error buffer. The real rover had centimetre localisation, so a crew rule would be stricter by design. |
| Does our hazard map agree with where JPL chose to drive? | On 30 drives where the rover detoured (path at least 1.15 × the straight line, 0.4 to 2 km), mean hazard along the real path vs the straight line | 0.182 vs 0.208; the real path is lower on 21 of 30 | The hazard layer ranks JPL's chosen paths as safer than the direct line, which is independent evidence it captures real driving hazards. Our risk-aware route scores 0.111. |
| Does our route follow the rover's route? | Mean offset of our robotic-scout route from the real drive vs a straight line | 38 m vs 34 m (closer on 14 of 30) | **Negative result, reported as such.** Rover drives are shaped by science stops, AutoNav and sub-metre hazards. The public record has one point per drive end, so geometric match is a weak test. |
| Does the bedform layer see what the rover avoided? | Share of strong-bedform cells on the rover path vs its 1 km corridor | 3 % vs 7 % | The rover avoided ripple fields that the detector finds (Séítah's ripples and the TARs to the south). |
| What does MarsNav plan for a trip the rover really made? | Same start and end as real drives; every route measured on the same 1 m terrain layers (`validation/rover_case_study.mjs`, `validation/ROVER_CASE_STUDY.md`) | Séítah to the delta front: rover 7.1 km over 85 sols, MarsNav 3.07 km planned in under a second (crew on foot: 2.92 km, 1.4 h). Over 45 drives MarsNav crosses 47 % less mapped sand, 55 % less rocky ground and 39 % less ground over 15°, with a lower peak slope on 33. Its speed model reproduces the rover's measured 79.7 m/h on the real route (79 m/h) | Wheels count bedforms as a hazard, a self-driving rover slows in clutter measured on 25 cm HiRISE images, and crew-only criteria are not weighted for a robot. Séítah still reads only 1.5x slower per metre against JPL's projected 4x, so MarsNav still prefers the short corridor for a rover. |
| Are the weights defensible? | AHP consistency, and 40 random log-normal perturbations (σ = 0.4) of every top-level judgement | CR ≤ 0.009; 100 % of runs keep at least 80 % of the balanced route within 30 m; EVA time 3.88 to 3.97 h | The route is robust to reasonable disagreement about priorities. |

**Weather model fit** (`validation/results/meda_fit.json`): air temperature RMSE 4.1 K, ground 6.1 K, atmospheric sensor 3.3 K, pressure 4.3 Pa, all from about 5,600 MEDA samples. The fitted pressure scale height of 11.7 km is physical.

## What is not validated (and cannot be yet)

- **Suited human performance on Mars.** Walking speed, metabolic cost, suit consumption and the 20° limit are Apollo, lunar and analogue values scaled to Mars. No human has walked on Mars.
- **Crew rover behaviour.** No crew rover exists. The profile uses study values.
- **Soft-soil slip for a crew rover.** The slip model is calibrated to classes from Mars rover experience, not measured on this terrain.
- **Real-time position fixes.** The simulation models drift and re-fixes; there is no hardware in the loop.

Each of these is a parameter in one place (`engine/physio.js`, `engine/costmodel.js`), tagged `[ASSUME]`, so it can be replaced as analogue and flight data arrive.

## Closed loop, navigation and station selection

| Check | Method | Result |
|---|---|---|
| Rate estimators | Synthetic TSS frames with known factors (x1.35 work, x1.25 water, x1.4 battery) | All within 5 % after an hour, σ under 0.1 |
| Navigation filter consistency | 200 Monte Carlo 1.5 km walks with heading drift, one sun fix, a landmark fix | Mean 2-D NEES between 1.2 and 3.2 (2 is ideal); a landmark fix removes the drift |
| Loop on real terrain | Hidden truths on the Jezero plan; simulated and TSS2026/2027-format live telemetry | Nominal crew: no re-plan; harder-working, slower, weak-battery crews learned within 10 % and kept out of the reserve |
| Paired campaign | 40 EVAs, closed loop vs filed plan, same random numbers, Wilcoxon signed-rank (`validation/CLOSED_LOOP.md`) | 0 of 40 vs 31 of 40 reserve dips, p < 0.001; science without touching the reserve 0.64 vs 0.29 |
| Hardware interface | UDP bridge over real sockets; NASA TSS2027 built from source and driven through its own commands | Frames relayed as SSE; the loop learned the test suit's 8x battery drain and turned the EVA home (docs/09) |
| Station selection | Held-Karp vs brute force; QUBO + annealing vs Held-Karp on 15-station instances | Exact agreement; QUBO path within 1.7 % mean (docs/11) |
| Wilcoxon implementation | Against scipy.stats.wilcoxon | Identical p-values to 5 decimals |
