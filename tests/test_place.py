"""
Place tests (planet/place.py, app/js/placeview.js): everything known about any point on Mars. Run: python -m pytest tests/ -q

Covers the USGS chart quadrangles at landed-mission sites, surface gravity against Mars' published equatorial value, the
liquid-water window against the steam tables, the whole place lookup with its data sources stubbed (no network, no
installed layers: it must still answer), and the live time-at-the-place code against the Python Mars24 port.
"""
from __future__ import annotations

import json
import math
import os
import subprocess
import sys

import numpy as np
import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "pipeline"))

from planet import place  # noqa: E402


def node(js: str):
    out = subprocess.run(["node", "--input-type=module", "-e", js], cwd=ROOT, capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


@pytest.mark.parametrize("lon,lat,mc", [
    (137.4416, -4.5895, "MC-23"),     # Curiosity, Bradbury Landing (Aeolis)
    (77.4509, 18.4446, "MC-13"),      # Perseverance, Octavia E. Butler Landing (Syrtis Major)
    (-5.526, -1.948, "MC-19"),        # Opportunity, Meridiani Planum (Margaritifer Sinus)
    (175.478, -14.572, "MC-23"),      # Spirit, Gusev crater (Aeolis)
    (-47.952, 22.272, "MC-10"),       # Viking 1, Chryse Planitia (Lunae Palus)
    (134.28, 47.667, "MC-07"),        # Viking 2, Utopia Planitia (Cebrenia)
    (-125.755, 68.219, "MC-01"),      # Phoenix (Mare Boreum)
    (135.623, 4.502, "MC-15"),        # InSight, Elysium Planitia (Elysium)
    (-133.8, 18.65, "MC-09"),         # Olympus Mons (Tharsis)
    (70.0, -42.0, "MC-28"),           # Hellas
    (0.0, -88.0, "MC-30"),            # south polar cap (Mare Australe)
])
def test_quadrangle_of_known_sites(lon, lat, mc):
    assert place.quadrangle(lon, lat)["id"] == mc


def test_quadrangle_wraps_longitude():
    assert place.quadrangle(360 + 137.44, -4.59) == place.quadrangle(137.44, -4.59)
    assert place.quadrangle(180.0, 10.0) == place.quadrangle(-180.0, 10.0)        # one meridian, one chart
    assert place.quadrangle(179.99, 10.0)["id"] == "MC-15" and place.quadrangle(-179.99, 10.0)["id"] == "MC-08"


def test_surface_gravity():
    eq = place.gravity(0.0, 0.0)
    assert eq["g_ms2"] == pytest.approx(3.71, abs=0.01)        # NASA Mars fact sheet: 3.71 m/s^2 at the equator
    assert eq["earth_ratio"] == pytest.approx(0.378, abs=0.002)
    assert place.gravity(80.0, 0.0)["g_ms2"] > eq["g_ms2"]       # flattening and spin: heavier at the poles
    assert place.gravity(18.65, 21000.0)["g_ms2"] < place.gravity(-42.0, -7000.0)["g_ms2"]   # Olympus Mons vs Hellas
    assert place.gravity(0.0, 0.0, 100.0)["g_ms2"] == pytest.approx(eq["g_ms2"] + 0.001, abs=1e-6)  # 100 mGal


def test_liquid_water_window():
    assert place.water_phase(500.0)["liquid_possible"] is False              # below the triple point
    assert place.water_phase(1228.0)["boil_c"] == pytest.approx(10.0, abs=0.1)   # steam tables: 1.228 kPa at 10 C
    assert place.water_phase(101325.0)["boil_c"] == pytest.approx(100.0, abs=0.3)
    lo, hi = place.water_phase(700.0)["boil_c"], place.water_phase(1100.0)["boil_c"]
    assert 0 < lo < hi < 10
    assert place.water_phase(None) is None


@pytest.fixture
def offline(monkeypatch, tmp_path):
    """The place lookup with nothing installed and no network: every source stubbed or empty."""
    from planet import atlas, catalog, config, datasets, megdr, names
    for k, v in {"root": __import__("pathlib").Path(ROOT), "cache": tmp_path, "base": tmp_path / "base", "catalog": tmp_path,
                 "app_data": __import__("pathlib").Path(ROOT) / "app" / "data", "pipeline": __import__("pathlib").Path(ROOT) / "pipeline"}.items():
        monkeypatch.setitem(config.PATHS, k, v)
    monkeypatch.setattr(megdr, "sample128", lambda lon, lat, allow_download=True, progress=None: np.full(len(lon), -4480.0))
    monkeypatch.setattr(megdr, "sample16", lambda lon, lat, progress=None: np.full(len(lon), -4480.0))
    monkeypatch.setattr(names, "nearest", lambda lon, lat, k=5, max_km=1e9: [{"name": "Yellowknife", "type": "Crater", "lon": 137.44, "lat": -4.58, "dist_km": 2.6}])
    monkeypatch.setattr(catalog, "query", lambda *a, **k: [])
    monkeypatch.setattr(catalog, "ready", lambda kind: True)
    monkeypatch.setattr(atlas, "sample_trek", lambda ovl, lon, lat: None)
    monkeypatch.setattr(datasets, "geology_at", lambda lon, lat: {"unit": "Htu", "description": "Hesperian transition undivided unit"})
    return tmp_path


def test_place_answers_for_any_point_without_layers(offline):
    d = place.everything(137.44, -4.59, wait_s=5)
    assert d["ok"] and not d["pending"]
    assert d["where"]["quadrangle"]["id"] == "MC-23" and d["where"]["names"][0]["name"] == "Yellowknife"
    assert d["elevation"]["m"] == -4480
    E = d["environment"]
    assert E["pressure_pa"] == pytest.approx(610 * math.exp(4480 / 11100), abs=1)
    assert E["water"]["liquid_possible"] and 4 < E["water"]["boil_c"] < 7
    assert E["gcr_ugy_day"] == pytest.approx(210, abs=3)                 # Curiosity's RAD dose at Gale
    assert E["gravity"]["g_ms2"] == pytest.approx(3.71, abs=0.02)
    assert d["surface"]["geology"]["unit"] == "Htu"
    assert d["surface"]["ti"] is None and d["water"]["ice"] is None         # not installed: said so, not invented
    assert any(m["id"] == "msl" for m in d["missions"]) and d["missions"][0]["dist_km"] < 50
    assert d["objectives"] and "title" in d["objectives"][0]
    assert d["coverage"]["best_m"] is None
    json.dumps(d)                                                           # the API sends it as JSON


def test_place_marks_slow_lookups_pending(offline, monkeypatch):
    import threading
    from planet import datasets
    gate = threading.Event()
    monkeypatch.setattr(datasets, "geology_at", lambda lon, lat: gate.wait(5) and None)
    d = place.everything(77.45, 18.44, wait_s=0.2)
    gate.set()
    assert "geology" in d["pending"] and d["surface"]["geology"] == {"pending": True}


def test_place_finds_the_built_site_it_is_in(offline):
    sites = json.loads(open(os.path.join(ROOT, "app", "data", "sites.json")).read())
    cfg = json.loads(open(os.path.join(ROOT, "pipeline", "sites", f"{sites[0]['id']}.json")).read())
    w, s, e, n = cfg["ops_area"]
    got = place.built_sites((w + e) / 2, (s + n) / 2)
    assert got["inside"] and got["inside"]["id"] == sites[0]["id"]
    assert place.built_sites(-100.0, -60.0)["inside"] is None


def test_time_here_matches_the_python_mars24_port():
    import mars_time
    ms = 1793232000000          # 2026-10-29T00:00:00Z
    js = node(f"""import {{ timeHere }} from './app/js/placeview.js';
const out = {{}};
for (const [k, lon, lat] of [["gale", 137.44, -4.59], ["n85", 0, 85], ["s85", 0, -85], ["jez", 77.45, 18.44]]) out[k] = timeHere({ms}, lon, lat);
console.log(JSON.stringify(out));""")
    jd = ms / 86400000 + 2440587.5 + 69.184 / 86400
    st = mars_time.mars_state(jd)
    for k, lon, lat in (("gale", 137.44, -4.59), ("jez", 77.45, 18.44)):
        assert js[k]["Ls"] == pytest.approx(st["Ls"], abs=0.01)
        assert js[k]["ltst"] == pytest.approx(mars_time.ltst_hours(st, lon), abs=0.01)
        assert js[k]["sun"]["elevation"] == pytest.approx(mars_time.sun(st, lon, lat)["elevation"], abs=0.05)
        assert 11.5 < js[k]["daylightH"] < 12.8               # Ls 14: near the equinox, close to 12 h everywhere
        assert js[k]["marsYear"] == 39
    assert js["n85"]["polar"] == "day" and js["s85"]["polar"] == "night"   # northern spring: the north pole is lit
    assert js["gale"]["seasonN"] == "spring" and js["gale"]["season"] == "autumn"
    assert 3 < js["gale"]["lightMin"] < 23


def test_thermal_inertia_class_knows_polar_ice():
    from planet import datasets
    assert datasets.ti_class(3753.0, 85.0).startswith("ice")             # the north residual cap (TES: ~3,750 SI)
    assert datasets.ti_class(1500.0, 20.0) == "rocky or bedrock"         # the same value at low latitude is rock
    assert datasets.ti_class(250.0, 80.0) == "sand, duricrust or mixed rock"
    assert datasets.ti_class(None) == "unknown"
