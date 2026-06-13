// e2e-mirror-slew.smoke.mjs — DETERMINISTIC reproduction of the dogfood
// BACKWARD SLEW: the partner mirror jumping/easing BACKWARD (Jake saw
// -0.5s / -0.6s / -1.53s, VISION_5 "DOGFOOD SESSION 1" P3). Requires the local
// mock WS server (run with `--mock`); SKIPs otherwise.
//
// THIS TEST IS REGISTERED xfail. It asserts the POST-FIX property (the mirror
// must NOT slew meaningfully backward). With today's localhost-tuned coast/snap
// model it FAILS — that failure is EXPECTED and reported as 🟡 XFAIL (non-fatal,
// not a regression). When Move #2 (the mirror coast/snap refactor) fixes it, this
// flips to 🎯 XPASS — the signal to drop the xfail flag and make it a hard gate.
// That is how Move #2 PROVES it killed THIS bug, not just reduced latency.
//
// MECHANISM (code-traced, src/collabmix-production.jsx ~5490-5540): the mirror
// coasts the partner playhead at the driver's last-known rate (remRateRef). If the
// driver is pitched DOWN while progress packets are absent (sparse / blacked out),
// the mirror keeps coasting at the STALE FAST rate → it OVERSHOOTS truth. When a
// packet finally lands, signedDrift is negative → the "absorbed backward drift …
// via slew" branch eases the playhead BACKWARD. Overshoot ≈ rateDrop × gap, so the
// repro is tunable and deterministic (total blackout = no random drops).
//
// REPRO: latency baseline → seek+settle → BLACK OUT deck_update (lossPct 1.0) →
// pitch the driver to 0.45 → hold ~5s (mirror coasts ahead) → restore packets →
// sample the mirror: it slews backward by ~0.8s today.
import { Suite } from "../lib/result.mjs";
import { launch, capture, gotoApp, createRoom, joinByCode, loadTestTrack, hasMock, setNetem, resetNetem } from "../lib/e2e.mjs";

const DUR = 12; // gen-fixture.mjs SECONDS
const t = new Suite("e2e-mirror-slew");

if (!hasMock()) t.skip("no mock WS server — run the suite with --mock (MOCK=1) to inject netem");
const browser = await launch();
if (!browser) t.skip("no system Chrome — e2e unavailable here");

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

  // Baseline latency so the coast is the active path; play; let the mirror lock on.
  await setNetem({ latencyMs: 120, jitterMs: 0, types: ["deck_update"], seed: 1 });
  await A.evaluate(() => window.__seekDeck("A", 0.12));
  await A.evaluate(() => window.__toggleDeck("A"));
  await B.waitForTimeout(1600);

  // ── REPRO ────────────────────────────────────────────────────────────────
  await A.evaluate(() => window.__seekDeck("A", 0.15));
  await B.waitForTimeout(1200);                                  // mirror anchors before blackout
  const slewLogsBefore = sB.all("absorbed backward drift").length;
  await setNetem({ lossPct: 1.0, types: ["deck_update"], seed: 1 }); // TOTAL progress blackout (deterministic)
  await A.evaluate(() => window.__setRateDeck("A", 0.45));        // pitch driver DOWN → truth slows, mirror coasts fast
  await new Promise((r) => setTimeout(r, 5000));                  // mirror overshoots while blind
  await setNetem({ latencyMs: 120, lossPct: 0, types: ["deck_update"], seed: 1 }); // restore → the backward correction lands

  // Sample the mirror through the slew.
  const seq = [];
  for (let i = 0; i < 18; i++) { await B.waitForTimeout(120); const m = await B.evaluate(() => window.__deckProg("A")); if (typeof m === "number") seq.push(m); }
  await A.evaluate(() => window.__setRateDeck("A", 1.0));         // restore rate
  await resetNetem();

  let maxBackSec = 0, backSteps = 0;
  for (let i = 1; i < seq.length; i++) { const dSec = (seq[i] - seq[i - 1]) * DUR; if (dSec < -1e-3) { backSteps++; if (-dSec > maxBackSec) maxBackSec = -dSec; } }
  const slewLogs = sB.all("absorbed backward drift").length - slewLogsBefore;
  console.log(`[REPRO] backward slew: maxBackwardStep=${maxBackSec.toFixed(2)}s  backwardSteps=${backSteps}  app "absorbed backward drift" logs=${slewLogs}  (dogfood: -0.5/-1.53s)`);

  // ── POST-FIX ASSERTIONS (xfail today; flip to XPASS when Move #2 lands) ─────
  // A correct mirror under latency NEVER displays a meaningful backward jump — it
  // should converge forward onto truth. 120ms tolerance absorbs single-frame
  // sampling noise; the bug is ~0.8s, far above it.
  t.check("mirror does NOT slew backward (max backward step < 120ms)", maxBackSec < 0.12, `max backward step ${(maxBackSec * 1000).toFixed(0)}ms (dogfood symptom: 500–1530ms)`);
  t.check("no large backward-drift correction fired", slewLogs === 0, `${slewLogs}× "[MIRROR-SNAP] absorbed backward drift" (the slew confession)`);

  // Sanity (green today and after the fix): the run is well-formed.
  const advanced = seq.length > 1 && seq[seq.length - 1] - seq[0] > -1; // it did move
  t.check("mirror sampled + run well-formed", advanced && seq.length > 4, `${seq.length} samples`);
  t.check("no page errors", sA.errors().length === 0 && sB.errors().length === 0, [...sA.errors(), ...sB.errors()].slice(0, 2).join(" | ") || "clean");
} catch (e) {
  t.check("no exceptions during run", false, e.message);
} finally {
  await browser.close();
}
t.done();
