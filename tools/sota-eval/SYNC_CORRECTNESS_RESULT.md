# Sync Correctness Diagnostic — Results

Measured 3 quantities per pair under 5 global-shift scenarios. The cross-track
measurements (xcorr peak lag, A↔B kick offset) are algebraically invariant under
uniform shift — they're reported for the record. The discriminating signal is
PER-TRACK: how far the audible kick body (perceptual reference) sits from bar-1.

## Pair selection
5 PASS-PASS pairs from the post-fix-G snapshot. All prog-house family, 120-122 BPM.
  1. 01 Bridge (Original Mix).mp3 (Δ 0.1) + 02 Welcome to You (Original Mix).mp3 (Δ -4.7)
  2. 01 Phase Sync (Original Mix).mp3 (Δ 14.8) + 01 Walk With Me (Original Mix).mp3 (Δ -7.2)
  3. 01 Paper Tiger (Extended Mix).mp3 (Δ -1.9) + 01 Atlas (Original Mix).mp3 (Δ -3.9)
  4. 04 Thunder (Original Mix).mp3 (Δ -4.0) + 03 Strange Way (Original Mix).mp3 (Δ 13.1)
  5. 02 Vivid Imagination (Tantum Remix).mp3 (Δ 3.3) + 02 Don't Stop (Guy J Remix).m4a (Δ 6.8)

## Per-track: audible kick body − bar-1 (negative = bar-1 is BEFORE the audible kick)

Audible kick = peak of 10ms-smoothed 40-200Hz power within ±60ms of bar-1.
This is the perceptual center of the kick body — the position the hypothesis
predicts Rekordbox anchors bar-1 to.

```
Pair  Track                                          bar1(ms)  audible(ms)  offset(ms)
  1  A: 01 Bridge (Original Mix).mp3                   274.1       294.2        20.1
     B: 02 Welcome to You (Original Mix).mp3            20.3        29.1         8.8
  2  A: 01 Phase Sync (Original Mix).mp3                38.8        53.4        14.5
     B: 01 Walk With Me (Original Mix).mp3              83.8       134.4        50.6
  3  A: 01 Paper Tiger (Extended Mix).mp3              288.1       333.1        45.0
     B: 01 Atlas (Original Mix).mp3                    144.1       151.9         7.8
  4  A: 04 Thunder (Original Mix).mp3                   20.0        73.8        53.8
     B: 03 Strange Way (Original Mix).mp3              213.1       228.3        15.2
  5  A: 02 Vivid Imagination (Tantum Remix).mp3        150.3       165.8        15.5
     B: 02 Don't Stop (Guy J Remix).m4a                297.8       313.0        15.2
```

Aggregate across 10 tracks:
```
  mean offset:   24.65 ms  (audible kick is AFTER bar-1 on average)
  median offset: 15.53 ms
  stdev:         16.91 ms
  min:           7.84 ms
  max:           53.81 ms
```

## Per-shift scenarios (per-track offset & cross-track metrics)

Negative per-track offset = bar-1 is BEFORE audible kick. Positive = AFTER.
Best shift = where per-track offset is closest to zero for most tracks.

```
Pair                                                    -10ms    +0ms   +10ms   +20ms   +30ms
  Track A audible-bar1:     30.1    20.1    10.1     0.1    -9.9
  Track B audible-bar1:     18.8     8.8    -1.3   -11.3   -21.3
  A↔B kick offset    :     11.4    11.4    11.4    11.4    11.4
  XCORR peak lag (ms):     -7.1    -7.1    -7.1    -7.1    -7.1
  Pair 1 above

  Track A audible-bar1:     24.5    14.5     4.5    -5.5   -15.5
  Track B audible-bar1:     60.6    50.6    40.6    30.6    20.6
  A↔B kick offset    :    -36.1   -36.1   -36.1   -36.1   -36.1
  XCORR peak lag (ms):    -35.3   -35.2   -35.2   -35.2   -35.3
  Pair 2 above

  Track A audible-bar1:     55.0    45.0    35.0    25.0    15.0
  Track B audible-bar1:     17.8     7.8    -2.2   -12.2   -22.2
  A↔B kick offset    :     37.2    37.2    37.2    37.2    37.2
  XCORR peak lag (ms):     -6.7    -6.6    -6.6    -6.6    -6.6
  Pair 3 above

  Track A audible-bar1:     63.8    53.8    43.8    33.8    23.8
  Track B audible-bar1:     25.2    15.2     5.2    -4.8   -14.8
  A↔B kick offset    :     38.6    38.6    38.6    38.6    38.6
  XCORR peak lag (ms):     -0.5    -0.5    -0.5    -0.5    -0.5
  Pair 4 above

  Track A audible-bar1:     25.5    15.5     5.5    -4.5   -14.5
  Track B audible-bar1:     25.1    15.2     5.2    -4.8   -14.8
  A↔B kick offset    :      0.4     0.4     0.4     0.4     0.4
  XCORR peak lag (ms):    -31.0   -31.1   -31.1   -31.0   -30.9
  Pair 5 above

```

## Aggregate per shift (mean across all tracks)

```
Shift     mean |offset|   median |offset|  mean A↔B
    -10ms       34.65          25.53         24.73
     +0ms       24.65          15.53         24.73
    +10ms       15.34           5.53         24.73
    +20ms       13.26          11.25         24.73
    +30ms       17.23          15.48         24.73
```

---

## Analysis

### Outcome: **3 — track-dependent.** No single global shift cleanly wins.

The per-track audible-kick-vs-bar1 offset ranges from **+7.8 ms to +53.8 ms** across the 10 tracks. A single global shift can only optimize one of these at a time.

### What a global shift does buy

| Shift | mean \|offset\| | median \|offset\| | improvement vs no shift |
|-------|-----------------|-------------------|-------------------------|
| -10 ms | 34.7 ms | 25.5 ms | worse |
| **+0 ms (current)** | **24.7 ms** | 15.5 ms | baseline |
| +10 ms | 15.3 ms | **5.5 ms** ← best median | 38% |
| **+20 ms** | **13.3 ms** ← best mean | 11.3 ms | 46% |
| +30 ms | 17.2 ms | 15.5 ms | 30% |

A **+10 to +20 ms shift moves the median per-track offset toward zero** for the bulk of tracks. The best-mean shift (+20 ms) cuts mean |offset| in half. But neither value works for the outliers (Thunder A and Paper Tiger A want +45-54 ms; Walk With Me B wants +50 ms; Vivid Imagination + Don't Stop already at +15 ms — would over-shift to -5 ms at +20).

### The cross-track sync truth (xcorr)

The xcorr peak lag is what matters for actual DJ sync. Per pair:

| Pair | Tracks | xcorr peak lag | A↔B first-kick offset | Interpretation |
|------|--------|----------------|-----------------------|----------------|
| 1 | Bridge + Welcome to You | -7.1 ms | +11.4 ms | mild slap, sub-perceptual |
| 2 | Phase Sync + Walk With Me | -35.2 ms | -36.1 ms | **audible slap** |
| 3 | Paper Tiger + Atlas | -6.6 ms | +37.2 ms | xcorr says no slap; first-kick says slap (detection artifact) |
| 4 | Thunder + Strange Way | -0.5 ms | +38.6 ms | xcorr says perfect sync; first-kick disagrees (detection artifact) |
| 5 | Vivid Imagination + Don't Stop | -31.0 ms | +0.4 ms | **audible slap** despite matching first kicks |

**The xcorr metric and first-kick offset metric disagree on 3 of 5 pairs.** Pairs 3 and 4 have a 37-39 ms first-kick offset that the xcorr says doesn't actually exist in audio — the first kick has detection noise but the rest of the bar aligns well. Pair 5 is the inverse: first kicks match but xcorr finds 31 ms lag elsewhere in the bar (possibly sub-bass leading the kick).

### Cross-track invariance confirmed

As predicted in the methodology pre-flight: the xcorr peak lag and A↔B first-kick offset are **invariant under global shifts** (numerically identical across all 5 shift columns). They depend only on the relative bar-1 alignment between A and B, which doesn't change when both are shifted by the same amount.

This means: **a global shift can change how the grid LOOKS over the waveform but cannot change how two tracks SYNC AUDIBLY against each other.** The user's hypothesis about "+20 ms making us sync-correct" is partially confirmed (it makes grids visually align with kicks for many tracks) but partially refuted (it doesn't change the actual cross-track sync correctness, which is dominated by per-track variability).

---

## Recommendations

### What NOT to do
- **Don't apply a global +20 ms shift to all tracks.** It would help on average per-track visual alignment but doesn't solve cross-track sync, and would over-shift tracks like Vivid Imagination + Don't Stop that already align well.

### What's the real picture
1. **Per-track audible-kick offset is genuinely variable**, dominated by detection of the kick attack edge vs body. Some tracks have a 7-15 ms attack-to-body delay (clean fast kicks); others have 45-54 ms (slow body envelope or detection landing on attack ramp).

2. **Currently-passing pairs already have sub-10 ms xcorr lag on 3 of 5 pairs** (Bridge+WtY -7.1, Paper Tiger+Atlas -6.6, Thunder+Strange Way -0.5). For these, sync would feel fine to a listener.

3. **2 of 5 pairs (Phase Sync+Walk With Me, Vivid Imagination+Don't Stop) have 30+ ms xcorr lag.** These would beat-slap audibly when synced via our grids. **Not solvable by global shift** since the A↔B offset is invariant under uniform shifts. Solvable by per-track manual nudge.

### Implications for product direction

This validates the UI-adjust direction the user outlined:

- **Manual anchor nudge is the right tool.** Per-track audible-kick variability (7-54 ms range) is too high for any global rule. Users will hit this; they need a way to nudge.

- **Visual grid alignment is real but variable.** Audible kicks are 7-54 ms AFTER our grid lines for the tracks tested. Users will see grids visually offset from kicks on many tracks — expect this UX feedback.

- **PASS in the harness doesn't guarantee no beat-slap.** 2 of 5 PASS-PASS pairs in this test would slap by 30+ ms. The 20 ms harness tolerance against Rekordbox truth doesn't translate to cross-track sync correctness.

- **Most PASS pairs will sync fine.** 3 of 5 have xcorr lag under 10 ms — within the sub-perceptual band for trained ears. The current analyzer is good enough for most prog house pairs at default settings.

### What the UI-adjust phase should support

1. **Per-track anchor offset** — slider/nudge in ±50 ms increments, with audio feedback.
2. **Optional: per-deck visual anchor preference** ("snap grid to attack edge" vs "snap grid to kick body") — global preference, not per-track.
3. **Sync-time correction visible**: when user activates sync between two decks, show the residual offset so they can nudge to taste.

The good news: even without any post-launch algorithmic work, manual nudge will close the gap on every track. The current 80.9% PASS rate is a measure of harness alignment with Rekordbox; sync correctness is mostly there for most prog house pairs.
