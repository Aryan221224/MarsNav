// meda_sampler.js - reproducible sampler for Perseverance MEDA data (NASA PDS Atmospheres Node).
//
// Why a browser script: the PDS server allows HTTP range requests, so instead of downloading ~15 MB of CSV per sol
// we read 48 evenly spaced rows from each file (a few kB per file). Paste this into the DevTools console on
// https://atmos.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda/ (same-origin, no CORS issue), wait for
// `__meda.finished === true`, then run `__medaSave()` to download meda_samples.json into data_cache/.
// This is exactly the procedure used to build app/data/environment.json (every 15th sol, sols 0-1859).

(() => {
  const B = "/PDS/data/PDS4/Mars2020/mars2020_meda/";
  const bins = [[0, 89], [90, 179], [180, 299], [300, 419], [420, 539], [540, 659], [660, 779], [780, 899], [900, 1019],
    [1020, 1139], [1140, 1259], [1260, 1379], [1380, 1499], [1500, 1619], [1620, 1739], [1740, 1859]];
  const binOf = (s) => {
    const b = bins.find(([a, z]) => s >= a && s <= z);
    return `sol_${String(b[0]).padStart(4, "0")}_${String(b[1]).padStart(4, "0")}`;
  };
  async function ls(p) {
    const r = await fetch(B + p);
    if (!r.ok) return [];
    const d = new DOMParser().parseFromString(await r.text(), "text/html");
    return [...d.querySelectorAll("a")].map((a) => a.getAttribute("href")).filter((h) => h && h.endsWith(".CSV"));
  }
  async function sampleFile(url, cols, n) {
    const size = +(await fetch(url, { method: "HEAD" })).headers.get("content-length");
    if (!size) return null;
    const head = (await (await fetch(url, { headers: { Range: "bytes=0-4000" } })).text()).split("\r\n")[0].split(",");
    const idx = cols.map((c) => head.indexOf(c));
    const rows = [];
    await Promise.all([...Array(n).keys()].map(async (i) => {
      const off = Math.floor(((i + 0.5) * size) / n);
      try {
        const t = await (await fetch(url, { headers: { Range: `bytes=${off}-${Math.min(size - 1, off + 1200)}` } })).text();
        const l = t.split("\r\n");
        if (l.length < 3) return;
        const f = l[1].split(",");
        rows.push(idx.map((k) => (k < 0 ? null : f[k])));
      } catch (e) { /* skip */ }
    }));
    return { cols, rows };
  }
  window.__meda = { done: 0, total: 0, sols: {}, errors: [], started: Date.now(), finished: false };
  const sols = [];
  for (let s = 0; s <= 1859; s += 15) sols.push(s);
  window.__meda.total = sols.length;
  const q = [...sols];
  async function worker() {
    while (q.length) {
      const s = q.shift(), ss = String(s).padStart(4, "0");
      try {
        const dder = `data_derived_env/${binOf(s)}/sol_${ss}/`, dcal = `data_calibrated_env/${binOf(s)}/sol_${ss}/`;
        const fd = await ls(dder), fc = await ls(dcal);
        const pick = (arr, k) => arr.find((x) => x.includes(k));
        const rec = { files: { der: fd, cal: fc } };
        const anc = pick(fd, "DER_ANCILLARY");
        if (anc) rec.anc = await sampleFile(B + dder + anc, ["LMST", "LTST", "SOLAR_LONGITUDE_ANGLE", "SOLAR_ZENITHAL_ANGLE", "ROVER_POSITION_X", "ROVER_POSITION_Y"], 48);
        const psd = pick(fd, "DER_PS");
        if (psd) rec.psd = await sampleFile(B + dder + psd, ["LMST", "LTST", "PRESSURE"], 48);
        const ti = pick(fc, "CAL_TIRS");
        if (ti) rec.tirs = await sampleFile(B + dcal + ti, ["LMST", "LTST", "AIR_TEMP", "GROUND_TEMP", "DOWNWARD_LW_IRRADIANCE", "UPWARD_SW_IRRADIANCE", "TIRS_GROUND_FOOTPRINT_NOT_IN_SHADOW"], 48);
        const at = pick(fc, "CAL_ATS");
        if (at) rec.ats = await sampleFile(B + dcal + at, ["LMST", "LTST", "ATS_LOCAL_TEMP1", "ATS_LOCAL_TEMP2", "ATS_LOCAL_TEMP3", "ATS_LOCAL_TEMP4", "ATS_LOCAL_TEMP5"], 48);
        window.__meda.sols[s] = rec;
      } catch (e) {
        window.__meda.errors.push([s, String(e)]);
      }
      window.__meda.done++;
    }
  }
  Promise.all([worker(), worker(), worker(), worker()]).then(() => { window.__meda.finished = true; });
  window.__medaSave = () => {
    const blob = new Blob([JSON.stringify({ sampled_utc: new Date().toISOString(), sols: window.__meda.sols })], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "meda_samples.json";
    a.click();
  };
})();
