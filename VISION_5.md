MIX//SYNC — RESUME BRIEF (May 7, 2026 evening — dogfood-ready handoff)
=================================================================

HOW TO USE: Paste this entire note as your first message in a new Claude
chat. Lead with: "Continuing work on Mix//Sync. Previous chat hit context
limits. Please confirm you understand state, then we'll start on next
priority." Don't paraphrase.

=================================================================
PROJECT BASICS
=================================================================
- Mix//Sync — browser-based remote DJ B2B platform
- Local path: /Users/chad/Desktop/collabmix
- Main file: src/collabmix-production.jsx (NOT src/App.jsx)
- BPM worker source: src/bpm-worker-source.js (analyzer logic lives here)
- Test harness: tools/bpm-test-harness/
- Backend: Node.js WebSocket on Railway
  - URL: wss://collabmix-server-production.up.railway.app
  - GitHub: github.com/chdcosta-max/collabmix-server (auto-deploy on push)
  - Local clone: /Users/chad/Desktop/collabmix-server-repo (the git copy)
  - Note: /Users/chad/Desktop/collabmix-server is a non-git copy — IGNORE for edits
- Frontend: React + Vite on Vercel (collabmix.vercel.app)
- Deploy: bash BUILD_AND_PUSH.command
- GitHub: github.com/chdcosta-max/collabmix
- Latest commit: 38f23ee (Compress artwork on import — 35x memory reduction)

=================================================================
SESSION HISTORY
=================================================================

APR 28 NIGHT (six commits):
1. Onset-gated phase scoring — fixes wrong-bar anchoring
2. BPM snap (initial version) — Starseed snaps to 121
3. Deck B beat grid restored
4. Crash hardening (sync.send, partner-mirror, localStorage)
5. WORKER_SRC extracted to src/bpm-worker-source.js
6. Node test harness built (tools/bpm-test-harness/)

APR 29 EVENING (gate redesign):
7. Dual-branch BPM-snap gate (commit 7e47553)
   - periodIntegerLocked: |bpmFromPeriod - intBpm| < 0.05
   - crossValidated: |bpm - intBpm| < 0.25 AND |bpm - bpmFromPeriod| < 0.07
   - withinOuterGuard: |bpm - intBpm| < 0.5
   - Snap if (periodIntegerLocked OR crossValidated) AND withinOuterGuard

MAY 4 EVENING — earlier (two commits):
8. AudioBufferSourceNode RangeError fix (commit e3d2d34)
   - Clamp seek() input to [0, 1] at the boundary
9. File picker reload fix (commit 5a94e27)
   - Reset hidden <input type=file> .value after onChange so same
     file can be reselected. Bug was completely silent.

MAY 4 EVENING — late (three commits, Phase 2 + Slices 1+2):
10. Phase 2 transport sync — server-side (collabmix-server commit 3dde18e)
    - Three new relay branches: seek_request, toggle_request, cue_request
    - Pure forwarding; broadcastToRoom auto-filters sender, no echo logic
11. Phase 2 transport sync — client senders (collabmix commit 4fbf28f)
    - Option A pattern: each callback gets fromRemote=false param
    - Local user click broadcasts; receiver passes true to suppress echo
12. Slice 1 — Partner deck spectator view (commit 3ac9ba9)
    - Broadcast artist + key + bpm via deck_update piggyback
    - Deck-header gate widened to accept partner data
    - CAMELOT extended with 30+ synonyms for rekordbox/MIK key spellings
13. Slice 2 — Partner transport control (commit 0a1c23b)
    - toggle restructured with broadcast above !buf guard + spectator branch
    - Play/CUE buttons use inline arrow onClick wrappers (workaround for
      ternary form failing to dispatch in spectator mode)

MAY 6-7 EVENING — early (two commits, both major bugs unblocked):
14. Audio routing bug fix (commit 3268c2f)
    - Root cause: endCall() called master.disconnect(dest.current) where
      dest.current was null when WebRTC was never established. Chrome
      silently treats AudioNode.disconnect(null) as disconnect-all-outputs,
      severing master from masterAn → ctx.destination, killing local audio.
    - Server unconditionally sends rtc_hangup on every partner disconnect,
      so endCall fired on every partner refresh. Even with no STREAM clicked.
    - Fix: guard the disconnect on dest.current actually being a real
      AudioNode (`if (dest.current && engineRef.current) ...`). ~4 lines.
    - This unblocked two-browser sessions for the FIRST TIME — audio actually
      flows end-to-end. Was the May 4 BLOCKER.
15. Partner playhead jitter fix (commit 7781f83)
    - Root cause: receiver computed playback rate from packet inter-arrival
      times. Network latency varies 2-200ms between packets, producing noisy
      rate estimates. Combined with hard-snap on every packet arrival, this
      caused visible playhead stutter and backward jumps.
    - Architecture of the fix:
      a) Sender: throttle progress broadcast to 10Hz (lastProgBroadcastRef
         in Deck.tick).
      b) Receiver: drop hard snap on packet arrival. Visible position now
         driven entirely by RAF interpolation reading from refs.
      c) Receiver: replace packet-derived rate with duration-based rate.
         remRateRef.current = nowPlaying ? 1 / (track_duration_seconds * 1000) : 0.
         This is the EXACT rate of B1's audio clock — eliminates noise entirely.
      d) Receiver: asymmetric drift threshold. First packet or large drift
         (>0.5%) hard-snaps. Forward corrections accepted. Backward corrections
         within tolerance ignored — let duration-based rate run, the next
         packet that catches up resyncs.
    - Also reduced WF_W from 48000 to 24000 for partner waveform broadcast
      (~800KB → ~400KB per track load — defensive, not the root cause).

MAY 6-7 EVENING — late (three commits, UX + library import + OOM fix):
16. Shareable invite links + Mix Name UX (commit 7a2fd25)
    - Two DJs can now connect to a unique Mix via shareable URL — no more
      hardcoded ?room=preview.
    - Host flow: Landing → "Start a Mix" → Lobby with Mix Name input + DJ
      Name input + auto-generated MIX CODE + COPY INVITE LINK button +
      "Start Mix →" button.
    - Invitee flow: opens invite URL → skips Landing → Lobby with read-only
      "JOINING MIX: <name>" display + DJ Name input + "Join Mix →" button.
    - Mix Name passed via URL ?mix= param. buildInviteLink now encodes both
      ?room and ?mix.
    - main.jsx fix: changed default mount from
      `<CollabMix initialPage="session" djName="DJ Preview" />` to
      `<CollabMix />` so the prop defaults are honored. URL-aware initialPage:
      if ?room= is in URL, route directly to "lobby"; else "landing".
    - Updated user-facing copy throughout: "Start a Mix", "Start Mix →",
      "Join Mix →", "MIX CODE", "JOINING MIX:", etc. Variable names
      (session.room, session.name) preserved as internal.
17. VISION_5.md update (commit ec6d660) — captured commits 14-15.
18. Library import + refresh-rejoin + dedup (commit 63ac7f9)
    - Library import infrastructure was already built in useLibrary, just
      unwired in V2. This commit wired it up:
      a) ADD MUSIC button in left rail; clicking opens showOpenFilePicker
         (or hidden <input> fallback for non-Chromium).
      b) Drag-drop on outermost LibraryPanelV2 container — handles both
         flat files and folders via webkitGetAsEntry recursive traversal.
      c) Filename cleanup: strip leading track-number prefixes ("01 ",
         "01-", "1. "), parse "Artist - Title" pattern when ID3 missing.
      d) ID3 metadata extraction (title, artist, album, BPM, key, artwork).
      e) Persists to OPFS (file bytes) + IndexedDB (metadata + handles).
      f) Empty-state CTA replaces mock tracks ("Drop tracks here or click
         to add" / "Drag a folder for bulk import" / "MP3 · WAV · FLAC ·
         AAC · OGG · M4A").
      g) MOCK_TRACKS / MOCK_CRATES / MOCK_QUEUE constants kept as dead code
         for easy re-enable during testing.
    - Duplicate detection on import: tracks normalized by artist+title match,
      checked against existing library AND within-batch dupes. If any dupes
      detected, surfaces a confirmation modal:
      "SKIP DUPLICATES (ADD N NEW)" / "IMPORT ALL (INCLUDING DUPLICATES)"
      / "CANCEL". Lists first ≤5 dupes so user can verify. Modal styling
      matches Lobby aesthetic (Cormorant Garamond title, DM Mono labels,
      gold primary button, dark panel background). Click-outside dismissal.
    - Refresh-rejoin: hitting Cmd+R during a session now reads cm_session
      from localStorage and auto-rejoins the same Mix instead of bouncing
      to Landing. Critical for dogfooding where DJs may refresh accidentally.
      Strips URL params and uses localStorage as source of truth. leave()
      clears cm_session so post-leave refresh correctly returns to Landing.
    - CRITICAL OOM FIX (within commit 63ac7f9):
      Importing 322 tracks crashed Chrome with ~10GB memory. Root cause:
      every imported track was queued for BPM/key analysis (queueRef.current
      .push) AND pinned in fileMap.current[id]=file. With 322 tracks at
      5-15MB each, that's 3-5GB of File blobs pinned simultaneously plus
      the audio decode queue. Auto-queue on app load also re-queued every
      unanalyzed track on every page load — re-OOM'd on each launch.
      Fix:
      • _importFileObjects no longer pushes to queueRef or pins fileMap.
        Just parseID3 + opfsStore + cmDbPut.
      • Auto-queue block on app mount removed entirely.
      • New queueAnalysis(id, file) callback in useLibrary.
      • handleLibLoad calls lib.queueAnalysis when track is loaded onto
        a deck and not yet analyzed — bounded to user activity, never bulk.
      • Tracks with ID3 BPM/key tags display those values immediately;
        tracks without ID3 show "—" until loaded onto a deck.

MAY 7 EVENING (two commits — both critical dogfood blockers cleared):
19. Library persistence (commit 82fd5c6)
    - Root cause of carry-over "library state↔IDB desync": Chrome was
      evicting OPFS data between sessions because storage was on the
      default (evictable) tier. 200+ track libraries appeared imported
      in the UI but only ~4 entries survived a browser quit.
    - Fix:
      a) Request persistent storage on first import via
         `navigator.storage.persist()` (gated on `persisted()` so we
         don't re-prompt). Upgrades OPFS+IDB to the persistent tier
         so Chrome won't evict under quota pressure.
      b) Made `opfsStore` properly awaited inside the import loop —
         previously fire-and-forget under concurrency, which was
         silently dropping writes at scale. Errors now propagate;
         per-track failures are caught and skipped instead of
         orphaning a metadata entry without bytes.
    - Verified: library survives page refresh AND full Chrome
      quit/restart cycles. This was the gating issue blocking
      dogfood.
20. Artwork compression (commit 38f23ee)
    - Root cause of OOM at moderate library sizes: each track held a
      full-res base64 ID3 APIC artwork string up to ~666 KB. At 266
      tracks that was ~177 MB just for artwork strings, multiplied
      across the library state, the IDB poll's deserialization
      allocation, and the artwork cache. Total resident memory hit
      ~6 GB — over Chrome's per-tab limit.
    - Fix: new `downscaleArtwork(dataUrl)` helper draws the original
      image into a canvas at 200×200 with cover-fit centering, then
      re-encodes as JPEG quality 0.7 (~10-20 KB per track, ~35×
      reduction). Called in `_importFileObjects` after `parseID3`;
      keeps the original on compression failure. The 5-second IDB
      poll's existing fingerprint check already prevents redundant
      `setLibrary` calls, so compressed artwork plus that guard
      makes polling churn a non-issue at any practical scale.
    - Verified at 135 tracks: Chrome reports 182 MB resident
      (vs ~3 GB at comparable scale pre-fix). Roughly 1.3 MB per
      track linear scaling — projects ~700 MB at 500 tracks,
      ~2.6 GB at 2000 tracks.

=================================================================
DOGFOOD SESSIONS — May 13 evening — CRITICAL FINDINGS
=================================================================

CONTEXT:
- Session 1: Tested on design-decks preview
- Session 2: Tested on production (collabmix.vercel.app, master)
- Both sessions with same remote partner (Jake)
- Goal of session 2 was to determine if bugs were
  design-decks-specific or platform-wide

KEY FINDING: All bugs are platform-wide. Present on master.

WHAT WORKED:
- Connection: 36ms ping, both browsers connected
- Chat: messages flow bidirectionally
- Library import: 16 tracks imported
- BPM analysis: working
- Library persistence: working
- No console errors thrown — bugs are behavioral, not crashes

BUGS FOUND:

Bug 1 — Partner cannot load tracks on Deck B
- Library row click only offers "Load to Deck A" option for partner
- No drag-and-drop available for partner
- Severity: BLOCKING

Bug 2 — Partner click-to-load on Deck B empty state non-functional
- The music icon affordance does not respond for remote partner
- Severity: BLOCKING

Bug 3 — Deck A visual/audio state desync between browsers
- Host loads track X on Deck A → both browsers see X
- Partner loads Y on Deck A → partner sees Y, audio still plays X
- Host loads Z on Deck A → host sees Z, partner still sees Y
- State sync is unreliable/one-way
- Severity: CRITICAL

Bug 4 — Partner cannot hear audio from Deck B
- Host loads track on Deck B, host hears audio
- Partner hears nothing from Deck B
- Severity: CRITICAL

Bug 5 — SYNC button non-functional
- Clicking SYNC produces no observable BPM matching
- Decks had 121.1 and 122 BPM — clear sync target
- Severity: HIGH

Bug 6 — BIDIRECTIONAL audio routing failure (NEW in session 2)
- Host loads track → partner can't hear it
- Partner loads track → host can't hear it
- Neither direction works
- Severity: CRITICAL — core platform value broken

CRITICAL ASSESSMENT CHANGE:
VISION_5 previously said master was "dogfood-ready for one DJ
partner on 50-150 tracks." That assessment was WRONG. Solo
functionality works. Multi-user collab is non-functional.

ROOT CAUSE HYPOTHESIS:
Bugs 1, 2, 4, 6 cluster around audio + state crossing the
WebSocket/streaming boundary between browsers. Likely related:
- Audio may not actually be streaming between browsers
- State replication may be one-way or have race conditions
- Deck ownership/authority model may be confused

NEXT PRIORITIES:
1. Debug audio routing layer first (Bug 6) — core platform value
2. Debug state sync layer (Bug 3) — needed for reliability
3. Fix partner deck access (Bugs 1, 2) — likely flow from #1
4. Fix SYNC (Bug 5) — separate investigation
5. ALL DESIGN WORK PAUSED until multi-user collab works

=================================================================
ARCHITECTURE DECISIONS (May 4 + May 6-7 + May 7)
=================================================================

Shared-decks model: both DJs see the same Deck A and Deck B. Whoever loads
a track most recently OWNS it (their AudioBuffer drives audio; partner gets
the file's audio via WebRTC). Either DJ can fire transport on either deck.
Partner pressing play sends toggle_request to the owner who actually drives
the audio engine. UI state mirrors both ways via the existing deck_update
field-by-field broadcast.

Product framing: "back-to-back DJing, online." Partner B might play 3 songs
in a row before A plays again; both DJs need control of both decks since
there are only two decks in the session.

Playhead sync model (May 6-7 insight): when both DJs see the same playing
track, the playback rate is BY DEFINITION 1.0 against real time. So the
visible playhead rate on the receiver side equals exactly 1 / track_duration_ms,
NOT a value derived from packet timing. Network jitter is irrelevant to
rate — it only affects when the BASELINE position should be corrected.
Asymmetric handling (forward = accept, backward-within-tolerance = ignore)
ensures B2 never gets pulled backward by a delayed packet, so motion stays
strictly monotonic and visually smooth.

Session routing & rejoin (May 6-7 late insight): the entry point is
URL-driven and localStorage-backed. main.jsx Root computes initialPage
from ?room= presence (lobby vs landing). After join() runs, cm_session
is persisted. On any subsequent mount, the auto-rejoin useEffect checks
URL params first (?room=&name= for library-app handoff), then localStorage
(refresh-during-session). leave() clears cm_session so post-leave refresh
returns to Landing as expected. URL params get stripped from the address
bar after either path — localStorage becomes the source of truth once
joined.

Library import & analysis (May 6-7 late insight): import is intentionally
shallow — parseID3, opfsStore, cmDbPut. Heavy work (decodeAudioData, BPM
analysis, waveform peak generation) is deferred until a track is actually
loaded onto a deck. This bounds memory pressure to one track at a time
even with thousands in the library. The deck-side BPM analyzer runs in
parallel with the library-side analyzer when a track loads — wasteful but
correct, and bounded.

Library memory & durability (May 7 insight): two orthogonal axes failed
silently and had to be fixed together for the library to be usable.
(1) Durability — default OPFS storage is evictable. Without a persistent
storage request, Chrome may discard hundreds of imported tracks under
quota pressure. Always call `navigator.storage.persist()` before relying
on long-lived browser storage, and `await` writes in import loops so
silent failures surface. (2) Memory — embedded ID3 artwork is the
dominant per-track cost (~666 KB raw vs ~10-20 KB compressed). Aggressive
downscale (200×200 JPEG @0.7) on import keeps thumbnails crisp while
collapsing the per-track cost ~35×. Together these turn library scale
from "OOM at 266 tracks" into "linear at ~1.3 MB/track, viable to
thousands."

=================================================================
TESTING SCOREBOARD
=================================================================

Live app verified across sessions: Sunday Sunrise (snaps to 124, key 11A),
01 Retro (124), Starseed (121 via crossValidated), Atlas (122),
Lucida, Spektre, Tunnel, 06 Asphodel — all working.

Slight-offset (kick body vs click physics, NOT a bug — acoustic delay):
Welcome to You, Eternal Journey.

Harness (3 tracks): 01 Alive Again (122), 03 Aliens (120),
Astronauts Nightmares (123) — all snap via periodIntegerLocked.

Phase 2 verified end-to-end: two browsers in same room, all 8 transport
scenarios pass — B2 click play/pause/cue/scrub on owned and unowned decks;
B1 reverse direction; local-only workflow on B1; Phase 2 DJ-driving
direction preserved.

Slice 1 spectator view verified: track title, artist, BPM, key, duration
all display on partner's Deck panel after DJ loads.

May 6-7 verified end-to-end TWO-BROWSER session for the first time:
- Audio flows from DJ-A's local speakers
- Both DJs see synchronized track metadata
- Both DJs see same waveform shape
- Either DJ can drive transport on either deck
- Visual playhead on partner side stays in time with B1
- Smooth playhead motion, no visible stutter
- Audio survives partner refresh / reconnect cycles

May 6-7 late session also verified:
- Invite-link flow: host creates Mix, copies link, invitee opens link →
  joins same room as same Mix. Both browsers connect, audio works,
  transport works, smooth playhead.
- Refresh-rejoin: Cmd+R mid-session lands back in same Mix without bouncing
  to Landing. LEAVE → Cmd+R correctly returns to Landing.
- Library import (small batches): drag-drop files / folder, ADD MUSIC
  button, ID3 extraction, filename cleanup, dedup detection + modal.
- OOM fix: 322-track import no longer crashes Chrome (was crashing prior
  to commit 63ac7f9).

May 7 evening verified:
- Library persistence: tracks survive a full Chrome quit/restart, not
  just a tab refresh. `navigator.storage.persist()` returns true after
  first import. Awaited opfsStore means metadata and bytes stay in sync.
- Artwork compression: 135-track library uses 182 MB resident (was on
  track for ~3 GB pre-fix). Artwork still visibly populated in track
  rows; some non-square sources show minor cover-fit framing (flagged
  as polish, not breaking).

=================================================================
KNOWN OPEN ISSUES
=================================================================

NEW (May 7 evening) — NEXT-SESSION PRIORITIES (in priority order):

1. **Track list virtualization** (HIGH for public launch). Even with
   compressed artwork, rendering 500+ DOM rows simultaneously degrades
   scroll performance. Needs react-window or similar windowing library.
   Critical before opening to public users with arbitrary library sizes.

2. **Artwork cover-fit math.** Some non-square source art crops awkwardly
   during compression — visible as "half artwork showing" on certain
   tracks. Polish issue, not breaking. Adjust the canvas drawImage
   cover-fit calculation in `downscaleArtwork` (probably needs
   contain-fit-with-blur-pad or a smarter aspect handler).

3. **Click-to-load picker fallback UX.** When the OPFS file is missing,
   `handleLibLoad` falls through to the file picker silently. With
   awaited `opfsStore` now in place this should be rare, but a
   "track audio missing — locate file?" prompt would be clearer than
   silently opening a picker.

4. **Pre-fix tracks still hold full-size artwork.** Tracks imported
   before commit 38f23ee retain full ID3 APIC bytes. Could add a
   one-time "re-compress library" pass on app load, but simplest is
   to just re-import. Document for users.

5. **No delete-tracks UI.** Users currently have no way to remove
   tracks from their library. Needed before launch.

6. **Import safety / progress UI.** For users importing 500+ tracks,
   show progress and don't allow runaway imports without warning.

7. **No manual "Analyze Library" path** — auto-queue on app load was
   removed (was the OOM cause). Legacy unanalyzed tracks only get
   analyzed by being loaded onto a deck. Should add an explicit
   "Analyze All" button so users can backfill BPM/key when they have
   time. `analyzeAll(getFileFn)` in useLibrary already exists — just
   needs a button + click handler.

CARRIED FORWARD FROM EARLIER MAY 6-7:
- Phantom loop on zoomed waveform clicks. Repro: while playback is active,
  click around on the zoomed waveform across both browsers a few times. At
  some point the deck enters a 1-second loop (e.g., 1:25 → 1:26). Pressing
  play/pause doesn't break it. Hot cue buttons set cues but don't break
  the loop. Workaround: hard refresh. Suspected: AnimatedZoomedWF
  onSeek/onClick inadvertently sets lr2.start, lr2.end, and lr2.active in
  some interaction sequence.
- Initial playhead sync has subtle warm-up — catches up over first few
  seconds rather than syncing immediately. Minor polish.
- WF_W=24000 visible quality is acceptable but a bit blocky. User noted
  "looks a little amateur." Now that we know jitter wasn't bandwidth-bound,
  could go higher (32000 or 48000) safely, OR keep at 24000 and improve
  render quality (smoothed bars).

CARRIED FORWARD FROM EARLIER SESSIONS:
- Mirror effect noise — diagnostic logs showed setPlay firing 60+ times
  per second with the same value during playback. Performance opportunity:
  guard with `if (nowPlaying !== play)` before calling setPlay.
- Simultaneous-press hazard for toggle_request — DJs both pressing play
  within ~50ms can end up in opposite states. Fix is to broadcast absolute
  play_state {playing: true|false} instead of toggle.
- Mystery: onClick={local?toggle:(remoteToggle||undefined)} ternary form
  fails for partner-mode buttons; inline arrow wrapper works. Workaround
  in place. Revisit if curious.
- Hot cues can't be deleted from UI (state can be cleared via right-click
  context but no obvious delete button)
- Kick body vs click visual offset on some tracks (acoustic physics)
- Manual nudge UI for Deck B (state added Apr 28, no buttons wired)
- Analyzer fires twice per track load (efficiency, not correctness)
- Hot cues missing on zoomed waveform
- Hot cues no number labels
- Library defaults to "Recently Played" instead of "All Tracks"
- Pre-existing fontSize duplicate-key warning at line 1613 (build warning,
  non-blocking)

Strategic backlog:
- Manual beat-grid nudge UI (rekordbox-style override)
- Bulk-test analyzer with 15-20+ tracks via harness
  - Build out ground-truth.json from rekordbox values
- Spectator artwork (broadcast small thumbnail data URL or content hash)

RESOLVED THIS SESSION (May 6-7):
- ✅ WebRTC audio routing — DJ's local speakers no longer silent on
  partner connect (was the May 4 BLOCKER, fixed in commit 3268c2f)
- ✅ Catch-up jitter during continuous partner playback (was a Phase 2
  follow-up, fixed in commit 7781f83)
- ✅ Hardcoded room IDs / no shareable invite links (fixed in 7a2fd25)
- ✅ Mock library populates when empty (replaced by empty-state CTA in 63ac7f9)
- ✅ Refresh-during-session bounces to Landing (fixed in 63ac7f9)
- ✅ OOM on bulk import (fixed in 63ac7f9 — deferred analysis)

RESOLVED MAY 7 EVENING:
- ✅ Library state↔IDB desync under load — Chrome was evicting OPFS data
  on the default storage tier. Fixed in 82fd5c6 by requesting persistent
  storage and awaiting opfsStore writes.
- ✅ No persistent storage request — added in 82fd5c6.
- ✅ OOM at moderate library scale (~6 GB at 266 tracks) — fixed in
  38f23ee by compressing ID3 artwork to 200×200 JPEG @0.7 on import.
  ~35× memory reduction; verified at 135 tracks / 182 MB.

=================================================================
DOGFOOD READINESS
=================================================================

UPDATED May 13 evening — see DOGFOOD SESSIONS section above for full
findings from first real B2B test with Jake.

CURRENT STATUS: Solo DJ works. Multi-user collab (audio routing,
state sync, partner deck control) is NON-FUNCTIONAL. Not
dogfood-ready until fixed.

Storage blockers from earlier remain cleared (these were necessary
but not sufficient):
- ✅ Library data loss across browser restarts (82fd5c6)
- ✅ OOM crash at moderate library size (38f23ee)

Previous assessment (NOW SUPERSEDED): "dogfood-ready for one DJ
partner on 50-150 tracks." That was wrong — it was based on solo
testing only. First real two-browser session (May 13) revealed
multi-user collab is broken end-to-end.

=================================================================
RECOMMENDED FIRST ACTIONS NEXT SESSION
=================================================================

In priority order:

1. **Cover-fit math fix** (small) — adjust `downscaleArtwork` so
   non-square source art doesn't crop awkwardly. Probably swap
   cover-fit for contain-fit with letterbox, or a smarter aspect
   handler.

2. **Track list virtualization** (medium) — react-window. Probably
   1-2 hours including testing. Removes the last hard limit on
   library scale.

3. **Delete tracks UI** (small) — users need a way to remove tracks
   from their library before any public exposure.

4. **Re-test at 500+ tracks** — verify projected memory scaling
   (~700 MB) holds and scroll/import perf is acceptable with
   virtualization in place.

5. **Dogfood with a real DJ partner** on a 50-150 track library.
   Real use will surface what to fix next. Test scenarios: track
   handoff, EQ matching on incoming tracks, cue points, beat-grid
   alignment under live conditions, network latency tolerance.

6. **Add "Analyze All" button** to library panel — wire to existing
   `lib.analyzeAll(getFile)`. Quick addition, surfaces the existing
   one-at-a-time analyzer to users for legacy tracks.

7. **Click-to-load picker fallback UX** — replace silent file-picker
   fallback in `handleLibLoad` with an explicit "track audio missing
   — locate file?" prompt.

8. **Phantom loop bug** — once stability is solid, audit
   AnimatedZoomedWF click handlers and any drag-to-set-loop gestures.

9. **WF_W resolution decision** — bump to 48000 for better
   partner-side waveform quality, OR improve render with smoothed
   bars.

=================================================================
WORKING RULES
=================================================================
- ALWAYS edit src/collabmix-production.jsx for app code; analyzer
  changes go in src/bpm-worker-source.js (both app and harness pick
  it up)
- For server changes, edit /Users/chad/Desktop/collabmix-server-repo
  (the git copy). Push to GitHub triggers Railway auto-deploy.
- Test on production URL (collabmix.vercel.app), not localhost
- Investigate before editing for ambiguous tasks
- One change at a time, deploy, verify, then commit
- Roll back fast when a fix regresses something — don't ship a
  broken state while diagnosing
- Tagline filter: does this make "back-to-back DJing, online" better?
- When user's domain reasoning contradicts technical framing, user is
  usually right
- Trust ear-based ground truth — when kicks audibly hit on markers,
  audio is right even if visual looks off
- For DSP investigation, ALWAYS get rekordbox/Traktor BPM as second
  source of truth before chasing precision bugs
- For React event-handler bugs that defy code reading, instrument
  with console logs at the click site and the handler entry
- For sync bugs: when both sides see the same playing track, derive
  rate from track duration, NOT from packet timing. Network latency
  is irrelevant to rate; it only affects when to correct the baseline.
- For WebSocket disconnect logic, ALWAYS guard cleanup operations on
  whether the resource was actually established. Chrome's silent
  disconnect-all behavior on null arguments is a sharp edge.
- For library import / heavy per-track work: defer everything possible
  until the user actually loads a track onto a deck. Don't queue 100s
  of files for analysis at import time — File references pin blobs
  in RAM until processed. Bulk decode at scale = OOM.
- For storage that needs to survive: call navigator.storage.persist()
  before relying on OPFS or IDB at scale. Default storage tier is
  evictable.

=================================================================
INSTRUCTION FOR NEW CLAUDE
=================================================================
"Continuing work on Mix//Sync. Previous chat hit context limits.
Please confirm you understand where we left off. The May 7 evening
session shipped two commits that cleared both critical dogfood
blockers: library persistence (82fd5c6) added
navigator.storage.persist() and made opfsStore writes properly
awaited so libraries survive Chrome quit/restart cycles, and artwork
compression (38f23ee) downscales ID3 artwork to 200×200 JPEG @0.7
on import for ~35× per-track memory reduction (135 tracks now uses
182 MB; pre-fix was on track for ~3 GB at that scale). The two
critical blockers (data loss, OOM) are now fixed — app is dogfood-
ready for one DJ partner on 50-150 tracks. NEXT priorities (in
order): cover-fit math fix for non-square artwork, track list
virtualization (react-window), delete-tracks UI, re-test at 500+
tracks, then dogfood with a real DJ. Public beta still needs
virtualization + delete + import safety + cover-fit polish first."
