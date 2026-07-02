// e2e-mirror-clump.smoke.mjs — the July 2 dogfood mirror bug stays dead: under
// DETERMINISTIC deck_update clumping (the mock netem stand-in for real TCP WS
// bursts — Jake's logs showed 100-600ms pktGaps), the mirror follower must NOT
// inherit the clump delay as lag. The render layer aligns the drawn playhead to
// the AUDIBLE position assuming the follower tracks truth, so follower lag reads
// directly as "audio leads the playhead" (~a beat in the dogfood).
//
// Gate (calibrated from the fix A/B, tools/smoke/out/mirror-fix-{on,off}-1.log):
//   legacy (arrival-time anchor): lag p90 +130ms, max +268ms  → FAILS
//   MIRROR_TSEND (send-time anchor): p90 +13ms, max +25ms     → passes 5-10×
// Bounds sit between the two with headroom for CI noise. Backward steps must be
// zero (the monotonic-follower guarantee, same property e2e-mirror-slew gates).
// Needs --mock (SKIPs without it).
import { Suite } from "../lib/result.mjs";
import { launch, capture, createRoom, joinByCode, loadTestTrack, appUrl, hasMock, setNetem, resetNetem, FIXTURE_URL } from "../lib/e2e.mjs";

const t = new Suite("e2e-mirror-clump");
if (!hasMock()) t.skip("needs the mock WS server (--mock) for deterministic netem");
const browser = await launch();
if (!browser) t.skip("no system Chrome — e2e unavailable here");

const SAMPLE_SEC = 15;
const P90_BOUND_MS = 80;   // legacy 130, fixed 13
const MAX_BOUND_MS = 150;  // legacy 268, fixed 25

try {
  const ctxA = await browser.newContext(); const A = await ctxA.newPage(); const sA = capture(A);
  const ctxB = await browser.newContext(); const B = await ctxB.newPage(); capture(B);
  await A.goto(appUrl(), { waitUntil: "domcontentloaded" });
  const code = await createRoom(A);
  await A.waitForTimeout(1500);
  await B.goto(appUrl(), { waitUntil: "domcontentloaded" });
  await joinByCode(B, code);
  await B.waitForFunction(() => /⟺/.test(document.body.innerText), null, { timeout: 12000 }).catch(() => {});

  // Race-safe load+play (toggle before decode = silent no-op, hasBuf=false).
  await loadTestTrack(A, "A", FIXTURE_URL);
  await sA.waitFor("[ANALYZER-BROADCAST]", 60000);
  await A.evaluate(() => window.__toggleDeck("A"));
  const played = await sA.waitFor("hasBuf=true", 5000);
  t.check("deck A entered play with a decoded buffer", played, played ? "hasBuf=true" : "hasBuf=false — load race");

  // Jake-profile clumping on progress packets only; applied AFTER play so setup
  // is crisp and the sampled window is fully shaped. Seeded → reproducible.
  await setNetem({ latencyMs: 80, jitterMs: 260, lossPct: 0, seed: 42, types: ["deck_update"] });
  await B.waitForTimeout(4000); // settle under netem

  // Fixture is 12s and play started ~4s ago; re-seek to keep A playing through
  // the whole sample window (seek packets are shaped too — that's fine, the
  // follower must absorb them; seekEpoch snaps are position-exact).
  const sampler = (secs) => `
    new Promise((res) => {
      const out = [];
      const t0 = Date.now();
      const tick = () => {
        out.push([Date.now(), window.__deckProg("A")]);
        if (Date.now() - t0 < ${secs} * 1000) requestAnimationFrame(tick); else res(out);
      };
      requestAnimationFrame(tick);
    })`;
  const keepAlive = (async () => { for (let i = 0; i < Math.ceil(SAMPLE_SEC / 8); i++) { await A.waitForTimeout(8000); await A.evaluate(() => window.__seekDeck("A", 0.05)).catch(() => {}); } })();
  const [sa, sb] = await Promise.all([A.evaluate(sampler(SAMPLE_SEC)), B.evaluate(sampler(SAMPLE_SEC))]);
  await keepAlive;

  // mirror lag series (see measure-mirror.mjs): interpolate A onto B timestamps.
  const durSec = 12; // fixture duration — fixed, no slope estimate needed
  let j = 0; const lags = [];
  for (const [ts, pb] of sb) {
    while (j < sa.length - 2 && sa[j + 1][0] <= ts) j++;
    const [t1, p1] = sa[j], [t2, p2] = sa[Math.min(j + 1, sa.length - 1)];
    const pa = t2 === t1 ? p1 : p1 + ((ts - t1) / (t2 - t1)) * (p2 - p1);
    const lag = (pa - pb) * durSec * 1000;
    if (Math.abs(lag) < 3000) lags.push(lag); // exclude seek-snap transients (position jumps)
  }
  const s = [...lags].sort((a, b) => a - b);
  const p90 = s[Math.floor(s.length * 0.9)], max = s[s.length - 1];
  t.check(`mirror lag p90 under clumping < ${P90_BOUND_MS}ms`, p90 < P90_BOUND_MS, `p90=${p90.toFixed(0)}ms (legacy ~130, fixed ~13; n=${lags.length})`);
  t.check(`mirror lag max under clumping < ${MAX_BOUND_MS}ms`, max < MAX_BOUND_MS, `max=${max.toFixed(0)}ms (legacy ~268, fixed ~25)`);

  // monotonicity: the mirror never steps backward (excluding genuine seek snaps)
  let backs = 0;
  for (let i = 1; i < sb.length; i++) {
    const step = (sb[i][1] - sb[i - 1][1]) * durSec * 1000;
    if (step < -1 && step > -2000) backs++; // < −2s = the keep-alive re-seek snap, allowed
  }
  t.check("no backward mirror steps under clumping", backs === 0, `backward steps=${backs}`);
} catch (e) {
  t.check("no exceptions during run", false, e.message);
} finally {
  await resetNetem().catch(() => {});
  await browser.close();
}
t.done();
