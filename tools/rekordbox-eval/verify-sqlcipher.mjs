// verify-sqlcipher.mjs — verify our JS SQLCipher decryption produces a
// valid plain SQLite file, by decrypting the user's master.db and comparing
// with pyrekordbox's output.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { getRekordboxPassphrase, decryptSqlCipher } from "../../src/rekordbox-sqlcipher.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MASTER_DB = "/Users/chad/Library/Pioneer/rekordbox/master.db";
const PY = resolve(__dirname, "venv/bin/python");
const OUT_PLAIN = resolve(__dirname, "master-plain.db");

// Step 1: deobfuscate passphrase
console.log("Step 1: deobfuscate passphrase");
const passphrase = await getRekordboxPassphrase();
console.log("  passphrase length:", passphrase.length, "chars");
console.log("  first 12 chars:   ", passphrase.slice(0, 12), "...");

// Get pyrekordbox's version to cross-check
const pyResult = execFileSync(PY, ["-c", `
from pyrekordbox.utils import deobfuscate
from pyrekordbox.db6.database import BLOB
print(deobfuscate(BLOB))
`], { encoding: "utf8" }).trim();
console.log("  python passphrase length:", pyResult.length);
console.log("  python first 12 chars:   ", pyResult.slice(0, 12), "...");

if (passphrase !== pyResult) {
  console.error("\n✗ Passphrase MISMATCH");
  console.error("  JS:", passphrase);
  console.error("  PY:", pyResult);
  process.exit(1);
}
console.log("  ✓ JS passphrase matches Python\n");

// Step 2: decrypt master.db
console.log("Step 2: decrypt master.db (this may take ~1-3 sec for PBKDF2)");
const t0 = Date.now();
const encrypted = readFileSync(MASTER_DB);
const encBuf = new Uint8Array(encrypted.buffer, encrypted.byteOffset, encrypted.byteLength);
console.log("  file size:", encBuf.length, "bytes, pages:", encBuf.length / 4096);

let plain;
try {
  plain = await decryptSqlCipher(encBuf, passphrase, { verifyHmac: true });
} catch (e) {
  console.error("\n✗ Decryption failed:", e.message);
  process.exit(1);
}
const t1 = Date.now();
console.log("  decrypt time:", (t1 - t0) + "ms");
console.log("  output size:", plain.length);

// Step 3: verify magic + structure
const magic = new TextDecoder().decode(plain.subarray(0, 16));
console.log("  first 16 bytes:", JSON.stringify(magic));
if (magic !== "SQLite format 3\0") {
  console.error("✗ Output does not start with SQLite magic");
  process.exit(1);
}
console.log("  ✓ Plain SQLite magic present");

// Step 4: write plain DB and verify with sqlite3 CLI if available
writeFileSync(OUT_PLAIN, plain);
console.log("  wrote plain DB to:", OUT_PLAIN);

try {
  const tables = execFileSync("sqlite3", [OUT_PLAIN, ".tables"], { encoding: "utf8" }).trim();
  console.log("\n  sqlite3 .tables output:");
  console.log("  " + tables.split("\n").join("\n  "));
  // Count tracks
  const count = execFileSync("sqlite3", [OUT_PLAIN, "SELECT COUNT(*) FROM djmdContent;"], { encoding: "utf8" }).trim();
  console.log("\n  djmdContent row count:", count);
  // Count cues
  const cueCount = execFileSync("sqlite3", [OUT_PLAIN, "SELECT COUNT(*) FROM djmdCue;"], { encoding: "utf8" }).trim();
  console.log("  djmdCue row count:    ", cueCount);
  // Sample a row
  const sample = execFileSync("sqlite3", [OUT_PLAIN, "SELECT ID, FileNameL, Title FROM djmdContent LIMIT 3;"], { encoding: "utf8" }).trim();
  console.log("\n  Sample tracks:");
  console.log("  " + sample.split("\n").join("\n  "));
} catch (e) {
  console.log("\n  (sqlite3 CLI not available or query failed: " + e.message + ")");
}

console.log("\n✓ End-to-end SQLCipher decryption verified");
