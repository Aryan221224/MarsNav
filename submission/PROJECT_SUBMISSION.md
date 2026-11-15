# MarsNav: Space Apps 2026 project submission

The text for every field of the NASA Space Apps 2026 project form, ready to paste. Challenge: *Interplanetary Survival Guide: Martian Map*. Fields are in the order of the 2026 Project Submission Guide (13 November 2026). The demo is the 29.5-second video with English subtitles (the limit is 30 seconds).

---

## Project Name

MarsNav

## High-Level Project Summary

On Mars there is no GPS, help can be 22 light-minutes away, and a suit carries a fixed supply of oxygen, water and battery. MarsNav is crew mission software that answers the questions the first Mars crews will ask: where do we land and live, which way do we walk, and can we always get home?

Landing mode screens 66 candidate sites against NASA's human landing-site criteria on live NASA and USGS data, and turns the chosen site into a full EVA site. The EVA planner reads 1 m HiRISE terrain the way a boot meets it, applies hard safety limits before it optimises anything, and plans five named routes on which every step keeps a walk home. During the EVA it reads suit telemetry in NASA's SUITS format, learns how hard the crew is really working, and re-plans before the margin runs out. The same EVA appears on a habitat console, a helmet-visor display, a rover dashboard and a wrist cuff.

It is checked against Perseverance's own drives. In 40 simulated EVAs with hidden surprises, no MarsNav crew touched its emergency reserve (31 of 40 did on the fixed plan). It runs fully offline, as it must on Mars.

## Link to Project Demo

https://youtu.be/n4fgprexx3E (the 29.5-second demo video, English on-screen text and subtitles; plays without signing in)

## Link to Final Project

`https://github.com/Aryan221224/MarsNav` (repository: source, README, 86-page user guide, validation reports)
Download for Windows: `https://github.com/Aryan221224/MarsNav/releases/latest` (`MarsNav-Windows.zip`, unzip and double-click `MarsNav.exe`; nothing to install)
Try it in a browser: `https://aryan221224.github.io/MarsNav/` (the EVA planner, visor HUD and drive window on real Jezero terrain; Landing mode needs the desktop app)

## Detailed Project Description

### The problem

A Marswalk is a closed-loop survival problem. The crew cannot call Earth for help in real time, cannot use GPS, and carries consumables that decide how far they can go. The terrain hides the hazards that end missions: Spirit was lost in soft soil that looked firm from orbit, and Curiosity's wheels were torn by sharp rock. NASA's own rule for EVAs is the *walkback* rule: never go where the crew could not walk home with what is left. Today's maps show terrain; they do not keep that promise for every step, adapt it to how the crew is actually doing, or carry it from the choice of landing site to the last step of each EVA. MarsNav does.

### What it does

**Landing mode: where the crew lands and lives.** A 3D globe streams the whole planet, sharpening as you zoom in, from 3.7 km MOLA topography down to 1 m HiRISE elevation and 25 cm imagery where they exist. All 66 candidate sites (48 NASA Exploration Zones from the 2015 Human Landing Sites workshop, 7 SpaceX Starship candidates, 11 heritage landers) are screened in seconds against NASA's 2015 criteria, or the 2021 Starship study. Any point on Mars gets a dossier: engineering limits (latitude, elevation for atmospheric braking, slope), a Monte Carlo landing ellipse on lander-safe ground, terrain-relative-navigation coverage, water ice (SWIM), near-surface water (Mars Odyssey GRS), thermal inertia and dust (TES), craters, geology, radiation and sunlight. A safety map shows lander-safe ground; "commit the hub" builds a full EVA site at 1 to 20 m resolution from the best elevation data at that place.

**Plan: the evening before.** The crew picks stations and states the work at each (time, intensity, tool energy, extra oxygen or water) and the suit and rover checkout state (tank fills, battery health). MarsNav runs the hard limits first (walking slope, step height, cliffs with a position-error buffer, soft soil priced by its worst 10 % of outcomes, keep-outs, planetary-protection zones, daylight, and the walk home), then plans five named routes: balanced, safest, fastest, lowest consumption, and a fallback in a different corridor. Each shows time, distance, oxygen, water, battery, the worst walk-home margin, radiation dose and data confidence. The best set and order of stations is found exactly (Held-Karp). When no plan can work, it shows the point of no return and the resource that runs out, instead of just saying "infeasible". A 3D view walks the route at eye height against the real crater skyline.

**Execute: during the EVA.** Telemetry comes from a built-in simulator, a first-person drive window, or live from a NASA SUITS Telemetry Stream Server. A glance band shows mission time, walk-home time, position error and radio line of sight; consumable gauges show what is left, the same way as on the crew displays, with the walk-home need marked on each. A navigation filter tracks position with no GPS (dead reckoning, sun heading, landmark matching, beacon ranging) and draws its error ellipse. A caution-and-warning system follows NASA's display rules (latching alerts, acknowledge, one-press silence, two-step "Return now"). Operations controls (telemetry source, run, drop pin, return now, crew displays) are kept apart from the simulator and training controls (hidden truth, speed, fault injection), which fold away and switch off whenever real telemetry is the source. The closed loop learns the crew's real work rate, cooling-water use and battery drain from telemetry and re-plans the rest of the EVA from where the crew actually is; on a critical fault such as a suit leak, the plan becomes the walk-home route by itself.

**Review: after the EVA.** Planned against flown first, then the event log, the paper cue card crews carry as a fallback, routes as GeoJSON for NASA's MMGIS or QGIS, and the validation against Perseverance.

**Science atlas and objectives: what to study, and where.** Twenty-six more whole-planet layers, grouped by the kind of measurement the challenge lists: spectral (4,572 aqueous-mineral sites, 1,648 CRISM and OMEGA hydrous detections, 642 chloride deposits, TES plagioclase, pyroxene and sheet silicates), chemical (Mars Odyssey GRS iron, chlorine, potassium, thorium, silicon), thermal and surface (albedo, dust cover), topographic (MOLA roughness), geophysical (MRO GMM-3 gravity), atmospheric and radiation (air pressure, cosmic-ray dose scaled from Curiosity's RAD by the air overhead, sunlight), water and ice (glaciers, gullies, fans, valley networks) and present-day activity (recurring slope lineae, new and icy impacts). The dossier lists what is within 100 km and flags candidate Special Regions. Seven science objectives, after the MEPAG goals, turn on their layers with one press and rank every candidate site by the evidence near it. For ancient life they rank Columbus crater, Jezero, Mawrth Vallis and Nili Fossae first. A catalogue of 31 missions (Viking to ESCAPADE, MMX, Rosalind Franklin and Tianwen-3, with MAVEN's loss and Mars Sample Return's cancellation) says what each one gives the map and the crew.

**Science filter and research plans.** When the crew needs a particular material, the Candidates list keeps only the landing sites that have it nearby (clays, sulfates, silica, carbonates, chlorides, buried glacier ice, gullies, recurring slope lineae, river valleys, fans), within 25 to 200 km, with the nearest distance on each row. Each site's dossier turns the objectives with evidence nearby into a research plan: the question, the evidence and how far it is, what to do at the outcrop, why it needs people, a suggested field kit, the safety note, and the missions that did related research. In the planner, every stop lists the minerals and ice within 30 km and the research it serves.

**Space weather.** NASA's DONKI gives CME arrivals forecast at Mars, solar particle events and flares, with the Sun-Earth-Mars angle and an EVA advisory (quiet, watch, storm), cached for Mars mode. Route dose now follows the altitude of every step and the terrain around it: hills and walls that hide part of the sky cut the cosmic-ray dose (modelled with Curiosity RAD's measured angular spread and checked against RAD by the Murray Buttes), a map layer shows where the cover is, and in a solar particle event the warning gives the walk home first and says what the terrain can and cannot do.

**Crew displays.** The same EVA, live, on a helmet-visor HUD (heading tape, steering cue, walk-home margin, consumables, alerts; it can also overlay the first-person drive window), a rover dashboard (speed, slope ahead, power, route map) and a wrist cuff (the next stop with the rover's own photograph of it, the procedure checklist, acknowledge, pin and a two-step return). Every station at Jezero and Mount Sharp has the rover's raw Navcam and Mastcam frames from that spot: what the crew will see when they arrive.

**Everything at any place.** Click any point on Mars, on the globe or on a built site, and every layer appears at once, with no assessment to run:
- **Where:** chart quadrangle and names.
- **Time:** local solar time, sun, sunrise and sunset, season and Mars Year, live.
- **Survival:** air pressure, whether liquid water can exist and where it boils, air shielding, cosmic-ray dose, gravity and sunlight.
- **Ground:** thermal inertia, geologic unit, albedo, dust cover, roughness and craters.
- **Water and composition:** ice at three depths, the nearest ice, GRS hydrogen, TES minerals and GRS elements.
- **Science and context:** catalogued features and objective scores, missions nearby, and the best elevation data covering the point.

On a site the card adds the planner's own terrain model at that cell and the rover's photographs. The helmet visor, rover dashboard and wrist cuff show the same facts for the ground under the crew, and any place can be opened on them as a survey.

**The challenge's example: the Mount Sharp boxwork.** Built from five HiRISE 1 m models, with Curiosity's track to sol 5045 and its boxwork drill sites (Altadena, Monte Grande, Campo Marte) placed at the rover's own positions. MarsNav's answer is a real finding. Cliff-bounded buttes (every one at least 8 m high) and 39 % sand leave most of the foothills out of reach with dead-reckoning navigation, so the hub is a forward camp in a pressurised rover. From there a suited crew reaches Altadena in 1.3 h and Campo Marte in 3.4 h.

**Local mode and Mars mode: no Earth link.** Local mode measures and downloads the whole-planet datasets at native resolution and every high-resolution product around each site. Mars mode then refuses every internet request, counts what it refused, and keeps everything working from local copies. The EVA planner needs no internet at any time.

### How it works

- **Ground truth at walking scale.** A Python pipeline turns HiRISE 1 m and CTX 20 m elevation models into a 10 m operations grid (2.3 million cells at Jezero) with walking-scale statistics per cell: the slope a boot meets (90th percentile on a 4 m baseline), step height, roughness, and a detector for sand ripples and wind-blown ridges. It screens stereo blunders and repaired a real 18 m mosaic seam that had cut one site in two with a false cliff.
- **Safety first, then optimisation.** Eight hard vetoes are never traded against time. Only safe routes are then ranked over time, hazard exposure, consumables, recoverability and science value, with weights from pairwise judgements (AHP) whose consistency ratio is shown live.
- **The walk home inside the search.** A walkback field gives the true shortest safe return time and the oxygen, water and battery it costs from every cell. Any partial route from which the crew could not walk home is dropped during the search, so the guarantee holds at every step, not only at the turnaround.
- **Physiology and environment.** Metabolic power from walking speed and slope (calibrated on Apollo surface data), a suit heat balance with sun, shade and temperature, a Mars clock on NASA's Mars24 algorithm, horizon shadows in 16 directions, a temperature and pressure climatology fitted to Perseverance's MEDA weather station, and radiation dose from Curiosity's RAD.
- **Position error as a planning input.** Cliff and keep-out stand-offs grow where dead reckoning will have drifted; navigation-aid choices change the plan.
- **One engine everywhere.** The planning engine is plain JavaScript shared by the app, the tests and the validation, and runs offline in any modern browser engine, so it can move onto the computers a mission carries: a habitat station, a rover or a suit display. Today's host is a Python supervisor with health checks and automatic restarts, the planet engine reads MOLA, HRSC, CTX and HiRISE through GDAL in worker processes, and the interface is HTML, CSS and JavaScript in a native Windows window (Microsoft Edge WebView2). The display is informed by NASA-STD-3001 Vol. 2: dark low-glare ground, status colours reserved for status, every value with its unit, one status-marker style on every screen, latched alerts shown as cleared (not active) on every display until acknowledged, and dialogs, search and messages that behave the same way in both modules.

### Checked against Perseverance

| Check | Result |
|---|---|
| Mars clock vs Perseverance MEDA sun geometry | Solar zenith angle error 0.001 ± 0.086° over 5,616 samples on 117 sols (mean error 95 % CI −0.001 to 0.003°) |
| Terrain vs the rover | Walking-scale slope at or above the rover's measured chassis tilt at 74 % of 480 points (95 % CI 70–78 %; r = 0.72) |
| False no-go rate | 2 % of 703 real Perseverance positions (95 % CI 1–3 %; all cliff-edge stand-offs) |
| Hazard model vs JPL's route choices | On 30 detour drives the rover's real path scores lower hazard than the straight line on 21 of 30 (95 % CI 52–83 %) |
| Route geometry vs the rover's drives | **Not** better than a straight line (38 m vs 34 m mean offset). Reported as a negative result: drives are shaped by science stops and sub-metre hazards |
| Closed loop vs flying the filed plan | 40 paired EVAs with crews and hardware the planner was not told about: 0 of 40 dipped into the reserve (95 % CI 0–9 %), against 31 of 40 (62–89 %); Wilcoxon p < 0.001, exact sign test p = 9 × 10⁻¹⁰ |
| Terrain radiation shielding vs Curiosity RAD | By a Murray Butte that blocked 19 % of the sky, RAD measured about −4 % dose; MarsNav's formula gives −3 % to −10 % for that geometry (−6 % to −15 % without ground albedo, which overshoots). From orbit the stop is unresolved: 1 m terrain shows 5–16 % of the sky blocked within 24 m, so the map under-states shelter by cliffs (the conservative side) |
| Against NASA's TSS2027 telemetry server | Detected a battery and CO₂ drain beyond its 8× estimator limit (O₂ about 4×) and turned the EVA home within about 2 minutes |
| Reproducibility | A full rebuild from the raw USGS files gives byte-identical layers |

188 automated tests pass (102 engine, closed-loop, radiation-shielding, map-tool and headline-number; 86 pipeline, downloader, map-streaming, science-atlas, place, map-tool and headline-statistics), and the local server passes an end-to-end self-test under load, including a first run on an empty computer.

### Use-case evidence: the same trip as Perseverance

In 2022 Perseverance travelled from Issole in Séítah to the Amalik outcrop on the delta front, 2.5 km apart in a straight line. JPL drove around Séítah's rocks and sand: 7.1 km over 85 sols. MarsNav was given the same two points, and every route was measured on the same 1 m terrain layers:

| | Perseverance (actual) | MarsNav, robotic scout | MarsNav, suited crew |
|---|---|---|---|
| Distance | 7.15 km | 3.07 km | 2.92 km |
| Time | 85 sols, 44 with recorded drives | about 49 h of driving (modelled) | 1.4 h EVA from the habitat |
| Planning | multi-sol planning on Earth | under 1 s | about 1 s |
| Steepest slope | 20.5° | 13.5° | 12.8° |
| Ground over 15° | 42 m | 0 m | 0 m |
| Sand bedforms crossed | 256 m | 192 m | 103 m |
| Rocky ground crossed | 152 m | 110 m | 47 m |

Across all 45 validation drives, MarsNav's routes cross 47 % less mapped sand, 55 % less rocky ground and 39 % less ground steeper than 15° than the rover did, with a lower peak slope on 33 of 45. Its speed model, which slows a self-driving rover in clutter measured on 25 cm HiRISE images, reproduces the 79.7 m/h Perseverance averaged on this route (79 m/h). We report what it does not do: it rates Séítah 1.5 times slower per metre where JPL projected 4 times, so for a rover it still prefers the short corridor JPL rejected. For a crew, the same trip becomes one 1.4-hour EVA with the walk home kept at every step. Full report: `validation/ROVER_CASE_STUDY.md`.

### How it answers the challenge

| The challenge asks for | MarsNav |
|---|---|
| A layered, integrated view of a location or route | Twelve terrain layers (including radiation shielding) and four overlays at 10 m with routes, uncertainty and a timeline profile; the whole planet with six base maps and six science overlays |
| Data from multiple NASA science missions | MRO, MGS, Mars Odyssey, Mars 2020, MSL, Viking, Apollo, plus ESA's Mars Express (below) |
| Details of routes and destinations | Turn-by-turn guidance legs, station procedures, target provenance, the cue card, GeoJSON |
| Updates on current conditions | Live Mars clock, sun and shade along the route, dust, radio line of sight, position error, live suit telemetry with learned rates |
| Complete the mission quickly and safely | Five named routes under hard limits, walk-home margins everywhere, caution and warning, automatic return |
| Plan and carry out a successful Marswalk | Plan, Execute and Review, with a 3D rehearsal and a first-person drive window |
| New and exciting science along the way | Perseverance's real sample sites (Rochette, Séítah, Amalik, Cheyava Falls) and Curiosity's boxwork drill sites, a science-value optimiser, seven science objectives that rank every site, and catalogued minerals, ice and activity within 100 km |
| At least three kinds of data | Optical, thermal, spectral, topographic, geophysical, atmospheric, radiation and chemical layers for the whole planet |
| Space weather and radiation | NASA DONKI CME arrivals at Mars, particle events and flares with an EVA advisory; dose by altitude and terrain shielding on every route |
| Habitat display, tablet or helmet HUD | Habitat console, helmet-visor HUD, rover dashboard and wrist cuff, all live |
| Point-of-view images | The rover's own photographs from each station |
| The boxwork example at Mount Sharp | A full EVA site with Curiosity's track and drill sites |

### Benefits and who it helps

- **Crews and mission planners:** a plan that keeps the walk home for every step and adapts it to how the crew is really doing, not how the plan assumed.
- **Site-selection teams:** a first screen of any place on Mars against NASA's human landing criteria, with the data gaps stated (where HiRISE coverage is still needed).
- **Robotic missions today:** the robotic-scout profile plans Perseverance-class drives, and the hazard model agrees with JPL's choices.
- **Students and the public:** real Mars data, the real constraints of human exploration, and a guided two-minute tour.

### What is new

NASA's walkback rule made into an algorithm; soft ground priced by its tail risk (the way Spirit was lost); navigation error treated as a planning input; a closed loop with NASA's SUITS telemetry format that learns and re-plans; the same safety logic carried from choosing the landing site to the last step of each EVA; and all of it working with no Earth link.

### Honest limitations

Not flight software and not certified to NASA-STD-3001. Hazards smaller than the elevation data (rocks under about 1 m) are not seen. The default route weights are the team's documented judgements, since NASA has published none for Mars. The closed-loop campaign uses our simulator; the integration with NASA's real telemetry server is shown separately. The full list is in `docs/08_limitations.md`.

### What's next

Rock-abundance maps from HiRISE imagery, two-crew and rover-pair operations, the helmet display on its own device through the plan uplink, ESCAPADE's space-weather data at Mars when it arrives in 2027, and testing with analog-mission crews.

### Built with

Python (numpy, scipy, rasterio / GDAL, Pillow, pywebview, pythonnet, PyInstaller), JavaScript (ES modules, Web Workers, three.js), HTML and CSS, Node.js test runner, pytest. No special hardware: today it runs on any Windows 10 or 11 computer and the EVA planner runs in any modern browser; the same engine is built to run on habitat, rover and suit computers.

## Use of Super Intelligence (SI)

Yes. (The guide calls these tools Super Intelligence, SI; this answer is collected for data purposes and is not shown to the judges. The SI indicators judges can see are listed at the end.) We used AI tools the way a modern engineering team does: to move faster, while every design decision, method, result and claim stayed with the team.

- **Software development.** We used an AI coding assistant (Anthropic's Claude) to help write, refactor, test and debug code to our design. The team designed the system, chose the methods and data, set the safety rules, and reviewed and tested every change. The repository acknowledges the AI-assisted code in `docs/AI_USE.md`, linked from the README.
- **Documentation.** The assistant helped draft and edit the README, the technical documents, the user guide and this submission from our results; we checked every statement against the code and data.
- **Logo.** The MarsNav logo was created with an AI image generator (stated here, in the README, in `docs/AI_USE.md` and on the demo video's end card).
- **Demo video.** The AI assistant scripted the captures of the running app, the 3D device models and the edit; the music is synthesised by our own script (no samples, no AI audio); the video has no narration (the story is told in on-screen headlines, with English subtitles), and its end card states that the illustrations and logo were made with AI assistance.
- **Not AI-generated.** All data is real NASA, ESA and USGS mission data, downloaded from its source with recorded checksums. Every number in this submission comes from running our code on that data and can be reproduced with the scripts in `validation/`. Screenshots are captures of the running app. No AI-generated content uses NASA branding.
- **Where the SI indicators are.** Code and data: `docs/AI_USE.md` (linked from the README) and the AI co-author line in the commit history. Logo: identified as AI-generated in this text, the README and `docs/AI_USE.md`. Video: the end card says the illustrations and logo were made with AI assistance.

## NASA Data

| Data | Mission / source | How MarsNav uses it |
|---|---|---|
| HiRISE stereo elevation models (1 m) and orthoimages | Mars Reconnaissance Orbiter; USGS Mars 2020 Terrain Relative Navigation products | Walking-scale slope, step height, roughness, sand-bedform detection; 2 m relief imagery; landing-ellipse terrain where available |
| CTX elevation models (20 m), orthomosaics (5–6 m) and the CTX global mosaic | Mars Reconnaissance Orbiter | Regional elevation, horizons and shadows, basemaps, sites built from 20 m data only |
| MOLA topography (MEGDR, 463 m and 3.7 km) | Mars Global Surveyor, PDS Geosciences Node | Vertical datum of every elevation model; whole-planet elevation for Landing mode |
| TES thermal inertia | Mars Global Surveyor | Dust cover and surface firmness in the site dossier |
| GRS water-equivalent hydrogen | Mars Odyssey | Near-surface water for landing-site scoring |
| THEMIS day and night infrared mosaics (100 m) | Mars Odyssey | Rocky versus dusty ground; base map |
| MEDA weather station (temperature, pressure, sun geometry) | Mars 2020 Perseverance, PDS Atmospheres Node | Climatology for the suit heat model; validation of the Mars clock (5,616 samples) |
| Rover traverse, positions and chassis tilt | Mars 2020 Perseverance (NASA/JPL waypoint feed) | Validation of terrain, slope, false no-go rate, route choices and bedforms; real science targets and keep-outs |
| RAD surface radiation dose | Mars Science Laboratory Curiosity | EVA radiation dose on every route |
| Viking colour mosaic (MDIM 2.1) | Viking orbiters, via USGS | Global colour base map |
| SWIM subsurface water-ice consistency maps | NASA-funded Subsurface Water Ice Mapping project (Planetary Science Institute) | Water ice at 0–1 m, 1–5 m and >5 m depth for landing sites |
| Human Landing Sites / Exploration Zones | NASA First Human Landing Site Workshop (2015) | The 48 candidate zones and the screening criteria |
| SUITS Telemetry Stream Server (TSS) format | NASA SUITS challenge | Live suit and rover telemetry; tested against a TSS2027 build |
| Mars24 algorithm | NASA Goddard Institute for Space Studies | Mars clock: sol, local solar time, season, sun position |
| Apollo 14, 15 and 17 surface walking data | Apollo programme | Suited walking speed and slope model |
| NASA-STD-3001 Vol. 2 and SUITS crew-display requirements | NASA | Display, alerting and caution-and-warning design |
| CRISM and OMEGA hydrous minerals; aqueous-mineral compilation | MRO (with Mars Express OMEGA), via NASA Mars Trek | Spectral layers; science objectives; "science along the way" in the dossier |
| TES mineral abundances, albedo and dust cover index | Mars Global Surveyor (PDS, NASA Mars Trek) | Spectral and surface layers |
| GRS iron, chlorine, potassium, thorium, silicon | Mars Odyssey, PDS Geosciences Node | Chemical layers and dossier values |
| GMM-3 gravity field (spherical harmonics to degree 120) | MRO, MGS and Odyssey radio science, PDS | Geophysical layer (free-air anomaly) |
| Glaciers, gullies, fans, valley networks, dune fields, recurring slope lineae, new and icy impacts | MRO CTX / HiRISE, Mars Odyssey THEMIS surveys via NASA Mars Trek | Ice, activity, planetary protection and hazard layers |
| Rover traverses and raw images | Curiosity and Perseverance (NASA/JPL waypoint feeds and raw-image service) | Traverses on the globe; the Mount Sharp site; photographs at every station |
| DONKI space-weather database | NASA CCMC (api.nasa.gov) | CME arrivals at Mars, particle events, flares, EVA advisory |
| NASA Mars Trek, Planetary Data System | NASA | Data access and cross-checks |

Every file is downloaded from its canonical source with a recorded size and SHA-256 (`pipeline/sources.json`); `docs/04_data_and_provenance.md` lists each one.

## Space Agency Partner Data and Other References

**Space agency partner data**
- **ESA Mars Express HRSC** (with DLR and Freie Universität Berlin): the HRSC-MOLA blended elevation model at 200 m (Fergason et al. 2018, USGS) is the best global elevation in Landing mode and the 11 GB core of Local mode.

**Other data**
- USGS Astrogeology Science Center: global geologic map SIM 3292 (Tanaka et al. 2014), the STAC catalogue of HiRISE and CTX products, Mars 2020 science investigation maps.
- Robbins & Hynek (2012) Mars crater database: 384,343 craters of 1 km and larger.
- Caltech Murray Lab CTX global mosaic (Dickson et al. 2023), served by Esri and Arizona State University.
- Golombek et al. (2021), SpaceX Starship candidate landing sites.
- IAU Gazetteer of Planetary Nomenclature: place names.
- Putzig & Mellon (2007) thermal inertia; Boynton et al. (2007) GRS; Morgan et al. (2021, 2025) SWIM.

**Software and assets** (all open source, used under their licences)
- three.js (MIT), numpy, scipy, rasterio and GDAL, Pillow, pywebview, pythonnet, PyInstaller, Microsoft Edge WebView2 runtime.
- Fonts: Barlow, Barlow Condensed and IBM Plex Mono (SIL Open Font License).
- Screenshots, diagrams and the user guide were made by the team for this project; the logo was made with an AI image generator (see Use of Super Intelligence).

No code was copied from other projects; three ideas seen in other public entries were re-implemented independently and are credited in `submission/comparison.md`.

## Images for the project page

Upload from `submission/screens/` (each under 10 MB): `01_plan_routes.jpg`, `20_rover_case_study.jpg`, `13_landing_mode.jpg`, `14_landing_dossier.jpg`, `06_execute_station.jpg`, `04_3d_orbit.jpg`, `10_point_of_no_return.jpg`, `17_mars_mode.jpg`, `08_review_validation.jpg`.

## Tags

#Mars #EVA #Marswalk #HiRISE #Perseverance #JezeroCrater #LandingSites #Navigation #SUITS #ClosedLoop #Offline #OpenData
