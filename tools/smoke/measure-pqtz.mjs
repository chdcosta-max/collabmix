// measure-pqtz.mjs — does REKORDBOX's OWN grid sit on the audio kick?
// Reconstruct Rekordbox's uniform grid from its ground-truth (firstDownbeatSec
// + BPM = exactly what the app's PQTZ/rkGridFromRecord path builds) and measure
// each beat vs the true 40-200Hz kick onset. If tight near 0 → the PQTZ grid is
// good and any in-app misalignment is the RENDER smear. If offset → even
// Rekordbox's grid is off the raw kick (the perceptual-offset ceiling).
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { decode, kickEnvelope, envFloor, onsetOf } from "./lib/audio.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACKDIR = resolve(__dirname, "../bpm-test-harness/tracks");
const gt = JSON.parse(readFileSync(resolve(__dirname, "../bpm-test-harness/ground-truth.json"), "utf8"));
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const within = (xs, t) => 100 * xs.filter((v) => Math.abs(v) <= t).length / xs.length;

const all = [];
for (const [name, g] of Object.entries(gt)) {
  if (name === "_comment" || !g.bpm || g.firstDownbeatSec == null) continue;
  let dec; try { dec = await decode(resolve(TRACKDIR, name)); } catch { continue; }
  const { sr, mono, dur } = dec;
  const env = kickEnvelope(mono, sr), floor = envFloor(env);
  const period = 60 / g.bpm;
  const errs = [];
  for (let t = g.firstDownbeatSec; t < dur - 0.3; t += period) {
    if (t < 0.3) continue;
    const a = onsetOf(env, sr, t, floor); if (a == null) continue;
    const d = (t - a) * 1000;
    if (Math.abs(d) > 80) continue;       // skip beats with no clean kick
    errs.push(d);
  }
  if (errs.length < 10) continue;
  all.push(...errs);
  process.stdout.write(`${name.slice(0, 40).padEnd(42)} bpm=${g.bpm} n=${errs.length} med=${med(errs).toFixed(1)}ms within5=${within(errs, 5).toFixed(0)}%\n`);
}
console.log(`\n=== REKORDBOX PQTZ grid − true audio kick · n=${all.length} beats across ${Object.keys(gt).length - 1} tracks ===`);
console.log(`median=${med(all).toFixed(1)}ms   within ±3ms=${within(all, 3).toFixed(0)}%   ±5ms=${within(all, 5).toFixed(0)}%   ±10ms=${within(all, 10).toFixed(0)}%`);
console.log(`(tight near 0 → PQTZ grid is on the kick → in-app misalignment is render smear.`);
console.log(` offset/scatter → even Rekordbox's grid is off the raw kick = perceptual-offset ceiling.)`);
