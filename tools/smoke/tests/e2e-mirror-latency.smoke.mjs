// e2e-mirror-latency.smoke.mjs — the partner mirror under DETERMINISTIC network
// conditions the production gate can't reproduce. Requires the local mock WS
// server (run with `--mock`); SKIPs otherwise (no regression — env gap).
//
// WHY: every other e2e test connects to the production relay, which during tests
// runs on a clean fast network — so latency, jitter, packet loss and reordering
// never happen and the mirror always looks perfect (~4ms). The mirror/stale
// position bug class lives in exactly those conditions. This test injects them via
// the mock's seeded netem layer and asserts the mirror invariants hold:
//   1. clean baseline is tight (proves the mock path itself adds ~no error)
//   2. under realistic latency+jitter+sparse packets the mirror NEVER steps
//      backward, keeps ADVANCING (no freeze), and tracks truth within the
//      one-way latency floor + margin (it coasts, not diverges)
// It also LOGS the harsh-profile max error as a tracked diagnostic — the number
// Move #2 (mirror coast/snap refactor) will drive down and then assert on.
//
// SCOPE: netem shapes the WS control plane (the deck_update progress packets that
// drive the mirror). Audio is P2P WebRTC, unaffected — not what this test covers.
import { Suite } from "../lib/result.mjs";
import { launch, capture, gotoApp, createRoom, joinByCode, loadTestTrack, hasMock, setNetem, resetNetem } from "../lib/e2e.mjs";

const FIXTURE_DUR_SEC = 12; // gen-fixture.mjs SECONDS
const t = new Suite("e2e-mirror-latency");

if (!hasMock()) t.skip("no mock WS server — run the suite with --mock (MOCK=1) to inject netem");
const browser = await launch();
if (!browser) t.skip("no system Chrome — e2e unavailable here");

// Sample driver truth (A's own playhead) vs the mirror (B's view of deck A) over
// `n` ticks; return error stats in ms of track time + backward-step count.
async function sampleMirror(A, B, n = 28, dwell = 200) {
  const errs = [], mir = [];
  for (let i = 0; i < n; i++) {
    await B.waitForTimeout(dwell);
    const [da, mb] = await Promise.all([A.evaluate(() => window.__deckProg("A")), B.evaluate(() => window.__deckProg("A"))]);
    if (typeof da === "number" && typeof mb === "number") { errs.push(Math.abs(da - mb) * FIXTURE_DUR_SEC * 1000); mir.push(mb); }
  }
  let backward = 0; for (let i = 1; i < mir.length; i++) if (mir[i] - mir[i - 1] < -1e-4) backward++;
  const med = errs.length ? [...errs].sort((a, b) => a - b)[errs.length >> 1] : Infinity;
  const max = errs.length ? Math.max(...errs) : Infinity;
  const advanced = mir.length > 1 && mir[mir.length - 1] - mir[0] > 0.02;
  return { med, max, backward, advanced, mir };
}

try {
  const ctxA = await browser.newContext(); const A = await ctxA.newPage(); const sA = capture(A);
  await gotoApp(A);
  const code = await createRoom(A);
  await A.waitForTimeout(1200);
  const ctxB = await browser.newContext(); const B = await ctxB.newPage(); const sB = capture(B);
  await gotoApp(B);
  await joinByCode(B, code);
  await B.waitForFunction(() => /⟺/.test(document.body.innerText), null, { timeout: 12000 }).catch(() => {});

  await loadTestTrack(A, "A");
  await sA.waitFor("[ANALYZER-BROADCAST] A beats=", 15000);
  await B.waitForFunction(() => !!window.__smokeReady, null, { timeout: 8000 });

  // ── 1) CLEAN baseline (netem off): the mock path adds ~no error. ───────────
  await resetNetem();
  await A.evaluate(() => window.__seekDeck("A", 0.1));
  await A.evaluate(() => window.__toggleDeck("A"));
  const clean = await sampleMirror(A, B, 14);
  t.check("clean baseline: mirror tracks tight (median < 40ms)", clean.med < 40, `median ${clean.med.toFixed(0)}ms, max ${clean.max.toFixed(0)}ms`);
  t.check("clean baseline: no backward steps", clean.backward === 0, `${clean.backward} backward steps`);

  // ── 2) REALISTIC latency + jitter + sparse packets on the progress stream. ──
  // 150ms one-way, ±70ms jitter (→ reordering), 40% loss on deck_update only
  // (control/transport stay crisp). Seeded → reproducible. This is the condition
  // the production gate is structurally blind to.
  await A.evaluate(() => window.__seekDeck("A", 0.1));
  await B.waitForTimeout(800);
  await setNetem({ latencyMs: 150, jitterMs: 70, lossPct: 0.4, types: ["deck_update"], seed: 1 });
  await B.waitForTimeout(800); // let the conditions take hold
  const real = await sampleMirror(A, B, 28);

  t.check("realistic netem: mirror keeps advancing (no freeze)", real.advanced, `mir ${real.mir[0]?.toFixed(3)}→${real.mir[real.mir.length - 1]?.toFixed(3)}`);
  t.check("realistic netem: mirror never steps backward (slew guard holds)", real.backward === 0, `${real.backward} backward steps`);
  // One-way latency is the floor; the coast should track within floor + margin,
  // not diverge. (Move #2 tightens this toward the floor.)
  t.check("realistic netem: coast tracks truth (median < 350ms — ~150ms floor)", real.med < 350, `median ${real.med.toFixed(0)}ms, max ${real.max.toFixed(0)}ms`);

  // ── 3) HARSH profile — DIAGNOSTIC (logged, not asserted today). Exposes the ─
  // coast-accuracy blowout under heavy sparse+jittery load (~1.4s max in
  // exploration). This is the number Move #2 must drive down; a tight assertion
  // lands with that refactor so the gate proves the fix.
  await A.evaluate(() => window.__seekDeck("A", 0.1));
  await B.waitForTimeout(800);
  await setNetem({ latencyMs: 200, jitterMs: 120, lossPct: 0.7, types: ["deck_update"], seed: 1 });
  await B.waitForTimeout(800);
  const harsh = await sampleMirror(A, B, 24);
  console.log(`[DIAG] harsh-profile mirror error: median ${harsh.med.toFixed(0)}ms  max ${harsh.max.toFixed(0)}ms  backwardSteps ${harsh.backward}  (Move #2 target: drive max down + assert)`);
  // Sanity floor only — the harsh path must still not crash or freeze.
  t.check("harsh netem: mirror still advances (no crash/freeze)", harsh.advanced, `median ${harsh.med.toFixed(0)}ms max ${harsh.max.toFixed(0)}ms`);

  await resetNetem();
  t.check("no page errors", sA.errors().length === 0 && sB.errors().length === 0, [...sA.errors(), ...sB.errors()].slice(0, 2).join(" | ") || "clean");
} catch (e) {
  t.check("no exceptions during run", false, e.message);
} finally {
  await browser.close();
}
t.done();
