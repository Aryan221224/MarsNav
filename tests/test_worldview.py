"""
Worldview-style server features. Run: python -m pytest tests/test_worldview.py -q

1. The dust climatology on the server (planet/dust.py) gives the same numbers as the browser engine (engine/dust.js),
   and its globe overlay follows the local surface pressure.
2. The crustal magnetic field (planet/magnetic.py) reproduces the check values published with the MGS grids
   (Connerney et al. 2001 data README) and peaks in Terra Cimmeria / Sirenum.
3. The MARCI daily maps (planet/marci.py) are found by Mars year and season without downloading anything, and tiles are
   cut from the right place of the 0.1 deg map.
4. A MARCI month is downloaded from Harvard Dataverse even when the map servers' internet probe fails (that server is
   asked itself), and the stand-in tile shown meanwhile is never cached as final.
5. Area statistics (planet/stats.py) use exact spherical areas, sample inside the shape (also across 180 deg) and read
   every layer.
"""
from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)

from planet import (
    config,
    dust,
    imagery,
    localmode,
    magnetic,
    marci,
    net,
    stats,
    tilecache,
)

R = 3396.19


@pytest.fixture(autouse=True)
def _project(tmp_path, monkeypatch):
    """The project's data (app/data/global, planet/data) with a throw-away tile cache."""
    config.configure(ROOT)
    for k in ("cache", "tiles", "tiles_offline"):
        monkeypatch.setitem(config.PATHS, k, tmp_path / k)
        (tmp_path / k).mkdir(parents=True, exist_ok=True)
    yield


# ------------------------------------------------------------------ 1. dust
def test_dust_server_and_browser_engine_agree():
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    pts = [[77.45, 18.44, 250, "p50", 610], [137.4, -4.6, 205, "p90", 820], [-5.53, -1.95, 3, "p10", 700],
           [179.9, 88.0, 359.9, "p50", 300], [-179.9, -88.0, 0.0, "p90", 610], [12.3, 45.6, 181.7, "p50", 1000]]
    years = [[77.45, 18.44, 250, 28], [137.4, -4.6, 205, 34], [0, 0, 50, 24]]
    js = f"""
import {{ DustClimatology }} from {json.dumps(Path(ROOT, "engine", "dust.js").as_uri())};
import {{ nodeIO }} from {json.dumps(Path(ROOT, "engine", "node_io.js").as_uri())};
const D = await DustClimatology.load(nodeIO({json.dumps(str(Path(ROOT, "app", "data", "global")))}));
const a = {json.dumps(pts)}.map(([lo, la, ls, st, p]) => D.tauVisible(lo, la, ls, {{ stat: st, pressurePa: p }}));
const b = {json.dumps(years)}.map(([lo, la, ls, my]) => D.yearCdod(lo, la, ls, my));
console.log(JSON.stringify([a, b.map((v) => (Number.isNaN(v) ? null : v))]));
"""
    out = subprocess.run([node, "--input-type=module", "-e", js], capture_output=True, text=True, timeout=60, check=True)
    js_tau, js_year = json.loads(out.stdout)
    for (lo, la, ls, st, p), v in zip(pts, js_tau):
        py = float(dust.tau_visible(np.array([lo]), np.array([la]), ls, st, p)[0])
        assert abs(py - v) < 1e-9, (lo, la, ls, st, py, v)
    for (lo, la, ls, my), v in zip(years, js_year):
        py = float(dust.year_cdod(np.array([lo]), np.array([la]), ls, my)[0])
        assert (v is None and math.isnan(py)) or abs(py - v) < 1e-9, (lo, la, ls, my, py, v)


def test_dust_year_at_a_place():
    s = dust.season(77.45, 18.44, pressure_pa=700)
    assert len(s["curve"]) == 73 and s["curve"][0]["ls"] == 0 and s["curve"][-1]["ls"] == 360
    assert all(r["p10"] <= r["p50"] <= r["p90"] for r in s["curve"])
    assert 0 <= s["clearest"]["ls"] < 180 <= s["dustiest"]["ls"] < 360          # aphelion clear, perihelion dusty
    assert s["storm_years"] == [25, 28, 34]
    assert s["years"]["24"][0] is None and s["years"]["25"][20] is not None    # MY 24 starts at Ls ~103 in the record
    assert s["pressure_pa"] == 700 and "Montabone" in s["cite"]


def test_dust_overlay_ids_legend_and_pressure(monkeypatch):
    from planet import megdr
    assert dust.parse_ovl("dust@250") == ("p50", 250.0)
    assert dust.parse_ovl("dust90@365") == ("p90", 5.0)
    assert dust.parse_ovl("dust") is None and dust.parse_ovl("dust@x") is None
    assert "Ls 250" in dust.legend("dust@250")["title"] and "90th" in dust.legend("dust90@250")["title"]
    # MOLA not here yet: the 610 Pa datum, provisional (asked for again)
    monkeypatch.setattr(megdr, "sample16", lambda lon, lat, wait=False: None)
    a, prov = dust.overlay_rgba("dust@250", 2, 1, 3, 64)
    assert prov is True and a.shape == (64, 64, 4) and 0 <= a.min() and a.max() <= 1
    # at the datum the same field, final; in a deep basin (Hellas, -7 km) more air, more dust, a stronger overlay
    monkeypatch.setattr(megdr, "sample16", lambda lon, lat, wait=False: np.zeros(np.size(lon)))
    b, prov = dust.overlay_rgba("dust@250", 2, 1, 3, 64)
    assert prov is False and np.allclose(a, b)
    monkeypatch.setattr(megdr, "sample16", lambda lon, lat, wait=False: np.full(np.size(lon), -7000.0))
    c, _ = dust.overlay_rgba("dust@250", 2, 1, 3, 64)
    assert c[..., 3].mean() > b[..., 3].mean()


# ------------------------------------------------------------------ 2. magnetic field
def test_magnetic_field_reproduces_the_published_check_values():
    # the data README: Br = 138.271 nT at 171.5E 54.5S and -7.367 nT at 200.5E 45.5N (stored to 0.1 nT)
    assert abs(float(magnetic.sample(np.array([171.5]), np.array([-54.5]), "br")[0]) - 138.271) <= 0.05
    assert abs(float(magnetic.sample(np.array([200.5 - 360]), np.array([45.5]), "br")[0]) + 7.367) <= 0.05
    a = magnetic.load()["a"][0]
    g = magnetic.load()["m"]["grid"]
    i, j = np.unravel_index(np.argmax(np.abs(a)), a.shape)
    lat, lon = g["lat0"] - i * g["step_deg"], g["lon0"] + j * g["step_deg"]
    assert lat < -30 and (lon > 120 or lon < -140), (lat, lon)               # Terra Cimmeria / Terra Sirenum
    assert 150 < abs(a[i, j]) < 300
    p = magnetic.point(177.5, -52.5)
    assert p["word"] == "strong" and p["btotal_nT"] >= abs(p["br_nT"]) and p["altitude_km"] == 400
    assert magnetic.point(-60, 60)["word"] in ("negligible", "weak")        # the northern plains: next to nothing


# ------------------------------------------------------------------ 3. MARCI daily maps
def test_marci_dates_resolve_without_downloading():
    d = marci.days()
    assert len(d) == 2680 and {x[2] for x in d} == {28, 29, 30, 31, 32}
    assert d == sorted(d, key=lambda r: (r[2], r[3]))
    assert min(x[3] for x in d if x[2] == 28) > 130                        # MRO mapping began at Ls ~132 of MY 28
    n = marci.nearest(28, 265)
    assert n["sub"] == "P08" and n["gap_deg"] < 1 and n["layer"].startswith("marci-P08-")
    assert marci.nearest(28, 100) is None                                   # before MRO arrived
    assert all(0 <= x[4] <= 1 for x in d) and np.median([x[4] for x in d]) > 0.85
    # MY 29 near Ls 280: the two nearest sols lost orbits (day 9 at Ls 281.8 maps 38 % of 60 S - 60 N); a full one is used
    n29 = marci.nearest(29, 280)
    assert n29["coverage"] >= marci.MIN_COVERAGE and n29["gap_deg"] <= 6 and (n29["sub"], n29["day"]) != ("B10", 9)
    assert marci.nearest(29, 281.8, max_gap=0.1)["day"] == 9                # still used when it is the only one
    ix = marci.index()
    assert ix["download"].startswith("https://dataverse.harvard.edu/")
    assert all(s["md5"] and s["bytes"] > 1e6 for s in ix["subphases"].values())


def test_marci_tiles_come_from_the_right_place(monkeypatch):
    # a synthetic map whose red is longitude and green latitude, at the 0.1 deg pixel centres
    g = marci.index()["grid"]
    lon = g["lon0"] + (np.arange(g["w"]) + 0.5) * g["deg_per_px"]
    lat = g["lat0"] - (np.arange(g["h"]) + 0.5) * g["deg_per_px"]
    img = np.zeros((g["h"], g["w"], 3), np.uint8)
    img[..., 0] = np.round((lon[None, :] + 180) / 360 * 250).astype(np.uint8) + 3
    img[..., 1] = np.round((90 - lat[:, None]) / 180 * 250).astype(np.uint8) + 3
    img[:50, :, :] = 0                                                      # polar night: black, no data
    monkeypatch.setitem(marci._imgs, ("P08", 29), img)
    for w, s, e, n, size in ((-40, -10, -20, 10, 64), (10.0, 20.0, 11.0, 21.0, 64)):       # zoomed out, zoomed in
        rgb, nodata = marci.tile_rgb("marci-P08-29", w, s, e, n, size)
        assert rgb.shape == (size, size, 3) and not nodata.any()
        cl = w + (np.arange(size) + 0.5) * (e - w) / size
        ca = n - (np.arange(size) + 0.5) * (n - s) / size
        er = np.abs(rgb[size // 2, 2:-2, 0] * 255 - ((cl[2:-2] + 180) / 360 * 250 + 3)).max()
        eg = np.abs(rgb[2:-2, size // 2, 1] * 255 - ((90 - ca[2:-2]) / 180 * 250 + 3)).max()
        assert er < 1.6 and eg < 1.6, (w, s, er, eg)
    _, nodata = marci.tile_rgb("marci-P08-29", -180, 80, 180, 90, 32)
    assert nodata[:8].all()                                                 # north of 85 deg is black in the map
    assert marci.tile_rgb("viking", 0, 0, 1, 1) == (None, None)


def test_marci_missing_month_starts_its_download(monkeypatch):
    started = []
    monkeypatch.setattr(marci, "image", lambda sub, day: None)
    monkeypatch.setattr(marci, "fetch_async", lambda sub: started.append(sub))
    monkeypatch.setattr(net, "blocked", lambda url="": False)
    assert marci.tile_rgb("marci-P08-29", 0, 0, 1, 1) == (None, None) and started == ["P08"]
    monkeypatch.setattr(net, "blocked", lambda url="": True)
    marci.tile_rgb("marci-P08-29", 0, 0, 1, 1)
    assert started == ["P08"]                                               # Mars mode / no internet: not tried


# ------------------------------------------------------------------ 4. MARCI download while the map servers' probe fails
def test_download_host_is_asked_itself_when_the_map_servers_do_not_answer(monkeypatch):
    asked = []

    def probe(url, timeout=6):
        asked.append(url)
        return ("dataverse" in url), None
    monkeypatch.setattr(net, "_probe_one", probe)
    monkeypatch.setattr(net, "_hosts", {})
    monkeypatch.setattr(net, "_state", {"online": False, "checked": time.time(), "last_error": "map servers down"})
    monkeypatch.setattr(localmode, "offline", lambda: False)
    dv = "https://dataverse.harvard.edu/api/access/datafile/123"
    assert net.blocked() is True
    assert net.blocked(dv) is False and net.blocked(dv) is False
    assert asked == ["https://dataverse.harvard.edu/"]                     # one probe, then remembered
    assert net.blocked("https://unreachable.example/x") is True
    assert net.blocked(net.PROBE_URLS[0]) is True and len(asked) == 2        # the map servers are not asked twice
    monkeypatch.setattr(localmode, "offline", lambda: True)
    assert net.blocked(dv) is True                                          # Mars mode: nothing goes out
    monkeypatch.setattr(localmode, "offline", lambda: False)
    monkeypatch.setattr(net, "_state", {"online": True, "checked": time.time(), "last_error": None})
    assert net.blocked(dv) is False and len(asked) == 2                     # online: no probe needed


def test_a_success_off_the_probe_does_not_switch_the_map_servers_on(monkeypatch):
    dv = "https://dataverse.harvard.edu/api/access/datafile/1"
    monkeypatch.setattr(net, "_hosts", {})
    monkeypatch.setattr(net, "_state", {"online": False, "checked": time.time(), "last_error": None})
    net._mark(True, url=dv)
    assert net._state["online"] is False and net._hosts["dataverse.harvard.edu"][0] is True
    net._mark(True, url=net.PROBE_URLS[0])                                 # a map server answered: online
    assert net._state["online"] is True
    monkeypatch.setattr(net, "_state", {"online": None, "checked": 0.0, "last_error": None})
    net._mark(True, url=dv)                                                 # a normal network: any success counts
    assert net._state["online"] is True


def test_marci_stand_in_is_never_cached(monkeypatch):
    from PIL import Image
    monkeypatch.setattr(imagery, "_base_trek", lambda layer, z, y, x: Image.new("RGB", (256, 256), (120, 90, 70)))
    monkeypatch.setattr(marci, "tile_rgb", lambda *a, **k: (None, None))
    monkeypatch.setattr(net, "blocked", lambda url="": True)               # the map servers' probe failed
    monkeypatch.setattr(localmode, "offline", lambda: False)
    _, meta = imagery.build(1, 0, 1, "marci-P08-29", (), 1.0)
    assert meta["provisional"] is True                                      # the month can still arrive
    data, final = imagery.tile_bytes_ex(1, 0, 1, "marci-P08-29")
    assert final is False and data[:2] == b"\xff\xd8"
    for offline in (False, True):
        key, _ = tilecache.path("img3_marci-P08-29", 1, 0, 1, "jpg", offline=offline), None
        assert not key.exists()
    monkeypatch.setattr(localmode, "offline", lambda: True)                # Mars mode: no month can arrive, final
    _, meta = imagery.build(1, 0, 1, "marci-P08-29", (), 1.0)
    assert meta["provisional"] is False


def test_layer_names_and_overlay_order():
    assert imagery.parse("viking", "craters,magnetic,dust@250,geology,dust90@100") == ("viking", ("dust@250", "magnetic", "geology", "craters"))
    assert imagery.parse("marci-P08-29", "")[0] == "marci-P08-29"
    assert imagery.parse("marci-Z99-01", "")[0] == "best"                   # not a MARCI month: the default map


# ------------------------------------------------------------------ 5. area statistics
def test_spherical_areas_and_sampling():
    box = R * R * math.radians(1) * math.sin(math.radians(1))
    assert abs(stats.area_km2([[0, 0], [1, 0], [1, 1], [0, 1]]) - box) < 1e-6
    across = [[179.5, 0], [-179.5, 0], [-179.5, 1], [179.5, 1]]
    assert abs(stats.area_km2(across) - box) < 1e-6
    lo, la, step = stats.lattice(across, n=400)
    assert 300 < lo.size < 520 and abs(step - math.sqrt(box / 400)) < 1e-9
    assert ((lo >= 179.5) | (lo <= -179.5)).all() and ((la > 0) & (la < 1)).all()
    tri = [[0, 0], [2, 0], [0, 2]]
    lo, la, _ = stats.lattice(tri, n=500)
    assert (lo + la < 2).all() and lo.size > 300


def test_polygon_statistics_read_every_layer(monkeypatch):
    poly = [[76.5, 17.5], [78.5, 17.5], [78.5, 19.5], [76.5, 19.5]]
    monkeypatch.setattr(stats, "_elev", lambda megdr, lon, lat: (np.full(np.shape(lon), -2500.0), "test grid"))
    r = stats.polygon_stats(poly, ls=250, n=600)
    L = r["layers"]
    assert r["ok"] and abs(r["area_km2"] - stats.area_km2(poly)) < 1e-3 and 450 < r["points"] < 750
    assert L["elev"]["p50"] == -2500 and L["slope"]["max"] == 0 and L["elev"]["source"] == "test grid"
    p = 610 * math.exp(2500 / 11100)
    assert abs(L["pressure"]["p50"] - p) < 60                                # the model surface pressure at -2.5 km
    tau = dust.tau_visible(np.array([77.5]), np.array([18.5]), 250, "p50", p)[0]
    assert L["dust"]["ls"] == 250 and L["dust"]["min"] <= round(float(tau), 2) + 0.05 and L["dust"]["max"] >= round(float(tau), 2) - 0.05
    assert L["dust90"]["p50"] >= L["dust"]["p50"] and L["mag"]["unit"] == "nT" and L["mag"]["cover"] == 1.0
    # before the first MOLA download: the 610 Pa datum, said so
    monkeypatch.setattr(stats, "_elev", lambda megdr, lon, lat: (None, None))
    r2 = stats.polygon_stats(poly, ls=250, n=300)
    assert "elevation_missing" in r2 and "elev" not in r2["layers"] and r2["layers"]["dust"]["n"] > 0
    with pytest.raises(ValueError):
        stats.polygon_stats([[0, 0], [1, 1]])


def test_data_links_for_the_new_layers():
    from planet import api
    assert "lmd.jussieu.fr" in api.data_url("dust@250") and "lmd.jussieu.fr" in api.data_url("dust90@10")
    assert "gsfc.nasa.gov" in api.data_url("magnetic")
