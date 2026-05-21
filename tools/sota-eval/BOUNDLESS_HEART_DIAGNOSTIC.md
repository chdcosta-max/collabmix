# Boundless Heart drop-detection diagnostic

Task: figure out why drop-detection (Sub-cause D, commit `9ba92fe`) didn't
rescue Boundless Heart even though its `anaBar1 = 29.9 ms` is under the
50 ms gate. Determine if a narrow extension can fix it without breaking
the 272-track baseline.

## Result: NO production fix. The narrow extension that looked good offline
delivers net 0 (+1 / -1) in production. Reverted, not shipped.

## Step 1 — Which gate condition failed?

From the offline drop-detect snapshot (`drop-detect-full.json`):

```
Boundless Heart:
  anaBar1:        29.9 ms      ← under the 50 ms gate ✓
  period:         487.80 ms
  nBreakdowns:    3            ← multiple breakdowns ✓
  nValidDrops:    1            ← only 1 drop survives snap+energy+rise filter
  drops:          [{ t: 283.5s, bob: 1, frac: 0.11 }]
  votedShift:     1            ← would correctly rescue
  domConfidence:  1.0
  newBar1:        517.7 ms (truth 513 ms → Δ +4.7 ms)
```

**The gate that failed is `drops.length >= 2`.** The production code requires
at least 2 validated drops to vote. Boundless Heart has 3 breakdowns but
only 1 drop survives the snap-to-beat + 40 % energy + 2 × rise filter.

The single drop is at bob=1 with conf=1.0 and would correctly rescue the
track to Δ=+4.7 ms.

## Step 2 — Why drops.length >= 2 exists

The 2-drop requirement is a safety belt: tracks like Forest Beast, Amuja,
Won't Let Go each have ONE breakdown and ONE drop that lands on a non-bar
position (a fill or one-shot, not a true bar boundary). Allowing single
drops would shift them ~1 sec wrongly. The 2-drop requirement filters
these out by requiring consensus across multiple drops.

## Step 3 — Looking for a smarter discriminator

The offline data shows a clean separator: **`nBreakdowns ≥ 2`**.

```
Track                  nDrops  nBreakdowns  status
─────────────────────  ──────  ───────────  ──────
Shuttered                  2         2      FAIL  (currently rescued by drops≥2)
White Moon                 2         3      FAIL  (currently rescued)
Boundless Heart            1         3      FAIL  (NOT currently rescued, would benefit)
It Has To Be Like This     1         2      FAIL  (NOT currently rescued, would benefit)

Forest Beast               1         1      PASS  (currently passes, but offline
Amuja                      1         1      PASS   gate-relax would regress them
Won't Let Go               1         1      PASS   by ~1 sec each)
```

Tracks with one breakdown produce noisy single drops. Tracks with multiple
breakdowns produce structurally reliable drops even if only one survives
the validation filter.

## Step 4 — Offline sweep

```
Gate                                                  selected  rescue  regress  net
----------------------------------------------------- -------- ------- -------- ----
CURRENT: anaBar1<50ms AND drops>=2 AND conf=1.0            56       2        0   +2
PROPOSED: anaBar1<50ms AND conf=1.0 AND
          (drops>=2 OR breakdowns>=2)                      ??       4        0   +4
```

Offline projection: +2 more rescues (Boundless Heart, It Has To Be Like
This) with 0 new regressions.

## Step 5 — Production test (the offline prediction did NOT hold)

Implemented the proposed gate change in `src/bpm-worker-source.js`. Ran the
full 272-track harness. Result:

```
Baseline (fix-D):    199/272 = 73.2%
Proposed (fix-D2):   199/272 = 73.2%  (net 0)
  Rescued:    +1  (It Has To Be Like This, Δ 1477 → 10.5)
  Regressed:  -1  (Somewhere [Gai Barone & Luke Brancaccio Remix], Δ 16.6 → 467.3)
  Boundless Heart was NOT rescued.
```

## Step 6 — Why the production result differs from the offline prediction

Production was instrumented with a debug print to log what the in-worker
drop-detection sees for Boundless Heart and Somewhere:

```
[BPM-DROPDIAG] Boundless Heart:  nBreakdowns=3  nValidDrops=0
                anaBar1=0.0299s  period=0.4878s  drops=[]

[BPM-DROPDIAG] Somewhere:         nBreakdowns=4  nValidDrops=1
                anaBar1=0.0074s  period=0.4839s  drops=[bob1 @ 139.85s]
```

Compare to the offline tool's snapshot results:

```
Boundless Heart offline:  nBreakdowns=3  nValidDrops=1  drops=[bob1 @ 283.5s]
Somewhere offline:        nBreakdowns=4  nValidDrops=3
                          drops=[bob1@139.85, bob0@151, bob1@302.4]
                          conf=0.67 (split between bob 0 and bob 1)
```

**Two divergences between production and offline:**

1. **Boundless Heart**: offline finds 1 drop, production finds 0. The snap +
   energy + rise filter rejects all 3 candidate drops in production.
2. **Somewhere**: offline finds 3 drops (mixed bob 0 / bob 1, conf=0.67 →
   gate doesn't fire because conf < 1.0), production finds only 1 drop
   (bob=1, conf=1.0 by default → gate fires and shifts wrongly).

Both the offline tool (`drop-detect-worker.mjs`) and the in-production code
use the same DSP primitives: same bandpass, same 100 ms hop, same 2 s smooth,
same 40 % p70 threshold, same snap-to-beat-with-2×-rise logic. The
algorithms look functionally identical to me on inspection. But empirically
they don't produce the same drops list, and the divergence is enough to
flip which tracks the proposed gate fires on.

Possible causes (not pinpointed in the 2 hr cap):
- Subtle audio-state difference: the in-production worker's `mono` is
  computed inline (line 102: `mono[i] += d[i]/nc`) and the standalone
  tool's `toMono` is structurally the same but in a separate file. The
  channel averaging should be identical for stereo inputs.
- Floating-point ordering: the in-production fE / fS computation iterates
  the same way as standalone, but the `Math.floor(len / hopS)` vs
  `Math.floor(mono.length / hop)` could land on slightly different last-
  frame boundaries that shift array indices.
- `anaBar1Sec` micro-difference: production reads `barDownbeatFrame / ar`
  at the point drop-detection runs (after walk-back + sampler-snap), while
  offline used `analyzerFirstDownbeatSec` from the snapshot (= same value
  but written to and read back from JSON, which round-trips through
  float64 → string → float64 with possible 1-ulp drift).

I instrumented the divergence but didn't isolate the exact cause within the
2-hour cap on this task.

## Step 7 — Decision

Per task spec:
> If a narrow extension exists with predicted +1-3 rescues / 0 regressions,
> implement it as a production fix. If not, do not ship.

The proposed extension delivered net **0** in production (+1 rescue, -1
regression). **Reverted, not shipped.**

The offline diagnostic infrastructure is now an unreliable predictor of
in-production behavior. Until the divergence is understood, any further
"offline says +N" prediction needs to be validated with a full production
harness run before committing.

## Recommended follow-up

1. **Reconcile the offline/production divergence**: extract the exact
   snap+filter behavior on Boundless Heart and Somewhere step-by-step
   (per-breakdown trace of `eHere`, `ePrev`, `minEnergy`, `snappedT`)
   from both code paths. Probably 1-2 hours to pinpoint.
2. **Once reconciled, re-evaluate the breakdowns ≥ 2 gate**: if the
   offline tool can be trusted, the +2 rescue prediction may be
   reproducible by a slightly different production gate formulation
   that accounts for whatever the divergence is.
3. **Or accept that drop-detection has hit its ceiling**: the existing
   ship at +2 (commit `9ba92fe`) may be the most we can get without
   significantly redesigning the snap logic to be more permissive.

## Status

- `src/bpm-worker-source.js`: reverted to clean master (no uncommitted
  changes).
- Harness baseline: 199/272 = 73.2% unchanged.
- Diagnostic finding: drop-detection's offline/production divergence
  blocks safe extension via the breakdowns gate as conceived.
