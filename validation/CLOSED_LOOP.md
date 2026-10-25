# Closed-loop validation campaign

Generated 2026-10-25T10:59:22.083Z by `node validation/closed_loop_campaign.mjs` (40 paired runs, 68 s).
Raw numbers: `validation/results/closed_loop.json`.

**Set-up.** Jezero, habitat -> Amalik -> Issole -> habitat, the balanced plan (4.8 h, 12 % minimum walkback margin). Each run
draws a hidden truth the software is not told: work rate x0.9-1.4, cooling water x0.9-1.4, battery drain x0.9-1.5, walking
pace x0.7-1.1 (the first four runs are the named scenarios). The same EVA is flown twice with the same random numbers:
**closed loop** (TSS-format telemetry -> estimators -> forecast -> re-plan) and **open loop** (the plan as filed; the
caution-and-warning system still calls RETURN NOW at the walkback limit). "Reserve" below is measured on the hidden truth.

| Measure | Closed loop | Open loop | Paired test |
|---|---|---|---|
| Lowest usable consumable left, mean | 24.6 % | -5.1 % | Wilcoxon signed-rank, closed > open: p < 0.001 (n = 34) |
| Lowest usable consumable left, worst run | 3.1 % | -40.8 % | |
| Runs that dipped into the reserve | 0 of 40 | 31 of 40 | |
| Runs that needed a RETURN NOW warning | 0 | 31 | |
| Science value completed, mean | 0.64 | 0.90 | two-sided p < 0.001 |
| Science completed without touching the reserve, mean | 0.64 | 0.29 | closed > open: p < 0.001 |

Re-plans per EVA (closed loop): 1.1 on average; nominal crew: no re-plan.

**What this shows.** Learning the real rates from telemetry and re-planning early keeps more in the tanks than flying the
filed plan and reacting to the walkback caution, across crews and hardware the planner was not told about.
**What it costs.** Raw science is lower: the open-loop crew often finishes a station on reserve oxygen or battery. Counting
only science done without touching the reserve, the loop comes out ahead. It cuts the lowest-value station's work to half
before dropping it, and it waits for confident estimates unless the walkback margin is thin or station work is about to
start (the last responsible moment), so it does not give science away to an estimation wobble.
**What it does not show.** Both arms use the same simulator; the truth is drawn from ranges we chose. The integration with
NASA's own telemetry server is shown separately (docs/09, "Test against TSS").
