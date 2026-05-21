# Long-track audit

Hypothesis: some test-harness tracks may be full-length DJ mixes (60-90 min) which
can't be properly beat-gridded because they contain multiple tracks at different BPMs.
Excluding those would give a more honest accuracy number.

## Tracks > 15 minutes
```
  count: 10

name                                                    duration   status  Δ (ms)
01 JC Mix.wav                                              78:05    FAIL    -727.6
01 Contiuous Mix (Mixed by (Guy J).m4a                     77:42    FAIL   -1034.7
01 June San Juan 2025.wav                                  70:35    FAIL    -930.1
01 May San Juan Mix 2026.wav                               65:35    FAIL    -958.0
01 San Juan 2025.wav                                       64:50    FAIL    -904.0
MI December 2024.wav                                       63:19    FAIL    -955.0
01 Chad May 14.wav                                         61:00    FAIL    -921.0
Juno's Mix.wav                                             60:55    FAIL    -925.1
MI May 25.wav                                              60:55    FAIL    -887.2
Melodic Inspiration's - December 2024.wav                  59:59    FAIL    -611.7
```

## Tracks 10-15 minutes
```
  count: 1

name                                                    duration   status  Δ (ms)
02 Love Story (Original Mix).mp3                           10:58    FAIL   -1578.6
```

## Counts
```
  All graded tracks:           272
  Tracks > 15 min:             10
  Tracks 10-15 min:            1
  Tracks > 10 min (total):     11
```

## Adjusted accuracy
```
  Current:                     199/272 = 73.2%
  Excluding >15min mixes:      199/262 = 76.0%
  Excluding >10min mixes:      199/261 = 76.2%
```

## Cross-contamination check
```
  Sub-cause B tracks > 10min:  0 / 13

  Sub-cause F candidates > 10min:  0
```