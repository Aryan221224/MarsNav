# 10 Station tasks and rocky ground

## Station tasks: stating the work before the walk

A crew member heading to a station knows roughly what they will do there. MarsNav lets them, or the science team, state it per station before the EVA, and budgets the whole out-and-back trip with it.

| Stated per station | Meaning | Effect in the model |
|---|---|---|
| Work time (min) | How long the station takes | Time at the station; the walkback margin is checked after it |
| Intensity | Light 200 W (imaging, contact science), moderate 250 W (sampling, instrument set-up), heavy 400 W (drilling, trenching, hauling) | Metabolic rate during the work: O₂, CO₂, heat and so cooling water, and heater or cooling load on the battery |
| Tools (Wh) | Energy that tools and instruments draw from the suit battery over the stated time | Added to the suit battery |
| O₂ (g) | Extra oxygen, for example a purge | Added to O₂ |
| Water (g) | Extra water, for example sample handling | Added to cooling water |

The intensity values sit inside the measured ranges: Apollo lunar EVAs averaged 234 to 270 W with peaks over 500 W during drilling and trenching, and ISS EVAs average about 250 W (research doc 12). They are assumptions, tagged in `engine/task.js`.

**Where it is used.**

1. Planning. `stationWork()` prices the station in every route, so the five named routes, their minimum margins and the point-of-no-return diagnosis all include it. Each station row in Plan shows its budget, for example "45 min · O₂ 52 g · water 266 g · battery 53 Wh · walkback margin after 36 %". If a stated task makes the trip impossible, the plan says which consumable runs out and where the crew must turn back.
2. Station selection. The exact optimiser and the QUBO path both use each station's stated O₂ and battery when checking the budget.
3. The cue card. Each WORK row carries the task and its O₂, water and battery.
4. The closed loop. During the EVA the stated task is the model the telemetry is compared against. A crew that works harder than stated shows up as a higher learned work rate.
5. Re-planning. When a station is cut to half its time, its tool energy and extra consumables are halved with it.

## Rocky ground: judged three ways

Rocky ground (10 m cells with steps over 0.3 m or roughness over 0.3 m in the 1 m DTMs) is slower, costs more and is riskier, for boots and for wheels. The planner counts all three at once, so a rocky shortcut has to earn its place.

| | On foot | Rover |
|---|---|---|
| Slower | Walking pace x0.5 | Driving speed x0.5 (hazard avoidance) |
| Costlier | Metabolic cost x1.2, so more O₂, water and CO₂ | Motion resistance x1.35 (obstacle climbing, suspension and steering losses), and drive energy / (1 - slip) wherever wheels slip; auxiliary power runs longer too |
| Riskier | Steps and roughness in the safety tree (S1.2); boot and suit abrasion (S3.1) | Steps and roughness (S1.2), step veto at 0.35 m; wheel wear (S2.1) from Curiosity's wheel tests (35 km to failure on benign ground, 13.5 on rocky, 8 on very rocky), weighted up to three times as heavily on worn wheels |

Route cards show the share of rocky ground, and for a rover the wheel life the drive uses and the rover battery. A route that would leave the wheels under 20 % of their life is flagged. Wheel life is scaled by the vehicle's design life on benign ground (500 km assumed for a crewed rover; the Apollo LRV's wire-mesh wheels were qualified for 180 km), with Curiosity's ratios between ground classes.

The x1.35 motion-resistance and 500 km figures are assumptions inside published ranges (terramechanics puts loose sand at 1.5 to 2 times compacted soil; rover drive logs put rough ground at 20 to 50 % more energy per metre). Tests in `tests/closed_loop.test.mjs` check that each effect is applied and that a rover on worn wheels keeps off rocky ground at least as well as one on new wheels.
