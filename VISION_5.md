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
MAY 16-17 LATE NIGHT SESSION — DRIVER MODEL + SHARED MIXER +
ANALYZER ACCURACY PROBLEM IDENTIFIED
=================================================================

WHAT SHIPPED TO PRODUCTION (collabmix.vercel.app):

Beat grid display (premium edge-marker style):
- Three-tier hierarchy: off-beats (every beat), downbeats (every
  4 beats, white with through-line), phrase markers (every 16
  beats, deck identity color, larger ticks + stronger through-line)
- Tick rails above and below waveform with breathing room — ticks
  never overlap waveform amplitude
- Through-waveform lines on downbeats and phrase markers only;
  off-beats stay clean
- Deck identity colors for phrase markers (violet A #7B61FF,
  teal B #00BFA5)
- Iterated multiple times for visibility and proportion (commits
  6665374, 8561363, d47eaab, 95e02f8, cfea19f, 0d4aae6, 3e7131c)
- Final config: 70px canvas (both decks loaded), 18px tick rails
  + 26px amplitude pad (waveform compressed toward centerline so
  ticks float in clear space)

Driver model (multi-user collab — addresses Bugs 1, 2, 3 from
May 13 dogfood):
- Server-side per-deck driver state tracking
  (collabmix-server commit 318b42d)
- deck_driver_change broadcast on track LOAD; loader becomes driver
- Client driver state synced from server (commit 0edf542)
- Driver-only deck_update broadcast gate via SHARED_FIELDS
  allowlist (commit 2232c7b — partially reverted in fe0a21f to
  skip mixer fields)
- Non-driver mutes local audio output via trim.gain ramp;
  partner-driven decks come through WebRTC mix (commit 6575340)
- Track metadata propagates instantly on driver change — title,
  artist, BPM, key, duration in the deck_driver_change payload so
  partner paints immediately without waiting for loader's decode
  (commit ce632f2 client + 6b8daf5 server)
- Track-display + play/pause inversion fixes — Deck.toggle/seek/
  cue hard-gate on isDriver; non-drivers send *_request and mutate
  nothing locally; lost-driver useEffect clears local buf/name so
  remote.* takes over display (commit 979dda5)
- Shared mixer EQ / vol / filter broadcast both ways
  (commit fe0a21f) — reverted earlier per-user-mix decision, user
  wanted fully shared everything
- Master volume sync via new master_vol_update message type
  (collabmix-server commit bd1c588), A/B hover buttons always
  visible at 55% opacity (was hover-only and undiscoverable), and
  driver-propagation debug logs pending next-session diagnosis
  (commit c2e4781)

Deploy workflow:
- Vercel Production Branch changed from "main" to "master" — git
  push to master now auto-deploys to production. No more
  BUILD_AND_PUSH.command needed.
- Upgraded to Vercel Pro tier mid-session; builds now process in
  priority queue, dropped from ~2 min queue to immediate start.

KEY ARCHITECTURAL DECISIONS LOCKED:

1. DECK CONTROL: shared decks with implicit driver takeover.
   Both DJs can do anything to either deck. No ownership, no
   permissions, no prompts. LOCKED — do not revisit.

2. DRIVER MODEL: "Loader is the driver" pattern. Loading a track
   makes you the audio source for that deck. Other actions
   (play/pause/scrub/SYNC/cue) by partner relay through *_request
   control commands; driver executes and broadcasts new state via
   deck_update. NO cross-user file transfer — files stay local to
   each user. Driver transitions only on track LOAD.

3. SHARED MIXER: ALL mixer controls sync across browsers — EQ
   Hi/Mid/Lo, channel volume, gain, filter, crossfader, master
   volume. Per-user-mix model was attempted and rejected by user.
   Both DJs see and control every knob. The SHARED_FIELDS
   allowlist in dh carves out which fields bypass the driver-only
   broadcast gate.

4. LIBRARY MODEL: each user has their own library — no cross-user
   file sharing. Everyone sees track metadata on partner's loaded
   tracks. Each DJ "brings their own crates" — physical B2B
   equivalent of two USB drives.

=================================================================
CRITICAL ISSUE IDENTIFIED — TOP PRIORITY FOR NEXT SESSION
=================================================================

BPM ANALYZER ACCURACY IS BELOW INDUSTRY STANDARD.

PROBLEM: Beat phase offset (bphs values) are placing beat markers
slightly off the actual transients in the audio. User has visually
confirmed via screenshot — beat grid lines are 20-50ms off the
actual kick/snare peaks on many tracks. Industry-standard
analyzers (Rekordbox, Beatport, Serato) place beats precisely on
transients; ours does not.

The BPM detection itself appears correct (spacing between beats
matches the actual track tempo), but the PHASE — where the
analyzer thinks "beat 1" starts — is consistently off by enough
to cause audible clashing when sync engages.

User explicitly does NOT want a manual nudge UI. The analyzer
must be accurate. This is an engineering problem to solve, not a
feature gap to paper over with user controls.

LIKELY ROOT CAUSE: After detecting BPM via autocorrelation/onset
detection, the analyzer doesn't perform a final precision
alignment pass — it doesn't snap detected beats to the nearest
strong onset peak within a small search window. Detected beat
positions are quantized to coarser time resolution than the
actual audio transients.

INVESTIGATION NEEDED NEXT SESSION:
1. Read src/bpm-worker-source.js carefully — understand current
   algorithm structure
2. Identify where beat positions are finalized
3. Add a "transient snap" pass: for each detected beat, search
   within ±50ms for the nearest onset peak, snap to it
4. May also need to investigate FFT window size, onset detection
   threshold tuning
5. Verify periodIntegerLocked behavior — logs show many tracks
   lock to integer BPM even when fractional would be more accurate
6. Test across the 135 tracks in user's library to measure
   improvement

This is real signal processing work. Estimate: 3-6 hours focused.
Could take longer if the algorithm needs more fundamental rework.
Should be done with fresh eyes — not after a 15-hour session.

WHY THIS IS THE TOP PRIORITY:
Without analyzer accuracy, sync doesn't sound right, and the
platform isn't dogfoodable as a real DJ tool. All other work
(driver model, shared mixer, UI polish) doesn't matter if the
core feature — beat-synchronized B2B mixing — sounds bad. This
is the gate.

OTHER OPEN ISSUES (lower priority than analyzer accuracy):

1. Driver propagation may be asymmetric between browsers.
   Browser 1 loading new track on Deck B doesn't always reach
   Browser 2. Instrumentation added in commit c2e4781 — next
   session's two-browser test will reveal where messages drop.
   Look for [DRIVER-SEND] and [DRIVER-RECV] in browser console +
   "broadcast to peers=[...]" line in Railway server logs.

2. SYNC engine bypasses the driver gate via direct sync.send
   calls in syncDecks. Non-driver can engage SYNC on a deck.
   Edge case behavior under driver swaps is unclear — needs
   explicit two-browser test.

3. Stale local playhead on partner takeover. When a driver loses
   the deck, the lost-driver useEffect stops audio and clears
   visible state, but if they regain driver later, the old offset
   state may need reset. Future polish.

4. Name collisions break driver model. Two DJs with identical
   session.name = broken (server stores name as the driver ID and
   client compares names for self-check). Should pass a stable
   deviceId alongside name in future.

5. Audio skip on sync engage. Still using destroy-and-recreate
   AudioBufferSourceNode for seek. Needs smooth seek
   implementation (brief rate manipulation crossfade). ~1-2 hours.

6. Library row hover A/B buttons — Claude Code says they're now
   always visible at 55% opacity. Verify in next-session test.

NEXT SESSION PRIORITY ORDER:

1. FIX BPM ANALYZER ACCURACY (THE GATE). Read the worker source,
   understand the algorithm, add transient snap pass, possibly
   tune FFT window and onset thresholds. Until this is fixed,
   dogfood is not meaningful.
2. After analyzer is accurate: verify driver propagation works
   in two-browser test with debug logs. Fix any drop points.
3. Test SYNC behavior across browsers thoroughly under driver
   swaps.
4. Verify master volume sync and A/B hover buttons.
5. Dogfood session with partner Jake — first real multi-user
   test with accurate sync.
6. Based on dogfood: identify what else needs fixing.

ALL DESIGN EXPLORATION work (design-warm, design-booth, design-
decks branches) STILL PAUSED. Resume only after dogfood validates
platform works.

SESSION TIME ESTIMATE:
- This session: ~15+ hours active work
- Total across May 13 + May 16 + May 16-17 sessions: roughly
  equivalent to 4-5 weeks of conventional senior engineering team
  output

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
MAY 17 — WAVEFORM POLISH + BPM ANALYZER + SYNC INFRASTRUCTURE
=================================================================

### WAVEFORM SHIPPED (DONE)
- Smooth filled envelope replacing blocky bars (commits 2287bd6 through
  e04812a, ~12 commits)
- Bass-weighted env (0.7 bass + 0.2 mid + 0.1 high), renormalization,
  gamma 1.4
- Additive lift for drops (env > 0.7 columns), no floor
- Canvas geometry: wfH=120, ampPad=28, maxH≈31.5 css
- Selective curve smoothing with steep-rise sharp edges
  (STEEP_THRESH = maxH * 0.15)
- Beat grid markers have clean ~20px separation from waveform peaks
- Both decks identical rendering (single function AnimatedZoomedWF,
  only deckColor differs)
- AA stroke around path for sub-pixel smoothness

### WAVEFORM — REMAINING POLISH (NEXT SESSION)
User clarification on kick transient shape:
- Goal: kicks should look like a triangle laid on its side
- LEFT edge of kick = near-vertical wall (attack moment, completely
  flat-to-vertical rise)
- RIGHT side = slopes down gradually as kick decays
- Currently: steep-rise detection at 0.15 threshold creates sharper
  edges but LEFT edge still slightly rounded
- Want: attack edge should look like a perfectly vertical line

Investigation paths for next session:
1. Asymmetric edge detection: force flat lineTo on LEFT side of rise,
   smooth slope on right
2. Multi-column attack handling: detected kicks draw left edge as
   single vertical line
3. Pre-attack flat baseline: ensure column before kick is at exact
   baseline

### BPM ANALYZER WORK

Per-beat kick snap pass shipped (commits 88df063 through 5532546):
- ±100ms search window
- Kick-exclusive onset (onK - onP) for snap targets
- First-rise rollback at 40% threshold to find attack moment, not peak
- Safety gate: only rollback when argmaxVal > 2 × SNAP_THRESH
  (prevents weak-kick false rollbacks)
- Monotonic constraint prevents reordering

Symmetric crossValidated thresholds (commit c277a9f):
- Changed from |bpm - bpmFromPeriod| < 0.07 to
  |bpmFromPeriod - intBpm| < 0.25 (symmetric with first check)
- DRIFT ELIMINATED on tracks where both BPM estimators agree within
  ±0.25 of integer
- Home In The Sky now snaps to integer 121 BPM

Sample-level transient refinement shipped (commit d07b92f):
- Replaces frame-resolution snap with sub-sample precision
- Per-beat ±50ms window in raw audio samples (44.1kHz resolution)
- Bandpass 40-200 Hz + power envelope (1.5ms smoothing) +
  half-wave-rectified derivative
- Parabolic interpolation around argmax for sub-sample precision
- Three confidence gates: silence, no-transient ratio, edge-of-window
- Monotonic guard preserved
- New parallel dpBeatsFloat[] array holds fractional frame positions
- Algorithm refines 96-99% of beats successfully
- Theoretical accuracy: ±1-2ms on most tracks
- Kill-switch available: USE_LEGACY_FRAME_SNAP = true at top of
  refinement block

### CURRENT ANALYZER STATE (POST SAMPLE-LEVEL REFINEMENT)
- Home In The Sky: markers ~5-10ms off kick attack (improved but not
  at target)
- Sunbeam: ~5-10ms residual offset
- You Will Never Know: accurate
- Shadow Work: BEAT GRID PLACED MULTI-BEAT OFF (bar phase issue, not
  precision)
- Spektre: still slightly off when synced with Home In The Sky

### NUDGE PRIMITIVE — ABANDONED
- nudgeRate function for cross-correlation sync (commits 208efc1,
  f80250d)
- BLOCKED: function shows play:false despite audio audibly playing
- Ref-based fix did not resolve
- ABANDONED — pivoted to sample-level analyzer instead
- Code remains in place but unused
- Could be removed in cleanup

### SYNC INFRASTRUCTURE FIXES SHIPPED (commit 2772cb9)

Fix 1 — Sync drift elimination:
- Root cause: setTargetAtTime(rate, time, 0.05) was asymptotic, never
  reaching exact target
- Was leaving ~10⁻⁵ rate error → 30ms drift per 5 minutes
- Fix: replaced with cancelScheduledValues + setValueAtTime + 5ms
  linearRampToValueAtTime
- Reaches exact target value, click-free
- Residual drift now ~6ms per hour (below perception)

Fix 2 — Sync state reset on unsync:
- Root cause: rate state not reset on unsync, contaminating
  subsequent sync engages
- Plus sticky masterDeckRef from auto-detection
- Fix on unsync: setRateA(1) + setRateB(1) + broadcast rate=1 to
  partner + clear masterDeckRef + clear lastSlaveDeckRef
- Slave audibly returns to natural BPM on unsync (Rekordbox convention)
- Added [SYNC-STATE] log at start of handleSyncToggle for diagnostic

### NOT YET TESTED — NEXT SESSION FIRST
[SUPERSEDED in May 17-18 Session 4 — all three items tested and confirmed
working. Sync drift verified clean over multi-minute synced playback;
unsync state contamination resolved; many additional sync fixes shipped
on top. See Session 4 section below.]
- Sync drift fix in live testing (2+ minute play after sync engage)
- Sync state bug fix in live testing
  (sync→unsync→pause→play→re-sync sequence)
- Verify [SYNC-STATE] log shows clean state on second engage

### REMAINING ANALYZER PROBLEMS

Shadow Work multi-beat error:
[SUPERSEDED in Session 4 — investigated extensively, broader pattern
discovered: downbeat misdetection is NOT just a Shadow Work problem,
it's a systemic issue across most tracks. 4 of 4 newly-tested tracks
post-Sunbeam had wrong beat grids. Kick-exclusive scoring + phrase
voting (phSc16/phSc32) shipped; both helped marginally but neither
fixes the fundamental issue. See Session 4's CRITICAL BLOCKER section.]
- Bar phase detection (L252-276) placing beat 1 at wrong position
- Sample-level refinement can't fix (only operates within ±50ms of
  DP placement)
- Need to investigate bar phase scoring on this specific track
- Diagnostic data not yet captured

Residual ±5-10ms on Home / Sunbeam / Spektre:
- Sample-level refinement helped but not at ±1-2ms target
- Unknown whether parameter tuning or algorithm floor
- Need [REFINE-DEBUG] data from these tracks to diagnose

### NEXT SESSION PRIORITY (ORDERED)

1. Test sync infrastructure fixes — 15 min
   - Play synced tracks 2-3 min, verify no drift
   - Test sync→unsync→pause→play→re-sync sequence
   - Verify [SYNC-STATE] log shows clean state

2. Investigate Shadow Work bar phase — gather diagnostic data
   - Load Shadow Work, capture [phase] line, [BPM-SNAP], [REFINE-STATS]
   - If bestPh wrong or spread/peak below 0.25, propose fix

3. Tune sample-level refinement for ±1-2ms target on Home / Sunbeam
   - Capture [REFINE-DEBUG] for these tracks
   - Diagnose: systematic bias (tunable) vs random variance
     (algorithm floor)

4. Waveform attack edge sharpening — visual polish
   - Force vertical left edge on kick transients (triangle on its side
     shape)
   - Asymmetric edge detection or multi-column attack handling

5. Validate on broader library — 10-15 tracks across genres after
   fixes above

6. Then dogfood with Jake

### OTHER OPEN ISSUES (LOWER PRIORITY)
- Driver propagation verification in two-browser test
- SYNC engine bypasses driver gate
- Stale local playhead on partner takeover
- Smooth seek for general scrubbing (gain-ramp approach, optional)
- Nudge primitive cleanup (remove unused code)

### KEY ARCHITECTURAL DECISIONS LOCKED THIS SESSION
1. Sample-level transient detection is THE proper analyzer fix
   (not cross-correlation)
2. Cross-correlation sync abandoned — temp fix not worth the time
   [REVERSED in Session 4 — Path C kick-band cross-correlation shipped
   (commit 9b67697). FFT-based, ±2 beat search window, peak/RMS confidence
   gate at 2.0, ±2 beat correction cap. Validated in production with
   peak/RMS=4+ on real tracks, applies sub-beat corrections after the
   beat-phase alignment. The temp-fix concern was wrong — Path C is a
   permanent refinement layer that catches what the analyzer's downbeat
   anchor misses.]
3. Manual nudge UI is NOT acceptable
4. Waveform style locked (bass-weighted env, drops tower, sharp
   transients, triangle-on-side kick shape pending)
5. 5ms hop frame analysis cannot reach Beatport accuracy — sample-level
   required
6. Sync infrastructure has two distinct concerns: rate precision
   (drift) and state management (re-engage)

### DEPLOY STATE AT SESSION END
- Latest shipped commit: 2772cb9 (sync infrastructure fixes)
- Live bundle: main-BN-rPKwe.js
- All work pushed to master
- Vercel Pro auto-deploy on push
- Railway server unchanged
- Sentry instrumentation intact

### SESSION SUMMARY
~11 hours focused work today on top of yesterday's marathon. Major
shipping:
- Smooth professional waveform
- BPM drift elimination
- Sample-level transient detection
- Sync drift fix
- Sync state reset on unsync

=================================================================
MAY 17-18 SESSION 4 — SYNC ENGINE COMPLETE + ANALYZER BLOCKER
=================================================================

Extended session. 18 commits shipped, range b28214b → edde4ee. Live
bundle at session end: main-XTT71I0o.js.

### SYNC ENGINE — NOW FUNCTIONAL

The full sync engine is shipped, validated, and behaves like a pro
DJ tool on tracks where the analyzer's downbeat detection is correct.

Audio sync:
- Beat-phase alignment matches beat-fraction across decks
  (max ±0.5 beat nudge, replaced the broken bar-phase math from
  commit 6a4e432).
- Path C cross-correlation refinement after beat-phase seek
  (commit 9b67697). FFT-based, kick-band envelope, ±2 beat search,
  peak/RMS confidence gate at 2.0, ±2 beat correction cap. Validated
  in production with peak/RMS=4+ — applies sub-beat corrections that
  the analyzer's downbeat anchor misses.
- Rate-aware visual position math (b28214b) — fixes 5+ beat grid
  drift after a minute of synced play at rate≠1.
- Shared-frame tick (0db7aa2) — both decks read ac.currentTime from
  a single parent-RAF snapshot to eliminate the sub-millisecond
  per-deck read offset that caused visual oscillation.
- Sync engages cleanly while paused, persists through pause/play,
  re-aligns automatically on the slave deck's first play-start
  (commit 4402eb3 + the play-start hook).

Visual sync:
- Rate-aware grid + waveform rendering (672129f) — both decks show
  the same wall-time window of audio; per-beat pixel spacing
  matches between decks regardless of their playback rates.
- Auto-position to first downbeat on load (5f4337b / f848480) —
  playhead lands at firstBar1AnchorSec when BPM analysis completes,
  matching Rekordbox/Serato/Traktor behavior.

Re-align on every seek path:
- Drag scrub on big waveform (anchor-based, seek-on-release)
- Click on small per-deck waveform
- Beat-step arrows (with quantize-to-grid when sync engaged)
- CUE button
- Master deck scrubs (slave re-aligns to new master position)
- Sync engaged while paused → realigns on first play

M and SYNC controls decoupled (01b8feb):
- M = metadata label only (which deck is the tempo reference)
- SYNC = global engage/disengage toggle, reachable from EITHER deck
- Master deck's SYNC button no longer disabled
- Rate preserved on unsync (DJ-correct behavior, not Rekordbox-reset)

### UX SHIPPED

- Library track rows: A/B load buttons always visible at left edge,
  filled-when-loaded indicator state (6fd5580). Hover-revealed chips
  approach replaced with always-visible for discoverability.
- Drag scrub anchor-based with seek-on-release (f3e52d3). Prior
  implementation seeked on every mousemove → 60 AudioBufferSourceNode
  create/destroy cycles per second of drag. Now: one seek per drag.
- Beat-step arrows: one beat per click in normal mode, quantize-to-
  grid when sync engaged (Rekordbox quantize behavior).
- Manual ±1 beat anchor override (edde4ee). Amber-accented buttons
  in each deck's waveform header: ⟨ +N beat ⟩. Persisted per-track
  via localStorage. Whole-beat shift is no-op modulo beatPeriod,
  so sync math is unaffected.
- Phrase voting (phSc16 + phSc32) in the analyzer (edde4ee).
  Computes longer-cycle phase patterns alongside the existing 4-beat
  phSc. Cheap (two extra array writes per beat). Overrides bestPh
  when 16-beat winner disagrees with 4-beat winner. Tested same-vote
  on all 4 failing tracks — phrase voting doesn't help when accents
  are uniform across phrases.
- Skip arrows now use beatPeriodSec/dur for step size (was fixed
  0.005 of track which was 3-7 beats per click depending on length).
- Rate-aware tick + shared parent-RAF time snapshot eliminate the
  sub-pixel visual jitter on synced decks.

### CRITICAL BLOCKER — DOWNBEAT DETECTION

After Sunbeam + Home In The Sky (the original validation pair) both
synced cleanly, broader library testing found 4 of 4 additional
tracks have wrong beat grid placement:
- Shadow Work
- You Will Never Know
- Racing Heart
- Tuesday Maybe

Pattern: each track has kick on every beat + clap on beat 3 of every
bar. phSc scoring picks bucket 2 (the clap-on-3 position) because
total kick-band energy is highest there. Kick-exclusive scoring
(onK − onP) helped but not enough — claps with sub-bass bleed still
elevate beat 3 enough to win. Phrase voting (phSc16/phSc32) is
useless when accents repeat uniformly across phrases.

This is the dogfood blocker. Users will not manually correct each
track's bar-1 offset, and 100% manual-override rate is unacceptable
for a DJ platform.

Survey of solutions queued for next session (no code yet):
- madmom RNN downbeat models via ONNX → TF.js / ONNX.js
- Essentia.js (likely insufficient — only does beat tracking, not
  true downbeat detection)
- Aubio-js (same limitation as Essentia)
- Custom hybrid: bass-continuity check + multi-pass phrase detection
- Pre-trained model + heuristic fallback
- Manual override remains as belt-and-braces for edge cases

Estimated 10-25 hours of analyzer work to reach 95%+ accuracy. Won't
ship code until survey identifies the right path.

### UPDATED ROADMAP TO DOGFOOD

Phase 1 — Analyzer fix (~10-25 hours)
  Survey existing solutions (madmom ONNX, Essentia, custom). Pick
  one, implement, validate on 15-20 track library. This is the
  blocker.

Phase 2 — Telemetry foundation (~2-3 hours)
  PostHog or similar. Need to know which tracks the analyzer fails
  on in production once dogfooding starts.

Phase 3 — Design migration (~5-10 hours)
  Migrate to the new design branch.

Phase 4 — Dogfood prep + dogfood with Jake (~1-2 hours)
  Final QA pass, send invite, watch session.

### DEPLOY STATE AT SESSION END
- Latest shipped commit: edde4ee (phrase voting + manual override)
- Live bundle: main-XTT71I0o.js
- All work pushed to master
- Vercel Pro auto-deploy on push (verified via curl)
- Railway server unchanged this session

### KEY ARCHITECTURAL DECISIONS LOCKED THIS SESSION

1. Path C cross-correlation IS the right refinement layer over
   beat-phase alignment. Reverses the May 17 "abandoned" decision.
   Confidence gate (peak/RMS > 2.0) is the real safety; magnitude
   cap (±2 beats) is secondary.

2. Auto-position to first downbeat on track load is essential DJ
   tool UX. firstBar1AnchorSec gets posted explicitly from the
   worker (not derived as beatPhaseFrac × beatPeriodSec, which had
   a stale-data race bug).

3. Stale-closure protection via refs (syncLockedRef, userMovedRef,
   etc.) is the pattern for cross-cutting state read from inside
   useCallback closures with incomplete dep arrays.

4. Worker-side stale data must be cleared on analyze() start, not
   spread-preserved. The "preserve prev[id]" pattern in useBPM was
   leaking the previous track's beatPhaseFrac into auto-position
   for the new track.

5. Manual override UI is necessary regardless of how good auto-
   detection gets. Pro tools have it too (Rekordbox grid editor).

6. Cross-correlation window must be SYMMETRICALLY clamped around
   both decks' play positions; using newSlaveTime (which the
   beat-phase seek clamps to [0,1] but the local variable stays
   negative) caused 90%+ skip rate near track start.

### OPEN TECHNICAL DEBT (lower priority, cleanup)
- Delete dphase() function in bpm-worker-source.js (replaced by
  bar-1 anchor, kept only for diagnostic comparison log)
- Delete diagnostic logs once analyzer is fixed:
  [SYNC-XCORR], [GRID-DIAG] (already removed), [phase] override logs
- Delete USE_LEGACY_FRAME_SNAP flag (sample-level refinement
  validated)
- Delete unused nudge primitive (replaced by Path C)
- Fix toggle() pause-bookkeeping rate-unaware bug at line ~3735
  (off.current = old + elapsed without × rate)
- Add gridOffset / bpmNudge UI to Deck B's header (currently only
  on Deck A; manual bar-1 override added to both decks this session)

### SESSION SUMMARY
Sync engine went from "drift fixes shipped but untested" at session
start to "fully functional and validated end-to-end" — audio sync,
visual sync, all seek-path re-align, pause/play persistence, M/SYNC
decoupling, Path C cross-correlation refinement. 18 commits, all
pushed, all live.

Counter-balancing: discovered the analyzer's downbeat detection is
the real dogfood blocker. The sync engine is correct; the input data
(bar-1 anchors) is wrong on most tracks. Next session is a survey
of how to fix the analyzer, not more sync engine work.

=================================================================
INSTRUCTION FOR NEW CLAUDE
=================================================================
"Continuing work on Mix//Sync. Previous chat hit context limits.
Please confirm you understand where we left off.

May 17-18 Session 4 (extended, 18 commits, range b28214b → edde4ee)
completed the sync engine end-to-end and validated it in production:
audio sync via beat-phase + Path C kick-band cross-correlation,
visual sync via rate-aware grid rendering, re-align on every seek
path, sync persists through pause/play, M and SYNC controls
decoupled. Live bundle main-XTT71I0o.js.

CRITICAL BLOCKER discovered late in the session: the analyzer's
downbeat detection (bestPh / firstBar1AnchorSec) is wrong on most
tracks. 4 of 4 tracks tested after the original Sunbeam + Home In
The Sky validation pair had grids placed multiple beats off. Pattern:
tracks with kick + clap on every bar score higher on the clap
position than the kick position, and our kick-exclusive scoring
(onK − onP) + phrase voting (phSc16/phSc32) help marginally but
don't fix it. Manual ±1 beat override UI shipped as belt-and-braces
but is not a viable primary workflow.

NEXT SESSION: survey downbeat detection options (no code yet) —
madmom RNN via ONNX, Essentia.js, custom multi-pass. Choose path
based on bundle size, accuracy, integration complexity. After
survey, implement Phase 1 of roadmap (~10-25 hours analyzer work).
Then Phase 2 telemetry, Phase 3 design migration, Phase 4 dogfood
with Jake.

Sync engine work is DONE for now. Don't touch it unless something
regresses."

## MAY 18-19, 2026 SESSION 5 — REAL ACCURACY VALIDATION + ROOT CAUSE PIVOT

### SESSION 5 PROGRESS

### Major shipped (committed and pushed)
- d306514 — BPM: Rekordbox-style bar-1 anchor (walk-back to time 0)
  - 4-line fix replacing Phase 1-3 phase analysis as the source of bar-1 selection
  - Walk back from dpBeatsFloat[0] by single beats to approach time 0
  - Phase 1-3 code kept dormant (computed but not consumed)
  - Result: 28% → 64% PASS, 39% → 86% on-grid

### Rekordbox library extraction proven
- pyrekordbox integration works
- Read 272 analyzed tracks from user's Rekordbox database
- Created test harness: tools/bpm-test-harness/analyze-library.mjs
- Full ground truth in tools/bpm-test-harness/library-truth.json
- Snapshot baselines saved for regression testing

### Critical understanding shift
- Initial Phase 1-3 work was wrong approach — it tried to find "musical bar-1" via signal analysis
- User clarified: Rekordbox places bar-1 at mathematical time ≈ 0, not at first audible accent
- Bar-1 is structural start of bar pattern, not first audible kick
- Walk-back is the correct algorithm for Rekordbox compatibility

### Fix #1 attempted, abandoned
- Three variants tried: diff-threshold gate=5.0, gate=3.0, power-threshold back-walk
- All failed to meaningfully improve the 60 drifting tracks (~28ms median offset)
- Power-threshold version regressed 19 prior-PASS tracks
- All reverted, worker back to d306514 state

### Root cause re-diagnosed
- The +28ms drift is NOT from refinement choosing mid-attack vs attack-start
- Real cause: DP tracker has dpLo lower bound (~0.37s)
- DP cannot place a beat before frame 0.37s
- For tracks where first kick is at 0.024s (or 0.000s for WAV), DP locks onto SECOND kick
- Walk-back recovers approximately the first kick position, but with 22-40ms quantization error
- This single cause explains the +25ms cluster, +200ms cluster, AND -25ms cluster (60 tracks total)

### Next session priority: Fix #2 (DP first-kick rescue)
Algorithm:
- After DP completes, scan [0, dpBeats[0] - dpLo/2] for above-threshold onset peaks
- For each candidate peak position p: verify p + N × beatLag ≈ dpBeats[0] for small N (1 or 2)
- Confidence gates: onset strength > 40% of median DP-beat onset, period match within ±5%
- If passes gates, prepend to dpBeats[]

Estimated effort: 4-5 hours
Predicted accuracy gain: 64% → 83-88%

### Strategic documents created
- tools/docs/DESIGN_PHILOSOPHY.md — Quiet Pro Tool direction, references, anti-patterns
- tools/docs/STRATEGIC_ROADMAP.md — Phased plan to launch
- tools/docs/FEATURES_PIPELINE.md — Feature ideas from Rekordbox data + signal processing
- tools/docs/LIBRARY_IMPORT_STRATEGY.md — Rekordbox/iTunes/folder import options

These capture today's strategic discussions for permanent reference.

### Deferred for later
- Phase 1-3 code cleanup (currently dormant, ~150 LOC)
- Disappear timing-within-beat drift (subset of the 60 affected, may auto-resolve via Fix #2)
- Beatport streaming integration (1045 tracks in Rekordbox library are Beatport refs, not local files)

### Status for next session start
- All code committed and pushed
- VISION_5.md updated with this section
- Strategic docs saved in tools/docs/
- Ready to start Fix #2 implementation immediately

## MAY 19-20, 2026 SESSION 6 — CLASS 1 FIX PASS + SUB-CAUSE B ABANDONED

### Shipped (in commit order)
- 5f9ce8d — BPM: Sub-cause A — earliest-peak rule on beat-0 refinement (64% → 71% PASS)
  - Beat 0 refinement: scan diff curve for earliest local maximum ≥ 75% of argmax. Targets the
    +20-35ms drift class where Rekordbox anchors to an earlier secondary peak.
  - Threshold sweep: 70% → 6 regressions (over gate); 75% → 4 regressions (PASS); 80% → only +15 net.
  - 75% selected: 23 fixed / 4 regressed, net +19.
- d024f2a — BPM: Sub-cause C — sampler/one-shot snap-to-0 (71% → 72.1% PASS)
  - Detection: durSec < 30 OR dpBeats.length < 8.
  - Action: if walk-back result is within 40ms of file start, snap to 0 (Rekordbox sampler convention).
  - First-attack gate at 40ms vs spec's 30ms — empirical sweep showed 40ms catches the natural
    attack-to-peak band for kick-at-0 samplers without false-triggering. +3 fixed / 0 regressed.
- 485f470 — test: parallelize analyze-library via worker_threads pool (5.4× speedup)
  - 8-thread pool replaces the sequential decode+analyze inner loop.
  - 272-track run: 1046s → 193s. Output byte-identical to sequential (0/3264 field diffs).
  - New flag `--workers N` (default min(cpus, 8)).
  - analyze-worker.mjs (new) + refactored analyze-library.mjs. Snapshot format unchanged.

### Step 5 (Sub-cause B back-extrapolation) — ABANDONED
Spent ~3 hours investigating; no commits.
- Hypothesis: dpBeatsFloat[0] is a phantom/pre-roll; back-extrap from dpBeatsFloat[N] gives true bar-1.
- Probe revealed: Body Stars / Hymn Fern have INTERNALLY-CONSISTENT DP grids (intervals ≈ period),
  uniformly shifted ~22ms earlier than Rekordbox's grid. Back-extrap from beat[N] gives the same
  wrong answer as beat[0].
- Empirical sweep N∈{4,8} × threshold∈{10,15,20,25,30}ms: best case (N=8, 30ms) was +6/-5, fails the
  user's 5-regression gate. No combination crosses the gate with meaningful fixes.
- Full investigation preserved in tools/docs/STEP5_INVESTIGATION.md. Probe tool kept at
  tools/bpm-test-harness/predict-backextrap.mjs.

### Strategic decoder investigation (rejected hypothesis)
Spent ~2 hours verifying production decoder vs test-harness decoder.
- Audio-decode npm (libmpg123 with MPG123_GAPLESS) vs ffmpeg-static (libavcodec, what Chrome uses):
  zero-sample-offset alignment on all 5 Class 1 candidates. Amplitude scales by ~1.41× but onset
  detection is amplitude-invariant.
- "26ms problem" hypothesis (Rekordbox skips an MPEG frame on Case-2 MP3s): REJECTED. Empirical
  shift simulation showed uniform +26ms shift CRATERS accuracy (70.9% → 26.8%). The 27ms median
  drift on Case 2 FAILs is coincidental, not systematic.
- Library is 97% Lavc-encoded (Case 2 — Xing header, no LAME subtag). All decoded buffers start at
  "real audio sample 0".
- Browser HTML test page available at tools/bpm-test-harness/browser-decoder-test.html for any
  future verification. Conclusion: production ≈ test harness within onset-detection tolerance.

### Accuracy trajectory
- Pre-session: 174/272 PASS = 64.0%
- After Step 3: 193/272 = 71.0%
- After Step 4: 196/272 = 72.1% (current)
- Step 5: no change (abandoned)

### Hypotheses for what Rekordbox does on Sub-cause B tracks
None confirmed; ordered by gut likelihood:
1. Envelope-peak detection (walk forward from argmax-of-dE/dt to envelope max)
2. Sub-bass phase alignment (40-80 Hz fundamental phase, not broadband onset)
3. Pre-roll/anacrusis skipping (detect outlier beat[0] vs the beat[1..32] pattern)
4. Different filter band (60-80 Hz body, not 40-200 Hz like ours)

### Next session priority
Try Approach A from STEP5_INVESTIGATION.md: beat-0-only forward walk to envelope peak.
- Same shape as Step 3 (beat 0 only, single tunable knob), which landed cleanly under the gate.
- Predicted to address Body Stars / Hymn Fern (analyzer ~20ms EARLY) without touching the 196 PASS.
- Estimated effort: 5-7 hours.

### Deliverable files added this session
- tools/docs/STEP5_INVESTIGATION.md — full Step 5 investigation report
- tools/bpm-test-harness/predict-backextrap.mjs — back-extrap impact simulator (re-runnable)
- tools/bpm-test-harness/analyze-worker.mjs — worker-thread per-track runner (committed in 485f470)
- tools/bpm-test-harness/compare-decoders.mjs — ffmpeg vs mpg123 alignment test
- tools/bpm-test-harness/browser-decoder-test.html — browser decodeAudioData verification page
- tools/bpm-test-harness/decoder-output-probe.mjs — leading-sample inspector
- tools/bpm-test-harness/lame-tag-probe.mjs + lame-survey.mjs — LAME-tag parser + library survey
- tools/bpm-test-harness/simulate-decoder-shift.mjs — uniform-shift impact simulator
- tools/bpm-test-harness/probe-beat0.mjs — beat-0 refinement deep probe
- tools/bpm-test-harness/sampler-survey.mjs — sampler-candidate enumerator
- tools/bpm-test-harness/debug-fix2.mjs — single-track verbose worker runner

### Status for next session start
- Worker is at d024f2a / 485f470 clean state (no uncommitted code changes)
- Harness is parallel — full runs take ~3 minutes
- 72.1% accuracy on 272-track library; production ≈ test harness
- VISION_5.md updated through this section
- All diagnostic tools preserved (uncommitted; will commit selectively next session)

## Session log — May 20-21, 2026

### ANALYZER (final this session)

Three fixes shipped:

- `9ba92fe`: drop-detection grid validation (72.4% → 73.2%)
- `4f57d9b`: Sub-cause F first-kick rescue (73.2% → 73.9%) — Rocket Jam fixed
- `38af43b`: Sub-cause G walkback to earliest transient (73.9% → 80.9%) —
  +19 tracks, 0 regressions, largest single fix of the project

Ending state: **80.9% harness / 84.3% standalone** (excluding 11 long DJ mixes).

Full project trajectory: 28% → 64% → 71% → 72.1% → 72.4% → 73.2% → 73.9% → 80.9%.

**Decision: pause analyzer work until real user telemetry.** Across heuristics,
madmom, beat_this, anchor hypothesis, cluster offset, and sync correctness
diagnostics, remaining failures confirmed unfixable from audio. Per-track
perceptual offset varies 7-54 ms — no global shift solves it.

### WAVEFORM WORK (Phase 1 complete)

Strategic pivot from "improve analyzer to 95%" to "use Rekordbox's own
analyzed data for tracks user has in Rekordbox library, plus manual UI for
the rest." Stronger product position than chasing Pioneer parity.

Phase 1 shipped:

- `src/rekordbox-anlz.js` (ANLZ parser, zero byte-diffs vs pyrekordbox)
- `src/rekordbox-sqlcipher.js` (SQLCipher decryption, Web Crypto, 154 ms for
  12 MB, HMAC verified on all 2,958 pages)
- `src/rekordbox-library.js` (library connector)
- `public/sql-wasm.js` + `public/sql-wasm.wasm`
- REKORDBOX pill UI in LibraryPanelV2
- `wfA` / `wfB` waveform-override hooks
- `sql.js@^1.14.1` added as dependency

Library accessible: **1,343 tracks, 389 cues, 1,327 with AnalysisDataPath (98.8%)**.
Build green, dev server boots in 5 s.

Full report at `tools/rekordbox-eval/PHASE_1_REPORT.md`.

### NEXT IN QUEUE

- Phase 2 waveform: spectral color band rendering (PWV5 → 3-band renderer)
- Phase 3 waveform: cue point overlay
- Phase 4 waveform: non-Rekordbox track fallback
- Manual UI adjust (anchor + BPM nudge, like Rekordbox/Traktor) — separate
  workstream, must ship before dogfood

### NON-NEGOTIABLES (Chad's bar)

- Waveform must look as good or better than Rekordbox
- Sync must phase-lock in audio (beat-slap = broken product)
- Manual UI nudge must exist before dogfood, but analyzer cannot rely on it

## May 21 evening — current state snapshot

> Bridges the gap between the May 16 entries above and where we
> actually are tonight. Full vision reconciliation pending in next
> session.

### 1. Analyzer state

- **80.9% PASS on the 272-track Rekordbox-truth harness** after the
  Sub-cause A–G fixes shipped earlier this week (Class 1 walk-back,
  first-kick rescue, drop-detection grid validation, envelope walk-
  forward, first-kick anchor, late-cluster walk-back).
- Work **paused**. Across heuristics, madmom, beat_this, anchor
  hypothesis, cluster offset, and sync correctness diagnostics, the
  remaining ~19% of failures are confirmed **not tractable from audio
  alone** — per-track perceptual offsets vary 7–54 ms, no global
  correction recovers them.
- **Manual nudge UI required before dogfood** as the safety net for
  that residual 19%. Already shipped as the amber ±1 beat anchor
  buttons in the waveform header (commit `edde4ee`); will likely need
  a more discoverable affordance before dogfood.
- Full diagnostic data + investigation history preserved in
  `tools/rekordbox-eval/PHASE_2_STATUS.md` and
  `tools/sota-eval/` (cross-reference against SOTA models +
  Rekordbox truth on the full library).

### 2. Rekordbox integration (Phase 1 + Phase 2 shipped)

- `src/rekordbox-anlz.js` (ANLZ parser),
  `src/rekordbox-sqlcipher.js` (SQLCipher v4 decryption via Web
  Crypto), and `src/rekordbox-library.js` (library connector) all
  live in production.
- Verified end-to-end: **1,343 tracks, 389 cues, 1,327 with
  AnalysisDataPath (98.8 %)** on the test library. ~196 ms cold
  open, ~1 ms per ANLZ decode after.
- **PQTZ grid override active in production** for Rekordbox-imported
  tracks via `getBeatGrid(trackId)` + the `effectiveBpmResults`
  useMemo + the transparent `bpm` shadow. Kicks land on the grid
  by definition for those tracks. Non-Rekordbox tracks continue to
  use the analyzer's 80.9% grid + manual nudge as fallback.
- **PWV5 spectral waveform data** is decoded and available
  (`getWaveformBands()`), but currently **off the render path**.
  Kept in code as a calibration reference for the eventual spectral
  revisit and for future cue-point rendering.

### 3. Waveform rendering

- **Reverted from the Phase 2 spectral attempt back to calm
  monochrome amplitude** (commit `6fcc4d4` waveform revert section).
  Single deck hue per renderer, alpha modulated by envelope. Joint
  band normalization rolled back to per-band. `deckSpectralAnchors`
  helper removed.
- Reason: visual contrast between bass and treble in the spectral
  attempt was subtle vs Pioneer's reference, and the design
  philosophy lock-in chose Mix//Sync brand identity over Rekordbox
  literal coloring. Calm monochrome ships cleaner for now.
- **Spectral work tabled** until dogfood feedback indicates spectral
  differentiation actually matters to real users in real sessions.
- Diagnostic data + future revisit notes preserved in
  `tools/rekordbox-eval/PHASE_2_STATUS.md`. Beat grid data and
  Rekordbox PQTZ override are untouched by the waveform revert —
  bars still land on kicks.

### 4. Design

- **"Quiet Pro Tool" direction LOCKED** in
  `tools/docs/DESIGN_PHILOSOPHY.md` — Japanese minimalism, MUJI /
  Teenage Engineering / fragment design / Nendo references; NOT
  Pioneer / Maschine / Linear / Figma.
- **Structural redesign in progress.** Production tip tonight:
  `565991d` (Design v3 fixes — edge-to-edge deck row, DeckArt
  locked 96×96, transport row visible with Elapsed/Remain merged
  in, library gained vertical room, top-waveform chrome moved off
  the waveform into a row above).
- Foundation now in place: warm palette (#0F1014 bg, oak
  `#C9B79C` accent, desaturated deck violet/teal), album-art deck
  anchors (96×96), sentence case throughout, tabular nums, A–D
  inline cue chips, **white circle play as visual anchor**, compact
  mixer (200 px column / 16 px knobs / 130 px faders).
- **Reference**: structural decisions from `design-decks` branch
  (album-art anchors, cue list, transport hierarchy), **NOT** its
  cool-grey palette. Target aesthetic: Beatport B2B (content-
  forward, minimal, generous negative space, restrained).
- **Expect 2–3 more iteration rounds** before user sign-off.
  Worktrees `../collabmix-booth` (port 5174) and `../collabmix-decks`
  (port 5175) preserved for ongoing visual reference.

### 5. Unresolved for dogfood

1. Finish design iteration to user approval (2–3 more rounds expected).
2. Manual UI adjust (anchor + BPM nudge) made discoverable enough
   that real users can correct the 19% of tracks the analyzer misses
   on. **Required before dogfood.**
3. Dogfood with Jake — first real B2B test on the new design with
   the manual nudge safety net in place.

### 6. Nice-to-have post-dogfood

- **Phase 3 cue points overlay** — Rekordbox PCOB / PCO2 hot cues
  and memory cues rendered on the waveform. Connector already parsed
  in Phase 1; rendering work is the remaining piece.
- **Phase 4 fallback handling polish** — better UX on tracks where
  Rekordbox match fails, ANLZ data is missing, or PQTZ is absent.
- **Waveform spectral coloring revisit** with real user feedback to
  inform whether the visible-frequency-differentiation aesthetic is
  worth the analyzer + render complexity. Tabled state captured in
  `PHASE_2_STATUS.md`.

> **May 21 evening status snapshot — full vision reconciliation
> pending in next session.**

## May 23 evening — major design evolution day

> This section replaces the May 21 evening snapshot above as the
> current state of truth. May 21 is preserved as historical record.

### What changed today

Today represented a major aesthetic pivot for Mix//Sync. Started
with the "warm Quiet Pro Tool" direction locked in
`DESIGN_PHILOSOPHY.md` and ended with that direction explicitly
superseded.

### Key design decisions (locked in)

#### 1. Palette pivot — warm → cool dark

- Warm "Quiet Pro Tool" palette rejected after user saw it
  executed ("retro / military, not clean or minimal")
- New direction: Beatport-leaning cool dark with **NO warm cast**
- Background: `#0A0B0E` (near-black, no brown / sepia)
- Text: `#F5F5F7` (clean white, not warm)
- Surfaces: cool dark grays (`#15171A`, `#1F2126` levels)
- **ZERO amber on deck cards** (key chip, BPM, all white)
- Amber `#D4A06A` accent surgical use ONLY on active sidebar
  border in the library

#### 2. Deck identity colors — iterated through ~10 options

Final state at session end (commit `80929d9`):
- **Deck A: `#0F4FA0`** (deep electric night blue)
- **Deck B: `#1FC97A`** (electric green, from DJ booth reference
  photo)
- Reference rejected: brown / rust copper (too earthy / aged)
- Reference rejected: purple / lavender (felt amateur)
- Reference accepted: cool family pair, both glowing in dark room

#### 3. Waveform rendering — major architectural work

- v5.8 introduced **multi-pass additive glow rendering**
- v5.10 inverted peak gradient (deep color = body, subtle
  brightness only at peak tips)
- Three glow passes layered: wide halo + concentrated halo +
  crisp shape
- **KNOWN LIMITATION**: canvas rendering may have hit ceiling for
  "neon glow in dark room" aesthetic. May require WebGL approach
  if that aesthetic is critical to dogfood. User to decide with
  fresh eyes.

#### 4. Layout decisions locked

- Edge-to-edge deck row (no center gutter, no maxWidth)
- 96×96 album art square as deck visual anchor
- Track title row with inline elapsed / remaining time
  (Rekordbox-style: `01:35 / -06:36`)
- Metadata below title: artist name only (dropped duration,
  sample rate, channel info)
- A–D cue chips inline below transport (not A–H column on right)
- **WHITE play button as visual anchor** (largest control, glows
  white when active)
- Cue / Sync as smaller pills
- Sync and M active state: **WHITE glow (NO green — user explicit)**
- BPM in white (no amber)
- Camelot key chip in white (no amber)
- Mixer column compact, slim
- Crossfader moved INSIDE mixer column bottom (was separate strip
  eating library space)
- AUDIO / REC / MIDI moved to TOP HEADER next to session info
  (was strip below decks eating library space)
- No gap between Deck A and Deck B waveforms (waveforms sit
  edge-to-edge in top zoomed area)
- Library expanded to substantially more vertical room

#### 5. Waveform treatment

- Calm monochrome amplitude (NOT spectral — that was tabled today)
- White beat grid markers (functional reference points)
- White grid markers carry deck-color glow halo (subtle)
- Red 16-bar phrase markers — outer ticks only, NO through-line
  crossing the waveform body
- `ampPad 18` = clear visible space between waveform peaks and
  grid markers
- Multi-pass additive glow rendering (per v5.8 + v5.10)
- Pure black background for maximum glow contrast

#### 6. What was removed from UI (needs new home)

**Manual nudge controls** (grid offset, bar-1 nudge, BPM nudge):
- REMOVED from visible UI in v5.2 chrome cleanup
- State and handlers still exist in parent component
- These are **REQUIRED** to have a UI surface before dogfood
- Was in waveform chrome row — needs new home, possibly:
  - Hover-reveal on the waveform itself
  - Inside mixer column
  - Small expandable panel
  - To be determined in next session

### DESIGN_PHILOSOPHY.md status

- Original May 19 "warm Quiet Pro Tool" direction explicitly
  superseded (block retained as `> SUPERSEDED` for historical
  context)
- Cool dark Beatport-leaning direction now canonical
- All six core principles (restraint, dense-but-clean, negative
  space, functionality is aesthetic, quiet confidence, one
  perfect detail) **STILL APPLY** — only palette and color
  execution changed
- Sentence case, tabular nums, Inter typography all preserved
- Anti-patterns from original (no skeuomorphism, gradients,
  glassmorphism, all-caps, multiple accents) still apply

### Commits shipped today (master, in order)

- `5b09651` — Design v4 cool dark palette + layout fixes
- `cad2098` — Design v5 deck temperature contrast + beat grid glow
- `be6cb8d` — Design v5.2 cleanup (5 fixes including chrome
  cleanup)
- `8e81414` — Design v5.3 white grid markers + amplitude clearance
- `bde9aee` — Design v5.4 grid clearance + alive Deck A blue
- `d6f4c3f` — Design v5.5 club-lighting cool pair
- `be3f2d0` — Design v5.6 actual glow rendering
- `c39028b` — Design v5.7 vivid pigment + atmospheric glow
- `0feee47` — Design v5.8 true neon multi-pass glow rendering
- `e1de1db` — Design v5.9 deep blue + electric green
- `80929d9` — Design v5.10 inverted peak gradient

### Strategic roadmap — updated for dogfood readiness

**Critical path to dogfood (in order):**

1. **Manual nudge UI — REQUIRED, NOT OPTIONAL**
   Manual anchor and BPM nudge controls must have a discoverable
   UI surface. State exists, handlers exist, visible UI does not.
   This is the safety net for the 20% of tracks the analyzer
   gets within ±20 ms but not perfect.
2. **Waveform glow decision**
   User to decide with fresh eyes: accept current canvas-based
   glow as "good enough" OR commit to WebGL rebuild for true
   neon aesthetic. Not blocking other work either way.
3. **Library deeper polish**
   Current library has space but track row design could improve.
   Specific improvements deferred to next session.
4. **Dogfood with partner**
   First real B2B session on new design with manual nudge UI in
   place as safety net.

**Post-dogfood:**

- Phase 3 cue points overlay (Rekordbox PCOB / PCO2 hot cues)
- Phase 4 fallback polish
- Waveform spectral coloring revisit (currently tabled,
  diagnostic data preserved in `PHASE_2_STATUS.md`)
- Marketing landing page redesign

### Worktrees preserved

- `../collabmix-booth` @ `3ec2995` (`design-booth`) — kept for
  reference
- `../collabmix-decks` @ `e700508` (`design-decks`) — kept for
  reference

### User work style notes (preserve for future Claude sessions)

- Non-designer founder, learns by seeing not articulating
- Wants direct opinions and pushback, not wishy-washy responses
- Quality bar: Rekordbox / Traktor level — non-negotiable
- Will change direction when seeing executed result (philosophy
  direction changed twice today after seeing builds)
- Important to let builds finish before reacting / iterating
- Memory: color principle saved — start at full saturation,
  reduce brightness for depth, never desaturate first

> **May 23 evening end-of-session snapshot. v5.10 (`80929d9`) is
> the current production tip. Canvas-2D glow rendering at its
> quality ceiling; WebGL migration flagged as the lever if the
> Reflect-style neon aesthetic stays critical to dogfood.**

## May 24 morning — Quick Wins

> Executes the five "Quick Wins" items from the design research
> document produced May 23 evening. Establishes a new color
> baseline, single-accent rule, motion baseline, library row
> design, and play-button feedback in five surgical commits.
> Each was committed independently so any one can be reverted
> cleanly without unwinding the others.

### Commits shipped today (master, in order)

- `4ba8a05` — v5.11 deck color baseline: Dusk Blue + Deep
  Emerald Glow (P3 + sRGB)
- `693c81f` — v5.12 retire amber, single accent (white at three
  opacity tiers)
- `f5c777a` — v5.13 standard 150ms motion baseline
  (cubic-bezier 0.4, 0, 0.2, 1)
- `f54b84d` — v5.14 library track row hierarchy polish
- `f6dd7d3` — v5.15 play button single-pulse on activation

### Key decisions locked in

#### 1. Deck identity colors superseded (third time)

- **Deck A: `#1976D2`** (Dusk Blue) — sRGB fallback;
  `color(display-p3 0.10 0.46 0.82)` on wide-gamut displays
- **Deck B: `#00C853`** (Deep Emerald Glow) — sRGB fallback;
  `color(display-p3 0 0.78 0.32)` on wide-gamut displays
- Supersedes May 23 evening's `#0F4FA0` deep blue + `#1FC97A`
  electric green
- **Why**: design research flagged perceptual issue — `#0F4FA0`
  was deep enough that even the v5.8 additive glow couldn't
  pull a convincing "lit from inside" reading out of it. Brain
  reads very dark blue as a static painted shape no matter how
  much halo sits around it. New Deck A blue is lighter into the
  range where canvas glow registers as light. Deck B green
  pushed to a higher chroma in the same direction.
- **P3 + sRGB pattern**: CSS variables `--deck-a` / `--deck-b`
  in `src/index.css` declare sRGB first, override with P3
  inside `@supports (color: color(display-p3 0 0 0))`. Canvas
  cannot read CSS variables so `TOK.deckA` / `TOK.deckB` mirror
  the sRGB hex as the single source of truth in JS — keep the
  two in sync.

#### 2. Single accent — amber retired permanently

- May 23 evening retained `#D4A06A` as a surgical warm accent
  on the active sidebar border. Removed today.
- **New rule: single accent = white at three opacity tiers**
  - **Primary** `rgba(255,255,255,0.9)` — active states,
    primary indicators (active sidebar border, play active,
    sync engaged, M master engaged)
  - **Secondary** `rgba(255,255,255,0.6)` — hover states,
    secondary info (minor-key Camelot text, artist names,
    durations)
  - **Tertiary** `rgba(255,255,255,0.3)` — borders, dividers,
    inactive pill outlines
- **Why**: even one warm hue against the cool dark surfaces
  broke the Beatport / Spotify register the rest of the palette
  was reaching for. Tried it (v5–v5.10) and dropped it.
- `TOK.accent` / `TOK.accent2` / `TOK.accent3` exposed as the
  tier system; legacy `oak` / `gold` aliases removed.

#### 3. Motion baseline established

- **Standard transition**: `all 150ms cubic-bezier(0.4, 0, 0.2, 1)`
- Low-specificity CSS rule in `src/index.css` applies the
  standard to buttons / inputs / selects / textareas / links
  and `[role="button"]` — picks up un-styled controls for free
- Canvas excluded (waveforms paint per-frame, never
  transitioned)
- The most prominent interactive surfaces brought to the
  standard explicitly: TrackRow + LibraryPanelV2 row
  backgrounds, cue chips, Cue / Sync / M, deck-card
  driver-border, mixer TB2 helper, play button
- Intentionally-fast transitions left alone (VU meter width
  `.05s`, drag-cap height `.05s`) and intentionally-slow
  deck-card outer container (`.3s` on track load)
- **Why**: app felt static without motion. Inline transitions
  varied across `.1s` / `.12s` / `.15s` / `.2s` / `.3s` with
  mixed easing. One curve, one duration is the legibility win.

#### 4. Library track row design locked

- Restructured from left-anchored A/B-buttons-first to
  art-first reading order:
  `[3px deck border] [32px art] [Title 500 / Artist .6]
  [energy bar 56w] [BPM Key Dur tabular cluster]
  [A B load buttons]`
- Album art moved to the left edge as the visual anchor
- Title bumped to weight 500 — slight hierarchy lift against
  artist
- Artist + duration use the new secondary white tier
  (`rgba(255,255,255,0.6)`)
- Analysis-status dot collapsed into the title row inline
- Energy bar slimmed to 3px, recolored to white-tier over a
  low-alpha track (was gray-on-darker-gray)
- BPM / Key / Duration grouped into a single right-aligned
  tabular cluster — was three separate fixed-width slots with
  no visual unit
- Key chip restyled to white tier; em-dash placeholder when
  missing so spacing stays stable
- A/B load buttons moved to the far right (action zone),
  preserving always-visible + filled-when-loaded affordance
- Hover background brightened to `rgba(255,255,255,0.04)`
- **Why**: design research flagged library as the weakest
  competitive area of the app. Decks read pro; library still
  read generic. Row redesign was the lowest-effort lever to
  close that gap without touching filters / search / sidebar
  (those are later sessions).

#### 5. Play button feedback — single pulse on activation

- When `playVisual` transitions false → true, fires once:
  - Button scales 1 → 1.05 → 1 (subtle physical bump)
  - Halo ring (white at 0.9) expands 1 → 1.25 with opacity
    fade to 0
  - Both 200ms cubic-bezier(0.4, 0, 0.2, 1)
- Trigger: `pulseId` counter in `useEffect` watching
  `playVisual`; keyed wrapper remounts on each increment so the
  one-shot `@keyframes` replays
- **Single pulse on press, NOT continuous** — continuous would
  be visual noise during a long set (user explicit)
- Active background also changed from solid `#FFFFFF` to
  `rgba(255,255,255,0.9)` for consistency with the new tier
  system
- **Why**: design research called out the play press as a
  "weight-of-the-moment" interaction that deserves a single
  acknowledgement frame, not silence.

### Where this came from

These five changes are the entire "Quick Wins" section of the
design research document produced May 23 evening. The research
identified three classes of issues addressed today:

1. **Perceptual color theory** — Deck A `#0F4FA0` was too deep
   for canvas-2D glow to register as light (Path A multi-layer
   compositing is the *other* lever, deferred to its own
   session)
2. **Library is the weakest competitive area** — row hierarchy
   polish closes the gap on the lowest-effort surface
3. **App felt static** — motion baseline + play pulse give the
   app a heartbeat without any motion being decorative

### Next session priorities

In order, all blocking various things downstream:

1. **Path A multi-layer offscreen canvas compositing** for
   waveform glow rendering (4–8 hour focused session). The
   v5.8 multi-pass additive glow is at canvas-2D's ceiling;
   Path A separates the wide halo / concentrated halo / crisp
   shape passes into cached offscreen canvases composited in a
   single per-frame draw, which should give us enough headroom
   to push glow intensity without dropping frames.
2. **Manual nudge UI hover-reveal on waveform** —
   required pre-dogfood. State and handlers still live in the
   parent (`gridOffsetA/B`, `barOneA/B`, `bpmNudgeA/B`); needs
   a discoverable affordance. Hover-reveal on the waveform
   itself is the candidate; alternatives are the mixer column
   or a small expandable panel.
3. **Library smart filter expansion** — separate session.
   Today's row polish was scoped intentionally narrow; smart
   filters, search behavior, and sidebar are untouched and
   are the next library lever.

> **May 24 morning end-of-session snapshot. v5.15 (`f6dd7d3`)
> is the current production tip. New color baseline + single
> accent + motion baseline + library row + play pulse all
> shipped to master and deploying to collabmix.vercel.app.
> Path A waveform compositing is the next major lever; manual
> nudge UI is the next blocker on the critical path to
> dogfood.**

## May 25 — Memory fix (analysis path)

Importing 100+ tracks could push Chrome past 8 GB and crash the tab.
The May 6 OOM fix removed auto-queue on import + mount and made
`_importFileObjects` itself pin-free, but the bulk analysis path
(`analyzeAll`, wired to the toolbar "Analyze library" button) still
had the original shape: pre-resolve every File via `getFile`, push
File-bearing items into `queueRef` all at once. For 5000 tracks
that's 5000 live blob references queued before any draining starts.
The May 8 verification ("182 MB at 135 tracks") was for resident
library state with compressed artwork, not for an active analysis
pass — `analyzeAll` was assumed lazy, but wasn't.

Three commits (d1b5177, eb67661, c1f68c2):

**Streaming analyzer (d1b5177)**
- `analyzeAll` now pushes `{id, skipBPM, skipKey}` only. Files are
  resolved one at a time by `processQ` at the moment of analysis,
  then released. Bulk-path File pinning is gone.
- `processQ` downmixes to mono and decimates to **11025 Hz with a
  60 s cap**. The three worker analyzers only need a fraction of
  the input: `dbpm` bandpasses to 100–400 Hz (well below 5.5 kHz
  Nyquist), `dkey` reads ~2 s of FFT hops at chroma fundamentals
  ≤880 Hz, `denergy` uses the first 30 s of RMS+ZCR. Worker now
  receives ≈2.6 MB instead of the ≈50 MB full-rate stereo PCM
  it used to get. Box-filter average over each source window
  doubles as anti-aliasing.
- Mono PCM ArrayBuffer is **transferred** (not structured-cloned)
  to LIB_WORKER — matches the deck BPM worker pattern at
  `bpm-worker-source.js:130`. Previously the library worker was
  the only postMessage in the app that did a full structured
  clone, transiently tripling PCM memory per track.
- Intermediate buffers (compressed ArrayBuffer, full-rate
  AudioBuffer) are explicitly nulled before the worker round-trip
  so they're GC-eligible while the worker runs.
- AudioContext is recycled (close + recreate) every 50 tracks.
  Chrome leaks small internal buffers per decode that aren't
  reclaimed until `close()`.
- `requestIdleCallback` yield between worker results — gives the
  GC room to run on library-scale passes.

**fileMap LRU cap (eb67661)**
- `fileMap.current` cached every resolved File for the session
  lifetime. A DJ previewing 100 tracks pinned ~1 GB of blob
  references; every deck-load stayed pinned even after unload.
- New `fileMapTouch / setFile / removeFile` helpers, cap of 16.
  Comfortably above any realistic working set (decked tracks,
  recent previews, in-flight analyzer) and small enough that
  pathological loops can't run away.

**Force re-analyze (c1f68c2)**
- Right-click any track → "↻ Re-analyze". Marks the track
  unanalyzed, persists the reset, queues it for the new pipeline.
  Recovery path for tracks analyzed under the pre-May 25 full-
  rate code or with bad ID3 BPM/key tags.

### Verification

- **Build clean**: `vite build` produces a 540 kB main bundle
  (vs. 540 kB pre-fix — no size regression).
- **Worker math sanity check**: synthetic 120 BPM click track
  + 440 Hz A4 sine at 11025 Hz mono → `dbpm` returns 120, `dkey`
  returns A, `denergy` returns Peak Hour. All three analyzers
  produce correct results at the new SR.
- **Pending**: live import test of 100+ tracks on production
  (collabmix.vercel.app) to confirm the resident heap stays under
  500 MB during the analysis pass.

### What this does NOT fix

- **Resident library state at extreme scale.** At ~1.3 MB/track
  (per the May 8 artwork-compression measurement) a 5000-track
  library still carries ~6.5 GB of in-memory artwork data URLs
  plus the React state and IDB poll's deserialization allocation.
  This is the next ceiling. Fix is artwork-on-demand (drop
  in-memory `artworkCache.current`, lazy-fetch from IDB per
  visible row) — separate session, deliberately deferred.
- **Very long single tracks.** `decodeAudioData` always decodes
  the full compressed file before we can truncate. An 8-min
  48 kHz stereo song peaks at ~184 MB transient during the
  decode→downsample step. Serial processing means peak memory
  is bounded by the longest single track, not the library size.
  1-hour DJ mixes would still peak at ~750 MB. Acceptable trade
  given the user library composition (5–8 min EDM tracks).
  WebCodecs `AudioDecoder` would unlock partial decode if this
  ever becomes a real constraint.

> **May 25 end-of-session tip: c1f68c2. Analysis-path memory fix
> shipped to production. Next sessions: live verification at
> 100+ tracks, then storage bug (Session 2), then artwork-on-
> demand (separate session) if 5000-track resident becomes a
> real constraint.**

## May 25 evening — Storage fix (Session 2)

User reported library disappearing between browser sessions —
entire library showing zero tracks on app reopen. The May 7 fix
(`navigator.storage.persist()` on first import) was real but only
half the surface: the standalone library app at `/library.html`
never called persist() at all, didn't use OPFS, and wrote `handles`
records in a shape the mixer couldn't read. The mixer's own
`cmDbPutHandle` was also broken — `{id, ...handle}` silently
dropped the handle field because `FileSystemFileHandle` has no
enumerable own properties. Both apps were also declaring the
`settings` store with divergent keyPaths (latent, never triggered
because nothing wrote to it).

Seven commits implementing the full layered fix:

**Commit 1 (57535b6) — Shared `src/utils/storage.js`.**
All IDB / OPFS / persist calls now live in one module. Schema is
v5: new `migrations` store, settings rebuilt with consistent
keyPath, normalized `handles` shape, OPFS dir owned by the utility,
`versionchange` listener so multi-tab upgrades don't deadlock.

**Commit 2 (b851180) — Mixer uses shared utility + mount persist.**
~115 lines of inline cmDb*/opfs* helpers gone. Aliased imports
preserve call-site names. `ensurePersistentStorage()` runs once
per mount, idempotent — fixes the pre-May-7 cohort whose storage
was never persisted. `getFile` uses `resolveHandleRecord` to
tolerate all 3 legacy record shapes.

**Commit 3 (274212f) — Library-app uses shared utility + OPFS writes.**
Shimmed IDB helpers preserve `(db, store, val)` call-site shape.
Mount-time persist call (this app NEVER called it before — the
proximate cause of the report). OPFS writes added to both
`handleImport` (file input) and `scanFolder` (folder picker).
The legacy `{id, file}` `handles` write is gone — replaced with
`{id, handle, opfsBacked: true}` or `{id, handle: null,
opfsBacked: true}` for the input path.

**Commit 4 (05ab765) — Lazy v4→v5 handle-shape migration.**
`runHandleMigration()` walks `handles` at idle time on each app's
first launch, normalizes legacy shapes, copies any embedded `File`
to OPFS, marks orphans as `needsReconnect`. Marker stored in the
`migrations` store on completion. Partial runs are safe — re-run
on the next launch is idempotent.

**Commit 5 (d1a83dc) — JSON export/import.**
`lib.exportLibrary()` bundles tracks + crates + queue into a single
JSON download. Audio bytes are NOT exported (too large). Artwork
data URLs included (already compressed). `lib.importLibraryJson(file)`
dedupes by id, merges crates, reloads. Two new icon buttons
("Export", "Import") in the mixer library toolbar. Critical safety
net for browsers where persist() is unavailable.

**Commit 6 (962530b) — STORAGE.md + upgrade toast + Safari banner.**
STORAGE.md is the single source of truth for the schema, the 5
layers, the 5 legacy record shapes, the read-priority order, and
the anti-patterns that caused the original drift. Upgrade toast
("Library upgraded — tracks now permanently saved") shows once per
origin after v5 migration completes, auto-dismisses in 6s. Banner
appears when `persist()` is denied/unsupported with copy pointing
the user to the new Export button. Dismissible per origin.

### Verification

- **Build clean**: `vite build` produces a 541 kB main bundle (was
  540 kB pre-fix — within noise). Both apps build, both load with no
  module-resolution errors. Storage shared chunk extracted to 147 kB.
- **Syntax/parse clean**: all three changed files pass esbuild JSX
  parse.
- **Lint**: not runnable in this repo — `npm run lint` errors with
  "ESLint couldn't find eslint.config.js". Pre-existing (ESLint v9
  migration not done). Flagged for a separate cleanup session.
- **Live verification pending**: requires a browser. The IDB v5
  upgrade, lazy migration, OPFS writes, and `persist()` request
  cannot be exercised from node. User should test on production
  after deploy with a fresh-import + close-browser-fully + reopen
  flow.

### What this does NOT fix
- **Live verification by Claude.** I cannot run the browser
  pipeline. The architectural changes are sound but unmeasured
  against real user data.
- **Safari `persist()` denial.** Banner surfaces this honestly but
  the only remedy is the JSON export workflow.
- **Tracks orphaned by the pre-v5 `cmDbPutHandle` bug with no OPFS
  bytes.** The migration marks them `needsReconnect`. UI surface
  for that flag is the existing "Reconnect music folder" button —
  no new affordance shipped this session.

> **May 25 evening end-of-session tip: 962530b. Full storage
> layered fix shipped to master and deploying to
> collabmix.vercel.app. Next session: live verification of the
> migration + import + survive-restart cycle on real user data.
> Then: artwork-on-demand for the 5000-track resident ceiling
> (Session 3).**

## May 25, 2026 — Evening session

Big session — critical reliability fixes, protocol establishment,
beatgrid editor v1, and a 1,070-line dead-code purge. Final commit
`cc426d1`.

### CRITICAL FIXES
- **Memory architecture fix.** Three latent OOM paths corrected:
  - `parseID3` was silently truncating APIC artwork at 500 KB,
    feeding partially-decoded JPEGs into `downscaleArtwork`. This
    produced the "Racing Heart" / "You Will Never Know" half-
    rendered thumbnails. Removed the cap; embedded bytes are now
    passed through whole.
  - Library worker's `postMessage` was structured-cloning the
    full-rate stereo PCM (~50 MB per track). Switched to
    transferable mono 11 kHz buffers (~2.6 MB) matching the deck
    worker's pattern.
  - `fileMap.current` grew unbounded across sessions; capped at 16
    entries with LRU eviction. Routes all writes through `setFile`
    / `removeFile` helpers so the cap can't drift.
- **Storage fix — library survives full Chrome quit.** Lazy v4→v5
  IDB migration normalizes legacy `handles` record shapes
  (`{id,file}`, `{id}` orphans from the prior `cmDbPutHandle` bug,
  canonical `{id,handle}`) into a uniform `{id, handle?,
  opfsBacked?, file?}`. Verified at 135 tracks: library survives
  full quit/restart cycles. `navigator.storage.persist()` now
  requested at mount in BOTH apps (mixer + standalone library) so
  pre-fix users get upgraded on first launch of the new build.
- **Album art rendering fix.** `AlbumArt` component replaces five
  inline render sites that drifted in styling. Square via CSS
  `aspect-ratio: 1/1`, `object-fit: cover`, `loading="lazy"`, on-
  error fallback to the subtle music-note SVG instead of the
  browser's broken-image glyph.
- **Album art recovery — re-extraction.** Added
  `artworkVersion` field on track records; `scanArtwork` and
  per-track context-menu re-extract trigger a fresh pull for any
  track without `artworkVersion >= 2`. Recovery path for the
  ~half-rendered thumbnails that already existed in IDB pre-fix.
- **Pre-existing drag-handler bug fix.** Dotted gold outline
  around `LibraryPanelV2` could get stuck "on" when internal drags
  (track-row reorders, text selection) ended outside the wrapper
  without firing `drop`. Two-part fix: `onDragOver` now gates on
  `dataTransfer.types.includes("Files")`, and a window-level
  `dragend` + `drop` listener resets the flag as a safety
  backstop. Visible benefit: the outline only appears for actual
  file drags, never gets stuck across sessions.

### PROTOCOL ESTABLISHED
- **CLAUDE.md** created with Verification Protocol baked in. The
  protocol mandates a verification report on every shipped change
  with explicit build status, runtime check, test data, and a
  separate "verified vs assumed" section. **Including bundle byte
  verification** — every visible UI string and DOM-marker is
  scanned in the emitted bundle before declaring a UI feature
  shipped.
- **Three "shipped but invisible" UI bugs caught only because of
  the protocol:**
  - Session 1's `↻ Re-analyze` right-click menu item was shipped
    into the dead `TrackRow` / `LibraryPanel` v1 code path —
    invisible to the user the whole time.
  - Session 2.5's `↻ Re-extract artwork` item: same issue, same
    code path.
  - Session 4's `Scan artwork` and `Analyze library` toolbar
    buttons: same issue, no UI surface in `LibraryPanelV2`.
  - All three were caught by checking `document.body.innerText.
    includes('GRID') === false` (and equivalents) before declaring
    "the feature works." Bundle byte scan + DOM presence check
    are now standard.
- **Investigation-first pattern confirmed.** Step-1 read /
  step-2 propose / step-3 implement remains the cheapest path
  through ambiguous bug reports. The grid-editor work especially
  benefited from this — the "missing tab strip" / "missing
  toolbar" issues surfaced before any commit was made.

### FEATURES SHIPPED
- **Auto-maintenance.** Artwork scan + BPM/key analysis now run
  silently in the background on app mount (after a 4 s settle
  delay) and on every new track import. Toolbar "Scan artwork"
  and "Analyze library" buttons removed — UI is now invisible
  unless work is in flight, in which case a subtle progress line
  at the bottom of the library shows "Updating artwork… N of M"
  or "Analyzing N of M". Sequential (artwork → analysis) so they
  don't contend on main-thread `decodeAudioData`.
- **Right-click menu cleaned of developer-speak.** `↻ Re-analyze`
  and `↻ Re-extract artwork` items removed (auto-maintenance
  covers both cases). Final menu: track title (dim header) ·
  Load to Deck A · Load to Deck B · Remove from Library.
- **Beatgrid editor v1 — Set-Beat-1 marker.** Single ~4×18 px
  vertical bar icon to the left of the Cue button on each deck.
  White accent on top (~3 px), red `#FF3B30` below (~15 px) —
  Rekordbox's beatgrid-marker visual language. Click writes the
  current playhead position to the track's `gridAnchorSec` field
  via `lib.setGridEdit`. **Snap-to-transient** active on every
  click: scans ±50 ms of the live `AudioBuffer` at sample
  precision, finds the loudest sample, snaps if `peakAbs ≥ 2 ×
  meanAbs`, falls back to the raw playhead otherwise. Persists
  in IndexedDB. Sync handlers, beat-skip buttons, and partner
  broadcast all respect user edits via the new
  `effectiveBpmResults` merge (precedence: analyzer → Rekordbox
  PQTZ → user override). Verified working: 11.56× ratio kick
  snap on Deck B test.
- **Pure black background.** App background flipped from
  `#0A0B0E` (cool near-black) to `#000000` for OLED display
  optimization. Three surfaces touched: `index.html` body,
  CollabMix root container, top bar (preserving the `f0` alpha
  for the backdrop blur). Deck cards (`#15171A`), library rail
  (`#0D0F12`), and other component-level surfaces unchanged —
  now read with sharper visual hierarchy against the true-black
  page bg.

### CODE CLEANUP
- **1,070 lines of dead code removed** in a single commit. Seven
  components purged after grep-confirmed zero JSX consumers:
  `TrackRow` (141 lines), `LibraryPanel` v1 (625), `ZoomedWF`
  (154), `BeatGrid` (43), `SyncPanel` (25), `ChatPanel` (20),
  `ChatBar` (51). Bundle output identical pre/post deletion —
  Vite's tree-shaker had already excluded all of it — confirming
  the cleanup is purely source-level with zero runtime risk.
- Main file: **7,674 → 6,604 lines** (−13.9%).

### FINAL COMMIT
`cc426d1` — Delete 7 dead components.

### DEFERRED for next session
- Brand + UX design principles conversation: target user, tone,
  differentiators, "the one thing Mix//Sync stands for."
- Path A waveform glow rendering.
- "Scan computer for music" feature.
- Rekordbox XML import.
- iTunes XML import.
- USB drive handling.
- AcoustID metadata fix (track ID lookup for tracks without
  good ID3 metadata).
- Library UI deeper redesign.
- Empty state design.
- Metronome audio for the beatgrid editor (visual pulse v1
  shipped; audio click deferred).

## May 26, 2026 — Atmospheric Anjunadeep deck palette

Foundational brand-color shift. The May 23 "Quick Wins" Material
Design deck pair (`#1976D2` Dusk Blue / `#00C853` Deep Emerald Glow)
shipped to production but on review read as "consumer software /
Android" rather than "pro DJ tool." Replaced with an atmospheric,
desaturated palette aligned to the Anjunadeep / Above & Beyond /
Universal Audio aesthetic register.

### Palette change
- **Deck A: `#1976D2` → `#3D5A80`** (Twilight Blue) — desaturated
  atmospheric blue, deeper and more set than Material primary 700.
- **Deck B: `#00C853` → `#5F8B95`** (Atmospheric Teal) — deep ocean
  teal / sophisticated gray-blue. A vs B now reads through hue
  family (blue vs teal) rather than the bright blue-vs-green
  contrast.
- Pure black `#000000` background (May 25 evening) preserved.
- Text `#F5F5F7`, beatgrid marker red `#FF3B30`, white-accent tier
  system all preserved.

### Semantic green decoupled
The old Deck B `#00C853` was doing double duty as both deck identity
and "green = online / ready" status color. A naive bulk replace
would have broken the Rekordbox ready badge, the partner online dot,
and adjacent landing-page brand cues. Introduced a module-level
constant `STATUS_OK = "#22c55e"` (consolidating with the existing
inline `#22c55e` usage at partner-volume / START-STREAM / BPM
sites). Re-routed two semantic-green sites (Rekordbox ready badge,
partner online dot) to `STATUS_OK` before the bulk Deck B replace.
The five landing-page brand-decoration sites (MIX//SYNC logo
gradients ×2, hero radial glow, deck mockup color array, crossfader
preview) followed the bulk replace into the new Deck B teal — those
are brand decoration, not status semantics, and should track the
deck identity.

### CSS variables cleaned
The `:root { --deck-a / --deck-b }` declarations and the
`@supports (color: color(display-p3 ...))` wide-gamut override block
in `src/index.css` were confirmed dead code — no `var(--deck-a)`
consumers anywhere; every JSX site inlined the hex literal. The
"keep the two in sync" comment was aspirational, not enforced.
Both blocks deleted. For atmospheric desaturated colors P3 also
gives zero visible benefit (both new colors well within sRGB gamut).

### Verification per CLAUDE.md
- **Build clean**: `vite build` produces `dist/assets/main-C75qnnc1.js`
  at 548.33 kB gzip 176.69 kB (no size regression vs prior 540ish kB).
  All four chunks build, ✓ 364 modules transformed.
- **Bundle byte scan (precise occurrence counts via `grep -oE`)**:
  - `3D5A80`: **16** occurrences in main bundle ✓
  - `5F8B95`: **22** occurrences in main bundle ✓
  - `22c55e` (STATUS_OK): **24** occurrences ✓
  - `1976D2` (case-insensitive): **0** ✓
  - `00C853` (case-insensitive): **0** ✓
  - Alpha-variant sweep (`#1976D2[22|44|55|88|aa]`, `#00C853[22|44|55|88|aa]`
    — eight known variants from the investigation) all zero in source.
  - Equality-check site preserved: bundle contains
    `ne.current==="#3D5A80"?"A":ne.current==="#5F8B95"?"B":"?"` —
    deck-id derivation in the debug logger still works under the
    new strings.
- **Lint**: not runnable (`npm run lint` still errors with the
  pre-existing "ESLint couldn't find eslint.config.js" — ESLint v9
  migration outstanding from Session 2). Flagged unchanged.
- **Runtime check**: build artifact verified, but full live load
  in a browser is the user-side verification step below.

### What's verified vs assumed
- **Verified** by direct bundle inspection: every old hex is gone,
  every new hex is present, the equality-check site at line 2901
  (now renumbered after edits) compiled correctly with both sides
  of the ternary changed, the semantic-green re-route compiled into
  `STATUS_OK` references.
- **Assumed** (architecturally sound but not visually verified by
  me): waveform Canvas2D `shadowColor` calls now using the new
  atmospheric hex render correctly; deck-color border alpha
  variants (`#3D5A8044` etc.) still produce the intended subtle
  driver-highlight borders; landing-page MIX//SYNC logo gradients
  composite cleanly with the new teal as the gradient endpoint.
- **Live verification pending** — requires a browser.

### Known limitations
- The new desaturated palette will not show its full atmospheric
  character until **Path A multi-layer offscreen canvas glow
  compositing** ships. Current canvas-2D multi-pass additive glow
  is at its ceiling; the new hues are deliberately chosen to compose
  well under Path A's wide-halo + concentrated-halo + crisp-shape
  layering, which means flat-fill UI elements (knob rings, VU bars,
  small chips) will look "deeper" but the waveforms themselves will
  feel atmospheric only after the next major rendering pass.
- Landing-page MIX//SYNC logo gradient now goes gray → teal rather
  than gray → green. Visually less vibrant than the prior Material
  green endpoint; consistent with the new restrained brand register.
  If the landing page later gets a dedicated brand-color pass, this
  is a candidate site for re-evaluation.

### Recommended user verification
1. Hard refresh (Cmd+Shift+R) on `collabmix.vercel.app` after deploy.
2. Look at Deck A — should read as deeper, atmospheric Twilight Blue
   (NOT bright Material blue). Check the deck letter, the VU meter,
   the waveform color, the knob rings, the volume fader.
3. Look at Deck B — should read as atmospheric teal-blue (NOT bright
   green). Check the same elements as Deck A.
4. **Partner online dot in P2P AUDIO panel should STILL BE GREEN**
   when a partner is connected — proves the semantic-green re-route
   worked. (If it's teal-blue, the Pass-B re-route failed.)
5. **Rekordbox "ready" badge** (after connecting a Rekordbox library)
   **should STILL BE GREEN** — same proof.
6. Landing page hero — MIX//SYNC logo text gradient now ends in teal
   instead of green. Confirm this reads as intentional / brand-aligned.
7. Pure black `#000000` background still in place (no regression
   from the May 25 evening session).
8. No other regressions: load a track on each deck, hit Sync, hit
   Set-Beat-1, verify chat / library / waveform all render normally.

### Files changed
- `src/index.css` — deleted dead `:root` block + `@supports` P3 block.
- `src/collabmix-production.jsx` — added `STATUS_OK` constant; re-
  routed Rekordbox ready badge (3 hex sites) + partner online dot
  to `STATUS_OK`; bulk-replaced `1976D2` → `3D5A80` (18 sites) and
  `00C853` → `5F8B95` (remaining 23 sites after Pass B); updated
  `TOK.deckA` / `TOK.deckB` inline comments to new color names.
- `tools/docs/DESIGN_PHILOSOPHY.md` — rewrote "Colors (current)"
  block at the top, added "Banned colors" subsection, added May 26
  entry to the status log, blockquoted the May 24 block as
  SUPERSEDED.

### Deferred (unchanged from May 25 evening)
Path A waveform glow rendering remains the next major visual lever.
The new atmospheric palette is deliberately a "down-payment" on
Path A — flat fills change today; waveform compositing depth
changes when Path A ships.
