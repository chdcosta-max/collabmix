// late_track_probe.js — for a single track + truth/ana positions, dump the
// kick attack signal at both positions and a few surrounding beats. Used to
// diagnose whether the analyzer "missed an earlier kick" in LATE FAILs.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS_NM = resolve(__dirname, "..", "bpm-test-harness", "node_modules");
const decodeAudioMod = await import(resolve(HARNESS_NM, "audio-decode", "audio-decode.js"));
const decodeAudio = decodeAudioMod.default;

const TRACK_PATH = process.argv[2];
const TRUTH_MS = parseFloat(process.argv[3]);
const ANA_MS = parseFloat(process.argv[4]);
const PERIOD_MS = parseFloat(process.argv[5] || "500");

const buf = await decodeAudio(readFileSync(TRACK_PATH));
const sr = buf.sampleRate;
const ch = buf.channelData;
const mono = new Float32Array(ch[0].length);
for (let i = 0; i < mono.length; i++) {
  let s = 0;
  for (let c = 0; c < ch.length; c++) s += ch[c][i];
  mono[i] = s / ch.length;
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

function attackSlope(centerMs, halfWinMs = 50) {
  const winStart = Math.max(0, Math.round((centerMs - halfWinMs) / 1000 * sr));
  const winEnd = Math.min(mono.length, Math.round((centerMs + halfWinMs) / 1000 * sr));
  if (winEnd - winStart < 200) return { slope: null, argmax_ms: null, peakPower: 0 };
  const padS = Math.round(sr * 0.010);
  const padStart = Math.max(0, winStart - padS);
  const padEnd = Math.min(mono.length, winEnd + padS);
  const padded = mono.subarray(padStart, padEnd);
  const filtered = bandpass(padded, sr, 40, 200);
  const innerOff = winStart - padStart;
  const winLen = winEnd - winStart;
  const power = new Float32Array(winLen);
  let peakPow = 0, peakI = 0;
  for (let i = 0; i < winLen; i++) {
    const v = filtered[innerOff + i]; const p = v * v;
    power[i] = p;
    if (p > peakPow) { peakPow = p; peakI = i; }
  }
  const smoothWin = Math.max(8, Math.round(sr * 0.0015));
  const smoothed = new Float32Array(winLen);
  let runSum = 0;
  for (let i = 0; i < winLen; i++) {
    runSum += power[i];
    if (i >= smoothWin) runSum -= power[i - smoothWin];
    smoothed[i] = runSum / Math.min(i + 1, smoothWin);
  }
  let bestSlope = 0, argmaxI = 1;
  for (let i = 1; i < winLen; i++) {
    const d = smoothed[i] - smoothed[i - 1];
    if (d > bestSlope) { bestSlope = d; argmaxI = i; }
  }
  return { slope: bestSlope, argmax_ms: (winStart + argmaxI) / sr * 1000, peakPower: peakPow, peakI_ms: (winStart + peakI) / sr * 1000 };
}

console.log(TRACK_PATH);
console.log("  Truth   =", TRUTH_MS, "ms");
console.log("  Analyzer=", ANA_MS, "ms");
console.log("  Period  =", PERIOD_MS, "ms");
console.log("");
console.log("Attack slopes at:");
const positions = [
  { name: "Truth", ms: TRUTH_MS },
  { name: "Analyzer", ms: ANA_MS },
  { name: "ana - 25ms", ms: ANA_MS - 25 },
  { name: "ana - period/2", ms: ANA_MS - PERIOD_MS / 2 },
  { name: "ana - period", ms: ANA_MS - PERIOD_MS },
  { name: "ana + period", ms: ANA_MS + PERIOD_MS },
];
for (const p of positions) {
  if (p.ms < 0) continue;
  const r = attackSlope(p.ms);
  console.log("  " + p.name.padEnd(18) + " @ " + p.ms.toFixed(0).padStart(5) + "ms: slope=" + (r.slope?.toExponential(2) || "null") + " argmax@" + r.argmax_ms?.toFixed(1) + "ms (peakPower=" + r.peakPower?.toExponential(2) + ")");
}
