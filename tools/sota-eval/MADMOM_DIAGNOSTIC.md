# madmom Diagnostic — Does it solve Sub-cause B?

Date: 2026-05-20. Sandbox: `tools/sota-eval/`. Investigation only — no production code touched.

## Headline verdict: NO

**Group A (Sub-cause B failures): 0/13 strict, 1/13 harness-tolerance.**
Madmom does *not* solve the Sub-cause B class. It suffers the same -10 to -25 ms EARLY drift as our analyzer plus a new off-by-N-bars failure mode on several tracks.

**Group B (regression check): 0/15 strict, 5/15 harness-tolerance.**
Madmom breaks **10 of 15** currently-PASSING tracks. Eight of those break by entire bars (Δ = 400-2926 ms), not small drift. This is not a "marginally worse" — madmom's downbeat tracker disagrees with Rekordbox's bar-phase convention on a majority of EDM tracks.

**Performance: 37.4 s/track mean, 248 s/track max.**
For 10,000 tracks: ~104 hours single-thread, ~13 hours on 8 cores.

**Per user instructions: STOPPING here. Not proceeding to beat_this or BeatNet without your sign-off.**

---

## Setup notes (see `SETUP.md`)

Three install gotchas — all worked around in the venv but worth documenting if anyone else tries this:
1. madmom needs Cython preinstalled and `--no-build-isolation` to build.
2. madmom 0.16.1 references `np.float` (removed in NumPy 1.24+); pinned NumPy 1.23.5.
3. madmom 0.16.1 imports `pkg_resources` (removed in setuptools 81+); pinned setuptools <81.
4. madmom calls out to `ffmpeg` via subprocess; reused the existing `ffmpeg-static` binary from the harness rather than installing system-wide.

Processor used: `RNNDownBeatProcessor()` → `DBNDownBeatTrackingProcessor(beats_per_bar=[4], fps=100)`. First downbeat extracted as the first row where bar_pos == 1.

PASS criteria reported in both **strict (10 ms)** and **harness (20 ms)** columns. The actual production harness uses 20 ms; the strict column is for reference per the task spec.

---

## Group A — 13 known Sub-cause B failures

Truth = Rekordbox `firstDownbeatSec`. `ana_base` = our analyzer's output BEFORE drop-detection (snapshot `parallel-full.json`). madmom Δ = (madmom_first_downbeat - truth) in ms.

| Track                                          | Truth (ms) | madmom (ms) | Δ (ms) | strict ≤10ms | harness ≤20ms | ana baseline (ms) | Time (s) |
|------------------------------------------------|------------|-------------|--------|--------------|---------------|-------------------|----------|
| 01 Body Stars (Original Mix).mp3               | 24         |   0         | -24    | .            | .             | 2.5               | 35.2     |
| 01 Scarlet Sails (Extended).mp3                | 25         |   0         | -25    | .            | .             | 0.0               | 29.6     |
| 10 Aurora (Original Mix).mp3                   | 24         | 980         | +956   | .            | .             | 0.0               | 28.0     |
| 04 Coaster (Durante Remix).mp3                 | 25         |  10         | -15    | .            | **Y**         | 4.7               | 25.3     |
| 07 Leave the World Behind (Original Mix).mp3   | 24         | 980         | +956   | .            | .             | 1.2               | 29.9     |
| 02 Serenità (Original Mix).mp3                 | 82         | 1050        | +968   | .            | .             | 54.9              | 34.3     |
| 08 Fly Fox (Original Mix).mp3                  | 33         |  10         | -23    | .            | .             | 9.8               | 26.4     |
| 04 Great Attractor (Ruben Karapetyan Remix)    | 32         |  10         | -22    | .            | .             | 9.0               | 30.2     |
| 01 Astronauts Nightmares (DJ Ruby Ext Remix)   | 207        | 170         | -37    | .            | .             | 184.0             | 26.5     |
| 06 Finding Estrella (Analog Jungs Remix)       | 225        | 190         | -35    | .            | .             | 203.2             | 30.2     |
| 04 Swans (Dave DK Extended Remix).mp3          | 116        |  80         | -36    | .            | .             | 94.5              | 30.2     |
| 03 Sparky (Original Mix).mp3                   | 192        | 160         | -32    | .            | .             | 171.3             | 27.8     |
| 02 Track II (Original Mix).mp3                 | 267        | 220         | -47    | .            | .             | 254.4             | 17.3     |

**Group A summary: 0/13 strict, 1/13 harness.**

Three failure patterns visible:
1. **Same EARLY drift as our analyzer, slightly worse** (Body Stars/Scarlet/Fly Fox/Great Attractor/Coaster) — Δ = -15 to -25 ms. Madmom doesn't have a fundamentally different anchor for these.
2. **Larger EARLY drift on mid-track-start tracks** (Astronauts/Finding/Swans/Sparky/Track II) — Δ = -32 to -47 ms. WORSE than our analyzer baseline.
3. **Off-by-2-bars phantom drops** (Aurora/Leave the World/Serenità) — Δ ≈ +960 ms (one entire bar at 120 BPM). Madmom's DBN picked the wrong bar to anchor on these tracks.

---

## Group B — 15 random currently-PASSING tracks (regression check)

| Track                                          | Truth (ms) | madmom (ms) | Δ (ms)  | strict ≤10ms | harness ≤20ms | ana baseline (ms) | Time (s) |
|------------------------------------------------|------------|-------------|---------|--------------|---------------|-------------------|----------|
| 02 Gothamania (Jamie Stevens Remix).mp3        | 208        | 1150        | +942    | .            | .             | 217.2             | 25.8     |
| 01 Biome (Mike Rish Remix).mp3                 | 26         | 1450        | +1424   | .            | .             | 44.6              | 30.7     |
| 07 Serene (Extended Mix).mp3                   | 25         |  10         | -15     | .            | **Y**         | 19.4              | 31.7     |
| 01 Cosmos (Original Mix).m4a                   | 170        | 120         | -50     | .            | .             | 159.5             | 29.1     |
| 02 Upsala (Forty Cats Remix).m4a               | 54         | 490         | +436    | .            | .             | 38.8              | 27.4     |
| 01 In This World (Original Mix).mp3            | 24         | 2950        | +2926   | .            | .             | 15.0              | 26.9     |
| 01 Transcender (Original Mix).mp3              | 24         |  10         | -14     | .            | **Y**         | 18.0              | 27.8     |
| House1.wav                                     | 0          | 970         | +970    | .            | .             | 0.0               | 0.2      |
| 02 Mr Pong (Original Mix).m4a                  | 159        | 1090        | +931    | .            | .             | 142.6             | 25.0     |
| 02 Shambhala (Extended).mp3                    | 26         |  10         | -16     | .            | **Y**         | 11.1              | 39.5     |
| 10 Sea & Stars (Original Mix).mp3              | 24         |  10         | -14     | .            | **Y**         | 39.5              | 28.5     |
| 03 Against the Wall (Original Mix).mp3         | 145        | 610         | +465    | .            | .             | 140.8             | 248.5    |
| 01 Dejavu (Original Mix).mp3                   | 275        | 1240        | +965    | .            | .             | 260.8             | 25.8     |
| 03 Aliens (Original Mix).mp3                   | 24         |  10         | -14     | .            | **Y**         | 11.8              | 82.2     |
| 02 Loveland (Gorkiz Remix).mp3                 | 24         |   0         | -24     | .            | .             | 9.9               | 27.8     |

**Group B summary: 0/15 strict, 5/15 harness.**

This is a **catastrophic regression**: 10 of 15 currently-passing tracks would FAIL with madmom in place. 8 of those 10 break by 400-2926 ms — entire bars off, not small drift. Replacing our pipeline with madmom would cost us ~130 PASS tracks library-wide.

The five harness-passing tracks (Serene/Transcender/Shambhala/Sea & Stars/Aliens) all show the same -14 to -16 ms drift pattern — borderline within the 20 ms tolerance but consistently EARLY.

---

## Performance

| Metric                              | Value         |
|-------------------------------------|---------------|
| Mean inference time                 | 37.4 s/track  |
| Max inference time (Against the Wall, 6:13 m4a) | 248.5 s/track |
| Total for 28 tracks                 | 1048 s (17.5 min) |
| Estimated 10,000-track scan (single-thread) | **~104 hours**  |
| Estimated 10,000-track scan (8-core parallel) | **~13 hours**   |

Track-length-dominated. RNN inference scales linearly with audio duration. Per-second-of-audio inference is roughly 0.1× real-time on this M-series Mac CPU.

For comparison, our current Node analyzer runs the full 272-track library in **3 minutes** parallel (8 workers) — a ~13× speedup vs madmom and on a much smaller installation footprint.

---

## License audit

| Package    | Version | License                        | Commercial OK? |
|------------|---------|--------------------------------|----------------|
| madmom (code)  | 0.16.1  | BSD                            | ✓             |
| **madmom (models)** | 0.16.1  | **CC BY-NC-SA 4.0**              | **✗ NON-COMMERCIAL** |
| Cython     | 3.2.4   | Apache-2.0                     | ✓             |
| mido       | 1.3.3   | MIT                            | ✓             |
| numpy      | 1.23.5  | BSD                            | ✓             |
| scipy      | 1.13.1  | BSD                            | ✓             |
| packaging  | 26.2    | Apache-2.0 OR BSD-2-Clause     | ✓             |

**The pretrained RNN downbeat models — required at runtime — are CC BY-NC-SA 4.0.** Verbatim from `venv/lib/python3.9/site-packages/madmom/models/LICENSE`:

> All model and data files are distributed under the Creative Commons Attribution-NonCommercial-ShareAlike 4.0 license. … If you want to include any of these files (or a variation or modification thereof) or technology which utilises them in a commercial product, please contact Gerhard Widmer at http://www.cp.jku.at/people/widmer/.

The code is BSD (forkable, replaceable). The MODELS are not. Madmom is **not commercially shippable** without a separate license deal with JKU. No GPL/LGPL/AGPL contamination in the dep tree — license risk is concentrated entirely in the CC BY-NC-SA model files.

---

## Why madmom underperforms here

Hypothesized (not confirmed):
- madmom's downbeat tracker was trained on the **Ballroom + Beatles + RWC datasets** — predominantly non-EDM genres. Its bar-phase prior was learned from music where the "downbeat" convention matches a different musical structure than Rekordbox's EDM-centric "first kick of bar 1" rule.
- The DBN tracker fits a global bar-phase via Viterbi over the whole track. On EDM tracks with breakdowns, the DBN can land bar-1 on the wrong beat-of-bar — exactly the failure pattern we see in Group A's Aurora/Leave the World/Serenità (+956 ms ≈ 2 beats) and Group B's massive misalignments.
- The systematic -15 to -25 ms EARLY drift on tracks where madmom *does* find the right bar suggests madmom uses the kick-attack edge (similar to our analyzer's diff-argmax) rather than the kick-body / envelope-peak position Rekordbox uses. Same Sub-cause B mechanism we already documented.

In other words: madmom doesn't disagree with us in a way that *helps*. Where it agrees, it has the same drift. Where it disagrees, it's mostly wrong (per Rekordbox truth).

---

## Recommendation

**Do not pursue madmom integration.** Three independent blockers:

1. **Accuracy** — fails 12/13 Group A targets and regresses 10/15 Group B controls. Replacing our pipeline with madmom would drop accuracy from 73.2% to roughly 30-40% on the same 272 tracks.
2. **License** — CC BY-NC-SA models are a hard commercial blocker.
3. **Performance** — 37 s/track mean is ~13× slower than our current Node analyzer.

Per your instructions: **stopping here, not proceeding to beat_this or BeatNet without your sign-off.** Awaiting your call on:
- Skip SOTA evaluation entirely and stay heuristic at 73.2%
- Try beat_this (MIT-licensed, transformer-based, more recent) anyway — different model, possibly different failure modes
- Try BeatNet (MIT-licensed, RNN-based, optimized for real-time) — though it may share madmom's genre-prior issue since both descend from the same lineage
- Negotiate a JKU license deal — but only if madmom *actually rescued* Group A, which it doesn't

The most likely upgrade path now: **accept 73.2% as the heuristic ceiling for v1, ship the app, gather user-correction telemetry, and revisit beat-tracking accuracy once we have real-world failure data instead of guessing what Rekordbox is doing.**

---

## Artifacts preserved

- `tools/sota-eval/SETUP.md` — install steps and pinned versions
- `tools/sota-eval/madmom_run.py` — diagnostic runner
- `tools/sota-eval/madmom_results.json` — raw per-track results
- `tools/sota-eval/MADMOM_DIAGNOSTIC.md` — this report
- `tools/sota-eval/venv/` — Python venv (gitignored, regenerate via `SETUP.md`)
