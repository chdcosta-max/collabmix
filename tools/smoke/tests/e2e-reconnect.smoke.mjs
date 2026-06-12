// e2e-reconnect.smoke.mjs — a mid-session WS drop must auto-recover. Simulate a
// real network blip on client B (context.setOffline), then restore: B must
// re-dial with backoff, re-join the room, and see its partner again — not
// silently die. Verifies the [RECONNECT] log family.
import { Suite } from "../lib/result.mjs";
import { launch, capture, createRoom, joinByCode, partnerOf } from "../lib/e2e.mjs";

const TARGET = process.env.TARGET || "http://localhost:5173/";
const t = new Suite("e2e-reconnect");
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
  const pairedBefore = !!(await partnerOf(B));
  t.check("paired before the blip", pairedBefore, "B sees a partner");

  // ── Network blip on B: drop the WS (as if the connection died).
  await B.waitForFunction(() => !!window.__smokeReady, null, { timeout: 12000 });
  await B.evaluate(() => window.__dropWS());
  const scheduled = await sB.waitFor("[RECONNECT] phase=schedule", 12000);
  t.check("WS drop triggers a reconnect attempt (not silent death)", scheduled, sB.last("[RECONNECT] phase=schedule")?.replace(/.*\[RECONNECT\]/, "[RECONNECT]") || "");

  // ── Recovery: B reconnects + re-joins within the window.
  const recovered = await sB.waitFor("[RECONNECT] phase=success", 25000);
  t.check("B reconnects + re-joins after the blip", recovered, sB.last("[RECONNECT] phase=success")?.replace(/.*\[RECONNECT\]/, "[RECONNECT]") || "");
  await B.waitForTimeout(3000);
  const pairedAfter = !!(await partnerOf(B));
  t.check("partner restored after reconnect", pairedAfter, "B⟺ " + (await partnerOf(B)));

  t.check("no page errors", sB.errors().length === 0, sB.errors().slice(0, 2).join(" | ") || "clean");
} catch (e) {
  t.check("no exceptions during run", false, e.message);
} finally {
  await browser.close();
}
t.done();
