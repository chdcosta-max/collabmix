// conn-quality.js — passive connection-quality classifier (the "forecast" for the
// intermittent-network-weather bug class). Pure logic, no DOM/WebRTC — imported by
// both the app (useRTC's stats poll) and the smoke suite's unit gate, following the
// rekordbox-grid.js pattern.
//
// Classifies the RECEIVER-side stats the app already polls (no new getStats) into
// good / marginal / poor. WARN-ONLY — nothing here (or downstream) auto-applies a
// lever; levers stay manual until proven on a real bad network (Chad, July 3).
//
// ── Bands — derived from measured sessions, not invented ────────────────────────
// CLEAN (July 2 Jake two-way tail + loopback/relay runs):
//   jbTargetMs 220 flat · jitterMs 2-19 · concealMs/2s 0 (one 20ms blip all night)
//   · lostΔ 0-1 · rtt 21-37
// MILD-BUT-HARMLESS (harness calib profile — jitter provably landing, no symptom):
//   jbTargetMs 225-229 · jitterMs 17-19 · conceal p90 ~23 · buffer stayed at floor
// POOR (harness frozen Jake profile + bw-cap runs; Jake's real June sessions):
//   jbTargetMs 476-650 · jitterMs 37-77 · conceal bursts 20-420 · loss to 27% ·
//   rtt 158-1436 (bufferbloat) · comp saturating the 400ms cap = the audible flam
// NOTE the measured gap: no session has yet LIVED between jbTarget ~230 and ~476.
// The marginal band (260-379) is interpolated — the escalation point where NetEQ
// demonstrably left the floor but comp isn't yet near saturation. Bands are
// constants below so a real marginal session can recalibrate them in one place.
//
// jbTargetMs is the primary signal (it IS the flam precursor: comp saturates when
// measured ≈ jbTarget+playout exceeds the 400 cap → poor starts at 380). rttMs is
// deliberately capped at "marginal": a TURN long-haul adds honest baseline RTT
// with zero audible symptom — rtt alone must never paint POOR.

export const CONN_BANDS = {
  jbTargetMs: { marginal: 260, poor: 380 },
  jitterMs:   { marginal: 25,  poor: 50 },
  concealMs:  { marginal: 40,  poor: 150 },   // per ~2s stats window
  lostPct:    { marginal: 2,   poor: 8 },     // % of expected packets, per window
  rttMs:      { marginal: 600, poor: Infinity }, // corroborator only — never poor alone
};

const SEV = { good: 0, marginal: 1, poor: 2 };
const LEVELS = ["good", "marginal", "poor"];

// Classify ONE stats window (the ~2s JITTER-DIAG cadence). Missing/null signals
// are skipped, worst signal wins. Returns { level, reason } — reason names the
// driving signal + value for the [CONN-QUALITY] log and the tooltip debugging.
export function classifyConnWindow(w) {
  let level = 0, reason = "all signals clean";
  for (const key of Object.keys(CONN_BANDS)) {
    const v = w?.[key];
    if (v == null || !Number.isFinite(v)) continue;
    const b = CONN_BANDS[key];
    const sev = v >= b.poor ? 2 : v >= b.marginal ? 1 : 0;
    if (sev > level) { level = sev; reason = `${key}=${Math.round(v)} ≥ ${sev === 2 ? b.poor : b.marginal}`; }
  }
  return { level: LEVELS[level], reason };
}

// Sustain state machine (anti-flap — the Quiet principle applied to a warning).
// Escalation needs `escalateWindows` CONSECUTIVE windows at ≥ that severity
// (default 3 ≈ 6s); clearing needs `clearWindows` consecutive good (default 5 ≈
// 10s). July 2's lone clean-network blip (one concealMs=20 + lostΔ=1 window) is
// a non-event twice over: below every band AND unsustained.
export function createConnQualityTracker({ escalateWindows = 3, clearWindows = 5 } = {}) {
  let level = "good";           // the SUSTAINED level consumers render
  let candidate = null;         // { level, count } of a pending escalation
  let goodStreak = 0;
  return {
    level: () => level,
    // Push one window; returns { level, changed, reason } for the transition log.
    push(w) {
      const { level: raw, reason } = classifyConnWindow(w);
      let changed = false;
      if (SEV[raw] > SEV[level]) {
        goodStreak = 0;
        if (candidate && SEV[raw] >= SEV[candidate.level]) candidate.count++;
        else candidate = { level: raw, count: 1 };
        if (candidate.count >= escalateWindows) {
          level = candidate.level; candidate = null; changed = true;
        }
      } else if (raw === "good" && level !== "good") {
        candidate = null;
        if (++goodStreak >= clearWindows) { level = "good"; goodStreak = 0; changed = true; }
      } else {
        // same level, or a lower-but-not-good level: hold, reset the counters
        candidate = null; goodStreak = 0;
      }
      return { level, changed, reason };
    },
  };
}
