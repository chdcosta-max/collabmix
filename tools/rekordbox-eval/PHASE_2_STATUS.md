# Phase 2 — Status at hand-off (May 21, 2026)

Tabled here for dogfood feedback. Resume after we learn which visual
gaps actually matter to users in real sessions.

## Final shipped state

**v3 anchor-lerp formula** (commit `8184359`).

Per-column color = `lerp(bassAnchor, trebleAnchor, spectralCentroid)`,
then peak-bleach toward white at high amplitude. Single formula
applied uniformly across:
- `WF` (small per-deck waveform, h=40 in actual use)
- `AnimatedZoomedWF` (big top scrolling waveform)
- All tracks regardless of source (Rekordbox-imported or freshly
  decoded)

Spectral data path: existing local audio decoder in `Deck.load()`
(IIR filters at 300 Hz and 3500 Hz cutoffs producing 3-band envelopes
at WF_W = 24,000 columns) → **joint normalization** to a common max
(commit `935ca18`, fixes the subtle-contrast root cause from v1) →
per-column lerp formula.

## What's working

- ✅ **Visual parity across track sources** — Rekordbox-imported and
  freshly imported tracks render through the same pipeline, no two-
  tier UX, no "RB" badge or source indicator.
- ✅ **Grid override for Rekordbox-imported tracks** — `getBeatGrid()`
  reads PQTZ entries and overrides analyzer's
  `firstBar1AnchorSec` / `beatPeriodSec` / `beatPhaseFrac` /
  `beatPhaseSec` via the `effectiveBpmResults` useMemo. Kicks land
  on grid lines by definition for Rekordbox tracks.
- ✅ **Non-Rekordbox tracks unaffected** — analyzer's grid (80.9%
  PASS within ±20ms) used as before. Manual ±1 beat anchor button
  handles the residual ~19% misses. Same UX for both cases.
- ✅ **Peak-bleach toward white** — drops with full-spectrum energy
  bleach near-white at peak amplitude (peakAmt = pow(env, 2.0) ×
  0.85). Reads as visual "punch" on heavy moments.
- ✅ **Waveform sizing / density / shape** — gamma curves, gradient
  silhouette, centerline weight band all unchanged and well-tuned.
- ✅ **Feature flag** — `USE_RB_GRID = true` near imports;
  flip-and-rebuild reverts grid override without touching renderer.
- ✅ **Sync / quantize / nudge** — all read from `bpm.results.X` via
  the transparent `bpm` shadow useMemo. Rekordbox grid drives sync
  audibly when present.
- ✅ **Console marker** for path verification:
  `[WF-BANDS] Phase 2 joint-norm path active for deck X — jointMax=…`
  Fires on every track load. Confirms not a stale cached bundle.

## Known visual gap (the reason we're tabling)

**Spectral contrast between bass and treble sections is subtle
relative to Pioneer's Rekordbox reference.**

The current anchors produce visible-but-not-dramatic differentiation:
- Kick column (centroid ≈ 0.08): `rgb(88, 43, 186)` — deep purple
- Hi-hat column (centroid ≈ 0.72): `rgb(152, 153, 234)` — light
  lavender

These are distinct hues, not just shades — which v1/v2 weren't — but
they don't carry the same dramatic visual impact as Rekordbox's
orange/blue/white palette (which we intentionally rejected in favor
of Mix//Sync brand identity).

**Critically — diagnostic data captured in commit `ef4a2f8` confirmed
this is a color-formula problem, NOT a pipeline problem:**
- Raw band envelopes show clean separation across kick / hi-hat /
  drop / quiet / peak columns
- Joint normalization keeps the contrast through normalization
- Spectral centroid math discriminates correctly (0.079 / 0.722 /
  0.503 / 0.500 / 0.358 across the 5 exemplar columns)
- RGB output is what the formula produces given correct centroids

**The anchor RGB values are the lever to dial. Architecture is
sound.**

## Current anchor RGB values (starting points for next iteration)

| Deck | Base color | Bass anchor | Treble anchor |
| --- | --- | --- | --- |
| A | violet `#7B61FF` / rgb(123,97,255) | `rgb(80, 30, 180)` — deep saturated magenta-purple | `rgb(180, 200, 255)` — light lavender / periwinkle |
| B | teal `#00BFA5` / rgb(0,191,165) | `rgb(0, 80, 90)` — deep teal | `rgb(160, 240, 240)` — light cyan |

Defined in `deckSpectralAnchors(colorHex)` helper at the top of
`AnimatedZoomedWF` / `WF` block in `src/collabmix-production.jsx`.
Easy single point to tune.

## Recommended next iterations (when revisited)

In order of likely impact:

1. **More extreme anchor RGB values.** Push bass anchor darker /
   more saturated (e.g., Deck A bass: try `rgb(50, 0, 120)` — near-
   black violet); push treble anchor lighter / cooler (e.g., Deck A
   treble: try `rgb(220, 230, 255)` — near-white blue tint). The
   wider the anchor distance in RGB-perceptual space, the more
   dramatic the centroid lerp.

2. **Saturation lift on bass side.** Bass columns currently render
   in the deep anchor; we could additionally boost saturation
   (HSL space) for centroid < 0.3, so kicks read as
   actively-saturated rather than just deep. Risk: oversaturated
   bass could clash visually. Worth a single pass + screenshot.

3. **Two-color blend per pixel (deck color + anchor).** Instead of
   lerp(bassAnchor, trebleAnchor), use deck base color as a third
   stop:
   ```
   centroid < 0.5: lerp(bassAnchor, deckBase, centroid * 2)
   centroid ≥ 0.5: lerp(deckBase, trebleAnchor, (centroid-0.5)*2)
   ```
   Deck identity dominates the middle band; anchors take over at the
   extremes. May read more cohesively as "Mix//Sync brand."

4. **Reconsider peak-bleach curve.** Currently `pow(env, 2.0) × 0.85`.
   If anchors are pushed more extreme, peak-bleach intensity may
   need to drop (e.g., × 0.65) so saturated bass columns don't
   immediately wash to white at the kick attack.

5. **Per-column color smoothing.** Adjacent columns can flip
   centroid abruptly between consecutive samples (especially at low
   amplitude). A 3-column rolling average on the centroid might
   reduce visual noise without losing transient detail.

6. **Consider falling back to literal Pioneer orange/blue/white if
   brand-identity colors can't reach the visual bar.** Dogfood
   feedback will tell us if "Mix//Sync identity" reads as worth the
   contrast cost. Code path is one helper function — trivial to
   swap.

## What does NOT need revisiting

- Band extraction / IIR filters — confirmed working via diagnostic
- Joint normalization — fix for the v1 root cause, stays
- Spectral centroid math — correct, produces expected values
- Grid override pipeline — Phase 2's other big deliverable, fully
  working
- PWV5 connector — untouched, stays for future cue-point work
- Sync engine — unaffected by any of this; uses `effectiveBpmResults`

## Resume conditions

Re-open when one of:
- Dogfood session with partner exposes specific waveform readability
  pain points
- We have a side-by-side reference screenshot pair (current vs target)
  to anchor anchor tuning against
- A Phase 3 (cue-point rendering) or Phase 4 (non-Rekordbox track
  fallback) brings related rendering work into scope

## Live state summary

- Latest commit: `8184359` (v3 anchor-lerp)
- Live bundle: rotates on each push
- All changes pushed to `origin/master`, auto-deployed via Vercel
- No uncommitted local changes
- Grid override active and working for Rekordbox-imported tracks
- `[WF-BANDS]` console marker active for verification
- No `[WF-DIAG]` diagnostic noise (removed in v3)
