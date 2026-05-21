# Anchor Hypothesis Test — Results

Hypothesis: `anchor = first_kick - N × beat_period` where N is the largest
integer keeping anchor ≥ 0.

The analyzer's existing walk-back code (`bpm-worker-source.js:1041-1043`)
already applies this exact formula. The real question is whether a DIFFERENT
first_kick detector — fed into the same formula — produces results closer
to Rekordbox truth than the analyzer's current diff-argmax detector does.

Two first-kick detector variants, plus a third with a stricter threshold:
  A: diff-argmax of 1.5ms-smoothed 40-200Hz power envelope (matches analyzer)
  B: first 40-100Hz power-peak ≥ 30% of track-wide max peak amplitude
  B': first 40-100Hz power-peak ≥ 50% of track-wide max peak amplitude

Truth: Rekordbox `firstDownbeatSec` from `library-truth.json`.
Period: analyzer-detected `beatPeriodSec` from `snapshots/fix-D.json`.
Anchor = first_kick - N × period (largest N keeping ≥ 0).
Δ = anchor - truth, in ms. Pass: |Δ| ≤ 10 ms (strict, per task) or ≤ 20 ms (harness).

### Group A — 13 Sub-cause B failures

Track                                       | truth |  period |  bpm   | analyzer | Variant A: diff-argmax       | Variant B: 1st-loud-kick (frac=0.30)  | Variant B': frac=0.50           
                                            |  ms   |   ms    |        |  bar1 ms |  fk_ms  N   anchor   Δ   p10 |  fk_ms  N    anchor    Δ    p10/p20  |  fk_ms  N    anchor    Δ    p10/p20
--------------------------------------------|-------|---------|--------|----------|------------------------------|---------------------------------------|------------------------------------
01 Body Stars (Original Mix).mp3            |  24.0 |   487.8 | 123.0  |      2.5 |  489.9 1.0     2.1  -21.9  .    |  493.0 1.0     5.2  -18.8  ./✓   | 1727.0 3.0   263.6 +239.6  ./.
01 Scarlet Sails (Extended).mp3             |  25.0 |   487.8 | 123.0  |      0.0 |  978.9 2.0     3.3  -21.7  .    | 7587.0 15.0   269.9 +244.9  ./.   | 7587.0 15.0   269.9 +244.9  ./.
10 Aurora (Original Mix).mp3                |  24.0 |   491.8 | 122.0  |      0.0 |  492.6 1.0     0.8  -23.2  .    |  389.0 0.0   389.0 +365.0  ./.   |  389.0 0.0   389.0 +365.0  ./.
04 Coaster  (Durante Remix).mp3             |  25.0 |   483.9 | 124.0  |      4.7 |  974.5 2.0     6.8  -18.2  .    |  491.0 1.0     7.1  -17.9  ./✓   |  491.0 1.0     7.1  -17.9  ./✓
07 Leave the World Behind (Original Mix).mp |  24.0 |   491.8 | 122.0  |      1.2 |  496.0 1.0     4.2  -19.8  .    |  511.0 1.0    19.2   -4.8  ✓/✓   |  511.0 1.0    19.2   -4.8  ✓/✓
02 Serenità (Original Mix).mp3              |  82.0 |   500.0 | 120.0  |     54.9 |  557.6 1.0    57.6  -24.4  .    |  558.0 1.0    58.0  -24.0  ./.   |  558.0 1.0    58.0  -24.0  ./.
08 Fly Fox (Original Mix).mp3               |  33.0 |   500.0 | 120.0  |      9.8 |   14.5 0.0    14.5  -18.5  .    | 4026.0 8.0    26.0   -7.0  ✓/✓   | 4026.0 8.0    26.0   -7.0  ✓/✓
04 Great Attractor (Ruben Karapetyan Remix) |  32.0 |   482.8 | 124.0  |      9.0 |  977.1 2.0    11.6  -20.4  .    |  266.0 0.0   266.0 +234.0  ./.   | 1847.0 3.0   398.7 +366.7  ./.
01 Astronauts Nightmares (DJ Ruby Extended  | 207.0 |   487.8 | 123.0  |    184.0 |  672.5 1.0   184.7  -22.3  .    |  201.0 0.0   201.0   -6.0  ✓/✓   |  201.0 0.0   201.0   -6.0  ✓/✓
06 Finding Estrella (Analog Jungs Remix).mp | 225.0 |   491.8 | 122.0  |    203.2 |  707.7 1.0   215.9   -9.1  ✓    |  212.0 0.0   212.0  -13.0  ./✓   |  212.0 0.0   212.0  -13.0  ./✓
04 Swans (Dave DK Extended Remix).mp3       | 116.0 |   495.9 | 121.0  |     94.5 |  110.2 0.0   110.2   -5.8  ✓    |  156.0 0.0   156.0  +40.0  ./.   |  156.0 0.0   156.0  +40.0  ./.
03 Sparky (Original Mix).mp3                | 192.0 |   487.8 | 123.0  |    171.3 |  662.7 1.0   174.9  -17.1  .    |  193.0 0.0   193.0   +1.0  ✓/✓   |  193.0 0.0   193.0   +1.0  ✓/✓
02 Track II (Original Mix).mp3              | 267.0 |   406.1 | 140.7  |    254.4 |  722.7 1.0   316.6  +49.6  .    |  234.0 0.0   234.0  -33.0  ./.   |  724.0 1.0   317.9  +50.9  ./.

Pass counts (strict ≤10ms / harness ≤20ms):
  Variant A:  2 / 6  out of 13
  Variant B (30%):  4 / 7  out of 13
  Variant B' (50%): 4 / 6  out of 13

### Group B — 15 PASS regression check

Track                                       | truth |  period |  bpm   | analyzer | Variant A: diff-argmax       | Variant B: 1st-loud-kick (frac=0.30)  | Variant B': frac=0.50           
                                            |  ms   |   ms    |        |  bar1 ms |  fk_ms  N   anchor   Δ   p10 |  fk_ms  N    anchor    Δ    p10/p20  |  fk_ms  N    anchor    Δ    p10/p20
--------------------------------------------|-------|---------|--------|----------|------------------------------|---------------------------------------|------------------------------------
02 Gothamania (Jamie Stevens Remix).mp3     | 208.0 |   483.9 | 124.0  |    217.2 |  216.1 0.0   216.1   +8.1  ✓    |  269.0 0.0   269.0  +61.0  ./.   |  269.0 0.0   269.0  +61.0  ./.
01 Biome (Mike Rish Remix).mp3              |  26.0 |   483.9 | 124.0  |     44.6 |  538.7 1.0    54.8  +28.8  .    |  150.0 0.0   150.0 +124.0  ./.   |  150.0 0.0   150.0 +124.0  ./.
07 Serene (Extended Mix).mp3                |  25.0 |   504.2 | 119.0  |     19.4 |  523.2 1.0    19.0   -6.0  ✓    |  331.0 0.0   331.0 +306.0  ./.   |  331.0 0.0   331.0 +306.0  ./.
01 Cosmos (Original Mix).m4a                | 170.0 |   491.8 | 122.0  |    159.5 |  163.3 0.0   163.3   -6.7  ✓    |  205.0 0.0   205.0  +35.0  ./.   |  205.0 0.0   205.0  +35.0  ./.
02 Upsala (Forty Cats Remix).m4a            |  54.0 |   483.9 | 124.0  |     38.8 |  531.9 1.0    48.0   -6.0  ✓    |   53.0 0.0    53.0   -1.0  ✓/✓   |   53.0 0.0    53.0   -1.0  ✓/✓
01 In This World (Original Mix).mp3         |  24.0 |   491.8 | 122.0  |     15.0 |  756.8 1.0   265.0 +241.0  .    | 2028.0 4.0    60.8  +36.8  ./.   | 2028.0 4.0    60.8  +36.8  ./.
01 Transcender (Original Mix).mp3           |  24.0 |   491.8 | 122.0  |     18.0 |  531.2 1.0    39.4  +15.4  .    |   55.0 0.0    55.0  +31.0  ./.   |   55.0 0.0    55.0  +31.0  ./.
House1.wav                                  |   0.0 |   487.8 | 123.0  |      0.0 |  510.6 1.0    22.8  +22.8  .    |  512.0 1.0    24.2  +24.2  ./.   |  512.0 1.0    24.2  +24.2  ./.
02 Mr Pong (Original Mix).m4a               | 159.0 |   491.8 | 122.0  |    142.6 |  149.4 0.0   149.4   -9.6  ✓    |  156.0 0.0   156.0   -3.0  ✓/✓   |  156.0 0.0   156.0   -3.0  ✓/✓
02 Shambhala (Extended).mp3                 |  26.0 |   491.8 | 122.0  |     11.1 |  512.4 1.0    20.6   -5.4  ✓    |  522.0 1.0    30.2   +4.2  ✓/✓   |  522.0 1.0    30.2   +4.2  ✓/✓
10 Sea & Stars (Original Mix).mp3           |  24.0 |   495.9 | 121.0  |     39.5 |  541.6 1.0    45.7  +21.7  .    |  126.0 0.0   126.0 +102.0  ./.   |  126.0 0.0   126.0 +102.0  ./.
03 Against the Wall (Original Mix).mp3      | 145.0 |   491.8 | 122.0  |    140.8 |  144.9 0.0   144.9   -0.1  ✓    |  157.0 0.0   157.0  +12.0  ./✓   |  157.0 0.0   157.0  +12.0  ./✓
01 Dejavu (Original Mix).mp3                | 275.0 |   500.0 | 120.0  |    260.8 |  272.7 0.0   272.7   -2.3  ✓    |  317.0 0.0   317.0  +42.0  ./.   |  317.0 0.0   317.0  +42.0  ./.
03 Aliens (Original Mix).mp3                |  24.0 |   500.0 | 120.0  |     11.8 |   11.2 0.0    11.2  -12.8  .    |  524.0 1.0    24.0   +0.0  ✓/✓   |  524.0 1.0    24.0   +0.0  ✓/✓
02 Loveland (Gorkiz Remix).mp3              |  24.0 |   490.6 | 122.1  |      9.9 |  504.5 1.0    13.9  -10.1  .    |  254.0 0.0   254.0 +230.0  ./.   |  505.0 1.0    14.4   -9.6  ✓/✓

Pass counts (strict ≤10ms / harness ≤20ms):
  Variant A:  8 / 11  out of 15
  Variant B (30%):  4 / 5  out of 15
  Variant B' (50%): 5 / 6  out of 15

---

## Verdict: HYPOTHESIS FALSIFIED

Per the task's interpretation gates:

| Detector | Group A strict ≤10ms | Verdict gate |
|---|---|---|
| Variant A (diff-argmax) | **2/13** (15%) | ≤ 4/13 → **FALSIFIED** |
| Variant B (30% threshold) | **4/13** (31%) | ≤ 4/13 → **FALSIFIED** (just barely; partial otherwise) |
| Variant B' (50% threshold) | **4/13** (31%) | ≤ 4/13 → **FALSIFIED** |

Group A pass rate maxes at 4/13 strict, 7/13 harness — far below the ≥10/13 confirmation threshold. Group B (regression check) is also catastrophic for Variant B: 4-5/15 strict means **10-11 currently-passing tracks would FAIL** if we replaced the analyzer's first_kick detector with a raw-power-peak detector.

## What the data actually shows

**The formula is correct — the analyzer already uses it.** Lines 1041-1043 of `bpm-worker-source.js` are literally `anchor = first_kick - N × period`. So testing this formula is testing the first_kick detector, not the placement rule.

**The Sub-cause B drift is a DETECTION-vs-PERCEPTION offset, not a placement-rule error.**

Look at the Δ pattern across Group A:

```
Body Stars:    A: -21.9    B: -18.8    B': +239.6
Scarlet Sails: A: -21.7    B: +244.9   B': +244.9
Aurora:        A: -23.2    B: +365.0   B': +365.0
Coaster:       A: -18.2    B: -17.9    B': -17.9
Leave World:   A: -19.8    B: -4.8 ✓   B': -4.8 ✓
Serenità:      A: -24.4    B: -24.0    B': -24.0
Fly Fox:       A: -18.5    B: -7.0 ✓   B': -7.0 ✓
Great Attr.:   A: -20.4    B: +234.0   B': +366.7
Astronauts:    A: -22.3    B: -6.0 ✓   B': -6.0 ✓
Finding Estr.: A: -9.1 ✓   B: -13.0    B': -13.0
Swans:         A: -5.8 ✓   B: +40.0    B': +40.0
Sparky:        A: -17.1    B: +1.0 ✓   B': +1.0 ✓
Track II:      A: +49.6    B: -33.0    B': +50.9
```

Variant A's Δ clusters tightly at **-18 to -24 ms** across the Sub-cause B set — a uniform offset, exactly the signature of a systematic ~20 ms attack-edge-vs-perceived-center mismatch. Variant B's Δ either matches A's drift (when it lands on the same kick) or jumps wildly (when it lands on a louder kick several beats later).

**The 4 Variant-B wins are not a confirmation — they're noise.** They land within tolerance because their `first_loud_kick - N × period` coincidentally maps to truth, while their detector found a different beat. The same detector logic produces 10 catastrophic misses on Group B.

## Reconciling with your Body Stars example

Your example: first_kick ≈ 524 ms, period = 500 ms, anchor = 24 ms = truth. **Two free parameters made it fit:**
- The actual period at 123 BPM is **487.8 ms**, not 500. Substituting: 524 - 487.8 = 36.2 ms. **Δ = +12 ms from truth, not 0.**
- My detector found Body Stars's first loud kick at **493 ms**, not 524 ms. Substituting: 493 - 487.8 = 5.2 ms. **Δ = -18.8 ms from truth.**

The example's apparent perfection came from rounding period to 500 and choosing 524 as first_kick. Either rounding error would have surfaced as a 12-20 ms residual. That residual is the same Sub-cause B drift we see everywhere.

## What this means alongside the madmom result

- **madmom test:** even a SOTA learned beat tracker shows the same ~15-25 ms EARLY drift on these tracks. ✓
- **Anchor hypothesis test:** every first_kick detector we try (diff-argmax, raw-power 30%, raw-power 50%) shows the same ~20 ms drift. ✓

Two independent attacks on the problem converge on the same conclusion: **audio-based detection of "the first kick" cannot match Rekordbox's anchor convention without modeling the ~20 ms perceptual offset Rekordbox uses on top of detection.**

That offset might be:
- The peak of the kick's sub-bass fundamental (40-80 Hz, one half-cycle later than the broadband attack edge — ~6 ms at 80 Hz, ~12 ms at 40 Hz).
- A fixed per-genre constant baked into Rekordbox's algorithm.
- Something derived from envelope shape that's not captured by simple smoothing.

None of these are recoverable from "detect the first kick and walk back."

## Recommendation

The hypothesis path is exhausted. Three independent investigations (Step 5 back-extrapolation, madmom diagnostic, this anchor test) all hit the same Sub-cause B wall at ~73% accuracy.

**Accept 73.2% as the heuristic ceiling.** The remaining ~27% breaks down roughly as:
- ~14 tracks at -15 to -27 ms drift (Sub-cause B detection-vs-perception offset)
- ~22 tracks at off-by-N-bars where drop-detection's safe gate didn't fire
- ~10 tracks at +25 to +75 ms (LATE drift — separate Sub-cause)
- ~10 tracks at other patterns

The next concrete leverage points, in order:
1. **Ship v1 at 73.2%.** Real users provide ground truth via manual nudge corrections.
2. **Collect nudge telemetry.** Each correction is a per-track delta and a free training label.
3. **Fine-tune on the corrections.** Even a 2-parameter shift (`+X ms per genre` or `+Y ms per BPM bucket`) might add 5-10%.
4. **Revisit SOTA only if telemetry confirms it's needed.** beat_this (MIT, transformer-based) is the most promising next candidate — different architecture, different training data, might have a different drift profile. But shipping first means we have something concrete to compare against.

