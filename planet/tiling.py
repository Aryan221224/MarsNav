"""The tile pyramid: equirectangular (simple cylindrical, planetocentric, east-positive), -180..180 x -90..90, zoom 0 = two
tiles of 180 x 180 degrees. Identical to NASA Mars Trek's EQ tile matrix set, so Trek imagery tiles line up 1:1."""
from __future__ import annotations

import math

from .config import R_MARS, TILE, MAX_Z


def tile_deg(z: int) -> float:
    return 180.0 / (1 << z)


def ntiles(z: int) -> tuple[int, int]:
    """(columns, rows) at zoom z."""
    return 2 << z, 1 << z


def bounds(z: int, y: int, x: int) -> tuple[float, float, float, float]:
    """(west, south, east, north) degrees of tile (z, y, x); y counts rows down from the north pole."""
    d = tile_deg(z)
    w = -180.0 + x * d
    n = 90.0 - y * d
    return w, n - d, w + d, n


def valid(z: int, y: int, x: int) -> bool:
    c, r = ntiles(z)
    return 0 <= z <= MAX_Z and 0 <= y < r and 0 <= x < c


def wrap_x(z: int, x: int) -> int:
    return x % ntiles(z)[0]


def tile_of(lon: float, lat: float, z: int) -> tuple[int, int]:
    """(y, x) of the tile containing lon/lat."""
    d = tile_deg(z)
    c, r = ntiles(z)
    x = int(math.floor(((lon + 180.0) % 360.0) / d)) % c
    y = min(r - 1, max(0, int(math.floor((90.0 - lat) / d))))
    return y, x


def m_per_px(z: int, lat: float = 0.0, n: int = TILE) -> float:
    """Ground size of one imagery pixel at zoom z (east-west at latitude lat)."""
    return tile_deg(z) / n * math.pi / 180.0 * R_MARS * max(0.01, math.cos(math.radians(lat)))


def zoom_for_res(res_m: float, lat: float = 0.0) -> int:
    """Smallest zoom whose pixels are at least as fine as res_m."""
    for z in range(MAX_Z + 1):
        if m_per_px(z, lat) <= res_m:
            return z
    return MAX_Z


def haversine_m(lon1, lat1, lon2, lat2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_MARS * math.asin(min(1.0, math.sqrt(a)))
