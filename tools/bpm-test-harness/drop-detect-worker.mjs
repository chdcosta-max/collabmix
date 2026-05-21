// drop-detect-worker.mjs — detects "breakdown → drop" events in a track and
// returns drop times in seconds. Pure investigation tool; no production code.
//
// Concept:
//   EDM tracks alternate kick-active sections with breakdown sections (no kick
//   or sidechained-down kick). A "drop" is the moment the kick returns after a
//   breakdown. Drops align with bar-1 of a 4-bar phrase. By voting on which
//   beat-of-bar each drop lands on, we can detect (and correct) grid phase
//   errors in the analyzer.
//
// Algorithm:
//   1. Bandpass 40-100 Hz → frame energy at 100 ms hops → smooth with 2 s box
//   2. Determine "kick-active" threshold: 40% of the per-track 70th percentile
//      of the smoothed envelope (robust to a few loud drops dragging the mean)
//   3. Walk the smoothed envelope; mark every "low" stretch ≥ MIN_BREAK_SEC
//      (default 4 s) as a breakdown.
//   4. For each breakdown, the drop = first frame after the breakdown where
//      the envelope rises ABOVE threshold. Refine to the local maximum in the
//      raw (un-smoothed) frame energy within ±300 ms.
//   5. Also count the START of the track as an implicit "drop" if it begins
//      kick-active (since the very-start kick-in is structurally a downbeat).

import { parentPort } from "node:worker_threads";
import { readFileSync } from "node:fs";
import decodeAudio from "audio-decode";

function toMono(ch) {
  if (ch.length === 1) return ch[0];
  const o = new Float32Array(ch[0].length);
  for (let i = 0; i < ch[0].length; i++) {
    let s = 0;
    for (let c = 0; c < ch.length; c++) s += ch[c][i];
    o[i] = s / ch.length;
  }
  return o;
}

function bandpass(sig, sr, low, high) {
  const out = new Float32Array(sig.length);
  const rL = 1 / (2 * Math.PI * high / sr + 1);
  const rH = 1 / (2 * Math.PI * low / sr + 1);
  const hp = new Float32Array(sig.length);
  let pi = 0, po = 0;
  for (let i = 0; i < sig.length; i++) {
    hp[i] = rH * (po + sig[i] - pi);
    pi = sig[i];
    po = hp[i];
  }
  let pv = 0;
  for (let i = 0; i < hp.length; i++) {
    pv = pv + (1 - rL) * (hp[i] - pv);
    out[i] = pv;
  }
  return out;
}

function detectDrops(mono, sr, opts = {}) {
  const HOP_SEC = opts.hopSec ?? 0.1;
  const SMOOTH_SEC = opts.smoothSec ?? 2.0;
  const MIN_BREAK_SEC = opts.minBreakSec ?? 4.0; // breakdown must be ≥4 s
  const THRESH_FRAC = opts.threshFrac ?? 0.40;   // % of p70 envelope
  const ANA_BAR1 = opts.anaBar1;                 // sec — analyzer's bar-1 (for beat-snap)
  const ANA_PERIOD = opts.anaPeriod;             // sec — analyzer's beat period

  const band = bandpass(mono, sr, 40, 100);
  const hop = Math.max(1, Math.round(sr * HOP_SEC));
  const n = Math.floor(mono.length / hop);
  const fE = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const st = i * hop;
    let s = 0;
    for (let j = 0; j < hop && st + j < band.length; j++) {
      const v = band[st + j];
      s += v * v;
    }
    fE[i] = Math.sqrt(s / hop);
  }

  // Smooth with box of SMOOTH_SEC frames
  const sw = Math.max(3, Math.round(SMOOTH_SEC / HOP_SEC));
  const fS = new Float32Array(n);
  let acc = 0;
  const q = [];
  for (let i = 0; i < n; i++) {
    acc += fE[i];
    q.push(fE[i]);
    if (q.length > sw) acc -= q.shift();
    fS[i] = acc / q.length;
  }

  // Threshold = THRESH_FRAC × p70 of fS
  const sorted = Array.from(fS).filter(v => v > 0).sort((a, b) => a - b);
  if (sorted.length < 10) return { drops: [], breakdowns: [], threshold: 0, p70: 0 };
  const p70 = sorted[Math.floor(sorted.length * 0.70)];
  const thresh = p70 * THRESH_FRAC;

  // Build active/inactive frame map
  const active = new Uint8Array(n);
  for (let i = 0; i < n; i++) active[i] = fS[i] > thresh ? 1 : 0;

  // Walk runs: find inactive runs ≥ MIN_BREAK_SEC and the first active frame after
  const minBreakFrames = Math.ceil(MIN_BREAK_SEC / HOP_SEC);
  const drops = [];
  const breakdowns = [];

  // First, handle the start: if the track starts active, that's an implicit drop at t=0
  if (active[0]) {
    drops.push({ frame: 0, time: 0, refinedTime: 0, kind: "start" });
  }

  // Scan for inactive→active transitions following sufficient inactivity
  let i = 0;
  let inactiveStart = active[0] ? -1 : 0;
  for (i = 1; i < n; i++) {
    if (!active[i] && active[i - 1]) {
      inactiveStart = i;
    } else if (active[i] && !active[i - 1] && inactiveStart >= 0) {
      const breakFrames = i - inactiveStart;
      if (breakFrames >= minBreakFrames) {
        breakdowns.push({
          startSec: inactiveStart * HOP_SEC,
          endSec: i * HOP_SEC,
          durSec: breakFrames * HOP_SEC,
        });

        // Refine drop position by snapping to the earliest analyzer-grid beat
        // near the threshold crossing that:
        //   (a) has substantial kick energy in raw fE (above local median)
        //   (b) shows a clear energy RISE from the previous beat (kick-return,
        //       not pre-roll noise)
        let refinedTime = i * HOP_SEC;
        let snappedBeat = -1;

        if (ANA_BAR1 != null && ANA_PERIOD != null && ANA_PERIOD > 0) {
          const tDrop = i * HOP_SEC;
          // Sample-time of candidate analyzer beats within ±1.5 × period of tDrop
          const N0 = Math.round((tDrop - ANA_BAR1) / ANA_PERIOD);
          // Compute local energy floor (median of fE in a 2-sec window AFTER the drop)
          const winLo = i, winHi = Math.min(n - 1, i + Math.round(2.0 / HOP_SEC));
          const win = [];
          for (let k = winLo; k <= winHi; k++) win.push(fE[k]);
          const winSorted = win.slice().sort((a, b) => a - b);
          const winMedian = winSorted[Math.floor(winSorted.length / 2)] || 0;
          const minEnergy = winMedian * 0.4;

          // Walk candidate beats from earliest (N0-2) forward to (N0+2),
          // pick the earliest beat satisfying (a) and (b).
          for (let dN = -2; dN <= 2; dN++) {
            const N = N0 + dN;
            const tBeat = ANA_BAR1 + N * ANA_PERIOD;
            if (tBeat < 0 || tBeat >= mono.length / sr) continue;
            const fIdx = Math.round(tBeat / HOP_SEC);
            if (fIdx < 1 || fIdx >= n - 1) continue;
            // Local-max energy in ±60ms window
            const r = Math.max(1, Math.round(0.06 / HOP_SEC));
            let eHere = 0;
            for (let k = Math.max(0, fIdx - r); k <= Math.min(n - 1, fIdx + r); k++) {
              if (fE[k] > eHere) eHere = fE[k];
            }
            if (eHere < minEnergy) continue;
            // Energy at the PREVIOUS beat (1 beat earlier)
            const prevFIdx = Math.round((tBeat - ANA_PERIOD) / HOP_SEC);
            let ePrev = 0;
            if (prevFIdx >= 0 && prevFIdx < n) {
              for (let k = Math.max(0, prevFIdx - r); k <= Math.min(n - 1, prevFIdx + r); k++) {
                if (fE[k] > ePrev) ePrev = fE[k];
              }
            }
            // Require ≥2× rise from prev beat (this is what makes it a "drop")
            if (eHere < 2 * ePrev) continue;
            refinedTime = tBeat;
            snappedBeat = N;
            break;
          }
        }

        drops.push({
          frame: i,
          time: i * HOP_SEC,
          refinedTime,
          snappedBeat,
          kind: "post-breakdown",
        });
      }
      inactiveStart = -1;
    }
  }

  return { drops, breakdowns, threshold: thresh, p70 };
}

parentPort.on("message", async (msg) => {
  if (msg.type === "shutdown") {
    process.exit(0);
  }
  const { idx, path, anaBar1, anaPeriod } = msg;
  let buf;
  try {
    buf = await decodeAudio(readFileSync(path));
  } catch (e) {
    parentPort.postMessage({ idx, decodeError: e.message });
    return;
  }
  const mono = toMono(buf.channelData);
  let result;
  try {
    result = detectDrops(mono, buf.sampleRate, { anaBar1, anaPeriod });
    result.durSec = mono.length / buf.sampleRate;
  } catch (e) {
    parentPort.postMessage({ idx, decodeError: "probe error: " + e.message });
    return;
  }
  parentPort.postMessage({ idx, result });
});

parentPort.postMessage({ type: "ready" });
