// capture_filter.mjs - the science beat's two cards, from the running Landing mode at 2x: the science filter with one
// material ticked (the candidate list narrowed to the sites that have it nearby) and a site's research plan.
// Needs the planet server (python3 launcher/martian_map.py --headless --port 8790).
//
//   node submission/video/capture_filter.mjs http://127.0.0.1:8790/ submission/video/build/stills [material] [site]
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.argv[2] || "http://127.0.0.1:8790/";
const OUT = process.argv[3] || "submission/video/build/stills";
const MAT = process.argv[4] || "carbonates";
const SITE = process.argv[5] || "Jezero";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1500 }, deviceScaleFactor: 2 });
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));
await page.goto(new URL("landing.html", BASE).href, { waitUntil: "load" });
// keep the data-install banner and the map-loading bar out of the cards
await page.addStyleTag({ content: "#dsBanner, .banner, #mapLoad, .dindex { display: none !important; }" });
await page.waitForSelector("#matChips [data-mat]", { state: "attached", timeout: 60000 });
await page.click("#matBox summary");
await page.click(`[data-mat="${MAT}"]`);
await page.waitForTimeout(400);
// card 1: the filter and the narrowed list, as one tall strip of the left rail (the screening button and its note,
// which sit between them in the app, are hidden for the card)
await page.addStyleTag({ content: "#btnScreen, #screenNote, .matbox > p.hint { display: none !important; }" });
const rail = page.locator(".rail.left").first();
await page.evaluate(() => { const r = document.querySelector("#matBox"); r?.scrollIntoView({ block: "start" }); });
await page.waitForTimeout(200);
const rb = await rail.boundingBox();
const top = await page.locator("#matBox").boundingBox();
const last = await page.locator("#candList li").last().boundingBox();
await page.screenshot({ path: path.join(OUT, "sci_filter_card.png"), clip: { x: rb.x, y: top.y - 8, width: rb.width, height: last.y + last.height - top.y + 20 } });
const n = await page.$$eval("#candList li .t", (l) => l.length);
// card 2: the research plan of a site that has the material
await page.locator("#candList li", { hasText: SITE }).first().click();
await page.waitForTimeout(1200);
await page.click("#btnAssess");
await page.waitForSelector("details.rp[open]", { timeout: 120000 });
const rp = page.locator("details.rp[open]").first();
await rp.scrollIntoViewIfNeeded();
await rp.screenshot({ path: path.join(OUT, "sci_research_card.png") });
console.log(`science filter: ${MAT} -> ${n} sites; research plan of ${SITE} captured`);
if (errs.length) console.log("page errors:", errs.slice(0, 4));
await browser.close();
