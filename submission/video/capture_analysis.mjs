// capture_analysis.mjs - every analysis layer the planner computes for a route, as stills of the map at twice the
// screen density: the same Jezero EVA (habitat to the delta front), one layer at a time, with the no-go hatching
// (the 8 hard limits) that is always drawn on top.
//
//   node submission/video/capture_analysis.mjs [base-url] [out-dir]
// Writes ana_<layer>.png for hazard, slope, sand, slip, shade, los, walkback, range, sigma and none (the routes alone).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.argv[2] || "http://127.0.0.1:8790/";
const OUT = process.argv[3] || "submission/video/build/stills";
const LAYERS = (process.env.LAYERS || "hazard,slope,sand,slip,shade,los,walkback,range,sigma,none").split(",");
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));
await p.goto(new URL("index.html", BASE).href, { waitUntil: "load" });
await p.waitForFunction(() => document.querySelector("#busy").hidden && !document.querySelector("#btnPlan")?.disabled, null, { timeout: 120000 });
await wait(1500);
await p.click("#btnPlan");
await p.waitForFunction(() => document.querySelectorAll("#cards .card").length >= 3 && document.querySelector("#busy").hidden, null, { timeout: 180000 });
await wait(2500);
// the map's hover read-out ("Move over the map ...") is hidden: it says nothing on a still
await p.evaluate(() => { for (const el of document.querySelectorAll(".hint, #hoverInfo, .maphint, #readout")) el.style.visibility = "hidden"; });
for (const v of LAYERS) {
  await p.evaluate((v) => document.querySelector(`input[name=ov][value=${v}]`)?.click(), v);
  await p.waitForFunction(() => document.querySelector("#busy").hidden, null, { timeout: 60000 });
  await wait(1800);
  await (await p.$("#map")).screenshot({ path: path.join(OUT, `ana_${v}.png`) });
  const legend = await p.evaluate(() => { const l = document.querySelector("#legend"); return l && !l.hidden ? l.innerText.replace(/\s+/g, " ").slice(0, 110) : ""; });
  console.log(v, "|", legend);
}
if (errs.length) console.log("page errors:", errs.slice(0, 5));
await browser.close();
