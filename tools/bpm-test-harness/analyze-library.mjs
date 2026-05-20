// analyze-library.mjs — full-library validation against a Rekordbox-derived
// manifest. Unlike analyze.mjs (small-corpus iteration), this is the
// once-run, comprehensive accuracy report:
//
//   node analyze-library.mjs --manifest library-truth.json
//
// Per-track: decode the original-path mp3, run WORKER_SRC, compare to
// Rekordbox-truth bpm + firstDownbeatSec.
//
// Output: stats summary on stderr (progress) + stdout (final report),
// per-track snapshot at snapshots/baseline-full.json for regression
// comparison via analyze.mjs --compare baseline-full later.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = resolve(__dirname, "snapshots");
const WORKER_PATH = resolve(__dirname, "analyze-worker.mjs");

const TOLERANCE_BPM = 0.5;
const TOLERANCE_DOWNBEAT_MS = 20;

// ── CLI ──────────────────────────────────────────────────────────────────
function arg(flag, def = null) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i < process.argv.length - 1 ? process.argv[i + 1] : def;
}
const MANIFEST_PATH = arg("--manifest");
const SNAPSHOT_NAME = arg("--save", "baseline-full");
const LIMIT = parseInt(arg("--limit", "0"), 10) || 0;
const N_WORKERS = parseInt(arg("--workers", "0"), 10) || Math.min(os.cpus().length, 8);
if (!MANIFEST_PATH) {
  console.error("Usage: node analyze-library.mjs --manifest <path> [--save <name>] [--limit N] [--workers N]");
  process.exit(2);
}

// ── Load manifest ────────────────────────────────────────────────────────
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
let tracks = manifest.tracks || [];
if (LIMIT > 0) tracks = tracks.slice(0, LIMIT);
console.log(`Manifest: ${tracks.length} tracks (source: ${manifest.source || "unknown"})`);
console.log(`Worker pool: ${N_WORKERS} threads`);

// ── Per-track scoring (kept identical to sequential version) ─────────────
function buildRow(t, r) {
  const aFirstDb = r.beatPhaseFrac != null && r.beatPeriodSec != null
    ? r.beatPhaseFrac * r.beatPeriodSec
    : null;
  const deltaBpm = r.bpm == null ? Infinity : Math.abs(r.bpm - t.bpm);
  const deltaDbSec = aFirstDb == null ? Infinity : Math.abs(aFirstDb - t.firstDownbeatSec);
  const deltaDbMs = deltaDbSec * 1000;
  const offsetBeats = r.beatPeriodSec > 0
    ? Math.round((aFirstDb - t.firstDownbeatSec) / r.beatPeriodSec)
    : null;
  const passed = deltaBpm <= TOLERANCE_BPM && deltaDbMs <= TOLERANCE_DOWNBEAT_MS;
  return {
    path: t.path,
    basename: t.basename,
    truthBpm: t.bpm,
    truthFirstDownbeatSec: t.firstDownbeatSec,
    analyzerBpm: r.bpm,
    analyzerFirstDownbeatSec: aFirstDb,
    beatPeriodSec: r.beatPeriodSec,
    deltaBpm,
    deltaDownbeatMs: deltaDbMs,
    offsetBeats,
    status: passed ? "PASS" : "FAIL",
    decision: r.phase ? r.phase.decision : null,
    bestPh: r.phase ? r.phase.bestPh : null,
    snapped: r.snapped,
    rekordboxNotes: t.notes || null,
  };
}

// ── Worker-pool dispatch ─────────────────────────────────────────────────
const results = new Array(tracks.length);
const startTime = Date.now();
let lastReport = startTime;
let decodeFailures = 0;
let workerFailures = 0;
let completed = 0;
let nextIdx = 0;

await new Promise((resolveAll) => {
  const workers = [];
  let readyCount = 0;

  function dispatch(worker) {
    if (nextIdx >= tracks.length) {
      worker.postMessage({ type: "shutdown" });
      return false;
    }
    const i = nextIdx++;
    worker.postMessage({ idx: i, path: tracks[i].path, basename: tracks[i].basename });
    return true;
  }

  function progressTick() {
    const now = Date.now();
    if (now - lastReport > 1000 || completed === tracks.length) {
      const elapsed = (now - startTime) / 1000;
      const rate = completed / Math.max(0.001, elapsed);
      const eta = rate > 0 ? (tracks.length - completed) / rate : 0;
      process.stderr.write(`\r  [${completed}/${tracks.length}] ${rate.toFixed(1)}/s  elapsed=${elapsed.toFixed(0)}s  eta=${eta.toFixed(0)}s   `);
      lastReport = now;
    }
  }

  for (let w = 0; w < N_WORKERS; w++) {
    const worker = new Worker(WORKER_PATH);
    workers.push(worker);

    worker.on("message", (msg) => {
      if (msg.type === "ready") {
        readyCount++;
        if (readyCount === N_WORKERS) {
          // All workers ready — kick off initial dispatch
          for (const w2 of workers) dispatch(w2);
        }
        return;
      }
      const t = tracks[msg.idx];
      if (msg.decodeError) {
        results[msg.idx] = { ...t, status: "DECODE_FAIL", error: msg.decodeError };
        decodeFailures++;
      } else if (msg.workerError) {
        results[msg.idx] = { ...t, status: "WORKER_FAIL", error: msg.workerError };
        workerFailures++;
      } else {
        results[msg.idx] = buildRow(t, msg.result);
      }
      completed++;
      progressTick();
      if (completed === tracks.length) {
        for (const w2 of workers) w2.postMessage({ type: "shutdown" });
        resolveAll();
      } else {
        dispatch(worker);
      }
    });

    worker.on("error", (err) => {
      console.error("\nWorker thread error:", err);
    });
  }
});
process.stderr.write("\n");

// ── Aggregate ────────────────────────────────────────────────────────────
const graded = results.filter(r => r.status === "PASS" || r.status === "FAIL");
const pass = graded.filter(r => r.status === "PASS").length;
const fail = graded.length - pass;
const total = graded.length;
const accuracy = total > 0 ? (pass / total) * 100 : 0;

// Offset histogram (only on graded FAILs to understand the shape)
const offsetHist = new Map();
for (const r of graded) {
  const k = r.offsetBeats == null ? "null" : Math.abs(r.offsetBeats) > 4 ? "other" : String(r.offsetBeats);
  offsetHist.set(k, (offsetHist.get(k) || 0) + 1);
}

// BPM delta buckets
const bpmHist = { exact: 0, leqHalf: 0, halfToOne: 0, gtOne: 0, null: 0 };
for (const r of graded) {
  if (r.deltaBpm == null || !isFinite(r.deltaBpm)) bpmHist.null++;
  else if (r.deltaBpm === 0) bpmHist.exact++;
  else if (r.deltaBpm <= 0.5) bpmHist.leqHalf++;
  else if (r.deltaBpm <= 1.0) bpmHist.halfToOne++;
  else bpmHist.gtOne++;
}

// Decision-tree branch firing
const decisionHist = new Map();
for (const r of graded) {
  if (!r.decision) continue;
  // Normalize the decision string by stripping the "→ N" / "(...)" suffixes
  const branch = r.decision
    .replace(/→ \d+/g, "")
    .replace(/\([^)]+\)/g, "")
    .replace(/\d+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  decisionHist.set(branch, (decisionHist.get(branch) || 0) + 1);
}

// Top 20 worst FAILs by deltaDownbeatMs
const worstFails = graded
  .filter(r => r.status === "FAIL" && isFinite(r.deltaDownbeatMs))
  .sort((a, b) => b.deltaDownbeatMs - a.deltaDownbeatMs)
  .slice(0, 20);

// ── Report ───────────────────────────────────────────────────────────────
function fmt(n, d = 1) { return n == null ? "—" : Number(n).toFixed(d); }
function pct(n, total) { return total === 0 ? "0%" : ((n / total) * 100).toFixed(1) + "%"; }

console.log("");
console.log("═".repeat(78));
console.log("FULL-LIBRARY VALIDATION REPORT");
console.log("═".repeat(78));
console.log(`  Tracks in manifest:     ${tracks.length}`);
console.log(`  Decode failures:        ${decodeFailures}`);
console.log(`  Worker failures:        ${workerFailures}`);
console.log(`  Graded:                 ${total}`);
console.log(`  Tolerance:              Δbpm ≤ ${TOLERANCE_BPM}, Δfirstdownbeat ≤ ${TOLERANCE_DOWNBEAT_MS}ms`);
console.log("");
console.log(`  PASS:  ${pass} / ${total}  (${accuracy.toFixed(1)}%)`);
console.log(`  FAIL:  ${fail} / ${total}  (${pct(fail, total)})`);
console.log("");

console.log("Offset-from-truth distribution (round((analyzer - truth) / beatPeriod)):");
const offsetKeys = ["0", "-1", "1", "-2", "2", "-3", "3", "-4", "4", "other", "null"];
for (const k of offsetKeys) {
  const v = offsetHist.get(k) || 0;
  if (v === 0) continue;
  const bar = "█".repeat(Math.min(60, Math.round(v / total * 200)));
  const lbl = k === "0" ? "  ✓ on-grid (0)" : k === "null" ? "  null (no period)" : `  off by ${k.padStart(3)}`;
  console.log(`${lbl}: ${String(v).padStart(5)}  (${pct(v, total).padStart(6)})  ${bar}`);
}
console.log("");

console.log("BPM accuracy:");
console.log(`  exact (Δ=0):     ${bpmHist.exact} (${pct(bpmHist.exact, total)})`);
console.log(`  Δ ≤ 0.5 BPM:     ${bpmHist.leqHalf} (${pct(bpmHist.leqHalf, total)})`);
console.log(`  0.5 < Δ ≤ 1.0:   ${bpmHist.halfToOne} (${pct(bpmHist.halfToOne, total)})`);
console.log(`  Δ > 1.0 BPM:     ${bpmHist.gtOne} (${pct(bpmHist.gtOne, total)})`);
console.log("");

console.log("Decision-tree branch firing:");
const sortedDecisions = [...decisionHist.entries()].sort((a, b) => b[1] - a[1]);
for (const [k, v] of sortedDecisions) {
  console.log(`  ${k.padEnd(45)} ${String(v).padStart(5)}  (${pct(v, total).padStart(6)})`);
}
console.log("");

console.log(`Top ${worstFails.length} worst Δdownbeat tracks (manual inspection candidates):`);
for (const r of worstFails) {
  const name = r.basename.length > 56 ? r.basename.substring(0, 53) + "..." : r.basename.padEnd(56);
  const offTag = r.offsetBeats == null ? "  ?" : Math.abs(r.offsetBeats) <= 4 ? `${r.offsetBeats > 0 ? "+" : ""}${r.offsetBeats}β` : "X";
  const noteTag = r.rekordboxNotes ? " ⚠" : "";
  console.log(`  Δfd=${String(Math.round(r.deltaDownbeatMs)).padStart(5)}ms ${offTag.padStart(4)}  ${name}${noteTag}`);
}
console.log("");

// ── Save snapshot ────────────────────────────────────────────────────────
mkdirSync(SNAPSHOT_DIR, { recursive: true });
const snapshotPath = resolve(SNAPSHOT_DIR, `${SNAPSHOT_NAME}.json`);
writeFileSync(snapshotPath, JSON.stringify({
  savedAt: new Date().toISOString(),
  manifest: { path: MANIFEST_PATH, source: manifest.source || null },
  tolerance: { bpm: TOLERANCE_BPM, downbeatMs: TOLERANCE_DOWNBEAT_MS },
  summary: {
    total, pass, fail, accuracy,
    decodeFailures, workerFailures,
    offsetHistogram: Object.fromEntries(offsetHist),
    bpmHistogram: bpmHist,
    decisionHistogram: Object.fromEntries(sortedDecisions),
  },
  results,
}, null, 2));
console.log(`Snapshot: ${snapshotPath}`);
console.log(`Run-time: ${((Date.now() - startTime) / 1000).toFixed(0)}s`);

process.exit(fail > 0 ? 1 : 0);
