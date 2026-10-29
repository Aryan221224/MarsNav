# Deployment and new sites

## Deploying the app

MarsNav ships as a portable Windows desktop app: `dist\MarsNav\` (or `MarsNav-Windows.zip`), about 280 MB, with nothing to install and no Python needed. `MarsNav.exe` runs the local map engine (Landing mode, Local mode, site building) and shows the app in its own window. The EVA planner itself is the `app/` folder: HTML, CSS, JavaScript modules and pre-built data, with no server-side code, so it can also be served on its own.

| Target | Steps |
|---|---|
| Laptop (demo, habitat workstation, judging) | Download `MarsNav-Windows.zip` (155 MB) from the [latest release](https://github.com/Aryan221224/MarsNav/releases/latest). Unzip it anywhere you can save files and double-click `MarsNav.exe`. For no internet at all: Data > Local mode, download, then switch on Mars mode. The zip is built and tested on a clean Windows machine by `.github/workflows/windows-exe.yml` on every push, with the same recipe as `build_exe.bat` (`tools/build_windows.py`). |
| EVA planner only, any OS | 1. `python3 -m http.server 8765 --directory app` 2. Open `http://localhost:8765` (Landing mode needs `MarsNav.exe` or `launcher/martian_map.py`) |
| Habitat local network | Serve `app/` from any static web server (nginx, Caddy, the habitat file server). Every tablet on the network gets the same plan data. |
| Crew tablet, out of radio range | Open the app once on the habitat network; the service worker caches the shell and each data file as it loads. Later visits work with no network. Bump `VERSION` in `app/sw.js` after a data update. |
| Public web (judging) | Any static host (GitHub Pages, Netlify, S3) or the published Artifact. Embedded viewers skip the service worker and the file-save button; the Copy button still works. |

Browser support: current Chrome, Edge and Firefox (ES modules, module workers, `DecompressionStream`). Memory: about 300 MB of typed arrays (400 MB process total, measured in Node) for the Jezero site with one crew profile loaded. Planning uses one core and takes about 3 s for five routes.

A site selector appears when more than one site is built. `#<site id>` in the address opens a site directly, for example `#jezero_east`.

## Adding a new site

The software is site-agnostic. Everything specific to a place is in one JSON file, `pipeline/sites/<id>.json`.

**Minimum:** one DEM covering the area (a CTX DEM at 20 m; a HRSC/MOLA blend works for a first look) and an operations area.

**Adds fidelity when present:** 1 m DTMs (HiRISE), an orthoimage, curated targets and keep-outs, a rover traverse, a local climatology.

```json
{
  "id": "my_site",
  "name": "My site, Mars",
  "short": "My site",
  "description": "One sentence for the provenance panel.",
  "projection": { "lat_ts": 18.4663, "name": "Jezero_Crater_Projection" },
  "snap_origin": [4329000.0, 1143420.0],
  "base": null,
  "ops_area": [77.70, 18.22, 78.00, 18.46],
  "regional_area": [77.00, 17.60, 78.57, 19.28],
  "clock": { "name": "M2020", "landing_utc": "2021-02-18T20:43:48Z", "lon_east": 77.45088572 },
  "sources": {
    "regional_dem": "M20_JezeroCrater_CTXDEM_20m.tif",
    "check_dem": null,
    "hires_dtms": [],
    "ortho": "M20_JezeroCrater_CTXortho_mosaic_5m.tif",
    "traverse": null,
    "climate": "from:jezero"
  },
  "calibration_from": "jezero",
  "out_dir": "sites/my_site",
  "targets": [],
  "keepouts": []
}
```

Field notes:

| Field | Meaning |
|---|---|
| `projection.lat_ts` | Standard parallel. Use the source DEM's own, or the site latitude, so cells stay square on the ground. |
| `snap_origin` | A corner of the source DEM, so its posts land exactly on grid cells |
| `base` | The habitat `{name, lon, lat}`. With `null`, the pipeline picks the gentlest open ground near the centre (lowest 300 m mean walking slope, at least 200 m from any cliff). |
| `hires_dtms` | Priority-ordered list of `{key, file, quality, optional}`. `quality` < 1 down-weights bedform evidence (for example, known striping). `optional` DTMs are used when present. |
| `climate` | `"meda"` fits the Jezero MEDA data. `"from:<site>"` reuses another site's fit; pressure is moved to the local elevation by the hydrostatic term. |
| `calibration_from` | Where to take the CTX-to-walking-slope calibration if this site has too little 1 m coverage |
| `clock` | The mission calendar: sol 0 is the landing sol at `lon_east`. A crewed mission would use its own landing time. |
| `targets` | `{id, name, kind, lon, lat, value, dwell_min, why, source}`. With none, the pipeline proposes up to five survey stations at the most distinctive landmarks 1 to 4 km from the habitat. |

Then build it:

1. Put the source files in `data_cache/raw/` (or add them to `pipeline/sources.json` and run `python3 pipeline/fetch_data.py`)
2. `python3 pipeline/build_terrain.py --site my_site`
3. `python3 pipeline/build_layers.py --site my_site`
4. `python3 pipeline/build_imagery.py --site my_site`
5. Open `http://localhost:8765/#my_site`

`build_layers.py` also rewrites `app/data/sites.json`, so the site appears in the selector.

## What changes at a site without 1 m data

The CTX-only test site (`jezero_east`) shows the degradation honestly:

- **Confidence.** Confidence is 0 everywhere and route cards say "on 20 m data only". The cue card warns that boulders and scarps under 20 m are not in the map.
- **Slope.** Walking slope comes from the conservative Jezero calibration.
- **Soft soil.** Bedforms cannot be detected at 20 m, so a weak sand prior is used and the slip uncertainty widens. Rover plans are therefore more cautious.
- **Data errors.** The DEM blunder screen and seam repair run automatically. At this site they found 0.5 % blunders and an 18 m mosaic seam that would otherwise have cut the area in two.

## Porting beyond the browser

The engine has no browser dependency (`engine/node_io.js` loads a site in Node). The same modules can run on a habitat server, in a rover computer's JavaScript runtime, or behind a small API for another display (for example, a head-mounted display or Open MCT). Planning is deterministic for the same inputs. The simulation takes a seed.
