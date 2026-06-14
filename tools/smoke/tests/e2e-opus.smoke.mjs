// e2e-opus.smoke.mjs — PROOF that partner audio negotiates MUSIC-GRADE Opus
// (stereo + high bitrate), not the voice-grade default (~mono ~32 kbps). Both
// clients play a deck so audio flows both ways; we read the NEGOTIATED codec
// fmtp + channels straight from getStats (surfaced by the app's [OPUS-SDP] log,
// which reads RTCCodecStats.sdpFmtpLine — the negotiated result, not the string
// we munged) and assert stereo=1 + maxaveragebitrate=256000. Needs real WebRTC
// audio; SKIPs if RTC never connects (headless env).
import { Suite } from "../lib/result.mjs";
import { launch, capture, createRoom, joinByCode, loadTestTrack } from "../lib/e2e.mjs";

const TARGET = process.env.TARGET || "http://localhost:5173/";
const t = new Suite("e2e-opus");
const browser = await launch();
if (!browser) t.skip("no system Chrome — e2e unavailable here");

const rtcUp = (s) => s.has("ice state: connected") || s.has("connection state: connected") || s.has("[RTC] incoming track");
const fmtpOf = (line) => { const m = (line || "").match(/fmtp="([^"]*)"/); return m ? m[1] : ""; };
const kbpsOf = (line) => { const m = (line || "").match(/bitrateKbps=([\d.]+)/); return m ? parseFloat(m[1]) : null; };

try {
  const ctxA = await browser.newContext(); const A = await ctxA.newPage(); const sA = capture(A);
  await A.goto(TARGET, { waitUntil: "domcontentloaded" });
  const code = await createRoom(A);
  await A.waitForTimeout(1500);
  const ctxB = await browser.newContext(); const B = await ctxB.newPage(); const sB = capture(B);
  await B.goto(TARGET, { waitUntil: "domcontentloaded" });
  await joinByCode(B, code);
  await B.waitForFunction(() => /⟺/.test(document.body.innerText), null, { timeout: 12000 }).catch(() => {});

  // Both play a deck → audio flows BOTH ways → both receivers get frames so the
  // [OPUS-SDP] probe fires on both sides (proves both directions negotiated hi-fi).
  await loadTestTrack(A, "A");
  await loadTestTrack(B, "B");
  await A.evaluate(() => window.__toggleDeck("A"));
  await B.evaluate(() => window.__toggleDeck("B"));

  // RTC connect + audio flow + the one-shot [OPUS-SDP] probe (~2.5s after connect).
  await B.waitForTimeout(16000);

  if (!rtcUp(sA) && !rtcUp(sB)) t.skip("WebRTC never connected in this environment (headless audio) — Opus negotiation untestable here");

  const recvA = sA.last("[OPUS-SDP] RECV"); // A receiving B's stream
  const recvB = sB.last("[OPUS-SDP] RECV"); // B receiving A's stream
  const proven = [recvA, recvB].filter(Boolean);
  t.check("[OPUS-SDP] logged on a receiver (RTC audio flowed)", proven.length > 0, `A:${!!recvA} B:${!!recvB}`);

  // The NEGOTIATED fmtp (from getStats, not our munge input) must carry hi-fi.
  const hasStereo = proven.some((l) => /stereo=1/.test(fmtpOf(l)));
  const hasBitrate = proven.some((l) => /maxaveragebitrate=256000/.test(fmtpOf(l)));
  const bothOnOne = proven.some((l) => /stereo=1/.test(fmtpOf(l)) && /maxaveragebitrate=256000/.test(fmtpOf(l)));
  const sample = (fmtpOf(proven[0]) || "none");
  t.check("partner Opus negotiated STEREO (stereo=1 in negotiated fmtp)", hasStereo, sample.slice(0, 100));
  t.check("partner Opus negotiated 256kbps (maxaveragebitrate=256000)", hasBitrate, sample.slice(0, 100));
  t.check("one stream proves both — true music-grade (not voice default)", bothOnOne, proven.map(fmtpOf).join(" || ").slice(0, 140));

  // Live receive bitrate — LOGGED, not gated. maxaveragebitrate is a CAP, not a
  // floor, and the synthetic fixture is a sparse 12s kick loop that ends before
  // this window (Opus DTX → ~0 during silence), so throughput is uninformative
  // here. The negotiated fmtp above is the rigorous proof; real-music throughput
  // is a live check. (On voice content this would sit ~32k; the cap is now 256k.)
  const kbps = proven.map(kbpsOf).filter((v) => v != null);
  const maxKbps = kbps.length ? Math.max(...kbps) : 0;
  console.log(`[OPUS-INFO] live receive bitrate ${maxKbps.toFixed(0)}kbps (cap raised to 256; content/timing-dependent on the kick fixture — fmtp negotiation is the proof)`);

  t.check("connection clean (no page errors)", sA.errors().length === 0 && sB.errors().length === 0, [...sA.errors(), ...sB.errors()].slice(0, 2).join(" | ") || "clean");
} catch (e) {
  t.check("no exceptions during run", false, e.message);
} finally {
  await browser.close();
}
t.done();
