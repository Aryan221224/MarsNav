// main.js - the MarsNav console: Plan, Execute and Review on one data model (research doc 17).
import { MapView } from "./map.js";
import { Timeline } from "./timeline.js";
import { ahp, L1_IDS, L1_NAMES, L1_MATRIX, L1_REASONS } from "../engine/ahp.js";
import { marsContext, missionClock, M2020_CLOCK, fmtHours, earthMarsLight } from "../engine/marstime.js";
import { setProjection, lonlatToXY } from "../engine/geo.js";
import { View3D } from "./view3d.js";
import { fmtDuration } from "../engine/util.js";
import { speak, tone, primeAudio } from "./speech.js";
import { TASK_PRESETS } from "../engine/task.js";

const $ = (id) => document.getElementById(id);
const DATA_ROOT = new URL("../data/", import.meta.url).href;
let DATA = DATA_ROOT;
const IN_FRAME = (() => { try { return window.top !== window.self; } catch { return true; } })();

// ------------------------------------------------------------------------------------------------ worker RPC --
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
let seq = 0;
const pending = new Map();
worker.onmessage = (e) => {
  const { id, ok, result, error } = e.data;
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  ok ? p.resolve(result) : p.reject(new Error(error));
};
worker.onerror = (e) => showError(`Engine failed to start: ${e.message || e}`);
const call = (type, args = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  worker.postMessage({ id, type, ...args });
});

// ----------------------------------------------------------------------------------------------------- state --
const state = {
  meta: null, map: null, tl: null, mode: "plan", stations: [], routes: null, selected: "balanced", cfg: null,
  setup: null, addMode: false, overlay: "hazard", l1Upper: {}, sim: null, simTimer: null, lastSpoken: new Set(),
};

function showError(msg) {
  $("busy").hidden = false;
  $("busy").textContent = msg;
}

const busy = (on, text = "Computing…") => {
  $("busy").hidden = !on;
  if (on) $("busy").textContent = text;
};

// ------------------------------------------------------------------------------------------------------ boot --
// site selection: data/sites.json lists every built site; "#<site id>" in the address picks one
async function pickSite() {
  let sites = [];
  try { sites = await (await fetch(new URL("sites.json", DATA_ROOT))).json(); } catch { /* single-site build */ }
  const want = decodeURIComponent(location.hash.slice(1));
  const site = sites.find((x) => x.id === want) ?? sites[0] ?? null;
  if (site) DATA = new URL(site.path, DATA_ROOT).href;
  const sel = $("siteSel");
  sel.innerHTML = sites.map((x) => `<option value="${x.id}"${x === site ? " selected" : ""}>${x.short}</option>`).join("");
  sel.closest("label").hidden = sites.length < 2;
  sel.onchange = () => { location.hash = sel.value; location.reload(); };
  // sites created in Landing mode ("g_...") can be deleted; the shipped Jezero sites cannot
  const del = $("btnDelSite");
  del.hidden = !(site && /^g_/.test(site.id));
  del.onclick = async () => {
    if (!confirm(`Delete the site "${site.short || site.name}"?\n\nIts built data and downloaded elevation files are removed from this computer. The Jezero sites are not affected.`)) return;
    del.disabled = true;
    try {
      const r = await fetch("/api/site/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: site.id }) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      location.hash = "jezero";
      location.reload();
    } catch (e) {
      del.disabled = false;
      alert(`Could not delete the site: ${e.message}`);
    }
  };
  return site;
}

async function boot() {
  try {
    await pickSite();
    const meta = await call("init", { base: DATA });
    state.meta = meta;
    if (meta.projection?.lat_ts != null) setProjection(meta.projection.lat_ts, meta.projection.clon ?? 0);
    state.site = meta.site;
    state.clock = meta.site.clock ? missionClock(meta.site.clock) : M2020_CLOCK;
    $("siteName").textContent = meta.site.short ?? meta.site.name;
    $("ckSolLbl").textContent = `${state.clock.name} sol`;
    state.map = new MapView($("map"), meta.grid, meta.imagery, DATA);
    state.tl = new Timeline($("tl"));
    state.map.targets = meta.targets;
    state.map.keepouts = meta.keepouts;
    state.map.landmarks = meta.landmarks;
    state.map.traverse = meta.traverse?.path ?? null;
    const hab = meta.site.base ?? meta.targets.find((t) => t.id === "HAB");
    state.base = { lon: hab.lon, lat: hab.lat, name: hab.name ?? "Habitat" };
    state.siteBase = { ...state.base };
    // a habitat placed by a flown landing on this site (per-viewer convenience; the site's own base is the default)
    try {
      const saved = JSON.parse(localStorage.getItem(`mm-hub-${meta.site.id}`) || "null");
      if (saved && T_inside(meta.grid, saved.lon, saved.lat)) state.base = saved;
    } catch { /* storage unavailable */ }
    state.map.habitat = state.base;
    // default demonstration sortie: at Jezero a geology EVA to Amalik on the delta front, where Perseverance cored
    // "Mageik"; at any other site the first science or survey station
    const dist = (t) => Math.hypot((t.lon - state.base.lon) * Math.cos(state.base.lat * Math.PI / 180), t.lat - state.base.lat);
    const first = meta.targets.find((t) => t.id === "AMAL") ??
      meta.targets.filter((t) => t.kind === "science").sort((a, b) => dist(a) - dist(b))[0];
    if (first) addStation(first);
    buildTargets();
    buildAHP();
    bindUI();
    wireMap();
    const now = state.clock.solFromMs(Date.now());
    $("departSol").value = now.sol + 1;
    tickClock();
    setInterval(tickClock, 1000);
    flashClock();
    fillProvenance();
    loadSpaceWeather();
    setInterval(loadSpaceWeather, 30 * 60 * 1000);
    $("ckSwxBox").addEventListener("click", showSpaceWeather);
    for (const b of document.querySelectorAll("[data-display]")) b.addEventListener("click", () => openDisplay(b.dataset.display));
    if ("BroadcastChannel" in window) hudChannel();       // a display opened earlier (or reloaded) finds us
    const landers = await call("landers");
    $("landerSel").innerHTML = landers.map((l) => `<option value="${l.id}"${l.id === "m2020" ? " selected" : ""} title="${l.src}">${l.label}${l.trn ? " · TRN" : ""}</option>`).join("");
    const truths = await call("truths");
    $("truthSel").innerHTML = truths.map((t) => `<option value="${t.id}">${t.label}</option>`).join("");
    $("demoTruth").innerHTML = truths.map((t) => `<option value="${t.id}"${t.id === "hardwork" ? " selected" : ""}>${t.label}</option>`).join("");
    await runSetup();
    await runPlan();
    busy(false);
    state.map.fitLonLat([[state.base.lon, state.base.lat], ...state.stations.map((s) => [s.lon, s.lat])], 90);
    if ("BroadcastChannel" in window) driveChannel();   // a drive window opened earlier (or reloaded) finds us
  } catch (err) {
    console.error(err);
    showError(`Could not start: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------------------------------- clocks --
// space weather at Mars (planet/spaceweather.py, NASA DONKI) when the MarsNav server is there; a static copy of the
// planner has no server and simply does not show it
async function loadSpaceWeather() {
  let w;
  try {
    const r = await fetch("/api/spaceweather");
    if (!r.ok) return;
    w = await r.json();
  } catch { return; }
  state.swx = w;
  const word = { quiet: "QUIET", watch: "WATCH", storm: "STORM" }[w.level] ?? "NO DATA";
  $("ckSwx").textContent = word;
  $("ckSwx").className = `v ${w.level === "storm" ? "bad" : w.level === "watch" ? "warn" : w.level === "quiet" ? "ok" : ""}`;
  $("ckSwxBox").hidden = false;
  $("ckSwxBox").title = `${w.headline}. ${(w.reasons || []).join(". ")}${w.action ? `. ${w.action}` : ""}`;
  if (state.routes) renderCards();
}

function showSpaceWeather() {
  const w = state.swx;
  if (!w) return;
  const g = w.geometry || {};
  $("modalTitle").textContent = "Space weather at Mars";
  $("modalBody").innerHTML = `<p><b class="${w.level === "storm" ? "bad" : w.level === "watch" ? "warn" : "ok"}">${w.headline}</b></p>
    <ul>${(w.reasons || []).map((x) => `<li>${x}</li>`).join("")}</ul>${w.action ? `<p><b>For this EVA:</b> ${w.action}</p>` : ""}
    <p class="note">Mars is ${g.separation_deg ?? "?"}° from Earth as seen from the Sun, ${g.light_min ?? "?"} light-minutes away. ${g.note ?? ""}</p>
    <p class="note">${w.fetched_utc ? `NASA DONKI data fetched ${w.fetched_utc} (${w.age_h} h ago).` : "No DONKI data on this computer yet."} ${w.basis ?? ""}
    The full list of CME arrivals, particle events and flares is in Landing mode (SPACE WX).</p>
    <p class="note">To rehearse the response, Execute has a "Solar particle event" fault.</p>`;
  $("modal").hidden = false;
}

function tickClock() {
  const now = Date.now();
  const ctx = marsContext(now, state.base.lon, state.base.lat, state.clock);
  $("ckUtc").textContent = new Date(now).toISOString().slice(11, 19);
  $("ckSol").textContent = String(ctx.sol);
  $("ckLmst").textContent = fmtHours(ctx.lmst);
  $("ckLs").textContent = `${ctx.Ls.toFixed(1)}°`;
  $("ckSun").textContent = `${ctx.sun.elevation >= 0 ? "+" : ""}${ctx.sun.elevation.toFixed(1)}°`;
  const lt = earthMarsLight(now).lightS;
  $("ckLight").textContent = `${Math.floor(lt / 60)}m ${String(Math.round(lt % 60)).padStart(2, "0")}s`;
}

// synchronised flashing: one clock for all elements (NASA-STD-3001 F.5.11 as summarised in doc 17)
function flashClock() {
  const root = document.documentElement;
  const phase = (t, hz, duty) => t % (1000 / hz) < (1000 / hz) * duty;
  const tick = (now) => {
    root.dataset.flashLow = phase(now, 0.8, 0.7) ? "on" : "off";
    root.dataset.flashHigh = phase(now, 3.0, 0.5) ? "on" : "off";
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------------------------------- set-up --
function readCfg() {
  const sol = parseInt($("departSol").value, 10);
  const [hh, mm] = ($("departLmst").value || "09:00").split(":").map(Number);
  const risk = $("risk").value;
  return {
    profile: $("profile").value,
    departMs: state.clock.msFromSol(sol, (hh || 0) + (mm || 0) / 60),
    evaMaxH: Math.max(1, Math.min(8, parseFloat($("evaMax").value) || 7)),
    reserveFrac: Math.max(0.05, Math.min(0.4, (parseFloat($("reserve").value) || 15) / 100)),
    risk: { kind: risk, alpha: 0.9, lambda: 1 },
    tau: parseFloat($("tau").value),
    nav: $("nav").value,
    rescue: $("rescue").checked,
    base: state.base,
    userNoGo: [],
    mastM: 10,
    hw: { o2Fill: pctIn("hwO2"), battSOH: pctIn("hwBatt"), waterFill: pctIn("hwWater"), scrubCap: pctIn("hwScrub"), roverBattSOH: pctIn("hwRBatt"),
      wheelWear: Math.max(0, Math.min(1, (parseFloat($("hwWear").value) || 0) / 100)) },
    cal: { met: numIn("calMet", 1, 0.5, 2), speed: numIn("calSpeed", 1, 0.5, 1.5), water: state.carry?.water ?? 1, batt: 1, co2: state.carry?.co2 ?? 1 },
  };
}
const pctIn = (id) => Math.max(0.1, Math.min(1, (parseFloat($(id).value) || 100) / 100));
const numIn = (id, d, lo, hi) => Math.max(lo, Math.min(hi, parseFloat($(id).value) || d));

async function runSetup() {
  busy(true, "Building hazard model…");
  state.cfg = readCfg();
  state.setup = await call("setup", { cfg: state.cfg });
  const s = state.setup;
  const ctx = s.ctx;
  $("rescueRow").hidden = state.cfg.profile !== "rover";
  $("hwRoverRow").hidden = state.cfg.profile !== "rover";
  $("setupNote").innerHTML = `Habitat: ${state.base.name}. Depart ${ctx.sol >= 0 ? `${ctx.clockName} sol ${ctx.sol}` : ""} LMST ${fmtHours(ctx.lmst).slice(0, 5)}
    (UTC ${new Date(state.cfg.departMs).toISOString().slice(0, 16).replace("T", " ")}), Ls ${ctx.Ls.toFixed(0)}°, sun ${ctx.sun.elevation.toFixed(0)}°.
    Time budget <span class="num">${fmtDuration(s.timeEndS)}</span> (max EVA or sunset minus 30 min).
    <br>Suit cooling: site pressure ${(s.pNow.pa / 100).toFixed(2)} hPa (${s.pNow.torr.toFixed(1)} Torr) now, at most
    ${(s.pEnv.pMaxPa / 100).toFixed(2)} hPa over a Mars year in this area; limit ${(s.pEnv.limitPa / 100).toFixed(1)} hPa (7.5 Torr):
    <span class="${s.pEnv.coolingOK ? "ok" : "bad"}">${s.pEnv.coolingOK ? "OK" : "EXCEEDED - evaporative cooling not assured"}</span>.`;
  const veto = await call("overlay", { name: "veto" });
  state.map.setVeto(veto);
  await refreshOverlay();
  busy(false);
}

async function refreshOverlay(opts = {}) {
  const name = state.overlay;
  if (name === "none") { state.map.setOverlay(null); $("legend").hidden = true; return; }
  const ov = await call("overlay", { name, opts: { ms: state.cfg.departMs, ...opts } });
  state.map.setOverlay(ov);
  showLegend(ov.legend);
}

function showLegend(lg) {
  const el = $("legend");
  if (!lg) { el.hidden = true; return; }
  el.hidden = false;
  const grad = { haz: "linear-gradient(90deg, rgba(110,80,255,.4), rgba(190,80,255,.7), rgba(255,80,216,.9), #fff)",
    seq: "linear-gradient(90deg, rgba(90,110,255,.5), rgba(200,90,255,.8), #fff)" };
  const badge = lg.prov ? `<div class="prov"><span class="pb ${lg.prov[0].toLowerCase()}">${lg.prov[0]}</span> ${lg.prov[1]}</div>` : "";
  el.innerHTML = (lg.kind === "ramp"
    ? `<div>${lg.text}</div><div class="bar" style="background:${grad[lg.pal]}"></div><div class="row" style="justify-content:space-between"><span class="num">${lg.lo}</span><span class="num">${lg.hi}</span></div>`
    : `<div>${lg.text}</div>`) + badge;
}

// -------------------------------------------------------------------------------------------------- stations --
function addStation(t) {
  if (!t) return;
  if (state.stations.some((x) => (x.id ?? x.name) === (t.id ?? t.name))) return; // already on the list
  state.stations.push({ id: t.id || `P${Date.now().toString(36)}`, name: t.name, lon: t.lon, lat: t.lat, dwell_min: t.dwell_min ?? 30, kind: t.kind ?? "survey",
    value: t.value ?? 0.3, task: t.kind === "science" ? "sampling" : "survey", toolWh: 0, extraO2g: 0, extraWaterG: 0 });
  renderStations();
}

function T_inside(g, lon, lat) { const [r, c] = rcOfLonLatGrid(g, lon, lat); return r >= 0 && c >= 0 && r < g.height && c < g.width; }

// --------------------------------------------------------------------------------------------------- landing --
state.landing = null;
const pct = (v) => `${(100 * v).toFixed(v < 0.1 && v > 0 ? 1 : 0)} %`;

function renderLanding() {
  const L = state.landing?.result;
  const box = $("landOut");
  if (!L) return;
  const td = state.landing.touchdown;
  const chk = (L.checks || []).map((c) => `<div class="chk"><span class="${c.ok === true ? "ok" : c.ok === false ? "bad" : "dim"}">${c.ok === true ? "✓" : c.ok === false ? "✗" : "?"}</span> ${c.label}: <span class="num">${c.value}</span></div>`).join("");
  const hub = (state.landing.hub || L.hub || []).map((h) => `<div class="chk">${h.label}: <span class="num">±${h.sigmaM < 2 ? h.sigmaM.toFixed(2) : Math.round(2 * h.sigmaM)} m</span></div>`).join("");
  box.innerHTML = `<div><b>${L.label}</b> · ellipse ${(L.majorM / 1000).toFixed(L.majorM < 1000 ? 2 : 1)} × ${(L.minorM / 1000).toFixed(L.minorM < 1000 ? 2 : 1)} km${L.trn ? " · TRN divert to safe targets" : ""}</div>
    <div>Probability of a safe landing: <span class="num ${L.pSafe > 0.9 ? "ok" : L.pSafe > 0.7 ? "warn" : "bad"}">${pct(L.pSafe)}</span>
      · unverified ground <span class="num">${pct(L.pUnverified)}</span> · unsafe <span class="num">${pct(L.pUnsafe)}</span>${L.pOutside > 0.001 ? ` · outside the mapped area <span class="num">${pct(L.pOutside)}</span>` : ""}</div>
    <details open><summary class="lbl">Engineering constraints</summary>${chk}</details>
    ${td ? `<div style="margin-top:6px">Touchdown: <span class="num">${td.lat.toFixed(5)}°N ${td.lon.toFixed(5)}°E</span> on
      <span class="${td.cls === 1 ? "ok" : td.cls === 2 ? "warn" : "bad"}">${td.cls === 1 ? "safe ground" : td.cls === 2 ? "unverified ground" : td.cls === 0 ? "UNSAFE ground (in a real landing: a lost or damaged lander)" : "outside the mapped area"}</span></div>
      <details open><summary class="lbl">Pinpointing the hub after landing</summary>${hub}</details>
      <div class="row"><button class="btn primary" id="btnHubSet"${td.cls === 0 || td.cls < 0 ? " disabled" : ""}>Set habitat (hub) here</button></div>` : ""}
    ${state.base !== state.siteBase && state.base.landed ? '<div class="row"><button class="btn" id="btnHubReset">Back to the site\'s habitat</button></div>' : ""}
    <p class="note">${L.src}. Dispersion sampled ${L.n} times on the site's real hazard layers (MSL engineering limits: slope ≤ 15° over 2–5 m, rocks ≤ 0.55 m).</p>`;
  $("btnHubSet")?.addEventListener("click", () => setHub(td));
  $("btnHubReset")?.addEventListener("click", () => setHub(null));
}

async function runLanding(lon, lat, optimise = false) {
  busy(true, optimise ? "Searching for the safest landing target…" : "Monte Carlo landing…");
  try {
    const r = await call("landing", { lander: $("landerSel").value, lon, lat, azimuthDeg: +$("landAz").value || 90, optimise });
    if (!r.ok) { $("landOut").innerHTML = `<span class="warn">${r.reason}</span>`; return; }
    state.landing = { result: r, target: r.target, touchdown: null, hub: r.hub };
    state.map.landing = { ellipse: r.ellipse, samples: r.samples, target: r.target };
    state.map.draw();
    renderLanding();
  } finally { busy(false); }
}

async function flyLanding() {
  const t = state.landing?.target ?? { lon: state.base.lon, lat: state.base.lat };
  if (!state.landing) await runLanding(t.lon, t.lat);
  const r = await call("landOnce", { lander: $("landerSel").value, lon: t.lon, lat: t.lat, azimuthDeg: +$("landAz").value || 90 });
  state.landing.touchdown = r.touchdown;
  state.landing.hub = r.hub;
  state.map.landing = { ...state.map.landing, touchdown: r.touchdown };
  state.map.draw();
  renderLanding();
}

async function setHub(td) {
  if (td) state.base = { lon: td.lon, lat: td.lat, name: `Habitat (landed: ${$("landerSel").selectedOptions[0].text.split(":")[0].split("(")[0].trim()})`, landed: true };
  else state.base = { ...state.siteBase };
  try { if (td) localStorage.setItem(`mm-hub-${state.site.id}`, JSON.stringify(state.base)); else localStorage.removeItem(`mm-hub-${state.site.id}`); } catch { /* storage unavailable */ }
  state.map.habitat = state.base;
  renderLanding();
  await runSetup();
  await runPlan();
}

// grid row/col of a lon/lat (same maths as engine/geo.js Grid.rcOfLonLat, on the plain JSON grid)
function rcOfLonLatGrid(g, lon, lat) {
  const [x, y] = lonlatToXY(lon, lat);
  return [(g.y0 - y) / g.res - 0.5, (x - g.x0) / g.res - 0.5];
}

// ------------------------------------------------------------------------------------------------ route legs --
// The crew chooses the sequence: where the sortie starts (habitat, or a station for a rover drop-off), which stations
// are visited and in what order (list order; tick to include), and where it finishes (back at the habitat, or one-way
// at a station for a rover pick-up). Every point on every leg still keeps the walk-home guarantee to the habitat.
state.route = { start: "base", end: "base" };
const stKey = (s) => s.id ?? s.name;

function routeStops() {
  const st = state.route.start;
  return state.stations.filter((s) => !s.skip && stKey(s) !== st);
}

function routeStartPoint() {
  const st = state.route.start;
  if (st === "base") return null;
  const s = state.stations.find((x) => stKey(x) === st);
  return s ? { lon: s.lon, lat: s.lat, name: s.name } : null;
}

function routeEnd() {
  const e = state.route.end;
  if (e === "base") return "base";
  const stops = routeStops();
  if (!stops.length) return "base";
  return "last";
}

function routeSequenceNames() {
  const start = routeStartPoint();
  const names = [start ? start.name : "Habitat", ...routeStops().map((s) => s.name)];
  if (routeEnd() === "base") names.push("Habitat");
  return names;
}

let replanTimer = null;
function scheduleReplan(ms = 700) {
  if (!state.meta) return;
  clearTimeout(replanTimer);
  $("planMsg").innerHTML = '<span class="dim">Route changed: re-planning…</span>';
  replanTimer = setTimeout(async () => { await runSetup(); await runPlan(); }, ms);
}

function renderRouteBox() {
  const box = $("routeBox");
  if (!box) return;
  const opts = state.stations.map((s) => ({ v: stKey(s), label: s.name }));
  if (state.route.start !== "base" && !state.stations.some((s) => stKey(s) === state.route.start)) state.route.start = "base";
  if (typeof state.route.end === "string" && !["base", "last"].includes(state.route.end) && !state.stations.some((s) => stKey(s) === state.route.end)) state.route.end = "base";
  $("routeStart").innerHTML = `<option value="base">Habitat (HAB)</option>` +
    opts.map((o) => `<option value="${o.v}"${state.route.start === o.v ? " selected" : ""}>${o.label}</option>`).join("");
  $("routeStart").value = state.route.start;
  $("routeEnd").innerHTML = `<option value="base">Return to habitat</option><option value="last">Finish at the last station (one-way)</option>` +
    opts.map((o) => `<option value="${o.v}"${state.route.end === o.v ? " selected" : ""}>Finish at ${o.label}</option>`).join("");
  $("routeEnd").value = state.route.end;
  const seq = routeSequenceNames();
  const chip = (n, k) => `<span class="chip${n === "Habitat" ? " hab" : ""}">${n === "Habitat" ? "HAB" : n}</span>`;
  $("routeSeq").innerHTML = seq.length < 2 || (seq.length === 2 && seq[0] === "Habitat" && seq[1] === "Habitat")
    ? '<span class="warn">Nothing to plan: add a station, or pick a different start.</span>'
    : seq.map(chip).join('<span class="arr">→</span>');
}

function renderStations() {
  const box = $("stations");
  box.innerHTML = "";
  if (!state.stations.length) box.innerHTML = '<p class="note">No stations yet. Use “+ Add on map”, then click the map, or add a science target below.</p>';
  // numbers on the map = visiting order on the route
  let ord = 0;
  const order = new Map();
  for (const s of state.stations) if (!s.skip && stKey(s) !== state.route.start) order.set(stKey(s), ++ord);
  state.stations.forEach((s, k) => {
    const d = document.createElement("div");
    d.className = "station" + (s.skip ? " skipped" : "");
    const isStart = stKey(s) === state.route.start;
    const o = order.get(stKey(s));
    const opt = Object.entries(TASK_PRESETS).map(([id, p]) => `<option value="${id}"${(s.task || "sampling") === id ? " selected" : ""}>${p.label.split(":")[0]} (${p.workW} W)</option>`).join("");
    d.innerHTML = `<span class="n" title="${isStart ? "Start point" : s.skip ? "Not on this route" : `Visited ${o}${["st", "nd", "rd"][o - 1] ?? "th"}`}">${isStart ? "S" : s.skip ? "–" : o}</span><div>
      <div class="t"><label class="inroute" title="Include this station in the route"><input type="checkbox" data-inc="${k}"${s.skip ? "" : " checked"}${isStart ? " disabled" : ""}> ${s.name}</label>${isStart ? ' <span class="tag">start</span>' : ""}</div>
      <div class="meta">Work <input type="number" min="0" max="180" step="5" value="${s.dwell_min}" data-f="dwell_min" style="width:58px;padding:2px 4px"> min
        <select data-f="task" aria-label="Work intensity" title="${Object.values(TASK_PRESETS).map((p) => p.label).join(" / ")}" style="padding:2px 4px">${opt}</select></div>
      <details class="task"><summary class="lbl">Task consumables${s.toolWh || s.extraO2g || s.extraWaterG ? " ✓" : ""}</summary>
        <div class="meta">Tools <input type="number" min="0" max="2000" step="5" value="${s.toolWh || 0}" data-f="toolWh" style="width:58px;padding:2px 4px"> Wh
          · O₂ <input type="number" min="0" max="500" step="5" value="${s.extraO2g || 0}" data-f="extraO2g" style="width:52px;padding:2px 4px"> g
          · water <input type="number" min="0" max="2000" step="10" value="${s.extraWaterG || 0}" data-f="extraWaterG" style="width:58px;padding:2px 4px"> g</div>
        <div class="note">Stated for the full work time: tool and instrument energy from the suit battery, O₂ for a purge, water for sample handling.</div></details>
      <div class="meta sb" id="sb${k}">${s.budget ? stationBudgetText(s.budget) : ""}</div></div>
      <div class="ord"><button aria-label="Visit earlier" title="Visit earlier" data-up="${k}">&uarr;</button><button aria-label="Visit later" title="Visit later" data-dn="${k}">&darr;</button><button aria-label="Remove" title="Remove" data-del="${k}">&times;</button></div>`;
    box.appendChild(d);
    d.querySelectorAll("[data-f]").forEach((el) => el.addEventListener("change", (e) => {
      const f = e.target.dataset.f;
      s[f] = f === "task" ? e.target.value : Math.max(0, +e.target.value || 0);
      s.budget = null;
      $(`sb${k}`).textContent = "Changed: re-planning with it…";
      scheduleReplan(1200);
    }));
  });
  const changed = () => { renderStations(); scheduleReplan(); };
  box.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => { state.stations.splice(+b.dataset.del, 1); changed(); }));
  box.querySelectorAll("[data-up]").forEach((b) => b.addEventListener("click", () => {
    const k = +b.dataset.up;
    if (k > 0) [state.stations[k - 1], state.stations[k]] = [state.stations[k], state.stations[k - 1]];
    changed();
  }));
  box.querySelectorAll("[data-dn]").forEach((b) => b.addEventListener("click", () => {
    const k = +b.dataset.dn;
    if (k < state.stations.length - 1) [state.stations[k + 1], state.stations[k]] = [state.stations[k], state.stations[k + 1]];
    changed();
  }));
  box.querySelectorAll("[data-inc]").forEach((c) => c.addEventListener("change", (e) => {
    state.stations[+c.dataset.inc].skip = !e.target.checked;
    changed();
  }));
  renderRouteBox();
  if (state.map) {
    const endLast = routeEnd() === "last" ? routeStops().slice(-1)[0] : null;
    state.map.stations = state.stations.map((s) => ({ ...s, label: stKey(s) === state.route.start ? "S" : s.skip ? "–" : String(order.get(stKey(s))),
      isStart: stKey(s) === state.route.start, isEnd: endLast && stKey(endLast) === stKey(s) }));
    state.map.draw();
  }
}

function stationBudgetText(b) {
  return `Station budget: ${Math.round(b.s / 60)} min · O₂ ${(b.o2 * 1000).toFixed(0)} g · water ${(b.water * 1000).toFixed(0)} g · battery ${b.batt.toFixed(0)} Wh` +
    (b.marginAfter != null ? ` · walkback margin after <span class="num ${marginClass(b.marginAfter)}">${(100 * b.marginAfter).toFixed(0)} %</span>` : "");
}

// after planning: each station row shows what its stated task costs on the selected route, and what is left after it
function showStationBudgets() {
  const r = state.routes?.[state.selected];
  state.stations.forEach((s, k) => {
    const leg = r?.ok ? r.legs.find((l) => l.to === s.name && l.work) : null;
    s.budget = leg?.work ?? null;
    const el = $(`sb${k}`);
    if (el) el.innerHTML = s.budget ? stationBudgetText(s.budget) : !state.routes && s.dwell_min > 0
      ? '<span class="warn">Not budgeted: no round trip fits with the stations as stated (see Why this route)</span>' : "";
  });
}

function buildTargets() {
  const box = $("targets");
  box.innerHTML = "";
  for (const t of state.meta.targets.filter((x) => x.kind !== "base")) {
    const row = document.createElement("div");
    row.className = "cand";
    row.innerHTML = `<button class="btn" style="padding:3px 8px">+</button><div><div>${t.name}</div><div class="note">${t.why}</div></div>
      <span class="num dim">${t.value ? t.value.toFixed(1) : "-"}</span>`;
    row.querySelector("button").addEventListener("click", () => { addStation(t); scheduleReplan(); });
    box.appendChild(row);
  }
}

// ------------------------------------------------------------------------------------------------------- AHP --
const SAATY = [1 / 9, 1 / 7, 1 / 5, 1 / 3, 1, 3, 5, 7, 9];
const saatyLabel = (v) => (v >= 1 ? String(Math.round(v)) : `1/${Math.round(1 / v)}`);

function buildAHP() {
  const box = $("ahpBox");
  const n = L1_IDS.length;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) state.l1Upper[`${i},${j}`] = L1_MATRIX[i][j];
  let html = "";
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const key = `${i},${j}`;
    const v = state.l1Upper[key];
    const idx = SAATY.reduce((b, s, k) => (Math.abs(Math.log(s / v)) < Math.abs(Math.log(SAATY[b] / v)) ? k : b), 0);
    const reason = L1_REASONS[`${L1_IDS[i]},${L1_IDS[j]}`]?.[1] || "";
    html += `<label title="${reason}" style="display:grid;grid-template-columns:1fr auto;gap:4px 8px;font-size:13px">
      <span>${L1_NAMES[L1_IDS[i]]} vs ${L1_NAMES[L1_IDS[j]]}</span><span class="num" id="ahpv${i}${j}">${saatyLabel(v)}</span>
      <input type="range" min="0" max="8" step="1" value="${idx}" data-key="${key}" aria-label="${L1_NAMES[L1_IDS[i]]} versus ${L1_NAMES[L1_IDS[j]]}" style="grid-column:1/-1">
    </label>`;
  }
  html += '<div id="ahpOut" class="kv"></div><div id="ahpCR" class="num"></div>';
  box.innerHTML = html;
  box.querySelectorAll("input[type=range]").forEach((r) => r.addEventListener("input", () => {
    state.l1Upper[r.dataset.key] = SAATY[+r.value];
    $(`ahpv${r.dataset.key.replace(",", "")}`).textContent = saatyLabel(SAATY[+r.value]);
    updateAHP();
  }));
  updateAHP();
}

function l1Matrix() {
  const n = L1_IDS.length;
  const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : null)));
  for (const [k, v] of Object.entries(state.l1Upper)) {
    const [i, j] = k.split(",").map(Number);
    A[i][j] = v;
    A[j][i] = 1 / v;
  }
  return A;
}

function updateAHP() {
  const r = ahp(l1Matrix());
  state.l1 = Object.fromEntries(L1_IDS.map((k, i) => [k, r.weights[i]]));
  $("ahpOut").innerHTML = L1_IDS.map((k, i) => `<div><span class="k">${L1_NAMES[k]}</span><span class="v">${(100 * r.weights[i]).toFixed(1)}%</span></div>`).join("");
  $("ahpCR").innerHTML = `CR ${r.CR.toFixed(3)} ${r.consistent ? '<span class="pill n">consistent</span>' : '<span class="pill c">revise: CR &gt; 0.10</span>'}`;
}

// ------------------------------------------------------------------------------------------------------ plan --
const ROUTE_INFO = {
  balanced: ["Balanced", "Team AHP weights: safety and margins first, then time"],
  safest: ["Safest", "Safety 60 %, recoverability 20 %: lowest hazard exposure"],
  fastest: ["Fastest", "Least time among feasible routes (Earth-style)"],
  economy: ["Lowest consumption", "Least oxygen, water and power used"],
  fallback: ["Fallback", "Different corridor, kept ready if the primary is blocked"],
};

async function runPlan() {
  busy(true, "Planning routes on real terrain…");
  $("planMsg").textContent = "";
  try {
    const res = await call("plan", { stops: routeStops().map(({ lon, lat, name, dwell_min, kind, value, task, toolWh, extraO2g, extraWaterG }) =>
      ({ lon, lat, name, dwell_min, kind, value, task, toolWh, extraO2g, extraWaterG })),
      weights: state.l1, start: routeStartPoint(), end: routeEnd() });
    if (!res.ok) {
      const NAMES = { o2: "oxygen", co2: "CO₂ scrubber", water: "cooling water", batt: "suit battery", time: "time before sunset / EVA limit" };
      const d = res.diag;
      const pnr = d && d.pnrIndex >= 0
        ? ` Point of no return: <span class="num">${(d.pnrDistM / 1000).toFixed(2)} km</span> along the direct plan of ${(d.totalDistM / 1000).toFixed(2)} km (limit: ${NAMES[d.limiting]}). The red marker shows the last point from which the crew can still walk home.`
        : "";
      $("planMsg").innerHTML = `<span class="bad">No feasible route${res.from ? ` from ${res.from} to ${res.to}` : ""}: ${res.reason}.</span>${pnr} Remove a station, shorten work time, depart earlier, or raise the EVA limit.`;
      state.routes = null;
      state.map.routes = {};
      state.map.diag = d && d.pnrIndex >= 0 ? d : null;
      $("why").innerHTML = state.map.diag
        ? `No route fits the crew limits. On the direct plan the ${NAMES[d.limiting]} runs out first; the crew must turn back by <span class="num">${(d.pnrDistM / 1000).toFixed(2)} km</span>. Options: drop or reorder a station, shorten station work, depart earlier, add a rover (rescue mode) or raise the EVA limit.`
        : "No route fits the crew limits.";
      $("guidance").innerHTML = "";
      if (state.map.diag) state.map.fitLonLat(d.pts.map((p) => [p.lon, p.lat]), 70);
      state.tl.set(null);
      renderCards();
      showStationBudgets();
      return;
    }
    state.routes = res.routes;
    state.refs = res.refs;
    state.map.diag = null;
    if (!state.routes[state.selected]?.ok) state.selected = "balanced";
    $("planMsg").innerHTML = `Routes planned in <span class="num">${(res.ms / 1000).toFixed(1)} s</span> on 10 m terrain (${state.site.hires_dtms?.length ? "1 m DTMs + regional DEM" : "regional DEM only: lower confidence"}).`;
    state.map.routes = state.routes;
    selectRoute(state.selected);
    showStationBudgets();
  } catch (err) {
    $("planMsg").innerHTML = `<span class="bad">${err.message}</span>`;
  } finally {
    busy(false);
  }
}

function selectRoute(name) {
  state.selected = name;
  state.map.selected = name;
  state.map.draw();
  state.tl.set(state.routes?.[name]);
  renderCards();
  showStationBudgets();
  renderWhy();
  renderGuidance();
  hudPlan();
}

function marginClass(m) {
  return m < 0 ? "bad" : m < 0.2 ? "warn" : "good";
}

function renderCards() {
  const box = $("cards");
  if (!state.routes) { box.innerHTML = '<p class="note">No routes.</p>'; return; }
  box.innerHTML = "";
  for (const name of ["balanced", "safest", "fastest", "economy", "fallback"]) {
    const r = state.routes[name];
    const [title, why] = ROUTE_INFO[name];
    const el = document.createElement("div");
    el.className = "card";
    el.setAttribute("role", "button");
    el.tabIndex = 0;
    el.setAttribute("aria-pressed", String(name === state.selected));
    if (!r?.ok) {
      el.innerHTML = `<div class="head"><span class="title">${title}</span><span class="pill w">NO ROUTE</span></div><div class="why">${r?.reason || "not computed"}</div>`;
    } else {
      const status = !r.feasible ? '<span class="pill w">INFEASIBLE</span>' : r.minMargin < 0.2 ? '<span class="pill c">TIGHT</span>' : '<span class="pill n">GO</span>';
      const dq = [r.seamCells ? "crosses a repaired DEM seam: check on imagery" : "",
        r.lowConfFrac > 0.25 ? `${(100 * r.lowConfFrac).toFixed(0)} % on 20 m data only` : ""].filter(Boolean).join(" · ");
      el.innerHTML = `<div class="head"><span class="title">${title}</span>${status}</div><div class="why">${why}${name === "fallback" && r.overlap != null ? ` · shares ${(100 * r.overlap).toFixed(0)} % of the balanced corridor` : ""}${dq ? `<div class="dq">${dq}</div>` : ""}</div>
        <div class="kv">
          <div><span class="k">Duration</span><span class="v">${fmtDuration(r.t).slice(0, 5)}</span></div>
          <div><span class="k">Distance</span><span class="v">${(r.dist / 1000).toFixed(2)} km</span></div>
          <div><span class="k">Min margin</span><span class="v ${marginClass(r.minMargin)}">${(100 * r.minMargin).toFixed(0)} %</span></div>
          <div><span class="k">O₂ used</span><span class="v">${r.res.o2.toFixed(2)} kg</span></div>
          <div><span class="k">Water</span><span class="v">${r.res.water.toFixed(1)} kg</span></div>
          <div><span class="k">Battery</span><span class="v">${r.res.batt.toFixed(0)} Wh</span></div>
          <div><span class="k">Max grade</span><span class="v">${r.maxSlope.toFixed(1)}°</span></div>
          <div><span class="k">Shade</span><span class="v">${(100 * r.shadeFrac).toFixed(0)} %</span></div>
          <div><span class="k">Radio LOS</span><span class="v">${(100 * r.losFrac).toFixed(0)} %</span></div>
          <div><span class="k">Rocky ground</span><span class="v ${r.rockyFrac > 0.3 ? "warn" : ""}">${(100 * (r.rockyFrac ?? 0)).toFixed(0)} %</span></div>
          ${r.wheelLife != null ? `<div><span class="k">Wheel life used</span><span class="v">${(100 * r.wheelLife).toFixed(1)} %</span></div>
          <div><span class="k">Rover battery</span><span class="v">${(r.res.rbatt ?? 0).toFixed(0)} Wh</span></div>` : `<div><span class="k">Sand</span><span class="v">${(100 * (r.sandFrac ?? 0)).toFixed(0)} %</span></div>`}
        </div>
        ${r.wheelLeft != null && r.wheelLeft < 0.2 ? `<div class="dq">Wheels at ${(100 * Math.max(0, r.wheelLeft)).toFixed(0)} % life after this drive: inspect or avoid rocky ground</div>` : ""}
        <div class="note">Radiation ≈ ${r.doseMSv.toFixed(2)} mSv from cosmic rays at this altitude (Curiosity RAD, scaled by the air overhead)${state.swx?.level === "storm" ? '; <span class="bad">a solar particle event in progress would add to it</span>' : ""}.</div>`;
    }
    el.addEventListener("click", () => r?.ok && selectRoute(name));
    el.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && r?.ok && selectRoute(name));
    box.appendChild(el);
  }
}

function renderWhy() {
  const r = state.routes?.[state.selected];
  const s = state.setup;
  if (!r?.ok || !s) return;
  const vc = s.vetoCount, n = vc.reduce((a, b) => a + b, 0);
  const vetoLines = vc.map((c, k) => (k && c ? `<li>${s.vetoNames[k]}: <span class="num">${(100 * c / n).toFixed(1)} %</span> of the map</li>` : "")).join("");
  const X = r.X, refs = state.refs || {};
  const w = state.selected === "balanced" ? state.l1 : { fastest: { T: 1 }, safest: { S: 0.6, R: 0.2, C: 0.1, T: 0.1 }, economy: { C: 0.9, T: 0.1 },
    fallback: state.l1 }[state.selected] || state.l1;
  const rows = L1_IDS.map((k) => `<tr><td>${L1_NAMES[k]}</td><td class="num">${(100 * (w[k] || 0)).toFixed(1)}%</td><td class="num">${refs[k] ? (X[k] / refs[k]).toFixed(2) : "-"}</td></tr>`).join("");
  $("why").innerHTML = `<p>Hard limits removed these areas before any weighing (profile: ${state.cfg.profile}):</p><ul style="margin:4px 0 8px 18px;padding:0">${vetoLines}</ul>
    <p>Every point on this route keeps enough oxygen, water, CO₂ capacity, battery and daylight to walk home: minimum margin <span class="num ${marginClass(r.minMargin)}">${(100 * r.minMargin).toFixed(0)} %</span> after the ${(100 * state.cfg.reserveFrac).toFixed(0)} % reserve.</p>
    <div class="tablewrap"><table class="t"><tr><th>Criterion</th><th>Weight</th><th>vs fastest</th></tr>${rows}</table></div>
    <p class="note">"vs fastest" is this route's total on each criterion divided by the fastest route's (1.00 = same; lower is better).</p>
    <p>Rocky ground is judged three ways at once: it is slower (walking pace ×0.5, driving ×0.5), it costs more (walking metabolic ×1.2; rover motion resistance ×1.35 plus wheel slip), and it carries hazard (steps and roughness in the safety tree${state.cfg.profile === "rover" ? "; wheel wear from Curiosity's km-to-failure data, weighted three times as heavily on worn wheels" : "; boot and suit abrasion"}). This route: <span class="num">${(100 * (r.rockyFrac ?? 0)).toFixed(0)} %</span> rocky${r.wheelLife != null ? `, wheel life used <span class="num">${(100 * r.wheelLife).toFixed(1)} %</span> (${(100 * Math.max(0, r.wheelLeft)).toFixed(0)} % left after)` : ""}.</p>`;
}

function renderGuidance() {
  const r = state.routes?.[state.selected];
  if (!r?.ok) { $("guidance").innerHTML = ""; return; }
  let html = '<table class="t"><tr><th>Leg</th><th>Hdg</th><th>Dist</th><th>Time</th><th>Climb</th></tr>';
  for (const leg of r.legs) {
    html += `<tr><td colspan="5" class="lbl">${leg.from} → ${leg.to}</td></tr>`;
    leg.guidance.forEach((g, k) => {
      html += g.work
        ? `<tr><td>${k + 1}</td><td colspan="4">Station work ${fmtDuration(g.work).slice(0, 5)}</td></tr>`
        : g.dist < 1 ? "" : `<tr><td>${k + 1}</td><td class="num">${String(Math.round(g.heading)).padStart(3, "0")}°</td><td class="num">${(g.dist / 1000).toFixed(2)} km</td><td class="num">${fmtDuration(g.dt).slice(0, 5)}</td><td class="num">${g.climb >= 0 ? "+" : ""}${g.climb.toFixed(0)} m</td></tr>`;
    });
  }
  $("guidance").innerHTML = html + "</table>";
}

// ------------------------------------------------------------------------------------------------ map wiring --
function wireMap() {
  const m = state.map;
  let pendingHover = null, busyHover = false;
  m.onHover = async (lon, lat) => {
    if (lon == null) return;
    pendingHover = [lon, lat];
    if (busyHover) return;
    busyHover = true;
    while (pendingHover) {
      const [lo, la] = pendingHover;
      pendingHover = null;
      const c = await call("cell", { lon: lo, lat: la }).catch(() => null);
      if (c) {
        $("readout").textContent =
          `${la.toFixed(5)}°N ${lo.toFixed(5)}°E  elev ${c.elevation.toFixed(0)} m  ${c.terrain}\n` +
          `slope ${c.slopeW.toFixed(1)}° (walking p90)  step ${c.step.toFixed(2)} m  sand ${c.sand.toFixed(2)}  slip risk ${c.slipRisk.toFixed(2)}\n` +
          `cliff ${c.cliffDist >= 1020 ? ">1 km" : c.cliffDist.toFixed(0) + " m"}  pos error ±${(2 * c.sigma).toFixed(0)} m  radio ${c.los ? "LOS" : "NO LOS"}  walk home ${Number.isFinite(c.walkbackS) ? fmtDuration(c.walkbackS).slice(0, 5) : "--"}\n` +
          (c.veto ? `NO-GO: ${c.veto}` : `hazard index ${c.hazard.toFixed(2)}  data: ${c.confidence > 0.5 ? "HiRISE 1 m" : "CTX 20 m only"}`);
      }
    }
    busyHover = false;
  };
  m.onClick = (lon, lat) => {
    if (state.landPick) {
      state.landPick = false;
      $("btnLandPick").setAttribute("aria-pressed", "false");
      $("btnLandPick").classList.remove("primary");
      runLanding(lon, lat);
      return;
    }
    if (!state.addMode) return;
    const g = state.meta.grid, [rr, cc] = rcOfLonLatGrid(g, lon, lat);
    if (!(rr >= 0 && cc >= 0 && rr < g.height && cc < g.width)) {
      $("planMsg").innerHTML = '<span class="warn">That point is outside this site\'s detailed terrain. Add points inside the mapped area, or use Landing mode to build a hub site there.</span>';
      return;
    }
    let n = state.stations.length + 1;
    while (state.stations.some((x) => x.name === `Point ${n}`)) n++;
    addStation({ id: `P${Date.now().toString(36)}`, name: `Point ${n}`, lon, lat, dwell_min: 20, value: 0.3 });
    scheduleReplan();
    state.addMode = false;
    $("btnAddMode").setAttribute("aria-pressed", "false");
    $("btnAddMode").classList.remove("primary");
  };
  state.tl.onHover = (p) => {
    state.map.crew = p ? { lon: p.lon, lat: p.lat, sigma: p.sigma } : state.simCrew || null;
    state.map.draw();
  };
}

// ---------------------------------------------------------------------------------------------------- binding --
function bindUI() {
  for (const b of document.querySelectorAll(".modes button")) b.addEventListener("click", () => setMode(b.dataset.mode));
  $("btnPlan").addEventListener("click", async () => { await runSetup(); await runPlan(); });
  for (const id of ["profile", "risk", "tau", "reserve", "evaMax", "departSol", "departLmst", "rescue", "nav",
    "hwO2", "hwBatt", "hwWater", "hwScrub", "hwRBatt", "hwWear", "calMet", "calSpeed"]) {
    $(id).addEventListener("change", async () => { await runSetup(); });
  }
  $("btnCarry").addEventListener("click", async () => {
    const c = state.lastCal;
    if (!c) return;
    // start the next plan from what this crew and suit really did (review carry-over)
    $("calMet").value = c.met.toFixed(2);
    $("calSpeed").value = c.speed.toFixed(2);
    state.carry = { water: c.water / Math.max(0.3, c.met), co2: (c.co2 ?? c.met) / c.met };
    await runSetup();
    $("planMsg").textContent = `Using learned rates: work x${c.met.toFixed(2)}, pace x${c.speed.toFixed(2)}, water x${c.water.toFixed(2)}. Re-plan to apply.`;
  });
  $("telSrc").addEventListener("change", () => {
    const live = $("telSrc").value === "live" || $("telSrc").value === "drive";
    $("simOpts").hidden = live;
    $("liveOpts").hidden = $("telSrc").value !== "live";
    $("speedBox").hidden = live;
    runSim(false);
    state.sim = null;
    setMode(state.mode);
  });
  $("truthSel").addEventListener("change", () => { runSim(false); state.sim = null; startSim(); });
  $("chkReplan").addEventListener("change", (e) => call("setAutoReplan", { on: e.target.checked }));
  $("btnAddMode").addEventListener("click", () => {
    state.addMode = !state.addMode;
    $("btnAddMode").setAttribute("aria-pressed", String(state.addMode));
    $("btnAddMode").classList.toggle("primary", state.addMode);
  });
  $("btnClear").addEventListener("click", () => { state.stations = []; state.route = { start: "base", end: "base" }; renderStations(); scheduleReplan(); });
  $("routeStart").addEventListener("change", (e) => { state.route.start = e.target.value; renderStations(); scheduleReplan(); });
  $("routeEnd").addEventListener("change", (e) => {
    const v = e.target.value;
    if (v === "base" || v === "last") state.route.end = v;
    else {
      // "finish at station X": X becomes the last station visited, and the sortie ends there (one-way)
      const k = state.stations.findIndex((s) => stKey(s) === v);
      if (k >= 0) { const [s] = state.stations.splice(k, 1); s.skip = false; state.stations.push(s); }
      if (state.route.start === v) state.route.start = "base";
      state.route.end = "last";
    }
    renderStations();
    scheduleReplan();
  });
  $("btnOptimise").addEventListener("click", optimise);
  $("btnLandPick").addEventListener("click", () => {
    state.landPick = !state.landPick;
    $("btnLandPick").setAttribute("aria-pressed", String(state.landPick));
    $("btnLandPick").classList.toggle("primary", state.landPick);
  });
  $("btnLandBest").addEventListener("click", () => { const t = state.landing?.target ?? state.base; runLanding(t.lon, t.lat, true); });
  $("btnLandFly").addEventListener("click", flyLanding);
  $("landerSel").addEventListener("change", () => { const t = state.landing?.target; if (t) runLanding(t.lon, t.lat); });
  $("landAz").addEventListener("change", () => { const t = state.landing?.target; if (t) runLanding(t.lon, t.lat); });
  document.querySelectorAll("input[name=ov]").forEach((r) => r.addEventListener("change", () => { state.overlay = r.value; refreshOverlay(); }));
  $("chkVeto").addEventListener("change", (e) => { state.map.showVeto = e.target.checked; state.map.draw(); });
  $("chkTrav").addEventListener("change", (e) => { state.map.layers.traverse = e.target.checked; state.map.draw(); });
  $("chkLmk").addEventListener("change", (e) => { state.map.layers.landmarks = e.target.checked; state.map.draw(); });
  $("chkAlt").addEventListener("change", (e) => { state.map.layers.alt = e.target.checked; state.map.draw(); });
  $("btn3d").addEventListener("click", open3D);
  $("btnDrive").addEventListener("click", openDriveWindow);
  $("btnDrive2").addEventListener("click", openDriveWindow);
  $("btnTour").addEventListener("click", () => tourShow(0));
  state.setLayersOpen = initLayerPanel();
  initSectionHelp();
  $("telSrc").addEventListener("change", () => { if (!$("execLeft").hidden) setPhasePill("exec"); });
  $("tourNext").addEventListener("click", () => tourShow(tourK + 1));
  $("tourBack").addEventListener("click", () => tourShow(tourK - 1));
  $("tourEnd").addEventListener("click", () => tourShow(-1));
  $("v3close").addEventListener("click", () => { state.v3?.play(false); state.v3?.release(); $("view3d").hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("view3d").hidden) $("v3close").click(); });
  document.querySelectorAll("[data-v3]").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("[data-v3]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    state.v3?.setMode(b.dataset.v3);
    update3DInfo();
  }));
  $("v3t").addEventListener("input", (e) => {
    document.querySelector("[data-v3=helmet]").click();
    state.v3?.setFly(+e.target.value / 1000);
    update3DInfo();
  });
  $("v3play").addEventListener("click", () => {
    if (!state.v3) return;
    const on = !state.v3.playing;
    if (on) document.querySelector("[data-v3=helmet]").click();
    state.v3.onFly = (t) => { $("v3t").value = Math.round(t * 1000); update3DInfo(); };
    state.v3.play(on);
    $("v3play").textContent = on ? "Pause walk" : "Walk route";
  });
  $("v3x").addEventListener("change", async (e) => { if (state.v3) { busy(true, "Rebuilding 3D terrain…"); await state.v3.setExag(e.target.checked ? 2 : 1); busy(false); } });
  $("zoomIn").addEventListener("click", () => state.map.zoomAt(0.6));
  $("zoomOut").addEventListener("click", () => state.map.zoomAt(1.6));
  $("zoomFit").addEventListener("click", () => {
    const r = state.routes?.[state.selected];
    if (r?.ok) state.map.fitLonLat(r.pts.map((p) => [p.lon, p.lat]), 60);
  });
  // execute
  $("btnRun").addEventListener("click", () => { primeAudio(); runSim(true); });
  // live telemetry: one button does everything (the local server finds the TSS; else the built-in demo suit)
  $("btnLive").addEventListener("click", () => { primeAudio(); if (state.mode !== "exec") setMode("exec"); runSim(!(state.sim?.running)); });
  const tssModeUi = () => {
    $("tssAddrRow").hidden = $("tssMode").value !== "addr";
    $("demoRow").hidden = $("tssMode").value === "addr";
  };
  $("tssMode").addEventListener("change", () => { tssModeUi(); if (state.sim?.running) { runSim(false); state.sim = null; } });
  $("demoTruth").addEventListener("change", () => { if (state.sim?.demo) { runSim(false); state.sim = null; } });
  try { const a = localStorage.getItem("mm-tss-addr"); if (a) $("tssAddr").value = a; } catch { /* storage unavailable */ }
  tssModeUi();
  $("btnPause").addEventListener("click", () => runSim(false));
  document.querySelectorAll("[data-fault]").forEach((b) => b.addEventListener("click", async () => {
    if (!state.sim) await startSim();
    const snap = await call("simInject", { kind: b.dataset.fault });
    onSnap(snap);
  }));
  $("btnAckAll").addEventListener("click", async () => onSnap(await call("simAck", {})));
  $("btnSilence").addEventListener("click", async () => { await call("simSilence"); state.silenced = true; });
  document.querySelectorAll("[data-ask]").forEach((b) => b.addEventListener("click", () => answer(b.dataset.ask)));
  $("askForm").addEventListener("submit", (e) => { e.preventDefault(); answer(parseAsk($("askIn").value)); $("askIn").select(); });
  $("btnPin").addEventListener("click", dropPin);
  // critical action, two steps (NASA-STD-3001 F interaction rule, research doc 17): arm, then confirm within 5 s
  let armTimer = null;
  $("btnAbort").addEventListener("click", async () => {
    const b = $("btnAbort");
    if (!b.classList.contains("armed")) {
      b.classList.add("armed");
      b.textContent = "Confirm return";
      armTimer = setTimeout(() => { b.classList.remove("armed"); b.textContent = "Return now"; }, 5000);
      return;
    }
    clearTimeout(armTimer);
    b.classList.remove("armed");
    b.textContent = "Return now";
    if (!state.sim && !(await startSim())) return;
    onSnap(await call("simAbort"));
  });
  // review
  $("btnCue").addEventListener("click", cueCard);
  $("btnGeo").addEventListener("click", geoJSON);
  $("modalClose").addEventListener("click", () => { $("modal").hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("modal").hidden = true; });
}

async function optimise() {
  busy(true, "Choosing stations…");
  try {
    const cands = state.meta.targets.filter((t) => t.kind === "science").map(({ id, name, lon, lat, value, dwell_min }) => ({ id, name, lon, lat, value, dwell_min }));
    const r = await call("optimise", { cands, maxStops: 4 });
    if (!r.options.length) { $("optOut").innerHTML = '<span class="warn">No science target is reachable and returnable within this EVA\'s budget.</span>'; return; }
    const names = Object.fromEntries(cands.map((c) => [c.id, c.name]));
    $("optOut").innerHTML = r.options.slice(0, 4).map((o, k) => `<div class="cand"><button class="btn" data-opt="${k}" style="padding:3px 8px">Use</button>
      <div>${o.ids.map((i) => names[i]).join(" → ")}</div><span class="num dim">${o.value.toFixed(1)} · ${fmtDuration(o.timeS).slice(0, 5)}</span></div>`).join("") +
      `<p class="note">${r.method ? `${r.method}. ` : "Exact search over every set and order. "}Ranked by science value (team priorities), then time. Budget ${fmtDuration(r.budgetT).slice(0, 5)} with 15 % held back for the detailed plan.
      <button class="btn" id="btnQubo" style="padding:2px 8px">Export as QUBO</button></p>`;
    $("btnQubo").addEventListener("click", async () => {
      const q = await call("quboExport", { cands });
      const txt = JSON.stringify(q.json, null, 1);
      openModal("Station selection as a QUBO", `<p class="note">The same selection problem in the form quantum annealers and QAOA take (research doc 34: no quantum advantage at this size; solved here by simulated annealing in ${q.ms} ms).</p><textarea readonly>${txt.replace(/</g, "&lt;")}</textarea>`, txt, "station_selection_qubo.json", "application/json");
    });
    $("optOut").querySelectorAll("[data-opt]").forEach((b) => b.addEventListener("click", async () => {
      const o = r.options[+b.dataset.opt];
      state.stations = [];
      state.route = { start: "base", end: "base" };   // the optimiser plans round trips from the habitat
      for (const id of o.ids) addStation(state.meta.targets.find((t) => t.id === id));
      await runPlan();
      const rr = state.routes?.[state.selected];
      if (rr?.ok) state.map.fitLonLat(rr.pts.map((p) => [p.lon, p.lat]), 60);
    }));
  } finally {
    busy(false);
  }
}

// ----------------------------------------------------------------------------------------------------- modes --
function setMode(mode) {
  state.mode = mode;
  for (const b of document.querySelectorAll(".modes button")) b.setAttribute("aria-selected", String(b.dataset.mode === mode));
  $("planLeft").hidden = mode !== "plan";
  $("planRight").hidden = mode !== "plan";
  $("execLeft").hidden = mode !== "exec";
  $("execRight").hidden = mode !== "exec";
  $("hud").hidden = mode !== "exec";
  document.querySelector(".mapwrap").classList.toggle("exec", mode === "exec");
  $("reviewLeft").hidden = mode !== "review";
  $("reviewRight").hidden = mode !== "review";
  setPhasePill(mode);
  if (mode === "exec" && !state.sim && $("telSrc").value === "sim") startSim();
  if (mode === "review") renderReview();
}

// EVA phase annunciator in the top bar: PRE-EVA (planning), EVA with its telemetry source, POST-EVA (review)
function setPhasePill(mode) {
  const live = $("telSrc").value === "live", drive = $("telSrc").value === "drive";
  const el = $("dataPill");
  el.textContent = mode === "exec" ? (live ? "EVA · LIVE TLM" : drive ? "EVA · DRIVE TLM" : "EVA · SIM TLM") : mode === "review" ? "POST-EVA" : "PRE-EVA";
  el.className = `pill phase${mode === "exec" ? (live ? " live" : " sim") : ""}`;
}

// map layer panel: collapsed to one line (the layer shown) until opened; L toggles it
function initLayerPanel() {
  const box = $("layers"), btn = $("layersToggle");
  const set = (open) => {
    box.classList.toggle("collapsed", !open);
    btn.setAttribute("aria-expanded", String(open));
    try { localStorage.setItem("mm.layersOpen", open ? "1" : "0"); } catch { /* storage unavailable */ }
  };
  const cur = () => {
    const r = document.querySelector("input[name=ov]:checked");
    $("layersCur").textContent = r ? r.parentElement.textContent.trim() : "";
  };
  let open = false;
  try { open = localStorage.getItem("mm.layersOpen") === "1"; } catch { /* storage unavailable */ }
  set(open);
  cur();
  btn.addEventListener("click", () => set(box.classList.contains("collapsed")));
  document.querySelectorAll("input[name=ov]").forEach((r) => r.addEventListener("change", cur));
  document.addEventListener("keydown", (e) => {
    if ((e.key === "l" || e.key === "L") && !e.ctrlKey && !e.altKey && !e.metaKey && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || "")) set(box.classList.contains("collapsed"));
  });
  return set;
}

// explanations under a section heading stay hidden until its (i) button is pressed
function initSectionHelp() {
  for (const sec of document.querySelectorAll(".section")) {
    const h = sec.querySelector("h2");
    if (!h || !sec.querySelector(".help")) continue;
    const b = document.createElement("button");
    b.className = "infob";
    b.type = "button";
    b.textContent = "i";
    b.title = "Show or hide the explanation";
    b.setAttribute("aria-label", `About ${h.textContent.trim()}`);
    b.addEventListener("click", () => sec.classList.toggle("show-help"));
    h.appendChild(b);
  }
}

// --------------------------------------------------------------------------------------------------- execute --
async function startSim() {
  if (!state.routes?.[state.selected]?.ok) {
    $("alerts").innerHTML = '<p class="note">No feasible plan to fly. Plan an EVA in Plan mode first.</p>';
    return false;
  }
  const live = $("telSrc").value === "live" || $("telSrc").value === "drive";
  const snap = live
    ? await call("liveStart", { route: state.selected, crew: $("telCrew").value, autoReplan: $("chkReplan").checked })
    : await call("simStart", { route: state.selected, seed: 11, truth: $("truthSel").value || "nominal", autoReplan: $("chkReplan").checked });
  state.sim = { snap, running: false, live };
  state.lastSpoken = new Set();
  onSnap(snap);
  return true;
}

function runSim(on) {
  if (!state.sim) { if (on) startSim().then((ok) => ok && runSim(on)); return; }
  state.sim.running = on;
  clearInterval(state.simTimer);
  if (state.sim.live) {
    if ($("telSrc").value === "drive") { state.driveOn = on; driveChannel(); $("driveStatus").hidden = false; $("driveStatus").textContent = on ? "Listening to the drive window: press Start EVA there." : "Paused."; return; }
    liveConnect(on); return;
  }
  if (!on) return;
  state.simTimer = setInterval(async () => {
    if (state.simBusy) return;
    state.simBusy = true;
    const dt = parseFloat($("simSpeed").value) * 0.5;
    const snap = await call("simStep", { dt });
    state.simBusy = false;
    onSnap(snap);
    if (snap.done) { clearInterval(state.simTimer); state.sim.running = false; }
  }, 500);
}

// ---------------------------------------------------------------------------------- crew displays (hud.html) --
// The same EVA on the displays a crew would carry: a helmet-visor HUD, a rover dashboard and a wrist cuff. They get
// the plan and every snapshot over a BroadcastChannel and send back the cuff's commands (acknowledge, silence, pin,
// two-step return), so they work beside the simulator, live suit telemetry and the drive window alike.
const HUD = "marsnav-hud";
function hudChannel() {
  if (state.hudCh || !("BroadcastChannel" in window)) return state.hudCh;
  const ch = new BroadcastChannel(HUD);
  state.hudCh = ch;
  ch.onmessage = async (ev) => {
    const m = ev.data;
    try {
      if (m.type === "hello") {
        hudPlan();
        if (state.sim?.snap) hudSnap(state.sim.snap);
      } else if (!state.sim?.snap) {
        ch.postMessage({ type: "note", text: "No EVA running: start one in Execute (simulator, live suit or drive window)." });
      } else if (m.type === "ack") onSnap(await call("simAck", { id: m.id ?? null }));
      else if (m.type === "silence") { await call("simSilence"); state.silenced = true; }
      else if (m.type === "pin") onSnap(await call("simPin", { note: m.note || "pin from the wrist cuff" }));
      else if (m.type === "return") onSnap(await call("simAbort"));
    } catch (e) { console.error(e); }
  };
  return ch;
}
function hudPlan() {
  const ch = hudChannel();
  if (!ch) return;
  const r = state.routes?.[state.selected];
  ch.postMessage({ type: "plan", site: state.site?.short ?? state.site?.name, siteId: state.site?.id, base: state.base,
    clock: state.site?.clock ?? null, profile: $("profile").value, routeName: state.selected, departMs: state.cfg?.departMs ?? null,
    route: r?.ok ? r.pts.filter((_, k) => k % 3 === 0).map((p) => [p.lon, p.lat]) : [],
    stations: routeStops().map(({ lon, lat, name, id }) => ({ lon, lat, name, id: id ?? null })),
    summary: r?.ok ? { t: r.t, dist: r.dist, doseMSv: r.doseMSv, minMargin: r.minMargin } : null,
    guidance: r?.ok ? r.legs.map((l) => ({ from: l.from, to: l.to, guidance: l.guidance })) : [],
    swx: state.swx ? { level: state.swx.level, headline: state.swx.headline } : null });
}
function hudSnap(s) {
  const ch = hudChannel();
  if (!ch) return;
  ch.postMessage({ type: "snap", snap: { t: s.t, ms: s.ms, lon: s.lon, lat: s.lat, sigma: s.sigma, remaining: s.remaining, margins: s.margins,
    back: s.back, dist: s.dist, returning: s.returning, done: s.done, los: s.los, shade: s.shade, alerts: s.alerts, counts: s.counts,
    station: s.station, stops: s.loop?.stops ?? null, livePlan: s.livePlan, returnPts: s.returnPts, rs: s.rs ?? null, live: !!s.live,
    res: s.res, cap: s.cap, track: s.track?.slice(-60) ?? null } });
}
function openDisplay(mode) {
  hudChannel();
  const size = { visor: "width=1280,height=720", rover: "width=1400,height=820", cuff: "width=480,height=860" }[mode];
  const w = window.open(new URL(`../hud.html?mode=${mode}`, import.meta.url).href, `marsnav-hud-${mode}`, `popup=yes,${size}`);
  if (!w) $("planMsg").innerHTML = '<span class="bad">The browser blocked the display window. Allow pop-ups for this page, then press the button again.</span>';
  else w.focus?.();
}

// ------------------------------------------------------------------------------------ 3D drive window link --
// The drive window (drive.html) is a telemetry source like a real suit: it sends TSS frames over a BroadcastChannel,
// the engine runs its closed loop on them (LiveSession), and every snapshot goes back so the walker sees the re-plans.
const DRIVE = "martian-map-drive";
function driveChannel() {
  if (state.driveCh) return state.driveCh;
  const ch = new BroadcastChannel(DRIVE);
  state.driveCh = ch;
  ch.onmessage = async (ev) => {
    const m = ev.data;
    try {
      if (m.type === "hello") sendDriveInit();
      else if (m.type === "start") {
        setMode("exec");
        $("telSrc").value = "drive";
        $("telSrc").dispatchEvent(new Event("change"));
        runSim(false);
        state.sim = null;
        if (!(await startSim())) { ch.postMessage({ type: "stopped" }); return; }
        runSim(true);
      } else if (m.type === "tss") {
        if (!state.sim?.live || !state.driveOn) return;
        state.liveQ = m;
        if (state.liveBusy) return;
        state.liveBusy = true;
        try {
          while (state.liveQ) {
            const f = state.liveQ;
            state.liveQ = null;
            const snap = await call("liveFrame", { eva: f.eva, rover: f.rover || null, wallS: f.wallS });
            onSnap(snap);
            ch.postMessage({ type: "snap", snap: { t: snap.t, est: snap.est, sigma: snap.sigma, margins: snap.margins, back: snap.back, remaining: snap.remaining,
              alerts: snap.alerts, counts: snap.counts, livePlan: snap.livePlan, returnPts: snap.returnPts, track: snap.track, events: snap.events,
              stops: snap.loop?.stops ?? snap.stops, returning: snap.returning, done: snap.done, station: snap.station, loop: { crossTrack: snap.loop?.crossTrack, cal: snap.loop?.cal, planVersion: snap.loop?.planVersion, lastReplan: snap.loop?.replans?.slice(-1)[0] ?? null } } });
            $("driveStatus").textContent = `LIVE from the drive window · ${snap.live?.frames ?? 0} frames · ${snap.live?.activity ?? ""}`;
          }
        } finally { state.liveBusy = false; }
      } else if (m.type === "profile") {
        $("profile").value = m.profile;
        runSim(false); state.sim = null;
        await runSetup(); await runPlan();
        sendDriveInit();
      } else if (m.type === "checkout") {
        const set = (id, v) => { if ($(id)) $(id).value = Math.round(100 * v); };
        set("hwO2", m.hw.o2Fill); set("hwBatt", m.hw.battSOH); set("hwWater", m.hw.waterFill); set("hwRBatt", m.hw.roverBattSOH);
        runSim(false); state.sim = null;
        await runSetup(); await runPlan();
        sendDriveInit();
      }
    } catch (e) { console.error(e); $("driveStatus").hidden = false; $("driveStatus").textContent = `Drive link error: ${e.message}`; }
  };
  return ch;
}

function sendDriveInit() {
  const r = state.routes?.[state.selected];
  const hw = state.cfg?.hw ?? {};
  driveChannel().postMessage({ type: "init", data: DATA, siteName: state.site?.short ?? state.site?.name, base: state.base, profile: $("profile").value,
    route: r?.ok ? r.pts.map((p) => [p.lon, p.lat]) : [], stations: routeStops().map(({ lon, lat, name }) => ({ lon, lat, name })),
    departMs: state.cfg?.departMs, tau: state.cfg?.tau, hw: { o2Fill: hw.o2Fill ?? 1, battSOH: hw.battSOH ?? 1, waterFill: hw.waterFill ?? 1, scrubCap: hw.scrubCap ?? 1, roverBattSOH: hw.roverBattSOH ?? 1 } });
}

function openDriveWindow() {
  if (!state.routes?.[state.selected]?.ok) $("planMsg").innerHTML = '<span class="warn">No feasible route yet: the drive window opens, but plan a route to walk it with the planner watching.</span>';
  driveChannel();
  const w = window.open(new URL("../drive.html", import.meta.url).href, "martian-map-drive", "popup=yes,width=1400,height=860");
  if (!w) { $("planMsg").innerHTML = '<span class="bad">The browser blocked the drive window. Allow pop-ups for this page, then press the button again.</span>'; return; }
  w.focus?.();
  $("telSrc").value = "drive";
  $("telSrc").dispatchEvent(new Event("change"));
  $("driveStatus").hidden = false;
  $("driveStatus").textContent = "Drive window open. Press Start EVA there; this window flies the closed loop on your telemetry.";
  setTimeout(sendDriveInit, 1500);
}

// live telemetry. The MarsNav server has the TSS bridge built in: POST /api/tss/start finds a NASA SUITS Telemetry
// Stream Server (last used, this computer, then a broadcast on the local networks), polls it over UDP and streams the
// frames here as Server-Sent Events (/api/tss/events). With no TSS anywhere, a built-in demo suit (a simulated crew
// member with a hidden truth, in the worker) produces the same TSS frames. Either way the frames go through the same
// closed loop (LiveSession), and every re-plan is uplinked (POST /api/tss/plan, where a helmet display can read it).
function liveStatus(msg) { $("liveStatus").textContent = msg; }
function setLiveBtn(on) {
  $("btnLive").textContent = on ? "Disable live telemetry" : "Enable live telemetry";
  $("btnLive").classList.toggle("primary", !on);
}
async function feedFrames(next) {
  if (state.liveBusy) return;
  state.liveBusy = true;
  try {
    let f;
    while ((f = next())) {
      const snap = await call("liveFrame", { eva: f.eva, rover: f.rover || null, wallS: f.wallS });
      if (!state.sim) break;
      onSnap(snap);
      if (snap.uplink) fetch("/api/tss/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snap.uplink) }).catch(() => null);
      liveStatus(`LIVE · TSS ${state.tssInfo?.tss ?? ""}${state.tssInfo?.year ? ` (TSS${state.tssInfo.year})` : ""} · ${snap.live.frames} frames · ${snap.live.activity}` +
        `${snap.live.unreported?.length ? ` · not reported: ${snap.live.unreported.join(", ")}` : ""}`);
    }
  } catch (e) { liveStatus(`Telemetry error: ${e.message}`); }
  state.liveBusy = false;
}
function streamTss(info) {
  state.tssInfo = info;
  const es = new EventSource("/api/tss/events");
  state.es = es;
  state.liveQ = null;
  liveStatus(`Found the TSS at ${info.tss} (TSS${info.year}, ${info.how}). Waiting for the first frame…`);
  es.addEventListener("status", (ev) => {
    const d = JSON.parse(ev.data);
    if (!d.ok && d.error) liveStatus(`TSS ${info.tss}: ${d.error} (still trying)`);
  });
  es.addEventListener("tss", (ev) => {
    state.liveQ = JSON.parse(ev.data);          // keep only the newest frame if the engine is still busy
    feedFrames(() => { const f = state.liveQ; state.liveQ = null; return f; });
  });
  es.onerror = () => liveStatus("Lost the MarsNav server (reconnecting)…");
}
async function startDemo() {
  const truth = $("demoTruth").value || "hardwork";
  const snap = await call("demoStart", { route: state.selected, truth, crew: $("telCrew").value, autoReplan: $("chkReplan").checked });
  state.sim.snap = snap;
  state.sim.demo = true;
  onSnap(snap);
  $("speedBox").hidden = false;
  state.demoTimer = setInterval(async () => {
    if (state.liveBusy || !state.sim?.running) return;
    state.liveBusy = true;
    try {
      const dt = parseFloat($("simSpeed").value) * 0.5;
      const s2 = await call("demoTick", { dt });
      if (!state.sim) return;
      onSnap(s2);
      liveStatus(`DEMO SUIT · hidden truth: ${s2.demo.truth} · ${s2.live.frames} TSS frames · ${s2.live.activity}${s2.demo.done ? " · EVA complete" : ""}`);
      if (s2.demo.done) { clearInterval(state.demoTimer); state.sim.running = false; setLiveBtn(false); }
    } catch (e) { liveStatus(`Demo suit error: ${e.message}`); }
    finally { state.liveBusy = false; }
  }, 500);
}
async function liveConnect(on) {
  state.es?.close();
  state.es = null;
  clearInterval(state.demoTimer);
  state.demoTimer = null;
  setLiveBtn(on);
  if (!on) {
    fetch("/api/tss/stop", { method: "POST" }).catch(() => null);
    liveStatus("Live telemetry off.");
    return;
  }
  const mode = $("tssMode").value;
  if (mode !== "demo") {
    const addr = mode === "addr" ? $("tssAddr").value.trim() : null;
    if (mode === "addr" && !addr) { liveStatus("Type the TSS address first (for example 192.168.1.20)."); setLiveBtn(false); state.sim.running = false; return; }
    if (addr) { try { localStorage.setItem("mm-tss-addr", addr); } catch { /* storage unavailable */ } }
    liveStatus(addr ? `Contacting the TSS at ${addr}…` : "Looking for a NASA SUITS TSS on this computer and your network…");
    let r = null;
    try {
      const res = await fetch("/api/tss/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ addr }) });
      r = await res.json();
    } catch { r = { ok: false, noServer: true }; }
    if (!state.sim?.running) return;               // switched off while searching
    if (r?.found) { streamTss(r); return; }
    if (mode === "addr") {
      liveStatus(`No TSS answered at ${addr}. Check the address and that the TSS is running and on the same network, or choose "Demo suit".`);
      state.sim.running = false; setLiveBtn(false);
      return;
    }
    liveStatus(r?.noServer ? "This copy is not served by MarsNav.exe, so it cannot reach a TSS: using the built-in demo suit."
      : `No TSS found (${r?.tried?.length ?? 0} places checked): using the built-in demo suit.`);
  }
  // demo suit: the live session was created by liveStart; replace it with the demo pair
  await startDemo();
}

function renderLoop(s) {
  const L = s.loop;
  if (!L?.cal) return;
  const c = L.cal, T = L.truth, pc = state.cfg?.cal || {};
  const ROWS = [["met", "Work rate (O₂ use)"], ["water", "Cooling water"], ["batt", "Suit battery"], ["co2", "CO₂ loading"], ["speed", "Walking pace"]];
  const cell = (v, sd) => {
    const d = Math.abs(v - 1), cls = d > 0.3 ? "bad" : d > 0.15 ? "warn" : "ok";
    return `<span class="num ${cls}">×${v.toFixed(2)}</span>${sd != null ? `<span class="num dim"> ±${sd.toFixed(2)}</span>` : ""}`;
  };
  // CO2 loading is learned as a total (metabolic x scrubber); show the truth the same way
  const truthOf = (k) => (k === "co2" ? (T.co2 ?? 1) * (T.met ?? 1) : T[k] ?? 1);
  const rows = ROWS.map(([k, name]) => `<tr><td>${name}</td><td class="num">×${(pc[k] ?? 1).toFixed(2)}</td><td>${cell(c[k] ?? 1, c.sd?.[k])}</td>${T ? `<td class="num dim">×${truthOf(k).toFixed(2)}</td>` : ""}</tr>`).join("");
  const stops = (L.stops || []).map((x) => `<span class="${x.done ? "ok" : x.dropped ? "bad" : ""}">${x.done ? "✓" : x.dropped ? "✗" : "○"} ${x.name.split(",")[0]}</span>`).join(" &nbsp;");
  const nav = `${L.navFix || "dead reckoning"} · ±${(2 * s.sigma).toFixed(0)} m (2σ)` +
    (L.crossTrack != null ? ` · ${L.crossTrack.toFixed(0)} m off plan` : L.truthErr != null ? ` · true error ${L.truthErr.toFixed(0)} m <span class="dim">(simulator only)</span>` : "");
  const rp = (L.replans || []).slice().reverse().map((r) => `<div>${fmtDuration(r.t).slice(0, 5)} ${r.ok ? "" : '<span class="bad">no route:</span> '}${r.reason}${r.dropped?.length ? `; dropped ${r.dropped.map((d) => d.split(",")[0]).join(", ")}` : ""} <span class="dim">(${r.ms} ms)</span></div>`).join("");
  $("loopBox").innerHTML = `<div class="tablewrap"><table class="t"><tr><th>Rate vs model</th><th>Plan</th><th>Learned</th>${T ? "<th>Truth</th>" : ""}</tr>${rows}</table></div>
    <div>Metabolic rate <span class="num">${c.metW != null ? `${c.metW.toFixed(0)} ± ${c.metSd.toFixed(0)} W` : "--"}</span> <span class="dim">(O₂ decay + heart rate)</span></div>
    <div>Position: ${nav}</div>
    <div>Plan <span class="num">v${L.planVersion}</span>${L.autoReplan ? "" : ' <span class="warn">(auto re-plan off)</span>'} · ${stops}</div>
    ${L.lastSlip != null ? `<div>Wheel slip last ${(100 * L.lastSlip).toFixed(0)} %${c.slipBias ? ` · learned sand +${(100 * (c.slipBias.w[1] + c.slipBias.w[3])).toFixed(0)} %` : ""}</div>` : ""}
    ${rp ? `<div class="log" style="max-height:110px;margin-top:4px">${rp}</div>` : '<div class="dim">No re-plans: telemetry agrees with the plan.</div>'}
    ${T ? `<p class="note" style="margin-top:4px">Truth column: what the simulator is really doing (${T.label}). The engine only sees TSS-format telemetry.</p>` : ""}`;
  if (s.done || s.returning) state.lastCal = c;
  $("btnCarry").disabled = !state.lastCal;
}

const GAUGES = [["o2", "Oxygen"], ["co2", "CO₂ scrub"], ["water", "Cooling H₂O"], ["batt", "Battery"]];

function onSnap(s) {
  state.sim.snap = s;
  hudSnap(s);
  state.simCrew = { lon: s.lon, lat: s.lat, sigma: s.sigma, ellipse: s.ellipse };
  state.map.crew = state.simCrew;
  state.map.returnPts = s.returnPts;
  state.map.livePlan = s.returnPts ? null : s.livePlan;
  renderLoop(s);
  state.map.track = s.track;
  state.map.draw();
  state.tl.now = s.t;
  state.tl.draw();
  // HUD glance band
  const worst = Math.min(s.margins.o2, s.margins.co2, s.margins.water, s.margins.batt);
  const cls = marginClass(worst);
  $("hud").innerHTML = [
    ["MET", fmtDuration(s.t).slice(0, 5), ""], ["Walk home", Number.isFinite(s.back) ? fmtDuration(s.back).slice(0, 5) : "--", ""], ["Walkback margin", `<span class="${cls}">${(100 * worst).toFixed(0)}</span>`, "%"],
    ["O₂ left", (100 * s.remaining.o2).toFixed(0), "%"], ["Position", `±${(2 * s.sigma).toFixed(0)}`, "m"],
    ["Radio", s.los ? "LOS" : '<span class="warn">NONE</span>', ""], ["Mode", s.returning ? '<span class="bad">RETURN</span>' : s.done ? "DONE" : s.station ? "STATION" : "TRAVERSE", ""],
  ].map(([k, v, u]) => `<div class="cell"><span class="lbl">${k}</span><span class="big">${v}<span class="unit">${u}</span></span></div>`).join("");
  document.querySelector(".mapwrap").style.setProperty("--hud-h", `${$("hud").offsetHeight}px`);
  // gauges
  $("gauges").innerHTML = GAUGES.map(([k, name]) => {
    const used = 1 - s.remaining[k];
    const need = used + (1 - s.margins[k] - used);
    const col = s.margins[k] < 0 ? "var(--warning)" : s.margins[k] < 0.2 ? "var(--caution)" : "var(--nominal)";
    return `<div class="gauge"><span>${name}</span><div class="track"><div class="fill" style="width:${Math.min(100, 100 * used)}%;background:${col}"></div>
      <div class="ret" style="left:${Math.min(99.5, 100 * need)}%"></div></div><span class="num">${(100 * s.remaining[k]).toFixed(0)}%</span></div>`;
  }).join("");
  // station procedure: current and completed steps visible
  $("proc").innerHTML = s.station
    ? `<strong>${s.station.name}</strong> <span class="num">${fmtDuration(s.station.done).slice(0, 5)} / ${fmtDuration(s.station.total).slice(0, 5)}</span><ol>${s.station.steps
      .map((x, k) => `<li class="${k < s.station.step ? "done" : k === s.station.step ? "cur" : ""}">${x}</li>`).join("")}</ol>`
    : "Shown while working at a station.";
  state.map.pins = s.pins;
  // alerts
  const box = $("alerts");
  box.innerHTML = s.alerts.length ? "" : '<p class="note">No active alerts.</p>';
  const ICON = { 3: "▲", 2: "■", 1: "●" };
  for (const a of s.alerts) {
    const d = document.createElement("div");
    d.className = `alert l${a.level}${a.acked ? " acked" : ""}${a.cleared ? " cleared" : ""}`;
    d.innerHTML = `<span aria-hidden="true">${ICON[a.level]}</span><div><div>${a.text}${a.cleared ? ' <span class="clr">CLEARED</span>' : ""}</div><div class="act">${a.cleared ? "Condition no longer present - acknowledge to remove" : a.action}</div></div>${a.acked ? "" : `<button data-ack="${a.id}">ACK</button>`}`;
    box.appendChild(d);
  }
  box.querySelectorAll("[data-ack]").forEach((b) => b.addEventListener("click", async () => onSnap(await call("simAck", { id: b.dataset.ack }))));
  const c = s.counts;
  setCount("cntW", "w", "W", c[3]);
  setCount("cntC", "c", "C", c[2]);
  setCount("cntA", "a", "A", c[1]);
  // tones and speech for newly raised alerts
  for (const a of s.raised || []) {
    if (!state.silenced || a.level === 3) tone(a.level);
    if ($("chkVoice").checked && !state.lastSpoken.has(a.id + a.level)) { speak(`${["", "Advisory", "Caution", "Warning"][a.level]}. ${a.text}. ${a.action}.`); state.lastSpoken.add(a.id + a.level); }
  }
  if ((s.raised || []).some((a) => a.level === 3)) state.silenced = false;
}

function setCount(id, cls, letter, n) {
  const el = $(id);
  el.textContent = `${letter} ${n}`;
  el.className = `pill ${n ? cls : "off"}`;
}

// ----------------------------------------------------------------------------------------------------- tour --
// A guided walkthrough for first-time users and judges: each step sets the app up, then explains what is on screen.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TOUR = [
  { t: "Real Mars, real data", sel: "#clock", x: "The live Mars clock runs on NASA's Mars24 algorithm: mission sol, local solar time, season (Ls), the sun, and the radio delay to Earth. The map is built from HiRISE 1 m and CTX 20 m elevation models, and the demonstration site is Perseverance's own.",
    go: async () => { setMode("plan"); document.querySelector("input[name=ov][value=hazard]").click(); } },
  { t: "The ground a boot meets", sel: "#layers", x: "Walking-scale slope, steps and sand ripples are measured in the 1 m terrain models, not the 20 m ones. Purple is hazard; hatched is no-go (a hard limit, never traded against time).",
    go: async () => { document.querySelector("input[name=ov][value=sand]").click(); } },
  { t: "Never out of reach of home", sel: "#layers", x: "Walkback time: from every point, how long the walk home takes and what it costs in oxygen, water and battery. No planned route ever goes where the crew could not walk back with what is left.",
    go: async () => { document.querySelector("input[name=ov][value=walkback]").click(); } },
  { t: "Five named routes", sel: "#cards", x: "Balanced, safest, fastest, lowest consumption and a fallback in a different corridor. Each shows time, distance, O2, water, battery, the worst walkback margin, radiation dose and data confidence.",
    go: async () => { document.querySelector("input[name=ov][value=hazard]").click(); $("zoomFit").click(); } },
  { t: "Walk it before you walk it", sel: "#view3d", x: "The 3D view walks the planned route at eye height on the real terrain, with the crater rim on the skyline and the walk-home margin at every step.",
    go: async () => { await open3D(); document.querySelector("[data-v3=helmet]").click(); state.v3?.setFly(0.3); update3DInfo(); } },
  { t: "Flying the EVA", sel: "#hud", x: "Execute reads suit telemetry (NASA's SUITS format; simulated here, live through the bridge), learns how hard the crew is really working, and re-plans from where they are. Watch a suit leak: a WARNING sounds and the plan turns into the walk-home route by itself.",
    go: async () => { $("view3d").hidden = true; state.v3?.play(false); setMode("exec"); await wait(300); $("simSpeed").value = "600"; runSim(true); await wait(3500);
      onSnap(await call("simInject", { kind: "leak" })); } },
  { t: "Checked against Perseverance", sel: "#validation", x: "Review compares plan and flight, prints the paper cue card, and shows the validation against the rover's own records, including the result that did not come out in our favour.",
    go: async () => { runSim(false); setMode("review"); } },
];
let tourK = -1;
async function tourShow(k) {
  document.querySelectorAll(".tour-hl").forEach((e) => e.classList.remove("tour-hl"));
  if (k < 0 || k >= TOUR.length) { $("tour").hidden = true; tourK = -1; return; }
  tourK = k;
  const st = TOUR[k];
  $("tour").hidden = false;
  $("tourStep").textContent = `STEP ${k + 1} OF ${TOUR.length}`;
  $("tourTitle").textContent = st.t;
  $("tourText").textContent = st.x;
  $("tourBack").disabled = k === 0;
  $("tourNext").textContent = k === TOUR.length - 1 ? "Finish" : "Next";
  if (st.sel === "#layers") state.setLayersOpen?.(true);
  try { await st.go(); } catch (e) { console.error(e); }
  if (tourK === k) document.querySelector(st.sel)?.classList.add("tour-hl");
}

// ------------------------------------------------------------------------------------------------------- 3D --
async function open3D() {
  const r = state.routes?.[state.selected];
  $("view3d").hidden = false;
  busy(true, "Building 3D terrain…");
  state.v3 ??= new View3D($("view3d"), call, state.map);
  state.v3.onStatus = (msg) => { $("v3info").textContent = msg ?? ""; if (!msg) update3DInfo(); };
  let ok = false, why = "";
  const ctx3d = () => ({
      grid: state.meta.grid, imagery: state.meta.imagery, base: state.base,
      route: r?.ok ? r.pts : state.map.diag?.pts ?? null,
      stations: state.map.stations?.length ? state.map.stations : state.stations,
      pins: state.sim?.snap?.pins ?? [], diag: state.map.diag, ms: state.cfg?.departMs ?? Date.now(),
    });
  try {
    // after a graphics reset the browser blocks 3D for this page for a short while ("Web page caused context loss and
    // was blocked"): retry for up to ~20 s on a fresh canvas instead of failing at the first attempt
    for (let attempt = 0; attempt < 12; attempt++) {
      ok = await state.v3.open(ctx3d());
      if (ok) break;
      if (!/blocked|context/i.test(state.v3.initError || "")) break;
      busy(true, `The browser paused 3D after a graphics reset; retrying (${attempt + 1}/12)…`);
      await new Promise((res) => setTimeout(res, 1800));
    }
    if (!ok) why = /blocked/i.test(state.v3.initError || "")
      ? "The browser has blocked 3D for this page after a graphics memory error. Reload the page (Ctrl+R) and open 3D again."
      : "3D view needs WebGL, which this browser has turned off (check that hardware acceleration is on in the browser settings).";
  } catch (e) {
    console.error(e);
    why = `3D view could not be built: ${e.message}`;
  } finally {
    busy(false);
  }
  if (!ok) { $("view3d").hidden = true; $("planMsg").innerHTML = `<span class="bad">${why}</span>`; return; }
  $("view3d").scrollIntoView?.({ block: "nearest" });
  update3DInfo();
}

function update3DInfo() {
  const v = state.v3;
  if (!v) return;
  const s = v.sunInfo;
  const r = state.routes?.[state.selected];
  let txt = `True scale${v.exag > 1 ? " (relief x2)" : ""} · 10 m terrain, 2 m HiRISE relief · sun ${s.elevation.toFixed(0)}° el, ${s.azimuth.toFixed(0)}° az`;
  if (v.mode === "helmet" && r?.ok) {
    const k = Math.min(r.pts.length - 1, Math.round(v.flyT * (r.pts.length - 1)));
    const p = r.pts[k];
    txt = `EYE 1.8 m · ${(p.dist / 1000).toFixed(2)} km · MET ${fmtDuration(p.t).slice(0, 5)} · grade ${p.grade.toFixed(0)}° · walk home ${fmtDuration(p.back).slice(0, 5)} · margin ${(100 * Math.min(p.margins.o2, p.margins.co2, p.margins.water, p.margins.batt)).toFixed(0)} %`;
  }
  $("v3info").textContent = txt;
}

// offline intent parser: short questions in plain words -> one intent (answers come only from known state)
function parseAsk(text) {
  const t = (text || "").toLowerCase();
  const rules = [["pin", /\b(drop|mark|pin)\b/], ["where", /\bwhere|position|location|am i\b/], ["home", /\bhome|habitat|walk ?back|return\b/],
    ["o2", /\bo2|oxygen\b/], ["water", /\bwater|cool/], ["batt", /\bbatt|power|energy\b/], ["co2", /\bco2|scrub/],
    ["next", /\bnext|station|stop|target\b/], ["sun", /\bsun|sunset|dark|daylight\b/], ["alerts", /\balert|warning|caution\b/]];
  for (const [k, re] of rules) if (re.test(t)) return k;
  return "unknown";
}

async function dropPin(note = "") {
  if (!state.sim && !(await startSim())) return;
  const s = await call("simPin", { note: typeof note === "string" ? note : "" });
  onSnap(s);
  const p = s.pins[s.pins.length - 1];
  const msg = `Pin ${s.pins.length} dropped at ${p.lat.toFixed(4)} north, ${p.lon.toFixed(4)} east, plus or minus ${Math.round(2 * p.sigma)} metres.`;
  $("voiceOut").textContent = msg;
  if ($("chkVoice").checked) speak(msg);
}

function answer(q) {
  if (q === "pin") { dropPin(); return; }
  const s = state.sim?.snap;
  if (!s) { $("voiceOut").textContent = "Not available: start the EVA first."; return; }
  const pct = (v) => Math.round(100 * v);
  const worst = Math.min(s.margins.o2, s.margins.water, s.margins.batt, s.margins.co2);
  const res = { o2: "Oxygen", water: "Cooling water", batt: "Suit battery", co2: "CO2 scrubber" };
  let msg;
  if (q === "where") msg = `Position ${s.lat.toFixed(4)} north, ${s.lon.toFixed(4)} east, plus or minus ${Math.round(2 * s.sigma)} metres.`;
  else if (q === "home") msg = `${Math.round(s.back / 60)} minutes to the habitat on foot. Walkback margin ${pct(worst)} percent.`;
  else if (res[q]) msg = `${res[q]} ${pct(s.remaining[q])} percent remaining. ${s.margins[q] > 0 ? "Enough to walk home." : "Return now."}`;
  else if (q === "next") msg = s.station ? `Working at ${s.station.name}, step ${s.station.step + 1} of ${s.station.steps.length}: ${s.station.steps[s.station.step]}.` : s.returning ? "Returning to the habitat." : "Walking to the next station.";
  else if (q === "sun") msg = `Sunset in ${Math.round((state.setup.sunsetMs - s.ms) / 60000)} minutes.`;
  else if (q === "alerts") msg = s.alerts.length ? `${s.alerts.length} alerts. Highest: ${s.alerts[0].text}.` : "No active alerts.";
  else msg = "Not understood. Ask about oxygen, water, battery, time home, position, next stop, sunset or alerts.";
  $("voiceOut").textContent = msg;
  if ($("chkVoice").checked) speak(msg);
}

// ---------------------------------------------------------------------------------------------------- review --
async function renderReview() {
  const v = state.meta.validation;
  $("validation").innerHTML = v ? v.html : "No rover ground truth at this site. Validation against Perseverance data is on the Jezero site (node validation/validate.mjs).";
  const log = await call("simLog");
  const lines = [...log.events.map((e) => [e.t, e.event]), ...log.alerts.map((a) => [a.t, `${a.event}: ${a.text || a.id}`])].sort((a, b) => a[0] - b[0]);
  $("evLog").innerHTML = lines.length ? lines.map(([t, x]) => `<div>${fmtDuration(t)} ${x}</div>`).join("") : '<p class="note">No EVA flown yet.</p>';
  const s = state.sim?.snap, r = state.routes?.[state.selected];
  if (s && r?.ok) {
    $("aar").innerHTML = `<div class="tablewrap"><table class="t"><tr><th></th><th>Planned</th><th>Flown</th></tr>
      <tr><td>Duration</td><td class="num">${fmtDuration(r.t)}</td><td class="num">${fmtDuration(s.t)}</td></tr>
      <tr><td>Distance</td><td class="num">${(r.dist / 1000).toFixed(2)} km</td><td class="num">${(s.dist / 1000).toFixed(2)} km</td></tr>
      <tr><td>O₂</td><td class="num">${r.res.o2.toFixed(2)} kg</td><td class="num">${s.res.o2.toFixed(2)} kg</td></tr>
      <tr><td>Water</td><td class="num">${r.res.water.toFixed(2)} kg</td><td class="num">${s.res.water.toFixed(2)} kg</td></tr>
      <tr><td>Battery</td><td class="num">${r.res.batt.toFixed(0)} Wh</td><td class="num">${s.res.batt.toFixed(0)} Wh</td></tr>
      <tr><td>Outcome</td><td>${r.legs.length} legs</td><td>${s.returning ? "contingency return" : s.done ? "complete" : "in progress"}</td></tr></table></div>`;
  }
}

function fillProvenance() {
  const m = state.meta, si = m.site, q = m.quality || {};
  const hv = q.hirise_vs_ctx, bl = q.dem_blunders;
  const hi = si.hires_dtms?.length ? ` and 1 m stereo DTMs (${si.hires_dtms.join(", ")})` : "";
  $("prov").innerHTML = `<ul style="margin:0 0 0 18px;padding:0">
  <li>Site: ${si.name}. ${si.description ?? ""}</li>
  <li>Elevation: ${si.regional_dem ?? "regional DEM"}${hi}, blended at 10 m${hv ? `; 1 m DTMs and the regional DEM agree to ${hv.mean_m.toFixed(1)} ± ${hv.sd_m.toFixed(1)} m` : ""}.
    ${bl ? `DEM blunder screen flagged ${bl.cells} cells (${(100 * bl.frac).toFixed(2)} %) as unreliable.` : ""}
    ${si.calibration_site && si.calibration_site !== si.id ? `Walking-scale slope calibrated at ${si.calibration_site} (no 1 m DTM here).` : ""}</li>
  <li>Imagery: ${m.imagery?.ortho5?.source ?? "-"}; ${m.imagery?.hi2?.source ?? ""}.</li>
  <li>Weather: ${m.climSource ?? "fallback diurnal model"}.</li>
  ${m.traverse ? `<li>Traverse: NASA Mars 2020 waypoint feed, sol ${m.traverse.firstSol} to ${m.traverse.lastSol}.</li>` : ""}
  <li>Sun and calendar: Mars24 algorithm (NASA GISS); ${state.clock.name} sols at ${state.clock.lonEast.toFixed(3)}° E.</li></ul>`;
}

// ---------------------------------------------------------------------------------------------------- export --
async function cueCard() {
  if (!state.routes?.[state.selected]?.ok) return;
  const html = await call("cuecard", { route: state.selected, title: state.stations.map((s) => s.name).join(" / ") });
  openModal("EVA cue card", `<iframe title="EVA cue card" sandbox="" srcdoc="${html.replace(/"/g, "&quot;")}"></iframe>`, html, "eva_cue_card.html", "text/html");
}

async function geoJSON() {
  const gj = await call("geojson");
  const txt = JSON.stringify(gj, null, 1);
  openModal("Routes (GeoJSON)", `<textarea readonly id="gjText">${txt.replace(/</g, "&lt;")}</textarea>`, txt, "martian_map_routes.geojson", "application/geo+json");
}

function openModal(title, bodyHTML, text, filename, mime) {
  $("modalTitle").textContent = title;
  $("modalBody").innerHTML = bodyHTML;
  $("modal").hidden = false;
  $("modalCopy").onclick = async () => {
    try { await navigator.clipboard.writeText(text); $("modalCopy").textContent = "Copied"; } catch { $("modalCopy").textContent = "Copy blocked"; }
    setTimeout(() => ($("modalCopy").textContent = "Copy"), 1500);
  };
  $("modalSave").hidden = IN_FRAME; // embedded viewers block page-started downloads: Copy is the path there
  $("modalSave").onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: mime }));
    a.download = filename;
    a.click();
  };
}

// standalone deployments run fully offline after the first load; embedded viewers do not allow service workers
if (!IN_FRAME && "serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register(new URL("../sw.js", import.meta.url), { updateViaCache: "none" }).catch(() => { /* optional */ });
  // a newer service worker took over (e.g. after an update): reload once so every script comes from the same version
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    let done = false;
    try { done = sessionStorage.getItem("mm-sw-reload") === "1"; sessionStorage.setItem("mm-sw-reload", "1"); } catch { /* private mode */ }
    if (!reloaded && !done) { reloaded = true; location.reload(); }
  });
}

boot();
