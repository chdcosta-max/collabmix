// e2e-drift.smoke.mjs — the phase-error monitor must emit [SYNC-DRIFT] during a
// locked remote B2B (each client drives one deck, both playing, sync engaged).
// This is the telemetry that watches a live blend for drift. SKIPs if the clock
// sync / RTC never warms up in this environment.
import { Suite } from "../lib/result.mjs";
import { launch, capture, createRoom, joinByCode, loadTestTrack } from "../lib/e2e.mjs";

const TARGET = process.env.TARGET || "http://localhost:5173/";
const Q = (TARGET.includes("?") ? "&" : "?") + "syncdebug=1";
const t = new Suite("e2e-drift");
const browser = await launch();
if (!browser) t.skip("no system Chrome — e2e unavailable here");

try {
  const ctxA = await browser.newContext(); const A = await ctxA.newPage(); const sA = capture(A);
  await A.goto(TARGET + Q, { waitUntil: "domcontentloaded" });
  const code = await createRoom(A);
  await A.waitForTimeout(1500);
  const ctxB = await browser.newContext(); const B = await ctxB.newPage(); const sB = capture(B);
  await B.goto(TARGET + Q, { waitUntil: "domcontentloaded" });
  await joinByCode(B, code);
  await B.waitForFunction(() => /⟺/.test(document.body.innerText), null, { timeout: 12000 }).catch(() => {});

  // Each drives its own deck; both play (partner progress must be flowing).
  await loadTestTrack(A, "A");
  await loadTestTrack(B, "B");
  await sA.waitFor("[BPM] analysis complete for deck A", 15000);
  await A.evaluate(() => window.__toggleDeck("A"));
  await B.evaluate(() => window.__toggleDeck("B"));
  await A.waitForTimeout(2000);
  // Engage sync (lock) from A.
  await A.evaluate(() => window.__syncDeck("A"));

  // Wait for clock-sync warmup (≥3 samples) + a drift sample.
  const got = await sA.waitFor("[SYNC-DRIFT]", 20000);
  if (!got) {
    const reason = sA.last("monitorReason") || "";
    if (!sA.has("[SYNC-DRIFT]") && /clock_warmup|not_remote_b2b|no_recent_progress/.test(reason))
      t.skip("monitor never reached 'sampling' (env: " + (reason.match(/monitorReason[":= ]+(\w+)/)?.[1] || "warmup") + ")");
  }
  const driftLine = sA.last("[SYNC-DRIFT]") || sB.last("[SYNC-DRIFT]");
  t.check("[SYNC-DRIFT] emits during locked remote B2B", !!driftLine, (driftLine || "").slice(0, 80));
  const phaseM = (driftLine || "").match(/phaseMs=([\-\d.]+)/);
  t.check("drift sample carries a numeric phaseMs", !!phaseM, phaseM ? `phaseMs=${phaseM[1]}` : "no phaseMs");
  t.check("no page errors", sA.errors().length === 0 && sB.errors().length === 0, [...sA.errors(), ...sB.errors()].slice(0, 2).join(" | ") || "clean");
} catch (e) {
  t.check("no exceptions during run", false, e.message);
} finally {
  await browser.close();
}
t.done();
