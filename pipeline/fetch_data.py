"""
fetch_data.py - download every input listed in pipeline/sources.json, verify its SHA-256 and put it where the
pipeline expects it (data_cache/raw for rasters, data_cache for tables).

    python pipeline/fetch_data.py                 # required files only (about 870 MB)
    python pipeline/fetch_data.py --optional      # also the optional extra HiRISE DTMs (about 350 MB)
    python pipeline/fetch_data.py --check         # verify what is already present, download nothing

Files already present with the right hash are skipped; downloads resume from a .part file. MEDA cannot be fetched as
one file (the PDS bundle is tens of GB): its entry explains the range-read sampler in tools/meda_sampler.js.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.request

# MM_ROOT: the project folder (set by the launcher; inside the packaged exe __file__ is in a temporary folder)
ROOT = os.environ.get("MM_ROOT") or os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
from sitecfg import raw_dir  # noqa: E402

DEST = {"raw": raw_dir(), "cache": os.path.join(ROOT, "data_cache")}


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(url: str, out: str) -> None:
    part = out + ".part"
    have = os.path.getsize(part) if os.path.exists(part) else 0
    req = urllib.request.Request(url, headers={"User-Agent": "MarsNav-fetch/2.0", **({"Range": f"bytes={have}-"} if have else {})})
    with urllib.request.urlopen(req, timeout=60) as r:
        mode = "ab" if have and r.status == 206 else "wb"
        total = int(r.headers.get("Content-Length") or 0) + (have if mode == "ab" else 0)
        done = have if mode == "ab" else 0
        with open(part, mode) as f:
            while True:
                b = r.read(1 << 20)
                if not b:
                    break
                f.write(b)
                done += len(b)
                if total:
                    print(f"\r  {done / 1e6:8.1f} / {total / 1e6:.1f} MB", end="", flush=True)
    print()
    os.replace(part, out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--optional", action="store_true", help="include optional sources")
    ap.add_argument("--check", action="store_true", help="verify only")
    a = ap.parse_args()
    cfg = json.load(open(os.path.join(ROOT, "pipeline", "sources.json")))
    bad = 0
    for s in cfg["sources"]:
        out = os.path.join(DEST[s["dest"]], s["file"])
        os.makedirs(os.path.dirname(out), exist_ok=True)
        tag = "optional" if s.get("optional") else "required"
        if os.path.exists(out):
            h = sha256(out)
            if s.get("sha256") in (None, h):
                print(f"ok       {s['file']}{'' if s.get('sha256') else '  (no reference hash; sha256 ' + h + ')'}")
                continue
            print(f"MISMATCH {s['file']}: {h}")
            bad += 1
            if a.check:
                continue
        if a.check or (s.get("optional") and not a.optional):
            print(f"missing  {s['file']} ({tag})")
            bad += 0 if s.get("optional") else 1
            continue
        if not s.get("urls"):
            print(f"manual   {s['file']}: {s.get('how', 'see sources.json')}")
            bad += 1
            continue
        for url in s["urls"]:
            try:
                print(f"get      {s['file']} <- {url}")
                download(url, out)
                break
            except Exception as e:  # try the next mirror
                print(f"  failed: {e}")
        if not os.path.exists(out):
            bad += 1
            continue
        h = sha256(out)
        if s.get("sha256") and h != s["sha256"]:
            print(f"  SHA-256 MISMATCH: got {h}")
            bad += 1
        else:
            print(f"  verified {h}")
    print("all inputs present and verified" if not bad else f"{bad} problem(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
