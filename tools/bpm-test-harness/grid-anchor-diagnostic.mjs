// grid-anchor-diagnostic.mjs — separates GRID-DATA error from RENDER error.
//
// Per kick, on real tracks, measures three positions and reports two errors:
//   a = TRUE AUDIO ONSET   — leading edge from raw samples (40-200Hz kick-band
//                            envelope crosses a fraction of its local peak).
//   b = REFINED beatTime   — the analyzer's diff-argmax position (what the grid
//                            line is drawn at).
//   c = DRAWN BLOB EDGE    — leading edge of the kick blob as the big waveform
//                            actually renders it (WF_W=24000 peak-hold buckets,
//                            bass-weighted env — identical to production).
//
//   b - a = GRID error   (is the beat data itself off the onset?)
//   c - a = RENDER error (does the drawn waveform smear/shift the kick?)
//   c - b = grid-vs-drawn (what the eye sees between line and blob)
//
// All in milliseconds. Run from tools/bpm-test-harness:
//   node grid-anchor-diagnostic.mjs ["Track A.mp3" "Track B.mp3" ...]
// Defaults to three clean four-on-the-floor tracks. NOT pushed as a test —
// a measurement script for the grid-anchor decision. Changes NOTHING.

import { readFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import decodeAudio from "audio-decode";
import { WORKER_SRC } from "../../src/bpm-worker-source.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACKS_DIR = resolve(__dirname, "tracks");
const DEFAULT_TRACKS = [
  "03 Aliens (Original Mix).mp3",
  "Cloaked - Hypervisor (Extended Mix).mp3",
  "Will DeKeizer - Rocket Jam (Original Mix).mp3",
];
const WF_W = 24000;                 // production waveform width (peak-hold buckets)
const ONSET_THRESHOLDS = [0.10, 0.20]; // fraction-of-local-peak leading-edge defs
const N_KICKS = 24;                 // kicks sampled per track (after the intro)
const SKIP_BEATS = 8;               // skip the intro/anchor region

// ── run the analyzer worker headlessly (same shim as analyze.mjs) ───────────
function runWorker(cd, sr, id) {
  let captured = null;
  const self = { onmessage: null, postMessage: (r) => { captured = r; } };
  const origLog = console.log; console.log = () => {};
  try {
    new Function("self", WORKER_SRC)(self);     // eslint-disable-line no-new-func
    self.onmessage({ data: { cd, sr, id } });
  } finally { console.log = origLog; }
  if (!captured) throw new Error("worker produced no result");
  return captured;
}

// ── (a) reference: 40-200Hz kick-band rectified+smoothed envelope (raw samples)
// Independent of the analyzer's internal choices — a clean leading-edge proxy.
function kickEnvelope(mono, sr) {
  const aHP = Math.exp(-2 * Math.PI * 40 / sr);
  const aLP = Math.exp(-2 * Math.PI * 200 / sr);
  const aSm = Math.exp(-2 * Math.PI * 80 / sr);   // ~2ms smooth on the rectified band
  const env = new Float32Array(mono.length);
  let lpHP = 0, lpBand = 0, lpEnv = 0;
  for (let i = 0; i < mono.length; i++) {
    lpHP = aHP * lpHP + (1 - aHP) * mono[i];
    const hp = mono[i] - lpHP;
    lpBand = aLP * lpBand + (1 - aLP) * hp;
    const rect = lpBand > 0 ? lpBand : -lpBand;
    lpEnv = aSm * lpEnv + (1 - aSm) * rect;
    env[i] = lpEnv;
  }
  return env;
}

// ── (c) the DRAWN bass-weighted env, identical to production WF band-split ────
function drawnEnv(channelData, length, sr) {
  const aB = Math.exp(-2 * Math.PI * 300 / sr);
  const aM = Math.exp(-2 * Math.PI * 3500 / sr);
  const step = Math.max(1, length / WF_W);
  const bass = new Float32Array(WF_W), mid = new Float32Array(WF_W), high = new Float32Array(WF_W);
  for (let ch = 0; ch < channelData.length; ch++) {
    const data = channelData[ch];
    let lpB = 0, lpM = 0;
    for (let i = 0; i < length; i++) {
      const s = data[i];
      lpB = aB * lpB + (1 - aB) * s;
      lpM = aM * lpM + (1 - aM) * s;
      const x = Math.min(WF_W - 1, Math.floor(i / step));
      const bv = Math.abs(lpB), mv = Math.abs(lpM - lpB), hv = Math.abs(s - lpM);
      if (bv > bass[x]) bass[x] = bv;
      if (mv > mid[x]) mid[x] = mv;
      if (hv > high[x]) high[x] = hv;
    }
  }
  const norm = (arr) => { let mx = 0; for (const v of arr) mx = Math.max(mx, v); if (mx < 1e-4) return arr.map(() => 0); return Array.from(arr, v => Math.round(v / mx * 1000) / 1000); };
  const bN = norm(bass), mN = norm(mid), hN = norm(high);
  const env = new Float32Array(WF_W); let mx = 0;
  for (let i = 0; i < WF_W; i++) { const bw = 0.7 * bN[i] + 0.2 * mN[i] + 0.1 * hN[i]; env[i] = bw; if (bw > mx) mx = bw; }
  for (let i = 0; i < WF_W; i++) env[i] /= (mx > 1e-4 ? mx : 1);
  return env; // length WF_W; bucket k spans [k, k+1) * dur/WF_W seconds
}

// Leading edge: from the local peak in [t0,t1], walk back to the first sample
// below floor + thresh*(peak-floor). Returns seconds, or null if it runs to t0.
function leadingEdge(env, sr, tCenter, halfBackSec, halfFwdSec, thresh, floor) {
  const i0 = Math.max(1, Math.floor((tCenter - halfBackSec) * sr));
  const i1 = Math.min(env.length - 1, Math.floor((tCenter + halfFwdSec) * sr));
  let peak = 0, peakIdx = i0;
  for (let i = i0; i <= i1; i++) if (env[i] > peak) { peak = env[i]; peakIdx = i; }
  if (peak <= floor) return null;
  const gate = floor + thresh * (peak - floor);
  let j = peakIdx;
  while (j > i0 && env[j] >= gate) j--;
  if (j <= i0) return null;            // ran to window edge → unreliable
  return (j + 1) / sr;                 // first sample at/above gate
}

// Same, but on the bucketed drawn env (bucket→seconds via dur/WF_W).
function leadingEdgeBuckets(env, dur, tCenter, halfBackSec, halfFwdSec, thresh, floor) {
  const bsec = dur / WF_W;
  const i0 = Math.max(1, Math.floor((tCenter - halfBackSec) / bsec));
  const i1 = Math.min(env.length - 1, Math.floor((tCenter + halfFwdSec) / bsec));
  let peak = 0, peakIdx = i0;
  for (let i = i0; i <= i1; i++) if (env[i] > peak) { peak = env[i]; peakIdx = i; }
  if (peak <= floor) return null;
  const gate = floor + thresh * (peak - floor);
  let j = peakIdx;
  while (j > i0 && env[j] >= gate) j--;
  if (j <= i0) return null;
  return (j + 1) * bsec;
}

const med = (xs) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (xs, p) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

const tracks = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TRACKS;
const overall = { gridA: {}, render: {} };
for (const th of ONSET_THRESHOLDS) { overall.gridA[th] = []; overall.render[th] = []; }

console.log("\nGRID-ANCHOR DIAGNOSTIC — kick onset (a) vs beatTime (b) vs drawn edge (c)");
console.log("Positive = LATE of the true onset. b-a = grid error, c-a = render error.\n");

for (const name of tracks) {
  const path = resolve(TRACKS_DIR, name);
  let decoded;
  try { decoded = await decodeAudio(readFileSync(path)); }
  catch (e) { console.log(`SKIP ${name}: ${e.message}`); continue; }
  const sr = decoded.sampleRate;
  const channelData = decoded.channelData;
  const length = channelData[0].length;
  const dur = length / sr;
  const bucketMs = dur / WF_W * 1000;

  // mono mix for the onset reference
  const mono = new Float32Array(length);
  for (let ch = 0; ch < channelData.length; ch++) { const d = channelData[ch]; for (let i = 0; i < length; i++) mono[i] += d[i] / channelData.length; }

  const res = runWorker(channelData, sr, name);
  const beatTimes = res.beatTimes;
  if (!beatTimes || beatTimes.length < SKIP_BEATS + 4) { console.log(`SKIP ${name}: too few beats`); continue; }

  const onsetEnv = kickEnvelope(mono, sr);
  const dEnv = drawnEnv(channelData, length, sr);
  // noise floors (low percentile of the relevant envelope)
  const onsetFloor = pct(Array.from(onsetEnv.filter((_, i) => i % 97 === 0)), 0.30);
  const drawnFloor = pct(Array.from(dEnv), 0.30);

  console.log(`── ${basename(name)}`);
  console.log(`   dur=${dur.toFixed(1)}s  sr=${sr}  beats=${beatTimes.length}  bucket=${bucketMs.toFixed(1)}ms (render-resolution floor)`);

  for (const th of ONSET_THRESHOLDS) {
    const gridErr = [], renderErr = [], drawnVsGrid = [];
    let used = 0;
    for (let k = SKIP_BEATS; k < beatTimes.length && used < N_KICKS; k++) {
      const b = beatTimes[k];
      if (b < 0.3 || b > dur - 0.3) continue;
      const a = leadingEdge(onsetEnv, sr, b, 0.16, 0.06, th, onsetFloor);
      const c = leadingEdgeBuckets(dEnv, dur, b, 0.16, 0.06, th, drawnFloor);
      if (a == null || c == null) continue;
      gridErr.push((b - a) * 1000);
      renderErr.push((c - a) * 1000);
      drawnVsGrid.push((c - b) * 1000);
      used++;
    }
    if (!gridErr.length) { console.log(`   thr=${(th * 100).toFixed(0)}%: no reliable kicks`); continue; }
    overall.gridA[th].push(...gridErr);
    overall.render[th].push(...renderErr);
    console.log(
      `   thr=${(th * 100).toFixed(0).padStart(2)}%  n=${gridErr.length}` +
      `  | GRID b-a: median ${med(gridErr).toFixed(1)}ms  mean ${mean(gridErr).toFixed(1)}  [p25 ${pct(gridErr, .25).toFixed(0)}, p75 ${pct(gridErr, .75).toFixed(0)}]` +
      `  | RENDER c-a: median ${med(renderErr).toFixed(1)}ms  mean ${mean(renderErr).toFixed(1)}` +
      `  | drawn-vs-grid c-b: median ${med(drawnVsGrid).toFixed(1)}ms`
    );
  }
  console.log("");
}

console.log("══ OVERALL (all tracks pooled) ══");
for (const th of ONSET_THRESHOLDS) {
  const g = overall.gridA[th], r = overall.render[th];
  if (!g.length) continue;
  console.log(`  onset thr=${(th * 100).toFixed(0)}%  (n=${g.length} kicks)`);
  console.log(`    GRID error   b-a : median ${med(g).toFixed(1)}ms  mean ${mean(g).toFixed(1)}  [p25 ${pct(g, .25).toFixed(0)}, p75 ${pct(g, .75).toFixed(0)}]`);
  console.log(`    RENDER error c-a : median ${med(r).toFixed(1)}ms  mean ${mean(r).toFixed(1)}  [p25 ${pct(r, .25).toFixed(0)}, p75 ${pct(r, .75).toFixed(0)}]`);
}
console.log("\nInterpretation: a large positive GRID median = beatTime sits LATE of the");
console.log("onset (diff-argmax mid-attack). RENDER median isolates the waveform's own");
console.log("contribution (bucket quantization + band-split delay). Fix the larger term.\n");
