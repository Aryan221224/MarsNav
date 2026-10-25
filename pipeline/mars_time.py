"""
mars_time.py - Python port of engine/marstime.js (NASA GISS Mars24 algorithm, Allison & McEwen 2000).
Used by the pipeline to put MEDA samples on the Mars calendar, and as an independent implementation that the test
suite compares against the JavaScript engine (same inputs must give the same Ls, LMST and solar zenith angle).
"""
import math

DEG = math.pi / 180
PBS = [(0.0071, 2.2353, 49.409), (0.0057, 2.7543, 168.173), (0.0039, 1.1177, 191.837), (0.0037, 15.7866, 21.736),
       (0.0021, 2.1354, 15.704), (0.0020, 2.4694, 95.528), (0.0018, 32.8493, 49.095)]
M2020_LON = 77.45088572
M2020_LAT = 18.44462715
SOL0_MSD_M2020 = 52304   # integer local MSD of sol 0 at the landing longitude (from the landing time; checked in tests)


def jd_tt_from_msd(msd):
    return (msd - 44796.0 + 0.0009626) * 1.0274912517 + 2451549.5


def msd_from_jd_tt(jd):
    return (jd - 2451549.5) / 1.0274912517 + 44796.0 - 0.0009626


def mars_state(jd):
    dt = jd - 2451545.0
    M = (19.3871 + 0.52402073 * dt) % 360
    a_fms = (270.3871 + 0.524038496 * dt) % 360
    pbs = sum(A * math.cos(DEG * (0.985626 * dt / tau + phi)) for A, tau, phi in PBS)
    Mr = M * DEG
    nu_m = ((10.691 + 3.0e-7 * dt) * math.sin(Mr) + 0.623 * math.sin(2 * Mr) + 0.05 * math.sin(3 * Mr)
            + 0.005 * math.sin(4 * Mr) + 0.0005 * math.sin(5 * Mr) + pbs)
    Ls = (a_fms + nu_m) % 360
    Lr = Ls * DEG
    eot = 2.861 * math.sin(2 * Lr) - 0.071 * math.sin(4 * Lr) + 0.002 * math.sin(6 * Lr) - nu_m
    msd = msd_from_jd_tt(jd)
    mtc = (24 * msd) % 24
    sub_w = (mtc * 15 + eot + 180) % 360
    decl = math.asin(0.42565 * math.sin(Lr)) / DEG + 0.25 * math.sin(Lr)
    return {"Ls": Ls, "EOT": eot, "MTC": mtc, "subsolar_lon_east": (360 - sub_w) % 360, "decl": decl, "msd": msd}


def m2020_state(sol, lmst_hours):
    """State at a Mars 2020 mission sol and LMST (hours, at the landing longitude)."""
    local = SOL0_MSD_M2020 + sol + lmst_hours / 24.0
    msd = local - M2020_LON / 360.0
    return mars_state(jd_tt_from_msd(msd))


def sun(state, lon_east, lat):
    H = (lon_east - state["subsolar_lon_east"]) * DEG
    d, p = state["decl"] * DEG, lat * DEG
    s = math.sin(p) * math.sin(d) + math.cos(p) * math.cos(d) * math.cos(H)
    el = math.asin(max(-1.0, min(1.0, s)))
    az = math.atan2(-math.cos(d) * math.sin(H), math.cos(p) * math.sin(d) - math.sin(p) * math.cos(d) * math.cos(H))
    return {"elevation": el / DEG, "zenith": 90 - el / DEG, "azimuth": (az / DEG) % 360}


def ltst_hours(state, lon_east):
    return (state["MTC"] + lon_east / 15 + state["EOT"] / 15) % 24


if __name__ == "__main__":
    import datetime as _dt
    # Mars24 worked example: 2000-01-06 00:00 UTC (TT-UTC = 64.184 s in 2000)
    jd = 2451549.5 + 64.184 / 86400
    st = mars_state(jd)
    print(round(st["Ls"], 5), round(st["EOT"], 5), round(st["MTC"], 5))
    assert abs(st["Ls"] - 277.18758) < 1e-3 and abs(st["MTC"] - 23.99425) < 1e-3
    print("ok")
