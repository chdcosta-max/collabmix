// Single-track debug: keep console.log enabled to surface [BPM-RESCUE]
// and [BPM-PERIOD]/[phase] traces so we can see whether Fix #2 fired.
import { readFileSync } from "node:fs";
import decodeAudio from "audio-decode";
import { WORKER_SRC } from "../../src/bpm-worker-source.js";

const PATH = process.argv[2];
if (!PATH) { console.error("Usage: node debug-fix2.mjs <audio-path>"); process.exit(2); }

const buf = await decodeAudio(readFileSync(PATH));
const sr = buf.sampleRate;
const cd = buf.channelData;

let captured = null;
const self = { onmessage: null, postMessage: (r) => { captured = r; } };
new Function("self", WORKER_SRC)(self);
self.onmessage({ data: { cd, sr, id: PATH.split("/").pop() } });

console.log("\n=== WORKER OUTPUT ===");
console.log("bpm:", captured.bpm);
console.log("beatPeriodSec:", captured.beatPeriodSec);
console.log("firstBar1AnchorSec:", captured.firstBar1AnchorSec);
console.log("beatPhaseFrac × beatPeriodSec:",
  captured.beatPhaseFrac != null && captured.beatPeriodSec != null
    ? captured.beatPhaseFrac * captured.beatPeriodSec
    : null);
