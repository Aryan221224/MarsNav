"""Where on Mars the detailed data are: the USGS Astrogeology STAC catalogue (analysis-ready, cloud-optimised GeoTIFFs on
AWS). Footprints of every HiRISE 1 m DTM and every CTX 20 m DTM (with their orthoimages) are fetched once, cached on disk
(refreshed every two weeks) and searched locally, so finding "the best data here" is instant and works offline.
  https://stac.astrogeology.usgs.gov/api  (USGS Astrogeology Analysis Ready Data, CC0)"""
from __future__ import annotations

import json
import threading
import time

from . import net
from .config import PATHS

STAC = "https://stac.astrogeology.usgs.gov/api"
# known collection ids; discovered again at run time in case USGS renames them
KNOWN = {
    "hirise": ["mro_hirise_socet_dtms", "mro_hirise_controlled_socet_dtms"],
    "ctx": ["mro_ctx_controlled_usgs_dtms"],
}
CITATION = {
    "hirise": "HiRISE DTMs (Univ. of Arizona and partners), USGS analysis-ready COGs, STAC collection mro_hirise_socet_dtms",
    "ctx": "Laura, J.R. et al. 2023, MRO CTX DTMs and orthoimages (Ames Stereo Pipeline, controlled to MOLA), doi:10.5066/P9JKVWR3",
}
_lock = threading.Lock()
_items: dict[str, list] = {}
_status: dict[str, dict] = {}


def _norm_bbox(b):
    w, s, e, n = b[:4] if len(b) == 4 else (b[0], b[1], b[3], b[4])
    if w > 180:
        w -= 360
        e -= 360
    return [w, s, e, n]


def _pick(assets: dict, *keys):
    for k in keys:
        if k in assets:
            return assets[k].get("href")
    return None


def _compact(kind: str, f: dict) -> dict | None:
    a = f.get("assets", {})
    # HiRISE items call the elevation "dtm"; CTX items "geoid_adjusted_dem" (heights above the areoid, like MOLA) or "dem"
    dtm = _pick(a, "dtm", "geoid_adjusted_dem", "dem")
    if not dtm:
        return None
    if kind == "hirise":
        ortho = next((v.get("href") for k, v in sorted(a.items()) if k.startswith("ortho_") and "thumbnail" not in k and "label" not in k
                      and str(v.get("href", "")).lower().endswith(".tif")), None)
    else:
        ortho = _pick(a, "orthoimage")
    p = f.get("properties", {})
    return {"id": f.get("id"), "bbox": _norm_bbox(f.get("bbox") or [0, 0, 0, 0]), "dtm": dtm, "ortho": ortho,
            "gsd": p.get("gsd") or (1.0 if kind == "hirise" else 20.0), "date": p.get("datetime") or p.get("start_datetime")}


def _discover() -> dict:
    ids = {k: list(v) for k, v in KNOWN.items()}
    try:
        cols = net.get_json(f"{STAC}/collections", timeout=20).get("collections", [])
        for c in cols:
            cid = c.get("id", "")
            low = cid.lower()
            if "test" in low:
                continue
            if "hirise" in low and "dtm" in low and cid not in ids["hirise"]:
                ids["hirise"].insert(0, cid)
            if "ctx" in low and "dtm" in low and cid not in ids["ctx"]:
                ids["ctx"].insert(0, cid)
    except Exception:  # noqa: BLE001 - offline: use the known ids
        pass
    return ids


def _no_retry_offline(e):
    return isinstance(e, net.Offline)


def _fetch(kind: str, progress=None) -> list:
    ids = _discover()
    for cid in ids[kind]:
        # the HiRISE collection returns HTTP 502 for pages of 500; 250 works for every collection (CTX has ~45,000 items)
        url = f"{STAC}/collections/{cid}/items?limit=250"
        items, pages = [], 0
        complete = False
        try:
            while url and pages < 400:
                page = None
                for attempt in range(5):          # the USGS API returns the odd 502 / timeout: retry the page
                    try:
                        page = net.get_json(url, timeout=60)
                        break
                    except Exception as e:  # noqa: BLE001
                        if attempt == 4 or _no_retry_offline(e):
                            raise
                        time.sleep(2 + 3 * attempt)
                for f in page.get("features", []):
                    c = _compact(kind, f)
                    if c:
                        items.append(c)
                pages += 1
                if progress:
                    progress(len(items))
                url = next((l["href"] for l in page.get("links", []) if l.get("rel") == "next"), None)
            complete = url is None
        except Exception as e:  # noqa: BLE001
            if not items:
                _status[kind] = {"error": str(e), "collection": cid}
                continue
        if items:
            _complete[kind] = complete
            return items
    return []


_complete: dict[str, bool] = {}


_fetching: dict[str, threading.Event] = {}


def load(kind: str, refresh_days: float = 14, progress=None, wait: bool = False) -> list:
    """Footprints of one catalogue. The first download (CTX: ~45,000 items, a few minutes) runs once, in the background:
    callers that do not wait get what is on disk (or nothing yet) instead of stalling a map tile."""
    with _lock:
        if kind in _items:
            return _items[kind]
        ev = _fetching.get(kind)
        mine = ev is None
        if mine:
            ev = _fetching[kind] = threading.Event()
    if not mine:
        if wait:
            ev.wait(900)
            return _items.get(kind, [])
        return _partial.get(kind, [])
    if wait:
        return _load(kind, refresh_days, progress, ev)
    threading.Thread(target=_load, args=(kind, refresh_days, progress, ev), daemon=True).start()
    ev.wait(0.5)
    return _items.get(kind) or _partial.get(kind, [])


_partial: dict[str, list] = {}


def _load(kind, refresh_days, progress, ev) -> list:
    try:
        return _load_inner(kind, refresh_days, progress)
    finally:
        ev.set()


def _load_inner(kind: str, refresh_days: float = 14, progress=None) -> list:
    path = PATHS["catalog"] / f"stac_{kind}.json"
    cached = None
    if path.exists():
        try:
            cached = json.loads(path.read_text())
        except (OSError, ValueError):
            cached = None
    fresh = cached and cached.get("complete", True) is not False and time.time() - cached.get("t", 0) < refresh_days * 86400
    if cached and net.blocked():
        fresh = True                 # Mars mode / no internet: the copy on disk is the catalogue
    items = cached["items"] if cached else []
    _partial[kind] = items          # a stale copy serves requests while the fresh one downloads
    if not fresh:
        try:
            got = _fetch(kind, progress)
            if got:
                items = got
                # a partial download (a page kept failing) is kept, and completed on the next start
                path.write_text(json.dumps({"t": time.time(), "complete": _complete.get(kind, True), "items": items}))
        except Exception as e:  # noqa: BLE001
            _status[kind] = {"error": str(e)}
    with _lock:
        _items[kind] = items
        _status[kind] = {**_status.get(kind, {}), "count": len(items), "cached": bool(cached), "fresh": bool(fresh)}
    return items


def query(kind: str, w: float, s: float, e: float, n: float, limit: int = 12) -> list:
    """Items whose footprint box overlaps (w, s, e, n), finest first, then newest."""
    out = []
    for it in load(kind):
        bw, bs, be, bn = it["bbox"]
        if be < w or bw > e or bn < s or bs > n:
            continue
        out.append(it)
    out.sort(key=lambda it: (it.get("gsd") or 99, -(len(it.get("date") or ""))))
    return out[:limit]


def coverage(w: float, s: float, e: float, n: float, limit: int = 400) -> dict:
    """Footprints inside a box, for drawing where the detailed data are."""
    return {k: [{"id": it["id"], "bbox": it["bbox"]} for it in query(k, w, s, e, n, limit)] for k in ("hirise", "ctx")}


def status() -> dict:
    return {k: dict(v) for k, v in _status.items()}


def ready(kind: str) -> bool:
    """True once the full footprint catalogue of this kind is in memory."""
    return kind in _items
