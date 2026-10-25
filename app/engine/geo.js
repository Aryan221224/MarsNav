// geo.js - Mars geodesy used everywhere in the engine.
// All products are equirectangular on the Mars 2000 IAU sphere (R = 3 396 190 m). Each site's grids use a standard
// parallel close to the site latitude (read from its manifest by terrain.js -> setProjection), so the projection is
// nearly conformal there: grid cells are square on the ground and a metre on the grid is a metre on Mars (< 0.1 %
// scale error in a 30 km operations area). Default: JPL "Jezero_Crater_Projection" (standard parallel 18.4663 deg).

export const R_MARS = 3396190.0; // m
export const G_MARS = 3.72076; // m/s^2
export const G_EARTH = 9.80665; // m/s^2
export const DEG = Math.PI / 180;
export let LAT_TS = 18.4663; // deg, standard parallel of the working projection (live binding)
export let CLON = 0; // deg, central meridian of the working projection (0 for the original sites; the site longitude
//                      for sites generated anywhere on Mars, so a site straddling 180 deg stays one continuous grid)
export let KX = R_MARS * Math.cos(LAT_TS * DEG); // m per radian of longitude in the working projection

/** Switch the working projection (called once per site from the manifest). */
export function setProjection(latTs, clon = 0) {
  LAT_TS = latTs;
  CLON = clon || 0;
  KX = R_MARS * Math.cos(LAT_TS * DEG);
}

/** Longitude difference folded into [-180, 180). */
export const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

export function lonlatToXY(lon, lat) {
  return [KX * (CLON ? wrap180(lon - CLON) : lon) * DEG, R_MARS * lat * DEG];
}

export function xyToLonLat(x, y) {
  const lon = x / KX / DEG;
  return [CLON ? wrap180(lon + CLON) : lon, y / R_MARS / DEG];
}

export function haversine(lon1, lat1, lon2, lat2) {
  const p1 = lat1 * DEG, p2 = lat2 * DEG;
  const dp = p2 - p1, dl = (lon2 - lon1) * DEG;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_MARS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing (deg clockwise from north) from point 1 to point 2. */
export function bearing(lon1, lat1, lon2, lat2) {
  const p1 = lat1 * DEG, p2 = lat2 * DEG, dl = (lon2 - lon1) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

/**
 * A north-up raster grid in the working projection. (x0, y0) is the top-left corner of cell (0, 0).
 * Cell index i = row * width + col.
 */
export class Grid {
  constructor({ x0, y0, res, width, height, name = "" }) {
    Object.assign(this, { x0, y0, res, width, height, name });
    this.n = width * height;
  }

  static fromJSON(j) {
    return new Grid(j);
  }

  toJSON() {
    const { x0, y0, res, width, height, name } = this;
    return { x0, y0, res, width, height, name };
  }

  idx(r, c) {
    return r * this.width + c;
  }

  rc(i) {
    return [Math.floor(i / this.width), i % this.width];
  }

  inside(r, c) {
    return r >= 0 && c >= 0 && r < this.height && c < this.width;
  }

  cellXY(r, c) {
    return [this.x0 + (c + 0.5) * this.res, this.y0 - (r + 0.5) * this.res];
  }

  cellLonLat(r, c) {
    return xyToLonLat(...this.cellXY(r, c));
  }

  /** Fractional (row, col) of a lon/lat; cell centres are at integer values. */
  rcOfLonLat(lon, lat) {
    const [x, y] = lonlatToXY(lon, lat);
    return [(this.y0 - y) / this.res - 0.5, (x - this.x0) / this.res - 0.5];
  }

  idxOfXY(x, y) {
    const r = Math.round((this.y0 - y) / this.res - 0.5), c = Math.round((x - this.x0) / this.res - 0.5);
    return this.inside(r, c) ? this.idx(r, c) : -1;
  }

  idxOfLonLat(lon, lat) {
    const [r, c] = this.rcOfLonLat(lon, lat);
    const ri = Math.round(r), ci = Math.round(c);
    return this.inside(ri, ci) ? this.idx(ri, ci) : -1;
  }

  /** Bilinear sample of a per-cell array at fractional (r, c); NaN outside. */
  sample(arr, r, c) {
    if (r < 0 || c < 0 || r > this.height - 1 || c > this.width - 1) return NaN;
    const r0 = Math.floor(r), c0 = Math.floor(c);
    const r1 = Math.min(r0 + 1, this.height - 1), c1 = Math.min(c0 + 1, this.width - 1);
    const fr = r - r0, fc = c - c0, w = this.width;
    const a = arr[r0 * w + c0], b = arr[r0 * w + c1], d = arr[r1 * w + c0], e = arr[r1 * w + c1];
    return (a * (1 - fc) + b * fc) * (1 - fr) + (d * (1 - fc) + e * fc) * fr;
  }

  /** Map this grid's cell (r, c) to the fractional cell of another grid. */
  toGrid(other, r, c) {
    const [x, y] = this.cellXY(r, c);
    return [(other.y0 - y) / other.res - 0.5, (x - other.x0) / other.res - 0.5];
  }
}
