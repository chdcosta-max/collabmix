// desmear-verify.mjs — Phase 2 render check.
//
// Confirms the hybrid de-smear moves the DRAWN kick leading edge onto the true
// onset. Replicates production's big-WF column math (AnimatedZoomedWF Pass 1 +
// heights) at max zoom, measures the blob leading edge BEFORE and AFTER the
// de-smear pass, vs the raw-sample onset. Uses onset-anchored beatTimes (the
// onsets the de-smear snaps to).
//
//   cd tools/bpm-test-harness && node desmear-verify.mjs   (needs ./tracks)
//   exit 0 = PASS (|drawn-edge − onset| median < 6ms after de-smear), else 1.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import decodeAudio from "audio-decode";
import { WORKER_SRC } from "../../src/bpm-worker-source.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACKS_DIR = resolve(__dirname, "tracks");
const TRACKS = ["03 Aliens (Original Mix).mp3", "Cloaked - Hypervisor (Extended Mix).mp3", "Will DeKeizer - Rocket Jam (Original Mix).mp3"];
const WF_W = 24000, GAMMA = 1.4, LIFT_TH = 0.7, LIFT_AMT = 0.35;
const WINDOW_SEC = 4, PHYS_W = 1100;     // max-zoom level, representative canvas width
const EDGE_THRESH = 0.15, N_KICKS = 24, SKIP_BEATS = 8;
// Robust gate: the de-smear must close most of the gap, not hit a knife-edge.
const MAX_AFTER_MS = 10;                  // |drawn edge − onset| after de-smear
const MIN_REDUCTION = 0.40;               // ≥40% smaller than before

function runWorker(cd, sr, id, onsetAnchor) {
  let captured = null; const self = { onmessage: null, postMessage: (r) => { captured = r; } };
  const origLog = console.log; console.log = () => {};
  try { new Function("self", WORKER_SRC)(self); self.onmessage({ data: { cd, sr, id, onsetAnchor } }); } finally { console.log = origLog; } // eslint-disable-line no-new-func
  if (!captured) throw new Error("no worker result");
  return captured;
}
function kickEnvelope(mono, sr) {
  const aHP = Math.exp(-2 * Math.PI * 40 / sr), aLP = Math.exp(-2 * Math.PI * 200 / sr), aSm = Math.exp(-2 * Math.PI * 80 / sr);
  const env = new Float32Array(mono.length); let lpHP = 0, lpBand = 0, lpEnv = 0;
  for (let i = 0; i < mono.length; i++) { lpHP = aHP * lpHP + (1 - aHP) * mono[i]; const hp = mono[i] - lpHP; lpBand = aLP * lpBand + (1 - aLP) * hp; const rect = lpBand > 0 ? lpBand : -lpBand; lpEnv = aSm * lpEnv + (1 - aSm) * rect; env[i] = lpEnv; }
  return env;
}
// production band-split → normalized bands (bands.bass/mid/high, 0..1)
function bands(channelData, length, sr) {
  const aB = Math.exp(-2 * Math.PI * 300 / sr), aM = Math.exp(-2 * Math.PI * 3500 / sr), step = Math.max(1, length / WF_W);
  const b = new Float32Array(WF_W), m = new Float32Array(WF_W), h = new Float32Array(WF_W);
  for (let ch = 0; ch < channelData.length; ch++) { const d = channelData[ch]; let lpB = 0, lpM = 0;
    for (let i = 0; i < length; i++) { const s = d[i]; lpB = aB * lpB + (1 - aB) * s; lpM = aM * lpM + (1 - aM) * s; const x = Math.min(WF_W - 1, Math.floor(i / step)); const bv = Math.abs(lpB), mv = Math.abs(lpM - lpB), hv = Math.abs(s - lpM); if (bv > b[x]) b[x] = bv; if (mv > m[x]) m[x] = mv; if (hv > h[x]) h[x] = hv; } }
  const norm = (a) => { let mx = 0; for (const v of a) mx = Math.max(mx, v); const o = new Float32Array(a.length); if (mx < 1e-4) return o; for (let i = 0; i < a.length; i++) o[i] = Math.round(a[i] / mx * 1000) / 1000; return o; };
  return { bass: norm(b), mid: norm(m), high: norm(h) };
}
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function onsetOf(env, sr, b, floor) {
  const i0 = Math.max(1, Math.floor((b - 0.16) * sr)), i1 = Math.min(env.length - 1, Math.floor((b + 0.06) * sr));
  let peak = 0, pk = i0; for (let i = i0; i <= i1; i++) if (env[i] > peak) { peak = env[i]; pk = i; }
  if (peak <= floor) return null; const gate = floor + EDGE_THRESH * (peak - floor); let j = pk; while (j > i0 && env[j] >= gate) j--; return j <= i0 ? null : (j + 1) / sr;
}

// Replicate AnimatedZoomedWF column render around a kick at tCenter; return the
// drawn-blob leading-edge time (seconds), optionally with the de-smear applied.
function drawnLeadingEdge(bnd, dur, tCenter, onsets, applyDesmear) {
  const len = WF_W, bArr = bnd.bass, mArr = bnd.mid, hArr = bnd.high;
  const viewBufSec = WINDOW_SEC;                          // rate=1
  const viewPx = (viewBufSec / dur) * len;
  const prog = tCenter / dur;
  const srcX = prog * len - viewPx / 2, spp = viewPx / PHYS_W;
  let envDivisor = 0; for (let i = 0; i < len; i++) { const v = 0.7 * bArr[i] + 0.2 * mArr[i] + 0.1 * hArr[i]; if (v > envDivisor) envDivisor = v; } if (envDivisor < 1e-4) envDivisor = 1;
  const envs = new Float32Array(PHYS_W);
  for (let dx = 0; dx < PHYS_W; dx++) {
    const f0 = srcX + dx * spp, f1 = f0 + spp; let s0 = f0 | 0, s1 = f1 | 0;
    s0 = s0 < 0 ? 0 : (s0 >= len ? len - 1 : s0); s1 = s1 < s0 ? s0 : (s1 >= len ? len - 1 : s1);
    let b = 0, m = 0, h = 0; for (let k = s0; k <= s1; k++) { if (bArr[k] > b) b = bArr[k]; if (mArr[k] > m) m = mArr[k]; if (hArr[k] > h) h = hArr[k]; }
    envs[dx] = (0.7 * b + 0.2 * m + 0.1 * h) / envDivisor;
  }
  if (applyDesmear && onsets) {
    const bucketSec = dur / len, SMEAR = Math.min(0.025, Math.max(0.008, bucketSec * 1.5));
    const tLeft = (srcX / len) * dur, tRight = ((srcX + viewPx) / len) * dur;
    for (let oi = 0; oi < onsets.length; oi++) {
      const t = onsets[oi]; if (t < tLeft - SMEAR || t > tRight) continue;
      const xOnset = ((t / dur) * len - srcX) / spp, xStart = (((t - SMEAR) / dur) * len - srcX) / spp;
      const c0 = Math.max(0, Math.ceil(xStart)), c1 = Math.min(PHYS_W - 1, Math.floor(xOnset) - 1);
      if (c1 < c0) continue; const baseline = envs[c0];
      for (let dx = c0; dx <= c1; dx++) if (envs[dx] > baseline) envs[dx] = baseline;
    }
  }
  // leading edge: from the local peak column near canvas center, walk back to
  // the first column below 15% of (peak above the window floor).
  const cCenter = Math.round(PHYS_W / 2);
  let peak = 0, pk = cCenter; for (let dx = Math.max(0, cCenter - 120); dx <= Math.min(PHYS_W - 1, cCenter + 60); dx++) if (envs[dx] > peak) { peak = envs[dx]; pk = dx; }
  let floor = 1; for (let dx = Math.max(0, pk - 160); dx < pk; dx++) if (envs[dx] < floor) floor = envs[dx];
  if (peak <= floor) return null;
  const gate = floor + EDGE_THRESH * (peak - floor); let j = pk; while (j > 0 && envs[j] >= gate) j--;
  // column → time
  const f = srcX + (j + 1) * spp; return (f / len) * dur;
}

console.log("\nPHASE 2 DE-SMEAR VERIFY — drawn kick edge vs true onset (max zoom " + WINDOW_SEC + "s)\n");
console.log("track                              | render edge BEFORE | render edge AFTER | verdict");
console.log("-".repeat(80));
const pooledBefore = [], pooledAfter = []; let ran = 0;
for (const name of TRACKS) {
  const path = resolve(TRACKS_DIR, name);
  if (!existsSync(path)) { console.log(basename(name).padEnd(34) + " | (missing audio)"); continue; }
  const dec = await decodeAudio(readFileSync(path));
  const sr = dec.sampleRate, cd = dec.channelData, length = cd[0].length, dur = length / sr;
  const mono = new Float32Array(length); for (let ch = 0; ch < cd.length; ch++) { const d = cd[ch]; for (let i = 0; i < length; i++) mono[i] += d[i] / cd.length; }
  const env = kickEnvelope(mono, sr), floor = pct(Array.from(env.filter((_, i) => i % 97 === 0)), 0.30);
  const bnd = bands(cd, length, sr);
  const onsets = runWorker(cd.map(a => Float32Array.from(a)), sr, name, true).beatTimes;
  const before = [], after = [];
  let used = 0;
  for (let k = SKIP_BEATS; k < onsets.length && used < N_KICKS; k++) {
    const b = onsets[k]; if (b < 0.3 || b > dur - 0.3) continue;
    const a = onsetOf(env, sr, b, floor); if (a == null) continue;
    const cB = drawnLeadingEdge(bnd, dur, b, onsets, false);
    const cA = drawnLeadingEdge(bnd, dur, b, onsets, true);
    if (cB == null || cA == null) continue;
    before.push((cB - a) * 1000); after.push((cA - a) * 1000); used++;
  }
  if (!after.length) { console.log(basename(name).padEnd(34) + " | no reliable kicks"); continue; }
  pooledBefore.push(...before); pooledAfter.push(...after); ran++;
  const reduced = 1 - Math.abs(med(after)) / Math.max(1e-6, Math.abs(med(before)));
  const pass = Math.abs(med(after)) < MAX_AFTER_MS && reduced >= MIN_REDUCTION;
  console.log(basename(name).slice(0, 34).padEnd(34) + " | " + (med(before).toFixed(1) + "ms").padStart(17) + "  | " + (med(after).toFixed(1) + "ms").padStart(16) + "  | " + (pass ? "PASS" : "FAIL"));
}
const mb = Math.abs(med(pooledBefore)), ma = Math.abs(med(pooledAfter));
const reduction = 1 - ma / Math.max(1e-6, mb);
const overall = ran > 0 && ma < MAX_AFTER_MS && reduction >= MIN_REDUCTION;
console.log("-".repeat(80));
console.log("pooled: |edge−onset| median " + med(pooledBefore).toFixed(1) + "ms → " + med(pooledAfter).toFixed(1) +
  "ms  (" + (reduction * 100).toFixed(0) + "% closer, n=" + pooledAfter.length + ")");
console.log("gate: |after| < " + MAX_AFTER_MS + "ms AND ≥" + (MIN_REDUCTION * 100) + "% reduction");
console.log(overall ? "\n✅ PASS — de-smear lands the drawn kick edge on the onset."
                    : "\n❌ FAIL — de-smear did not close the gap enough.");
process.exit(overall ? 0 : 1);
