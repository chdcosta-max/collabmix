#!/usr/bin/env python3
"""Extract waveform/cues/phrase data from one Rekordbox-analyzed track and
render a sample PNG so we can see what's actually there."""

import json
import sys
from pathlib import Path
from pyrekordbox.anlz import AnlzFile
from PIL import Image, ImageDraw
import numpy as np

OUT_DIR = Path(__file__).resolve().parent
SAMPLE = "/Users/chad/Library/Pioneer/rekordbox/share/PIONEER/USBANLZ/000/1deb6-618e-4735-ad63-3d6cb473bfa1/ANLZ0000"

dat = AnlzFile.parse_file(SAMPLE + ".DAT")
ext = AnlzFile.parse_file(SAMPLE + ".EXT")

print("=" * 60)
print("Sample track:", SAMPLE)
print()

# Track path
for t in dat.tags:
    if t.type == "PPTH":
        print("Path:", t.content.path)
        break

# BPM + beat grid (PQTZ in DAT, PQT2 in EXT)
for t in dat.tags:
    if t.type == "PQTZ":
        c = t.content
        print("PQTZ beat grid:")
        print("  beats:", c.entry_count if hasattr(c, "entry_count") else len(c.entries))
        if c.entries:
            print("  first 3 entries:", [{"beat": e.beat, "time": e.time} for e in list(c.entries)[:3]])
        break
for t in ext.tags:
    if t.type == "PQT2":
        c = t.content
        print("PQT2 extended beat grid:")
        print("  entry_count:", c.entry_count)
        print("  first bpm point: tempo=" + str(c.bpm[0].tempo / 100.0) + " BPM at beat " + str(c.bpm[0].beat) + " (time=" + str(c.bpm[0].time) + "ms)")
        print("  bpm change points:", len(c.bpm))
        break

# Phrase analysis (PSSI)
for t in ext.tags:
    if t.type == "PSSI":
        c = t.content
        print("PSSI phrase analysis:")
        print("  mood:", c.mood, "(1=low/high, 2=mid)")
        print("  end_beat:", c.end_beat)
        print("  bank:", c.bank)
        print("  num phrases:", c.len_entries)
        for e in list(c.entries)[:8]:
            print("   beat", e.beat, "kind", e.kind, "fill", e.fill, "beat_fill", e.beat_fill)
        break

# Cues
for t in dat.tags + ext.tags:
    if t.type in ("PCOB", "PCO2"):
        c = t.content
        cue_type_field = getattr(c, "cue_type", None) or getattr(c, "type", None)
        print("Tag", t.type, "type=" + str(cue_type_field), "count=" + str(c.count))

# Now the waveforms
print()
print("=== PWV4 (color preview, 6 bytes/entry) ===")
for t in ext.tags:
    if t.type == "PWV4":
        c = t.content
        result = t.get()
        print("  len_entries:", c.len_entries)
        print("  get() returned:", type(result))
        if isinstance(result, tuple):
            print("  shape:", [r.shape if hasattr(r, "shape") else len(r) for r in result])
            print("  first element first 3 values:", result[0][:3] if len(result) > 0 else "?")
        break

print()
print("=== PWV5 (color detail, 16-bit/entry) ===")
for t in ext.tags:
    if t.type == "PWV5":
        c = t.content
        result = t.get()
        print("  len_entries:", c.len_entries)
        print("  get() returned:", type(result))
        if isinstance(result, tuple):
            for i, r in enumerate(result):
                if hasattr(r, "shape"):
                    print("  result[" + str(i) + "] shape:", r.shape, "dtype:", r.dtype)
                    print("  result[" + str(i) + "] first 5:", r[:5])
                else:
                    print("  result[" + str(i) + "]:", type(r), "len=", len(r), "first 5:", r[:5] if hasattr(r, "__getitem__") else "?")
        break

# Render sample PNG of PWV5 mid-track 1000 pixels (skip silent intro)
print()
print("=== Rendering PWV5 sample PNG ===")
pwv5_tag = next(t for t in ext.tags if t.type == "PWV5")
heights, colors = pwv5_tag.get()
print("  total entries:", len(heights))
print("  heights[0] dtype:", heights.dtype, "(0.0-1.0 normalized)")
print("  colors[0]:", colors[0], "(R 0-14, G 0-7, B 0-7)")

# Pick mid-track window
start = len(heights) // 3  # one-third in
SAMPLE_LEN = 1000
end = min(start + SAMPLE_LEN, len(heights))

WIDTH = end - start
HEIGHT = 200

img = Image.new("RGB", (WIDTH, HEIGHT), "black")
px = img.load()
for x in range(WIDTH):
    h = float(heights[start + x])  # 0.0-1.0
    if h <= 0:
        continue
    bar_h = int(h * (HEIGHT / 2 - 4))
    rgb = colors[start + x]
    # Scale red from 0-14, green/blue from 0-7, all to 0-255
    r = min(255, int(rgb[0] * 255 / 14))
    g = min(255, int(rgb[1] * 255 / 7))
    b = min(255, int(rgb[2] * 255 / 7))
    cy = HEIGHT // 2
    for y in range(max(0, cy - bar_h), min(HEIGHT, cy + bar_h + 1)):
        px[x, y] = (r, g, b)

img.save(OUT_DIR / "sample_waveform.png")
print("  PNG saved:", OUT_DIR / "sample_waveform.png")
print("  Sampling window: entries " + str(start) + " to " + str(end) + " of " + str(len(heights)))

# Also render a "full track overview" using PWV4 (1200-entry color preview)
pwv4_tag = next(t for t in ext.tags if t.type == "PWV4")
pwv4_heights, pwv4_color, pwv4_blues = pwv4_tag.get()
print()
print("PWV4 overview shapes:", pwv4_heights.shape, pwv4_color.shape, pwv4_blues.shape)

OV_W = 1200
OV_H = 120
ov = Image.new("RGB", (OV_W, OV_H), "black")
ovpx = ov.load()
for x in range(OV_W):
    fh, bh = pwv4_heights[x]
    # back waveform (taller)
    bh_px = int(min(bh, 127) / 127 * (OV_H / 2 - 2))
    fh_px = int(min(fh, 127) / 127 * (OV_H / 2 - 2))
    bcol = pwv4_color[x][0]  # back color
    fcol = pwv4_color[x][1]  # front color
    cy = OV_H // 2
    # back (darker)
    for y in range(max(0, cy - bh_px), min(OV_H, cy + bh_px + 1)):
        ovpx[x, y] = (min(255, int(bcol[0])), min(255, int(bcol[1])), min(255, int(bcol[2])))
    # front (brighter, narrower)
    for y in range(max(0, cy - fh_px), min(OV_H, cy + fh_px + 1)):
        ovpx[x, y] = (min(255, int(fcol[0])), min(255, int(fcol[1])), min(255, int(fcol[2])))

ov.save(OUT_DIR / "sample_overview.png")
print("  Overview PNG saved:", OUT_DIR / "sample_overview.png")

# JSON sample (first 1000 PWV5)
sample = []
for i in range(min(1000, len(heights))):
    sample.append({"i": i, "height": float(heights[i]), "r": int(colors[i][0]), "g": int(colors[i][1]), "b": int(colors[i][2])})

# Sample summary stats
all_heights = heights.tolist()
all_R = [int(c[0]) for c in colors]
print()
print("=== Stats across full waveform ===")
print("  height min/max/mean:", round(min(all_heights), 3), "/", round(max(all_heights), 3), "/", round(sum(all_heights)/len(all_heights), 3))
print("  R range:", min(all_R), "to", max(all_R))

(OUT_DIR / "sample_waveform.json").write_text(json.dumps({
    "track_path": next(t.content.path for t in dat.tags if t.type == "PPTH"),
    "anlz_path": SAMPLE,
    "pwv5_total_entries": len(heights),
    "sample_first_1000": sample,
    "encoding": "PWV5 16-bit RGB565-like: 3R + 3G + 3B + 5 height + 2 zero",
    "height_range": "0-31 (5 bits)",
    "rgb_range": "0-7 each band (3 bits)",
}, indent=2))
print("  JSON saved:", OUT_DIR / "sample_waveform.json")
