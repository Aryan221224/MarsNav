// view3d.js - 3D terrain view of the planned EVA on the real DEM (research doc 17: "3D map" is a SUITS "should").
// Local terrain: the 10 m elevation around the route, draped with the CTX ortho and the 2 m HiRISE relief tiles (and the
// active overlay). Far terrain: the whole-crater 100 m DEM, so the skyline in helmet view is the real crater rim.
// Mars curvature is applied (drop = d^2 / 2R) and vertical exaggeration defaults to 1 (true scale).
// The crew displays (hud.js) use the same view behind the helmet visor, following the crew (setEye).
import * as THREE from "../vendor/three.module.min.js";
import { lonlatToXY, R_MARS } from "../engine/geo.js";
import { marsState, jdTT, sunPosition } from "../engine/marstime.js";

const SKY = new THREE.Color("#c9a27a"), SKY_TOP = new THREE.Color("#8f6a4c");

export class View3D {
  constructor(wrap, rpc, map) {
    this.wrap = wrap;
    this.call = rpc;
    this.map = map;
    this.canvas = wrap.querySelector("canvas");
    this.mode = "orbit";
    this.exag = 1;
    this.tiles = new Map();
    this.renderer = null;
    this.flyT = 0;
    this.playing = false;
  }

  _init() {
    if (this.renderer && !this.lost) return true;
    if (this.renderer) this._teardown(true);   // context lost earlier: start over on a brand-new canvas
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: "default",
        failIfMajorPerformanceCaveat: false, preserveDrawingBuffer: false });
    } catch (e) {
      // a canvas whose context creation failed cannot be retried: swap in a fresh one for the next attempt
      this.renderer = null;
      const fresh = document.createElement("canvas");
      this.canvas.replaceWith(fresh);
      this.canvas = fresh;
      this.initError = String(e?.message || e);
      return false;
    }
    this.initError = null;
    this.lost = false;
    // GPU memory budget: laptop GPUs (and D3D11 via ANGLE on Windows) run out of texture memory quickly; the terrain
    // texture is capped at 2048 px (halved again after every context loss) and never above the GPU's own limit
    this.texCap = Math.min(this.texCap ?? 2048, this.renderer.capabilities.maxTextureSize || 2048);
    this.renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
    const cv = this.canvas;
    cv.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      if (cv !== this.canvas) return;
      this.lost = true;
      this.playing = false;
      this.texCap = Math.max(512, Math.floor((this.texCap || 2048) / 2));
      this.onStatus?.("3D ran out of graphics memory; rebuilding with lighter textures…");
      clearTimeout(this._recover);
      this._recover = setTimeout(() => this._rebuildAfterLoss(), 600);
    });
    if (!this.scene) {
      this.scene = new THREE.Scene();
      this.scene.background = SKY;
      this.scene.fog = new THREE.Fog(SKY, 4000, 70000);
      this.camera = new THREE.PerspectiveCamera(55, 1, 0.5, 200000);
      this.sun = new THREE.DirectionalLight(0xfff1dc, 1.6);
      this.scene.add(this.sun, new THREE.HemisphereLight(SKY_TOP, 0x3a2a20, 0.9));
      this.group = new THREE.Group();
      this.scene.add(this.group);
      this.orbit = { theta: -0.6, phi: 0.95, dist: 6000, target: new THREE.Vector3() };
      this.look = { yaw: 0, pitch: -0.05 };
      new ResizeObserver(() => this._resize()).observe(this.wrap);
    }
    this._bind();
    this._resize();
    return true;
  }

  /** Free every GPU resource; with `newCanvas`, also replace the canvas (a lost context cannot be reused reliably). */
  _teardown(newCanvas = false) {
    this.playing = false;
    if (this.group) for (const o of [...this.group.children]) this._dispose(o);
    this.group?.clear();
    this.labels = [];
    try { this.renderer?.dispose(); } catch { /* already lost */ }
    this.renderer = null;
    if (newCanvas) {
      const fresh = document.createElement("canvas");
      this.canvas.replaceWith(fresh);
      this.canvas = fresh;
    }
  }

  _dispose(o) {
    o.traverse?.((c) => {
      c.geometry?.dispose();
      const mats = Array.isArray(c.material) ? c.material : c.material ? [c.material] : [];
      for (const m of mats) { m.map?.dispose(); m.dispose(); }
    });
  }

  async _rebuildAfterLoss() {
    if (!this.ctx || this.wrap.hidden) return;
    try {
      if (!this._init()) { this.onStatus?.("3D needs WebGL, which the browser has turned off."); return; }
      await this._build();
      this.setMode(this.mode);
      this.onStatus?.(null);
    } catch (e) {
      this.onStatus?.(`3D could not rebuild: ${e.message}. Close and reopen 3D to retry.`);
    }
  }

  /** Called when the 3D view closes: give the GPU memory back to the rest of the browser. */
  release() {
    this.playing = false;
    if (this.group) for (const o of [...this.group.children]) this._dispose(o);
    this.group?.clear();
    this.labels = [];
    this.curve = null;
    this.renderer?.renderLists?.dispose();
  }

  _resize() {
    if (!this.renderer) return;
    const r = this.wrap.getBoundingClientRect();
    this.renderer.setSize(Math.max(1, r.width), Math.max(1, r.height), false);
    this.camera.aspect = Math.max(1, r.width) / Math.max(1, r.height);
    this.camera.updateProjectionMatrix();
    this.render();
  }

  _bind() {
    if (this.canvas._mmBound) return;
    this.canvas._mmBound = true;
    let drag = null;
    this.canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, b: e.button, shift: e.shiftKey }; this.canvas.setPointerCapture(e.pointerId); });
    this.canvas.addEventListener("pointerup", () => { drag = null; });
    this.canvas.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (this.mode === "orbit") {
        if (drag.b === 2 || drag.shift) {
          const s = this.orbit.dist / 900;
          const f = new THREE.Vector3(Math.sin(this.orbit.theta), 0, Math.cos(this.orbit.theta));
          const r = new THREE.Vector3(f.z, 0, -f.x);
          this.orbit.target.addScaledVector(r, -dx * s).addScaledVector(f, -dy * s);
        } else {
          this.orbit.theta -= dx * 0.006;
          this.orbit.phi = Math.min(1.5, Math.max(0.08, this.orbit.phi - dy * 0.005));
        }
      } else {
        this.look.yaw -= dx * 0.004;
        this.look.pitch = Math.min(1.2, Math.max(-1.2, this.look.pitch - dy * 0.004));
      }
      this.render();
    });
    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    this.canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (this.mode === "orbit") this.orbit.dist = Math.min(80000, Math.max(150, this.orbit.dist * Math.exp(e.deltaY * 0.001)));
      else this.camera.fov = Math.min(90, Math.max(15, this.camera.fov + e.deltaY * 0.02)), this.camera.updateProjectionMatrix();
      this.render();
    }, { passive: false });
  }

  /** ctx: { grid, imagery, base, route (pts with lon, lat, elev), stations, pins, crew, diag, ms, focus, habitat } */
  async open(ctx) {
    if (!this._init()) return false;
    if (this.lost) throw new Error("the graphics context is lost; try again in a moment");
    this.ctx = ctx;
    await this._build();
    this.setMode(this.mode);
    return true;
  }

  // world coordinates: x east, z south (north = -z), y up, origin at the local window centre
  _w(x, y, z) {
    const dx = x - this.ox, dz = this.oy - y;
    const drop = (dx * dx + dz * dz) / (2 * R_MARS);
    return new THREE.Vector3(dx, (z - this.zRef) * this.exag - drop, dz);
  }

  _groundAt(x, y) {
    const L = this.local, g = this.ctx.grid;
    const c = ((x - g.x0) / g.res - 0.5 - L.c0) / L.step, r = ((g.y0 - y) / g.res - 0.5 - L.r0) / L.step;
    const ci = Math.max(0, Math.min(L.nc - 1, Math.round(c))), ri = Math.max(0, Math.min(L.nr - 1, Math.round(r)));
    return L.z[ri * L.nc + ci];
  }

  async _build() {
    const { grid: g, route, stations, base, focus } = this.ctx;
    for (const o of [...this.group.children]) { this.group.remove(o); this._dispose(o); }
    // window around the route (or stations, and the crew's position on the crew displays), padded 700 m, at least 3 km
    const pts = [...(route || []).map((p) => lonlatToXY(p.lon, p.lat)), ...[base, ...(stations || []), ...(focus || [])].filter(Boolean).map((p) => lonlatToXY(p.lon, p.lat))];
    let xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    let x0 = Math.min(...xs) - 700, x1 = Math.max(...xs) + 700, y0 = Math.min(...ys) - 700, y1 = Math.max(...ys) + 700;
    const cxm = (x0 + x1) / 2, cym = (y0 + y1) / 2, half = Math.max(1500, (x1 - x0) / 2, (y1 - y0) / 2);
    x0 = cxm - half; x1 = cxm + half; y0 = cym - half; y1 = cym + half;
    // clamp to the terrain grid; a window that falls (partly or wholly) outside it — a point added at the edge of the
    // map — is shifted back inside, keeping at least 3 km of terrain, instead of producing an empty or negative window
    const clampWin = (a0, a1, n) => {
      const want = Math.max(300, a1 - a0);
      if (want >= n - 1) return [0, n - 1];
      let lo = Math.max(0, Math.min(a0, n - 1 - want));
      return [lo, Math.min(n - 1, lo + want)];
    };
    const [c0, c1] = clampWin(Math.floor((x0 - g.x0) / g.res), Math.ceil((x1 - g.x0) / g.res), g.width);
    const [r0, r1] = clampWin(Math.floor((g.y0 - y1) / g.res), Math.ceil((g.y0 - y0) / g.res), g.height);
    if (!(c1 > c0 && r1 > r0)) throw new Error("the route is outside this site's terrain");
    const step = Math.max(1, Math.ceil(Math.max(c1 - c0, r1 - r0) / 360));
    const L = await this.call("elevWindow", { r0, c0, r1, c1, step });
    this.local = L;
    this.ox = g.x0 + (L.c0 + (L.nc - 1) * L.step / 2 + 0.5) * g.res;
    this.oy = g.y0 - (L.r0 + (L.nr - 1) * L.step / 2 + 0.5) * g.res;
    let zs = 0, n = 0;
    for (const z of L.z) if (Number.isFinite(z)) { zs += z; n++; }
    this.zRef = n ? zs / n : 0;
    // local terrain mesh
    const wM = (L.nc - 1) * L.step * g.res, hM = (L.nr - 1) * L.step * g.res;
    const geo = new THREE.PlaneGeometry(wM, hM, L.nc - 1, L.nr - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const X = pos.getX(i), Z = pos.getZ(i), z = L.z[i];
      pos.setY(i, ((Number.isFinite(z) ? z : this.zRef) - this.zRef) * this.exag - (X * X + Z * Z) / (2 * R_MARS));
    }
    geo.computeVertexNormals();
    const tex = await this._texture(L, wM, hM);
    this.terrain = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex }));
    this.group.add(this.terrain);
    // far terrain: regional DEM for the skyline
    const R = await this.call("regionalWindow", { step: 2 });
    const rg = R.grid;
    const rw = (R.nc - 1) * R.step * rg.res, rh = (R.nr - 1) * R.step * rg.res;
    const rgeo = new THREE.PlaneGeometry(rw, rh, R.nc - 1, R.nr - 1);
    rgeo.rotateX(-Math.PI / 2);
    const rcx = rg.x0 + ((R.nc - 1) * R.step / 2 + 0.5) * rg.res, rcy = rg.y0 - ((R.nr - 1) * R.step / 2 + 0.5) * rg.res;
    rgeo.translate(rcx - this.ox, 0, this.oy - rcy);
    const rp = rgeo.attributes.position;
    // cells without data (outside the regional DEM's coverage) take the nearest valid value along their row, so the
    // skyline has no holes and no NaN vertices
    const rz = Float32Array.from(R.z);
    for (let r = 0; r < R.nr; r++) {
      const row = r * R.nc;
      let last = NaN;
      for (let c = 0; c < R.nc; c++) { if (Number.isFinite(rz[row + c])) last = rz[row + c]; else rz[row + c] = last; }
      last = NaN;
      for (let c = R.nc - 1; c >= 0; c--) { if (Number.isFinite(rz[row + c])) last = rz[row + c]; else rz[row + c] = Number.isFinite(last) ? last : this.zRef; }
    }
    for (let i = 0; i < rp.count; i++) {
      const X = rp.getX(i), Z = rp.getZ(i);
      const inside = Math.abs(X) < wM / 2 - 50 && Math.abs(Z) < hM / 2 - 50;
      rp.setY(i, (rz[i] - this.zRef) * this.exag - (X * X + Z * Z) / (2 * R_MARS) - (inside ? 25 : 3));
    }
    rgeo.computeVertexNormals();
    const rtex = await new THREE.TextureLoader().loadAsync(new URL(this.ctx.imagery.regional.file, this.map.base).href);
    rtex.colorSpace = THREE.SRGBColorSpace;
    this.group.add(new THREE.Mesh(rgeo, new THREE.MeshLambertMaterial({ map: rtex })));
    this._markers();
    this._sun();
    this.orbit.target.set(0, 0, 0);
    this.orbit.dist = Math.max(2500, half * 2.2);
  }

  async _texture(L, wM, hM) {
    const g = this.ctx.grid, im = this.ctx.imagery;
    const px = Math.min(this.texCap || 2048, Math.round(wM / 2)), sc = px / wM; // px per metre (GPU memory budget)
    const cv = document.createElement("canvas");
    cv.width = px; cv.height = Math.round(hM * sc);
    const c = cv.getContext("2d");
    const wx0 = g.x0 + (L.c0 + 0.5) * g.res, wy0 = g.y0 - (L.r0 + 0.5) * g.res; // world coords of the window's NW vertex
    if (this.map.ortho) {
      const o = im.ortho5, s5 = 5;
      c.drawImage(this.map.ortho, (wx0 - g.x0) / s5, (g.y0 - wy0) / s5, wM / s5, hM / s5, 0, 0, cv.width, cv.height);
    }
    // 2 m HiRISE relief tiles where they exist
    const tiles = (im.hi2?.tiles || []).filter((t) => {
      const tx0 = g.x0 + t.c0 * g.res, ty0 = g.y0 - t.r0 * g.res, tw = t.cells * g.res;
      return tx0 < wx0 + wM && tx0 + tw > wx0 && ty0 > wy0 - hM && ty0 - tw < wy0;
    });
    await Promise.all(tiles.map((t) => this._img(t.file).then((img) => {
      if (!img) return;
      const tx0 = g.x0 + t.c0 * g.res, ty0 = g.y0 - t.r0 * g.res, tw = t.cells * g.res;
      c.globalAlpha = 0.92;
      c.drawImage(img, (tx0 - wx0) * sc, (wy0 - ty0) * sc, tw * sc, tw * sc);
      c.globalAlpha = 1;
    })));
    // the active hazard overlay (fine grid, one pixel per 10 m cell)
    if (this.map.overlay) {
      c.globalAlpha = 0.75;
      c.imageSmoothingEnabled = false;
      c.drawImage(this.map.overlay, L.c0, L.r0, (L.nc - 1) * L.step + 1, (L.nr - 1) * L.step + 1, 0, 0, cv.width, cv.height);
      c.globalAlpha = 1;
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    return tex;
  }

  _img(file) {
    if (!this.tiles.has(file)) {
      this.tiles.set(file, new Promise((res) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = () => res(null);
        img.src = new URL(file, this.map.base).href;
      }));
    }
    return this.tiles.get(file);
  }

  /** Ground height between the local terrain's vertices (bilinear), for what has to sit on the surface itself. */
  _groundSmooth(x, y) {
    const L = this.local, g = this.ctx.grid;
    const c = Math.max(0, Math.min(L.nc - 1.001, ((x - g.x0) / g.res - 0.5 - L.c0) / L.step));
    const r = Math.max(0, Math.min(L.nr - 1.001, ((g.y0 - y) / g.res - 0.5 - L.r0) / L.step));
    const c0 = Math.floor(c), r0 = Math.floor(r), fc = c - c0, fr = r - r0;
    const z = (i, j) => { const v = L.z[i * L.nc + j]; return Number.isFinite(v) ? v : this.zRef; };
    return (z(r0, c0) * (1 - fc) + z(r0, c0 + 1) * fc) * (1 - fr) + (z(r0 + 1, c0) * (1 - fc) + z(r0 + 1, c0 + 1) * fc) * fr;
  }

  _onGround(lon, lat, lift = 0) {
    const [x, y] = lonlatToXY(lon, lat);
    return this._w(x, y, this._groundAt(x, y) + lift / this.exag);
  }

  _label(text, color = "#f2f5f8") {
    const cv = document.createElement("canvas");
    const ctx = cv.getContext("2d");
    ctx.font = "600 28px 'Barlow Condensed', system-ui, sans-serif";
    cv.width = Math.ceil(ctx.measureText(text).width) + 20;
    cv.height = 40;
    const c2 = cv.getContext("2d");
    c2.font = "600 28px 'Barlow Condensed', system-ui, sans-serif";
    c2.fillStyle = "rgba(11,15,20,0.8)";
    c2.fillRect(0, 0, cv.width, cv.height);
    c2.fillStyle = color;
    c2.fillText(text, 10, 29);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false }));
    sp.userData.aspect = cv.width / cv.height;
    return sp;
  }

  _markers() {
    const { route, stations, base, pins, diag } = this.ctx;
    this.labels = [];
    const pole = (p, color, h, text) => {
      const top = this._onGround(p.lon, p.lat, h);
      const bot = this._onGround(p.lon, p.lat, 0);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, top.y - bot.y, 8), new THREE.MeshBasicMaterial({ color }));
      m.position.set(bot.x, (top.y + bot.y) / 2, bot.z);
      const s = new THREE.Mesh(new THREE.SphereGeometry(4, 16, 12), new THREE.MeshBasicMaterial({ color }));
      s.position.copy(top);
      this.group.add(m, s);
      if (text) { const l = this._label(text); l.position.copy(top).add(new THREE.Vector3(0, 12, 0)); this.group.add(l); this.labels.push(l); }
    };
    if (base && this.ctx.habitat !== false) {              // a survey of a place has no habitat at its centre
      const b = this._onGround(base.lon, base.lat, 0);
      const hab = new THREE.Mesh(new THREE.CylinderGeometry(8, 8, 7, 24), new THREE.MeshLambertMaterial({ color: 0xf2f5f8 }));
      hab.position.set(b.x, b.y + 3.5, b.z);
      this.group.add(hab);
      pole(base, 0xf2f5f8, 40, "HAB");
    }
    (stations || []).forEach((s, k) => pole(s, s.skip ? 0x8a8f96 : 0xffc629, 35, `${s.label ?? k + 1} ${s.name.split(/[,(]/)[0].trim()}`));
    (pins || []).forEach((p, k) => pole(p, 0x3ccbff, 20, `PIN ${k + 1}`));
    if (diag?.pnr) pole(diag.pnr, 0xff7470, 45, "POINT OF NO RETURN");
    this.routeOrbit = new THREE.Group();
    this.routeHelmet = new THREE.Group();
    this.routeCrew = new THREE.Group();
    this.group.add(this.routeOrbit, this.routeHelmet, this.routeCrew);
    if (route?.length > 1) {
      // white core riding on top of a wider dark casing (legible on every Mars tone, research doc 17)
      this._tube(route, 2, 8, 0x0b0f14, this.routeOrbit);
      this._tube(route, 6.5, 5, 0xf2f5f8, this.routeOrbit);
      this._tube(route, 0.25, 0.32, 0x0b0f14, this.routeHelmet);
      this.curve = this._tube(route, 0.45, 0.2, 0xf2f5f8, this.routeHelmet);
      // the crew view stands beside the route, not on it: a band painted on the ground reads better than a pipe
      this._ribbon(route, 1.2, 0.35, 0xf2f5f8, 0.8, this.routeCrew);
    }
    this.crewMesh = new THREE.Mesh(new THREE.SphereGeometry(3, 16, 12), new THREE.MeshBasicMaterial({ color: 0xd8a57a }));
    this.crewMesh.visible = false;
    this.group.add(this.crewMesh);
    this.trackMesh = null;
    if (this.trackSpec) this.setTrack(...this.trackSpec);
  }

  /** A tube along `ll` (points with lon, lat) lifted `lift` m off the ground, added to `into`; returns its curve. */
  _tube(ll, lift, r, color, into) {
    const pts = [];
    let last = null;
    for (const p of ll) {
      const v = this._onGround(p.lon, p.lat, lift);
      if (!last || v.distanceTo(last) > 12) { pts.push(v); last = v; }
    }
    if (pts.length < 2) return null;
    const curve = new THREE.CatmullRomCurve3(pts, false, "centripetal");
    into.add(new THREE.Mesh(new THREE.TubeGeometry(curve, Math.min(2500, pts.length * 2), r, 6), new THREE.MeshBasicMaterial({ color })));
    return curve;
  }

  /** A flat band `width` m wide, `lift` m above the ground along `ll` (points with lon, lat), added to `into`. */
  _ribbon(ll, width, lift, color, opacity, into) {
    const xy = [];
    let last = null;
    for (const p of ll) {
      const [x, y] = lonlatToXY(p.lon, p.lat);
      if (last) {
        const n = Math.ceil(Math.hypot(x - last[0], y - last[1]) / 4);
        for (let k = 1; k <= n; k++) xy.push([last[0] + (x - last[0]) * k / n, last[1] + (y - last[1]) * k / n]);
      } else xy.push([x, y]);
      last = [x, y];
    }
    if (xy.length < 2) return null;
    const pos = new Float32Array(xy.length * 6), idx = [];
    for (let i = 0; i < xy.length; i++) {
      const [x, y] = xy[i], [xa, ya] = xy[Math.max(0, i - 1)], [xb, yb] = xy[Math.min(xy.length - 1, i + 1)];
      const L = Math.hypot(xb - xa, yb - ya) || 1, nx = -(yb - ya) / L * width / 2, ny = (xb - xa) / L * width / 2;
      const a = this._w(x + nx, y + ny, this._groundSmooth(x + nx, y + ny) + lift / this.exag);
      const b = this._w(x - nx, y - ny, this._groundSmooth(x - nx, y - ny) + lift / this.exag);
      pos.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
      if (i) idx.push(2 * i - 2, 2 * i - 1, 2 * i, 2 * i - 1, 2 * i + 1, 2 * i);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    m.renderOrder = 2;
    into.add(m);
    return m;
  }

  /** The crew view's path when it is not the filed plan (a re-plan or the return home), in its own colour. */
  setTrack(ll, color) {
    this.trackSpec = ll?.length > 1 ? [ll, color] : null;
    if (this.trackMesh) { this.routeCrew.remove(this.trackMesh); this._dispose(this.trackMesh); this.trackMesh = null; }
    if (!this.trackSpec || !this.routeCrew) return;
    this.trackMesh = this._ribbon(ll, 1.4, 0.45, color, 0.9, this.routeCrew);
    this.render();
  }

  _sun() {
    const { base, ms } = this.ctx;
    const st = marsState(jdTT(ms));
    const s = sunPosition(st, base.lon, base.lat);
    const el = Math.max(2, s.elevation) * Math.PI / 180, az = s.azimuth * Math.PI / 180;
    this.sun.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).multiplyScalar(10000);
    this.sunInfo = s;
  }

  setMode(mode) {
    this.mode = mode;
    if (mode === "helmet") this.setFly(this.flyT);
    this.render();
  }

  setExag(x) {
    this.exag = x;
    return this._build().then(() => this.setMode(this.mode));
  }

  /** Helmet view at fraction t of the route: 1.8 m eye height, looking along the route. */
  setFly(t) {
    this.flyT = t;
    if (!this.curve) {
      const b = this.ctx?.base;
      if (!b) return;
      const [x, y] = lonlatToXY(b.lon, b.lat);
      this.eye = this._w(x, y, this._groundAt(x, y));
      this.eye.y += 1.8;
      this.render();
      return;
    }
    const p = this.curve.getPointAt(Math.min(0.999, t));
    const q = this.curve.getPointAt(Math.min(1, t + 0.004));
    const [x, y] = [p.x + this.ox, this.oy - p.z];
    const eye = this._w(x, y, this._groundAt(x, y));
    eye.y = Math.max(eye.y, p.y - 0.45) + 1.8; // eye 1.8 m above the ground under the route
    this.eye = eye;
    this.look.yaw = Math.atan2(q.x - p.x, -(q.z - p.z));
    this.render();
  }

  /** Crew view (the helmet visor): the eye `h` m above the ground at lon / lat (1.8 m standing, 2.25 m in the rover's
   *  seat), facing `heading` (radians east of north). Dragging looks around from there (look.yaw is then the offset
   *  from the heading); recentre() looks ahead. */
  setEye(lon, lat, heading, h = 1.8) {
    this.mode = "crew";
    const [x, y] = lonlatToXY(lon, lat);
    this.eye = this._w(x, y, this._groundSmooth(x, y) + h / this.exag);
    this.heading = heading;
    this.render();
  }

  recentre() {
    this.look.yaw = 0;
    this.look.pitch = -0.05;
    this.render();
  }

  /** Whether lon / lat is on the detailed terrain, at least `margin` m inside its edge. */
  contains(lon, lat, margin = 300) {
    if (!this.local) return false;
    const [x, y] = lonlatToXY(lon, lat), g = this.ctx.grid, L = this.local;
    const wx0 = g.x0 + (L.c0 + 0.5) * g.res, wy0 = g.y0 - (L.r0 + 0.5) * g.res;
    const wM = (L.nc - 1) * L.step * g.res, hM = (L.nr - 1) * L.step * g.res;
    return x > wx0 + margin && x < wx0 + wM - margin && y < wy0 - margin && y > wy0 - hM + margin;
  }

  play(on) {
    this.playing = on;
    if (!on) return;
    const tick = () => {
      if (!this.playing) return;
      this.setFly(this.flyT >= 0.995 ? 0 : this.flyT + 0.0006);
      this.onFly?.(this.flyT);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  render() {
    if (!this.renderer || !this.scene || this.lost) return;
    const cam = this.camera;
    if (this.routeOrbit) { this.routeOrbit.visible = this.mode === "orbit"; this.routeHelmet.visible = this.mode === "helmet"; this.routeCrew.visible = this.mode === "crew"; }
    if (this.mode === "orbit") {
      const o = this.orbit;
      cam.position.set(o.target.x + o.dist * Math.sin(o.phi) * Math.sin(o.theta), o.target.y + o.dist * Math.cos(o.phi),
        o.target.z + o.dist * Math.sin(o.phi) * Math.cos(o.theta));
      cam.lookAt(o.target);
      for (const l of this.labels || []) { const s = o.dist / 45; l.scale.set(s * l.userData.aspect, s, 1); l.visible = true; }
    } else if (this.eye) {
      cam.position.copy(this.eye);
      const { pitch } = this.look, yaw = this.look.yaw + (this.mode === "crew" ? this.heading : 0);
      cam.lookAt(this.eye.x + Math.sin(yaw) * Math.cos(pitch), this.eye.y + Math.sin(pitch), this.eye.z - Math.cos(yaw) * Math.cos(pitch));
      for (const l of this.labels || []) { const d = l.position.distanceTo(cam.position), s = d / 30; l.scale.set(s * l.userData.aspect, s, 1); }
    }
    this.renderer.render(this.scene, cam);
  }
}
