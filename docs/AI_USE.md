# Use of AI in MarsNav

NASA Space Apps asks every team to disclose its use of AI. This file is that disclosure for the repository.

## How we used AI

We used AI tools the way a modern engineering team does: to move faster, while every design decision, method, result and claim stayed with the team.

| Area | How AI helped | What the team did |
|---|---|---|
| Source code (`engine/`, `planet/`, `pipeline/`, `launcher/`, `app/`) | An AI coding assistant (Anthropic's Claude) helped write, refactor and debug code | Designed the system, chose methods and data, set the safety rules, reviewed and tested every change |
| Tests and validation (`tests/`, `validation/`) | Helped write test and validation code | Chose what to test against (Perseverance's records, NASA's TSS2027 server) and checked the results |
| Documents (`README.md`, `docs/`, `submission/`, the user guide) | Helped draft and edit text from our results | Checked every statement against the code and data |
| Logo (`app/logo-*.png`, `app/icon-256.png`, `app/favicon-64.png`) | Created with an AI image generator | Chose the design; marked as AI-generated in the README and the submission |

All source files in this repository should be treated as AI-assisted.

## What is not AI-generated

- **Data.** Every dataset is real NASA, ESA and USGS mission data, downloaded from its source with a recorded SHA-256 checksum (`pipeline/sources.json`, `docs/04_data_and_provenance.md`).
- **Results.** Every number in the README, the documents and the submission comes from running the code on that data. Anyone can re-run them: `node --test tests/*.test.mjs`, `python -m pytest tests -q`, `node validation/validate.mjs`, `node validation/closed_loop_campaign.mjs`, `node validation/rover_case_study.mjs`.
- **Screenshots and figures.** Captures of the running app and plots made by our scripts.

No AI-generated content uses NASA logos or branding. MarsNav is an independent project and is not endorsed by NASA.
