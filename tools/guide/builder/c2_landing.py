# -*- coding: utf-8 -*-
# Chapters 4-7: Landing mode, everything at any place, science atlas / missions / space weather, Local mode / Mars mode
from glib import *

MAP = (452, 70, 1247, 950)      # globe area inside a content screenshot (1783 x 955)

# ================================================================== 4. LANDING MODE
chapter("Landing mode", "choose where the crew lands and lives",
        "Landing mode is where the mission picks the hub: the place the crew lands, sets up the habitat and starts "
        "every EVA from. It shows the whole of Mars in 3D on real NASA and USGS data, screens every candidate site "
        "against NASA's human landing-site criteria, and builds the chosen hub into a full EVA site.")
P("Open it with <b>Landing</b> in the top bar (the module switch next to the MarsNav name), or the MarsNav menu. The globe is streamed the way a "
  "flight simulator streams the Earth: only the map tiles in view are loaded, each at the best resolution NASA and USGS "
  "have mapped there, from 3.7 km for the whole planet down to 1 m HiRISE elevation and 25 cm imagery close up.")
figure("l01_overview", "Landing mode on first opening: 66 candidate sites, screened on real data, on the globe and in the list.",
       marks=[(0.128, 0.024, 1), (0.242, 0.024, 2), (0.538, 0.024, 3), (0.702, 0.024, 4), (0.944, 0.024, 5), (0.983, 0.024, 6),
              (0.041, 0.096, 7), (0.033, 0.144, 8), (0.041, 0.268, 9), (0.041, 0.401, 10), (0.241, 0.079, 11), (0.50, 0.33, 12),
              (0.744, 0.888, 13), (0.794, 0.524, 14)])
table([["#", "Part", "What it does"],
       ["1", "Module switch", "Landing (this page) and EVA planner."],
       ["2", "Search", "Place names, candidate sites, or coordinates such as 18.4N 77.5E (press / to jump here)."],
       ["3", "Criteria set", "NASA HLS 2015 (Human Landing Sites call) or Starship 2021 (Golombek et al.)."],
       ["4", "Annunciators", "Connection to NASA / USGS, Local mode data on this computer (click to open Local mode), and SCIENCE n/7: how many installable science layers are on this computer."],
       ["5", "Space weather", "SPACE WX: NASA DONKI space weather at Mars, quiet, watch or storm. Click it for the digest (Chapter 6)."],
       ["6", "Help", "The keyboard shortcuts and how to read the scores."],
       ["7", "Mission", "Lander class and approach azimuth. They set the size and orientation of the landing ellipse."],
       ["8", "Tabs", "Candidates, Science (objectives and missions, Chapter 6), Hubs (sites already built), Traverse (long drives) and Data (science layers, offline download, sources)."],
       ["9", "Screen all candidates", "Re-scores every candidate on global data in a second or two."],
       ["10", "Candidate list", "Each site with a 0-100 score and five dots: latitude, elevation, dust, water, craters."],
       ["11", "Map layers", "Base imagery, overlays and the whole-planet science atlas (press L)."],
       ["12", "The globe", "Drag to move, wheel to zoom, right-drag to tilt, double-click to fly. Click any point for every data layer there (Chapter 5). Dots are coloured by verdict; labels that would overlap give way."],
       ["13", "View controls", "Zoom, north up, tilt."],
       ["14", "Site dossier", "The selected place: score, verdict, criteria, actions, and all the data at that point."]],
      [0.3 * inch, 1.35 * inch, CW - 1.65 * inch], bold_first=False)

H2("Step 1 · Find a candidate")
bullets(["<b>NASA EZ</b>: the 48 Exploration Zones proposed at NASA's First Landing Site / Exploration Zone Workshop for "
         "Human Missions to the Surface of Mars (2015), each with its proposer and links to the abstract and presentation.",
         "<b>Starship</b>: 7 candidate sites from the SpaceX Starship study (Golombek et al. 2021).",
         "<b>Heritage</b>: 11 places where spacecraft have landed, for comparison.",
         "Every candidate is screened when the page opens. Filter by name or proposer, sort by score, name or latitude, "
         "or simply click anywhere on Mars to screen that point and see every data layer there (Chapter 5)."])
figure("l02_candidate", "Arcadia Planitia AP-1 (SpaceX's prime Starship site) selected: the 100 km zone is drawn around it and "
       "the dossier shows a preliminary screen from global data, before the full assessment.")

H2("Step 2 · Assess the landing site")
P("<b>Assess landing site</b> (or the A key) runs the full assessment for the chosen lander and approach azimuth. The "
  "engine builds the best elevation mosaic over the landing ellipse (HiRISE 1 m where it exists, then CTX 20 m, HRSC "
  "200 m and MOLA 463 m), classifies the touchdown point and every part of the ellipse, and evaluates each criterion on "
  "the real data. The result is a score out of 100 and a verdict:")
table([["Verdict", "Meaning"],
       ["<font color='#2c8a55'><b>GO</b></font>", "Every criterion is met."],
       ["<font color='#c58a12'><b>CAUTION</b></font>", "Usable with mitigations: at least one criterion is amber, or a non-critical one is red."],
       ["<font color='#b4302a'><b>NO-GO</b></font>", "Latitude, elevation or the landing ellipse fails. The crew should not land there."]],
      [1.0 * inch, CW - 1.0 * inch], bold_first=False)
figure("l03a_assessed_close", "AP-1 assessed for a human-class precision lander: score 97, CAUTION (8 criteria green, 1 amber: "
       "no 1 m HiRISE elevation yet over the ellipse). The 150 m ellipse is drawn on the CTX 5 m mosaic.")
H3("The criteria")
table([["Criterion", "NASA HLS 2015", "Starship 2021", "Data used"],
       ["Latitude", "≤ 50° (amber above 40°)", "≤ 40° (amber above 35°)", "position"],
       ["Elevation", "≤ +2 km (best below −1 km)", "≤ −2 km (best below −3 km)", "MOLA MEGDR"],
       ["Landing ellipse", "point safe, ≥ 80 % of the ellipse safe", "same", "slope and relief on the best elevation"],
       ["Level ground", "slopes under 10° over 2 km", "under 5°", "elevation mosaic"],
       ["TRN map", "orbital images over > 90 % of the ellipse", "same", "CTX / HiRISE footprints"],
       ["1 m verification", "HiRISE elevation over > 50 %", "same", "USGS STAC catalogue"],
       ["Dust", "thermal inertia ≥ 100 (no thick fine dust)", "same", "TES (Putzig & Mellon 2007)"],
       ["Water", "ice (Ci ≥ 0.5, 0-5 m) within 5 km; amber within 100 km", "same", "SWIM; GRS if SWIM is not installed"],
       ["Craters", "not in a crater or on a crater wall; few craters within 10 km", "same", "Robbins & Hynek database"]],
      [1.05 * inch, 2.05 * inch, 1.35 * inch, CW - 4.45 * inch])
H3("The dossier")
P("Below the verdict, the dossier explains every number, section by section, with its data source:")
bullets(["<b>Criteria</b>, grouped (engineering, landing, resources, surface), each with the measured value, the limit and a note.",
         "<b>Landing ellipse</b>: its size and orientation, the share that is safe / caution / hazard / no-go, the class of the "
         "touchdown point and the elevation data under it. If the point is not safe, <b>Move to nearest safe spot</b> fixes it.",
         "<b>Water and resources</b>: SWIM ice consistency at 0-1 m, 1-5 m and deeper, the nearest ice-consistent ground "
         "(<b>Show the ice target</b> draws a line to it), and the GRS hydrogen value.",
         "<b>Surface</b>: thermal inertia (dust, sand or rock), the geologic unit, and craters nearby.",
         "<b>Environment</b>: surface pressure, the air overhead (radiation shielding) and sunlight through the year.",
         "<b>Context</b>: the nearest Exploration Zones, Starship sites, landed spacecraft and named features.",
         "<b>Science along the way</b>: the catalogued minerals, ice landforms, active slopes and mission sites within 100 km, "
         "the nearest of each, and a planetary-protection warning when a candidate Special Region is near (Chapter 6).",
         "<b>Science objectives here</b>: the seven objectives scored on the evidence within 100 km.",
         "<b>Chemistry, gravity and radiation</b>: the GRS elements, albedo, the gravity anomaly, the cosmic-ray dose for the "
         "air overhead and space weather now; then the <b>data sources</b> with citations.",
         "Below the dossier, <b>All data at this place</b> stays open for the same point, folded (Chapter 5)."])
figrow([("l04_dossier_0", None, "Verdict and criteria"), ("l04_dossier_2", None, "Landing ellipse"),
        ("l04_dossier_3", None, "Water and surface"), ("l04_dossier_4", None, "Environment, context")],
       "The AP-1 dossier: shallow water ice 1.9 km from the touchdown point (SWIM Ci +0.56 at 1-5 m), 73 % of the 100 km zone "
       "ice-consistent, 100 % of the ellipse safe at the available resolution, and a clear warning about what the data cannot show.")

H2("Step 3 · Refine with the map layers")
P("<b>Map layers</b> (top left of the globe, or L) sets the base imagery and the overlays drawn on top. The legend in the "
  "bottom-left corner always says what is shown and where it comes from.")
table([["Layer", "What it tells the mission"],
       ["Best available imagery", "Colour from orbit, then the CTX 5 m global mosaic, then HiRISE down to 25 cm, as you zoom in."],
       ["THEMIS night / day infrared", "Night IR: rocky ground stays warm and bright. Day IR at 100 m: morphology everywhere."],
       ["MOLA colour elevation, Viking colour", "Topography at a glance; the classic colour mosaic."],
       ["Landing safety (for the chosen lander)", "Green safe (strong green verified at 1-2 m), amber caution, red hazard, purple no-go. It sharpens as you zoom, because the elevation under it does."],
       ["Water ice (SWIM)", "Blue where every orbital dataset agrees with shallow ice, at 0-1 m, 1-5 m or deeper."],
       ["Thermal inertia (TES)", "Orange = fine loose dust (weak ground, dust on hardware), blue = rock."],
       ["Near-surface water (GRS)", "Water-equivalent hydrogen in the top half metre (5° cells)."],
       ["Geologic map, craters ≥ 1 km", "USGS SIM 3292 units in their published colours; rims of 384,343 catalogued craters."],
       ["Science atlas · whole planet", "Twenty-six more layers in nine groups: minerals, elements, water and ice landforms, thermal, topographic, gravity, air pressure, dose, sunlight, present-day activity and mission sites (Chapter 6)."]],
      [1.9 * inch, CW - 1.9 * inch])
figrow([("c_l06_ice", MAP, "Water ice (SWIM, 1-5 m)"), ("c_l07b_thermal", MAP, "Thermal inertia (TES)"),
        ("c_l07_geology_craters", MAP, "Geologic map + craters")],
       "Science overlays around Arcadia Planitia, about 2,000 km across: shallow ice is consistent across the plains (left), "
       "the surface is sand and duricrust rather than deep dust (centre), and the geologic units and crater rims (right).")
figrow([("c_l06d_themis_night", MAP, "THEMIS night infrared"), ("c_l06e_mola", MAP, "MOLA colour elevation"),
        ("c_l06c_grs", MAP, "Near-surface water (GRS)")],
       "Base imagery and the GRS hydrogen map over the same region.")
figure("l05_safety", "The landing-safety overlay for a human-class lander, zoomed to about 30 km: green ground is safe at the "
       "resolution shown. Where 1 m HiRISE elevation exists the map reaches lander scale and the green becomes 'verified'.",
       width=CW * 0.86)

H2("Step 4 · Commit the hub")
P("<b>Set as hub…</b> opens the commit card. It repeats the verdict and asks for the hub's name, the size of the EVA site "
  "(6 to 24 km) and the lander. <b>Build hub site</b> then builds a complete EVA site centred on the hub, with the habitat "
  "exactly there. It takes a few minutes and the log shows each step. When it is done, <b>Open … in the EVA planner</b> "
  "takes you to the new site, which also appears in the <b>Hubs</b> tab and on the globe.")
figrow([("l08b_hubcard", None, "Commit the hub"), ("l09_tab_hubs", None, "Hubs tab"), ("l09_tab_data", None, "Data tab")],
       "Committing AP-1 as a hub (left); the hubs already built, each a full EVA site (centre); the science layers installed "
       "once on this computer, each with its source (right).")
H3("What a new hub site gets")
bullets(["The same pipeline as Jezero: a 10 m operations grid with slope, steps, roughness, sand, soft soil, cliffs, landmarks "
         "and science layers, walk-home fields, 3D, the drive window and the closed loop.",
         "Elevation: CTX 20 m where it exists, blended into MOLA; HiRISE 1 m models over the operations area (up to eight, "
         "those covering the hub first); otherwise 463 m MOLA with walking-scale slopes calibrated from Jezero's 1 m data.",
         "Imagery: a CTX 5 m mosaic, and 2 m HiRISE detail where 1 m elevation exists.",
         "Weather: Jezero's MEDA climatology moved to the new latitude and elevation (sunlight through the Martian year, the "
         "CO₂ frost point, hydrostatic pressure).",
         "Named features inside the area become science targets; otherwise survey stations are placed around the hub.",
         "To remove a hub you built, open it in the EVA planner and press <b>Delete site</b> (the Jezero sites are kept)."])
H3("Report and JSON")
P("<b>Report</b> opens a printable dossier, with a picture of the site, in its own window: press <b>Print / save as PDF</b>. "
  "<b>JSON</b> saves the complete assessment for other tools.")
H2("Traverse: long drives between sites")
P("In the <b>Traverse</b> tab, add the selected point (and more), choose the traveller (crewed pressurised rover, robotic "
  "rover or suited walk) and press <b>Plan traverse</b>. The router finds the least-cost path on the real elevation, coarse "
  "to fine: slopes over the traveller's limit are impassable, and climbing costs more than descending. The result shows "
  "distance, climb, steepest slope, driving time in sols and an elevation profile with over-limit stretches in red.")
H2("Science layers and keyboard")
P("Seven datasets are downloaded once (about 300 MB in all) and converted on this computer: SWIM ice consistency (Morgan "
  "et al. 2021, 2025), TES thermal inertia (Putzig & Mellon 2007), Mars Odyssey GRS hydrogen and elements (Boynton et al. "
  "2007), TES albedo, the MRO GMM-3 gravity field and the Robbins & Hynek crater database (384,343 craters ≥ 1 km). Until "
  "they are installed, the banner over the globe offers to install them and the criteria that need them are judged from "
  "coarser data, and say so. Each layer installs on its own: if one server does not answer, the others still work. The "
  "feature catalogues of the science atlas are part of the app and need no download.")
table([["Keys", "Action", "Keys", "Action"],
       ["Drag", "move the globe", "Wheel, + / −", "zoom (towards the cursor)"],
       ["Right-drag, Shift+drag", "tilt and turn", "Double-click", "fly there"],
       ["Arrows · Q / E", "pan · turn", "PgUp / PgDn", "tilt"],
       ["N", "north up", "/", "search"],
       ["A", "assess the selection", "L", "map layers"],
       ["?", "help", "Esc", "close a panel"]], [1.35 * inch, 1.85 * inch, 1.35 * inch, CW - 4.55 * inch], bold_first=True)

# ================================================================== 5. EVERYTHING AT ANY PLACE
chapter("Everything at any place", "every data layer at one point, anywhere on Mars",
        "Click any point on the globe, or any point of a built EVA site, and everything MarsNav holds about it appears at "
        "once: where it is, the time and sun there, whether a crew could survive and work there, the ground, water, "
        "minerals, science, the missions nearby and the best data covering it. No assessment has to run first.")
H2("In Landing mode")
P("Click anywhere on the globe, or pick a candidate. The dossier first shows the quick screen against the criteria set and "
  "the best elevation at the current zoom, then <b>All data at this place</b>: the time there, live, and nine folding "
  "sections, the first four open. They stay below the dossier when you press <b>Assess landing site</b>. "
  "<b>JSON</b> saves them with the assessment (or alone, before one), and <b>Report</b> prints them; <b>HUD</b> opens the "
  "crew displays as a survey of the point (Chapter 10).")
figure("g01_place_full", "A point clicked on the floor of Jezero crater: the quick screen against NASA's 2015 criteria, the "
       "elevation and slope at this zoom, and the start of All data at this place, with the local time and the sun.")
figrow([("g02_place_time", None, "Time and where"), ("g03_place_env", None, "Survival and ground"),
        ("g04_place_water", None, "Water and composition"), ("g05_place_science", None, "Science, missions, data")],
       "The same point, section by section: local solar time, sun and season; the USGS chart and names; air pressure, the "
       "liquid-water window, dose and gravity; thermal inertia, geology, dust and roughness; SWIM ice at three depths and GRS "
       "hydrogen; minerals and elements; the catalogued features and objective scores; the missions and the elevation models "
       "covering the point.", height=4.6 * inch, gap=6)
H3("What each section holds")
table([["Section", "What it holds", "From"],
       ["Time here now", "Local true and mean solar time, the sun's height and direction, sunrise, sunset and daylight length, the noon sun, the season in each hemisphere, Ls and Mars Year, the dust-storm season, sunlight above the air, the Earth's distance and radio delay. Polar day and night are named.", "Mars24 clock, JPL planet elements"],
       ["Where", "Position (east and west longitude), the USGS 1:5M chart quadrangle (MC-01 to MC-30), lowlands or highlands, MOLA elevation, named features, and the built EVA site the point lies in or the nearest hub.", "IAU Gazetteer, USGS, MOLA"],
       ["Survival here", "Mean air pressure, whether pure liquid water can exist and at what temperature it boils, the air overhead as radiation shielding, the cosmic-ray dose per day and over a 500-sol stay, surface gravity, sunlight above the air and at the ground, space weather now.", "MOLA, Curiosity RAD, MRO gravity, NASA DONKI"],
       ["Ground", "Thermal inertia and what it means (dust, sand, rock, or ice near the poles), the geologic unit, albedo, the crater the point is in, crater counts within 10 and 100 km, dust cover and roughness at 0.6, 2.4 and 9.2 km.", "TES, USGS SIM 3292, Robbins & Hynek, MOLA"],
       ["Water and ice", "SWIM ice consistency at 0-1 m, 1-5 m and deeper; the nearest ice-consistent ground and its share of the 100 km around; GRS water-equivalent hydrogen.", "SWIM, Mars Odyssey GRS"],
       ["Composition", "Plagioclase, pyroxene and glass / clay (TES); iron, chlorine, potassium, thorium and silicon (GRS); the hydrous and aqueous mineral detections nearby.", "TES, GRS, CRISM, OMEGA"],
       ["Science here", "Every catalogued layer within 100 km with its nearest feature, a Special Region warning, and the seven science objectives scored at the point.", "the science atlas (Chapter 6)"],
       ["Missions and sites nearby", "Landed and targeted missions by distance and direction, NASA Exploration Zones and Starship candidates.", "mission catalogue, candidates"],
       ["Best data here", "The HiRISE 1 m and CTX 20 m elevation models that cover the point, and the finest resolution a hub built here would get.", "USGS STAC catalogue"]],
      [1.15 * inch, CW - 2.75 * inch, 1.6 * inch])
H2("How the values are made")
bullets(["<b>Fast.</b> Everything is read from data on this computer or its caches in well under a second. Two lookups are "
         "remote and run in parallel with a four-second budget: the geologic unit (USGS OGC API) and NASA Mars Trek's colour "
         "maps. If one is slower, its line says <i>reading…</i> and fills in by itself a few seconds later.",
         "<b>Colour maps read back.</b> The TES mineral and dust-cover maps are published as rainbow images under a hillshade. "
         "Hillshade changes brightness, not hue, so the hue at the point gives its place on the scale, shown as very low to very "
         "high, never as an abundance. Checked on known places: Syrtis Major reads very high for pyroxene and plagioclase; "
         "Arabia Terra, Tharsis and Olympus Mons high for dust; Meridiani smooth; Hellas has no TES data, as published.",
         "<b>Liquid water.</b> Above water's triple point (611.7 Pa) pure liquid water can exist between 0 °C and its boiling "
         "point at the local pressure (Buck's equation); below it, ice turns straight to vapour.",
         "<b>Gravity</b> from the mass, flattening and spin of Mars at the ground (3.71 m/s² at the equator), plus the measured "
         "MRO anomaly where the gravity layer is installed.",
         "<b>Dose</b>: Curiosity's RAD record at Gale, moved by the air column overhead (Guo et al. 2017); galactic cosmic rays "
         "only, solar particle events come on top.",
         "<b>Missing data say so.</b> A layer that is not installed, or has no value at that latitude, is named as such; "
         "nothing is filled in."])
callout("What the numbers are, and are not", "Every value comes from orbit or a model, at the resolution of its dataset: GRS "
        "cells are 5° (about 300 km) wide, the TES maps 3 to 16 km, SWIM 0.05°. They describe the ground around the point, not "
        "what a boot or a drill will meet. Pressure and dose are mean, modelled values; colour-map values are relative.", "amber")
H2("On a built EVA site")
P("In the EVA planner, click any point of the map (when <b>+ Add on map</b> and <b>Target on map</b> are off). A card opens "
  "over the map, named after the nearest station or landmark, with the point's position and its distance and direction "
  "from the habitat; a yellow ring marks it on the map. Esc or × closes it.")
figure("g12_place_card", "A point clicked 41 m south-west of the forward camp on the Mount Sharp site, by the Altadena drill site: "
       "the planner's own model of the cell (rocky, 17° walking slope, 0.7 m steps, not no-go, line of sight to the habitat, two "
       "minutes' walk home, measured at HiRISE 1 m) and the time there; the planet-wide sections follow further down the card.")
table([["Row", "What it is"],
       ["Elevation, terrain", "From the site's own elevation model; the terrain class used by the planner."],
       ["Slope, steps", "Walking-scale slope (90th percentile per cell) and step height."],
       ["Sand, wheel-slip risk, rock cover", "Bedform evidence and the soft-soil risk a rover would face."],
       ["Nearest cliff, hazard index, no-go", "The distance to the nearest drop, the composite hazard and, if the cell is forbidden, why."],
       ["Position error, radio", "The navigation filter's 2σ error there, and line of sight to the habitat."],
       ["Walk home", "From the walk-home field of the planned EVA (plan one first)."],
       ["Elevation data", "Whether HiRISE 1 m or only CTX 20 m data back the cell."]],
      [1.95 * inch, CW - 1.95 * inch])
bullets(["<b>Add as station</b> makes the point a station (named after the landmark when you clicked one) and re-plans.",
         "<b>Crew displays</b> opens the helmet visor, rover dashboard and wrist cuff as a survey of the point (Chapter 10).",
         "<b>Photos</b> appears when a station with the rover's own photographs is within 150 m (Chapter 8).",
         "The planet-wide sections need the MarsNav engine. When the EVA planner is served on its own as plain web files, the "
         "card keeps the site terrain and says so."])

# ================================================================== 6. SCIENCE ATLAS, OBJECTIVES, MISSIONS, SPACE WEATHER
chapter("Science atlas, objectives, missions and space weather", "what to study, where, and when it is safe",
        "The challenge asks for at least three kinds of data from several NASA missions, science along the way, and space "
        "weather. MarsNav adds a whole-planet science atlas grouped by the kind of measurement, seven science objectives that "
        "rank every site, a catalogue of the missions past, present and future, and an EVA advisory from NASA's space-weather "
        "service.")
H2("The science atlas")
P("Open <b>Map layers</b> in Landing mode: under the base imagery and the science layers is <b>Science atlas · whole planet</b>, "
  "nine groups that fold open. Tick any layer to draw it on the globe; the legend says what the colours mean and cites the "
  "source, and the number beside a catalogue is how many features it holds.")
table([["Group", "Layers", "Source"],
       ["Spectral: minerals", "Aqueous minerals (4,572 sites), hydrous mineral detections (1,648), chloride salt deposits (642); plagioclase, high-calcium pyroxene and sheet silicates / high-Si glass", "Ehlmann & Edwards 2014; Carter et al. 2013 (CRISM, OMEGA); Osterloo et al. 2010; Bandfield 2002 (TES)"],
       ["Chemical: elements", "Water-equivalent hydrogen, iron, chlorine, potassium, thorium, silicon", "Mars Odyssey GRS (Boynton et al. 2007)"],
       ["Water and ice", "SWIM ice; glaciers and glacial valleys (1,847); gullies (4,978); valley networks (59,394 segments); alluvial fans (44)", "Morgan et al.; Souness, Brough, Fassett; Harrison 2015; Hynek 2010; Moore & Howard 2005"],
       ["Thermal and surface", "Thermal inertia, albedo, dust cover index, dune fields (547)", "Putzig & Mellon 2007; TES; Ruff & Christensen 2002; Hayward et al. 2007"],
       ["Topographic and geologic", "MOLA surface roughness, the geologic map, craters ≥ 1 km", "Kreslavsky & Head 2000; Tanaka et al. 2014; Robbins & Hynek"],
       ["Geophysical", "Gravity anomaly", "MRO GMM-3 (Genova et al. 2016)"],
       ["Atmospheric, radiation, power", "Surface air pressure, cosmic-ray dose rate, sunlight for solar power", "MOLA elevation; Curiosity RAD (Hassler 2014, Guo 2017)"],
       ["Present-day activity", "508 sites: recurring slope lineae, new and icy impacts, active gullies and dunes; candidate Special Regions", "Daubar 2013, McEwen 2014, Ojha 2014, Dundas 2014"],
       ["Missions on the ground", "Rover traverses; 66 landers, rovers and science stops", "NASA Mars Trek, JPL waypoint feeds"]],
      [1.35 * inch, CW - 3.25 * inch, 1.9 * inch])
figure("g06_atlas", "The science atlas over Nili Fossae and Jezero (about 1,800 km across): aqueous-mineral sites and CRISM / OMEGA "
       "hydrous detections, with the legend and its citations. The groups fold open in the Map layers panel.")
P("The feature catalogues ship inside the app, built from NASA Mars Trek by <font name='Plex'>tools/build_features.py</font>, so "
  "they work offline at once. The GRS elements, albedo and gravity install once in the Data tab. The TES mineral, dust and "
  "roughness maps stream from NASA Mars Trek and are kept by Local mode. The atmosphere, dose and sunlight maps are computed "
  "from MOLA elevation and latitude.")
H2("Science objectives")
P("The <b>Science</b> tab starts from the question, as the challenge does: choose an objective, then find where to pursue it. "
  "Each objective card says what to look for, why a human on foot changes the answer, example places, what to do at the "
  "station and what to watch for. <b>Show its layers</b> turns on the atlas layers that answer it. <b>Rank sites for it</b> "
  "scores every candidate and every hub you have built by the evidence within 100 km, each kind counted on a logarithmic "
  "scale and weighted, plus terms from the installed layers such as ice, water, dose or sunlight. Click a result to fly "
  "there and open it.")
table([["Objective", "Evidence that scores"],
       ["Ancient life in lakes and deltas", "Aqueous and hydrous minerals, valley networks, fans, chlorides, the geologic map"],
       ["Groundwater and the boxwork of Mount Sharp", "Aqueous and hydrous minerals, rover traverses, dunes, the gravity anomaly (the challenge's example)"],
       ["Water ice: drinking water, propellant and climate record", "SWIM ice, GRS water, glaciers, active slopes, thermal inertia"],
       ["Mars today: active slopes, new craters and Special Regions", "Present-day activity, gullies, dunes"],
       ["Volcanoes, crust and the planet's interior", "Pyroxene, plagioclase, GRS potassium and thorium, gravity, geology"],
       ["Climate history in layers and glaciers", "Glaciers, valley networks, fans, geology, ice"],
       ["A place to live: water, sunlight, low radiation, firm ground", "Ice, GRS water, cosmic-ray dose, sunlight, dust cover, thermal inertia"]],
      [2.65 * inch, CW - 2.65 * inch])
figrow([("g07_objectives", None, "An objective and its ranking"), ("g10_dossier_science", None, "Science in the dossier"),
        ("g08_missions", None, "The mission catalogue")],
       "Ancient life ranked over every site (Columbus crater first, with the evidence that put it there); the science sections "
       "of the dossier at Mount Sharp; and the mission catalogue, from Viking to the missions still on their way.",
       height=5.2 * inch, gap=8)
H2("Missions, past, present and future")
P("<b>Missions 31</b> lists the Mars missions as of 28 October 2026: landers, rovers, orbiters and helicopters that have "
  "ended, are active, are en route, are planned or in development, or were cancelled. Filter by <b>Active</b>, <b>En route / "
  "planned</b> or <b>Past</b>. Each entry gives the agency, the years, the status (with a source wherever it can change), "
  "what the mission found, what it gives MarsNav's map and what it means for a crew; landing sites are on the globe. "
  "Statuses that change quickly (MAVEN lost in 2025, ESCAPADE and MMX en route, Mars Sample Return cancelled in its "
  "current form) are dated and sourced in <font name='Plex'>planet/data/missions.json</font>.")
H2("Space weather")
P("<b>SPACE WX</b> in Landing mode's top bar, and the matching box in the EVA planner's top bar, read NASA's DONKI service "
  "(the CCMC Space Weather Database of Notifications, Knowledge, Information): CME arrivals predicted at Mars by the "
  "WSA-ENLIL model, solar particle events and flares over the last 30 days, refreshed at most every three hours and kept for "
  "Mars mode. The digest also gives the Sun-Earth-Mars angle: past about 60° Mars faces solar regions that Earth-side "
  "monitors cannot see, so DONKI may miss events that reach Mars.")
table([["Level", "When", "Advice for EVAs"],
       ["<font color='#2c8a55'><b>QUIET</b></font>", "Nothing below applies.", "EVA as planned."],
       ["<font color='#c58a12'><b>WATCH</b></font>", "A CME is predicted at Mars within 72 h; or a particle event near Earth in the last 48 h with Mars more than 60° away; or an X-class flare in the last 24 h.", "Shorter EVAs within reach of shelter; recheck before egress."],
       ["<font color='#b4302a'><b>STORM</b></font>", "A CME shock at Mars within ±24 h; or a particle event in the last 48 h with Mars within 60° of Earth (probably the same magnetic connection).", "Hold EVAs or return to shelter (habitat or pressurised rover)."]],
      [0.85 * inch, CW - 2.95 * inch, 2.1 * inch], bold_first=False)
figure("g09_swx", "The space-weather digest. On the day of these screenshots NASA's service refused requests from the "
       "development network (rate limit), so the panel says there is no data instead of guessing; the Sun-Earth-Mars "
       "geometry is computed locally (64°, 1.46 AU, 12.1 light-minutes).", width=CW * 0.9)
P("Every route card also gives the route's cosmic-ray dose, from the altitude of every step (more air overhead, less dose), "
  "and Execute's <b>Solar particle event</b> drill rehearses the return. Your own NASA API key, in the environment variable "
  "<font name='Plex'>MM_NASA_API_KEY</font>, avoids the demonstration key's limit.")

# ================================================================== 7. LOCAL MODE AND MARS MODE
chapter("Local mode and Mars mode", "working with no Earth link",
        "On Mars there is no internet. Local mode puts every dataset MarsNav uses on this computer, at the resolution "
        "it was published at. Mars mode then cuts the app off from the internet, so you can show that everything still "
        "works, and the panel counts every request it refused.")
P("Open it from the <b>LOCAL MODE</b> pill in Landing mode's top bar, the <b>Local mode</b> button in the Data tab, or "
  "<b>Data</b> menu, <b>Local mode</b>.")
figure("l13_local_estimate", "The Local mode panel after <b>Measure sizes</b>: whole-planet packs on the left, exploration zones "
       "on the right, and the size check against the free disk at the bottom (here: 29 GB selected, 20 GB free, so MarsNav "
       "says it will not fit and suggests what to untick, before anything is downloaded).")
H2("What can be downloaded")
table([["Whole-planet pack", "Resolution", "Size"],
       ["MOLA elevation", "463 m (128 px/deg) and 3.7 km; 16 files from the PDS Geosciences Node", "2.1 GB"],
       ["HRSC + MOLA blended elevation", "200 m; the best global elevation model (Fergason et al. 2018), one file", "11 GB"],
       ["Viking colour mosaic", "232 m (MDIM 2.1, USGS / NASA Mars Trek)", "≈ 2.3 GB"],
       ["MOLA colour relief", "463 m, colour-coded elevation with shading", "≈ 1.7 GB"],
       ["Global geologic map (USGS SIM 3292)", "unit polygons for every point, and the coloured overlay", "≈ 113 MB"],
       ["Science layers", "SWIM ice, TES thermal inertia and albedo, GRS water and elements, MRO gravity, every crater ≥ 1 km", "≈ 310 MB"],
       ["Mineral and surface maps", "TES plagioclase, pyroxene, sheet silicates and dust cover; MOLA roughness (NASA Mars Trek)", "≈ 6 MB"],
       ["Catalogues and names", "every HiRISE / CTX elevation-model footprint, 2,000+ IAU names", "60 MB"],
       ["THEMIS day / night infrared (optional)", "100 m, whole planet", "≈ 21 GB each"]],
      [2.0 * inch, CW - 2.85 * inch, 0.85 * inch])
P("<b>Exploration zones</b> add full resolution where the crew will actually work. Add the site selected on the globe "
  "(or all your hubs) with a radius of 10 to 50 km, and choose what to include: every HiRISE elevation model (1 m) and "
  "orthoimage (25-50 cm) that touches the zone as complete files, every CTX elevation model (20 m) and orthoimage (6 m), "
  "every tile of the CTX 5 m global mosaic in the zone, THEMIS infrared, and map tiles pre-rendered from all of it.")
callout("Why not simply 'download all of Mars'?", "The complete HiRISE and CTX archives are hundreds of terabytes. MarsNav "
        "therefore keeps every whole-planet dataset at its native resolution and the full-resolution archives inside the "
        "zones you choose, which is what a crew on the surface needs. Sizes are measured against the real files before "
        "anything is downloaded.", "cyan")
H2("Downloading")
bullets(["<b>Measure sizes</b> asks the NASA and USGS servers for the exact size of every file and compares the total with "
         "the free disk (keeping 2 GB free).",
         "<b>Download to this computer</b> shows overall and per-item progress, speed and time left. Downloads run in their "
         "own process, resume where they stopped, and can be stopped with <b>Stop</b>.",
         "Everything goes to <font name='Plex'>data_cache\\planet\\local</font> with a manifest and checksums; tiles you have "
         "already viewed are reused."])
H2("Mars mode")
P("Switch on <b>Mars mode</b> in the panel. From that moment the engine refuses every outside request instantly and counts "
  "it; the top bar turns orange and reads <b>EARTH LINK OFF</b> and <b>MARS MODE · LOCAL DATA ONLY</b>. Maps, assessments, "
  "the EVA planner and the closed loop keep working from the local copies. The interface itself, fonts included, is part "
  "of the app, so it looks the same with no internet. Switch Mars mode off and MarsNav may use the internet again.")
figure("l15_mars_mode", "Mars mode on: the whole globe drawn from data on this computer, with the orange EARTH LINK OFF / "
       "MARS MODE banner in the top bar.")
callout("Demonstrating it to judges", None, "green",
        ["Open Local mode and switch on <b>Mars mode</b>.",
         "Fly around the globe, assess a candidate, open the EVA planner and plan an EVA.",
         "Open the panel again: <b>Requests refused</b> counts the outside requests the app refused while it kept working from local data.",
         "For a fully convincing demo, also unplug the network: nothing changes."])
