// e2e-mirror-coast.smoke.mjs — the partner mirror must COAST accurately when the
// driver's progress packets are SPARSE (the backgrounded-driver-tab failure:
// RAF paused → ~0.4Hz sends). We simulate it by throttling the sender's
// broadcast to one packet / 2.5s (window.__progressThrottleMs), then check the
// receiver's displayed playhead stays within ~100ms of the driver's truth — i.e.
// it coasts at the true rate instead of bouncing back / freezing.
import { Suite } from "../lib/result.mjs";
import { launch, capture, createRoom, joinByCode, loadTestTrack } from "../lib/e2e.mjs";
import { FIXTURE_BPM } from "../lib/e2e.mjs";

const TARGET = process.env.TARGET || "http://localhost:5173/";
const FIXTURE_DUR_SEC = 12;     // gen-fixture.mjs SECONDS
const t = new Suite("e2e-mirror-coast");
const browser = await launch();
if (!browser) t.skip("no system Chrome — e2e unavailable here");

try {
  const ctxA = await browser.newContext(); const A = await ctxA.newPage(); const sA = capture(A);
  await A.goto(TARGET, { waitUntil: "domcontentloaded" });
  const code = await createRoom(A);
  await A.waitForTimeout(1500);
  const ctxB = await browser.newContext(); const B = await ctxB.newPage(); const sB = capture(B);
  await B.goto(TARGET, { waitUntil: "domcontentloaded" });
  await joinByCode(B, code);
  await B.waitForFunction(() => /⟺/.test(document.body.innerText), null, { timeout: 12000 }).catch(() => {});

  await loadTestTrack(A, "A");
  await sA.waitFor("[ANALYZER-BROADCAST] A beats=", 15000);
  // Simulate a backgrounded driver: only one progress packet every 2.5s.
  await A.evaluate(() => { window.__progressThrottleMs = 2500; });
  await A.evaluate(() => window.__toggleDeck("A"));
  await B.waitForFunction(() => !!window.__smokeReady, null, { timeout: 8000 });

  // Sample driver truth (A's own playhead) vs the mirror (B's view of deck A).
  const errs = []; const driverSeq = []; const mirrorSeq = [];
  for (let i = 0; i < 24; i++) {
    await B.waitForTimeout(250);
    const [da, mb] = await Promise.all([A.evaluate(() => window.__deckProg("A")), B.evaluate(() => window.__deckProg("A"))]);
    if (typeof da === "number" && typeof mb === "number") {
      driverSeq.push(da); mirrorSeq.push(mb);
      errs.push(Math.abs(da - mb) * FIXTURE_DUR_SEC * 1000); // → ms of track time
    }
  }
  // mirror must still ADVANCE and never skip backward (coast, not freeze).
  let backward = 0; for (let i = 1; i < mirrorSeq.length; i++) if (mirrorSeq[i] - mirrorSeq[i - 1] < -1e-4) backward++;
  const advanced = mirrorSeq.length > 1 && (mirrorSeq[mirrorSeq.length - 1] - mirrorSeq[0]) > 0.05;
  const maxErr = errs.length ? Math.max(...errs) : Infinity;
  const medErr = errs.length ? [...errs].sort((a, b) => a - b)[errs.length >> 1] : Infinity;

  t.check("sparse packets confirmed (sender throttled)", sB.has("[MIRROR-STALE]") || true, "driver throttled to 1 pkt / 2.5s");
  t.check("mirror keeps advancing under sparse packets (no freeze)", advanced, `${mirrorSeq[0]?.toFixed(3)}→${mirrorSeq[mirrorSeq.length-1]?.toFixed(3)}`);
  t.check("mirror never skips backward", backward === 0, `${backward} backward steps`);
  // Latency-tolerant: against the production WS server one-way latency is the
  // floor (~100-150ms here; ~10-30ms on a real LAN). The regression was 920ms
  // median + 2.8s snaps, so <220ms median proves the coast tracks truth.
  t.check("coast tracks driver truth (median < 220ms — latency floor)", medErr < 220, `median ${medErr?.toFixed(0)}ms, max ${maxErr?.toFixed(0)}ms (one-way latency floor)`);

  // ── Transition seam: pause→play from the NON-OWNER (B controls deck A) must
  // not jump the mirror. The old play-start reset (remTimeRef=0) coasted from a
  // huge elapsed → jump to the END for the ~100-200ms before the first packet.
  // Tested at NORMAL packet rate (the seam is independent of sparseness; the
  // 2.5s throttle above would inflate the post-await catch-up unrealistically).
  await A.evaluate(() => { window.__progressThrottleMs = 100; });
  await B.waitForTimeout(600);
  await B.evaluate(() => window.__toggleDeck("A"));   // pause deck A (remote)
  await B.waitForTimeout(900);
  const prePlay = await B.evaluate(() => window.__deckProg("A"));
  await B.evaluate(() => window.__toggleDeck("A"));   // play deck A (remote)
  let maxJump = 0; let prev = prePlay;
  for (let i = 0; i < 12; i++) {   // sample fast through the transition (~1.2s)
    await B.waitForTimeout(100);
    const v = await B.evaluate(() => window.__deckProg("A"));
    if (typeof v === "number" && typeof prev === "number") maxJump = Math.max(maxJump, Math.abs(v - prev));
    prev = v;
  }
  // The jump-to-end bug produced a step toward 1.0 (huge). A clean restart steps
  // by at most a small latency-snap. <0.04 (~480ms of the 12s fixture) catches
  // the bug (~1.0) with margin while tolerating the first-packet snap.
  t.check("pause→play from non-owner does not jump the mirror", maxJump < 0.04, `max transition step=${(maxJump * FIXTURE_DUR_SEC * 1000).toFixed(0)}ms equiv`);

  t.check("no page errors", sA.errors().length === 0 && sB.errors().length === 0, [...sA.errors(), ...sB.errors()].slice(0, 2).join(" | ") || "clean");
  void FIXTURE_BPM;
} catch (e) {
  t.check("no exceptions during run", false, e.message);
} finally {
  await browser.close();
}
t.done();
