// e2e-mirror.smoke.mjs — the partner-deck waveform MIRROR must MOVE. The driver
// plays a deck; the non-driver's mirror of that deck must advance smoothly
// forward — no backward skips (the "bounces back multiple bars" bug), no freeze
// (the "starved of updates" bug). None of the prior 15 tests asserted the mirror
// actually moves, so this class could ship silently. Reads the non-driver's
// displayed playhead via window.__deckProg.
import { Suite } from "../lib/result.mjs";
import { launch, capture, createRoom, joinByCode, loadTestTrack } from "../lib/e2e.mjs";

const TARGET = process.env.TARGET || "http://localhost:5173/";
const t = new Suite("e2e-mirror");
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
  await A.evaluate(() => window.__toggleDeck("A"));
  await B.waitForFunction(() => !!window.__smokeReady, null, { timeout: 8000 });

  // Sample the non-driver's mirror of deck A over ~4s.
  const samples = [];
  for (let i = 0; i < 16; i++) { await B.waitForTimeout(250); samples.push(await B.evaluate(() => window.__deckProg("A"))); }
  const valid = samples.filter(x => typeof x === "number");
  let advanced = 0, backward = 0, maxBack = 0;
  for (let i = 1; i < valid.length; i++) {
    const d = valid[i] - valid[i - 1];
    if (d > 1e-5) advanced++;
    if (d < -1e-4) { backward++; maxBack = Math.max(maxBack, -d); }
  }
  const moved = valid.length > 1 && (valid[valid.length - 1] - valid[0]) > 0.02;

  t.check("mirror reports a numeric playhead", valid.length >= 12, `${valid.length}/16 samples`);
  t.check("mirror advances (not frozen)", advanced >= 10 && moved, `${advanced} advancing steps, ${valid[0]?.toFixed?.(3)}→${valid[valid.length-1]?.toFixed?.(3)}`);
  t.check("mirror never skips backward", backward === 0, backward ? `${backward} backward steps, max ${(maxBack).toFixed(4)}` : "monotonic forward");
  t.check("no page errors", sA.errors().length === 0 && sB.errors().length === 0, [...sA.errors(), ...sB.errors()].slice(0, 2).join(" | ") || "clean");
} catch (e) {
  t.check("no exceptions during run", false, e.message);
} finally {
  await browser.close();
}
t.done();
