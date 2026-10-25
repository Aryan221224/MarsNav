# -*- coding: utf-8 -*-
# Chapters 6-10: EVA planner Plan / Execute / Review, Tour, other sites
from glib import *

WMAP = (422, 132, 1342, 808)        # map area in a window screenshot (1800 x 1030)

# ================================================================== 6. PLAN
chapter("EVA planner: Plan", "the evening before the Marswalk",
        "Plan is where the crew and science team decide tomorrow's EVA: where to go, what to do there, and whether "
        "everyone can always get home. It opens by default and runs entirely on this computer.")
P("The demonstration site is Jezero crater, which has the richest public data on Mars: 1 m HiRISE stereo terrain, a 45 km "
  "rover traverse and years of MEDA weather records. The planner itself is site-agnostic (Chapter 10).")
H2("Set up the EVA")
figrow([("p07_setup_panel", None, "EVA set-up"), ("p08_checkout_panel", None, "Suit and rover checkout"),
        ("p21_landing_panel", None, "Landing site & hub")],
       "The left panel in Plan mode: the EVA conditions, the pre-EVA checkout state of suit and rover, and NASA's landing "
       "logic applied at site scale.")
bullets(["<b>Crew mode</b>: suited walk, unpressurised rover with walkback, or robotic scout (for validation against rover data).",
         "<b>Depart sol / Depart LMST</b>: when the EVA starts, in Mars local mean solar time. <b>Max EVA</b> and "
         "<b>Reserve</b>: the time budget and the margin held back from every consumable.",
         "<b>Soft-soil risk</b> (how cautious to be about ground that looked firm, priced by its worst cases) and <b>dust "
         "opacity τ</b>.",
         "<b>Navigation aids</b>: habitat beacon and landmarks, dead reckoning and landmarks only, or a studied orbital "
         "navigation constellation. The position error they imply widens the stand-off from cliffs and keep-out zones.",
         "<b>Suit and rover state</b>: tank fills, battery health, scrubber capacity, the crew's work rate and pace, rover "
         "battery and wheel wear. <b>Use rates learned on the last EVA</b> starts from what the closed loop learned.",
         "Below the fields: the site's suit-cooling check (pressure against the 7.5 Torr evaporative-cooling limit) and the "
         "EVA time budget (the EVA limit, or sunset minus 30 minutes)."])
H3("Landing site & hub at site scale")
P("Choose a lander (Viking, MER, MSL, Mars 2020 with Terrain-Relative Navigation, or a human-class precision lander) and "
  "an approach azimuth. <b>Target on map</b>, <b>Find safest target</b> and <b>Fly the landing</b> run a Monte Carlo of "
  "3,000 touchdowns over the lander's delivery ellipse on the site's 1 m and 10 m hazard maps; with TRN the lander diverts to "
  "safe ground as Perseverance did. The result is the probability of a safe landing and the engineering constraints met. "
  "<b>Set as hub</b> moves the habitat, the start and end of every route, to the touchdown point.")
figure("p20_landing_hub", "The landing-safety layer at Jezero for a human-class lander: the crater floor is safe (green), "
       "steep ground hazardous (red). Probability of a safe landing at the chosen target: 100 %.")

H2("Read the terrain: eleven layers")
P("The <b>Layers</b> box switches what the map shows. Every layer is computed from real data on a 10 m grid (2.3 million "
  "cells at Jezero), and its legend names the source and whether it is derived, modelled or an assumption.")
figrow([("p01_plan_overview", WMAP, "Safety hazard (composite)"), ("p02_layer_sand", WMAP, "Sand bedforms"),
        ("p03_layer_walkback", WMAP, "Walkback time")],
       "Composite safety hazard; aeolian bedforms detected in the 1 m DTMs (the ripples that trapped Spirit and "
       "Opportunity); and walk-home time to the habitat with 15-minute contours, the field the walk-home guarantee rests on.")
figrow([("p04_layer_slope", WMAP, "Slope (walking scale)"), ("p05_layer_shade", WMAP, "Shadows at time"),
        ("p06_layer_los", WMAP, "Radio line of sight")],
       "Walking-scale slope (the 90th percentile in each 10 m cell, from 1 m data); terrain shadow at the selected time "
       "from horizon maps and the Mars24 sun; and where the crew loses radio line of sight to the habitat mast.")
table([["Layer", "What it shows"],
       ["Safety hazard", "A composite risk score from a factor tree (slope, steps, roughness, sand, soft soil, cliffs)."],
       ["Slope · Sand bedforms · Wheel-slip risk", "The ground a boot or wheel meets."],
       ["Shadows at time · Walkback time · EVA range", "Light, the walk home, and how far the consumables reach."],
       ["Radio line of sight · Position error · Data confidence", "Communications, navigation uncertainty, and where the data are weak."],
       ["Landing safety", "Lander-scale safety for the chosen lander."],
       ["No-go areas · Perseverance traverse · Landmarks · Alternative routes", "Overlays: cliffs and keep-outs (hatched), the rover's real path, navigation landmarks, the other route options."]],
      [2.4 * inch, CW - 2.4 * inch])

H2("Choose stations and the best sortie")
figrow([("p09_stations", None, "Stations and route order"), ("p10_sortie", None, "Suggest best sortie"),
        ("p11_ahp", None, "Priorities (AHP)")],
       "Stations with their tasks and consumables, the exact sortie optimiser, and the AHP priorities with a live "
       "consistency ratio (CR 0.009: consistent).")
bullets(["Add stations with <b>+ Add on map</b>, or pick from the curated <b>science and survey targets</b> (including "
         "Perseverance's real sample sites). For each, set the work time, intensity (light, moderate or heavy), tool energy "
         "and any extra oxygen or water; its own budget and the walk-home margin after it update at once.",
         "Tick the stations to visit, order them with ↑ / ↓, and choose where the route <b>starts</b> and <b>finishes</b> "
         "(back at the habitat, at the last station, or at any point, for example a rover pick-up). The walk-home guarantee "
         "holds whatever the end point.",
         "<b>Suggest best sortie</b> finds the best set and order of stations for the time, oxygen and battery budget, "
         "exactly (Held-Karp dynamic programming over every subset, about 35 ms for 15 candidates), ranked by science value.",
         "<b>Priorities (AHP)</b>: weigh safety, consumables, recoverability, time and science value with pairwise sliders. "
         "The consistency ratio updates live, so you can see when your own judgements stop being consistent."])

H2("Plan the EVA: five named routes")
P("Press <b>Plan EVA</b>. In about three seconds on one laptop core the engine returns five routes, each inside every hard "
  "limit: <b>Balanced</b> (the team's AHP weights), <b>Safest</b>, <b>Fastest</b>, <b>Lowest consumption</b>, and a "
  "<b>Fallback</b> in a different corridor, kept ready if the primary is blocked.")
figrow([("p12_cards", None, "Route cards"), ("p13_why_guidance", None, "Why this route")],
       "Each route card shows duration, distance, minimum walk-home margin, oxygen, water, battery, maximum grade, shade, "
       "radio line of sight, rocky ground, sand and radiation dose. <b>Why this route</b> lists the hard limits applied and "
       "how each criterion compares with the fastest route.")
figure("p14_timeline", "The timeline under the map: elevation, walk-home margin (green) and sun elevation along the whole "
       "route; the shaded band is station work.")
H2("When no plan can work: the point of no return")
P("If no route satisfies every hard limit, MarsNav does not relax a safety rule or hide the problem. It marks the exact "
  "<b>point of no return</b> on the map, the last point from which the crew can still walk home, and names the resource "
  "that runs out first (oxygen, water, battery, CO₂ scrubber or daylight), with what to change.")
figrow([("p15_no_return", WMAP, "Point of no return on the map"), ("p16_no_return_msg", None, "What to change")],
       "An EVA limit cut to 1.5 hours: no feasible route to the delta front. The point of no return is 1.63 km along the "
       "6.2 km direct plan, and the limit is time before sunset / the EVA limit.")
H2("Rehearse it in 3D")
P("Press <b>3D</b> to see the route on the real terrain. <b>Orbit</b> above it, switch to <b>Helmet</b> for the view at "
  "eye height, and press <b>Walk route</b> to walk it with the walk-home margin and grade shown at every step. The crater "
  "rim is on the real skyline. Esc or <b>Close 3D</b> returns to the map.")
figure("p17_3d_orbit", "3D orbit view of the planned route over Jezero's real terrain (10 m elevation, 2 m HiRISE relief).",
       crop=WMAP)
figrow([("p18_3d_helmet", WMAP, "Helmet view at the start"), ("p19_3d_walk", WMAP, "Walking the route")],
       "Eye-height rehearsal: the route ribbon ahead, distance, mission elapsed time, grade, walk-home time and margin in the "
       "readout at the top.")

# ================================================================== 7. EXECUTE
chapter("EVA planner: Execute", "flying the Marswalk",
        "Execute is the suit and habitat display during the EVA. It flies the chosen route in real time (or faster for a "
        "demonstration), reads suit telemetry, keeps the walk-home margin in view, raises cautions and warnings, and "
        "re-plans from where the crew really is.")
figure("e05_station", "Execute mode at the first station, at 120x speed: consumables (left), the glance band, the live map, "
       "alerts and the closed loop (right).",
       marks=[(0.106, 0.151, 1), (0.356, 0.155, 2), (0.608, 0.155, 3), (0.589, 0.243, 4), (0.053, 0.334, 5), (0.178, 0.462, 6), (0.097, 0.555, 7), (0.881, 0.124, 8), (0.803, 0.151, 9), (0.822, 0.330, 10), (0.422, 0.500, 11), (0.453, 0.835, 12)])
table([["#", "Part", "What it shows"],
       ["1", "Consumables", "Oxygen, CO₂ scrubber, cooling water and battery used; the white tick is what the walk home would need from here."],
       ["2", "Glance band", "Mission elapsed time, walk-home time, position error (2σ) and radio line of sight."],
       ["3", "Walkback margin", "The worst margin along the rest of the route, and oxygen left."],
       ["4", "Mode", "TRAVERSE, STATION or RETURN."],
       ["5", "Telemetry source", "Built-in simulator, live suit telemetry, or you in the 3D drive window."],
       ["6", "Hidden truth", "What the crew and hardware are really doing. The software is not told; it has to learn it."],
       ["7", "Run, Pause, Speed", "30x, 120x or 600x, so a four-hour EVA can be shown in minutes."],
       ["8", "Annunciators", "EVA phase and telemetry source (here EVA · SIM TLM), then the warning, caution and advisory counters."],
       ["9", "Alerts", "Latching cautions and warnings with the action to take; acknowledge, or silence the tone."],
       ["10", "Closed loop", "Each rate as planned, as learned from telemetry (with its uncertainty) and the hidden truth."],
       ["11", "Live map", "The crew position with its error radius, the route flown and any re-planned route."],
       ["12", "Timeline cursor", "Where the crew is along the planned profile."]],
      [0.3 * inch, 1.35 * inch, CW - 1.65 * inch], bold_first=False)
H2("Telemetry sources")
bullets(["<b>Built-in simulator (TSS format)</b>: no setup. Choose a <b>hidden truth</b> (crew working 35 % harder than "
         "modelled, rough going 25 % slower, a suit battery draining 40 % faster, ground softer than mapped) and watch the "
         "closed loop discover it.",
         "<b>Live suit telemetry</b>: <b>Enable live telemetry</b> and MarsNav looks for a NASA SUITS Telemetry Stream Server "
         "by itself (Chapter 11). With none on the network, a built-in demo suit flies the plan instead.",
         "<b>You, in the 3D drive window</b>: walk or drive the route yourself; your movement becomes the telemetry."])
H2("The closed loop")
P("The heart of Execute. The engine compares the rates the plan assumed with what telemetry reports: work rate (oxygen "
  "use), cooling water, suit battery, CO₂ loading and walking pace. As the estimates firm up, it re-plans the rest of the "
  "EVA from the crew's real position, shown as a separate <b>re-planned</b> route, before the margin is gone. It waits for "
  "confident estimates unless the walk-home margin is thin or station work is about to start, and it cuts the lowest-value "
  "station short before dropping it.")
figrow([("e01b_exec_left", None, "Telemetry and controls"), ("e03b_loop_panel", None, "Closed loop"),
        ("e05b_proc_voice", None, "Station procedure and voice")],
       "The simulated crew is working 35 % harder than modelled. Within minutes the loop has learned the work rate, cooling "
       "water and CO₂ loading (×1.35, ×1.25, ×1.35 against the hidden truth of ×1.35, ×1.25, ×1.35), each with its "
       "uncertainty. At the station: the procedure checklist and voice queries.")
H2("Caution and warning")
P("MarsNav follows NASA's three-tier convention: <b>WARNING</b> (red, an immediate threat such as a suit leak), "
  "<b>CAUTION</b> (amber, a developing problem) and <b>ADVISORY</b> (informational). Every alert has the action to take and "
  "a tone; alerts latch until acknowledged, one press silences the tone, and a critical fault turns the plan into the "
  "walk-home route automatically. <b>Return now</b> is a deliberate two-step action, arm then confirm.")
P("Inject faults with the buttons under the controls: <b>Suit leak</b>, <b>Cooling</b>, <b>Injury</b>, <b>Dust storm</b>, "
  "<b>Solar particle event</b> and <b>Rover failure</b>.")
figure("e06_leak_return", "A suit leak injected after the station: SUIT PRESSURE DECAY (warning), and the mode switches to "
       "RETURN at once, with 53 % oxygen and a 27 % walk-home margin left; the return route is drawn in red.")
H2("At the station")
bullets(["The <b>station procedure</b> shows the current and completed steps: report position and margin, panorama, pick the "
         "target, abrade, close-up imaging and spectra, collect and seal the sample, stow and depart.",
         "<b>Drop pin</b> marks the estimated position with its own error.",
         "<b>Voice</b>: type or speak short questions (Where am I, Time home, Oxygen, Next stop). Replies come only from "
         "known telemetry, never invented; tick <b>Spoken callouts</b> to hear them."])
H2("The 3D drive window")
P("<b>Open 3D drive window</b> (or <b>Drive</b> on the map) opens a first-person view of the real terrain in a second window. "
  "Choose <b>Walk</b> (suited) or <b>Rover</b>. W / A / S / D or the arrows move (Shift to hurry), the mouse looks around, "
  "F works at a station, C changes the camera, M zooms the minimap and P hides the panel. Every second of your movement "
  "becomes suit telemetry in TSS format for the main window, which runs its closed loop on it and re-plans live.")
P("The drive panel sets the hidden truth and the declared checkout, and <b>Live: change consumables now</b> hits the running "
  "EVA with a sudden event of 15, 35 or 60 %: O₂ tank loss, battery failure, coolant leak, suit O₂ leak, CO₂ scrubber "
  "degradation, an exertion spike or a rover battery fault. Each reaction of the planner is listed with how long it took.")
figure("d01_drive", "The 3D drive window: hidden truth, live consumable events and the first-person view of Jezero with the "
       "route, the next station and the minimap.", crop=(8, 38, 1742, 1067))

# ================================================================== 8. REVIEW
chapter("EVA planner: Review", "after the EVA",
        "Review is the debrief: what was planned against what was flown, every event, the paper fallback, files for other "
        "tools, and the software's own scorecard against real rover data.")
figure("r01_review", "Review after an EVA cut short by a suit leak: exports and the event log (left), validation on real data (right).")
figrow([("r02b_aar", None, "Planned vs flown"), ("r02c_prov", None, "Data provenance"), ("r02_review_right", None, "Validation on real data")],
       "The after-action comparison (duration, distance, O₂, water, battery, outcome), the provenance of every layer, and the "
       "validation scorecard against Perseverance.")
bullets(["<b>After-action</b>: planned versus flown for time, distance and every consumable, and the outcome (here a "
         "contingency return), linked to the re-plans in the event log.",
         "<b>Event log</b>: every alert, re-plan, pin and command with its mission time.",
         "<b>EVA cue card</b>: the paper fallback in the Artemis style, with heading, distance, time, climb, arrival time and "
         "walk-home margin for every leg. <b>Save file</b> saves it for printing; <b>Copy</b> copies it.",
         "<b>Routes as GeoJSON</b>: for MMGIS or QGIS.",
         "<b>Validation on real data</b> and <b>data provenance</b>: which NASA and USGS products, and which processing, produced each layer."])
figure("r04_cue_card", "The EVA cue card: the plan on paper if every display fails.", crop=(338, 203, 1463, 884), width=CW * 0.64)

# ================================================================== 9. TOUR
chapter("The guided Tour", "seven steps for first-time users and judges",
        "Press <b>Tour</b> in the top bar at any time. The Tour drives the app itself through a real scenario and explains "
        "each step in a card; <b>Next</b>, <b>Back</b> and <b>End tour</b> control it.")
table([["Step", "Title", "What it shows"],
       ["1", "Real Mars, real data", "The live Mars clock (Mars24), and a map built from HiRISE 1 m and CTX 20 m elevation models."],
       ["2", "The ground a boot meets", "Walking-scale slope and hazards from 1 m stereo terrain."],
       ["3", "Never out of reach of home", "Walk-home time from every point; no planned route ever goes where the crew could not walk back."],
       ["4", "Five named routes", "Balanced, safest, fastest, lowest consumption and fallback, with their budgets."],
       ["5", "Walk it before you walk it", "The 3D eye-height rehearsal on the real terrain."],
       ["6", "Flying the EVA", "Telemetry in NASA's SUITS format, a crew working harder than planned, a suit leak and the automatic walk-home."],
       ["7", "Checked against Perseverance", "The validation numbers against the rover's own records."]],
      [0.45 * inch, 1.75 * inch, CW - 2.2 * inch], bold_first=False)
figrow([("t01_tour_1", None, "1 · Real Mars, real data"), ("t03_tour", None, "3 · Never out of reach of home")],
       "Tour steps 1 and 3.")
figrow([("t05_tour", None, "5 · Walk it before you walk it"), ("t06_tour", None, "6 · Flying the EVA")],
       "Tour steps 5 and 6: the 3D rehearsal, and Execute with a suit-leak warning and the return.")

# ================================================================== 10. SITES
chapter("Other sites and new hubs", "the same planner anywhere on Mars",
        "Everything specific to a place lives in one site file: area, projection, habitat, source data, mission calendar, "
        "targets and keep-outs. So the same planner runs on any site, including hubs you build in Landing mode.")
H2("jezero_east: a site with 20 m data only")
P("Most of Mars will never have 1 m stereo terrain. <b>jezero_east</b> is built from a 20 m CTX elevation model alone to "
  "show the planner working at that resolution. Open it from <b>MarsNav</b> menu, <b>Jezero east demo site</b>. Every "
  "1 m statistic is left empty, the hazard model falls back to calibrated 20 m estimates, and the planner says so: "
  "<i>regional DEM only: lower confidence</i>.")
figure("w_s01_jezero_east", "jezero_east: five routes planned in 1.7 s on 20 m terrain, with the lower data confidence stated.")
H2("Hubs built in Landing mode")
P("A hub committed in Landing mode (Chapter 4) becomes a site like any other: choose it in the planner's <b>Site</b> "
  "selector or press <b>Open</b> in the Hubs tab. It has its own terrain, hazard layers, imagery, weather, targets, 3D "
  "view, drive window and closed loop.")
figure("w_s02_built_hub", "A hub built in Landing mode near the equator (3.1°N, 155.3°E): CTX 20 m elevation blended into "
       "MOLA, survey stations around the habitat, and routes planned in 4.0 s.")
