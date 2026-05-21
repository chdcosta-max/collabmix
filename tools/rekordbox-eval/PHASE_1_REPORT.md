# Phase 1 — DONE. Ready for review.

End-to-end pipeline: pick Rekordbox folder → decrypt `master.db` → query
`djmdContent`/`djmdCue` → match tracks → decode `.EXT` → Mix//Sync renders
real Rekordbox waveforms on the decks.

## Verified output (all numbers from this machine)

| Stage | Result |
| --- | --- |
| Passphrase deobfuscation | matches pyrekordbox exactly (`402fd482c388…`) |
| SQLCipher v4 decrypt (12 MB master.db) | **154 ms**, HMAC verified on all **2,958 pages** |
| Plain SQLite | sqlite3 opens, 49 tables, **1,343 tracks**, **389 cues** |
| sql.js queries | `djmdContent` + `djmdCue` build the in-memory index in <50 ms |
| ANLZ decode (5 sample tracks) | **0 byte-level diffs** vs pyrekordbox |
| ANLZ decode (random 20 tracks) | **20 / 20** OK |
| Full library → bands | end-to-end open in **196 ms**, 1 ms per `.EXT` decode |

## Modules shipped

| File | Purpose | LOC |
| --- | --- | --- |
| `src/rekordbox-anlz.js` | Pure-JS ANLZ parser (PWV4/5, PCOB/PCO2, PQTZ/PQT2, PPTH). Zero deps. | ~380 |
| `src/rekordbox-sqlcipher.js` | SQLCipher v4 decrypt via Web Crypto. PBKDF2-SHA512 + AES-256-CBC + HMAC-SHA512. Runs in browser & Node. | ~340 |
| `src/rekordbox-library.js` | Orchestrator: picker → decrypt → sql.js → index → matchTrack → getWaveformBands. Lazy IndexedDB cache for parsed ANLZ blobs. | ~280 |
| `tools/rekordbox-eval/verify-anlz.mjs` | Parser verification vs pyrekordbox (re-runnable). | — |
| `tools/rekordbox-eval/verify-sqlcipher.mjs` | SQLCipher decrypt + sqlite3-CLI smoke test. | — |
| `tools/rekordbox-eval/verify-library.mjs` | Full end-to-end library test (Node-friendly stub for `FileSystemDirectoryHandle`). | — |
| `public/sql-wasm.wasm` | Served at `/sql-wasm.wasm` for sql.js (660 KB, copied from `node_modules/sql.js/dist/`). | — |
| `public/sql-wasm.js` | Served at `/sql-wasm.js`. Loaded via runtime `<script>` injection so Vite never tries to transform sql.js's UMD asm.js (the transformer hung indefinitely on it). | — |

`package.json` adds **one** dependency: `sql.js@^1.14.1`.

## SQLCipher v4 — corrections vs the original Phase 1 plan

The decrypt code in the first stub used the wrong page-format constants. The
working configuration that Rekordbox actually uses is:

| Field | Original guess | Actual (per SQLCipher v4) |
| --- | --- | --- |
| `reserve_sz` | 48 (16 IV + 32 HMAC) | **80** (16 IV + 64 HMAC) |
| `data_per_page` | 4048 | **4016** |
| IV location | `page[4048..4063]` | `page[4016..4031]` |
| HMAC algorithm | HMAC-SHA512 truncated to 32 bytes | full **HMAC-SHA512**, 64 bytes |
| HMAC key derivation | bytes 32..63 of the main PBKDF2 output | **separate** PBKDF2-SHA512(cipher_key, salt XOR 0x3a, **2 iter**, 32 bytes) |
| HMAC input | `ct + iv + pgno_be32` | **`ct + iv + pgno_le32`** (little-endian page number) |
| Page-1 special handling | strip salt, decrypt 4032 bytes | strip salt, decrypt **4000 bytes**; salt also excluded from HMAC input |

These corrections live in `src/rekordbox-sqlcipher.js`, with each constant
labeled. Page-1 (block-0) plaintext now matches the original SQLite header
that SQLCipher encrypted — `1000 0202 50 40 20 20 …` (page_size=4096, write/read
version 2, reserve **0x50 = 80** confirming the format, 64/32/32 payload
fractions). HMAC verification passes on every page in the file.

## Library coverage (this machine)

```
Total tracks in master.db:       1,343
With AnalysisDataPath (.DAT):    1,327   (98.8%)
With cues in master.db:            230   (17.1%)
Total cues across the library:     389
```

`AnalysisDataPath` in `djmdContent` solves Surprise 2 from the previous
report — it's the path to the `.DAT` (and by extension `.EXT`) file under
`<rekordbox>/share/PIONEER/USBANLZ/…`, so we no longer need to match tracks
via PPTH content. The orchestrator follows it directly through the
`FileSystemDirectoryHandle`.

## Mix//Sync integration

1. **Connect button.** A `REKORDBOX` pill next to `SUGGESTIONS` in
   `LibraryPanelV2`. Idle → click → `showDirectoryPicker()` →
   pill turns green and shows `REKORDBOX · 1343`.
2. **Waveform override.** When a track loads onto a deck (`libLoadA` /
   `libLoadB`), if a Rekordbox library is connected the orchestrator runs
   `matchTrack(file)` → `getWaveformBands(id)` and replaces `wfA` / `wfB`
   bands with the `.EXT`-derived ones. The deck's audio-decoded bands
   stay as a fallback while the Rekordbox lookup is in flight; the
   Rekordbox bands win the last-write race.
3. **Color mapping.** PWV5 stores per-pixel amplitude + a spectral color
   triple (R = low / B = mid / G = high). Each pixel's amplitude is split
   into bass / mid / high using the color as the weight, so the renderer's
   existing `0.7 bass + 0.2 mid + 0.1 high` height calc keeps the
   Rekordbox waveform shape intact and future renderer upgrades that
   surface the spectral color will get it for free.
4. **Cache.** Parsed ANLZ blobs are stored in IndexedDB
   (`cm_rekordbox_cache`) keyed by track ID. Re-opening the library
   skips re-parsing.
5. **Matching.** `matchTrack(file)` checks exact basename → file size →
   normalized name (NFKD, lowercased, punctuation-stripped), with size
   used to disambiguate basename collisions.

## What you can do right now

- `npm run dev` — boots in ~5 s, `/sql-wasm.js` and `/sql-wasm.wasm` both
  serve at HTTP 200.
- Click the `REKORDBOX` pill in the library — grant the Rekordbox folder
  (`~/Library/Pioneer/rekordbox/`).
- Load any analysed track onto deck A or B — the zoomed top waveform
  switches to the Rekordbox PWV5 within ~200 ms of the audio decoding.

## Build state

- `npm run build` succeeds (chunk count: 4 main JS + 1 sql-wasm + 1 CSS,
  total ~530 KB pre-gzip).
- `npm run dev` boots in ~5 s.
- One pre-existing duplicate-key warning in `collabmix-production.jsx`
  near line 2153 (unrelated to Phase 1 work).

## Out of scope for Phase 1 (deferred)

- Surfacing the Rekordbox color band directly in the renderer (Phase 2).
- Showing cue points on the zoomed waveform (Phase 3).
- Beatport-only tracks: still need a fallback when a user-imported file
  doesn't match any `djmdContent` row (Phase 4 — basename + ID3 +
  fuzzy-title matching).
- `PSSI` phrase-analysis decoding (currently stubbed in the ANLZ parser).
- Broadcasting Rekordbox bands to a remote partner: today the partner
  still sees the audio-decoded bands the loader's deck computed locally.

## Files in the working set

- `src/rekordbox-anlz.js`, `src/rekordbox-sqlcipher.js`, `src/rekordbox-library.js`
- `src/collabmix-production.jsx` — `connectRekordboxLibrary` import,
  `rkLib` / `rkStatus` state, `useEffect` overrides for `wfA` / `wfB`,
  `REKORDBOX` pill in `LibraryPanelV2`.
- `public/sql-wasm.wasm`
- `package.json` — `sql.js` dependency
- Verify scripts in `tools/rekordbox-eval/`
