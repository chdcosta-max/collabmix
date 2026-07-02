// measure-mirror.mjs — mirror-pipeline repro: two-tab loopback, A plays a real
// track, B's MIRROR of deck A is sampled at rAF cadence SIMULTANEOUSLY with A's
// local truth (shared wall clock via Date.now), so we can measure directly:
//   mirrorLagMs(t) = A_localProg(t) − B_mirrorProg(t)   (in track-time ms)
//   audio B hears ≈ A_localProg(t − compMs)  ⇒  audioLeadsPlayheadMs ≈ mirrorLag − comp
// Jake's complaint = audio leads the mirrored playhead by ~a beat (~470ms @128).
// [GRID-ALIGN-DIAG] (app's own instrumentation) ASSUMES mirrorLag≈0 — this run
// tests that assumption instead of trusting it.
// Also quantifies mirror smoothness: update cadence, step sizes, backward steps,
// stalls — the "jittery waveform" half of the report.
//
//   node tools/smoke/measure-mirror.mjs                 # 30s sample, localhost:5173
//   SAMPLE_SEC=60 FLAGS="mirrordiag=1" node tools/smoke/measure-mirror.mjs
//
// Mock + netem mode (Jake-repro): start the mock WS server, export MOCK_WS_URL,
// and pass a netem profile — deck_update clumping is injected AFTER play is
// verified, so setup stays crisp and the sample window is fully shaped:
//   node tools/smoke/lib/mock-ws-server.mjs 8090 &
//   MOCK_WS_URL=ws://127.0.0.1:8090 \
//   NETEM_WS='{"latencyMs":80,"jitterMs":260,"seed":42,"types":["deck_update"]}' \
//   LABEL=ws-clump node tools/smoke/measure-mirror.mjs
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, capture, createRoom, joinByCode, loadTestTrack, appUrl, setNetem, resetNetem } from "./lib/e2e.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET = process.env.TARGET || "http://localhost:5173/";
const FLAGS = process.env.FLAGS || "mirrordiag=1";
const Q = (TARGET.includes("?") ? "&" : "?") + FLAGS;
const SAMPLE_SEC = parseFloat(process.env.SAMPLE_SEC || "30");
const SETTLE_SEC = parseFloat(process.env.SETTLE_SEC || "12");
const TRACK = process.env.TRACK || "/@fs/Users/chad/Desktop/collabmix/tools/bpm-test-harness/tracks/Kyotto%20-%20Home%20In%20The%20Sky%20(Original%20Mix).mp3";
const LABEL = process.env.LABEL || "default";
const OUT_DIR = resolve(__dirname, "out");
const die = (m) => { console.error("✗ " + m); process.exit(1); };

const browser = await launch();
if (!browser) die("no system Chrome");
const ctxA = await browser.newContext(); const A = await ctxA.newPage(); const sA = capture(A);
const ctxB = await browser.newContext(); const B = await ctxB.newPage(); const sB = capture(B);
await A.goto(appUrl(TARGET + Q), { waitUntil: "domcontentloaded" });
const code = await createRoom(A);
await A.waitForTimeout(1500);
await B.goto(appUrl(TARGET + Q), { waitUntil: "domcontentloaded" });
await joinByCode(B, code);
await B.waitForFunction(() => /⟺/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});

// CPU_THROTTLE_B=<rate> — CDP CPU throttling on the RECEIVER page (Jake's-render-
// load proxy): rAF gaps → the follower's capped catch-up falls genuinely behind.
if (process.env.CPU_THROTTLE_B) {
  const cdp = await B.context().newCDPSession(B);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: parseFloat(process.env.CPU_THROTTLE_B) });
  console.log(`✓ CPU throttle ${process.env.CPU_THROTTLE_B}x on B (receiver)`);
}

await loadTestTrack(A, "A", TRACK);
await sA.waitFor("[ANALYZER-BROADCAST]", 90000);
await A.evaluate(() => window.__toggleDeck("A"));
if (!(await sA.waitFor("hasBuf=true", 5000))) die("deck A toggled without buffer");
await A.waitForTimeout(2500);
const p0 = await A.evaluate(() => window.__deckProg("A"));
if (!(p0 > 0.001)) die("deck A not advancing");
if (process.env.NETEM_WS) {
  const prof = JSON.parse(process.env.NETEM_WS);
  const r = await setNetem(prof);
  if (!r) die("NETEM_WS set but no MOCK_WS_URL — start the mock WS server first");
  console.log("✓ WS netem ON: " + JSON.stringify(prof));
}
console.log(`✓ deck A playing; settling ${SETTLE_SEC}s (RTC + jitter buffer + comp)…`);
await B.waitForTimeout(SETTLE_SEC * 1000);

// ── simultaneous samplers: [DateNowMs, prog] per rAF frame on each side
const sampler = (deck, secs) => `
  new Promise((res) => {
    const out = [];
    const t0 = Date.now();
    const tick = () => {
      out.push([Date.now(), window.__deckProg("${deck}")]);
      if (Date.now() - t0 < ${secs} * 1000) requestAnimationFrame(tick); else res(out);
    };
    requestAnimationFrame(tick);
  })`;
console.log(`sampling both sides for ${SAMPLE_SEC}s…`);
const [sa, sb] = await Promise.all([A.evaluate(sampler("A", SAMPLE_SEC)), B.evaluate(sampler("A", SAMPLE_SEC))]);

// ── track duration from A's own slope (local deck advances at 1/dur per sec)
const slope = (xs) => {
  const n = xs.length, mx = xs.reduce((s, r) => s + r[0], 0) / n, my = xs.reduce((s, r) => s + r[1], 0) / n;
  let num = 0, den = 0; for (const [x, y] of xs) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
  return num / den; // prog per ms
};
const durSec = 1 / (slope(sa) * 1000);
console.log(`track duration (from A's slope): ${durSec.toFixed(1)}s`);
const toMs = (dp) => dp * durSec * 1000;

// ── mirror lag: interpolate A's series onto B's timestamps
let j = 0;
const lags = [];
for (const [t, pb] of sb) {
  while (j < sa.length - 2 && sa[j + 1][0] <= t) j++;
  const [t1, p1] = sa[j], [t2, p2] = sa[Math.min(j + 1, sa.length - 1)];
  const pa = t2 === t1 ? p1 : p1 + ((t - t1) / (t2 - t1)) * (p2 - p1);
  lags.push(toMs(pa - pb));
}
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b), n = s.length;
  return { n, min: s[0], p10: s[Math.floor(n * .1)], p50: s[n >> 1], p90: s[Math.floor(n * .9)], max: s[n - 1], mean: xs.reduce((a, b) => a + b, 0) / n };
};
const f = (v) => v.toFixed(0).padStart(5);
const ls = stats(lags);
console.log(`\n=== MIRROR LAG (A truth − B mirror, track-ms; + = mirror BEHIND sender) ===`);
console.log(`  n=${ls.n}  min=${f(ls.min)}  p10=${f(ls.p10)}  p50=${f(ls.p50)}  p90=${f(ls.p90)}  max=${f(ls.max)}  mean=${f(ls.mean)}`);

// comp on B (audio delay of A's stream at B) → audio-vs-playhead verdict
const compVals = sB.all("[SYNC-COMP] measured=").map((l) => { const m = l.match(/measured=([\d.]+)/); return m ? +m[1] : null; }).filter((v) => v != null && v > 1);
const comp = compVals.length ? compVals[compVals.length - 1] : null;
console.log(`  B's measured comp (audio delay): ${comp == null ? "?" : comp.toFixed(0)}ms`);
if (comp != null) console.log(`  ⇒ audioLeadsPlayhead ≈ p50 lag − comp = ${(ls.p50 - comp).toFixed(0)}ms  (positive = Jake's complaint, audio ahead of drawn playhead)`);

// ── smoothness of B's mirror motion
const changes = [];   // [dtMs since last change, stepTrackMs]
let lastT = sb[0][0], lastP = sb[0][1], stalls = 0, backs = 0, backMs = 0;
for (let i = 1; i < sb.length; i++) {
  const [t, p] = sb[i];
  if (p !== lastP) {
    const step = toMs(p - lastP), dt = t - lastT;
    changes.push([dt, step]);
    if (step < 0) { backs++; backMs += -step; }
    if (dt > 150) stalls++;
    lastT = t; lastP = p;
  }
}
const upd = stats(changes.map((c) => c[0])), stp = stats(changes.map((c) => c[1]));
console.log(`\n=== B MIRROR MOTION (smoothness) ===`);
console.log(`  displayed-value updates: ${changes.length} over ${SAMPLE_SEC}s = ${(changes.length / SAMPLE_SEC).toFixed(1)}/s`);
console.log(`  update interval ms: p50=${upd.p50.toFixed(0)} p90=${upd.p90.toFixed(0)} max=${upd.max.toFixed(0)}   stalls(>150ms)=${stalls}`);
console.log(`  step size track-ms: p50=${stp.p50.toFixed(0)} p90=${stp.p90.toFixed(0)} max=${stp.max.toFixed(0)}   backward steps=${backs} (total ${backMs.toFixed(0)}ms)`);

// control: A's own local motion (should be rAF-smooth)
const chA = []; let lTA = sa[0][0], lPA = sa[0][1];
for (let i = 1; i < sa.length; i++) { const [t, p] = sa[i]; if (p !== lPA) { chA.push(t - lTA); lTA = t; lPA = p; } }
const updA = stats(chA);
console.log(`  control — A local updates: ${(chA.length / SAMPLE_SEC).toFixed(1)}/s, interval p50=${updA.p50.toFixed(0)} p90=${updA.p90.toFixed(0)} max=${updA.max.toFixed(0)}`);

// app's own diagnostics
for (const tag of ["[GRID-ALIGN-DIAG]", "[MIRROR-DIAG]", "[MIRROR-RAF]", "[MIRROR-STALE]"]) {
  const all = sB.all(tag);
  if (all.length) { console.log(`\n${tag} on B (${all.length} lines, last 3):`); all.slice(-3).forEach((l) => console.log("  " + l)); }
  else console.log(`\n${tag} on B: none`);
}

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
let n = 1; while (existsSync(resolve(OUT_DIR, `mirror-${LABEL}-${n}.log`))) n++;
const outPath = resolve(OUT_DIR, `mirror-${LABEL}-${n}.log`);
writeFileSync(outPath, ["=== A ===", ...sA.lines, "", "=== B ===", ...sB.lines, "", "=== B samples (t,prog) ===", ...sb.map((r) => r.join(","))].join("\n"));
console.log(`\nraw → ${outPath}`);
if (process.env.NETEM_WS) await resetNetem().catch(() => {});
await browser.close();
