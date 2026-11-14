// nav.js - real-time navigation filter for a suited crew member or a rover (research doc 33).
// Mars has no GPS. Flight rovers propagate position with IMU heading and wheel/visual odometry, re-fix heading on the
// Sun, and re-fix position against orbital maps (Perseverance "Mars Global Localization", ~0.25-1 m, 2026).
// This is an extended Kalman filter on [east, north, heading bias] in metres/radians:
//   propagate: each step of length d at measured heading psi_m  ->  true heading psi = psi_m - b
//   measurements: absolute position (map match / constellation / telemetry), sun heading (observes b),
//                 range to the habitat beacon, relay-orbiter Doppler fix (coarse)
// Everything the crew sees (position, error ellipse, "position uncertain") comes from this estimate, never from truth.

const DEG = Math.PI / 180;

/** Sensor suites [ASSUME values, sourced ranges in research doc 33]. */
export const NAV_SENSORS = {
  suit: { distFrac: 0.02, headingNoiseDeg: 2, biasDriftDegPerH: 3, sunSigmaDeg: 1.5, mapFixM: 1.0, beaconRangeM: 1.0 },
  rover: { distFrac: 0.01, headingNoiseDeg: 0.5, biasDriftDegPerH: 3, sunSigmaDeg: 1.5, mapFixM: 0.5, beaconRangeM: 1.0 },
};

export class NavFilter {
  /**
   * @param x0,y0 initial position (m, working projection)
   * @param opts { kind: "suit"|"rover", sigma0 (m), headingSigma0Deg }
   */
  constructor(x0, y0, opts = {}) {
    this.p = { ...NAV_SENSORS[opts.kind || "suit"], ...(opts.sensors || {}) };
    this.x = [x0, y0, 0];
    const s0 = opts.sigma0 ?? 3, h0 = (opts.headingSigma0Deg ?? 2) * DEG;
    this.P = [[s0 * s0, 0, 0], [0, s0 * s0, 0], [0, 0, h0 * h0]];
    this.fixes = [];
    this.lastFix = null;
  }

  /** Dead-reckoning step: d metres at measured heading psiMDeg (clockwise from north), over dt seconds. */
  propagate(d, psiMDeg, dt) {
    const [x, y, b] = this.x;
    const psi = psiMDeg * DEG - b;
    const s = Math.sin(psi), c = Math.cos(psi);
    this.x = [x + d * s, y + d * c, b];
    // Jacobian wrt state (bias enters through psi) and wrt noise (distance scale, heading noise)
    const F = [[1, 0, -d * c], [0, 1, d * s], [0, 0, 1]];
    const sd = this.p.distFrac * d, sh = this.p.headingNoiseDeg * DEG;
    const G = [[s, d * c], [c, -d * s], [0, 0]];
    const qb = (this.p.biasDriftDegPerH * DEG) ** 2 * (dt / 3600);
    const FP = mul(F, this.P);
    let P = mul(FP, tr(F));
    const GQ = [[G[0][0] * sd * sd, G[0][1] * sh * sh], [G[1][0] * sd * sd, G[1][1] * sh * sh], [0, 0]];
    const GQG = mul(GQ, tr(G));
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) P[i][j] += GQG[i][j];
    P[2][2] += qb;
    this.P = sym(P);
  }

  /** Motion with no odometry (e.g. between external position fixes): position variance grows by q (m^2) per axis. */
  inflate(q, dt = 0) {
    this.P[0][0] += q;
    this.P[1][1] += q;
    this.P[2][2] += (this.p.biasDriftDegPerH * DEG) ** 2 * (dt / 3600);
  }

  /** Re-acquire: restart the filter at a new position (after repeated rejected fixes, e.g. a telemetry jump). */
  reset(x, y, sigma) {
    this.x = [x, y, this.x[2]];
    this.P = [[sigma * sigma, 0, 0], [0, sigma * sigma, 0], [0, 0, this.P[2][2]]];
    this.lastFix = "re-acquired";
  }

  _update(z, h, H, R, kind) {
    // generic EKF update for measurement vector z with prediction h, Jacobian H (m x 3), noise R (m x m)
    const HP = mul(H, this.P);
    const S = add(mul(HP, tr(H)), R);
    const Si = inv(S);
    const K = mul(mul(this.P, tr(H)), Si);
    const y = z.map((zi, i) => zi - h[i]);
    // chi-square gate (reject outliers beyond ~99.9 %)
    const d2 = quad(y, Si);
    const gate = [0, 10.8, 13.8, 16.3][z.length];
    if (d2 > gate) return false;
    for (let i = 0; i < 3; i++) this.x[i] += K[i].reduce((a, k, j) => a + k * y[j], 0);
    const KH = mul(K, H);
    const I_KH = [[1 - KH[0][0], -KH[0][1], -KH[0][2]], [-KH[1][0], 1 - KH[1][1], -KH[1][2]], [-KH[2][0], -KH[2][1], 1 - KH[2][2]]];
    // Joseph form keeps P symmetric positive definite
    this.P = sym(add(mul(mul(I_KH, this.P), tr(I_KH)), mul(mul(K, R), tr(K))));
    this.lastFix = kind;
    this.fixes.push(kind);
    if (this.fixes.length > 200) this.fixes.shift();
    return true;
  }

  /** Absolute position fix (orbital-map match, constellation, external telemetry), sigma in metres. */
  fixPosition(x, y, sigma, kind = "map match") {
    return this._update([x, y], [this.x[0], this.x[1]], [[1, 0, 0], [0, 1, 0]], [[sigma * sigma, 0], [0, sigma * sigma]], kind);
  }

  /** Sun-sensor heading: true heading psiTrueDeg observed while the IMU reads psiMDeg -> observes the bias. */
  fixHeading(psiMDeg, psiTrueDeg, sigmaDeg = this.p.sunSigmaDeg) {
    let db = (psiMDeg - psiTrueDeg) * DEG;
    db = Math.atan2(Math.sin(db), Math.cos(db));
    return this._update([db], [this.x[2]], [[0, 0, 1]], [[(sigmaDeg * DEG) ** 2]], "sun heading");
  }

  /** Two-way radio range to a beacon at (bx, by). */
  fixRange(bx, by, range, sigma = this.p.beaconRangeM) {
    const dx = this.x[0] - bx, dy = this.x[1] - by, r = Math.max(1e-3, Math.hypot(dx, dy));
    return this._update([range], [r], [[dx / r, dy / r, 0]], [[sigma * sigma]], "beacon range");
  }

  get pos() { return [this.x[0], this.x[1]]; }

  /** 2-sigma error ellipse: semi-axes (m) and orientation (deg from east). */
  ellipse() {
    const a = this.P[0][0], b = this.P[0][1], d = this.P[1][1];
    const tt = (a + d) / 2, det = a * d - b * b, disc = Math.sqrt(Math.max(0, tt * tt - det));
    const l1 = tt + disc, l2 = Math.max(0, tt - disc);
    return { major: 2 * Math.sqrt(l1), minor: 2 * Math.sqrt(l2), angleDeg: (0.5 * Math.atan2(2 * b, a - d)) / DEG,
      sigma: Math.sqrt(l1) };
  }
}

// ---- tiny dense linear algebra (3x3 and smaller) ----
function mul(A, B) {
  const n = A.length, m = B[0].length, k = B.length;
  const C = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) { let s = 0; for (let q = 0; q < k; q++) s += A[i][q] * B[q][j]; C[i][j] = s; }
  return C;
}
function tr(A) { return A[0].map((_, j) => A.map((r) => r[j])); }
function add(A, B) { return A.map((r, i) => r.map((v, j) => v + B[i][j])); }
function sym(P) { return P.map((r, i) => r.map((v, j) => (v + P[j][i]) / 2)); }
function inv(S) {
  if (S.length === 1) return [[1 / S[0][0]]];
  if (S.length === 2) {
    const [[a, b], [c, d]] = S, det = a * d - b * c;
    return [[d / det, -b / det], [-c / det, a / det]];
  }
  throw new Error("inv: size");
}
function quad(y, Si) { let s = 0; for (let i = 0; i < y.length; i++) for (let j = 0; j < y.length; j++) s += y[i] * Si[i][j] * y[j]; return s; }
