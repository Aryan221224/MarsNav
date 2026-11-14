// Tests of the Worldview-style features: dust climatology, relay coverage, measuring, and the GIF / GeoTIFF / KMZ / KML
// writers. Run: node --test tests/
// Expected values come from published sources (Montabone et al. 2015/2020, Lemmon et al. 2015, Guzewich et al. 2019,
// mission orbit fact sheets), from geometry, or from the file-format specifications, not from the code under test.
import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import { DustClimatology, pressureFromElev } from "../engine/dust.js";
import { relayCoverage, RELAY_ORBITERS, hhmm } from "../engine/relay.js";
import { nodeIO } from "../engine/node_io.js";
import { R_KM, distKm, bearingDeg, pathKm, areaKm2, greatCircle, fmtDist, fmtArea } from "../app/js/measure.js";
import { GifEncoder } from "../app/js/gif.js";
import { crc32, geoTiff, zip, kml } from "../app/js/geoexport.js";

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b} +/- ${tol}, got ${a}`);
const GLOBAL = fileURLToPath(new URL("../app/data/global/", import.meta.url));
const D = await DustClimatology.load(nodeIO(GLOBAL));
const DEG = Math.PI / 180;

// ------------------------------------------------------------------------------------------------- dust climatology
test("dust: planet-encircling storms of MY 24-36 are MY 25, 28 and 34 (Montabone et al. 2015, 2020)", () => {
  assert.deepEqual(D.stormYears, [25, 28, 34]);
});

test("dust: visible optical depth = 2.6 x 9.3 um absorption CDOD, scaled with surface pressure (Montabone et al. 2015)", () => {
  const c = D.cdod(77.45, 18.44, 250);
  near(D.tauVisible(77.45, 18.44, 250), 2.6 * c, 1e-12, "610 Pa");
  near(D.tauVisible(77.45, 18.44, 250, { pressurePa: 305 }), 1.3 * c, 1e-12, "half the pressure, half the column");
  near(pressureFromElev(0), 610, 1e-9, "datum");
  near(pressureFromElev(11100), 610 / Math.E, 1e-9, "one scale height");
});

test("dust: percentiles are ordered p10 <= p50 <= p90 everywhere", () => {
  let n = 0;
  for (let lat = -85; lat <= 85; lat += 10) for (let lon = -180; lon < 180; lon += 15) for (let ls = 0; ls < 360; ls += 17) {
    const a = D.cdod(lon, lat, ls, "p10"), b = D.cdod(lon, lat, ls, "p50"), c = D.cdod(lon, lat, ls, "p90");
    assert.ok(a <= b + 1e-9 && b <= c + 1e-9, `${lon},${lat} Ls ${ls}: ${a} ${b} ${c}`);
    n++;
  }
  assert.ok(n > 1000);
});

test("dust: the perihelion season (Ls 180-360) is dustier than the aphelion season at Jezero", () => {
  const mean = (a, b) => { let s = 0, k = 0; for (let L = a; L <= b; L += 5) { s += D.tauVisible(77.45, 18.44, L); k++; } return s / k; };
  const aph = mean(40, 140), per = mean(200, 320);
  assert.ok(per > 1.8 * aph, `aphelion ${aph.toFixed(2)}, perihelion ${per.toFixed(2)}`);
  assert.ok(aph > 0.1 && aph < 0.6, `aphelion-season haze ${aph}`);
});

test("dust: MY 24 starts at Ls ~103 in the record (no data before), and the storm years stand out globally", () => {
  assert.ok(Number.isNaN(D.yearCdod(0, 0, 50, 24)));
  assert.ok(Number.isFinite(D.yearCdod(0, 0, 150, 24)));
  const gm = (my, L) => {
    let s = 0, w = 0;
    for (let la = -87; la <= 87; la += 6) for (let lo = -177; lo <= 177; lo += 6) {
      const v = D.yearCdod(lo, la, L, my); if (Number.isFinite(v)) { const c = Math.cos(la * DEG); s += v * c; w += c; }
    }
    return s / w;
  };
  assert.ok(gm(25, 205) > 3 * gm(24, 205), "MY 25 storm (2001)");
  assert.ok(gm(28, 275) > 2.5 * gm(27, 275), "MY 28 storm (2007)");
  assert.ok(gm(34, 205) > 3 * gm(33, 205), "MY 34 storm (2018)");
});

test("dust: storm peaks at the rovers are of the measured size (Opportunity 4.6-5 in 2007, Curiosity 8.5 in 2018)", () => {
  const peak = (lon, lat, my, p, a, b) => { let m = 0; for (let L = a; L <= b; L += 2) m = Math.max(m, D.visibleFactor * D.yearCdod(lon, lat, L, my) * p / 610); return m; };
  // 10 deg Ls means on a 6 deg grid smooth a peak that lasted days: the bin mean is below the daily peak, above half of it
  const opp = peak(-5.53, -1.95, 28, pressureFromElev(-1400), 240, 300);
  const msl = peak(137.4, -4.6, 34, pressureFromElev(-4500), 180, 240);
  assert.ok(opp > 2.3 && opp < 4.6, `Meridiani MY 28: ${opp}`);
  assert.ok(msl > 4.2 && msl < 8.5, `Gale MY 34: ${msl}`);
});

test("dust: season curve spans the year and agrees with the point values", () => {
  const c = D.seasonCurve(77.45, 18.44, { step: 30 });
  assert.equal(c.length, 13);
  near(c[3].p50, D.tauVisible(77.45, 18.44, 90), 1e-12);
  near(c[0].p50, c[12].p50, 1e-9, "Ls 0 = Ls 360");
});

// ------------------------------------------------------------------------------------------------- relay coverage
const RC0 = relayCoverage(0, { sols: 12, runs: 2, stepS: 20 });
const RC70 = relayCoverage(70, { sols: 12, runs: 2, stepS: 20 });
const at = (r, id) => r.orbiters.find((o) => o.id === id);

test("relay: orbital periods match the published orbits (MRO ~112 min, TGO ~2 h, MEX ~7 h)", () => {
  near(at(RC0, "mro").periodMin, 112, 3, "MRO");
  near(at(RC0, "tgo").periodMin, 118, 4, "TGO");
  near(at(RC0, "mex").periodMin / 60, 7.0, 0.3, "MEX");
  assert.ok(!RELAY_ORBITERS.some((o) => /maven/i.test(o.id)), "MAVEN is not counted (contact lost Dec 2025)");
});

test("relay: MRO (sun-synchronous, ascending node 3 pm) passes near 15:00 and 03:00 local time at the equator", () => {
  const w = at(RC0, "mro").windows;
  assert.equal(w.length, 2, JSON.stringify(w));
  const dist = (h, t) => Math.abs(((h - t + 36) % 24) - 12);
  const centres = w.map((x) => x.centreH);
  assert.ok(centres.some((h) => dist(h, 15) < 1.2), `afternoon window ${centres.map(hhmm)}`);
  assert.ok(centres.some((h) => dist(h, 3) < 1.2), `night window ${centres.map(hhmm)}`);
});

test("relay: pass lengths and rates follow the geometry", () => {
  const mro = at(RC0, "mro"), mex = at(RC0, "mex");
  assert.ok(mro.maxPassMin > 5 && mro.maxPassMin < 12, `MRO longest pass ${mro.maxPassMin} min (300 km orbit, 10 deg mask)`);
  assert.ok(mro.passesPerSol > 1.5 && mro.passesPerSol < 3.5, `MRO ${mro.passesPerSol}/sol at the equator`);
  assert.ok(mex.meanPassMin > 5 * mro.meanPassMin, `MEX ${mex.meanPassMin} min: its 10,500 km apoapsis gives long passes`);
  for (const id of ["mro", "odyssey"]) assert.ok(at(RC70, id).passesPerSol > 1.5 * at(RC0, id).passesPerSol, `${id}: polar orbits converge at high latitude`);
  assert.ok(RC0.minutesPerSol > 0 && Math.abs(RC0.minutesPerSol - RC0.orbiters.reduce((a, o) => a + o.minutesPerSol, 0)) < 1e-9);
});

test("relay: the model is deterministic (same input, same answer)", () => {
  assert.deepEqual(relayCoverage(18.44, { sols: 4, runs: 1 }), relayCoverage(18.44, { sols: 4, runs: 1 }));
});

// ------------------------------------------------------------------------------------------------- measuring
test("measure: distances on the 3396.19 km sphere", () => {
  near(distKm([0, 0], [1, 0]), 2 * Math.PI * R_KM / 360, 1e-9, "1 deg of the equator");
  near(distKm([0, -90], [0, 90]), Math.PI * R_KM, 1e-6, "pole to pole");
  near(distKm([179.5, 0], [-179.5, 0]), 2 * Math.PI * R_KM / 360, 1e-9, "across the date line");
  near(bearingDeg([0, 0], [0, 10]), 0, 1e-9, "north");
  near(bearingDeg([0, 0], [10, 0]), 90, 1e-9, "east");
  const p = pathKm([[0, 0], [1, 0], [1, 1]]);
  assert.equal(p.seg.length, 2);
  near(p.total, p.seg[0] + p.seg[1], 1e-12);
});

test("measure: areas are exact for meridian/parallel boxes and the hemisphere", () => {
  const box = R_KM * R_KM * DEG * (Math.sin(DEG) - 0);
  near(areaKm2([[0, 0], [1, 0], [1, 1], [0, 1]]), box, 1e-6, "1 x 1 deg at the equator");
  near(areaKm2([[179.5, 0], [-179.5, 0], [-179.5, 1], [179.5, 1]]), box, 1e-6, "same box across the date line");
  near(areaKm2([[0, 0], [120, 0], [240, 0]]), 2 * Math.PI * R_KM * R_KM, 1e-3, "a ring along the equator encloses a hemisphere");
  assert.equal(areaKm2([[0, 0], [1, 1]]), 0);
});

test("measure: great circles end on their end points and stay on the sphere's shortest path", () => {
  const g = greatCircle([0, 0], [90, 0], 100);
  assert.deepEqual(g[0].map((v) => +v.toFixed(9)), [0, 0]);
  near(g[g.length - 1][0], 90, 1e-9); near(g[g.length - 1][1], 0, 1e-9);
  const mid = greatCircle([0, 0], [90, 0], distKm([0, 0], [90, 0]) / 2)[1];        // two segments: the midpoint
  near(mid[0], 45, 1e-9); near(mid[1], 0, 1e-9);
  for (const [lo] of greatCircle([30, -40], [30, 50], 50)) near(lo, 30, 1e-9, "a meridian stays a meridian");
  assert.equal(fmtDist(0.25), "250 m"); assert.equal(fmtDist(12.345), "12.35 km"); assert.equal(fmtDist(1234), "1234 km");
  assert.match(fmtArea(0.05), /m² \(5\.00 ha\)/); assert.equal(fmtArea(2.5), "2.50 km²");
});

// ------------------------------------------------------------------------------------------------- GIF (GIF89a spec)
function decodeGif(b) {
  let p = 0;
  const u8 = () => b[p++], u16 = () => { const v = b[p] | (b[p + 1] << 8); p += 2; return v; };
  const sig = String.fromCharCode(...b.slice(0, 6)); p = 6;
  const W = u16(), H = u16(), f = u8(); u8(); u8();
  let gct = null;
  if (f & 0x80) { const n = 2 << (f & 7); gct = b.slice(p, p + 3 * n); p += 3 * n; }
  const frames = []; let loop = false, delay = 0;
  for (;;) {
    const c = u8();
    if (c === 0x3b || c === undefined) break;
    if (c === 0x21) {
      const label = u8();
      if (label === 0xf9) { u8(); u8(); delay = u16(); u8(); u8(); continue; }
      let first = true;
      for (let n = u8(); n; n = u8()) { if (label === 0xff && first && String.fromCharCode(...b.slice(p, p + n)) === "NETSCAPE2.0") loop = true; first = false; p += n; }
      continue;
    }
    assert.equal(c, 0x2c, "image descriptor");
    u16(); u16(); const w = u16(), h = u16(), lf = u8();
    let ct = gct;
    if (lf & 0x80) { const n = 2 << (lf & 7); ct = b.slice(p, p + 3 * n); p += 3 * n; }
    const min = u8(), data = [];
    for (let n = u8(); n; n = u8()) { for (let i = 0; i < n; i++) data.push(b[p + i]); p += n; }
    frames.push({ w, h, delay, ct, idx: lzwDecode(data, min, w * h) });
  }
  return { sig, W, H, frames, loop };
}
function lzwDecode(data, min, npix) {
  const clear = 1 << min, eoi = clear + 1, out = [];
  let size, dict, prev, bit = 0;
  const reset = () => { dict = []; for (let i = 0; i < clear; i++) dict[i] = [i]; dict.push(null, null); size = min + 1; prev = null; };
  reset();
  const read = () => { let v = 0; for (let i = 0; i < size; i++, bit++) v |= ((data[bit >> 3] >> (bit & 7)) & 1) << i; return v; };
  while (bit + size <= data.length * 8 && out.length < npix + 1) {
    const code = read();
    if (code === clear) { reset(); continue; }
    if (code === eoi) break;
    const entry = code < dict.length && dict[code] ? dict[code] : prev ? prev.concat(prev[0]) : null;
    assert.ok(entry, `invalid LZW code ${code}`);
    out.push(...entry);
    if (prev) { dict.push(prev.concat(entry[0])); if (dict.length === 1 << size && size < 12) size++; }
    prev = entry;
  }
  return out.slice(0, npix);
}

test("gif: a GIF89a that loops, with the frame delays, decodes back to the frames", () => {
  const w = 37, h = 23, cols = [[200, 30, 30], [30, 200, 30], [30, 30, 200], [240, 240, 240]];
  const enc = new GifEncoder(w, h, { delayMs: 250 });
  const frames = [];
  for (let f = 0; f < 3; f++) {
    const a = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { const c = cols[(Math.floor(i / 7) + f) % 4]; a.set([...c, 255], i * 4); }
    frames.push(a); enc.addFrame(a, f === 2 ? 1000 : undefined);
  }
  const g = decodeGif(enc.encode());
  assert.equal(g.sig, "GIF89a"); assert.equal(g.W, w); assert.equal(g.H, h); assert.ok(g.loop, "NETSCAPE2.0 loop");
  assert.deepEqual(g.frames.map((f) => f.delay), [25, 25, 100], "delays in 1/100 s");
  for (const [k, fr] of g.frames.entries()) {
    for (let i = 0; i < w * h; i++) {
      const ix = fr.idx[i], rgb = [fr.ct[3 * ix], fr.ct[3 * ix + 1], fr.ct[3 * ix + 2]];
      assert.deepEqual(rgb, [...frames[k].slice(4 * i, 4 * i + 3)], `frame ${k} pixel ${i}`);
    }
  }
  assert.throws(() => enc.addFrame(new Uint8ClampedArray(8)), /size/);
});

test("gif: a smooth image keeps its colours closely with one 256-colour palette", () => {
  const w = 96, h = 64, enc = new GifEncoder(w, h), a = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a.set([x * 255 / (w - 1), y * 255 / (h - 1), 128 + 60 * Math.sin(x / 9), 255], (y * w + x) * 4);
  enc.addFrame(a);
  const fr = decodeGif(enc.encode()).frames[0];
  let err = 0;
  for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) err += Math.abs(fr.ct[3 * fr.idx[i] + c] - a[4 * i + c]);
  assert.ok(err / (w * h * 3) < 8, `mean colour error ${(err / (w * h * 3)).toFixed(2)} levels`);
});

// ------------------------------------------------------------------------------------------------- GeoTIFF (TIFF 6, GeoTIFF 1.1)
function readTiff(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  assert.deepEqual([...b.slice(0, 4)], [0x49, 0x49, 42, 0], "little-endian TIFF");
  const ifd = dv.getUint32(4, true), n = dv.getUint16(ifd, true), tags = {};
  const size = { 1: 1, 2: 1, 3: 2, 4: 4, 12: 8 };
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + 12 * k, tag = dv.getUint16(e, true), type = dv.getUint16(e + 2, true), count = dv.getUint32(e + 4, true);
    const bytes = count * size[type], off = bytes <= 4 ? e + 8 : dv.getUint32(e + 8, true);
    const v = [];
    for (let i = 0; i < count; i++) {
      if (type === 2 || type === 1) v.push(b[off + i]);
      else if (type === 3) v.push(dv.getUint16(off + 2 * i, true));
      else if (type === 4) v.push(dv.getUint32(off + 4 * i, true));
      else v.push(dv.getFloat64(off + 8 * i, true));
    }
    tags[tag] = type === 2 ? String.fromCharCode(...v.slice(0, -1)) : v;
    if (type === 2) assert.equal(v[v.length - 1], 0, `ASCII tag ${tag} ends in NUL inside its count`);
  }
  return tags;
}

test("geotiff: RGB pixels, Mars sphere, equirectangular at the site's standard parallel (GDAL reads it the same way)", async () => {
  const W = 5, H = 4, rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) rgba.set([i * 11 % 256, i * 37 % 256, i * 73 % 256, 255], 4 * i);
  const tif = await geoTiff(rgba, { x0: -1200, y0: 3400, res: 2, width: W, height: H }, { latTs: 18.4663, clon: 77.45 },
    { description: "MarsNav Jezero · slope °", rowsPerStrip: 3 });
  const t = readTiff(tif);
  assert.deepEqual([t[256][0], t[257][0], t[277][0]], [W, H, 3]);
  assert.equal(t[270], "MarsNav Jezero - slope  deg", "TIFF text is ASCII");
  assert.deepEqual(t[33550], [2, 2, 0]); assert.deepEqual(t[33922], [0, 0, 0, -1200, 3400, 0]);
  // GeoKeyDirectory: header + 4 shorts per key
  const gk = t[34735], keys = {};
  for (let k = 0; k < gk[3]; k++) keys[gk[4 + 4 * k]] = gk.slice(5 + 4 * k, 8 + 4 * k);
  const val = ([loc, , v]) => (loc === 0 ? v : loc === 34736 ? t[34736][v] : null);
  assert.equal(val(keys[3075]), 17, "CT_Equirectangular");
  assert.equal(val(keys[2057]), 3396190, "semi-major axis"); assert.equal(val(keys[2058]), 3396190, "a sphere");
  near(val(keys[3078]), 18.4663, 1e-12, "standard parallel"); near(val(keys[3088]), 77.45, 1e-12, "central meridian");
  assert.equal(t[34737].split("|")[1], "GCS_Mars_2000_Sphere", "geographic citation");
  // strips: zlib (compression 8) or raw, pixel-exact
  const raw = Buffer.concat(t[273].map((o, k) => {
    const s = Buffer.from(tif.slice(o, o + t[279][k]));
    return t[259][0] === 8 ? zlib.inflateSync(s) : s;
  }));
  for (let i = 0; i < W * H; i++) assert.deepEqual([...raw.slice(3 * i, 3 * i + 3)], [...rgba.slice(4 * i, 4 * i + 3)], `pixel ${i}`);
});

// ------------------------------------------------------------------------------------------------- ZIP / KMZ / KML
test("zip: CRC-32 check value, and a KMZ every unzip reads (PKWARE APPNOTE)", async () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  if (zlib.crc32) assert.equal(crc32(Uint8Array.from([1, 2, 3, 250])), zlib.crc32(Buffer.from([1, 2, 3, 250])));
  const doc = kml.doc("Test", kml.point("Hab", 77.45, 18.44));
  const bin = Uint8Array.from({ length: 3000 }, (_, i) => (i * 7) % 13);
  const z = Buffer.from(await zip([{ name: "doc.kml", data: doc }, { name: "files/a.bin", data: bin }]));
  const eocd = z.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0);
  const n = z.readUInt16LE(eocd + 10), cdOff = z.readUInt32LE(eocd + 16);
  assert.equal(n, 2);
  const got = {};
  for (let k = 0, p = cdOff; k < n; k++) {
    assert.equal(z.readUInt32LE(p), 0x02014b50);
    const method = z.readUInt16LE(p + 10), crc = z.readUInt32LE(p + 16), csize = z.readUInt32LE(p + 20), usize = z.readUInt32LE(p + 24);
    const nl = z.readUInt16LE(p + 28), lh = z.readUInt32LE(p + 42), name = z.slice(p + 46, p + 46 + nl).toString();
    assert.equal(z.readUInt32LE(lh), 0x04034b50);
    const body = z.slice(lh + 30 + z.readUInt16LE(lh + 26) + z.readUInt16LE(lh + 28), lh + 30 + z.readUInt16LE(lh + 26) + z.readUInt16LE(lh + 28) + csize);
    const data = method === 8 ? zlib.inflateRawSync(body) : body;
    assert.equal(data.length, usize); assert.equal(crc32(data), crc);
    got[name] = data;
    p += 46 + nl;
  }
  assert.equal(got["doc.kml"].toString(), doc);
  assert.deepEqual([...got["files/a.bin"]], [...bin]);
});

test("kml: well-formed, Mars target, longitude-latitude order, text escaped", () => {
  const body = [
    kml.point('Hab <A> & "B"', 77.45, 18.44, { style: "hab", description: "x < y" }),
    kml.line("Traverse", [[77.4, 18.4, 0], [77.5, 18.5, 0]]),
    kml.polygon("Ellipse", [[77, 18], [78, 18], [78, 19]]),
  ].join("\n");
  const doc = kml.doc("MarsNav: test", body, { description: "d" });
  assert.match(doc, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(doc, /hint="target=mars"/);
  assert.match(doc, /<coordinates>\s*77\.450*,18\.440*,/, "lon,lat[,alt]");
  assert.ok(doc.includes("Hab &lt;A&gt; &amp; &quot;B&quot;"));
  // balanced elements
  const stack = [];
  for (const m of doc.matchAll(/<(\/?)([A-Za-z][\w:]*)[^>]*?(\/?)>/g)) {
    if (m[0].startsWith("<?")) continue;
    if (m[3] === "/") continue;
    if (m[1]) assert.equal(stack.pop(), m[2], `closing ${m[2]}`); else stack.push(m[2]);
  }
  assert.deepEqual(stack, []);
  // polygons are closed rings
  const ring = doc.match(/<Polygon>[\s\S]*?<coordinates>\s*([^<]*)<\/coordinates>/)[1].trim().split(/\s+/);
  assert.equal(ring[0], ring[ring.length - 1]);
});
