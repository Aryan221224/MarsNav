// check_web_demo.cjs - opens the web demo in a headless browser the way GitHub Pages serves it and checks it works:
// the planner plans routes on the real terrain, the visor HUD and the drive window load without page errors, and Landing
// mode shows the web-demo message (not "start MarsNav.exe").
//
//   node tools/check_web_demo.cjs                        # serves app/ itself under https://<github.io>/MarsNav/ (emulated)
//   node tools/check_web_demo.cjs https://aryan221224.github.io/MarsNav/   # checks the live site
//
// The emulated run answers every request for the Pages address from app/ on disk, so it tests the same paths, the
// same sub-folder and the same "no server behind it" situation as the live site, without the network.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "app");
const live = process.argv[2];
const BASE = (live || "https://aryan221224.github.io/MarsNav/").replace(/\/?$/, "/");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json",
  ".bin": "application/octet-stream", ".wasm": "application/wasm", ".glb": "model/gltf-binary", ".woff2": "font/woff2" };

async function emulate(ctx) {
  const origin = new URL(BASE).origin, prefix = new URL(BASE).pathname;
  await ctx.route(`${origin}/**`, (route) => {
    const u = new URL(route.request().url());
    if (!u.pathname.startsWith(prefix)) return route.fulfill({ status: 404, body: "not found" });
    let rel = decodeURIComponent(u.pathname.slice(prefix.length)) || "index.html";
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.join(APP, rel);
    if (!file.startsWith(APP) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ status: 200, body: fs.readFileSync(file), headers: { "content-type": TYPES[path.extname(file)] || "application/octet-stream" } });
  });
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, serviceWorkers: "block" });
  if (!live) await emulate(ctx);
  // anything outside the demo's own origin (NASA feeds, map tiles) is allowed to fail: the demo must not depend on it
  const own = new URL(BASE).origin;
  let failed = 0;
  const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) failed++; };

  async function open(page, name) {
    const pg = await ctx.newPage();
    const errors = [];
    pg.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    await pg.goto(BASE + page, { waitUntil: "load", timeout: 90000 });
    return { pg, errors, name };
  }

  // 1. planner: routes appear on the real Jezero terrain
  {
    const { pg, errors } = await open("index.html");
    const cards = await pg.waitForFunction(() => document.querySelectorAll("#cards .card, #cards [data-route]").length >= 3, null, { timeout: 120000 })
      .then(() => pg.$$eval("#cards .card, #cards [data-route]", (els) => els.length)).catch(() => 0);
    ok(cards >= 3, `planner planned ${cards} named routes on the real terrain`);
    const sol = await pg.textContent("body");
    ok(/Jezero/.test(sol), "planner shows the Jezero site");
    ok(errors.length === 0, `planner: no page errors${errors.length ? " (" + errors[0] + ")" : ""}`);
    await pg.screenshot({ path: path.join(process.env.SHOT_DIR || ".", "web_demo_planner.png") }).catch(() => {});
    await pg.close();
  }
  // 2. visor HUD and 3. drive window load
  for (const page of ["hud.html", "drive.html"]) {
    const { pg, errors } = await open(page);
    await pg.waitForTimeout(4000);
    ok(errors.length === 0, `${page}: loads with no page errors${errors.length ? " (" + errors[0] + ")" : ""}`);
    await pg.close();
  }
  // 4. Landing mode: the web-demo message, with working links back to the planner
  {
    const { pg, errors } = await open("landing.html");
    await pg.waitForSelector("#offline:not([hidden])", { timeout: 30000 }).catch(() => {});
    const hostedShown = await pg.isVisible("#offlineHosted").catch(() => false);
    const localShown = await pg.isVisible("#offlineLocal").catch(() => false);
    ok(hostedShown && !localShown, "Landing mode shows the web-demo message, not 'start MarsNav.exe'");
    ok((await pg.textContent("#netPill")).trim() === "WEB DEMO", "status pill reads WEB DEMO");
    const href = await pg.getAttribute("#offlineHosted a[href='index.html']", "href").catch(() => null);
    ok(href === "index.html", "Landing mode links to the EVA planner");
    ok(errors.length === 0, `landing.html: no page errors${errors.length ? " (" + errors[0] + ")" : ""}`);
    await pg.screenshot({ path: path.join(process.env.SHOT_DIR || ".", "web_demo_landing.png") }).catch(() => {});
    await pg.close();
  }
  await browser.close();
  console.log(failed ? `${failed} check(s) failed (${live ? "live site" : "emulated Pages copy"} ${BASE})` : `all checks passed (${live ? "live site" : "emulated Pages copy"} ${BASE})`);
  process.exit(failed ? 1 : 0);
})();
