# Same trip, two navigators: Perseverance vs MarsNav

Generated 2026-10-25T19:09:59.293Z by `node validation/rover_case_study.mjs`. Raw numbers and route geometry: `validation/results/rover_case_study.json`. Figure: `submission/screens/20_rover_case_study.jpg`.

**Method.** Each route is measured on the same terrain layers (walking-scale slope, step, roughness and bedform evidence from the 1 m HiRISE elevation models, on the 10 m grid), sampled every 2 m; climb is taken from the elevation model every 10 m. These measurements do not use MarsNav's cost function. The rover's route is the public NASA/JPL waypoint record (one point per drive end, plus some intermediate points), so its values are measured along straight lines between waypoints and are approximate; its true odometry is longer.

## Case study: Séítah to the delta front

Perseverance left Issole in Séítah on sol 335 and reached the Amalik outcrop on the delta front on sol 420, including the 2022 Rapid Traverse (sols 379 to 409). The two points are 2.47 km apart. JPL deliberately drove around Séítah: its rover planners chose a 4.8 km strategic route over the 2.4 km direct line because the direct line crosses Séítah's rocky outcrops and sand features, where the rover's onboard navigation (AutoNav) was projected to make under 50 m per sol against 200 to 250 m per sol on the longer route, with a higher risk of a drive fault (Rapid Traverse paper, JPL Robotics, 2023).

MarsNav was given the same two points.

| | Perseverance (actual) | MarsNav, robotic scout | MarsNav, suited crew |
|---|---|---|---|
| Distance | 7.15 km | 3.07 km | 2.92 km |
| Time | 85 sols, 44 with recorded drives | about 49 h of driving (modelled) | 1.4 h EVA from the habitat |
| MarsNav's modelled driving time on this route | 91 h (79 m/h) | 49 h (62 m/h) | n/a |
| Planning time | multi-sol strategic and tactical planning on Earth | 0.4 s on one laptop core | 0.7 s |
| Climb | 108 m | 90 m | 81 m |
| Steepest walking-scale slope | 20.5° | 13.5° | 12.8° |
| Ground steeper than 15° | 42 m | 0 m | 0 m |
| Average slope | 3.9° | 5.3° | 5.2° |
| Mapped sand bedforms crossed | 256 m | 192 m | 103 m |
| Rocky ground crossed | 152 m | 110 m | 47 m |
| Ground outside MarsNav's robotic limits | 73 m | 0 m | 0 m |
| Walk-home margin (crew) | n/a | n/a | never below 52 % |

**What this shows.**
- **The rover's own speed is reproduced.** On Perseverance's actual route MarsNav's speed model, with the autonomy slowdown, gives 79 m/h; JPL measured an average of 79.7 m/h during the Rapid Traverse.
- **Séítah is recognised as slow and cluttered, but not as slow as JPL projected.** MarsNav's model drives the direct line at 52 m/h against 79 m/h on the rover's route, about 1.5 times slower per metre. JPL projected about 4 times slower. A stronger slowdown cannot close that gap without breaking the match to the rover's measured speed: at 12 times the published rate, the direct line is still only 2.6 times slower and the rover's own route drops to 27 m/h. The terrain data explain part of the gap; the rest of JPL's judgement (human-directed drives in complex ground, camera and thermal constraints, the risk of a drive fault) is operational and is not in the terrain. On total time MarsNav therefore still takes the shorter way (49 h against 91 h on the rover's route). For a rover, JPL's choice stands; MarsNav puts both options and their numbers on one screen in seconds.
- **For a crew, the trip becomes one EVA.** MarsNav's suited-crew route covers 2.92 km in 1.4 h, crosses 103 m of mapped bedforms (rover route 256 m) and 47 m of rocky ground (rover 152 m), and keeps the walk home to the landing-site habitat at every step, with at least 52 % margin.

## All 45 validation drives

The same comparison on the 45 end-of-drive pairs (0.4 to 2 km apart, spread over sols 13 to 1,893) used in `validate.mjs`: MarsNav's safest robotic-scout route against the rover's actual route.

| Measured on the 1 m terrain | Perseverance (actual) | MarsNav | Change | MarsNav lower on |
|---|---|---|---|---|
| Mapped sand bedforms | 1.06 km | 0.56 km | −47 % | 12 of 45 (31 tied) |
| Rocky ground | 4.11 km | 1.83 km | −55 % | 35 of 45 |
| Ground steeper than 15° | 4.19 km | 2.55 km | −39 % | 25 of 45 (12 tied) |
| Steepest slope per drive (mean) | 17.5° | 14.2° | −19 % | 33 of 45 |
| Total climb | 1201 m | 1059 m | −12 % | 25 of 45 |
| Total distance | 28.10 km | 25.32 km | −10 % | 24 of 45 drives |

MarsNav planned all 45 drives in 0.13 s each on average (at most 0.19 s). The rover's recorded route passes through 1.62 km of ground that MarsNav's robotic limits forbid (step / boulder over limit: 0.90 km; cliff edge (incl. 2-sigma position error): 0.53 km; slope over limit: 0.20 km): on these measures MarsNav is more conservative than the envelope JPL drove in.

**What this does not show.** That MarsNav's routes would have been faster or safer for Perseverance in practice: rover drives are shaped by science stops, sub-metre hazards, communication windows and operational risk, which the comparison includes only through the terrain.
