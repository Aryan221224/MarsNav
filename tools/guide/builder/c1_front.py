# -*- coding: utf-8 -*-
# Cover, at-a-glance, contents, chapters 1-3
from glib import *

# ------------------------------------------------------------------ cover (drawn by the page template)
story.append(NextPageTemplate("Cover"))
story.append(Spacer(1, 1))
story.append(NextPageTemplate("Body"))
story.append(PageBreak())

# ------------------------------------------------------------------ at a glance
story.append(Paragraph("AT A GLANCE", ST["kicker"]))
story.append(Paragraph("Which way do we go, and can we always get home?", ST["h1"]))
story.append(Rule(CW, RUST, 2.2, space=8))
lead("MarsNav is mission software for the first human crews on Mars. It helps a mission <b>choose where to land and "
     "build the base</b>, then <b>plan and fly every Marswalk (EVA)</b> from it, on real NASA and USGS data, with hard "
     "safety limits, a walk-home guarantee, and no Earth link needed.")
stats([("66", "candidate landing sites screened on real data: NASA's 48 Exploration Zones, 7 Starship sites, 11 landed spacecraft"),
       ("5", "named EVA routes in about 3 s on one laptop core, every one inside hard limits"),
       ("0 / 40", "simulated EVAs dipped into the reserve with MarsNav's closed loop, against 31 / 40 flying the filed plan"),
       ("Offline", "Mars mode: every map tile and dataset served from this computer; outside data requests refused and counted"),
       ("118", "automated tests pass (65 engine and closed-loop, 53 pipeline, science atlas and place); every build is tested on a clean Windows PC"),
       ("0.086°", "sun-angle error of the Mars clock against Perseverance's MEDA sensor, over 5,616 samples"),
       ("21 / 30", "real Perseverance detours where MarsNav's hazard map agrees the rover chose safer ground"),
       ("1 click", "to run: a native Windows app, no install, no Python, works on a fresh PC"),
       ("Any point", "of Mars, one click: ground, ice, minerals, air, where water boils, radiation, gravity, science and missions there"),
       ("26", "more whole-planet science layers: spectral, chemical, geophysical, atmospheric, radiation, with 74,250 mapped features"),
       ("31", "Mars missions catalogued, past, active, en route and planned, as of 28 October 2026"),
       ("3", "crew displays fed live: a helmet-visor HUD, a rover dashboard and a wrist cuff, with real maps")], cols=4)
H2("What you can do with it")
table([["Stage", "Where", "What it does"],
       ["Choose the landing site", "Landing mode", "The whole of Mars in 3D from NASA / USGS data; every candidate scored on NASA's human landing-site criteria."],
       ["Know any place", "Landing mode, EVA planner", "Click any point on Mars or on a site: every data layer MarsNav holds about it, at once."],
       ["Choose the science", "Landing mode, Science tab", "26 more whole-planet layers, seven science objectives that rank every site, 31 missions, space weather."],
       ["Commit the hub", "Landing mode", "Builds the chosen site into a full EVA site: elevation, hazards, imagery, weather, targets."],
       ["Plan the Marswalk", "Plan", "Hard limits first, then five named routes with oxygen, water and battery budgets, rehearsed in 3D."],
       ["Fly it", "Execute", "NASA SUITS telemetry, navigation without GPS, caution and warning, automatic re-planning."],
       ["Wear it", "Crew displays", "The same EVA on a helmet-visor HUD, a rover dashboard and a wrist cuff, with the ground under the crew."],
       ["Debrief", "Review", "Planned vs flown, event log, paper cue card, GeoJSON, validation on real rover data."],
       ["Go offline", "Local / Mars mode", "Every dataset on this computer at native resolution; then cut the Earth link."]],
      [1.3 * inch, 1.05 * inch, CW - 2.35 * inch])

# ------------------------------------------------------------------ start here
story.append(CondPageBreak(3.6 * inch))
story.append(Paragraph("START HERE", ST["kicker"]))
story.append(Paragraph("Find your way in", ST["h1"]))
story.append(Rule(CW, RUST, 2.2, space=8))
callout("For judges: the two-minute path",
        None, "green",
        ["Download <b>MarsNav-Windows.zip</b> from <font name='Plex'>github.com/Aryan221224/MarsNav/releases/latest</font>, "
         "unzip it and double-click <b>MarsNav.exe</b> (Chapter 2).",
         "Click <b>Tour</b> in the top bar: a guided, seven-step walkthrough of the EVA planner (Chapter 12).",
         "Click <b>Landing mode</b> and click anywhere on Mars: every data layer at that point appears (Chapter 5). Then pick "
         "<b>Arcadia Planitia AP-1</b> and press <b>Assess landing site</b> (Chapter 4).",
         "In the <b>Science</b> tab, choose <b>Groundwater and the boxwork of Mount Sharp</b>, the challenge's own example, and "
         "press <b>Rank sites for it</b> (Chapter 6).",
         "In the EVA planner, press <b>Execute</b>, <b>Run</b>, then <b>HUD</b>: the helmet visor, rover dashboard and wrist cuff "
         "follow the EVA (Chapter 10).",
         "Open <b>Local mode</b> and switch on <b>Mars mode</b>: the app keeps working with the internet cut (Chapter 7).",
         "Read Chapter 16 for the validation against Perseverance and Chapter 17 for how MarsNav answers the challenge."])
H2("Who this guide is for")
table([["If you are…", "Read", "You will learn"],
       ["A judge or reviewer", "At a glance, Chapters 2, 12, 16, 17", "What MarsNav is, how to see it working in minutes, and the evidence behind it."],
       ["A mission planner or crew member", "Chapters 4-13", "Choosing and committing a landing site, then planning, flying and debriefing an EVA on the crew's displays."],
       ["Showing it offline", "Chapter 7", "Downloading the data and running in Mars mode with no Earth link."],
       ["A scientist or engineer", "Chapters 5, 6, 14-16, 20", "The data at any place, the science atlas, the algorithms, the validation and the honest limits."],
       ["A developer", "Chapters 3, 18, 19, 21", "How the app is put together, built, tested and fixed."]],
      [1.8 * inch, 1.85 * inch, CW - 3.65 * inch])
H2("The mission journey")
P("MarsNav follows the mission from orbit to the end of each Marswalk. Landing mode covers the first two stages and the "
  "EVA planner the last three; a hub committed in Landing mode becomes a full EVA site in the planner.")
journey()
small("In this guide, <b>bold</b> marks buttons and menus as they appear in the app, <font name='Plex'>monospace</font> marks "
      "files and commands, and numbered red markers on a screenshot match the table under it.")

# ------------------------------------------------------------------ contents
story.append(PageBreak())
story.append(Paragraph("CONTENTS", ST["kicker"]))
story.append(Paragraph("Inside this guide", ST["h1"]))
story.append(Rule(CW, RUST, 2.2, space=10))
story.append(toc_flowable())

# ================================================================== 1. WHY MARSNAV
chapter("Why MarsNav", "the problem and the idea",
        "The first humans on Mars will make two decisions that no map app can make for them: where to put the base, and "
        "which way to walk from it, every day, with a fixed supply of air and no one on Earth fast enough to help. "
        "MarsNav is built for both.")
H2("The operating problem")
bullets(["<b>Light delay.</b> A radio signal takes 3 to 22 minutes each way. Mission control can advise, but the crew "
         "must decide on the spot.",
         "<b>No GPS.</b> Position comes from dead reckoning, the sun, landmarks and a beacon at the habitat, so every "
         "position has an error that grows with distance.",
         "<b>Finite consumables.</b> Suit oxygen, cooling water, CO₂ scrubber capacity and battery set hard ceilings. "
         "NASA's walkback rule says the crew must always be able to walk home, even if the rover fails.",
         "<b>Terrain that has already bitten.</b> Spirit was trapped in soft soil that looked firm; Opportunity was "
         "stuck for six weeks in a wind ripple. A boot meets slopes and steps that a 20 m elevation model cannot show.",
         "<b>Choosing the hub.</b> NASA's 2015 workshop proposed 48 Exploration Zones and SpaceX studied candidate "
         "Starship sites. Each must clear engineering limits and offer water ice, safe ground and science."])
H2("What MarsNav does differently")
bullets(["<b>Hard limits before optimisation.</b> Unsafe ground, cliffs, keep-outs and anything beyond the walk-home "
         "budget are removed first. Only then are routes optimised, so no weight setting can trade safety away.",
         "<b>A walk-home guarantee inside the search.</b> Every partial route is dropped the moment the crew could not "
         "walk home with what is left. If no plan can work, MarsNav shows the point of no return and the resource that "
         "runs out there, rather than quietly relaxing a rule.",
         "<b>The ground a boot meets.</b> Walking-scale slope and step height from 1 m HiRISE stereo models, a ripple "
         "detector, and soft soil priced by its worst cases (CVaR), not its average.",
         "<b>A closed loop with the hardware.</b> During the EVA it reads suit telemetry in NASA's own SUITS format, "
         "learns how hard the crew is really working and how fast the suit is draining, and re-plans before the margin "
         "is gone.",
         "<b>Honest about what it does not know.</b> Data confidence on every route, assumptions tagged <font name='Plex'>[ASSUME]</font> "
         "in the code, and validation against Perseverance's own records, including the result that did not go our way.",
         "<b>Everything about a place, one click away.</b> Any point on Mars, or on a site, shows every layer MarsNav holds "
         "there: ground, ice, minerals, air, where water boils, radiation, gravity, science, missions and the best data.",
         "<b>Science first.</b> Twenty-six more whole-planet layers grouped by the kind of measurement, seven science "
         "objectives that rank every candidate site, the missions past, present and future, and space weather.",
         "<b>On the crew's own displays.</b> The same EVA, live, on a helmet-visor HUD, a rover dashboard and a wrist cuff, "
         "with the orbital map under the route and the facts about the ground the crew stands on.",
         "<b>Built for Mars, so it runs without the internet.</b> Local mode puts every dataset on the computer; Mars "
         "mode proves it by refusing every outside request."])
figure("p01_plan_overview", "The EVA planner on real Jezero crater data: the EVA set-up (left), the composite safety-hazard "
       "map with the planned route to the Amalik delta front, where Perseverance cored Mageik (centre), the five named routes "
       "(right) and the elevation, walk-home margin and sun profile along the route (bottom).")

# ================================================================== 2. QUICK START
chapter("Quick start", "two minutes from download to Mars",
        "MarsNav is a portable Windows program: one folder, one double-click. Nothing is installed and nothing needs "
        "admin rights, so it runs the same on a judge's laptop as on the development machine.")
H2("What you need")
table([["Item", "Requirement"],
       ["Computer", "Windows 10 or 11, 64-bit. 4 GB RAM (8 GB recommended)."],
       ["Disk", "About 300 MB for the program (a download of about 160 MB), plus room for data the app downloads (the tile cache is "
        "capped at 20 GB; Local mode packs are optional and sized before you download)."],
       ["Window engine", "Microsoft Edge WebView2, which is part of Windows 10 and 11. On a PC without it, MarsNav opens in "
        "a Microsoft Edge app window instead (no tabs, no address bar)."],
       ["Internet", "Optional. The Jezero EVA planner works fully offline from the data shipped in the folder. Landing mode "
        "streams whole-planet data the first time you look at a place, or uses Local mode packs."],
       ["Python, Node, admin rights", "Not needed."]], [1.55 * inch, CW - 1.55 * inch])
H2("Run it")
numbered(["Download <b>MarsNav-Windows.zip</b> from the latest release, "
          "<font name='Plex'>github.com/Aryan221224/MarsNav/releases/latest</font>. Every release is built and tested on a "
          "clean Windows machine before it is published (Chapter 18).",
          "Unzip it anywhere you can save files: your Desktop, Documents, another drive such as "
          "D:\\, or a USB stick. Not inside C:\\Program Files.",
          "Open the <b>MarsNav</b> folder and double-click <b>MarsNav.exe</b>.",
          "The first time on a new PC, Windows may show <b>“Windows protected your PC”</b> because the program is not "
          "code-signed. Click <b>More info</b>, then <b>Run anyway</b>. This happens once.",
          "The start-up screen appears while the map engine starts (a few seconds; up to a minute the very first time "
          "while Windows checks the files). The EVA planner then opens on Jezero crater.",
          "Optional: <b>MarsNav</b> menu, <b>Add desktop and Start menu shortcuts</b>."])
figrow([("sp5", (10, 66, 1790, 1020), "Start-up screen"), ("m_land", None, "Landing mode, a few seconds later")],
       "MarsNav starting on a fresh PC: the logo start-up screen while the local map engine starts, then the app in its own "
       "window, with its own icon in the title bar and taskbar.")
H2("What is in the folder")
table([["Item", "What it is"],
       ["MarsNav.exe", "The program. Double-click to run."],
       ["MarsNav_runtime\\", "Its libraries (Python, numpy, scipy, GDAL / rasterio, WebView2 bindings). Keep it next to the exe."],
       ["app\\", "The interface and the planning engine, plus the Jezero site data (works offline)."],
       ["planet\\, pipeline\\", "The whole-planet engine and the data pipeline used to build new sites."],
       ["MarsNav_User_Guide.pdf", "This guide (also Help, User guide)."],
       ["START HERE.txt", "A one-page version of this chapter."],
       ["data_cache\\", "Created on first run: everything MarsNav downloads or builds (map tiles, science layers, Local "
        "mode packs, built hub sites, reports, logs)."]], [1.75 * inch, CW - 1.75 * inch], mono_first=True)
callout("Keep the folder together", "MarsNav.exe needs the folders next to it. Move or copy the whole MarsNav folder, never "
        "the .exe alone. To remove MarsNav, delete the folder (and the shortcuts if you added them).", "amber")
H2("Your first ten minutes")
numbered(["Press <b>Tour</b> in the top bar for a guided walkthrough of the EVA planner.",
          "Press <b>Plan EVA</b> and compare the five route cards on the right.",
          "Switch to <b>Execute</b>, set the speed to 120x and press <b>Run</b>; then press <b>Suit leak</b> and watch "
          "the warning and the automatic walk-home.",
          "While the EVA runs, press <b>HUD</b> on the map: the helmet visor opens, with the rover dashboard and the wrist "
          "cuff one key away (1, 2, 3).",
          "Click any point of the map: a card shows the site's terrain there and every planet-wide layer.",
          "Press <b>Landing mode</b>, click anywhere on Mars, then choose a candidate and press <b>Assess landing site</b>.",
          "Open <b>Local mode</b> and switch on <b>Mars mode</b>."])

# ================================================================== 3. THE DESKTOP APP
chapter("The MarsNav desktop app", "window, menus and files",
        "MarsNav runs in its own native window, not in a web browser. Behind the window, a supervised local engine "
        "streams the planet, runs the heavy computations and keeps itself healthy.")
figure("p01_plan_overview", "The MarsNav window (EVA planner). Numbers mark the parts described below.",
       marks=[(0.143, 0.050, 1), (0.106, 0.083, 2), (0.234, 0.082, 3), (0.404, 0.082, 4), (0.589, 0.078, 5), (0.812, 0.078, 6), (0.971, 0.120, 7), (0.167, 0.151, 8), (0.284, 0.243, 9), (0.562, 0.158, 10), (0.803, 0.151, 11), (0.500, 0.497, 12), (0.552, 0.680, 13), (0.072, 0.927, 14)])
table([["#", "Part", "What it shows or does"],
       ["1", "Menu bar", "MarsNav, View, Data and Help menus (table below), in the same console colours as the window."],
       ["2", "MarsNav and site", "The site being planned (here Jezero crater)."],
       ["3", "Module switch", "Landing (where the crew lands and lives) and EVA planner (plan, fly and review a Marswalk)."],
       ["4", "EVA phase", "Plan, Execute and Review."],
       ["5", "Mars clock", "UTC, mission sol, local mean solar time and sun elevation; wider windows also show the season (Ls) and the one-way radio delay to Earth."],
       ["6", "Annunciators", "The EVA phase and telemetry source (PRE-EVA, EVA · SIM TLM, EVA · LIVE TLM, POST-EVA), then the W / C / A counters: warnings, cautions, advisories."],
       ["7", "Tour", "The guided two-minute walkthrough (Chapter 12)."],
       ["8", "Left panel", "EVA set-up in Plan, telemetry and controls in Execute, exports and the event log in Review."],
       ["9", "Map tools", "Zoom, fit the route, 3D view, Drive (the first-person drive window) and HUD (the crew displays, Chapter 10)."],
       ["10", "Layers", "Shows the layer on the map; click it (or press L) for the eleven layers and four overlays."],
       ["11", "Right panel", "Route cards in Plan, alerts and the closed loop in Execute, validation in Review."],
       ["12", "The route", "The selected route in white, alternatives dashed, no-go areas hatched."],
       ["13", "Legend", "What the active layer means and the data it comes from (DERIVED, MODELLED or [ASSUME] tags)."],
       ["14", "Timeline", "Elevation, walk-home margin and sun angle along the route; a cursor follows the crew in Execute."]],
      [0.3 * inch, 1.3 * inch, CW - 1.6 * inch], bold_first=False)
H2("The menus")
table([["Menu", "Command", "What it does"],
       ["MarsNav", "Landing mode (hub site selection)", "Open Landing mode."],
       ["", "EVA planner (Jezero traverse planning)", "Open the EVA planner."],
       ["", "Jezero east demo site", "The planner on a site built from 20 m data only (Chapter 13)."],
       ["", "Add desktop and Start menu shortcuts", "What an installer would add, for this copy of MarsNav."],
       ["", "Quit", "Close MarsNav and stop everything it started."],
       ["View", "Reload page (F5) · Back · Full screen (F11)", "Window controls."],
       ["Data", "Local mode: download the data for offline use…", "Opens the Local mode panel (Chapter 7)."],
       ["", "Rebuild Jezero data from raw NASA / USGS sources…", "Re-runs the data pipeline in its own console window (Chapter 18)."],
       ["", "Full rebuild (also the Jezero 1 m DTMs)…", "The same, with three optional HiRISE elevation models."],
       ["", "Open the data folder · Open saved reports", "Explorer on data_cache and on saved dossiers."],
       ["Help", "User guide (PDF)", "Opens this guide."],
       ["", "Engine status", "Map engine health, memory, raster workers and free disk."],
       ["", "Open the log folder · About MarsNav", "Logs for troubleshooting; version and window engine."]],
      [0.75 * inch, 2.55 * inch, CW - 3.3 * inch])
H2("Windows, dialogs and files")
bullets(["<b>Extra windows.</b> The 3D drive window, the crew displays and printable dossiers open as further MarsNav "
         "windows. The drive window and the crew displays talk to the main window live, so you can walk the route in one, "
         "watch the visor in another and the planner react in the third.",
         "<b>Saving.</b> Every export (cue card, GeoJSON, dossier JSON) opens the normal Windows <b>Save As</b> dialog. "
         "Dossiers are also kept in <font name='Plex'>data_cache\\reports</font>.",
         "<b>Links</b> to NASA abstracts and data sources open in your web browser.",
         "<b>One copy at a time.</b> Starting MarsNav again brings the open window to the front.",
         "<b>It remembers</b> the window size, position and the page you were on, and whether the layer list is open.",
         "<b>Explanations on request.</b> Panels show values, not paragraphs: an <b>i</b> next to a section heading opens a "
         "short explanation of that section.",
         "<b>Closing</b> the window stops the map engine and every helper process. If a Local mode download is running, "
         "MarsNav asks first; downloads resume where they stopped."])
figrow([("d01_drive", (8, 38, 1742, 1067), "3D drive window"), ("l11_report", None, "Printable hub dossier")],
       "Further windows: the first-person drive window (left), whose movement becomes suit telemetry for the main window, "
       "and a hub-site dossier ready to print or save as PDF (right).")
H2("Behind the window")
P("The window is the visible part of a small, robust system. A supervisor starts the local map engine in its own process, "
  "checks it every five seconds on a private health port, and replaces it within seconds if it ever stops answering. Raster "
  "reads from NASA and USGS servers run in one to three worker processes, and long jobs (routes, hub builds, downloads) in "
  "their own processes, so a slow server can never freeze the app. Everything runs inside a Windows job object: closing "
  "MarsNav ends every process it started. The built-in self-test kills a worker and the server on purpose under load and "
  "checks that everything recovers (Chapter 16).")
architecture()
