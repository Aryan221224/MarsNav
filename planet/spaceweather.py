"""Space weather for an EVA: NASA's DONKI (Space Weather Database Of Notifications, Knowledge, Information, at the
Community Coordinated Modeling Center) with what it means at Mars.

  WSAEnlilSimulations  CME arrival forecasts from the WSA-ENLIL model; each lists the bodies it hits, Mars included
  CME                  coronal mass ejections and their analyses
  SEP                  solar energetic particle events (the radiation storms that matter for a suit)
  FLR                  solar flares with their class and source location

Read through api.nasa.gov (a key from MM_NASA_API_KEY or data_cache/planet/nasa_api_key.txt, else NASA's DEMO_KEY,
30 requests an hour), falling back to the CCMC server itself. The last answer is kept on disk, so Mars mode and an
offline computer still show it, with its age. DONKI is built from spacecraft near Earth and at L1 (and STEREO-A): a
particle event seen there reaches Mars only if Mars is magnetically connected to the same solar region, so the summary
gives the Sun-Earth-Mars angle, and the advisory is a heuristic stated as such, not a forecast.
"""
from __future__ import annotations

import json
import math
import os
import time
from datetime import datetime, timedelta, timezone

from . import net
from .config import PATHS

KINDS = ("WSAEnlilSimulations", "CME", "SEP", "FLR")
API = "https://api.nasa.gov/DONKI/{kind}?startDate={s}&endDate={e}&api_key={key}"
CCMC = "https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get/{kind}?startDate={s}&endDate={e}"
STALE_S = 3 * 3600                      # refresh at most every 3 hours (DEMO_KEY allows 30 requests an hour)


def _file():
    return PATHS["cache"] / "spaceweather.json"


def _key() -> str:
    k = os.environ.get("MM_NASA_API_KEY", "").strip()
    if not k:
        try:
            k = (PATHS["cache"] / "nasa_api_key.txt").read_text().strip()
        except OSError:
            k = ""
    return k or "DEMO_KEY"


def _iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%d")


def _parse_t(s) -> datetime | None:
    """DONKI times: '2026-10-20T14:36Z', with seconds, or a bare date."""
    if not s:
        return None
    s = str(s).strip().rstrip("Z")
    for fmt, n in (("%Y-%m-%dT%H:%M:%S", 19), ("%Y-%m-%dT%H:%M", 16), ("%Y-%m-%d", 10)):
        try:
            return datetime.strptime(s[:n], fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def refresh(days: int = 30, log=print) -> dict:
    """Fetch every kind for the last `days` days (and arrivals forecast up to a week ahead); keep the result on disk."""
    now = datetime.now(timezone.utc)
    s, e = _iso(now - timedelta(days=days)), _iso(now + timedelta(days=7))
    got, errors, via = {}, {}, {}
    for kind in KINDS:
        for name, url in (("api.nasa.gov", API.format(kind=kind, s=s, e=e, key=_key())), ("ccmc", CCMC.format(kind=kind, s=s, e=e))):
            try:
                raw = net.get(url, timeout=40, retries=1)
                data = json.loads(raw.decode("utf-8", "replace") or "[]")
                if isinstance(data, dict) and data.get("error"):
                    raise ValueError(str(data["error"])[:160])
                got[kind] = data if isinstance(data, list) else []
                via[kind] = name
                break
            except Exception as ex:  # noqa: BLE001 - try the other server, then report
                errors[f"{kind} via {name}"] = f"{type(ex).__name__}: {ex}"[:200]
        log(f"DONKI {kind}: {len(got.get(kind, []))} records" + (f" via {via[kind]}" if kind in via else " (not available)"))
    doc = {"fetched_utc": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "fetched_s": time.time(), "window": [s, e], "data": got, "via": via,
           "errors": errors}
    if got:
        old = _load()
        if old and set(old.get("data", {})) - set(got):          # keep kinds this refresh could not get
            for k in set(old["data"]) - set(got):
                doc["data"][k] = old["data"][k]
                doc.setdefault("kept_from_previous", []).append(k)
        tmp = _file().with_suffix(".tmp")
        tmp.write_text(json.dumps(doc))
        os.replace(tmp, _file())
    return {"ok": bool(got), "kinds": list(got), "errors": errors}


def _load() -> dict | None:
    try:
        return json.loads(_file().read_text())
    except (OSError, ValueError):
        return None


# ------------------------------------------------------------------ Sun-Earth-Mars geometry (JPL approximate elements)

_KEPLER = {   # a, e, I, L, long. perihelion, long. node and their rates per century (Standish, JPL; as engine/marstime.js)
    "earth": [1.00000261, 0.00000562, 0.01671123, -0.00004392, -0.00001531, -0.01294668, 100.46457166, 35999.37244981,
              102.93768193, 0.32327364, 0.0, 0.0],
    "mars": [1.52371034, 0.00001847, 0.0933941, 0.00007882, 1.84969142, -0.00813131, -4.55343205, 19140.30268499,
             -23.94362959, 0.44441088, 49.55953891, -0.29257343],
}


def _helio(el, T):
    D = math.pi / 180
    a, e, I = el[0] + el[1] * T, el[2] + el[3] * T, (el[4] + el[5] * T) * D
    L, varpi, Om = el[6] + el[7] * T, el[8] + el[9] * T, el[10] + el[11] * T
    w, O = (varpi - Om) * D, Om * D
    M = ((((L - varpi) % 360) + 540) % 360 - 180) * D
    E = M + e * math.sin(M)
    for _ in range(8):
        E -= (E - e * math.sin(E) - M) / (1 - e * math.cos(E))
    xp, yp = a * (math.cos(E) - e), a * math.sqrt(1 - e * e) * math.sin(E)
    cw, sw, cO, sO, cI = math.cos(w), math.sin(w), math.cos(O), math.sin(O), math.cos(I)
    return ((cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp, (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp)


def geometry(when: datetime | None = None) -> dict:
    """Heliocentric longitudes of Earth and Mars, the angle between them seen from the Sun, distance and light time."""
    when = when or datetime.now(timezone.utc)
    jd = when.timestamp() / 86400 + 2440587.5 + 69.184 / 86400           # TT ~ UTC + 69.2 s
    T = (jd - 2451545.0) / 36525
    ex, ey = _helio(_KEPLER["earth"], T)
    mx, my = _helio(_KEPLER["mars"], T)
    le, lm = math.degrees(math.atan2(ey, ex)) % 360, math.degrees(math.atan2(my, mx)) % 360
    ang = (lm - le + 540) % 360 - 180                 # + : Mars ahead of Earth (east of the Sun-Earth line, seen from north)
    au = math.hypot(mx - ex, my - ey)
    return {"earth_lon_deg": round(le, 1), "mars_lon_deg": round(lm, 1), "mars_minus_earth_deg": round(ang, 1),
            "separation_deg": round(abs(ang), 1), "distance_au": round(au, 3), "light_min": round(au * 149597870.7 / 299792.458 / 60, 1),
            "conjunction": abs(ang) > 160, "note": "Earth-side spacecraft see the half of the Sun that faces Earth; at large separations "
                                                  "Mars faces regions Earth cannot see, and DONKI may miss events that reach Mars."}


# ------------------------------------------------------------------ what it means for an EVA

def summary(now: datetime | None = None, days: int = 30) -> dict:
    """Mars-relevant digest of the stored DONKI data, with an EVA advisory (quiet / watch / storm) and its reasons."""
    now = now or datetime.now(timezone.utc)
    doc = _load()
    geo = geometry(now)
    out = {"ok": True, "have_data": doc is not None, "geometry": geo, "now_utc": now.strftime("%Y-%m-%dT%H:%MZ"),
           "source": "NASA CCMC DONKI (api.nasa.gov / kauai.ccmc.gsfc.nasa.gov)", "advisory": None}
    if doc is None:
        out.update(level="unknown", headline="No space-weather data on this computer yet",
                   reasons=["Connect to the internet once (Landing mode or the planner fetch it), or install a Local mode pack."])
        return out
    age_h = (time.time() - doc.get("fetched_s", 0)) / 3600
    out.update(fetched_utc=doc.get("fetched_utc"), age_h=round(age_h, 1), via=doc.get("via"), errors=doc.get("errors"),
               stale=age_h * 3600 > STALE_S)
    D = doc.get("data", {})
    # CME arrivals at Mars from the WSA-ENLIL runs (the most recent run per CME wins)
    arrivals = {}
    for sim in D.get("WSAEnlilSimulations", []) or []:
        for imp in sim.get("impactList") or []:
            if "mars" not in str(imp.get("location", "")).lower():
                continue
            t = _parse_t(imp.get("arrivalTime"))
            if t is None:
                continue
            cmes = [c.get("cmeid") or c.get("activityID") for c in sim.get("cmeInputs") or [] if isinstance(c, dict)]
            speed = max([float(c.get("speed") or 0) for c in sim.get("cmeInputs") or [] if isinstance(c, dict)] or [0])
            key = ",".join(sorted(x for x in cmes if x)) or sim.get("simulationID")
            done = _parse_t(sim.get("modelCompletionTime")) or t
            prev = arrivals.get(key)
            if prev is None or done > prev["_done"]:
                arrivals[key] = {"arrival_utc": t.strftime("%Y-%m-%dT%H:%MZ"), "glancing": bool(imp.get("isGlancingBlow")),
                                 "cme": [x for x in cmes if x], "speed_kms": round(speed) or None, "link": sim.get("link"),
                                 "hours_from_now": round((t - now).total_seconds() / 3600, 1), "_done": done}
    arr = sorted(arrivals.values(), key=lambda a: a["arrival_utc"])
    for a in arr:
        a.pop("_done", None)
    sep = []
    for ev in D.get("SEP", []) or []:
        t = _parse_t(ev.get("eventTime"))
        if t is None:
            continue
        sep.append({"time_utc": t.strftime("%Y-%m-%dT%H:%MZ"), "hours_ago": round((now - t).total_seconds() / 3600, 1),
                    "instruments": [i.get("displayName") for i in ev.get("instruments") or [] if isinstance(i, dict)], "link": ev.get("link")})
    sep.sort(key=lambda x: x["time_utc"], reverse=True)
    flr = []
    for ev in D.get("FLR", []) or []:
        t = _parse_t(ev.get("peakTime") or ev.get("beginTime"))
        cls = str(ev.get("classType") or "")
        if t is None or not cls[:1] in ("M", "X"):
            continue
        flr.append({"peak_utc": t.strftime("%Y-%m-%dT%H:%MZ"), "class": cls, "source": ev.get("sourceLocation"),
                    "hours_ago": round((now - t).total_seconds() / 3600, 1), "link": ev.get("link")})
    flr.sort(key=lambda x: x["peak_utc"], reverse=True)
    out.update(mars_arrivals=arr, sep=sep[:12], flares=flr[:12], counts={k: len(D.get(k) or []) for k in KINDS})
    # advisory heuristic [ASSUME]: thresholds stated so a crew can see why
    level, reasons = "quiet", []
    sep48 = [x for x in sep if 0 <= x["hours_ago"] <= 48]
    hit_now = [a for a in arr if -24 <= a["hours_from_now"] <= 24 and not a["glancing"]]
    soon = [a for a in arr if 0 < a["hours_from_now"] <= 72]
    if sep48 and geo["separation_deg"] <= 60:
        level = "storm"
        reasons.append(f"Solar particle event {sep48[0]['hours_ago']:.0f} h ago, and Mars is within {geo['separation_deg']:.0f} deg of Earth "
                       "as seen from the Sun (likely the same magnetic connection)")
    if hit_now:
        level = "storm"
        reasons.append(f"CME shock predicted at Mars {hit_now[0]['arrival_utc']} (WSA-ENLIL): particle flux and dose can rise for a day or more")
    if level != "storm":
        if soon:
            level = "watch"
            reasons.append(f"CME predicted to reach Mars in {soon[0]['hours_from_now']:.0f} h ({'glancing blow' if soon[0]['glancing'] else 'direct'})")
        if sep48:
            level = "watch"
            reasons.append(f"Solar particle event {sep48[0]['hours_ago']:.0f} h ago near Earth; Mars is {geo['separation_deg']:.0f} deg away "
                           "(connection uncertain)")
        xfl = [f for f in flr if f["class"].startswith("X") and f["hours_ago"] <= 24]
        if xfl:
            level = "watch"
            reasons.append(f"{xfl[0]['class']} flare {xfl[0]['hours_ago']:.0f} h ago")
    if geo["conjunction"]:
        reasons.append("Mars is near solar conjunction: Earth-side monitors cannot see the solar regions facing Mars")
    if out.get("stale"):
        reasons.append(f"Data are {age_h:.0f} h old")
    if not reasons:
        reasons.append("No solar particle event in 48 h and no CME forecast to reach Mars in 72 h")
    action = {"quiet": "EVA as planned.",
              "watch": "Plan shorter EVAs that stay within a short drive or walk of shelter; recheck before egress.",
              "storm": "Hold EVAs or return to shelter (habitat or pressurised rover). The September 2017 event more than doubled the "
                       "surface dose rate Curiosity's RAD measured; larger events can be far stronger."}[level]
    out.update(level=level, headline={"quiet": "Space weather quiet", "watch": "Space weather watch", "storm": "Radiation storm risk"}[level],
               reasons=reasons, action=action,
               basis="Heuristic on DONKI events: SEP within 48 h with Mars within 60 deg of Earth, or a WSA-ENLIL CME arrival at Mars within "
                     "24 h = storm; a forecast arrival within 72 h, a distant SEP or an X flare in 24 h = watch [ASSUME].")
    return out


def ensure_fresh(log=print) -> None:
    """Refresh in the background when the stored data are stale and the internet is allowed."""
    doc = _load()
    if net.blocked() or (doc and time.time() - doc.get("fetched_s", 0) < STALE_S):
        return
    import threading
    threading.Thread(target=lambda: refresh(log=lambda m: None), daemon=True, name="spaceweather").start()
