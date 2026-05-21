// anchor_hypothesis_test.js — tests the hypothesis that Rekordbox uses
//   anchor = first_kick - N × beat_period   (N largest keeping anchor ≥ 0)
//
// Two first-kick detector variants are tested per the task spec:
//   A) diff-argmax (mimics analyzer's beat-0 refinement: argmax of HW-rectified
//      first derivative of 1.5ms-smoothed 40-200Hz power envelope)
//   B) raw power peak above per-track threshold (first "loud" 40-100Hz peak)
//
// Pure investigation — no production code touched. Uses audio-decode from
// the existing harness node_modules; reads period from snapshots/fix-D.json.
//
// Usage:
//   node tools/sota-eval/anchor_hypothesis_test.js
//
// Output: tools/sota-eval/ANCHOR_HYPOTHESIS_RESULT.md + raw JSON

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = resolve(__dirname, "..", "bpm-test-harness");

// audio-decode lives in the harness node_modules
const decodeAudioMod = await import(resolve(HARNESS_DIR, "node_modules", "audio-decode", "audio-decode.js"));
const decodeAudio = decodeAudioMod.default;

const MANIFEST = JSON.parse(readFileSync(resolve(HARNESS_DIR, "library-truth.json"), "utf8"));
const SNAPSHOT = JSON.parse(readFileSync(resolve(HARNESS_DIR, "snapshots", "fix-D.json"), "utf8"));
const snapByPath = new Map(SNAPSHOT.results.map(r => [r.path, r]));

const TOL_MS = 10; // strict tolerance per task spec
const HARNESS_TOL_MS = 20;

// ── Group A: 13 known Sub-cause B failures (matched by basename substring) ──
const GROUP_A_SUBS = [
  "Body Stars", "Scarlet Sails", "Aurora", "Coaster",
  "Leave the World", "Serenità", "Fly Fox", "Great Attractor",
  "Astronauts", "Finding Estrella", "Swans", "Sparky", "Track II",
];

// ── Group B: same 15 random PASS tracks the madmom test used (seed=42) ──
// Reconstruct by reading madmom_results.json
let GROUP_B_PATHS = [];
try {
  const m = JSON.parse(readFileSync(resolve(__dirname, "madmom_results.json"), "utf8"));
  GROUP_B_PATHS = m.group_b.map(t => t.path);
} catch (e) {
  console.error("Could not load madmom_results.json; falling back to fresh random selection");
  const passes = SNAPSHOT.results.filter(r => r.status === "PASS").map(r => r.path);
  // Deterministic seeded shuffle
  let seed = 42;
  const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  passes.sort(() => rand() - 0.5);
  GROUP_B_PATHS = passes.slice(0, 15);
}

function pickGroupA() {
  const out = [];
  for (const sub of GROUP_A_SUBS) {
    const t = MANIFEST.tracks.find(t => t.basename.toLowerCase().includes(sub.toLowerCase()));
    if (t) out.push(t);
  }
  return out;
}
function pickGroupB() {
  const out = [];
  for (const p of GROUP_B_PATHS) {
    const t = MANIFEST.tracks.find(t => t.path === p);
    if (t) out.push(t);
  }
  return out;
}

// ── DSP primitives (matched to analyzer style) ──
function toMono(channels) {
  const len = channels[0].length;
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(len);
  const n = channels.length;
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let c = 0; c < n; c++) s += channels[c][i];
    out[i] = s / n;
  }
  return out;
}

function bandpass(sig, sr, low, high) {
  const out = new Float32Array(sig.length);
  const rL = 1 / (2 * Math.PI * high / sr + 1);
  const rH = 1 / (2 * Math.PI * low / sr + 1);
  const hp = new Float32Array(sig.length);
  let pi = 0, po = 0;
  for (let i = 0; i < sig.length; i++) {
    hp[i] = rH * (po + sig[i] - pi);
    pi = sig[i];
    po = hp[i];
  }
  let pv = 0;
  for (let i = 0; i < hp.length; i++) {
    pv = pv + (1 - rL) * (hp[i] - pv);
    out[i] = pv;
  }
  return out;
}

// ── Variant A: analyzer-style first_kick (diff-argmax on 1.5ms-smoothed power) ──
// Scans the first SEARCH_SEC of audio, finds the argmax of HW-rectified
// first derivative of the smoothed 40-200Hz power envelope.
function firstKickDiffArgmax(mono, sr, searchSec = 1.0) {
  const N = Math.min(mono.length, Math.round(sr * searchSec));
  const sig = mono.subarray(0, N);
  const filtered = bandpass(sig, sr, 40, 200);
  const power = new Float32Array(N);
  for (let i = 0; i < N; i++) { const v = filtered[i]; power[i] = v * v; }

  // Smoothed power (1.5ms running average), matches analyzer
  const smoothWin = Math.max(8, Math.round(sr * 0.0015));
  const smoothed = new Float32Array(N);
  let acc = 0;
  for (let i = 0; i < N; i++) {
    acc += power[i];
    if (i >= smoothWin) acc -= power[i - smoothWin];
    smoothed[i] = acc / Math.min(i + 1, smoothWin);
  }
  // HW-rectified diff, argmax
  let bestI = 1, bestVal = 0;
  for (let i = 1; i < N; i++) {
    const d = smoothed[i] - smoothed[i - 1];
    if (d > bestVal) { bestVal = d; bestI = i; }
  }
  return bestI / sr; // seconds
}

// ── Variant B: first loud kick — raw 40-100Hz power peak above per-track threshold ──
// Find peaks in 40-100Hz raw power envelope. A peak is "loud" if amplitude
// ≥ FRAC × the global track-wide peak. The FIRST loud peak is the first kick.
function firstLoudKick(mono, sr, opts = {}) {
  const FRAC = opts.frac ?? 0.30;
  const SCAN_SEC = opts.scanSec ?? 8.0; // scan first 8 seconds — plenty for a kick
  const N = Math.min(mono.length, Math.round(sr * SCAN_SEC));
  const sig = mono.subarray(0, N);
  const filtered = bandpass(sig, sr, 40, 100);
  // Raw power at small hops (1ms) for precise peak location
  const HOP_SEC = 0.001;
  const hop = Math.max(1, Math.round(sr * HOP_SEC));
  const nf = Math.floor(N / hop);
  const fE = new Float32Array(nf);
  for (let i = 0; i < nf; i++) {
    const st = i * hop;
    let s = 0;
    const end = Math.min(filtered.length, st + hop);
    for (let j = st; j < end; j++) { const v = filtered[j]; s += v * v; }
    fE[i] = s / hop;
  }
  // Find ALL local peaks in fE (exclusion ±50ms ~ kick width)
  const peakExclWin = Math.max(2, Math.round(0.05 / HOP_SEC));
  const peaks = [];
  for (let i = peakExclWin; i < nf - peakExclWin; i++) {
    let isPeak = true;
    for (let k = 1; k <= peakExclWin; k++) {
      if (fE[i] < fE[i - k] || fE[i] < fE[i + k]) { isPeak = false; break; }
    }
    if (isPeak && fE[i] > 0) peaks.push({ frame: i, amp: fE[i] });
  }
  if (peaks.length === 0) return null;

  // Threshold: FRAC × global max peak amplitude (scan first SCAN_SEC)
  const maxAmp = Math.max(...peaks.map(p => p.amp));
  const thresh = maxAmp * FRAC;
  const loudPeaks = peaks.filter(p => p.amp >= thresh);
  if (loudPeaks.length === 0) return null;
  return loudPeaks[0].frame * HOP_SEC;
}

// ── Anchor formula: first_kick - N × period, N largest keeping result ≥ 0 ──
function applyAnchor(firstKickSec, periodSec) {
  if (firstKickSec == null || !(periodSec > 0)) return { N: null, anchor: null };
  let N = 0;
  let a = firstKickSec;
  while (a - periodSec >= 0) { a -= periodSec; N++; }
  return { N, anchor: a };
}

// ── Main driver ──
async function processTrack(track) {
  const snap = snapByPath.get(track.path);
  const periodSec = snap?.beatPeriodSec || 0;
  const periodMs = periodSec * 1000;

  let buf;
  try {
    buf = await decodeAudio(readFileSync(track.path));
  } catch (e) {
    return { basename: track.basename, error: "decode: " + e.message };
  }
  const sr = buf.sampleRate;
  const mono = toMono(buf.channelData);

  // Variant A: diff-argmax in first second
  const fkA = firstKickDiffArgmax(mono, sr, 1.0);
  const { N: NA, anchor: anchorA } = applyAnchor(fkA, periodSec);
  // Variant B: first loud kick (raw power peak above threshold) in first 8 sec
  const fkB = firstLoudKick(mono, sr, { frac: 0.30, scanSec: 8.0 });
  const { N: NB, anchor: anchorB } = applyAnchor(fkB, periodSec);
  // Variant B' (stricter): 50% threshold
  const fkBs = firstLoudKick(mono, sr, { frac: 0.50, scanSec: 8.0 });
  const { N: NBs, anchor: anchorBs } = applyAnchor(fkBs, periodSec);

  const truthMs = track.firstDownbeatSec * 1000;
  return {
    basename: track.basename,
    path: track.path,
    truthMs,
    periodMs,
    bpm: snap?.analyzerBpm,
    analyzerBar1Ms: (snap?.analyzerFirstDownbeatSec ?? 0) * 1000,
    analyzerStatus: snap?.status,
    A: { fk: fkA * 1000, N: NA, anchorMs: anchorA * 1000 },
    B30: { fk: fkB == null ? null : fkB * 1000, N: NB, anchorMs: anchorB == null ? null : anchorB * 1000 },
    B50: { fk: fkBs == null ? null : fkBs * 1000, N: NBs, anchorMs: anchorBs == null ? null : anchorBs * 1000 },
  };
}

const groupATracks = pickGroupA();
const groupBTracks = pickGroupB();
console.error(`Group A: ${groupATracks.length} tracks; Group B: ${groupBTracks.length} tracks`);

const results = { groupA: [], groupB: [] };
for (const [label, tracks, store] of [["A", groupATracks, results.groupA], ["B", groupBTracks, results.groupB]]) {
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    process.stderr.write(`\r  [${label}] ${i + 1}/${tracks.length}  ${t.basename.slice(0, 40)}                                  `);
    const r = await processTrack(t);
    store.push(r);
  }
  process.stderr.write("\n");
}

writeFileSync(resolve(__dirname, "anchor_results.json"), JSON.stringify(results, null, 2));

// ── Build report ──
function fmt(n, w = 7) { return (n == null ? "  -" : (typeof n === "number" ? n.toFixed(1) : String(n))).padStart(w); }
function deltaSign(d) { if (d == null) return "  -"; const s = d >= 0 ? "+" : ""; return s + d.toFixed(1); }
function passMark(d, tol) { if (d == null) return "."; return Math.abs(d) <= tol ? "✓" : "."; }

function buildTable(group, label) {
  const rows = [];
  rows.push("");
  rows.push("### " + label);
  rows.push("");
  rows.push("Track                                       | truth |  period |  bpm   | analyzer | Variant A: diff-argmax       | Variant B: 1st-loud-kick (frac=0.30)  | Variant B': frac=0.50           ");
  rows.push("                                            |  ms   |   ms    |        |  bar1 ms |  fk_ms  N   anchor   Δ   p10 |  fk_ms  N    anchor    Δ    p10/p20  |  fk_ms  N    anchor    Δ    p10/p20");
  rows.push("--------------------------------------------|-------|---------|--------|----------|------------------------------|---------------------------------------|------------------------------------");
  for (const r of group) {
    if (r.error) { rows.push(r.basename.padEnd(43).slice(0, 43) + " ERROR: " + r.error); continue; }
    const dA = r.A.anchorMs == null ? null : r.A.anchorMs - r.truthMs;
    const dB30 = r.B30.anchorMs == null ? null : r.B30.anchorMs - r.truthMs;
    const dB50 = r.B50.anchorMs == null ? null : r.B50.anchorMs - r.truthMs;
    rows.push(
      r.basename.padEnd(43).slice(0, 43) + " |" +
      fmt(r.truthMs, 6) + " |" +
      fmt(r.periodMs, 8) + " |" +
      fmt(r.bpm, 6) + "  |" +
      fmt(r.analyzerBar1Ms, 9) + " |" +
      fmt(r.A.fk, 7) + " " + fmt(r.A.N, 3) + fmt(r.A.anchorMs, 8) + " " + deltaSign(dA).padStart(6) + "  " + passMark(dA, TOL_MS) + "    |" +
      fmt(r.B30.fk, 7) + " " + fmt(r.B30.N, 3) + fmt(r.B30.anchorMs, 8) + " " + deltaSign(dB30).padStart(6) + "  " + passMark(dB30, TOL_MS) + "/" + passMark(dB30, HARNESS_TOL_MS) + "   |" +
      fmt(r.B50.fk, 7) + " " + fmt(r.B50.N, 3) + fmt(r.B50.anchorMs, 8) + " " + deltaSign(dB50).padStart(6) + "  " + passMark(dB50, TOL_MS) + "/" + passMark(dB50, HARNESS_TOL_MS)
    );
  }
  // Summary
  const tally = (key, tol) => group.filter(r => {
    if (!r[key] || r[key].anchorMs == null) return false;
    return Math.abs(r[key].anchorMs - r.truthMs) <= tol;
  }).length;
  rows.push("");
  rows.push("Pass counts (strict ≤10ms / harness ≤20ms):");
  rows.push(`  Variant A:  ${tally("A", TOL_MS)} / ${tally("A", HARNESS_TOL_MS)}  out of ${group.length}`);
  rows.push(`  Variant B (30%):  ${tally("B30", TOL_MS)} / ${tally("B30", HARNESS_TOL_MS)}  out of ${group.length}`);
  rows.push(`  Variant B' (50%): ${tally("B50", TOL_MS)} / ${tally("B50", HARNESS_TOL_MS)}  out of ${group.length}`);
  return rows.join("\n");
}

const report = [
  "# Anchor Hypothesis Test — Results",
  "",
  "Hypothesis: `anchor = first_kick - N × beat_period` where N is the largest",
  "integer keeping anchor ≥ 0.",
  "",
  "The analyzer's existing walk-back code (`bpm-worker-source.js:1041-1043`)",
  "already applies this exact formula. The real question is whether a DIFFERENT",
  "first_kick detector — fed into the same formula — produces results closer",
  "to Rekordbox truth than the analyzer's current diff-argmax detector does.",
  "",
  "Two first-kick detector variants, plus a third with a stricter threshold:",
  "  A: diff-argmax of 1.5ms-smoothed 40-200Hz power envelope (matches analyzer)",
  "  B: first 40-100Hz power-peak ≥ 30% of track-wide max peak amplitude",
  "  B': first 40-100Hz power-peak ≥ 50% of track-wide max peak amplitude",
  "",
  "Truth: Rekordbox `firstDownbeatSec` from `library-truth.json`.",
  "Period: analyzer-detected `beatPeriodSec` from `snapshots/fix-D.json`.",
  "Anchor = first_kick - N × period (largest N keeping ≥ 0).",
  "Δ = anchor - truth, in ms. Pass: |Δ| ≤ 10 ms (strict, per task) or ≤ 20 ms (harness).",
  buildTable(results.groupA, "Group A — 13 Sub-cause B failures"),
  buildTable(results.groupB, "Group B — 15 PASS regression check"),
  "",
];

writeFileSync(resolve(__dirname, "ANCHOR_HYPOTHESIS_RESULT.md"), report.join("\n"));
console.error("\nResults written to anchor_results.json and ANCHOR_HYPOTHESIS_RESULT.md");
