// rocket_jam_probe.js — single-track diagnostic for the off-grid issue
// reported on "Rocket Jam (Original Mix)" by Will DeKeizer (122 BPM, 8:35).
//
// Runs the production analyzer pipeline unmodified and dumps:
//   1. Detected BPM (3 decimal places)
//   2. Detected first downbeat position (ms)
//   3. All detected beat positions for the first 60 seconds
//   4. Loudest energy increase in the second half of the track (drop proxy)
//   5. Where bars land at that drop position (which beat, distance in ms)
//   6. Kick attack positions for the first 16 beats
//
// Pure investigation — no production code touched.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_SRC } from "../../src/bpm-worker-source.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS_NM = resolve(__dirname, "..", "bpm-test-harness", "node_modules");
const decodeAudioMod = await import(resolve(HARNESS_NM, "audio-decode", "audio-decode.js"));
const decodeAudio = decodeAudioMod.default;

// Usage: node rocket_jam_probe.js [path] [report-name] [user-bpm]
const TRACK_PATH = process.argv[2] || "/Users/chad/Music/Music/Media.localized/Music/Will DeKeizer/Sound of Neptune/02 Rocket Jam (Original Mix).mp3";
const REPORT_NAME = process.argv[3] || "ROCKET_JAM_PROBE.md";
const DATA_NAME = REPORT_NAME.replace(/\.md$/i, "").toLowerCase() + "_data.json";
const USER_BPM = parseFloat(process.argv[4] || "122");

console.error("Decoding", TRACK_PATH);
const buf = await decodeAudio(readFileSync(TRACK_PATH));
const sr = buf.sampleRate;
const mono = buf.channelData[0];
const durSec = mono.length / sr;
console.error(`Decoded: sr=${sr}  durSec=${durSec.toFixed(2)}  channels=${buf.channelData.length}`);

// ── Capture per-beat refinement logs by parsing console.log lines.
//    The worker emits [REFINE-DEBUG] only for beats 50/100/200. To get the
//    first 16 beats we need to grab dpBeats from a debug shim. Cleanest: run
//    the worker, intercept its postMessage to get the standard outputs, then
//    re-run our own beat-detection pass on the same audio to get per-beat
//    positions matching the analyzer's grid.
//
//    Approach: run the worker once, get bpm + period + firstBar1Anchor, then
//    reconstruct the beat grid analytically as bar1 + k × period. The
//    production walk-back + sampler-snap + drop-detection means firstBar1Anchor
//    is the production-final bar-1. Beat 0 of the GRID is at firstBar1Anchor
//    (since walk-back brought it to the closest beat-period to 0).
const logs = [];
const origLog = console.log;
console.log = (...args) => { logs.push(args.join(' ')); };
let captured = null;
const self = { onmessage: null, postMessage: (r) => { captured = r; } };
new Function("self", WORKER_SRC)(self);
self.onmessage({ data: { cd: buf.channelData, sr, id: "rocket-jam" } });
console.log = origLog;

const bpm = captured.bpm;
const periodSec = captured.beatPeriodSec;
const periodMs = periodSec * 1000;
const bar1Sec = captured.firstBar1AnchorSec;
const bar1Ms = bar1Sec * 1000;
console.error(`bpm=${bpm}  period=${periodMs.toFixed(3)}ms  bar1=${bar1Ms.toFixed(2)}ms`);

// ── Reconstruct beat positions for first 60s using grid arithmetic ──
// Production exports bar1 = first detected kick after walk-back. The grid
// then has beat_k = bar1 + k × period for k = 0, 1, 2, ...
const beatsFirst60 = [];
for (let k = 0; ; k++) {
  const tSec = bar1Sec + k * periodSec;
  if (tSec > 60) break;
  beatsFirst60.push(tSec);
}
console.error(`Reconstructed ${beatsFirst60.length} beats in first 60s`);

// ── (4) Loudest energy increase in second half of the track (drop proxy) ──
// Method: bandpass 40-100Hz on entire track, 100ms frame energy, smooth 2s,
// find the largest jump in smoothed energy in the second half.
function bp(sig, srLocal, low, high) {
  const out = new Float32Array(sig.length);
  const rL = 1 / (2 * Math.PI * high / srLocal + 1);
  const rH = 1 / (2 * Math.PI * low / srLocal + 1);
  const hp = new Float32Array(sig.length);
  let pi = 0, po = 0;
  for (let i = 0; i < sig.length; i++) {
    hp[i] = rH * (po + sig[i] - pi); pi = sig[i]; po = hp[i];
  }
  let pv = 0;
  for (let i = 0; i < hp.length; i++) { pv = pv + (1 - rL) * (hp[i] - pv); out[i] = pv; }
  return out;
}

const band = bp(mono, sr, 40, 100);
const HOP_SEC = 0.1;
const hopS = Math.max(1, Math.round(sr * HOP_SEC));
const nf = Math.floor(mono.length / hopS);
const fE = new Float32Array(nf);
for (let i = 0; i < nf; i++) {
  const st = i * hopS;
  let s = 0;
  const end = Math.min(band.length, st + hopS);
  for (let j = st; j < end; j++) { const v = band[j]; s += v * v; }
  fE[i] = Math.sqrt(s / hopS);
}
const sw = Math.round(2.0 / HOP_SEC);
const fS = new Float32Array(nf);
let acc = 0;
const q = [];
for (let i = 0; i < nf; i++) {
  acc += fE[i];
  q.push(fE[i]);
  if (q.length > sw) acc -= q.shift();
  fS[i] = acc / q.length;
}
// Find largest jump in the second half — measure as (smoothed[i+5s] - smoothed[i])
const halfFrame = Math.floor(nf / 2);
const jumpWin = Math.round(5.0 / HOP_SEC);
let bestJumpFrame = halfFrame;
let bestJump = -Infinity;
for (let i = halfFrame; i + jumpWin < nf; i++) {
  const jump = fS[i + jumpWin] - fS[i];
  if (jump > bestJump) { bestJump = jump; bestJumpFrame = i; }
}
// Refine: also look for the exact transition by scanning a 5s window forward
// for the steepest 100ms-to-100ms rise
let dropFrame = bestJumpFrame;
let bestRise = 0;
for (let i = bestJumpFrame; i < bestJumpFrame + jumpWin && i < nf - 1; i++) {
  const rise = fS[i + 1] - fS[i];
  if (rise > bestRise) { bestRise = rise; dropFrame = i + 1; }
}
const dropSec = dropFrame * HOP_SEC;
console.error(`Loudest jump region starts at ~${(bestJumpFrame * HOP_SEC).toFixed(1)}s, sharpest transition at ${dropSec.toFixed(2)}s`);

// ── (5) Where does the analyzer's bar grid land at the drop? ──
const beatsFromBar1 = (dropSec - bar1Sec) / periodSec;
const nearestBeatIdx = Math.round(beatsFromBar1);
const beatSec = bar1Sec + nearestBeatIdx * periodSec;
const distMsFromDrop = (beatSec - dropSec) * 1000;
const barOfBeat = Math.floor(nearestBeatIdx / 4);
const positionInBar = ((nearestBeatIdx % 4) + 4) % 4; // 0..3, where 0 = beat 1
const positionLabels = ['beat 1 (downbeat)', 'beat 2', 'beat 3', 'beat 4'];

// ── (6) Kick attack positions for first 16 beats ──
// For each grid beat in [0..15], run a ±50ms search for the strongest kick
// transient (HW-rectified diff of 1.5ms-smoothed 40-200Hz power), report
// the offset of the detected attack from the grid position.
function kickAttackOffsetMs(grid_t_sec, mono, sr) {
  const halfWinMs = 50;
  const winStart = Math.max(0, Math.round((grid_t_sec - halfWinMs / 1000) * sr));
  const winEnd = Math.min(mono.length, Math.round((grid_t_sec + halfWinMs / 1000) * sr));
  if (winEnd - winStart < 200) return null;
  const padS = Math.round(sr * 0.010);
  const padStart = Math.max(0, winStart - padS);
  const padEnd = Math.min(mono.length, winEnd + padS);
  const padded = mono.subarray(padStart, padEnd);
  const filtered = bp(padded, sr, 40, 200);
  const innerOff = winStart - padStart;
  const winLen = winEnd - winStart;
  const power = new Float32Array(winLen);
  for (let i = 0; i < winLen; i++) {
    const v = filtered[innerOff + i]; power[i] = v * v;
  }
  const smoothWin = Math.max(8, Math.round(sr * 0.0015));
  const smoothed = new Float32Array(winLen);
  let runSum = 0;
  for (let i = 0; i < winLen; i++) {
    runSum += power[i];
    if (i >= smoothWin) runSum -= power[i - smoothWin];
    smoothed[i] = runSum / Math.min(i + 1, smoothWin);
  }
  let bestI = 0, bestD = 0;
  for (let i = 1; i < winLen; i++) {
    const d = smoothed[i] - smoothed[i - 1];
    if (d > bestD) { bestD = d; bestI = i; }
  }
  // attack position relative to grid center
  const attackSampleAbs = winStart + bestI;
  const attackSec = attackSampleAbs / sr;
  const offsetMs = (attackSec - grid_t_sec) * 1000;
  return { attackSec, offsetMs, slope: bestD };
}

const beat16Data = [];
for (let k = 0; k < 16 && k < beatsFirst60.length; k++) {
  const grid_t = beatsFirst60[k];
  const r = kickAttackOffsetMs(grid_t, mono, sr);
  beat16Data.push({ k, gridSec: grid_t, attack: r });
}

// ── Build the markdown report ──
const lines = [];
lines.push("# Rocket Jam Probe — diagnostic report\n");
lines.push("Track: `" + TRACK_PATH + "`");
lines.push("Decoded: " + buf.channelData.length + " channels, sr=" + sr + " Hz, duration=" + durSec.toFixed(2) + "s\n");

lines.push("## (1) Detected BPM");
lines.push("```");
lines.push("  BPM:              " + bpm.toFixed(3));
lines.push("  Beat period:      " + periodMs.toFixed(3) + " ms  (= " + periodSec.toFixed(6) + " sec)");
lines.push("  Reported BPM (user-claimed): 122.000");
lines.push("  Δ BPM:            " + (bpm - 122).toFixed(3));
lines.push("```\n");

lines.push("## (2) First detected downbeat (production bar-1 anchor)");
lines.push("```");
lines.push("  bar1 (firstBar1AnchorSec): " + bar1Ms.toFixed(2) + " ms");
lines.push("  beatPhaseSec:              " + (captured.beatPhaseSec * 1000).toFixed(2) + " ms");
lines.push("  beatPhaseFrac:             " + captured.beatPhaseFrac);
lines.push("```\n");

lines.push("## (3) Beat positions, first 60 seconds");
lines.push("Reconstructed analytically as `bar1 + k × period`. " + beatsFirst60.length + " beats in window.");
lines.push("```");
lines.push("  k       time (s)   time (ms)");
for (let k = 0; k < Math.min(beatsFirst60.length, 32); k++) {
  lines.push("  " + String(k).padStart(3) + "    " + beatsFirst60[k].toFixed(4).padStart(10) + "    " + (beatsFirst60[k] * 1000).toFixed(2).padStart(10));
}
if (beatsFirst60.length > 32) {
  lines.push("  ... (showing first 32 of " + beatsFirst60.length + ")");
  lines.push("  " + String(beatsFirst60.length - 1).padStart(3) + "    " +
    beatsFirst60[beatsFirst60.length - 1].toFixed(4).padStart(10) + "    " +
    (beatsFirst60[beatsFirst60.length - 1] * 1000).toFixed(2).padStart(10));
}
lines.push("```\n");

lines.push("## (4) Loudest energy increase in second-half (drop proxy)");
lines.push("Bandpass 40-100 Hz on full track, 100ms frame energy, 2s box-smoothed.");
lines.push("Largest jump (smoothed energy now vs smoothed energy +5s later) starts at frame " + bestJumpFrame + " = " + (bestJumpFrame * HOP_SEC).toFixed(2) + " s.");
lines.push("Sharpest 100ms-to-100ms transition within that window: " + dropSec.toFixed(3) + " s = " + (dropSec * 1000).toFixed(0) + " ms.");
lines.push("(Track midpoint = " + (durSec / 2).toFixed(2) + " s.)\n");

lines.push("## (5) Where the analyzer grid lands at the drop");
lines.push("```");
lines.push("  Drop position (sec):         " + dropSec.toFixed(3));
lines.push("  Beats from bar-1 to drop:    " + beatsFromBar1.toFixed(3));
lines.push("  Nearest grid beat (index):   " + nearestBeatIdx);
lines.push("  Bar of beat:                 " + barOfBeat + "  (bars are 0-indexed)");
lines.push("  Position in bar:             " + positionInBar + "  (" + positionLabels[positionInBar] + ")");
lines.push("  Nearest beat time (sec):     " + beatSec.toFixed(3));
lines.push("  Distance from drop (ms):     " + (distMsFromDrop >= 0 ? "+" : "") + distMsFromDrop.toFixed(1) + " ms");
lines.push("                               (analyzer beat is " + (distMsFromDrop >= 0 ? "AFTER" : "BEFORE") + " the drop)");
lines.push("```\n");

lines.push("## (6) Kick attack positions, first 16 beats");
lines.push("For each grid beat, ±50ms window, argmax of 1.5ms-smoothed 40-200Hz dE/dt.");
lines.push("Offset > 0 means the detected kick is LATER than the grid position.");
lines.push("```");
lines.push("  k     grid(ms)   attack(ms)   offset(ms)   slope");
for (const b of beat16Data) {
  if (b.attack == null) {
    lines.push("  " + String(b.k).padStart(2) + "  " + (b.gridSec * 1000).toFixed(2).padStart(9) + "   (no detection)");
  } else {
    lines.push("  " + String(b.k).padStart(2) + "  " +
      (b.gridSec * 1000).toFixed(2).padStart(9) + "  " +
      (b.attack.attackSec * 1000).toFixed(2).padStart(11) + "  " +
      (b.attack.offsetMs >= 0 ? "+" : "") + b.attack.offsetMs.toFixed(2).padStart(9) + "  " +
      b.attack.slope.toExponential(2).padStart(10));
  }
}
const offsets = beat16Data.filter(b => b.attack != null).map(b => b.attack.offsetMs);
const meanOff = offsets.reduce((a, b) => a + b, 0) / offsets.length;
const sortedOff = [...offsets].sort((a, b) => a - b);
const medOff = sortedOff[Math.floor(sortedOff.length / 2)];
const stdevOff = Math.sqrt(offsets.reduce((a, b) => a + (b - meanOff) ** 2, 0) / offsets.length);
lines.push("");
lines.push("  Summary across 16 beats: mean offset = " + meanOff.toFixed(2) + " ms, median = " + medOff.toFixed(2) + " ms, stdev = " + stdevOff.toFixed(2) + " ms");
lines.push("```\n");

// ── Interpretation ──
lines.push("## Interpretation\n");
const beatsAtDropFromBar1 = (dropSec - bar1Sec) / periodSec;
const beatsAtDropFractional = beatsAtDropFromBar1 - Math.round(beatsAtDropFromBar1);
const distFromBeatMs = Math.abs(beatsAtDropFractional) * periodMs;
lines.push("- BPM precision: the user reports " + USER_BPM.toFixed(0) + " BPM. Analyzer says " + bpm.toFixed(3) + " BPM. ");
const bpmDriftPerSec = Math.abs(bpm - USER_BPM) / 60.0;
const bpmDriftAtEnd = bpmDriftPerSec * durSec * periodMs;
lines.push("  Over " + durSec.toFixed(1) + "s of audio, a Δ of " + (bpm - USER_BPM).toFixed(3) + " BPM corresponds to ~" +
  bpmDriftAtEnd.toFixed(0) + " ms of cumulative grid drift end-of-track (if user's BPM is exact truth).");
lines.push("");
lines.push("- Bar-phase check at the drop: drop is " + beatsFromBar1.toFixed(2) +
  " beats from bar-1. Nearest beat is index " + nearestBeatIdx +
  " (bar " + barOfBeat + ", " + positionLabels[positionInBar] + ").");
if (positionInBar !== 0) {
  lines.push("  **The drop lands on " + positionLabels[positionInBar] + ", NOT on a bar downbeat.** " +
    "If the drop should be on bar 1, the analyzer's bar-phase is wrong by " +
    positionInBar + " beat" + (positionInBar > 1 ? "s" : "") + ". This is a bar-phase failure mode.");
} else {
  lines.push("  Drop lands on a bar downbeat (beat 1). Bar-phase appears correct at the drop.");
}
lines.push("");
const fractionalOffBeats = Math.abs(beatsFromBar1 - Math.round(beatsFromBar1));
if (fractionalOffBeats > 0.10) {
  lines.push("- The drop sits " + (fractionalOffBeats * 100).toFixed(1) + "% of a beat OFF the grid (" +
    distFromBeatMs.toFixed(1) + " ms from nearest grid beat). " +
    "This is too far to be a pure anchor offset — it suggests the BPM/period is wrong, " +
    "causing the grid to drift relative to the actual beats by the end of the track.");
} else {
  lines.push("- The drop sits " + (fractionalOffBeats * 100).toFixed(1) + "% of a beat off the grid (" +
    distFromBeatMs.toFixed(1) + " ms from nearest grid beat). " +
    "Within tolerance — grid is locked to the beats, the issue (if any) is bar-phase or anchor, not BPM drift.");
}
lines.push("");
lines.push("- First-16-beat offsets: mean " + meanOff.toFixed(2) + " ms, stdev " + stdevOff.toFixed(2) + " ms.");
if (Math.abs(meanOff) > 10 && stdevOff < 5) {
  lines.push("  Consistent offset across the first 16 beats with low spread — the grid is locked " +
    "to the actual beat rate but anchored " + Math.abs(meanOff).toFixed(0) +
    "ms " + (meanOff > 0 ? "EARLIER" : "LATER") + " than the kicks. Pure anchor offset.");
} else if (stdevOff > 10) {
  lines.push("  Offset varies substantially beat-to-beat — suggests either the grid is drifting " +
    "(BPM wrong) or the kick detector itself is unreliable on this material.");
} else {
  lines.push("  Offsets are small and bounded — grid is well-aligned to detected kicks in the first 16 beats.");
}

// ── Write outputs ──
const reportPath = resolve(__dirname, REPORT_NAME);
writeFileSync(reportPath, lines.join("\n"));
console.error("\nReport written to", reportPath);

writeFileSync(resolve(__dirname, DATA_NAME), JSON.stringify({
  trackPath: TRACK_PATH,
  workerOutput: captured,
  durSec, bpm, periodMs, bar1Ms,
  dropSec, beatsFromBar1, nearestBeatIdx, positionInBar,
  beatsFirst60: beatsFirst60.slice(0, 130),
  beat16Data,
  workerLogs: logs,
}, null, 2));
