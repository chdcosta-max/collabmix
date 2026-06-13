// e2e-sync-mode.smoke.mjs — SYNC AS A MODE (ticket #6, absorbs #2).
// SYNC is a persistent mode (off → armed → locked), not a command with
// preconditions. This proves the three entry paths all converge on a
// beat-aligned lock:
//   1. arm-before-load — press SYNC with empty decks, then load + play.
//   2. arm-before-play — press SYNC with both decks paused, then play
//      (this IS ticket #2's engage-before-play clash; in the mode model the
//       play-start alignment makes it structurally impossible).
//   3. arm-mid-play    — press SYNC with both decks already playing → locks now.
// Solo client drives BOTH decks (the real solo-test setup and the #2 repro);
// the B2B locked path stays covered by e2e-sync / e2e-drift / e2e-comp.
//
// Alignment is read via window.__deckPhaseFrac (the SAME refined grid +
// refinedBeatPhase the engage uses); a clash shows as a large wrapped phase
// difference between A and B.
import { Suite } from "../lib/result.mjs";
import { launch, capture, createRoom, loadTestTrack } from "../lib/e2e.mjs";

const TARGET = process.env.TARGET || "http://localhost:5173/";
const t = new Suite("e2e-sync-mode");
const browser = await launch();
if (!browser) t.skip("no system Chrome — e2e unavailable here");

// Beat-phase error between the two decks, in ms (0 = same beat phase).
const phaseErrMs = (page) => page.evaluate(() => {
  const a = window.__deckPhaseFrac("A"), b = window.__deckPhaseFrac("B");
  if (!a || !b) return null;
  let d = a.frac - b.frac;
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return Math.abs(d) * (a.periodSec || b.periodSec || 0.5) * 1000;
});
const syncState = (page) => page.evaluate(() => window.__syncState());
// Alignment lands well under a beat; bound covers ~16ms progRef sampling skew
// between the two decks' RAF loops plus live jitter, while a real clash
// (≥¼ beat ≈ 125ms at 120 BPM) fails loudly.
const ALIGN_MS = 70;

try {
  const ctxA = await browser.newContext();
  const A = await ctxA.newPage();
  const sA = capture(A);
  await A.goto(TARGET, { waitUntil: "domcontentloaded" });
  await createRoom(A);
  await A.waitForFunction(() => !!window.__smokeReady, null, { timeout: 12000 });

  // ── 1) ARM-BEFORE-LOAD ────────────────────────────────────────────────
  // Press SYNC with empty decks → armed (must not crash / must not lock).
  await A.evaluate(() => window.__syncDeck("A"));
  await A.waitForTimeout(150);
  let st = await syncState(A);
  t.check("arm with empty decks → armed (not locked)", st.armed === true && st.locked === false, JSON.stringify(st));

  await loadTestTrack(A, "A");
  await loadTestTrack(A, "B");
  await sA.waitFor("[BPM] analysis complete for deck A", 15000);
  await sA.waitFor("[BPM] analysis complete for deck B", 15000);
  await A.waitForTimeout(300);
  st = await syncState(A);
  t.check("both loaded, nothing playing → still armed", st.armed === true && st.locked === false, JSON.stringify(st));

  // Play A (master), then B → mode locks and aligns.
  await A.evaluate(() => window.__toggleDeck("A"));
  await sA.waitFor("[SYNC] LOCKED (mode)", 4000);
  st = await syncState(A);
  t.check("first play under armed → locked", st.locked === true, JSON.stringify(st));
  await A.waitForTimeout(400);
  await A.evaluate(() => window.__toggleDeck("B"));
  await A.waitForTimeout(1000);
  let err = await phaseErrMs(A);
  t.check(`arm-before-load aligns (|phaseErr| < ${ALIGN_MS}ms)`, err != null && err < ALIGN_MS, `phaseErr=${err == null ? "null" : err.toFixed(1)}ms`);

  // Reset → off, pause + rewind both decks for the next phase.
  await A.evaluate(() => window.__syncDeck("A"));
  await A.waitForTimeout(250);
  await A.evaluate(() => { window.__toggleDeck("A"); window.__toggleDeck("B"); });
  await A.waitForTimeout(150);
  await A.evaluate(() => { window.__seekDeck("A", 0); window.__seekDeck("B", 0); });
  await A.waitForTimeout(200);

  // ── 2) ARM-BEFORE-PLAY (ticket #2 repro: engage with slave paused) ─────
  // Both paused → arm stays ARMED (per Chad: align on first play, not at rest).
  await A.evaluate(() => window.__syncDeck("A"));
  await A.waitForTimeout(150);
  st = await syncState(A);
  t.check("arm with both paused → armed, not locked", st.armed === true && st.locked === false, JSON.stringify(st));

  // Play A (master) → locks; then play B (slave) → aligns from beat one.
  await A.evaluate(() => window.__toggleDeck("A"));
  await sA.waitFor("[SYNC] LOCKED (mode)", 4000);
  await A.waitForTimeout(400);
  await A.evaluate(() => window.__toggleDeck("B"));
  await A.waitForTimeout(1100);
  st = await syncState(A);
  err = await phaseErrMs(A);
  t.check("arm-before-play → locked", st.locked === true, JSON.stringify(st));
  t.check(`arm-before-play aligns (|phaseErr| < ${ALIGN_MS}ms)`, err != null && err < ALIGN_MS, `phaseErr=${err == null ? "null" : err.toFixed(1)}ms`);

  // Reset → off. Leave both decks PLAYING for the mid-play phase.
  await A.evaluate(() => window.__syncDeck("A"));
  await A.waitForTimeout(250);

  // ── 3) ARM-MID-PLAY ───────────────────────────────────────────────────
  // Both already playing → arming locks immediately.
  await A.evaluate(() => window.__syncDeck("A"));
  await sA.waitFor("[SYNC] LOCKED (mode)", 4000);
  await A.waitForTimeout(900);
  st = await syncState(A);
  err = await phaseErrMs(A);
  t.check("arm-mid-play → locked immediately", st.locked === true, JSON.stringify(st));
  t.check(`arm-mid-play aligns (|phaseErr| < ${ALIGN_MS}ms)`, err != null && err < ALIGN_MS, `phaseErr=${err == null ? "null" : err.toFixed(1)}ms`);

  t.check("no page errors", sA.errors().length === 0, sA.errors().slice(0, 2).join(" | ") || "clean");
} catch (e) {
  t.check("no exceptions during run", false, e.message);
} finally {
  await browser.close();
}
t.done();
