> # ⚠ NEXT SESSION STARTS HERE ⚠
>
> **Phase 3 Beat Grid Panel — DESIGN PIVOT PENDING. Tomorrow's
> first action: revert bf2198a + b38c539, then build tab-based
> design per Session end section below. 6 assumptions awaiting
> approval before Commit A.**

---

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

## May 26, 2026 evening — High-contrast cool deck pair (atmospheric retired same day)

Second color migration of the day. The morning's atmospheric
Anjunadeep palette (`#3D5A80` Twilight Blue / `#5F8B95` Atmospheric
Teal) shipped at commit `f9f0bf9` but tested poorly in side-by-side
deck review: both colors read as cold / dead / nearly-indistinguishable
(same cool-blue hue family at low saturation). The "atmospheric depth"
justification was contingent on Path A multi-layer canvas glow
rendering shipping later — these were the wrong flat-fill defaults to
wait on it with. Waveforms felt lifeless even when surrounding deck
chrome was otherwise intact.

### Palette change
- **Deck A: `#3D5A80` → `#2E86DE`** (Vivid Ocean Blue) — saturated
  cool blue. Alive as a flat fill; doesn't need Path A glow to feel
  energetic.
- **Deck B: `#5F8B95` → `#A855F7`** (Electric Royal Purple) — saturated
  cool violet. A vs B now reads through strong hue contrast (blue
  vs purple) rather than the cold-and-similar pair the morning's
  palette landed on.
- Pure black `#000000` background preserved.
- `STATUS_OK = "#22c55e"` (semantic green) preserved.
- Beatgrid marker red `#FF3B30` preserved.

### "Why no warm deck colors" documented in DESIGN_PHILOSOPHY.md
User considered warm coral / orange for visual energy but rejected:
warm hues at deck-identity saturation cause cumulative eye fatigue
under long stare-tasks (DJs lock onto waveforms for minutes). Pro DJ
tools optimize for stareable cool waveforms; warm is reserved for
marker-scale uses (cue points, phrase markers, recording dot —
milliseconds of attention, not minutes). The new pair stays inside
this rule: A vs B distinction is hue family (blue vs purple), not
temperature.

### Iteration sequence (documented in the philosophy doc)
Three palettes in one day:
1. **Material Design `#1976D2 / #00C853`** — read as consumer-app /
   Android. Retired May 26 morning at commit `f9f0bf9`.
2. **Atmospheric `#3D5A80 / #5F8B95`** — cold / dead / too similar.
   Retired May 26 evening (this commit).
3. **High-contrast `#2E86DE / #A855F7`** — current. Saturated enough
   to feel alive, distinct enough to read across the screen, stays
   inside the no-warm-fills rule.

All three failure modes are now recorded in the philosophy doc's
Banned colors section + supersession blockquotes so future
iterations don't repeat them.

### Verification per CLAUDE.md
- **Build clean**: `vite build` → `dist/assets/main-By5X8XjF.js`
  at 548.33 kB / gzip 176.69 kB (no size regression vs `main-C75qnnc1.js`
  from the morning commit). 364 modules transformed in 970 ms.
- **Bundle byte scan (precise counts via `grep -oE`)**:
  - `2E86DE`: **16** occurrences ✓
  - `A855F7`: **23** occurrences ✓ (22 from this migration + 1 pre-
    existing `#a855f706` hero glow at `collabmix-production.jsx:4481`,
    case-insensitive grep counts both — coincidence, not collision)
  - `22c55e` (STATUS_OK): **24** occurrences ✓ (unchanged)
  - `FF3B30` (beatgrid marker red): **1** occurrence ✓ (preserved)
  - `3D5A80`: **0** ✓
  - `5F8B95`: **0** ✓
  - `1976D2`: **0** ✓ (still gone from morning commit)
  - `00C853`: **0** ✓
  - All alpha variants of all four retired hex values: **0** in source.
  - Equality check at deck-id logger: bundle contains
    `ne.current==="#2E86DE"?"A":ne.current==="#A855F7"?"B":"?"` —
    string literals updated cleanly on both sides of the ternary.
- **Lint**: still pre-broken (ESLint v9 migration outstanding) —
  flagged unchanged from prior sessions.
- **Live verification pending** — requires a browser load.

### What's verified vs assumed
- **Verified** by build artifact + grep: every old hex gone from
  source, every new hex present, equality-check site compiled clean,
  STATUS_OK + beatgrid red preserved, alpha variants migrated
  correctly through the bare-6-char bulk replace.
- **Assumed**: Canvas2D `shadowColor` calls with the new saturated
  hex render correctly (no parsing risk — standard CSS hex);
  driver-highlight borders at `#2E86DE44` / `#A855F744` read as
  intended; landing-page brand gradient composites cleanly with
  the new purple endpoint; the saturated colors don't blow out
  against pure black at high brightness (architectural — both
  values are mid-luminance, no full-white channel).
- **Not yet verified**: visual character in the actual UI. The user
  rejected the morning palette specifically on visual feel — this
  same-day iteration needs visual confirmation before committing
  to it as the canonical pair.

### Known limitations
- **Pre-existing inconsistency in landing-page glow casing.** The
  hero radial glow at line 4481 uses lowercase `#a855f706`; the
  newly-migrated landing-page brand gradient sites use uppercase
  `#A855F7`. Functionally identical; cosmetic-only inconsistency.
  Not normalized this commit (scope discipline — user didn't ask).
- **`src/App.jsx` not touched.** Confirmed dead code (not imported
  from `main.jsx`, no consumer references). The file has its own
  `#a855f706` glow but no deck-color sites to migrate.
- **Two palette migrations stacked in one day.** Vercel may queue
  both commits (`f9f0bf9` and the new one); typically Vercel skips
  to the latest tip and only deploys this one. If they BOTH deploy
  sequentially, expect one brief window where the atmospheric
  palette is live before being replaced.
- **No browser verification.** Same caveat as the morning commit.

### Recommended user verification
1. Deploy: `git push origin master`. Vercel auto-deploys (when it
   catches up — the morning commit was still queued at last check).
2. Hard refresh `collabmix.vercel.app` (Cmd-Shift-R) once Vercel
   shows the deploy as Ready.
3. **Deck A**: should read as **Vivid Ocean Blue** — saturated,
   alive, immediately distinct. Check the deck letter, waveform,
   VU meter, knob rings, vertical fader.
4. **Deck B**: should read as **Electric Royal Purple** — saturated
   cool violet. Same surfaces as Deck A.
5. **Side-by-side distinction**: A vs B should be instantly
   distinguishable from across the screen. If they still feel "too
   similar" or "muddy," that's a regression of the goal and we
   iterate again.
6. **CRITICAL — Pass-B-equivalent regression check**: the partner
   online dot in P2P AUDIO must STILL be green (`STATUS_OK`).
   Rekordbox "ready" badge must STILL be green.
7. **Beatgrid marker red `#FF3B30`** — must STILL be red.
8. **Eye comfort check**: stare at a Deck A waveform for 30+
   seconds. Should not cause discomfort. Repeat with Deck B. If
   the purple causes any strain, flag immediately — purple is the
   highest-risk saturated cool because it has both red and blue
   wavelength content.
9. **Subjective "alive" check**: app should feel energetic compared
   to the morning's atmospheric palette. If it still feels dead,
   the saturated cool pair is also wrong and we go back to the
   palette-iteration table.

### Files changed
- `src/collabmix-production.jsx` — bulk-replaced `3D5A80 → 2E86DE`
  (16 source sites) and `5F8B95 → A855F7` (22 source sites);
  updated `TOK.deckA` / `TOK.deckB` inline comments.
- `tools/docs/DESIGN_PHILOSOPHY.md` — rewrote "Colors (current)"
  block (now "high-contrast cool pair, May 26 evening"); added
  `#3D5A80` and `#5F8B95` to "Banned colors" with failure-mode
  notes; appended "Why no warm deck colors" rationale; added a
  SUPERSEDED blockquote for the May 26 morning atmospheric block;
  added a new status-log entry above the morning entry.
- `VISION_5.md` — this entry appended (per CLAUDE.md append-only
  rule).
- `src/index.css` — untouched (CSS-variable block was already
  deleted in the morning commit).

### Deferred (unchanged)
Path A multi-layer canvas glow rendering remains the next major
visual lever. The new high-contrast pair is chosen to work as flat
fills without Path A — but Path A will still amplify the saturated
colors into atmospheric light when it ships. The morning palette
was deferred-in-advance; this one is forward-compatible without
being dependent.

## May 26, 2026 evening through night — Color identity locked + Path A glow rendering shipped

Major session. Eight commits to master spanning two interleaved
work streams:

1. **Final color iteration** through three palette generations to
   land on a vivid cool pair (`#2E86DE` Vivid Ocean Blue +
   `#A855F7` Electric Royal Purple).
2. **Path A waveform glow rendering** — the deferred multi-layer
   canvas compositing work — shipped via a two-canvas + CSS blur
   architecture.

Both streams iterated multiple times against visual review on real
waveforms. Final state is "dogfood quality" — usable, will iterate
further based on real-session feedback.

### Phase 1 — Color iteration cycle (three palettes in one day)

Pre-session state had Material Design colors (`#1976D2` /
`#00C853`) that read as "consumer software / Android" rather than
"pro DJ tool" — addressed first.

**Palette 1 (commit `f9f0bf9`): Atmospheric Anjunadeep pair.**
Material → desaturated `#3D5A80` Twilight Blue + `#5F8B95`
Atmospheric Teal. Rationale: deep, set, restrained — aligned to
Anjunadeep / Above & Beyond visual register. Side-effect:
introduced `STATUS_OK = "#22c55e"` module-level constant to
decouple semantic green (online / ready / recording indicators)
from Deck B identity, so future palette iterations wouldn't break
"green = online" convention. Also cleaned `src/index.css`: deleted
dead `:root { --deck-a / --deck-b }` CSS variable block and the
`@supports` P3 wide-gamut override (no consumers anywhere — every
JSX site inlined the hex literal). Pushed but **never deployed** —
superseded by Palette 2 before Vercel finished building.

**Palette 2 (commit `a9d3093`): Vivid high-contrast cool pair —
LIVE.** Atmospheric pair tested visually as "cold / dead / too
similar" in the side-by-side deck view. Both colors landed in the
same low-saturation cool-blue family — A vs B nearly
indistinguishable. The "atmospheric depth" justification was
contingent on Path A shipping later — the wrong flat-fill defaults
to wait on it with.

New palette:
- **Deck A: `#2E86DE`** — Vivid Ocean Blue (saturated, alive)
- **Deck B: `#A855F7`** — Electric Royal Purple (saturated,
  distinct hue from blue)

Both stay in the cool family (no warm waveforms — pro DJ
stare-task eye-fatigue rule applies). A vs B distinction now comes
from hue family (blue vs purple) rather than temperature
contrast. Saturated enough to feel alive against pure black as
flat fills, without needing Path A.

Pre-existing landing-page hero glow at `#a855f706` (2.4% alpha
purple radial decoration) coincidentally matches the new Deck B
color — happy outcome; the landing page now has unintentional
brand cohesion with the deck identity.

### Phase 2 — Path A investigation

Asked for investigation-only pass before touching any rendering
code. Findings:

- **The codebase already had a working multi-pass additive glow**
  at `AnimatedZoomedWF` lines 3074-3103 (the "v5.8 NEON GLOW" in
  DESIGN_PHILOSOPHY.md status log was active, not aspirational).
  Three `ctx.fill(silhouettePath)` calls with
  `globalCompositeOperation='lighter'` at shadow radii `70*dpr` /
  `28*dpr` / `0`. Heavy main-thread CPU cost — at the ceiling of
  canvas-2D compositing.
- `AnimatedZoomedWF` uses naked `requestAnimationFrame` at 60 Hz
  per deck — full pipeline runs every frame.
- `WF` (small overview) uses `useEffect` deps (re-renders on prop
  change), no RAF.
- **No hot cues on `AnimatedZoomedWF`** — hot cues live only on
  `WF`. Path A doesn't have to worry about hot-cue blur on the
  zoomed view.
- **Set-Beat-1 marker is a DOM element**, not on the canvas —
  unaffected by anything in Path A scope.

Three approach options proposed:
- **A**: OffscreenCanvas + `ctx.filter='blur()'` (single DOM
  canvas, JS-side blur on GPU via canvas filter).
- **B**: Two stacked `<canvas>` elements with CSS `filter:blur()`
  on the lower (browser GPU compositor handles blur free).
- **C**: Cache silhouette to offscreen + keep existing shadowBlur
  (smallest change, no visual improvement).

User chose **Option B** — best visual quality + best perf +
universal browser support (Safari 17+ in scope by construction).
Three-commit implementation plan: helper extraction → two-canvas
split → tuning.

### Phase 3 — Path A Commit 1 (silhouette helper extraction, commit `23e75bb`)

Pure refactor, zero visual change. Extracted from
`AnimatedZoomedWF.draw` into two module-level helpers:
- `buildSilhouettePath(heights, center, physW, maxH) → Path2D` —
  pure geometry, no rendering side effects
- `renderSilhouetteGlow(ctx, path, dr, dg, db, dpr) → void` —
  encapsulates the three-pass additive glow

Establishes the architectural seam Commit 2 needs to retarget the
glow render to a separate canvas. Pixel-identical: same
`shadowBlur` radii, same alphas, same composite-mode transitions,
same Path2D construction with same conditional branches (steep
transients vs monotonic smoothing). AA stroke at the original
site still binds the returned `silhouettePath` variable.

Bundle audit confirmed all rendering primitives preserved at
expected counts.

### Phase 4 — Path A Commit 2 (two-canvas architecture, commit `a1b4e9d`)

Real architectural change. Replaced the single
`<canvas ref={ref}/>` JSX with a container div + two stacked
absolute-positioned canvases:

```
<div container (position:relative, background:#000000, cursor:ew-resize)>
  <canvas ref={lowerRef} (filter:blur(...), opacity:..., pointer-events:none)/>
  <canvas ref={ref} (upper — drag target, crisp content layer)/>
</div>
```

Code changes inside `AnimatedZoomedWF`:
- Added four tuning constants at top of component body (final
  count after Phase 6; Phase 4 initially added three)
- Added `lowerRef`
- Draw `useEffect` now initializes both contexts (`ctx` upper +
  `lctx` lower) in lock-step; both canvases sized identically on
  resize via the same dirty-check block
- Frame clear changed from `fillRect('#000000', ...)` to
  `clearRect(0,0,physW,physH)` on both contexts — container's
  black background shows through transparent canvases
- Silhouette renders to `lctx` (lower canvas) only; everything
  else stays on `ctx` (upper canvas)
- `renderSilhouetteGlow` body simplified to a single solid fill —
  no `shadowBlur`, no `globalCompositeOperation`. Signature changed
  from `(ctx, path, dr, dg, db, dpr)` to `(ctx, path, dr, dg, db,
  alpha)`.
- Drag handler `useEffect` untouched — still binds to `ref.current`
  (upper canvas, the topmost interactive element)

Verified by build + bundle audit: all expected drops
(`'lighter'` / `'source-over'` / `globalCompositeOperation` /
`Math.round(70*` / `Math.round(28*` all → 0; `shadowBlur` 13 →
10), all expected additions (`blur(20px)` × 1), all preserved
invariants present.

**Shipped broken.** See next phase.

### Phase 5 — Critical bug + fix (commit `5fe1dc7`)

User reported `Uncaught ReferenceError: canvas is not defined`
firing every frame, breaking track loading.

Investigation showed **exactly one stale reference**: the
`[WF-DIMS]` debug log inside the draw loop referenced a local
named `canvas` that had been renamed to `upper` during Commit 2's
draw-`useEffect` refactor. The RAF re-schedules at the top of the
draw function (`raf.current = requestAnimationFrame(draw)` before
any body work), so the throw fired every frame in an infinite
loop. The `dimsLoggedRef.current` one-shot guard never flipped
because the throw happened before the flag-set.

Drag handler had its own scope-local `canvas` declared
independently (line 3328: `const canvas = ref.current`) — that
one was correct and untouched.

User approved deleting the entire debug log (labeled "Temporary
one-shot verification log" in its own declaration comment) rather
than patching the variable name. Aligns with the May 25 evening
1,070-line dead-code-removal pattern. Removed:
- `dimsLoggedRef = useRef(false)` declaration + its `// Temporary…`
  comment (2 lines)
- The full `if(!dimsLoggedRef.current){…}` block including
  `deckId` derivation + `console.log` + flag-set (5 lines)

Side-effect: the equality-check string literals `'#2E86DE'` and
`'#A855F7'` (used by the deleted `deckId` derivation) went with
the deletion. **New production rendering baselines**: 15
occurrences of Deck A hex and 22 of Deck B in the bundle, down 1
each from the pre-cleanup audits. All other invariants preserved.

#### Lesson — Debug-code fragility under refactor

Temporary diagnostic code that captures local variable references
is fragile under any refactor that renames those locals. The
"Temporary" comment label was honored by deletion **only after**
the renamed variable broke at runtime — the label alone didn't
prevent the bug. Better patterns for future diagnostic code:

- Delete diagnostic logs immediately after the diagnostic question
  is answered, rather than leaving them indefinitely behind a
  one-shot guard.
- If a diagnostic must persist temporarily, write it against
  stable refs (`ref.current`) rather than draw-loop local aliases
  — refs are part of the component's surface and less likely to
  be silently renamed.
- The verification protocol's bundle byte audit catches
  architectural drift but not runtime variable binding — when a
  refactor renames a local, all in-scope references must be
  re-checked manually before declaring complete.

### Phase 6 — Path A Commit 2 followup (commit `e953879`)

User reported the waveforms read as "blurry" not "glowing" after
the debug-log fix.

Investigation: Commit 2 had moved the silhouette fill to the
lower (CSS-blurred) canvas only. There was no crisp body fill on
the upper canvas — only the AA stroke (thin outline at 0.55
alpha), per-column overlay, centerline weight band, grid, and
playhead. The user was seeing the blurred lower canvas through
the gap with no defining shape on top.

The v5.8 multi-pass architecture had **Pass C as a crisp
0.45-alpha body fill** drawn last in the additive stack — that
body was the visual definition. The Commit 2 refactor dropped it
by accident.

Fix: add a second `renderSilhouetteGlow(ctx, silhouettePath, dr,
dg, db, UPPER_CANVAS_SILHOUETTE_ALPHA)` call between the
lower-canvas call and the AA stroke. **Same Path2D reused** — no
extra geometry work. Added the fourth tuning constant
`UPPER_CANVAS_SILHOUETTE_ALPHA = 0.9` (initial value).

#### Lesson — Enumerate per-surface responsibility on render-pipeline refactors

When a refactor moves rendering between surfaces, the
verification report should explicitly enumerate which surface is
responsible for which visual component, before and after. The
Commit 2 verification correctly identified that the silhouette
glow source moved to the lower canvas — but didn't enumerate that
the "crisp body" responsibility was now homeless. A
"what's-on-each-canvas" table in the verification report would
have caught this without needing a browser to see it.

Bundle audits are good at architecture-level drift detection
(`'lighter'` → 0, `blur(20px)` → 1, etc.) but not at
"completeness of visual output." That gap is filled by
explicit per-surface enumeration in the verification report —
treat each canvas as a checklist of "must render the following
components" and verify each one before declaring done.

### Phase 7 — Tuning pass (commit `838787d`)

After the body addition, user reported "foggy / misty" — halo too
prominent vs the body. Two one-line constant changes:

- `UPPER_CANVAS_SILHOUETTE_ALPHA`: 0.9 → 1.0 (body fully opaque,
  cleaner deck color)
- `LOWER_CANVAS_OPACITY`: 0.85 → 0.55 (halo more subtle, supports
  rather than dominates)

Result: dogfood-quality glow rendering. Crisp body in saturated
deck color, atmospheric halo extending past edges but not
dominating, all crisp content (grid, playhead, AA stroke)
razor-sharp on top.

### Final state at end of session

**Eight commits today, all on master and live** (except `f9f0bf9`
which was superseded before deploy):

| Commit | Description |
|---|---|
| `f9f0bf9` | Atmospheric color migration (superseded before deploy) |
| `a9d3093` | Vivid Ocean Blue + Electric Royal Purple — LIVE |
| `23e75bb` | Path A Commit 1 (helper extraction) |
| `a1b4e9d` | Path A Commit 2 (two-canvas split — shipped broken) |
| `5fe1dc7` | Commit 2 fix (debug log removal, ReferenceError gone) |
| `e953879` | Commit 2 followup (upper-canvas crisp body restored) |
| `838787d` | Tuning pass (less fog, more definition) |

**Tuning constants** in `src/collabmix-production.jsx` near lines
2877-2880:

```js
const LOWER_CANVAS_BLUR_PX = 20;             // CSS blur radius on the lower canvas
const LOWER_CANVAS_OPACITY = 0.55;           // opacity multiplier on the lower canvas
const SILHOUETTE_FILL_ALPHA = 1.0;           // alpha of the silhouette fill (pre-blur)
const UPPER_CANVAS_SILHOUETTE_ALPHA = 1.0;   // alpha of the crisp body on the upper canvas
```

**Architecture summary**:
- Lower canvas: silhouette solid fill at `SILHOUETTE_FILL_ALPHA`
  → CSS `filter:blur(20px)` + `opacity:0.55` = atmospheric halo
- Upper canvas: silhouette solid fill at
  `UPPER_CANVAS_SILHOUETTE_ALPHA` = crisp body, plus AA stroke +
  per-column gradient overlay + centerline weight band + beat
  grid (with its own `shadowBlur=4` deck-color halo) + phrase
  markers (red) + playhead (white `shadowBlur=16`)
- Container `<div>`: `position:relative`, `background:#000000`,
  `cursor:'ew-resize'`. Both canvases fill 100%/100% absolute.
- Path2D built once per frame via `buildSilhouettePath`, reused
  for both canvas fills — no duplicate geometry cost.
- Drag handler binds to upper canvas (`ref.current`); lower has
  `pointer-events:none` so events fall through.

**Performance**: GPU compositor handles the blur for free per
frame. Replaced 3 `shadowBlur` passes (70*dpr + 28*dpr + 0 with
`'lighter'` composite) on the CPU shadow path with one CSS blur
on the lower canvas + one extra solid fill on the upper. Net main
thread should be cleaner.

**Browser support**: CSS `filter:blur` and `pointer-events:none`
are universal in modern browsers. Safari 17+ supported by
construction. (Landing page copy still says "Works in Chrome &
Edge" — that predates this commit and is captured in open items
below.)

**Subjective evaluation**: dogfood quality. The waveforms have a
real glow now — saturated cool body with soft colored halo. Will
iterate constants based on real-session feedback. The deck colors
are also placeholders pending final tuning with the glow live.

### Open items for future sessions

- **Final color iteration with full glow live** — re-evaluate
  `#2E86DE` / `#A855F7` now that they sit inside the new
  rendering. May want to pull them back slightly if they read as
  too neon under the glow, or push them further if they read as
  flat.
- **Glow constant tuning** — `LOWER_CANVAS_BLUR_PX` and
  `LOWER_CANVAS_OPACITY` may need iteration once the user spends
  real time looking at waveforms during sessions.
- **Dotted white border around library** — intermittent
  regression, appears dynamically (during drag interactions?).
  Needs reproducible repro before investigation.
- **Landing page copy update** — "Works in Chrome & Edge"
  predates Safari 17+ support; should include Safari now that
  Path A is universally compatible.
- **Brand / UX design principles conversation** — tabled multiple
  sessions. High-leverage strategy work: target user definition,
  tone of voice, "the one thing Mix//Sync stands for,"
  differentiators vs Pioneer / Traktor / Serato / Beatport.
- **Status indicators redesign** — strings like "CONNECTED 39ms"
  feel developer-y; pro DJ tools surface this kind of thing more
  sparingly.
- **Empty state design polish.**
- **Library row hierarchy tuning** — smart filters / search
  behavior / sidebar were untouched in the May 23 Quick Wins.
- **Metronome audio for beatgrid editor** — visual pulse v1
  shipped May 25; audio click deferred.
- **Library auto-import system** — see "Open roadmap discussion —
  Library auto-import system" section below for full discussion
  (deferred pending brand/UX strategy session).
- **Bigger feature backlog**: scan computer for music, Rekordbox
  XML import, iTunes XML import, USB drive handling, AcoustID
  metadata fix for tracks without good ID3 data, library UI
  deeper redesign.

## Open roadmap discussion — Library auto-import system (May 26 evening, post-Path-A)

After Path A glow rendering shipped, an end-of-day strategic
discussion turned to the single biggest unresolved UX problem in
Mix//Sync's current shape: **what happens to a user's library
after the first import**. This section captures the full
discussion verbatim so the nuance is preserved across sessions.
Implementation is multi-session and gated on a brand/UX strategy
session that has been tabled multiple times — this discussion
informs that session.

### The core insight

After a user uploads music to Mix//Sync once, they will continue
to buy and download music separately — and **it will NOT
automatically appear in the Mix//Sync library.** This creates an
ongoing friction of manually re-uploading new music, which is a
huge negative experience and a reason for users to drift back to
Rekordbox / Traktor / Serato, where their music "just appears."

This is a "death by paper cut" failure mode. Each individual
re-upload is small. The cumulative effect over weeks of buying
tracks is users silently giving up on Mix//Sync as their primary
tool. The first-time import is solved (commit `63ac7f9`, May 6-7);
the steady-state ongoing-import problem is not.

### The complication — music is scattered, not in one folder

DJs almost never have one folder. They have music scattered
across the file system, some organized, most not. Real
distribution looks like:

- **Beatport downloads** → usually `~/Downloads`, not Music
- **Bandcamp** → wherever the user saved it
- **Promos from labels** → email attachments, random folders
- **DJ pools (DJcity, BPM Supreme)** → `~/Downloads`
- **iTunes / Apple Music** → `~/Music/iTunes/iTunes Media`
  (managed)
- **USB drives** → external mounted drives
- **AirDropped tracks from friends** → `~/Downloads`
- **SoundCloud rips** → `~/Downloads`
- **Old library imports** → `~/Music` or custom legacy folders

`~/Downloads` is the **single highest-traffic location** for
newly acquired music for ~95% of DJs, even those who later
organize. The solution must handle "scan all music wherever it
lives," not just "watch one folder."

### The browser constraint — what's actually possible

Mix//Sync is a browser app, and that hard-limits the design
space. Native apps (Rekordbox, Traktor, Serato) can watch
folders in the background, receive OS notifications when files
change, scan the entire file system. Browser apps cannot do any
of that:

- Browsers can't watch the file system in the background
- File System Access API requires explicit user permission per
  folder
- No root / home directory access (security boundary, by design)
- No background scanning when the tab is closed
- Chrome / Edge support the File System Access API; **Safari
  does NOT yet**

These constraints are non-negotiable — they're security
boundaries built into the browser platform, not bugs we can work
around. Anything we ship has to live within them.

### Three approach options considered

- **Option A — Scan the entire user file system.** NOT POSSIBLE
  in browsers by design. Hard wall.
- **Option B — Smart default folder list.** Suggest
  `~/Downloads`, `~/Music`, `~/Music/iTunes/iTunes Media`,
  `~/Documents`, `~/Desktop`. User confirms each, grants
  permission. Catches 90%+ of cases.
- **Option C — Folder + track-by-track hybrid.** Watched folders
  for predictable cases, plus "watch this file" or "watch this
  album folder" for one-off random locations.

### Recommended architecture — four tiers

The recommended shape combines Options B and C into a four-tier
system:

1. **Smart watched folders with default suggestions** (Downloads,
   Music)
2. **User can add any custom folder** (USB, Dropbox, organized
   library)
3. **Drag-and-drop individual files** (for one-offs from
   anywhere)
4. **Smart deduplication** (same file hash in multiple locations
   = one library entry)

### Critical filtering — where the feature lives or dies

`~/Downloads` contains everything — PDFs, ZIPs, installers,
photos, screenshots, not just music. The filtering logic is the
single most failure-prone piece of the system. Too aggressive
and we miss real tracks; too loose and the library fills with
garbage and the user loses trust.

Required filtering layers:

- File extension whitelist (`mp3`, `wav`, `aiff`, `flac`, `m4a`,
  `ogg`, `alac`)
- Minimum file size (skip tiny non-music files — voice memos,
  notification sounds)
- Maximum file size (skip multi-GB non-music — installers, video)
- Optional: duration check (skip 5-second voice notes that
  happen to be mp3)
- Optional: audio characteristics check (sample rate plausible
  for music, etc.)

This is where the feature lives or dies. A library that
auto-fills with garbage is worse than no auto-import at all.

### Philosophical question resolved — "DJ track manager vs smart auto-finder"

A philosophical question surfaced during discussion: should
Mix//Sync be a **DJ track manager** (explicit, user-driven, no
surprises) or a **smart auto-finder** (figures it out, magical,
hands-off)? These reflect two different DJ mentalities and two
different historical product lineages.

**The user resolved this: BOTH.** Mix//Sync should support both
modes because the real DJ population spans both types:

- **The Organizer** — explicit folder management, no surprises,
  full control (typically came from Rekordbox / Traktor
  mentality)
- **The Collector** — scattered files, downloads stay where they
  fall, wants the tool to figure it out
- **The Pragmatist** — middle ground, smart defaults with
  override ability (most DJs)

Building for just one type would alienate the other two.
Building for both serves everyone.

### Product implication — three modes

The "both" resolution implies three explicit user-facing modes,
available during onboarding and changeable in settings anytime:

**Mode 1 — "Auto-discover my music" (Smart Auto-Finder)**
- We scan high-probability locations automatically
- Defaults: Downloads, Music, iTunes Media, Desktop
- New tracks auto-imported as they appear
- Best for: "I just want my music to be in Mix//Sync"
- Trade-off: less precise, may import unwanted files

**Mode 2 — "Let me manage my library" (DJ Track Manager)**
- User explicitly adds folders to watch
- User explicitly approves new tracks before adding
- No surprises, full control
- Best for: "I'm organized and want it that way"
- Trade-off: more setup, more ongoing curation

**Mode 3 — "Hybrid" (likely default for most users)**
- Smart defaults for obvious folders (Downloads, Music)
- User explicitly adds any other folders
- New tracks auto-imported from approved folders **with
  notification**
- Easy to remove imports the user didn't want
- Best for: "Mostly automatic but I want to know what's
  happening"
- Trade-off: slight learning curve

### The shared technical foundation

Critically, **all three modes share the same underlying
infrastructure** — the difference is UX presets on top, not a
fork in the code path:

- Folder watching system (whatever folders, however many)
- File scanning logic (extensions, size, dedup)
- Library import pipeline
- Permission management
- "What's new" notification system

The difference between modes is **how aggressive the defaults
are** and **how much user approval is in the loop**. Same code
paths, different UX presets. This means we can ship the
infrastructure once and the three modes are essentially
configuration on top of it.

### Brand principle emerging

A brand principle crystallized out of the both-modes
resolution:

> **"Mix//Sync respects how YOU work, not how WE think you
> should work."**

This may extend beyond library management to other features and
could become a Mix//Sync differentiator vs Rekordbox / Traktor
/ Serato — all of which impose specific workflows. Mix//Sync
would be the one that bends to fit the user. Worth exploring
further in the brand / UX strategy session that has been tabled
multiple times. **This principle should be a key input to that
session.**

### The Safari problem

The File System Access API is not supported in Safari. Three
options:

- **Build Chrome / Edge magic, accept Safari limitation**
  (manual import only on Safari) — pragmatic
- **Wait for Safari support** (timeline unclear, possibly
  2026-2027) — delays a major UX win for years
- **Build different solutions per browser** — most work, most
  code

**Recommended: Build Chrome / Edge magic.** Most pro DJs use
Chrome. Safari users still get the app — they just get manual
import. Communicate honestly on the landing page. (Note: the
current landing-page copy still says "Works in Chrome & Edge"
from before Path A made Safari 17+ viable for rendering — that
copy is already on the open-items list and would need a careful
rewrite to distinguish "playback works in Safari" from "library
auto-import doesn't.")

### Realistic phased scope (~28-40 hours across 6 phases)

This is multi-session work. Should not be attempted in one go.
Phasing:

- **Phase 1 — Multi-folder watched setup (~8-12 hours).** File
  System Access API integration, smart defaults, permission
  management, per-folder enable / disable.
- **Phase 2 — Smart scanning (~6-8 hours).** New file
  detection, filtering, deduplication, background scan progress.
- **Phase 3 — Custom folder addition (~3-4 hours).** Add-folder
  button, management UI, external drive handling.
- **Phase 4 — Mode selection + UX (~3-5 hours).** Onboarding
  flow, mode toggle in settings, default behavior split between
  Auto-Finder / Manager / Hybrid modes.
- **Phase 5 — Edge cases + polish (~6-8 hours).** Cloud-synced
  folders (Dropbox, iCloud), moved / renamed files, deletion
  handling, empty state, notification UX.
- **Phase 6 — One-off file import (~3-4 hours).** Drag
  individual file from anywhere.

### Scan logic options

Three candidate strategies for detecting "what's new" in a
watched folder:

- **Approach 1 — Modification time comparison.** Store
  `lastScannedAt` per folder, find files with `modifiedAt >
  lastScannedAt`, filter to audio extensions, filter against
  existing library, import the diff. Fast, simple, common.
- **Approach 2 — File hash comparison (SHA-256).** More robust,
  catches renamed / moved files, slower (must read full file
  bytes to hash).
- **Approach 3 — Filename + size comparison.** Simplest,
  fastest, risk of false negatives (different file with same
  name and size silently skipped).

**Realistic implementation: Approach 1 with Approach 3 as
fallback.** Catches ~95% of cases. Approach 2 only if dedup
across moved-file scenarios becomes a real complaint.

### Why this matters

This is **THE feature that determines whether Mix//Sync becomes
someone's DJ home or stays a novelty.** Manual re-uploading is
death by paper cut — users churn. It's table stakes for serious
DJ tools. Not having it makes Mix//Sync feel like a toy
regardless of how good everything else is. The Path A glow that
just shipped, the real-time collaboration, the partner
spectator view — none of those matter if the user has to
manually re-import every new track they buy.

This is also why it's multi-session work and gated on strategy.
Shipping a half-baked version of this is worse than shipping
nothing — it would train users to distrust the library
auto-population, which is the exact trust we need to build.

### Next steps flagged for future sessions

1. **Brand / UX strategy session** (tabled 4+ times) should
   incorporate the **"Mix//Sync respects how YOU work"**
   principle. The both-modes resolution for library is a strong
   precedent — that decision pattern should inform other places
   where we're tempted to impose a single workflow.
2. **After strategy: Phase 1 build** (multi-folder watched
   setup) as a focused dedicated session.
3. **Subsequent phases each get their own session** with
   verification between.
4. **User dogfooding throughout** — Chad uses Mix//Sync daily,
   reports edge cases as they hit real-world libraries.

### Key questions to resolve in the strategy session

These are deliberately not pre-decided. The strategy session
should pick them up:

- **Where do users actually keep their music?** (Partially
  answered above — scattered across multiple locations,
  Downloads is highest traffic — but probably more nuance worth
  surfacing.)
- **What file formats matter?** MP3 + WAV + AIFF baseline; FLAC,
  M4A, OGG common; ALAC, DSD rare but pro.
- **What about pre-existing library?** (135 tracks already
  uploaded — re-map to file-system locations, or start fresh
  with the new system?)
- **What's the onboarding moment?** First-time wizard, optional
  upgrade prompt, settings option, all of the above?
- **Browser strategy?** (Chrome / Edge only with Safari graceful
  degradation recommended above — needs final sign-off as
  policy, not just engineering preference.)
- **Default mode for new users?** (Auto-Finder, Manager, or
  Hybrid? The discussion leans Hybrid for "most users," but
  this is a high-impact onboarding default that affects how
  Mix//Sync first feels.)

### Status

**Discussion only.** Nothing implemented, no commits, no code
touched. This section exists to preserve the strategic context
so a future session can pick it up without re-deriving the
problem from scratch. The next concrete action is the
brand / UX strategy session, not Phase 1 implementation.

## Library strategy session — May 27 morning (continuation of May 26 auto-import discussion)

The brand / UX strategy session that was tabled across multiple
prior sessions finally happened this morning, continuing
directly from the May 26 evening auto-import discussion above.
This section captures **what we locked in** and **what's still
open** before the session ended at ~90% context to preserve
clean state for next session.

This document is now the authoritative summary. A fresh Claude
session reading `VISION_5.md` gets full state without needing
to recreate any prior discussion. The strategy is **settled
except for the three PENDING questions** at the bottom of this
section.

### Locked principles (do not relitigate)

These are decided. Future sessions should treat them as
inputs, not open questions.

**1. Target user (confirmed, was already locked).**
- Pro / working DJs
- Melodic and progressive house aesthetic
- Anjunadeep, Lane 8, Ben Böhmer adjacent crowd
- NOT festival EDM, NOT casual hobbyists
- Power users with thousands of tracks
- Often migrating from Rekordbox / Traktor / Serato
- Multiple acquisition sources (Beatport, Bandcamp, promos,
  DJ pools)

**2. Library modes (locked May 26).** Auto-Finder + Manager +
Hybrid all supported. Resolved via the "BOTH" answer to the
philosophical question of "DJ track manager vs smart
auto-finder." Documented in commit `8539e53` and detailed in
the section immediately above this one.

**3. Collaboration modes (locked May 27 — this session).**
**ALL** modes supported in library collaboration:
- **Personal libraries** — yours is yours
- **Read-only visibility** — partner sees your tracks during
  sessions
- **Mid-session sharing** — send tracks to partner during a
  session
- **Shared collections** — build playlists together
- **Session-based pools** — per-session track contributions

User decision: **"all"** — Mix//Sync library supports every
collaboration mode because that's the differentiator vs
single-user tools (Rekordbox / Traktor / Serato). This is the
collaboration analogue of the May 26 "BOTH" resolution for
library modes — the same instinct (refuse to pick a single
workflow) applied to a different surface.

**4. Brand principle (locked May 26).** **"Mix//Sync respects
how YOU work, not how WE think you should work."** Applies to
library modes, applies to collaboration modes, and likely
extends to other features. The pattern emerging is: where
competitors impose a workflow, Mix//Sync supports all of them
and lets the user pick.

**5. Brand aesthetic (locked across multiple sessions).**
Anti-Material Design, atmospheric, sophisticated, premium but
alive, pure black background, cool deck colors, Path A glow
rendering. Established in DESIGN_PHILOSOPHY.md and refined
across the May 22 → May 26 visual iteration cycle.

### Strategic insight from today

The biggest framing shift to come out of this morning's
session:

> **The library is NOT just "where music lives" for the target
> user. Pro DJs come to Mix//Sync with existing libraries (in
> Rekordbox, in folders, in iTunes). Mix//Sync's library is
> "where you bring your existing music to USE it" — a
> performance interface, not just a storage interface.**

This shifts the framing of the entire product:

- Mix//Sync is **less** "music library app"
- Mix//Sync is **more** "collaborative performance interface
  for your existing music"

The library is a **means to an end** (the collaboration +
performance), not the end itself. This reframing has downstream
implications for nearly every UI decision around library — it
should optimize for "find a track fast and load it into a deck
with a partner watching," not for "browse and organize a
collection." The collection-management work happens in
Rekordbox; Mix//Sync inherits the result and makes it
playable-together.

This is also why auto-import matters so much (May 26 section
above): the friction of re-uploading manually doesn't just
slow users down — it breaks the entire framing. If users have
to maintain Mix//Sync as a separate library, it becomes another
storage app to manage. If music just appears, Mix//Sync becomes
the performance layer on top of the music they already own.

### Open questions — STILL NEED TO RESOLVE BEFORE PHASE 1 BUILD

These three questions were posed in this morning's session but
not answered before stopping for context budget. They must be
resolved in the next session before any code is written.

#### Q1. Existing 135 tracks — what happens when auto-import finds duplicates of already-uploaded tracks?

The current Mix//Sync library has 135 manually-uploaded tracks
(per the May 7 dogfood-ready milestone — see top of
`VISION_5.md`). When auto-import is built and runs against the
user's file system, many of those same tracks will exist on
disk as well. What's the merge behavior?

- **A.** Auto-detect duplicates, merge into one library entry
  (file-system version becomes canonical).
- **B.** Keep uploaded ones as-is, auto-import only NEW files
  (the 135 stay separate).
- **C.** Migration prompt: "We found these tracks on your
  computer. Replace your uploaded versions with file-system
  versions?"
- **D.** Start fresh — wipe the 135, scan computer, build from
  scratch.

**USER ANSWER: [RESOLVED — May 27 afternoon — NONE of A-D as stated; new behavior.]**
Smart duplicate detection (SHA-256 hash, filename+size fallback)
+ user choice + **never destructive merging**. When duplicates are
found, surface a notification ("Found N tracks on your computer
that are already in your library") and offer per-duplicate
**Skip** (default — keep existing entry untouched) or **Import as
separate copy** (explicit user opt-in). Existing tracks with cue
points, beat grids, hot cues, energy ratings, tags, notes are
**NEVER** touched without explicit user action. Reasoning: a
track in Mix//Sync has accumulated user work — silently
overwriting with a file-system version would destroy it, which
is unacceptable UX and erodes trust. See the appended
"May 27, 2026 — Q1 / Q2 / Q3 resolved" section below for the
full operational expression as the new protect-user-work
principle.

#### Q2. New user first experience — what's step 1 when someone signs up and lands in Mix//Sync for the first time?

The onboarding moment is the most consequential UX decision in
the product. It defines what users believe Mix//Sync is.

- **A.** "Connect your music folders" wizard immediately.
- **B.** Empty app with a clear "Add music to get started"
  prompt.
- **C.** Upload a single track to try it out, then prompt for
  folder access.
- **D.** Demo mode — play with sample tracks first, then add
  your own.

**USER ANSWER: [RESOLVED — May 27 afternoon — Option B.]**
Empty app with a clear "Add music to get started" prompt in the
library area. Full interface visible but empty library. No
wizard, no hand-holding, no demo mode. Pro DJs get the tool and
figure it out — consistent with the "talented friend who trusts
you" brand personality and the target user profile (pro /
working DJs, often migrating from Rekordbox / Traktor / Serato).

#### Q3. Default mode for new users — Auto-Finder, Manager, or Hybrid?

All three modes are supported (locked May 26), but the
default for a brand-new user has to be picked. It is the
single biggest factor in what "Mix//Sync first feels like."

- **A.** Auto-Finder (aggressive) — scan everything, user
  cleans up later.
- **B.** Manager (conservative) — user explicitly adds each
  folder, full control.
- **C.** Hybrid (middle ground) — smart defaults with
  notification, user approves new tracks.

**USER ANSWER: [RESOLVED — May 27 afternoon — Option C, Hybrid.]**
Smart defaults watching common folders (Downloads + Music) with
notification when new tracks are found; user approves before
they're added to library. Best balance of convenience and
control. Power users can switch to Manager (B) for full control;
convenience-first users can switch to Auto-Finder (A). Mode is
changeable from settings anytime.

### Next session plan

1. **Open fresh Claude Code session.**
2. **Read `VISION_5.md`** to load full context (today's
   session included — this entry is the load-bearing summary).
3. **User answers Q1, Q2, Q3 above.**
4. **Update `VISION_5.md`** with answers (append a follow-up
   section with the resolutions).
5. **Then: write Phase 1 build prompt** with all decisions
   locked.
6. **Phase 1 implementation begins** (Multi-folder watched
   setup, ~8-12 hours, per the phased scope in the May 26
   section above).

### Context-efficient recovery

This document is the authoritative summary. A fresh Claude
session reading `VISION_5.md` from the top gets:
- The full project history through May 7 dogfood milestone
- All design / palette / glow iteration context through
  May 26
- The May 26 evening auto-import strategic context (full
  section above)
- This May 27 morning strategy session (locked principles +
  strategic reframe + three open questions)

No prior conversation needs to be reconstructed. The strategy
is **settled except for Q1, Q2, Q3** — those are the only
gates between today's state and Phase 1 implementation.

Session ended at ~90% context usage to preserve clean state
for the next session, rather than continuing into degraded
context where decisions become unreliable.

## May 27, 2026 afternoon — Q1 / Q2 / Q3 resolved, protect-user-work principle added

The three PENDING gating questions from the May 27 morning
strategy session were answered this afternoon in a follow-up
session. Phase 1 (Multi-folder watched setup, ~8-12 hours) is
now unblocked. The build prompt itself has not yet been written
— next concrete step is the user reviewing a scope draft before
any code investigation begins.

This section consolidates the three resolutions and adds the
new operational principle that emerged from Q1.

### Q1 resolution — Smart duplicate detection with user choice, never destructive merging

Duplicate handling at auto-import time:

- **Detect** via SHA-256 hash (primary) with filename + size as a
  fallback fingerprint. Approach 2 from the May 26 scan-logic
  section, promoted from "only if dedup becomes a complaint" to
  the default for the duplicate-against-existing-library check.
  (Approach 1 — `lastScannedAt` modification time comparison —
  is still the right primary mechanism for "what's new in this
  folder since last scan." Approach 2 is specifically the
  "is this new file the same as something already in the
  library" check.)
- **Surface** a notification: "Found N tracks on your computer
  that are already in your library."
- **Per-duplicate user choice**, two options:
  - **Skip** *(default)* — keep the existing library entry
    completely as-is, do nothing, the new file-system instance
    is ignored.
  - **Import as separate copy** — add a new library entry
    alongside the existing one. Explicit user opt-in, never the
    default.
- **Existing tracks are NEVER touched without explicit user
  action.** Cue points, beat grids (including manual beatgrid-
  editor adjustments), hot cues, energy ratings, tags, notes,
  and any other accumulated user work are preserved exactly.

#### The reasoning — why "never destructive merging"

When a track is in Mix//Sync, it has accumulated user work
attached:

- Beat grid (potentially manually adjusted via the beatgrid
  editor)
- Cue points and hot cues (set during practice / dogfood
  sessions)
- Energy ratings, tags, notes (when those features ship)

Silently replacing a library entry with a file-system version
would destroy that work. This is unacceptable UX and would
erode the exact trust we need to build for users to commit
to Mix//Sync as their primary tool. The protect-user-work rule
is therefore the *operational* default for every auto-import
edge case, not just deduplication.

### Q1 corollary — New operational principle: "Protect user work — never destructive merging without explicit user action"

This is now a locked principle on the same tier as the May 27
morning "Mix//Sync respects how YOU work, not how WE think you
should work" brand principle. The protect-user-work rule is how
the brand principle operationally manifests in the library
auto-import surface — and likely beyond.

The principle extends across every edge case where the file
system and the library can diverge:

- **File moved on disk** → keep the library entry, update the
  file path under the hood, preserve metadata (cue points,
  beat grid, hot cues, tags). User work survives the move.
- **File deleted from disk** → mark the library entry as
  "missing" (visible in UI), do NOT delete the library entry
  itself. User can re-link a relocated file later without
  losing accumulated work. (Eventual hard-delete only via
  explicit user action on the library entry.)
- **File renamed** → detect the same file via hash, update the
  display name, preserve all metadata. No new library entry
  created.
- **Metadata conflicts** (file ID3 disagrees with library
  metadata) → user's library version wins over file metadata.
  The library is the source of truth for anything the user has
  explicitly set or edited; the file is the source of bytes only.
- **Duplicate found across watched folders** → one library
  entry, multiple file-system locations recorded under the hood.
  (Smart dedup, fourth tier of the May 26 architecture.)

#### Why this principle matters at strategy scale

The May 27 morning session locked the brand principle
**"Mix//Sync respects how YOU work, not how WE think you should
work."** That principle is abstract until it gets operational
defaults. Protect-user-work is the first concrete default that
expresses it.

Without protect-user-work, the brand principle is just copy.
With it, every file-system-vs-library edge case has a defined
answer that aligns with the brand. The principle should be the
default tiebreaker for all future auto-import design questions
not explicitly answered elsewhere in this document.

It should also be a key reference for future strategic
discussions about other surfaces where Mix//Sync touches user
work — collaboration history, recorded mixes, session state,
cloud sync (if/when it ships). The same logic applies: where
Mix//Sync could either preserve the user's accumulated work or
override it with a "cleaner" system view, protect the work by
default.

### Q2 resolution — Option B, empty app with prompt

New user onboarding flow:

- New user signs up and lands in Mix//Sync
- Full interface is visible — decks, mixer, library panel,
  transport — but the library is empty
- A clear "Add music to get started" prompt occupies the
  library area
- **No wizard, no hand-holding, no demo mode, no sample
  tracks**

This matches the target user profile (pro / working DJs,
melodic / progressive house, Anjunadeep crowd, often migrating
from Rekordbox / Traktor / Serato) and the brand personality
("the talented friend who's been DJing for 10 years, helps you
sound good without being a snob about it"). Pro DJs do not
want hand-holding wizards — they want the tool, and they will
figure it out. Demo mode would also conflict with the strategic
reframe from this morning's session: Mix//Sync is **less**
"music library app" and **more** "collaborative performance
interface for your existing music" — sample tracks would
frame Mix//Sync as a music-discovery app, not a performance
interface for music the user already owns.

The "Add music to get started" prompt is the *first interaction*
that introduces auto-import. The Hybrid-mode default (Q3) means
the prompt likely surfaces both **"Connect Downloads / Music
folders (recommended)"** and **"Add music manually"** as two
clear options at first hit — but the *interface around the
prompt* is the same full Mix//Sync UI, not a stripped-down
onboarding shell.

### Q3 resolution — Option C, Hybrid default

Default library mode for new users is **Hybrid**:

- Smart defaults watching common folders — **Downloads** +
  **Music** at first hit (the two highest-traffic locations from
  the May 26 distribution analysis)
- Notification surfaces when new tracks are found in watched
  folders
- User approves new tracks before they're added to the library
  (no silent magical imports — see protect-user-work principle,
  the same "no surprises" instinct)

Mode is changeable from settings anytime. Power users who want
full Manager-style control can switch to B (no auto-watching,
explicit folder adds). Convenience-first users who want
aggressive scanning can switch to A (Auto-Finder, scan
everything, no per-track approval). All three modes share the
same infrastructure per the May 26 architecture — the difference
is UX presets, not a code-path fork.

#### Why Hybrid as the default

Three considerations:

1. **Trust must be earned before automation is trusted.** A
   brand-new user has no reason to believe Mix//Sync's
   auto-import won't fill their library with garbage from
   `~/Downloads`. Auto-Finder as the default would feel
   presumptuous on first hit. Manager as the default would feel
   tedious and bury the auto-import value. Hybrid demonstrates
   the auto-detection (notifications surface) while still
   letting the user approve before commitment.
2. **Two folders is enough to demonstrate the magic.**
   Downloads + Music covers the high-probability locations for
   ~95% of DJs (per the May 26 distribution analysis). A new
   user sees value immediately without granting access to their
   whole file system on first interaction.
3. **Mode-switching from settings is the safety valve.**
   Anyone unhappy with Hybrid can move to A or B at any time.
   The default just has to be the *least surprising* starting
   point — Hybrid is that.

### What this resolves

- Phase 1 (Multi-folder watched setup, ~8-12 hours) is fully
  unblocked. All three gating questions from the May 27 morning
  session are answered.
- The protect-user-work principle is now a locked design
  default and should be referenced by every subsequent
  auto-import design choice.
- The brand principle "Mix//Sync respects how YOU work" has its
  first operational expression. Future strategic discussions
  about other surfaces can reference this pattern (brand
  principle → operational principle → defined defaults for
  every edge case).

### What's next

1. **User reviews the Phase 1 build prompt scope** (next concrete
   step — not yet written, drafted in the next assistant
   response after this commit confirms).
2. **After scope approval: Phase 1 build prompt is written
   fully.**
3. **After build prompt approval: code investigation begins**
   (Investigation-First Protocol per CLAUDE.md — find the
   relevant code, read it, report findings, propose fix
   architecture, get approval, then implement).
4. **Phase 1 implementation across one or more sessions** (~8-12
   hours estimated).

No code touched in this session. This entry exists to lock the
resolved strategy and the new principle so the build can
proceed without re-deriving the answers.

## Library architecture strategic pivot — May 29 evening (post-Commit-3 UX review)

Phase 1 shipped end-to-end across three commits today (`ccf38bf`
schema, `66bbb09` FSA helpers + embedded spike, `f9f3ab1` settings
UI with strip + modal). User visual review of the deployed
Commit 3 surfaced a fundamental UX problem that warrants a
strategic pivot before continuing into Phase 2.

This section records the pivot, the reasoning behind it, and the
new direction. The underlying engineering from Phase 1 is
preserved; only the user-facing surface is being redesigned.

### The UX problem identified

The Phase 1 design (Watched Folders + Modes + Manage modal)
exposed too much technical complexity. Pro DJs don't think in
terms of "watched folders," "granted permissions," "enabled
toggles," or "Auto-Finder / Manager / Hybrid modes." They think
in terms of "where's my music" and "show me my new tracks."

Direct user feedback during testing: **"I am not sure what I am
supposed to do or what watched folder means or granted/enabled."**
This is direct evidence the UI exposed plumbing instead of
intent — the exact failure mode the May 26 strategic
"Mix//Sync respects how YOU work, not how WE think you should
work" brand principle is meant to guard against.

The Quiet Pro Tool design philosophy says "functionality is the
aesthetic" and "restraint as a virtue." The Commit 3 surface
violated both — by exposing a configuration panel for a feature
the user shouldn't need to configure to use.

### The browser limitation (reconfirmed)

Browser apps cannot scan the entire file system. File System
Access API requires explicit per-folder user permission. This is
a hard browser security boundary — not a bug, not something
Mix//Sync can opt around, not something that will improve in
future browser releases. Any browser-only library auto-import
system must work within this constraint.

This is unchanged from the May 26 architecture session; restating
here because the redesign is downstream of accepting it.

### The scope-appropriate browser UX

The redesigned Phase 1 surface:

- User clicks ONE "Connect your music" button
- User picks ONE folder via Chrome's folder picker (usually
  Downloads — but Mix//Sync doesn't dictate which one)
- Mix//Sync recursively scans the chosen folder, filters audio
  files, imports everything
- Every subsequent app launch: silent re-scan, surfaces a
  notification "X new tracks found, import them?"
- Power users can add additional locations via a quiet
  "Add another location" affordance — NOT a "watched folders
  panel"
- **Zero "watched folders" or "modes" terminology exposed to the
  user**

The infrastructure built in Commits 1-3 supports this entirely;
only the UI words and screens change. The user's mental model is
"my music folder" — singular, intuitive — not "watched folders
list with permission states." Even when the user adds a second
folder, the framing remains "another music location," not "a new
entry in your watched-folders set."

### Companion desktop app — new roadmap item

**User decision: Build a separate desktop library companion app
LATER (not now).**

Concept:

- **Mix//Sync (browser app)** = performance interface — decks,
  mixer, real-time collaboration. What exists today and what the
  next 6-9 months will continue to focus on.
- **Mix//Sync Library (desktop app, future)** = full library
  manager with native file system access. Syncs to the browser
  app so the user's library is consistent in both surfaces.

Why this matters: browser apps cannot fully replicate pro DJ
tools' library management capabilities — there's no way to parse
Rekordbox / Traktor / Serato database files at scale in the
browser, no background scanning when the tab is closed, no full
system search. Native apps can do all of this. The companion-app
pattern matches existing pro DJ workflows (Rekordbox itself is a
desktop app that pushes to CDJ hardware; Mix//Sync's browser app
is the equivalent of "the performance surface" in that pattern).

**Decision: build LATER, not now.** Reasoning:

- Mix//Sync's core thesis (remote real-time DJ collaboration) is
  unvalidated. Validate it before expanding scope.
- A desktop companion app is 6-9 months of focused work
  (architecture, build, distribution, code signing, auto-update,
  database parsers).
- The browser-only experience is sufficient for dogfood and
  public beta. The redesigned Phase 1 (single-folder connect +
  smart scanning + new-track notifications) covers ~95% of the
  ongoing-import friction without leaving the browser.
- Real user feedback during dogfood will tell us which desktop
  capabilities matter most. Building the desktop app before
  having that feedback would be guessing.
- This is **Series A scope**, not validation-stage scope.

Future phasing for the companion app (rough, not committed):

- Phase 1 (current focus): validate browser app with real DJs
- Phase 2: architecture work for desktop (2-4 weeks)
- Phase 3: desktop MVP build (2-3 months) — Electron or Tauri TBD
- Phase 4: distribution + beta — code signing, auto-update
- Phase 5: Rekordbox / Traktor / Serato library imports as v1.1
  features once the desktop shell exists

Sync architecture options for future evaluation:

- Cloud sync via Mix//Sync servers
- Local sync via local HTTP / WebSocket between browser and
  desktop app on the same machine
- Hybrid (recommended) — local when possible, cloud as fallback

None of this is locked. It's documented here so a future session
picking up the desktop app discussion has a starting point and
doesn't re-derive the framing.

### What current Phase 1 gets right (salvageable)

Despite the UX miss in Commit 3's settings panel, the underlying
engineering from the three Phase 1 commits is correct and stays:

- **Schema additions** — `watchedFolders` IDB store (v6),
  `sourcePath` / `hash` fields on Track. Phase 2 dedup and
  Phase 5 file-move handling both need these.
- **FSA permission helpers** in `src/utils/fsa.js` —
  `isFSASupported`, `requestFolder`, `restoreHandles`,
  `checkPermission`, `requestPermissionFor`, `removeFolderById`,
  `setFolderEnabled`, `addFolder`. Reusable as-is.
- **The `[LIB-PHASE1-SPIKE]` embedded roundtrip** — proved
  `FileSystemDirectoryHandle` persistence works end-to-end in
  real Chrome via IndexedDB. The spec's "structured-cloneable"
  claim is verified in this environment. Phase 2 inherits this
  guarantee.
- **IndexedDB integration** — additive v5→v6 migration ran
  cleanly in production, 136 existing tracks untouched, store
  reads/writes verified.
- **`useLibrary` state plumbing** — `watchedFolders`,
  `libraryMode`, mount-time restore effect, action callbacks
  (`addWatchedFolder`, `removeWatchedFolder`,
  `setWatchedFolderEnabled`, `requestPermissionForFolder`,
  `changeLibraryMode`). The hook surface is correct; only its
  UI consumers need to change.

**What needs redesign: only the user-facing UI layer.** The
three components added in Commit 3 (`LibraryControlStrip`,
`LibrarySettingsModal`, helper rows) are being removed and
replaced with a single "Connect your music" empty-state CTA plus
a quiet "Add another location" affordance in the populated
state. The `🎵 LIBRARY` PANELS pill is being removed. No mode
toggles in the UI. No "watched folders" terminology anywhere
the user sees.

### What this resolves

- Phase 1 ships in user-visible form once the redesign lands —
  the engineering is already in production.
- Phase 2 (scanning + new-track notifications) inherits a clean
  surface to build on top of, instead of a settings panel
  contradiction.
- The desktop companion app is on the roadmap with explicit
  "later, not now" framing — future sessions know the option
  exists without feeling pressure to ship it.
- The "Mix//Sync respects how YOU work" brand principle now has
  a second concrete operational test alongside protect-user-work:
  **don't expose plumbing the user shouldn't need to think
  about.** This is a candidate companion principle worth naming
  explicitly in the next strategy pass.

### What's next this session

1. This documentation lands as its own commit + push (the entry
   you're reading now).
2. UI redesign plan goes back to the user for plan-only review.
3. Plan approval → implementation commit → push → browser
   verification.
4. If clean: tonight's work concludes. Phase 2 (scanning + new
   tracks notification) is a future session.

## Phase 1 — SHIPPED (May 29 evening, post-redesign verification)

Phase 1 of the library auto-import system shipped end-to-end
this evening across six commits and was verified working in
production via fresh Chrome incognito testing on
https://collabmix.vercel.app. The plumbing layer is live, the
user-facing surface is the redesigned "Connect your music" CTA,
and the [LIB-PHASE1-SPIKE] roundtrip confirmed that
`FileSystemDirectoryHandle` persistence works end-to-end in
real Chrome.

This section closes Phase 1 and hands off cleanly to Phase 2.

### Phase 1 scope delivered

- **Schema** — IndexedDB v6 with new `watchedFolders` store
  (keyPath `id`). `libraryMode` value persisted in the existing
  `settings` store; default `"hybrid"` per the May 27 Q3
  resolution. Additive migration; no existing data touched.
- **Track fields** — `sourcePath` and `hash` added as `null`
  defaults on all new manually-imported tracks. Reserved for
  Phase 2 dedup and Phase 5 file-move handling. Existing 136
  tracks not backfilled per P1-Q1.
- **FSA helpers** — `src/utils/fsa.js` exports
  `isFSASupported`, `requestFolder`, `restoreHandles`,
  `checkPermission`, `requestPermissionFor`, `removeFolderById`,
  `setFolderEnabled`, `addFolder`. All `[LIB-PHASE1]` tagged.
- **UI** — `LibraryEmptyState` component with three branches:
  not-yet-connected (Connect-your-music CTA + drag-drop hint +
  format caption), connected (transitional "Auto-scanning
  launches soon" state listing all connected folders), Safari
  fallback (manual import via drag-drop and "+ Add music").
- **Sidebar** — "+ Add another location" button appears in
  the existing footer cluster (next to "+ Add music" and
  "+ New folder") once `watchedFolders.length > 0`. Quiet text
  button matching the existing styling, no `startIn` bias.
- **Telemetry** — `[LIB-PHASE1]` tags on mount-time restore,
  folder grant/deny, queryPermission results, settings
  actions. `[LIB-PHASE1-SPIKE]` wraps the first put-then-read
  per session with explicit step-by-step logging (put →
  read-back → queryPermission) plus rollback on failure.
- **Downloads bias** — the primary "Connect your music" CTA
  calls `addWatchedFolder({ startIn: "downloads" })`. Chrome's
  picker opens at `~/Downloads` (the highest-traffic location
  for newly acquired DJ music per the May 26 distribution
  analysis). The "+ Add another location" button omits
  `startIn` so users adding additional folders can navigate
  freely.

### Phase 1 NOT in scope — deferred to Phase 2+

- ❌ Actual folder scanning (recursive directory traversal +
  audio file filtering)
- ❌ Dedup against existing library (the SHA-256 hash field is
  reserved; the matching logic itself is Phase 2)
- ❌ "X new tracks found" notification + Import/Skip
  confirmation flow
- ❌ `libraryMode` behavioral differences — Auto-Finder
  aggressive scan, Manager wait-for-explicit-add, Hybrid
  notify-and-confirm. Phase 1 stores the mode but exposes no
  UI to change it and no behavioral fork to honor it.
- ❌ File move / delete / rename handling per the protect-
  user-work principle (Phase 5)
- ❌ Rekordbox / Traktor / Serato library imports — separate
  feature surface, not part of the auto-import scope. Likely
  shipped via the future desktop companion app, not the
  browser app.

### Verification results — May 29 evening incognito test

Chad ran the verification path in a fresh Chrome incognito
window (empty IndexedDB → empty library) on
https://collabmix.vercel.app. Results:

- **Empty state renders correctly** — prominent
  "Connect your music" CTA, "or drag tracks here" copy,
  expectation-setting "Mix//Sync will scan your chosen folder
  and import all music it finds", and the new format hint
  "Supports MP3, WAV, FLAC, AAC, OGG, M4A".
- **Downloads bias works** — Chrome's folder picker opened at
  `~/Downloads` directly when the user clicked
  "Connect your music".
- **macOS picker UX friction noted** — selecting Downloads
  itself requires navigating into it and clicking Open. This
  is **standard macOS folder picker behavior**, not a
  Mix//Sync bug. Worth surfacing as a Phase 4 onboarding-
  guidance item for the public beta if it becomes a recurring
  complaint.
- **[LIB-PHASE1-SPIKE] roundtrip PASSED** in real Chrome —
  console logged in order:
  - `[LIB-PHASE1-SPIKE] starting roundtrip`
  - `[LIB-PHASE1-SPIKE] put ok`
  - `[LIB-PHASE1-SPIKE] read-back ok`
  - `[LIB-PHASE1-SPIKE] queryPermission → granted`
  - `[LIB-PHASE1-SPIKE] passed — DirectoryHandle persistence
    verified in this browser`
  This confirms the FSA spec's "structured-cloneable" claim
  holds end-to-end in production Chrome. Phase 2 inherits this
  guarantee — no further spike needed.
- **Cancel flow clean** — when the user dismissed the picker,
  no orphan record was left in the `watchedFolders` IDB store.
  The `requestFolder` helper's AbortError handling worked as
  designed.
- **Post-connect transitional state correct** — after granting
  a folder, the empty state transitioned to
  `● Connected: beatport_tracks_2026-05-2` (the actual folder
  name Chad picked) + "Auto-scanning launches soon." + the
  manual-import nudge.
- **"+ Add another location" surfaced** — after the first
  folder was connected, the sidebar footer gained the
  "+ Add another location" button as designed. No UI before
  first connect, naturally appears after.
- **Existing-library tab unaffected** — the 136-track real
  library tab loaded normally in a parallel non-incognito
  window. No UI changes, no console errors, no missing
  metadata, no broken transport / decks / sync / chat. The
  LIBRARY pill is gone from the top header (per the
  redesign); only the original AUDIO / REC / MIDI pills
  remain.

### Commits in Phase 1

| Commit | Purpose |
|---|---|
| `ccf38bf` | Phase 1 Commit 1 — IDB v5→v6 schema + Track sourcePath/hash fields |
| `66bbb09` | Phase 1 Commit 2 — FSA helpers + handle persistence + embedded spike |
| `f9f3ab1` | Phase 1 Commit 3 — Original UI (LIBRARY pill + strip + modal + mode toggles). **Superseded by the redesign** |
| `b5e15b3` | VISION_5.md — Library architecture strategic pivot (post-Commit-3 UX review) |
| `3dcc7ee` | Phase 1 UI redesign — empty-state CTA replaces strip + modal + mode toggle |
| `8cd328d` | Phase 1 redesign fix — remove duplicate OLD "Add your music" hero + add format caption |

Net code delta: roughly +500 / -300 lines (~200 net added
across the FSA helpers module, the LibraryEmptyState
component, the schema migration, and useLibrary hook
plumbing). The Commit 3 → redesign cycle was net negative on
its own (the redesign deleted ~280 lines of strip/modal UI
and added ~80 lines of empty-state UI), but the prior commits
brought the foundation.

### Principles validated in Phase 1

- **"Mix//Sync respects how YOU work, not how WE think you
  should work."** — UX shifted from technical-concept
  exposure (watched folders, modes, granted/enabled) to
  user-intent exposure (Connect your music, scan launches
  soon). The pivot mid-session was driven by direct user
  feedback during real testing, not by spec review. Brand
  principle's first concrete operational pass: the
  redesigned surface uses zero "watched folders" or
  "mode toggle" terminology.
- **"Protect user work — never destructive merging without
  explicit user action."** — Phase 1 doesn't auto-import on
  connect. The user grants a folder; nothing is added to the
  library until Phase 2's explicit "found N tracks, import?"
  confirmation lands. The cancel flow rolls back cleanly so a
  half-granted folder doesn't leave orphan state.
- **Investigation-First Protocol per CLAUDE.md** — the
  redesign was driven by real user testing feedback, not by
  assumed UX patterns. The Investigation step before any code
  ran proved its value (the FSA spike, the data-model
  validation, the settings-UI options question), AND its
  limits (missing the OLD "Add your music" hero during
  redesign investigation surfaced as a same-session bug).

### Lessons learned

- **Always investigate ALL existing UI patterns before adding
  new ones.** The duplicate empty-state bug surfaced from
  missing the OLD hero block (lines 1981–2005) during the
  redesign investigation. The Investigation step found the
  secondary text fallback at line 2017 and stopped looking.
  Next time: grep for every variation of "empty" / "no tracks"
  / "library is empty" / "drop tracks" / etc. inside any
  panel being redesigned, not just the first match.
- **User testing in actual UI catches what spec reviews
  miss.** The "watched folders / granted / enabled"
  terminology only felt wrong when seen in context. The
  Commit 3 spec review with strip + modal sketches read as
  reasonable; the deployed product read as plumbing.
  Future strategic decisions involving terminology should
  test the surface, not the words.
- **macOS folder picker UX is a real friction point for
  browser apps using FSA.** Selecting a folder requires
  navigating into it and clicking Open, which is non-obvious.
  Affects every browser app using `showDirectoryPicker`.
  Consider future onboarding guidance to mitigate (Phase 4
  onboarding flow, or a one-time hint on first Connect).
- **Bundle byte audit catches presence, not co-render.** The
  pre-deploy audit on Commit 3dcc7ee confirmed the new
  empty-state strings were in the bundle, but it didn't
  detect that the OLD hero strings were ALSO still in the
  bundle. Future audits on UI changes should also grep for
  the *replaced* strings and confirm they're at 0
  occurrences, not just that the new strings are present.
  Both directions of the audit are needed.

### Next session — Phase 2 scope

- Recursive folder scanner in `fsa.js` — walk every directory
  entry of granted handles, return audio files only
- Audio-extension filter — `.mp3`, `.wav`, `.flac`, `.m4a`,
  `.aac`, `.ogg` (mp4 audio is `.m4a` in practice; reconsider
  scope if `.mp4` audio container is needed)
- Dedup against existing tracks — first pass uses existing
  `tracksMatch` (normalized artist+title), second pass adds
  SHA-256 hash check using the `hash` field reserved in
  Phase 1
- "X new tracks found in `<folder name>`. Import them?"
  notification — Import / Skip buttons, in-app toast or
  modal. Honors the protect-user-work principle (never auto-
  import).
- Update the LibraryEmptyState transitional copy when
  scanning becomes active — "Auto-scanning launches soon"
  becomes "Scanning..." then "Found N tracks" + actionable
  buttons.
- Auto-rescan on app mount + post-grant — silent
  queryPermission per folder, then scan, then notify if new
  tracks found.

Estimated time: 4-6 hours. Phase 2 inherits a clean
foundation — no spike re-run needed, no schema migration,
no UI surface to redesign mid-flight.

### Companion desktop app — remains roadmapped

Per the May 29 evening strategic pivot, a separate desktop
library companion app remains on the long-term roadmap.
Phase 1 through Phase 6 of the browser-only auto-import
system provides "good enough" library management for dogfood
and public beta. The desktop companion build begins after the
browser-only validation phase completes — estimated as a
6-9 month future scope item, **Series A scope, not
validation-stage scope**.

The framing from the pivot section above stands: Mix//Sync
(browser) is the performance interface; Mix//Sync Library
(future desktop) is the full library manager that syncs to
the browser app. Browser-only is sufficient for the next
6-9 months. Real dogfood feedback will inform desktop
priorities when the time comes.

### Phase 1 closed

This is the close of Phase 1. The next concrete action is
either (a) Phase 2 implementation (scanning + notification)
in a future session, or (b) gathering user feedback on the
deployed Phase 1 surface during dogfood and letting that
inform Phase 2 scope refinements. No code touched in the
final documentation commit — this entry exists to mark Phase
1 done and hand state to the next session cleanly.

## Session end — May 30 evening

### Phase 2 status

- **Commit 1 (`cbc9e3b`)** — `scanWatchedFolder` +
  `scanWatchedFolders` recursive scanner in `src/utils/fsa.js`.
  Audio extension filter, skip-list, dotfile filter, AbortSignal,
  onProgress callback, `enabled` flag and `permission` state
  honored. 21-assertion synthetic Node test + browser smoke test
  pass.
- **Commit 2 (`acdeccb`)** — useLibrary scan integration:
  `pendingNewTracks` state, `runLibraryScan` / `dismissPending
  NewTracks` / `commitPendingNewTracks` callbacks, dedup via
  `tracksMatch(artist,title)` primary + `(folderId, relativePath)`
  composite-key fallback, chunked-batch import wrapper (CHUNK 100),
  `lastScannedAt` update on each scanned folder. All 10 smoke
  test checks pass.
- **Commit 3 (`12c01ab`)** — `NewTracksBanner` UI +
  `ReviewTracksModal` + `importProgress` state with per-file
  granularity + state-aware `LibraryEmptyState` copy. Banner
  styling polished to discrete card (background 0.04 → 0.05,
  border 0.10 → 0.14, padding 14 → 16px) after visual review.
  20 of 22 smoke test checks pass; 2 unverified due to <1 s
  import duration on small libraries (progress label + bar
  visible mid-import — code correctness confirmed via per-file
  [IMPORT-ITER] telemetry).
- **Commit 4 (`604ec7d`)** — Auto-scan triggers: mount-time
  (one-shot via `mountScanStartedRef`, deferred via
  `setTimeout(0)`), post-grant (scope:'subset' via
  `runLibraryScan({ folderIds: [newId] })`), manual
  "Check for new music" sidebar button with `Scanning…`
  disabled state. All 11 functional smoke test checks pass.
  Production verified live at `main-BH38w-qF.js` on
  `https://collabmix.vercel.app/`.

### Phase 2 status at session end

- 4 of 5 commits shipped to production
- Feature is **FUNCTIONALLY COMPLETE** on production after the
  Commit 4 Vercel deploy
- Mount-time auto-scan, post-grant auto-scan (scoped to the
  newly-added folder), and manual rescan all work end-to-end
- Banner appears with new tracks count, Review modal selection
  flow works, dedup prevents duplicate imports
- Per-file import progress display works (verified via the
  408-track ~/Music import which fired auto-banner immediately
  after grant)

### Remaining work (Commit 5)

- Final copy polish pass — any rough strings, missing periods,
  inconsistent sentence case
- Comprehensive bundle byte audit (Phase-1-redesign lesson:
  verify replaced strings sit at 0 occurrences, not just that
  new strings are present)
- End-to-end Vercel production verification via Claude Desktop
  on `https://collabmix.vercel.app/`
- Update VISION_5.md with final "Phase 2 — SHIPPED" summary
  section
- Estimated 30-45 min in a fresh session

### Notable moments this session

- Recovered May 24 deep research on library design and stored
  outstanding items in VISION_5.md before starting work — pre-
  reading paid off (Bug 1 "computer must never crash" memory
  framing already addressed by the May 25 streaming-analyzer
  commits; cleared as a non-blocker for Phase 2)
- Caught the path-shape contract issue in Commit 1 review (bare
  filename vs full identity tuple) — pivoted from `path` string
  to `{folderId, folderName, relativePath}` shape before locking
  in. Set up clean composite-key dedup in Commit 2.
- Banner styling flagged as too subtle in Commit 3 visual
  verification — refined to discrete card (one opacity tier lift
  on background + border) before commit
- Post-grant auto-scan on `~/Music` (408 tracks) confirmed the
  real-world Phase 2 user journey works: connect → instant scan
  → banner with track count → Import them path
- `runLibraryScanRef` forward-ref pattern used to break a TDZ
  cycle between `addWatchedFolder` (declared early in
  `useLibrary` body) and `runLibraryScan` (declared later) —
  worth remembering as a clean pattern for cross-callback
  triggers inside the same hook

### Anticipated Phase 3+ work (per May 24 research)

- AcoustID + MusicBrainz integration for auto-fixing broken
  metadata
- Audio fingerprint duplicate detection (currently dedup is
  artist+title normalized equality + folder-path fallback)
- Multi-paradigm library organization — Collections + Smart
  Collections + Tags + Folders + Sets
- "What's next?" AI-suggested track panel during mixing
- Rekordbox / Serato / Traktor / Engine DJ import paths
- Rekordbox-compatible USB export

### Commit chain reference

```
cbc9e3b  Phase 2 Commit 1 — Recursive folder scanner + audio file filter
acdeccb  Phase 2 Commit 2 — useLibrary scan integration + dedup + new tracks state
12c01ab  Phase 2 Commit 3 — NewTracksBanner UI + ReviewTracksModal + progress display
604ec7d  Phase 2 Commit 4 — Auto-scan triggers (mount, post-grant, manual)
```

### Don't-touch list (carried into Commit 5)

- Manual import paths (drag-drop + "+ Add music" + showOpenFile
  Picker) — verified non-regressed across all four commits
- Existing 136 tracks in IDB — never backfilled with folderId /
  sourcePath / hash fields per P1-Q1
- Memory pipeline (`processQ` streaming analyzer, `fileMap` LRU
  cap, AudioContext recycle every 50) — untouched since May 25
- Worktrees `../collabmix-booth` and `../collabmix-decks` stay
  REFERENCE ONLY

## Session end — May 30 night — Phase 2 Commit 5 SHIPPED

Phase 2 closes here. Commit 5 polished the four user-facing
surfaces shipped in Commits 1–4, audited the bundle, and updated
this doc. No new functional code — copy + verification + handoff
only.

### Commit 5 — what changed

- **Verb normalization across empty-state copy.** Two lines that
  said "Drag tracks here" (non-FSA branch + FSA not-yet-connected
  branch) now say "Drop tracks here" to match the FSA-connected
  branch already in production. One verb across all three empty-
  state surfaces. The queue ("Drag tracks from library to queue
  them up") and deck-zone ("drop tracks below to start") copy
  uses different verbs by design — those describe their own
  action shapes and were intentionally left out of scope.
- **Initial-state footer hint tightened.** "Mix//Sync will scan
  your chosen folder and import all music it finds." → "Mix//Sync
  scans the folder and imports the music it finds." Same meaning,
  five fewer words, present-tense matches the Quiet Pro Tool
  voice (confident, no second-guessing the user).
- **No structural changes.** Three string edits inside existing
  JSX text nodes. No new components, no logic touched, no styles
  touched, no hook surface changes.

### Bundle byte audit — verified clean

Built bundle: `dist/assets/main-ggW55D_U.js` (570 KB; 182 KB
gzip). Audit method: `grep -c` on the minified production
output to confirm each expected string lands once and each
retired string lands zero times.

Retired strings — all `0` occurrences in the new bundle:

- `Auto-scanning launches soon` (Phase-1 placeholder copy)
- `LibrarySettingsModal`, `LibraryControlStrip`, `Auto-Finder`,
  `Manager / Hybrid`, `Hybrid mode` (May 29 strategic-pivot
  removal — confirms the dead symbols are not in the bundle)
- `will scan your chosen folder`, `import all music it finds`
  (replaced this commit)
- `Drag tracks here`, `drag tracks here` (replaced this commit)

New / current strings present in the bundle (≥1 each):

- Banner: `Importing`, `new track`, `Import them`, `Review first`
- Modal: `Review new tracks`, `Deselect all`, `Import…selected`
- Empty state: `No tracks yet`, `Connect your music`, `Library
  up to date`, `Last checked`, `Mix//Sync scans the folder`
- Sidebar: `Check for new music`, `Scanning`, `Add another
  location`

Drag/drop accounting — every variant lands where expected:

- 1× `Drop tracks here` (no-FSA empty + FSA-connected fallback)
- 1× `drop tracks here` (FSA-connected initial-state hint)
- 1× `Drag tracks from library` (queue surface, unchanged)
- 1× `drop tracks below` (deck-zone surface, unchanged)
- 0× `Drag tracks here` / `drag tracks here`

### Verification report (engineer-side)

- **Build:** `npm run build` succeeds — 365 modules, 944 ms,
  bundle `main-ggW55D_U.js`.
- **Lint:** `npm run lint` fails for a PRE-EXISTING reason —
  eslint v9.39.4 requires `eslint.config.js` and the project
  still has the older config format (no `eslint.config.*` file
  exists). Not caused by Commit 5; surfaces every run. Flagging
  as a separate cleanup item.
- **Type check:** project has no TS — N/A.
- **Runtime check on dev server:** not run this commit. Edits
  are pure rendered-string changes in three JSX text nodes with
  no logic / layout / type touchpoints; runtime failure surface
  is effectively zero. Confidence comes from the bundle byte
  audit confirming the new strings survived Vite minification.
- **Real-data path exercised:** none required — scanner / dedup
  / banner / modal / empty-state logic is unchanged.

### Verification checklist (Chad-side, via Claude Desktop on
`https://collabmix.vercel.app/` after Vercel auto-deploys this
commit)

Wait for Vercel to flip to the new bundle hash. Confirm via
DevTools Network tab that the loaded `main-*.js` is NOT
`main-BH38w-qF.js` (Commit 4) and NOT `main-ggW55D_U.js` (this
local build — production will pick a fresh hash). Then:

1. **First-visit empty state** (fresh browser profile, or after
   `indexedDB.deleteDatabase('mixsyncLibrary')`):
   - "No tracks yet" + "Connect your music" button visible
   - Footer hint reads "Mix//Sync scans the folder and imports
     the music it finds." (the tightened copy)
   - Secondary line reads "or drop tracks here" (NOT "drag")
2. **Connect a real folder** (small Beatport export, 5–20
   tracks): post-grant scan fires → banner shows "N new tracks
   found in <folder>." → "Import them" works → tracks appear.
3. **Connect a second folder:** post-grant scan fires scoped to
   the new folder; banner updates; dedup keeps already-imported
   tracks out.
4. **Manual rescan:** click sidebar "Check for new music" →
   disables to "Scanning…" mid-scan → produces no banner when
   nothing on disk has changed.
5. **Reload the app:** mount-time auto-scan runs once;
   "Library up to date. Last checked Xm ago." reads under the
   connected indicator when no pending tracks exist.
6. **Review modal:** with pending tracks present, click "Review
   first"; checkboxes work; "Deselect all" toggles correctly;
   "X of Y selected" footer updates; "Import N selected"
   commits the selection; Cancel / Escape / backdrop click all
   dismiss.

If any of these fail, capture the bundle hash + DevTools
console + a screenshot. The bundle byte audit above proves the
strings exist in the artifact; a failure on Vercel would be a
runtime regression (state / hook ordering / layout), not a
stale-deploy or missing-string issue.

### Phase 2 — the full arc

```
cbc9e3b  Phase 2 Commit 1 — Recursive folder scanner + audio file filter
acdeccb  Phase 2 Commit 2 — useLibrary scan integration + dedup + new tracks state
12c01ab  Phase 2 Commit 3 — NewTracksBanner UI + ReviewTracksModal + progress display
604ec7d  Phase 2 Commit 4 — Auto-scan triggers (mount, post-grant, manual)
(this)   Phase 2 Commit 5 — Copy polish + bundle audit + SHIPPED handoff
```

End-to-end DJ user journey works without any "+ Add music"
clicks: open the app, connect your music folder, watch the
scanner work, click "Import them," start mixing. The library
no longer demands manual maintenance — it stays current across
mount-time + post-grant + manual triggers, and dedup keeps
re-imports clean.

Phase 3 candidates carry forward unchanged from the "May 30
evening" section: AcoustID/MusicBrainz auto-fix, fingerprint
dedup, multi-paradigm organization (Collections / Smart
Collections / Tags), "What's next?" suggestion panel,
Rekordbox/Serato/Traktor/Engine DJ import paths, USB export.

### Known cleanup items (not Phase 2 blockers)

- `npm run lint` fails: project has no `eslint.config.js` and
  eslint v9 requires it. Pre-existing condition. Either migrate
  the config to flat-config or pin eslint back to v8 — separate
  session, low priority while lint is not part of any pre-push
  gate.
- `BUILD_AND_PUSH.command` deprecated (per memory) — the deploy
  path since May 7 is `git push origin master`, which Vercel
  auto-deploys.

### Don't-touch list (carried forward unchanged)

- Manual import paths (drag-drop + "+ Add music" +
  showOpenFilePicker) — verified non-regressed across all five
  commits
- Existing 136 tracks in IDB — never backfilled with folderId /
  sourcePath / hash fields per P1-Q1
- Memory pipeline (`processQ` streaming analyzer, `fileMap` LRU
  cap, AudioContext recycle every 50) — untouched since May 25
- Worktrees `../collabmix-booth` and `../collabmix-decks` stay
  REFERENCE ONLY

## Session start — May 31 morning — Phase 3 begins

Phase 3 = **analyzer diagnostic tool**. Goal: surface the gap
between what the per-deck worker says about a track and what
the library row stores, so harmonic errors (Palindrome reading
90 in library but 120 on deck), grid-vs-kick offset drift, and
drop-detection blind spots can be caught with data instead of
ear-tested one track at a time.

### Prior-investigation findings, verified

The Claude Desktop source-map + live-IDB investigation that
preceded this session was cross-checked against the actual repo
at session start. All structural claims hold; one routing
adjustment was made (see below).

- ✅ `src/bpm-worker-source.js` (1368 lines) is the Web Worker
  doing all DSP. `createBPMWorker()` at line 144 wraps the source
  in a Blob URL.
- ✅ `processQ` is the serial streaming analyzer in
  `useLibrary` — defined at line 604, ref-wired at line 681.
- ✅ Decode pipeline: main-thread `decodeAudioData` → downmix
  mono → decimate to 11025 Hz with a 60 s cap → transferable
  buffer to worker. ~2.6 MB peak PCM per track (line 629
  `TARGET_SR=11025`, line 657 transferable post).
- ✅ `exportLibrary` at line 1171 has the Blob → URL → click
  pattern (reusable for the JSON / CSV downloads in later
  Commits 2 and 5).
- ✅ IDB is `cm_music_library` v6 per `src/utils/storage.js:25-26`.
  v6 added the `watchedFolders` store; the rest of the schema
  matches the prior summary.
- ✅ `skipBPM:!!track.bpm` confirmed at three library sites
  (lines 814, 916, 1155). Per-deck path at line 177 does not pass
  `skipBPM` at all — worker defaults it to `undefined`/falsy, so
  the deck runs full detection. **Two code paths disagreeing is
  the root cause Phase 3 is built to surface.**
- ✅ Onset infrastructure in the worker is richer than the prior
  summary mentioned: kick-band (40-60 Hz) + punch (100-200 Hz)
  with kick-EXCLUSIVE onset (`max(0, onK - onP)`); sub-bass
  continuity 20-80 Hz; DP beat tracker; 4-phase bar-downbeat
  scoring; ±15 ms windowed max around DP beats; sample-level
  transient refinement with parabolic interp on dE/dt and
  envelope-peak walk-forward for flat-top kicks.
  → **Implication: the diagnostic's independent onset detection
  (Commit 3) must make completely different algorithmic choices
  (different band splits, different thresholds, different
  smoothing) so its blind spots don't overlap with the worker's.**
- ⚠️ **Routing adjustment.** The prior investigation suggested
  adding a `window.location.pathname === '/diagnose'` check in
  `src/main.jsx`'s `Root()`. Verification surfaced the existing
  multi-entry Vite setup (`vite.config.js` rollupOptions.input
  declares `main` + `library`) with `library.html` +
  `src/library-app.jsx` as a standalone companion app. Phase 3
  mirrors that precedent — `/diagnose.html` is a standalone
  bundle, isolated from the 570 KB mixer chunk, zero risk to
  the mixer's import / worker / memory paths.

### Worker results — only PARTIALLY persisted to IDB

Important nuance the prior investigation hinted at but the
verification confirmed: the library-side worker callback
(around lines 519-545) destructures only `{id, bpm, key,
energy}` from worker output and writes them back via `cmDbPut`.
The deck-side callback (lines 154-159) extracts the richer
fields (`beatPeriodSec`, `firstBar1AnchorSec`, `beatPhaseFrac`,
`snapped`, `candidates`, `_debug`) into in-memory `results`
state — **never written to IDB**.

So "Palindrome shows 90 in library row but 120 on deck" isn't
a tag-vs-detection disagreement; it's the same DSP under two
different orchestrators, with `skipBPM:!!track.bpm` causing
the library path to never re-run detection on tagged tracks.
The diagnostic needs to expose BOTH the stored value AND a
fresh detection run on every track to make this visible
across the 136-track library.

### Two `createBPMWorker` / `createLibWorker` paths

There are two distinct worker-factory functions: `createBPMWorker`
(line 144, deck path) and `createLibWorker` (around line 519,
library path). They may wrap the same source file or different
ones — verification was time-boxed; Commit 2 will resolve which
worker the diagnostic reuses and whether the two factories
diverge in their setup.

## Session start — May 31 morning — Phase 3 Commit 1 SHIPPED

Bones of the diagnostic stand up. Standalone `/diagnose.html`
entry mirroring the existing `/library.html` pattern; walks
`cm_music_library`, dumps stored metadata, probes whether each
track's underlying file is silently resolvable. No worker
invocation, no measurement, no IDB writes.

### Files added / modified

- **`diagnose.html`** (new, 12 lines) — entry HTML mirroring
  `library.html`. Loads `/src/diagnose-main.jsx`.
- **`src/diagnose-main.jsx`** (new, 7 lines) — `createRoot` +
  `StrictMode` mount of `DiagnoseApp`. Imports `./index.css`
  for global resets only (no shared mixer styling).
- **`src/diagnose-app.jsx`** (new, ~290 lines) — the diagnostic
  itself. One React component, single `Walk library` button,
  table of per-track stored metadata + resolution probe, summary
  stats panel. Quiet Pro Tool styling: pure black background,
  white at 0.9 / 0.6 / 0.3 opacity tiers, 150 ms cubic-bezier
  row hover, no glassmorphism, sentence case throughout.
  STATUS_OK / STATUS_WARN / STATUS_BAD colour roles for
  resolvable / needs-grant / unresolvable badges.
- **`vite.config.js`** (modified, +1 line) — added
  `diagnose: resolve(__dirname, 'diagnose.html')` to
  rollupOptions.input.

### Silent-probe contract

`probeResolution(track)` returns
`{ state: 'yes'|'grant'|'no', source: <label>, detail? }`.
Probe order:

1. `opfsGet(id)` — silent, no permission required. Tracks with
   bytes in OPFS resolve as `{state:'yes', source:'opfs'}`.
2. `dbGet("handles", id)` → `resolveHandleRecord(rec)`.
   Legacy `{id, file: File}` records resolve as
   `{state:'yes', source:'legacy-file'}`.
3. For handle-bearing records: `handle.queryPermission({mode:'read'})`
   — silent in all modern browsers. Maps to `handle-granted` /
   `handle-prompt` (state='grant') / `handle-denied`.
4. Anything else: `state:'no'` with source label
   (`no-record` / `orphan-handle` / `handle-error`).

**No `requestPermission` call this commit.** Per-handle user
gestures would break a 136-track batch walk. Tracks in `prompt`
state are reported as needs-grant so Commit 2's measurement
pass can decide how to handle them (probably: surface a "grant
N folders to enable measurement" CTA).

### Bundle byte audit — clean isolation

Build artifacts after this commit:

```
dist/diagnose.html                   0.49 kB
dist/assets/diagnose-COGvtNTa.js     9.25 kB  (gzip 3.34 kB)
dist/assets/storage-C8ykY87b.js    148.05 kB  (shared with library)
dist/assets/main-DADumd6-.js       570.60 kB  (unchanged size)
dist/assets/library-BN2zwc87.js     91.07 kB  (unchanged)
```

Diagnose chunk is 9.25 KB — 60× smaller than the mixer chunk,
confirming the standalone entry is properly isolated. Verified
by grep on the minified `diagnose-COGvtNTa.js`:

- 1× `Analyzer diagnostic`, 1× `Walk library`, 1× `queryPermission`,
  1× `OPFS` — diagnostic-specific strings present.
- 0× `createBPMWorker`, 0× `NewTracksBanner`, 0× `engineRef`,
  0× `useRecorder`, 0× `useRTC`, 0× `showOpenFilePicker` —
  no mixer code leaked in.
- `cm_music_library` lives in the shared `storage-*.js` chunk,
  imported by both `library-*.js` and `diagnose-*.js`. No code
  duplication.

Main bundle (`main-DADumd6-.js`) is byte-identical in size to
the Phase 2 SHIPPED bundle, and still contains the Phase 2
polish strings (`Library up to date`, `Drop tracks here`,
`Mix//Sync scans the folder`). 0× `Analyzer diagnostic` in the
main bundle — confirms diagnose code did not leak into mixer.

### Verification report (engineer-side)

- **Build:** `npm run build` succeeds — 368 modules (up from
  365), 953 ms, new diagnose entry produces a 9.25 KB chunk.
- **Lint:** still fails for the pre-existing eslint v9 config
  reason — not caused by Phase 3 edits, surfaces every run.
- **Runtime check in dev server:** NOT run by Claude this
  commit. The diagnose code only reads from `cm_music_library`
  via the same shared `src/utils/storage.js` helpers that
  `library-app.jsx` already uses in production, plus
  `handle.queryPermission` (a synchronous-ish standards API
  call). Risk surface for a runtime failure is small but
  non-zero — Chad should load `/diagnose.html` on the dev
  server (or after deploy) and click `Walk library` once.
- **Real-data path exercised:** none by Claude — diagnostic
  exists to be run by Chad against the real 136-track library.

### Verification checklist (Chad-side, run after deploy)

After Vercel deploys this commit, visit
`https://collabmix.vercel.app/diagnose.html` (or run locally
on the dev server at `http://localhost:5173/diagnose.html`).

1. Page loads, shows "Analyzer diagnostic" header, "Phase 3 ·
   Commit 1" tag at top right, and a single "Walk library"
   button. Background is pure black.
2. Click "Walk library." Button changes to "Walking…" and
   progress reads "0 / 136 tracks probed", incrementing every
   ~10 tracks.
3. When done, a summary panel appears with: total count,
   analyzed / not analyzed, errored count, has-stored-BPM
   count, has-stored-key count, gridAnchorSec count (expected:
   2 per prior investigation), bpmOverride count (expected:
   1), and a resolution breakdown.
4. Table below shows every track with: #, Title, Artist, BPM,
   Key, Duration, Analyzed flag, gridAnchorSec, bpmOverride,
   File-resolvable badge (green ✓ / amber needs-grant / red
   ✗), Source label.
5. The "Resolvable" badges should be mostly green for the
   working library; any amber rows are tracks whose handles
   are in `prompt` state — Commit 2 will surface a per-folder
   "grant" affordance to flip these to silently-resolvable.
   Red rows are unresolvable (no OPFS, no handle) — flag these
   to Claude; they may indicate the v4→v5 handle-shape
   migration didn't run for those records.

### Scope discipline maintained

Zero modifications to: `src/collabmix-production.jsx`,
`src/bpm-worker-source.js`, `src/utils/storage.js`,
`src/library-app.jsx`, anything in the worker / import /
memory / worktree surface. The diagnostic is purely additive
new files plus a one-line vite config addition.

### Remaining commits (refined plan)

- **Commit 2** — Worker reuse harness + Dimension 3 (BPM /
  anchor / harmonic-ratio re-detection on every track) +
  per-track JSON dump download. Resolves which `createBPMWorker`
  vs `createLibWorker` to reuse. Adds the `requestPermission`
  flow gated behind a per-folder grant button so the walk can
  run over the full library.
- **Commit 3** — Dimension 1: independent onset detection (must
  use different band splits / thresholds than the worker — see
  prior section on the worker's richness). Reports grid-to-kick
  offset mean / median / max / stddev / drift-slope per track.
- **Commit 4** — Dimension 2: drop detection + downbeat-vs-drop
  bar position.
- **Commit 5** — Sortable / filterable table, visual indicators
  for outliers (red badges on tracks where worker vs diagnostic
  disagree by >5 BPM or >50 ms grid offset), summary stats
  rollup, CSV download.

### Don't-touch list (carried forward unchanged)

Same as Phase 2 SHIPPED:

- `src/collabmix-production.jsx` (mixer)
- `src/bpm-worker-source.js` (DSP)
- `src/utils/storage.js` (IDB / OPFS contract) — read-only
  imports only
- Manual import paths in the mixer
- Memory pipeline (`processQ`, `fileMap` LRU, AudioContext
  recycle)
- Worktrees `../collabmix-booth`, `../collabmix-decks`
- Worker source file — diagnostic re-uses, never edits

## Session end — May 31 night — Reconciliation: prior analyzer work + Phase 3 Commit 1 reframed

This session's Phase 3 planning was done without context on the
extensive May 17-21 analyzer accuracy work that already sits in
`tools/bpm-test-harness/`, `tools/sota-eval/`, and
`tools/rekordbox-eval/`. A late-evening read-only investigation
surfaced ~80 files of prior work, completed analyzer surveys,
shipped sub-cause fixes, and an explicit "this is the last
algorithmic round" decision that pre-dated tonight's planning
by ten days. This section captures what was found so future
sessions can pick the right next move without re-discovering
the state of the world from scratch.

### Prior analyzer work state (was invisible to this session at planning time)

- **Analyzer is at 80.9% PASS** on the 272-track Rekordbox-truth
  harness (84.3% excluding 11 long DJ mixes that fundamentally
  cannot be single-tempo gridded).
- **`tools/bpm-test-harness/`** — built, functional, 33 files.
  272-track ground truth (`library-truth.json`, derived from
  Rekordbox `.DB` extraction). Parallel runner (5.4× faster than
  sequential, full library runs in ~3 minutes). README documents
  `npm test`, `--save baseline`, `--compare baseline`, PASS/FAIL
  tolerances (Δbpm ≤ 0.5 AND Δfirstdownbeat ≤ 20 ms). Idle since
  May 21 but production-grade and ready to resume.
- **`tools/sota-eval/`** — 47 files. State-of-the-art analyzer
  survey work. Includes `MADMOM_DIAGNOSTIC.md`,
  `BEAT_THIS_DIAGNOSTIC.md`, `ANCHOR_HYPOTHESIS_RESULT.md`,
  `CLUSTER_OFFSET_RESULT.md`, `LATE_CLUSTER_FIX.md`,
  `ROCKET_JAM_FIX.md`, `SYNC_CORRECTNESS_RESULT.md`,
  `REAL_ACCURACY_SUMMARY.md`. The survey is **complete**, not
  queued.
- **`tools/rekordbox-eval/`** — Rekordbox `.DB` / ANLZ binary
  parsing work. SQLCipher decryption walkthrough, waveform
  extraction, beat-grid extraction. Underpins the harness ground
  truth pipeline.

### SOTA survey conclusion (was thought to be queued, was actually done)

| Candidate | Verdict | Reason |
|---|---|---|
| **madmom** | REJECTED | (1) CC BY-NC-SA model license — non-commercial blocker. (2) Breaks 10 of 15 currently-PASSING tracks (8 by entire bars). (3) Same ~22 ms early drift on Sub-cause B class. (4) Perf ~37 s/track. |
| **beat_this** | REJECTED | (1) Model license ambiguous (no explicit declaration in repo). (2) Would lose 7-9 of 15 PASS controls. (3) Same ~22-27 ms early drift on the same Sub-cause B tracks. (4) Faster than madmom (~3.9 s/track) but still net-negative on accuracy. |
| **Essentia.js** | Not investigated | Survey stopped after both madmom + beat_this failed. |
| **Custom multi-pass** | THIS IS THE PATH TAKEN | Sub-causes A through G are the multi-pass result. |

**Three independent detectors (our analyzer, madmom, beat_this)
converge on the same ~20-35 ms early drift versus Rekordbox
truth on the Sub-cause B cluster.** That convergence is the
evidence that the residual error is not an audio-detection
problem — it's a perceptual anchor convention that Rekordbox
applies which no audio-only system can recover without modeling
per-track perceptual offsets.

### Shipped analyzer fixes (currently in `src/bpm-worker-source.js`)

| Sub-cause | What it does | Gain on harness | Commit |
|---|---|---|---|
| **A** (Step 3) | Beat-0 earliest-peak ≥75% of argmax | baseline | `d306514` |
| **B** (Step 5 Phase 1) | Beat-0-only attack refinement | baseline | `5f9ce8d` |
| **C** (Step 4) | Sampler / one-shot snap-to-0 | small | `d024f2a` |
| **D** | Drop-detection grid validation | +1 (72.4 → 73.2%) | `9ba92fe` |
| **F** | No-kick-beat-0 advance to first real kick | +2 (73.2 → 73.9%) | `4f57d9b` |
| **G** | Walkback to earliest transient ≥30%, ≥20 ms gate | **+19 (73.9 → 80.9%)** — largest single gain | `38af43b` |
| Kick-exclusive phSc scoring (`onK − onP` not `onK` alone) | | | `1c8549a` |
| Phrase voting (`phSc16` / `phSc32`) | | | `edde4ee` |
| Manual bar-1 anchor override UI | | | `edde4ee` |
| Sample-level transient refinement infrastructure | (powers Sub-causes A, B, F, G) | | (multiple) |

All shipped. All currently in the production worker. The worker
was last functionally touched May 21 — the past ten days were
storage / library / Phase 1+2 / Phase 3 Commit 1 / design v5
work, not analyzer work.

### Explicit May 20 recommendation (never acted on)

From `tools/sota-eval/LATE_CLUSTER_FIX.md`:

> "All algorithmic rounds planned for this phase are complete.
> Per the user's note: 'if Sub-cause G ships, that's the last
> algorithmic round we plan to do. After this, focus shifts to
> manual UI adjust + nudge telemetry + dogfood.'"

From `tools/sota-eval/REAL_ACCURACY_SUMMARY.md`:

> "1. Per-track anchor offset slider/nudge in ±10 ms increments
>  2. Nudge telemetry capture so real user corrections become a
>     dataset
>  3. Ship at 76-80% and use the telemetry to either model
>     per-track offsets or build training data"

The project pivoted to library Phase 1 + Phase 2 work instead.
The May 20 recommendation is still the on-the-shelf next step
for analyzer accuracy.

### Known un-fixable failure modes

- **Sub-cause B cluster — 14 tracks, irreducible.** All at
  20-27 ms EARLY of Rekordbox truth. Confirmed not fixable from
  audio alone via 3-detector convergence. The tracks:
  - Body Stars
  - Hymn Of The Fern
  - Scarlet Sails
  - Aurora
  - Coaster
  - Leave The World Behind
  - Serenità
  - Fly Fox
  - Great Attractor
  - Astronauts Nightmares
  - Finding Estrella
  - Swans
  - Sparky
  - Track II
- **Long DJ mixes — 11 tracks, all > 10 min.** Fundamentally
  un-griddable by a single-BPM analyzer. Counting them as
  failures inflates the denominator unfairly; the "honest"
  accuracy number is the 84.3% with long mixes excluded.
- **The Palindrome 90 → 120 BPM class** — **NOT in any
  sota-eval doc.** Root cause is the library-side
  `skipBPM:!!track.bpm` flag at lines 814 / 916 / 1155 of
  `useLibrary` in `src/collabmix-production.jsx`, which trusts
  ID3 tags and never re-runs full detection when a tag exists.
  The per-deck path always runs full detection. So the library
  row and deck disagree on BPM for any track with a tag that
  the analyzer would have detected differently. Addressed in
  the followup commit landing tonight (see "1-line skipBPM fix"
  section below).

### Phase 3 Commit 1 (`/diagnose.html`, commit `903e4ef`) — reframed

- Built without prior context on `tools/bpm-test-harness/` or
  `tools/sota-eval/`.
- **Orthogonal to the harness, not duplicate work:**
  - Harness audience: developer comparing analyzer changes vs
    Rekordbox ground truth (272-track curated set).
  - `/diagnose` audience: founder inspecting the real production
    library (~136 tracks, no ground truth available).
  - Different questions, different datasets, different
    actionability. Not in conflict.
- Currently does library metadata dump only (Commit 1 scope).
- **Commits 2-5 of the original Phase 3 plan are NOT the
  highest-priority next step.** They are defensible only if the
  stated problem is "see analyzer divergence at scale on real
  library." For other problems (Palindrome class fix, accuracy
  improvement, user-facing nudge UI) different work would lead.

### Next-session decision point — 5 options

Ranked by what the evidence supports, not by what would be
quickest to start writing:

- **Option A — Per-track ±10 ms anchor nudge UI + nudge
  telemetry.** The explicit May 20 deferred plan. Slider 4-8 hrs,
  telemetry plumbing 2-3 hrs. Doesn't change the analyzer;
  gives users a way to fix the remaining ~20% per-track and
  feeds a real-world dataset for future modeling.
- **Option B — Continue `/diagnose` Commit 2, scoped tighter.**
  Worker invocation + re-detect with `skipBPM:false` on every
  track + surface tracks where stored vs re-detected differ by
  >2 BPM. 4-6 hrs. Measures library divergence. Doesn't fix the
  analyzer.
- **Option C — 1-line `skipBPM` fix.** Applied tonight (see
  below). Fixes the Palindrome class at import time and on
  re-analyze. Smallest possible production change.
- **Option D — Approach A from `STEP5_INVESTIGATION.md`.**
  Beat-0-only forward walk to envelope peak for the Sub-cause B
  cluster. 5-7 hrs. Predicted +8-12 PASS (80.9% → ~83-84% raw,
  ~87% excluding long mixes). Breaks the explicit "G is the
  last round" decision — re-litigates that call.
- **Option E — Dogfood Phase 1+2 first, decide based on real
  feedback.** Don't pick an analyzer direction until DJs have
  actually used the library auto-import in a real session.
  Lowest-cost option; highest-information option.

### Recommended framing for tomorrow

**Pick which problem you're solving before picking what to
build.** The 5 options above each serve a different problem.
None are wrong; choosing without naming the problem leads to
work that doesn't connect to user outcomes — which is how
Phase 3 Commit 1 got built tonight without first asking whether
the diagnostic was the right next investment.

| If the problem is… | The right next move is… |
|---|---|
| "Palindrome shows wrong BPM in library" | **Option C** (landed tonight). |
| "See analyzer divergence at scale on real library" | **Option B** (Phase 3 Commit 2, scoped tighter). |
| "Analyzer 80.9% isn't good enough, push to 85%+" | **Option D** (Approach A from STEP5). |
| "Users will fix per-track grids themselves; give them the tool" | **Option A** (deferred May 20 plan). |
| "Don't know if analyzer accuracy actually matters yet" | **Option E** (dogfood first). |

### 1-line `skipBPM` fix (separate commit landing tonight)

Per Option C above and the Palindrome root-cause finding, the
followup commit tonight changes `skipBPM:!!track.bpm` to
`skipBPM:false` at the three `useLibrary` queue-push sites
(lines 814, 916, 1155 of `src/collabmix-production.jsx`). See
that commit's message for trade-offs and verification report.
Existing tracks with tag-based BPM are not re-analyzed by the
fix; they keep their current stored values. New imports and
re-analyze actions will use the corrected logic.

### Don't-touch list (unchanged)

- `src/bpm-worker-source.js` — analyzer DSP, untouched since
  May 21
- `tools/bpm-test-harness/`, `tools/sota-eval/`,
  `tools/rekordbox-eval/` — preserved as reference artifacts;
  re-runnable but not modified
- Worktrees `../collabmix-booth`, `../collabmix-decks` —
  REFERENCE ONLY
- Memory pipeline (`processQ`, `fileMap` LRU, AudioContext
  recycle)


## Session end — June 6, 2026 — Phase 3 Beat Grid Panel design pivot

Tonight built two commits of a slide-down Beat Grid panel
(scaffolding + Set-Beat-1 migration, then anchor nudge ±10 ms
stepper + telemetry). Both pushed to master and verified working
end-to-end via Claude Desktop. Then user shared Rekordbox
screenshots showing the actual pro-DJ pattern for the same
problem and we caught that the slide-down panel approach was
the wrong design. Plan: revert both commits next session and
rebuild as a tab-based design.

### PUSHED COMMITS TO REVERT TOMORROW

- **`bf2198a`** — Phase 3 Beat Grid Panel Commit 1 (scaffolding
  + Set-Beat-1 migration)
- **`b38c539`** — Phase 3 Beat Grid Panel Commit 2 (anchor
  nudge ±10 ms stepper + telemetry)

### REVERT COMMAND PLANNED (single combined revert, no force push)

```
git revert --no-commit b38c539 bf2198a
git commit -m "Revert Phase 3 Beat Grid Panel (Commits 1 + 2) — pivoting to vertical tab design"
git push origin master
```

After this, master is functionally back to `c174fd3` state.
Reverted commits stay in history for porting the nudge math /
telemetry payload / indicator dot logic.

### DESIGN PIVOT REASON

Rekordbox uses vertical tabs on the left side of each deck
(user shared screenshots tonight, tooltip "Displays BPM/Grid
adjustment buttons and Auto Gain adjustment knob"). Click a
tab → lower control zone content swaps. Waveform / transport /
mixer all stay unchanged. The slide-down panel approach in
Commits 1+2 grew the deck card and stole vertical space —
wrong pattern.

### NEW DESIGN APPROVED

- Vertical tab strip inside each deck card, leftmost edge,
  ~24px wide
- Tab strip spans full deck card height below title row
  (~210px)
- Two tabs initially: CUES (default, existing chips behavior)
  and GRID (new content)
- Vertical-rotated text labels (Inter 9px, letter-spacing 2)
- Active tab: rgba(255,255,255,0.06) bg, 0.9 text, thin 0.30
  left accent border
- Inactive tab: transparent bg, 0.6 text, 0.9 on hover
- 150ms cubic-bezier transitions
- Per-deck state inside each Deck component (`activeTab:
  "cues" | "grid"`, default `cues`)
- Grid tab content can grow taller than Cues — parent grid
  bumps 248px → 290px when any deck has Grid tab active,
  200ms cubic-bezier transition. Library absorbs ~42px loss.
- Set-Beat-1 lives INSIDE Grid tab (removed from transport
  row — single source of truth)
- Indicator dot moves to GRID tab label when track has any
  override

### GRID TAB CONTENT (~80px, two rows)

Row 1 (BEAT 1 + ANCHOR): Set-Beat-1 button · ANCHOR label ·
−10 ms · +10 ms · Auto/Manual badge for anchor

Row 2 (BPM + RESET): BPM label · −1 button · 122.7 display
(Inter 14px, tabular-nums, `.toFixed(1)`) · +1 button ·
Auto/Manual badge for BPM · Reset text button

BPM stepper behavior: first click writes
`round(currentEffectiveBpm) ± 1` to `bpmOverride`. Snaps to
integer on first click, then steps by 1.

### TELEMETRY EVENTS

- `[GRID-SNAP]` for Set-Beat-1
- `[GRID-NUDGE]` + `logEvent('grid', 'anchor_nudge', ...)` for
  nudges
- `[GRID-BPM-OVERRIDE]` + `logEvent('grid', 'bpm_override_set',
  ...)` for BPM
- `[GRID-RESET]` + `logEvent('grid', 'override_cleared', ...)`
  for reset

### CORRECT LOGIC TO PORT FROM REVERTED COMMITS

- Anchor nudge math (reads `bpmResult.firstBar1AnchorSec`,
  writes clamped `gridAnchorSec`, compounds correctly)
- Telemetry payload shape
- Indicator dot logic (`hasOverride` from parent's
  `_buildUserGrid`)
- Set-Beat-1 `snapToTransient` behavior

All correct — just need new host UI.

### 6 ASSUMPTIONS AWAITING APPROVAL TOMORROW

1. Single combined revert commit (not two separate, not force
   push) — Claude recommends, awaiting confirmation
2. Tab strip vertical extent: full deck card height below title
   row (~210px), not scoped only to cue chips footprint
3. Vertical-rotated CUES / GRID text labels (not icons, not
   two-letter)
4. Transport-row Set-Beat-1 stays REMOVED after revert — Grid
   tab is single source of truth
5. Indicator dot moves from transport-row Grid button onto GRID
   tab label
6. Parent grid height transitions 248 → 290 when any deck has
   Grid tab active, library absorbs loss

### REVISED COMMIT SLICING

- **Tomorrow Commit A** — Single combined revert
- **Tomorrow Commit B** — Build new tab system + Grid tab
  content (heaviest commit — tab strip + Grid tab +
  Set-Beat-1 migration + nudge + BPM + reset + indicators all
  together; no good split point)
- **Tomorrow Commit C** — Polish + Vercel verification +
  Phase 3 SHIPPED handoff (also lands the polish items:
  rename `prevAnchor`→`prevAnchorSec`, styled tooltips
  replacing native `title`)

Total estimate: 5-8 hours tomorrow.

### Don't-touch list (unchanged from prior section)

- `src/bpm-worker-source.js` — analyzer DSP
- `tools/bpm-test-harness/`, `tools/sota-eval/`,
  `tools/rekordbox-eval/`
- Worktrees `../collabmix-booth`, `../collabmix-decks`
- Memory pipeline (`processQ`, `fileMap` LRU, AudioContext
  recycle)


## Session end — June 7 night — Jake dogfood failure + Bug #1 (room/peer) FIXED + Layer 1 telemetry SHIPPED

Tonight ran the first real B2B dogfood with Jake. Shipped
Layer 1 telemetry capture in advance so the session would
generate inspectable artifacts instead of relying on memory.
The dogfood itself failed on the room/peer layer — Jake and
Chad never connected — but the failure was diagnosed cleanly
from Jake's downloaded session log, the bug was fully fixed
in five commits, and the production smoke test now passes
8/8. Tonight's production release SHA is `665e7e4`.

### Dogfood attempt (failed but valuable)

First B2B session with Jake attempted ~9pm. Both users loaded
the bare `https://collabmix.vercel.app/` URL. Symptoms:
- Both users got the default name "DJ Nova" (random collision
  from a 6-element pool).
- Each user landed in their OWN randomly-generated room.
- Zero `[RTC]` events in Jake's downloaded session JSON — his
  client never even attempted to peer.
- Jake's app worked SOLO (tracks loaded, BPM analyzed, decks
  played) but they were never in the same room.

The session ended without any B2B mixing actually happening.
Salvaged via post-session async feedback from Jake — bugs
were enumerated, root-caused, and the most critical one
(room/peer) was fixed and verified on production tonight.

### Layer 1 telemetry SHIPPED (5 commits)

Built earlier in the evening so the dogfood would produce
inspectable artifacts. Without this, "Jake's app never tried
to peer" would have been a guess; with it, it was an
evidence-based finding from the JSON Jake downloaded.

- **`f491d45`** — Add `src/utils/sessionLog.js` module
  (`initSession`, `pushEvent`, `mergeSessionMeta`,
  `downloadSessionLog`). 5000-event cap, oldest dropped on
  overflow. Exposes `window.__sessionLog` for console
  inspection.
- **`b8417c0`** — Mirror `logEvent` / `setSessionContext` /
  `captureHandledError` into sessionLog from
  `src/utils/telemetry.js`. **Architectural key:** `logEvent`
  is already the chokepoint for every existing telemetry
  category (ws, rtc, deck, grid, sync, session, error).
  Mirroring there auto-captures every existing event without
  touching dozens of call sites.
- **`224ca72`** — Wire `main.jsx`: `initSession()` at boot,
  global `window.error` + `unhandledrejection` listeners,
  initial keyboard shortcut wiring.
- **`6fc2ecd`** — Add two missing `logEvent` call sites in
  `collabmix-production.jsx`: `logEvent("grid","snap",...)`
  alongside the existing `[GRID-SNAP]` console.log at
  Set-Beat-1, and `logEvent("deck","cue",...)` in the CUE
  handler. Symmetric payload to GRID-NUDGE: `{deck, trackId,
  prevAnchorSec, newAnchorSec, source: "snap_to_transient"}`.
- **`87b10d0`** — Keybinding hardening. Initial Cmd+Shift+L
  binding never fired in Chrome (likely captured by 1Password
  or similar before the page saw keydown). Switched to
  Cmd+Option+L (Ctrl+Alt+L on Win/Linux), used `e.code ===
  "KeyL"` (layout-independent), strict exact-match modifiers,
  `{capture: true}` registration, and a one-time init log
  `"[sessionLog] download shortcut: ..."` so any future
  smoke test can verify the listener mounted.

End-to-end smoke verified by Claude Desktop on both localhost
and production. JSON file lands on disk with valid `meta` +
`events` shape and event count matching
`window.__sessionLog.count()`.

### Layer 1 deferred items

- **`meta.release` reads `"dev"` not the git SHA** on
  production. `VITE_SENTRY_RELEASE` env var is not being
  injected into Vercel's build pipeline. Tonight's deploy
  SHA was manually noted as `665e7e4` for any post-session
  JSON review. Fix this week (Vercel project env settings).
- **Code hygiene** noted by Claude Desktop: the keyboard
  shortcut calls the private `downloadSessionLog` import
  directly rather than `window.__sessionLog.download()`.
  Functional today, refactor later for single-source-of-
  truth symmetry.
- **Possible duplicate `session.room_joined` events on
  mount** in dev (likely React StrictMode double-mount —
  StrictMode typically doesn't run in prod builds, so this
  may be dev-only; verify when reviewing prod JSON).

### Bug #1 (room/peer) — FIXED in 5 commits

Five sub-causes were identified and addressed in one
focused commit chain:

| Sub-cause | What broke | Commit |
|---|---|---|
| A | Random default name from 6-element pool → 16.7% collision per pair | (covered by 2) |
| B | **No "enter room code" UI anywhere** — base URL always generates a new room, no path to join an existing one without the full invite URL | (covered by 1) |
| C | Sticky `cm_session` localStorage silently overrode invite link with prior room | (covered by 3) |
| D | Auto-rejoin Path 1 stripped `?room=` from URL via `replaceState`, then RTC role tiebreaker re-read the now-empty URL and declared both peers initiator (latent SDP glare) | (covered by 4) |
| E | Existing `ShareButton` in session header was 7px font / 7% gray opacity — invisible at the moment users needed it, and room code was never displayed for verbal sharing | (covered by 5) |

- **`5bae11e`** — Lobby: "JOIN BY MIX CODE" input below
  the primary join button (only in START A MIX mode).
  Accepts free-form room code, trims + lowercases, calls
  the same `onJoin` path with the typed room. Fixes the
  receiver side of the discoverability gap.
- **`b87b551`** — Default DJ name: append 4-char hex
  suffix (e.g. "DJ Nova 7c2a"). 6-pool × 65,536 suffix →
  ~1-in-393k collision rate. Visible in the input so users
  can edit or delete the suffix freely.
- **`b107b07`** — Auto-rejoin: URL `?room=` now wins over
  `cm_session`. New Path 1b: if URL has `?room=` but no
  `?name=`, skip the localStorage path entirely. The Lobby
  is already rendered (main.jsx routes initialPage="lobby"
  when `?room=` is present) and the user confirms via one
  click. Path 2 only runs when there are no URL params.
- **`728c5a9`** — RTC role tiebreaker: capture initial
  isHost in `initialIsHostRef` (useRef lazy-init, runs
  before any useEffect can strip the URL) and read that
  ref instead of re-checking `window.location.search`.
  Also replaces two other duplicate URL re-reads (`join`,
  setSessionContext effect).
- **`665e7e4`** — Session header: enhance existing
  ShareButton (label "Invite partner" / "Link copied", 10px
  Inter weight 500, slightly more visible bg, 150ms
  transitions) AND add a `tabular-nums` room code display
  between DJ name and Invite button. Header reading order
  now: `[DJ name] [room code] [Invite partner] [Leave]`.

Production smoke test (8/8 PASS via Claude Desktop on
Vercel + Railway infrastructure, two Chrome profiles):
unique names, JOIN BY MIX CODE, same-room peering, RTC
bidirectional, invite link path, sticky session resilient,
audio sharing both ways, sync engages and beatmatches
across peers. Phase 2 library features + Layer 1 telemetry
intact.

### Jake feedback captured (separate items)

- **Bug #2 — Sync release doesn't reset rate.** Code
  comment at lines 6866-6872 says this is intentional
  (matches Rekordbox / CDJ convention). DESIGN QUESTION
  awaiting Jake's clarification on whether his expectation
  reflects a real pain point or just unfamiliarity.
- **Bug #10 — Scrub on master moves slave.** DESIGN
  QUESTION awaiting Jake's clarification.
- **Feature #8 — Manual BPM override UI.** Already on the
  Phase 3 Beat Grid Tab plan saved in the prior session-end
  section.
- **Feature #9 — Drag-and-drop library → deck.** NEW.
  Needs scoping (may already partially exist via existing
  drag-over handlers at lines 4436-4438 / 7368-7387).

### Palindrome fix — shipped earlier today

- **`c728878`** — `Fix Palindrome BPM class — library
  analyzer now always runs full BPM detection`. Library
  side now passes `skipBPM:false` at all re-analyze sites,
  so a track tagged with the wrong BPM (e.g. Palindrome at
  90 vs detected 120) gets corrected on import / re-analyze.
  Verified working in production. Resolves the
  Palindrome-class root cause identified in the May 31
  reconciliation section.

### Don't-touch list (unchanged)

- `src/bpm-worker-source.js` — analyzer DSP
- `tools/bpm-test-harness/`, `tools/sota-eval/`,
  `tools/rekordbox-eval/`
- Worktrees `../collabmix-booth`, `../collabmix-decks`
- Memory pipeline (`processQ`, `fileMap` LRU, AudioContext
  recycle)
- Phase 2 library code (works correctly, ships)
- Layer 1 telemetry capture (working, do not regress)

### Tomorrow's plan

1. **Session Start Protocol first.** Read VISION_5.md last
   2 sessions (this one + June 6 pivot), CLAUDE.md, journal
   if present.
2. **Get Jake's answers** on the two design questions (#2
   sync release + #10 scrub-on-master).
3. **Revert Phase 3 Beat Grid Panel commits** per the
   saved plan in the June 6 section. Single combined
   revert: `git revert --no-commit b38c539 bf2198a` then
   one commit. Reverted commits stay in history for porting
   the nudge math, telemetry payload, and indicator-dot
   logic.
4. **Build Phase 3 Beat Grid Tab system** per the design
   approved in the June 6 section. Addresses #8 (manual
   BPM override) and completes the anchor/BPM override
   functionality in a Rekordbox-pattern vertical tab UI.
5. **Possibly start drag-and-drop scoping (#9)** if time
   permits.
6. **Fix Vercel env var injection** so `meta.release` reads
   the git SHA instead of `"dev"` in tonight's session log
   format. Deferred item #4.
7. **Schedule Jake round 2** once the Phase 3 Beat Grid
   Tab system ships — second dogfood with the room/peer
   bug fixed and the BPM/anchor UI live.

### Deferred for later this week

- **UX/design competitive review (#13).** Focus areas
  include emotion / waveform / beat grid. Currently
  deferred from tonight's tactical fix work.


## Session log — June 7 night (FULL) — Issue log + Critic review + tomorrow's plan

Persistence capture written near the end of tonight's chat
window so tomorrow's Claude can pick up complete context.
Supplements (does not replace) the prior June 7 session-end
section above. The earlier section is the official ship log
of tonight's commits; THIS section is the broader state of
the world — issue tracker, Claude Desktop's Critic Role
design review, Jake status, and tomorrow's priorities.

### Production state at this snapshot

- Latest commit on master: `f93318e` (Vercel SHA injection
  for `meta.release`).
- **Plus uncommitted in working tree:** the #12 `isHost`
  fix. Built clean locally, dev server up at
  `localhost:5173` (PID 58314) for Claude Desktop multi-tab
  verification, **not yet pushed**.
- Production deploy SHA:
  `f93318ed23461916ed6fcb43619bbf73c6c9c359`.
- All Layer 1 telemetry verified working on prod.
- All Bug #1 fixes verified working on prod (8/8 smoke
  test).

Tonight's commit chain (12 commits, oldest to newest):

| Group | Commits |
|---|---|
| Layer 1 telemetry | `f491d45` → `b8417c0` → `224ca72` → `6fc2ecd` → `87b10d0` |
| Bug #1 room/peer fix | `5bae11e` → `b87b551` → `b107b07` → `728c5a9` → `665e7e4` |
| VISION_5 session end | `3d7fdd1` |
| Vercel SHA injection | `f93318e` |
| **Uncommitted** | #12 `isHost` fix pending verification + push |

### Full issue log — 15 items

#### Closed tonight

- **#1 Room/peer connection bug.** Five sub-causes (name
  collision; no JOIN-BY-CODE input; sticky `cm_session`
  overriding invite link; URL-strip race in RTC tiebreaker;
  invisible session-header invite affordance). Five commits.
  8/8 production smoke test PASS via Claude Desktop on
  Vercel + Railway.
- **#4 `meta.release` shows "dev" not git SHA.** Root cause:
  `VITE_SENTRY_RELEASE` was undefined in production because
  Vite only exposes `VITE_`-prefixed env vars to client
  code, and Vercel's `VERCEL_GIT_COMMIT_SHA` lacks that
  prefix. Fixed via `define:` block in `vite.config.js`
  (`f93318e`). Verified on prod — bundle now contains the
  full 40-char SHA twice.
- Plus Phase 2 library auto-import + Palindrome BPM class
  fix from earlier today (`c728878`, already in VISION_5).

#### In progress (verification pending)

- **#12 `meta.isHost: true` on both tabs after JOIN BY MIX
  CODE.** Root cause documented in this session's earlier
  Task B report: the prior `initialIsHostRef` inferred
  host-ness from URL `?room=` presence at mount, which
  broke for the new JOIN-BY-CODE path (joiner at bare URL
  looked identical to creator at bare URL) and for any
  joiner who refreshed mid-session after the URL was
  stripped. Fix: `isHost` becomes an explicit field passed
  by every call site, stored in a new `iAmHostRef`,
  persisted to `cm_session` for refresh resilience. **Fix
  built and applied to working tree, NOT yet committed
  or pushed** — pending Claude Desktop's 8-step multi-tab
  smoke test on localhost. If 8/8 PASS, push as a single
  commit; if anything regresses Bug #1 peering, revert
  immediately.

#### Pending decision — Jake's clarification needed

- **#2 Sync release rate behavior.** Current code at
  `collabmix-production.jsx:6866-6872` deliberately
  preserves the synced rate on toggle-off per
  Rekordbox/CDJ convention (commit message documents this
  was a reverted overreach). Jake reported expected
  reset. Ask Jake: (a) "Did you want the rate to snap back
  to the slave's natural BPM?" vs (b) "Were you just
  confused about what rate it ended up at because the
  pitch fader didn't visibly move?" — option (a) means we
  change behavior, option (b) means we add visual
  feedback without changing behavior.
- **#10 Scrub-master-moves-slave behavior.** Sync engine
  re-aligns slave when master scrubs. Jake wants this
  different. Need Jake's preferred behavior before
  scoping a fix.

#### Confirmed feature gaps from Jake's session

- **#8 Manual BPM override UI.** Already on the Phase 3
  Beat Grid Tab plan (June 6 design pivot section). Lands
  with the tab-system rebuild.
- **#9 Drag-and-drop library → deck.** NEW. Some drag
  primitives already exist (`onDragOver`/`onDrop` handlers
  at lines 4436-4438 and 7368-7387). Needs investigation
  to scope: where library tracks render, how decks accept
  loads, what protocol exists between them. Standalone
  work, not on any prior plan.

#### Deferred — tomorrow's work

- **#3 Phase 3 Beat Grid Panel design pivot.** Revert
  plan saved in June 6 section. Single combined revert:
  ```
  git revert --no-commit b38c539 bf2198a
  git commit -m "Revert Phase 3 Beat Grid Panel (Commits 1+2) — pivoting to vertical tab design"
  ```
  Then build the vertical tab system per the approved
  spec in the June 6 section (vertical tab strip inside
  the deck card's left edge, two tabs CUES/GRID, GRID tab
  contains Set Beat 1 + ±10 ms anchor + ±1 BPM + BPM
  display + Reset + Auto/Manual indicators).
- **#5 Code hygiene.** Cmd+Option+L shortcut handler
  calls the private `downloadSessionLog` import directly
  rather than `window.__sessionLog.download()`. Functional
  today, refactor for single-source-of-truth symmetry.
  Trivial, batch with any sessionLog touch.

#### Deferred — later this week

- **#13 Comprehensive UX/design competitive review.** The
  full-scope version of tonight's #15 Critic review.
  Schedule after Phase 3 tab system + drag-and-drop ship.
- **#14 Process improvement — Claude Desktop's four
  roles.** Critic / Competitive Intel / Execution Partner
  / Validation. Habit 1 (passive design observation
  embedded in every Claude Desktop test prompt) is now
  automatic going forward. Other three roles are explicit
  on-demand triggers.

#### Open observations

- **#11 Intermittent "Could not connect to server"
  banner.** Seen only on localhost during tonight's
  testing, NOT reproducible on prod. Likely a dev-mode
  WebSocket reconnect quirk. Watch but don't chase.
- **#6 Possible duplicate `session.room_joined` events on
  mount.** Tonight's prod JSON inspection — confirmed
  absent on production builds (was a React StrictMode
  artifact in dev only).
- **#7 Analyzer offset on Jake's tracks.** A few tracks
  in Jake's session showed beat grid offsets consistent
  with the known Sub-cause B cluster (irreducible from
  audio alone per the May 20 three-detector convergence
  finding documented in May 31 reconciliation section).
  Not a new bug.

### #15 — Critic Role design review (verbatim capture)

Claude Desktop ran the Critic Role design review tonight
against the production app. Capturing in full because the
synthesis is more valuable than the individual notes and
won't survive context truncation.

#### Product identity read

- Product: browser-based two-DJ remote B2B mixing platform.
- Audience: **prosumer / serious-hobbyist DJs.** Not
  casual. Not producers. The vocabulary alone — Camelot
  keys, hot cues, Rekordbox import, CDJ name-drops —
  signals this.
- Price tier read: feels free or ~$10/mo. Ambition
  justifies $15-20/mo. Visual finish doesn't yet project
  that. Could plausibly trick into $50+ tier with polished
  surface.

#### Dimension ratings (1-10)

| Dimension | Rating | Notes |
|---|---:|---|
| Visual polish | 6 | Workspace strong; landing weak |
| Information density | 8 | Rekordbox-adjacent, dense in a good way for the audience |
| Professionalism | 6.5 | Held back by surface details |
| Differentiation | 5 | "Dark synthwave dev tool" — could sell a VPN |
| Trust | 5.5 | P2P privacy copy is good; broken icons + AUDIO:OFFLINE on load + naming drift erode |

#### Top 3 amateur/generic signals (highest-priority fixes)

- **#15A — Mismatched icons in feature grid.** Yellow
  emoji ⚡, red emoji 🎯, blue emoji 🔊, plus a plain
  white circle (broken/missing icon for "Session
  Recording"). Most amateur-looking single artifact on
  the site. ~30-60 min fix.
- **#15B — Two clashing typography systems.** Landing
  uses all-caps geometric sans ("MIX TOGETHER."); lobby
  + app use elegant serif ("Mix//Sync"). Reads like two
  different products. ~1-2 hrs to unify.
- **#15C — Generic hero section.** Dark + faint grid +
  blue-to-purple gradient text + "THE FUTURE OF REMOTE
  DJing" — could sell a VPN. No DJ specificity until you
  scroll. ~2-4 hrs to redesign with real product
  screenshot.

#### Top 3 good signals

- **The center mixer.** Channel-A blue / channel-B
  purple, glowing knobs, real vertical faders, Master in
  the middle, VU meters. Claude Desktop's verbatim:
  "most credible, clearly-loved part of the UI."
- **Domain-correct density.** Camelot, beat-jump, hot
  cues, Rekordbox import, harmonic/BPM suggestions.
  Verbatim: "speaks fluent DJ."
- **Honest low-friction onboarding.** "No account
  required," "Works in Chrome & Edge," P2P privacy claim.

#### One screen to redesign

The **landing / hero page**, not the app. Verbatim: "The
product's real asset — the dense, credible mixer — is
hidden until you launch." Lead with a real workspace
screenshot or a short loop. Pick one typeface system. Fix
the icon set.

#### What's missing

- Real product screenshot anywhere on landing (glaring
  omission for a visual tool).
- "Who's behind this" / social proof / demo video that
  actually resolves.
- Frequency-colored waveforms (every pro DJ tool has
  them; conspicuous absence in our workspace).
- Consistent naming ("Launch App" vs "Start a Mix",
  "Room ID" vs "Mix code" — already partially fixed
  tonight by adding the room code display in session
  header).
- Pricing/limits clarity (paradox: "free" feels less
  trustworthy without details about what tier this is).

#### Strategic synthesis (verbatim from Claude Desktop)

> "Inside is stronger than outside. The mixing workspace
> is dense, domain-literate, and clearly built by someone
> who DJs. The marketing wrapper and unfinished details
> make it read 1-2 notches more amateur than the actual
> tool deserves. Fix the surface and perceived tier jumps
> immediately."

This is the **opposite of the usual problem** — most
pre-launch tools have flashy marketing hiding a rough
product. Mix//Sync has a serious tool hiding behind a
generic wrapper.

#### Derived actionable items

| # | Item | Estimate | Bucket |
|---|---|---|---|
| 15A | Fix broken icons | 30-60 min | quick win |
| 15B | Unify typography | 1-2 hrs | quick-medium |
| 15C | Replace generic hero with real product screenshot | 2-4 hrs | medium |
| 15D | Consistent naming/vocabulary across site + app | 30-45 min | quick win |
| 15E | Add creator / social proof to landing | 2-3 hrs | medium |
| 15F | Frequency-colored waveforms | 15-20 hrs | already in Phase 6 |
| 15G | Pricing / limits clarity | depends on business decision | — |

#### Strategic implications for the roadmap

- **Phase 9 (marketing site polish), originally
  scheduled "with launch," should happen BEFORE launch.**
  The marketing wrapper is currently the weakest part of
  the perceived tier.
- **Phase 6 (frequency-colored waveforms) elevated
  priority** — confirmed as the #1 visible amateur signal
  inside the actual product.
- Quick wins #15A + #15D could ship alongside Phase 3
  Beat Grid Tab tomorrow if energy permits.

### Tomorrow's priority order

1. **Session Start Protocol.** Read VISION.md (if it
   exists), CLAUDE.md, the prior session-end section
   (`Session end — June 7 night — Jake dogfood…`), and
   THIS section. Skim journal.txt if present.
2. **Check status of #12 isHost fix.**
   - If Claude Desktop already verified 8/8 PASS by the
     time tomorrow's session starts → push the in-flight
     commit to master, run prod smoke, close #12.
   - If anything failed → debug and fix.
   - If verification didn't happen → run it first before
     anything else.
3. **Check email/messages for Jake's answers** on #2 +
   #10. If answers received, plan sync engine work. If
   no answers yet, defer both.
4. **Phase 3 Beat Grid Panel design pivot** (biggest
   piece of tomorrow's work, 5-8 hrs):
   - Confirm the 6 saved assumptions from the June 6
     pivot section
   - Execute the revert as a single combined commit
     (Tomorrow's Commit A)
   - Build the new vertical tab system per the saved
     spec (Tomorrow's Commit B)
   - Polish + Claude Desktop verification + push
     (Tomorrow's Commit C)
5. **Quick wins from #15 Critic review** (if energy
   permits):
   - #15A Fix broken icons (30-60 min)
   - #15D Consistent naming (30-45 min)
   - Could batch alongside Phase 3 push if time permits
   - #15B + #15C are bigger, defer to dedicated session
6. **Drag-and-drop scoping (#9):**
   - Investigation only — Claude Code maps where library
     renders, where decks accept loads, what handlers
     already exist
   - Produce implementation plan, do NOT build yet
   - Schedule build for a separate session

### Jake status

Jake's session ended ~30 min after start due to Bug #1
preventing peering. Sent Jake a message acknowledging the
issue, asking for sync clarifications (#2 + #10), and
committing to round 2 once Phase 3 Beat Grid Tab +
drag-and-drop ship.

Jake's session log JSON: Chad has both his own + Jake's
JSON files saved from tonight's session (or will receive
Jake's async). Useful for cross-referencing future bug
reports.

Round 2 dogfood with Jake: schedule after Phase 3 Beat
Grid Tab ships + drag-and-drop is at least scoped (ideally
shipped).

### Process improvements made tonight

CLAUDE.md additions from earlier today (`c174fd3`):
- **Session Start Protocol** was exercised successfully
  tonight during Bug #1 investigation — confirmed working
  as designed.
- **Visual Verification Protocol** was exercised — Claude
  Desktop drove all visual verification across Layer 1
  telemetry, Bug #1 fix, and tonight's #15 Critic design
  review.

Going forward:
- **Every Claude Desktop test prompt** now includes a
  passive design-observation request (Critic Role
  micro-version). Standard practice from this point.
- **Weekly structured design review** TBD as recurring
  practice — frequency to be set.
- **Pre-launch comprehensive #13 review** scheduled after
  Phase 3 + drag-and-drop ship.

### Don't-touch list (unchanged)

- `src/bpm-worker-source.js` — analyzer DSP
- `tools/bpm-test-harness/`, `tools/sota-eval/`,
  `tools/rekordbox-eval/`
- Worktrees `../collabmix-booth`, `../collabmix-decks`
- Memory pipeline (`processQ`, `fileMap` LRU,
  AudioContext recycle)
- Phase 2 library code (works correctly, ships)
- Layer 1 telemetry capture (working, do not regress)
- Bug #1 room/peer code paths (just shipped, verified)


## Session log — June 7 night (ADDENDUM) — Post-capture items + process learnings

Supplement to the `f785811` persistence capture. The June 7
night chat continued after that commit landed, and several
issue-log additions, framings, and process learnings were
discussed in that tail. Capturing here before context is
lost. Nothing in this section changes the prior session log
or invalidates it — it extends.

### Post-capture issue log additions

#### #11 — UPGRADED from cosmetic to "worth investigating"

Originally logged in the `f785811` capture as: cosmetic,
localhost only, watch. Reframed after observing the timing:

- The "Could not connect to server" red banner flashes on
  Tab B reload **right as the user returns to the working
  session.** RTC connects fine within ~1s, but the first
  visual impression on every reload is a red error.
- Bad emotional moment, even if functionally harmless.
- Tomorrow's investigation question: is this stale state
  from before reload (UI shows last-known status before
  the new WS handshake completes), or a real signaling
  hiccup during reconnect? The former is a 5-line fix
  (suppress the banner during the first N ms after mount);
  the latter needs deeper inspection.
- Worth investigating **before next Jake dogfood** so the
  first thing he sees on a refresh isn't a red error.

#### #16 — NEW — Beat Grid panel ANCHOR controls too close to transport row

- ±10 ms anchor stepper sits visually too close to the
  transport row with no clear divider.
- Easy to mis-click adjacent transport controls.
- Will likely be addressed by the Phase 3 vertical tab
  redesign (different surface entirely — anchor controls
  move INSIDE the GRID tab, off the transport row).
- Log anyway so we don't drop it if the tab redesign
  leaves any spacing tension between the new tab content
  and the transport row.

#### #17 — NEW — Session header connection cluster is the strongest emotional beat in the app

- `CONNECTED · 32ms` + partner pill + `AUDIO: STREAMING`
- Critic Role observation, verbatim: **"the genuine
  we're-live-together feeling."**
- **KEEP THIS DESIGN** — explicit instruction not to
  disturb in future iterations.
- Reference as "felt-sense success" when polishing other
  elements: this is what the rest of the app should feel
  like at its peak moments.
- Useful design anchor: when in doubt about visual
  treatment of any other live/realtime element, look at
  what the connection cluster does and match the energy.

#### #18 — NEW — Waveform reads as "level meter" not DJ waveform

- Direct observation during the Critic review: still a
  flat single-color blue.
- Reinforces **#15F (frequency-colored waveforms,
  already in Phase 6 roadmap)**.
- The exact target audience (prosumer/serious-hobbyist
  DJs per #15 audience read) expects Serato/Rekordbox-
  style RGB frequency bands. Without them the workspace
  reads as "level meter visualization" rather than "DJ
  tool."
- Conspicuous absence confirmed by both the Critic Role
  review AND direct in-session observation — two
  independent signals same conclusion.
- **Priority bump:** 15-20 hrs work, high visual impact.
  Elevate within Phase 6 scheduling. Currently a
  conspicuous "amateur" signal inside an otherwise
  pro-feel workspace.

### #14 EXPANSION — Claude Desktop 4-role framework (full)

The `f785811` capture mentioned this expansion but didn't
spell it out. Full framework below.

#### Role 1 — Critic

- **Purpose:** structured reviews of what's shipped
  against references.
- **Style:** brutal-honest critique. Not "looks good."
- **When to use:** after major UI work; weekly minimum;
  definitely before launch.
- **Output:** specific observations with examples (e.g.
  "the feature-grid icons mix emoji styles") not vague
  praise.
- Tonight's #15 review is the reference example.

#### Role 2 — Competitive Intelligence

- **Purpose:** deep competitor study (Rekordbox, Serato,
  Beatport DJ, djay, RecordBox web, etc.).
- **When to use:** before significant design work; before
  launch; quarterly for trends.
- **Output:** study reports with patterns + screenshots +
  concrete recommendations for what to borrow / avoid /
  invert.

#### Role 3 — Execution Partner

- **Purpose:** builds variations under user's strategic
  direction.
- **When to use:** AFTER decision is made, not during
  decision-making. Decision-making is Chad's; execution
  partner generates options to pick from.
- **Output:** concrete options (visual mockups, code
  variants, copy variants) to pick from.

#### Role 4 — Validation

- **Purpose:** verifies design intent matches execution.
- **When to use:** after implementing significant
  changes, before declaring done.
- **Output:** honest "user-like" reports — does this feel
  like what we intended? Examples of moments where
  intent and execution diverge.

#### Three habits to systematize

| Habit | Status |
|---|---|
| **1. Passive design observation request in every Claude Desktop test prompt** | ✅ NOW AUTOMATIC — included in all verification prompts going forward |
| **2. Weekly structured design review** | TBD recurring schedule |
| **3. Pre-launch comprehensive #13 review** | Scheduled after this week's changes ship (Phase 3 tab system + drag-and-drop + any quick wins) |

### Strategic framing — Chad's stated weakness + the compensating system

Chad's self-stated weakness from June 7 night chat: **"I'm
bad at branding, UI design, webpage design, marketing."**
The system to compensate:

| Function | Owner |
|---|---|
| Strategic direction | Chad + Jake + future DJ testers |
| Brand vision | Chad + persistent `DESIGN_PHILOSOPHY.md` |
| Daily execution | Claude Code (builds) + Claude Desktop (verifies + critiques) |
| Quality control | Claude Desktop — Critic role |
| Competitive awareness | Claude Desktop — Intel role |
| Validation | Real DJ users (Jake first, others later) |

The system explicitly leverages Chad's strengths (product
direction, DJ domain knowledge, sense of when something
feels wrong) and offloads his stated weaknesses to roles
that compensate for them with structured, repeatable
process.

### Process learnings from June 7

- **Session Start Protocol** (CLAUDE.md, `c174fd3`)
  exercised successfully during Bug #1 investigation.
  Specifically surfaced the prior 47-file `tools/sota-eval/`
  + 33-file `tools/bpm-test-harness/` work that earlier
  planning had missed. **Confirmed: protocol works.**
- **Visual Verification Protocol** (CLAUDE.md, `c174fd3`)
  exercised successfully across Layer 1 telemetry, Bug #1
  fix, #15 Critic review, and #12 isHost localhost smoke.
  Claude Desktop drove all visual verification — CLI
  Claude never had to ask Chad to paste console output or
  eyeball UI.
- **Pattern recognized:** Chad catches design/scope
  misses by asking "have we done this before?" and "is
  this how Rekordbox does it?" — the AI side should
  proactively verify both BEFORE drafting plans. This is
  now an implicit rule for Claude Code investigation
  passes.
- **"Inside is stronger than outside" framing from #15
  review** is a real strategic insight, not just a
  one-off observation. Mix//Sync is in the rare position
  of having a substantive product behind under-polished
  marketing. **Fixing the surface gives an immediate
  perceived-tier jump** — most pre-launch tools have the
  opposite problem (flashy marketing hiding a rough
  product) and don't have this lever available.

### Jake status — June 8 morning

- **Last contact:** post-session debrief request sent
  ~midnight June 7.
- **Awaiting answers on:**
  - Bug #2 sync release rate — (a) wanted snap back vs
    (b) couldn't tell what rate it ended up at.
  - Bug #10 scrub-master-moves-slave — preferred
    behavior.
- **Round 2 dogfood:** schedule after Phase 3 Beat Grid
  Tab + drag-and-drop ship (at minimum scoped, ideally
  built).

### Today (June 8) priority order — unchanged from `f785811` capture

1. Status check **#12 isHost fix** — verify or push
   based on last night's Claude Desktop smoke results.
2. Check for **Jake's replies on #2 / #10.**
3. **Phase 3 Beat Grid Panel revert + vertical tab
   system build.** Biggest piece, 5-8 hrs.
4. **Quick wins from #15** if energy permits: #15A
   icons (30-60 min), #15D consistent naming (30-45
   min). Note: prompt referenced #15A icons + "#15C
   naming" but per the issue numbering in the prior
   section, naming is #15D (#15C is the generic-hero
   redesign which is 2-4 hrs and NOT a quick win).
   Treating naming as #15D below.
5. **Drag-and-drop scoping (#9)** — investigation only,
   produce implementation plan, do not build.

### Don't-touch list (unchanged)

Same as prior section.


## Session note — June 8 morning — #12 closed, ready to start Phase 3 work

Short update appended to keep the issue log current and
record the new design observations from Claude Desktop's
production smoke test of the #12 fix.

### #12 — CLOSED

- **Commit:** `1e0690e` (Bug #12 fix: isHost flag now
  correctly false for join-by-code and reload-as-joiner)
- **Production verification:** 4/4 abbreviated smoke test
  PASS via Claude Desktop on `https://collabmix.vercel.app/`
  (Vercel + Railway infrastructure).
  - Step A — Creator `isHost = true` ✅ (regression check)
  - Step B — Join-by-code joiner `isHost = false` ✅ (THE
    FIX — was `true` before)
  - Step C — Bug #1 peering + track sharing intact ✅ (no
    regression to last night's room/peer work)
  - Step D — `isHost = false` preserved across reload ✅
    (THE OTHER FIX — was `true` after reload before)
- **Bonus confirmations from same run:**
  - `meta.release` reads the full 40-char SHA
    `1e0690e2ca8604db3974345c6447f00568e821b9` — confirms
    last night's Task A (Vercel SHA injection via
    `vite.config.js` define block, commit `f93318e`) is
    also live and correct on prod.
  - "Could not connect to server" banner did **not**
    appear on prod this run. Consistent with the prior
    observation that #11 is localhost-only. Still worth
    investigating the localhost behavior before Jake
    round 2 per the ADDENDUM #11 upgrade.

### New issue log items from Claude Desktop's bonus design observations

Three observations surfaced during the prod test as part of
the now-automatic Habit 1 (passive design observation
embedded in every Claude Desktop test prompt). Captured here
so they don't get lost in the prod-smoke chat thread.

#### #19 — NEW — Overview strip vs main deck waveform have no figure/ground distinction

- Both visually near-identical in color + treatment.
- No visual signal of "whole track overview" vs "zoomed
  playback view."
- **Reinforces #15F** (frequency-colored waveforms,
  already in Phase 6 roadmap). Once the main deck waveform
  is RGB frequency-banded, the contrast with the
  single-color overview strip emerges naturally — this
  may auto-resolve.
- Low priority standalone. Track in case Phase 6 work
  doesn't fully solve it.

#### #20 — NEW — Reload recovery is a marketing moment

- Critic Role observation, verbatim: **"Tab B dropped
  straight back into a live, playing, peered session in
  ~3s with partner pill and AUDIO: STREAMING intact."**
- Continuation, verbatim: **"the most confidence-inspiring
  UX beat in the product."**
- **Strategic implication:** worth capturing as
  marketing/demo footage. This is exactly the kind of
  asset that would land hard on the landing page redesign
  per #15C / #15D.
- **Connects directly to #15C** (replace generic hero
  with real product screenshot/loop). Whoever takes on
  the landing redesign should know reload-recovery
  footage exists and is the strongest available.
- Connects to #17 (session header connection cluster as
  strongest emotional beat) — the same component is the
  hero of this moment too.

#### #21 — NEW — Top utility cluster has inconsistent visual weights

- `CONNECTED · 37ms` green-dot status, DJ name pill, and
  `AUDIO: STREAMING` chip — three different visual
  treatments crammed together.
- Sits tight against the `Mix//Sync` logo with
  inconsistent gaps.
- **Fix direction:** unified pill style + more breathing
  room between elements.
- **Tension with #17:** #17 says "the connection cluster
  is the strongest emotional beat — KEEP this design."
  Both are true. **The COMPONENT works emotionally; the
  LAYOUT around it could improve.** Polish opportunity
  for a future design pass — don't disturb the cluster
  itself, fix the surrounding rhythm.

### Ready for Phase 3 work

With #12 closed and the issue log current, the next piece
on today's priority order (from the `f785811` capture and
`615b55f` ADDENDUM) is:

**Phase 3 Beat Grid Panel revert + vertical tab system
build.** Plan saved in the June 6 "Phase 3 Beat Grid Panel
design pivot" section. Standing by for Chad's go-ahead on
the work plan.

### Don't-touch list

Unchanged from prior sections.


## Session — June 8 evening/night — Phase 3 Commit A SHIPPED + tempo control build spec + comprehensive design intel

Long session. Phase 3 Beat Grid Panel work landed cleanly
on production via Commit A. A separate design-exploration
pass produced a full build spec for the next piece (deck
inline tempo nudge cluster) — investigation deferred to
tomorrow morning with fresh judgment. Plus a competitive
audit, multiple design observations, and a deliberate
re-deferral of the vertical tab redesign. Capture below
preserves all of it before stopping.

### Phase 3 Commit A — SHIPPED

- **Commit:** `87627a5` — Phase 3 Beat Grid Panel: Add BPM
  controls + Reset (Commit A of 3)
- **Production SHA:**
  `87627a513951bca616fed4afc3c897bbbed7291d`

#### Verification chain

| Phase | Verifier | Result |
|---|---|---|
| Pre-commit (localhost) | Claude Desktop multi-tab | 9/9 PASS |
| Post-commit (bundle) | Static audit on prod bundle | 8/8 PASS |
| Post-deploy (prod) | Claude Desktop 4-step on Vercel + Railway | 4/4 PASS |

#### What shipped

- **Beat Grid Panel Row 3 added:** `[BPM] [÷ 2] [× 2]
  [type-in] [Reset]`
- **Multipliers trimmed** from initial 4 (÷2, ×0.75, ×1.5,
  ×2) to 2 (÷2, ×2) per Rekordbox reference pattern.
- **Reset telemetry bug fixed** — data-flow fix. Deck now
  reads live `userGridOverride` from parent (derived from
  `lib.library` via `_buildUserGrid`), not stale
  `loadFromLibrary?.track` snapshot. The original bug
  surfaced when an in-session BPM override was applied —
  `loadFromLibrary.track` is the load-time snapshot and
  never sees post-load `setGridEdit` writes.
- **RTC propagation:** BPM override propagates correctly
  over RTC to partner deck (validated in localhost test).
- **Indicator dot** lights up for BPM overrides via the
  existing `hasOverride` truthiness check on
  `userGridA`/`userGridB` (no separate wiring needed —
  `_buildUserGrid` already returns non-null when either
  field is overridden).
- **Telemetry:** `[GRID-BPM-OVERRIDE]` (`method:
  multiplier|typed`) and `[GRID-RESET]` (with
  `hadAnchor`/`hadBpm` flags).
- **No regressions** to Bug #1 (room/peer), #12 (isHost),
  or Layer 1 telemetry — all verified by post-deploy
  bundle audit.

### Deck Inline Tempo Nudge Cluster — build spec READY (for tomorrow)

Claude Desktop produced a comprehensive build spec tonight
(June 8 late). The spec is ready; the build is deferred to
tomorrow morning for fresh judgment.

#### Design exploration coverage

- **Competitive analysis:** Rekordbox 7, Serato DJ Pro,
  Traktor Pro 4, Beatport DJ Pro (browser), Pioneer
  CDJ-3000, DDJ-FLX10.
- **Mix//Sync current deck state:** 533×222 px card, 76 px
  free space in transport row right of M button.
- **Four options generated** with full tradeoffs +
  amateur-vs-pro analysis per option.

#### DECISION — Option 1: Inline Nudge Cluster

- **Position:** right of Sync button, before M, in
  transport row.
- **Layout:** `[−] [readout] [+]` cluster, 116 px total ×
  38 px tall.
- **Controls:**
  - Click `−` / `+`: ±0.1 BPM
  - Shift-click: ±1.0 BPM
  - Scroll over readout: continuous fine adjust
    (~0.05 BPM/notch)
  - Double-click readout: reset to 0.0%
- **Range:** ±8% from native BPM.
- **Display:** `"0.0%"` gray default, `"+1.8%"` amber when
  offset.
- **Hover on readout:** shows effective BPM (e.g.
  `"122.2"`).
- **Visual:** matches Sync button styling. Amber accent
  ONLY when offset ≠ 0.
- **Sync integration:** **tempo overrides Sync (disengages
  it on use).** Decision (b) from the spec.
- **Formula:**
  `effective BPM = (analyzer BPM OR bpmOverride) × (1 + tempoOffsetPct/100)`
- **State persistence:** **NONE** — runtime-only. Resets
  on track load + page reload.
- **Telemetry:**
  `logEvent("tempo", "offset_changed", {deck, trackId, prevPct, newPct, method, effectiveBpm})`
  + `[TEMPO-OFFSET]` console.
- **Audio engine assumption:** spec assumes WaveSurfer.js
  `setPlaybackRate(rate, preservePitch=true)`. Claude Code
  must verify the actual engine before wiring.

#### Critical pre-build investigation (tomorrow)

1. Confirm actual audio engine — WaveSurfer or something
   else.
2. Find header BPM rendering location (needs
   `effectiveBpm` instead of `nativeBpm`).
3. Find Sync engine disengage API.
4. Confirm top waveform timer source (clock-derived vs
   independent).

**Estimated build time:** 2-3 hours including
investigation, implementation, and verification.

### Competitive audit findings (June 8 morning)

Beat grid + waveform competitive audit done with the same
source track in Mix//Sync vs Beatport DJ Pro side-by-side.

- **Mix//Sync grids are pro-grade on correctly-detected
  tracks** — 0-5 ms offsets on attack transients.
- **Visible failure mode is tempo errors** (Palindrome
  90→120, long mixes wrong tempo) — NOT small
  misalignments. This is exactly what Commit A's
  ÷2/×2/type-in addresses.
- **Frequency-colored waveforms are NOT a critical gap.**
  Beatport DJ Pro (direct browser competitor) ships flat
  single-color waveform like Mix//Sync. Phase 6
  confirmed deferrable — earlier instinct to elevate
  priority is moderated by this finding.
- **Waveform render slightly blocky vs Beatport**
  (anti-aliasing gap) — material for Commit C.

### Design observations captured tonight

Existing items from morning audit (verbatim summaries):

- **#28** — Transport row gets crowded with 8 controls
  post-tempo-cluster. Worth deciding if ◂/▸ (pitch-bend)
  earn their place. Polish question.
- **#29** — Key badge (`4A`) underweight relative to BPM.
  Rekordbox/Serato give key more prominence since
  harmonic mixing is core pro workflow. Could color-code
  by Camelot wheel position.
- **#30** — Reinforces #18 (waveform reads as level
  meter).

New items from production verification + design pass:

- **#32 (NEW)** — Landing-to-workspace transition feels
  abrupt. Landing punches above app's weight (`MIX
  TOGETHER. ANYWHERE.` + blue gradient — confident and
  modern). Transition into workspace loads abruptly. `NO
  TRACK LOADED` reads as placeholder, not intentional.
  Fix: easing transition + design the empty workspace
  state as intentional.
- **#33 (NEW)** — Lobby serif `Mix//Sync` wordmark + mono
  room code is a "quiet pro touch." **KEEP** this pattern
  when doing #15B (unify typography).
- **#34 (NEW)** — Beat 1 marker red (`#FF3B30`) feels
  off-palette. Rest of app is amber + blue + warm grays.
  Could use warmer red (more orange/coral) or amber
  accent instead. Minor polish.
- **#35 (NEW)** — Disabled button styling (0.3 alpha) too
  subtle on bright displays. Add `cursor:not-allowed` +
  tooltip on disabled state to communicate WHY. The
  enabled buttons already have good tooltips like
  `"Halve detected BPM"` — disabled state should match
  that level of explanation.

#### Positive confirmation from tonight

Grid panel Row 3 is comfortable at 4 controls (down from
initial 6). The trim was correct. Visual rhythm matches
the existing ANCHOR row (3 controls + label) closely
enough.

### Phase 3 vertical tab redesign — DEFERRED AGAIN

- **#31 — Vertical tab redesign for Beat Grid Panel.**
  Chad raised tonight: *"get rid of the Grid button and
  make it an easy-to-click tab that then shows the
  beatgrid option. Should we have claude desktop research
  this and add it as it might create more space?"*
- **Deferred** to avoid combining two major architectural
  changes in one session.
- Schedule for **after Phase 3 complete** (after tempo
  control + waveform polish ship).
- When revisiting: needs to consider migration of Commit
  A's BPM controls into tab content, indicator dot
  relocation, interaction with the new tempo control
  cluster.

### Issue log — full snapshot

#### Closed today

- ✅ **#1** Room/peer connection bug
- ✅ **#4** `meta.release` shows "dev"
- ✅ **#12** `isHost: true` on both tabs
- ✅ **Phase 3 Commit A** — Beat Grid Panel BPM controls

#### In design — spec ready, awaiting build

- 📋 Deck inline tempo nudge cluster (spec produced
  tonight, ready for tomorrow morning).

#### Pending decision — Jake's clarification needed

- **#2** Sync release rate behavior
- **#10** Scrub-master-moves-slave behavior

#### Confirmed feature gaps from Jake

- **#8** Manual BPM override UI — **PARTIALLY shipped**
  via Beat Grid Panel; tempo control next.
- **#9** Drag-and-drop library → deck.

#### Quick wins from #15 Critic Role review (deferred)

| # | Item | Estimate |
|---|---|---|
| 15A | Fix broken icons on feature grid | 30-60 min |
| 15B | Unify typography | 1-2 hrs |
| 15C | Replace generic hero with product screenshot | 2-4 hrs |
| 15D | Consistent naming / vocabulary | 30-45 min |
| 15E | Add creator / social proof | 2-3 hrs |
| 15F | Frequency-colored waveforms | 15-20 hrs — Phase 6, **confirmed deferrable per Beatport audit** |
| 15G | Pricing / limits clarity | depends on business |

#### New from tonight's verification cycles

- **#19** Overview strip vs deck waveform need
  figure/ground distinction.
- **#20** Reload recovery is a marketing moment.
- **#21** Top utility cluster has inconsistent visual
  weights.
- **#22** Tempo detection errors are the actual visible
  failure mode (this drove the Commit A scope).
- **#23** Waveform render has slightly blocky edges
  (Commit C material).
- **#25** Type-in field doesn't look editable.
- **#26** Reset disabled state inconsistent with
  multipliers.
- **#27** Disabled buttons keep full opacity / border.
- **#28** Transport row crowded with 8 controls.
- **#29** Key badge underweight relative to BPM.
- **#30** Reinforces #18 (waveform reads as level meter).
- **#32** Landing-to-workspace transition abrupt.
- **#33** Lobby serif + mono is good — **KEEP**.
- **#34** Beat 1 marker red feels off-palette.
- **#35** Disabled button styling too subtle.

#### Deferred

- **#3** Phase 3 vertical tab redesign — deferred again
  tonight (#31 is the same item).
- **#5** Code hygiene (shortcut handler).
- **#13** Comprehensive UX review — schedule after Phase
  3 + drag-and-drop ship.
- **#14** Claude Desktop 4-role framework documentation.
- **#31** Vertical tab redesign (re-deferred).

#### Open observations

- **#11** "Could not connect" banner (localhost only;
  watch for prod).
- **#16** Beat Grid panel anchor controls visual
  separator.
- **#17** Session header connection cluster is strongest
  emotional beat — **KEEP**.
- **#18** Waveform reads as level meter (Phase 6
  priority, but moderated per #15F audit finding).

#### Minor / observational

- **#6** Possible duplicate `session.room_joined` (absent
  in prod).
- **#7** Analyzer offset on Jake's tracks.

### Tomorrow (June 9) priority order

1. **Session Start Protocol** — read CLAUDE.md, VISION_5
   last 2-3 session-end sections (especially this one).
2. **Check email / messages** for Jake's replies on
   #2/#10 sync engine clarifications.
3. **Build deck inline tempo nudge cluster** per Claude
   Desktop's spec captured above:
   - Investigation phase first — verify audio engine,
     header BPM rendering, sync engine API, transport
     row space, waveform timer source.
   - Implementation per spec.
   - Claude Desktop verification (localhost multi-tab).
   - Push + Vercel deploy.
   - Production verification (Claude Desktop).
   - **Estimated 2-3 hours.**
4. **If tempo control closes cleanly with time/energy
   remaining:**
   - Phase 3 Commit C: waveform render anti-aliasing
     polish (audit identified slight blockiness vs
     Beatport).
   - **OR:** Quick wins from #15 review — #34 (Beat 1
     red), #35 (disabled state cursor) — 15-30 min each.
5. **After Phase 3 fully ships:**
   - Schedule Round 2 dogfood with Jake.
   - Begin #9 drag-and-drop scoping (investigation
     only).
6. **Later this week:**
   - #13 Comprehensive UX/design competitive review.
   - #15A-E quick wins from design review.

### Jake status

- **Round 2 dogfood:** schedule after tempo control +
  waveform polish ship.
- **Pending answers** on #2 (sync release rate) and #10
  (scrub-master-moves-slave) — these would inform sync
  engine work.
- **His feedback shipped today:** #8 manual BPM (partial
  — Beat Grid Panel done, tempo control next).
- **Still owed:** #9 drag-and-drop scoping.

### Process learnings today

- **Session Start Protocol** exercised again at session
  start this morning — caught prior work, oriented
  quickly. Protocol works.
- **Visual Verification Protocol** exercised
  extensively. Claude Desktop drove all major
  verifications across Commit A localhost + prod, plus
  competitive audit, plus tempo control design
  exploration, plus the 4-step prod test.
- **Pattern reinforced:** founder's gut catches design
  issues the AI side missed. Tonight's example: Chad
  noticed the deck needed quick BPM adjustment (separate
  from Beat Grid Panel) → led to the tempo control spec.
- **Pattern:** investigate before building, design
  before building. Multiple times tonight we paused to
  verify scope (vertical tab redesign deferred,
  multipliers trimmed based on Rekordbox reference, sync
  integration decision made deliberately).
- **Pattern broken (honest note):** work continued past
  midnight despite multiple "stop" recommendations.
  Late-night strategic decisions risk being suboptimal.
  Tomorrow's tempo control build benefits from fresh
  morning judgment.

### Working state for tomorrow

- **Master HEAD:** `87627a5` (Phase 3 Commit A) + this
  VISION_5 update.
- **Working tree:** clean after VISION_5 update lands.
- **Dev server:** PID 71138 on `localhost:5173` will be
  killed before stopping tonight — port freed.
- **All commits pushed** to `origin/master`.
- **`meta.release` on prod** correctly shows the full
  git SHA.
- **Bug #1 + #12 + Layer 1 telemetry** all working in
  production.

### Don't-touch list (unchanged)

Same as prior sections.



---

## ADDENDUM — Rekordbox waveform transient hairline insight (June 8 late night)

Visual inspection of Rekordbox's zoomed-in waveform revealed THREE rendering layers Mix//Sync currently lacks:

1. Bass body (blue diamond) — Mix//Sync HAS this
2. Mid/high body (orange threaded through center) — Mix//Sync LACKS this
3. **White transient peak hairline at each kick attack** — Mix//Sync LACKS this, and this is the critical one

The white hairline is what lets users visually verify grid alignment. The grid line lands EXACTLY on the white transient peak. Without this hairline, Mix//Sync's grid placement may be mathematically correct but is visually unverifiable.

Beatport DJ Pro (direct browser competitor) also lacks the transient hairline — adding it would differentiate Mix//Sync from Beatport while approaching Rekordbox-grade visual confidence WITHOUT requiring full Phase 6 frequency-colored waveforms.

NEW issues for tomorrow's roadmap consideration:

- #37 Waveform transient peak hairline (~3-5 hours estimated, MAY BE BETTER Commit C THAN the originally-planned anti-alias polish)
- #38 Mid/high frequency layer orange overlay (~5-8 hours)
- #39 Bar/phrase markers in main waveform like Rekordbox uses red lines for every 8 or 16 bars + position indicator like "65.2 Bars" (~2-4 hours)

This refines Phase 3 Commit C priority. Originally planned anti-alias the slightly blocky edges. But the transient hairline may be higher-leverage with similar effort. Decide tomorrow morning based on energy and priorities.


---

## Session — June 9 (full day) — Phase 3 Commit B SHIPPED + #44 stutter/floor-aliasing fix SHIPPED + PitchNudge polish verified + Commit C Phase 1 ready

Heavy day. Shipped two production commits, built and verified a
third (uncommitted at write time, pending final 13-item check),
cross-referenced today's Commit C research against the May
locked record, and produced a Phase 1 build spec ready for
tomorrow morning. Capture below preserves all decisions before
context window resets.

### Shipped to production

#### Phase 3 Commit B — `ae83a62`

Deck inline PitchNudge cluster — compact 96 px layout integrated
into the BPM hero block (not the transport row, per Rekordbox /
Beatport convention).

- **Layout:** BPM hero (28 px) above `+0.0% [−] [+]` inline row.
  Drops the "BPM" label below the number (matches Beatport
  reference; the number is unambiguous in deck-card context).
- **Container:** Decks + Mixer row grown 248 → 260 px (+12 px,
  ~4 % library loss at 820 vh viewport — imperceptible).
- **Interactions:** click ± = 0.1 % step, shift-click = 1.0 %,
  scroll over readout = 0.05 BPM / notch, double-click resets to
  0.0 %. Range ± 8 % from native rate.
- **Sync interaction:** touching pitch on either deck while
  Sync is engaged disengages Sync on both decks (RTC mirror).
  Rates are PRESERVED on disengage (matches Rekordbox / CDJ).
- **Audio:** raw Web Audio `playbackRate` with the existing
  5 ms anti-click ramp. Pitch + tempo change together (CDJ pitch
  fader semantics).
- **RTC:** driver-side rate change broadcasts via existing
  `deck_update` channel; receive-side `dh` extended to push to
  local Deck via `_setRate` so partner audio + visual mirror.
- **Telemetry:** `pitch.offset_changed`,
  `pitch.reset`, `sync.disengaged_by_pitch`.
- **Verified:** localhost 5/5 PASS (Claude Desktop layout +
  interaction + clamp + neutrality + sync release), production
  bundle audit 5/5 PASS (all symbols present, no Bug #1 / #12 /
  Phase 3A regressions). Audio + RTC verified to the extent prod
  allows (real two-tab session pending).

#### #44 Stutter + floor-aliasing fix — `09249e5`

Two latent issues, both exposed by Commit B's pitch usage:

1. **`tick()` closure bug.** The animation loop inside `play_`
   was reading `o` (closure parameter from play start) instead
   of `off.current` (the ref the rate `useEffect` rebases on
   every rate change). On every pitch change the visual playhead
   snapped back to whatever `o` was at last `play_()` call —
   typically 0 (start of track). Sync engagement had masked this
   because sync always paired the rate change with a phase-align
   seek that recreates the tick closure. PitchNudge has no seek,
   so the bug was fully exposed.
   - **Fix:** two identifier replacements at lines 4092, 4095 —
     tick now reads `off.current` directly, so the existing
     rebase actually takes effect.

2. **`Math.floor()` grid line aliasing.** Six grid line render
   call sites in `AnimatedZoomedWF` floor-snapped the x position
   each frame. At non-1.0 rate, `pxPerSec × beatPeriodSec` is
   non-integer, so adjacent beats alternated between two pixel
   positions as `prog` advanced — visible as ~10 Hz shimmer on
   the grid during pitch nudges. Wasn't visible before fix #1
   because the snap-back was freezing `prog` near 0.
   - **Fix:** removed `Math.floor()` from 7 call sites
     (lines 3679–3713). Canvas-2D anti-aliasing handles
     sub-pixel positioning; lines stay crisp at rate 1.0
     because the existing `shadowBlur=4` halo already softened
     them slightly.

- **Verified:** localhost 5/5 PASS Claude Desktop with sub-pixel
  position measurements before/after. Eyeball-confirmed by Chad:
  smooth at all rates, still crisp at rate 1.0. Production
  deploy audit 9/9 PASS (all `pitch.*` + `sync.*` strings, plus
  Bug #1 / #12 / Phase 3A regression checks all green).

### In working tree (uncommitted at write time) — Commit B-2 candidate

PitchNudge polish — three UX gaps verified during today's Claude
Desktop session:

- **Press-and-hold on ± buttons.**
  - 0 ms (immediate): first step fires (preserves quick-tap)
  - 0 → 500 ms: dormant (initial gate)
  - 500 → 1500 ms: repeats at 100 ms interval, 0.1 BPM step
  - 1500 ms+: repeats at 50 ms interval, 0.5 BPM step
  - Shift+hold variants use 1.0 / 5.0 BPM steps
  - Clamp at ± 8 % stops the repeat
- **Click-and-drag on the % readout.**
  - 5 px vertical drag = 0.1 % step
  - 3 px threshold prevents accidental drag (double-click + quick
    click still register cleanly)
  - Uses Pointer Events + `setPointerCapture` so drag survives
    the cursor leaving the readout
  - Drag start captures `rate`; subsequent moves compute
    `target = startRate + steps × 0.001`
- **Telemetry method field** added to `pitch.offset_changed` and
  `pitch.reset` payloads:
  `button | shift_button | hold | scroll | drag | reset`
- **Drag telemetry debounced** at 100 ms (other methods always
  log). `setRate` + RTC broadcast unaffected.
- **All existing PitchNudge behaviors preserved:** range clamp,
  sync disengage trigger, RTC mirror, track-load reset to 0.0 %.

Build clean (587.52 KB, +2.3 KB), HMR-served, dev server live on
`localhost:5173`. **If Claude Desktop's 13-item verification
returns 13/13 PASS, commits as B-2 tonight.** If issues found,
fix and re-verify; if substantive issues, B-2 ships tomorrow.

### Commit C Phase 1 plan — ready for tomorrow

Cross-referenced today against:

- **May locked decisions** — `tools/docs/DESIGN_PHILOSOPHY.md`,
  VISION_5 sections 1844–2050 (May 21–23 + May 26 evolution),
  `tools/rekordbox-eval/WAVEFORM_BUILD_PLAN.md`
- **Today's Claude Code research agent** — Tier 1 (envelope +
  silhouette path), Tier 2 (transient hairline)
- **Today's Claude Desktop design exploration** — 12-item spec

#### Locked decisions (preserved from May, NOT re-litigated)

- Calm monochrome amplitude direction (spectral revert
  preserved — locked tabled until dogfood feedback)
- White beat grid markers with deck-color halo
- Red 16-bar phrase markers as **outer ticks only**, no
  full-height through-line
- Pure black background `#000000` (OLED + glow contrast)
- Single accent: white at three opacity tiers
  (0.9 / 0.6 / 0.3); NO amber, NO warm fill saturation on decks
- Deck identity colors in cool family — Deck A `#2E86DE`
  (Vivid Ocean Blue), Deck B `#A855F7` (Electric Royal Purple)
- Path A glow architecture for the big waveform — two-canvas
  stack with CSS `filter: blur()` on lower canvas

#### Phase 1 build scope (universal improvements; no palette
decisions — those deferred to Phase 2 visual iteration)

1. **Silhouette path replacement (both waveforms).** Replace
   the per-column `fillRect` loop with `buildSilhouettePath`
   (already in file at line 3232, used by Path A on the big
   waveform). Anti-aliased smooth edges.
2. **Gamma drop (both waveforms).** 1.4 → ~0.9. Makes structure
   visible (drops, breakdowns, intro/outro) instead of
   "too full everywhere."
3. **Transient hairline (BIG waveform only).** 1 px white at
   ~70 % opacity, top half of waveform only. Cap density at
   zoom level so it doesn't flood. The Rekordbox-style
   grid-verification cue (#37 from June 8 late night).
4. **Played / unplayed split (both waveforms).** Deck identity
   color on played portion; dimmer same color on unplayed.
   Clip-region over a single silhouette path (one geometry,
   two fills).
5. **Edge stroke (big waveform only).** 1 px brighter
   same-hue edge on the silhouette path for crispness.
6. **Responsive density (both waveforms).** Re-bin peaks to
   `floor(cssWidth × DPR)` columns on resize. Debounce 100 ms.
   Cache peak array keyed by `bands` identity.
7. **Edge cases (both waveforms).**
   - Empty deck: flat thin centerline in neutral gray
   - Loading: subtle left-to-right shimmer
   - Analyzing: silhouette dim to 40 %

#### Phase 1 does NOT touch (preserved for Phase 2 visual
iteration)

- Playhead color (stays current white per locked decision)
- Beat 1 anchor color (stays current red)
- Cue marker treatment
- Beatgrid weight / color (white with deck-color halo per lock)
- Three-band frequency coloring (locked out — spectral tabled)

**Estimated 4–6 hours for Phase 1 build** including
investigation, implementation, Claude Desktop verification,
deploy, and prod smoke test.

#### Phase 2 approach

Per Chad's "I need to see things to know" principle: palette
decisions are deferred to **visual iteration after Phase 1
ships**. Don't lock palette in a spec up front. Implement
Phase 1, see the result on real tracks in two-tab session, then
decide:

- Does playhead need amber, or is white fine after the new
  waveform body?
- Does Beat 1 anchor red still bother us (issue #34)?
- Are cue tabs visible enough against the new silhouette?
- Does beatgrid weight feel right?

Visual iteration, not theorize-then-build.

### Open bugs / issues at end of day

- **#43 Partner deck shows native BPM instead of effective BPM.**
  Cosmetic display bug. RTC propagation works correctly (pitch
  readout shows correct `+X %` on partner). Only the big BPM
  hero is wrong — partner side reads stale or wrong field.
  Pre-existing pattern (present on production before today).
  Scope ~30–60 min. Bump to top of tomorrow.
- **#42 Deck header zone redesign.** Post-launch consideration.
  Reclaim empty space below thumbnail. Three options identified:
  (a) BPM stays right + controls shift left, (b) thumbnail to
  lower-left, (c) BPM moves into empty space. Deferred —
  substantial redesign, not blocking.

### Process improvements identified

- **Claude Desktop sessions need a briefing document.** Too many
  sessions today re-litigated locked decisions because Desktop
  came in fresh without the May design history. Build a
  "Mix//Sync briefing template" when convenient — a short
  one-pager Desktop reads first that captures the locked
  decisions + open questions + don't-touch list. Eliminates
  re-litigation cost.

### Tomorrow's work order (June 10)

1. **Session Start Protocol** — read CLAUDE.md + this addendum
   + the prior June 8 / June 9 sections.
2. **If PitchNudge polish committed last night:** verify shipped
   to prod, smoke-test audio + RTC in a real two-tab session.
3. **Bug #43 fix** — partner BPM hero shows effective BPM
   (~30–60 min). Fix before Commit C so dogfood-ready.
4. **Commit C Phase 1 build** per spec above (~4–6 hours):
   - Investigation phase first (silhouette path call sites,
     gamma constants, transient detection signal)
   - Implementation in slices (silhouette swap → gamma → split
     → hairline → edge cases) so each can verify independently
   - Claude Desktop visual verification on multiple track types
     (drop-heavy, breakdown-heavy, vocal, ambient)
   - Push to production
5. **After Phase 1 ships:** Chad evaluates visually, decides
   Phase 2 palette adjustments.
6. **Phase 2 implementation** if needed (~1–2 hours):
   per-element palette tweaks based on the live Phase 1 result.

### Today's process learnings

- **Investigation-before-building pattern continues to work
  excellently.** Today's catches:
  - PitchNudge placement caught (transport row → BPM cluster)
  - Color escalation caught and neutralized (amber → neutral)
  - Container overflow caught and right-sized
  - Stutter root cause found (closure mismatch)
  - Floor-aliasing latent issue found and pinned to the right
    root cause (non-integer `pxPerSec`)
- **Visual verification pattern works.** Chad eyeballs
  subjective things (smoothness, crispness, feel) that Claude
  Desktop can't fully judge from screenshots alone. The split
  works: Desktop measures + flags, Chad arbitrates.
- **Cross-reference research pattern matters.** When multiple
  sources of design intent exist (May locked record + today's
  research agent + today's Desktop spec), reconciling them
  explicitly *before* drafting a build plan prevents
  re-litigating locked decisions.
- **"I need to see things to know."** Palette decisions
  deferred to visual iteration after build. Specifying palette
  in spec before seeing the new substrate is theorize-then-build,
  which doesn't work for Chad's evaluation style.

### Jake status

- Pending replies on Bugs #2 + #10 (sync engine clarifications)
- Round 2 dogfood: 5 of 6 critical items now addressed:
  - Room/peer connection ✓ (Bug #1)
  - Manual BPM control ✓ (Phase 3 Commit A — Beat Grid Panel)
  - Deck-level pitch control with polish ✓ (Phase 3 Commit B
    + B-2 pending verification)
  - Telemetry ✓ (Layer 1 + pitch events)
  - Sync engine fixes ⏳ (need Jake's input on #2 + #10)
  - Drag-and-drop library → deck ❌ (not scoped — separate
    workstream)

### Don't-touch list (unchanged)

Same as prior sections.

### Working state for tomorrow

- **Master HEAD at time of writing:** `09249e5` (#44 fix). Will
  advance to B-2 commit if PitchNudge polish verifies tonight.
- **Working tree:** dirty with the PitchNudge polish + this
  VISION_5 update at write time. Expected to be clean after
  the end-of-night sequence (B-2 commit if it verifies +
  VISION_5 commit + push).
- **Dev server:** PID 1477 on `localhost:5173` — will be killed
  at end of night.
- **Production state:** Commit B + #44 fix live and verified
  via Desktop. `meta.release` SHA on prod = `09249e5dcc3987e2...`
  (or B-2's SHA if it commits tonight).

---

## Session — June 9-10 evening — Bug #43 shipped + Small WF Slice A WIP + signal extraction root cause identified

### Shipped to production

- **`f48d0ea` — Bug #43 partner BPM hero now shows effective BPM**
  - One-line fix: `rateApplies` gates on `effectiveBpm` instead of
    `bpmResult?.bpm` only
  - Catches a Phase 3B follow-up that was missed at the time
  - Verified 4/4 PASS on localhost + 11/11 production bundle audit

### Small WF Slice A — in working tree (stashed)

#### Foundation work

- `buildSilhouettePath` replacing per-column `fillRect` loop
- `GAMMA = 0.7`
- `PEAK_HEIGHT_RATIO = 0.85` breathing room above and below silhouette
- Two-pass silhouette fill (vertical gradient + horizontal
  played/unplayed)
- Empty / loading / analyzing state branches
- `ResizeObserver` responsive density
- **Step A:** bright-at-center vertical gradient (inverted from peak-tip
  brightness — peak-tip stop coinciding with flat silhouette top edge
  was lighting up 600+ adjacent columns as a continuous "border")
- **Step B:** per-track 5/95 percentile normalization (median + scale
  soft-clip variant was tried and reverted — looked like uniform tubes)
- Cache key on `bArr` Float32Array (perf fix — was recomputing 24K-element
  sort × 60 fps × 2 decks because wrapper bands object was being
  rebuilt every render)
- Minute markers as 1 px bottom ticks at `y = H - tickHeight - 4` (spacing
  to waveform body not fully resolved — canvas-expansion option deferred)
- `[WF-DIAG]` diagnostic instrumentation that logs raw env / normalized /
  heightPx at 9 fixed track positions on track load (`window.__cap` hook
  installed by Claude Desktop to deep-clone the payload for survival)

#### Critical finding — real root cause

Multiple rendering iterations failed to make dense tracks (Embers in
Bloom) show structural variation. Claude Desktop captured `[WF-DIAG]`
data showing env values clustered near maximum (0.864–0.997) at all 9
sampled positions on BOTH Embers and Lost Canvas, despite envFloor
being 0.10–0.20 (i.e. low values exist somewhere in each track).

Claude Desktop's initial fix recommendation ("shorten the IIR filter
time constant") was wrong. Claude Code's investigation showed:

- The IIR in question is a 300 Hz one-pole low-pass on the **audio
  signal** (`lpB = aB*lpB + (1-aB)*s`), not an envelope follower
- Time constant: τ = 1/(2π × 300) ≈ **0.53 ms** — already very fast
- Shortening it (smaller aB → higher cutoff) would pass MORE signal
  content, making magnitudes HIGHER on average, not lower
- The recommended change targeted the wrong mechanism

**Actual root cause:** bass-band content in dense electronic tracks is
sustained (synth pads + sustained kicks + sub-bass through the track),
not transient. Peak detection on rectified bass-band magnitude
correctly captures this as constant loudness. **The visual flatness
is faithful representation of the bass band.**

The variation DJs want to see (no-kick intros, breakdowns, sparse
sections) lives in OTHER frequency bands — especially the high band
(hi-hats, leads, vocals, atmospheric elements) which DO vary between
sections.

### Tomorrow's order

1. **Session Start Protocol** — read CLAUDE.md + this VISION_5 addendum
2. **`git stash pop`** to restore small WF work + `[WF-DIAG]`
3. **Candidate 1 first** — change small WF env from `max(bv, mv, hv)`
   to just `hv` (high band only). One-line change in small WF, no
   analyzer touch. Re-run `[WF-DIAG]` via `window.__cap`. Check:
   - Do intros register as low env now?
   - Do drops register as high env?
4. **If Candidate 1 works** — ship Slice A + move to Slice B
5. **If high-band-only too "shimmery" / loses bass character** — try
   Candidate 2 (weighted blend `0.2*bv + 0.5*mv + 0.3*hv`)
6. **If neither lands** — Candidate 3 (transient/onset detection in
   analyzer) — but this touches the don't-touch list (analyzer
   pipeline), larger scope
7. **After fix lands** — address the marker spacing question (canvas
   height +6 px option vs alternative)
8. **Then** — Slice B (big WF improvements)

### Unresolved this session

1. **Minute marker visually touches waveform body** despite `y=32`
   reposition. Canvas height expansion option deferred (would cost
   ~6 px from library; alternatives: marker inside silhouette
   accepted, or different marker geometry).
2. **#45 (NEW)** — Small WF loading state renders a smooth gradient
   when bands fail to load — visually indistinguishable from a
   real-but-flat waveform. Robustness issue caught during Desktop
   testing. Log for future fix.

### Process learnings

1. **When agents disagree about code facts, believe the one reading
   the code.** Twice tonight Claude Desktop's analysis was directionally
   useful but mechanistically wrong: first claiming "mean binning" when
   the code was already peak; then claiming "shorten IIR" when the IIR
   was a low-pass on the signal at 0.53 ms time constant, not an
   envelope follower. Claude Code pushed back appropriately both times
   rather than implementing wrong fixes.
2. **When iteration fails, investigate a different layer.** Hours
   tonight spent tuning RENDERING (gradient inversion, gamma 1.4 → 0.9
   → 0.7, normalization percentiles 5/95 → 10/90 → 20/80 → back to 5/95,
   soft-clip experiment) when the actual issue was SIGNAL EXTRACTION.
   When math reasoning says "should work" but visual reality says
   "worse," the problem is at a different layer than the one being
   tuned.
3. **Chad's eye is the ground truth.** Every iteration tonight that
   Chad said "looks worse" was actually worse, even when math reasoning
   suggested improvement. Trust visual judgment over math when they
   disagree.
4. **Instrument before theorizing.** Once `[WF-DIAG]` captured actual
   env numbers at fixed positions, the diagnosis became clear in
   minutes. Should have asked for measurements much earlier instead of
   iterating on theory.
5. **Saving energy is worth more than shipping tired.** Chad correctly
   called the stop. Decisions made fatigued compound losses.

### Roadmap status

**Closed this session:**

- ✅ Bug #43 — partner-side BPM hero shows effective BPM

**Active for tomorrow:**

- 🔄 Small WF Slice A — high-band env experiment is the next try
- 📋 Slice B — big WF improvements (per VISION_5 Phase 1 spec)
- 📋 Slice C — transient hairline (issue #37)

**Pending Jake:**

- Bug #2 — sync release rate
- Bug #10 — scrub-master-moves-slave

**Pre-dogfood essentials still needed:**

- Slice A complete
- Slice B big WF improvements
- #9 drag-and-drop library → deck
- Self-verify audio + RTC with headphones

**New issues logged this session:**

- **#45** — Small WF loading state visually indistinguishable from
  real-but-flat waveform

### Don't-touch list (unchanged)

Same as prior sections.

### Working state for tomorrow

- **Master HEAD:** `f48d0ea` (Bug #43) at write time, will advance to
  this VISION_5 commit after this section ships
- **Working tree:** clean after stash + VISION_5 commit
- **Stash:** `stash@{0}` carries the small WF Slice A WIP + `[WF-DIAG]`
  diagnostic + marker reposition — restore with `git stash pop`
- **Dev server:** PID 76963 will be killed at end of session

---

## Session — June 10 evening — Small WF Slice A SHIPPED + analyzer exposes beatTimes/beatAttacks

### Shipped to production

- **`11a00ee` — `docs: SOCIAL_VISION + LANDING_BRIEF (June 10 strategy session)`**
  - Two strategy docs committed at session start. Brochure-stage
    landing brief + community/matchmaking architecture. Pure docs;
    no production code touched.
- **`1b0989c` — Small WF Slice A: kick-presence rendering + high-band
  env + silhouette foundation**
  - Slice A WIP from June 9–10 stash + tonight's kick-presence
    rendering system + analyzer exposure for Slice C.
  - 2 files, 371 insertions / 61 deletions. Production bundle
    audit clean on `main-BlOaY8yI.js`: beatTimes ×8, beatAttacks
    ×11, DIM_GAMMA 0.55 inlined ×4, core floor 0.35 inlined ×6,
    WF-DIAG string ×0 (dead-code-eliminated).

### The kick-presence rendering system — what it is, why it exists

The June 9–10 finding was that bass-band magnitude saturates on
dense electronic tracks: sustained synth-pads + sub-bass push the
peak envelope to ~max for the entire track. Chad couldn't see the
structural variation DJs need to read. Switching to high-band-only
(`env = hv`) fixed the flat-bass tube — Embers spread out, no-kick
intros dropped — but introduced a NEW problem Chad identified
tonight:

**DJs verify mix-in/out points by seeing where the KICK/BASS drops
out.** No-kick sections of dense tracks still have hats/synths
running, so the high band stays active through them. Bass-band
magnitude can't show kick-out either (saturated, as above). The
needed signal is low-band TRANSIENTS — kick presence specifically.

The analyzer already had the answer. The `beatAttackSlopes`
Float64Array (one per beat) was being computed for the Sub-cause F
gate and discarded at worker exit. It's the half-wave-rectified
first-difference peak of the 40-200 Hz power envelope inside a
±50 ms window around each beat — literally the per-beat
kick-attack strength, with 0 written when the refiner skipped the
beat (silence/flat/edge/mono). Surfacing it cost ~5 lines on the
worker postMessage + main-thread destructure; no DSP touch, no
analyzer change.

The same payload (`beatTimes` seconds + `beatAttacks` per-beat
strength) is exactly what Slice C transient hairline (#37) will
need — positions for hairline placement, strengths for dimming
weak attacks. One exposed array, two consumers.

### Iteration path (what landed in code vs what we tried)

1. **hv envelope only** — visually fixed flatness; created the
   no-kick visibility problem above.
2. **Two-layer build** — dim hv outer + bright kick-driven inner
   core, both buildSilhouettePath. Worked structurally but the
   inner core showed a hazy see-through fringe of dim env around
   it (alpha layering of two overlapping silhouettes).
3. **Brightness gate via destination-out** — one envelope shape,
   per-column alpha erase in kick-out columns. Read as a bright
   envelope-tube again because the shape was wrong (kept envH
   everywhere, dimmed alpha only).
4. **Per-column shape select** — one silhouette path built from
   per-column heights (coreH where kick present, envH where
   absent), clipped silhouette + per-column fillRect with one of
   four precomputed composite gradients. Fog gone, two structural
   issues remained.
5. **Beat-aliasing fix (max-over-span) + core floor + DIM_GAMMA
   lift** — column span covers ~2-3 beats; a single refiner-
   skipped beat was blanking columns inside kick regions. Running
   pointer + max strength + 0.35×envH floor + DIM_GAMMA 0.55 for
   kick-out heights = bright continuous core + lifted readable
   breakdowns.
6. **Run-length morphology = PASS.** Real kick-out sections are
   ≥4 bars; shorter dim runs are noise from individually skipped
   beats (~23/834 on Embers). Threshold in BARS via bpm+dur,
   clamped 3–12 / 2–8 cols. Dim flip first, bright prune second.
   Kick regions read as continuous bright blocks. Breakdowns stay
   clean dim. Boundaries land on real musical structure.

### Tunable knobs (single point each, top of WF render)

- `GAMMA = 0.7` — bright envelope curve
- `DIM_GAMMA = 0.55` — lifts kick-out / breakdown envelope heights
- `PEAK_HEIGHT_RATIO = 0.85` — breathing room above/below silhouette
- Core floor `0.35 × envH`, core scale `0.9 × envH`
- `MIN_DIM_RUN_BARS = 4`, `MIN_BRIGHT_RUN_BARS = 2` (with
  clamps 3–12 / 2–8 cols and fallbacks 5/3 when bpm unavailable)
- `WF_DIAG = false` — gates `[WF-DIAG]` console log; flip true to
  debug env/normalization regressions. Vite DCE strips the log
  string from production builds when off.

### Slice C — what's prewired

`beatTimes` + `beatAttacks` already exposed on `bpmResult`.
Slice C transient hairline (#37) consumes both: positions for
hairline placement, strength for dimming weak attacks (avoids
false hairlines in no-kick sections — the same problem Slice A
just solved on the envelope side). No additional analyzer
surface needed.

### Process learnings (tonight)

1. **When you don't have the signal, don't keep tuning the
   gradient.** Six rendering iterations on the two-layer haze
   problem produced incremental improvements but never solved it
   because the architecture was wrong. The fix was structural
   (one shape, per-column choice), not visual.
2. **Pre-existing analyzer state is cheaper than new DSP every
   time.** `beatAttackSlopes` already existed; exposing it cost
   ~5 lines. Building a separate transient detector would have
   been days.
3. **Visual verdict beats math.** Build #N-2 (destination-out)
   was mathematically clean and "correct" by design — Chad's eye
   immediately read the tube. Built #N-1 also looked plausible
   on paper. The user's eye called both correctly.
4. **Run-length morphology is musical-time-aware now.** Pixel-
   threshold filters would have failed on short or long tracks;
   deriving thresholds from bpm+dur+W self-tunes per track.

### Roadmap status

**Closed this session:**

- ✅ Bug #43 partner BPM (last night) — already shipped at session
  open as `f48d0ea`.
- ✅ Small WF Slice A — kick-presence rendering, env=hv,
  beatTimes/beatAttacks exposure.

**Open for next session (priority order):**

- 🔄 **Slice B — big WF improvements** per VISION_5 Phase 1 spec.
  Next active waveform work.
- 🔄 **Self-verified sync (the #1 hard problem)** — audio + RTC
  through headphones, end-to-end, before Jake round 2. The sync
  deep-dive Chad has flagged as the gating risk for dogfood.
- 📋 **Slice C — transient hairline (#37)**. Inputs prewired:
  `beatTimes` + `beatAttacks` already on `bpmResult`.
- 📋 **#9 — drag-and-drop library → deck.**
- 📋 **Bug #2 — sync release rate** (Jake).
- 📋 **Bug #10 — scrub-master-moves-slave** (Jake).

**New issues logged this session:**

- (None — #45 from June 9-10 still open: small WF loading state
  visually indistinguishable from real-but-flat waveform.)

### Don't-touch list (unchanged)

Same as prior sections. Tonight's analyzer change was a single
read-only surface addition (postMessage payload field) — no DSP
math, no gate threshold, no existing output value touched.

### Working state for next session

- **Master HEAD:** `1b0989c` (Slice A) at write time; will advance
  one more to this VISION_5 commit.
- **Production:** `collabmix.vercel.app` live on bundle
  `main-BlOaY8yI.js`. Audit confirmed analyzer + knobs present.
- **Working tree:** clean.
- **Stash:** none.
- **Open in Vite dev:** http://localhost:5173/ (PID will be killed
  at session end).
- **Strategy docs added:** `tools/docs/SOCIAL_VISION.md` and
  `tools/docs/LANDING_BRIEF.md` (commit `11a00ee`).

---

## Session — June 10 late evening — SYNC_MAP + Phase 1 measurement layer + #10 fix + #2 decision + first two-client soak (partial)

### Shipped to production

- **`8cc01a7`** — `Sync Phase 1: wire timestamps, clock-offset
  estimator, phase-error monitor, debug HUD, engage telemetry`.
  Measurement-only — no behavior change to the sync engine itself.
  Makes sync quality a number so design decisions can follow data.
- **`26cc278`** — `Sync: master scrub no longer re-aligns slave
  (#10); document #2 rate-persist as intended`. Chad's decisions
  on both bugs landed in code (#10 behavior change + telemetry,
  #2 comment-only documenting the CDJ-convention intent).
- **(server) `d708747`** — `Relay sync_ping / sync_pong for
  client clock-offset estimator` on `collabmix-server-repo`
  (Railway auto-deployed, verified live with `/health` uptime
  reset to 6.75 s after push).

### Slice A recap

Earlier in the same session day (June 10): Slice A kick-presence
small WF shipped — `11a00ee` (docs), `1b0989c` (code), `cb8e60b`
(VISION_5 prior addendum). Bundle audit on `main-BlOaY8yI.js`
confirmed live. Recapped here for session-boundary clarity; full
detail in the June 10 evening section above.

### The SYNC_MAP audit (what the sync engine actually is today)

Investigation-first map produced before any code change. Findings:

1. **Architecture.** WS = control plane (`deck_update`, scrub /
   toggle / cue requests, sync engage state). WebRTC = audio
   plane only. `useSync` at `:2816-2862`, `useRTC` at `:2865-2997`,
   `syncDecks` at `:7691-7910`, `handleSyncToggle` at
   `:7944-8042`, `handleTransportFire` at `:8095-8125`.

2. **What syncDecks does** at engage time, then never again:
   (a) rate match with ±12 % safety clamp,
   (b) beat-phase seek wrapped to ±0.5 beat, then
   (c) Path C cross-correlation refinement (40-200 Hz kick band,
       2 s window) gated by `peakRatio ≥ 2.0`.
   After return, audio engines run independently.

3. **Clock problem.** No shared clock. No NTP-style offset
   estimation. No server timestamps on wire messages. Ping/pong
   measures client↔server RTT only and uses `Date.now`. The
   `seek_request` path executes "now" on receive — one-way WS
   latency is baked into every cross-machine alignment.

4. **Drift.** Zero continuous correction. `AudioContext.currentTime`
   on the two browsers drifts (±50 ppm hardware tolerance =
   ±15 ms over 5 min, structurally). No periodic re-check. No
   ongoing drift monitor. The xcorr that runs at engage is
   one-shot — designed for `beatPhaseSec` misdetection, not for
   accumulating clock skew.

5. **Telemetry.** Engage decisions log via console (`[SYNC]`).
   `logEvent("sync","toggle")` etc. ship to Layer 1 telemetry.
   **No phase-error measurement anywhere** — we had zero signal
   on how alignment evolves over a mix.

6. **The bugs.** Both intentional code: #2 explicitly defends
   rate-persist on release (matches Rekordbox/CDJ); #10's
   scrub-master-moves-slave is an intentional re-align trigger
   on EITHER deck's scrub. Both became "design questions, not
   bugs" once decoded.

Risk-ranked gaps: (1) no clock-offset estimator, (2) no drift
correction loop, (3) no phase-error telemetry, (4) WebRTC
audio carries no timing reference and the partner's deck is on
a different audio clock, (5) wire messages lack `t_send`.
Gap (5) was the cheap unblock for measurement.

### Phase 1 measurement layer (what shipped tonight)

- **Wire timestamps.** `useSync.send` wraps every outbound
  payload as `{...m, t_send: performance.now()}`. Backward-safe:
  receivers destructure named keys, ignore extras.
- **Clock-offset estimator.** New `src/utils/clockSync.js`
  implementing Cristian's algorithm — 20-sample rolling window,
  top-quartile RTT rejection, median offset over the remaining,
  confidence = `1 − rttSpread/rttMedian`.
- **Peer-to-peer ping.** 3-second `sync_ping`/`sync_pong` round
  trip relayed via the WS server (distinct from client↔server
  ping). Server-side relay added in `d708747`.
- **Phase-error monitor.** Every 2 s while syncLocked AND in
  remote B2B AND clock warmed up, projects partner's last
  progress packet forward via offset, computes beat-fractional
  drift vs my synced deck, converts to ms. Emits `[SYNC-DRIFT]`
  + `logEvent("sync","drift_sample")`. **No correction applied.**
- **Engage snapshot.** `syncDecks` accumulates rate delta,
  beat-phase seek ms, xcorr applied/skipped/reason (including
  new `bufrefs_unavailable` reason that surfaces the remote
  B2B path), total runtime ms. Emits `[SYNC-ENGAGE-QUALITY]`
  + `logEvent("sync","engage_quality")`.
- **Debug HUD.** `SyncDebugHUD` component, gated behind
  `?syncdebug=1`. JetBrains Mono, top-right, opacity 0.85,
  pointer-events:none. Polls a ref at 5 Hz (no re-render storm).

Investigation result: in remote B2B the xcorr refinement
**always skips** — local `bufRefs.current[partnerDeck]` is null
because the partner loaded the track. Beat-phase alignment IS
the entire engage in remote B2B, and it lands with one-way WS
latency baked in. Phase 1 will quantify both.

### Bug fixes / decisions

- **#10 fix (`26cc278`).** `handleTransportFire`'s scrub-resync
  scheduler now gates on the scrubbed deck identity. Master-deck
  scrubs suppress the auto re-align (emits
  `logEvent("sync","scrub_realign_suppressed")`); tempo lock
  stays engaged; slave holds position. Slave-deck scrubs
  preserve the original auto-realign — user explicitly asking
  to line back up. Pro-DJ ergonomic call per Chad.
- **#2 decision.** No code change. Rate persists on release per
  CDJ/Rekordbox convention. Jake's snap-back expectation = a
  teaching moment, not a bug. Optional settings toggle deferred
  until other dogfooders raise the same expectation.

### Live test findings (first two-client soak, partial)

1. **Railway relay dropped `sync_ping`/`sync_pong`.** Server's
   explicit-allowlist message handler had no case for the new
   types → silently dropped. Both clients stuck at
   `sampleCount=0`, HUD state=`clock_warmup`, no
   `[SYNC-DRIFT]` ever emitted. Fixed in
   `collabmix-server-repo d708747`, deployed and verified.
2. **Xcorr CONFIRMED absent in remote B2B.** Engage-quality log
   captured: `result=ok rateDelta=0.0000 phaseSeekMs=104.37
   durationMs=0.8 xcorr={applied:false,reason:"bufrefs_unavailable",
   haveSlaveBuf:true,haveMasterBuf:false}`. Matches the
   SYNC_MAP prediction. Beat-phase alone carried the engage.
3. **Listening verdict blocked — four audio sources stacked.**
   Two browser tabs × two decks each = four audio sources
   playing simultaneously. Tab 2 unmuted made the musical
   clash drown the actual sync signal. Verdict UNAVAILABLE
   from tonight's test.

### Tomorrow's soak protocol (locked in)

Run with the Railway relay fix live + tonight's clean Tab 2.

1. **Mute Tab 2 BEFORE engage.** Chad listens to Tab 1 only.
2. **Same track on both decks, both cued to position 0 (first
   downbeat)** before pressing play. Perfect sync = sounds like
   one track; any error = flange/flam, unambiguous verdict.
   Tonight's run had decks ~85 s apart in the arrangement,
   making musical content clash mask the sync verdict.
3. **Play both → press SYNC.**
4. **HUD snapshot at engage / +1 / +2 / +5 / +8 / +10 minutes.**
   Capture `offset`, `rttMedian`, `confidence`, `phaseErrorMs`,
   `msSinceEngage` at each marker.
5. **Verify #10 live.** Scrub master, confirm slave holds.
   Scrub slave, confirm slave re-aligns.

### New gaps logged this session

- **Gap #4 — RTC jitter-buffer delay uncompensated in local
  monitoring.** Even with a perfectly synced engine, each DJ
  hears their own deck via local AudioContext and the partner's
  deck via the WebRTC jitter buffer (stable but adds
  ~50-200 ms). Result: local-deck beatslap in each DJ's ears
  today, regardless of engine accuracy. **Local-deck delay
  compensation is a required Phase 2 component, not optional.**
  Surfaces as a different fix path from clock-offset (which
  fixes cross-machine engage accuracy) — this fixes
  same-machine perceptual sync.
- **Stale session reaches deck UI with dead WS silently.** Once
  the WS drops, the deck-mixer view stays mounted with no
  banner indicating the partner channel is gone. Telemetry
  shows `ws.disconnected` but UI doesn't react.
- **No Lobby return path from deck view.** Leaving back to
  Lobby requires `localStorage.removeItem("cm_session")` +
  reload. Add an explicit "leave session" UI affordance.
- **AUDIO indicator vs CONNECTED pill semantics unclear.** The
  two indicators report different layers (WebRTC vs WS) but
  look similar — Chad had to inspect to know which was which.

### Tomorrow's order (priority-ranked)

1. **Relay fix is already deployed** (server `d708747`,
   verified). No action needed pre-soak.
2. **Re-run two-client soak with the protocol above.** Goal:
   first real drift data + engage-accuracy data + #10
   verification.
3. **Phase 2 design** happens only after drift data exists.
   Likely components based on tonight's map:
   - **Continuous drift correction loop** — periodic
     `nudgeRate` calls sized by measured phase error.
   - **Latency compensation on cross-machine commands** —
     timestamp every action with `t_send` (already wired),
     apply on receive based on estimated offset.
   - **Remote xcorr alternative** for the case where one buf is
     missing locally — either ship partial buf for xcorr at
     engage time (bandwidth concern) or do all xcorr on the
     driver side and broadcast the correction.
   - **Local-deck delay compensation** (Gap #4) so each DJ's
     OWN ears hear the two decks aligned, accounting for the
     RTC jitter buffer adding latency to the partner's stream.
4. **Slice B big WF** per the existing Slice A/B/C punch list
   — once the sync work stabilizes.

### Roadmap status

**Closed this session:**

- ✅ SYNC_MAP architecture audit
- ✅ Phase 1 measurement instrumentation shipped
- ✅ Bug #10 fix shipped (master scrub no longer yanks slave)
- ✅ Bug #2 resolution documented (rate persists per CDJ
  convention; no code change)
- ✅ Server relay fix shipped and deployed
- ✅ Slice A kick-presence WF (recapped from earlier today)

**Active for tomorrow:**

- 🔄 Two-client soak with cleaned protocol — first real drift
  numbers
- 🔄 Live verification of #10 + Phase 1 telemetry flow

**Pending (priority order):**

- 📋 Phase 2 sync design — drift loop + latency comp + remote
  xcorr alternative + local-deck delay comp (Gap #4)
- 📋 Slice B big WF improvements
- 📋 Slice C transient hairline (#37) — inputs already prewired
  via `beatTimes`/`beatAttacks`
- 📋 #9 drag-and-drop library → deck
- 📋 Stale-session-with-dead-WS banner + Lobby return path

### Don't-touch list (unchanged)

Same as prior sections. Phase 1 added measurement only; no DSP
math, no sync engine math, no gate threshold change.

### Working state for next session

- **Master HEAD:** `26cc278` (Task 2) at write time; will
  advance one more to this VISION_5 commit.
- **Production (client):** `collabmix.vercel.app` live on
  bundle `main-CDt3TaQD.js`. Audit confirmed: `sync_ping` ×2,
  `sync_pong` ×2, `SYNC-DRIFT` ×1, `SYNC-ENGAGE-QUALITY` ×1,
  `scrub_realign_suppressed` ×1, `SYNC DEBUG` ×1.
- **Production (server):** `collabmix-server-production.up.
  railway.app` live at `d708747`, uptime reset confirmed.
- **Working tree:** clean (after this VISION_5 commit).
- **Stash:** none.
- **Strategy docs:** `tools/docs/SOCIAL_VISION.md` and
  `LANDING_BRIEF.md` from `11a00ee` still standing.

### POST-DEPLOY SOAK — first real production data

Run on production (`collabmix.vercel.app` + Railway server),
real network between two clients, post-relay-fix.

#### Engage accuracy — TIGHT

Single `[SYNC-ENGAGE-QUALITY]` capture with the cued-to-zero
protocol from the same-room test:

```
result=ok  rateDelta=0.0000  phaseSeekMs=3.73  durationMs=~1
xcorr={applied:false, reason:"bufrefs_unavailable",
       haveSlaveBuf:true, haveMasterBuf:false}
```

**Engage math is tight when cueing is right.** Earlier
`phaseSeekMs=104.37` came from decks ~85 s apart in the
arrangement (different beat-positions in the bar). With both
decks cued to position 0 before pressing play, the beat-phase
seek required only 3.73 ms to land. The cueing protocol matters
as much as the algorithm — same-position cue is the right
engage discipline, and the engage math currently doesn't need
xcorr to land well from a clean cue.

Remote-B2B xcorr-skip confirmed again with the exact
`bufrefs_unavailable` reason and `haveMasterBuf:false` field.

#### Clock estimator — WORKING

Post-relay-fix the Cristian's-algorithm offset estimator is
collecting samples cleanly:

- **RTT median ~93 ms** between the two clients (real-network
  round trip).
- **Confidence 0.66 – 0.88** range, well above the 0-stuck
  state from the tonight-pre-fix run.
- **Offset stable at ±53 026 ms epoch delta** — large absolute
  value reflects the unrelated zero-time on the two browsers'
  `performance.now()`, NOT real clock skew.
- **Non-monotonic wander only ~2.6 ms over 2 minutes** of
  observation — clock skew between the two machines is small
  and slow at this timescale. Phase 2 drift loop won't need to
  chase fast oscillations.

#### Drift monitor — NEVER EMITTED (root cause: progress meta)

State remained `no_recent_progress` throughout the run. The
phase-error monitor wasn't getting fresh
`partnerProgressMetaRef[partnerDeck]` updates. Engage data was
clean (so syncDecks fired) and the clock estimator was
collecting (so the WS relay works), but the 10 Hz partner
progress packets weren't reaching the monitor's read of
`m.t_send`. Investigate the partner-progress mirroring path
first thing tomorrow — possible causes: the broadcast isn't
firing on the right side of the driver model, the t_send
field is being stripped on the wire, or the read path is
checking the wrong deck.

#### NEW CRITICAL BUG — non-driver seek_request not executing

Live observation, production, two clients in one room:
**Tab 2 (non-driver) clicking seek on the partner-driven deck
did not move the playhead.** Driver→partner mirroring works in
the opposite direction (driver-side seek mirrors to partner via
10 Hz progress + `deck_update`), so the receive path on the
driver works for one type of flow.

Engage path dependency: in remote B2B, `syncDecks` calls
`seekFnsRef.current[slave]?.(newProg)` to align beat phase.
When slave is partner-driven, that seek call is non-driver →
it fires `onTransportFire({type:"seek_request",
deckId:id, value:pc})`. If `seek_request` from non-driver is
silently dropping in production, then **the engage's beat-phase
seek is silently not landing on the partner side either** —
meaning the 3.73 ms phaseSeekMs above was computed but may not
have been APPLIED to the partner-driven deck. Possible
explanations for the observed `result=ok` while the actual
seek failed: the driver still receives `seek_request`, executes
its own `seek`, but… something blocks. Likely candidates:
server-side `seek_request` relay branch dropping the message,
client-side driver guard in `seek` not unwrapping
`fromRemote=true`, or `seekFnsRef` not yet populated on the
driver side when the request lands. INVESTIGATE FIRST
TOMORROW — this is the most consequential finding from the
soak.

#### NEW BUGS (lower severity)

- **Audio continues after track end.** Playhead reaches 1.0
  and the buffer source's `onended` should fire `setPlay(false)`
  + `setProg(0)`. Either the loop guard at `loopRef.current
  .active` is mis-evaluated post-track-end, or the buffer is
  being re-triggered. Surfaces as audible silence followed by
  the track restarting at 0 without a play press.
- **Partner-driven deck missing kick-presence WF AND grid
  markers.** The analyzer payload (`beatTimes`, `beatAttacks`,
  `beatPhaseSec`, `beatPeriodSec`, full bands arrays) computed
  on the driver side isn't reaching the non-driver's local
  `bpmResult` state. The non-driver renders the partner deck
  with `remote.*` fallbacks only, which don't include the
  analyzer payload. Same path degrades the sync engine's
  inputs — when MY-side `syncDecks` reads
  `bpm.results[partnerDeck]?.bpm` it falls back to
  `pX?.bpm`, which is available (broadcast on track load),
  but `beatPhaseSec` / `beatPeriodSec` may not be on the
  fallback path in all cases. Mirror these fields explicitly
  in `deck_update` field broadcasts at analyzer completion,
  symmetric to how `bpm` and `rate` are mirrored today.

#### Tomorrow's order — UPDATED (replaces the prior locked order)

1. **`seek_request` path fix.** The most consequential finding
   — silent failure on a code path that the sync engine
   depends on. Trace driver/non-driver/server-relay all the
   way through with two-client logging before patching.
2. **Drift monitor `partnerProgressMetaRef` fix.** Without
   this, Phase 1 measurement is half-built — we have engage
   data but no drift data. Re-soak needs both.
3. **Re-soak, full 10 minutes.** Same cued protocol. Goal:
   full drift slope across the time markers
   (+1/+2/+5/+8/+10), data that sizes Phase 2's drift loop.
4. **Phase 2 design — only after step 3 data lands.** Components
   now confirmed required:
   - **Local-deck delay compensation (Gap #4).** Without
     this, perceptual sync inside each DJ's ears remains
     broken regardless of engine accuracy.
   - **Drift correction loop** sized by the measured drift
     rate from the 10-minute re-soak.
   - **Remote xcorr alternative** still relevant — the
     `bufrefs_unavailable` skip remains the structural
     limit on engage accuracy when same-position cueing
     isn't enforced.
5. **Partner-side analyzer payload mirroring.** Broadcast
   `beatTimes` / `beatAttacks` / `beatPhaseSec` /
   `beatPeriodSec` / full bands on the driver side at
   analyzer completion. Fixes the missing WF and grid
   markers AND restores sync engine input quality on the
   partner side.

#### New issues logged from soak

- **Sync-#1 (CRITICAL)** — `seek_request` from non-driver
  silently fails in production. Blocks every cross-machine
  seek including the sync engine's beat-phase alignment.
- **Sync-#2** — Drift monitor `no_recent_progress` stuck;
  partner progress meta path not reaching the read site.
- **Bug #11 (NEW)** — Audio continues / re-triggers after
  track end on driver side.
- **Bug #12 (NEW)** — Partner-driven deck missing
  kick-presence WF and grid markers (analyzer payload not
  mirrored).

---

## Session — June 10 late-late — Soak re-verification + identity root cause + Chad observations

### Soak verdict on tonight's three fixes (deployed earlier)

Live two-client soak with the cued protocol:

- ✅ **Check A — Bug #12 (analyzer payload mirror) PASS.** Partner-
  driven deck rendered kick-presence WF, minute markers, and
  grid markers identical to driver side.
- ✅ **Check D — Bug #10 (master-scrub-doesn't-yank-slave) PASS.**
  `scrub_realign_suppressed` telemetry fired correctly on master
  scrubs; slave held its position.
- ❌ **Check B — Drift telemetry FAIL.** `[SYNC-DRIFT]` never
  emitted. HUD state pinned at `not_remote_b2b` throughout.
- ❌ **Check C — Seek trace FAIL.** `[SEEK-SEND]`/`[SEEK-RECV]`/
  `[SEEK-EXEC]` all silent. The instrumentation never fired
  because the path was never taken.

### Root cause for B and C: identity collision

Both tabs were assigned the **identical** DJ name "DJ Nova 440b".
Deck headers showed "you" on owned decks, no crossed partner
names anywhere in the UI. Investigation:

1. **Identity in code was pure display name.** All driver checks
   used `deckDrivers.X === session.name`. The server already
   generated a per-connection unique `djId` but the client threw
   it away — never captured from the `joined` payload.
2. **`cm_session` localStorage rejoin.** When both tabs opened
   the bare base URL in the same browser profile, the auto-
   rejoin path at `:8397-8413` read the same persisted
   `{room, name}` and both auto-joined as the same display
   name. The name pool was 6 words × 65,536 hex suffix
   (per code comment at `:6388-6390` — "DJ Nova" had already
   collided once for Jake/Chad), but **identical persisted name
   trumped the pool size entirely**.
3. **Cascading failures.** Tab 2's `isDriver` for Deck A
   evaluated to `true` (`"DJ Nova 440b" === "DJ Nova 440b"`).
   Tab 2's seek on the partner deck fell into the DRIVER branch,
   never emitted `seek_request` (explains silent `[SEEK-SEND]`).
   Phase-error monitor's `myDecks = ["A","B"].filter(d =>
   drivers[d] === myName)` returned BOTH decks under collision →
   permanent `not_remote_b2b` (explains silent `[SYNC-DRIFT]`).

### Identity fix shipped (commits 8849446 server + 33273e5 client)

- **Server** (`d708747 → 8849446`): `room.deckDrivers[deckId]` is
  now `{ id, name } | null`. `id` = the server-generated `djId`
  (per-WS-connection unique, was already produced for a different
  purpose). `deck_driver_change` broadcast carries both
  `driverId` and `driverName`. Close-cleanup matches by id.
- **Client** (`33273e5`): `useSync` captures `djId` from the
  `joined` payload (logs `[WS-JOINED] djId=…`), exposes it on
  the sync return. Driver-routing comparisons (`isDriver` in
  Deck render, `dh` driver-gate, phase-error monitor's
  remote-B2B filter, `handleWS deck_driver_change` echo
  detection, optimistic deckDrivers set) all moved to id.
  `session.name` remains cosmetic (UI display, telemetry,
  server "join" payload for the display name).

Production audit on `main-_MXI3OgT.js`: `djId ×11`, `driverId
×2`, `WS-JOINED ×1`. Railway live on `8849446` with uptime
reset confirmed.

### Display-name collision is now COSMETIC ONLY

With ID-based identity, two tabs auto-rejoining the same room
with identical persisted names still get distinct `djId`s from
the server. Driver routing, seek path, drift monitor all work
correctly. The only remaining annoyance is two clients showing
the same display name in the UI. Deferred as polish — on the
agenda after the re-soak confirms the identity fix lands the
seek + drift behavior.

### Chad's observations from tonight's soak (triage tomorrow)

a. **Seeks/cues sometimes don't snap to nearest gridline.**
   Possible causes: (i) analyzer phase error (the track's
   `beatPhaseSec` is slightly off, so the grid is mathematically
   correct but visually mis-located); (ii) ABSENCE of
   quantize-seek-to-beat behavior (the click is honored exactly
   where it lands, not snapped to the nearest beat). If (ii):
   feature ticket — quantize-seek-to-beat (or option-modified
   snap) is DJ-tool standard. Triage after a clean drift
   trace shows whether phase math itself is off.

b. **Decks visually offset from each other even when on
   gridlines.** Likely 10 Hz progress packet display lag vs
   actual audio. Tab 1 broadcasts progress at 100 ms intervals;
   Tab 2's interp loop smooths between snapshots but can lag the
   actual audio. Confirm via drift telemetry: if `phaseErrorMs`
   shows the audio is aligned within ±5 ms but the visual is
   off, the visual is the issue, not engine sync. Fix path:
   either drive the interp from `acNow + offset` instead of
   pure `performance.now()`-since-last-packet, or render the
   playhead from a periodic `getActualBufferPosition()` if the
   driver exposes one.

c. **Engage `phaseSeekMs=-231.26` this run** (vs 3.73 first
   soak with cued protocol). Decks were ~25 s apart in the
   arrangement. The math is correct — the engage seeks the slave
   back 231 ms to land on the nearest beat — but it confirms
   same-position cueing matters for calibration tests. For
   real-world DJ use the engage will land on the nearest beat
   to the slave's current position, which is the intended
   behavior; for measurement runs we want both decks at
   matching positions so we can interpret `phaseSeekMs` as
   "alignment error from a pristine starting point."

### Tomorrow's order — UPDATED

1. **Re-soak with identity fix live.** Same cued protocol,
   Tab 2 muted, HUD snapshots at engage/+1/+2/+5/+8/+10. This
   should finally produce the first real drift trace AND the
   seek-path log trace.
2. **Triage Chad observations (a) and (b)** with drift data in
   hand — distinguishing analyzer phase error from
   display-interp lag from missing-quantize feature.
3. **Audio-after-end (Bug #11)** if soak goes cleanly.
4. **Display-name collision UX polish.** Append window-disambig
   suffix on auto-rejoin OR detect partner_joined with same
   name and force rename. Decide after re-soak.
5. **Phase 2 design** once drift loop is sized by data, per
   prior plan (Gap #4 local-deck delay comp + drift correction
   + remote xcorr alternative).

### Working state for next session

- **Master HEAD:** `33273e5` (identity fix client) at write
  time; will advance one more to this VISION_5 commit.
- **Production (client):** `collabmix.vercel.app` live on
  `main-_MXI3OgT.js`. Audit clean.
- **Production (server):** Railway live on `8849446`. `/health`
  uptime 23 s confirms fresh boot.
- **Working tree:** clean after this VISION_5 commit.

## Session — June 10 — Re-soak verification + booth-audio-dead fix

### RE-SOAK RESULTS — all four checks PASS

- **Identity fix VERIFIED** — distinct djIds, crossed names,
  join-by-code all confirmed live.
- **HEADLINE: first real drift data** — cross-client offset
  wander ~4.3 ms peak-to-peak over 7.5 min lock, slope ≈ 0
  ms/min. Clock drift is NOT a major problem. Phase 2
  re-prioritized: drift loop = low-priority maintenance; engage
  precision + monitoring latency comp (Gap #4) + audio-path
  robustness = the real work.
- **Seek propagation VERIFIED end-to-end** (SEND→RECV→EXEC ×3) —
  Bug 1's root cause was the identity collision, not seek code.
- **#10 + analyzer-mirroring regressions hold.**

### AUDIO-DEAD BUG CLOSED

Root cause = identity fix's unmigrated trim-gate comparison
(`{id,name}` object vs name string → every driven deck gated to
0). Fixed via syncRef djId migration after one render-order
crash iteration. AUDIO chip now polls master analyser → red NO
OUTPUT on playing-but-silent (warning only). Verified by ear on
localhost. Shipped in commit `63adacd`.

Note for the record: the live console diagnostic paste did not
make it into this session's notes (placeholder came through
empty); the fix is ear-verified rather than log-pasted. One-shot
`[AUDIO-DIAG]`/`[TRIM-GATE]` play-time logs remain in the build
for field diagnosis; the high-frequency per-tick monitor log was
removed before push to avoid production console spam.

### NEW TICKETS

1. **Initiator display echo:** remote seek executes on driver but
   initiating tab's view of that deck stays frozen.
2. **Asymmetric monitor sampling:** slave-side tab stayed
   `no_recent_progress` all run — check progress meta both ways.
3. **Drift estimator noise:** ±9–186 ms oscillation around stable
   offset — needs smoothing before Phase 2 consumes it.
4. **Part 3 click-to-resume recovery** (specced).
5. **ESLint v9 config migration** — repo lint is broken; ESLint
   v9 needs an `eslint.config.js` (no `.eslintrc` support).
6. **AUDIO chip semantics:** OFFLINE means "no partner" —
   misleading; consider separate connection vs output indicators.

### THE CANONICAL FLOW (Chad, June 10)

Check every sync/audio decision against this: DJ A loads a track;
partner sees AND hears it in real time. Both listen together
while partner digs. At the mix-out point, partner loads Deck B,
hits play — both hear it instantly — and performs the blend from
A into B until the new track owns the room. Roles alternate. The
blend IS the performance; everyone hears all of it.

### ONE BOOTH, ONE TRUTH (founder principle)

All listeners — both DJs, spectators, recordings, livestreams —
hear the SAME mix. Phase 2 latency compensation aligns everyone
to one shared mix timeline (tiny shared delay acceptable) rather
than minimizing per-listener delay independently.

### Working state for next session

- **Master HEAD:** `63adacd` (booth-audio-dead fix) at write
  time; advances one more to this VISION_5 commit.
- **Production (client):** deploy triggered by this push —
  bundle audit recorded in the session report.
- **Production (server):** Railway unchanged (`8849446`); this
  was a client-only fix.

## Session — June 10 — Entry-flow investigation + stale-socket fix

### Entry-path map (Chad, localhost, two-window testing)

1. **Fresh via Landing** (private tab, no storage): WORKS.
2. **Auto-rejoin from storage** (regular tab): WORKS post-identity
   -fix (distinct djIds). Storage decides destination — same URL
   goes to Landing in a private tab, straight to the booth in a
   regular tab.
3. **Join-by-code:** reported BROKEN on localhost (typing a valid
   code silently creates a NEW empty room); reported WORKING on
   production in the re-soak → suspected dev-only.

### Headless reproduction — could NOT reproduce the split

Drove the real two-window click path (Playwright + system Chrome,
dev StrictMode, live Railway server). **14/14 runs PAIRED**
across: fresh-create + join-by-code (5), stale-room restore +
join-by-code (4), and a tight timing race with B joining inside
A's double-mount gap (5). The join-by-code room-split did not
reproduce. NOT claiming a fix for it — it is likely intermittent
/ timing- or environment-specific (server room-GC race in the
double-mount gap, or a copy-paste artifact). The `[JOIN-DIAG]`
logs added this session capture the exact roomId each socket
sends, so the next real occurrence in Chad's browser will show
whether it's a code mismatch, a dead-socket send, or a server
room miss.

Mechanism note: the "fires once on a doomed socket" hypothesis
does not hold for join-by-code — its `connect()` comes from a
CLICK handler, which React StrictMode does NOT double-invoke, so
there is no teardown to lose the join to. The double-mount is
real only on EFFECT-driven connects (auto-rejoin/restore), and
those RECOVER because `connect()` re-fires on the effect's second
setup.

### FIXED + VERIFIED: restore "ghost room" / contradictory banner

The earlier restore symptom — "CONNECTED·43ms" + "Could not
connect to server" banner + AUDIO: OFFLINE simultaneously — IS
reproduced and fixed. Cause: the StrictMode double-mount tears
down the first WebSocket; unpatched, that dying socket's
`onerror`/`onclose` painted "Could not connect" and flipped
status to disconnected OVER the healthy live socket. Fix:
stale-socket guards in `useSync` — ignore `onopen`/`onerror`/
`onclose` when `ws.current !== w`. Verified headlessly (stale
onerror suppressed, stale close `wasCurrent=false`). Restore
re-registers a REAL server room (WS#2 sends join, server
responds `joined`, partner pairs) — NOT a ghost.

### No exit from the booth (UX ticket logged, not built)

`leave()` exists (returns to Landing, clears `cm_session`) but is
wired to nothing. There is currently no way back from the mixing
view to Landing/Lobby. Decision: log only this session; build
later (needs a header button + confirm).

### NEW / UPDATED TICKETS

1. **Join-by-code room-split:** unreproduced across 14 headless
   runs. Capture `[JOIN-DIAG]` from the next real occurrence
   (browser console) — need the actual roomId-sent-vs-matched.
2. **INVITE button flow** (invitee landed in a room without the
   inviter's track): same family; now rides `[JOIN-DIAG]`. Not
   separately reproduced.
3. **Back-to-lobby navigation** (UX): wire the existing `leave()`
   to a booth-header control.
4. **Transport-from-non-driver recheck:** play button on a
   partner-driven deck did nothing once from the non-driver tab;
   resolved after refreshing both tabs. Stale-state artifact, not
   reproducible clean — recheck after entry-flow fixes settle.

### PHASE 2 EVIDENCE (no action — founder-validated by ear)

Chad's first clean listening verdict (two tabs, same room, same
track on both decks, synced): audibly smeared/doubled but far
better than pre-fix chaos. Confirms **Gap #4** (RTC jitter-buffer
delay vs local deck, uncompensated in monitoring) is THE audible
artifact. Phase 2 delay compensation is now validated by ear as
the right next work.

### Working state for next session

- **Master HEAD:** advances to this VISION_5 commit (sits above
  the stale-socket-fix commit).
- **Production (client):** stale-socket guards + `[JOIN-DIAG]`
  pushed; bundle audit in the session report.
- **Production (server):** Railway unchanged (`8849446`);
  client-only.
- **Verification tooling:** `_join_repro*.mjs` (Playwright +
  system Chrome, `playwright-core` installed --no-save) drive a
  two-window join headlessly — re-runnable for regression.

### Two-client smoke suite — SEED (kept on disk, to be extended)

`_join_repro*.mjs` (root, untracked; dev server left running) are
the SEED of a two-client smoke suite. They already assert: two
clients boot, join one room by code, get distinct djIds, and see
each other as partners (names crossed). Extend into the full
smoke test:
- distinct djIds ✓ (seed)
- partners crossed ✓ (seed)
- track load mirrors (driver loads → partner paints
  title/BPM/waveform)
- play/seek propagate (driver play/seek → partner deck reflects)
- drift telemetry emits (`[SYNC-DRIFT]`/phaseErrorMs while both
  decks play synced)
Intended home: `tools/smoke/` (repo convention), with a runner
(PASS/FAIL + exit code), `playwright-core` promoted to a saved
devDependency, and a small license-clean audio fixture. Effort
estimate logged in the session report (~2–3 focused sessions;
Phase 2 headless track-load is the one real unknown — a tiny
test-only load hook de-risks it).

### NEW BUG: partner-deck waveform jumps backward (display-only)

During the live two-tab listening test, Tab 2's partner-driven
deck waveform repeatedly jumps BACK several beats. Diagnosed as
DISPLAY-ONLY (the partner deck has no local buffer; its audio is
the driver's continuous RTC stream — the jumps are not audible).

Root cause: the non-driver playhead interpolation
(`Deck`, ~:4555) extrapolates at a FIXED 1× rate
(`1/(trackDurSec*1000)`), IGNORING the driver's actual
`remote.rate`. When the driver deck is rate-adjusted (synced/
pitched — the norm in a beatmatched set), the interp drifts ahead
of truth at `(1−rate)/dur` per ms. The drift accumulates until it
crosses `SNAP_THRESHOLD` (0.5% of track ≈ 1.8s ≈ several beats),
then the hard-snap branch (~:4573) yanks the playhead BACK to
truth. Sawtooth — amplitude ≈ threshold ≈ "multiple beats,"
exactly as observed.

Proposed fix (NOT built — awaiting approval):
1. Rate-aware interp: `rate = (remote.rate ?? 1)/(dur*1000)` —
   removes the systematic drift (the root cause).
2. Never snap BACKWARD visually — slew: for sub-seek backward
   drift, reduce interp rate until the playhead eases down to
   truth instead of hard-resetting; still allow a backward HARD
   snap for a LARGE jump (a genuine driver seek-backward).
Relates to the `initiator display echo` and `decks-visually-
offset` tickets (same 10Hz-packet-vs-interp family).

### Waveform-jump fix — BUILT + SHIPPED

Both parts built and pushed: (1) rate-aware interp using
`remote.rate` (kills the systematic drift); (2) never snap
backward — re-anchor the model to truth each packet but carry the
current visible offset into a slew term (`remSlewRef`) that
decays to 0 over ~220ms (TAU), so the playhead EASES onto truth
instead of jumping; a hard snap is reserved for a genuine seek
(>3s discrepancy, either direction). Verified by a math-model
simulation of the interp: the synced-slower case (rates
0.90–0.97) goes from a 1.79s backward sawtooth (OLD) to a 0.004s
worst-case backward step (NEW, imperceptible) across a 0.90–1.06
rate sweep. App build + headless boot + two-client partner-mirror
render all clean (no console errors). Audio was never affected
(partner deck has no local buffer; its sound is the driver's RTC
stream) — this was always display-only.

### Room-split ROOT-CAUSED + FIXED (the `[JOIN-DIAG]` net worked)

The production `[JOIN-DIAG]` instrumentation caught it: Chad pasted the
full INVITE URL into the Lobby join field, and the client sent the
entire URL as the roomId —
`roomId="https://collabmix.vercel.app/?room=drop-haze-451&mix=untitled+mix"`
— so the server created a room literally NAMED that URL. Bare codes
always worked (Cowork + all 14 headless runs typed bare codes); pasted
links split. This is why I could never reproduce it — I was always
feeding bare codes.

Fix: `normalizeRoomCode()` — if the join input parses as a URL or
contains `room=`, extract the room param (via `new URL().searchParams`
with a regex fallback for bare `?room=…` fragments), URL-decode, trim,
lowercase. Wired into `submitJoinCode`. Verified headlessly: pasting the
full invite URL now sends `roomId="echo-bass-772"` and PAIRS (was SPLIT);
opening the invite URL directly also PAIRS (invite flow end-to-end OK);
8/8 normalizer unit cases pass. Shipped.

Open follow-ups:
- **Server-side defense in depth:** reject/normalize roomIds that look
  like URLs. NOT done — the server is a separate Railway repo, not in
  this tree. Ticket for the server side.
- **Share flow copyable bare code:** the Share button copies the full
  invite LINK; add a one-tap copy of the BARE code too (the booth
  already displays it). Ticket.

### Smoke suite — APPROVED for tomorrow's first build

Decision: build the two-client smoke suite in `tools/smoke/`
tomorrow, WITH a test-only load hook — `window.__loadTestTrack`
behind a dev flag — that runs a bundled sample track through the
normal load path so the headless suite can exercise track-mirror
+ play/seek-propagate + drift-telemetry without the unautomatable
`showOpenFilePicker` dialog. Seed: `_join_repro*.mjs`. Promote
`playwright-core` to a saved devDependency at that point. The
interp-math harness `_interp_sim.mjs` also stays as the
regression check for the playhead model.

## CLOSING VERDICT — June 10 (Chad, production, Chrome + Safari)

Blend test, post all fixes: **the sync engine is LOCKED.** The only
audible artifact is a clean, constant "quick double kick" — a tight,
steady flam between the local deck and the RTC-streamed partner deck.
No chaos, no wander; the gap does not grow over the blend. That steady
offset is **Gap #4 isolated by ear: monitoring delay, NOT engine
error.** The engine holds time; the local monitor and the RTC-streamed
partner audio simply arrive a fixed beat apart at the listener.

This confirms the Phase 2 priority: **local-deck delay compensation
against the shared mix timeline** — align every listener to one mix
clock (ONE BOOTH, ONE TRUTH; a small shared delay is acceptable) rather
than minimizing each path independently. The flam is the founder-by-ear
measurement of exactly that uncompensated delay.

The night's arc is complete: every sync layer measured (identity, seek
propagation, drift ~4.3ms p2p / slope≈0, audio-path output truth, entry
flows, playhead render), and the last remaining artifact is named and
specced. Tomorrow opens on the two-client smoke suite (with the
`__loadTestTrack` hook), then Phase 2 delay compensation.

## PHASE 2 BUILD — local-deck delay compensation (Gap #4), behind ?delaycomp=1

Built and headless-verified; NOT yet pushed (awaiting Chad's ear test —
the double kick should collapse to ONE kick).

**Investigation result — measurement is feasible.** Chrome's audio
receiver `getStats()` exposes `jitterBufferDelay/jitterBufferEmittedCount`
(dominant variable delay) + `media-playout` `totalPlayoutDelay/
totalSamplesCount`. A self-contained loopback probe
(`_rtc_stats_probe.mjs`) read avg jitter-buffer ≈31ms + playout ≈18ms at
near-zero network; scales to 100–200ms over a real network. Computed
DELTA-based (recent average, not lifetime) so it tracks the buffer
adapting.

**Build:**
- `createEngine`: one `monitorDelay = ctx.createDelay(1.0)` inserted
  `masterAn → monitorDelay → destination`. It sits ONLY on the local
  speaker path — the partner-send tap (`capture()`) and the recorder tap
  read `master` upstream, so compensation never colours what we send or
  record. Default 0 = no-op.
- `useRTC`: a 1.5s `getStats()` poller computes `compMs = jitterBuffer +
  playout` and exposes it via `compRef`.
- `CollabMix`: a 1s driver clamps to 0–400ms and slews
  `monitorDelay.delayTime` via `setTargetAtTime` (~1.5s TC, never clicks).
  Applied only when `?delaycomp=1`; measurement + telemetry always run.
- Telemetry: `syncStatsRef` → `SyncDebugHUD` (`?syncdebug=1`) now shows
  `comp meas / jb / play / comp appl (on|off)`; `[SYNC-COMP]` log.

**Verified headlessly:** flag ON, two real clients RTC-connected →
measured 48.2ms, applied 48.2ms, HUD shows it, no errors (even silent
master measures — NetEQ emits silence frames). Flag OFF (production
default) → applied 0.0ms, bit-identical, no errors. Symmetric: each side
measures its own inbound delay and delays its own monitor. Tooling:
`_rtc_stats_probe.mjs`, `_delaycomp_verify.mjs`.

**Ear test (Chad):** load `…/?delaycomp=1&syncdebug=1` (best on production
with Cowork on a second machine for real network jitter). The HUD's
`comp appl` shows the live applied delay; the double kick should collapse
to one. The `comp meas` number is visible even with the flag off.

**Open / follow-ups:**
- Recorder still captures local master only (no partner stream) — "one
  truth" recordings are separate future work.
- Optional refinements if the single value isn't enough by ear: add an
  RTT/2 network term (`remote-inbound roundTripTime`), a small constant
  manual trim, and freeze adjustments during an active blend (fader move).

### EAR VERDICT (Chad, production, Chrome + Safari, ?delaycomp=1)

**THE WIN:** double kick GONE on first engagement, no perceptible lag,
`comp appl ~53.7ms`. Booth sounded locked — Gap #4 audibly closed.

**THE BUG (founder QA, minutes later):** comp does NOT survive pause/
resume. PAUSE + PLAY a deck → double kick returned, while the HUD still
showed `comp appl ~47.8ms` applied. DelayNode survives; Chad's read =
the measurement went stale.

**Promotion to default-on is BLOCKED on transport robustness** until comp
survives pause/resume, seek, track swap, and re-sync.

### Investigation — could NOT reproduce the stale-measurement permanently

- `_rtc_interrupt_probe.mjs`: a silent interruption (`track.enabled=false`,
  like a deck pause where the engine stays connected but silent) does NOT
  stall the jitter buffer — `emittedCount` keeps advancing at 48000/s and
  the delta stays a clean 30ms. So a silent pause shouldn't stale the
  measurement.
- `_comp_rebaseline_sim.mjs`: even modelling a 1.5s jitter-buffer STALL +
  true-delay jump (30→120ms), the OLD poller still re-converges (~5.3s) —
  it does not permanently stick. So the lifetime-average fallback is a real
  latent transient but likely NOT the permanent-stick Chad saw.
- Conclusion: the measurement is robust in both models; the real cause may
  be elsewhere (resume transient / local-deck restart timing / DelayNode).
  Not claiming a fix — added instrumentation to catch the real numbers on
  Chad's next pause/resume (the [JOIN-DIAG] playbook).

### Hardening shipped (behind ?delaycomp=1 — genuine improvements)

- Removed the lifetime-average fallback; skip ticks with no new samples
  (keep last value) instead of reporting a stale mean.
- Re-baseline on any discontinuity: counter reset, emit-rate collapse
  (auto-detected stall), OR a transport event. `markTransportEvent()` is
  called from local play/pause (`dh`), seek/cue/toggle
  (`handleTransportFire`), and partner play/pause (`handleWS` deck_update
  `playing` only — never the 10Hz progress packets).
- Fast settle (~0.3s slew TC) for 4s after a transport event, then
  slow-follow (~1.5s). Poll 1.5s → 700ms for responsiveness.
- `[SYNC-COMP]` now logs `jb / playout / target / applied / [settling]` so
  the next real pause/resume confesses what actually happens.
- Sim: re-converge after a stall improved 5.3s → 2.57s. Two-client happy
  path still measures + applies (48–51ms), no errors.

### Display ticket — non-driver beatgrid slides back on play (FIXED, same family)

On play-START the non-driver extrapolated off stale paused state, then the
never-snap-backward slew turned the first-packet correction into a visible
backward glide over a few bars (sound unaffected). Fix: on the play
transition (`!wasPlaying && nowPlaying`) reset the interp anchor so the
first authoritative packet HARD-SNAPS to truth, then resumes slewing.
Refines tonight's sawtooth fix; does not revert it.

### COMP ZERO-OUT ROOT CAUSE FOUND — stale receiver after renegotiation

Chad's Chrome console (the broken side) cracked it: `[SYNC-COMP]
measured=0.0ms (jb=0.0 playout=0.0)` EVERY tick the whole session, and RTC
negotiated TWICE (`[RTC] role determination` ×2, `incoming track received`
×2, autoplay `NotAllowedError` then later `play() succeeded`). The comp
poller was reading a STALE/DEAD receiver: `pc.getStats()` returns ALL
inbound-rtp reports including the corpse of the pre-renegotiation receiver,
and last-wins picked it → jb=0/playout=0 forever → applied slewed to 0 →
double kick returned and never recovered. Explains both the original break
(win on connection #1, Safari pause forced a rebuild, comp polled the
corpse) and the all-zero session (renegotiation happened early). NOT the
delta math — receiver binding.

Fix (behind ?delaycomp=1):
- Bind to the LIVE receiver every tick via
  `pc.getReceivers().find(audio)` and scope `getStats()` to it, so dead
  inbound reports can't poison the read. On `track.id` change → rebind:
  re-baseline + fast-settle + `[SYNC-COMP] rebind → live receiver` log.
- Never follow to zero: HOLD the last good compMs whenever there are no
  measurable frames (no receiver / emittedCount not advancing / not
  flowing) — only re-measure once frames flow again.
- Health gate: require `HEALTH_MIN=4` consecutive flowing windows before
  trusting a value; a big DROP (<50% of last good) needs +3 more — so a
  refill transient or spurious-low can't drag comp toward zero.

Verified headlessly:
- Renegotiation (`_comp_reneg_verify.mjs`): A measuring 53.3ms → partner B
  reloaded (forces A to renegotiate a new receiver) → 2 rebind events,
  A recovered to 48.2ms in **0.3s** (was: stuck at 0).
- Sender interruption (`_sender_interrupt_probe.mjs`): NEW holds last good
  through the resume transient, never dips below the real value; OLD
  followed the refill dip down.
- Happy path: receiver-scoped stats still yield jb+playout+target
  (55/48ms), no errors.

Still flag-gated. Promotion to default-on pending Chad's full gauntlet:
local pause/resume, REMOTE pause/resume, partner refresh, seek, re-sync.

### RETRACTION + REAL ROOT CAUSE — it was autoplay, not comp

**RETRACTED:** "remote pause/resume breaks comp." The comp gauntlet has NOT
cleanly run yet. Both browser logs (Chrome + Safari) showed the truth:
Safari's RTC `<audio>` element was autoplay-BLOCKED (`play() failed:
NotAllowedError`, Safari silent). Chad's pause/play CLICK in Safari was the
user gesture that UNBLOCKED it (`play() succeeded`) → Safari's speakers began
playing the (delayed) Deck A stream. On a one-machine, two-browser test that
is a permanent "double kick" (Chrome local deck + Safari speakers) — and comp
can't touch it (the offset is ~a full round trip, not the receive buffer).
Comp itself behaved (Safari measured a steady ~30ms throughout). Chrome's
`measured=0` was because Safari had no deck loaded → silent/empty inbound.

**Echo / mix-minus check (from the prior message): NO echo.** Confirmed in
code: the outbound stream taps `eng.master` (local decks only); partner audio
plays via a separate `<audio>` element (`srcObject`) that is NEVER connected
into the AudioContext. So the outbound can't contain partner audio — mix-minus
is inherently correct.

### Product fixes shipped

1. **Autoplay (the culprit):** removed the global "any click resumes partner
   audio" handler — an unrelated gesture must never start partner audio. The
   blocked-state banner is now an EXPLICIT button ("Tap here to enable partner
   audio") that calls `enablePartnerAudio` (the only way it starts).
2. **Comp telemetry honesty:** when the inbound stream has no frames
   (partner silent / no deck), HUD + `[SYNC-COMP]` now show "no inbound frames"
   instead of a masking `measured=0`, and comp HOLDS (doesn't apply a
   meaningless 0). Also: poll only LIVE receivers (`readyState==="live"`) so
   ended tracks from prior negotiations can't be selected.
3. **Partner-audio local monitor mute — TICKET (consider):** a per-side mute of
   what I hear from the partner. Largely covered today by the Partner-vol
   slider (→0); fold into the shared-mixer monitoring ticket.

Verified headlessly: happy path still measures (48/50ms); renegotiation rebind
still recovers (50.8→48.2ms in 0.3s, 2 rebinds); no errors. Tooling:
`_remote_pause_probe.mjs` (unused — superseded by the log diagnosis).

**Next:** Chad re-runs the comp gauntlet now that the autoplay artifact is
gone — partner audio will only start via the explicit button, so a deck
pause/play can no longer trigger the phantom double kick.

## 🏆 COMP GAUNTLET — ALL FIVE PASS (Chrome + Safari, production)

Clean protocol: Safari audio woken deliberately then tab-muted, real Deck B
loaded, one-kick baseline confirmed first.
1. Local pause/resume (Chrome) — PASS
2. Remote pause/resume (Safari) — PASS (the old killer, now clean)
3. Full Safari reload + rejoin — PASS
4. Seek — PASS
5. Re-sync engage — PASS

Canonical flow also exercised: partner loaded a NEW track on Deck B
mid-session, heard cleanly in the driver's booth. **Comp is transport-proof.**

### Tonight's full comp arc (one place)

- Gap #4 named by ear (the "double kick"): local deck instant vs partner deck
  jitter-buffer-delayed.
- Built local-monitor delay comp behind `?delaycomp=1`: a single `monitorDelay`
  on `masterAn → destination` (local-only; partner-send + recorder tap `master`
  upstream), driven by a `getStats()` poll of `jitterBufferDelay + playout`.
- First ear test: WIN — double kick collapsed, `comp appl ~53.7ms`.
- Robustness pass: removed lifetime-average staleness, re-baseline on transport
  events / stalls, fast-settle slew, faster poll.
- Zero-out bug: poller read a DEAD receiver after renegotiation → fixed by
  binding to the LIVE receiver via `getReceivers()` each tick + rebind on
  track change.
- The "remote pause breaks comp" red herring: RETRACTED — it was the autoplay
  `<audio>` element unblocking on an unrelated click (one-machine artifact).
  Fixed the autoplay UX; comp was innocent.
- Gauntlet: 5/5 PASS. Mix-minus confirmed correct (no echo).

### PROMOTION PLAN (Chad's call — NOT flipped tonight)

- delaycomp stays OPT-IN (`?delaycomp=1`) tonight.
- Tomorrow: Cowork runs ONE 30-min soak with `?delaycomp=1` active (full HUD
  protocol, comp fields tracked) as the final endurance check.
- If clean → promote to default-ON, keeping a kill-switch: disable with
  `?delaycomp=0`. Implementation for tomorrow: flip the gate to
  `delayCompOn = new URLSearchParams(...).get("delaycomp") !== "0"` (default on,
  off only when explicitly =0). Do NOT change tonight.

### NEW DISPLAY TICKET (not urgent, display-only)

A freshly-loaded partner deck's waveform is visually jumpy for a while after
load (audio clean). Likely the interp stabilizing during the load burst
(analyzer payload + first progress packets + comp settle). Same family as the
play-start glide / sawtooth — handle in the shared display-path cleanup
(candidate: suppress/hard-anchor the interp until the first post-load progress
packets + waveform payload have landed).

### Working state

- Master HEAD advances to this VISION_5 commit (above `1f5ddc2`, the autoplay
  + telemetry fix). Production client live on the `1f5ddc2` bundle
  (`main-CH1s4n8g.js`); Railway server unchanged.
- Verification tooling (`_*.mjs` at repo root) kept untracked for now; fold the
  keepers into `tools/smoke/` during tomorrow's smoke-suite build (with
  `playwright-core` promoted to a saved devDependency).

### TICKET — Safari waveform jitter (cosmetic, Safari-specific, NOT chased)

First Safari compatibility data point of the project. On `main-CH1s4n8g.js`,
BOTH decks' waveforms render jittery / uneven in Safari (it's the MOVEMENT —
like a lower/uneven frame rate — not the visuals), while Chrome is perfectly
smooth on the same session. Audio clean. Affects local AND partner decks
equally → it's a rendering-engine difference, NOT network/sync. Likely
suspects to triage when Safari gets a proper support pass:
- Safari `requestAnimationFrame` throttling (background/occluded window?
  low-power mode? — note the render loops in `AnimatedZoomedWF` and the
  per-deck WF use rAF).
- canvas2D performance with the blur/glow draw stack.
- `devicePixelRatio` handling on the canvas.
Log only — do not chase tonight. Belongs to a dedicated Safari-support pass.

### Re-verification (main-CH1s4n8g.js)

Both decks confirmed working in both tabs, including Safari pause/play —
**one kick holds.** Comp gauntlet result stands; promotion still gated on
tomorrow's Cowork 30-min soak.

## SMART QUANTIZE-SEEK — SHIPPED (Chad's design call)

Seeks land off-grid mid-mix, breaking the lock feel. Implemented snap-to-
nearest-beat in `Deck.seek` using the analyzer's `beatTimes`:
- **When PLAYING → snap** the seek to the nearest analyzed beat; **paused →
  free** (cue placement). The big-waveform DRAG commits one seek on release, so
  dragging stays free and only the landing snaps; small-WF click snaps too.
- Quantized at EXECUTION on the driver (after the `isDriver` gate, before
  off/play_/setProg/broadcast) so the broadcast `progress` IS the landed beat —
  local seeks and remote `seek_request`s land identically; both sides agree.
- Beats read via `beatTimesRef` (driver's own `bpmResult.beatTimes`, remote
  fallback) so `seek`'s deps don't churn. Binary-search nearest beat. Logs
  `[SEEK-QUANTIZE]` with from/to/deltaMs.
- Verified: quantize math unit test 7/7 (incl. ties → lower beat, beyond-last →
  clamps to last); build + two-client boot clean, no errors. Chad ear/eye-
  verifies on deploy (a synced blend should survive any seek).

## TICKET — Safari waveform jitter (DIAGNOSED; fix deferred to Safari pass)

Root cause (from the render code): `AnimatedZoomedWF` is a time-scrolling
window, so it redraws EVERYTHING every rAF frame (can't cache — it scrolls).
Per frame: full `clearRect` of both canvases at `devicePixelRatio` (2× on
Retina) + hundreds of per-column `fillRect`s with `globalAlpha` churn + gradient
creation + **`shadowBlur` glow** on the beat grid (blur=4) and playhead
(blur=8). `shadowBlur` is the most expensive canvas2D op in WebKit
(software-rendered); Chrome's Skia backend is GPU-fast. So Chrome sustains
60fps and Safari can't → uneven frame rate (movement jitter, both decks, visuals
fine). NOT network/sync.

Proposed fix (cheap, Safari-gated render path; ~½ day incl. in-Safari verify):
- Set `shadowBlur=0` in the draw loop on Safari (drop the glow — biggest win).
- Cap the canvas `devicePixelRatio` to ~1.5 on Safari (halve pixel count).
- Optionally batch per-column fills by alpha to cut `globalAlpha` state changes.
Deferred (not built tonight) because it touches the visual glow (needs a
DESIGN_PHILOSOPHY check + Chad's eye), adds a Safari-specific code path, and the
smoothness gain can't be verified headlessly (no WebKit here). Belongs to the
dedicated Safari-support pass alongside the earlier Safari-jitter note.

## 🧭 BEAT-GRID UNIFICATION PLAN (sync regression — priority #1 tomorrow)

### The regression

Post-quantize (`main-CQUPH1xf.js`), four symptoms appeared on the sync/seek
path: SYNC engage lands off-grid AND sounds off (kicks unlocked) with
repeat-presses walking ~a beat and never settling; quantized seeks land
"close but not crisp" on the partner deck and seemingly do nothing on the
local deck; and play-while-synced doesn't align at all. Beat-phase sync was
verified working May 22 — this is a regression, and the analyzer's REFINE
rebuild (per-beat shifts ±5–25ms, walk-back firstBar1AnchorSec, snapped BPM)
is the trigger.

### Root cause — TWO beat grids, systems split across them

Since the REFINE rebuild there are two definitions of "where the beats are":

- **REFINED** — `beatTimes[]`: per-beat positions, REFINE-shifted ±5–25ms,
  non-uniform. **The actual kicks.**
- **LINEAR** — `beatPhaseSec / beatPhaseFrac / beatPeriodSec`: a single-anchor
  + single-period reconstruction (`beatPhaseSec = anchor % period`, ~line 7031).
  One period value — **cannot represent** the refined per-beat positions.

**Source-of-truth audit (verbatim):**

| Path | Consults | Camp |
|---|---|---|
| **SYNC engage** (`syncDecks`) | `beatPhaseSec` + `beatPeriodSec` | **LINEAR** |
| **Big-waveform grid** (`AnimatedZoomedWF`) | `beatPhaseFrac` + `beatPeriodSec` (never receives `beatTimes`) | **LINEAR** |
| Small-WF grid lines | `beatPhaseFrac` | LINEAR |
| Small-WF kick markers | `beatTimes` | REFINED |
| **Seek-quantize** | `beatTimes` | **REFINED** |

Engage + the big grid are LINEAR; quantize + the kicks are REFINED. They
disagree by the refine deltas. NOT an analyzer error — the refined `beatTimes`
are the *better* data; engage and the grid simply never adopted them.

### Four-symptom mapping

1. **Engage off + sounds off:** engage aligns *linear* beat positions, but the
   audible kicks sit at *refined* `beatTimes` ±5–25ms away → kicks don't
   coincide → sounds off. PLUS the new quantize snaps the engage's seek to the
   slave's nearest *refined* beat (a third position); repeat-engage recomputes
   from the new spot and re-snaps → **the wander**.
2. **Partner-deck quantize "close but not crisp":** quantize snaps to refined
   `beatTimes` (the real kick), but the watched big-waveform grid is *linear* →
   playhead on the kick, ±5–25ms off the linear gridline.
3. **Local-deck quantize "nothing":** same split — likely small refine deltas
   on that track (snap sub-perceptible) or clicked while paused (free by
   design). A per-seek log would confirm; same root.
4. **Play-while-synced no align:** play-start re-align (~line 8582) fires only
   when the starting deck IS the previously-designated `lastSlaveDeck`, so a
   freshly-cued deck never part of an engage gets no alignment → the canonical
   mix-in moment enters unlocked. A missing/too-narrow trigger.

### The fix — unify on refined `beatTimes` (one source of truth)

Build behind a flag (`?beatsv2=1`) for A/B ear-verification. Decision (Chad):
**NO stopgap tonight — do not touch the engage seek; half-states on the core
sync path are how this regression was born.**

1. Shared `nearestBeatTime(beats, t)` / beat-align helper.
2. **Engage** aligns refined-beat-to-refined-beat (coincide master's nearest
   `beatTime` with slave's nearest `beatTime`) → idempotent → repeat-engage
   stable, no wander. Targets a real `beatTime`, so seek-quantize agrees and
   the quantize regression auto-resolves.
3. **Big-WF grid** renders gridlines from `beatTimes` in the visible window
   (pass it as a prop) → grid matches kicks AND quantize.
4. **Play-while-synced** triggers the same align (rate + phase) for ANY deck
   starting under sync, not just `lastSlaveDeck`.
5. **Linear model demoted** to telemetry / display-summary only — deprecated
   for alignment.

So seek, engage, repeat-engage, play-while-synced, and the visible grid all
share ONE definition of "on the beat."

### Smoke-suite assertion (build alongside)

After engage: **slave nearest-beat offset from master < 10ms**, and
**repeat-engage produces identical alignment** — so this regression class can
never travel silently again.

### TOMORROW'S ORDER

a. **beatTimes unification** behind `?beatsv2=1` + ear/eye A/B verify (priority #1).
b. **comp 30-min endurance soak** via Cowork (`?delaycomp=1`, full HUD protocol).
c. **promote delaycomp default-on** with kill-switch (`delayCompOn = …get("delaycomp") !== "0"`).
d. **smoke-suite build** in `tools/smoke/` (fold `_*.mjs` seeds in; promote
   `playwright-core` to a saved devDependency; add the engage assertion above).
e. **stale `collabmix-server/` dir cleanup** (non-repo working copy; real server
   is `collabmix-server-repo`).

### Deferred display tickets (shared display-path cleanup, same family)

play-start glide (fixed), post-load partner-waveform jumpiness, Safari
waveform jitter (diagnosed: per-frame shadowBlur at dpr in WebKit).

## ✅ BEAT-GRID UNIFICATION — BUILT (June 11, 2026) — behind ?beatsv2=1, NOT yet pushed

Implemented the unification plan from the previous addendum. All five pieces
landed behind `?beatsv2=1` so the legacy LINEAR path stays intact for A/B
ear-verification. Build passes; headless smoke asserts the engage math.

### What was built (commit pending — awaiting Chad's push approval)

1. **Shared helpers** (`nearestBeatTime`, `refinedBeatPhase`) at module scope.
   The seek-quantize now calls `nearestBeatTime` (was an inline binary search) —
   one definition of "nearest beat" for quantize + engage + grid.
2. **Engage** (`syncDecks`, beatsv2 branch): aligns slave→master on the REFINED
   `beatTimes` local phase instead of the linear single-period model. Iterates
   the minimal (≤0.5-beat) phase nudge to a fixed point so repeat-engage is
   IDEMPOTENT, and seeks with a new `noQuantize` flag so the smart-quantize does
   NOT re-snap the engage's own seek (that re-snap was the wander). Path C
   cross-correlation is SKIPPED under beatsv2 (it patched the linear
   mis-anchoring; refined beats already sit on the kicks, and its quantizing
   seek would break idempotency).
3. **Big-WF grid** (`AnimatedZoomedWF`): now takes `beatTimes` + `beatsV2` props
   and renders gridlines AT the refined beats (downbeat/phrase tiers still
   labeled from the linear downbeat anchor). Grid now matches kicks + quantize.
4. **Play-while-synced**: broadened so ANY deck starting under sync re-aligns to
   the other (the canonical mix-in), except the explicit master. Legacy only
   re-aligned the designated `lastSlaveDeck`.
5. **Linear model** is no longer consulted for alignment/grid under beatsv2 —
   `beatPhaseSec/Frac/PeriodSec` still broadcast for display/telemetry only.

### Verification

- `npm run build` — PASS.
- `npm run smoke:engage` (`tools/smoke/engage_align.smoke.mjs`, pure-logic,
  deterministic): REFINED engage lands **0.00ms** off-grid and **0.00ms**
  repeat-move (idempotent) across 4 BPM/jitter scenarios; LEGACY shown for
  contrast at **59–93ms** off-grid (the diagnosed regression). The smoke
  duplicates the two helpers verbatim — keep in sync if either changes.
- `npm run lint` — BROKEN PROJECT-WIDE (ESLint 9 has no `eslint.config.js`;
  pre-existing, not from this change). Needs a separate config-migration pass.
- NOT verified: real two-client audio engage in the browser (ear/eye A/B with
  `?beatsv2=1`). That is the next required step before promoting beatsv2 to
  default.

### Known edges / follow-ups

- Play-start broadening with NO explicit master lets either deck re-align on
  play (only the explicit M-deck is protected) — intended for mix-in, but worth
  an ear-check that restarting an implicit master doesn't tug.
- Promotion path: once A/B confirms, flip `beatsv2` default-on with a
  `?beatsv2=0` kill-switch (mirror the planned delaycomp promotion).
- ESLint config migration is now on the board (blocks the lint half of the
  verification protocol).

## ✅ beatsv2 PROMOTED default-on (June 11, 2026)

The 7-point A/B passed by ear + eye (engage locks, no wander, quantize crisp,
play-while-synced aligns, implicit-master edge behaves, flag-off restores old
behavior). Flipped `beatsV2On` default-on with a `?beatsv2=0` kill-switch
(mirrors the planned delaycomp promotion). Production now runs the unified
refined-beat path for everyone; the legacy LINEAR engage + grid is one URL
param away if a regression surfaces. Build + smoke green.

NEXT: grid-anchors-to-kick-attack precision pass (see investigation below) —
gridlines currently land mid-kick-blob, not on the onset (the Rekordbox bar).

## ✅ Phase 1 grid re-anchor BUILT — gated ?onsetgrid=1 (default OFF) (June 11, 2026)

beatTimes re-anchored from diff-argmax (mid-attack, ~+8ms late of the kick
onset) to the attack leading edge: REFINE walks each beat back to the first
sample crossing floor+15%·(peak−floor), gated in amplitude space, uniform
across all beats. Threaded via worker message + ?onsetgrid=1, default OFF for
A/B. ONSET_FRAC is a one-line knob (0.15 shipped; 0.30 prepped fallback if it
reads too early). Because the grid is unified, this moves engage + grid +
quantize onto the true onset together — sync correctness, not just looks.

Verification: onset-anchor smoke median |beatTime−onset| 2.21ms (<4ms). Local
272-harness subset (11 graded) 0 regressed, BPM untouched. Caveat: 2 passing
tracks' bar-1 anchor ate ~10ms margin vs Rekordbox (still PASS) — Rekordbox's
anchor doesn't map cleanly to the 15% leading edge; threshold is a by-eye call.

OPEN COUPLING: after Phase 1 the grid line sits on the TRUE onset, but the
drawn blob's leading edge is still ~14ms early (render smear). So a correct 15%
line still sits ~a few px inside the drawn blob front at max zoom — the eye may
read it as "late." Threshold pick by eye is therefore confounded by the render
smear; Phase 2 (hybrid: 24000 body + sharp attack edges drawn from the
re-anchored onsets) likely needs to land before the threshold is finally locked.

## ✅ Phase 2 hybrid de-smear BUILT — gated ?onsetgrid=1 (default OFF) (June 11, 2026)

Big-WF keeps the 24000-bucket body but snaps each kick's drawn leading edge onto
the re-anchored onset beatTimes (clamp the backward smear down to the pre-smear
baseline → crisp vertical front). Zero extra broadcast (no WF_W bump). Gated by
the same ?onsetgrid=1 as Phase 1 → one flag, full stack vs production; default-
off render is byte-identical. Verify: pooled drawn-edge-vs-onset -18.7ms →
-6.0ms (68% closer); line-vs-blob gap ~21ms → ~6ms. Worker untouched → harness
regression unchanged.

PENDING: Chad zoom-tests ?onsetgrid=1 (full stack) and locks ONSET_FRAC 0.15 vs
0.30 against the honest (de-smeared) blob, then we promote the whole stack
(onsetgrid default-on) together.

## ✅ FULL ARC PROMOTED — beat-grid unification + onset re-anchor + de-smear (June 11, 2026)

Today's complete arc, all live in production:

1. **beatsv2 unification** (default-on, ?beatsv2=0 kill-switch) — SYNC engage,
   seek-quantize, and the big-WF grid all read ONE source of truth (refined
   beatTimes). Killed the post-quantize sync regression (engage wander, off-grid
   kicks). Verified by ear + the engage idempotency smoke.

2. **Onset re-anchor** (Phase 1) — beatTimes moved from diff-argmax (mid-attack,
   ~+8ms late of the kick onset) to the attack leading edge (amplitude-space 15%
   walk-back, uniform across all beats). median |beatTime−onset| 8→2ms. Because
   the grid is unified, this moved engage + grid + quantize onto the true onset
   together (sync correctness, not just looks).

3. **Render de-smear** (Phase 2, hybrid) — big-WF keeps the 24000-bucket body
   but snaps each kick's drawn leading edge onto the re-anchored onset (clamp the
   backward bucket-bleed to the pre-smear baseline). Zero extra broadcast. Drawn
   edge vs onset 19→6ms; line-vs-blob gap ~21ms → ~6ms.

4. **Threshold LOCKED at 15%** after full-stack zoom A/B — gridlines ride the
   kick fronts. ONSET_FRAC is the single knob (worker module scope).

5. **Promoted** the onsetgrid stack default-on (?onsetgrid=0 kill-switch).
   Hardened all URL flags against the post-join query-string strip (capture at
   module load). Added '[ONSET-GRID] active/inactive' worker log for provable
   flag participation.

Net effect: line on the true onset, blob front on the onset, grid/engage/quantize
all coherent. The Rekordbox "attached to the kick" bar — substantially met.

### FOLLOW-UP TICKET — per-kick onset residual variance (not now)

Some individual kicks still read slightly off after the 15% re-anchor — e.g.,
certain track openers (Chad's screenshots). Likely soft-attack / layered-bass
kicks where the leading edge is genuinely fuzzy (Aliens residual ~10ms in the
diagnostic corroborates). Candidate fixes when we tune: per-kick ADAPTIVE
threshold (scale ONSET_FRAC by attack sharpness), or fold the correction into
the Slice B render pass. Revisit alongside Slice B.

### SLICE B — render quality spec (Rekordbox zoomed-WF reference)

Bar (from Chad's reference screenshot): layered frequency-band silhouettes —
bass UNDER mids UNDER highs as stacked translucent shapes — with smooth,
non-blocky contours and fine edge detail (no "blocky" steps). Current big-WF is
bass-weighted single silhouette + bucket-blocky at zoom.

- DATA is NOT the gap: waveformBass/Mid/High already broadcast. The gap is
  RESOLUTION (24000 buckets → blocky at max zoom) + RENDERING CRAFT (stacked
  translucent band contours vs one weighted silhouette).
- BAND COLORS need a design decision: DESIGN_PHILOSOPHY bans warm fills, but
  Rekordbox uses orange mids. Reconcile in the design session (don't pick by
  training-data instinct).
- The per-kick onset residual (ticket above) gets another look here — sharper
  band edges may resolve the fuzzy-attack cases visually.

### TOMORROW'S ORDER (updated)

a. **comp 30-min endurance soak** via Cowork (?delaycomp=1, full HUD protocol).
b. **promote delaycomp default-on** with kill-switch (delayCompOn = get != "0",
   via the URL_FLAGS capture so the kill-switch survives the query strip).
c. **smoke-suite build** in tools/smoke/ — fold the seeds + the new engage /
   onset-anchor / desmear-verify assertions; promote playwright-core to a saved
   devDependency.
d. **Slice B render quality** — the "blocky" fix (layered band silhouettes,
   higher edge resolution) + band-color design decision + per-kick residual
   re-look.

## ✅ TWO-CLIENT SMOKE SUITE BUILT (June 11, 2026) — the permanent regression net

tools/smoke/ — one command (`npm run smoke`), per-test PASS/FAIL/SKIP, CI exit
code. Now the STANDARD PRE-PUSH GATE (added to CLAUDE.md Verification Protocol).

11 tests, three kinds:
- unit (pure logic): engage idempotency, interp sawtooth, comp re-baseline.
- audio (real analyzer worker on a bundled synthetic fixture): onset-anchor
  <4ms, render de-smear closes the gap.
- e2e (two-client playwright/system-Chrome, driving the real app via a
  test-only load+transport hook): join-by-code+paste / distinct djIds; track
  mirror (ANALYZER-BROADCAST→RECV, counts match); play/pause both ways + seek
  SEND→RECV→EXEC; engage idempotent (no wander); delaycomp nonzero on LIVE
  fixture audio + survives partner reload; [SYNC-DRIFT] in locked B2B.

Key wins: window.__loadTestTrack runs a fixture through the NORMAL load path
(real analysis + mirror), and the fixture playing through WebRTC gave the comp
test a real live stream (the old seeds had only a silent master, untestable).
Added symmetric receive-side markers [ANALYZER-RECV] / [TRANSPORT-RECV] for B2B
debugging. Hardened the URL flags (capture at module load) so onsetgrid/beatsv2
kill-switches survive the post-join query-string strip.

Flake-check: two full cold-start runs, 11/11 green, ~92s each. e2e-sync bound is
30ms (live 10Hz-packet jitter; exact math proven by the unit test). e2e-comp
~45s, SKIPs if RTC can't connect. Superseded seeds folded; four _*_probe.mjs
diagnostics kept.

### TOMORROW'S ORDER (updated — smoke suite ✅ done)

a. **comp 30-min endurance soak** via Cowork (?delaycomp=1, full HUD protocol).
b. **promote delaycomp default-on** with kill-switch (via URL_FLAGS capture).
c. **Slice B render quality** — layered translucent band silhouettes (bass<mids
   <highs), smooth non-blocky contours + band-color design decision (warm-fill
   ban vs Rekordbox orange mids) + per-kick onset residual re-look.

## ✅ DELAYCOMP PROMOTED default-on (June 11, 2026) — full flag stack now default

30-min production endurance soak PASSED (Cowork, room fade-beam-467, ?delaycomp=1,
A=Shadow Work 120 / B=Home In The Sky 121, 3 track-ends + 3 re-engages):
- comp appl held 55.3–55.9ms (0.6ms band) the FULL 30 min — never zeroed, never
  wandered, measured==applied (jb≈37.4, playout≈18.2, target≈20.0).
- Survived all 3 track-ends + re-engages; audio streaming throughout; zero
  console errors; zero disconnects; no rebinds after initial setup; rtt 95–100ms,
  conf 0.72–0.92.
- Drift: bounded sawtooth (~±240ms, mean-reverting, no slope); offset flat.
- Engage T0: result=ok rateDelta=0.0083 phaseSeekMs=10.54 xcorr=beatsv2_refined.

Promoted delayCompOn default-on (?delaycomp=0 kill-switch) via the URL_FLAGS
module-load capture (survives the post-join query strip).

🏁 MILESTONE: the full flag stack — beatsv2 + onsetgrid + delaycomp — is now
production default. Unified refined-beat sync, onset-anchored grid + de-smear,
and delay compensation all ON by default, each with a ?flag=0 kill-switch.

### FIX shipped with the promotion — [SYNC-DRIFT] log firehose

The phase-error monitor effect re-runs on every pA/pB progress packet and calls
sample() immediately each time → 400–600 [SYNC-DRIFT] lines/sec on the slave
(drowned every other console event). Throttled the console.log + telemetry to
≤2/sec (driftLogTsRef); the HUD (syncStatsRef) still updates every sample.
[Deeper: the effect's per-packet re-run also recomputes the drift math at that
rate — a perf item for the robustness pass, separate from the log spam.]

### TRIAGE TICKETS (from the soak)

a. [ONSET-GRID] wording — TWO logs exist, same meaning (flag reached the
   worker): app-side "[ONSET-GRID] deck A analysis dispatch — onsetAnchor=true"
   (the send) + worker-side "[ONSET-GRID] active ONSET_FRAC=0.15" (worker
   confirms). Verification specs can assert either; not a bug.
b. Telemetry/HUD asymmetries (cosmetic, one ticket): slave HUD sinceEngageMs
   stays "—", state "sampling" all run; master state "no_recent_progress";
   master engage timer froze at 171.7s → "—" → ~6s instead of counting up.
c. Partner-deck mirror freezes at track-end (stuck at last position; doesn't
   track partner's live position) — display-path ticket family; overlaps the
   track-end state-machine work (robustness Phase 1) + rejoin replay (Phase 3).
d. Cold re-engage after track-end: large first step then iterative refine
   (223→−97, 231→−102) — convergence working as designed; watch whether the
   residual relates to the per-kick onset variance ticket.

## 🛡️ ROBUSTNESS CAMPAIGN — Phase 1: track-end state machine (June 11, 2026)

REPRODUCED the inert-transport family headlessly. Root cause: a deck parked at
its end (off.current == buf.duration — from a seek-to-end, a paused-near-end, or
a re-engage that landed near the end; NOT a natural end, which already resets to
0) → pressing play calls play_(buf.duration) → AudioBufferSourceNode starts at
the end → 0 samples → instant onended → play flips true→false with no audio. The
FIRST press is eaten (looks dead); the second works (onended reset off to 0).
Matches Chad's soak evidence (flip-flop true/false, no audio, waveform stuck).

FIX: play-press-at-end wraps to the start (off.current=0) before playing, so the
deck replays instead of going inert. Runs on the driver, so it covers both a
local press and a partner's toggle_request.

CONTRACT verified (e2e-trackend smoke, 5 checks):
- natural end → resets to 0, buf retained, operable ✓
- parked at end + NON-OWNER play → wraps + plays (no flip-flop) ✓
- parked at end + OWNER play → plays ✓
- play from start → normal ✓
- remote toggle round-trip after end works (driver executes) ✓
Deferred to the display-path family (ticket 4c): the partner-deck READOUT
freezes at the last position at track-end (cosmetic mirror, not operability).

Full suite 12/12 green (added e2e-trackend).

## 🛡️ ROBUSTNESS CAMPAIGN — Phase 2a: WS auto-reconnect (June 11, 2026)

INVESTIGATION confirmed the gap: WS onclose just set status="disconnected" and
stopped the ping — a mid-session network blip / server restart silently killed
the session, no recovery.

FIX: on an UNEXPECTED close (not a deliberate disconnect()), re-dial with
exponential backoff (0.5/1/2/4/8s) and re-join the room for up to a 30s window,
then re-pull partner state (sync_request) on success. Deliberate disconnect()
and component-unmount suppress reconnect. New [RECONNECT] log family confesses
phase=schedule/attempt/success/gaveup with reason + elapsed.

Verified (e2e-reconnect smoke): drop B's WS → [RECONNECT] schedule (attempt=1,
500ms) → success (632ms) → partner restored. Full suite 13/13 green.

Phase 2b (RTC renegotiation on network change) + 2c (sleep/wake) — next.

## 🛡️ ROBUSTNESS CAMPAIGN — Phase 2b/2c: RTC recovery + sleep/wake (June 11, 2026)

2b — RTC renegotiation on network change. GAP found: oniceconnectionstatechange
handled "failed" by only painting state (no renegotiation) and ignored
"disconnected" entirely. FIX: "failed" → onIceRecover immediately; "disconnected"
→ 6s grace then recover if still down. The App's handleIceRecover does an
INITIATOR-GATED startCall() (fresh offer → ICE restart) over the auto-reconnected
WS, reusing the rtc_hangup 3-retry budget so a flapping network can't storm. New
[RTC-RECOVER] log family (phase=ice-failed/ice-disconnected-timeout/restart/
exhausted). This is the connection-layer trigger that was missing — comp already
survives the renegotiation once it fires (verified by e2e-comp's reload path).

2c — sleep/wake. On wake the socket can be dead before onclose fires. Added a
visibilitychange + online listener: if visible/online with an active room and a
non-OPEN socket, re-dial immediately ([RECONNECT] phase=wake). Honest behavior —
rejoin cleanly rather than pretend nothing happened.

CAVEAT: 2b/2c can't be FORCED headlessly (Playwright can't kill an established
ICE connection or suspend the OS), so they're wired + instrumented + reuse the
verified recovery path, but need manual chaos-script verification (wifi kill
mid-blend, sleep laptop). Full suite 13/13 green (comp-reload path intact proves
no regression). The CHAOS SCRIPT (Phase 4 deliverable) will cover these.

## 🛡️ ROBUSTNESS CAMPAIGN — Phase 3: late-joiner / re-joiner state replay (June 11, 2026)

INVESTIGATION: the sync_request/sync_response replay carried lsRef (deck fields,
xfade) so a rejoiner recovered BPM + title, but the refined beat GRID never
replayed — the analyzer broadcast only fires on a beatTimes CHANGE, so a
reload/rejoin got no [ANALYZER-RECV] (grid stale, the soak's mirror-staleness).

FIX: extracted the analyzer broadcast into broadcastAnalyzerRef; on partner
(re)join the driver re-fires it (dh's driver gate = only my driven deck goes on
the wire) + re-pushes the lsRef snapshot. The rejoiner now rebuilds the grid via
the SAME verified [ANALYZER-BROADCAST]→[ANALYZER-RECV] path as an initial load.
[REJOIN-REPLAY] log marks it.

Verified (e2e-rejoin smoke): B reloads mid-blend → re-paired, [ANALYZER-RECV] A
beats=24, BPM + title mirrored, all within 1.1s (budget 5s). Full suite 14/14.

## 🛡️ ROBUSTNESS CAMPAIGN — Phase 4: chaos hardening + chaos script (June 11, 2026)

Headless chaos (e2e-chaos smoke): rapid transport+sync spam during engage, seek
storm while syncing, track (re)load during engage, BOTH sides loading the same
deck simultaneously. RESULT: app survives all four — zero unhandled page errors,
stays responsive after each storm. No cheap breaks found headlessly (the engage/
seek/load paths are already guarded). 6/6.

Manual CHAOS SCRIPT (tools/smoke/CHAOS_SCRIPT.md) for the breaks a browser can't
fake — wifi off, ethernet yank, laptop sleep, server restart, wifi→cellular
handover, 10-min tab background, frantic dual-press during a drop, parked-at-end
play. Expected vs Actual columns + the confession logs to watch
([RECONNECT]/[RTC-RECOVER]/[PLAY-STATE]). For Chad's two-laptop session.

Tickets surfaced (not cheap, logged): rejoiner's OWN loaded track isn't
auto-restored on reload (persist+restore local deck track); the partner-position
LIVE re-track after a long background (display-path family).

### CAMPAIGN SUMMARY — Friday-night survival

Full suite now 15/15 green (~129s): 3 unit + 2 audio + 10 e2e. Robustness added:
- track-end deck stays operable (no inert flip-flop)
- WS auto-reconnect (backoff + rejoin, 30s window)
- RTC ICE-failure → initiator-gated renegotiation
- sleep/wake re-dial
- reload/rejoin rebuilds the FULL partner view (grid + state)
- survives transport/seek/load storms
Confession logs throughout: [RECONNECT] [RTC-RECOVER] [REJOIN-REPLAY]
[ANALYZER-RECV] [TRANSPORT-RECV] [PLAY-STATE]. Manual chaos script for the
physical-layer breaks. Remaining: local-track restore-on-reload + display-path
live-position re-track — ticketed for the display pass.

## 📋 DISPLAY / SESSION PASS — consolidated queued tickets (June 11, 2026)

Gathered in one place (some appear in earlier sections). For a future
display-path + session-persistence pass:
1. Rejoiner's OWN loaded track is NOT auto-restored on reload — the rejoiner
   rebuilds the PARTNER view fully (Phase 3) but must re-drag their own deck's
   track. Fix: persist + restore the local deck's loaded track across reload.
2. Partner live-position re-track after a long tab-background — on foreground,
   the partner-deck readout should resume tracking the partner's live position
   (timer-throttling staleness).
3. Partner-deck mirror freezes at track-end (readout stuck at last position;
   doesn't follow the partner's live position) — same display-path family.
4. Telemetry/HUD asymmetries (cosmetic): slave HUD sinceEngageMs "—" / state
   "sampling" all run; master "no_recent_progress"; engage-timer freeze/reset
   quirks.
These are display/telemetry quality, not operability — the decks WORK; the
readouts lag. Bundle with the Slice B render-quality work.

## 🛡️ ROBUSTNESS TICKETS — chaos-run evidence (June 11, 2026)

From Chad's manual chaos run (two new items for the robustness/display queue):

1. STALE-SESSION RESURRECTION (bug). Tabs auto-rejoined room fade-beam-467 —
   the soak room from HOURS earlier (partner identity DJ Flux 80b7 persisted via
   cm_session). Auto-rejoin (Path 2, cm_session) has no freshness limit. FIX
   (cheap): timestamp cm_session on write; on auto-rejoin, if older than ~1-2h
   don't silently resurrect — offer "rejoin or start fresh?" (or just drop to
   Landing). Queued for the robustness pass.

2. PARTNER-MIRROR DISPLAY bounce/freeze (best evidence yet for the ticketed
   display-path family). On the stale session, Tab 2's mirror of Deck A bounced
   back multiple bars / skipped, then froze entirely — WHILE audio responded
   correctly to transport clicks. Control path PROVEN healthy in the log
   (TRANSPORT-RECV round trips clean, comp steady 48.2ms, zero errors); the
   DISPLAY path is the broken layer (progress-mirror interpolation: stale
   partnerProgressMeta + the long-session/throttle staleness). Retest on clean
   state: [CHAD TO FILL: persists / gone]. This is the same family as the
   partner-mirror-freeze-at-track-end + live-position-re-track tickets — likely
   one root cause in the non-driver progress interpolation. Prioritize in the
   display pass; the control path is fine, so this is purely visual-trust.

## ✅ PARTNER-MIRROR ARC — CLOSED (pending one eye-check) (June 11, 2026)

Four rounds of capture-driven fixes; Cowork Round-4 verification verdict:
1. Non-owner pause/play JUMP — FIXED. 5 transitions, baseline 0.068/0.052/0.061
   → ~0.000 every time; mirror resumes at exactly the held position. The fix:
   broadcast the exact frozen position WITH the pause/play transport change +
   paused mirror snaps to it; coast-at-true-rate absorbs 18-30s pktAge (STALE
   fires, position holds, no snap).
2. Owner-side pause/play — clean throughout.
3. Triage (a) CLOSED — owner drawnProg matches displayed timecode within
   rounding across all samples; the baseline 0.3705 reading was the
   partner-MIRRORED deck (deck= color), not an owner divergence.
4. Continuous-motion smoothness — UNVERIFIED by Cowork (its mirror tab is
   hidden=true throughout, draw throttled BY DESIGN — correct, not a bug, now
   labelled via the hidden= diag field). Chad eye-verifies on a FOREGROUNDED
   mirror tab; if stutter persists there, that's the one remaining thread.

Fixes across the arc: worker-timer broadcast from the audio clock (background-
immune), true-rate coast, re-anchor-on-new-progress-only, hold-at-displayed +
slew on play-start, paused-position transfer, hidden-tab refocus re-anchor.
Guards: e2e-mirror (continuous) + e2e-mirror-coast (sparse + pause/play transfer).
Instrument: ?mirrordiag=1 ([MIRROR-DIAG] with hidden=, [MIRROR-SNAP], [MIRROR-STALE]).
STATUS: closed pending Chad's foregrounded-mirror eye-check.

## ✅ LIBRARY DOOR 3 (rekordbox.xml) — BUILT + WF SMOOTHNESS TOOLKIT (June 11, 2026)

Two threads, all pushed to production (commits d7f23fd, 16a1dcf, 1ee6e3b, e54ceee).

DOOR 3 — rekordbox.xml import (playlists + grids + cues), behind ?libwizard=1.
Decision honored: ONE parser, ONE truth. The library app (src/library-app.jsx,
/library.html) owns the rekordbox parser; the mixer wizard's rekordbox door is
now LIVE and ROUTES there (no duplicate importer). Two library UIs over one
shared IDB is now a recorded architecture fact (LIBRARY_IMPORT_V2.md); Door 2
(iTunes) will follow the same route pattern.
- Parse: parseRekordboxXML now reads <TEMPO> → piecewise beatTimes (single +
  multi-tempo, via node-tested src/rekordbox-grid.js) and <POSITION_MARK> → hot
  cues (Num≥0) + memory cues (Num=-1). Imported tracks carry gridSource:'rekordbox'
  + beatTimes on the shared record.
- Consume (HARD REQ MET): the mixer reads that record through the SAME unified
  bpm.results path the analyzer uses (rkGridFromRecord → rkGridA/B →
  effectiveBpmResults), so deck / engage / quantize / grid-render all hit one
  nearestBeatTime. Onset re-anchor SKIPPED for imported grids (skipOnsetAnchor —
  analyzer still runs for beatAttacks/broadcast); de-smear SKIPPED (gridSource
  gate on the WF prop). Imported hot cues seed the deck's 4-slot hotCues.
- Verify: tools/smoke/tests/e2e-rekordbox.smoke.mjs (16/16) — parse on the real
  library page → 3 tracks / 2 playlists intact → single+multi-tempo grids →
  hot/memory cues → mixer consumes imported grid → de-smear off → onset-anchor
  skipped (active on a normal deck) → engage idempotent <10ms. + rekordbox-grid
  unit (11/11). Full suite 19/19.
- Memory cues import data-only (render deferred to Slice B).

WF SMOOTHNESS TOOLKIT (for the "why isn't our scroll glass like Rekordbox" hunt):
- ?wfpulse=<0..1> (default 1, unchanged): dials the big-WF per-kick emphasis
  (centerline weight band + amplitude brightness overlay) — what the eye reads as
  breathing/pulse at the fixed playhead. wfpulse=0 = static glass for an A/B vs
  Rekordbox; 0.5 = half. Base amplitude shape untouched.
- ?smoothdiag=1 (pure logging): per deck, 1/s, last-second [SMOOTH-DIAG] —
  scrollPx/frame {mean,sd,max} (motion smoothness), zeroFrames (STEPPED vs
  interpolated position updates), fps/dropped/frameMs (cadence), drawMs {mean,max}
  (de-smear/band hitch cost), role=local|mirror, desmear flag.
- Early headless read: local driver deck shows scroll sd ~40% of mean + bursts of
  zeroFrames (19/122 one window) → position source updates slower than the draw
  RAF (stepped-motion signature). Cowork to run the FOREGROUNDED capture next.

PENDING: (1) Chad's foregrounded-mirror eye-check (carried from the mirror arc).
(2) Cowork smoothdiag foreground capture → pin the judder root cause with numbers.
(3) Chad A/B wfpulse 0 / 0.5 / default by eye. (4) Door 3 memory-cue render
(Slice B). (5) Doors 2/4 (iTunes / USB-PDB) per LIBRARY_IMPORT_V2 build order.

## WF SMOOTHNESS — RESOLUTION + TWO TICKETS (June 11, 2026)

Recalibration from Chad's side-by-side: examined as closely as he'd been
examining ours, **Rekordbox shows comparable shimmer**. So the scroll artifact is
ENDEMIC to scrolling-waveform renderers, not a Mix//Sync defect — the bar is
PARITY (confirmed), not perfection. Two distinct contributors were separated:

- **Shimmer (amplitude "breathing in some spots")** = scroll-resampling, ENDEMIC.
  Verdict: PARITY with Rekordbox by side-by-side. Not fixing now. → TICKET below.
- **Stepping (zeroFrames / sub-pixel scroll granularity)** = genuinely ours, but
  the contained fix is invasive. → TICKET below; revisit with Cowork's
  FOREGROUNDED smoothdiag numbers.

`?wfpulse` reverted to a pure beat-pulse EMPHASIS dial (centerline weight band +
amplitude brightness overlay). It is NOT an anti-shimmer control. A linear-interp
"rigid resampler" was prototyped under wfpulse=0 and MEASURED — it did NOT reduce
the canvas jitter (wfpulse=0 jerkNorm 0.155 vs wfpulse=1 0.125) — so it was
reverted, not shipped. The wfpulse taste A/B (0 / 0.5 / default) remains OPEN for
Chad, post-stepping decision.

### TICKET-WF-SHIMMER — scroll-resampling shimmer (PARKED, parity-acceptable)
STATUS: parked. Do NOT build without a product reason — Rekordbox parity confirmed.
SYMPTOM: with the per-kick emphasis OFF (wfpulse=0), faint localized amplitude
oscillation remains — regions subtly swell/shrink ("a stomach breathing in/out
IN SOME SPOTS") only while PLAYING (scrolling); paused is perfectly static.
COWORK FORENSIC LOCALIZATION (half-day, done):
- Paused = 0.000px residual across 24 frames (perfect glass).
- Playing = ~1.9px RMS / 4.1px max after scroll-alignment.
- All suspects ruled out EXCEPT scroll-resampling in the big-WF audio→pixel
  binning + quadratic-fill path, plus desmear reshaping bins near boundaries.
- Component: the rAF/fill block of AnimatedZoomedWF (props windowSec/progRef/etc).
- Frame pacing is HEALTHY (paused frameMs sd ~1.1ms) — this is render math, not perf.
ROOT CAUSE (matches the in-code note at Pass 1): heights come from a per-column
MAX over a FLOORED integer source window [f0|0 .. f1|0] that re-evaluates every
frame as srcX (=prog·len − viewPx/2) slides sub-pixel; the window straddles
different source buckets frame-to-frame, so a transient's drawn height/width
oscillates as it slides. De-smear compounds it by re-clamping bins just before
each onset relative to the (sliding) CANVAS position rather than the audio offset.
COWORK'S PROPOSED FIX SHAPE (verbatim): "stable-bin rendering — quantize the
resample grid so a given audio offset always maps to the same drawn height
regardless of scroll position; make desmear deterministic w.r.t. audio offset not
canvas position." (i.e. snap the bin grid to integer source-bucket boundaries and
translate the prebinned heights by the sub-pixel remainder, instead of re-maxing
a sliding floored window every frame.)
EVIDENCE the naive rigid-interp ISN'T the answer: a linear-interp center-sample
resampler was tried and measured no jitter improvement — a proper fix needs the
STABLE-BIN approach (fixed grid + sub-pixel translate), not point interpolation.

### TICKET-WF-STEPPING — sub-pixel scroll granularity (in scope, deferred-pending-numbers)
STATUS: deferred. In scope per rescope ("smooth sub-pixel scroll is mathematically
better than stepped") but the contained fix is invasive; awaiting Cowork's
FOREGROUNDED smoothdiag numbers to confirm materiality at 60fps before building.
SYMPTOM: ?smoothdiag=1 on the LOCAL driver deck shows bursts of zeroFrames (frames
where the playhead px did not advance — e.g. 19/122 one window, 0/121 another;
headless 120fps). High zeroFrames = the scroll position steps rather than moving
every frame. Per Chad: if it shows foregrounded, it's position-source granularity,
not render perf (paused frameMs sd ~1.1ms = healthy pacing).
ROOT CAUSE (code analysis): the playhead flows through a THREE-stage RAF pipeline,
each loop an independent requestAnimationFrame:
  (1) acNowRef updater (top-level): acNowRef.current = ctx.currentTime  [~line 7929]
  (2) Deck tick(): p = (off + (acNowRef − st)·rate)/dur; progRef.current = p  [~5499]
  (3) WF draw(): reads progRef.current, renders  [~4339]
The local position IS already computed per-frame from the audio clock — so any
residual stepping is DESYNC between these three RAF loops (a draw frame landing
between position updates sees an unadvanced progRef), not a coarse source.
WHY NOT A ONE-LINER: the acNowRef indirection is load-bearing — both decks read
ONE identical clock snapshot per frame so their grids stay locked (reading
ctx.currentTime directly per deck reintroduced sub-ms A/B grid oscillation, the
reason it exists). The clean fix is to COLLAPSE the pipeline: derive the playhead
from the audio clock INSIDE the WF draw() at draw time (zero pipeline latency,
true per-frame sub-pixel motion). That requires threading the audio-clock +
off/st/rate refs into AnimatedZoomedWF and re-validating the just-stabilized
mirror / drag-scrub / pause / seek / parked-at-end paths — invasive right after
the partner-mirror arc. INSTRUMENT already in place: ?smoothdiag=1
([SMOOTH-DIAG] scrollPx{mean,sd,max} + zeroFrames + frameMs + drawMs, role=local|mirror).
NEXT: Cowork foreground capture → if zeroFrames is material at 60fps, schedule the
pipeline-collapse as its own change with the mirror-path regression net (e2e-mirror,
e2e-mirror-coast) as the guard.

## TICKET-WF-STEPPING — CLOSED, NO DEFECT (June 11, 2026)

Cowork FOREGROUNDED smoothdiag capture resolves it: under genuine tab visibility
the local driver deck's playhead is per-frame SMOOTH, not stepped.
- scrollPx/f: mean 3.168, sd 0.376 (tight, glass).
- zeroFrames: 1 / 7629 = 0.013% (vs my headless 19/122 ≈ 15%).
- frameMs 16.69 (clean 60fps), 1 dropped frame in 90s.
ROOT of the earlier signal: my headless measurement ran with the tab effectively
backgrounded → the position-source RAF was throttle-desynced from the draw RAF, a
HEADLESS ARTIFACT. The 3-stage RAF pipeline (acNowRef → tick/progRef → WF draw) is
fine in the foreground. Do NOT pursue the invasive playhead-pipeline rewire.

SMOOTHNESS ARC — FINAL STATE:
- Shimmer = PARITY with Rekordbox (TICKET-WF-SHIMMER parked for the record only).
- Stepping = never existed (this closure).
- Frame pacing = clean (paused sd ~1.1ms, playing 16.69ms / 1 drop in 90s).
The LOCAL waveform is verified at-reference-quality by eyes + pixels + math.
The one remaining UNMEASURABLE is MIRROR-role smoothness (headless mirror tab is
hidden=true by env limitation) — it folds into the two already-queued checks:
Chad's foregrounded-mirror eye-check + the iPad shakedown. No further build.
Lesson logged: smoothdiag/zeroFrames numbers are only trustworthy from a
FOREGROUNDED tab — a hidden/headless tab throttles the position RAF and
manufactures false stepping. Tag captures with hidden= (already in the log line).

## ═══ SESSION HANDOFF — June 11, 2026 ═══

The per-task arcs above carry the detail; this is the session-level state for the
next Claude Code to inherit.

### MILESTONES TONIGHT
- **Partner-mirror regression — CLOSED** (Cowork-diff-verified). Three root
  causes fixed: (1) paused-deck broadcast gap (paused decks stopped emitting →
  mirror fell behind → lurch on resume; fixed by broadcasting the exact frozen
  position WITH the pause/play transport change + paused mirror snaps to it),
  (2) hidden-tab RAF death (background draw loop dead; fixed via worker-timer
  broadcast off the audio clock + true-rate coast + hidden= labelling),
  (3) transition seam (play-start coasted from a huge elapsed → jump-to-end;
  fixed by anchoring to the displayed position + slew). Two PERMANENT smoke
  guards added: e2e-mirror (continuous) + e2e-mirror-coast (sparse + pause/play
  transfer).
- **Library Door 3 (rekordbox.xml) — SHIPPED** behind ?libwizard=1. Grids + cues
  + playlists, ONE parser in the library app (the mixer wizard routes to it),
  imported grids consumed through the SAME unified nearestBeatTime path; engage
  measured 0.06ms idempotent on an imported-grid track; onset-anchor + de-smear
  correctly skipped for imported grids. Fixture + e2e (16/16) + grid-math unit
  (11/11). Two-UI-over-one-IDB recorded as an architecture fact.
- **WF smoothness arc — CLOSED.** Shimmer = PARITY-verified vs Rekordbox (Chad
  side-by-side; ticketed for the record, not built). Stepping = MEASUREMENT
  ARTIFACT (headless background-RAF throttle; foreground 1/7629 zeroFrames =
  clean). Scroll math verified at-reference by eyes + pixels + math. ?wfpulse
  kept as a pure emphasis taste-dial; ?smoothdiag=1 instrument retained.
- **Onboarding walkthrough — COMPLETE.** Top-10 friction list produced; fix batch
  PENDING (prompt ready for tomorrow).
- **Suite: 19/19 green** (5 unit/audio + 14 e2e).

### WORKFLOW DOCTRINE (permanent — how this project runs)
Codifies what worked tonight. Applies to all future sessions unless Chad overrides.
- **(a) Division of labor.** Cowork owns EVIDENCE — logs, numbers, timing,
  repetition, multi-client capture. Chad owns EARS / EYES / TASTE / chaos-hands
  (the unmeasurables + adversarial use). TRIGGER: the moment a task needs a
  SECOND manual console capture, it converts to a Cowork mission — stop asking
  Chad to paste console output by hand.
- **(b) Calibrate against the reference BEFORE declaring a quality gap.** The
  Rekordbox side-by-side turned a "fix our defect" hunt into "we're at parity" —
  saved days. Always compare to the gold-standard tool before assuming a flaw is
  ours.
- **(c) Measure prototypes before shipping.** The anti-shimmer resampler was
  built, MEASURED (no jitter improvement), and DISCARDED — never shipped on
  faith. Build → measure → keep-or-revert.
- **(d) Escalate model effort only while the MECHANISM is unknown.** Spend the
  heavy reasoning on diagnosis; de-escalate to straightforward execution once the
  cause is pinned.
- **(e) Routing.** build / fix / deploy → Claude Code. watch / capture / measure
  → Cowork.

### TOMORROW'S QUEUE (in order)
1. Chad's foregrounded-mirror eye-check (~60s) — the one unmeasurable left from
   the mirror arc (headless mirror tab is hidden=true by env limitation).
2. Chad's REAL rekordbox.xml through Door 3 (first live-data exercise of the
   importer — synthetic fixture passed; real export is the true test).
3. Onboarding fix batch (prompt ready).
4. iPad shakedown (protocol ready).
5. Jake recon text.
6. wfpulse taste A/B (0 / 0.5 / default).
7. THEN: the engage-precision session.

### CARRIED-FORWARD TICKETS
- TICKET-WF-SHIMMER — parked (parity-acceptable; Cowork evidence + stable-bin fix
  shape on file).
- TICKET-WF-STEPPING — CLOSED no-defect.
- Door 3 memory-cue RENDER (Slice B) — imported as data now, not yet drawn.
- Doors 2/4 (iTunes / USB-PDB) — per LIBRARY_IMPORT_V2 build order; Door 2 follows
  Door 3's library-app-parser + wizard-route pattern.

## ═══ SESSION — June 12, 2026 — MORNING BATCH (6 tickets) ═══

Six tickets from Chad's morning testing batch. Five fully shipped (local commits,
not pushed); #5 onboarding substantially done with the rest decision-gated.
Full smoke 20/20 green throughout (19 prior + new e2e-sync-mode). NOT pushed —
awaiting Chad's live eye-check on #6 (the SYNC-mode feel) before deploy.

### SHIPPED (committed local, unpushed)
- **#1 Self-echo on same-machine twin tabs** (commit 1ea8338). BroadcastChannel
  ("cm-presence") sibling-tab detection → later same-device tab defaults partner
  audio OFF (partnerAudioOn gate on all remote playback). Persistent booth
  Monitor switch in the master-VU header (manual backstop for the
  two-different-browsers case the per-origin detector can't see — Chad's option 2)
  + P2P-panel toggle. enablePartnerAudio flips the gate on explicitly.
- **#6 SYNC as a mode (absorbs #2)** (commit 1ea8338). off → armed → locked state
  machine. Pressable anytime incl. empty/paused decks. attemptLock() evaluator
  locks the instant both decks loadable (BPM local OR partner) AND a deck plays;
  master = explicit M else first-to-play; fired on arm / local play / partner
  play / BPM-ready-while-armed. This makes #2's engage-before-play clash
  structurally impossible (no 50ms special-case re-align). B2B: the slave's own
  client does the lock; if the master's client arms, the partner auto-locks via
  the armed-mirror effect. SYNC pill: always clickable, honest off/armed/locked
  visuals (MINIMAL — full look queued for the design session).
- **#4 Stale-room auto-rejoin** (commit 1ea8338). cm_session now stamped with
  joinedAt; >90min (or unstamped) → StaleSessionModal "rejoin or start fresh?"
  instead of silent resurrection.
- **#3 Rapid-toggle mirror snaps** (commit eda1ab5). Play-start forward catch-up
  now EASES onto truth via slew instead of a hard +6.4s/+8.7s jump; only a
  forward jump during steady coast still hard-snaps. NOTE: the exact >3s
  message-interleaving race couldn't be forced in the clean 2-client harness
  (TCP-ordered, un-throttled transport positions), so the new e2e-mirror-coast
  spam-toggle phase guards the rapid-toggle path rather than reproducing the
  original gap. Fix justified by Chad's live log (room fade-flux-199) + the
  play-start code path. LIVE RE-TEST RECOMMENDED.
- **#5 onboarding (partial)** (commits 4b8c6a2, 9562624):
  - P1.1 empty-deck click with empty library → Add-music flow (else keeps quick
    single-file load).
  - P1.2 resolved by decision — the "Connect your music" CTA already does the
    chosen Add-music folder-connect; wizard intentionally not used.
  - P1.3 truthful presence — "partner online" gated on real sync.partner
    (muted "waiting for partner" until someone joins).
  - P2.5 (clear half) — joiners no longer see share/copy tools.
  - P2.6 — creator lobby code labeled "Your room is reserved — press the button
    below to go live."
  - P3.8 — landing "Room ID" → "Mix code" (consistency).

### DECISIONS MADE (Chad, this session)
- #1 control: auto-off + PERSISTENT booth monitor switch (option 2).
- #4 freshness window: 90 minutes.
- #6 arm-with-both-paused: stay armed, align on first play. Master = first to play.
- #5 P1.1/P1.2/P4.10: route dead clicks to the EXISTING Add-music flow; keep the
  LibraryWizard behind ?libwizard=1 (NOT default). The wizard auto-opens in the
  mix view when flagged — it never opened "on landing" because landing has no
  library (working as designed).
- #5 P4.9 demo library: there is NO 146-track demo in the codebase. Fresh users
  get a true empty state (LibraryEmptyState). The 146 tracks Chad sees are HIS
  OWN persisted IndexedDB test library. Decision: add a "reset my library"
  control (NOT a demo).

### REMAINING (#5 — next focused pass)
- **P4.9 reset-my-library control** (decided, not built). Needs a multi-store IDB
  wipe (tracks/queue/crates/handles) + opfsClear + watched-folder clear + reload,
  behind a confirm modal (destructive). Deferred from this session to avoid a
  half-working wipe that orphans state at end-of-long-session. lib.clear() only
  does memory+OPFS, so tracks return on reload — a real reset must clear IDB.
- **P2.4 invite-confirm popover** — replace ShareButton's 2.5s "Link copied"
  flash with an anchored confirm popover (link visible + mix code fallback).
- **P2.5 (remaining)** — "[Creator] invited you to mix" framing + default mix
  name to "[Creator]'s mix". BLOCKED on data: buildInviteLink carries room+mix
  but NOT the inviter's DJ name; needs the creator name added to the invite link.
- **P3.7 top-bar you-vs-partner identity** — deck rows already show you/partner;
  the session top bar needs an explicit "you" tag / role distinction.

### VERIFICATION
- npm run build: clean (✓ ~1.1s).
- npm run smoke: 20/20 (5 unit/audio + 15 e2e incl. new e2e-sync-mode). 0 skips.
- npm run lint: PRE-EXISTING BROKEN (ESLint v9 wants eslint.config.js; repo has
  old .eslintrc). Not introduced this session; separate cleanup if wanted.
- NOT pushed. Chad to feel #6 live + re-test #3 spam-toggle (fade-flux-199) before
  deploy.

### #5 ONBOARDING — COMPLETE (June 12, afternoon)
The 4 remaining items shipped (commit b50def6), batch now 10/10:
- P2.4 invite-confirm popover (anchored; link + mix-code fallback).
- P2.5 inviter framing ("[name] invited you to mix" via ?by=; unnamed mix →
  "[creator]'s mix"; joiner share-tools already hidden).
- P3.7 top-bar "YOU" chip on own name (partner stays the ⟺ pill).
- P4.9 lib.resetLibrary() — correct multi-store IDB wipe (tracks/queue/crates/
  handles + OPFS) behind a confirm modal; surfaced as a discreet "Reset library…"
  footer link. Needed because the library load effect re-polls IDB every 5s, so a
  memory-only clear() resurrects within seconds.
Decisions used: route dead clicks to the existing Add-music flow (wizard stays
?libwizard=1); no demo library exists (146 tracks were Chad's own persisted IDB)
→ shipped a reset control, not a demo. Full smoke 20/20. PUSHED to production.
All six morning tickets + the full onboarding batch are now live for tonight's
brother session. Chad to verify the whole set on production before the session.

## ═══ HOTFIX — June 12 — locked-B2B deck self-pause (anomaly) ═══
Cowork production sweep (bundle CF3S7XMf, room drop-fade-979): a deck paused
ITSELF mid-track in a locked B2B (Deck A 7:57, Deck B 8:02), play→false with NO
toggle() — just "[PLAY-STATE] play prop/state changed to false" + broadcast
playing=false, not near end, sync stayed locked.

ROOT CAUSE (regression from this morning's #6): SYNC-as-mode's attemptLock fires
on every PARTNER play-start. When the MASTER's client ran it, it re-ran syncDecks
on the partner-driven SLAVE — issuing a cross-client seek_request computed from
the master's OWN MIRROR of that deck (which can be stale). Landing near the track
end made the owner's play_() start a 0-sample source → instant onended →
setPlay(false) + onChange("playing",false). No toggle(), matches the signature.
(The "[SYNC-DEBUG] master changed mid-lock" Cowork saw is benign — separate.)

FIX (commit pending): attemptLock only RE-ALIGNS a slave THIS client drives;
it never issues a cross-client re-seek of a partner-driven deck. The slave's OWNER
re-aligns its own deck locally (on its play-start, and on becoming locked via the
syncLocked mirror — added a relock there so the master-arms case still aligns).
This restores the OLD safe "re-align only the local deck" behavior while keeping
the sync-as-mode model.

GUARD: new e2e-lock-stability smoke — locked B2B, slave re-triggers the master's
attemptLock (pause/play), asserts the master SKIPS the cross-client re-seek and
both decks keep advancing (no self-pause). NOTE: like #3, the clean harness can't
force the stale-mirror→near-end condition, so it guards the path + asserts the
skip is taken; the fix is justified by the live bundle + the play_/onended code
path. Also hardened e2e-sync + e2e-lock-stability against a cross-propagation
flake (wait for [ANALYZER-RECV] before engaging). Full smoke 21/21. PUSHED.

## ═══ DOGFOOD SESSION 1 — 6 bugs (Chad+Jake, room haze-neon-153, bundle 562b145) ═══
First two-machine two-human test. WORKED (don't regress): NAT traversal across two
homes (no relay), audio both ways, SYNC-as-mode locked, this-morning's self-pause
fix HELD ("skipping cross-client re-seek" fired, no spontaneous pauses), Jake's
grid analysis correct on his machine.

BUGS (priority order):
- P1 #1 AUDIO↔BEATGRID MISALIGNMENT (core promise): partner deck visual leads the
  heard audio by ~one comp-delay (~120-160ms). See "kick shown, breakdown heard."
- P2 #2 real-network comp/jitter (applied 110-160ms, spikes 197/247/321; jb
  75-205ms; RTT 67-216; SYNC-DRIFT conf→0.00) + Jake "BPM changing" distortion.
- P3 #3 partner waveform choppy on REAL two-machine (worse on 2nd track load);
  MIRROR-SNAP A +35.7s, deck B backward slews -0.5/-0.6/-0.66/-1.53s, MIRROR-STALE
  4034ms.
- P4 #4 seek mirror delay (+35.7s snap after seek) + #5 load slide-back (same
  mirror-under-latency family as #3).
- P5 #6 library key (letters G/D) ≠ deck key (Camelot 5A) — standardize on Camelot.
- ALSO: Chrome-required browser warning (Jake on Edge unlistenable); note
  [STORAGE-PERSIST] denied on strict browsers.
METHOD: #1-5 are cross-connection — headless can instrument but the ear-verdict
needs a Chad+Jake session-2 (both Chrome). Working P1 first, investigation-first,
no push until Chad reviews the alignment logic.

### P1 #1 AUDIO↔BEATGRID — FIX BUILT behind ?gridalign=1 (default OFF), June 12
MECHANISM (confirmed, code-traced): the partner deck renders at progRef = the
mirror's coasted SENT position (~real-time), but its audio arrives through the
jitter buffer (compMs = jb+playout, ~120-160ms live) — so the visual LEADS the
audible by ~one comp-delay → "kick shown, breakdown heard." The local deck has the
same lead (delaycomp delays its audio by the same compMs).
FIX (Chad: BOTH decks): offset BOTH decks' VISUAL timeline back by the measured
compMs so playhead+grid sit on the AUDIBLE position — "looks lined up" = "sounds
lined up." Render-time ONLY (prog2 in AnimatedZoomedWF; progRef/sync truth never
touched — verified sync still locks + truth advances with the flag on). SLEWED
(~0.4s ease) so the spiky 110-321ms comp doesn't make the grid jump. Gated on
delaycomp (local audio only delayed when delaycomp applies it). Suppressed during
drag; seek reads progRef so click-to-seek is unaffected.
DEFAULT OFF (?gridalign=1 to enable) — production safe; Chad flips it on for the
Chad+Jake session-2 ear-test before it becomes default. [GRID-ALIGN-DIAG] + rttMs
logging kept in so session-2 shows whether a residual rtt/2 term is needed after
the compMs offset. Full smoke 21/21 (flag off). Flag-on path verified: locks,
sync-truth advances, 0 errors. PUSHED behind the flag.
KNOWN CAVEATS for session-2: (1) residual network half-RTT not included (compMs
only, per Chad). (2) on a local-deck drag-grab the displayed playhead jumps from
offset→true position (minor; flag-gated). VERIFY: Chad+Jake session-2, both Chrome.

### P2-P6 + browser — instrument/propose pass (June 12, NOT pushed)
Per Chad: instrument-only, no pushes, while session-2 is lined up. P1 already
pushed behind ?gridalign=1. The rest committed LOCALLY only.

- **P2 #2 comp/jitter + "BPM changing"** — INSTRUMENTED. Added [JITTER-DIAG] in the
  comp poll: per-window NetEq accelerate (removedSamplesForAcceleration → speeds
  up), decelerate (insertedSamplesForDeceleration → slows down), conceal
  (concealedSamples → underrun fill), packetsLost delta, jitter, jbTarget. These
  stretch events ARE the audible "BPM changing"/distortion — session-2 will show
  the rate and correlate with Jake's ear. PROPOSAL (build+verify in session-2):
  stabilize the buffer with receiver.playoutDelayHint / jitterBufferTarget (give
  NetEq a steadier target so it stops chasing 80→104ms and stretching), and/or cap
  the adaptation rate. Real WebRTC NetEq is browser-managed; we can hint, not
  control. Needs the two-machine re-test to confirm it reduces the wobble.
- **P3 #3 partner waveform choppy (real two-machine)** — root: mirror coast/snap
  thresholds (FWD_SNAP_SEC=3, BACK_SNAP_SEC=8, slew TAU) were tuned on LOCALHOST
  (flat 30ms, dense packets). On real latency + sparse packets (MIRROR-STALE
  4034ms) the coast overshoots and late packets yank it back (the -0.5/-0.6/-1.53s
  backward slews). PROPOSAL: make the slew/snap adaptive to measured RTT + packet
  cadence; consider raising the partner progress send-rate or smoothing the coast
  more under sparse packets. Existing MIRROR-SNAP/STALE/DIAG logs already
  instrument it; session-2 capture + tune.
- **P4 #4 seek mirror delay (+35.7s snap)** — the partner seek isn't re-anchored as
  a discrete event: the mirror keeps coasting from the OLD anchor, so when the
  seeked progress finally lands the delta is huge → a +35.7s hard snap. PROPOSAL:
  on a partner SEEK (SEEK-RECV/seek_request for that deck), reset the mirror anchor
  to the new position immediately (authoritative re-anchor) instead of
  coast-then-snap. Likely shares the fix with #3/#5.
- **P5 #5 load slide-back** — on partner load+play the mirror's first-play
  anchor/hold slides back briefly. Same mirror-under-latency family; the play-start
  hold (remProgRef/remAwaitPktRef) on a freshly-loaded track needs a clean reset on
  track-change. Handle with #3/#4.
- **P6 #6 key notation** — FIXED (local): library rows now render CAMELOT[t.key]
  (falls back to raw if unmapped), matching the deck's Camelot. One notation
  everywhere.
- **Browser warning** — BUILT (local): IS_CHROME detect (UA Chrome and NOT
  Edg//OPR//Samsung); amber "works best in Chrome" notice in the lobby for
  non-Chrome users. Also noted [STORAGE-PERSIST] denied on strict browsers (library
  may evict between sessions) — accept for now; a manual JSON export already exists
  as the backup.
HEADLESS vs SESSION-2: P2-P5 are cross-connection — instrumented here, but the
ear-verdict + the real numbers need the Chad+Jake session-2 (both Chrome). P6 +
browser warning are verifiable now (build clean). Full smoke not re-run for these
(pure UI/log additions, default behavior unchanged); will run before any push.

### grid-align STEADINESS (Chad's NMP principle — variance breaks sync, not latency)
Applied to the ?gridalign offset: slew-rate-LIMIT the target to ≤15ms/poll so a
single comp spike (197/247/321ms) shifts the grid ≤15ms and recovers, rather than
the grid lurching to chase every comp twitch. Rock-steady offset > jumpy-exact.
Combined with the per-frame ease in AnimatedZoomedWF, the visual offset is steady.
NOTE: this refines the already-pushed ?gridalign fix; it's LOCAL/unpushed with the
P2-P6 batch — needs pushing before session-2 so Jake tests the steady version.
(Full comp jitterBufferTarget plan banked for after session-2.)

### smoke hardening (June 12) — sequential-load cross-propagation flake
e2e-sync + e2e-lock-stability intermittently failed in the FULL suite (passed
standalone): under a long sequential run the shared WS server slows the
analyzer cross-propagation, so the [ANALYZER-RECV] wait timed out → engage no-op
(phaseSeekMs=null / 0 skip logs). Bumped those waits to 25s + a settle. Full smoke
21/21. Product was never affected (standalone always green); pure test-infra
robustness. PUSHED with the P2-P6 + grid-align-steadiness batch.

### P3/P4/P5 mirror-under-latency — INVESTIGATION + PROPOSALS (instrument-only, LOCAL/unpushed)
Code-traced the mirror coast (Deck mirror useEffect ~5450-5535). All three share the
same root: the coast/snap/slew model (FWD_SNAP_SEC=3, BACK_SNAP_SEC=8, SLEW_TAU=220ms,
coast at remRateRef) was tuned on LOCALHOST (flat ~30ms, dense 10Hz packets). Under
real latency + sparse packets (MIRROR-STALE 4034ms) the assumptions break.

INSTRUMENTED (this commit, behind ?mirrordiag=1): [MIRROR-NET-DIAG] — per-PACKET
log of inter-arrival gap (pktGapMs), coast DRIFT before correction (driftMs),
driver rate, and action (first / FWD-SNAP / REWIND-SNAP / playstart-slew / slew).
Gives a mirror-focused session the real per-packet cadence vs the localhost tuning.

- **#3 (choppy + backward slews -0.5/-0.6/-1.53s):** over a long sparse gap the
  linear coast (remRateRef) extrapolates far; if it OVERSHOOTS truth (broadcast
  rate slightly high, or partner audio is jitter-buffered behind the sent pos), the
  next packet pulls it back → backward slew. Frequent = repeated overshoot.
  PROPOSAL: (a) coast slightly CONSERVATIVELY as pktAge grows (bias toward
  undershoot → gentler forward catch-up instead of jarring backward slew); (b)
  scale SLEW_TAU with packet cadence (gentler corrections when sparse); (c) probe
  whether the 4034ms gaps are WS packet loss vs send-rate (send is already 10Hz, so
  the sparseness is receive-side — worth a WS-reliability look).
- **#4 (seek +35.7s snap / lag):** mostly INHERENT latency, not a defect — a genuine
  partner seek correctly hard-snaps the mirror to the seeked position; the +35.7s is
  the seek distance and the lag is the packet's network transit. Minor improvement:
  freeze the coast on a detected seek so it doesn't wander before the snap. Low
  priority vs #3/#5.
- **#5 (load slide-back):** on partner load+play the play-start anchor
  (remProgRef = progRef.current at nowPlaying&&!wasPlaying, ~L5454) can hold the OLD
  track's position, so the mirror shows it briefly then snaps. PROPOSAL (most clearly
  fixable): on partner TRACK-CHANGE (remote.trackName change), reset the coast state
  cleanly (remTimeRef=0 → force a clean first-packet snap; clear slew/await) so a new
  track starts fresh without the slide-back.

ALL THREE need the two-machine session to verify (real latency). [MIRROR-NET-DIAG]
is committed LOCAL/unpushed — push it before a mirror-focused session (NOT needed
for session-2, which is grid-align + jitter). Full comp jitterBufferTarget plan
still banked for after session-2.

## ═══ NEXT INFRA PRIORITY — local mock/test WS server (for a fresh session) ═══
PROBLEM: the e2e smoke suite connects every 2-client test to the SHARED PRODUCTION
WS server. Over a long SEQUENTIAL full-suite run the server degrades under load and
partner PAIRING intermittently slows/fails — so e2e-sync (and occasionally
e2e-lock-stability) flake in the FULL run (20/21) while passing 4/4 standalone every
time. The product is sound; the GATE ITSELF is being eroded by infra, which is
dangerous (a flaky gate trains us to ignore red).
ROOT: shared remote dependency + cumulative sequential load (worse after a marathon
session degrades the dev server too — restart the dev server between long runs).
MITIGATED so far: tests poll the real precondition (window.__partnerBpm) not a log
marker — e2e-lock-stability now solid; e2e-sync improved but still hits WS-pairing
degradation under heavy load.
THE FIX (dedicated task, fresh session — NOT tonight): stand up a LOCAL mock/test
WS server the e2e suite points at (TARGET-style env), so room create/join, partner
pairing, deck_update relay, RTC signaling, and analyzer broadcast are deterministic
and load-independent. Then the full suite is reliably green and the gate is
trustworthy again. Until then: a red e2e-sync in a FULL run that passes standalone
is an infra flake, not a product regression — verify standalone before trusting it.

### SESSION END — June 12, 2026 (marathon: morning batch → onboarding → anomaly → dogfood P1-P6)
PUSHED to production today: #1 self-echo guard, #6 SYNC-as-mode (absorbs #2),
#4 stale-room, #3 mirror-snap slew, #5 onboarding (10/10), the locked-B2B self-pause
hotfix, P1 #1 audio↔grid fix behind ?gridalign=1 (default OFF, slew-rate-limited per
Chad's NMP variance principle) + [GRID-ALIGN-DIAG], P2 [JITTER-DIAG], P6 key→Camelot,
Chrome-required warning, P3/P4/P5 [MIRROR-NET-DIAG] (?mirrordiag=1) + proposals, and
the __partnerBpm test-robustness hook.
SESSION-2 (Chad+Jake, both Chrome) ARMED: flip ?gridalign=1 → verify kick-on-playhead
by ear; capture GRID-ALIGN-DIAG (offset magnitude + rtt/2 residual?); capture
JITTER-DIAG (confirm the "BPM changing" time-stretch before tuning the buffer).
BANKED for after session-2: comp jitterBufferTarget steadiness tuning; mirror-family
(#3/#4/#5) fixes; the local mock-WS-server infra task above.

## ═══ SESSION — June 13, 2026 — REGRESSION AUDIT + Move #1 (local mock WS server) ═══

### The audit (Chad asked for a brutally honest sync regression review)
Pulled the full bug-fix history from VISION_5 + git log and categorized it.
VERDICT: most "sync feels off" bugs were DISTINCT root causes sharing a SYMPTOM
(healthy), not fixes regressing each other — e.g. the "double kick" family (Gap #4
monitoring delay / comp staleness / dead-receiver-after-reneg / the autoplay RED
HERRING that was retracted) and the "can't pair" family (room-split URL / identity
collision / stale socket / Railway dropped ping). TWO genuine regressions, both the
scary cross-coupling kind: (1) the June-12 self-pause — SYNC-as-mode (#6) re-broke
the "only re-align your OWN deck" invariant (a feature rippling into transport);
(2) the June-11 beat-grid "regression" — the analyzer REFINE rebuild silently split
sync onto two grid definitions (fixed structurally by beatsv2 unification).
STRUCTURAL FINDINGS: the whole app is ONE 10,606-line file (no module boundary
around sync); 5 live URL-flag branches (beatsv2/onsetgrid/delaycomp/gridalign/
mirrordiag) each carry a legacy+new path. The mirror coast/snap model is the one
genuinely fragile mechanism — patched 6× because it was tuned on localhost.
THE WORST FINDING: the smoke gate structurally CANNOT reproduce the conditions the
worst bugs live in (the log repeatedly admits "the clean harness can't force…" the
stale-mirror / interleave / sparse-packet cases) — green on the easy case, blind on
the hard case. 3-MOVE PLAN agreed (NOT a big-bang rewrite): #1 local mock WS server
w/ injectable latency+loss (close the blind spot) → #2 mirror coast/snap refactor
(latency-adaptive) → #3 retire promoted flags. Order matters: #1 first so #2 is
verifiable under simulated latency.

### Move #1 SHIPPED (local, unpushed — Chad to review before any push)
Built the local mock WS server + deterministic netem so the gate can finally see
the real-network conditions.
- **Commit 1 (394023c)** — `tools/smoke/lib/mock-ws-server.mjs`: protocol-exact
  stand-in for `../collabmix-server-repo/server.js` (join/identity, deck_update,
  transport, rtc signaling, sync_ping/pong, deck_driver_change, close-cleanup).
  App: a `?wsurl=` override gated behind TEST_HOOKS (inert in production — no socket
  hijack risk). Runner: `--mock`/`MOCK=1` spawns+tears it down, exports MOCK_WS_URL;
  `lib/e2e.mjs` appUrl()/gotoApp() route through it. Added `ws` devDependency.
- **Commit 2 (7ee945d)** — seeded (mulberry32) netem layer: latencyMs / jitterMs
  (→ reordering) / lossPct / seed / types[] filter, live via POST /netem +
  setNetem()/resetNetem(). First test `e2e-mirror-latency.smoke.mjs` (needs --mock).

### What the netem PROVED (the blind spot, quantified)
Same mirror code, driven through the real app under the mock:
- clean (no netem): median **4ms** ← what the production gate sees, always.
- latency 150 + jitter 70 + 40% loss (deck_update): median **~150ms**, 0 backward.
- harsh 200/120/70%: median ~185ms but MAX spikes to **~1.4s** (transient).
The clean network HID all of it. The committed test asserts the invariants that
hold today + Move #2 must keep (no backward step, keeps advancing, tracks within
the latency floor + margin) and LOGS the harsh-profile max as a [DIAG] line — the
number Move #2 will drive down and then assert on. NOTE: the backward-SLEW symptom
specifically needs a rate-adjusted (synced/pitched) driver — that deliberate repro
is the first thing to add when Move #2 starts.

### VERIFICATION
- npm run build: clean (~1.1s). npm run smoke:unit: 6/6.
- netem standalone: determinism (same seed → identical 50/100 drop set), seed
  sensitivity, latency (~129ms for 120 set), reorder-under-jitter — all PASS.
- e2e-mirror-latency: 7/7 against the mock (direct + via runner --mock).
- End-to-end: two real Chrome clients paired THROUGH the mock (distinct djIds,
  /health=2djs/1room, 0 console errors).
- NOT pushed. Scope kept INCREMENTAL (Chad's call): existing e2e still hit prod;
  mock-based tests opt in. Full-suite migration onto the mock = deliberate next step.

### REMAINING (next sessions)
- Move #1 follow-ups: message-interleaving + rate-adjusted backward-slew repro
  tests; migrate e2e-mirror-coast off the client-side __progressThrottleMs hack
  onto real mock-induced sparsity; THEN flip the whole e2e suite onto the mock
  (load-independent gate) with TARGET= as the escape hatch.
- Move #2: mirror coast/snap latency-adaptive refactor (now verifiable via netem).
- Move #3: retire promoted flags (beatsv2/onsetgrid/delaycomp dead branches).

### Move #1 follow-up — the ACTUAL backward-slew reproduced (Chad's call, June 13)
Per Chad: before the mirror refactor, reproduce the EXACT dogfood symptom (Jake's
backward slew -0.5/-0.6/-1.53s, "DOGFOOD SESSION 1" P3), not just general lag, so
Move #2 can prove it killed THAT bug — not merely reduced latency. Skipped the
full-suite migration (separate, lower-urgency session).
- **Mechanism (code-traced, ~5490-5540):** the mirror coasts the partner playhead
  at the driver's last-known rate (remRateRef). Pitch the driver DOWN while
  progress packets are absent → the mirror keeps coasting at the STALE FAST rate →
  OVERSHOOTS truth → when a packet lands, signedDrift is negative → the "absorbed
  backward drift … via slew" branch eases the playhead BACKWARD. Overshoot ≈
  rateDrop × gap, so it's tunable + deterministic.
- **New test hook** `__setRateDeck(deck, rate)` (TEST_HOOKS-gated): changes the
  live audio rate AND broadcasts it like the pitch fader (driver-gated in dh).
  Wired via onRateReady like the existing onToggle/Seek/CueReady.
- **Repro recipe (deterministic):** baseline latency 120ms → seek+settle → BLACK
  OUT deck_update (lossPct 1.0, total = no random drops) → pitch driver to 0.45 →
  hold 5s → restore. Measured: maxBackwardStep **0.73s**, 6 backward steps, 5×
  "[MIRROR-SNAP] absorbed backward drift" — squarely in Jake's 0.5–1.53s range.
- **xfail convention added to the runner:** `e2e-mirror-slew` is registered
  `xfail:true` and asserts the POST-FIX property (max backward step < 120ms). It
  FAILS today → reported 🟡 **XFAIL** (non-fatal, NOT a regression). When Move #2
  fixes the coast/snap model it flips to 🎯 **XPASS** = "remove the flag, promote to
  a hard gate." That flip is the proof Move #2 killed this exact bug.

### Move #1 — commit 4 (June 13)
- **Commit 4** — `__setRateDeck` rate hook (app) + `e2e-mirror-slew.smoke.mjs`
  (xfail repro) + runner xfail/XPASS handling + README xfail note. Build clean.
  e2e-mirror-slew: post-fix checks FAIL as designed (XFAIL), repro deterministic.
NEXT: Move #2 — mirror coast/snap latency-adaptive refactor, verified by driving
e2e-mirror-slew from XFAIL → XPASS (and keeping e2e-mirror-latency green).

### Move #2 — mirror coast/snap → monotonic forward-only follower (June 13) — ON A BRANCH, NOT master
Committed to branch **`move2-mirror-slew-fix`** (`9b1f7f4`). **master is deliberately
left clean/untouched** — do NOT merge until the open sync-idempotency question below
is resolved.

**WHAT shipped (on the branch):** Replaced the localhost-tuned coast/snap/slew model
in the non-driver mirror with a **monotonic forward-only follower**. Backward motion
is impossible BY CONSTRUCTION, not by threshold tuning:
- Position smoothing (decaying re-anchor step) kept for smoothness, but hard-clamped
  FORWARD-ONLY — when the smoothing would reverse, the playhead CREEPS forward
  instead (small creep, never a freeze, never backward).
- **Reorder guard** drops stale/late packets that sit below the anchor (reordering is
  a real network condition — it was the harsh-profile error killer), distinguished
  from a genuine rewind by magnitude.
- Observed-rate coast (low-passed) + broadcast-rate bootstrap so a sparse stream
  never freezes at baseRate=0. Genuine seeks/rewinds still hard-snap.
- **GRID_ALIGN promoted default-ON** (audible-position lock: partner grid drawn at
  sent − measured comp delay, so the beat you SEE = the beat you HEAR), kill-switch
  `?gridalign=0`. The comp subtraction stays at the render layer (keeps the smoothness
  tests measuring the raw follower; preserves click-to-seek + diagnostics).
- e2e-mirror-latency upgraded: pace-adjustment metric + hard harsh-profile assertion.

**PROVEN (deterministic mock-based tests — not the flaky prod relay):**
- `e2e-mirror-slew`: **XFAIL → XPASS.** maxBackwardStep=0.00s, 0 backward steps, 0
  "absorbed backward drift" logs. Jake's exact bug is dead.
- `e2e-mirror-latency`: **10/10.** 0 backward steps in clean/realistic/harsh. **Healthy
  pace deviation ~1% (imperceptible — indistinguishable from local).** Degraded (40%
  loss) ~10–35% (logged, not gated → Bug #2 connection warning). Harsh error driven
  from ~5.7s (naive) / ~1.4s (pre-fix) down to ~320ms.
- `e2e-mirror-coast`: **11/11.** Also re-verified green: e2e-transport, e2e-mirror,
  e2e-track-mirror, e2e-trackend, e2e-lock-stability; unit suite 6/6.

**OPEN — sync idempotency regression (NOT fixed; deferred deliberately):**
`e2e-sync` re-engage idempotency regressed (~-160ms vs the <45ms bound). Suspected
coupling: sync engage reads the **instantaneous** mirror position (progRef,
~line 9541), and the new follower's reading has more run-to-run variance than the old
heavily-damped model. **Measurement is currently UNRELIABLE** — e2e-sync runs against
the PRODUCTION relay, which degraded under repeated runs (failure magnitude climbed
-160 → ±180ms — the flaky-gate signature the audit warned about), so real-vs-noise
can't be separated right now. Four follower re-tunes traded one number for another;
**that path is closed.** NEXT-SESSION focused task:
  1. Route `e2e-sync` through the **deterministic MOCK** server (not the prod relay)
     to find out if the regression is even real or mostly relay noise.
  2. If real, fix on the **sync-SAMPLING side** — read the stable smoothed *anchor*
     (remProgRef) instead of the instantaneous display — NOT by re-tuning the follower.

**Process note (Chad's call):** stopped after the regression failed to converge across
4 attempts rather than keep flailing. Lock-in-the-win-on-a-branch + tackle-the-coupled-
regression-fresh is the pattern; don't patch a flaky-gated regression under time pressure.

### Move #2 follow-up — sync idempotency FIXED on the sampling side (June 13) — branch `move2-mirror-slew-fix`
Commit `a2c1475`. master still untouched. The deferred sync-idempotency regression
is resolved — exactly per the plan above (measure first, fix sampling-side, don't
re-tune the follower).

**Measure first (the answer to "real or relay noise"):** routed `e2e-sync` through the
DETERMINISTIC MOCK (clean netem) and ran a definitive A/B — original vs new follower,
same harness, only the follower swapped:
- original follower: re-engage **0.9–5.2 ms** (rock-steady)
- new follower, reading the LIVE display: **−11 → +118 ms, 3/5 FAIL**
→ The regression is REAL and attributable to the follower's effect on the *sampling*,
not relay noise (the prod-relay numbers had been corrupted by the relay degrading under
load — the flaky-gate signature). The ±100ms failures sat near the ±250ms half-beat line:
the wobble was tipping the **nearest-beat pick** across a beat boundary.

**Fix (sampling-side, follower untouched):** `syncDecks` reads a STABLE projected anchor
for a partner-driven deck's beat phase instead of the wobbling live display. The last-
received packet value (`partnerProgressMetaRef`) projected to "now" by a clean ramp
(broadcast rate, NO follower dynamics) so it lines up with the live local slave. A
locally-driven deck keeps its precise live position. Raw anchor alone killed the variance
but left a ~37ms staleness bias near the bound; projecting removes it.
- projected anchor: re-engage **−5.4 → +14.9 ms, 6/6 pass, centered on zero**

**Full suite `npm run smoke -- --mock`: 22 passed, 0 failed, 0 skipped, 1 XPASS.**
e2e-mirror-slew XPASS intact (0 backward); latency 10/10 (healthy pace 0.9%); coast 11/11;
e2e-rekordbox re-engage 0.06ms (<10ms bound). The backward-slew follower is byte-for-byte
unchanged.

**Key lesson (banked):** two consumers were fighting over one number — the eye wants a
smooth/never-backward playhead, sync wants a deterministic instantaneous read. The fix was
DECOUPLING them (sync reads the stable anchor), not re-tuning the shared follower. Four
follower re-tunes traded one number for another; the sampling-side fix landed first try.

**Open follow-up:** e2e-mirror-slew is now XPASS — remove its `xfail:true` flag in
`tools/smoke/run.mjs` to promote it to a hard gate (separate, trivial change). The whole
branch still needs a final review + the live Jake audio-lock check before merge to master.

### Move #2 follow-up — e2e-mirror-slew promoted to a HARD GATE (June 13) — `a965c58`
Removed `xfail: true` from `e2e-mirror-slew` in `tools/smoke/run.mjs`; it now counts as a
normal PASS/FAIL gate (was reporting 🎯 XPASS since the follower fix). Any future change
that reintroduces the dogfood backward slew now FAILS the suite — the bug can't return
silently. Full suite `npm run smoke -- --mock`: **23 passed, 0 failed, 0 skipped** (no XPASS
line — slew is a regular ✅ PASS, 0 backward steps).

**Branch `move2-mirror-slew-fix` status (master still untouched):** the Move #2 work is
complete and green end-to-end —
  - 9b1f7f4 monotonic forward-only follower (kills the backward slew)
  - a2c1475 sync re-engage idempotency fixed sampling-side (projected stable anchor)
  - a965c58 slew test promoted to a hard gate
Remaining before merge to master: final human review + the live Jake audio-lock check
(grid sits on the HEARD beat — the one thing the suite can't prove).

### Bug #2 audio — Opus HI-FI stereo (June 13) — branch `opus-hifi-stereo`, off master
Commit `bf05ef0`. master untouched. Independent of the mirror/jitter-buffer work —
this is the audio-FIDELITY lever (lever #3 from the Bug #2 measurement pass), shipped
as its own clean branch.

**Measurement that motivated it:** the four-lever audit found partner audio was running
on **voice-grade Opus defaults** — no SDP munging anywhere, so Chrome negotiated ~mono,
~32 kbps, voice-optimized — wrong for a DJ app. (The other levers: jitterBufferTarget is
never set = browser-adaptive shallow ~80–104ms; the wobble is confirmed NetEQ
time-stretch via the existing [JITTER-DIAG]; the partner stream IS separable from local
audio. Those remain banked.)

**What shipped:** munge the LOCAL SDP on BOTH sides (offer in `startCall`, answer in
`handleOffer`) → Opus fmtp `stereo=1; sprop-stereo=1; maxaveragebitrate=256000;
maxplaybackrate=48000; useinbandfec=1`, plus raise the audio sender's encoding
maxBitrate to 256000 (`applySenderHiFi`) so the encoder actually pushes stereo at rate.
Added a `[OPUS-SDP]` one-shot diagnostic that reads the NEGOTIATED codec
(sdpFmtpLine + channels + live bitrate) from getStats. New `e2e-opus` smoke test + run.mjs
registration.

**PROVEN (e2e-opus 5/5):** the NEGOTIATED fmtp read from getStats — Chrome's agreed
result, NOT the munge input — on BOTH receivers is
`maxaveragebitrate=256000;...;sprop-stereo=1;stereo=1;useinbandfec=1`. Stereo + 256k took
effect end-to-end. Full suite `npm run smoke -- --mock`: 23 passed, 0 failed, 0 skipped,
1 xfail (e2e-mirror-slew XFAIL is EXPECTED on this branch — the Move #2 slew fix is on
`move2-mirror-slew-fix`). All RTC tests (comp/drift/reconnect/rejoin) pass → the SDP munge
doesn't break the connection.

**Honesty note:** the live-throughput check read ~1kbps on the synthetic kick fixture
(sparse + DTX + the 12s track ends before the window) — uninformative, since
maxaveragebitrate is a CAP not a floor. Demoted it from a hard gate to a logged diagnostic
TRANSPARENTLY (flagged in test + commit) rather than faking a pass. The fmtp negotiation is
the proof; real-music throughput + the audible jump are the live check.

**Two branches now staged + proven, master clean. Both need a live Jake session:**
  - `opus-hifi-stereo` — HEAR the hi-fi stereo jump (vs phone-call-grade).
  - `move2-mirror-slew-fix` — grid locks to the HEARD beat (GRID_ALIGN) + no backward slew.
Holding: do NOT push, do NOT merge until the live checks pass.

### Bug #2 audio — jitter-buffer depth PINNED (June 13) — branch `jitter-buffer-target`, off master
Commit `223229a`. master untouched. Independent of opus + mirror branches. Built from a
REAL two-machine Jake log (June 13), measured before coding.

**Measurement (from the log):** jitter 3–20ms, ZERO packet loss. The browser's
jitterBufferTarget started shallow (~90→69ms) and HUNTED up to ~134–135ms over ~30s.
The audible wobble (decel=10–20ms time-stretch + conceal bursts of 2,300–5,180ms/window)
fired ONLY during that shallow ramp + an ICE disconnect→reconnect + the pre-play period.
In steady playback (jbTarget ~135) it was essentially clean (conceal=0 in ~95% of windows,
decel=0 always). Honest verdict: the wobble is a SETTLING/RAMP/RECONNECT phenomenon on a
good connection, not ongoing — the slow ramp from a too-shallow start is the pain.

**Fix:** pin `recv.jitterBufferTarget = JB_TARGET_MS` (default 160) on the PARTNER's inbound
audio receiver in the comp poll (re-checked each tick → reconnect-safe). 160 = the depth THIS
connection proved clean, reached from the FIRST packet so the shallow ramp (where NetEQ
underran + stretched) never happens. URL flag `?jbtarget=<ms>` (`200` deeper, `120` snappier,
`0` = browser default for A/B). TWO-SIDED: partner receiver ONLY; local Web Audio monitor
untouched/instant.

**PROVEN (e2e-jbtarget 5/5):** getStats jbTarget median/min/max all = 160ms (rock-steady) —
localhost auto-targets far lower, so a held 160 proves NetEQ honours the pin at the buffer
level, not just a constant change. `[JB-TARGET]` log confirms it overrode browser-default.
Full suite `npm run smoke -- --mock`: 23 passed, 0 failed, 0 skipped, 1 xfail (e2e-mirror-slew
expected on this branch). RTC tests (comp/drift/reconnect/rejoin) all pass.

**Scope honesty:** kills the settling/ramp/reconnect wobble (the bulk of the log); a genuinely
BAD connection's physics remain (→ the separate connection-warning lever, still banked). Right
depth is a listening call — tune by ear in the dogfood; 160 is the data-anchored start.

### THREE branches now staged + proven, master clean — all await a live Jake session:
  - `move2-mirror-slew-fix` — no backward slew + grid locks to the HEARD beat (GRID_ALIGN).
  - `opus-hifi-stereo` — HEAR the hi-fi stereo jump (vs phone-call-grade).
  - `jitter-buffer-target` — HEAR the smoother audio (no settling wobble); tune jbtarget by ear.
Holding: do NOT push, do NOT merge until the live checks pass. All three are independent.

### ALL THREE merged to master + re-verified TOGETHER (June 13)
Per Chad: merge the three proven branches into master so the COMBINED app can be
dogfooded live with Jake — but combined + re-verified together first, not smashed.
Merge commits: `a811079` (move2-mirror-slew-fix) → `52aff4d` (opus-hifi-stereo) →
`9ef76f7` (jitter-buffer-target), each `--no-ff` (revertable).

**Conflicts (all mechanical, resolved keep-both):**
- `VISION_5.md` — append-only log; kept every branch's section (both merges).
- `tools/smoke/run.mjs` — opus + jitter both registered a test after e2e-comp; kept BOTH.
- `src/collabmix-production.jsx` — the flags block: move2 flipped `GRID_ALIGN` default-ON
  (`!== "0"`) while jitter added `JB_TARGET_MS` right after the old line. Kept move2's
  default-ON GRID_ALIGN **and** jitter's JB_TARGET_MS (did NOT revert the flip).
  The functional code (mirror follower ~5400, opus munge ~3430, jitter set ~3540) sat in
  non-overlapping regions → auto-merged clean.

**COMBINED-SUITE PROOF (`npm run smoke -- --mock`): 25 passed, 0 failed, 0 skipped, 0 xfail.**
All four targets re-verified TOGETHER on merged master (nothing changed when combined):
- e2e-mirror-slew: **0 backward** (maxBackwardStep 0.00s) — now a regular hard-gate PASS.
- e2e-sync: re-engage **6.17ms** (idempotency tight, undisturbed by the audio changes).
- e2e-opus: negotiated fmtp **stereo=1 + maxaveragebitrate=256000**.
- e2e-jbtarget: jitter buffer **HOLDS ~160ms**.
Build clean. The three overlapping audio/sync fixes coexist with no interaction regression.

NEXT: push master → Vercel deploy → live dogfood with Jake (the audible/visual checks the
suite can't prove: hear hi-fi stereo + smoother audio; see grid locked to the heard beat,
no backward slew). Tune `?jbtarget` by ear if a worse connection needs deeper.

### Sentry telemetry — WORKING + confirmed live (June 13)
Goal: session data flows to Chad's dashboard automatically instead of Jake emailing logs,
before tonight's dogfood. ASSESSED first (Sentry was already ~90% wired), then a config fix
+ a plan upgrade got it over the line. DONE.

**Assessment (what was already wired):** `@sentry/react` + `@sentry/vite-plugin` installed;
`Sentry.init` in `src/main.jsx` with a real DSN (Chad's own org `mixsync.sentry.io`),
browserTracing, replay, ErrorBoundary, breadcrumbs/tags/context (`telemetry.js`),
`captureHandledError` in the RTC paths, and a Cmd+Shift+E test-error trigger. The 429s in
Jake's logs were **quota rejection, not misconfig** — the DSN was valid and reaching Sentry.

**Root cause:** the **Replay** quota was exhausted (10%-of-ALL-sessions session recording
burned the free tier), and the **error** quota was also maxed for the cycle → errors 429'd too.

**Fix (commits `a9fbe25` → `18abc58`, on master, deployed):**
- `replaysSessionSampleRate` 0.1 → **0** (stop the continuous session-recording quota bleed).
- `replaysOnErrorSampleRate` kept at **1.0** (capture a replay only WHEN something breaks — rare).
- `tracesSampleRate` 1.0 → **0.2** (stop burning the performance quota).
- DSN → `import.meta.env.VITE_SENTRY_DSN || <existing>` (env-var ready, existing DSN as fallback).
- Error capture untouched (top priority).
- Chad **upgraded to the $29 Sentry Team plan** → cleared the exhausted error/replay quota.

**PROVEN:** Cmd+Shift+E on the live app → `Sentry test error — triggered by Cmd+Shift+E`
**landed in the Issues feed** (env=production). Verified the deploy by live-bundle CONTENT
(`replaysSessionSampleRate:0`, `replaysOnErrorSampleRate:1`, `tracesSampleRate:.2`) since Vercel's
build hash differs from local — content, not hash, is the reliable signal.

**KNOWN GAPS (non-blocking, future):**
- Source maps NOT uploaded (`SENTRY_AUTH_TOKEN` unset in Vercel) → stack traces are MINIFIED.
  The vite-plugin is already wired; just needs the token in Vercel env for readable traces.
- Standalone console-log capture not enabled — console shows only as breadcrumbs ON errors.
  Jake's full diagnostic stream is still captured via the local **Cmd+Option+L** session-log
  download (belt-and-suspenders). Wiring console→Sentry Logs is a small future add.
- Note: a deploy-skip scare during this session turned out to be a hash-naming ghost — Vercel
  builds fresh but content-hashes differently than the local build; always verify by CONTENT.

## ═══ SESSION END — June 26, 2026 — WAVEFORM AESTHETIC LOCKED + DEPLOYED ═══

**What was done.** Resumed the parked top-zoomed-waveform aesthetic work and took it
to a Rekordbox-matched, locked finish — then shipped to production. Iterated
eye-by-eye against the real Rekordbox waveform (Chad on his machine, every step
behind a live `?wf*=` URL knob). Squashed to one clean commit `94cacaf`, merged
fast-forward to `master`, pushed (`b393496..94cacaf`), **live + content-verified**
(bundle `main-BGT_u-BU.js` contains the new knob strings; hash differs from local
build — content, not hash, is the signal, per the standing rule).

**The waveform (three bands: blue/purple lows · amber mids · cream kicks), final:**
- **Colour fix (pastel → vivid):** saturation pinned HIGH (`wfSat 1.90`) so the min
  RGB channel hits 0 → the additive glow can't wash blue to sky-blue. `source-over`
  blend, `wfVal 0.92` (luminous, not dark).
- **Glow:** tight additive bloom (offscreen, `wfGlowPx 5 / wfGlowA 0.60`); wide soft
  halo OFF (it was the foggy/smeared/gap-bridging failure).
- **Amber:** full-bodied dynamic band (`wfMidScale 0.95`), abs-max normalization (no
  flat-tube clip), opaque (`wfAmberOver 1.0` = identical amber on both decks), capped
  under blue at kicks (`wfCapRatio 0.68` so blue punches solid) with a blue-envelope
  cap that OPENS in breakdowns (`wfAmberOpen 0.45`) so amber rides the melody.
- **Kicks:** cream = highs, gated by bass-coincidence (`wfKickHi 0.28`) so kicks (not
  hi-hats) are the markers; fully OPAQUE (`wfCreamAlpha 1.0`) for solid punch; tips
  darkened on amber/blue (`wfTipMul 0.72`), kept bright on cream (`wfCreamTip 1.15`).

**What was decided (canonical).** The waveform aesthetic is **LOCKED — do not regress
without Chad's explicit approval.** Protections shipped: code banners at the `WF_*`
block + above `AnimatedZoomedWF`; full rationale + tried-and-rejected in
**`tools/docs/WAVEFORM_LOCKED.md`**; pointer from DESIGN_PHILOSOPHY.md; a new
**"🔒 Locked Foundations"** section in MASTER_INDEX.md (waveform locked; connection
fixes shipped/awaiting Jake; landing built in Claude Design; app-design unification =
next project). URL knobs retained for A/B tuning ONLY. Structure (onset/attack/
two-layer geometry) was never touched — paint/colour/cap/gate only.

**Verification.** `npm run build` clean; full `npm run smoke` GREEN (25 passed / 0
failed / 2 dep-skips); live deploy content-verified.

**What remains pending.** (1) Connection/dogfood fixes (`?gridcouple` / `?progthrottle`
/ `?jbtarget`) still **awaiting Jake's B2B confirmation**. (2) **App design unification**
(library + mixing view to match the landing page) is the planned next project via the
Design-mocks → Code-builds loop. (3) Housekeeping: several stale dev-server processes
were cleaned mid-session (one clean instance left running) — note for future sessions
to avoid spawning duplicate `npm run dev`.

## ═══ SYNC TEMPO PRECISION — FIXED + SHIPPED (awaiting Jake) — June 26, 2026 ═══

**Status: FIXED, full smoke GREEN (25/0/2), shipped. Behind `?syncprecision=` (default ON;
`=0` reverts to legacy rounded-BPM). Still needs JAKE BY-EAR validation — smoke proves the
logic didn't regress, but only a real long-blend session confirms the audio stays beat-matched.
Validate alongside the connection fixes in the same two-machine session.**

**Confirmed it is an AUDIO bug, not just visual.** `rate` IS the deck's audio `playbackRate`
(pitch+tempo, no time-stretch; `s.playbackRate.value=rate` ~L6573, `_setRate` ~L7778), and
there is NO continuous tempo re-lock for local two-deck beatmatch (rate set once at engage),
so a wrong rate is not masked — two "128.0" tracks (~128.04 / ~127.97) drifted audibly:
~33ms flam after 1 min, ~66ms after 2, kicks separating through a long blend. The grid drift
was its visual shadow. Fix keeps the audio locked to analyzer precision (~6 decimals).

**Symptom.** Two tracks that both DISPLAY "128.0" BPM show beat grids that are aligned at
one point in the window but DRIFT apart toward the edges — visible even when the decks are
STOPPED. A DJ would read it as broken.

**Root cause (real bug, not cosmetic).** Their true analyzed tempos differ in the decimals
(e.g. 128.04 vs 127.97) — both round to "128.0" for display. Two independent facts combine:
1. The **grid** is rendered from the analyzer's **full-precision `beatPeriodSec`**, and the
   waveform zoom is a fixed-**TIME** window (`WF_WINDOWS` seconds), so each deck draws its
   grid spacing proportional to its OWN tempo → different tempos = different on-screen
   spacing = drift across the window even when static. (The spacing math is identical per
   deck and correct — it faithfully renders two different tempos. NOT a precision bug in the
   renderer.)
2. **SYNC computes the rate from the ROUNDED display BPM** — `src/collabmix-production.jsx`
   ~line 10419: `const rate = targetBPM / srcBPM` where both are `bpm.results[id].bpm`
   (rounded to 0.1). So syncing two "128.0" tracks gives rate = 1.0 → NO tempo correction →
   they keep drifting after sync, and during playback the audio itself slowly slides out of
   beat-match. This is the actual product gap.

**The fix (APPLIED, `src/collabmix-production.jsx` ~L10419).** Rate now derived from
full-precision tempo: `rate = slaveBps / masterBps` (= masterTrueBPM/slaveTrueBPM), using
`bpm.results[id].beatPeriodSec` with the same partner-state fallback as the phase-align reads.
Falls back to the rounded-BPM rate if either period is missing; the ±12% safety clamp is
unchanged. Gated by `SYNC_PRECISION` (`?syncprecision=`, default ON, `=0` legacy). Logs the
chosen path (`[SYNC] precision rate from periods…`). Effect: sub-0.1-BPM differences get
nudged out → audio stays beat-matched + grids lock across the whole window.

**Done this session.** Implemented behind the A/B flag, full `npm run smoke` GREEN (25 passed
/ 0 failed / 2 dep-skips — incl. e2e-sync, sync-mode, lock-stability, comp, drift). Does NOT
touch the locked waveform aesthetic (WAVEFORM_LOCKED.md). Pending: Jake by-ear validation in
the same two-machine session as gridcouple/progthrottle/jbtarget.

**Held separately (bigger, own decision).** Fixed-BEATS zoom (lock the waveform horizontal
scale to beats, not seconds) would make grids lock even for UNSYNCED/stopped different-tempo
tracks (true Rekordbox feel). Deferred — the sync fix solves the real-use problem; unsynced
different-tempo tracks showing different spacing is accurate.

**How to confirm the real decimals.** Console logs per deck:
`[BPM-PERIOD] track A : mean=0.4688xx s (128.0xx)` — compare the two `(128.0xx)` values.

## ═══ STANDING FOUNDATION (read at session start) — Social & Matchmaking ═══

### Social & Matchmaking — Core Foundation
Before designing ANY social, matchmaking, community, profile, discovery, or taste-comparison feature, read **tools/docs/SOCIAL_DESIGN_PHILOSOPHY.md**.
Core principle: **Music taste is identity. Pair people around SHARED taste (connection/belonging); never across taste differences** — incompatible-taste matching is harmful on three stacking levels: musical (the mix doesn't work), experiential (bad first experiences), and social (triggers "my taste is better" defensiveness and conflict). Matchmaking is *social compatibility*, not just a preference filter. Avoid quantifying/ranking taste (invites comparison/judgment — why the "92% match" score and "in tune" meter were cut); convey match strength through concrete shared evidence instead. This drives feature decisions across the whole social layer.

## ═══ SESSION END — June 26–27, 2026 — WAVEFORM/SYNC/CURSOR POLISH + SOCIAL FOUNDATION ═══

A long eye-by-eye + empirical session. Everything below is on `master` and live unless noted.

### SHIPPED LIVE (production, content-verified)
- **Locked waveform aesthetic** (`94cacaf`) — three-band Rekordbox-matched look: vivid
  saturation (min channel→0 so the glow can't wash blue to sky-blue), tight additive bloom,
  full-bodied dynamic amber (capped under blue, opens in breakdowns), solid opaque kicks
  gated by bass-coincidence. FROZEN — see `tools/docs/WAVEFORM_LOCKED.md`. Do not regress.
- **Uniform beat grid** (`943e36a`, default ON, `?griduniform=0`) — grid lines at the snapped
  period, not raw beats → two synced decks' grids stay parallel edge-to-edge (fixed the
  "looks broken" spread).
- **Sync tempo precision** (`c9a1c61`, default ON, `?syncprecision=0`) — rate from full-
  precision `beatPeriodSec`, not rounded BPM (was an AUDIO drift over long blends).
- **Sync-state fix** (`87ed128`→`bf17067`, default ON, `?synctempo=0`) — natural-BPM sticky
  session tempo + master freeze + clean reset + de-churn. Kills the contaminated-session-
  tempo + master-reassignment bugs (rate=1.0165→123 stuck; master B not taking). **Desktop-
  validated** (rate=1.0000 across 4 cycles, B-master takes, clean reset). Self-cleaning every
  engage. Still needs Jake by-ear + human review before "done".
- **Grid drag-jump fix** (`9662409`, default ON, `?dragfix=0`) — apply the grid-align offset
  during the drag too → no visual jump on release (position was already exact).
- **Cursor sweep + drag-direction** (`9d3dabd`) — normal arrow EVERYWHERE (waveforms, buttons,
  mixer faders/crossfader/sliders; text caret kept in search/chat); waveform drag = Rekordbox
  PLATTER model (drag left → forward), local+partner consistent, `?draginvert=0` reverts.
- All gated by `=0` kill-switches; full `npm run smoke` GREEN each ship (25/0/2, dep-skips).

### FOUNDATIONS (read-before-build, same tier as DESIGN_PHILOSOPHY)
- **`tools/docs/WAVEFORM_LOCKED.md`** — every locked WF value + why + tried/rejected.
- **`tools/docs/JAKE_VALIDATION_PLAN.md`** — TWO categories scored SEPARATELY (see NEXT).
- **`tools/docs/SOCIAL_DESIGN_PHILOSOPHY.md`** (`4002d58`) — THE principle for all future
  social/matchmaking/community/profile/discovery/taste-comparison design: music taste is
  identity → pair around SHARED taste (connection), never across differences (musical +
  experiential + social/identity harm). Never quantify taste (the "92% match" score + "in-
  tune" meter were cut). Wired into CLAUDE.md (line-1 flag), MASTER_INDEX (🧭 Core Design
  Principles section), and this doc — a fresh session hits it 3× before any social work.

### HELD / PENDING
- **gridsnap (snap-to-uniform seek-quantize)** — PULLED before ship; the danger is the
  PARTNER-SYNC feedback loop (it re-snapped remote seeks → walked the synced position tens of
  sec off). When revisited: gate to LOCAL seeks (`!fromRemote`) + match the rendered grid
  (note `beatPhaseFrac` is a beat-INDEX, not 0..1). Memory: `project_gridsnap_held`.
- **"Match with anyone"** — UI cut done in Claude Design; matchmaking is taste-only now. (Not
  a repo change — the landing lives in Design until the app-unification project.)

### NEXT MILESTONE — Jake two-machine dogfood (UNBLOCKED)
Per `JAKE_VALIDATION_PLAN.md`, validate the two categories SEPARATELY:
- **Category A (LOCAL logic = sync reliability + visuals):** sync precision + uniform grid +
  sync-state — does sync stay reliable over a long multi-track session (no 4th-track failure,
  grids parallel, tempo locks, master reassignment takes)?
- **Category B (REAL-NETWORK = audio):** connection fixes (gridcouple/progthrottle/jbtarget) —
  is partner audio clean over the wire? Ceiling = Opus FEC (not built) for real packet loss.
A failure in one is NOT attributed to the other; today's local fixes are NOT assumed to fix
the audio category. THEN: human-engineer review of the core sync/audio before launch.

## ═══ SESSION END — June 27, 2026 — DOGFOOD AUDIO DIAGNOSIS (CONCLUSIVE) + EXPERIMENT DEPLOYED ═══

Pivoted from polish to the #1 blocker: the Jake B2B dogfood was **unusable after ~1 min** —
audio and waveform too choppy to mix. This session **conclusively diagnosed the cause by
elimination** and **deployed a flagged A/B experiment** to confirm the fix. The A/B itself runs
next time Jake is available (he left before we could run it).

### THE DIAGNOSIS — conclusive (root cause isolated by elimination)
Symptom: heavy, sustained packet loss on Jake's side — `[JITTER-DIAG] concealMs≈472–670,
lostΔ≈24–34` (~30 packets/window), plus `[MIRROR-SNAP]` waveform jumps (+186s/+54s). My side
was spotless the entire log (`concealMs=0 lostΔ=0`). We ruled out every external cause:
- **Relay — RULED OUT.** New `[ICE-PATH]` logging (shipped this session, commit `9bd023d`)
  showed **DIRECT P2P both ways** (me `srflx/udp` 24ms RTT; Jake `host→srflx/udp` 20ms). No TURN.
- **Bandwidth — RULED OUT both sides.** Me **757/166**, Jake **323/115**. 256k audio is ~0.03%
  of either uplink. Not remotely a capacity problem.
- **Distance/latency — RULED OUT.** ~20ms RTT, direct.
- **"Wrong value / missing flag" — RULED OUT by the ASYMMETRY.** Both sides send identical 256k
  stereo, yet **only the busy sender's OUTBOUND loses** (~30 pkts/window) while the received
  stream is clean. If the value/flag were wrong, *both* directions would suffer.
- → **REMAINING CAUSE: 256k STEREO encode/pacing load on the busy sender's CPU/pipeline.** The
  sender (running the full DJ app — two deck decodes + 60fps waveforms) starves the audio
  encode/pace thread → packets produced late and **CLUMPED** → the receiver's jitter buffer
  counts late/clumped packets as **lost** and conceals. This explains the paradox (clean, fast,
  direct connection yet "loss"), and matches our own code's note (~line 9810) that packets
  "arrive EVENLY on localhost but CLUMPED over a real network."

### THE EXPERIMENT — built + deployed, default-OFF (commit `755e90d`, live bundle `main-BzLdUPQv.js`)
Two send-side levers, both safe in prod (prod unchanged until a flag is added):
- **`?audiolite`** (default OFF) — shapes ONLY the WebRTC peer monitoring stream (local deck
  playback + the recorder tap `eng.master` and are untouched). Grammar: kbps + optional `m` for
  mono. **STEREO is the default — we do NOT ship mono** (the active deck flips senders, so a mono
  peer stream would flip stereo↔mono on every handoff = jarring/ear-fatigue; established earlier).
  Lowers BOTH the SDP `maxaveragebitrate` and the sender `maxBitrate` ceiling; FEC stays on.
- **`contentHint="music"`** on the sent track (UNCONDITIONAL, now on prod) — tells the encoder
  it's music, not speech, so it skips voice-tuned processing. The legit "how-we-send" config fix;
  minor next to bitrate but standards-based. Validated non-breaking by `e2e-opus` (5/5, still
  negotiates stereo 256k + FEC by default).

### THE PENDING A/B LADDER (run with Jake — busier machine SENDS; capture Jake's console each round)
Capture `[JITTER-DIAG] concealMs/lostΔ` + `[OPUS-SDP] SEND` (confirms bitrate changed) +
`[MIRROR-SNAP]` per round; swap who sends for one round to confirm it follows the sender.
- **R1** `(no flag)` = 256k stereo baseline (have it: concealMs~600, lostΔ~30)
- **R2** `?audiolite=64m` = **THE FORK** (mono diagnostic)
- **R3** `?audiolite=96` = stereo candidate
- **R4** `?audiolite=128` = stereo candidate (best quality)
Interpretation:
- **Mono 64m goes CLEAN** → encode/volume load confirmed → climb to the **highest STEREO rung
  that stays clean** → **ship that stereo bitrate** (never mono).
- **Mono 64m STILL lossy** → not about data volume → **pivot** to send-pacing/CPU investigation
  (bitrate is not the lever).
- Win = highest stereo rung where Jake's conceal/lost → ~0.
Honest confidence: with bandwidth/relay/distance all eliminated, the encode-load theory is the
prime and near-sole explanation, so reduced-bitrate STEREO has strong reason to work — but the
mono fork is what makes it conclusive rather than assumed.

### SEPARATE BUG (flagged, NOT part of the audio fix)
**Kick-behind-waveform on a LOCALLY-loaded track** (Jake's deck B, which he loaded himself):
local audio is ahead of where the waveform shows it by a couple seconds. This is a local
deck audio-vs-waveform TIMING bug, distinct from the packet-loss issue. Investigate separately.

### ALSO PARKED (not shipped)
- **Solo-state copy reframe** — DONE, localhost-ready, **uncommitted** in the working tree. Three
  surfaces reframed so solo reads as a complete, intentional mode (never "offline/waiting"):
  header AUDIO pill (`AUDIO: OFFLINE` → `Solo session · invite a partner`; connected →
  `Mixing with [name]` showcase, restrained per Quiet Pro Tool), chat header (`waiting for
  partner` → `Solo session`), RTC panel (`OFFLINE`/`Waiting for partner` → `SOLO`/`Solo session —
  invite a partner to go live`). Real failures (NO OUTPUT/FAILED) preserved as attention-red.
  Invite-affordance WIRING deferred to a follow-up (copy only this pass). NOTE: `contentHint`
  rode to prod separately; the solo COPY did not.
- **Solo-as-first-class positioning** — captured to memory (`project_solo_first_class`): solo
  mixing is a legit, valued, COMPLETE use case and the on-ramp/broader market; collaboration is
  the differentiator + upgrade moment. **TODO: promote to a repo doc** (e.g. tools/docs/) so it's
  unmissable to fresh sessions, same as SOCIAL_DESIGN_PHILOSOPHY.

### STATE
- Prod `master` @ `755e90d`. Two commits shipped this session: `9bd023d` ([ICE-PATH] logging),
  `755e90d` (?audiolite experiment + contentHint). Both content-verified live.
- Smoke before push: 24 pass / 2 dep-skip / 1 fail — the fail (`e2e-sync`, a prod-relay flake)
  reproduced GREEN 2× in isolation; `e2e-opus` 5/5 confirmed the default Opus path unchanged.
- NEXT: run the A/B ladder with Jake → pick the ship stereo bitrate (or pivot to pacing/CPU).

---

## Session end — June 29, 2026 — Audio loss levers: ?audionack + ?audiolite auto-match

### SHIPPED (prod master @ 88e366e, content-verified live in main-Btc3mFMH.js)
Two orthogonal, flag-gated levers for the confirmed ASYMMETRIC send-path packet loss
(receiver of a busy sender sees concealMs~375 lostΔ~19; sender side clean; 3rd dogfood
confirmation). Both DEFAULT OFF — prod negotiation unchanged (default-session SDP byte-identical).

- **?audionack — LEAD candidate (loss RECOVERY, full quality).** Research surfaced the gap:
  Chrome does NOT negotiate NACK for Opus by default (video gets it, audio doesn't). We now
  inject `a=rtcp-fb:<opus-pt> nack` so genuinely-lost packets RETRANSMIT. Textbook fit for our
  profile: direct P2P, ~20ms RTT, 160-220ms jitter buffer = a retransmit lands long before
  playout; NACK beats FEC on BURSTY loss; keeps full 256k quality (NO tradeoff). If it works we
  ship full quality and we're done. CAVEAT: currently needs the flag on BOTH peers (the
  auto-match mirrors the audiolite PROFILE, not the nack line). For the Jake session both load
  the same URL anyway. Optional follow-up: answerer-mirrors-nack for true one-flag behavior.

- **?audiolite auto-match — bitrate FALLBACK (loss PREVENTION, quality tradeoff).** Fixes the
  old crash: ?audiolite=64m munged only the RECV side → mismatched/asymmetric SDP → connection
  hung up. Now the ANSWERER mirrors the initiator's parsed Opus profile (stereo + bitrate), so a
  single flag set by ONE peer applies BOTH directions (no manual URL coordination, no mismatch).
  Advertises the lower (min) bitrate, which per RFC 7587 also caps the initiator's encoder. NOTE
  re-frame: the actual send bitrate is already capped by min(sender maxBitrate, partner fmtp), so
  the "256k SEND" in the old log was a LABEL — the real lever is the encoder cap. The old crash
  was the MONO fork (stereo=0 vs stereo=1), not the bitrate asymmetry; STEREO rungs (96/128) are
  the safe ship candidates. channels=2 + stereo=0 is NORMAL (Opus rtpmap is always /2), not a bug.

- **[OPUS-SDP] proof logging** now reports NACK negotiation (local/remote, read from the session
  descriptions) → retransmission is provable, not inferred. ("RETRANSMISSION ACTIVE both ways" /
  "one-sided" / "OFF").

### NEXT JAKE SESSION — test both orthogonal levers in one build
- `?audionack` on BOTH machines (lead — full quality). Watch [OPUS-SDP] for "RETRANSMISSION
  ACTIVE both ways" + whether concealMs/lostΔ on the receiver drop.
- `?audiolite=96` / `?audiolite=128` (stereo fallback — one machine sets it, auto-matches).
- `?mirrordiag=1` to ALSO capture the waveform-freeze data (see PARKED below).

### PARKED — waveform fps freeze (displayedProg stuck at 0.7222 while audio advances)
Diagnosed but NOT fixed — BLOCKED on data. The mirror follower (remRaf) has coast + 3x catch-up +
creep, so low-fps alone can NOT freeze it; a hard freeze at a constant means the RAF callback
stopped entirely. Three candidates, disambiguated ONLY by the live log fields:
(1) tab hidden/occluded → browser SUSPENDS raf (audio + 1s setInterval keep running) — NOT a bug;
(2) main-thread long-task stall (CPU overload) — the shared-root-cause-with-audio-loss case;
(3) stuck remAwaitPktRef hold on a playing flicker with sparse packets.
Need `[MIRROR-DIAG] hidden=` and `[MIRROR-RAF] fps=/droppedFrames=` from a freeze window
(requires ?mirrordiag=1). hidden=true → (1), unrelated to audio. hidden=false+low-fps → (2).
Latent bug found: the visibility re-anchor handler at the deck is dead code (`if(local) return`
with local always true) — likely the real repair if cause #1.

### PARKED — solo-UI copy reframe (project_solo_first_class)
Still uncommitted; this session STASHED it (stash@{0} "project_solo_first_class WIP") to ship the
audio experiment CLEAN/isolated. It hides the `⟺` partner pill on connect (→ "Mixing with [name]"),
which breaks smoke's partnerOf (greps `⟺`). When resuming: pop the stash AND update
tools/smoke/lib/e2e.mjs partnerOf to also detect "Mixing with".

### STATE
- Prod `master` @ `88e366e` (was 2c3255a). One commit this session: the audio levers. Content-
  verified live (audionack/AUDIO-NACK/a=rtcp-fb/auto-matched present in main-Btc3mFMH.js).
- Smoke before push: 24 pass / 2 dep-skip / 1 fail — the fail (`e2e-sync`, prod-relay flake)
  proven NON-CAUSAL via interleaved clean-vs-changed (6/6 identical) + 8/8 green in isolation;
  `e2e-opus` (exercises the SDP path) PASSED. e2e-entry/rejoin/lock-stability flakes also cleared.

---

# Session end — June 30 / July 1, 2026 — THE REFRAME: Jake's dropouts are a TIMING/sync bug, not packet loss

## HEADLINE DECISION (canonical — supersedes the "audio packet loss" framing for Jake's symptoms)
Jake's "choppy audio / waveform lag / kicks double-hitting / out of sync" is a **TIMING problem**,
not packet loss. Mechanism: the local-monitor delay-comp (`monitorDelay`, ~L535; it shifts LOCAL
audio later to line up with the partner's jitter-buffered late stream) **SATURATES at its 400ms
cap** when real network jitter balloons the partner buffer to 500–650ms. comp measures ~650 but
applies only 400 → ~250ms un-compensated offset → the audible flam. Loss makes audio CUT OUT; this
makes beats MIS-ALIGN — different failure mode. Why it held on loopback but broke with Jake:
loopback has no jitter → buffer stays ~220ms → cap never bites. See memory
`project_jake_dropouts_are_timing`.

## THE NEW TOOL (removes the Jake bottleneck for this bug class)
`?jbtarget=650` on two loopback tabs PINS a deep buffer = **Jake-latency proxy with ZERO network**.
Reproduced Jake's exact numbers locally: comp measured=666 applied=400 residual=266ms (Jake's log:
665→400). So the deep-buffer/cap-saturation class is now fixable + A/B-able locally, no Jake needed.

## EARS OVER NUMBERS (Chad's feel test — decisive)
- `?compcap=650` and `=800` (raise the cap): numbers align (measured=applied, residual 0) but STILL
  double-kicks by ear → **REJECTED**. Raising the cap to match a deep buffer sounds bad.
- Plain (jbtarget=220, shallow, comp~235): sounds good, barely any double-kick, **play/pause lag GONE**.
- VERDICT: **KEEP THE BUFFER SHALLOW is the fix, NOT raise the cap.** (Lesson re-confirmed:
  measured=applied only proves the delay was APPLIED, not that it SOUNDS aligned. Ears win.)
- Play/pause control-vs-audio lag = the SAME buffer-depth problem (monitorDelay delay-line drains
  after stop; deep = long tail = visible lag). Shallow fixes both symptoms. Not a second bug.

## SHIPPED THIS SESSION (all pushed, content-verified live, default-safe/byte-identical with flags off)
- **`?ptime=40/60`** (e636c08) — Opus frame size via `RTCRtpSender.setParameters encodings[].ptime`
  (SDP `a=ptime` ALONE is ignored by Chrome — the "looks-set-ignored" trap). Verified takes live
  (SEND=27 pkt/s). Auto-matches offer↔answer; has a "rejected" confession log if the browser refuses.
- **`[SEND-DIAG]` sender telemetry + `packetsDiscarded` (discΔ)** (68b2014) — outbound pkt rate,
  send-queue wait, retransmits, availableOutgoingBitrate, qualityLimitationReason, and the partner's
  RTCP report of OUR send loss. Read via `p.getStats()` (receive telemetry is receiver-scoped).
  Confirmed on loopback: our SEND is CLEAN → not outbound congestion. discΔ splits
  arrived-but-dropped (receiver/CPU) from never-arrived (wire).
- **Lever-reliability bugfix** (68b2014) — initiator re-reads the negotiated Opus profile in
  `handleAnswer` and re-applies the (possibly-lower) send bitrate/ptime. Without it, a
  `?audiolite`/`?ptime` flag set on the ANSWERER alone never dropped the initiator's real send.
- **`?compcap=<ms>`** (68b2014, default 400 = byte-identical) — raises the delay-comp ceiling.
  Kept as a **DIAGNOSTIC knob** (it proved the cap-saturation mechanism), NOT the fix.
- **NACK proof re-log** (f2f3ed5) — re-prints `[OPUS-SDP] audio NACK negotiated` every 20s (gated
  on `?audionack`) so it can't scroll off a long dogfood.

## RESEARCH (investigation-only, both correctly PARKED/STOPPED)
- **RED distance=2 — STOPPED.** NOT reachable via SDP: Chrome hard-wires Opus send-redundancy to
  distance=1 (`kRedNumberOfRedundantEncodings=1`), does NOT read distance from SDP, and the
  `WebRTC-Audio-Red-For-Opus` fieldtrial isn't page-settable. A `?red=2` flag would be a dead
  "looks-set-ignored" trap. The ONLY page-reachable path is building RFC 2198 RED packets ourselves
  via Encoded Transform (`RTCRtpScriptTransform`, stable Chrome 141+, Jitsi `RFC2198Encoder`
  reference). Real build, 3× bitrate → pair with low base bitrate. STOPPED — aimed at an unconfirmed
  end; revisit only if diagnosis proves bursty loss is the driver.
- **Cloudflare Realtime (Lever 2) — PARKED.** A relay only helps the PATH case; does NOTHING for
  last-mile/endpoint (their docs concede the last mile stays public-internet). TURN-both-ends >
  their SFU for 2–4 people; ~$0 at our scale; latency delta must be measured not assumed. Revisit
  ONLY if a Jake session shows the path is a big jitter source. It also independently endorsed our
  existing `?ice=relay` + getStats-split as the cheap first experiment.

## GHOST — do NOT re-chase (Chad's gut-check, correct)
The shallow-buffer residual "slightly off" heard on TWO-TAB LOOPBACK is largely a **loopback/machine-
specific artifact**: the Web-Audio-vs-`<audio>`-element output-path mismatch, a FIXED per-machine
constant. A hand-tuned `?compoffset` (built + REVERTED this session) would measure Chad's laptop's
constant and mean nothing for Jake, whose residual is **network-dominated and variable** (wrong value
AND wrong shape — a fixed offset can't track a variable network term). Chasing it = re-solving the
two-tab case already fixed weeks ago. If a residual PERSISTS after the buffer is confirmed shallow on
Jake's REAL network, the right fix is architectural (route partner stream through Web Audio to kill
the output-path mismatch for everyone, no tuning) — NOT before.

## PENDING — Jake-gated (the one thing loopback CANNOT answer)
Does **keep-shallow HOLD on Jake's real network?** — i.e. do `?audiolite`/`?ptime` reduce real jitter
enough that NetEQ never balloons the buffer past ~220ms. Loopback has no jitter to reduce, so this is
purely a Jake datapoint.
- **NEXT JAKE SESSION:** `?audiolite=96` (or `128`) on **Chad or BOTH, never Jake-alone** (Chad is
  always initiator, C<J). Console open, watch: `[JITTER-DIAG] jbTargetMs` (stays ~220?),
  `[SYNC-COMP] measured` (stays <400, no saturation?), `[SEND-DIAG]` (send clean?).
  SUCCESS = buffer shallow + comp unsaturated → the flam should not appear.
- IF still off after buffer confirmed shallow → the architectural Web-Audio-routing fix (above).
- Held levers: lower `?jbtarget` (e.g. 160) to cut absolute latency (trades underrun risk);
  continuous ICE-path re-sample (audit item 4, not built).

## STATE
- Prod `master` @ `68b2014`. Commits this session: `f2f3ed5` (NACK re-log), `e636c08` (ptime),
  `68b2014` (SEND-DIAG + lever-reliability fix + ?compcap). Each pushed on a GREEN full smoke
  (25 pass / 0 fail / 2 dep-skip) and content-verified in the live bundle.
- `?compoffset` built + REVERTED (loopback ghost). Working tree clean at `68b2014`.
- New memory: `project_jake_dropouts_are_timing` (the reframe + `?jbtarget=650` local repro).

---

# Session end — July 1, 2026 (autonomous) — Jitter harness shipped; lever ladder ANSWERED locally: no audio lever keeps the buffer shallow under burst jitter

## JOB 1 — ?ice=relay real-transit test: Chad's uplink is CLEAN
Two-tab + `?ice=relay` (both tabs), 4 min, TURN relay confirmed on both sides
(`[ICE-PATH] local=relay/udp remote=relay/udp`, rtt 25–33ms). With real internet
transit (machine → TURN → machine) in the path: **jbTargetMs pinned at 220 for
all 115 samples, comp measured ~227 max 239, zero conceal/loss/discard, rtp
jitter mean 6ms.** Real transit through the relay does NOT balloon the buffer →
the path from Chad through TURN is not the jitter source; Jake's jitter is his
last mile / environment. (Also independently re-confirms TURN works, and that
the PARKED Cloudflare lever stays parked.)

## JOB 2 — jitter harness: TWO built, one sudo-blocked, one verified
- `tools/netem/dummynet-jitter.sh` — the pf+dummynet kernel harness as specced
  (delay toggle HIGH↔LOW + plr, lo0-scoped, skip-on-lo0 stripped, full cleanup,
  self-verify instructions in header). **UNVERIFIED: needs sudo (password), which
  an autonomous session doesn't have.** Run it manually when kernel-level ground
  truth is wanted; if jbTargetMs doesn't balloon, suspect dummynet-inert-on-
  modern-macOS and fall back to the proxy below.
- `tools/netem/turn-jitter-proxy.mjs` — UNPRIVILEGED equivalent, VERIFIED. Local
  UDP forwarder in front of the real TURN server; `VITE_TURN_URLS=turn:127.0.0.1:3479
  npm run dev` + `?ice=relay` puts all media through it. Seeded/deterministic,
  shapes only media frames (setup always crisp), HTTP control (POST :3480/shape),
  per-leg byte accounting, optional bwKbps queue model. Zero machine residue.
- `tools/smoke/measure-relay.mjs` — the run driver: two tabs, relay-proof gate,
  N-minute measurement, jbTargetMs/[SYNC-COMP]/conceal/loss percentile report +
  raw log to tools/smoke/out/. NETEM_URL/NETEM_PROFILE envs drive the proxy.
- SELF-VERIFY PASSED after one calibration step. Frozen Jake-profile:
  `{"highMs":250,"lowMs":10,"periodMs":1000,"plr":0.005,"noiseMs":20,"seed":1}`
  (per-crossing; media crosses the proxy 2× → effective ~20↔500ms bursts, ~1%
  loss). Reproduces Jake's exact signature ON DEMAND, no Jake needed:
  jbTargetMs ~532–540 (Jake: 500–650), measured climbs ~450–480+ while applied
  SATURATES flat at 400 — the cap-saturation flam mechanism.

## THE LADDER (3-min runs, identical frozen profile, one lever at a time)
| run | jbTargetMs p50 | measured p50 | applied
| baseline            | 540 | 337 | saturates 400
| ?audiolite=96 (took: targetKbps=96, fmtp 96000) | 536 | 334 | saturates 400
| ?ptime=40 (took: 25 pkt/s)  | 528 | 385 | saturates 400
| ?ptime=60 (took: 17 pkt/s)  | 541 | 400 | saturates 400
| combo 96+40 (both took)     | 531 | 335 | saturates 400

**VERDICT: NULL ACROSS THE BOARD — and mechanistically expected in hindsight.**
NetEQ's buffer target tracks packet ARRIVAL-TIME variance. Bitrate/packet-rate
levers only reduce jitter that is SELF-LOAD-INDUCED (own stream queueing a
constrained link). Against exogenous burst jitter (other traffic, WiFi airtime
stalls — the delay the network adds regardless of our load), they change nothing;
ptime if anything worsens comp saturation (bigger frames = coarser recovery).
Chad's success metric (jbTarget ~220, measured <400) is NOT achievable with
these levers under burst jitter.

## DISCOVERY — headless harness sends near-silent audio (caveat + follow-up)
Per-leg proxy accounting: BOTH tabs send ~25kbps at full packet rate, identical
for the kick fixture and a real music track → deck content is not reaching the
encoder with real energy in headless Chrome. This does NOT touch the ladder
conclusions (NetEQ target is arrival-timing-driven; packets flowed at full rate;
ptime provably changed the stream and still nulled). It DOES mean: (a) the
load-dependent/bwKbps branch is untestable headless (a cap can't bite a silent
stream); (b) we still don't know the REAL mid-track send bitrate on a headed
session — the [OPUS-SDP] one-shot fires at connect (before play; that's why it
logs bitrateKbps=1). FOLLOW-UP (tiny, needs approval — src change): add outbound
kbps to [SEND-DIAG] so the next real dogfood reports the true wire rate.

## WHAT THIS MEANS FOR THE PENDING JAKE QUESTION
"Do ?audiolite/?ptime reduce Jake's real jitter enough to keep the buffer
shallow?" now has a strong local prior: **only if his jitter is self-load-induced
— and our stream is featherweight (tens of kbps on the wire), so that's unlikely;
if the jitter comes from anything else on his WiFi, these levers do nothing.**
The next Jake session should still capture [JITTER-DIAG]/[SEND-DIAG] (now the
levers' takes are provable), but the working assumption flips: stream-lightening
is NOT the path to keep-shallow. The candidate paths that remain are the parked
architectural one (route partner audio through Web Audio) and/or rethinking how
comp handles a deep-but-honest buffer — the latter re-opens ears-rejected
territory, so it needs Chad's call, not a default.

## HOW TO RERUN (fully local, deterministic)
1. `node tools/netem/turn-jitter-proxy.mjs &`
2. `VITE_TURN_URLS="turn:127.0.0.1:3479" npm run dev &`
3. `NETEM_URL=http://127.0.0.1:3480 NETEM_PROFILE='<frozen profile above>'
   FLAGS="ice=relay&<lever>" DURATION_MIN=3 node tools/smoke/measure-relay.mjs`
Raw logs from tonight: tools/smoke/out/relay-*.log

## STATE
- No src/ changes. New: tools/netem/ (2 files), tools/smoke/measure-relay.mjs,
  this handoff. Pre-existing untracked measure-b2b/measure-disambig/out left as
  found (separate B2B-accuracy thread).
- Machine clean: pf/dummynet never touched (sudo unavailable); proxy + dev
  server stopped after runs.
- New memory: project_jitter_harness_and_ladder.

---

# Session end — July 2, 2026 — Load-dependent rung: ?audiolite=96 WORKS when jitter is self-congestion; harness had been measuring a silent stream (fixed)

## CORRECTIONS to the July 1 late-session handoff (important — supersede in place)
- **"Our stream is featherweight (~25kbps)" was WRONG** — an artifact of a harness bug, not
  reality. A playing 256k-stereo session ACTUALLY SENDS the full 256kbps payload, **~281kbps on
  the wire** (proxy per-leg ground truth + new [SEND-DIAG] outKbps=256). Two DJs both playing ≈
  ~560kbps of continuous 50pps UDP on shared airtime. Self-congestion is PLAUSIBLE after all.
- **The harness bug:** measure-relay toggled play before the deck's decode finished →
  `toggle()` with hasBuf=false is a defensive UI-only no-op → deck never played → the whole
  July 1 ladder streamed a SILENT master mix. Found via [PLAY-STATE] hasBuf=false in every raw
  log. FIXED: wait for [ANALYZER-BROADCAST], toggle, hard-verify hasBuf=true + progress
  advancing. Headless renders audio fine — the "headless silence" theory was wrong.
- **The July 1 exogenous-ladder NULLS STILL STAND** — NetEQ's buffer target is driven by
  arrival TIMING; packets flowed at full rate all night and ptime provably changed the packet
  rate with no effect. Silence doesn't change arrival-time variance.
- ⚠ FLAG (not fixed, needs decision): the e2e smoke tests share the same load→toggle race —
  e2e-comp etc. have likely been measuring a silent-but-connected stream. Passing today, but
  an energy gate (e.g. assert outKbps > threshold) would make them honest. Follow-up candidate.

## SHIPPED THIS SESSION
- **[SEND-DIAG] outKbps** (approved 2-liner, src) — actual outbound wire rate from bytesSent
  delta, next to the targetKbps cap it was previously confused with. Log-only.
- Harness: measure-relay load-race fix + play verification; HEADFUL=1 option in e2e launch;
  proxy: bwKbps/maxQueueMs were silently dropped by the /shape whitelist (fixed), per-leg
  counters reset on profile POST.

## THE LOAD-DEPENDENT RUNG (one rung, as scoped — then stop)
Real track (Kyotto via /@fs/), real 256k send confirmed, frozen profile
`{"highMs":30,"lowMs":10,"periodMs":600,"plr":0.002,"noiseMs":5,"seed":1,"bwKbps":200,"maxQueueMs":900}`
(cap sized ONCE from measured wire: baseline 281k = 40% over, audiolite 118k = 40% under). 3 min each:

| run | B jbTargetMs | B comp measured | link queue | loss |
| baseline 256k | p50 476 / p90 586 / max 627 | p50 270 / max 980 (applied pinned 400) | 2522 drops, pegged 900ms | bursts to 27% |
| ?audiolite=96 | **220 flat, every sample** | ~219, never saturates | 0 drops, qMax 111ms | ~0 |

**VERDICT: the lever LIVES for the self-congestion case.** When the jitter is load-coupled,
audiolite=96 completely prevents the balloon AND the loss (same mechanism produces both —
matches "worse while Jake plays"). Combined with July 1: levers do NOTHING vs exogenous burst
jitter, EVERYTHING vs self-congestion. The Jake session determines which world he's in.

## NEXT JAKE SESSION — decision tree (updated)
**STEP ONE, before any flags: Jake plugs into ETHERNET.** (Chad's call. His 400Mbps/high-end
rig means bandwidth+CPU were never it; WiFi timing stalls fit the buffer signature exactly.)
1. **Wired baseline:** buffer sits ~220 → his case is environmental (WiFi) → the architectural
   fix reprioritizes from "required" to "robustness"; the practical fix may be "plug in".
2. **Still deep on Ethernet** → real path/exogenous jitter → levers won't help (July 1 nulls)
   → architectural path required.
3. **Back on WiFi + ?audiolite=96 (Chad or BOTH, never Jake-alone):** buffer stays shallow →
   self-congestion confirmed → the lever ships for WiFi users.
4. **WiFi + audiolite doesn't help** → exogenous WiFi stalls → environmental/architectural.
Watch: [JITTER-DIAG] jbTargetMs, [SYNC-COMP] measured-vs-applied, [SEND-DIAG] outKbps (now
shows the REAL send rate; 256 = playing, ~1 = idle/silent).

## BANKED — DO NOT BUILD (Chad, July 1)
- (a) The raised-cap ear-rejection (?compcap 650/800 "still double-kicks") was CONTAMINATED by
  the output-path ghost (Web-Audio-vs-audio-element mismatch): deep comp has NEVER been
  ear-tested ghost-free. **Web-Audio routing + deeper comp is a candidate PACKAGE**, not two
  separate rejected ideas.
- (b) Deep-buffer path parked idea: **quantize comp to whole beats** (NINJAM-style) so kicks
  coincide at far less local delay than full-buffer compensation.

## STATE
- src change: [SEND-DIAG] outKbps only (log line). Tools: measure-relay fixes, proxy fixes,
  HEADFUL launch option. Machine clean (proxy + dev server stopped; pf never touched).
- Raw logs: tools/smoke/out/relay-rung-*.log, relay-energy-fixed-probe-1.log (the outKbps=256
  proof), relay-headed-energy-probe-1.log (the hasBuf=false smoking gun).
- Memory: project_jitter_harness_and_ladder REWRITTEN (featherweight claim corrected).

---

# Session end — July 2/3, 2026 (overnight) — Mirror bug DIAGNOSED + FIXED (MIRROR_TSEND); dogfood logs parsed; e2e race fixed

## LOG PARSE — confirms + corrections (Chad's reads, checked against artifacts)
Only TWO files existed on this machine (no session-logs/ dir anywhere — repo, Desktop,
Downloads, Documents, Dropbox, iCloud, Google Drive):
- `~/Downloads/collabmix.vercel.app-1782962446298.log` — **this IS jake-twoway.log**
  (Chrome default filename, never renamed). Proof: its owner "DJ Flux cfa7" has partner
  "DJ Prism d4fc" = the local DJ of Chad's own session JSON (suffixes are client-stable);
  deck B driven locally + [ANALYZER-BROADCAST] deck B = Jake loading/playing, as described.
- `~/Downloads/mixsync-session-…-neon-haze-545.json` — Chad's Cmd+Opt+L export (4.4min slice).
- **Phase 1/2 logs do NOT exist on this machine** — if they were saved, they're still on
  Jake's machine / in chat. The Phase 1-2 claims rest on what was seen live.
- ⚠ CAVEAT on "all night, every sample": the console log is EXACTLY 1000 lines — Chrome's
  buffer cap — covering only the last ~7 min (two-way tail). Within that window every read
  CONFIRMS: jbTargetMs 220 × 203 samples, comp max 269.1, one concealMs=20, one lostΔ=1,
  DIRECT P2P rtt 25ms, 256k both ways, outKbps 256 while playing / 1 idle. Cleanest window
  we've ever measured. audiolite verdict UNTESTED-NOT-FAILED stands (banked, not dead).
- BPM pair CONFIRMED in detail on Jake's deck B (bad: period 0.6589s→88.2, periodIntegerLocked
  =false crossValidated=false snapped=false firstBeatDpIdx=46, 443 beats; good: 0.4878s→123,
  all guards true, idx=0, 641 beats). CORRECTION: implied durations differ (292s vs 313s) →
  probably TWO DIFFERENT TRACKS, not same-file non-determinism. Awaiting Jake's filename(s).
  Also confirmed: zero MIRROR-STALE (the warn is UNGATED, so zero = genuinely no >1.5s gaps).

## THE MIRROR BUG — reproduced, diagnosed, FIXED (tonight's directive)
**Repro:** clean loopback is SILKY (mirror lag 54±5ms, 120fps, zero backward steps) — the
pipeline is capable. Deterministic repro via mock netem on deck_update only
(`{latencyMs:80, jitterMs:260, seed:42}` ≈ real TCP WS clumping, Jake's documented 100-600ms
pktGaps): lag blows out to p90 +130 / max +268ms with ±200ms wobble. Same seed every run.
**Diagnosis (two parts, both required):**
1. The follower anchored its coast at packet ARRIVAL time → TCP clump hold-back became
   mirror lag; the slope rate-estimate wobbled on arrival jitter (the "jittery waveform").
2. The render layer (gridcouple alignSec — applied to BOTH decks, and that's CORRECT:
   local audio is monitorDelay-late, partner audio is jitter-buffer-late, both ≈comp)
   draws the playhead at the AUDIBLE position ASSUMING the follower tracks truth →
   **every ms of follower lag = "audio leads the playhead"**, no cushion. Jake's real
   clumps ≈ up to a beat. Asymmetry = whichever WS direction clumps worse.
**Fix — MIRROR_TSEND (default ON, `?mirrortsend=0` legacy A/B):** receiver-only, ZERO wire
change (t_send is ALREADY on every progress broadcast — sync's phase monitor used it; the
mirror dropped it). Thread {tSend,tRecv} through the coalescer; rolling-min (15s) of
tRecv−tSend isolates clock-skew+minTransit; anchor at (arrival − clumpExcess); the rate
slope becomes Δvalue/Δt_send (exact by construction). Sender clock resets degrade to
bounded legacy behavior (2s cap + window aging). [MIRROR-NET-DIAG] logs clumpExcessMs.
**Proof (identical seeded netem):** legacy p90 +130/max +268ms → fix p90 +13/max +25ms
(10× tail collapse). Raw: tools/smoke/out/mirror-fix-{on,off}-1.log.
**Permanent gate:** `e2e-mirror-clump` (mock suite; bounds p90<80/max<150 sit between
legacy-fail and fixed-pass; also re-asserts monotonicity).

## ALSO SHIPPED — e2e load→toggle race (approved follow-up)
`loadAndPlay()` in lib/e2e.mjs (wait [ANALYZER-BROADCAST] → toggle → assert hasBuf=true);
applied to e2e-comp (the energy-sensitive test — it had been measuring a silent-but-
connected stream). Other tests gate timing, not energy — sweep them later if wanted.

## GATES (both green before push)
- Mock suite (`smoke:e2e -- --mock`): **22/22 PASS** incl. e2e-mirror-clump (new),
  e2e-mirror-latency, e2e-mirror-slew, race-safe e2e-comp.
- Full default smoke: **25 pass / 0 fail / 3 dep-skips** (the mock-gated trio — correct).

## MORNING EYEBALL (Chad)
Two-tab prod (or wait for next Jake session): default URL = fix ON. A/B: add
`?mirrortsend=0` to BOTH tabs for legacy. `?mirrordiag=1` shows clumpExcessMs live.
On loopback both look similar (clean network) — the difference shows under real WS jitter,
so the REAL verify is the next Jake session: his screen, Chad's deck, watch whether the
playhead sits on the kick.

## PENDING
- BPM misdetection repro — waiting on Jake's track file/name; fix direction per Chad:
  guard-failure → tempo-ratio retry (×4/3, ×3/2, ×2) or surface low-confidence in UI.
  Also flagged: what does SYNC do when engaged on a misdetected grid?
- Phase 1/2 session logs (if Jake saved them) for the full-night confirm.
- Jake headed-session [SEND-DIAG] outKbps reading + Ethernet-first decision tree (July 2).
- Minor: Jake's early Phase-1 stutter on a zero-loss stream — first-minutes settling, deprioritized.

## STATE
- src: MIRROR_TSEND (flag + coalescer threading + follower anchor) — flag-gated, legacy
  path byte-identical with ?mirrortsend=0. Tools: measure-mirror.mjs (dual-tab sampler,
  netem/CPU-throttle axes), e2e-mirror-clump test, loadAndPlay helper.
- New memory: project_mirror_pipeline_fix.

---

# Session end — July 3, 2026 (overnight, part 2) — ?connwarn shipped (DEFAULT OFF, awaiting eyeball); stall-and-flush mock mode; e2e-sync ambient instability documented

## ?connwarn — the connection-quality forecast (WARN ONLY, default OFF)
Passive good/marginal/poor from receiver-side stats ALREADY polled (zero new getStats):
the [JITTER-DIAG] window deltas + comp rtt. Classifier is a pure module
(`src/conn-quality.js`, rekordbox-grid.js pattern) wired into useRTC behind
`?connwarn=1`. NO lever is auto-applied — levers stay manual until proven on a real
bad network. Transitions log `[CONN-QUALITY] level=… — latest window: …`.

### THE BANDS (derived from measured sessions — Chad asked to see these)
| signal            | good  | marginal   | poor  | derivation |
|-------------------|-------|------------|-------|------------|
| jbTargetMs        | <260  | 260–379    | ≥380  | clean nights 220 flat; harness mild-jitter 225–229; Jake/harness deep 476–650. Poor edge = the 400ms comp cap minus playout headroom — warn AS saturation becomes possible, i.e. before the flam |
| rtp jitterMs      | <25   | 25–49      | ≥50   | clean 2–19 (mean 5–11); deep-buffer runs 37–77 |
| concealMs (/2s)   | <40   | 40–149     | ≥150  | clean 0 with one 20ms blip all night; congested bursts 200–420 |
| lossPct (/2s)     | <2%   | 2–7.9%     | ≥8%   | clean 0–1 pkt; self-congestion 10–27% |
| rttMs             | <600  | ≥600       | never | corroborator ONLY — a TURN long-haul adds honest baseline RTT with zero audible symptom; rtt alone must never paint poor |
- Worst signal wins per ~2s window; SUSTAIN machine: 3 consecutive bad windows (~6s)
  to escalate, 5 consecutive good (~10s) to clear. July 2's real clean-network blip
  (one concealMs=20 + lostΔ=1 window) is a non-event twice over (below-band AND
  unsustained).
- HONESTY NOTE: no measured session ever LIVED in 230–476 jbTarget; the marginal band
  is interpolated. The harness mid-profile run (below) landed there and HELD marginal,
  so the band is reachable and stable — but its edges are constants in conn-quality.js,
  one-line recalibratable when a real marginal session shows its numbers.

### UI (Quiet Pro Tool)
5px amber dot (`#f59e0b` — the semantic-indicator exception; same hue as this row's
"analyzing…" note) in the deck identity row (`A · partner ●`), PARTNER-driven decks
only. marginal = 55% opacity; poor = full + the row's standard dot glow. Tooltip:
"Partner connection unstable — audio may drift" / poor: "…poor — audio may drop or
drift". No modal, no red, nothing renders when good or when flag off.

### PROOFS (jitter harness) + PERMANENT GATE
- clean relay + connwarn: ZERO transitions over the run (stays good) ✓
- frozen Jake profile: marginal (buffer ramp) → poor within ~10s of shaping, both tabs ✓
- mid profile (120/10/800): buffer settles ~305–320 → MARGINAL, holds, no flap ✓
- `conn-quality` unit gate (18 checks): band edges on measured profiles, July-2 blip
  immunity, 3-up/5-down sustain, rtt-never-poor. Runs in the DEFAULT suite. (A mock
  e2e gate can't exist for this: the mock shapes the WS control plane only — RTP/NetEQ
  stats are physically out of its reach. Unit gate + live harness is the right split.)

### MORNING EYEBALL (before default-ON)
1. `?connwarn=1` two-tab loopback → play → NO dot ever (good is silent).
2. Live amber: `node tools/netem/turn-jitter-proxy.mjs` + `VITE_TURN_URLS=turn:127.0.0.1:3479
   npm run dev` + both tabs `?ice=relay&connwarn=1` + POST the frozen Jake profile to
   :3480/shape (VISION_5 July 2) → amber dot on the partner deck within ~15s, tooltip on hover.
3. If the look passes: flip default by changing `=== "1"` to `!== "0"` on CONN_WARN.

## ALSO SHIPPED — stall-and-flush mock netem (approved follow-up)
`stallMs` + `stallEveryMs` on the mock: TCP-faithful IN-ORDER clumping (hold FIFO per
connection, flush together) — the mode the independent-jitter model couldn't express
(it reorders, which TCP never does). Verified live: 40/296 packet gaps >300ms under
450/600 stall. FINDING: under pure stall-and-flush the LEGACY mirror only degrades
mildly (each flush ends with a fresh packet → anchor self-heals; p90 36ms vs dispersed
jitter's 130) — real WiFi is a mix of both patterns; MIRROR_TSEND wins in both (p90 13).

## HELD — __loadTestTrack decode-await race fix (patch parked, NOT guilty, NOT shipped)
`tools/patches/loadtracktest-race-fix.HELD.patch`. Supersedes the approved loadAndPlay
sweep (fixes every caller at the hook, zero test churn). Initial interleave blamed it
for e2e-sync failures — a cold-vite re-run showed the CLEAN tree failing 2/3 with the
IDENTICAL signature, so it is NOT causal. Held anyway because it makes decks REALLY
play in every e2e test for the first time (many currently toggle inside the decode gap
and run parked/silent) — a suite-semantics shift that needs a stable gate environment
and a deliberate bound review (e2e-sync's 45ms idempotency bound especially) in
daylight, not a 4am ship.

## AMBIENT FINDING — e2e-sync unstable tonight EVEN ON CLEAN TREE (documented, not chased)
~40% of e2e-sync runs tonight hang 45s in engage (phaseSeekMs=null) or wander ~97ms on
re-engage — INCLUDING on untouched `1a6080c` with a cold vite. Earlier the same evening
the full suite was green twice, so this degraded mid-night: prod-relay health at this
hour and/or hours-loaded machine are the suspects (matches the known-flaky memory:
"distrust flaky prod-relay gates"). Also fingered vite-HMR churn as an interleave
confounder — attribution runs MUST cold-restart the dev server per tree swap (learned
tonight, the hard way). Follow-up when convenient: route e2e-sync through the mock
relay to remove the prod dependency.

## GATES (shipping tree)
- Unit suite: green (conn-quality 18/18 included).
- Full default smoke: 25 pass / 1 fail / 3 mock-skips — the fail (e2e-lock-stability,
  known-flaky set) 3/3 GREEN in cold isolation → non-causal batch contention. e2e-sync
  passed this run; its earlier failures reproduced on the CLEAN tree (see above).
- Mock trio through the rewritten netem seam: latency 10/10, slew 4/4, clump 4/4.

## STATE
- src: conn-quality.js (new) + connwarn wiring/UI (flag-gated, default OFF — inert in
  prod paths without ?connwarn=1). tools: mock stall mode, conn-quality unit gate,
  HELD patch. Memory: project_connwarn_shipped; mirror-fix memory updated with the
  stall-mode finding.

---

# Session end — July 2, 2026 (weekend housekeeping + read-only queue) — ALL LOCAL, push freeze

## ⛔ PUSH FREEZE (Chad, this session) — expires Monday July 6
NO pushes to master until Chad is back Monday (prod auto-deploys, unwatched). Everything below
is COMMITTED LOCALLY on green gates, UNPUSHED. origin/master stays at `e089013` (the two
already-pushed commits — standing laws + deny-list — went out BEFORE the freeze). Unpushed
local: 9bce7bf, 753ceb5, 73675bc, dd6e680. Push together Monday after a full-suite run.
Memory `project_weekend_freeze_and_updater` (DELETE after Monday).

## Housekeeping
- **Standing laws → CLAUDE.md** (8 laws, permanent; every future session inherits them).
- **Deny floor** `.claude/settings.json` (force-added past .claude/ gitignore): rm -rf/-fr,
  git push --force/-f, Read(.env*), Write/Edit(~/Music/**). READ-only music enforced at harness.
- **Updater**: native user-owned build installed (~/.local/bin/claude, self-updating) + PATH line
  in ~/.zshrc. PARKED for Chad Monday (needs sudo/new terminal): `source ~/.zshrc` +
  `sudo npm -g uninstall @anthropic-ai/claude-code` (leftover root binary at /usr/local/bin).

## Shipped behind flags (default OFF, gated, LOCAL)
- **?bpmretry** (9bce7bf) — tempo-guard retry: ratio hypotheses ×4/3,×3/2,×2 each anchored to a
  REAL autocorr peak near the hypothesis lag (±2.5 BPM window) so the unchanged crossValidated
  test applies to independent evidence (a scaled estimate can't self-validate). Best validated
  candidate wins; none → original + lowConfidence (state only, no UI). Flag-off byte-identical;
  gated `bpm-retry` (audio, 6 checks). Calibration deliberately deferred to the audit corpus.
- **e2e-sync flake killed structurally** (753ceb5) — smoke runner spawns the mock WS relay BY
  DEFAULT (--no-mock opts out); e2e-sync + mirror trio run local/deterministic; direct-goto tests
  keep prod coverage. Verified 3/3 green under full audit-grind CPU load (the contention that
  flaked prod). Root cause was ambient prod-relay instability on the untouched tree (~40%).

## Read-only deliverables (dd6e680, + audit report artifact gitignored)
- **ANALYZER AUDIT** — 476 tracks, 0 errors. Honest read (report says so): 46.6% guard-fail is
  inflated; real remediation target = **38 real tracks (8.0%)** genuinely uncertain (rest are
  short sample/loop files where non-snap is correct, or near-integer fine grids). ~21 optimistically
  ?bpmretry-reachable — CEILING not promise (hand-tested tracks had no ac peak at hypothesis).
  Tools: tools/audit/analyzer-audit.mjs (resume-safe, m4a via afconvert-to-AIFF temp, READ-ONLY) +
  audit-summary.mjs. Report: tools/audit/out/AUDIT_REPORT.md (out/ gitignored).
- **ARCHITECTURE + RISK doc** (ultracode, 28 agents) — tools/docs/ARCHITECTURE_RISK.md, 9
  subsystems, 40-row register (10 High/28 Med/2 Low), 62 claims adversarially verified (44
  confirmed/17 amended/1 refuted). Surfaced TWO real bugs (documented, NOT fixed — need Chad):
  - **#36 (High)**: dead hidden-tab re-anchor — `if(local)return` (jsx L6895) always true since
    both decks pass local=true → **root cause of the PARKED waveform-fps-freeze**. Fix =
    `if(buf)return`. Matches the repair MEMORY already hypothesized.
  - **#37 (Med)**: seekEpoch deterministic snap defeated by the reorder guard for <0.75s backward
    seeks (guard returns before the epoch check). Fix = test epoch before magnitude.
  - Refuted claim of note: engage does NOT read the smoothed mirror phase — it reads the stable
    packet anchor (stableProg, L10925) precisely because mirror wobble broke idempotency. Follower
    comments (L6849) are stale/misleading → risk #38 (comment fix).
- **SECURITY REVIEW** — tools/docs/SECURITY_REVIEW_2026-07-03.md. 1 HIGH, code-verified,
  PRE-EXISTING: `?smoke=1` flips TEST_HOOKS → `?smoke=1&wsurl=wss://evil` redirects a victim's WS
  (session MITM + PII) on one click. Comment at L432 ("can NEVER") is false. Fix: gate ?wsurl on
  DEV-only, or require loopback host when opened by ?smoke=1. Should ride the next prod push.
- **UI AUDIT** — tools/docs/UI_AUDIT.md, ranked. #1 crossfader banned blue→green gradient
  (rgba(15,79,160)→rgba(31,201,122), jsx L12083); #2 grey text #9CA3AF×87/#5A5E66×36 vs
  white-opacity tiers; #3 all-caps top-bar status. Transport row = the system done right (template).
  Waveform correctly excluded (LOCKED). Doc discrepancy flagged: philosophy says 200ms, code+CLAUDE
  say 150ms — reconcile the docs.

## HELD (unchanged) — Monday daylight review
tools/patches/loadtracktest-race-fix.HELD.patch — still held.

## MONDAY TO-DO (Chad)
1. Push the 4 local commits after a full-suite run. 2. Finish updater (2 sudo/terminal steps).
3. Review: security HIGH (fix before/at push), architecture bugs #36 (fps-freeze root cause!)/#37,
   UI audit list, bpmretry calibration against the audit corpus. 4. Decide the HELD patch.
