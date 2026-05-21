#!/usr/bin/env python3
"""
madmom_run.py — runs madmom DBNDownBeatTracker on a list of tracks and
compares first-downbeat time to Rekordbox truth.

Reads track paths + truth from the harness manifest at
../bpm-test-harness/library-truth.json. Track selection is hardcoded below:
- Group A: 13 known Sub-cause B failures (analyzer Δ = -20 to -27 ms)
- Group B: 15 random PASS tracks (sampled from the harness's most recent
  full-library snapshot — used to confirm madmom doesn't break tracks we
  already get right).

Output: writes a markdown table to MADMOM_DIAGNOSTIC.md, also prints to stdout.

Run-time: ~12 s per track (RNN inference dominates).
For 28 tracks: ~5-6 min.

Usage:
    source venv/bin/activate
    export PATH=/Users/chad/Desktop/collabmix/tools/bpm-test-harness/node_modules/ffmpeg-static:$PATH
    python madmom_run.py
"""

import json
import os
import random
import sys
import time
from pathlib import Path

# Ensure ffmpeg-static is on PATH even if user forgot to export it.
HARNESS_DIR = Path(__file__).resolve().parent.parent / "bpm-test-harness"
FFMPEG_DIR = HARNESS_DIR / "node_modules" / "ffmpeg-static"
if str(FFMPEG_DIR) not in os.environ.get("PATH", ""):
    os.environ["PATH"] = str(FFMPEG_DIR) + os.pathsep + os.environ.get("PATH", "")

MANIFEST = HARNESS_DIR / "library-truth.json"
SNAPSHOT = HARNESS_DIR / "snapshots" / "fix-D.json"  # latest production snapshot, contains current PASS/FAIL labels

# Group A — 13 known Sub-cause B failures. Substrings matched against `basename`.
GROUP_A_SUBSTRINGS = [
    "Body Stars",
    "Scarlet Sails",
    "Aurora",
    "Coaster",
    "Leave the World",
    "Serenità",
    "Fly Fox",
    "Great Attractor",
    "Astronauts",
    "Finding Estrella",
    "Swans",
    "Sparky",
    "Track II",
]

TOL_STRICT_MS = 10   # user-specified
TOL_HARNESS_MS = 20  # actual harness tolerance


def load_tracks():
    """Return (group_a, group_b) lists of dicts. Each dict has basename, path,
    truth_ms, baseline_status, baseline_ana_ms.
    """
    manifest = json.loads(MANIFEST.read_text())
    snapshot = json.loads(SNAPSHOT.read_text())
    snap_by_path = {r["path"]: r for r in snapshot["results"]}

    by_basename_sub = {}
    for t in manifest["tracks"]:
        for sub in GROUP_A_SUBSTRINGS:
            if sub.lower() in t["basename"].lower():
                by_basename_sub[sub] = t
                break

    group_a = []
    missing = []
    for sub in GROUP_A_SUBSTRINGS:
        t = by_basename_sub.get(sub)
        if not t:
            missing.append(sub)
            continue
        s = snap_by_path.get(t["path"], {})
        group_a.append({
            "basename": t["basename"],
            "path": t["path"],
            "truth_ms": t["firstDownbeatSec"] * 1000,
            "baseline_status": s.get("status", "?"),
            "baseline_ana_ms": (s.get("analyzerFirstDownbeatSec") or 0) * 1000,
            "baseline_delta_ms": s.get("deltaDownbeatMs"),
        })

    if missing:
        print(f"WARNING: could not match Group A subs in manifest: {missing}", file=sys.stderr)

    # Group B — 15 random PASS tracks from snapshot
    pass_rows = [r for r in snapshot["results"] if r.get("status") == "PASS"]
    random.seed(42)
    random.shuffle(pass_rows)
    group_b_rows = pass_rows[:15]
    group_b = []
    for r in group_b_rows:
        group_b.append({
            "basename": r["basename"],
            "path": r["path"],
            "truth_ms": r["truthFirstDownbeatSec"] * 1000,
            "baseline_status": r["status"],
            "baseline_ana_ms": (r.get("analyzerFirstDownbeatSec") or 0) * 1000,
            "baseline_delta_ms": r["deltaDownbeatMs"],
        })

    return group_a, group_b


def run_madmom(path, rnn, dbn):
    """Returns (first_downbeat_ms, total_runtime_s, error)."""
    t0 = time.time()
    try:
        acts = rnn(path)
        beats = dbn(acts)
        # beats is array of [time_sec, bar_pos]. bar_pos=1 marks a downbeat.
        downbeats = beats[beats[:, 1] == 1]
        if len(downbeats) == 0:
            return None, time.time() - t0, "no downbeats detected"
        first = downbeats[0, 0] * 1000.0
        return first, time.time() - t0, None
    except Exception as e:
        return None, time.time() - t0, str(e)


def main():
    print("Loading manifest and snapshot...", file=sys.stderr)
    group_a, group_b = load_tracks()
    print(f"Group A: {len(group_a)} tracks", file=sys.stderr)
    print(f"Group B: {len(group_b)} tracks", file=sys.stderr)

    print("Initializing madmom processors...", file=sys.stderr)
    from madmom.features.downbeats import DBNDownBeatTrackingProcessor, RNNDownBeatProcessor
    rnn = RNNDownBeatProcessor()
    dbn = DBNDownBeatTrackingProcessor(beats_per_bar=[4], fps=100)

    all_results = {"group_a": [], "group_b": []}

    for group_name, tracks in [("group_a", group_a), ("group_b", group_b)]:
        print(f"\n=== {group_name.upper()} ===", file=sys.stderr)
        for i, t in enumerate(tracks):
            print(f"  [{i+1}/{len(tracks)}] {t['basename'][:50]}...", file=sys.stderr)
            ms, secs, err = run_madmom(t["path"], rnn, dbn)
            r = dict(t)
            r["madmom_ms"] = ms
            r["madmom_runtime_s"] = secs
            r["madmom_error"] = err
            if ms is not None:
                r["delta_ms"] = float(ms - t["truth_ms"])
                r["pass_strict"] = bool(abs(r["delta_ms"]) <= TOL_STRICT_MS)
                r["pass_harness"] = bool(abs(r["delta_ms"]) <= TOL_HARNESS_MS)
                r["madmom_ms"] = float(ms)
                r["madmom_runtime_s"] = float(secs)
            else:
                r["delta_ms"] = None
                r["pass_strict"] = False
                r["pass_harness"] = False
            all_results[group_name].append(r)
            print(f"    Δ={r['delta_ms']:.1f}ms" if r['delta_ms'] is not None else f"    ERROR: {err}", file=sys.stderr)

    out = Path(__file__).resolve().parent / "madmom_results.json"
    out.write_text(json.dumps(all_results, indent=2))
    print(f"\nResults written to {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
