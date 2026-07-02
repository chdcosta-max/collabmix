// analyzer-audit.mjs — batch-run the REAL analyzer worker headlessly across
// Chad's music library and log per-track confidence internals. READ-ONLY on
// music files (m4a is transcoded via afconvert into /tmp, originals untouched).
//
//   node tools/audit/analyzer-audit.mjs            # full run (resume-safe)
//   node tools/audit/audit-summary.mjs             # ranked report from the NDJSON
//
// Output: tools/audit/out/audit-results.ndjson — one row per track with the
// fields the July 2 BPM misdetection surfaced (Jake's 88.2 case):
// periodIntegerLocked, crossValidated, |bpmFromPeriod-intBpm|, firstBeatDpIdx,
// dpBeats count, phase spread/peak, plus the worker result's own confidence.
// Resume: rows already present are skipped, so the grind survives interruption.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { decode } from "../smoke/lib/audio.mjs";
import { WORKER_SRC } from "../../src/bpm-worker-source.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOTS = [
  "/Users/chad/Music/Music/Media.localized",
  "/Users/chad/Music/rekordbox",
];
const OUT_DIR = resolve(__dirname, "out");
const OUT = resolve(OUT_DIR, "audit-results.ndjson");
const TMP_AIFF = "/tmp/mixsync-audit-tmp.aiff"; // AIFF: afconvert's WAVE output is EXTENSIBLE (0xfffe), which audio-decode rejects
const NATIVE = new Set([".mp3", ".wav", ".aiff", ".aif", ".flac"]);

// ── collect + dedup (lowercase basename; first root wins) ───────────────────
const walk = (dir, acc) => {
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
};
const all = ROOTS.flatMap((r) => walk(r, []));
const seen = new Set(); const files = [];
let skippedDrm = 0, skippedExt = 0;
for (const p of all) {
  const ext = extname(p).toLowerCase();
  if (ext === ".m4p") { skippedDrm++; continue; }                    // DRM — cannot decode
  if (!NATIVE.has(ext) && ext !== ".m4a") { skippedExt++; continue; }
  const key = basename(p).toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key); files.push(p);
}
console.log(`corpus: ${files.length} tracks (deduped from ${all.length} files; ${skippedDrm} DRM m4p skipped)`);
// LIMIT=<n> — pre-flight sanity slice (mixed extensions) before the full grind
if (process.env.LIMIT) {
  const lim = parseInt(process.env.LIMIT, 10);
  const byExt = {}; for (const f of files) (byExt[extname(f).toLowerCase()] ||= []).push(f);
  files.length = 0; files.push(...Object.values(byExt).flatMap((a) => a.slice(0, Math.ceil(lim / Object.keys(byExt).length))).slice(0, lim));
  console.log(`LIMIT=${lim}: ${files.map((f) => basename(f)).join(" | ")}`);
}

// ── resume ───────────────────────────────────────────────────────────────────
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
const done = new Set();
if (existsSync(OUT)) for (const l of readFileSync(OUT, "utf8").split("\n")) { try { done.add(JSON.parse(l).file); } catch {} }
if (done.size) console.log(`resume: ${done.size} already audited`);

// ── worker with log capture ──────────────────────────────────────────────────
// The confidence internals live in the worker's console.log lines ([phase] /
// [BPM-PERIOD]) as alternating "key:"/value args — capture and parse them.
function runWorkerVerbose(channelData, sr) {
  let cap = null; const logs = [];
  const self = { onmessage: null, postMessage: (r) => { cap = r; } };
  const ol = console.log; console.log = (...a) => logs.push(a);
  try { new Function("self", WORKER_SRC)(self); self.onmessage({ data: { cd: channelData, sr, id: "audit", onsetAnchor: true } }); } // eslint-disable-line no-new-func
  finally { console.log = ol; }
  if (!cap) throw new Error("worker produced no result");
  return { result: cap, logs };
}
const kvParse = (args) => {
  const out = {};
  for (let i = 0; i < args.length - 1; i++) {
    if (typeof args[i] === "string" && args[i].endsWith(":")) {
      const k = args[i].slice(0, -1); const v = args[i + 1];
      out[k] = typeof v === "string" && v !== "" && !isNaN(+v) ? +v : v;
    }
  }
  return out;
};

// ── main loop (serial — bounded transient memory, per the library-OOM lesson) ─
const t0 = Date.now();
let n = 0, errs = 0;
for (const file of files) {
  if (done.has(file)) { n++; continue; }
  const row = { file, error: null };
  try {
    let path = file;
    if (extname(file).toLowerCase() === ".m4a") {
      // afconvert READS the m4a and writes a temp aiff — the original is untouched
      try { unlinkSync(TMP_AIFF); } catch {}
      execFileSync("afconvert", ["-f", "AIFF", "-d", "BEI16@44100", file, TMP_AIFF], { stdio: "ignore" });
      path = TMP_AIFF;
    }
    const { channelData, sr, dur } = await decode(path);
    row.durSec = +dur.toFixed(1);
    const { result, logs } = runWorkerVerbose(channelData.map((a) => Float32Array.from(a)), sr);
    row.bpm = result.bpm; row.confidence = result.confidence ?? null; row.snapped = result.snapped ?? null;
    row.beats = result.beatTimes?.length ?? null; // Float32Array or Array — either way .length
    for (const a of logs) {
      const head = String(a[0] ?? "");
      if (head.includes("[BPM-PERIOD]")) {
        const m = String(a[a.length - 1]).match(/mean=([\d.]+)s \(([\d.]+)\)/);
        if (m) { row.periodMean = +m[1]; row.bpmFromPeriod = +m[2]; }
      } else if (head.includes("[phase] phSc")) {
        const kv = kvParse(a);
        row.spreadPeak = kv["spread/peak"] ?? null;
        row.firstBeatDpIdx = kv["firstBeatDpIdx"] ?? null;
        row.dpBeats = kv["dpBeats.length"] ?? null;
        row.best16 = kv["best16%4"] ?? null; row.best32 = kv["best32%4"] ?? null; row.bestPh = kv["bestPh"] ?? null;
        row.intBpm = kv["intBpm"] ?? null;
        row.dIntBpm = kv["|bpmFromPeriod-intBpm|"] ?? null;
        row.periodIntegerLocked = kv["periodIntegerLocked"] ?? null;
        row.crossValidated = kv["crossValidated"] ?? null;
        row.withinOuterGuard = kv["withinOuterGuard"] ?? null;
      }
    }
  } catch (e) {
    row.error = String(e.message || e).slice(0, 200); errs++;
  }
  appendFileSync(OUT, JSON.stringify(row) + "\n");
  n++;
  if (n % 10 === 0) {
    const rate = (n - done.size) / ((Date.now() - t0) / 60000);
    console.log(`${n}/${files.length} (${errs} errors, ${rate.toFixed(1)}/min, ~${Math.round((files.length - n) / Math.max(0.1, rate))}min left)`);
  }
}
try { unlinkSync(TMP_AIFF); } catch {}
console.log(`DONE: ${n}/${files.length} audited, ${errs} errors → ${OUT}`);
