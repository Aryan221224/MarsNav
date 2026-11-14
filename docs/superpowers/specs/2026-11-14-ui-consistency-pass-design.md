# UI consistency pass: MarsNav as one piece of operational software

Date: 14 November 2026. Status: proposed, for approval.

## Intent

The whole chain works: Landing mode, commit the hub, the EVA planner's Plan, Execute and Review, and the crew displays
(helmet visor, rover dashboard, wrist cuff) plus the drive window. Most of it already reads like operational software.
The owner wants it audited and refined so that everything is placed and behaves the way software actually used on the
ground would: the same thing shown the same way everywhere, nothing overlapping, operations controls separate from
simulator controls, and the next step always obvious. It is for the Space Apps submission (judges watch the demo and may
open the app) and for credibility as a real product.

## Goals

- One convention for each kind of information across every screen (gauges, alerts, status markers, units).
- No overlapping or clipped elements at 1366x768, 1600x900 and 1920x1080.
- Operations controls and simulator/training controls clearly separated.
- Each screen leads with what its user needs at that moment (Review leads with the after-action summary; after an
  assessment the next step is the highlighted one).
- Plain language on the main screens; expert detail one click away.

## Non-goals

- No new design system or restyle: the existing look, colours, fonts and layout stay.
- No new features and no change to planning, engine physics, data or the server API (one engine log fix excepted, below).
- No re-cut of the 30-second demo video in this pass.

## Anti-goals (a failure even if it technically works)

- Hiding or softening anything safety-critical (walk-home margin, alerts, no-go ground).
- Breaking links, keyboard shortcuts, live TSS telemetry, the crew-display channel, or the end-to-end tests.
- Making the app look unlike the video and user guide in ways that would confuse a judge comparing them.

## Constraints

- Plain JavaScript/CSS as now; no new dependencies.
- Tokens from `app/css/theme.css` (nominal / caution / warning / advisory colours, fonts) are the only colours used.
- The 158 automated tests and both Playwright end-to-end runs (Landing and planner) must pass afterwards.
- The globe imagery and MOLA elevation cannot be seen in the development sandbox (map servers blocked); visual checks of
  the globe itself are limited to layout.

## Approaches considered

1. **Consistency pass on the existing design (chosen).** Keep the layout and look; fix every inconsistency, collision and
   structural issue found in the audit. Low risk; the video and guide stay recognisable.
2. Restyle to a formal ground-software standard (for example the status system of the US Space Force's Astro UX design
   system). Most "real" look, but every screen changes, high regression risk, and the video and guide would no longer match.
3. Bug fixes only (gauges, alerts, overlaps). Smallest, but leaves the structural issues (mixed operations/simulator
   controls, Review order, jargon) that make it feel less like a product.

The owner handed over the how; approach 1 is the builder's recommendation.

## The design

Each item: what changes, where, and how it is checked. File paths are where the behaviour lives today.

### A. One convention everywhere

1. **Consumables gauges fill with what is left.** The planner's Execute gauges (`app/js/main.js`, `#gauges`) fill with
   the fraction used, so 93 % oxygen looks nearly empty, while the visor, rover dashboard and cuff (`app/js/hud.js`,
   `gauge2`) fill with what remains. Change the planner to the displays' rule: the bar is the remaining fraction, the tick
   is the amount needed to walk home (remaining minus margin), colour nominal / caution (margin under 20 %) / warning
   (margin below zero), the label says "tick = needed to walk home". Check: at the same instant the planner and the three
   displays show the same fill and tick.
2. **Alert lifecycle: active, acknowledged, cleared.** The planner already marks a latched alert whose condition has gone
   ("CLEARED, acknowledge to remove"); the rover dashboard lists it as if active, so it can say "line of sight" beside
   "NO RADIO LINE OF SIGHT". Render cleared alerts in the rover dashboard's list the planner's way (dimmed, "CLEARED,
   acknowledge to remove"); the visor and the cuff, which show only the top alert, keep showing active ones only (as now).
   Check: a latched, cleared alert never appears as active on any screen.
3. **Event log records every return of a condition.** `engine/alerts.js` logs "raised" only the first time; when a latched
   alert comes back after clearing it logs nothing, so the Review log shows "cleared" three times after one "raised". Log
   "raised" when a cleared, latched alert becomes active again (no new tone while it is still unacknowledged). Check: a
   unit test with a flickering condition gives alternating raised / cleared entries.
4. **One status-marker style.** Landing mode's top bar mixes four styles (red monospace "OFFLINE · local data", a yellow
   outline "SCIENCE 0/7", a filled yellow "SPACE WX", a grey "STORIES"). Give every status marker in both apps the same
   shape, font and colour meaning: nominal green, caution amber, warning red, advisory cyan, off/unknown grey. Buttons
   that open something (Local mode, guide) look like buttons, not status. The shared style goes in `app/css/theme.css`,
   which every page already loads. Check: side-by-side screenshots of both top bars.
5. **Units and symbols.** The dossier writes `deg`, `<=`, `>=`, `+-` (`planet/assess.py` display strings, a few in
   `app/js/landing.js` and `planet/place.py`). Use °, ≤, ≥, ± and a proper minus in text shown to people (JSON keys and
   numbers unchanged). Check: no ASCII stand-ins on any screen.

### B. Nothing overlaps

6. **Planner map overlays.** The hover readout (bottom left), the scale bar (bottom centre) and the legend (bottom right)
   collide at 1600 px and worse at 1366 px. Lay them out so they cannot overlap at any of the three sizes (for example the
   scale bar above the readout, the readout width bounded by the space left of the legend).
7. **Landing mode at 1366 px.** The science banner drops behind the map-loading bar. Keep them from overlapping at every
   width.
8. **Execute status strip.** Seven cells wrap and leave "Mode" alone on a second row. Fit all cells on one row at 1600 px
   and wrap evenly below that.
9. **Globe labels and markers.** Candidate markers sit on top of place-name labels ("J◆zero"). Place names give way to
   markers the way they already give way to each other.
10. **Timeline labels.** The track labels at the left of the timeline are cramped ("-2570 m" under "ELEV", "0%" over
    "SUN"). Give each track a clear label and its scale.

### C. Structure: the right things together, the next step obvious

11. **Execute: operations apart from simulation.** The left panel mixes operational controls (telemetry source, crew
    displays, drop pin, return now, re-plan from telemetry) with simulator and training controls (run, pause, speed,
    hidden truth, fault injection). Two labelled groups: "Operations" first; "Simulator and training" below. Run, pause,
    speed and fault injection apply to the built-in simulator only, so the group is collapsed and disabled when the
    source is the live suit (TSS bridge) or the drive window (which has its own controls).
12. **Review leads with the after-action summary.** Planned against flown (duration, distance, O₂, water, battery,
    outcome) moves to the top of the right column; the validation against Perseverance follows, collapsible.
13. **The next step is the highlighted button.** In the Landing dossier, once a site is assessed, "Set as hub" becomes the
    primary action and "Re-assess" secondary. In the drive window, "Start EVA" moves to the top of its panel.
14. **One guide.** The planner has Tour and Stories side by side, Landing mode has Stories. One "Guide" button in the same
    place in both apps replaces them and opens a chooser: the quick tour (planner), and the stories on real data (both).
    Landing mode's "?" (help and keyboard shortcuts) stays.
15. **Plain language first.** Main-screen jargon gets a plain label with the detail in the tooltip or an expandable part:
    the legend's "factor tree, static leaves", route cards' "Team AHP weights", the AHP panel's "CR 0.009 CONSISTENT"
    (the AHP sliders go under an "Advanced: route priorities" section).
16. **Set-up summary readable at a glance.** The planner's set-up note (a dense paragraph: habitat, departure, time
    budget, suit cooling, dust) becomes a short labelled list with the same facts.

### D. Documentation follows the screens

17. Where a change alters what the user guide shows (Execute panel groups, Review order, gauges, top bars, guide button),
    update the guide's text and retake the affected figures; rebuild `MarsNav_User_Guide.pdf`. Planner and crew-display
    figures can be retaken in the sandbox (their data are local). Landing-mode figures whose subject is the globe keep their
    current images, because the sandbox cannot load the globe imagery; only panels and the top bar are retaken there.

## Verification

- Screenshot sweep of every screen at 1366x768, 1600x900 and 1920x1080 before and after; each item above checked on
  them.
- `node --test tests/*.test.mjs` and `python -m pytest tests -q` pass; one new unit test for item 3.
- Both Playwright end-to-end runs (Landing and planner) pass with no page errors; the crew displays checked live with the
  simulator running (gauges and alerts match the planner at the same instant).

## Left to the builder

- Exact positions and spacing within the existing grid, and the wording of plain labels, as long as the meaning is kept.
- Whether the guide chooser is a menu or a small modal.
- Which guide figures need retaking, judged from what changed.
