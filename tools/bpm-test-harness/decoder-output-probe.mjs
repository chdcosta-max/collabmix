// Inspect the FIRST samples of the decoded buffer from audio-decode (mpg123 wrapper).
// Does mpg123 strip leading silence/padding for Case 2 tracks (Xing/Info, no LAME)?
// If so, the buffer starts at "real audio". If not, there's ~25ms of priming.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import decodeAudio from "audio-decode";

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("Usage: node decoder-output-probe.mjs <path1> [path2 ...]");
  process.exit(2);
}

for (const path of paths) {
  console.log(`\n── ${basename(path)} ──`);
  const buf = await decodeAudio(readFileSync(path));
  const sr = buf.sampleRate;
  const cd = buf.channelData;
  const len = cd[0].length;

  // Mono mix
  const mono = new Float32Array(len);
  const nc = cd.length;
  for (let c = 0; c < nc; c++) {
    const d = cd[c];
    for (let i = 0; i < len; i++) mono[i] += d[i] / nc;
  }

  console.log(`  sr=${sr}  channels=${nc}  totalSamples=${len}  duration=${(len/sr).toFixed(2)}s`);

  // Per-millisecond max-abs for first 100ms
  console.log(`  Per-ms |max| of first 100ms:`);
  let line = "    ";
  for (let ms = 0; ms < 100; ms++) {
    const start = Math.floor(ms * sr / 1000);
    const end = Math.floor((ms + 1) * sr / 1000);
    let mx = 0;
    for (let i = start; i < end; i++) {
      const a = Math.abs(mono[i]);
      if (a > mx) mx = a;
    }
    // Color by magnitude
    const s = mx < 1e-4 ? "·" : mx < 1e-2 ? "." : mx < 0.1 ? "o" : mx < 0.5 ? "O" : "█";
    line += s;
    if ((ms + 1) % 10 === 0) line += " ";
  }
  console.log(line);
  console.log(`    legend: · = <1e-4  . = <1e-2  o = <0.1  O = <0.5  █ = ≥0.5`);

  // First sample-by-sample for first 50 samples (~1ms)
  let nonZeroStart = -1;
  for (let i = 0; i < len; i++) {
    if (Math.abs(mono[i]) > 1e-6) { nonZeroStart = i; break; }
  }
  console.log(`  First non-zero (|>1e-6|) sample: idx=${nonZeroStart}  time=${nonZeroStart < 0 ? "—" : (nonZeroStart / sr * 1000).toFixed(2) + "ms"}`);

  // First sample reaching 1% peak
  let p99 = 0;
  for (let i = 0; i < Math.min(len, sr); i++) {
    if (Math.abs(mono[i]) > p99) p99 = Math.abs(mono[i]);
  }
  let firstAt1pct = -1;
  for (let i = 0; i < Math.min(len, sr); i++) {
    if (Math.abs(mono[i]) > p99 * 0.01) { firstAt1pct = i; break; }
  }
  console.log(`  First sample reaching 1% of first-second peak (${p99.toExponential(2)}): idx=${firstAt1pct}  time=${firstAt1pct < 0 ? "—" : (firstAt1pct / sr * 1000).toFixed(2) + "ms"}`);

  // Print first 30 samples (raw)
  console.log(`  First 30 raw mono samples: ${Array.from(mono.subarray(0, 30)).map(v => v.toFixed(4)).join(" ")}`);
}
