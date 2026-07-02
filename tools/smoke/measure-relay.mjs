// measure-relay.mjs — JOB 1: two-tab test with ?ice=relay on BOTH tabs, no other
// flags. Forces media out over the real uplink through the TURN server and back —
// real internet transit on one machine. Confirms [ICE-PATH] shows RELAYED, plays
// the fixture for DURATION_MIN minutes (re-seeking before the 12s fixture ends so
// audio never stops), and reports what jbTargetMs ([JITTER-DIAG]) and [SYNC-COMP]
// measured do with real transit in the path. Question: does the buffer stay near
// ~220 or drift up?
//
//   node tools/smoke/measure-relay.mjs                # 4 min run, localhost:5173
//   DURATION_MIN=3 node tools/smoke/measure-relay.mjs
//   FLAGS="ice=relay&audiolite=96" node tools/smoke/measure-relay.mjs   # lever runs
//
// Jitter-harness mode (tools/netem/turn-jitter-proxy.mjs): set NETEM_URL to the
// proxy's control endpoint and NETEM_PROFILE to the shaping JSON. Shaping turns
// ON only after [ICE-PATH] confirms relay (so setup is always crisp) and is
// turned OFF at the end of the run.
//   NETEM_URL=http://127.0.0.1:3480 \
//   NETEM_PROFILE='{"highMs":75,"lowMs":20,"periodMs":600,"plr":0.005,"seed":1}' \
//   FLAGS="ice=relay" LABEL=jitter-baseline node tools/smoke/measure-relay.mjs
//
// Writes the raw console capture to tools/smoke/out/relay-<label>-<n>.log.
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, capture, createRoom, joinByCode, loadTestTrack } from "./lib/e2e.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET = process.env.TARGET || "http://localhost:5173/";
const FLAGS = process.env.FLAGS || "ice=relay";
const LABEL = process.env.LABEL || FLAGS.replace(/[^a-z0-9=]+/gi, "_");
const DURATION_MIN = parseFloat(process.env.DURATION_MIN || "4");
const Q = (TARGET.includes("?") ? "&" : "?") + FLAGS;
const OUT_DIR = resolve(__dirname, "out");

const die = (msg) => { console.error("✗ " + msg); process.exit(1); };

const browser = await launch();
if (!browser) die("no system Chrome");

const ctxA = await browser.newContext(); const A = await ctxA.newPage(); const sA = capture(A);
const ctxB = await browser.newContext(); const B = await ctxB.newPage(); const sB = capture(B);

await A.goto(TARGET + Q, { waitUntil: "domcontentloaded" });
const code = await createRoom(A);
await A.waitForTimeout(1500);
await B.goto(TARGET + Q, { waitUntil: "domcontentloaded" });
await joinByCode(B, code);
await B.waitForFunction(() => /⟺/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});

// A is the audio source; B is the receiver whose jitter buffer we watch.
// TRACK env = app-relative URL for a real track (e.g. a /@fs/… vite dev path) —
// sustained music drives the real Opus wire bitrate; the default kick fixture is
// mostly silence, so VBR sends far below the negotiated cap (matters for
// load-dependent/bwKbps profiles). Real tracks outlast the run → no re-seek.
const TRACK = process.env.TRACK || null;
await loadTestTrack(A, "A", ...(TRACK ? [TRACK] : []));
// Toggling before the deck's decode finishes is a SILENT NO-OP (hasBuf=false →
// defensive UI flip only) and the whole run streams a silent master mix. Wait
// for the analyzer broadcast (the tail of the real load path), then toggle,
// then hard-verify the deck actually entered play and is advancing.
await sA.waitFor("[ANALYZER-BROADCAST]", 90000);
await A.evaluate(() => window.__toggleDeck("A"));
const toggled = await sA.waitFor("hasBuf=true", 5000);
if (!toggled) die("deck A toggled without a decoded buffer (hasBuf=false) — playback never started");
await A.waitForTimeout(2500);
const prog = await A.evaluate(() => window.__deckProg ? window.__deckProg("A") : null);
if (prog != null && !(prog > 0.001)) die(`deck A is not advancing after play (prog=${prog}) — run would measure a silent stream`);
console.log(`✓ deck A playing (prog=${prog == null ? "n/a" : prog.toFixed(4)})`);

// Wait for the connection + the one-shot [ICE-PATH] proof line (fires ~2.5s+
// after audio flows). If it never comes or says DIRECT, the run is invalid.
const gotPath = await sB.waitFor("[ICE-PATH]", 45000) || await sA.waitFor("[ICE-PATH]", 5000);
if (!gotPath) die("no [ICE-PATH] line within 45s — RTC likely never connected (check TURN env / network)");
const pathA = sA.last("[ICE-PATH]"), pathB = sB.last("[ICE-PATH]");
console.log("ICE path A: " + (pathA || "(none)"));
console.log("ICE path B: " + (pathB || "(none)"));
if (FLAGS.includes("ice=relay")) {
  const relayed = [pathA, pathB].some((l) => l && l.includes("RELAYED via TURN"));
  if (!relayed) die("[ICE-PATH] does not show RELAYED via TURN — relay not in the path, run invalid");
  console.log("✓ relay confirmed — media is transiting the TURN server");
}

// ── Jitter harness: enable shaping only now that the relay path is proven.
const NETEM_URL = process.env.NETEM_URL || null;
const setShape = async (body) => {
  if (!NETEM_URL) return null;
  const r = await fetch(NETEM_URL + "/shape", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
};
if (NETEM_URL && process.env.NETEM_PROFILE) {
  const prof = JSON.parse(process.env.NETEM_PROFILE);
  await setShape(prof);
  console.log("✓ netem shaping ON: " + JSON.stringify(prof));
  await B.waitForTimeout(3000); // let the first shaped packets land before the window starts
}

// ── Measurement window. Keep the 12s fixture playing by re-seeking to the top
// every 9s (before it can end); the receiver's inbound RTP flows continuously.
const t0 = Date.now();
const endAt = t0 + DURATION_MIN * 60_000;
console.log(`measuring for ${DURATION_MIN} min…`);
let nextSeek = t0 + 9000, nextTick = t0 + 30_000;
while (Date.now() < endAt) {
  await B.waitForTimeout(500);
  const now = Date.now();
  if (!TRACK && now >= nextSeek) { await A.evaluate(() => window.__seekDeck("A", 0.02)).catch(() => {}); nextSeek = now + 9000; }
  if (now >= nextTick) { console.log(`  …${Math.round((now - t0) / 1000)}s`); nextTick = now + 30_000; }
}

// ── Parse the receiver-side series. Console lines carry no timestamps, so we
// index by line order — [JITTER-DIAG] fires every ~2s, [SYNC-COMP] every poll.
const num = (line, key) => { const m = (line || "").match(new RegExp(key + "=([\\-\\d.]+)")); return m ? parseFloat(m[1]) : null; };
const series = (sink, tag, key) => sink.all(tag).map((l) => num(l, key)).filter((v) => v != null && Number.isFinite(v));
const stats = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { n: xs.length, min: s[0], p50: s[s.length >> 1], p90: s[Math.floor(s.length * 0.9)], max: s[s.length - 1], mean };
};
const fmt = (st) => st ? `n=${st.n}  min=${st.min.toFixed(0)}  p50=${st.p50.toFixed(0)}  p90=${st.p90.toFixed(0)}  max=${st.max.toFixed(0)}  mean=${st.mean.toFixed(0)}` : "(no data)";
// thirds() splits a series into first/middle/last thirds — drift shows as a
// rising mean across thirds even without per-line timestamps.
const thirds = (xs) => {
  if (xs.length < 6) return null;
  const k = Math.floor(xs.length / 3);
  const m = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  return [m(xs.slice(0, k)), m(xs.slice(k, 2 * k)), m(xs.slice(2 * k))];
};
const fmtThirds = (t) => t ? t.map((v) => v.toFixed(0)).join(" → ") : "(too few samples)";

for (const [name, sink] of [["B (receiver of A's track)", sB], ["A (sender)", sA]]) {
  const jbT = series(sink, "[JITTER-DIAG]", "jbTargetMs");
  const meas = series(sink, "[SYNC-COMP] measured", "measured");
  const applied = series(sink, "[SYNC-COMP] measured", "applied");
  const conc = series(sink, "[JITTER-DIAG]", "concealMs");
  const lost = series(sink, "[JITTER-DIAG]", "lostΔ");
  const disc = series(sink, "[JITTER-DIAG]", "discΔ");
  const jit = series(sink, "[JITTER-DIAG]", "jitterMs");
  console.log(`\n=== ${name} ===`);
  console.log(`  jbTargetMs        ${fmt(stats(jbT))}   thirds: ${fmtThirds(thirds(jbT))}`);
  console.log(`  SYNC-COMP measured ${fmt(stats(meas))}   thirds: ${fmtThirds(thirds(meas))}`);
  console.log(`  SYNC-COMP applied  ${fmt(stats(applied))}`);
  console.log(`  concealMs/2s      ${fmt(stats(conc))}`);
  console.log(`  lostΔ/2s          ${fmt(stats(lost))}   discΔ/2s ${fmt(stats(disc))}`);
  console.log(`  rtp jitterMs      ${fmt(stats(jit))}`);
  const sd = sink.all("[SEND-DIAG]");
  if (sd.length) console.log(`  last [SEND-DIAG]  ${sd[sd.length - 1]}`);
}

// Shaping off + proxy-side accounting (proves the jitter actually transited).
if (NETEM_URL) {
  const st = await fetch(NETEM_URL + "/shape").then((r) => r.json()).catch(() => null);
  if (st?.stats) {
    const secs = st.stats.t0 ? (Date.now() - st.stats.t0) / 1000 : 0;
    const kbps = secs > 0 && st.stats.mediaBytes ? (st.stats.mediaBytes * 8 / 1000 / secs).toFixed(0) : "?";
    console.log(`\nproxy accounting: media=${st.stats.media} (${kbps}kbps all legs) dropped=${st.stats.dropped} (queue=${st.stats.qDropped ?? 0}) avgAddedDelay=${st.stats.shapedPkts ? (st.stats.delayedMs / st.stats.shapedPkts).toFixed(0) : 0}ms qMax=${(st.stats.qMsMax ?? 0).toFixed(0)}ms`);
    if (st.legs) for (const [k, l] of Object.entries(st.legs)) console.log(`  leg ${k}: up ${l.upKbps}kbps/${l.upPkts}pkts  down ${l.downKbps}kbps/${l.downPkts}pkts`);
  }
  await setShape({ off: true }).catch(() => {});
  console.log("✓ netem shaping OFF");
}

// Raw dump for later inspection.
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
let n = 1; while (existsSync(resolve(OUT_DIR, `relay-${LABEL}-${n}.log`))) n++;
const outPath = resolve(OUT_DIR, `relay-${LABEL}-${n}.log`);
writeFileSync(outPath, ["=== A ===", ...sA.lines, "", "=== B ===", ...sB.lines].join("\n"));
console.log(`\nraw console capture → ${outPath}`);

await browser.close();
