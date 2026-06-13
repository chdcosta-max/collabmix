// e2e-lock-stability.smoke.mjs — a LOCKED B2B deck must not pause ITSELF.
// Regression guard for the spontaneous-pause anomaly (room drop-fade-979): under
// SYNC-as-mode, the MASTER's client re-ran attemptLock on every partner play and
// issued a cross-client seek_request for the partner-driven slave, computed from
// its own (possibly stale) MIRROR position. Landing near the track end made the
// owner's play_() start a 0-sample source → instant onended → the deck paused
// itself and broadcast playing=false with no toggle().
//
// The fix: attemptLock only re-aligns a slave THIS client drives; a partner's
// play no longer triggers a cross-client re-seek (the master logs a skip). This
// test drives a real locked B2B, has the SLAVE re-trigger the master's
// attemptLock (intentional pause/play), and asserts (a) the master SKIPS the
// cross-client seek and (b) both decks keep advancing — no spontaneous pause.
import { Suite } from "../lib/result.mjs";
import { launch, capture, createRoom, joinByCode, loadTestTrack } from "../lib/e2e.mjs";

const TARGET = process.env.TARGET || "http://localhost:5173/";
const t = new Suite("e2e-lock-stability");
const browser = await launch();
if (!browser) t.skip("no system Chrome — e2e unavailable here");

const advanced = async (page, deck) => {
  const a = await page.evaluate((d) => window.__deckProg(d), deck);
  await page.waitForTimeout(600);
  const b = await page.evaluate((d) => window.__deckProg(d), deck);
  return { from: a, to: b, moved: typeof a === "number" && typeof b === "number" && b - a > 0.002 };
};

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
  await loadTestTrack(B, "B");
  await sA.waitFor("[BPM] analysis complete for deck A", 15000);
  await sB.waitFor("[BPM] analysis complete for deck B", 15000);
  // The master (A) only evaluates the slave once B's grid/BPM AND driver claim
  // have mirrored to it; under full-suite load that propagation lags. Wait for
  // B's analysis to actually reach A so attemptLock has bBpm + a partner-driven
  // slave to skip (otherwise it returns early and the skip never logs — a flake).
  await sA.waitFor("[ANALYZER-RECV] B", 15000);

  // A plays deck A first (→ master), B plays deck B (→ slave). Lock from B (the
  // mixing-in deck → the slave's own client aligns locally).
  await A.evaluate(() => window.__toggleDeck("A"));
  await A.waitForTimeout(350);
  await B.evaluate(() => window.__toggleDeck("B"));
  await A.waitForTimeout(2000);
  await B.evaluate(() => window.__syncDeck("B"));
  await sB.waitFor("[SYNC] LOCKED (mode)", 6000).catch(() => {});
  await A.waitForTimeout(800);

  // Re-trigger the master's attemptLock from the partner side: the SLAVE deck
  // pauses/plays a few times. Each play broadcasts playing=true → the master (A)
  // runs attemptLock for a partner-driven slave. Even count → ends playing.
  for (let i = 0; i < 6; i++) { await B.evaluate(() => window.__toggleDeck("B")); await B.waitForTimeout(220); }
  await A.waitForTimeout(1200);

  // (a) The fix is active: in this locked B2B the master (A) declines to re-seek
  // the partner-driven slave (it logs the skip rather than issuing the
  // cross-client seek_request that could pause the partner's deck). Pre-fix this
  // log never existed — A always ran syncDecks(slave) cross-client.
  t.check("master skips cross-client re-seek of partner-driven slave", sA.has("skipping cross-client re-seek"), `${sA.all("skipping cross-client re-seek").length} skip log(s)`);

  // (b) No spontaneous pause: with the slave intended-playing again, BOTH decks'
  // own owners show an ADVANCING playhead (a self-paused deck would be frozen).
  const advA = await advanced(A, "A");
  const advB = await advanced(B, "B");
  t.check("master deck A keeps playing (advances, no self-pause)", advA.moved, `A ${advA.from?.toFixed(3)}→${advA.to?.toFixed(3)}`);
  t.check("slave deck B keeps playing (advances, no self-pause)", advB.moved, `B ${advB.from?.toFixed(3)}→${advB.to?.toFixed(3)}`);

  t.check("no page errors", sA.errors().length === 0 && sB.errors().length === 0, [...sA.errors(), ...sB.errors()].slice(0, 2).join(" | ") || "clean");
} catch (e) {
  t.check("no exceptions during run", false, e.message);
} finally {
  await browser.close();
}
t.done();
