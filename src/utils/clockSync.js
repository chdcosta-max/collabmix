// Cristian's-algorithm clock offset estimator for cross-machine sync
// measurement. Bounces a small ping/pong off the partner via the existing
// WebSocket relay; per round-trip computes:
//   rtt    = t2 - t0                      // round-trip in my timebase (ms)
//   offset = t1 - (t0 + t2) / 2           // partner_now - my_now (ms)
// Maintains a rolling window of recent samples, rejects top-quartile RTT
// outliers (jittery samples dominated by network burst), and exposes the
// median offset over the remaining "good" samples + a confidence score
// derived from RTT spread (tight spread = high confidence).
//
// One-way latency estimate ≈ rttMedian / 2 (assumes symmetric paths,
// which holds well over WebSocket for stable connections).
//
// Usage:
//   const cs = createClockSync();
//   cs.addSample(t0_send, t1_partner_time, t2_recv);
//   const { offset, confidence, rttMedian, rttSpread, sampleCount } = cs.getOffset();
//   const partnerNow = performance.now() + offset; // remap to partner's clock
//
// All times in ms (performance.now() units).

const WINDOW_SIZE = 20;
const MIN_SAMPLES = 3;

export function createClockSync() {
  const samples = [];

  function addSample(t0, t1, t2) {
    const rtt = t2 - t0;
    const offset = t1 - (t0 + t2) / 2;
    samples.push({ rtt, offset });
    if (samples.length > WINDOW_SIZE) samples.shift();
  }

  function getOffset() {
    if (samples.length < MIN_SAMPLES) {
      return {
        offset: 0,
        confidence: 0,
        rttMedian: null,
        rttSpread: null,
        sampleCount: samples.length,
      };
    }
    // Reject top-quartile RTT outliers.
    const byRtt = [...samples].sort((a, b) => a.rtt - b.rtt);
    const keep = Math.max(MIN_SAMPLES, Math.floor(samples.length * 0.75));
    const good = byRtt.slice(0, keep);

    const offsets = good.map((s) => s.offset).sort((a, b) => a - b);
    const offset = offsets[offsets.length >> 1];

    const rtts = good.map((s) => s.rtt).sort((a, b) => a - b);
    const rttMedian = rtts[rtts.length >> 1];
    const rttSpread = rtts[rtts.length - 1] - rtts[0];

    // Confidence shrinks as spread grows relative to median. 0 spread = 1.0;
    // spread == median = 0. Floored at 0.
    const confidence = Math.max(
      0,
      Math.min(1, 1 - rttSpread / Math.max(1, rttMedian))
    );

    return {
      offset,
      confidence,
      rttMedian,
      rttSpread,
      sampleCount: samples.length,
    };
  }

  function reset() {
    samples.length = 0;
  }

  return { addSample, getOffset, reset };
}
