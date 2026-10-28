"""Give a generated EVA site its rover context: the rover's real traverse, the places it worked (as stations, at the
rover's own localised position on the sol it worked there), a keep-out around the active rover, and the rover's mission
clock. Then the planning layers are rebuilt so the stations and keep-outs are in the site.

  python tools/add_rover_context.py --site g_4p811s_137p384e --rover msl

Positions come from the NASA/JPL waypoint feed (mars.nasa.gov/mmgis-maps/<rover>/Layers/json/<rover>_waypoints.json); the
named stops and their sols from NASA's mission blog, cited per stop."""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ROVERS = {
    "msl": {"feed": "https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json", "name": "Curiosity",
            "clock": {"name": "MSL", "landing_utc": "2012-08-06T05:17:57Z", "lon_east": 137.4416,
                      "note": "Mars Science Laboratory sols (sol 0 = landing day) at Bradbury Landing"}},
}
# Curiosity's boxwork campaign on Mount Sharp (NASA Curiosity mission blog, science.nasa.gov/blog)
STOPS = {
    "msl": [
        {"id": "ALTA", "sol": 4568, "name": "Altadena (first boxwork drill)", "value": 0.8, "dwell_min": 45,
         "why": "Edge of the boxwork unit; drill target chosen sol 4560, hole and tailings imaged sols 4568-4569 (June 2025): "
                "the end of the campaign's first phase (sols 4534-4570).",
         "source": "NASA Curiosity blog, sols 4568-4569 'A Close Look at the Altadena Drill Hole and Tailings'"},
        {"id": "MGRD", "sol": 4712, "name": "Monte Grande hollow: Valle de la Luna and Nevado Sajama drills", "value": 0.9, "dwell_min": 60,
         "why": "A drilled pair: 'Valle de la Luna' in the floor of the large hollow 'Monte Grande' and 'Nevado Sajama' on the ridge beside it, "
                "to compare the ridge-forming rock with the hollow floor.",
         "source": "NASA Curiosity blog, sols 4709-4715 'Drilling High and Low in the Boxwork Unit'"},
        {"id": "CAMP", "sol": 4897, "name": "Campo Marte drill and the Atacama block (sulfate unit)", "value": 0.7, "dwell_min": 45,
         "why": "The layered sulfate unit above the boxwork: 'Atacama' lifted out of the ground on the drill (April 2026); Curiosity's "
                "47th drill hole 'Campo Marte' beside it, first imaged in colour on sol 4897.",
         "source": "NASA Curiosity blog, sols 4893-4899 'Drilling at Campo Marte' and sols 4908-4912"},
    ],
}


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "MarsNav add_rover_context (NASA Space Apps 2026)"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", required=True)
    ap.add_argument("--rover", default="msl", choices=sorted(ROVERS))
    ap.add_argument("--no-rebuild", action="store_true", help="only write the site files, do not rebuild the planning layers")
    ap.add_argument("--camp-sol", type=int, default=None,
                    help="put the hub at the rover's position on this sol: a forward camp (pressurised rover) where the crew "
                         "cannot land, as on Mount Sharp's cliff-bounded foothills")
    a = ap.parse_args()
    R = ROVERS[a.rover]
    cfg_path = ROOT / "pipeline" / "sites" / f"{a.site}.json"
    cfg = json.loads(cfg_path.read_text())
    feed = get_json(R["feed"])
    fixes = sorted((f["properties"] for f in feed["features"] if f["properties"].get("lon") is not None), key=lambda p: (p["sol"], p.get("drive", 0)))
    w, s, e, n = cfg["regional_area"]
    inside = [p for p in fixes if w <= p["lon"] <= e and s <= p["lat"] <= n]
    # traverse: every localisation inside the regional area, as the planner's traverse layer
    out_dir = ROOT / "app" / "data" / cfg["out_dir"]
    trav = {"source": f"NASA/JPL {R['name']} waypoint feed ({R['feed']})", "rover": R["name"],
            "firstSol": inside[0]["sol"], "lastSol": inside[-1]["sol"], "dist_total_m": inside[-1].get("dist_total_m"),
            "path": [[round(p["lon"], 6), round(p["lat"], 6)] for p in inside]}
    (out_dir / "traverse.json").write_text(json.dumps(trav, separators=(",", ":")))
    print(f"traverse: {len(inside)} localisations, sols {trav['firstSol']}-{trav['lastSol']}")

    def at_sol(sol):
        best = [p for p in fixes if p["sol"] <= sol]
        return best[-1] if best else fixes[0]

    keep = [t for t in cfg.get("targets", []) if not t.get("rover_stop")]
    for st in STOPS.get(a.rover, []):
        p = at_sol(st["sol"])
        keep.append({"id": st["id"], "name": st["name"], "kind": "science", "lon": round(p["lon"], 7), "lat": round(p["lat"], 7),
                     "value": st["value"], "dwell_min": st["dwell_min"], "sigma_m": 30, "why": st["why"],
                     "source": f"{st['source']}; position: {R['name']} localisation on sol {p['sol']} (site {p.get('site')}, drive {p.get('drive')})",
                     "rover_stop": True, "sol": p["sol"]})
        print(f"  {st['id']}: sol {p['sol']} at {p['lon']:.5f}, {p['lat']:.5f}")
    cfg["targets"] = keep
    last = fixes[-1]
    ko = [k for k in cfg.get("keepouts", []) if k.get("id") != "ROVER"]
    if w <= last["lon"] <= e and s <= last["lat"] <= n:
        ko.append({"id": "ROVER", "name": f"{R['name']} rover (active asset)", "flag": 1, "radius_m": 50,
                   "points": [[round(last["lon"], 7), round(last["lat"], 7)]],
                   "why": "Do not approach an active rover closer than 50 m [ASSUME].", "source": f"{R['name']} waypoint feed sol {last['sol']}"})
    cfg["keepouts"] = ko
    if a.camp_sol is not None:
        p = at_sol(a.camp_sol)
        cfg["base"] = {"id": "HAB", "name": f"Forward camp: pressurised rover at {R['name']}'s sol {p['sol']} stop",
                       "lon": round(p["lon"], 7), "lat": round(p["lat"], 7),
                       "why": f"Ground {R['name']} parked on (sol {p['sol']}). The foothills are cliff-bounded and no place for a lander: "
                              "the crew lands on the crater floor and drives up; the pressurised rover is the hub for these EVAs.",
                       "source": f"{R['name']} waypoint feed, sol {p['sol']} (site {p.get('site')}, drive {p.get('drive')})"}
        print(f"  hub: forward camp at sol {p['sol']} ({p['lon']:.5f}, {p['lat']:.5f})")
    cfg["clock"] = R["clock"]
    cfg["rover_context"] = {"rover": R["name"], "feed": R["feed"], "last_sol": last["sol"]}
    cfg_path.write_text(json.dumps(cfg, indent=1))
    print(f"site file updated: {len(keep)} targets, {len(ko)} keep-outs, clock {R['clock']['name']}")
    if a.no_rebuild:
        return 0
    sys.path.insert(0, str(ROOT / "pipeline"))
    os.environ["MM_ROOT"] = str(ROOT)
    import build_layers
    import sitecfg
    build_layers.main(sitecfg.load_site(a.site))
    # the site list in the app: the clock and the description
    idx = ROOT / "app" / "data" / "sites.json"
    sites = json.loads(idx.read_text())
    for x in sites:
        if x["id"] == a.site:
            x["clock"] = R["clock"]["name"]
    idx.write_text(json.dumps(sites, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
