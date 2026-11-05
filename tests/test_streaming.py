"""
Map streaming tests. Run: python -m pytest tests/test_streaming.py -q

1. The whole-globe elevation tiles (zoom 0-4) are sampled from the 33 MB MOLA grid. On a first run that file is not
   on the computer yet: a tile must come back at once with a smooth stand-in, marked provisional (so it is never cached
   and the globe asks again), while the file downloads in the background. Before the fix every globe tile waited for
   the whole download, and the globe stayed black.
2. The internet check asks several map servers at once. One server that hangs up ("Remote end closed connection
   without response") must not switch the app to offline while another answers; an HTTP error status still means the
   network is there.
"""
from __future__ import annotations

import os
import sys
import time
import urllib.error

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)

from planet import config, dem, megdr, net, tilecache  # noqa: E402


def test_globe_elevation_tile_does_not_wait_for_the_33_mb_grid(tmp_path, monkeypatch):
    config.configure(tmp_path)
    started = []
    monkeypatch.setattr(megdr, "have", lambda info: False)
    monkeypatch.setattr(megdr, "fetch_async", lambda info: started.append(info["key"]))
    monkeypatch.setattr(megdr, "_maps", {})

    def no_blocking_download(*a, **k):
        raise AssertionError("a map tile must not download the 33 MB grid itself")
    monkeypatch.setattr(megdr, "ensure", no_blocking_download)
    monkeypatch.setattr(net, "blocked", lambda url="": False)

    t0 = time.time()
    elev, meta = dem.build(2, 1, 3)
    assert time.time() - t0 < 2.0
    assert meta.get("provisional") is True                 # served, not cached; the globe asks again
    assert np.isfinite(elev).all() and float(np.abs(elev).max()) == 0.0
    assert [s["id"] for s in meta["sources"]] == ["pending"]
    assert started == [megdr.G16["key"]]                   # the download started in the background

    data, final = dem.tile_bytes_ex(2, 1, 3)
    assert final is False
    key, _ = tilecache.lookup("dem", 2, 1, 3, "mmd")
    assert not key.exists()                                # the stand-in never reaches the tile cache


def test_globe_elevation_tile_uses_the_grid_once_it_is_here(tmp_path, monkeypatch):
    config.configure(tmp_path)
    info = megdr.G16
    grid = np.full((info["rows"], info["cols"]), 1234, dtype=">i2")
    monkeypatch.setattr(megdr, "_maps", {info["key"]: grid})
    monkeypatch.setattr(net, "blocked", lambda url="": False)
    elev, meta = dem.build(2, 1, 3)
    assert not meta.get("provisional")
    assert np.allclose(elev, 1234.0)
    assert [s["id"] for s in meta["sources"]] == ["megdr16"]


def test_online_when_one_server_hangs_up(monkeypatch):
    monkeypatch.setattr(net, "PROBE_URLS", ("https://a.example/x", "https://b.example/y", "https://c.example/z"))

    class _R:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self, n=-1): return b"ok"

    def fake_urlopen(req, timeout=None, context=None):
        host = req.full_url.split("/")[2]
        if host == "a.example":
            raise ConnectionResetError("Remote end closed connection without response")
        if host == "b.example":
            time.sleep(0.2)
            return _R()
        raise TimeoutError("timed out")
    monkeypatch.setattr(net.urllib.request, "urlopen", fake_urlopen)
    assert net._probe() is True


def test_http_error_status_still_means_online(monkeypatch):
    monkeypatch.setattr(net, "PROBE_URLS", ("https://a.example/x",))

    def fake_urlopen(req, timeout=None, context=None):
        raise urllib.error.HTTPError(req.full_url, 403, "Forbidden", {}, None)
    monkeypatch.setattr(net.urllib.request, "urlopen", fake_urlopen)
    assert net._probe() is True


def test_offline_when_no_server_answers(monkeypatch):
    monkeypatch.setattr(net, "PROBE_URLS", ("https://a.example/x", "https://b.example/y"))

    def fake_urlopen(req, timeout=None, context=None):
        raise OSError("network unreachable")
    monkeypatch.setattr(net.urllib.request, "urlopen", fake_urlopen)
    assert net._probe() is False
    assert "a.example" in net.status()["last_error"] and "b.example" in net.status()["last_error"]


def test_status_reports_download_progress(monkeypatch):
    key = megdr.G16["key"]
    monkeypatch.setattr(megdr, "_fetching", {key})
    megdr._progress_of(megdr.G16)(10_000_000, megdr.G16["bytes"])
    st = megdr.status()
    assert st["global16_key"] == key
    assert st["progress"][key] == {"done": 10_000_000, "total": megdr.G16["bytes"]}


def test_closer_zoom_has_no_holes_while_the_grids_download(tmp_path, monkeypatch):
    config.configure(tmp_path)
    monkeypatch.setattr(megdr, "have", lambda info: False)
    monkeypatch.setattr(megdr, "fetch_async", lambda info: None)
    monkeypatch.setattr(megdr, "_maps", {})
    monkeypatch.setattr(megdr, "ensure", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no blocking download")))
    monkeypatch.setattr(net, "blocked", lambda url="": False)
    monkeypatch.setattr(dem, "blend_usable", lambda: False)
    from planet import localmode
    monkeypatch.setattr(localmode, "blend", lambda: None)
    elev, meta = dem.build(7, 40, 200, detail=False)
    assert np.isfinite(elev).all()
    assert meta.get("provisional") is True
