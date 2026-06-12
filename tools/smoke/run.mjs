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
  { name: "e2e-entry",        file: "e2e-entry.smoke.mjs",        kind: "e2e",   gates: "two clients join one room (code + paste); distinct djIds; partners crossed" },
  { name: "e2e-track-mirror", file: "e2e-track-mirror.smoke.mjs", kind: "e2e",   gates: "driver load → partner mirrors title/BPM/waveform/beatTimes" },
  { name: "e2e-transport",    file: "e2e-transport.smoke.mjs",    kind: "e2e",   gates: "play/pause both ways; seek SEND→RECV→EXEC round-trip" },
  { name: "e2e-sync",         file: "e2e-sync.smoke.mjs",         kind: "e2e",   gates: "engage end-to-end: nearest-beat <10ms; repeat identical" },
  { name: "e2e-comp",         file: "e2e-comp.smoke.mjs",         kind: "e2e",   gates: "delaycomp measures nonzero on live audio; survives partner reload" },
  { name: "e2e-drift",        file: "e2e-drift.smoke.mjs",        kind: "e2e",   gates: "[SYNC-DRIFT] emits during locked remote B2B" },
  { name: "e2e-trackend",     file: "e2e-trackend.smoke.mjs",     kind: "e2e",   gates: "deck parked at end stays operable (play replays, no inert flip-flop)" },
  { name: "e2e-reconnect",    file: "e2e-reconnect.smoke.mjs",    kind: "e2e",   gates: "mid-session WS drop auto-reconnects + re-joins + restores partner" },
  { name: "e2e-rejoin",       file: "e2e-rejoin.smoke.mjs",       kind: "e2e",   gates: "client reload mid-blend rebuilds full partner view (grid+BPM) within 5s" },
  { name: "e2e-chaos",        file: "e2e-chaos.smoke.mjs",        kind: "e2e",   gates: "app survives transport/seek/load storms (no crash, stays responsive)" },
];

// ── args
const argv = process.argv.slice(2);
const kindArg = (argv.find((a) => a.startsWith("--kind=")) || "").split("=")[1];
const KINDS = kindArg ? new Set(kindArg.split(",").map((s) => s.trim())) : null;
const LIST = argv.includes("--list");
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
      const status = code === 0 ? "PASS" : code === 2 ? "SKIP" : "FAIL";
      res({ ...t, status, code, ms });
    });
    child.on("error", (e) => res({ ...t, status: "FAIL", code: -1, ms: Date.now() - t0, err: e.message }));
  });
}

// ── e2e setup: fixture + dev server (spawn vite if not already up, unless a
// remote TARGET was provided).
let devProc = null;
async function setupE2E() {
  ensureFixture();
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
function teardownE2E() { if (devProc) { try { devProc.kill("SIGTERM"); } catch {} devProc = null; } }

// ── run
console.log(`\n╔═ MIX//SYNC SMOKE SUITE ═╗  target=${TARGET}  tests=${wanted.length}${KINDS ? `  kinds=${[...KINDS].join(",")}` : ""}`);
if (needE2E) await setupE2E();

const results = [];
for (const t of wanted) results.push(await runOne(t));
teardownE2E();

// ── summary
const pass = results.filter((r) => r.status === "PASS").length;
const fail = results.filter((r) => r.status === "FAIL");
const skip = results.filter((r) => r.status === "SKIP");
const totMs = results.reduce((a, r) => a + r.ms, 0);
console.log("\n╔════════════════════════ SUMMARY ════════════════════════╗");
for (const r of results) {
  const icon = r.status === "PASS" ? "✅" : r.status === "SKIP" ? "⊘ " : "❌";
  console.log(`  ${icon} ${r.status.padEnd(4)} [${r.kind.padEnd(5)}] ${r.name.padEnd(17)} ${(r.ms / 1000).toFixed(1)}s`);
}
console.log("╚══════════════════════════════════════════════════════════╝");
console.log(`  ${pass} passed, ${fail.length} failed, ${skip.length} skipped · ${(totMs / 1000).toFixed(1)}s total`);
if (skip.length) console.log(`  skipped: ${skip.map((s) => s.name).join(", ")} (deps unavailable — not failures)`);
if (fail.length) { console.log(`  FAILED: ${fail.map((f) => f.name).join(", ")}`); process.exit(1); }
process.exit(0);
