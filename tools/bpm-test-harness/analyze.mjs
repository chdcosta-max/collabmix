// BPM Test Harness — runs WORKER_SRC analyzer over a folder of audio files
// and compares results against ground-truth.json.
//
// Usage:
//   cd tools/bpm-test-harness
//   npm install
//   npm test
//
// Tracks live in ./tracks/ (gitignored). Ground truth in ./ground-truth.json.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import decodeAudio from "audio-decode";
import { WORKER_SRC } from "../../src/bpm-worker-source.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACKS_DIR = resolve(__dirname, "tracks");
const GROUND_TRUTH_PATH = resolve(__dirname, "ground-truth.json");

const TOLERANCE_BPM = 0.5;        // ±0.5 BPM
const TOLERANCE_DOWNBEAT_MS = 20; // ±20 ms

const SUPPORTED_EXT = new Set([".mp3", ".wav", ".flac", ".ogg"]);

// ── Load ground truth (optional) ─────────────────────────────────────────
let groundTruth = {};
if (existsSync(GROUND_TRUTH_PATH)) {
  try {
    const raw = JSON.parse(readFileSync(GROUND_TRUTH_PATH, "utf8"));
    // Strip metadata keys that begin with underscore.
    for (const [k, v] of Object.entries(raw)) {
      if (!k.startsWith("_")) groundTruth[k] = v;
    }
  } catch (e) {
    console.error(`Failed to parse ${GROUND_TRUTH_PATH}: ${e.message}`);
    process.exit(1);
  }
}

// ── Discover tracks ──────────────────────────────────────────────────────
if (!existsSync(TRACKS_DIR)) {
  console.error(`Tracks directory not found: ${TRACKS_DIR}`);
  console.error(`Create it and drop audio files (mp3, wav, flac, ogg) inside.`);
  process.exit(1);
}

const tracks = readdirSync(TRACKS_DIR)
  .filter((f) => SUPPORTED_EXT.has(extname(f).toLowerCase()))
  .sort();

if (tracks.length === 0) {
  console.error(`No audio files found in ${TRACKS_DIR}`);
  console.error(`Supported extensions: ${[...SUPPORTED_EXT].join(", ")}`);
  process.exit(1);
}

// ── Set up the worker shim ───────────────────────────────────────────────
// WORKER_SRC was written to run inside a Web Worker. It defines `self.onmessage`
// and posts results via `self.postMessage`. In Node we shim `self` as a plain
// object, evaluate the source so its declarations attach to the shim, then
// invoke `self.onmessage({ data: ... })` synchronously.
//
// The worker source is synchronous start-to-finish (no awaits, no timers) so
// `postMessage` fires before `onmessage` returns. We capture the result via
// the shim's postMessage closure.
function runWorker(cd, sr, id) {
  let captured = null;
  const self = {
    onmessage: null,
    postMessage: (result) => { captured = result; },
  };
  // Suppress the worker's [phase] console.log unless DEBUG=1.
  const origLog = console.log;
  if (!process.env.DEBUG) console.log = () => {};
  try {
    // eslint-disable-next-line no-new-func
    new Function("self", WORKER_SRC)(self);
    if (typeof self.onmessage !== "function") {
      throw new Error("WORKER_SRC did not assign self.onmessage");
    }
    self.onmessage({ data: { cd, sr, id } });
  } finally {
    console.log = origLog;
  }
  if (captured === null) {
    throw new Error("WORKER_SRC did not call self.postMessage");
  }
  return captured;
}

// ── Helpers ──────────────────────────────────────────────────────────────
function fmt(n, digits = 4) {
  if (n == null || Number.isNaN(n)) return "—";
  return Number(n).toFixed(digits);
}

function classifyDownbeatError(deltaSec, beatPeriodSec) {
  // If Δfirstdownbeat is close to an integer multiple of beatPeriodSec, the
  // anchor selected the wrong beat-of-bar. Useful diagnostic for FAIL output.
  if (!beatPeriodSec || beatPeriodSec <= 0) return null;
  const beats = deltaSec / beatPeriodSec;
  const nearest = Math.round(beats);
  if (nearest >= 1 && Math.abs(beats - nearest) < 0.15) {
    return `off by ${nearest} beat${nearest === 1 ? "" : "s"}`;
  }
  return null;
}

// ── Run analysis ─────────────────────────────────────────────────────────
console.log(`BPM Test Harness — ${tracks.length} track${tracks.length === 1 ? "" : "s"}\n`);

const results = [];
for (let i = 0; i < tracks.length; i++) {
  const filename = tracks[i];
  const filepath = resolve(TRACKS_DIR, filename);
  console.log(`[${i + 1}/${tracks.length}] ${filename} ...`);

  let buf;
  try {
    const fileData = readFileSync(filepath);
    buf = await decodeAudio(fileData);
  } catch (e) {
    console.log(`       DECODE_FAIL  ${e.message}`);
    console.log("");
    results.push({ filename, status: "DECODE_FAIL", error: e.message });
    continue;
  }

  // audio-decode 3.x returns { channelData: Float32Array[], sampleRate }.
  // (v2 returned an AudioBuffer with getChannelData(c). API changed in 3.0.)
  const sr = buf.sampleRate;
  const cd = buf.channelData;
  if (!Array.isArray(cd) || cd.length === 0 || !(cd[0] instanceof Float32Array)) {
    console.log(`       DECODE_FAIL  unexpected decoder output shape (no channelData)`);
    console.log("");
    results.push({ filename, status: "DECODE_FAIL", error: "no channelData" });
    continue;
  }

  let result;
  try {
    result = runWorker(cd, sr, filename);
  } catch (e) {
    console.log(`       WORKER_FAIL  ${e.message}`);
    console.log("");
    results.push({ filename, status: "WORKER_FAIL", error: e.message });
    continue;
  }

  const { bpm, beatPhaseFrac, beatPeriodSec, snapped, candidates } = result;
  const firstDownbeatSec =
    beatPhaseFrac != null && beatPeriodSec != null ? beatPhaseFrac * beatPeriodSec : null;

  // Best-effort raw BPM for display: top candidate's BPM (rv-rounded but pre-snap).
  const rawDisplay = candidates && candidates[0] ? candidates[0].bpm : bpm;
  const snapTag = snapped ? `snapped, raw=${fmt(rawDisplay, 2)}` : `no-snap, raw=${fmt(rawDisplay, 2)}`;

  console.log(
    `       bpm=${bpm ?? "—"} (${snapTag})  bps=${fmt(beatPeriodSec)}  bpf=${fmt(beatPhaseFrac, 3)}  firstDownbeat=${fmt(firstDownbeatSec, 3)}s`,
  );

  const truth = groundTruth[filename];
  if (!truth) {
    console.log(`       (no ground truth — analyzer-only)`);
    console.log(`       SKIP`);
    console.log("");
    results.push({ filename, status: "SKIP", bpm, firstDownbeatSec });
    continue;
  }

  console.log(`       expected: bpm=${truth.bpm}, firstDownbeat=${fmt(truth.firstDownbeatSec, 3)}s`);

  const deltaBpm = bpm == null ? Infinity : Math.abs(bpm - truth.bpm);
  const deltaDownbeatSec =
    firstDownbeatSec == null ? Infinity : Math.abs(firstDownbeatSec - truth.firstDownbeatSec);
  const deltaDownbeatMs = deltaDownbeatSec * 1000;

  const passed = deltaBpm <= TOLERANCE_BPM && deltaDownbeatMs <= TOLERANCE_DOWNBEAT_MS;
  const status = passed ? "PASS" : "FAIL";

  let note = "";
  if (!passed) {
    const beatNote = classifyDownbeatError(deltaDownbeatSec, beatPeriodSec);
    if (beatNote) note = ` (${beatNote})`;
  }

  console.log(
    `       ${status}  Δbpm=${fmt(deltaBpm, 2)}  Δfirstdownbeat=${Math.round(deltaDownbeatMs)}ms${note}`,
  );
  console.log("");
  results.push({
    filename,
    status,
    bpm,
    firstDownbeatSec,
    deltaBpm,
    deltaDownbeatMs,
    note,
  });
}

// ── Summary ──────────────────────────────────────────────────────────────
const tally = { PASS: 0, FAIL: 0, SKIP: 0, DECODE_FAIL: 0, WORKER_FAIL: 0 };
for (const r of results) tally[r.status] = (tally[r.status] || 0) + 1;

const totalGraded = tally.PASS + tally.FAIL;

console.log("═════════════════════════════════════════");
console.log("Summary");
console.log(`  PASS:  ${tally.PASS} / ${totalGraded}`);
console.log(`  FAIL:  ${tally.FAIL} / ${totalGraded}`);
if (tally.SKIP) console.log(`  SKIP:  ${tally.SKIP} (no ground truth)`);
if (tally.DECODE_FAIL) console.log(`  DECODE_FAIL: ${tally.DECODE_FAIL}`);
if (tally.WORKER_FAIL) console.log(`  WORKER_FAIL: ${tally.WORKER_FAIL}`);
console.log(`  Tolerance: ±${TOLERANCE_BPM} BPM, ±${TOLERANCE_DOWNBEAT_MS} ms first-downbeat`);

const failures = results.filter((r) => r.status === "FAIL");
if (failures.length) {
  console.log("  Failed tracks:");
  for (const r of failures) {
    console.log(
      `    ${r.filename}  Δbpm=${fmt(r.deltaBpm, 2)}  Δfirstdownbeat=${Math.round(r.deltaDownbeatMs)}ms${r.note || ""}`,
    );
  }
}

process.exit(tally.FAIL > 0 ? 1 : 0);
