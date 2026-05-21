// subcause_f_worker.mjs — extracts attackSlope at the first N beats of a
// track. Used by subcause_f_population.js to identify Sub-cause F candidates
// (beat 0 slope much weaker than the track's typical beat slope).
//
// Method: replicates the analyzer's beat-0 refinement (40-200 Hz bandpass,
// 1.5ms-smoothed power, HW-rectified first derivative, argmax) at every
// beat position derived from bar1Sec + k × periodSec.

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
  for (let i = 0; i < sig.length; i++) {
    hp[i] = rH * (po + sig[i] - pi); pi = sig[i]; po = hp[i];
  }
  let pv = 0;
  for (let i = 0; i < hp.length; i++) { pv = pv + (1 - rL) * (hp[i] - pv); out[i] = pv; }
  return out;
}

function attackSlopeAt(mono, sr, centerSec) {
  const halfWinMs = 50;
  const winStart = Math.max(0, Math.round((centerSec - halfWinMs / 1000) * sr));
  const winEnd = Math.min(mono.length, Math.round((centerSec + halfWinMs / 1000) * sr));
  if (winEnd - winStart < 200) return { slope: null, peak: null };
  const padS = Math.round(sr * 0.010);
  const padStart = Math.max(0, winStart - padS);
  const padEnd = Math.min(mono.length, winEnd + padS);
  const padded = mono.subarray(padStart, padEnd);
  const filtered = bandpass(padded, sr, 40, 200);
  const innerOff = winStart - padStart;
  const winLen = winEnd - winStart;
  const power = new Float32Array(winLen);
  let peakPower = 0;
  for (let i = 0; i < winLen; i++) {
    const v = filtered[innerOff + i]; const p = v * v;
    power[i] = p;
    if (p > peakPower) peakPower = p;
  }
  const smoothWin = Math.max(8, Math.round(sr * 0.0015));
  const smoothed = new Float32Array(winLen);
  let runSum = 0;
  for (let i = 0; i < winLen; i++) {
    runSum += power[i];
    if (i >= smoothWin) runSum -= power[i - smoothWin];
    smoothed[i] = runSum / Math.min(i + 1, smoothWin);
  }
  let bestSlope = 0;
  for (let i = 1; i < winLen; i++) {
    const d = smoothed[i] - smoothed[i - 1];
    if (d > bestSlope) bestSlope = d;
  }
  return { slope: bestSlope, peak: peakPower };
}

parentPort.on("message", async (msg) => {
  if (msg.type === "shutdown") process.exit(0);
  const { idx, path, bar1Sec, periodSec, nBeats } = msg;
  let buf;
  try {
    buf = await decodeAudio(readFileSync(path));
  } catch (e) {
    parentPort.postMessage({ idx, error: "decode: " + e.message });
    return;
  }
  const sr = buf.sampleRate;
  const mono = toMono(buf.channelData);
  const durSec = mono.length / sr;
  const slopes = new Array(nBeats).fill(null);
  for (let k = 0; k < nBeats; k++) {
    const t = bar1Sec + k * periodSec;
    if (t < 0 || t >= durSec) break;
    const r = attackSlopeAt(mono, sr, t);
    slopes[k] = r.slope;
  }
  parentPort.postMessage({ idx, slopes, durSec });
});

parentPort.postMessage({ type: "ready" });
