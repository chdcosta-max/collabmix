#!/usr/bin/env python3
"""
extract-rekordbox-library.py — build a full-library ground-truth manifest
from the local Rekordbox 6 master.db.

For EVERY analyzed track in Rekordbox, extract:
  - original file path (no copying)
  - BPM (from ANLZ PQTZ tag's first beat marker — the per-bar BPM Rekordbox
    actually uses for grid display)
  - first downbeat in seconds (first ANLZ beat marker with beat==1, time/1000)
  - anomaly flags (multi-tempo, pickup beat, BPM mismatch, missing file)

Output: ./library-truth.json with a `tracks` array suitable as a manifest
for the Node analyze-library.mjs harness.

Requirements:
  pip3 install --user pyrekordbox
  Rekordbox CLOSED (master.db lock).
"""
import json
import sys
from datetime import datetime
from pathlib import Path

try:
    from pyrekordbox import Rekordbox6Database
    from pyrekordbox import anlz
except ImportError:
    sys.exit("pyrekordbox not installed. Run: pip3 install --user pyrekordbox")

HARNESS_DIR = Path(__file__).parent
OUTPUT_PATH = HARNESS_DIR / "library-truth.json"

SUPPORTED_EXTS = {".mp3", ".wav", ".flac", ".m4a", ".aiff", ".aif"}


def get_first_downbeat(content, db):
    """Return dict with bpm + firstDownbeatSec + notes, or {'error': reason}."""
    notes = []
    if not content.Analysed:
        return {"error": "not analyzed in Rekordbox"}
    try:
        anlz_paths = db.get_anlz_paths(content.ID)
    except Exception as e:
        return {"error": f"get_anlz_paths failed: {e}"}
    dat_path = anlz_paths.get("DAT") if isinstance(anlz_paths, dict) else None
    if not dat_path or not Path(dat_path).exists():
        return {"error": "ANLZ0000.DAT not found"}

    try:
        f = anlz.AnlzFile.parse_file(dat_path)
    except Exception as e:
        return {"error": f"ANLZ parse failed: {e}"}

    pqtz = f.get_tag("PQTZ")
    if pqtz is None:
        return {"error": "no PQTZ tag"}
    entries = list(pqtz.content.entries)
    if not entries:
        return {"error": "PQTZ empty"}

    first_db = next((e for e in entries if e.beat == 1), None)
    if first_db is None:
        return {"error": "no beat==1 markers"}

    bpm = first_db.tempo / 100.0
    first_downbeat_sec = first_db.time / 1000.0

    # Anomaly notes
    if first_db.time < 0:
        notes.append(f"negative-time first downbeat ({first_db.time}ms)")
    unique_tempos = set(e.tempo for e in entries)
    if len(unique_tempos) > 1:
        tempos = "/".join(f"{t/100:.2f}" for t in sorted(unique_tempos))
        notes.append(f"multi-tempo: {tempos}")
    if entries[0].beat != 1:
        notes.append(f"pickup: grid starts on beat {entries[0].beat}")
    db_bpm = content.BPM / 100.0 if content.BPM else 0
    if db_bpm > 0 and abs(bpm - db_bpm) > 0.5:
        notes.append(f"PQTZ-vs-DB BPM mismatch: {bpm:.2f} vs {db_bpm:.2f}")

    return {
        "bpm": round(bpm) if abs(bpm - round(bpm)) < 0.05 else round(bpm, 2),
        "firstDownbeatSec": round(first_downbeat_sec, 4),
        "notes": notes,
    }


def resolve_path(content):
    """Resolve the on-disk path for a content row, or None if missing."""
    if not content.FolderPath:
        return None
    p = Path(content.FolderPath)
    if p.exists():
        return str(p)
    return None


def main():
    print("Opening Rekordbox database (read-only)...")
    try:
        db = Rekordbox6Database()
    except Exception as e:
        sys.exit(f"Failed to open DB: {e}\n"
                 "If 'database is locked', close Rekordbox first.")

    tracks = []
    stats = {
        "total": 0,
        "analyzed": 0,
        "missing_file": 0,
        "unsupported_ext": 0,
        "anlz_error": 0,
        "anomalies": 0,
        "with_notes": 0,
    }

    print("Iterating content rows...")
    for content in db.get_content():
        stats["total"] += 1
        if not content.FileNameL:
            continue
        ext = Path(content.FileNameL).suffix.lower()
        if ext not in SUPPORTED_EXTS:
            stats["unsupported_ext"] += 1
            continue
        path = resolve_path(content)
        if path is None:
            stats["missing_file"] += 1
            continue
        info = get_first_downbeat(content, db)
        if "error" in info:
            stats["anlz_error"] += 1
            continue
        stats["analyzed"] += 1
        track_entry = {
            "path": path,
            "basename": Path(path).name,
            "bpm": info["bpm"],
            "firstDownbeatSec": info["firstDownbeatSec"],
            "rekordboxId": str(content.ID),
        }
        if info["notes"]:
            track_entry["notes"] = "; ".join(info["notes"])
            stats["with_notes"] += 1
            # Multi-tempo / pickup / BPM-mismatch all count as anomalies
            stats["anomalies"] += 1
        tracks.append(track_entry)
        if stats["analyzed"] % 100 == 0:
            print(f"  ...processed {stats['analyzed']} analyzed tracks")

    # BPM distribution summary
    bpm_buckets = {}
    for t in tracks:
        b = int(round(t["bpm"]))
        key = f"{(b//5)*5}-{(b//5)*5+4}"
        bpm_buckets[key] = bpm_buckets.get(key, 0) + 1

    manifest = {
        "_comment": (
            "Full-library ground truth from Rekordbox 6 master.db. "
            "firstDownbeatSec is the time of the first beat-1 marker in "
            "the PQTZ beat grid. notes flag pickup beats, multi-tempo, "
            "or DB/PQTZ BPM disagreements."
        ),
        "extractedAt": datetime.now().isoformat(),
        "source": "Rekordbox 6 master.db via pyrekordbox 0.4.4",
        "stats": stats,
        "bpmDistribution": dict(sorted(bpm_buckets.items())),
        "tracks": tracks,
    }
    OUTPUT_PATH.write_text(json.dumps(manifest, indent=2) + "\n")

    # Print summary
    print()
    print("═" * 72)
    print("REKORDBOX LIBRARY EXTRACTION — SUMMARY")
    print("═" * 72)
    print(f"  Total content rows:        {stats['total']}")
    print(f"  Successfully extracted:    {stats['analyzed']}")
    print(f"    with anomaly notes:      {stats['with_notes']}")
    print(f"  Skipped (missing file):    {stats['missing_file']}")
    print(f"  Skipped (unsupported ext): {stats['unsupported_ext']}")
    print(f"  Skipped (ANLZ error):      {stats['anlz_error']}")
    print()
    print("  BPM distribution:")
    for k, v in sorted(bpm_buckets.items(), key=lambda x: int(x[0].split('-')[0])):
        bar = "█" * min(40, v)
        print(f"    {k:>9} BPM: {v:>4}  {bar}")
    print()
    print(f"  Wrote manifest: {OUTPUT_PATH}")
    print(f"  Run: node analyze-library.mjs --manifest library-truth.json")


if __name__ == "__main__":
    main()
