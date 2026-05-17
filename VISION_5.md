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

MAY 13 LATE EVENING — Bug 6 FIXED (3 commits, deployed to production):
21. Auto-start + reconnect + status indicator (commit 397c62d)
    - useRTC: console instrumentation throughout, explicit play() in
      ontrack with autoplay-blocked detection, document-level one-shot
      click handler that retries play() on next user gesture.
    - Parent: useEffect on sync.partner change schedules startCall after
      500ms; rtc_hangup branch in handleWS schedules retry (3 attempts,
      1s delay); reconnect counter resets on rtc.state==="connected".
    - Top bar: AUDIO status pill (OFFLINE / CONNECTING… / STREAMING /
      FAILED) replacing the prior LIVE-only badge.
    - Banner below top bar when autoplay is blocked.
    - Manual START STREAM button retained as fallback.
22. Role election + glare-safe handleAnswer + DOM-attached audio (850c952)
    - First preview hit WebRTC offer/answer glare: both browsers fired
      startCall, both sent offers, both processed each other's offers as
      answerers, then InvalidStateError on the original answers.
    - isInitiatorRole helper: lexicographic name compare; same-name
      fallback to URL ?room= presence (host = no param = initiator).
      Only the elected initiator calls startCall; answerer waits for
      incoming offer. Same gate applied to rtc_hangup retry.
    - handleAnswer: catch InvalidStateError specifically and treat as
      benign (peer already stable from glare-resolved remote offer).
    - ontrack: append remote <audio> element to document.body
      (display:none) — some browsers won't drive playback for detached
      <audio> elements with srcObject.
23. TDZ hotfix (commit ac1da26)
    - 850c952's first preview was a blank page: useEffect mirroring
      isInitiatorRole into a ref was declared BEFORE the useCallback
      that defined the helper. React's deps-array evaluation hit the
      temporal dead zone at first render. Pure reorder fix.

VERIFIED: bidirectional audio routing between two Chrome windows, no
glare errors, AUDIO pill transitions OFFLINE → CONNECTING → STREAMING.

REMAINING from May 13 dogfood — Bugs 1, 2, 3, 5 still broken:
- Bug 1: Library row click hardcoded to Deck A (everyone, not just partner)
- Bug 2: Partner click-to-load on Deck B empty state — needs reproduction
- Bug 3: Deck state desync between browsers (mirror gate at :3269)
- Bug 5: SYNC button silently no-ops when target BPM is partner's only

All four are downstream of the missing deck control model. Driver model
implementation (see DECK CONTROL MODEL section) is the next session.

=================================================================
MAY 13-14 OVERNIGHT SESSION — MULTI-USER COLLAB FIXES
=================================================================

WHAT SHIPPED TO PRODUCTION (collabmix.vercel.app):

Bug 6 — Audio routing FIXED (commits 397c62d, 850c952, ac1da26)
- WebRTC auto-starts on partner_joined (no more manual START STREAM
  button required)
- Role election: lexicographic name comparison decides initiator vs
  answerer to prevent glare
- Glare-safe handleAnswer: catches InvalidStateError when both sides
  offered simultaneously
- DOM-attached remote audio element so browser playback actually fires
- Auto-reconnect on rtc_hangup with 3-retry cap
- Autoplay banner fallback for browsers that block initial audio
- Status pill in top bar: OFFLINE / CONNECTING / STREAMING / FAILED

Bug 5 — SYNC button FIXED (commit e6ae5ae)
- Uses partner BPM fallback (pA/pB) when local analyzer hasn't run
- Broadcasts rate changes via deck_update
- Disabled state with tooltips when SYNC isn't available

SYNC IMPROVEMENTS:
- Phase alignment using bar fractions (4-beat bars), not single beats
  (commits 2e40644, then bar math in 37ab4cb)
- Analyzing state visual on SYNC button (amber pulse) while BPM is
  being computed (commit 6fb856a)
- Toggle behavior: click engages, click again releases (commit 83879aa)
- Global lock model: ONE click syncs BOTH decks (Beatport B2B pattern)
  (commit 8f5d6f7)
- Auto re-sync when slave or master deck is scrubbed (commit 37ab4cb)
- Master/slave visual differentiation: master deck shows "MASTER"
  outlined, slave shows "SYNC" filled green (commit 37ab4cb)
- BPM display shows pitch adjustment percentage (+2.1% / -1.8% with
  color thresholds) (commit 37ab4cb)
- Infinite re-sync loop fixed: prev-bpm gate + 1s throttle
  (commit cae2a4b)

PRODUCTION STATUS:
- Bundle: main-5Yyar07J.js
- All commits live on collabmix.vercel.app
- Stale 6-day-old production bundle replaced with current code
- Discovery during session: GitHub push does NOT auto-deploy to
  production. BUILD_AND_PUSH.command (vercel --prod --yes) is the
  canonical promotion path. Production had been stuck on a 6-day-old
  bundle until we ran the script.

KEY ARCHITECTURAL DECISIONS LOCKED:

1. DECK CONTROL MODEL (locked earlier in session, see DECK CONTROL
   MODEL section): Shared decks with implicit driver takeover. NO
   ownership, NO permissions, NO confirmation prompts. Any action on
   a deck makes that user the driver. This is locked, do not revisit.

2. SYNC MODEL: Single global lock. ONE click on either deck's SYNC
   button engages sync on both. Clicked deck becomes SLAVE, other
   becomes MASTER. Click either again to release. This is the
   Beatport B2B pattern.

REMAINING KNOWN ISSUES (for next session):

1. Audio skip on sync engage. Seek implementation destroys and
   recreates AudioBufferSourceNode every seek. Smooth seek (brief
   rate manipulation instead of jump) is the proper fix. ~1-2 hours.

2. Master deck auto-assignment is implicit and confusing. Plan: add
   explicit "M" button per deck for manual master selection. Default
   master = currently-playing deck if no explicit selection.
   ~30-60 min.

3. Sync alignment not perfectly tight. Multiple potential causes:
   - Beat grid inaccuracy on individual tracks (analyzer's
     crossValidated=false on some)
   - Drift after sync engages (no continuous tempo lock)
   - Downbeat assumption: "first detected beat = bar 1 beat 1"
     sometimes wrong for tracks with intros
   - Phase calculation has small timing slack between click and
     seek apply

4. Beat grid editing UI doesn't exist. Pro DJ tools have manual beat
   grid editing (half/double BPM toggle, beat offset nudge,
   click-to-set first beat). This is what fixes case 3 root cause.
   ~3-5 hours.

5. Bugs 1, 2, 3 (multi-user state desync, partner can't load Deck B)
   still broken — these need the DRIVER MODEL implementation.
   ~3-5 hours.

6. Sentry not yet set up. Earlier in session: started, paused on
   master/main branch confusion (now resolved — master is production).
   Pick back up cleanly. ~30-40 min.

NEXT SESSION PRIORITY ORDER:

1. Explicit master selector (M button per deck) — small win, removes
   confusion
2. Beat grid editing UI — the real fix for "not perfectly synced"
3. Smooth seek (audio quality polish)
4. Driver model (Bugs 1, 2, 3 — multi-user state) — biggest remaining
   impact
5. Sentry setup — instrument before next dogfood
6. Next dogfood session with partner once above lands

ALL DESIGN EXPLORATION WORK (design-warm, design-booth, design-decks
branches) STILL PAUSED until multi-user collab fundamentals are solid.

=================================================================
MAY 16 OVERNIGHT SESSION — SYNC HARDENING + OBSERVABILITY
=================================================================

WHAT SHIPPED TO PRODUCTION (collabmix.vercel.app):

SYNC system completed:
- M button per deck for explicit master selection (commit a6f38e0)
- M button is metadata-only — never touches audio rates (commit 13a802e)
- Auto-master detection: when SYNC clicked without explicit master,
  picks the deck that started playing first (commit 13a802e)
- Stale BPM display fix: track load now resets rate to 1.0 and
  updates display (commit 347ed93)
- Sync uses master's EFFECTIVE BPM (natural × rate), not natural
  BPM (commit 347ed93)
- 200ms re-entry guard on SYNC toggle (commit 347ed93)
- Session tempo as locked target: once SYNC engages, the master's
  effective BPM at that moment becomes the locked session tempo
  (commit 2ae6657)
- Both decks track session tempo across track changes (commit
  2ae6657)
- Slave auto-syncs when its track changes while locked (commit
  2ae6657)
- Master keeps session tempo when its track changes while locked —
  new track rate-adjusts to session tempo, no audible tempo shift
  (commit 2ae6657)

Sentry instrumentation:
- Full Sentry SDK integrated: error tracking, session replay,
  breadcrumbs (commit 45085be)
- Breadcrumbs at track load, play toggle, WS open/close, RTC state,
  room join, SYNC toggle
- Session context tags: dj_name, room_code, ping_bucket, is_host,
  has_partner
- Cmd+Shift+E test error shortcut for verification
- Sentry project slug corrected from "mixsync" to "javascript-react"
  (commit bd2b138)
- Source maps now uploading correctly on every Vercel build
- Verified: production errors show full symbolicated stack traces
  with real source code visible

Deploy workflow fix (huge win):
- Identified that Vercel's Production Branch was set to "main"
  while we push to "master"
- Changed Vercel project setting: Production Branch is now "master"
- Result: every git push to master now auto-creates Production
  deployment
- BUILD_AND_PUSH.command no longer needed (avoid using it — it
  hangs on vercel login OAuth)
- Standard deploy workflow going forward: Claude Code commits +
  pushes, Vercel auto-deploys, ~2-3 min total
- Saved roughly 20-30 min per deploy cycle going forward

PRODUCTION STATE AT SESSION END:
- URL: collabmix.vercel.app
- Latest commit on origin/master: bd2b138 (Sentry slug fix)
- All commits live in production
- Backend (Railway) upgraded to Pro plan ($20/mo)
- Sentry dashboard: https://mixsync.sentry.io/issues/

KEY ARCHITECTURAL DECISIONS LOCKED:

1. DECK CONTROL MODEL (from previous sessions): Shared decks with
   implicit driver takeover. NO ownership, NO permissions, NO
   confirmation prompts. Locked, do not revisit.

2. SYNC MODEL: Single global lock. ONE click on either deck's SYNC
   button engages sync on both. Beatport B2B pattern. Auto-master
   detection from play-start time, M button override available.

3. SESSION TEMPO MODEL (new this session): When sync is locked, the
   session tempo is sticky. BOTH decks (master and slave) track
   session tempo regardless of role. Loading a new track on either
   deck auto-aligns to session tempo. This is more intuitive than
   typical pro DJ tools where loading on master jumps the whole mix
   tempo — better for remote B2B context.

4. DEPLOY WORKFLOW (new this session): git push to master =
   automatic production deploy. No CLI scripts needed.

KNOWN ISSUES STILL OPEN:

1. Audio skip on sync engage and on bar-level seeks.
   AudioBufferSourceNode destroy-and-recreate seek causes audible
   pop. Needs smooth seek (brief rate manipulation crossfade).
   ~1-2 hours.

2. Beat grid alignment not perfectly tight even when math is
   correct. Causes:
   - Beat grid inaccuracy on tracks where analyzer's
     crossValidated=false
   - Drift after sync engages (no continuous tempo lock)
   - Downbeat assumption ("first detected beat = bar 1 beat 1")
     wrong on tracks with intros
   The real fix is beat grid editing UI — let user manually adjust
   where beat 1 is on each track. ~3-5 hours.

3. Beat grid DISPLAY doesn't exist yet. Currently only a red line
   through waveform. Need premium edge-marker style
   (Beatport-direction): small ticks above/below waveform at each
   beat, brighter at downbeats, identity color at phrase markers.
   NO through-waveform lines by default. Hover/scrub state could
   show full lines temporarily for precision. Required prerequisite
   for beat grid editing. ~1-2 hours.

4. Bugs 1, 2, 3 (multi-user state desync, partner can't load Deck B)
   still broken. Need DRIVER MODEL: per-deck driver tracking, audio
   source swap on driver change, visual driver indicator, library
   panel fix so partner can load either deck. ~3-5 hours.

5. SYNC double-fire pattern observed in logs (toggle ON fires
   twice). Re-entry guard added defensively but root cause not
   identified — possibly WebSocket round-trip race or browser event
   anomaly. Watch for it post-driver-model.

6. Waveform visual polish needed for premium look. Tied to design
   pass discussion below.

NEXT SESSION PRIORITY ORDER:

1. Beat grid display (premium edge-marker style) — the real next
   step
2. Beat grid editing UI — fixes alignment for real
3. Driver model — fixes Bugs 1, 2, 3 (multi-user state desync)
4. Next dogfood session with partner Jake (Sentry-instrumented, all
   the above live)
5. Smooth seek (audio quality polish)
6. After dogfood validates platform works: real design pass

DESIGN DIRECTION CAPTURED (for eventual design pass — NOT for
tonight, NOT for next session):

User aligned with Scandinavian-modern aesthetic direction for
eventual design overhaul:
- Deep warm-black surfaces (not pure #000 — has slight warmth,
  "ink" rather than "OLED off"), around #0B0908 family
- Warm dark grays in panel chrome (#1C1816 family) — matte stone,
  not plastic
- Pale "oak" accent (#C9B79C-ish) used sparingly: master indicators,
  key labels, time displays — NOT big surfaces
- Warm amber (#E8A87C-ish) for active states like play/sync-lock
- Deck identity colors stay vibrant but slightly desaturated to fit
  palette
- Clean humanist sans typography (Inter or Söhne family). Not
  condensed, not geometric.
- Generous spacing, thin quiet edges, no glassmorphism, no neon, no
  chrome gradients
- NO wood textures, NO skeuomorphic materials — capture material
  FEELING through palette and restraint only

Direction: apply this Scandi-modern palette/material treatment ON
TOP of design-decks branch's structural decisions (twin stacked
waveforms, album-art decks). Combine the structural work and the
aesthetic in one coherent pass.

All design exploration work (design-warm, design-booth, design-decks
branches) STILL PAUSED. Resume only after driver model + dogfood
validates platform works.

SESSION TIME ESTIMATE:
- Tonight: ~12 hours active work
- Across the two May 13-14 + May 16 sessions: probably equivalent
  to 3-4 weeks of conventional senior engineering team output
- Major deploy workflow fix discovered (vercel branch tracking)
  will save 20-30 min/deploy going forward

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
DECK CONTROL MODEL — locked May 13
=================================================================

DECK CONTROL MODEL: SHARED DECKS WITH IMPLICIT DRIVER TAKEOVER

Both users have full control of both decks at all times. No ownership,
no permissions, no confirmation prompts.

DRIVER ROLE:
The "driver" of a deck is whoever last performed any action on it.

Actions that transfer the driver role:
- Load track
- Play / pause
- Scrub / seek
- BPM change (sync, manual adjust)
- Loop set / clear
- Cue trigger / set / clear
- EQ adjust (GAIN, HI, MID, LOW, filter)
- Any other deck mutation

DRIVER BEHAVIOR:
- Driver's browser plays the audio locally for that deck
- Driver's WebRTC stream carries that deck's audio to the partner
- Non-driver's browser does NOT play local audio for that deck
- Non-driver hears that deck via WebRTC from the driver
- Non-driver's UI mirrors driver's state (track, position, BPM, EQ) via WebSocket

DRIVER TRANSITION:
- Any action by the non-driver instantly makes them the new driver
- Old driver's local audio for that deck stops
- New driver's local audio for that deck starts (from the position synced)
- WebRTC stream automatically picks up new driver's output
- NO prompts, NO confirmations, NO popups, NO permission requests
- Seamless audio handoff (target: <100ms gap)

VISUAL FEEDBACK:
- Identity colors already in the design (blue = host, violet = partner)
  extend to indicate driver
- When YOU are driving a deck, that deck's top border glows with YOUR color
- When PARTNER is driving a deck, that deck's top border glows with
  PARTNER's color
- No text labels, no badges — purely visual

EDGE CASES:
- Simultaneous actions on same deck: last-write-wins via server timestamp
- Driver disconnects: deck pauses, partner can take over by performing
  any action
- New partner joins: deck states sync to whoever's been driving

REFERENCE: Beatport B2B uses this model. It is the standard expectation
for online B2B DJing.

THIS DECISION IS LOCKED. Future sessions should NOT revisit "should
there be an ownership model" — the answer is permanently no. Shared
control with implicit takeover is the model.

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

UPDATED May 13-14 overnight — Bug 6 (audio routing) AND Bug 5 (SYNC)
both fixed in production. Bundle main-5Yyar07J.js. See MAY 13-14
OVERNIGHT SESSION section above for the full commit list and the
SYNC improvements (global lock model, bar-fraction phase alignment,
master/slave indicators, scrub auto-resync, BPM rate display).

CURRENT STATUS: Solo DJ works. Multi-user audio routing works. SYNC
works cross-browser with phase alignment. Multi-user STATE sync and
partner deck control (Bugs 1, 2, 3) are STILL broken. Not dogfood-
ready until the driver model lands.

Cleared blockers:
- ✅ Library data loss across browser restarts (82fd5c6)
- ✅ OOM crash at moderate library size (38f23ee)
- ✅ WebRTC audio routing (Bug 6 — fixed May 13 late evening)
- ✅ SYNC cross-browser (Bug 5 — fixed May 13-14 overnight)

Outstanding blockers for dogfood:
- ❌ Bug 1: Library row click hardcoded to Deck A
- ❌ Bug 2: Partner click-to-load on Deck B empty state (needs repro)
- ❌ Bug 3: Deck state desync between browsers

Path forward: implement the DECK CONTROL MODEL (shared decks with
implicit driver takeover, locked May 13). All three remaining bugs
collapse into the driver-model implementation.

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
