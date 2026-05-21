# Rocket Jam Probe — diagnostic report

Track: `/Users/chad/Music/Music/Media.localized/Music/Will DeKeizer/Sound of Neptune/02 Rocket Jam (Original Mix).mp3`
Decoded: 2 channels, sr=44100 Hz, duration=515.66s

## (1) Detected BPM
```
  BPM:              122.000
  Beat period:      491.803 ms  (= 0.491803 sec)
  Reported BPM (user-claimed): 122.000
  Δ BPM:            0.000
```

## (2) First detected downbeat (production bar-1 anchor)
```
  bar1 (firstBar1AnchorSec): 279.37 ms
  beatPhaseSec:              279.37 ms
  beatPhaseFrac:             0.568042328042328
```

## (3) Beat positions, first 60 seconds
Reconstructed analytically as `bar1 + k × period`. 122 beats in window.
```
  k       time (s)   time (ms)
    0        0.2794        279.37
    1        0.7712        771.17
    2        1.2630       1262.97
    3        1.7548       1754.77
    4        2.2466       2246.58
    5        2.7384       2738.38
    6        3.2302       3230.18
    7        3.7220       3721.99
    8        4.2138       4213.79
    9        4.7056       4705.59
   10        5.1974       5197.40
   11        5.6892       5689.20
   12        6.1810       6181.00
   13        6.6728       6672.81
   14        7.1646       7164.61
   15        7.6564       7656.41
   16        8.1482       8148.22
   17        8.6400       8640.02
   18        9.1318       9131.82
   19        9.6236       9623.63
   20       10.1154      10115.43
   21       10.6072      10607.23
   22       11.0990      11099.04
   23       11.5908      11590.84
   24       12.0826      12082.64
   25       12.5744      12574.45
   26       13.0663      13066.25
   27       13.5581      13558.05
   28       14.0499      14049.86
   29       14.5417      14541.66
   30       15.0335      15033.46
   31       15.5253      15525.27
  ... (showing first 32 of 122)
  121       59.7876      59787.56
```

## (4) Loudest energy increase in second-half (drop proxy)
Bandpass 40-100 Hz on full track, 100ms frame energy, 2s box-smoothed.
Largest jump (smoothed energy now vs smoothed energy +5s later) starts at frame 3857 = 385.70 s.
Sharpest 100ms-to-100ms transition within that window: 386.300 s = 386300 ms.
(Track midpoint = 257.83 s.)

## (5) Where the analyzer grid lands at the drop
```
  Drop position (sec):         386.300
  Beats from bar-1 to drop:    784.909
  Nearest grid beat (index):   785
  Bar of beat:                 196  (bars are 0-indexed)
  Position in bar:             1  (beat 2)
  Nearest beat time (sec):     386.345
  Distance from drop (ms):     +44.9 ms
                               (analyzer beat is AFTER the drop)
```

## (6) Kick attack positions, first 16 beats
For each grid beat, ±50ms window, argmax of 1.5ms-smoothed 40-200Hz dE/dt.
Offset > 0 means the detected kick is LATER than the grid position.
```
  k     grid(ms)   attack(ms)   offset(ms)   slope
   0     279.37       229.43     -49.93    8.99e-13
   1     771.17       770.09      -1.08     1.07e-2
   2    1262.97      1250.93     -12.04     9.37e-3
   3    1754.77      1753.81      -0.97     9.31e-3
   4    2246.58      2230.34     -16.24     8.69e-3
   5    2738.38      2737.46      -0.92     8.98e-3
   6    3230.18      3218.16     -12.02     8.63e-3
   7    3721.99      3710.07     -11.92     8.88e-3
   8    4213.79      4201.81     -11.98     8.60e-3
   9    4705.59      4693.65     -11.94     8.90e-3
  10    5197.40      5185.33     -12.07     8.95e-3
  11    5689.20      5688.34      -0.86     9.14e-3
  12    6181.00      6169.02     -11.98     8.62e-3
  13    6672.81      6660.86     -11.95     9.04e-3
  14    7164.61      7152.59     -12.03     8.58e-3
  15    7656.41      7655.49      -0.93     8.89e-3

  Summary across 16 beats: mean offset = -11.18 ms, median = -11.95 ms, stdev = 11.34 ms
```

## Interpretation

- BPM precision: the user reports 122 BPM. Analyzer says 122.000 BPM. 
  At 8:35 track length, a Δ of 0.000 BPM corresponds to ~0 ms of cumulative grid drift end-of-track (if user's BPM is exact truth).

- Bar-phase check at the drop: drop is 784.91 beats from bar-1. Nearest beat is index 785 (bar 196, beat 2).
  **The drop lands on beat 2, NOT on a bar downbeat.** If the drop should be on bar 1, the analyzer's bar-phase is wrong by 1 beat. This is a bar-phase failure mode.

- The drop sits 9.1% of a beat off the grid (44.9 ms from nearest grid beat). Within tolerance — grid is locked to the beats, the issue (if any) is bar-phase or anchor, not BPM drift.

- First-16-beat offsets: mean -11.18 ms, stdev 11.34 ms.
  Offset varies substantially beat-to-beat — suggests either the grid is drifting (BPM wrong) or the kick detector itself is unreliable on this material.
---

## Manual interpretation (deeper look at the data)

### Headline diagnosis: **bar-phase wrong, BPM correct**

The drop at 386.30s lands on **beat 2 of bar 196** (analyzer index 785). Shifting bar-1 forward by **1 beat** would put it on bar-1. This is a 1-beat phase error in the bar grid, NOT a BPM drift, NOT a continuous anchor offset.

### Why BPM drift is ruled out
- Analyzer BPM is **exactly 122.000** — matches user's claim with no daylight.
- Drop is only 44.9ms (9.1% of a beat) from a grid beat. If BPM were drifting over 8 minutes, the drop would land 200+ ms off the grid by track end.

### Why pure anchor offset is ruled out
- The drop is on bob=1 (beat 2 of bar). Continuous offsets that small would land within the same beat-of-bar as truth. Whole-beat misalignment = bar-phase, not anchor.

### Why bar-phase is the right diagnosis
- Drop is on beat 2 → analyzer's bar boundaries are shifted by 1 beat relative to where the song's bars actually start.
- This is the same failure family as the off-by-N-beats cluster, but **off by 1** instead of off by 2/3. Drop-detection fix (Sub-cause D, commit `9ba92fe`) only fires when `anaBar1 < 50ms` AND drops vote on bob 0/2/3 with 100% confidence. For Rocket Jam:
  - anaBar1 = **279.37 ms** (well over the 50ms gate → drop-detection didn't run)
  - Even if it had, the 1-beat shift case is exactly what the existing gate could handle if extended to fire on bob=1 too.

### Side observation — bimodal first-16-beat offsets

Looking past the auto-generated "varies substantially" line: the offsets aren't noise, they're bimodal.

```
Beats 1, 3, 5, 11, 15   →  offset ≈ -1 ms   (5 beats clean-aligned)
Beats 2, 4, 6, 7, 8, 9, 10, 12, 13, 14  →  offset ≈ -12 ms   (10 beats consistently early)
Beat 0  →  offset = -50 ms, slope ≈ 0  (kick not really there at this position)
```

The -12 ms cluster is Sub-cause B drift (already documented). The -1 ms cluster is on the "real" kicks. The pattern of clean-vs-drifted alternating suggests the kick lands on every other beat in this track's pattern, with off-beats being smaller transients that the detector still locks to.

**Beat 0's offset of -50 ms with near-zero slope is the smoking gun** — there's no strong kick at the analyzer's bar-1 position. The analyzer has anchored bar-1 to a position that **does not contain a kick attack**. That's structurally consistent with the bar-phase being off by 1 beat: the real first-bar kick is one beat later (around 771ms), and the analyzer mis-anchored to 279ms which is roughly the upbeat before it.

### What a fix would look like (informational only — not implementing)

Extend the existing drop-detection gate (Sub-cause D in `bpm-worker-source.js` ~line 1068):
- Currently fires only when `anaBar1 < 50ms` and votes choose bob ∈ {1, 2, 3}.
- Rocket Jam needs it to fire when `anaBar1` is later (here 279ms) AND votes pick bob=1.
- The risk is the same regression family — 7-8 currently-passing tracks have drops at non-zero bob that would shift wrongly.

Best path forward is likely a **per-bar plausibility check on the existing dpBeats[0]** — if beat 0 has zero kick energy (as Rocket Jam does, slope ≈ 0), advance bar-1 by one beat. This is much narrower than the drop-detection gate and would specifically catch the "anchored to a beat that doesn't have a kick" failure.
