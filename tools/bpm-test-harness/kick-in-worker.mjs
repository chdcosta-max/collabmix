// kick-in-worker.mjs — Worker thread for kick-in-probe.mjs
//
// Detects the "structural kick-in" moment: first kick that is part of a
// sustained, regularly-spaced kick pattern. Distinct from "first transient"
// (which fires on any onset of any sort).
//
// Method:
//   1. Decode → mono → bandpass 40-100 Hz
//   2. Frame energy at 25ms hops, smooth ~80ms
//   3. Find peaks in the smoothed envelope (these are kick events)
//   4. Filter peaks to "real" — peak amplitude > 25% of median real-peak amplitude
//      (iterate twice: first pass uses median of all peaks ≥ noise-floor)
//   5. structuralKickIn = first peak that is followed by ≥3 more real peaks
//      within the next 1.5 seconds AND spaced consistently (intervals
//      coefficient of variation < 0.25). This is the first sustained beat.

import { parentPort } from "node:worker_threads";
import { readFileSync } from "node:fs";
import decodeAudio from "audio-decode";

function toMono(channels) {
  const len = channels[0].length;
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(len);
  const n = channels.length;
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let c = 0; c < n; c++) s += channels[c][i];
    out[i] = s / n;
  }
  return out;
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

function kickInProbe(mono, sr) {
  const durSec = mono.length / sr;

  // 1. Kick band
  const band = bandpass(mono, sr, 40, 100);

  // 2. Frame energy + onset envelope at 25ms hops
  const HOP_SEC = 0.025;
  const hop = Math.max(1, Math.round(sr * HOP_SEC));
  const nFrames = Math.floor(mono.length / hop);
  const fE = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    const st = i * hop;
    let s = 0;
    for (let j = 0; j < hop && st + j < band.length; j++) {
      const v = band[st + j];
      s += v * v;
    }
    fE[i] = Math.sqrt(s / hop);
  }
  // Lightly smoothed for peak picking (~75ms)
  const SMOOTH = 3;
  const fS = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    let acc = 0, n = 0;
    for (let k = -1; k <= 1; k++) {
      const j = i + k;
      if (j >= 0 && j < nFrames) { acc += fE[j]; n++; }
    }
    fS[i] = acc / n;
  }

  // 3. Peak picking. A peak is a frame i where fS[i] > fS[i±k] for k=1..4
  //    (~100ms exclusion window — kicks at 120 BPM are 500ms apart so this
  //    is safely inside a single beat).
  const PEAK_R = 4;
  const peaks = []; // {frame, amp}
  for (let i = PEAK_R; i < nFrames - PEAK_R; i++) {
    let isPeak = true;
    for (let k = 1; k <= PEAK_R; k++) {
      if (fS[i] < fS[i - k] || fS[i] < fS[i + k]) { isPeak = false; break; }
    }
    if (isPeak && fS[i] > 0) peaks.push({ frame: i, amp: fS[i] });
  }
  if (peaks.length === 0) {
    return { durSec, firstTransSec: null, kickInSec: null, kicklessIntroSec: 0, nPeaks: 0, medianPeakAmp: 0 };
  }

  // 4. Robust threshold via median of all peaks
  const ampsSorted = peaks.map(p => p.amp).sort((a, b) => a - b);
  const medianAmp = ampsSorted[Math.floor(ampsSorted.length / 2)];
  // "Real" peaks: amplitude ≥ 30% of median (keeps low-velocity-but-sustained
  // intro kicks while filtering out room-tone/noise floor jitter)
  const realThresh = medianAmp * 0.30;
  const realPeaks = peaks.filter(p => p.amp >= realThresh);

  // 5. First-transient = first real peak (informational only).
  const firstTransSec = realPeaks.length > 0 ? realPeaks[0].frame * HOP_SEC : null;

  // 6. Structural kick-in: first real peak that is part of a regular run of
  //    ≥4 real peaks (the trigger + 3) within the next 1.6 seconds AND with
  //    inter-peak intervals consistent enough that this is a beat (not random
  //    transients). Coefficient of variation of intervals < 0.30.
  const RUN_WIN_SEC = 1.6;
  const RUN_N = 4;
  let kickInFrame = -1;
  for (let i = 0; i < realPeaks.length; i++) {
    const startFrame = realPeaks[i].frame;
    // Collect all real peaks in [startFrame, startFrame + RUN_WIN_SEC]
    const winFrames = [];
    for (let j = i; j < realPeaks.length; j++) {
      const dt = (realPeaks[j].frame - startFrame) * HOP_SEC;
      if (dt > RUN_WIN_SEC) break;
      winFrames.push(realPeaks[j].frame);
    }
    if (winFrames.length < RUN_N) continue;
    // Compute intervals
    const intervals = [];
    for (let k = 1; k < winFrames.length; k++) {
      intervals.push((winFrames[k] - winFrames[k - 1]) * HOP_SEC);
    }
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    if (mean < 0.25 || mean > 0.80) continue; // BPM 75-240 range for kick spacing
    const variance = intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length;
    const cv = Math.sqrt(variance) / mean;
    if (cv > 0.30) continue; // intervals too jittery to be a real beat
    kickInFrame = startFrame;
    break;
  }

  let kickInSec = kickInFrame >= 0 ? kickInFrame * HOP_SEC : null;
  // Refine: the peak is one full kick attack-to-peak after the kick onset.
  // Walk back ~15ms (typical attack rise on low-band onset) for closer
  // alignment with Rekordbox-style beat placement. This is a fixed offset,
  // not per-track tuning — kept for interpretability of the comparison.
  if (kickInSec != null) kickInSec = Math.max(0, kickInSec - 0.005);

  // Compute leading kickless interval — gap from time 0 to first real peak,
  // a proxy for "did this track have a kickless intro".
  const kicklessIntroSec = firstTransSec != null ? firstTransSec : 0;

  return {
    durSec,
    firstTransSec,
    kickInSec,
    kicklessIntroSec,
    nPeaks: realPeaks.length,
    medianPeakAmp: medianAmp,
  };
}

parentPort.on("message", async (msg) => {
  if (msg.type === "shutdown") {
    process.exit(0);
  }
  const { idx, path } = msg;
  let buf;
  try {
    buf = await decodeAudio(readFileSync(path));
  } catch (e) {
    parentPort.postMessage({ idx, decodeError: e.message });
    return;
  }
  const sr = buf.sampleRate;
  const cd = buf.channelData;
  if (!Array.isArray(cd) || !(cd[0] instanceof Float32Array)) {
    parentPort.postMessage({ idx, decodeError: "no channelData" });
    return;
  }
  const mono = toMono(cd);
  let probe;
  try {
    probe = kickInProbe(mono, sr);
  } catch (e) {
    parentPort.postMessage({ idx, decodeError: "probe error: " + e.message });
    return;
  }
  parentPort.postMessage({ idx, probe });
});

parentPort.postMessage({ type: "ready" });
