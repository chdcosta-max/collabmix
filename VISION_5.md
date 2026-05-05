MIX//SYNC — RESUME BRIEF (May 4, 2026 — Monday evening handoff)
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
  - Source: /Users/chad/Desktop/collabmix-server/server.js (separate repo)
- Frontend: React + Vite on Vercel (collabmix.vercel.app)
- Deploy: bash BUILD_AND_PUSH.command
- GitHub: github.com/chdcosta-max/collabmix
- Latest commit: 5a94e27 (file picker reload fix)

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

MAY 4 EVENING (three commits):
8. AudioBufferSourceNode RangeError fix (commit e3d2d34)
   - Clamp seek() input to [0, 1] at the boundary
   - Catches negative fractions from clicking outside small WF edge,
     plus future unclamped network seek_request callers
9. File picker reload fix (commit 5a94e27)
   - Reset hidden <input type=file> .value after onChange so same
     file can be reselected. Bug was completely silent — picker
     would close and load chain dropped.
10. (this VISION update commit)

=================================================================
TESTING SCOREBOARD
=================================================================

Live app verified across sessions: Sunday Sunrise (snaps to 124),
01 Retro (124), Starseed (121 via crossValidated), Atlas (122),
Lucida, Spektre, Tunnel, 06 Asphodel — all working with current grid.

Slight-offset (kick body vs click physics, NOT a bug — acoustic delay):
Welcome to You, Eternal Journey.

Harness (3 tracks tested): 01 Alive Again (snaps to 122), 03 Aliens
(120), Astronauts Nightmares (123) — all snap via periodIntegerLocked.

Picker reload bug fix verified May 4: same-file reload works,
different-file picks work, drag-drop unaffected, library row clicks
unaffected.

Seek clamp verified May 4: clicking edges of small overview waveform
no longer triggers AudioBufferSourceNode RangeError.

=================================================================
KNOWN OPEN ISSUES
=================================================================

Polish:
- Kick body vs click visual offset on some tracks (acoustic physics —
  consider future render: shift bass band display ~10ms left)
- Manual nudge UI for Deck B (state added Apr 28, no buttons wired)
- Analyzer fires twice per track load (efficiency, not correctness)
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
- Pre-existing fontSize duplicate-key warning at line 1613 of
  collabmix-production.jsx (build warning, non-blocking)

Strategic backlog:
- Manual beat-grid nudge UI (rekordbox-style override)
- Phase 2 transport sync (play/pause/cue/scrub/SYNC mirroring)
  - Server.js has no routing for seek/toggle/cue requests yet
  - Client receivers exist; senders missing
  - Estimated 1-3 days
- Bulk-test analyzer with 15-20+ tracks via harness
  - Build out ground-truth.json from rekordbox values
  - Slow but high-leverage once done

=================================================================
RECOMMENDED FIRST ACTIONS NEXT SESSION
=================================================================

Three good options, in rough priority:

1. Phase 2 transport sync (the big one).
   - Start with server-side: add routing branches in
     /Users/chad/Desktop/collabmix-server/server.js for
     seek_request, toggle_request, cue_request. Server already has
     broadcastToRoom that filters out the sender — no echo
     suppression needed.
   - Then client-side senders. Receivers already exist
     (toggleFnsRef, seekFnsRef, cueFnsRef on the Deck refs).
   - Estimated 1-3 days total. Could ship server piece in ~30 min
     as a contained first slice.

2. Bulk-test analyzer accuracy. With the dual-branch gate now battle-
   tested, add 10-15 tracks to tools/bpm-test-harness/tracks/, build
   out ground-truth.json from rekordbox, run npm test, see what
   patterns emerge. Could surface new edge cases for the gate.

3. Investigate analyzer-fires-twice issue. Pre-existing, low
   priority, contained. Probably a useEffect dependency issue or
   double-render. Quick fix once located.

Best fresh-start option is #1 — biggest strategic value, well-scoped,
and the architecture decision (eventual consistency, no actor IDs
needed because server already filters senders) is already made.

=================================================================
WORKING RULES
=================================================================
- ALWAYS edit src/collabmix-production.jsx for app code; analyzer
  changes go in src/bpm-worker-source.js (both app and harness pick
  it up)
- Test on production URL (collabmix.vercel.app), not localhost
- Investigate before editing for ambiguous tasks
- One change at a time, deploy, verify, then commit
- Roll back fast when a fix regresses something — don't ship a
  broken state while diagnosing (we did this May 4 with the gate
  redesign and it was the right call)
- Tagline filter: does this make "back-to-back DJing, online" better?
- When user's domain reasoning contradicts technical framing, user is
  usually right
- Trust ear-based ground truth — when kicks audibly hit on markers,
  audio is right even if visual looks off
- For DSP investigation, ALWAYS get rekordbox/Traktor BPM as second
  source of truth before chasing precision bugs

=================================================================
INSTRUCTION FOR NEW CLAUDE
=================================================================
"Continuing work on Mix//Sync. Previous chat hit context limits.
Please confirm you understand where we left off, then help me start
with priority #1 (Phase 2 transport sync — server-side routing
branches first in /Users/chad/Desktop/collabmix-server/server.js
for seek_request, toggle_request, cue_request)."
