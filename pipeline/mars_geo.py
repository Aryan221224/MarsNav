"""
mars_geo.py - Mars geodesy helpers shared by the whole pipeline.

Every site is worked in an equirectangular projection on the Mars 2000 IAU sphere (R = 3 396 190 m) whose standard
parallel is close to the site's latitude, so the projection is almost conformal there (scale error < 0.1 % over a
30 km operations area) and a grid cell is square on the ground: slope maths needs no correction. The standard parallel
comes from the site file (pipeline/sites/<id>.json) through set_projection(); the default is the JPL
"Jezero_Crater_Projection" (standard parallel 18.4663 deg) used by the USGS/JPL Mars 2020 science products.
(HiRISE DTMs and the TRN CTX DTM use standard parallel 0 deg; they are reprojected on read.)
"""
from __future__ import annotations

import math
from dataclasses import dataclass

R_MARS = 3_396_190.0                 # m, Mars 2000 IAU sphere (the radius the USGS products use)
LAT_TS_JEZERO = 18.4663              # deg, standard parallel of the JPL Jezero projection
G_MARS = 3.72076                     # m/s^2, NASA Mars fact sheet quotes 3.73; 3.72076 is the IAU/GM-derived value
DEG = math.pi / 180.0

# active working projection (set per site by site.load_site)
PROJ = {"name": "Jezero_Crater_Projection", "lat_ts": LAT_TS_JEZERO, "clon": 0.0}


def set_projection(lat_ts: float, name: str = "", clon: float = 0.0) -> None:
    """Working projection for a site: equirectangular, standard parallel lat_ts (near the site latitude, so cells are
    square on the ground) and central meridian clon (0 for the original sites; the site longitude for sites generated
    anywhere on Mars, so an area straddling the 180 deg meridian stays one continuous grid)."""
    PROJ["lat_ts"] = float(lat_ts)
    PROJ["clon"] = float(clon or 0.0)
    PROJ["name"] = name or (f"Mars2000_Equirectangular_latTs{lat_ts:g}" + (f"_clon{clon:g}" if clon else ""))


def crs_wkt(lat_ts: float | None = None, name: str | None = None, clon: float | None = None) -> str:
    lt = PROJ["lat_ts"] if lat_ts is None else lat_ts
    cl = (PROJ["clon"] if lat_ts is None else 0.0) if clon is None else clon
    nm = (PROJ["name"] if lat_ts is None else None) or name or f"Mars2000_Equirectangular_latTs{lt:g}"
    return ('PROJCS["%s",GEOGCS["GCS_Mars_2000_Sphere",DATUM["Mars_2000_(Sphere)",'
            'SPHEROID["Mars_2000_Sphere",3396190,0]],PRIMEM["Reference_Meridian",0],'
            'UNIT["degree",0.0174532925199433]],PROJECTION["Equirectangular"],'
            'PARAMETER["standard_parallel_1",%r],PARAMETER["central_meridian",%r],'
            'PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1]]') % (nm, lt, float(cl))


JEZERO_CRS_WKT = crs_wkt(LAT_TS_JEZERO, "Jezero_Crater_Projection", 0.0)


def kx(lat_ts: float | None = None) -> float:
    """Metres per radian of longitude in an equirectangular projection with standard parallel lat_ts."""
    return R_MARS * math.cos((PROJ["lat_ts"] if lat_ts is None else lat_ts) * DEG)


def wrap180(d):
    """Longitude difference folded into [-180, 180) (works on floats and numpy arrays)."""
    return (d + 180.0) % 360.0 - 180.0


def lonlat_to_xy(lon: float, lat: float, lat_ts: float | None = None) -> tuple[float, float]:
    cl = PROJ["clon"] if lat_ts is None else 0.0
    return kx(lat_ts) * (wrap180(lon - cl) if cl else lon) * DEG, R_MARS * lat * DEG


def xy_to_lonlat(x: float, y: float, lat_ts: float | None = None) -> tuple[float, float]:
    cl = PROJ["clon"] if lat_ts is None else 0.0
    lon = x / kx(lat_ts) / DEG
    return (wrap180(lon + cl) if cl else lon), y / R_MARS / DEG


def m_per_deg_lat() -> float:
    return R_MARS * DEG


def m_per_deg_lon(lat: float) -> float:
    return R_MARS * math.cos(lat * DEG) * DEG


def haversine_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    p1, p2 = lat1 * DEG, lat2 * DEG
    dp, dl = p2 - p1, (lon2 - lon1) * DEG
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_MARS * math.asin(math.sqrt(a))


@dataclass(frozen=True)
class Grid:
    """A north-up raster grid in the working projection. (x0, y0) is the top-left corner of cell (0, 0)."""
    x0: float
    y0: float
    res: float
    width: int
    height: int
    name: str = ""

    @property
    def transform(self):
        from affine import Affine
        return Affine(self.res, 0.0, self.x0, 0.0, -self.res, self.y0)

    @property
    def bounds(self):
        return self.x0, self.y0 - self.height * self.res, self.x0 + self.width * self.res, self.y0

    def cell_center(self, row: float, col: float) -> tuple[float, float]:
        return self.x0 + (col + 0.5) * self.res, self.y0 - (row + 0.5) * self.res

    def lonlat_of(self, row: float, col: float) -> tuple[float, float]:
        return xy_to_lonlat(*self.cell_center(row, col))

    def rowcol_of_lonlat(self, lon: float, lat: float) -> tuple[float, float]:
        x, y = lonlat_to_xy(lon, lat)
        return (self.y0 - y) / self.res - 0.5, (x - self.x0) / self.res - 0.5

    def lonlat_bounds(self):
        l, b, r, t = self.bounds
        lo0, la0 = xy_to_lonlat(l, b)
        lo1, la1 = xy_to_lonlat(r, t)
        return lo0, la0, lo1, la1

    def coarsen(self, f: int, name: str = "") -> "Grid":
        return Grid(self.x0, self.y0, self.res * f, self.width // f, self.height // f, name or f"{self.name}_x{f}")

    def to_json(self) -> dict:
        lo0, la0, lo1, la1 = self.lonlat_bounds()
        return {"name": self.name, "x0": self.x0, "y0": self.y0, "res": self.res, "width": self.width,
                "height": self.height, "crs": f"{PROJ['name']} (eqc, lat_ts={PROJ['lat_ts']}, clon={PROJ['clon']}, R=3396190 m)",
                "lat_ts": PROJ["lat_ts"], "clon": PROJ["clon"], "R": R_MARS,
                "lon_min": lo0, "lat_min": la0, "lon_max": lo1, "lat_max": la1}


def grid_from_lonlat(lon_min, lat_min, lon_max, lat_max, res, snap=20.0, snap_origin=(4329000.0, 1143420.0),
                     name="") -> Grid:
    """Grid covering a lon/lat box, with its origin snapped to a multiple of `snap` metres from snap_origin
    (the CTX DEM corner), so 20 m CTX cells map exactly onto 10 m or 20 m working cells."""
    xa, ya = lonlat_to_xy(lon_min, lat_max)
    xb, yb = lonlat_to_xy(lon_max, lat_min)
    ox, oy = snap_origin
    x0 = ox + math.floor((xa - ox) / snap) * snap
    y0 = oy - math.floor((oy - ya) / snap) * snap
    w = int(math.ceil((xb - x0) / res))
    h = int(math.ceil((y0 - yb) / res))
    # keep sizes divisible by 4 so coarse pyramid levels align
    w += (-w) % 4
    h += (-h) % 4
    return Grid(x0, y0, res, w, h, name)


# --- backward-compatible Jezero definition; sites are now defined in pipeline/sites/<id>.json (see sitecfg.py) ---
SITE = {
    "name": "Jezero Crater, Mars",
    "crater_center": (77.583, 18.383),               # lon, lat  [Wikipedia: 18 23'N 77 35'E]
    "landing_site": (77.45088572, 18.44462715),      # lon, lat  [NASA M20 waypoints feed, first localized position, sol 13]
    # Operations area: the whole Perseverance traverse (77.218-77.463 E, 18.420-18.500 N) plus margin
    "ops_area": (77.17, 18.36, 77.52, 18.56),
    # Regional area: the whole crater and rim, the extent of the JPL CTX DEM
    "regional_area": (77.00, 17.60, 78.57, 19.28),
}


if __name__ == "__main__":
    g = grid_from_lonlat(*SITE["ops_area"], res=10.0, name="ops10")
    print(g, g.lonlat_bounds())
    print("m/deg lat", m_per_deg_lat(), "m/deg lon at 18.45", m_per_deg_lon(18.45))
    # round trip
    x, y = lonlat_to_xy(77.45, 18.44)
    assert abs(xy_to_lonlat(x, y)[0] - 77.45) < 1e-12
    print("ok")
