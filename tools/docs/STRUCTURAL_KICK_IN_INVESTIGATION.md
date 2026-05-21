# Structural Kick-In Hypothesis — Investigation Report

Session: May 20, 2026. Investigates the user's hypothesis that Rekordbox places bar-1 at the first sustained kick-in after a kickless intro section, not at the first audio transient.

## Verdict: REJECTED for the bulk hypothesis, PARTIAL for one narrow subclass.

The hypothesis does not explain the dominant FAIL clusters and would not produce a "72% → 85%" leap. Best-case realistic gain is **+3 to +5 tracks** under a tightly-gated rule (72.1% → 73.2-74.0%).

## What I built

`tools/bpm-test-harness/kick-in-probe.mjs` (+ `kick-in-worker.mjs`, `kick-in-debug.mjs`).
Pure-investigation tool. Read-only. Does not touch production code.

Algorithm: decode → bandpass 40-100 Hz → 25 ms frame energy → smooth → peak-pick → drop low-amplitude peaks (<30% of median peak) → find first peak that begins a regular run of ≥4 peaks with inter-peak CV < 0.30 within 1.6 s.

## Comparative table — 10 tracks

```
name                                              truth    anlyz   kickIn    Δana   ΔkIn   status
01 Body Stars (Original Mix).mp3                   24.0      2.2  16845.0   -21.8 +16821  FAIL
02 Hymn Of The Fern (Original Mix).mp3             47.0     26.8  31545.0   -20.2 +31498  FAIL
01 Phase Sync (Original Mix).mp3                   24.0     38.8    545.0   +14.8   +521  PASS
01 Scarlet Sails (Extended).mp3                    25.0      0.0  63420.0   -25.0 +63395  FAIL
10 Aurora (Original Mix).mp3                       24.0      0.0  24370.0   -24.0 +24346  FAIL
01 Back In The Days (Original Mix).mp3             25.0     69.1  62695.0   +44.1 +62670  FAIL
01 Just (Patrice Baumel Remix).mp3                 24.0     99.8  92795.0   +75.8 +92771  FAIL
02 It Has To Be Like This (Original Mix).mp3     1507.0     29.9   1495.0 -1477.1    -12  FAIL
01 Distortion Feelings (Original Mix).mp3        1009.0      0.0  32495.0 -1009.0 +31486  FAIL
NO1 - Elements.wav                               1966.0    119.7  31495.0 -1846.3 +29529  FAIL
```

Only `It Has To Be Like This` (a clean off-by-3-beats failure) becomes a true rescue. Everywhere else, kick-in is wildly wrong because the detector picks the loudest drop deep inside the track, not the bar-1 location Rekordbox uses.

## Body Stars debug — why the hypothesis is wrong for Sub-cause B

Truth = 24 ms. Analyzer = 2.22 ms. The hypothesis predicted kick-in should be near 24 ms.
What's actually there in the 40-100 Hz band:
```
First 5 peaks: t = 500, 750, 1000, 1225, 1475 ms  (all at 0.04-0.08× median peak amp)
```
There is **no kick-band content** at 24 ms. The first detectable pulse is a low-amplitude sub-bass eighth-note pattern starting at 500 ms. Rekordbox is anchoring bar-1 to 24 ms anyway — i.e., **to the implicit bar grid even when the kick band is empty**.

Conclusion: for the entire Sub-cause B cluster (Body Stars, Hymn Fern, Scarlet Sails, Aurora, Coaster, Leave The World, Serenità, Fly Fox, Great Attractor, Astronauts Nightmares, Finding Estrella, Swans, Sparky, Track II — 14 tracks at Δ = -12 to -27 ms), the user's hypothesis predicts the *wrong* direction. Rekordbox places bar-1 *earlier*, not later, than our analyzer.

The 20 ms drift on those tracks is something else — envelope-peak / attack-band convention, as proposed in `STEP5_INVESTIGATION.md` Approach A.

## Full-library statistics (272 tracks)

```
Total tracks:                   272
Successfully probed:            268 (4 decode failures)
Tracks with "kickless intro"
  (no 40-100Hz peaks > noise
   floor for ≥800ms):           61   (22.4%)
Tracks with NO kickless gap:    207  (77.2%)

Within ±20ms RAW of Rekordbox truth:
  current analyzer:             195/268  (72.8%)
  first-transient detector:      34/268  (12.7%)
  structural kick-in detector:   33/268  (12.3%)

If we naively replaced analyzer output with kick-in:
  RESCUED  (FAIL → PASS):        10
  REGRESSED (PASS → FAIL):      122
  Net:                          -112   (catastrophic)
```

`structural kick-in` matches Rekordbox on only 12% of tracks. It's not a generalizable bar-1 source.

## Currently-passing tracks — does kick-in agree?

Among the 193 currently-PASSing tracks:
- 12.4% have kick-in within 20 ms of truth
- 36.8% within 100 ms
- **86.5%** have kick-in landing on a beat (frac-of-period < 0.15) — i.e., the detector is finding beats, just usually a *later* beat than bar-1

This is consistent with structural kick-in being "first big drop", which in standard EDM is N bars after bar-1.

## Gated replacement — sweep of candidate rules

Apply kick-in only when conditions are met; keep analyzer output otherwise.

```
Gate                                                          rescued  regressed   net
─────────────────────────────────────────────────────────────────────────────────────
B: kickless > 800ms AND status=FAIL                                3          0    +3
D: kickless > 1000ms AND offset > 1.5β                             2          0    +2
F: kickless > 800ms + offset > 1β + on-beat (frac<0.15) + FAIL     3          0    +3
G: kickless > 800ms + offset > 1.5β + on-beat (frac<0.15) + FAIL   3          0    +3
I: kickless > 500ms + offset > 1.5β + on-beat (frac<0.10) + FAIL   3          0    +3
H: on-beat + kickless > 800ms (no FAIL gate)                       3         16   -13
```

Best gates ceiling at **+3 net** for THIS detector. No regressions when properly gated. The three rescues:
- `When Midnight Comes (Alex O'Rion Remix)` — truth 1033, ana 55, kickIn 1045 (within 12 ms)
- `It Has To Be Like This (Original Mix)`  — truth 1507, ana 30, kickIn 1495 (within 12 ms)
- `May San Juan Mix 2026`                   — truth 958,  ana 0,  kickIn 970  (within 12 ms)

## The off-by-N-beats cluster — where the hypothesis CAN help

Pulled the 24 FAIL tracks whose truth is > 500 ms (the "off-by-N-beats" cluster — analyzer anchors near 0 while Rekordbox's bar-1 is 0.5-2 s in).

```
Of 24 off-by-N-beats failures:
  kick-in within  20 ms RAW of truth:   4  (Shuttered, May San Juan, ItHasToBe, WhenMidnight)
  kick-in within 100 ms RAW of truth:  12
  kick-in > 1 sec wrong:                12  (Boundless Heart, Melodic Inspiration, Distortion
                                            Feelings, Elements, Love Story, Alraegadir, etc.)
```

So even on the friendly subclass, my detector lands within tolerance on only 1/6 tracks. The other half are CLOSE (within 100 ms) — likely a refinement / attack-walk-back issue. A better detector could plausibly reach 8-12 rescues within this subclass.

The other half (Distortion Feelings, Elements, Love Story, etc.) genuinely have ambiguous structural drops — early sub-bass / arpeggios that the detector treats as the structural drop, but Rekordbox's bar-1 lands somewhere else (often deeper into the track or at a soft kick the detector missed).

## Edge cases the user asked about

- **Tracks with NO kickless intro (kick from sample 0):** 207/268 tracks (77.2%). For these the gate doesn't fire — algorithm is a no-op.
- **Sampler / one-shot files:** Step 4 sampler snap-to-0 already handles them. Their kickless gap is 0 ms so the gate doesn't fire.
- **Tracks with gradual kick fade-in:** Detector picks the first "loud enough" frame, which is several seconds after the true fade-in start. Examples include "Arrival", "Everyday", "In This World" — Rekordbox places bar-1 at the start (≤25 ms) but my detector says 30 s+ in. The strict on-beat + offset gate excludes these.
- **Tracks with multiple sections matching the pattern:** Detector always returns the FIRST such section, which is the correct behavior. Not observed as a failure mode.

## Predicted impact summary

| Approach                          | Rescued | Regressed | Net  | Effort     |
| --------------------------------- | ------- | --------- | ---- | ---------- |
| Naive replacement                 |   ~10   |   ~122    | -112 | —          |
| Strict gate (Gate G), this detector |     3   |      0    |  +3  | 2-3 hrs    |
| Improved detector + Gate G        |    6-10 |     0-2   | +6-8 | 8-12 hrs   |
| Best plausible upper bound        |  ~12    |    ~2     | ~+10 | 15-20 hrs  |

**This is a small, narrow fix, not a major leap.** Realistic delivered ceiling: **72.1% → 73-76% accuracy**, not the speculated 85%+.

## Why the user's mental model doesn't match Rekordbox

The user's intuition is musically sound — humans would mark bar-1 at the structural drop. Rekordbox doesn't. Strong evidence:

1. For ~196 tracks with no real kickless intro, truth is within 50 ms of file start.
2. For Body Stars, Hymn Fern, etc., the kick band is silent until 500 ms but truth still lands at 24-47 ms — Rekordbox uses an implied grid extrapolated backward to a near-time-0 anchor.
3. For tracks with a genuine kickless intro and a clear first drop (It Has To Be, When Midnight Comes), Rekordbox does land at the drop — but this is a small minority.

Rekordbox's behavior is closer to: "anchor bar-1 to the earliest position that the established beat grid would put a downbeat, modulo the bar boundary set by the audible content." This is what our walk-back-to-0 algorithm (Step 1) was designed to do. The remaining failures are mostly tracks where the bar boundary is ambiguous (off-by-N-beats) or where our beat-0 refinement disagrees with Rekordbox's by ~20 ms (Sub-cause B).

## Proposed algorithm (if we want the +3 anyway)

```
Post-processing pass after the existing walk-back / sampler-snap:

Given analyzer's current firstDownbeatSec (= beatPhaseFrac × beatPeriodSec) AND
the existing dpBeats, do a kick-in probe:

  bandpass 40-100Hz; 25ms frames; smoothed peak-pick;
  filter peaks below 30% of median peak amplitude;
  find first peak F that begins a run of ≥4 peaks within 1.6s with CV(intervals) < 0.30.

Gate (all must hold):
  - F exists AND F.time > 1.0 s
  - currentBar1 < 100 ms (suggests anchor near 0 — off-by-N candidate)
  - (F.time − currentBar1) >= 1.5 × beatPeriodSec
  - |((F.time − currentBar1) / beatPeriodSec) − round(...)| < 0.10  (on-beat)

If gate fires:
  newBar1 = F.time mod beatPeriodSec        // keep period, shift phase to F
  bump dpBeats forward by round((F.time − dpBeats[0]) / beatPeriodSec) beats
```

The integer-beat offset constraint is the key safety check — it rejects the regressions (Event Horizon, Arrival, In This World) where the detector found a non-beat transient.

Estimated effort to implement, threshold-sweep, and integrate: **3-4 hours**. Predicted impact: **+3 PASS / 0 regression**, takes 72.1% → 73.2%.

## Recommendation

**Skip this for now.** The +3 fix is real but small, and the underlying detector needs more work to expand. The user's intuition is musically correct but Rekordbox doesn't follow it. The bigger remaining gains are:

1. STEP5_INVESTIGATION.md Approach A — envelope-peak walk-forward for the Sub-cause B 14-track cluster (predicted +8-12).
2. The ~10 analyzer-LATE tracks (+25 to +75 ms) — separate cause, separate fix.
3. The ~12 off-by-N tracks where the structural drop is genuinely ambiguous — would need a content-aware model.

If we revisit, the right move is: improve the structural-drop detector (use longer kickless-gap analysis, multi-band kick detection, attack-walk-back) and combine with Approach A. Combined ceiling probably 75-78%.

## Artifacts preserved

- `tools/bpm-test-harness/kick-in-probe.mjs` — 272-track sweep + reporting
- `tools/bpm-test-harness/kick-in-worker.mjs` — per-thread DSP + detector
- `tools/bpm-test-harness/kick-in-debug.mjs` — single-track verbose peak dump
- `tools/bpm-test-harness/snapshots/kick-in-full.json` — full sweep output for cross-tab

All re-runnable. No production code changes were made.
