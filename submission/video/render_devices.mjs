// render_devices.mjs - renders the "one EVA on every display" 3D shot (devices.html) frame by frame from the frames
// captured by capture_eva.mjs. Serve the repository root first (python3 -m http.server 8800 --directory .).
//
//   node submission/video/render_devices.mjs [base-url] [from-frame] [count] [out-dir] [only-frame]
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.argv[2] || "http://127.0.0.1:8800/";
const FROM = +(process.argv[3] ?? 150), COUNT = +(process.argv[4] ?? 135);
const OUT = process.argv[5] || "submission/video/build/devices";
const ONLY = process.argv[6] != null ? +process.argv[6] : null;
fs.mkdirSync(OUT, { recursive: true });
const cap = JSON.parse(fs.readFileSync("submission/video/build/eva/capture.json", "utf8"));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
await page.goto(new URL("submission/video/devices.html", BASE).href, { waitUntil: "load" });
await page.waitForFunction(() => window.ready === true, null, { timeout: 60000 });
await page.evaluate((cfg) => window.setup(cfg), {
  from: FROM, count: COUNT, fps: cap.fps, leakFrame: cap.leakFrame,
  every: { planner: cap.planner_every, rover: cap.displays.rover.every, cuff: cap.displays.cuff.every, visor: cap.displays.visor.every },
});
const t0 = Date.now();
for (let k = 0; k < COUNT; k++) {
  if (ONLY != null && k !== ONLY) continue;
  await page.evaluate((k) => window.renderFrame(k), k);
  await page.screenshot({ path: path.join(OUT, `${String(k).padStart(4, "0")}.jpg`), type: "jpeg", quality: 94 });
  if (k % 30 === 0) console.log(`device frame ${k}/${COUNT}  ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
if (errs.length) console.log("errors:", errs.slice(0, 6));
await browser.close();
