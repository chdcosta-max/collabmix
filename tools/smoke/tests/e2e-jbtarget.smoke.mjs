// e2e-jbtarget.smoke.mjs — PROOF that the partner receiver's jitter-buffer depth is
// PINNED to JB_TARGET_MS (default 220) instead of the browser's shallow auto-target.
// A plays the fixture (audio source → B's receiver); we read the realized
// jitterBufferTargetDelay from B's [JITTER-DIAG] (getStats-derived) and assert it
// HOLDS ~220. localhost (near-zero jitter) would auto-pick a far shallower target, so
// a steady reading of ~220 proves the set took effect — not just that a constant was
// changed. Needs real WebRTC audio; SKIPs if RTC never connects (headless env).
import { Suite } from "../lib/result.mjs";
import { launch, capture, createRoom, joinByCode, loadTestTrack } from "../lib/e2e.mjs";

const TARGET = process.env.TARGET || "http://localhost:5173/";
const t = new Suite("e2e-jbtarget");
const browser = await launch();
if (!browser) t.skip("no system Chrome — e2e unavailable here");

const rtcUp = (s) => s.has("ice state: connected") || s.has("connection state: connected") || s.has("[RTC] incoming track");
const jbTargetOf = (line) => { const m = (line || "").match(/jbTargetMs=([\d.]+)/); return m ? parseFloat(m[1]) : null; };

try {
  const ctxA = await browser.newContext(); const A = await ctxA.newPage(); const sA = capture(A);
  await A.goto(TARGET, { waitUntil: "domcontentloaded" });
  const code = await createRoom(A);
  await A.waitForTimeout(1500);
  const ctxB = await browser.newContext(); const B = await ctxB.newPage(); const sB = capture(B);
  await B.goto(TARGET, { waitUntil: "domcontentloaded" });
  await joinByCode(B, code);
  await B.waitForFunction(() => /⟺/.test(document.body.innerText), null, { timeout: 12000 }).catch(() => {});

  // A is the audio source → B's inbound receiver is the one pinned to JB_TARGET_MS.
  await loadTestTrack(A, "A");
  await A.evaluate(() => window.__toggleDeck("A"));

  // RTC connect + buffer fill + several JITTER-DIAG windows (logged ~every 2s).
  await B.waitForTimeout(16000);

  if (!rtcUp(sA) && !rtcUp(sB)) t.skip("WebRTC never connected in this environment (headless audio) — jitter buffer untestable here");

  t.check("partner receiver target was SET ([JB-TARGET] logged on the receiver)", sB.has("[JB-TARGET]"), (sB.last("[JB-TARGET]") || "not logged").replace(/.*\[JB-TARGET\]\s*/, "").slice(0, 80));

  const targets = sB.all("[JITTER-DIAG]").map(jbTargetOf).filter((v) => v != null);
  t.check("JITTER-DIAG produced jbTarget samples (RTC audio flowed)", targets.length > 0, `n=${targets.length}`);

  // Use the settled half (skip the connection-settling transient).
  const settled = targets.slice(Math.floor(targets.length / 2));
  const med = settled.length ? [...settled].sort((a, b) => a - b)[settled.length >> 1] : null;
  const min = settled.length ? Math.min(...settled) : null;
  const max = settled.length ? Math.max(...settled) : null;
  console.log(`[JB-PROOF] settled jbTarget median ${med?.toFixed(0)}ms (min ${min?.toFixed(0)}, max ${max?.toFixed(0)}, n=${settled.length}) — pinned to JB_TARGET_MS default 220`);

  // Default is now 220ms (Issue #3). A clean localhost would auto-target far lower, so a
  // steady reading near the pinned value proves the set took effect at the NetEQ level.
  // Bounds are generous to bracket the 220 default + NetEQ wiggle AND survive by-ear
  // ?jbtarget tuning of the default in the ~200–280 range without test churn.
  t.check("jitter buffer HOLDS ~220ms (pinned, not browser-default shallow)", med != null && med >= 180 && med <= 320, `median jbTarget ${med?.toFixed(0)}ms`);
  // Steadiness: it never drops back to a shallow hunting value.
  t.check("buffer STEADY, not hunting shallow (min ≥ 150ms)", min != null && min >= 150, `min jbTarget ${min?.toFixed(0)}ms (max ${max?.toFixed(0)})`);

  t.check("connection clean (no page errors)", sA.errors().length === 0 && sB.errors().length === 0, [...sA.errors(), ...sB.errors()].slice(0, 2).join(" | ") || "clean");
} catch (e) {
  t.check("no exceptions during run", false, e.message);
} finally {
  await browser.close();
}
t.done();
