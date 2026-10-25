"""
Downloader test. Run: python -m pytest tests/test_download.py -q

On a first run several map tiles, a route job and a raster worker can all need the same whole-planet file at once
(the 33 MB MOLA elevation grid). planet/net.py must fetch it once and let the others wait, across threads and across
processes; before the fix they wrote one .part file together and every copy failed its size check.
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)

from planet import localmode, net  # noqa: E402

SIZE = 2 * 1024 * 1024
PAYLOAD = hashlib.sha256(b"marsnav").digest() * (SIZE // 32)


class _Slow(BaseHTTPRequestHandler):
    hits = 0

    def do_GET(self):  # noqa: N802 - http.server API
        type(self).hits += 1
        self.send_response(200)
        self.send_header("Content-Length", str(SIZE))
        self.end_headers()
        for i in range(0, SIZE, 32768):            # about 2 s per copy, so every caller overlaps the first one
            try:
                self.wfile.write(PAYLOAD[i:i + 32768])
            except OSError:
                return
            time.sleep(0.03)

    def log_message(self, *a):
        pass


CHILD = r"""
import sys
sys.path.insert(0, sys.argv[1])
from planet import localmode, net
localmode.offline = lambda: False
net.download(sys.argv[2], sys.argv[3], expected=int(sys.argv[4]), timeout=30)
print("ok")
"""


def test_one_download_per_file_across_threads_and_processes(tmp_path, monkeypatch):
    monkeypatch.setattr(localmode, "offline", lambda: False)
    _Slow.hits = 0
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Slow)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_address[1]}/megt90n000eb.img"
    dest = tmp_path / "megt90n000eb.img"
    try:
        procs = [subprocess.Popen([sys.executable, "-c", CHILD, ROOT, url, str(dest), str(SIZE)],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(2)]
        errors = []

        def grab():
            try:
                net.download(url, dest, expected=SIZE, timeout=30)
            except Exception as e:  # noqa: BLE001
                errors.append(repr(e))

        threads = [threading.Thread(target=grab) for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(120)
        outs = [p.communicate(timeout=120) for p in procs]
    finally:
        srv.shutdown()
        srv.server_close()
    assert not errors, errors
    for p, (out, err) in zip(procs, outs):
        assert p.returncode == 0 and out.strip() == "ok", err[-800:]
    assert dest.read_bytes() == PAYLOAD
    assert not (tmp_path / "megt90n000eb.img.part").exists()
    assert _Slow.hits == 1, f"the file was fetched {_Slow.hits} times"
