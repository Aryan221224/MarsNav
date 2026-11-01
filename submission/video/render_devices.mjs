// render_devices.mjs - renders the "one EVA on every display" 3D shot (devices.html) frame by frame from the frames
// captured by capture_eva.mjs. Shot length, cuts and the captured frame it starts from are in timeline.json.
// Serve the repository root first (python3 -m http.server 8800 --directory .).
//
//   node submission/video/render_devices.mjs [base-url] [out-dir]             every frame of the shot
//   node submission/video/render_devices.mjs [base-url] [out-dir] 15 45 75    only these frames (checks)
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.argv[2] || "http://127.0.0.1:8800/";
const OUT = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : "submission/video/build/devices";
// --intro renders the opening shot instead (its length is the first shot in timeline.json)
const INTRO = process.argv.includes("--intro");
const ONLY = process.argv.slice(4).filter((a) => a !== "--intro").map(Number);
fs.mkdirSync(OUT, { recursive: true });
const TL = JSON.parse(fs.readFileSync("submission/video/timeline.json", "utf8"));
const shot = TL.shots.find((s) => s.id === (INTRO ? "intro" : "devices"));
const cap = JSON.parse(fs.readFileSync("submission/video/build/eva/capture.json", "utf8"));
const COUNT = Math.round((shot.end - shot.start) * TL.fps);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
await page.goto(new URL("submission/video/devices.html", BASE).href, { waitUntil: "load" });
await page.waitForFunction(() => window.ready === true || window.__err, null, { timeout: 120000 });
// the shot plays device frames shot.from .. shot.from + COUNT - 1 (the compositor's "from"); the device frame k shows
// captured frame capture_from + k
const K0 = INTRO ? 0 : (shot.from || 0), K1 = K0 + COUNT;
await page.evaluate((cfg) => window.setup(cfg), {
  from: shot.capture_from, start: K0, count: K1, fps: cap.fps, leakFrame: cap.leakFrame, cuts: shot.cuts,
  every: { planner: cap.planner_every, rover: cap.displays.rover.every, cuff: cap.displays.cuff.every, visorPlain: cap.displays.visor_plain.every },
});
const t0 = Date.now();
for (let k = K0; k < K1; k++) {
  if (ONLY.length && !ONLY.includes(k)) continue;
  if (!ONLY.length && process.env.RESUME && fs.existsSync(path.join(OUT, `${String(k).padStart(4, "0")}.jpg`))) continue;
  await page.evaluate(([k, intro]) => (intro ? window.renderIntro(k) : window.renderFrame(k)), [k, INTRO]);
  await page.screenshot({ path: path.join(OUT, `${String(k).padStart(4, "0")}.jpg`), type: "jpeg", quality: 94 });
  if (k % 15 === 0) console.log(`device frame ${k}/${K1}  ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
if (errs.length) console.log("errors:", errs.slice(0, 6));
await browser.close();
