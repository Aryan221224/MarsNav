# Limitations and honest claims

What MarsNav does not do, what it assumes, and what we do not claim.

## Claims we make

- It plans and simulates EVAs on real Jezero terrain from USGS HiRISE and CTX elevation models, at 10 m with walking-scale statistics from 1 m data.
- Its Mars clock, terrain registration and slope layer agree with Perseverance's own records (docs/05).
- Its hazard map ranks the paths JPL chose for Perseverance as safer than the direct line on 21 of 30 detour drives.
- Every route it offers respects its hard limits and keeps a walk-home plan within every consumable at every point. This is tested on real terrain.
- It runs offline, in a browser, on one laptop core.

## Claims we do not make

- **Not a flight product.** It is not certified to any NASA standard. The display is *informed by* NASA-STD-3001 Appendix F and the SUITS requirements, not compliant with them.
- **No human data from Mars.** Walking speed (Apollo, lunar regolith), metabolic cost (Minetti, scaled to Mars gravity), suit capacities (EMU heritage), the 20° human slope limit (NASA lunar tool) and the 0.8 m step limit are assumptions carried over to Mars. They are tagged `[ASSUME]` or `[SRC]` in `engine/physio.js` and `engine/costmodel.js`.
- **Weights are ours.** NASA has published no Mars route-safety weights. The AHP judgements are the team's documented reasoning (research docs 27 and 28). They are robust to perturbation, but they are not NASA values.
- **Routes do not reproduce Perseverance's drives.** Our robotic-scout route is no closer to the rover's real path than a straight line (38 m vs 34 m). We report this rather than tune it away.
- **The elevation check against the rover is not independent.** JPL localises the rover against these same orbital maps.

## Data limits

- **1 m coverage.** It is 64 % of the Jezero operations area with the four DTMs in the default build. East of 77.47° E it is only 26 %, and three more USGS DTMs (E, N, DL) are fetched optionally to close that gap. Elsewhere the map is 20 m based: boulders and scarps smaller than about 20 m are not in it, and the route cards and cue card say so.
- **Bedform detection** needs 1 m data. At 20 m the model uses a weak prior with wider uncertainty.
- **Crater-rim DTMs** have y-parallax striping outside the landing ellipse per USGS; their bedform evidence is halved, not removed.
- **The climatology** is a harmonic fit to sampled MEDA records (every 15th sol). It gives typical conditions, not a forecast. Dust storms are represented through the τ setting, not predicted.
- **Radiation** is the Curiosity RAD surface average; solar particle events are handled as a contingency, not modelled in dose.
- **The traverse feed** is a snapshot (sol 1980, September 2026). The rover keep-out uses that position.

## Software limits

- **Voice.** Voice is an offline intent parser for typed or spoken commands and speech output; speech recognition is not bundled (it needs a local model in a real suit). Replies come only from known state.
- **Simulation and telemetry.** The closed loop reads live TSS telemetry and has been run against a TSS2027 build, but not against flight hardware. The simulator and the estimators share the same physics, so the paired campaign measures the loop's logic, not the physics. TSS carries no wheel or visual odometry, so live rover slip learning needs a rover that publishes both. The per-crew heart-rate calibration is an assumption. A hosted copy of the app cannot reach a local bridge; live mode runs from the locally served app.
- **Station tasks and rocky ground.** Task intensities (200, 250, 400 W), rover motion resistance on rocks (x1.35) and crewed-rover wheel life (500 km) are assumptions inside published ranges (docs/10).
- **Rover autonomy is modelled from terrain only.** The robotic scout slows in cluttered ground (terrain classes plus a 25 cm HiRISE clutter layer, Jezero only; other sites use the classes alone). That reproduces Perseverance's measured average speed, but it rates Séítah only 1.5 times slower per metre where JPL projected about 4 times; the rest of JPL's judgement (human-directed drives, camera and thermal constraints, fault risk) is operational. So for a rover MarsNav can still prefer a short corridor that JPL would reject (`validation/ROVER_CASE_STUDY.md`).
- **The image clutter layer is a contrast measure, not a rock count.** It flags 1 m blocks whose brightness contrast is above twice the mosaic median: rocks and ripples, but also bright-dark albedo patterns. Its threshold is fixed, not calibrated against counted rocks.
- **Search.** Label pruning keeps up to four labels per cell with resource dominance. That is near-optimal, not exact, for five criteria. Routes are re-evaluated exactly after the search.
- **Sortie optimiser.** Exact (Held-Karp) up to 15 candidates on the coarse time field with a 15 % hold-back; beyond that the QUBO path came within 1.7 % of optimal on average on 15-station tests (docs/11).
- **Sites without MEDA.** These reuse a reference climatology with a hydrostatic pressure correction; a real site would add its own or a Mars Climate Database extraction.
- **Service worker.** It caches data on first use; a crew tablet must load each site once on the habitat network before going out of range.
