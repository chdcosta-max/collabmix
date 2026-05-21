// LAME tag probe — parses the Xing/Info/LAME header of an MP3 to determine:
//   - presence of Xing/Info tag
//   - presence of LAME extension
//   - LAME CRC validity
//   - encoder delay (12-bit) + encoder padding (12-bit)
//
// The four cases from digital-dj-tools/dj-data-converter issue #3:
//   1. No Xing/Info tag                  → no Rekordbox shift
//   2. Xing/Info present, no LAME subtag → Rekordbox shifts +1152 samples (26ms)
//   3. LAME present, CRC invalid         → Rekordbox shifts +1152 samples (26ms)
//   4. LAME present, CRC valid           → no Rekordbox shift
//
// mpg123 (audio-decode) behavior:
//   - Cases 1,2: typically no LAME-padding stripping (audio includes encoder padding)
//   - Cases 3,4: LAME-aware stripping if CRC valid (case 4); fall back if invalid (case 3)
//
// Usage: node lame-tag-probe.mjs <path1.mp3> [path2.mp3 ...]

import { readFileSync } from "node:fs";
import { basename } from "node:path";

// MPEG-1 Layer III bitrate table (kbps) by version, layer, bitrate index.
// We only need MPEG-1 Layer III here.
const BITRATES_MPEG1_L3 = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1,
];
const SAMPLE_RATES_MPEG1 = [44100, 48000, 32000, -1];

function parseFrameHeader(b, off) {
  // 32-bit frame header
  if (b[off] !== 0xff || (b[off + 1] & 0xe0) !== 0xe0) return null;
  const versionId = (b[off + 1] >> 3) & 0x3; // 3 = MPEG-1
  const layer = (b[off + 1] >> 1) & 0x3;     // 1 = layer III
  const bitrateIdx = (b[off + 2] >> 4) & 0xf;
  const srIdx = (b[off + 2] >> 2) & 0x3;
  const padding = (b[off + 2] >> 1) & 0x1;
  const channelMode = (b[off + 3] >> 6) & 0x3; // 0=Stereo,1=JointStereo,2=Dual,3=Mono
  if (versionId !== 3 || layer !== 1) return null; // require MPEG-1 Layer III
  const bitrate = BITRATES_MPEG1_L3[bitrateIdx];
  const sr = SAMPLE_RATES_MPEG1[srIdx];
  if (bitrate <= 0 || sr <= 0) return null;
  const frameLen = Math.floor((144 * bitrate * 1000) / sr) + padding;
  // sideInfo offset: 32 bytes for Mono, 17 for Stereo/Joint/Dual? Actually:
  // MPEG-1 stereo (channelMode != 3): side info length = 32
  // MPEG-1 mono   (channelMode == 3): side info length = 17
  const sideInfoLen = channelMode === 3 ? 17 : 32;
  return { versionId, layer, bitrate, sr, frameLen, padding, channelMode, sideInfoLen };
}

// Skip ID3v2 if present
function skipID3v2(b) {
  if (b.length < 10) return 0;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
    const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
    return 10 + size;
  }
  return 0;
}

// CRC-16/Genibus polynomial (used by LAME tag). Init 0x0000.
// Spec: https://libzplay.sourceforge.net/LAMETAG.html
function crc16Genibus(buf, start, len) {
  let crc = 0x0000;
  for (let i = 0; i < len; i++) {
    crc ^= buf[start + i] << 8;
    for (let bit = 0; bit < 8; bit++) {
      if (crc & 0x8000) crc = (crc << 1) ^ 0x1021;
      else crc <<= 1;
      crc &= 0xffff;
    }
  }
  return crc;
}

function probeMp3(path) {
  const buf = readFileSync(path);
  const total = buf.length;
  let off = skipID3v2(buf);

  // Find first MPEG frame
  let header = null;
  for (let p = off; p < Math.min(off + 65536, total - 4); p++) {
    const h = parseFrameHeader(buf, p);
    if (h) { off = p; header = h; break; }
  }
  if (!header) return { error: "no MPEG-1 Layer III frame found" };

  // Xing/Info/Vbri offset:
  // Frame header = 4 bytes, then side info, then "Xing"/"Info"/"VBRI"
  const tagOff = off + 4 + header.sideInfoLen;
  if (tagOff + 4 > total) return { error: "buffer too short for tag" };
  const tagMagic = buf.slice(tagOff, tagOff + 4).toString("ascii");
  if (tagMagic !== "Xing" && tagMagic !== "Info" && tagMagic !== "VBRI") {
    return {
      firstFrameOffset: off,
      hasXingInfoVbri: false,
      tag: null,
      rekordboxCase: 1, // No tag → no Rekordbox shift
    };
  }

  let lameOff = -1;
  let xingInfoFlags = 0;
  if (tagMagic === "Xing" || tagMagic === "Info") {
    // Layout: "Xing"|"Info" (4) + flags (4 BE) + [frames? 4][bytes? 4][toc? 100][quality? 4]
    xingInfoFlags = buf.readUInt32BE(tagOff + 4);
    let p = tagOff + 8;
    if (xingInfoFlags & 0x1) p += 4; // frames
    if (xingInfoFlags & 0x2) p += 4; // bytes
    if (xingInfoFlags & 0x4) p += 100; // toc
    if (xingInfoFlags & 0x8) p += 4; // quality
    // LAME tag begins at p; spec: 9 bytes encoder version "LAME3.99r" then ...
    if (p + 4 < total && buf.slice(p, p + 4).toString("ascii") === "LAME") {
      lameOff = p;
    }
  } else if (tagMagic === "VBRI") {
    // VBRI is Fraunhofer; no LAME extension
    return {
      firstFrameOffset: off,
      hasXingInfoVbri: true,
      tagType: "VBRI",
      tag: null,
      rekordboxCase: 1, // VBRI → no Xing/LAME → Rekordbox treats like no tag? per dj-data-converter, this is rare
    };
  }

  if (lameOff < 0) {
    return {
      firstFrameOffset: off,
      hasXingInfoVbri: true,
      tagType: tagMagic,
      xingInfoFlags,
      lame: null,
      rekordboxCase: 2, // Xing/Info present, no LAME → Rekordbox shifts +1152
    };
  }

  // LAME tag layout: 36 bytes total
  //   0-8   encoder version (9 bytes)
  //   9     tag revision / VBR method
  //   10    lowpass
  //   11-14 peak signal amplitude
  //   15-16 radio replay gain
  //   17-18 audiophile replay gain
  //   19    encoding flags + ATH type
  //   20    bitrate
  //   21-23 delay (12 bits) + padding (12 bits) - big endian, packed
  //   24    misc
  //   25    mp3 gain
  //   26-27 preset + surround info
  //   28-31 music length
  //   32-33 music CRC
  //   34-35 tag CRC  -- CRC over bytes 0..33 of LAME tag (i.e., the first 190 bytes from the start of the frame header? Let me check)
  // Actually per spec the CRC is over the first 190 bytes from the start of the frame header (Mp3 Info Tag rev1 spec).
  // We'll compute CRC over `firstFrameOffset .. firstFrameOffset+190` and compare to bytes at lameOff+34..35
  const delayPadBuf = buf.slice(lameOff + 21, lameOff + 24);
  const delayPad24 = (delayPadBuf[0] << 16) | (delayPadBuf[1] << 8) | delayPadBuf[2];
  const encDelay = (delayPad24 >> 12) & 0xfff;
  const encPadding = delayPad24 & 0xfff;

  // CRC: bytes 0..189 from start of first MPEG frame (offset `off`)
  // CRC stored at lameOff+34..35 (big-endian 16-bit)
  const crcOff = lameOff + 34;
  const crcStored = (buf[crcOff] << 8) | buf[crcOff + 1];
  const crcComputed = crc16Genibus(buf, off, 190);
  const crcValid = crcStored === crcComputed;

  const encoder = buf.slice(lameOff, lameOff + 9).toString("ascii");

  return {
    firstFrameOffset: off,
    hasXingInfoVbri: true,
    tagType: tagMagic,
    xingInfoFlags,
    lame: {
      offset: lameOff,
      encoderVersion: encoder,
      encDelay,
      encPadding,
      crcStored: crcStored.toString(16).padStart(4, "0"),
      crcComputed: crcComputed.toString(16).padStart(4, "0"),
      crcValid,
    },
    rekordboxCase: crcValid ? 4 : 3, // Case 3: Rekordbox shifts; Case 4: no shift
    expectedRekordboxShiftSamples: crcValid ? 0 : 1152,
    expectedRekordboxShiftMs: crcValid ? 0 : (1152 / 44.1).toFixed(2),
  };
}

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("Usage: node lame-tag-probe.mjs <path1.mp3> [path2.mp3 ...]");
  process.exit(2);
}

for (const path of paths) {
  console.log(`\n── ${basename(path)} ──`);
  try {
    const r = probeMp3(path);
    console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    console.log(`ERROR: ${e.message}`);
  }
}
