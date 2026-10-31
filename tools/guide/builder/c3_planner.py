# -*- coding: utf-8 -*-
# Chapters 8-13: EVA planner Plan / Execute, crew displays, Review, Tour, other sites
from glib import *

WMAP = (422, 132, 1342, 808)        # map area in a window screenshot (1800 x 1030)
PMAP = (330, 50, 1440, 860)         # map area in a page screenshot without the window frame (1800 x 1030, 2.1 captures)

# ================================================================== 8. PLAN
chapter("EVA planner: Plan", "the evening before the Marswalk",
        "Plan is where the crew and science team decide tomorrow's EVA: where to go, what to do there, and whether "
        "everyone can always get home. It opens by default and runs entirely on this computer.")
P("The demonstration site is Jezero crater, which has the richest public data on Mars: 1 m HiRISE stereo terrain, a 45 km "
  "rover traverse and years of MEDA weather records. The planner itself is site-agnostic (Chapter 13).")
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

story.append(CondPageBreak(4.2 * inch))
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
         "The consistency ratio updates live, so you can see when your own judgements stop being consistent.",
         "<b>What you'll see · n photos</b> on a station opens the rover's own photographs from that spot (below).",
         "Click any point of the map, outside <b>+ Add on map</b>, for the site's terrain there and every planet-wide layer; "
         "<b>Add as station</b> on that card adds it (Chapter 5)."])
H3("Photographs from the ground")
P("The challenge asks for point-of-view images so the crew knows what to expect. Where a rover has stood at a station, "
  "MarsNav keeps that rover's own raw Navcam and Mastcam frames from the spot: four at each of the eight Jezero stations "
  "(Perseverance) and two at each of the three Mount Sharp drill sites (Curiosity). Perseverance frames carry the rover's "
  "site and drive index, so only frames taken at that exact stop are used; for Curiosity, only sols when it stood there all "
  "day. Sun images, sky frames, deck shots and near-duplicates are rejected. Every photo carries the sol, local time, "
  "pointing, the rover's distance from the station and the credit, and links to NASA's full-resolution original. The same "
  "photos appear on the wrist cuff for the next stop (Chapter 10).")
figure("g14_pov_modal", "What you'll see at Amalik, the delta front where Perseverance cored Mageik: two Navcam and two "
       "Mastcam-Z frames the rover took from that stop, with sol, time, pointing and credit (NASA/JPL-Caltech/ASU).", width=CW * 0.9)

H2("Plan the EVA: five named routes")
P("Press <b>Plan EVA</b>. In about three seconds on one laptop core the engine returns five routes, each inside every hard "
  "limit: <b>Balanced</b> (the team's AHP weights), <b>Safest</b>, <b>Fastest</b>, <b>Lowest consumption</b>, and a "
  "<b>Fallback</b> in a different corridor, kept ready if the primary is blocked.")
figrow([("p12_cards", None, "Route cards"), ("p13_why_guidance", None, "Why this route")],
       "Each route card shows duration, distance, minimum walk-home margin, oxygen, water, battery, maximum grade, shade, "
       "radio line of sight, rocky ground, sand and radiation dose. <b>Why this route</b> lists the hard limits applied and "
       "how each criterion compares with the fastest route.")
P("The dose on each card follows the altitude of every step: Curiosity's measured dose at Gale, scaled by the air overhead, "
  "so a route over a ridge costs a little more than one along the crater floor. The space-weather box in the top bar says "
  "whether NASA's DONKI service sees a reason to shorten EVAs (Chapter 6).")
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

# ================================================================== 9. EXECUTE
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
         "by itself (Chapter 14). With none on the network, a built-in demo suit flies the plan instead.",
         "<b>You, in the 3D drive window</b>: walk or drive the route yourself; your movement becomes the telemetry."])
P("The same EVA can be shown at once on the crew's own displays: <b>Helmet visor</b>, <b>Rover dash</b> and <b>Wrist cuff</b> "
  "under the telemetry controls, or <b>HUD</b> on the map (Chapter 10).")
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

# ================================================================== 10. CREW DISPLAYS
chapter("Crew displays", "helmet visor, rover dashboard and wrist cuff",
        "The challenge asks how the guide is shown: inside the habitat, on a tablet, or as a heads-up display on the helmet "
        "visor. MarsNav shows the same EVA, live, on the three displays a crew would carry: a visor HUD, the dashboard of the "
        "crew rover, and a wrist cuff made for gloved hands. Each shows the map under the crew and the facts about the ground "
        "they stand on.")
H2("Opening them")
bullets(["In the EVA planner: <b>HUD</b> on the map tools opens the visor; <b>Helmet visor</b>, <b>Rover dash</b> and "
         "<b>Wrist cuff</b> in Execute open each one. Every display is its own window: keys <b>1</b>, <b>2</b> and <b>3</b> "
         "switch between them and <b>F</b> goes full screen. On the visor, <b>V</b> switches the 3D view on and off and "
         "<b>C</b> looks ahead again after a look around.",
         "They follow whatever flies the EVA: the simulator, live suit telemetry or you in the drive window. They get the plan "
         "and every snapshot live, and the cuff's commands act on the planner's loop. A display opened first waits for the "
         "planner and connects by itself.",
         "In the 3D drive window, <b>H</b> draws the visor see-through over the drive window's own first-person view.",
         "For a place with no EVA, <b>HUD</b> in Landing mode's dossier and <b>Crew displays</b> on the planner's place card "
         "open them as a survey of that point (below)."])
story.append(CondPageBreak(4.8 * inch))     # the heading stays with its figure
H2("Helmet visor")
figure("g15_visor", "The helmet visor during a simulated EVA to Amalik at 120x, over the site's terrain in 3D from the crew's "
       "eyes: the route painted on the ground and the stop's pole on the delta front, heading 288° with the next stop 1.72 km "
       "away (ahead), consumables with the walk-home need ticked, the walk-home time and margin, the facts about the ground "
       "under the crew (bottom left) and the mini map.")
table([["Part", "What it shows"],
       ["3D view", "The site's terrain from the crew's eyes (1.8 m standing, 2.25 m in the rover's seat), following its position and heading: the 10 m terrain with the orbital and HiRISE images, the crater rim on the skyline, the route painted on the ground in white (a re-plan in cyan, the return in red), the stops and the habitat as poles. Drag to look around: the tape and the arrow turn with the view."],
       ["Heading tape", "The 120° ahead of the view with the next stop (diamond), home (H) and the sun. Heading comes from the track: SUITS telemetry has no compass."],
       ["Steering cue", "An arrow to the next stop with its distance, bearing, time at the current pace and turn left / right / ahead; amber when the next stop is home."],
       ["Mode tag", "TRAVERSE, STATION, RETURN or EVA DONE."],
       ["Consumables", "O₂, CO₂ scrubber, cooling water and battery; the white tick is what the walk home from here needs."],
       ["Right column", "Walk-home time, worst margin, mission time, position error, radio, the sun's height and time to sunset, and the dose so far."],
       ["Here", "Air pressure, dose rate, gravity, the boiling point of water, the ground, dust, ice and the geologic unit at the crew's position (Chapter 5)."],
       ["Alert and step", "The top unacknowledged alert with its action, and the station procedure step."],
       ["Mini map", "The route, the re-plan or the return, the track, the stations, the habitat and the crew with its position error; lines only."]],
      [1.15 * inch, CW - 1.15 * inch])
figure("g15b_visor_leak", "The same visor seconds after a suit leak is injected: WARNING · SUIT PRESSURE DECAY with its action, the "
       "mode RETURN, the steering cue turned amber towards the habitat (HAB on the skyline) and the return route in red.", width=CW * 0.8)
callout("Why the visor looks like this", "Black is see-through on a real visor, so it draws nothing it does not need and keeps "
        "the centre of view clear. On a screen the 3D terrain stands in for the world behind the visor, darkened at the edges "
        "where the numbers are; <b>V</b> gives the plain visor. Normal symbols use one calm colour; amber and red appear only "
        "for cautions and warnings. "
        "This follows the display practice of NASA's SUITS challenge and NASA-STD-3001, as the planner's own display does.", "cyan")
story.append(CondPageBreak(4.8 * inch))
H2("Rover dashboard")
figure("g16_rover", "The rover dashboard on the same EVA: speed, heading, slope ahead, off-route distance, position error and radio "
       "(left), with the site's terrain under the crew and the place facts below; the map on the orbital image of Jezero with "
       "the no-go areas hatched, the route in white and the track in green (centre); suit consumables and alerts (right).")
bullets(["<b>Map</b>: drawn on the site's own orbital image. Zoomed in, HiRISE detail tiles replace the 5 m image. <b>Route</b> "
         "fits the EVA, <b>Whole site</b> shows the operations area.",
         "<b>Data here</b>: every layer at the crew's position, the same sections as Chapter 5, folded.",
         "<b>Rover power</b> shows the battery left when a rover is on the EVA; on foot it says so.",
         "Along the bottom: next stop, walk home, worst margin, sunset and mission time."])
figrow([("g16b_rover_site", None, "Whole site"), ("g17_rover_data", None, "Data here")],
       "The dashboard's map over the whole Jezero site, and the Data here tab with every layer at the crew's position.")
H2("Wrist cuff")
figrow([("g18_cuff", (0, 0, 480, 1150), "Top: alert, next stop, map, here"), ("g18_cuff", (0, 1150, 480, 2300), "Lower: procedure, commands, consumables, cue card")],
       "The wrist cuff during the EVA: big numbers for O₂, walk home and margin; the next stop with the rover's photographs of "
       "it; the map; the ground here as tiles with the nearest catalogued features; the station checklist; the commands; the "
       "consumables; the cue card; and every layer, folded.", height=6.3 * inch, gap=14)
bullets(["Large targets for gloves. <b>ACK ALERTS</b> and <b>SILENCE</b> act on the planner's caution and warning, <b>DROP PIN</b> "
         "marks the crew's position with its error, and <b>RETURN NOW</b> is two steps: press, then confirm within five seconds.",
         "The header gives mission time, the mode and the local time on the mission clock."])
H2("A survey of any place")
P("Opened from Landing mode or from the planner's place card, the displays show a place with no EVA running. The visor gives "
  "the local solar time, the sun, the time to sunset, the season, the elevation and the Earth's radio delay, over the place "
  "in 3D when it is inside a built EVA site (the 3D terrain is built per site; elsewhere the visor says so). The dashboard "
  "and the visor map the catalogued features and names within 50 km on Mars imagery, with range rings and the sun's "
  "direction; the cuff lists the facts, the nearest features and every layer.")
figrow([("g19_survey_rover", None, "Rover dashboard"), ("g19b_survey_visor", None, "Helmet visor")],
       "A survey of the Mount Sharp boxwork, opened from Landing mode: no EVA, the features within 50 km on Mars imagery, and "
       "the facts about the place; the visor stands on the boxwork in 3D, facing north, with Mount Sharp rising on the right.")
P("During an EVA the planner sends every layer at the crew's position again after 400 m of travel or ten minutes, and the "
  "site's terrain under the crew once a second. Without the MarsNav engine (the planner served as plain web files) the "
  "displays still follow the EVA, without the place facts.")

# ================================================================== 11. REVIEW
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

# ================================================================== 12. TOUR
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

# ================================================================== 13. SITES
chapter("Other sites and new hubs", "the same planner anywhere on Mars",
        "Everything specific to a place lives in one site file: area, projection, habitat, source data, mission calendar, "
        "targets and keep-outs. So the same planner runs on any site, including hubs you build in Landing mode.")
H2("jezero_east: a site with 20 m data only")
P("Most of Mars will never have 1 m stereo terrain. <b>jezero_east</b> is built from a 20 m CTX elevation model alone to "
  "show the planner working at that resolution. Open it from <b>MarsNav</b> menu, <b>Jezero east demo site</b>. Every "
  "1 m statistic is left empty, the hazard model falls back to calibrated 20 m estimates, and the planner says so: "
  "<i>regional DEM only: lower confidence</i>.")
figure("w_s01_jezero_east", "jezero_east: five routes planned in 1.7 s on 20 m terrain, with the lower data confidence stated.")
H2("Mount Sharp boxwork: the challenge's own example")
P("The challenge names one place: the boxwork formations Curiosity studied on Mount Sharp, in Gale crater, in 2025. MarsNav "
  "has it as a full EVA site, built from five HiRISE 1 m elevation models (94 % of the operations area) and CTX 20 m models. "
  "Curiosity's track and its boxwork drill sites, Altadena, Monte Grande and Campo Marte, are placed at the rover's own "
  "positions, the mission clock is Curiosity's, and each drill site has the rover's photographs.")
figrow([("g11_mount_sharp", PMAP, "Plan"), ("g11b_mount_sharp_3d", PMAP, "3D rehearsal")],
       "The Mount Sharp site: the forward camp (HAB) and the walk to Altadena on the safety-hazard map, with cliffs and buttes "
       "hatched (left); the same walk in 3D on 1 m terrain (right).")
P("MarsNav's answer here is a finding. Cliff-bounded buttes (every one at least 8 m high) and 39 % sand leave much of the "
  "foothills out of reach on foot with dead-reckoning navigation, so the hub is a forward camp in a pressurised rover at "
  "Curiosity's sol 4530 stop. From there a suited crew reaches Altadena in 1.3 h and Campo Marte in 3.4 h.")
H2("Hubs built in Landing mode")
P("A hub committed in Landing mode (Chapter 4) becomes a site like any other: choose it in the planner's <b>Site</b> "
  "selector or press <b>Open</b> in the Hubs tab. It has its own terrain, hazard layers, imagery, weather, targets, 3D "
  "view, drive window and closed loop.")
figure("w_s02_built_hub", "A hub built in Landing mode near the equator (3.1°N, 155.3°E): CTX 20 m elevation blended into "
       "MOLA, survey stations around the habitat, and routes planned in 4.0 s.")
