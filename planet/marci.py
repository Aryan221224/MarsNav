"""MRO MARCI Mars Daily Global Maps on the globe: the planet's weather on a chosen sol of Mars years 28-32.

What: one colour mosaic of the whole of Mars per sol (0.1 deg, 3600 x 1800, from 13 MARCI swaths taken around 3 pm
local time): dust storms, water-ice clouds and the polar hoods as the orbiter saw them. Version 1 MDGMs (Wang &
Richardson 2015, Icarus 251; Wang & Wheeler, Harvard Dataverse doi:10.7910/DVN/G2VENZ, CC0; images NASA/JPL-Caltech/
MSSS). The maps are stretched for seeing storms and clouds, not calibrated reflectance.

How: planet/data/marci_v1_index.json (tools/build_marci_index.py) lists every daily map with its Mars year and solar
longitude, so a date is resolved without downloading anything. The first time a map of a subphase is wanted, that
subphase's tar (about 15 MB, ~30 sols) is downloaded from Dataverse in the background and unpacked into
data_cache/planet/marci/<sub>/; until it is there, tiles are served provisional (the globe asks again). Then every map of
that month is local, and tiles are cut from it like any other base layer.

Base layer ids (planet/imagery.py): marci-<sub>-<day>, e.g. marci-B01-05."""
from __future__ import annotations

import io
import json
import re
import tarfile
import threading
from collections import OrderedDict

import numpy as np

from . import config, net

LAYER_RE = re.compile(r"^marci-([A-Z]\d{2})-(\d{1,2})$")
MIN_COVERAGE = 0.6              # a sol with less of 60 S - 60 N mapped (orbits lost) is used only if no better one is near
_lock = threading.Lock()
_index: dict = {}
_fetching: dict = {}            # sub -> {"done", "total", "error"}
_imgs: OrderedDict = OrderedDict()   # (sub, day) -> uint8 (1800, 3600, 3), a few kept in memory
MAX_IMGS = 4


def index() -> dict:
    from pathlib import Path
    with _lock:
        if not _index:
            # the install folder first (the packaged app runs these modules from its runtime folder), then next to this file
            for d in (config.PATHS.get("root", Path(".")) / "planet" / "data", Path(__file__).parent / "data"):
                p = d / "marci_v1_index.json"
                if p.exists():
                    _index.update(json.loads(p.read_text()))
                    break
        return _index


def _dir(sub: str):
    return config.PATHS["cache"] / "marci" / sub


def _path(sub: str, day: int):
    return _dir(sub) / f"{sub}_day{day:02d}.jpg"


def have(sub: str, day: int) -> bool:
    return _path(sub, day).exists()


def days() -> list:
    """Every daily map: [[sub, day, Mars year, Ls, coverage], ...] in time order (for the date control and animations)."""
    out = []
    for sub, s in index()["subphases"].items():
        for d in s["days"]:
            out.append([sub, d[0], d[2], d[1], d[3] if len(d) > 3 else 1.0])
    out.sort(key=lambda r: (r[2], r[3]))
    return out


def nearest(my: int, ls: float, max_gap: float = 6.0) -> dict | None:
    """The daily map of Mars year `my` closest in season to `ls`, preferring a well-covered sol (MIN_COVERAGE) within
    max_gap deg to a nearer one that lost orbits; None if no map of that year is within max_gap."""
    best = None
    for sub, s in index()["subphases"].items():
        for d in s["days"]:
            if d[2] != my:
                continue
            g = abs(((d[1] - ls + 180) % 360) - 180)
            cov = d[3] if len(d) > 3 else 1.0
            if g > max_gap:
                continue
            score = g + (0 if cov >= MIN_COVERAGE else 100)
            if best is None or score < best[0]:
                best = (score, g, sub, d[0], d[1], cov)
    if best is None:
        return None
    _, g, sub, day, l2, cov = best
    return {"sub": sub, "day": day, "my": my, "ls": l2, "layer": f"marci-{sub}-{day:02d}", "local": have(sub, day),
            "gap_deg": round(g, 2), "coverage": cov}


def status() -> dict:
    with _lock:
        return {"fetching": {k: dict(v) for k, v in _fetching.items()}}


def fetch_async(sub: str) -> None:
    """Download and unpack one subphase in the background (once at a time)."""
    s = index()["subphases"].get(sub)
    if not s:
        raise ValueError(f"unknown MARCI subphase {sub}")
    with _lock:
        if sub in _fetching and not _fetching[sub].get("error"):
            return
        _fetching[sub] = {"done": 0, "total": s["bytes"], "error": None}

    def run():
        try:
            fetch(sub)
            with _lock:
                _fetching.pop(sub, None)
        except Exception as e:  # noqa: BLE001 - offline, blocked or a broken download: reported, tried again on demand
            with _lock:
                _fetching[sub] = {**_fetching.get(sub, {}), "error": str(e)}
    threading.Thread(target=run, daemon=True, name=f"marci-{sub}").start()


def fetch(sub: str, progress=None) -> int:
    """Download the subphase tar (resumable), check its MD5 and unpack its JPEGs. Returns the number of maps."""
    import hashlib
    idx = index()
    s = idx["subphases"][sub]
    d = _dir(sub)
    d.mkdir(parents=True, exist_ok=True)
    tar = d / f"{sub}.tar"

    def prog(done, total):
        with _lock:
            if sub in _fetching:
                _fetching[sub].update(done=done, total=total or s["bytes"])
        if progress:
            progress(done, total)
    h = hashlib.md5()
    net.download(idx["download"].format(id=s["id"]), tar, progress=prog, expected=s["bytes"], hasher=h)
    if s.get("md5"):
        got = hashlib.md5(tar.read_bytes()).hexdigest()
        if got != s["md5"]:
            tar.unlink(missing_ok=True)
            raise OSError(f"MARCI {sub}: checksum mismatch (download again)")
    n = 0
    with tarfile.open(tar) as t:
        for m in t.getmembers():
            mm = re.search(r"_day(\d+)\.jpg$", m.name)
            if m.isfile() and mm:
                (d / f"{sub}_day{int(mm.group(1)):02d}.jpg").write_bytes(t.extractfile(m).read())
                n += 1
    tar.unlink(missing_ok=True)            # the JPEGs are kept, the tar is not needed twice
    return n


def image(sub: str, day: int):
    """The daily map as an array (1800, 3600, 3) uint8, or None when it is not on this computer yet."""
    key = (sub, day)
    with _lock:
        if key in _imgs:
            _imgs.move_to_end(key)
            return _imgs[key]
    p = _path(sub, day)
    if not p.exists():
        return None
    from PIL import Image
    a = np.asarray(Image.open(io.BytesIO(p.read_bytes())).convert("RGB"))
    with _lock:
        _imgs[key] = a
        while len(_imgs) > MAX_IMGS:
            _imgs.popitem(last=False)
    return a


def parse_layer(layer: str):
    m = LAYER_RE.match(layer or "")
    return (m.group(1), int(m.group(2))) if m else None


def tile_rgb(layer: str, w: float, s: float, e: float, n: float, size: int = 256):
    """(size, size, 3) float 0-1 for a lon/lat box, and a no-data mask (polar night and gaps between swaths are black).
    Returns (None, None) while the map is still downloading (the download starts here)."""
    from PIL import Image
    p = parse_layer(layer)
    if not p:
        return None, None
    sub, day = p
    a = image(sub, day)
    if a is None:
        if not net.blocked(index()["download"]):
            fetch_async(sub)
        return None, None
    g = index()["grid"]
    H, W = a.shape[:2]
    x0 = (w - g["lon0"]) / g["deg_per_px"]
    x1 = (e - g["lon0"]) / g["deg_per_px"]
    y0 = (g["lat0"] - n) / g["deg_per_px"]
    y1 = (g["lat0"] - s) / g["deg_per_px"]
    im = Image.fromarray(a)
    # crop with sub-pixel bounds via an affine transform (keeps zoomed-in tiles aligned with the other layers)
    sx, sy = (x1 - x0) / size, (y1 - y0) / size
    if sx >= 1:
        # zoomed out: average the source pixels (box filter) for smooth, alias-free tiles
        box = (max(0, int(np.floor(x0))), max(0, int(np.floor(y0))), min(W, int(np.ceil(x1))), min(H, int(np.ceil(y1))))
        out = im.crop(box).resize((size, size), Image.BOX)
    else:
        out = im.transform((size, size), Image.AFFINE, (sx, 0, x0, 0, sy, y0), resample=Image.BICUBIC)
    rgb = np.asarray(out, np.float32) / 255.0
    nodata = rgb.sum(axis=2) < 0.05
    return rgb, nodata
