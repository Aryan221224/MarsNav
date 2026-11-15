"""Write science.json for every built site (app/data and app/data/sites/*): the minerals, ice and landforms within
30 km of each stop and the science objectives it serves (planet/science.py site_science). The planner shows it on
each stop; new hubs get theirs when Landing mode builds them (planet/sitegen.py).

    python tools/build_site_science.py
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from planet import science  # noqa: E402

dirs = [ROOT / "app" / "data"] + sorted(p for p in (ROOT / "app" / "data" / "sites").iterdir() if (p / "manifest.json").exists())
for d in dirs:
    sc = science.write_site_science(d)
    if sc:
        n = sum(1 for s in sc["stops"].values() if s["materials"] or s["objectives"])
        print(f"{os.path.relpath(d, ROOT)}: {len(sc['stops'])} stops, {n} with catalogued science nearby")
