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
