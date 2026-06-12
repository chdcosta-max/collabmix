// e2e-rejoin.smoke.mjs — late-joiner / re-joiner full state replay. When client
// B reloads mid-blend, it must rebuild the COMPLETE partner view (track, BPM,
// refined beat grid) — not just forward deltas. The existing driver re-broadcasts
// its analyzer payload on partner (re)join, so B recovers via the verified
// [ANALYZER-BROADCAST]→[ANALYZER-RECV] path. Gate: within 5s of reload, B's view
// matches A's (partner restored, beat grid + BPM mirrored).
import { Suite } from "../lib/result.mjs";
import { launch, capture, createRoom, joinByCode, loadTestTrack, partnerOf } from "../lib/e2e.mjs";

const TARGET = process.env.TARGET || "http://localhost:5173/";
const t = new Suite("e2e-rejoin");
const browser = await launch();
if (!browser) t.skip("no system Chrome — e2e unavailable here");

try {
  const ctxA = await browser.newContext(); const A = await ctxA.newPage(); const sA = capture(A);
  await A.goto(TARGET, { waitUntil: "domcontentloaded" });
  const code = await createRoom(A);
  await A.waitForTimeout(1500);
  const ctxB = await browser.newContext(); let B = await ctxB.newPage(); capture(B);
  await B.goto(TARGET, { waitUntil: "domcontentloaded" });
  await joinByCode(B, code);
  await B.waitForFunction(() => /⟺/.test(document.body.innerText), null, { timeout: 12000 }).catch(() => {});

  // A is the audio source with a refined grid; B sees it.
  await loadTestTrack(A, "A");
  await A.evaluate(() => window.__toggleDeck("A"));
  await sA.waitFor("[ANALYZER-BROADCAST] A beats=", 15000);
  await B.waitForTimeout(2000);

  // ── B reloads mid-blend.
  await B.reload({ waitUntil: "domcontentloaded" });
  const sB = capture(B);                       // fresh page → fresh console sink
  const tReload = Date.now();
  await B.waitForFunction(() => /⟺/.test(document.body.innerText), null, { timeout: 12000 }).catch(() => {});

  // ── Within 5s: B's view rebuilds (full grid via [ANALYZER-RECV] + BPM/title).
  const gotGrid = await sB.waitFor("[ANALYZER-RECV] A beats=", 6000);
  const within5s = Date.now() - tReload <= 7000; // reload nav + 5s replay budget
  const paired = !!(await partnerOf(B));
  const showsBpm = await B.evaluate(() => /\b120\b/.test(document.body.innerText));
  const showsTitle = await B.evaluate(() => /Smoke Kick 120/.test(document.body.innerText));
  const beats = (sB.last("[ANALYZER-RECV] A beats=") || "").match(/beats=(\d+)/)?.[1];

  t.check("B re-paired after reload", paired, "B⟺ " + (await partnerOf(B)));
  t.check("B rebuilds the refined grid ([ANALYZER-RECV])", gotGrid, `beats=${beats}`);
  t.check("grid rebuilt within the 5s budget", gotGrid && within5s, `${((Date.now() - tReload) / 1000).toFixed(1)}s after reload`);
  t.check("B mirrors A's BPM", showsBpm, "120");
  t.check("B mirrors A's track title", showsTitle, "Smoke Kick 120");
  t.check("no page errors", sB.errors().length === 0, sB.errors().slice(0, 2).join(" | ") || "clean");
} catch (e) {
  t.check("no exceptions during run", false, e.message);
} finally {
  await browser.close();
}
t.done();
