// Simulate the cumulative getStats counters across a transport interruption that
// (a) STALLS the jitter buffer for ~1.5s and (b) leaves the TRUE delay changed
// (30ms → 120ms, buffer rebuilt larger). Compare OLD poller (lifetime-average
// fallback when samples don't advance) vs NEW (re-baseline + delta + fast settle).
const SR = 48000, POLL = 700, FRAME = 1000/60, TC_SLOW = 1500, TC_FAST = 300;
const EVENT_T = 10000, STALL_MS = 1500, D1 = 0.030, D2 = 0.120, RUN = 20000;

// Build a ground-truth timeline of cumulative (emitted, jbd) at 1ms resolution.
let emitted = 0, jbd = 0; const truth = [];
for (let t = 0; t <= RUN; t++) {
  const trueDelay = t < EVENT_T ? D1 : D2;
  const stalled = t >= EVENT_T && t < EVENT_T + STALL_MS;     // emittedCount frozen
  if (!stalled) { const dE = SR/1000; emitted += dE; jbd += trueDelay * dE; }
  truth[t] = { emitted, jbd };
}
const sample = t => truth[Math.max(0, Math.min(RUN, Math.round(t)))];

function run(mode) {
  let prev = null, compMs = 0, settleUntil = 0, applied = 0, maxErrAfter = 0, convergedAt = null;
  let nextPoll = 0;
  for (let t = 0; t <= RUN; t += FRAME) {
    if (t >= nextPoll) {
      const s = sample(t); const now = t;
      if (mode === 'old') {
        // OLD: delta when emitted advanced, else LIFETIME average.
        let jbMs;
        if (prev && s.emitted > prev.jbe) jbMs = ((s.jbd - prev.jbd)/(s.emitted - prev.jbe))*1000;
        else jbMs = (s.jbd / s.emitted) * 1000;          // lifetime fallback
        compMs = jbMs;
        prev = { jbd: s.jbd, jbe: s.emitted, ts: now };
        nextPoll += 1500;
      } else {
        const dEmit = prev ? s.emitted - prev.jbe : 0;
        const dt = prev ? (now - prev.ts)/1000 : 0;
        const transportSince = prev ? EVENT_T > prev.ts && EVENT_T <= now : true;
        const rateCollapsed = prev ? dEmit <= 0.5*(dt*SR) : false;
        if (!prev || s.emitted < prev.jbe || transportSince || rateCollapsed) {
          prev = { jbd: s.jbd, jbe: s.emitted, ts: now }; settleUntil = now + 4000; // skip, keep compMs
        } else {
          compMs = ((s.jbd - prev.jbd)/dEmit)*1000;
          prev = { jbd: s.jbd, jbe: s.emitted, ts: now };
        }
        nextPoll += 700;
      }
    }
    // slew applied → compMs (clamped), fast TC while settling
    const measured = Math.max(0, Math.min(400, compMs));
    const tc = (mode === 'new' && t < settleUntil) ? TC_FAST : TC_SLOW;
    const alpha = 1 - Math.exp(-FRAME / tc);
    applied += (measured - applied) * alpha;
    if (t > EVENT_T + STALL_MS) {
      const err = Math.abs(applied - D2*1000);
      if (err > maxErrAfter && t < EVENT_T + 8000) maxErrAfter = err;
      if (convergedAt === null && err < 10) convergedAt = (t - EVENT_T) / 1000;
    }
  }
  return { finalApplied: applied, convergedAt, maxErrAfter };
}

const o = run('old'), n = run('new');
console.log('Scenario: true delay 30ms → 120ms with a 1.5s jitter-buffer stall at t=10s\n');
console.log('OLD  final applied: ' + o.finalApplied.toFixed(1) + 'ms  converged@: ' + (o.convergedAt ?? 'never') + 's');
console.log('NEW  final applied: ' + n.finalApplied.toFixed(1) + 'ms  converged@: ' + (n.convergedAt ?? 'never') + 's');
console.log('\nTarget after event: 120ms');
console.log('OLD stuck near old value:', Math.abs(o.finalApplied - 30) < 40 ? 'YES (bug reproduced — sticks low)' : 'no, old=' + o.finalApplied.toFixed(0));
console.log('NEW re-converged < 5s   :', (n.convergedAt != null && n.convergedAt < 5) ? 'YES ✅ (' + n.convergedAt + 's)' : 'NO ❌');
