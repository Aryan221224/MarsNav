// capture_loop.mjs - the closed loop at work, for the video. The planner flies the campaign's Jezero EVA (Amalik, then
// Issole; validation/closed_loop_campaign.mjs) with a hidden crew that works 35 % harder than the plan assumed
// ("hardwork" in engine/sim.js). The closed-loop panel learns the real rates from the suit telemetry alone and the
// planner re-plans before the reserve is touched.
//
// The page runs on the virtual clock (lib/vt_shim.js). Every frame moves the clock exactly one simulator tick (500 ms),
// waits until the engine has answered every request (a re-plan takes about a second of real time) and takes a
// screenshot at twice the screen density, so the editor gets one even frame per tick and can push in on the panel and
// the map. Nothing in the app is changed.
//
//   node submission/video/capture_loop.mjs [base-url] [out-dir]          SPEED=60 (x real time per tick of 0.5 s)
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || "http://127.0.0.1:8790/";
const OUT = process.argv[3] || "submission/video/build/loop";
const SPEED = process.env.SPEED || "60";
const AFTER = +(process.env.AFTER || 30);                 // frames kept after the re-plan
const MAX = +(process.env.MAX || 200);
const SHIM = fs.readFileSync(path.join(HERE, "lib", "vt_shim.js"), "utf8");
// count every request to the planning engine and every reply, so a frame is taken only once the engine is idle
// (requests carry an id and the engine answers with the same id; other messages are not waited for)
const WORKER_COUNT = `(() => {
  const W = window.Worker; const open = new Set(); window.__wk = { open };
  window.Worker = class extends W {
    constructor(...a) {
      super(...a);
      this.__k = Math.random() + ":";
      this.addEventListener("message", (e) => { if (e.data && e.data.id != null) open.delete(this.__k + e.data.id); });
    }
    postMessage(m, ...r) { if (m && m.id != null && m.type) { open.add(this.__k + m.id); (window.__wk.types ||= {})[this.__k + m.id] = m.type; } return super.postMessage(m, ...r); }
  };
})();`;
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
await ctx.addInitScript(SHIM);
await ctx.addInitScript(WORKER_COUNT);
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
await page.goto(new URL("index.html", BASE).href, { waitUntil: "load" });
await page.waitForFunction(() => document.querySelector("#busy").hidden && !document.querySelector("#btnPlan").disabled, null, { timeout: 120000 });
await wait(1000);
await page.click("#btnPlan");
await page.waitForFunction(() => document.querySelectorAll("#cards .card").length >= 3 && document.querySelector("#busy").hidden, null, { timeout: 180000 });
await wait(1500);
// the campaign's EVA: Amalik, then Issole
await page.evaluate(() => {
  const row = [...document.querySelectorAll("#targets .cand")].find((r) => /Issole/.test(r.textContent));
  row?.querySelector("button")?.click();
});
await wait(800);
await page.click("#btnPlan");
await page.waitForFunction(() => document.querySelectorAll("#cards .card").length >= 3 && document.querySelector("#busy").hidden, null, { timeout: 180000 });
await wait(1500);
await page.click("#tabExec");
await wait(600);
await page.selectOption("#truthSel", "hardwork");
await page.evaluate((v) => {
  const s = document.querySelector("#simSpeed");
  if (![...s.options].some((o) => o.value === v)) s.add(new Option(`${v}x`, v));
  s.value = v;
}, SPEED);
await page.evaluate(() => { const c = document.querySelector("#chkReplan"); if (c && !c.checked) c.click(); });
await wait(500);

// (polled from here: the page's own animation frames and timers are stopped between steps)
async function idle() {
  for (let t = 0; t < 600; t++) {
    if (await page.evaluate(() => window.__wk.open.size === 0)) return;
    await wait(50);
  }
  console.log("  engine slow:", await page.evaluate(() => [...window.__wk.open].map((k) => window.__wk.types[k]).join(",")));
}
// stop the clock, start the EVA (simStart is answered in real time), then one tick per frame
await page.evaluate(() => window.__vt.auto(false));
await page.click("#btnRun");
await idle();
await page.evaluate(() => window.__vt.step(1));
await idle();

const readPanel = () => page.evaluate(() => {
  const txt = document.body.innerText;
  const row = (re) => (txt.match(re) || [""])[0].replace(/\s+/g, " ");
  return { met: row(/MET\s*\n?\s*\d\d:\d\d/), work: row(/Work rate \(O₂ use\)[^\n]*\n?[^\n]*\n?[^\n]*/), plan: row(/Plan v\d/) };
});
const log = [];
let after = -1;
for (let f = 0; f < MAX; f++) {
  await page.evaluate(() => window.__vt.step(500));
  await idle();
  await page.evaluate(() => { window.__vt.step(1); window.__vt.step(1); });   // let the map and panels draw
  await idle();
  const name = `${String(f).padStart(3, "0")}.jpg`;
  await page.screenshot({ path: path.join(OUT, name), type: "jpeg", quality: 92 });
  const info = await readPanel();
  log.push({ f, ...info });
  if (f % 5 === 0 || (after < 0 && /v[2-9]/.test(info.plan))) console.log(f, info.met, "|", info.work.slice(0, 90), "|", info.plan);
  if (after < 0 && /Plan v[2-9]/.test(info.plan)) { after = f; console.log(`  re-planned at frame ${f}`); }
  const done = await page.evaluate(() => /EVA complete|POST-EVA/i.test(document.body.innerText));
  if (done || (after >= 0 && f - after >= AFTER)) break;
}
fs.writeFileSync(path.join(OUT, "log.json"), JSON.stringify({ speed: +SPEED, replan_frame: after, log, errors: errs.slice(0, 10) }, null, 1));
if (errs.length) console.log("page errors:", errs.slice(0, 5));
await browser.close();
