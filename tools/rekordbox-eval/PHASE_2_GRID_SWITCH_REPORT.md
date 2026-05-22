# Phase 2 — Recon Report (revised after UX-consistency pivot, May 21 2026)

## Pivot note

The original Phase 2 plan (Rekordbox-PWV5 waveforms for tracks in the
user's Rekordbox library, analyzer-decoded waveforms for the rest) was
a two-tier UX that would be unshippable as a real DJ product. Every
track in the app must look and behave the same. This report is the
revised plan.

## TL;DR

**Path A: Uniform analyzer-derived waveforms + best-available grid
sources behind a uniform UX.**

- **Waveform render path:** the local 3-band analyzer (already running
  on every track via `wfBass`/`wfMid`/`wfHigh`) feeds a new
  Pioneer-style spectral color renderer. Applied to ALL tracks.
  PWV5 is dropped from the runtime render path.
- **Grid path:** Rekordbox PQTZ when available (perfect accuracy);
  analyzer's 80.9% PASS grid otherwise; manual ±1 beat anchor button
  (already shipped) for the residual misses. The user sees the same
  waveform aesthetic regardless; grid precision varies invisibly per
  track.
- **PWV5 role:** kept in the codebase as a calibration reference for
  analyzer tuning, and as a future option for cue-point rendering.
  Not on the render hot path.
- **Feature flag:** `const USE_RB_GRID = true;` near imports. Toggles
  grid override only. Renderer is uniform regardless of flag state.
- **Estimated effort:** 15-25 hours total. ~10 hrs renderer + tuning,
  ~10 hrs grid override + edge cases, ~5 hrs buffer for calibration
  iteration.

## Why the pivot

A library that mixes pretty colored waveforms with plain amplitude
waveforms is a non-starter for a working DJ. Loading 4 tracks for a
set where 3 are in your Rekordbox library and 1 isn't would produce
visibly inconsistent decks — different waveform style, different visual
behavior — and break the product's perceived quality.

Two paths address this:

- **Lift everyone to PWV5-quality:** use Rekordbox's waveform on every
  track. Impossible because non-Rekordbox tracks have no PWV5 data.
- **Bring everything down to a common renderer:** use our local
  analyzer's 3-band output for every track, render through one path.
  This is Path A.

## Critical realization: we already have a 3-band analyzer

The local audio analyzer in `Deck.jsx` already extracts 3-band
envelopes on every track load:

- `wfBass` — low frequency envelope (sub + bass)
- `wfMid` — mid frequency envelope (vocals, snares, instruments)
- `wfHigh` — high frequency envelope (hi-hats, cymbals, presence)

The smaller per-deck WF (the one at line ~4290) already renders from
these. The bigger top waveform (`AnimatedZoomedWF`) currently folds
the bands to a single bass-weighted scalar (line 3141) and paints in
deck-identity color (line 3249). The COLOR information from the bands
is being discarded.

**So Phase 2 isn't building a new analyzer — it's surfacing band data
that already exists, in a Pioneer-style color formula, on all tracks.**

## Architecture (Path A)

### Waveform pipeline (uniform across all tracks)

```
Audio file (any source)
   ↓
Local audio decode (OfflineAudioContext + biquad filters in Deck.jsx)
   ↓
{ bass, mid, high } envelope arrays per track (already happens today)
   ↓
Spectral color formula (NEW) — column-by-column RGB driven by band intensities
   ↓
Render: AnimatedZoomedWF + small WF (modified to consume color per column)
```

PWV5 (Rekordbox waveform data) bypassed. Phase 1 PWV5 reader code
stays in the codebase for now — useful for calibration during tuning
and possibly for future Phase 3 cue-point rendering — but not called
from the render path.

### Grid pipeline (best-available per track, invisible to user)

```
Track loads
   ↓
Local audio decode → analyzer worker → bpm.results[deck]
                                       { bpm, beatPeriodSec, ... }
   ↓
IF track matches Rekordbox library AND USE_RB_GRID:
   getBeatGrid(trackId) → { bpm', beatPeriodSec', ... }
   Override bpm.results[deck] via effectiveBpmResults useMemo
   ↓
Renderer + sync engine read effectiveBpmResults[deck]
```

When Rekordbox PQTZ is available: perfect grid (every kick on a
grid line, by definition).

When not: analyzer's 80.9% grid (kicks on grid most of the time;
manual ±1 beat anchor button corrects the rest).

The user does not see a UI difference between these two cases. They
see a uniform waveform aesthetic, with grid accuracy varying
invisibly per track.

## What changes from the current code

| Area | Change |
| --- | --- |
| `AnimatedZoomedWF` | New spectral color render mode. Per-column RGB from band intensities (replaces deck-color solid fill). Heights stay bass-weighted as today. |
| Small `WF` component | Same spectral color treatment so both renderers match. |
| `collabmix-production.jsx` Rekordbox useEffects (the ones hotfixed last turn) | `setWfA`/`setWfB` from Rekordbox bands → no longer needed (waveform comes from local analyzer). Keep `setRkGridA`/`setRkGridB` for the grid override. |
| `rekordbox-library.js` | Add `getBeatGrid(trackId)` returning derived PQTZ fields. ~30 LOC. |
| `collabmix-production.jsx` | Add `USE_RB_GRID` const, `rkGridA`/`rkGridB` state, `effectiveBpmResults` useMemo, ~10 consumer renames. ~50 LOC. |

## What does NOT change

- Local audio engine (createEngine, AudioBufferSourceNode lifecycle)
- Manual override UI (`gridOffsetMs` / `barOneOffset` / `bpmNudge`)
- useBPM worker / analyzer code
- Sync engine algorithm (Path C, beat-phase, quantize)
- WebRTC / multi-user state sync
- Driver model
- Library import / persistence / dedup
- PWV5 / PWV4 / PCO2 connector code (stays, just unused on the
  render path)

## The color formula (Mix//Sync brand, NOT Pioneer's orange/blue)

Per user direction May 21, 2026:

> Mix//Sync brand identity (deck color base, tonal variation by
> frequency, near-white at peaks). Not Pioneer's orange/blue. We will
> iterate on the exact formula together using the existing screenshots
> as reference.

Provisional first-cut formula (coefficients tuned together post-build):

```js
// Per-column spectral color (replaces solid deck-color fill in Pass 2b)
const total = bv + mv + hv + 1e-6;
const centroid = (mv * 0.5 + hv * 1.0) / total;   // 0=all bass, 1=all high
const env = (0.7*bv + 0.2*mv + 0.1*hv) / envMax;  // bass-weighted amplitude

// Tonal shift around the deck color: bass darkens, highs lighten.
// Keeps deck identity dominant; frequency adds subtle modulation.
const tonalAmt = (centroid - 0.5) * 0.5;          // -0.25..+0.25
let cR = dr, cG = dg, cB = db;
if (tonalAmt > 0) {
  cR += (255 - dr) * tonalAmt;
  cG += (255 - dg) * tonalAmt;
  cB += (255 - db) * tonalAmt;
} else {
  const k = 1 + tonalAmt;                          // 0.75..1.0 — darken
  cR *= k; cG *= k; cB *= k;
}

// Peak push toward white at full amplitude.
const peakAmt = Math.pow(env, 1.5) * 0.65;
cR += (255 - cR) * peakAmt;
cG += (255 - cG) * peakAmt;
cB += (255 - cB) * peakAmt;

ctx.fillStyle = `rgb(${cR|0},${cG|0},${cB|0})`;
```

Per-deck identity preserved: violet for A (`#7B61FF`), teal for B
(`#00BFA5`). No cross-tinting between decks. The silhouette gradient
in Pass 2a stays in pure deck color so the overall waveform shape reads
as deck identity at a glance; the per-column brightness overlay (Pass
2b) carries the spectral modulation.

This is iteration coefficient #1. Knobs to adjust:
- `0.5` in tonalAmt: tonal-shift intensity (raise for bolder frequency cues)
- `0.65` in peakAmt: how strongly peaks bleach toward white
- `1.5` exponent: peak-curve steepness (higher = more "snap" at the top)

## Edge cases

| Case | Behavior |
| --- | --- |
| Track in Rekordbox library, has PQTZ | Grid override applies. Waveform identical to non-RB track. |
| Track in Rekordbox library, no PQTZ (rare) | Grid falls back to analyzer. Waveform unchanged. |
| Track NOT in Rekordbox library | Grid from analyzer. Waveform from analyzer. (Identical UX to the case above.) |
| `USE_RB_GRID = false` | All grids from analyzer. Waveform unchanged. |
| Partner-driver loaded a track | Local UI reads `effectiveBpmResults`. Partner's Rekordbox library is not accessible, so partner-driven Rekordbox tracks fall back to whatever BPM the partner broadcasted via `deck_update`. Waveform comes from partner-broadcast bands (existing path). |

## Sync engine implications (unchanged from original recon)

| Component | Affected? |
| --- | --- |
| Path C kick-band cross-correlation | No — operates on raw audio |
| Beat-phase alignment | Yes (intended) — consumes overridden values for Rekordbox tracks |
| Auto-position playhead on track load | Yes (intended) — `firstBar1AnchorSec` from Rekordbox |
| Quantize-to-grid arrows | Yes (intended) — step size matches Rekordbox |
| Manual nudge UI | No — applied on top of either grid source |
| Local audio engine | No |

## Risks

1. **Visual fidelity gap.** Our analyzer's color output will not be
   pixel-identical to Pioneer's PWV5. With ~5-10 hrs of tuning using
   PWV5 as reference, we should get to "indistinguishable to a working
   DJ in normal use." Blind A/B at high zoom may expose differences.
   Acceptable.
2. **Per-deck WF wiring.** The smaller per-deck WF already consumes
   `wfBass`/`wfMid`/`wfHigh`, so it auto-benefits from any band
   renderer changes. The bigger `AnimatedZoomedWF` currently consumes
   parent `wfA`/`wfB` (which gets fed by local decode via
   `Deck.onWaveform` → `setWfA`). Confirm wiring matches end-to-end
   so both renderers paint the same data.
3. **Variable-tempo Rekordbox grids.** PQTZ stores per-beat tempo;
   our sync model collapses to first-entry BPM. Same drift behavior
   as today's analyzer. Parity, not regression.
4. **Calibration loop time.** Tuning band cutoffs + gamma + color
   coefficients takes iteration. Budget 5-10 hours of trial-and-error
   with side-by-side reference comparison.

## Reversibility

`USE_RB_GRID = false` reverts grid behavior. The new renderer applies
to all tracks regardless, so the visual change is permanent (this is
the goal — uniformity). If we want to revert the renderer too, the
old monochrome-with-deck-color path is preserved in git for one-commit
rollback.

## LOC estimate (revised)

| File | Change | LOC |
| --- | --- | --- |
| `src/rekordbox-library.js` | Add `getBeatGrid(trackId)` | +30 |
| `src/collabmix-production.jsx` | `USE_RB_GRID` const, `rkGridA/B` state, fetch in existing Rekordbox useEffects | +30 |
| `src/collabmix-production.jsx` | `effectiveBpmResults` derived state + ~10 consumer replacements | +25 |
| `src/collabmix-production.jsx` | Remove `setWfA`/`setWfB` from Rekordbox useEffects (waveform from analyzer now) | -5 |
| `src/collabmix-production.jsx` / `AnimatedZoomedWF` | Spectral color rendering, both renderers | +60-80 |
| `src/collabmix-production.jsx` / `Deck.jsx` | Confirm bands wired uniformly into both top and per-deck renderers | +5 |
| **Total** | | **~150-170 LOC** |

## Status: implementation landed, awaiting visual review

- ✅ Path A sign-off received May 21, 2026
- ✅ Color palette locked to Mix//Sync brand (deck color base, NOT
  Pioneer orange/blue)
- ✅ Sub-decision: drop the obsolete `setWfA(bands)` from Rekordbox
  useEffects (clean uniformity, no second feature flag)
- ✅ Implementation landed locally:
  - `USE_RB_GRID` feature flag near imports
  - `getBeatGrid(trackId)` in `rekordbox-library.js`
  - `rkGridA` / `rkGridB` state + Rekordbox useEffects rewritten
    (fetch grid, no waveform override)
  - `effectiveBpmResults` useMemo + transparent `bpm` shadow useMemo
    (no consumer-site renames needed)
  - Spectral color rendering in both `WF` (small per-deck) and
    `AnimatedZoomedWF` (top zoomed) — uniform across ALL tracks
- ✅ `npm run build` green, dev server boots clean
- ⏳ Visual review with user (side-by-side vs earlier "before"
  screenshot); color formula coefficient iteration

## Known minor follow-up

If the analyzer's `firstBar1AnchorSec` happens to arrive BEFORE the
Rekordbox grid lookup completes (rare — Rekordbox grid fetch is ~1-50
ms, analyzer is ~1-5 sec, so the reverse race is the norm), the
auto-position useEffect's `positionedBufRef.current === buf` guard
prevents a re-position when the Rekordbox grid arrives. The visible
effect is the initial playhead landing on the analyzer's anchor for
that one load instead of Rekordbox's. Once the user plays or scrubs,
sync math uses Rekordbox's grid regardless. Acceptable for V1; fix
shipped only if observed in practice.

## Open follow-ups (out of scope for Phase 2)

- Phase 3 cue-point rendering (PCOB/PCO2 are already parsed in Phase 1)
- Variable-tempo grid support (would require sync engine changes)
- Telemetry on which tracks the manual nudge gets used on
  (informs future analyzer improvements)
- Analyzer telemetry-driven gain in accuracy via real-user-correction
  data (long-term, possibly post-launch)
