// map.js - canvas map: CTX orthomosaic, HiRISE 2 m detail tiles when zoomed in, engine overlays, routes drawn as a
// white core with a dark casing (legible on every Mars tone, research doc 17), a violet position-error corridor,
// stations, keep-outs, landmarks, the real Perseverance traverse, and the crew during Execute.
import { lonlatToXY, xyToLonLat } from "../engine/geo.js";

export class MapView {
  constructor(canvas, grid, imagery, dataBase) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.grid = grid; // ops10 grid JSON
    this.im = imagery;
    this.base = dataBase;
    this.cx = grid.x0 + (grid.width * grid.res) / 2;
    this.cy = grid.y0 - (grid.height * grid.res) / 2;
    this.mpp = 12; // metres per CSS pixel
    this.ortho = null;
    this.tiles = new Map();
    this.overlay = null; // canvas
    this.showVeto = true;
    this.veto = null;
    this.layers = { traverse: true, landmarks: false, alt: true };
    this.routes = {};
    this.selected = null;
    this.stations = [];
    this.targets = [];
    this.keepouts = [];
    this.landmarks = [];
    this.traverse = null;
    this.habitat = null;
    this.crew = null;
    this.hover = null;
    this._load();
    this._bind();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
  }

  _load() {
    const img = new Image();
    img.onload = () => { this.ortho = img; this.draw(); };
    img.src = new URL(this.im.ortho5.file, this.base).href;
  }

  resize() {
    const r = this.cv.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = r.width;
    this.h = r.height;
    this.cv.width = Math.max(1, Math.round(r.width * dpr));
    this.cv.height = Math.max(1, Math.round(r.height * dpr));
    this.dpr = dpr;
    this.draw();
  }

  // ---------------------------------------------------------------------------------------------- transforms --
  toScreen(x, y) {
    return [(x - this.cx) / this.mpp + this.w / 2, (this.cy - y) / this.mpp + this.h / 2];
  }

  toWorld(sx, sy) {
    return [(sx - this.w / 2) * this.mpp + this.cx, this.cy - (sy - this.h / 2) * this.mpp];
  }

  llScreen(lon, lat) {
    return this.toScreen(...lonlatToXY(lon, lat));
  }

  screenLL(sx, sy) {
    return xyToLonLat(...this.toWorld(sx, sy));
  }

  zoomAt(f, sx = this.w / 2, sy = this.h / 2) {
    const [wx, wy] = this.toWorld(sx, sy);
    this.mpp = Math.min(60, Math.max(0.6, this.mpp * f));
    const [nx, ny] = this.toWorld(sx, sy);
    this.cx += wx - nx;
    this.cy += wy - ny;
    this.draw();
  }

  fitLonLat(pts, pad = 60) {
    if (!pts.length) return;
    const xy = pts.map(([lo, la]) => lonlatToXY(lo, la));
    const xs = xy.map((p) => p[0]), ys = xy.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    this.cx = (x0 + x1) / 2;
    this.cy = (y0 + y1) / 2;
    this.mpp = Math.max(1.2, Math.max((x1 - x0) / Math.max(50, this.w - 2 * pad), (y1 - y0) / Math.max(50, this.h - 2 * pad)));
    this.draw();
  }

  _bind() {
    const cv = this.cv;
    const pts = new Map();
    let moved = 0, pinch = null;
    cv.addEventListener("pointerdown", (e) => {
      cv.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, [e.offsetX, e.offsetY]);
      moved = 0;
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), mpp: this.mpp };
      }
    });
    cv.addEventListener("pointermove", (e) => {
      const p = pts.get(e.pointerId);
      if (!p) {
        this.hover = [e.offsetX, e.offsetY];
        this.onHover?.(...this.screenLL(e.offsetX, e.offsetY), e.offsetX, e.offsetY);
        return;
      }
      if (pts.size === 2 && pinch) {
        pts.set(e.pointerId, [e.offsetX, e.offsetY]);
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        const target = pinch.mpp * (pinch.d / Math.max(d, 1));
        this.zoomAt(target / this.mpp, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
        moved += 10;
        return;
      }
      const dx = e.offsetX - p[0], dy = e.offsetY - p[1];
      moved += Math.abs(dx) + Math.abs(dy);
      this.cx -= dx * this.mpp;
      this.cy += dy * this.mpp;
      pts.set(e.pointerId, [e.offsetX, e.offsetY]);
      this.draw();
    });
    const up = (e) => {
      if (pts.has(e.pointerId) && moved < 6 && pts.size === 1) this.onClick?.(...this.screenLL(e.offsetX, e.offsetY));
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
    };
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", (e) => { pts.delete(e.pointerId); pinch = null; });
    cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.zoomAt(Math.exp(e.deltaY * 0.0015), e.offsetX, e.offsetY);
    }, { passive: false });
    cv.addEventListener("pointerleave", () => { this.hover = null; this.onHover?.(null); });
  }

  setOverlay(ov) {
    if (!ov) { this.overlay = null; this.draw(); return; }
    const c = document.createElement("canvas");
    c.width = ov.w;
    c.height = ov.h;
    c.getContext("2d").putImageData(new ImageData(ov.rgba, ov.w, ov.h), 0, 0);
    this.overlay = c;
    this.draw();
  }

  setVeto(ov) {
    const c = document.createElement("canvas");
    c.width = ov.w;
    c.height = ov.h;
    c.getContext("2d").putImageData(new ImageData(ov.rgba, ov.w, ov.h), 0, 0);
    this.veto = c;
    this.draw();
  }

  _tile(t) {
    let e = this.tiles.get(t.file);
    if (!e) {
      e = { img: new Image(), ok: false };
      e.img.onload = () => { e.ok = true; this.draw(); };
      e.img.src = new URL(t.file, this.base).href;
      this.tiles.set(t.file, e);
    }
    return e;
  }

  draw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); });
  }

  _gridRect(ctx) {
    const g = this.grid;
    const [sx, sy] = this.toScreen(g.x0, g.y0);
    return [sx, sy, (g.width * g.res) / this.mpp, (g.height * g.res) / this.mpp];
  }

  _draw() {
    const ctx = this.ctx, g = this.grid;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = "#06080b";
    ctx.fillRect(0, 0, this.w, this.h);
    const [gx, gy, gw, gh] = this._gridRect();
    ctx.imageSmoothingEnabled = this.mpp > 2.5;
    if (this.ortho) ctx.drawImage(this.ortho, gx, gy, gw, gh);
    // HiRISE detail tiles when zoomed in
    if (this.mpp < 3.2 && this.im.hi2) {
      for (const t of this.im.hi2.tiles) {
        const x0 = g.x0 + t.c0 * g.res, y0 = g.y0 - t.r0 * g.res, size = t.cells * g.res;
        const [sx, sy] = this.toScreen(x0, y0);
        const s = size / this.mpp;
        if (sx > this.w || sy > this.h || sx + s < 0 || sy + s < 0) continue;
        const e = this._tile(t);
        if (e.ok) ctx.drawImage(e.img, sx, sy, s, s);
      }
    }
    ctx.imageSmoothingEnabled = false;
    if (this.overlay) ctx.drawImage(this.overlay, gx, gy, gw, gh);
    if (this.showVeto && this.veto) { ctx.globalAlpha = 0.85; ctx.drawImage(this.veto, gx, gy, gw, gh); ctx.globalAlpha = 1; }
    ctx.imageSmoothingEnabled = true;
    this._vectors(ctx);
    this._scale();
  }

  _line(ctx, pts, color, width, dash = null) {
    ctx.beginPath();
    pts.forEach((p, k) => { const [sx, sy] = this.llScreen(p[0], p[1]); k ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash || []);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.setLineDash([]);
  }

  _vectors(ctx) {
    this._lbl = [];
    // keep-out zones (hazard tape outline)
    for (const k of this.keepouts) {
      for (const [lo, la] of k.points) {
        const [sx, sy] = this.llScreen(lo, la);
        const r = k.radius_m / this.mpp;
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, 2 * Math.PI);
        ctx.strokeStyle = "#ffc629";
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const [sx, sy] = this.llScreen(...k.points[0]);
      this._label(ctx, sx + 8, sy - 10, k.name, "#ffc629", 2);
    }
    // Perseverance traverse (real)
    if (this.layers.traverse && this.traverse) {
      this._line(ctx, this.traverse, "rgba(11,15,20,0.7)", 4);
      this._line(ctx, this.traverse, "rgba(216,165,122,0.95)", 1.6, [5, 4]);
    }
    if (this.layers.landmarks) {
      for (const l of this.landmarks) {
        const [sx, sy] = this.llScreen(l.lonlat[0], l.lonlat[1]);
        ctx.beginPath();
        ctx.moveTo(sx, sy - 5); ctx.lineTo(sx + 5, sy); ctx.lineTo(sx, sy + 5); ctx.lineTo(sx - 5, sy); ctx.closePath();
        ctx.strokeStyle = "#f2f5f8"; ctx.lineWidth = 1.5; ctx.stroke();
      }
    }
    // alternative routes
    if (this.layers.alt) {
      for (const [name, r] of Object.entries(this.routes)) {
        if (!r?.ok || name === this.selected) continue;
        const ll = r.pts.map((p) => [p.lon, p.lat]);
        this._line(ctx, ll, "rgba(11,15,20,0.85)", 5);
        this._line(ctx, ll, "#9fb0c4", 2, name === "fallback" ? [2, 5] : [9, 6]);
      }
    }
    const sel = this.routes[this.selected];
    if (sel?.ok) {
      // position-error corridor: 2 sigma each side
      ctx.lineCap = "round";
      for (let k = 0; k + 1 < sel.pts.length; k += 1) {
        const a = sel.pts[k], b = sel.pts[k + 1];
        const [x0, y0] = this.llScreen(a.lon, a.lat), [x1, y1] = this.llScreen(b.lon, b.lat);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.strokeStyle = "rgba(201,160,255,0.22)";
        ctx.lineWidth = Math.max(3, (4 * b.sigma) / this.mpp);
        ctx.stroke();
      }
      const ll = sel.pts.map((p) => [p.lon, p.lat]);
      this._line(ctx, ll, "#0b0f14", 7);
      this._line(ctx, ll, "#ffffff", 3);
      // direction chevrons every ~300 m
      let next = 0;
      for (let k = 1; k < sel.pts.length; k++) {
        if (sel.pts[k].dist < next) continue;
        next = sel.pts[k].dist + Math.max(200, 60 * this.mpp);
        const a = sel.pts[k - 1], b = sel.pts[k];
        const [x0, y0] = this.llScreen(a.lon, a.lat), [x1, y1] = this.llScreen(b.lon, b.lat);
        const ang = Math.atan2(y1 - y0, x1 - x0);
        ctx.save();
        ctx.translate(x1, y1);
        ctx.rotate(ang);
        ctx.beginPath();
        ctx.moveTo(-5, -5); ctx.lineTo(3, 0); ctx.lineTo(-5, 5);
        ctx.strokeStyle = "#0b0f14"; ctx.lineWidth = 2.5; ctx.stroke();
        ctx.restore();
      }
    }
    // infeasible plan: safe part amber, beyond the point of no return red, with the PNR marker
    if (this.diag?.pts?.length) {
      const d = this.diag, k = d.pts.findIndex((p) => p.dist >= d.pnrDistM);
      const cut = k < 0 ? d.pts.length : k + 1;
      const ll = d.pts.map((p) => [p.lon, p.lat]);
      // beyond the PNR first, so the reachable part stays visible where an out-and-back route overlaps itself
      this._line(ctx, ll.slice(Math.max(0, cut - 1)), "#0b0f14", 6);
      this._line(ctx, ll.slice(Math.max(0, cut - 1)), "#ff7470", 3, [4, 6]);
      this._line(ctx, ll.slice(0, cut), "#0b0f14", 6);
      this._line(ctx, ll.slice(0, cut), "#ffc629", 3, [8, 5]);
      if (d.pnr) {
        const [sx, sy] = this.llScreen(d.pnr.lon, d.pnr.lat);
        ctx.beginPath(); ctx.moveTo(sx, sy - 10); ctx.lineTo(sx + 9, sy + 6); ctx.lineTo(sx - 9, sy + 6); ctx.closePath();
        ctx.fillStyle = "#ff7470"; ctx.fill(); ctx.strokeStyle = "#0b0f14"; ctx.lineWidth = 2; ctx.stroke();
        this._label(ctx, sx + 12, sy + 4, "POINT OF NO RETURN", "#ff7470", 9);
      }
    }
    // landing ellipse and Monte Carlo touchdowns (green safe, amber unverified, red unsafe)
    if (this.landing) {
      const L = this.landing;
      for (const q of L.samples || []) {
        const [sx, sy] = this.llScreen(q.lon, q.lat);
        ctx.fillStyle = q.cls === 1 ? "rgba(62,224,126,0.85)" : q.cls === 2 ? "rgba(255,198,41,0.85)" : q.cls === 0 ? "rgba(255,116,112,0.9)" : "rgba(150,150,150,0.6)";
        ctx.fillRect(sx - 1.5, sy - 1.5, 3, 3);
      }
      if (L.ellipse?.length) { this._line(ctx, L.ellipse, "#0b0f14", 5); this._line(ctx, L.ellipse, "#f2f5f8", 2, [8, 5]); }
      if (L.target) {
        const [sx, sy] = this.llScreen(L.target.lon, L.target.lat);
        ctx.strokeStyle = "#f2f5f8"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(sx - 9, sy); ctx.lineTo(sx + 9, sy); ctx.moveTo(sx, sy - 9); ctx.lineTo(sx, sy + 9); ctx.stroke();
        this._label(ctx, sx + 10, sy - 10, "LANDING TARGET", "#f2f5f8", 8);
      }
      if (L.touchdown) {
        const [sx, sy] = this.llScreen(L.touchdown.lon, L.touchdown.lat);
        ctx.beginPath(); ctx.arc(sx, sy, 7, 0, 2 * Math.PI); ctx.fillStyle = "#ffc629"; ctx.fill();
        ctx.strokeStyle = "#0b0f14"; ctx.lineWidth = 2; ctx.stroke();
        this._label(ctx, sx + 10, sy + 4, "TOUCHDOWN", "#ffc629", 8);
      }
    }
    // contingency return route during Execute
    if (this.returnPts) {
      this._line(ctx, this.returnPts, "#0b0f14", 7);
      this._line(ctx, this.returnPts, "#ff7470", 3, [10, 6]);
    }
    // the plan now being flown after a closed-loop re-plan (the original stays underneath in white)
    if (this.livePlan?.length) {
      this._line(ctx, this.livePlan, "#0b0f14", 7);
      this._line(ctx, this.livePlan, "#3cc8ff", 3, [12, 5]);
      const [sx, sy] = this.llScreen(...this.livePlan[0]);
      this._label(ctx, sx + 10, sy - 8, "RE-PLANNED", "#3cc8ff", 8);
    }
    if (this.track?.length) this._line(ctx, this.track, "rgba(62,224,126,0.9)", 2);
    // crew pins: a diamond with the position-error circle (a pin is never drawn as an exact point)
    (this.pins || []).forEach((p, k) => {
      const [sx, sy] = this.llScreen(p.lon, p.lat);
      const r = Math.max(3, (2 * p.sigma) / this.mpp);
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, 2 * Math.PI);
      ctx.strokeStyle = "rgba(201,160,255,0.8)"; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(sx, sy - 7); ctx.lineTo(sx + 6, sy); ctx.lineTo(sx, sy + 7); ctx.lineTo(sx - 6, sy); ctx.closePath();
      ctx.fillStyle = "#3ccbff"; ctx.fill(); ctx.strokeStyle = "#0b0f14"; ctx.lineWidth = 2; ctx.stroke();
      this._label(ctx, sx + 9, sy + 4, `PIN ${k + 1}`, "#3ccbff", 7);
    });
    // targets
    for (const t of this.targets) {
      if (t.kind === "base") continue;
      const [sx, sy] = this.llScreen(t.lon, t.lat);
      ctx.beginPath();
      ctx.arc(sx, sy, 5, 0, 2 * Math.PI);
      ctx.fillStyle = t.kind === "asset" ? "#9fb0c4" : "#d8a57a";
      ctx.fill();
      ctx.strokeStyle = "#0b0f14";
      ctx.lineWidth = 2;
      ctx.stroke();
      if (this.mpp < 14) this._label(ctx, sx + 9, sy + 4, t.name, "#f2f5f8", 1);
    }
    // stations (numbered)
    this.stations.forEach((s, k) => {
      const [sx, sy] = this.llScreen(s.lon, s.lat);
      ctx.globalAlpha = s.skip ? 0.45 : 1;
      ctx.beginPath();
      ctx.arc(sx, sy, 11, 0, 2 * Math.PI);
      ctx.fillStyle = s.isStart ? "#7fe3a1" : s.isEnd ? "#ffcf6e" : "#f2f5f8";
      ctx.fill();
      ctx.strokeStyle = "#0b0f14";
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.fillStyle = "#0b0f14";
      ctx.font = "700 13px 'IBM Plex Mono', monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(s.label ?? String(k + 1), sx, sy + 0.5);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.globalAlpha = 1;
    });
    // habitat
    if (this.habitat) {
      const [sx, sy] = this.llScreen(this.habitat.lon, this.habitat.lat);
      ctx.fillStyle = "#f2f5f8";
      ctx.strokeStyle = "#0b0f14";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.rect(sx - 10, sy - 10, 20, 20);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#0b0f14";
      ctx.font = "700 11px 'Barlow Condensed', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("HAB", sx, sy + 4);
      ctx.textAlign = "left";
    }
    // crew (estimated position + 2-sigma circle)
    if (this.crew) {
      const [sx, sy] = this.llScreen(this.crew.lon, this.crew.lat);
      ctx.beginPath();
      const el = this.crew.ellipse;
      // 2-sigma error ellipse from the navigation filter (axes in metres, angle from east, anticlockwise)
      if (el && el.major > 0) ctx.ellipse(sx, sy, Math.max(6, el.major / this.mpp), Math.max(6, el.minor / this.mpp), (-el.angleDeg * Math.PI) / 180, 0, 2 * Math.PI);
      else ctx.arc(sx, sy, Math.max(6, (2 * this.crew.sigma) / this.mpp), 0, 2 * Math.PI);
      ctx.fillStyle = "rgba(201,160,255,0.18)";
      ctx.fill();
      ctx.strokeStyle = "#c9a0ff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(sx, sy, 6, 0, 2 * Math.PI);
      ctx.fillStyle = "#3ee07e";
      ctx.fill();
      ctx.strokeStyle = "#0b0f14";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    this._placeLabels(ctx);
  }

  // labels are queued while drawing and placed last, highest priority first: a label that would overlap another label,
  // a station or habitat marker, or the map buttons is tried on the left of its point and otherwise left out
  // (priority 7 and up - point of no return, landing target, touchdown, pins, re-plan - is always drawn)
  _label(ctx, x, y, text, color, prio = 1) {
    (this._lbl ||= []).push({ x, y, text, color, prio });
  }

  _placeLabels(ctx) {
    const queue = (this._lbl || []).sort((a, b) => b.prio - a.prio);
    this._lbl = [];
    ctx.font = "600 12.5px 'Barlow', system-ui, sans-serif";
    // keep clear of the panels floating over the map (buttons, layers, legend, readout, Execute HUD)
    const taken = [];
    const cr = this.cv.getBoundingClientRect();
    for (const el of this.cv.parentElement.querySelectorAll(".maptools, .layerbox, .legend, .readout, .hud")) {
      if (el.hidden || !el.offsetParent) continue;
      const b = el.getBoundingClientRect();
      taken.push([b.left - cr.left - 4, b.top - cr.top - 4, b.width + 8, b.height + 8]);
    }
    const mark = (lon, lat, r) => { const [sx, sy] = this.llScreen(lon, lat); taken.push([sx - r, sy - r, 2 * r, 2 * r]); };
    for (const st of this.stations) mark(st.lon, st.lat, 13);
    if (this.habitat) mark(this.habitat.lon, this.habitat.lat, 12);
    const out = (b) => b[0] < 2 || b[1] < 2 || b[0] + b[2] > this.w - 2 || b[1] + b[3] > this.h - 2;   // cut by the map edge
    const hit = (b) => out(b) || taken.some((o) => b[0] < o[0] + o[2] && b[0] + b[2] > o[0] && b[1] < o[1] + o[3] && b[1] + b[3] > o[1]);
    for (const l of queue) {
      const w = ctx.measureText(l.text).width;
      // tried in turn: as given, nudged right (clear of a station disc), mirrored to the left, below
      const tries = [[l.x - 2, l.y - 12], [l.x + 8, l.y - 12], [l.x - w - 20, l.y - 12], [l.x - w / 2, l.y + 6]].map(([x, y]) => [x, y, w + 4, 16]);
      let box = tries.find((b) => !hit(b));
      if (!box) {
        if (l.prio < 7) continue;
        box = tries[0];
      }
      taken.push(box);
      const x = box[0] + 2, y = box[1] + 12;
      ctx.lineWidth = 3.5;
      ctx.lineJoin = "round";
      ctx.strokeStyle = "rgba(11,15,20,0.9)";
      ctx.strokeText(l.text, x, y);
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, x, y);
    }
  }

  _scale() {
    const target = 120 * this.mpp;
    const nice = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
    let v = nice[0];
    for (const n of nice) if (n <= target) v = n;
    const bar = document.getElementById("scaleBar"), txt = document.getElementById("scaleTxt");
    if (bar) bar.style.width = `${v / this.mpp}px`;
    if (txt) txt.textContent = v >= 1000 ? `${v / 1000} km` : `${v} m`;
  }
}
