# The 30-second demo video

`MarsNav_demo_30s_music.mp4`: 29.5 s, 1920 × 1080, 30 fps, H.264 + AAC, English subtitles burned in and embedded
(`marsnav_en.srt` for YouTube's upload). It has music, and the story in large headlines, but no narration yet: a team member records the
nine lines below and one command mixes them in (`MarsNav_demo_30s.mp4`).

Everything on screen is the running app or the repository's own validation output. Nothing is mocked up:

| Time | Shot | Made from |
|---|---|---|
| 0.0–5.2 s | Hook: a crew member and rover alone on a Mars plain; "NO GPS. Help can be 22 minutes away."; the camera pushes in to the gold visor and MarsNav's HUD | 3D illustration (`devices.html`); the HUD symbology is `hud.html?mode=visor` with its 3D view off, captured from a simulated EVA |
| 5.2–7.2 s | Name: MARSNAV full screen over the walkback field (time to walk home from every point) | The planner's "Walkback time" layer (`capture_maps.mjs`) |
| 7.2–9.8 s | Plan: hazards, then five named routes on HiRISE terrain; "5 routes. 8 hard safety limits." | The running planner (`capture_maps.mjs`) |
| 9.8–11.3 s | Science: the science atlas (water-formed minerals around Jezero, the 66 screened candidates) and the boxwork objective from the Science tab; "It finds the science. 7 science goals · 66 landing sites" | Landing mode's atlas from the user guide; the objective card from the running app at 2× (`capture_science.mjs`) |
| 11.3–13.4 s | Data and place: six NASA data layers with their missions, then Curiosity's boxwork at Mount Sharp, built as an EVA site; the instruments named on screen | User-guide captures of Landing mode; the planner's 3D view of the built Mount Sharp site |
| 13.4–16.4 s | Closed loop: the crew secretly works 35 % harder; the learned work rate climbs ×1.00 → ×1.35 against the hidden truth, and the planner re-plans | The running planner on the virtual clock, one simulator tick per frame (`capture_loop.mjs`) |
| 16.4–20.0 s | Fly: one EVA on the habitat workstation, the rover's dashboard, the visor and the wrist cuff; at the suit leak all four turn home | The planner and crew displays captured in lockstep (`capture_eva.mjs`), on 3D models built in `devices.html` |
| 20.0–25.0 s | Proof: Perseverance's real 7.15 km, 85-sol route, then MarsNav's 2.92 km, 84-minute crew route | `validation/results/rover_case_study.json` over the app's 2 m HiRISE relief tiles |
| 25.0–27.5 s | Proof: 0 of 40 against 31 of 40, one dot per real paired run | `validation/results/closed_loop.json` |
| 27.5–29.5 s | End card: logo, tagline, repository, the NASA data it is built on | Watermarked AI-generated logo; no NASA or Space Apps logos |

## Narration

Record each line as its own file, `vo/line1.m4a` … `vo/line9.m4a` (any format ffmpeg reads). A phone in a quiet room,
about 20 cm away, is enough. Read at a calm, confident pace, and keep each take inside its slot: a take up to 12 %
too long is sped up to fit, and a longer one is cut and reported.

| Line | Slot | Words | Say |
|---|---|---|---|
| 1 | 0.20–4.55 s (4.35 s) | 12 | On Mars there's no GPS, and help can be 22 minutes away. |
| 2 | 4.70–7.10 s (2.40 s) | 8 | MarsNav keeps a way home on every step. |
| 3 | 7.30–9.70 s (2.40 s) | 6 | It plans every walk, safety first. |
| 4 | 9.90–13.30 s (3.40 s) | 10 | It finds the science, with data from seven NASA missions. |
| 5 | 13.50–16.30 s (2.80 s) | 7 | It learns from the suit, and re-plans. |
| 6 | 16.50–19.90 s (3.40 s) | 10 | If a suit leaks, every display turns the crew home. |
| 7 | 20.10–24.90 s (4.80 s) | 14 | Perseverance took 85 sols for this trip. MarsNav plans it as an 84-minute walk. |
| 8 | 25.10–27.40 s (2.30 s) | 8 | Forty simulated walks: no crew touched their reserve. |
| 9 | 27.60–29.40 s (1.80 s) | 6 | MarsNav. Every step, a way home. |

Say "Séítah" as *say-EE-tah*, "sols" as *soles*, "EVAs" as *E-V-As*. The subtitles are this exact text, so read it word
for word. To rehearse, play `MarsNav_demo_30s_music.mp4` and read each caption as it appears.

```bash
python3 submission/video/make_audio.py --vo submission/video/vo
```

```bash
python3 submission/video/assemble.py --vo
```

The first command reports each take's length against its slot; the second writes `MarsNav_demo_30s.mp4` and refuses
anything over 30 s. If an AI voice is used instead, say so in `docs/AI_USE.md`.

## Rebuilding the picture

Needs Node 20+, Playwright with Chromium, Python 3 with numpy, scipy and Pillow, and ffmpeg. The four captures need the
planet server; the rest only a static server at the repository root.

```bash
python3 launcher/martian_map.py --headless --port 8790
```

```bash
python3 -m http.server 8800 --directory .
```

```bash
node submission/video/capture_maps.mjs http://127.0.0.1:8790/ submission/video/build/stills
```

```bash
node submission/video/capture_eva.mjs http://127.0.0.1:8790/ submission/video/build/eva 9.6 6.5
```

```bash
node submission/video/capture_loop.mjs http://127.0.0.1:8790/ submission/video/build/loop
```

```bash
node submission/video/capture_science.mjs http://127.0.0.1:8790/ submission/video/build/stills
```

```bash
RESUME=1 bash submission/video/build_video.sh
```

`build_video.sh` renders the opening and the devices shot, the rover map and every frame, then the sound and the
MP4 (add `--vo` once the narration is recorded). With `RESUME=1` it keeps frames that already exist, so an
interrupted run picks up where it stopped. The 3D models (habitat workstation, crew rover, suited crew member with
its helmet and wrist cuff) are built from three.js primitives in `devices.html`; nothing is downloaded.

The app has no notion of video time, and software 3D cannot render 30 frames a second, so the captures run every page
on a virtual clock (`lib/vt_shim.js`): each frame the clock moves exactly 1/30 s, the page renders, and a screenshot is
taken. The planner, the visor, the rover dashboard and the wrist cuff are stepped together and the capture waits for
each snapshot to reach every display, so all four show the same moment. The app itself is not modified.

`timeline.json` is the single source for shot times, captions, chips and narration cues.

## Sound

`make_audio.py` synthesises the music from scratch (pads, a plucked arpeggio, low hits): no samples, no licences and
no AI. The warning at the suit leak is the app's own caution-and-warning tone (`app/js/speech.js`: square wave,
880 / 660 Hz). The mix is normalised to -14 LUFS with peaks under -1.5 dBTP.

## Honesty notes

- The opening and the devices shot are 3D illustrations; what plays on every screen and on the visor is the running
  app, flying a simulated EVA from its own simulator.
- The rover comparison is a robot driven from Earth against a planned crew walk between the same two points, on the
  same 1 m terrain; the narration says "for a crew" so it is not read as a faster rover.
- The closed-loop beat is the simulator's "crew working 35 % harder than modelled" scenario. The truth column is what
  the simulator really does; the engine sees only TSS-format telemetry and learns the rates from it. The frames are
  stepped one tick at a time, so the time between ticks is not real time, but every number is the app's own.
- The science atlas behind the objective card is the user guide's capture of Landing mode (this machine cannot reach
  the imagery servers); the objective card is captured fresh. The site ranking under the card is left out, because the
  capture machine lacks the 323 MB science layers that ranking reads.
- "Down to one metre": not every site has 1 m data (docs/08), so the line does not claim every walk is planned at 1 m.
- The 0 / 40 result is from 40 paired simulated EVAs, as the narration says.
