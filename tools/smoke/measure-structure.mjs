// measure-structure.mjs — where does the grid sit relative to the DRAWN waveform
// envelope's valleys (pinches) and peaks (swells)? Rekordbox: line AT the valley,
// swell AFTER. Measure, on the drawn bass RMS envelope, per grid line:
//   normPos  = (env@line − valley) / (peak − valley)   [0 = at pinch, 1 = at swell peak]
//   valleyMs = (valley_time − line)  [negative = valley is BEFORE the line → line past pinch]
//   pinch    = peak/valley ratio in the beat window  [high = clear pinch; ~1 = flat blob, no pinch]
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decode, runWorker, kickEnvelope, envFloor, onsetOf } from "./lib/audio.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACKDIR = resolve(__dirname, "../bpm-test-harness/tracks");
const NAMES = [
  "03 Sparky (Original Mix).mp3", "06 Logical (Extended Mix).mp3",      // SHARP kicks
  "Way Out West - Tuesday Maybe (Guy J Remix).mp3",                      // medium
  "Kyotto - Home In The Sky (Original Mix).mp3", "Tantum - It Has To Be Like This (Original Mix).mp3",
  "Michael A - Sunbeam (HAFT Extended Remix).mp3",                      // SOFT melodic (user genre)
];
const WFW = 262144;
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
function bassRMS(cd, length, sr, wfw) {
  const aB = Math.exp(-2 * Math.PI * 300 / sr), step = Math.max(1, length / wfw);
  const b = new Float64Array(wfw), cnt = new Float64Array(wfw);
  for (let ch = 0; ch < cd.length; ch++) { const d = cd[ch]; let lp = 0; for (let i = 0; i < length; i++) { lp = aB * lp + (1 - aB) * d[i]; const x = Math.min(wfw - 1, Math.floor(i / step)); b[x] += lp * lp; cnt[x]++; } }
  for (let x = 0; x < wfw; x++) b[x] = Math.sqrt(b[x] / (cnt[x] || 1));
  let mx = 0; for (const v of b) mx = v > mx ? v : mx; const o = new Float32Array(wfw); if (mx > 1e-4) for (let i = 0; i < wfw; i++) o[i] = b[i] / mx; return o;
}
const at = (env, len, dur, t) => { const x = Math.round(t / dur * len); return env[x < 0 ? 0 : x >= len ? len - 1 : x]; };

console.log("track                                  pinch(pk/val)  grid@norm[0=valley,1=swell]  valleyOffset  peakOffset");
for (const name of NAMES) {
  let dec; try { dec = await decode(resolve(TRACKDIR, name)); } catch { continue; }
  const { sr, channelData, length, dur, mono } = dec;
  const env = kickEnvelope(mono, sr), floor = envFloor(env);
  const res = runWorker(channelData, sr, "anc", true); const bts = res.beatTimes, p = res.beatPeriodSec;
  const bassN = bassRMS(channelData, length, sr, WFW);
  const len = bassN.length;
  const norm = [], valOff = [], pkOff = [], pinch = [];
  for (let k = 8; k < bts.length; k++) {
    const g = bts[k]; if (g < 0.5 || g > dur - p) continue;
    if (onsetOf(env, sr, g, floor) == null) continue;                 // strong-kick beats only
    // beat window: from a bit before the line to most of the way to the next beat
    const t0 = g - 0.35 * p, t1 = g + 0.65 * p; const N = 200;
    let vMin = Infinity, vT = g, pMax = -Infinity, pT = g;
    for (let s = 0; s <= N; s++) { const t = t0 + (t1 - t0) * s / N; const v = at(bassN, len, dur, t); if (v < vMin) { vMin = v; vT = t; } if (v > pMax) { pMax = v; pT = t; } }
    const eAt = at(bassN, len, dur, g);
    if (pMax - vMin < 1e-4) continue;
    norm.push((eAt - vMin) / (pMax - vMin));
    valOff.push((vT - g) * 1000); pkOff.push((pT - g) * 1000);
    pinch.push(vMin > 1e-4 ? pMax / vMin : 99);
  }
  if (!norm.length) continue;
  console.log(`  ${name.slice(0, 36).padEnd(38)} ${med(pinch).toFixed(1).padStart(6)}        ${med(norm).toFixed(2).padStart(5)}                ${med(valOff).toFixed(0).padStart(5)}ms     ${med(pkOff).toFixed(0).padStart(5)}ms`);
}
console.log(`\nRekordbox target: grid@norm≈0 (AT the valley/pinch), valleyOffset≈0 (valley on the line), peak well after.`);
console.log(`pinch≈1 means NO valley between kicks (sustained-bass blob) — the envelope never necks down.`);
