// measure-smear.mjs — DISAMBIGUATE the grid-vs-kick problem on real tracks.
// For each STRONG kick we measure three distances (ms):
//   A) workerBeat − trueKick   = the GRID's placement vs the actual kick (analyzer)
//   B) drawnFront − trueKick    = the RENDERING smear (drawn blob front vs kick)
//   C) drawnFront − workerBeat  = what the user SEES (grid line vs drawn front;
//                                 negative = grid sits INSIDE the blob)
// Run at the best render config (RMS, high-res bass) so we isolate the cause.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decode, runWorker, kickEnvelope, envFloor, onsetOf } from "./lib/audio.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACKS = [
  "Kyotto - Home In The Sky (Original Mix).mp3",
  "Tantum - It Has To Be Like This (Original Mix).mp3",
  "Michael A - Sunbeam (HAFT Extended Remix).mp3",
  "Way Out West - Tuesday Maybe (Guy J Remix).mp3",
].map((f) => resolve(__dirname, "../bpm-test-harness/tracks", f));

const WINDOW_SEC = 4, PHYS_W = 1100, EDGE = 0.15, SKIP_BEATS = 8;
const stat = (xs) => {
  if (!xs.length) return { n: 0 };
  const s = [...xs].sort((a, b) => a - b), q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  const within = (t) => (100 * xs.filter((v) => Math.abs(v) <= t).length / xs.length);
  return { n: xs.length, med: q(0.5), p25: q(0.25), p75: q(0.75), p10: q(0.10), p90: q(0.90), w3: within(3), w5: within(5), w10: within(10) };
};
const show = (lbl, st) => console.log(`  ${lbl.padEnd(34)} med=${st.med.toFixed(1).padStart(6)}  IQR[${st.p25.toFixed(0)},${st.p75.toFixed(0)}]  p10/90[${st.p10.toFixed(0)},${st.p90.toFixed(0)}]  ≤3ms:${st.w3.toFixed(0)}%  ≤5ms:${st.w5.toFixed(0)}%  ≤10ms:${st.w10.toFixed(0)}%  n=${st.n}`);

function bandsRMS(channelData, length, sr, wfw) {
  const aB = Math.exp(-2 * Math.PI * 300 / sr), aM = Math.exp(-2 * Math.PI * 3500 / sr), step = Math.max(1, length / wfw);
  const b = new Float64Array(wfw), cnt = new Float64Array(wfw);
  for (let ch = 0; ch < channelData.length; ch++) { const d = channelData[ch]; let lpB = 0, lpM = 0;
    for (let i = 0; i < length; i++) { const s = d[i]; lpB = aB * lpB + (1 - aB) * s; lpM = aM * lpM + (1 - aM) * s; const x = Math.min(wfw - 1, Math.floor(i / step)); b[x] += lpB * lpB; cnt[x]++; } }
  for (let x = 0; x < wfw; x++) { const c = cnt[x] || 1; b[x] = Math.sqrt(b[x] / c); }
  let mx = 0; for (const v of b) mx = v > mx ? v : mx; const o = new Float32Array(wfw); if (mx > 1e-4) for (let i = 0; i < wfw; i++) o[i] = b[i] / mx;
  return o; // normalized bass envelope
}
// Drawn leading edge of the bass band near tCenter; also returns peak strength.
function drawnBassEdge(bassN, dur, tCenter, len) {
  const viewPx = (WINDOW_SEC / dur) * len, srcX = (tCenter / dur) * len - viewPx / 2, spp = viewPx / PHYS_W;
  const envs = new Float32Array(PHYS_W);
  for (let dx = 0; dx < PHYS_W; dx++) {
    const f0 = srcX + dx * spp, f1 = f0 + spp; let s0 = f0 | 0, s1 = f1 | 0;
    s0 = s0 < 0 ? 0 : s0 >= len ? len - 1 : s0; s1 = s1 < s0 ? s0 : s1 >= len ? len - 1 : s1;
    let v = 0; for (let k = s0; k <= s1; k++) if (bassN[k] > v) v = bassN[k];
    envs[dx] = v;
  }
  const cC = Math.round(PHYS_W / 2); let peak = 0, pk = cC;
  for (let dx = Math.max(0, cC - 120); dx <= Math.min(PHYS_W - 1, cC + 60); dx++) if (envs[dx] > peak) { peak = envs[dx]; pk = dx; }
  let floor = 1; for (let dx = Math.max(0, pk - 160); dx < pk; dx++) if (envs[dx] < floor) floor = envs[dx];
  if (peak <= floor) return null;
  const gate = floor + EDGE * (peak - floor); let j = pk; while (j > 0 && envs[j] >= gate) j--;
  return { edge: ((srcX + (j + 1) * spp) / len) * dur, strength: peak - floor };
}

const WFW = 262144; // high-res local
const A = [], B = [], C = [];
for (const path of TRACKS) {
  const { sr, channelData, length, dur, mono } = await decode(path);
  const env = kickEnvelope(mono, sr), floor = envFloor(env);
  const onsets = runWorker(channelData, sr, "anc", true).beatTimes;
  const bassN = bandsRMS(channelData, length, sr, WFW);
  process.stdout.write(`${path.split("/").pop()}  dur=${dur.toFixed(0)}s beats=${onsets.length}\n`);
  for (let k = SKIP_BEATS; k < onsets.length; k++) {
    const b = onsets[k]; if (b < 0.3 || b > dur - 0.3) continue;
    const a = onsetOf(env, sr, b, floor); if (a == null) continue;               // true kick onset
    const de = drawnBassEdge(bassN, dur, b, WFW); if (de == null) continue;
    if (de.strength < 0.18) continue;                                            // STRONG kicks only
    A.push((b - a) * 1000);          // grid vs true kick (analyzer)
    B.push((de.edge - a) * 1000);    // drawn front vs true kick (render smear)
    C.push((de.edge - b) * 1000);    // drawn front vs grid (what user sees)
  }
}
console.log(`\n=== strong-kick distribution, RMS bass @ WF_W=${WFW} (≈${(1000 / (WFW / 450)).toFixed(1)}ms buckets on a 7.5min track) ===`);
console.log("negative = earlier in time. Want B and C tight near zero.\n");
show("A) grid − trueKick (ANALYZER)", stat(A));
show("B) drawnFront − trueKick (SMEAR)", stat(B));
show("C) drawnFront − grid (USER SEES)", stat(C));
