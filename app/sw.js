// sw.js - offline operation for a standalone deployment (habitat server, crew tablet). Execute mode must work with no
// network (research doc 17: 4-24 min light time, relay gaps).
// Strategy: NETWORK FIRST for everything the app loads from its own server, falling back to the cached copy only when
// the server cannot be reached. (v1 was cache-first forever, so after any update a browser kept running a stale mix of
// old and new scripts - which broke the 3D view and hid fixes.) The live planet tile stream (/tiles/) and the launcher
// API (/api/) are never cached here: the launcher keeps its own disk cache of tiles.
const VERSION = "marsnav-v10";
const SHELL = ["./", "index.html", "css/app.css", "js/main.js", "js/worker.js", "js/map.js", "js/timeline.js", "js/speech.js",
  "js/view3d.js", "js/landing.js", "landing.html", "css/landing.css", "planet.html", "drive.html", "css/drive.css", "js/drive.js", "js/desktop.js", "hud.html", "css/hud.css", "js/hud.js", "css/theme.css", "vendor/fonts/Barlow-Regular.woff", "vendor/fonts/Barlow-Medium.woff", "vendor/fonts/Barlow-SemiBold.woff", "vendor/fonts/Barlow-Bold.woff", "vendor/fonts/Barlow-Italic.woff", "vendor/fonts/BarlowCondensed-Medium.woff", "vendor/fonts/BarlowCondensed-SemiBold.woff", "vendor/fonts/BarlowCondensed-Bold.woff", "vendor/fonts/IBMPlexMono-Regular.woff", "vendor/fonts/IBMPlexMono-Medium.woff", "logo-96.png", "favicon-64.png", "vendor/three.module.min.js", "manifest.webmanifest", "data/sites.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/tiles/")) return;
  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    try {
      const res = await fetch(e.request, { cache: "no-store" });
      if (res.ok && res.status === 200) c.put(e.request, res.clone());
      return res;
    } catch (err) {
      const hit = await c.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
