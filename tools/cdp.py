"""Test helper: drive the MarsNav window through the Chrome DevTools protocol (MM_DEBUG_PORT, localhost only).

    python tools/cdp.py <port> list
    python tools/cdp.py <port> eval "<js expression>" [url-substring]
    python tools/cdp.py <port> shot <out.png> [url-substring] [x,y,w,h]
"""
import base64
import json
import sys
import urllib.request

import websocket  # websocket-client (test-only dependency)


def targets(port):
    return json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=5).read())


def pick(port, sub):
    pages = [t for t in targets(port) if t["type"] == "page"]
    for t in pages:                                    # exact URL or title first, then a substring
        if sub and sub in (t["url"], t.get("title", "")):
            return t
    for t in pages:
        if not sub or sub in t["url"] or sub in t.get("title", ""):
            return t
    raise SystemExit(f"no page matching {sub!r}: {[t['url'] for t in pages]}")


def call(ws, method, params=None, _id=[0]):
    _id[0] += 1
    ws.send(json.dumps({"id": _id[0], "method": method, "params": params or {}}))
    while True:
        m = json.loads(ws.recv())
        if m.get("id") == _id[0]:
            return m


def main():
    port, cmd = int(sys.argv[1]), sys.argv[2]
    if cmd == "list":
        for t in targets(port):
            print(t["type"], t["url"], t.get("title", ""))
        return
    sub = sys.argv[4] if len(sys.argv) > 4 else ""
    t = pick(port, sub)
    ws = websocket.create_connection(t["webSocketDebuggerUrl"], timeout=120, suppress_origin=True)
    if cmd == "eval":
        r = call(ws, "Runtime.evaluate", {"expression": sys.argv[3], "awaitPromise": True, "returnByValue": True})
        res = r.get("result", {})
        if "exceptionDetails" in res:
            print("EXCEPTION", json.dumps(res["exceptionDetails"])[:1500])
        else:
            print(json.dumps(res.get("result", {}).get("value"), indent=1)[:20000])
    elif cmd == "shot":
        params = {"format": "png"}
        if len(sys.argv) > 5:                          # optional clip in CSS pixels: x,y,w,h
            x, y, w, h = (float(v) for v in sys.argv[5].split(","))
            params["clip"] = {"x": x, "y": y, "width": w, "height": h, "scale": 1}
        r = call(ws, "Page.captureScreenshot", params)
        open(sys.argv[3], "wb").write(base64.b64decode(r["result"]["data"]))
        print("saved", sys.argv[3])
    ws.close()


if __name__ == "__main__":
    main()
