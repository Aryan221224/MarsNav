// timeline.js - the strip under the map: elevation profile, walkback margin (the worst consumable after the walk
// home), time left before sunset, shade and station work, against mission elapsed time.
import { fmtDuration } from "../engine/util.js";

export class Timeline {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.route = null;
    this.cursor = null;
    this.now = null;
    new ResizeObserver(() => this.draw()).observe(canvas.parentElement);
    canvas.addEventListener("pointermove", (e) => {
      if (!this.route) return;
      const t = this._tOf(e.offsetX);
      const p = this._ptAt(t);
      this.cursor = t;
      this.onHover?.(p);
      this.draw();
    });
    canvas.addEventListener("pointerleave", () => { this.cursor = null; this.onHover?.(null); this.draw(); });
  }

  set(route) {
    this.route = route?.ok ? route : null;
    this.draw();
  }

  _tOf(x) {
    const L = 64, R = this.w - 14;
    return ((x - L) / (R - L)) * (this.route.t || 1);
  }

  _ptAt(t) {
    const pts = this.route.pts;
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (pts[m].t < t) lo = m; else hi = m;
    }
    return pts[hi];
  }

  draw() {
    const r = this.cv.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = r.width;
    this.h = r.height;
    this.cv.width = Math.round(r.width * dpr);
    this.cv.height = Math.round(r.height * dpr);
    const c = this.ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = "#151c26";
    c.fillRect(0, 0, this.w, this.h);
    const css = getComputedStyle(document.documentElement);
    const text = "#b8c2ce", faint = "#8d9aab", line = "#2a3646";
    c.font = "12px 'IBM Plex Mono', monospace";
    if (!this.route) {
      c.fillStyle = faint;
      c.fillText("Route profile appears here after planning: elevation, walkback margin, sunset, shade.", 16, 28);
      return;
    }
    const pts = this.route.pts, T = this.route.t || 1;
    const L = 64, R = this.w - 14;
    const X = (t) => L + ((R - L) * t) / T;
    const bands = [[8, 0.42], [0.46, 0.78], [0.8, 0.97]].map(([a, b]) => [this.h * (a < 1 ? a : 0.05), this.h * b]);
    bands[0][0] = 10;
    // time axis grid (every 30 min)
    c.strokeStyle = line;
    c.lineWidth = 1;
    c.fillStyle = faint;
    for (let t = 0; t <= T; t += 1800) {
      const x = X(t);
      c.beginPath(); c.moveTo(x, 6); c.lineTo(x, this.h - 4); c.stroke();
      c.fillText(fmtDuration(t).slice(0, 5), x + 3, this.h - 6);
    }
    // station work bands and shade
    for (let k = 1; k < pts.length; k++) {
      if (pts[k].work) { c.fillStyle = "rgba(216,165,122,0.18)"; c.fillRect(X(pts[k].t - pts[k].work), 6, X(pts[k].t) - X(pts[k].t - pts[k].work), this.h - 22); }
      if (pts[k].shade) { c.fillStyle = "rgba(0,0,0,0.35)"; c.fillRect(X(pts[k - 1].t), bands[0][0], Math.max(1, X(pts[k].t) - X(pts[k - 1].t)), bands[0][1] - bands[0][0]); }
    }
    // --- elevation
    const el = pts.map((p) => p.elev);
    let zmin = Math.min(...el), zmax = Math.max(...el);
    if (zmax - zmin < 20) { zmin -= 10; zmax += 10; }
    const [e0, e1] = bands[0];
    const Y = (z) => e1 - ((e1 - e0) * (z - zmin)) / (zmax - zmin);
    c.beginPath();
    c.moveTo(X(pts[0].t), e1);
    for (const p of pts) c.lineTo(X(p.t), Y(p.elev));
    c.lineTo(X(pts[pts.length - 1].t), e1);
    c.closePath();
    c.fillStyle = "rgba(216,165,122,0.28)";
    c.fill();
    c.beginPath();
    pts.forEach((p, k) => (k ? c.lineTo(X(p.t), Y(p.elev)) : c.moveTo(X(p.t), Y(p.elev))));
    c.strokeStyle = "#d8a57a";
    c.lineWidth = 1.5;
    c.stroke();
    c.fillStyle = text;
    c.fillText("ELEV", 8, e0 + 10);
    c.fillText(`${zmax.toFixed(0)}`, 8, e0 + 24);
    c.fillText(`${zmin.toFixed(0)} m`, 8, e1);
    // --- walkback margin (worst consumable), 0-100 %
    const [m0, m1] = bands[1];
    const YM = (v) => m1 - (m1 - m0) * Math.max(0, Math.min(1, v));
    c.strokeStyle = line;
    c.beginPath(); c.moveTo(L, YM(0.2)); c.lineTo(R, YM(0.2)); c.stroke();
    let prev = null;
    for (const p of pts) {
      const v = Math.min(p.margins.o2, p.margins.co2, p.margins.water, p.margins.batt, p.margins.time / (this.route.timeEndS || 1));
      const x = X(p.t), y = YM(v);
      if (prev) {
        c.strokeStyle = v < 0 ? "#ff7470" : v < 0.2 ? "#ffc629" : "#3ee07e";
        c.lineWidth = 2;
        c.beginPath(); c.moveTo(prev[0], prev[1]); c.lineTo(x, y); c.stroke();
      }
      prev = [x, y];
    }
    c.fillStyle = text;
    c.fillText("MARGIN", 8, m0 + 10);
    c.fillText("100%", 8, m0 + 24);
    c.fillText("0%", 8, m1);
    // --- sun elevation
    const [s0, s1] = bands[2];
    const YS = (e) => s1 - ((s1 - s0) * Math.max(0, Math.min(90, e))) / 90;
    c.beginPath();
    pts.forEach((p, k) => (k ? c.lineTo(X(p.t), YS(p.sunEl)) : c.moveTo(X(p.t), YS(p.sunEl))));
    c.strokeStyle = "#f2f5f8";
    c.lineWidth = 1;
    c.stroke();
    c.fillStyle = text;
    c.fillText("SUN", 8, s0 + 10);
    // cursors
    const mark = (t, col) => { const x = X(t); c.strokeStyle = col; c.lineWidth = 1.5; c.beginPath(); c.moveTo(x, 6); c.lineTo(x, this.h - 18); c.stroke(); };
    if (this.now != null) mark(this.now, "#3ee07e");
    if (this.cursor != null) {
      mark(this.cursor, "#f2f5f8");
      const p = this._ptAt(this.cursor);
      const m = Math.min(p.margins.o2, p.margins.co2, p.margins.water, p.margins.batt);
      const s = `MET ${fmtDuration(p.t)}  ${(p.dist / 1000).toFixed(2)} km  ${p.elev.toFixed(0)} m  grade ${p.grade.toFixed(1)}°  margin ${(100 * m).toFixed(0)}%  sun ${p.sunEl.toFixed(0)}°${p.shade ? " SHADE" : ""}`;
      const x = Math.min(this.w - c.measureText(s).width - 10, X(this.cursor) + 8);
      c.fillStyle = "rgba(11,15,20,0.92)";
      c.fillRect(x - 4, 8, c.measureText(s).width + 8, 18);
      c.fillStyle = "#f2f5f8";
      c.fillText(s, x, 21);
    }
  }
}
