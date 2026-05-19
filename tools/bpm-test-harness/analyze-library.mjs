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

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import decodeAudio from "audio-decode";
import { WORKER_SRC } from "../../src/bpm-worker-source.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = resolve(__dirname, "snapshots");

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
if (!MANIFEST_PATH) {
  console.error("Usage: node analyze-library.mjs --manifest <path> [--save <name>] [--limit N]");
  process.exit(2);
}

// ── Worker shim (same pattern as analyze.mjs) ────────────────────────────
function runWorker(cd, sr, id) {
  let captured = null;
  const self = { onmessage: null, postMessage: (r) => { captured = r; } };
  const origLog = console.log;
  console.log = () => {}; // suppress worker [phase] chatter at scale
  try {
    new Function("self", WORKER_SRC)(self);
    self.onmessage({ data: { cd, sr, id } });
  } finally {
    console.log = origLog;
  }
  return captured;
}

// ── Load manifest ────────────────────────────────────────────────────────
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
let tracks = manifest.tracks || [];
if (LIMIT > 0) tracks = tracks.slice(0, LIMIT);
console.log(`Manifest: ${tracks.length} tracks (source: ${manifest.source || "unknown"})`);

// ── Per-track analysis ───────────────────────────────────────────────────
const results = [];
const startTime = Date.now();
let lastReport = startTime;
let decodeFailures = 0;
let workerFailures = 0;

for (let i = 0; i < tracks.length; i++) {
  const t = tracks[i];
  let buf;
  try {
    buf = await decodeAudio(readFileSync(t.path));
  } catch (e) {
    results.push({ ...t, status: "DECODE_FAIL", error: e.message });
    decodeFailures++;
    continue;
  }
  const sr = buf.sampleRate;
  const cd = buf.channelData;
  if (!Array.isArray(cd) || !(cd[0] instanceof Float32Array)) {
    results.push({ ...t, status: "DECODE_FAIL", error: "no channelData" });
    decodeFailures++;
    continue;
  }

  let r;
  try {
    r = runWorker(cd, sr, t.basename);
  } catch (e) {
    results.push({ ...t, status: "WORKER_FAIL", error: e.message });
    workerFailures++;
    continue;
  }

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
  results.push({
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
  });

  // Progress every 1s
  const now = Date.now();
  if (now - lastReport > 1000 || i === tracks.length - 1) {
    const done = i + 1;
    const elapsed = (now - startTime) / 1000;
    const rate = done / elapsed;
    const eta = (tracks.length - done) / rate;
    process.stderr.write(`\r  [${done}/${tracks.length}] ${rate.toFixed(1)}/s  elapsed=${elapsed.toFixed(0)}s  eta=${eta.toFixed(0)}s   `);
    lastReport = now;
  }
}
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
