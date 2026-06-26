# Mix//Sync — Landing Page Package (for Claude Design)

**What this is:** a single hand-off document consolidating Mix//Sync's actual,
existing design documentation for building the V1 landing page. Assembled from
three source docs in `tools/docs/`:
- `DESIGN_PHILOSOPHY.md` → **Section A** (visual identity / design system)
- `LANDING_BRIEF.md` → **Section B** (what's already decided about the page)
- `SOCIAL_VISION.md` → **Section C** (product vision / messaging direction)

**How to read it:** Sections A–C are pulled from the real docs — hard rules
(colors, type, spacing, bans) are reproduced verbatim so nothing is approximated.
**Section D flags the gaps** — things a landing page needs that the existing docs
do NOT decide. Section D is the only place anything is "missing"; it is not filled
in with invented answers.

> Two app-internal subsystems from `DESIGN_PHILOSOPHY.md` are intentionally OMITTED
> here because they are waveform-canvas *rendering implementation*, not landing-page
> design rules: (1) the "Glow rendering architecture (Path A)" two-canvas/CSS-blur
> spec with its tuning constants, and (2) the dated "Status log" of v5.x waveform
> render iterations (May 21–26). They remain in the source doc if ever needed. The
> *current* design system (current colors, type, spacing, principles, bans) is below
> in full.

---

# SECTION A — Visual identity (the design system)

## Direction
"Quiet Pro Tool" — Japanese minimalism applied to a serious DJ platform.
Restrained, considered, modern. Every element earns its place. Confidence without
shouting. The opposite of loud DJ software.

## Target audience
- **Primary:** existing pro/intermediate DJs (Rekordbox/Serato users) who want
  remote B2B collaboration.
- **Secondary:** aspiring DJs who find Rekordbox's complexity intimidating.

## Brand personality
The talented friend who's been DJing for 10 years, has great taste, knows their
gear, and helps you sound good without being a snob about it.

## Core aesthetic principles (verbatim)
- **Restraint as a virtue** — Less is more. Each element must earn its place. When
  in doubt, remove it.
- **Information density done well** — Rekordbox-level density for data (library,
  BPM, key, etc.) but executed with Ableton-level cleanliness. Dense but never
  crowded.
- **Negative space is a real design element** — Breathing room around primary
  controls. Generous spacing between sections. White space communicates confidence.
- **Functionality is the aesthetic** — Don't decorate. Function shapes form. The
  visual design emerges from what the tool does, not from imposed styling.
- **Quiet confidence** — The opposite of loud or shouty. Confident defaults, no
  second-guessing the user, no aggressive animations or attention-grabbing elements.
- **One small detail can carry the whole design** — A perfectly considered control,
  a beautiful waveform, an animation that feels exactly right. Quality of details
  over quantity of features.

## Colors — CURRENT (pure black + high-contrast cool pair; locked May 26, 2026 evening)
Exact values, verbatim:

| Role | Value | Notes |
|---|---|---|
| Background | **`#000000`** pure black | OLED-optimized, max contrast for deck colors. The substrate that lets saturated deck colors "pop." |
| Panels / surfaces | `#15171A`, `#1F2126` | cool dark greys, slightly lifted |
| Text | **`#F5F5F7`** clean white | NOT warm white |
| Borders (subtle) | `rgba(255,255,255,0.06)` | |
| Borders (defined) | `rgba(255,255,255,0.12)` | |

**Single accent: white at varying opacity. No amber, no warm accent.** Three tiers,
used everywhere an accent is needed:
- **Primary** `rgba(255,255,255,0.9)` — active states, primary indicators (active
  sidebar border, active play / sync glow center)
- **Secondary** `rgba(255,255,255,0.6)` — hover states, secondary info (minor-key
  Camelot text, secondary metadata)
- **Tertiary** `rgba(255,255,255,0.3)` — borders, dividers, inactive pill outlines

**Active state on buttons: clean white — NO green.** Sync engaged and M (master)
engaged both get a white glow / brightness lift matching the white play button when
playing. Green removed from active-state palette entirely; retained only for
semantic indicators (recording in progress, partner online dot, Rekordbox "ready"
badge) — held in `STATUS_OK = "#22c55e"`, decoupled from any deck color.

**Deck identity colors — high-contrast cool pair** (saturated enough to feel alive
against pure black; both in the cool family — no warm waveforms — but A vs B reads
through strong hue contrast, blue vs purple):
- **Deck A: `#2E86DE`** — Vivid Ocean Blue. Saturated, alive, distinct.
- **Deck B: `#A855F7`** — Electric Royal Purple. Saturated cool violet; pairs with
  Ocean Blue through hue contrast rather than temperature.

**Other functional colors:**
- **16-bar phrase marker (waveform): `#FF3B30`** red — the only warm hue in the
  working surface, and only at marker scale, not as a fill. Strong, unambiguous
  structural reference; has its own subtle red glow.
- **Semantic green: `#22c55e`** (`STATUS_OK`) — online / ready / recording only.
  Small surface, short attention; never a deck/active color.
- **BPM display:** clean white (same family as track title; reads as primary data
  through size, not color).
- **Track time** (elapsed/remain): tabular-nums, cool gray, inline with title,
  Rekordbox style (`03:03 / -05:08`).
- **Beat grid lines:** render in WHITE (functional reference; must contrast against
  any deck color). Canvas glow *around* the ticks uses the deck identity color —
  white carries contrast, deck-color halo carries vibe.
- Frequency band colors (if/when spectral rendering revisited): Lows = deep
  teal-blue · Mids = warm amber · Highs = soft cream.

**Why no warm deck colors (hard rule):** long DJ sessions are stare-tasks — the eye
locks onto waveforms for minutes. Warm hues (orange, coral, amber, red) at deck-
identity saturation cause cumulative eye fatigue. Warm is reserved for marker-scale
uses only (cue points, phrase markers, recording dot). A-vs-B distinction comes from
hue family (blue vs purple), not temperature.

## Banned colors (verbatim — do NOT use)
- **`#1976D2`** — Material Design blue 700. Reads as Android / consumer app.
- **`#00C853`** — Material Design green A700. Reads as bright party-DJ / Maschine.
- **`#3D5A80`** — Twilight Blue. Too desaturated as a flat-fill default; reads cold,
  dead, lifeless against pure black.
- **`#5F8B95`** — Atmospheric Teal. Same failure as `#3D5A80`, plus too close to
  Deck A in hue.
- **Any Material Design primary at full saturation** — signals the wrong product
  category for a pro DJ tool.
- **Warm deck colors at fill saturation** (orange, coral, amber, red) — eye-fatigue.
  Warm only at marker scale.
- **Bright neon greens at fill saturation** in deck slots — party/DJ-software
  aesthetic, the opposite of "Quiet Pro Tool." (`#22c55e` retained only at small
  semantic scale.)
- **Pale warm accents** (amber `#D4A06A`, oak `#C9B79C`, sepia) — even one warm hue
  broke the Beatport/Spotify register.

## Typography (verbatim)
- Sentence case throughout (NEVER all-caps for display)
- **Inter or Söhne** (refined, has personality, modern)
- **JetBrains Mono for data** (BPM, time, position)
- Type hierarchy through size, not weight
- Confident sizing — small text small, large text large, no in-between

## Spacing (verbatim)
- 8px grid base
- Generous around primary controls
- Tight where data lives
- Negative space used confidently

## Controls (verbatim)
- Smaller, more precise (not aggressive hardware-style)
- Thin lines, subtle borders
- Visual weight reduced overall
- Empty states feel intentional, not empty

## Interaction / animation (verbatim)
- **Standard duration: 200ms**
- Spring physics for tactile elements; animations never sluggish, never arbitrary;
  each animation has a reason
- Hover states: very subtle, restrained — slight elevation, never bright outlines

## Anti-patterns (things to never do — verbatim)
Skeuomorphic CDJ-photo aesthetic · generic web-app cards/tabs/dropdowns ·
glassmorphism / neumorphism · excessive gradients · too many icons · all-caps
display fonts · inverted-light-mode "dark mode" · corporate-sounding microcopy ·
loud attention-grabbing animations · multiple accent colors competing · visual
clutter masquerading as features.

## Marketing voice (verbatim)
Confident but not arrogant. Clean copy. Sentence case. No exclamation marks. Trust
the user without dumbing things down. Like the talented friend, not like corporate
marketing.

> Headline candidates listed in the philosophy doc "to workshop later":
> "DJ together. From anywhere." · "Real DJing. Online." · "The first DJ platform
> built for B2B." — NOTE: the landing brief (Section B) locked a *different* hero
> headline on June 10; see Section D for the reconciliation.

## Reference inspirations (for inspiration, not copying)
- **Aesthetic:** MUJI · Teenage Engineering (the minimalism, NOT the retro) ·
  Hiroshi Fujiwara / fragment design · Nendo · Naoto Fukasawa · recent Sony.
- **Functional:** Rekordbox (info architecture, waveform/beatgrid quality) · Ableton
  Live 12 (clean creative palette, organized density).
- **What we're NOT:** Pioneer hardware (too retro/cluttered) · Apple Music (too soft)
  · Linear/Cursor (too cold, code-like) · Figma (too consumer) · Maschine/Traktor
  (too "DJ software") · all-caps athletic brands (too shouty).

---

# SECTION B — What's already decided about the landing page
*(from `LANDING_BRIEF.md` — "Brief locked June 10, 2026. V1 = pre-community brochure."
V2 live-venue homepage is deferred to SOCIAL_VISION Phase 4.)*

**Job of the page (one job):** make a DJ feel the magic moment and sign up. The
magic moment = two DJs, two cities, one mix.

**Audience:** Primary — pro/intermediate DJs (Rekordbox/Serato) who want to mix with
friends remotely. Secondary — aspiring DJs intimidated by pro-tool complexity.

**Tone:** the talented friend who's been DJing ten years. Confident, warm, zero
hype-speak. Quiet pro. Show, don't shout.

**Structure (single page), verbatim:**
1. **HERO** — the product mixing, not feature bullets. Two deck cards side by side,
   waveforms alive, DJ names + cities visible (Seattle / Denver), sync indicator
   between them. **Headline locked from June 10 mock: "Two DJs. Two cities. One
   mix."** Subline: **"The booth is wherever you both are."** One CTA: **Get early
   access.**
2. **THE MOMENT** — 2-3 sentences on what remote B2B is. No jargon.
3. **HOW IT WORKS** — three steps, one line each: bring your library → invite your
   partner → mix in real time. Rekordbox-companion positioning here ("your library,
   your cues, your grids — nothing to rebuild").
4. **PROOF OF CRAFT** — one beautiful waveform/deck UI shot. The waveform IS the
   credibility shot. Mock demonstrates three-tier grid hierarchy + bar counter.
5. **CLOSING CTA** — repeat the one action.

**Design system (inherits the app):** pure black, white three-tier text
(0.9/0.6/0.3), deck blue `#2E86DE` / purple `#A855F7` as the only color moments,
serif reserved for wordmark, JetBrains Mono for data, sentence case, generous
negative space. *(See Section D — the "serif wordmark" line conflicts with Section
A's typography.)*

**Anti-goals (verbatim):** no feature grids, no pricing tables (pre-launch), no fake
testimonials, no stock DJ photos, no neon, no "live now" sections until Phase 4.

**Open items already flagged in the brief:**
- Domain before public push
- Waitlist vs direct signup
- Hero: video loop vs animated mock — prototype both
- React mock v1 exists from a June 10 Claude.ai session (in chat, not in repo) —
  iterate there before any web build

**June 10 late addendum — HERO DIRECTION IS OPEN (verbatim intent):** Chad's verdict
on mock v2 — better (light fields, human moments, set card all landed) BUT
waveform-as-hero is wrong until the app's waveforms are genuinely beautiful (post
"Slice B/C" waveform work). Explore instead: **real photography — real DJs, real
decks, hands on gear, home setups — cinematic warm grading per "MI Thumbnail Bible"
taste.** Chad: "I'm very bad at this stuff and need to SEE it" → next step = visual
exploration with image-rich mockups / mood boards, not more abstract mocks. Both
landing mocks (v1, v2) exist in the June 10 Claude.ai chat.

---

# SECTION C — Product vision / messaging direction
*(from `SOCIAL_VISION.md` — positioning/emotional material useful for landing copy &
messaging. NOTE: the social product itself is Phase 2–4 and must NOT appear on the V1
page — see anti-goals — but the vision sharpens the V1 story.)*

**The core promise:** remote B2B — two DJs, two cities, one mix. The "magic moment"
the page must make a visitor feel.

**Why it matters / the moat (positioning angle):** the core feature requires two
people, so every user arrives alone — a cold-start problem. The eventual answer is
matchmaking on real taste data: *"we analyze every user's library — BPM ranges,
keys, genre profile. 'Match me with someone who plays melodic house at 120-124' is a
signal no other platform has."* (Defensible — but Phase 4, not V1 copy.)

**Rekordbox-companion positioning (reinforces the brief's "HOW IT WORKS"):** "your
library, your cues, your grids — nothing to rebuild." Pro-tool respect, not
replacement.

**Brand constraint (verbatim):** Quiet-pro, NOT neon gamer. **chess.com community
energy, not Twitch visual chaos.** All UI inherits the locked design system (pure
black, white tiers, mono data type, sentence case).

**Marketing engine (leverage order — context for tone/story, not page sections):**
1. Set cards — organic shareable content from every session
2. "Melodic Inspirations" channel — owned audience of the exact target niche
3. Magic-moment clips (two cities, one mix) for short-form video
4. Niche-first seeding: melodic/progressive house before "all DJs" — small dense
   community beats a large empty one
5. Prereq: a real domain before public marketing (currently `collabmix.vercel.app`)

**Messaging guardrails (anti-goals, verbatim):** no gamer-neon aesthetic, no
engagement-bait mechanics, no matchmaking/"live" claims before the product earns
trust. (V1 is a brochure; the community story is future.)

---

# SECTION D — Gaps: what a landing page needs that the docs DON'T decide

These are genuinely open or ambiguous in the existing docs. **Flagged, not filled —
each needs a decision from Chad before/while designing.**

### D1. Hero VISUAL treatment — OPEN (biggest open decision)
The brief locks the hero *copy* but the June 10 addendum explicitly reopens the hero
*visual*: waveform/product-mock-as-hero was judged premature; the new direction is
**real photography (real DJs/decks/hands/home setups, cinematic warm grading)** — but
no shots, art direction, or source exist yet, and the referenced **"MI Thumbnail
Bible"** is not in these docs. Also still open from the brief: **video loop vs
animated mock vs photography**, all "prototype both." → *Decision needed: which hero
medium, and source the photography/art-direction reference.*

### D2. Warm-photography vs cool-app-palette tension — UNRESOLVED
The hero direction calls for **"cinematic warm grading"** photography, but the entire
app/design system is **strictly cool + anti-warm** (warm hues are a hard ban for
fills). The docs never reconcile how warm hero imagery coexists with the cool brand
surface. → *Decision needed: how warm the landing imagery may go before it breaks the
"Quiet Pro Tool" cool register.*

### D3. Headline — two conflicting "decisions" on record
- Brief (June 10, "locked"): **"Two DJs. Two cities. One mix."** / subline **"The
  booth is wherever you both are."**
- Philosophy doc ("workshop later"): "DJ together. From anywhere." / "Real DJing.
  Online." / "The first DJ platform built for B2B."
The brief is newer and explicitly locked, so it likely wins — but the docs don't say
the candidates are dead. → *Confirm the brief headline is final.*

### D4. Wordmark / logo — UNDEFINED + a doc conflict
- **No actual logo or wordmark design/asset exists** in the docs (mark, lockup,
  spacing, favicon — none specified).
- **Conflict:** the brief says **"serif reserved for wordmark,"** but Section A's
  typography lists only Inter/Söhne + JetBrains Mono and never mentions a serif (and
  the app appears to have moved to Inter-only). → *Decision needed: is there a serif
  wordmark or not, and who designs the actual mark?*

### D5. Body copy — direction only, not written
"THE MOMENT" (2-3 sentences) and the three "HOW IT WORKS" one-liners are described as
*intent*, not written copy. The page needs the actual words. → *Decision/drafting
needed: final microcopy for sections 2–3 and the CTAs.*

### D6. CTA mechanics — UNDECIDED
The CTA label ("Get early access") is set, but **waitlist vs direct signup is an open
item**, and what happens after the click (email capture? form? confirmation state?)
is undefined. → *Decision needed: signup mechanism + post-click state.*

### D7. Font specifics not locked
- **"Inter OR Söhne"** is two options, not one (Söhne is a paid licensed face — a
  real cost/licensing decision).
- The wordmark serif (if kept per D4) has **no named typeface**.
→ *Decision needed: pick the display face; confirm Söhne license or default to Inter.*

### D8. Domain — open
Still `collabmix.vercel.app`; the docs flag "real domain before public push" but no
domain is chosen. → *Decision needed before any public launch.*

### D9. Responsive / mobile — not addressed
The docs describe a desktop-feeling pro tool and a single-page structure but say
nothing about the **mobile landing layout** (likely a large share of first-touch
traffic). → *Decision needed: mobile hero + section behavior.*

### D10. Browser-support copy — stale
The philosophy doc notes existing landing copy still says **"Works in Chrome &
Edge,"** which now predates Safari 17+ support. If any such line carries into V1, it
needs updating. → *Use current support, not the stale string.*

### D11. Intentionally EXCLUDED (not gaps — confirming, so they aren't "missing")
By the brief's anti-goals these are deliberately NOT on V1 and should not be designed
in: feature grids, pricing tables, testimonials/social proof, stock DJ photos, neon,
and any "live now"/community sections (those are Phase 4 / Landing V2).

---

*Sources: `tools/docs/DESIGN_PHILOSOPHY.md`, `tools/docs/LANDING_BRIEF.md`,
`tools/docs/SOCIAL_VISION.md`. Hard rules reproduced verbatim; gaps flagged in
Section D, not invented.*
