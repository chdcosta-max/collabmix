// measure-uniform.mjs — is the kick-to-kick SCATTER caused by per-beat snapping?
// Compare, per track, the grid-vs-kick CONSISTENCY of:
//   SNAPPED  = the analyzer's per-beat onset-anchored beatTimes (what we draw)
//   UNIFORM  = a single anchor + constant period (what Rekordbox draws)
// Metric = STDEV of (grid − kick) kick-to-kick (lower = more consistent) + within5%.
// Also report non-uniformity = stdev(snapped − uniform) = the per-beat jitter.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";
import { decode, runWorker, kickEnvelope, envFloor, onsetOf } from "./lib/audio.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACKDIR = resolve(__dirname, "../bpm-test-harness/tracks");
const TRACKS = readdirSync(TRACKDIR).filter((f) => /\.(mp3|wav|flac)$/i.test(f)).map((f) => resolve(TRACKDIR, f));
const SKIP = 8;
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const std = (xs) => { if (xs.length < 2) return NaN; const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); };
const within = (xs, c, t) => 100 * xs.filter((v) => Math.abs(v - c) <= t).length / xs.length; // within ±t of the track's own center c

const rows = [];
for (const path of TRACKS) {
  let dec; try { dec = await decode(path); } catch { continue; }
  const { sr, channelData, length, dur, mono } = dec;
  const env = kickEnvelope(mono, sr), floor = envFloor(env);
  const res = runWorker(channelData, sr, "anc", true);
  const bts = res.beatTimes, period = res.beatPeriodSec;
  if (!bts || bts.length < 30 || !period) continue;
  // collect (index, snapped, kick) for strong kicks
  const idx = [], snap = [], kick = [];
  for (let k = SKIP; k < bts.length; k++) {
    const b = bts[k]; if (b < 0.3 || b > dur - 0.3) continue;
    const a = onsetOf(env, sr, b, floor); if (a == null) continue;
    if (Math.abs((b - a) * 1000) > 80) continue;
    idx.push(k); snap.push(b); kick.push(a);
  }
  if (snap.length < 25) continue;
  // UNIFORM grid: fixed period, phase = median(snapped[k] − k·period)
  const phase = med(snap.map((b, i) => b - idx[i] * period));
  const uni = idx.map((k) => phase + k * period);
  const snapVsKick = snap.map((b, i) => (b - kick[i]) * 1000);
  const uniVsKick = uni.map((u, i) => (u - kick[i]) * 1000);
  const nonUnif = snap.map((b, i) => (b - uni[i]) * 1000);
  // consistency = stdev; within = % within ±5ms of each grid's OWN median offset
  rows.push({
    name: path.split("/").pop().slice(0, 34),
    snapStd: std(snapVsKick), uniStd: std(uniVsKick), jitter: std(nonUnif),
    snapW5: within(snapVsKick, med(snapVsKick), 5), uniW5: within(uniVsKick, med(uniVsKick), 5),
    n: snap.length,
  });
  process.stdout.write(".");
}
process.stdout.write("\n\n");
rows.sort((a, b) => b.jitter - a.jitter);
console.log("track (sorted by per-beat JITTER)      snapStd  uniStd   jitter  | consistent-within5: snap → uni");
for (const r of rows) console.log(`  ${r.name.padEnd(36)} ${r.snapStd.toFixed(1).padStart(5)}ms ${r.uniStd.toFixed(1).padStart(5)}ms ${r.jitter.toFixed(1).padStart(5)}ms |  ${r.snapW5.toFixed(0).padStart(3)}% → ${r.uniW5.toFixed(0).padStart(3)}%`);
const agg = (key) => med(rows.map((r) => r[key]));
console.log(`\n=== medians across ${rows.length} tracks ===`);
console.log(`  SNAPPED grid (per-beat onset):  stdev(grid−kick)=${agg("snapStd").toFixed(1)}ms   consistent-within±5ms=${agg("snapW5").toFixed(0)}%`);
console.log(`  UNIFORM grid (anchor+period):   stdev(grid−kick)=${agg("uniStd").toFixed(1)}ms   consistent-within±5ms=${agg("uniW5").toFixed(0)}%`);
console.log(`  per-beat JITTER added by snapping (stdev snapped−uniform) = ${agg("jitter").toFixed(1)}ms`);
console.log(`\nLower stdev / higher within5 = tighter, more consistent kick-to-kick (Rekordbox-like).`);
