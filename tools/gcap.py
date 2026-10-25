"""Guide capture helper: drive the MarsNav window over the DevTools protocol and save screenshots.

    python tools/gcap.py <batch.py>     runs the batch (a Python file using js(), shot(), win(), wait())
Screenshots go to data_cache/guide/.
"""
import base64
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import websocket

PORT = 9335
OUT = Path("data_cache/guide")
OUT.mkdir(parents=True, exist_ok=True)
_ws = {}
_id = [0]


def _page(sub="MarsNav"):
    pages = [t for t in json.loads(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json", timeout=5).read())
             if t["type"] == "page"]
    for t in pages:
        if sub in (t["url"], t.get("title", "")):
            return t
    for t in pages:                      # the main window before any drive or report window
        if (sub in t["url"] or sub in t.get("title", "")) and ("Drive" in sub or "Drive" not in t.get("title", "")):
            return t
    for t in pages:
        if sub in t["url"] or sub in t.get("title", ""):
            return t
    raise RuntimeError(f"no page {sub!r}: {[(t['url'], t.get('title')) for t in pages]}")


def _conn(sub):
    t = _page(sub)
    key = t["id"]
    if key not in _ws:
        _ws[key] = websocket.create_connection(t["webSocketDebuggerUrl"], timeout=180, suppress_origin=True)
    return _ws[key]


def _call(sub, method, params=None):
    ws = _conn(sub)
    _id[0] += 1
    ws.send(json.dumps({"id": _id[0], "method": method, "params": params or {}}))
    while True:
        m = json.loads(ws.recv())
        if m.get("id") == _id[0]:
            return m


def js(expr, page="MarsNav"):
    r = _call(page, "Runtime.evaluate", {"expression": expr, "awaitPromise": True, "returnByValue": True})
    res = r.get("result", {})
    if "exceptionDetails" in res:
        print("  JS EXCEPTION:", json.dumps(res["exceptionDetails"])[:600])
        return None
    return res.get("result", {}).get("value")


def wait(s):
    time.sleep(s)


def until(expr, timeout=60, page="MarsNav", step=0.5):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            if js(expr, page):
                return True
        except Exception:  # noqa: BLE001
            pass
        time.sleep(step)
    print(f"  timeout waiting for {expr[:80]}")
    return False


def shot(name, clip=None, page="MarsNav"):
    """Content screenshot; clip = (x, y, w, h) in CSS px, or a CSS selector."""
    params = {"format": "png"}
    if isinstance(clip, str):
        r = js(f"(()=>{{const e=document.querySelector({json.dumps(clip)}); if(!e) return null; const b=e.getBoundingClientRect(); return [b.x,b.y,b.width,b.height]}})()", page)
        if not r:
            print("  no element", clip)
            return
        clip = r
    if clip:
        x, y, w, h = clip
        params["clip"] = {"x": x, "y": y, "width": w, "height": h, "scale": 1}
    r = _call(page, "Page.captureScreenshot", params)
    (OUT / f"{name}.png").write_bytes(base64.b64decode(r["result"]["data"]))
    print("  shot", name, clip or "")


def win(name, title="MarsNav"):
    r = subprocess.run([sys.executable, "tools/winshot.py", title, str(OUT / f"{name}.png")], capture_output=True, text=True)
    print("  win", name, r.stdout.strip() or r.stderr.strip()[-200:])


def go(path, page="MarsNav", settle=4):
    js(f"location.href={json.dumps(path)}; 1", page)
    _ws.clear()
    time.sleep(settle)


def click(sel, page="MarsNav"):
    return js(f"(()=>{{const e=document.querySelector({json.dumps(sel)}); if(!e) return 'missing'; e.click(); return 'ok'}})()", page)


if __name__ == "__main__":
    code = Path(sys.argv[1]).read_text(encoding="utf-8")
    exec(compile(code, sys.argv[1], "exec"), globals())
