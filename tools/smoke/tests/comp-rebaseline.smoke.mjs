// comp-rebaseline.smoke.mjs — delay-comp poller must re-baseline across a
// transport interruption (jitter-buffer stall + true delay 30ms→120ms) instead
// of sticking near the old value. Pure sim of the cumulative getStats counters.
// Gates: NEW re-converges to 120ms in <5s; OLD sticks low (sanity).
import { Suite } from "../lib/result.mjs";

const SR = 48000, FRAME = 1000 / 60, TC_SLOW = 1500, TC_FAST = 300;
const EVENT_T = 10000, STALL_MS = 1500, D1 = 0.030, D2 = 0.120, RUN = 20000;

let emitted = 0, jbd = 0; const truth = [];
for (let t = 0; t <= RUN; t++) {
  const trueDelay = t < EVENT_T ? D1 : D2, stalled = t >= EVENT_T && t < EVENT_T + STALL_MS;
  if (!stalled) { const dE = SR / 1000; emitted += dE; jbd += trueDelay * dE; }
  truth[t] = { emitted, jbd };
}
const sample = (t) => truth[Math.max(0, Math.min(RUN, Math.round(t)))];

function run(mode) {
  let prev = null, compMs = 0, settleUntil = 0, maxErrAfter = 0, convergedAt = null, nextPoll = 0, applied = 0;
  for (let t = 0; t <= RUN; t += FRAME) {
    if (t >= nextPoll) {
      const s = sample(t), now = t;
      if (mode === "old") {
        let jbMs; if (prev && s.emitted > prev.jbe) jbMs = ((s.jbd - prev.jbd) / (s.emitted - prev.jbe)) * 1000; else jbMs = (s.jbd / s.emitted) * 1000;
        compMs = jbMs; prev = { jbd: s.jbd, jbe: s.emitted, ts: now }; nextPoll += 1500;
      } else {
        const dEmit = prev ? s.emitted - prev.jbe : 0, dt = prev ? (now - prev.ts) / 1000 : 0;
        const transportSince = prev ? EVENT_T > prev.ts && EVENT_T <= now : true, rateCollapsed = prev ? dEmit <= 0.5 * (dt * SR) : false;
        if (!prev || s.emitted < prev.jbe || transportSince || rateCollapsed) { prev = { jbd: s.jbd, jbe: s.emitted, ts: now }; settleUntil = now + 4000; }
        else { compMs = ((s.jbd - prev.jbd) / dEmit) * 1000; prev = { jbd: s.jbd, jbe: s.emitted, ts: now }; }
        nextPoll += 700;
      }
    }
    const measured = Math.max(0, Math.min(400, compMs)), tc = mode === "new" && t < settleUntil ? TC_FAST : TC_SLOW;
    applied += (measured - applied) * (1 - Math.exp(-FRAME / tc));
    if (t > EVENT_T + STALL_MS) { const err = Math.abs(applied - D2 * 1000); if (err > maxErrAfter && t < EVENT_T + 8000) maxErrAfter = err; if (convergedAt === null && err < 10) convergedAt = (t - EVENT_T) / 1000; }
  }
  return { finalApplied: applied, convergedAt };
}

const o = run("old"), n = run("new");
const t = new Suite("comp-rebaseline");
t.check("NEW re-converges to 120ms < 5s", n.convergedAt != null && n.convergedAt < 5, `NEW converged@=${n.convergedAt ?? "never"}s, final=${n.finalApplied.toFixed(0)}ms`);
t.check("NEW recovers faster than OLD (sanity)", n.convergedAt != null && (o.convergedAt == null || n.convergedAt < o.convergedAt), `OLD converged@=${o.convergedAt ?? "never"}s vs NEW ${n.convergedAt ?? "never"}s`);
t.done();
