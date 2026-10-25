"""Live suit and rover telemetry, built into the MarsNav server (no separate bridge, no command line).

The NASA SUITS Telemetry Stream Server (TSS) answers UDP only, and browsers cannot speak UDP, so the local server does
it: it finds a TSS by itself (the last one used, this computer, then a broadcast on every local network), polls it once
a second (its update rate) and relays each frame to the app as Server-Sent Events on the app's own address.

  TSS (UDP :14141)  <-- [uint32 timestamp][uint32 command], big-endian --  this server
  TSS               --> JSON bytes (EVA.json / ROVER.json)             -->  this server
  this server       --> GET /api/tss/events (SSE, event "tss")          -->  app (Execute > Telemetry > Live > Enable)

TSS2027: command 0 -> EVA.json.  TSS2026: command 0 -> ROVER.json, 1 -> EVA.json.  Only GET commands (< 1000) are ever
sent: this never changes TSS state.  https://github.com/SUITS-Techteam/TSS2027

Endpoints:  POST /api/tss/start {addr?: "host:port", year?}   find (or use) a TSS and start relaying
            POST /api/tss/stop
            GET  /api/tss/status
            GET  /api/tss/events                               SSE stream
            POST /api/tss/plan   GET /api/tss/plan             plan uplink (for a helmet display)"""
from __future__ import annotations

import json
import queue
import socket
import struct
import sys
import threading
import time
from pathlib import Path

PORT = 14141
COMMANDS = {2027: [(0, "eva")], 2026: [(1, "eva"), (0, "rover")]}


def _req(cmd: int) -> bytes:
    return struct.pack(">II", int(time.time()) & 0xFFFFFFFF, cmd)


def _parse(data: bytes):
    try:
        return json.loads(data.decode("utf-8", "replace").rstrip("\x00").strip())
    except ValueError:
        return None


def _udp() -> socket.socket:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    if hasattr(socket, "SIO_UDP_CONNRESET"):      # Windows: do not turn ICMP "port unreachable" into socket errors
        try:
            s.ioctl(socket.SIO_UDP_CONNRESET, False)
        except (OSError, ValueError):
            pass
    return s


def tss_get(host: str, port: int, cmd: int, timeout: float = 1.0):
    s = _udp()
    try:
        s.settimeout(timeout)
        s.sendto(_req(cmd), (host, port))
        data, _ = s.recvfrom(65535)
        j = _parse(data)
        if j is None:
            raise ValueError(f"TSS reply is not JSON ({len(data)} bytes)")
        return j
    finally:
        s.close()


def _year_of(reply) -> int:
    return 2026 if isinstance(reply, dict) and "pr_telemetry" in reply else 2027


def _local_broadcasts() -> list[str]:
    """Broadcast addresses of this computer's networks (assumes /24, true of almost every lab and home network)."""
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    try:   # the address used for the default route
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    out = ["255.255.255.255"]
    for ip in ips:
        if ip.startswith("127.") or ip.startswith("169.254."):
            continue
        out.append(".".join(ip.split(".")[:3] + ["255"]))
    return out


def discover(candidates: list[str], wait: float = 1.6, port: int = PORT) -> dict | None:
    """Send one TSS GET (command 0) to every candidate at once (unicast and broadcast) and take the first JSON reply."""
    s = _udp()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    s.settimeout(0.2)
    sent = []
    try:
        for c in candidates:
            host, _, p = c.partition(":")
            try:
                s.sendto(_req(0), (host, int(p or port)))
                sent.append(c)
            except OSError:
                continue
        t_end = time.time() + wait
        while time.time() < t_end:
            try:
                data, (h, p) = s.recvfrom(65535)
            except (socket.timeout, ConnectionResetError):
                # Windows reports "nobody listening" (ICMP port unreachable) from one candidate as an error on the socket:
                # keep waiting for the others
                continue
            except OSError:
                break
            j = _parse(data)
            if isinstance(j, dict):
                return {"host": h, "port": p, "year": _year_of(j), "tried": sent}
    finally:
        s.close()
    return None


class Bridge:
    def __init__(self):
        self.lock = threading.Lock()
        self.clients: list[queue.Queue] = []
        self.thread = None
        self.stop_ev = threading.Event()
        self.state = {"running": False, "tss": None, "year": None, "frames": 0, "errors": 0, "lastError": None,
                      "lastOkMs": None, "how": None, "plan": None}
        self.latest = None

    # ------------------------------------------------------------------ control
    def start(self, addr: str | None, year: int | None, cfg_path: Path) -> dict:
        self.stop()
        saved = None
        try:
            saved = json.loads(cfg_path.read_text()).get("addr")
        except (OSError, ValueError, AttributeError):
            pass
        if addr:
            cands, how = [addr if ":" in addr else f"{addr}:{PORT}"], "the address you gave"
        else:
            cands = ([saved] if saved else []) + [f"127.0.0.1:{PORT}"] + [f"{b}:{PORT}" for b in _local_broadcasts()]
            how = "automatic search (last used, this computer, local networks)"
        found = discover(cands)
        if not found:
            return {"ok": True, "found": False, "tried": cands,
                    "message": "No NASA SUITS TSS answered on this computer or the local network."}
        host, port = found["host"], found["port"]
        y = int(year or found["year"])
        try:
            cfg_path.parent.mkdir(parents=True, exist_ok=True)
            cfg_path.write_text(json.dumps({"addr": f"{host}:{port}", "year": y}))
        except OSError:
            pass
        with self.lock:
            self.state.update(running=True, tss=f"{host}:{port}", year=y, frames=0, errors=0, lastError=None, lastOkMs=None, how=how)
        self.stop_ev = threading.Event()
        self.thread = threading.Thread(target=self._poll, args=(host, port, y, self.stop_ev), daemon=True, name="tss-bridge")
        self.thread.start()
        self._emit("status", {"ok": True, "tss": f"{host}:{port}", "year": y})
        return {"ok": True, "found": True, "tss": f"{host}:{port}", "year": y, "how": how}

    def stop(self):
        if self.thread:
            self.stop_ev.set()
            self.thread = None
        with self.lock:
            self.state["running"] = False

    def _poll(self, host, port, year, stop_ev):
        t0 = time.time()
        cmds = COMMANDS.get(year, COMMANDS[2027])
        while not stop_ev.is_set():
            tick = time.time()
            try:
                frame = {"wallS": round(tick - t0, 3), "year": year}
                for cmd, k in cmds:
                    frame[k] = tss_get(host, port, cmd, timeout=1.2)
                with self.lock:
                    self.state["frames"] += 1
                    self.state["lastOkMs"] = time.time() * 1000
                self.latest = frame
                self._emit("tss", frame)
            except (OSError, ValueError) as e:
                msg = f"TSS {host}:{port} not answering ({e})" if isinstance(e, OSError) else str(e)
                with self.lock:
                    self.state["errors"] += 1
                    self.state["lastError"] = msg
                self._emit("status", {"ok": False, "error": msg})
            stop_ev.wait(max(0.05, 1.0 - (time.time() - tick)))

    # ------------------------------------------------------------------ streaming
    def _emit(self, event, data):
        msg = f"event: {event}\ndata: {json.dumps(data)}\n\n".encode()
        with self.lock:
            for q in list(self.clients):
                try:
                    q.put_nowait(msg)
                except queue.Full:
                    pass

    def status(self) -> dict:
        with self.lock:
            st = dict(self.state)
            st["clients"] = len(self.clients)
        st["ok"] = bool(st["running"] and st["lastOkMs"] and time.time() * 1000 - st["lastOkMs"] < 5000)
        st["lastOkAgoS"] = round((time.time() * 1000 - st["lastOkMs"]) / 1000, 1) if st["lastOkMs"] else None
        st.pop("plan", None)
        return st

    def serve_events(self, handler):
        q: queue.Queue = queue.Queue(maxsize=50)
        with self.lock:
            self.clients.append(q)
        try:
            handler.send_response(200)
            handler.send_header("Content-Type", "text/event-stream")
            handler.send_header("Cache-Control", "no-cache")
            handler._mm_cache_set = True
            handler.send_header("Connection", "keep-alive")
            handler.end_headers()
            st = self.status()
            handler.wfile.write(f"retry: 2000\nevent: status\ndata: {json.dumps({'ok': st['running'], 'tss': st['tss'], 'year': st['year']})}\n\n".encode())
            handler.wfile.flush()
            while True:
                try:
                    msg = q.get(timeout=15)
                except queue.Empty:
                    msg = b": keep-alive\n\n"
                handler.wfile.write(msg)
                handler.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass
        finally:
            with self.lock:
                if q in self.clients:
                    self.clients.remove(q)


def bridge() -> Bridge:
    # kept on the sys module so a development reload of this package does not orphan a running bridge
    b = getattr(sys, "_martian_map_tss", None)
    if b is None:
        b = Bridge()
        sys._martian_map_tss = b
    return b


def handle(handler, method: str, path: str, root: Path) -> None:
    """Serve /api/tss/* directly on the request handler (the event stream must write as frames arrive)."""
    b = bridge()
    cfg = root / "data_cache" / "tss.json"

    def reply(obj, status=200):
        data = json.dumps(obj).encode()
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Cache-Control", "no-store")
        handler._mm_cache_set = True
        handler.send_header("Content-Length", str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)

    body = {}
    if method == "POST":
        n = int(handler.headers.get("Content-Length") or 0)
        raw = handler.rfile.read(n) if n else b""
        try:
            body = json.loads(raw.decode() or "{}")
        except ValueError:
            return reply({"ok": False, "error": "bad JSON"}, 400)
    p = path.split("?", 1)[0]
    if p == "/api/tss/events":
        return b.serve_events(handler)
    if p == "/api/tss/start" and method == "POST":
        return reply(b.start(body.get("addr") or None, body.get("year"), cfg))
    if p == "/api/tss/stop" and method == "POST":
        b.stop()
        return reply({"ok": True})
    if p == "/api/tss/status":
        return reply({"ok": True, **b.status()})
    if p == "/api/tss/latest":
        return reply(b.latest or {"error": "no frame yet"}, 200 if b.latest else 503)
    if p == "/api/tss/plan":
        if method == "POST":
            with b.lock:
                b.state["plan"] = {**body, "receivedUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            return reply({"ok": True})
        plan = b.state.get("plan")
        return reply(plan or {"error": "no plan yet"}, 200 if plan else 404)
    return reply({"ok": False, "error": f"unknown endpoint {p}"}, 404)
