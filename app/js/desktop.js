/* MarsNav desktop integration.
 * Active only inside the MarsNav app window (MarsNav.exe, launcher/desktop.py), where window.pywebview.api exists;
 * in an ordinary browser every function falls through to the browser's own behaviour.
 *   - same-site pop-ups (the rover drive window) open as further native windows, so BroadcastChannel keeps working;
 *   - generated documents (the hub site dossier, a blob: URL) open in their own window, with Print / save as PDF;
 *   - exports (<a download> of blob:/data: URLs) get a native Save dialog;
 *   - links to other sites open in the user's web browser;
 *   - F11 toggles full screen.
 */
(function () {
  "use strict";
  if (window.__mmDesktop) return;
  window.__mmDesktop = true;

  function api() {
    const a = window.pywebview && window.pywebview.api;
    return a && typeof a.open_window === "function" ? a : null;
  }

  function toB64(buf) {
    const b = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }

  async function saveAs(href, name) {
    try {
      const buf = await (await fetch(href)).arrayBuffer();
      return await api().save_file(name || "export", toB64(buf));
    } catch (e) {
      console.error("MarsNav: export failed", e);
      return "";
    }
  }

  function stub(name) {
    return {
      closed: false, name: name, document: null, location: { href: "" }, opener: window,
      focus() {}, blur() {}, postMessage() {},
      close() { const a = api(); if (a) a.close_window(name); this.closed = true; },
    };
  }

  const origOpen = window.open;
  window.open = function (url, name, features) {
    const a = api();
    if (!a) return origOpen.apply(window, arguments);
    let u;
    try { u = new URL(url || "about:blank", location.href); } catch (e) { return origOpen.apply(window, arguments); }
    const key = String(name || u.href);
    if (u.protocol === "blob:") {
      fetch(u.href).then((r) => r.text()).then((html) => {
        const t = ((html.match(/<title>([^<]*)<\/title>/i) || [])[1] || "MarsNav document").replace(/&middot;|·/g, "-").trim();
        a.open_document(html, t, t.replace(/[^\w-]+/g, "_").replace(/_+/g, "_").slice(0, 80) + ".html");
      });
      return stub(key);
    }
    if (u.origin === location.origin) {
      a.open_window(u.href, String(name || ""), String(features || ""));
      return stub(key);
    }
    if (/^https?:$/.test(u.protocol)) {
      a.open_external(u.href);
      return stub(key);
    }
    return origOpen.apply(window, arguments);
  };

  // exports made with a detached <a download> and .click() (no click event reaches the document)
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (api() && this.hasAttribute("download") && /^(blob|data):/.test(this.href)) {
      saveAs(this.href, this.getAttribute("download"));
      return;
    }
    return origClick.call(this);
  };

  document.addEventListener("click", function (e) {
    if (!api() || e.defaultPrevented) return;
    const el = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!el) return;
    if (el.hasAttribute("download") && /^(blob|data):/.test(el.href)) {
      e.preventDefault();
      saveAs(el.href, el.getAttribute("download"));
    } else if (el.target === "_blank") {
      e.preventDefault();
      window.open(el.href, "_blank");
    }
  }, true);

  document.addEventListener("keydown", function (e) {
    if (e.key === "F11" && api()) {
      e.preventDefault();
      api().toggle_fullscreen();
    }
  });

  window.addEventListener("pywebviewready", function () {
    document.documentElement.classList.add("mm-desktop");
  });
})();
