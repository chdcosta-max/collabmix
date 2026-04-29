# BPM Test Harness

Node script that runs the Mix//Sync BPM analyzer on a folder of audio files and compares results against ground truth.

## Setup

```bash
cd tools/bpm-test-harness
npm install
```

## Adding tracks

1. Copy audio files into `./tracks/` (mp3, wav, flac, ogg supported)
2. Add ground truth entries to `./ground-truth.json`:
   - `bpm`: integer BPM as reported by rekordbox
   - `firstDownbeatSec`: time in seconds where bar 1 begins (rekordbox shows this as DOWNBEAT or grid offset)

## Running

```bash
npm test
```

Or directly: `node analyze.mjs`

Set `DEBUG=1` to surface the worker's `[phase]` log line per track:

```bash
DEBUG=1 node analyze.mjs
```

## Tolerances

- PASS if Δbpm ≤ 0.5 AND Δfirstdownbeat ≤ 20ms
- FAIL otherwise
- SKIP if no ground truth entry exists

Tracks are gitignored so audio files don't get pushed to GitHub.
