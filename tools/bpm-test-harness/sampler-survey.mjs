// Survey: which tracks in the current FAIL set are samplers (short, few beats),
// and which tracks in the current PASS set would be affected (regression risk).
//
// Sampler detection: durSec < 30 OR dpBeats.length (proxy: durSec/beatPeriodSec) < 8.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import decodeAudio from "audio-decode";

const baseline = JSON.parse(readFileSync("snapshots/fix-A-75.json", "utf8"));

// Approximate duration from file size won't work; need to decode briefly.
// Use audio-decode to get sample count; cap to first 30s read for speed where possible.
async function probeDuration(path) {
  try {
    const buf = await decodeAudio(readFileSync(path));
    const samples = buf.channelData[0].length;
    return { sr: buf.sampleRate, samples, durSec: samples / buf.sampleRate };
  } catch (e) {
    return { error: e.message };
  }
}

console.log("=== Currently-FAILING tracks: which would be sampler candidates? ===\n");
const fails = baseline.results.filter(r => r.status === "FAIL");
const failsCandidate = [];
for (const r of fails) {
  const d = await probeDuration(r.path);
  if (d.error) continue;
  const period = r.beatPeriodSec || 0.5;
  const durBeats = d.durSec / period;
  const isSamplerByDur = d.durSec < 30;
  const isSamplerByBeats = durBeats < 8;
  const isSampler = isSamplerByDur || isSamplerByBeats;
  if (isSampler) {
    failsCandidate.push({ ...r, durSec: d.durSec, durBeats });
  }
}
console.log("Failing samplers:");
console.log("  durSec  durBeats  ana_ms   truth_ms  Δfd      <30ms? ext  basename");
for (const r of failsCandidate.sort((a,b)=>a.durSec-b.durSec)) {
  const ext = (r.path.match(/\.[a-z0-9]+$/i) || ["?"])[0];
  const ana_ms = (r.analyzerFirstDownbeatSec || 0) * 1000;
  const truth_ms = (r.truthFirstDownbeatSec || 0) * 1000;
  const within30 = ana_ms < 30 ? "Y" : "N";
  console.log("  " + r.durSec.toFixed(2).padStart(6) + "  " + r.durBeats.toFixed(1).padStart(7) + "  " +
    ana_ms.toFixed(1).padStart(6) + "  " + truth_ms.toFixed(1).padStart(7) + "  " +
    r.deltaDownbeatMs.toFixed(1).padStart(7) + "ms " + within30.padStart(5) + "  " + ext.padEnd(4) + " " + r.basename);
}

console.log("\n=== Currently-PASSING tracks that ARE samplers: regression risk ===\n");
const passes = baseline.results.filter(r => r.status === "PASS");
const passSamplerRisk = [];
for (const r of passes) {
  const d = await probeDuration(r.path);
  if (d.error) continue;
  const period = r.beatPeriodSec || 0.5;
  const durBeats = d.durSec / period;
  const isSampler = d.durSec < 30 || durBeats < 8;
  if (isSampler) {
    const ana_ms = (r.analyzerFirstDownbeatSec || 0) * 1000;
    const truth_ms = (r.truthFirstDownbeatSec || 0) * 1000;
    passSamplerRisk.push({ ...r, durSec: d.durSec, durBeats, ana_ms, truth_ms });
  }
}
console.log("Currently-passing samplers (would snap to 0 if heuristic fires):");
console.log("  durSec  durBeats  ana_ms   truth_ms  cur_Δfd  <30ms?  new_Δfd_if_snap  basename");
for (const r of passSamplerRisk.sort((a,b)=>a.durSec-b.durSec)) {
  const within30 = r.ana_ms < 30 ? "Y" : "N";
  const newDfd = within30 === "Y" ? Math.abs(0 - r.truth_ms) : r.deltaDownbeatMs;
  const newPass = newDfd <= 20 ? "PASS" : "FAIL";
  console.log("  " + r.durSec.toFixed(2).padStart(6) + "  " + r.durBeats.toFixed(1).padStart(7) + "  " +
    r.ana_ms.toFixed(1).padStart(6) + "  " + r.truth_ms.toFixed(1).padStart(7) + "  " +
    r.deltaDownbeatMs.toFixed(1).padStart(7) + "  " + within30.padStart(5) + "   " +
    newDfd.toFixed(1).padStart(8) + " " + newPass + "  " + r.basename);
}

const couldFireFails = failsCandidate.filter(r => (r.analyzerFirstDownbeatSec || 0) * 1000 < 30).length;
const couldFirePasses = passSamplerRisk.filter(r => r.ana_ms < 30).length;
console.log(`\n=== SUMMARY (sampler heuristic with <30ms gate) ===`);
console.log(`  FAIL → PASS candidates: ${couldFireFails}`);
console.log(`  PASS could be affected: ${couldFirePasses}`);
const regressions = passSamplerRisk.filter(r => {
  if (r.ana_ms >= 30) return false;
  const newDfd = Math.abs(0 - r.truth_ms);
  return newDfd > 20;
});
console.log(`  PASS → FAIL regressions predicted: ${regressions.length}`);
if (regressions.length > 0) {
  console.log("  Predicted regressions:");
  for (const r of regressions) {
    console.log("    truth=" + r.truth_ms.toFixed(1) + "ms ana=" + r.ana_ms.toFixed(1) + "ms → after snap Δfd would be " + Math.abs(0 - r.truth_ms).toFixed(1) + "ms  " + r.basename);
  }
}
