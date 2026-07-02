#!/usr/bin/env node
// run.mjs — the single smoke-suite runner. One command, per-test PASS/FAIL/SKIP,
// exit code for CI.
//
//   npm run smoke                 # everything available
//   npm run smoke:unit            # unit + audio only (no browser)
//   npm run smoke:e2e             # two-client browser tests only
//   node tools/smoke/run.mjs --kind=unit,e2e --list
//   TARGET=https://collabmix.vercel.app node tools/smoke/run.mjs --kind=e2e
//
// Exit 0 = all ran tests passed (skips don't fail). Non-zero = ≥1 FAIL.
//
// Test contract: each tests/<x>.smoke.mjs is a standalone process exiting
// 0=PASS, 1=FAIL, 2=SKIP (deps unavailable). e2e tests read TARGET (the app URL)
// and skip themselves if the browser/server can't be reached.

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import http from "node:http";
import { ensureFixture } from "./lib/gen-fixture.mjs";
import { startMockServer } from "./lib/mock-ws-server.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = resolve(__dirname, "tests");

// ── Registry. kind: unit (pure logic) | audio (analyzer on fixture) | e2e
// (two-client browser). gates = one line on what regression it catches.
const TESTS = [
  { name: "engage-align",     file: "engage.smoke.mjs",           kind: "unit",  gates: "SYNC engage <10ms + repeat-engage idempotent (no wander)" },
  { name: "interp-sawtooth",  file: "interp.smoke.mjs",           kind: "unit",  gates: "non-driver playhead has no backward sawtooth at off-1.0 rates" },
  { name: "comp-rebaseline",  file: "comp-rebaseline.smoke.mjs",  kind: "unit",  gates: "delay-comp re-converges after a transport interruption" },
  { name: "onset-anchor",     file: "onset-anchor.smoke.mjs",     kind: "audio", gates: "beatTimes anchored on the kick onset (<4ms)" },
  { name: "desmear-render",   file: "desmear.smoke.mjs",          kind: "audio", gates: "drawn kick leading edge sits on the onset" },
  { name: "rekordbox-grid",   file: "rekordbox-grid.smoke.mjs",   kind: "unit",  gates: "rekordbox.xml TEMPO→beatTimes (single + multi-tempo, piecewise)" },
  { name: "conn-quality",     file: "conn-quality.smoke.mjs",     kind: "unit",  gates: "?connwarn classifier: measured clean=good / deep-buffer=poor bands, July-2 blip immunity, 3-window escalate / 5-window clear sustain" },
  { name: "bpm-retry",        file: "bpm-retry.smoke.mjs",        kind: "audio", gates: "?bpmretry safety contract: flag-off payload identical (no key leak), clean track never retried, only validated hypotheses can change a result" },
  { name: "e2e-entry",        file: "e2e-entry.smoke.mjs",        kind: "e2e",   gates: "two clients join one room (code + paste); distinct djIds; partners crossed" },
  { name: "e2e-track-mirror", file: "e2e-track-mirror.smoke.mjs", kind: "e2e",   gates: "driver load → partner mirrors title/BPM/waveform/beatTimes" },
  { name: "e2e-transport",    file: "e2e-transport.smoke.mjs",    kind: "e2e",   gates: "play/pause both ways; seek SEND→RECV→EXEC round-trip" },
  { name: "e2e-sync",         file: "e2e-sync.smoke.mjs",         kind: "e2e",   gates: "engage end-to-end: nearest-beat <10ms; repeat identical" },
  { name: "e2e-sync-mode",    file: "e2e-sync-mode.smoke.mjs",    kind: "e2e",   gates: "SYNC-as-mode: arm-before-load / arm-before-play (#2) / arm-mid-play all lock + align" },
  { name: "e2e-lock-stability", file: "e2e-lock-stability.smoke.mjs", kind: "e2e", gates: "locked B2B deck never self-pauses: master skips cross-client re-seek; both decks keep advancing" },
  { name: "e2e-comp",         file: "e2e-comp.smoke.mjs",         kind: "e2e",   gates: "delaycomp measures nonzero on live audio; survives partner reload" },
  { name: "e2e-opus",         file: "e2e-opus.smoke.mjs",         kind: "e2e",   gates: "partner Opus negotiates music-grade STEREO + 256kbps (not voice-grade default) — proven via getStats fmtp" },
  { name: "e2e-jbtarget",     file: "e2e-jbtarget.smoke.mjs",     kind: "e2e",   gates: "partner receiver jitter-buffer pinned to JB_TARGET_MS (~160) — proven via getStats jbTarget, not browser-default shallow" },
  { name: "e2e-drift",        file: "e2e-drift.smoke.mjs",        kind: "e2e",   gates: "[SYNC-DRIFT] emits during locked remote B2B" },
  { name: "e2e-trackend",     file: "e2e-trackend.smoke.mjs",     kind: "e2e",   gates: "deck parked at end stays operable (play replays, no inert flip-flop)" },
  { name: "e2e-reconnect",    file: "e2e-reconnect.smoke.mjs",    kind: "e2e",   gates: "mid-session WS drop auto-reconnects + re-joins + restores partner" },
  { name: "e2e-rejoin",       file: "e2e-rejoin.smoke.mjs",       kind: "e2e",   gates: "client reload mid-blend rebuilds full partner view (grid+BPM) within 5s" },
  { name: "e2e-chaos",        file: "e2e-chaos.smoke.mjs",        kind: "e2e",   gates: "app survives transport/seek/load storms (no crash, stays responsive)" },
  { name: "e2e-mirror",       file: "e2e-mirror.smoke.mjs",       kind: "e2e",   gates: "partner-deck waveform mirror advances forward (no backward skip / freeze)" },
  { name: "e2e-mirror-coast", file: "e2e-mirror-coast.smoke.mjs", kind: "e2e",   gates: "mirror coasts accurately under SPARSE packets (backgrounded driver)" },
  { name: "e2e-mirror-seek",  file: "e2e-mirror-seek.smoke.mjs",  kind: "e2e",   gates: "real seek hard-snaps the mirror via seekEpoch (no magnitude-guess false snap); paused mirror stays static unless a genuine re-cue" },
  { name: "e2e-seek-smooth",  file: "e2e-seek-smooth.smoke.mjs",  kind: "e2e",   gates: "smooth-seek crossfade: rapid seeks keep deck playing (no false track-end), land exactly, no source-node leak (fade tails released)" },
  { name: "e2e-mirror-latency", file: "e2e-mirror-latency.smoke.mjs", kind: "e2e", gates: "mirror under DETERMINISTIC netem (latency/jitter/loss): no backward step, tracks within floor (needs --mock)" },
  { name: "e2e-mirror-slew",  file: "e2e-mirror-slew.smoke.mjs",   kind: "e2e",  gates: "the dogfood BACKWARD SLEW stays dead: rate-adjusted driver + sparse packets must NOT slew the mirror backward (Jake's -0.5/-1.53s). HARD GATE since Move #2's monotonic forward-only follower (needs --mock)" },
  { name: "e2e-mirror-clump", file: "e2e-mirror-clump.smoke.mjs",  kind: "e2e",  gates: "July 2 mirror bug stays dead: deck_update TCP-clump netem must NOT become mirror lag / audio-leads-playhead (MIRROR_TSEND send-time anchor; needs --mock)" },
  { name: "e2e-rekordbox",    file: "e2e-rekordbox.smoke.mjs",    kind: "e2e",   gates: "Door 3: rekordbox.xml parse (grids+cues+playlists) + imported grid consumed by deck (unified path, de-smear off, engage idempotent)" },
];

// ── args
const argv = process.argv.slice(2);
const kindArg = (argv.find((a) => a.startsWith("--kind=")) || "").split("=")[1];
const KINDS = kindArg ? new Set(kindArg.split(",").map((s) => s.trim())) : null;
const LIST = argv.includes("--list");
// --mock (or MOCK=1): spawn the LOCAL mock WS server and expose its URL to e2e
// children via MOCK_WS_URL. Tests that opt in (via lib/e2e.mjs appUrl) connect the
// app to it with ?wsurl=… so network conditions are deterministic + load-free.
// Existing tests ignore MOCK_WS_URL → they keep hitting the production relay until
// the deliberate full-suite migration (incremental rollout per the build plan).
const USE_MOCK = argv.includes("--mock") || process.env.MOCK === "1";
const MOCK_PORT = Number(process.env.MOCK_PORT) || 8090;
const wanted = TESTS.filter((t) => !KINDS || KINDS.has(t.kind));

if (LIST) {
  console.log("smoke tests:");
  for (const t of wanted) console.log(`  [${t.kind}] ${t.name.padEnd(16)} — ${t.gates}`);
  process.exit(0);
}

const DEV_PORT = 5173;
const DEV_URL = `http://localhost:${DEV_PORT}/`;
const TARGET = process.env.TARGET || DEV_URL;
const needE2E = wanted.some((t) => t.kind === "e2e");

function ping(url) {
  return new Promise((res) => {
    const req = http.get(url, (r) => { r.resume(); res(r.statusCode > 0); });
    req.on("error", () => res(false)); req.setTimeout(1500, () => { req.destroy(); res(false); });
  });
}
async function waitPort(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await ping(url)) return true; await new Promise((r) => setTimeout(r, 500)); }
  return false;
}

function runOne(t) {
  return new Promise((res) => {
    const t0 = Date.now();
    const env = { ...process.env, TARGET };
    if (!existsSync(resolve(TESTS_DIR, t.file))) {
      console.log(`\n⊘ [${t.kind}] ${t.name} — not yet implemented (SKIP)`);
      return res({ ...t, status: "SKIP", code: 2, ms: 0 });
    }
    console.log(`\n▶ [${t.kind}] ${t.name}`);
    const child = spawn(process.execPath, [resolve(TESTS_DIR, t.file)], { stdio: "inherit", env });
    child.on("close", (code) => {
      const ms = Date.now() - t0;
      let status = code === 0 ? "PASS" : code === 2 ? "SKIP" : "FAIL";
      // xfail: a registered KNOWN bug whose repro test asserts the POST-FIX
      // property. It is EXPECTED to fail until the fix lands, so its failure is
      // non-fatal (XFAIL). When the fix makes it pass, that's XPASS — a loud
      // signal to remove the xfail flag and promote it to a hard gate.
      if (t.xfail && status === "FAIL") status = "XFAIL";
      else if (t.xfail && status === "PASS") status = "XPASS";
      res({ ...t, status, code, ms });
    });
    child.on("error", (e) => res({ ...t, status: "FAIL", code: -1, ms: Date.now() - t0, err: e.message }));
  });
}

// ── e2e setup: fixture + dev server (spawn vite if not already up, unless a
// remote TARGET was provided).
let devProc = null;
let mockHandle = null;
async function setupE2E() {
  ensureFixture();
  if (USE_MOCK) {
    mockHandle = await startMockServer({ port: MOCK_PORT, log: false });
    process.env.MOCK_WS_URL = mockHandle.url; // inherited by child tests via runOne
    console.log(`✓ mock WS server up at ${mockHandle.url} (deterministic netem available)`);
  }
  if (process.env.TARGET) { // remote target — don't manage a server
    if (!(await ping(TARGET))) console.warn(`⚠ TARGET ${TARGET} not reachable — e2e tests will SKIP themselves.`);
    return;
  }
  if (await ping(DEV_URL)) { console.log(`✓ dev server already up at ${DEV_URL}`); return; }
  console.log(`↻ starting dev server (vite) for e2e…`);
  devProc = spawn("npm", ["run", "dev"], { cwd: resolve(__dirname, "../.."), stdio: "ignore", detached: false });
  const up = await waitPort(DEV_URL, 25000);
  if (!up) { console.warn("⚠ dev server did not come up in 25s — e2e tests will SKIP."); }
  else console.log(`✓ dev server ready at ${DEV_URL}`);
}
async function teardownE2E() {
  if (devProc) { try { devProc.kill("SIGTERM"); } catch {} devProc = null; }
  if (mockHandle) { try { await mockHandle.close(); } catch {} mockHandle = null; }
}

// ── run
console.log(`\n╔═ MIX//SYNC SMOKE SUITE ═╗  target=${TARGET}  tests=${wanted.length}${KINDS ? `  kinds=${[...KINDS].join(",")}` : ""}`);
if (needE2E) await setupE2E();

const results = [];
for (const t of wanted) results.push(await runOne(t));
await teardownE2E();

// ── summary
const pass = results.filter((r) => r.status === "PASS").length;
const fail = results.filter((r) => r.status === "FAIL");
const skip = results.filter((r) => r.status === "SKIP");
const xfail = results.filter((r) => r.status === "XFAIL");
const xpass = results.filter((r) => r.status === "XPASS");
const totMs = results.reduce((a, r) => a + r.ms, 0);
console.log("\n╔════════════════════════ SUMMARY ════════════════════════╗");
for (const r of results) {
  const icon = r.status === "PASS" ? "✅" : r.status === "SKIP" ? "⊘ " : r.status === "XFAIL" ? "🟡" : r.status === "XPASS" ? "🎯" : "❌";
  console.log(`  ${icon} ${r.status.padEnd(5)} [${r.kind.padEnd(5)}] ${r.name.padEnd(19)} ${(r.ms / 1000).toFixed(1)}s`);
}
console.log("╚══════════════════════════════════════════════════════════╝");
console.log(`  ${pass} passed, ${fail.length} failed, ${skip.length} skipped${xfail.length ? `, ${xfail.length} xfail` : ""}${xpass.length ? `, ${xpass.length} XPASS` : ""} · ${(totMs / 1000).toFixed(1)}s total`);
if (skip.length) console.log(`  skipped: ${skip.map((s) => s.name).join(", ")} (deps unavailable — not failures)`);
if (xfail.length) console.log(`  xfail: ${xfail.map((x) => x.name).join(", ")} (known bug, expected to fail — Move #2 target, NOT a regression)`);
if (xpass.length) console.log(`  🎯 XPASS: ${xpass.map((x) => x.name).join(", ")} — a known bug now PASSES; remove its xfail flag and promote it to a hard gate`);
if (fail.length) { console.log(`  FAILED: ${fail.map((f) => f.name).join(", ")}`); process.exit(1); }
process.exit(0);
