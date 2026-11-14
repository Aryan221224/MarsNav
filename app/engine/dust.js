// dust.js - the seasonal dust climatology (tools/build_dust.py -> app/data/global/dust_cdod.{json,bin.gz}).
// Source: the Mars Climate Database dust scenarios, MY 24-36 (Montabone et al. 2015, 2020; CC BY-SA 3.0): daily
// 9.3 um absorption column dust optical depth (CDOD) normalised to 610 Pa. Stored: the 10th, 50th and 90th percentile
// of every sol of every year in each 10 deg Ls bin (3 deg grid), and each year's own bin means (6 deg grid).
// tauVisible() turns the stored value into what the Sun and the crew see at a place: x 2.6 (visible band) and
// x p / 610 Pa (the local air column), both conversions from the source.
// Works in the browser and in Node through the same I/O adapter as terrain.js (json + gz).

const STATS = ["p10", "p50", "p90"];

export class DustClimatology {
  constructor(meta, bytes) {
    this.meta = meta;
    this.q = bytes;
    const g = meta.grid;
    this.nlat = g.nlat; this.nlon = g.nlon; this.step = g.step_deg; this.lat0 = g.lat[0]; this.lon0 = g.lon[0];
    this.nbin = meta.ls_bins.n; this.binW = meta.ls_bins.width_deg;
    this.tauMax = meta.encoding.tau_max;
    this.yOff = meta.years.offset;
    this.yg = meta.years.grid;
    this.years = meta.years.list;
    this.visibleFactor = meta.use.visible_factor;
    this.pRef = meta.use.pressure_ref_pa;
  }

  /** Load from a data folder: io = browserIO(new URL("global/", dataRoot)) or nodeIO(".../app/data/global"). */
  static async load(io) {
    const meta = await io.json("dust_cdod.json");
    const bytes = await io.gz(meta.file);
    return new DustClimatology(meta, bytes);
  }

  _dec(q) { return q === 255 ? NaN : this.tauMax * (q / 254) ** 2; }

  // bilinear on a grid of points (lat from north, lon from lon0 east, periodic), one Ls bin
  _bil(off, nlat, nlon, lat0, lon0, step, lon, lat) {
    const fi = Math.max(0, Math.min(nlat - 1, (lat0 - lat) / step));
    const i0 = Math.min(nlat - 2, Math.floor(fi)), di = Math.min(1, fi - i0);
    const fj = ((((lon - lon0) / step) % nlon) + nlon) % nlon;
    const j0 = Math.floor(fj) % nlon, j1 = (j0 + 1) % nlon, dj = fj - Math.floor(fj);
    const v = (i, j) => this._dec(this.q[off + i * nlon + j]);
    return (v(i0, j0) * (1 - dj) + v(i0, j1) * dj) * (1 - di) + (v(i0 + 1, j0) * (1 - dj) + v(i0 + 1, j1) * dj) * di;
  }

  // the two Ls bins around Ls and the weight of the second (bins are centred at 5, 15, ... 355 deg)
  _lsBins(Ls) {
    const u = ((((Ls % 360) + 360) % 360) - this.binW / 2) / this.binW;
    const k = Math.floor(u);
    return [((k % this.nbin) + this.nbin) % this.nbin, (((k + 1) % this.nbin) + this.nbin) % this.nbin, u - k];
  }

  /** 9.3 um absorption CDOD at 610 Pa (the stored quantity) at a place and season. stat: "p10" | "p50" | "p90". */
  cdod(lon, lat, Ls, stat = "p50") {
    const s = STATS.indexOf(stat);
    if (s < 0) throw new Error(`unknown statistic ${stat}`);
    const [k0, k1, w] = this._lsBins(Ls), plane = this.nlat * this.nlon;
    const at = (k) => this._bil((s * this.nbin + k) * plane, this.nlat, this.nlon, this.lat0, this.lon0, this.step, lon, lat);
    return at(k0) * (1 - w) + at(k1) * w;
  }

  /** Visible-band column optical depth the crew and the solar panels see: 2.6 x CDOD x (local pressure / 610 Pa). */
  tauVisible(lon, lat, Ls, { stat = "p50", pressurePa = this.pRef } = {}) {
    return this.visibleFactor * this.cdod(lon, lat, Ls, stat) * pressurePa / this.pRef;
  }

  /** One Mars year's own mean in the Ls bin (6 deg grid), as CDOD at 610 Pa; NaN where the source has no observations. */
  yearCdod(lon, lat, Ls, my) {
    const y = this.years.indexOf(my);
    if (y < 0) return NaN;
    const G = this.yg, plane = G.nlat * G.nlon;
    const [k0, k1, w] = this._lsBins(Ls);
    const at = (k) => this._bil(this.yOff + (y * this.nbin + k) * plane, G.nlat, G.nlon, G.lat0, G.lon0, G.step_deg, lon, lat);
    return at(k0) * (1 - w) + at(k1) * w;
  }

  /** The year at a place, every `step` deg of Ls: [{Ls, p10, p50, p90}] as visible optical depth at pressurePa. */
  seasonCurve(lon, lat, { pressurePa = this.pRef, step = 5 } = {}) {
    const out = [];
    for (let Ls = 0; Ls <= 360 + 1e-9; Ls += step) {
      const o = { Ls };
      for (const s of STATS) o[s] = this.tauVisible(lon, lat, Ls, { stat: s, pressurePa });
      out.push(o);
    }
    return out;
  }

  /** One year's curve (visible optical depth at pressurePa): [{Ls, tau}] (tau NaN where not observed). */
  yearCurve(lon, lat, my, { pressurePa = this.pRef, step = 10 } = {}) {
    const out = [];
    for (let Ls = 0; Ls <= 360 + 1e-9; Ls += step) out.push({ Ls, tau: this.visibleFactor * this.yearCdod(lon, lat, Ls, my) * pressurePa / this.pRef });
    return out;
  }

  /** Mars years with a planet-encircling dust storm in the record, and the storm list with their peaks. */
  get stormYears() { return this.meta.global_storm_years; }
  get storms() { return this.meta.storms; }
  get cite() { return this.meta.cite; }
}

/** Mean surface pressure at a MOLA elevation (610 Pa at the datum, 11.1 km scale height; as planet/assess.py). */
export const pressureFromElev = (elevM) => 610 * Math.exp(-elevM / 11100);
