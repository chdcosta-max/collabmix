// rekordbox-sqlcipher.js — decrypt Rekordbox 6/7's SQLCipher-encrypted
// master.db to a plain SQLite buffer using Web Crypto API. Pure browser
// code, no external deps. Also runs in Node (Node 19+ has Web Crypto via
// globalThis.crypto).
//
// SQLCipher v4 format (default settings, matches Rekordbox):
//   page size:     4096
//   reserved bytes per page: 80 (16-byte IV + 64-byte HMAC-SHA512)
//   KDF (cipher):  PBKDF2-HMAC-SHA512, 256,000 iterations, 32-byte AES-256 key
//   KDF (hmac):    PBKDF2-HMAC-SHA512, 2 iterations, 32-byte HMAC key,
//                  input = cipher key, salt = encryption salt XOR 0x3a
//   cipher:        AES-256-CBC
//   HMAC:          HMAC-SHA512 over (ciphertext || iv || pgno_le32), full 64-byte output
//   file structure:
//     bytes 0..15 = salt (cleartext, used for KDF)
//     remaining = pages of 4096 bytes each
//   per-page layout:
//     bytes 0..4015        = ciphertext (4016 bytes; for page 1, bytes 0..15 are salt cleartext)
//     bytes 4016..4031     = IV (16 bytes)
//     bytes 4032..4095     = HMAC-SHA512 (64 bytes)
//   page 1 special case:
//     bytes 0..15 = salt (cleartext, NOT encrypted, included in HMAC but excluded from AES decrypt)
//     bytes 16..4015 = AES-CBC encrypted (this is page 1's "data" area, 4000 bytes)
//     after decryption, bytes 0..15 must be replaced with the SQLite magic
//     "SQLite format 3\0"
//
// The Rekordbox SQLCipher passphrase is a 64-char hex string obtained by
// deobfuscating a constant. The deobfuscation is base85-decode → XOR with
// a key → zlib-inflate → utf-8 decode.

// ── BLOB constants from pyrekordbox (public knowledge, MIT-licensed) ──
const BLOB_KEY_STR = "657f48f84c437cc1";
const BLOB_STR = "PN_Pq^*N>(JYe*u^8;Yg76HuZ<mR13S?=>)b9;DpoTXV(6ItkU`}8*m6tx_I{Solh_N#dfe{v=";

// ── Python-style base85 decoder ──
// Alphabet: '0-9A-Za-z!#$%&()*+-;<=>?@^_`{|}~'
const B85_ALPHA = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~";
const B85_DECODE = new Uint8Array(256).fill(255);
for (let i = 0; i < B85_ALPHA.length; i++) B85_DECODE[B85_ALPHA.charCodeAt(i)] = i;

function b85decode(str) {
  // Strip whitespace; if not a multiple of 5, pad with '~' (max value).
  const cleaned = str.replace(/\s/g, "");
  const padCount = (5 - (cleaned.length % 5)) % 5;
  const padded = cleaned + "~".repeat(padCount);
  const outBytes = new Uint8Array((padded.length / 5) * 4);
  let outI = 0;
  for (let i = 0; i < padded.length; i += 5) {
    let v = 0;
    for (let j = 0; j < 5; j++) {
      const d = B85_DECODE[padded.charCodeAt(i + j)];
      if (d === 255) throw new Error("Invalid base85 char at offset " + (i + j));
      v = v * 85 + d;
    }
    outBytes[outI++] = (v >>> 24) & 0xff;
    outBytes[outI++] = (v >>> 16) & 0xff;
    outBytes[outI++] = (v >>> 8) & 0xff;
    outBytes[outI++] = v & 0xff;
  }
  // Trim padding bytes from the result
  return padCount > 0 ? outBytes.subarray(0, outBytes.length - padCount) : outBytes;
}

// ── zlib decompress via DecompressionStream (both browser and Node 18+) ──
async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  const reader = stream.getReader();
  const chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// ── Resolve the SQLCipher passphrase ──
let _cachedPassphrase = null;
export async function getRekordboxPassphrase() {
  if (_cachedPassphrase) return _cachedPassphrase;
  const blob = b85decode(BLOB_STR);
  const key = new TextEncoder().encode(BLOB_KEY_STR);
  const xored = new Uint8Array(blob.length);
  for (let i = 0; i < blob.length; i++) xored[i] = blob[i] ^ key[i % key.length];
  const inflated = await inflate(xored);
  const passphrase = new TextDecoder("utf-8").decode(inflated);
  _cachedPassphrase = passphrase;
  return passphrase;
}

// ── SQLCipher v4 decryption ──
const PAGE_SIZE = 4096;
const IV_SIZE = 16;
const HMAC_SIZE = 64;            // HMAC-SHA512 full output
const RESERVED = IV_SIZE + HMAC_SIZE;        // 80
const DATA_PER_PAGE = PAGE_SIZE - RESERVED;  // 4016
const KDF_ITER = 256000;
const FAST_KDF_ITER = 2;
const KEY_SIZE = 32;
const HMAC_SALT_MASK = 0x3a;

function utf8(s) { return new TextEncoder().encode(s); }

async function deriveKeys(passphraseStr, salt) {
  // Replicates SQLCipher v4: PBKDF2-HMAC-SHA512 (256000 iter) over utf-8
  // passphrase bytes for the cipher key; then PBKDF2-HMAC-SHA512 (2 iter)
  // over the cipher key with salt = encryption_salt XOR 0x3a for HMAC key.
  const passBytes = utf8(passphraseStr);
  const baseKey = await crypto.subtle.importKey(
    "raw", passBytes, { name: "PBKDF2" }, false, ["deriveBits"],
  );
  const cipherKeyBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: KDF_ITER, hash: "SHA-512" },
    baseKey,
    KEY_SIZE * 8,
  );
  const cipherKey = new Uint8Array(cipherKeyBits);

  // HMAC key: derive from cipher key with masked salt (encryption salt XOR 0x3a)
  const hmacSalt = new Uint8Array(salt.length);
  for (let i = 0; i < salt.length; i++) hmacSalt[i] = salt[i] ^ HMAC_SALT_MASK;
  const cipherKeyKdf = await crypto.subtle.importKey(
    "raw", cipherKey, { name: "PBKDF2" }, false, ["deriveBits"],
  );
  const hmacKeyBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hmacSalt, iterations: FAST_KDF_ITER, hash: "SHA-512" },
    cipherKeyKdf,
    KEY_SIZE * 8,
  );
  const hmacKey = new Uint8Array(hmacKeyBits);

  return { cipherKey, hmacKey };
}

/** Decrypt a SQLCipher v4 file (Uint8Array → Uint8Array of plain SQLite).
 *  Throws if the file isn't valid SQLCipher v4 with the given passphrase.
 */
export async function decryptSqlCipher(fileBytes, passphraseStr, opts = {}) {
  if (!(fileBytes instanceof Uint8Array)) throw new Error("expect Uint8Array");
  if (fileBytes.length < PAGE_SIZE) throw new Error("file too small");
  if (fileBytes.length % PAGE_SIZE !== 0) {
    throw new Error("file size " + fileBytes.length + " is not a multiple of " + PAGE_SIZE);
  }
  const verifyHmac = opts.verifyHmac !== false;  // default ON

  const salt = fileBytes.subarray(0, 16);
  const { cipherKey, hmacKey } = await deriveKeys(passphraseStr, salt);

  // Import keys for repeated use. We need BOTH encrypt+decrypt usages on the
  // AES key because the "no-padding" CBC trick requires us to compute a
  // synthetic encrypted padding block per page.
  const aesKey = await crypto.subtle.importKey(
    "raw", cipherKey, { name: "AES-CBC" }, false, ["decrypt"],
  );
  const aesEncKey = await crypto.subtle.importKey(
    "raw", cipherKey, { name: "AES-CBC" }, false, ["encrypt"],
  );
  const hmacKeyImported = verifyHmac
    ? await crypto.subtle.importKey(
        "raw", hmacKey, { name: "HMAC", hash: "SHA-512" }, false, ["sign"],
      )
    : null;

  const numPages = fileBytes.length / PAGE_SIZE;
  const out = new Uint8Array(fileBytes.length);

  for (let p = 0; p < numPages; p++) {
    const pageOff = p * PAGE_SIZE;
    const page = fileBytes.subarray(pageOff, pageOff + PAGE_SIZE);
    const pageNo = p + 1; // SQLCipher pages are 1-indexed

    // For page 1, the first 16 bytes are salt (cleartext, present in the
    // page data and INCLUDED in the HMAC but EXCLUDED from AES decrypt).
    // For other pages, the entire 4016-byte data area is ciphertext.
    const dataStart = (p === 0) ? 16 : 0;
    const ciphertext = page.subarray(dataStart, DATA_PER_PAGE);
    const iv = page.subarray(DATA_PER_PAGE, DATA_PER_PAGE + IV_SIZE);
    const hmacStored = page.subarray(DATA_PER_PAGE + IV_SIZE, PAGE_SIZE);

    // Verify HMAC (HMAC-SHA512 over ciphertext || iv || pgno_le32).
    // For page 1, "ciphertext" here is bytes 16..4015 (4000 bytes — salt
    // is excluded from HMAC input per SQLCipher's page-1 handling).
    if (verifyHmac) {
      const macInput = new Uint8Array(ciphertext.length + IV_SIZE + 4);
      macInput.set(ciphertext, 0);
      macInput.set(iv, ciphertext.length);
      // page number as little-endian uint32 (SQLCipher default)
      const pn = macInput.length - 4;
      macInput[pn]     = pageNo & 0xff;
      macInput[pn + 1] = (pageNo >>> 8) & 0xff;
      macInput[pn + 2] = (pageNo >>> 16) & 0xff;
      macInput[pn + 3] = (pageNo >>> 24) & 0xff;
      const macOut = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKeyImported, macInput));
      // Constant-time-ish compare on the full 64-byte HMAC
      let mismatch = 0;
      for (let i = 0; i < HMAC_SIZE; i++) mismatch |= macOut[i] ^ hmacStored[i];
      if (mismatch !== 0) {
        throw new Error("HMAC mismatch on page " + pageNo + " (wrong passphrase or corrupt file)");
      }
    }

    const decrypted = await aesCbcDecryptRawWC(ciphertext, aesKey, aesEncKey, iv);

    if (p === 0) {
      // Page 1: prepend the SQLite magic header (16 bytes that SQLCipher
      // replaced with the salt). The standard SQLite file magic is
      // "SQLite format 3\0".
      const magic = utf8("SQLite format 3\0");
      out.set(magic, 0);
      out.set(decrypted, 16);
    } else {
      out.set(decrypted, pageOff);
    }
    // Zero out the IV + HMAC reserved area (Web Crypto's output won't
    // touch it; out was allocated with zeros)
  }

  return out;
}

// ── Web Crypto AES-256-CBC, no padding (raw mode) ──
// Web Crypto's AES-CBC validates PKCS#7 padding. SQLCipher pages have NO
// padding (data area is exactly N×16 bytes). To use Web Crypto for the
// raw decryption, we generate a synthetic "padded final block" that, when
// appended to the real ciphertext, decrypts to a valid PKCS#7 padding of
// "16 × 0x10". Web Crypto strips those 16 bytes from the output, leaving
// only the real plaintext.
//
// Synthesizing the block: it's AES-CBC encryption of `[0x10] × 16` using
// the LAST 16 bytes of real ciphertext as IV. (Web Crypto's encrypt also
// applies PKCS#7, producing 32 bytes; the first 16 are what we need.)
async function aesCbcDecryptRawWC(ciphertext, aesDecKey, aesEncKey, iv) {
  if (ciphertext.length % 16 !== 0) throw new Error("ciphertext not multiple of 16");
  if (ciphertext.length === 0) return new Uint8Array(0);
  // Synthesize the padding block
  const lastBlock = ciphertext.subarray(ciphertext.length - 16);
  const pad = new Uint8Array(16);
  pad.fill(0x10);
  const synthOut = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-CBC", iv: lastBlock }, aesEncKey, pad)
  );
  // synthOut[0..15] is AES-CBC(pad) with our IV. That's our synthetic block.
  // Concatenate real ciphertext + synthetic block, decrypt, get plaintext + dropped padding.
  const combined = new Uint8Array(ciphertext.length + 16);
  combined.set(ciphertext, 0);
  combined.set(synthOut.subarray(0, 16), ciphertext.length);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, aesDecKey, combined);
  return new Uint8Array(plainBuf);
}

// ── Pure-JS AES-256-CBC decrypt (UNUSED — kept as a reference). ──

// AES tables. Generated at startup.
const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
const RCON = new Uint8Array([0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36]);

(function initAesTables() {
  // Compute S-box via Rijndael GF(2^8) inversion + affine transform.
  function mulGF(a, b) {
    let p = 0;
    for (let i = 0; i < 8; i++) {
      if (b & 1) p ^= a;
      const hi = a & 0x80;
      a = (a << 1) & 0xff;
      if (hi) a ^= 0x1b;
      b >>= 1;
    }
    return p;
  }
  function inv(a) {
    if (a === 0) return 0;
    // Search; tiny table, fine
    for (let i = 1; i < 256; i++) if (mulGF(a, i) === 1) return i;
    return 0;
  }
  for (let i = 0; i < 256; i++) {
    let x = inv(i);
    let s = x;
    for (let j = 0; j < 4; j++) {
      x = ((x << 1) | (x >> 7)) & 0xff;
      s ^= x;
    }
    s ^= 0x63;
    SBOX[i] = s;
    INV_SBOX[s] = i;
  }
})();

function keyExpansion256(key) {
  // 14 rounds × 16 bytes = 224 bytes of round key (15 × 16 actually)
  const Nk = 8, Nr = 14, Nb = 4;
  const totalWords = Nb * (Nr + 1); // 60 words
  const w = new Uint32Array(totalWords);
  for (let i = 0; i < Nk; i++) {
    w[i] = (key[4*i] << 24) | (key[4*i+1] << 16) | (key[4*i+2] << 8) | key[4*i+3];
  }
  for (let i = Nk; i < totalWords; i++) {
    let temp = w[i - 1];
    if (i % Nk === 0) {
      // RotWord + SubWord + Rcon
      temp = ((temp << 8) | (temp >>> 24)) >>> 0;
      temp = ((SBOX[(temp >>> 24) & 0xff] << 24) |
              (SBOX[(temp >>> 16) & 0xff] << 16) |
              (SBOX[(temp >>> 8) & 0xff] << 8) |
              (SBOX[temp & 0xff])) >>> 0;
      temp ^= RCON[(i / Nk) - 1] << 24;
    } else if (Nk > 6 && (i % Nk) === 4) {
      // SubWord
      temp = ((SBOX[(temp >>> 24) & 0xff] << 24) |
              (SBOX[(temp >>> 16) & 0xff] << 16) |
              (SBOX[(temp >>> 8) & 0xff] << 8) |
              (SBOX[temp & 0xff])) >>> 0;
    }
    w[i] = (w[i - Nk] ^ temp) >>> 0;
  }
  return w;
}

function invMixColumn(s) {
  // s is array of 4 bytes; returns 4-byte mixed column
  const a0 = s[0], a1 = s[1], a2 = s[2], a3 = s[3];
  function gm(a, b) {
    let p = 0;
    for (let i = 0; i < 8; i++) {
      if (b & 1) p ^= a;
      const hi = a & 0x80;
      a = (a << 1) & 0xff;
      if (hi) a ^= 0x1b;
      b >>= 1;
    }
    return p;
  }
  return [
    gm(a0, 0x0e) ^ gm(a1, 0x0b) ^ gm(a2, 0x0d) ^ gm(a3, 0x09),
    gm(a0, 0x09) ^ gm(a1, 0x0e) ^ gm(a2, 0x0b) ^ gm(a3, 0x0d),
    gm(a0, 0x0d) ^ gm(a1, 0x09) ^ gm(a2, 0x0e) ^ gm(a3, 0x0b),
    gm(a0, 0x0b) ^ gm(a1, 0x0d) ^ gm(a2, 0x09) ^ gm(a3, 0x0e),
  ];
}

function aesDecryptBlock(state, w) {
  // state: Uint8Array of 16 bytes (modified in place)
  const Nr = 14;
  // AddRoundKey (last round key)
  for (let c = 0; c < 4; c++) {
    const rk = w[(Nr * 4) + c];
    state[c*4]   ^= (rk >>> 24) & 0xff;
    state[c*4+1] ^= (rk >>> 16) & 0xff;
    state[c*4+2] ^= (rk >>> 8) & 0xff;
    state[c*4+3] ^= rk & 0xff;
  }
  for (let round = Nr - 1; round >= 0; round--) {
    // InvShiftRows + InvSubBytes (combined)
    // state is column-major: byte at [c*4 + r] is row r, col c
    const t = new Uint8Array(16);
    // For each (r,c), the byte at (r, c) in the output came from (r, (c+r) mod 4)
    // in the input (because InvShiftRows rotates row r RIGHT by r positions).
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        t[c*4 + r] = INV_SBOX[state[((c + r) % 4) * 4 + r]];
      }
    }
    state.set(t);
    // AddRoundKey
    for (let c = 0; c < 4; c++) {
      const rk = w[(round * 4) + c];
      state[c*4]   ^= (rk >>> 24) & 0xff;
      state[c*4+1] ^= (rk >>> 16) & 0xff;
      state[c*4+2] ^= (rk >>> 8) & 0xff;
      state[c*4+3] ^= rk & 0xff;
    }
    if (round > 0) {
      // InvMixColumns
      const out = new Uint8Array(16);
      for (let c = 0; c < 4; c++) {
        const col = [state[c*4], state[c*4+1], state[c*4+2], state[c*4+3]];
        const mc = invMixColumn(col);
        out[c*4]   = mc[0];
        out[c*4+1] = mc[1];
        out[c*4+2] = mc[2];
        out[c*4+3] = mc[3];
      }
      state.set(out);
    }
  }
}

async function aesCbcDecryptRaw(ciphertext, keyBytes, iv) {
  // Returns plaintext of same length as ciphertext (no PKCS#7 stripping).
  if (ciphertext.length % 16 !== 0) throw new Error("ciphertext not multiple of 16");
  const w = keyExpansion256(keyBytes);
  const out = new Uint8Array(ciphertext.length);
  let prevC = iv;
  for (let off = 0; off < ciphertext.length; off += 16) {
    const block = new Uint8Array(ciphertext.subarray(off, off + 16));
    const blockCopy = new Uint8Array(block); // save ciphertext for XOR
    aesDecryptBlock(block, w);
    for (let i = 0; i < 16; i++) out[off + i] = block[i] ^ prevC[i];
    prevC = blockCopy;
  }
  return out;
}

// Export for testing
export const _internal = { b85decode, inflate, aesCbcDecryptRaw, keyExpansion256, aesDecryptBlock };
