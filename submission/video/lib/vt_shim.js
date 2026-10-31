// vt_shim.js - a virtual clock for frame-accurate capture of the running app (installed with page.addInitScript).
//
// The app animates with requestAnimationFrame, timers and performance.now / Date.now. Software WebGL in a headless
// browser cannot render the 3D views at 30 frames a second in real time, so capture.mjs stops the clock, advances it by
// exactly one frame (1000/30 ms), lets the page render, and takes a screenshot. Every timer, animation frame and clock
// read in the page then sees perfectly even 30 fps time, however long each frame took to render.
//
//   __vt.auto(true)   the clock follows real time (loading, planning, setting up)
//   __vt.auto(false)  the clock only moves when __vt.step(ms) is called
//
// Web Workers keep real time: the planning engine runs there and the planner waits for its replies as usual.
// BroadcastChannel traffic is stamped so capture.mjs can wait until a snapshot posted by the planner has reached
// every crew display before it takes the next frame.
(() => {
  if (window.__vt) return;
  const real = {
    setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
    raf: window.requestAnimationFrame.bind(window), perfNow: performance.now.bind(performance), dateNow: Date.now.bind(Date),
  };
  const epoch = real.dateNow() - real.perfNow();      // Date.now() = epoch + virtual performance.now()
  let now = real.perfNow();
  let auto = true;
  let lastReal = real.perfNow();
  let rafQ = new Map();
  let rafId = 0;
  const timers = new Map();
  let tid = 1;

  function runTimersUntil(target) {
    for (let guard = 0; guard < 100000; guard++) {
      let best = null;
      for (const [id, t] of timers) {
        if (t.at <= target && (!best || t.at < best.t.at || (t.at === best.t.at && id < best.id))) best = { id, t };
      }
      if (!best) break;
      now = Math.max(now, best.t.at);
      if (best.t.every) best.t.at += best.t.every; else timers.delete(best.id);
      try { if (typeof best.t.fn === "function") best.t.fn(...best.t.args); } catch (e) { console.error(e); }
    }
    now = Math.max(now, target);
  }
  function flushRaf() {
    const q = rafQ;
    rafQ = new Map();
    for (const fn of q.values()) { try { fn(now); } catch (e) { console.error(e); } }
  }
  function advance(ms) { runTimersUntil(now + ms); flushRaf(); }

  // auto mode: virtual time follows real time, driven by both real rAF and a real timer (a page in the background
  // gets no animation frames)
  function pump() {
    const r = real.perfNow();
    if (auto) advance(Math.min(Math.max(0, r - lastReal), 250));
    lastReal = r;
  }
  (function rafPump() { pump(); real.raf(rafPump); })();
  (function timerPump() { pump(); real.setTimeout(timerPump, 16); })();

  performance.now = () => now;
  Date.now = () => Math.round(epoch + now);
  window.requestAnimationFrame = (fn) => { const id = ++rafId; rafQ.set(id, fn); return id; };
  window.cancelAnimationFrame = (id) => { rafQ.delete(id); };
  window.setTimeout = (fn, ms = 0, ...args) => { const id = tid++; timers.set(id, { at: now + Math.max(0, +ms || 0), fn, args }); return id; };
  window.setInterval = (fn, ms = 0, ...args) => {
    const id = tid++;
    const every = Math.max(1, +ms || 0);
    timers.set(id, { at: now + every, every, fn, args });
    return id;
  };
  window.clearTimeout = (id) => { timers.delete(id); };
  window.clearInterval = (id) => { timers.delete(id); };

  // stamp the crew-display channel: every snapshot the planner posts carries a sequence number (__seq, ignored by the
  // app), the planner records the last one it posted and every display the last one it received. A fault injected
  // between ticks re-sends a snapshot with the same mission time, so time alone cannot tell two snapshots apart.
  window.__bc = { posted: 0, received: 0 };
  const BC = window.BroadcastChannel;
  if (BC) {
    const post = BC.prototype.postMessage;
    BC.prototype.postMessage = function (m) {
      if (m && m.type === "snap" && m.snap) { window.__bc.posted++; m = { ...m, __seq: window.__bc.posted }; }
      return post.call(this, m);
    };
    window.BroadcastChannel = function (name) {
      const ch = new BC(name);
      ch.addEventListener("message", (ev) => {
        const m = ev.data;
        if (m && m.type === "snap" && m.__seq) window.__bc.received = Math.max(window.__bc.received, m.__seq);
      });
      return ch;
    };
    window.BroadcastChannel.prototype = BC.prototype;
  }

  window.__vt = {
    now: () => now,
    step: (ms) => { advance(ms); return now; },
    auto: (on) => { auto = !!on; lastReal = real.perfNow(); return auto; },
    pending: () => timers.size,
  };
})();
