# MarsNav demo video: how it is judged, what to show, and the cut

Written 1 November 2026, from the official Judging and Awards Guide, the Space Apps participant terms, the team's
analysis of the 2025 Global Winners' demos, the 2026 challenge statement (`docs/12_challenge_2026_update.md`) and
the project as it stands (v2.1, 118 tests passing). The 2026 Project Submission Guide is published on 13 November:
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

| Award | Definition | MarsNav's case | Target |
|---|---|---|---|
| **Best Mission Concept** | The most plausible concept and design | End to end for a crew: choose the landing site, plan the EVA, fly it on the suit's telemetry, turn home on a fault, all offline and on NASA's own rules (walkback, NASA-STD-3001, SUITS) | **Primary** |
| **Best Use of Science** | The best and most valid use of science or the scientific method | Validated on Perseverance's records, a negative result reported, a paired statistical test | **Second** |
| **Best Use of Data** | Makes space data accessible, or uses it in a unique application | 1 m HiRISE terrain read at boot scale, a whole-Mars atlas from seven NASA missions plus ESA, Perseverance's traverse | **Third** |
| Best Use of Technology | The most innovative use of technology | Closed loop with SUITS telemetry, crew HUD, exact station selection, offline | Stretch |
| Most Inspirational | Captures the judges' hearts | The first humans on Mars, a crew member alone on the plain | Supported by the opening |
| Galactic Impact | Most potential to improve life on Earth or in the universe | Crew safety beyond Earth | Weak fit |
| Storytelling, Global Connection, Art and Technology, Local Impact | Story, connecting people, art with code, local impact | Not MarsNav's strengths | None |

## 3. What the 2025 winners did, and what that means for this cut

| Pattern in every winning demo | In this cut |
|---|---|
| The full 29 to 30 seconds, 75 to 85 spoken words | 29.5 s, 79 words |
| Hook in the first 4 s, product named by about 7 s | A shocking number at 0.5 s; MARSNAV full screen at 5.2 s |
| The working product fills the middle half | 0:07 to 0:19 is the app: plan, landing and data, the four crew displays |
| One proof, with a number | Two: 85 sols vs 84 minutes, and 0 of 40 vs 31 of 40 |
| NASA data named out loud | "NASA's HiRISE terrain", "seven NASA missions", the instrument names on screen |
| A human element | A crew member on Mars; the team member's voice |
| Subtitles always on | Large headlines carry the story; subtitles of the narration in the narrated cut |
| AI disclosed | The end card says the illustrations are illustrations; `docs/AI_USE.md` covers the rest |

## 4. Every feature, weighted

Each feature was scored 0 to 3 against what judges reward:

- the four judging criteria (influence, creativity, validity, relevance to the 2026 statement);
- how well it reads on screen in a second or two.

The scores set the screen time.

| Feature | Infl. | Creat. | Valid. | Relev. | Visual | Awards it serves | Priority | Where it is in the cut |
|---|---|---|---|---|---|---|---|---|
| Walk-home guarantee inside the route search (walkback field) | 3 | 3 | 3 | 3 | 3 | Mission Concept, Science | **P1** | The message; title over the walkback field |
| Closed loop: reads SUITS telemetry, learns the crew's real rates, re-plans, turns home on a fault | 3 | 3 | 3 | 3 | 2 | Mission Concept, Technology | **P1** | The suit leak on four displays; 0 / 40 |
| Validation against Perseverance; same trip as the rover | 2 | 2 | 3 | 2 | 3 | Science, Data | **P1** | 85 sols vs 84 minutes |
| Crew displays: helmet-visor HUD, rover dashboard, wrist cuff, habitat console | 3 | 3 | 1 | 3 | 3 | Mission Concept, Technology | **P1** | Opening; the four-display shot |
| Hard limits first, five named routes, AHP weights | 2 | 2 | 3 | 3 | 2 | Science, Mission Concept | P2 | Plan shot |
| Landing mode: 66 candidates on NASA's criteria, hub becomes an EVA site | 3 | 2 | 2 | 3 | 2 | Mission Concept, Data | P2 | Landing shot |
| Whole-Mars science atlas: 8 kinds of data, objectives, missions | 2 | 2 | 2 | 3 | 2 | Data | P2 | Six-layer grid, instrument strip |
| Mount Sharp boxwork site (the statement's own example) | 1 | 1 | 2 | 3 | 2 | Relevance | P2 | Mount Sharp 3D |
| Offline Local and Mars mode | 2 | 2 | 2 | 2 | 1 | Mission Concept | P3 | Chip |
| Navigation without GPS (filter with an error ellipse) | 2 | 2 | 3 | 2 | 1 | Science, Technology | P3 | "No GPS" hook; position error on the HUD |
| Walking-scale terrain from 1 m HiRISE, bedforms, seam repair | 1 | 2 | 3 | 2 | 1 | Data, Science | P3 | "HiRISE" in the narration |
| Physiology, consumables, Mars clock, MEDA weather, RAD dose | 1 | 1 | 3 | 2 | 1 | Science | P3 | Numbers on the HUD |
| Caution and warning per NASA-STD-3001, two-step return, cue card | 2 | 1 | 2 | 2 | 2 | Mission Concept | P3 | The leak moment |
| Space weather (DONKI), point-of-view rover photos | 1 | 1 | 1 | 3 | 1 | Relevance | P4 | On the cuff and in the strip |
| 3D eye-height walk, drive window | 1 | 1 | 1 | 2 | 3 | Presentation | P4 | Replaced by the opening |
| 118 tests, byte-identical rebuild, CI-built Windows app | 1 | 1 | 3 | 1 | 0 | Validity | P4 | In the repository, not the video |

## 4a. The 2026 challenge statement, ask by ask

The official statement page could not be reached from the production machine. The asks below are the team's own capture
of it, made after NASA published the full statement on 28 October 2026 (`docs/12_challenge_2026_update.md`).

| The statement asks for | Where the cut shows it |
|---|---|
| A map, tool or interface a Mars astronaut could use, on NASA data | The planner, Landing mode and the crew displays: the whole middle |
| Pick science goals and a location; the example is Curiosity's boxwork at Mount Sharp | Mount Sharp boxwork shot, labelled as the challenge's example |
| At least three kinds of data (optical, thermal, spectral, topographic, geophysical, atmospheric, radiation, chemical) | Six-layer grid: ice, water (chemical), night-time heat, elevation, thermal inertia, geology; instrument strip |
| Data from several NASA missions, past and future | "7 NASA missions", the instrument strip |
| Space weather and radiation | DONKI in the strip; the dose readout on the visor HUD |
| Safety first; a route that avoids obstacles | "5 routes. 8 hard safety limits." over the hazard map |
| A display: habitat, tablet, helmet-visor HUD or other | Habitat workstation, rover dashboard, wrist cuff and helmet visor, all live |
| Point-of-view images | The cuff shows the rover's own photographs of the next stop |
| What the data say about the chosen place | One place, six layers |
| Rovers carrying crew, or astronauts in pairs | The crew rover and its dashboard |
| Inspiration from other worlds' maps | Not in the video (Apollo walking data is in the docs) |

## 5. The cut

**Structure:** hook, name, show, prove, close.

**Message:** on Mars, MarsNav keeps a way home on every step, and it is checked against Perseverance.

**Tagline:** Every step, a way home.

| Time | Beat | Picture | Headline on screen | Narration (79 words) |
|---|---|---|---|---|
| 0.0–5.2 | Hook | A crew member and rover alone on a Mars plain; the camera pushes in to the gold visor, where MarsNav's HUD glows | NO GPS. / HELP CAN BE 22 MINUTES AWAY. | "On Mars there's no GPS, and help can be 22 minutes away." |
| 5.2–7.4 | Name | The walkback field: time to walk home from every point | **MARSNAV** · Every step, a way home. | "MarsNav keeps a way home on every step." |
| 7.4–11.1 | Show: plan | The planner on HiRISE terrain: hazards, then five named routes | 5 ROUTES. 8 HARD SAFETY LIMITS. | "It plans each walk on NASA's HiRISE terrain, safety first." |
| 11.1–14.7 | Show: land and data | 66 candidate sites, six NASA data layers at one place, Curiosity's boxwork at Mount Sharp | 66 LANDING SITES. 7 NASA MISSIONS. | "It scores landing sites with data from seven NASA missions." |
| 14.7–18.9 | Show: fly | One EVA on the habitat workstation, the rover's dashboard, the visor and the wrist cuff; a suit leak turns all four home | SUIT LEAK: EVERY DISPLAY TURNS HOME. | "If a suit leaks, every display turns the crew home." |
| 18.9–24.8 | Prove | Perseverance's real 7.15 km route, then MarsNav's 2.92 km crew route | 85 SOLS → 84 MINUTES | "Perseverance took 85 sols for this trip. MarsNav plans it as an 84-minute walk." |
| 24.8–27.5 | Prove | One dot per paired simulated EVA | 0 / 40 vs 31 / 40 | "Forty simulated walks: no crew touched their reserve." |
| 27.5–29.5 | Close | Logo, tagline, repository | MarsNav · Every step, a way home. | "MarsNav. Every step, a way home." |

## 6. Two cuts

- **`MarsNav_demo_30s_music.mp4`:** music, with the story in large headlines. It is complete and submittable as it is.
- **`MarsNav_demo_30s.mp4`:** the same picture with a team member's narration and its subtitles. The 2025 winners
  all had narration, so this is the one to submit.

  Record the eight lines in `README.md` as `vo/line1` to `vo/line8`, then run:

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
