// Headline numbers: every validation figure quoted in the README and the submission comes from the result files the
// validation scripts write, through validation/results/headline.json. These tests fail if a document, headline.json
// and the source results disagree. Run: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { headline, wilson, clopperPearson, signTestP } from "../validation/headline_stats.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const H = JSON.parse(read("validation/results/headline.json"));
const DOCS = {
  readme: read("README.md"),
  submission: read("submission/PROJECT_SUBMISSION.md"),
  details: read("submission/project_details.html"),
  form: read("submission/SPACE_APPS_FORM.md"),
  vv: read("docs/05_verification_and_validation.md"),
};
const r0 = (x) => Math.round(x);
const sup = (n) => String(n).replace(/\d/g, (d) => "⁰¹²³⁴⁵⁶⁷⁸⁹"[d]);

test("headline.json is exactly what the result files give (no hand-typed figures)", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(headline())), H);
});

test("interval methods: Wilson, Clopper-Pearson and the exact sign test on known cases", () => {
  // Clopper-Pearson for 0 of n has the closed form 1 - (alpha/2)^(1/n)
  assert.ok(Math.abs(clopperPearson(0, 40)[1] - (1 - Math.pow(0.025, 1 / 40))) < 1e-6);
  assert.deepEqual(clopperPearson(40, 40).map((x) => +x.toFixed(6)), [+Math.pow(0.025, 1 / 40).toFixed(6), 1]);
  // Wilson is symmetric under k -> n - k
  const [a, b] = wilson(21, 30), [c, d] = wilson(9, 30);
  assert.ok(Math.abs(a - (1 - d)) < 1e-12 && Math.abs(b - (1 - c)) < 1e-12);
  // sign test: all 31 discordant pairs one way is 2 * 0.5^31
  assert.ok(Math.abs(signTestP(31, 0) - 2 * Math.pow(0.5, 31)) < 1e-18);
  assert.ok(Math.abs(signTestP(5, 5) - 1) < 1e-12);
});

test("the README quotes every headline figure and interval as headline.json has it", () => {
  const t = DOCS.readme;
  const need = [
    `0.001 ± ${H.clock.sza_sd_deg}° over ${H.clock.samples.toLocaleString("en-US")} samples on ${H.clock.sols} sols`,
    `${r0(H.slope.pct)} % of ${H.slope.n} points (95 % CI ${r0(H.slope.ci95_pct[0])}–${r0(H.slope.ci95_pct[1])} %; r = ${H.slope.r})`,
    `${r0(H.false_nogo.pct)} % of ${H.false_nogo.n} real Perseverance positions (95 % CI ${r0(H.false_nogo.ci95_pct[0])}–${r0(H.false_nogo.ci95_pct[1])} %)`,
    `${H.detour.k} of ${H.detour.n} detour drives (${r0(H.detour.pct)} %, 95 % CI ${r0(H.detour.ci95_pct[0])}–${r0(H.detour.ci95_pct[1])} %)`,
    `${H.closed_loop.closed_dips} of ${H.closed_loop.runs} dipped into the reserve with the loop (95 % CI ${r0(H.closed_loop.closed_ci95_pct[0])}–${r0(H.closed_loop.closed_ci95_pct[1])} %)`,
    `${H.closed_loop.open_dips} of ${H.closed_loop.runs} without (95 % CI ${r0(H.closed_loop.open_ci95_pct[0])}–${r0(H.closed_loop.open_ci95_pct[1])} %)`,
    `p = ${Math.round(H.closed_loop.sign_test_p / 10 ** Math.floor(Math.log10(H.closed_loop.sign_test_p)))} × 10⁻${sup(-Math.floor(Math.log10(H.closed_loop.sign_test_p)))}`,
    `${H.shielding.blocked_sky_pct} % of the sky blocked, RAD measured about −${-H.shielding.measured_change_pct} % dose`,
    `−${-r0(H.shielding.model_range_pct[0])} % to −${-r0(H.shielding.model_range_pct[1])} % for that geometry`,
    `−${-r0(H.shielding.model_range_no_albedo_pct[0])} % to −${-r0(H.shielding.model_range_no_albedo_pct[1])} % without the butte's own albedo`,
    `only ${r0(H.shielding.orbital_blocked_sky_within_24m_pct[0])}–${r0(H.shielding.orbital_blocked_sky_within_24m_pct[1])} % of the sky blocked within 24 m`,
  ];
  for (const s of need) assert.ok(t.includes(s), `README is missing: ${s}`);
});

test("the measured RAD change sits inside the model's range, and the no-albedo variant overshoots it", () => {
  const [hi, lo] = H.shielding.model_range_pct;          // e.g. [-2.6, -9.9]
  assert.ok(lo < H.shielding.measured_change_pct && H.shielding.measured_change_pct < hi);
  assert.ok(H.shielding.model_range_no_albedo_pct[0] < H.shielding.measured_change_pct, "no-albedo range starts beyond the measurement");
});

test("the submission texts quote the same validation counts", () => {
  const counts = [`${H.detour.k} of ${H.detour.n}`, `${H.closed_loop.closed_dips} of ${H.closed_loop.runs}`, `${H.closed_loop.open_dips} of ${H.closed_loop.runs}`,
    `${H.clock.samples.toLocaleString("en-US")} samples`, `${r0(H.slope.pct)} % of ${H.slope.n} points`];
  for (const [name, t] of [["PROJECT_SUBMISSION.md", DOCS.submission], ["project_details.html", DOCS.details]]) {
    for (const s of counts) assert.ok(t.includes(s), `${name} is missing: ${s}`);
  }
  // the form's short summary quotes the closed-loop result
  assert.ok(DOCS.form.includes(`${H.closed_loop.open_dips} of ${H.closed_loop.runs} did on the fixed plan`));
  for (const s of [`${H.detour.k} of ${H.detour.n}`, `${H.closed_loop.closed_dips} of ${H.closed_loop.runs} vs ${H.closed_loop.open_dips} of ${H.closed_loop.runs}`]) {
    assert.ok(DOCS.vv.includes(s), `docs/05 is missing: ${s}`);
  }
});
