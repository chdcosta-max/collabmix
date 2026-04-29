MIX//SYNC — RESUME BRIEF (Apr 28-29, 2026 — late Tuesday handoff)
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
- BPM worker source: src/bpm-worker-source.js (extracted Apr 28)
- Test harness: tools/bpm-test-harness/ (built Apr 28)
- Backend: Node.js WebSocket on Railway
  - URL: wss://collabmix-server-production.up.railway.app
  - Source: /Users/chad/Desktop/collabmix-server/server.js (separate repo)
- Frontend: React + Vite on Vercel (collabmix.vercel.app)
- Deploy: bash BUILD_AND_PUSH.command
- GitHub: github.com/chdcosta-max/collabmix
- Most recent commits: c51d78b (harness), 04f0344 (extract), 146faf8 (BPM snap)

=================================================================
APR 28 SESSION WINS (five commits)
=================================================================

1. ANALYZER PHASE SCORING — replaced kickExAt with onset-gated sub-bass
   (onK * envK over ±5 frame window). Fixes wrong-bar anchoring on tracks
   where mid-band syncopation outscored real downbeats.
   - Verified: 01 Retro now lands on the drop (was 2 beats off)

2. BPM SNAP — when detection is stable (DP-mean and autocorrelation BPM
   agree within 0.05) AND close to integer (within 0.3), snap both bpm
   and beatPeriodSec to the integer. beatPhaseFrac recomputed accordingly.
   - Verified: Starseed (was 121.2) snaps to 121, drop now aligns

3. DECK B BEAT GRID — was missing markers entirely; fixed mirror state
   wiring + added gridOffsetB/bpmNudgeB state.

4. CRASH HARDENING (three latent bugs):
   - sync.send → send inside useSync (ReferenceError on partner_joined)
   - Partner-waveform mirror gated on all three bands present
   - All localStorage wrapped in try/catch (fixes app-blank on QuotaExceededError)

5. WORKER_SRC EXTRACTED — moved to src/bpm-worker-source.js so analyzer
   logic is shared between live app and Node test harness. Pure refactor,
   byte-identical string content.

6. NODE TEST HARNESS BUILT — tools/bpm-test-harness/. Decodes audio,
   runs analyzer, compares vs ground-truth.json. 3 tracks smoke-tested
   cleanly. Commands: cd tools/bpm-test-harness && npm test.

=================================================================
NEW FINDING (FIRST PRIORITY NEXT SESSION)
=================================================================

Smoke test of harness revealed that the BPM-snap stability gate may be
TOO STRICT. Two tracks at 122.1 and 120.9 BPM (both 0.1 from integer)
did NOT snap, even though they passed the closeness check. This means
the stability gate (DP-mean vs autocorrelation agreement within 0.05)
is failing on tracks that intuitively should be integer-locked.

Hypothesis: DP beat tracker drifts more than 0.05 BPM from autocorrelation
on real tracks even when those tracks are produced at integer tempo.
The 0.05 threshold may be too tight.

To investigate: run DEBUG=1 npm test in the harness, see actual values
of bpmFromPeriod (DP-mean derived) vs bpm (autocorrelation) for these
tracks. If the disagreement is consistent at 0.1-0.2 BPM, loosen the
gate to ~0.2. Need to verify this doesn't regress the stable cases.

This is NOT urgent — analyzer is shipping fine. But it's the first
thing to look at when expanding test coverage.

=================================================================
TESTING SCOREBOARD
=================================================================

Live app verified (Apr 28): Sunday Sunrise, 01 Retro, Starseed, Atlas,
Lucida, Spektre, Tunnel, 06 Asphodel — all working with current grid.
Slight-offset (kick body vs click physics, not bug): Welcome to You,
Eternal Journey.

Harness smoke test (3 tracks): all decoded and analyzed cleanly,
all SKIP (no ground truth yet). Numbers look reasonable but unsnapped
on close-to-integer tracks (see above finding).

=================================================================
KNOWN OPEN ISSUES
=================================================================

Polish:
- Kick body vs click visual offset on some tracks (acoustic physics —
  consider future render: shift bass band display ~10ms left)
- Manual nudge UI for Deck B (state added Apr 28, no buttons wired)
- Analyzer fires twice per track load (efficiency only)
- Hot cues missing on zoomed waveform
- Hot cues no number labels
- Delete hot cue requires two-finger trackpad

Functional:
- Partner audio glitches/skips when Deck A plays (untested in detail —
  likely WebRTC artifact, not Phase 1 mixer sync)
- Partner can't see Deck B waveform on host browser when partner loaded
- Library defaults to "Recently Played" instead of "All Tracks"
- Room IDs hardcoded as "preview"
- Mock library data populates when empty

Strategic backlog:
- Manual beat-grid nudge UI (rekordbox-style override)
- Phase 2 transport sync (play/pause/cue/scrub/SYNC mirroring)
  - Server.js has no routing for seek/toggle/cue requests yet
  - Client receivers exist (toggleFnsRef, seekFnsRef, cueFnsRef); senders missing
  - Estimated 1-3 days

=================================================================
RECOMMENDED FIRST ACTIONS NEXT SESSION
=================================================================

In priority order:

1. Run DEBUG=1 npm test in tools/bpm-test-harness on existing 3 tracks
   to see why 122.1 and 120.9 didn't snap. Decide if stability gate
   needs loosening (e.g. 0.05 -> 0.15 or 0.2).

2. Build out ground-truth.json for ~15-20 tracks using rekordbox values.
   Get rekordbox BPM and DOWNBEAT (first downbeat in seconds) for each.
   This is the slow part but unblocks all measurement.

3. With ground truth in place, run npm test and see actual PASS/FAIL
   accuracy. Iterate on analyzer if needed.

4. Then: Phase 2 transport sync (server-side branches first, client senders).

If you want to skip analyzer work and ship transport sync: do server-side
branches in collabmix-server/server.js first (add routing for
seek_request, toggle_request, cue_request), then client senders.

=================================================================
WORKING RULES
=================================================================
- ALWAYS edit src/collabmix-production.jsx, not src/App.jsx
- Worker source lives in src/bpm-worker-source.js — change there if
  modifying analyzer; both app and harness will pick it up
- Test on production URL (collabmix.vercel.app), not localhost
- Investigate before editing for ambiguous tasks
- One change at a time, deploy, verify, then commit
- Tagline filter: does this make "back-to-back DJing, online" better?
- When user's domain reasoning contradicts technical framing, user is
  usually right
- Trust ear-based ground truth — when kicks audibly hit on markers, audio
  is right even if visual looks off
- For DSP investigation, ALWAYS get rekordbox/Traktor BPM as second
  source of truth before chasing precision bugs

=================================================================
INSTRUCTION FOR NEW CLAUDE
=================================================================
"Continuing work on Mix//Sync. Previous chat hit context limits.
Please confirm you understand where we left off, then help me start
with priority #1 (investigate why the BPM-snap stability gate didn't
fire on 122.1 and 120.9 BPM tracks in last night's harness smoke test)."
