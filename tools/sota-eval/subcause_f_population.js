// subcause_f_population.js — population scan for the Sub-cause F signature
// across all 272 harness tracks. Identifies tracks where beat 0 has weak
// kick energy relative to the track's other beats (= analyzer anchored bar-1
// to a no-kick position).
//
// Sub-cause F signature (per task spec):
//   - beat 0 attackSlope is in the bottom 10% of the track's beat slopes
//   - AND beat 1 attackSlope is substantially higher (> track median)
//
// Per matched track, also simulates: what happens to its Δ if we shift bar-1
// forward by 1 beat? Reports flip counts (FAIL→PASS rescue / PASS→FAIL regress).

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = resolve(__dirname, "..", "bpm-test-harness");
const SNAPSHOT = JSON.parse(readFileSync(resolve(HARNESS_DIR, "snapshots", "fix-D.json"), "utf8"));
const N_BEATS = 30; // probe first 30 beats
const HARNESS_TOL_MS = 20;

const graded = SNAPSHOT.results.filter(r => r.status === "PASS" || r.status === "FAIL");
const results = new Array(graded.length).fill(null);

const N_WORKERS = Math.min(os.cpus().length, 8);
const startTime = Date.now();
let nextIdx = 0, completed = 0;
console.error(`Probing ${N_BEATS} beat slopes on ${graded.length} tracks (parallel x${N_WORKERS})...`);

await new Promise((resolveAll) => {
  const workers = [];
  let ready = 0;
  function dispatch(w) {
    if (nextIdx >= graded.length) { w.postMessage({ type: "shutdown" }); return; }
    const i = nextIdx++;
    const r = graded[i];
    w.postMessage({
      idx: i,
      path: r.path,
      bar1Sec: r.analyzerFirstDownbeatSec || 0,
      periodSec: r.beatPeriodSec || 0,
      nBeats: N_BEATS,
    });
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
      if (completed % 25 === 0 || completed === graded.length) {
        process.stderr.write(`\r  [${completed}/${graded.length}] ${((Date.now() - startTime)/1000).toFixed(0)}s   `);
      }
      if (completed === graded.length) {
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

// ── Compute Sub-cause F signature per track ──
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length * p)];
}

const enriched = graded.map((r, i) => {
  const slopes = (results[i]?.slopes || []).filter(x => x != null && x > 0);
  const beat0 = (results[i]?.slopes || [])[0];
  const beat1 = (results[i]?.slopes || [])[1];
  const truthMs = r.truthFirstDownbeatSec * 1000;
  const anaMs = (r.analyzerFirstDownbeatSec ?? 0) * 1000;
  const periodMs = (r.beatPeriodSec || 0) * 1000;
  return {
    basename: r.basename,
    path: r.path,
    status: r.status,
    bpm: r.analyzerBpm,
    truthMs,
    anaMs,
    deltaMs: anaMs - truthMs,
    periodMs,
    durSec: results[i]?.durSec,
    beat0Slope: beat0,
    beat1Slope: beat1,
    trackMedianSlope: median(slopes),
    trackP10Slope: percentile(slopes, 0.10),
    nValidSlopes: slopes.length,
  };
});

// ── Apply Sub-cause F gate ──
// Per task spec: beat 0 < trackP10 AND beat 1 > trackMedian.
// "Substantially higher" = above the track's median.
const subFCandidates = enriched.filter(t => {
  if (t.beat0Slope == null || t.beat1Slope == null) return false;
  if (t.nValidSlopes < 8) return false; // need enough valid beats
  return t.beat0Slope < t.trackP10Slope && t.beat1Slope > t.trackMedianSlope;
});

// ── Simulate 1-beat shift impact on each candidate ──
// New Δ = (anaMs + periodMs) - truthMs = deltaMs + periodMs
// PASS if |new Δ| ≤ 20ms
let rescue = 0, regress = 0;
let stillPass = 0, stillFail = 0;
const rescueList = [], regressList = [];
for (const t of subFCandidates) {
  const newDelta = t.deltaMs + t.periodMs;
  // Also consider equivalence mod period for off-by-N-beats tracks
  const wasPass = Math.abs(t.deltaMs) <= HARNESS_TOL_MS;
  const willPass = Math.abs(newDelta) <= HARNESS_TOL_MS;
  if (wasPass && willPass) stillPass++;
  else if (!wasPass && !willPass) stillFail++;
  else if (!wasPass && willPass) { rescue++; rescueList.push({ ...t, newDelta }); }
  else if (wasPass && !willPass) { regress++; regressList.push({ ...t, newDelta }); }
}

// ── Build report ──
const lines = [];
lines.push("# Sub-cause F population scan\n");
lines.push("Signature: beat 0 attackSlope is in the bottom 10% of the track's beat slopes,");
lines.push("AND beat 1 attackSlope is above the track median.");
lines.push("Probed " + N_BEATS + " beats per track (~12-15 seconds of audio at 120-150 BPM).");
lines.push("");

lines.push("## Population stats");
lines.push("```");
lines.push("  Tracks probed:                  " + graded.length);
lines.push("  Tracks with ≥8 valid slopes:    " + enriched.filter(t => t.nValidSlopes >= 8).length);
lines.push("  Sub-cause F candidates:         " + subFCandidates.length);
lines.push("```");

lines.push("\n## Candidate tracks (matching signature)");
lines.push("```");
lines.push("Track                                         truth    ana_bar1   slope[0]    slope[1]   p10/med ratio  status  Δ");
lines.push("--------------------------------------------- -------- --------- ---------- ----------  ------------- ------  --------");
const sortedCands = [...subFCandidates].sort((a, b) => a.beat0Slope - b.beat0Slope);
for (const t of sortedCands) {
  const ratio = t.trackMedianSlope > 0 ? (t.beat0Slope / t.trackMedianSlope).toFixed(2) : "—";
  lines.push(
    t.basename.slice(0, 45).padEnd(46) + " " +
    t.truthMs.toFixed(0).padStart(7) + "  " +
    t.anaMs.toFixed(1).padStart(8) + "  " +
    t.beat0Slope.toExponential(2).padStart(10) + " " +
    t.beat1Slope.toExponential(2).padStart(10) + "  " +
    ratio.padStart(13) + "  " +
    t.status.padStart(6) + "  " +
    (t.deltaMs >= 0 ? "+" : "") + t.deltaMs.toFixed(1)
  );
}
lines.push("```");

lines.push("\n## If we shifted bar-1 forward by 1 beat on every candidate:");
lines.push("```");
lines.push("  Rescued (FAIL → PASS):      " + rescue);
lines.push("  Regressed (PASS → FAIL):    " + regress);
lines.push("  Net:                        " + (rescue - regress >= 0 ? "+" : "") + (rescue - regress));
lines.push("  Still PASS after shift:     " + stillPass);
lines.push("  Still FAIL after shift:     " + stillFail);
lines.push("```");

lines.push("\n### Rescued tracks");
lines.push("```");
for (const t of rescueList) {
  lines.push("  " + t.basename.slice(0, 50).padEnd(51) + "  Δ " + t.deltaMs.toFixed(1).padStart(7) + " → " + t.newDelta.toFixed(1).padStart(6));
}
lines.push("```");

lines.push("\n### Regressed tracks");
lines.push("```");
for (const t of regressList) {
  lines.push("  " + t.basename.slice(0, 50).padEnd(51) + "  Δ " + t.deltaMs.toFixed(1).padStart(7) + " → " + t.newDelta.toFixed(1).padStart(6));
}
lines.push("```");

// ── Cross-reference: Sub-cause B cluster ──
const SUB_B = ["Body Stars", "Scarlet Sails", "Aurora", "Coaster", "Leave the World", "Serenità", "Fly Fox", "Great Attractor", "Astronauts", "Finding Estrella", "Swans", "Sparky", "Track II"];
function isSubB(name) { return SUB_B.some(s => name.toLowerCase().includes(s.toLowerCase())); }
const subBCands = subFCandidates.filter(t => isSubB(t.basename));
lines.push("\n## Overlap with the 13 known Sub-cause B tracks");
lines.push("```");
lines.push("Sub-cause B tracks also matching Sub-cause F signature: " + subBCands.length + " / 13");
for (const t of subBCands) {
  lines.push("  " + t.basename.slice(0, 48).padEnd(49) + "  slope[0]=" + t.beat0Slope.toExponential(2) + "  slope[1]=" + t.beat1Slope.toExponential(2));
}
lines.push("```");

writeFileSync(resolve(__dirname, "SUBCAUSE_F_POPULATION.md"), lines.join("\n"));
writeFileSync(resolve(__dirname, "subcause_f_data.json"), JSON.stringify({ enriched, subFCandidates, rescueList, regressList }, null, 2));
console.error("Wrote SUBCAUSE_F_POPULATION.md (" + subFCandidates.length + " candidates, +" + rescue + "/-" + regress + " net)");
