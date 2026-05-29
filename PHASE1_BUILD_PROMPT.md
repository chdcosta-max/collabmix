# PHASE 1 — Library auto-import: Multi-folder watched setup (plumbing only)

## Context

You are continuing work on **Mix//Sync**, a real-time collaborative DJ web app. The user (Chad) is a non-developer founder. Project root: `/Users/chad/Desktop/collabmix`. Primary file: `src/collabmix-production.jsx`.

Before doing anything else, read these in full:

1. `CLAUDE.md` (project protocols — Investigation-First, Verification, Scope Discipline, No Silent Assumptions, Commit Standards, Communication Style)
2. `VISION_5.md` (full project history and locked strategy — read all sections, do not skim)
3. `tools/docs/DESIGN_PHILOSOPHY.md` (visual / UX principles)

Worktrees `../collabmix-booth` and `../collabmix-decks` are **reference-only** — never modify them.

## What this session is for

Build **Phase 1 of the library auto-import system** — the plumbing layer that enables Phases 2-6 to follow. This is **infrastructure only**, not user-visible auto-scanning. By the end of this session:

- The user can grant Mix//Sync permission to one or more folders via Chrome's File System Access API
- Those grants persist across browser restarts
- A Settings tab lists watched folders with enable / disable / remove controls
- The data model supports everything Phase 2-5 will need (without implementing the behavior)
- Existing manual import via drag-drop and "Add music" button remains fully functional in parallel

**No file scanning, no dedup, no mode behavior, no library panel onboarding UI.** Those are Phases 2, 4, and beyond.

## STOP IMMEDIATELY conditions

**Read this section before starting. These are hard stops — do not push through.**

Stop work, report to Chad in plain English, and wait for direction if any of the following occur:

1. **Existing `_importFileObjects` or OPFS storage flow breaks** during investigation or implementation — at any point, for any reason.
2. **Any of the 135 existing tracks disappear or lose metadata** during testing — even one missing track is a stop.
3. **Build fails after any commit** — do not push, do not "fix forward," stop and report.
4. **Browser console shows new errors after any code change** — even seemingly unrelated ones.
5. **FSA spike reveals serialization problems** — do not commit to the data model, surface the finding first.
6. **Settings UI strategy is unclear and needs Chad's input** — do not assume; ask with concrete options.

When stopping, do not commit, do not push, do not attempt destructive recovery (no `git reset --hard`, no `git checkout .`, no deleting files). Report the state, explain what happened, list what you've tried, and wait.

## Locked strategic decisions (do not relitigate)

These were settled across the May 26 evening, May 27 morning, and May 27 afternoon sessions. Treat as inputs, not open questions. Full context in `VISION_5.md`.

- **Hybrid mode** is the default for new users — smart folder watching with user approval before import. Auto-Finder and Manager are alternative modes available from settings.
- **Brand principle:** "Mix//Sync respects how YOU work, not how WE think you should work."
- **Operational principle (NEW, May 27 afternoon):** **Protect user work — never destructive merging without explicit user action.** Cue points, beat grids, hot cues, tags, ratings, notes are NEVER touched without explicit opt-in. The data model in this phase must accommodate this for Phase 5 file-move / delete / rename handling.
- **Empty-app onboarding** — new users see the full Mix//Sync UI with an empty library and an "Add music to get started" prompt. **That prompt is Phase 4 work** — do not build it in Phase 1.
- **Chrome / Edge only for auto-import.** Safari users get a graceful fallback message. Manual import (existing) remains the Safari path.

## Phase 1 scope — IN

1. **File System Access API integration**
   - Use `window.showDirectoryPicker()` to request directory handles
   - Persist handles in IndexedDB (FSA handles are structured-cloneable in Chrome / Edge)
   - On app load, restore handles and re-verify permission state via `handle.queryPermission({ mode: 'read' })`
   - Show graceful message in Safari (feature-detect `window.showDirectoryPicker`)

2. **Smart default suggestions on first interaction with auto-import**
   - Offer Downloads + Music as the two suggested folders (highest-traffic locations per May 26 distribution analysis, aligned with Q3 Hybrid default)
   - User confirms each individually — granting permission per folder
   - User can decline either and add a custom folder instead
   - **"First interaction" means** when the user first opens the auto-import settings tab — not on app mount. Do not show prompts the user didn't ask for.

3. **Settings tab for watched-folder management**
   - New "Library" tab in a settings UI (if a settings UI does not exist, build a minimal one — see Investigation step)
   - List of watched folders with: name, path display, enabled toggle, remove button
   - Per-folder permission state indicator (granted / needs re-grant)
   - "Add folder" button → opens picker → adds to the list
   - **Mode toggle UI** for the three modes (Auto-Finder / Manager / Hybrid) with Hybrid pre-selected — **stored but not yet behavioral** (Phase 4 wires the differences)

4. **Permission re-grant UX (Hybrid, per P1-Q2)**
   - On app load, silently call `handle.queryPermission({ mode: 'read' })` and `handle.requestPermission({ mode: 'read' })` once per watched folder
   - If denied, mark the folder "needs permission" in settings UI — do **not** repeatedly prompt
   - User re-grants deliberately from the settings tab when they choose to

5. **Data model + persistence**
   - New IndexedDB store: `watchedFolders` with schema `{ id, name, handle, enabled, addedAt, lastScannedAt }`
   - `lastScannedAt` is `null` initially (reserved for Phase 2)
   - New IndexedDB key: `libraryMode` storing `"auto-finder" | "manager" | "hybrid"` (default `"hybrid"`)
   - **Track schema gets two new fields** (reserved, populated `null` for existing tracks):
     - `sourcePath: string | null` — file system path when known, for Phase 5 protect-user-work
     - `hash: string | null` — SHA-256 reserved for Phase 2 dedup (do NOT backfill existing 135 tracks per P1-Q1)

6. **Development telemetry / logging**
   - All folder-related events logged to browser console with `[LIB-PHASE1]` tag prefix:
     - Folder grant / deny (`[LIB-PHASE1] grant requested for <name>`, `[LIB-PHASE1] grant denied for <name>`)
     - Handle restoration on app load (`[LIB-PHASE1] restored N handles from IDB`)
     - Permission re-check results (`[LIB-PHASE1] queryPermission <name> → granted`)
     - Settings actions (folder added, removed, enable toggled, mode changed)
   - Not user-visible. Helps debugging in Phase 2 onward. Tagged for easy grep / removal later.

## Phase 1 scope — NOT (deferred — do not build)

- ❌ Scanning folder contents — Phase 2
- ❌ Deduplication logic — Phase 2
- ❌ Filtering (extension whitelist, size limits, duration check) — Phase 2
- ❌ "New tracks found" notification UX — Phase 2
- ❌ Library panel "Add music to get started" onboarding prompt — Phase 4
- ❌ Mode behavioral differences (Auto-Finder scans aggressively, Manager waits for explicit add, Hybrid notifies) — Phase 4
- ❌ File move / delete / rename handling — Phase 5
- ❌ Drag individual file from anywhere — Phase 6

If you find yourself wanting to build any of the above to "complete" Phase 1, **stop and flag it** per the Scope Discipline protocol. The scope is intentionally narrow.

## Investigation step (mandatory before any code change)

Per CLAUDE.md Investigation-First Protocol, do NOT skip to implementation. Required pre-work:

1. **Read `src/collabmix-production.jsx`** to find:
   - The `useLibrary` hook (where `_importFileObjects`, `cmDbPut`, OPFS storage live — established in commit `63ac7f9`)
   - `LibraryPanelV2` component
   - Whether a settings UI already exists (panel, modal, tab — anywhere)
   - The current IndexedDB schema (`cmDb` open call, store names, current structure)
   - Where the "Add music" button is wired today

2. **30-minute FSA spike** — verify Chrome / Edge support for `IDBObjectStore.put()` of a `FileSystemDirectoryHandle`. Spec says it works (structured-cloneable), historically there have been edge cases. Confirm with a small test:
   - Open picker, get handle
   - Put handle into IDB
   - Read back on next page load
   - Call `handle.queryPermission()` — confirm state returns
   - If anything fails, **STOP and report per STOP conditions above**. The data model depends on this working.

3. **Determine settings UI strategy**:
   - If a settings panel / modal already exists → add a new "Library" tab to it
   - If not → propose a minimal settings UI (likely a modal triggered from the top header, matching the existing top-header pattern from commit `7a2fd25` Mix Name UX)
   - **STOP and surface the strategy as a question before building** — do not assume.

4. **Report findings to Chad in plain English before proposing the fix architecture.** Per CLAUDE.md Step 1: investigate, then propose, then implement after approval.

## Implementation order (after investigation is reported and approved)

1. **Data model migration** — add `watchedFolders` store + `libraryMode` key + `sourcePath` / `hash` fields on Track schema. Migration is additive — existing data untouched.
2. **FSA permission helpers** — small utility module: `requestFolder()`, `restoreHandles()`, `checkPermission(handle)`, `removeFolder(id)`.
3. **`watchedFolders` state in `useLibrary`** — load on mount, expose via hook return.
4. **Settings UI** — new Library tab with folder list + add button + mode toggle.
5. **Telemetry pass** — sprinkle `[LIB-PHASE1]` console.log calls per the spec above.
6. **Verify manual import still works** — drag-drop a folder, click "Add music", confirm both code paths still hit `_importFileObjects` and persist correctly.

## Risk flags (acknowledged from scope review)

1. **`navigator.storage.persist()` already called** in commit `82fd5c6` (May 7). **Do NOT re-request.** Persistent storage is already granted for the OPFS / IDB tier — Phase 1 inherits that.
2. **FSA handle serialization** — see Investigation step 2 (30-min spike at start). If it fails, STOP per STOP conditions.
3. **Manual import must remain fully functional in parallel** — `_importFileObjects`, OPFS storage, dedup confirmation modal from commit `63ac7f9` must remain untouched. Phase 1 adds the new system alongside, never replaces. Verify in Implementation step 6.

## Verification expectations (per CLAUDE.md Verification Protocol)

Before declaring complete or pushing any commit, produce a verification report covering:

1. **Build status** — `npm run build` succeeded? Paste last 10+ lines.
2. **Type check / lint** — run `npm run typecheck` and `npm run lint` if scripts exist (note if they don't).
3. **Runtime check** — dev server loaded, no console errors on app mount, settings tab opens.
4. **Test data** — grant a folder, refresh page, confirm handle restored + permission re-verified. Remove the folder, confirm it's gone. Toggle modes, confirm persistence.
5. **Parallel manual import** — drag-drop a track via existing flow, confirm it still imports correctly and appears in library.
6. **What's verified vs assumed** — be explicit.
7. **Known limitations** — Safari path? Custom folder picker error states? Cloud-synced folders behavior?
8. **Recommended user verification checklist** for Chad to test before trusting in production.

### FINAL verification step — user-facing nothing-changed checklist

**This step is mandatory before commit-and-push of any individual commit, and again before declaring the session complete.** It verifies that Phase 1 plumbing has not regressed any existing functionality.

Go through each item. For any item that does NOT pass, **STOP per STOP conditions and report** — do not push.

- [ ] Drag-drop a track into the library → still works, track appears
- [ ] Play a track on Deck A → audio plays, transport responds
- [ ] Play a track on Deck B → audio plays, transport responds
- [ ] All 135 existing tracks still load and appear in library (count matches pre-change)
- [ ] Each existing track still shows its previously-set metadata — artist, BPM, key, artwork
- [ ] Beat grid editor still functional (open it, no errors, can adjust)
- [ ] Path A waveform glow still rendering correctly on both decks
- [ ] Deck colors still `#2E86DE` (Deck A Vivid Ocean Blue) and `#A855F7` (Deck B Electric Royal Purple)
- [ ] Partner online dot still green (`STATUS_OK = "#22c55e"`)
- [ ] Beatgrid 16-bar phrase marker still red (`#FF3B30`)
- [ ] Sync button functional (engage / release)
- [ ] Transport controls functional (play, pause, cue, skip)
- [ ] Chat panel functional (open, send message)
- [ ] Browser console clean (no new errors or warnings tagged outside `[LIB-PHASE1]`)
- [ ] Manual import dedup confirmation modal from commit `63ac7f9` still triggers correctly when importing duplicates

If any box can't be ticked, that is a regression. STOP and report.

## Commit standards (per CLAUDE.md)

Commit in logical chunks, not one mega-commit. Each commit message answers WHAT changed and WHY. Suggested commit slicing:

1. `Phase 1 — Add watchedFolders IDB schema + Track sourcePath/hash fields`
2. `Phase 1 — FSA permission helpers + handle persistence`
3. `Phase 1 — Library settings tab with folder list + mode toggle`
4. `Phase 1 — [LIB-PHASE1] telemetry logging`

**Run the FINAL verification step before each push.** After all commits land and verification passes: `git push origin master` deploys to production (master is the prod branch in this repo).

## Communication with Chad during the session

- Lead with plain English. Implementation detail only when relevant.
- Surface assumptions and tradeoffs proactively (per No Silent Assumptions).
- If the FSA spike reveals problems → STOP, report, ask before continuing.
- If the settings UI strategy needs a decision → STOP and ask with 2-4 concrete options.
- Don't bury bad news. If something doesn't work or is harder than estimated, say so directly.
- Use the STOP conditions as a checklist. If any apply, stop and report immediately.

## Out-of-scope cleanup to flag (if encountered)

If during investigation you notice any of the following, **flag — do not silently fix**:

- Landing-page copy "Works in Chrome & Edge" is stale post-Path-A (Safari 17+ playback works; only auto-import is Chrome / Edge only)
- Any cleanup opportunities in `useLibrary` from commit `63ac7f9`
- Schema migration questions for existing libraries

These are follow-up sessions, not Phase 1 scope.

## Session end protocol (per CLAUDE.md)

Update `VISION_5.md` with a dated section documenting:
- What was done (commits, schema changes, settings UI shape)
- What was decided (any new strategic decisions surfaced during build — should be minimal if scope held)
- What remains pending (Phase 2 entry point + any open questions for next session)

---

**Entry point summary:** Read CLAUDE.md → read VISION_5.md → read DESIGN_PHILOSOPHY.md → run investigation step (including FSA spike) → report findings to Chad → propose fix architecture → wait for Chad's approval → implement in order → run FINAL verification before each push → STOP at any of the listed conditions.
