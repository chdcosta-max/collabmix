// measure-anchor.mjs — decompose (grid − true_kick) into SYSTEMATIC offset vs
// SCATTER. If a global or per-track shift collapses it near zero, it's a fixable
// offset; if scatter survives the shift, it's genuine detection noise.
// true_kick = independent 40-200Hz kick-envelope onset (NOT the analyzer).
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";
import { decode, runWorker, kickEnvelope, envFloor, onsetOf } from "./lib/audio.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACKDIR = resolve(__dirname, "../bpm-test-harness/tracks");
const TRACKS = readdirSync(TRACKDIR).filter((f) => /\.(mp3|wav|flac)$/i.test(f)).slice(0, 12).map((f) => resolve(TRACKDIR, f));
const SKIP = 8;
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const within = (xs, t) => 100 * xs.filter((v) => Math.abs(v) <= t).length / xs.length;

const perTrack = [];      // { name, errs: [grid-kick ms] }
for (const path of TRACKS) {
  const { sr, channelData, length, dur, mono } = await decode(path);
  const env = kickEnvelope(mono, sr), floor = envFloor(env);
  const beats = runWorker(channelData, sr, "anc", true).beatTimes;
  const errs = [];
  for (let k = SKIP; k < beats.length; k++) {
    const b = beats[k]; if (b < 0.3 || b > dur - 0.3) continue;
    const a = onsetOf(env, sr, b, floor); if (a == null) continue;
    const d = (b - a) * 1000;
    if (Math.abs(d) > 80) continue;                    // drop ambiguous beats (no clean kick) > 80ms
    errs.push(d);
  }
  if (errs.length >= 20) perTrack.push({ name: path.split("/").pop(), errs });
  process.stdout.write(`${path.split("/").pop().slice(0, 38).padEnd(40)} n=${errs.length} med=${med(errs).toFixed(1)}ms\n`);
}

const all = perTrack.flatMap((t) => t.errs);
const globalMed = med(all);
// residual after a single GLOBAL shift (subtract global median)
const afterGlobal = all.map((v) => v - globalMed);
// residual after PER-TRACK shift (subtract each track's own median)
const afterPerTrack = perTrack.flatMap((t) => { const m = med(t.errs); return t.errs.map((v) => v - m); });
const trackMeds = perTrack.map((t) => med(t.errs));

console.log(`\n=== (grid − true_kick) decomposition · ${perTrack.length} tracks, n=${all.length} strong kicks ===`);
console.log(`RAW:                 median=${globalMed.toFixed(1)}ms   within ±3ms=${within(all,3).toFixed(0)}%  ±5ms=${within(all,5).toFixed(0)}%  ±10ms=${within(all,10).toFixed(0)}%`);
console.log(`per-track medians:   ${trackMeds.map((m)=>m.toFixed(0)).join(", ")} ms`);
console.log(`  → spread of per-track medians: ${Math.min(...trackMeds).toFixed(0)} … ${Math.max(...trackMeds).toFixed(0)} ms (if tight → ONE global offset; if wide → per-track)`);
console.log(`AFTER GLOBAL −${globalMed.toFixed(0)}ms shift:   within ±3ms=${within(afterGlobal,3).toFixed(0)}%  ±5ms=${within(afterGlobal,5).toFixed(0)}%  ±10ms=${within(afterGlobal,10).toFixed(0)}%`);
console.log(`AFTER PER-TRACK shift:        within ±3ms=${within(afterPerTrack,3).toFixed(0)}%  ±5ms=${within(afterPerTrack,5).toFixed(0)}%  ±10ms=${within(afterPerTrack,10).toFixed(0)}%`);
console.log(`\nInterpretation: high % after GLOBAL shift → systematic, one-line fix. High only after PER-TRACK shift → per-track offsets (medium). Low even after per-track → irreducible scatter (hard).`);
