# -*- coding: utf-8 -*-
# Chapters 11-19
from glib import *

# ================================================================== 11. LIVE TELEMETRY
chapter("Live telemetry and hardware", "closing the loop with a real suit",
        "During the EVA, MarsNav reads suit and rover telemetry in the format of NASA's SUITS Telemetry Stream Server "
        "(TSS), the server NASA uses for its spacesuit-interface challenge, learns from it and uplinks every re-plan. "
        "The telemetry bridge is built into the app: there is nothing to install or start.")
P("In <b>Execute</b>, set <b>Telemetry</b> to <b>Live suit telemetry</b> and press <b>Enable live telemetry</b>:")
bullets(["<b>Automatic</b> (default): MarsNav looks for a TSS at the last address used, then on this computer (port 14141), "
         "then with a UDP broadcast on every local network. It detects the TSS year (2026 or 2027), polls it once a second "
         "and streams the frames to the app. If none answers within about 1.6 s it switches to the built-in <b>demo suit</b> "
         "and says so.",
         "<b>A TSS at a specific address</b>: type its IP (or IP:port); it is remembered for next time.",
         "<b>Demo suit</b>: a simulated crew member flies the plan with the hidden truth you choose (working harder, walking "
         "slower, battery drain, a leak) and follows every re-plan, as a real crew would.",
         "Every re-plan is uplinked at <font name='Plex'>/api/tss/plan</font> for a helmet display; "
         "<font name='Plex'>/api/tss/status</font> shows the link. Only TSS read commands are ever sent."])
callout("Tested against NASA's own server", "MarsNav was driven over UDP by a TSS2027 build compiled from NASA's source. The "
        "closed loop learned that the test-week suit drains its battery and CO₂ bed more than eight times faster than "
        "the model, and turned the EVA home within about two minutes.", "green")
H2("Navigation without GPS")
P("Position comes from an extended Kalman filter built on Mars practice: dead reckoning from steps or wheel odometry, sun "
  "heading, map-matching against landmarks extracted from the terrain, and ranging to the habitat beacon. Its 2σ error is "
  "drawn on the map as a radius (never a false exact dot) and feeds the planner: the stand-off from cliffs and keep-outs "
  "grows where the crew will be less sure where they are.")

# ================================================================== 12. HOW IT WORKS
chapter("How MarsNav works", "the science and engineering inside",
        "MarsNav is three things working together: a data pipeline that turns orbital measurements into the ground a "
        "boot meets, a planning engine that puts safety first, and a whole-planet engine that streams and screens Mars. "
        "Every constant in the code is tagged by its origin: [SRC] sourced, [CALIB] calibrated, [PHYS] physics, [ASSUME] assumption.")
H2("Technology")
table([["Layer", "Built with"],
       ["Desktop app", "Python launcher compiled with PyInstaller; native window through pywebview on Microsoft Edge WebView2 (pythonnet / .NET); "
        "a supervisor with a Windows job object, health checks and automatic restarts."],
       ["Interface", "HTML, CSS and JavaScript modules, no framework; three.js for 3D; the planning engine in a Web Worker."],
       ["Planning engine", "Plain JavaScript (engine/): terrain, cost model, planner, walk-home fields, physiology, station "
        "tasks, Mars clock, environment, AHP, risk, sortie selection (Held-Karp, QUBO), simulation, closed loop, alerts, "
        "procedures, reports. The same code runs in the app, the tests and the validation."],
       ["Planet engine and server", "Python (planet/): pooled HTTP server, tile pyramid and disk cache, MOLA / HRSC / CTX / HiRISE "
        "readers over GDAL in worker processes, USGS STAC catalogue, landing assessment, site generator, Local mode, TSS bridge."],
       ["Data pipeline", "Python with numpy, scipy, rasterio / GDAL and Pillow (pipeline/): download with SHA-256 checks, "
        "terrain statistics, hazard layers, imagery, weather fit."],
       ["Verification", "Node's test runner (63 engine and closed-loop tests), pytest (15 pipeline and downloader tests), validation scripts "
        "against Perseverance data, and an end-to-end server self-test."]],
      [1.45 * inch, CW - 1.45 * inch])
H2("From orbit to the ground a boot meets")
bullets(["<b>Grids.</b> Each site gets a 10 m operations grid, a 40 m horizon grid and a 100 m regional grid in a site-centred "
         "projection (scale error under 0.1 %).",
         "<b>Data screens.</b> Stereo blunders (spikes, pits, striping) are flagged and vetoed as unreliable; mosaic seams "
         "are found and repaired. The screen found and fixed a real 18 m seam that had cut one site in two with a false cliff.",
         "<b>Walking-scale statistics from 1 m HiRISE models</b>, per 10 m cell: walking slope (90th percentile on a ~4 m "
         "baseline, one or two strides), step height (99th percentile of detrended relief), roughness, and a bedform detector "
         "using orientation coherence: ripples and TARs are directional and tall, rubble is neither.",
         "<b>20 m-only ground</b> gets walking slope from a conservative calibration fitted where both resolutions overlap, "
         "moderate priors for steps and roughness, and zero data confidence, so the planner says so.",
         "<b>Other layers</b>: cliff distance, landmarks for navigation, horizons in 16 directions out to 25 km with Mars "
         "curvature, keep-outs (sample depot, active rover, planetary protection), and science value."])
H2("Safety first, then optimisation")
table([["Hard limit (veto)", "Rule"],
       ["No reliable terrain data", "Outside the elevation model, or a flagged blunder."],
       ["Keep-out, planetary protection", "Within 2σ of position error of a keep-out or Special Region."],
       ["Cliff", "Cliff distance minus 2σ below the stand-off (10 m on foot, 20 m by rover)."],
       ["Slope", "Walking slope over 20° on foot; 25° on rock or 12° on sand by rover; 30° for a robot."],
       ["Step", "Over 0.8 m on foot; 0.35 m by rover."],
       ["Soft soil", "Wheel-slip CVaR (the mean of the worst 10 % of outcomes) at or above 0.7 for vehicles."],
       ["Walk home", "Any partial route from which the crew could not walk home with what is left is dropped during the search."]],
      [1.9 * inch, CW - 1.9 * inch])
P("Only then are routes optimised, over five criteria each normalised by the fastest route: time, hazard exposure, "
  "consumables, recoverability (walk-home time, radio line of sight, position error) and science value missed. The default "
  "weights come from the team's pairwise judgements with AHP (safety 0.42, consumables 0.22, recoverability 0.22, time 0.09, "
  "science 0.04; consistency ratio under 0.01). NASA has published no Mars route weights, so they are documented as an "
  "assumption and shown to be robust: 40 random perturbations keep 100 % of runs within 80 % of the same route.")
H2("Crew, suit and the walk-home field")
bullets(["<b>Walking speed</b> from Apollo planning speeds, slowed on slopes by an Apollo regolith footing curve and a "
         "constant-metabolic-power limit; slower on sand and rocky ground.",
         "<b>Metabolic power</b> from the Minetti cost of transport scaled to Mars gravity, with suit inefficiency; oxygen, "
         "CO₂ and heat follow by physics, plus a small suit leak.",
         "<b>Walk-home fields.</b> For every point, the time and consumables needed to walk home are computed over the whole "
         "map, so the search can test the guarantee instantly at every step.",
         "<b>Environment</b>: the Mars24 clock, sun and shadows from horizon maps, temperatures from a harmonic fit to MEDA "
         "records, dust opacity, and radiation from the Curiosity RAD surface average."])
H2("The whole planet")
table([["Zoom", "Elevation", "Imagery"],
       ["Whole planet", "MOLA MEGDR 16 px/deg (3.7 km)", "Viking MDIM 2.1 colour, 232 m"],
       ["Regional", "MOLA MEGDR 128 px/deg (463 m); HRSC-MOLA blend 200 m", "Viking colour, THEMIS 100 m"],
       ["Close", "CTX stereo models, 20 m (44,628 on USGS STAC)", "CTX global mosaic, 5 m"],
       ["Closest", "HiRISE stereo models, 1 m (1,262 on USGS STAC)", "HiRISE, 0.25-1 m"]],
      [1.1 * inch, 2.8 * inch, CW - 3.9 * inch])
P("Mars is cut into a pyramid of map tiles, the same tiling as NASA's Mars Trek. Each frame the globe keeps only the tiles "
  "in view; a tile splits into four finer ones when it covers more than about 330 pixels, and a coarse tile keeps drawing "
  "until its children arrive, so the ground never has holes. The local server builds each tile on demand from the best "
  "data under it and keeps a disk cache (20 GB by default, oldest removed first).")

# ================================================================== 13. VALIDATION
chapter("Validation and testing", "checked against Perseverance",
        "MarsNav is tested against the real rover's records, not only against itself, and every result is reported, "
        "including the one that did not go our way. The figures below were re-run on 26 October 2026 for this guide.")
table([["Check", "Result"],
       ["Mars clock vs Perseverance MEDA sun geometry", "Solar zenith angle error 0.001 ± 0.086° (95 % within 0.20°) over 5,616 samples on 117 sols; local true solar time within 5 s."],
       ["Terrain vs the rover", "Walking-scale slope at or above the rover's measured chassis tilt at 74 % of 480 points (r = 0.72). Elevation agrees to 0.2 ± 0.4 m, but that check is not independent: JPL localises the rover against the same orbital maps."],
       ["False no-go rate", "2 % of 703 real Perseverance positions, all cliff-edge stand-offs."],
       ["Hazard model vs JPL's choices", "On 30 detour drives the hazard index along the rover's real path is 0.182 against 0.208 for the straight line; the real path scores lower on 21 of 30. MarsNav's risk-aware route scores 0.111."],
       ["Bedform avoidance", "Strong bedform evidence on 3 % of the rover's path against 7 % of the surrounding 1 km corridor."],
       ["Route geometry vs the rover's drives", "Not better than a straight line (38 m vs 34 m mean offset). Reported as a negative result: rover drives are shaped by science stops, AutoNav and sub-metre hazards."],
       ["Same trip as the rover", "Séítah to the delta front: Perseverance drove 7.1 km over 85 sols; MarsNav plans 3.07 km for a robotic scout in under a second, or 2.92 km in a 1.4 h EVA for a crew. Over 45 real drives its routes cross 47 % less mapped sand and 55 % less rocky ground than the rover did, and its speed model reproduces the rover's measured 79.7 m/h (79 m/h). It rates Séítah only 1.5x slower per metre where JPL projected 4x, so for a rover it still prefers the shorter corridor JPL rejected."],
       ["Weight robustness", "AHP consistency ratios all under 0.01; 40 random perturbations keep 100 % of runs within 80 % of the balanced route."],
       ["Closed loop vs flying the filed plan", "40 paired EVAs with crews and hardware the planner was not told about: 0 of 40 dipped into the reserve with the loop, 31 of 40 without (Wilcoxon p < 0.001)."],
       ["Against NASA's TSS2027 server", "Learned an 8x faster battery and CO₂ drain and turned the EVA home within about 2 minutes."],
       ["Station selection", "Held-Karp exact over all 32,767 sets of 15 candidates in about 35 ms."],
       ["Speed", "2.3 million 10 m cells; five named routes in about 3 s on one laptop core."],
       ["Reproducibility", "A full rebuild from the raw USGS files gives byte-identical layers."]],
      [1.85 * inch, CW - 1.85 * inch])
H2("The closed-loop campaign")
table([["Measure", "Closed loop", "Open loop (filed plan)"],
       ["Lowest usable consumable left, mean", "24.6 %", "−5.1 %"],
       ["Lowest usable consumable left, worst run", "3.1 %", "−40.8 %"],
       ["Runs that dipped into the reserve", "0 of 40", "31 of 40"],
       ["Runs that needed a RETURN NOW warning", "0", "31"],
       ["Science completed without touching the reserve", "0.64", "0.29"]],
      [2.9 * inch, 1.6 * inch, CW - 4.5 * inch])
small("Each EVA is flown twice with the same random numbers and a hidden truth drawn per run (work rate ×0.9-1.4, cooling "
      "water ×0.9-1.4, battery drain ×0.9-1.5, walking pace ×0.7-1.1). The open-loop crew completes more raw science (0.90 "
      "vs 0.64) because it often finishes stations on reserve oxygen or battery; counting only science done without "
      "touching the reserve, the loop comes out ahead. Both arms use the same simulator.")
H2("Automated tests")
table([["Suite", "Command", "Result (26 Oct 2026)"],
       ["Engine and closed loop (Node 20+)", "node --test tests/*.test.mjs", "63 of 63 pass"],
       ["Data pipeline and downloader", "python -m pytest tests -q", "15 of 15 pass"],
       ["Validation vs Perseverance", "node validation/validate.mjs", "results above, about 30 s"],
       ["Closed-loop campaign", "node validation/closed_loop_campaign.mjs", "0 / 40 vs 31 / 40, about 70 s"],
       ["Same trips as the rover", "node validation/rover_case_study.mjs", "results above, about 15 s"],
       ["Desktop server under load", "selftest.bat (MarsNav.exe --selftest)", "every check passes: server killed and replaced in 3 s, no process left"]],
      [1.9 * inch, 2.45 * inch, CW - 4.35 * inch])
P("The tests include the planner's safety contract on real terrain (every route inside its hard limits with a walk-home "
  "plan at every point), navigation-filter consistency, estimator convergence, the UDP telemetry bridge over real sockets, "
  "and exact against heuristic station selection. Full reports: <font name='Plex'>validation/REPORT.md</font>, "
  "<font name='Plex'>validation/CLOSED_LOOP.md</font>, and the method in <font name='Plex'>docs/05_verification_and_validation.md</font>.")

# ================================================================== 14. FOR JUDGES
chapter("How MarsNav answers the challenge", "for judges",
        "The challenge asks for an interplanetary survival guide: a layered map that helps astronauts plan and carry out "
        "a safe, successful Marswalk with science along the way. Here is MarsNav against the challenge and the criteria.")
callout("What is new compared with existing tools", "Mapping tools show terrain; route planners optimise a cost. MarsNav makes "
        "NASA's walkback rule an algorithm, prices the uncertainty that trapped Spirit, treats navigation error as a planning "
        "input, closes the loop with suit telemetry, and carries the same safety logic from choosing the landing site to the "
        "last step of each EVA, offline.", "rust")
table([["The challenge asks for", "MarsNav"],
       ["“a layered, integrated view of a location or route”", "Eleven terrain layers and four overlays at 10 m, routes with uncertainty, a timeline profile; the whole planet with six base maps and six overlays."],
       ["“data from multiple NASA science missions”", "MRO (HiRISE, CTX), MGS (MOLA, TES), Mars Odyssey (GRS, THEMIS), Mars Express (HRSC), Mars 2020 (MEDA, traverse, tilt), MSL (RAD), Viking, Apollo (walking)."],
       ["“details of their routes and destinations”", "Guidance legs, station procedures, target provenance, the cue card, GeoJSON."],
       ["“updates on current conditions”", "Live Mars clock, sun and shade along the route, dust, radio line of sight, position error, and live suit telemetry with learned rates."],
       ["“complete their mission quickly and safely”", "Five named routes under hard limits, walk-home margins everywhere, caution and warning, automatic return."],
       ["“plan and carry out a successful Marswalk”", "Plan, Execute and Review, with the 3D rehearsal and the drive window."],
       ["“new and exciting science along the way”", "Perseverance's real sample sites, a science-value optimiser, landing sites scored for water ice."]],
      [2.0 * inch, CW - 2.0 * inch])
H2("The judging criteria")
table([["Criterion", "Evidence in MarsNav"],
       ["Influence", "The decisions NASA must make before the first crewed EVA; site-agnostic; reads NASA's SUITS telemetry format; "
        "runs offline on one laptop; open data and open source."],
       ["Creativity", "Walk-home guarantee inside the search; soft soil priced by its tail (CVaR); position error as a planning "
        "input; walking-scale terrain from 1 m stereo; a closed loop that learns the crew and the suit; Mars mode."],
       ["Validity", "Validated against Perseverance; a negative result reported; 78 automated tests; a paired 40-EVA campaign "
        "with a significance test; byte-identical rebuilds; assumptions tagged."],
       ["Relevance", "Every point of the challenge statement (above), demonstrated at Perseverance's own field site."],
       ["Presentation", "A native desktop app with a guided Tour and 3D rehearsal; this guide; focused documents in docs/."]],
      [1.1 * inch, CW - 1.1 * inch])
# ================================================================== 15. BUILD FROM SOURCE
chapter("Building from source", "for developers and reviewers",
        "The portable app is built from this repository with one script. You only need this chapter to change the code, "
        "rebuild the science data or reproduce the results.")
H2("Build the desktop app")
P("On Windows with Python 3.10 or later (tick “Add python.exe to PATH”) and an internet connection, double-click "
  "<b>build_exe.bat</b> in the project folder. It:")
numbered(["creates a private build environment in <font name='Plex'>.buildvenv</font> (your own Python is not touched);",
          "installs numpy, scipy, rasterio, Pillow, pywebview, pythonnet and PyInstaller from <font name='Plex'>requirements.txt</font>;",
          "compiles <font name='Plex'>launcher/martian_map.py</font> and <font name='Plex'>launcher/desktop.py</font> into "
          "<b>MarsNav.exe</b>, a windowed program with its libraries in <font name='Plex'>MarsNav_runtime</font>;",
          "assembles the portable package: <font name='Plex'>dist\\MarsNav\\</font> and <font name='Plex'>dist\\MarsNav-Windows.zip</font>;",
          "starts the new MarsNav.exe as a check."])
P("The <font name='Plex'>app/</font> and <font name='Plex'>planet/</font> folders are read from disk, so changes there "
  "need no rebuild; changes to <font name='Plex'>launcher/</font> or the pipeline do.")
H2("Run from source")
code("# the desktop app from source (Windows, with the build environment)\n"
     ".buildvenv\\Scripts\\python.exe launcher\\martian_map.py\n"
     "\n"
     "# text modes\n"
     "MarsNav.exe --console      # the text menu, app in the default browser\n"
     "MarsNav.exe --headless     # serve only (development, tests)\n"
     "MarsNav.exe --selftest     # end-to-end server check under load\n"
)
H2("Rebuild the science data")
P("The data ship pre-built. To regenerate them from the raw NASA and USGS files (about 0.9 GB download, about 10 minutes), "
  "use <b>Data</b> menu, <b>Rebuild Jezero data</b>, or from source:")
code("pip install -r requirements.txt\n"
     "bash tools/build_all.sh     # fetch + SHA-256 check, terrain, layers, weather fit, imagery")
small("Raw rasters are read from data_cache/raw/, a _data_raw/ folder next to the project, or $MM_RAW. Exact URLs and "
      "checksums are in pipeline/sources.json. A full rebuild reproduces the shipped layers byte for byte.")
small("Tests: node --test tests/*.test.mjs (61), python -m pytest tests -q (15), node validation/validate.mjs, "
      "node validation/closed_loop_campaign.mjs, and selftest.bat (Chapter 13).")

# ================================================================== 16. TROUBLESHOOTING
chapter("Troubleshooting", "if something does not work",
        "Most problems have a one-line fix. MarsNav also keeps logs that say exactly what happened.")
table([["Symptom", "What to do"],
       ["“Windows protected your PC”", "Expected for an unsigned program. Click More info, then Run anyway. Antivirus may also ask once."],
       ["“MarsNav cannot find its 'app' folder”", "The exe was moved on its own. Keep MarsNav.exe with the folders it came with; move the whole folder."],
       ["“MarsNav cannot save data in its folder”", "The folder is read-only (for example inside C:\\Program Files). Copy the whole folder to your Desktop, Documents or another drive."],
       ["The window opens in an Edge window instead", "This PC has no WebView2 runtime. Everything works the same; install WebView2 from Microsoft to get the native window."],
       ["Starting it again does nothing", "MarsNav is already running: its window is brought to the front. Look for it in the taskbar."],
       ["The first start is slow", "Windows checks the program files the first time; later starts take a few seconds."],
       ["Landing mode is blurry close up", "Close-up detail needs CTX (20 m) or HiRISE (1 m) data under that spot; elsewhere 463 m MOLA is the best that exists. The first view of an area downloads its data in the background and sharpens by itself."],
       ["A science layer did not install", "Each comes from a different server. The others work; press Install the missing layer later in the Data tab."],
       ["Local mode says it will not fit", "Untick the 11 GB blended elevation or a THEMIS pack, use a smaller zone radius, or free disk space."],
       ["The map stops responding", "Wait a few seconds: the supervisor replaces a stalled engine within 30-60 s (3 s if it exits). Help, Engine status shows its health."]],
      [1.95 * inch, CW - 1.95 * inch])
H2("Logs and the self-test")
P("<b>Help</b>, <b>Open the log folder</b> opens <font name='Plex'>data_cache</font>: <font name='Plex'>server.log</font> "
  "(start-up, restarts, errors and a memory census), <font name='Plex'>desktop.log</font>, <font name='Plex'>server_child.log</font>, "
  "<font name='Plex'>workers.log</font> and, if the engine ever stalled, <font name='Plex'>server_hang.log</font> with what "
  "every thread was doing. <b>selftest.bat</b> loads the server for about three minutes, kills a raster worker and the server "
  "on purpose, and checks that everything recovers; its report is <font name='Plex'>data_cache\\selftest.txt</font>.")
callout("Keep some space free on C:", "Windows needs free space on the system drive to grow its page file. With almost none, "
        "every program can run out of memory. MarsNav writes nothing to the system drive itself, but warns in its log when "
        "it is below 2 GB.", "amber")

# ================================================================== 17. LIMITATIONS
chapter("Honest limitations", "what MarsNav does not claim",
        "A tool for life-critical decisions must be clear about its limits. These are condensed from "
        "docs/08_limitations.md; every assumption is tagged [ASSUME] in the code.")
H2("Claims not made")
bullets(["<b>Not a flight product.</b> Not certified to any NASA standard. The display is informed by NASA-STD-3001 Appendix F "
         "and the SUITS requirements, not compliant with them.",
         "<b>No human has walked on Mars.</b> Walking speed (Apollo), metabolic cost (Minetti, scaled to Mars gravity), suit "
         "capacities (EMU heritage), the 20° slope limit and the 0.8 m step limit are assumptions carried over from Earth and Moon.",
         "<b>The route weights are the team's own.</b> NASA has published none; they are shown to be robust, not official.",
         "<b>Routes do not reproduce Perseverance's actual drives</b> better than a straight line. This is reported, not tuned away.",
         "<b>Landing-site scores are a first screen</b> from orbital data. A crewed site still needs HiRISE imaging and 1 m "
         "elevation over the whole ellipse and an engineering review. SWIM says where ice is consistent with every dataset, "
         "not that it has been sampled."])
H2("Data and software limits")
bullets(["1 m HiRISE coverage is 75 % of the Jezero operations area with all seven DTMs (64 % with the default four). Elsewhere "
         "the map is 20 m-based, and boulders or scarps smaller than about 20 m are not in it; route cards say so.",
         "The weather model is a fit to sampled MEDA records: typical conditions, not a forecast. Dust storms enter through τ.",
         "Radiation uses the Curiosity RAD surface average; solar particle events are a contingency, not a modelled dose.",
         "The closed loop has run against NASA's TSS2027 server, not flight hardware; the campaign measures the loop's logic "
         "with a shared simulator.",
         "The path search keeps up to four labels per grid cell (near-optimal across five criteria); returned routes are "
         "re-evaluated exactly afterwards.",
         "Voice is an offline intent parser with speech output (no speech recognition). The global traverse router plans "
         "long drives on 20-463 m elevation; build a hub at each end for EVA-scale planning.",
         "Moving the weather model to a new latitude is a first-order correction, not a climate model. MarsNav is a Windows "
         "program; the EVA planner alone runs in any modern browser from a simple web server (Chapter 15)."])

# ================================================================== 18. PROJECT STRUCTURE
chapter("Project structure", "where everything is",
        "The repository layout, for anyone reading or extending the code.")
table([["Path", "Contents"],
       ["MarsNav.exe, MarsNav_runtime/, dist/", "The desktop app built by build_exe.bat, its libraries, and the portable folder and zip. Build output, kept out of the repository (.gitignore)."],
       ["launcher/", "martian_map.py (supervisor, local server, worker and job processes, self-test), desktop.py (the native "
        "window, menus, dialogs), wintheme.py (dark title bar and menu), make_portable.py, the icon and version resource."],
       ["app/", "The interface: index.html (EVA planner), landing.html (Landing mode), drive.html (3D drive window), css/, js/, "
        "theme.css (the shared console style), engine/ (copy of engine/), data/ (built Jezero layers), vendor/ (three.js and the "
        "fonts), sw.js (offline cache)."],
       ["engine/", "The planning engine in plain JavaScript, shared by the app, the tests and the validation."],
       ["planet/", "The whole-planet engine: tiles and cache, raster readers, STAC catalogue, IAU names, landing assessment, site "
        "generator, science datasets, Local mode, TSS bridge and the HTTP API."],
       ["pipeline/", "The Python data pipeline and the site definitions (pipeline/sites/*.json)."],
       ["validation/", "Validation against Perseverance and the closed-loop campaign, with their reports."],
       ["tests/", "Engine and closed-loop tests (Node), pipeline and downloader tests (pytest)."],
       ["tools/", "build_all.sh, the TSS bridge and stand-in, guide/ (the screenshot script and this guide's source), dev/ (developer scripts)."],
       ["docs/", "Concept of operations, architecture, algorithms, data provenance, verification, requirements traceability, "
        "deployment and new sites, limitations, the closed loop and hardware interface, station tasks, station selection."],
       ["submission/", "Judging-criteria map, demo script, comparison with other approaches, screenshots."],
       ["build_exe.bat, selftest.bat", "Build the app; test the server end to end."],
       ["data_cache/", "Created at run time: downloads, tiles, science layers, Local mode packs, built sites, reports, logs. Not part of the repository."]],
      [1.85 * inch, CW - 1.85 * inch], mono_first=True)

# ================================================================== 19. CREDITS
chapter("Data sources and credits", "standing on NASA's shoulders",
        "MarsNav is built entirely on public data. All mission data are US Government works in the public domain or "
        "openly licensed; exact sources, URLs and checksums are in pipeline/sources.json and docs/04_data_and_provenance.md.")
table([["Data", "Source"],
       ["HiRISE 1 m stereo DTMs and orthoimages; CTX 20 m DTMs and 6 m orthoimages", "Mars Reconnaissance Orbiter; USGS Astrogeology (STAC catalogue), NASA-JPL Mars 2020 products"],
       ["MOLA MEGDR elevation", "Mars Global Surveyor (Smith et al. 2001), PDS Geosciences Node"],
       ["HRSC-MOLA blended DEM, 200 m", "Mars Express / MGS (Fergason et al. 2018), USGS"],
       ["CTX global mosaic, 5 m", "Dickson et al. 2023, Caltech Murray Lab; served by Esri / ASU"],
       ["Viking MDIM 2.1, THEMIS infrared mosaics, Exploration Zone centres", "USGS; ASU; NASA Mars Trek"],
       ["MEDA weather, rover traverse and tilt", "Mars 2020 Perseverance; PDS Atmospheres Node; Mars 2020 waypoint feed"],
       ["RAD surface radiation", "Mars Science Laboratory Curiosity"],
       ["SWIM subsurface water-ice consistency", "Morgan et al. 2021 (Nature Astronomy), 2025 (PSJ); Planetary Science Institute"],
       ["TES thermal inertia", "Putzig & Mellon 2007 (Icarus), PDS Geosciences Node"],
       ["GRS water-equivalent hydrogen", "Mars Odyssey (Boynton et al. 2007, JGR), PDS"],
       ["Crater database (384,343 craters ≥ 1 km)", "Robbins & Hynek 2012 (JGR), 2020 release"],
       ["Global geologic map, SIM 3292", "Tanaka et al. 2014, USGS (OGC API)"],
       ["Candidate sites", "NASA First Landing Site / Exploration Zone Workshop (2015); Golombek et al. 2021 (Starship); NSSDCA"],
       ["Place names", "IAU Gazetteer of Planetary Nomenclature"],
       ["Mars clock", "Mars24 algorithm, NASA GISS"]],
      [2.55 * inch, CW - 2.55 * inch])
P("Software: three.js (MIT), numpy, scipy, rasterio / GDAL, Pillow, pywebview, pythonnet and PyInstaller. Fonts in this "
  "guide: Barlow and IBM Plex Mono (SIL Open Font License). MarsNav's own code is released under the MIT licence (LICENSE).")
spacer(10)
callout("About this guide", "Written for MarsNav 2.0 for the NASA Space Apps Challenge 2026 (Interplanetary Survival Guide: "
        "Martian Map). Every screenshot was taken from the running desktop app on real data; every number in Chapter 13 was "
        "re-run for this edition.", "cyan")
