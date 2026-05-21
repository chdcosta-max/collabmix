// anlz-parser.js — JS port of pyrekordbox ANLZ parser. Pure ES module,
// no dependencies. Reads Rekordbox per-track analysis files (.DAT, .EXT,
// .2EX, .3EX) from an ArrayBuffer / Uint8Array.
//
// Supported tags in this version:
//   PMAI — file header (auto-handled, not exposed)
//   PPTH — track path
//   PQTZ — beat grid (DAT)
//   PQT2 — extended beat grid (EXT)
//   PCOB — legacy cue list
//   PCO2 — extended cue list (color + label)
//   PWV4 — color waveform preview (1200 columns × 6 bytes)
//   PWV5 — color waveform detail (~50K columns × 2 bytes)
//
// PSSI (phrase analysis) — not implemented in Phase 1, parser will skip and
// continue. Add when phrase markers are scoped.
//
// Usage:
//   import { parseAnlz } from "./anlz-parser.js";
//   const result = parseAnlz(arrayBuffer);  // { tags: [...], unknownTags: [...] }
//   const pwv5 = result.tags.find(t => t.type === "PWV5");
//   pwv5.heights  // Float32Array, 0-1
//   pwv5.colors   // Uint8Array shape [N, 3], R 0-14, G 0-7, B 0-7

const FILE_HEADER_TYPE = "PMAI";

// Read helpers — DataView with explicit big-endian (Rekordbox uses BE).
function readAscii(view, offset, length) {
  let s = "";
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}
function readUint16BE(view, offset) { return view.getUint16(offset, false); }
function readUint32BE(view, offset) { return view.getUint32(offset, false); }
function readInt32BE(view, offset)  { return view.getInt32(offset, false); }
function readInt8(view, offset)     { return view.getInt8(offset); }
function readUint8(view, offset)    { return view.getUint8(offset); }

function readUtf16BE(view, offset, byteLength) {
  let s = "";
  for (let i = 0; i < byteLength; i += 2) {
    const code = view.getUint16(offset + i, false);
    if (code === 0) break;
    s += String.fromCharCode(code);
  }
  return s;
}

// ── Tag decoders ─────────────────────────────────────────────────────────

function decodePPTH(view, contentOffset, lenHeader, lenTag) {
  // Content starts at lenHeader, but the "tag header" portion before len_path
  // is at offset 12 (the generic tag header is 12 bytes).
  // PPTH layout after generic header: len_path(4), then UTF-16BE path padded.
  const lenPath = readUint32BE(view, contentOffset);
  const path = readUtf16BE(view, contentOffset + 4, Math.max(0, lenPath - 2));
  return { type: "PPTH", path };
}

function decodePQTZ(view, contentOffset, lenHeader, lenTag) {
  // After generic header (12 bytes), content:
  //   4 bytes padding
  //   4 bytes const 0x80000
  //   4 bytes entry_count
  // entries start at lenHeader (= 24 typically)
  const entryCount = readUint32BE(view, contentOffset + 8);
  const entriesOffset = lenHeader - 12 + contentOffset; // total file offset - generic header
  // Actually: tag content starts at `contentOffset` which is right after generic header.
  // len_header is the total tag-header offset from the start of the tag (including
  // generic 12 bytes). So entries start at (tagStart + lenHeader). contentOffset
  // is tagStart + 12. Entries start at (tagStart + lenHeader) = contentOffset + (lenHeader - 12).
  const entStart = contentOffset + (lenHeader - 12);
  const entries = [];
  for (let i = 0; i < entryCount; i++) {
    const off = entStart + i * 8;
    if (off + 8 > view.byteLength) break;
    entries.push({
      beat: readUint16BE(view, off),
      tempo: readUint16BE(view, off + 2),  // BPM × 100
      time: readUint32BE(view, off + 4),   // ms from start
    });
  }
  return { type: "PQTZ", entryCount, entries };
}

function decodePQT2(view, contentOffset, lenHeader, lenTag) {
  // PQT2 layout (per pyrekordbox):
  //   pad(4), const(4), pad(4), bpm[2] = 2×AnlzQuantizeTick(8), entry_count(4),
  //   u3(4), u4(4), u5(4) — total 56 bytes from tag start (so 44 bytes content header
  //   after the generic 12-byte tag header)
  // Then entry_count × AnlzQuantizeTick2 (2 bytes each)
  const bpm = [];
  for (let i = 0; i < 2; i++) {
    const off = contentOffset + 12 + i * 8;
    bpm.push({
      beat: readUint16BE(view, off),
      tempo: readUint16BE(view, off + 2),
      time: readUint32BE(view, off + 4),
    });
  }
  const entryCount = readUint32BE(view, contentOffset + 28);
  const entStart = contentOffset + (lenHeader - 12);
  const entries = [];
  for (let i = 0; i < entryCount; i++) {
    const off = entStart + i * 2;
    if (off + 2 > view.byteLength) break;
    entries.push({
      beat: readUint8(view, off),
      unknown: readUint8(view, off + 1),
    });
  }
  return { type: "PQT2", bpm, entryCount, entries };
}

function decodePCOB(view, contentOffset, lenHeader, lenTag) {
  // PCOB content after generic header:
  //   cue_type(4, Int32ub), unk(2), count(2), memory_count(4 signed)
  // Then count × AnlzCuePoint (each is len_entry bytes, typically 56)
  const cueType = readUint32BE(view, contentOffset);
  const unk = readUint16BE(view, contentOffset + 4);
  const count = readUint16BE(view, contentOffset + 6);
  const memoryCount = readInt32BE(view, contentOffset + 8);
  const entStart = contentOffset + (lenHeader - 12);
  const entries = [];
  let entOff = entStart;
  for (let i = 0; i < count; i++) {
    if (entOff + 16 > view.byteLength) break;
    // PCPT header
    const pcptType = readAscii(view, entOff, 4);
    if (pcptType !== "PCPT") {
      console.warn("PCOB entry " + i + " expected PCPT, got " + pcptType);
      break;
    }
    const pcptLenHeader = readUint32BE(view, entOff + 4);
    const pcptLenEntry = readUint32BE(view, entOff + 8);
    const hotCue = readUint32BE(view, entOff + 12);
    // status, u1, order, type, time at fixed offsets
    const status = readUint32BE(view, entOff + 16);   // 0=disabled, 4=enabled
    // skip u1 (4), order_first (2), order_last (2), type (1), pad (1), u2 (2) = 12 bytes
    const time = readUint32BE(view, entOff + 32);
    const loopTime = readInt32BE(view, entOff + 36);
    entries.push({
      kind: hotCue === 0 ? "memory" : "hot",
      hotCueSlot: hotCue,            // 1-8 for hot, 0 for memory
      enabled: status === 4,
      timeMs: time,
      loopTimeMs: loopTime < 0 ? null : loopTime,
    });
    entOff += pcptLenEntry;
  }
  return {
    type: "PCOB",
    cueType: cueType === 1 ? "hot" : "memory",
    count,
    memoryCount,
    entries,
  };
}

function decodePCO2(view, contentOffset, lenHeader, lenTag) {
  // PCO2 content after generic header:
  //   type(4), count(2), unknown(2)
  const cueType = readUint32BE(view, contentOffset);  // 0=memory, 1=hotcue
  const count = readUint16BE(view, contentOffset + 4);
  const entStart = contentOffset + (lenHeader - 12);
  const entries = [];
  let entOff = entStart;
  for (let i = 0; i < count; i++) {
    if (entOff + 16 > view.byteLength) break;
    const pcp2Type = readAscii(view, entOff, 4);
    if (pcp2Type !== "PCP2") {
      console.warn("PCO2 entry " + i + " expected PCP2, got " + pcp2Type);
      break;
    }
    const pcp2LenHeader = readUint32BE(view, entOff + 4);
    const pcp2LenEntry = readUint32BE(view, entOff + 8);
    const hotCue = readUint32BE(view, entOff + 12);
    const cueTypeByte = readUint8(view, entOff + 16);  // 1=single, 2=loop
    // skip 3 padding bytes
    const time = readUint32BE(view, entOff + 20);
    const loopTime = readInt32BE(view, entOff + 24);
    const colorId = readUint8(view, entOff + 28);
    // skip 7 padding bytes
    const loopEnum = readUint16BE(view, entOff + 36);
    const loopDenom = readUint16BE(view, entOff + 38);
    const lenComment = readUint32BE(view, entOff + 40);
    const comment = lenComment > 0
      ? readUtf16BE(view, entOff + 44, lenComment - 2)
      : "";
    const colorOff = entOff + 44 + lenComment;
    const colorCode = colorOff < view.byteLength ? readUint8(view, colorOff) : 0;
    const colorR = colorOff + 1 < view.byteLength ? readUint8(view, colorOff + 1) : 0;
    const colorG = colorOff + 2 < view.byteLength ? readUint8(view, colorOff + 2) : 0;
    const colorB = colorOff + 3 < view.byteLength ? readUint8(view, colorOff + 3) : 0;
    entries.push({
      kind: hotCue === 0 ? "memory" : "hot",
      hotCueSlot: hotCue,
      type: cueTypeByte === 2 ? "loop" : "single",
      timeMs: time,
      loopTimeMs: loopTime < 0 ? null : loopTime,
      colorId,
      colorRGB: [colorR, colorG, colorB],   // raw RGB from the file
      colorCode,                            // palette index (0-15 typically)
      label: comment,
      loopBars: loopEnum,
      loopDivisor: loopDenom,
    });
    entOff += pcp2LenEntry;
  }
  return {
    type: "PCO2",
    cueType: cueType === 1 ? "hot" : "memory",
    count,
    entries,
  };
}

function decodePWV4(view, contentOffset, lenHeader, lenTag) {
  // PWV4 — Color Waveform Preview, 6 bytes per entry, typically 1200 entries
  // Header: len_entry_bytes(4)=6, len_entries(4), unknown(4)
  const lenEntryBytes = readUint32BE(view, contentOffset);
  const numEntries = readUint32BE(view, contentOffset + 4);
  if (lenEntryBytes !== 6) {
    console.warn("PWV4 unexpected len_entry_bytes=" + lenEntryBytes);
  }
  const entStart = contentOffset + (lenHeader - 12);
  const heights = new Int32Array(numEntries * 2);
  const colColor = new Uint8Array(numEntries * 2 * 3);
  const colBlues = new Uint8Array(numEntries * 2 * 3);
  // Port of pyrekordbox's PWV4 decoder:
  for (let x = 0; x < numEntries; x++) {
    const base = entStart + x * 6;
    if (base + 6 > view.byteLength) break;
    // d0 unknown
    const d1 = readUint8(view, base + 1);   // luminance boost 0-127
    const d2 = readUint8(view, base + 2) & 0x7F;  // inverse intensity for blue waveform
    const d3 = readUint8(view, base + 3) & 0x7F;  // red
    const d4 = readUint8(view, base + 4) & 0x7F;  // green
    const d5 = readUint8(view, base + 5) & 0x7F;  // blue + front-height
    const bh = Math.max(d2, d3, d4);
    const fh = d5;
    const fl = 32;
    heights[x * 2 + 0] = fh;  // front
    heights[x * 2 + 1] = bh;  // back
    // color waveform (back then front)
    const lumScale = d1 / 127;
    const cR = d3 * lumScale, cG = d4 * lumScale, cB = d5 * lumScale;
    colColor[x * 6 + 0] = Math.min(255, Math.max(0, cR | 0));
    colColor[x * 6 + 1] = Math.min(255, Math.max(0, cG | 0));
    colColor[x * 6 + 2] = Math.min(255, Math.max(0, cB | 0));
    colColor[x * 6 + 3] = Math.min(255, Math.max(0, (cR + fl) | 0));
    colColor[x * 6 + 4] = Math.min(255, Math.max(0, (cG + fl) | 0));
    colColor[x * 6 + 5] = Math.min(255, Math.max(0, (cB + fl) | 0));
    // blue waveform
    const bR = 95 - d2 * 1.0;
    const bG = 95 - d2 * 0.5;
    const bB = 95 - d2 * 0.25;
    colBlues[x * 6 + 0] = Math.min(255, Math.max(0, bR | 0));
    colBlues[x * 6 + 1] = Math.min(255, Math.max(0, bG | 0));
    colBlues[x * 6 + 2] = Math.min(255, Math.max(0, bB | 0));
    colBlues[x * 6 + 3] = Math.min(255, Math.max(0, (bR + fl) | 0));
    colBlues[x * 6 + 4] = Math.min(255, Math.max(0, (bG + fl) | 0));
    colBlues[x * 6 + 5] = Math.min(255, Math.max(0, (bB + fl) | 0));
  }
  return { type: "PWV4", numEntries, heights, colColor, colBlues };
}

function decodePWV5(view, contentOffset, lenHeader, lenTag) {
  // PWV5 — Color Waveform Detail, 2 bytes per entry, typically ~50K entries
  // Header: len_entry_bytes(4)=2, len_entries(4), unknown(4)
  const lenEntryBytes = readUint32BE(view, contentOffset);
  const numEntries = readUint32BE(view, contentOffset + 4);
  if (lenEntryBytes !== 2) {
    console.warn("PWV5 unexpected len_entry_bytes=" + lenEntryBytes);
  }
  const entStart = contentOffset + (lenHeader - 12);
  const heights = new Float32Array(numEntries);
  const colors = new Uint8Array(numEntries * 3);
  // Bit layout per pyrekordbox:
  //   bit:  f e d c | b a 9 | 8 7 6 | 5 4 3 2 1 | 0
  //         red(3)  | grn(3)| blu(3)| height(5) | (2 zero)
  //   rmask = 0xE000, shift >> 12 (gives 0-14, even values)
  //   gmask = 0x1C00, shift >> 10 (gives 0-7)
  //   bmask = 0x0380, shift >> 7  (gives 0-7)
  //   hmask = 0x007C, shift >> 2  (gives 0-31)
  for (let i = 0; i < numEntries; i++) {
    const off = entStart + i * 2;
    if (off + 2 > view.byteLength) break;
    const x = readUint16BE(view, off);
    const r = (x & 0xE000) >>> 12;
    const g = (x & 0x1C00) >>> 10;
    const b = (x & 0x0380) >>> 7;
    const h = (x & 0x007C) >>> 2;
    heights[i] = h / 31;
    colors[i * 3 + 0] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }
  return { type: "PWV5", numEntries, heights, colors };
}

// ── Main parse ───────────────────────────────────────────────────────────

/** Parse an ANLZ file. Input: ArrayBuffer or Uint8Array. */
export function parseAnlz(buffer) {
  let bytes;
  if (buffer instanceof ArrayBuffer) bytes = new Uint8Array(buffer);
  else if (buffer instanceof Uint8Array) bytes = buffer;
  else throw new Error("parseAnlz expects ArrayBuffer or Uint8Array");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // File header
  const headerType = readAscii(view, 0, 4);
  if (headerType !== FILE_HEADER_TYPE) {
    throw new Error("Not an ANLZ file: header type='" + headerType + "', expected " + FILE_HEADER_TYPE);
  }
  const fileLenHeader = readUint32BE(view, 4);
  const fileLenFile = readUint32BE(view, 8);

  const tags = [];
  const unknownTags = [];
  let offset = fileLenHeader;
  while (offset < fileLenFile && offset + 12 <= view.byteLength) {
    const tagType = readAscii(view, offset, 4);
    const tagLenHeader = readUint32BE(view, offset + 4);
    const tagLenTag = readUint32BE(view, offset + 8);
    const contentOffset = offset + 12;
    let parsed = null;
    try {
      switch (tagType) {
        case "PPTH": parsed = decodePPTH(view, contentOffset, tagLenHeader, tagLenTag); break;
        case "PQTZ": parsed = decodePQTZ(view, contentOffset, tagLenHeader, tagLenTag); break;
        case "PQT2": parsed = decodePQT2(view, contentOffset, tagLenHeader, tagLenTag); break;
        case "PCOB": parsed = decodePCOB(view, contentOffset, tagLenHeader, tagLenTag); break;
        case "PCO2": parsed = decodePCO2(view, contentOffset, tagLenHeader, tagLenTag); break;
        case "PWV4": parsed = decodePWV4(view, contentOffset, tagLenHeader, tagLenTag); break;
        case "PWV5": parsed = decodePWV5(view, contentOffset, tagLenHeader, tagLenTag); break;
        // Phase-1 stubs — recognized but not decoded. Will be implemented later.
        case "PWV3": parsed = { type: "PWV3", _stub: true, lenTag: tagLenTag }; break;
        case "PSSI": parsed = { type: "PSSI", _stub: true, lenTag: tagLenTag }; break;
        case "PWAV":
        case "PWV2":
        case "PVBR":
          parsed = { type: tagType, _stub: true, lenTag: tagLenTag };
          break;
        default:
          unknownTags.push({ type: tagType, lenHeader: tagLenHeader, lenTag: tagLenTag });
      }
    } catch (e) {
      console.warn("Error decoding tag " + tagType + ": " + e.message);
    }
    if (parsed) tags.push(parsed);
    offset += tagLenTag;
    if (tagLenTag === 0) break; // safety
  }

  return { tags, unknownTags, fileLenHeader, fileLenFile };
}

/** Helper: merge cues from PCOB + PCO2 into a single list, preferring PCO2 (has color + label). */
export function mergeCues(parseResult) {
  const pco2s = parseResult.tags.filter(t => t.type === "PCO2");
  const pcobs = parseResult.tags.filter(t => t.type === "PCOB");
  const out = [];
  // PCO2 first (richer)
  for (const t of pco2s) {
    for (const e of t.entries) out.push({ source: "PCO2", ...e });
  }
  // PCOB only for slots not already covered by PCO2 (PCOB is legacy)
  const seen = new Set(out.map(c => c.kind + "/" + c.hotCueSlot + "/" + c.timeMs));
  for (const t of pcobs) {
    for (const e of t.entries) {
      const key = e.kind + "/" + e.hotCueSlot + "/" + e.timeMs;
      if (seen.has(key)) continue;
      out.push({ source: "PCOB", ...e });
      seen.add(key);
    }
  }
  // Sort by time
  out.sort((a, b) => a.timeMs - b.timeMs);
  return out;
}
