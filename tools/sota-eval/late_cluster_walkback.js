// late_cluster_walkback.js — simulate "walk back from analyzer bar-1 to
// earliest substantial transient within W ms" rule across the 272-track
// harness. Test thresholds + gate combinations to see if any produces a
// net-positive Sub-cause G fix.
//
// For each track, we already have beatAttackSlopes from the subcause_f
// data. But that array contains beat 0 attackSlope computed in the same
// way as the production refinement. The "walk back within current beat 0"
// would need a finer-grained pass — for each candidate, look at the
// per-sample dE/dt within ana ± 50ms and find earliest local max above
// THRESH_FRAC × global max.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = resolve(__dirname, "..", "bpm-test-harness");
const SNAPSHOT = JSON.parse(readFileSync(resolve(HARNESS_DIR, "snapshots", "fix-F2.json"), "utf8"));
const HARNESS_TOL_MS = 20;

const graded = SNAPSHOT.results.filter(r => r.status === "PASS" || r.status === "FAIL");
const probeResults = new Array(graded.length).fill(null);
const startTime = Date.now();
let nextIdx = 0, completed = 0;
const N_WORKERS = Math.min(os.cpus().length, 8);

await new Promise((resolveAll) => {
  const workers = [];
  let ready = 0;
  function dispatch(w) {
    if (nextIdx >= graded.length) { w.postMessage({ type: "shutdown" }); return; }
    const i = nextIdx++;
    const r = graded[i];
    w.postMessage({ idx: i, path: r.path, anaSec: r.analyzerFirstDownbeatSec || 0 });
  }
  for (let i = 0; i < N_WORKERS; i++) {
    const w = new Worker(resolve(__dirname, "late_walkback_worker.mjs"));
    workers.push(w);
    w.on("message", (m) => {
      if (m.type === "ready") {
        ready++;
        if (ready === N_WORKERS) for (const w2 of workers) dispatch(w2);
        return;
      }
      probeResults[m.idx] = m;
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

// ── For each track, simulate walkback at various thresholds ──
function simulate(thresholdFrac, minWalkbackMs) {
  let rescue = 0, regress = 0;
  const rList = [], regList = [];
  for (let i = 0; i < graded.length; i++) {
    const r = graded[i];
    const probe = probeResults[i];
    if (!probe || probe.error) continue;
    const truthMs = r.truthFirstDownbeatSec * 1000;
    const anaMs = (r.analyzerFirstDownbeatSec || 0) * 1000;
    const wasPass = Math.abs(anaMs - truthMs) <= HARNESS_TOL_MS;
    // Earliest peak with slope >= thresholdFrac * global max in window
    let earliestI = -1;
    if (probe.slopes && probe.slopes.length > 0) {
      const maxSlope = Math.max(...probe.slopes);
      const thresh = maxSlope * thresholdFrac;
      for (let k = 0; k < probe.slopes.length; k++) {
        if (probe.slopes[k] >= thresh) { earliestI = k; break; }
      }
    }
    if (earliestI < 0) continue;
    const newMs = anaMs + (probe.offsetMs[earliestI] || 0);
    const walkbackMs = anaMs - newMs;
    if (walkbackMs < minWalkbackMs) continue;
    const willPass = Math.abs(newMs - truthMs) <= HARNESS_TOL_MS;
    if (!wasPass && willPass) { rescue++; rList.push({ basename: r.basename, anaMs, truthMs, newMs, walkbackMs }); }
    if (wasPass && !willPass) { regress++; regList.push({ basename: r.basename, anaMs, truthMs, newMs, walkbackMs }); }
  }
  return { rescue, regress, net: rescue - regress, rList, regList };
}

const sweeps = [];
for (const tf of [0.30, 0.50, 0.70, 0.90]) {
  for (const minW of [5, 10, 15, 20, 25, 30, 40]) {
    const r = simulate(tf, minW);
    sweeps.push({ tf, minW, ...r });
  }
}
console.log("Walk-back simulation (rescue/regress/net per gate):");
console.log("THRESH_FRAC  minWalkback   rescue  regress   net");
for (const s of sweeps) {
  console.log("  " + s.tf.toFixed(2) + "       >=" + s.minW + "ms     " + String(s.rescue).padStart(4) + "    " + String(s.regress).padStart(4) + "    " + (s.net >= 0 ? "+" : "") + s.net);
}

// Best gate
sweeps.sort((a, b) => b.net - a.net);
const best = sweeps[0];
console.log("");
console.log("=== Best gate ===");
console.log("THRESH_FRAC=" + best.tf + ", minWalkbackMs=" + best.minW);
console.log("rescue=" + best.rescue + ", regress=" + best.regress + ", net=" + best.net);
console.log("Rescues:");
for (const r of best.rList) console.log("  " + r.basename.slice(0, 55).padEnd(56) + " ana " + r.anaMs.toFixed(1) + " → " + r.newMs.toFixed(1) + " (walked back " + r.walkbackMs.toFixed(1) + "ms, truth " + r.truthMs.toFixed(1) + ")");
console.log("Regressions:");
for (const r of best.regList) console.log("  " + r.basename.slice(0, 55).padEnd(56) + " ana " + r.anaMs.toFixed(1) + " → " + r.newMs.toFixed(1) + " (walked back " + r.walkbackMs.toFixed(1) + "ms, truth " + r.truthMs.toFixed(1) + ")");

writeFileSync(resolve(__dirname, "late_cluster_walkback_data.json"), JSON.stringify({ sweeps, best }, null, 2));
