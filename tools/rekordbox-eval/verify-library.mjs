// verify-library.mjs — end-to-end test of the rekordbox-library orchestrator.
// Verifies: decrypt master.db → sql.js queries → ANLZ decode → bands.
//
// Uses a stub FileSystemDirectoryHandle backed by the real filesystem so we
// can run this in Node without a browser.

import { readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { existsSync, statSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openLibraryFromHandle } from "../../src/rekordbox-library.js";

const ROOT = "/Users/chad/Library/Pioneer/rekordbox";

// ── Stub FileSystemFileHandle / DirectoryHandle for Node ──
class NodeFileHandle {
  constructor(absPath) { this.path = absPath; }
  async getFile() {
    const buf = readFileSync(this.path);
    return new NodeFile(buf, this.path);
  }
}
class NodeFile {
  constructor(buf, name) {
    this.buf = buf;
    this.name = name.split("/").pop();
    this.size = buf.length;
  }
  async arrayBuffer() { return this.buf.buffer.slice(this.buf.byteOffset, this.buf.byteOffset + this.buf.byteLength); }
}
class NodeDirHandle {
  constructor(absPath) { this.path = absPath; }
  async getFileHandle(name) {
    const p = join(this.path, name);
    if (!existsSync(p) || !statSync(p).isFile()) {
      const e = new Error("NotFound: " + name); e.name = "NotFoundError"; throw e;
    }
    return new NodeFileHandle(p);
  }
  async getDirectoryHandle(name) {
    const p = join(this.path, name);
    if (!existsSync(p) || !statSync(p).isDirectory()) {
      const e = new Error("NotFound: " + name); e.name = "NotFoundError"; throw e;
    }
    return new NodeDirHandle(p);
  }
}

console.log("Step 1: open library at", ROOT);
const t0 = Date.now();
const rootHandle = new NodeDirHandle(ROOT);
const lib = await openLibraryFromHandle(rootHandle, {
  onProgress: (p) => console.log("  [" + p.phase + "]" + (p.trackCount ? " tracks=" + p.trackCount : "") + (p.cueCount ? " cues=" + p.cueCount : "")),
});
const t1 = Date.now();
console.log("  ready in " + (t1 - t0) + "ms\n");

console.log("Step 2: track + cue counts");
console.log("  trackCount:", lib.trackCount());
const allTracks = lib.allTracks();
const withAnalysis = allTracks.filter(t => t.analysisDataPath).length;
console.log("  with AnalysisDataPath:", withAnalysis);
const withCues = Array.from({length: allTracks.length}).filter((_, i) => lib.getCues(allTracks[i].id).length > 0).length;
console.log("  tracks with cues:", withCues);

// Pick a sample track that has analysis data
const sample = allTracks.find(t => t.analysisDataPath);
console.log("\nStep 3: sample track");
console.log("  id:", sample.id);
console.log("  fileNameL:", sample.fileNameL);
console.log("  title:", sample.title);
console.log("  bpm:", sample.bpm, "length:", sample.lengthSec, "size:", sample.fileSize);
console.log("  analysisDataPath:", sample.analysisDataPath);

console.log("\nStep 4: decode sample's ANLZ");
const t2 = Date.now();
const parsed = await lib.getAnlz(sample.id);
const t3 = Date.now();
if (!parsed) {
  console.error("  ✗ getAnlz returned null");
  process.exit(1);
}
console.log("  decoded in " + (t3 - t2) + "ms");
console.log("  tag types:", parsed.tags.map(t => t.type).join(", "));
const pwv5 = parsed.tags.find(t => t.type === "PWV5" && !t._stub);
console.log("  PWV5 entries:", pwv5?.numEntries);

console.log("\nStep 5: build waveform bands");
const t4 = Date.now();
const bands = await lib.getWaveformBands(sample.id);
const t5 = Date.now();
if (!bands) { console.error("  ✗ getWaveformBands null"); process.exit(1); }
console.log("  bands built in " + (t5 - t4) + "ms");
console.log("  bass.length:", bands.bass.length, "mid.length:", bands.mid.length, "high.length:", bands.high.length);
console.log("  dur:", bands.dur, "source:", bands.source);

// Sanity check: bass+mid+high at each pixel should approximately equal height
console.log("  first 5 (bass, mid, high, sum) vs PWV5 height:");
for (let i = 0; i < 5; i++) {
  const sum = bands.bass[i] + bands.mid[i] + bands.high[i];
  console.log(`    [${i}] ${bands.bass[i].toFixed(3)} ${bands.mid[i].toFixed(3)} ${bands.high[i].toFixed(3)} | sum=${sum.toFixed(3)} | h=${pwv5.heights[i].toFixed(3)}`);
}

console.log("\nStep 6: matchTrack by basename");
const fakeFile = { name: sample.fileNameL, size: sample.fileSize };
const m = lib.matchTrack(fakeFile);
console.log("  matched id:", m?.id, "== sample.id?", m?.id === sample.id);

// Bigger test: how many tracks have parseable .EXT files? Sample 20.
console.log("\nStep 7: random-sample decode test (20 tracks)");
const sampleSize = 20;
const samples = [];
for (let i = 0; i < sampleSize && i < allTracks.length; i++) {
  const t = allTracks[Math.floor(Math.random() * allTracks.length)];
  if (t.analysisDataPath) samples.push(t);
}
let ok = 0, fail = 0;
for (const t of samples) {
  try {
    const b = await lib.getWaveformBands(t.id);
    if (b && b.bass.length > 0) ok++; else fail++;
  } catch {
    fail++;
  }
}
console.log("  decoded ok: " + ok + " / failed: " + fail + " / out of: " + samples.length);

lib.disconnect();
console.log("\n✓ Library verification complete");
