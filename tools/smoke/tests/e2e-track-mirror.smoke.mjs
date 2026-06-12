// e2e-track-mirror.smoke.mjs — driver loads a track; the partner mirrors its
// title, BPM, waveform and refined beatTimes. Driver broadcasts via
// [ANALYZER-BROADCAST]; partner confirms via [DRIVER-RECV] (meta) +
// [ANALYZER-RECV] (beat grid) + BPM rendered in the partner deck.
import { Suite } from "../lib/result.mjs";
import { launch, capture, createRoom, joinByCode, loadTestTrack } from "../lib/e2e.mjs";

const TARGET = process.env.TARGET || "http://localhost:5173/";
const t = new Suite("e2e-track-mirror");
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

  // Driver A loads the fixture through the real path.
  await loadTestTrack(A, "A");

  const aBroadcast = await sA.waitFor("[ANALYZER-BROADCAST] A beats=", 15000);
  const bMeta = await sB.waitFor("[DRIVER-RECV]", 12000);
  const bBeats = await sB.waitFor("[ANALYZER-RECV] A beats=", 12000);
  await B.waitForTimeout(1500);
  const bShowsBpm = await B.evaluate(() => /\b120\b/.test(document.body.innerText));
  const bShowsTitle = await B.evaluate(() => /Smoke Kick 120/.test(document.body.innerText));
  const beatsBroad = (sA.last("[ANALYZER-BROADCAST] A beats=") || "").match(/beats=(\d+)/)?.[1];
  const beatsRecv = (sB.last("[ANALYZER-RECV] A beats=") || "").match(/beats=(\d+)/)?.[1];

  t.check("driver broadcast beatTimes ([ANALYZER-BROADCAST])", aBroadcast, `A beats=${beatsBroad}`);
  t.check("partner received track meta ([DRIVER-RECV])", bMeta, sB.last("[DRIVER-RECV]")?.slice(0, 70) || "");
  t.check("partner received beatTimes ([ANALYZER-RECV])", bBeats, `B got beats=${beatsRecv}`);
  t.check("beat counts match across the wire", beatsBroad && beatsBroad === beatsRecv, `broadcast=${beatsBroad} recv=${beatsRecv}`);
  t.check("partner renders BPM 120", bShowsBpm, "BPM mirrored");
  t.check("partner renders track title", bShowsTitle, "title mirrored");
  t.check("no page errors", sA.errors().length === 0 && sB.errors().length === 0, [...sA.errors(), ...sB.errors()].slice(0, 2).join(" | ") || "clean");
} catch (e) {
  t.check("no exceptions during run", false, e.message);
} finally {
  await browser.close();
}
t.done();
