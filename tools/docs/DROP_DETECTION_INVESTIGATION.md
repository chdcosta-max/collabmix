# Drop-Detection as Grid Validation — Investigation Report

Session: May 20, 2026. Follow-up to STRUCTURAL_KICK_IN_INVESTIGATION.md after the user reframed the hypothesis: drops align with bar-1 of 4-bar phrases, so detecting kick breakdowns → returns gives us a way to vote on the bar phase (which beat of the bar bar-1 should be) and correct off-by-N-beats failures.

## Verdict: PARTIAL CONFIRMATION. Validates well, narrow rescue band.

The hypothesis is correct enough to be useful but narrower than hoped. Practical safe gain: **+2 to +4 rescues** (72.1% → 72.8-73.5%). Combined with the Sub-cause B fix from STEP5_INVESTIGATION.md, ceiling could plausibly reach **+8-12** because most "off-by-N + residual-phase" tracks would land within tolerance once both fixes apply.

## What I built

`tools/bpm-test-harness/drop-detect-probe.mjs` + `drop-detect-worker.mjs`. Pure investigation, no production touched.

Algorithm:
1. Bandpass 40-100 Hz on the mono mix
2. 100 ms frame energy → smooth with 2-second box
3. Threshold = 40% × p70 of smoothed envelope (per-track, robust to drop peaks)
4. Find inactive runs ≥ 4 sec → these are breakdowns
5. First active frame after each breakdown = candidate drop
6. **Refinement (the key step):** snap the candidate to the earliest *analyzer-grid beat* within ±2 beats that has (a) substantial kick energy and (b) a ≥2× energy rise from the previous beat. This anchors the drop on the actual bar boundary rather than the threshold-crossing position (which lags by half the smoothing window).
7. For each snapped drop, compute beat-of-bar = `round((dropTime − anaBar1)/period) mod 4`
8. Vote: histogram across drops, dominant beat = candidate shift.
9. Voted shift = dominantBeat. If non-zero, new bar-1 = anaBar1 + dominantBeat × period.

## Strong validation signal on PASS tracks

```
Total tracks:                       272
With ≥1 drop event:                 271
With ≥1 breakdown ≥4s:              260
With ≥1 valid (on-beat) drop:       253
Confidence-gated (≥60% dom, ≥2 drops):  170
```

```
Validation on PASS tracks (confidence-gated):
  Total PASS conf-gated:              129
  Of those, voted shift = 0:           121  (93.8%)  ← algorithm validates
  Of those, voted shift ≠ 0:           8   (potential regressions)
```

**93.8% of currently-passing tracks vote shift = 0.** The algorithm correctly identifies that the bar phase is already aligned. This is strong evidence that the user's intuition is real: drops do align with bar-1 in most EDM tracks.

The 8 PASS-but-shift-non-zero tracks are the regression risk; we need to gate them out.

## Where the rescues live — 4 clean cases

In the off-by-N-beats failure cluster:

| Track | Truth | Ana | Period | Voted shift | New bar-1 | Δ truth |
|---|---|---|---|---|---|---|
| Shuttered (Original Mix) | 514 ms | 35 | 492 | 1β | 527 ms | 12.7 ms ✓ |
| White Moon (Alex O'Rion Remix) | 1025 ms | 35 | 500 | 2β | 1035 ms | 9.9 ms ✓ |
| Boundless Heart (Original Mix) | 513 ms | 30 | 488 | 1β | 518 ms | 4.7 ms ✓ |
| It Has To Be Like This | 1507 ms | 30 | 496 | 3β | 1518 ms | 10.5 ms ✓ |

For these the algorithm works as advertised: drops are detected, snapped to analyzer beats, voted with 100% confidence, and the shifted bar-1 lands within 13 ms of Rekordbox truth.

## Where the hypothesis breaks — three failure modes

### 1. Sub-cause B-class tracks: the BEAT phase itself is wrong (not just bar phase)

Example — Sunset on Mars: ana=386 ms, truth=25 ms. Diff = 361 ms ≈ 0.72 beats. NOT an integer-beat offset. The analyzer's beat grid is genuinely *misaligned* in phase, not just bar-phase.

My detector finds drops landing on bob=3 in the ana grid (because the ana grid is shifted 0.72 beats off the true grid). If I apply shift=3β, newBar1 lands 1.8 sec from truth — catastrophic regression.

This is the same Sub-cause B failure mode (envelope-peak / attack-band convention) covered in STEP5_INVESTIGATION.md. Drop-detection cannot fix it — drop detection assumes the beat grid's *period* and *phase-modulo-period* are both correct.

### 2. Tracks where drops are not on bob=0

7-8 currently-PASSing tracks (Forest Beast, Amuja, With You, Mr Pong, Mediterraneo, Mixolydyan, Solas, Won't Let Go) have drops that consistently land on bob 1, 2, or 3 of the ana grid — even though the ana grid agrees with Rekordbox truth (both anchor bar-1 near time 0). For these tracks the drop is musically *not on bar-1*; it lands on a different beat of the bar.

Could be tracks with:
- Drops triggered by snares/risers landing off the kick downbeat
- Phrase-1 starts on bob=0 but the "audible drop moment" is a fill landing on bob=2

Whatever the cause, my detector finds these and votes a non-zero shift, which would regress them.

### 3. Tracks the detector mis-times

Examples: Love Rhythm, Sunset on Mars, Juno Boy, Lost — all PASSed by the analyzer but my detector finds repeated drops on bob=3 with 100% confidence. Likely the detector is finding sub-bass loops or pad swells that aren't real kick returns. Without listening to each track, hard to distinguish from genuine drops.

## Gate sweep — finding a safe net-positive rule

```
Gate                                                              Resc / Reg /  Net  (+almost)
─────────────────────────────────────────────────────────────────────────────────────────────
A: conf≥0.6, drops≥2                                                  2 / 8 / -6   (5)
B: conf≥0.6, drops≥1                                                  4 / 14 / -10  (7)
C: conf=1.0, drops≥1                                                  4 / 7 / -3   (6)
D: conf=1.0, drops≥2                                                  2 / 1 / +1   (4)
L: conf=1.0, drops≥2, anaBar1<50ms                                    2 / 0 / +2   (3)  ← SAFE
M: conf=1.0, drops≥1, anaBar1<50ms, first drop>1s                     4 / 3 / +1   (4)
K: conf=1.0, drops≥2, frac<0.05, anaBar1<150ms                        2 / 1 / +1   (3)
```

`+almost` = additional FAILs within 50 ms (would pass with relaxed tolerance or a Sub-cause B fix in tandem).

**Best safe gate: Gate L** — ana_bar1 < 50 ms + confidence = 100% + ≥ 2 valid drops → **+2 rescues / 0 regressions**.

The anaBar1<50ms gate is the safety belt: it limits the rule to tracks where the analyzer's current bar-1 is near time-0 (the typical off-by-N case), which excludes most of the false-positive PASS regressions whose ana_bar1 is already at the correct mid-track position.

## Combined-with-Sub-cause B projection

Several FAIL tracks have newΔ in the 25-75 ms band (rescue would happen with a slightly relaxed tolerance or once Sub-cause B's residual phase error is fixed):

```
Tracks where grid-shift gets newΔ close but not within 20ms:
  Alraegadir          newΔ = 28.3 ms   (shift=3β correct, residual 28ms)
  Distortion Feelings newΔ = 25.4 ms   (shift=2β correct, residual 25ms)
  Silver Lake         newΔ = 36.8 ms   (shift=1β correct, residual 37ms)
  Evo (.mp3 + .m4a)   newΔ = 38-60 ms  (shift=1β correct)
  When Midnight Comes newΔ = 21.9 ms   (shift=2β correct, residual 22ms)
  Chad May 14.wav     newΔ = 54.6 ms   (shift=2β correct, residual 55ms)
  San Juan 2025       newΔ = 75.7 ms   (shift=2β correct, residual 76ms)
  Hips and Dips       newΔ = 24.8 ms   (shift=1β correct, residual 25ms)
  Melodic Inspiration newΔ = 364 ms    (off — half-beat issue)
```

If STEP5 Approach A (envelope-peak walk-forward) lands and reduces residual phase error on these tracks by ~20-30 ms, **6-8 of them would join the rescue list**. The two fixes are orthogonal and compound.

## Edge-case handling

- **Tracks without breakdowns (12/272):** No drops produced → gate doesn't fire → no-op. Safe.
- **Multiple breakdowns:** Each contributes a drop to the vote. Helpful — more drops → more confidence → higher chance of crossing the drops≥2 threshold.
- **Sidechained tracks where kick band never fully drops:** Threshold = 40% × p70. If sidechain only ducks 20-30%, no breakdown detected → no shift. Safe.
- **Tracks where breakdown ends gradually:** The smoothed-envelope threshold crossing is by definition the moment the *smoothed* energy crosses 40% × p70 — for a gradual fade-in, this lags substantially. The beat-snap refinement to "first beat with 2× energy rise" handles this by finding the actual transient when the kick re-enters at full velocity.
- **Tracks starting kick-active (no opening breakdown):** Handled via the "implicit start drop at t=0" provision (commented in the worker but currently filtered by `t < 0.5` skip — see code). PASS rate on these tracks would not benefit either way.

## Predicted impact summary

| Approach | Rescued | Regressed | Net | Effort |
|---|---|---|---|---|
| Drop-detection alone, safe gate (L) | 2 | 0 | +2 | 3-4 hrs |
| Drop-detection alone, looser gate (M) | 4 | 3 | +1 | 3-4 hrs |
| Drop-detection + STEP5 Approach A (Sub-cause B fix) | 8-12 | 0-3 | +5 to +10 | 8-12 hrs combined |

**Single-fix delivered ceiling: 72.1% → 72.8%.** The hypothesis works but the rescue band is narrow because most off-by-N failures also carry a small residual phase error that pushes them just outside tolerance.

**Combined-fix ceiling: 72.1% → ~76%.** Realistic and worth pursuing if Sub-cause B is tackled in the same session.

## Why the user's intuition is mostly right but doesn't translate to big wins

The intuition that drops align with bar-1 is musically correct and confirmed by the 93.8% validation rate on PASS tracks. But:

1. **Most tracks (~76%) don't have an off-by-N-beats problem** — for them, bar phase is already correct, and drop voting just confirms what we already have.
2. **Of the ~24 tracks that DO have an off-by-N error**, many also have a Sub-cause B phase error layered on. Fix one without the other, and you still fail tolerance.
3. **A small subset of tracks have drops that don't land on bob=0** — these are the regression risk if the gate is too loose.

The leverage point is bigger if combined with Sub-cause B fix. Standalone it's small.

## Proposed algorithm (if we want the +2)

```js
// Post-processing pass, runs after existing walk-back / sampler-snap.
// All inputs already available in the analyzer's worker.
function maybeShiftBarPhase(dpBeatsFloat, beatPeriodSec, anaBar1, mono, sr) {
  // 1. detectDrops(mono, sr, { anaBar1, anaPeriod: beatPeriodSec })
  // 2. For each detected drop snapped to a beat,
  //    bob = round((dropTime − anaBar1)/beatPeriodSec) mod 4
  // 3. Vote → dominantBeat
  // 4. Apply IFF:
  //      - anaBar1 < 0.050  (we're in off-by-N territory)
  //      - ≥ 2 valid drops (frac < 0.20)
  //      - 100% of valid drops on dominantBeat (conf=1.0)
  //      - dominantBeat !== 0
  // 5. newBar1 = anaBar1 + dominantBeat × beatPeriodSec
  //    Reflect into analyzer's beatPhaseFrac / beatPhaseSec outputs.
  // 6. Optionally: shift dpBeats indices forward by dominantBeat (so beat 0
  //    of the array is the new bar-1).
}
```

Estimated implementation: **3-4 hours** including the threshold sweep, integration into `src/bpm-worker-source.js`, and regression-snapshot verification.

## Recommendation

**Implement alongside STEP5 Approach A**, not alone. Combined effort 8-12 hours, projected +6 to +10 PASS gain (72.1% → 75-76%), 0-3 regressions.

If implementing alone, only the safe gate (Gate L) — small win but defensible.

If neither is implemented, the algorithm is still valuable as a **validation tool**: it confirms in 93.8% of cases that the analyzer's bar phase is correct, which de-risks any future bar-phase changes. Keep the probe runnable for that purpose.

## Artifacts preserved

- `tools/bpm-test-harness/drop-detect-probe.mjs` — full sweep + reporting
- `tools/bpm-test-harness/drop-detect-worker.mjs` — per-thread DSP + beat-snap refinement
- `tools/bpm-test-harness/snapshots/drop-detect-full.json` — 272-track results
- `tools/docs/DROP_DETECTION_INVESTIGATION.md` — this document

All re-runnable. No production code changes were made.
