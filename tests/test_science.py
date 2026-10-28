"""
Science-atlas tests. Run: python -m pytest tests/ -q

Covers the whole-planet layers added for the 2026 challenge: the bundled feature catalogues (counts, the radius query
against brute force, across the 180 deg meridian), the cosmic-ray dose model (Curiosity's RAD value at Gale, the
direction of the air-column effect, the same numbers as the JavaScript engine), the gravity summation against an
analytic case, the space-weather advisory on documented DONKI record shapes, and the objective and mission catalogues.
"""
from __future__ import annotations

import json
import math
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)

from planet import atlas, datasets, features, science, spaceweather  # noqa: E402


def node(js: str):
    out = subprocess.run(["node", "--input-type=module", "-e", js], cwd=ROOT, capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


# ------------------------------------------------------------------------------------------------- features ----

def test_feature_catalogue_is_complete():
    L = features.layers()
    want = {"aqueous": 4572, "hydrous": 1648, "chlorides": 642, "active": 508, "gullies": 4978, "glacial": 1847, "fans": 44,
            "dunes": 547}
    for k, n in want.items():
        got = len(L[k].get("pts") or L[k].get("items"))
        assert got == n, f"{k}: {got} features, Mars Trek lists {n}"
    assert {t["name"] for t in L["traverses"]["items"]} >= {"Curiosity", "Perseverance", "Spirit", "Opportunity"}
    for k, v in L.items():
        assert v.get("cite"), f"{k} has no citation"


@pytest.mark.parametrize("lon,lat", [(-165.982, -29.293), (179.95, 10.0), (-179.95, -20.0), (77.45, 18.44), (24.0, 45.0)])
def test_radius_query_matches_brute_force(lon, lat):
    """The bounding-box prefilter never drops a feature that is truly inside the radius (lines and outlines included,
    and on either side of the 180 deg meridian)."""
    L = features.layers()
    for k in ("valleys", "chlorides", "dunes", "aqueous"):
        Lk = L[k]
        if Lk["geom"] == "line":
            d = np.array([features._seg_dist_km(lon, lat, ln) for ln in Lk["lines"]])
        elif Lk["geom"] == "polygon":
            d = np.array([0.0 if features._inside(it["r"][0], lon, lat) else features._seg_dist_km(lon, lat, it["r"][0]) for it in Lk["items"]])
        else:
            d = features._hav_km(lon, lat, Lk["_lon"], Lk["_lat"])
        assert int((d <= 100).sum()) == len(features.in_radius(lon, lat, 100, {k}, limit=10 ** 6)), k


def test_line_distance_does_not_jump_across_the_meridian():
    # a short line 180 deg away must be far, not "through" the point
    assert features._seg_dist_km(0.0, 0.0, [[179.9, 0.1], [-179.9, 0.1]]) > 10000


def test_planetary_protection_flags_recurring_slope_lineae():
    c = features.context(-69.689, -11.516, 100)               # Garni crater, Valles Marineris (RSL)
    assert c["planetary_protection"] and c["planetary_protection"]["nearest_rsl_km"] < 50
    assert features.context(77.45, 18.44, 100)["planetary_protection"] is None      # Jezero


# ----------------------------------------------------------------------------------------------------- dose ----

def test_dose_model_is_rad_at_gale_and_falls_with_more_air():
    g = atlas.gcr_dose(np.array([atlas.GALE_ELEV_M]))
    assert g["ugy_day"][0] == pytest.approx(210.0)
    assert g["msv_day"][0] == pytest.approx(0.64)
    hi, lo = atlas.gcr_dose(np.array([2000.0, -7000.0]))["ugy_day"]
    assert hi > 210 > lo, "higher ground has less air overhead: more dose"
    ext = atlas.gcr_dose(np.array([-4500.0, 15000.0]))["extrapolated"]
    assert not ext[0] and ext[1], "far outside RAD's measured pressures the value is flagged"
    # weaker shielding at strong solar modulation (Guo et al.): the slope shrinks
    assert abs(atlas.gcr_dose(np.array([0.0]), 400)["kappa"]) > abs(atlas.gcr_dose(np.array([0.0]), 800)["kappa"])


def test_dose_model_matches_the_engine():
    js = node("""import { gcrDoseRate } from './engine/sitecheck.js';
console.log(JSON.stringify([-4501, -2566, 0, 2000].map((e) => gcrDoseRate(e))));""")
    py = atlas.gcr_dose(np.array([-4501.0, -2566.0, 0.0, 2000.0]))
    for k, r in enumerate(js):
        assert r["uGyDay"] == pytest.approx(float(py["ugy_day"][k]), rel=1e-9)
        assert r["mSvDay"] == pytest.approx(float(py["msv_day"][k]), rel=1e-9)


def test_route_dose_integrates_each_step():
    out = node("""import { routeDoseMSv, gcrDoseRate } from './engine/sitecheck.js';
const pts = [{ t: 0, elev: -2500 }, { t: 3600, elev: -2500 }, { t: 7200, elev: -4501 }];
console.log(JSON.stringify({ d: routeDoseMSv(pts), a: gcrDoseRate(-2500).mSvDay, b: gcrDoseRate(-4501).mSvDay, none: routeDoseMSv([{ t: 0 }]) }));""")
    assert out["d"] == pytest.approx((out["a"] * 3600 + out["a"] * 3600) / 86400)
    assert out["none"] is None


# -------------------------------------------------------------------------------------------------- gravity ----

def test_gravity_sum_matches_an_analytic_zonal_term():
    """One coefficient C30: dg = GM/R^2 (n-1) C30 Pbar30(sin lat), Pbar30(x) = sqrt(7) (5x^3 - 3x) / 2."""
    R, GM, C30 = 3396.0, 42828.37, 1e-6
    tab = f"{R:.16e}, {GM:.16e}, 0.0, 3, 3, 1, 0.0, 0.0\n" + "".join(
        f"{n:5d},{m:5d}, {(C30 if (n, m) == (3, 0) else 0.0):.16e}, 0.0, 0.0, 0.0\n" for n in range(1, 4) for m in range(n + 1))
    g = datasets.gravity_grid(tab, d_deg=1.0)
    lat = 90.0 - (np.arange(180) + 0.5)
    x = np.sin(np.radians(lat))
    want = GM / R ** 2 * 2 * C30 * math.sqrt(7) * (5 * x ** 3 - 3 * x) / 2 * 1e3 * 1e5
    assert np.allclose(g[:, 0], want, rtol=1e-6, atol=1e-6)
    assert np.allclose(g, g[:, :1], atol=1e-9), "a zonal term does not vary with longitude"


def test_gravity_sum_sectoral_term():
    """C22: dg = GM/R^2 (n-1) C22 Pbar22(sin lat) cos(2 lon), Pbar22 = sqrt(15)/2 cos^2 lat."""
    R, GM, C22 = 3396.0, 42828.37, 2e-6
    tab = f"{R:.16e}, {GM:.16e}, 0.0, 2, 2, 1, 0.0, 0.0\n" + "".join(
        f"{n:5d},{m:5d}, {(C22 if (n, m) == (2, 2) else 0.0):.16e}, 0.0, 0.0, 0.0\n" for n in range(1, 3) for m in range(n + 1))
    g = datasets.gravity_grid(tab, d_deg=2.0)
    lat = 90.0 - (np.arange(90) + 0.5) * 2
    lon = -180.0 + (np.arange(180) + 0.5) * 2
    LA, LO = np.meshgrid(lat, lon, indexing="ij")
    want = GM / R ** 2 * 1 * C22 * math.sqrt(15) / 2 * np.cos(np.radians(LA)) ** 2 * np.cos(2 * np.radians(LO)) * 1e8
    assert np.allclose(g, want, rtol=1e-6, atol=1e-6)


# ------------------------------------------------------------------------------------------- space weather ----

NOW = datetime(2026, 10, 28, 12, 0, tzinfo=timezone.utc)


def _doc(sims=(), seps=(), flares=()):
    # record shapes as documented for the DONKI web services (ccmc.gsfc.nasa.gov/tools/DONKI)
    return {"fetched_utc": "2026-10-28T11:00:00Z", "fetched_s": NOW.timestamp() - 3600, "data": {
        "WSAEnlilSimulations": list(sims), "SEP": list(seps), "FLR": list(flares), "CME": []}, "via": {}, "errors": {}}


def _t(hours):
    return (NOW + timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%MZ")


def test_space_weather_quiet_watch_storm(monkeypatch, tmp_path):
    monkeypatch.setitem(spaceweather.PATHS, "cache", tmp_path)
    monkeypatch.setattr(spaceweather.time, "time", lambda: NOW.timestamp())
    f = tmp_path / "spaceweather.json"
    f.write_text(json.dumps(_doc()))
    assert spaceweather.summary(NOW)["level"] == "quiet"
    sim = {"simulationID": "WSA-ENLIL/1", "modelCompletionTime": _t(-30),
           "cmeInputs": [{"cmeid": "2026-10-27T09:00:00-CME-001", "speed": 900.0}],
           "impactList": [{"isGlancingBlow": False, "location": "Mars", "arrivalTime": _t(48)},
                          {"isGlancingBlow": True, "location": "STEREO A", "arrivalTime": _t(20)}], "link": "x"}
    f.write_text(json.dumps(_doc(sims=[sim])))
    s = spaceweather.summary(NOW)
    assert s["level"] == "watch" and len(s["mars_arrivals"]) == 1 and s["mars_arrivals"][0]["hours_from_now"] == pytest.approx(48)
    sim["impactList"][0]["arrivalTime"] = _t(6)
    f.write_text(json.dumps(_doc(sims=[sim])))
    assert spaceweather.summary(NOW)["level"] == "storm"
    # a later run of the same CME replaces the earlier forecast
    late = dict(sim, simulationID="WSA-ENLIL/2", modelCompletionTime=_t(-2),
                impactList=[{"isGlancingBlow": True, "location": "Mars", "arrivalTime": _t(60)}])
    f.write_text(json.dumps(_doc(sims=[sim, late])))
    s = spaceweather.summary(NOW)
    assert len(s["mars_arrivals"]) == 1 and s["mars_arrivals"][0]["glancing"] and s["level"] == "watch"


def test_space_weather_sep_needs_magnetic_connection(monkeypatch, tmp_path):
    monkeypatch.setitem(spaceweather.PATHS, "cache", tmp_path)
    monkeypatch.setattr(spaceweather.time, "time", lambda: NOW.timestamp())
    sep = {"sepID": "x", "eventTime": _t(-10), "instruments": [{"displayName": "GOES-18: SEISS >10 MeV"}]}
    (tmp_path / "spaceweather.json").write_text(json.dumps(_doc(seps=[sep])))
    s = spaceweather.summary(NOW)
    geo = s["geometry"]["separation_deg"]
    assert s["level"] == ("storm" if geo <= 60 else "watch")


def test_space_weather_without_data_is_honest(monkeypatch, tmp_path):
    monkeypatch.setitem(spaceweather.PATHS, "cache", tmp_path)
    s = spaceweather.summary(NOW)
    assert s["ok"] and not s["have_data"] and s["level"] == "unknown"


def test_earth_mars_geometry_is_plausible():
    for d in range(0, 800, 37):
        g = spaceweather.geometry(NOW + timedelta(days=d))
        assert 0.37 < g["distance_au"] < 2.68 and 0 <= g["separation_deg"] <= 180
    js = node("""import { earthMarsLight } from './engine/marstime.js';
console.log(JSON.stringify(earthMarsLight(Date.parse('2026-10-28T12:00:00Z')).au));""")
    assert spaceweather.geometry(NOW)["distance_au"] == pytest.approx(js, abs=0.002)


# ----------------------------------------------------------------------------------- objectives, missions ----

def test_objectives_reference_real_layers_and_score_known_sites():
    ids = {L["id"] for g in atlas.catalogue()["groups"] for L in g["layers"]} | {"ice", "geology", "grs", "ti", "craters"}
    for o in science.objectives()["objectives"]:
        assert set(o["layers"]) <= ids, f"{o['id']}: unknown layers {set(o['layers']) - ids}"
        for e in o["examples"]:
            assert -90 <= e["lat"] <= 90 and -180 <= e["lon"] <= 180
        for layer, _cls, w in o.get("evidence", []):
            assert layer in features.layers() and w > 0
    # the delta where Perseverance found Cheyava Falls scores for ancient life; the dry volcanic summit does not
    assert science.evaluate("life", 77.40, 18.50)["score"] > 5 * max(0.1, science.evaluate("life", -133.8, 18.65)["score"])


def test_mission_catalogue_has_dated_status_and_sources():
    m = science.missions()
    assert m["as_of"] == "2026-10-28"
    status = {x["id"]: x["status"] for x in m["missions"]}
    assert status["maven"] == "lost" and status["escapade"] == "en route" and status["mmx"] == "en route"
    timely = ("en route", "planned", "in development", "slipped", "cancelled")
    for x in m["missions"]:
        if x["status"].startswith(timely) or "2026" in x["status"] or x["id"] == "maven":
            assert x.get("sources"), f"{x['id']}: a time-sensitive status needs a source"
        s = x.get("site")
        if s and s.get("lon") is not None:
            assert -180 <= s["lon"] <= 180 and -90 <= s["lat"] <= 90
