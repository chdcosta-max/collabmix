// desmear.smoke.mjs — the Phase 2 render de-smear must move each kick's DRAWN
// leading edge onto the onset. Replicates the big-WF column render at max zoom,
// measures the drawn blob leading edge before/after the de-smear pass vs the
// raw-sample onset. Gates: |after| < 10ms AND ≥40% closer than before.
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Suite, med } from "../lib/result.mjs";
import { decode, runWorker, kickEnvelope, envFloor, onsetOf, bands, WF_W } from "../lib/audio.mjs";
import { ensureFixture } from "../lib/gen-fixture.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WINDOW_SEC = 4, PHYS_W = 1100, EDGE = 0.15, SKIP_BEATS = 4, N_KICKS = 24;
const MAX_AFTER_MS = 10, MIN_REDUCTION = 0.40;
const TARGET_BUCKET_MS = 19;   // mimic a real (minutes-long) track's WF_W=24000 bucket
const t = new Suite("desmear-render");

let tracks;
if (process.env.SMOKE_TRACKS) {
  const dir = resolve(__dirname, "../../bpm-test-harness/tracks");
  tracks = process.env.SMOKE_TRACKS.split(",").map((f) => resolve(dir, f.trim())).filter(existsSync);
  if (!tracks.length) t.skip("SMOKE_TRACKS set but no listed files found");
} else { tracks = [ensureFixture()]; }

// Drawn-blob leading edge (seconds) at max zoom centered on tCenter; optional
// de-smear. `len` = bucket count (production WF_W on a real track; scaled here).
function drawnEdge(bnd, dur, tCenter, onsets, desmear, len) {
  const bA = bnd.bass, mA = bnd.mid, hA = bnd.high;
  const viewPx = (WINDOW_SEC / dur) * len, srcX = (tCenter / dur) * len - viewPx / 2, spp = viewPx / PHYS_W;
  let div = 0; for (let i = 0; i < len; i++) { const v = 0.7 * bA[i] + 0.2 * mA[i] + 0.1 * hA[i]; if (v > div) div = v; } if (div < 1e-4) div = 1;
  const envs = new Float32Array(PHYS_W);
  for (let dx = 0; dx < PHYS_W; dx++) {
    const f0 = srcX + dx * spp, f1 = f0 + spp; let s0 = f0 | 0, s1 = f1 | 0;
    s0 = s0 < 0 ? 0 : s0 >= len ? len - 1 : s0; s1 = s1 < s0 ? s0 : s1 >= len ? len - 1 : s1;
    let b = 0, m = 0, h = 0; for (let k = s0; k <= s1; k++) { if (bA[k] > b) b = bA[k]; if (mA[k] > m) m = mA[k]; if (hA[k] > h) h = hA[k]; }
    envs[dx] = (0.7 * b + 0.2 * m + 0.1 * h) / div;
  }
  if (desmear) {
    const bucketSec = dur / len, SMEAR = Math.min(0.025, Math.max(0.008, bucketSec * 1.5));
    const tLeft = (srcX / len) * dur, tRight = ((srcX + viewPx) / len) * dur;
    for (const ot of onsets) {
      if (ot < tLeft - SMEAR || ot > tRight) continue;
      const xOn = ((ot / dur) * len - srcX) / spp, xSt = (((ot - SMEAR) / dur) * len - srcX) / spp;
      const c0 = Math.max(0, Math.ceil(xSt)), c1 = Math.min(PHYS_W - 1, Math.floor(xOn) - 1);
      if (c1 < c0) continue; const base = envs[c0];
      for (let dx = c0; dx <= c1; dx++) if (envs[dx] > base) envs[dx] = base;
    }
  }
  const cC = Math.round(PHYS_W / 2); let peak = 0, pk = cC;
  for (let dx = Math.max(0, cC - 120); dx <= Math.min(PHYS_W - 1, cC + 60); dx++) if (envs[dx] > peak) { peak = envs[dx]; pk = dx; }
  let floor = 1; for (let dx = Math.max(0, pk - 160); dx < pk; dx++) if (envs[dx] < floor) floor = envs[dx];
  if (peak <= floor) return null;
  const gate = floor + EDGE * (peak - floor); let j = pk; while (j > 0 && envs[j] >= gate) j--;
  return ((srcX + (j + 1) * spp) / len) * dur;
}

const before = [], after = [];
for (const path of tracks) {
  const { sr, channelData, length, dur, mono } = await decode(path);
  // Bucket count for a real-track-equivalent smear. On a real minutes-long
  // track WF_W=24000 already gives ~19ms buckets; on a short fixture/track we
  // scale down so the same smear is exercised. Never exceeds production WF_W.
  const WFW = Math.min(WF_W, Math.max(64, Math.round(dur / (TARGET_BUCKET_MS / 1000))));
  const env = kickEnvelope(mono, sr), floor = envFloor(env), bnd = bands(channelData, length, sr, WFW);
  const onsets = runWorker(channelData, sr, "anc", true).beatTimes;
  let used = 0;
  for (let k = SKIP_BEATS; k < onsets.length && used < N_KICKS; k++) {
    const b = onsets[k]; if (b < 0.2 || b > dur - 0.2) continue;
    const a = onsetOf(env, sr, b, floor); if (a == null) continue;
    const cB = drawnEdge(bnd, dur, b, onsets, false, WFW), cA = drawnEdge(bnd, dur, b, onsets, true, WFW);
    if (cB == null || cA == null) continue;
    before.push((cB - a) * 1000); after.push((cA - a) * 1000); used++;
  }
}
if (!after.length) t.fail("no reliable kicks measured");
const mb = Math.abs(med(before)), ma = Math.abs(med(after)), reduction = 1 - ma / Math.max(1e-6, mb);
t.check(`drawn edge within ${MAX_AFTER_MS}ms of onset after de-smear`, ma < MAX_AFTER_MS, `before=${med(before).toFixed(1)}ms → after=${med(after).toFixed(1)}ms`);
t.check(`de-smear closes ≥${MIN_REDUCTION * 100}% of the gap`, reduction >= MIN_REDUCTION, `${(reduction * 100).toFixed(0)}% closer (n=${after.length})`);
t.done();
