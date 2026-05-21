// cluster_offset_worker.mjs — feature extraction worker.
// For each track, decode and compute signal features at the analyzer's bar-1
// position. Used by cluster_offset_test.js to evaluate conditional offset
// gates.
//
// Features extracted (all measured in a 100ms window centered on analyzer's bar-1):
//   - attackSlope: max(dE/dt) of 1.5ms-smoothed 40-200Hz power envelope
//   - subBassRatio: power(40-80Hz) / (power(80-200Hz) + eps)
//   - attackRampMs: time from 10%-of-peak to peak in the smoothed envelope
//   - peakPower: max smoothed power in window
//   - firstKickAmpRatio: peak smoothed power at analyzer bar-1 / median peak
//     amplitude across first 10s of audio

import { parentPort } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS_NM = resolve(__dirname, "..", "bpm-test-harness", "node_modules");
const decodeAudioMod = await import(resolve(HARNESS_NM, "audio-decode", "audio-decode.js"));
const decodeAudio = decodeAudioMod.default;

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

function sumSquares(buf, lo, hi) {
  let s = 0;
  for (let i = lo; i < hi; i++) { const v = buf[i]; s += v * v; }
  return s;
}

function extractFeatures(mono, sr, bar1Sec) {
  // 100ms window centered on bar1 (but clip to start ≥ 0)
  const winHalfMs = 50;
  const winStart = Math.max(0, Math.round((bar1Sec - winHalfMs / 1000) * sr));
  const winEnd = Math.min(mono.length, Math.round((bar1Sec + winHalfMs / 1000) * sr));
  if (winEnd - winStart < sr * 0.02) {
    return { error: "window-too-small" };
  }
  const sub = mono.subarray(winStart, winEnd);

  // Filter 40-80Hz and 80-200Hz (with 10ms padding for IIR warmup)
  const padSamples = Math.round(sr * 0.010);
  const padStart = Math.max(0, winStart - padSamples);
  const padEnd = Math.min(mono.length, winEnd + padSamples);
  const padded = mono.subarray(padStart, padEnd);
  const f40_80 = bandpass(padded, sr, 40, 80);
  const f80_200 = bandpass(padded, sr, 80, 200);
  const f40_200 = bandpass(padded, sr, 40, 200);
  const innerOff = winStart - padStart;
  const innerEnd = innerOff + (winEnd - winStart);

  const E_sub = sumSquares(f40_80, innerOff, innerEnd);
  const E_mid = sumSquares(f80_200, innerOff, innerEnd);
  const subBassRatio = E_sub / (E_mid + 1e-12);

  // Smoothed power envelope (1.5ms), attack slope, ramp duration
  const winLen = winEnd - winStart;
  const power = new Float32Array(winLen);
  for (let i = 0; i < winLen; i++) {
    const v = f40_200[innerOff + i];
    power[i] = v * v;
  }
  const smoothWin = Math.max(8, Math.round(sr * 0.0015));
  const smoothed = new Float32Array(winLen);
  let acc = 0;
  for (let i = 0; i < winLen; i++) {
    acc += power[i];
    if (i >= smoothWin) acc -= power[i - smoothWin];
    smoothed[i] = acc / Math.min(i + 1, smoothWin);
  }
  // Max dE/dt + position of peak
  let attackSlope = 0, peakI = 0, peakPower = 0;
  for (let i = 1; i < winLen; i++) {
    const d = smoothed[i] - smoothed[i - 1];
    if (d > attackSlope) attackSlope = d;
    if (smoothed[i] > peakPower) { peakPower = smoothed[i]; peakI = i; }
  }
  // Attack ramp duration: time from 10%-of-peak to peak (in ms)
  let attackRampMs = null;
  if (peakI > 0) {
    const thresh10 = peakPower * 0.10;
    let startI = 0;
    for (let i = 0; i <= peakI; i++) { if (smoothed[i] >= thresh10) { startI = i; break; } }
    attackRampMs = (peakI - startI) / sr * 1000;
  }

  // For first-kick amplitude ratio: peak smoothed in window vs the median
  // peak amplitude across the first 10s of audio (cheap proxy for "is this
  // a loud kick relative to the track baseline").
  const ref10Sec = Math.min(mono.length, Math.round(10 * sr));
  const refFiltered = bandpass(mono.subarray(0, ref10Sec), sr, 40, 200);
  // Smoothed power at 5ms hops, take the median of all local maxima as the
  // reference amplitude.
  const refHop = Math.max(1, Math.round(sr * 0.005));
  const refN = Math.floor(refFiltered.length / refHop);
  const refE = new Float32Array(refN);
  for (let i = 0; i < refN; i++) {
    const st = i * refHop;
    let s = 0;
    for (let j = st; j < Math.min(refFiltered.length, st + refHop); j++) {
      const v = refFiltered[j]; s += v * v;
    }
    refE[i] = s / refHop;
  }
  const refPeaks = [];
  for (let i = 1; i < refN - 1; i++) {
    if (refE[i] > refE[i - 1] && refE[i] > refE[i + 1] && refE[i] > 0) refPeaks.push(refE[i]);
  }
  refPeaks.sort((a, b) => a - b);
  const refMedian = refPeaks.length ? refPeaks[Math.floor(refPeaks.length / 2)] : 0;
  const firstKickAmpRatio = refMedian > 0 ? peakPower / refMedian : 0;

  return {
    attackSlope,
    subBassRatio,
    attackRampMs,
    peakPower,
    firstKickAmpRatio,
  };
}

parentPort.on("message", async (msg) => {
  if (msg.type === "shutdown") process.exit(0);
  const { idx, path, bar1Sec } = msg;
  let buf;
  try {
    buf = await decodeAudio(readFileSync(path));
  } catch (e) {
    parentPort.postMessage({ idx, error: "decode: " + e.message });
    return;
  }
  const sr = buf.sampleRate;
  const mono = toMono(buf.channelData);
  try {
    const feats = extractFeatures(mono, sr, bar1Sec);
    parentPort.postMessage({ idx, features: feats });
  } catch (e) {
    parentPort.postMessage({ idx, error: "extract: " + e.message });
  }
});

parentPort.postMessage({ type: "ready" });
