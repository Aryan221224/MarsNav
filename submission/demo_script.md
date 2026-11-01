# Demo script

Two versions: a 30-second video for the project page, and a 2-minute live walkthrough for judges. Check the current Space Apps submission guide for the exact demo format before recording.

## Setup (once)

1. Double-click `MarsNav.exe` (or unzip `MarsNav-Windows.zip` first on another PC). Maximise the window; 1600 × 900 or larger records best.
2. Wait for "Loading terrain" to clear in the EVA planner (about 3 s).
3. Tick "Spoken callouts" in Execute before recording if you want voice.

## 30-second video

Built and rendered from the running app: `submission/video/MarsNav_demo_30s_music.mp4` (music and burned-in
captions; add the narration with `submission/video/README.md`). Shot times, captions and narration cues live in
`submission/video/timeline.json`.

| Time | On screen | Voice-over |
|---|---|---|
| 0.0 to 4.6 s | A crew member and rover on a Mars plain; the camera pushes in to the gold visor and MarsNav's HUD | "The first crew on Mars will walk with no GPS, and limited air." |
| 4.6 to 7.6 s | The walkback field fades in over the route; MarsNav name | "MarsNav keeps a way home on every step." |
| 7.6 to 12.8 s | Landing mode (66 candidates), six NASA data layers at one place, Curiosity's boxwork at Mount Sharp in 3D | "It ranks landing sites and science targets, then plans each walk on NASA terrain down to one metre." |
| 12.8 to 17.3 s | One EVA on the habitat workstation, the rover's dashboard and the crew member's visor and wrist cuff; at a suit leak all four turn home | "From habitat to helmet, it reads the suit and re-plans." |
| 17.3 to 23.9 s | Perseverance's real 7.15 km route drawn, then MarsNav's 2.92 km crew route | "Perseverance took 85 sols to make this trip. For a crew, MarsNav plans it as an 84-minute walk." |
| 23.9 to 27.1 s | 0 of 40 against 31 of 40, one dot per paired run | "In 40 simulated EVAs, no crew touched their reserve." |
| 27.1 to 29.5 s | End card: logo, tagline, repository | "MarsNav. Every step, a way home." |

## 2-minute walkthrough

1. **Problem (15 s).** Light delay 3 to 22 minutes, EVAs of 2 to 8 hours, no GPS, and Spirit trapped in soft soil that looked firm. A Mars crew needs a map that knows where they can always get home from.
2. **Landing and real data (15 s).** Switch to **Landing** in the top bar: the whole planet, 66 candidate sites screened against NASA's 2015 human landing-site criteria; open Arcadia Planitia AP-1 and press Assess for the full dossier, then back to the **EVA planner**. Top bar: live Mars clock (sol, LMST, Ls, sun). The provenance panel lists HiRISE 1 m and CTX 20 m DTMs, MEDA weather, and the rover traverse. The site selector shows the second, CTX-only site.
3. **Plan (25 s).**
   - Layers: Safety hazard, Sand bedforms (Séítah ripples), Walkback time contours, EVA range.
   - "Suggest best sortie": the optimiser picks stations by science value inside the time, O₂ and battery budgets.
   - Plan EVA: five routes in about 3 s. Point at the fallback's small overlap with the balanced route, "why this route", guidance legs and the timeline (elevation, margin, sun).
   - Setup note: suit-cooling pressure check at 6.2 Torr against the 7.5 Torr limit.
   - Station task: set Amalik to "Heavy" with 150 Wh of tools and re-plan. The station row shows its O₂, water and battery budget; if it no longer fits, the point of no return names the suit battery.
4. **3D and limits (15 s).** Press 3D: orbit the route, then "Walk route" at eye height with the crater rim on the skyline. Add Cheyava Falls as a station and plan: the point of no return appears, with the resource that runs out.
5. **Priorities (10 s).** Drag one AHP slider. The consistency ratio updates live; re-plan and the route shifts.
6. **Execute (35 s).**
   - Set the hidden truth to "Crew working 35 % harder" and run at 600×. In Closed loop, the learned work rate climbs to x1.35 against a model of x1.00; the forecast re-plans and cuts Issole to half its time (cyan RE-PLANNED route). Point at the navigation fix and its error ellipse.
   - Optional live: `node tools/tss_bridge.mjs --demo --truth battery`, set Telemetry to "Live suit telemetry", Run. The same panel now runs on TSS-format frames over UDP.
   - Show the glance band: walk home, margin, position ±, radio.
   - At the station: the procedure checklist. Drop a pin, then ask "oxygen?" in the Ask box.
   - Inject "Suit leak": WARNING, tone, automatic return. Acknowledge, and show the CLEARED latch.
   - Show "Return now" asking for confirmation before it acts.
7. **Review and trust (15 s).** Planned vs flown, event log, cue card (the paper fallback). Validation: the hazard map agrees with JPL's choices on 21 of 30 drives, and the negative route-geometry result is stated plainly.

## Backup if the network or the app fails

- The EVA planner needs no internet. For Landing mode without internet, switch on Mars mode (Local mode panel) after the data is on the computer.
- `node --test tests/*.test.mjs` runs the safety contract and the closed-loop tests in the terminal (65 tests, about 40 s).
- `node validation/closed_loop_campaign.mjs` prints the paired closed-loop table.
- `node validation/validate.mjs` prints the validation table.
- Screenshots of each mode are in `submission/screens/`.
