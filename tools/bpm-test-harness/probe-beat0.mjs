// Deep probe of beat-0 refinement.
// For each input track:
//   1. Run the worker to get DP frame + refined frame + final firstBar1AnchorSec
//   2. Re-implement the refinement on beat 0 in this process so we can dump
//      smoothed[], diff[], top-3 argmax candidates, parabolic frac
//   3. Compute a "ground-truth" attack position by scanning ±100ms around the
//      Rekordbox truth time using the same 40-200Hz bandpass — to see where
//      the ACTUAL kick attack peaks in the audio
//   4. Print a comparative line: DP, refined, truth (Rekordbox), audio-peak
//
// Usage:
//   node probe-beat0.mjs <path1> [path2 ...]
//
// Truth is loaded from library-truth.json by basename match.

import { readFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import decodeAudio from "audio-decode";
import { WORKER_SRC } from "../../src/bpm-worker-source.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const truth = JSON.parse(readFileSync(resolve(__dirname, "library-truth.json"), "utf8"));
const truthByBasename = new Map();
for (const t of truth.tracks) truthByBasename.set(t.basename, t);

// One-pole IIR bandpass — same as worker
function bp(sig, sr, low, high) {
  const o = new Float32Array(sig.length);
  const rL = 1 / (2 * Math.PI * high / sr + 1);
  const rH = 1 / (2 * Math.PI * low / sr + 1);
  let pi = 0, po = 0;
  const hp = new Float32Array(sig.length);
  for (let i = 0; i < sig.length; i++) {
    hp[i] = rH * (po + sig[i] - pi);
    pi = sig[i];
    po = hp[i];
  }
  let pv = 0;
  for (let i = 0; i < hp.length; i++) {
    pv = o[i] = pv + (1 - rL) * (hp[i] - pv);
  }
  return o;
}

function runWorker(cd, sr, id) {
  let captured = null;
  const self = { onmessage: null, postMessage: (r) => { captured = r; } };
  const origLog = console.log;
  let workerLogs = [];
  console.log = (...args) => workerLogs.push(args.join(" "));
  try {
    new Function("self", WORKER_SRC)(self);
    self.onmessage({ data: { cd, sr, id } });
  } finally {
    console.log = origLog;
  }
  return { result: captured, logs: workerLogs };
}

// Re-implement the worker's beat-0 refinement in detail so we can introspect.
function probeBeat0Refinement(mono, sr, dpFrame0, floatBeatLag, hop, ar) {
  const halfBeatFrames = floatBeatLag * 0.5;
  const beatPeriodSecEst = floatBeatLag / ar;
  const halfWinSec = Math.min(0.05, beatPeriodSecEst * 0.4);
  const halfWinSamples = Math.round(sr * halfWinSec);
  const padSamples = Math.round(sr * 0.010);
  const smoothWin = Math.max(8, Math.round(sr * 0.0015));
  const edgeMargin = Math.max(4, Math.round(sr * 0.001));
  const halfBeatSamples = floatBeatLag * hop / 2;
  const TRANSIENT_RATIO = 3.0;

  const len = mono.length;
  const centerSample = dpFrame0 * hop;
  const winStart = Math.max(0, centerSample - halfWinSamples);
  const winEnd = Math.min(len, centerSample + halfWinSamples);
  const winLen = winEnd - winStart;

  const padStart = Math.max(0, winStart - padSamples);
  const padEnd = Math.min(len, winEnd + padSamples);
  const padded = mono.subarray(padStart, padEnd);
  const filtered = bp(padded, sr, 40, 200);
  const innerOffset = winStart - padStart;

  const power = new Float32Array(winLen);
  let maxPow = 0;
  for (let j = 0; j < winLen; j++) {
    const v = filtered[innerOffset + j];
    const p = v * v;
    power[j] = p;
    if (p > maxPow) maxPow = p;
  }

  const smoothed = new Float32Array(winLen);
  {
    let runSum = 0;
    for (let j = 0; j < winLen; j++) {
      runSum += power[j];
      if (j >= smoothWin) runSum -= power[j - smoothWin];
      const denom = j + 1 < smoothWin ? j + 1 : smoothWin;
      smoothed[j] = runSum / denom;
    }
  }

  const diff = new Float32Array(winLen);
  let maxDiff = 0;
  let sumDiff = 0;
  for (let j = 1; j < winLen; j++) {
    const d = smoothed[j] - smoothed[j - 1];
    const dr = d > 0 ? d : 0;
    diff[j] = dr;
    if (dr > maxDiff) maxDiff = dr;
    sumDiff += dr;
  }
  const meanDiff = sumDiff / Math.max(1, winLen - 1);
  const transientRatio = meanDiff > 0 ? maxDiff / meanDiff : 0;

  // Top-3 argmax candidates (with min spacing of edgeMargin to avoid lobes)
  const peaks = [];
  for (let j = 1; j < winLen - 1; j++) {
    if (diff[j] > 0 && diff[j] >= diff[j - 1] && diff[j] >= diff[j + 1]) {
      peaks.push({ j, v: diff[j] });
    }
  }
  peaks.sort((a, b) => b.v - a.v);
  // dedupe with min spacing
  const topPeaks = [];
  for (const p of peaks) {
    if (topPeaks.every(q => Math.abs(q.j - p.j) >= edgeMargin)) {
      topPeaks.push(p);
      if (topPeaks.length >= 3) break;
    }
  }

  // Argmax (matches worker's first-pass selection)
  let argmaxIdx = 1;
  for (let j = 2; j < winLen; j++) {
    if (diff[j] > diff[argmaxIdx]) argmaxIdx = j;
  }

  // Parabolic interpolation around argmax
  let frac = 0;
  if (argmaxIdx > 0 && argmaxIdx < winLen - 1) {
    const yL = diff[argmaxIdx - 1], yC = diff[argmaxIdx], yR = diff[argmaxIdx + 1];
    const denom = yL - 2 * yC + yR;
    if (denom < 0) {
      frac = (yL - yR) / (2 * denom);
      if (frac > 0.5) frac = 0.5;
      else if (frac < -0.5) frac = -0.5;
    }
  }

  const refinedSample = winStart + argmaxIdx + frac;
  const refinedSec = refinedSample / sr;

  return {
    centerSample,
    centerSec: centerSample / sr,
    winStart,
    winEnd,
    winLen,
    halfWinSamples,
    smoothWin,
    edgeMargin,
    padSamples,
    maxPow,
    transientRatio,
    argmaxIdx,
    frac,
    refinedSample,
    refinedSec,
    topPeaks,
    smoothed,
    diff,
    filtered: filtered.subarray(innerOffset, innerOffset + winLen),
    power,
  };
}

// Audio-peak scan: scan ±100ms around the Rekordbox truth time with the same
// 40-200Hz bandpass. Find the sample of peak smoothed-power onset.
function scanAroundTruth(mono, sr, truthSec) {
  const winHalf = Math.round(sr * 0.10); // ±100ms
  const center = Math.round(truthSec * sr);
  const start = Math.max(0, center - winHalf);
  const end = Math.min(mono.length, center + winHalf);
  const winLen = end - start;
  const padSamples = Math.round(sr * 0.010);
  const padStart = Math.max(0, start - padSamples);
  const padEnd = Math.min(mono.length, end + padSamples);
  const padded = mono.subarray(padStart, padEnd);
  const filtered = bp(padded, sr, 40, 200);
  const innerOffset = start - padStart;
  const smoothWin = Math.max(8, Math.round(sr * 0.0015));

  const power = new Float32Array(winLen);
  for (let j = 0; j < winLen; j++) {
    const v = filtered[innerOffset + j];
    power[j] = v * v;
  }
  const smoothed = new Float32Array(winLen);
  let runSum = 0;
  for (let j = 0; j < winLen; j++) {
    runSum += power[j];
    if (j >= smoothWin) runSum -= power[j - smoothWin];
    const denom = j + 1 < smoothWin ? j + 1 : smoothWin;
    smoothed[j] = runSum / denom;
  }
  const diff = new Float32Array(winLen);
  for (let j = 1; j < winLen; j++) {
    const d = smoothed[j] - smoothed[j - 1];
    diff[j] = d > 0 ? d : 0;
  }
  let argmax = 1;
  for (let j = 2; j < winLen; j++) {
    if (diff[j] > diff[argmax]) argmax = j;
  }
  const audioPeakSample = start + argmax;
  return {
    audioPeakSample,
    audioPeakSec: audioPeakSample / sr,
    audioPeakIdxInWindow: argmax,
    scanStart: start,
    scanEnd: end,
    scanWinLen: winLen,
    diffPeakValue: diff[argmax],
  };
}

function fmtMs(sec) {
  return (sec * 1000).toFixed(2) + "ms";
}
function fmtDelta(a, b) {
  const d = (a - b) * 1000;
  return (d >= 0 ? "+" : "") + d.toFixed(2) + "ms";
}

// ── Per-track probe ───────────────────────────────────────────────────────
const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("Usage: node probe-beat0.mjs <path1> [path2 ...]");
  process.exit(2);
}

for (const path of paths) {
  const base = basename(path);
  const truth = truthByBasename.get(base);
  if (!truth) {
    console.log(`\n── ${base} ──  (NO TRUTH ENTRY)`);
    continue;
  }

  let buf;
  try {
    buf = await decodeAudio(readFileSync(path));
  } catch (e) {
    console.log(`\n── ${base} ──  DECODE FAIL: ${e.message}`);
    continue;
  }
  const sr = buf.sampleRate;
  const cd = buf.channelData;

  // Mono mix (same as worker)
  const len = cd[0].length;
  const nc = cd.length;
  const mono = new Float32Array(len);
  for (let c = 0; c < nc; c++) {
    const d = cd[c];
    for (let i = 0; i < len; i++) mono[i] += d[i] / nc;
  }

  // Run worker
  const { result, logs } = runWorker(cd, sr, base);

  // Recover worker-internal info from logs
  const periodLog = logs.find(l => l.startsWith("[BPM-PERIOD]")) || "";
  const phaseLog = logs.find(l => l.startsWith("[phase] phSc")) || "";
  const refineStatsLog = logs.find(l => l.startsWith("[REFINE-STATS]")) || "";
  const anchorLog = logs.find(l => l.startsWith("[phase] anchor")) || "";

  // Parse hop/ar — match the worker's constants
  const hop = Math.floor(sr / 200);
  const ar = sr / hop;
  const floatBeatLag = (60 / result.bpm) * ar;
  const beatPeriodSec = result.beatPeriodSec;
  const beatFrames = beatPeriodSec * ar;

  // dpBeats[0] from worker anchor log: "dpBeats[0]=0.0443"
  const anchorMatch = anchorLog.match(/dpBeats\[0\]=([\d.]+)/);
  const dpBeat0Sec = anchorMatch ? parseFloat(anchorMatch[1]) : NaN;
  // Worker stores dpBeatsFloat[0] after refinement, then walks back; the value
  // logged is dpBeatsFloat[0] post-refinement.
  const dpFrame0 = Math.round(dpBeat0Sec * ar);

  // Re-run beat-0 refinement locally to introspect
  const probe = probeBeat0Refinement(mono, sr, dpFrame0, floatBeatLag, hop, ar);

  // Scan around truth for the real audio peak
  const truthScan = scanAroundTruth(mono, sr, truth.firstDownbeatSec);

  // Refined sec from probe (matches what worker computes for beat 0)
  const refinedSec = probe.refinedSec;

  // Walk-back simulation (what the worker does)
  let barDownbeatFrame = refinedSec * ar;
  while (barDownbeatFrame - beatFrames >= 0) barDownbeatFrame -= beatFrames;
  const firstBar1Anchor = barDownbeatFrame / ar;

  // Compose report
  console.log(`\n── ${base} ──`);
  console.log(`  truth bpm=${truth.bpm}  truthFirstDownbeatSec=${fmtMs(truth.firstDownbeatSec)}`);
  console.log(`  analyzer bpm=${result.bpm}  firstBar1AnchorSec=${fmtMs(result.firstBar1AnchorSec)}  Δfd=${fmtDelta(result.firstBar1AnchorSec, truth.firstDownbeatSec)}`);
  console.log(`  beatPeriodSec=${beatPeriodSec.toFixed(6)} (beatFrames=${beatFrames.toFixed(2)})`);
  console.log(`  sr=${sr}  hop=${hop}  ar=${ar.toFixed(3)}  floatBeatLag=${floatBeatLag.toFixed(2)} frames`);
  console.log(`  BEAT 0:`);
  console.log(`    DP frame ${dpFrame0} = ${fmtMs(dpFrame0 / ar)}  (centerSample=${probe.centerSample})`);
  console.log(`    window: samples ${probe.winStart}..${probe.winEnd} (winLen=${probe.winLen} = ±${(probe.halfWinSamples / sr * 1000).toFixed(1)}ms)`);
  console.log(`    smoothWin=${probe.smoothWin} samples (${(probe.smoothWin / sr * 1000).toFixed(2)}ms)  edgeMargin=${probe.edgeMargin}  padSamples=${probe.padSamples}`);
  console.log(`    maxPow=${probe.maxPow.toExponential(2)}  transientRatio=${probe.transientRatio.toFixed(2)}`);
  console.log(`    argmax: idx=${probe.argmaxIdx}/${probe.winLen}  frac=${probe.frac.toFixed(3)}`);
  console.log(`    refined sample=${(probe.refinedSample).toFixed(1)} = ${fmtMs(refinedSec)}  Δvs_DP=${fmtDelta(refinedSec, dpFrame0 / ar)}`);
  console.log(`    refined → walk-back → firstBar1Anchor=${fmtMs(firstBar1Anchor)}  Δvs_truth=${fmtDelta(firstBar1Anchor, truth.firstDownbeatSec)}`);
  console.log(`  TOP DIFF PEAKS (in beat-0 window, by amplitude):`);
  for (const p of probe.topPeaks) {
    const sampInTrack = probe.winStart + p.j;
    const sec = sampInTrack / sr;
    console.log(`    idx=${p.j}/${probe.winLen}  sample=${sampInTrack}  sec=${fmtMs(sec)}  diff=${p.v.toExponential(2)}  Δvs_truth=${fmtDelta(sec, truth.firstDownbeatSec)}`);
  }
  console.log(`  AUDIO PEAK (scan ±100ms around truth, same 40-200Hz filter):`);
  console.log(`    sample=${truthScan.audioPeakSample}  sec=${fmtMs(truthScan.audioPeakSec)}  Δvs_truth=${fmtDelta(truthScan.audioPeakSec, truth.firstDownbeatSec)}  diff_amp=${truthScan.diffPeakValue.toExponential(2)}`);
  console.log(`    truth window: samples ${truthScan.scanStart}..${truthScan.scanEnd} (truth-centered ±100ms)`);
  const truthSampleInProbeWin = Math.round(truth.firstDownbeatSec * sr) - probe.winStart;
  const truthInWindow = truthSampleInProbeWin >= 0 && truthSampleInProbeWin < probe.winLen;
  console.log(`  TRUTH POSITION RELATIVE TO BEAT-0 WINDOW:`);
  console.log(`    truth sample=${Math.round(truth.firstDownbeatSec * sr)}  ${truthInWindow ? `INSIDE window at idx=${truthSampleInProbeWin}` : `OUTSIDE window (offset ${truthSampleInProbeWin})`}`);

  // Inspect diff at the truth position to see if it's actually a peak there
  if (truthInWindow) {
    const tj = truthSampleInProbeWin;
    const radius = 200;
    let localMax = 0, localMaxIdx = tj;
    const lo = Math.max(0, tj - radius), hi = Math.min(probe.winLen - 1, tj + radius);
    for (let j = lo; j <= hi; j++) {
      if (probe.diff[j] > localMax) { localMax = probe.diff[j]; localMaxIdx = j; }
    }
    const truthDiffVal = probe.diff[tj];
    console.log(`    diff at truth idx=${tj}: ${truthDiffVal.toExponential(2)}`);
    console.log(`    local max ±${radius} samples around truth: idx=${localMaxIdx}  diff=${localMax.toExponential(2)}  (offset ${localMaxIdx - tj} samples = ${((localMaxIdx - tj) / sr * 1000).toFixed(2)}ms from truth)`);
  }

  // RAW SIGNAL ENERGY comparison at analyzer-peak vs truth (both ±5ms windows)
  // — uses RAW MONO (no filter), so independent of bandpass artifacts.
  const rmsAt = (centerSec, halfMs) => {
    const c = Math.round(centerSec * sr);
    const r = Math.round(sr * halfMs / 1000);
    let s = 0, n = 0;
    for (let i = Math.max(0, c - r); i < Math.min(mono.length, c + r); i++) {
      s += mono[i] * mono[i]; n++;
    }
    return n > 0 ? Math.sqrt(s / n) : 0;
  };
  const rmsAtAnalyzer = rmsAt(refinedSec, 5);
  const rmsAtTruth = rmsAt(truth.firstDownbeatSec, 5);
  const rmsBefore0 = rmsAt(0.001, 5); // first 0..10ms
  const rmsTrackMean = rmsAt(2, 1000); // a 2s window mid-track for reference
  console.log(`  RAW RMS (no filter) in ±5ms windows:`);
  console.log(`    at analyzer (${fmtMs(refinedSec)}): ${rmsAtAnalyzer.toExponential(2)}`);
  console.log(`    at truth    (${fmtMs(truth.firstDownbeatSec)}): ${rmsAtTruth.toExponential(2)}`);
  console.log(`    in first 0-10ms: ${rmsBefore0.toExponential(2)}  (filter-startup proxy)`);
  console.log(`    mid-track reference (2s ±1s): ${rmsTrackMean.toExponential(2)}`);

  // FILTER STARTUP CHECK: scan with bandpass starting at sample 0 (no pre-padding)
  // and compare to a scan with proper pre-padding from later in the file. If the
  // early peak is a filter transient, removing it (e.g., zero-pad first 2000
  // samples and discard their filter output) should change the peak position.
  const earlyScanLen = Math.round(sr * 0.15); // first 150ms
  const filteredFromZero = bp(mono.subarray(0, earlyScanLen + 1000), sr, 40, 200);
  const filteredZeroOut = new Float32Array(earlyScanLen);
  // Sanity: what does filter output look like in first 50ms when input is real?
  let maxRawAbs50 = 0;
  for (let i = 0; i < Math.min(2205, mono.length); i++) {
    if (Math.abs(mono[i]) > maxRawAbs50) maxRawAbs50 = Math.abs(mono[i]);
  }
  console.log(`    max |raw mono| in first 50ms: ${maxRawAbs50.toExponential(2)}`);
  // Filter output in first 50ms
  let maxFiltAbs50 = 0;
  for (let i = 0; i < Math.min(2205, earlyScanLen); i++) {
    if (Math.abs(filteredFromZero[i]) > maxFiltAbs50) maxFiltAbs50 = Math.abs(filteredFromZero[i]);
  }
  console.log(`    max |bp output| in first 50ms (starting from sample 0): ${maxFiltAbs50.toExponential(2)}`);

  // Worker logs (filtered)
  console.log(`  WORKER LOGS:`);
  for (const l of [periodLog, refineStatsLog, anchorLog]) {
    if (l) console.log(`    ${l}`);
  }
}
