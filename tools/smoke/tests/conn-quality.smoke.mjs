// conn-quality.smoke.mjs — permanent gate for the ?connwarn classifier
// (src/conn-quality.js). Pure logic, no browser. Locks three properties:
//   1. BANDS — the measured clean profile (July 2 dogfood) classifies GOOD, the
//      measured deep-buffer profile (harness Jake repro / June sessions) POOR,
//      and the interpolated middle MARGINAL.
//   2. BLIP IMMUNITY — July 2's real clean-network blip (one concealMs=20 +
//      lostΔ=1 window) never surfaces a warning.
//   3. SUSTAIN — escalation needs 3 consecutive bad windows (~6s), clearing
//      needs 5 consecutive good (~10s); no flapping.
// NOTE: this is a UNIT gate by design — the mock WS server shapes the control
// plane only and cannot move RTP/NetEQ stats, so classifier logic gates here and
// the live poor-path is proven with the TURN jitter harness (measure-relay +
// NETEM_PROFILE, see VISION_5 July 3).
import { Suite } from "../lib/result.mjs";
import { classifyConnWindow, createConnQualityTracker, CONN_BANDS } from "../../../src/conn-quality.js";

const t = new Suite("conn-quality");

// ── 1. band classification on MEASURED profiles ─────────────────────────────
const CLEAN = { jbTargetMs: 220, jitterMs: 9, concealMs: 0, lostPct: 0, rttMs: 30 };          // July 2 two-way tail
const CLEAN_RELAY = { jbTargetMs: 220, jitterMs: 6, concealMs: 0, lostPct: 0, rttMs: 33 };    // TURN relay run
const MILD = { jbTargetMs: 229, jitterMs: 19, concealMs: 23, lostPct: 1, rttMs: 160 };        // harness mild profile (no symptom)
const DEEP = { jbTargetMs: 540, jitterMs: 40, concealMs: 30, lostPct: 1, rttMs: 200 };        // harness frozen Jake profile
const CONGESTED = { jbTargetMs: 500, jitterMs: 10, concealMs: 200, lostPct: 15, rttMs: 1400 };// bw-cap run
const MIDDLE = { jbTargetMs: 300, jitterMs: 30, concealMs: 60, lostPct: 3, rttMs: 100 };      // interpolated marginal

t.check("clean two-way profile = good", classifyConnWindow(CLEAN).level === "good", JSON.stringify(classifyConnWindow(CLEAN)));
t.check("clean relay profile = good", classifyConnWindow(CLEAN_RELAY).level === "good", JSON.stringify(classifyConnWindow(CLEAN_RELAY)));
t.check("mild-no-symptom profile = good (buffer at floor)", classifyConnWindow(MILD).level === "good", JSON.stringify(classifyConnWindow(MILD)));
t.check("deep-buffer (Jake repro) profile = poor", classifyConnWindow(DEEP).level === "poor", JSON.stringify(classifyConnWindow(DEEP)));
t.check("poor reason names the driving signal (jbTargetMs)", classifyConnWindow(DEEP).reason.startsWith("jbTargetMs"), classifyConnWindow(DEEP).reason);
t.check("self-congestion profile = poor", classifyConnWindow(CONGESTED).level === "poor", JSON.stringify(classifyConnWindow(CONGESTED)));
t.check("interpolated middle = marginal", classifyConnWindow(MIDDLE).level === "marginal", JSON.stringify(classifyConnWindow(MIDDLE)));

// rtt is a corroborator, never poor alone (TURN long-haul must not panic)
const RTT_ONLY = { jbTargetMs: 220, jitterMs: 8, concealMs: 0, lostPct: 0, rttMs: 900 };
t.check("extreme rtt alone caps at marginal (never poor)", classifyConnWindow(RTT_ONLY).level === "marginal", JSON.stringify(classifyConnWindow(RTT_ONLY)));

// missing signals are skipped, not treated as bad
t.check("null/missing signals classify good", classifyConnWindow({ jbTargetMs: null, jitterMs: null }).level === "good", "");
t.check("poor band edge: jbTargetMs at threshold trips", classifyConnWindow({ jbTargetMs: CONN_BANDS.jbTargetMs.poor }).level === "poor", "");
t.check("marginal band edge: one below poor threshold stays marginal", classifyConnWindow({ jbTargetMs: CONN_BANDS.jbTargetMs.poor - 1 }).level === "marginal", "");

// ── 2. July 2's real blip: below-band AND unsustained — never warns ─────────
const BLIP = { jbTargetMs: 220, jitterMs: 12, concealMs: 20, lostPct: 1, rttMs: 30 };
{
  const tr = createConnQualityTracker();
  for (const w of [CLEAN, CLEAN, BLIP, CLEAN, CLEAN, BLIP, CLEAN]) tr.push(w);
  t.check("July 2 blip windows never surface a warning", tr.level() === "good", `level=${tr.level()}`);
}

// ── 3. sustain machine ──────────────────────────────────────────────────────
{
  const tr = createConnQualityTracker();
  tr.push(DEEP); tr.push(DEEP);
  t.check("2 consecutive poor windows do NOT escalate yet", tr.level() === "good", `level=${tr.level()}`);
  const r3 = tr.push(DEEP);
  t.check("3rd consecutive poor window escalates to poor", tr.level() === "poor" && r3.changed, `level=${tr.level()} changed=${r3.changed}`);
  tr.push(CLEAN); tr.push(CLEAN); tr.push(CLEAN); tr.push(CLEAN);
  t.check("4 consecutive good windows do NOT clear yet", tr.level() === "poor", `level=${tr.level()}`);
  const r5 = tr.push(CLEAN);
  t.check("5th consecutive good window clears to good", tr.level() === "good" && r5.changed, `level=${tr.level()} changed=${r5.changed}`);
}
{
  // an interrupted bad streak restarts the escalation count (no slow-creep flap)
  const tr = createConnQualityTracker();
  tr.push(DEEP); tr.push(DEEP); tr.push(CLEAN); tr.push(DEEP); tr.push(DEEP);
  t.check("interrupted bad streak does not escalate", tr.level() === "good", `level=${tr.level()}`);
}
{
  // marginal escalates on the same sustain rule
  const tr = createConnQualityTracker();
  tr.push(MIDDLE); tr.push(MIDDLE); tr.push(MIDDLE);
  t.check("3 sustained marginal windows escalate to marginal", tr.level() === "marginal", `level=${tr.level()}`);
}

t.done();
