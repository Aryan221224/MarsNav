// placeview.js - everything known about one place on Mars, for any point selected anywhere on the planet: fetched from
// /api/place (planet/place.py) and drawn the same way in Landing mode, the EVA planner's place card and the crew displays.
// The time at the place (local solar time, sun, season, sunrise and sunset) is computed here, live, from the Mars24 clock.
import { earthMarsLight, jdTT, lmstHours, ltstHours, marsState, marsYear, sunPosition, solarConstant } from "../engine/marstime.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtN = (v, d = 0) => v == null || !isFinite(v) ? "–" : (+v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
const fmtKm = (km) => km == null || !isFinite(km) ? "–" : km >= 100 ? `${km.toFixed(0)} km` : km >= 1 ? `${km.toFixed(1)} km` : `${(km * 1000).toFixed(0)} m`;
const hhmm = (h) => { const t = Math.round((((h % 24) + 24) % 24) * 60); return `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`; };
const ll = (lat, lon, d = 4) => `${Math.abs(lat).toFixed(d)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(d)}°${lon >= 0 ? "E" : "W"}`;
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compass = (b) => COMPASS[Math.round((((b % 360) + 360) % 360) / 45) % 8];
const NA = (t = "layer not installed") => `<span class="pv-na">${t}</span>`;

/** Every layer at one place, from the local server. Lookups still running on the server (geology, Trek maps) come back
 *  with `pending`; asking again a few seconds later gets them from its cache. */
export async function fetchPlace(lon, lat, { crit = "hls2", signal } = {}) {
  const url = `/api/place?lon=${lon}&lat=${lat}&crit=${encodeURIComponent(crit)}`;
  const r = await fetch(url, { signal });
  const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

/** fetchPlace, then once more for the remote lookups that had not answered (onUpdate gets each version). */
export async function loadPlace(lon, lat, onUpdate, opts = {}) {
  let d = await fetchPlace(lon, lat, opts);
  onUpdate(d);
  for (let k = 0; k < 2 && d.pending?.length; k++) {
    await new Promise((res) => setTimeout(res, 3500));
    if (opts.stillWanted && !opts.stillWanted()) return d;
    d = await fetchPlace(lon, lat, opts);
    onUpdate(d);
  }
  return d;
}

// --------------------------------------------------------------------------------------------- time at the place --
const SEASON = ["spring", "summer", "autumn", "winter"];
/** The time and sun at a place now: local true and mean solar time, sun position, sunrise / sunset (sun centre at the
 *  horizon, no refraction), daylight length in Mars hours, season by hemisphere, Mars Year, Earth-Mars light time. */
export function timeHere(ms, lon, lat) {
  const st = marsState(jdTT(ms));
  const lonE = ((lon % 360) + 360) % 360;
  const sun = sunPosition(st, lonE, lat);
  const x = -Math.tan(lat * Math.PI / 180) * Math.tan(st.decl * Math.PI / 180);
  const h0 = x <= -1 ? 180 : x >= 1 ? 0 : Math.acos(x) * 180 / Math.PI;      // half-day arc, degrees
  const q = Math.floor(st.Ls / 90);
  const north = SEASON[q], south = SEASON[(q + 2) % 4];
  const ltst = ltstHours(st, lonE);
  const sunset = 12 + h0 / 15, sunrise = 12 - h0 / 15;
  const toSet = h0 > 0 && h0 < 180 ? ((sunset - ltst + 24) % 24) : null;
  const em = earthMarsLight(ms);
  return {
    Ls: st.Ls, marsYear: marsYear(st.msd, st.Ls), ltst, lmst: lmstHours(st, lonE), sun, day: sun.elevation > 0,
    polar: h0 >= 180 ? "day" : h0 <= 0 ? "night" : null, sunrise, sunset, daylightH: 2 * h0 / 15, noonEl: 90 - Math.abs(lat - st.decl),
    toSetH: toSet != null && sun.elevation > 0 ? toSet : null, toRiseH: h0 > 0 && h0 < 180 && sun.elevation <= 0 ? ((sunrise - ltst + 24) % 24) : null,
    season: lat >= 0 ? north : south, seasonN: north, seasonS: south, dustSeason: st.Ls >= 180, toa: solarConstant(st),
    earthAU: em.au, lightMin: em.lightS / 60,
  };
}
export function timeHtml(t) {
  const sunTxt = t.polar === "day" ? "polar day: the sun does not set" : t.polar === "night" ? "polar night: the sun does not rise"
    : `rises ${hhmm(t.sunrise)} · sets ${hhmm(t.sunset)} LTST · ${t.daylightH.toFixed(1)} h of daylight`;
  return `<div class="pv-kv">
    <span>Local solar time</span><span><b>${hhmm(t.ltst)}</b> true · ${hhmm(t.lmst)} mean</span>
    <span>Sun now</span><span>${t.day ? `${t.sun.elevation.toFixed(1)}° high, ${compass(t.sun.azimuth)} (${t.sun.azimuth.toFixed(0)}°)` : `night · sun ${Math.abs(t.sun.elevation).toFixed(0)}° below the horizon`}
      ${t.toSetH != null ? ` · sets in ${Math.floor(t.toSetH)} h ${Math.round((t.toSetH % 1) * 60)} min` : t.toRiseH != null ? ` · rises in ${Math.floor(t.toRiseH)} h ${Math.round((t.toRiseH % 1) * 60)} min` : ""}</span>
    <span>Sol</span><span>${sunTxt}; noon sun ${Math.max(-90, t.noonEl).toFixed(0)}° high</span>
    <span>Season</span><span>${t.season} here (north ${t.seasonN}, south ${t.seasonS}) · Ls ${t.Ls.toFixed(1)}° · Mars Year ${t.marsYear}</span>
    <span>Dust</span><span>${t.dustSeason ? '<span class="pv-warn">dust-storm season (Ls 180–360, near perihelion)</span>' : "outside the dust-storm season (Ls 0–180)"}</span>
    <span>Sunlight above the air</span><span>${fmtN(t.toa)} W/m² now (Mars ${Math.sqrt(1361 / t.toa).toFixed(2)} AU from the Sun)</span>
    <span>Earth</span><span>${t.earthAU.toFixed(2)} AU away · radio ${t.lightMin.toFixed(1)} min one way</span>
  </div>`;
}

// ------------------------------------------------------------------------------------------------ the sections ----
function meter(label, v, title = "SWIM ice consistency Ci: +1 every dataset agrees with ice, 0 ambiguous, -1 inconsistent. Tick: 0.5") {
  if (v == null || !isFinite(v)) return `<div class="pv-meter"><span>${label}</span><span class="tr"></span><span class="n pv-na">–</span></div>`;
  const x = Math.max(-1, Math.min(1, v)), left = x >= 0 ? 50 : 50 + x * 50, w = Math.abs(x) * 50;
  const col = x >= 0.5 ? "var(--pv-info)" : x >= 0 ? "#7fc4ff99" : "var(--pv-bad)";
  return `<div class="pv-meter" title="${title}"><span>${label}</span><span class="tr"><i style="left:${left}%;width:${w}%;background:${col}"></i><b></b></span><span class="n">${x >= 0 ? "+" : ""}${x.toFixed(2)}</span></div>`;
}
function rel(label, r, note) {
  if (r?.pending) return `<div class="pv-rel"><span>${label}</span><span class="tr"></span><span class="n pv-na">reading…</span></div>`;
  if (!r || r.rel == null) return `<div class="pv-rel"><span>${label}</span><span class="tr"></span><span class="n pv-na">no data here</span></div>`;
  return `<div class="pv-rel" title="${esc(note || "Relative: position on the published colour scale, low to high")}"><span>${label}</span><span class="tr"><i style="width:${Math.max(3, 100 * r.rel)}%"></i></span><span class="n">${esc(r.word)}</span></div>`;
}
const kv = (rows) => `<div class="pv-kv">${rows.filter(Boolean).map(([a, b]) => `<span>${a}</span><span>${b}</span>`).join("")}</div>`;
const sec = (id, title, sub, body) => ({ id, title, sub, html: body });

/** The place's sections as [{id, title, sub, html}]. opts.links: true to make built sites links into the planner. */
export function placeSections(d, opts = {}) {
  const out = [];
  const W = d.where || {}, E = d.environment || {}, S = d.surface || {}, Wt = d.water || {}, C = d.composition || {}, inst = d.installed || {};
  const q = W.quadrangle || {}, site = d.sites?.inside;
  // where
  out.push(sec("where", "Where", "position, chart and names", kv([
    ["Position", `${ll(d.lat, d.lon)} <span class="pv-na">(${fmtN(W.lon_east, 3)}°E · ${fmtN(W.lon_west, 3)}°W)</span>`],
    ["USGS chart", `${esc(q.id)} ${esc(q.name)} quadrangle`],
    ["Terrain", esc(W.hemisphere || "–")],
    ["Elevation", d.elevation?.m != null ? `${fmtN(d.elevation.m)} m <span class="pv-na">${esc(d.elevation.source || "")}</span>` : NA("MOLA not downloaded")],
    W.names?.length ? ["Named features", W.names.slice(0, 4).map((n) => `${esc(n.name)} <span class="pv-na">${esc(n.type || "")}, ${fmtKm(n.dist_km)}</span>`).join("<br>")] : null,
    site ? ["Built EVA site", opts.links ? `<a href="index.html#${encodeURIComponent(site.id)}">${esc(site.name)}</a> (this place is inside it)` : `${esc(site.name)} (inside)`]
      : d.sites?.nearest?.length ? ["Nearest hub", `${esc(d.sites.nearest[0].name)}, ${fmtKm(d.sites.nearest[0].dist_km)}`] : null,
  ])));
  // survival
  const wp = E.water, g = E.gravity, sw = d.spaceweather;
  out.push(sec("env", "Survival here", "air, water, radiation, gravity, sunlight", kv([
    ["Air pressure", E.pressure_pa != null && d.elevation?.m != null ? `${fmtN(E.pressure_pa)} Pa <span class="pv-na">(${fmtN(E.pressure_pa / 1013.25, 2)} % of Earth's)</span>` : "–"],
    ["Liquid water", wp ? (wp.liquid_possible ? `possible between 0 and ${fmtN(wp.boil_c, 1)} °C (boils above)` : '<span class="pv-warn">no: below the triple point, ice sublimes</span>') : "–"],
    ["Air overhead", E.column_g_cm2 != null ? `${fmtN(E.column_g_cm2, 1)} g/cm² of shielding` : "–"],
    ["Cosmic-ray dose", E.gcr_ugy_day != null ? `${fmtN(E.gcr_ugy_day)} µGy/day · ${fmtN(E.gcr_msv_day, 2)} mSv/day <span class="pv-na">(${E.gcr_vs_gale >= 1 ? "+" : ""}${fmtN(100 * (E.gcr_vs_gale - 1))} % vs Curiosity at Gale)</span>${E.gcr_extrapolated ? ' <span class="pv-warn">extrapolated</span>' : ""}` : "–"],
    E.gcr_msv_day != null ? ["500-sol stay", `≈ ${fmtN(E.gcr_msv_day * 500 * 1.0275)} mSv on the surface, cosmic rays only`] : null,
    ["Gravity", g ? `${fmtN(g.g_ms2, 3)} m/s² · ${fmtN(100 * g.earth_ratio, 1)} % of Earth's${d.gravity_anomaly_mgal != null ? ` <span class="pv-na">(anomaly ${d.gravity_anomaly_mgal > 0 ? "+" : ""}${fmtN(d.gravity_anomaly_mgal)} mGal)</span>` : ""}` : "–"],
    ["Sunlight, above air", E.sun_toa ? `${fmtN(E.sun_toa.mean_wm2)} W/m² sol mean (${fmtN(E.sun_toa.min_wm2)}–${fmtN(E.sun_toa.max_wm2)} over the year)` : "–"],
    ["Sunlight, at ground", E.sun_surface_mean_wm2 != null ? `≈ ${fmtN(E.sun_surface_mean_wm2)} W/m² mean, ${fmtN(E.sun_surface_min_wm2)} in the darkest season` : "–"],
    ["Space weather", sw?.have_data ? `<span class="${sw.level === "quiet" ? "pv-ok" : sw.level === "storm" ? "pv-bad" : "pv-warn"}">${esc(sw.headline)}</span>` : '<span class="pv-na">no NASA DONKI data yet</span>'],
  ]) + `<p class="pv-hint">Pressure is the mean for this elevation (it swings ±12 % over the year). Dose: Curiosity's RAD record, moved by the air column; solar particle events come on top.</p>`));
  // ground
  const ti = S.ti, cr = S.craters, cz = S.craters_zone, geo = S.geology, ro = S.roughness, dc = S.dust_cover;
  out.push(sec("ground", "Ground", "what the crew walks and builds on", kv([
    ["Thermal inertia", ti ? (ti.value != null ? `${fmtN(ti.value)} SI · ${esc(ti.class)}` : NA("no TES value here")) : NA()],
    ["Geologic unit", geo?.pending ? NA("asking the USGS map…") : geo?.unit ? `<b>${esc(geo.unit)}</b> · ${esc(geo.description || "")}` : geo?.error ? NA("USGS map service not reachable") : "–"],
    ["Albedo (TES)", S.albedo != null ? `${fmtN(S.albedo, 3)} <span class="pv-na">${S.albedo >= 0.22 ? "bright, dusty" : S.albedo <= 0.15 ? "dark: sand or rock" : "intermediate"}</span>` : inst.albedo === false ? NA() : NA("no value here")],
    ["Craters here", !cr ? NA() : cr.inside ? `inside a ${cr.inside.diameter_km.toFixed(1)} km crater, ${fmtKm(cr.inside.rim_km)} from its rim` : "not inside a crater of 1 km or more"],
    cr ? ["Within 10 km", `${cr.count} craters ≥ 1 km${cr.count_5km ? `, ${cr.count_5km} ≥ 5 km` : ""}`] : null,
    cz ? ["Within 100 km", `${cz.count} craters ≥ 1 km (${fmtN(cz.n1_per_1e6km2)} per 10⁶ km²)${cz.largest_km ? `, largest ${cz.largest_km.toFixed(0)} km` : ""}`] : null,
  ]) + rel("Dust cover", dc, "TES dust cover index (Ruff & Christensen 2002): high is thick dust hiding the rock")
     + (ro?.pending ? rel("Roughness", ro) : ro ? `<div class="pv-rel" title="MOLA roughness at 0.6, 2.4 and 9.2 km baselines (Kreslavsky & Head 2000), relative"><span>Roughness</span><span class="tr tri"><i style="width:${100 * ro.km_0_6}%"></i><i style="width:${100 * ro.km_2_4}%"></i><i style="width:${100 * ro.km_9_2}%"></i></span><span class="n">${esc(ro.word)}</span></div>` : rel("Roughness", null))
     + `<p class="pv-hint">Dust and roughness are read back from the published Trek colour maps: relative, low to high. Roughness bars: 0.6, 2.4 and 9.2 km scales.</p>`));
  // water
  const di = Wt.ice, ni = Wt.nearest_ice;
  let water = "";
  if (di) water += `<div class="pv-lbl">SWIM ice consistency here</div>${meter("0–1 m", di["0-1 m"])}${meter("1–5 m", di["1-5 m"])}${meter("&gt; 5 m", di[">5 m"])}`;
  else if (inst.swim === false) water += `<p class="pv-hint">SWIM ice layer not installed (Data tab in Landing mode).</p>`;
  if (ni?.outside) water += `<p class="pv-hint">Poleward of 60° SWIM has no map; shallow ground ice is common there (Phoenix dug into it at 68°N).</p>`;
  else if (ni?.found) water += kv([["Nearest ice (Ci ≥ 0.5)", `<span class="${ni.dist_km <= 5 ? "pv-ok" : "pv-warn"}">${fmtKm(ni.dist_km)} away, ${esc(ni.depth)}, Ci ${ni.ci >= 0 ? "+" : ""}${ni.ci.toFixed(2)}</span>`],
    ["Ice-consistent ground", `${Math.round(100 * (ni.share_within_km || 0))} % of the 100 km around`]]);
  else if (ni) water += `<p class="pv-bad">No ice-consistent ground (Ci ≥ 0.5, 0–5 m) within 100 km${ni.best_ci != null ? `; best Ci ${ni.best_ci >= 0 ? "+" : ""}${ni.best_ci.toFixed(2)}` : ""}.</p>`;
  water += kv([["GRS hydrogen", Wt.grs_h2o_wt != null ? `${fmtN(Wt.grs_h2o_wt, 1)} wt % water-equivalent in the top ~0.5 m <span class="pv-na">(5° cell)</span>` : inst.grs === false ? NA() : NA("no value at this latitude")]]);
  out.push(sec("water", "Water and ice", "for drinking, oxygen and fuel (ISRU)", water));
  // composition
  const ch = C.chem, mi = C.minerals || {};
  const hyd = ["hydrous", "aqueous", "chlorides"].map((k) => d.science?.context?.layers?.[k]).filter(Boolean);
  out.push(sec("comp", "Composition", "minerals and elements", `<div class="pv-lbl">Minerals (TES, 16 km)</div>
    ${rel("Plagioclase", mi.tes_plag, "Plagioclase feldspar (Bandfield 2002): basaltic rock")}${rel("Pyroxene", mi.tes_cpx, "High-calcium pyroxene (Bandfield 2002): unaltered volcanic rock")}${rel("Glass / clay", mi.tes_glass, "Sheet silicates or high-silica glass (Bandfield 2002): weathered rock")}
    ${kv([...(ch ? Object.values(ch).map((e) => [`${esc(e.name)} (GRS)`, e.value != null ? `${fmtN(e.value, e.value < 2 ? 2 : 1)} ${esc(e.unit)}` : NA("no measurement here")]) : [["GRS elements", NA()]]),
      ...hyd.map((p) => [esc(p.name), `${fmtN(p.count)} within 100 km · nearest ${esc(p.nearest.label)}, ${fmtKm(p.nearest.km)}`])])}`));
  // science
  const sc = d.science?.context;
  if (sc) {
    const rows = Object.values(sc.layers || {}).sort((a, b) => (a.nearest?.km ?? 1e9) - (b.nearest?.km ?? 1e9))
      .map((p) => [esc(p.name), `${fmtN(p.count)} within ${fmtN(sc.radius_km)} km · nearest: ${esc(p.nearest.label)}, ${fmtKm(p.nearest.km)}`]);
    const pp = sc.planetary_protection;
    const top = Math.max(1, ...(d.objectives || []).map((o) => o.score || 0));
    out.push(sec("science", "Science here", "catalogued features within 100 km, objectives",
      (rows.length ? kv(rows) : `<p class="pv-hint">No catalogued minerals, ice landforms, active slopes or mission sites within ${fmtN(sc.radius_km)} km.</p>`)
      + (pp ? `<p class="pv-warn">Planetary protection: ${esc(pp.label)} ${fmtKm(pp.nearest_rsl_km)} away. ${esc(pp.note)}</p>` : "")
      + ((d.objectives || []).length && !d.objectives[0].error ? `<div class="pv-lbl">Science objectives scored here</div>${d.objectives.map((o) =>
        `<div class="pv-obj" title="${esc([...(o.evidence || []).map((e) => `${e.count} ${e.class === "*" ? e.layer : e.class} (nearest ${e.nearest_km} km)`), ...(o.data || [])].join(" · "))}"><span>${esc(o.title)}</span><span class="tr"><i style="width:${Math.max(3, 100 * (o.score || 0) / top)}%"></i></span><span class="n">${(o.score || 0).toFixed(1)}</span></div>`).join("")}` : "")));
  }
  // missions and candidates
  const cx = d.context || {};
  out.push(sec("missions", "Missions and sites nearby", "landed, proposed, named", kv([
    ...(d.missions || []).slice(0, 4).map((m) => [esc(m.name), `${fmtKm(m.dist_km)} ${compass(m.bearing_deg)} <span class="pv-na">${[m.agency, m.status, m.years].filter((x) => x && x !== "-").map(esc).join(" · ")}</span>`]),
    ...(cx.ez || []).slice(0, 2).map((e) => [`EZ ${esc(e.name)}`, `${fmtKm(e.dist_km)} <span class="pv-na">NASA Exploration Zone (2015)</span>`]),
    ...(cx.starship || []).slice(0, 1).map((e) => [`Starship ${esc(e.name)}`, `${fmtKm(e.dist_km)} <span class="pv-na">Golombek et al. 2021</span>`]),
  ])));
  // data coverage
  const cv = d.coverage || {};
  const hi = cv.hirise || {}, cx2 = cv.ctx || {};
  out.push(sec("data", "Best data here", "elevation models covering this point", kv([
    ["HiRISE 1 m DTMs", hi.count ? `${hi.count} · ${hi.items.slice(0, 3).map((i) => esc(i.id)).join(", ")}` : hi.ready === false ? NA("catalogue loading") : "none"],
    ["CTX 20 m DTMs", cx2.count ? `${cx2.count}` : cx2.ready === false ? NA("catalogue loading") : "none"],
    ["Finest elevation", cv.best_m ? `${cv.best_m} m (a hub built here gets it)` : "MOLA 463 m / HRSC-MOLA 200 m only"],
  ])));
  out.push(sec("sources", "Sources", "", `<ul class="pv-src">
    <li>Elevation: MOLA MEGDR (Smith et al. 2001). Pressure: 610 Pa datum, 11.1 km scale height. Gravity: GM, J2, spin (MRO, Konopliv et al. 2016); anomaly MRO GMM-3 (Genova et al. 2016).</li>
    <li>Ice: SWIM (Morgan et al. 2021, 2025). Hydrogen and elements: Mars Odyssey GRS (Boynton et al. 2007). Thermal inertia: TES (Putzig &amp; Mellon 2007). Albedo, dust, minerals: TES (Christensen et al. 2001; Ruff &amp; Christensen 2002; Bandfield 2002). Roughness: MOLA (Kreslavsky &amp; Head 2000).</li>
    <li>Craters: Robbins &amp; Hynek (2012, 2020 update). Geology: Tanaka et al. 2014, USGS SIM 3292. Names: IAU Gazetteer. Charts: USGS 1:5M MC quadrangles.</li>
    <li>Radiation: Curiosity RAD (Hassler et al. 2014; Guo et al. 2017). Space weather: NASA DONKI. Time: Mars24 (Allison &amp; McEwen 2000).</li>
  </ul>`));
  return out;
}

/** The sections as HTML: each a <section class="pv-sec"> with a title bar (collapsible with <details> when opts.fold). */
export function placeHtml(d, opts = {}) {
  return placeSections(d, opts).map((s) => opts.fold
    ? `<details class="pv-sec" data-pv="${s.id}"${(opts.open || ["where", "env", "ground", "water"]).includes(s.id) ? " open" : ""}><summary>${esc(s.title)}${s.sub ? ` <small>${esc(s.sub)}</small>` : ""}</summary>${s.html}</details>`
    : `<section class="pv-sec" data-pv="${s.id}"><h3>${esc(s.title)}${s.sub ? ` <small>${esc(s.sub)}</small>` : ""}</h3>${s.html}</section>`).join("");
}

/** A short list for crew displays: [{k, v, cls}] (cls: "", "c-caution", "c-warning"), the facts that matter in a suit. */
export function placeFacts(d) {
  if (!d) return [];
  const E = d.environment || {}, S = d.surface || {}, Wt = d.water || {}, ni = Wt.nearest_ice;
  const f = [];
  if (E.pressure_pa != null && d.elevation?.m != null) f.push({ k: "Air", v: `${fmtN(E.pressure_pa)} Pa`, cls: "" });
  if (E.gcr_msv_day != null) f.push({ k: "Dose rate", v: `${fmtN(E.gcr_msv_day, 2)} mSv/day`, cls: E.gcr_vs_gale > 1.15 ? "c-caution" : "" });
  if (d.spaceweather?.have_data && d.spaceweather.level) f.push({ k: "Space wx", v: d.spaceweather.level.toUpperCase(), cls: d.spaceweather.level === "storm" ? "c-warning" : d.spaceweather.level === "quiet" ? "" : "c-caution" });
  if (E.gravity) f.push({ k: "Gravity", v: `${fmtN(E.gravity.earth_ratio, 3)} g`, cls: "" });
  if (E.water) f.push({ k: "Water", v: E.water.liquid_possible ? `boils ${fmtN(E.water.boil_c, 1)} °C` : "sublimes", cls: "" });
  if (S.ti?.value != null) f.push({ k: "Ground", v: `${S.ti.class}`, cls: S.ti.value < 100 ? "c-caution" : "" });
  if (S.dust_cover?.word) f.push({ k: "Dust", v: S.dust_cover.word, cls: S.dust_cover.rel >= 0.8 ? "c-caution" : "" });
  if (ni) f.push({ k: "Ice", v: ni.outside ? "polar (likely)" : ni.found ? `${fmtKm(ni.dist_km)} ${ni.depth}` : "none in 100 km", cls: ni.found || ni.outside ? "" : "c-caution" });
  else if (Wt.grs_h2o_wt != null) f.push({ k: "H₂O", v: `${fmtN(Wt.grs_h2o_wt, 0)} wt %`, cls: "" });
  if (S.geology?.unit) f.push({ k: "Unit", v: S.geology.unit, cls: "" });
  const pp = d.science?.context?.planetary_protection;
  if (pp) f.push({ k: "Protect", v: `${pp.label} ${fmtKm(pp.nearest_rsl_km)}`, cls: "c-warning" });
  const best = (d.objectives || []).find((o) => !o.error && o.score > 0);
  if (best) f.push({ k: "Science", v: best.title.split(":")[0], cls: "" });
  return f;
}

/** The nearest catalogued features, one line each (for the cuff and the dashboard). */
export function nearFeatures(d, k = 5) {
  return (d?.science?.nearest || []).slice(0, k).map((r) => ({ label: r.label, layer: r.layer, km: r.km }));
}
export { fmtKm as placeFmtKm, hhmm as placeHhmm, compass as placeCompass };
