// kick-in-probe.mjs — Investigation tool for the "structural drop" hypothesis.
//
// Hypothesis: Rekordbox anchors bar-1 to the first sustained kick-in after a
// kickless intro section, NOT the first audio transient.
//
// This script computes, for each track:
//   - truthSec       — Rekordbox firstDownbeatSec
//   - analyzerSec    — current analyzer output (from the parallel-full snapshot)
//   - firstTransSec  — first 40-100Hz onset of any size (current-style detection)
//   - kickInSec      — first sustained "kick-active" region after a kickless gap
//
// Pure investigation. No production code touched. Read-only.
//
// Usage:
//   node kick-in-probe.mjs --names "Body Stars,Hymn"        # 10-track mode
//   node kick-in-probe.mjs --all                            # full library
//   node kick-in-probe.mjs --all --json out.json            # save snapshot

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

function arg(flag, def = null) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i < process.argv.length - 1 ? process.argv[i + 1] : def;
}
const ALL = process.argv.includes("--all");
const NAMES = arg("--names", "");
const JSON_OUT = arg("--json", null);
const N_WORKERS = parseInt(arg("--workers", "0"), 10) || Math.min(os.cpus().length, 8);

// ── Load manifest + current analyzer snapshot ────────────────────────────
const manifest = JSON.parse(readFileSync(resolve(__dirname, "library-truth.json"), "utf8"));
const snapshot = JSON.parse(readFileSync(resolve(__dirname, "snapshots/parallel-full.json"), "utf8"));
const snapMap = new Map();
for (const r of snapshot.results) snapMap.set(r.path, r);

let tracks = manifest.tracks || [];
if (!ALL) {
  if (!NAMES) {
    console.error("Usage: node kick-in-probe.mjs --names \"<comma-substrings>\" | --all");
    process.exit(2);
  }
  const subs = NAMES.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  tracks = tracks.filter(t => subs.some(s => t.basename.toLowerCase().includes(s)));
  console.log(`Matched ${tracks.length} of ${manifest.tracks.length} tracks`);
}

// ── Worker-thread pool — each thread does decode + kick-in probe ─────────
const results = new Array(tracks.length);
const startTime = Date.now();
let nextIdx = 0;
let completed = 0;
let decodeFails = 0;

await new Promise((resolveAll) => {
  const workers = [];
  let readyCount = 0;

  function dispatch(worker) {
    if (nextIdx >= tracks.length) {
      worker.postMessage({ type: "shutdown" });
      return;
    }
    const i = nextIdx++;
    worker.postMessage({ idx: i, path: tracks[i].path, basename: tracks[i].basename });
  }

  for (let w = 0; w < N_WORKERS; w++) {
    const worker = new Worker(resolve(__dirname, "kick-in-worker.mjs"));
    workers.push(worker);

    worker.on("message", (msg) => {
      if (msg.type === "ready") {
        readyCount++;
        if (readyCount === N_WORKERS) {
          for (const w2 of workers) dispatch(w2);
        }
        return;
      }
      const t = tracks[msg.idx];
      const snap = snapMap.get(t.path) || {};
      if (msg.decodeError) {
        results[msg.idx] = {
          basename: t.basename,
          truthSec: t.firstDownbeatSec,
          analyzerSec: snap.analyzerFirstDownbeatSec ?? null,
          firstTransSec: null,
          kickInSec: null,
          kicklessIntroSec: null,
          error: msg.decodeError,
        };
        decodeFails++;
      } else {
        const p = msg.probe;
        results[msg.idx] = {
          basename: t.basename,
          path: t.path,
          truthSec: t.firstDownbeatSec,
          analyzerSec: snap.analyzerFirstDownbeatSec ?? null,
          analyzerStatus: snap.status ?? null,
          firstTransSec: p.firstTransSec,
          kickInSec: p.kickInSec,
          kicklessIntroSec: p.kicklessIntroSec,
          medianKickEnergy: p.medianKickEnergy,
          durSec: p.durSec,
        };
      }
      completed++;
      if (completed % 25 === 0 || completed === tracks.length) {
        process.stderr.write(`\r  [${completed}/${tracks.length}]   `);
      }
      if (completed === tracks.length) {
        for (const w2 of workers) w2.postMessage({ type: "shutdown" });
        resolveAll();
      } else {
        dispatch(worker);
      }
    });

    worker.on("error", (err) => console.error("\nWorker error:", err));
  }
});
process.stderr.write("\n");

// ── Reporting ────────────────────────────────────────────────────────────
function fmtMs(s) {
  if (s == null || !isFinite(s)) return "      —";
  return (s * 1000).toFixed(1).padStart(8);
}
function diffMs(a, b) {
  if (a == null || b == null) return "    —";
  const d = (a - b) * 1000;
  return (d >= 0 ? "+" : "") + d.toFixed(1);
}

// ── 10-track-style table ─────────────────────────────────────────────────
console.log("");
console.log("═".repeat(120));
console.log("KICK-IN PROBE — comparative table");
console.log("═".repeat(120));
console.log(
  "name".padEnd(46) +
    " " + "truth".padStart(8) +
    " " + "anlyz".padStart(8) +
    " " + "1stTr".padStart(8) +
    " " + "kickIn".padStart(8) +
    " " + "Δana".padStart(7) +
    " " + "Δ1Tr".padStart(7) +
    " " + "ΔkIn".padStart(7) +
    "  status"
);
console.log("─".repeat(120));

for (const r of results) {
  const name = (r.basename || "?").slice(0, 45).padEnd(46);
  console.log(
    name +
      " " + fmtMs(r.truthSec) +
      " " + fmtMs(r.analyzerSec) +
      " " + fmtMs(r.firstTransSec) +
      " " + fmtMs(r.kickInSec) +
      " " + diffMs(r.analyzerSec, r.truthSec).padStart(7) +
      " " + diffMs(r.firstTransSec, r.truthSec).padStart(7) +
      " " + diffMs(r.kickInSec, r.truthSec).padStart(7) +
      "  " + (r.analyzerStatus || (r.error ? "ERR" : "?"))
  );
}

// ── Full-library stats ───────────────────────────────────────────────────
if (ALL) {
  console.log("");
  console.log("═".repeat(78));
  console.log("FULL-LIBRARY STATS");
  console.log("═".repeat(78));

  const good = results.filter(r => r.kickInSec != null && r.truthSec != null);
  const intros = results.filter(r => (r.kicklessIntroSec || 0) > 0.5);
  console.log(`  Total tracks:                 ${results.length}`);
  console.log(`  Successfully probed:          ${good.length}`);
  console.log(`  Decode failures:              ${decodeFails}`);
  console.log(`  Tracks with kickless intro:   ${intros.length} (>0.5s of pre-kick silence)`);
  console.log(`  Tracks with NO kickless gap:  ${good.length - intros.length}`);
  console.log("");

  // Compare each method's absolute error to truth, modulo nearest beat (so off-by-N-beats doesn't dominate)
  // Use analyzer's beat period from snapshot to fold
  function deltaModBeat(time, truth, periodSec) {
    if (time == null || truth == null) return null;
    let d = time - truth;
    if (periodSec > 0) {
      while (d < -periodSec / 2) d += periodSec;
      while (d > periodSec / 2) d -= periodSec;
    }
    return Math.abs(d * 1000);
  }
  function deltaAbsRaw(time, truth) {
    if (time == null || truth == null) return null;
    return Math.abs((time - truth) * 1000);
  }

  let cnt = { ana20: 0, fT20: 0, kI20: 0 };
  let cntRaw = { ana20: 0, fT20: 0, kI20: 0 };
  const periodMap = new Map();
  for (const r of snapshot.results) periodMap.set(r.path, r.beatPeriodSec);

  for (const r of good) {
    const per = periodMap.get(r.path);
    const dAna = deltaModBeat(r.analyzerSec, r.truthSec, per);
    const dFt = deltaModBeat(r.firstTransSec, r.truthSec, per);
    const dKi = deltaModBeat(r.kickInSec, r.truthSec, per);
    if (dAna != null && dAna <= 20) cnt.ana20++;
    if (dFt != null && dFt <= 20) cnt.fT20++;
    if (dKi != null && dKi <= 20) cnt.kI20++;

    const dAnaR = deltaAbsRaw(r.analyzerSec, r.truthSec);
    const dFtR = deltaAbsRaw(r.firstTransSec, r.truthSec);
    const dKiR = deltaAbsRaw(r.kickInSec, r.truthSec);
    if (dAnaR != null && dAnaR <= 20) cntRaw.ana20++;
    if (dFtR != null && dFtR <= 20) cntRaw.fT20++;
    if (dKiR != null && dKiR <= 20) cntRaw.kI20++;
  }
  console.log("Within ±20ms of Rekordbox truth (modulo beat — like the 20ms tolerance):");
  console.log(`  current analyzer:   ${cnt.ana20}/${good.length}  (${(cnt.ana20 / good.length * 100).toFixed(1)}%)`);
  console.log(`  first-transient:    ${cnt.fT20}/${good.length}  (${(cnt.fT20 / good.length * 100).toFixed(1)}%)`);
  console.log(`  structural kick-in: ${cnt.kI20}/${good.length}  (${(cnt.kI20 / good.length * 100).toFixed(1)}%)`);
  console.log("");
  console.log("Within ±20ms RAW (no beat-folding — exact match):");
  console.log(`  current analyzer:   ${cntRaw.ana20}/${good.length}  (${(cntRaw.ana20 / good.length * 100).toFixed(1)}%)`);
  console.log(`  first-transient:    ${cntRaw.fT20}/${good.length}  (${(cntRaw.fT20 / good.length * 100).toFixed(1)}%)`);
  console.log(`  structural kick-in: ${cntRaw.kI20}/${good.length}  (${(cntRaw.kI20 / good.length * 100).toFixed(1)}%)`);

  // Cross-tab: on tracks where analyzer FAILs but kick-in is close, would kick-in help?
  const anaFails = good.filter(r => r.analyzerStatus === "FAIL");
  let kIRescues = 0, kIRegresses = 0, kIRescuesRaw = 0;
  for (const r of anaFails) {
    const per = periodMap.get(r.path);
    const dKi = deltaModBeat(r.kickInSec, r.truthSec, per);
    if (dKi != null && dKi <= 20) kIRescues++;
    const dKiR = deltaAbsRaw(r.kickInSec, r.truthSec);
    if (dKiR != null && dKiR <= 20) kIRescuesRaw++;
  }
  const anaPasses = good.filter(r => r.analyzerStatus === "PASS");
  for (const r of anaPasses) {
    const per = periodMap.get(r.path);
    const dKi = deltaModBeat(r.kickInSec, r.truthSec, per);
    if (dKi == null || dKi > 20) kIRegresses++;
  }
  console.log("");
  console.log("If we REPLACED analyzer output with kick-in detector (naive swap):");
  console.log(`  RESCUED (was FAIL, kick-in within 20ms modBeat):  ${kIRescues}`);
  console.log(`  RESCUED (was FAIL, kick-in within 20ms RAW):      ${kIRescuesRaw}`);
  console.log(`  REGRESSED (was PASS, kick-in > 20ms modBeat):     ${kIRegresses}`);
  console.log(`  Net delta (modBeat):                              ${kIRescues - kIRegresses}`);

  // Where DOES kick-in match best? Distribution of |kickIn - truth|
  console.log("");
  console.log("|kickIn - truth| distribution (raw, ms):");
  const buckets = { "<5": 0, "5-10": 0, "10-20": 0, "20-50": 0, "50-100": 0, "100-500": 0, "500+": 0 };
  for (const r of good) {
    const d = deltaAbsRaw(r.kickInSec, r.truthSec);
    if (d == null) continue;
    if (d < 5) buckets["<5"]++;
    else if (d < 10) buckets["5-10"]++;
    else if (d < 20) buckets["10-20"]++;
    else if (d < 50) buckets["20-50"]++;
    else if (d < 100) buckets["50-100"]++;
    else if (d < 500) buckets["100-500"]++;
    else buckets["500+"]++;
  }
  for (const [k, v] of Object.entries(buckets)) {
    console.log(`  ${k.padEnd(10)} ${String(v).padStart(4)}  ${"█".repeat(Math.round(v / good.length * 80))}`);
  }
}

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({ savedAt: new Date().toISOString(), results }, null, 2));
  console.log(`\nSaved: ${JSON_OUT}`);
}

console.log(`\nRun-time: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
