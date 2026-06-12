// interp.smoke.mjs — non-driver playhead interpolation: the rate-aware + slew
// model must NOT show backward sawtooth jumps a viewer would see when the
// driver plays SYNCED at off-1.0 rates. Pure sim, deterministic (seeded jitter).
// Gates: NEW worst backward visual step < 50ms across rates 0.90–1.06.
import { Suite } from "../lib/result.mjs";

const DUR = 360, FRAME_MS = 1000 / 60, RUN_MS = 120000, SLEW_TAU_MS = 220, SEEK_SNAP_SEC = 3, PKT_MS = 100;
let RATE = 0.94, seed = 12345;
const jit = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };

function run(mode) {
  let remProg = 0, remTime = 0, remRate = 0, remSlew = 0, lastVisible = null, maxBack = 0, nextPkt = 0;
  const trueRate = RATE / (DUR * 1000);
  const visibleAt = (now) => {
    const since = now - remTime;
    if (mode === "old") return Math.min(1, Math.max(0, remProg + remRate * since));
    const modeled = remProg + remRate * since, slew = remSlew * Math.exp(-since / SLEW_TAU_MS);
    return Math.min(1, Math.max(0, modeled + slew));
  };
  for (let now = 0; now <= RUN_MS; now += FRAME_MS) {
    const truth = 0.02 + trueRate * now;
    if (now >= nextPkt) {
      const pkt = truth + trueRate * (jit() * 30);
      if (mode === "old") {
        remRate = 1 / (DUR * 1000); const since = remTime ? now - remTime : 0;
        const cur = remTime ? remProg + remRate * since : pkt, drift = pkt - cur;
        if (remTime === 0 || Math.abs(drift) > 0.005) { remProg = pkt; remTime = now; }
        else if (drift > 0) { remProg = pkt; remTime = now; }
      } else {
        remRate = RATE / (DUR * 1000); const since = now - remTime;
        const visibleNow = remTime > 0 ? remProg + (remRate || 0) * since + remSlew * Math.exp(-since / SLEW_TAU_MS) : pkt;
        const driftSec = Math.abs(pkt - visibleNow) * DUR;
        if (remTime === 0 || driftSec > SEEK_SNAP_SEC) { remProg = pkt; remTime = now; remSlew = 0; }
        else { remProg = pkt; remTime = now; remSlew = visibleNow - pkt; }
      }
      nextPkt += PKT_MS;
    }
    const v = visibleAt(now);
    if (lastVisible != null) { const back = (lastVisible - v) * DUR; if (back > maxBack) maxBack = back; }
    lastVisible = v;
  }
  return maxBack;
}

const t = new Suite("interp-sawtooth");
let worstNew = 0, oldReproduced = false;
for (const r of [0.90, 0.94, 0.97, 1.03, 1.06]) {
  RATE = r; seed = 12345; const oldBack = run("old"); seed = 12345; const newBack = run("new");
  if (oldBack > 0.5) oldReproduced = true;
  if (newBack > worstNew) worstNew = newBack;
}
t.check("OLD model reproduces the sawtooth (sanity)", oldReproduced, "confirms the sim exercises the bug");
t.check("NEW worst backward step < 50ms", worstNew < 0.05, `worst=${(worstNew * 1000).toFixed(1)}ms across rates`);
t.done();
