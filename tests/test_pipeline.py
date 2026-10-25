"""
Pipeline tests. Run: python -m pytest tests/ -q

Covers the Python side of the system: the Mars24 port (against the published worked example and against the
JavaScript engine, so pipeline and app agree on time), the Jezero projection (against the JS engine), the terrain
detectors on synthetic ground truth (known slope, known ripple field), the soft-soil model's monotonicity, and the
integrity of every shipped data layer.
"""
from __future__ import annotations

import gzip
import json
import math
import os
import subprocess
import sys

import numpy as np
import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "pipeline"))

import mars_time  # noqa: E402
import mars_geo  # noqa: E402

DATA = os.path.join(ROOT, "app", "data")


def node(js: str):
    """Evaluate an ES-module snippet with the shipped engine and return its JSON output."""
    out = subprocess.run(["node", "--input-type=module", "-e", js], cwd=ROOT, capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


# ----------------------------------------------------------------------------------------------------- time ----
def test_mars24_worked_example():
    # Allison & McEwen (2000) / Mars24 example: 2000-01-06 00:00:00 UTC -> JD_TT 2451549.500743
    jd_tt = 2451549.5 + 64.184 / 86400
    st = mars_time.mars_state(jd_tt)
    assert st["Ls"] == pytest.approx(277.18758, abs=2e-4)
    assert st["MTC"] == pytest.approx(23.99425, abs=2e-4)


def test_python_and_js_clocks_agree():
    times = [0, 1.0e11, 6.3e11, 1.6137e12, 1.7e12, 1.79e12]   # ms since 1970, 1970 to 2026
    js = node(
        "import {marsState, jdTT, sunPosition, M2020} from './engine/marstime.js';"
        f"const T={json.dumps(times)};"
        "console.log(JSON.stringify(T.map(ms=>{const s=marsState(jdTT(ms));"
        "const p=sunPosition(s,M2020.lonEast,M2020.lat);return {jd:jdTT(ms),Ls:s.Ls,MTC:s.MTC,z:p.zenith};})))")
    for r in js:
        st = mars_time.mars_state(r["jd"])
        assert st["Ls"] == pytest.approx(r["Ls"], abs=1e-6)
        assert st["MTC"] == pytest.approx(r["MTC"], abs=1e-6)
        z = mars_time.sun(st, mars_time.M2020_LON, mars_time.M2020_LAT)["zenith"]
        assert z == pytest.approx(r["z"], abs=1e-6)


def test_sol_zero_is_landing_sol():
    js = node("import {m2020SolFromMs, M2020, SOL0_MSD_M2020} from './engine/marstime.js';"
              "console.log(JSON.stringify({s:m2020SolFromMs(Date.parse(M2020.landingUTC)).sol, m:SOL0_MSD_M2020}))")
    assert js["s"] == 0
    assert js["m"] == mars_time.SOL0_MSD_M2020


# ----------------------------------------------------------------------------------------------- projection ----
def test_projection_matches_engine():
    pts = [(77.45088572, 18.44462715), (77.17, 18.36), (77.52, 18.56)]
    js = node("import {lonlatToXY} from './engine/geo.js';"
              f"console.log(JSON.stringify({json.dumps(pts)}.map(([a,b])=>lonlatToXY(a,b))))")
    for (lon, lat), (x, y) in zip(pts, js):
        px, py = mars_geo.lonlat_to_xy(lon, lat)
        assert px == pytest.approx(x, abs=1e-6)
        assert py == pytest.approx(y, abs=1e-6)
        back = mars_geo.xy_to_lonlat(px, py)
        assert back[0] == pytest.approx(lon, abs=1e-10) and back[1] == pytest.approx(lat, abs=1e-10)


def test_haversine_one_degree():
    assert mars_geo.haversine_m(0, 0, 0, 1) == pytest.approx(3396190 * math.pi / 180, rel=1e-9)


# ------------------------------------------------------------------------------------------ terrain detectors --
bt = pytest.importorskip("build_terrain", reason="needs rasterio/scipy (pip install -r requirements.txt)")
bl = pytest.importorskip("build_layers")


def test_walking_slope_recovers_a_known_plane():
    n = 200
    yy, xx = np.mgrid[0:n, 0:n].astype(float)
    z = np.tan(np.radians(12.0)) * xx
    pf = bt.post_fields(z, np.ones_like(z, bool))
    assert np.median(pf["sw"][20:-20, 20:-20]) == pytest.approx(12.0, abs=0.05)


def test_bedform_detector_fires_on_ripples_not_on_rough_ground():
    rng = np.random.default_rng(1)
    n = 240
    yy, xx = np.mgrid[0:n, 0:n].astype(float)
    ripples = 0.35 * np.sin(2 * np.pi * (xx * math.cos(0.4) + yy * math.sin(0.4)) / 14.0)    # 14 m wavelength TAR-like
    rough = ndi_smooth(rng.normal(0, 0.35, (n, n)), 2.0)                                     # isotropic rubble
    ones = np.ones((n, n), bool)
    ev = []
    for z in (ripples, rough):
        pf = bt.post_fields(z, ones)
        c = pf["coh"][40:-40, 40:-40].mean()
        e = pf["energy"][40:-40, 40:-40].mean()
        ev.append(float(bl.sand_evidence(np.full((5, 5), c), np.full((5, 5), e))[2, 2]))
    assert ev[0] > 0.6, ev
    assert ev[1] < 0.2, ev


def ndi_smooth(a, s):
    from scipy import ndimage as ndi
    return ndi.gaussian_filter(a, s)


def test_slip_model_is_monotone_and_widens_without_hirise():
    sand = np.array([0.0, 0.5, 1.0])
    mu, sd = bl.slip_model(sand, np.full(3, 10.0), np.ones(3))
    assert np.all(np.diff(mu) > 0) and np.all(np.diff(sd) > 0)
    _, sd_lo = bl.slip_model(sand, np.full(3, 10.0), np.zeros(3))
    assert np.all(sd_lo > sd)
    mu_s, _ = bl.slip_model(np.ones(3), np.array([0.0, 10.0, 20.0]), np.ones(3))
    assert np.all(np.diff(mu_s) > 0)


# ------------------------------------------------------------------------------------------------ shipped data --
def manifest():
    with open(os.path.join(DATA, "manifest.json")) as f:
        return json.load(f)


def test_every_layer_decodes_to_its_grid():
    man = manifest()
    for name, L in man["layers"].items():
        g = man["grids"][L["grid"]]
        raw = gzip.open(os.path.join(DATA, L["file"])).read()
        n = int(np.prod(L["shape"]))
        assert n % (g["width"] * g["height"]) == 0, name
        assert len(raw) == n * np.dtype(L["dtype"]).itemsize, name


def test_targets_and_keepouts_inside_the_ops_area():
    man = manifest()
    lo0, la0, lo1, la1 = mars_geo.SITE["ops_area"]
    for t in man["targets"]:
        assert lo0 <= t["lon"] <= lo1 and la0 <= t["lat"] <= la1, t["id"]
    assert len(man["keepouts"]) >= 2


def test_environment_fit_quality():
    with open(os.path.join(ROOT, "validation", "results", "meda_fit.json")) as f:
        fit = json.load(f)
    q = fit["quality"]
    assert q["air"]["rmse"] < 6.0 and q["ground"]["rmse"] < 8.0      # K, harmonic climatology vs MEDA samples
    assert q["pressure"]["rmse"] < 10.0                              # Pa, with hydrostatic elevation term
    assert 9000 < q["pressure"]["scale_height_m"] < 13000            # physical Mars scale height ~11 km
    with open(os.path.join(DATA, "environment.json")) as f:
        env = json.load(f)
    for k in ("air", "ground", "pressure"):
        assert k in env


def test_blunder_screen_flags_spikes_not_slopes():
    n = 120
    yy, xx = np.mgrid[0:n, 0:n].astype(float)
    z = np.tan(np.radians(25)) * xx * 10.0        # a real, steady 25 deg slope on a 10 m grid
    z[60, 60] += 60.0                              # one stereo blunder spike
    bad, med = bt.dem_blunders(z, 10.0)
    assert bad[60, 60] and bad.sum() <= 9
    assert not bad[20:40, 20:40].any()


def test_seam_repair_turns_a_mosaic_step_into_a_ramp_but_keeps_a_crater():
    n = 400
    yy, xx = np.mgrid[0:n, 0:n].astype(float)
    z = np.where(xx < 200 + 0.05 * yy, 0.0, 18.0)                 # 18 m offset along a straight 4 km join
    r = np.hypot(yy - 100, xx - 80)
    z = z - np.where(r < 12, 40 * (1 - (r / 12) ** 2), 0)          # a real 240 m crater, deep and round
    seam = bt.dem_seams(z, 10.0)
    assert seam.sum() > 200
    assert not seam[85:115, 65:95].any(), "the crater is not a seam"
    band = __import__("scipy.ndimage", fromlist=["x"]).binary_dilation(seam, iterations=15)
    fixed = bt.membrane_fill(z, band)
    s = bt.slope_deg(fixed, 10.0)
    assert s[band].max() < 10, "the step becomes a gentle ramp"
    assert np.allclose(fixed[~band], z[~band]), "ground outside the band is untouched"


def test_every_site_file_is_valid_and_indexed():
    import sitecfg
    idx = json.load(open(os.path.join(DATA, "sites.json")))
    ids = {s["id"] for s in idx}
    for sid in sitecfg.list_sites():
        cfg = json.load(open(os.path.join(sitecfg.SITES, f"{sid}.json")))
        for k in ("id", "name", "projection", "ops_area", "regional_area", "sources"):
            assert k in cfg, (sid, k)
        lo0, la0, lo1, la1 = cfg["ops_area"]
        assert lo0 < lo1 and la0 < la1
        if os.path.exists(os.path.join(DATA, cfg.get("out_dir", ""), "manifest.json")):
            assert sid in ids
