// e2e-comp.smoke.mjs — delay compensation on a LIVE audio stream. A plays the
// fixture (audio source); the receiving side must measure a nonzero comp, and
// that measurement must survive a partner reload (renegotiation → rebind →
// recover). Needs real WebRTC audio; SKIPs if RTC never connects (headless env).
import { Suite } from "../lib/result.mjs";
import { launch, capture, createRoom, joinByCode, loadAndPlay } from "../lib/e2e.mjs";

const TARGET = process.env.TARGET || "http://localhost:5173/";
const Q = (TARGET.includes("?") ? "&" : "?") + "delaycomp=1&syncdebug=1";
const t = new Suite("e2e-comp");
const browser = await launch();
if (!browser) t.skip("no system Chrome — e2e unavailable here");

const measuredVal = (line) => { const m = (line || "").match(/measured=([\-\d.]+)/); return m ? parseFloat(m[1]) : null; };
const rtcUp = (s) => s.has("ice state: connected") || s.has("connection state: connected") || s.has("[RTC] incoming track");

try {
  const ctxA = await browser.newContext(); const A = await ctxA.newPage(); const sA = capture(A);
  await A.goto(TARGET + Q, { waitUntil: "domcontentloaded" });
  const code = await createRoom(A);
  await A.waitForTimeout(1500);
  const ctxB = await browser.newContext(); const B = await ctxB.newPage(); const sB = capture(B);
  await B.goto(TARGET + Q, { waitUntil: "domcontentloaded" });
  await joinByCode(B, code);
  await B.waitForFunction(() => /⟺/.test(document.body.innerText), null, { timeout: 12000 }).catch(() => {});

  // A is the audio source. loadAndPlay = race-safe (toggle-before-decode was a
  // silent no-op → comp measured on a silent-but-connected stream).
  await loadAndPlay(A, sA, "A");

  // Let RTC connect + jitter buffer fill + comp settle.
  await B.waitForTimeout(16000);

  if (!rtcUp(sA) && !rtcUp(sB)) t.skip("WebRTC never connected in this environment (headless audio) — comp untestable here");

  const compLinesA = sA.all("[SYNC-COMP] measured="), compLinesB = sB.all("[SYNC-COMP] measured=");
  const allMeas = [...compLinesA, ...compLinesB].map(measuredVal).filter((v) => v != null);
  const maxMeas = allMeas.length ? Math.max(...allMeas.map(Math.abs)) : 0;
  const measuredNonzero = maxMeas > 1; // >1ms = real measurement, not a zeroed stream
  t.check("comp measures nonzero on the live stream", measuredNonzero, `max |measured|=${maxMeas.toFixed(1)}ms (n=${allMeas.length})`);

  // ── Renegotiation: reload B → A rebuilds its receiver → comp must recover.
  const reloadAt = Date.now();
  sA.lines.length = 0;
  await B.reload({ waitUntil: "domcontentloaded" });
  await B.waitForTimeout(16000);
  const rebind = sA.has("[SYNC-COMP] rebind") || sA.has("rebind");
  const recoveredVals = sA.all("[SYNC-COMP] measured=").map(measuredVal).filter((v) => v != null && Math.abs(v) > 1);
  t.check("renegotiation rebinds the receiver after partner reload", rebind || recoveredVals.length > 0, rebind ? "rebind logged" : `recovered n=${recoveredVals.length}`);
  t.check("comp recovers (nonzero) after reload", recoveredVals.length > 0, `post-reload measurements=${recoveredVals.length}`);
  void reloadAt;
} catch (e) {
  t.check("no exceptions during run", false, e.message);
} finally {
  await browser.close();
}
t.done();
