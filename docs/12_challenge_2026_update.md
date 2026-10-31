# The 2026 challenge statement: gaps found and what was added

NASA published the full statement of *Interplanetary Survival Guide: Martian Map* for Space Apps 2026. This document compares it, line by line, with MarsNav as it stood (v2.0), and records what was added to close each gap, with the data behind it and what we could not verify.

## What the statement asks, and where MarsNav stood

| The statement asks for | MarsNav v2.0 | Gap | Now |
|---|---|---|---|
| A map, tool or interface a Mars astronaut could use, on NASA data | Landing mode + EVA planner on real NASA / USGS data | none | unchanged |
| Pick science goals and a location; the example is **boxwork at Mount Sharp, studied by Curiosity in 2025** | Jezero (Perseverance) only, with its sample sites | The example site and the goal-first workflow were missing | **Mount Sharp boxwork EVA site** from 5 HiRISE 1 m DTMs with Curiosity's track, drill sites and clock; **science objectives** that rank every candidate site |
| "At least three kinds of data: optical, thermal, spectral, topographic, geophysical, atmospheric, radiation, chemical" | Optical, thermal, topographic; GRS water and a single RAD number | No spectral (mineral), geophysical, atmospheric or radiation map; chemistry was water only | **Whole-Mars science atlas**: spectral (CRISM / OMEGA / TES minerals), chemical (GRS Fe, Cl, K, Th, Si), geophysical (MRO gravity), atmospheric (air pressure), radiation (cosmic-ray dose), plus ice, activity and missions |
| Data from multiple NASA science missions, past and future | MRO, MGS, Odyssey, Mars 2020, MSL, Viking, Apollo, Mars Express | No view of the missions themselves, nothing about the future | **Mission catalogue** of 31 missions (past, active, en route, planned, cancelled) as of 28 October 2026, each with what it contributes to MarsNav and to a crew |
| Space weather and the radiation environment | Constant RAD dose; "solar particle event" as a drill | No real space weather, dose not tied to place | **NASA DONKI space weather** (CME arrivals at Mars, particle events, flares) with an EVA advisory; **dose by altitude** from RAD on every route |
| Safety first; a route that avoids obstacles such as rock formations | Hard limits, walk-home guarantee, five routes | none | unchanged; the Mount Sharp site shows it on cliff-bounded buttes |
| Display: inside the habitat, a tablet, **a HUD on the helmet visor**, or another format | One habitat-style console; a first-person drive window | No visor HUD, no tablet, no rover dashboard | **Crew displays**: helmet-visor HUD, rover dashboard and wrist cuff, live from the planner; the visor also overlays the drive window |
| Point-of-view images so the astronaut knows what to expect | None | missing | **The rover's own photographs** from each station (Perseverance and Curiosity raw images), in the planner, the station panel and the cuff |
| Know the place: what the data say about the location the crew picks | A dossier after "Assess" (landing criteria); the readout on a site | Only a slow assessment, and only for landing | **Everything at any place**: one click anywhere on Mars, or on a built site, shows every layer at once. The crew displays show it for the ground under the crew. |
| Rovers carrying crew, or astronauts in pairs | Unpressurised rover, rescue-rover rule, EV1 / EV2 telemetry | Partly | The forward-camp hub (pressurised rover) at Mount Sharp; the cuff and visor for each crew member |
| Inspiration from other worlds' maps | Lunar slope limit, Apollo walking data | none | unchanged |

## The science atlas

All layers are drawn by the planet server onto the globe's tiles (`planet/imagery.py`), have a legend with the citation (`/api/legend`), are grouped by the kind of measurement in the Landing-mode layer list (`/api/atlas`), and are kept by Local mode for Mars mode.

| Kind | Layer | Source | How it gets to the app |
|---|---|---|---|
| Spectral | Aqueous minerals: 4,572 sites of clays, sulfates, silica, chlorides, carbonates | Ehlmann & Edwards 2014 (CRISM, OMEGA, THEMIS), NASA Mars Trek | bundled (`planet/data/features.json.gz`) |
| Spectral | Hydrous mineral detections: 1,648 (CRISM 1,208, OMEGA 440) | Carter et al. 2013, JGR Planets 118, 831 | bundled |
| Spectral | Chloride salt deposits: 642 outlines | Osterloo et al. 2010, JGR 115, E10012 | bundled |
| Spectral | Plagioclase, high-Ca pyroxene, sheet silicates / high-Si glass | Bandfield 2002 (TES), NASA Mars Trek tiles | streamed, Local mode pack "atlas" |
| Chemical | Iron, chlorine, potassium, thorium, silicon (5° cells) | Boynton et al. 2007 (Mars Odyssey GRS), PDS | "Install science layers" (1 MB) |
| Thermal / surface | Albedo (8 px/deg); dust cover index (16 px/deg) | Christensen et al. 2001 (TES, PDS); Ruff & Christensen 2002 (Trek) | installed / streamed |
| Geophysical | Free-air gravity anomaly, degree 120 | Genova et al. 2016 (MRO GMM-3, PDS); summed in `datasets.gravity_grid` | installed (0.9 MB) |
| Topographic | Kilometre-scale roughness at 0.6 / 2.4 / 9.2 km | Kreslavsky & Head 2000 (MOLA), Trek | streamed |
| Atmospheric | Mean surface air pressure | MOLA elevation, 610 Pa datum, 11.1 km scale height | model, no download |
| Radiation | Galactic cosmic-ray dose rate at the surface | Curiosity RAD at Gale (Hassler et al. 2014) moved by the measured dose-pressure slope (Guo et al., doi:10.1002/2016JE005206) | model, no download |
| Power | Daily-mean sunlight over a Mars year | Kepler orbit, obliquity 25.19°, dust τ 0.5 | model, no download |
| Water and ice | Glacier-like forms (1,309), receding GLFs (436), glacial valleys (102), gullies (4,978), alluvial fans (44), valley networks | Souness et al. 2012; Brough et al. 2016; Fassett et al. 2010; Harrison et al. 2015; Moore & Howard 2005, Kraal et al. 2008; Hynek et al. 2010 | bundled |
| Activity / planetary protection | New impacts (365), recurring slope lineae (60), active and dune gullies (61), icy impact sites (22) | Daubar et al. 2013; McEwen et al. 2014, Ojha et al. 2014; Dundas et al. 2014, 2015 | bundled |
| Hazard | Dune fields (547 outlines) | Hayward et al. 2007, USGS OFR 2007-1158 | bundled |
| Missions | Spirit, Opportunity, Curiosity (to sol 5045) and Perseverance (to sol 2022) traverses; every lander and named stop | NASA/JPL waypoint feeds; NASA Mars Trek | bundled |
| Base map | HRSC + MOLA colour relief, 200 m | ESA Mars Express / NASA MGS, USGS, Trek | streamed (optional Local mode pack) |

`tools/build_features.py` rebuilds the bundled catalogues from Mars Trek's map services and the rover feeds (about 2 minutes); the counts above are checked by `tests/test_science.py`. The site dossier now lists the features within 100 km ("Science along the way"), the GRS chemistry, albedo, gravity and the model dose at the point, scores the place for every science objective, and flags recurring slope lineae (candidate COSPAR Special Regions) within 300 km.

Checks of the new layers against known places: the gravity map gives +2,831 mGal over Olympus Mons and +2,413 over Ascraeus Mons, and positive mascons under Isidis (+322) and Utopia (+107); the summation is tested against analytic zonal and sectoral terms. TES plagioclase peaks over Syrtis Major, as Bandfield describes. GRS chlorine is highest at Medusae Fossae (0.66 wt %). The dose model returns exactly 210 µGy/day and 0.64 mSv/day at Bradbury Landing, and agrees with the JavaScript engine to machine precision.

## Science objectives and missions

`planet/data/objectives.json` holds seven objectives after the MEPAG goals: ancient life in lakes and deltas; groundwater and the boxwork of Mount Sharp; water ice; present-day activity and Special Regions; volcanoes, crust and interior; climate history; and a place to live. Each lists the layers that show it (one button turns them on), the catalogued features that count as evidence, real example places (IAU gazetteer centres or rover positions), what to do at a station and what to watch for. "Rank sites for it" scores every candidate and hub: weight × log2(1 + features of each kind within 100 km), plus installed-layer terms (ice consistency, GRS water, gravity, dose, sunlight, dust). For ancient life it ranks Columbus crater, Jezero, Mawrth Vallis and Nili Fossae first, all prime aqueous sites in the literature.

`planet/data/missions.json` lists 31 missions with their status on 28 October 2026 and a source for every time-sensitive status. Among them: MAVEN lost (contact ended 6 December 2025, mission ended mid-2026); ESCAPADE launched on New Glenn on 13 November 2025, waiting near L2 to leave for Mars, arrival autumn 2027; MMX launched on H3 on 20 October 2026; the Mars Telecommunications Orbiter awarded to Blue Origin on 1 September 2026 for operations by 2030; Rosalind Franklin to launch in 2028 for Oxia Planum; Tianwen-3 sample return (candidate regions in Utopia, Chryse and Amazonis); Mars Sample Return unfunded in the FY2026 budget; and SpaceX's uncrewed Starship flights moved past the 2026 window. Future landing regions are markers on the globe.

## Space weather and radiation on the route

`planet/spaceweather.py` reads NASA's DONKI (WSA-ENLIL CME arrival forecasts, which list Mars among the bodies hit; CMEs; solar energetic particle events; flares) through api.nasa.gov (NASA's `DEMO_KEY` or a key in `MM_NASA_API_KEY`), falling back to the CCMC server. It keeps the last answer on disk, so Mars mode shows it with its age. It also computes the Sun-Earth-Mars angle (JPL elements, the same as the engine's Earth-delay clock), because DONKI watches the Sun from the Earth side. The advisory rule is stated on screen:

- **Storm:** a particle event within 48 h while Mars is within 60° of Earth, or a CME forecast to hit Mars within 24 h.
- **Watch:** a forecast arrival within 72 h, a particle event with uncertain connection to Mars, or an X flare within 24 h.

Landing mode shows the details (SPACE WX); the planner shows the level in its clock bar and on the route cards.

Route dose now integrates the cosmic-ray dose rate at each step's own elevation (`engine/sitecheck.js: gcrDoseRate, routeDoseMSv`). At Jezero, 2 km higher than Gale, the Amalik EVA comes to 0.113 mSv instead of 0.105 mSv at the old single RAD value.

## The Mount Sharp boxwork site

Built with MarsNav's own site generator (`planet/sitegen.py`) at 4.811°S, 137.384°E, over 10 km. The generator now ranks CTX DTMs by their overlap with the operations area. In its first build here, 16 DTMs sharing one stereo image left the operations area on 463 m MOLA; now CTX covers 72 % of the regional area, and HiRISE disagrees with the regional model by 15 m instead of 36 m. Five HiRISE 1 m DTMs cover 94 % of the operations area. `tools/add_rover_context.py` added:

- Curiosity's track to sol 5045 from the NASA/JPL feed;
- the boxwork drill sites as stations, at the rover's own localisation on the sols NASA's mission blog reports: Altadena (sol 4560), the Monte Grande hollow with Valle de la Luna and Nevado Sajama (sol 4711), Campo Marte beside the Atacama block (sol 4893);
- a 50 m keep-out around the active rover, and the MSL mission clock. The clock agrees with NASA's labels: an image taken on 2026-10-11 at 23:37 UTC is sol 5041.

What the planner found is a real result about this terrain. The foothills are cut by buttes and scarps: every steep patch flagged as a cliff is at least 8 m high, with a median of 24 m. Mean walking slope is 18.7°, and 39 % of the area is sand. With dead-reckoning-class navigation (position error up to 80 m), the cliff stand-offs leave only 17 % of the site reachable from the generator's habitat, and none of the drill sites. An orbital navigation constellation (about 8 m) opens 54 %. So the hub is a forward camp: a pressurised rover at Curiosity's sol-4530 stop, since no lander should come down on these foothills. From there a suited crew reaches Altadena (0.59 km, 1.3 h, 76 % margin) and Campo Marte (2.46 km, 3.4 h, 37 %). Monte Grande stays refused: the hollow is ringed by ridge walls the 10 m map treats as cliffs. The unpressurised-rover profile is refused everywhere here, because the ground is past its slope limits.

## Everything at any place

Click any point, anywhere on the globe or on a built EVA site, and every layer MarsNav holds about it appears at once, without running an assessment. `planet/place.py` gathers it (`GET /api/place?lon=&lat=`) and `app/js/placeview.js` draws it, the same way in Landing mode, in the planner's place card and on the crew displays.

| Section | What it holds | From |
|---|---|---|
| Where | Position (east and west longitude), USGS 1:5M chart quadrangle (MC-01 to MC-30), named features, the built site it lies in | IAU Gazetteer, USGS charts, `app/data/sites.json` |
| Time here now | Local true and mean solar time, sun elevation and direction, sunrise and sunset, daylight length, noon sun, season in each hemisphere, Ls and Mars Year, dust-storm season, sunlight above the air, Earth distance and radio delay. Computed live in the browser. | Mars24 (Allison & McEwen 2000), JPL Keplerian elements |
| Survival here | Mean air pressure, whether pure liquid water can exist and where it boils, air shielding, cosmic-ray dose (per day and over a 500-sol stay), surface gravity, sunlight above the air and at the ground, space weather now | MOLA, RAD (Hassler 2014; Guo 2017), Mars GM, J2 and spin (Konopliv 2016), MRO GMM-3, NASA DONKI |
| Ground | Thermal inertia and its class, geologic unit, albedo, dust cover, roughness at 0.6, 2.4 and 9.2 km, the crater it is in, crater counts within 10 and 100 km | TES (Putzig & Mellon 2007; Ruff & Christensen 2002), MOLA (Kreslavsky & Head 2000), USGS SIM 3292, Robbins & Hynek |
| Water and ice | SWIM ice consistency at 0-1 m, 1-5 m and below 5 m; the nearest ice-consistent ground and its share of the 100 km around; GRS hydrogen | SWIM (Morgan et al.), Mars Odyssey GRS |
| Composition | Plagioclase, pyroxene and glass / clay (TES); iron, chlorine, potassium, thorium, silicon (GRS); hydrous and aqueous mineral detections nearby | Bandfield 2002, Boynton 2007, Carter 2013, Ehlmann & Edwards 2014 |
| Science here | Catalogued features within 100 km with the nearest of each; Special Region warning; the seven objectives scored at the point | `planet/features.py`, `planet/science.py` |
| Missions and sites nearby | Landed and targeted missions by distance and direction, NASA Exploration Zones, Starship candidates | `planet/data/missions.json`, `candidates.json` |
| Best data here | HiRISE 1 m and CTX 20 m elevation models whose footprint covers the point, and the finest resolution a hub built here would get | USGS STAC catalogue |

Everything comes from data on the computer, or its caches, in well under a second. The two remote lookups run in parallel with a 4 s budget: the geologic unit (USGS OGC API) and the Trek colour maps. A lookup still running is marked pending and the app asks again. Landing mode keeps its quick screen and "Assess landing site" for the landing ellipse; the place data sit below it and stay when the dossier arrives.

**How the colour maps are read.** The TES mineral and dust-cover maps are published as rainbow images (purple, blue, green, yellow, red from low to high) under a hillshade. Hillshade changes brightness but not hue, so the hue of the 3 × 3 pixels at the point gives its position on the scale, 0 to 1. It is shown as very low to very high, never as a percentage. Roughness is an RGB composite, one channel per baseline. Checked on known places: Syrtis Major reads very high for plagioclase and pyroxene; Arabia Terra, Tharsis and Olympus Mons read high for dust; Meridiani reads smooth; Acidalia reads high for glass / clay; Hellas has no TES data, as published.

**On a built site** the planner's place card adds that site's own terrain model at the cell: elevation, terrain class, walking slope, step height, sand, wheel-slip risk, nearest cliff, hazard index, the no-go reason, position error, radio line of sight to the habitat, walk-home time, and whether HiRISE 1 m or CTX 20 m data back it. It also shows the distance and direction from the habitat, the rover's photographs when a station is within 150 m, and buttons to add the point as a station or open it on the crew displays.

The Mars Year shown anywhere in the app was wrong (63 instead of 39): `marsYear()` started MY 1 at the wrong sol. It now starts at MSD 28892.7 (11 April 1955), and a test checks the published starts of MY 36 to 39.

## Crew displays

`app/hud.html` shows the EVA the planner is flying (simulator, live SUITS telemetry or the drive window) on three displays. It receives the plan and every snapshot over a BroadcastChannel, and sends the cuff's commands back.

- **Helmet visor.** Black is see-through on a real visor and the centre of view stays clear. It shows a heading tape with the next stop, home and the sun; a steering cue with distance, bearing and ETA; consumables with the walk-home need marked; walk-home time and margin; MET, position error, comm, sun and sunset, and dose; the top alert with its action; the station step; and a mini map. Heading comes from the track, because SUITS telemetry has no compass. Behind it runs the site's terrain in 3D from the crew's eyes (`view3d.js` in its crew mode: 1.8 m standing, 2.25 m in the rover), following the crew's position and heading, with the route painted on the ground, a re-plan in cyan, the return in red and the stops as poles; drag looks around (the tape and steering cue turn with the view), C looks ahead and V gives the plain visor. A survey shows the place in 3D when it is inside a built site. Press H in the drive window to wear the visor over that window's own first-person view.
- **Rover dashboard.** Speed gauge, heading, slope ahead, cross-track error, position error and radio. A north-up map shows the filed, re-planned or return route with the track. It also shows rover power, crew suit status and alerts, and along the bottom the next stop, walk home, worst margin, sunset and MET.
- **Wrist cuff.** Large targets for gloves: the top alert, O₂, walk home and margin; the next stop with the rover's photograph of it; the procedure checklist; acknowledge, silence, drop pin and a two-step return that act on the planner's loop; consumables; and the cue card.
- **The place under the crew, on all three.** The planner sends every layer at the crew's position, fetched again after 400 m or 10 minutes, and the site's terrain cell once a second.
  - **Visor:** a short "here" list at the bottom left: air, dose rate, gravity, water's boiling point, ground, dust, ice, geologic unit.
  - **Dashboard:** the site's slope, sand, slip and cliff distance next to them, and a "Data here" tab with every layer.
  - **Cuff:** the facts as tiles, the local time line, the nearest catalogued features, and every layer folded.
- **Maps on real terrain.** The planner sends the site's orbital image, its HiRISE detail tiles and the no-go areas.
  - **Dashboard:** draws them under the route, the re-plan, the track, the stations and the crew, with a Route / Whole site switch. Zoomed in past the 5 m image, it uses the HiRISE tiles.
  - **Cuff:** has the same map.
  - **Visor:** its mini map stays lines only, because black is see-through on a real visor.
- **Survey of any place.** `hud.html?lon=&lat=&name=` opens the three displays for a place with no EVA. They are opened from Landing mode ("HUD") or the planner's place card ("Crew displays"). The visor shows local time, sun, time to sunset, season, elevation and Earth delay. The dashboard and visor map the catalogued features and names within 50 km, with range rings and the sun's direction.

Checked in a headless browser on the real app. The visor followed a simulated Jezero EVA, switched to RETURN with the warning and its action when a suit leak was injected, and the cuff's acknowledge cleared the three open alerts in the planner. No console errors. Also checked:
- a place clicked at Jezero and at Gale in Landing mode, with its survey on all three displays;
- a point clicked on the Mount Sharp site;
- a simulated Mount Sharp EVA with the place data on the visor, the dashboard (both tabs) and the cuff.

## Photographs from the ground

`tools/build_pov.py` finds, for each station, the rover's localisations within 60 m and takes that rover's raw images from those spots (NASA raw-image service). Perseverance images carry the rover's site and drive index, so only frames taken at that exact localisation are used. Curiosity's do not, so only sols when it stood there all day are used.

It keeps Navcam and Mastcam / Mastcam-Z frames of the ground and horizon. Sun images (neutral-density filters), sky frames, deck shots, near-duplicates within 5 minutes and frames that are mostly black or featureless are rejected. The result: 4 photos at each of the 8 Jezero stations (3.3 MB) and 2 at each of the 3 Mount Sharp drill sites (1.1 MB). Every photo carries sol, local time, pointing, distance and credit, and links to NASA's full-resolution original.

## What we could not verify here

- **DONKI live.** NASA's demo key was rate-limited on the shared development network and the CCMC host dropped connections. The space-weather parser is tested on DONKI's documented record shapes, not on a live response. On a crew or user computer both routes are normally open.
- **Mission status** comes from NASA, ESA, JAXA and press reports through web search on 28 October 2026; Wikipedia could not be read (rate-limited). Statuses that change (en route, planned, cancelled) cite a source in the file.
- **TES mineral maps** are Trek's published colour maps without a numeric scale. Their legends say "low → high", with the published value ranges in the note. At a point, the value is read back from the colour as a position on that scale (very low to very high), not as an abundance.
- **Crustal magnetic field** is not included: no openly licensed global grid could be found (the Langlais et al. 2019 model is distributed on request).
- **The dose model** is RAD's measured slope near 700-950 Pa. Far outside it (high volcanoes, the deepest basins) values are flagged as extrapolations, and solar particle events are not in the map.
- **The user guide PDF** (`MarsNav_User_Guide.pdf`) describes 2.1, with Chapters 5 (everything at any place), 6 (science atlas, objectives, missions, space weather) and 10 (crew displays). Its new figures were taken in a browser on the running app (`tools/guide/capture_guide21.cjs`), without the desktop window frame.
