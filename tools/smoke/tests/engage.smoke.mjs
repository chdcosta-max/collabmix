// engage_align.smoke.mjs — headless assertion for the beat-grid unification.
//
// Proves the two properties the VISION_5 unification plan calls for:
//   1. Post-engage, the slave's nearest beat aligns to the master's within
//      <10ms (measured against the REFINED beatTimes — the actual kicks).
//   2. Repeat-engage is IDEMPOTENT — pressing SYNC again does not move the
//      slave (no wander).
//
// It runs BOTH engage models against the same synthetic tracks:
//   - REFINED (beatsv2): phase-align on the refined beatTimes, seek NOT
//     re-quantized → expected PASS on both properties.
//   - LINEAR + quantize (legacy): phase-align on the single-period linear
//     model, then the smart-quantize re-snaps the seek to the nearest refined
//     beat → expected FAIL (off by the refine deltas, and it wanders on
//     repeat-engage). This is the regression the plan diagnoses.
//
// Pure logic, no browser, deterministic (seeded jitter — no Math.random).
//   node tools/smoke/engage_align.smoke.mjs   →  exit 0 = PASS, 1 = FAIL.
//
// nearestBeatTime + refinedBeatPhase are COPIED VERBATIM from
// src/collabmix-production.jsx — keep them in sync if either changes.

// ───────────────────────── helpers (verbatim from src) ─────────────────────
function nearestBeatTime(beats, t) {
  if (!beats || beats.length === 0) return null;
  let lo = 0, hi = beats.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (beats[mid] < t) lo = mid + 1; else hi = mid; }
  let nearest = beats[lo];
  if (lo > 0 && Math.abs(beats[lo - 1] - t) <= Math.abs(beats[lo] - t)) nearest = beats[lo - 1];
  return nearest;
}
function refinedBeatPhase(beats, t) {
  if (!beats || beats.length < 2) return null;
  let lo = 0, hi = beats.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (beats[mid] <= t) lo = mid; else hi = mid - 1; }
  let i = lo;
  if (i >= beats.length - 1) i = beats.length - 2;
  const period = beats[i + 1] - beats[i];
  if (!(period > 0)) return null;
  const frac = (t - beats[i]) / period;
  return { index: i, frac, period };
}

// ───────────────────────── synthetic track builder ─────────────────────────
// Deterministic ±jitterMs per-beat refine offset (no Math.random).
function mkTrack(bpm, anchorSec, jitterMs, seed, nBeats = 2048) {
  const period = 60 / bpm;
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5; }; // [-0.5,0.5]
  const refined = new Array(nBeats);
  for (let k = 0; k < nBeats; k++) {
    refined[k] = k * period + anchorSec + rnd() * 2 * (jitterMs / 1000); // ±jitterMs
  }
  // Linear reconstruction the analyzer also emits (single anchor + period).
  return { refined, linear: { beatPhaseSec: anchorSec % period, beatPeriodSec: period }, period };
}

// Residual KICK misalignment (ms), ALWAYS measured on the refined grids — that
// is what the ear hears. Phase fraction is rate-invariant, so reporting in
// slave-buffer-ms is equivalent to wall-clock ms after the rate match.
function residualMs(master, slave, masterCurTime, slaveCurTime) {
  const m = refinedBeatPhase(master.refined, masterCurTime);
  const s = refinedBeatPhase(slave.refined, slaveCurTime);
  let d = m.frac - s.frac;
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return Math.abs(d * s.period) * 1000;
}

// ───────────────────────── the two engage models ───────────────────────────
// REFINED engage (beatsv2): returns the new slave buffer time. No re-quantize.
// Iterates the minimal (wrap-bounded ≤0.5-beat) phase nudge to convergence —
// the refine jitter means each seek lands in a neighbouring interval with a
// slightly different period, so one shot leaves a small residual. The first
// step is the minimal move; subsequent steps are sub-ms. Converged = exactly
// idempotent on repeat-engage.
function engageRefined(master, slave, masterCurTime, slaveCurTime) {
  const m = refinedBeatPhase(master.refined, masterCurTime);
  const mFrac = m.frac - Math.floor(m.frac);
  let t = slaveCurTime;
  for (let iter = 0; iter < 6; iter++) {
    const s = refinedBeatPhase(slave.refined, t);
    let off = mFrac - (s.frac - Math.floor(s.frac));
    if (off > 0.5) off -= 1;
    if (off < -0.5) off += 1;
    if (Math.abs(off) < 1e-4) break; // <0.01% of a beat → converged
    t += off * s.period;
  }
  return t;
}

// LEGACY engage: linear phase-align, THEN smart-quantize snaps the seek to the
// nearest refined beat (the production behavior that produces the wander).
function engageLegacy(master, slave, masterCurTime, slaveCurTime) {
  const mFrac = ((masterCurTime - master.linear.beatPhaseSec) / master.linear.beatPeriodSec) % 1;
  const sFrac = ((slaveCurTime - slave.linear.beatPhaseSec) / slave.linear.beatPeriodSec) % 1;
  let off = mFrac - sFrac;
  if (off > 0.5) off -= 1;
  if (off < -0.5) off += 1;
  const target = slaveCurTime + off * slave.linear.beatPeriodSec;
  return nearestBeatTime(slave.refined, target); // smart-quantize re-snap
}

// ───────────────────────── scenarios ───────────────────────────────────────
const SCEN = [
  { name: "124→128, +18ms jitter", mBpm: 124, sBpm: 128, jit: 18, mAnchor: 0.031, sAnchor: 0.207, mt: 30.137, st: 30.0, seedM: 11, seedS: 97 },
  { name: "126→120, +25ms jitter", mBpm: 126, sBpm: 120, jit: 25, mAnchor: 0.140, sAnchor: 0.019, mt: 72.610, st: 71.880, seedM: 5, seedS: 61 },
  { name: "128→128, +12ms jitter", mBpm: 128, sBpm: 128, jit: 12, mAnchor: 0.088, sAnchor: 0.260, mt: 15.500, st: 16.220, seedM: 23, seedS: 7 },
  { name: "120→122, +22ms jitter", mBpm: 120, sBpm: 122, jit: 22, mAnchor: 0.300, sAnchor: 0.044, mt: 95.250, st: 94.700, seedM: 44, seedS: 88 },
];

const OFFSET_TOL_MS = 10;   // plan: post-engage offset < 10ms
const IDEMP_TOL_MS = 0.5;   // repeat-engage must not move the slave

let allPass = true;
console.log("Beat-grid unification — engage alignment + idempotency");
console.log("=".repeat(74));
console.log("scenario                      | model   | offsetMs | repeatMoveMs | verdict");
console.log("-".repeat(74));

for (const sc of SCEN) {
  const master = mkTrack(sc.mBpm, sc.mAnchor, sc.jit, sc.seedM);
  const slave  = mkTrack(sc.sBpm, sc.sAnchor, sc.jit, sc.seedS);

  for (const model of ["REFINED", "LEGACY"]) {
    const engage = model === "REFINED" ? engageRefined : engageLegacy;
    // First engage.
    const st1 = engage(master, slave, sc.mt, sc.st);
    const offMs = residualMs(master, slave, sc.mt, st1);
    // Repeat engage from the landed position — how far does the slave move?
    const st2 = engage(master, slave, sc.mt, st1);
    const repeatMoveMs = Math.abs(st2 - st1) * 1000;

    const pass = offMs < OFFSET_TOL_MS && repeatMoveMs < IDEMP_TOL_MS;
    if (model === "REFINED" && !pass) allPass = false; // REFINED must pass
    const verdict = pass ? "PASS" : "FAIL";
    console.log(
      sc.name.padEnd(29) + " | " + model.padEnd(7) + " | " +
      offMs.toFixed(2).padStart(8) + " | " + repeatMoveMs.toFixed(2).padStart(12) + " | " + verdict
    );
  }
}

console.log("=".repeat(74));
console.log("REFINED (beatsv2): offset must be <" + OFFSET_TOL_MS + "ms AND repeat-move <" + IDEMP_TOL_MS + "ms.");
console.log("LEGACY shown for contrast — the off-grid + wander the plan diagnoses.");
console.log(allPass ? "\n✅ PASS — refined engage is on-grid and idempotent."
                    : "\n❌ FAIL — refined engage missed the tolerance.");
process.exit(allPass ? 0 : 1);
