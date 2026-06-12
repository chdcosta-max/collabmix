// e2e-chaos.smoke.mjs — chaos hardening. Throw the storms a real session hits
// during a frantic mix and assert the app SURVIVES: no unhandled page errors,
// no stuck state, still responsive afterward. Each scenario is a fuzz, not an
// exact assertion — the gate is "didn't crash / lock up".
import { Suite } from "../lib/result.mjs";
import { launch, capture, createRoom, joinByCode, loadTestTrack } from "../lib/e2e.mjs";

const TARGET = process.env.TARGET || "http://localhost:5173/";
const t = new Suite("e2e-chaos");
const browser = await launch();
if (!browser) t.skip("no system Chrome — e2e unavailable here");

const errCount = (s) => s.errors().length;

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
  await A.waitForTimeout(2000);

  const e0 = errCount(sA) + errCount(sB);

  // ── Scenario 1: rapid transport + sync spam during engage.
  await A.evaluate(async () => { for (let i = 0; i < 30; i++) { window.__toggleDeck("A"); window.__syncDeck("A"); await new Promise(r => setTimeout(r, 15)); } });
  await A.waitForTimeout(800);
  const e1 = errCount(sA) + errCount(sB);
  t.check("survives rapid transport+sync spam", e1 === e0, e1 === e0 ? "no new errors" : `${e1 - e0} errors`);

  // ── Scenario 2: seek storm while syncing.
  await A.evaluate(() => window.__syncDeck("A"));
  await A.evaluate(async () => { for (let i = 0; i < 40; i++) { window.__seekDeck("A", Math.abs(Math.sin(i)) ); await new Promise(r => setTimeout(r, 10)); } });
  await A.waitForTimeout(800);
  const e2 = errCount(sA) + errCount(sB);
  t.check("survives seek storm while syncing", e2 === e1, e2 === e1 ? "no new errors" : `${e2 - e1} errors`);

  // ── Scenario 3: track (re)load during engage.
  await A.evaluate(() => { window.__syncDeck("A"); window.__loadTestTrack("A", "/test-fixtures/kick120.wav"); });
  await A.waitForTimeout(2500);
  const e3 = errCount(sA) + errCount(sB);
  t.check("survives track load during engage", e3 === e2, e3 === e2 ? "no new errors" : `${e3 - e2} errors`);

  // ── Scenario 4: both sides load the SAME deck simultaneously (driver fight).
  await Promise.all([
    A.evaluate(() => window.__loadTestTrack("A", "/test-fixtures/kick120.wav")),
    B.evaluate(() => window.__loadTestTrack("A", "/test-fixtures/kick120.wav")),
  ]);
  await A.waitForTimeout(2500);
  const e4 = errCount(sA) + errCount(sB);
  t.check("survives both sides loading the same deck", e4 === e3, e4 === e3 ? "no new errors" : `${e4 - e3} errors`);

  // ── Still responsive afterward? A basic toggle must still fire the handler.
  const beforeToggle = sA.all("[PLAY-STATE] deck A toggle()").length;
  await A.evaluate(() => window.__toggleDeck("A"));
  await A.waitForTimeout(600);
  const responsive = sA.all("[PLAY-STATE] deck A toggle()").length > beforeToggle;
  t.check("app still responsive after the storms", responsive, "transport handler still fires");

  const errs = [...sA.errors(), ...sB.errors()];
  t.check("zero unhandled page errors across all chaos", errs.length === 0, errs.slice(0, 3).join(" | ") || "clean");
} catch (e) {
  t.check("no exceptions during run", false, e.message);
} finally {
  await browser.close();
}
t.done();
