MIX//SYNC — RESUME BRIEF (May 6-7, 2026 — late Wednesday handoff)
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
- Latest commit: 7781f83 (partner playhead jitter fix)

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

MAY 6-7 EVENING (two commits, both major bugs unblocked):
14. Audio routing bug fix (commit 3268c2f)
    - Root cause: endCall() called master.disconnect(dest.current) where
      dest.current was null when WebRTC was never established. Chrome
      silently treats AudioNode.disconnect(null) as disconnect-all-outputs,
      severing master from masterAn → ctx.destination, killing local audio.
    - Server unconditionally sends rtc_hangup on every partner disconnect,
      so endCall fired on every partner refresh. Even with no STREAM clicked.
    - Fix: guard the disconnect on dest.current actually being a real
      AudioNode (`if (dest.current && engineRef.current) ...`). ~4 lines.
    - This unblocks two-browser sessions for the FIRST TIME — audio actually
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

=================================================================
ARCHITECTURE DECISIONS (May 4 + May 6-7)
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
- Both DJs see synchronized track metadata (title, artist, BPM, key, duration)
- Both DJs see same waveform shape (rendered identically on owner and partner)
- Either DJ can drive transport on either deck (play/pause/cue/scrub round-trip)
- Visual playhead on partner side stays in time with B1 within network latency
- Smooth playhead motion, no visible stutter
- Audio survives partner refresh / reconnect cycles

=================================================================
KNOWN OPEN ISSUES
=================================================================

NEW (May 6-7):
- Phantom loop on zoomed waveform clicks. Repro: while playback is active,
  click around on the zoomed waveform across both browsers a few times. At
  some point the deck enters a 1-second loop (e.g., 1:25 → 1:26). Pressing
  play/pause doesn't break it. Hot cue buttons set cues but don't break the
  loop. Workaround: hard refresh. Suspected: AnimatedZoomedWF onSeek/onClick
  inadvertently sets lr2.start, lr2.end, and lr2.active in some interaction
  sequence. Audit the onClick handler at AnimatedZoomedWF and any
  loop-setting gestures (drag-to-set-loop?).
- Initial playhead sync has subtle warm-up — catches up over first few
  seconds rather than syncing immediately. Likely the first packet's
  hard-snap baseline sets, then RAF takes over with stale rate until the
  duration-based rate stabilizes. Minor polish.
- WF_W=24000 visible quality is acceptable but a bit blocky. User noted
  "looks a little amateur." Revisit when polishing visuals; could go higher
  (32000?) now that bandwidth is no longer suspect, or keep low and use
  better rendering (smoothed bars).

CARRIED FORWARD:
- Mirror effect noise — diagnostic logs showed setPlay firing 60+ times
  per second with the same value during playback. Performance opportunity:
  guard with `if (nowPlaying !== play)` before calling setPlay.
- Simultaneous-press hazard for toggle_request — DJs both pressing play
  within ~50ms can end up in opposite states. Fix is to broadcast absolute
  play_state {playing: true|false} instead of toggle.
- Mystery: onClick={local?toggle:(remoteToggle||undefined)} ternary form
  fails for partner-mode buttons; inline arrow wrapper works. Workaround
  in place from May 4 session. Revisit if curious.
- Hot cues can't be deleted from UI (state can be cleared via right-click
  context but no obvious delete button)
- Kick body vs click visual offset on some tracks (acoustic physics)
- Manual nudge UI for Deck B (state added Apr 28, no buttons wired)
- Analyzer fires twice per track load (efficiency, not correctness)
- Hot cues missing on zoomed waveform
- Hot cues no number labels
- Library defaults to "Recently Played" instead of "All Tracks"
- Room IDs hardcoded as "preview" — no shareable invite links yet
- Mock library data populates when empty
- Pre-existing fontSize duplicate-key warning at line 1613 (build warning,
  non-blocking)

Strategic backlog:
- Manual beat-grid nudge UI (rekordbox-style override)
- Bulk-test analyzer with 15-20+ tracks via harness
  - Build out ground-truth.json from rekordbox values
- Spectator artwork (broadcast small thumbnail data URL or content hash)

RESOLVED THIS SESSION:
- ✅ WebRTC audio routing — DJ's local speakers no longer silent on
  partner connect (was the May 4 BLOCKER, fixed in commit 3268c2f)
- ✅ Catch-up jitter during continuous partner playback (was a Phase 2
  follow-up, fixed in commit 7781f83)

=================================================================
RECOMMENDED FIRST ACTIONS NEXT SESSION
=================================================================

In priority order:

1. **Dogfood with another DJ.** Now that audio works AND visual sync is
   smooth, the next biggest leverage move is real human use. 30 minutes
   of B2B with a friend will reveal more than another night of solo
   development. Test scenarios: track handoff between DJs, EQ matching
   on incoming tracks, cue points and beat-grid alignment under live
   conditions, network latency tolerance.

2. **Investigate phantom loop bug** if it bothers anyone during dogfood.
   Otherwise low priority — rare and easy to recover from.

3. **Connection flow / shareable invite links.** Rooms are hardcoded
   "preview" today. For real dogfood beyond a one-off session, partners
   need a link they can click. Something like collabmix.vercel.app/?room=abc.
   Server already supports arbitrary room IDs.

4. **Polish:** initial playhead warm-up, WF_W resolution decision, mirror
   effect setPlay dedup. None blocking.

5. **Strategic:** absolute play_state instead of toggle_request to fix
   simultaneous-press hazard (1-2 hours), or bulk-test analyzer with 15-20
   tracks (longer, builds confidence). Pick whichever feels more useful
   after dogfood feedback.

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
- For sync bugs, the BIGGEST insight from May 6-7: when both sides see
  the same playing track, derive rate from track duration, NOT from
  packet timing. Network latency is irrelevant to rate; it only affects
  when to correct the baseline. Apply this pattern to any future
  visible-position sync.
- For WebSocket disconnect logic, ALWAYS guard cleanup operations on
  whether the resource was actually established. Chrome's silent
  disconnect-all behavior on null arguments is a sharp edge.

=================================================================
INSTRUCTION FOR NEW CLAUDE
=================================================================
"Continuing work on Mix//Sync. Previous chat hit context limits.
Please confirm you understand where we left off. The May 6-7 session
unblocked two-DJ end-to-end use: audio routing bug fixed (commit
3268c2f) and partner playhead jitter fixed (commit 7781f83). Two-browser
session now works fully: audio + metadata + waveform + transport sync +
smooth playhead. Next priority is dogfooding with another DJ — real
human use will surface what to polish next. Phantom loop bug from
zoomed-waveform clicks is the only new bug, low priority."
