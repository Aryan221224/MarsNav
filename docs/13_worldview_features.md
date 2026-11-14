# Worldview-style tools on Mars data

The 2026 challenge lists NASA Worldview among its resources. Worldview is an Earth-observation browser: every layer has a date, a time slider steps through the days, two dates or layers can be compared side by side, areas can be measured and summarised, the view can be animated and saved as a GIF, images download as GeoTIFF or KMZ, the whole state of the map travels in a link, and guided tours explain events. MarsNav now has the same tools, built on Mars data and used for the two questions the project answers: where to put a crewed base (Landing mode) and how to walk from it (the EVA planner).

## What was added, and what each piece answers

| Tool | Landing mode (globe) | EVA planner (site map) | What it answers |
|---|---|---|---|
| **Dust by season** | Dust overlay for any season (median or dusty year); "Dust in the air" in the place view; dust in area statistics | Dust optical depth from the climatology for the departure date (typical or dusty year) feeds the suit's solar heating; season chart of the year | How hazy is the sky here, in which season, and how bad does it get in a dusty year |
| **MARCI daily weather maps** | Base layer: the planet as MRO saw it on one sol of Mars years 28 to 32; season slider and Mars year; "Weather here in past years" in the dossier | (season chart and dust story) | What the weather actually looked like here at this season in past years, including the 2007 global dust storm |
| **Relay orbiter coverage** | "Earth relay coverage" in the place view and dossier | Relay passes drawn on the sol timeline; pass statistics in the season panel | How many minutes a sol a hub can talk to Earth through MRO, Odyssey, TGO and Mars Express, and at what local times |
| **Crustal magnetic field** | Science atlas overlay (geophysical); value in the place view; area statistics | | Where the ancient crust is strongly magnetised (context for space weather, not shielding) |
| **Season slider, animation, GIF** | Season (Ls) slider; Play steps sol by sol through a MARCI year or by 5° of Ls; GIF of 30 steps | Sol playback through the planned EVA at 30-minute steps; GIF | How a place changes through the year or through one EVA day |
| **Compare** | Swipe line or spy lens between the base map and a second map (another layer, or another Mars year of MARCI) | Swipe or spy between two overlays | What differs between two maps or two years at the same place |
| **Ruler with statistics** | Great-circle distance, area, climb along the line; "Area + statistics" of every global layer inside; statistics inside the landing ellipse | Distance, area and elevation profile on the site map; statistics of the site layers inside | How far, how big, and what the ground inside a shape is like |
| **Overlay strength and thresholds** | Overlay strength (10 to 100 %) | Overlay strength; "show only above" threshold for each layer | Seeing the base map under a layer; isolating the ground that crosses a limit |
| **Exports** | KML of the site, landing ellipse, zones, ice target, traverse and measurements (Google Earth, Mars view); GIF | GeoTIFF of the map in the site's projection; KMZ with the routes, stations and map overlay; GIF | Taking the plan into GIS tools and Google Earth |
| **Links with the full state** | The view, base map, overlays, selected place, season, Mars year, overlay strength and comparison | The site, plan settings, overlay, comparison and selected route | Sending exactly what is on screen to a colleague |
| **Data links** | "Get the data" in each legend | | Where each layer can be downloaded |
| **Stories** (the **Guide** button) | The 2007 global dust storm; choosing a hub with statistics; water ice and the magnetic field | Dust and the plan; comparing layers; a detour; sharing a plan | A guided walk through the tools on real data |

## Data sources

### Dust: Mars Climate Database dust scenarios, Mars years 24 to 36

- **Source.** Montabone L. et al. 2015, Icarus 251, 65-95 (doi:10.1016/j.icarus.2014.12.034) and 2020, JGR Planets 125, e2019JE006111 (doi:10.1029/2019JE006111); `www-mars.lmd.jussieu.fr/mars/dust_climatology/`; CC BY-SA 3.0. Gridded, kriged daily maps of the 9.3 µm absorption column dust optical depth (CDOD) normalised to 610 Pa, from TES, THEMIS, MCS and other instruments, on a 3° x 3° grid. 13 NetCDF files (`dustscenario_MY24_v2-0.nc` to `dustscenario_MY36_v2-5.nc`), each pinned by SHA-256 in `tools/build_dust.py`. The record starts at Ls ~103 of MY 24, when TES mapping began; the earlier part of the MY 24 file is filled in rather than observed and is not used.
- **Product.** `app/data/global/dust_cdod.bin.gz` (0.44 MB) and `dust_cdod.json`: the 10th, 50th and 90th percentile of every 10° Ls bin over all years on the 3° grid (198 to 273 sols per bin), and each year's own bin mean on a 6° grid. Values are stored as 8-bit square-root codes (tau = 9.5 (q/254)^2; 255 = no observation), deterministic gzip. `python tools/build_dust.py` rebuilds it; `--check` verifies the shipped files.
- **Use.** Visible optical depth at a place = 2.6 x CDOD x (local surface pressure / 610 Pa) (Montabone et al. 2015); the local pressure is 610 Pa x exp(-elevation / 11.1 km) from MOLA. The browser (`engine/dust.js`) and the server (`planet/dust.py`) use the same file and arithmetic; a test checks that they agree to 1e-9.
- **Global dust storms** in the record: MY 25 (2001), MY 28 (2007) and MY 34 (2018).

### MARCI daily global maps (MRO), version 1

- **Source.** Wang H. & Richardson M.I. 2015, Icarus 251, 112-127; Wang H. & Wheeler J., *MRO MARCI Mars Daily Global Maps V1*, Harvard Dataverse, doi:10.7910/DVN/G2VENZ, CC0. Images NASA/JPL-Caltech/MSSS. One colour mosaic of the whole planet per sol, at 0.1° (3600 x 1800), from the swaths MARCI takes around 3 pm local time. The maps are stretched to show dust storms, water-ice clouds and the polar hoods; they are not calibrated reflectance.
- **Index.** `planet/data/marci_v1_index.json` (60 kB) lists all 2,680 maps, from Ls 132 of MY 28 (November 2006) to Ls 110 of MY 32 (2014), with Mars year, Ls and coverage (the share of 60° S to 60° N with data), and for each of the 86 monthly archives its Dataverse file id, size and MD5. A date is resolved without downloading anything. Some sols lost orbits: 104 maps cover less than 60 %, 35 less than 20 % (the median map covers 93 %). The app shows the closest sol of the chosen year within 6° of the season, preferring one with at least 60 % coverage, and the animation steps only through well-covered sols. `python tools/build_marci_index.py --tars DIR` rebuilds the index from the archives.
- **Download on demand.** The first time a map of a month is shown, that month's archive (8 to 15 MB) is downloaded from Harvard Dataverse, checked against its MD5 and unpacked into `data_cache/planet/marci/`. Until it arrives the globe shows the Viking map dimmed, as a provisional tile that is never cached, and asks again when the month is there. If the app's internet check fails (the map servers do not answer) the MARCI server is asked directly before the download is refused; in Mars mode nothing is downloaded.

### Relay orbiters

- **Model.** `engine/relay.js` flies each orbiter from its published orbit (two-body Kepler orbit with the J2 drift of the node and periapsis; a sun-synchronous orbit keeps its node at a fixed local solar time) for 16 to 24 sols, several times with different orbit phases, and counts a pass while the orbiter is at least 10° above the site's horizon.
- **Orbits.** MRO 255 x 320 km, 93°, sun-synchronous with the ascending node at 3:00 pm LMST (PDS catalogue; JPL navigation). Odyssey ~400 km, 93.1°, sun-synchronous, node near 6 am / 6 pm since 2014 [ASSUME: still there]. TGO ~400 km, 74°, not sun-synchronous (ESA). Mars Express 330 x 10,530 km, 86.9°, 7.0 h (ESA). MAVEN is not counted (contact lost in December 2025).
- **Results** (24 sols x 3 runs, 10° mask):

| Latitude | MRO | Odyssey | TGO | Mars Express | All |
|---|---|---|---|---|---|
| Jezero, 18.4° N | 2.3 passes/sol, mean 7.5 min, max 9.5 min, 02:09-04:00 and 13:59-15:54 LMST | 3.0/sol, mean 9.1 min, 05:02-06:58 and 16:45-18:42 | 2.7/sol, mean 9.7 min | 2.4/sol, mean 128 min | 375 min/sol |
| Equator | 2.2/sol, 02:08-03:53 and 14:07-15:52 | 2.5/sol | 2.6/sol | 2.0/sol, mean 100 min | 262 min/sol |
| Arcadia, 46° N | 3.4/sol, 01:52-04:36 and 13:24-16:08 | 3.8/sol | 4.0/sol | 2.9/sol | 692 min/sol |
| 80° N | 13.1/sol, on most orbits | 12.5/sol, on most orbits | 7.2/sol | 3.5/sol | 1,004 min/sol |

These are properties of the orbits: rates, pass lengths and, for the sun-synchronous orbiters, local times. The exact times of the passes on a given sol need the spacecraft ephemerides and are not predicted.

### Crustal magnetic field (Mars Global Surveyor)

- **Source.** Connerney J.E.P. et al. 2001, Geophys. Res. Lett. 28, 4015-4018 (doi:10.1029/2001GL013619), NASA GSFC (`mgs-mager.gsfc.nasa.gov/publications/grl_28_connerney/`): the radial, north and east field components at 400 +/- 30 km altitude as night-side medians in 1° x 1° bins. Read from the ESRI grids prepared by USGS Astrogeology (`mars_magnetic_grids_meters.zip`, SHA-256 `265eb68850cccc2c…`). Public domain.
- **Product.** `app/data/global/magnetic_mgs.bin.gz` (231 kB): int16 at 0.1 nT, three planes. `tools/build_magnetic.py` checks the two values given in the data README (Br = 138.271 nT at 171.5° E 54.5° S, -7.367 nT at 200.5° E 45.5° N) before writing. The strongest field is 221 nT at 52.5° S 177.5° E (Terra Cimmeria / Terra Sirenum).
- **Meaning for crews** [ASSUME, qualitative]: strong crustal fields form local mini-magnetospheres that turn away part of the solar wind and low-energy particles; they do almost nothing against galactic cosmic rays. The layer is context, not shielding a mission can count on.

## How the tools work

**Season and animation.** Landing mode keeps one season (Ls) for every seasonal layer: the dust overlay is drawn for that season (rounded to 5°), and the MARCI base shows the map of the chosen Mars year closest to that season (within 6°, preferring a sol with at least 60 % coverage). Play steps through the sols of a MARCI year (1, 5 or 15 at a time, skipping sols that lost orbits), or through the season in 5, 10 or 30° steps; each step waits until its textures have arrived (and, for MARCI, until a month being downloaded is here), so a GIF never records half-loaded frames. The GIF is 640 px wide, 30 steps, with the date written under each frame. In the planner, the sol playback moves the sun, the shadows and the crew along the planned routes at 30-minute steps.

**Compare.** On the planner's 2D map the second layer is drawn clipped to one side of a draggable line (swipe) or to a lens around the cursor (spy). On the globe the second map is rendered in its own pass: each tile in view gets a second texture, the scene is drawn with those textures into a canvas laid over the globe, and that canvas is clipped by CSS to the right of the line or to a 130 px lens. Two Mars years of MARCI can be compared at the same season.

**Ruler and statistics.** Distances are great circles on the 3,396.19 km sphere; areas are spherical polygon areas (Chamberlain & Duquette 2007), exact for boxes bounded by meridians and parallels, and correct across 180°. The climb along a line is read from the best elevation in view. "Area + statistics" sends the shape to the server, which samples it on an equal-area lattice of about 1,500 points (never finer than the data) and returns the 10th, 50th and 90th percentile and maximum of every installed layer: elevation, km-scale slope, model surface pressure and cosmic-ray dose, TES thermal inertia and albedo, GRS water-equivalent hydrogen, SWIM ice consistency, dust (median and dusty year) at the season, the crustal field, and the craters of 1 km and larger inside. The dossier offers the same statistics for the landing ellipse.

**Exports.** The GeoTIFF is RGB in the site's own projection: equirectangular on the Mars 2000 sphere (R 3,396,190 m) with the site's standard parallel, deflate-compressed, all GeoKeys written (GDAL reads it as `+proj=eqc +lat_ts=<site> +R=3396190`). The KMZ holds `doc.kml` and the map image as a ground overlay; KML files carry `hint="target=mars"` so Google Earth opens them on Mars. Everything is written in the browser, with no library.

**Links.** The planner keeps its state in the address after the site name (`#jezero&p=<base64url JSON>`): stations, plan settings, the overlay with its strength and threshold, the comparison, the selected route, the view and any measurement. Landing mode adds a tenth field to its address (`ls=…;my=…;op=…;cmp=<map>~<swipe|spy>~<year>`). Opening the link restores the view exactly.

## Validation

- **Dust against measurements.** Bin means (10° Ls, 6° grid) at the rovers in the storm years: 3.0 at Meridiani in MY 28 (Opportunity measured 4.6 to 5 at the peak, Lemmon et al. 2015) and 7.4 at Gale in MY 34 (Curiosity measured about 8.5, Guzewich et al. 2019). The bins smooth peaks that lasted days, so they sit below the daily peaks and above half of them. Global means at the same season are about 7 and 8 times those of the year before in MY 25 and MY 34, and 3.7 times in MY 28.
- **Dust at Jezero** (visible, median year, at the local 771 Pa for -2,600 m), every 30° of Ls from 0: 0.58, 0.34, 0.28, 0.28, 0.35, 0.39, 0.53, 0.78, 1.12, 0.86, 0.60, 0.91; up to 4.0 in a dusty year (90th percentile).
- **Relay.** MRO's computed windows fall at 14:00-16:00 and 02:00-04:00 LMST, as its 3 pm ascending node requires; pass lengths of 7 to 10 minutes match a 300 km orbit with a 10° mask; the computed periods match the published ones (MRO 113 min, TGO 2 h, Mars Express 7 h).
- **Magnetic field.** The README check values are reproduced to within the 0.1 nT storage step.
- **Files.** The GeoTIFF is read back pixel-exact with its georeferencing; the KMZ unzips with every CRC correct; the GIF decodes back to its frames.
- **Tests.** `tests/worldview_features.test.mjs` (19 tests: dust, relay, measuring, GIF, GeoTIFF, ZIP, KML) and `tests/test_worldview.py` (14 tests: server dust and its agreement with the browser engine, the dust overlay and pressure, the magnetic check values, MARCI dates and tile geometry, the MARCI download and stand-in rules, layer order, area statistics, data links). Browser checks of both apps (every tool above, the stories, the links, and no page errors) are run with Playwright against the desktop server.

## Limitations

- The dust layer is a climatology of 13 Mars years, not a forecast: it says how dusty a season usually is and how bad a dusty year gets, not what next year will bring. The bins smooth short storm peaks (see Validation).
- The MARCI maps are stretched for seeing storms and clouds and are not calibrated. They cover MY 28 (from Ls 132) to MY 32 (to Ls 110); polar night and gaps between swaths show the dimmed Viking map. A month needs one download (8 to 15 MB) from Harvard Dataverse.
- Relay coverage is a statistical model of the orbits, not a pass schedule. Odyssey's local time is assumed, and the orbiters' remaining lifetimes and scheduling are not modelled.
- The magnetic field is measured at 400 km altitude; the surface field is stronger and finer, and the layer is context only.
- Area statistics sample the global layers at their own resolution (1/128° to 3°). For a landing ellipse a few kilometres across, the coarse layers give the same value at every point.
