# LIBRARY_IMPORT_V2 — audit + strategy

Status: **AUDIT + BRIEF ONLY. No feature building in this doc.** Building is
green-lit per-door afterward. Supersedes `LIBRARY_IMPORT_STRATEGY.md` (the
original 3-priority plan); that doc's instincts (rekordbox-first, never make the
user hunt) are folded in below.

## North star

The user never hunts for music — the app hunts. First-run is a wizard: "Where's
your music?" — **five doors, each one click to start.** Library setup is **the
pair-activation gate**: both halves of a pair must get their music in before the
magic moment. Every decision is measured against **time-to-first-track-loaded.**

---

## STEP 1 — AUDIT: what exists today (LIB-PHASE1/2 + rekordbox infra)

Status legend: ✅ BUILT · ◑ PARTIAL · ✗ MISSING. Evidence is `file:line`.

| # | Capability | Status | Evidence | Note |
|---|---|---|---|---|
| 1 | Folder-handle persistence (IndexedDB) | ✅ | `utils/fsa.js:128` addFolder, `:234` restoreHandles; `utils/storage.js:88` v6 `watchedFolders` store | `FileSystemDirectoryHandle` structured-cloned + spike-tested; re-resolved at mount |
| 2 | Permission re-request flow | ◑ | `utils/fsa.js:58` checkPermission/requestPermissionFor; `collabmix:1448` requestPermissionForFolder; `:1076` getFile re-grants | Works, but it's a per-folder/per-file button — NOT the single graceful "Reconnect library" moment V2 wants |
| 3 | Watched-folder rescan | ✅ | `utils/fsa.js:357` scanWatchedFolder, `:404` scanWatchedFolders; `collabmix:1508` runLibraryScan; mount + post-grant + manual triggers | Recursive, audio-filtered, async-generator |
| 4 | New-track detection banner | ✅ | `collabmix:504` pendingNewTracks; `:2344` NewTracksBanner; `:1625` commitPendingNewTracks | Count + import/skip/review |
| 5 | Metadata extraction (ID3) | ✅ | `collabmix:281` parseID3 (ID3v2.2/3/4 + v1 fallback); field map `:294` | TIT2/TPE1/TBPM/TKEY/TCON/TALB/TPUB + APIC; duration from decode |
| 6 | Artwork extract + cache | ✅ | `collabmix:312` APIC; `:366` downscaleArtwork (200×200 @0.7); `:1136` scanArtwork; `artworkCache` `:488` | ~10–20KB/track, mem + IDB, versioned |
| 7 | Dedupe | ✅ | `collabmix:448` normalizeForDedupe, `:459` tracksMatch; 2-phase manual `:898`/`:923`; auto on import `:800`; scan 2-tier `:1540` | **artist+title only** — no duration tiebreak, no hash (hash field reserved, unused) |
| 8 | iTunes / Apple Music | ✗ | — | No XML parse, no integration |
| 9 | Rekordbox (app-side) | ◑ | `src/rekordbox-library.js`, `rekordbox-sqlcipher.js`, `rekordbox-anlz.js` | Parses the DESKTOP `master.db` (SQLCipher SQLite) + ANLZ `.DAT/.EXT` (grids/cues/waveforms) in JS. NOT wired into the mixer import flow; NOT rekordbox.xml; NOT USB PDB |
| 10 | USB / removable drive | ✗ | — | No drive detect, no PIONEER-folder handling, no hot-plug |
| 11 | Multi-source / presence model | ◑ | `collabmix:830` single `{folderId, sourcePath}`; `:1017` reconnectFromFolder | One source per track; getFile falls back fileMap→OPFS→IDB but a track can't record "also on USB X" |
| 12 | Import entry points / wizard | ◑ | drag-drop `:1944`/`:2130`; importFromPicker/importFiles `:934`; addWatchedFolder `:1411` | All manual paths exist; **no first-run wizard, no onboarding** |
| 13 | Mix/recording detection | ✗ | duration extracted `:683` but never used to classify | No is_mix flag; "(Mix)" suffix is stripped at parse → identity lost |
| 14 | Track data model | ✅ | `collabmix:836` | id, filename, title, artist, album, genre, label, bpm, key, duration, energy, artwork(+version), analyzed, error, addedAt, folderId, sourcePath, hash(reserved), grid-edit fields |
| 15 | Analysis pipeline (deferred) | ✅ | `LIB_WORKER` `:403`; queueAnalysis lazy on deck-load; processQ `:661`; analyzeAll `:967` | mono 11kHz → BPM/key/energy; AudioContext recycle/50 |
| 16 | LIBRARY_MODE | ◑ | `utils/storage.js:268` ["auto-finder","manager","hybrid"], default hybrid; `collabmix:1459` | Persisted but no scan logic honors the mode yet |

**Prior tooling to reuse (not in the app yet):** `tools/rekordbox-eval/` (pyrekordbox 0.4.4 venv — has BOTH `rbxml.py` for rekordbox.xml AND `db6` for the DeviceSQL PDB, as Python *reference*), `tools/rekordbox-eval/anlz-parser.js`, `REKORDBOX_DATA_INVENTORY.md` (full ANLZ tag map: PQTZ/PQT2 grids, PCOB/PCO2 cues, PWV4/5 color waveforms, PSSI phrases), `extract-rekordbox-truth.py`. The 272-track harness proved we can read rekordbox grids/cues.

**One-line audit verdict:** the *scattered-downloads folder-scan engine* (Doors 1 & 5) is ~80% built — watched folders, rescan, metadata, artwork, banner, dedupe-lite all exist. What's MISSING is the **wizard shell**, the **four named-doors UX**, **iTunes/USB**, **multi-source + graceful presence**, **mix detection**, and **stronger dedupe**. Rekordbox parsing exists in JS but reads the wrong artifact (desktop master.db, not the .xml interchange or the USB .pdb).

---

## STEP 2 — THE V2 SPEC (merged with the above)

### DOOR 1 — "Scan my computer"  (default; the scattered-downloads majority)

Prompt for the standard four — **Music, Downloads, Desktop, Documents** — one
grant each, individually skippable. Recursive, audio-only, metadata-extract,
then **DEDUPE before showing the count.** Payoff: "Found 1,243 tracks."

- **Reuse (✅):** watched-folder add/scan/dedupe/banner pipeline (#1–4, #7), metadata/artwork (#5–6). Builds directly on LIB-PHASE2.
- **New:** the wizard step that requests the four standard dirs in sequence (each `showDirectoryPicker` needs its own user gesture — four buttons, not one); the "dedupe-then-count" payoff screen; honoring per-dir skip.
- **Effort:** **S–M (~6–10h)** — mostly UX assembly over existing engine.

### DOOR 2 — iTunes / Apple Music  (guided XML export)

Modern Music.app DB is binary/closed; the readable **`Library.xml` must be
hand-exported** (File → Library → Export Library — still supported in Music.app).
Flow: detect/ask for the XML → if absent, **10-second guided export walkthrough
with a screenshot** → parse playlists + track paths → match against the granted
Music folder → import playlists intact.

- **Honest limitation, handled gracefully:** Apple Music **streaming** tracks are
  DRM and can never import. Wizard says so **per-track** ("12 tracks are Apple
  Music streaming-only — purchase/download them to use here"), never fails
  mysteriously. (Detect via `Kind`/`Track Type`/no local `Location` in the XML.)
- **Reuse (✅):** the iTunes `Library.xml` is a plist (`<plist><dict>…`). DOMParser
  in-browser handles it. Track→File matching can reuse the path/filename match
  logic from `rekordbox-library.js:298 matchTrack`.
- **New:** plist parser, playlist model, the export walkthrough + screenshot, the
  streaming-only classifier + per-track messaging.
- **Effort:** **M (~8–12h).** The old strategy doc's "low 5–7h" under-counted the
  export-walkthrough UX + streaming-DRM handling.

### DOOR 3 — rekordbox.xml  (the documented interchange: playlists, cues, grids)

Import = playlists + cues + grids attached to matched files. **Positioning
weapon:** "your library, your cues, your grids — nothing to rebuild."

- **Reuse (✅, strong):** we already parse rekordbox **data** (grids/cues) in JS via
  `rekordbox-anlz.js` and matched 272 tracks of truth. rekordbox.xml is plain XML
  (`<DJ_PLAYLISTS><COLLECTION><TRACK …><TEMPO><POSITION_MARK>`) — DOMParser, far
  easier than the master.db we currently read. Reuse `matchTrack` + the cue/grid
  data shapes already defined.
- **New:** the XML→track/cue/grid mapper, playlist (crate) import into the
  `crates` store, and the **grid-conflict policy** (design Q below).
- **Effort:** **M (~10–14h)** incl. the grid-merge decision + cue UI plumbing.

### DOOR 4 — USB drive  (the gig stick; arguably THE pro door)

Wizard says it: "DJ with a USB? Plug it in." User picks the drive → app detects:
- **`PIONEER/` present** → a Rekordbox-prepared stick carrying the exported DB
  (`export.pdb` / `exportExt.pdb`, **binary DeviceSQL**) + `PIONEER/USBANLZ/`
  per-track ANLZ. Payoff: "Found your Rekordbox USB — 14 playlists, 482 tracks,
  cues and grids included."
- **No `PIONEER/`** → treat as a Door 1 folder scan.

- **Reuse (✅):** the per-track ANLZ on the stick is the SAME `.DAT/.EXT` format
  `rekordbox-anlz.js` already parses (grids/cues/waveforms). So once we have the
  track→ANLZ index, waveform/grid/cue extraction is solved.
- **The hard part — `export.pdb`:** see the feasibility verdict below.
- **Effort:** **L / Fable-grade** — dominated by the PDB parser (see §4).

### DOOR 5 — "Drop anything here"  (always-visible, zero ceremony)

- **Status: ✅ BUILT** — window/drop-zone drag-drop with **folder traversal** via
  `webkitGetAsEntry` (`collabmix:1944`, `:2130`) → previewImport → commitImport.
- **New (small):** keep it always-visible inside the wizard + library; route its
  output through the V2 dedupe/source model. **Effort: XS (~1–2h) confirm/polish.**

---

### CROSS-CUTTING SYSTEMS (these make the doors feel pro)

**A. DEDUPE (upgrade #7).** Same track via Downloads + USB + iTunes = ONE entry,
multiple known locations. Match: **metadata primary (artist+title+duration±2s)**,
**file hash secondary** where cheap (the reserved `hash` field — SHA-256 of a
size+head-bytes window, not the whole file). Surface honestly: "1,243 tracks, 89
duplicates merged." **Effort: S–M (~6–8h)** — extend `tracksMatch` with duration
tiebreak + optional hash + the merge-into-multi-source step.

**B. SOURCE-PRESENCE MODEL (upgrade #11 — the biggest data-model change).** Every
track knows its **source(s)**; every source has a **live/absent** state. Track
record gains `sources: [{ kind: 'folder'|'usb'|'itunes'|'rekordbox'|'opfs',
id, path, present: bool }]` (migrate the current single `folderId/sourcePath`
into `sources[0]`). USB unplugged → its tracks **gray out** with "USB not
connected — plug in [name]" + one-click reconnect on return; never look
broken/vanished. **Permission lapses use the SAME model** — one graceful
"Reconnect library" moment per session, replacing today's per-folder button
(#2 ◑). **Effort: M–L (~12–18h)** — data-model migration + presence UI + folding
the existing permission flow in. *This is the spine that makes USB + iTunes +
folders coexist.*

**C. WIZARD UX.** First-run = the five doors. Re-entrant anytime via "Add music".
Per-door progress, per-door skip, totals at the end. Copy tone: **quiet-pro
(DESIGN_PHILOSOPHY)** — confident, no exclamation marks. **Effort: M (~10–14h)**
for the shell + routing; individual doors plug in.

**D. METRICS HOOKS (beta).** Console-log level OK now: time-to-first-track per
door, door-choice distribution, dedupe rate, source-absence events. **Effort: XS
(~2h)** — `logEvent`/console hooks at the existing telemetry seam.

**E. MIX/RECORDING DETECTION.** Real Chad finding: scans ingest his own 30–90min
DJ sets as "songs." Classify at import by **duration**: `<12min` = track;
`>20min` = **auto-shelve** to a separate "Mixes & Recordings" section (visible,
reversible per-file, never deleted; wizard notes "N long recordings moved to
Mixes & Recordings"); `12–20min` gray zone = import as track with a long-track
marker, refined by **metadata votes** (genre "DJ Mix"; filename `mix/set/live/@`;
absent artist–title structure). **No review-gate friction in the wizard.**
Forward-compat: this section is the natural home for Mix//Sync's own future booth
recordings (one-truth recording feature). **Effort: S (~4–6h)** — a classifier at
import + a `librarySection: 'tracks'|'mixes'` field + a filtered view + the
per-file move/restore. **High value-per-hour (solves a live user pain).**

---

## §3 — PDB FEASIBILITY VERDICT (Door 4 deep-dive)

**Question:** can we parse `export.pdb` (DeviceSQL) in-browser?

**Verdict: FEASIBLE, medium effort — via Kaitai Struct, NOT a from-scratch port.**

- The format is fully reverse-engineered. Deep Symmetry's **crate-digger** ships a
  **Kaitai Struct definition** (`rekordbox_pdb.ksy`) describing the page/B-tree
  layout (table pointers → row groups → track/playlist/artist/… rows with file
  paths, cue refs, beat-grid refs). `rekordcrate` (Rust) and `pyrekordbox.db6`
  (Python, in our venv) are independent confirmations of the same layout.
- **Kaitai compiles `.ksy` → JavaScript** + a small KS runtime. So the path is:
  take the existing `rekordbox_pdb.ksy`, compile to JS, run it on the `File`
  bytes from the USB pick, and walk the track + playlist tables for the subset we
  need: **track rows (file path, title, artist, bpm, key, ANLZ ref), playlist
  tree, cue/grid refs.** Per-track waveforms/grids/cues then come from the ANLZ
  files we ALREADY parse (`rekordbox-anlz.js`).
- **Effort split:**
  - Kaitai-JS wiring + compiled pdb parser + subset extraction: **M (~14–20h).**
  - Mapping pdb rows → our track/crate/cue/grid model + USB source-presence: **M
    (~10–14h, shares B).**
  - From-scratch hand-port (if we avoid Kaitai): **L+ (~40h+)** — not recommended.
- **Risks:** `.ksy` drift across rekordbox 6/7 export versions (test against a
  real stick early); Kaitai-JS bundle size (~tens of KB, acceptable, lazy-load
  only when a PIONEER stick is detected); very large `.pdb` parse time (stream /
  chunk).
- **Recommendation:** Door 4 is a real **Fable-grade subproblem** but bounded by
  the Kaitai path. Do it LAST, on a real Rekordbox USB, after the source-presence
  model (B) exists to hang it on. If Kaitai drift bites, fall back to "scan the
  USB as a plain folder (Door 1) + opportunistically read ANLZ for any track we
  can path-match" — degraded but still useful.

---

## §4 — PROPOSED BUILD ORDER (with rationale)

Ordered by **time-to-first-track-loaded × reach ÷ effort**, and by what unblocks
what. Each door is independently green-lit.

1. **Wizard shell + Door 1 + Door 5 (✅ mostly built) + Metrics (D).**
   *Why first:* the default door reaches the majority, rides the ~80%-built
   folder engine, and the wizard is the pair-activation gate everything else
   plugs into. Ship the magic moment fastest. *(~M total.)*
2. **Mix/recording detection (E).**
   *Why early:* cheap, solves a confirmed live user pain (Chad's own sets), and
   keeps the Door-1 payoff count honest. *(~S.)*
3. **Dedupe upgrade (A) + Source-presence model (B).**
   *Why here:* B is the spine multi-door coexistence needs; A makes the counts
   honest once multiple doors feed in. Do them together — A merges into B's
   `sources[]`. *(~M–L.)*
4. **Door 3 — rekordbox.xml.**
   *Why before iTunes:* highest pro value, strongest reuse (we already parse
   rekordbox grids/cues; XML is the easy artifact), the "nothing to rebuild"
   positioning weapon. *(~M.)*
5. **Door 2 — iTunes/Apple Music XML.**
   *Why here:* broad mainstream reach, low-medium effort, but gated on the
   export-walkthrough UX + DRM messaging. *(~M.)*
6. **Door 4 — USB / PDB (Fable-grade).**
   *Why last:* highest effort, needs B in place + a real stick to test, and the
   Kaitai path wants a focused run. The pro "plug in your gig stick" moment is
   the trophy, not the warm-up. *(~L.)*

Permission "Reconnect library" graceful moment folds into B (step 3).

---

## §5 — OPEN DESIGN QUESTIONS FOR CHAD

1. **Grid-conflict policy (Door 3/4).** When a rekordbox grid is imported AND our
   analyzer has a grid: which wins, when, and is it user-visible? *Proposal:*
   **theirs wins when present** (they tuned it), **ours fills gaps** (tracks with
   no rekordbox grid), with a small per-deck "grid: rekordbox / analyzer" toggle
   so a DJ can override. Needs your call — it touches the onset/de-smear work we
   just shipped (our refined grid vs their PQTZ grid).
2. **Wizard placement / force.** Is first-run wizard **mandatory** (block the
   mixer until ≥1 door done, since it's the pair-activation gate) or
   **skippable** (land in an empty library with a persistent "Add music")?
   Pair-activation argues mandatory-ish; abandonment risk argues skippable.
3. **The four standard dirs (Door 1).** Confirm Music/Downloads/Desktop/Documents
   — and do we recurse the WHOLE of each (Desktop/Documents can be huge/noisy) or
   cap depth / time-box and offer "scan deeper"?
4. **Mix-detection thresholds.** `<12min` track / `>20min` mix / 12–20 gray —
   confirm the boundaries and whether the gray zone defaults to track (proposed)
   or mix.
5. **Source-presence default for OPFS-copied tracks.** Today some files are copied
   into OPFS (always-present). Do Door-1 folder scans **copy into OPFS** (robust,
   storage cost) or **reference in place** (light, needs the folder present)? This
   sets the default `present` semantics.
6. **iTunes streaming-only tracks.** Import them as **greyed/absent** placeholders
   (so playlists stay intact, with a "buy to enable" affordance) or **omit
   entirely** with a count? Proposal: greyed placeholders (playlist integrity).
7. **LIBRARY_MODE (#16).** Three modes exist (auto-finder/manager/hybrid) but no
   scan logic honors them. Do the V2 doors **retire** that concept, or map doors
   onto it (auto-finder = aggressive Door-1 rescan; manager = manual only)?

---

*Audit by Opus 4.8 against LIB-PHASE1/2 (`src/collabmix-production.jsx`,
`utils/fsa.js`, `utils/storage.js`, `src/rekordbox-*.js`) + `tools/rekordbox-eval/`.
No code changed. Build per-door on green-light.*
