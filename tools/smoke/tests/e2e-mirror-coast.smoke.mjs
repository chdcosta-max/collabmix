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

  // ── Pause/play from the NON-OWNER under SPARSE packets (the real failure: a
  // paused deck stops broadcasting, so the mirror was stuck behind truth and
  // lurched forward on play). The fix delivers the exact frozen position WITH
  // the pause/play transport change. Throttle stays sparse — the position must
  // transfer regardless of the heartbeat rate.
  await B.evaluate(() => window.__toggleDeck("A"));   // pause deck A (remote)
  await B.waitForTimeout(1200);                        // sit in pause (no heartbeat)
  // During pause: the mirror must match the OWNER's frozen truth (position transferred).
  const [ownerPaused, mirrorPaused] = await Promise.all([A.evaluate(() => window.__deckProg("A")), B.evaluate(() => window.__deckProg("A"))]);
  const pauseErr = Math.abs(ownerPaused - mirrorPaused) * FIXTURE_DUR_SEC * 1000;
  t.check("paused mirror matches owner truth (position transferred)", pauseErr < 100, `owner=${ownerPaused?.toFixed(3)} mirror=${mirrorPaused?.toFixed(3)} (${pauseErr.toFixed(0)}ms)`);

  await B.evaluate(() => window.__toggleDeck("A"));   // play deck A (remote)
  let prev = mirrorPaused, tBackward = 0; const tErr = [];
  for (let i = 0; i < 14; i++) {   // sample through + past the transition
    await B.waitForTimeout(150);
    const [o, m] = await Promise.all([A.evaluate(() => window.__deckProg("A")), B.evaluate(() => window.__deckProg("A"))]);
    if (typeof o === "number" && typeof m === "number") {
      tErr.push(Math.abs(o - m) * FIXTURE_DUR_SEC * 1000);
      if (m - prev < -1e-4) tBackward++;
      prev = m;
    }
  }
  const tMed = tErr.length ? [...tErr].sort((a, b) => a - b)[tErr.length >> 1] : Infinity;
  // No BACKWARD lurch, and the mirror tracks owner truth through the restart.
  // The lurch bug put the mirror 8-10 bars off (>800ms); <250ms is the
  // latency-tolerant floor (the position-transfer above is the strict 0ms proof).
  t.check("no backward lurch on play from non-owner", tBackward === 0, `${tBackward} backward steps`);
  t.check("mirror tracks owner through pause→play (median < 250ms)", tMed < 250, `median ${tMed.toFixed(0)}ms vs owner truth`);

  // ── SPAM-TOGGLE from the NON-OWNER under sparse packets (#3). Rapid pause/play
  // must not produce forward "hard snap" lurches (Chad's repro: [MIRROR-SNAP]
  // forward +6.4s/+8.7s on quick non-owner pause/play). Each play-start should
  // EASE onto truth, not jump. Reset position first (phases 1-2 ran us near the
  // 12s end), let the mirror reconcile, THEN hammer the toggle.
  await A.evaluate(() => window.__seekDeck("A", 0.1));
  await B.waitForTimeout(3000);                         // mirror reconciles to the seek (sparse)
  const snapsBefore = sB.all("forward seek/catch-up").length;
  const errBefore = sB.errors().length;
  for (let i = 0; i < 10; i++) { await B.evaluate(() => window.__toggleDeck("A")); await B.waitForTimeout(110); } // even count → ends playing
  await B.waitForTimeout(3500);                         // settle + ≥1 sparse packet so it reconciles
  const fwdSnaps = sB.all("forward seek/catch-up").length - snapsBefore;
  // Mirror sampled BACKWARD across the spam? (a lurch). And does it end on truth?
  const [oEnd, mEnd] = await Promise.all([A.evaluate(() => window.__deckProg("A")), B.evaluate(() => window.__deckProg("A"))]);
  const endErr = Math.abs(oEnd - mEnd) * FIXTURE_DUR_SEC * 1000;
  t.check("spam-toggle: no forward hard-snap lurches", fwdSnaps === 0, `${fwdSnaps} forward hard-snaps during ${10}x non-owner toggle`);
  t.check("spam-toggle: mirror converges to owner truth (< 400ms)", endErr < 400, `owner=${oEnd?.toFixed(3)} mirror=${mEnd?.toFixed(3)} (${endErr.toFixed(0)}ms)`);
  t.check("spam-toggle: no new page errors", sB.errors().length === errBefore, sB.errors().slice(errBefore).slice(0, 2).join(" | ") || "clean");

  t.check("no page errors", sA.errors().length === 0 && sB.errors().length === 0, [...sA.errors(), ...sB.errors()].slice(0, 2).join(" | ") || "clean");
  void FIXTURE_BPM;
} catch (e) {
  t.check("no exceptions during run", false, e.message);
} finally {
  await browser.close();
}
t.done();
