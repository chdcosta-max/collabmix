// gen-fixture.mjs — writes the bundled audio fixture the smoke suite loads
// through the app's normal path. Deterministic synthetic 120 BPM four-on-the-
// floor kick loop: a sharp broadband attack click + a 55 Hz body with fast
// exponential decay every 0.5s. Sharp attack → clean onset for the onset/
// de-smear assertions; steady 120 BPM → the analyzer detects beats reliably.
//
// Generated at suite setup (not committed) so the repo carries no binary.
//   import { ensureFixture } from "./gen-fixture.mjs"; await ensureFixture();
// Writes public/test-fixtures/kick120.wav (served by vite at /test-fixtures/).

import { writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_REL = "/test-fixtures/kick120.wav";
export const FIXTURE_BPM = 120;
const OUT_DIR = resolve(__dirname, "../../../public/test-fixtures");
const OUT_PATH = resolve(OUT_DIR, "kick120.wav");

const SR = 44100, SECONDS = 12, BPM = FIXTURE_BPM;

// Deterministic PRNG (no Math.random — reproducible fixture byte-for-byte).
let _s = 0x2545f491;
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff - 0.5; };

function renderKickLoop() {
  const n = SR * SECONDS;
  const x = new Float32Array(n);
  const beatSec = 60 / BPM;
  const kickInterval = Math.round(beatSec * SR);
  for (let b = 0; b * kickInterval < n; b++) {
    const start = b * kickInterval;
    for (let i = 0; i < SR * 0.4 && start + i < n; i++) {
      const t = i / SR;
      // 5ms broadband attack click — dominant, sharp leading edge that both the
      // analyzer walk-back and the onset reference agree on within ~1ms.
      const click = i < SR * 0.005 ? rnd() * 2 * Math.exp(-t / 0.0025) : 0;
      // 55 Hz body with INSTANT attack (cosine starts at full) + exp decay, so
      // the kick energy rises immediately rather than over a slow sine ramp.
      const body = Math.cos(2 * Math.PI * (55 - 15 * t) * t) * Math.exp(-t / 0.07);
      x[start + i] += 0.8 * body + 0.6 * click;
    }
  }
  // Low broadband noise floor so it's never pure digital silence.
  for (let i = 0; i < n; i++) x[i] += rnd() * 0.002;
  // Normalize to -1.5 dBFS.
  let mx = 0; for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(x[i]));
  const g = mx > 0 ? 0.84 / mx : 1;
  for (let i = 0; i < n; i++) x[i] *= g;
  return x;
}

function toWav16(samples, sr) {
  const n = samples.length, dataBytes = n * 2, buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < n; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE((s * 32767) | 0, 44 + i * 2);
  }
  return buf;
}

export function ensureFixture(force = false) {
  if (!force && existsSync(OUT_PATH) && statSync(OUT_PATH).size > 1000) return OUT_PATH;
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_PATH, toWav16(renderKickLoop(), SR));
  return OUT_PATH;
}
export const FIXTURE_PATH = OUT_PATH;

// Allow `node gen-fixture.mjs` to (re)generate directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  const p = ensureFixture(true);
  console.log("wrote fixture:", p, statSync(p).size + " bytes");
}
