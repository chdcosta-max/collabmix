# Step 5 Investigation — Sub-cause B Back-Extrapolation (UNRESOLVED)

Session: May 19-20, 2026. Picks up after Step 3 (earliest-peak, 71%) and Step 4 (sampler heuristic, 72.1%). The plan was to land Sub-cause B as a back-extrapolation fix targeting the ~12 tracks with -20 to -27ms drift (Body Stars, Hymn Fern, etc.). It did not work and we stopped before committing anything.

## Original hypothesis

From the deep investigation report:
> Sub-cause B (back-extrapolation from confident beat)
> - More delicate: don't trust dpBeats[0], extrapolate from dpBeats[4 or 8]
> - Validate pattern across [N, 32]
> - Expected gain: +15 tracks → ~77% accuracy

The model: our DP's beat 0 may have latched onto a pre-roll transient or filter-startup artifact. If we extrapolate backward from a confident later beat — `bar1 = dpBeatsFloat[N] - N × beatPeriodSec` — and the result differs meaningfully from the current walk-back, the back-extrap is more reliable.

Trigger condition designed before probing:
- `dpBeats.length > 8`, `finalPeriod > 0`, not a sampler
- Disagreement between back-extrap and current bar-1 > 15ms
- Used `finalPeriod` (BPM-snapped) for the extrapolation

## What the probe revealed

Temporarily logged `dpBeatsFloat[0..15]` per track via `[STEP5-PROBE]` line in `src/bpm-worker-source.js`. Ran on three Sub-cause B candidates. Reverted before commit.

**Body Stars** (truth=24ms, analyzer=2.22ms, Δ=-22ms):
```
period_mean=0.488039  finalPeriod=0.487805
bF0..15ms = 2.22, 489.86, 977.85, 1465.46, 1953.46, 2441.05, 2929.05, 3419.17,
            3904.68, 4392.28, 4880.37, 5370.38, 5855.91, 6351.07, 6831.59, 7319.11
```
Interval beat[0]→beat[1] = 487.64ms ≈ period. Inter-beat spacing across all 16 captured beats is ~488ms. **The DP grid is internally consistent.** All beats are uniformly shifted ~22ms earlier than Rekordbox's grid (24, 511.805, 999.61, ...).

**Hymn Of The Fern** (truth=47ms, analyzer=26.76ms, Δ=-20ms):
```
period_mean=0.491811  finalPeriod=0.491803
bF0..15ms = 26.76, 523.01, 1010.37, 1508.66, 1993.97, 2490.23, 2977.58, 3475.88,
            3961.19, 4458.57, 4944.80, 5443.09, 5928.40, 6425.79, 6912.01, 7410.30
```
Intervals vary slightly (487-498ms, mean ≈ 492). Beat 8 - 8×period_mean ≈ beat 0 within 0.5ms. **Same pattern — internally consistent grid, uniformly shifted.**

**Phase Sync** (post-Step 3, currently PASS at Δ=14.8ms):
```
period_mean=0.500502  finalPeriod=0.500000
bF0..15ms = 38.84, 550.55, 1038.78, 1550.56, 2038.65, 2538.71, 3044.36, 3538.72, ...
```
Intervals more variable (488-512ms). Still consistent enough that back-extrap from beat[8] ≈ beat[0].

## Why back-extrap from beat[N] does not work

For an internally-consistent grid: `dpBeatsFloat[N] ≈ dpBeatsFloat[0] + N × period_mean`. Substituting:
```
back-extrap = dpBeatsFloat[N] - N × finalPeriod
            = dpBeatsFloat[0] + N × (period_mean - finalPeriod)
```
The "disagreement" is `N × (period_mean - finalPeriod)`. For Body Stars: `delta = 0.234ms/beat`. Over N=8: only 1.87ms — below the 15ms gate. Over N=64: 14.9ms — still below. Over N=100: 23.4ms — would trigger.

So the disagreement only manifests at large N, where the cumulative effect of `period_mean - finalPeriod` exceeds the threshold. The problem: at large N, single-beat refinement noise also accumulates, and the trigger becomes noisy.

## N=4 to 15 empirical sweep (predict-backextrap.mjs)

Across all 272 tracks, simulated what overriding the walk-back with back-extrap would do, by N ∈ {4, 8} and threshold ∈ {10, 15, 20, 25, 30}ms. (Tested both `period_mean` and `finalPeriod`.)

```
period basis: finalPeriod (BPM-snapped)
N=4, threshold=15ms:  +7 fixed / -15 regressed (net -8)
N=4, threshold=30ms:  +5 fixed /  -7 regressed (net -2)
N=8, threshold=15ms:  +9 fixed / -15 regressed (net -6)
N=8, threshold=20ms:  +7 fixed / -12 regressed (net -5)
N=8, threshold=25ms:  +6 fixed /  -8 regressed (net -2)
N=8, threshold=30ms:  +6 fixed /  -5 regressed (net +1)
```

`period_mean` sweep had similar results. No combination beats the 5-regression gate while producing meaningful fixes. The "fixes" cap at 6-9, while regressions stay at 5-15. Most disagreements between methods produce *worse* anchors, not better ones.

N=16 and N=32 returned 0 fixes / 0 regressions in the original probe because the probe only logged 16 beats — beat[16] and beat[32] weren't captured.

## N=32/64/128 sweep — started, killed before completion

Extended the probe to dump dpBeatsFloat at indices `[0, 1, 2, 4, 8, 16, 32, 64, 128, 256]`. Re-ran the predict script. Killed mid-run because:
- The N=4-15 data already shows back-extrap chooses between "near beat[0]" and "wrap-around junk" — not a credible bar-1 candidate.
- Large N amplifies single-beat refinement noise (each beat is ±50ms-refinable independently), making the back-extrap output noisier, not cleaner.
- Theoretical math: for Body Stars, N=100 back-extrap with finalPeriod = 21.5ms, Δfd 2.5ms — fixes it. But this is a single-track lucky alignment; the same N=100 applied to tracks where BPM-snap was conservative would regress them. The earlier sweep already showed the regression-to-fix ratio is unfavorable.

## What Rekordbox is doing differently — hypotheses for next session

Our analyzer detects each kick at the **argmax of dE/dt** (steepest slope of the smoothed-power derivative — mid-attack). Rekordbox places beats ~20ms later on these tracks. Possible Rekordbox conventions:

1. **Envelope-peak detection.** Walk *forward* from argmax(dE/dt) to where the smoothed-power envelope peaks. Adds ~10-20ms (natural attack-to-peak in a kick body).

2. **Sub-bass phase alignment.** Lock to the zero-crossing or peak of the kick's sub-bass fundamental (40-80 Hz sinusoid). Kicks have a clean sub-bass cycle ~12.5ms long (at 80 Hz) — phase alignment would systematically pick a position later than the attack onset.

3. **Pre-roll/intro skipping.** Rekordbox may explicitly detect and skip very-early transients that don't fit a regular bar pattern across the first 16-32 beats. For Body Stars, the kick at 2.2ms could be flagged as anacrusis if the rest of the grid suggests bar-1 is at 24ms.

4. **Per-beat snap to a master grid.** Once tempo is locked, beats may be quantized to the nearest "musical" grid position rather than the locally-detected onset peak.

5. **Different filter / band convention.** Rekordbox might emphasize 60-80 Hz body (not 40-200 Hz like us). The body peaks slightly later than the broadband attack edge.

## Alternative approaches to investigate tomorrow

In rough priority order (most likely to land within the 5-regression gate):

**A. Beat-0-only forward walk to envelope peak (5-7 hrs)**
After argmax-of-dE/dt finds the steepest-slope point, walk forward on the smoothed power envelope until it stops rising. The envelope peak is ~10-20ms later. Only apply to beat 0 (to avoid breaking the 196 PASS bulk). Predicted: catches Body Stars / Hymn Fern (analyzer EARLY by 20ms) without affecting tracks where our current convention is already correct.

**B. Anacrusis detection (8-12 hrs)**
After DP completes, scan the first 16-32 beats. If beat[0] is at an *outlier* position (interval beat[0]→beat[1] differs from period_mean by > 5%), suspect anacrusis. Drop beat[0] and re-anchor from beat[1]. Detection has to handle the case where beat[0] is legitimately the bar-1 kick (most tracks).

**C. Sub-bass phase-alignment refinement (10-15 hrs)**
Replace the broadband (40-200Hz) refinement with a sub-bass (40-80 Hz) phase tracker for beat 0 only. The peak of the sub-bass fundamental is the perceived downbeat position — closer to what Rekordbox seems to use.

**D. Two-pass refinement (15-20 hrs)**
First pass: place beats with current method. Second pass: shift every beat by a learned offset (per-track median of envelope-peak offset from argmax-of-dE/dt across all beats). The shift would be ~20ms for Body Stars-class tracks and ~0ms for tracks where current method is correct.

**E. Accept 72.1% and move on**
Cumulative Sub-cause B failures are ~12 tracks. If alternatives A-D all fail the gate, the remaining ceiling without ML is around 72-75%. Phase 1-3 dormant code (off-beat phase locks, Class 3) is a separate ~+20 track potential gain (8-15 hrs).

## Artifacts preserved

- `tools/bpm-test-harness/predict-backextrap.mjs` — diagnostic that runs the analyzer on every manifest track, extracts `[STEP5-PROBE]` log lines, and sweeps `(N, threshold)` combinations to predict the impact of any candidate back-extrap rule. Useful again if/when we revisit. Requires the `[STEP5-PROBE]` worker logging to be re-enabled (currently removed from src/bpm-worker-source.js as of the wrap-up).
- This document.

## Status going into next session

- Worker code reverted to `d024f2a` clean state (Step 4 sampler heuristic committed).
- Harness is parallel (`485f470`), 5.4× faster than the original sequential — full library runs in ~3 minutes.
- 72.1% accuracy on 272-track Rekordbox library.
- No commits made for Step 5.

Recommended next move: try Approach A (beat-0-only forward walk to envelope peak). Cheapest, most direct, narrowest blast radius. Same shape as Step 3 (beat 0 only, single-knob threshold), which lands cleanly under the gate.
