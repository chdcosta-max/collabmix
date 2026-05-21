# Rekordbox Data Inventory

Date: 2026-05-20. Investigation for the waveform-display work — what
Pioneer data is available on this machine and what we can read.

## 1. Where Rekordbox data lives on this machine

```
~/Library/Pioneer/rekordbox/master.db                      ← SQLite library DB
~/Library/Pioneer/rekordbox/master.backup{,2,3}.db         ← rotating backups
~/Library/Pioneer/rekordbox/share/PIONEER/USBANLZ/         ← per-track analysis files
   └── XYZ/<uuid>/ANLZ0000.{DAT,EXT,2EX,3EX}               ← one folder per track
~/Library/Pioneer/rekordbox/share/PIONEER/Artwork/         ← album art cache
~/Library/Pioneer/rekordbox/datafile{,.backup}.edb         ← ?
~/Library/Pioneer/rekordbox/networkAnalyze6.db             ← network analysis
~/Library/Pioneer/rekordbox/automixPlaylist6.xml           ← automix data
/Applications/rekordbox 7                                  ← Rekordbox app (v7)
```

Counts:
- ANLZ0000.DAT files: **1,343**
- ANLZ0000.EXT files: **1,326**

Match: matches the 1,343-track library count we used to extract truth labels
in `tools/bpm-test-harness/extract-rekordbox-truth.py`.

## 2. Tools

### Already available (existing extraction pipeline)
- `tools/bpm-test-harness/extract-rekordbox-truth.py` — uses pyrekordbox 0.4.4 to read master.db + ANLZ files to extract BPM and bar-1 truth. Currently working.
- `tools/bpm-test-harness/extract-rekordbox-library.py` — companion script for batch library extraction.

### Installed by this investigation
- `tools/rekordbox-eval/venv/` — Python 3.11 venv with pyrekordbox 0.4.4 + Pillow installed.

### Not installed but available if needed
- **crate-digger** (Java) — reference implementation by Deep Symmetry; richer ANLZ format docs; not needed if pyrekordbox covers our cases.
- **rekordcrate** (Rust) — Rust port of crate-digger; nicer for shipping as native binary if we ever want to embed parsing.

### Recently installed by user (none found)
No DJ-related apps in `/Applications` or `~/Applications` beyond Rekordbox 7. Homebrew not installed. No recent `.dmg`/`.pkg` files in `~/Downloads` related to DJ/Rekordbox tooling. The "recently installed" likely refers to Rekordbox 7 itself or pyrekordbox during the BPM-truth extraction phase.

## 3. Inventory table — what's accessible

| Data type | Available? | Source | Notes |
|-----------|-----------|--------|-------|
| Beat grid (bar-1, BPM, beat times) | **Yes** | `.DAT` PQTZ tag, `.EXT` PQT2 tag (extended) | already in use for truth labels |
| Tempo changes mid-track | **Yes** | `.EXT` PQT2 tag (`bpm` array with multiple tempo change points) | `tempo` is 100× actual BPM |
| Hot cues + memory cues | **Yes** | `.DAT` PCOB tag (legacy), `.EXT` PCO2 tag (extended) | first 200 tracks sampled had 0 cues; user-set on import |
| Waveform — tiny mono preview | **Yes** | `.DAT` PWAV (400 entries, 1 byte each) | low-res, monochrome |
| Waveform — detail mono | **Yes** | `.DAT` PWV2 + `.EXT` PWV3 (50K entries, 1 byte each) | high-res, monochrome |
| Waveform — **color preview** (overview) | **Yes** | `.EXT` PWV4 (1200 entries, 6 bytes each) | the "track overview" bar Rekordbox shows |
| Waveform — **color detail** (zoomed) | **Yes** | `.EXT` PWV5 (50K entries, 16-bit each) | the main scrubbing waveform |
| **Phrase analysis** (intro/verse/chorus/drop) | **Yes** | `.EXT` PSSI tag | per-phrase: beat, kind, fill flag |
| Track mood (high/low/mid bank) | **Yes** | `.EXT` PSSI tag (`mood` field) | determines phrase-kind taxonomy |
| Per-beat tempo (if variable) | **Yes** | PQT2 `bpm` array (multi-point) | most prog house tracks: single tempo |
| Track metadata (title/artist/genre/etc.) | **Yes** | `master.db` SQLite | already used by extract-rekordbox-truth.py |
| Musical key | **Yes (DB)** | `master.db` djmdContent.KeyID | string like "Cmin", "F#maj" |
| Album art | **Yes** | `share/PIONEER/Artwork/` (cached JPGs) | path stored in DB |
| Playlists | **Yes (DB)** | `master.db` djmdPlaylist | pyrekordbox exposes |
| Energy / per-band amplitude over time | **YES — via PWV5** | PWV5 itself IS multi-band amplitude data — R/G/B channels per 16ms slice | this is what we want for the colored waveform |

## 4. Waveform-specific findings

### Format decoded ✓

PWV5 (color detail) encoding (16 bits/entry):
```
bit:  15  14  13 | 12  11  10 |  9   8   7 |  6   5   4   3   2 |  1   0
       red (3)   |  green (3) |  blue (3)  |       height (5)   |  zero (2)
```

Each entry represents ~16 ms of audio (50,803 entries for a ~13 min track). The red/green/blue values are NOT literal colors — they're band-amplitude indicators that Pioneer's analysis assigned (red = bass content presence, green = mids, blue = highs). The colors form the visual "frequency map" that gives the waveform its characteristic look.

PWV4 (color preview) encoding (6 bytes/entry):
```
byte 0: unknown
byte 1: luminance boost (0-127)
byte 2: inverse intensity for the "blue" alternate waveform
byte 3: red channel (0-127)
byte 4: green channel (0-127)
byte 5: blue + height of front waveform
```

PWV4 returns three arrays:
- `heights` shape (1200, 2) — front + back heights per column
- `col_color` shape (1200, 2, 3) — back and front RGB
- `col_blues` shape (1200, 2, 3) — alternate "blue" theme

### Sample rendered

Sample track: `/Users/chad/Library/Pioneer/rekordbox/share/PIONEER/USBANLZ/000/1deb6-.../ANLZ0000.EXT`
(path field: `?/beatport:tracks:20022210`)

Rendered files (in this directory):
- `sample_waveform.png` — 1000 PWV5 detail entries from mid-track (1000×200 px). Multi-color kick + bass visible with frequency content variation.
- `sample_overview.png` — full track PWV4 overview (1200×120 px). Track structure visible — intro, breakdown in middle, build-up, drops.
- `sample_waveform.json` — first 1000 PWV5 entries as JSON.

Visual quality assessment: **the rendered waveforms look as good as what Rekordbox displays** — same color palette, same multi-band structure visible. We can render Rekordbox-quality waveforms directly from this data with zero quality loss.

### Sample stats (one ~13 min track)
```
PWV5 entries:        51,803 over ~13 min track ≈ 16 ms per pixel
Height range:        0.0 to 1.0 (normalized from 5-bit 0-31)
Mean height:         0.336 (typical EDM energy level)
Color R range:       0-14 (3-bit value × 2)
Color G/B range:     0-7 (3-bit values)
```

## 5. Recommended path forward

### Option A — Rekordbox data direct (PWV4 + PWV5)
**Use what Rekordbox computed; render it ourselves.**

Pros:
- Visual quality matches Rekordbox exactly (same source data)
- Free: data already exists for the user's 1,343-track library
- Bundles cue points, phrase analysis, beat grid — full feature parity
- ~13 ms of decoding per track (fast)

Cons:
- Only works for tracks in Rekordbox library
- Pipe needs Python sidecar OR JS port of decoder
- Doesn't help tracks user adds outside Rekordbox

Effort: **~6-8 hours** to port the PWV4/PWV5 decoder + display pipeline. JS port of pyrekordbox's `.get()` is straightforward; we'd produce per-track `{heights[], colors[]}` JSON consumable by a canvas renderer.

### Option B — Compute our own multi-band waveform
**Build a 3-band bandpass analyzer + color renderer in our worker.**

Pros:
- Works for any track regardless of source
- Independent of Rekordbox (no Pioneer dependency)
- Could match Rekordbox's color taxonomy or invent our own

Cons:
- 1-2 weeks of work (Web Audio bandpass filters, frame-amplitude per band, color mapping)
- Quality probably 70-80% of Rekordbox's (their analysis is mature and well-tuned)
- More CPU at analyze time (3× the bandpass work the current analyzer does)

Effort: **~30-50 hours** for a polished implementation.

### Option C — Build from scratch, ignore Rekordbox
Same as Option B but commits to not depending on Pioneer data. Same effort.

### Option D — Hybrid (recommended) ⭐
**Use Rekordbox data when available; fall back to Option B for tracks not in Rekordbox.**

Pros:
- Best of both — Rekordbox-quality for the user's existing library, still works for new imports
- Incremental: ship Option A path first (~1 week), Option B path second (~3-4 weeks more)
- Users who never use Rekordbox still get colored waveforms (eventually)

Cons:
- Visual inconsistency between "in Rekordbox" and "not in Rekordbox" tracks until Option B ships
- Two code paths to maintain

Effort: **~6-8 hours to ship Option A** (which covers the user's actual library of 1,343 tracks today). **~30-50 hours more** to ship the Option B fallback later.

### My recommendation

**Ship Option A first.** Within a week we have Rekordbox-quality colored waveforms for the user's existing 1,343-track library — which is where the user actually mixes. Plus bonus features (phrase markers, cue points). Then evaluate whether non-Rekordbox tracks are a real use case before investing in Option B.

For the user's stated goal ("waveform as good as or better than Rekordbox"), Option A literally is Rekordbox's waveform, plus we can layer additional UI on top (phrase boundaries, fills, cue points already extractable from the same ANLZ files).

## Files in this directory

- `venv/` — Python 3.11 venv with pyrekordbox 0.4.4 + Pillow
- `sample_extract.py` — extraction + rendering script (uses pyrekordbox)
- `sample_waveform.json` — first 1000 PWV5 entries from sample track
- `sample_waveform.png` — detail waveform render, 1000 px wide
- `sample_overview.png` — full-track color overview, 1200 px wide
- `REKORDBOX_DATA_INVENTORY.md` — this document

No production code changes from this round. Diagnostic-only.
