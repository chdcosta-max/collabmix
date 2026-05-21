# Systemwide Bias Diagnostic — Results

Hypothesis: currently-PASSING tracks show mean Δ = -4.55ms (early bias).
Is this constant across the library, or does it correlate with BPM/length?

## Dataset summary
```
  Total tracks in snapshot:     272
  Tracks graded (PASS or FAIL): 272
  PASS tracks:                  199
  Bounded |Δ|<100ms:            230
  PASS + bounded:               199

  All PASS (any Δ):             n=199  mean -4.55  median -6.95  stdev 10.45
  All bounded (|Δ|<100ms):      n=230  mean -2.98  median -6.95  stdev 17.89
  PASS + bounded (target set):  n=199  mean -4.55  median -6.95  stdev 10.45
```

## Bucketed by BPM (PASS tracks only)

### Δ by BPM range
```
  bucket      n     mean Δ    median Δ   stdev    min     max
  --------- ---  --------- --------- -------- ------- -------
   110-119    6     -7.87     -5.62     5.74  -15.53    0.48
   120-129  191     -4.49     -7.04    10.59  -19.71   19.38
      130+    2         0         0        0       0       0
```

## Bucketed by track length (PASS tracks only)

### Δ by length
```
  bucket      n     mean Δ    median Δ   stdev    min     max
  --------- ---  --------- --------- -------- ------- -------
     ≤4min    6      2.97         0     5.46       0   14.95
    4-7min   54     -5.35     -9.86    11.05  -19.71   19.38
     7+min  139     -4.56     -6.98    10.25  -19.01   18.65
```

## Cross-tab (BPM × length, PASS only)
```
BPM \ Len     ≤4min       4-7min      7+min
     ≤110          —          —          —
  110-119          —   -4.5(n=  1)   -8.6(n=  5)
  120-129    4.5(n=  4)   -5.4(n= 53)   -4.4(n=134)
     130+    0.0(n=  2)          —          —
```

## Cross-bucket consistency check
```
  BPM-bucket means (buckets with n>=5):  [-4.49, -7.87]
  Mean of means:    -6.18 ms
  Stdev of means:   1.69 ms
```

## Pearson correlations
```
  BPM × Δ:    r = -0.073   (n=199)
  Length × Δ: r = -0.119   (n=199)
```
(r near 0 = no correlation; |r| > 0.3 = noteworthy; |r| > 0.5 = strong)

## Verdict per the interpretation gates

**Bias is constant across BPM buckets** (stdev of bucket means = 1.69 ms < 3 ms).
Optimal global shift: +7.0 ms (negated median of PASS+bounded).

This would re-center the distribution at 0 instead of -6.95 ms.
---

## Critical correction — global shift is NOT a free win

The verdict block above proposed "+7 ms = optimal shift." That's wrong. The median doesn't predict the practical impact under the 20 ms tolerance gate because the distribution is **asymmetric near the tolerance edges**.

### Actual rescue/regression sweep (on bounded |Δ| < 100 ms tracks, n=230):

```
  shift   rescue  regress    net
  -----   ------  -------    ---
  +0ms       0       0      +0
  +1ms       2       2      +0
  +2ms       5       3      +2  ←
  +3ms       7       6      +1
  +4ms      10       8      +2  ←
  +5ms      11       9      +2  ← three-way tie at the optimum
  +6ms      11      15      -4
  +7ms      11      18      -7  ← what "negated median" would have suggested
  +8ms      12      21      -9
  +9ms      12      24     -12
  +10ms     12      26     -14
```

**Optimal global shift: +2 ms to +5 ms, all delivering net +2.** Beyond +5 ms, regressions accelerate sharply.

### Why the asymmetry

There are more tracks lurking near the +15 to +20 ms PASS edge (about to fall off the late side) than there are FAIL tracks near the -20 to -27 ms edge (about to be rescued from the early side). A naive "shift to center" overshoots the late edge and breaks more PASSes than it rescues FAILs.

### What net +2 means

- Tracks rescued (FAIL → PASS, +5 ms shift): about 11 tracks, mostly in the -25 to -22 ms cluster (the Sub-cause B class).
- Tracks regressed (PASS → FAIL, +5 ms shift): about 9 tracks currently in the +15 to +20 ms range.
- Net: +2. Predicted accuracy: 73.2% → ~73.9% (small).

### Honest verdict

The bias IS constant across BPM and length buckets (stdev of bucket means = 1.69 ms — meets the constancy criterion). But "constant" doesn't mean "shiftable for free." The library's bounded-Δ distribution has long tails on both sides of the tolerance band, and a global shift trades roughly 1:1.

**Possible interpretations:**

1. **The bias is real but the win is tiny.** +2 net at +5 ms shift is real but not worth the integration cost (every track gets shifted, every existing PASS metric needs to be re-baselined).

2. **The bias might be a measurement artifact, not a real systematic offset.** If our analyzer is uniformly ~5-7 ms EARLY of Rekordbox truth, that could just reflect Rekordbox's anchor-on-body-peak convention applied with some attack-edge offset. A global shift wouldn't fix the underlying disagreement — it would just relabel where we land relative to a 20 ms tolerance band.

3. **A conditional shift (per cluster) is better than a global one.** Sub-cause B class wants +22.8 ms (already failed validation). Other clusters might want different shifts. A global +5 ms gives the same shift to all, capturing 2 net rescues but missing the bigger Sub-cause B rescues.

### Recommendation

**Do NOT implement a global shift.** The +2 net win is too small relative to the risk of mis-calibrating the entire 73.2% PASS baseline. The bias is real but it's not the right intervention surface.

The more interesting takeaway is that the existing 20 ms tolerance is masking a systematic ~5-7 ms early bias on the bulk of tracks. If the user ever tightens the harness tolerance to 10 ms, ~30-40 currently-passing tracks would silently start failing — worth knowing for any future regression-test stringency change.
