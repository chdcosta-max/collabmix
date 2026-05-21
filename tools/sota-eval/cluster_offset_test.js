// cluster_offset_test.js — measures the distribution of Δ = analyzer_bar1 -
// rekordbox_truth across all 272 tracks, then evaluates whether a conditional
// +offset correction (gated by signal features) could rescue the Sub-cause B
// cluster without breaking currently-passing tracks.
//
// Part 1: bucketed Δ histogram + per-cluster stats.
// Part 2: gate evaluation for conditional +offset rules.
//
// Pure investigation — no production code touched. Reads from existing
// snapshots; extracts features via worker pool.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = resolve(__dirname, "..", "bpm-test-harness");
const SNAPSHOT = JSON.parse(readFileSync(resolve(HARNESS_DIR, "snapshots", "fix-D.json"), "utf8"));

const HARNESS_TOL_MS = 20;
const STRICT_TOL_MS = 10;

// ── Group A subs (Sub-cause B candidates) ──
const GROUP_A_SUBS = [
  "Body Stars", "Scarlet Sails", "Aurora", "Coaster",
  "Leave the World", "Serenità", "Fly Fox", "Great Attractor",
  "Astronauts", "Finding Estrella", "Swans", "Sparky", "Track II",
];

function isSubCauseB(basename) {
  const lower = basename.toLowerCase();
  return GROUP_A_SUBS.some(s => lower.includes(s.toLowerCase()));
}

// ── Build track-level dataset ──
// For each track, compute raw Δ = analyzer_bar1 - truth and bucket by status
const tracks = [];
for (const r of SNAPSHOT.results) {
  if (r.status !== "PASS" && r.status !== "FAIL") continue;
  const truthMs = r.truthFirstDownbeatSec * 1000;
  const anaMs = (r.analyzerFirstDownbeatSec ?? 0) * 1000;
  const deltaMs = anaMs - truthMs;
  tracks.push({
    basename: r.basename,
    path: r.path,
    truthMs,
    anaMs,
    deltaMs,
    status: r.status,
    isSubB: isSubCauseB(r.basename),
    bpm: r.analyzerBpm,
    periodMs: (r.beatPeriodSec || 0) * 1000,
  });
}
console.error(`Loaded ${tracks.length} tracks from snapshot`);

// ── Feature extraction via worker pool ──
const N_WORKERS = Math.min(os.cpus().length, 8);
console.error(`Spinning up ${N_WORKERS} workers for feature extraction...`);

const features = new Array(tracks.length).fill(null);
let nextIdx = 0;
let completed = 0;
const startTime = Date.now();

await new Promise((resolveAll) => {
  const workers = [];
  let readyCount = 0;
  function dispatch(worker) {
    if (nextIdx >= tracks.length) { worker.postMessage({ type: "shutdown" }); return; }
    const i = nextIdx++;
    const t = tracks[i];
    worker.postMessage({ idx: i, path: t.path, bar1Sec: t.anaMs / 1000 });
  }
  for (let w = 0; w < N_WORKERS; w++) {
    const worker = new Worker(resolve(__dirname, "cluster_offset_worker.mjs"));
    workers.push(worker);
    worker.on("message", (msg) => {
      if (msg.type === "ready") {
        readyCount++;
        if (readyCount === N_WORKERS) for (const w2 of workers) dispatch(w2);
        return;
      }
      features[msg.idx] = msg.features || { error: msg.error };
      completed++;
      if (completed % 20 === 0 || completed === tracks.length) {
        process.stderr.write(`\r  [${completed}/${tracks.length}] ${((Date.now() - startTime)/1000).toFixed(0)}s   `);
      }
      if (completed === tracks.length) {
        for (const w2 of workers) w2.postMessage({ type: "shutdown" });
        resolveAll();
      } else {
        dispatch(worker);
      }
    });
    worker.on("error", e => console.error("\nWorker error:", e));
  }
});
process.stderr.write("\n");

// Merge features into tracks
for (let i = 0; i < tracks.length; i++) {
  Object.assign(tracks[i], features[i] || {});
}

// ── Part 1: Distribution analysis ──
function stats(values) {
  if (!values.length) return { n: 0, mean: null, median: null, stdev: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const median = sorted[Math.floor(values.length / 2)];
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return {
    n: values.length,
    mean: +mean.toFixed(2),
    median: +median.toFixed(2),
    stdev: +Math.sqrt(variance).toFixed(2),
    min: +Math.min(...values).toFixed(2),
    max: +Math.max(...values).toFixed(2),
  };
}
function histogram(values, binMs = 5, minMs = -50, maxMs = 50) {
  const bins = {};
  for (const v of values) {
    if (v < minMs) bins["< " + minMs] = (bins["< " + minMs] || 0) + 1;
    else if (v >= maxMs) bins[">= " + maxMs] = (bins[">= " + maxMs] || 0) + 1;
    else {
      const lo = Math.floor(v / binMs) * binMs;
      const key = `${lo} to ${lo + binMs}ms`;
      bins[key] = (bins[key] || 0) + 1;
    }
  }
  return bins;
}
function histLines(values, binMs = 5, minMs = -50, maxMs = 50) {
  const lines = [];
  const bins = {};
  const sub = values.filter(v => v >= minMs && v < maxMs);
  for (const v of sub) {
    const lo = Math.floor(v / binMs) * binMs;
    bins[lo] = (bins[lo] || 0) + 1;
  }
  const outOfRangeLow = values.filter(v => v < minMs).length;
  const outOfRangeHigh = values.filter(v => v >= maxMs).length;
  const total = values.length;
  if (outOfRangeLow) lines.push(`  < ${minMs}ms:  ${"█".repeat(Math.round(outOfRangeLow / total * 40))} ${outOfRangeLow}`);
  for (let lo = minMs; lo < maxMs; lo += binMs) {
    const n = bins[lo] || 0;
    const bar = "█".repeat(Math.round(n / total * 40));
    lines.push(`  ${String(lo).padStart(4)} to ${String(lo + binMs).padStart(4)}ms:  ${bar} ${n}`);
  }
  if (outOfRangeHigh) lines.push(`  >= ${maxMs}ms:  ${"█".repeat(Math.round(outOfRangeHigh / total * 40))} ${outOfRangeHigh}`);
  return lines.join("\n");
}

// Pass tracks (raw)
const passTracks = tracks.filter(t => t.status === "PASS");
const passDeltas = passTracks.map(t => t.deltaMs);
const passStats = stats(passDeltas);

// FAIL tracks: separate into bounded-Δ (single-beat drift) and off-by-N
const failTracks = tracks.filter(t => t.status === "FAIL");
const failBounded = failTracks.filter(t => Math.abs(t.deltaMs) < 100);
const failOffN = failTracks.filter(t => Math.abs(t.deltaMs) >= 100);
const failBoundedDeltas = failBounded.map(t => t.deltaMs);
const failOffNDeltas = failOffN.map(t => t.deltaMs);

const failBoundedEarly = failBounded.filter(t => t.deltaMs < 0).map(t => t.deltaMs);
const failBoundedLate = failBounded.filter(t => t.deltaMs > 0).map(t => t.deltaMs);

// Sub-cause B cluster
const subBTracks = tracks.filter(t => t.isSubB);
const subBDeltas = subBTracks.map(t => t.deltaMs);
const subBStats = stats(subBDeltas);

// ── Part 2: Gate evaluation ──
// For a given gate predicate AND a candidate +offset, compute:
//   - selected: tracks matching gate
//   - TP: selected tracks that are FAIL AND become PASS after offset
//   - FP: selected tracks that are PASS AND become FAIL after offset
// Use harness 20ms tolerance for PASS/FAIL determination.
function evalGate(name, predicate, offsetMs) {
  const selected = tracks.filter(t => !t.error && predicate(t));
  let rescued = 0, regressed = 0;
  const rExamples = [], regExamples = [];
  for (const t of selected) {
    const newDelta = t.deltaMs + offsetMs; // adding +offset moves analyzer LATER
    const wasPass = Math.abs(t.deltaMs) <= HARNESS_TOL_MS;
    const becomesPass = Math.abs(newDelta) <= HARNESS_TOL_MS;
    if (!wasPass && becomesPass) {
      rescued++;
      if (rExamples.length < 6) rExamples.push(`${t.basename.slice(0, 40)} Δ ${t.deltaMs.toFixed(1)} → ${newDelta.toFixed(1)}`);
    }
    if (wasPass && !becomesPass) {
      regressed++;
      if (regExamples.length < 6) regExamples.push(`${t.basename.slice(0, 40)} Δ ${t.deltaMs.toFixed(1)} → ${newDelta.toFixed(1)}`);
    }
  }
  return { name, selected: selected.length, rescued, regressed, net: rescued - regressed, rExamples, regExamples };
}

// Compute the SubB cluster offset to apply (median Δ negated, since Δ is
// already negative and we want analyzer to move LATER to match truth)
const subBOffsetMs = -subBStats.median;
console.error(`Sub-cause B median Δ: ${subBStats.median}ms; applying offset +${subBOffsetMs.toFixed(1)}ms in gate tests`);

// Candidate gates — we sweep thresholds for each feature
const gates = [];

// Gate 1: high sub-bass ratio (Sub-cause B might correlate with deep house / sub-dominant tracks)
for (const thresh of [0.5, 1.0, 1.5, 2.0, 3.0, 5.0]) {
  gates.push(evalGate(`G1 subBassRatio ≥ ${thresh}`,
    t => (t.subBassRatio || 0) >= thresh, subBOffsetMs));
}

// Gate 2: slow attack ramp (Sub-cause B may have slow kicks)
for (const thresh of [3, 5, 8, 12, 18, 25]) {
  gates.push(evalGate(`G2 attackRampMs ≥ ${thresh}`,
    t => (t.attackRampMs || 0) >= thresh, subBOffsetMs));
}

// Gate 3: high first-kick amplitude (truly a kick, not pre-roll)
for (const thresh of [1.0, 2.0, 5.0, 10.0]) {
  gates.push(evalGate(`G3 firstKickAmpRatio ≥ ${thresh}`,
    t => (t.firstKickAmpRatio || 0) >= thresh, subBOffsetMs));
}

// Gate 4: low attackSlope (gentle attack)
const attackSlopeVals = tracks.filter(t => !t.error).map(t => t.attackSlope).sort((a, b) => a - b);
const aS_p25 = attackSlopeVals[Math.floor(attackSlopeVals.length * 0.25)];
const aS_p50 = attackSlopeVals[Math.floor(attackSlopeVals.length * 0.50)];
const aS_p75 = attackSlopeVals[Math.floor(attackSlopeVals.length * 0.75)];
for (const [label, thresh] of [["p25", aS_p25], ["p50", aS_p50], ["p75", aS_p75]]) {
  gates.push(evalGate(`G4 attackSlope ≤ ${label} (${thresh.toExponential(2)})`,
    t => (t.attackSlope || 0) <= thresh, subBOffsetMs));
}

// Gate 5: combinations
gates.push(evalGate("G5 subBassRatio≥1.5 AND attackRampMs≥5",
  t => (t.subBassRatio || 0) >= 1.5 && (t.attackRampMs || 0) >= 5, subBOffsetMs));
gates.push(evalGate("G5b subBassRatio≥1.0 AND attackRampMs≥3",
  t => (t.subBassRatio || 0) >= 1.0 && (t.attackRampMs || 0) >= 3, subBOffsetMs));

// ── Build the report ──
const report = [];
report.push("# Cluster-Offset Diagnostic — Results\n");
report.push("Investigation: is the Sub-cause B drift a fixed-offset correctable bias?");
report.push("Measured per-track Δ = analyzer_bar1 − Rekordbox_truth across all 272 tracks");
report.push("(snapshot: `fix-D.json`, current 73.2% PASS rate). Bucketed by status; then");
report.push("evaluated whether a signal-gated +offset could rescue Sub-cause B without");
report.push("regressing currently-passing tracks.");
report.push("");
report.push("PASS tolerance throughout: ±20 ms (harness standard).");
report.push("");

// Part 1
report.push("## Part 1 — Δ distribution\n");

report.push("### Bucket 1 — Currently PASSING tracks");
report.push("```");
report.push(`  n = ${passStats.n}`);
report.push(`  mean Δ:   ${passStats.mean} ms     (sign: ${passStats.mean < 0 ? "EARLY" : passStats.mean > 0 ? "LATE" : "centered"})`);
report.push(`  median Δ: ${passStats.median} ms`);
report.push(`  stdev:    ${passStats.stdev} ms`);
report.push(`  range:    [${passStats.min}, ${passStats.max}] ms`);
report.push("");
report.push("Histogram (5ms bins):");
report.push(histLines(passDeltas, 5, -25, 25));
report.push("```\n");

report.push("### Bucket 2 — Currently FAILING tracks");
report.push("Split into bounded-Δ (single-beat drift, |Δ| < 100 ms) and off-by-N-beats (|Δ| ≥ 100).");
report.push("");
report.push("**2a — Bounded FAIL (likely fixable by small offset)**");
report.push("```");
const bs = stats(failBoundedDeltas);
report.push(`  n = ${bs.n}`);
report.push(`  mean Δ:   ${bs.mean} ms`);
report.push(`  median Δ: ${bs.median} ms`);
report.push(`  stdev:    ${bs.stdev} ms`);
report.push(`  range:    [${bs.min}, ${bs.max}] ms`);
report.push("");
report.push("Histogram (5ms bins):");
report.push(histLines(failBoundedDeltas, 5, -50, 100));
report.push("");
report.push("  Sub-split by direction:");
const earlyStats = stats(failBoundedEarly);
const lateStats = stats(failBoundedLate);
report.push(`    EARLY (Δ<0): n=${earlyStats.n}, mean ${earlyStats.mean}, median ${earlyStats.median}, stdev ${earlyStats.stdev}`);
report.push(`    LATE  (Δ>0): n=${lateStats.n}, mean ${lateStats.mean}, median ${lateStats.median}, stdev ${lateStats.stdev}`);
report.push("```\n");

report.push("**2b — Off-by-N-beats FAIL (|Δ| ≥ 100ms, not addressable by small offset)**");
report.push("```");
const offStats = stats(failOffNDeltas);
report.push(`  n = ${offStats.n}`);
report.push(`  median Δ: ${offStats.median} ms`);
report.push(`  range:    [${offStats.min}, ${offStats.max}] ms`);
report.push("```\n");

report.push("### Bucket 3 — 13 Sub-cause B cluster (per-track)");
report.push("```");
report.push("Track                                       truth   ana_bar1   Δ (ms)");
report.push("------------------------------------------- ------- --------- -------");
for (const t of subBTracks) {
  report.push(t.basename.slice(0, 43).padEnd(43) + " " + t.truthMs.toFixed(1).padStart(7) + " " + t.anaMs.toFixed(1).padStart(9) + " " + t.deltaMs.toFixed(2).padStart(7));
}
report.push("");
report.push(`  n = ${subBStats.n}`);
report.push(`  mean Δ:   ${subBStats.mean} ms`);
report.push(`  median Δ: ${subBStats.median} ms`);
report.push(`  stdev:    ${subBStats.stdev} ms     ← key: < 5 = constant; 5-15 = bucketable; > 15 = noise`);
report.push(`  range:    [${subBStats.min}, ${subBStats.max}] ms`);
report.push("```\n");

// Part 2
report.push("## Part 2 — Conditional offset gate evaluation\n");
report.push(`Applying offset = +${subBOffsetMs.toFixed(1)} ms (negated Sub-cause B median) to tracks selected by each gate.`);
report.push("Rescue = was FAIL, becomes PASS (|new Δ| ≤ 20ms). Regression = was PASS, becomes FAIL.");
report.push("");
report.push("Feature stats across the 272-track dataset:");
const featGroups = [["attackSlope", t => t.attackSlope], ["subBassRatio", t => t.subBassRatio], ["attackRampMs", t => t.attackRampMs], ["firstKickAmpRatio", t => t.firstKickAmpRatio]];
report.push("```");
for (const [name, fn] of featGroups) {
  const all = tracks.filter(t => !t.error && fn(t) != null).map(fn);
  const subB = subBTracks.filter(t => !t.error && fn(t) != null).map(fn);
  const aS = stats(all);
  const bS = stats(subB);
  report.push(`  ${name.padEnd(20)} all:   median ${String(aS.median).padStart(8)}  stdev ${String(aS.stdev).padStart(8)}`);
  report.push(`  ${" ".repeat(20)} subB:  median ${String(bS.median).padStart(8)}  stdev ${String(bS.stdev).padStart(8)}`);
}
report.push("```\n");

report.push("Gate results:");
report.push("```");
report.push("Gate                                          selected  rescued  regressed   net");
report.push("--------------------------------------------- --------  -------  ---------   ----");
for (const g of gates) {
  report.push(g.name.padEnd(45) + "    " + String(g.selected).padStart(4) + "      " + String(g.rescued).padStart(3) + "         " + String(g.regressed).padStart(3) + "      " + (g.net >= 0 ? "+" + g.net : g.net));
}
report.push("```\n");

// Find best gate
gates.sort((a, b) => b.net - a.net);
const best = gates[0];
report.push(`### Best gate: ${best.name}`);
report.push(`  selected=${best.selected}, rescued=${best.rescued}, regressed=${best.regressed}, net=${best.net >= 0 ? "+" : ""}${best.net}`);
if (best.rExamples.length) {
  report.push("  rescues:");
  for (const ex of best.rExamples) report.push("    " + ex);
}
if (best.regExamples.length) {
  report.push("  regressions:");
  for (const ex of best.regExamples) report.push("    " + ex);
}
report.push("");

// Write report
writeFileSync(resolve(__dirname, "CLUSTER_OFFSET_RESULT.md"), report.join("\n"));
writeFileSync(resolve(__dirname, "cluster_offset_data.json"), JSON.stringify({ tracks, gates }, null, 2));
console.error(`\nResults written to CLUSTER_OFFSET_RESULT.md and cluster_offset_data.json`);
console.error(`Run-time: ${((Date.now() - startTime) / 1000).toFixed(0)}s`);
