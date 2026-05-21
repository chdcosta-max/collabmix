# Sub-cause F population scan

Signature: beat 0 attackSlope is in the bottom 10% of the track's beat slopes,
AND beat 1 attackSlope is above the track median.
Probed 30 beats per track (~12-15 seconds of audio at 120-150 BPM).

## Population stats
```
  Tracks probed:                  272
  Tracks with ≥8 valid slopes:    269
  Sub-cause F candidates:         34
```

## Candidate tracks (matching signature)
```
Track                                         truth    ana_bar1   slope[0]    slope[1]   p10/med ratio  status  Δ
--------------------------------------------- -------- --------- ---------- ----------  ------------- ------  --------
07 Holding On (Original Mix).mp3                   425       0.0    1.89e-13    7.74e-3           0.00    FAIL  -425.0
01 Boundless Heart (Original Mix).mp3              513      29.9    7.86e-13    8.30e-3           0.00    FAIL  -483.1
16 Low Tide (Ezequiel Arias Remix).mp3             216     109.8    8.16e-12    5.15e-4           0.00    FAIL  -106.2
01 Just (Patrice Baumel Remix).mp3                  24      99.8     1.13e-7    4.80e-5           0.00    FAIL  +75.8
02 Hips and Dips (Zankee Gulati Remix).mp3         521      49.9     1.90e-7    8.17e-3           0.00    FAIL  -471.1
02 Delusion (Jiminy Hop Extended Remix).mp3         24     257.4     9.83e-5    8.93e-4           0.41    FAIL  +233.4
02 Feel Love (Extended Mix).mp3                    139     120.0     1.12e-4    2.47e-4           0.50    PASS  -19.0
07 Leave the World Behind (Original Mix).mp3        24       1.2     1.98e-4    3.69e-4           0.58    FAIL  -22.8
01 Astronauts Nightmares (DJ Ruby Extended Re      207     184.0     2.67e-4    3.32e-4           0.85    FAIL  -23.0
02 Loveland (Gorkiz Remix).mp3                      24       9.9     5.36e-4    9.48e-4           0.67    PASS  -14.1
01 Parental Control (Original Mix).mp3              24      21.2     7.79e-4    2.13e-3           0.66    PASS  -2.8
01 Cavalier (Extended).mp3                          25       6.9     9.38e-4    1.58e-3           0.75    PASS  -18.1
04 Alien Flu (Forty Cats Remix).mp3                272     265.4     1.06e-3    1.31e-3           0.83    PASS  -6.6
02 Hello (Extended).mp3                            249     241.8     2.21e-3    3.46e-3           0.86    PASS  -7.2
02 Higher Self (Original Mix).mp3                   25      28.5     2.46e-3    4.10e-3           0.60    PASS  +3.5
04 Apex (Original Mix).mp3                          24      27.7     2.69e-3    3.49e-3           0.89    PASS  +3.7
01 Jungle (Extended Mix).mp3                        55      60.3     3.09e-3    3.94e-3           0.82    PASS  +5.3
04 Moksha (Extended Mix).mp3                       148     165.7     3.13e-3    3.47e-3           0.97    PASS  +17.7
08 Different feat. XIRA (Extended).mp3             144     137.8     3.38e-3    4.38e-3           0.81    PASS  -6.2
02 Shambhala (Extended).mp3                         26      11.1     3.72e-3    5.05e-3           0.78    PASS  -14.9
01 Restored (Original Mix).mp3                      24      43.3     3.91e-3    5.46e-3           0.79    PASS  +19.3
01 Telomeres (Original Mix).mp3                     25      18.0     4.09e-3    5.11e-3           0.80    PASS  -7.0
03 Illusionist (Hicky & Kalo 'Stereo 6AM' Rem       23      15.0     4.84e-3    6.64e-3           0.74    PASS  -8.0
03 Somewhere (Gai Barone & Luke Brancaccio Re       24       7.4     5.07e-3    5.69e-3           0.90    PASS  -16.6
01 N.u. (Original Mix).mp3                          24      32.7     5.57e-3    7.27e-3           0.79    PASS  +8.7
04 Cercanias (Alex O'Rion Remix).mp3               149     166.4     5.70e-3    5.93e-3           0.97    PASS  +17.4
09 The Last Stand (Original Mix).mp3                57      70.1     6.21e-3    7.80e-3           0.83    PASS  +13.1
01 Biome (Mike Rish Remix).mp3                      26      44.6     6.43e-3    7.46e-3           0.89    PASS  +18.6
03 Moai (Maze 28 Reform).m4a                        47      53.6     6.48e-3    7.44e-3           0.90    PASS  +6.6
01 Forgotten (Extended).mp3                        247     230.6     7.12e-3    8.34e-3           0.90    PASS  -16.4
06 Hymn (Hernan Cattaneo & Simply City Extend      105      87.0     7.18e-3    9.63e-3           0.91    PASS  -18.0
03 Sparky (Original Mix).mp3                       192     171.3     7.43e-3    8.20e-3           0.91    FAIL  -20.7
01 Parlez-Vous (Extended Mix).mp3                   24      24.2     7.71e-3    9.19e-3           0.86    PASS  +0.2
02 The Covern (Rigopolar Remix).mp3                 27      10.5     8.69e-3    9.07e-3           0.96    PASS  -16.5
```

## If we shifted bar-1 forward by 1 beat on every candidate:
```
  Rescued (FAIL → PASS):      1
  Regressed (PASS → FAIL):    25
  Net:                        -24
  Still PASS after shift:     0
  Still FAIL after shift:     8
```

### Rescued tracks
```
  01 Boundless Heart (Original Mix).mp3                Δ  -483.1 →    4.7
```

### Regressed tracks
```
  02 Hello (Extended).mp3                              Δ    -7.2 →  492.8
  01 Parlez-Vous (Extended Mix).mp3                    Δ     0.2 →  484.1
  04 Alien Flu (Forty Cats Remix).mp3                  Δ    -6.6 →  477.3
  03 Somewhere (Gai Barone & Luke Brancaccio Remix).   Δ   -16.6 →  467.3
  04 Cercanias (Alex O'Rion Remix).mp3                 Δ    17.4 →  513.2
  04 Moksha (Extended Mix).mp3                         Δ    17.7 →  513.5
  01 Telomeres (Original Mix).mp3                      Δ    -7.0 →  488.8
  03 Moai (Maze 28 Reform).m4a                         Δ     6.6 →  494.4
  06 Hymn (Hernan Cattaneo & Simply City Extended Mi   Δ   -18.0 →  473.8
  01 Cavalier (Extended).mp3                           Δ   -18.1 →  469.7
  02 Shambhala (Extended).mp3                          Δ   -14.9 →  476.9
  02 Higher Self (Original Mix).mp3                    Δ     3.5 →  499.4
  01 Parental Control (Original Mix).mp3               Δ    -2.8 →  497.2
  03 Illusionist (Hicky & Kalo 'Stereo 6AM' Remix).m   Δ    -8.0 →  487.9
  09 The Last Stand (Original Mix).mp3                 Δ    13.1 →  508.9
  01 Biome (Mike Rish Remix).mp3                       Δ    18.6 →  502.5
  02 The Covern (Rigopolar Remix).mp3                  Δ   -16.5 →  467.4
  01 Forgotten (Extended).mp3                          Δ   -16.4 →  467.5
  01 N.u. (Original Mix).mp3                           Δ     8.7 →  496.5
  01 Restored (Original Mix).mp3                       Δ    19.3 →  519.3
  04 Apex (Original Mix).mp3                           Δ     3.7 →  499.6
  02 Feel Love (Extended Mix).mp3                      Δ   -19.0 →  461.0
  08 Different feat. XIRA (Extended).mp3               Δ    -6.2 →  481.6
  01 Jungle (Extended Mix).mp3                         Δ     5.3 →  474.0
  02 Loveland (Gorkiz Remix).mp3                       Δ   -14.1 →  476.5
```

## Overlap with the 13 known Sub-cause B tracks
```
Sub-cause B tracks also matching Sub-cause F signature: 3 / 13
  03 Sparky (Original Mix).mp3                       slope[0]=7.43e-3  slope[1]=8.20e-3
  01 Astronauts Nightmares (DJ Ruby Extended Remix   slope[0]=2.67e-4  slope[1]=3.32e-4
  07 Leave the World Behind (Original Mix).mp3       slope[0]=1.98e-4  slope[1]=3.69e-4
```
---

## Stricter-gate sweeps (looking for cleaner signature)

The "bottom 10% AND above median" gate fires too easily — most tracks have beat 0 slightly weaker than beat 1 just by chance. Tighter gates that specifically target "beat 0 has effectively ZERO kick energy":

```
Gate                                                  selected  rescue  regress  net
----------------------------------------------------- -------- ------- -------- ----
slope[0] < 1e-6  AND slope[1] > slope[0] * 100              21       1        0   +1
slope[0] < 1e-6  AND slope[1] > slope[0] * 1000             19       1        0   +1
slope[0] < 1e-8  AND slope[1] > slope[0] * 1000             17       1        0   +1
slope[0] < 1e-10 AND slope[1] > slope[0] * 10000            17       1        0   +1
```

All tighter gates land on the same single rescue: **`01 Boundless Heart (Original Mix).mp3` Δ -483.1 → +4.7**. Zero regressions with any of these gates.

### Why only one rescue despite multiple "no-kick beat 0" candidates

Tracks identified as having truly weak beat 0 slopes, with their actual Δ values:

```
Track                         slope[0]    slope[1]    Δ (ms)    Δ + 1 period   would rescue?
Holding On                   1.89e-13     7.74e-3      -425        +63          no (over 20ms)
Boundless Heart              7.86e-13     8.30e-3      -483         +5          ✓ YES
Low Tide                     8.16e-12     5.15e-4      -106        +382         no (off-by-multi-beat)
Just (Patrice Baumel)        1.13e-7      4.80e-5       +75        +563         no (multi-beat)
Hips and Dips                1.90e-7      8.17e-3      -471        +21          no (just over 20ms tolerance)
```

Three of these (Holding On, Boundless Heart, Hips and Dips) genuinely have Δ ≈ -period — so a 1-beat shift moves them toward truth. But only Boundless Heart lands inside the ±20ms tolerance. The other two land at +21 and +63 ms — within sight of a fix but not quite there.

### What this tells us about the Symbiotic Symphony case

Symbiotic Symphony (your example) had **beat 0 slope = 0.00, beat 1 slope = 3.34e-3** — matches the strict signature perfectly. The drop in SS was on **bob=2 of the analyzer's grid** — meaning SS needs a **2-beat shift**, not 1-beat.

So Sub-cause F as "advance bar-1 by 1 beat" rescues exactly 1 track in the harness. The same diagnostic concept ("beat 0 has no kick → shift to first kick") would rescue more if we knew HOW MANY beats to shift, but determining that requires either truth or a separate signal (e.g., drop-detection telling us "drops vote on bob=2, shift by 2").

### Honest conclusion on Sub-cause F as a stand-alone fix

- **The signature is real and detectable.** beat 0 attackSlope < 1e-6 cleanly identifies tracks where the analyzer anchored to a no-kick position (5 in this harness).
- **A 1-beat shift only helps when the truth happens to be 1 period away.** Of 5 strict-signature matches, only 1 (Boundless Heart) gets fully rescued by +1 period.
- **The right Sub-cause F gate would need to be combined with drop-detection.** Drop-detection tells us how many beats off; Sub-cause F tells us "anchor is on a no-kick beat, shift is safe to apply." Combined: shift by drop-detection's voted N, only on Sub-cause F-signature tracks. Different shape than what the current commit `9ba92fe` (Sub-cause D / drop-detection) does — drop-detection only fires when anaBar1 < 50ms, which excludes Boundless Heart (anaBar1 = 29.9ms ← actually under 50ms, so it should have fired) and Symbiotic Symphony (anaBar1 = 0ms ← under 50ms too).

**Worth investigating: why didn't the existing drop-detection fix Boundless Heart?** Its anaBar1 (29.9ms) is below the 50ms gate. Either the drop detector didn't find enough drops, or didn't vote conf=1.0, or didn't vote on a non-zero bob. That's a separate question — flagged for follow-up but out of scope for this task.
