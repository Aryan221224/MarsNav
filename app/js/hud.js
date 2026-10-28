// hud.js - the EVA on the displays a Mars crew carries, fed live by the planner (main.js) over a BroadcastChannel:
//   visor  heads-up display on the helmet visor: heading tape, steering cue to the next stop, walk-home time and margin,
//          consumables with the walk-home need marked, alerts, the station procedure step, a mini map
//   rover  dashboard of the crew rover: speed, heading, slope ahead, power and range, route map, alerts
//   cuff   wrist tablet: next stop with the rover's own photograph of it, procedure checklist, big numbers, and the
//          commands a gloved hand needs (acknowledge, silence, drop a pin, two-step return)
// ?mode=visor|rover|cuff picks one; ?overlay=1 draws the visor see-through over another view (the drive window).
import { marsContext, missionClock, M2020_CLOCK } from "../engine/marstime.js";
import { fmtDuration } from "../engine/util.js";

const $ = (id) => document.getElementById(id);
const R_MARS = 3396190;
const DEG = Math.PI / 180;
const qs = new URLSearchParams(location.search);
const S = { mode: qs.get("mode") || "visor", plan: null, snap: null, hist: [], clock: M2020_CLOCK, armed: 0, last: 0 };
if (qs.get("overlay") === "1") document.body.classList.add("overlay");

// ------------------------------------------------------------------------------------------------ channel ----
const CH = new BroadcastChannel("marsnav-hud");
CH.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === "plan") {
    S.plan = m;
    S.clock = m.clock ? missionClock(m.clock) : M2020_CLOCK;
    S.hist = [];
  } else if (m.type === "snap") {
    S.snap = m.snap;
    S.last = Date.now();
    const p = m.snap;
    if (Number.isFinite(p.lon)) {
      const h = S.hist;
      if (!h.length || p.t < h[h.length - 1].t) h.length = 0;              // a new EVA started
      h.push({ t: p.t, lon: p.lon, lat: p.lat });
      while (h.length > 120) h.shift();
    }
  } else if (m.type === "note") {
    flashNote(m.text);
  }
  render();
};
const hello = () => { if (!S.plan) { CH.postMessage({ type: "hello" }); setTimeout(hello, 2000); } };
hello();
setInterval(render, 1000);                                                   // the clock and the link state age on their own

// ------------------------------------------------------------------------------------------------- geometry --
function local(lon, lat) {
  const b = S.plan?.base ?? { lon, lat };
  return [((((lon - b.lon) + 540) % 360) - 180) * Math.cos(b.lat * DEG) * R_MARS * DEG, (lat - b.lat) * R_MARS * DEG];
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const bearing = (a, b) => ((Math.atan2(b[0] - a[0], b[1] - a[1]) / DEG) + 360) % 360;

/** Heading and ground speed from the recent positions (telemetry carries no compass): the last 30 s of mission time. */
function motion() {
  const h = S.hist;
  if (h.length < 2) return { heading: null, speed: 0 };
  const b = h[h.length - 1];
  let a = null;
  for (let k = h.length - 2; k >= 0; k--) {
    if (dist(local(h[k].lon, h[k].lat), local(b.lon, b.lat)) > 3) { a = h[k]; if (b.t - h[k].t >= 30) break; }
  }
  if (!a) return { heading: S.heading ?? null, speed: 0 };
  const pa = local(a.lon, a.lat), pb = local(b.lon, b.lat);
  S.heading = bearing(pa, pb);
  return { heading: S.heading, speed: b.t > a.t ? dist(pa, pb) / (b.t - a.t) : 0 };
}

/** The next destination: the first stop not yet done (or dropped), else the habitat. */
function nextStop() {
  const P = S.plan, s = S.snap;
  if (!P) return null;
  const home = { name: P.base?.name || "Habitat", lon: P.base.lon, lat: P.base.lat, home: true };
  if (!s || s.returning || s.done) return home;
  const done = new Set((s.stops || []).filter((x) => x.done || x.dropped).map((x) => x.name));
  return P.stations.find((x) => !done.has(x.name)) ?? home;
}

/** The path the crew should be on now: the return route, else the re-planned route, else the filed plan. */
function activePath() {
  const s = S.snap;
  if (s?.returnPts?.length) return { pts: s.returnPts, kind: "return" };
  if (s?.livePlan?.length) return { pts: s.livePlan.map((p) => [p.lon, p.lat]), kind: "replan" };
  return { pts: S.plan?.route || [], kind: "plan" };
}

const MARGIN_CLS = (m) => m < 0 ? "c-warning" : m < 0.2 ? "c-caution" : "";
const hm = (s) => Number.isFinite(s) ? fmtDuration(s).slice(0, 5) : "--:--";
const topAlert = (s) => (s?.alerts || []).filter((a) => !a.cleared).sort((a, b) => (b.level - a.level) || (a.acked - b.acked))[0] ?? null;
const RES = [["o2", "O₂"], ["co2", "CO₂"], ["water", "H₂O"], ["batt", "BATT"]];
const worstMargin = (s) => Math.min(s.margins.o2, s.margins.co2, s.margins.water, s.margins.batt);

// --------------------------------------------------------------------------------------------------- render --
function render() {
  document.body.dataset.mode = S.mode;
  for (const b of document.querySelectorAll("#modes [data-mode]")) b.setAttribute("aria-checked", String(b.dataset.mode === S.mode));
  const ready = !!S.plan;
  document.body.classList.toggle("ready", ready);
  const age = (Date.now() - S.last) / 1000;
  const link = $("link");
  link.textContent = !S.snap ? (ready ? "plan received · no EVA running" : "waiting for the planner")
    : age > 10 ? `no update for ${Math.round(age)} s` : `${S.snap.live ? "live telemetry" : "simulator"} · ${S.plan?.site ?? ""}`;
  link.className = `link ${S.snap && age <= 10 ? (S.snap.live ? "live" : "sim") : ""}`;
  if (!ready) return;
  const ctx = marsContext(S.snap?.ms ?? Date.now(), S.plan.base.lon, S.plan.base.lat, S.clock);
  const mo = motion();
  const nx = nextStop();
  const here = S.snap ? local(S.snap.lon, S.snap.lat) : [0, 0];
  const there = nx ? local(nx.lon, nx.lat) : here;
  const nav = { here, there, d: dist(here, there), brg: bearing(here, there), ...mo, nx, ctx };
  if (S.mode === "visor") visor(nav);
  else if (S.mode === "rover") rover(nav);
  else cuff(nav);
}

// ---------------------------------------------------------------------------------------------------- visor --
function visor(n) {
  const s = S.snap;
  tape($("vTape"), n);
  const rel = n.heading == null ? 0 : (((n.brg - n.heading) + 540) % 360) - 180;
  const arrow = $("vArrow");
  arrow.setAttribute("transform", `rotate(${rel.toFixed(1)})`);
  arrow.classList.toggle("home", !!n.nx?.home);
  const eta = n.speed > 0.15 ? n.d / n.speed : null;
  $("vNext").innerHTML = n.nx ? `${n.nx.home ? "HOME · " : ""}${esc(n.nx.name)}<small>${fmtM(n.d)} · ${Math.round(n.brg)}°${eta ? ` · ${hm(eta)}` : ""}${n.heading == null ? "" : rel > 8 ? " · turn right" : rel < -8 ? " · turn left" : " · ahead"}</small>` : "--";
  if (!s) {
    $("vLeft").innerHTML = "";
    $("vRight").innerHTML = `<div class="vrow"><span class="k">EVA</span><span class="v">not started</span></div>`;
    $("vMode").textContent = "PRE-EVA";
    return;
  }
  $("vLeft").innerHTML = RES.map(([k, name]) => {
    const rem = s.remaining[k], m = s.margins[k], need = Math.max(0, rem - m);
    return `<div class="vbar ${MARGIN_CLS(m)}"><span>${name}</span><span class="tr"><span class="fill" style="width:${pct(rem)}%"></span>
      <span class="need" style="left:${pct(need)}%"></span></span><span>${Math.round(100 * rem)}%</span></div>`;
  }).join("") + `<div class="vrow" style="margin-top:6px"><span class="k">Tick = needed to walk home</span></div>`;
  const wm = worstMargin(s);
  const dose = S.plan.summary?.t ? S.plan.summary.doseMSv * Math.min(1.5, s.t / S.plan.summary.t) : null;
  $("vRight").innerHTML = [
    ["Walk home", hm(s.back), ""], ["Margin", `<span class="${MARGIN_CLS(wm)}">${Math.round(100 * wm)}</span>`, "%"],
    ["MET", hm(s.t), ""], ["Position", `±${Math.round(2 * s.sigma)}`, " m"],
    ["Comm", s.los ? "LOS" : '<span class="c-caution">NONE</span>', ""],
    ["Sun", `${n.ctx.sun.elevation.toFixed(0)}°`, s.rs?.sunsetMinLeft != null ? ` · set ${hm(s.rs.sunsetMinLeft * 60)}` : ""],
    ["Dose", dose != null ? dose.toFixed(2) : "--", " mSv"],
  ].map(([k, v, u]) => `<div class="vrow"><span class="k">${k}</span><span class="v">${v}<small>${u}</small></span></div>`).join("");
  const a = topAlert(s);
  const al = $("vAlert");
  al.className = a && !a.acked ? `l${a.level}` : "";
  al.innerHTML = a && !a.acked ? `${["", "ADVISORY", "CAUTION", "WARNING"][a.level]} · ${esc(a.text)}<span class="act">${esc(a.action)}</span>` : "";
  $("vProc").innerHTML = s.station ? `<b>${esc(s.station.name)}</b> · step ${s.station.step + 1}/${s.station.steps.length}: ${esc(s.station.steps[s.station.step])} · ${hm(s.station.done)} / ${hm(s.station.total)}` : "";
  const tag = $("vMode");
  tag.textContent = s.returning ? "RETURN" : s.done ? "EVA DONE" : s.station ? "STATION" : "TRAVERSE";
  tag.classList.toggle("ret", !!s.returning);
  miniMap($("vMini"), n, { visor: true });
}

/** Heading tape: the 120 deg ahead, with the next stop (diamond), home (H) and the sun. */
function tape(cv, n) {
  const W = cv.clientWidth, H = cv.clientHeight, dpr = window.devicePixelRatio || 1;
  if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const hd = n.heading ?? 0, span = 120, px = W / span;
  const col = getComputedStyle(document.body).getPropertyValue("--hud").trim() || "#9dffcf";
  g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 1.5;
  g.font = "13px 'IBM Plex Mono', monospace"; g.textAlign = "center";
  const x = (b) => W / 2 + ((((b - hd) + 540) % 360) - 180) * px;
  for (let b = Math.floor((hd - span / 2) / 5) * 5; b <= hd + span / 2; b += 5) {
    const bb = (b + 360) % 360, X = x(bb);
    const major = bb % 30 === 0;
    g.beginPath(); g.moveTo(X, 30); g.lineTo(X, major ? 18 : 25); g.stroke();
    if (major) g.fillText({ 0: "N", 90: "E", 180: "S", 270: "W" }[bb] ?? String(bb).padStart(3, "0"), X, 13);
  }
  g.beginPath(); g.moveTo(W / 2 - 7, 46); g.lineTo(W / 2, 36); g.lineTo(W / 2 + 7, 46); g.stroke();
  g.font = "600 15px 'IBM Plex Mono', monospace";
  g.fillText(n.heading == null ? "---" : String(Math.round(hd) % 360).padStart(3, "0"), W / 2, 62);
  g.font = "13px 'IBM Plex Mono', monospace";
  const mark = (b, draw) => { const X = x(b); if (X > 4 && X < W - 4) draw(X); };
  mark(n.brg, (X) => { g.beginPath(); g.moveTo(X, 30); g.lineTo(X + 6, 37); g.lineTo(X, 44); g.lineTo(X - 6, 37); g.closePath(); g.stroke(); });
  if (S.plan && !n.nx?.home) {
    const hb = bearing(n.here, local(S.plan.base.lon, S.plan.base.lat));
    mark(hb, (X) => g.fillText("H", X, 44));
  }
  if (n.ctx.sun.elevation > -2) mark(n.ctx.sun.azimuth, (X) => { g.beginPath(); g.arc(X, 38, 5, 0, 2 * Math.PI); g.stroke(); });
}

// ---------------------------------------------------------------------------------------------------- rover --
function rover(n) {
  const s = S.snap;
  const vehicle = S.plan.profile !== "foot";
  speedGauge($("rSpeed"), n.speed * 3.6, vehicle ? 15 : 6);
  $("rHead").textContent = n.heading == null ? "---°" : `${String(Math.round(n.heading) % 360).padStart(3, "0")}°`;
  $("rSlope").innerHTML = s?.rs ? `<span class="${s.rs.slopeAhead > 15 ? "c-caution" : ""}">${s.rs.slopeAhead.toFixed(1)}°</span>` : "--";
  $("rXt").textContent = s?.rs?.crossTrack != null ? `${Math.round(s.rs.crossTrack)} m` : "--";
  $("rSig").textContent = s ? `±${Math.round(2 * s.sigma)} m (2σ)` : "--";
  $("rLos").innerHTML = s ? (s.los ? "line of sight" : `<span class="c-caution">none${s.rs?.losLostMin ? ` · ${Math.round(s.rs.losLostMin)} min` : ""}</span>`) : "--";
  const eta = n.speed > 0.15 ? n.d / n.speed : null;
  $("rNext").textContent = n.nx ? `${n.nx.home ? "Home: " : ""}${n.nx.name} · ${fmtM(n.d)} at ${Math.round(n.brg)}°${eta ? ` · ${hm(eta)}` : ""}` : "--";
  $("rMet").textContent = s ? hm(s.t) : "--";
  $("rSun").textContent = s?.rs?.sunsetMinLeft != null ? hm(s.rs.sunsetMinLeft * 60) : "--";
  if (s) {
    const wm = worstMargin(s);
    $("rBack").textContent = hm(s.back);
    $("rMargin").innerHTML = `<span class="${MARGIN_CLS(wm)}">${Math.round(100 * wm)} %</span>`;
    const rb = s.cap?.rbatt ? 1 - (s.res?.rbatt ?? 0) / s.cap.rbatt : null;
    $("rPower").innerHTML = rb != null
      ? gauge2("Rover battery", rb, null) + `<div class="hint">${((s.cap.rbatt - (s.res?.rbatt ?? 0)) / 1000).toFixed(1)} kWh left of ${(s.cap.rbatt / 1000).toFixed(1)}</div>`
      : `<div class="hint">${vehicle ? "No rover battery in this telemetry." : "On foot: no rover on this EVA (switch the crew mode to rover in the planner)."}</div>`;
    $("rCrew").innerHTML = RES.map(([k, name]) => gauge2(name, s.remaining[k], Math.max(0, s.remaining[k] - s.margins[k]), s.margins[k])).join("");
    $("rAlerts").innerHTML = (s.alerts || []).length ? s.alerts.map((a) => `<div class="al l${a.level}${a.acked ? " acked" : ""}">${esc(a.text)}<br><small>${esc(a.action)}</small></div>`).join("")
      : `<div class="hint">No active alerts.</div>`;
  }
  const cv = $("rMap");
  const W = cv.clientWidth, H = cv.clientHeight, dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  miniMap(cv, n, { visor: false });
  $("rMapNote").textContent = `${S.plan.site} · ${{ return: "return route", replan: "re-planned route", plan: "filed plan" }[activePath().kind]} · north up`;
}

function gauge2(name, rem, need, margin) {
  const cls = margin == null ? "" : MARGIN_CLS(margin);
  return `<div class="gauge2 ${cls}"><span>${name}</span><span class="num">${Math.round(100 * rem)} %</span><span class="tr"><span class="fill" style="width:${pct(rem)}%"></span>
    ${need != null ? `<span class="need" style="left:${pct(need)}%"></span>` : ""}</span></div>`;
}

function speedGauge(cv, kmh, max) {
  const g = cv.getContext("2d"), W = cv.width, H = cv.height, cx = W / 2, cy = H * 0.72, r = Math.min(W, H) * 0.55;
  g.clearRect(0, 0, W, H);
  const a0 = Math.PI * 0.8, a1 = Math.PI * 2.2, a = a0 + (a1 - a0) * Math.min(1, kmh / max);
  g.lineWidth = 12; g.lineCap = "round";
  g.strokeStyle = "#2a3646"; g.beginPath(); g.arc(cx, cy, r, a0, a1); g.stroke();
  g.strokeStyle = "#3ee07e"; g.beginPath(); g.arc(cx, cy, r, a0, a); g.stroke();
  g.fillStyle = "#f2f5f8"; g.textAlign = "center";
  g.font = "600 40px 'IBM Plex Mono', monospace"; g.fillText(kmh.toFixed(1), cx, cy - 6);
  g.font = "14px 'Barlow Condensed', sans-serif"; g.fillStyle = "#b8c2ce"; g.fillText(`KM/H · 0-${max}`, cx, cy + 20);
}

// --------------------------------------------------------------------------------------------------- mini map --
function miniMap(cv, n, { visor }) {
  const g = cv.getContext("2d"), W = cv.width, H = cv.height;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, W, H);
  const P = S.plan, s = S.snap, path = activePath();
  const pts = [...(P.route || []), ...P.stations.map((x) => [x.lon, x.lat]), [P.base.lon, P.base.lat], ...(s ? [[s.lon, s.lat]] : [])].map(([lo, la]) => local(lo, la));
  if (!pts.length) return;
  let x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0])), y0 = Math.min(...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]));
  const pad = 0.12 * Math.max(x1 - x0, y1 - y0, 200);
  x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
  const k = Math.min(W / (x1 - x0), H / (y1 - y0));
  const ox = (W - k * (x1 - x0)) / 2, oy = (H - k * (y1 - y0)) / 2;
  const X = (p) => [ox + (p[0] - x0) * k, H - oy - (p[1] - y0) * k];
  const line = (arr, col, w, dash) => {
    if (arr.length < 2) return;
    g.strokeStyle = col; g.lineWidth = w; g.setLineDash(dash || []);
    g.beginPath(); arr.forEach((p, i) => { const [a, b] = X(local(p[0], p[1])); i ? g.lineTo(a, b) : g.moveTo(a, b); }); g.stroke(); g.setLineDash([]);
  };
  const hud = visor ? "#9dffcf" : "#f2f5f8";
  if (!visor) { g.fillStyle = "#05080c"; g.fillRect(0, 0, W, H); }
  line(P.route || [], visor ? "#2f6b52" : "#5c6b7d", visor ? 2 : 3, path.kind === "plan" ? [] : [6, 5]);
  if (path.kind !== "plan") line(path.pts, path.kind === "return" ? "#ff7470" : "#3ccbff", visor ? 2 : 3);
  if (s?.track?.length) line(s.track, visor ? "#5fbf93" : "#d8a57a", visor ? 1.5 : 2);
  for (const st of P.stations) {
    const [a, b] = X(local(st.lon, st.lat));
    g.strokeStyle = hud; g.lineWidth = 2; g.beginPath(); g.moveTo(a, b - 6); g.lineTo(a + 6, b); g.lineTo(a, b + 6); g.lineTo(a - 6, b); g.closePath(); g.stroke();
    if (!visor) { g.fillStyle = "#b8c2ce"; g.font = "12px Barlow, sans-serif"; g.fillText(st.name.slice(0, 28), a + 9, b + 4); }
  }
  const [hx, hy] = X(local(P.base.lon, P.base.lat));
  g.strokeStyle = "#d8a57a"; g.lineWidth = 2; g.strokeRect(hx - 6, hy - 6, 12, 12);
  if (s) {
    const [cx, cy] = X(local(s.lon, s.lat));
    g.strokeStyle = "rgba(170,140,255,.8)"; g.lineWidth = 1.5; g.beginPath(); g.arc(cx, cy, Math.max(4, 2 * s.sigma * k), 0, 2 * Math.PI); g.stroke();
    const h = (n.heading ?? 0) * DEG;
    g.fillStyle = visor ? hud : "#3ccbff";
    g.beginPath(); g.moveTo(cx + 9 * Math.sin(h), cy - 9 * Math.cos(h)); g.lineTo(cx + 6 * Math.sin(h + 2.4), cy - 6 * Math.cos(h + 2.4));
    g.lineTo(cx + 6 * Math.sin(h - 2.4), cy - 6 * Math.cos(h - 2.4)); g.closePath(); g.fill();
  }
  // scale bar
  const m = niceScale((x1 - x0) / 4), L = m * k;
  g.strokeStyle = visor ? hud : "#b8c2ce"; g.lineWidth = 2; g.beginPath(); g.moveTo(10, H - 12); g.lineTo(10 + L, H - 12); g.stroke();
  g.fillStyle = g.strokeStyle; g.font = "11px 'IBM Plex Mono', monospace"; g.textAlign = "left"; g.fillText(fmtM(m), 12 + L, H - 8);
}
const niceScale = (v) => { const p = 10 ** Math.floor(Math.log10(v)); return [1, 2, 5, 10].map((x) => x * p).find((x) => x >= v * 0.6) ?? 10 * p; };

// ----------------------------------------------------------------------------------------------------- cuff --
function cuff(n) {
  const s = S.snap;
  $("cMet").textContent = s ? hm(s.t) : "--:--";
  $("cLink").textContent = `sol ${n.ctx.sol} · ${fmtLmst(n.ctx.lmst)} LMST`;
  const tag = $("cMode");
  tag.textContent = !s ? "PRE-EVA" : s.returning ? "RETURN" : s.done ? "DONE" : s.station ? "STATION" : "TRAVERSE";
  tag.classList.toggle("ret", !!s?.returning);
  const a = topAlert(s), al = $("cAlert");
  al.hidden = !a;
  if (a) { al.className = `calert l${a.level}`; al.innerHTML = `${["", "Advisory", "Caution", "Warning"][a.level]}${a.acked ? " (acknowledged)" : ""}: ${esc(a.text)}<small>${esc(a.action)}</small>`; }
  if (s) {
    const wm = worstMargin(s);
    $("cO2").textContent = `${Math.round(100 * s.remaining.o2)}%`;
    $("cBack").textContent = hm(s.back);
    $("cMargin").innerHTML = `<span class="${MARGIN_CLS(wm)}">${Math.round(100 * wm)}%</span>`;
    $("cCons").innerHTML = `<h3>Consumables · tick = needed to walk home</h3>${RES.map(([k, name]) => gauge2(name, s.remaining[k], Math.max(0, s.remaining[k] - s.margins[k]), s.margins[k])).join("")}`;
  }
  const st = n.nx ? S.plan.stations.find((x) => x.name === n.nx.name) : null;
  const pov = st?.pov || [];
  const eta = n.speed > 0.15 ? n.d / n.speed : null;
  $("cNext").innerHTML = n.nx ? `<h3>${n.nx.home ? "Going home" : "Next stop"}</h3><div class="big">${esc(n.nx.name)}</div>
    <div>${fmtM(n.d)} at ${Math.round(n.brg)}°${eta ? ` · about ${hm(eta)}` : ""}</div>
    ${pov.length ? `<div class="pov">${pov.slice(0, 2).map((p) => `<div><img src="${esc(p.src)}" alt="${esc(p.alt || "Rover image near this stop")}" loading="lazy"><div class="cap">${esc(p.caption || "")}</div></div>`).join("")}</div>` : ""}` : "";
  $("cProc").innerHTML = s?.station ? `<h3>Procedure · ${esc(s.station.name)}</h3><ol>${s.station.steps.map((x, k) => `<li class="${k < s.station.step ? "done" : k === s.station.step ? "cur" : ""}">${esc(x)}</li>`).join("")}</ol>
    <div class="num">${hm(s.station.done)} of ${hm(s.station.total)}</div>` : `<h3>Procedure</h3><div class="hint">Shown at each station.</div>`;
  const legs = S.plan.guidance || [];
  $("cLegs").innerHTML = legs.length ? `<h3>Cue card · ${esc(S.plan.routeName)} route</h3><table class="legs">${legs.flatMap((l) => (l.guidance || []).slice(0, 4).map((gd) =>
    `<tr><td>${esc(l.to)}</td><td>${String(Math.round(gd.heading)).padStart(3, "0")}°</td><td>${fmtM(gd.dist)}</td><td>${hm(gd.dt)}</td></tr>`)).join("")}</table>` : "";
  const rb = $("cReturn");
  const armed = Date.now() - S.armed < 5000;
  rb.classList.toggle("armed", armed);
  rb.textContent = armed ? "Confirm return" : "Return now";
}

for (const b of document.querySelectorAll("[data-cmd]")) {
  b.addEventListener("click", () => {
    const c = b.dataset.cmd;
    if (c === "return") {
      if (Date.now() - S.armed < 5000) { CH.postMessage({ type: "return" }); S.armed = 0; }
      else S.armed = Date.now();
      render();
      return;
    }
    CH.postMessage({ type: c });
    flashNote({ ack: "Alerts acknowledged", silence: "Tone silenced", pin: "Pin dropped at your position" }[c]);
  });
}

// ------------------------------------------------------------------------------------------------------ misc --
function flashNote(text) {
  const l = $("link");
  l.textContent = text;
  S.last = Date.now();
}
const esc = (x) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pct = (v) => Math.max(0, Math.min(100, 100 * v)).toFixed(1);
const fmtM = (m) => !Number.isFinite(m) ? "--" : m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
const fmtLmst = (h) => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.floor((h % 1) * 60)).padStart(2, "0")}`;

for (const b of document.querySelectorAll("#modes [data-mode]")) b.addEventListener("click", () => setMode(b.dataset.mode));
function setMode(m) {
  S.mode = m;
  const u = new URL(location.href);
  u.searchParams.set("mode", m);
  history.replaceState(null, "", u);
  render();
}
$("fs").addEventListener("click", () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.()));
addEventListener("keydown", (e) => {
  if (e.target.closest?.("input, select, textarea")) return;
  if (e.key === "1") setMode("visor");
  else if (e.key === "2") setMode("rover");
  else if (e.key === "3") setMode("cuff");
  else if (e.key === "f" || e.key === "F") $("fs").click();
});
addEventListener("resize", render);
render();
