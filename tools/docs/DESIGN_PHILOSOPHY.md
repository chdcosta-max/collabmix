# Mix//Sync Design Philosophy — Working Draft

## Direction

"Quiet Pro Tool" — Japanese minimalism applied to a serious DJ platform. Restrained, considered, modern. Every element earns its place. Confidence without shouting. The opposite of loud DJ software.

## Target Audience

Primary: existing pro/intermediate DJs (Rekordbox/Serato users) who want remote B2B collaboration.

Secondary: aspiring DJs who find Rekordbox's complexity intimidating.

## Brand Personality

The talented friend who's been DJing for 10 years, has great taste, knows their gear, and helps you sound good without being a snob about it.

## Core Aesthetic Principles

### Restraint as a virtue
Less is more. Each element must earn its place. When in doubt, remove it.

### Information density done well
Rekordbox-level density for data (library, BPM, key, etc.) but executed with Ableton-level cleanliness. Dense but never crowded.

### Negative space is a real design element
Breathing room around primary controls. Generous spacing between sections. White space communicates confidence.

### Functionality is the aesthetic
Don't decorate. Function shapes form. The visual design emerges from what the tool does, not from imposed styling.

### Quiet confidence
The opposite of loud or shouty. Confident defaults, no second-guessing the user, no aggressive animations or attention-grabbing elements.

### One small detail can carry the whole design
A perfectly considered control, a beautiful waveform, an animation that feels exactly right. Quality of details over quantity of features.

## What This Means Visually

### Colors (current — pure black + high-contrast cool pair, May 26, 2026 evening)
- Background: **pure black** `#000000` — OLED-optimized, maximum
  contrast for saturated deck identity colors against the page. The
  black background is the substrate that lets the high-saturation
  deck colors "pop" rather than wash out.
- Panels / surfaces: cool dark greys, slightly lifted (`#15171A`,
  `#1F2126`)
- Text: **clean white** `#F5F5F7` (NOT warm white)
- Borders: cool whites at low alpha — `rgba(255,255,255,0.06)` subtle,
  `rgba(255,255,255,0.12)` defined
- **Single accent: white at varying opacity. No amber, no warm accent.**
  Three tiers, used everywhere an accent is needed:
  - **Primary** `rgba(255,255,255,0.9)` — active states, primary
    indicators (active sidebar border, active play / sync glow center)
  - **Secondary** `rgba(255,255,255,0.6)` — hover states, secondary
    info (minor-key Camelot text, secondary metadata)
  - **Tertiary** `rgba(255,255,255,0.3)` — borders, dividers, inactive
    pill outlines
- **Active state on buttons: clean white** — NO green. Sync engaged,
  M (master) engaged both get a white glow / brightness lift matching
  the white play button when playing. Green removed from active-state
  palette entirely; retained only for semantic indicators (recording
  in progress, partner online dot, Rekordbox "ready" badge) — held in
  the `STATUS_OK = "#22c55e"` constant, decoupled from any deck color.
- Deck identity colors — **high-contrast cool pair**, saturated enough
  to feel alive against the pure-black background. Both stay in the
  cool family (no warm waveforms — long-session eye fatigue concern,
  see "Why no warm deck colors" below), but A vs B reads through
  strong hue contrast (blue vs purple), instant distinction from
  across the screen:
  - Deck A: `#2E86DE` — **Vivid Ocean Blue**. Saturated, alive,
    distinct. NOT Material `#1976D2` (consumer-app feel), NOT
    `#3D5A80` (May 26 atmospheric — read as dead / lifeless), NOT
    Pioneer cyan.
  - Deck B: `#A855F7` — **Electric Royal Purple**. Saturated cool
    violet; pairs with Ocean Blue through hue contrast rather than
    temperature. NOT Material green `#00C853` (party DJ), NOT
    `#5F8B95` (May 26 atmospheric — too similar to Deck A in the
    cold-and-similar pair).

> **Why these colors:** Three iterations today led here.
> (1) The May 23 Quick Wins Material pair (`#1976D2` / `#00C853`)
> read as consumer-app / Android. (2) The May 26 atmospheric pair
> (`#3D5A80` / `#5F8B95`) over-corrected: both colors landed in the
> same low-saturation cool-blue family and read as cold, dead, and
> insufficiently distinct from each other in side-by-side decks. The
> "atmospheric depth" goal was deferred to Path A glow rendering and
> these were the WRONG flat-fill defaults to wait on it with —
> waveforms felt lifeless even with the deck cards otherwise intact.
> (3) The high-contrast cool pair fixes both failure modes: saturated
> enough to feel alive immediately (no waiting on Path A) AND
> distinct enough that A vs B is unambiguous from across the screen.

> **Why no warm deck colors:** Long DJ sessions are stare-tasks —
> the eye locks onto waveforms for minutes at a time. Warm hues
> (orange, coral, amber, red) at the saturation needed for deck
> identity cause cumulative eye fatigue under those conditions.
> Pro DJ tools historically optimize for stareable colors: cool
> family for waveforms, warm reserved for tiny accents (cue points,
> phrase markers, recording dot — milliseconds of attention, not
> minutes). The high-contrast cool pair stays inside this rule —
> A vs B distinction comes from hue family (blue vs purple), not
> temperature. The 16-bar phrase marker red (`#FF3B30`) remains
> the only warm hue in the working surface, and only at marker
> scale, not as a fill.

### Banned colors

- **`#1976D2`** — Material Design blue 700. Reads as Android / consumer
  app. Retired May 26 morning.
- **`#00C853`** — Material Design green A700. Reads as bright
  party-DJ / Maschine. Retired May 26 morning.
- **`#3D5A80`** — Twilight Blue (atmospheric). Too desaturated as a
  flat-fill default; reads cold, dead, lifeless against pure black
  without the Path A glow rendering it was waiting on. Retired
  May 26 evening.
- **`#5F8B95`** — Atmospheric Teal. Same failure mode as `#3D5A80`,
  compounded by being in the same cool-blue hue family — A vs B
  decks were nearly indistinguishable. Retired May 26 evening.
- **Any Material Design primary** at full saturation. The full
  Material palette is calibrated for consumer Android UI density and
  signals the wrong product category for a pro DJ tool.
- **Warm deck colors at fill saturation** — orange, coral, amber,
  red as deck identity. Eye-fatigue concern for long sessions where
  the waveform is a stare-task. Warm reserved for marker-scale uses
  only (cue points, phrase markers, recording dot).
- **Bright neon greens at fill saturation** in deck identity slots —
  party / DJ-software aesthetic, the opposite of "Quiet Pro Tool."
  (Note: `#22c55e` retained at the smaller scale as `STATUS_OK`
  semantic green — online/ready/recording. Smaller surface, shorter
  attention, different role.)
- **Pale warm accents (amber `#D4A06A`, oak `#C9B79C`, sepia)** —
  tried at v5–v5.10 and May 21, retired May 24. Even one warm hue
  against the cool/black surfaces broke the Beatport / Spotify
  register the rest of the palette was reaching for.

> ### Colors (SUPERSEDED — May 26 morning atmospheric Anjunadeep pair)
> Earlier direction same day used pure black `#000000` background
> with deck identity `#3D5A80` (Twilight Blue, desaturated atmospheric
> blue) and `#5F8B95` (Atmospheric Teal, deep ocean teal). Retired
> May 26 evening because side-by-side decks failed two ways: (a) both
> colors in the same low-saturation cool-blue family read as cold /
> dead / not-quite-different-enough, and (b) the "atmospheric depth"
> goal that justified the desaturation was contingent on Path A
> multi-layer canvas glow shipping later — these were the wrong
> flat-fill defaults to wait on it with. Replaced by the high-contrast
> cool pair above (`#2E86DE` / `#A855F7`). See commit `f9f0bf9` for
> historical record.

> ### Colors (SUPERSEDED — May 24 cool near-black + electric pair)
> Earlier direction used cool near-black `#0A0B0E` background, deck
> identity `#0F4FA0` (deep electric night blue) and `#1FC97A` (electric
> cyan-green). Background flipped to pure black `#000000` May 25
> evening for OLED + atmospheric glow contrast. Deck pair retired
> May 26 for the atmospheric Anjunadeep palette above — the electric
> pair was right for v5.8 multi-pass additive glow rendering but
> read too saturated as flat fills before Path A glow ships.
> (Between May 24 and May 26 the production deck pair was the
> Material Design `#1976D2` / `#00C853` Quick Wins variant, now
> banned — see above.)
- **Beat grid lines render in WHITE** (functional reference, must
  contrast against any deck color). Off-beat ticks at low alpha,
  downbeat ticks bright + through-line. **Canvas `shadowColor`
  around the ticks uses the deck identity color** — white carries
  the contrast, deck-color halo carries the atmospheric vibe. Phrase
  (16-bar) markers stay red on the outer rails only with their own
  red glow. Deck-color glow also lives on the waveform bars
  themselves (in the amplitude pixel pass).
- BPM display: **clean white**, same color family as the track title.
  Number reads as a primary data point through size, not color.
- Track time (elapsed/remain): inline with the track title, Rekordbox
  style — `03:03 / -05:08` tabular-nums, cool gray. NOT in the
  transport row.
- 16-bar phrase marker on waveform: **red `#FF3B30`** — strong,
  unambiguous structural reference against the cool dark background.
  Has its own subtle red glow.
- Frequency band colors (if/when spectral rendering revisited): cohesive
  palette, not random
  - Lows: deep teal-blue
  - Mids: warm amber
  - Highs: soft cream

> ### Colors (SUPERSEDED — May 21 warm "Quiet Pro Tool" palette)
> Earlier direction used warm dark gray (`#0F1014`), warm white text
> (`#E8E3D8`), and a single pale-oak accent (`#C9B79C`) applied across
> many UI elements. May 22 visual review by user determined the warm
> execution read as "retro / military, not clean or minimal" and the
> direction reversed to the cool dark Beatport-leaning palette above
> with surgical warm accents only. Underlying philosophy (restraint,
> Japanese minimalism, MUJI / Teenage Engineering references, sentence
> case, tabular nums, Inter typography) unchanged — only palette changed.

### Typography
- Sentence case throughout (NEVER all-caps for display)
- Inter or Söhne (refined, has personality, modern)
- JetBrains Mono for data (BPM, time, position)
- Type hierarchy through size, not weight
- Confident sizing — small text small, large text large, no in-between

### Spacing
- 8px grid base
- Generous around primary controls
- Tight where data lives
- Negative space used confidently

### Controls
- Smaller, more precise (not aggressive hardware-style)
- Thin lines, subtle borders
- Visual weight reduced overall
- Empty states feel intentional, not empty

## What This Means In Interaction

### Animation philosophy
- Standard duration: 200ms
- Spring physics for tactile elements
- Animations never sluggish, never arbitrary
- Each animation has a reason

### Tactile satisfaction
- Knobs respond with proper rotation physics
- Slight inertia/momentum on release
- Visual rotation matches finger movement exactly
- Click into detents at meaningful values
- Optional haptic feedback (Web Vibration API on mobile)

### Audio feedback (sparingly)
- Subtle clicks on cue point activation
- Soft thud when track loads
- Visual flash plus subtle sound when mix engages
- Optional, on by default

### Hover states
- Very subtle, restrained
- Slight elevation, never bright outlines

## Critical Feature Treatments

### Waveforms
Multi-band frequency-colored — refined, slightly softer than Rekordbox. Subtle glow under playing portion. Phrase markers clean and unobtrusive.

### Sync button
The most important button. When engaged, should feel dramatic — subtle pulse, glow, communicate "locked together." This is the moment the magic happens.

### Two decks
Spatial relationship unmistakable. Left/right separation clear. Subtle color coding so you always know which is which.

### Library
Should feel like a DJ's crate — curated, organized, personal. Not generic music app library.

### Cue points
Deserve love. Beautiful, memorable, color-coded with intention.

## Reference Inspirations (for inspiration, not copying)

### Aesthetic references
- MUJI — utility design, functional minimalism
- Teenage Engineering (the minimalism, NOT the retro)
- Hiroshi Fujiwara / fragment design — modern Japanese minimal
- Nendo studio — playful minimalism
- Naoto Fukasawa — design dissolving in behavior
- Sony's recent design language

### Functional references
- Rekordbox — information architecture, waveform quality, beat grid execution
- Ableton Live 12 — clean creative palette, separation between areas, organized density

### What we're NOT
- Pioneer hardware (too retro, too cluttered)
- Apple Music (too soft for pro tool)
- Linear/Cursor (too cold, code-like)
- Figma (too consumer, too iPad-design-tool)
- Maschine/Traktor (too "DJ software" aesthetic)
- All-caps athletic brands (too shouty)

## Marketing Voice

Confident but not arrogant. Clean copy. Sentence case. No exclamation marks. Trust the user without dumbing things down. Like the talented friend, not like corporate marketing.

Headline candidates to workshop later:
- "DJ together. From anywhere."
- "Real DJing. Online."
- "The first DJ platform built for B2B."

## Anti-Patterns (things to never do)

- Skeuomorphic CDJ-photo aesthetic
- Generic web app cards/tabs/dropdowns
- Glassmorphism / neumorphism
- Excessive gradients
- Too many icons
- All-caps display fonts
- Inverted-light-mode "dark mode"
- Corporate-sounding microcopy
- Loud attention-grabbing animations
- Multiple accent colors competing
- Visual clutter masquerading as features

## User's Taste Profile (Reference Reactions)

Reactions to 8 reference apps during taste-mapping session:

**Rekordbox** — Organized density appreciated. Pro waveforms/beatgrids strong reference. Dark grey offsets better than pure black. "Feels old and dated outside of beatgrid and wave, maybe feels kind of basic."

**Ableton Live 12** — "Feels like an artist palette." Clean and open and organized. Likes contrast between separate but connected areas. Plugins at bottom feel right. "Very organized."

**Maschine+** — Doesn't move user. Groups with Rekordbox/Traktor "vibe." Lots of colors lighting up = criticism. Confirms NOT this direction.

**Teenage Engineering OP-1** — "Apple combined with the 80s and Japan." Likes clean/minimal approach. Does NOT like retro/old hardware vibe.

**Linear** — Good and clean but "code-like." Too dev-tool. Confirms not this direction.

**Cursor** — Similar to Linear. Confirms not this direction.

**Figma** — "Colors jump at you, reminds me of canva or one of those ipad design sites." Too consumer.

**Tonal** — Doesn't like their all-caps typography. (Note: all-caps doesn't always bother user, theirs specifically did.)

## Living Document

This is a working draft. We will refine and add as we see mockups and react. Decisions will get more specific over time. What's here is direction, not final commitment.

## Status log

### May 26, 2026 evening — high-contrast cool deck pair (atmospheric pair retired same day)
- **Deck A `#3D5A80` → `#2E86DE`** (Vivid Ocean Blue). Saturated,
  alive, distinct. The morning's `#3D5A80` Twilight Blue tested as
  cold / dead in the side-by-side deck view — desaturated colors
  needed Path A glow rendering to come alive, and that's not shipping
  today. Reverting to a saturated cool that works as a flat fill
  immediately.
- **Deck B `#5F8B95` → `#A855F7`** (Electric Royal Purple). Same
  failure on `#5F8B95` — both atmospheric colors landed in the
  cool-blue hue family and read as "same color, slightly different
  shade" rather than two distinct decks. New pair contrasts through
  hue family (blue vs purple), not temperature — strong distinction
  while staying inside the cool-color stare-task rule.
- **Iteration narrative captured in the philosophy doc.** Three
  palettes in one day: Material `#1976D2 / #00C853` (consumer-app
  feel) → atmospheric `#3D5A80 / #5F8B95` (cold / dead / too
  similar) → high-contrast `#2E86DE / #A855F7` (current). The doc
  now records all three failure modes in the Banned colors section
  + supersession blockquotes so future iterations don't repeat them.
- **"Why no warm deck colors" rule documented.** Pro-DJ stare-task
  ergonomics: warm fills cause cumulative eye fatigue under long
  sessions. Warm reserved for marker-scale uses only (cue points,
  phrase markers, recording dot). A vs B distinction comes from hue
  family within cool, not from cool-vs-warm temperature contrast.
- **Pre-existing landing-page detail noted.** The radial-glow at the
  hero bottom-center already used `#a855f706` at 2.4% alpha (pre-
  existing, unrelated to this work). The new Deck B color matches
  it — landing-page brand gradient + deck mockup will now share a
  purple base with the existing glow tint, accidentally coherent.
- **`STATUS_OK = "#22c55e"` and beatgrid red `#FF3B30` preserved.**
  Both confirmed in bundle byte scan post-migration (24 and 1
  occurrences respectively, unchanged from pre-edit).

### May 26, 2026 — atmospheric Anjunadeep deck pair (Material Design retired)
- **Deck A `#1976D2` → `#3D5A80`** (Twilight Blue). Desaturated
  atmospheric blue. The May 23 Quick Wins Material-Design pair read
  as "consumer software" / Android primary at full saturation. New
  hue is closer to the Anjunadeep / Above & Beyond / Universal Audio
  register — depth and restraint rather than brightness.
- **Deck B `#00C853` → `#5F8B95`** (Atmospheric Teal). Deep ocean teal /
  sophisticated gray-blue. Replaces the Material green that read as
  consumer / party-DJ aesthetic. New hue is a desaturated cousin of
  Deck A in the same Anjunadeep register — A vs B reads through hue
  family (blue vs teal), not saturation or temperature.
- **Semantic green decoupled.** Introduced module-level constant
  `STATUS_OK = "#22c55e"` for status / online / ready indicators
  (Rekordbox "ready" badge, partner online dot, partner chat colour
  / volume indicators, START STREAM button). Previously these reused
  the Deck B green hex, so any deck-B palette change silently broke
  the "green = online" convention. Decoupled now — future deck-pair
  tunings can move without touching status semantics.
- **`src/index.css` cleaned.** The unused `:root { --deck-a / --deck-b }`
  CSS variables and the `@supports (color: color(display-p3 ...))`
  P3 wide-gamut override block were both deleted — confirmed dead
  code (no `var(--deck-a)` consumers anywhere; every site inlined
  the hex literal). For atmospheric desaturated colors P3 gives zero
  visible benefit anyway (both new colors well within sRGB gamut, no
  channel above ~0.58).
- **Banned-colors policy added** to the philosophy doc (above) — `#1976D2`,
  `#00C853`, any Material primary at full saturation, bright neon
  deck colors, and warm accents (amber / oak / sepia) are all on the
  retired list now.
- **What this doesn't include yet:** full atmospheric glow visibility.
  The current canvas-2D multi-pass additive glow is at its ceiling;
  the new desaturated base colors are chosen so **Path A multi-layer
  offscreen canvas compositing** (deferred — next major lever) will
  compose wide-halo + concentrated-halo + crisp-shape layers into
  ambient light rather than over-saturated neon. Expect the
  atmospheric character of the new palette to come through fully
  once Path A ships.

### May 22 deep night — design v5.10 (invert peak brightness gradient — deep BODY, peak tips only)
- **Per-column gradient inverted.** v5.8 introduced the peaks-bright
  cached gradient (peak stops `+180` near-white at gradient
  positions 0.0 and 1.0; base color only at 0.5 centerline).
  Visual review on v5.9 showed this was the source of the
  "thin-deep-band-at-centerline" problem — the +180 lift was
  rendering the top/bottom of EVERY column as near-white, leaving
  only a horizontal centerline band reading the deep pigment we
  kept chasing.
  v5.10 flips it:
  - Body of the column (gradient positions 0.05–0.95) = deep base
    color at high alpha (0.92–0.95). The waveform body now reads
    as the deep saturated pigment everywhere.
  - Subtle brightness lift (`+40` above base, not +180) only at
    the very top tip and very bottom tip (0.0 and 1.0). Tall
    columns get a thin highlight at the actual amplitude peak;
    short columns sample only the middle deep stops.
- **Pass C (silhouette baseline) flattened to uniform deep color**
  (was peaks-bright gradient mirroring the v5.8 idea). The body
  is consistently deep pigment now without competing brightness
  gradients.
- v5.8 multi-pass additive glow halo (Pass A wide + Pass B
  concentrated) preserved — that's still rendering the
  atmospheric outer bleed correctly. The fix was inside the
  silhouette, not in the halo.
- Deck colors unchanged from v5.9 (`#0F4FA0` deep blue, `#1FC97A`
  electric green).

### May 22 deep night — design v5.9 (color tuning for v5.8 glow rendering)
- **Deck A `#1A6EE0` → `#0F4FA0`** (deep electric night blue).
  v5.8's multi-pass additive glow was washing the v5.7 mid-tone
  blue out to "sky blue" — the bright peak cores + halo pulled
  the visual weight up to a light hue. Pulling the base color
  darker (full saturation preserved, brightness pushed down per
  the color principle) keeps the halo reading as "deep blue
  light" rather than cyan-tinted glow.
- **Deck B `#7E3FD6` (purple) → `#1FC97A` (electric cyan-green).**
  Replaces the purple identity with a vivid green matching the
  user's club-lighting reference (DJ booth neon strips). With
  v5.8 glow rendering applied, expect bright lit cores at peaks,
  deep electric green halo bleed across surrounding dark space —
  neon green light in a dark room. NOT lime / fluorescent / Matrix.
  Crossfader gradient updated to deep-blue → electric-green.
- All other v5.8 rendering preserved (multi-pass additive Path2D
  glow, peak cores +180 above base, pure black canvas, source-over
  for crisp downstream passes).

### May 22 deep night — design v5.8 (true neon multi-pass glow)
- **Multi-pass additive glow rendering on the top zoomed waveform.**
  Silhouette path refactored to a `Path2D` so the same geometry
  can be re-filled cheaply. Three passes composited with
  `globalCompositeOperation = 'lighter'` (additive — same physics
  as real light, color accumulates where it overlaps):
  - Pass A: `shadowBlur = 70*dpr`, deck-color shadow alpha 1.0,
    fill alpha 0.18 — wide atmospheric spread far past the
    silhouette edge.
  - Pass B: `shadowBlur = 28*dpr`, fill alpha 0.30 — concentrated
    halo around the bright core.
  - Pass C: `shadowBlur = 0`, peaks-bright baseline gradient —
    silhouette body fills in with depth.
  Composite reset to `source-over` before the AA stroke + per-column
  overlay + grid markers + playhead + hot cues so those stay crisp.
- **Per-column "lit core" — peak tops near-white.** Pass 2b cached
  gradient pushes peak stops `+180` above base deck color (was +90)
  → near-white with a slight deck-color cast at the very tips.
  Tall columns get a bright core that reads against the deck-color
  halo. Quiet columns sample only the dim middle stops.
- **Canvas clear → pure black `#000000`** (was `#06070A`). The
  additive `lighter` glow needs maximum contrast to bleed into.
  Section container backgrounds also changed to pure black so the
  empty / no-track strip stays coherent.
- Deck colors unchanged from v5.7 (`#1A6EE0` blue, `#7E3FD6`
  purple) — the colors are right; v5.8 is about the *rendering* of
  light, not the pigment. Goal reference: looking at a neon sign
  in a dark room with visible atmospheric bleed across the dark
  space, not a flat painted shape.
- Performance: three `ctx.fill(path)` calls per frame plus one
  large 70*dpr blur. Caching to offscreen canvas is the next lever
  if scroll/zoom feels laggy.

### May 22 deep night — design v5.7 (vivid colors, atmospheric glow)
- **Deck colors pushed to vivid pigment.** v5.6 values still landed
  as muted dark; v5.7 punches saturation up:
  - Deck A `#1B5BAA` → `#1A6EE0` — vivid confident blue (not "navy").
  - Deck B `#6B3FA8` → `#7E3FD6` — vivid glowing purple (Reflect-
    style premium amethyst).
  Crossfader gradient updated to the new rgb pair + slightly higher
  gradient opacity.
- **Glow intensity cranked to atmospheric.** Previous halo read
  as faint drop-shadow; v5.7 makes it real light-through-mist:
  - `shadowBlur` 14*dpr → 28*dpr (real atmospheric spread).
  - `shadowColor` alpha 0.65 → 0.90 (visible halo).
  - Inner-gradient peak brightness brightened from +60 → +90 above
    base color so peak tips actually glow rather than just being
    saturated.
  - Silhouette gradient peak stop alpha 0.42 → 0.48, slight bump
    at the lit centerline transitions.
  Goal reference: Reflect's vivid glowing purple with visible color
  extending well beyond the central element. Looking at the
  waveform now feels like seeing light through mist.

### May 22 deep night — design v5.6 (actual glow rendering on waveforms)
- **Outer bloom on the top zoomed waveform silhouette.** Canvas
  `shadowColor` set to deck-color rgba 0.65 + `shadowBlur` 14*dpr,
  applied to the silhouette `fill()`. Renders an atmospheric halo
  extending beyond the waveform peaks — club lighting on dark
  fabric. Shadow reset to 0 before the AA stroke and downstream
  passes so they stay crisp.
- **Inner brightness gradient — peaks lit, centerline dim.**
  Pass 2a silhouette gradient inverted: peaks (top/bottom of vertical
  gradient) bright at 0.42 alpha, centerline dim at 0.08. Pass 2b
  per-column overlay switches from solid `rgb(deck)` fill to a cached
  vertical gradient that brightens toward peaks (full alpha,
  deck-color+60 lightened) and dims toward centerline (0.50 alpha
  raw deck-color). Tall columns get "light coming from the peaks"
  feel; quiet columns sample only the dim middle stops.
- Combined effect: waveforms now read as **glowing in a dark room**
  with their own light source — atmospheric outer halo + lit-from-
  inside peaks. Not painted shapes.
- No other changes — deck colors (v5.5 blue/purple), white grid
  markers + deck-color halo, red phrase ticks, ampPad 18 amplitude
  clearance all preserved.

### May 22 late night — design v5.5 (club-lighting cool pair, deck-color grid glow)
- **Deck pair re-themed to "club lighting" cool tones.** v5.1–v5.4
  cycled through blue/slate, blue/rust-copper, and saturated
  variants of those; none landed as "glowing in a dark room"
  atmospheric. v5.5 abandons the temperature-contrast rule —
  both decks now in the cool family but distinct hues:
  - Deck A: `#1B5BAA` — deep electric night blue. Dusk city
    skyline / phone screen in dark room / deep stage lighting.
  - Deck B: `#6B3FA8` — deep electric purple. Premium amethyst /
    high-end venue lighting / between deep amethyst and electric
    violet (NOT neon party purple, NOT lavender, NOT magenta).
  Both have "their own light source" — glowing, modern, mature.
  Crossfader gradient updated to the new rgb pair.
- **Beat grid glow follows deck identity color again.** Grid
  LINES still render in white (v5.3 contrast rule preserved) but
  the canvas `shadowColor` around the ticks is now deck-color
  rgba (blue halo on Deck A, purple halo on Deck B). White
  carries the contrast; deck-color glow carries the vibe. The
  waveform area reads as atmospheric lighting rather than flat
  white-on-dark. Phrase tick branch still overrides to red glow.

### May 22 night — design v5.4 (true amplitude clearance, alive Deck A blue)
- **ampPad 11 → 18 css px.** v5.3 bumped 6 → 11 but peaks were
  still touching the grid tick rail; markers existed but didn't
  visually sit "above" the waveform. At 18 the amplitude region
  exactly meets the tick rail (tickRailPad is also 18) — no
  overlap, no gap. White grid markers now read as clearly atop
  the waveform.
- **Deck A blue `#2974B6` → `#1E80D4`** (alive saturated blue).
  v5.3's value was still landing in "dark blue-gray" territory.
  v5.4 keeps the principle (full saturation in hue family first,
  then reduce brightness) — drops some lightness vs full neon but
  retains full pigment so the BLUE identity reads at a glance.
  Spotify/Beatport accent-blue range. Deck B `#C16842` unchanged
  — copper landed correctly in v5.3.

### May 22 night — design v5.3 (white grid markers, amplitude clearance, saturated deck colors)
- **Beat grid markers render in WHITE on both decks.** v5/v5.2 had
  grid lines using the deck identity color (rust grid on rust
  waveform = invisible). Switched OFF/DOWN/DOWN_LINE fills to white
  rgba; shadowColor white at low alpha for a subtle haze. The grid
  is functional reference structure — must contrast against the
  waveform body regardless of deck color. Deck-color glow stays on
  the waveform bars themselves (separate render pass). 16-bar phrase
  ticks unchanged — still red, outer ticks only.
- **Waveform amplitude clearance restored.** ampPad bumped 6 → 11
  css px. At 6 the peaks were physically covering the top/bottom
  grid tick positions; markers existed but were hidden. At 11 the
  amplitude region has clear vertical clearance from the tick rail
  so white markers stay visible above the loudest peaks and below
  the lowest troughs.
- **Deck colors pushed to higher saturation.**
  - Deck A `#1F4F7A` → `#2974B6` — confident mature blue (was reading
    as muted gray-blue).
  - Deck B `#7C4E3B` → `#C16842` — alive aged copper (was reading
    as muddy dark brown).
  Still grounded, still Scandi-honest, but the BLUE and the COPPER
  identities come through with real presence from across the room.

### May 22 late — design v5.2 cleanup (stray border, panel relocate, waveform gap, Camelot, phrase line)
- **Stray dashed border on the library section removed.** LibraryPanelV2's
  outer wrapper had `outline: "2px dashed transparent"` as the
  non-dragging default — some browsers render the dashed shape even
  when transparent. Changed to `outline: "none"`; the dashed indicator
  only appears now while a drag is actively in progress.
- **AUDIO / REC / MIDI panel toggles relocated to the top header.**
  The dedicated strip between the deck row and the library was
  removed entirely. Toggle buttons live next to the session-name +
  Share + Leave cluster in the top bar; detail panel content
  (`RTCPanel` / `RecPanel` / `MidiPanel`) still renders below the
  decks but only when a panel is open — wrapper collapses fully
  otherwise. Library reclaims the vertical strip.
- **Gap between Deck A and Deck B waveforms removed.** The two
  per-deck chrome rows (each holding an A/B letter label + manual
  nudge / zoom controls) were stripped. Both top zoomed waveforms now
  sit edge-to-edge with no horizontal band between them. Waveform
  height bumped 78 → 90 with the freed space. **Zoom selector**
  preserved as a small backdrop-blur overlay floating in the
  waveform's top-right corner. **Manual nudge controls (grid offset,
  bar-1 nudge, BPM nudge) were dropped from the UI** — state and
  handlers still defined in the parent so they can be reattached.
  They need a new discoverable affordance before dogfood (per
  VISION_5 known TODO).
- **Camelot key chip dropped from amber to white.** Removes amber
  from the deck cards entirely — the amber accent now lives only on
  the active sidebar item's thin left border in the library. About
  as surgical as it gets.
- **Red 16-bar phrase through-line removed.** Was the full-height
  red vertical line crossing the waveform body — too visually heavy,
  competed with waveform content. Phrase columns now render as a
  normal downbeat (deck-color through-line + downbeat ticks) PLUS
  red top/bottom phrase ticks for identity. Red carries the marker;
  the through-line stops shouting.

### May 22 evening — design v5 (deck temperature contrast, beat grid glow, transport cleanup)
- **Deck colors swapped for real temperature contrast.** v4's deep
  blue-grays (`#3B5A6F` / `#4A5568`) read as identical. v5 splits to
  Deck A `#1F4F7A` (deep saturated Scandi blue) vs Deck B `#7C4E3B`
  (deep aged rust copper). Cool vs warm temperature, instant glance
  identification.
- **Beat grid lines render in deck identity color with subtle outer
  glow.** Off-beat ticks dim, downbeats bright + through-line, all
  with canvas `shadowBlur=3` for ambient "alive" feel. Soft inner
  light, NOT Tron. Red 16-bar phrase markers unchanged (with their
  own red glow).
- **Metadata line simplified.** Was `08:12 · 48.0kHz · Stereo · Kyotto`
  — now artist name only. Sample rate / channel / duration noise
  removed; the data lives elsewhere (or doesn't matter to the DJ).
- **Elapsed / Remain time moved inline with track title** (Rekordbox
  style). Compact `03:03 / -05:08` tabular-nums sits on the title's
  own row, right of title. Transport row no longer carries time
  displays — just Cue · Skip · Play · Skip · Sync · M, centered.
- **BPM is white now.** v4 had it amber; v5 reads it as inconsistent
  against the white title — same data family, should be same color.
  BPM stays large + bold, focal point through size not color.
- **No green active states.** Sync engaged and M (master) engaged both
  use white glow / brightness lift matching the white play button.
  Green removed from active-state palette entirely. Retained only for
  semantic indicators (recording, partner-online dot).
- **Mixer center stripped of diagnostics.** "Master out · room-name"
  text removed from header strip; ROOM / PING / NET diagnostic block
  removed from below the master fader. VU meter stays, master fader
  + label stays, channel strips unchanged. Center column now reads as
  pure controls — no debug noise.
- **Waveform amplitude scaling.** Reduced `ampPad` from 28 → 6 css
  px per side on the top zoomed waveform. Peaks now fill nearly the
  full container height; no dead vertical space between peaks and
  beat grid markers top/bottom. Grid ticks render after the amplitude
  fill (intentional overlap so ticks read on top of tall peaks).
- **Surgical amber tightened.** v4 used amber on BPM, Camelot, and
  playing-time. v5 reduces to Camelot chip + active sidebar item's
  thin left border only. Two locations — about as surgical as it gets.

### May 22 — palette pivot to cool dark + layout fixes
- **Palette direction reversed.** The warm "Quiet Pro Tool" palette
  shipped May 21 (`#0F1014` warm bg, `#C9B79C` oak accent) was judged
  "retro / military, not clean or minimal" on user visual review. New
  direction: cool near-black `#0A0B0E`, clean white `#F5F5F7`, deck
  colors deep navy `#3B5A6F` (A) / slate `#4A5568` (B), surgical amber
  accent `#D4A06A` applied to 2–3 element types only (BPM, Camelot,
  playing-time elapsed). Beatport-leaning, Scandi-mature.
- **16-bar phrase markers changed to red `#FF3B30`** — was previously
  derived from deck identity color; red gives strong unambiguous
  structural reference against the cool dark waveform background.
- **Transport clipping fix.** Deck row height bumped 220 → 248 so the
  52 px white play + 8+8 padding transport row fits inside the deck
  card without clipping. v3's earlier "fits in 220" claim did not hold
  on review.
- **Top waveform height reduced** 120 → 78 (~35% shorter). Rekordbox's
  reference waveforms run shorter than ours; library reclaims that
  vertical real estate.
- **Crossfader relocated** out of the standalone strip between decks
  and library, into a horizontal strip at the bottom of the mixer
  card. Frees the full-width vertical strip for the library.
- **Library polish.** TrackRow padding 5→9 px vertical for more
  breathing room. Search bar lost its inset shadow; sidebar got more
  generous label padding; "+ Add music" and "+ New folder" buttons
  changed from chunky chips to restrained text-button style. Selected
  sidebar item uses a thin amber left border as the only sidebar
  accent.
- Philosophy (restraint, MUJI / Teenage Engineering refs, sentence
  case, Inter, tabular nums, album-art deck anchors, white-circle play
  as visual anchor, calm monochrome waveform amplitude) **unchanged**.
  This was a palette + layout pass, not a direction change.

### May 21 evening
- Design v3 layout fixes shipped (commit `565991d`). Six fixes from
  visual review of the prior commit: edge-to-edge deck row, DeckArt
  locked to 96×96, transport row merged with LCD time (Elapsed left,
  Remain right) so all controls fit a 220px deck card, library gained
  vertical room, top-waveform chrome moved off the waveform into a
  dedicated row above, "{ N beats }" label no longer overlaps the
  waveform.
- Still iterating on the look. Target aesthetic is **Beatport B2B** —
  content-forward, minimal, generous negative space, restrained
  warm-dark palette with single oak accent. Expect 2–3 more visual
  rounds before sign-off.
- Waveform color spectral work **tabled** per
  `tools/rekordbox-eval/PHASE_2_STATUS.md` — calm monochrome shipping
  for now; spectral diagnostic data preserved as historical record;
  resume only after dogfood feedback indicates spectral
  differentiation matters to real users.
