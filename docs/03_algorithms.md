# Algorithms

What the software computes and why each method was chosen. Constants tagged `[SRC]` come from a source read during research (docs 03, 08 to 13, 26 to 28 of the research set). `[ASSUME]` marks an engineering assumption, `[CALIB]` a value fitted to one sourced point, and `[PHYS]` physics.

## 1. Terrain from orbit (pipeline)

**Grids.** Each site gets a 10 m operations grid, a 40 m horizon grid and a 100 m regional grid. They use an equirectangular projection whose standard parallel is at the site (scale error under 0.1 %), snapped to the source DEM's posts.

**Regional DEM screens.** These run before anything else uses the elevation:

- *Blunders.* A cell is flagged when it sits next to slopes over 45° and departs from the 90 m median by more than 8 m. That catches stereo spikes, pits and striping. The median value replaces it for derived products, and the cell is vetoed as "no reliable terrain data" unless a 1 m DTM covers it. A real 45° slope is no-go anyway; the veto reason tells the crew it is a data problem.
- *Mosaic seams.* A seam is a vertical offset where two source DEMs meet. The screen looks for a step of at least 6 m across 40 m between ground within 8° on both sides, forming a line at least 2 km long and at least 15 times longer than wide. That line is replaced by a Laplace (membrane) surface over ±150 m, so the step becomes a ramp. The band is flagged, and any route crossing it says "check on imagery". Found at the CTX-only site: an 18 m seam that had cut the site in two with a false cliff.

**Walking-scale statistics from 1 m DTMs.** Each HiRISE DTM is processed alone, in 1 km chunks with a 48 m halo. Per 10 m cell the pipeline computes:

- **Walking slope**: the p90 and maximum of slope on the 1 m DTM smoothed at σ = 1.5 m (about a 4 m baseline, one to two strides), and the share of the cell over 20, 25 and 30°.
- **Step**: the p99 of detrended relief, for ledges and blocks.
- **Roughness**: the RMS after a 10 m trend.
- **Bedforms**: relief band-passed to 6 to 30 m wavelengths, with *orientation coherence* (the structure-tensor eigenvalue ratio) and *energy* over a 12 m window. Aeolian ripples and TARs are both strongly directional and measurably tall; rubble is neither directional nor periodic. Evidence = √(coherence ramp × energy ramp).

Each product's noise floor (the 10th percentile over gentle ground) is removed in quadrature. The crater-rim DTMs have y-parallax striping outside the landing ellipse according to their USGS metadata, so their bedform evidence is multiplied by 0.5.

**Elevation blend.** HiRISE block means are used where covered and CTX elsewhere. The HiRISE-minus-CTX offset is low-pass filtered and feathered over 200 m, so no step appears at a DTM edge.

**CTX-only cells.** Walking slope is estimated from the 20 m slope with a calibration fitted where both sources overlap. The calibration is the 75th percentile of the HiRISE p90 per 1° bin of CTX slope, so it is conservative. Sites without any 1 m data reuse Jezero's calibration. Step and roughness get a moderate prior (0.25 m), bedforms a weak prior (0.25), and confidence is 0.

**Other layers.**

- **Cliff distance.** A cliff is p30 of walking slope over 30°, or 10 m slope over 32 to 35°. The layer is a distance transform from those cells.
- **Landmarks.** Peaks of |Laplacian of Gaussian| at 60 to 200 m scale, at least 400 m apart.
- **Horizons.** 16 azimuth sectors on a 40 m grid, marching out to 25 km with Mars curvature (d²/2R) from a 1.7 m eye height.
- **Keep-outs.** Sample-depot and active-rover buffers, planetary protection, unreliable DEM and repaired-seam bits.
- **Science value.** Kernel density around targets.

## 2. Soft soil (Spirit's failure mode)

Wheel slip is modelled as a distribution per cell. The mean rises with bedform evidence and with slope on sand; the standard deviation carries epistemic uncertainty and is larger with no 1 m data:

μ = 0.03 + 0.30·sand + 0.012·sand·slope + 0.004·max(0, slope − 10)  
σ = 0.03 + 0.12·sand + 0.10·(1 − confidence)  `[ASSUME, classes from doc 26]`

Vehicles are vetoed where the risk measure reaches 0.7 (the start of "extreme" slip). The default measure is CVaR at α = 0.9: μ + 1.755·σ, the mean of the worst 10 % of outcomes. A risk-neutral planner reads a firm-looking patch with an uncertain tail as safe; CVaR does not. Mean and mean + λσ are selectable.

**Wheels in bedforms.** For wheeled profiles (the robotic scout and the crew rover) the soft-ground hazard leaf is the larger of the slip-risk term and the bedform evidence itself, ramped from 0.2 to 0.8 `[ASSUME]`. Rippled sand trapped Opportunity at Purgatory (2005) and Spirit at Troy (2009), and turned Curiosity back at Hidden Valley (2014), on ground where a slip map alone can look mild. On foot, bedforms cost footing as before (0.6 × the same ramp, to 1.0).

**Rover autonomy in clutter (robotic scout).** A rover that drives itself slows down where its stereo hazard map is cluttered. During the 2022 Rapid Traverse JPL planned 200 to 250 m per sol of progress on benign ground, against under 50 m per sol through Séítah's rocks and sand, about 4 times slower `[SRC: JPL Rapid Traverse paper, 2023]`. The per-cell speed model already halves speed on rocky ground; the autonomy factor 1 / (1 + c) halves it again where all the ground within 50 m is cluttered, so fully cluttered ground drives about 4 times slower than firm open ground. A cell counts as cluttered (value 1) if its 10 m class is rocky or sandy or it is steeper than 15°; otherwise its value is the share of its 1 m blocks that show rock or ripple contrast in the 25 cm HiRISE orthomosaic (`pipeline/build_clutter.py`: high-pass at 5.25 m, contrast per 1 m block, cluttered above twice the mosaic median). The 25 cm image sees the decimetre rocks the 1 m elevation models cannot, at the resolution JPL's planners used (30 to 60 cm). Crews on foot and the crew rover do not use this factor.

## 3. Hard limits first, then weights

Vetoes are checked in order. The first reason found is the one reported.

| # | Veto | Rule |
|---|---|---|
| 7 | No reliable terrain data | Outside the DEM, or a flagged DEM blunder |
| 5 | Keep-out | Within 2σ of position error of a hardware or sample keep-out |
| 6 | Planetary protection | Within 2σ of a Special Region |
| 4 | Cliff | Cliff distance − 2σ below the stand-off (10 m on foot, 20 m by rover) |
| 1 | Slope | Walking slope over 20° on foot `[SRC]`; 25° rock or 12° sand by rover `[SRC, one study]`; 30° robot |
| 2 | Step | Over 0.8 m on foot `[ASSUME]`; 0.35 m by rover |
| 3 | Soft soil | Slip CVaR ≥ 0.7 (vehicles) |
| 8 | User no-go | Circles drawn by the crew |

σ is the planning position error: fix error + 2 × drift × distance to the nearest landmark + 5 m map registration, capped at 80 m. So the stand-off from a cliff grows where the crew will be less sure where they are.

**Weighted criteria.** There are five, each normalised by the fastest route's value, so a weight means the relative importance of a relative change:

- **T**: time.
- **S**: hazard × distance. Static leaves are weighted by AHP: slope, step and roughness, soft soil, cliff proximity, and for rovers wheel wear and slip. Time-dependent leaves are added per edge: cold soak in shade and poor light at low sun.
- **C**: consumables as a fraction of each tank.
- **R**: recoverability: walk-home time, radio line of sight and position error. It protects a crew, so it is not weighted for the uncrewed robotic scout, which relays through orbiters and has no one to walk home.
- **V**: science value missed.

Default weights come from the team's pairwise judgements with AHP (the principal eigenvector, consistency ratio under 0.01). The result is S 0.42, C 0.22, R 0.22, T 0.09, V 0.04 `[ASSUME]`. NASA has published no Mars route weights. The UI edits the judgements on Saaty's 1 to 9 scale and recomputes the consistency ratio live.

## 4. Crew physiology and consumables

- **Walking speed.** Apollo planning speeds `[SRC]`: 2.7 km/h for long walks, reduced on slopes by the lesser of a footing curve (1.0 at 0°, 0.5 at 7.5°, 0.14 at 15°, from Apollo 14/15 regolith `[SRC]`) and a constant-metabolic-power limit. Terrain multipliers are 0.7 for sand and 0.5 for rocky ground `[ASSUME]`.
- **Metabolic power.** 120 W at rest, plus body-and-suit mass (184 kg) × the Minetti (2002) cost of transport, with the level part halved and the grade part scaled by g_Mars/g_Earth, × 1.3 suit inefficiency `[ASSUME]` × a terrain factor.
- **Gas exchange.** O₂ = P / 20.1 kJ L⁻¹ × 1.429 g L⁻¹; CO₂ = O₂ × RQ 0.85 × 44/32 `[PHYS]`; plus a 5 g/h suit leak.
- **Heat balance.** Metabolic heat − external work + solar gain (0.12 m² × direct irradiance) − conductance (1.2 W/K × (295 K − T_env)). A positive balance is removed with water (2.45 MJ/kg × 0.9 efficiency); a negative one is supplied by the heater from the battery. The battery also carries a 70 W base load.
- **Suit capacity** `[ASSUME, EMU heritage]`: 0.6 kg O₂, 4.5 kg water, 1.2 kg CO₂ removal, 450 Wh. A reserve (default 15 %) is never planned against.
- **Environment along the route.** Shade comes from the horizon maps at the edge's mid-time. Air temperature comes from the MEDA climatology (Ls × local true solar time), 10 K colder in shade. Direct irradiance comes from the solar constant at the current Mars-Sun distance, attenuated by the dust opacity τ.

## 5. The walkback field (never lose the way home)

A backward Dijkstra from the habitat over the coarse (40 m) grid gives, for every cell, the fastest walk-home time and the O₂, CO₂, water and battery it costs. It is evaluated conservatively: water with full sun, and battery with cold shade, both at once. In a rover sortie the walk home is on foot; this is NASA's walkback rule. With a rescue rover on standby, the field becomes twice the one-way drive time at seated metabolic rate.

This one field gives four products: the pruning test in the planner, the "Walk home" readout and its margin in Execute, the walkback contour map, and the consumables-aware range (every cell where going there and coming back fits every tank and the time budget).

## 6. Route planning

For each leg:

1. **Coarse search (40 m).** Label-setting A* over 16 move directions. A label carries cost, elapsed time and five resource totals. It is discarded the moment the crew could not walk home from that cell with what is left before the time limit (sunset minus 30 min, or the EVA limit), or a resource would exceed its capacity. Up to four labels per cell survive, pruned by resource dominance, so a slightly costlier label with more oxygen left is kept. The heuristic is admissible: the distance × (w_T / v_max + w_C × least consumption per metre).
2. **Refine (10 m).** The same search inside a 300 m corridor around the coarse route.
3. **Smooth.** Any-angle string pulling, which replaces a grid staircase with a straight segment only if it crosses no veto and costs no more (prefix sums make each test O(1)).
4. **Evaluate.** An exact time-stepped re-evaluation of the final route covers sun, shade, temperature, every consumable, the position error (drift, then landmark or beacon re-fix), walkback margins at every point, data-quality flags and dose.

**Named routes.**

- Balanced (the AHP weights), safest, fastest and economy are Pareto-selected: fastest and economy are the best feasible candidates on their own criterion.
- The fallback is re-planned with a penalty inside 60 m of the balanced corridor, so a blocked primary route has a genuinely different alternative. The share of overlap is reported.

**When no plan works.** The planner does not just say "infeasible". It re-plans the fastest sortie with the crew limits switched off, then re-evaluates it with the real limits. The *point of no return* is the last point from which the crew can still walk home with what is left, and it is reported with the resource that runs out first (for Cheyava Falls from the landing site on foot: 5.95 km out of 20.7 km, suit battery). The map draws the safe part amber and the rest red.

**Sortie optimiser.** Time fields from each candidate give a travel-time matrix. Every ordered subset up to four stations is scored by science value within 85 % of the time, O₂ and battery budgets, and the best order of each set is kept. At this scale (under ten candidates) that is exact, and fast enough.

## 7. Execute: simulation, position and alerts

- The simulator steps the flown route with the same edge model. It adds a random-walk position error at the dead-reckoning drift rate (2 % of distance) and re-fixes when a landmark is within 150 m, or by the habitat beacon in line of sight. It injects faults: leak, cooling, injury, dust, solar particle event, rover failure.
- Alert rules follow NASA-STD-3001 Appendix F as summarised in research doc 17. A WARNING-level walkback limit, leak, rover failure, particle event or sunset starts the return along the walkback tree automatically. Alerts latch: one that clears before it is acknowledged stays listed, marked CLEARED, until the crew acknowledges it. New warnings always sound, even after silence.
- The glance band shows the worst walkback margin: the fraction of each tank left after walking home from here, over all four tanks, with time as a fraction of the budget.

## 8. Mars time and weather

- **Mars24** (Allison and McEwen 2000): MSD, Ls, equation of time, subsolar point, LMST and LTST. Validated against the published worked example and against 5,616 MEDA sun-geometry samples.
- **Earth–Mars light time.** Earth and Mars positions come from JPL's approximate Keplerian elements (valid 1800 to 2050), giving the one-way signal delay shown in the top bar. It gives 11 min 22 s at Perseverance's landing, NASA's published figure.
- **Mission calendar.** Sol 0 = landing sol at the landing longitude (M2020 for Jezero; any landing epoch for a new site).
- **Climatology.** A 63-term harmonic model (seasonal ±4 × diurnal ±3 harmonics) fitted to MEDA samples: air RMSE 4.1 K, ground 6.1 K, pressure 4.3 Pa. Pressure is fitted in log space with a hydrostatic elevation term (scale height 11.7 km), so it transfers to other elevations.
- **Site suit check.** The highest pressure over the operations area across a Mars year is compared with the 7.5 Torr evaporative-cooling limit (research doc 03). Jezero: at most 8.2 hPa (6.2 Torr) at the lowest ground in the operations area: OK. Jezero east floor: 8.4 hPa (6.3 Torr): OK.
