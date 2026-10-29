// Screenshots for the 2.1 figures of the user guide (Chapters 4-6, 8, 10, 13), taken in Chromium from the running app.
// The 2.0 figures come from capture_guide.py (the desktop window); these are page captures without the window frame.
//
//   MarsNav.exe --headless --port 8765          (or: python launcher/martian_map.py --headless --no-browser)
//   node tools/guide/capture_guide21.js [landing] [planner] [hud]        (needs Playwright with Chromium)
//
// Pictures go to data_cache/guide/*.png; python tools/guide/builder/build.py crops them into tools/guide/assets/img and
// builds the PDF. BASE=http://127.0.0.1:<port> points it at another server.
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");
const OUT = path.join(__dirname, "..", "..", "data_cache", "guide");
fs.mkdirSync(OUT, { recursive: true });
const BASE = process.env.BASE || "http://127.0.0.1:8765";
const parts = process.argv.slice(2);
const want = (p) => !parts.length || parts.includes(p);
const W = 1800, H = 1030;
(async () => {
  const b = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
  const ctx = await b.newContext({ viewport: { width: W, height: H } });
  const errs = [];
  const watch = (p, t) => { p.on("pageerror", (e) => errs.push(`${t}: ${e.message}`)); };
  const marks = async (p, sels) => p.evaluate((sels) => sels.map(([s, n]) => { const e = document.querySelector(s); if (!e) return [s, null]; const r = e.getBoundingClientRect(); return [n, +((r.x + r.width / 2) / innerWidth).toFixed(3), +((r.y + r.height / 2) / innerHeight).toFixed(3)]; }), sels);
  const ready = (p) => p.waitForFunction(() => document.getElementById("busy").hidden && document.querySelector("#cards .card"), null, { timeout: 240000 });
  // ------------------------------------------------------------------ Landing mode overview with markers
  if (want("landing")) {
    const L = await ctx.newPage(); watch(L, "landing");
    await L.goto(`${BASE}/landing.html`); await L.waitForTimeout(4000);
    if (!(await L.$eval("#layers", (e) => e.classList.contains("collapsed")))) await L.click("#layersToggle");
    await L.waitForFunction(() => /screened/.test(document.getElementById("screenNote")?.textContent || "") && /ONLINE/.test(document.getElementById("netPill")?.textContent || ""), null, { timeout: 120000 });
    await L.waitForTimeout(9000);
    await L.screenshot({ path: `${OUT}/l01_overview.png` });
    // marker positions for the figure (fractions of the picture): print them to update c2_landing.py
    console.log("l01 marks", JSON.stringify(await marks(L, [[".modsw", 1], ["#searchIn", 2], [".seg[aria-label='Criteria set']", 3], ["#netPill", 4], ["#swxPill", 5], ["#btnHelp", 6], ["#landerSel", 7], [".tabs", 8], ["#btnScreen", 9], ["#candList li", 10], ["#layersToggle", 11], ["#globe", 12], ["#ctrls", 13], ["#dossier", 14]])));
    if (await L.$eval("#layers", (e) => e.classList.contains("collapsed"))) await L.click("#layersToggle");
    // everything at a place: Jezero
    await L.goto(`${BASE}/landing.html#18.44,77.45,400,0,0,best,hls2,,`); await L.reload(); await L.waitForTimeout(9000);
    const g = await L.$eval("#globe", (c) => { const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await L.mouse.click(g.x, g.y);
    await L.waitForFunction(() => /All data at this place/.test(document.querySelector("#dPlace")?.textContent || ""), null, { timeout: 60000 });
    await L.waitForTimeout(9000);
    await L.screenshot({ path: `${OUT}/g01_place_full.png` });
    const sec = async (pv, name, extraOpen = []) => {
      await L.evaluate(([pv, ex]) => { for (const d of document.querySelectorAll("#dPlace details")) if (ex.includes(d.dataset.pv)) d.open = true; const e = document.querySelector(`#dPlace [data-pv="${pv}"]`); const D = document.getElementById("dossier"); D.scrollTop = e.offsetTop - D.offsetTop - 4; }, [pv, extraOpen]);
      await L.waitForTimeout(600);
      await L.locator("#dossier").screenshot({ path: `${OUT}/${name}.png` });
    };
    await sec("time", "g02_place_time");
    await sec("env", "g03_place_env");
    await sec("water", "g04_place_water", ["comp", "science"]);
    await sec("science", "g05_place_science", ["science", "missions", "data"]);
    // science atlas on the globe: Nili Fossae / Syrtis, aqueous minerals + pyroxene
    await L.goto(`${BASE}/landing.html#19.5,76.0,1800,0,0,best,hls2,,`); await L.reload(); await L.waitForTimeout(8000);
    if (await L.$eval("#layers", (e) => e.classList.contains("collapsed"))) await L.click("#layersToggle");
    await L.evaluate(() => { for (const d of document.querySelectorAll("#atlasBox details")) d.open = true; });
    await L.locator('[data-ovl="f_aqueous"]').check().catch(() => {});
    await L.locator('[data-ovl="f_hydrous"]').check().catch(() => {});
    await L.waitForTimeout(12000);
    await L.screenshot({ path: `${OUT}/g06_atlas.png` });
    await L.locator('[data-ovl="f_aqueous"]').uncheck().catch(() => {});
    await L.locator('[data-ovl="f_hydrous"]').uncheck().catch(() => {});
    // science tab: objectives ranked, then missions
    await L.click('.tabs button[data-tab="sci"]'); await L.waitForTimeout(800);
    await L.selectOption("#objSel", "life");
    await L.click("#btnObjRank");
    await L.waitForSelector("#objRank li", { timeout: 90000 }); await L.waitForTimeout(1500);
    await L.locator("#left").screenshot({ path: `${OUT}/g07_objectives.png` });
    await L.click('#sciChips [data-sci="mis"]'); await L.waitForTimeout(800);
    await L.locator("#left").screenshot({ path: `${OUT}/g08_missions.png` });
    await L.click('#misChips [data-mis="future"]').catch(() => {}); await L.waitForTimeout(800);
    await L.locator("#left").screenshot({ path: `${OUT}/g08b_missions_future.png` });
    // space weather
    await L.click("#swxPill"); await L.waitForTimeout(1500);
    await L.screenshot({ path: `${OUT}/g09_swx.png` });
    await L.keyboard.press("Escape");
    // dossier after an assessment at Gale: science along the way, objectives, chemistry
    await L.goto(`${BASE}/landing.html#-4.75,137.38,300,0,0,best,hls2,,`); await L.reload(); await L.waitForTimeout(9000);
    await L.mouse.click(g.x + 60, g.y + 40);
    await L.waitForFunction(() => /All data at this place/.test(document.querySelector("#dPlace")?.textContent || ""), null, { timeout: 60000 });
    await L.click("#btnAssess");
    await L.waitForFunction(() => /Science along the way/.test(document.querySelector("#dSections")?.textContent || ""), null, { timeout: 150000 });
    await L.waitForTimeout(2500);
    await L.evaluate(() => { const h = [...document.querySelectorAll("#dSections .sect h3")].find((x) => /Science along/.test(x.textContent)); const D = document.getElementById("dossier"); D.scrollTop = h.closest(".sect").offsetTop - D.offsetTop - 4; });
    await L.waitForTimeout(600);
    await L.locator("#dossier").screenshot({ path: `${OUT}/g10_dossier_science.png` });
    await L.close();
  }
  // ------------------------------------------------------------------ EVA planner: Mount Sharp, place card, photos
  if (want("planner")) {
    const P = await ctx.newPage(); watch(P, "planner");
    await P.goto(`${BASE}/index.html#g_4p811s_137p384e`); await ready(P); await P.waitForTimeout(2000);
    await P.click("#zoomFit"); await P.waitForTimeout(2500);
    await P.screenshot({ path: `${OUT}/g11_mount_sharp.png` });
    await P.click("#btn3d"); await P.waitForTimeout(7000);
    await P.screenshot({ path: `${OUT}/g11b_mount_sharp_3d.png` });
    await P.click("#v3close"); await P.waitForTimeout(800);
    const r = await P.$eval("#map", (c) => { const q = c.getBoundingClientRect(); return { x: q.x + q.width * 0.55, y: q.y + q.height * 0.45 }; });
    await P.mouse.click(r.x, r.y);
    await P.waitForFunction(() => /Planet-wide data/.test(document.querySelector("#pcPlanet")?.textContent || ""), null, { timeout: 60000 });
    await P.waitForTimeout(6000);
    await P.screenshot({ path: `${OUT}/g12_place_card.png` });
    await P.keyboard.press("Escape");
    // photos at a station (Jezero)
    await P.goto(`${BASE}/index.html#jezero`); await P.reload(); await ready(P); await P.waitForTimeout(1500);
    await P.locator("#left").screenshot({ path: `${OUT}/g13_stations_pov.png` }).catch(() => {});
    const pov = await P.$("[data-pov]");
    if (pov) { await pov.scrollIntoViewIfNeeded(); await P.locator("#left").screenshot({ path: `${OUT}/g13_stations_pov.png` }); await pov.click(); await P.waitForTimeout(3000); await P.screenshot({ path: `${OUT}/g14_pov_modal.png` }); await P.keyboard.press("Escape"); }
    await P.close();
  }
  // ------------------------------------------------------------------ crew displays during a simulated EVA at Jezero
  if (want("hud")) {
    const P = await ctx.newPage(); watch(P, "planner");
    await P.goto(`${BASE}/index.html#jezero`); await ready(P);
    const Hd = await ctx.newPage(); watch(Hd, "hud");
    await Hd.setViewportSize({ width: 1280, height: 720 });
    await Hd.goto(`${BASE}/hud.html?mode=visor`);
    await Hd.waitForFunction(() => document.body.classList.contains("ready"), null, { timeout: 20000 });
    await P.click("#tabExec"); await P.selectOption("#simSpeed", "120"); await P.click("#btnRun"); await P.waitForTimeout(16000);
    await Hd.screenshot({ path: `${OUT}/g15_visor.png` });
    await Hd.keyboard.press("2"); await Hd.setViewportSize({ width: 1400, height: 820 }); await Hd.waitForTimeout(2500);
    await Hd.screenshot({ path: `${OUT}/g16_rover.png` });
    await Hd.click('[data-rfit="site"]'); await Hd.waitForTimeout(2500);
    await Hd.screenshot({ path: `${OUT}/g16b_rover_site.png` });
    await Hd.click('[data-rfit="route"]');
    await Hd.click('[data-rtab="data"]'); await Hd.waitForTimeout(1500);
    await Hd.screenshot({ path: `${OUT}/g17_rover_data.png` });
    await Hd.click('[data-rtab="map"]');
    await Hd.keyboard.press("3"); await Hd.setViewportSize({ width: 480, height: 2300 }); await Hd.waitForTimeout(2500);
    await Hd.screenshot({ path: `${OUT}/g18_cuff.png` });
    // a suit leak: the visor in RETURN
    await P.click('[data-fault="leak"]'); await P.waitForTimeout(4000);
    await Hd.keyboard.press("1"); await Hd.setViewportSize({ width: 1280, height: 720 }); await Hd.waitForTimeout(2000);
    await Hd.screenshot({ path: `${OUT}/g15b_visor_leak.png` });
    await Hd.close(); await P.close();
    // survey of a place (no EVA)
    const Sv = await ctx.newPage(); watch(Sv, "survey");
    await Sv.setViewportSize({ width: 1400, height: 820 });
    await Sv.goto(`${BASE}/hud.html?mode=rover&lon=137.384&lat=-4.811&name=Mount%20Sharp%20boxwork`); await Sv.waitForTimeout(14000);
    await Sv.screenshot({ path: `${OUT}/g19_survey_rover.png` });
    await Sv.click('#modes [data-mode="visor"]'); await Sv.setViewportSize({ width: 1280, height: 720 }); await Sv.waitForTimeout(2500);
    await Sv.screenshot({ path: `${OUT}/g19b_survey_visor.png` });
    await Sv.click('#modes [data-mode="cuff"]'); await Sv.setViewportSize({ width: 480, height: 1500 }); await Sv.waitForTimeout(3000);
    await Sv.screenshot({ path: `${OUT}/g19c_survey_cuff.png` });
    await Sv.close();
  }
  console.log("errors", JSON.stringify(errs));
  await b.close();
})();
