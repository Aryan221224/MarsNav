// plannerx.js - the EVA planner's season, sharing and map tools (Worldview-style features on Mars data):
//   - Season chart: one Mars year at the habitat (13-year dust percentiles, sunlight, daylight, temperature); click to
//     choose the departure season. "Play the sol" animates shadows and sunlight across the departure sol; GIF export.
//   - Earth relay: when the relay orbiters are overhead (engine/relay.js), in text and as bands on the route timeline.
//   - Layer tools: overlay opacity, "show only above" thresholds, compare two layers (swipe line or spy lens).
//   - Measure: distance, climb, steepest grade and no-go ground along a line; area and statistics inside a shape.
//   - Exports: the site as a GeoTIFF in its own projection, a KMZ for Google Earth's Mars view, a link to the plan.
//   - Stories: guided walkthroughs on real data, in the tour box.
import { GifEncoder } from "./gif.js";
import { geoTiff, zip, kml, saveBytes } from "./geoexport.js";
import { distKm, pathKm, areaKm2, bearingDeg, fmtDist, fmtArea } from "./measure.js";
import { xyToLonLat, lonlatToXY } from "../engine/geo.js";
import { hhmm } from "../engine/relay.js";

const SOL_MS = 88775244;
const MARS_HOUR_MS = SOL_MS / 24;
const RANGE = { shield: [0, 15, " %"], hazard: [0, 0.5, ""], slope: [0, 25, "°"], sand: [0, 1, ""], slip: [0, 0.7, ""], sigma: [10, 60, " m"], walkback: [0, 180, " min"] };
const LAYER_NAME = { none: "Imagery only", hazard: "Safety hazard", slope: "Slope (walking scale)", sand: "Sand bedforms", slip: "Wheel-slip risk",
  shade: "Shadows at time", walkback: "Walkback time", range: "EVA range", los: "Radio line of sight", sigma: "Position error",
  confidence: "Data confidence", landing: "Landing safety", science: "Science value", shield: "Radiation shielding" };
const esc = (x) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const frames2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const kelvinC = (k) => `${Math.round(k - 273.15)} °C`;

function seasonName(Ls, lat) {
  const n = ["spring", "summer", "autumn", "winter"][Math.floor((((Ls % 360) + 360) % 360) / 90)];
  const s = { spring: "autumn", summer: "winter", autumn: "spring", winter: "summer" }[n];
  return lat >= 0 ? `northern ${n}` : `southern ${s}`;
}

export function initPlannerExtras(X) {
  const { state, call, $ } = X;
  const P = { season: null, seasonKey: "", relay: null, relayLat: null, playing: false, gif: false, ovMinPct: 0, cmp: { layer: "", mode: "swipe" } };
  state.px = P;

  // ============================================================================================ season chart
  const cv = $("seasonChart");
  const drawSeason = () => {
    const d = P.season;
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const W = Math.max(200, r.width), H = 150;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.height = `${H}px`;
    const c = cv.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = "#0f151d"; c.fillRect(0, 0, W, H);
    c.font = "11px 'IBM Plex Mono', monospace";
    if (!d) { c.fillStyle = "#8d9aab"; c.fillText("Season chart: computing…", 10, 20); return; }
    const L = 30, R = W - 34, T = 14, B = H - 20;
    const X = (ls) => L + ((R - L) * ls) / 360;
    const TMAX = 3;
    const Y = (t) => B - ((B - T) * Math.min(TMAX, t)) / TMAX;
    const eMax = Math.max(1, ...d.sols.map((x) => x.sunWh)) / 1000;
    const Ye = (wh) => B - ((B - T) * (wh / 1000)) / (eMax * 1.08);
    // dusty season shading (Ls 180-360: perihelion, when the big storms start)
    c.fillStyle = "rgba(255,170,90,0.07)"; c.fillRect(X(180), T, X(360) - X(180), B - T);
    // grid and axes
    c.strokeStyle = "#243142"; c.lineWidth = 1; c.fillStyle = "#8d9aab";
    for (let ls = 0; ls <= 360; ls += 90) { c.beginPath(); c.moveTo(X(ls), T); c.lineTo(X(ls), B); c.stroke(); c.fillText(`${ls}°`, X(ls) - (ls ? 10 : 0), H - 6); }
    for (const t of [0.5, 1, 2, 3]) { c.beginPath(); c.moveTo(L, Y(t)); c.lineTo(R, Y(t)); c.stroke(); c.fillText(String(t), 4, Y(t) + 4); }
    c.fillText("Ls", L - 22, H - 6);
    const S = [...d.sols].sort((a, b) => a.Ls - b.Ls);
    // dust band and median
    c.beginPath();
    S.forEach((x, k) => (k ? c.lineTo(X(x.Ls), Y(x.tau90)) : c.moveTo(X(x.Ls), Y(x.tau90))));
    for (let k = S.length - 1; k >= 0; k--) c.lineTo(X(S[k].Ls), Y(S[k].tau10));
    c.closePath(); c.fillStyle = "rgba(230,150,70,0.30)"; c.fill();
    c.beginPath(); S.forEach((x, k) => (k ? c.lineTo(X(x.Ls), Y(x.tau50)) : c.moveTo(X(x.Ls), Y(x.tau50))));
    c.strokeStyle = "#ff9a4a"; c.lineWidth = 2; c.stroke();
    // sunlight energy on the ground (right axis)
    c.beginPath(); S.forEach((x, k) => (k ? c.lineTo(X(x.Ls), Ye(x.sunWh)) : c.moveTo(X(x.Ls), Ye(x.sunWh))));
    c.strokeStyle = "#ffe066"; c.lineWidth = 1.4; c.setLineDash([4, 3]); c.stroke(); c.setLineDash([]);
    c.fillStyle = "#ffe066"; c.fillText(`${eMax.toFixed(1)}`, R + 4, Ye(eMax * 1000) + 4); c.fillText("kWh", R + 3, Ye(eMax * 500) + 4);
    c.fillStyle = "#ff9a4a"; c.fillText("τ", 4, T + 2);
    // departure cursor
    const dep = d.sols[0];
    c.strokeStyle = "#3ccbff"; c.lineWidth = 2; c.beginPath(); c.moveTo(X(dep.Ls), T); c.lineTo(X(dep.Ls), B); c.stroke();
    c.fillStyle = "#3ccbff"; c.beginPath(); c.arc(X(dep.Ls), Y(state.setup?.tau ?? dep.tau50), 4, 0, 2 * Math.PI); c.fill();
    // hover readout
    if (P.hoverLs != null) {
      const h = S.reduce((a, b) => (Math.abs(b.Ls - P.hoverLs) < Math.abs(a.Ls - P.hoverLs) ? b : a), S[0]);
      c.strokeStyle = "rgba(242,245,248,0.5)"; c.lineWidth = 1; c.beginPath(); c.moveTo(X(h.Ls), T); c.lineTo(X(h.Ls), B); c.stroke();
      const txt = `Ls ${h.Ls.toFixed(0)}° τ ${h.tau50.toFixed(2)} (p90 ${h.tau90.toFixed(2)}) · ${(h.sunWh / 1000).toFixed(1)} kWh/m² · ${h.daylightH.toFixed(1)} h`;
      const w = c.measureText(txt).width + 10, x0 = Math.min(R - w, Math.max(L, X(h.Ls) - w / 2));
      c.fillStyle = "rgba(11,15,20,0.9)"; c.fillRect(x0, T, w, 16); c.fillStyle = "#f2f5f8"; c.fillText(txt, x0 + 5, T + 12);
    }
  };
  cv.addEventListener("pointermove", (e) => {
    const r = cv.getBoundingClientRect(), L = 30, R = r.width - 34;
    P.hoverLs = Math.max(0, Math.min(360, ((e.clientX - r.left - L) / (R - L)) * 360));
    drawSeason();
  });
  cv.addEventListener("pointerleave", () => { P.hoverLs = null; drawSeason(); });
  cv.addEventListener("click", async (e) => {
    if (!P.season) return;
    const r = cv.getBoundingClientRect(), L = 30, R = r.width - 34;
    const ls = ((e.clientX - r.left - L) / (R - L)) * 360;
    const best = P.season.sols.reduce((a, b) => (Math.abs(((b.Ls - ls + 540) % 360) - 180) < Math.abs(((a.Ls - ls + 540) % 360) - 180) ? b : a));
    $("departSol").value = (parseInt($("departSol").value, 10) || 0) + best.k;
    await X.runSetup();
    await X.runPlan();
  });
  new ResizeObserver(() => drawSeason()).observe(cv.parentElement);

  async function refreshSeason() {
    const cfg = state.cfg;
    const key = `${cfg.base.lon.toFixed(4)},${cfg.base.lat.toFixed(4)},${Math.round(cfg.departMs / SOL_MS)}`;
    if (P.seasonKey !== key) {
      P.seasonKey = key;
      P.season = null; drawSeason();
      P.season = await call("season", { cfg: {} }).catch(() => null);
    }
    drawSeason();
    const d = P.season, s = state.setup;
    if (!d) { $("seasonNote").textContent = ""; return; }
    const dep = d.sols[0], du = s?.dust;
    const tauTxt = du?.mode && du.mode !== "fixed"
      ? `dust τ <b class="num">${s.tau.toFixed(2)}</b> (${du.mode === "clim90" ? "dusty year, 90th percentile" : "typical year, median"}; 10th-90th percentile ${du.p10.toFixed(2)}-${du.p90.toFixed(2)} over 13 Mars years)`
      : `dust τ <b class="num">${(s?.tau ?? state.cfg.tau).toFixed(2)}</b> (fixed; the 13-year median here is ${dep.tau50.toFixed(2)})`;
    $("seasonNote").innerHTML = `Departure: Ls ${dep.Ls.toFixed(0)}°, ${seasonName(dep.Ls, state.base.lat)}; ${tauTxt}.
      Daylight ${dep.daylightH.toFixed(1)} h, sunlight on the ground ${(dep.sunWh / 1000).toFixed(2)} kWh/m², air ${kelvinC(dep.tMinK)} to ${kelvinC(dep.tMaxK)}.
      ${d.stormYears?.length ? `<span class="dim">Global dust storms in the record: MY ${d.stormYears.join(", ")} (shown in the band's top).</span>` : ""}`;
  }

  // ================================================================================================= relay
  async function refreshRelay() {
    const lat = Math.round(state.base.lat * 2) / 2;
    if (P.relayLat !== lat) { P.relayLat = lat; P.relay = await call("relay", { lat, opts: { sols: 20, runs: 2, stepS: 20 } }).catch(() => null); }
    const r = P.relay;
    if (!r) { $("relayOut").textContent = ""; return; }
    const parts = r.orbiters.map((o) => {
      const win = o.windows.some((w) => w.allDay) ? "on most orbits, all sol"
        : o.windows.length ? o.windows.map((w) => `${hhmm(w.fromH)}-${hhmm(w.toH)}`).join(" and ") + " LMST" : "at times that change from sol to sol";
      return `<li><b>${esc(o.name)}</b> ≈ ${o.passesPerSol.toFixed(1)} passes/sol, ${win}; ${o.meanPassMin.toFixed(0)} min each on average${o.uncertain ? ' <span class="warn" title="Its local time has drifted; propellant nearly used up in 2026">(local time assumed)</span>' : ""}</li>`;
    }).join("");
    $("relayOut").innerHTML = `<div class="lbl" style="margin-top:6px">Earth relay passes here (modelled, ≥ 10° elevation)</div><ul class="relay">${parts}</ul>
      <span class="dim">About ${Math.round(r.minutesPerSol)} min of relay contact per sol in total. Send the EVA report on the next MRO afternoon pass.</span>`;
    setTimelineRelay();
  }

  // relay windows of the sun-synchronous orbiters, in route elapsed seconds, for the timeline
  function setTimelineRelay() {
    const r = P.relay, route = state.routes?.[state.selected];
    state.tl.relay = [];
    if (!r || !route?.ok) { state.tl.draw(); return; }
    const sol = parseInt($("departSol").value, 10) || 0;
    const t0 = state.cfg.departMs, t1 = t0 + route.t * 1000;
    for (const o of r.orbiters) {
      for (const w of o.windows) {
        if (w.allDay) continue;
        for (let k = -1; k <= 1; k++) {
          const a = state.clock.msFromSol(sol + k, w.fromH), b0 = state.clock.msFromSol(sol + k, w.toH);
          const b = b0 < a ? b0 + SOL_MS : b0;
          if (b < t0 || a > t1) continue;
          state.tl.relay.push({ t0: Math.max(0, (a - t0) / 1000), t1: Math.min(route.t, (b - t0) / 1000), label: o.name });
        }
      }
    }
    state.tl.draw();
  }

  // ======================================================================================= play the sol + GIF
  const prevOverlay = () => state.overlay;
  async function showDayTime(min) {
    const sol = parseInt($("departSol").value, 10) || 0;
    const ms = state.clock.msFromSol(sol, min / 60);
    if (state.overlay !== "shade") {
      P.overlayBeforePlay ??= prevOverlay();
      document.querySelector("input[name=ov][value=shade]").checked = true;
      state.overlay = "shade";
      document.querySelector("input[name=ov][value=shade]").dispatchEvent(new Event("change"));
    }
    await X.refreshOverlay({ ms });
    const e = await call("envAt", { ms });
    $("dayOut").innerHTML = `Sol ${sol} · LMST ${hhmm(min / 60)} · sun ${e.sunEl >= 0 ? "+" : ""}${e.sunEl.toFixed(0)}° az ${e.sunAz.toFixed(0)}° · sunlight ${Math.round(e.ghi)} W/m² (τ ${e.tau.toFixed(2)}) · air ${kelvinC(e.airK)}`;
    return e;
  }
  $("dayT").addEventListener("input", () => showDayTime(+$("dayT").value));
  async function dayRange() {
    const sol = parseInt($("departSol").value, 10) || 0;
    const r = await call("sunTimes", { ms: state.clock.msFromSol(sol, 12) });
    const toMin = (ms) => (ms - state.clock.msFromSol(sol, 0)) / MARS_HOUR_MS * 60;
    return [Math.max(0, toMin(r.sunrise) - 30), Math.min(1440, toMin(r.sunset) + 30)];
  }
  $("btnDayPlay").addEventListener("click", async () => {
    if (P.playing) { P.playing = false; return; }
    P.playing = true; $("btnDayPlay").textContent = "Stop";
    try {
      const [a, b] = await dayRange();
      for (let m = a; m <= b && P.playing; m += 15) { $("dayT").value = m; await showDayTime(m); await wait(140); }
    } finally { P.playing = false; $("btnDayPlay").textContent = "Play the sol"; }
  });
  $("btnDayGif").addEventListener("click", async () => {
    if (P.gif) return;
    P.gif = true;
    const btn = $("btnDayGif"); btn.disabled = true;
    try {
      const [a, b] = await dayRange();
      const mc = state.map.cv, cw = Math.min(640, Math.round(state.map.w)), ch = Math.round((cw * state.map.h) / state.map.w);
      const fc = document.createElement("canvas"); fc.width = cw; fc.height = ch + 26;
      const fx = fc.getContext("2d");
      const enc = new GifEncoder(fc.width, fc.height, { delayMs: 280 });
      const sol = parseInt($("departSol").value, 10) || 0;
      let n = 0;
      for (let m = a; m <= b; m += 30) {
        $("dayT").value = m;
        const e = await showDayTime(m);
        await frames2();
        fx.fillStyle = "#06080b"; fx.fillRect(0, 0, fc.width, fc.height);
        fx.drawImage(mc, 0, 0, mc.width, mc.height, 0, 0, cw, ch);
        fx.fillStyle = "#0b0f14"; fx.fillRect(0, ch, cw, 26);
        fx.fillStyle = "#f2f5f8"; fx.font = "600 13px 'Barlow', system-ui, sans-serif";
        fx.fillText(`MarsNav · ${state.site.short ?? state.site.name} · ${state.clock.name} sol ${sol} · LMST ${hhmm(m / 60)} · sun ${e.sunEl.toFixed(0)}° · ${Math.round(e.ghi)} W/m²`, 8, ch + 18);
        enc.addFrame(fx.getImageData(0, 0, fc.width, fc.height).data);
        btn.textContent = `Recording ${++n}…`;
      }
      btn.textContent = "Encoding…";
      await wait(30);
      saveBytes(enc.encode(), `marsnav_${state.site.id}_sol${sol}_shadows.gif`, "image/gif");
      $("dayOut").innerHTML += ` · <span class="ok">GIF saved (${n} frames)</span>`;
    } catch (err) {
      $("dayOut").innerHTML = `<span class="bad">GIF failed: ${esc(err.message)}</span>`;
    } finally { P.gif = false; btn.disabled = false; btn.textContent = "Save as GIF"; }
  });

  // ======================================================================================= layer tools
  $("ovOpacity").addEventListener("input", () => {
    const v = +$("ovOpacity").value;
    $("ovOpacityV").textContent = `${v} %`;
    state.map.overlayAlpha = v / 100;
    state.map.draw();
  });
  const minLabel = () => {
    const rg = RANGE[state.overlay], pct = P.ovMinPct;
    $("ovMin").disabled = !rg;
    $("ovMinLbl").style.opacity = rg ? 1 : 0.5;
    $("ovMinV").textContent = !rg ? "n/a" : pct <= 0 ? "off" : `${+(rg[0] + ((rg[1] - rg[0]) * pct) / 100).toFixed(2)}${rg[2]}`;
  };
  X.ovMinFor = (name) => {
    const rg = RANGE[name];
    return rg && P.ovMinPct > 0 ? rg[0] + ((rg[1] - rg[0]) * P.ovMinPct) / 100 : null;
  };
  let minT = 0;
  $("ovMin").addEventListener("input", () => {
    P.ovMinPct = +$("ovMin").value; minLabel();
    clearTimeout(minT); minT = setTimeout(() => X.refreshOverlay(), 120);
  });
  document.querySelectorAll("input[name=ov]").forEach((r) => r.addEventListener("change", () => { minLabel(); refreshCompare(); }));
  minLabel();

  async function refreshCompare() {
    const L = P.cmp.layer;
    if (!L) { state.map.setCompare(null); return; }
    const labelA = LAYER_NAME[state.overlay] ?? state.overlay;
    const ov = L === "none" ? null : await call("overlay", { name: L, opts: { ms: state.cfg.departMs } });
    state.map.setCompare({ mode: P.cmp.mode, ov, labelA, labelB: LAYER_NAME[L] ?? L });
  }
  X.refreshCompare = refreshCompare;
  $("cmpSel").addEventListener("change", () => { P.cmp.layer = $("cmpSel").value; refreshCompare(); X.saveLink?.(); });
  document.querySelectorAll("#cmpMode [data-cm]").forEach((b) => b.addEventListener("click", () => {
    P.cmp.mode = b.dataset.cm;
    document.querySelectorAll("#cmpMode [data-cm]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    if (state.map.compare) { state.map.compare.mode = P.cmp.mode; state.map.draw(); }
  }));

  // ============================================================================================ measure
  const M = { on: false };
  const mbox = $("measureBox");
  function setMeasure(on) {
    M.on = on;
    $("btnMeasure").setAttribute("aria-pressed", String(on));
    $("btnMeasure").classList.toggle("primary", on);
    mbox.hidden = !on && !(state.map.measure?.pts?.length);
    if (on) state.map.measure = { pts: [], closed: false, active: true };
    else if (state.map.measure) state.map.measure.active = false;
    state.map.draw();
    if (on) $("mOut").textContent = "Click the map to add points. Double-click or “Finish” to end; “Area” closes the shape.";
  }
  X.measureActive = () => !!state.map.measure?.active;
  X.measureClick = (lon, lat) => {
    const m = state.map.measure;
    if (!m?.active) return false;
    m.pts.push([lon, lat]);
    state.map.draw();
    updateMeasure();
    return true;
  };
  let mSeq = 0;
  async function updateMeasure() {
    const m = state.map.measure, pts = m?.pts || [];
    if (pts.length < 2) { $("mOut").textContent = pts.length ? "Add the next point." : "Click the map to add points."; return; }
    const seq = ++mSeq;
    const line = m.closed ? [...pts, pts[0]] : pts;
    const len = pathKm(line).total;
    let html = `<div><b class="num">${fmtDist(len)}</b> ${m.closed ? "perimeter" : `along ${line.length - 1} segment${line.length > 2 ? "s" : ""}`}${line.length > 2 || m.closed ? "" : ` · bearing ${Math.round(bearingDeg(pts[0], pts[1]))}°`}</div>`;
    if (m.closed && pts.length >= 3) { m.areaText = fmtArea(areaKm2(pts)); html += `<div>Area <b class="num">${m.areaText}</b></div>`; }
    const pr = await call("profileLine", { pts: line }).catch(() => null);
    if (seq !== mSeq) return;
    if (pr) {
      html += `<div>Climb <span class="num">+${Math.round(pr.climbM)} m / −${Math.round(pr.descentM)} m</span> · steepest grade <span class="num">${pr.maxGradeDeg.toFixed(0)}°</span> · walking-scale slope up to <span class="num">${pr.maxSlopeWDeg.toFixed(0)}°</span></div>`;
      html += pr.vetoM > 0 ? `<div class="warn">Crosses ${Math.round(pr.vetoM)} m of no-go ground: a straight line is not a route.</div>` : `<div class="dim">No no-go ground on this line (it is still a straight line, not a planned route).</div>`;
      if (pr.noDataM > 1) html += `<div class="dim">${Math.round(pr.noDataM)} m outside the site's map.</div>`;
    }
    if (m.closed && pts.length >= 3) {
      const st = await call("areaStats", { poly: pts }).catch(() => null);
      if (seq !== mSeq) return;
      if (st?.n) {
        const row = (lbl, v, u, d = 1) => v ? `<tr><td>${lbl}</td><td class="num">${v.p10.toFixed(d)}</td><td class="num">${v.p50.toFixed(d)}</td><td class="num">${v.p90.toFixed(d)}</td><td class="num">${v.max.toFixed(d)}</td><td>${u}</td></tr>` : "";
        html += `<div class="lbl" style="margin-top:6px">Inside the shape (${st.n.toLocaleString()} cells of 10 m)</div>
          <table class="t mstat"><tr><th></th><th>p10</th><th>median</th><th>p90</th><th>max</th><th></th></tr>
          ${row("Elevation", st.elev, "m", 0)}${row("Walking slope", st.slopeW, "°")}${row("Hazard", st.haz, "", 2)}${row("Sand", st.sand, "", 2)}</table>
          <div>No-go <span class="num">${(100 * st.vetoFrac).toFixed(1)} %</span> · radio line of sight <span class="num">${(100 * st.losFrac).toFixed(0)} %</span> · 1 m data <span class="num">${(100 * st.hiresFrac).toFixed(0)} %</span></div>`;
      }
    }
    $("mOut").innerHTML = html;
  }
  $("btnMeasure").addEventListener("click", () => setMeasure(!M.on));
  $("mClose").addEventListener("click", () => { setMeasure(false); state.map.measure = null; mbox.hidden = true; state.map.draw(); });
  $("mUndo").addEventListener("click", () => { const m = state.map.measure; if (!m) return; if (m.closed) m.closed = false; else m.pts.pop(); state.map.draw(); updateMeasure(); });
  $("mClear").addEventListener("click", () => { state.map.measure = { pts: [], closed: false, active: true }; setMeasure(true); });
  $("mDone").addEventListener("click", () => { if (state.map.measure) state.map.measure.active = false; M.on = false; $("btnMeasure").setAttribute("aria-pressed", "false"); $("btnMeasure").classList.remove("primary"); state.map.draw(); });
  $("mArea").addEventListener("click", () => {
    const m = state.map.measure; if (!m || m.pts.length < 3) { $("mOut").textContent = "An area needs at least three points."; return; }
    m.closed = true; m.active = false; M.on = false; $("btnMeasure").setAttribute("aria-pressed", "false"); $("btnMeasure").classList.remove("primary");
    state.map.draw(); updateMeasure();
  });
  $("mStation").addEventListener("click", () => {
    const p = state.map.measure?.pts?.at(-1);
    if (p) X.addPointStation(p[0], p[1]);
  });
  state.map.cv.addEventListener("dblclick", () => { if (state.map.measure?.active) $("mDone").click(); });
  document.addEventListener("keydown", (e) => {
    if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || "")) return;
    if ((e.key === "m" || e.key === "M") && !e.ctrlKey && !e.metaKey && !e.altKey) setMeasure(!M.on);
    if (e.key === "Escape" && M.on) setMeasure(false);
  });

  // ============================================================================================ exports
  const proj = () => ({ latTs: state.meta.projection?.lat_ts ?? 18.4663, clon: state.meta.projection?.clon ?? 0 });
  const stamp = () => `${state.site.id}_${state.overlay}`;
  $("btnTiff").addEventListener("click", async () => {
    X.busy(true, "Writing the GeoTIFF…");
    try {
      const c = state.map.exportCanvas({ vectors: true });
      const rgba = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      const bytes = await geoTiff(rgba, state.meta.grid, proj(), { description: `MarsNav ${state.site.name}: ${LAYER_NAME[state.overlay] ?? state.overlay}` });
      saveBytes(bytes, `marsnav_${stamp()}.tif`, "image/tiff");
    } catch (err) { alert(`GeoTIFF failed: ${err.message}`); } finally { X.busy(false); }
  });
  $("btnKmz").addEventListener("click", async () => {
    X.busy(true, "Writing the KMZ…");
    try { saveBytes(await buildKmz(), `marsnav_${stamp()}.kmz`, "application/vnd.google-earth.kmz"); }
    catch (err) { alert(`KMZ failed: ${err.message}`); } finally { X.busy(false); }
  });
  async function buildKmz() {
    const g = state.meta.grid;
    const c = state.map.exportCanvas({ vectors: false });
    const jpg = new Uint8Array(await (await new Promise((r) => c.toBlob(r, "image/jpeg", 0.86))).arrayBuffer());
    const [west, north] = xyToLonLat(g.x0, g.y0), [east, south] = xyToLonLat(g.x0 + g.width * g.res, g.y0 - g.height * g.res);
    const parts = [kml.overlay(`${LAYER_NAME[state.overlay] ?? "Map"} (MarsNav)`, "map.jpg", { north, south, east, west }, { opacity: 0.85 })];
    parts.push(kml.point(state.base.name ?? "Habitat", state.base.lon, state.base.lat, { style: "hab", description: "Habitat (hub)" }));
    parts.push(kml.folder("Stations", state.stations.map((s, k) => kml.point(`${k + 1}. ${s.name}`, s.lon, s.lat, { description: `${s.dwell_min} min ${s.task || ""}` })).join(""), true));
    const sel = state.routes?.[state.selected];
    if (sel?.ok) {
      const desc = `${state.selected}: ${(sel.dist / 1000).toFixed(2)} km, ${(sel.t / 3600).toFixed(2)} h, worst walk-home margin ${(100 * sel.minMargin).toFixed(0)} %`;
      parts.push(kml.line(`Route (${state.selected})`, sel.pts.map((p) => [p.lon, p.lat, 0]), { description: desc }));
      const alt = Object.entries(state.routes).filter(([k, r]) => k !== state.selected && r?.ok)
        .map(([k, r]) => kml.line(k, r.pts.map((p) => [p.lon, p.lat, 0]), { style: "alt" })).join("");
      if (alt) parts.push(kml.folder("Alternative routes", alt));
    }
    const ko = (state.map.keepouts || []).flatMap((k) => k.points.map(([lo, la]) => kml.polygon(k.name, circleLL(lo, la, k.radius_m), { style: "danger" })));
    if (ko.length) parts.push(kml.folder("Keep-out zones", ko.join("")));
    if (state.map.traverse?.length) parts.push(kml.line("Perseverance traverse", state.map.traverse.map(([lo, la]) => [lo, la, 0]), { style: "alt" }));
    const m = state.map.measure;
    if (m?.pts?.length >= 2) parts.push(m.closed ? kml.polygon("Measured area", m.pts, { style: "measure" }) : kml.line("Measured line", m.pts, { style: "measure" }));
    if (state.landing?.result?.ellipse) parts.push(kml.polygon("Landing ellipse", state.landing.result.ellipse, { style: "ellipse" }));
    const doc = kml.doc(`MarsNav: ${state.site.name}`, parts.join("\n"),
      { description: `EVA plan from MarsNav (${new Date().toISOString().slice(0, 10)}). Open in Google Earth Pro, Mars view.` });
    return zip([{ name: "doc.kml", data: doc }, { name: "map.jpg", data: jpg }]);
  }
  X.buildKmz = buildKmz;
  function circleLL(lon, lat, rM, n = 48) {
    const [x, y] = lonlatToXY(lon, lat), out = [];
    for (let k = 0; k <= n; k++) { const a = (2 * Math.PI * k) / n; out.push(xyToLonLat(x + rM * Math.cos(a), y + rM * Math.sin(a))); }
    return out;
  }

  // ======================================================================================= link to this plan
  function planState() {
    const v = state.map;
    return {
      v: 1,
      st: state.stations.map((s) => ({ id: s.id, n: s.name, lo: +s.lon.toFixed(6), la: +s.lat.toFixed(6), d: s.dwell_min, t: s.task, k: s.kind, val: s.value, sk: s.skip ? 1 : 0 })),
      rs: state.route.start, re: state.route.end,
      c: Object.fromEntries(["profile", "departSol", "departLmst", "evaMax", "reserve", "risk", "tau", "nav"].map((id) => [id, $(id).value]).concat([["rescue", $("rescue").checked ? 1 : 0]])),
      ov: state.overlay, sel: state.selected, cmp: P.cmp.layer ? [P.cmp.layer, P.cmp.mode] : null,
      view: [Math.round(v.cx), Math.round(v.cy), +v.mpp.toFixed(2)],
      hab: state.base?.landed ? [state.base.lon, state.base.lat] : null,
      ms: v.measure?.pts?.length ? [v.measure.pts, v.measure.closed ? 1 : 0] : null,
      op: +$("ovOpacity").value, mn: P.ovMinPct || 0,              // overlay strength and the "show only above" threshold
    };
  }
  const b64u = (str) => btoa(String.fromCharCode(...new TextEncoder().encode(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unb64u = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
  function linkUrl() {
    const u = new URL(location.href);
    u.hash = `${state.site.id}&p=${b64u(JSON.stringify(planState()))}`;
    return u.href;
  }
  X.saveLink = () => {};
  $("btnLink").addEventListener("click", async () => {
    const url = linkUrl();
    let copied = false;
    try { await navigator.clipboard.writeText(url); copied = true; } catch { /* blocked */ }
    X.openModal("Link to this plan", `<p class="note">${copied ? "Copied to the clipboard. " : ""}Opening this link starts the planner on the same site with the same stations, settings, map layer, comparison and view. It works on any computer that runs MarsNav.</p><textarea readonly>${esc(url)}</textarea>`, url, "marsnav_plan_link.txt", "text/plain");
  });

  /** Apply a plan state from the address (#site&p=...). Returns true when one was applied. */
  X.applyLinkState = async () => {
    const m = location.hash.match(/&p=([A-Za-z0-9_-]+)/);
    if (!m) return false;
    let st;
    try { st = JSON.parse(unb64u(m[1])); } catch { return false; }
    if (st.v !== 1) return false;
    for (const [id, val] of Object.entries(st.c || {})) {
      const el = $(id);
      if (!el) continue;
      if (el.type === "checkbox") el.checked = !!val; else el.value = val;
    }
    if (st.hab) state.base = { lon: st.hab[0], lat: st.hab[1], name: "Habitat (landed)", landed: true };
    state.map.habitat = state.base;
    state.stations = (st.st || []).map((s) => ({ id: s.id, name: s.n, lon: s.lo, lat: s.la, dwell_min: s.d ?? 30, task: s.t ?? "survey", kind: s.k ?? "survey",
      value: s.val ?? 0.3, skip: !!s.sk, toolWh: 0, extraO2g: 0, extraWaterG: 0 }));
    state.route = { start: st.rs ?? "base", end: st.re ?? "base" };
    X.renderStations();
    if (st.ov && document.querySelector(`input[name=ov][value="${st.ov}"]`)) {
      document.querySelector(`input[name=ov][value="${st.ov}"]`).checked = true;
      state.overlay = st.ov;
    }
    if (st.mn != null) { P.ovMinPct = +st.mn || 0; $("ovMin").value = P.ovMinPct; minLabel(); }
    if (st.op != null) { $("ovOpacity").value = st.op; $("ovOpacity").dispatchEvent(new Event("input")); }
    await X.runSetup();
    await X.runPlan();
    if (st.sel && state.routes?.[st.sel]?.ok) X.selectRoute(st.sel);
    if (st.cmp) { $("cmpSel").value = st.cmp[0]; P.cmp = { layer: st.cmp[0], mode: st.cmp[1] || "swipe" }; document.querySelector(`#cmpMode [data-cm="${P.cmp.mode}"]`)?.click(); await refreshCompare(); }
    if (st.ms) { state.map.measure = { pts: st.ms[0], closed: !!st.ms[1], active: false }; $("measureBox").hidden = false; updateMeasure(); }
    if (st.view) { state.map.cx = st.view[0]; state.map.cy = st.view[1]; state.map.mpp = st.view[2]; state.map.draw(); }
    return true;
  };

  // ============================================================================================ stories
  const target = (id) => state.meta.targets.find((t) => t.id === id);
  const setOv = async (name) => { const r = document.querySelector(`input[name=ov][value="${name}"]`); if (r) { r.checked = true; state.overlay = name; r.dispatchEvent(new Event("change")); await X.refreshOverlay(); } };
  const setStations = async (ids) => {
    state.stations = []; state.route = { start: "base", end: "base" };
    for (const id of ids) { const t = target(id); if (t) X.addStation(t); }
    await X.runSetup(); await X.runPlan();
    const r = state.routes?.[state.selected]; if (r?.ok) state.map.fitLonLat(r.pts.map((p) => [p.lon, p.lat]), 60);
  };
  const departAtLs = async (ls) => {
    if (!P.season) await refreshSeason();
    const best = P.season.sols.reduce((a, b) => (Math.abs(((b.Ls - ls + 540) % 360) - 180) < Math.abs(((a.Ls - ls + 540) % 360) - 180) ? b : a));
    $("departSol").value = (parseInt($("departSol").value, 10) || 0) + best.k;
    await X.runSetup(); await X.runPlan();
  };
  const use = () => { const r = state.routes?.[state.selected]; return r?.ok ? { water: r.res.water, batt: r.res.batt, margin: r.minMargin, tau: state.setup.tau } : null; };
  const useText = (u) => (u ? `Cooling water ${u.water.toFixed(2)} kg, suit battery ${Math.round(u.batt)} Wh, worst walk-home margin ${(100 * u.margin).toFixed(0)} %.` : "No feasible route.");
  const compareUse = (a, b) => {
    if (!a || !b) return "";
    const dw = (100 * (b.water - a.water)) / a.water, db = (100 * (b.batt - a.batt)) / a.batt;
    return `Against the clear season: cooling water ${dw >= 0 ? "+" : ""}${dw.toFixed(0)} %, battery ${db >= 0 ? "+" : ""}${db.toFixed(0)} %. Dust blocks direct sunlight on the suit: less heat to reject, but less warmth in the cold; and less sunlight reaches the ground for the habitat's solar arrays (the dashed line).`;
  };
  const STORIES = [
    { id: "dust", title: "Clear season or dusty season?", sub: "13 Mars years of dust, the same EVA in two seasons", steps: [
      { t: "Dust sets the sunlight budget", sel: "#seasonSec", x: "The band is 13 Mars years of orbital dust measurements at this habitat (Mars Climate Database); the dashed line is the sunlight that reaches the ground. Dust rises after Ls 180, when Mars is closest to the Sun.",
        go: async () => { X.setMode("plan"); $("tau").value = "clim50"; await setStations(["AMAL"]); } },
      { t: "The EVA in the clear season", sel: "#cards", x: "", go: async () => { await departAtLs(100); P.storyClear = use(); STORIES[0].steps[1].x = `Departure in the clear season (Ls ~100°): dust τ ${state.setup.tau.toFixed(2)}. ${useText(P.storyClear)}`; } },
      { t: "The same EVA in the dusty season", sel: "#cards", x: "", go: async () => { await departAtLs(250); const u = use(); STORIES[0].steps[2].x = `The same stations at Ls ~250° (typical year): dust τ ${state.setup.tau.toFixed(2)}. ${useText(u)} ${compareUse(P.storyClear, u)}`; } },
      { t: "A dusty year", sel: "#tau", x: "", go: async () => { $("tau").value = "clim90"; await X.runSetup(); await X.runPlan(); const u = use(); STORIES[0].steps[3].x = `In a dusty year (90th percentile of the record) τ is ${state.setup.tau.toFixed(2)}. ${useText(u)} Planning on the 90th percentile is the conservative choice for the dusty season; the habitat's solar arrays get the sunlight of the dashed line.`; } },
    ] },
    { id: "compare", title: "Compare two layers", sub: "Swipe and spy, as in NASA Worldview", steps: [
      { t: "Swipe between two maps", sel: "#layers", x: "Left of the blue line: the safety hazard. Right of it: walking-scale slope. Drag the line to see where the hazard comes from.",
        go: async () => { X.setMode("plan"); state.setLayersOpen?.(true); await setOv("hazard"); $("cmpSel").value = "slope"; P.cmp.layer = "slope"; document.querySelector('#cmpMode [data-cm="swipe"]').click(); await refreshCompare(); } },
      { t: "Spy lens", sel: ".mapwrap", x: "Spy mode shows the second layer inside a lens that follows the cursor: here sand bedforms under the hazard map.",
        go: async () => { $("cmpSel").value = "sand"; P.cmp.layer = "sand"; document.querySelector('#cmpMode [data-cm="spy"]').click(); await refreshCompare(); } },
      { t: "Only what matters", sel: "#layers", x: "“Show only above” keeps the cells over a threshold: here slopes of 15° and more.",
        go: async () => { $("cmpSel").value = ""; P.cmp.layer = ""; await refreshCompare(); await setOv("slope"); $("ovMin").value = 60; $("ovMin").dispatchEvent(new Event("input")); await wait(300); } },
    ] },
    { id: "detour", title: "Perseverance's detour", sub: "Measure what the rover drove around", jezero: true, steps: [
      { t: "The rover's real path", sel: ".mapwrap", x: "The dashed tan line is Perseverance's real traverse. Between Séítah and the delta front it went around the sand.",
        go: async () => { X.setMode("plan"); await setOv("sand"); $("chkTrav").checked = true; state.map.layers.traverse = true; await setStations(["ISSO", "AMAL"]); } },
      { t: "Measure the straight line", sel: "#measureBox", x: "",
        go: async () => { const a = target("ISSO"), b = target("AMAL"); state.map.measure = { pts: [[a.lon, a.lat], [b.lon, b.lat]], closed: false, active: false }; $("measureBox").hidden = false; await updateMeasure();
          STORIES[2].steps[1].x = `Issole to Amalik is ${fmtDist(distKm([a.lon, a.lat], [b.lon, b.lat]))} in a straight line; the measure panel shows the sand and no-go ground it would cross.`; } },
      { t: "The planned route", sel: "#cards", x: "MarsNav's routes keep the walk home within every consumable and stay off no-go ground; compare their length with the straight line.",
        go: async () => { $("zoomFit").click(); } },
    ] },
    { id: "share", title: "Share and export a plan", sub: "A link, a GeoTIFF, Google Earth", steps: [
      { t: "One link, the whole plan", sel: "#btnLink", x: "Review → “Copy link to this plan” puts the site, stations, settings, layer, comparison and view in the address. Opening it rebuilds the same plan.",
        go: async () => { X.setMode("review"); } },
      { t: "GIS and Google Earth", sel: "#btnKmz", x: "“Map as GeoTIFF” writes the site in its own Mars projection for QGIS or ArcGIS; “Google Earth (KMZ)” carries the routes, stations, keep-outs and the map for Google Earth Pro's Mars view.",
        go: async () => {} },
      { t: "A sol in shadows", sel: "#seasonSec", x: "Back in Plan, “Play the sol” animates the terrain shadows from sunrise to sunset on the departure sol; “Save as GIF” records it.",
        go: async () => { X.setMode("plan"); } },
    ] },
  ];
  // one Guide button (same place as in Landing mode): the quick tour first, then the stories on real data
  $("btnGuide").addEventListener("click", () => {
    const list = STORIES.filter((s) => !s.jezero || state.site.id === "jezero");
    X.openModal("Guide", `<p class="note">New here? Start with the quick tour. The stories are guided walkthroughs on real data: each one sets the planner up and explains what is on screen.</p>
      <div class="stories"><button class="btn story first" data-guide="tour"><b>Quick tour</b><span>The whole chain, plan to review, in ${X.tourSteps()} steps (about two minutes)</span></button>
      ${list.map((s) => `<button class="btn story" data-story="${s.id}"><b>${esc(s.title)}</b><span>${esc(s.sub)}</span></button>`).join("")}</div>`);
    document.querySelector("[data-guide=tour]").addEventListener("click", () => { $("modal").hidden = true; X.startTour(); });
    document.querySelectorAll("[data-story]").forEach((b) => b.addEventListener("click", () => {
      $("modal").hidden = true;
      X.startStory(STORIES.find((s) => s.id === b.dataset.story).steps);
    }));
  });
  X.stories = STORIES;

  // ===================================================================================== hooks for main.js
  return {
    afterSetup: async () => { await refreshSeason(); await refreshRelay(); },
    afterPlan: () => { setTimelineRelay(); if (P.cmp.layer) refreshCompare(); },
    afterOverlay: () => { minLabel(); if (P.cmp.layer && state.map.compare) state.map.compare.labelA = LAYER_NAME[state.overlay] ?? state.overlay; },
  };
}
