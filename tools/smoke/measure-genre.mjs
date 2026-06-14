// measure-genre.mjs — is the grid-vs-kick offset SOFT-KICK-specific or universal?
// For every track: measure analyzer grid−kick offset, the render smear (drawn bass
// front − kick), AND a kick-sharpness proxy (attack rise time onset→peak, ms).
// Then group by sharpness: if offset tracks softness → genre-specific; if high
// everywhere → universal.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";
import { decode, runWorker, kickEnvelope, envFloor, onsetOf } from "./lib/audio.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACKDIR = resolve(__dirname, "../bpm-test-harness/tracks");
const TRACKS = readdirSync(TRACKDIR).filter((f) => /\.(mp3|wav|flac)$/i.test(f)).map((f) => resolve(TRACKDIR, f));
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const within = (xs, t) => 100 * xs.filter((v) => Math.abs(v) <= t).length / xs.length;
const SKIP = 8, WFW = 262144, WIN = 4, PW = 1100, EDGE = 0.15;

function bassRMS(cd, length, sr, wfw) {
  const aB = Math.exp(-2 * Math.PI * 300 / sr), step = Math.max(1, length / wfw);
  const b = new Float64Array(wfw), cnt = new Float64Array(wfw);
  for (let ch = 0; ch < cd.length; ch++) { const d = cd[ch]; let lp = 0;
    for (let i = 0; i < length; i++) { lp = aB * lp + (1 - aB) * d[i]; const x = Math.min(wfw - 1, Math.floor(i / step)); b[x] += lp * lp; cnt[x]++; } }
  for (let x = 0; x < wfw; x++) b[x] = Math.sqrt(b[x] / (cnt[x] || 1));
  let mx = 0; for (const v of b) mx = v > mx ? v : mx; const o = new Float32Array(wfw); if (mx > 1e-4) for (let i = 0; i < wfw; i++) o[i] = b[i] / mx; return o;
}
function drawnFront(bassN, dur, tC, len) {
  const viewPx = (WIN / dur) * len, srcX = (tC / dur) * len - viewPx / 2, spp = viewPx / PW;
  const e = new Float32Array(PW);
  for (let dx = 0; dx < PW; dx++) { const f0 = srcX + dx * spp, f1 = f0 + spp; let s0 = f0 | 0, s1 = f1 | 0; s0 = s0 < 0 ? 0 : s0 >= len ? len - 1 : s0; s1 = s1 < s0 ? s0 : s1 >= len ? len - 1 : s1; let v = 0; for (let k = s0; k <= s1; k++) if (bassN[k] > v) v = bassN[k]; e[dx] = v; }
  const cC = Math.round(PW / 2); let peak = 0, pk = cC; for (let dx = Math.max(0, cC - 120); dx <= Math.min(PW - 1, cC + 60); dx++) if (e[dx] > peak) { peak = e[dx]; pk = dx; }
  let fl = 1; for (let dx = Math.max(0, pk - 160); dx < pk; dx++) if (e[dx] < fl) fl = e[dx]; if (peak <= fl) return null;
  const g = fl + EDGE * (peak - fl); let j = pk; while (j > 0 && e[j] >= g) j--; return ((srcX + (j + 1) * spp) / len) * dur;
}
// kick attack rise time (ms): onset(15% gate) → peak, from the 40-200Hz envelope.
function rise(env, sr, b, floor) {
  const i0 = Math.max(1, Math.floor((b - 0.06) * sr)), i1 = Math.min(env.length - 1, Math.floor((b + 0.06) * sr));
  let peak = 0, pk = i0; for (let i = i0; i <= i1; i++) if (env[i] > peak) { peak = env[i]; pk = i; }
  if (peak <= floor) return null;
  const gate = floor + 0.15 * (peak - floor); let j = pk; while (j > i0 && env[j] >= gate) j--;
  return { onset: (j + 1) / sr, riseMs: (pk - (j + 1)) / sr * 1000, strength: peak - floor };
}

const rows = [];
for (const path of TRACKS) {
  let dec; try { dec = await decode(path); } catch { continue; }
  const { sr, channelData, length, dur, mono } = dec;
  const env = kickEnvelope(mono, sr), floor = envFloor(env);
  const beats = runWorker(channelData, sr, "anc", true).beatTimes;
  const bassN = bassRMS(channelData, length, sr, WFW);
  const offs = [], smears = [], rises = [];
  for (let k = SKIP; k < beats.length; k++) {
    const b = beats[k]; if (b < 0.3 || b > dur - 0.3) continue;
    const r = rise(env, sr, b, floor); if (!r || r.strength < 0.18) continue;
    if (Math.abs((b - r.onset) * 1000) > 80) continue;
    offs.push((b - r.onset) * 1000); rises.push(r.riseMs);
    const f = drawnFront(bassN, dur, b, WFW); if (f != null) smears.push((f - r.onset) * 1000);
  }
  if (offs.length < 20) { process.stdout.write(`(skip ${path.split("/").pop().slice(0,30)} n=${offs.length})\n`); continue; }
  rows.push({ name: path.split("/").pop().slice(0, 36), off: med(offs), smear: med(smears), rise: med(rises), w5: within(offs, 5), n: offs.length });
  process.stdout.write(".");
}
process.stdout.write("\n\n");
rows.sort((a, b) => a.rise - b.rise);
console.log("track (sorted SHARP→SOFT kick)        riseMs  gridOff  within5  renderSmear");
for (const r of rows) console.log(`  ${r.name.padEnd(38)} ${r.rise.toFixed(1).padStart(5)}   ${r.off.toFixed(1).padStart(5)}ms  ${r.w5.toFixed(0).padStart(3)}%   ${r.smear.toFixed(1).padStart(6)}ms`);
const t = Math.ceil(rows.length / 3), grp = (a) => ({ off: med(a.map(r => r.off)), rise: med(a.map(r => r.rise)), w5: med(a.map(r => r.w5)), smear: med(a.map(r => r.smear)), n: a.length });
const sharp = grp(rows.slice(0, t)), midg = grp(rows.slice(t, 2 * t)), soft = grp(rows.slice(2 * t));
console.log(`\n=== grouped by kick sharpness (median per group) ===`);
console.log(`  SHARP kicks (rise≈${sharp.rise.toFixed(0)}ms, n=${sharp.n}):  gridOff=${sharp.off.toFixed(1)}ms  within5=${sharp.w5.toFixed(0)}%  smear=${sharp.smear.toFixed(1)}ms`);
console.log(`  MED   kicks (rise≈${midg.rise.toFixed(0)}ms, n=${midg.n}):  gridOff=${midg.off.toFixed(1)}ms  within5=${midg.w5.toFixed(0)}%  smear=${midg.smear.toFixed(1)}ms`);
console.log(`  SOFT  kicks (rise≈${soft.rise.toFixed(0)}ms, n=${soft.n}):  gridOff=${soft.off.toFixed(1)}ms  within5=${soft.w5.toFixed(0)}%  smear=${soft.smear.toFixed(1)}ms`);
