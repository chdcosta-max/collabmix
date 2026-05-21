// Simulate: if we subtract 26ms (1152 samples / 44.1kHz) from our analyzer output
// for ALL Case 2 (Xing/Info, no LAME) MP3 tracks, what would PASS rate become?
//
// Hypothesis: Rekordbox skips one MPEG frame for Case 2 tracks. Our test harness
// (mpg123) doesn't, so our analyzer output is 26ms ahead of Rekordbox truth.
// Subtracting 26ms aligns our frame with Rekordbox's frame.

import { readFileSync } from "node:fs";

const baseline = JSON.parse(readFileSync("snapshots/baseline-full-walkback.json", "utf8"));

const BITRATES_MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1];
const SAMPLE_RATES_MPEG1 = [44100, 48000, 32000, -1];

function parseFrameHeader(b, off) {
  if (b[off] !== 0xff || (b[off + 1] & 0xe0) !== 0xe0) return null;
  const versionId = (b[off + 1] >> 3) & 0x3;
  const layer = (b[off + 1] >> 1) & 0x3;
  const bitrateIdx = (b[off + 2] >> 4) & 0xf;
  const srIdx = (b[off + 2] >> 2) & 0x3;
  const padding = (b[off + 2] >> 1) & 0x1;
  const channelMode = (b[off + 3] >> 6) & 0x3;
  if (versionId !== 3 || layer !== 1) return null;
  const bitrate = BITRATES_MPEG1_L3[bitrateIdx];
  const sr = SAMPLE_RATES_MPEG1[srIdx];
  if (bitrate <= 0 || sr <= 0) return null;
  const sideInfoLen = channelMode === 3 ? 17 : 32;
  return { sr, sideInfoLen };
}

function skipID3v2(b) {
  if (b.length < 10) return 0;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
    const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
    return 10 + size;
  }
  return 0;
}

function detectCase(path) {
  if (!path.toLowerCase().endsWith(".mp3")) return null;
  let buf;
  try { buf = readFileSync(path); } catch { return null; }
  const total = buf.length;
  let off = skipID3v2(buf);
  let header = null;
  for (let p = off; p < Math.min(off + 65536, total - 4); p++) {
    const h = parseFrameHeader(buf, p);
    if (h) { off = p; header = h; break; }
  }
  if (!header) return "no-frame";
  const tagOff = off + 4 + header.sideInfoLen;
  if (tagOff + 4 > total) return "case1";
  const tagMagic = buf.slice(tagOff, tagOff + 4).toString("ascii");
  if (tagMagic !== "Xing" && tagMagic !== "Info") return "case1";
  const flags = buf.readUInt32BE(tagOff + 4);
  let p = tagOff + 8;
  if (flags & 0x1) p += 4;
  if (flags & 0x2) p += 4;
  if (flags & 0x4) p += 100;
  if (flags & 0x8) p += 4;
  if (p + 4 > total) return "case2";
  return buf.slice(p, p + 4).toString("ascii") === "LAME" ? "case4-or-3" : "case2";
}

// Per-track classify
const cases = new Map();
for (const r of baseline.results) {
  cases.set(r.basename, detectCase(r.path));
}

// Simulate various shift candidates and find the one that maximizes PASS rate.
// Shift is in milliseconds, applied to analyzer (analyzer - shift compared to truth).
function passRate(shiftMs, applyToCase) {
  let pass = 0, fail = 0;
  for (const r of baseline.results) {
    if (r.status === "DECODE_FAIL" || r.status === "WORKER_FAIL") continue;
    const trackCase = cases.get(r.basename);
    const useShift = applyToCase ? (trackCase === applyToCase) : true;
    const shifted = (r.analyzerFirstDownbeatSec || 0) - (useShift ? shiftMs / 1000 : 0);
    const newDelta = Math.abs(shifted - (r.truthFirstDownbeatSec || 0)) * 1000;
    const bpmOk = (r.deltaBpm || 0) <= 0.5;
    if (newDelta <= 20 && bpmOk) pass++; else fail++;
  }
  return { pass, fail, accuracy: pass / (pass + fail) * 100 };
}

console.log("─── No shift (baseline) ───");
const baselineRate = passRate(0, null);
console.log(`  PASS ${baselineRate.pass}/${baselineRate.pass + baselineRate.fail}  (${baselineRate.accuracy.toFixed(1)}%)`);

console.log("\n─── Sweep: shift ALL tracks by +S ms ───");
for (const s of [0, 5, 10, 13, 15, 20, 22, 25, 26, 27, 28, 30, 35, 40]) {
  const r = passRate(s, null);
  console.log(`  +${s.toString().padStart(2)}ms → PASS ${r.pass}/${r.pass + r.fail} (${r.accuracy.toFixed(1)}%)`);
}

console.log("\n─── Sweep: shift Case 2 ONLY by +S ms ───");
for (const s of [0, 13, 20, 25, 26, 27, 30]) {
  const r = passRate(s, "case2");
  console.log(`  +${s.toString().padStart(2)}ms (case2) → PASS ${r.pass}/${r.pass + r.fail} (${r.accuracy.toFixed(1)}%)`);
}

// Per-case breakdown
console.log("\n─── Per-case breakdown ───");
const caseGroups = new Map();
for (const r of baseline.results) {
  const c = cases.get(r.basename) || "non-mp3";
  if (!caseGroups.has(c)) caseGroups.set(c, []);
  caseGroups.get(c).push(r);
}
for (const [k, arr] of caseGroups) {
  const pass = arr.filter(r => r.status === "PASS").length;
  const tot = arr.length;
  console.log(`  ${k}: ${pass}/${tot} (${(pass / tot * 100).toFixed(1)}%) PASS at baseline`);
}

// For Case 2, what shift gets best accuracy specifically WITHIN that group?
const case2 = caseGroups.get("case2") || [];
console.log(`\n─── Case 2 ONLY (${case2.length} tracks): sweep shift ───`);
for (const s of [-30, -27, -26, -20, 0, 13, 20, 25, 26, 27, 30, 40]) {
  let p = 0, f = 0;
  for (const r of case2) {
    if (r.status === "DECODE_FAIL" || r.status === "WORKER_FAIL") continue;
    const shifted = (r.analyzerFirstDownbeatSec || 0) - s / 1000;
    const newDelta = Math.abs(shifted - (r.truthFirstDownbeatSec || 0)) * 1000;
    const bpmOk = (r.deltaBpm || 0) <= 0.5;
    if (newDelta <= 20 && bpmOk) p++; else f++;
  }
  console.log(`  ${s >= 0 ? "+" : ""}${s.toString().padStart(3)}ms → PASS ${p}/${p + f} (${(p / (p + f) * 100).toFixed(1)}%)`);
}

// For Case 2, what's the histogram of (analyzer - truth) ms?
const case2Drifts = case2.filter(r => r.status !== "DECODE_FAIL")
  .map(r => ((r.analyzerFirstDownbeatSec || 0) - (r.truthFirstDownbeatSec || 0)) * 1000);
const histogram = new Map();
for (const d of case2Drifts) {
  const bucket = Math.round(d / 5) * 5;
  histogram.set(bucket, (histogram.get(bucket) || 0) + 1);
}
console.log(`\n─── Case 2 (analyzer - truth) ms histogram, 5ms buckets ───`);
for (const k of [...histogram.keys()].sort((a, b) => a - b)) {
  const v = histogram.get(k);
  const bar = "█".repeat(Math.min(60, v));
  console.log(`  ${k >= 0 ? "+" : ""}${k.toString().padStart(4)}: ${v.toString().padStart(3)} ${bar}`);
}
