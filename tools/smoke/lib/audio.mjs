// audio.mjs — shared analyzer/onset/band helpers for the audio smoke tests.
// Single source so onset-anchor and desmear measure identically. nearestBeat /
// onset / band logic mirrors src (the grid-anchor diagnostics) — keep in sync.

import { readFileSync } from "node:fs";
import decodeAudio from "audio-decode";
import { WORKER_SRC } from "../../../src/bpm-worker-source.js";

export const WF_W = 24000, GAMMA = 1.4, LIFT_TH = 0.7, LIFT_AMT = 0.35;

export async function decode(path) {
  const dec = await decodeAudio(readFileSync(path));
  const sr = dec.sampleRate, channelData = dec.channelData, length = channelData[0].length;
  const mono = new Float32Array(length);
  for (let ch = 0; ch < channelData.length; ch++) { const d = channelData[ch]; for (let i = 0; i < length; i++) mono[i] += d[i] / channelData.length; }
  return { sr, channelData, length, dur: length / sr, mono };
}

// Run the real analyzer worker headlessly (same shim the harness uses).
export function runWorker(channelData, sr, id, onsetAnchor) {
  let cap = null;
  const self = { onmessage: null, postMessage: (r) => { cap = r; } };
  const ol = console.log; console.log = () => {};
  try { new Function("self", WORKER_SRC)(self); self.onmessage({ data: { cd: channelData.map((a) => Float32Array.from(a)), sr, id, onsetAnchor } }); } // eslint-disable-line no-new-func
  finally { console.log = ol; }
  if (!cap) throw new Error("worker produced no result");
  return cap;
}

// 40-200Hz kick-band rectified+smoothed envelope (raw-sample onset reference).
export function kickEnvelope(mono, sr) {
  const aHP = Math.exp(-2 * Math.PI * 40 / sr), aLP = Math.exp(-2 * Math.PI * 200 / sr), aSm = Math.exp(-2 * Math.PI * 80 / sr);
  const env = new Float32Array(mono.length); let lpHP = 0, lpBand = 0, lpEnv = 0;
  for (let i = 0; i < mono.length; i++) { lpHP = aHP * lpHP + (1 - aHP) * mono[i]; const hp = mono[i] - lpHP; lpBand = aLP * lpBand + (1 - aLP) * hp; const r = lpBand > 0 ? lpBand : -lpBand; lpEnv = aSm * lpEnv + (1 - aSm) * r; env[i] = lpEnv; }
  return env;
}
const PCT = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
export const envFloor = (env) => PCT(Array.from(env.filter((_, i) => i % 97 === 0)), 0.30);

// Leading edge (seconds) near time b: walk back from the local peak to the
// first sample below floor + thresh·(peak−floor). null if it runs to the edge.
export function onsetOf(env, sr, b, floor, thresh = 0.15) {
  const i0 = Math.max(1, Math.floor((b - 0.16) * sr)), i1 = Math.min(env.length - 1, Math.floor((b + 0.06) * sr));
  let peak = 0, pk = i0; for (let i = i0; i <= i1; i++) if (env[i] > peak) { peak = env[i]; pk = i; }
  if (peak <= floor) return null;
  const gate = floor + thresh * (peak - floor); let j = pk; while (j > i0 && env[j] >= gate) j--;
  return j <= i0 ? null : (j + 1) / sr;
}

// Production band split → normalized bass/mid/high (0..1), peak-hold `wfw`
// buckets. wfw defaults to production WF_W (24000); the desmear test passes a
// smaller value so a SHORT fixture exhibits the same ~19ms bucket smear a real
// (minutes-long) track shows at WF_W=24000 — bucketSec = dur/wfw either way.
export function bands(channelData, length, sr, wfw = WF_W) {
  const aB = Math.exp(-2 * Math.PI * 300 / sr), aM = Math.exp(-2 * Math.PI * 3500 / sr), step = Math.max(1, length / wfw);
  const b = new Float32Array(wfw), m = new Float32Array(wfw), h = new Float32Array(wfw);
  for (let ch = 0; ch < channelData.length; ch++) { const d = channelData[ch]; let lpB = 0, lpM = 0;
    for (let i = 0; i < length; i++) { const s = d[i]; lpB = aB * lpB + (1 - aB) * s; lpM = aM * lpM + (1 - aM) * s; const x = Math.min(wfw - 1, Math.floor(i / step)); const bv = Math.abs(lpB), mv = Math.abs(lpM - lpB), hv = Math.abs(s - lpM); if (bv > b[x]) b[x] = bv; if (mv > m[x]) m[x] = mv; if (hv > h[x]) h[x] = hv; } }
  const norm = (a) => { let mx = 0; for (const v of a) mx = Math.max(mx, v); const o = new Float32Array(a.length); if (mx < 1e-4) return o; for (let i = 0; i < a.length; i++) o[i] = Math.round(a[i] / mx * 1000) / 1000; return o; };
  return { bass: norm(b), mid: norm(m), high: norm(h) };
}
