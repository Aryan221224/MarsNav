"""Check, from this computer, which NASA / USGS Mars data services answer, and keep small samples of each for inspection.
Writes data_cache/probe/report.txt (+ sample files). Run: probe_sources.bat"""
from __future__ import annotations

import json
import ssl
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data_cache" / "probe"
OUT.mkdir(parents=True, exist_ok=True)
try:
    import certifi
    CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:  # noqa: BLE001
    CTX = ssl.create_default_context()
UA = "MarsNav/2.0 (NASA Space Apps Challenge 2026 EVA planner; data-source check)"

# Jezero: z8 tile row 101 col 366 (0.703125 deg tiles), z5 row 12 col 45
PROBES = [
    ("esri_ctx1_info", "https://astro.arcgis.com/arcgis/rest/services/OnMars/CTX1/MapServer?f=json", None, "json"),
    ("esri_ctx1_tile", "https://astro.arcgis.com/arcgis/rest/services/OnMars/CTX1/MapServer/tile/8/101/366", None, "img"),
    ("esri_ctx1_tile_z11", "https://astro.arcgis.com/arcgis/rest/services/OnMars/CTX1/MapServer/tile/11/814/2929", None, "img"),
    ("esri_ctx_tile", "https://astro.arcgis.com/arcgis/rest/services/OnMars/CTX/MapServer/tile/8/101/366", None, "img"),
    ("esri_hirise_info", "https://astro.arcgis.com/arcgis/rest/services/OnMars/HiRISE/MapServer?f=json", None, "json"),
    ("trek_themis_day", "https://trek.nasa.gov/tiles/Mars/EQ/THEMIS_DayIR_ControlledMosaics_100m_v2_oct2018/1.0.0//default/default028mm/5/12/45.png", None, "img"),
    ("trek_themis_night", "https://trek.nasa.gov/tiles/Mars/EQ/THEMIS_NightIR_ControlledMosaics_100m_v2_oct2018/1.0.0//default/default028mm/5/12/45.png", None, "img"),
    ("trek_geology", "https://trek.nasa.gov/mars/trekarcgis/rest/services/SIM3292_Global_Geology/MapServer/WMTS/tile/1.0.0/SIM3292_Global_Geology/default/default028mm/5/12/45.png", None, "img"),
    ("trek_ez_query", "https://trek.nasa.gov/mars/trekarcgis/rest/services/EZMars/MapServer/0/query?where=1%3D1&outFields=*&f=json", None, "json"),
    ("trek_ez_landing", "https://trek.nasa.gov/mars/trekarcgis/rest/services/EZMars/MapServer/2/query?where=1%3D1&outFields=*&returnGeometry=true&f=json", None, "json"),
    ("swim_ci01", "https://swim.psi.edu/output/SWIM4MIM/Global/Composite/SWIM4MIM_Ci_0_1.tif", (0, 65535), "bin"),
    ("swim_listing", "https://swim.psi.edu/output/SWIM4MIM/Global/Composite/", None, "text"),
    ("tes_ti_lbl", "https://pds-geosciences.wustl.edu/mgs/mgs-m-tes-5-timap-v1/mgst_9001/data/global_ti_night_2007.lbl", None, "text"),
    ("tes_ti_img", "https://pds-geosciences.wustl.edu/mgs/mgs-m-tes-5-timap-v1/mgst_9001/data/global_ti_night_2007.img", (0, 4095), "bin"),
    ("robbins_zip", "https://craters.sjrdesign.net/Catalog_Mars_Release_2020_1kmPlus_FullMorphData.csv.zip", (0, 4095), "bin"),
    ("grs_h2o", "https://pds-geosciences.wustl.edu/ody/ody-m-grs-5-elements-v1/odgm_xxxx/data/smoothed/h2o_sr_5x5.tab", None, "text"),
    ("grs_h2o_lbl", "https://pds-geosciences.wustl.edu/ody/ody-m-grs-5-elements-v1/odgm_xxxx/data/smoothed/h2o_sr_5x5.lbl", None, "text"),
    ("pygeoapi_units", "https://astrogeology.usgs.gov/pygeoapi/collections/mars/sim3292_global_geologic_map/units/items?bbox=77.4,18.4,77.5,18.5&f=json", None, "json"),
    ("pygeoapi_robbins", "https://astrogeology.usgs.gov/pygeoapi/collections/mars/robbinsv1/items?bbox=77.0,18.0,78.0,19.0&f=json&limit=5", None, "json"),
    ("stac_themis", "https://stac.astrogeology.usgs.gov/api/collections/mo_themis_controlled_mosaics/items?limit=100", None, "json"),
    ("mola_rough_readme", "https://zenodo.org/records/15734221", None, "text"),
]


def fetch(url, rng=None, timeout=40):
    h = {"User-Agent": UA}
    if rng:
        h["Range"] = f"bytes={rng[0]}-{rng[1]}"
    req = urllib.request.Request(url, headers=h)
    t = time.time()
    with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
        data = r.read(3_000_000)
        return r.status, dict(r.headers), data, time.time() - t


def main():
    lines = [time.strftime("%Y-%m-%d %H:%M:%S") + f" probe from {sys.executable}"]
    for name, url, rng, kind in PROBES:
        try:
            st, hd, data, dt = fetch(url, rng)
            ext = {"json": ".json", "img": "", "bin": ".bin", "text": ".txt"}[kind]
            if kind == "img":
                ct = hd.get("Content-Type", "")
                ext = ".png" if "png" in ct else ".jpg" if "jp" in ct else ".dat"
            (OUT / f"{name}{ext}").write_bytes(data)
            extra = ""
            if kind == "json":
                try:
                    j = json.loads(data.decode("utf-8", "replace"))
                    extra = f" json keys {list(j)[:8]}" + (f" features {len(j.get('features', []))}" if isinstance(j, dict) else "")
                except ValueError:
                    extra = " (not JSON)"
            lines.append(f"OK   {name:20s} {st} {len(data):9d} B {dt:5.1f}s type={hd.get('Content-Type')} "
                         f"len={hd.get('Content-Length')} range={hd.get('Content-Range')} accept-ranges={hd.get('Accept-Ranges')}{extra}")
        except Exception as e:  # noqa: BLE001
            lines.append(f"FAIL {name:20s} {type(e).__name__}: {e}")
        print(lines[-1], flush=True)
    (OUT / "report.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
