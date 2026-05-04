MIX//SYNC — RESUME BRIEF (Apr 29, 2026 — Wednesday late update)
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
- Latest commit: 7e47553 (dual-branch BPM-snap gate)

=================================================================
APR 28-29 SESSION WINS
=================================================================

APR 28 NIGHT (six commits):
1. Onset-gated phase scoring — fixes wrong-bar anchoring
2. BPM snap (initial version) — Starseed snaps to 121
3. Deck B beat grid restored
4. Crash hardening (sync.send, partner-mirror, localStorage)
5. WORKER_SRC extracted to src/bpm-worker-source.js
6. Node test harness built (tools/bpm-test-harness/)

APR 29 EVENING (one commit, gate redesign):
7. Dual-branch BPM-snap gate (commit 7e47553)
   - Replaces the original |bpmFromPeriod - bpm| < 0.05 gate
   - Branch 1 (periodIntegerLocked): |bpmFromPeriod - intBpm| < 0.05
   - Branch 2 (crossValidated): |bpm - intBpm| < 0.25 AND |bpm - bpmFromPeriod| < 0.07
   - Outer guard (withinOuterGuard): |bpm - intBpm| < 0.5
   - Verified on 5 live-app tracks + 3 harness tracks, all snap via correct branch
   - Truly drifting tracks correctly rejected by both branches
   - Diagnostic log emits all branch booleans + gate-input deltas

=================================================================
TESTING SCOREBOARD
=================================================================

Live app verified (Apr 28-29): Sunday Sunrise (snaps to 124), 01 Retro
(124), Starseed (121 via crossValidated branch), Atlas (122), Lucida,
Spektre, Tunnel, 06 Asphodel — all working with current grid.

Slight-offset (kick body vs click physics, NOT a bug — acoustic delay):
Welcome to You, Eternal Journey.

Harness (3 tracks): 01 Alive Again (snaps to 122), 03 Aliens (120),
Astronauts Nightmares (123) — all snap via periodIntegerLocked branch.

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

Functional bug spotted Apr 29:
- AudioBufferSourceNode RangeError when scrubbing/playing certain
  tracks: "The offset provided (-1.38269) is less than the minimum
  bound (0)". Pre-existing or recent — needs investigation. Stack
  trace points to main bundle, may relate to scrub/seek with negative
  position. Capture a repro before fixing.

Other functional issues:
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
  - Client receivers exist; senders missing
  - Estimated 1-3 days
- Bulk-load harness with 15-20+ tracks for accuracy testing at scale
  - Requires building out ground-truth.json from rekordbox values
  - Slow but high-leverage once done

=================================================================
RECOMMENDED FIRST ACTIONS NEXT SESSION
=================================================================

In priority order:

1. Investigate the AudioBufferSourceNode RangeError. Need a repro:
   what action triggered "offset -1.38269" — was it scrub, cue, play
   from a stopped state? Search collabmix-production.jsx for
   "AudioBufferSourceNode" and ".start(" calls; find the one that
   could pass a negative offset.

2. Build out ground-truth.json for ~15-20 tracks using rekordbox
   values. With the harness now battle-tested by tonight's gate redesign,
   this unblocks accuracy testing at scale. Get rekordbox BPM and
   DOWNBEAT (first downbeat in seconds) for tracks you actually use.

3. Run npm test on a real library sample. Look for snap behavior
   patterns: how often does each branch fire? Are there tracks
   neither branch catches that should be snapping?

4. Then: Phase 2 transport sync (server-side branches first, client senders).

If you want to skip analyzer work and ship transport sync: do server-side
branches in collabmix-server/server.js first (add routing for
seek_request, toggle_request, cue_request), then client senders.

=================================================================
WORKING RULES
=================================================================
- ALWAYS edit src/collabmix-production.jsx for app code; analyzer changes
  go in src/bpm-worker-source.js (both app and harness pick it up)
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
- Roll back fast when a fix regresses something — don't ship a broken
  state while diagnosing

=================================================================
INSTRUCTION FOR NEW CLAUDE
=================================================================
"Continuing work on Mix//Sync. Previous chat hit context limits.
Please confirm you understand where we left off, then help me start
with priority #1 (investigate the AudioBufferSourceNode RangeError
spotted in Apr 29 session)."
