// drive.js - the "you are the crew" window. A first-person 3D view of the site's real terrain in which you walk (suited)
// or drive (unpressurised rover) with the keyboard and look with the mouse. Every second of your EVA becomes NASA SUITS
// Telemetry Stream Server frames (suit consumables, heart rate, position) sent to the main MarsNav window, which runs
// its closed loop on them exactly as it would on a real suit: it localises you, learns how hard you are really working
// and how fast the suit is really draining, and re-plans when you leave the route or the forecast breaks a limit. The
// re-planned route comes back here in cyan, the contingency return in red.
// Your movement costs what the engine's physiology says it costs (engine/physio.js), times the "hidden truth" sliders
// (work rate, pace, battery drain, leak) that the planner is not told about.

import * as THREE from "../vendor/three.module.min.js";
import { loadTerrain, browserIO } from "../engine/terrain.js";
import { lonlatToXY, xyToLonLat, R_MARS, DEG } from "../engine/geo.js";
import { Environment } from "../engine/environment.js";
import { walkSpeedKmh, walkMetabolicW, vehicleSpeedKmh, drivePowerW, suitHeat, SUIT, MET, PROFILES, o2KgPerH, co2KgPerH, THERM } from "../engine/physio.js";
import { tssFrameFromSim } from "../engine/telemetry.js";
import { HR_CAL } from "../engine/estimator.js";

const $ = (id) => document.getElementById(id);
const CH = new BroadcastChannel("martian-map-drive");
const SKY = new THREE.Color("#c9a27a"), SKY_TOP = new THREE.Color("#8f6a4c");
const CHUNK = 64;                         // 10 m cells per terrain chunk (640 m)
const LOD = [{ d: 1200, step: 1, tex: 256 }, { d: 4000, step: 2, tex: 128 }, { d: 12000, step: 4, tex: 64 }, { d: Infinity, step: 8, tex: 32 }];

const S = {
  T: null, env: null, data: null, imagery: null, ortho: null, hi2: new Map(), base: null, baseXY: [0, 0], zRef: 0,
  profile: "foot", departMs: Date.now(), hw: { o2Fill: 1, battSOH: 1, waterFill: 1, scrubCap: 1, roverBattSOH: 1 },
  route: [], live: null, ret: null, stations: [], snap: null,
  x: 0, y: 0, yaw: 0, pitch: -0.05, roverYaw: 0, speed: 0, grade: 0, ground: "firm",
  running: false, t: 0, used: { o2: 0, co2: 0, water: 0, batt: 0, rbatt: 0 }, dist: 0, metW: MET.P_REST_W, working: false,
  keys: new Set(), lastSend: 0, miniZoom: 1, seedRand: 1,
  steer: 0, cam: "eyes", lastLook: 0, camPos: null,
};
// Rover handling. Steering sets the path curvature (tightest turn radius R_MIN at full lock), so the path you drive is the
// same at every time warp; the on-screen turn rate is capped so the view stays controllable at high warp. At a standstill
// the rover can turn on the spot (skid steer), as NASA's pressurised-rover concepts can.
const ROVER = { R_MIN: 5.0, YAW_MAX: 1.1, PIVOT: 0.55, ACC: 0.8, COAST: 1.5, BRAKE: 3.0, REVERSE_MAX: 1.5 };
const CAMS = { rover: ["cockpit", "chase", "top"], foot: ["eyes", "top"] };
const truth = () => ({ met: +$("met").value, pace: +$("pace").value, batt: +$("battX").value, leak: +$("leak").value, cooling: $("fCool").checked });
const rand = (() => { let s = 12345; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s >>>= 0; s ^= s << 5; s >>>= 0; return s / 4294967296; }; })();

// ------------------------------------------------------------------------------------------------ three.js --
const canvas = $("view");
let renderer;
try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "default" }); }
catch (e) { $("status").innerHTML = `<span class="bad">This browser has WebGL turned off, so the 3D view cannot run: ${e.message}</span>`; throw e; }
renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
const scene = new THREE.Scene();
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 2500, 22000);
const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 60000);
const sun = new THREE.DirectionalLight(0xfff1dc, 1.7);
scene.add(sun, new THREE.HemisphereLight(SKY_TOP, 0x3a2a20, 0.85));
const world = new THREE.Group();
scene.add(world);
const CAM = { value: new THREE.Vector3() };
// Mars curvature on every surface: a point d metres away sits d^2 / 2R lower (a 10 km horizon drops 15 m)
function curved(mat) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uCam = CAM;
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nuniform vec3 uCam;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\n{ vec2 dd = transformed.xz - uCam.xz; transformed.y -= dot(dd, dd) / 6792380.0; }");
  };
  return mat;
}
function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / Math.max(1, window.innerHeight);
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();
canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); $("status").innerHTML = '<span class="bad">Graphics context lost (GPU memory). Reload this window to continue.</span>'; });

// ---------------------------------------------------------------------------------------------- terrain --
const g = () => S.T.grid;
function elevAt(x, y) {
  const G = g(), r = (G.y0 - y) / G.res - 0.5, c = (x - G.x0) / G.res - 0.5;
  const v = G.sample(S.T.f32("elev_dm"), Math.max(0, Math.min(G.height - 1, r)), Math.max(0, Math.min(G.width - 1, c)));
  return Number.isFinite(v) ? v : S.zRef;
}
const W = (x, y, z) => new THREE.Vector3(x - S.baseXY[0], z - S.zRef, S.baseXY[1] - y); // world: +x east, +z south, +y up
function layerAt(name, x, y) {
  const i = g().idxOfXY(x, y);
  return i < 0 ? NaN : S.T.get(name, i);
}
function groundClass(x, y) {
  if (layerAt("sand", x, y) > 0.5) return "sand";
  if (layerAt("step", x, y) > 0.3) return "rocky";
  return "firm";
}

const chunks = new Map();
let chunkQueue = [];
function img(url) {
  return new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = url; });
}
function chunkTexture(r0, c0, r1, c1, size, lod) {
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const cx = cv.getContext("2d");
  cx.fillStyle = "#8a6a50";
  cx.fillRect(0, 0, size, size);
  const o = S.imagery?.ortho5, f = o ? o.width / g().width : 2;    // ortho px per 10 m cell
  if (S.ortho) cx.drawImage(S.ortho, c0 * f, r0 * f, (c1 - c0) * f, (r1 - r0) * f, 0, 0, size, size);
  if (lod === 0) {
    for (const t of S.imagery?.hi2?.tiles || []) {
      if (t.c0 >= c1 || t.c0 + t.cells <= c0 || t.r0 >= r1 || t.r0 + t.cells <= r0) continue;
      const im = S.hi2.get(t.file);
      if (!im) { if (!S.hi2.has(t.file)) { S.hi2.set(t.file, null); img(new URL(t.file, S.data).href).then((i) => { if (i) { S.hi2.set(t.file, i); refreshNear(); } }); } continue; }
      cx.globalAlpha = 0.9;
      cx.drawImage(im, (t.c0 - c0) / (c1 - c0) * size, (t.r0 - r0) / (r1 - r0) * size, t.cells / (c1 - c0) * size, t.cells / (r1 - r0) * size);
      cx.globalAlpha = 1;
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = lod === 0 ? 4 : 1;
  return tex;
}
function buildChunk(cr, cc, lod) {
  const G = g(), L = LOD[lod];
  const r0 = cr * CHUNK, c0 = cc * CHUNK, r1 = Math.min(G.height - 1, r0 + CHUNK), c1 = Math.min(G.width - 1, c0 + CHUNK);
  if (r1 <= r0 || c1 <= c0) return null;
  const rows = [], cols = [];
  for (let r = r0; r < r1; r += L.step) rows.push(r);
  rows.push(r1);
  for (let c = c0; c < c1; c += L.step) cols.push(c);
  cols.push(c1);
  const nr = rows.length, nc = cols.length, e = S.T.f32("elev_dm");
  const skirt = 2 * (nr + nc);
  const pos = new Float32Array((nr * nc + skirt) * 3), uv = new Float32Array((nr * nc + skirt) * 2);
  const idx = [];
  const put = (k, r, c, drop = 0) => {
    const z = e[r * G.width + c];
    const X = G.x0 + (c + 0.5) * G.res - S.baseXY[0], Y = S.baseXY[1] - (G.y0 - (r + 0.5) * G.res);
    pos[3 * k] = X; pos[3 * k + 1] = (Number.isFinite(z) ? z : S.zRef) - S.zRef - drop; pos[3 * k + 2] = Y;
    uv[2 * k] = (c - c0) / (c1 - c0); uv[2 * k + 1] = 1 - (r - r0) / (r1 - r0);
  };
  for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) put(i * nc + j, rows[i], cols[j]);
  for (let i = 0; i + 1 < nr; i++) for (let j = 0; j + 1 < nc; j++) {
    const a = i * nc + j, b = a + 1, c = a + nc, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  // skirts hide the cracks between chunks drawn at different levels of detail
  let k = nr * nc;
  const edge = (list) => {
    const start = k;
    for (const [r, c] of list) put(k++, r, c, 25);
    return start;
  };
  const top = cols.map((c) => [rows[0], c]), bot = cols.map((c) => [rows[nr - 1], c]);
  const lef = rows.map((r) => [r, cols[0]]), rig = rows.map((r) => [r, cols[nc - 1]]);
  const s1 = edge(top), s2 = edge(bot), s3 = edge(lef), s4 = edge(rig);
  for (let j = 0; j + 1 < nc; j++) { idx.push(j, j + 1, s1 + j, j + 1, s1 + j + 1, s1 + j); const b0 = (nr - 1) * nc + j; idx.push(b0, s2 + j, b0 + 1, b0 + 1, s2 + j, s2 + j + 1); }
  for (let i = 0; i + 1 < nr; i++) { const a0 = i * nc; idx.push(a0, s3 + i, a0 + nc, a0 + nc, s3 + i, s3 + i + 1); const b0 = i * nc + nc - 1; idx.push(b0, b0 + nc, s4 + i, b0 + nc, s4 + i + 1, s4 + i); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, curved(new THREE.MeshLambertMaterial({ map: chunkTexture(r0, c0, r1, c1, L.tex, lod) })));
  mesh.userData = { cr, cc, lod, cx: (c0 + c1) / 2, cy: (r0 + r1) / 2 };
  return mesh;
}
function disposeMesh(m) { world.remove(m); m.geometry.dispose(); m.material.map?.dispose(); m.material.dispose(); }
function wantLod(cr, cc) {
  const G = g(), cx = G.x0 + ((cc + 0.5) * CHUNK) * G.res, cy = G.y0 - ((cr + 0.5) * CHUNK) * G.res;
  const d = Math.hypot(cx - S.x, cy - S.y);
  return LOD.findIndex((l) => d < l.d);
}
function planChunks() {
  const G = g(), NR = Math.ceil(G.height / CHUNK), NC = Math.ceil(G.width / CHUNK);
  const q = [];
  for (let cr = 0; cr < NR; cr++) for (let cc = 0; cc < NC; cc++) {
    const want = wantLod(cr, cc), have = chunks.get(`${cr},${cc}`);
    if (!have || have.userData.lod !== want) q.push([want, cr, cc]);
  }
  q.sort((a, b) => a[0] - b[0]);
  chunkQueue = q;
}
function refreshNear() {
  for (const m of chunks.values()) if (m.userData.lod === 0) m.userData.lod = -1; // force a rebuild with the new imagery
  planChunks();
}
function pumpChunks(budgetMs = 8) {
  const t0 = performance.now();
  while (chunkQueue.length && performance.now() - t0 < budgetMs) {
    const [lod, cr, cc] = chunkQueue.shift();
    const key = `${cr},${cc}`, old = chunks.get(key);
    if (old && old.userData.lod === lod) continue;
    const m = buildChunk(cr, cc, lod);
    if (!m) continue;
    if (old) disposeMesh(old);
    world.add(m);
    chunks.set(key, m);
  }
}

// ------------------------------------------------------------------------------------- route, markers --
const overlays = new THREE.Group();
world.add(overlays);
let ribbons = { plan: null, live: null, ret: null };
function ribbon(ll, color, width, lift = 0.35, opacity = 0.9) {
  if (!ll || ll.length < 2) return null;
  const pts = [];
  let last = null;
  for (let k = 0; k < ll.length; k++) {
    const [x, y] = lonlatToXY(ll[k][0], ll[k][1]);
    if (last) {
      const n = Math.ceil(Math.hypot(x - last[0], y - last[1]) / 4);
      for (let s = 1; s <= n; s++) pts.push([last[0] + (x - last[0]) * s / n, last[1] + (y - last[1]) * s / n]);
    } else pts.push([x, y]);
    last = [x, y];
  }
  const pos = new Float32Array(pts.length * 6), idx = [];
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pts[i], [xa, ya] = pts[Math.max(0, i - 1)], [xb, yb] = pts[Math.min(pts.length - 1, i + 1)];
    let dx = xb - xa, dy = yb - ya;
    const L = Math.hypot(dx, dy) || 1;
    dx /= L; dy /= L;
    const nx = -dy * width / 2, ny = dx * width / 2;
    const a = W(x + nx, y + ny, elevAt(x + nx, y + ny) + lift), b = W(x - nx, y - ny, elevAt(x - nx, y - ny) + lift);
    pos.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
    if (i) idx.push(2 * i - 2, 2 * i - 1, 2 * i, 2 * i - 1, 2 * i + 1, 2 * i);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  const m = new THREE.Mesh(geo, curved(new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false })));
  m.renderOrder = 2;
  return m;
}
function setRibbon(key, ll, color, width) {
  if (ribbons[key]) { overlays.remove(ribbons[key]); ribbons[key].geometry.dispose(); ribbons[key].material.dispose(); }
  ribbons[key] = ribbon(ll, color, width);
  if (ribbons[key]) overlays.add(ribbons[key]);
}
function label(text, color = "#f2f5f8") {
  const cv = document.createElement("canvas"), c = cv.getContext("2d");
  c.font = "600 30px 'Barlow Condensed', system-ui, sans-serif";
  cv.width = Math.ceil(c.measureText(text).width) + 20; cv.height = 42;
  const c2 = cv.getContext("2d");
  c2.font = "600 30px 'Barlow Condensed', system-ui, sans-serif";
  c2.fillStyle = "rgba(11,15,20,0.8)"; c2.fillRect(0, 0, cv.width, cv.height);
  c2.fillStyle = color; c2.fillText(text, 10, 31);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false, sizeAttenuation: false }));
  sp.scale.set(0.045 * cv.width / cv.height, 0.045, 1);
  sp.renderOrder = 5;
  return sp;
}
let markers = new THREE.Group();
function buildMarkers() {
  overlays.remove(markers);
  markers.traverse((o) => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose(); });
  markers = new THREE.Group();
  const pole = (lon, lat, h, color, text) => {
    const [x, y] = lonlatToXY(lon, lat), z = elevAt(x, y), p = W(x, y, z);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, h, 8), curved(new THREE.MeshBasicMaterial({ color })));
    m.position.set(p.x, p.y + h / 2, p.z);
    const l = label(text); l.position.set(p.x, p.y + h + 2, p.z);
    markers.add(m, l);
  };
  if (S.base) {
    const [x, y] = S.baseXY, p = W(x, y, elevAt(x, y));
    const hab = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 3.5, 24), curved(new THREE.MeshLambertMaterial({ color: 0xf2f5f8 })));
    hab.position.set(p.x, p.y + 1.75, p.z);
    markers.add(hab);
    pole(S.base.lon, S.base.lat, 12, 0xf2f5f8, "HAB");
  }
  S.stations.forEach((s, k) => pole(s.lon, s.lat, 10, 0xffc629, `${k + 1} ${s.name.split(/[,(]/)[0].trim()}`));
  overlays.add(markers);
}

// ---------------------------------------------------------------------------------------------- controls --
canvas.addEventListener("click", () => { if (document.pointerLockElement !== canvas) canvas.requestPointerLock?.(); });
document.addEventListener("mousemove", (e) => {
  if (document.pointerLockElement !== canvas) return;
  S.yaw += e.movementX * 0.0022;
  S.pitch = Math.max(-1.3, Math.min(1.3, S.pitch - e.movementY * 0.0022));
  S.lastLook = performance.now();
});
// drag-to-look when the pointer is not locked (e.g. inside an embedded browser that refuses pointer lock)
let drag = null;
canvas.addEventListener("pointerdown", (e) => { if (document.pointerLockElement !== canvas) drag = { x: e.clientX, y: e.clientY }; });
window.addEventListener("pointerup", () => { drag = null; });
window.addEventListener("pointermove", (e) => {
  if (!drag) return;
  S.yaw -= (e.clientX - drag.x) * 0.004; S.pitch = Math.max(-1.3, Math.min(1.3, S.pitch - (e.clientY - drag.y) * 0.004));
  drag = { x: e.clientX, y: e.clientY };
  S.lastLook = performance.now();
});
const GAME = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "KeyW", "KeyA", "KeyS", "KeyD", "ShiftLeft", "ShiftRight", "KeyF", "Space"]);
const TYPING = "input[type=text], input[type=number], input[type=search], textarea";
window.addEventListener("keydown", (e) => {
  if (e.target.closest?.(TYPING)) return;
  // a panel control that still has focus (the Mode or Time-warp list, a slider, a button) must not swallow the driving
  // keys: the arrows would otherwise switch Walk/Rover or move a slider instead of the rover
  if ((GAME.has(e.code) || ["KeyC", "KeyV", "KeyM", "KeyP"].includes(e.code)) && e.target.closest?.("select, input, button, summary")) e.target.blur();
  if (GAME.has(e.code)) { S.keys.add(e.code); e.preventDefault(); }
  if (e.repeat) return;
  if (e.code === "KeyM") S.miniZoom = (S.miniZoom + 1) % 3;
  if (e.code === "KeyP") $("panel").classList.toggle("min");
  if (e.code === "KeyC") cycleCamera();
  if (e.code === "KeyV") { S.yaw = S.profile === "rover" ? 0 : S.yaw; S.pitch = -0.05; }
});
// selects and sliders give the keyboard back to the view as soon as they are used
for (const el of document.querySelectorAll("#panel select, #panel input[type=range], #panel input[type=checkbox]")) el.addEventListener("change", () => el.blur());
canvas.addEventListener("pointerdown", () => document.activeElement?.blur?.());
function cycleCamera() {
  const list = CAMS[S.profile === "rover" ? "rover" : "foot"];
  S.cam = list[(list.indexOf(S.cam) + 1) % list.length];
  S.camPos = null;
  $("hCam").textContent = S.cam;
}
window.addEventListener("keyup", (e) => S.keys.delete(e.code));
window.addEventListener("blur", () => S.keys.clear());
$("pToggle").addEventListener("click", () => $("panel").classList.toggle("min"));
for (const [id, out, fmt] of [["met", "vMet", (v) => (+v).toFixed(2)], ["pace", "vPace", (v) => (+v).toFixed(2)], ["battX", "vBatt", (v) => (+v).toFixed(2)],
  ["leak", "vLeak", (v) => (+v).toFixed(3)], ["o2Fill", "vO2", (v) => v], ["battSOH", "vBh", (v) => v], ["waterFill", "vW", (v) => v], ["roverSOH", "vRb", (v) => v]]) {
  $(id).addEventListener("input", () => { $(out).textContent = fmt($(id).value); });
}
$("mode").addEventListener("change", () => {
  CH.postMessage({ type: "profile", profile: $("mode").value });
  $("status").textContent = "Asked the planner to re-plan for this crew mode…";
});
$("btnDeclare").addEventListener("click", () => {
  CH.postMessage({ type: "checkout", hw: { o2Fill: +$("o2Fill").value / 100, battSOH: +$("battSOH").value / 100, waterFill: +$("waterFill").value / 100,
    roverBattSOH: +$("roverSOH").value / 100 } });
  $("status").textContent = "Checkout sent: the planner re-plans with these fills.";
});
$("btnStart").addEventListener("click", () => startEva());
$("btnHome").addEventListener("click", () => { toHab(); });

// the walker looks where S.yaw points; in the rover the vehicle points along S.roverYaw and S.yaw is the look offset
// from the vehicle's nose (0 = straight ahead), so W always drives the way the camera faces at the start
function setHeading(h) { S.roverYaw = h; S.yaw = S.profile === "rover" ? 0 : h; }
function viewHeading() { return S.profile === "rover" ? S.roverYaw + S.yaw : S.yaw; }

function toHab() {
  [S.x, S.y] = S.baseXY;
  S.speed = 0;
  // face the first station
  const s = S.stations[0];
  if (s) { const [x, y] = lonlatToXY(s.lon, s.lat); setHeading(Math.atan2(x - S.x, y - S.y)); }
  planChunks();
}

function startEva() {
  if (!S.T) return;
  toHab();
  S.t = 0; S.dist = 0; S.used = { o2: 0, co2: 0, water: 0, batt: 0, rbatt: 0 };
  S.running = true;
  S.live = null; S.ret = null; setRibbon("live", null); setRibbon("ret", null);
  $("events").innerHTML = "";
  CH.postMessage({ type: "start" });
  $("btnStart").textContent = "Restart EVA";
  $("status").innerHTML = '<span class="ok">EVA running: your telemetry is feeding the main window (Execute, live).</span>';
  canvas.focus?.();
}

// --------------------------------------------------------------------------------------------- simulation --
function stepPlayer(dtWall) {
  const warp = +$("warp").value, dt = dtWall * warp, T = truth();
  const k = S.keys, fwd = (k.has("ArrowUp") || k.has("KeyW") ? 1 : 0) - (k.has("ArrowDown") || k.has("KeyS") ? 1 : 0);
  const side = (k.has("ArrowRight") || k.has("KeyD") ? 1 : 0) - (k.has("ArrowLeft") || k.has("KeyA") ? 1 : 0);
  const hurry = k.has("ShiftLeft") || k.has("ShiftRight");
  const braking = k.has("Space");
  S.working = k.has("KeyF") && Math.abs(S.speed) < 0.05;
  const rover = S.profile === "rover";
  let hx, hy, vTarget;
  if (rover) {
    // steering wheel: eases towards full lock and back (real time)
    S.steer += Math.sign(side - S.steer) * Math.min(Math.abs(side - S.steer), dtWall * (side === 0 ? 4 : 2.5));
    let dyaw = S.speed * dt * S.steer / ROVER.R_MIN;                 // curvature x distance (reverses when backing up)
    const cap = ROVER.YAW_MAX * dtWall;
    dyaw = Math.max(-cap, Math.min(cap, dyaw));
    if (Math.abs(S.speed) < 0.15 && fwd === 0) dyaw = S.steer * ROVER.PIVOT * dtWall;   // turn on the spot
    S.roverYaw = ((S.roverYaw + dyaw) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    hx = Math.sin(S.roverYaw); hy = Math.cos(S.roverYaw);
    // the view drifts back to straight ahead while driving, unless you are looking around with the mouse
    if (Math.abs(S.speed) > 0.3 && performance.now() - S.lastLook > 1500) S.yaw *= Math.exp(-dtWall / 0.6);
  } else {
    const len = Math.hypot(fwd, side) || 1;
    hx = (Math.sin(S.yaw) * fwd + Math.cos(S.yaw) * side) / len;
    hy = (Math.cos(S.yaw) * fwd - Math.sin(S.yaw) * side) / len;
  }
  const moving = rover ? fwd !== 0 : fwd !== 0 || side !== 0;
  const z0 = elevAt(S.x, S.y), z1 = elevAt(S.x + hx * 3 * Math.sign(rover ? fwd || 1 : 1), S.y + hy * 3 * Math.sign(rover ? fwd || 1 : 1));
  S.grade = Math.atan((z1 - z0) / 3) / DEG;
  S.ground = groundClass(S.x, S.y);
  if (rover) {
    const vmax = vehicleSpeedKmh(PROFILES.rover, S.grade, S.ground) / 3.6 * (hurry ? 1.25 : 1);
    vTarget = braking ? 0 : fwd > 0 ? vmax : fwd < 0 ? -Math.min(ROVER.REVERSE_MAX, vmax * 0.4) : 0;
    // [ASSUME] gentle acceleration on loose ground; rolling resistance stops it when you let go; Space brakes hard
    const acc = braking ? ROVER.BRAKE : (vTarget === 0 || Math.sign(vTarget) !== Math.sign(S.speed || vTarget)) ? ROVER.COAST : ROVER.ACC;
    S.speed += Math.max(-acc * dt, Math.min(acc * dt, vTarget - S.speed));
    if (vmax === 0 && S.speed > 0) S.speed = 0;
  } else {
    const v = walkSpeedKmh(S.grade, S.ground, !hurry) / 3.6 * T.pace;
    S.speed = moving ? v : 0;
  }
  const step = S.speed * dt;
  S.wheel = (S.wheel || 0) + step;
  let nx = S.x + (rover ? hx : hx) * step, ny = S.y + (rover ? hy : hy) * step;
  const G = g(), inside = (x, y) => x > G.x0 + 20 && x < G.x0 + G.width * G.res - 20 && y < G.y0 - 20 && y > G.y0 - G.height * G.res + 20;
  if (inside(nx, ny)) { S.dist += Math.hypot(nx - S.x, ny - S.y); S.x = nx; S.y = ny; } else S.speed = 0;
  if (!S.running) return;
  // ---- consumables: the engine's physiology, times the hidden truth ----
  S.t += dt;
  const ms = S.departMs + S.t * 1000;
  const hz = S.T.hzGrid.idxOfXY(S.x, S.y);
  const shaded = hz >= 0 && S.env.shadedHz(hz, ms) ? 1 : 0;
  const Te = S.env.envTempK(ms, shaded), sunW = shaded ? 0 : S.env.directBeam(ms);
  const kmh = Math.abs(S.speed) * 3.6;
  let met = rover ? (S.working ? MET.P_WORK_W : MET.P_SEATED_W)
    : kmh > 0.05 ? walkMetabolicW(kmh, S.grade, S.ground) : S.working ? MET.P_WORK_W : MET.P_REST_W;
  met *= T.met * (S.spike && S.t < S.spike.until ? S.spike.x : 1);
  S.metW = met;
  const heat = suitHeat(met, 0, Te, sunW);
  S.used.o2 += (o2KgPerH(met) + SUIT.leakKgPerH + T.leak) / 3600 * dt;
  S.used.co2 += co2KgPerH(met) / 3600 * dt;
  S.used.water += heat.reject / (THERM.LATENT_J_PER_KG * THERM.EVAP_EFFICIENCY) * dt;
  S.used.batt += (SUIT.baseW + heat.heat) * T.batt / 3600 * dt;
  if (rover) S.used.rbatt += Math.max(0, drivePowerW(PROFILES.rover, kmh, S.grade, S.ground) + PROFILES.rover.auxW) / 3600 * dt;
}

function sendTelemetry(wallNow) {
  if (!S.running || wallNow - S.lastSend < 250) return;
  S.lastSend = wallNow;
  const T = truth();
  const eva = tssFrameFromSim({ t: S.t, used: S.used, hw: S.hw, metW: S.metW, hrCal: HR_CAL,
    pos: { x: S.x - S.baseXY[0], y: S.y - S.baseXY[1] }, heading: ((S.profile === "rover" ? S.roverYaw : S.yaw) / DEG + 360) % 360, rand,
    faults: { leak: T.leak >= 0.05, cooling: T.cooling } });
  let rover = null;
  if (S.profile === "rover") {
    const pct = Math.max(0, 100 * (S.hw.roverBattSOH - S.used.rbatt / PROFILES.rover.batteryWh));
    rover = { pr_telemetry: { rover_pos_x: Math.round((S.x - S.baseXY[0]) * 100) / 100, rover_pos_y: Math.round((S.y - S.baseXY[1]) * 100) / 100,
      heading: (S.roverYaw / DEG + 360) % 360, pitch: S.grade, roll: 0, speed: Math.abs(S.speed) * 3.6, distance_traveled: S.dist,
      primary_battery_level: Math.round(pct * 100) / 100, surface_incline: S.grade, oxygen_storage: 100, cabin_pressure: 0, lidar: [] } };
  }
  CH.postMessage({ type: "tss", eva, rover, wallS: S.t });
}

// --------------------------------------------------------------------------------------------------- HUD --
const fmtT = (s) => { s = Math.max(0, Math.round(s)); return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
function hud() {
  const heading = (((S.profile === "rover" ? S.roverYaw : S.yaw) / DEG) % 360 + 360) % 360;
  $("hMet").textContent = fmtT(S.t);
  $("hSpeed").textContent = `${(Math.abs(S.speed) * 3.6).toFixed(1)} km/h`;
  $("hGrade").innerHTML = S.profile !== "rover" && Math.abs(S.grade) > 20 ? `<span class="bad">${S.grade.toFixed(0)}° TOO STEEP</span>` : `${S.grade.toFixed(0)}°`;
  $("hGround").textContent = S.ground;
  $("hHead").textContent = `${String(Math.round(heading) % 360).padStart(3, "0")}°`;
  const rv = S.profile === "rover";
  $("cSteer").hidden = !rv;
  if (rv) {
    const st = Math.round(100 * S.steer);
    $("hSteer").textContent = st === 0 ? "centre" : `${st < 0 ? "◀ L" : "R ▶"} ${Math.abs(st)} %`;
  }
  $("hCam").textContent = S.cam;
  $("ctlHint").innerHTML = rv
    ? "<b>W</b>/<b>S</b> throttle · <b>A</b>/<b>D</b> steer · <b>Space</b> brake · <b>Shift</b> boost · <b>C</b> camera · <b>V</b> look ahead · mouse: look around"
    : "<b>W</b>/<b>S</b> walk · <b>A</b>/<b>D</b> step sideways · mouse: look / turn · <b>Shift</b> hurry · <b>F</b> work · <b>C</b> camera";
  const sn = S.snap;
  const stops = sn?.stops;
  const next = S.stations.find((s) => !(stops || []).find((x) => x.name === s.name && (x.done || x.dropped)));
  if (next) {
    const [x, y] = lonlatToXY(next.lon, next.lat);
    const d = Math.hypot(x - S.x, y - S.y), brg = ((Math.atan2(x - S.x, y - S.y) / DEG) + 360) % 360;
    $("hNext").textContent = `${next.name.split(/[,(]/)[0].trim().slice(0, 16)} ${d < 1000 ? d.toFixed(0) + " m" : (d / 1000).toFixed(2) + " km"} ${String(Math.round(brg) % 360).padStart(3, "0")}°`;
  } else $("hNext").textContent = sn?.returning ? "HABITAT (returning)" : "HABITAT";
  if (sn) {
    $("hBack").textContent = Number.isFinite(sn.back?.t) ? fmtT(sn.back.t).slice(0, 5) : Number.isFinite(sn.back) ? fmtT(sn.back).slice(0, 5) : "--";
    const m = sn.margins ? Math.min(...["o2", "co2", "water", "batt"].map((k) => sn.margins[k] ?? 1)) : null;
    $("hMargin").innerHTML = m == null ? "--" : `<span class="${m < 0.1 ? "bad" : m < 0.25 ? "warn" : "ok"}">${(100 * m).toFixed(0)} %</span>`;
    const xt = sn.loop?.crossTrack;
    $("hXt").innerHTML = Number.isFinite(xt) ? `<span class="${xt > 40 ? "warn" : ""}">${xt.toFixed(0)} m</span>` : "--";
    const al = (sn.alerts || []).filter((a) => !a.acked).slice(0, 3);
    $("alertsBox").style.display = al.length ? "block" : "none";
    $("alertsBox").innerHTML = al.map((a) => `<div class="${a.level === 3 ? "W" : a.level === 2 ? "C" : "A"}">${{ 3: "WARNING", 2: "CAUTION", 1: "ADVISORY" }[a.level] ?? ""} · ${a.text}</div>`).join("");
  }
  // true consumables (what the suit really has left), against the planner's walk-home need when it sends one
  const T = truth();
  const rows = [["O₂", 1 - S.used.o2 / (SUIT.o2Kg * S.hw.o2Fill)], ["Battery", 1 - S.used.batt / (SUIT.batteryWh * S.hw.battSOH)],
    ["Cooling H₂O", 1 - S.used.water / (SUIT.waterKg * S.hw.waterFill)], ["CO₂ scrub", 1 - S.used.co2 / SUIT.co2CapKg]];
  if (S.profile === "rover") rows.push(["Rover batt", 1 - S.used.rbatt / (PROFILES.rover.batteryWh * S.hw.roverBattSOH)]);
  $("cons").innerHTML = `<div class="lbl" style="margin-top:6px">Suit (truth) · metabolic ${S.metW.toFixed(0)} W${T.met !== 1 ? ` (×${T.met.toFixed(2)})` : ""}</div>` +
    rows.map(([n, f]) => `<div class="bar"><span>${n}</span><span class="track"><span class="fill" style="width:${Math.max(0, Math.min(100, 100 * f)).toFixed(1)}%"></span></span><span class="num">${(100 * Math.max(0, f)).toFixed(0)} %</span></div>`).join("");
}

function minimap() {
  const c = $("mini").getContext("2d"), Wd = 240, R = [600, 2500, 9000][S.miniZoom];
  c.clearRect(0, 0, Wd, Wd);
  const px = (x, y) => [Wd / 2 + (x - S.x) / R * Wd / 2, Wd / 2 - (y - S.y) / R * Wd / 2];
  const line = (ll, col, w, dash = []) => {
    if (!ll || ll.length < 2) return;
    c.beginPath(); c.setLineDash(dash);
    ll.forEach(([lo, la], i) => { const [x, y] = lonlatToXY(lo, la); const [a, b] = px(x, y); i ? c.lineTo(a, b) : c.moveTo(a, b); });
    c.strokeStyle = col; c.lineWidth = w; c.stroke(); c.setLineDash([]);
  };
  line(S.route, "rgba(242,245,248,0.9)", 2);
  line(S.live, "#3cc8ff", 2, [6, 3]);
  line(S.ret, "#ff7470", 2, [5, 4]);
  line(S.snap?.track, "rgba(62,224,126,0.9)", 1.5);
  S.stations.forEach((s, k) => { const [x, y] = lonlatToXY(s.lon, s.lat); const [a, b] = px(x, y); c.fillStyle = "#ffc629"; c.beginPath(); c.arc(a, b, 4, 0, 7); c.fill(); c.fillStyle = "#0b0f14"; c.font = "9px monospace"; c.fillText(String(k + 1), a - 3, b + 3); });
  if (S.base) { const [a, b] = px(...S.baseXY); c.fillStyle = "#f2f5f8"; c.fillRect(a - 4, b - 4, 8, 8); }
  if (S.snap?.est && Number.isFinite(S.snap.est[0])) {
    // where the planner thinks you are, and how sure it is (2 sigma)
    const [ex, ey] = S.snap.est, [a, b] = px(ex, ey);
    c.strokeStyle = "rgba(201,160,255,0.9)"; c.beginPath(); c.arc(a, b, Math.max(3, 2 * (S.snap.sigma || 5) / R * Wd / 2), 0, 7); c.stroke();
  }
  const hd = S.profile === "rover" ? S.roverYaw : S.yaw;
  c.save(); c.translate(Wd / 2, Wd / 2); c.rotate(hd);
  c.fillStyle = "#3ee07e"; c.beginPath(); c.moveTo(0, -8); c.lineTo(5, 6); c.lineTo(-5, 6); c.closePath(); c.fill(); c.restore();
  c.fillStyle = "#9aa6b2"; c.font = "10px monospace"; c.fillText(`${R >= 1000 ? R / 1000 + " km" : R + " m"} · N↑ · M zoom`, 6, 234);
}

// ------------------------------------------------------------------------------------------ rover, camera --
const roverMesh = (() => {
  const grp = new THREE.Group();
  const M = (c) => curved(new THREE.MeshLambertMaterial({ color: c }));
  const add = (geo, color, x, y, z) => { const m = new THREE.Mesh(geo, M(color)); m.position.set(x, y, z); grp.add(m); return m; };
  add(new THREE.BoxGeometry(2.1, 0.26, 3.3), 0xd6d9dd, 0, 0.82, 0);              // chassis deck (forward = -z)
  add(new THREE.BoxGeometry(1.9, 0.2, 0.45), 0xc4552f, 0, 0.98, -1.5);           // front bumper, orange: shows the nose
  add(new THREE.BoxGeometry(1.9, 0.5, 0.5), 0x8b939c, 0, 1.1, 1.35);            // rear equipment box
  for (const sx of [-0.45, 0.45]) add(new THREE.BoxGeometry(0.6, 0.5, 0.6), 0x3a4048, sx, 1.2, 0.3);   // two seats
  add(new THREE.CylinderGeometry(0.035, 0.035, 1.5, 8), 0x9aa6b2, 0.8, 1.9, 1.35);                       // comms mast
  const dish = add(new THREE.CylinderGeometry(0.42, 0.42, 0.04, 20), 0xf2f5f8, 0.8, 2.7, 1.35);
  dish.rotation.x = 0.5;
  const wg = new THREE.CylinderGeometry(0.42, 0.42, 0.28, 18);
  wg.rotateZ(Math.PI / 2);
  grp.userData.wheels = [[-1.15, -1.15], [1.15, -1.15], [-1.15, 1.15], [1.15, 1.15]].map(([x, z]) => add(wg, 0x2b2f35, x, 0.42, z));
  grp.rotation.order = "YXZ";
  grp.visible = false;
  scene.add(grp);
  return grp;
})();
function placeRover(z) {
  const hx = Math.sin(S.roverYaw), hy = Math.cos(S.roverYaw);
  const zf = elevAt(S.x + hx * 1.6, S.y + hy * 1.6), zb = elevAt(S.x - hx * 1.6, S.y - hy * 1.6);
  const zr = elevAt(S.x + hy * 1.15, S.y - hx * 1.15), zl = elevAt(S.x - hy * 1.15, S.y + hx * 1.15);
  roverMesh.position.copy(W(S.x, S.y, Math.max(z, (zf + zb) / 2)));
  roverMesh.rotation.set(Math.atan((zf - zb) / 3.2), -S.roverYaw, Math.atan((zr - zl) / 2.3));
  for (const w of roverMesh.userData.wheels) w.rotation.x = -(S.wheel || 0) / 0.42;
}
function placeCamera(dtWall) {
  const rover = S.profile === "rover";
  const z = elevAt(S.x, S.y);
  const yaw = rover ? S.roverYaw + S.yaw : S.yaw;
  const fx = Math.sin(yaw), fz = -Math.cos(yaw);                 // the view's forward direction in the world
  roverMesh.visible = rover;
  if (rover) placeRover(z);
  camera.up.set(0, 1, 0);
  let p, look;
  if (S.cam === "top") {
    const base = W(S.x, S.y, z);
    p = new THREE.Vector3(base.x, base.y + (rover ? 90 : 60), base.z);
    camera.up.set(fx, 0, fz);                                   // heading up
    look = base;
  } else if (S.cam === "chase" && rover) {
    const base = W(S.x, S.y, z + 1.6);
    const bx = S.x - Math.sin(yaw) * 11, by = S.y - Math.cos(yaw) * 11;
    const want = new THREE.Vector3(base.x - fx * 11, Math.max(base.y + 4.2, elevAt(bx, by) - S.zRef + 2), base.z - fz * 11);
    if (!S.camPos) S.camPos = want.clone();
    else S.camPos.lerp(want, 1 - Math.exp(-dtWall / 0.15));
    p = S.camPos.clone();
    look = new THREE.Vector3(base.x + fx * 5, base.y + Math.sin(S.pitch + 0.05) * 6, base.z + fz * 5);
  } else {
    p = W(S.x, S.y, z + (rover ? 2.25 : 1.8));
    if (rover) { p.x += Math.sin(S.roverYaw) * 0.25; p.z -= Math.cos(S.roverYaw) * 0.25; }   // the driver's seat
    look = new THREE.Vector3(p.x + fx * Math.cos(S.pitch), p.y + Math.sin(S.pitch), p.z + fz * Math.cos(S.pitch));
  }
  camera.position.copy(p);
  CAM.value.copy(p);
  camera.lookAt(look);
  return p;
}

// ---------------------------------------------------------------------------------------------- main loop --
let last = performance.now(), lodTimer = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dtWall = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!S.T) { renderer.render(scene, camera); return; }
  stepPlayer(dtWall);
  sendTelemetry(now);
  lodTimer += dtWall;
  if (lodTimer > 0.5) { lodTimer = 0; planChunks(); }
  pumpChunks();
  const p = placeCamera(dtWall);
  const ms = S.departMs + S.t * 1000, s = S.env.sun(ms);
  const el = Math.max(1, s.elevation) * DEG, az = s.azimuth * DEG;
  sun.position.set(p.x + Math.sin(az) * Math.cos(el) * 1000, p.y + Math.sin(el) * 1000, p.z - Math.cos(az) * Math.cos(el) * 1000);
  sun.target.position.copy(p);
  sun.intensity = s.elevation > 0 ? 1.7 : 0.15;
  renderer.render(scene, camera);
  hud();
  minimap();
}
requestAnimationFrame(frame);

// ------------------------------------------------------------------------ live consumables / sudden events --
// Change the truth now, mid-EVA, and watch the closed loop in the main window notice it from telemetry alone and react
// (re-plan, drop stations, order a return, raise cautions). Each injection starts a stopwatch; every reaction the planner
// sends back is logged with how long (mission time) it took.
const capOf = {
  o2: () => SUIT.o2Kg * S.hw.o2Fill, batt: () => SUIT.batteryWh * S.hw.battSOH, water: () => SUIT.waterKg * S.hw.waterFill,
  rbatt: () => PROFILES.rover.batteryWh * S.hw.roverBattSOH,
};
const remainPct = (k) => 100 * Math.max(0, 1 - S.used[k] / capOf[k]());
function setRemain(k, pct) { S.used[k] = capOf[k]() * (1 - Math.max(1, Math.min(100, pct)) / 100); }
function react(html) {
  const d = document.createElement("div");
  d.innerHTML = html;
  $("react").prepend(d);
  while ($("react").children.length > 14) $("react").lastChild.remove();
}
function inject(kind) {
  if (!S.running) { $("status").innerHTML = '<span class="bad">Start the EVA first: sudden events act on a running EVA.</span>'; return; }
  const sev = +$("sev").value, pc = `${Math.round(sev * 100)} %`;
  const lose = (k) => { S.used[k] = Math.min(capOf[k]() * 0.98, S.used[k] + sev * capOf[k]()); };
  let label;
  switch (kind) {
    case "o2": lose("o2"); label = `O₂ tank loss: −${pc} of capacity (now ${remainPct("o2").toFixed(0)} %)`; break;
    case "batt": lose("batt"); label = `Suit battery cell failure: −${pc} (now ${remainPct("batt").toFixed(0)} %)`; break;
    case "water": lose("water"); label = `Coolant leak: −${pc} of cooling water (now ${remainPct("water").toFixed(0)} %)`; break;
    case "rbatt": lose("rbatt"); label = `Rover battery fault: −${pc} (now ${remainPct("rbatt").toFixed(0)} %)`; break;
    case "scrub": S.hw.scrubCap = Math.max(0.1, S.hw.scrubCap * (1 - sev)); label = `CO₂ scrubber degraded: capacity −${pc}`; break;
    case "spike": S.spike = { x: 1 + sev * 1.7, until: S.t + 30 * 60 }; label = `Exertion spike: work rate ×${S.spike.x.toFixed(2)} for 30 min`; break;
    case "leak": $("leak").value = Math.min(0.2, 0.04 + sev * 0.25).toFixed(3); $("leak").dispatchEvent(new Event("input")); label = `Suit O₂ leak starts: ${(+$("leak").value).toFixed(3)} kg/h`; break;
    case "clear": S.spike = null; $("leak").value = 0; $("leak").dispatchEvent(new Event("input")); $("fCool").checked = false; S.hw.scrubCap = 1; label = "Faults cleared (leak, scrubber, exertion spike)"; break;
    default: return;
  }
  const sn = S.snap || {};
  S.pending = { label, t: S.t, pv: sn.loop?.planVersion ?? 1, ret: !!sn.returning, alerts: new Set((sn.alerts || []).map((a) => a.text)), n: 0 };
  react(`<b class="warn">⚡ ${fmtT(S.t).slice(0, 5)} you:</b> ${label}`);
}
function watchReaction(sn) {
  const P = S.pending;
  if (!P) return;
  const dt = `${Math.max(0, (sn.t ?? S.t) - P.t).toFixed(0)} s later`;
  for (const a of sn.alerts || []) {
    if (a.level >= 2 && !P.alerts.has(a.text)) { P.alerts.add(a.text); P.n++; react(`<span class="${a.level === 3 ? "bad" : "warn"}">⚠ ${a.level === 3 ? "WARNING" : "CAUTION"}</span> ${a.text} <span class="note">(${dt})</span>`); }
  }
  const pv = sn.loop?.planVersion ?? P.pv;
  if (pv > P.pv) {
    P.pv = pv; P.n++;
    const r = sn.loop?.lastReplan;
    react(`<span class="ok">↻ Planner re-planned (plan v${pv})</span>${r ? `: ${r.reason}${r.dropped?.length ? `; dropped ${r.dropped.map((d) => d.split(",")[0]).join(", ")}` : ""}` : ""} <span class="note">(${dt})</span>`);
  }
  if (sn.returning && !P.ret) { P.ret = true; P.n++; react(`<span class="bad">⟲ Planner ordered a RETURN to the habitat</span> <span class="note">(${dt})</span>`); }
  if ((sn.t ?? S.t) - P.t > 1800 && !P.n) { react(`<span class="ok">✓ No change needed: margins still hold after “${P.label.split(":")[0]}”</span>`); S.pending = null; }
  if ((sn.t ?? S.t) - P.t > 3600) S.pending = null;
}
for (const b of document.querySelectorAll("[data-inject]")) b.addEventListener("click", () => inject(b.dataset.inject));
for (const k of ["o2", "batt", "water", "rbatt"]) {
  const el = $(`now_${k}`);
  el.addEventListener("input", () => { $(`vNow_${k}`).textContent = el.value; });
  el.addEventListener("change", () => {
    if (!S.running) return;
    const before = remainPct(k);
    setRemain(k, +el.value);
    const names = { o2: "O₂", batt: "Suit battery", water: "Cooling water", rbatt: "Rover battery" };
    const sn = S.snap || {};
    S.pending = { label: `${names[k]} set ${before.toFixed(0)} % → ${el.value} %`, t: S.t, pv: sn.loop?.planVersion ?? 1, ret: !!sn.returning, alerts: new Set((sn.alerts || []).map((a) => a.text)), n: 0 };
    react(`<b class="warn">⚡ ${fmtT(S.t).slice(0, 5)} you:</b> ${S.pending.label}`);
  });
}
setInterval(() => {   // keep the "remaining now" sliders showing the truth, except the one being dragged
  for (const k of ["o2", "batt", "water", "rbatt"]) {
    const el = $(`now_${k}`);
    if (document.activeElement === el) continue;
    const v = Math.round(remainPct(k));
    el.value = v; $(`vNow_${k}`).textContent = v;
  }
  $("rowRbatt").hidden = S.profile !== "rover";
}, 700);

// ----------------------------------------------------------------------------------- main-window protocol --
async function init(msg) {
  const sameSite = S.data === msg.data && S.T;
  const prevProfile = S.profile, h0 = viewHeading();
  S.profile = msg.profile || "foot";
  if (prevProfile !== S.profile) {
    setHeading(h0);
    S.cam = S.profile === "rover" ? "cockpit" : "eyes";
    S.camPos = null; S.steer = 0;
  }
  $("mode").value = S.profile;
  S.departMs = msg.departMs ?? Date.now();
  S.hw = { ...S.hw, ...(msg.hw || {}) };
  for (const [id, k, v] of [["o2Fill", "vO2", S.hw.o2Fill], ["battSOH", "vBh", S.hw.battSOH], ["waterFill", "vW", S.hw.waterFill], ["roverSOH", "vRb", S.hw.roverBattSOH]]) {
    $(id).value = Math.round(100 * v); $(k).textContent = Math.round(100 * v);
  }
  if (!sameSite) {
    $("status").textContent = "Loading the site's terrain…";
    S.data = msg.data;
    S.T = await loadTerrain(browserIO(msg.data));
    const clim = await fetch(new URL("environment.json", msg.data)).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    S.env = new Environment(S.T, clim, { tau: msg.tau });
    S.imagery = await fetch(new URL("imagery.json", msg.data)).then((r) => r.json()).catch(() => null);
    S.ortho = S.imagery?.ortho5 ? await img(new URL(S.imagery.ortho5.file, msg.data).href) : null;
    for (const m of chunks.values()) disposeMesh(m);
    chunks.clear();
  }
  if (msg.tau != null && S.env) S.env.tau = msg.tau;
  S.base = msg.base;
  S.baseXY = lonlatToXY(msg.base.lon, msg.base.lat);
  S.zRef = S.T.get("elev_dm", Math.max(0, g().idxOfXY(...S.baseXY)));
  if (!Number.isFinite(S.zRef)) S.zRef = -2500;
  S.route = msg.route || [];
  S.stations = msg.stations || [];
  S.live = null; S.ret = null;
  // chunks are built relative to the habitat: rebuild everything when it moves
  for (const m of chunks.values()) disposeMesh(m);
  chunks.clear();
  setRibbon("plan", S.route, 0xf2f5f8, S.profile === "rover" ? 3 : 1.4);
  setRibbon("live", null); setRibbon("ret", null);
  buildMarkers();
  if (!S.running) toHab();
  planChunks();
  document.title = `MarsNav · Drive · ${msg.siteName ?? ""}`;
  $("status").innerHTML = S.route.length > 1
    ? `${msg.siteName ?? "Site"} · ${S.profile === "rover" ? "rover" : "suited walk"} · route of ${S.stations.length} station(s) loaded. Press <b>Start EVA</b>, then walk it — or don't, and watch the planner react.`
    : '<span class="warn">No feasible route in the main window yet: plan one there. You can still explore.</span>';
}

CH.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === "init") await init(m);
    else if (m.type === "snap") {
      S.snap = m.snap;
      watchReaction(m.snap);
      if (m.snap.livePlan && JSON.stringify(m.snap.livePlan.slice(0, 3)) !== JSON.stringify(S.live?.slice(0, 3))) {
        S.live = m.snap.livePlan;
        setRibbon("live", S.live, 0x3cc8ff, S.profile === "rover" ? 3.2 : 1.6);
      }
      if (m.snap.returnPts && !S.ret) { S.ret = m.snap.returnPts; setRibbon("ret", S.ret, 0xff7470, 2); }
      const ev2 = (m.snap.events || []).slice(-6).reverse();
      $("events").innerHTML = ev2.map((e) => `<div>${fmtT(e.t).slice(0, 5)} ${e.event}</div>`).join("");
      if (m.snap.done) { S.running = false; $("status").innerHTML = '<span class="ok">EVA complete. Press Restart EVA to fly again.</span>'; }
    } else if (m.type === "stopped") { S.running = false; $("status").textContent = "The main window stopped the EVA."; }
  } catch (e) {
    console.error(e);
    $("status").innerHTML = `<span class="bad">${e.message}</span>`;
  }
};
// announce ourselves until the main window answers
const hello = () => { if (!S.T) { CH.postMessage({ type: "hello" }); setTimeout(hello, 2000); } };
hello();
setTimeout(() => { if (!S.T) $("status").innerHTML = '<span class="warn">No main MarsNav window answered. Open this window from MarsNav (Execute → Open 3D drive window).</span>'; }, 6000);
