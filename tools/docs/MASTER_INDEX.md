# Mix//Sync — MASTER INDEX (START HERE)

> **If you are a new Claude instance: your MEMORY summary is LOSSY, NOT the source of
> truth.** It is a compressed pointer, not the real documentation. For any real work,
> read the relevant doc below (or ask Chad to point you to it). **Do not build from
> memory alone** — that causes rebuilding work that already exists.

## Orientation (60-second version)
**Mix//Sync** is a real-time collaborative DJ web app — remote back-to-back (B2B): two
DJs, two cities, one mix. Founder **Chad** is non-developer (explain in plain English).
**Primary code file:** `src/collabmix-production.jsx` (one large file). **Production:**
`collabmix.vercel.app`, auto-deploys on push to **`master`** (the prod branch — NOT
`main`). **The 3-tool workflow:** chat-side Claude plans + searches past chats →
**Claude Code** (this tool) implements, tests, and deploys → **Claude Desktop** (Chrome
extension) does visual verification of UI/waveform work. Protocols live in `CLAUDE.md`.

## 🔒 Locked Foundations — what's SETTLED vs OPEN (orient before proposing)

Read this before proposing changes — some things are deliberately frozen, some are
in-flight. Don't re-litigate the locked ones or duplicate the in-flight ones.

**SETTLED / LOCKED:**
- **Waveform aesthetic = LOCKED** (top zoomed waveform: colours, glow, amber
  height/cap, breakdown dynamics, kick gating, opacity). Tuned eye-by-eye against
  real Rekordbox, June 26 2026. **Do not change `WF_*` defaults/presets/band-RGB or
  paint/glow/cap/gate logic without Chad's explicit approval.** → **`tools/docs/WAVEFORM_LOCKED.md`**
  (code banner at the `WF_*` block ~L159 and above `AnimatedZoomedWF`).

**JAKE TWO-MACHINE VALIDATION — plan covers TWO categories, scored SEPARATELY:**
- **`tools/docs/JAKE_VALIDATION_PLAN.md`** — (A) LOCAL logic = sync reliability + visual
  correctness (would misbehave on one machine too); (B) REAL-NETWORK = audio jitter/
  dropouts/wobble (only over the wire). Today's local fixes are NOT assumed to fix the
  audio category. A failure in one is not attributed to the other.

**SHIPPED, AWAITING CONFIRMATION:**
- **Connection / dogfood fixes** — visual-behind-audio (`?gridcouple=`), prog
  framerate throttle (`?progthrottle=`), jitter-buffer target (`?jbtarget=`) — all
  shipped to prod, **awaiting Jake B2B session confirmation**. See
  [[project_reconcile_contention]] memory.

- **Sync tempo-precision fix** — sync now matches the rate from full-precision
  `beatPeriodSec` (not rounded BPM), so two tracks both showing "128.0" but differing
  in the decimals stay beat-matched (was an AUDIO drift, not just visual — kicks
  separated through a long blend). Behind `?syncprecision=` (default ON, `=0` legacy).
  Implemented, full smoke GREEN, shipped — **awaiting Jake by-ear validation** in the
  same session as the connection fixes. VISION_5.md June 26 "SYNC TEMPO PRECISION".

**HELD (separate decision, not started):**
- **Fixed-beats-zoom** — would lock grids even for UNSYNCED/stopped different-tempo
  tracks (true Rekordbox feel). Deferred; the sync fix solves the real-use problem.

**BUILT / IN-FLIGHT:**
- **Landing page** — built in **Claude Design** (has login / create / join build).
- **App design unification** — making the **library + mixing view match the landing
  page** is the **PLANNED NEXT project**, via the Design-mocks → Code-builds loop.

## Where the LATEST state lives (check these first for "what's going on now")
1. **`VISION_5.md`** — read the **LAST 2–3 "Session end" sections** (most recent state;
   append-only canonical log).
2. **`journal.txt`** — session journal, if present.
3. **Auto-memory** `MEMORY.md` (in the memory dir) — lossy index of recent facts; a
   pointer, not the truth.
4. **`git log --oneline -15`** on `master` — what actually shipped.

## Routing table — read the doc, don't reconstruct it

| Doc | Purpose (one line) | Read this when… |
|---|---|---|
| **`CLAUDE.md`** (root) | Standing protocols (investigation-first, verification, deploy, scope) | **FIRST, every session** — before any work |
| **`VISION_5.md`** (root) | Canonical product direction + dated session log | You need product direction OR the latest state |
| `journal.txt` (root) | Session journal | Session start, for recent narrative |
| `PHASE1_BUILD_PROMPT.md` (root) | Original Phase-1 build prompt | Historical context on the initial build |
| `STORAGE.md` (root) | Storage / persistence notes | Working on library/track persistence |
| **`tools/docs/DESIGN_PHILOSOPHY.md`** | Full "Quiet Pro Tool" visual/UX spec (colors, type, spacing, bans) | **ANY visual / UI / waveform / color work** |
| `tools/docs/LANDING_PAGE_PACKAGE.md` | Consolidated landing hand-off (design system + brief + vision + gaps) | Building / designing the landing page |
| `tools/docs/LANDING_BRIEF.md` | Landing page V1 creative brief | Landing page (source brief) |
| `tools/docs/SOCIAL_VISION.md` | Community / matchmaking / feed vision (Phase 2–4) | Social features, positioning, messaging |
| `tools/docs/STRATEGIC_ROADMAP.md` | Feature sequencing | Work touches features or their order |
| `tools/docs/FEATURES_PIPELINE.md` | Feature backlog | Picking / scoping a feature |
| `tools/docs/LIBRARY_IMPORT_V2.md` (+ `_STRATEGY.md`) | Library import strategy | Library import / Rekordbox ingest work |
| `tools/docs/DROP_DETECTION_INVESTIGATION.md` | Drop-detection analysis | Drop / energy / structure detection |
| `tools/docs/STRUCTURAL_KICK_IN_INVESTIGATION.md` | "Kick-in" / structure analysis | Structure / arrangement detection |
| `tools/docs/STEP5_INVESTIGATION.md` | Step-5 analysis | That specific investigation thread |
| **`tools/smoke/README.md`** (+ `CHAOS_SCRIPT.md`) | The regression smoke suite (`npm run smoke`) | **Before pushing**, or touching sync/audio/render |
| **`tools/sota-eval/`** (23 docs) | COMPLETED analyzer / beat-detection survey | Any analyzer/beat-grid idea — **read before reopening; mostly already settled** |
| `tools/bpm-test-harness/README.md` | 272-track Rekordbox ground-truth BPM harness | Validating BPM/beat analyzer accuracy |
| `tools/rekordbox-eval/` (PHASE_* + `WAVEFORM_BUILD_PLAN.md`) | Rekordbox data / grid / waveform analysis | Rekordbox grid import, waveform render plans |

## Rule of thumb
Before proposing or building anything, find its doc above and read it. If a task spans
several (e.g. a visual feature → `CLAUDE.md` + `DESIGN_PHILOSOPHY.md` + `VISION_5.md`
latest sections), read all of them. When unsure which doc owns a topic, ask Chad to
point you — don't guess from memory.
