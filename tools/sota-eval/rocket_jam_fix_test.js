// rocket_jam_fix_test.js — designs and simulates a "shift to first real kick"
// rule for tracks with the Sub-cause F signature (beat 0 attackSlope ≈ 0).
//
// For each candidate, walk forward through beats 1..N to find the first
// beat with attackSlope ≥ FIRSTKICK_THRESHOLD × trackMedianSlope. Shift
// bar-1 to that beat. Simulate the harness impact + verify on Rocket Jam
// (not in harness), Symbiotic Symphony, and Boundless Heart.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = resolve(__dirname, "..", "bpm-test-harness");
const SNAPSHOT = JSON.parse(readFileSync(resolve(HARNESS_DIR, "snapshots", "fix-D.json"), "utf8"));
const MANIFEST = JSON.parse(readFileSync(resolve(HARNESS_DIR, "library-truth.json"), "utf8"));
const N_BEATS = 30;
const HARNESS_TOL_MS = 20;

// Sub-cause F tight gate: beat 0 slope effectively zero
const SUBF_BEAT0_MAX = 1e-6;
const SUBF_RATIO_MIN = 100; // slope[1] / slope[0] for sanity

// First-kick rule threshold
const FIRSTKICK_THRESHOLD = 0.5; // slope ≥ 50% × median(slopes from 1+)

// ── Set up targets ──
// Harness tracks (272) + Rocket Jam (off-harness, for verification only)
const ROCKET_JAM_PATH = "/Users/chad/Music/Music/Media.localized/Music/Will DeKeizer/Sound of Neptune/02 Rocket Jam (Original Mix).mp3";
const ROCKET_JAM_TRUTH_MS = 771; // per probe: first real kick at ~771ms = analyzer beat 1 = +1 period shift

const graded = SNAPSHOT.results.filter(r => r.status === "PASS" || r.status === "FAIL");

// Build "tasks" — each track gets a probe job
const tasks = [];
for (const r of graded) {
  tasks.push({
    basename: r.basename,
    path: r.path,
    bar1Sec: r.analyzerFirstDownbeatSec || 0,
    periodSec: r.beatPeriodSec || 0,
    truthMs: r.truthFirstDownbeatSec * 1000,
    anaMs: (r.analyzerFirstDownbeatSec ?? 0) * 1000,
    periodMs: (r.beatPeriodSec || 0) * 1000,
    status: r.status,
    deltaMs: (r.analyzerFirstDownbeatSec ?? 0) * 1000 - r.truthFirstDownbeatSec * 1000,
    isOffHarness: false,
  });
}
// Rocket Jam: use the probe's known bar1 + period
tasks.push({
  basename: "02 Rocket Jam (Original Mix).mp3 [OFF-HARNESS]",
  path: ROCKET_JAM_PATH,
  bar1Sec: 0.27937, // per ROCKET_JAM_PROBE.md
  periodSec: 0.491803,
  truthMs: ROCKET_JAM_TRUTH_MS,
  anaMs: 279.37,
  periodMs: 491.803,
  status: "FAIL",
  deltaMs: 279.37 - ROCKET_JAM_TRUTH_MS, // -491.6
  isOffHarness: true,
});

console.error(`Tasks: ${tasks.length} (${graded.length} harness + ${tasks.length - graded.length} off-harness)`);

// ── Probe slopes via worker pool ──
const results = new Array(tasks.length).fill(null);
const N_WORKERS = Math.min(os.cpus().length, 8);
const startTime = Date.now();
let nextIdx = 0, completed = 0;

await new Promise((resolveAll) => {
  const workers = [];
  let ready = 0;
  function dispatch(w) {
    if (nextIdx >= tasks.length) { w.postMessage({ type: "shutdown" }); return; }
    const i = nextIdx++;
    const t = tasks[i];
    w.postMessage({ idx: i, path: t.path, bar1Sec: t.bar1Sec, periodSec: t.periodSec, nBeats: N_BEATS });
  }
  for (let i = 0; i < N_WORKERS; i++) {
    const w = new Worker(resolve(__dirname, "subcause_f_worker.mjs"));
    workers.push(w);
    w.on("message", (m) => {
      if (m.type === "ready") {
        ready++;
        if (ready === N_WORKERS) for (const w2 of workers) dispatch(w2);
        return;
      }
      results[m.idx] = m;
      completed++;
      if (completed % 25 === 0 || completed === tasks.length) {
        process.stderr.write(`\r  [${completed}/${tasks.length}] ${((Date.now() - startTime)/1000).toFixed(0)}s   `);
      }
      if (completed === tasks.length) {
        for (const w2 of workers) w2.postMessage({ type: "shutdown" });
        resolveAll();
      } else {
        dispatch(w);
      }
    });
    w.on("error", e => console.error("\nWorker error:", e));
  }
});
process.stderr.write("\n");

// ── Helpers ──
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ── Apply the rule ──
// For each task: find "first kick beat" = first beat[k>=1] with slope >= FIRSTKICK_THRESHOLD × medianSlopeFromBeat1Plus.
// Apply gate: only fire if beat[0] slope < SUBF_BEAT0_MAX AND slope[firstKick] >= SUBF_RATIO_MIN × slope[0]
// (effectively saying beat 0 is truly silent compared to the first real kick).
const enriched = tasks.map((t, i) => {
  const slopes = (results[i]?.slopes || []).slice();
  const beat0 = slopes[0];
  const slopes1plus = slopes.slice(1).filter(s => s != null && s > 0);
  const medSlope = median(slopes1plus);
  let firstKickBeat = null;
  if (slopes1plus.length >= 4) {
    const thresh = medSlope * FIRSTKICK_THRESHOLD;
    for (let k = 1; k < slopes.length; k++) {
      if (slopes[k] != null && slopes[k] >= thresh) {
        firstKickBeat = k;
        break;
      }
    }
  }
  let gateFires = false;
  if (beat0 != null && firstKickBeat != null) {
    gateFires = beat0 < SUBF_BEAT0_MAX &&
                slopes[firstKickBeat] > beat0 * SUBF_RATIO_MIN;
  }
  const shiftBeats = gateFires ? firstKickBeat : 0;
  const newDeltaMs = t.deltaMs + shiftBeats * t.periodMs;
  const wasPass = Math.abs(t.deltaMs) <= HARNESS_TOL_MS;
  const willPass = Math.abs(newDeltaMs) <= HARNESS_TOL_MS;
  return {
    ...t,
    beat0Slope: beat0,
    beat1Slope: slopes[1],
    firstKickBeat,
    firstKickSlope: firstKickBeat != null ? slopes[firstKickBeat] : null,
    trackMedianSlope: medSlope,
    gateFires,
    shiftBeats,
    newDeltaMs,
    wasPass,
    willPass,
  };
});

// ── Report ──
const fires = enriched.filter(e => e.gateFires);
const rescues = enriched.filter(e => e.gateFires && !e.wasPass && e.willPass);
const regressions = enriched.filter(e => e.gateFires && e.wasPass && !e.willPass);
const stillFail = enriched.filter(e => e.gateFires && !e.wasPass && !e.willPass);
const stillPass = enriched.filter(e => e.gateFires && e.wasPass && e.willPass);

console.log("");
console.log("=== Rule: shift to first beat with slope ≥ " + (FIRSTKICK_THRESHOLD * 100) + "% of track median ===");
console.log("Gate: beat0Slope < " + SUBF_BEAT0_MAX + " AND firstKickSlope > " + SUBF_RATIO_MIN + " × beat0Slope");
console.log("");
console.log("Gate fires on: " + fires.length + " tracks");
console.log("  Rescues (FAIL→PASS):    " + rescues.length);
console.log("  Regressions (PASS→FAIL): " + regressions.length);
console.log("  Still FAIL after shift:  " + stillFail.length);
console.log("  Still PASS after shift:  " + stillPass.length);
console.log("");
console.log("All fired tracks:");
console.log("name".padEnd(50) + "  shift  period   Δ_before    Δ_after    was→will");
for (const e of fires) {
  console.log(e.basename.slice(0, 49).padEnd(50) + "  " +
    (e.shiftBeats + "β").padStart(4) + "   " +
    e.periodMs.toFixed(1).padStart(6) + "  " +
    e.deltaMs.toFixed(1).padStart(9) + "  " +
    e.newDeltaMs.toFixed(1).padStart(9) + "    " +
    (e.wasPass ? "P" : "F") + "→" + (e.willPass ? "P" : "F")
  );
}

// ── Acceptance checks ──
console.log("");
console.log("=== Acceptance checks ===");
const ssE = enriched.find(e => e.basename.toLowerCase().includes("symbiotic"));
const bhE = enriched.find(e => e.basename.toLowerCase().includes("boundless"));
const rjE = enriched.find(e => e.basename.toLowerCase().includes("rocket jam"));
function check(name, e) {
  if (!e) { console.log("  " + name + ": NOT FOUND"); return; }
  console.log("  " + name + ":");
  console.log("    beat0Slope: " + (e.beat0Slope != null ? e.beat0Slope.toExponential(2) : "null"));
  console.log("    beat1Slope: " + (e.beat1Slope != null ? e.beat1Slope.toExponential(2) : "null"));
  console.log("    medianSlope: " + (e.trackMedianSlope != null ? e.trackMedianSlope.toExponential(2) : "null"));
  console.log("    firstKickBeat: " + e.firstKickBeat);
  console.log("    gateFires: " + e.gateFires);
  console.log("    shift: " + e.shiftBeats + "β");
  console.log("    Δ_before: " + e.deltaMs.toFixed(1) + "ms, Δ_after: " + e.newDeltaMs.toFixed(1) + "ms");
  console.log("    " + (e.wasPass ? "PASS" : "FAIL") + " → " + (e.willPass ? "PASS" : "FAIL"));
}
check("Rocket Jam (off-harness)", rjE);
check("Symbiotic Symphony", ssE);
check("Boundless Heart", bhE);

// Save full data
writeFileSync(resolve(__dirname, "rocket_jam_fix_data.json"), JSON.stringify({ enriched, settings: { FIRSTKICK_THRESHOLD, SUBF_BEAT0_MAX, SUBF_RATIO_MIN } }, null, 2));
