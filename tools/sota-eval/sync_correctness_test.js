// sync_correctness_test.js — comprehensive sync-correctness diagnostic
// across 5 PASS-PASS pairs of similar-BPM prog house tracks.
//
// Three measurements per pair, computed under each of 5 shift scenarios:
//   1. PER-TRACK: (audible_first_kick - bar1) for each track
//   2. CROSS-TRACK XCORR: peak xcorr between grid-aligned audio
//   3. A↔B KICK OFFSET: difference in audible first-kick times after grid alignment
//
// Per the methodology discussion: #1 is the discriminating metric (varies
// with shifts). #2 and #3 are invariant under uniform grid shift on both
// tracks, but reported anyway for the record.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = resolve(__dirname, "..", "bpm-test-harness");
const HARNESS_NM = resolve(HARNESS_DIR, "node_modules");
const decodeAudioMod = await import(resolve(HARNESS_NM, "audio-decode", "audio-decode.js"));
const decodeAudio = decodeAudioMod.default;

const SNAPSHOT = JSON.parse(readFileSync(resolve(HARNESS_DIR, "snapshots", "fix-G.json"), "utf8"));

// ── 5 pairs of PASS tracks, all prog house family, 120-122 BPM ──
const PAIRS = [
  // Pair 1: gold standard — both very tight to truth
  ["01 Bridge (Original Mix).mp3", "02 Welcome to You (Original Mix).mp3"],
  // Pair 2: typical prog house — borderline-tolerant Δ
  ["01 Phase Sync (Original Mix).mp3", "01 Walk With Me (Original Mix).mp3"],
  // Pair 3: clean 122 BPM
  ["01 Paper Tiger (Extended Mix).mp3", "01 Atlas (Original Mix).mp3"],
  // Pair 4: Sub-cause G rescue + a partner
  ["04 Thunder (Original Mix).mp3", "03 Strange Way (Original Mix).mp3"],
  // Pair 5: another mixed 122 BPM
  ["02 Vivid Imagination (Tantum Remix).mp3", "02 Don't Stop (Guy J Remix).m4a"],
];

const SHIFTS_MS = [-10, 0, 10, 20, 30];

// ── DSP primitives ──
function toMono(ch) {
  if (ch.length === 1) return ch[0];
  const o = new Float32Array(ch[0].length);
  for (let i = 0; i < ch[0].length; i++) {
    let s = 0;
    for (let c = 0; c < ch.length; c++) s += ch[c][i];
    o[i] = s / ch.length;
  }
  return o;
}
function bandpass(sig, sr, low, high) {
  const out = new Float32Array(sig.length);
  const rL = 1 / (2 * Math.PI * high / sr + 1);
  const rH = 1 / (2 * Math.PI * low / sr + 1);
  const hp = new Float32Array(sig.length);
  let pi = 0, po = 0;
  for (let i = 0; i < sig.length; i++) { hp[i] = rH * (po + sig[i] - pi); pi = sig[i]; po = hp[i]; }
  let pv = 0;
  for (let i = 0; i < hp.length; i++) { pv = pv + (1 - rL) * (hp[i] - pv); out[i] = pv; }
  return out;
}

// Audible first kick: in 40-200Hz bandpass, find the position of MAX power
// (not slope) within ±50ms of bar1Sec. This measures "where the kick body
// peaks" — the perceptual reference point Rekordbox is hypothesized to use.
function audibleKickPosMs(mono, sr, bar1Sec) {
  const halfWinMs = 60;
  const winStart = Math.max(0, Math.round((bar1Sec - halfWinMs / 1000) * sr));
  const winEnd = Math.min(mono.length, Math.round((bar1Sec + halfWinMs / 1000) * sr));
  if (winEnd - winStart < 200) return null;
  const padS = Math.round(sr * 0.010);
  const padStart = Math.max(0, winStart - padS);
  const padEnd = Math.min(mono.length, winEnd + padS);
  const padded = mono.subarray(padStart, padEnd);
  const filtered = bandpass(padded, sr, 40, 200);
  const innerOff = winStart - padStart;
  const winLen = winEnd - winStart;
  // Smoothed power envelope (10ms) — perceptual "weight" of the kick
  const smoothWin = Math.max(8, Math.round(sr * 0.010));
  const power = new Float32Array(winLen);
  for (let i = 0; i < winLen; i++) {
    const v = filtered[innerOff + i];
    power[i] = v * v;
  }
  const smoothed = new Float32Array(winLen);
  let runSum = 0;
  for (let i = 0; i < winLen; i++) {
    runSum += power[i];
    if (i >= smoothWin) runSum -= power[i - smoothWin];
    smoothed[i] = runSum / Math.min(i + 1, smoothWin);
  }
  // Find peak of smoothed envelope = perceptual kick center
  let peakI = 0;
  for (let i = 1; i < winLen; i++) if (smoothed[i] > smoothed[peakI]) peakI = i;
  return (winStart + peakI) / sr * 1000;
}

// Cross-correlate two audio segments. Returns { peakLagMs, peakValue } where
// peakLagMs is the lag of B relative to A that maximizes correlation.
// Search range: ±50ms.
function crossCorrelate(audA, audB, sr, searchMs = 50) {
  // Bandpass both to 40-200Hz, downsample correlation to 1ms steps
  const fA = bandpass(audA, sr, 40, 200);
  const fB = bandpass(audB, sr, 40, 200);
  const N = Math.min(fA.length, fB.length);
  if (N < sr * 0.5) return null;
  const maxLag = Math.round(searchMs / 1000 * sr);
  let bestLag = 0, bestCorr = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let corr = 0;
    const startA = Math.max(0, lag);
    const startB = Math.max(0, -lag);
    const len = N - Math.max(startA, startB);
    for (let i = 0; i < len; i += Math.max(1, Math.round(sr * 0.001))) {
      corr += fA[startA + i] * fB[startB + i];
    }
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
  }
  return { peakLagMs: bestLag / sr * 1000, peakValue: bestCorr };
}

// ── Run the test ──
async function runPair(pairIdx, basenameA, basenameB) {
  const trackA = SNAPSHOT.results.find(r => r.basename === basenameA);
  const trackB = SNAPSHOT.results.find(r => r.basename === basenameB);
  if (!trackA || !trackB) throw new Error("Missing track: " + basenameA + " or " + basenameB);

  console.error("Pair " + pairIdx + ": " + basenameA.slice(0, 35) + " vs " + basenameB.slice(0, 35));
  console.error("  A: BPM=" + trackA.analyzerBpm + ", bar1=" + (trackA.analyzerFirstDownbeatSec * 1000).toFixed(2) + "ms, truth=" + (trackA.truthFirstDownbeatSec * 1000).toFixed(2) + "ms, Δ=" + trackA.deltaDownbeatMs.toFixed(2) + "ms");
  console.error("  B: BPM=" + trackB.analyzerBpm + ", bar1=" + (trackB.analyzerFirstDownbeatSec * 1000).toFixed(2) + "ms, truth=" + (trackB.truthFirstDownbeatSec * 1000).toFixed(2) + "ms, Δ=" + trackB.deltaDownbeatMs.toFixed(2) + "ms");

  // Decode both
  const bufA = await decodeAudio(readFileSync(trackA.path));
  const bufB = await decodeAudio(readFileSync(trackB.path));
  const srA = bufA.sampleRate, srB = bufB.sampleRate;
  const monoA = toMono(bufA.channelData);
  const monoB = toMono(bufB.channelData);
  if (srA !== srB) {
    console.error("  SR mismatch (" + srA + " vs " + srB + "), skipping pair");
    return null;
  }
  const sr = srA;

  // Per-track audible kick (no shift applied here — it's absolute)
  const audibleA = audibleKickPosMs(monoA, sr, trackA.analyzerFirstDownbeatSec);
  const audibleB = audibleKickPosMs(monoB, sr, trackB.analyzerFirstDownbeatSec);
  console.error("  Audible kick A: " + audibleA.toFixed(2) + "ms (bar1=" + (trackA.analyzerFirstDownbeatSec * 1000).toFixed(2) + ", diff=" + (audibleA - trackA.analyzerFirstDownbeatSec * 1000).toFixed(2) + "ms)");
  console.error("  Audible kick B: " + audibleB.toFixed(2) + "ms (bar1=" + (trackB.analyzerFirstDownbeatSec * 1000).toFixed(2) + ", diff=" + (audibleB - trackB.analyzerFirstDownbeatSec * 1000).toFixed(2) + "ms)");

  // For each shift scenario
  const scenarios = [];
  for (const shiftMs of SHIFTS_MS) {
    const bar1A_ms = trackA.analyzerFirstDownbeatSec * 1000 + shiftMs;
    const bar1B_ms = trackB.analyzerFirstDownbeatSec * 1000 + shiftMs;
    // 1. Per-track: audible_kick - bar1 (shifted)
    const offA = audibleA - bar1A_ms;
    const offB = audibleB - bar1B_ms;
    // 2. Cross-track xcorr: align B to A using shifted bar1, xcorr a 4-bar window
    const periodA = trackA.beatPeriodSec;
    const periodB = trackB.beatPeriodSec;
    // Reference bar: pick bar 8 of A (16 sec at 120 BPM) — ensures we're past intros
    const targetBarsA = 8;
    const refStartA = bar1A_ms / 1000 + targetBarsA * 4 * periodA;
    const refStartB = bar1B_ms / 1000 + targetBarsA * 4 * periodB; // same bar count for B
    const winSec = 4 * Math.max(periodA, periodB); // 4 bars worth
    const startSampleA = Math.round(refStartA * sr);
    const startSampleB = Math.round(refStartB * sr);
    const lenSamples = Math.round(winSec * sr);
    if (startSampleA + lenSamples > monoA.length || startSampleB + lenSamples > monoB.length || startSampleA < 0 || startSampleB < 0) {
      scenarios.push({ shiftMs, offA, offB, xcorr: null, abKickOffset: null });
      continue;
    }
    const audA = monoA.subarray(startSampleA, startSampleA + lenSamples);
    const audB = monoB.subarray(startSampleB, startSampleB + lenSamples);
    const xcorr = crossCorrelate(audA, audB, sr, 50);
    // 3. A↔B kick offset: audible_kick_A_after_align - audible_kick_B_after_align
    // After aligning B's bar1 to A's bar1, B's audio is shifted by (bar1A - bar1B).
    // So audible kick B (in shifted coords) = audibleB + (bar1A - bar1B)
    // A↔B offset = audibleA - (audibleB + bar1A - bar1B) = audibleA - audibleB - bar1A + bar1B
    //            = (audibleA - bar1A) - (audibleB - bar1B) = offA - offB
    // (Invariant under uniform global shift)
    const abKickOffset = offA - offB;
    scenarios.push({ shiftMs, offA: +offA.toFixed(2), offB: +offB.toFixed(2), xcorr, abKickOffset: +abKickOffset.toFixed(2) });
  }
  return {
    pairIdx,
    basenameA, basenameB,
    bpmA: trackA.analyzerBpm, bpmB: trackB.analyzerBpm,
    bar1A_ms: trackA.analyzerFirstDownbeatSec * 1000,
    bar1B_ms: trackB.analyzerFirstDownbeatSec * 1000,
    truthA_ms: trackA.truthFirstDownbeatSec * 1000,
    truthB_ms: trackB.truthFirstDownbeatSec * 1000,
    audibleA, audibleB,
    audibleA_offFromBar1: +(audibleA - trackA.analyzerFirstDownbeatSec * 1000).toFixed(2),
    audibleB_offFromBar1: +(audibleB - trackB.analyzerFirstDownbeatSec * 1000).toFixed(2),
    scenarios,
  };
}

const results = [];
for (let i = 0; i < PAIRS.length; i++) {
  const r = await runPair(i + 1, PAIRS[i][0], PAIRS[i][1]);
  if (r) results.push(r);
}

writeFileSync(resolve(__dirname, "sync_correctness_data.json"), JSON.stringify(results, null, 2));

// ── Build report ──
const lines = [];
lines.push("# Sync Correctness Diagnostic — Results\n");
lines.push("Measured 3 quantities per pair under 5 global-shift scenarios. The cross-track");
lines.push("measurements (xcorr peak lag, A↔B kick offset) are algebraically invariant under");
lines.push("uniform shift — they're reported for the record. The discriminating signal is");
lines.push("PER-TRACK: how far the audible kick body (perceptual reference) sits from bar-1.");
lines.push("");

lines.push("## Pair selection");
lines.push("5 PASS-PASS pairs from the post-fix-G snapshot. All prog-house family, 120-122 BPM.");
for (let i = 0; i < results.length; i++) {
  const r = results[i];
  lines.push("  " + (i + 1) + ". " + r.basenameA + " (Δ " + (r.bar1A_ms - r.truthA_ms).toFixed(1) + ") + " + r.basenameB + " (Δ " + (r.bar1B_ms - r.truthB_ms).toFixed(1) + ")");
}
lines.push("");

// Per-track audible kick offsets
lines.push("## Per-track: audible kick body − bar-1 (negative = bar-1 is BEFORE the audible kick)\n");
lines.push("Audible kick = peak of 10ms-smoothed 40-200Hz power within ±60ms of bar-1.");
lines.push("This is the perceptual center of the kick body — the position the hypothesis");
lines.push("predicts Rekordbox anchors bar-1 to.");
lines.push("");
lines.push("```");
lines.push("Pair  Track                                          bar1(ms)  audible(ms)  offset(ms)");
for (const r of results) {
  lines.push(`  ${r.pairIdx}  A: ${r.basenameA.slice(0, 42).padEnd(43)} ${r.bar1A_ms.toFixed(1).padStart(8)}  ${r.audibleA.toFixed(1).padStart(10)}  ${r.audibleA_offFromBar1.toFixed(1).padStart(10)}`);
  lines.push(`     B: ${r.basenameB.slice(0, 42).padEnd(43)} ${r.bar1B_ms.toFixed(1).padStart(8)}  ${r.audibleB.toFixed(1).padStart(10)}  ${r.audibleB_offFromBar1.toFixed(1).padStart(10)}`);
}
lines.push("```\n");

const allOffsets = [];
for (const r of results) {
  allOffsets.push(r.audibleA_offFromBar1);
  allOffsets.push(r.audibleB_offFromBar1);
}
const meanOffset = allOffsets.reduce((a, b) => a + b, 0) / allOffsets.length;
const sortedOff = [...allOffsets].sort((a, b) => a - b);
const medianOffset = sortedOff[Math.floor(sortedOff.length / 2)];
const stdevOffset = Math.sqrt(allOffsets.reduce((a, b) => a + (b - meanOffset) ** 2, 0) / allOffsets.length);
lines.push("Aggregate across 10 tracks:");
lines.push("```");
lines.push(`  mean offset:   ${meanOffset.toFixed(2)} ms  (audible kick is ${meanOffset > 0 ? "AFTER" : "BEFORE"} bar-1 on average)`);
lines.push(`  median offset: ${medianOffset.toFixed(2)} ms`);
lines.push(`  stdev:         ${stdevOffset.toFixed(2)} ms`);
lines.push(`  min:           ${Math.min(...allOffsets).toFixed(2)} ms`);
lines.push(`  max:           ${Math.max(...allOffsets).toFixed(2)} ms`);
lines.push("```\n");

// Per-shift table: per-track offset after shift, plus A↔B
lines.push("## Per-shift scenarios (per-track offset & cross-track metrics)\n");
lines.push("Negative per-track offset = bar-1 is BEFORE audible kick. Positive = AFTER.");
lines.push("Best shift = where per-track offset is closest to zero for most tracks.");
lines.push("");
lines.push("```");
const shiftCols = SHIFTS_MS.map(s => (s >= 0 ? "+" : "") + s + "ms");
lines.push("Pair                                                 " + shiftCols.map(s => s.padStart(8)).join(""));
for (const r of results) {
  for (const [label, key] of [["  Track A audible-bar1", "offA"], ["  Track B audible-bar1", "offB"], ["  A↔B kick offset    ", "abKickOffset"]]) {
    const row = label + ": " + r.scenarios.map(s => s[key] != null ? s[key].toFixed(1).padStart(8) : "      —").join("");
    lines.push(row);
  }
  lines.push("  XCORR peak lag (ms): " + r.scenarios.map(s => s.xcorr ? s.xcorr.peakLagMs.toFixed(1).padStart(8) : "      —").join(""));
  lines.push("  Pair " + r.pairIdx + " above");
  lines.push("");
}
lines.push("```\n");

// Per-shift aggregate
lines.push("## Aggregate per shift (mean across all tracks)\n");
lines.push("```");
lines.push("Shift     mean |offset|   median |offset|  mean A↔B");
for (let s = 0; s < SHIFTS_MS.length; s++) {
  const shiftMs = SHIFTS_MS[s];
  const allOffs = [];
  const allAB = [];
  for (const r of results) {
    if (r.scenarios[s].offA != null) allOffs.push(Math.abs(r.scenarios[s].offA));
    if (r.scenarios[s].offB != null) allOffs.push(Math.abs(r.scenarios[s].offB));
    if (r.scenarios[s].abKickOffset != null) allAB.push(Math.abs(r.scenarios[s].abKickOffset));
  }
  const mAbs = allOffs.reduce((a, b) => a + b, 0) / allOffs.length;
  const sorted = [...allOffs].sort((a, b) => a - b);
  const medAbs = sorted[Math.floor(sorted.length / 2)];
  const mAB = allAB.reduce((a, b) => a + b, 0) / allAB.length;
  lines.push("  " + ((shiftMs >= 0 ? "+" : "") + shiftMs + "ms").padStart(7) + "    " + mAbs.toFixed(2).padStart(8) + "       " + medAbs.toFixed(2).padStart(8) + "      " + mAB.toFixed(2).padStart(8));
}
lines.push("```\n");

writeFileSync(resolve(__dirname, "SYNC_CORRECTNESS_RESULT.md"), lines.join("\n"));
console.error("\nWritten to SYNC_CORRECTNESS_RESULT.md");
