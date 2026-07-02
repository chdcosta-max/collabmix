# UI Audit — live deck + mixer UI vs Design Philosophy

**Date:** July 2, 2026
**Auditor:** read-only design-system pass (no source files changed)
**Scope:** the live in-session product UI — decks, mixer, library, transport,
and the session chrome (top bar) — in `src/collabmix-production.jsx`.
**Reference docs:** `tools/docs/DESIGN_PHILOSOPHY.md`,
`tools/docs/WAVEFORM_LOCKED.md`.

This is a to-do list, worst offenders first. Every entry cites a real
`file:line` you can hand to a developer, in plain English plus the exact rule
it breaks.

---

## How to read this

- **Major** = loud, visible, breaks the "Quiet Pro Tool" identity at a glance.
- **Minor** = real divergence but small, low-traffic, or arguably semantic.
- **Compliant** = called out at the end so this isn't all bad news. Big chunks
  of the app are done right.

### The design rules I audited against (extracted from the docs)

1. **One accent only: white at three opacities** — 0.9 (primary/active), 0.6
   (secondary), 0.3 (borders/inactive). *"Single accent: white at varying
   opacity. No amber, no warm accent."*
2. **Active state = clean white, never green.** Green (`#22c55e`, the
   `STATUS_OK` constant) is allowed ONLY for semantic status (recording dot,
   partner-online dot, "ready" badge).
3. **Deck colors `#2E86DE` (A) / `#A855F7` (B) are the ONLY saturation** in the
   app.
4. **Text is clean white `#F5F5F7`.** Borders are `rgba(255,255,255,0.06)`
   (subtle) / `0.12` (defined).
5. **Sentence case everywhere. NEVER all-caps for display.**
6. **Transitions:** 150ms `cubic-bezier(0.4,0,0.2,1)` (per CLAUDE.md; the
   philosophy doc says 200ms — see note in "Compliant").
7. **No glassmorphism, no background gradients, no decoration.** Restraint.
8. **Banned colors:** old deck pairs `#0F4FA0`/`#1FC97A`, `#1976D2`/`#00C853`,
   Material primaries, and **warm accents (amber) at UI scale**. Warm hues are
   allowed only at marker scale (cue points, phrase markers, recording dot).
9. **Quiet tone:** confident, not shouty; no aggressive/attention-grabbing
   animations; no exclamation marks; few icons.

### Excluded from ranking (by instruction)

- **The top zoomed waveform (`AnimatedZoomedWF`, ~L5178+) is LOCKED.** It uses
  warm amber + cream bands, which technically breaks "no warm waveforms" — but
  that is an **explicitly approved override** (`WAVEFORM_LOCKED.md`, and the
  philosophy doc's waveform section). **Do not touch. Not an offender.**
- **The landing page (`Landing`, ~L8759–9350)** is the reference the design
  system was built from, not in-session UI. Its gradients/copy are out of scope.
- **Debug-only surfaces** behind URL flags (`SyncDebugHUD` ~L4620, `RTCPanel`
  L8234, `MidiPanel` L8288) — dev tooling, not the shipped product surface.
  Noted lightly where relevant but not ranked.

---

## RANKED TOP 10 (worst first)

### 1. Crossfader fill uses BANNED, retired colors — blue→green, not blue→purple  · MAJOR
- **Where:** `src/collabmix-production.jsx:12083`
- **Plain English:** The crossfader is a central, always-on mixer control. As
  you slide it, the fill bar is a gradient from **an old retired blue
  (`#0F4FA0`) to a bright green (`#1FC97A`)**. Both colors are on the *banned*
  list — `#1FC97A` is exactly the "bright neon green as fill" the docs forbid,
  and `#0F4FA0` is the deck-A blue that was retired back on May 24. The current
  decks are blue `#2E86DE` and purple `#A855F7`, so the crossfader should read
  **A-blue → B-purple**. Instead it shows blue → green, which contradicts the
  deck identity right in the middle of the mixer.
- **Rules broken:** *"Banned colors … `#0F4FA0` … `#1FC97A`"*, *"Deck colors
  are the ONLY saturation"*, and *"no background gradients / excessive
  gradients."*
- **Fix direction:** rebuild the fill from the live deck colors (blue→purple),
  or drop the gradient for a flat white-opacity indicator.

### 2. Secondary/muted text is hardcoded grey, not white-at-opacity — everywhere  · MAJOR (systemic)
- **Where:** defined at `src/collabmix-production.jsx:2447` (`SUBTLE = "#9CA3AF"`)
  and `2448` (`MUTED = "#5A5E66"`); used **~87×** (`#9CA3AF`) and **~36×**
  (`#5A5E66`) across the file.
- **Plain English:** Almost every piece of secondary text — track time, artist,
  the "Master" label, EQ knob labels, skip arrows, inactive buttons, VU meters —
  is painted a solid cool grey rather than **white at 0.6 / 0.3 opacity** as the
  system requires. Individually each is quiet, but it's the single most
  widespread divergence: the whole app is subtly off-palette.
- **Rules broken:** *"Single accent: white at varying opacity … Secondary
  `rgba(255,255,255,0.6)` … Tertiary `rgba(255,255,255,0.3)`."*
- **Note:** the transport row (item under "Transport" below) and a few newer
  spots already use the correct `rgba(255,255,255,0.6/0.3)` tokens — proof the
  fix is just swapping greys for those tokens.

### 3. Top-bar status text is ALL-CAPS and shouty  · MAJOR
- **Where:** connection state `sync.status.toUpperCase()` at
  `src/collabmix-production.jsx:11804`; the AUDIO pill labels
  `"AUDIO: STREAMING"`, `"AUDIO: NO OUTPUT"`, `"AUDIO: OFFLINE"`,
  `"AUDIO: FAILED"`, `"AUDIO: CONNECTING…"` at `11815–11822`.
- **Plain English:** The very top of the screen shows uppercase status like
  **CONNECTED** and **AUDIO: STREAMING**. All-caps is explicitly banned for
  display, and the "AUDIO: …" phrasing reads as a system alert, not a quiet pro
  tool. This is high-visibility (top bar, always on).
- **Rules broken:** *"Sentence case throughout (NEVER all-caps for display)"*
  and *"the opposite of loud or shouty."*
- **Fix direction:** sentence case ("Connected", "Audio streaming" or just a
  colored dot + "Streaming").

### 4. Amber (`#f59e0b`) used as a UI accent — a banned warm color  · MAJOR
- **Where:** ~26 uses. Live examples: sync-button "analyzing" state
  `src/collabmix-production.jsx:8142` (amber border + amber text); AUDIO
  "connecting" pill `11821`; autoplay banner `11882`; VU/level meter ladder
  `4655`.
- **Plain English:** Amber `#f59e0b` is used to signal "busy/analyzing/warning"
  in several places. The design system bans warm accents entirely at UI scale —
  the *only* sanctioned accent is white, and the only sanctioned status color is
  the green `STATUS_OK`. Warm hues are allowed only at marker scale (cue dots,
  phrase markers).
- **Rules broken:** *"No amber, no warm accent"* and the banned-colors list
  (*"Warm deck/UI colors … amber"*).
- **Fix direction:** use white-opacity for busy states, or a small neutral
  spinner; reserve color for the genuine error (red) and ready (green) states.

### 5. All-caps labels scattered through library, panels, and empty states  · MINOR (but a pattern)
- **Where:** sidebar section heads "SMART" / "FOLDERS"
  `src/collabmix-production.jsx:2855, 2858`; library tabs forced uppercase
  `2970`; suggestions header "SUGGESTIONS FOR" `3427`; grid-panel "ANCHOR"
  label `7798`; the "No track loaded…" empty-state, uppercased `11895`;
  "YOU" / "SESSION" badges `11890, 11897`.
- **Plain English:** A handful of labels are ALL CAPS (some via `textTransform:
  "uppercase"`, some typed in caps). The system calls for sentence case
  everywhere. None is huge on its own, but together they're a recurring tic.
- **Rule broken:** *"Sentence case throughout (NEVER all-caps for display)."*

### 6. Pulsing red/amber alert animations  · MINOR
- **Where:** AUDIO "NO OUTPUT" pulses red (`pulse:true`)
  `src/collabmix-production.jsx:11816`; REC badge pulses `11871`; autoplay
  banner `11878–11882`.
- **Plain English:** Error/recording chips blink to grab attention. These are
  genuine states, but a pulsing red bar is closer to "loud DJ software" than
  "quiet confidence." Consider a steady (non-blinking) treatment.
- **Rule broken:** *"No aggressive animations or attention-grabbing elements."*

### 7. Emoji used as UI icons in copy  · MINOR
- **Where:** 🔇 in the autoplay banner `src/collabmix-production.jsx:11882`;
  plus ⟺ (partner pill), ⓘ (storage banner), ⟳ (loop) nearby.
- **Plain English:** Emoji stand in for icons in a few places. The docs warn
  against "too many icons" and decoration; emoji in particular read as consumer,
  not pro tool.
- **Rule broken:** *"Too many icons"* / *"Functionality is the aesthetic — don't
  decorate."*

### 8. A grey "brand accent" (`G`) mislabeled "gold", used app-wide  · MINOR
- **Where:** `src/collabmix-production.jsx:11747` — `const G = "#9CA3AF"; //
  gold accent — matches App.jsx landing`. Used for the `Mix//Sync` logo mark,
  the "⟺ partner" pill, the MIDI badge, and the active-tab underline (`2956`).
- **Plain English:** This introduces a fourth "accent" (grey) that isn't in the
  system — the accent is supposed to be white-at-opacity, with saturation
  reserved for the decks. The comment says it matches a *gold* accent on the
  landing page, but the value is grey — so either the code drifted from the
  landing or the comment is stale. Worth reconciling against the landing page.
- **Rule broken:** *"Single accent: white at varying opacity"* / *"Multiple
  accent colors competing."*

### 9. Glassmorphism — `backdrop-filter: blur()` on the top bar and overlays  · MINOR
- **Where:** top bar `src/collabmix-production.jsx:11794`
  (`background:"#000000f0", backdropFilter:"blur(16px)"`); also the waveform
  zoom overlay and a few panels (`2345, 3268, 3498, 11950`).
- **Plain English:** The top bar is a translucent, blurred surface — a
  glassmorphism effect. The docs list glassmorphism as an explicit
  anti-pattern. It's subtle here, so it's minor, but it's on the "never do"
  list by name.
- **Rule broken:** *"Glassmorphism / neumorphism"* (anti-pattern list).

### 10. Decorative glows / drop-shadows on controls  · MINOR
- **Where:** EQ knob glow `src/collabmix-production.jsx:6187`
  (`boxShadow: 0 0 8px ${color}22` when off-center); mixer card
  `0 8px 32px rgba(0,0,0,.8)` (`11993`); crossfader handle drop-shadows
  (`12086, 12088`).
- **Plain English:** A few controls carry soft glows/shadows for depth. Small,
  and the knob glow is arguably useful feedback, but the system leans "don't
  decorate — function shapes form." Lowest-priority cleanup.
- **Rule broken:** *"Functionality is the aesthetic. Don't decorate."*

---

## By screen

### (a) DECKS

**Mostly compliant — this is a strong area.**
- Track title `#F5F5F7` white, sentence case, size 20 — correct (`7515`).
- Camelot key chip is white on a white-opacity border — correct; amber was
  deliberately removed here in v5.2 (`7545`).
- BPM is neutral gray with a *documented, deliberate* "no amber/red escalation"
  restraint — good pro-tool discipline (`7561` region).
- Deck cards adopt the correct identity colors `#2E86DE`/`#A855F7` (`11982`,
  `12097`), and the active-driver border uses them at low alpha — correct
  "decks are the only saturation."

**Divergences:**
- Inline track time and artist use grey `#9CA3AF` / `#5A5E66` instead of
  white-0.6/0.3 (`7524`, `7532`). *(instance of Top-10 #2)*
- Grid-panel "ANCHOR" label is all-caps (`7798`), though its color already
  correctly uses `rgba(255,255,255,0.6)`. *(instance of Top-10 #5)*
- Hot-cue chips pull from `HOT_CUE_COLORS = ["#9CA3AF","#ef4444","#22c55e",
  "#f59e0b"]` (`6196`). Cue points are explicitly a sanctioned marker-scale
  color use ("cue points deserve love, color-coded"), so this is *allowed* — but
  cue A being grey and the label/time text using greys is worth a light tidy.

### (b) MIXER (EQ / faders / crossfader / channel)

- **Crossfader fill** — Top-10 #1 (banned blue→green gradient, `12083`).
- **EQ knobs & channel strips** — **compliant**: knobs and faders take the deck
  identity color per side (`12013–12016`, `12045`), VU per channel is deck
  color (`12008`). Decks-as-only-saturation done right.
- **Knob default + labels** — the `Knob` default `color="#9CA3AF"` (`6182`) and
  its label text `#9CA3AF` (`6190`) are grey; in the live mixer the color is
  overridden to the deck color (good), but the label text stays grey.
  *(instance of Top-10 #2)*
- **Master fader + master VU** — label "Master" grey `#9CA3AF99` (`12043`) and
  VU `color="#9CA3AF"` (`11996`). The master fader is the one control that
  legitimately shouldn't be a deck color, so this is exactly where the **white-
  0.3/0.6 tokens** should be used instead of grey. *(instance of Top-10 #2)*
- **Crossfader "CTR" reset button** — all-caps abbreviation, grey `#5A5E66`
  (`12089`). Minor.
- **Knob glow** — decorative box-shadow (`6187`). *(instance of Top-10 #10)*

### (c) LIBRARY

- Panel background is `#0D0F12` (`2442`), not the sanctioned `#000000` shell or
  `#15171A` panel — a small near-black drift (the app has several: `#0D0F12`,
  `#0A0B0E`, `#06070A`). All in the cool-dark family, so **minor**, but the
  palette lists specific surface tokens and these aren't them.
- Sidebar "SMART"/"FOLDERS" headers all-caps + grey `MUTED` (`2855, 2858`).
  *(Top-10 #5)*
- Library tabs forced uppercase, letterSpacing 1.5 (`2970`); active tab uses the
  grey `G` underline (`2956`). *(Top-10 #5 + #8)*
- "SUGGESTIONS FOR" header all-caps + grey (`3427`); the deck badge beside it
  correctly uses `DECK_A_CLR`/`DECK_B_CLR` (`3433`) — good.
- Footer buttons ("+ Add music") are restrained grey text-buttons (`2867`) —
  the intent (quiet CTAs) is right; just on the grey-vs-white-opacity theme.
- Suggestions panel slide-in shadow `-10px 0 28px` (`3423`) — mild decoration,
  minor.

### (d) TRANSPORT (cue / play / sync / loop / M / time)

**This is the best-executed screen — use it as the template.**
- White play button: white-at-0.9 fill, white glow when playing, `#0A0B0E` glyph
  on white, no green — textbook (`8107–8120`).
- Sync button: white active states, subtle white glow when locked, sentence-case
  "Sync" / "Armed" — matches "the most important button … locked together"
  (`8135–8178`).
- M (master) button: white active, no green (`8180–8188`).
- Cue / Grid buttons: correct white-opacity tiers (`8046`, `8032`).
- Transitions here are all `150ms cubic-bezier(0.4,0,0.2,1)` — the sanctioned
  curve.

**Divergences:**
- Sync "analyzing" state uses amber `#f59e0b` (`8142`). *(Top-10 #4)*
- Skip-beat arrows and inactive states use grey `#9CA3AF`/`#5A5E66`
  (`8058`, `8082`). *(Top-10 #2)*
- Loop-clear "✕" uses red `#ef4444` (`8008`) — semantic destructive, acceptable.

### Session chrome — TOP BAR

- All-caps status + "AUDIO: …" labels — Top-10 #3 (`11804`, `11815–11822`).
- Pulsing red/amber chips — Top-10 #6 (`11816`, `11871`).
- Emoji copy — Top-10 #7 (`11882`).
- Grey brand accent `G` on the logo/pills — Top-10 #8 (`11747`).
- Glassmorphism blur — Top-10 #9 (`11794`).
- Leave button red border/text (`11907`) — semantic destructive, acceptable.
- **Good tone note:** the "Room complete · 2 DJs" case is deliberately a calm
  neutral chip instead of a red error (`11806`) — exactly the right instinct.

---

## What's COMPLIANT and good (credit where due)

- **The transport controls** (play / sync / M / cue / grid) are the design
  system done right: white-at-opacity, white active glow, no green, sentence
  case, correct 150ms easing. Everything else should be leveled up to match.
- **Deck identity discipline:** EQ knobs, faders, VU meters, channel labels,
  deck-card borders, and the suggestions deck badge all correctly use
  `#2E86DE`/`#A855F7` and nothing else saturated.
- **Deck header:** white title, white Camelot chip (amber removed), and a BPM
  readout with a *documented* decision to stay neutral gray and never escalate
  to amber/red — genuine pro-tool restraint.
- **Transitions:** the app is remarkably consistent on `150ms cubic-bezier(0.4,
  0,0.2,1)`. *(One doc-hygiene note: the philosophy doc says "standard 200ms"
  while CLAUDE.md and the code say 150ms — worth reconciling the docs, but the
  code is internally consistent, so this is not a UI offender.)*
- **`STATUS_OK` green** is used correctly for semantic status (online/ready/
  recording), not as an active-button state.

## Waveform — LOCKED, excluded

The top zoomed waveform (`AnimatedZoomedWF`, ~L5178+) uses warm amber + cream
bands, which would normally violate "no warm waveforms." This is an **approved
override**, frozen per `tools/docs/WAVEFORM_LOCKED.md`. **Do not change it.** It
is correctly not counted as an offender.

## Appendix — latent risks (defined but not currently rendered)

These aren't live offenders (I couldn't find them drawn on screen), but they're
rainbow palettes sitting in the code that would violate "one accent / decks are
the only saturation" the moment they're wired up:
- `ENERGY_COLOR` (`841`) — a 5-color blue/green/amber/orange/red palette; no
  live render found.
- `SES_AVATAR_COLORS` / `sesAvatarColor` (`2195–2196`) — eight multi-hue
  gradient pairs for session avatars; no live call found.

If either is planned for use, run it past the design system first.
