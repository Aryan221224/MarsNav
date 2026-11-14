// gif.js - animated GIF encoder for map recordings (sol playback, MARCI weather loops). No library: one 256-colour
// palette for the whole animation (median cut over samples of every frame, so colours do not flicker between frames),
// nearest-colour mapping through a 15-bit lookup, and the standard GIF LZW coder (as in omggif). Loops forever.

export class GifEncoder {
  constructor(width, height, { delayMs = 250 } = {}) {
    this.w = width; this.h = height; this.delay = delayMs; this.frames = [];
  }

  /** rgba: Uint8ClampedArray / Uint8Array of width*height*4 (e.g. ctx.getImageData(...).data). */
  addFrame(rgba, delayMs = this.delay) {
    if (rgba.length !== this.w * this.h * 4) throw new Error("frame size does not match the GIF size");
    this.frames.push({ rgba, delay: delayMs });
  }

  encode() {
    if (!this.frames.length) throw new Error("no frames");
    const pal = medianCut(this.frames, 256);
    const map = paletteMapper(pal);
    const out = new Bytes();
    out.str("GIF89a");
    out.u16(this.w); out.u16(this.h);
    out.u8(0xf7); out.u8(0); out.u8(0);                         // global table of 256 colours
    for (let k = 0; k < 256; k++) { const c = pal[k] || [0, 0, 0]; out.u8(c[0]); out.u8(c[1]); out.u8(c[2]); }
    out.u8(0x21); out.u8(0xff); out.u8(11); out.str("NETSCAPE2.0"); out.u8(3); out.u8(1); out.u16(0); out.u8(0);   // loop forever
    const idx = new Uint8Array(this.w * this.h);
    for (const f of this.frames) {
      out.u8(0x21); out.u8(0xf9); out.u8(4); out.u8(0x04); out.u16(Math.max(2, Math.round(f.delay / 10))); out.u8(0); out.u8(0);
      out.u8(0x2c); out.u16(0); out.u16(0); out.u16(this.w); out.u16(this.h); out.u8(0);
      const p = f.rgba;
      for (let i = 0, j = 0; i < idx.length; i++, j += 4) idx[i] = map(p[j], p[j + 1], p[j + 2]);
      out.u8(8);
      lzw(idx, 8, out);
    }
    out.u8(0x3b);
    return out.bytes();
  }
}

class Bytes {
  constructor() { this.buf = new Uint8Array(1 << 20); this.n = 0; }
  _grow(k) { if (this.n + k <= this.buf.length) return; const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k)); b.set(this.buf.subarray(0, this.n)); this.buf = b; }
  u8(v) { this._grow(1); this.buf[this.n++] = v & 255; }
  u16(v) { this.u8(v); this.u8(v >> 8); }
  str(s) { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i)); }
  bytes() { return this.buf.slice(0, this.n); }
}

// median cut: split the box with the widest channel range at its median until there are n boxes
function medianCut(frames, n) {
  const want = 120000, per = Math.max(1, Math.floor((frames.length * frames[0].rgba.length / 4) / want));
  const s = [];
  for (const f of frames) for (let j = 0; j < f.rgba.length; j += 4 * per) s.push((f.rgba[j] << 16) | (f.rgba[j + 1] << 8) | f.rgba[j + 2]);
  const boxes = [Uint32Array.from(s)];
  const range = (b) => {
    let r0 = 255, r1 = 0, g0 = 255, g1 = 0, b0 = 255, b1 = 0;
    for (const v of b) {
      const r = v >> 16, g = (v >> 8) & 255, bl = v & 255;
      if (r < r0) r0 = r; if (r > r1) r1 = r; if (g < g0) g0 = g; if (g > g1) g1 = g; if (bl < b0) b0 = bl; if (bl > b1) b1 = bl;
    }
    return [r1 - r0, g1 - g0, b1 - b0];
  };
  while (boxes.length < n) {
    let bi = -1, best = 0, ch = 0;
    for (let k = 0; k < boxes.length; k++) {
      if (boxes[k].length < 2) continue;
      const rg = range(boxes[k]), m = Math.max(...rg);
      const score = m * Math.sqrt(boxes[k].length);
      if (score > best) { best = score; bi = k; ch = rg.indexOf(m); }
    }
    if (bi < 0 || best === 0) break;
    const b = boxes[bi], sh = 16 - 8 * ch;
    const sorted = Uint32Array.from(b).sort((x, y) => ((x >> sh) & 255) - ((y >> sh) & 255));
    const mid = sorted.length >> 1;
    boxes.splice(bi, 1, sorted.slice(0, mid), sorted.slice(mid));
  }
  return boxes.map((b) => {
    let r = 0, g = 0, bl = 0;
    for (const v of b) { r += v >> 16; g += (v >> 8) & 255; bl += v & 255; }
    const k = Math.max(1, b.length);
    return [Math.round(r / k), Math.round(g / k), Math.round(bl / k)];
  });
}

function paletteMapper(pal) {
  const cache = new Int16Array(32768).fill(-1);
  return (r, g, b) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let v = cache[key];
    if (v >= 0) return v;
    const R = (r & 0xf8) | 4, G = (g & 0xf8) | 4, B = (b & 0xf8) | 4;
    let bd = Infinity;
    for (let k = 0; k < pal.length; k++) {
      const c = pal[k], d = (c[0] - R) ** 2 * 3 + (c[1] - G) ** 2 * 4 + (c[2] - B) ** 2 * 2;
      if (d < bd) { bd = d; v = k; }
    }
    cache[key] = v;
    return v;
  };
}

// GIF LZW (variable code width from minCode+1 to 12 bits, clear on a full table), written in 255-byte sub-blocks
function lzw(index, minCode, out) {
  const clear = 1 << minCode, eoi = clear + 1;
  let next = eoi + 1, size = minCode + 1;
  const table = (lzw.table ||= new Int32Array(4096 * 256).fill(-1));     // shared; left all -1 after every call
  const used = [];
  let cur = 0, shift = 0;
  const block = new Uint8Array(255);
  let bn = 0;
  const byte = (v) => { block[bn++] = v; if (bn === 255) { out.u8(255); for (let k = 0; k < 255; k++) out.u8(block[k]); bn = 0; } };
  const emit = (code) => { cur |= code << shift; shift += size; while (shift >= 8) { byte(cur & 255); cur >>>= 8; shift -= 8; } };
  emit(clear);
  let prefix = index[0];
  for (let i = 1; i < index.length; i++) {
    const k = index[i], key = (prefix << 8) | k, c = table[key];
    if (c >= 0) { prefix = c; continue; }
    emit(prefix);
    if (next === 4096) {
      emit(clear);
      for (const u of used) table[u] = -1;
      used.length = 0;
      next = eoi + 1; size = minCode + 1;
    } else {
      if (next >= (1 << size)) size++;
      table[key] = next++; used.push(key);
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  for (const u of used) table[u] = -1;
  if (shift > 0) byte(cur & 255);
  if (bn) { out.u8(bn); for (let k = 0; k < bn; k++) out.u8(block[k]); }
  out.u8(0);
}
