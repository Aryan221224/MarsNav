// check_web_demo_files.mjs - the web demo (GitHub Pages) serves app/ as plain files, with no MarsNav server behind it.
// This walks every page's scripts, styles and ES-module imports (recursively) and fails if any relative reference does
// not resolve to a file inside app/. Run: node tools/check_web_demo_files.mjs
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..", "app");
const PAGES = ["index.html", "landing.html", "hud.html", "drive.html", "planet.html"];
const seen = new Set();
const missing = [];

const isRelative = (u) => u && !/^(?:[a-z]+:|\/\/|\/|#|data:|blob:)/i.test(u) && !u.includes("${");
const clean = (u) => u.split(/[?#]/)[0];

function check(from, ref) {
  if (!isRelative(ref)) return null;
  const target = join(dirname(from), clean(ref));
  if (!target.startsWith(APP)) { missing.push(`${relative(APP, from)} -> ${ref} (outside app/)`); return null; }
  if (!existsSync(target) || !statSync(target).isFile()) { missing.push(`${relative(APP, from)} -> ${ref}`); return null; }
  return target;
}

function walkModule(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const src = readFileSync(file, "utf8");
  // static imports / re-exports and dynamic import("...") with a literal path
  const re = /(?:^|[\s;])(?:import|export)\s[^'"`]*?from\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|new URL\(\s*["']([^"']+\.m?js)["']\s*,\s*import\.meta\.url\)/gm;
  for (const m of src.matchAll(re)) {
    const ref = m[1] || m[2] || m[3] || m[4];
    const t = check(file, ref);
    if (t && /\.m?js$/.test(t)) walkModule(t);
  }
}

for (const page of PAGES) {
  const file = join(APP, page);
  if (!existsSync(file)) { missing.push(`page ${page}`); continue; }
  const html = readFileSync(file, "utf8");
  for (const m of html.matchAll(/<(?:script|img)[^>]*\ssrc=["']([^"']+)["']/g)) {
    const t = check(file, m[1]);
    if (t && /\.m?js$/.test(t)) walkModule(t);
  }
  for (const m of html.matchAll(/<link[^>]*\shref=["']([^"']+)["']/g)) check(file, m[1]);
  for (const m of html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)) {
    for (const i of m[1].matchAll(/from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      const t = check(file, i[1] || i[2]);
      if (t) walkModule(t);
    }
  }
}

if (missing.length) {
  console.error(`web demo: ${missing.length} missing file(s):\n  ` + missing.join("\n  "));
  process.exit(1);
}
console.log(`web demo: ${PAGES.length} pages and ${seen.size} modules, every relative reference resolves inside app/`);
