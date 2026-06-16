// e2e-seek-smooth.smoke.mjs — the smooth-seek crossfade (Option B) must not break
// correctness: rapid seeks while playing keep the deck PLAYING (no false track-end
// from a fade tail's onended), land EXACTLY on the target (crossfade is gain-only,
// position unchanged), throw no errors, and leave NO accumulated source nodes (fade
// tails are released, not leaked). Audio click-freeness itself is the by-ear gate.
import { Suite } from "../lib/result.mjs";
import { launch, capture, createRoom, loadTestTrack } from "../lib/e2e.mjs";

const TARGET = process.env.TARGET || "http://localhost:5173/";
const FIXTURE_DUR_SEC = 12;
const t = new Suite("e2e-seek-smooth");
const browser = await launch();
if (!browser) t.skip("no system Chrome — e2e unavailable here");

try {
  const ctxA = await browser.newContext(); const A = await ctxA.newPage(); const sA = capture(A);
  await A.goto(TARGET, { waitUntil: "domcontentloaded" });
  await createRoom(A);
  await loadTestTrack(A, "A");
  await sA.waitFor("[ANALYZER-BROADCAST] A beats=", 15000);
  await A.evaluate(() => window.__toggleDeck("A"));   // play deck A
  await A.waitForFunction(() => !!window.__smokeReady, null, { timeout: 8000 });
  await A.waitForTimeout(600);

  // ── Rapid seeks while playing (~70ms apart — crosses the ~12ms xfade window so
  //    both the common path and the rapid-re-seek path are exercised). ──
  const targets = [0.20, 0.55, 0.15, 0.70, 0.35, 0.62, 0.25, 0.48, 0.18, 0.66];
  for (const f of targets) { await A.evaluate((v) => window.__seekDeck("A", v), f); await A.waitForTimeout(70); }

  // (a) still PLAYING — no spurious pause from a fade tail's onended firing setPlay(false).
  await A.evaluate(() => window.__seekDeck("A", 0.40));
  const p0 = await A.evaluate(() => window.__deckProg("A"));
  await A.waitForTimeout(500);
  const p1 = await A.evaluate(() => window.__deckProg("A"));
  const advanced = typeof p0 === "number" && typeof p1 === "number" && (p1 - p0) > 0.005;
  t.check("deck keeps PLAYING through rapid seeks (no false track-end)", advanced,
    `prog ${p0?.toFixed(3)}→${p1?.toFixed(3)} (must advance)`);

  // (b) position lands EXACTLY on the target (crossfade is gain-only — no drift).
  await A.evaluate(() => window.__seekDeck("A", 0.50));
  await A.waitForTimeout(120);
  const landed = await A.evaluate(() => window.__deckProg("A"));
  // playing → seek quantizes to nearest beat; tolerance covers one beat at 120 BPM / 12s.
  const exact = typeof landed === "number" && Math.abs(landed - 0.50) < 0.07;
  t.check("seek lands exactly on target (no position drift)", exact,
    `landed=${landed?.toFixed(3)} (target 0.50, ±0.07 quantize)`);

  // (c) NO source-node accumulation — after the fade window, only the live source remains.
  await A.evaluate(() => window.__toggleDeck("A"));   // pause → stop_ releases the current source
  await A.waitForTimeout(200);                          // let any fade tails finish + onended-cleanup run
  const liveAfterPause = await A.evaluate(() => window.__liveSourceCount());
  t.check("no source-node leak (fade tails released)", liveAfterPause === 0,
    `live AudioBufferSourceNodes after pause+settle = ${liveAfterPause} (expect 0)`);

  t.check("no page errors", sA.errors().length === 0, sA.errors().slice(0, 2).join(" | ") || "clean");
} catch (e) {
  t.check("test ran without throwing", false, e.message);
} finally {
  await browser.close();
}

t.done();
