# MarsNav: the Space Apps 2026 project form, field by field

Everything to type or paste into your team's **Project** tab (spaceappschallenge.org: profile icon > My Team > Project >
Edit), in the form's own order. Turn the edit **Lock** on while you work and click **Save Progress** often.
Updated 15 November 2026: Project Details now has the browser demo link, the terrain radiation shielding feature and
its check against Curiosity RAD, 95 % intervals on the validation results, twelve map layers, the science filter and research plans, and 188 tests. If you
already pasted Project Details, paste it again.

## Project Summary

**Project Name**

```
MarsNav
```

**Summary \*** (1097 of 1500 characters, 199 words; the form suggests 50-200)

```
On Mars there is no GPS, help can be 22 light-minutes away, and a suit carries a fixed supply of oxygen, water and battery. MarsNav is crew mission software that answers the first Mars crews' questions: where do we land and live, which way do we walk, and can we always get home?

Landing mode screens 66 candidate sites against NASA's human landing-site criteria on NASA and USGS data, filters them by the minerals and ice a crew needs, and turns the chosen site into a full EVA site. The EVA planner reads 1 m HiRISE terrain the way a boot meets it, applies hard safety limits first, and plans five named routes that keep a walk home. During the EVA it reads suit telemetry in NASA's SUITS format, learns how hard the crew is working, and re-plans before the margin runs out. The same EVA appears on a habitat console, a helmet-visor display, a rover dashboard and a wrist cuff.

It is checked against Perseverance's own drives. In 40 simulated EVAs with hidden surprises, no MarsNav crew touched its emergency reserve (31 of 40 did on the fixed plan). It runs fully offline, as it must on Mars.
```

## Project Links

**Project Demonstration \***

```
https://youtu.be/n4fgprexx3E
```

**Project \***

```
https://github.com/Aryan221224/MarsNav
```

The form has only these two links. The other two are the first line of Project Details (below): the browser demo,
https://aryan221224.github.io/MarsNav/ (EVA planner, visor HUD and drive window, nothing to install), and the
Windows download, https://github.com/Aryan221224/MarsNav/releases/latest.

## Project Information

**Project Details \*** is a rich-text editor, so paste it with its formatting: open
[`submission/project_details.html`](project_details.html) in a browser (on GitHub: open the file, then "Raw", or open
the copy from the package), select the text below the line, copy, and paste into the field. Headings, bold text and
lists keep their formatting. (The same text, as Markdown, is the "Detailed Project Description" in
`submission/PROJECT_SUBMISSION.md`.)

**Use of Super Intelligence (SI) \*** (select all that apply; the answer is not shown to the judges). Pick the options
that match these uses, by their wording on the form:

- **Code / software**: yes. An AI coding assistant (Anthropic's Claude) helped write, test and debug the code.
- **Text / documents** (chatbots, large language models): yes. It helped draft the README, documents, user guide and
  this write-up.
- **Images**: yes. The MarsNav logo was made with an AI image generator.
- **Video**: yes, if offered. The video's capture and editing scripts were written with the AI assistant. The footage
  is the running app.
- **Audio**: no. The music was synthesised by the team's own script, with no AI audio.
- Do **not** select "I did not use SI".

**NASA Data \*** (click **Add New Link** for each row; Link Text, then Link Url)

| # | Link Text | Link Url |
|---|---|---|
| 1 | HiRISE 1 m and CTX 20 m elevation models and orthoimages of Jezero (MRO; Mars 2020 Terrain Relative Navigation products) | `https://planetarymaps.usgs.gov/mosaic/mars2020_trn/` |
| 2 | MOLA topography MEGDR (Mars Global Surveyor, PDS Geosciences Node) | `https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/` |
| 3 | TES thermal inertia (Mars Global Surveyor, PDS) | `https://pds-geosciences.wustl.edu/mgs/mgs-m-tes-5-timap-v1/mgst_9001/` |
| 4 | TES albedo (Mars Global Surveyor, PDS) | `https://pds-geosciences.wustl.edu/mgs/mgs-m-tes-special-v1/` |
| 5 | Mars Odyssey GRS hydrogen and elements (PDS Geosciences Node) | `https://pds-geosciences.wustl.edu/ody/ody-m-grs-5-elements-v1/odgm_xxxx/` |
| 6 | MRO GMM-3 gravity field (PDS Geosciences Node) | `https://pds-geosciences.wustl.edu/mro/mro-m-rss-5-sdp-v1/mrors_1xxx/data/shadr/` |
| 7 | NASA Mars Trek: THEMIS day/night infrared, Viking MDIM 2.1 colour mosaic, CRISM/OMEGA minerals, Exploration Zones, ice and activity layers | `https://trek.nasa.gov/mars/` |
| 8 | Mars 2020 MEDA weather station data (PDS Atmospheres Node) | `https://atmos.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda/` |
| 9 | Perseverance traverse waypoints (NASA/JPL MMGIS) | `https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json` |
| 10 | Curiosity traverse waypoints (NASA/JPL MMGIS) | `https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json` |
| 11 | Curiosity (MSL) RAD surface radiation dose | `https://science.nasa.gov/mission/msl-curiosity/` |
| 12 | MRO MARCI daily global weather maps, Mars years 28-32 | `https://doi.org/10.7910/DVN/G2VENZ` |
| 13 | MGS crustal magnetic field (Connerney et al. 2001, NASA GSFC) | `https://mgs-mager.gsfc.nasa.gov/publications/grl_28_connerney/data/grl_28_connerney_data.html` |
| 14 | SWIM subsurface water-ice maps (NASA-funded, Planetary Science Institute) | `https://swim.psi.edu/` |
| 15 | DONKI space-weather database (NASA CCMC) | `https://kauai.ccmc.gsfc.nasa.gov/DONKI/` |
| 16 | NASA SUITS Telemetry Stream Server (TSS2027) | `https://github.com/SUITS-Techteam/TSS2027` |
| 17 | Mars24 sunclock algorithm (NASA GISS) | `https://www.giss.nasa.gov/tools/mars24/` |

**Space Agency Partner & Other Data** (same, with **Add New Link**)

| # | Link Text | Link Url |
|---|---|---|
| 1 | ESA Mars Express HRSC: HRSC-MOLA blended global elevation 200 m (USGS) | `https://planetarymaps.usgs.gov/mosaic/Mars/HRSC_MOLA_Blend/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif` |
| 2 | Mars Climate Database dust climatology, Mars years 24-36 (LMD / CNES / ESA) | `https://www-mars.lmd.jussieu.fr/mars/dust_climatology/` |
| 3 | USGS global geologic map of Mars, SIM 3292 | `https://pubs.usgs.gov/sim/3292/` |
| 4 | USGS Astrogeology STAC catalogue (HiRISE, CTX, THEMIS products) | `https://stac.astrogeology.usgs.gov/api/` |
| 5 | Robbins & Hynek Mars crater database | `https://craters.sjrdesign.net/` |
| 6 | IAU Gazetteer of Planetary Nomenclature | `https://planetarynames.wr.usgs.gov/` |
| 7 | CTX global mosaic (Caltech Murray Lab), served by Esri | `https://astro.arcgis.com/arcgis/rest/services/OnMars/CTX1/MapServer` |
| 8 | three.js (MIT licence) | `https://threejs.org/` |
| 9 | NumPy | `https://numpy.org/` |
| 10 | SciPy | `https://scipy.org/` |
| 11 | rasterio | `https://rasterio.readthedocs.io/` |
| 12 | GDAL | `https://gdal.org/` |
| 13 | Pillow | `https://python-pillow.org/` |
| 14 | pywebview | `https://pywebview.flowrl.com/` |
| 15 | PyInstaller | `https://pyinstaller.org/` |
| 16 | Barlow and Barlow Condensed fonts (SIL Open Font License) | `https://fonts.google.com/specimen/Barlow` |
| 17 | IBM Plex Mono font (SIL Open Font License) | `https://fonts.google.com/specimen/IBM+Plex+Mono` |
| 18 | Claude (Anthropic), AI assistant used for code, documents and video scripts | `https://www.anthropic.com/claude` |

## Project Submission Verification

Your team ticks these itself; they are the team's own statements:

- [ ] **Agree to Terms and Conditions**
- [ ] **Confirm All Work is Original**

Then click **Submit for Judging**. A notification bar confirms it, and the participant certificate appears on each
member's profile. You can edit and resubmit until **Sunday 15 November, 23:59 (your Local Event's time)**; only the last
submission is judged.

## Images (optional)

The form above has no image field. If the Project page offers image upload elsewhere (JPG, PNG or GIF, up to 10 MB
each), use the screenshots in `submission/screens/`, starting with `01_plan_routes.jpg`, `13_landing_mode.jpg`,
`14_landing_dossier.jpg`, `06_execute_station.jpg` and `08_review_validation.jpg`.
