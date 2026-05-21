# beat_this Diagnostic — Does it solve Sub-cause B?

Date: 2026-05-20. Sandbox: `tools/sota-eval/beat_this/`. Investigation only — no production code touched. Same protocol as `MADMOM_DIAGNOSTIC.md`.

## Headline verdict: Better than madmom, still well below proceed threshold.

**Group A (13 Sub-cause B failures): 2/13 strict, 4/13 harness.**
beat_this does NOT solve Sub-cause B. It shows the same systematic ~22-27 ms EARLY drift on the same tracks that our analyzer and madmom miss — confirming a third independent piece of evidence that audio-based detection cannot reach Rekordbox's anchor convention.

**Group B (15 regression-check PASS tracks): 6/15 strict, 7/15 harness.**
beat_this breaks **8-9 of 15 currently-passing tracks.** Three failures were audio-load issues (unicode paths in m4a files broke soundfile/torchaudio); even ignoring those, beat_this gets 6/12 strict, 7/12 harness.

**Performance: 3.9 s/track mean, 5.7 s max. ~10× faster than madmom.**
For 10,000 tracks: ~11 hours single-thread (vs madmom's 104 hrs).

**Per user instructions: ≤5/13 strict → dead end. STOPPING.**

---

## Setup notes (see `beat_this/` directory)

- **Python 3.11.9** required (beat_this uses PEP 604 `int | None` syntax). Installed via official .pkg installer.
- `pip install beat-this` pulls in torch 2.12, torchaudio 2.11, soundfile, einops, rotary-embedding-torch.
- Models downloaded automatically from `cloud.cp.jku.at` on first inference (~78 MB for `final0`). Manual prefetch worked when auto-download hit a transient initialization issue.
- Audio loading on macOS needs `soundfile` for mp3 (works after pip install). m4a files require `torchcodec` (failed to load on this system: `libtorchcodec_core4.dylib` won't link), or ffmpeg subprocess (works with ASCII paths but unicode paths break the shell call).

Three Group B tracks in artist directories with non-ASCII characters (Patrice Bäumel, Mortinaré, Pong) failed to load. Easily fixable but didn't change the headline verdict.

Probed via `final0` checkpoint (main model, no DBN postprocessing, per beat_this paper's recommendation).

---

## Group A — 13 known Sub-cause B failures

| Track | Truth (ms) | beat_this (ms) | Δ (ms) | strict ≤10ms | harness ≤20ms | ana baseline (ms) | Time (s) |
|-------|-----------|----------------|--------|--------------|---------------|-------------------|----------|
| 01 Body Stars (Original Mix).mp3              | 24  |   0  | -24  | . | . |   2.5 | 5.7 |
| 01 Scarlet Sails (Extended).mp3               | 25  | 980  | +955 | . | . |   0.0 | 4.5 |
| 10 Aurora (Original Mix).mp3                  | 24  |  20  | -4   | **Y** | **Y** |   0.0 | 4.4 |
| 04 Coaster (Durante Remix).mp3                | 25  |   0  | -25  | . | . |   4.7 | 4.0 |
| 07 Leave the World Behind (Original Mix).mp3  | 24  | 500  | +476 | . | . |   1.2 | 4.8 |
| 02 Serenità (Original Mix).mp3                | 82  |  60  | -22  | . | . |  54.9 | 5.7 |
| 08 Fly Fox (Original Mix).mp3                 | 33  |  20  | -13  | . | **Y** |   9.8 | 4.3 |
| 04 Great Attractor (Ruben Karapetyan Remix)   | 32  |  20  | -12  | . | **Y** |   9.0 | 4.8 |
| 01 Astronauts Nightmares (DJ Ruby Ext Remix)  | 207 | 200  | -7   | **Y** | **Y** | 184.0 | 4.1 |
| 06 Finding Estrella (Analog Jungs Remix)      | 225 | 200  | -25  | . | . | 203.2 | 4.9 |
| 04 Swans (Dave DK Extended Remix).mp3         | 116 |  80  | -36  | . | . |  94.5 | 5.0 |
| 03 Sparky (Original Mix).mp3                  | 192 | 160  | -32  | . | . | 171.3 | 4.4 |
| 02 Track II (Original Mix).mp3                | 267 | 240  | -27  | . | . | 254.4 | 2.7 |

**Group A summary: 2/13 strict, 4/13 harness.**

Three failure patterns:
1. **Same -10 to -36 ms EARLY drift as our analyzer and madmom** on the same tracks (Body Stars, Coaster, Serenità, Fly Fox, Great Attractor, Finding Estrella, Swans, Sparky, Track II). Different model, different architecture, same convergent error.
2. **Two unexpected wins** (Aurora -4, Astronauts -7) where beat_this happens to land much closer than our analyzer. Possibly a different anchor convention for those specific kicks.
3. **Two bar-phase failures** (Scarlet Sails +955, Leave the World +476) where beat_this anchored to the wrong beat entirely — same off-by-bars failure mode we see in madmom.

---

## Group B — 15 regression-check PASS tracks

| Track | Truth (ms) | beat_this (ms) | Δ (ms) | strict ≤10ms | harness ≤20ms | ana baseline (ms) | Time (s) |
|-------|-----------|----------------|--------|--------------|---------------|-------------------|----------|
| 02 Gothamania (Jamie Stevens Remix).mp3       | 208 |  200 |   -8 | **Y** | **Y** | 217.2 | 4.3 |
| 01 Biome (Mike Rish Remix).mp3                | 26  |   20 |   -6 | **Y** | **Y** |  44.6 | 5.0 |
| 07 Serene (Extended Mix).mp3                  | 25  |   20 |   -5 | **Y** | **Y** |  19.4 | 4.9 |
| 01 Cosmos (Original Mix).m4a                  | 170 |   —  |   —  | . | . | 159.5 | LOAD-FAIL |
| 02 Upsala (Forty Cats Remix).m4a              | 54  |   —  |   —  | . | . |  38.8 | LOAD-FAIL |
| 01 In This World (Original Mix).mp3           | 24  | 1980 | +1956| . | . |  15.0 | 4.4 |
| 01 Transcender (Original Mix).mp3             | 24  |   20 |   -4 | **Y** | **Y** |  18.0 | 4.4 |
| House1.wav                                    |  0  |    0 |    0 | **Y** | **Y** |   0.0 | 0.0 |
| 02 Mr Pong (Original Mix).m4a                 | 159 |   —  |   —  | . | . | 142.6 | LOAD-FAIL |
| 02 Shambhala (Extended).mp3                   | 26  |    0 |  -26 | . | . |  11.1 | 4.7 |
| 10 Sea & Stars (Original Mix).mp3             | 24  |    0 |  -24 | . | . |  39.5 | 4.7 |
| 03 Against the Wall (Original Mix).mp3        | 145 |  120 |  -25 | . | . | 140.8 | 4.4 |
| 01 Dejavu (Original Mix).mp3                  | 275 |  260 |  -15 | . | **Y** | 260.8 | 4.5 |
| 03 Aliens (Original Mix).mp3                  | 24  | 1000 |  +976| . | . |  11.8 | 4.8 |
| 02 Loveland (Gorkiz Remix).mp3                | 24  |   20 |   -4 | **Y** | **Y** |   9.9 | 4.5 |

**Group B summary: 6/15 strict, 7/15 harness.** Excluding the 3 load failures: 6/12 strict, 7/12 harness.

Patterns:
- 6 tracks land within ±10ms (5 within ±4ms): clean wins where beat_this matches the analyzer's PASS at sub-10ms precision.
- 2 tracks at bar-phase failures (In This World +1956, Aliens +976): catastrophic, off by entire bars.
- 4 tracks at -15 to -26ms: same EARLY drift family as Group A.

Replacing our pipeline with beat_this would lose ~7-9 of the 15 PASS controls. Net would be **catastrophic** on the full library (similar to madmom's drop from 73% to ~30-40%).

---

## Performance

| Metric | beat_this | madmom (for comparison) |
|--------|-----------|-------------------------|
| Mean inference time | **3.9 s/track** | 37.4 s/track |
| Max inference time | 5.7 s | 248.5 s |
| Total 28 tracks | 110 s (1.8 min) | 1048 s (17.5 min) |
| 10,000 tracks single-thread | **~11 hours** | ~104 hours |
| 10,000 tracks 8-core parallel | ~1.4 hrs | ~13 hrs |
| Per-track-second-of-audio | ~0.01× real-time | ~0.1× real-time |

beat_this is **~10× faster** than madmom. The transformer architecture is much more compute-efficient than madmom's RNN+DBN pipeline. This is meaningful: at 1.4 hours for 10k tracks parallel, a beat_this-backed analyzer could realistically run on the user's full library locally.

But it's still ~200× slower than our existing Node analyzer (which does 272 tracks in 3 min parallel = ~0.07 s/track).

---

## License audit

| Package | Version | License | Commercial OK? |
|---------|---------|---------|----------------|
| beat-this (code) | 1.1.0 | MIT | ✓ |
| **beat-this (model weights)** | final0 | **NOT DECLARED** | **⚠ AMBIGUOUS** |
| torch | 2.12.0 | BSD-3-Clause | ✓ |
| torchaudio | 2.11.0 | BSD | ✓ |
| numpy | 2.4.6 | BSD-3-Clause | ✓ |
| einops | 0.8.2 | MIT | ✓ |
| rotary-embedding-torch | 0.8.9 | MIT | ✓ |
| **soxr** | 1.1.0 | **LGPL-2.1-or-later** | **⚠ YELLOW** |
| soundfile | 0.13.1 | BSD | ✓ |
| Jinja2, sympy, networkx, etc. | various | BSD/MIT | ✓ |

### Key license findings

**1. Model weights have NO explicit license declared.** The beat_this repo (`https://github.com/CPJKU/beat_this`) ships a single MIT `LICENSE` file at the top level for "the Software". The README's `## Available models` section describes the model checkpoints but does not declare a license for them. The models are hosted at `cloud.cp.jku.at` (same lab as madmom) and downloaded automatically at runtime.

This is **legally ambiguous**:
- Optimistic reading: "the Software" in the MIT LICENSE includes the model weights → MIT.
- Conservative reading: model weights are a separate artifact, not the Software, with no explicit license → default copyright (i.e., no permission granted for any use beyond what fair use / personal use covers).

**Cleanly resolvable by emailing the authors** (foscarin / schlueter / widmer @ jku.at) to clarify. For commercial shipping this clarification is mandatory; without it, the safe default is "do not redistribute / do not use commercially without authorization."

This is materially better than madmom's situation (madmom's models had an EXPLICIT CC BY-NC-SA license — definitive non-commercial blocker). beat_this's models could plausibly be MIT after a short email exchange. But shipping the diagnostic conclusion as "use beat_this commercially today" is not safe.

**2. `soxr` is LGPL-2.1-or-later.** This is a yellow flag for distribution:
- Dynamic linking + ability for user to swap the LGPL library is OK (Python dynamic loading does this naturally — `pip install soxr` is replaceable).
- Static linking or bundling without LGPL-compliance is NOT OK.
- For a packaged DJ app shipped via PyInstaller / py2app / similar, the bundle would need to either provide unstripped object files for soxr relinking or use a non-LGPL alternative (e.g., scipy.signal.resample at performance cost).

Most commercial Python apps work around LGPL by documenting the dynamic-link allowance and pointing users to source. Tractable, not a blocker.

**3. No GPL/AGPL contamination.** No hard blockers in the dep tree.

### License summary

- **Code: clean (MIT)** ✓
- **Models: ambiguous, needs author email** (better than madmom but not free-and-clear)
- **Transitive deps: 1 yellow flag (soxr LGPL)** — manageable with care
- **Hard blockers: none**

---

## Why beat_this also can't solve Sub-cause B

The convergent finding across three independent investigations:

```
Track                Analyzer Δ    madmom Δ   beat_this Δ
Body Stars              -21.5      -24.0       -24.0
Scarlet Sails           -25.0      -25.0       +955 (off by bars)
Aurora                  -24.0      +956        -4.0 ✓
Coaster                 -19.5      -15.0       -25.0
Leave the World         -22.6      +956        +476 (off by bars)
Serenità                -27.1      +968        -22.0
Fly Fox                 -21.9       -23        -13
Great Attractor         -22.3       -22        -12
Astronauts              -22.2       -37        -7.0 ✓
Finding Estrella        -21.8       -35        -25.0
Swans                   -20.4       -36        -36
Sparky                  -19.7       -32        -32
Track II                -12.6       -47        -27.0
```

All three systems (our heuristic, madmom, beat_this) cluster at -20 to -36 ms EARLY of Rekordbox truth on the bulk of Sub-cause B tracks. Different architectures, different training data, same systematic anchor-vs-Rekordbox mismatch.

This is the third independent confirmation of the finding from the cluster-offset diagnostic and the anchor hypothesis test: **Rekordbox's anchor convention applies a ~20-25 ms perceptual offset that audio-based detectors cannot infer from the signal alone.** Whether the detector is a hand-tuned heuristic, an RNN+DBN, or a transformer, the same drift appears.

---

## Verdict per the user's interpretation gates

- **Group A: 2/13 strict (4/13 harness)** — falls in the "≤5/13 → likely dead end" bucket.
- **Group B: 6/15 strict (7/15 harness)** — would regress 8-9 currently-passing tracks.

**Decision: STOPPING per instruction. Not proceeding to integration planning.**

The transformer architecture, MIT-leaning license posture, and 10× speed advantage over madmom are all real improvements, but they don't change the fundamental Sub-cause B story. beat_this is a better tool than madmom in every respect except the one we actually care about for this evaluation.

---

## Recommendations

Three paths forward, in order of effort:

1. **Ship the current heuristic analyzer at ~76% (excluding long mixes), gather user nudge telemetry.** This was the prior recommendation from `REAL_ACCURACY_SUMMARY.md`. The convergent SOTA evidence reinforces it: there's no off-the-shelf model that does better.

2. **Email JKU to clarify beat_this model license.** Cheap (one email). If they confirm MIT, beat_this becomes a viable commercial candidate for a *different* use case — e.g., a secondary high-precision tracker on user-flagged tracks where the heuristic disagrees. Wouldn't help the Sub-cause B problem but would give a second opinion.

3. **Build a Rekordbox-truth-trained correction layer.** All three audio detectors (us, madmom, beat_this) agree on the kick attack edge within a few ms. The 20-25 ms gap to Rekordbox is a *learned offset* that could be applied as a post-processing layer: feed the detected kick position into a small model trained on Rekordbox truth labels, output the perceptually-aligned position. ~1 week of work to scope, requires real Rekordbox truth dataset. Most promising long-term path.

The cheapest immediate win remains telemetry-driven learning from real user corrections.
