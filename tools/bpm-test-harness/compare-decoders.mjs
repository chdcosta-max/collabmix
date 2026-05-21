// Compare the decoded output of audio-decode (mpg123/libmpg123) vs
// ffmpeg-static (libavcodec, same MP3 decoder family Chrome ships with).
// Goal: determine whether production (Web Audio API in browser) sees the
// same buffer as the test harness, or whether there's a sample-offset shift.
//
// For each track:
//   1. Decode via audio-decode → buf_mpg
//   2. Decode via ffmpeg → buf_ff (raw F32LE PCM, native sample rate, mono)
//   3. Find best-cross-correlation alignment of buf_ff vs buf_mpg in the first 2s
//   4. Report sample offset, peak xcorr value, first-100ms profile diff
//
// Usage: node compare-decoders.mjs <path1> [path2 ...]

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import decodeAudio from "audio-decode";

const FFMPEG = new URL("./node_modules/ffmpeg-static/ffmpeg", import.meta.url).pathname;

function decodeWithFfmpeg(path, sr) {
  const tmpDir = mkdtempSync(join(tmpdir(), "ffdecode-"));
  const out = join(tmpDir, "out.f32");
  // -i path → -f f32le -ac 1 -ar <sr>  (raw float32, mono, target sample rate)
  // -vn = no video; -map_metadata -1 to drop tags; -hide_banner
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-i", path,
    "-f", "f32le",
    "-ac", "1",
    "-ar", String(sr),
    "-vn",
    "-map_metadata", "-1",
    "-y",
    out,
  ];
  const r = spawnSync(FFMPEG, args);
  if (r.status !== 0) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw new Error("ffmpeg failed: " + r.stderr.toString());
  }
  const raw = readFileSync(out);
  rmSync(tmpDir, { recursive: true, force: true });
  // raw is Float32 LE; copy into a Float32Array
  const samples = new Float32Array(raw.byteLength / 4);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getFloat32(i * 4, true);
  }
  return samples;
}

function monoMix(buf) {
  const cd = buf.channelData;
  const len = cd[0].length;
  const nc = cd.length;
  const mono = new Float32Array(len);
  for (let c = 0; c < nc; c++) {
    const d = cd[c];
    for (let i = 0; i < len; i++) mono[i] += d[i] / nc;
  }
  return { mono, sr: buf.sampleRate };
}

// Cross-correlation alignment: find offset that minimizes RMS(a - b_shifted)
// in a 2-second window. Returns { bestOffset, bestRms }.
function alignBuffers(a, b, maxOffsetSamples = 4096) {
  const winLen = Math.min(88200, a.length - maxOffsetSamples, b.length - maxOffsetSamples);
  if (winLen <= 0) return { bestOffset: 0, bestRms: Infinity };
  let bestOffset = 0, bestSumSq = Infinity;
  for (let off = -maxOffsetSamples; off <= maxOffsetSamples; off++) {
    let sumSq = 0;
    const aStart = off >= 0 ? 0 : -off;
    const bStart = off >= 0 ? off : 0;
    for (let i = 0; i < winLen; i++) {
      const av = a[aStart + i] || 0;
      const bv = b[bStart + i] || 0;
      const d = av - bv;
      sumSq += d * d;
    }
    if (sumSq < bestSumSq) { bestSumSq = sumSq; bestOffset = off; }
  }
  const rms = Math.sqrt(bestSumSq / winLen);
  return { bestOffset, bestRms: rms };
}

// Per-ms |max| profile
function msProfile(buf, sr, count = 100) {
  const arr = [];
  for (let ms = 0; ms < count; ms++) {
    const s = Math.floor(ms * sr / 1000);
    const e = Math.floor((ms + 1) * sr / 1000);
    let mx = 0;
    for (let i = s; i < e; i++) { const a = Math.abs(buf[i] || 0); if (a > mx) mx = a; }
    arr.push(mx);
  }
  return arr;
}

function profileToBar(p) {
  return p.map(v => v < 1e-4 ? "·" : v < 1e-2 ? "." : v < 0.1 ? "o" : v < 0.5 ? "O" : "█").join("");
}

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("Usage: node compare-decoders.mjs <path1> [path2 ...]");
  process.exit(2);
}

for (const path of paths) {
  console.log(`\n══ ${basename(path)} ══`);
  try {
    const mpgBuf = await decodeAudio(readFileSync(path));
    const { mono: mpg, sr } = monoMix(mpgBuf);
    const ff = decodeWithFfmpeg(path, sr);

    console.log(`  sr=${sr}  mpg samples=${mpg.length}  ff samples=${ff.length}  diff=${ff.length - mpg.length}`);

    // Per-ms profile
    const mpgProf = msProfile(mpg, sr, 60);
    const ffProf = msProfile(ff, sr, 60);
    console.log("  mpg123  (audio-decode): " + profileToBar(mpgProf));
    console.log("  ffmpeg  (libavcodec):   " + profileToBar(ffProf));
    console.log("                           " + " ".repeat(0) + "0         1         2         3         4         5");
    console.log("                           ms tens →");

    // Find best alignment
    const { bestOffset, bestRms } = alignBuffers(mpg, ff, 4096);
    console.log(`  best alignment: ffmpeg shifted by ${bestOffset >= 0 ? "+" : ""}${bestOffset} samples (= ${(bestOffset / sr * 1000).toFixed(2)}ms) vs mpg123  rms_residual=${bestRms.toExponential(2)}`);

    // First 10 samples comparison
    console.log("  first 10 mpg123 samples: " + Array.from(mpg.subarray(0, 10)).map(v => v.toFixed(4)).join(" "));
    console.log("  first 10 ffmpeg samples: " + Array.from(ff.subarray(0, 10)).map(v => v.toFixed(4)).join(" "));

    // Find first non-zero sample in each
    let mpgNZ = -1; for (let i = 0; i < mpg.length; i++) { if (Math.abs(mpg[i]) > 1e-6) { mpgNZ = i; break; } }
    let ffNZ = -1; for (let i = 0; i < ff.length; i++) { if (Math.abs(ff[i]) > 1e-6) { ffNZ = i; break; } }
    console.log(`  first non-zero: mpg=${mpgNZ} (${(mpgNZ / sr * 1000).toFixed(2)}ms)  ff=${ffNZ} (${(ffNZ / sr * 1000).toFixed(2)}ms)  diff=${ffNZ - mpgNZ} samples`);

    // First sample reaching 1% of first-second peak
    let mpgPeak = 0, ffPeak = 0;
    for (let i = 0; i < Math.min(mpg.length, sr); i++) if (Math.abs(mpg[i]) > mpgPeak) mpgPeak = Math.abs(mpg[i]);
    for (let i = 0; i < Math.min(ff.length, sr); i++) if (Math.abs(ff[i]) > ffPeak) ffPeak = Math.abs(ff[i]);
    let mpg1pct = -1; for (let i = 0; i < Math.min(mpg.length, sr); i++) { if (Math.abs(mpg[i]) > mpgPeak * 0.01) { mpg1pct = i; break; } }
    let ff1pct = -1; for (let i = 0; i < Math.min(ff.length, sr); i++) { if (Math.abs(ff[i]) > ffPeak * 0.01) { ff1pct = i; break; } }
    console.log(`  first @ 1% peak: mpg=${mpg1pct} (${(mpg1pct / sr * 1000).toFixed(2)}ms)  ff=${ff1pct} (${(ff1pct / sr * 1000).toFixed(2)}ms)  diff=${ff1pct - mpg1pct} samples`);
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
  }
}
