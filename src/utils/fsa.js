// File System Access — watched-folder plumbing for the library auto-import
// system (Phase 1).
//
// Owns the read-side and write-side of the `watchedFolders` IndexedDB store
// added in storage.js v6. Records on disk are shaped:
//
//   { id, name, handle, enabled, addedAt, lastScannedAt }
//
//   - id            string  — stable client-generated identifier (wf_<ts>_<rand>)
//   - name          string  — folder display name (FileSystemDirectoryHandle.name)
//   - handle        FileSystemDirectoryHandle  — structured-cloneable; the
//                                                 whole point of the FSA spec
//                                                 that this module exercises
//   - enabled       boolean — UI toggle for whether scanning should consider
//                              this folder (Phase 2+ will honour this; Phase 1
//                              records it but does nothing with it)
//   - addedAt       number  — Date.now() at grant time
//   - lastScannedAt number | null — null in Phase 1; Phase 2 populates after
//                                    its first successful folder scan
//
// Permission state on the returned record is a runtime-only field computed
// fresh via handle.queryPermission() — it is not persisted, because the
// browser owns permission state, not us. Three values per the FSA spec:
// "granted" | "denied" | "prompt".
//
// Telemetry tags:
//   [LIB-PHASE1]       — normal-operation logs (folder added, removed, etc.)
//   [LIB-PHASE1-SPIKE] — one-shot verification of put → read-back →
//                         queryPermission on the FIRST watched-folder write
//                         per session. Confirms FileSystemDirectoryHandle is
//                         actually structured-cloneable in this environment
//                         (spec says yes; historically edge cases exist).

import { dbGet, dbGetAll, dbPut, dbDelete } from "./storage.js";

const STORE = "watchedFolders";
const TAG = "[LIB-PHASE1]";
const SPIKE_TAG = "[LIB-PHASE1-SPIKE]";

// One-shot per session. Once the spike passes, subsequent addFolder calls go
// through the fast path without verbose telemetry. Reset on full page reload.
let _spikeRanThisSession = false;

// ── Feature detection ────────────────────────────────────────────────────
// Chrome/Edge expose window.showDirectoryPicker; Safari does not (as of
// Safari 17.x). Used by the UI to render the Safari fallback message and by
// restoreHandles to short-circuit on browsers that can't read back.
export function isFSASupported() {
  return typeof window !== "undefined"
    && typeof window.showDirectoryPicker === "function";
}

// ── Permission helpers ───────────────────────────────────────────────────
// queryPermission is non-prompting — safe to call on app mount once per
// watched folder. requestPermission CAN prompt and MUST be called only in
// response to a user gesture (Chrome enforces this), so it is only invoked
// from the explicit "Re-grant access" UI action.
export async function checkPermission(handle) {
  if (!handle || typeof handle.queryPermission !== "function") return "denied";
  try {
    return await handle.queryPermission({ mode: "read" });
  } catch (err) {
    console.warn(`${TAG} queryPermission threw`, { error: err?.message || String(err) });
    return "denied";
  }
}

export async function requestPermissionFor(handle) {
  if (!handle || typeof handle.requestPermission !== "function") return "denied";
  try {
    const state = await handle.requestPermission({ mode: "read" });
    console.log(`${TAG} requestPermission → ${state}`, { name: handle.name });
    return state;
  } catch (err) {
    console.warn(`${TAG} requestPermission threw`, { error: err?.message || String(err) });
    return "denied";
  }
}

// ── Spike — runs once per session around the first watched-folder write ──
// Verifies the three steps that the Phase 1 plumbing depends on:
//   1. IDBObjectStore.put() accepts a FileSystemDirectoryHandle
//   2. The same handle survives a read-back from IDB in the same session
//   3. queryPermission() on the read-back handle returns a valid state
//
// On any failure: rolls back (deletes the record from IDB) and returns
// `{ ok: false, step, error }`. Caller is responsible for surfacing the
// failure to the UI. On success: returns `{ ok: true }`.
async function _runSpike(record) {
  console.log(`${SPIKE_TAG} starting roundtrip`, { name: record.name, id: record.id });
  let step = "put";
  try {
    await dbPut(STORE, record);
    console.log(`${SPIKE_TAG} put ok`);
    step = "read-back";
    const readBack = await dbGet(STORE, record.id);
    if (!readBack || !readBack.handle) {
      throw new Error("read-back returned no record or no handle");
    }
    if (typeof readBack.handle.queryPermission !== "function") {
      throw new Error("read-back handle missing queryPermission method (structured-clone lost prototype?)");
    }
    console.log(`${SPIKE_TAG} read-back ok`, { name: readBack.handle.name });
    step = "queryPermission";
    const permission = await readBack.handle.queryPermission({ mode: "read" });
    console.log(`${SPIKE_TAG} queryPermission → ${permission}`);
    console.log(`${SPIKE_TAG} passed — DirectoryHandle persistence verified in this browser`);
    _spikeRanThisSession = true;
    return { ok: true };
  } catch (err) {
    const errMsg = err?.message || String(err);
    console.error(`${SPIKE_TAG} FAILED at ${step} — ${errMsg}`, err);
    try {
      await dbDelete(STORE, record.id);
      console.warn(`${SPIKE_TAG} rolled back — removed ${record.id} from ${STORE}`);
    } catch (rollbackErr) {
      console.error(`${SPIKE_TAG} rollback ALSO failed — ${rollbackErr?.message || String(rollbackErr)}`);
    }
    return { ok: false, step, error: errMsg };
  }
}

// ── Write-side primitives ────────────────────────────────────────────────
// addFolder is the canonical IDB write for a brand-new watched folder. The
// first call per session runs through the spike; subsequent calls go through
// the fast path. Returns the persisted record (with addedAt set) or throws
// if the spike fails or the IDB write fails. UI is expected to catch.
export async function addFolder({ handle, suggestedName }) {
  if (!handle || handle.kind !== "directory") {
    throw new Error("addFolder requires a FileSystemDirectoryHandle");
  }
  const record = {
    id: `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: suggestedName || handle.name,
    handle,
    enabled: true,
    addedAt: Date.now(),
    lastScannedAt: null,
  };
  if (!_spikeRanThisSession) {
    const result = await _runSpike(record);
    if (!result.ok) {
      // Spike rolled back the record already. Surface via thrown error so the
      // caller can show the user what happened.
      throw new Error(`FSA spike failed at ${result.step}: ${result.error}`);
    }
  } else {
    await dbPut(STORE, record);
    console.log(`${TAG} addFolder ok`, { id: record.id, name: record.name });
  }
  return record;
}

// User opens the system folder picker. The picker MUST be invoked inside a
// user gesture handler (button click) — Chrome rejects otherwise. Returns
// the persisted record on grant, or null on user-cancel.
//
// `startIn` biases the picker's initial directory ("downloads", "music",
// "documents", "desktop", "pictures", "videos", or a directory handle). The
// user still has to confirm; we never get a handle without explicit picking.
export async function requestFolder({ startIn } = {}) {
  if (!isFSASupported()) {
    throw new Error("File System Access API not supported in this browser");
  }
  let handle;
  try {
    const opts = { mode: "read" };
    if (startIn) opts.startIn = startIn;
    handle = await window.showDirectoryPicker(opts);
  } catch (err) {
    // AbortError = user cancelled. Any other error is unexpected.
    if (err && err.name === "AbortError") {
      console.log(`${TAG} requestFolder cancelled by user`);
      return null;
    }
    console.warn(`${TAG} requestFolder threw`, { error: err?.message || String(err) });
    throw err;
  }
  console.log(`${TAG} grant requested for ${handle.name}`);
  return addFolder({ handle });
}

// Toggle the `enabled` flag on a watched folder. Phase 1 records it; Phase 2+
// will check it before scanning.
export async function setFolderEnabled(id, enabled) {
  const rec = await dbGet(STORE, id);
  if (!rec) {
    console.warn(`${TAG} setFolderEnabled: no record for id`, id);
    return null;
  }
  const next = { ...rec, enabled: !!enabled };
  await dbPut(STORE, next);
  console.log(`${TAG} folder ${enabled ? "enabled" : "disabled"}`, { id, name: rec.name });
  return next;
}

export async function removeFolderById(id) {
  const rec = await dbGet(STORE, id);
  if (!rec) {
    console.warn(`${TAG} removeFolderById: no record for id`, id);
    return false;
  }
  await dbDelete(STORE, id);
  console.log(`${TAG} folder removed`, { id, name: rec.name });
  return true;
}

// Phase 2 — stamp lastScannedAt after a successful scan. Caller passes the
// completion timestamp (or omits to use now). Returns the updated record or
// null if the folder is missing from IDB (e.g. removed mid-scan).
export async function setFolderLastScanned(id, when = Date.now()) {
  const rec = await dbGet(STORE, id);
  if (!rec) {
    console.warn(`${TAG} setFolderLastScanned: no record for id`, id);
    return null;
  }
  const next = { ...rec, lastScannedAt: when };
  await dbPut(STORE, next);
  return next;
}

// ── Read-side ────────────────────────────────────────────────────────────
// Called on app mount. Reads every watched folder, runs a non-prompting
// queryPermission per handle, returns an array shaped:
//
//   [{ id, name, handle, enabled, addedAt, lastScannedAt, permission }]
//
// permission is "granted" | "denied" | "prompt". Records with a missing or
// malformed handle are still returned but with permission:"denied" so the UI
// can surface them as "needs re-grant" without crashing.
//
// On Safari (no FSA support), returns []. The IDB records — if any — are
// left alone in case the user comes back via Chrome later.
export async function restoreHandles() {
  if (!isFSASupported()) {
    console.log(`${TAG} restoreHandles skipped — FSA unsupported in this browser`);
    return [];
  }
  let records;
  try {
    records = await dbGetAll(STORE);
  } catch (err) {
    console.warn(`${TAG} restoreHandles: dbGetAll failed`, { error: err?.message || String(err) });
    return [];
  }
  const restored = [];
  for (const rec of records || []) {
    let permission = "denied";
    if (rec && rec.handle && typeof rec.handle.queryPermission === "function") {
      try {
        permission = await rec.handle.queryPermission({ mode: "read" });
      } catch (err) {
        console.warn(`${TAG} queryPermission on restore failed`, { id: rec.id, error: err?.message || String(err) });
        permission = "denied";
      }
    } else {
      console.warn(`${TAG} restored record missing handle or queryPermission method`, { id: rec?.id });
    }
    restored.push({
      id: rec.id,
      name: rec.name,
      handle: rec.handle || null,
      enabled: rec.enabled !== false,
      addedAt: rec.addedAt || null,
      lastScannedAt: rec.lastScannedAt || null,
      permission,
    });
    console.log(`${TAG} queryPermission ${rec.name} → ${permission}`);
  }
  console.log(`${TAG} restored ${restored.length} handles from IDB`);
  return restored;
}

// ── Phase 2 — Recursive folder scanner ───────────────────────────────────
// Walks a granted FileSystemDirectoryHandle tree and yields one record per
// audio file found. Async-generator pattern so callers can interleave
// dedup, state updates, and cancellation without buffering the whole result
// set. Yields FileSystemFileHandle references only — File bytes are never
// resolved here, so memory cost is constant in the number of tracks
// (decisive when the user has 5000+ files under the chosen folder).
//
// Yielded record (from scanWatchedFolder):
//   { name, handle, relativePath }
//     - name          string — filename (e.g. "track.mp3")
//     - handle        FileSystemFileHandle — caller resolves .getFile() lazily
//     - relativePath  string — slash-joined path relative to the scan root,
//                              INCLUDING the filename. For a file at the
//                              root of the scanned folder this equals `name`;
//                              for nested files it looks like
//                              "subdir/Strobe.mp3" or "a/b/c/Strobe.mp3".
//
// scanWatchedFolders is the orchestrator across multiple watched folders;
// each result is additionally stamped with:
//     - folderId      string — id of the watchedFolder this file lives in
//     - folderName    string — folder display name at scan time (UI only)
// The composite key (folderId, relativePath) is what Phase 2 dedup uses
// to populate the `sourcePath` field on imported tracks; folderName is
// purely for UI display and may change if the user renames the folder
// without losing track identity.
//
// Telemetry tag: [LIB-PHASE2-SCAN].

const SCAN_TAG = "[LIB-PHASE2-SCAN]";

// Audio extensions worth surfacing as "new tracks." .mp4 is intentionally
// excluded — the container can hold video as well as audio, and surfacing
// video files as DJ tracks would be wrong. The audio-only variant (.m4a)
// IS included. Future Phase 2.5 work can re-introduce .mp4 with magic-byte
// / mp4-box codec verification.
const AUDIO_EXTENSIONS = new Set([
  "mp3", "wav", "flac", "aiff", "aif", "m4a", "aac", "ogg", "opus", "alac",
]);

// Directory names skipped regardless of contents. Saves traversing into
// macOS system locations, dev artifact dirs, and browser cache dirs that
// almost never contain real music. Hidden directories (name starts with
// ".") are ALSO skipped via a separate rule below, so .git / .Trash /
// .Spotlight-V100 / .DocumentRevisions-V100 are caught even though they're
// not enumerated here.
const SKIP_DIR_NAMES = new Set([
  // macOS system locations at user-home level
  "Library", "Applications",
  // dev artifact directories
  "node_modules", "dist", "build", "__pycache__", "venv",
  // browser / OS cache directories
  "Cache", "Caches",
]);

function _hasAudioExtension(name) {
  // Skip macOS metadata files like "._foo.mp3" — they share the extension
  // but contain resource-fork garbage, not real audio.
  if (!name || name.startsWith(".")) return false;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return AUDIO_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

function _shouldSkipDir(name) {
  if (!name) return true;
  // Catches .git, .Trash, .Trashes, .Spotlight-V100, .DocumentRevisions-V100,
  // .cache, .next, .nuxt, .venv, and anything else starting with a dot.
  if (name.startsWith(".")) return true;
  return SKIP_DIR_NAMES.has(name);
}

// scanWatchedFolder(rootHandle, { signal, onProgress })
//   async generator yielding { name, handle, relativePath } per audio file
//   found. Paths are relative to rootHandle and INCLUDE the filename.
//   - signal:     optional AbortSignal — checked at every directory and file
//                  entry; throws DOMException("aborted", "AbortError") if set.
//   - onProgress: optional callback ({ found, relativePath }) fired each
//                  time a new audio file is yielded; safe to ignore.
//
// Caller drives pacing via `for await (const item of scanWatchedFolder(...))`.
// Yielding between entries gives the UI thread room to update progress copy
// without the scanner needing its own throttle.
export async function* scanWatchedFolder(rootHandle, { signal, onProgress } = {}) {
  if (!rootHandle || rootHandle.kind !== "directory") {
    throw new Error("scanWatchedFolder requires a FileSystemDirectoryHandle");
  }
  let found = 0;
  async function* walk(dirHandle, prefix) {
    if (signal?.aborted) {
      throw new DOMException("scan aborted", "AbortError");
    }
    for await (const [name, handle] of dirHandle.entries()) {
      if (signal?.aborted) {
        throw new DOMException("scan aborted", "AbortError");
      }
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === "file") {
        if (_hasAudioExtension(name)) {
          found++;
          try { onProgress?.({ found, relativePath }); } catch {}
          yield { name, handle, relativePath };
        }
      } else if (handle.kind === "directory") {
        if (_shouldSkipDir(name)) continue;
        yield* walk(handle, relativePath);
      }
    }
  }
  yield* walk(rootHandle, "");
}

// scanWatchedFolders(folders, { signal, onProgress })
//   Aggregates scans across every enabled+granted watched folder. Returns
//   {
//     results:          [{name, handle, relativePath, folderId, folderName}],
//     scannedFolderIds: [folderId, ...],     // folders successfully walked
//     skippedFolders:   [{folderId, folderName, reason}], // disabled / no perm / threw
//   }
//
// Composite identity (folderId, relativePath) on each result is the key
// Phase 2 dedup uses to populate `sourcePath` on imported tracks — stable
// across folder renames and resilient to multiple watched folders that
// happen to contain identically-named files at their roots.
//
// Honors the per-folder `enabled` flag (skips disabled) and `permission`
// field (skips non-granted — re-grant happens via the existing UI before
// the next scan). Errors on individual folders are caught and recorded in
// skippedFolders so one bad handle doesn't abort the whole pass; AbortError
// IS propagated so the caller's cancellation request takes effect immediately.
export async function scanWatchedFolders(folders, { signal, onProgress } = {}) {
  if (!Array.isArray(folders)) {
    throw new Error("scanWatchedFolders requires an array of folder records");
  }
  const results = [];
  const scannedFolderIds = [];
  const skippedFolders = [];
  for (const folder of folders) {
    if (signal?.aborted) {
      throw new DOMException("scan aborted", "AbortError");
    }
    if (!folder || !folder.handle) {
      skippedFolders.push({ folderId: folder?.id, folderName: folder?.name, reason: "no-handle" });
      continue;
    }
    if (folder.enabled === false) {
      skippedFolders.push({ folderId: folder.id, folderName: folder.name, reason: "disabled" });
      console.log(`${SCAN_TAG} skip ${folder.name} — disabled`);
      continue;
    }
    if (folder.permission && folder.permission !== "granted") {
      skippedFolders.push({ folderId: folder.id, folderName: folder.name, reason: `permission:${folder.permission}` });
      console.log(`${SCAN_TAG} skip ${folder.name} — permission=${folder.permission}`);
      continue;
    }
    try {
      console.log(`${SCAN_TAG} scan start ${folder.name}`);
      const t0 = performance.now();
      let folderFound = 0;
      const innerProgress = (info) => {
        folderFound = info.found;
        try {
          onProgress?.({
            ...info,
            folderId: folder.id,
            folderName: folder.name,
          });
        } catch {}
      };
      for await (const item of scanWatchedFolder(folder.handle, { signal, onProgress: innerProgress })) {
        results.push({ ...item, folderId: folder.id, folderName: folder.name });
      }
      scannedFolderIds.push(folder.id);
      console.log(`${SCAN_TAG} scan done ${folder.name}`, {
        files: folderFound,
        ms: Math.round(performance.now() - t0),
      });
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      console.warn(`${SCAN_TAG} scan failed ${folder.name}`, { error: err?.message || String(err) });
      skippedFolders.push({
        folderId: folder.id,
        folderName: folder.name,
        reason: `error:${err?.message || String(err)}`,
      });
    }
  }
  console.log(`${SCAN_TAG} scanWatchedFolders summary`, {
    folders: folders.length,
    scanned: scannedFolderIds.length,
    skipped: skippedFolders.length,
    files: results.length,
  });
  return { results, scannedFolderIds, skippedFolders };
}
