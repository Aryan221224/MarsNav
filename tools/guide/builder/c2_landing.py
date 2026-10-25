# -*- coding: utf-8 -*-
# Chapters 4-5: Landing mode, Local mode / Mars mode
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
figure("l01_overview", "Landing mode on first opening: 66 candidate sites, already screened, on the globe and in the list.",
       marks=[(0.254, 0.078, 1), (0.498, 0.078, 2), (0.646, 0.078, 3), (0.806, 0.117, 4), (0.974, 0.123, 5), (0.133, 0.150, 6), (0.240, 0.242, 7), (0.039, 0.395, 8), (0.167, 0.550, 9), (0.473, 0.162, 10), (0.503, 0.573, 11), (0.653, 0.777, 12), (0.881, 0.167, 13)])
table([["#", "Part", "What it does"],
       ["1", "Module switch", "Landing (this page) and EVA planner."],
       ["2", "Search", "Place names, candidate sites, or coordinates such as 18.4N 77.5E (press / to jump here)."],
       ["3", "Criteria set", "NASA HLS 2015 (Human Landing Sites call) or Starship 2021 (Golombek et al.)."],
       ["4", "Annunciators", "Connection to NASA / USGS, Local mode data on this computer (click to open Local mode), and SCIENCE n/4: how many science layers are installed."],
       ["5", "Help", "The keyboard shortcuts and how to read the scores."],
       ["6", "Mission", "Lander class and approach azimuth. They set the size and orientation of the landing ellipse."],
       ["7", "Tabs", "Candidates, Hubs (sites already built), Traverse (long drives) and Data (science layers, offline download, sources)."],
       ["8", "Screen all candidates", "Re-scores every candidate on global data in a second or two."],
       ["9", "Candidate list", "Each site with a 0-100 score and five dots: latitude, elevation, dust, water, craters."],
       ["10", "Map layers", "Base imagery and overlays (press L)."],
       ["11", "The globe", "Drag to move, wheel to zoom, right-drag to tilt, double-click to fly. Dots are coloured by verdict; labels that would overlap give way."],
       ["12", "View controls", "Zoom, north up, tilt."],
       ["13", "Site dossier", "The selected place: score, verdict, criteria and actions."]],
      [0.3 * inch, 1.35 * inch, CW - 1.65 * inch], bold_first=False)

H2("Step 1 · Find a candidate")
bullets(["<b>NASA EZ</b>: the 48 Exploration Zones proposed at NASA's First Landing Site / Exploration Zone Workshop for "
         "Human Missions to the Surface of Mars (2015), each with its proposer and links to the abstract and presentation.",
         "<b>Starship</b>: 7 candidate sites from the SpaceX Starship study (Golombek et al. 2021).",
         "<b>Heritage</b>: 11 places where spacecraft have landed, for comparison.",
         "Every candidate is screened when the page opens. Filter by name or proposer, sort by score, name or latitude, "
         "or simply click anywhere on Mars to screen that point."])
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
         "<b>Context</b>: the nearest Exploration Zones, Starship sites, landed spacecraft and named features; then the "
         "<b>data sources</b> with citations."])
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
       ["Geologic map, craters ≥ 1 km", "USGS SIM 3292 units in their published colours; rims of 384,343 catalogued craters."]],
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
P("Four datasets are downloaded once (about 300 MB) and converted on this computer: SWIM ice consistency (Morgan et al. "
  "2021, 2025), TES thermal inertia (Putzig & Mellon 2007), Mars Odyssey GRS hydrogen (Boynton et al. 2007) and the "
  "Robbins & Hynek crater database (384,343 craters ≥ 1 km). Until they are installed, the banner over the globe offers to "
  "install them and the criteria that need them are judged from coarser data, and say so. Each layer installs on its own: "
  "if one server does not answer, the others still work.")
table([["Keys", "Action", "Keys", "Action"],
       ["Drag", "move the globe", "Wheel, + / −", "zoom (towards the cursor)"],
       ["Right-drag, Shift+drag", "tilt and turn", "Double-click", "fly there"],
       ["Arrows · Q / E", "pan · turn", "PgUp / PgDn", "tilt"],
       ["N", "north up", "/", "search"],
       ["A", "assess the selection", "L", "map layers"],
       ["?", "help", "Esc", "close a panel"]], [1.35 * inch, 1.85 * inch, 1.35 * inch, CW - 4.55 * inch], bold_first=True)

# ================================================================== 5. LOCAL MODE AND MARS MODE
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
       ["Science layers", "SWIM ice, TES thermal inertia, GRS water, every crater ≥ 1 km", "304 MB"],
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
