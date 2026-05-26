# STORAGE.md — Mix//Sync storage architecture

This document is the single source of truth for the schema, layers, and
migration history of Mix//Sync's client-side storage. Update this file
whenever the schema or storage code changes.

## Why this exists

Before the May 25 storage fix, both apps in this repo (mixer at `/`,
standalone library at `/library.html`) inlined their own copies of the
IDB helpers. Those copies drifted — notably the `settings` store
keyPath was declared differently in the two apps — and a third schema
dimension (OPFS audio backing) was implemented only in the mixer. Users
who imported via `/library.html` had their tracks become unreadable by
the mixer, and pre-fix nothing requested persistent storage at all, so
Chrome silently evicted libraries under disk pressure.

All storage code now lives in `src/utils/storage.js`. **Do not inline
IDB or OPFS calls in either app.** If you need a new helper, add it to
the shared utility and import it.

## Storage layers

There are five distinct storage layers. Each has a different durability
profile and a different role:

| Layer | What | Durability | Used by |
|---|---|---|---|
| 1. IndexedDB | metadata (tracks, crates, queue, handle refs, settings, migrations) | until evicted | both apps |
| 2. OPFS | audio bytes (`cm_audio/<trackId>`) | until evicted | both apps (since May 25) |
| 3. FileSystemFileHandle stored inside IDB `handles` | permission token for re-grant | survives sessions but requires user gesture to re-grant read | both apps |
| 4. `navigator.storage.persist()` | upgrades layers 1–3 from evictable → persistent tier | until user clears site data | requested on mount by both apps (since May 25) |
| 5. In-memory `fileMap` (mixer only) | LRU cache, cap 16, of resolved File objects | per-session | mixer |

User-controlled backup (layer 6): the **JSON export** in the mixer
library toolbar bundles layers 1's content (tracks + crates + queue,
metadata + compressed artwork data URLs only — no audio bytes) into a
portable file. Required safety net for browsers where layer 4 is
unavailable (Safari) or denied (private mode, embedded WebViews).

## IDB schema — v5 (current)

Database name: `cm_music_library`. Version: `5`.

| Store | keyPath | Notes |
|---|---|---|
| `tracks` | `id` | Track metadata + downsampled artwork data URL. Indexes: artist, genre, energy, bpm, addedAt |
| `crates` | `id` | Playlists. `{ id, name, trackIds, createdAt }` |
| `queue` | `trackId` | Session queue ordering. `{ trackId, order }` |
| `handles` | `id` | File-access references — see "Handle record shapes" below |
| `settings` | `key` | App-level prefs (declared, currently unused) |
| `requests` | `id` | Cross-deck track-load requests |
| `migrations` | `id` | One-shot upgrade markers. `{ id, ranAt, ...details }` |

### Handle record shapes

The `handles` store carries multiple legacy shapes. Consumers should
use `resolveHandleRecord()` from the shared utility rather than reading
fields directly.

| Shape | Origin | After v5 migration |
|---|---|---|
| `{ id, handle, opfsBacked: true }` | canonical (v5 writes) | unchanged |
| `{ id, handle: null, opfsBacked: true }` | library-app `<input>` import path, post-v5 | unchanged |
| `{ id, file: File }` | library-app `<input>` import path, pre-v5 | migrated → File copied to OPFS, record rewritten as `{ id, handle: null, opfsBacked: true }` |
| `{ id }` (no handle, no file) | mixer pre-v5 `cmDbPutHandle` bug — spread on a FileSystemFileHandle silently dropped the handle | if OPFS has bytes, rewrite as opfsBacked; else mark `needsReconnect: true` |
| `{ id: "scan_dir"\|"itunes_file"\|"rb_dir"\|"rb_file", handle }` | folder/settings handles, library-app | unchanged (skipped by migration) |

## Read priority

When resolving a track's audio file, **always check in this order**:

1. `fileMap.current[id]` (mixer only, in-memory LRU)
2. `opfsGet(id)` (zero-permission, survives session)
3. `dbGet("handles", id)` then `resolveHandleRecord(rec)`:
   - if `rec.file` is a File → use it directly (legacy library-app `<input>` path)
   - if `rec.handle` is a FileSystemFileHandle → `queryPermission` / `requestPermission` / `getFile`
   - else → null (UI should prompt re-pick if `needsReconnect`)

Both apps' file resolvers follow this priority. Don't reorder.

## Persistence

`ensurePersistentStorage()` runs on every app mount. Returns:

| State | Meaning | UI response |
|---|---|---|
| `"persisted"` | Storage upgraded to durable tier. Chrome won't evict | none (silent success) |
| `"denied"` | Browser declined `persist()` request | banner: "Persistent storage unavailable. Use Export Library to back up." |
| `"unsupported"` | API not available (very old browsers, some WebViews) | same banner |

Banner is dismissible per origin via `localStorage["cm_storage_banner_dismissed"]`.

## Migration history

| Marker id | DB version | Date | What ran |
|---|---|---|---|
| `handles_v4_to_v5` | v4 → v5 | May 25 | Lazy. Normalized legacy `handles` record shapes (see above). Idle-scheduled, marker written on completion. |

Adding a new migration: append a marker id, declare the action in
`runHandleMigration()` (or a new function), and update this table.

## Anti-patterns

- **Do not inline IDB or OPFS calls.** Use `src/utils/storage.js`.
- **Do not store File objects in IDB.** OPFS owns the bytes. IDB owns
  the metadata + handle refs.
- **Do not bump CM_DB_VER without writing a migration.** v5 is the
  current version. The upgrade function in `openCmDB` is the only
  place that should add stores or change keyPaths.
- **Do not call `navigator.storage.persist()` ad-hoc.** Use
  `ensurePersistentStorage()` from the utility — it's idempotent and
  returns the typed state the UI banner depends on.
