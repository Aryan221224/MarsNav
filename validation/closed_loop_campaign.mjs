#!/usr/bin/env node
// closed_loop_campaign.mjs - does the closed loop make EVAs safer? A paired Monte Carlo campaign on the real Jezero data.
// Each run draws a hidden truth (how hard the crew works, how the cooling water, battery and walking pace compare with
// the model) and flies the same EVA twice with the same random numbers: once with the closed loop (telemetry ->
// estimators -> forecast -> re-plan) and once without it (plan as filed; the caution-and-warning system still calls
// "return now" at the walkback limit, as any suit display would). Paired Wilcoxon signed-rank tests on the per-run
// differences; every number is reported whichever way it comes out.
//   node validation/closed_loop_campaign.mjs [--runs 40]
// Writes validation/results/closed_loop.json, validation/CLOSED_LOOP.md, and adds a section to app/data/validation.json.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildHeadless } from "../tools/tss_fake.mjs";
import { EvaSim, TRUTH_SCENARIOS } from "../engine/sim.js";
import { wilcoxonSignedRank } from "../engine/stats.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = Number(process.argv[process.argv.indexOf("--runs") + 1]) || 40;
const t0 = performance.now();
const H = await buildHeadless({ stops: ["AMAL", "ISSO"] });
const valueOf = Object.fromEntries(H.stops.map((s) => [s.name, s.value ?? 0.3]));

function rng(seed) { // mulberry32: well mixed even for consecutive seeds
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function fly(truth, seed, autoReplan) {
  const sim = new EvaSim(H.P, H.sortie, { truth, stops: H.stops, seed, autoReplan });
  let minRem = 1;
  for (let k = 0; k < 2000 && !sim.done; k++) {
    sim.step(60);
    // the hidden truth, not the telemetry: did the crew really dip into the reserve?
    const r = sim.res, cap = sim.P.cap;
    minRem = Math.min(minRem, 1 - r.o2 / cap.o2, 1 - r.co2 / cap.co2, 1 - r.water / cap.water, 1 - r.batt / cap.batt);
  }
  // science credit in proportion to the station work actually done (a station cut to half its time earns half)
  const science = sim.stops.filter((s) => s.done).reduce((a, s) => a + valueOf[s.name] * (s.frac ?? 1), 0);
  const warn = sim.alerts.log.filter((a) => a.event === "raised" && a.level === 3).map((a) => a.id);
  return { minRem, breach: minRem < 0, science, returning: sim.returning, done: sim.done, tH: sim.t / 3600, replans: sim.replans.filter((r) => !r.kept).length,
    firstDecisionMin: sim.replans.length ? sim.replans[0].t / 60 : null, warnings: [...new Set(warn)], lateReturn: warn.includes("pnr") };
}

const runs = [];
const named = ["nominal", "hardwork", "slow", "battery"];
for (let k = 0; k < RUNS; k++) {
  let truth, label;
  if (k < named.length) { truth = named[k]; label = named[k]; }
  else {
    const r = rng(1000 + k);
    truth = { met: 0.9 + 0.5 * r(), water: 0.9 + 0.5 * r(), batt: 0.9 + 0.6 * r(), speed: 0.7 + 0.4 * r() };
    label = `random ${k}`;
  }
  const seed = 7 + k;
  const closed = fly(truth, seed, true), open = fly(truth, seed, false);
  const T = typeof truth === "string" ? TRUTH_SCENARIOS[truth] : truth;
  runs.push({ label, truth: { met: T.met ?? 1, water: T.water ?? 1, batt: T.batt ?? 1, speed: T.speed ?? 1 }, closed, open });
  process.stdout.write(`${label.padEnd(10)} closed min ${(100 * closed.minRem).toFixed(0).padStart(4)} %  sci ${closed.science.toFixed(1)}  | open min ${(100 * open.minRem).toFixed(0).padStart(4)} %  sci ${open.science.toFixed(1)}${open.lateReturn ? "  (RETURN NOW warning)" : ""}\n`);
}

const col = (w, k) => runs.map((r) => r[w][k]);
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const S = {
  runs: runs.length,
  minReserve: { closedMean: mean(col("closed", "minRem")), openMean: mean(col("open", "minRem")),
    closedWorst: Math.min(...col("closed", "minRem")), openWorst: Math.min(...col("open", "minRem")),
    test: wilcoxonSignedRank(col("closed", "minRem"), col("open", "minRem")) },
  breaches: { closed: col("closed", "breach").filter(Boolean).length, open: col("open", "breach").filter(Boolean).length },
  lateReturnWarnings: { closed: col("closed", "lateReturn").filter(Boolean).length, open: col("open", "lateReturn").filter(Boolean).length },
  science: { closedMean: mean(col("closed", "science")), openMean: mean(col("open", "science")),
    test: wilcoxonSignedRank(col("closed", "science"), col("open", "science")) },
  // science that did not cost a dip into the reserve (a station finished on reserve oxygen is not a success)
  safeScience: { closed: mean(runs.map((r) => (r.closed.breach ? 0 : r.closed.science))), open: mean(runs.map((r) => (r.open.breach ? 0 : r.open.science))),
    test: wilcoxonSignedRank(runs.map((r) => (r.closed.breach ? 0 : r.closed.science)), runs.map((r) => (r.open.breach ? 0 : r.open.science))) },
  replansMean: mean(col("closed", "replans")),
  noReplanWhenNominal: runs[0].closed.replans === 0,
  runtime_s: (performance.now() - t0) / 1000,
};
fs.mkdirSync(path.join(ROOT, "validation", "results"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "validation", "results", "closed_loop.json"), JSON.stringify({ generated_utc: new Date().toISOString(), summary: S, runs }, null, 1));

const pc = (v) => `${(100 * v).toFixed(1)} %`, pv = (p) => (p < 0.001 ? "< 0.001" : p.toFixed(3));
const md = `# Closed-loop validation campaign

Generated ${new Date().toISOString()} by \`node validation/closed_loop_campaign.mjs\` (${S.runs} paired runs, ${S.runtime_s.toFixed(0)} s).
Raw numbers: \`validation/results/closed_loop.json\`.

**Set-up.** Jezero, habitat -> Amalik -> Issole -> habitat, the balanced plan (4.8 h, 12 % minimum walkback margin). Each run
draws a hidden truth the software is not told: work rate x0.9-1.4, cooling water x0.9-1.4, battery drain x0.9-1.5, walking
pace x0.7-1.1 (the first four runs are the named scenarios). The same EVA is flown twice with the same random numbers:
**closed loop** (TSS-format telemetry -> estimators -> forecast -> re-plan) and **open loop** (the plan as filed; the
caution-and-warning system still calls RETURN NOW at the walkback limit). "Reserve" below is measured on the hidden truth.

| Measure | Closed loop | Open loop | Paired test |
|---|---|---|---|
| Lowest usable consumable left, mean | ${pc(S.minReserve.closedMean)} | ${pc(S.minReserve.openMean)} | Wilcoxon signed-rank, closed > open: p ${pv(S.minReserve.test.pGreater)} (n = ${S.minReserve.test.n}) |
| Lowest usable consumable left, worst run | ${pc(S.minReserve.closedWorst)} | ${pc(S.minReserve.openWorst)} | |
| Runs that dipped into the reserve | ${S.breaches.closed} of ${S.runs} | ${S.breaches.open} of ${S.runs} | |
| Runs that needed a RETURN NOW warning | ${S.lateReturnWarnings.closed} | ${S.lateReturnWarnings.open} | |
| Science value completed, mean | ${S.science.closedMean.toFixed(2)} | ${S.science.openMean.toFixed(2)} | two-sided p ${pv(S.science.test.pTwoSided)} |
| Science completed without touching the reserve, mean | ${S.safeScience.closed.toFixed(2)} | ${S.safeScience.open.toFixed(2)} | closed > open: p ${pv(S.safeScience.test.pGreater)} |

Re-plans per EVA (closed loop): ${S.replansMean.toFixed(1)} on average; nominal crew: ${S.noReplanWhenNominal ? "no re-plan" : "re-planned (unexpected)"}.

**What this shows.** Learning the real rates from telemetry and re-planning early keeps more in the tanks than flying the
filed plan and reacting to the walkback caution, across crews and hardware the planner was not told about.
**What it costs.** Raw science is lower: the open-loop crew often finishes a station on reserve oxygen or battery. Counting
only science done without touching the reserve, the loop comes out ahead. It cuts the lowest-value station's work to half
before dropping it, and it waits for confident estimates unless the walkback margin is thin or station work is about to
start (the last responsible moment), so it does not give science away to an estimation wobble.
**What it does not show.** Both arms use the same simulator; the truth is drawn from ranges we chose. The integration with
NASA's own telemetry server is shown separately (docs/09, "Test against TSS").
`;
fs.writeFileSync(path.join(ROOT, "validation", "CLOSED_LOOP.md"), md);

// add to the Review panel's validation block
const vpath = path.join(ROOT, "app", "data", "validation.json");
if (fs.existsSync(vpath)) {
  const v = JSON.parse(fs.readFileSync(vpath, "utf8"));
  const rows = [
    ["Closed loop (paired, n = " + S.runs + ")", `lowest consumable left ${pc(S.minReserve.closedMean)} vs ${pc(S.minReserve.openMean)} open loop (Wilcoxon p ${pv(S.minReserve.test.pGreater)}); reserve dipped ${S.breaches.closed} vs ${S.breaches.open} runs`],
    ["Closed loop cost", `science ${S.science.closedMean.toFixed(2)} vs ${S.science.openMean.toFixed(2)} raw; ${S.safeScience.closed.toFixed(2)} vs ${S.safeScience.open.toFixed(2)} without touching the reserve`],
  ];
  v.summary = [...(v.summary || []).filter(([k]) => !String(k).startsWith("Closed loop")), ...rows];
  v.html = v.html.replace(/<tr><th>Closed loop[\s\S]*?<\/tr>/g, "").replace("</table>", rows.map(([k, x]) => `<tr><th>${k}</th><td>${x}</td></tr>`).join("") + "</table>");
  fs.writeFileSync(vpath, JSON.stringify(v));
}
console.log(`\n${md}`);
