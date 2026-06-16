// e2e-mirror-seek.smoke.mjs — the partner mirror must hard-snap on a REAL seek
// (driver bumps seekEpoch → deterministic snap), and must stay STATIC while paused
// unless the partner genuinely re-cues. Guards the move2 follow-up fix that replaced
// the magnitude-guess snap (false "+35s" snaps) with the seekEpoch signal, and gated
// the paused re-snap (the "moves while paused" / slide-back bug).
import { Suite } from "../lib/result.mjs";
import { launch, capture, createRoom, joinByCode, loadTestTrack } from "../lib/e2e.mjs";

const TARGET = process.env.TARGET || "http://localhost:5173/";
const FIXTURE_DUR_SEC = 12;     // gen-fixture.mjs SECONDS
const t = new Suite("e2e-mirror-seek");
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
  await A.evaluate(() => window.__toggleDeck("A"));   // driver A starts playing deck A
  await B.waitForFunction(() => !!window.__smokeReady, null, { timeout: 8000 });

  // ── Phase 1: normal coast — the mirror tracks WITHOUT a false snap ──────────
  await B.waitForTimeout(1500);
  const falseSnapDuringCoast = sB.has("[MIRROR-SNAP]");
  t.check("no false snap during normal coast", !falseSnapDuringCoast,
    falseSnapDuringCoast ? "MIRROR-SNAP fired with no seek" : "clean coast");

  // ── Phase 2: a REAL forward seek must hard-snap the mirror (epoch path) ──────
  const before = await B.evaluate(() => window.__deckProg("A"));
  await A.evaluate(() => window.__seekDeck("A", 0.7));   // big forward jump on the driver
  // The mirror should reach the new position FAST (snap), not slow-coast toward it.
  let snappedTo = null;
  for (let i = 0; i < 8; i++) {           // ~800ms budget
    await B.waitForTimeout(100);
    const p = await B.evaluate(() => window.__deckProg("A"));
    if (typeof p === "number" && p > 0.55) { snappedTo = p; break; }
  }
  const snapped = snappedTo != null && Math.abs(snappedTo - 0.7) < 0.08;
  t.check("real seek hard-snaps the mirror to the new position (epoch)", snapped,
    `before=${before?.toFixed(3)} after=${snappedTo?.toFixed(3) ?? "—"} (target ~0.70)`);
  t.check("snap was logged ([MIRROR-SNAP] fired on the real seek)", sB.has("[MIRROR-SNAP]"),
    "driver seekEpoch advanced → mirror snapped");

  // ── Phase 3: paused mirror stays STATIC (no movement while paused) ──────────
  await A.evaluate(() => window.__toggleDeck("A"));   // pause
  await B.waitForTimeout(400);                         // let the pause settle
  const pausedSeq = [];
  for (let i = 0; i < 6; i++) { await B.waitForTimeout(180); pausedSeq.push(await B.evaluate(() => window.__deckProg("A"))); }
  const nums = pausedSeq.filter((x) => typeof x === "number");
  let maxDriftMs = 0;
  for (let i = 1; i < nums.length; i++) maxDriftMs = Math.max(maxDriftMs, Math.abs(nums[i] - nums[i - 1]) * FIXTURE_DUR_SEC * 1000);
  t.check("paused mirror stays static (no movement while paused)", maxDriftMs < 30,
    `max frame-to-frame drift ${maxDriftMs.toFixed(0)}ms over ${nums.length} samples`);

  // ── Phase 4: a genuine paused RE-CUE still moves the mirror ──────────────────
  await A.evaluate(() => window.__seekDeck("A", 0.2));   // re-cue while paused
  let recued = null;
  for (let i = 0; i < 8; i++) { await B.waitForTimeout(120); const p = await B.evaluate(() => window.__deckProg("A")); if (typeof p === "number" && p < 0.4) { recued = p; break; } }
  t.check("genuine paused re-cue moves the mirror", recued != null && Math.abs(recued - 0.2) < 0.1,
    `re-cued to ${recued?.toFixed(3) ?? "—"} (target ~0.20)`);

  t.check("no page errors", sA.errors().length === 0 && sB.errors().length === 0,
    [...sA.errors(), ...sB.errors()].slice(0, 2).join(" | ") || "clean");
} catch (e) {
  t.check("test ran without throwing", false, e.message);
} finally {
  await browser.close();
}

t.done();
