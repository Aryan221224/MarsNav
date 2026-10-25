"""
sitecfg.py - load a site definition. The software is site-agnostic: everything that is specific to a place (area,
projection, habitat, source files, mission calendar, targets, keep-out zones) lives in pipeline/sites/<id>.json.

    python pipeline/build_terrain.py --site jezero_east       (or MM_SITE=jezero_east)

Minimum for a new site: a DEM of the area (any resolution; CTX 20 m or HRSC/MOLA blend for a first look) and an ops
area. 1 m DTMs, an orthoimage, targets, keep-outs and a rover traverse are optional and add fidelity when present.
"""
from __future__ import annotations

import argparse
import json
import os

from mars_geo import set_projection

# MM_ROOT: the project folder (set by the launcher; inside the packaged exe __file__ is in a temporary folder)
ROOT = os.environ.get("MM_ROOT") or os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SITES = os.path.join(ROOT, "pipeline", "sites")
DEFAULT = "jezero"


def raw_dir() -> str:
    """Where the raw rasters live: $MM_RAW, else data_cache/raw, else a _data_raw folder next to the project files."""
    for d in (os.environ.get("MM_RAW"), os.path.join(ROOT, "data_cache", "raw"), os.path.join(ROOT, "_data_raw")):
        if d and os.path.isdir(d):
            return d
    return os.path.join(ROOT, "data_cache", "raw")


def list_sites() -> list[str]:
    return sorted(f[:-5] for f in os.listdir(SITES) if f.endswith(".json"))


def load_site(site_id: str | None = None) -> dict:
    site_id = site_id or os.environ.get("MM_SITE") or DEFAULT
    path = os.path.join(SITES, f"{site_id}.json")
    if not os.path.exists(path):
        raise SystemExit(f"unknown site '{site_id}'; available: {', '.join(list_sites())}")
    cfg = json.load(open(path))
    pr = cfg["projection"]
    set_projection(pr["lat_ts"], pr.get("name", ""), pr.get("clon", 0.0))
    cfg["raw"] = raw_dir()
    cfg["work"] = os.path.join(ROOT, "data_cache", "work", cfg["id"])
    cfg["out"] = os.path.join(ROOT, "app", "data", cfg.get("out_dir", ""))
    os.makedirs(cfg["work"], exist_ok=True)
    os.makedirs(cfg["out"], exist_ok=True)
    return cfg


def cli_site(description: str) -> dict:
    ap = argparse.ArgumentParser(description=description)
    ap.add_argument("--site", default=None, help=f"site id ({', '.join(list_sites())}); default $MM_SITE or {DEFAULT}")
    return load_site(ap.parse_args().site)
