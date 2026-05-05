MIX//SYNC — RESUME BRIEF (May 4, 2026 — Monday late-evening handoff)
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
- Latest commit: 0a1c23b (Slice 2 — partner transport control)

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
   - Catches negative fractions from clicking outside small WF edge,
     plus future unclamped network seek_request callers
9. File picker reload fix (commit 5a94e27)
   - Reset hidden <input type=file> .value after onChange so same
     file can be reselected. Bug was completely silent.

MAY 4 EVENING — late (three commits, Phase 2 + Slices 1+2):
10. Phase 2 transport sync — server-side (collabmix-server commit 3dde18e)
    - Three new relay branches: seek_request, toggle_request, cue_request
    - Pure forwarding; broadcastToRoom auto-filters sender, no echo logic
    - Verified live; uptime reset on /health confirmed deploy.
11. Phase 2 transport sync — client senders (collabmix commit 4fbf28f)
    - Option A pattern: each callback gets fromRemote=false param
    - Local user click broadcasts; receiver passes true to suppress echo
    - Both Deck JSX mounts pass onTransportFire={sync.send}
12. Slice 1 — Partner deck spectator view (commit 3ac9ba9)
    - Broadcast artist + key + bpm via deck_update piggyback (BPM via
      Deck-level useEffect on bpmResult; useBPM has no sync.send scope)
    - Deck-header gate widened: {(buf || remote?.trackName) ? ... : placeholder}
    - Local sub-line shows artist when known, else sampleRate/channels
    - Partner sub-line shows duration · artist
    - Key display uses effectiveKey = deckKey || remote?.key
    - BPM display uses effectiveBpm = bpmResult?.bpm ?? remote?.bpm
    - CAMELOT extended with 30+ synonyms (Cmaj/Bbmaj/Amin/Bbmin/Gbm/Gbmin/etc)
      for rekordbox/Mixed-In-Key spellings — fixed Sunday Sunrise "Gbmin" → 11A
    - New trackArtist Deck state set in load()
13. Slice 2 — Partner transport control (commit 0a1c23b)
    - toggle restructured: broadcast above !buf guard; spectator branch
      with optimistic setPlay(p=>!p) for instant UI; owner branch unchanged
    - Play/CUE button onClick wrapped in inline arrow:
        onClick={(e)=>{ if(local&&toggle) toggle(); else if(remoteToggle) remoteToggle(); }}
      The original ternary form `local?toggle:(remoteToggle||undefined)` was
      empirically failing to dispatch clicks in spectator mode despite
      evaluating correctly. Wrapper that explicitly dereferences each click
      reliably routes through. Root cause not understood — possibly
      useCallback re-binding timing vs event-listener attachment when prop
      reference changes. Workaround stable; revisit later if curious.
    - seek and cue unchanged — already broadcast above their state work
      and update local UI even when play is false.

=================================================================
ARCHITECTURE DECISIONS (May 4 late session)
=================================================================

Shared-decks model (confirmed): both DJs see the same Deck A and Deck B.
Whoever loads a track most recently OWNS it (their AudioBuffer drives
audio; partner gets the file's audio via WebRTC). Either DJ can fire
transport on either deck. Partner pressing play sends toggle_request
to the owner who actually drives the audio engine. UI state mirrors
both ways via the existing deck_update field-by-field broadcast.

Product framing (confirmed via working session): "back-to-back DJing,
online." Partner B might play 3 songs in a row before A plays again;
both DJs need control of both decks since there are only two decks
in the session.

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

Phase 2 verified end-to-end (May 4 late): two browsers in same room, all
8 transport scenarios pass — B2 click play/pause/cue/scrub on owned and
unowned decks; B1 reverse direction; local-only workflow on B1; Phase 2
DJ-driving direction preserved.

Slice 1 spectator view verified: track title, artist, BPM, key, duration
all display on partner's Deck panel after DJ loads.

=================================================================
KNOWN OPEN ISSUES
=================================================================

BLOCKER for beta:
- WebRTC audio routing — DJ's local speakers go silent when a partner
  is connected. Audio engine still runs (mixer levels animate), output
  not reaching audioContext.destination. Pre-existing; surfaced sharply
  in two-browser testing tonight. **Highest priority next session.**
  Suspect: when WebRTC transmission is wired, output gets routed only
  to the MediaStreamDestination instead of teeing to both that AND
  audioContext.destination.

Phase 2 follow-ups:
- Catch-up jitter during continuous partner playback — likely the
  mirror effect at line 2801-2838 firing on every progress update,
  re-running the RAF interpolation seed.
- Mirror effect noise — diagnostic logs showed setPlay firing 60+ times
  per second with the same value during playback. Performance opportunity:
  guard with `if (nowPlaying !== play)` before calling setPlay.
- Simultaneous-press hazard for toggle_request still open — DJs both
  pressing play within ~50ms can end up in opposite states. Fix is to
  broadcast absolute play_state {playing: true|false} instead of toggle.

Mystery (low priority):
- onClick={local?toggle:(remoteToggle||undefined)} fails in spectator
  mode despite evaluating correctly; inline arrow wrapper works reliably.
  Working workaround in place. Could investigate root cause later.

Polish:
- Kick body vs click visual offset on some tracks (acoustic physics —
  consider future render: shift bass band display ~10ms left)
- Manual nudge UI for Deck B (state added Apr 28, no buttons wired)
- Analyzer fires twice per track load (efficiency, not correctness)
- Hot cues missing on zoomed waveform
- Hot cues no number labels
- Delete hot cue requires two-finger trackpad

Functional:
- Partner can't see Deck B waveform on host browser when partner loaded
  (may be resolved by Slice 1 — needs re-test)
- Library defaults to "Recently Played" instead of "All Tracks"
- Room IDs hardcoded as "preview"
- Mock library data populates when empty
- Pre-existing fontSize duplicate-key warning at line 1613 of
  collabmix-production.jsx (build warning, non-blocking)

Strategic backlog:
- Manual beat-grid nudge UI (rekordbox-style override)
- Bulk-test analyzer with 15-20+ tracks via harness
  - Build out ground-truth.json from rekordbox values
  - Slow but high-leverage once done
- Spectator artwork (broadcast small thumbnail data URL or content hash)

=================================================================
RECOMMENDED FIRST ACTIONS NEXT SESSION
=================================================================

In priority order:

1. **WebRTC audio routing fix** (BLOCKER for dogfood/beta).
   - Investigate first: read the WebRTC pipeline (search for
     MediaStreamDestination, createMediaStreamDestination, eng.current,
     useRTC) to understand current output graph.
   - Goal: ensure each Deck's output reaches BOTH the MediaStreamDestination
     (WebRTC pipe to partner) AND audioContext.destination (local speakers).
     Likely a missing `.connect(audioContext.destination)` somewhere when
     WebRTC is wired up, or a one-time route swap that should be a tee.
   - Test plan: open two browsers, both connected to same room, load
     and play a track on Browser 1 — Browser 1 should hear it locally
     AND Browser 2 should hear it via WebRTC. Both must work.

2. **Dogfood with another DJ** once #1 is fixed. Real two-DJ session
   to surface real-world issues (latency, echo, drift).

3. Then revisit Phase 2 follow-ups (catch-up jitter, mirror effect noise,
   absolute play_state instead of toggle_request) once dogfood feedback
   is in hand.

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
  broken state while diagnosing (we did this May 4 morning with the gate
  redesign and it was the right call)
- Tagline filter: does this make "back-to-back DJing, online" better?
- When user's domain reasoning contradicts technical framing, user is
  usually right
- Trust ear-based ground truth — when kicks audibly hit on markers,
  audio is right even if visual looks off
- For DSP investigation, ALWAYS get rekordbox/Traktor BPM as second
  source of truth before chasing precision bugs
- For React event-handler bugs that defy code reading, instrument
  with console logs at the click site and the handler entry — proved
  decisive in tracking down the spectator onClick mystery.

=================================================================
INSTRUCTION FOR NEW CLAUDE
=================================================================
"Continuing work on Mix//Sync. Previous chat hit context limits.
Please confirm you understand where we left off, then help me start
with priority #1 — investigating the WebRTC audio routing issue
where DJ's local speakers go silent when a partner is connected.
The audio engine runs but output isn't reaching audioContext.destination.
Phase 2 transport sync and partner spectator view + control are all
shipped (commits 4fbf28f, 3ac9ba9, 0a1c23b). The audio routing fix
unblocks dogfood with another DJ."
