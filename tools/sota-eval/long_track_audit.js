// long_track_audit.js — bucket the 272 harness tracks by duration and
// compute adjusted accuracy projections if long mixes are excluded.
// Reads durations from snapshots/duration_cache.json if present, else
// decodes all 272 tracks once via worker pool.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = resolve(__dirname, "..", "bpm-test-harness");
const SNAPSHOT = JSON.parse(readFileSync(resolve(HARNESS_DIR, "snapshots", "fix-D.json"), "utf8"));
const HARNESS_TOL_MS = 20;
const CACHE = resolve(__dirname, "duration_cache.json");

const graded = SNAPSHOT.results.filter(r => r.status === "PASS" || r.status === "FAIL");

// ── Get durations (cached or fresh decode) ──
let durations;
if (existsSync(CACHE)) {
  console.error("Using cached durations from " + CACHE);
  const cache = JSON.parse(readFileSync(CACHE, "utf8"));
  durations = graded.map(r => cache[r.path] ?? null);
} else {
  console.error("No cache; decoding " + graded.length + " files...");
  durations = new Array(graded.length).fill(null);
  const N_WORKERS = Math.min(os.cpus().length, 8);
  const startTime = Date.now();
  let nextIdx = 0, completed = 0;

  await new Promise((resolveAll) => {
    const workers = [];
    let ready = 0;
    function dispatch(w) {
      if (nextIdx >= graded.length) { w.postMessage({ type: "shutdown" }); return; }
      const i = nextIdx++;
      w.postMessage({ idx: i, path: graded[i].path });
    }
    for (let i = 0; i < N_WORKERS; i++) {
      const w = new Worker(resolve(__dirname, "duration_worker.mjs"));
      workers.push(w);
      w.on("message", (m) => {
        if (m.type === "ready") {
          ready++;
          if (ready === N_WORKERS) for (const w2 of workers) dispatch(w2);
          return;
        }
        if (m.durSec != null) durations[m.idx] = m.durSec;
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
  const cache = {};
  for (let i = 0; i < graded.length; i++) cache[graded[i].path] = durations[i];
  writeFileSync(CACHE, JSON.stringify(cache, null, 2));
}

// ── Build enriched records ──
const tracks = graded.map((r, i) => ({
  basename: r.basename,
  path: r.path,
  status: r.status,
  bpm: r.analyzerBpm,
  truthMs: r.truthFirstDownbeatSec * 1000,
  anaMs: (r.analyzerFirstDownbeatSec ?? 0) * 1000,
  deltaMs: (r.analyzerFirstDownbeatSec ?? 0) * 1000 - r.truthFirstDownbeatSec * 1000,
  durSec: durations[i],
}));

const long15 = tracks.filter(t => t.durSec != null && t.durSec > 15 * 60);
const long10 = tracks.filter(t => t.durSec != null && t.durSec > 10 * 60 && t.durSec <= 15 * 60);
const longTotal = tracks.filter(t => t.durSec != null && t.durSec > 10 * 60);

// ── Sub-cause B + F overlap check ──
const SUB_B = ["Body Stars", "Scarlet Sails", "Aurora", "Coaster", "Leave the World", "Serenità", "Fly Fox", "Great Attractor", "Astronauts", "Finding Estrella", "Swans", "Sparky", "Track II"];
function isSubB(name) { return SUB_B.some(s => name.toLowerCase().includes(s.toLowerCase())); }
const longSubB = tracks.filter(t => isSubB(t.basename) && t.durSec != null && t.durSec > 10 * 60);

let subFNames = [];
try {
  const subFData = JSON.parse(readFileSync(resolve(__dirname, "subcause_f_data.json"), "utf8"));
  subFNames = (subFData.subFCandidates || []).map(c => c.basename);
} catch {}
const longSubF = tracks.filter(t => subFNames.includes(t.basename) && t.durSec != null && t.durSec > 10 * 60);

// ── Adjusted accuracy ──
function acc(list) {
  const pass = list.filter(t => t.status === "PASS").length;
  return { pass, total: list.length, pct: list.length === 0 ? 0 : (pass / list.length * 100) };
}
const accAll = acc(tracks);
const accNo15 = acc(tracks.filter(t => !(t.durSec != null && t.durSec > 15 * 60)));
const accNo10 = acc(tracks.filter(t => !(t.durSec != null && t.durSec > 10 * 60)));

const lines = [];
lines.push("# Long-track audit\n");
lines.push("Hypothesis: some test-harness tracks may be full-length DJ mixes (60-90 min) which");
lines.push("can't be properly beat-gridded because they contain multiple tracks at different BPMs.");
lines.push("Excluding those would give a more honest accuracy number.\n");

lines.push("## Tracks > 15 minutes");
lines.push("```");
lines.push(`  count: ${long15.length}`);
lines.push("");
lines.push("name".padEnd(54) + "  duration   status  Δ (ms)");
for (const t of long15.sort((a, b) => b.durSec - a.durSec)) {
  const m = Math.floor(t.durSec / 60), s = Math.round(t.durSec - m * 60);
  lines.push(t.basename.slice(0, 53).padEnd(54) + "  " + (m + ":" + String(s).padStart(2, "0")).padStart(8) + "  " + t.status.padStart(6) + "  " + (t.deltaMs >= 0 ? "+" : "") + t.deltaMs.toFixed(1).padStart(8));
}
lines.push("```\n");

lines.push("## Tracks 10-15 minutes");
lines.push("```");
lines.push(`  count: ${long10.length}`);
lines.push("");
lines.push("name".padEnd(54) + "  duration   status  Δ (ms)");
for (const t of long10.sort((a, b) => b.durSec - a.durSec)) {
  const m = Math.floor(t.durSec / 60), s = Math.round(t.durSec - m * 60);
  lines.push(t.basename.slice(0, 53).padEnd(54) + "  " + (m + ":" + String(s).padStart(2, "0")).padStart(8) + "  " + t.status.padStart(6) + "  " + (t.deltaMs >= 0 ? "+" : "") + t.deltaMs.toFixed(1).padStart(8));
}
lines.push("```\n");

lines.push("## Counts");
lines.push("```");
lines.push("  All graded tracks:           " + tracks.length);
lines.push("  Tracks > 15 min:             " + long15.length);
lines.push("  Tracks 10-15 min:            " + long10.length);
lines.push("  Tracks > 10 min (total):     " + longTotal.length);
lines.push("```\n");

lines.push("## Adjusted accuracy");
lines.push("```");
lines.push("  Current:                     " + accAll.pass + "/" + accAll.total + " = " + accAll.pct.toFixed(1) + "%");
lines.push("  Excluding >15min mixes:      " + accNo15.pass + "/" + accNo15.total + " = " + accNo15.pct.toFixed(1) + "%");
lines.push("  Excluding >10min mixes:      " + accNo10.pass + "/" + accNo10.total + " = " + accNo10.pct.toFixed(1) + "%");
lines.push("```\n");

lines.push("## Cross-contamination check");
lines.push("```");
lines.push("  Sub-cause B tracks > 10min:  " + longSubB.length + " / 13");
for (const t of longSubB) lines.push("    " + t.basename.slice(0, 50));
lines.push("");
lines.push("  Sub-cause F candidates > 10min:  " + longSubF.length);
for (const t of longSubF) lines.push("    " + t.basename.slice(0, 50));
lines.push("```");

writeFileSync(resolve(__dirname, "LONG_TRACK_AUDIT.md"), lines.join("\n"));
console.error("Wrote LONG_TRACK_AUDIT.md");
console.error("Current: " + accAll.pct.toFixed(1) + "%, no >15min: " + accNo15.pct.toFixed(1) + "%, no >10min: " + accNo10.pct.toFixed(1) + "%");
