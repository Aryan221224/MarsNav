# Data and provenance

Every input is real mission data. Each file has a canonical URL, a size and a SHA-256 in `pipeline/sources.json`, and `python pipeline/fetch_data.py --check` verifies all of them. The Jezero products are US Government works (NASA, USGS) in the public domain; the whole-planet sources below are public domain or openly licensed and are credited individually.

## Missions behind the map

| Mission | Instrument or product | Used for |
|---|---|---|
| Mars Reconnaissance Orbiter | HiRISE stereo DTMs (1 m) | Walking-scale slope, steps, roughness, sand bedforms, 2 m relief imagery |
| Mars Reconnaissance Orbiter | CTX DEM mosaic (20 m) and orthomosaic (5 m) | Regional elevation, horizons, basemap, CTX-only sites |
| Mars Global Surveyor | MOLA topography | Vertical datum of every DEM (products are tied to MOLA with a geoid correction) |
| Mars 2020 (Perseverance) | MEDA weather station | Temperature and pressure climatology, and the clock validation |
| Mars 2020 (Perseverance) | Localised traverse, with chassis tilt | Validation (elevation, slope, false no-go, route choice, bedforms); science targets and keep-outs |
| Mars Reconnaissance Orbiter | HiRISE orthomosaic (25 cm), read in place | Sub-metre terrain clutter (rocks, ripples) for the robotic scout's autonomy speed |
| Mars Science Laboratory (Curiosity) | RAD surface dose (0.64 mSv/day) | EVA dose estimate |
| Apollo 14, 15, 17 | Walking speeds and slope behaviour | Suited walking speed model |

## Whole-planet data (Landing mode and Local mode)

Landing mode streams the whole of Mars from a local tile server that builds each tile from the best data under it. Local mode downloads the same sources for offline use (Mars mode). Each source below is read from its canonical host; Local mode records the size of every pack it downloads.

| Zoom | Elevation | Imagery |
|---|---|---|
| Whole planet | MOLA MEGDR 16 px/deg (3.7 km) | Viking MDIM 2.1 colour, 232 m |
| Regional | MOLA MEGDR 128 px/deg (463 m); HRSC-MOLA blend 200 m | Viking colour, THEMIS infrared 100 m |
| Close | CTX stereo models, 20 m (44,628 on USGS STAC) | CTX global mosaic, 5 m |
| Closest | HiRISE stereo models, 1 m (1,262 on USGS STAC) | HiRISE, 0.25 to 1 m |

| Data | Mission or agency | Reference and host | Used for |
|---|---|---|---|
| MOLA MEGDR elevation | Mars Global Surveyor (NASA) | Smith et al. 2001; PDS Geosciences Node | Global elevation, landing elevation limit |
| HRSC-MOLA blended DEM, 200 m | Mars Express (ESA, with DLR and FU Berlin) and MGS | Fergason et al. 2018; USGS Astrogeology | Best global elevation; the 11 GB core of Local mode |
| CTX and HiRISE stereo models and orthoimages | Mars Reconnaissance Orbiter (NASA) | USGS Astrogeology STAC catalogue | Site building at 1 to 20 m, landing-ellipse slope |
| CTX global mosaic, 5 m | Mars Reconnaissance Orbiter (NASA) | Dickson et al. 2023, Caltech Murray Lab; served by Esri and ASU | Close imagery |
| Viking MDIM 2.1 colour mosaic | Viking orbiters (NASA) | USGS Astrogeology | Global colour base map |
| THEMIS day and night infrared mosaics, 100 m | Mars Odyssey (NASA) | Arizona State University | Rocky versus dusty ground, base map |
| TES thermal inertia | Mars Global Surveyor (NASA) | Putzig & Mellon 2007; PDS Geosciences Node | Dust cover and surface firmness |
| GRS water-equivalent hydrogen | Mars Odyssey (NASA) | Boynton et al. 2007; PDS | Near-surface water |
| SWIM subsurface water-ice consistency | NASA-funded SWIM project | Morgan et al. 2021, 2025; Planetary Science Institute | Ice at 0 to 1 m, 1 to 5 m and over 5 m depth |
| Crater database (384,343 craters of 1 km and larger) | Independent | Robbins & Hynek 2012, 2020 release | Crater density, landing hazards |
| Global geologic map, SIM 3292 | USGS | Tanaka et al. 2014; USGS OGC API | Geologic unit in the dossier |
| Candidate sites (48 Exploration Zones, 7 Starship, 11 heritage) | NASA, SpaceX study | NASA First Human Landing Site Workshop 2015; Golombek et al. 2021; NSSDCA; NASA Mars Trek | The 66 candidates and their criteria |
| Place names | IAU | Gazetteer of Planetary Nomenclature | Labels and search |
| Mars clock | NASA GISS | Mars24 algorithm | Sol, local solar time, season, sun position |

These whole-planet layers inform landing-site screening. They are not used in the Jezero validation, which relies only on the files listed below.

## Files

| File | Size | SHA-256 (first 16) | Source |
|---|---|---|---|
| `M20_JezeroCrater_CTXDEM_20m.tif` | 90.3 MB | `ba7f706ea1b5d63a` | USGS/JPL Mars 2020 Science Investigation maps: `planetarymaps.usgs.gov/mosaic/mars2020_trn/CTX/ScienceInvestigationMaps_JPL/` |
| `M20_JezeroCrater_CTXortho_mosaic_5m.tif` | 359.6 MB | `cd9f4b2154fdd43e` | same folder |
| `JEZ_ctx_B_soc_008_DTM_MOLAtopography_DeltaGeoid_20m_Eqc_latTs0_lon0.tif` | 9.7 MB | `16a1aa66c3f48c1b` | USGS Mars 2020 Terrain Relative Navigation (TRN) CTX DTM: `.../mars2020_trn/CTX/` |
| `DTM_MOLAtopography_DeltaGeoid_Jezero_C_Edited_affine_1m_Eqc_latTs0_lon0.tif` | 125.0 MB | `0c681fa0c2fa72ec` | USGS TRN HiRISE DTMs, DOI 10.5066/P9REJ9JN: `.../mars2020_trn/HiRISE/` |
| `..._Jezero_W_...` | 129.7 MB | `5a56ce872a8e4938` | same |
| `..._Jezero_CR_SOUTH_...` | 77.4 MB | `1b79324efae3a5a0` | same |
| `..._Jezero_CR_NORTH_...` | 72.0 MB | `f3f47409081e6466` | same |
| `..._Jezero_E_...`, `_N_`, `_DL_` (optional) | 132, 106, 115 MB | recorded on first download | same; used automatically when present |
| `m20_waypoints_enomis.json` | 100 kB | `6ffa13c5117e8bde` | NASA/JPL MMGIS feed `mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json`, sols 13 to 1980, via the snapshot in `github.com/enomis-dev/perseverance-traverse-3d` |
| `rover_points_stiles.geojson` | 383 kB | `52bc2d8a8fde3252` | Same NASA feed with geoid elevation and roll/pitch/yaw, collected hourly by `github.com/stiles/mars-perseverance-waypoints` |
| `meda_samples.json` | 2.0 MB | `7ef4353d5451aa43` | NASA PDS Atmospheres Node, `mars2020_meda` bundle (DOI 10.17189/1522849), sampled with `tools/meda_sampler.js` |

`planetarymaps.usgs.gov` redirects to the `asc-pds-services` S3 bucket; `fetch_data.py` tries both.

**Read in place, not downloaded.** The clutter layer (`app/data/clutter.bin.gz`) comes from the USGS/JPL Mars 2020 TRN product `JEZ_hirise_soc_007_orthoMosaic_25cm_Ortho_blend120.tif` (HiRISE, NASA/JPL/University of Arizona; 3.25 GB, tiled GeoTIFF, `asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/HiRISE/`). `pipeline/build_clutter.py` reads only the tiles over the operations area with HTTP range requests, so the file is not in `sources.json` and no checksum is recorded; the script's method is fixed in its header and its output is shipped.

**Why two GitHub mirrors.** The NASA traverse endpoint sends no CORS header and changes hourly, so a fixed snapshot is needed for a reproducible build. The two mirrors hold NASA's own records unchanged, and their SHA-256 values are fixed in `sources.json`. No code or method was taken from other projects. Where another project was examined, it used coarser data and simpler methods (see `submission/comparison.md`).

**Why a sampler for MEDA.** The MEDA bundle is tens of gigabytes. The sampler reads 48 evenly spaced rows per file with HTTP range requests, every 15th sol from 0 to 1,859. The result is 5,600 temperature and pressure samples and 5,616 sun-geometry samples from a 2 MB download. The procedure is in the script header, so anyone can repeat it.

## Stated accuracy of the inputs (from USGS metadata)

- HiRISE DTMs: horizontal co-registration better than 3 m at the 99th percentile (most under 1.1 m). The median vertical offset from the CTX DTM mosaic is about 0.4 m.
- Our own measurements over the Jezero operations area (`data_cache/work/jezero/terrain_report.json`):
  - HiRISE 10 m block means minus the CTX science DEM: −1.0 ± 3.8 m, 95 % within 7.8 m, over 1.49 million cells.
  - CTX science DEM minus the independent TRN CTX DTM: 0.09 ± 1.0 m, 95 % within 2.2 m, over 2.34 million cells.
  - HiRISE noise floors (10th percentile of RMS relief on gentle ground): 5 cm for C, 7.6 to 8.1 cm for W and the rim DTMs.

## Quality screens applied by the pipeline

| Screen | Jezero | Jezero east floor (CTX-only) |
|---|---|---|
| DEM blunders (spikes, pits, striping) | 0 cells | 12,536 cells (0.5 %), vetoed as "no reliable terrain data" |
| Mosaic seams | none | One 18 m seam repaired over 36,143 cells (1.5 %); routes crossing it are flagged |
| 1 m DTM noise floors | Removed per product, in quadrature | n/a |
| Crater-rim DTM striping (per USGS metadata) | Bedform evidence × 0.5 | n/a |

## Derived products shipped in the app

`app/data/<site>/manifest.json` lists every layer with its data type, scale, offset, unit, description, shape and size, plus the site description, projection, calibration, landmarks, targets, keep-outs and quality statistics. The science targets at Jezero are real rover positions from the NASA feed, taken at the sol of each publicly reported event (first cores at Rochette; Malay at Séítah; Mageik at Amalik on the delta front; Cheyava Falls, the potential biosignature; the rim crest). Each target in `pipeline/sites/jezero.json` lists its source and sol.
