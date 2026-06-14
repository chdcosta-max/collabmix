// measure-transient.mjs — answers two questions on real tracks:
//  (1) Does the high-mid TRANSIENT lead the BASS body (so the grid should attach
//      to the sharp transient, not the wide bass)?
//  (2) Is each kick ASYMMETRIC (sharp attack rise << gradual decay) per band, and
//      how SUSTAINED is the bass (valley/peak) — i.e. does the bass have a clean
//      sharp LEFT EDGE or is it a wide blob with energy on both sides?
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decode, runWorker, kickEnvelope, envFloor, onsetOf } from "./lib/audio.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACKDIR = resolve(__dirname, "../bpm-test-harness/tracks");
const NAMES = [
  "03 Sparky (Original Mix).mp3",
  "Way Out West - Tuesday Maybe (Guy J Remix).mp3",
  "Kyotto - Home In The Sky (Original Mix).mp3",
  "Tantum - It Has To Be Like This (Original Mix).mp3",
  "Michael A - Sunbeam (HAFT Extended Remix).mp3",
];
const WFW = 262144;
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

function bandsRMS(cd, length, sr, wfw) {
  const aB = Math.exp(-2 * Math.PI * 300 / sr), aM = Math.exp(-2 * Math.PI * 3500 / sr), step = Math.max(1, length / wfw);
  const B = new Float64Array(wfw), M = new Float64Array(wfw), H = new Float64Array(wfw), cnt = new Float64Array(wfw);
  for (let ch = 0; ch < cd.length; ch++) { const d = cd[ch]; let lpB = 0, lpM = 0;
    for (let i = 0; i < length; i++) { const s = d[i]; lpB = aB * lpB + (1 - aB) * s; lpM = aM * lpM + (1 - aM) * s; const x = Math.min(wfw - 1, Math.floor(i / step)); B[x] += lpB * lpB; const mv = lpM - lpB, hv = s - lpM; M[x] += mv * mv; H[x] += hv * hv; cnt[x]++; } }
  const fin = (A) => { for (let x = 0; x < wfw; x++) A[x] = Math.sqrt(A[x] / (cnt[x] || 1)); let mx = 0; for (const v of A) mx = v > mx ? v : mx; const o = new Float32Array(wfw); if (mx > 1e-4) for (let i = 0; i < wfw; i++) o[i] = A[i] / mx; return o; };
  return { bass: fin(B), mid: fin(M), high: fin(H) };
}
// onset(15% gate), peak, rise(ms), decay(ms back to gate) of env near time t.
function shape(e, len, dur, t) {
  const bps = len / dur, i0 = Math.max(1, Math.round((t - 0.06) * bps)), iP = Math.min(len - 1, Math.round((t + 0.08) * bps));
  let peak = 0, pk = i0; for (let i = i0; i <= iP; i++) if (e[i] > peak) { peak = e[i]; pk = i; }
  let fl = 1; for (let i = Math.max(0, pk - Math.round(0.05 * bps)); i < pk; i++) if (e[i] < fl) fl = e[i];
  if (peak - fl < 0.02) return null;
  const g = fl + 0.15 * (peak - fl);
  let j = pk; while (j > i0 && e[j] >= g) j--;                       // walk back → onset
  let d = pk, dlim = Math.min(len - 1, pk + Math.round(0.25 * bps)); while (d < dlim && e[d] >= g) d++; // walk fwd → decay end
  return { onset: (j + 1) / bps, riseMs: (pk - (j + 1)) / bps * 1000, decayMs: (d - pk) / bps * 1000 };
}

console.log("track                     midLeadsBassBy   bass(rise/decay)   mid(rise/decay)   high(rise/decay)  [ms]");
for (const name of NAMES) {
  let dec; try { dec = await decode(resolve(TRACKDIR, name)); } catch { continue; }
  const { sr, channelData, length, dur, mono } = dec;
  const env = kickEnvelope(mono, sr), floor = envFloor(env);
  const beats = runWorker(channelData, sr, "anc", true).beatTimes;
  const bn = bandsRMS(channelData, length, sr, WFW); const len = bn.bass.length;
  const lead = [], br = [], bd = [], mr = [], mdc = [], hr = [], hd = [];
  for (let k = 8; k < beats.length; k++) {
    const b = beats[k]; if (b < 0.5 || b > dur - 0.3) continue;
    if (onsetOf(env, sr, b, floor) == null) continue;
    const sb = shape(bn.bass, len, dur, b), sm = shape(bn.mid, len, dur, b), sh = shape(bn.high, len, dur, b);
    if (!sb || !sm) continue;
    lead.push((sb.onset - sm.onset) * 1000); br.push(sb.riseMs); bd.push(sb.decayMs); mr.push(sm.riseMs); mdc.push(sm.decayMs);
    if (sh) { hr.push(sh.riseMs); hd.push(sh.decayMs); }
  }
  if (!lead.length) continue;
  console.log(`  ${name.slice(0, 24).padEnd(26)} ${med(lead).toFixed(1).padStart(6)}ms      ${med(br).toFixed(0)}/${med(bd).toFixed(0).padEnd(4)}        ${med(mr).toFixed(0)}/${med(mdc).toFixed(0).padEnd(4)}       ${med(hr).toFixed(0)}/${med(hd).toFixed(0)}`);
}
console.log("\nmidLeadsBassBy>0 → high-mid transient ONSET is earlier than the bass onset (attach grid to transient).");
console.log("rise<<decay → asymmetric (sharp attack, gradual decay). Big bass decay = wide body blooming AFTER the attack.");
