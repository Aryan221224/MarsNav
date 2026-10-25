// landing.js - Landing mode: choose where the crew lands and sets up the hub, on the whole of Mars streamed like a flight
// simulator. The globe engine (tiles, LOD, camera, picking) is shared with the former Planet view; the panels screen every
// candidate against NASA's human landing-site criteria (planet/assess.py on the server) and commit the chosen hub as an
// EVA site.
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
  base: "best", exag: 1, crit: "hls2", focus: null, dossier: null, quick: null, cand: [], screen: new Map(), set: "all",
  iceTarget: null, datasets: {}, legendCache: new Map(),
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

// the imagery asked for: base layer + overlays composited on the server (planet/imagery.py)
function activeOverlays() {
  const out = [];
  for (const el of document.querySelectorAll("[data-ovl]")) {
    if (!el.checked) continue;
    const k = el.dataset.ovl;
    out.push(k === "safety" ? `safety_${$("landerSel").value}` : k === "ice" ? $("iceDepth").value : k);
  }
  return out;
}
function imgLayer() {
  const ov = activeOverlays();
  return `${S.base}${ov.length ? `&ovl=${ov.join(",")}` : ""}`;
}
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
  const showNames = $("namesChk").checked, showCand = $("ezChk").checked;
  const far = S.cam.range > 5000;
  for (const m of markers) {
    if ((m.kind === "name" && !showNames) || (["ez", "starship", "heritage", "hub"].includes(m.kind) && !showCand)
      || (far && m.kind === "heritage")) { m.el.style.display = "none"; continue; }
    const p = surf(m.lon, m.lat, 0);
    const ang = Math.acos(Math.max(-1, Math.min(1, camDir.dot(tmp.copy(p).normalize()))));
    if (ang > horizon + 0.005) { m.el.style.display = "none"; continue; }
    p.project(camera);
    if (p.z > 1 || p.x < -1.1 || p.x > 1.1 || p.y < -1.1 || p.y > 1.1) { m.el.style.display = "none"; continue; }
    m.el.style.display = "";
    m.x = (p.x + 1) / 2 * w;
    m.y = (1 - p.y) / 2 * h;
    m.el.style.left = `${m.x}px`;
    m.el.style.top = `${m.y}px`;
  }
  declutter(S.cam.range > 5200);
}

// a label that would overlap one already placed (higher priority first) keeps its dot but hides its text
const LABEL_PRI = { pick: 7, rp: 6, hub: 5, ice: 5, ez: 3, starship: 3, name: 2, heritage: 1 };
function declutter(far) {
  const vis = markers.filter((m) => m.el.style.display !== "none");
  const pri = (m) => (m.el.classList.contains("sel") ? 10 : 0) + (LABEL_PRI[m.kind] ?? 2);
  vis.sort((a, b) => pri(b) - pri(a));
  const placed = [];
  for (const m of vis) {
    const textShown = m.el.classList.contains("sel") || !(far && ["ez", "starship", "heritage", "hub"].includes(m.kind));
    if (!textShown) { m.el.classList.remove("nolbl"); continue; }
    const tw = m.el.textContent.length * 6.4 + 8;
    const box = [m.x - tw / 2, m.y - 27, tw, 17];
    const clash = placed.some((o) => box[0] < o[0] + o[2] && box[0] + box[2] > o[0] && box[1] < o[1] + o[3] && box[1] + box[3] > o[1]);
    m.el.classList.toggle("nolbl", clash);
    if (!clash) placed.push(box);
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
  if (S.focus && $("zoneChk").checked) {
    // the Exploration Zone (100 km, pressurised-rover range) and the 5 km infrastructure radius (NASA HLS2 2015)
    if (S.cam.range < 9000) overlay.add(lineFrom(circle(S.focus.lon, S.focus.lat, 100), 0xd8a57a, { depthTest: false, opacity: 0.85 }));
    if (S.cam.range < 400) overlay.add(lineFrom(circle(S.focus.lon, S.focus.lat, 5), 0xf2f5f8, { depthTest: false, opacity: 0.6 }));
  }
  if (S.local?.offline || !$("localModal")?.hidden) {
    // Local mode: the zones whose high-resolution data are on this computer (green rings)
    for (const z of S.local?.zones || []) if (S.cam.range < 20000) overlay.add(lineFrom(circle(z.lon, z.lat, z.radius_km || 25), 0x3ee07e, { depthTest: false, opacity: 0.9 }));
  }
  if (S.iceTarget && S.focus) {
    const n = 48, pts = [];
    for (let k = 0; k <= n; k++) pts.push([S.focus.lon + wrap180(S.iceTarget.lon - S.focus.lon) * k / n, S.focus.lat + (S.iceTarget.lat - S.focus.lat) * k / n, null]);
    overlay.add(lineFrom(pts, 0x7fc4ff, { depthTest: false, opacity: 0.95 }));
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

// geodesic circle of radius km around a point: [[lon, lat, null], ...]
function circle(lon, lat, km, n = 96) {
  const out = [], d = km / R, p1 = lat * DEG, l1 = lon * DEG;
  for (let k = 0; k <= n; k++) {
    const b = 2 * Math.PI * k / n;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    out.push([wrap180(l2 / DEG), p2 / DEG, null]);
  }
  return out;
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
    if (p) selectPoint(p.lon, p.lat);
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
  if (e.key === "Escape") { $("help").hidden = true; $("localModal").hidden = true; $("searchRes").hidden = true; if (document.activeElement?.blur) document.activeElement.blur(); return; }
  if (e.target.closest("input, select, textarea")) return;
  if (e.key === "/") { e.preventDefault(); $("searchIn").focus(); return; }
  if (e.key === "?") { $("help").hidden = false; return; }
  if (e.key === "a" || e.key === "A") { if (S.focus) assess(); return; }
  if (e.key === "l" || e.key === "L") { $("layers").classList.toggle("collapsed"); return; }
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

// ================================================================================================= Landing mode UI
const KIND = { ez: "NASA Exploration Zone proposal (2015)", starship: "SpaceX Starship candidate (2021)", heritage: "Landed spacecraft",
  hub: "Hub (built EVA site)", point: "Selected point" };
const TAG = { ez: "EZ", starship: "Starship", heritage: "Landed", hub: "Hub" };
const CRIT_SHORT = { lat: "Latitude", elev: "Elevation", landing: "Landing ellipse", slope: "km-scale slope", trn: "TRN map",
  verify: "1 m verification", dust: "Dust / bearing strength", ice: "Water", craters: "Craters" };
const GROUP_ORDER = ["Engineering", "Landing", "Resources", "Surface"];
const OVL_NEEDS = { ice: "swim", ti: "ti", grs: "grs", craters: "craters" };
const VERDICT_TEXT = { GO: "GO · suitable hub site", CAUTION: "CAUTION · usable with mitigations", "NO-GO": "NO-GO · outside the envelope" };
const fmtLL = (lat, lon, d = 3) => `${Math.abs(lat).toFixed(d)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(d)}°${lon >= 0 ? "E" : "W"}`;
const pct = (v) => `${Math.round(100 * (v || 0))} %`;
const statusOf = (ok) => ok === true ? "go" : ok === false ? "nogo" : "unknown";
const fmtN = (v, d = 0) => v == null || !isFinite(v) ? "–" : (+v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } } };

function currentZoom() {
  const kmScreen = S.cam.range * 2 * Math.tan(camera.fov * DEG / 2);
  for (let z = 0; z <= MAXZ; z++) if (tileDeg(z) * DEG * R < kmScreen) return z;
  return MAXZ;
}
function kmPerPx() { return S.cam.range * 2 * Math.tan(camera.fov * DEG / 2) / Math.max(1, canvas.clientHeight); }

// ------------------------------------------------------------------------------------------------- tabs, help, layers panel
function showTab(name) {
  for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === name));
  for (const p of document.querySelectorAll(".tabpane")) p.hidden = p.dataset.pane !== name;
}
for (const b of document.querySelectorAll(".tabs button")) b.onclick = () => showTab(b.dataset.tab);
$("btnHelp").onclick = () => { $("help").hidden = false; };
$("helpClose").onclick = () => { $("help").hidden = true; };
$("help").addEventListener("click", (e) => { if (e.target === $("help")) $("help").hidden = true; });
$("layersToggle").onclick = () => {
  const c = $("layers").classList.toggle("collapsed");
  $("layersToggle").setAttribute("aria-expanded", String(!c));
};

// ------------------------------------------------------------------------------------------------- map layers and legend
$("baseSel").onchange = () => { S.base = $("baseSel").value; reloadTextures(); saveHash(); };
for (const el of document.querySelectorAll("[data-ovl]")) {
  el.onchange = () => {
    const need = OVL_NEEDS[el.dataset.ovl];
    if (el.checked && need && S.datasets[need] && !S.datasets[need].installed) {
      toast(`${S.datasets[need].name} is not installed yet: see the Data tab (one download).`, 6000);
      showTab("data");
    }
    reloadTextures(); updateLegend(); saveHash();
  };
}
$("iceDepth").onchange = () => { if (document.querySelector('[data-ovl="ice"]').checked) { reloadTextures(); updateLegend(); saveHash(); } };
$("exag").oninput = () => {
  S.exag = +$("exag").value; $("exagV").textContent = S.exag;
  for (const t of tiles.values()) { t.radius = t.radius - 25 * (t.lastExag || 1) + 25 * S.exag; t.lastExag = S.exag; if (t.dem) buildMesh(t); }
  rebuildOverlays(); dirty = true;
};
$("covChk").onchange = () => { if ($("covChk").checked) loadCoverage(); else { S.coverage = null; rebuildOverlays(); } };
$("namesChk").onchange = $("ezChk").onchange = () => { dirty = true; };
$("zoneChk").onchange = () => rebuildOverlays();

let legendSeq = 0;
async function updateLegend() {
  // a legend can take a while to arrive when the server is busy with tiles: only the newest call may write the box,
  // so a slow answer for overlays that have since been switched off never replaces the current legend
  const seq = ++legendSeq;
  const box = $("legend"), parts = [];
  for (const o of activeOverlays()) {
    const key = o.startsWith("safety") ? "safety" : o;
    let L = S.legendCache.get(key);
    if (L === undefined) {
      try { L = (await api(`/api/legend?ovl=${encodeURIComponent(o)}`)).legend; } catch { L = null; }
      S.legendCache.set(key, L);
    }
    if (seq !== legendSeq) return;
    if (L) parts.push(legendHtml(key, L));
  }
  if (seq !== legendSeq) return;
  box.innerHTML = parts.join("");
  box.hidden = !parts.length;
}
function legendHtml(key, L) {
  const note = L.note ? `<p>${esc(L.note)}</p>` : "";
  if (L.classes) {
    return `<div class="lg"><b>${esc(L.title)} · ${esc($("landerSel").selectedOptions[0].text.split("·")[0].trim())}</b><div class="cls">${L.classes.map((c) =>
      `<i style="background:rgba(${c.rgba[0]},${c.rgba[1]},${c.rgba[2]},${Math.min(1, c.rgba[3] * 1.8)})"></i><span>${esc(c.label)}</span>`).join("")}</div>
      <p>Resolution follows your zoom; over HiRISE footprints it reaches lander scale (1–2 m).</p></div>`;
  }
  if (L.ticks?.length) {
    const n = L.ticks.length;
    const grad = L.ticks.map((t, i) => `rgba(${Math.round(t.rgba[0] * 255)},${Math.round(t.rgba[1] * 255)},${Math.round(t.rgba[2] * 255)},${Math.min(1, t.rgba[3] * 1.3 + 0.12).toFixed(2)}) ${(100 * i / (n - 1)).toFixed(0)}%`).join(",");
    return `<div class="lg"><b>${esc(L.title)}</b><div class="ramp" style="background:linear-gradient(90deg,${grad})"></div>
      <div class="ticks">${L.ticks.map((t) => `<span>${esc(t.label)}</span>`).join("")}</div>${note}</div>`;
  }
  return `<div class="lg"><b>${esc(L.title)}</b>${note}</div>`;
}

let covT = 0;
async function loadCoverage() {
  if (!$("covChk").checked) return;
  const c = S.cam, dLat = Math.min(60, c.range / R / DEG * 1.2), dLon = Math.min(180, dLat / Math.max(0.1, Math.cos(c.lat * DEG)));
  try {
    const cov = await api(`/api/coverage?w=${c.lon - dLon}&s=${Math.max(-90, c.lat - dLat)}&e=${c.lon + dLon}&n=${Math.min(90, c.lat + dLat)}`);
    S.coverage = cov; rebuildOverlays();
    toast(`${cov.hirise.length} HiRISE 1 m (green) and ${cov.ctx.length} CTX 20 m (blue) elevation models in view${cov.ctx.length >= 300 ? " (first 300 shown)" : ""}`, 3000);
  } catch (e) { toast(e.message); }
}

// ------------------------------------------------------------------------------------------------- mission settings
let reassessT = 0;
function missionChanged() {
  if (document.querySelector('[data-ovl="safety"]').checked) { reloadTextures(); S.legendCache.delete("safety"); updateLegend(); }
  const lv = $("landerSel").value;
  if ([...$("siteLander").options].some((o) => o.value === lv)) $("siteLander").value = lv;
  clearTimeout(reassessT);
  if (S.dossier) reassessT = setTimeout(assess, 350);
}
$("landerSel").onchange = missionChanged;
$("landAz").onchange = missionChanged;
for (const b of document.querySelectorAll(".seg button[data-crit]")) {
  b.onclick = () => {
    if (S.crit === b.dataset.crit) return;
    S.crit = b.dataset.crit;
    for (const x of document.querySelectorAll(".seg button[data-crit]")) x.setAttribute("aria-checked", String(x === b));
    S.screen.clear();
    renderCandList();
    screenAll(true);
    if (S.dossier) assess(); else if (S.focus) quickLook(selToken);
    saveHash();
  };
}

// ------------------------------------------------------------------------------------------------- candidates
async function loadCandidates() {
  try {
    const c = await api("/api/candidates");
    S.candSources = c.sources || {};
    const out = [];
    for (const e of c.ez || []) out.push({ ...e, kind: "ez", sub: `abstract ${e.abstract ?? ""}`, url: e.abstract_url, url2: e.slides_url });
    for (const e of c.starship || []) out.push({ ...e, kind: "starship", sub: e.tier ? `${e.tier} site` : "" });
    for (const e of c.heritage || []) out.push({ ...e, kind: "heritage", sub: [e.year, e.note].filter(Boolean).join(" · ") });
    S.cand = out;
    $("nEz").textContent = (c.ez || []).length; $("nSs").textContent = (c.starship || []).length; $("nHe").textContent = (c.heritage || []).length;
    for (const k of ["ez", "starship", "heritage"]) clearMarkers(k);
    for (const x of out) {
      const el = addMarker(x.kind, x.lon, x.lat, x.name, () => openCandidate(x), `${x.name} · ${KIND[x.kind]}`);
      el.dataset.cid = x.id;
    }
    renderCandList();
    restoreFocusFromHash();
    screenAll(true);
  } catch (e) {
    $("candList").innerHTML = `<li class="hint">Candidate list unavailable: ${esc(e.message)}</li>`;
  }
}
function visibleCands() {
  const q = $("candFilter").value.trim().toLowerCase();
  let list = S.cand.filter((c) => (S.set === "all" || c.kind === S.set)
    && (!q || c.name.toLowerCase().includes(q) || (c.proposer || "").toLowerCase().includes(q) || (c.sub || "").toLowerCase().includes(q)));
  const by = $("candSort").value;
  const sc = (c) => S.screen.get(c.id)?.score ?? -1;
  if (by === "score") list.sort((a, b) => sc(b) - sc(a) || a.name.localeCompare(b.name));
  else if (by === "name") list.sort((a, b) => a.name.localeCompare(b.name));
  else list.sort((a, b) => Math.abs(a.lat) - Math.abs(b.lat));
  return list;
}
function renderCandList() {
  const ol = $("candList"), list = visibleCands();
  ol.innerHTML = "";
  if (!S.cand.length) { ol.innerHTML = `<li class="hint">Loading candidate sites…</li>`; return; }
  if (!list.length) { ol.innerHTML = `<li class="hint">No candidate matches.</li>`; }
  const fid = S.focus?.cand?.id;
  for (const c of list) {
    const s = S.screen.get(c.id);
    const li = document.createElement("li");
    if (c.id === fid) li.className = "sel";
    const elev = s?.elev_m != null ? s.elev_m / 1000 : c.elev_km;
    li.innerHTML = `<span class="t">${esc(c.name)}${c.kind === "starship" && c.tier ? `<small>${esc(c.tier)}</small>` : c.kind === "heritage" && c.year ? `<small>${c.year}</small>` : ""}</span>
      <span class="m"><span class="tag ${c.kind}">${TAG[c.kind]}</span> ${fmtLL(c.lat, c.lon, 1)}${elev != null ? ` · ${elev.toFixed(1)} km` : ""}${c.proposer ? ` · ${esc(c.proposer)}` : ""}</span>
      <span class="b">${s ? `<span class="badge ${s.verdict}" title="Screen score (global data)">${s.score ?? "–"}</span><span class="dots">${s.rows.map((r) =>
        `<i class="${r.status}" title="${esc(CRIT_SHORT[r.id] || r.id)}: ${esc(r.value)}"></i>`).join("")}</span>` : ""}</span>`;
    li.onclick = () => openCandidate(c);
    ol.appendChild(li);
  }
  // candidate markers: dim the ones outside the chosen list, colour the dot by the screen verdict
  for (const m of markers) {
    if (!["ez", "starship", "heritage"].includes(m.kind)) continue;
    const id = m.el.dataset.cid, s = S.screen.get(id);
    m.el.classList.toggle("dim", S.set !== "all" && S.set !== m.kind);
    m.el.classList.toggle("sel", id === fid);
    m.el.classList.remove("v-GO", "v-CAUTION", "v-NO-GO");
    if (s?.verdict) m.el.classList.add(`v-${s.verdict}`);
  }
}
for (const b of document.querySelectorAll("#candChips .chip")) {
  b.onclick = () => {
    S.set = b.dataset.set;
    for (const x of document.querySelectorAll("#candChips .chip")) x.classList.toggle("on", x === b);
    renderCandList();
  };
}
$("candFilter").oninput = renderCandList;
$("candSort").onchange = renderCandList;
$("btnScreen").onclick = () => screenAll(false);

let screening = false;
async function screenAll(quiet) {
  if (screening || !S.cand.length) return;
  screening = true;
  const btn = $("btnScreen"); btn.disabled = true; btn.textContent = "Screening…";
  try {
    const { results } = await post("/api/screen", { points: S.cand.map((c) => [c.lon, c.lat, c.id]), crit: S.crit });
    for (const r of results) S.screen.set(r.id, r);
    const n = { GO: 0, CAUTION: 0, "NO-GO": 0 };
    for (const r of results) n[r.verdict] = (n[r.verdict] || 0) + 1;
    const unknown = Object.values(S.datasets).filter((d) => !d.installed).length;
    $("screenNote").innerHTML = `${results.length} candidates screened against <b>${esc(S.crit === "starship" ? "Starship 2021" : "NASA HLS 2015")}</b>:
      <span class="ok-t">${n.GO} go</span> · <span class="warn-t">${n.CAUTION} caution</span> · <span class="bad-t">${n["NO-GO"]} no-go</span>.
      Global data only (latitude, elevation, dust, water, craters); open one for the landing ellipse and the full dossier.${unknown ? ` <span class="warn-t">${unknown} science layer${unknown > 1 ? "s" : ""} not installed: fewer criteria.</span>` : ""}`;
    renderCandList();
    if (!quiet) toast(`Screened ${results.length} candidates.`);
  } catch (e) {
    if (!quiet) toast(`Screening failed: ${e.message}`);
  } finally { screening = false; btn.disabled = false; btn.textContent = "Screen all candidates"; }
}

function openCandidate(c, fly = true) {
  if (fly) flyTo(c.lon, c.lat, Math.min(Math.max(S.cam.range * 0.5, 450), 700));
  selectPoint(c.lon, c.lat, c);
}

// ------------------------------------------------------------------------------------------------- hubs (built sites)
async function loadHubs() {
  clearMarkers("hub");
  try {
    const { sites } = await api("/api/sites");
    S.sites = sites.filter((s) => s.center);
    const ol = $("hubList"); ol.innerHTML = "";
    if (!S.sites.length) ol.innerHTML = `<li class="hint">No hubs yet. Assess a site, then press “Set as hub…”.</li>`;
    for (const s of S.sites) {
      const c = s.center, cand = { id: `hub:${s.id}`, siteId: s.id, kind: "hub", name: s.name || s.id, lon: c.lon, lat: c.lat };
      addMarker("hub", c.lon, c.lat, `▲ ${s.short || s.name || s.id}`, () => openCandidate(cand), `Hub: ${s.name}`).dataset.cid = cand.id;
      const li = document.createElement("li");
      li.innerHTML = `<span class="t">▲ ${esc(s.name || s.id)}</span>
        <span class="m">${fmtLL(c.lat, c.lon, 3)}${s.dem_res_m ? ` · ${s.dem_res_m} m elevation` : ""}${s.lander ? ` · ${esc(s.lander)}` : ""}</span>
        <span class="b"><a class="btn small" href="index.html#${encodeURIComponent(s.id)}" title="Open in the EVA planner">Open</a></span>`;
      li.onclick = (e) => { if (!e.target.closest("a")) openCandidate(cand); };
      ol.appendChild(li);
    }
  } catch { /* no sites */ }
}

// ------------------------------------------------------------------------------------------------- selection and dossier
// narrow screens: the dossier overlays the globe; it opens on a selection and has a close button
{
  const x = document.createElement("button");
  x.className = "btn ghost icon dclose"; x.textContent = "×"; x.title = "Close the dossier"; x.setAttribute("aria-label", "Close the dossier");
  x.onclick = () => $("dossier").classList.add("closed");
  $("dossier").prepend(x);
  $("dossier").classList.add("closed");
}
let selToken = 0;
function selectPoint(lon, lat, cand = null) {
  $("dossier").classList.remove("closed");
  lon = wrap180(lon);
  const tok = ++selToken;
  S.focus = { lon, lat, cand, name: cand?.name || null };
  S.dossier = null; S.landing = null; S.iceTarget = null; S.quick = null;
  clearMarkers("pick"); clearMarkers("ice");
  if (!cand) addMarker("pick", lon, lat, "◆");
  $("dEmpty").hidden = true; $("dBody").hidden = false;
  $("dKind").textContent = cand ? KIND[cand.kind] : KIND.point;
  $("dName").textContent = cand?.name || "Unnamed site";
  $("dCoords").textContent = `${fmtLL(lat, lon, 4)}`;
  setGauge(null, null);
  setVerdict(null, "Reading the global data…");
  $("btnAssess").disabled = false; $("btnAssess").textContent = "Assess landing site";
  $("btnSafe").hidden = true;
  $("btnHub").disabled = true; $("btnHub").textContent = "Set as hub…";
  $("btnReport").disabled = true; $("btnJson").disabled = true;
  $("hubCard").hidden = true; $("siteDone").innerHTML = ""; $("siteLog").hidden = true;
  $("btnAddRoute").disabled = false;
  $("dSections").innerHTML = "";
  rebuildOverlays(); renderCandList(); saveHash();
  quickLook(tok);
}
async function quickLook(tok) {
  const f = S.focus; if (!f) return;
  const z = Math.max(6, Math.min(12, currentZoom() + 1));
  const [pt, sc] = await Promise.all([
    api(`/api/point?lon=${f.lon}&lat=${f.lat}&z=${z}`).catch((e) => ({ err: e.message })),
    post("/api/screen", { points: [[f.lon, f.lat, "pick"]], crit: S.crit }).then((r) => r.results[0]).catch(() => null),
  ]);
  if (tok !== selToken || S.dossier) return;
  S.quick = { pt, sc };
  if (!f.cand && pt.names?.length) { f.name = `Near ${pt.names[0].name}`; $("dName").textContent = f.name; }
  if (sc) {
    setGauge(sc.score, sc.verdict, true);
    setVerdict(sc.verdict, `Preliminary, from global data. Assess for the landing ellipse, surface, water and environment.`, true);
  } else setVerdict(null, "Global screen unavailable. Assess for the full dossier.");
  const rows = sc ? sc.rows.map((r) => `<div class="crit"><i class="${r.status}"></i><span class="l">${esc(CRIT_SHORT[r.id] || r.id)}</span><span class="v">${esc(r.value)}</span></div>`).join("") : "";
  const src = (pt.sources || []).filter((s) => (s.frac ?? 1) > 0.01).map((s) => esc(s.name || s)).join(", ") || "MOLA";
  $("dSections").innerHTML = candidateSection(f.cand) + `
    <section class="sect"><h3>Quick screen <small>${esc(S.crit === "starship" ? "Starship 2021" : "NASA HLS 2015")}</small></h3>${rows || `<p class="hint">No screen.</p>`}</section>
    <section class="sect"><h3>Here <small>best elevation at this zoom</small></h3>
      ${pt.err ? `<p class="warn-t">${esc(pt.err)}</p>` : `<div class="kv">
        <span>Elevation</span><span>${pt.elev_m != null ? `${fmtN(pt.elev_m)} m` : "–"}</span>
        <span>Local slope</span><span>${pt.slope_deg != null ? `${pt.slope_deg.toFixed(1)}° over ${fmtKm((pt.baseline_m || 0) / 1000)}` : "–"}</span>
        <span>Elevation data</span><span>${src}${pt.finest_m ? ` (finest ${fmtKm(pt.finest_m / 1000)})` : ""}</span>
        ${(pt.names || []).length ? `<span>Nearby</span><span>${pt.names.map((n) => `${esc(n.name)} <span class="na-t">${fmtKm(n.dist_km ?? 0)}</span>`).join("<br>")}</span>` : ""}
      </div>`}
    </section>`;
}
function candidateSection(c) {
  if (!c) return "";
  const rows = [];
  if (c.kind === "ez") {
    rows.push(["Proposed by", esc(c.proposer || "–")]);
    rows.push(["Workshop", "First Landing Site / Exploration Zone Workshop, NASA, Oct 2015"]);
    const links = [c.url && `<a href="${esc(c.url)}" target="_blank" rel="noopener">abstract (PDF)</a>`, c.url2 && `<a href="${esc(c.url2)}" target="_blank" rel="noopener">presentation</a>`].filter(Boolean);
    if (links.length) rows.push(["Documents", links.join(" · ")]);
  } else if (c.kind === "starship") {
    rows.push(["Study", "Golombek et al. 2021, LPSC 52 #2420"]);
    if (c.tier) rows.push(["Tier", esc(c.tier)]);
  } else if (c.kind === "heritage") {
    if (c.year) rows.push(["Landed", String(c.year)]);
    if (c.note) rows.push(["Note", esc(c.note)]);
  } else if (c.kind === "hub") {
    rows.push(["EVA site", `<a href="index.html#${encodeURIComponent(c.siteId)}">open in the EVA planner</a>`]);
  }
  if (c.elev_km != null) rows.push(["Listed elevation", `${c.elev_km.toFixed(2)} km`]);
  return `<section class="sect"><h3>${esc(TAG[c.kind] || "Site")} <small>${esc(KIND[c.kind])}</small></h3><div class="kv">${rows.map(([a, b]) => `<span>${a}</span><span>${b}</span>`).join("")}</div></section>`;
}

function setGauge(score, verdict, prelim = false) {
  const arc = $("gArc"), C = 113.1;
  arc.style.strokeDashoffset = score == null ? C : C * (1 - Math.max(0, Math.min(100, score)) / 100);
  arc.style.stroke = verdict === "GO" ? "var(--go)" : verdict === "CAUTION" ? "var(--caution)" : verdict === "NO-GO" ? "var(--nogo)" : "var(--unknown)";
  arc.style.opacity = prelim ? 0.55 : 1;
  $("dScore").textContent = score ?? "–";
  $("dGauge").title = score == null ? "Not scored" : `${prelim ? "Preliminary " : ""}score ${score} / 100`;
}
function setVerdict(v, small, prelim = false) {
  const el = $("dVerdict");
  el.className = `verdictbar ${v || ""}`;
  el.innerHTML = `${v ? `${prelim ? "Preliminary · " : ""}${esc(prelim ? v : VERDICT_TEXT[v] || v)}` : "Not assessed yet"}<small>${small}</small>`;
}

$("btnAssess").onclick = () => assess();
$("dCoords").onclick = async () => {
  if (!S.focus) return;
  const t = `${S.focus.lat.toFixed(5)}, ${S.focus.lon.toFixed(5)}`;
  try { await navigator.clipboard.writeText(t); toast(`Copied ${t} (lat, lon; east-positive)`); } catch { toast(t); }
};

async function assess() {
  const f = S.focus; if (!f) return;
  const tok = selToken;
  const lander = $("landerSel").value, az = ((+$("landAz").value || 0) % 360 + 360) % 360;
  $("dProgress").hidden = false; $("btnAssess").disabled = true;
  $("dProgress").querySelector("span").textContent = `Assessing for ${$("landerSel").selectedOptions[0].text.split("·")[0].trim()}: elevation mosaic over the landing ellipse, water ice, craters, dust…`;
  try {
    const d = await api(`/api/assess?lon=${f.lon}&lat=${f.lat}&lander=${lander}&az=${az}&crit=${S.crit}`);
    if (tok !== selToken) return;
    Object.assign(d, { lander, az, name: f.name, candidate: f.cand ? { id: f.cand.id, kind: f.cand.kind, name: f.cand.name } : null, generated: new Date().toISOString() });
    if (!f.cand && d.context?.names?.length && (!f.name || f.name === "Unnamed site")) { f.name = d.name = `Near ${d.context.names[0].name}`; $("dName").textContent = f.name; }
    S.dossier = d; S.landing = d.landing;
    S.iceTarget = d.ice?.found ? { lon: d.ice.lon, lat: d.ice.lat } : null;
    renderDossier(d);
    rebuildOverlays();
    const major = (d.landing?.majorM || 2000) / 1000;
    if (S.cam.range > major * 60 || S.cam.range < major * 1.2) flyTo(f.lon, f.lat, Math.max(3, major * 4));
  } catch (e) {
    if (tok !== selToken) return;
    setVerdict(null, `Assessment failed: ${esc(e.message)}. The server keeps working; try again, or zoom out and assess a nearby point.`);
  } finally {
    if (tok === selToken) { $("dProgress").hidden = true; $("btnAssess").disabled = false; $("btnAssess").textContent = "Re-assess"; }
  }
}

function critHtml(r) {
  return `<div class="crit"><i class="${r.status}" title="${r.status}"></i><span class="l">${esc(r.label)}</span>
    <span class="v">${esc(r.value)} <span class="na-t">· need ${esc(r.limit)}</span></span>
    <span class="s">${esc(r.source)}${r.note ? ` · ${esc(r.note)}` : ""}</span></div>`;
}
function meter(label, v) {
  if (v == null || !isFinite(v)) return `<div class="meter"><span>${label}</span><span class="tr"></span><span class="n na-t">–</span></div>`;
  const x = Math.max(-1, Math.min(1, v)), left = x >= 0 ? 50 : 50 + x * 50, w = Math.abs(x) * 50;
  const col = x >= 0.5 ? "var(--info)" : x >= 0 ? "#7fc4ff99" : "var(--nogo)";
  return `<div class="meter" title="SWIM ice consistency Ci: +1 every dataset agrees with ice, 0 ambiguous, -1 inconsistent. Tick: 0.5"><span>${label}</span><span class="tr"><i style="left:${left}%;width:${w}%;background:${col}"></i><b></b></span><span class="n">${x >= 0 ? "+" : ""}${x.toFixed(2)}</span></div>`;
}
function renderDossier(d) {
  setGauge(d.score, d.verdict);
  const c = d.counts || {};
  setVerdict(d.verdict, `${c.go || 0} go · ${c.caution || 0} caution · ${c.nogo || 0} no-go${c.unknown ? ` · ${c.unknown} unknown` : ""} — ${esc(d.criteria_label)}`);
  $("btnHub").disabled = false;
  $("btnHub").textContent = d.verdict === "NO-GO" ? "Set as hub anyway…" : "Set as hub…";
  $("btnReport").disabled = false; $("btnJson").disabled = false;
  const L = d.landing || {}, sf = L.safety || {}, fr = sf.ellipse || {}, ns = sf.nearest_safe;
  const moveSafe = sf.target_class && sf.target_class !== "safe" && ns && ns.dist_m > 5 && ns.dist_m < 20000;
  $("btnSafe").hidden = !moveSafe;
  if (moveSafe) $("btnSafe").textContent = `Move to nearest safe spot (${fmtKm(ns.dist_m / 1000)})`;

  const sect = [];
  // criteria
  const groups = {};
  for (const r of d.criteria || []) (groups[r.group] ||= []).push(r);
  sect.push(`<section class="sect"><h3>Criteria <small>${esc(d.criteria_label)}</small></h3>${GROUP_ORDER.concat(Object.keys(groups).filter((g) => !GROUP_ORDER.includes(g)))
    .filter((g) => groups[g]).map((g) => `<div class="lbl" style="margin-top:6px">${esc(g)}</div>${groups[g].map(critHtml).join("")}`).join("")}</section>`);
  sect.push(candidateSection(d.candidate && S.focus?.cand));

  // landing ellipse
  if (L.ok !== false && L.majorM) {
    const bar = `<div class="fracbar" title="Share of the landing ellipse by class"><i style="width:${100 * (fr.safe || 0)}%;background:var(--go)"></i><i style="width:${100 * (fr.caution || 0)}%;background:var(--caution)"></i><i style="width:${100 * (fr.hazard || 0)}%;background:var(--nogo)"></i><i style="width:${100 * (fr.nogo || 0)}%;background:#9664dc"></i></div>`;
    const fid = L.hirise_dtms ? `<p class="ok-t">Lander-scale data: ${L.hirise_dtms} HiRISE 1 m elevation model${L.hirise_dtms > 1 ? "s" : ""} over the ellipse. The hub's EVA site gets measured metre-scale hazards and 25 cm imagery.</p>`
      : L.ctx_dtms ? `<p class="warn-t">Reduced fidelity: 20 m CTX elevation here, no 1 m HiRISE model. Boulders and scarps under ~40 m are not seen; a crewed landing needs new HiRISE stereo first. Turn on “HiRISE / CTX elevation footprints” to find covered ground.</p>`
        : `<p class="bad-t">Low fidelity: only ${fmtKm((L.cell_m || 200) / 1000)} elevation exists here. Move into CTX (blue) or HiRISE (green) footprints before committing.</p>`;
    sect.push(`<section class="sect"><h3>Landing ellipse <small>${esc(L.label || "")}</small></h3>
      ${bar}<div class="hint"><span class="ok-t">${pct(fr.safe)} safe</span> · <span class="warn-t">${pct(fr.caution)} caution</span> · <span class="bad-t">${pct(fr.hazard)} hazard</span>${fr.nogo ? ` · ${pct(fr.nogo)} no-go` : ""}</div>
      <div class="kv" style="margin-top:8px">
        <span>Ellipse</span><span>${fmtKm(L.majorM / 1000)} × ${fmtKm(L.minorM / 1000)}, approach ${L.azimuthDeg}°</span>
        <span>Touchdown point</span><span class="${sf.target_class === "safe" ? "ok-t" : sf.target_class === "caution" ? "warn-t" : "bad-t"}">${esc(sf.target_class || "–")}${sf.verified ? " (verified at lander scale)" : " (candidate at this resolution)"}</span>
        <span>Slope limits</span><span>hazard &gt; ${sf.slope_hazard_deg ?? "–"}°, caution &gt; ${sf.slope_caution_deg ?? "–"}° over ${fmtKm((sf.baseline_m || 0) / 1000)}</span>
        <span>Elevation data</span><span>${fmtKm((L.cell_m || 0) / 1000)} · ${esc((L.sources || []).join(", "))}</span>
        <span>HiRISE / CTX DTMs</span><span>${L.hirise_dtms ?? 0} / ${L.ctx_dtms ?? 0} over the ellipse</span>
        ${ns && sf.target_class !== "safe" ? `<span>Nearest safe</span><span>${fmtKm(ns.dist_m / 1000)} away</span>` : ""}
      </div>
      <div style="margin-top:6px">${(L.checks || []).map((k) => `<div class="crit"><i class="${statusOf(k.ok)}"></i><span class="l">${esc(k.label)}</span><span class="v">${esc(k.value)}</span></div>`).join("")}</div>
      ${fid}
      <div class="row"><button class="btn small" id="btnShowSafety">${document.querySelector('[data-ovl="safety"]').checked ? "Safety map is on" : "Show the safety map"}</button><button class="btn small ghost" id="btnFitEllipse">Zoom to the ellipse</button></div>
    </section>`);
  }

  // water
  const ice = d.ice, di = d.data?.ice, grs = d.data?.grs_h2o_wt, sw = d.datasets?.swim;
  let water = "";
  if (di) water += `<div class="lbl">SWIM ice consistency here</div>${meter("0–1 m", di["0-1 m"])}${meter("1–5 m", di["1-5 m"])}${meter("&gt; 5 m", di[">5 m"])}`;
  if (ice?.outside) water += `<p class="hint">Poleward of 60° SWIM has no map; shallow ground ice is common there (Phoenix dug into it at 68°N).</p>`;
  else if (ice?.found) water += `<div class="kv" style="margin-top:6px"><span>Nearest ice (Ci ≥ 0.5)</span><span class="${ice.dist_km <= 5 ? "ok-t" : "warn-t"}">${fmtKm(ice.dist_km)} away, ${esc(ice.depth)}, Ci ${ice.ci >= 0 ? "+" : ""}${ice.ci.toFixed(2)}</span>
      <span>Ice-consistent ground</span><span>${pct(ice.share_within_km)} of the 100 km zone</span></div>
      <div class="row"><button class="btn small" id="btnIceShow">Show the ice target</button></div>`;
  else if (ice && !ice.found) water += `<p class="bad-t">No ice-consistent ground (Ci ≥ 0.5, 0–5 m) within 100 km${ice.best_ci != null ? `; best Ci ${ice.best_ci >= 0 ? "+" : ""}${ice.best_ci.toFixed(2)}` : ""}. Water would come from hydrated minerals or be shipped.</p>`;
  if (grs != null) water += `<div class="kv" style="margin-top:6px"><span>GRS hydrogen</span><span>${grs.toFixed(1)} wt% water-equivalent, top ~0.5 m (5° cell)</span></div>`;
  if (sw && !sw.installed) water += `<p class="warn-t">The SWIM ice layer is not installed: water is judged from the coarse GRS map. <button class="btn small" id="btnGoData">Data tab</button></p>`;
  water += `<p class="hint">NASA's HLS2 call asks for water ice (or hydrated minerals) yielding &gt; 100 t of water within the zone, ideally within 5 km of the landing site for ISRU plants.</p>`;
  sect.push(`<section class="sect"><h3>Water and resources <small>ISRU</small></h3>${water}</section>`);

  // surface
  const ti = d.data?.ti, g = d.geology, cr = d.craters, cz = d.craters_zone;
  const craterTxt = !cr ? `<span class="na-t">crater layer not installed</span>`
    : `${cr.inside ? `inside a ${cr.inside.diameter_km.toFixed(1)} km crater, ${fmtKm(cr.inside.rim_km)} from its rim${cr.inside.interior ? ` (${esc(cr.inside.interior)})` : ""}` : "not inside a ≥ 1 km crater"}
       ${cr.nearest_rim ? `<br>nearest rim: ${cr.nearest_rim.diameter_km.toFixed(1)} km crater, ${fmtKm(Math.max(0, cr.nearest_rim.rim_km))} away` : ""}`;
  sect.push(`<section class="sect"><h3>Surface <small>ground the lander and habitat sit on</small></h3><div class="kv">
    <span>Thermal inertia</span><span>${ti?.value != null ? `${fmtN(ti.value)} SI · ${esc(ti.class)}` : ti ? "no data" : `<span class="na-t">layer not installed</span>`}</span>
    <span>Geologic unit</span><span>${g?.unit ? `<b>${esc(g.unit)}</b> · ${esc(g.description || "")}` : g?.error ? `<span class="na-t">USGS map service not reachable</span>` : "–"}</span>
    <span>Craters here</span><span>${craterTxt}</span>
    ${cr ? `<span>Within 10 km</span><span>${cr.count} craters ≥ 1 km${cr.count_5km ? `, ${cr.count_5km} ≥ 5 km` : ""}</span>` : ""}
    ${cz ? `<span>Within 100 km</span><span>${cz.count} craters ≥ 1 km (${fmtN(cz.n1_per_1e6km2)} per 10⁶ km²)${cz.largest_km ? `, largest ${cz.largest_km.toFixed(0)} km` : ""}</span>` : ""}
  </div><p class="hint">Crater density is a proxy for surface age and for boulder fields around fresh craters; walls and fresh ejecta are the rockiest ground.</p></section>`);

  // environment
  const E = d.environment || {};
  sect.push(`<section class="sect"><h3>Environment <small>for the crew and power</small></h3><div class="kv">
    <span>Surface pressure</span><span>${fmtN(E.pressure_pa)} Pa (datum 610 Pa)</span>
    <span>Air overhead</span><span>${fmtN(E.column_g_cm2, 1)} g/cm² of shielding</span>
    <span>Sunlight, top of air</span><span>${fmtN(E.sun_toa?.mean_wm2)} W/m² mean (${fmtN(E.sun_toa?.min_wm2)}–${fmtN(E.sun_toa?.max_wm2)} over the year)</span>
    <span>Sunlight, at surface</span><span>≈ ${fmtN(E.sun_surface_mean_wm2)} W/m² mean, ${fmtN(E.sun_surface_min_wm2)} worst season</span>
    <span>Latitude</span><span>${Math.abs(d.target.lat).toFixed(2)}° ${d.target.lat >= 0 ? "N" : "S"}</span>
  </div><p class="hint">${esc(E.notes || "")}</p></section>`);

  // context
  const cx = d.context || {};
  const li = (arr, f) => (arr || []).map(f).join("");
  sect.push(`<section class="sect"><h3>Context <small>what else is near</small></h3>
    ${cx.ez?.length ? `<div class="lbl">NASA Exploration Zones</div><ol class="list">${li(cx.ez, (e) => `<li data-go="${e.lon},${e.lat},${esc(e.id)}"><span class="t">${esc(e.name)}<small>${esc(e.proposer || "")}</small></span><span class="m">${fmtKm(e.dist_km)} away${e.abstract_url ? ` · <a href="${esc(e.abstract_url)}" target="_blank" rel="noopener">abstract</a>` : ""}</span></li>`)}</ol>` : ""}
    ${cx.starship?.length ? `<div class="lbl">Starship candidate</div><ol class="list">${li(cx.starship, (e) => `<li data-go="${e.lon},${e.lat},${esc(e.id)}"><span class="t">${esc(e.name)}</span><span class="m">${fmtKm(e.dist_km)} away</span></li>`)}</ol>` : ""}
    ${cx.heritage?.length ? `<div class="lbl">Landed spacecraft</div><ol class="list">${li(cx.heritage, (e) => `<li data-go="${e.lon},${e.lat},${esc(e.id)}"><span class="t">${esc(e.name)}<small>${e.year || ""}</small></span><span class="m">${fmtKm(e.dist_km)} away</span></li>`)}</ol>` : ""}
    ${cx.names?.length ? `<div class="lbl">IAU names</div><div class="hint">${cx.names.map((n) => `${esc(n.name)} (${esc(n.type || "")}, ${fmtKm(n.dist_km)})`).join(" · ")}</div>` : ""}
  </section>`);

  // sources
  const ds = d.datasets || {};
  sect.push(`<section class="sect"><h3>Data sources</h3><ul class="srcs">
    <li>Elevation: MOLA MEGDR (Smith et al. 2001); HRSC-MOLA blend 200 m; CTX 20 m and HiRISE 1 m DTMs (USGS Astrogeology, CC0)${L.sources ? ` — used here: ${esc(L.sources.join(", "))}` : ""}</li>
    ${Object.values(ds).map((v) => `<li>${esc(v.name)}: ${esc(v.cite)}${v.installed ? "" : ` <span class="warn-t">(not installed)</span>`}</li>`).join("")}
    <li>Geology: Tanaka K.L. et al. 2014, Geologic map of Mars, USGS SIM 3292 (OGC API, astrogeology.usgs.gov)</li>
    <li>Candidates: NASA First Landing Site / Exploration Zone workshop (2015; EZ centres from the NASA Mars Trek EZMars service); Golombek M. et al. 2021, LPSC 52 #2420 (Starship); landed-spacecraft positions from NSSDCA / PDS</li>
    <li>Criteria: NASA Human Landing Sites call (2015) and HLS2 workshop; Starship study (Golombek et al. 2021). Environment: model values [ASSUME], see notes.</li>
  </ul></section>`);

  $("dSections").innerHTML = sect.join("");
  // wire the buttons made above
  $("btnShowSafety")?.addEventListener("click", () => {
    const cb = document.querySelector('[data-ovl="safety"]');
    if (!cb.checked) { cb.checked = true; reloadTextures(); updateLegend(); saveHash(); }
    $("btnShowSafety").textContent = "Safety map is on";
    flyTo(S.focus.lon, S.focus.lat, Math.max(2, (L.majorM || 2000) / 1000 * 3));
  });
  $("btnFitEllipse")?.addEventListener("click", () => flyTo(S.focus.lon, S.focus.lat, Math.max(1.5, (L.majorM || 2000) / 1000 * 2.2)));
  $("btnIceShow")?.addEventListener("click", showIceTarget);
  $("btnGoData")?.addEventListener("click", () => showTab("data"));
  for (const el of $("dSections").querySelectorAll("[data-go]")) {
    el.addEventListener("click", (ev) => {
      if (ev.target.closest("a")) return;
      const [lo, la, id] = el.dataset.go.split(",");
      const c = S.cand.find((x) => x.id === id);
      if (c) openCandidate(c); else { flyTo(+lo, +la, 500); selectPoint(+lo, +la); }
    });
  }
}
function showIceTarget() {
  const f = S.focus, t = S.iceTarget;
  if (!f || !t) return;
  clearMarkers("ice");
  addMarker("ice", t.lon, t.lat, "❄ ice", () => flyTo(t.lon, t.lat, Math.min(S.cam.range, 60)), "Nearest ground consistent with shallow water ice (SWIM Ci ≥ 0.5)");
  const cb = document.querySelector('[data-ovl="ice"]');
  if (!cb.checked && S.datasets.swim?.installed) { cb.checked = true; reloadTextures(); updateLegend(); }
  const km = haversineKm([f.lon, f.lat], [t.lon, t.lat]);
  flyTo((f.lon + f.lon + wrap180(t.lon - f.lon)) / 2, (f.lat + t.lat) / 2, Math.max(20, km * 2.6));
  rebuildOverlays();
}
$("btnSafe").onclick = () => {
  const ns = S.dossier?.landing?.safety?.nearest_safe; if (!ns) return;
  const cand = S.focus?.cand ? { ...S.focus.cand, name: `${S.focus.cand.name} (refined)` } : null;
  selectPoint(ns.lon, ns.lat, cand);
  flyTo(ns.lon, ns.lat, Math.min(S.cam.range, 30));
  setTimeout(assess, 200);
};

// ------------------------------------------------------------------------------------------------- commit the hub
$("btnHub").onclick = () => {
  const f = S.focus, d = S.dossier; if (!f || !d) return;
  const card = $("hubCard"); card.hidden = false;
  $("siteLog").hidden = true; $("siteDone").innerHTML = "";
  const base = (f.cand?.name || f.name || "New").replace(/^Near /, "").replace(/ \(refined\)$/, "");
  $("siteName").value = `${base} Base`;
  const lv = d.lander;
  $("siteLander").value = [...$("siteLander").options].some((o) => o.value === lv) ? lv : "human";
  let warn = $("hubWarn");
  if (!warn) { warn = document.createElement("p"); warn.id = "hubWarn"; card.querySelector("h3").after(warn); }
  warn.className = d.verdict === "GO" ? "ok-t" : d.verdict === "CAUTION" ? "warn-t" : "bad-t";
  warn.textContent = d.verdict === "GO" ? `Assessed GO (score ${d.score}) for ${d.criteria_label}.`
    : d.verdict === "CAUTION" ? `Assessed CAUTION (score ${d.score}): see the amber criteria before committing.`
      : `Assessed NO-GO for ${d.criteria_label}. Build it only for study; the crew should not land here.`;
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  $("siteName").focus();
};
$("btnSiteCancel").onclick = () => { $("hubCard").hidden = true; };
$("btnSiteGo").onclick = async () => {
  const f = S.focus; if (!f) return;
  const btn = $("btnSiteGo"); btn.disabled = true; btn.textContent = "Building…";
  const log = $("siteLog"); log.hidden = false; log.textContent = "Starting the hub build…\n";
  $("siteDone").innerHTML = "";
  try {
    const name = $("siteName").value.trim() || "New hub";
    const { job } = await post("/api/site", { lon: f.lon, lat: f.lat, km: +$("siteKm").value || 10, lander: $("siteLander").value, name, hub: [f.lon, f.lat] });
    const res = await pollJob(job, (lines) => { log.textContent += lines.map((x) => x[1]).join("\n") + "\n"; log.scrollTop = 1e9; });
    if (!res?.id) throw new Error("the build finished without a site id (see the log)");
    log.textContent += `\nDone: ${res.name} (${res.dem_res_m} m elevation${res.hirise?.length ? `, ${res.hirise.length} HiRISE DTM(s)` : ""}).\n`;
    $("siteDone").innerHTML = `<p class="ok-t">Hub “${esc(res.name)}” is built and saved.</p>
      <div class="row"><a class="btn accent grow" href="index.html#${encodeURIComponent(res.id)}">Open ${esc(res.name)} in the EVA planner</a></div>`;
    toast(`Hub ${res.name} built.`);
    loadHubs();
  } catch (e) {
    log.textContent += `\nFailed: ${e.message}\n`;
    $("siteDone").innerHTML = `<p class="bad-t">The build failed: ${esc(e.message)}. Nothing was changed; you can try again.</p>`;
  } finally { btn.disabled = false; btn.textContent = "Build hub site"; }
};

// ------------------------------------------------------------------------------------------------- report and JSON
function snapshot() {
  try { renderer.render(scene, camera); return canvas.toDataURL("image/jpeg", 0.85); } catch { return null; }
}
$("btnJson").onclick = () => {
  const d = S.dossier; if (!d) return;
  const out = { app: "MarsNav · Landing mode", ...d };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }));
  a.download = `hub-dossier-${(d.name || "site").replace(/[^\w-]+/g, "_")}-${d.generated.slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
$("btnReport").onclick = () => {
  const d = S.dossier; if (!d) return;
  const img = snapshot();
  const secs = $("dSections").cloneNode(true);
  for (const b of secs.querySelectorAll("button")) b.remove();
  const css = `body{font:13px/1.45 Barlow,Segoe UI,Arial,sans-serif;color:#111;margin:28px;max-width:900px}h1{font-size:22px;margin:0}h3{font-size:14px;text-transform:uppercase;letter-spacing:.06em;border-bottom:2px solid #222;padding-bottom:2px;margin:18px 0 6px;display:flex;justify-content:space-between}h3 small{font-weight:400;text-transform:none;color:#555}
    .v{font-weight:700;font-size:18px;padding:6px 10px;border:2px solid;display:inline-block;margin:8px 0}.GO{color:#0a7a3a}.CAUTION{color:#9a6b00}.NO-GO{color:#b3261e}
    .crit{display:grid;grid-template-columns:14px 1fr;gap:0 8px;padding:4px 0;border-bottom:1px solid #ddd}.crit>i{width:10px;height:10px;border-radius:50%;margin-top:4px;background:#999}.crit>i.go{background:#1a9e55}.crit>i.caution{background:#e0a100}.crit>i.nogo{background:#d33}
    .crit .l{font-weight:600}.crit .v,.crit .s{grid-column:2;font-weight:400;font-size:12px;border:0;padding:0;margin:0;display:block}.s{color:#555}.kv{display:grid;grid-template-columns:170px 1fr;gap:3px 10px}.kv>span:nth-child(odd){color:#555}
    .fracbar{display:flex;height:10px;margin:4px 0}.fracbar i{display:block}.meter{display:grid;grid-template-columns:60px 1fr 50px;gap:8px;align-items:center}.meter .tr{height:8px;background:#ddd;position:relative}.meter .tr i{position:absolute;top:0;bottom:0}
    .list{list-style:none;padding:0;margin:0}.tag,.badge{font-size:11px}.hint,.na-t{color:#666}.ok-t{color:#0a7a3a}.warn-t{color:#9a6b00}.bad-t{color:#b3261e}.lbl{font-weight:700;font-size:11px;text-transform:uppercase;color:#444;margin-top:6px}
    img{width:100%;border:1px solid #999;margin:10px 0}.bar{display:flex;gap:10px;align-items:center}@media print{.noprint{display:none}body{margin:12mm}}`;
  const verdictClass = d.verdict || "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Hub site dossier · ${esc(d.name || "")}</title><style>${css}</style></head><body>
    <div class="bar noprint"><button onclick="print()">Print / save as PDF</button></div>
    <h1>Hub site dossier: ${esc(d.name || "Selected site")}</h1>
    <div>${fmtLL(d.target.lat, d.target.lon, 4)} · lat ${d.target.lat.toFixed(5)}, lon ${d.target.lon.toFixed(5)} (east-positive, IAU 2015 sphere)</div>
    <div>Lander: ${esc(d.landing?.label || d.lander)} · approach ${d.az}° · criteria: ${esc(d.criteria_label)}</div>
    <div class="v ${verdictClass}">${esc(VERDICT_TEXT[d.verdict] || d.verdict)} · score ${d.score ?? "–"} / 100</div>
    ${img ? `<img src="${img}" alt="Globe view of the site">` : ""}
    ${secs.innerHTML}
    <p class="hint">Generated ${new Date(d.generated).toLocaleString()} by MarsNav (NASA Space Apps 2026). A first screen from orbital data: a crewed site still needs HiRISE imaging and 1 m elevation over the whole landing ellipse, and the project's own engineering review, before commitment.</p>
  </body></html>`;
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const w = window.open(url, "_blank");
  if (!w) { const a = document.createElement("a"); a.href = url; a.download = `hub-dossier-${(d.name || "site").replace(/[^\w-]+/g, "_")}.html`; a.click(); }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
};

// ------------------------------------------------------------------------------------------------- traverse
function renderRoutePts() {
  const ol = $("routePts"); ol.innerHTML = "";
  clearMarkers("rp");
  S.route.forEach((p, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="num">${fmtLL(p[1], p[0], 3)}</span> ${p[2] ? `<small class="hint">${esc(p[2])}</small>` : ""}`;
    const del = document.createElement("button"); del.textContent = "×"; del.title = "Remove"; del.className = "btn small ghost";
    del.onclick = () => { S.route.splice(i, 1); S.routeResult = null; renderRoutePts(); rebuildOverlays(); };
    li.appendChild(del); ol.appendChild(li);
    addMarker("rp", p[0], p[1], String(i + 1), () => flyTo(p[0], p[1], Math.min(S.cam.range, 300)));
  });
  $("btnRoute").disabled = S.route.length < 2;
}
$("btnAddRoute").onclick = () => {
  const f = S.focus; if (!f) return;
  S.route.push([f.lon, f.lat, f.cand?.name || f.name || ""]);
  S.routeResult = null;
  renderRoutePts(); rebuildOverlays();
  showTab("trav");
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
    if (!res?.points) throw new Error("the route job finished without a path (see the log)");
    S.routeResult = res;
    rebuildOverlays();
    const detour = res.straight_m ? res.distance_m / res.straight_m : 1;
    out.innerHTML = `<table>
      <tr><td>Traveller</td><td>${esc(res.mode_label)}</td></tr>
      <tr><td>Distance</td><td class="num">${fmtKm(res.distance_m / 1000)} <small class="hint">(${detour.toFixed(2)}× straight line)</small></td></tr>
      <tr><td>Climb / descent</td><td class="num">${res.ascent_m.toFixed(0)} m / ${res.descent_m.toFixed(0)} m</td></tr>
      <tr><td>Steepest</td><td class="num ${res.over_limit_m > 0 ? "bad-t" : ""}">${res.max_slope_deg.toFixed(1)}°${res.over_limit_m > 0 ? ` · ${fmtKm(res.over_limit_m / 1000)} over the limit` : ""}</td></tr>
      <tr><td>Driving time</td><td class="num">${res.drive_hours.toFixed(1)} h ≈ ${res.sols} sols</td></tr>
      <tr><td>Resolution</td><td>${res.legs.map((l) => l.levels.map((v) => `z${v.zoom}: ${fmtKm(v.cell_m / 1000)} (${v.sources.join(", ")})`).join(" → ")).join("<br>")}</td></tr>
      </table>
      ${res.legs.some((l) => l.relaxed) ? `<p class="warn-t">No path stays within the slope limit on at least one leg: the least-steep path is shown.</p>` : ""}
      <p class="hint">${esc(res.assumptions)}. ${esc(res.warning)}</p>`;
    drawProfile(res.points);
    let w = 180, e = -180, s = 90, n = -90;
    for (const p of res.points) { w = Math.min(w, p[0]); e = Math.max(e, p[0]); s = Math.min(s, p[1]); n = Math.max(n, p[1]); }
    const span = Math.max((e - w) * Math.cos((s + n) / 2 * DEG), n - s) * DEG * R;
    flyTo((w + e) / 2, (s + n) / 2, Math.max(20, span * 1.4));
  } catch (e) {
    out.innerHTML = `<p class="bad-t">Traverse failed: ${esc(e.message)}</p>`;
  } finally { btn.disabled = S.route.length < 2; }
};
function drawProfile(points) {
  const cv = $("profile"); cv.hidden = false;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.width = Math.max(200, cv.clientWidth) * dpr, h = cv.height = 150 * dpr;
  const g = cv.getContext("2d");
  g.fillStyle = "#0b0f14"; g.fillRect(0, 0, w, h);
  const D = points[points.length - 1][3] || 1;
  let lo = Infinity, hi = -Infinity;
  for (const p of points) { lo = Math.min(lo, p[2]); hi = Math.max(hi, p[2]); }
  if (hi - lo < 10) { hi += 5; lo -= 5; }
  const pad = 26 * dpr, X = (d) => pad + (w - pad - 8) * d / D, Y = (z) => h - pad + (pad * 1.4 - h) * (z - lo) / (hi - lo);
  g.strokeStyle = "#2a3646"; g.lineWidth = 1;
  g.beginPath(); g.moveTo(pad, 6); g.lineTo(pad, h - pad); g.lineTo(w - 4, h - pad); g.stroke();
  g.beginPath();
  points.forEach((p, i) => (i ? g.lineTo(X(p[3]), Y(p[2])) : g.moveTo(X(p[3]), Y(p[2]))));
  g.strokeStyle = "#ffffff"; g.lineWidth = 1.5 * dpr; g.stroke();
  const lim = { crewed_rover: 20, robotic_rover: 25, walk: 20 }[$("modeSel").value] || 20;
  g.strokeStyle = "#ff7470"; g.lineWidth = 3 * dpr;
  for (let i = 1; i < points.length; i++) if (points[i][4] > lim) { g.beginPath(); g.moveTo(X(points[i - 1][3]), Y(points[i - 1][2])); g.lineTo(X(points[i][3]), Y(points[i][2])); g.stroke(); }
  g.fillStyle = "#b8c2ce"; g.font = `${11 * dpr}px IBM Plex Mono, monospace`;
  g.fillText(`${hi.toFixed(0)} m`, 2, 14 * dpr);
  g.fillText(`${lo.toFixed(0)} m`, 2, h - pad - 2);
  g.fillText(fmtKm(D / 1000), w - 70 * dpr, h - 8);
}

// ------------------------------------------------------------------------------------------------- data tab: science layers, offline
S.dsFailed = {};
let dsJobRunning = false;
async function loadDatasets() {
  try {
    const { datasets } = await api("/api/datasets");
    S.datasets = datasets;
  } catch { return; }
  const ids = Object.keys(S.datasets), missing = ids.filter((k) => !S.datasets[k].installed);
  $("dsList").innerHTML = ids.map((k) => {
    const v = S.datasets[k];
    return `<div class="ds"><div class="h"><span>${esc(v.name)}</span>${v.installed ? `<span class="ok-t">✔ installed</span>` : `<span class="na-t">${v.size_mb} MB</span>`}</div>
      <p>${esc(v.what)}</p><p>${esc(v.res)} · ${esc(v.cite)}</p>
      ${S.dsFailed[k] ? `<p class="bad-t">Last attempt: ${esc(S.dsFailed[k])}</p>` : ""}</div>`;
  }).join("");
  const mb = missing.reduce((a, k) => a + (S.datasets[k].size_mb || 0), 0);
  const btn = $("btnInstall");
  btn.hidden = !missing.length || dsJobRunning;
  btn.textContent = missing.length === ids.length ? `Install science layers (${Math.round(mb)} MB, once)` : `Install the missing layer${missing.length > 1 ? "s" : ""} (${Math.round(mb)} MB)`;
  const pill = $("dsPill");
  pill.textContent = `SCIENCE ${ids.length - missing.length}/${ids.length}`;
  pill.className = `pill ${missing.length ? "warn" : "ok"}`;
  pill.title = missing.length ? `Not installed: ${missing.map((k) => S.datasets[k].name).join(", ")}` : "Water ice, thermal inertia, GRS water and craters are installed";
  pill.style.cursor = "pointer";
  pill.onclick = () => showTab("data");
  updateBanner();
}
function updateBanner() {
  const b = $("banner");
  const ids = Object.keys(S.datasets), missing = ids.filter((k) => !S.datasets[k].installed);
  if (dsJobRunning) {
    b.hidden = false;
    b.innerHTML = `<span class="grow"><b>Installing science layers</b> · <span id="bnTxt">${esc($("dsTxt")?.textContent || "starting")}</span></span><button class="btn small ghost" id="bnData">Details</button>`;
  } else if (missing.length && !S.bannerClosed && !S.local?.offline) {
    const mb = Math.round(missing.reduce((a, k) => a + (S.datasets[k].size_mb || 0), 0));
    b.hidden = false;
    b.innerHTML = `<span class="grow"><b>${missing.length === ids.length ? "Science layers are not installed." : `${missing.map((k) => esc(S.datasets[k].name.split(" ")[0])).join(", ")} not installed.`}</b>
      Water ice, dust and crater criteria need them (${mb} MB, downloaded once from NASA / PSI / USGS).</span>
      <button class="btn small accent" id="bnInstall">Install</button><button class="btn small ghost" id="bnLater">Later</button>`;
  } else { b.hidden = true; return; }
  $("bnInstall")?.addEventListener("click", () => installDatasets());
  $("bnLater")?.addEventListener("click", () => { S.bannerClosed = true; b.hidden = true; });
  $("bnData")?.addEventListener("click", () => showTab("data"));
}
$("btnInstall").onclick = () => installDatasets();
async function installDatasets() {
  const missing = Object.keys(S.datasets).filter((k) => !S.datasets[k].installed);
  if (!missing.length || dsJobRunning) return;
  try {
    const { job } = await post("/api/datasets/install", { ids: missing });
    store.set("mm.dsJob", job);
    followDsJob(job);
  } catch (e) { toast(`Could not start the install: ${e.message}`); }
}
async function followDsJob(job) {
  if (dsJobRunning) return;
  dsJobRunning = true;
  $("btnInstall").hidden = true;
  const box = $("dsJob");
  box.innerHTML = `<div class="bar"><i id="dsBar"></i></div><div class="hint" id="dsTxt">Starting…</div><pre class="log" id="dsLog"></pre>`;
  updateBanner();
  const nIds = Math.max(1, Object.keys(S.datasets).filter((k) => !S.datasets[k].installed).length);
  let doneLayers = 0;
  try {
    const res = await pollJob(job, (lines) => {
      const lg = $("dsLog"); if (!lg) return;
      for (const [, t] of lines) {
        lg.textContent += t + "\n";
        if (/: ready \(|: already installed|NOT INSTALLED/.test(t)) doneLayers++;
        const m = t.match(/(\d+) of (\d+) MB/);
        const frac = (doneLayers + (m ? +m[1] / Math.max(1, +m[2]) : 0)) / nIds;
        $("dsBar").style.width = `${Math.min(100, 100 * frac)}%`;
        $("dsTxt").textContent = t.trim();
        const bt = $("bnTxt"); if (bt) bt.textContent = t.trim();
      }
      lg.scrollTop = 1e9;
    });
    S.dsFailed = res?.failed || {};
    $("dsBar").style.width = "100%";
    const nf = Object.keys(S.dsFailed).length;
    $("dsTxt").innerHTML = nf ? `<span class="warn-t">${(res.installed || []).length} layer(s) installed; ${nf} could not be downloaded now (see below). Try again later.</span>` : `<span class="ok-t">All science layers are installed.</span>`;
    toast(nf ? `Science layers: ${nf} not installed (server not answering). The rest work now.` : "Science layers installed.", 6000);
  } catch (e) {
    $("dsTxt").innerHTML = `<span class="bad-t">Install failed: ${esc(e.message)}</span>`;
  } finally {
    dsJobRunning = false; store.set("mm.dsJob", null);
    S.legendCache.clear();
    await loadDatasets();
    reloadTextures(); updateLegend();
    S.screen.clear(); screenAll(true);
    if (S.dossier) assess();
  }
}

$("btnPrecache").onclick = async () => {
  const c = S.cam, dLat = Math.min(10, c.range / R / DEG * 0.6), dLon = dLat / Math.max(0.1, Math.cos(c.lat * DEG));
  const out = $("preOut"), btn = $("btnPrecache");
  btn.disabled = true;
  out.innerHTML = `<div class="bar"><i id="preBar"></i></div><div class="hint" id="preTxt">Planning…</div>`;
  try {
    const { job } = await post("/api/precache", { w: c.lon - dLon, s: c.lat - dLat, e: c.lon + dLon, n: c.lat + dLat, zmax: +$("preZ").value, layers: [S.base] });
    const res = await pollJob(job, (lines) => {
      const last = lines[lines.length - 1][1]; $("preTxt").textContent = last;
      const m = last.match(/(\d+)\/(\d+)/); if (m) $("preBar").style.width = `${100 * m[1] / m[2]}%`;
    });
    $("preBar").style.width = "100%";
    $("preTxt").textContent = res ? `${res.tiles} tiles saved in ${res.seconds} s. This area now works offline.` : "Done.";
  } catch (e) { out.innerHTML = `<p class="bad-t">${esc(e.message)}</p>`; }
  finally { btn.disabled = false; }
};


// ------------------------------------------------------------------------------------------------- Local mode (Mars, no internet)
// Every dataset on this computer at native resolution (planet/localmode.py), then Mars mode: the server sends nothing to
// the internet and serves everything from the local copies. The panel shows sizes, progress and the refused requests.
const GB = (b) => b == null ? "–" : b >= 1e9 ? `${(b / 1e9).toFixed(b >= 1e10 ? 0 : 1)} GB` : `${Math.max(0.1, b / 1e6).toFixed(b >= 1e8 ? 0 : 1)} MB`;
const LOCAL_KEY = "mm.localPlan";
S.localPlan = (() => {
  try { const j = JSON.parse(store.get(LOCAL_KEY) || "null"); if (j && Array.isArray(j.global)) return j; } catch { /* default */ }
  return { global: null, zones: [], parts: null };
})();
S.local = null;
function saveLocalPlan() { store.set(LOCAL_KEY, JSON.stringify(S.localPlan)); }
function localPlanForServer() {
  return { global: S.localPlan.global || [], zones: S.localPlan.zones.map((z) => ({ ...z, parts: S.localPlan.parts })) };
}
async function loadLocal() {
  try { S.local = await api("/api/local/status"); } catch { return; }
  const L = S.local;
  if (!S.localPlan.global) S.localPlan.global = Object.entries(L.global_packs).filter(([, v]) => v.default).map(([k]) => k);
  if (!S.localPlan.parts) S.localPlan.parts = Object.keys(L.zone_parts);
  if (!S.localPlan.zones.length && S.sites.length) S.localPlan.zones = S.sites.slice(0, 1).map((s) => ({ id: s.id, name: s.short || s.name, lon: s.center.lon, lat: s.center.lat, radius_km: 25 }));
  renderLocalPill();
  if (!$("localModal").hidden) renderLocal();
  const running = L.progress?.running;
  clearTimeout(loadLocal._t);
  loadLocal._t = setTimeout(loadLocal, running || !$("localModal").hidden ? 2000 : 15000);
}
function renderLocalPill() {
  const L = S.local; if (!L) return;
  const pill = $("localPill");
  document.body.classList.toggle("mars", !!L.offline);
  pill.classList.toggle("on", !!L.offline);
  pill.classList.toggle("have", !L.offline && L.bytes > 1e9);
  pill.textContent = L.offline ? "MARS MODE · LOCAL DATA ONLY" : L.progress?.running ? `LOCAL · ${Math.round(100 * (L.progress.done_bytes / Math.max(1, L.progress.total_bytes)))} %` : `LOCAL MODE${L.bytes > 1e8 ? ` · ${GB(L.bytes)}` : ""}`;
  if (L.offline) {
    const np = $("netPill"); np.textContent = "EARTH LINK OFF"; np.className = "pill warn";
    np.title = "Mars mode: nothing is sent to the internet; everything comes from this computer";
    $("banner").hidden = true;
  }
  rebuildOverlays();
}
function openLocal() { $("localModal").hidden = false; renderLocal(); loadLocal(); }
$("localPill").onclick = openLocal;
$("btnOpenLocal").onclick = openLocal;
$("localClose").onclick = () => { $("localModal").hidden = true; };
$("localModal").addEventListener("click", (e) => { if (e.target === $("localModal")) $("localModal").hidden = true; });

function renderLocal() {
  const L = S.local; if (!L) { $("globalTbl").innerHTML = `<tr><td class="hint">Reading what is on this computer…</td></tr>`; return; }
  // Mars mode bar
  $("marsChk").checked = !!L.offline;
  $("marsChk").closest(".marsbar").classList.toggle("on", !!L.offline);
  const c = L.net?.counters || {};
  const hosts = Object.entries(c.blocked_hosts || {}).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([h, n]) => `${esc(h)} ${n}`).join(", ");
  $("marsStats").innerHTML = `
    <span>Earth link <b class="${L.offline ? "warn-t" : L.net?.online ? "ok-t" : "bad-t"}">${L.offline ? "OFF (Mars mode)" : L.net?.online ? "online" : "unreachable"}</b></span>
    <span>Data on this PC <b>${GB(L.bytes)}</b></span>
    <span>Free disk <b>${GB(L.disk?.free)}</b></span>
    ${L.offline ? `<span>Requests refused <b>${c.blocked || 0}</b>${hosts ? ` <span class="hint">(${hosts})</span>` : ""}</span>` : `<span class="hint">Switch on to prove it: the app then refuses every internet request and counts them here.</span>`}`;
  // whole-planet packs
  const sel = new Set(S.localPlan.global || []);
  $("globalTbl").innerHTML = Object.entries(L.global_packs).map(([k, v]) => {
    const p = L.packs[k] || {};
    const state = p.complete ? `<span class="ok-t">✔ on this PC</span>` : p.bytes ? `<span class="warn-t">${GB(p.bytes)} so far</span>` : `<span class="na-t">not yet</span>`;
    return `<tr><td><input type="checkbox" data-gp="${k}" ${sel.has(k) ? "checked" : ""} aria-label="${esc(v.name)}"></td>
      <td><div class="nm">${esc(v.name)}</div><div class="rs">${esc(v.res)} · ${esc(v.why || "")}</div></td>
      <td class="sz">${v.kind === "tiles" || v.kind === "geology" ? "≈ " : ""}${GB(v.bytes)}</td><td class="stt">${state}</td></tr>`;
  }).join("");
  for (const cb of $("globalTbl").querySelectorAll("[data-gp]")) cb.onchange = () => {
    const s2 = new Set(S.localPlan.global); cb.checked ? s2.add(cb.dataset.gp) : s2.delete(cb.dataset.gp);
    S.localPlan.global = [...s2]; saveLocalPlan(); $("localEst").innerHTML = "";
  };
  // zones
  const have = new Set((L.zones || []).map((z) => z.id));
  $("zoneList").innerHTML = S.localPlan.zones.length ? "" : `<li class="hint">No zone yet: select a site on the globe and press “Add selected site”, or add your hubs.</li>`;
  S.localPlan.zones.forEach((z, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="t">${esc(z.name)}<small>${z.radius_km} km radius</small></span>
      <span class="m">${fmtLL(z.lat, z.lon, 2)} · ${have.has(z.id) ? `<span class="ok-t">✔ on this PC</span>` : `<span class="na-t">not downloaded</span>`}</span>
      <span class="b"><button class="x" title="Remove this zone" aria-label="Remove ${esc(z.name)}">×</button></span>`;
    li.querySelector(".x").onclick = (e) => { e.stopPropagation(); S.localPlan.zones.splice(i, 1); saveLocalPlan(); renderLocal(); };
    li.onclick = () => { flyTo(z.lon, z.lat, Math.max(30, z.radius_km * 5)); };
    $("zoneList").appendChild(li);
  });
  const parts = new Set(S.localPlan.parts || []);
  $("zoneParts").innerHTML = Object.entries(L.zone_parts).map(([k, v]) => `<label><input type="checkbox" data-zp="${k}" ${parts.has(k) ? "checked" : ""}> ${esc(v)}</label>`).join("");
  for (const cb of $("zoneParts").querySelectorAll("[data-zp]")) cb.onchange = () => {
    const s2 = new Set(S.localPlan.parts); cb.checked ? s2.add(cb.dataset.zp) : s2.delete(cb.dataset.zp);
    S.localPlan.parts = [...s2]; saveLocalPlan(); $("localEst").innerHTML = "";
  };
  // progress
  const P = L.progress;
  const running = !!P?.running;
  $("btnLocalGo").disabled = running || !!L.offline;
  $("btnLocalGo").title = L.offline ? "Switch Mars mode off to download (it needs the internet)" : "";
  $("btnEstimate").disabled = running;
  $("btnLocalCancel").hidden = !running;
  $("localProg").hidden = !P;
  if (P) {
    const frac = P.total_bytes ? Math.min(1, P.done_bytes / P.total_bytes) : 0;
    $("lpBar").style.width = `${(100 * frac).toFixed(1)}%`;
    $("lpTxt").innerHTML = running
      ? `Downloading: item ${Math.min(P.items_total, P.items_done + 1)} of ${P.items_total} · ${GB(P.done_bytes)} of ${GB(P.total_bytes)}`
      : P.result?.ok ? `<span class="ok-t">Done: everything selected is on this computer.</span> You can switch Mars mode on.`
        : P.result?.cancelled ? `<span class="warn-t">Stopped. What was downloaded is kept; Download continues from here.</span>`
          : P.stopped ? `<span class="warn-t">${esc(P.stopped)}</span>` : `<span class="warn-t">Finished with problems (below). Download again to retry them.</span>`;
    $("lpRate").textContent = running && P.rate_bps ? `${GB(P.rate_bps)}/s${P.eta_s ? ` · about ${fmtDur(P.eta_s)} left` : ""}` : "";
    const ifrac = P.tiles_total ? P.tiles_done / P.tiles_total : P.item_total ? Math.min(1, P.item_done / P.item_total) : 0;
    $("lpItemBar").style.width = `${(100 * ifrac).toFixed(1)}%`;
    $("lpItem").textContent = P.item || "";
    $("lpItemTxt").textContent = P.tiles_total ? `${(P.tiles_done || 0).toLocaleString()} / ${P.tiles_total.toLocaleString()} tiles` : P.item_total ? `${GB(P.item_done)} / ${GB(P.item_total)}` : "";
    const lg = $("lpLog");
    lg.textContent = [...(P.log || []), ...(P.errors || []).map((e) => `PROBLEM: ${e}`)].join("\n");
    lg.scrollTop = 1e9;
  }
}
const fmtDur = (s) => s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`;

$("zoneAddSel").onclick = () => {
  const f = S.focus;
  if (!f) { toast("Select a site on the globe first (a candidate, a hub or any point)."); return; }
  const r = +$("zoneRadius").value || 25;
  const id = (f.cand?.id || `p${f.lat.toFixed(3)}_${f.lon.toFixed(3)}`).replace(/[^\w.-]/g, "_");
  S.localPlan.zones = S.localPlan.zones.filter((z) => z.id !== id);
  S.localPlan.zones.push({ id, name: (f.cand?.name || f.name || "Selected site").replace(/^Near /, ""), lon: +f.lon.toFixed(5), lat: +f.lat.toFixed(5), radius_km: r });
  saveLocalPlan(); $("localEst").innerHTML = ""; renderLocal();
};
$("zoneAddHubs").onclick = () => {
  const r = +$("zoneRadius").value || 25;
  for (const s of S.sites) {
    if (S.localPlan.zones.some((z) => z.id === s.id)) continue;
    S.localPlan.zones.push({ id: s.id, name: s.short || s.name, lon: s.center.lon, lat: s.center.lat, radius_km: r });
  }
  saveLocalPlan(); $("localEst").innerHTML = ""; renderLocal();
};
$("btnEstimate").onclick = async () => {
  const btn = $("btnEstimate"); btn.disabled = true; btn.textContent = "Measuring…";
  $("localEst").innerHTML = `<p class="hint">Asking each server for the exact file sizes (HTTP Content-Length)…</p>`;
  try {
    const e = await post("/api/local/estimate", { plan: localPlanForServer() });
    S.localEst = e;
    const groups = {};
    for (const it of e.items) (groups[it.group === "global" ? "Whole planet" : it.zone || it.group] ||= []).push(it);
    $("localEst").innerHTML = `<div class="tot">
        <span>Selected <b>${GB(e.total_bytes)}</b></span><span>Already here <b>${GB(e.have_bytes)}</b></span>
        <span>To download <b>${GB(e.need_bytes)}</b></span><span>Free disk <b>${GB(e.free_bytes)}</b></span>
        <span class="${e.fits ? "ok-t" : "bad-t"}">${e.fits ? "Fits on this disk" : "Does not fit: untick some packs or use a smaller radius"}</span></div>
      <details><summary class="hint">Item by item</summary><table class="tbl">${Object.entries(groups).map(([g, its]) =>
        `<tr><td colspan="3" class="lbl">${esc(g)}</td></tr>` + its.map((it) =>
          `<tr><td>${esc(it.label)}${it.count != null ? ` <span class="na-t">(${it.count.toLocaleString()} ${it.part && it.part.endsWith("dtm") || it.part && it.part.endsWith("ortho") ? "files" : "tiles"})</span>` : ""}</td><td class="num">${it.approx ? "≈ " : ""}${GB(it.bytes)}</td><td class="num na-t">${it.have ? `${GB(it.have)} here` : ""}</td></tr>`).join("")).join("")}</table></details>`;
  } catch (err) { $("localEst").innerHTML = `<p class="bad-t">Could not measure: ${esc(err.message)}</p>`; }
  finally { btn.disabled = false; btn.textContent = "Measure sizes"; }
};
$("btnLocalGo").onclick = async () => {
  if (!(S.localPlan.global || []).length && !S.localPlan.zones.length) { toast("Choose at least one pack or zone."); return; }
  try {
    await post("/api/local/install", { plan: localPlanForServer() });
    toast("Downloading to this computer. You can keep using the app; the download resumes if it is interrupted.", 6000);
    setTimeout(async () => { await loadLocal(); $("localProg").scrollIntoView({ behavior: "smooth", block: "nearest" }); }, 800);
  } catch (err) { toast(`Could not start: ${err.message}`); }
};
$("btnLocalCancel").onclick = async () => { try { await post("/api/local/cancel", {}); toast("Stopping after the current file…"); } catch { /* */ } };
$("marsChk").onchange = async () => {
  const on = $("marsChk").checked;
  try {
    await post("/api/local/mode", { offline: on });
    toast(on ? "Mars mode on: nothing is sent to the internet. Everything you see now comes from this computer."
      : "Mars mode off: the app may use the internet again.", 6000);
    S.legendCache.clear();
    for (const t of tiles.values()) if (t.state === "ready" && t.z >= 6) t.refreshAt = performance.now() + 200;   // redraw from the local data
    await loadLocal(); refreshStatus();
  } catch (err) { $("marsChk").checked = !on; toast(`Could not switch: ${err.message}`); }
};

// ------------------------------------------------------------------------------------------------- search
let searchT = 0;
$("searchIn").addEventListener("input", () => { clearTimeout(searchT); searchT = setTimeout(runSearch, 180); });
$("searchForm").addEventListener("submit", (e) => { e.preventDefault(); const b = $("searchRes").querySelector("button:not([disabled])"); if (b && !$("searchRes").hidden) b.click(); else runSearch(true); });
document.addEventListener("click", (e) => { if (!e.target.closest(".search")) $("searchRes").hidden = true; });
function parseLatLon(q) {
  const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*°?\s*([NSns])?\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*°?\s*([EWew])?\s*$/);
  if (!m) return null;
  let lat = +m[1], lon = +m[3];
  if (m[2] && /s/i.test(m[2])) lat = -Math.abs(lat);
  if (m[4] && /w/i.test(m[4])) lon = -Math.abs(lon);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 360) return null;
  return { lat, lon: wrap180(lon) };
}
let searchSeq = 0;
async function runSearch(submit = false) {
  const q = $("searchIn").value.trim(), box = $("searchRes");
  const seq = ++searchSeq;
  if (q.length < 2) { box.hidden = true; return; }
  const ll = parseLatLon(q);
  if (ll) {
    box.innerHTML = "";
    const b = document.createElement("button");
    b.innerHTML = `Go to ${fmtLL(ll.lat, ll.lon, 4)}<small>latitude, longitude (east-positive)</small>`;
    b.onclick = () => { box.hidden = true; flyTo(ll.lon, ll.lat, 300); selectPoint(ll.lon, ll.lat); };
    box.appendChild(b); box.hidden = false;
    if (submit) b.click();
    return;
  }
  const ql = q.toLowerCase();
  const local = S.cand.filter((c) => c.name.toLowerCase().includes(ql) || (c.proposer || "").toLowerCase().includes(ql)).slice(0, 8);
  const hubs = S.sites.filter((s) => (s.name || s.id).toLowerCase().includes(ql)).slice(0, 4);
  let iau = [];
  try { iau = (await api(`/api/search?q=${encodeURIComponent(q)}&limit=12`)).results; } catch { /* names offline */ }
  if (seq !== searchSeq) return;
  box.innerHTML = "";
  const group = (title) => { const d = document.createElement("div"); d.className = "grp"; d.textContent = title; box.appendChild(d); };
  const item = (html, fn) => { const b = document.createElement("button"); b.innerHTML = html; b.onclick = () => { box.hidden = true; fn(); }; box.appendChild(b); };
  if (hubs.length) { group("Hubs"); for (const s of hubs) item(`▲ ${esc(s.name || s.id)}<small>built EVA site</small>`, () => openCandidate({ id: `hub:${s.id}`, siteId: s.id, kind: "hub", name: s.name || s.id, lon: s.center.lon, lat: s.center.lat })); }
  if (local.length) { group("Candidate sites"); for (const c of local) item(`${esc(c.name)}<small>${TAG[c.kind]} · ${fmtLL(c.lat, c.lon, 1)}${c.proposer ? ` · ${esc(c.proposer)}` : ""}</small>`, () => { $("searchIn").value = c.name; openCandidate(c); }); }
  if (iau.length) {
    group("IAU place names");
    for (const r of iau) {
      item(`${esc(r.name)}<small>${esc(r.type || "")}${r.diameter_km ? ` · ${(+r.diameter_km).toFixed(0)} km` : ""} · ${fmtLL(+r.lat, +r.lon, 2)}</small>`, () => {
        $("searchIn").value = r.name;
        const d = +r.diameter_km || 30;
        flyTo(+r.lon, +r.lat, Math.max(5, Math.min(8000, d * 2.2)));
        clearMarkers("name");
        loadNames();
        addMarker("name", +r.lon, +r.lat, r.name, () => selectPoint(+r.lon, +r.lat));
        setTimeout(() => selectPoint(+r.lon, +r.lat), 1900);
      });
    }
  }
  if (!box.children.length) { const b = document.createElement("button"); b.disabled = true; b.textContent = `Nothing matches “${q}”. Try a crater name or “18.4N 77.5E”.`; box.appendChild(b); }
  box.hidden = false;
}
const FAMOUS = [["Olympus Mons", -133.8, 18.65], ["Valles Marineris", -59.2, -13.9], ["Hellas Planitia", 70.5, -42.4], ["Jezero", 77.58, 18.38],
  ["Gale", 137.85, -5.4], ["Elysium Mons", 146.9, 24.8], ["Arsia Mons", -120.46, -8.26], ["Utopia Planitia", 117.5, 49.7], ["Argyre Planitia", -43, -49.7],
  ["Planum Boreum", 0, 88], ["Planum Australe", 160, -84], ["Meridiani Planum", -3.7, -0.2], ["Isidis Planitia", 88, 13], ["Arcadia Planitia", -165, 47],
  ["Amazonis Planitia", -163, 25], ["Chryse Planitia", -40, 25], ["Acidalia Planitia", -21, 47]];
function loadNames() { for (const [n, lon, lat] of FAMOUS) addMarker("name", lon, lat, n, () => { flyTo(lon, lat, 1400); selectPoint(lon, lat); }); }

// ------------------------------------------------------------------------------------------------- controls, scale, needle
$("zIn").onclick = () => { S.cam.range /= 1.8; dirty = true; };
$("zOut").onclick = () => { S.cam.range *= 1.8; dirty = true; };
$("north").onclick = () => { S.cam.heading = 0; S.cam.tilt = 0; dirty = true; };
$("tilt").onclick = () => {
  if (S.cam.range > 3000) { toast("Zoom in to tilt the view."); return; }
  S.cam.tilt = S.cam.tilt > 10 ? 0 : 55; dirty = true;
};
function updateScale() {
  const kpp = kmPerPx(), target = kpp * 110;
  const p = 10 ** Math.floor(Math.log10(target));
  const nice = [5, 2, 1].map((m) => m * p).find((v) => v <= target) || p;
  $("scaleBar").style.width = `${Math.max(20, nice / kpp).toFixed(0)}px`;
  $("scaleTxt").textContent = fmtKm(nice);
  $("needle").style.transform = `rotate(${-S.cam.heading}deg)`;
}

// ------------------------------------------------------------------------------------------------- status
async function refreshStatus() {
  try {
    const s = await api("/api/planet/status");
    S.online = s.online;
    $("offline").hidden = true;
    const pill = $("netPill");
    const mars = !!s.local?.offline;
    pill.textContent = mars ? "EARTH LINK OFF" : s.online ? "NASA / USGS · ONLINE" : "OFFLINE · local data";
    pill.className = `pill ${mars ? "warn" : s.online ? "ok" : "bad"}`;
    pill.title = mars ? "Mars mode: nothing is sent to the internet; everything comes from this computer"
      : s.online ? "Connected to the NASA / USGS data servers" : `No internet: working from the data on this computer. ${s.net?.last_error || ""}`;
    if (S.local && !!S.local.offline !== mars) loadLocal();
    const gb = (b) => (b / 1e9).toFixed(b > 1e9 ? 1 : 2);
    $("cacheOut").textContent = `Cache: ${s.cache.tiles.toLocaleString()} tiles, ${gb(s.cache.bytes)} of ${gb(s.cache.limit)} GB.`;
    const cat = s.catalog || {};
    $("srcOut").innerHTML = `<b>Elevation</b>: MOLA MEGDR 463 m global${s.megdr.global16 ? " ✔" : " (downloading)"}; HRSC-MOLA blend 200 m${s.blend.usable ? " ✔" : ""};
      CTX 20 m DTMs: ${cat.ctx?.count ?? "…"}; HiRISE 1 m DTMs: ${cat.hirise?.count ?? "…"} (USGS Astrogeology STAC, CC0).<br>
      <b>Imagery</b>: CTX global mosaic 5 m (Dickson et al. 2023, via Esri / ASU); HiRISE 25 cm mosaics; THEMIS day and night IR 100 m; Viking MDIM 2.1 colour (NASA Mars Trek).<br>
      <b>Maps</b>: USGS SIM 3292 geologic map (Tanaka et al. 2014); science layers in the list above.<br>
      <b>Names</b>: ${s.names.count.toLocaleString()} IAU / USGS Gazetteer features.`;
    if (!dsJobRunning) {
      const dj = (s.jobs || []).find((j) => j.kind === "datasets") || null;
      if (dj) followDsJob(dj.id);
      else if (s.datasets && Object.entries(s.datasets).some(([k, v]) => S.datasets[k] && S.datasets[k].installed !== v)) loadDatasets();
    }
  } catch {
    $("offline").hidden = false;
    $("netPill").textContent = "SERVER NOT RUNNING"; $("netPill").className = "pill bad";
  }
}

// ------------------------------------------------------------------------------------------------- URL state
function saveHash() {
  const c = S.cam, f = S.focus;
  const ov = [...document.querySelectorAll("[data-ovl]")].filter((x) => x.checked).map((x) => x.dataset.ovl).join("+");
  const sel = !f ? "" : f.cand && ["ez", "starship", "heritage"].includes(f.cand.kind) && !/refined/.test(f.cand.name) ? `c:${f.cand.id}` : `${f.lat.toFixed(5)};${f.lon.toFixed(5)}`;
  history.replaceState(null, "", `#${c.lat.toFixed(4)},${c.lon.toFixed(4)},${c.range.toFixed(2)},${c.heading.toFixed(0)},${c.tilt.toFixed(0)},${S.base},${S.crit},${ov},${encodeURIComponent(sel)}`);
}
let hashSel = null;
function readHash() {
  const p = decodeURIComponent(location.hash.slice(1)).split(",");
  if (p.length >= 3 && p.slice(0, 3).every((v) => v !== "" && isFinite(+v))) {
    Object.assign(S.cam, { lat: +p[0], lon: +p[1], range: +p[2], heading: +p[3] || 0, tilt: +p[4] || 0 });
    if ([...$("baseSel").options].some((o) => o.value === p[5])) { S.base = p[5]; $("baseSel").value = p[5]; }
    if (p[6] === "hls2" || p[6] === "starship") {
      S.crit = p[6];
      for (const x of document.querySelectorAll(".seg button[data-crit]")) x.setAttribute("aria-checked", String(x.dataset.crit === S.crit));
    }
    for (const k of (p[7] || "").split("+")) { const cb = document.querySelector(`[data-ovl="${k}"]`); if (cb) cb.checked = true; }
    hashSel = p[8] || null;
    return true;
  }
  return false;
}
function restoreFocusFromHash() {
  if (!hashSel) return;
  const s = hashSel; hashSel = null;
  if (s.startsWith("c:")) { const c = S.cand.find((x) => x.id === s.slice(2)); if (c) openCandidate(c, false); return; }
  const [la, lo] = s.split(";").map(Number);
  if (isFinite(la) && isFinite(lo)) selectPoint(lo, la);
}

// ------------------------------------------------------------------------------------------------- loop
let lastHash = 0, lastScale = 0, lastStat = { drawn: 0, wanted: 0 };
function frame(now) {
  requestAnimationFrame(frame);
  stepFlight(now);
  placeCamera();
  lastStat = selectTiles();
  if (Math.abs(Math.log(S.cam.range / (overlayRange || 1))) > 0.7) rebuildOverlays();
  labelsEl.classList.toggle("far", S.cam.range > 5200);
  updateMarkers();
  renderer.render(scene, camera);
  if (now - lastScale > 120) {
    lastScale = now;
    updateScale();
    const alt = camera.position.length() - R;
    $("hudAlt").textContent = `alt ${fmtKm(alt)} · z${currentZoom()}`;
    $("hudLoad").textContent = loading || lastStat.wanted ? `streaming ${loading + queue.size} tiles` : `${loadedTotal} tiles`;
  }
  if (dirty && now - lastHash > 500) { saveHash(); lastHash = now; dirty = false; clearTimeout(covT); covT = setTimeout(loadCoverage, 800); }
}

const hadHash = readHash();
resize();
if (canvas.clientWidth < 820 || window.innerHeight < 820) {       // small screens: the layer list starts folded (header stays)
  $("layers").classList.add("collapsed"); $("layersToggle").setAttribute("aria-expanded", "false");
}
loadNames();
updateLegend();
loadDatasets().then(() => loadCandidates());
loadHubs().then(() => loadLocal());
refreshStatus();
setInterval(refreshStatus, 5000);
requestAnimationFrame(frame);
if (!hadHash) flyTo(20, 20, 11000, 10);
{ const j = store.get("mm.dsJob"); if (j) api(`/api/job/${j}`).then((x) => { if (x.status === "running") followDsJob(j); else store.set("mm.dsJob", null); }).catch(() => store.set("mm.dsJob", null)); }
window.MMLanding = { S, tiles, flyTo, selectPoint, assess, elevAt, screenAll };   // for debugging from the console
