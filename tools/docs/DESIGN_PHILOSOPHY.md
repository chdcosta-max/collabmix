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

### Colors
- Background: warm dark gray (NOT pure black) — has warmth, around #0F1014
- Surface/panels: slightly elevated grays
- Text: warm white (NOT pure white)
- ONE accent color used sparingly with intention (exploring amber/warm tones)
- Frequency band colors: cohesive palette, not random
  - Lows: deep teal-blue
  - Mids: warm amber
  - Highs: soft cream

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
