// planet.js - the whole of Mars in 3D, streamed like a flight simulator.
// The planet is a quadtree of equirectangular tiles (NASA Mars Trek's EQ tiling: zoom 0 = two 180 deg tiles). Each frame
// the tree is walked from the two root tiles: a tile is split when its on-screen size exceeds ~1.3 tile widths, hidden
// when it is behind the horizon or outside the view, and a parent keeps drawing until all four children have arrived, so
// the ground never has holes. Tiles come from the local server (/tiles/dem, /tiles/img), which builds them on demand
// from the real data (MOLA, HRSC-MOLA 200 m, CTX 20 m, HiRISE 1 m; Viking colour, CTX / HiRISE orthoimages) and keeps a
// disk cache. Geometry is built relative to each tile's centre (floating origin), so a 20 m crater is as steady as the
// globe. Units: kilometres.
import * as THREE from "../vendor/three.module.min.js";

const $ = (id) => document.getElementById(id);
const R = 3396.19;                       // Mars sphere radius, km (IAU 2015; same as the data's datum)
const DEG = Math.PI / 180;
const MAXZ = 14;                         // finest zoom requested (~2 m / imagery pixel at the equator)
const GRID = 65;                         // vertices per tile edge (DEM tiles are 257 x 257; every 4th sample)
const MAX_LOADS = 6;                     // concurrent tile downloads
const MAX_TILES = 700;                   // tiles kept in memory before the least recently used are dropped
const SPLIT_PX = 330;                    // split a tile when it covers more than this many pixels

// ----------------------------------------------------------------------------------------------- geometry helpers
function pos(lon, lat, r, out = new THREE.Vector3()) {
  const cl = Math.cos(lat * DEG);
  return out.set(r * cl * Math.cos(lon * DEG), r * Math.sin(lat * DEG), -r * cl * Math.sin(lon * DEG));
}
function lonlatOf(v) {
  const r = v.length();
  return { lon: Math.atan2(-v.z, v.x) / DEG, lat: Math.asin(Math.max(-1, Math.min(1, v.y / r))) / DEG, r };
}
const wrap180 = (l) => ((((l + 180) % 360) + 360) % 360) - 180;
const tileDeg = (z) => 180 / (1 << z);
function tileOf(lon, lat, z) {
  const d = tileDeg(z), nx = 2 << z, ny = 1 << z;
  return [Math.min(ny - 1, Math.max(0, Math.floor((90 - lat) / d))), Math.floor((((lon + 180) % 360 + 360) % 360) / d) % nx];
}
function haversineKm(a, b) {
  const p1 = a[1] * DEG, p2 = b[1] * DEG, dp = p2 - p1, dl = (b[0] - a[0]) * DEG;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
const fmtKm = (km) => km >= 100 ? `${km.toFixed(0)} km` : km >= 1 ? `${km.toFixed(1)} km` : `${(km * 1000).toFixed(0)} m`;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ------------------------------------------------------------------------------------------------------ state
const S = {
  layer: "best", exag: 1,
  cam: { lon: 77.5, lat: 18.4, range: 9000, heading: 0, tilt: 0 },   // range: km from the target point
  targetElev: 0,
  route: [], routeResult: null, pick: null, landing: null, names: [], sites: [], coverage: null,
  online: false,
};

// ------------------------------------------------------------------------------------------------------ renderer
const canvas = $("globe");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1e6);
scene.add(camera);
scene.add(new THREE.AmbientLight(0xffffff, 1.35));
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(-0.5, 0.8, 1);                     // a headlight from the upper left of the view: relief reads as relief
camera.add(sun);
const tilesGroup = new THREE.Group(); scene.add(tilesGroup);
const overlay = new THREE.Group(); scene.add(overlay);

// stars and a thin atmosphere
{
  const g = new THREE.BufferGeometry(), n = 3000, p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const v = new THREE.Vector3().randomDirection().multiplyScalar(4e5); p.set([v.x, v.y, v.z], i * 3); }
  g.setAttribute("position", new THREE.BufferAttribute(p, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xbfc6d0, size: 1.2, sizeAttenuation: false })));
  const atm = new THREE.Mesh(new THREE.SphereGeometry(R * 1.018, 96, 48), new THREE.ShaderMaterial({
    side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: "varying vec3 vN; varying vec3 vP; void main(){ vN = normalize(normalMatrix*normal); vec4 mv = modelViewMatrix*vec4(position,1.0); vP = mv.xyz; gl_Position = projectionMatrix*mv; }",
    fragmentShader: "varying vec3 vN; varying vec3 vP; void main(){ float f = pow(1.0 - abs(dot(normalize(-vP), vN)), 3.0); gl_FragColor = vec4(0.85,0.55,0.35, f*0.55); }",
  }));
  atm.name = "atmosphere";
  scene.add(atm);
}

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);

// ------------------------------------------------------------------------------------------------- tile store
const tiles = new Map();           // key -> tile {z,y,x,bbox,state,heights,mesh,center,radius,used}
const queue = new Set();
let loading = 0, frameNo = 0, loadedTotal = 0, failedTotal = 0;
const key = (z, y, x) => `${z}/${y}/${x}`;

function getTile(z, y, x) {
  const k = key(z, y, x);
  let t = tiles.get(k);
  if (!t) {
    const d = tileDeg(z), w = -180 + x * d, n = 90 - y * d;
    t = { k, z, y, x, bbox: [w, n - d, w + d, n], state: "new", used: 0 };
    const clat = Math.max(-89.9, Math.min(89.9, n - d / 2));
    t.center = pos(w + d / 2, clat, R);
    // bounding sphere: farthest corner from the centre, plus room for 21 km of relief (exaggerated)
    let rad = 0;
    for (const [lo, la] of [[w, n], [w + d, n], [w, n - d], [w + d, n - d], [w + d / 2, n], [w + d / 2, n - d]]) rad = Math.max(rad, pos(lo, la, R).distanceTo(t.center));
    t.radius = rad + 25 * S.exag;
    t.angR = Math.min(Math.PI, rad / R);
    tiles.set(k, t);
  }
  return t;
}

function decodeMMD(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== "MMD1") throw new Error("not an MMD1 tile");
  const n = dv.getUint16(4, true), lo = dv.getFloat32(8, true), scale = dv.getFloat32(12, true), ml = dv.getUint32(16, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, ml)));
  let off = 20 + ml; if (off % 2) off += 1;
  const q = new Uint16Array(buf.slice(off, off + n * n * 2));
  const h = new Float32Array(n * n);
  let fill = 0, cnt = 0;
  for (let i = 0; i < q.length; i++) if (q[i] !== 65535) { fill += lo + q[i] * scale; cnt++; }
  fill = cnt ? fill / cnt : 0;
  for (let i = 0; i < q.length; i++) h[i] = q[i] === 65535 ? fill : lo + q[i] * scale;
  return { n, h, meta };
}

// the imagery layer asked for: the chosen mosaic, or the landing-safety map for the chosen lander
function imgLayer() { return $("safeChk").checked ? `safety&lander=${$("landerSel").value}` : S.layer; }
function reloadTextures() {
  const want = imgLayer();
  for (const t of tiles.values()) if (t.state === "ready") {
    t.texLayer = want;
    loadTexture(t).then((tex) => {
      if (t.texLayer !== want || !t.mesh) { tex.dispose(); return; }
      t.mesh.material.map?.dispose(); t.mesh.material.map = tex; t.mesh.material.needsUpdate = true;
      if (t.provisional && !t.refreshAt) t.refreshAt = performance.now() + 20000;
    }).catch(() => null);
  }
}
function loadTexture(t) {
  const url = `/tiles/img/${t.z}/${t.y}/${t.x}.jpg?layer=${imgLayer()}`;
  // fetch (not the image loader) so the "provisional" header can be read
  return fetch(url).then((r) => {
    if (!r.ok) throw new Error(`imagery ${r.status}`);
    if (r.headers.get("X-MM-Provisional")) t.provisional = true;
    return r.blob();
  }).then((b) => createImageBitmap(b, { imageOrientation: "flipY" })).then((bmp) => {
    const tex = new THREE.CanvasTexture(bmp);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  });
}

async function loadTile(t) {
  const refresh = t.state === "ready";          // re-fetch of a provisional tile: keep drawing the old one meanwhile
  if (!refresh) t.state = "loading";
  t.provisional = false;
  loading++;
  try {
    const [dem, tex] = await Promise.all([
      fetch(`/tiles/dem/${t.z}/${t.y}/${t.x}.mmd`).then((r) => {
        if (!r.ok) throw new Error(`DEM ${r.status}`);
        if (r.headers.get("X-MM-Provisional")) t.provisional = true;
        return r.arrayBuffer();
      }).then(decodeMMD),
      loadTexture(t).catch(() => null),
    ]);
    if (refresh && t.mesh?.material.map && tex) t.mesh.material.map.dispose();
    t.dem = dem;
    t.tex = tex;
    const vis = t.mesh?.visible;
    buildMesh(t);
    if (vis) t.mesh.visible = true;
    if (!refresh) loadedTotal++;
    t.state = "ready";
    t.refreshAt = t.provisional ? performance.now() + 20000 : 0;   // better data is downloading on the server: ask again
  } catch (e) {
    if (refresh) { t.refreshAt = performance.now() + 30000; return; }
    t.state = "error"; t.err = String(e); failedTotal++;
    t.retryAt = performance.now() + 8000;
  } finally {
    loading--;
    pump();
  }
}

function buildMesh(t) {
  if (t.mesh) { tilesGroup.remove(t.mesh); t.mesh.geometry.dispose(); }
  const { n, h } = t.dem;
  const [w, s, e, nn] = t.bbox;
  const G = GRID, step = (n - 1) / (G - 1);
  const E = S.exag / 1000;                                 // metres of elevation -> km, exaggerated
  const skirt = Math.max(0.05, tileDeg(t.z) * DEG * R * 0.02) ;
  const V = G + 2;                                          // an outer ring of skirt vertices hangs below the edges
  const P = new Float32Array(V * V * 3), UV = new Float32Array(V * V * 2);
  const v = new THREE.Vector3();
  const org = t.center;
  for (let j = 0; j < V; j++) {
    const gj = Math.min(G - 1, Math.max(0, j - 1));
    const lat = nn - (nn - s) * gj / (G - 1);
    for (let i = 0; i < V; i++) {
      const gi = Math.min(G - 1, Math.max(0, i - 1));
      const lon = w + (e - w) * gi / (G - 1);
      const hv = h[Math.round(gj * step) * n + Math.round(gi * step)];
      const edge = i === 0 || j === 0 || i === V - 1 || j === V - 1;
      pos(lon, lat, R + hv * E - (edge ? skirt : 0), v).sub(org);
      P.set([v.x, v.y, v.z], (j * V + i) * 3);
      UV.set([gi / (G - 1), 1 - gj / (G - 1)], (j * V + i) * 2);
    }
  }
  const idx = new Uint32Array((V - 1) * (V - 1) * 6);
  let k = 0;
  for (let j = 0; j < V - 1; j++) for (let i = 0; i < V - 1; i++) {
    const a = j * V + i, b = a + 1, c = a + V, d = c + 1;
    idx.set([a, c, b, b, c, d], k); k += 6;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(P, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(UV, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  const mat = t.mesh?.material || new THREE.MeshLambertMaterial({ color: t.tex ? 0xffffff : 0xb07a55 });
  if (t.tex) { mat.map = t.tex; mat.color.set(0xffffff); mat.needsUpdate = true; }
  t.mesh = new THREE.Mesh(g, mat);
  t.mesh.position.copy(org);
  t.mesh.matrixAutoUpdate = false; t.mesh.updateMatrix();
  t.mesh.userData.tile = t;
  t.mesh.visible = false;
  tilesGroup.add(t.mesh);
}

function disposeTile(t) {
  if (t.mesh) { tilesGroup.remove(t.mesh); t.mesh.geometry.dispose(); t.mesh.material.map?.dispose(); t.mesh.material.dispose(); }
  tiles.delete(t.k);
}

function want(t, prio) {
  if (t.state === "new" || (t.state === "error" && performance.now() > t.retryAt)) { t.prio = prio; queue.add(t); }
}
function pump() {
  if (loading >= MAX_LOADS || !queue.size) return;
  const list = [...queue].filter((t) => t.used >= frameNo - 2 || t.z <= 1).sort((a, b) => a.prio - b.prio);
  queue.clear();
  for (const t of list) {
    if (loading >= MAX_LOADS) { queue.add(t); continue; }
    if (t.state === "new" || t.state === "error") loadTile(t);
  }
}

// elevation (m) at a point from the finest tile in memory
function elevAt(lon, lat) {
  for (let z = MAXZ; z >= 0; z--) {
    const [y, x] = tileOf(lon, lat, z);
    const t = tiles.get(key(z, y, x));
    if (!t || !t.dem) continue;
    const [w, s, e, n] = t.bbox, N = t.dem.n;
    const gx = Math.min(N - 1.001, Math.max(0, ((lon - w + 360) % 360) / (e - w) * (N - 1)));
    const gy = Math.min(N - 1.001, Math.max(0, (n - lat) / (n - s) * (N - 1)));
    const i = Math.floor(gx), j = Math.floor(gy), a = gx - i, b = gy - j, H = t.dem.h;
    return (H[j * N + i] * (1 - a) + H[j * N + i + 1] * a) * (1 - b) + (H[(j + 1) * N + i] * (1 - a) + H[(j + 1) * N + i + 1] * a) * b;
  }
  return 0;
}
const surf = (lon, lat, liftKm = 0, elevM = null) => pos(lon, lat, R + (elevM ?? elevAt(lon, lat)) * S.exag / 1000 + liftKm);

// ------------------------------------------------------------------------------------------------- camera
const tmp = new THREE.Vector3();
function placeCamera() {
  const c = S.cam;
  c.lat = Math.max(-89.9, Math.min(89.9, c.lat)); c.lon = wrap180(c.lon);
  c.range = Math.max(0.03, Math.min(40000, c.range));
  c.tilt = Math.max(0, Math.min(c.range < 3000 ? 80 : 80 * Math.max(0, (6000 - c.range) / 3000), c.tilt));
  S.targetElev += (elevAt(c.lon, c.lat) - S.targetElev) * 0.25;
  const T = pos(c.lon, c.lat, R + S.targetElev * S.exag / 1000);
  const U = T.clone().normalize();
  const E = new THREE.Vector3(-Math.sin(c.lon * DEG), 0, -Math.cos(c.lon * DEG));
  const N = new THREE.Vector3().crossVectors(U, E).normalize();
  const H = c.heading * DEG, tl = c.tilt * DEG;
  const fwd = N.clone().multiplyScalar(Math.cos(H)).addScaledVector(E, Math.sin(H));   // horizontal view direction
  const d = U.clone().multiplyScalar(-Math.cos(tl)).addScaledVector(fwd, Math.sin(tl)); // camera -> target
  const P = T.clone().addScaledVector(d, -c.range);
  // never below the ground
  const ll = lonlatOf(P);
  const ground = R + elevAt(ll.lon, ll.lat) * S.exag / 1000 + Math.max(0.02, c.range * 0.02);
  if (ll.r < ground) P.setLength(ground);
  camera.position.copy(P);
  camera.up.copy(c.tilt < 1 ? fwd : U);
  camera.lookAt(T);
  const alt = P.length() - R;
  camera.near = Math.max(0.0005, alt * 0.05 * Math.cos(tl) ** 2);
  camera.far = P.length() + R * 1.5 + 5e5;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}

// ------------------------------------------------------------------------------------------------- LOD walk
const frustum = new THREE.Frustum(), projView = new THREE.Matrix4(), sphere = new THREE.Sphere();
function selectTiles() {
  frameNo++;
  projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projView);
  const camP = camera.position, camDist = camP.length();
  const camDir = camP.clone().normalize();
  const horizon = Math.acos(Math.min(1, R / camDist));
  const pxPerRad = canvas.clientHeight / (2 * Math.tan(camera.fov * DEG / 2));
  const draw = [];
  let wanted = 0;

  const visible = (t) => {
    const ang = Math.acos(Math.max(-1, Math.min(1, camDir.dot(tmp.copy(t.center).normalize()))));
    if (ang - t.angR > horizon + 0.02 + (21 * S.exag) / R) return false;
    sphere.center.copy(t.center); sphere.radius = t.radius;
    return frustum.intersectsSphere(sphere);
  };
  const split = (t) => {
    if (t.z >= MAXZ) return false;
    const d = Math.max(0.001, camP.distanceTo(t.center) - t.radius * 0.7);
    const size = tileDeg(t.z) * DEG * R;              // N-S edge, km
    return size / d * pxPerRad > SPLIT_PX;
  };
  const visit = (t) => {
    t.used = frameNo;
    if (!visible(t)) return;
    const prio = t.z * 0.2 + camP.distanceTo(t.center) / (tileDeg(t.z) * DEG * R);
    if (t.state !== "ready") { want(t, prio); wanted++; return; }
    if (split(t)) {
      const kids = [];
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) kids.push(getTile(t.z + 1, t.y * 2 + dy, t.x * 2 + dx));
      // only the children in view matter (the others would never be drawn)
      const inView = kids.filter((c) => { c.used = frameNo; return visible(c); });
      if (inView.every((c) => c.state === "ready")) { inView.forEach(visit); return; }
      // children still coming (or unavailable): keep drawing this tile, never a mix of parent and children
      inView.forEach((c) => { if (c.state !== "loading" && c.state !== "ready") { want(c, prio + 0.5); wanted++; } });
    }
    draw.push(t);
  };
  for (const x of [0, 1]) { const r = getTile(0, 0, x); r.used = frameNo; if (r.state !== "ready") { want(r, -1); } visit(r); }
  for (const t of tiles.values()) if (t.mesh) t.mesh.visible = false;
  for (const t of draw) if (t.mesh) t.mesh.visible = true;
  const now = performance.now();
  for (const t of draw) if (t.refreshAt && now > t.refreshAt && loading < MAX_LOADS) { t.refreshAt = 0; loadTile(t); }
  pump();
  // evict least recently used
  if (tiles.size > MAX_TILES) {
    const old = [...tiles.values()].filter((t) => t.z > 1 && t.used < frameNo - 30 && t.state !== "loading").sort((a, b) => a.used - b.used);
    for (const t of old.slice(0, tiles.size - MAX_TILES)) disposeTile(t);
  }
  return { drawn: draw.length, wanted };
}

// ------------------------------------------------------------------------------------------------- overlays
const labelsEl = $("labels");
const markers = [];      // {el, lon, lat, elev, kind}
function clearMarkers(kind) {
  for (let i = markers.length - 1; i >= 0; i--) if (markers[i].kind === kind) { markers[i].el.remove(); markers.splice(i, 1); }
}
function addMarker(kind, lon, lat, text, onClick, title) {
  const el = document.createElement("div");
  el.className = `mk ${kind}`; el.textContent = text;
  if (title) el.title = title;
  if (onClick) el.onclick = (ev) => { ev.stopPropagation(); onClick(); };
  labelsEl.appendChild(el);
  markers.push({ el, lon, lat, kind });
  return el;
}
function updateMarkers() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const camP = camera.position, camDist = camP.length(), horizon = Math.acos(Math.min(1, R / camDist));
  const camDir = camP.clone().normalize();
  const showNames = $("namesChk").checked, showSites = $("sitesChk").checked;
  for (const m of markers) {
    if ((m.kind === "name" && !showNames) || (m.kind === "site" && !showSites)) { m.el.style.display = "none"; continue; }
    const p = surf(m.lon, m.lat, 0);
    const ang = Math.acos(Math.max(-1, Math.min(1, camDir.dot(tmp.copy(p).normalize()))));
    if (ang > horizon + 0.005) { m.el.style.display = "none"; continue; }
    p.project(camera);
    if (p.z > 1 || p.x < -1.1 || p.x > 1.1 || p.y < -1.1 || p.y > 1.1) { m.el.style.display = "none"; continue; }
    m.el.style.display = "";
    m.el.style.left = `${(p.x + 1) / 2 * w}px`;
    m.el.style.top = `${(1 - p.y) / 2 * h}px`;
  }
}

function lineFrom(points, color, opts = {}) {
  // points: [[lon, lat, elevM|null], ...]; positions relative to the first point (precision), lifted off the ground
  const lift = Math.max(0.01, Math.min(20, S.cam.range * 0.004));
  const org = surf(points[0][0], points[0][1], lift, points[0][2]);
  const arr = new Float32Array(points.length * 3);
  points.forEach((p, i) => { const v = surf(p[0], p[1], lift, p[2]).sub(org); arr.set([v.x, v.y, v.z], i * 3); });
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
  const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: opts.opacity ?? 1, depthTest: opts.depthTest ?? true }));
  line.position.copy(org);
  line.renderOrder = 5;
  return line;
}
let overlayRange = 0;
function rebuildOverlays() {
  overlayRange = S.cam.range;
  for (const c of [...overlay.children]) { overlay.remove(c); c.geometry.dispose(); c.material.dispose(); }
  const rr = S.routeResult;
  if (rr?.points?.length > 1) {
    const pts = rr.points.map((p) => [p[0], p[1], p[2]]);
    overlay.add(lineFrom(pts, 0x000000, { opacity: 0.6 }));
    overlay.add(lineFrom(pts, 0xffffff, { depthTest: false, opacity: 0.35 }));
    overlay.add(lineFrom(pts, 0xffffff));
  } else if (S.route.length > 1) {
    const pts = [];
    for (let i = 0; i < S.route.length - 1; i++) {
      const a = S.route[i], b = S.route[i + 1], n = 64;
      for (let k = 0; k <= n; k++) {
        const va = pos(a[0], a[1], 1), vb = pos(b[0], b[1], 1), v = va.lerp(vb, k / n);
        const ll = lonlatOf(v); pts.push([ll.lon, ll.lat, null]);
      }
    }
    overlay.add(lineFrom(pts, 0x9fb0c4, { opacity: 0.8 }));
  }
  if (S.landing?.ellipse) {
    const e = S.landing.ellipse.map((p) => [p[0], p[1], null]); e.push(e[0]);
    overlay.add(lineFrom(e, 0xffc629, { depthTest: false, opacity: 0.9 }));
  }
  if (S.coverage && $("covChk").checked) {
    const box = (b, color) => {
      const [w, s, e, n] = b, pts = [], k = 12;
      for (let i = 0; i <= k; i++) pts.push([w + (e - w) * i / k, n, null]);
      for (let i = 1; i <= k; i++) pts.push([e, n - (n - s) * i / k, null]);
      for (let i = 1; i <= k; i++) pts.push([e - (e - w) * i / k, s, null]);
      for (let i = 1; i <= k; i++) pts.push([w, s + (n - s) * i / k, null]);
      overlay.add(lineFrom(pts, color, { opacity: 0.85 }));
    };
    (S.coverage.ctx || []).slice(0, 300).forEach((c) => box(c.bbox, 0x3ccbff));
    (S.coverage.hirise || []).slice(0, 200).forEach((c) => box(c.bbox, 0x3ee07e));
  }
}

// ------------------------------------------------------------------------------------------------- input
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function pickAt(cx, cy) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects(tilesGroup.children.filter((m) => m.visible), false);
  if (hits.length) return lonlatOf(hits[0].point);
  // fall back to the bare sphere
  const o = ray.ray.origin, d = ray.ray.direction, b = o.dot(d), c = o.lengthSq() - R * R, disc = b * b - c;
  if (disc < 0) return null;
  return lonlatOf(o.clone().addScaledVector(d, -b - Math.sqrt(disc)));
}
let drag = null, dirty = true;
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, rot: e.button === 2 || e.shiftKey, t: performance.now() };
  canvas.classList.add("drag");
});
canvas.addEventListener("pointermove", (e) => {
  hoverAt(e.clientX, e.clientY);
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  const c = S.cam;
  if (drag.rot) {
    c.heading = (c.heading - dx * 0.3 + 360) % 360;
    c.tilt += dy * 0.25;
  } else {
    const kmPerPx = c.range * 2 * Math.tan(camera.fov * DEG / 2) / canvas.clientHeight * (c.tilt > 1 ? 1 : 1);
    const H = c.heading * DEG;
    const dN = (dx * Math.sin(H) + dy * Math.cos(H)) * kmPerPx;
    const dE = (-dx * Math.cos(H) + dy * Math.sin(H)) * kmPerPx;
    c.lat += dN / R / DEG;
    c.lon += dE / (R * Math.max(0.05, Math.cos(c.lat * DEG))) / DEG;
  }
  dirty = true;
});
canvas.addEventListener("pointerup", (e) => {
  canvas.classList.remove("drag");
  if (drag && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4 && performance.now() - drag.t < 500 && e.button === 0) {
    const p = pickAt(e.clientX, e.clientY);
    if (p) { selectPoint(p.lon, p.lat); if (S.hubMode) { $("landSec").scrollIntoView({ behavior: "smooth", block: "nearest" }); runLanding(); } }
  }
  drag = null;
});
canvas.addEventListener("dblclick", (e) => {
  const p = pickAt(e.clientX, e.clientY);
  if (p) flyTo(p.lon, p.lat, S.cam.range * 0.35);
});
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const f = Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 200) * 0.0022);
  // zoom towards the cursor: move the target part of the way to the point under the mouse
  if (f < 1) {
    const p = pickAt(e.clientX, e.clientY);
    if (p) {
      const c = S.cam, t = 1 - f;
      let dl = wrap180(p.lon - c.lon);
      c.lon += dl * t; c.lat += (p.lat - c.lat) * t;
    }
  }
  S.cam.range *= f;
  dirty = true;
}, { passive: false });
window.addEventListener("keydown", (e) => {
  if (e.target.closest("input, select, textarea")) return;
  const c = S.cam, step = c.range * 0.15 / R / DEG;
  const H = c.heading * DEG;
  const mv = (n, ea) => { c.lat += n * Math.cos(H) - ea * Math.sin(H); c.lon += (n * Math.sin(H) + ea * Math.cos(H)) / Math.max(0.05, Math.cos(c.lat * DEG)); };
  switch (e.key) {
    case "ArrowUp": mv(step, 0); break;
    case "ArrowDown": mv(-step, 0); break;
    case "ArrowLeft": mv(0, -step); break;
    case "ArrowRight": mv(0, step); break;
    case "+": case "=": c.range /= 1.4; break;
    case "-": case "_": c.range *= 1.4; break;
    case "q": case "Q": c.heading = (c.heading + 350) % 360; break;
    case "e": case "E": c.heading = (c.heading + 10) % 360; break;
    case "PageUp": c.tilt += 5; break;
    case "PageDown": c.tilt -= 5; break;
    case "n": case "N": c.heading = 0; c.tilt = 0; break;
    default: return;
  }
  e.preventDefault(); dirty = true;
});

let hoverT = 0;
function hoverAt(x, y) {
  const now = performance.now();
  if (now - hoverT < 90) return;
  hoverT = now;
  const p = pickAt(x, y);
  if (!p) { $("hudPos").textContent = "--"; return; }
  const el = elevAt(p.lon, p.lat);
  $("hudPos").textContent = `${Math.abs(p.lat).toFixed(4)}°${p.lat >= 0 ? "N" : "S"} ${Math.abs(p.lon).toFixed(4)}°${p.lon >= 0 ? "E" : "W"} · ${el.toFixed(0)} m`;
}

// smooth flights
let flight = null;
function flyTo(lon, lat, range, ms = 1800) {
  const c = S.cam;
  const from = { lon: c.lon, lat: c.lat, range: c.range };
  const dist = haversineKm([from.lon, from.lat], [lon, lat]);
  const peak = Math.max(from.range, range, Math.min(12000, dist * 1.2));
  flight = { from, to: { lon: from.lon + wrap180(lon - from.lon), lat, range: Math.max(0.05, range) }, t0: performance.now(), ms, peak };
}
function stepFlight(now) {
  if (!flight) return;
  const { from, to, t0, ms, peak } = flight;
  const u = Math.min(1, (now - t0) / ms), s = u * u * (3 - 2 * u);
  const c = S.cam;
  c.lon = from.lon + (to.lon - from.lon) * s;
  c.lat = from.lat + (to.lat - from.lat) * s;
  // log-space zoom out to the peak and back in
  const a = Math.log(from.range), b = Math.log(to.range), p = Math.log(peak);
  const lr = u < 0.5 ? a + (p - a) * Math.sin(u * Math.PI) : b + (p - b) * Math.sin(u * Math.PI);
  c.range = Math.exp(lr);
  dirty = true;
  if (u >= 1) flight = null;
}

// ------------------------------------------------------------------------------------------------- server API
async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function pollJob(id, onLog, onProgress) {
  let since = 0;
  for (;;) {
    const j = await api(`/api/job/${id}?since=${since}`);
    since = j.log_len;
    if (j.log?.length) onLog?.(j.log);
    onProgress?.(j);
    if (j.status === "done") return j.result;
    if (j.status === "error") throw new Error(j.error || "job failed");
    await new Promise((r) => setTimeout(r, 1000));
  }
}
function toast(msg, ms = 4000) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}

// ------------------------------------------------------------------------------------------------- panel: point info
async function selectPoint(lon, lat) {
  lon = wrap180(lon);
  S.pick = { lon, lat };
  clearMarkers("pick");
  addMarker("pick", lon, lat, "◆");
  $("infoSec").hidden = false;
  $("infoBody").innerHTML = `<div class="num">${lat.toFixed(5)}°, ${lon.toFixed(5)}° E</div><div class="hint">Reading the best elevation here…</div>`;
  try {
    const z = Math.max(6, Math.min(12, currentZoom() + 1));
    const p = await api(`/api/point?lon=${lon}&lat=${lat}&z=${z}`);
    if (S.pick?.lon !== lon) return;
    const src = (p.sources || []).filter((s) => (s.frac ?? 1) > 0.01).map((s) => esc(s.name || s)).join(", ") || "MOLA";
    const names = (p.names || []).map((n) => `${esc(n.name)} <small class="hint">${n.type ? esc(n.type) + " · " : ""}${fmtKm(n.dist_km ?? 0)}</small>`).join("<br>");
    $("infoBody").innerHTML = `<table>
      <tr><td>Position</td><td class="num">${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? "N" : "S"}, ${lon.toFixed(5)}° E</td></tr>
      <tr><td>Elevation</td><td class="num">${p.elev_m != null ? p.elev_m.toFixed(0) + " m" : "--"} <small class="hint">(above the MOLA areoid)</small></td></tr>
      <tr><td>Slope</td><td class="num">${p.slope_deg != null ? p.slope_deg.toFixed(1) + "°" : "--"} <small class="hint">over a ${p.baseline_m ? fmtKm(p.baseline_m / 1000) : "tile-cell"} baseline</small></td></tr>
      <tr><td>Data</td><td>${src}${p.finest_m ? ` <small class="hint">(finest ${fmtKm(p.finest_m / 1000)})</small>` : ""}</td></tr>
      ${names ? `<tr><td>Nearby</td><td>${names}</td></tr>` : ""}</table>`;
  } catch (e) {
    $("infoBody").innerHTML = `<div class="num">${lat.toFixed(5)}°, ${lon.toFixed(5)}° E</div><div class="warn">${esc(e.message)}</div>`;
  }
}
function currentZoom() {
  // the zoom whose tiles are about one screen across at the target
  const kmScreen = S.cam.range * 2 * Math.tan(camera.fov * DEG / 2);
  for (let z = 0; z <= MAXZ; z++) if (tileDeg(z) * DEG * R < kmScreen) return z;
  return MAXZ;
}

// ------------------------------------------------------------------------------------------------- route
function renderRoutePts() {
  const ol = $("routePts"); ol.innerHTML = "";
  clearMarkers("rp");
  S.route.forEach((p, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="num">${p[1].toFixed(3)}°, ${p[0].toFixed(3)}° E</span> ${p[2] ? `<small class="hint">${esc(p[2])}</small>` : ""}`;
    const del = document.createElement("button"); del.textContent = "×"; del.title = "Remove";
    del.onclick = () => { S.route.splice(i, 1); S.routeResult = null; renderRoutePts(); rebuildOverlays(); };
    li.appendChild(del); ol.appendChild(li);
    addMarker("rp", p[0], p[1], String(i + 1), () => flyTo(p[0], p[1], Math.min(S.cam.range, 300)));
  });
  $("btnRoute").disabled = S.route.length < 2;
}
$("btnAddRoute").onclick = () => {
  if (!S.pick) return;
  const near = markers.find((m) => m.kind === "name" && Math.abs(m.lon - S.pick.lon) < 0.05 && Math.abs(m.lat - S.pick.lat) < 0.05);
  S.route.push([S.pick.lon, S.pick.lat, near?.el.textContent || ""]);
  S.routeResult = null;
  renderRoutePts(); rebuildOverlays();
};
$("btnRouteClear").onclick = () => { S.route = []; S.routeResult = null; $("routeOut").innerHTML = ""; $("profile").hidden = true; renderRoutePts(); rebuildOverlays(); };
$("btnRoute").onclick = async () => {
  const btn = $("btnRoute"); btn.disabled = true;
  const out = $("routeOut");
  const total = S.route.slice(1).reduce((a, p, i) => a + haversineKm(S.route[i], p), 0);
  out.innerHTML = `<div class="hint">Solving ${fmtKm(total)} straight-line on the real terrain…</div><pre class="log" id="routeLog"></pre>`;
  try {
    const { job } = await post("/api/route", { points: S.route.map((p) => [p[0], p[1]]), mode: $("modeSel").value });
    const res = await pollJob(job, (lines) => { const l = $("routeLog"); if (l) { l.textContent += lines.map((x) => x[1]).join("\n") + "\n"; l.scrollTop = 1e9; } });
    S.routeResult = res;
    rebuildOverlays();
    const detour = res.straight_m ? res.distance_m / res.straight_m : 1;
    out.innerHTML = `<table>
      <tr><td>Traveller</td><td>${esc(res.mode_label)}</td></tr>
      <tr><td>Distance</td><td class="num">${fmtKm(res.distance_m / 1000)} <small class="hint">(${detour.toFixed(2)}× straight line)</small></td></tr>
      <tr><td>Climb / descent</td><td class="num">${(res.ascent_m).toFixed(0)} m / ${(res.descent_m).toFixed(0)} m</td></tr>
      <tr><td>Steepest</td><td class="num ${res.over_limit_m > 0 ? "bad-t" : ""}">${res.max_slope_deg.toFixed(1)}°${res.over_limit_m > 0 ? ` · ${fmtKm(res.over_limit_m / 1000)} over the limit` : ""}</td></tr>
      <tr><td>Driving time</td><td class="num">${res.drive_hours.toFixed(1)} h ≈ ${res.sols} sols</td></tr>
      <tr><td>Resolution</td><td>${res.legs.map((l) => l.levels.map((v) => `z${v.zoom}: ${fmtKm(v.cell_m / 1000)} (${v.sources.join(", ")})`).join(" → ")).join("<br>")}</td></tr>
      </table>
      ${res.legs.some((l) => l.relaxed) ? `<p class="warn">No path stays within the slope limit on at least one leg: the least-steep path is shown.</p>` : ""}
      <p class="hint">${esc(res.assumptions)}. ${esc(res.warning)}</p>`;
    drawProfile(res.points);
    const pts = res.points;
    let w = 180, e = -180, s = 90, n = -90;
    for (const p of pts) { w = Math.min(w, p[0]); e = Math.max(e, p[0]); s = Math.min(s, p[1]); n = Math.max(n, p[1]); }
    const span = Math.max((e - w) * Math.cos((s + n) / 2 * DEG), n - s) * DEG * R;
    flyTo((w + e) / 2, (s + n) / 2, Math.max(20, span * 1.4));
  } catch (e) {
    out.innerHTML = `<p class="warn">Route failed: ${esc(e.message)}</p>`;
  } finally { btn.disabled = S.route.length < 2; }
};
function drawProfile(points) {
  const cv = $("profile"); cv.hidden = false;
  const w = cv.width = cv.clientWidth * devicePixelRatio, h = cv.height = 150 * devicePixelRatio;
  const g = cv.getContext("2d");
  g.fillStyle = "#0b0f14"; g.fillRect(0, 0, w, h);
  const D = points[points.length - 1][3] || 1;
  let lo = Infinity, hi = -Infinity;
  for (const p of points) { lo = Math.min(lo, p[2]); hi = Math.max(hi, p[2]); }
  if (hi - lo < 10) { hi += 5; lo -= 5; }
  const pad = 26 * devicePixelRatio, X = (d) => pad + (w - pad - 8) * d / D, Y = (z) => h - pad + (pad * 1.4 - h) * (z - lo) / (hi - lo);
  g.strokeStyle = "#2a3646"; g.lineWidth = 1;
  g.beginPath(); g.moveTo(pad, 6); g.lineTo(pad, h - pad); g.lineTo(w - 4, h - pad); g.stroke();
  g.beginPath();
  points.forEach((p, i) => (i ? g.lineTo(X(p[3]), Y(p[2])) : g.moveTo(X(p[3]), Y(p[2]))));
  g.strokeStyle = "#ffffff"; g.lineWidth = 1.5 * devicePixelRatio; g.stroke();
  // steep sections
  const lim = { crewed_rover: 20, robotic_rover: 25, walk: 20 }[$("modeSel").value] || 20;
  g.strokeStyle = "#ff7470"; g.lineWidth = 3 * devicePixelRatio;
  for (let i = 1; i < points.length; i++) if (points[i][4] > lim) { g.beginPath(); g.moveTo(X(points[i - 1][3]), Y(points[i - 1][2])); g.lineTo(X(points[i][3]), Y(points[i][2])); g.stroke(); }
  g.fillStyle = "#b8c2ce"; g.font = `${11 * devicePixelRatio}px IBM Plex Mono, monospace`;
  g.fillText(`${hi.toFixed(0)} m`, 2, 14 * devicePixelRatio);
  g.fillText(`${lo.toFixed(0)} m`, 2, h - pad - 2);
  g.fillText(fmtKm(D / 1000), w - 70 * devicePixelRatio, h - 8);
}

// ------------------------------------------------------------------------------------------------- landing & hub
// The safety map (server: planet/safety.py) tints the imagery safe / caution / hazard / no-go for the chosen lander at
// the resolution of the data under it, so zooming in sharpens it. "Create a hub" turns it on; a click then screens that
// spot against NASA's engineering constraints and, when it is landable, builds an EVA site with the hub exactly there.
async function showLegend() {
  const box = $("legend");
  box.hidden = !$("safeChk").checked;
  if (box.hidden || box.dataset.done) return;
  try {
    const { legend } = await api("/api/safety/legend");
    box.innerHTML = legend.map((l) => `<div><i style="background:rgba(${l.rgba[0]},${l.rgba[1]},${l.rgba[2]},${Math.min(1, l.rgba[3] * 1.8)})${l.cls === 3 ? ";background-image:repeating-linear-gradient(45deg,#0005 0 3px,transparent 3px 6px)" : ""}"></i>${esc(l.label)}</div>`).join("")
      + `<div class="hint">Resolution follows your zoom: zoom in over HiRISE coverage (green boxes in "DTM footprints") for lander-scale (2–5 m) verification.</div>`;
    box.dataset.done = "1";
  } catch { box.textContent = "Legend unavailable (server)."; }
}
$("safeChk").onchange = () => { showLegend(); reloadTextures(); };
$("landerSel").onchange = () => { if ($("safeChk").checked) reloadTextures(); if (S.landing) runLanding(); };
S.hubMode = false;
$("btnHubMode").onclick = () => {
  S.hubMode = !S.hubMode;
  document.body.classList.toggle("hubmode", S.hubMode);
  $("btnHubMode").textContent = S.hubMode ? "Cancel hub placement" : "Create a hub…";
  if (S.hubMode) {
    if (!$("safeChk").checked) { $("safeChk").checked = true; showLegend(); reloadTextures(); }
    toast("Hub placement: zoom in and click a green (safe) area. The spot is screened for the chosen lander.", 6000);
    if (S.cam.range > 400 && S.pick) flyTo(S.pick.lon, S.pick.lat, 120);
  }
};
$("btnLandHere").onclick = () => { $("landSec").scrollIntoView({ behavior: "smooth", block: "nearest" }); runLanding(); };
$("btnLandRun").onclick = () => runLanding();
async function runLanding() {
  if (!S.pick) { toast("Click a point on the planet first."); return; }
  const out = $("landOut");
  const lander = $("landerSel").value, at = { ...S.pick };
  out.innerHTML = `<div class="hint">Screening against NASA's engineering constraints for this lander…</div>`;
  try {
    const L = await api(`/api/landing?lon=${at.lon}&lat=${at.lat}&lander=${lander}&az=${+$("landAz").value || 90}`);
    if (S.pick?.lon !== at.lon) return;
    S.landing = L; rebuildOverlays();
    const mark = (ok) => ok === true ? `<span class="ok-t">✔ pass</span>` : ok === false ? `<span class="bad-t">✖ fail</span>` : `<span class="na-t">– n/a</span>`;
    const fails = L.checks.filter((c) => c.ok === false).length;
    const sf = L.safety || {}, fr = sf.ellipse || {};
    const tc = sf.target_class;
    const landable = fails === 0 && tc === "safe";
    const cls = landable ? "ok" : tc === "hazard" || tc === "no-go" || fails ? "bad" : "warn";
    const verdict = landable
      ? `<b class="ok-t">Landable here</b> for ${esc(L.label)}${sf.verified ? " (verified at lander scale)" : ` (candidate: checked at ${fmtKm(sf.baseline_m / 1000)}; boulders and scarps smaller than that are not seen)`}.`
      : tc === "no-go" ? `<b class="bad-t">No-go</b>: outside this lander's envelope (elevation or latitude).`
      : tc === "hazard" ? `<b class="bad-t">Hazardous</b> right here (too steep or too rough).`
      : fails ? `<b class="bad-t">Fails ${fails} engineering constraint${fails > 1 ? "s" : ""}</b> (below).`
      : `<b class="warn">Caution</b>: close to the slope limit or rough.`;
    const pct = (v) => `${Math.round(100 * (v || 0))} %`;
    out.innerHTML = `<div class="verdict ${cls}">${verdict}</div>
      <table>
        <tr><td>Ellipse</td><td class="num">${fmtKm(L.majorM / 1000)} × ${fmtKm(L.minorM / 1000)} at ${L.azimuthDeg}°</td></tr>
        <tr><td>Inside it</td><td><span class="ok-t">${pct(fr.safe)} safe</span> · <span class="warn">${pct(fr.caution)} caution</span> · <span class="bad-t">${pct(fr.hazard)} hazard</span>${fr.nogo ? ` · ${pct(fr.nogo)} no-go` : ""}</td></tr>
        <tr><td>Slope limits</td><td class="num">hazard > ${sf.slope_hazard_deg}°, caution > ${sf.slope_caution_deg}° over ${fmtKm(sf.baseline_m / 1000)}</td></tr>
        ${L.checks.map((c) => `<tr><td>${mark(c.ok)}</td><td>${esc(c.label)}<br><small class="hint num">${esc(c.value)}</small></td></tr>`).join("")}
      </table>
      <p class="${L.hirise_dtms ? "ok-t" : "warn"}" style="margin:6px 0 2px">${L.hirise_dtms
        ? `Jezero-level fidelity: ${L.hirise_dtms} HiRISE 1 m elevation model(s) here. The EVA site gets measured metre-scale hazards (slope, steps, roughness, sand), 2 m detail imagery and a 20 m regional map.`
        : L.ctx_dtms
          ? `Reduced fidelity: 20 m CTX elevation here but no 1 m HiRISE model. Walking-scale hazards would be estimated (calibrated from Jezero), not measured. For Jezero-level data, place the hub inside a green HiRISE footprint (tick "HiRISE / CTX DTM footprints").`
          : `Low fidelity: only 200–463 m elevation exists here. Place the hub inside CTX (blue) or, better, HiRISE (green) footprints.`}</p>
      <div class="row wrap" id="hubBtns"></div>
      <p class="hint">Elevation at ${fmtKm(L.cell_m / 1000)} from ${esc(L.sources.join(", "))}. HiRISE DTMs touching the ellipse: ${L.hirise_dtms}; CTX DTMs: ${L.ctx_dtms}.</p>`;
    const btns = $("hubBtns");
    if (!landable && sf.nearest_safe && sf.nearest_safe.dist_m < 20000) {
      const b = document.createElement("button"); b.className = "btn";
      b.textContent = `Move to the nearest safe spot (${fmtKm(sf.nearest_safe.dist_m / 1000)} away)`;
      b.onclick = () => { selectPoint(sf.nearest_safe.lon, sf.nearest_safe.lat); flyTo(sf.nearest_safe.lon, sf.nearest_safe.lat, Math.min(S.cam.range, 30)); setTimeout(runLanding, 400); };
      btns.appendChild(b);
    }
    const hb = document.createElement("button"); hb.className = landable ? "btn accent" : "btn";
    hb.textContent = landable ? "Create hub + EVA site here" : "Create hub here anyway";
    hb.onclick = () => openSiteBuilder({ hub: [at.lon, at.lat], lander });
    btns.appendChild(hb);
    if (!S.hubMode || S.cam.range > 60) flyTo(at.lon, at.lat, Math.max(2, Math.min(S.cam.range, (L.majorM / 1000) * 2.5)));
  } catch (e) { out.innerHTML = `<p class="warn">${esc(e.message)}</p>`; }
}

// ------------------------------------------------------------------------------------------------- build a site
function openSiteBuilder({ hub = null, lander = null } = {}) {
  if (!S.pick) return;
  S.siteHub = hub;
  if (lander && [...$("siteLander").options].some((o) => o.value === lander)) $("siteLander").value = lander;
  $("siteSec").hidden = false; $("siteLog").hidden = true;
  const near = markers.find((m) => m.kind === "name" && Math.abs(m.lon - S.pick.lon) < 0.3 && Math.abs(m.lat - S.pick.lat) < 0.3);
  $("siteName").value = near ? `${near.el.textContent} site` : "";
  if (hub) $("siteName").value = $("siteName").value || "New hub";
  $("siteSec").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
$("btnSiteHere").onclick = () => openSiteBuilder({ hub: null });
$("btnSiteCancel").onclick = () => { $("siteSec").hidden = true; };
$("btnSiteGo").onclick = async () => {
  if (!S.pick) return;
  const btn = $("btnSiteGo"); btn.disabled = true;
  const log = $("siteLog"); log.hidden = false; log.textContent = "Starting…\n";
  try {
    const c = S.siteHub || [S.pick.lon, S.pick.lat];      // the site is centred on the hub
    const { job } = await post("/api/site", { lon: c[0], lat: c[1], km: +$("siteKm").value || 10, lander: $("siteLander").value, name: $("siteName").value || null, hub: S.siteHub });
    const res = await pollJob(job, (lines) => { log.textContent += lines.map((x) => x[1]).join("\n") + "\n"; log.scrollTop = 1e9; });
    log.textContent += `\nDone: ${res.name} (${res.dem_res_m} m elevation${res.hirise?.length ? `, ${res.hirise.length} HiRISE DTM(s)` : ""}).\n`;
    const a = document.createElement("a");
    a.className = "btn accent"; a.href = `index.html#${encodeURIComponent(res.id)}`; a.textContent = `Open ${res.name} in the EVA planner`;
    log.after(a);
    loadSites();
  } catch (e) { log.textContent += `\nFailed: ${e.message}\n`; }
  finally { btn.disabled = false; }
};

// ------------------------------------------------------------------------------------------------- search, names, sites
let searchT = 0;
$("searchIn").addEventListener("input", () => { clearTimeout(searchT); searchT = setTimeout(runSearch, 180); });
$("searchForm").addEventListener("submit", (e) => { e.preventDefault(); const b = $("searchRes").querySelector("button"); if (b) b.click(); else runSearch(); });
document.addEventListener("click", (e) => { if (!e.target.closest(".search")) $("searchRes").hidden = true; });
async function runSearch() {
  const q = $("searchIn").value.trim(), box = $("searchRes");
  if (q.length < 2) { box.hidden = true; return; }
  // "lat, lon" typed directly
  const m = q.match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
  if (m) { box.hidden = true; const lat = +m[1], lon = +m[2]; flyTo(lon, lat, 200); selectPoint(lon, lat); return; }
  try {
    const { results } = await api(`/api/search?q=${encodeURIComponent(q)}&limit=15`);
    box.innerHTML = "";
    if (!results.length) box.innerHTML = `<button disabled>No IAU name matches “${esc(q)}”</button>`;
    for (const r of results) {
      const b = document.createElement("button");
      b.innerHTML = `${esc(r.name)}<small>${esc(r.type || "")}${r.diameter_km ? ` · ${(+r.diameter_km).toFixed(0)} km` : ""} · ${(+r.lat).toFixed(2)}°, ${(+r.lon).toFixed(2)}° E</small>`;
      b.onclick = () => {
        box.hidden = true; $("searchIn").value = r.name;
        const d = +r.diameter_km || 30;
        flyTo(+r.lon, +r.lat, Math.max(5, Math.min(8000, d * 2.2)));
        clearMarkers("name");
        addMarker("name", +r.lon, +r.lat, r.name, () => selectPoint(+r.lon, +r.lat));
        setTimeout(() => selectPoint(+r.lon, +r.lat), 1900);
      };
      box.appendChild(b);
    }
    box.hidden = false;
  } catch (e) { box.innerHTML = `<button disabled>${esc(e.message)}</button>`; box.hidden = false; }
}
const FAMOUS = [["Olympus Mons", -133.8, 18.65], ["Valles Marineris", -59.2, -13.9], ["Hellas Planitia", 70.5, -42.4], ["Jezero", 77.58, 18.38],
  ["Gale", 137.85, -5.4], ["Elysium Mons", 146.9, 24.8], ["Arsia Mons", -120.46, -8.26], ["Utopia Planitia", 117.5, 49.7], ["Argyre Planitia", -43, -49.7],
  ["Planum Boreum", 0, 88], ["Planum Australe", 160, -84], ["Meridiani Planum", -3.7, -0.2], ["Isidis Planitia", 88, 13], ["Tharsis Montes", -113, 0]];
function loadNames() { for (const [n, lon, lat] of FAMOUS) addMarker("name", lon, lat, n, () => { flyTo(lon, lat, 900); selectPoint(lon, lat); }); }
async function loadSites() {
  clearMarkers("site");
  try {
    const { sites } = await api("/api/sites");
    S.sites = sites;
    for (const s of sites) {
      const c = s.center || (s.lon != null ? { lon: s.lon, lat: s.lat } : null);
      if (!c) continue;
      addMarker("site", c.lon, c.lat, `▲ ${s.short || s.name}`, () => { location.href = `index.html#${encodeURIComponent(s.id)}`; }, `Open ${s.name} in the EVA planner`);
    }
  } catch { /* no sites list */ }
}

// ------------------------------------------------------------------------------------------------- view settings
$("layerSel").onchange = () => { S.layer = $("layerSel").value; reloadTextures(); saveHash(); };
$("exag").oninput = () => {
  S.exag = +$("exag").value; $("exagV").textContent = S.exag;
  for (const t of tiles.values()) { t.radius = t.radius - 25 * (t.lastExag || 1) + 25 * S.exag; t.lastExag = S.exag; if (t.dem) buildMesh(t); }
  rebuildOverlays(); dirty = true;
};
$("covChk").onchange = () => { if ($("covChk").checked) loadCoverage(); else { S.coverage = null; rebuildOverlays(); } };
$("namesChk").onchange = $("sitesChk").onchange = () => { dirty = true; };
let covT = 0;
async function loadCoverage() {
  if (!$("covChk").checked) return;
  const c = S.cam, dLat = Math.min(60, c.range / R / DEG * 1.2), dLon = Math.min(180, dLat / Math.max(0.1, Math.cos(c.lat * DEG)));
  try {
    const cov = await api(`/api/coverage?w=${c.lon - dLon}&s=${Math.max(-90, c.lat - dLat)}&e=${c.lon + dLon}&n=${Math.min(90, c.lat + dLat)}`);
    S.coverage = cov; rebuildOverlays();
    toast(`${cov.hirise.length} HiRISE (green) and ${cov.ctx.length} CTX (blue) DTMs in view${cov.ctx.length >= 300 ? " (first 300 shown)" : ""}`, 3000);
  } catch (e) { toast(e.message); }
}

// ------------------------------------------------------------------------------------------------- offline download
$("btnPrecache").onclick = async () => {
  const c = S.cam, dLat = Math.min(10, c.range / R / DEG * 0.6), dLon = dLat / Math.max(0.1, Math.cos(c.lat * DEG));
  const out = $("preOut");
  out.innerHTML = `<div class="bar"><i id="preBar"></i></div><div class="hint" id="preTxt">Planning…</div>`;
  try {
    const { job } = await post("/api/precache", { w: c.lon - dLon, s: c.lat - dLat, e: c.lon + dLon, n: c.lat + dLat, zmax: +$("preZ").value, layers: [S.layer] });
    const res = await pollJob(job, (lines) => {
      const last = lines[lines.length - 1][1]; $("preTxt").textContent = last;
      const m = last.match(/(\d+)\/(\d+)/); if (m) $("preBar").style.width = `${100 * m[1] / m[2]}%`;
    });
    $("preBar").style.width = "100%";
    $("preTxt").textContent = `${res.tiles} tiles saved in ${res.seconds} s. This area now works offline.`;
  } catch (e) { out.innerHTML = `<p class="warn">${esc(e.message)}</p>`; }
};

// ------------------------------------------------------------------------------------------------- status
async function refreshStatus() {
  try {
    const s = await api("/api/planet/status");
    S.online = s.online;
    $("offline").hidden = true;
    const pill = $("netPill");
    pill.textContent = s.online ? "NASA / USGS · ONLINE" : "OFFLINE · cached data";
    pill.className = `pill ${s.online ? "ok" : "bad"}`;
    const gb = (b) => (b / 1e9).toFixed(b > 1e9 ? 1 : 2);
    $("cacheOut").textContent = `Cache: ${s.cache.tiles.toLocaleString()} tiles, ${gb(s.cache.bytes)} of ${gb(s.cache.limit)} GB.`;
    const cat = s.catalog || {};
    const warm = s.warmup && s.warmup.status === "running" ? ` Preparing: ${esc(s.warmup.log?.[s.warmup.log.length - 1]?.[1] || "")}` : "";
    $("srcOut").innerHTML = `
      <b>Elevation</b>: MOLA MEGDR 463 m–3.7 km global${s.megdr.global16 ? " ✔" : " (downloading)"}; HRSC-MOLA blend 200 m${s.blend.usable ? " ✔ streaming" : s.blend.usable === false ? " (not streamable: MOLA used)" : ""};
      CTX 20 m DTMs: ${cat.ctx?.count ?? "…"}; HiRISE 1 m DTMs: ${cat.hirise?.count ?? "…"} (USGS Astrogeology STAC, CC0).<br>
      <b>Imagery</b>: Viking MDIM 2.1 colour 232 m, MOLA colour shaded relief (NASA Mars Trek); CTX 5 m and HiRISE 25 cm orthoimages at close range.<br>
      <b>Names</b>: ${s.names.count.toLocaleString()} IAU/USGS Gazetteer features.${warm}`;
  } catch {
    $("offline").hidden = false;
    $("netPill").textContent = "SERVER NOT RUNNING"; $("netPill").className = "pill bad";
  }
}

// ------------------------------------------------------------------------------------------------- URL state
function saveHash() {
  const c = S.cam;
  history.replaceState(null, "", `#${c.lat.toFixed(4)},${c.lon.toFixed(4)},${c.range.toFixed(2)},${c.heading.toFixed(0)},${c.tilt.toFixed(0)},${S.layer}`);
}
function readHash() {
  const p = decodeURIComponent(location.hash.slice(1)).split(",");
  if (p.length >= 3 && p.slice(0, 3).every((v) => isFinite(+v))) {
    Object.assign(S.cam, { lat: +p[0], lon: +p[1], range: +p[2], heading: +p[3] || 0, tilt: +p[4] || 0 });
    if (["best", "viking", "mola"].includes(p[5])) { S.layer = p[5]; $("layerSel").value = p[5]; }
  }
}

// ------------------------------------------------------------------------------------------------- loop
let lastHash = 0, lastStat = { drawn: 0, wanted: 0 };
function frame(now) {
  requestAnimationFrame(frame);
  stepFlight(now);
  placeCamera();
  lastStat = selectTiles();
  if (Math.abs(Math.log(S.cam.range / (overlayRange || 1))) > 0.7) rebuildOverlays();
  updateMarkers();
  renderer.render(scene, camera);
  const c = S.cam;
  const alt = camera.position.length() - R;
  $("hudAlt").textContent = `alt ${fmtKm(alt)} · view ${fmtKm(c.range * 2 * Math.tan(camera.fov * DEG / 2))} · z${currentZoom()}`;
  $("hudLoad").textContent = loading || lastStat.wanted ? `streaming ${loading + queue.size} tiles` : `${loadedTotal} tiles`;
  if (dirty && now - lastHash > 500) { saveHash(); lastHash = now; dirty = false; clearTimeout(covT); covT = setTimeout(loadCoverage, 800); }
}

readHash();
resize();
loadNames();
loadSites();
refreshStatus();
setInterval(refreshStatus, 5000);
requestAnimationFrame(frame);
if (!location.hash) flyTo(77.5, 18.4, 9000, 10);
window.MMPlanet = { S, tiles, flyTo, selectPoint, elevAt };   // for debugging from the console
