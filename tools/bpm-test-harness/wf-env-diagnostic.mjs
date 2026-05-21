// Replicates the exact band-split + normalize logic from
// src/collabmix-production.jsx:3707-3744 against a real MP3, then dumps
// the env distribution that AnimatedZoomedWF would see. NOT pushed to
// master — this is a one-shot measurement script for tuning decisions.
//
// Usage: node wf-env-diagnostic.mjs <path-to-mp3>
// Defaults to tracks/03 Aliens (Original Mix).mp3 if no arg given.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import decodeAudio from 'audio-decode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const trackArg = process.argv[2]
  || path.join(__dirname, 'tracks', '03 Aliens (Original Mix).mp3');

console.log(`\n=== WF env diagnostic ===`);
console.log(`Track: ${trackArg}\n`);

const fileData = fs.readFileSync(trackArg);
const decoded = await decodeAudio(fileData);
// audio-decode v3 returns { channelData: Float32Array[], sampleRate }
const sr = decoded.sampleRate;
const channelData = decoded.channelData;
const numCh = channelData.length;
const length = channelData[0].length;
const dur = length / sr;
const getChannelData = (c) => channelData[c];
console.log(`sampleRate=${sr}, duration=${dur.toFixed(2)}s, frames=${length}, channels=${numCh}\n`);

// ── Mirrors collabmix-production.jsx:3710-3744 (pure peak after revert) ───
const WF_W = 24000;
const aB = Math.exp(-2 * Math.PI * 300 / sr);
const aM = Math.exp(-2 * Math.PI * 3500 / sr);
const bassArr = new Float32Array(WF_W);
const midArr = new Float32Array(WF_W);
const highArr = new Float32Array(WF_W);
const step = Math.max(1, length / WF_W);

for (let ch = 0; ch < numCh; ch++) {
  const data = getChannelData(ch);
  let lpB = 0, lpM = 0;
  for (let i = 0; i < length; i++) {
    const s = data[i];
    lpB = aB * lpB + (1 - aB) * s;
    lpM = aM * lpM + (1 - aM) * s;
    const x = Math.min(WF_W - 1, Math.floor(i / step));
    const bv = Math.abs(lpB);
    const mv = Math.abs(lpM - lpB);
    const hv = Math.abs(s - lpM);
    if (bv > bassArr[x]) bassArr[x] = bv;
    if (mv > midArr[x]) midArr[x] = mv;
    if (hv > highArr[x]) highArr[x] = hv;
  }
}

// ── Identical to collabmix-production.jsx:3743 normBand ────────────────────
const normBand = (arr) => {
  let mx = 0;
  for (let i = 0; i < arr.length; i++) mx = Math.max(mx, arr[i]);
  if (mx < 0.0001) return new Array(arr.length).fill(0);
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = Math.round(arr[i] / mx * 1000) / 1000;
  return out;
};
const bN = normBand(bassArr);
const mN = normBand(midArr);
const hN = normBand(highArr);

// ── Three env reducers: old max(b,m,h), bass-weighted raw, bass-weighted renormalized ──
const envMaxArr = new Array(WF_W);
const envBassWArr = new Array(WF_W);
let bassWMax = 0;
for (let i = 0; i < WF_W; i++) {
  const b = bN[i], m = mN[i], h = hN[i];
  envMaxArr[i] = b > m ? (b > h ? b : h) : (m > h ? m : h);
  const bw = 0.7 * b + 0.2 * m + 0.1 * h;
  envBassWArr[i] = bw;
  if (bw > bassWMax) bassWMax = bw;
}
const envBassWNormArr = envBassWArr.map(v => v / (bassWMax > 0.0001 ? bassWMax : 1));
const envArr = envBassWNormArr; // primary downstream var — what AnimatedZoomedWF Pass 1 sees

// ── Stats helpers ──────────────────────────────────────────────────────────
const stats = (arr, label) => {
  const sorted = [...arr].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const sum = arr.reduce((a, b) => a + b, 0);
  return {
    label,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: sum / arr.length,
    p10: pct(0.10),
    p25: pct(0.25),
    p50: pct(0.50),
    p75: pct(0.75),
    p90: pct(0.90),
    p99: pct(0.99),
  };
};

const printRow = (s) =>
  console.log(
    `${s.label.padEnd(20)} min=${s.min.toFixed(3)}  ` +
    `p10=${s.p10.toFixed(3)}  p25=${s.p25.toFixed(3)}  p50=${s.p50.toFixed(3)}  ` +
    `p75=${s.p75.toFixed(3)}  p90=${s.p90.toFixed(3)}  p99=${s.p99.toFixed(3)}  ` +
    `max=${s.max.toFixed(3)}  avg=${s.avg.toFixed(3)}`
  );

console.log(`── Per-band distribution (24000 columns) ──`);
printRow(stats(bN, 'bass'));
printRow(stats(mN, 'mid'));
printRow(stats(hN, 'high'));
console.log();
console.log(`── env reducer comparison ──`);
printRow(stats(envMaxArr, 'env max(bmh)'));
printRow(stats(envBassWArr, 'env 0.7b+.2m+.1h raw'));
printRow(stats(envBassWNormArr, 'env bassW renormed'));
console.log(`(bassW per-track max divisor = ${bassWMax.toFixed(3)})`);
console.log();

// Project the actual heights produced by AnimatedZoomedWF's Pass 1 with
// current production constants: gamma 1.4 + additive lift 0.20 above env 0.7.
const GAMMA = 1.4, LIFT_TH = 0.7, LIFT_AMT = 0.35;
const projHeight = (env) => {
  if (env <= 0.01) return 0;
  let h = Math.pow(env, GAMMA);
  if (env > LIFT_TH) h += LIFT_AMT * (env - LIFT_TH) / (1 - LIFT_TH);
  return h < 1 ? h : 1;
};
const heightArr = envBassWNormArr.map(projHeight);
console.log(`── Projected heights (% maxH) after gamma ${GAMMA} + lift ${LIFT_AMT} above ${LIFT_TH} ──`);
printRow(stats(heightArr, 'height (% maxH)'));
const satCount = heightArr.filter(v => v >= 0.99).length;
console.log(`  saturated (height >= 99% maxH): ${satCount} cols (${(satCount / WF_W * 100).toFixed(1)}%)`);
console.log();

// ── Drop / breakdown column counts ─────────────────────────────────────────
const dropCount = envArr.filter(v => v > 0.80).length;
const breakCount = envArr.filter(v => v < 0.30).length;
const midCount = envArr.length - dropCount - breakCount;
console.log(`── Energy section breakdown ──`);
console.log(`  drop columns    (env > 0.80): ${dropCount.toString().padStart(5)} (${(dropCount / WF_W * 100).toFixed(1)}%)`);
console.log(`  mid columns     (0.30-0.80):  ${midCount.toString().padStart(5)} (${(midCount / WF_W * 100).toFixed(1)}%)`);
console.log(`  break columns   (env < 0.30): ${breakCount.toString().padStart(5)} (${(breakCount / WF_W * 100).toFixed(1)}%)`);
console.log();

// ── Spot samples every 10% across the track ────────────────────────────────
console.log(`── env samples every 10% across track ──`);
for (let p = 0; p <= 100; p += 10) {
  const idx = Math.min(WF_W - 1, Math.floor(p / 100 * WF_W));
  const t = (idx / WF_W * dur).toFixed(1);
  console.log(
    `  ${p.toString().padStart(3)}%  col=${idx.toString().padStart(5)}  t=${t.padStart(6)}s  ` +
    `bass=${bN[idx].toFixed(3)}  mid=${mN[idx].toFixed(3)}  high=${hN[idx].toFixed(3)}  env=${envArr[idx].toFixed(3)}`
  );
}
console.log();

// ── Hypothesis check ───────────────────────────────────────────────────────
const envP10 = stats(envArr, '').p10;
const envP90 = stats(envArr, '').p90;
const ratio = envP90 / envP10;
console.log(`── Hypothesis check ──`);
console.log(`  env p90/p10 ratio = ${ratio.toFixed(2)}×`);
if (ratio >= 3.0) {
  console.log(`  WIDE spread — source data has plenty of dynamic range.`);
  console.log(`  Recommendation: keep current max(b,m,h) reducer, restore steeper gamma in renderer.`);
} else if (ratio >= 1.8) {
  console.log(`  MODERATE spread — some range but compressed by per-band normalization.`);
  console.log(`  Recommendation: switch to bass-weighted globally-normalized env (Option 2a).`);
} else {
  console.log(`  NARROW spread — source data is too compressed for visual drama at any gamma.`);
  console.log(`  Recommendation: bass-weighted globally-normalized env REQUIRED.`);
}
console.log();
