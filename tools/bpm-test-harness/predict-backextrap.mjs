// Across all FAIL tracks, simulate what back-extrap would predict for various N.
// Uses the worker probe to capture dpBeatsFloat[8] and finalPeriod, computes
// back-extrap_bar1 = dpBeatsFloat[8] - 8 * finalPeriod (wrapped to [0,period)),
// reports the predicted Δfd vs truth.
//
// Goal: predict how many FAIL tracks back-extrap would fix vs how many PASS
// tracks would regress, WITHOUT running the harness end-to-end.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = resolve(__dirname, "analyze-worker.mjs");

// Custom worker that captures the [STEP5-PROBE] log line by parsing it.
// We can't easily extract this from the existing analyze-worker without
// modifying. Instead, re-decode the worker source ad-hoc with a hook.
// SIMPLER: just modify analyze-worker.mjs temporarily, or run sequentially
// with audio-decode and the worker source.

import decodeAudio from "audio-decode";
import { WORKER_SRC } from "../../src/bpm-worker-source.js";

function runAnalyzer(cd, sr, id) {
  let captured = null;
  let probeLine = null;
  const self = { onmessage: null, postMessage: (r) => { captured = r; } };
  const origLog = console.log;
  console.log = (...args) => {
    const s = args.join(" ");
    if (s.startsWith("[STEP5-PROBE]")) probeLine = s;
  };
  try {
    new Function("self", WORKER_SRC)(self);
    self.onmessage({ data: { cd, sr, id } });
  } finally {
    console.log = origLog;
  }
  return { result: captured, probeLine };
}

function parseProbe(line) {
  // [STEP5-PROBE] track <id> period_mean=X finalPeriod=Y nBeats=Z bFms=N:t,N:t,...
  const periodMatch = line.match(/period_mean=([\d.]+)\s+finalPeriod=([\d.]+)/);
  const beatsMatch = line.match(/bFms=([\d.:,]+)/);
  if (!periodMatch || !beatsMatch) return null;
  const beatsByIdx = new Map();
  for (const pair of beatsMatch[1].split(",")) {
    const [n, t] = pair.split(":");
    beatsByIdx.set(parseInt(n, 10), parseFloat(t));
  }
  return {
    periodMean: parseFloat(periodMatch[1]),
    finalPeriod: parseFloat(periodMatch[2]),
    beatsByIdx,
  };
}

const truth = JSON.parse(readFileSync("library-truth.json", "utf8"));
const baseline = JSON.parse(readFileSync("snapshots/fix-C-40.json", "utf8"));
const truthByName = new Map(truth.tracks.map(t => [t.basename, t]));
const baseByName = new Map(baseline.results.map(r => [r.basename, r]));

// Process all tracks via a simple worker pool
const N_WORKERS = 8;
const tracks = truth.tracks;
let nextIdx = 0;
const probes = new Array(tracks.length);

// For each track, decode + run analyzer to capture probe line
async function worker() {
  while (true) {
    const i = nextIdx++;
    if (i >= tracks.length) return;
    const t = tracks[i];
    try {
      const buf = await decodeAudio(readFileSync(t.path));
      const sr = buf.sampleRate;
      const cd = buf.channelData;
      if (!Array.isArray(cd) || !(cd[0] instanceof Float32Array)) continue;
      const { result, probeLine } = runAnalyzer(cd, sr, t.basename);
      if (!probeLine) continue;
      const probe = parseProbe(probeLine);
      if (!probe) continue;
      probes[i] = { name: t.basename, truthSec: t.firstDownbeatSec, currentAnaSec: result.firstBar1AnchorSec, probe };
    } catch (e) {
      // skip
    }
    process.stderr.write(`\r  [${nextIdx}/${tracks.length}]   `);
  }
}

// Note: audio-decode and worker_threads with shared memory don't always cooperate
// (audio-decode's WASM init may not be thread-safe). For this analysis, run
// in main thread sequentially. Speed: ~30 ms per decode + analyze each in main.

await worker();
process.stderr.write("\n");

// Analyze each probe and predict back-extrap impact for various N
const TOLERANCE = 20;
function bestExtrap(p, N, period) {
  if (!p) return null;
  const beatNms = p.beatsByIdx.get(N);
  if (beatNms === undefined || isNaN(beatNms)) return null;
  const periodMs = period * 1000;
  let backExtrapMs = beatNms - N * periodMs;
  while (backExtrapMs < 0) backExtrapMs += periodMs;
  while (backExtrapMs >= periodMs) backExtrapMs -= periodMs;
  return backExtrapMs;
}

function circDiff(a, b, period) {
  const periodMs = period * 1000;
  const raw = Math.abs(a - b);
  return Math.min(raw, periodMs - raw);
}

// For each (N, threshold) combo, simulate and count outcomes
const Ns = [4, 8, 16, 32, 64, 128, 256];
const thresholds = [10, 15, 20, 25, 30];
for (const useFinal of [false, true]) {
  console.log(`\n=== using ${useFinal ? "finalPeriod (BPM-snapped)" : "period_mean (DP-mean)"} ===`);
  console.log("  N  thresh  newPASS  fixed  regressed  netΔ");
  for (const N of Ns) {
    for (const thresh of thresholds) {
      let fixed = 0, regressed = 0;
      for (const p of probes) {
        if (!p) continue;
        const baseEntry = baseByName.get(p.name);
        if (!baseEntry) continue;
        const period = useFinal ? p.probe.finalPeriod : p.probe.periodMean;
        const backExtrap = bestExtrap(p.probe, N, period);
        if (backExtrap === null) continue;
        const currentBar1 = (p.currentAnaSec || 0) * 1000;
        const diff = circDiff(backExtrap, currentBar1, period);
        if (diff <= thresh) continue; // no override
        // Override happens
        const newDfd = Math.abs(backExtrap - p.truthSec * 1000);
        const wasPassing = baseEntry.status === "PASS";
        const willPass = newDfd <= TOLERANCE;
        if (wasPassing && !willPass) regressed++;
        if (!wasPassing && willPass) fixed++;
      }
      const netGain = fixed - regressed;
      console.log(`  ${N.toString().padStart(2)}  ${thresh.toString().padStart(5)}ms  +${fixed.toString().padStart(3)}/-${regressed.toString().padStart(3)}  net=${netGain >= 0 ? "+" : ""}${netGain}`);
    }
  }
}
