// capture_eva.mjs - one simulated EVA at Jezero, captured frame by frame on the planner and on the three crew
// displays at once (helmet visor, rover dashboard, wrist cuff), with a suit leak injected part-way.
//
// Every page runs on a virtual clock (lib/vt_shim.js). Each frame the planner's clock moves 1/30 s; when its 500 ms
// simulation tick fires, the capture waits for the engine's reply and for the snapshot to reach every display, then
// moves each display's clock 1/30 s and takes the screenshots. Nothing in the app is changed: the displays show what
// the planner's simulator and closed loop compute, at an even 30 frames a second.
//
//   node submission/video/capture_eva.mjs [base-url] [out-dir] [seconds] [leak-at-seconds]
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || "http://127.0.0.1:8790/";
const OUT = process.argv[3] || "submission/video/build/eva";
const SECONDS = +(process.argv[4] || 10);
const LEAK_AT = +(process.argv[5] || 6.4);
const FPS = 30, DT = 1000 / FPS;
const SHIM = fs.readFileSync(path.join(HERE, "lib", "vt_shim.js"), "utf8");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// display pages: viewport and how often a frame is kept (every n-th video frame)
const DISPLAYS = {
  visor: { size: { width: 1920, height: 1080 }, every: 1 },
  rover: { size: { width: 1600, height: 900 }, every: 2 },
  cuff: { size: { width: 480, height: 1150 }, every: 2 },
};
const PLANNER_EVERY = 2;
// The planner's simulator ticks every 500 ms of its clock. Its clock runs PLANNER_K times faster than the displays',
// at SIM_SPEED x per tick, so the displays get a snapshot about 8 times a second and the crew moves smoothly at
// SIM_SPEED * PLANNER_K times real time on screen.
const SIM_SPEED = +(process.env.SIM_SPEED || 15), PLANNER_K = +(process.env.PLANNER_K || 4);
// the crew displays as a device shows them: no browser tab bar, no "drag to look around" hint
const DEVICE_CSS = "#modes{display:none!important} #v3dNote{display:none!important}";

for (const d of ["planner", ...Object.keys(DISPLAYS)]) fs.mkdirSync(path.join(OUT, d), { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await ctx.addInitScript(SHIM);
const errs = [];

const planner = await ctx.newPage();
planner.on("pageerror", (e) => errs.push(`planner: ${e.message}`));
await planner.goto(new URL("index.html", BASE).href, { waitUntil: "load" });
await planner.waitForFunction(() => document.querySelector("#busy").hidden && !document.querySelector("#btnPlan").disabled, null, { timeout: 120000 });
await wait(1000);
await planner.click("#btnPlan");
await planner.waitForFunction(() => document.querySelectorAll("#cards .card").length >= 3 && document.querySelector("#busy").hidden, null, { timeout: 180000 });
await wait(1500);
console.log("planned");

const pages = {};
for (const [mode, d] of Object.entries(DISPLAYS)) {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errs.push(`${mode}: ${e.message}`));
  await p.setViewportSize(d.size);
  await p.goto(new URL(`hud.html?mode=${mode}`, BASE).href, { waitUntil: "load" });
  await p.addStyleTag({ content: DEVICE_CSS });
  pages[mode] = p;
}
// the displays say hello and receive the plan; the visor builds its 3D terrain
await pages.visor.waitForFunction(() => document.body.classList.contains("ready"), null, { timeout: 60000 });
await pages.visor.waitForFunction(() => { const w = document.getElementById("v3d"); return w && !w.hidden && w.querySelector("canvas"); }, null, { timeout: 120000 })
  .catch(() => console.log("visor 3D did not appear"));
await wait(4000);
console.log("displays ready");

// fly the first part of the EVA quickly, then slow down for the capture
await planner.click("#tabExec");
await wait(500);
await planner.selectOption("#simSpeed", "600");
await planner.click("#btnRun");
await wait(+(process.env.FF_MS || 7000));
await planner.click("#btnPause");
await wait(800);
await planner.evaluate((v) => {
  const s = document.querySelector("#simSpeed");
  if (![...s.options].some((o) => o.value === v)) s.add(new Option(`${v}x`, v));
  s.value = v;
}, String(SIM_SPEED));
await wait(300);
console.log("fast-forwarded");

// stop every clock, start the simulator, and step
const all = [planner, ...Object.values(pages)];
for (const p of all) await p.evaluate(() => window.__vt.auto(false));
await planner.click("#btnRun");
const t0 = await planner.evaluate(() => window.__vt.now());
const N = Math.round(SECONDS * FPS), leakFrame = Math.round(LEAK_AT * FPS);
const log = { fps: FPS, frames: N, leakFrame, planner_every: PLANNER_EVERY, sim_speed: SIM_SPEED, planner_k: PLANNER_K, displays: {} };
for (const [m, d] of Object.entries(DISPLAYS)) log.displays[m] = { every: d.every, size: d.size };

async function waitDelivered(posted) {
  for (const [m, p] of Object.entries(pages)) {
    await p.waitForFunction((n) => window.__bc.received >= n, posted, { timeout: 8000 }).catch(() => console.log(`  ${m} missed snapshot ${posted}`));
  }
}

const started = Date.now();
for (let f = 0; f < N; f++) {
  const before = await planner.evaluate(() => window.__bc.posted);
  const { a, b } = await planner.evaluate((dt) => { const a = window.__vt.now(); window.__vt.step(dt); return { a, b: window.__vt.now() }; }, DT * PLANNER_K);
  const ticked = Math.floor((b - t0) / 500) > Math.floor((a - t0) / 500);
  if (f === leakFrame) {
    await planner.click("[data-fault=leak]");
    console.log(`  suit leak injected at frame ${f}`);
  }
  if (ticked || f === leakFrame) {
    await planner.waitForFunction((n) => window.__bc.posted > n, before, { timeout: 10000 }).catch(() => console.log(`  no snapshot after frame ${f}`));
  }
  const posted = await planner.evaluate(() => window.__bc.posted);
  await waitDelivered(posted);
  for (const p of Object.values(pages)) await p.evaluate((dt) => window.__vt.step(dt), DT);
  const name = String(f).padStart(4, "0") + ".jpg";
  for (const [m, d] of Object.entries(DISPLAYS)) {
    if (f % d.every === 0) await pages[m].screenshot({ path: path.join(OUT, m, name), type: "jpeg", quality: 93 });
  }
  if (f % PLANNER_EVERY === 0) await planner.screenshot({ path: path.join(OUT, "planner", name), type: "jpeg", quality: 93 });
  if (f % 30 === 0) console.log(`frame ${f}/${N}  ${((Date.now() - started) / 1000).toFixed(0)} s`);
}
fs.writeFileSync(path.join(OUT, "capture.json"), JSON.stringify({ ...log, errors: errs.slice(0, 40) }, null, 1));
if (errs.length) console.log("page errors:", errs.slice(0, 8));
await browser.close();
