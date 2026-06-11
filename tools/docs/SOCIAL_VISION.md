# Mix//Sync Social Vision — Community, Matchmaking, and the Feed

Status: Strategy locked June 10, 2026. NOTHING here starts before
pre-dogfood essentials ship.

## Why social is the moat, not a feature
The core feature (remote B2B) requires two people. Every new user
arrives alone — a cold-start problem baked into the product.
Matchmaking converts the two-player requirement from weakness into
hook (the multiplayer-gaming solution).

Unique asset: we analyze every user's library. BPM ranges, keys,
genre profile = real taste data. "Match me with someone who plays
melodic house at 120-124" is a matchmaking signal no other platform
has. Defensible.

## Architecture

### Identity — DJ Profiles
- Name, photo, location, genres (auto-suggested from library
  analysis), bio, mix history, stats
- Secondary purpose: DJ press kit / link-in-bio portfolio.
  Profiles are valuable BEFORE the social graph exists.

### Presence
- Friends list, three states: online / in session (watchable) /
  open to B2B
- "Open to B2B" is the doorbell — invites drop-in sessions

### Spectating
- Join any open session as listener (audio streaming exists)
- Turns sessions into venues; gives non-performers a participation
  mode

### Matchmaking — "The Queue"
- Quick Match: random. Tuned Match: library-similarity
  (genre/BPM/key overlap)
- Post-session: add friend, rematch
- CRITICAL: do not ship before user liquidity exists. Empty queues
  kill the feature permanently.
- Liquidity solution: scheduled events ("Friday Night Sessions")
  concentrate sparse users into time windows.

### The Feed
- Recorded sessions post as mixes: set card (artwork, tracklist,
  both DJ names, waveform timeline of who played what)
- Plays, likes, weekly Top Mixes chart (weekly reset so new users
  can chart)
- The feed is simultaneously community AND marketing engine —
  every session produces shareable branded content

### Community structures
- Crews: small groups (4-10 DJs), genre- or friendship-based
- Relay sessions: 3-4 DJs, 15 min each, pass-the-aux — party mode
  + content generator

## Brand constraint
Quiet-pro, NOT neon gamer. chess.com community energy, not Twitch
visual chaos. All social UI inherits the locked design system
(pure black, white tiers, mono data type, sentence case).

## Marketing engine (leverage order)
1. Set cards — organic shareable content from every session
2. Melodic Inspirations channel — owned audience of exactly the
   target niche; seed community + launch distribution
3. Magic-moment clips (two cities, one mix) for short-form video
4. Niche-first seeding: melodic/progressive house before "all
   DJs." Small dense community beats large empty one.
5. Prereq: real domain before public marketing (currently
   collabmix.vercel.app)

## Build sequencing
Phase 0 (NOW, unchanged): Slice A/B/C waveform work, drag-and-drop
#9, dogfood round 2. Core trust first.
Phase 1 (parallel-safe, anytime): Landing page V1 + branding (see
LANDING_BRIEF.md). Zero critical-path code.
Phase 2: Profiles + session recording + set cards.
Phase 3: Presence, friends, spectating.
Phase 4: Matchmaking + feed + weekly charts — ONLY once liquidity
exists. Consider Discord as interim community home.
Landing V2 (live-venue homepage) ships with Phase 4, never before.

## Anti-goals
- No gamer-neon aesthetic, no engagement-bait mechanics
- No matchmaking before liquidity
- No social build before core product earns trust
