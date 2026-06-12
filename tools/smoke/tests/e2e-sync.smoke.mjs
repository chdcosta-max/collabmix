// e2e-sync.smoke.mjs — SYNC engage end-to-end over the real B2B path (A drives
// deck A, B drives deck B, analysis mirrored). Asserts the engage succeeds and
// is IDEMPOTENT: re-engaging from the already-aligned state moves the slave
// <10ms (the wander regression the beat-grid unification fixed). The absolute
// alignment math is covered by the unit `engage` test; this proves the real
// path runs and doesn't walk.
import { Suite } from "../lib/result.mjs";
import { launch, capture, createRoom, joinByCode, loadTestTrack } from "../lib/e2e.mjs";

const TARGET = process.env.TARGET || "http://localhost:5173/";
const t = new Suite("e2e-sync");
const browser = await launch();
if (!browser) t.skip("no system Chrome — e2e unavailable here");

const phaseSeekMs = (line) => { const m = (line || "").match(/phaseSeekMs=([\-\d.]+)/); return m ? parseFloat(m[1]) : null; };

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
  await sA.waitFor("bpm= 120", 4000).catch(() => {});

  // Play A first (→ auto-master), then B a beat later (→ a real phase offset),
  // let them run so positions are well past 0.
  await A.evaluate(() => window.__toggleDeck("A"));
  await A.waitForTimeout(350);
  await B.evaluate(() => window.__toggleDeck("B"));
  await A.waitForTimeout(2500);

  // First engage.
  const firstIdx = sA.all("[SYNC-ENGAGE-QUALITY]").length;
  await A.evaluate(() => window.__syncDeck("A"));
  await sA.waitFor("[SYNC-ENGAGE-QUALITY]", 6000);
  await A.waitForTimeout(800);
  const q1 = sA.all("[SYNC-ENGAGE-QUALITY]")[firstIdx] || sA.last("[SYNC-ENGAGE-QUALITY]");
  const ok1 = /result=ok/.test(q1 || "");
  t.check("first engage succeeds (result=ok)", ok1, (q1 || "").replace(/.*\[SYNC-ENGAGE-QUALITY\]/, "").slice(0, 70));

  // Toggle OFF then re-engage. Decks stay phase-locked (rates persist), so the
  // 2nd engage should find them aligned and move the slave <10ms.
  await A.evaluate(() => window.__syncDeck("A")); // off
  await A.waitForTimeout(700);
  const beforeReeng = sA.all("[SYNC-ENGAGE-QUALITY]").length;
  await A.evaluate(() => window.__syncDeck("A")); // re-engage
  await sA.waitFor("[SYNC-ENGAGE-QUALITY]", 6000);
  await A.waitForTimeout(500);
  const q2 = sA.all("[SYNC-ENGAGE-QUALITY]")[beforeReeng] || sA.last("[SYNC-ENGAGE-QUALITY]");
  const seek2 = phaseSeekMs(q2);
  // Bound = 30ms. The WANDER regression walked ~a full beat (250-500ms) per
  // re-press; 30ms catches that with margin while tolerating live jitter (the
  // master phase comes from 10Hz partner progress packets, so a 2-client
  // re-engage offset jitters a few ms run-to-run). The exact <0.5ms idempotency
  // of the math is proven by the unit `engage` test.
  const IDEMP_MS = 30;
  t.check(`re-engage idempotent (|phaseSeek| < ${IDEMP_MS}ms — no wander)`, seek2 != null && Math.abs(seek2) < IDEMP_MS, `re-engage phaseSeekMs=${seek2}`);
  t.check("re-engage also result=ok", /result=ok/.test(q2 || ""), (q2 || "").replace(/.*\[SYNC-ENGAGE-QUALITY\]/, "").slice(0, 70));

  t.check("no page errors", sA.errors().length === 0 && sB.errors().length === 0, [...sA.errors(), ...sB.errors()].slice(0, 2).join(" | ") || "clean");
} catch (e) {
  t.check("no exceptions during run", false, e.message);
} finally {
  await browser.close();
}
t.done();
