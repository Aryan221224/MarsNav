"""Terrain radiation shielding: check MarsNav's model against Curiosity RAD at the Murray Buttes (sols 1455-1467).

What RAD measured (abstracts of the two papers on this stop):
  * Ehresmann et al. 2021, JGR Planets 126, e2021JE006851: parked next to butte M12, which blocked 19 % of the sky,
    the dose rate was about 4 % below the expected value (sols 1456-1467).
  * Guo et al. 2021, GRL 48, e2021GL093912: the upward "albedo" radiation from the ground is about 19 % of the total
    surface dose on flat, open terrain; at the butte, the dose change is the sky radiation it blocks minus the albedo
    radiation the butte itself sends back.

What this script does:
  1. Finds the stop in NASA's Curiosity waypoint feed (the copy in validation/data, checked point by point against the
     traverse the Mount Sharp site was built from) and the stops before and after it (the reference periods).
  2. Builds the horizon seen from the RAD instrument at each stop, in 360 directions out to 25 km: HiRISE 1 m stereo
     terrain models within 6 km (USGS Astrogeology, read remotely), the Mount Sharp site's 100 m regional elevation
     beyond, Mars curvature included.
  3. Computes the blocked share of the sky and MarsNav's dose factor (engine/shielding.js, same formula) at each stop,
     and the predicted change at M12 relative to the reference stops, next to the measured ~4 %.

The terrain read needs the network (stac.astrogeology.usgs.gov / astrogeo-ard S3). The horizons it builds are saved
in validation/results/shielding_murray_buttes.json, so tests/shielding.test.mjs re-checks the model without the network.

Run:  python validation/shielding_murray_buttes.py
"""
import gzip
import json
import math
import os
import sys

import numpy as np
from scipy import ndimage as ndi

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
R = 3396190.0                      # Mars sphere radius used by the USGS DTMs and by MarsNav (m)
DTM_BASE = "https://astrogeo-ard.s3.us-west-2.amazonaws.com/mars/mro/hirise/controlled/dtm/"
DTMS = [  # first one with valid data wins at each point
    "ESP_040770_1755_ESP_039280_1755/DTEEC_040770_1755_039280_1755_A01.tif",
    "PSP_009650_1755_PSP_009716_1755/DTEEC_009650_1755_009716_1755_U01.tif",
]
SITE = os.path.join(ROOT, "app", "data", "sites", "g_4p811s_137p384e")
WAYPOINTS = os.path.join(HERE, "data", "msl_waypoints_sols1420-1500.json")
OUT = os.path.join(HERE, "results", "shielding_murray_buttes.json")
PARK_SOLS = (1455, 1467)            # drive ended on sol 1455; next drive sol 1468 (RAD comparison: sols 1456-1467)
REF_SOLS = ((1420, 1454), (1468, 1500))
RAD_HEIGHT_M = 1.1                  # RAD sits on the rover deck, about 1.1 m above the ground [ASSUME]
NEAR_M, MID_M, FAR_M = 1500.0, 6000.0, 25000.0
N_AZ = 360

# the model (identical to engine/shielding.js; the test checks both give the same numbers)
GCR_ZENITH_EXP = 1.18               # Wimmer-Schweingruber et al. 2015, GRL 42:10557: J ~ cos^1.18(zenith angle)
ALBEDO_SHARE = 0.19                 # Guo et al. 2021, GRL 48: albedo ~19 % of the flat-terrain surface dose


def dose_factor(h_deg, n=GCR_ZENITH_EXP, a=ALBEDO_SHARE):
    s = np.sin(np.radians(np.clip(np.asarray(h_deg, float), 0, 90)))
    blocked = s.mean()
    down_lost = (s ** (n + 1)).mean()
    return {"blocked_sky": float(blocked), "down_lost": float(down_lost),
            "factor": float(1 - (1 - a) * down_lost + a * blocked)}


def read_site_regional():
    man = json.load(open(os.path.join(SITE, "manifest.json")))
    g, meta = man["grids"]["reg100"], man["layers"]["reg_elev_dm"]
    raw = np.frombuffer(gzip.open(os.path.join(SITE, meta["file"])).read(), dtype=meta["dtype"]).reshape(g["height"], g["width"])
    z = np.where(raw == 0, np.nan, raw / meta["scale"] - meta["offset"]).astype(np.float64)
    z = np.where(np.isfinite(z), z, np.nanmean(z))
    return z, g, man["projection"]


def load_stops():
    feats = json.load(open(WAYPOINTS))["features"]
    pts = [f["properties"] for f in feats]
    # authenticity: every point must be on the traverse the Mount Sharp site was built from (NASA feed, fetched by MarsNav)
    own = {(round(a, 6), round(b, 6)) for a, b in json.load(open(os.path.join(SITE, "traverse.json")))["path"]}
    bad = [p["sol"] for p in pts if (round(p["lon"], 6), round(p["lat"], 6)) not in own]
    if bad:
        sys.exit(f"waypoints not on MarsNav's NASA traverse: sols {bad}")
    park = [p for p in pts if p["sol"] == PARK_SOLS[0]]
    refs = [p for p in pts if any(lo <= p["sol"] <= hi for lo, hi in REF_SOLS)]
    return park[-1], refs


class Terrain:
    """Elevation at local east/north metres from the M12 stop: HiRISE 1 m near, HiRISE 5 m mid, site 100 m far."""

    def __init__(self, lat0, lon0):
        import rasterio
        from rasterio.windows import from_bounds
        self.lat0, self.lon0 = lat0, lon0
        self.c0 = math.cos(math.radians(lat0))
        self.x0, self.y0 = R * math.radians(lon0), R * math.radians(lat0)   # DTM frame: equirectangular, clon 0, lat_ts 0
        self.layers = []
        env = rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_MAX_RETRY="4", GDAL_HTTP_RETRY_DELAY="2")
        with env:
            for half, step in ((NEAR_M + 200, 1), (MID_M + 500, 5)):
                for p in DTMS:
                    with rasterio.open(DTM_BASE + p) as ds:
                        win = from_bounds(self.x0 - half / self.c0, self.y0 - half, self.x0 + half / self.c0, self.y0 + half, ds.transform)
                        win = win.intersection(rasterio.windows.Window(0, 0, ds.width, ds.height)).round_offsets().round_lengths()
                        shape = (max(1, int(win.height / step)), max(1, int(win.width / step)))
                        z = ds.read(1, window=win, out_shape=shape, resampling=rasterio.enums.Resampling.average).astype(np.float64)
                        z[(z < -1e4) | (z > 3e4)] = np.nan
                        t = ds.window_transform(win) * rasterio.Affine.scale(win.width / shape[1], win.height / shape[0])
                        self.layers.append({"id": p.split("/")[-1][:-4], "step": step, "z": z, "t": t,
                                            "valid": float(np.isfinite(z).mean())})
                        print(f"  read {p.split('/')[-1]} at {step} m: {shape[1]}x{shape[0]}, {100 * np.isfinite(z).mean():.0f} % valid", flush=True)
        self.reg, self.rg, proj = read_site_regional()
        self.lat_ts, self.clon = math.radians(proj["lat_ts"]), proj["clon"]
        # vertical datum check: HiRISE vs the site's regional DEM around the stop, outside the buttes (median offset)
        e, n = np.meshgrid(np.linspace(-1400, 1400, 60), np.linspace(-1400, 1400, 60))
        dh = self._hirise(e.ravel(), n.ravel(), step=5) - self._regional(e.ravel(), n.ravel())
        self.offset = float(np.nanmedian(dh))
        print(f"  HiRISE minus regional DEM around the stop: median {self.offset:+.1f} m (removed from the far field)", flush=True)

    def _hirise(self, e, n, step):
        out = np.full(e.shape, np.nan)
        for L in self.layers:
            if L["step"] != step:
                continue
            x = self.x0 + e / self.c0
            y = self.y0 + n
            col, row = ~L["t"] * (x, y)
            v = ndi.map_coordinates(L["z"], [row - 0.5, col - 0.5], order=1, mode="constant", cval=np.nan, prefilter=False)
            out = np.where(np.isfinite(out), out, v)
        return out

    def _regional(self, e, n):
        lon = self.lon0 + np.degrees(e / (R * self.c0))
        lat = self.lat0 + np.degrees(n / R)
        xs = R * math.cos(self.lat_ts) * np.radians(lon - self.clon)
        ys = R * np.radians(lat)
        g = self.rg
        col = (xs - g["x0"]) / g["res"] - 0.5
        row = (g["y0"] - ys) / g["res"] - 0.5
        return ndi.map_coordinates(self.reg, [row, col], order=1, mode="nearest")

    def elev(self, e, n):
        r = np.maximum(np.abs(e), np.abs(n))
        z = np.full(e.shape, np.nan)
        near = r <= NEAR_M
        if near.any():
            z[near] = self._hirise(e[near], n[near], 1)
        mid = np.isnan(z) & (r <= MID_M)
        if mid.any():
            z[mid] = self._hirise(e[mid], n[mid], 5)
        far = np.isnan(z)
        if far.any():
            z[far] = self._regional(e[far], n[far]) + self.offset
        return z

    def horizon(self, e0, n0, eye):
        z0 = self.elev(np.array([e0]), np.array([n0]))[0] + eye
        d = [2.0]
        while d[-1] < FAR_M:
            d.append(d[-1] * 1.02 + 1.0)
        d = np.array(d)
        az = np.radians(np.arange(N_AZ) * 360.0 / N_AZ)
        E = e0 + np.outer(np.sin(az), d)
        N = n0 + np.outer(np.cos(az), d)
        z = self.elev(E.ravel(), N.ravel()).reshape(E.shape)
        ang = np.degrees(np.arctan2(z - z0 - d * d / (2 * R), d))
        return np.nanmax(ang, axis=1), float(z0 - eye)


def local_en(lat, lon, lat0, lon0):
    return R * math.cos(math.radians(lat0)) * math.radians(lon - lon0), R * math.radians(lat - lat0)


def main():
    park, refs = load_stops()
    print(f"M12 stop: sol {park['sol']} (site {park['site']}, drive {park['drive']}) at {park['lat']:.6f}, {park['lon']:.6f}; "
          f"{len(refs)} reference stops (sols {REF_SOLS[0][0]}-{REF_SOLS[0][1]} and {REF_SOLS[1][0]}-{REF_SOLS[1][1]})", flush=True)
    T = Terrain(park["lat"], park["lon"])
    stops = []
    for p in [park] + refs:
        e, n = local_en(p["lat"], p["lon"], park["lat"], park["lon"])
        h, z = T.horizon(e, n, RAD_HEIGHT_M)
        f = dose_factor(h)
        f16 = dose_factor(h[::N_AZ // 16])           # MarsNav's own 16 sectors, one ray each
        stops.append({"sol": p["sol"], "site": p["site"], "drive": p["drive"], "lat": p["lat"], "lon": p["lon"],
                      "elev_dtm_m": round(z, 2), "elev_geoid_m": p["elev_geoid"], "park": p is park,
                      "horizon_deg": [round(float(v), 2) for v in h], **{k: round(v, 5) for k, v in f.items()},
                      "factor_16": round(f16["factor"], 5), "blocked_sky_16": round(f16["blocked_sky"], 5)})
        print(f"  sol {p['sol']:4d}{' (M12)' if p is park else '      '} blocked sky {100 * f['blocked_sky']:5.1f} %   "
              f"dose factor {f['factor']:.4f}   max horizon {np.nanmax(h):5.1f} deg", flush=True)
    m12 = stops[0]
    ref = [s for s in stops[1:]]
    f_ref = float(np.mean([s["factor"] for s in ref]))
    b_ref = float(np.mean([s["blocked_sky"] for s in ref]))
    change = m12["factor"] / f_ref - 1
    # sensitivity: exponent +-0.07 (its 1-sigma), albedo share 0.15-0.23, RAD height 0.6-1.6 m
    sens = {}
    for name, kw in (("n_lo", {"n": GCR_ZENITH_EXP - 0.07}), ("n_hi", {"n": GCR_ZENITH_EXP + 0.07}),
                     ("a_lo", {"a": 0.15}), ("a_hi", {"a": 0.23}), ("no_albedo_credit", {"a": 0.0})):
        fm = dose_factor(m12["horizon_deg"], **kw)["factor"]
        fr = float(np.mean([dose_factor(s["horizon_deg"], **kw)["factor"] for s in ref]))
        sens[name] = round(100 * (fm / fr - 1), 2)
    for eye in (0.6, 1.6):
        h, _ = T.horizon(0.0, 0.0, eye)
        sens[f"rad_height_{eye}m"] = round(100 * (dose_factor(h)["factor"] / f_ref - 1), 2)
    # 1. geometry from orbit: blocked sky in a 48 m box around the reported stop (localisation and the DTM's effective
    #    resolution are a few metres, and the butte face is that close)
    scan = []
    for de in range(-24, 25, 4):
        for dn in range(-24, 25, 4):
            h, _ = T.horizon(float(de), float(dn), RAD_HEIGHT_M)
            scan.append(dose_factor(h)["blocked_sky"])
    # 2. the dose formula at the published geometry: a wall of elevation h covering enough azimuth to block 19 % of the
    #    sky, against the reference stops' factor
    walls = []
    for hw in (20, 25, 30, 35, 40, 50, 60, 70):
        width = 0.19 / math.sin(math.radians(hw))          # share of azimuth covered
        if width > 1:
            continue
        prof = np.zeros(3600)
        prof[: int(round(width * 3600))] = hw
        fw = dose_factor(prof)["factor"]
        fw0 = dose_factor(prof, a=0.0)["factor"]
        walls.append({"wall_deg": hw, "azimuth_share": round(width, 3), "change_pct": round(100 * (fw / f_ref - 1), 2),
                      "change_pct_no_albedo": round(100 * (fw0 / float(np.mean([dose_factor(s["horizon_deg"], a=0.0)["factor"] for s in ref])) - 1), 2)})
    res = {
        "what": "Terrain radiation shielding at Curiosity's Murray Buttes stop (butte M12), MarsNav model vs RAD",
        "measured": {"source": "Ehresmann et al. 2021, JGR Planets 126, e2021JE006851 (abstract)",
                     "blocked_sky_pct": 19, "dose_change_pct": -4.0,
                     "albedo_share_source": "Guo et al. 2021, GRL 48, e2021GL093912 (abstract): albedo ~19 % of flat-terrain dose"},
        "model": {"formula": "factor = 1 - (1 - a) * mean(sin(h)^(n+1)) + a * mean(sin(h))",
                  "n": GCR_ZENITH_EXP, "a": ALBEDO_SHARE, "rad_height_m": RAD_HEIGHT_M,
                  "n_source": "Wimmer-Schweingruber et al. 2015, GRL 42:10557 (1.18 +- 0.07)"},
        "terrain": {"near": f"HiRISE 1 m within {NEAR_M:.0f} m, 5 m within {MID_M:.0f} m",
                    "dtms": [{"id": L["id"], "step_m": L["step"], "valid_frac": round(L["valid"], 3)} for L in T.layers],
                    "far": "Mount Sharp site 100 m regional DEM (CTX) to 25 km", "far_offset_m": round(T.offset, 2),
                    "azimuths": N_AZ, "curvature": True},
        "result": {"m12_blocked_sky_pct": round(100 * m12["blocked_sky"], 2), "ref_blocked_sky_pct": round(100 * b_ref, 2),
                   "m12_factor": m12["factor"], "ref_factor": round(f_ref, 5),
                   "predicted_change_pct": round(100 * change, 2),
                   "predicted_change_pct_16_sectors": round(100 * (m12["factor_16"] / float(np.mean([s["factor_16"] for s in ref])) - 1), 2),
                   "sensitivity_change_pct": sens,
                   "blocked_sky_within_24m_pct": [round(100 * min(scan), 1), round(100 * max(scan), 1)],
                   "published_geometry_walls": walls,
                   "published_geometry_change_range_pct": [max(w["change_pct"] for w in walls if 25 <= w["wall_deg"] <= 60),
                                                           min(w["change_pct"] for w in walls if 25 <= w["wall_deg"] <= 60)],
                   "published_geometry_change_range_pct_no_albedo": [max(w["change_pct_no_albedo"] for w in walls if 25 <= w["wall_deg"] <= 60),
                                                                     min(w["change_pct_no_albedo"] for w in walls if 25 <= w["wall_deg"] <= 60)]},
        "findings": [
            f"Geometry from orbit is unresolved at this stop: the HiRISE 1 m DTM gives {100 * m12['blocked_sky']:.0f} % of the "
            f"sky blocked at the reported position but {100 * min(scan):.0f} % to {100 * max(scan):.0f} % within 24 m of it, "
            "because the butte face is a few metres away and is smoothed by the DTM; the published 19 % (seen from the rover "
            "itself) is above that range. Orbital terrain therefore under-states shelter right against a cliff, the "
            "conservative direction for dose.",
            f"Dose formula at the published geometry: a wall 25-60 deg high blocking 19 % of the sky gives "
            f"{min(w['change_pct'] for w in walls if 25 <= w['wall_deg'] <= 60):.1f} % to "
            f"{max(w['change_pct'] for w in walls if 25 <= w['wall_deg'] <= 60):.1f} % against the reference stops; RAD "
            f"measured about -4 %, which corresponds to a wall about "
            f"{min(walls, key=lambda w: abs(w['change_pct'] + 4))['wall_deg']} deg high. Without the butte's own albedo the "
            f"formula would give {min(w['change_pct_no_albedo'] for w in walls if 25 <= w['wall_deg'] <= 60):.1f} % to "
            f"{max(w['change_pct_no_albedo'] for w in walls if 25 <= w['wall_deg'] <= 60):.1f} %, which overshoots at the "
            "same heights.",
        ],
        "caveats": [
            "The albedo share (19 %) was itself derived by Guo et al. from this butte, so agreement on the dose change is a "
            "consistency check of the model, not an independent test; the blocked-sky fraction is an independent check of "
            "the terrain geometry.",
            "Measured values are as stated in the papers' abstracts.",
            "RAD is a small instrument on a rover; a suited person is larger, and the rover body itself shields RAD from below.",
        ],
        "stops": stops,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(res, open(OUT, "w"), indent=1)
    print(json.dumps(res["result"], indent=1))
    print(f"wrote {os.path.relpath(OUT, ROOT)}")


if __name__ == "__main__":
    main()
