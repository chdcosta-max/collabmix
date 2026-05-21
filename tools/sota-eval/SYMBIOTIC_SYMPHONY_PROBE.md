# Rocket Jam Probe — diagnostic report

Track: `/Users/chad/Music/Music/Media.localized/Music/The Wash, Callecat/Symbiosis (The Remixes, Pt. 4)/01 Symbiotic Symphony (Weird Sounding Dude Remix).mp3`
Decoded: 2 channels, sr=44100 Hz, duration=408.28s

## (1) Detected BPM
```
  BPM:              123.000
  Beat period:      487.805 ms  (= 0.487805 sec)
  Reported BPM (user-claimed): 123.000
  Δ BPM:            0.000 (BPM matches user exactly)
```

## (2) First detected downbeat (production bar-1 anchor)
```
  bar1 (firstBar1AnchorSec): 0.00 ms
  beatPhaseSec:              0.00 ms
  beatPhaseFrac:             0
```

## (3) Beat positions, first 60 seconds
Reconstructed analytically as `bar1 + k × period`. 124 beats in window.
```
  k       time (s)   time (ms)
    0        0.0000          0.00
    1        0.4878        487.80
    2        0.9756        975.61
    3        1.4634       1463.41
    4        1.9512       1951.22
    5        2.4390       2439.02
    6        2.9268       2926.83
    7        3.4146       3414.63
    8        3.9024       3902.44
    9        4.3902       4390.24
   10        4.8780       4878.05
   11        5.3659       5365.85
   12        5.8537       5853.66
   13        6.3415       6341.46
   14        6.8293       6829.27
   15        7.3171       7317.07
   16        7.8049       7804.88
   17        8.2927       8292.68
   18        8.7805       8780.49
   19        9.2683       9268.29
   20        9.7561       9756.10
   21       10.2439      10243.90
   22       10.7317      10731.71
   23       11.2195      11219.51
   24       11.7073      11707.32
   25       12.1951      12195.12
   26       12.6829      12682.93
   27       13.1707      13170.73
   28       13.6585      13658.54
   29       14.1463      14146.34
   30       14.6341      14634.15
   31       15.1220      15121.95
  ... (showing first 32 of 124)
  123       60.0000      60000.00
```

## (4) Loudest energy increase in second-half (drop proxy)
Bandpass 40-100 Hz on full track, 100ms frame energy, 2s box-smoothed.
Largest jump (smoothed energy now vs smoothed energy +5s later) starts at frame 2466 = 246.60 s.
Sharpest 100ms-to-100ms transition within that window: 250.700 s = 250700 ms.
(Track midpoint = 204.14 s.)

## (5) Where the analyzer grid lands at the drop
```
  Drop position (sec):         250.700
  Beats from bar-1 to drop:    513.935
  Nearest grid beat (index):   514
  Bar of beat:                 128  (bars are 0-indexed)
  Position in bar:             2  (beat 3)
  Nearest beat time (sec):     250.732
  Distance from drop (ms):     +31.7 ms
                               (analyzer beat is AFTER the drop)
```

## (6) Kick attack positions, first 16 beats
For each grid beat, ±50ms window, argmax of 1.5ms-smoothed 40-200Hz dE/dt.
Offset > 0 means the detected kick is LATER than the grid position.
```
  k     grid(ms)   attack(ms)   offset(ms)   slope
   0       0.00         0.00  +     0.00     0.00e+0
   1     487.80       448.53     -39.28     3.34e-3
   2     975.61       952.02     -23.59     4.13e-3
   3    1463.41      1439.73     -23.69     4.24e-3
   4    1951.22      1927.64     -23.58     4.33e-3
   5    2439.02      2415.37     -23.65     4.49e-3
   6    2926.83      2903.13     -23.70     4.50e-3
   7    3414.63      3390.84     -23.80     4.43e-3
   8    3902.44      3878.71     -23.73     4.35e-3
   9    4390.24      4366.42     -23.83     4.36e-3
  10    4878.05      4854.20     -23.85     4.05e-3
  11    5365.85      5342.02     -23.84     3.96e-3
  12    5853.66      5829.77     -23.89     3.82e-3
  13    6341.46      6317.53     -23.94     3.52e-3
  14    6829.27      6799.05     -30.22     3.56e-3
  15    7317.07      7286.85     -30.23     3.52e-3

  Summary across 16 beats: mean offset = -24.05 ms, median = -23.80 ms, stdev = 7.45 ms
```

## Interpretation

- BPM precision: the user reports 123 BPM. Analyzer says 123.000 BPM. 
  Over 408.3s of audio, a Δ of 0.000 BPM corresponds to ~0 ms of cumulative grid drift end-of-track (if user's BPM is exact truth).

- Bar-phase check at the drop: drop is 513.94 beats from bar-1. Nearest beat is index 514 (bar 128, beat 3).
  **The drop lands on beat 3, NOT on a bar downbeat.** If the drop should be on bar 1, the analyzer's bar-phase is wrong by 2 beats. This is a bar-phase failure mode.

- The drop sits 6.5% of a beat off the grid (31.7 ms from nearest grid beat). Within tolerance — grid is locked to the beats, the issue (if any) is bar-phase or anchor, not BPM drift.

- First-16-beat offsets: mean -24.05 ms, stdev 7.45 ms.
  Offsets are small and bounded — grid is well-aligned to detected kicks in the first 16 beats.