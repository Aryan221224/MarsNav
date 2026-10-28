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

## Crew displays

`app/hud.html` shows the EVA the planner is flying (simulator, live SUITS telemetry or the drive window) on three displays. It receives the plan and every snapshot over a BroadcastChannel, and sends the cuff's commands back.

- **Helmet visor.** Black is see-through on a real visor and the centre of view stays clear. It shows a heading tape with the next stop, home and the sun; a steering cue with distance, bearing and ETA; consumables with the walk-home need marked; walk-home time and margin; MET, position error, comm, sun and sunset, and dose; the top alert with its action; the station step; and a mini map. Heading comes from the track, because SUITS telemetry has no compass. Press H in the drive window to wear it over the first-person view.
- **Rover dashboard.** Speed gauge, heading, slope ahead, cross-track error, position error and radio. A north-up map shows the filed, re-planned or return route with the track. It also shows rover power, crew suit status and alerts, and along the bottom the next stop, walk home, worst margin, sunset and MET.
- **Wrist cuff.** Large targets for gloves: the top alert, O₂, walk home and margin; the next stop with the rover's photograph of it; the procedure checklist; acknowledge, silence, drop pin and a two-step return that act on the planner's loop; consumables; and the cue card.

Checked in a headless browser on the real app. The visor followed a simulated Jezero EVA, switched to RETURN with the warning and its action when a suit leak was injected, and the cuff's acknowledge cleared the three open alerts in the planner. No console errors.

## Photographs from the ground

`tools/build_pov.py` finds, for each station, the rover's localisations within 60 m and takes that rover's raw images from those spots (NASA raw-image service). Perseverance images carry the rover's site and drive index, so only frames taken at that exact localisation are used. Curiosity's do not, so only sols when it stood there all day are used.

It keeps Navcam and Mastcam / Mastcam-Z frames of the ground and horizon. Sun images (neutral-density filters), sky frames, deck shots, near-duplicates within 5 minutes and frames that are mostly black or featureless are rejected. The result: 4 photos at each of the 8 Jezero stations (3.3 MB) and 2 at each of the 3 Mount Sharp drill sites (1.1 MB). Every photo carries sol, local time, pointing, distance and credit, and links to NASA's full-resolution original.

## What we could not verify here

- **DONKI live.** NASA's demo key was rate-limited on the shared development network and the CCMC host dropped connections. The space-weather parser is tested on DONKI's documented record shapes, not on a live response. On a crew or user computer both routes are normally open.
- **Mission status** comes from NASA, ESA, JAXA and press reports through web search on 28 October 2026; Wikipedia could not be read (rate-limited). Statuses that change (en route, planned, cancelled) cite a source in the file.
- **TES mineral maps** are Trek's published colour maps without a numeric scale, so their legends say "low → high" with the published value ranges in the note; values at a point are not read from them.
- **Crustal magnetic field** is not included: no openly licensed global grid could be found (the Langlais et al. 2019 model is distributed on request).
- **The dose model** is RAD's measured slope near 700-950 Pa. Far outside it (high volcanoes, the deepest basins) values are flagged as extrapolations, and solar particle events are not in the map.
- **The user guide PDF** (`MarsNav_User_Guide.pdf`) describes v2.0. The screens added here are documented in this file and the README.
