// terrain.js - load the pipeline's layers (app/data/manifest.json + *.bin.gz) into typed arrays.
// Works in the browser (fetch + DecompressionStream) and in Node (fs + zlib) through a tiny I/O adapter.

import { Grid, setProjection } from "./geo.js";

const DTYPES = { uint8: Uint8Array, uint16: Uint16Array, int16: Int16Array, float32: Float32Array };

export class Terrain {
  constructor(manifest, raw) {
    this.manifest = manifest;
    this.grid = Grid.fromJSON(manifest.grids.ops10);
    this.hzGrid = Grid.fromJSON(manifest.grids.hz40);
    this.regGrid = Grid.fromJSON(manifest.grids.reg100);
    this.raw = raw; // name -> typed array
    this.meta = manifest.layers;
    this.targets = manifest.targets ?? [];
    this.keepouts = manifest.keepouts ?? [];
    this.landmarks = manifest.landmarks ?? [];
    // site description (v2 manifests); v1 manifests were Jezero-only
    this.site = manifest.site_info ?? { id: "jezero", name: manifest.site, short: "Jezero crater",
      base: (manifest.targets ?? []).find((t) => t.id === "HAB") ?? null, clock: null };
    this.sectors = manifest.horizon?.sectors ?? 16;
    this._f32 = {};
  }

  /** Decoded value of layer `name` at cell i. */
  get(name, i) {
    const m = this.meta[name];
    const v = this.raw[name][i];
    return v === 0 && name.endsWith("elev_dm") ? NaN : v / m.scale - m.offset;
  }

  /** Decoded Float32Array of a whole layer (cached). */
  f32(name) {
    if (this._f32[name]) return this._f32[name];
    const m = this.meta[name], a = this.raw[name];
    const out = new Float32Array(a.length);
    const s = 1 / m.scale, o = m.offset;
    // elevation layers: raw 0 = no data (NaN), whatever the site's offset (sites span -8 km to +21 km)
    const nodata0 = name.endsWith("elev_dm");
    for (let i = 0; i < a.length; i++) out[i] = nodata0 && a[i] === 0 ? NaN : a[i] * s - o;
    this._f32[name] = out;
    return out;
  }

  /** Horizon elevation angle (deg) at 40 m cell j for sector k. */
  horizon(k, j) {
    return this.raw.horizon[k * this.hzGrid.n + j] / this.meta.horizon.scale;
  }
}

export async function loadTerrain(io) {
  const manifest = await io.json("manifest.json");
  if (manifest.projection?.lat_ts != null) setProjection(manifest.projection.lat_ts, manifest.projection.clon ?? 0);
  const raw = {};
  await Promise.all(
    Object.entries(manifest.layers).map(async ([name, m]) => {
      const buf = await io.gz(m.file);
      const T = DTYPES[m.dtype];
      raw[name] = new T(buf.buffer, buf.byteOffset, buf.byteLength / T.BYTES_PER_ELEMENT);
    }),
  );
  return new Terrain(manifest, raw);
}

/** Browser I/O adapter: base URL of the data folder. */
export function browserIO(base) {
  const url = (f) => new URL(f, base).href;
  return {
    json: async (f) => (await fetch(url(f))).json(),
    gz: async (f) => {
      let res = await fetch(url(f)).catch(() => null);
      let body;
      if (res?.ok) body = res.body;
      else {
        // hosts that only serve text (e.g. a published claude.ai artifact) get the same bytes as base64 text
        res = await fetch(url(`${f}.b64.txt`));
        if (!res.ok) throw new Error(`cannot load ${f}`);
        const b64 = (await res.text()).trim();
        const bytes = typeof Uint8Array.fromBase64 === "function" ? Uint8Array.fromBase64(b64) : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        body = new Blob([bytes]).stream();
      }
      const ds = body.pipeThrough(new DecompressionStream("gzip"));
      const buf = await new Response(ds).arrayBuffer();
      return new Uint8Array(buf);
    },
  };
}
