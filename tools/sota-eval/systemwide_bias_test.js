// systemwide_bias_test.js — diagnostic for the system-wide early bias on
// currently-PASSING tracks (mean Δ = -4.55 ms, median = -6.95 ms per the
// cluster-offset diagnostic). Tests whether this bias is constant across
// the 272-track library or correlates with BPM/length/genre.
//
// No production changes — pure diagnostic. Reads from fix-D.json snapshot.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = resolve(__dirname, "..", "bpm-test-harness");
const SNAPSHOT = JSON.parse(readFileSync(resolve(HARNESS_DIR, "snapshots", "fix-D.json"), "utf8"));

// ── Get durations via parallel audio-decode worker pool ──
const graded = SNAPSHOT.results.filter(r => r.status === "PASS" || r.status === "FAIL");
const durations = new Array(graded.length).fill(null);
const N_WORKERS = Math.min(os.cpus().length, 8);
const startTime = Date.now();
let nextIdx = 0, completed = 0;
console.error(`Decoding ${graded.length} files for duration (parallel x${N_WORKERS})...`);

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

const tracks = graded.map((r, i) => {
  const truthMs = r.truthFirstDownbeatSec * 1000;
  const anaMs = (r.analyzerFirstDownbeatSec ?? 0) * 1000;
  return {
    basename: r.basename,
    path: r.path,
    status: r.status,
    bpm: r.analyzerBpm,
    deltaMs: anaMs - truthMs,
    durSec: durations[i],
    truthMs, anaMs,
  };
});
const nDur = tracks.filter(t => t.durSec != null).length;
console.error(`Durations: ${nDur} / ${tracks.length} ok`);

// ── Stats helpers ──
function stats(values) {
  if (!values.length) return { n: 0, mean: null, median: null, stdev: null };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sorted = [...values].sort((a, b) => a - b);
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

// ── Limit to "bounded Δ" (single-beat drift) tracks — the off-by-N-beats
//    failures aren't relevant to a small global offset hypothesis. ──
const bounded = tracks.filter(t => Math.abs(t.deltaMs) < 100);
const passOnly = tracks.filter(t => t.status === "PASS");
const allBounded = tracks.filter(t => Math.abs(t.deltaMs) < 100);

console.error("");
console.error(`PASS tracks: ${passOnly.length}`);
console.error(`Bounded |Δ|<100ms: ${allBounded.length}`);

// ── Bucket by BPM ranges ──
function bpmBucket(bpm) {
  if (bpm == null) return "?";
  if (bpm <= 110) return "≤110";
  if (bpm < 120) return "110-119";
  if (bpm < 130) return "120-129";
  return "130+";
}
function lengthBucket(durSec) {
  if (durSec == null) return "?";
  const min = durSec / 60;
  if (min <= 4) return "≤4min";
  if (min <= 7) return "4-7min";
  return "7+min";
}

function bucketStats(srcList, keyFn, name) {
  const buckets = new Map();
  for (const t of srcList) {
    const k = keyFn(t);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(t.deltaMs);
  }
  const rows = [];
  rows.push("");
  rows.push("### " + name);
  rows.push("```");
  rows.push("  bucket      n     mean Δ    median Δ   stdev    min     max");
  rows.push("  --------- ---  --------- --------- -------- ------- -------");
  for (const [k, vals] of [...buckets.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
    const s = stats(vals);
    rows.push(`  ${String(k).padStart(8)}  ${String(s.n).padStart(3)}  ${String(s.mean).padStart(8)}  ${String(s.median).padStart(8)}  ${String(s.stdev).padStart(7)}  ${String(s.min).padStart(6)}  ${String(s.max).padStart(6)}`);
  }
  rows.push("```");
  return { lines: rows.join("\n"), buckets };
}

const lines = [];
lines.push("# Systemwide Bias Diagnostic — Results\n");
lines.push("Hypothesis: currently-PASSING tracks show mean Δ = -4.55ms (early bias).");
lines.push("Is this constant across the library, or does it correlate with BPM/length?\n");

lines.push("## Dataset summary");
const allBoundedStats = stats(allBounded.map(t => t.deltaMs));
const passStats_ = stats(passOnly.map(t => t.deltaMs));
const passBounded = allBounded.filter(t => t.status === "PASS");
const passBoundedStats = stats(passBounded.map(t => t.deltaMs));
lines.push("```");
lines.push(`  Total tracks in snapshot:     ${SNAPSHOT.results.length}`);
lines.push(`  Tracks graded (PASS or FAIL): ${tracks.length}`);
lines.push(`  PASS tracks:                  ${passOnly.length}`);
lines.push(`  Bounded |Δ|<100ms:            ${allBounded.length}`);
lines.push(`  PASS + bounded:               ${passBounded.length}`);
lines.push("");
lines.push(`  All PASS (any Δ):             n=${passStats_.n}  mean ${passStats_.mean}  median ${passStats_.median}  stdev ${passStats_.stdev}`);
lines.push(`  All bounded (|Δ|<100ms):      n=${allBoundedStats.n}  mean ${allBoundedStats.mean}  median ${allBoundedStats.median}  stdev ${allBoundedStats.stdev}`);
lines.push(`  PASS + bounded (target set):  n=${passBoundedStats.n}  mean ${passBoundedStats.mean}  median ${passBoundedStats.median}  stdev ${passBoundedStats.stdev}`);
lines.push("```");

// ── Part 1: bucket by BPM (on PASS tracks only) ──
lines.push("\n## Bucketed by BPM (PASS tracks only)");
const { lines: bpmLines, buckets: bpmBuckets } = bucketStats(passOnly, t => bpmBucket(t.bpm), "Δ by BPM range");
lines.push(bpmLines);

// ── Part 2: bucket by length ──
lines.push("\n## Bucketed by track length (PASS tracks only)");
const { lines: lenLines, buckets: lenBuckets } = bucketStats(passOnly.filter(t => t.durSec != null), t => lengthBucket(t.durSec), "Δ by length");
lines.push(lenLines);

// ── Part 3: cross-tab BPM × length ──
lines.push("\n## Cross-tab (BPM × length, PASS only)");
lines.push("```");
lines.push("BPM \\ Len     ≤4min       4-7min      7+min");
const bpmKeys = ["≤110", "110-119", "120-129", "130+"];
const lenKeys = ["≤4min", "4-7min", "7+min"];
for (const bk of bpmKeys) {
  const row = [bk.padStart(9)];
  for (const lk of lenKeys) {
    const subset = passOnly.filter(t => bpmBucket(t.bpm) === bk && lengthBucket(t.durSec) === lk);
    if (subset.length === 0) row.push("        —");
    else {
      const s = stats(subset.map(t => t.deltaMs));
      row.push(`${s.mean.toFixed(1).padStart(5)}(n=${String(s.n).padStart(3)})`);
    }
  }
  lines.push(row.join("  "));
}
lines.push("```");

// ── Cross-bucket stdev check ──
const bucketMeans = [...bpmBuckets.values()].filter(v => v.length >= 5).map(vals => stats(vals).mean);
const meanOfMeans = bucketMeans.reduce((a, b) => a + b, 0) / bucketMeans.length;
const stdevOfMeans = Math.sqrt(bucketMeans.reduce((a, b) => a + (b - meanOfMeans) ** 2, 0) / bucketMeans.length);

lines.push("\n## Cross-bucket consistency check");
lines.push("```");
lines.push(`  BPM-bucket means (buckets with n>=5):  [${bucketMeans.map(m => m.toFixed(2)).join(", ")}]`);
lines.push(`  Mean of means:    ${meanOfMeans.toFixed(2)} ms`);
lines.push(`  Stdev of means:   ${stdevOfMeans.toFixed(2)} ms`);
lines.push("```");

// ── Correlation: BPM vs Δ (Pearson) ──
function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return num / Math.sqrt(dx * dy);
}

const passOnlyBPM = passOnly.filter(t => t.bpm != null);
const corrBPM = pearson(passOnlyBPM.map(t => t.bpm), passOnlyBPM.map(t => t.deltaMs));
const passOnlyDur = passOnly.filter(t => t.durSec != null);
const corrLen = pearson(passOnlyDur.map(t => t.durSec), passOnlyDur.map(t => t.deltaMs));

lines.push("\n## Pearson correlations");
lines.push("```");
lines.push(`  BPM × Δ:    r = ${corrBPM.toFixed(3)}   (n=${passOnlyBPM.length})`);
lines.push(`  Length × Δ: r = ${corrLen.toFixed(3)}   (n=${passOnlyDur.length})`);
lines.push("```");
lines.push("(r near 0 = no correlation; |r| > 0.3 = noteworthy; |r| > 0.5 = strong)");

// ── Verdict per the gates ──
lines.push("\n## Verdict per the interpretation gates\n");
const stdevAcrossBuckets = stdevOfMeans;
if (stdevAcrossBuckets < 3) {
  lines.push("**Bias is constant across BPM buckets** (stdev of bucket means = " + stdevAcrossBuckets.toFixed(2) + " ms < 3 ms).");
  lines.push(`Optimal global shift: +${(-passBoundedStats.median).toFixed(1)} ms (negated median of PASS+bounded).`);
  lines.push("\nThis would re-center the distribution at 0 instead of " + passBoundedStats.median + " ms.");
} else if (Math.abs(corrBPM) > 0.3) {
  lines.push("**Bias correlates with BPM** (Pearson r = " + corrBPM.toFixed(3) + "). Might be a beat-period rounding issue.");
} else {
  lines.push("**Bias is noisy across buckets** (stdev of bucket means = " + stdevAcrossBuckets.toFixed(2) + " ms > 3 ms).");
  lines.push("Not a clean constant. Distribution shown above for inspection.");
}

writeFileSync(resolve(__dirname, "SYSTEMWIDE_BIAS_RESULT.md"), lines.join("\n"));
console.error(`Wrote SYSTEMWIDE_BIAS_RESULT.md`);
