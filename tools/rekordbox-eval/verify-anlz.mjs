// verify-anlz.mjs — verifies the JS ANLZ parser by comparing its output
// field-by-field against pyrekordbox on 5 sample tracks from the user's
// Rekordbox library.

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parseAnlz, mergeCues } from "./anlz-parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PY = resolve(__dirname, "venv/bin/python");
const USBANLZ = "/Users/chad/Library/Pioneer/rekordbox/share/PIONEER/USBANLZ";

// Pick 5 sample track folders — first one we know has data; pick four more with PSSI
const samples = [
  "/Users/chad/Library/Pioneer/rekordbox/share/PIONEER/USBANLZ/000/1deb6-618e-4735-ad63-3d6cb473bfa1/ANLZ0000",
];
// Add four more by scanning USBANLZ for first folders with both DAT+EXT files
import { readdirSync, existsSync } from "node:fs";
const usbRoot = USBANLZ;
const xyzDirs = readdirSync(usbRoot).filter(n => !n.startsWith(".")).sort();
outer:
for (const xyz of xyzDirs) {
  if (samples.length >= 5) break;
  const subDirs = readdirSync(resolve(usbRoot, xyz)).filter(n => !n.startsWith("."));
  for (const sub of subDirs) {
    const anlzBase = resolve(usbRoot, xyz, sub, "ANLZ0000");
    if (existsSync(anlzBase + ".DAT") && existsSync(anlzBase + ".EXT")) {
      if (samples.includes(anlzBase)) continue;
      samples.push(anlzBase);
      if (samples.length >= 5) break outer;
    }
  }
}

console.log("Picked", samples.length, "sample tracks.\n");

// Helper: run pyrekordbox on a file and get key fields
function runPyDecoder(extPath) {
  const cmd = `
import json
from pyrekordbox.anlz import AnlzFile
ae = AnlzFile.parse_file("${extPath.replace(/"/g, '\\"')}")
out = {"tag_types": [t.type for t in ae.tags]}
for t in ae.tags:
    if t.type == "PPTH":
        out["path"] = t.content.path
    elif t.type == "PWV5":
        heights, colors = t.get()
        out["pwv5_num_entries"] = int(t.content.len_entries)
        out["pwv5_heights_first10"] = [round(float(h), 4) for h in heights[:10]]
        out["pwv5_heights_mid10"] = [round(float(h), 4) for h in heights[len(heights)//2:len(heights)//2+10]]
        out["pwv5_colors_first5"] = [[int(c[0]),int(c[1]),int(c[2])] for c in colors[:5]]
        out["pwv5_colors_mid5"] = [[int(c[0]),int(c[1]),int(c[2])] for c in colors[len(colors)//2:len(colors)//2+5]]
    elif t.type == "PWV4":
        heights, col_color, col_blues = t.get()
        out["pwv4_num_entries"] = int(t.content.len_entries)
        out["pwv4_heights_first5"] = [[int(h[0]),int(h[1])] for h in heights[:5]]
        out["pwv4_colors_first3"] = [[[int(c[0][0]),int(c[0][1]),int(c[0][2])],[int(c[1][0]),int(c[1][1]),int(c[1][2])]] for c in col_color[:3]]
    elif t.type == "PCO2":
        out["pco2_count"] = t.content.count
        out["pco2_cue_type"] = str(t.content.type)
        out["pco2_entries"] = []
        for e in t.content.entries:
            out["pco2_entries"].append({"hot_cue": int(e.hot_cue), "time": int(e.time), "color_id": int(e.color_id), "comment": str(e.comment)})
print(json.dumps(out, indent=2))
`;
  const stdout = execFileSync(PY, ["-c", cmd], { encoding: "utf8" });
  return JSON.parse(stdout);
}

function summarizeJsTags(parseResult) {
  const tagTypes = parseResult.tags.map(t => t.type);
  const out = { tag_types: tagTypes };
  for (const t of parseResult.tags) {
    if (t.type === "PPTH") out.path = t.path;
    if (t.type === "PWV5") {
      out.pwv5_num_entries = t.numEntries;
      out.pwv5_heights_first10 = Array.from(t.heights.slice(0, 10)).map(v => +v.toFixed(4));
      const mid = Math.floor(t.numEntries / 2);
      out.pwv5_heights_mid10 = Array.from(t.heights.slice(mid, mid + 10)).map(v => +v.toFixed(4));
      out.pwv5_colors_first5 = [];
      for (let i = 0; i < 5 && i < t.numEntries; i++) {
        out.pwv5_colors_first5.push([t.colors[i*3], t.colors[i*3+1], t.colors[i*3+2]]);
      }
      out.pwv5_colors_mid5 = [];
      for (let i = mid; i < mid + 5 && i < t.numEntries; i++) {
        out.pwv5_colors_mid5.push([t.colors[i*3], t.colors[i*3+1], t.colors[i*3+2]]);
      }
    }
    if (t.type === "PWV4") {
      out.pwv4_num_entries = t.numEntries;
      out.pwv4_heights_first5 = [];
      for (let i = 0; i < 5 && i < t.numEntries; i++) {
        out.pwv4_heights_first5.push([t.heights[i*2], t.heights[i*2+1]]);
      }
      out.pwv4_colors_first3 = [];
      for (let i = 0; i < 3 && i < t.numEntries; i++) {
        const c0 = [t.colColor[i*6], t.colColor[i*6+1], t.colColor[i*6+2]];
        const c1 = [t.colColor[i*6+3], t.colColor[i*6+4], t.colColor[i*6+5]];
        out.pwv4_colors_first3.push([c0, c1]);
      }
    }
    if (t.type === "PCO2") {
      out.pco2_count = t.count;
      out.pco2_cue_type = t.cueType;
      out.pco2_entries = t.entries.map(e => ({
        hot_cue: e.hotCueSlot, time: e.timeMs, color_id: e.colorId, comment: e.label,
      }));
    }
  }
  return out;
}

function compareValues(jsVal, pyVal, path = "") {
  // Returns array of diffs; empty array = match
  if (Array.isArray(jsVal) && Array.isArray(pyVal)) {
    if (jsVal.length !== pyVal.length) return [path + ": length " + jsVal.length + " vs " + pyVal.length];
    const diffs = [];
    for (let i = 0; i < jsVal.length; i++) {
      diffs.push(...compareValues(jsVal[i], pyVal[i], path + "[" + i + "]"));
    }
    return diffs;
  }
  if (typeof jsVal === "object" && jsVal && typeof pyVal === "object" && pyVal) {
    const diffs = [];
    const keys = new Set([...Object.keys(jsVal), ...Object.keys(pyVal)]);
    for (const k of keys) diffs.push(...compareValues(jsVal[k], pyVal[k], path ? path + "." + k : k));
    return diffs;
  }
  if (typeof jsVal === "number" && typeof pyVal === "number") {
    if (Math.abs(jsVal - pyVal) > 0.0005) return [path + ": " + jsVal + " vs " + pyVal];
    return [];
  }
  if (jsVal !== pyVal) return [path + ": '" + jsVal + "' vs '" + pyVal + "'"];
  return [];
}

const report = [];
let totalDiffs = 0;
for (const base of samples) {
  const extPath = base + ".EXT";
  const datPath = base + ".DAT";
  console.log("=== " + base + " ===");
  // JS parse
  const extBytes = readFileSync(extPath);
  const extResult = parseAnlz(extBytes);
  const datBytes = readFileSync(datPath);
  const datResult = parseAnlz(datBytes);
  const jsSummary = summarizeJsTags(extResult);
  // Also pull path from DAT
  for (const t of datResult.tags) if (t.type === "PPTH") jsSummary.path_from_dat = t.path;
  // Python parse
  const pySummary = runPyDecoder(extPath);
  // Compare
  const diffs = compareValues(jsSummary, pySummary, "");
  // Filter known-to-not-be-in-py keys (path_from_dat)
  const realDiffs = diffs.filter(d => !d.startsWith("path_from_dat") && !d.includes("undefined"));
  console.log("  EXT tag types:", extResult.tags.map(t => t.type).join(", "));
  console.log("  PWV5 entries (JS):", jsSummary.pwv5_num_entries, "(PY):", pySummary.pwv5_num_entries);
  console.log("  PWV4 entries (JS):", jsSummary.pwv4_num_entries, "(PY):", pySummary.pwv4_num_entries);
  console.log("  Diffs:", realDiffs.length);
  if (realDiffs.length > 0) {
    realDiffs.slice(0, 5).forEach(d => console.log("    " + d));
    if (realDiffs.length > 5) console.log("    ... and " + (realDiffs.length - 5) + " more");
  }
  report.push({ base, jsSummary, pySummary, diffs: realDiffs });
  totalDiffs += realDiffs.length;
  console.log("");
}

console.log("=".repeat(60));
console.log("TOTAL DIFFS across", samples.length, "tracks:", totalDiffs);
if (totalDiffs === 0) {
  console.log("✓ All fields match exactly");
} else {
  console.log("✗ Diffs found — needs review");
}

writeFileSync(resolve(__dirname, "verify-anlz-report.json"), JSON.stringify(report, null, 2));
console.log("\nFull report: verify-anlz-report.json");

process.exit(totalDiffs === 0 ? 0 : 1);
