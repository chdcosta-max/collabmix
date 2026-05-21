// late_walkback_worker.mjs — for each track + analyzer bar-1 position,
// compute per-sample dE/dt of smoothed 40-200Hz power within ana ± 50ms.
// Return all local maxima and their offsets from ana.

import { parentPort } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS_NM = resolve(__dirname, "..", "bpm-test-harness", "node_modules");
const decodeAudioMod = await import(resolve(HARNESS_NM, "audio-decode", "audio-decode.js"));
const decodeAudio = decodeAudioMod.default;

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

function probeWindow(mono, sr, anaSec) {
  // Window: [anaSec - 50ms, anaSec + 25ms] — looking for EARLIER kicks
  const winStartSec = Math.max(0, anaSec - 0.050);
  const winEndSec = Math.max(winStartSec + 0.020, anaSec + 0.025);
  const winStart = Math.round(winStartSec * sr);
  const winEnd = Math.min(mono.length, Math.round(winEndSec * sr));
  if (winEnd - winStart < 200) return null;
  const padS = Math.round(sr * 0.010);
  const padStart = Math.max(0, winStart - padS);
  const padEnd = Math.min(mono.length, winEnd + padS);
  const padded = mono.subarray(padStart, padEnd);
  const filtered = bandpass(padded, sr, 40, 200);
  const innerOff = winStart - padStart;
  const winLen = winEnd - winStart;
  const power = new Float32Array(winLen);
  for (let i = 0; i < winLen; i++) {
    const v = filtered[innerOff + i]; power[i] = v * v;
  }
  const smoothWin = Math.max(8, Math.round(sr * 0.0015));
  const smoothed = new Float32Array(winLen);
  let runSum = 0;
  for (let i = 0; i < winLen; i++) {
    runSum += power[i];
    if (i >= smoothWin) runSum -= power[i - smoothWin];
    smoothed[i] = runSum / Math.min(i + 1, smoothWin);
  }
  // Find ALL local maxima of dE/dt (with exclusion ±2ms ~ 88 samples)
  const diff = new Float32Array(winLen);
  for (let i = 1; i < winLen; i++) {
    const d = smoothed[i] - smoothed[i - 1];
    diff[i] = d > 0 ? d : 0;
  }
  const exclRadius = Math.max(2, Math.round(sr * 0.002));
  const slopes = [];
  const offsetMs = [];
  for (let i = exclRadius; i < winLen - exclRadius; i++) {
    let isMax = true;
    for (let k = 1; k <= exclRadius; k++) {
      if (diff[i] < diff[i - k] || diff[i] < diff[i + k]) { isMax = false; break; }
    }
    if (isMax && diff[i] > 0) {
      slopes.push(diff[i]);
      // offset from ana (positive = later than ana, negative = earlier)
      offsetMs.push(((winStart + i) / sr - anaSec) * 1000);
    }
  }
  return { slopes, offsetMs };
}

parentPort.on("message", async (msg) => {
  if (msg.type === "shutdown") process.exit(0);
  const { idx, path, anaSec } = msg;
  try {
    const buf = await decodeAudio(readFileSync(path));
    const mono = toMono(buf.channelData);
    const r = probeWindow(mono, buf.sampleRate, anaSec);
    if (r) parentPort.postMessage({ idx, slopes: r.slopes, offsetMs: r.offsetMs });
    else parentPort.postMessage({ idx, error: "window too narrow" });
  } catch (e) {
    parentPort.postMessage({ idx, error: e.message });
  }
});

parentPort.postMessage({ type: "ready" });
