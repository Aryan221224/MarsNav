# How MarsNav compares

We reviewed public entries for this challenge and related tools. The goal was to adopt anything genuinely better and to be clear about where each approach stands. No code was copied. Three ideas that another entry did better were re-implemented independently and are credited below.

## Other approaches (as described in their public READMEs, September 2026)

| | MarsNav | Sol Atlas (the-sol-explorers) | MARSWAY | NeuroNexus |
|---|---|---|---|---|
| Terrain for routing | 10 m grid over 19.7 × 11.9 km, with walking-scale statistics from 1 m HiRISE DTMs; CTX 20 m elsewhere | A* on a 512 × 512 grid from the HiRISE 1 m DTM over a 5 × 5 km zone | MOLA/HRSC (463 m) with HiRISE slope | MOLA 463 m |
| Search | Label-setting A* with walkback pruning, 10 m refinement, any-angle smoothing, exact time-stepped evaluation | A*, minimum metabolic energy with a slope limit | Multi-objective weighted graph search | Point queries (no routing described) |
| Safety model | 8 hard vetoes (slope, step, soft soil as CVaR, cliff with a 2σ position buffer, keep-outs, planetary protection, no data, user), then AHP-weighted hazard leaves | Slope limit | Slope thresholds and hazard buffers inside a weighted sum | Heuristic survival risk |
| Walk home | A walkback field from every cell for time and all four consumables; any partial route that cannot walk home is dropped | Point of no return: O₂ used + straight-line return with a 25 % detour allowance | Not described | Not described |
| Consumables | O₂, CO₂, cooling water and battery from metabolic power and a suit heat balance (sun, shade, temperature) | O₂ (Pandolf model) | O₂ (Margaria-Minetti walking model) | Not described |
| Position error | Drift, landmark and beacon re-fix, 2σ corridors, navigation-aid scenarios | Not described | Not described | Not described |
| Weather, sun | Mars24 clock validated on 5,616 MEDA samples, a MEDA climatology, horizon shadows | Mars24, sun and GPU shadows; weather as typical values | MEDA typical values | Not described |
| Validation on rover data | Clock, terrain registration, slope vs tilt, false no-go, JPL route-choice agreement, bedforms, weight sensitivity; negative result reported | Elevation spot check | Not described | Declared limitations |
| In the field | Execute mode: caution and warning per NASA's model, faults, automatic return, procedures, pins, voice, two-step abort | EVA fly-over with a wrist display | What-if contingency simulator | Not described |
| 3D | Orbit and eye-height walk on the 10 m DEM with the real skyline | Orbit, crater and helmet view with the real skyline (the most polished 3D we saw) | 2D | 3D view |
| Sites | Site-agnostic (site files); a second CTX-only site built and tested | Jezero; others marked phase 2 | Jezero and Gale | Global point lookup |

## What we adopted, and why

| Idea | Seen in | Why it is better than what we had | Our implementation |
|---|---|---|---|
| Live Earth–Mars signal delay in the header | Sol Atlas | Makes the operating constraint (the crew is on its own) visible at a glance | JPL approximate Keplerian elements; checked against NASA's 11 min 22 s at landing (`engine/marstime.js`, test) |
| Show *where* an impossible plan fails | Sol Atlas (O₂ exhaustion point, point of no return) | "Infeasible" alone does not tell the crew what to change | Full diagnosis on the real route with every resource and the walkback field, not a straight-line estimate (`planner.diagnose`, test) |
| First-person view at eye height with the real horizon | Sol Atlas (helmet view) | Crews and judges read terrain faster in perspective | `app/js/view3d.js`, with the route, stations, the plan's margins at each step, and the crater skyline from the regional DEM |

## What we deliberately did differently

| Choice | Their approach | Ours, and why |
|---|---|---|
| Soft ground | Sol Atlas uses THEMIS night IR at 100 m as a firmness proxy | We detect ripples and TARs directly in the 1 m DTMs and price the risk by CVaR. At 100 m, THEMIS cannot resolve the ripple fields that trapped rovers. It remains a useful prior for sites with no 1 m data (noted in docs/08). |
| Safety | Weighted sums or a slope limit | Hard limits come first and are never traded against time; the weights then only rank safe routes, and they carry a consistency ratio and a sensitivity analysis |
| Point of no return | O₂ used + straight-line return + 25 % | The walkback field gives the true shortest safe return from every cell, for every consumable and for time |

Sources: the public README of each repository on GitHub (`saracen66/the-sol-explorers`, `ahsanur-official/Interplanetary-Survival-Guide-Martian-Map`, `kmmohaimenulhaque-code/neuronexus-mars-survival`), read 26 September 2026.

## QPath (quantum-inspired route optimisation, SIH 2026)

Assessed in full in research doc 35. QPath's solvers (QPSO, QIEA, "quantum federated learning") are classical metaheuristics; its own benchmark shows exact Held-Karp reaching the proven optimum faster than QPSO at the sizes MarsNav needs. What was genuinely better was adopted and credited: Held-Karp as the exact station selector and the yardstick for heuristics, Or-opt polishing, an 8 % dead band before re-routing, reference scales pinned across re-plans, and paired Wilcoxon trials. Nothing was copied; each was re-implemented and tested here (docs/11).
