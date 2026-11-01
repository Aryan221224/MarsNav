// capture_science.mjs - the science beat, from the running Landing mode at twice the screen density:
//   sci_atlas.png      the science atlas around Gale crater (aqueous minerals, hydrous detections) with the candidate list
//   sci_objective.png  the Science tab: "Groundwater and the boxwork of Mount Sharp" (the challenge's own example), every
//                      site ranked for it, over the same atlas
//   sci_missions.png   the mission catalogue, past and future
//
//   node submission/video/capture_science.mjs [base-url] [out-dir]
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = (process.argv[2] || "http://127.0.0.1:8790/").replace(/\/$/, "");
const OUT = process.argv[3] || "submission/video/build/stills";
const VIEW = process.env.VIEW || "-4.6,137.4,900,0,0,best,hls2,,";
fs.mkdirSync(OUT, { recursive: true });

const b = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
const L = await ctx.newPage();
const errs = [];
L.on("pageerror", (e) => errs.push(e.message));
await L.goto(`${BASE}/landing.html#${VIEW}`);
await L.waitForTimeout(3000);
await L.waitForFunction(() => /screened/.test(document.getElementById("screenNote")?.textContent || ""), null, { timeout: 120000 });
if (await L.$eval("#layers", (e) => e.classList.contains("collapsed"))) await L.click("#layersToggle");
await L.evaluate(() => { for (const d of document.querySelectorAll("#atlasBox details")) d.open = true; });
for (const o of (process.env.LAYERS || "f_aqueous,f_hydrous").split(",")) await L.locator(`[data-ovl="${o}"]`).check().catch(() => console.log("no layer", o));
await L.waitForTimeout(14000);
await L.screenshot({ path: path.join(OUT, "sci_atlas.png") });
console.log("atlas");
// the layers panel folds away so the objective and the map share the frame
if (process.env.KEEP_LAYERS !== "1" && !(await L.$eval("#layers", (e) => e.classList.contains("collapsed")))) await L.click("#layersToggle");
await L.click('.tabs button[data-tab="sci"]');
await L.waitForTimeout(800);
await L.selectOption("#objSel", process.env.OBJ || "boxwork");
await L.click("#btnObjRank");
await L.waitForSelector("#objRank li", { timeout: 120000 });
await L.waitForTimeout(6000);
await L.screenshot({ path: path.join(OUT, "sci_objective.png") });
console.log("objective:", await L.evaluate(() => [...document.querySelectorAll("#objRank li")].slice(0, 3).map((li) => li.textContent.replace(/\s+/g, " ").slice(0, 70))));
await L.click('#sciChips [data-sci="mis"]');
await L.waitForTimeout(1500);
await L.screenshot({ path: path.join(OUT, "sci_missions.png") });
if (errs.length) console.log("page errors:", errs.slice(0, 5));
await b.close();
