#!/usr/bin/env python3
"""
extract-rekordbox-truth.py — derive ground truth for the BPM test harness
from a local Rekordbox 6 master.db.

For every .mp3 in ./tracks/, find the matching Rekordbox library entry by
basename, parse its ANLZ analysis file, and emit BPM + first-downbeat-in-
seconds. Output goes to ./rekordbox-truth.json (NOT directly to
ground-truth.json — review first, then merge or rename).

Tracks that already exist in ground-truth.json are reported as
comparisons (Rekordbox vs manual measurement) without overwriting.

Requirements:
  pip3 install --user pyrekordbox
  Rekordbox application closed (master.db lock).
"""
import json
import sys
from pathlib import Path

try:
    from pyrekordbox import Rekordbox6Database
    from pyrekordbox import anlz
except ImportError:
    sys.exit("pyrekordbox not installed. Run: pip3 install --user pyrekordbox")

HARNESS_DIR = Path(__file__).parent
TRACKS_DIR = HARNESS_DIR / "tracks"
EXISTING_GT_PATH = HARNESS_DIR / "ground-truth.json"
OUTPUT_PATH = HARNESS_DIR / "rekordbox-truth.json"
TOLERANCE_MS_CONSISTENCY_OK = 20   # match harness tolerance
TOLERANCE_MS_CONSISTENCY_FLAG = 50

# ── Load existing ground truth so we can compare (not overwrite) ───────────
existing_gt = {}
if EXISTING_GT_PATH.exists():
    raw = json.loads(EXISTING_GT_PATH.read_text())
    for k, v in raw.items():
        if not k.startswith("_"):
            existing_gt[k] = v

# ── Discover tracks ────────────────────────────────────────────────────────
track_files = sorted(p.name for p in TRACKS_DIR.glob("*.mp3"))
if not track_files:
    sys.exit(f"No .mp3 files in {TRACKS_DIR}")

print(f"Inspecting {len(track_files)} mp3 files in {TRACKS_DIR.name}/...")
print()

# ── Open Rekordbox DB ──────────────────────────────────────────────────────
try:
    db = Rekordbox6Database()
except Exception as e:
    sys.exit(f"Failed to open Rekordbox DB: {e}\n"
             "If 'database is locked', close Rekordbox first.")

# Build basename → DjmdContent map. Many library files may share basenames
# (e.g., '01 Cavalier ...' from multiple albums) — collect all candidates per
# basename and we'll resolve later if needed.
basename_map = {}
for content in db.get_content():
    if not content.FileNameL:
        continue
    basename_map.setdefault(content.FileNameL, []).append(content)

# ── Extract per track ──────────────────────────────────────────────────────
new_entries = {}
comparisons = []
anomalies = []
missing = []

def get_first_downbeat(content):
    """Return (bpm, firstDownbeatSec, notes_list) or (None, None, reason)."""
    notes = []
    if not content.Analysed:
        return None, None, "track not analyzed in Rekordbox"
    if not content.AnalysisDataPath:
        return None, None, "no AnalysisDataPath in DB"

    # The AnalysisDataPath in DB is relative; pyrekordbox resolves it.
    try:
        anlz_paths = db.get_anlz_paths(content.ID)
    except Exception as e:
        return None, None, f"get_anlz_paths failed: {e}"

    dat_path = anlz_paths.get("DAT") if isinstance(anlz_paths, dict) else None
    if not dat_path or not Path(dat_path).exists():
        return None, None, f"ANLZ0000.DAT not found ({dat_path})"

    try:
        anlz_file = anlz.AnlzFile.parse_file(dat_path)
    except Exception as e:
        return None, None, f"failed to parse ANLZ: {e}"

    pqtz = anlz_file.get_tag("PQTZ")
    if pqtz is None:
        return None, None, "no PQTZ (beat grid) tag in ANLZ"

    entries = list(pqtz.content.entries)
    if not entries:
        return None, None, "PQTZ has no beat entries"

    # First beat-1 in the grid = musical bar-1
    first_db = next((e for e in entries if e.beat == 1), None)
    if first_db is None:
        return None, None, "no beat==1 markers in grid (unusual)"

    first_downbeat_sec = first_db.time / 1000.0
    bpm = first_db.tempo / 100.0

    # Anomaly detection
    if first_db.time < 0:
        notes.append(f"first downbeat is negative ({first_db.time}ms); using as-is")
    # Multi-tempo check
    unique_tempos = set(e.tempo for e in entries)
    if len(unique_tempos) > 1:
        tempos_str = "/".join(f"{t/100:.2f}" for t in sorted(unique_tempos))
        notes.append(f"multi-tempo: {tempos_str} BPM")
    # If first beat in grid is NOT a beat-1, that's a pickup. Report.
    if entries[0].beat != 1:
        notes.append(f"grid starts on beat {entries[0].beat} (pickup); first beat-1 at entry {entries.index(first_db)}")
    # If first beat-1 isn't the first beat, it just means pickup notes.
    # Sanity: rekordbox BPM might not match Rekordbox's "track BPM" field
    if abs(bpm - content.BPM / 100.0) > 0.5:
        notes.append(f"PQTZ BPM ({bpm:.2f}) differs from track.BPM ({content.BPM/100:.2f})")

    return bpm, first_downbeat_sec, notes

# ── Process each track ─────────────────────────────────────────────────────
for fn in track_files:
    candidates = basename_map.get(fn, [])
    if not candidates:
        missing.append(fn)
        continue
    if len(candidates) > 1:
        anomalies.append(f"{fn}: {len(candidates)} DB matches — picking first")
    content = candidates[0]

    bpm, fd, info = get_first_downbeat(content)
    if bpm is None:
        anomalies.append(f"{fn}: SKIP — {info}")
        continue

    notes = info if isinstance(info, list) else []
    entry = {
        "bpm": round(bpm) if abs(bpm - round(bpm)) < 0.05 else round(bpm, 1),
        "firstDownbeatSec": round(fd, 4),
        "source": "rekordbox",
    }
    if notes:
        entry["notes"] = "; ".join(notes)

    if fn in existing_gt:
        old_bpm = existing_gt[fn]["bpm"]
        old_fd = existing_gt[fn]["firstDownbeatSec"]
        delta_ms = abs(fd - old_fd) * 1000
        flag = "✓" if delta_ms <= TOLERANCE_MS_CONSISTENCY_OK else (
               "~" if delta_ms <= TOLERANCE_MS_CONSISTENCY_FLAG else "⚠")
        comparisons.append((fn, old_bpm, old_fd, entry["bpm"], fd, delta_ms, flag))
    else:
        new_entries[fn] = entry

# ── Report ─────────────────────────────────────────────────────────────────
print("═" * 78)
print("CONSISTENCY CHECK (tracks already in ground-truth.json)")
print("═" * 78)
if comparisons:
    print(f"{'flag':<6}{'Δms':<6} {'track':<55}{'old fd':>9} → {'rkb fd':>9}")
    print("-" * 95)
    for fn, ob, of, nb, nf, dm, flag in comparisons:
        name = fn if len(fn) <= 53 else fn[:50] + "..."
        print(f"  {flag:<4}{int(round(dm)):<5} {name:<55}{of:>9.4f} → {nf:>9.4f}")
else:
    print("  (none)")
print()

print("═" * 78)
print("NEW GROUND TRUTH (will be written to rekordbox-truth.json)")
print("═" * 78)
print(f"{'track':<60}{'bpm':>7}{'firstDownbeatSec':>20}  notes")
print("-" * 110)
for fn, e in sorted(new_entries.items()):
    name = fn if len(fn) <= 58 else fn[:55] + "..."
    notes = e.get("notes", "")
    print(f"  {name:<58}{e['bpm']:>7}{e['firstDownbeatSec']:>20.4f}  {notes}")
print(f"\n  Total new entries: {len(new_entries)}")
print()

if anomalies or missing:
    print("═" * 78)
    print("ANOMALIES / SKIPPED")
    print("═" * 78)
    for a in anomalies:
        print(f"  ⚠  {a}")
    for fn in missing:
        print(f"  ?  {fn}: not found in Rekordbox library")
    print()

# ── Write output ───────────────────────────────────────────────────────────
output = {
    "_comment": (
        "Rekordbox-extracted ground truth. Generated from "
        "~/Library/Pioneer/rekordbox/master.db via pyrekordbox. "
        "Merge into ground-truth.json after review. Source field flags "
        "Rekordbox-derived entries; notes flag pickup beats, multi-tempo, "
        "or DB-PQTZ-BPM mismatches."
    ),
    **new_entries,
}
OUTPUT_PATH.write_text(json.dumps(output, indent=2) + "\n")
print(f"Wrote {len(new_entries)} new entries to {OUTPUT_PATH.name}")
print("Review, then merge into ground-truth.json (or rename if you trust them as-is).")
