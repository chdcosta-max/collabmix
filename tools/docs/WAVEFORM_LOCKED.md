# Top Zoomed Waveform — LOCKED. DO NOT REGRESS WITHOUT APPROVAL.

> **STATUS: LOCKED — June 26, 2026.** The top zoomed waveform (`AnimatedZoomedWF`
> in `src/collabmix-production.jsx`) aesthetic was tuned over an extensive,
> eye-by-eye session against the **real Rekordbox waveform** as the reference.
> Every value below is a deliberate, interdependent default. **Do NOT change any
> `WF_*` default, depth/glow preset, band RGB, or the paint/glow/cap/gate logic
> without Chad's explicit approval.** A code banner at the `WF_*` constants block
> (~line 159) and above `AnimatedZoomedWF` points here.
>
> The URL knobs (`?wfSat=`, `?wfglow=`, `?wfMidScale=`, …) remain for **A/B
> tuning only** — they override at runtime but must not become the new defaults
> without sign-off. `?wfflat=1` reverts to the old flat look for comparison;
> `?wfCreamDbg=1` paints the cream layer magenta for diagnostics.

The waveform is three frequency bands rendered per column, composited as an
**additive bloom underneath + a deep opaque crisp core on top**, against pure
black:

- **Blue/purple lows** (`hLow`) — the bass body; per-deck identity colour
  (A `#2E86DE`, B `#A855F7`). The dominant mass; kicks punch above amber.
- **Amber mids** (`hHigh`) — full-bodied dynamic band, opaque, capped under blue.
- **Cream highs** (`hMid`) — the KICK transient; solid opaque markers, gated so
  only highs-with-bass (kicks) read full; hi-hats/claps stay subdued.

`hHigh`/`hLow`/`hMid` are the height arrays; the **structure** that builds them
(onset/attack, the kick-triangle geometry, the blue duck-and-swell arc, the
two-layer architecture) is correct and was NOT touched during the aesthetic
work — only colour, opacity, glow, the amber cap, and the kick gate.

---

## Locked values (all in `src/collabmix-production.jsx`)

### Colour & depth (depth preset `?wfdepth=2`, the default)
| Constant | Value | What it does | Why this value |
|---|---|---|---|
| `WF_BLEND` | `source-over` | blue+amber+cream composite in the offscreen | additive/`screen` washed overlaps pale; source-over keeps colours deep & mixed |
| `WF_SAT` | **1.90** | saturation boost in `deepen()` | **pinned HIGH on purpose**: at this level the min RGB channel hits 0 (e.g. `#2E86DE`→`[0,123,255]`), so the additive glow **cannot wash blue toward sky-blue/pastel**. The headline colour fix. |
| `WF_VAL` | 0.92 | value/brightness in `deepen()` | luminous enough to glow; not dark (a dark base only let amber glow, not blue) |
| `WF_TIP_MUL` | 0.72 | amber/blue peak-tip multiplier (<1 = darken) | recesses the between-beat peak highlights so they sit back and feed a dimmer, less-white glow — lets the kicks dominate |
| `WF_CREAM_TIP` | 1.15 | cream/kick tip multiplier (>1 = brighten) | kick keeps a bright tip and stays the dominant marker while amber/blue peaks recede |
| `WF_BLUE_ALPHA` | 1.0 | blue layer opacity | solid bass body |
| `WF_CREAM_ALPHA` | **1.0** | cream/kick opacity | **solid opaque kicks** like Rekordbox; 0.6 looked see-through/washy |
| `WF_AMBER_OVER` | **1.0** | amber layer opacity (over blue) | **opaque so no deck base bleeds through** — at <1 the blue base's green channel washed amber to pale yellow on deck A while deck B stayed rich; opaque = identical rich amber on both decks |
| `WF_GRAD` | 1 | per-bar vertical gradient (cached) | adds within-bar depth (deep centre → tip per `WF_TIP_MUL`/`WF_CREAM_TIP`) |
| `WF_TIP_WHITE` | 0 | additive white tip lift | OFF — the old pale preset-0 path; white lift = pastel |
| Band RGB | amber `[240,165,50]`, cream `[245,238,210]`, lows = per-deck `#2E86DE`/`#A855F7` | the three anchors | warm amber mids + soft cream highs + deck-identity lows |

### Glow / bloom (glow preset `?wfglow=2`, the default)
| Constant | Value | What it does | Why |
|---|---|---|---|
| `WF_GLOW_PX` | 5 | tight bloom blur radius (×dpr) | **tight** so bars keep crisp edges and gaps don't bridge into a tube |
| `WF_GLOW_A` | 0.60 | additive bloom intensity | luminous glow against black without over-accumulating to white |
| `WF_GLOW_PX2` / `WF_GLOW_A2` | 0 / 0 | wide soft halo | **OFF** — the wide pass was the foggy/hazy/smeared look |

Bloom = the bands rendered once to an offscreen canvas, drawn to the visible
canvas additively + blurred (UNDER), then the same offscreen drawn opaque crisp
(OVER). Core stays deep & saturated; only the halo blooms.

### Amber height & dynamics
| Constant | Value | What it does | Why |
|---|---|---|---|
| `WF_MID_SCALE` | 0.95 | amber height | full-bodied co-equal band that rides just under blue (Rekordbox) |
| `WF_MID_GAMMA` | 1.35 | amber contrast curve | its own dynamic rise/fall; higher crushed it to a sliver, lower = flat |
| `WF_MID_SMOOTH` | 14 ms | amber smoothing | low, so melodic detail shows; 30ms averaged sustained mids into a flat line |
| `WF_MID_PCT` | **1.0** (abs-max) | amber normalization reference | **abs-max, not p95**: p95 clamped any loud/mid-heavy section to the ceiling → a dead flat tube. Abs-max lets loud mids ride below the ceiling and keep varying. |

### Amber cap (keep amber under blue, but show melody in breakdowns)
| Constant | Value | What it does | Why |
|---|---|---|---|
| `WF_AMBER_CAP` | 1 (on) | enable the cap | — |
| `WF_AMBER_CAP_RATIO` | 0.68 | at a kick, amber ≤ blue×ratio | blue punches ~32% above amber as a **solid** shape (at 0.92 amber covered the blue down to a sliver) |
| `WF_AMBER_OPEN` | 0.45 | blue-envelope level that counts as a FULL kick | below it the cap **opens** proportionally so amber shows melodic shape over a faint breakdown bass — fixes the breakdown flat-tube. The cap uses a max-hold blue envelope (decays ~1 beat) so inter-beat gaps bridge but long breakdowns open. |
| `WF_AMBER_CAP_FLOOR` | 0.16 | min amber ceiling | keeps a little body in true gaps without a filled tube |

### Kick definition (cream = highs; gate to kicks)
| Constant | Value | What it does | Why |
|---|---|---|---|
| `WF_KICK_SCALE` | 0.86 | trims cream kick-needle height | kicks were a touch too big vs Rekordbox |
| `WF_KICK_HI_FLOOR` | 0.28 | cream height for highs WITHOUT coincident bass | subdues hi-hats/claps so the KICK (highs+bass) is the clear beat marker |
| `WF_KICK_LOW_REF` | 0.5 | bass level (frac of track max) = a full kick | smoothstep threshold for "this beat has a kick" |

(`WF_BLUE_SCALE` 2.0, `WF_BLUE_PEAK` 0.22, `WF_BLUE_RISE` 0.6, `WF_BLUE_CHAR`
0.3, `WF_BODY_GAMMA` 1.2, `WF_FILL` 0.97, `WF_KICK_WIN_MS` 70 — blue arc / kick
geometry, part of the untouched STRUCTURE; left as-is.)

---

## Tried & REJECTED — do not re-litigate

- **Additive/`screen` blend for the body** → washed overlaps pale; amber+blue
  (near-complementary) blew to white. Fix: `source-over` + high saturation.
- **Pale / pastel colours (low saturation, white tip-lift)** → cheap, sky-blue.
  Fix: `WF_SAT` 1.90 so the min channel pins to 0 and the glow stays in-hue.
- **Dark base for "depth"** → only the bright band (amber) glowed; blue went
  dim/dark. Fix: keep `WF_VAL` high (0.92) and get richness from saturation+glow.
- **Wide soft glow halo** (`WF_GLOW_PX2`>0) → foggy/hazy/misty, smeared edges,
  and bridged kick-gaps into a tube (same failure that removed an earlier glow).
  Fix: TIGHT bloom only.
- **Flat amber ribbon / flat tube** → caused by (a) p95 normalization clamping
  loud sections to the ceiling, and (b) a flat floor cap clamping amber in
  no-blue breakdowns. Fix: abs-max normalization + blue-envelope cap that opens
  in breakdowns (`WF_AMBER_OPEN`).
- **Amber as a thin sliver** (over-corrected the slab) → too small. Fix:
  `WF_MID_SCALE` 0.95 full-bodied.
- **Amber as a flat pale-cream/beige SLAB** → it was a continuous tall band drawn
  translucent over blue = a 50/50 amber-blue tan bed. Fix: opaque amber
  (`WF_AMBER_OVER` 1.0) + dynamic height + cap.
- **Translucent amber** → looked different per deck (yellow on blue, rich on
  purple) because the base bled through. Fix: opaque amber.
- **Amber capped at 0.92×blue** → amber covered the blue kick down to a sliver,
  blue not solid. Fix: ratio 0.68 so blue punches above.
- **See-through cream kicks (alpha 0.6)** → washy, not solid. Fix: alpha 1.0.
- **Gating the CREAM to fix "hi-hat" texture** → the white between beats is NOT
  the cream layer (confirmed with `?wfCreamDbg=1`: magenta only at beats). It's
  the bright amber/blue peak tips/glow. Fix: darken amber/blue tips
  (`WF_TIP_MUL` 0.72), keep cream tip bright (`WF_CREAM_TIP` 1.15).
- **Render smear / two-canvas CSS-blur glow** → removed earlier for washing out
  and bridging gaps; the current offscreen bloom replaces it.

## How it renders (pointer)
`AnimatedZoomedWF` draw loop: builds `hLow`/`hHigh`/`hMid` per column (structure),
applies the amber percentile-norm + blue-envelope cap + kick gate, then in the
paint block renders the three bands to an offscreen via `mkPaint()` (`deepen()` +
per-band gradient tip), composites additive-blurred bloom under + opaque core
over, then draws grid/playhead on top. Search `AESTHETIC LOCKED` in the source.
