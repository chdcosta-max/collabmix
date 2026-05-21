// Survey LAME-tag status across the whole library and correlate with PASS/FAIL.
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
  const frameLen = Math.floor((144 * bitrate * 1000) / sr) + padding;
  const sideInfoLen = channelMode === 3 ? 17 : 32;
  return { sr, channelMode, sideInfoLen, frameLen };
}

function skipID3v2(b) {
  if (b.length < 10) return 0;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
    const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
    return 10 + size;
  }
  return 0;
}

function crc16Genibus(buf, start, len) {
  let crc = 0x0000;
  for (let i = 0; i < len; i++) {
    crc ^= buf[start + i] << 8;
    for (let bit = 0; bit < 8; bit++) {
      if (crc & 0x8000) crc = (crc << 1) ^ 0x1021;
      else crc <<= 1;
      crc &= 0xffff;
    }
  }
  return crc;
}

function probeMp3(path) {
  let buf;
  try { buf = readFileSync(path); } catch (e) { return { error: "read failed" }; }
  const total = buf.length;
  let off = skipID3v2(buf);
  let header = null;
  for (let p = off; p < Math.min(off + 65536, total - 4); p++) {
    const h = parseFrameHeader(buf, p);
    if (h) { off = p; header = h; break; }
  }
  if (!header) return { case: 0, encoder: null, crcValid: null };

  const tagOff = off + 4 + header.sideInfoLen;
  if (tagOff + 4 > total) return { case: 0 };
  const tagMagic = buf.slice(tagOff, tagOff + 4).toString("ascii");
  if (tagMagic === "VBRI") return { case: 1, tag: "VBRI", encoder: null, crcValid: null };
  if (tagMagic !== "Xing" && tagMagic !== "Info") return { case: 1, tag: null, encoder: null, crcValid: null };

  const flags = buf.readUInt32BE(tagOff + 4);
  let p = tagOff + 8;
  if (flags & 0x1) p += 4;
  if (flags & 0x2) p += 4;
  if (flags & 0x4) p += 100;
  if (flags & 0x8) p += 4;
  if (p + 9 > total) return { case: 2, tag: tagMagic, encoder: null, crcValid: null };
  const lameMagic = buf.slice(p, p + 4).toString("ascii");
  const encoderStr = buf.slice(p, p + 9).toString("ascii");
  if (lameMagic !== "LAME") {
    return { case: 2, tag: tagMagic, encoder: encoderStr.replace(/[\x00-\x1f]/g, "").trim(), crcValid: null };
  }
  const crcOff = p + 34;
  if (crcOff + 2 > total) return { case: 3, tag: tagMagic, encoder: encoderStr, crcValid: false };
  const crcStored = (buf[crcOff] << 8) | buf[crcOff + 1];
  const crcComputed = crc16Genibus(buf, off, 190);
  const crcValid = crcStored === crcComputed;
  return { case: crcValid ? 4 : 3, tag: tagMagic, encoder: encoderStr, crcValid };
}

const results = [];
for (const t of baseline.results) {
  if (!t.path.toLowerCase().endsWith(".mp3")) continue;
  const probe = probeMp3(t.path);
  results.push({
    base: t.basename,
    status: t.status,
    offsetBeats: t.offsetBeats,
    deltaDownbeatMs: t.deltaDownbeatMs,
    truth: t.truthFirstDownbeatSec,
    analyzer: t.analyzerFirstDownbeatSec,
    case: probe.case,
    encoder: probe.encoder,
    crcValid: probe.crcValid,
  });
}

// Aggregate by case
const cases = { 0: { name: "no MPEG L3 frame", tracks: [] },
  1: { name: "no Xing/Info tag", tracks: [] },
  2: { name: "Xing/Info, no LAME (REKORDBOX shifts +1152)", tracks: [] },
  3: { name: "LAME tag, BAD CRC (REKORDBOX shifts +1152)", tracks: [] },
  4: { name: "LAME tag, valid CRC (no shift)", tracks: [] },
};
for (const r of results) {
  if (cases[r.case]) cases[r.case].tracks.push(r);
}

console.log(`Total MP3 tracks surveyed: ${results.length}\n`);
console.log("Case-by-case breakdown:");
for (const [k, v] of Object.entries(cases)) {
  const pass = v.tracks.filter(t => t.status === "PASS").length;
  const fail = v.tracks.filter(t => t.status === "FAIL").length;
  const tot = v.tracks.length;
  const accuracy = tot > 0 ? ((pass / tot) * 100).toFixed(1) : "—";
  console.log(`\n  Case ${k}: ${v.name}`);
  console.log(`    Count: ${tot}  PASS: ${pass}  FAIL: ${fail}  Accuracy: ${accuracy}%`);
  if (v.tracks.length > 0) {
    // top encoders
    const encoderHist = new Map();
    for (const t of v.tracks) {
      const e = t.encoder || "(none)";
      encoderHist.set(e, (encoderHist.get(e) || 0) + 1);
    }
    const top = [...encoderHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log(`    Top encoders: ${top.map(([e, n]) => `${e} (${n})`).join(", ")}`);
  }
}

// Within FAILs, what's the case distribution?
const fails = results.filter(r => r.status === "FAIL" && r.offsetBeats === 0);
console.log(`\n\nClass 1+ FAILs (on-grid, offsetBeats=0): ${fails.length}`);
const failCaseHist = new Map();
for (const r of fails) failCaseHist.set(r.case, (failCaseHist.get(r.case) || 0) + 1);
for (const [k, v] of [...failCaseHist.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  Case ${k}: ${v} tracks`);
}

// For Case 2 + Case 3 FAILs: what's the Δfd distribution?
const shiftFails = fails.filter(r => r.case === 2 || r.case === 3);
const shiftPasses = results.filter(r => r.status === "PASS" && (r.case === 2 || r.case === 3));
console.log(`\nCase 2+3 (Rekordbox should shift +1152 = +26ms): ${shiftFails.length + shiftPasses.length} tracks total`);
console.log(`  PASS: ${shiftPasses.length}  FAIL: ${shiftFails.length}`);
const shiftFailMs = shiftFails.map(r => (r.analyzer - r.truth) * 1000).sort((a, b) => a - b);
if (shiftFailMs.length > 0) {
  console.log(`  signed Δ ms (sorted): ${shiftFailMs.map(x => x.toFixed(1)).join(", ")}`);
  const median = shiftFailMs[Math.floor(shiftFailMs.length / 2)];
  const mean = shiftFailMs.reduce((s, x) => s + x, 0) / shiftFailMs.length;
  console.log(`  median: ${median.toFixed(2)}ms  mean: ${mean.toFixed(2)}ms`);
}

// What about Case 4 (LAME valid - no Rekordbox shift expected)?
const case4Fails = fails.filter(r => r.case === 4);
const case4Pass = results.filter(r => r.status === "PASS" && r.case === 4);
console.log(`\nCase 4 (LAME valid, no Rekordbox shift): ${case4Fails.length + case4Pass.length} tracks`);
console.log(`  PASS: ${case4Pass.length}  FAIL: ${case4Fails.length}`);
const case4FailMs = case4Fails.map(r => (r.analyzer - r.truth) * 1000).sort((a, b) => a - b);
if (case4FailMs.length > 0) {
  console.log(`  signed Δ ms (sorted): ${case4FailMs.map(x => x.toFixed(1)).join(", ")}`);
}
