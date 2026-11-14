# UI Consistency Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Landing mode, the EVA planner, the crew displays and the drive window read and behave as one piece of operational software: one convention per kind of information, nothing overlapping, operations apart from simulation, the next step obvious, plain language.

**Architecture:** Edits to the existing plain-JS/CSS front end (`app/`), a display-string pass in the server (`planet/assess.py`, `planet/place.py`), and one log fix in the engine (`engine/alerts.js`). UI behaviour is pinned by a Playwright contract script run against the local server; engine behaviour by `node --test`.

**Tech Stack:** Vanilla JS modules, CSS (tokens in `app/css/theme.css`), Python 3 server, Node test runner, pytest, Playwright (pre-installed in the dev environment, not a project dependency).

**Spec:** `docs/superpowers/specs/2026-11-14-ui-consistency-pass-design.md` (items 1-24 referenced as S1-S24).

## Global Constraints

- Keep the existing look, colours, fonts and layout; colours only from `app/css/theme.css` tokens.
- No new dependencies. No change to planning, engine physics, data or the server API, except the event-log fix (S3).
- Never hide or soften safety-critical information (walk-home margin, alerts, no-go ground).
- Keep links, keyboard shortcuts, live TSS telemetry, the crew-display BroadcastChannel and the drive window working.
- No overlap or clipping at 1366x768, 1600x900, 1920x1080.
- Run the server with `python3 launcher/martian_map.py --headless --port 8792`; after editing `engine/`, run `bash tools/build_app.sh`.
- All 158 tests stay green (`node --test tests/*.test.mjs`, `python -m pytest tests -q`); both browser end-to-end runs pass with no page errors.

## Review Focus

- A latched alert that clears and comes back several times (radio line of sight flickering): every screen shows its current state, the log alternates raised / cleared.
- Telemetry source switched to Live TSS or the drive window mid-session: simulator controls disable, operations controls keep working.
- The planner at 1366x768 with the legend, readout, measure panel and scale all visible: nothing overlaps.
- Landing search typed before the place-name server answers (or with the server offline): candidates still appear, and an empty result says so.
- A dialog opened from the keyboard and closed with Escape: focus returns to the opener, no dialog stays open behind another.

---

### Task 1: The UI contract script (the failing checks first)

**Files:**
- Create: `<scratchpad>/ui_contract.cjs` (dev-only; not shipped)

**Interfaces:**
- Produces: `node ui_contract.cjs <outdir>` prints one line per check, `PASS <id>` or `FAIL <id>: <detail>`, and exits 1 on any FAIL. Check ids used by later tasks: `gauge-fill`, `rover-cleared`, `no-overlap-<w>`, `exec-strip-one-row`, `esc-closes`, `search-local-first`, `toast-lane`, `hub-form-near`, `dossier-index`, `primary-after-assess`, `guide-button`, `units-symbols`, `review-aar-first`, `sim-group-disabled-live`, `drive-start-top`.

- [ ] **Step 1: Write the checks** against the running server: gauge fill width ≈ remaining (planner Execute, simulator running 10 s); rover dashboard alert list marks cleared alerts; pairwise bounding boxes of `#readout`, `#scale`, `#legend`, `#measureBox` do not intersect at the three sizes; `#hud` cells share one row at 1600 px; Escape closes `#swxModal`, the stories list, `#help`, `#localModal`; typing "Jez" shows the Jezero candidate within 300 ms; `#toast` does not intersect `#banner`; after "Set as hub…" the form's top is within 120 px of the action buttons and `#hubName` has focus; `.dindex` exists with links; after an assessment the hub button carries the primary class; one `#btnGuide` in both apps; the dossier text contains no `deg`, `<=`, `>=`, `+-`; Review's after-action block precedes validation; with `telSrc=live` the simulator group's buttons are disabled; drive window `#btnStart` top is within the first 200 px of its panel.
- [ ] **Step 2: Run it and record the failures** — Run: `node ui_contract.cjs ui_after` — Expected: FAIL on every id above (baseline).

### Task 2: Event log records a returning condition (S3)

**Files:**
- Modify: `engine/alerts.js` (`AlertManager.update`)
- Test: `tests/engine_unit.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
test("a latched alert that clears and returns is logged each time it is raised", () => {
  const M = new AlertManager();
  const a = { id: "los", level: 1, text: "NO RADIO LINE OF SIGHT", action: "x" };
  M.update([a], 0); M.update([], 1); M.update([a], 2); M.update([], 3);
  assert.deepEqual(M.log.map((e) => e.event), ["raised", "cleared", "raised", "cleared"]);
  assert.equal(M.update([a], 4).length, 0, "no new tone while it is still unacknowledged");
});
```

- [ ] **Step 2: Run** `node --test tests/engine_unit.test.mjs` — Expected: FAIL (`["raised","cleared","cleared"]`).
- [ ] **Step 3: Implement** in `update()`: when an existing record has `cleared === true` and its id is active again, push `{ t, event: "raised", ...a }` to `this.log`, set `cleared = false`, do not add it to `raised`.
- [ ] **Step 4: Run** `node --test tests/*.test.mjs` — Expected: all pass (85). Then `bash tools/build_app.sh`.
- [ ] **Step 5: Commit** `git commit -m "Alerts: log a latched condition each time it returns"`.

### Task 3: One gauge convention and cleared alerts on the rover dashboard (S1, S2)

**Files:**
- Modify: `app/js/main.js` (gauges in the Execute snapshot renderer, ~l.1456), `app/index.html` (consumables info text), `app/css/app.css` (`.gauge .ret`)
- Modify: `app/js/hud.js` (`#rAlerts` list, ~l.271), `app/css/hud.css`

- [ ] **Step 1:** Planner gauge: fill width `100 * remaining`, tick at `100 * max(0, remaining - margin)`, colour rule unchanged; header info reads "bar = left, tick = needed to walk home".
- [ ] **Step 2:** Rover list: a cleared alert renders dimmed with "CLEARED · acknowledge to remove" (same wording as the planner).
- [ ] **Step 3: Verify** `node ui_contract.cjs ui_after` — Expected: PASS `gauge-fill`, `rover-cleared`.
- [ ] **Step 4: Commit** `git commit -m "Gauges fill with what is left everywhere; cleared alerts marked on the rover dashboard"`.

### Task 4: One status-marker style in both apps (S4)

**Files:**
- Modify: `app/css/theme.css` (new shared classes), `app/landing.html` + `app/js/landing.js` (`#netPill`, `#dsPill`, `#swxPill`, `#localPill`, `#storiesPill`), `app/css/landing.css`, `app/index.html` + `app/css/app.css` (`#dataPill`, `#cntW/C/A`)

**Interfaces:**
- Produces: CSS classes `.stat` with modifiers `.ok`, `.cau`, `.war`, `.adv`, `.off` (status markers), and `.btn.sm` for openers. JS sets only the modifier.

- [ ] **Step 1:** Define `.stat` (same height, label font, uppercase, 1 px border, token colours per modifier) in `theme.css`; replace the per-app pill styles for status elements; Local mode and the guide become `.btn.sm`.
- [ ] **Step 2: Verify** side-by-side screenshots of both top bars at 1600 px (sweep) and the existing e2e text checks on these elements still pass.
- [ ] **Step 3: Commit** `git commit -m "One status-marker style across Landing mode and the planner"`.

### Task 5: Units and symbols (S5)

**Files:**
- Modify: `planet/assess.py` (display strings only), `planet/place.py`, `app/js/landing.js` (4 strings)
- Test: `tests/test_place.py`

- [ ] **Step 1: Write the failing test** `test_dossier_text_uses_symbols`: build the HLS2 rows for a point (`assess` row builder used by `/api/assess`) and assert no row `value`/`need`/`label` contains `" deg"`, `"<="`, `">="`, `"+-"`.
- [ ] **Step 2: Run** `python -m pytest tests/test_place.py -q` — Expected: FAIL.
- [ ] **Step 3: Implement**: `°`, `≤`, `≥`, `±` in the display strings; numbers and JSON keys unchanged.
- [ ] **Step 4: Run** `python -m pytest tests -q` — Expected: all pass. Contract `units-symbols` PASS.
- [ ] **Step 5: Commit** `git commit -m "Degrees and inequality symbols in the dossier text"`.

### Task 6: Planner layout: overlays, status strip, timeline (S6, S8, S10)

**Files:**
- Modify: `app/css/app.css` (`.readout`, `.scale`, `.legend`, `.hud`), `app/js/main.js` (hud cell layout if needed), `app/js/timeline.js` (track labels)

- [ ] **Step 1:** Readout bounded to the space left of the legend, scale bar above the readout; the 7 status cells in one row at ≥1600 px, even wrap below; each timeline track gets its name and scale on separate lines with no overlap.
- [ ] **Step 2: Verify** contract `no-overlap-1366`, `no-overlap-1600`, `no-overlap-1920`, `exec-strip-one-row` PASS; sweep screenshots of Plan/Execute at the three sizes.
- [ ] **Step 3: Commit** `git commit -m "Planner map overlays, status strip and timeline labels never collide"`.

### Task 7: Execute: operations apart from the simulator (S11)

**Files:**
- Modify: `app/index.html` (Execute left panel markup), `app/js/main.js` (`telSrc` change handler), `app/css/app.css`

- [ ] **Step 1:** Two groups: "Operations" (source, crew displays, drop pin, return now, re-plan from telemetry, voice) then "Simulator and training" (run, pause, speed, hidden truth, inject a fault) in a `<details>`; when `telSrc` is `live` or `drive`, the simulator group is collapsed and its controls disabled with a one-line reason.
- [ ] **Step 2: Verify** contract `sim-group-disabled-live` PASS; planner e2e passes (it uses `#btnRun`).
- [ ] **Step 3: Commit** `git commit -m "Execute separates operations from simulator and training controls"`.

### Task 8: Review leads with the after-action summary; plain language; set-up summary (S12, S15, S16)

**Files:**
- Modify: `app/index.html` (Review right panel: `#aar` section before `#validation`, validation in `<details open=false>`), `app/js/worker.js` (hazard legend text, l.202), `app/js/main.js` (route subtitle "Team AHP weights…" l.561; set-up note l.249 as a labelled list; AHP panel wrapped as "Advanced: route priorities", CR shown as "consistent" with the number in the tooltip)

- [ ] **Step 1:** Implement the reorder and wording: legend "Safety hazard (slope, steps, rocks, sand and cliffs combined)"; balanced route "Team priorities: safety and margins first, then time"; set-up note as `<dl>` rows Habitat / Departure / Time budget / Suit cooling / Dust.
- [ ] **Step 2: Verify** contract `review-aar-first` PASS; planner e2e passes (its `seasonNote`/`setupNote` checks read `Dust optical depth`).
- [ ] **Step 3: Commit** `git commit -m "Review leads with planned versus flown; plain labels on the planner"`.

### Task 9: One Guide button in both apps (S14)

**Files:**
- Modify: `app/index.html`, `app/js/main.js` (tour), `app/js/plannerx.js` (stories modal), `app/landing.html`, `app/js/landing.js` (stories)

**Interfaces:**
- Produces: `#btnGuide` in both top bars; the planner's chooser lists "Quick tour (7 steps)" and the stories; Landing's lists the stories. Existing story/tour functions are called unchanged.

- [ ] **Step 1:** Replace `#btnTour`/`#btnStories` (planner) and `#storiesPill` (Landing) with `#btnGuide`; Landing keeps `?`.
- [ ] **Step 2:** Update the scratchpad e2e scripts' selectors (`#btnTour`, `#btnStories`, `#storiesPill` → `#btnGuide` + chooser item).
- [ ] **Step 3: Verify** contract `guide-button` PASS; both e2e runs pass.
- [ ] **Step 4: Commit** `git commit -m "One Guide button for the tour and the stories in both apps"`.

### Task 10: Landing mode, in depth (S7, S9, S13 first half, S18-S24)

**Files:**
- Modify: `app/js/landing.js` (keydown Escape ~l.608, `runSearch` ~l.1764, `toast` ~l.695, the commit-hub section in `renderDossier`, dossier section index, label/marker collision ~l.440, hub button class after assessment ~l.1134, "HUD" button label), `app/landing.html`, `app/css/landing.css` (`#toast`, `#banner` vs `#mapLoad` at ≤1400 px, narrow-width labels)

- [ ] **Step 1:** Escape closes the topmost open dialog (`#swxModal`, stories list, `#help`, `#localModal`) and returns focus to its opener.
- [ ] **Step 2:** `runSearch` renders hubs and candidates synchronously, then appends IAU names (with a "searching place names…" row until they arrive; the existing "Nothing matches" when all are empty).
- [ ] **Step 3:** Toasts in a lane below the banner (or bottom-centre above the loading bar when the banner is hidden); banner and loading bar never overlap at any width.
- [ ] **Step 4:** "Set as hub…" inserts/moves the commit form directly under the action buttons, scrolls it into view, focuses `#hubName`; after an assessment the hub button is primary (accent) and Re-assess secondary.
- [ ] **Step 5:** Dossier section index (`.dindex`): links to criteria, landing, water, environment, relay, weather, all data; each scrolls its section into view.
- [ ] **Step 6:** Place-name labels give way to candidate markers (marker boxes join the label-collision test); "HUD" reads "Crew displays"; at ≤1400 px the search placeholder reads "Search places, sites, lat lon" and the lander menu shows short names.
- [ ] **Step 7: Verify** contract `esc-closes`, `search-local-first`, `toast-lane`, `hub-form-near`, `dossier-index`, `primary-after-assess` PASS; landing e2e passes; sweep at three sizes.
- [ ] **Step 8: Commit** `git commit -m "Landing mode: dialogs, search, messages, hub form, dossier index, labels"`.

### Task 11: Drive window start at the top (S13 second half)

**Files:**
- Modify: `app/drive.html`, `app/css/drive.css`

- [ ] **Step 1:** Move `#btnStart` (and its status line) to the top of the control panel, above the hidden-truth section.
- [ ] **Step 2: Verify** contract `drive-start-top` PASS; planner e2e drive step passes.
- [ ] **Step 3: Commit** `git commit -m "Drive window: Start EVA at the top of its panel"`.

### Task 12: Documentation, full verification, release commit (S17)

**Files:**
- Modify: `tools/guide/builder/c2_landing.py`, `c3_planner.py`, `c1_front.py` (wording that names Tour/Stories, gauges, Review, Execute groups), affected figures in `tools/guide/assets/img/` (planner and display figures retaken; Landing globe figures kept), `MarsNav_User_Guide.pdf`, `README.md` and `docs/13_worldview_features.md` where button names changed, `app/sw.js` (cache version bump)

- [ ] **Step 1:** Update guide text and retake affected planner/display figures; rebuild the PDF; bump `VERSION` in `app/sw.js`.
- [ ] **Step 2: Run** `node --test tests/*.test.mjs` and `python -m pytest tests -q` — Expected: 85 + 75 pass.
- [ ] **Step 3: Run** both e2e scripts and `node ui_contract.cjs ui_after` — Expected: no page errors, every contract id PASS.
- [ ] **Step 4:** Final sweep at the three sizes; compare with the baseline captures.
- [ ] **Step 5: Commit** `git commit -m "UI consistency pass: guide, figures and verification"`.
