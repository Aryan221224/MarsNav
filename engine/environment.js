// environment.js - the time-dependent environment: Sun, shadows, temperature, pressure, dust.
// Temperature and pressure come from a harmonic climatology fitted to real Perseverance MEDA measurements
// (pipeline/fit_meda.py -> app/data/environment.json). Sun position is Mars24 (marstime.js).
// Terrain shadowing uses the precomputed horizon angles (16 azimuth sectors, 40 m grid, Mars curvature included).

import { marsState, sunPosition, ltstHours, solarConstant } from "./marstime.js";
import { DEG } from "./geo.js";

export class Environment {
  /**
   * @param terrain Terrain
   * @param clim    fitted climatology JSON (environment.json) or null for the built-in fallback
   * @param opts    { tau: dust optical depth (0.45 typical Jezero, 5 global storm) }
   */
  constructor(terrain, clim = null, opts = {}) {
    this.T = terrain;
    this.clim = clim;
    this.tau = opts.tau ?? clim?.tau_typical ?? 0.45;
    const [lon, lat] = terrain.grid.cellLonLat(terrain.grid.height / 2, terrain.grid.width / 2);
    this.lon = lon;
    this.lat = lat;
    this._sunCache = new Map();
    this._shadeCache = new Map();
  }

  /** Sun and local time at the site centre; cached per 5 minutes of Earth time. */
  sun(ms) {
    const key = Math.round(ms / 300000);
    let s = this._sunCache.get(key);
    if (!s) {
      const st = marsState(2440587.5 + (key * 300000) / 8.64e7 + 69.184 / 86400);
      const pos = sunPosition(st, this.lon, this.lat);
      s = { ...pos, ltst: ltstHours(st, this.lon), Ls: st.Ls, S0: solarConstant(st) };
      this._sunCache.set(key, s);
      if (this._sunCache.size > 5000) this._sunCache.clear();
    }
    return s;
  }

  /** Direct solar irradiance on a surface normal to the beam (W/m^2), Beer-Lambert through dust. */
  directBeam(ms) {
    const s = this.sun(ms);
    if (s.elevation <= 0) return 0;
    const mu = Math.sin(s.elevation * DEG);
    return s.S0 * Math.exp(-this.tau / Math.max(mu, 0.05));
  }

  /** Global horizontal irradiance (W/m^2): direct + a diffuse term that grows with dust. */
  ghi(ms) {
    const s = this.sun(ms);
    if (s.elevation <= 0) return 0;
    const mu = Math.sin(s.elevation * DEG);
    const direct = s.S0 * mu * Math.exp(-this.tau / Math.max(mu, 0.05));
    const diffuse = s.S0 * mu * 0.35 * (1 - Math.exp(-this.tau / Math.max(mu, 0.05))); // [ASSUME] forward-scattering dust
    return direct + diffuse;
  }

  /** Is the 40 m horizon cell j in terrain shadow at time ms? */
  shadedHz(j, ms) {
    const s = this.sun(ms);
    if (s.elevation <= 0) return true;
    const T = this.T, K = T.sectors;
    const f = (s.azimuth / 360) * K;
    const k0 = Math.floor(f) % K, k1 = (k0 + 1) % K, w = f - Math.floor(f);
    const h = (1 - w) * T.horizon(k0, j) + w * T.horizon(k1, j);
    return s.elevation < h;
  }

  /** Shade mask for a whole plan grid at time ms (cached per 10 min). */
  shadeMask(grid, ms) {
    const key = `${grid.res}:${Math.round(ms / 600000)}`;
    let m = this._shadeCache.get(key);
    if (m) return m;
    m = new Uint8Array(grid.n);
    const hz = this.T.hzGrid;
    for (let r = 0; r < grid.height; r++) {
      for (let c = 0; c < grid.width; c++) {
        const [hr, hc] = grid.toGrid(hz, r, c);
        const rr = Math.max(0, Math.min(hz.height - 1, Math.round(hr)));
        const cc = Math.max(0, Math.min(hz.width - 1, Math.round(hc)));
        m[r * grid.width + c] = this.shadedHz(rr * hz.width + cc, ms) ? 1 : 0;
      }
    }
    if (this._shadeCache.size > 64) this._shadeCache.clear();
    this._shadeCache.set(key, m);
    return m;
  }

  _harm(coef, ltst, Ls) {
    // coef: { terms: [[kLs, kH, kind]], beta: [...] } design matrix built identically in fit_meda.py
    let v = 0;
    const h = (2 * Math.PI * ltst) / 24, l = Ls * DEG;
    for (let i = 0; i < coef.terms.length; i++) {
      const [a, b] = coef.terms[i];
      // term = cos/sin(a*l) * cos/sin(b*h) encoded as a = +-n (cos for +, sin for -), same for b
      const fl = a === 0 ? 1 : a > 0 ? Math.cos(a * l) : Math.sin(-a * l);
      const fh = b === 0 ? 1 : b > 0 ? Math.cos(b * h) : Math.sin(-b * h);
      v += coef.beta[i] * fl * fh;
    }
    return v;
  }

  /** Near-surface air temperature (K) at local true solar time ltst (h) and season Ls (deg): MEDA ATS sensors
   * (0.85-1.45 m above ground, about suit height) when the fitted climatology is present. */
  airTempK(ltst, Ls) {
    if (this.clim?.ats) return this._harm(this.clim.ats, ltst, Ls);
    if (this.clim?.air) return this._harm(this.clim.air, ltst, Ls);
    // fallback: Jezero-like diurnal cycle, 200-250 K [research doc 26]
    return 222 + 25 * Math.cos((2 * Math.PI * (ltst - 14)) / 24);
  }

  groundTempK(ltst, Ls) {
    if (this.clim?.ground) return this._harm(this.clim.ground, ltst, Ls);
    return 225 + 40 * Math.cos((2 * Math.PI * (ltst - 13)) / 24);
  }

  /** Surface pressure (Pa) at a site elevation (m, DEM datum): MEDA fit, hydrostatic with the fitted scale height. */
  pressurePa(ltst, Ls, elevM = -2550) {
    const c = this.clim;
    if (c?.pressure) {
      const lnp0 = this._harm(c.pressure, ltst, Ls);
      return Math.exp(lnp0 - (elevM - (c.pressure_zref_m ?? -2550)) / (c.pressure_scale_height_m ?? 11000));
    }
    return 730 * Math.exp(-(elevM + 2550) / 11000);
  }

  /** Effective environment temperature for suit heat loss (K): mean of air and ground, 10 K colder in shade [ASSUME].
   * Cached per 5-minute bucket (the climatology is smooth in time). */
  envTempK(ms, shaded) {
    const key = Math.round(ms / 300000);
    let t = this._tCache?.get(key);
    if (t === undefined) {
      if (!this._tCache || this._tCache.size > 5000) this._tCache = new Map();
      const s = this.sun(key * 300000);
      t = 0.5 * (this.airTempK(s.ltst, s.Ls) + this.groundTempK(s.ltst, s.Ls));
      this._tCache.set(key, t);
    }
    return shaded ? t - 10 : t;
  }

  /** Direct beam cached per 5-minute bucket. */
  directBeamCached(ms) {
    const key = Math.round(ms / 300000);
    let b = this._bCache?.get(key);
    if (b === undefined) {
      if (!this._bCache || this._bCache.size > 5000) this._bCache = new Map();
      b = this.directBeam(key * 300000);
      this._bCache.set(key, b);
    }
    return b;
  }

  /** Dust-devil activity index 0..1 by local time: Jezero devils peak late morning to early afternoon [research doc 26]. */
  dustDevilIndex(ms) {
    const h = this.sun(ms).ltst;
    return Math.max(0, Math.cos((Math.PI * (h - 12.5)) / 7)) ** 2;
  }

  /** Earth ms of the next sunset (sun elevation crossing 0) after ms, searching up to 1.2 sols. */
  nextSunset(ms) {
    let prev = this.sun(ms).elevation;
    for (let t = ms + 300000; t < ms + 1.2 * 88775244; t += 300000) {
      const e = this.sun(t).elevation;
      if (prev > 0 && e <= 0) return t;
      prev = e;
    }
    return ms + 88775244;
  }

  nextSunrise(ms) {
    let prev = this.sun(ms).elevation;
    for (let t = ms + 300000; t < ms + 1.2 * 88775244; t += 300000) {
      const e = this.sun(t).elevation;
      if (prev <= 0 && e > 0) return t;
      prev = e;
    }
    return ms;
  }
}
