"""HTTP API of the planet engine, called by the launcher's request handler.

GET  /api/planet/status                     data sources, cache, online state
GET  /tiles/dem/{z}/{y}/{x}.mmd             elevation tile (MMD1, gzip)
GET  /tiles/img/{z}/{y}/{x}.jpg?layer=best  imagery tile (best | viking | mola)
GET  /api/point?lon=&lat=                   elevation, slope, data sources, nearest named features
GET  /api/search?q=                         IAU named features
GET  /api/coverage?w=&s=&e=&n=              footprints of HiRISE / CTX DTMs in a box
GET  /api/landing?lon=&lat=&lander=&az=     global landing-site screen (ellipse + engineering constraints)
POST /api/route   {points: [[lon,lat],...], mode}        -> job
POST /api/site    {lon, lat, km, lander, name}           -> job (builds a full EVA site)
POST /api/precache {w, s, e, n, zmax, layers}            -> job (download an area for offline use)
GET  /api/job/{id}?since=n                  job status and log
GET  /api/sites                             every built site (app/data/sites.json)
GET  /api/candidates                        NASA Exploration Zones (2015), Starship candidates, heritage landers, hubs
GET  /api/assess?lon=&lat=&lander=&az=&crit= hub-site dossier with go / caution / no-go criteria (planet/assess.py)
POST /api/screen  {points: [[lon,lat,id]], crit} quick screen of many candidates from the global data
GET  /api/datasets                          science layers (SWIM ice, TES thermal inertia, GRS water, craters)
POST /api/datasets/install {ids}            -> job (download and convert them, once)
GET  /api/legend?ovl=                       legend of a map overlay
GET  /api/local/status                      Local mode: packs on this computer, Mars mode, download progress, proof counters
POST /api/local/estimate {plan}             sizes of a Local mode plan against the free disk
POST /api/local/install  {plan}             -> job (download it all, resumable)
POST /api/local/cancel                      stop the running download (what is done is kept)
POST /api/local/mode     {offline: bool}    Mars mode on / off (on: nothing is sent to the internet)
GET  /tiles/img/{z}/{y}/{x}.jpg?layer=&ovl= base imagery + overlays (planet/imagery.py)"""
from __future__ import annotations

import json
import math
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import catalog, config, jobs, megdr, net, names, tilecache

JSON = {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}
_started = [False]


def _clean(o):
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if hasattr(o, "item") and not isinstance(o, (str, bytes)):
        try:
            return _clean(o.item())
        except Exception:  # noqa: BLE001
            return str(o)
    return o


def _ok(obj, status=200):
    return status, dict(JSON), json.dumps(_clean(obj), allow_nan=False).encode()


def _err(msg, status=400):
    return _ok({"ok": False, "error": msg}, status)


def _warmup():
    """First request: fetch the whole-planet base and the catalogues in the background (the globe works meanwhile)."""
    if _started[0]:
        return
    _started[0] = True

    def go(log=print):
        log("downloading the MOLA 16 ppd whole-planet elevation (33 MB, once)")
        megdr.ensure(megdr.G16, progress=lambda d, t: None)
        log("MOLA base ready")
        names.load()
        log(f"IAU names: {names.status()}")
        from . import dem
        log(f"HRSC-MOLA blend streaming: {dem.blend_usable()} {dem._blend_state.get('why') or ''}")
        for k in ("hirise", "ctx"):
            log(f"STAC {k} DTM footprints: downloading the catalogue (once; CTX takes a few minutes)")
            n = len(catalog.load(k, wait=True))
            log(f"STAC {k} DTM footprints: {n}")
        return {"ok": True}
    _warm_job[0] = jobs.start("warmup", go)


_warm_job = [None]


def startup(root: Path) -> None:
    """Called once by the server right after it starts (not on the first request): whole-planet base data and catalogues
    in the background, and the first raster worker, so the first map tiles do not wait for them."""
    config.configure(root)
    _warmup()
    from . import workers
    if workers.enabled():
        import threading
        threading.Thread(target=lambda: workers.pool().warm(1), daemon=True, name="workers-warm").start()


def handle(method: str, raw_path: str, body: bytes, root: Path, client_gone=None):
    """One API request. client_gone() tells whether the browser has already closed the connection (a panned-away tile):
    waiting for a raster worker then stops at once. Map tiles get a time budget for remote reads."""
    from . import workers
    config.configure(root)
    _warmup()
    u = urlparse(raw_path)
    p = u.path
    q = {k: v[-1] for k, v in parse_qs(u.query).items()}
    try:
        if p.startswith("/tiles/"):
            with workers.request(budget=25, cancel=client_gone):
                return _tile(p, q)
        if p == "/api/planet/status":
            from . import dem
            st = {"ok": True, "online": net.online(), "net": net.status(), "megdr": megdr.status(), "catalog": catalog.status(),
                  "names": names.status(), "blend": {"usable": dem._blend_state.get("ok"), "why": dem._blend_state.get("why")},
                  "cache": tilecache.stats(), "warmup": jobs.get(_warm_job[0]) if _warm_job[0] else None, "jobs": jobs.running(),
                  "workers": workers.status(), "server": _server_info(),
                  "datasets": {k: v["installed"] for k, v in __import__("planet.datasets", fromlist=["status"]).status().items()},
                  "local": {"offline": __import__("planet.localmode", fromlist=["offline"]).offline()}}
            return _ok(st)
        if p == "/api/point":
            from . import dem
            lon, lat = float(q["lon"]), float(q["lat"])
            z = int(q.get("z", 12))
            with workers.request(budget=40, cancel=client_gone):
                r = dem.point(lon, lat, z)
            r["names"] = names.nearest(lon, lat, k=3)
            return _ok({"ok": True, **r})
        if p == "/api/search":
            return _ok({"ok": True, "results": names.search(q.get("q", ""), int(q.get("limit", 20)))})
        if p == "/api/coverage":
            w, s, e, n = (float(q[k]) for k in ("w", "s", "e", "n"))
            return _ok({"ok": True, **catalog.coverage(w, s, e, n)})
        if p == "/api/landing":
            from . import landing
            with workers.request(budget=60, cancel=client_gone):
                return _ok(landing.assess(float(q["lon"]), float(q["lat"]), q.get("lander", "m2020"), float(q.get("az", 90))))
        if p == "/api/candidates":
            from . import assess
            c = assess.candidates()
            f = config.PATHS["app_data"] / "sites.json"
            hubs = []
            try:
                for st in json.loads(f.read_text()) if f.exists() else []:
                    try:
                        cfg = json.loads((config.PATHS["pipeline"] / "sites" / f"{st['id']}.json").read_text())
                        w, so, e, n = cfg["ops_area"]
                        hubs.append({"id": st["id"], "name": st.get("name"), "lon": (w + e) / 2, "lat": (so + n) / 2,
                                     "protected": st["id"] in PROTECTED_SITES})
                    except (OSError, ValueError, KeyError, TypeError):
                        pass
            except (OSError, ValueError):
                pass
            return _ok({"ok": True, **c, "hubs": hubs})
        if p == "/api/datasets":
            from . import datasets
            return _ok({"ok": True, "datasets": datasets.status()})
        if p == "/api/legend":
            from . import datasets
            ov = q.get("ovl", "")
            if ov.startswith("safety"):
                from . import safety
                return _ok({"ok": True, "legend": {"title": "Landing safety", "classes": safety.LEGEND}})
            return _ok({"ok": True, "legend": datasets.legend(ov)})
        if p == "/api/assess":
            from . import assess
            with workers.request(budget=75, cancel=client_gone):
                return _ok(assess.dossier(float(q["lon"]), float(q["lat"]), q.get("lander", "human"), float(q.get("az", 90)),
                                          q.get("crit", "hls2")))
        if p == "/api/local/status":
            from . import localmode
            return _ok(localmode.status())
        if p == "/api/geology":
            from . import datasets
            return _ok({"ok": True, "geology": datasets.geology_at(float(q["lon"]), float(q["lat"]))})
        if p == "/api/safety/legend":
            from . import safety
            return _ok({"ok": True, "legend": safety.LEGEND, "limits": safety.LIMITS})
        if p == "/api/sites":
            f = config.PATHS["app_data"] / "sites.json"
            sites = json.loads(f.read_text()) if f.exists() else []
            for s in sites:     # where each site is, for the globe (centre of its operations area)
                try:
                    cfg = json.loads((config.PATHS["pipeline"] / "sites" / f"{s['id']}.json").read_text())
                    w, so, e, n = cfg["ops_area"]
                    s["center"] = {"lon": (w + e) / 2, "lat": (so + n) / 2}
                    s["ops_area"] = cfg["ops_area"]
                except (OSError, ValueError, KeyError, TypeError):
                    pass
            return _ok({"ok": True, "sites": sites})
        if p.startswith("/api/job/"):
            j = jobs.get(p.rsplit("/", 1)[-1], int(q.get("since", 0)))
            return _ok({"ok": True, **j}) if j else _err("no such job", 404)
        if method == "POST":
            data = json.loads(body.decode() or "{}")
            if p == "/api/route":
                pts = [[float(a), float(b)] for a, b in data["points"]]
                if len(pts) < 2:
                    return _err("need at least two points")
                # its own process: a planet-scale route builds graphs of up to ~1.6 million cells (hundreds of MB)
                return _ok({"ok": True, "job": jobs.start_process("route", "planet.router:route", pts, str(data.get("mode", "crewed_rover")))})
            if p == "/api/site":
                hub = data.get("hub")
                return _ok({"ok": True, "job": jobs.start_process("site", "planet.sitegen:build", float(data["lon"]), float(data["lat"]),
                                                                  float(data.get("km", 10)), data.get("lander", "human"), data.get("name"),
                                                                  hub=[float(hub[0]), float(hub[1])] if hub else None)})
            if p == "/api/screen":
                from . import assess
                pts = [[float(a[0]), float(a[1]), str(a[2]) if len(a) > 2 else ""] for a in data.get("points", [])][:400]
                return _ok({"ok": True, "results": assess.screen(pts, str(data.get("crit", "hls2")))})
            if p == "/api/datasets/install":
                ids = [str(i) for i in data.get("ids") or []] or None
                return _ok({"ok": True, "job": jobs.start_process("datasets", "planet.datasets:install", ids)})
            if p == "/api/local/estimate":
                from . import localmode
                return _ok(localmode.estimate(data.get("plan") or {}))
            if p == "/api/local/install":
                for j in jobs.running():
                    if j["kind"] == "local":
                        return _ok({"ok": True, "job": j["id"], "already": True})
                return _ok({"ok": True, "job": jobs.start_process("local", "planet.localmode:install", data.get("plan") or {})})
            if p == "/api/local/cancel":
                from . import localmode
                return _ok(localmode.request_cancel())
            if p == "/api/local/mode":
                from . import localmode
                return _ok({"ok": True, **localmode.set_offline(bool(data.get("offline")))})
            if p == "/api/site/delete":
                return _ok(delete_site(str(data.get("id", ""))))
            if p == "/api/rebuild":
                return _ok({"ok": True, "job": jobs.start_process("rebuild", "planet.api:rebuild_site", str(data.get("site", "jezero")),
                                                                  bool(data.get("optional", True)))})
            if p == "/api/precache":
                return _ok({"ok": True, "job": jobs.start_process("precache", "planet.api:precache", float(data["w"]), float(data["s"]),
                                                                  float(data["e"]), float(data["n"]), int(data.get("zmax", 10)),
                                                                  list(data.get("layers", ["best"])))})
        return _err(f"unknown endpoint {p}", 404)
    except KeyError as e:
        return _err(f"missing parameter {e}")
    except ValueError as e:
        return _err(str(e))


def _server_info() -> dict:
    """What the launcher knows about this server process (threads, queue, memory, workers), if it tells us."""
    fn = getattr(__import__("sys"), "_martian_map_server_info", None)
    try:
        return fn() if fn else {}
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


def _tile_cache(final: bool) -> dict:
    # a provisional tile (better data still downloading) must not stick in the browser: the globe asks again later
    return {"Cache-Control": "public, max-age=86400"} if final else {"Cache-Control": "no-store", "X-MM-Provisional": "1"}


def _tile(p: str, q: dict):
    parts = p.strip("/").split("/")          # tiles/dem/z/y/x.ext
    if len(parts) != 5:
        return _err("bad tile path", 404)
    _t, kind, z, y, xe = parts
    x = xe.split(".")[0]
    z, y, x = int(z), int(y), int(x)
    from .tiling import valid, wrap_x
    x = wrap_x(z, x)
    if not valid(z, y, x):
        return _err("tile out of range", 404)
    if kind == "dem":
        from . import dem
        data, final = dem.tile_bytes_ex(z, y, x)
        return 200, {"Content-Type": "application/octet-stream", "Content-Encoding": "gzip", **_tile_cache(final)}, data
    if kind == "img":
        from . import imagery
        layer = q.get("layer", "best")
        if layer == "safety":
            layer = f"safety_{q.get('lander', 'human')}"
        data, final = imagery.tile_bytes_ex(z, y, x, layer, q.get("ovl", ""))
        return 200, {"Content-Type": "image/jpeg", **_tile_cache(final)}, data
    return _err("unknown tile kind", 404)


def precache(w, s, e, n, zmax=10, layers=("best",), log=print):
    """Download every tile of an area up to zmax (elevation + imagery), for use with no network (like a flight
    simulator's manual cache)."""
    from . import dem, imagery
    from .tiling import tile_of
    zmax = min(14, max(0, zmax))
    total = 0
    plan = []
    for z in range(0, zmax + 1):
        y0, x0 = tile_of(w, n, z)
        y1, x1 = tile_of(e, s, z)
        for ty in range(y0, y1 + 1):
            for tx in range(x0, x1 + 1):
                plan.append((z, ty, tx))
    if len(plan) > 20000:
        raise ValueError(f"{len(plan)} tiles: choose a smaller area or a lower zoom")
    log(f"{len(plan)} tiles to fetch (zoom 0-{zmax})")
    t0 = time.time()
    for k, (z, ty, tx) in enumerate(plan):
        dem.tile_bytes(z, ty, tx)
        for L in layers:
            imagery.tile_bytes(z, ty, tx, L)
        total += 1
        if k % 25 == 0:
            log(f"{k + 1}/{len(plan)} tiles, {time.time() - t0:.0f} s")
    return {"ok": True, "tiles": total, "seconds": round(time.time() - t0, 1)}


def rebuild_site(site_id: str, optional: bool = True, log=print):
    """Rebuild one site's data from the raw rasters (fetch -> terrain -> layers -> [MEDA fit for Jezero] -> imagery),
    including the optional HiRISE DTMs when asked (Jezero N, E, DL). Files already in data_cache/raw are used as they are."""
    import os
    import sys
    root = config.PATHS["root"]
    pdir = str(config.PATHS["pipeline"])
    if pdir not in sys.path:
        sys.path.insert(0, pdir)
    os.environ["MM_ROOT"] = str(root)
    import fetch_data
    import sitecfg
    import build_terrain
    import build_layers
    import build_imagery
    old = sys.argv
    try:
        sys.argv = ["fetch_data"] + (["--optional"] if optional else [])
        log("fetching / verifying the raw sources (files already in data_cache/raw are kept)")
        rc = fetch_data.main()
        if rc:
            log(f"fetch_data reported {rc} problem(s); building with what is available")
    finally:
        sys.argv = old
    site = sitecfg.load_site(site_id)
    log(f"build_terrain {site_id}")
    build_terrain.main(site)
    log(f"build_layers {site_id}")
    build_layers.main(sitecfg.load_site(site_id))
    if site_id == "jezero":
        import fit_meda
        log("fit_meda (Jezero weather)")
        fit_meda.main()
        build_layers.main(sitecfg.load_site(site_id))
    log(f"build_imagery {site_id}")
    build_imagery.main(sitecfg.load_site(site_id))
    used = [h["key"] for h in sitecfg.load_site(site_id)["sources"].get("hires_dtms", [])
            if os.path.exists(os.path.join(sitecfg.raw_dir(), h["file"]))]
    log(f"done: HiRISE DTMs used: {', '.join(used)}")
    return {"ok": True, "site": site_id, "hirise_used": used}


PROTECTED_SITES = {"jezero", "jezero_east"}


def delete_site(site_id: str) -> dict:
    """Delete a site made from Planet mode ("g_..."): its site file, built data and raw downloads. The shipped Jezero
    sites can never be deleted this way."""
    import re
    import shutil
    if site_id in PROTECTED_SITES or not re.fullmatch(r"g_[0-9a-z_]+", site_id or ""):
        raise ValueError("only sites created in Planet mode can be deleted")
    root = config.PATHS["root"]
    removed = []
    cfg_f = config.PATHS["pipeline"] / "sites" / f"{site_id}.json"
    out_dir = config.PATHS["app_data"] / "sites" / site_id
    try:
        cfg = json.loads(cfg_f.read_text())
        od = (cfg.get("out_dir") or "").replace("\\", "/")
        if od == f"sites/{site_id}":
            out_dir = config.PATHS["app_data"] / od
    except (OSError, ValueError):
        pass
    raws = [root / "data_cache" / "raw" / "gen" / site_id, root / "_data_raw" / "gen" / site_id]
    for d in [out_dir] + raws:
        if d.is_dir() and site_id in d.parts:
            shutil.rmtree(d, ignore_errors=True)
            removed.append(str(d.relative_to(root)))
    if cfg_f.exists():
        cfg_f.unlink()
        removed.append(str(cfg_f.relative_to(root)))
    idx = config.PATHS["app_data"] / "sites.json"
    try:
        sites = json.loads(idx.read_text())
        idx.write_text(json.dumps([x for x in sites if x.get("id") != site_id], indent=1))
    except (OSError, ValueError):
        pass
    if not removed:
        raise ValueError(f"no site {site_id}")
    return {"ok": True, "id": site_id, "removed": removed}
