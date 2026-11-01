# MarsNav demo video: how it is judged, what to show, and the cut

Written 1 November 2026 (fifth version: the whole project reassessed, with the route analysis added), from the official Judging and Awards Guide, the
Space Apps participant terms, the team's analysis of the 2025 Global Winners' demos, the 2026 challenge statement
(`docs/12_challenge_2026_update.md`) and the project as it stands (v2.1, 118 tests passing). The 2026 Project Submission Guide is published on 13 November:
re-check the demo rules against it before uploading.

## 1. How the video is judged

**Who sees it, in order**

1. **Local judges** at the team's event pick roughly one project in ten as a Global Nominee.
2. **NASA and partner-agency experts** review every Global Nominee and pick the Global Finalists.
3. **An executive committee** of agency leaders scores every finalist and gives the 10 Global Awards.

The demo is the one thing every judge at every stage watches. At the last stage it is watched by executives who did
not attend the event, so it has to explain itself.

**The five criteria and the question each one asks** (Judging and Awards Guide)

| Criterion | The judges' question | What the video must make obvious |
|---|---|---|
| Influence (Impact) | How much impact can it have? A big problem or a small one? Many people or few? | Every step of the first crewed Marswalks; a tool for crews, planners and site-selection teams |
| Creativity | Is it new, or an increment on something that exists? | The walk home is enforced inside the route search, the plan adapts to the suit's telemetry, and one tool runs from landing site to helmet visor |
| Validity | Is it scientifically valid? Will it work in the real world? | Checked against Perseverance's own records, including a negative result; 40 paired runs |
| Relevance | Does it answer its challenge? Complete, feasible, usable? | Every ask of the 2026 statement: map on NASA data, HUD on the visor, several kinds of data, the Mount Sharp boxwork example, safety first |
| Presentation | Did the team tell the challenge, the solution and why it matters? | One message, real product, readable text, numbers with units |

The guide asks teams to give Presentation the same attention as the other four.

**Rules for the demo**

- A video of 30 seconds or less, or up to 7 slides. A longer demo is ineligible for Global Judging.
- Hosted on a public link (YouTube or Drive).
- English, or English subtitles.
- Strong visuals and readable text.
- Show which agency datasets were used.
- The team must have produced or edited the video.
- The AI use must be described.
- No names, voices or likenesses of anyone under 18.

## 2. The awards, and which ones MarsNav can win

Each award is given by the executive committee from the Global Finalists, so one video has to carry the evidence for
every award MarsNav can win. The seconds column is how much of the cut (section 5) argues for each.

| Award | Definition | MarsNav's case | Target | Seconds of evidence |
|---|---|---|---|---|
| **Best Mission Concept** | The most plausible concept and design | End to end for a crew: choose the site and the science, check the ground, plan the EVA, fly it on the suit's telemetry, re-plan, turn home on a fault, offline, on NASA's own rules (walkback, NASA-STD-3001, SUITS) | **Primary** | 15.3 |
| **Best Use of Science** | The best and most valid use of science or the scientific method | Physical models behind every route (slope, slip, radio line of sight with Mars curvature, walk-home time); science goals that rank sites; a hidden-truth experiment; validated on Perseverance's records with a negative result; a paired statistical test | **Second** | 17.2 |
| **Best Use of Data** | Makes space data accessible, or uses it in a unique application | 1 m HiRISE terrain read at boot scale into seven route layers; 8 kinds of data from 7 NASA missions plus ESA; Perseverance's traverse as ground truth | **Third** | 12.9 |
| **Best Use of Technology** | The most innovative use of technology | A closed loop that learns the crew's real rates from SUITS telemetry and re-plans; one plan on four displays; exact station selection; offline | **Fourth** (shown, not only claimed) | 11.4 |
| Most Inspirational | Captures the judges' hearts | The first humans on Mars, a crew member alone on the plain | Supported by the opening | 10.3 |
| Galactic Impact | Most potential to improve life on Earth or in the universe | Crew safety beyond Earth | Weak fit | – |
| Storytelling, Global Connection, Art and Technology, Local Impact | Story, connecting people, art with code, local impact | Not MarsNav's strengths | None | – |

## 3. What the 2025 winners did, and what that means for this cut

| Pattern in every winning demo | In this cut |
|---|---|
| The full 29 to 30 seconds, 75 to 85 spoken words | 29.5 s, 84 words |
| Hook in the first 4 s, product named by about 7 s | A shocking number at 0.5 s; MARSNAV full screen at 5.2 s |
| The working product fills the middle half | 0:07 to 0:20 is the app: route analysis, science and data, the closed loop, the four crew displays |
| One proof, with a number | Two: 85 sols vs 84 minutes, and 0 of 40 vs 31 of 40 |
| NASA data named out loud | "NASA's HiRISE terrain", "seven NASA missions", the instrument names on screen |
| A human element | A crew member on Mars; the team member's voice |
| Subtitles always on | Large headlines carry the story; subtitles of the narration in the narrated cut |
| AI disclosed | The end card says the illustrations are illustrations; `docs/AI_USE.md` covers the rest |

## 4. Every feature, reassessed and weighted

**Method.** Each feature was scored 0 to 3 on the five things judges reward: the four criteria (influence, creativity,
validity, relevance to the 2026 statement) and Presentation, which here means how well it reads on screen in one or
two seconds. The guide weighs the five equally, so the score is their sum (out of 15). The score and the number of
awards a feature argues for set its priority and its screen time.

**What the reassessment changed.** The third cut showed the closed loop only as its last resort (the suit leak) and
gave science goals one second. Both were under-weighted:

- The **closed loop learning and re-planning** is the most original thing MarsNav does and the only evidence for Best
  Use of Technology. It now has its own beat, filmed from the running app: the hidden crew works 35 % harder, the panel
  learns ×1.35 from telemetry alone, and the planner re-plans before the reserve is touched.
- **Science goals** are the statement's second ask ("pick science goals and a location", with the Mount Sharp boxwork
  as its example), and they serve Best Use of Science. They now have their own beat: one of the seven goals (the
  boxwork), the atlas it draws on, the eight kinds of data, and the boxwork site built as an EVA site.

- The **route analysis** is what the planner does before it draws a single route: seven layers computed from the
  terrain (safety hazard with the no-go zones of the 8 hard limits, slope at walking scale, sand and wheel slip, radio
  shadow where the crew would have no telemetry link, walk-home time, consumables range). The third and fourth cuts
  showed only the hazard layer. It now has its own beat, the layers one after another with a checklist, ending on the
  five routes.

**The table.**

| # | Feature | Infl. | Creat. | Valid. | Relev. | Pres. | Score | Awards it serves | Priority | Screen time (v4) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Walk-home guarantee inside the route search (walkback field) | 3 | 3 | 3 | 3 | 3 | **15** | Mission Concept, Science | **P1** | Title (2.0 s); a layer of the analysis beat |
| 2 | Closed loop: learns the crew's real rates from SUITS telemetry, re-plans, turns home on a fault | 3 | 3 | 3 | 3 | 2 | **14** | Technology, Mission Concept, Science | **P1** | Own beat (2.9 s), leak (1.3 s), benchmark (3.2 s) |
| 3 | Validation: Perseverance's own records, a negative result, 40 paired runs | 2 | 2 | 3 | 2 | 3 | **12** | Science, Data | **P1** | Rover proof (4.2 s), benchmark (3.2 s) |
| 4 | Crew displays: helmet-visor HUD, rover dashboard, wrist cuff, habitat console, one plan | 3 | 3 | 1 | 3 | 3 | **13** | Mission Concept, Technology, Inspirational | **P1** | Opening (5.0 s), four displays (3.5 s) |
| 5 | Science goals: 7 objectives (MEPAG) that rank every site; the boxwork site built for EVAs | 2 | 2 | 2 | 3 | 2 | **11** | Science, Mission Concept | **P1 (raised)** | Science beat (1.4 + 0.8 s) |
| 6 | Science atlas: 26 whole-planet layers, all 8 kinds of data the statement lists, 7 NASA missions plus ESA | 2 | 2 | 2 | 3 | 2 | **11** | Data | P2 | Atlas, data grid, instrument strip (2.5 s) |
| 7 | Route analysis: hazard, no-go zones (8 hard limits), slope, sand and slip, radio shadow, walk home, consumables range; five named routes, AHP weights | 2 | 2 | 3 | 3 | 3 | **13** | Science, Data, Mission Concept | **P1 (raised)** | Analysis beat (3.6 s) |
| 8 | Landing mode: 66 candidates on NASA's 2015 criteria; the hub becomes an EVA site | 3 | 2 | 2 | 3 | 1 | **11** | Mission Concept, Data | P2 | "66 landing sites", candidate list under the atlas |
| 9 | Caution and warning per NASA-STD-3001, two-step return | 2 | 1 | 2 | 2 | 3 | **10** | Mission Concept | P2 | The leak on four displays |
| 10 | Navigation without GPS (filter with an error ellipse) | 2 | 2 | 3 | 2 | 1 | **10** | Science, Technology | P3 | The hook ("no GPS"); position error on screen |
| 11 | Walking-scale terrain from 1 m HiRISE | 1 | 2 | 3 | 2 | 1 | **9** | Data, Science | P3 | Plan headline; rover proof chip |
| 12 | Offline Local and Mars mode | 2 | 2 | 2 | 2 | 1 | **9** | Mission Concept | P3 | Chip on the four displays |
| 13 | Physiology, consumables, Mars clock, MEDA weather, RAD dose | 1 | 1 | 3 | 2 | 1 | **8** | Science | P3 | Numbers on the HUD and the panels |
| 14 | Space weather (DONKI), point-of-view rover photos | 1 | 1 | 1 | 3 | 1 | **7** | Relevance | P4 | Instrument strip; photos on the cuff |
| 15 | Mission catalogue: 31 missions, past and future | 1 | 1 | 1 | 3 | 1 | **7** | Data | P4 | In the repository and the guide |
| 16 | 3D eye-height walk, drive window | 1 | 1 | 1 | 2 | 3 | **8** | Presentation | P4 | Replaced by the opening |
| 17 | 118 tests, byte-identical rebuild, CI-built Windows app | 1 | 1 | 3 | 1 | 0 | **6** | Validity | P4 | In the repository, not the video |

**Screen time by pillar (29.5 s).**

| Pillar | Seconds | Share |
|---|---|---|
| The problem and the hook (inspiration) | 5.0 | 17 % |
| The promise: a way home on every step (name, route analysis, routes) | 5.6 | 19 % |
| Science goals and data | 3.3 | 11 % |
| The closed loop | 2.9 | 10 % |
| One plan on every display, and the fault | 3.5 | 12 % |
| Proof (Perseverance, 40 paired runs) | 7.4 | 25 % |
| End card | 1.8 | 6 % |

## 4a. The 2026 challenge statement, ask by ask

The official statement page could not be reached from the production machine. The asks below are the team's own capture
of it, made after NASA published the full statement on 28 October 2026 (`docs/12_challenge_2026_update.md`).

| The statement asks for | Where the cut shows it | At |
|---|---|---|
| A map, tool or interface a Mars astronaut could use, on NASA data | The planner and its analysis layers, Landing mode, the closed-loop panel and the crew displays | 5.0–20.3 s |
| Pick science goals and a location; the example is Curiosity's boxwork at Mount Sharp | The boxwork objective from the Science tab, then the boxwork site built as an EVA site | 10.6–12.0, 13.1–13.9 s |
| At least three kinds of data (optical, thermal, spectral, topographic, geophysical, atmospheric, radiation, chemical) | "8 kinds of data": the six-layer grid and the mineral atlas | 10.6–13.9 s |
| Data from several NASA missions, past and future | "7 NASA missions", the instrument strip | 12.0–13.9 s |
| Space weather and radiation | DONKI in the strip; the dose on the visor HUD | 0–5.0, 12.0–13.9 s |
| Safety first; a route that avoids obstacles | The analysis beat: hazard, no-go zones, slope, slip, radio shadow, walk home, range, then 5 routes; the re-plan; the leak | 7.0–10.6, 13.9–20.3 s |
| A display: habitat, tablet, helmet-visor HUD or other | Habitat workstation, rover dashboard, wrist cuff and helmet visor, all live | 0–5.0, 16.8–20.3 s |
| Point-of-view images | The cuff shows the rover's own photographs of the next stop | 16.8–20.3 s |
| What the data say about the chosen place | The objective's question, evidence and safety notes for the boxwork; the layers at Jezero | 7.0–12.0 s |
| Rovers carrying crew, or astronauts in pairs | The crew rover and its dashboard | 16.8–20.3 s |
| Inspiration from other worlds' maps | Not in the video (Apollo walking data is in the docs) | – |

## 5. The cut

**Structure:** hook, name, show (plan, science, loop, displays), prove, close.

**Message:** on Mars, MarsNav keeps a way home on every step; it finds the science, learns from the suit, and is checked
against Perseverance.

**Tagline:** Every step, a way home.

| Time | Beat | Picture (all from the running app unless marked) | Headline on screen | Narration (84 words) |
|---|---|---|---|---|
| 0.0–5.0 | Hook | A crew member and rover alone on a Mars plain (3D illustration); the camera pushes in to the gold visor, where MarsNav's HUD glows | NO GPS. / HELP CAN BE 22 MINUTES AWAY. | "On Mars there's no GPS, and help can be 22 minutes away." |
| 5.0–7.0 | Name | The walkback field: time to walk home from every point | **MARSNAV** · Every step, a way home. | "MarsNav keeps a way home on every step." |
| 7.0–10.6 | Show: route analysis | The planner's layers over the same EVA, one after another: hazard and no-go zones, slope, wheel slip, radio shadow, walk home, consumables range; then the five routes | WHAT MARSNAV CHECKS BEFORE EVERY ROUTE (a checklist that builds up) · = 5 ROUTES, SAFEST FIRST | "It maps every hazard and radio shadow, then plans safe routes." |
| 10.6–12.0 | Show: science | The science atlas (water-formed minerals around Jezero, 66 candidates) and the boxwork objective card from the Science tab | IT FINDS THE SCIENCE. 7 SCIENCE GOALS · 66 LANDING SITES | "It finds the science, with data from seven NASA missions." |
| 12.0–13.9 | Show: data, place | Six NASA data layers with their missions, then the boxwork site at Mount Sharp in 3D | 8 KINDS OF DATA · 7 NASA MISSIONS | (continues) |
| 13.9–16.8 | Show: closed loop | The Execute screen: the learned work rate climbs ×1.00 → ×1.35 against the hidden truth, then "RE-PLANNED" | IT LEARNS FROM THE SUIT. AND RE-PLANS. | "It learns from the suit, and re-plans." |
| 16.8–20.3 | Show: fly | One EVA on the habitat workstation, the rover's dashboard, the visor and the wrist cuff (3D illustration; every screen is the app); a suit leak at 19.0 s turns all four home | SUIT LEAK: EVERY DISPLAY TURNS HOME | "If a suit leaks, every display turns the crew home." |
| 20.3–24.5 | Prove | Perseverance's real 7.15 km route, then MarsNav's 2.92 km crew route | 85 SOLS → 84 MINUTES | "Perseverance took 85 sols. MarsNav plans it as an 84-minute walk." |
| 24.5–27.7 | Prove | The benchmark: the same 40 simulated EVAs with hidden surprises, flown on a fixed plan and with MarsNav; one bar per walk for the lowest oxygen, water or battery left, against the emergency-reserve line; three tiles: RETURN NOW alarms, closest call, science done without touching the reserve | 40 MARSWALKS WITH HIDDEN SURPRISES · 31 / 40 vs 0 / 40 walks ate into the emergency reserve · 31 → 0 alarms · −41% → +3% · 2.2× | "Forty surprise walks: no MarsNav crew touched their reserve." |
| 27.7–29.5 | Close | Logo, tagline, repository, the NASA data | MarsNav · Every step, a way home. | "MarsNav. Every step, a way home." |

**How the new beats were filmed.**

- **Benchmark** (`compositor.html`, `proof`): drawn from `validation/results/closed_loop.json`, the 40 paired runs of
  `validation/closed_loop_campaign.mjs`. The left side is the same EVA flown on the plan as filed, turning back only when
  the caution-and-warning system calls RETURN NOW; the right side is MarsNav's closed loop. The bars are each walk's lowest
  usable consumable on the hidden truth, sorted by the fixed plan's result and kept in the same order on both sides; seven
  MarsNav walks that were called off early (over 90 % left, no science) are capped at the top of the scale. The card
  keeps to one headline, two columns, one number each and three tiles; the cost in raw science (0.90 → 0.64) is in
  `validation/CLOSED_LOOP.md`, and the tile counts only science done without touching the reserve.

- **Route analysis** (`capture_analysis.mjs`): the planner's own layers for the default Jezero EVA, one screenshot of the
  map per layer at twice the screen density, each with the app's legend (for the radio shadow: "no radio line of sight
  to the 10 m habitat mast, Mars curvature included").

- **Closed loop** (`capture_loop.mjs`): the campaign's EVA (Amalik, then Issole), the simulator's hidden "crew working
  35 % harder" truth, automatic re-plan on, 60× real time. The page runs on the virtual clock, one simulator tick per
  frame, and each frame waits for the engine's reply, so the re-plan (about 1.4 s of computing) lands exactly where it
  happens in mission time. The learned work rate reads ×1.26 after 5 minutes, ×1.35 after 10; the re-plan comes at
  35 minutes.
- **Science** (`capture_science.mjs`): the boxwork objective card from the Science tab at twice the screen density, over
  the science atlas still from the user guide (this machine cannot reach the imagery servers, so a fresh globe would be
  black).

## 6. Two cuts

- **`MarsNav_demo_30s_music.mp4`:** music, with the story in large headlines. It is complete and submittable as it is.
- **`MarsNav_demo_30s.mp4`:** the same picture with a team member's narration and its subtitles. The 2025 winners
  all had narration, so this is the one to submit.

  Record the nine lines in `README.md` as `vo/line1` to `vo/line9`, then run:

  ```bash
  bash submission/video/build_video.sh --vo
  ```

  Use an adult voice: the terms bar minors' voices. If an AI voice is used, say so in the submission.

## 7. Before uploading

- [ ] Re-check the 2026 Project Submission Guide (13 November) for the demo length and format
- [ ] The video is 30.0 s or shorter (29.5 s)
- [ ] The YouTube link is public or unlisted and plays logged out
- [ ] Upload `marsnav_en.srt` too
- [ ] The repository is public and `main` holds this video and the latest code
- [ ] The Windows release link works
- [ ] There are no NASA or Space Apps logos (only the watermarked MarsNav logo)
- [ ] The AI-use description in the submission covers the video: AI-assisted edit, illustrations, voice if AI
- [ ] Every number on screen matches `validation/results/`

Sources:
- Space Apps 2021 Judging and Awards Guide (NASA S3 copy)
- spaceappschallenge.org: the 2026 participant terms and the 2025 awards
- The 2025 Global Winners page and NASA's announcement of 18 December 2025
- The team's own transcription of the 2025 winners' demos
