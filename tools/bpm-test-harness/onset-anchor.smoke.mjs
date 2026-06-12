// onset-anchor.smoke.mjs — Phase 1 safety net #1.
//
// Asserts the re-anchored beatTimes (onsetAnchor=true / ?onsetgrid=1) sit on
// the kick ONSET: median |beatTime − onset| < 4ms across real tracks. Runs the
// analyzer worker BOTH ways (legacy diff-argmax vs onset-anchored) so the shift
// is visible. Onset reference = 40-200Hz kick-band leading edge from raw
// samples (same detector as grid-anchor-diagnostic.mjs).
//
//   cd tools/bpm-test-harness && node onset-anchor.smoke.mjs
//   exit 0 = PASS (median < 4ms), 1 = FAIL. Requires audio in ./tracks.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import decodeAudio from "audio-decode";
import { WORKER_SRC } from "../../src/bpm-worker-source.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACKS_DIR = resolve(__dirname, "tracks");
const TRACKS = [
  "03 Aliens (Original Mix).mp3",
  "Cloaked - Hypervisor (Extended Mix).mp3",
  "Will DeKeizer - Rocket Jam (Original Mix).mp3",
];
const THRESH = 0.15, N_KICKS = 24, SKIP_BEATS = 8, TOL_MS = 4;

function runWorker(cd, sr, id, onsetAnchor) {
  let captured = null;
  const self = { onmessage: null, postMessage: (r) => { captured = r; } };
  const origLog = console.log; console.log = () => {};
  try { new Function("self", WORKER_SRC)(self); self.onmessage({ data: { cd, sr, id, onsetAnchor } }); } // eslint-disable-line no-new-func
  finally { console.log = origLog; }
  if (!captured) throw new Error("worker produced no result");
  return captured;
}
function kickEnvelope(mono, sr) {
  const aHP = Math.exp(-2 * Math.PI * 40 / sr), aLP = Math.exp(-2 * Math.PI * 200 / sr), aSm = Math.exp(-2 * Math.PI * 80 / sr);
  const env = new Float32Array(mono.length); let lpHP = 0, lpBand = 0, lpEnv = 0;
  for (let i = 0; i < mono.length; i++) { lpHP = aHP * lpHP + (1 - aHP) * mono[i]; const hp = mono[i] - lpHP; lpBand = aLP * lpBand + (1 - aLP) * hp; const rect = lpBand > 0 ? lpBand : -lpBand; lpEnv = aSm * lpEnv + (1 - aSm) * rect; env[i] = lpEnv; }
  return env;
}
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

function onsetOf(env, sr, b, floor) {
  const i0 = Math.max(1, Math.floor((b - 0.16) * sr)), i1 = Math.min(env.length - 1, Math.floor((b + 0.06) * sr));
  let peak = 0, peakIdx = i0;
  for (let i = i0; i <= i1; i++) if (env[i] > peak) { peak = env[i]; peakIdx = i; }
  if (peak <= floor) return null;
  const gate = floor + THRESH * (peak - floor); let j = peakIdx;
  while (j > i0 && env[j] >= gate) j--;
  return j <= i0 ? null : (j + 1) / sr;
}

console.log("\nONSET-ANCHOR SMOKE — median |beatTime − onset| must be < " + TOL_MS + "ms when anchored\n");
console.log("track                              | legacy |b-a| | anchored |b-a| | verdict");
console.log("-".repeat(78));

const pooledAnchored = [];
let ran = 0;
for (const name of TRACKS) {
  const path = resolve(TRACKS_DIR, name);
  if (!existsSync(path)) { console.log(basename(name).padEnd(34) + " | (missing audio — skipped)"); continue; }
  const dec = await decodeAudio(readFileSync(path));
  const sr = dec.sampleRate, channelData = dec.channelData, length = channelData[0].length, dur = length / sr;
  const mono = new Float32Array(length);
  for (let ch = 0; ch < channelData.length; ch++) { const d = channelData[ch]; for (let i = 0; i < length; i++) mono[i] += d[i] / channelData.length; }
  const env = kickEnvelope(mono, sr);
  const floor = pct(Array.from(env.filter((_, i) => i % 97 === 0)), 0.30);

  const measure = (beatTimes) => {
    const errs = []; let used = 0;
    for (let k = SKIP_BEATS; k < beatTimes.length && used < N_KICKS; k++) {
      const b = beatTimes[k]; if (b < 0.3 || b > dur - 0.3) continue;
      const a = onsetOf(env, sr, b, floor); if (a == null) continue;
      errs.push(Math.abs(b - a) * 1000); used++;
    }
    return errs;
  };
  // NOTE: two full analyzer passes per track (legacy + anchored) — slower but
  // makes the shift explicit. cd is consumed per call; decode once, copy per run.
  const copy = () => channelData.map(a => Float32Array.from(a));
  const legacy = measure(runWorker(copy(), sr, name, false).beatTimes);
  const anchored = measure(runWorker(copy(), sr, name, true).beatTimes);
  if (!anchored.length) { console.log(basename(name).padEnd(34) + " | no reliable kicks"); continue; }
  pooledAnchored.push(...anchored); ran++;
  const pass = med(anchored) < TOL_MS;
  console.log(
    basename(name).slice(0, 34).padEnd(34) + " | " +
    (med(legacy).toFixed(1) + "ms").padStart(10) + " | " +
    (med(anchored).toFixed(1) + "ms").padStart(12) + "   | " + (pass ? "PASS" : "FAIL")
  );
}

const overallPass = ran > 0 && med(pooledAnchored) < TOL_MS;
console.log("-".repeat(78));
console.log("pooled anchored: median " + med(pooledAnchored).toFixed(2) + "ms  mean " + mean(pooledAnchored).toFixed(2) +
  "  p75 " + pct(pooledAnchored, 0.75).toFixed(1) + "ms  (n=" + pooledAnchored.length + ")");
console.log(overallPass ? "\n✅ PASS — beatTimes anchored to the kick onset (<" + TOL_MS + "ms median)."
                        : "\n❌ FAIL — anchored median ≥ " + TOL_MS + "ms (or no audio present).");
process.exit(overallPass ? 0 : 1);
