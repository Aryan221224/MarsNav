"""
fit_meda.py - fit a diurnal x seasonal climatology to real Perseverance MEDA measurements, and validate the Mars
clock (engine/marstime.js, Mars24) against MEDA's own ancillary LMST / LTST / Ls / solar zenith angle.

Input: data_cache/meda_samples.json - produced in the browser (tools/meda_sampler.js) by range-reading the PDS
       Atmospheres Node files for every 15th sol, 48 samples per sol per file:
         DER_ANCILLARY (LMST, LTST, SOLAR_LONGITUDE_ANGLE, SOLAR_ZENITHAL_ANGLE)
         CAL_TIRS (AIR_TEMP, GROUND_TEMP), CAL_ATS (ATS_LOCAL_TEMP1-5), DER_PS (PRESSURE)
Output: app/data/environment.json (harmonic coefficients read by engine/environment.js)
        validation/results/meda_fit.json (fit quality)

Model: y(h, Ls) = sum beta_ab * f_a(Ls) * f_b(h), with f_0 = 1, f_+n = cos(n x), f_-n = sin(n x);
       seasonal harmonics a in {0, +-1 .. +-4}, diurnal harmonics b in {0, +-1, +-2, +-3}. Same encoding in JS.
"""
from __future__ import annotations

import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import mars_time  # noqa: E402

# MM_ROOT: the project folder (set by the launcher; inside the packaged exe __file__ is in a temporary folder)
ROOT = os.environ.get("MM_ROOT") or os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SRC = os.path.join(ROOT, "data_cache", "meda_samples.json")
OUT = os.path.join(ROOT, "app", "data", "environment.json")
VAL = os.path.join(ROOT, "validation", "results")
os.makedirs(VAL, exist_ok=True)

SEAS = [0, 1, -1, 2, -2, 3, -3, 4, -4]
DIUR = [0, 1, -1, 2, -2, 3, -3]
TERMS = [(a, b) for a in SEAS for b in DIUR]


def f(n, x):
    return np.ones_like(x) if n == 0 else (np.cos(n * x) if n > 0 else np.sin(-n * x))


def design(h, ls):
    H = 2 * np.pi * h / 24.0
    L = np.radians(ls)
    return np.stack([f(a, L) * f(b, H) for a, b in TERMS], axis=1)


def hms(s):
    """'0539 23:24:38' or '00540M00:00:00.126' -> (sol, hours)."""
    s = s.strip()
    if "M" in s:
        sol, t = s.split("M")
    else:
        sol, t = s.split(" ")
    hh, mm, ss = t.split(":")
    return int(sol), int(hh) + int(mm) / 60 + float(ss) / 3600


def num(x):
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def rover_elevation_by_sol():
    """Elevation (m, DEM datum) of Perseverance on each sol: nearest earlier waypoint of NASA's traverse feed, sampled
    on our blended DEM (the feed's own elevation field is missing after sol ~1700)."""
    sys.path.insert(0, os.path.dirname(__file__))
    from mars_geo import Grid
    import gzip
    man = json.load(open(os.path.join(ROOT, "app", "data", "manifest.json")))
    g = man["grids"]["ops10"]
    G = Grid(g["x0"], g["y0"], g["res"], g["width"], g["height"])
    m = man["layers"]["elev_dm"]
    z = np.frombuffer(gzip.open(os.path.join(ROOT, "app", "data", m["file"])).read(), dtype=m["dtype"]).astype(float)
    z = z.reshape(G.height, G.width) / m["scale"] - m["offset"]
    wp = json.load(open(os.path.join(ROOT, "data_cache", "m20_waypoints_enomis.json")))["waypoints"]
    out = []
    for p in wp:
        r, c = G.rowcol_of_lonlat(p["lon"], p["lat"])
        ri, ci = int(round(r)), int(round(c))
        if 0 <= ri < G.height and 0 <= ci < G.width:
            out.append((p["sol"], float(z[ri, ci])))
    out.sort()
    sols = np.array([a for a, _ in out]); el = np.array([b for _, b in out])
    return lambda s: float(el[max(0, np.searchsorted(sols, s, side="right") - 1)])


def main():
    d = json.load(open(SRC))
    elev_of = rover_elevation_by_sol()
    sols = d["sols"]
    # Ls per sol from ancillary (median), used for every variable of that sol
    rows = {"air": [], "ground": [], "pressure": [], "ats": []}
    anc = []
    for s, rec in sols.items():
        a = rec.get("anc")
        if not a or not a["rows"]:
            continue
        # NOTE: MEDA's SOLAR_LONGITUDE_ANGLE column is a local solar angle that changes through the day, not the
        # areocentric Ls; the season comes from our Mars24 clock (sol + noon LMST).
        ls_sol = mars_time.m2020_state(int(s), 12.0)["Ls"]
        for r in a["rows"]:
            try:
                sol_m, lmst = hms(r[0])
                _, ltst = hms(r[1])
            except Exception:
                continue
            if num(r[2]) is None or num(r[3]) is None:
                continue
            anc.append({"sol": sol_m, "lmst": lmst, "ltst": ltst, "solar_angle": num(r[2]), "sza": num(r[3])})

        def ingest(key, block, cols_idx, name, lo, hi):
            if not block or not block["rows"]:
                return
            for r in block["rows"]:
                try:
                    _, ltst = hms(r[1])
                except Exception:
                    continue
                vals = [num(r[i]) for i in cols_idx]
                vals = [v for v in vals if v is not None and lo < v < hi]
                if vals:
                    rows[name].append((ltst, ls_sol, float(np.mean(vals)), elev_of(int(s))))

        ingest("tirs", rec.get("tirs"), [2], "air", 120, 320)
        ingest("tirs", rec.get("tirs"), [3], "ground", 120, 330)
        ingest("ats", rec.get("ats"), [2, 3, 4], "ats", 120, 320)
        ingest("psd", rec.get("psd"), [2], "pressure", 400, 1200)
    out = {"source": "NASA PDS Atmospheres Node, Mars 2020 MEDA bundle (mars2020_meda), sampled every 15 sols",
           "terms": [list(t) for t in TERMS], "tau_typical": 0.45, "n_sols": len(sols)}
    quality = {}
    for name, key in (("air", "air"), ("ground", "ground"), ("pressure", "pressure"), ("ats", "ats")):
        arr = np.array(rows[name])
        if len(arr) < 50:
            print("not enough", name, len(arr))
            continue
        X = design(arr[:, 0], arr[:, 1])
        y = arr[:, 2]
        if name == "pressure":
            # hydrostatic: ln p = f(Ls, h) - (z - z_ref)/H ; fit H jointly (extra column) around z_ref = -2550 m
            y = np.log(y)
            X = np.hstack([X, (arr[:, 3:4] + 2550.0)])
        beta, *_ = np.linalg.lstsq(X, y, rcond=None)
        # one robust re-fit dropping > 4 sigma outliers
        r = y - X @ beta
        keep = np.abs(r) < 4 * r.std()
        beta, *_ = np.linalg.lstsq(X[keep], y[keep], rcond=None)
        r = y[keep] - X[keep] @ beta
        if name == "pressure":
            pr = np.exp(X[keep] @ beta)
            r = np.exp(y[keep]) - pr
            H = -1.0 / beta[-1]
            out["pressure_scale_height_m"] = float(H)
            out["pressure_zref_m"] = -2550.0
            out[name] = {"terms": [list(t) for t in TERMS], "beta": [float(b) for b in beta[:-1]], "log": True}
            quality[name] = {"n": int(keep.sum()), "rmse": float(np.sqrt(np.mean(r ** 2))), "scale_height_m": float(H),
                             "min": float(np.exp(y).min()), "max": float(np.exp(y).max())}
            print(f"pressure scale height fitted: {H:.0f} m")
        else:
            quality[name] = {"n": int(keep.sum()), "rmse": float(np.sqrt(np.mean(r ** 2))), "min": float(y.min()), "max": float(y.max())}
            out[name] = {"terms": [list(t) for t in TERMS], "beta": [float(b) for b in beta]}
        print(f"{name:9s} n={keep.sum():5d} rmse {quality[name]['rmse']:.2f}  range {y.min():.1f}..{y.max():.1f}")
    json.dump(out, open(OUT, "w"), indent=1)
    json.dump({"quality": quality}, open(os.path.join(VAL, "meda_fit.json"), "w"), indent=1)
    json.dump(anc, open(os.path.join(ROOT, "data_cache", "meda_ancillary.json"), "w"))
    print("ancillary samples for clock validation:", len(anc))


if __name__ == "__main__":
    main()
