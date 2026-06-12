// e2e-trackend.smoke.mjs — track-end state machine. A deck parked at its end
// (natural end, seek-to-end, or a re-engage landing near the end) must remain
// operable: pressing play replays from the start instead of going inert (the
// "transport dead after a long session" family). Verifies BOTH sides can drive
// the deck after it's parked at end.
//
// The bug: play_(off.current) with off.current==buf.duration starts a source at
// the end → 0 samples → instant onended → play flips true→false, no audio. The
// fix wraps to the start on a play-press-at-end.
import { Suite } from "../lib/result.mjs";
import { launch, capture, createRoom, joinByCode, loadTestTrack } from "../lib/e2e.mjs";

const TARGET = process.env.TARGET || "http://localhost:5173/";
const t = new Suite("e2e-trackend");
const browser = await launch();
if (!browser) t.skip("no system Chrome — e2e unavailable here");

// After a play press the deck must END UP PLAYING. The inert flip-flop bug
// leaves the last play-state line "false" (play→true→instant onended→false);
// the fix leaves it "true". Caller clears the sink before the press so the
// window holds only this press's effects.
async function endsPlaying(sink, page) {
  await page.waitForTimeout(1000);
  const last = [...sink.lines].reverse().find((l) => /play prop\/state changed to (true|false)/.test(l));
  return /changed to true/.test(last || "");
}

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
  await sA.waitFor("[BPM] analysis complete for deck A", 15000);

  // ── Case 1: park at end, NON-OWNER (B) presses play → A replays from start.
  await A.evaluate(() => window.__seekDeck("A", 1.0));
  await A.waitForTimeout(600);
  sA.lines.length = 0;
  await B.evaluate(() => window.__toggleDeck("A"));
  const wrapped = await sA.waitFor("parked-at-end → wrapping", 4000);
  const nonOwnerPlays = await endsPlaying(sA, A);
  t.check("non-owner play at end → deck wraps to start", wrapped, "off.current was at buf end");
  t.check("non-owner play at end → deck actually plays (no flip-flop)", nonOwnerPlays, "play stays true");

  // ── Case 2: pause, park at end again, OWNER (A) presses play → plays.
  await A.evaluate(() => window.__toggleDeck("A")); // pause
  await A.waitForTimeout(500);
  await A.evaluate(() => window.__seekDeck("A", 1.0));
  await A.waitForTimeout(500);
  sA.lines.length = 0;
  await A.evaluate(() => window.__toggleDeck("A")); // owner play at end
  const ownerPlays = await endsPlaying(sA, A);
  t.check("owner play at end → deck actually plays", ownerPlays, "owner can operate after end");

  // ── Case 3: natural end resets to 0 → play works normally (sanity).
  await A.evaluate(() => window.__toggleDeck("A")); // pause
  await A.waitForTimeout(300);
  await A.evaluate(() => window.__seekDeck("A", 0.0));
  await A.waitForTimeout(300);
  sA.lines.length = 0;
  await A.evaluate(() => window.__toggleDeck("A"));
  const normalPlays = await endsPlaying(sA, A);
  t.check("play from start works normally", normalPlays, "baseline");

  t.check("no page errors", sA.errors().length === 0 && sB.errors().length === 0, [...sA.errors(), ...sB.errors()].slice(0, 2).join(" | ") || "clean");
} catch (e) {
  t.check("no exceptions during run", false, e.message);
} finally {
  await browser.close();
}
t.done();
