// duration_worker.mjs — decodes audio just to get duration.
import { parentPort } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS_NM = resolve(__dirname, "..", "bpm-test-harness", "node_modules");
const decodeAudioMod = await import(resolve(HARNESS_NM, "audio-decode", "audio-decode.js"));
const decodeAudio = decodeAudioMod.default;

parentPort.on("message", async (msg) => {
  if (msg.type === "shutdown") process.exit(0);
  const { idx, path } = msg;
  try {
    const buf = await decodeAudio(readFileSync(path));
    parentPort.postMessage({ idx, durSec: buf.channelData[0].length / buf.sampleRate });
  } catch (e) {
    parentPort.postMessage({ idx, error: e.message });
  }
});
parentPort.postMessage({ type: "ready" });
