// rekordbox-library.js — orchestrator for the Rekordbox waveform pipeline.
//
// One module ties together:
//   1. showDirectoryPicker → FileSystemDirectoryHandle on the Rekordbox folder
//   2. Decrypt master.db (SQLCipher) → plain SQLite bytes
//   3. sql.js → query djmdContent + djmdCue → in-memory track/cue index
//   4. Lazy ANLZ decode (cached in IndexedDB) → waveform bands for a track
//   5. Match a user-imported File to a Rekordbox track via filename / size
//
// Lifecycle:
//   const lib = await connectRekordboxLibrary();           // ask user to pick folder
//   const match = lib.matchTrack(file);                    // { id, title, ... } or null
//   const bands = await lib.getWaveformBands(match.id);    // {bass, mid, high, dur} or null
//   const cues  = await lib.getCues(match.id);             // sorted hot-cue list
//   lib.disconnect();                                      // release sql.js memory

import { decryptSqlCipher, getRekordboxPassphrase } from "./rekordbox-sqlcipher.js";
import { parseAnlz, mergeCues } from "./rekordbox-anlz.js";

// ── IndexedDB cache for parsed ANLZ blobs ─────────────────────────────────
// Avoids re-parsing the .EXT file on every connect. Keyed by trackId.
const CACHE_DB = "cm_rekordbox_cache";
const CACHE_VER = 1;
const STORE_ANLZ = "anlz";

function hasIndexedDB() {
  return typeof globalThis !== "undefined" && typeof globalThis.indexedDB !== "undefined";
}

function openCache() {
  if (!hasIndexedDB()) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const req = globalThis.indexedDB.open(CACHE_DB, CACHE_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_ANLZ)) {
        db.createObjectStore(STORE_ANLZ, { keyPath: "trackId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function cacheGet(db, trackId) {
  if (!db) return null;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ANLZ, "readonly");
    const req = tx.objectStore(STORE_ANLZ).get(String(trackId));
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function cachePut(db, entry) {
  if (!db) return;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ANLZ, "readwrite");
    tx.objectStore(STORE_ANLZ).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── sql.js loader (lazy, single instance) ─────────────────────────────────
// We do NOT bundle sql.js through Vite — the UMD bundle is huge and forces
// the build to spend minutes transforming an asm.js file. Instead, the JS
// + .wasm live in /public/ and are loaded at runtime:
//   - Browser: <script> tag injection from /sql-wasm.js, then window.initSqlJs
//   - Node:    dynamic import of node_modules/sql.js (lets verify scripts work)
let _sqlJsPromise = null;
async function loadSqlJs() {
  if (_sqlJsPromise) return _sqlJsPromise;
  _sqlJsPromise = (async () => {
    if (typeof window !== "undefined") {
      if (!window.initSqlJs) {
        await new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = "/sql-wasm.js";
          s.async = true;
          s.onload = resolve;
          s.onerror = () => reject(new Error("Failed to load /sql-wasm.js"));
          document.head.appendChild(s);
        });
      }
      return window.initSqlJs({ locateFile: (file) => "/" + file });
    }
    // Node fallback (verify scripts). @vite-ignore so Vite doesn't try to
    // bundle sql.js's UMD asm.js — it stalls the transformer.
    const sqlJsModule = await import(/* @vite-ignore */ "sql.js");
    const initSqlJs = sqlJsModule.default || sqlJsModule;
    return initSqlJs({
      locateFile: (file) =>
        new URL("../node_modules/sql.js/dist/" + file, import.meta.url).pathname,
    });
  })();
  return _sqlJsPromise;
}

// ── Helpers ───────────────────────────────────────────────────────────────
function basename(p) {
  if (!p) return "";
  return String(p).split(/[\\/]/).pop();
}

function normalizeName(s) {
  return String(s || "").toLowerCase().normalize("NFKD")
    .replace(/[^\w\s.-]/g, "").replace(/\s+/g, " ").trim();
}

// Walk down a FileSystemDirectoryHandle following a /-separated path.
// Returns null if any segment is missing.
async function resolvePath(rootHandle, relPath) {
  const parts = relPath.replace(/^\/+/, "").split("/").filter(Boolean);
  let dir = rootHandle;
  for (let i = 0; i < parts.length - 1; i++) {
    try {
      dir = await dir.getDirectoryHandle(parts[i]);
    } catch {
      return null;
    }
  }
  try {
    return await dir.getFileHandle(parts[parts.length - 1]);
  } catch {
    return null;
  }
}

// ── Main entry point ──────────────────────────────────────────────────────
/** Open the Rekordbox library: prompts user for the rekordbox folder,
 *  decrypts master.db, builds the track + cue index in memory.
 *
 *  Returns a `RekordboxLibrary` instance, or throws if the user cancels
 *  or the folder doesn't look like a Rekordbox install.
 */
export async function connectRekordboxLibrary(opts = {}) {
  if (typeof window === "undefined" || !window.showDirectoryPicker) {
    throw new Error("showDirectoryPicker not available — needs Chromium 86+ or Safari 18+");
  }
  const rootHandle = await window.showDirectoryPicker({
    id: "rekordbox",
    mode: "read",
    startIn: "documents",
  });
  return openLibraryFromHandle(rootHandle, opts);
}

/** Same, but with a directory handle the caller already obtained (e.g.,
 *  cached from a previous session). */
export async function openLibraryFromHandle(rootHandle, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  onProgress({ phase: "locate-db" });

  // Find master.db at the root
  let dbHandle;
  try {
    dbHandle = await rootHandle.getFileHandle("master.db");
  } catch {
    throw new Error("master.db not found — pick the Rekordbox folder (typically ~/Library/Pioneer/rekordbox/)");
  }

  onProgress({ phase: "decrypt" });
  const dbFile = await dbHandle.getFile();
  const dbBytes = new Uint8Array(await dbFile.arrayBuffer());
  const passphrase = await getRekordboxPassphrase();
  const plainBytes = await decryptSqlCipher(dbBytes, passphrase, { verifyHmac: true });

  onProgress({ phase: "load-sqljs" });
  const SQL = await loadSqlJs();
  const db = new SQL.Database(plainBytes);

  onProgress({ phase: "build-index" });
  const { contents, cuesById } = queryLibrary(db);

  // Build lookup tables for matching uploaded files
  const byBasename = new Map();   // "filename.mp3" → [trackEntry, ...]
  const byNorm = new Map();       // normalized name → [trackEntry]
  const bySize = new Map();       // fileSize → [trackEntry]
  for (const c of contents) {
    if (c.fileNameL) {
      const k = c.fileNameL.toLowerCase();
      if (!byBasename.has(k)) byBasename.set(k, []);
      byBasename.get(k).push(c);
    }
    const norm = normalizeName(c.fileNameL || c.title);
    if (norm) {
      if (!byNorm.has(norm)) byNorm.set(norm, []);
      byNorm.get(norm).push(c);
    }
    if (c.fileSize) {
      if (!bySize.has(c.fileSize)) bySize.set(c.fileSize, []);
      bySize.get(c.fileSize).push(c);
    }
  }

  onProgress({ phase: "ready", trackCount: contents.length, cueCount: cuesById.size });

  return new RekordboxLibrary({
    rootHandle, db, contents, cuesById, byBasename, byNorm, bySize,
  });
}

// ── Query layer ───────────────────────────────────────────────────────────
function queryLibrary(db) {
  // djmdContent: pick fields we need; skip rb_local_deleted rows
  const contentRes = db.exec(`
    SELECT ID, FolderPath, FileNameL, Title, BPM, Length, FileSize,
           AnalysisDataPath, BitRate, SampleRate
    FROM djmdContent
    WHERE rb_local_deleted = 0
  `);
  const contents = [];
  if (contentRes.length) {
    const cols = contentRes[0].columns;
    for (const row of contentRes[0].values) {
      const r = {};
      for (let i = 0; i < cols.length; i++) r[cols[i]] = row[i];
      contents.push({
        id: String(r.ID),
        folderPath: r.FolderPath || "",
        fileNameL: r.FileNameL || "",
        title: r.Title || "",
        bpm: r.BPM ? r.BPM / 100 : null,        // BPM is stored ×100
        lengthSec: r.Length || null,
        fileSize: r.FileSize || null,
        analysisDataPath: r.AnalysisDataPath || null,  // /PIONEER/USBANLZ/.../ANLZ0000.DAT
        bitRate: r.BitRate || null,
        sampleRate: r.SampleRate || null,
      });
    }
  }

  // djmdCue: bucket by ContentID
  const cuesById = new Map();
  const cueRes = db.exec(`
    SELECT ContentID, InMsec, OutMsec, Kind, Color, ColorTableIndex,
           ActiveLoop, Comment
    FROM djmdCue
    WHERE rb_local_deleted = 0
    ORDER BY ContentID, InMsec
  `);
  if (cueRes.length) {
    const cols = cueRes[0].columns;
    for (const row of cueRes[0].values) {
      const r = {};
      for (let i = 0; i < cols.length; i++) r[cols[i]] = row[i];
      const id = String(r.ContentID);
      const cue = {
        timeMs: r.InMsec || 0,
        endMs: r.OutMsec || 0,
        kind: r.Kind,                  // 0 = memory cue, 1+ = hot cue slot
        color: r.Color,                // legacy color id
        colorTableIndex: r.ColorTableIndex,
        isLoop: !!r.ActiveLoop,
        comment: r.Comment || "",
      };
      if (!cuesById.has(id)) cuesById.set(id, []);
      cuesById.get(id).push(cue);
    }
  }
  return { contents, cuesById };
}

// ── Library instance ──────────────────────────────────────────────────────
class RekordboxLibrary {
  constructor({ rootHandle, db, contents, cuesById, byBasename, byNorm, bySize }) {
    this.rootHandle = rootHandle;
    this._db = db;
    this._contents = contents;
    this._byId = new Map(contents.map(c => [c.id, c]));
    this._cuesById = cuesById;
    this._byBasename = byBasename;
    this._byNorm = byNorm;
    this._bySize = bySize;
    this._cachePromise = null;
    this._parseCache = new Map();    // in-memory: trackId → parsed ANLZ data
  }

  /** Total track count in the connected library. */
  trackCount() { return this._contents.length; }

  /** Get a track entry by Rekordbox ID. */
  getTrack(id) { return this._byId.get(String(id)) || null; }

  /** All tracks (for debug/list). */
  allTracks() { return this._contents.slice(); }

  /** Match a user-uploaded File to a Rekordbox track.
   *
   *  Tries, in order:
   *  1. Exact basename (lowercased) — strongest signal
   *  2. fileSize match
   *  3. Normalized name similarity
   *
   *  Returns the best match or null.
   */
  matchTrack(file) {
    if (!file || !file.name) return null;
    const base = file.name.toLowerCase();
    const size = file.size;

    // (1) Exact basename match
    const baseMatches = this._byBasename.get(base) || [];
    if (baseMatches.length === 1) return baseMatches[0];
    if (baseMatches.length > 1 && size) {
      // Disambiguate by size
      const sizeHit = baseMatches.find(t => t.fileSize === size);
      if (sizeHit) return sizeHit;
      return baseMatches[0];  // still better than nothing
    }
    if (baseMatches.length > 0) return baseMatches[0];

    // (2) Size match (rare unique hit, but precise when available)
    if (size) {
      const sizeMatches = this._bySize.get(size) || [];
      if (sizeMatches.length === 1) return sizeMatches[0];
    }

    // (3) Normalized name match
    const norm = normalizeName(file.name);
    if (norm) {
      const normMatches = this._byNorm.get(norm) || [];
      if (normMatches.length === 1) return normMatches[0];
      if (normMatches.length > 1 && size) {
        const sizeHit = normMatches.find(t => t.fileSize === size);
        if (sizeHit) return sizeHit;
        return normMatches[0];
      }
      if (normMatches.length > 0) return normMatches[0];
    }
    return null;
  }

  /** Get cues for a track, sorted by time. */
  getCues(trackId) {
    return (this._cuesById.get(String(trackId)) || []).slice();
  }

  /** Get parsed ANLZ data for a track. Returns null if no analysis exists
   *  or the .EXT file isn't reachable from the root handle. */
  async getAnlz(trackId) {
    const id = String(trackId);
    if (this._parseCache.has(id)) return this._parseCache.get(id);

    // Try IndexedDB cache first
    if (!this._cachePromise) this._cachePromise = openCache();
    const cacheDb = await this._cachePromise;
    const cached = await cacheGet(cacheDb, id);
    if (cached && cached.parsed) {
      this._parseCache.set(id, cached.parsed);
      return cached.parsed;
    }

    // Locate .EXT file via AnalysisDataPath (replace .DAT → .EXT)
    const track = this._byId.get(id);
    if (!track || !track.analysisDataPath) return null;
    const extPath = track.analysisDataPath.replace(/\.DAT$/i, ".EXT");
    // AnalysisDataPath starts with "/PIONEER/USBANLZ/..." but it's relative
    // to the user's rekordbox/share/ folder. We need to navigate to "share"
    // first.
    const shareRel = extPath.startsWith("/PIONEER")
      ? "share" + extPath
      : extPath.replace(/^\//, "");
    const fileHandle = await resolvePath(this.rootHandle, shareRel);
    if (!fileHandle) return null;

    const file = await fileHandle.getFile();
    const buf = new Uint8Array(await file.arrayBuffer());
    const parsed = parseAnlz(buf);
    // Merge cues from the .DAT file too (older Rekordbox 6 stores PCO2 in .DAT)
    // — but per Phase 1 findings, cues for this library all live in master.db
    // so we don't bother reading the .DAT.

    // Cache to IDB (store parsed object, not raw bytes — saves re-decode cost)
    await cachePut(cacheDb, { trackId: id, parsed, cachedAt: Date.now() });
    this._parseCache.set(id, parsed);
    return parsed;
  }

  /** Get waveform bands for a track in Mix//Sync's render format:
   *    { bass: Float32Array, mid: Float32Array, high: Float32Array,
   *      dur: number, source: "rekordbox" }
   *
   *  PWV5 (color waveform detail) is preferred. Maps the R/G/B color
   *  channels onto bass/high/mid respectively (Pioneer's convention: red =
   *  low frequencies, blue = mid, green = high; in the renderer's bass/mid/high
   *  layout we use bass=R*height, mid=B*height, high=G*height — matches the
   *  Rekordbox color scheme where red kicks dominate the bass band).
   *
   *  Returns null if no .EXT data is reachable. */
  async getWaveformBands(trackId) {
    const parsed = await this.getAnlz(trackId);
    if (!parsed) return null;
    const pwv5 = parsed.tags.find(t => t.type === "PWV5" && !t._stub);
    if (!pwv5) return null;

    const n = pwv5.numEntries;
    const bass = new Float32Array(n);
    const mid = new Float32Array(n);
    const high = new Float32Array(n);
    // PWV5 stores amplitude (height 0..1) plus a spectral color triple
    // (R: 0..14, G: 0..7, B: 0..7). Rekordbox's color convention is
    // R=low, B=mid, G=high. Split the per-pixel amplitude across the
    // renderer's three bands using the color as the weight; if there's
    // no color info (rare, silent sections), put all energy in bass so
    // the existing height calc (0.7 bass + 0.2 mid + 0.1 high) still
    // sees the waveform's shape.
    for (let i = 0; i < n; i++) {
      const h = pwv5.heights[i];
      const r = pwv5.colors[i * 3];
      const g = pwv5.colors[i * 3 + 1];
      const b = pwv5.colors[i * 3 + 2];
      const sum = r + g + b;
      if (sum > 0) {
        bass[i] = h * (r / sum);
        mid[i]  = h * (b / sum);
        high[i] = h * (g / sum);
      } else {
        bass[i] = h;
      }
    }
    const track = this._byId.get(String(trackId));
    return {
      bass, mid, high,
      dur: track?.lengthSec || 0,
      source: "rekordbox",
    };
  }

  /** Release sql.js memory. */
  disconnect() {
    try { this._db.close(); } catch {}
    this._byId.clear();
    this._byBasename.clear();
    this._byNorm.clear();
    this._bySize.clear();
    this._parseCache.clear();
  }
}

// Re-export for convenience
export { RekordboxLibrary };
