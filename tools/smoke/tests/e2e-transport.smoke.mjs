// e2e-transport.smoke.mjs — transport propagates both directions, and a
// non-driver seek round-trips SEND→RECV→EXEC.
//   - A drives deck A, B drives deck B (each loads its own deck).
//   - A plays/pauses A → B mirrors playing state.
//   - B plays B → A mirrors playing state (other direction).
//   - B (non-driver of A) seeks deck A → B [SEEK-SEND], A [SEEK-RECV]+[SEEK-EXEC].
import { Suite } from "../lib/result.mjs";
import { launch, capture, createRoom, joinByCode, loadTestTrack } from "../lib/e2e.mjs";

const TARGET = process.env.TARGET || "http://localhost:5173/";
const t = new Suite("e2e-transport");
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
  await loadTestTrack(B, "B");
  await A.waitForTimeout(2500); // let both analyses + driver claims settle

  // ── A→B: A plays deck A → B receives [TRANSPORT-RECV] A playing=true
  await A.evaluate(() => window.__toggleDeck("A"));
  const bSawAPlay = await sB.waitFor("[TRANSPORT-RECV] A playing=true", 6000);
  t.check("A→B: partner sees A play", bSawAPlay, sB.last("[TRANSPORT-RECV] A") || "");
  await A.evaluate(() => window.__toggleDeck("A")); // pause A
  const bSawAPause = await sB.waitFor("[TRANSPORT-RECV] A playing=false", 6000);
  t.check("A→B: partner sees A pause", bSawAPause, "pause propagated");

  // ── B→A: B plays deck B → A receives [TRANSPORT-RECV] B playing=true (other direction)
  await B.evaluate(() => window.__toggleDeck("B"));
  const aSawBPlay = await sA.waitFor("[TRANSPORT-RECV] B playing=true", 6000);
  t.check("B→A: partner sees B play (other direction)", aSawBPlay, sA.last("[TRANSPORT-RECV] B") || "");
  await B.evaluate(() => window.__toggleDeck("B")); // pause B
  await A.waitForTimeout(500);

  // ── non-driver seek round-trip: B seeks deck A (B is NOT deck A's driver)
  await B.evaluate(() => window.__seekDeck("A", 0.5));
  const gotSend = await sB.waitFor("[SEEK-SEND]", 5000);
  const gotRecv = await sA.waitFor("[SEEK-RECV]", 5000);
  const gotExec = await sA.waitFor("[SEEK-EXEC]", 5000);
  t.check("non-driver B emits [SEEK-SEND]", gotSend, sB.last("[SEEK-SEND]")?.slice(0, 60) || "");
  t.check("driver A emits [SEEK-RECV]", gotRecv, sA.last("[SEEK-RECV]")?.slice(0, 60) || "");
  t.check("driver A emits [SEEK-EXEC]", gotExec, sA.last("[SEEK-EXEC]")?.slice(0, 60) || "");

  t.check("no page errors", sA.errors().length === 0 && sB.errors().length === 0, [...sA.errors(), ...sB.errors()].slice(0, 2).join(" | ") || "clean");
} catch (e) {
  t.check("no exceptions during run", false, e.message);
} finally {
  await browser.close();
}
t.done();
