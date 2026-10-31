// render_video.mjs - renders every frame of the demo through compositor.html and encodes the picture.
// Serve the repository root first (python3 -m http.server 8800 --directory .).
//
//   node submission/video/render_video.mjs [base-url] [out-dir]            all frames, then picture.mp4
//   node submission/video/render_video.mjs [base-url] [out-dir] 0 5.2 12.9  only frames at these times (checks)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.argv[2] || "http://127.0.0.1:8800/";
const OUT = process.argv[3] || "submission/video/build/frames";
const ONLY = process.argv.slice(4).map(Number);
const TL = JSON.parse(fs.readFileSync("submission/video/timeline.json", "utf8"));
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
await page.goto(new URL("submission/video/compositor.html", BASE).href, { waitUntil: "load" });
await page.waitForFunction(() => window.ready === true, null, { timeout: 60000 });

const N = Math.round(TL.duration * TL.fps);
const times = ONLY.length ? ONLY : Array.from({ length: N }, (_, i) => i / TL.fps);
const t0 = Date.now();
for (const [k, t] of times.entries()) {
  await page.evaluate((t) => window.renderAt(t), t);
  const name = ONLY.length ? `t${t.toFixed(2)}.jpg` : `${String(Math.round(t * TL.fps)).padStart(4, "0")}.jpg`;
  await page.screenshot({ path: path.join(OUT, name), type: "jpeg", quality: 95 });
  if (!ONLY.length && k % 60 === 0) console.log(`frame ${k}/${N}  ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
if (errs.length) console.log("errors:", errs.slice(0, 6));
await browser.close();

if (!ONLY.length) {
  // picture only: 1920x1080, 30 fps, H.264 High, yuv420p (plays everywhere, YouTube's recommended settings)
  const out = path.join(path.dirname(OUT), "picture.mp4");
  execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-framerate", String(TL.fps), "-i", path.join(OUT, "%04d.jpg"),
    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], { stdio: "inherit" });
  console.log("wrote", out);
}
