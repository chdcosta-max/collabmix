// Per-thread worker used by analyze-library.mjs.
// Receives { idx, path, basename } messages, decodes the audio file, runs
// the WORKER_SRC analyzer, and posts back the raw analyzer output.
//
// The full-library harness owns aggregation; this thread is purely the
// per-track "decode + analyze" inner loop, suitable for running 4-8 of
// these in parallel via node:worker_threads.

import { parentPort } from "node:worker_threads";
import { readFileSync } from "node:fs";
import decodeAudio from "audio-decode";
import { WORKER_SRC } from "../../src/bpm-worker-source.js";

function runAnalyzer(cd, sr, id) {
  let captured = null;
  const self = { onmessage: null, postMessage: (r) => { captured = r; } };
  const origLog = console.log;
  console.log = () => {}; // suppress worker [phase] chatter at scale
  try {
    new Function("self", WORKER_SRC)(self);
    self.onmessage({ data: { cd, sr, id } });
  } finally {
    console.log = origLog;
  }
  return captured;
}

parentPort.on("message", async (msg) => {
  if (msg.type === "shutdown") {
    process.exit(0);
  }
  const { idx, path, basename } = msg;
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
  let r;
  try {
    r = runAnalyzer(cd, sr, basename);
  } catch (e) {
    parentPort.postMessage({ idx, workerError: e.message });
    return;
  }
  parentPort.postMessage({ idx, result: r });
});

parentPort.postMessage({ type: "ready" });
