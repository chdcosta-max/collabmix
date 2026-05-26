// Shared storage layer for Mix//Sync.
//
// Both apps in this repo (mixer at `/`, standalone library at `/library.html`)
// open the same browser-origin IndexedDB (`cm_music_library`). Before this
// module existed each app inlined its own copy of `openDB / dbPut / dbGet`,
// the two copies drifted (notably the `settings` store keyPath), and a third
// schema dimension — OPFS audio backing — was implemented only in the mixer.
// Net result: tracks imported via `/library.html` could not be loaded by the
// mixer because the `handles` records were written in a shape the mixer's
// permission-check path treated as null. See STORAGE.md for the full history.
//
// All IDB / OPFS / persistence calls in either app must go through this
// module so the schema can't drift again.

// ── Schema version ────────────────────────────────────────────────────────
// v4: original schema, two divergent `settings` keyPath definitions, no
//     normalized handle shape, OPFS used only by the mixer.
// v5: settings store rebuilt with keyPath "key" (unifies both apps), new
//     `migrations` store for one-shot upgrade markers, normalized handle
//     record shape, OPFS used by both apps.
export const CM_DB_NAME = "cm_music_library";
export const CM_DB_VER  = 5;
const OPFS_DIR = "cm_audio";

// ── Open + upgrade ────────────────────────────────────────────────────────
// `versionchange` listener closes the connection when another tab opens the
// DB at a higher version, so the upgrade in that other tab isn't blocked
// forever. Standard pattern; without it, opening `/library.html` and `/`
// during an upgrade hangs the second tab.
let _dbPromise = null;
export function openCmDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(CM_DB_NAME, CM_DB_VER);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      const tx = e.target.transaction;

      // tracks
      if (!db.objectStoreNames.contains("tracks")) {
        const ts = db.createObjectStore("tracks", { keyPath: "id" });
        ts.createIndex("artist",  "artist",  { unique: false });
        ts.createIndex("genre",   "genre",   { unique: false });
        ts.createIndex("energy",  "energy",  { unique: false });
        ts.createIndex("bpm",     "bpm",     { unique: false });
        ts.createIndex("addedAt", "addedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains("crates"))   db.createObjectStore("crates",   { keyPath: "id" });
      if (!db.objectStoreNames.contains("handles"))  db.createObjectStore("handles",  { keyPath: "id" });
      if (!db.objectStoreNames.contains("queue"))    db.createObjectStore("queue",    { keyPath: "trackId" });
      if (!db.objectStoreNames.contains("requests")) db.createObjectStore("requests", { keyPath: "id" });
      // migrations: marker store for one-shot post-upgrade tasks (e.g. lazy
      // handle-shape normalization). Records: { id, ranAt, ...details }.
      if (!db.objectStoreNames.contains("migrations")) db.createObjectStore("migrations", { keyPath: "id" });

      // v4 → v5: settings store had divergent keyPath between the two apps
      // (mixer: none; library-app: "key"). Rebuild with a consistent keyPath.
      // Settings was declared in both apps but never actually written to in
      // the v4 code, so the rebuild has no live data to preserve. We still
      // copy any out-of-line entries forward defensively.
      if (e.oldVersion < 5) {
        if (db.objectStoreNames.contains("settings")) {
          const old = tx.objectStore("settings");
          const carryOver = [];
          old.openCursor().onsuccess = (ev) => {
            const cur = ev.target.result;
            if (cur) {
              const val = cur.value;
              // Normalize: if value already has .key, keep it; else wrap.
              if (val && typeof val === "object" && "key" in val) carryOver.push(val);
              else carryOver.push({ key: String(cur.key), value: val });
              cur.continue();
            } else {
              db.deleteObjectStore("settings");
              const next = db.createObjectStore("settings", { keyPath: "key" });
              for (const item of carryOver) next.put(item);
            }
          };
        } else {
          db.createObjectStore("settings", { keyPath: "key" });
        }
      }
    };
    req.onsuccess = (e) => {
      const db = e.target.result;
      db.onversionchange = () => {
        // Another tab is trying to upgrade — release our v5 connection so
        // their `onupgradeneeded` can proceed.
        try { db.close(); } catch {}
        _dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = (e) => {
      _dbPromise = null;
      reject(e.target.error);
    };
    req.onblocked = () => {
      // Another tab holds an older version open. The user will see this as
      // "library disappeared until I close the other tab." Worth surfacing
      // but not fatal; the upgrade resumes once the other tab closes.
      console.warn("[storage] IDB upgrade blocked — close other Mix//Sync tabs");
    };
  });
  return _dbPromise;
}

// ── Generic IDB helpers ───────────────────────────────────────────────────
export async function dbGet(store, key) {
  const db = await openCmDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readonly");
    const r = tx.objectStore(store).get(key);
    r.onsuccess = (e) => res(e.target.result);
    r.onerror   = (e) => rej(e.target.error);
  });
}
export async function dbGetAll(store) {
  const db = await openCmDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readonly");
    const r = tx.objectStore(store).getAll();
    r.onsuccess = (e) => res(e.target.result);
    r.onerror   = (e) => rej(e.target.error);
  });
}
export async function dbPut(store, item) {
  const db = await openCmDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    const r = tx.objectStore(store).put(item);
    r.onsuccess = () => res();
    r.onerror   = (e) => rej(e.target.error);
  });
}
export async function dbDelete(store, key) {
  const db = await openCmDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    const r = tx.objectStore(store).delete(key);
    r.onsuccess = () => res();
    r.onerror   = (e) => rej(e.target.error);
  });
}
export async function dbClear(store) {
  const db = await openCmDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    const r = tx.objectStore(store).clear();
    r.onsuccess = () => res();
    r.onerror   = (e) => rej(e.target.error);
  });
}

// ── Normalized handles store ──────────────────────────────────────────────
// Canonical record shape (v5+):
//   { id, handle?: FileSystemFileHandle, opfsBacked?: boolean, file?: File (legacy) }
// Readers should call `resolveHandleRecord(rec)` to get back a uniform
// `{ file?: File, handle?: FileSystemFileHandle }` regardless of which legacy
// shape was on disk.
export async function putHandle(id, handle) {
  const db = await openCmDB();
  return new Promise((res, rej) => {
    const tx = db.transaction("handles", "readwrite");
    tx.objectStore("handles").put({ id, handle });
    tx.oncomplete = () => res();
    tx.onerror    = (e) => rej(e.target.error);
  });
}
export async function getHandleRecord(id) {
  return dbGet("handles", id);
}
// Tolerant reader: returns { handle?, file?, opfsBacked } regardless of which
// legacy record shape is on disk. Three shapes exist in the wild:
//   - { id, handle: FileSystemFileHandle }   (library-app folder-scan path)
//   - { id, file: File }                     (library-app <input> path; legacy)
//   - { id }                                  (mixer pre-v5; handle was lost
//                                              during put due to a spread-on-
//                                              non-plain-object bug)
// Lazy migration rewrites all three into { id, handle?, opfsBacked: true }
// over time, but until that completes consumers should call this helper.
export function resolveHandleRecord(rec) {
  if (!rec) return null;
  const out = { handle: null, file: null, opfsBacked: !!rec.opfsBacked };
  if (rec.handle && typeof rec.handle.queryPermission === "function") {
    out.handle = rec.handle;
  } else if (rec.file && typeof rec.file.arrayBuffer === "function") {
    out.file = rec.file;
  }
  return out;
}

// ── OPFS — audio backing store, single source of truth for the bytes ─────
export async function opfsStore(trackId, file) {
  const root = await navigator.storage.getDirectory();
  const dir  = await root.getDirectoryHandle(OPFS_DIR, { create: true });
  const fh   = await dir.getFileHandle(trackId, { create: true });
  const wr   = await fh.createWritable();
  await wr.write(file);
  await wr.close();
  return true;
}
export async function opfsGet(trackId) {
  try {
    const root = await navigator.storage.getDirectory();
    const dir  = await root.getDirectoryHandle(OPFS_DIR, { create: false });
    const fh   = await dir.getFileHandle(trackId);
    return await fh.getFile();
  } catch { return null; }
}
export async function opfsDelete(trackId) {
  try {
    const root = await navigator.storage.getDirectory();
    const dir  = await root.getDirectoryHandle(OPFS_DIR, { create: false });
    await dir.removeEntry(trackId);
  } catch {}
}
export async function opfsClear() {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(OPFS_DIR, { recursive: true });
  } catch {}
}

// ── Persistence — request "won't be evicted" tier from the browser ───────
// Idempotent. Safe to call at every app mount: if already persisted, the
// query is a fast no-op. Returns one of:
//   "persisted"      — storage is on the durable tier
//   "denied"         — browser denied the request (Safari, private mode, etc.)
//   "unsupported"    — API not available (very old browsers, some embedded
//                      WebViews); caller should surface a backup-prompt
// Sites should also offer the JSON export as a manual safety net for the
// "denied" / "unsupported" cases.
export async function ensurePersistentStorage() {
  if (!navigator.storage || typeof navigator.storage.persist !== "function") {
    return "unsupported";
  }
  try {
    const already = await navigator.storage.persisted();
    if (already) return "persisted";
    const granted = await navigator.storage.persist();
    return granted ? "persisted" : "denied";
  } catch {
    return "denied";
  }
}

// ── Migration markers ─────────────────────────────────────────────────────
export async function hasMigrationRun(id) {
  const rec = await dbGet("migrations", id);
  return !!rec;
}
export async function markMigrationRun(id, details = {}) {
  return dbPut("migrations", { id, ranAt: Date.now(), ...details });
}

// ── Lazy handle-shape migration (v4 → v5) ─────────────────────────────────
// One-shot, idempotent, runs at idle time after each app's mount. Walks the
// `handles` store and normalizes legacy record shapes:
//
//   { id, file: File }            (library-app <input> path):
//     → copy File to OPFS, rewrite as { id, handle: null, opfsBacked: true }
//   { id }  (orphan — mixer pre-v5 cmDbPutHandle wrote {id, ...handle} which
//                     silently dropped the handle field. Bytes may still exist
//                     in OPFS if the user previously deck-loaded the track):
//     → if OPFS has bytes, rewrite as { id, handle: null, opfsBacked: true }.
//     → if not, mark as { id, handle: null, needsReconnect: true } so the UI
//       can surface a re-pick prompt without silently failing.
//   { id, handle: FileSystemFileHandle }    (library-app folder-scan path):
//     → unchanged. Already canonical.
//   { id: "scan_dir" | "itunes_file" | "rb_dir" | "rb_file", handle: ... }
//     → these are FOLDER / SETTINGS handles, not per-track. Skipped.
//
// Yields between records via requestIdleCallback so it doesn't compete with
// the app's mount-time work. Tab-close partway is safe: the migration marker
// is only written on completion, so the next launch restarts. Normalized
// records are skipped on every pass (no-op for them), so restart is cheap.
const MIGRATION_ID = "handles_v4_to_v5";
const SETTINGS_HANDLE_IDS = new Set(["scan_dir", "itunes_file", "rb_dir", "rb_file"]);

export async function runHandleMigration() {
  if (await hasMigrationRun(MIGRATION_ID)) return { skipped: true };
  const all = await dbGetAll("handles");
  const todo = all.filter(rec =>
    rec && !SETTINGS_HANDLE_IDS.has(rec.id) && !rec.opfsBacked
  );
  if (todo.length === 0) {
    await markMigrationRun(MIGRATION_ID, { migrated: 0, skipped: all.length });
    return { migrated: 0, total: all.length };
  }
  console.log("[storage] starting handle-shape migration", { count: todo.length });
  let migrated = 0, orphaned = 0;
  for (const rec of todo) {
    await new Promise(r => {
      const tick = () => r();
      if (typeof requestIdleCallback === "function") requestIdleCallback(tick, { timeout: 250 });
      else setTimeout(tick, 0);
    });
    try {
      // Legacy {id, file}: promote File to OPFS, drop the File from IDB.
      if (rec.file && typeof rec.file.arrayBuffer === "function") {
        await opfsStore(rec.id, rec.file);
        await dbPut("handles", { id: rec.id, handle: null, opfsBacked: true });
        migrated++;
        continue;
      }
      // Orphan {id} — may have OPFS bytes from a prior deck-load.
      const opfsFile = await opfsGet(rec.id);
      if (opfsFile) {
        await dbPut("handles", { id: rec.id, handle: null, opfsBacked: true });
        migrated++;
      } else {
        await dbPut("handles", { id: rec.id, handle: null, needsReconnect: true });
        orphaned++;
      }
    } catch (err) {
      console.warn("[storage] migration record failed", { id: rec.id, error: err?.message || String(err) });
    }
  }
  await markMigrationRun(MIGRATION_ID, { migrated, orphaned, total: todo.length });
  console.log("[storage] handle-shape migration complete", { migrated, orphaned, total: todo.length });
  return { migrated, orphaned, total: todo.length };
}
