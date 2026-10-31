# The 30-second demo video

`MarsNav_demo_30s_music.mp4`: 29.5 s, 1920 × 1080, 30 fps, H.264 + AAC, English subtitles burned in and embedded
(`marsnav_en.srt` for YouTube's upload). It has music and captions but no narration yet: a team member records the
seven lines below and one command mixes them in (`MarsNav_demo_30s.mp4`).

Everything on screen is the running app or the repository's own validation output. Nothing is mocked up:

| Time | Shot | Made from |
|---|---|---|
| 0.0–4.6 s | First-person walk through the helmet-visor HUD at Jezero | `hud.html?mode=visor` flying a simulated EVA from the planner (`capture_eva.mjs`) |
| 4.6–7.6 s | The walkback field fades in over the route | The planner's "Walkback time" layer (`capture_maps.mjs`) |
| 7.6–9.0 s | Landing mode, 66 candidates | `submission/screens/13_landing_mode.jpg` |
| 9.0–11.0 s | Six NASA data layers at one place (Arcadia Planitia) | The user guide's captures of the running Landing mode |
| 11.0–12.8 s | Curiosity's boxwork at Mount Sharp in 3D, the challenge's own example | The planner's 3D view of the built site (`capture_maps.mjs`) |
| 12.8–17.3 s | One EVA on four displays; a suit leak turns all four home | The planner, visor, rover dashboard and wrist cuff captured in lockstep, shown on device models (`devices.html`) |
| 17.3–23.9 s | Perseverance's 7.15 km, 85-sol trip against MarsNav's 2.92 km, 84-minute crew walk | `validation/results/rover_case_study.json` over the app's 2 m HiRISE relief tiles (`prep_rover_map.py`) |
| 23.9–27.1 s | 0 of 40 against 31 of 40: one dot per real paired run | `validation/results/closed_loop.json` |
| 27.1–29.5 s | End card | Watermarked AI-generated logo; no NASA or Space Apps logos |

## Narration

Record each line as its own file, `vo/line1.m4a` … `vo/line7.m4a` (any format ffmpeg reads). A phone in a quiet room,
about 20 cm away, is enough. Read at a calm, confident pace, and keep each take inside its slot: a take up to 12 %
too long is sped up to fit, and a longer one is cut and reported.

| Line | Slot | Words | Say |
|---|---|---|---|
| 1 | 0.15–4.45 s (4.3 s) | 13 | The first crew on Mars will walk with no GPS, and limited air. |
| 2 | 4.75–7.45 s (2.7 s) | 8 | MarsNav keeps a way home on every step. |
| 3 | 7.70–12.65 s (4.95 s) | 17 | It ranks landing sites and science targets, then plans each walk on NASA terrain down to one metre. |
| 4 | 12.90–17.10 s (4.2 s) | 10 | From habitat to helmet, it reads the suit and re-plans. |
| 5 | 17.45–23.75 s (6.3 s) | 19 | Perseverance took 85 sols to make this trip. For a crew, MarsNav plans it as an 84-minute walk. |
| 6 | 24.00–26.95 s (2.95 s) | 9 | In 40 simulated EVAs, no crew touched their reserve. |
| 7 | 27.30–29.40 s (2.1 s) | 6 | MarsNav. Every step, a way home. |

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

Needs Node 20+, Playwright with Chromium, Python 3 with numpy, scipy and Pillow, and ffmpeg.

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
node submission/video/render_devices.mjs http://127.0.0.1:8800/ 150 135 submission/video/build/devices
```

```bash
python3 submission/video/prep_rover_map.py . submission/video/build/rover
```

```bash
node submission/video/render_video.mjs http://127.0.0.1:8800/ submission/video/build/frames
```

```bash
python3 submission/video/make_audio.py
```

```bash
python3 submission/video/assemble.py
```

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

- The EVA in the first and fourth shots is a simulation flown by the app's simulator, and the first shot says so on
  screen.
- The rover comparison is a robot driven from Earth against a planned crew walk between the same two points, on the
  same 1 m terrain; the narration says "for a crew" so it is not read as a faster rover.
- "Down to one metre": not every site has 1 m data (docs/08), so the line does not claim every walk is planned at 1 m.
- The 0 / 40 result is from 40 paired simulated EVAs, as the narration says.
