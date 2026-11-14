// geoexport.js - map exports that open in GIS tools and in Google Earth's Mars mode, written in the browser with no
// library:
//   geoTiff()  an RGB GeoTIFF in the site's own projection: equirectangular on the Mars 2000 sphere (R 3 396 190 m), the
//              site's standard parallel and central meridian, deflate-compressed strips. QGIS / GDAL read it as is.
//   zip()      a ZIP archive (deflate when the browser can, else stored) - a KMZ is a zip with doc.kml inside
//   kml        helpers for placemarks, lines and polygons; <kml hint="target=mars"> makes Google Earth open Mars

const enc = new TextEncoder();

// ------------------------------------------------------------------------------------------------ deflate helpers
async function compress(bytes, format) {
  if (typeof CompressionStream === "undefined") return null;
  const cs = new Blob([bytes]).stream().pipeThrough(new CompressionStream(format));
  return new Uint8Array(await new Response(cs).arrayBuffer());
}

let CRC_T = null;
export function crc32(b) {
  if (!CRC_T) { CRC_T = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c >>> 0; } }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ------------------------------------------------------------------------------------------------------- GeoTIFF
/**
 * RGB GeoTIFF of an image in a site grid.
 * @param rgba   Uint8ClampedArray (width*height*4), e.g. from getImageData
 * @param grid   { x0, y0, res, width, height }: top-left corner and pixel size in projected metres (engine/geo.js Grid)
 * @param proj   { latTs, clon }: standard parallel and central meridian (deg)
 * @returns Promise<Uint8Array>
 */
export async function geoTiff(rgba, grid, proj, { description = "MarsNav map", rowsPerStrip = 32 } = {}) {
  // TIFF text is 7-bit ASCII, counted in bytes; "|" separates the GeoKey citations
  description = String(description).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/°/g, " deg").replace(/[–—·]/g, "-")
    .replace(/\|/g, "/").replace(/[^\x20-\x7e]/g, "") || "MarsNav map";
  const W = grid.width, H = grid.height;
  const strips = [];
  for (let r0 = 0; r0 < H; r0 += rowsPerStrip) {
    const n = Math.min(rowsPerStrip, H - r0), raw = new Uint8Array(W * n * 3);
    for (let r = 0; r < n; r++) for (let c = 0; c < W; c++) {
      const s = ((r0 + r) * W + c) * 4, d = (r * W + c) * 3;
      raw[d] = rgba[s]; raw[d + 1] = rgba[s + 1]; raw[d + 2] = rgba[s + 2];
    }
    strips.push(raw);
  }
  // deflate (TIFF compression 8 = zlib stream) when the browser has CompressionStream, else uncompressed
  const z = await compress(strips[0], "deflate");
  const compressed = z ? [z, ...(await Promise.all(strips.slice(1).map((s) => compress(s, "deflate"))))] : strips;
  const comp = z ? 8 : 1;
  const asc = `${description}|GCS_Mars_2000_Sphere|`;
  // GeoKeys: projected, user-defined Mars sphere, CT_Equirectangular (17) with the site's standard parallel
  const dbl = [3396190, 3396190, proj.latTs, proj.clon || 0, 0, 0, 0];
  const keys = [
    [1024, 0, 1, 1],                              // GTModelTypeGeoKey = projected
    [1025, 0, 1, 1],                              // GTRasterTypeGeoKey = PixelIsArea
    [1026, 34737, description.length + 1, 0],     // GTCitationGeoKey
    [2048, 0, 1, 32767],                          // GeographicTypeGeoKey = user-defined
    [2049, 34737, 21, description.length + 1],    // GeogCitationGeoKey "GCS_Mars_2000_Sphere|"
    [2050, 0, 1, 32767],                          // GeogGeodeticDatumGeoKey = user-defined
    [2054, 0, 1, 9102],                           // GeogAngularUnitsGeoKey = degree
    [2056, 0, 1, 32767],                          // GeogEllipsoidGeoKey = user-defined
    [2057, 34736, 1, 0],                          // GeogSemiMajorAxisGeoKey
    [2058, 34736, 1, 1],                          // GeogSemiMinorAxisGeoKey
    [3072, 0, 1, 32767],                          // ProjectedCSTypeGeoKey = user-defined
    [3074, 0, 1, 32767],                          // ProjectionGeoKey = user-defined
    [3075, 0, 1, 17],                             // ProjCoordTransGeoKey = CT_Equirectangular
    [3076, 0, 1, 9001],                           // ProjLinearUnitsGeoKey = metre
    [3078, 34736, 1, 2],                          // ProjStdParallel1GeoKey
    [3082, 34736, 1, 4],                          // ProjFalseEastingGeoKey
    [3083, 34736, 1, 5],                          // ProjFalseNorthingGeoKey
    [3088, 34736, 1, 3],                          // ProjCenterLongGeoKey
    [3089, 34736, 1, 6],                          // ProjCenterLatGeoKey
  ];
  const geoKeys = [1, 1, 0, keys.length, ...keys.flat()];
  // ---- layout: header, IFD, then the variable-size values, then the strips
  const entries = [];
  const E = (tag, type, count, value) => entries.push({ tag, type, count, value });
  const SHORT = 3, LONG = 4, DOUBLE = 12, ASCII = 2;
  E(256, LONG, 1, [W]); E(257, LONG, 1, [H]); E(258, SHORT, 3, [8, 8, 8]); E(259, SHORT, 1, [comp]); E(262, SHORT, 1, [2]);
  E(270, ASCII, description.length + 1, description);
  E(273, LONG, compressed.length, null);            // strip offsets: filled below
  E(277, SHORT, 1, [3]); E(278, LONG, 1, [rowsPerStrip]);
  E(279, LONG, compressed.length, compressed.map((s) => s.length));
  E(284, SHORT, 1, [1]);
  E(305, ASCII, 8, "MarsNav");
  E(33550, DOUBLE, 3, [grid.res, grid.res, 0]);                  // ModelPixelScaleTag
  E(33922, DOUBLE, 6, [0, 0, 0, grid.x0, grid.y0, 0]);           // ModelTiepointTag: pixel (0,0) corner -> x0, y0
  E(34735, SHORT, geoKeys.length, geoKeys);
  E(34736, DOUBLE, dbl.length, dbl);
  E(34737, ASCII, asc.length + 1, asc);
  entries.sort((a, b) => a.tag - b.tag);
  const size = { 2: 1, 3: 2, 4: 4, 12: 8 };
  const ifdOff = 8, ifdLen = 2 + entries.length * 12 + 4;
  let off = ifdOff + ifdLen;
  for (const e of entries) {
    const bytes = e.count * size[e.type];
    e.inline = bytes <= 4;
    if (!e.inline) { e.off = off; off += bytes + (bytes & 1); }
  }
  const stripStart = off;
  let so = stripStart;
  const offsets = compressed.map((s) => { const o = so; so += s.length; return o; });
  entries.find((e) => e.tag === 273).value = offsets;
  const out = new Uint8Array(so);
  const dv = new DataView(out.buffer);
  out.set([0x49, 0x49, 42, 0]); dv.setUint32(4, ifdOff, true);
  dv.setUint16(ifdOff, entries.length, true);
  const put = (at, e) => {
    if (e.type === ASCII) { const b = enc.encode(e.value); out.set(b, at); out[at + b.length] = 0; return; }
    e.value.forEach((v, k) => {
      if (e.type === SHORT) dv.setUint16(at + 2 * k, v, true);
      else if (e.type === LONG) dv.setUint32(at + 4 * k, v, true);
      else dv.setFloat64(at + 8 * k, v, true);
    });
  };
  entries.forEach((e, k) => {
    const p = ifdOff + 2 + 12 * k;
    dv.setUint16(p, e.tag, true); dv.setUint16(p + 2, e.type, true); dv.setUint32(p + 4, e.count, true);
    if (e.inline) put(p + 8, e); else { dv.setUint32(p + 8, e.off, true); put(e.off, e); }
  });
  dv.setUint32(ifdOff + 2 + 12 * entries.length, 0, true);
  compressed.forEach((s, k) => out.set(s, offsets[k]));
  return out;
}

// --------------------------------------------------------------------------------------------------------- ZIP
/** files: [{ name, data: Uint8Array|string }] -> Promise<Uint8Array> (deflate where the browser can) */
export async function zip(files) {
  const parts = [], central = [];
  let off = 0;
  for (const f of files) {
    const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    let body = await compress(data, "deflate-raw");
    let method = 8;
    if (!body || body.length >= data.length) { body = data; method = 0; }
    const name = enc.encode(f.name);
    const lh = new Uint8Array(30 + name.length), lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true); lv.setUint16(12, 0x21, true);              // 1980-01-01 00:00 (reproducible)
    lv.setUint32(14, crc, true); lv.setUint32(18, body.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true); lh.set(name, 30);
    const ch = new Uint8Array(46 + name.length), cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true); cv.setUint16(12, 0, true); cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, body.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, off, true); ch.set(name, 46);
    parts.push(lh, body); central.push(ch);
    off += lh.length + body.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, off, true);
  const all = [...parts, ...central, end], out = new Uint8Array(all.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}

// --------------------------------------------------------------------------------------------------------- KML
export const xmlEsc = (s) => String(s ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
const co = (pts) => pts.map(([lo, la, h]) => `${(+lo).toFixed(7)},${(+la).toFixed(7)},${(+(h || 0)).toFixed(1)}`).join(" ");

export const kml = {
  doc: (name, body, { description = "" } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" hint="target=mars">
<Document><name>${xmlEsc(name)}</name>${description ? `<description>${xmlEsc(description)}</description>` : ""}
<Style id="route"><LineStyle><color>ffffffff</color><width>4</width></LineStyle></Style>
<Style id="alt"><LineStyle><color>b0c4b09f</color><width>2</width></LineStyle></Style>
<Style id="danger"><LineStyle><color>ff29c6ff</color><width>2</width></LineStyle><PolyStyle><color>3329c6ff</color></PolyStyle></Style>
<Style id="ellipse"><LineStyle><color>ff29c6ff</color><width>2</width></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style>
<Style id="zone"><LineStyle><color>ff7aa5d8</color><width>2</width></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style>
<Style id="measure"><LineStyle><color>ff3cd2ff</color><width>3</width></LineStyle><PolyStyle><color>333cd2ff</color></PolyStyle></Style>
<Style id="hab"><IconStyle><scale>1.2</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/homegardenbusiness.png</href></Icon></IconStyle></Style>
<Style id="stn"><IconStyle><scale>1.0</scale><Icon><href>http://maps.google.com/mapfiles/kml/paddle/wht-circle.png</href></Icon></IconStyle></Style>
${body}
</Document></kml>`,
  point: (name, lon, lat, { style = "stn", description = "" } = {}) =>
    `<Placemark><name>${xmlEsc(name)}</name>${description ? `<description>${xmlEsc(description)}</description>` : ""}<styleUrl>#${style}</styleUrl><Point><coordinates>${co([[lon, lat]])}</coordinates></Point></Placemark>`,
  line: (name, pts, { style = "route", description = "" } = {}) =>
    `<Placemark><name>${xmlEsc(name)}</name>${description ? `<description>${xmlEsc(description)}</description>` : ""}<styleUrl>#${style}</styleUrl><LineString><tessellate>1</tessellate><coordinates>${co(pts)}</coordinates></LineString></Placemark>`,
  polygon: (name, ring, { style = "zone", description = "" } = {}) => {
    const r = ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ? [...ring, ring[0]] : ring;
    return `<Placemark><name>${xmlEsc(name)}</name>${description ? `<description>${xmlEsc(description)}</description>` : ""}<styleUrl>#${style}</styleUrl><Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing><coordinates>${co(r)}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`;
  },
  overlay: (name, href, box, { opacity = 1 } = {}) => {
    const a = Math.round(Math.max(0, Math.min(1, opacity)) * 255).toString(16).padStart(2, "0");
    return `<GroundOverlay><name>${xmlEsc(name)}</name><color>${a}ffffff</color><Icon><href>${xmlEsc(href)}</href></Icon>
<LatLonBox><north>${box.north}</north><south>${box.south}</south><east>${box.east}</east><west>${box.west}</west></LatLonBox></GroundOverlay>`;
  },
  folder: (name, inner, open = false) => `<Folder><name>${xmlEsc(name)}</name><open>${open ? 1 : 0}</open>${inner}</Folder>`,
};

/** Save bytes as a file (anchor download; the desktop app's window passes it to the save dialog). */
export function saveBytes(bytes, filename, mime) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 20000);
}
