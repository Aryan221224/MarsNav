// capture_maps.mjs - stills of the running planner for the video, at twice the screen density so they stay sharp
// when the editor pushes in on them. Needs the app served (python launcher/martian_map.py --headless, or
// python3 -m http.server 8765 --directory app) and Playwright.
//
//   node submission/video/capture_maps.mjs [base-url] [out-dir]
//
// Writes:  jezero_plan_none.png      Jezero, the balanced route over the orthoimage and 2 m HiRISE relief
//          jezero_plan_walkback.png  the same view with the walkback field (time to walk home from every cell)
//          sharp_plan.png            the Mount Sharp boxwork site with its planned routes
//          sharp_3d.png              the same plan in the 3D view
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// Playwright is loaded through require so a global install (NODE_PATH) works as well as a local one
const { chromium } = createRequire(import.meta.url)("playwright");

const BASE = process.argv[2] || "http://127.0.0.1:8790/";
const OUT = process.argv[3] || "submission/video/build/stills";
fs.mkdirSync(OUT, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function openPlanner(ctx, hash = "") {
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(new URL(`index.html${hash}`, BASE).href, { waitUntil: "load" });
  // the terrain loads in a worker; Plan EVA is enabled once it is ready
  await p.waitForFunction(() => document.querySelector("#busy").hidden && !document.querySelector("#btnPlan")?.disabled, null, { timeout: 120000 });
  await wait(1500);
  return { p, errs };
}

async function plan(p) {
  await p.click("#btnPlan");
  await p.waitForFunction(() => document.querySelectorAll("#cards .card").length >= 3 && document.querySelector("#busy").hidden,
    null, { timeout: 180000 }).catch(() => console.log("planning did not finish in time"));
  await wait(2500);
}

async function setLayer(p, v) {
  await p.evaluate((v) => { const i = document.querySelector(`input[name=ov][value=${v}]`); if (i) i.click(); }, v);
  await wait(1200);
}

async function mapShot(p, file) {
  // keep the map clean: close the layer list and hide the hover hint
  await p.evaluate(() => {
    document.querySelector("#layersToggle")?.setAttribute("aria-expanded", "false");
    for (const el of document.querySelectorAll(".hint, #hoverInfo, .maphint")) el.style.visibility = "hidden";
  });
  await (await p.$("#map")).screenshot({ path: path.join(OUT, file) });
  console.log("wrote", file);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });

// Jezero: the default EVA (habitat to the delta front and back)
{
  const { p, errs } = await openPlanner(ctx);
  await plan(p);
  await setLayer(p, "none");
  await mapShot(p, "jezero_plan_none.png");
  await setLayer(p, "walkback");
  await mapShot(p, "jezero_plan_walkback.png");
  await setLayer(p, "hazard");
  await mapShot(p, "jezero_plan_hazard.png");
  await p.screenshot({ path: path.join(OUT, "jezero_planner_full.png") });
  if (errs.length) console.log("jezero page errors:", errs.slice(0, 5));
  await p.close();
}

// Mount Sharp boxwork (the challenge's own example)
{
  const { p, errs } = await openPlanner(ctx, "#g_4p811s_137p384e");
  await plan(p);
  await mapShot(p, "sharp_plan.png");
  await setLayer(p, "none");
  await mapShot(p, "sharp_plan_none.png");
  await p.screenshot({ path: path.join(OUT, "sharp_planner_full.png") });
  // the same plan in 3D (orbit view)
  await p.click("#btn3d").catch(() => {});
  await wait(9000);
  await p.screenshot({ path: path.join(OUT, "sharp_3d.png") });
  if (errs.length) console.log("sharp page errors:", errs.slice(0, 5));
  await p.close();
}

await browser.close();
