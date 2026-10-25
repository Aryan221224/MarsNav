"""Paths, limits and shared constants for the planet engine. The launcher calls configure(root) with the project folder
(important in the packaged exe, where this module's own __file__ is inside a temporary unpack folder)."""
from __future__ import annotations

import os
import threading
from pathlib import Path

R_MARS = 3396190.0            # m, Mars 2000 IAU sphere (the radius every USGS product uses)
TILE = 256                    # imagery tile size (px), same as Mars Trek
DEM_N = 257                   # elevation samples per tile side (vertex-registered, so neighbours share edges)
MAX_Z = 16                    # 0.64 m/px at the equator: HiRISE DTMs are 1 m

_lock = threading.Lock()
PATHS: dict[str, Path] = {}


def configure(root: Path | str) -> dict[str, Path]:
    with _lock:
        root = Path(root)
        if PATHS.get("root") == root:
            return PATHS
        cache = Path(os.environ.get("MM_PLANET_CACHE") or (root / "data_cache" / "planet"))
        PATHS.update({
            "root": root,
            "cache": cache,
            "tiles": cache / "tiles",
            "tiles_offline": cache / "tiles_offline",   # tiles built in Mars mode (no internet): rebuilt online later
            "base": cache / "base",          # whole-planet base datasets (MOLA MEGDR)
            "catalog": cache / "catalog",    # STAC footprints, IAU names
            "jobs": cache / "jobs",
            "app_data": root / "app" / "data",
            "pipeline": root / "pipeline",
        })
        for k in ("cache", "tiles", "base", "catalog", "jobs"):
            PATHS[k].mkdir(parents=True, exist_ok=True)
        return PATHS


def cache_limit_bytes() -> int:
    try:
        return int(float(os.environ.get("MM_TILE_CACHE_GB", "20")) * 1e9)
    except ValueError:
        return int(20e9)
