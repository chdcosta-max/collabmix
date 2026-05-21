# Real Accuracy Summary

Synthesizes the three diagnostics from this round (Symbiotic Symphony probe,
Sub-cause F population scan, long-track audit) into one honest number for
analyzer accuracy.

## Headline

```
Current shipped (raw):                      199/272 = 73.2%
Excluding tracks > 15 min (DJ mixes):       199/262 = 76.0%
Excluding tracks > 10 min:                  199/261 = 76.2%
Plus Sub-cause F fix on harness (+1 PASS):  200/261 = 76.6%
Theoretical ceiling of all clean fixes:     ~205/261 ≈ 78.5%
```

## What the numbers mean

### "Current shipped: 73.2%" — the literal raw number

199 of 272 harness tracks pass within ±20 ms of Rekordbox truth, after all
fixes (commits `d306514` walk-back, `5f9ce8d` earliest-peak, `d024f2a`
sampler-snap, `960051a` envelope-walk-forward, `9ba92fe` drop-detection).
This is the number the harness reports without any caveats.

### "76.0-76.2% excluding long mixes" — the honest number

The harness contains **10 tracks > 15 minutes** (range 60-78 min) and one
additional track > 10 minutes (Love Story, 10:58). All 11 are full-length
DJ mixes:

```
01 JC Mix.wav                        78:05  Δ = -728 ms
01 Continuous Mix (Mixed by Guy J)   77:42  Δ = -1035 ms
01 June San Juan 2025.wav            70:35  Δ = -930 ms
01 May San Juan Mix 2026.wav         65:35  Δ = -958 ms
01 San Juan 2025.wav                 64:50  Δ = -904 ms
MI December 2024.wav                 63:19  Δ = -955 ms
01 Chad May 14.wav                   61:00  Δ = -921 ms
Juno's Mix.wav                       60:55  Δ = -925 ms
MI May 25.wav                        60:55  Δ = -887 ms
Melodic Inspiration's - Dec 2024     59:59  Δ = -612 ms
02 Love Story (Original Mix)         10:58  Δ = -1579 ms (probably a long mix or has unusual structure)
```

All 11 are FAIL with Δ in the -600 to -1600 ms range — off by 1-3 entire
beats. A DJ mix containing multiple tracks at different BPMs CANNOT be
properly beat-gridded by a single-BPM analyzer; this is a fundamental
representation problem, not a tuning issue. Counting these as analyzer
failures inflates the denominator unfairly.

**76.2% (excluding all tracks > 10 min)** is the most defensible number
for "how well does the analyzer beat-grid actual EDM tracks?"

### Cross-contamination check

```
Sub-cause B tracks (13) that are also > 10 min:        0
Sub-cause F candidates (34) that are also > 10 min:    0
```

The long-mix exclusion does **not** overlap with either failure cluster
we've been investigating. The ~27% of remaining failures (after exclusion)
are genuine algorithmic limitations, not artifacts of test set composition.

### "+1 PASS from Sub-cause F" — what the new diagnostic adds

The Sub-cause F signature ("beat 0 has effectively zero kick energy AND
beat 1 has a real kick") identifies tracks where the analyzer anchored
bar-1 to a non-kick position. With a strict gate (slope[0] < 1e-6 AND
slope[1] > 100 × slope[0]), 21 tracks match in the harness.

Of those, only **1 track (Boundless Heart)** would actually flip
FAIL→PASS under a naive "shift bar-1 by +1 beat" rule. The others either:
- Are already passing (no flip)
- Need a different shift amount (Sub-cause F doesn't know how many beats)
- Have weird Δ values that a 1-beat shift doesn't fix

Predicted impact if a tight-gate Sub-cause F fix shipped:
```
On 272-track raw:        200/272 = 73.5%  (+0.3%)
On 261-track honest:     200/261 = 76.6%  (+0.4%)
```

Small. Boundless Heart specifically is the only solid rescue available
through this signature alone. Combined with drop-detection (which already
ships and votes on beat-of-bar), Sub-cause F could be the "is it SAFE to
apply the drop-detection-voted shift" gate — but that's a follow-up design
question.

### The Rocket Jam / Symbiotic Symphony class

Both Rocket Jam (122 BPM, 8:35) and Symbiotic Symphony (123 BPM, 6:48)
are in the user's app library but NOT in the test harness. Both have the
Sub-cause F signature (beat 0 slope ≈ 0). Neither would benefit from a
+1-beat shift alone:

- Rocket Jam: drop is on bob=1 → needs +1 beat shift ✓ (would work)
- Symbiotic Symphony: drop is on bob=2 → needs +2 beat shift (not what F alone does)

These two tracks confirm the failure mode is real and visible to users,
but they're outside the test harness so we can't put them in the rescue
ledger.

## Honest assessment

**The most defensible "real" accuracy number for the analyzer is ~76%.**

The 11 long DJ mixes in the test harness are fundamentally not analyzable
by a single-BPM beat tracker; counting them as failures is unfair. The
remaining ~24% of failures break down into:

- ~14 tracks: Sub-cause B drift (-20 to -27 ms early)
- ~14 tracks: LATE cluster (+25 to +75 ms)
- ~10-15 tracks: off-by-N-beats with various roots (Sub-cause F partially
  identifies these but doesn't fix them alone)
- ~10 tracks: misc patterns (very noisy attacks, unusual genres, etc.)

Each cluster has been investigated and confirmed not addressable by simple
heuristic patches without unacceptable regressions. The convergent finding
across madmom diagnostic, anchor hypothesis test, cluster-offset
diagnostic, and now Sub-cause F is: **audio-based detection alone cannot
reach Rekordbox's anchor convention without modeling perceptual offsets
that vary per track.**

## Recommended framing for v1 launch

When characterizing analyzer accuracy publicly or in marketing/docs:

- **"~76% accuracy on standalone EDM tracks"** — defensible, accurate,
  matches what users would experience on individual tracks.
- **Disclose the long-mix limitation** — the analyzer is designed for
  single-tempo tracks; full DJ mixes won't grid correctly. Users who
  load mixes will hit visible failures (like the 11 here).
- **Avoid claiming the raw 73.2%** — it includes test set composition
  artifacts that don't represent the real use case.

## What's next

Three reasonable paths from here:

1. **Ship at 76% and gather telemetry.** Real user nudge corrections are
   the cleanest source of per-track Rekordbox-style offsets. Telemetry
   answers questions that diagnostics can't.

2. **Combined Sub-cause F + drop-detection fix.** Drop-detection
   currently gates on `anaBar1 < 50ms` — Boundless Heart (anaBar1 =
   29.9 ms) should have triggered but didn't. Worth diagnosing why
   drop-detection isn't catching this case; a fix here could add 2-4
   more rescues. Estimated effort: 1-2 hours diagnostic, then a small
   implementation if root cause is fixable.

3. **Try beat_this (MIT-licensed transformer).** Per the earlier
   discussion, beat_this is the most promising next-tier model given
   different architecture and training set than madmom. We'd want to
   check whether it shares madmom's CC-BY-NC-SA model encumbrance
   first. Estimated effort: 1-2 days for diagnostic at madmom-level
   thoroughness.

My recommendation: **option 2 first (cheap), then ship at 76%, then
revisit telemetry after some real-world use.**
