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

### Colors (current — cool dark, design v5, May 22, 2026 evening)
- Background: **cool near-black** `#0A0B0E` — no brown/warm cast, reads
  like Beatport / Spotify dark mode (NOT warm sepia, NOT pure black)
- Panels / surfaces: cool dark greys, slightly lifted (`#15171A`,
  `#1F2126`)
- Text: **clean white** `#F5F5F7` (NOT warm white)
- Borders: cool whites at low alpha — `rgba(255,255,255,0.06)` subtle,
  `rgba(255,255,255,0.12)` defined
- **Surgical warm accent** — deeper amber `#D4A06A`. Used on
  **the Camelot key chip ONLY** plus thin border accent on the active
  sidebar item (restraint principle, v5 tightened from v4 by dropping
  BPM and elapsed-time off the amber list — those felt inconsistent
  against the white track title).
- **Active state on buttons: clean white** — NO green. Sync engaged,
  M (master) engaged both get a white glow / brightness lift matching
  the white play button when playing. Green removed from active-state
  palette entirely; only retained for semantic indicators (recording
  in progress, partner online dot).
- Deck identity colors — **"club lighting" cool pair**, both with
  "their own light source" / glowing-in-a-dark-room character. A vs
  B reads through hue (blue vs purple), not temperature:
  - Deck A: `#1B5BAA` — deep electric night blue (dusk skyline /
    phone screen in dark room / deep stage lighting)
  - Deck B: `#6B3FA8` — deep electric purple (premium amethyst,
    high-end venue lighting; NOT neon party, NOT lavender)
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
