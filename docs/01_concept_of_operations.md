# Concept of operations

How a Mars surface crew would use MarsNav across one sol, and why it is built this way.

## The operating problem

A Mars crew is 4 to 24 light-minutes from Earth, so mission control cannot steer an EVA in real time. Each EVA lasts 2 to 8 hours. NASA's walkback rule says that when a rover carries the crew, they must still be able to walk home if it fails. Suit oxygen, cooling water and battery set hard ceilings. Terrain on Mars has already stopped rovers: Spirit was trapped in soft soil that looked firm, and Opportunity was stuck for six weeks in a ripple. Mars has no GPS, so every route is only as safe as the position estimate that follows it (research docs 03, 08, 26).

MarsNav therefore does three things that an Earth map app does not. It checks hard limits before it optimises anything. It keeps a walk-home plan alive at every step. And it runs with no network.

## Where it runs

| Place | Device | Mode | Notes |
|---|---|---|---|
| Habitat workstation | Laptop or console | Plan, Review | Full map, all layers, route comparison, AHP priorities, cue-card export |
| Suit display or wrist tablet | Tablet or head-down display | Execute | Glance band (time, walk home, margin, O₂, position error, radio, mode), large buttons, voice |
| Unpressurised rover | Dash tablet | Execute | Same as the suit, plus the rover profile and rescue-rover option |
| Earth science team | Browser | Review, Plan (next sol) | Works on the same files. Results come back after the light-time delay. |

The top bar always shows the one-way radio delay to Earth, computed live from planetary positions, which is a reminder of how long any help from the ground takes. The app is a set of static files with an offline service worker. The habitat serves it on its local network, and tablets keep a cached copy for EVAs out of radio range.

## One sol, step by step

**Evening before (Plan).**

1. The science team proposes stations. Curated targets such as the real Perseverance sample sites at Jezero appear under Science targets; at a new site, the auto-generated survey stations do. "Suggest best sortie" picks the set and order of stations that fits the time, O₂ and battery budgets.
2. The crew sets the departure sol and local mean solar time (LMST), the crew mode (suited walk, unpressurised rover, robotic scout), navigation aids, reserve, the soft-soil risk measure and dust opacity.
3. The app shows the site's suit-cooling check (air pressure against the 7.5 Torr evaporative-cooling limit), the time budget (EVA limit or sunset minus 30 min) and the no-go map.
4. Planning produces five routes. The crew picks one. "Why this route" explains the choice, and the timeline shows elevation, walkback margin, sun and shade along the route. If no route fits, the map shows the point of no return and the resource that runs out, so the crew knows what to change.
5. The crew rehearses the route in 3D at eye height on the real terrain, with the crater rim on the skyline and the walk-home margin at every step.
6. The cue card is printed or loaded to the suit. It is the paper fallback that Artemis crews carry.

**EVA (Execute).**

1. The glance band shows mission elapsed time, walk-home time, worst walkback margin, O₂ left, position error (2σ), radio line of sight and mode.
2. Dead reckoning drifts. The crew re-fixes on landmarks and the habitat beacon, and position error is always drawn as a radius, never as an exact dot.
3. At each station the procedure checklist shows the current and completed steps. Crew can drop pins at their estimated position, with its error.
4. Caution and warning follows NASA's three priorities: WARNING red, CAUTION amber, ADVISORY cyan. Every alert has an icon, text, action and tone. Alerts latch until acknowledged, one press silences the tone, and the count is always visible.
5. A suit leak, rover failure, solar particle event, or a walkback limit reached turns the plan into the walk-home route automatically. The crew can also command "Return now", which takes two steps: arm, then confirm.

**After (Review).**

1. Planned-versus-flown table, merged event log, pins.
2. GeoJSON export for MMGIS or QGIS, so the ground team can overlay the day's track on their own maps.

## Crew modes

| Mode | Limits used | Walk home |
|---|---|---|
| Suited walk | 20° slope (NASA lunar traverse tool), 0.8 m step, suit consumables | Always required |
| Unpressurised rover | 25° bedrock and 12° sand slopes, 0.35 m step, soft-soil CVaR veto, rover battery | NASA walkback rule. With a second rover on standby, rescue mode replaces it with a rescue-drive time limit. |
| Robotic scout | Perseverance-class vehicle (152 m/h top speed, 30° slope) | Uncrewed, so no walk home. Used to validate against the real rover. |

## Contingencies designed in

| Event | What the software does |
|---|---|
| Suit leak | WARNING, return starts on the walkback route, O₂ burn rises in the simulation |
| Cooling degraded | CAUTION, water use rises, margins recompute |
| Crew injury | CAUTION, pace halves, return time recomputes |
| Dust storm | ADVISORY, pace and solar power drop, and the tau setting changes shade and temperature |
| Solar particle event | WARNING, shelter: immediate return |
| Rover failure | WARNING, the crew walks home on the walkback route that was guaranteed at planning time |
| Radio line of sight lost | ADVISORY, then CAUTION after 10 min. The EVA continues autonomously. |
| Sunset approaching | CAUTION at 60 min, WARNING at 30 min |
| Position uncertain | ADVISORY above ±60 m, CAUTION above ±100 m, with "re-fix on the next landmark" |
