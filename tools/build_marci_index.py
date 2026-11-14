"""
build_marci_index.py - the index of MRO MARCI Mars Daily Global Maps that Landing mode streams on demand.

The maps: version 1 MARCI MDGMs (Wang & Wheeler; Wang & Richardson 2015, Icarus 251), one stretched colour mosaic of
the whole planet per sol (0.1 deg, 3600 x 1800 JPEG, from 13 swaths taken around 3 pm local time), Mars years 28-32
(November 2006 to 2014), on Harvard Dataverse (doi:10.7910/DVN/G2VENZ, CC0). They come in one tar per MARCI subphase
(about a month, 15 MB). The app downloads only the subphase a user looks at (planet/marci.py); this tool records, for
every daily map, its Mars year and solar longitude (from each subphase's own _ls.txt), so the app can pick the right
package without downloading anything first. It also records each map's coverage: the share of 60 deg S - 60 deg N that
has data (some sols lost orbits and are nearly empty), so the app can prefer a well-covered sol next to an empty one.

    python tools/build_marci_index.py --tars DIR    # read the tars already in DIR (any that are missing are downloaded)
    python tools/build_marci_index.py               # download every tar (1.2 GB) into data_cache/marci_tars first

Output: planet/data/marci_v1_index.json
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import sys
import tarfile
import time
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DOI = "doi:10.7910/DVN/G2VENZ"
API = "https://dataverse.harvard.edu/api"
OUT = os.path.join(ROOT, "planet", "data", "marci_v1_index.json")
LINE = re.compile(r"^\s*(\w+?)_?day(\d+)\.sav\S*\s+(?:(\d+)\s+)?([-\d.]+)\s*$")
# subphase -> (first Mars year, first Ls, last Mars year, last Ls): the dataset's own summary_subphases.txt (version 2,
# which repeats the version 1 subphases), used only where a subphase's _ls.txt does not give the year
SUMMARY_V2_FILE_ID = 10734508


def get(url: str, timeout: int = 120) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "MarsNav-marci-index/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def files() -> list[dict]:
    d = json.loads(get(f"{API}/datasets/:persistentId/?persistentId={DOI}"))
    out = []
    for f in d["data"]["latestVersion"]["files"]:
        df = f["dataFile"]
        if df["filename"].endswith(".tar"):
            out.append({"sub": df["filename"][:-4], "id": df["id"], "bytes": df["filesize"], "md5": df.get("md5")})
    return sorted(out, key=lambda x: x["sub"])


def coverage(jpeg: bytes) -> float:
    """Share of 60 S - 60 N with data (not black), from a 1/8-scale decode (polar night is not counted)."""
    import numpy as np
    from PIL import Image
    im = Image.open(io.BytesIO(jpeg))
    im.draft("RGB", (im.width // 8, im.height // 8))
    a = np.asarray(im.convert("RGB"), np.float32)
    h = a.shape[0]
    lat = 90 - (np.arange(h) + 0.5) * 180 / h
    band = a[np.abs(lat) <= 60]
    return round(float((band.sum(axis=2) >= 12.75).mean()), 2)        # the server's no-data rule: r+g+b < 0.05


def summary() -> dict:
    txt = get(f"{API}/access/datafile/{SUMMARY_V2_FILE_ID}").decode()
    out = {}
    for ln in txt.splitlines()[1:]:
        p = ln.split()
        if len(p) == 5:
            out[p[0]] = (int(p[1]), float(p[2]), int(p[3]), float(p[4]))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--tars", default=os.path.join(ROOT, "data_cache", "marci_tars"))
    a = ap.parse_args()
    os.makedirs(a.tars, exist_ok=True)
    fl, summ = files(), summary()
    subs = {}
    for f in fl:
        p = os.path.join(a.tars, f"{f['sub']}.tar")
        if not os.path.exists(p) or os.path.getsize(p) != f["bytes"]:
            print(f"  download {f['sub']} ({f['bytes'] / 1e6:.1f} MB)")
            data = get(f"{API}/access/datafile/{f['id']}", timeout=600)
            with open(p, "wb") as o:
                o.write(data)
        with open(p, "rb") as fh:
            md5 = hashlib.md5(fh.read()).hexdigest()
        if f.get("md5") and md5 != f["md5"]:
            raise SystemExit(f"{f['sub']}: MD5 {md5} does not match Dataverse's {f['md5']}")
        with tarfile.open(p) as t:
            names = [m.name for m in t.getmembers() if m.isfile()]
            ls_name = next(n for n in names if n.endswith("_ls.txt"))
            txt = t.extractfile(ls_name).read().decode(errors="replace")
            jpgs = {int(re.search(r"day(\d+)\.jpg$", n).group(1)): n for n in names if n.endswith(".jpg")}
            cov = {d: coverage(t.extractfile(n).read()) for d, n in jpgs.items()}
        s = summ.get(f["sub"])
        days = []
        for ln in txt.splitlines():
            m = LINE.match(ln)
            if not m:
                continue
            day, my, ls = int(m.group(2)), m.group(3), float(m.group(4))
            if day not in jpgs:
                continue
            if my is None:
                if not s:
                    raise SystemExit(f"{f['sub']}: no Mars year in {ls_name} and none in the summary table")
                my = s[0] if (s[0] == s[2] or ls >= s[1] - 1) else s[2]
            days.append([day, round(ls, 2), int(my), cov[day]])
        days.sort()
        subs[f["sub"]] = {"id": f["id"], "bytes": f["bytes"], "md5": f.get("md5"), "member": jpgs[days[0][0]].rsplit("_day", 1)[0] + "_day{:02d}.jpg",
                          "days": days}
        print(f"  {f['sub']}: {len(days)} maps, MY {days[0][2]} Ls {days[0][1]} to MY {days[-1][2]} Ls {days[-1][1]}, "
              f"{sum(d[3] < 0.6 for d in days)} under 60 % coverage")
    n = sum(len(v["days"]) for v in subs.values())
    years = sorted({d[2] for v in subs.values() for d in v["days"]})
    out = {"what": "MRO MARCI Mars Daily Global Maps, version 1: one colour mosaic of the whole planet per sol (~3 pm local time)",
           "cite": "Wang H. & Richardson M.I. 2015, Icarus 251, 112-127; Wang H. & Wheeler J., MRO MARCI Mars Daily Global Maps V1, "
                   "Harvard Dataverse, doi:10.7910/DVN/G2VENZ (CC0). Images: NASA/JPL-Caltech/MSSS",
           "doi": "https://doi.org/10.7910/DVN/G2VENZ", "licence": "CC0 1.0",
           "download": f"{API}/access/datafile/{{id}}",
           "grid": {"w": 3600, "h": 1800, "deg_per_px": 0.1, "lon0": -180.0, "lat0": 90.0},
           "built": time.strftime("%Y-%m-%d"), "tool": "tools/build_marci_index.py",
           "maps": n, "years": years,
           "days_format": "[day, Ls, Mars year, coverage]: coverage = share of 60 S - 60 N with data (polar night not counted)",
           "subphases": subs}
    with open(OUT, "w") as o:
        json.dump(out, o, separators=(",", ":"))
    print(f"  wrote {os.path.relpath(OUT, ROOT)}: {n} daily maps, Mars years {years}, {os.path.getsize(OUT) / 1e3:.0f} kB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
