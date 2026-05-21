// drop-detect-probe.mjs — investigation tool for "drop-detection as grid
// validation". Detects breakdown→drop events per track, computes which
// beat-of-bar each drop lands on relative to the current analyzer grid,
// and aggregates into a "voted shift" (the integer number of beats by
// which the analyzer's bar-1 anchor would need to move to align drops to
// beat 1 of the 4-bar phrase).
//
// Per-track output:
//   - drops          — array of refined drop times (sec)
//   - beatOfBarVotes — histogram { 0, 1, 2, 3 } of how many drops land
//                      on each beat-of-bar
//   - dominantBeat   — argmax of votes; 0 means grid is already aligned
//   - votedShift     — (4 - dominantBeat) mod 4: how many beats to shift
//                      bar-1 FORWARD to put drops on beat 1
//   - shiftMs        — votedShift × beatPeriodSec × 1000
//   - newBar1Sec     — analyzerFirstDownbeatSec + votedShift × period
//                      (mod periodSec to stay within 1 beat)
//   - truthMatch     — bool: |newBar1 - truth| ≤ 20ms
//
// Usage:
//   node drop-detect-probe.mjs --names "It Has To Be,Body Stars,..."
//   node drop-detect-probe.mjs --all --json snapshots/drop-detect-full.json

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

const manifest = JSON.parse(readFileSync(resolve(__dirname, "library-truth.json"), "utf8"));
const snapshot = JSON.parse(readFileSync(resolve(__dirname, "snapshots/parallel-full.json"), "utf8"));
const snapMap = new Map();
for (const r of snapshot.results) snapMap.set(r.path, r);

let tracks = manifest.tracks || [];
if (!ALL) {
  if (!NAMES) {
    console.error("Usage: node drop-detect-probe.mjs --names \"<subs>\" | --all");
    process.exit(2);
  }
  const subs = NAMES.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  tracks = tracks.filter(t => subs.some(s => t.basename.toLowerCase().includes(s)));
  console.log(`Matched ${tracks.length} of ${manifest.tracks.length} tracks`);
}

// ── Worker pool ──────────────────────────────────────────────────────────
const probeResults = new Array(tracks.length);
const startTime = Date.now();
let nextIdx = 0, completed = 0;

await new Promise((resolveAll) => {
  const workers = [];
  let readyCount = 0;
  function dispatch(worker) {
    if (nextIdx >= tracks.length) {
      worker.postMessage({ type: "shutdown" });
      return;
    }
    const i = nextIdx++;
    const snap = snapMap.get(tracks[i].path);
    worker.postMessage({
      idx: i,
      path: tracks[i].path,
      basename: tracks[i].basename,
      anaBar1: snap?.analyzerFirstDownbeatSec ?? null,
      anaPeriod: snap?.beatPeriodSec ?? null,
    });
  }
  for (let w = 0; w < N_WORKERS; w++) {
    const worker = new Worker(resolve(__dirname, "drop-detect-worker.mjs"));
    workers.push(worker);
    worker.on("message", (msg) => {
      if (msg.type === "ready") {
        readyCount++;
        if (readyCount === N_WORKERS) for (const w2 of workers) dispatch(w2);
        return;
      }
      probeResults[msg.idx] = msg.result || { error: msg.decodeError };
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
    worker.on("error", (e) => console.error("\nWorker error:", e));
  }
});
process.stderr.write("\n");

// ── Per-track grid-shift analysis ────────────────────────────────────────
function analyseTrack(track, probe, snap) {
  const period = snap?.beatPeriodSec || 0;
  const bar1 = snap?.analyzerFirstDownbeatSec ?? 0;
  const truthBar1 = track.firstDownbeatSec;

  if (!period || !probe.drops || probe.drops.length === 0) {
    return {
      path: track.path,
      basename: track.basename,
      truthBar1,
      analyzerBar1: bar1,
      period,
      nDrops: 0,
      nBreakdowns: probe.breakdowns?.length || 0,
      votedShift: null,
      reason: probe.drops ? "no-drops" : "probe-error",
      analyzerStatus: snap?.status || null,
    };
  }

  // For each drop, compute beat-of-bar relative to current bar-1
  // beat index = (dropTime - bar1) / period (can be negative; we want mod 4 wrapped to [0,3])
  function beatOfBar(t) {
    const beatIdx = (t - bar1) / period;
    let bob = ((Math.round(beatIdx) % 4) + 4) % 4;
    return bob;
  }
  function nearestBeatFrac(t) {
    const beatIdx = (t - bar1) / period;
    return Math.abs(beatIdx - Math.round(beatIdx));
  }

  // Filter drops to those that land near a beat (frac < 0.20) — gives us
  // confidence the drop is a real downbeat-grade event, not a stray transient.
  const validDrops = [];
  const droppedReasons = [];
  for (const d of probe.drops) {
    const t = d.refinedTime ?? d.time;
    if (t < 0.5) continue; // skip the very start (often inside Step 1's walk-back)
    const frac = nearestBeatFrac(t);
    if (frac > 0.20) {
      droppedReasons.push({ t, frac });
      continue;
    }
    validDrops.push({ time: t, beatOfBar: beatOfBar(t), frac });
  }

  if (validDrops.length === 0) {
    return {
      path: track.path,
      basename: track.basename,
      truthBar1,
      analyzerBar1: bar1,
      period,
      nDrops: probe.drops.length,
      nValidDrops: 0,
      nBreakdowns: probe.breakdowns?.length || 0,
      votedShift: null,
      reason: "no-valid-drops",
      analyzerStatus: snap?.status || null,
    };
  }

  // Histogram beat-of-bar
  const hist = [0, 0, 0, 0];
  for (const d of validDrops) hist[d.beatOfBar]++;

  // Find dominant beat-of-bar
  let dom = 0;
  for (let b = 1; b < 4; b++) if (hist[b] > hist[dom]) dom = b;
  const total = hist[0] + hist[1] + hist[2] + hist[3];
  const domConfidence = total > 0 ? hist[dom] / total : 0;

  // votedShift = dom — to make drops land on beat-of-bar 0, add dom × period
  // to bar-1 (this moves bar-1 FORWARD in time so that what was at bob=dom
  // becomes bob=0 on the new grid).
  //   Proof: newBob = round((t - (bar1 + dom*period)) / period) mod 4
  //                = (oldBob - dom) mod 4
  //                = (dom - dom) mod 4 = 0 ✓
  const votedShift = dom;

  // Candidate new bar-1 positions. Try shifts of {votedShift + 4k} for k in
  // {-1, 0, 1} so we have both forward and backward equivalents.
  let candidates = [];
  for (let k = -1; k <= 1; k++) {
    candidates.push(bar1 + (votedShift + 4 * k) * period);
  }
  candidates = candidates.filter(c => c >= 0 && c < (snap?.beatPeriodSec || 0.5) * 32);
  let bestNew = null, bestDelta = Infinity;
  for (const c of candidates) {
    const d = Math.abs(c - truthBar1);
    if (d < bestDelta) { bestDelta = d; bestNew = c; }
  }

  const truthBeatOfBar = ((truthBar1 - bar1) / period);
  const truthBoBRound = ((Math.round(truthBeatOfBar) % 4) + 4) % 4;
  const truthBoBFrac = Math.abs(truthBeatOfBar - Math.round(truthBeatOfBar));

  return {
    path: track.path,
    basename: track.basename,
    truthBar1,
    analyzerBar1: bar1,
    period,
    durSec: probe.durSec,
    nDrops: probe.drops.length,
    nValidDrops: validDrops.length,
    nBreakdowns: probe.breakdowns?.length || 0,
    breakdownDurations: (probe.breakdowns || []).map(b => +b.durSec.toFixed(1)),
    drops: validDrops.map(d => ({ t: +d.time.toFixed(3), bob: d.beatOfBar, frac: +d.frac.toFixed(2) })),
    histogram: hist,
    dominantBeat: dom,
    domConfidence: +domConfidence.toFixed(2),
    votedShift,
    newBar1Sec: bestNew,
    truthBeatOfBar: truthBoBRound,
    truthBeatOfBarFrac: +truthBoBFrac.toFixed(2),
    truthMatch: bestDelta <= 0.020, // within 20ms
    truthDeltaMs: +(bestDelta * 1000).toFixed(1),
    analyzerStatus: snap?.status || null,
  };
}

const analyses = tracks.map((t, i) => analyseTrack(t, probeResults[i] || {}, snapMap.get(t.path)));

// ── Reporting ────────────────────────────────────────────────────────────
function fmtMs(s) { if (s == null || !isFinite(s)) return "      —"; return (s * 1000).toFixed(0).padStart(6); }

console.log("");
console.log("═".repeat(135));
console.log("DROP-DETECTION + GRID-SHIFT VOTING");
console.log("═".repeat(135));
console.log("name".padEnd(45) + "  " +
  "truth".padStart(6) + "  " +
  "ana".padStart(6) + "  " +
  "drops".padStart(5) + "  " +
  "histo".padStart(11) + "  " +
  "dom".padStart(3) + "  " +
  "conf".padStart(4) + "  " +
  "shift".padStart(5) + "  " +
  "newBar1".padStart(7) + "  " +
  "Δnew".padStart(5) + "  status  truthBoB");
console.log("─".repeat(135));
for (const a of analyses) {
  if (a.votedShift == null) {
    console.log(a.basename.slice(0, 44).padEnd(45) + "  " +
      fmtMs(a.truthBar1) + "  " +
      fmtMs(a.analyzerBar1) + "  " +
      "—".padStart(5) + "  (" + (a.reason || "—") + ")  " + (a.analyzerStatus || "?"));
    continue;
  }
  const histStr = `[${a.histogram.join(",")}]`;
  console.log(a.basename.slice(0, 44).padEnd(45) + "  " +
    fmtMs(a.truthBar1) + "  " +
    fmtMs(a.analyzerBar1) + "  " +
    String(a.nValidDrops).padStart(5) + "  " +
    histStr.padStart(11) + "  " +
    String(a.dominantBeat).padStart(3) + "  " +
    a.domConfidence.toFixed(2).padStart(4) + "  " +
    (a.votedShift + "β").padStart(5) + "  " +
    fmtMs(a.newBar1Sec) + "  " +
    String(a.truthDeltaMs).padStart(5) + "  " +
    (a.analyzerStatus || "?").padStart(4) + "  bob=" + a.truthBeatOfBar + "(frac=" + a.truthBeatOfBarFrac + ")");
}

// ── Stats ────────────────────────────────────────────────────────────────
if (ALL) {
  console.log("");
  console.log("═".repeat(78));
  console.log("FULL-LIBRARY DROP-DETECTION STATS");
  console.log("═".repeat(78));
  const total = analyses.length;
  const withDrops = analyses.filter(a => a.nDrops > 0).length;
  const withBreakdowns = analyses.filter(a => a.nBreakdowns > 0).length;
  const withValidDrops = analyses.filter(a => a.votedShift != null).length;

  console.log(`  Total tracks:                       ${total}`);
  console.log(`  With ≥1 drop event:                 ${withDrops}`);
  console.log(`  With ≥1 breakdown:                  ${withBreakdowns}`);
  console.log(`  With ≥1 valid (on-beat) drop:       ${withValidDrops}`);
  console.log("");

  // Among valid-drop tracks: vote distribution
  const voted = analyses.filter(a => a.votedShift != null);
  const voteHist = [0, 0, 0, 0];
  for (const a of voted) voteHist[a.votedShift]++;
  console.log("Voted-shift distribution (valid-drop tracks):");
  for (let s = 0; s < 4; s++) {
    console.log(`  shift = ${s}β:  ${voteHist[s]}  (${(voteHist[s] / voted.length * 100).toFixed(1)}%)`);
  }
  console.log("");

  // Confidence-gated tracks
  const conf = voted.filter(a => a.domConfidence >= 0.6 && a.nValidDrops >= 2);
  console.log(`Confidence-gated (≥60% dom, ≥2 valid drops):  ${conf.length}`);
  const confVotes = [0, 0, 0, 0];
  for (const a of conf) confVotes[a.votedShift]++;
  for (let s = 0; s < 4; s++) {
    console.log(`  shift = ${s}β:  ${confVotes[s]}  (${(confVotes[s] / conf.length * 100).toFixed(1)}%)`);
  }
  console.log("");

  // Validation: PASS tracks should vote shift = 0
  const passConf = conf.filter(a => a.analyzerStatus === "PASS");
  const passZero = passConf.filter(a => a.votedShift === 0).length;
  console.log(`Validation on PASS tracks (confidence-gated):`);
  console.log(`  Total PASS conf-gated:              ${passConf.length}`);
  console.log(`  Of those, voted shift = 0:           ${passZero}  (${(passZero / passConf.length * 100).toFixed(1)}%)`);
  const passWrong = passConf.filter(a => a.votedShift !== 0);
  console.log(`  Of those, voted shift ≠ 0:           ${passWrong.length}  (POTENTIAL REGRESSIONS)`);

  // Impact: FAIL tracks where shift would PASS
  const failConf = conf.filter(a => a.analyzerStatus === "FAIL");
  let rescuedShift = 0;
  let regressedShift = 0;
  for (const a of conf) {
    if (a.analyzerStatus === "FAIL" && a.truthMatch && a.votedShift !== 0) rescuedShift++;
    if (a.analyzerStatus === "PASS" && a.votedShift !== 0 && !a.truthMatch) regressedShift++;
  }
  console.log("");
  console.log(`If we apply: votedShift!=0 + confidence-gated → shift bar-1:`);
  console.log(`  RESCUED  (FAIL → would PASS):       ${rescuedShift}`);
  console.log(`  REGRESSED (PASS → would FAIL):      ${regressedShift}`);
  console.log(`  Net:                                 ${rescuedShift - regressedShift}`);

  // What if we add an extra gate: only apply when current analyzer disagreement with truth is multi-beat?
  // We can't check truth in production, but we can simulate the right gate: only apply if shift "looks safe"
  // (e.g., dominant beat is at least 2× the next-highest beat)
  let rescuedStrict = 0, regressedStrict = 0;
  for (const a of conf) {
    if (a.votedShift === 0) continue;
    const next = a.histogram.slice().sort((x, y) => y - x)[1] || 0;
    const dom = a.histogram[a.dominantBeat];
    if (dom < 2 * Math.max(1, next)) continue; // require dominance 2:1
    if (a.analyzerStatus === "FAIL" && a.truthMatch) rescuedStrict++;
    if (a.analyzerStatus === "PASS" && !a.truthMatch) regressedStrict++;
  }
  console.log("");
  console.log(`Stricter gate (dom ≥ 2× next-highest):`);
  console.log(`  RESCUED:    ${rescuedStrict}`);
  console.log(`  REGRESSED:  ${regressedStrict}`);
  console.log(`  Net:        ${rescuedStrict - regressedStrict}`);
}

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({ savedAt: new Date().toISOString(), analyses }, null, 2));
  console.log(`\nSaved: ${JSON_OUT}`);
}

console.log(`\nRun-time: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
