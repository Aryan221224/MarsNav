"""Smoke test of a built MarsNav program, as a user starts it: run it (serve only, no window), check that every page,
the engine, the bundled data and the planet API answer, then stop it and check nothing is left running.

    python tools/smoke_exe.py dist/MarsNav/MarsNav.exe      the portable folder (GitHub Actions runs this)
    python tools/smoke_exe.py launcher/martian_map.py       from source

Exit 0 when every check passes. The planet checks that need NASA / USGS data (MOLA, place lookups) only need the
internet the first time; they are reported but a slow download does not fail the build."""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

PAGES = ["/index.html", "/landing.html", "/hud.html", "/drive.html", "/js/main.js", "/js/landing.js", "/js/hud.js", "/js/placeview.js",
         "/js/worker.js", "/engine/marstime.js", "/engine/planner.js", "/css/place.css", "/data/sites.json", "/data/manifest.json",
         "/sw.js", "/vendor/three.module.min.js"]
REQUIRED_API = {
    "/api/ping": lambda j: True,
    "/api/planet/status": lambda j: j.get("ok"),
    "/api/sites": lambda j: len(j.get("sites", [])) >= 1,
    "/api/features": lambda j: sum(L.get("count", 0) for L in j.get("layers", {}).values()) > 10000,   # bundled catalogues found
    "/api/missions": lambda j: len(j.get("missions", [])) >= 30,
    "/api/objectives": lambda j: len(j.get("objectives", [])) >= 7,
    "/api/candidates": lambda j: len(j.get("ez", [])) >= 40,
    "/api/atlas": lambda j: len(j.get("groups", [])) >= 5,
    "/api/spaceweather": lambda j: j.get("ok"),
}
NETWORK_API = {
    "/api/place?lon=137.44&lat=-4.59": lambda j: j.get("ok") and j["where"]["quadrangle"]["id"] == "MC-23",
    "/api/point?lon=77.45&lat=18.44&z=8": lambda j: j.get("ok") and j.get("elev_m") is not None,
}


def get(port: int, path: str, timeout: float = 60) -> tuple[int, bytes]:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except OSError:
        return 0, b""


def main() -> int:
    target = Path(sys.argv[1]).resolve()
    frozen = target.suffix.lower() == ".exe"
    root = target.parent if frozen else target.parent.parent
    cmd = [str(target)] if frozen else [sys.executable, str(target)]
    port = 8765
    log = open(root / "smoke_exe.log", "w", encoding="utf-8")
    t0 = time.time()
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    p = subprocess.Popen([*cmd, "--headless", "--no-browser", "--port", str(port)], cwd=root, stdout=log, stderr=subprocess.STDOUT,
                         stdin=subprocess.DEVNULL, creationflags=flags)
    fails, notes = [], []

    def check(name, ok, detail=""):
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}{(': ' + detail) if detail else ''}", flush=True)
        if not ok:
            fails.append(name)

    try:
        # the launcher may move to the next free port: it writes the one it serves on to data_cache/server.json
        up = False
        while time.time() - t0 < 240 and p.poll() is None:
            try:
                port = json.loads((root / "data_cache" / "server.json").read_text()).get("port", port)
            except (OSError, ValueError):
                pass
            if get(port, "/api/ping", 5)[0] == 200:
                up = True
                break
            time.sleep(2)
        check("the program starts and serves", up, f"{time.time() - t0:.0f} s on port {port}" if up else f"exit code {p.poll()}")
        if not up:
            return 1
        for path in PAGES:
            st, body = get(port, path)
            check(f"page {path}", st == 200 and len(body) > 100, f"HTTP {st}, {len(body)} bytes")
        for path, ok in REQUIRED_API.items():
            st, body = get(port, path, 120)
            try:
                j = json.loads(body)
                good = st == 200 and bool(ok(j))
            except (ValueError, KeyError, TypeError) as e:
                good, j = False, {"error": str(e)}
            check(f"api {path}", good, f"HTTP {st}")
        for path, ok in NETWORK_API.items():
            st, body = get(port, path, 180)
            try:
                good = st == 200 and bool(ok(json.loads(body)))
            except (ValueError, KeyError, TypeError):
                good = False
            print(f"  [{'PASS' if good else 'NOTE'}] api {path}: HTTP {st}" + ("" if good else " (needs NASA / USGS downloads)"), flush=True)
            if not good:
                notes.append(path)
        return 1 if fails else 0
    finally:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True)
        else:
            p.send_signal(signal.SIGINT)
            try:
                p.wait(20)
            except subprocess.TimeoutExpired:
                p.kill()
        time.sleep(3)
        print(f"RESULT: {'ALL PASS' if not fails else 'FAILED: ' + '; '.join(fails)}"
              f"{' (network notes: ' + ', '.join(notes) + ')' if notes else ''}", flush=True)
        log.close()


if __name__ == "__main__":
    sys.exit(main())
