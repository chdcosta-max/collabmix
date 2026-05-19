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

Set `DEBUG=1` to surface the worker's full `[phase]` log line per track:

```bash
DEBUG=1 node analyze.mjs
```

The harness always prints a concise phase line per track (`bestPh`, `phSc`
buckets, `spread`, phrase-vote winners) so per-track decisions are visible
without `DEBUG`.

## A/B comparison

```bash
# Record current analyzer behaviour as a baseline
node analyze.mjs --save baseline

# After changing the analyzer, diff against the baseline
node analyze.mjs --compare baseline
```

Snapshots are stored in `./snapshots/<name>.json` (gitignored). Diff output
flags `fixed` (FAIL→PASS, ✓), `regressed` (PASS→FAIL, ✗), and notes when
the picked bucket changed (★). Exits non-zero if any track regressed.

## Tolerances

- PASS if Δbpm ≤ 0.5 AND Δfirstdownbeat ≤ 20ms
- FAIL otherwise
- SKIP if no ground truth entry exists

For FAIL tracks the harness also reports the *should-have-picked* bucket
(computed from the ground truth offset and current `beatPeriodSec`) so
it's clear which phase bucket the analyzer needs to land on.

Tracks and snapshots are gitignored so audio files and per-machine runs
don't get pushed to GitHub.
