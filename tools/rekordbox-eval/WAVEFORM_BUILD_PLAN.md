# Waveform Build Plan

Plan answers all six architecture questions BEFORE any production code is touched. Review before Phase 1 starts.

## Critical reality check: Mix//Sync is a web app

This drives every other answer.

`src/collabmix-production.jsx` runs in Chrome (Vercel-deployed). Browser code **cannot read `~/Library/Pioneer/rekordbox/`** without explicit user permission via the File System Access API. There's no native filesystem path.

Two viable shapes for getting Rekordbox data in:

**Shape A (recommended) — in-browser, one-time directory grant.** User clicks "Connect Rekordbox Library", picks the `~/Library/Pioneer/rekordbox/` folder once via `showDirectoryPicker()` (the same API the existing `reconnectFromFolder` already uses). The browser hands us a `FileSystemDirectoryHandle`. We then:
1. Read `master.db` via [sql.js](https://github.com/sql-js/sql.js) (WASM SQLite, ~700 KB).
2. Walk `share/PIONEER/USBANLZ/**/ANLZ0000.EXT` files for waveform/cue data.
3. Parse them with a JS ANLZ decoder (port of the pyrekordbox PWV4/PWV5/PCOB/PCO2 decoders).
4. Cache parsed results in IndexedDB so subsequent sessions are instant.

No external sidecar. No Python. Works after one folder-grant. The browser permission persists across sessions (we already do this for music folders via `reconnectFromFolder` — same mechanism).

**Shape B (rejected) — Python sidecar.** User runs `export-rekordbox.py` periodically, drag-drops JSON into Mix//Sync. Simpler to build (~3 hrs vs ~12 hrs), but you specified no Python in production. Rejected per non-negotiable.

Plan proceeds with Shape A.

---

## Q1. Track matching: Mix//Sync ↔ Rekordbox

### What we have on each side

Mix//Sync track record (from `_importFileObjects`, line 595):
```
{ id, filename, title, artist, album, genre, label, bpm, key, duration, ... }
```
- `filename` is the basename without extension (e.g., `04 Coaster (Durante Remix)`)
- `title` and `artist` come from ID3, fall back to parsing the filename
- **No file path stored** — the File object's path is not exposed by the browser

Rekordbox master.db (per pyrekordbox / our existing extractor):
- `djmdContent.FolderPath` = full file path (e.g., `/Users/chad/Music/.../04 Coaster (Durante Remix).mp3`)
- `djmdContent.FileNameL` = filename with extension
- `djmdContent.Title`, `djmdContent.Artist` (joined from artist table)
- `djmdContent.AnalysisDataPath` = path to ANLZ folder

### Match strategy (ordered)

1. **Primary: case-insensitive filename match (no extension).** Mix//Sync's `filename` field vs Rekordbox's `FileNameL` with extension stripped. Cheap, exact, works for the bulk case (user imports the same file Rekordbox indexed).

2. **Secondary: artist + title fuzzy match.** Lowercase + strip punctuation/whitespace, compare both fields. Catches renamed files. ~95% reliable for tracks with clean ID3.

3. **Tertiary: file-size + duration match.** Only used when 1 and 2 produce zero or multiple candidates. Browser exposes `File.size`; duration we extract during analysis.

### Tracks we'll miss

- **Beatport stream refs** (path like `?/beatport:tracks:20022210`): no local file path. If user has the file but Beatport-imported it into Rekordbox, ID3 tags still match → Strategy 2 covers it.
- **Tracks renamed AFTER Rekordbox indexed**: Strategy 1 fails, Strategy 2 catches if ID3 intact.
- **Live recordings / one-shot WAVs**: often no ID3 tags + generic filenames. Will miss. Fallback to default waveform.

Expect 90-95% match rate on the user's prog house library. Document the misses on first connect so the user knows.

---

## Q2. Performance: 50K-entry PWV5 per track

### Costs we care about

- **Parse cost**: pyrekordbox decoded a ~50K-entry PWV5 in <50 ms. Pure JS will be ~2-3× slower (no NumPy vector ops). ~100-150 ms per track.
- **Storage cost (decoded)**: PWV5 = 50K samples × 4 numbers (height + R + G + B) × 4 bytes (Float32) = 800 KB raw. Compressed (uint8 packed): ~200 KB.
- **Storage cost (raw bytes)**: PWV5 raw is 100 KB per track (2 bytes × 50K entries). PWV4 + PWV5 together ~110 KB.
- **Total for 1,343-track library**: ~150 MB if we decode-and-cache. ~150 MB if we keep raw + decode on demand. Either fits comfortably in IndexedDB (browsers allow GBs).

### Plan: lazy + cached

- On directory grant, walk the USBANLZ tree and **store the raw .EXT bytes** in IndexedDB keyed by Rekordbox track-uuid. No decoding yet.
- On track load (Deck A or B), look up the raw bytes by trackId, decode PWV4 + PWV5 + cues. Cache the *decoded* result in a session Map (`Map<trackId, {bands, cues, ...}>`).
- Subsequent loads of the same track hit the session Map: ~0 ms.
- Cold load on Deck A: ~150 ms decode + ~20 ms render. Imperceptible.

Eager pre-decoding all 1,343 tracks on connect would take ~3 min (single-threaded). Tempting for "warm cache" feel but wasteful — user only plays 20-30 tracks per session.

---

## Q3. Storage: where do decoded waveforms live

### Three layers

1. **Raw .EXT bytes**: IndexedDB. Persisted across sessions. Survives page reload. Refreshed when user re-runs "Connect Rekordbox Library" (in case master.db changed). ~110 KB × 1,343 tracks ≈ 150 MB.

2. **Decoded waveform per loaded track**: in-memory Map. Cleared on page reload. Re-decoded on demand.

3. **Mix//Sync's existing waveform cache** (`wfA`, `wfB` state): unchanged. Receives the bands from either Rekordbox decode (new path) or the in-app analyzer (existing path).

The existing in-app waveform analysis pipeline (`onWaveform` callback at line 4128) keeps working. We just intercept *before* it for tracks that have Rekordbox data.

---

## Q4. Sync with current waveform code

### Current architecture

- `WF` (line 2793): small per-deck waveform.
- `AnimatedZoomedWF` (line 2930): big top zoomed waveform.
- Both consume `bands = { bass: Float32Array, mid: Float32Array, high: Float32Array, dur, name }`.
- Bands produced inside `Deck` component, posted to parent via `onWaveform` (line 4128).

### Recommended approach: augment, don't replace

The current renderers already accept a 3-band format. Rekordbox PWV5 IS a 3-band format (R = bass-band amplitude proxy, G = mid, B = high). The mapping is:

```js
// Per pixel column in PWV5:
//   height = combined amplitude (0-31 → 0-1)
//   colors[i] = [R, G, B], values 0-14 / 0-7 / 0-7
bass[i] = height[i] * (colors[i][0] / 14);
mid[i]  = height[i] * (colors[i][1] / 7);
high[i] = height[i] * (colors[i][2] / 7);
```

This produces the same `{bass, mid, high}` shape the existing renderer consumes. Zero rendering-code changes needed for Phase 1. The visual quality lift comes entirely from the *source* data being multi-band (Rekordbox's analysis) rather than amplitude-only (current in-app analysis).

### Feature flag

Add `useRekordboxWaveforms: boolean` to settings. Default off until Phase 2 sign-off. After sign-off, default on. Keep the flag for at least one release cycle so we can disable without redeploying if something blows up.

---

## Q5. Mix//Sync's track data model — cue storage

### What exists

Track record fields (line 595): `id, filename, title, artist, album, genre, label, bpm, key, duration, energy, analyzed, error, addedAt, artwork`.

`hotCues` ALREADY exists as a prop passed to the `WF` component (line 4260: `hotCues={hotCues}`). Renders existing-app cues, currently empty/unused. Let me verify the renderer side.

### Minimum data model changes

**Add to track record** (persist to IndexedDB):
```js
rekordbox: {
  matched: true | false,
  matchedBy: "filename" | "artist+title" | "size+duration",
  uuid: "...",  // Rekordbox internal ID for cache lookup
}
```

**Per-track waveform cache** (separate IndexedDB store):
```js
{
  uuid: "...",       // primary key
  trackId: "t_...",  // Mix//Sync trackId for cross-reference
  pwv4Raw: Uint8Array,  // PWV4 tag bytes
  pwv5Raw: Uint8Array,  // PWV5 tag bytes
  cues: [{          // decoded PCOB + PCO2 merged
    type: "hot" | "memory",
    index: 0..7,    // hot cue slot, or sequential for memory
    time: 12.345,   // seconds
    color: "#FF0000",  // resolved from Rekordbox color index
    label: "Drop"
  }]
}
```

Cues live in the same store as the waveform raw bytes (one row per track). Looking up cues + waveform is one query.

The existing `hotCues` prop pipeline ALREADY exists in the renderer. We populate it. No rendering changes.

---

## Q6. Cue rendering — match Rekordbox's pattern

### How Rekordbox does it

Looking at Rekordbox's UI (the source of truth here):
- **Hot cues**: small filled triangle/marker at the cue time, color-coded, labeled with cue letter (A-H) or memory text. Above the waveform, not over it.
- **Memory cues**: thinner vertical line at cue time, in the cue's color. Label visible above on hover.
- **Loops**: range marker spanning two cue points, semi-transparent fill of the cue color.

### Recommended implementation (matches the existing `WF` hotCues prop pattern)

```jsx
// In WF / AnimatedZoomedWF:
// For each cue:
//   - hot: ▼ marker above waveform at cuePixel, color={cue.color}, label={cue.label || cue.slot}
//   - memory: thin vertical line through waveform at cuePixel, color={cue.color}, opacity 0.6
// On hover (within 8px horizontally): show label tooltip
```

Existing waveform component already has space above the waveform for indicators. Render markers there. No layout change.

### Color sources

Rekordbox stores cue colors as palette indices (0-15 typically). The palette is well-documented in crate-digger. We resolve at parse time and store as hex strings in the cue record.

---

## Implementation phases (recap with concrete steps)

### Phase 1 — Waveform data plumbing (~12-15 hrs)

1. **Port the ANLZ parser to JS** (`src/rekordbox-anlz.js`).
   - Parse the file structure (TLV: 4-byte type tag + 4-byte length + payload)
   - Tag decoders for PWV4 (color preview), PWV5 (color detail), PCOB (legacy cues), PCO2 (extended cues), PSSI (phrase, not used yet but free)
   - Decode logic matches pyrekordbox's `.get()` methods exactly
   - Unit-tested against the 1,000-pixel JSON sample from `tools/rekordbox-eval/sample_waveform.json`

2. **Integrate sql.js for master.db** (`src/rekordbox-db.js`).
   - Lazy-load the sql.js WASM (~700 KB) only when user clicks "Connect Rekordbox Library"
   - Parse `djmdContent` table to build the track-uuid → file metadata map
   - Resolve cue colors from `djmdColor` palette table

3. **Connect-library flow** (UI button in the Library panel).
   - User clicks → `showDirectoryPicker()` → walk for `master.db` + `share/PIONEER/USBANLZ/*/ANLZ0000.EXT`
   - Build the per-track row in IndexedDB
   - Report match count + miss list to user

4. **Decode + cache cycle**.
   - On Deck track load: lookup `rekordbox.uuid` from track record, fetch raw bytes from IndexedDB, decode to `{bands, cues}`, populate `wfA`/`wfB` and cue state via existing channels.

**Acceptance**: 5 sample tracks decode correctly, output matches the Python `sample_extract.py` for the same input files. Same heights, same color RGB, same cue positions.

### Phase 2 — Waveform rendering (~4-6 hrs)

5. **Wire decoded bands into existing renderer**. PWV5 height + RGB → existing `{bass, mid, high}` shape.
6. **Side-by-side QA**. Open same track in Mix//Sync and Rekordbox. Screenshot. Compare overall shape, color distribution, peak density. Adjust the RGB→band mapping if needed (we may need to recalibrate the height multiplier; the current renderer expects 0-1 floats but might need a different scale).

**Acceptance**: visual side-by-side passes user sign-off.

### Phase 3 — Cue overlay (~4-6 hrs)

7. **Cue overlay in `WF` and `AnimatedZoomedWF`**. Hot cues as labeled markers above the waveform, memory cues as vertical lines through it. Hover tooltips.
8. **Cue palette mapping**. Resolve Rekordbox color IDs to hex; match the in-app cue color scheme where possible.

**Acceptance**: cues at correct positions, colors, labels, matches Rekordbox display. User sign-off.

### Phase 4 — Fallback handling (~2-3 hrs)

9. **Status indicator**. Small badge in the deck or library row: "RB" if Rekordbox-matched, hidden otherwise. Tooltip explains.
10. **Graceful failure**. Non-Rekordbox tracks fall back to current in-app waveform analysis. No crash. No UI change other than missing the badge.

**Acceptance**: load a non-matched track, no crash, current rendering, no badge.

---

## Total effort estimate

- Phase 1: 12-15 hrs (ANLZ parser, sql.js, connect flow, decode cache)
- Phase 2: 4-6 hrs (renderer wiring + side-by-side QA)
- Phase 3: 4-6 hrs (cue overlay)
- Phase 4: 2-3 hrs (fallback + badge)

**Total: 22-30 hours of development.** Realistic for a focused 3-4 day push.

---

## Risk register

1. **sql.js bundle size (~700 KB)**: lazy-loaded only on Connect, so no startup impact. Acceptable.
2. **showDirectoryPicker permission persistence**: Chrome remembers it across sessions if the user grants "persistent" mode. Same pattern as existing `reconnectFromFolder`. Low risk.
3. **Color mapping calibration**: PWV5's R band is 3 bits × 2 (range 0-14), G/B are 3 bits (0-7). The current renderer's band format may have different amplitude semantics; we may need to scale or remix. Worst case: 2-3 hr tuning iteration in Phase 2.
4. **Track-match miss rate**: if the user's filenames diverge significantly from Rekordbox's, miss rate could be high. Phase 1 surfaces this via the match-rate report; we adjust matching strategy if needed.
5. **Beatport-streamed tracks** (path field is `?/beatport:tracks:XXX`): match only by artist+title. Less reliable. Documented; not blocking.
6. **Rekordbox 7 vs 6 schema differences**: pyrekordbox 0.4.4 was tested against 6. We're on 7. Existing extractor works (we already used it for truth labels), so probably fine, but worth verifying on first Connect attempt.

---

## Open question for review

The plan assumes **in-browser parsing via sql.js + showDirectoryPicker** (Shape A). This is the cleanest UX but adds ~700 KB to the JS bundle (lazy-loaded). 

Alternative Shape B (Python sidecar) is faster to build (~3 hrs) but you specified no Python in production. **Confirm Shape A is what you want before I start Phase 1**, or tell me if you'd prefer a Node CLI sidecar (intermediate option — ~5 hrs, no Python, no bundle bloat, but does require user to run a command).

---

## What I won't touch until you sign off

- `src/collabmix-production.jsx`: no changes until Phase 2.
- `tools/bpm-test-harness/`: untouched.
- No new dependencies installed yet. sql.js + the ANLZ JS parser are new code, will go through normal `package.json` review when I add them.
