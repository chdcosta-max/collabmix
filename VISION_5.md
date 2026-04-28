# Mix//Sync — Vision 5

## Current Architecture Decision (April 27, 2026)

After exploring three architectural models for B2B (back-to-back) DJ sessions, we've committed to **Option C — shared mixer controls with independent local libraries**. This unblocks the Wednesday 2026-04-29 B2B test while leaving room to upgrade to true sample-accurate shared playback in a later phase.

### Option C in one paragraph

Each DJ runs their own audio engine in their own browser. Each DJ uses their own local library (independently imported tracks, IDB-backed). When **any** mixer control is touched by **either** DJ — EQ, channel volume, filter, crossfader, transport — the change applies locally to the toucher's audio engine, broadcasts via WebSocket, and applies to the partner's local audio engine on the other browser. Audio that is actually heard by both DJs travels via WebRTC: each peer captures their own engine's `master` node into a `MediaStreamDestination`, sends it through one bidirectional `RTCPeerConnection`, and plays the inbound stream through a vanilla `<audio>` element. There is **no** sample-accurate shared playback, **no** per-track file transfer, and **no** lock-step transport scheduling — those are deferred.

### Why Option C and not the others

- **Option A (each DJ rigs independent).** Easiest, but doesn't feel like one shared B2B booth — collaborative gestures (one DJ EQ-ducking the other's bass while they both work the crossfader) are impossible.
- **Option B (one host renders, the other controls remotely).** Reasonable for low control-latency on the host's side; high control-latency on the guest. Feels lopsided.
- **Option C (this one).** Both DJs feel equally "at the booth" because mixer state is symmetric. Audio of underlying tracks lives only on whichever side loaded them, and the partner hears them via WebRTC master streaming. Trade-off: each side hears a slightly different mix (their own local levels + partner's remote levels), and there's no guarantee both hear the *same* master — but for two DJs on headphones B2B'ing one set, this is close enough to feel right.
- **Option D / Beatport-style sample-accurate shared playback** would require track delivery to both peers, clock-offset estimation via `RTCPeerConnection.getStats()` round-trip, and an op log for transport. Big lift; deferred.

## 3-Phase Build Plan

### Phase 1 — Shared mixer controls (foundation)

**Status: shipped tonight (2026-04-27).** All mixer state — EQ HI/MID/LO per deck, channel VOL, DJ filter, crossfader — broadcasts on local change and applies to the partner's local audio engine on inbound. The wire protocol uses the existing `deck_update {deckId, field, value}` and `xfade_update {value}` message types. Inbound `deck_update` is now wired through `setEqA` / `setEqB`, which feed the existing `Deck` prop-driven `useEffect` that writes to `ch.hi.gain.value`, `ch.mid.gain.value`, etc. `applyFilter("A"|"B", filter)` is already triggered by parent-level effects on `eqA.filter` / `eqB.filter`. Visual mirror of partner's loaded track is restored: `pA.waveformBass → setWfA`, `pB.waveformBass → setWfB`, and the in-`Deck` mirror useEffect runs whenever there is no local audio buffer (last-write-wins).

### Phase 2 — Shared transport (next)

Wire `play_request`, `cue_request`, and `seek_request` over WebSocket so either DJ can play, pause, scrub, or cue either deck. The plumbing is partially in place from earlier today (the seek/toggle/cue ref pattern via `seekFnsRef.current[id]?.()`); needs to be re-enabled now that Deck B is hybrid (local audio chain, mirrors partner state when no local buf). Includes broadcasting `progress` updates from whoever holds the local buffer, with the partner's `Deck` mirror RAF interpolating between snapshots. Conflict policy: last-action-wins, no permission system.

### Phase 3 — Hot cues + loops

Sync hot-cue points (4 per deck) and loop region/active state via `deck_update` field extensions: `hotCue0`, `hotCue1`, …, `loopStart`, `loopEnd`, `loopActive`. Hot-cue trigger broadcasts a `cue_jump_request` so partner's deck snaps to the same point. Loop activation and length changes propagate.

## Deferred (post-Wednesday)

- **True sample-accurate shared playback** (Beatport-style). Requires clock-offset estimation, scheduled `bufferSource.start(t)`, and an op-log replay. Out of scope for the test.
- **P2P track file transfer**. Today, if your partner doesn't have the same file in their own library, your "load track on Deck A" only updates partner visuals (waveform/name) — they can't actually mix it locally; they just hear it via your WebRTC master stream. A future phase could chunk the audio file over an `RTCDataChannel` so both peers truly own the audio.
- **Real shared master**. Today each peer hears their-local + partner-remote, which means the two DJs hear different mixes. A future phase could pick one peer as the canonical master and stream only one direction, or render both sides identically once tracks live on both peers.
- **Permission / claim system**. The user explicitly chose "last action wins" for Wednesday. Could revisit if collisions become annoying.
- **Sync_response EQ restore**. When a peer joins mid-session, today's handshake only restores xfade locally; partner's EQ snapshot fills `pA`/`pB` for visual but doesn't apply to my engine until the next knob move. Easy follow-up.
- **`SERVER_URL` env-var driven**. Today it's hardcoded. If we ever need a staging WebSocket server, we'll move it to `VITE_WS_URL`.

## Tonight's WebSocket Connection Bug — Postmortem

### Symptom
Production app at `https://collabmix.vercel.app/?room=preview` showed a `DISCONNECTED` status indicator and zero entries under Chrome DevTools' Socket filter — both on page load and after clicking the INVITE button. All Option C testing was blocked because partner sync depends on the WebSocket.

### Root cause
The `useSync` hook is correct. The `SERVER_URL` constant is correct (`wss://collabmix-server-production.up.railway.app`). The Railway server is up and responds `HTTP 200 / "COLLAB//MIX Server"`. None of those are the bug.

The bug is in the **page-state machine bypass**: an earlier preview/bypass shortcut hardcoded the initial page to `"session"` (line 3861, `useState("session")`) and `main.jsx` mounts `<CollabMix initialPage="session" djName="DJ Preview" />`. The shortcut skipped both `<Landing>` and `<Lobby>`. Because `sync.connect()` is *only* called from `join(info)`, and `join()` is *only* called from `<Lobby>`, the WebSocket was never opened in bypass mode — but no error showed, because nothing tried to fail.

The session UI silently rendered with `sync.status === "disconnected"`. INVITE only copies the URL to the clipboard; it has zero connection side effect by design. So the app appeared to work; it just never partnered.

### Fix (commit `b3c42af`)
Added a mount-time `useEffect` inside `CollabMix`, gated on `page === "session"` and `sync.status === "disconnected"`. It reads the `?room=` URL parameter, falls back to the seeded `session.room`, and calls `sync.connect(roomId, session.name)`. Returns a cleanup that calls `sync.disconnect()` on unmount, preventing dangling sockets. Also replaced the dead seeded `session.url = "wss://localhost:8080"` with `SERVER_URL` (the literal was misleading — `useSync` was already ignoring it and using `SERVER_URL` directly).

### Lesson for future Claude / future me
If you ever shortcut a multi-step user flow (landing → lobby → session) in favor of a faster preview path, **explicitly inventory the side effects of the steps you skipped**. In this case, `<Lobby>` did three things: rendered an invite link, asked for a DJ name, and called `join()` which opened the socket. Killing Lobby took the third one with it silently. Auto-join effects on the new entry point need to replicate what was lost.

## What's Working (as of 2026-04-27, end of session)

- **Audio engine**: `createEngine()` builds two parallel chains (Deck A, Deck B) with per-deck trim → highshelf/peaking/lowshelf EQ → DJ filter (allpass) → vol → xf → master. Master streams out to `<audio>` element + WebRTC peer.
- **Local playback**: drag-drop, click-to-load, file picker, OS-Finder drop all work on both Deck A and Deck B. Tracks are loaded into local `AudioBuffer` and routed through the local audio chain.
- **Library**: real IDB-backed track store via `useLibrary()` and `cmDb*`. Library V2 prototype (`library.html`) still has mock data in the separate library entry — wiring real data into V2 is task #3 in the queue.
- **Scrubbing / seeking**: top zoomed waveform (`AnimatedZoomedWF`) accepts click-to-seek on both decks. Deck-card overview (`WF`) seeks instantly even when paused — fixed earlier today.
- **Transport**: Cue / Play-Pause / Sync visible on both deck cards (height regression fixed by bumping deck row from 228px → 288px). Play/pause uses deck-color tint with glow when active.
- **Mixer Ch B**: now interactive (GAIN/HI/MID/LO knobs + VOL fader bound to `eqB`/`updateEqB`). VU meter pulls from `eng.B.an`.
- **Shared mixer controls (Phase 1, Option C)**: inbound `deck_update` for `eqHi/eqMid/eqLo/vol/filter` applies to local audio engine. Inbound `xfade_update` applies. Visual partner-mirror restored for both decks via parent-level `pA?.waveformBass → setWfA` and `pB?.waveformBass → setWfB`, plus in-Deck mirror running when no local buf.
- **WebSocket**: now opens automatically on session entry (mount-time effect). Honors `?room=` URL param. Cleans up on unmount. Same room ID in two browser windows = two clients connected to the same Railway server room.
- **WebRTC**: each peer captures own master and bidirectionally streams to the other. `START STREAM` button initiates the offer.
- **Beat detection**: per-track BPM + Camelot key analysis on load, displayed on deck card.
- **Beat grid**: drift-free per-bar grid drawing on top zoomed waveform with manual ±5ms nudges and ±0.01 BPM nudges, persisted per-track in localStorage.
- **Recording**: master output recordable to webm/ogg, downloadable.

## Out-of-scope tonight (still queued)

- Library V2 wiring to real data (task #3).
- Deck/mixer polish — BPM as largest text (32-36px), hot-cue touch targets, MASTER OUT compression, deck-card↔waveform visual continuity (task #4).
- Full Phase 2 (transport sync) and Phase 3 (hot cues + loops).
