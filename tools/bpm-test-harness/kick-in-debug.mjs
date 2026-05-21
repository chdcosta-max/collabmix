// kick-in-debug.mjs — verbose dump for a single track. Prints all peaks
// in the first 5 seconds (or all peaks before structural detector fires),
// so we can see why the structural-kick-in algorithm chose what it did.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import decodeAudio from "audio-decode";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NAME = process.argv[2];
if (!NAME) {
  console.error("Usage: node kick-in-debug.mjs <basename-substring>");
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(resolve(__dirname, "library-truth.json"), "utf8"));
const track = manifest.tracks.find(t => t.basename.toLowerCase().includes(NAME.toLowerCase()));
if (!track) {
  console.error("No match for", NAME);
  process.exit(2);
}
console.log("Track:", track.basename);
console.log("Truth firstDownbeatSec:", track.firstDownbeatSec);

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

const buf = await decodeAudio(readFileSync(track.path));
const sr = buf.sampleRate;
const mono = toMono(buf.channelData);
console.log("sr =", sr, "  durSec =", (mono.length / sr).toFixed(1));

const band = bandpass(mono, sr, 40, 100);
const HOP_SEC = 0.025;
const hop = Math.round(sr * HOP_SEC);
const nFrames = Math.floor(mono.length / hop);
const fE = new Float32Array(nFrames);
for (let i = 0; i < nFrames; i++) {
  const st = i * hop;
  let s = 0;
  for (let j = 0; j < hop && st + j < band.length; j++) {
    const v = band[st + j];
    s += v * v;
  }
  fE[i] = Math.sqrt(s / hop);
}
const fS = new Float32Array(nFrames);
for (let i = 0; i < nFrames; i++) {
  let acc = 0, n = 0;
  for (let k = -1; k <= 1; k++) {
    const j = i + k;
    if (j >= 0 && j < nFrames) { acc += fE[j]; n++; }
  }
  fS[i] = acc / n;
}
const PEAK_R = 4;
const peaks = [];
for (let i = PEAK_R; i < nFrames - PEAK_R; i++) {
  let isPeak = true;
  for (let k = 1; k <= PEAK_R; k++) {
    if (fS[i] < fS[i - k] || fS[i] < fS[i + k]) { isPeak = false; break; }
  }
  if (isPeak && fS[i] > 0) peaks.push({ frame: i, amp: fS[i] });
}
const ampsSorted = peaks.map(p => p.amp).sort((a, b) => a - b);
const medAmp = ampsSorted[Math.floor(ampsSorted.length / 2)];
console.log("Total peaks:", peaks.length, "  Median peak amp:", medAmp.toExponential(2));
console.log("Peak amplitude percentiles:");
for (const p of [0.10, 0.25, 0.50, 0.75, 0.90, 0.95, 0.99]) {
  const a = ampsSorted[Math.floor(ampsSorted.length * p)];
  console.log(`  p${(p * 100).toFixed(0)}: ${a.toExponential(2)}`);
}

const thresh30 = medAmp * 0.30;
const thresh10 = medAmp * 0.10;
const thresh05 = medAmp * 0.05;
console.log("");
console.log("First 25 peaks (frame, time, amp, /median):");
for (let i = 0; i < Math.min(25, peaks.length); i++) {
  const p = peaks[i];
  const t = p.frame * HOP_SEC;
  const ratio = p.amp / medAmp;
  console.log(`  ${String(p.frame).padStart(5)}  t=${(t * 1000).toFixed(0).padStart(6)}ms  amp=${p.amp.toExponential(2)}  ratio=${ratio.toFixed(2)}`);
}

console.log("");
console.log("Peaks within 5s of truth (truth =", (track.firstDownbeatSec * 1000).toFixed(0), "ms):");
const truthFrame = Math.round(track.firstDownbeatSec / HOP_SEC);
for (const p of peaks) {
  if (p.frame < truthFrame - 5 || p.frame > truthFrame + 200) continue;
  const ratio = p.amp / medAmp;
  const mark = Math.abs(p.frame - truthFrame) <= 1 ? " ← TRUTH" : "";
  console.log(`  frame=${String(p.frame).padStart(5)}  t=${(p.frame * HOP_SEC * 1000).toFixed(0).padStart(6)}ms  amp=${p.amp.toExponential(2)}  ratio=${ratio.toFixed(2)}${mark}`);
}
