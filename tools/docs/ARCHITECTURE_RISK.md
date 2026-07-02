# Mix//Sync — Architecture & Risk Assessment

**Date:** July 1, 2026
**Scope:** Five subsystems — audio engine, BPM/beat-grid analyzer, sync engine, WebRTC audio transport, mirror render.
**Method:** Each subsystem was mapped from source, a risk pass was run against the map, and every architecture claim was then independently re-verified against code. Verdicts (confirmed / amended / refuted) are applied throughout: amended corrections appear in the body, and the full honesty ledger is in the appendix (Section 4). The original four-subsystem audit refuted no claims (16 of 50 verified claims required amendment); the later mirror-render pass (Section 4.4) added 12 verified claims — 10 confirmed, 1 amended, 1 refuted — for 62 total (17 amended, 1 refuted).

> **Line-number caveat.** All `file:line` references were verified at audit time against `src/collabmix-production.jsx` (12,141 lines) and `src/bpm-worker-source.js` (1,4xx lines). This codebase's own memory notes that line numbers go stale with every edit — treat them as verified-at-audit pointers, not durable anchors.

---

## 1. Executive summary

### 1.1 What the product is

Mix//Sync is a real-time collaborative DJ web application (production: collabmix.vercel.app). Two DJs in different locations each run the app in Chrome, load tracks onto two decks, and mix together: each DJ's master mix streams to the partner over WebRTC (Opus, 256 kbps stereo by default), deck state and beat grids travel over a WebSocket relay, and a sync engine beat-matches the two decks using an in-house BPM/beat-grid analyzer. The core experiential promise is "one booth, one truth": both DJs hear the combined mix beat-aligned, achieved by delaying each DJ's *local* monitoring to land with the partner's network-delayed stream — never delaying what is sent or recorded. Solo mixing is a first-class use case, not a degraded mode.

The client is essentially one file: `src/collabmix-production.jsx`. The signaling/relay server (Railway) is **not in this repo**. The founder is a non-developer; all maintenance is performed through AI coding sessions with documented handoffs.

### 1.2 Architecture at a glance

```
LOCAL DJ (Chrome)
┌──────────────────────────────────────────────────────────────────────┐
│  Deck A ─┐   per-deck chain: trim → EQ(hi/mid/lo) → DJ filter        │
│          ├──────────────→ vol → crossfader(equal-power) ──┐          │
│  Deck B ─┘                                                │          │
│                                                      MASTER BUS      │
│  Analyzer (Web Worker: BPM, beat grid,                │   │   │      │
│  bar-1 anchor) ── beatTimes ──→ sync engine,          │   │   └─→ recorder tap
│                   seek-quantize, waveform grid        │   └─→ WebRTC send tap
│                                                       ▼   (both PRE-delay)
│                                        analyser → monitorDelay ─→ speakers
│                                        (delay-comp: measured partner
│                                         jitter+playout, capped 400 ms)
└──────────────────────────────────────────────────────────────────────┘
        │                                        ▲
        │ WebSocket relay (Railway — server      │ RTCPeerConnection
        │ source NOT in this repo):              │ one Opus track each way
        │  · deck_update (10 Hz progress,        │ (STUN + TURN; receiver
        │    grids, waveforms, sync state)       │  jitterBufferTarget 220 ms)
        │  · toggle/seek/cue requests            │
        │  · rtc_* signaling, sync_ping/pong     │
        ▼                                        ▼
PARTNER DJ (Chrome) — mirror render: partner decks are drawn from the
10 Hz progress stream via a forward-only smoothing follower (seekEpoch
snaps, send-time anchoring); partner-driven decks are locally muted so
the only audible copy is the WebRTC stream.
```

### 1.3 The five biggest risks

1. **Delay-comp cap saturation under real network jitter (High/High — audio engine + WebRTC).** The "one booth, one truth" promise audibly fails when a partner's jitter buffer exceeds the 400 ms compensation cap: comp measures ~650 ms but applies 400, leaving a ~250 ms audible flam. Measured repeatedly in dogfood (Jake) and in a deterministic local harness; every shipped audio lever (bitrate, ptime, NACK) was null against exogenous jitter. No shipped fix for the environmental-jitter case.
2. **One 12,141-line file carries the whole product (High/High — all subsystems).** Audio engine, WebRTC, sync, analyzer consumers, and UI live in a single JSX file with ~30 URL flags keeping legacy branches alive and keep-in-sync math copies that have already drifted (a stale pointer in the very comment meant to prevent drift). Bus factor is effectively the session-handoff docs.
3. **Pause math ignores playbackRate (High/Medium — audio engine).** The pause path adds elapsed wall-time without multiplying by rate — the only rate-blind position path in the engine. A sync-locked deck held at, e.g., rate 1.03 for 2 minutes freezes ~3.6 s off, broadcasts the wrong position, and resumes from it. One-line fix, but it corrupts positions the partner mirror consumes.
4. **Sync master election can split-brain (High/Medium — sync engine).** First-to-play master election uses local packet-arrival timestamps for the partner deck; two decks started within one-way latency (~100–300 ms real-world) can elect opposite masters on each client, each freezing a different session tempo. Sync state is last-write-wins with no versioning; rejoin replay can resurrect stale state.
5. **Manual grid edit creates a split-brain grid (High/Medium — analyzer).** After a user corrects a wrong grid (the exact workflow the analyzer's measured 19.1% failure tail requires), the drawn grid follows the edit but seek-quantize and sync engage still consume the stale analyzer `beatTimes` — the mix looks right and audibly aligns wrong.

A security cluster sits just below these: `?smoke=1&wsurl=` in a crafted production link redirects the WebSocket to an attacker relay (High severity, Low likelihood), TURN credentials are extractable from the public bundle, and rooms are joinable with ~130k guessable unauthenticated codes.

---

## 2. Subsystems

## 2.1 Audio engine

### Summary

The audio engine is a single Web Audio graph created once at app start (`createEngine`). It builds one AudioContext, a master gain bus (0.85 default), and two identical per-deck channel strips: trim → high-shelf EQ (8 kHz) → peaking mid (1.2 kHz) → low-shelf (200 Hz) → sweepable DJ filter (allpass at rest) → channel volume → crossfader gain → master. The crossfader is equal-power (cos/sin law). The master feeds an analyser (used for output-silence detection) and then a DelayNode ("monitorDelay") before the speakers. Critically, the WebRTC partner-send tap and the recorder tap both connect from the master node **upstream** of that delay — so delay compensation only affects what the local DJ hears, never what is sent or recorded.

Delay compensation ("one booth, one truth") delays local monitoring to land with the partner's jitter-buffered stream: a 1-second poll reads the measured inbound delay (jitter buffer + playout, from WebRTC getStats), clamps it to a cap (default 400 ms, `?compcap` up to 950; the DelayNode maxes at 1.0 s), and eases monitorDelay toward it slowly so it never clicks. When inbound frames stop, it holds rather than slewing to zero. The visual grid reads the same live AudioParam so audio and visuals cannot drift apart.

Playback uses fire-once AudioBufferSourceNodes, so every seek creates a new source; audible skips are hidden by a 12 ms equal-power crossfade between old and new sources (each source gets its own gain node). Play-start needs no fade — there is no old source to fade from — and sync-engage phase-align micro-seeks pass `hardSwap=true` to skip the fade deliberately (amended: plain play-start does *not* use hardSwap; the fade is skipped simply because `doXfade` requires an existing old source). A module-level `_LIVE_SOURCES` set tracks every created source for leak detection. Playhead math is `off.current + elapsed × rate`, where both decks read one shared per-frame snapshot of context time (`acNowRef`) so they can't oscillate relative to each other; rate changes rebase the bookkeeping using the previous rate. Sync corrections use `nudgeRate` — a click-free triangle playbackRate ramp capped at ±15% and ±50 ms. A driver model gates everything: only the deck's driver mutates audio, and partner-driven decks are muted locally at trim (their real audio arrives via WebRTC).

### Key files

- `src/collabmix-production.jsx` L100–217 — flag block: DELAY_COMP, GRID_ALIGN, WF_GRID_COUPLE, JB_TARGET_MS (220), COMP_CAP_MS (400)
- `src/collabmix-production.jsx` L260–277 — seek-crossfade curves (WF_SEEK_XFADE_MS=12, 33-point sin/cos) + `_LIVE_SOURCES` set
- `src/collabmix-production.jsx` L549–574 — `createEngine` (graph topology) + `xg()` equal-power crossfader law
- `src/collabmix-production.jsx` L3580–3615 — recorder tap on `eng.master` (upstream of monitorDelay)
- `src/collabmix-production.jsx` L4020–4230 — useRTC compRef measurement (jbMs+playoutMs from getStats) feeding delay-comp
- `src/collabmix-production.jsx` L4342–4345 — WebRTC capture tap: `eng.master.connect(MediaStreamDestination)`, upstream of monitorDelay
- `src/collabmix-production.jsx` L6433–7470 — Deck component: transport (play/toggle/seek/cue), nudgeRate, load, rate rebase effect, EQ prop writes
- `src/collabmix-production.jsx` L9650–9674 — `acNowRef` shared per-frame AudioContext-time snapshot (parent RAF)
- `src/collabmix-production.jsx` L9878–9903 — driver trim gate (mute partner-driven decks locally)
- `src/collabmix-production.jsx` L9902–9929 — output-truth silence monitor on masterAn
- `src/collabmix-production.jsx` L10145–10172 — applyXF (crossfader) + applyFilter (DJ filter sweep) + master volume
- `src/collabmix-production.jsx` L10420–10523 — delay-comp 1 s interval: clamp, slew, grid-align gate, [SYNC-COMP] telemetry
- `tools/docs/MASTER_INDEX.md` — doc map; `VISION_5.md` — session-end sections (delay-comp promotion June 11; compcap/timing diagnosis July 1)

### Data flows

**In**
- Decoded AudioBuffers — `Deck.load()` decodes dropped files / library tracks via `ac.decodeAudioData`; buffers feed AudioBufferSourceNodes.
- Mixer UI state — EQ/vol props written straight to chain node gains; crossfader value → applyXF; master volume; filter knob → applyFilter.
- playbackRate — from pitch controls and the sync engine; applied to the live source via 5 ms linearRamp and per-nudge triangle ramps (nudgeRate).
- Remote transport — non-driver clicks emit toggle/seek/cue requests over the wire; the driver executes them as if local.
- Delay measurement — useRTC getStats poll computes compMs = jitter-buffer + playout delay of the partner's inbound audio into `rtc.compRef`, consumed by the 1 s comp interval.
- deckDrivers — drives the trim gate (mute locally when partner drives).

**Out**
- Local speakers — deck chains → master → masterAn → monitorDelay → destination.
- Partner send — `eng.master` → MediaStreamAudioDestination → WebRTC track (pre-delay).
- Recording — `eng.master` → MediaStreamDestination → MediaRecorder (pre-delay).
- 60 Hz position — `tick()` writes progRef + onProgUpdate each frame for the waveform; React prog state throttled to ~10 Hz.
- 10 Hz progress broadcast — `broadcastProgress()` computes position from `ac.currentTime` → WS deck_update to the partner; driven by RAF and a background-immune Worker heartbeat.
- Telemetry — syncStatsRef comp fields for the HUD, [SYNC-COMP]/[GRID-ALIGN-DIAG] console lines, masterAn-based outputSilent flag.

### Invariants

1. Send and record taps are upstream of monitorDelay: delay compensation only delays what the local DJ hears, never what the partner or the recorder receives.
2. Applied monitor delay is always clamped 0..COMP_CAP_MS (default 400 ms, flag-capped at 950) and only ever moved by `setTargetAtTime` (TC 1.5 s steady / 0.3 s settling) — never a step, so it never clicks.
3. When there are no inbound frames (partner silent), the last applied delay is HELD, never slewed toward a meaningless 0.
4. Every AudioBufferSourceNode created is registered in `_LIVE_SOURCES` and removed on every retirement path (onended, hard-swap, stop, fade-tail cleanup); add/delete are idempotent so double-cleanup can't corrupt the count.
5. A retiring source's `onended` is nulled BEFORE `stop()` so the swap can never fire a false track-end.
6. Position truth is `off.current + (now − st.current) × rate`; every rate change rebases off/st using the OLD rate so the pre-change wall-time segment is never retroactively re-rated.
7. Both decks read one shared per-frame time snapshot (`acNowRef`) so their relative positions can't oscillate from sub-frame `ac.currentTime` read offsets.
8. The progress BROADCAST reads `ac.currentTime` directly (not `acNowRef`, which freezes in a backgrounded tab) so the partner never receives a stale anchor.
9. Driver model: only the driver mutates audio state and broadcasts; a non-driver interaction only emits a request; partner-driven decks are trim-muted locally over ~20 ms.
10. `nudgeRate` never destroys the source (no click): playbackRate triangle ramp, offset clamped to ±50 ms, rate excursion capped at ±15% (duration extends instead), bookkeeping applied only if the source is unchanged at ramp end.
11. Seek input is clamped to [0,1] before use — negative offsets would crash the next `play_()`.
12. Pressing play with the head parked at/past track end wraps to 0 instead of starting a 0-sample source.

### Flags

| Flag | Default | Effect |
|---|---|---|
| `?delaycomp` | ON | =0 kills local-monitor delay compensation. Promoted default-on June 11, 2026 after a 30-min soak. |
| `?compcap=<ms>` | 400 | Delay-comp ceiling; accepted 0–950 (DelayNode hard max is 1.0 s). |
| `?jbtarget=<ms>` | 220 | Partner-receiver jitterBufferTarget pin; 0 = browser default, max 4000; upstream of what delay-comp measures. |
| `?gridalign` | ON | =0 stops shifting visuals back by the comp delay (visual-only; requires delaycomp on). |
| `?gridcouple` | 1 (coupled) | Waveform reads the LIVE monitorDelay.delayTime each frame; =0 legacy separately-slewed copy. |
| `?seekXfade=<ms>` | 12 | Smooth-seek crossfade length; 0 = hard swap. |
| `?monitor=on` | guard active | Bypass the self-echo guard so partner audio is never auto-muted. |
| `?progthrottle` | ON | React prog state committed at ~10 Hz (refs stay 60 Hz); =0 legacy 60 Hz state. |
| `?syncprecision` / `?synctempo` | ON | Control the rate the sync engine writes into the engine's sources (full-precision tempo, sticky session tempo). |
| `?smoke=1` | OFF | Enables test hooks incl. `window.__liveSourceCount()` and `window.__setRateDeck`. |

---

## 2.2 BPM / beat-grid analyzer

### Summary

Mix//Sync's BPM/beat-grid analyzer is a single self-contained Web Worker whose source lives as a template string in `src/bpm-worker-source.js` (~1,400 lines), kept DOM-free so the exact same code runs in the browser and in a Node test harness with 272 tracks of Rekordbox ground truth. Per track it: (1) estimates tempo by autocorrelating a ~200 Hz onset envelope of 100–400 Hz bandpassed audio, with parabolic interpolation and octave-folding into 100–175 BPM; (2) finds every beat with an Ellis-style dynamic-programming tracker, then refines each beat to sample accuracy inside a ±50 ms window (with an optional walk-back to the kick's leading edge — the `?onsetgrid` feature, default on); (3) computes the mean beat period across all refined beats and snaps to integer BPM only under strict cross-validation gates; (4) places the bar-1 anchor by walking back from the first detected beat to just after time 0 (Rekordbox's convention — chosen after it matched truth ~95% vs 28% for the "musical downbeat" approach, which is still computed but diagnostic-only); and (5) applies four guarded post-fixes (sampler snap-to-0, drop-detection shift, no-kick-beat0 shift, late-cluster walk-back), each with its own `[BPM-*]` log tag.

Accuracy plateaued at 80.9% on the harness and work was deliberately paused; the product's answer for the rest is grid-source precedence: analyzer → imported Rekordbox grid (from master.db PQTZ or rekordbox.xml via `src/rekordbox-grid.js`) → user manual edit, merged in one place (`effectiveBpmResults`). The refined `beatTimes` array is the source of truth for seek quantize and sync engage phase-alignment (`?beatsv2`, default on) and is broadcast once per analysis to the partner as the fallback grid (and re-fired for partner rejoins — see amendments). Note (amended): under default flags the zoomed-waveform grid *lines* render a uniform snapped grid (anchor + n×period, `?griduniform` ON), not the refined kick positions — only seek-quantize and engage consume the refined kicks.

The app dispatches to the worker by copying each channel (`getChannelData().slice()`) and then transferring the copies' buffers — the transfer avoids the structured-clone copy, not all copying (the slice is required so the AudioBuffer isn't detached from playback; amended from "transfers, not copies").

Notable code-hygiene findings: a dead `dphase()` function, a 35 ms-comment vs 45 ms-code mismatch in the onset walk-back cap, and heavy dormant DSP (chroma/SSM) computed per track but unused for the shipped anchor.

### Key files

- `src/bpm-worker-source.js` (entire analyzer): helpers bp/pk/rv; `dphase` (DEAD CODE — never called); onmessage — BPM autocorrelation + parabolic interp; DP beat tracker; kick/punch/sub-bass band envelopes; per-beat sample-level refinement incl. onset walk-back (`?onsetgrid`) and legacy sub-cause A/B; bar-phase scoring kick/bass/chroma/SSM; decision tree; mean-period + integer BPM snap; walk-back bar-1 anchor; sampler snap; drop-detection shift; no-kick-beat0 shift; late-cluster walk-back; output assembly. (Worker line numbers in the audit drifted +13 from an inserted `?bpmretry` block.)
- `src/collabmix-production.jsx`: URL flag capture + ONSET_GRID/BEATS_V2/WF_GRID_UNIFORM (~L39–77); USE_RB_GRID (~L465); createBPMWorker/useBPM/analysis dispatch (~L603–646); seek quantize (~L7088–7143); auto-position + phase broadcast (~L7289–7312); small-WF kick markers; zoomed-WF de-smear + grid markers; shared beat helpers nearestBeatTime/refinedBeatPhase (~L9183–9224); effectiveBpmResults merge (~L9556–9587); rekordbox/user grid overrides (~L9796–9864); smoke hooks `__deckGrid`/`__deckPhaseFrac`; sync engage precision rate + refined phase-align (~L10868–11022); analyzer partner broadcast (~L11572–11602)
- `src/rekordbox-grid.js` (exactly 35 lines): `beatTimesFromAnchors` — piecewise beatTimes from rekordbox.xml TEMPO anchors
- `src/rekordbox-anlz.js` + `src/rekordbox-library.js`: PQTZ beat-grid source for the live master.db path
- `tools/bpm-test-harness/` (analyze.mjs, ground-truth.json, 272-track Rekordbox truth) and `tools/sota-eval/` (the evidence base for sub-causes A–G)
- `tools/docs/DROP_DETECTION_INVESTIGATION.md` and `VISION_5.md` (~L1735–1840: 28%→80.9% trajectory, pause decision, Rekordbox pivot)

### Data flows

- IN: decoded AudioBuffer (per-channel Float32Arrays, **copied then transferred**) + sampleRate + deck id + onsetAnchor boolean → worker via postMessage; dispatched from track load with `skipOnsetAnchor` when the track carries an imported Rekordbox grid.
- OUT (worker→app): `{ id, bpm, confidence, candidates[5], beatPhaseFrac (unwrapped beat index), beatPeriodSec, beatPhaseSec, firstBar1AnchorSec, snapped, phase (diagnostics, ignored), beatTimes, beatAttacks }` → useBPM results state.
- MERGE: bpmRaw.results → effectiveBpmResults (analyzer → Rekordbox override → user manual edit) → consumed everywhere as `bpm.results.A/.B`; Rekordbox overrides arrive from `rkLib.getBeatGrid` (master.db PQTZ) or imported rekordbox.xml records via `beatTimesFromAnchors`.
- OUT (consumers): (1) seek smart-quantize to nearestBeatTime while playing; (2) SYNC engage — precision rate from beatPeriodSec ratio + refined-beat phase-align via fixed-point iteration; (3) auto-position playhead to firstBar1AnchorSec on load; (4) small-WF kick markers; zoomed-WF grid lines (uniform grid by default) + de-smear.
- OUT (network): once per analysis, driver broadcasts beatTimes/beatAttacks + four scalar grid fields + bpm as deck_update fields ([ANALYZER-BROADCAST]); partner lands them in pA/pB as the fallback grid; **re-fired for rejoiners/late-joiners** via broadcastAnalyzerRef.
- OUT (telemetry): [ONSET-GRID], [REFINE-STATS], [phase], [BPM-PERIOD], [BPM-SNAP], [BPM-SAMPLER], [BPM-DROPSHIFT], [BPM-NOKICK-BEAT0], [BPM-WALKBACK] (worker); [BPM result]/[SEEK-QUANTIZE]/[ANALYZER-BROADCAST]/[REKORDBOX-A/B] (app); smoke hooks expose the effective grid.
- PARALLEL consumer: `tools/bpm-test-harness/analyze.mjs` evaluates the same WORKER_SRC in Node (via `new Function`) against 272-track ground truth; `tools/sota-eval/` holds the fix-by-fix diagnostics.

### Invariants

1. `bpm-worker-source.js` stays pure JS — no DOM, no AudioContext — so the identical analyzer runs in the production Web Worker AND in Node for the harness.
2. Every frames↔seconds conversion uses the ACTUAL frame rate `ar = sr/hop`, never the nominal 200 Hz — otherwise beatPeriodSec accumulates ~0.23% error/beat and the grid drifts ~1 s over a 5-minute track.
3. `beatPhaseFrac` is the UNWRAPPED beat index (anchor/period); `firstBar1AnchorSec = beatPhaseFrac × beatPeriodSec` exactly; consumers must never treat beatPhaseFrac as a [0,1) fraction.
4. `beatTimes[]` is sorted ascending — the refinement's monotonic guard plus DP ordering guarantee it; the binary-search helpers depend on it.
5. The walk-back bar-1 anchor lands in [0, beatPeriodSec) BEFORE post-fixes; post-fixes only move it by whole beats forward / to 0 / ≤~50 ms earlier with a ≥20 ms floor, each mutually guarded.
6. URL flags are captured ONCE at module load into URL_FLAGS because `history.replaceState` strips the query string after join — reading `window.location.search` later silently loses `?onsetgrid`/`?beatsv2` (this failure already happened once).
7. `nearestBeatTime` + `refinedBeatPhase` are duplicated verbatim in **`tools/smoke/tests/engage.smoke.mjs`** (the in-code comment still points at a nonexistent `engage_align.smoke.mjs` — stale); changes must be mirrored or the smoke asserts different math.
8. Only the deck DRIVER broadcasts analyzer results — once per analysis (dedupe on beatTimes reference identity), **plus a deliberate re-fire when a partner (re)joins**; receivers never re-broadcast.
9. Rekordbox grid, when present, is authoritative: the analyzer still runs (its beatAttacks feed the broadcast) but onset re-anchoring is skipped at dispatch and de-smear is off.
10. Sync engage rate is clamped to ±12% of unity regardless of grid source; engage's phase-align seeks pass noQuantize=true so seek-quantize never re-snaps them.
11. Waveform RENDERING never depends on grid source — all tracks render through the local analyzer's 3-band output so Rekordbox and analyzer tracks look identical.

### Flags

| Flag | Default | Effect |
|---|---|---|
| `?onsetgrid` | ON | =0 kill-switch. Gates the worker's per-beat onset re-anchor walk-back (ONSET_FRAC=0.15) and the waveform de-smear. Promoted June 11, 2026. |
| `?beatsv2` | ON | =0 kill-switch. Gates refined beatTimes for engage phase-align, zoomed-WF grid markers, `__deckPhaseFrac`; off = linear phase reconstruction. |
| `?griduniform` | ON | ON = grid LINES at uniform anchor + n×period; =0 lines at raw refined beatTimes. Grid lines only — seek/engage always use refined kicks. |
| `?syncprecision` | ON | =0 legacy: sync rate from rounded display BPM instead of full-precision beatPeriodSec ratio. |
| `USE_RB_GRID` | `true` (compile-time const, NOT a URL flag) | Rekordbox grid overrides analyzer when a match exists. No runtime kill-switch (see risk register). |
| `?gridsnap` | DOES NOT EXIST | Prototyped seek-snap-to-uniform-grid, PULLED before ship (remote-seek feedback loop); post-mortem note in source. |
| `USE_LEGACY_FRAME_SNAP` | `false` (worker-internal const) | Reverts sample-level refinement to legacy frame-resolution kick snap. |

---

## 2.3 Sync engine

### Summary

Mix//Sync's sync engine keeps two DJs' decks beat-matched across the internet using a WebSocket relay (an external Railway server; only the client is in this repo). The `useSync` hook manages the socket: it joins a room, captures a server-assigned identity (djId), stamps outbound messages with a send-time (`t_send`), and auto-reconnects with exponential backoff for up to 30 seconds after a drop. (Amended precision: t_send is injected by useSync's `send()` helper — the initial join handshake bypasses it, and the reconnect `sync_request` adds it manually.)

All deck state travels as small per-field `deck_update` messages. A "driver" model decides who may send: whoever loads a track onto a deck becomes its driver, and only the driver broadcasts audio-truth fields — play state, playhead progress (10 packets/sec off the audio clock), rate, and analyzer data. Mixer knobs are shared and exempt. (Amended precision: the djId driver gate covers the `dh()` deck-field path; sync-metadata broadcasts — rate-from-engage, masterDeck, syncLocked/syncArmed — are sent outside `dh()` and bypass that gate.) A non-driver pressing play/seek/cue sends a request; the driver executes it and the resulting broadcast syncs everyone. Incoming packets are batched to one React update per frame so network bursts can't starve rendering.

Sync engage is a mode: pressing SYNC arms it, and `attemptLock` promotes armed to locked the moment both decks have a usable BPM and one is playing. The master is the explicit M-button choice, else the first deck to play, frozen for the lock's duration. The session tempo is captured once from the master's full-precision natural beat period; `syncDecks` then rates the slave (clamped to ±12%) and phase-aligns it by at most half a beat using the refined beat grid, iterating to a fixed point so repeated engages land identically (a legacy cross-correlation refinement path survives behind `?beatsv2=0`). Releasing sync preserves rates, matching CDJ convention.

Cross-machine timing is measured, not corrected: a Cristian's-algorithm estimator (`src/utils/clockSync.js`) pings the partner every 3 s to learn the clock offset, and a monitor logs [SYNC-DRIFT] phase error while locked — deliberately observation-only in this phase. Defaults favor the new behavior; `?syncprecision=0`, `?synctempo=0`, and `?beatsv2=0` provide legacy A/B fallbacks. The tools/smoke suite gates engage accuracy and idempotency (30 ms bound) before every push.

### Key files

- `src/collabmix-production.jsx` L3622–3773 — useSync WebSocket client (connect/join, t_send injection, djId capture, backoff reconnect, sleep/wake re-dial)
- `src/collabmix-production.jsx` L6911–6956 — driver progress broadcast (10 Hz cap, audio-clock, RAF + Worker heartbeat)
- `src/collabmix-production.jsx` L7032–7155 — Deck transport: toggle/seek/cue driver gates, request emission, seek quantize + seekEpoch
- `src/collabmix-production.jsx` L9183–9224 — nearestBeatTime + refinedBeatPhase (engage math, duplicated in smoke)
- `src/collabmix-production.jsx` L9221–9280 — Path C xcorr helpers (kick envelope, downsample, crossCorrelate)
- `src/collabmix-production.jsx` L9440–9520 — sync state refs (sessionTempo/sessionPeriod/lockedMaster, clockSyncRef, syncStatsRef)
- `src/collabmix-production.jsx` L9860–9935 — driver model state, trim-gate muting, output-truth monitor
- `src/collabmix-production.jsx` L10175–10400 — handleWS: coalesced deck_update ingest, sync-state mirrors, ping/pong, request execution, rejoin replay
- `src/collabmix-production.jsx` L10607–10750 — sync_ping 3 s sampler; [SYNC-DRIFT] phase-error monitor
- `src/collabmix-production.jsx` L10817–11147 — syncDecks (precision rate, refined/linear phase align, Path C xcorr, engage-quality telemetry)
- `src/collabmix-production.jsx` L11149–11358 — attemptLock, handleSyncToggle, handlePitchInteract, handleMasterToggle, scrub-resync
- `src/collabmix-production.jsx` L11368–11469 — arm re-evaluation, session-tempo capture/release, mid-lock master swap
- `src/collabmix-production.jsx` L11490–11597 — SHARED_FIELDS + dh driver-gated broadcast, analyzer payload broadcast/replay
- `src/utils/clockSync.js` — Cristian's-algorithm clock offset estimator
- `tools/smoke/README.md` — regression gates (e2e-sync engage/idempotency, engage math unit tests)

### Data flows

- IN (WS, from relay `wss://collabmix-server-production.up.railway.app` — server code NOT in repo): `joined` (djId, partnerState snapshot, deckDrivers), `partner_joined`/`partner_left`, `deck_update` (per-field partner state incl. 10 Hz progress with t_send), `deck_driver_change`, `seek/toggle/cue_request`, `sync_ping`/`sync_pong`, `sync_request`/`sync_response` (full state snapshot), `xfade_update`, `master_vol_update`, `pong`, `error`, plus `rtc_*` signaling forwarded to the RTC hook.
- IN (local): analyzer results from useBPM (bpm, beatPeriodSec, refined beatTimes) feeding rate/phase math; live deck truth via progRefA/B, rateA/B; decoded AudioBuffers for Path C cross-correlation.
- OUT (WS): per-field deck_update broadcasts — progress (10 Hz, audio-clock), playing, rate, seekEpoch, track metadata, analyzer payload, sync state mirrors (syncLocked/syncArmed/masterDeck), shared mixer fields; deck_driver_change on every track load; sync_ping every 3 s; sync_response state replay for (re)joiners; toggle/seek/cue requests from non-driver decks.
- OUT (local side effects): setRate applied to Deck audio via a DOM `[data-set-rate]._setRate` hook; phase-align seeks via seekFnsRef; trim-gain mute (~20 ms) of partner-driven decks; `rtc.markTransportEvent()` re-baselines delay-comp on play/pause/seek.
- OUT (observability): [SYNC-DRIFT] samples + telemetry; [SYNC-ENGAGE-QUALITY] per-engage stats (rateDelta, phaseSeekMs, xcorr outcome, duration); [SEEK-SEND]/[SEEK-RECV]/[TRANSPORT-RECV]/[DRIVER-SEND]/[DRIVER-RECV] log families; syncStatsRef drives the debug HUD without re-renders.

### Invariants

1. Driver-only writes on the deck-field path: any `dh()`-routed deck_update field describing WHAT is playing or WHERE the playhead is (playing, progress, rate, track/analyzer fields) is only broadcast by the deck's driver, gated by server-assigned djId — never display name. Mixer fields (eqHi/eqMid/eqLo/vol/filter/masterVol) are exempt. **(Amended: sync-metadata broadcasts — engage rate, masterDeck, syncLocked/syncArmed — are sent outside `dh()` and bypass this gate.)**
2. Non-drivers never mutate audio: a non-driver transport click becomes a one-way request to the driver; a fromRemote call landing on a non-driver deck is dropped.
3. The drift monitor observes, never corrects — a deliberate Phase 1 boundary.
4. All sync rate changes are clamped to ±12% of 1.0; out-of-window engages abort with `safety_clamp` rather than partially applying.
5. Phase alignment moves ONLY the slave, by at most ±0.5 beat (wrap-bounded); the master is never seeked by attemptLock or engage.
6. attemptLock never issues a cross-client seek: it aligns only decks this client drives (a driverless deck counts as locally driven); the partner-driven slave's owner re-aligns locally when the syncLocked mirror arrives.
7. Session tempo is captured once at first engage from the master's NATURAL (rate-independent) beat period and stays sticky until full release, which clears ALL sticky state.
8. Unsync/release preserves rates (CDJ convention) — no snap-back on release or pitch-nudge disengage.
9. syncLocked supersedes syncArmed, and both are mirrored to the partner so both browsers show the same button state.
10. Repeat sync engage is idempotent: stable-anchor reads + fixed-point refined alignment + noQuantize seeks mean re-pressing SYNC doesn't wander (gated by e2e-sync at a 30 ms bound).
11. Every payload routed through useSync's `send()` helper carries t_send **(the join handshake does not)**; clock offset is only trusted at ≥3 samples with top-quartile RTT outliers rejected.
12. Engage math is duplicated verbatim in `tools/smoke/tests/engage.smoke.mjs` and must be kept in sync manually (the in-code pointer to `engage_align.smoke.mjs` is stale).

### Flags

| Flag | Default | Effect |
|---|---|---|
| `?syncprecision` | ON | =0 reverts sync rate to the legacy rounded-BPM ratio. |
| `?synctempo` | ON | =0 reverts sticky natural-period session tempo / frozen master / clean release to legacy behavior. |
| `?beatsv2` | ON | =0 falls back to linear single-period phase align + Path C cross-correlation engage. |
| `?mirrortsend` | ON | Mirror follower anchors coast on packet t_send instead of arrival time. |
| `?delaycomp` | ON | Local-monitor delay compensation (the drift the monitor measures assumes comp is aligning heard audio). |
| `?compcap=<ms>` | 400 | Delay-comp ceiling (max 950). |
| `?jbtarget=<ms>` | 220 | Partner-inbound jitterBufferTarget. |
| `?gridcouple` | ON | Couples visual playhead shift to the live audio monitorDelay; never touches progRef truth. |
| `?progthrottle` | ON | Caps React prog STATE at 10 Hz; the 60 Hz ref pipe (sync truth) untouched. |
| `?wsurl=<url>` | — | WS server override, honored only when TEST_HOOKS is on (dev or `?smoke=1`); `?smoke=1` also exposes `__syncDeck`/`__seekDeck`/`__toggleDeck` hooks. See risk register for the production-link hazard. |

---

## 2.4 WebRTC audio transport

### Summary

Mix//Sync's webrtc-audio subsystem carries each DJ's master mix to the partner over a single RTCPeerConnection and keeps the two ears aligned. The local Web Audio master mix is captured (tagged contentHint="music") and sent as one Opus audio track; the remote track plays through a hidden DOM `<audio>` element. Signaling (offer/answer/ICE/hangup) rides the existing WebSocket relay. ICE uses two Google STUN servers plus optional TURN servers injected at build time from VITE_TURN_* env vars; `?ice=relay` forces relay-only to prove TURN works.

Audio quality is negotiated by string-munging the SDP (`mungeOpusHiFi`): the default is 256 kbps stereo full-band Opus with in-band FEC. Three experimental levers are URL-flag gated: `?audiolite` lowers bitrate (bare = stereo 128k), `?audionack` injects NACK retransmission into both offer and answer, `?ptime` enlarges Opus frames to cut packet rate (enforced via `RTCRtpSender.setParameters`, not SDP). A one-sided flag propagates: the answerer mirrors the initiator's profile and advertises the minimum bitrate, and the initiator re-applies the negotiated profile after the answer, so either peer's flag reduces both send directions.

On the receive side, `jitterBufferTarget` is pinned to 220 ms (`?jbtarget`) on the partner receiver only. A 700 ms getStats poll measures the real receive delay (jitter buffer + playout) with heavy distrust logic: 4 consecutive healthy windows before trusting a value (7 if it dropped >50%), discontinuity re-baselining on transport events, and hold-on-silence. (Amended precision: the `noFrames` flag is set when the inbound report is *absent* or has never emitted frames / no live receiver exists; a stream that flowed and then stalls hits a separate not-flowing re-baseline branch with `noFrames:false` — both paths hold the last good value rather than writing 0.) The app then delays the DJ's own local monitor by the measured amount (delay-comp, default on, clamped to 400 ms, `?compcap` raisable to 950) so both decks hit the ear together.

The same poll feeds rich console diagnostics ([JITTER-DIAG], [SEND-DIAG], [OPUS-SDP], [ICE-PATH], [SYNC-COMP]) and an optional warn-only connection-quality classifier (`src/conn-quality.js`, `?connwarn=1`, amber dot on the partner deck). A BroadcastChannel-based self-echo guard mutes partner audio on later same-device tabs. Reconnect is initiator-elected (lexicographically smaller DJ name), budgeted at 3 attempts, triggered by ICE failure (immediate) or 6 s of "disconnected", and resets on success.

### Key files

- `src/collabmix-production.jsx` L100–182 — flag block: `?delaycomp`, `?gridalign`, `?gridcouple`, `?connwarn`, `?jbtarget` (JB_TARGET_MS), `?compcap` (COMP_CAP_MS)
- `src/collabmix-production.jsx` L504–546 — ICE/TURN config (_ICE_SERVERS, VITE_TURN_* env, `?ice=relay`, `?monitor=on`)
- `src/collabmix-production.jsx` L549–574 — createEngine: master → analyser → monitorDelay (1.0 s DelayNode) → destination chain
- `src/collabmix-production.jsx` L3785–3932 — Opus profile + levers: AUDIOLITE/OPUS_HIFI, AUDIO_NACK_ON, OPUS_PTIME, mungeOpusHiFi, parseOpusProfileFromSdp, applySenderHiFi
- `src/collabmix-production.jsx` L3934–4542 — useRTC hook: self-echo guard, stats poll + SEND-DIAG/JITTER-DIAG/JB-TARGET/connwarn, OPUS-SDP/ICE-PATH proof logs, capture/mkPC/offer/answer/ICE/endCall
- `src/collabmix-production.jsx` L10195–10222 — rtc_hangup reconnect (initiator-only, 3-attempt budget)
- `src/collabmix-production.jsx` L10402–10422 — handleIceRecover (ICE-restart trigger)
- `src/collabmix-production.jsx` L10420–10497 — delay-comp apply loop ([SYNC-COMP] log, COMP_CAP clamp, monitorDelay slew, grid-align gate)
- `src/collabmix-production.jsx` L10562–10605 — initiator election + auto startCall + reconnect-counter reset
- `src/collabmix-production.jsx` ~L7500 and L11985/L12098 — `?connwarn` amber-dot UI on the partner-driven deck
- `src/conn-quality.js` — passive quality classifier: CONN_BANDS, classifyConnWindow, createConnQualityTracker
- `VISION_5.md` — July 1–3 session-end sections (connwarn ship, mirror-timing diagnosis, lever test plan)

### Data flows

- IN: local Web Audio master mix — `capture()` taps `eng.master` into a MediaStreamDestination (upstream of monitorDelay) and addTrack()s it; tracks tagged contentHint='music'.
- IN: WebSocket signaling (rtc_offer/rtc_answer/rtc_ice/rtc_hangup) via handleWS → rtc.handleRtc; outbound signaling through the send prop.
- IN (build time): VITE_TURN_URLS / VITE_TURN_USERNAME / VITE_TURN_CREDENTIAL → TURN entries in the ICE server list.
- OUT: remote partner MediaStream → hidden `<audio>` element, volume driven by remVol, playback gated by the echo guard.
- OUT: compRef {jbMs, playoutMs, targetMs, compMs, rttMs, settleUntil, noFrames} — measured by the 700 ms getStats poll → consumed by the App 1 s interval that eases monitorDelay (delay comp) and sets gridAlignSecRef for the visual playhead.
- OUT: syncStatsRef telemetry (compMeasuredMs/compAppliedMs/compOn/…) for the HUD; rtc.connQuality (good/marginal/poor) → amber dot when `?connwarn=1`.
- IN: `markTransportEvent()` from transport handlers (partner playing change; local seek/cue; local play/pause) → forces the stats poll to re-baseline across the discontinuity.
- OUT: console diagnostics — [ICE], [ICE-PATH], [OPUS-SDP] (one-shot + 20 s re-logs), [JITTER-DIAG] (~2 s), [SEND-DIAG] (~2 s, always on), [SYNC-COMP] (~1 s when delaycomp on), [JB-TARGET], [RTC-RECOVER], [CONN-QUALITY], [SELF-ECHO-GUARD].
- IN/OUT: BroadcastChannel 'cm-presence' heartbeats between same-origin tabs for the self-echo guard.

### Invariants

1. The peer-send capture and the recorder tap `eng.master` UPSTREAM of monitorDelay — delay compensation never colors sent or recorded audio.
2. A default session (no flags on either peer) negotiates 256k stereo Opus with useinbandfec=1 in both directions; all levers (`?audiolite`/`?audionack`/`?ptime`) default OFF.
3. The answerer always advertises min(initiator bitrate, its own cap), so the REDUCED profile wins whichever peer sets the flag.
4. jitterBufferTarget is applied ONLY to the live partner audio receiver, never local audio, and re-asserted every poll tick so post-reconnect receivers inherit it.
5. compMs is never slewed toward a meaningless 0: absent/never-emitted inbound (noFrames), counter resets, non-flowing windows, and transport events all HOLD the last good value and re-baseline.
6. A measured comp value is trusted only after 4 consecutive healthy ~700 ms windows; a drop below 50% of the last good value requires 7.
7. Applied monitor delay is clamped to COMP_CAP_MS (default 400 ms, hard max 950 ms) — always below the DelayNode's 1.0 s ceiling.
8. Only the elected initiator (lexicographically smaller DJ name; tie → host) ever initiates or restarts calls; reconnect budget is 3 attempts, reset on successful connect or new partner.
9. The conn-quality classifier is WARN-ONLY — it never auto-applies any lever, and rttMs alone can never classify 'poor' (its poor threshold is Infinity).
10. Self-echo guard: exactly the earliest live same-origin tab keeps partner audio; an explicit user toggle latches and is never overridden; two different machines can never trip it (BroadcastChannel is same-origin).
11. Partner audio playback starts only via explicit user action when autoplay is blocked — deliberately NO global click-resumes-audio handler.
12. mungeOpusHiFi is idempotent across re-munges (NACK line skipped if present; ptime lines replaced before insert) and returns SDP unchanged if no Opus rtpmap exists.

### Flags

| Flag | Default | Effect |
|---|---|---|
| `?ice=relay` | 'all' | Force iceTransportPolicy 'relay' (TURN-only proof mode). |
| `?jbtarget=<0-4000>` | 220 | Partner receiver jitterBufferTarget in ms; 0 = browser default. |
| `?compcap=<0-950>` | 400 | Delay-comp ceiling in ms. |
| `?delaycomp=0` | ON | Kill switch for local-monitor delay compensation. |
| `?gridalign=0` | ON | Kill switch for shifting visuals to the audible (comp-delayed) position. |
| `?gridcouple=0` | 1 (coupled) | Legacy separately-slewed visual offset instead of reading live monitorDelay. |
| `?audiolite[=<kbps>[m]]` | OFF (256k stereo) | Reduce Opus bitrate on the peer stream; bare = stereo 128k; 'm' = mono (diagnostic); answerer auto-matches so one flag covers both directions. |
| `?audionack` | OFF | Inject `a=rtcp-fb nack` into offer+answer for Opus retransmission; needs the flag on the peer that munges each description; 20 s proof re-log. |
| `?ptime=<20-120>` | OFF (20 ms ≈ 50 pkt/s) | Opus frame size (packet-rate lever) via setParameters; bare/invalid snaps to 40; answerer auto-matches. |
| `?connwarn=1` | OFF | Passive good/marginal/poor indicator from receiver stats; warn-only amber dot. |
| `?monitor=on` | guard active | Bypass the self-echo guard entirely. |
| `?wsurl=<ws://…>` | — | Signaling-server override, TEST_HOOKS-gated (dev or `?smoke=1`). See risk register: `?smoke=1` in a production URL activates it. |

---

## 2.5 Mirror render (partner deck display)

### Summary

The mirror render is how each client draws the PARTNER's two decks. There are only two `<Deck>` components (each with one `<AnimatedZoomedWF>`) in the whole app: a deck runs as a normal local deck when a track is loaded (`buf` set) and switches to MIRROR mode whenever no local track is loaded but partner state has arrived (`remote && !buf`) — "shared decks", last-write-wins. The partner's audio-truth position arrives only as a 10 Hz `deck_update` progress stream, so a per-deck follower turns those sparse packets into a smooth, forward-only 60 fps displayed position.

The follower is forward-only by construction: it tracks a target extrapolated from the last packet at an OBSERVED base rate (an EMA of the packet slope, bootstrapped from the broadcast rate so a sparse stream never freezes), speeding up to a capped 3× to recover a gap (MAX_CATCHUP) and easing to a 15% forward CREEP when it has over-coasted ahead — it never moves backward except on a genuine transport jump. Two jump signals exist: a monotone `seekEpoch` the driver bumps and broadcasts BEFORE the new progress on every real user seek/cue (never on sync-engage's noQuantize phase-align seeks), which forces a deterministic hard-snap; and a 10 s magnitude backstop for a missing epoch. A reorder guard discriminates by magnitude, not arrival order: a packet below the anchor by <0.75 s is dropped as jitter/reorder, ≥0.75 s is a genuine rewind and snaps. Send-time anchoring (`?mirrortsend`, ON) keeps a 15 s window of (tRecv−tSend) samples, takes the window MIN to isolate clock-skew+min-transit, and anchors the coast at `now − excessMs` (capped 2000 ms) so a TCP/WS clump's hold-back never becomes mirror lag (proof run in VISION_5.md: legacy p90 +130 ms → fix p90 +13 ms). A paused mirror is static — it re-anchors truth on pause-entry without moving, and moves only on a genuine >20 ms re-cue; on play-start it HOLDS at the displayed position (`remAwaitPktRef`) until the first genuinely-new packet, avoiding the old jump-to-end.

Incoming fields are coalesced — merged into a per-deck pending object and flushed with at most one `setPA`/`setPB` per animation frame — so a network burst can't fire N whole-App reconciles and starve the draw RAF. Rendering is the LOCKED waveform aesthetic (June 26, 2026 — see `WAVEFORM_LOCKED.md`; do not change the look): the playhead is fixed at horizontal canvas center and progress is conveyed by the waveform scrolling left, the visible window is rate-aware (`viewBufSec = windowSec × rate`) so two synced decks at different rates show the same wall-time span, grid ticks are sub-pixel (no shimmer at non-1.0 rate) and none render before t=0, and in the default coupled grid-align mode the draw loop reads the LIVE `monitorDelay.delayTime` AudioParam every frame — one source of truth so visual and audible delay can't drift, applied as a render-time-only offset (`progRef`/sync truth is never touched).

Two corrections to the original (unverified) map surfaced under verification. *Amended:* the hidden-tab visibilitychange re-anchor is confirmed dead, not merely "suspected" — both decks pass `local` (= true), so its `if(local) return` guard is always true and it never runs (risk #36). *Refuted:* sync engage does NOT read the smoothed mirror-display phase; it deliberately reads the stable packet anchor (`stableProg`) for a partner-driven deck, so mirror-phase stability is NOT a sync-idempotency dependency (§4.4, risk #38).

### Key files

- `src/collabmix-production.jsx` L64–153 — mirror/render flag block: WF_GRID_UNIFORM (L64), MIRROR_DIAG (L86), SMOOTH_DIAG (L99), GRID_ALIGN (L115), WF_GRID_COUPLE (L123), WF_PROG_THROTTLE (L131), MIRROR_TSEND (L142), PROG_STATE_MS=100 → ~10 Hz (L153)
- `src/collabmix-production.jsx` L6503–6529 — follower ref block (remDispRef/remSlewRef, remSkewWinRef, remAwaitPktRef, lastSeekEpochRef, lastPausedProgRef, remRafProbeRef)
- `src/collabmix-production.jsx` L6568–6886 — the mirror follower effect: play-start HOLD (L6578–6589), constants MAX_CATCHUP/CREEP_FRAC/SLEW_TAU_MS/FWD_SNAP_SEC/REORDER_TOL_SEC (L6612–6626), re-anchor on genuinely-new progress (L6631), MIRROR_TSEND transit correction (L6641–6658), reorder guard (L6660–6680), seek-epoch / rewind snap + observed-rate EMA (L6681–6779), paused-static branch (L6784–6810), per-deck RAF follower (L6811–6884); effect deps `[remote,local,buf]` (L6886)
- `src/collabmix-production.jsx` L6894–6908 — hidden-tab visibilitychange re-anchor effect (gated `if(local) return` — **DEAD**, see risk #36)
- `src/collabmix-production.jsx` L6922–6956 — broadcastProgress (driver-only, 10 Hz cap L6928–6929, computed from `ac.currentTime` L6931) + Worker heartbeat (L6943–6956)
- `src/collabmix-production.jsx` L7098–7133, L7144–7159 — seek/cue transport: smart-quantize + seekEpoch bump broadcast-before-progress, gated `!noQuantize`
- `src/collabmix-production.jsx` L5178–6117 — AnimatedZoomedWF: LOCKED banner + refs (L5178–5271), coupled/legacy alignSec (L5343–5354), rate-aware viewBufSec (L5385–5392), LOCKED paint block (L5560–5898), grid markers uniform-vs-refined (L5929–5947), no-grid-before-0 (L6007) + sub-pixel x (L6008), fixed-center playhead (L6060–6069), [MIRROR-DIAG]/[SMOOTH-DIAG] probes (L5302–5310, L6071–6112); draw-RAF deps `[h,windowSec,progRef]` (L6117)
- `src/collabmix-production.jsx` L9638–9641 — progRefA/B + handleProgA/handleProgB (the `onProgUpdate` sink)
- `src/collabmix-production.jsx` L10191–10197, L10266–10280, L10403 — partner-field coalescer (pendPARef/pendPBRef/pendRafRef; progressMeta attached only to progress packets; one flush/frame) + sync_response full pA/pB replay
- `src/collabmix-production.jsx` L10455–10482 — comp poll → gridAlignSecRef (coupled GATE vs legacy slewed copy)
- `src/collabmix-production.jsx` L10925–10953 — sync-engage `stableProg` (reads the STABLE packet anchor for a partner-driven deck, NOT the mirror display — see §4.4 / risk #38)
- `src/collabmix-production.jsx` L11925, L11942 — AnimatedZoomedWF instances (props fall back `bpm.results ?? pA/pB`, gridAlignSecRef, monitorHostRef=eng); L11985, L12098 — the two `<Deck>` instances, both `local` (= true)
- `tools/docs/WAVEFORM_LOCKED.md` — locked aesthetic values + tried/rejected list

### Data flows

**In**
- Partner progress: the driver Deck computes progress from the audio clock (worker-heartbeat-backed when backgrounded) and broadcasts `deck_update` progress at ≤10 Hz via `useSync.send` (t_send stamped).
- WS receive: handleWS merges partner fields into the per-deck coalescer, attaches `progressMeta={value,tSend,tRecv}` to progress packets, and flushes ≤1 `setPA`/`setPB` per animation frame; pA/pB flow into each Deck as the `remote` prop; a `sync_response` replays the whole pA/pB snapshot on rejoin.
- Seek signal: the driver bumps+broadcasts `seekEpoch` before the new progress on real user seeks/cue; the mirror consumes it as the primary deterministic snap.
- Delay-comp measurement: `rtc.compRef` polled ~1 s drives the audio `monitorDelay` AudioParam and sets the `gridAlignSecRef` gate.
- Analyzer artifacts: per-track band arrays + beatTimes/beatPhaseFrac/beatPeriodSec/gridOffsetMs arrive as AnimatedZoomedWF props — locally analyzed (`bpm.results`) or mirrored from the partner (`pA/pB`).

**Internal**
- Follower: on each genuinely-new `remote.progress`, re-anchor (reorder-guarded, tSend-corrected), learn the base rate (EMA), then a per-deck RAF emits a smooth monotonic displayed position into `progRef` at 60 Hz plus a ≤10 Hz React `prog` state.

**Out**
- Render: AnimatedZoomedWF's own 60 fps RAF reads `progRef` (or `dragProgRef` during a scrub), subtracts the live `monitorDelay` alignSec, and paints bands + grid ticks + the fixed-center playhead.
- App position sink: `onProgUpdate` writes each deck's displayed position into App-level `progRefA/B`. (Refuted vs the original map: the sync engine reads `progRefA/B` only for a LOCALLY-driven deck; for a partner-driven (mirror) deck it deliberately reads the stable packet anchor via `stableProg`, NOT the follower display — so mirror-phase stability is NOT a sync-idempotency dependency; §4.4, risk #38.)
- Diagnostics: `?mirrordiag`/`?smoothdiag` console families ([MIRROR-DIAG], [MIRROR-NET-DIAG], [MIRROR-RAF], [MIRROR-STALE], [SMOOTH-DIAG]) plus `logEvent` entries into the Cmd+Option+L downloadable session ring.

### Invariants

1. **Monotonic forward:** the displayed position never decreases except on a genuine transport jump (a fwdSeek/epoch snap, or a ≥0.75 s rewind snap); when smoothing would reverse, the RAF creeps forward instead (jsx L6855–6866).
2. A deck is in mirror mode iff `remote && !buf` (`if(!remote||buf)return`, jsx L6569); the `local` prop does NOT select mirror mode — it is constant-true (see risk #39).
3. Re-anchor happens ONLY on a genuinely-new `remote.progress` (jsx L6631); every other partner-field change (rate, waveform, analyzer re-broadcast) leaves the coast undisturbed.
4. `seekEpoch` is the primary snap signal (jsx L6696–6698); it is bumped+broadcast only on real user seeks/cue, before the progress it describes (jsx L7132, L7152), never on engage's noQuantize phase-align.
5. Reorder guard: a below-anchor packet <0.75 s is dropped, ≥0.75 s snaps as a rewind — decided by magnitude, never arrival order (jsx L6668, L6699).
6. Under `?mirrortsend`, the coast anchors on send-aligned time (`now − excessMs`; excess = clump hold-back from a 15 s window MIN, capped 2000 ms); no meta → excess 0 → legacy-identical (jsx L6641–6658).
7. Partner fields commit at most once per animation frame (per-deck pending object, single RAF flush) (jsx L10191–10197, L10270–10280).
8. The grid-align offset is render-time only: `prog2 = rawProg − alignSec/dur`; `progRef` (sync/broadcast truth) is never mutated by it, so click-to-seek reads the true position (jsx L5355, comment L5332–5336).
9. In coupled mode the visual delay IS the live audio `monitorDelay.delayTime` read each frame — visual and audible delay cannot drift (jsx L5344–5346); legacy `?gridcouple=0` keeps a separately-slewed copy.
10. The follower writes `progRef` at 60 Hz but the React `prog` STATE at ≤10 Hz under `?progthrottle` (jsx L6872–6874); the driver's own progress BROADCAST is separately capped at 10 Hz and computed from `ac.currentTime`, not the RAF snapshot (jsx L6928–6931).

### Flags

| Flag | Default | Effect |
|---|---|---|
| `?mirrortsend` | ON | =0 reverts to legacy arrival-time anchoring of the mirror coast (jsx L142). |
| `?gridcouple` | ON (1) | Waveform reads the live monitorDelay.delayTime each frame; =0 legacy separately-slewed alignSec copy (jsx L123). |
| `?progthrottle` | ON | React prog STATE ≤10 Hz (the 60 Hz ref pipe is untouched); =0 restores 60 Hz state (the ~23 fps regression A/B) (jsx L131). |
| `?gridalign` | ON | =0 disables the visual shift of playhead/grid to the audible position. Requires delaycomp on (jsx L115). |
| `?griduniform` | ON | Grid LINES at uniform anchor + n×period; =0 lines at raw refined beatTimes. Grid lines only — seek/engage always use the refined kicks (jsx L64). |
| `?delaycomp` | ON | =0 kills delay compensation, which also zeroes the grid-align offset. |
| `?compcap=<ms>` | 400 (0–950) | Ceiling on measured comp, hence on alignSec magnitude. |
| `?jbtarget=<ms>` | 220 | Partner jitter-buffer pin; indirectly sets the comp magnitude the render offsets by. |
| `?mirrordiag=1` | OFF | [MIRROR-DIAG]/[MIRROR-NET-DIAG]/[MIRROR-RAF]/[MIRROR-STALE] logging + logEvent mirroring; pure logging (jsx L86). |
| `?smoothdiag=1` | OFF | Per-deck scroll-smoothness/frame-cadence/draw-cost logging (role=local\|mirror) (jsx L99). |
| `?wfmiddiag=1` | OFF | Marked THROWAWAY in source. |

---

## 3. Consolidated risk register

All 40 risks from the five subsystems, sorted by severity (High → Medium → Low), then likelihood. Rows 1–35 are the original four-subsystem audit; **rows 36–40 (newly added, July 2, 2026) close the mirror-render gap** — its risk pass was absent from the original source data (see §2.5 and §4.4). The new rows are appended in row-number order at the end of the table rather than re-sorted into it, so the original numbering stays stable.

**Cross-subsystem duplicates are kept as separate rows for traceability** and marked: † delay-comp cap saturation (same root cause, two subsystem views); ‡ single-file concentration (four views); § rotted keep-in-sync duplicate (two views); ¶ unvalidated peer input / NaN (two views); ∥ unauthenticated rooms (two views).

| # | Title | Subsystem | Sev | Likelihood | Evidence | Mitigation |
|---|---|---|---|---|---|---|
| 1 | † Delay-comp 400 ms cap saturates under real network jitter; no shipped lever fixes the exogenous case — the core "one booth, one truth" promise audibly fails | audio-engine | High | High | jsx L171–182 (cap comment: buffer balloons 500–650 ms, comp measures 650, applies 400 → ~250 ms flam) + L10448 clamp. Measured: Jake's log 665→400; local repro measured=666 applied=400 residual=266 ms; raising cap ears-REJECTED; July 1 lever ladder NULL across the board vs frozen exogenous burst-jitter (VISION_5.md ~L10024–10161). | Run the specced Jake-on-ethernet decision tree to classify his jitter; if environmental, prioritize the parked architectural fix (route partner audio through Web Audio; rethink comp for deep-but-honest buffers, Chad's ears as gate). Ship `?connwarn` default-on so users see the environment is the cause. |
| 2 | † Delay-comp cap saturation — the audible "double-kick" flam has no shipped fix for exogenous jitter (transport view) | webrtc-audio | High | High | Same mechanism from the transport side: deterministic harness repro (jbTargetMs 532–540, measured 450–480+, applied flat 400); lever ladder audiolite/ptime/combo ALL NULL vs exogenous burst jitter; self-congestion rung shows jbTarget max 627, comp measured max 980, applied pinned 400, loss bursts 27% (VISION_5.md ~L10139–10237). | Ethernet-first classification; ship `?audiolite=96` as the WiFi/self-congestion default (proven: buffer 220 flat, zero loss); fund the banked architectural package (Web Audio routing + deeper cap, or beat-quantized comp) for the exogenous case. |
| 3 | ‡ 12,141-line single file with verbatim keep-in-sync math copies and 32 URL flags carrying live legacy branches — change risk and bus factor concentrate in one artifact | audio-engine | High | High | `wc -l` = 12,141 (engine, WebRTC, recorder, decks, sync, UI). Keep-in-sync comment points at a file that doesn't exist (copy actually in tools/smoke/tests/engage.smoke.mjs). 32 URL_FLAGS.get sites, many default-on with preserved legacy paths — combinatorial state space the smoke suite can't cover. CLAUDE.md documents a session lost to re-discovering existing work. | Incremental extraction: move the pure shared math (nearestBeatTime/refinedBeatPhase) into an imported module used by app AND smoke first. Maintain a flag registry (name, default, ship date, retirement condition); retire decided legacy branches. Full split only one self-contained unit at a time behind green smoke. |
| 4 | ‡ Entire sync engine in the one 12,141-line JSX file with imperative cross-couplings; only maintainer context is AI sessions | sync-engine | High | High | Subsystem spans ~15 non-contiguous ranges (useSync L3628, engage math L9198, drift monitor L10642, syncDecks L10835, attemptLock L11163…). Rate changes reach audio via a DOM escape hatch (`[data-set-rate]._setRate`). Founder cannot read code deeply; bus factor is the handoff docs, which the file itself calls a lossy summary. | Extract one module per session following the clockSync.js pattern: driver-model gate, engage math core, useSync — each unit-testable in the existing smoke harness. Replace the DOM rate hook with a rate-callback registry (rateFnsRef already exists). |
| 5 | Pause position math ignores playbackRate — synced decks freeze/resume at the wrong spot | audio-engine | High | Medium | jsx L7057 (toggle pause): `off.current += (ac.currentTime−st.current)` without ×rate. Every sibling path is rate-aware (tick L7016, broadcastProgress L6931, rate rebase L7465). A sync-locked deck at rate 1.03 for 2 min accrues ~3.6 s of error at pause; wrong frozen position is broadcast and resume restarts from it. Sync holds rate≠1 by design (±12% clamp). | One-line fix: multiply elapsed by rateRef.current, mirroring L6931. Add a smoke: play at 1.05 via `window.__setRateDeck`, pause, assert frozen progress matches audio-clock truth within a few ms. Confirm with Chad first (Investigation-First) since broadcast positions change. |
| 6 | User manual grid edit creates a split-brain grid: rendered lines follow the edit, but seek-quantize and sync engage still use the stale analyzer beatTimes | analyzer | High | Medium | `_buildUserGrid` synthesizes only bpm/period/anchor and never rebuilds or clears beatTimes (jsx ~L9843–9854); mergeOne re-derives only the phase scalars. Under `?beatsv2` (ON), seek-quantize, engage phase-align, and the engage seek all consume the OLD kicks, while uniform grid lines render the edit. Manual edit is the exact workflow the 19.1% failure tail requires. | In mergeOne, when a user override changes bpm/anchor, synthesize uniform beatTimes = anchor + n×period (math already shipped in rekordbox-grid.js) or null beatTimes so consumers fall back to the linear path. Smoke: user-override → engage → assert alignment against the OVERRIDE grid. |
| 7 | Analyzer has no track-length cap: full-rate Float32 allocations scale linearly — long DJ mixes risk worker/tab OOM, and this input class was excluded from all testing | analyzer | High | Medium | Worker allocates full-track mono + two more full-length arrays in `bp()`; page side slices every channel (full extra copy) before transfer; no duration cap anywhere. A 2-hour 44.1 kHz mix ⇒ several ~1.3 GB arrays live simultaneously. The 80.9% figure EXCLUDES 11 long DJ mixes (VISION_5.md ~L1754). Dormant chroma/SSM burns CPU for a diagnostic-only output; one worker serializes deck A and B. | Cap or decimate analysis input (first N minutes for period/anchor; grid is extrapolated under griduniform) or downsample to mono ~11–22 kHz for envelope stages (the library import proved 11 kHz mono works). Gate chroma/SSM behind a diagnostic flag. Validate on 2–3 real DJ-mix files. |
| 8 | Last-write-wins sync state with no versioning — master election can split-brain across clients; rejoin replay can resurrect stale state | sync-engine | High | Medium | attemptLock picks first-to-play, but the partner deck's start time is stamped at packet ARRIVAL vs local click — two starts within one-way latency (~100–300 ms real dogfood) elect OPPOSITE masters, each freezing its own lockedMasterRef against a last-write-wins masterDeck mirror. sync_response applies a full snapshot with no freshness check; engines run on uncoordinated setTimeouts (50/90/700 ms). | Add a monotonic epoch to sync-state fields and ignore stale epochs; break first-to-play ties deterministically (lower djId wins); stamp sync_response with sender field epochs so replay never regresses. Pin with an e2e-chaos smoke: 200 ms asymmetric latency + simultaneous starts. |
| 9 | Security: `?smoke=1` in a crafted production link defeats the `?wsurl` gate and exposes remote-control test hooks | sync-engine | High | Low | TEST_HOOKS = DEV \|\| `?smoke=1` (jsx L209); SERVER_URL honors `?wsurl` when TEST_HOOKS (L438). The in-code claim that a crafted link "can NEVER redirect a real user's socket" is wrong: `?smoke=1&wsurl=wss://attacker` redirects the socket (attacker relay sees room/name, can inject every message type handleWS trusts) and installs `__seekDeck`/`__toggleDeck`/`__syncDeck`/`__loadTestTrack` in production. | Gate the wsurl override on `import.meta.env.DEV` only, or restrict to ws://localhost. Have `?smoke` hooks refuse to install on the production origin. Add a smoke asserting SERVER_URL stays default under `?smoke=1&wsurl=…` in a production build. |
| 10 | EQ and channel-volume knobs write `.gain.value` instantly (no ramp) on the path feeding the partner send and recorder — zipper/click artifacts get transmitted and recorded | audio-engine | Med | High | jsx L6562: direct instantaneous AudioParam steps (Chrome removed auto-dezippering in 2018). Every other live gain is smoothed (crossfader TC .01, trim gate TC .02, seek 33-point curves). The deck chain sits upstream of master, which feeds both the WebRTC send tap and recorder tap — worst with MIDI-driven EQ bursts. | Replace the four writes with `setTargetAtTime(v, now, 0.01)` matching applyXF — mechanical, low-risk. Verify by ear with a fast MIDI EQ sweep while recording; confirm smoke stays green. |
| 11 | Three-band waveform extraction iterates every sample of the full track on the main thread during load() — multi-hundred-ms UI/telemetry stall while the other deck plays live | audio-engine | Med | High | jsx L7388–7423: synchronous per-channel per-sample loop (~15 float ops/sample) over the whole decoded buffer inside load(); a 7-min stereo track ≈ 37M samples ×2. During the stall the RAF tick, the 1 s comp interval, and the Worker heartbeat's main-thread onmessage all queue — partner mirror sees a progress gap; looks like the parked "waveform fps freeze" symptom class. | Move band extraction into a worker (bpm-worker pattern; same transfer can carry channel data) or chunk across idle slices. Cheap first step: measure the actual block time with performance.now() on a long track to size the priority. |
| 12 | 19% of tracks ship a wrong grid, broadcast to the partner with zero confidence gating or user-facing signal | analyzer | Med | High | Measured 80.9% harness pass rate, work deliberately paused (VISION_5.md ~L1751–1758). Broadcast sends grid unconditionally once per analysis; both clients' sync/quantize consume it. The worker computes lowConfidence but only under `?bpmretry` (default OFF) and nothing surfaces it. Rekordbox precedence and the ±12% clamp partially mitigate. | Surface the already-computed guard state as a per-deck low-confidence indicator prompting Rekordbox import or manual edit (already framed as table-stakes). Feed the same signal into planned real-user telemetry so analyzer work resumes against production data. |
| 13 | § Keep-in-sync verbatim helper duplicates between app and smoke suite — pointer comment already rotted, so drift would pass the pre-push gate green | analyzer | Med | High | jsx comment says the helpers are duplicated in `tools/smoke/engage_align.smoke.mjs` — that file doesn't exist; the copy lives in `tools/smoke/tests/engage.smoke.mjs` (currently logic-identical). Enforced only by comment: a change to either copy keeps `npm run smoke` green against the OLD math. | Extract the two helpers into a small pure module imported by both (they're DOM-free; same pattern as rekordbox-grid.js). Failing that, add a smoke step that string-compares the function bodies and fails on mismatch. Fix the stale path. |
| 14 | ‡ The entire 1,400-line analyzer lives inside a JS template string, hosted in the 12,141-line app file — no lint/typecheck coverage, blob-URL stack traces, comment/code drift already present | analyzer | Med | High | `WORKER_SRC` wraps the analyzer as a string: no linting, a stray backtick breaks the bundle, runtime errors report blob-URL line numbers. Verified drift inside the string: walk-back comment says "capped at 35ms" while code is 45 ms; `dphase()` is fully dead. MEMORY.md already warns line numbers are stale — every session pays a re-verification tax. | Convert the worker to a real module loaded via Vite `?raw`/`?worker` (Node harness reads the same file, preserving dual-runtime). Same cleanup: fix 35 vs 45 ms (or re-run the 272-track harness to pick), delete dphase, gate chroma/SSM. |
| 15 | ~1.2 MB+ of JSON per track load and per rejoin rides the same WebSocket as the 10 Hz progress stream (head-of-line blocking) | sync-engine | Med | High | WF_W_BC=24000 (~400 KB per band, code's own comment) ×3 bands per track load as deck_update JSON; beatTimes/beatAttacks add more; all replayed WHOLESALE as one sync_response on every rejoin plus duplicate analyzer re-broadcast. On one TCP socket this queues around the 10 Hz progress packets — exactly the 100–600 ms pktGap clumping MIRROR_TSEND papers over — recurring at every track load and reconnect. | Cut broadcast waveform resolution (partner deck renders far fewer columns); hash-check before re-sending unchanged payloads on rejoin; chunk large payloads into idle gaps between progress packets. Measure with existing [SEEK-SEND]/pktGap logging before/after. |
| 16 | ‡ WebRTC subsystem scattered across five non-contiguous regions of the 12,141-line file — high change-risk and session re-discovery cost, bus factor ~1 | webrtc-audio | Med | High | Flags L100–209, engine L548–573, Opus munging L3785–3932, ~600-line useRTC L3934–4542, App-side reconnect/comp/election L10200–10610, UI ~L11980. Cost already paid: MEMORY.md "LINE NUMBERS STALE"; all comprehension re-derived per AI session. | Extract by the proven conn-quality.js pattern: mungeOpusHiFi/parseOpusProfileFromSdp/applySenderHiFi → src/opus-sdp.js (pure, unit-testable); useRTC → src/use-rtc.js, flag defaults byte-identical, gated on full smoke. Dedicated no-feature session. |
| 17 | Field diagnostics depend on Chrome's 1000-line console buffer — evidence keeps getting truncated; always-on 2 s logging accelerates it | webrtc-audio | Med | High | Bitten twice: [OPUS-SDP] NACK proof scrolled off (hence the 20 s re-log, commit f2f3ed5); the July 2 "all-night" Jake log was EXACTLY 1000 lines covering only the last ~7 min (VISION_5.md ~L10286). [SEND-DIAG] logs ~2 s unconditionally; [SYNC-COMP] ~1 s whenever delaycomp is on (the default) — ~1.5 lines/sec in production. | Route diag families through an in-app ring buffer (last ~30 min of structured samples) included in the existing Cmd+Opt+L session JSON export; then drop console cadence or gate behind `?diag`. |
| 18 | Two-sided flag coordination hazard — per-client flags silently produce mixed configurations; already caused a false-negative A/B class | webrtc-audio | Med | High | Flags split into auto-propagating (`?audiolite`/`?ptime`), both-peers-required (`?audionack`), and purely per-client (`?jbtarget`/`?compcap`/`?mirrortsend`/`?connwarn`). The lever-reliability fix comment records the real failure: before the answer re-apply, a partner-only flag never dropped our lossy send — the exact bug giving a false "flag didn't help". Nothing checks peer flag parity. | Exchange a compact flags manifest over signaling at connect and log one [FLAG-MISMATCH] warn line on coordination-sensitive differences — cheap, log-only, makes every A/B log self-certifying. |
| 19 | Deck load() has zero error handling — a corrupt/unsupported audio file silently kills the load with an unhandled promise rejection | audio-engine | Med | Med | `await f.arrayBuffer(); await ac.decodeAudioData(ab)` with no try/catch; all three call sites fire-and-forget with no `.catch()`. decodeAudioData rejects on truncated/DRM/undecodable files (some ALAC/AIFF variants common in real DJ libraries) — deck shows no feedback, keeps stale state. Mid-set, the DJ can't tell loading from dead. | Wrap load() in try/catch; quiet toast ("Couldn't decode <name>"), leave the current track intact, log [LOAD-FAIL] for dogfood triage. Smoke: drop a garbage buffer, assert the deck survives. |
| 20 | Behavior flags are module-load captured, unpersisted, and peer-asymmetric — a stale bookmarked flag or one-sided lever silently degrades a session with no UI trace | audio-engine | Med | Med | All levers read once at module load (must survive the post-join query-string strip), so a flag can be active with no URL evidence. Several are pair-sensitive (JB_TARGET_MS partner-receiver-only; `?audionack` needs both; `?audiolite` "Chad or BOTH, never Jake-alone" — the 68b2014 lever-reliability bugfix exists because a one-sided flag silently did nothing). A tester bookmarking `?jbtarget=650` gets a permanently deep buffer and the saturation flam every session. | Add a [FLAGS] boot line listing non-default flags; exchange it over the WS hello so each side logs BOTH peers' flags; warn on known-bad asymmetries. Optionally a small "modified" HUD badge (single low-opacity indicator, Quiet Pro-consistent). |
| 21 | Flag operability gaps: Rekordbox-grid precedence has no runtime kill-switch; the one-shot URL_FLAGS capture is an unenforced convention | analyzer | Med | Med | `USE_RB_GRID = true` is compile-time only — disabling a bad imported grid in production requires edit + redeploy, unlike every other analyzer lever. The flag-capture comment ("This is the fix for ?onsetgrid not reaching the analyzer") proves the read-location failure already happened once; no lint/smoke prevents new code from reading window.location.search directly. | Promote USE_RB_GRID to a URL_FLAGS-backed default-ON kill-switch (`?rbgrid=0`) matching the established pattern. Add a grep-based smoke/lint assertion that window.location.search appears only in the URL_FLAGS initializer. |
| 22 | ∥ Security: unauthenticated room join, ~130k guessable room codes, zero validation of inbound WS payloads | sync-engine | Med | Med | Room IDs are word-word-NNN from a 12-word list: 129,600 combinations, enumerable against the public relay. Join is `{type:"join", roomId, djName}` with no token. Any joiner gets full partner control: seek_request executes unvalidated (the [0,1] clamp passes NaN → deck inert); toggle/cue execute blind; deck_update merges with no type checks; master_vol_update sets local output volume directly. | Add a secret token to the invite link, checked server-side. Client-side: Number.isFinite + range checks on seek_request/deck_update numerics and master_vol_update. Rate-limit joins server-side. |
| 23 | WS reconnect gives up permanently after a 30 s window — a mid-gig outage over 30 s silently strands the session | sync-engine | Med | Med | RECONNECT_WINDOW_MS = 30000; elapsed > window → "[RECONNECT] phase=gaveup", no further retries. The wake handler only re-dials on visibilitychange/online events, so a >30 s outage with the tab visible ends the loop with no user-facing recovery. Real dogfood drop frequency (TURN + echo-guard shipped for this class) makes >30 s blips plausible live. | After the 30 s aggressive window, drop to indefinite slow retry (15–30 s) instead of stopping; surface a one-click "Reconnect" button wired to connectRef with the saved room. Both local to useSync. |
| 24 | § The sync-engine keep-in-sync duplicate of the engage math has already rotted — source comment points at a file that doesn't exist | sync-engine | Med | Med | Comment cites `tools/smoke/engage_align.smoke.mjs`; the actual copy is `tools/smoke/tests/engage.smoke.mjs` ("COPIED VERBATIM"). An app-side edit (e.g. boundary clamp in refinedBeatPhase) would fail no test — the smoke gate keeps passing against the OLD math, silently invalidating the 30 ms idempotency bound it protects. | Extract into a shared module imported by src and the smoke test (pure functions; suite already imports from lib/). Or add a smoke check string-diffing the two function bodies. Fix the stale comment. |
| 25 | ~20 URL flags with default-ON fixes keep live legacy code paths in the prod bundle, tested only in the default configuration, deploying straight to prod on master push | sync-engine | Med | Med | Legacy branches ship one query-param away (`?beatsv2=0` re-enables Path C xcorr engage; `?syncprecision=0` the rounded-BPM rate). Smoke exercises defaults only; several tests documented xfail/SKIP and SKIP never fails the run. Master push auto-deploys — no staging gate for flag-interaction regressions. Flags captured once at module load complicate "which config was live" forensics. | Flag-retirement ritual: after each Jake validation confirms a default-ON fix, delete the legacy branch + flag in the same session. Log the resolved flag object once at boot into telemetry. Occasionally smoke the top legacy configs until deleted. |
| 26 | Static long-term TURN credentials shipped in the public JS bundle — extractable relay abuse / quota exhaustion | webrtc-audio | Med | Med | Vite statically inlines VITE_* vars; verified in the local build: dist bundle contains turn:global.relay.metered.ca:80/443 plus the literal username/credential (grep-confirmed). "Secret stays out of the repo" is true of git, not production. Quota exhaustion silently reverts users to STUN-only — the exact "connected then dropped" failure TURN was added to fix. | Switch to ephemeral credentials via a tiny serverless endpoint (metered.ca supports expiring API-generated creds; coturn REST/HMAC is the generic pattern), fetched at startCall. Interim: usage alerts/quota + scheduled rotation. |
| 27 | Signaling server source is not in the repo — protocol evolution blocked, server behavior unauditable | webrtc-audio | Med | Med | DEFAULT_SERVER_URL points at the Railway relay but no server source exists in the repo. Cost already realized: connection-stability fixes #3 (reconnect de-race) and #4 (ghost cleanup) HELD because they "need server.js". Protocol compatibility is convention with no version pin; room-cap/rate-limit questions unverifiable. | Vendor the server into the repo (tools/server/) or link its repo in MASTER_INDEX + CLAUDE.md. Add a protocol version field to join, echoed in 'joined', so drift fails loud. Document the Railway deploy procedure. |
| 28 | Chrome-only API assumptions degrade silently on other browsers (Edge already proven unlistenable in dogfood) | webrtc-audio | Med | Med | "Jake on EDGE was unlistenable; Chrome fixed it" — the IS_CHROME check only warns. Chrome-specific surfaces: receiver.jitterBufferTarget (failure merely warns), encodings[0].ptime (reject-and-retry confesses but the lever silently no-ops), media-playout stats (absent stats leave playoutMs stale → compMs under-measures and comp aligns wrong). Each degradation is per-feature and quiet. | Keep Chrome as the target but make degradation loud: session-start warning enumerating inactive levers from the existing catch paths + a one-shot [COMPAT] log. Cross-browser support, if ever, is a project not a patch. |
| 29 | ¶ Partner-supplied beatTimes trusted in seek quantize — one NaN/garbage value from a peer can brick the deck via play_(NaN) | audio-engine | Med | Low | `beatTimesRef = bpmResult?.beatTimes ?? remote?.beatTimes` with only a length check; nearestBeatTime does no finiteness checks; NaN survives Math.min/max → `off.current=NaN; play_(NaN)` → source.start(0, NaN) throws uncaught. The seek clamp protects the INPUT fraction, not the quantized OUTPUT. Realistic trigger: buggy client version skew (master auto-deploys), not malice. | Sanitize remote arrays at receipt (finite, ascending, length-capped); add `if(!Number.isFinite(pq)) pq=pc;` after quantize. Apply the same caps to the 24000-element remote waveform arrays (flag as adjacent scope). |
| 30 | ¶ Partner deck_update fields trusted without validation; malformed or version-skewed beatTimes can NaN the engage math and seek | analyzer | Med | Low | Any m.field/m.value from a room peer lands directly in pA/pB. Consumers require sorted-ascending finite arrays; unsorted/NaN/huge beatTimes yield NaN frac → newSlaveProg = NaN → seek called with NaN. The ±12% rate clamp protects rate; nothing guards the phase seek. Version skew is the real-world case. | Validate analyzer fields at receive: whitelist field names, Array.isArray + every-finite + sorted + length cap (~200k), isFinite guard on newSlaveProg before the seek. |
| 31 | Worker exception permanently wedges the deck at analyzing:true — the '__err' recovery handler exists page-side but nothing in the worker ever sends it | analyzer | Med | Low | Worker onmessage has no try/catch (grep-confirmed; only success-path postMessage). Page handlers for `id==='__err'` and an error field are dead code. Dispatch nulls grid fields + sets analyzing:true; on an uncaught throw no result ever arrives: no grid, no auto-position, sync exits 'no_bpm', eternal spinner. | Wrap worker onmessage in try/catch posting `{ id, error }`; make useBPM's error paths set analyzing:false + error field so the UI can show "analysis failed — retry". Smoke: feed a malformed message, assert recovery. |
| 32 | ∥ Security: unauthenticated signaling + guessable rooms — an uninvited peer can receive the live master-mix audio and inject state (transport view) | webrtc-audio | Med | Low | 129,600 room combinations generated with non-crypto Math.random; join has no token; server URL public in the bundle. The initiator auto-calls within 500 ms — an intruder receives the live master mix with zero interaction. Inbound state applied unvalidated (deck_update, master_vol_update). Server-side caps unverifiable (source not in repo). | Raise room-code entropy (crypto.getRandomValues, add a segment); server-side rate-limit + reject 3rd join / host approval; client-side field whitelist + clamps. Fix before any public/growth push. |
| 33 | Initiator election keyed on mutable display names, not the server djId introduced precisely because name collisions broke routing | webrtc-audio | Med | Low | isInitiatorRole elects the lexicographically smaller session name, tie → host — yet the code adopted server djId as authoritative identity because persisted-name collisions broke name-based routing. Same-name peers with ambiguous host signal ⇒ both initiate (glare — the handleAnswer InvalidStateError catch is literally called "the safety net") or neither does: silent no-audio session. | Elect on the server-assigned djId (already stored from the 'joined' payload) — unique by construction; the tiebreak and glare net become dead code. Verifiable with existing join/rejoin smokes. |
| 34 | The [SYNC-DRIFT] "2 s" sampler is torn down and re-run on every partner state commit, so it actually samples at packet-flush rate | sync-engine | Low | High | Monitor effect deps include pA/pB/rates/bpm.results and calls sample() immediately each run. While the partner plays, coalesced flushes commit pA up to once per frame → effect re-runs ~10×/s; the 2 s setInterval never survives; only the 500 ms log throttle hides it. Telemetry labeled 2 s cadence is load-dependent, biased toward packet-busy periods. | Read pA/pB/rates via refs inside sample() and narrow deps to [syncLocked, sync.partner, deckDrivers] so one stable 2 s interval owns the cadence. Pure refactor; drift_sample timestamps verify. |
| 35 | ICE-recovery reconnect leaks one live MediaStreamDestination node per attempt (audio-graph accumulation on both peers) | webrtc-audio | Low | Med | capture() creates a NEW MediaStreamDestination and overwrites dest.current WITHOUT disconnecting the previous one; endCall disconnects only the current — and the ICE-failure path never calls it (handleIceRecover → startCall → capture()). Same on the answerer per re-offer. Bounded to 3 per drop, but the counter resets on every successful connect, so a flapping session accumulates without bound. | Two-line fix in capture(): disconnect the previous dest before replacing — or create one persistent MediaStreamDestination per engine at createEngine and reuse its stream (also removes addTrack churn). Smoke: repeated startCall cycles keep master's output count constant. |
| 36 | **(newly added)** Dead hidden-tab re-anchor — the mirror follower's visibilitychange reset never runs, so a backgrounded partner deck can resume frozen / coasted-to-end on refocus | mirror-render | High | Med | The follower selects mirror mode by `buf` (`if(!remote\|\|buf)return`, jsx L6569), but the paired visibilitychange re-anchor is gated `if(local) return` (jsx L6895) and BOTH decks render with `local` (= true) (jsx L11985/L12098) → the guard is always true, the re-anchor is dead. Its own comment (jsx L6888–6893) says its job is to stop the RAF resuming from a stale `remTimeRef` and coasting to the end; unmitigated, a sparse-packet refocus pins the display at 1.0 (the forward-only follower can't come back down) — the exact "displayed position freezes while audio advances" symptom in the PARKED fps-freeze note (MEMORY.md, VISION_5.md). Visual-only (WebRTC audio unaffected). | Change the guard to mirror the follower's own gate — `if(buf) return` (or `if(!remote\|\|buf) return`) — so the re-anchor fires for a deck in mirror mode. Verify with `?mirrordiag=1` across a hide/show cycle on a paused partner. Matches the repair already hypothesized in MEMORY.md. |
| 37 | **(newly added)** seekEpoch deterministic snap is defeated by the reorder guard for small (<0.75 s) backward seeks | mirror-render | Med | Med | The reorder guard runs FIRST: a packet below the anchor by 0<Δ<REORDER_TOL_SEC (0.75 s) is dropped as reordering (jsx L6668–6669) and returns before the seek-epoch check, which lives in the `else` branch (jsx L6696–6698). So a genuine user backward seek smaller than 0.75 s bumps+broadcasts seekEpoch (jsx L7132) but the mirror drops the packet and ignores the epoch — the "primary, deterministic" snap signal is silently overridden by the magnitude heuristic it was built to replace. Self-heals only once the driver replays past the pre-seek anchor (≤~0.75 s of wrong / creeping display). | Test the epoch (or a per-packet "seek" marker) BEFORE the magnitude reorder test, so an epoch change forces a snap regardless of backward magnitude. Smoke: driver seek −0.3 s with an epoch bump → mirror snaps, not drops. |
| 38 | **(newly added)** Follower comments assert sync engage reads the smoothed mirror phase, but engage was deliberately decoupled — stale comments misdirect the exact idempotency lane | mirror-render | Med | High | The follower justifies its SLEW smoothing as producing "a STABLE mirror phase (which sync engage reads)" (jsx L6849–6850) and flags reverse-engineered rate as maybe "coupling into the mirror PHASE that sync engage reads" (jsx L6707–6708). But engage's `stableProg` (jsx L10925–10953) reads the stable last-received packet anchor, NOT the display, precisely because the follower's creep/clamp wobble broke re-engage idempotency (±100 ms). A maintainer trusting the comments would re-tune the follower to "fix" engage — the wrong lane, the exact trap CLAUDE.md / MEMORY warn about. | Correct the follower comments to state engage reads the stable packet anchor (`stableProg`); reframe the SLEW justification as display-smoothness only. Pure comment fix, no behavior change. |
| 39 | **(newly added)** The `local` prop is a constant (both decks pass `local={true}`); mirror-vs-local behavior is split across two different predicates (`local` and `buf`) — a latent bug class | mirror-render | Med | Med | Only two `<Deck>` render sites, both bare `local` (jsx L11985/L12098). The follower keys mirror mode on `buf` (jsx L6569), but sibling effects key on `local`: worker heartbeat `if(!local)` (jsx L6948, always runs), visibility re-anchor `if(local) return` (jsx L6895, never runs — risk #36), drop-guard `if(!local)` (jsx L6554). Any future effect that assumes `local` separates local from mirror decks will be wrong. Root cause of #36. | Remove the dead `local` prop or set it meaningfully; standardize a single derived predicate (e.g. `isMirror = !!remote && !buf`) for all mirror-mode gating, and grep-audit the four `local`-gated effects while doing so. |
| 40 | ¶ **(newly added)** Partner progress/duration reach the follower and the engage phase-anchor unvalidated — a NaN / version-skewed value NaNs the displayed playhead and the engage seek (progress-scalar view of the ¶ cluster) | mirror-render | Med | Low | The follower consumes `remote.progress`/`remote.duration` directly (jsx L6631–6667; `trackDurSec=remote.duration\|\|dur\|\|1`) with no finiteness check → a NaN progress yields NaN `dispNow` → NaN `progRef`. Engage's `stableProg` clamps the partner anchor with Math.min/max but no `isFinite` (jsx L10949) → NaN `slaveCurTime` → phase-align seek called with NaN. Same unvalidated-peer class as #29/#30 (¶) but via the progress scalar, not beatTimes arrays; realistic trigger is client version skew (master auto-deploys). | Validate `remote.progress` (finite, in [0,1]) and `remote.duration` (finite, >0) at receipt; `isFinite` guard before the engage seek. Fold into the same receive-time sanitizer proposed for the ¶ beatTimes rows. |

**Severity totals: 10 High · 28 Medium · 2 Low (40 rows).** De-duplicating the cross-subsystem repeats (†, ‡, §, ¶, ∥) yields roughly 32 distinct underlying risks.

---

## 4. Claim-verification appendix (honesty ledger)

Every architecture claim in the subsystem maps was independently re-verified against source. Verdicts: **confirmed** (evidence checks out), **amended** (substance holds but a stated detail was wrong or imprecise — the correction is recorded below and applied in the doc body), **refuted** (claim wrong — dropped from the body). This ledger is deliberately complete: nothing amended or refuted is hidden.

A recurring, benign amendment class: line-number staleness (+5 in `collabmix-production.jsx` from a flag-block insertion; +13 in `bpm-worker-source.js` from an inserted `?bpmretry` block). Where staleness was the *only* issue, the verdict was still recorded honestly as stated by the verifier (some as confirmed-with-note, some as amended); the substantive corrections are what matter below.

### 4.1 Counts

| Subsystem | Claims | Confirmed | Amended | Refuted |
|---|---|---|---|---|
| Audio engine | 13 | 12 | 1 | 0 |
| Analyzer | 13 | 1 | 12 | 0 |
| Sync engine | 12 | 10 | 2 | 0 |
| WebRTC audio | 12 | 11 | 1 | 0 |
| Mirror render | 12 | 10 | 1 | 1 (verified July 2, 2026 — gap closed; see §2.5, §4.4) |
| **Total (verified)** | **62** | **44** | **17** | **1** |

### 4.2 Amended claims and their corrections

**Audio engine (1):**

1. *Claim:* Every seek while playing crossfades old→new over 12 ms; "play-start and sync-engage micro-seeks (hardSwap=true) skip the fade and hard-swap instead."
   *Correction:* The crossfade machinery is exactly as claimed, but play-start does NOT use `hardSwap=true` — toggle calls `play_(off.current)` with hardSwap defaulting to false. It skips the fade simply because there is no old source (`doXfade` requires `!!old`), giving an instant attack with nothing to "hard-swap". `hardSwap=true` is passed only by seek's `play_(o, noQuantize)`, i.e. the sync-engage phase-align micro-seek.

**Analyzer (12):**

1. *Claim:* The app "transfers (not copies)" the decoded channel data to the worker.
   *Correction:* Imprecise — the app first COPIES each channel via `buf.getChannelData(c).slice()`, then transfers the copies' buffers. The transfer avoids the structured-clone copy, not all copying (the slice is required so the AudioBuffer isn't detached from playback). Plus jsx citations stale +5.
2. *Claim:* Integer-BPM snap gates (periodIntegerLocked OR crossValidated) AND withinOuterGuard.
   *Correction:* Logic verified exactly as claimed; all cited worker line numbers stale by +13 (the `?bpmretry` block was inserted after the doc).
3. *Claim:* Ellis-2007 DP tracker + per-beat sample-level refinement details.
   *Correction:* Substance fully verified (window is min(0.05, 0.4×beat period), i.e. a ±50 ms CAP); all line citations stale +13.
4. *Claim:* Shipped bar-1 anchor ignores the musical-downbeat logic (walk-back, ~95% vs 28%).
   *Correction:* Fully verified including verbatim comments; lines stale +13. Pedantic note: the walk-back RESULT lands in [0, beatPeriodSec) as claimed, but the four post-fixes can subsequently move it (consistent with the next claim).
5. *Claim:* Four ordered post-fixes with gates and log tags.
   *Correction:* All four verified exactly, plus the no-kick fix has additional requirements not stated in the claim (≥8 beats and ≥4 positive slopes with a 50%-of-median threshold); lines stale +13.
6. *Claim:* `?onsetgrid` per-beat re-anchor details (ONSET_FRAC=0.15, amplitude-space gate, proof log).
   *Correction:* Substance fully verified; walk-back retreat is capped at 45 ms; worker citations stale +13, jsx +5.
7. *Claim:* `beatPhaseFrac` is an unwrapped beat index — "a naming hazard that already caused the pulled ?gridsnap feature to mis-snap."
   *Correction:* Core facts verified, but the causal attribution is overstated: the recorded ?gridsnap pull cause was the remote-seek re-snap feedback loop (walked synced position tens of seconds off); the beat-index gotcha is flagged in code as a caution for the future revisit, not the documented root cause of the pull.
8. *Claim:* Grid precedence analyzer → Rekordbox → user edit; USE_RB_GRID compile-time; Rekordbox tracks skip onset re-anchor and de-smear.
   *Correction:* Substance fully verified; all jsx citations stale +5.
9. *Claim:* rekordbox-grid.js is 35 lines of pure math with the stated return shape and the per-deck override paths.
   *Correction:* Verified exactly (also returns null for no-valid-anchors/duration, anchors sorted and clamped ≥0); jsx citations stale +5.
10. *Claim:* Under `?beatsv2`, THREE consumers (seek-quantize, engage, zoomed-WF grid markers) read the same refined beatTimes through the two shared helpers; duplicated in `tools/smoke/engage_align.smoke.mjs`.
    *Correction (three-part):* (a) The zoomed-WF grid markers do NOT read refined beatTimes under default flags — that branch is gated `!WF_GRID_UNIFORM && beatsV2` and WF_GRID_UNIFORM defaults ON, so grid LINES render the uniform snapped grid by default; only seek-quantize + engage consume refined kicks. (b) The grid-marker code doesn't call the shared helpers — it binary-searches inline; only seek-quantize (nearestBeatTime) and engage (refinedBeatPhase) use them. (c) The duplicate file is `tools/smoke/tests/engage.smoke.mjs` — `engage_align.smoke.mjs` does not exist (the src comment cites the stale path). Helpers verified byte-for-byte identical; engage iteration/convergence details verified.
11. *Claim:* Analyzer result broadcast "exactly once per analysis" as beatTimes/beatAttacks arrays "plus the five scalar grid fields and bpm."
    *Correction (two-part):* (a) It's FOUR scalar grid fields (beatPhaseSec, beatPeriodSec, beatPhaseFrac, firstBar1AnchorSec) plus bpm — five scalars total *including* bpm. (b) "Exactly once per analysis" holds for the completion effect, but the broadcast closure is deliberately stored so the partner-(re)join handler can RE-FIRE it for rejoiners/late-joiners — once per analysis plus once per partner rejoin.
12. *Claim:* Post-analysis auto-position to firstBar1AnchorSec with stale-result guards at dispatch.
    *Correction:* Substance fully verified (bail order, adjustedAnchor + bar-1 offset, in-bounds check); citations stale +5.

**Sync engine (2):**

1. *Claim:* "Every outbound WebSocket message automatically carries t_send."
   *Correction:* Overstated. useSync's `send()` helper does inject t_send and both consumers (drift monitor, mirror follower) are real — but two messages bypass `send()`: the initial join handshake (raw `w.send`, NO t_send) and the reconnect sync_request (adds t_send manually). Accurate statement: every message routed through the send() helper carries t_send; the join handshake does not.
2. *Claim:* Outbound deck_update broadcasts are driver-gated by djId; "only mixer control fields bypass the gate."
   *Correction:* The gate is exactly as described but only covers the `dh()` deck-field path. Several parent-level deck_update sends bypass dh and carry non-shared fields with NO driver gate: rate from syncDecks, masterDeck, syncLocked/syncArmed mirrors. So "only mixer control fields bypass the gate" is wrong — sync-metadata broadcasts bypass it too, by living outside dh().

**WebRTC audio (1):**

1. *Claim:* "Silent inbound (jitterBufferEmittedCount not growing) sets noFrames and HOLDS the last compMs."
   *Correction:* Trust gating confirmed (HEALTH_MIN=4; big-drop needs 7, with an extra lastGood>5 condition), but the noFrames attribution is wrong: `noFrames:true` is set when the inbound report is ABSENT or jitterBufferEmittedCount is 0 (never emitted) or no live receiver exists. Since jitterBufferEmittedCount is a lifetime counter, a stream that flowed and then stalls does NOT set noFrames — it hits the not-flowing/discontinuity branch, which re-baselines and holds last compMs with `noFrames:false`. Both paths hold rather than write 0, so the behavioral outcome described is right; the trigger for the flag is not.

### 4.3 Refuted claims

**One (mirror render).** Zero of the original 50 four-subsystem claims were refuted; the mirror-render pass (July 2, 2026) refuted one:

1. *Claim (mirror render):* "onProgUpdate mirrors each deck's displayed position into progRefA/B, which the sync-engage machinery reads — mirror-phase stability is a stated dependency of sync idempotency."
   *Refutation:* The `onProgUpdate → progRefA/B` wiring is real, but engage's `stableProg` helper (jsx L10925–10953) deliberately reads the **stable last-received packet anchor** for a partner-driven (mirror) deck — explicitly NOT the follower's smoothed display, whose creep/clamp wobble tipped the nearest-beat pick across a beat boundary and broke re-engage idempotency (±100 ms). `progRefA/B` is read only for a *locally*-driven deck (which has no follower). Mirror-phase stability was therefore engineered to be a **non**-dependency; the follower's own comments (jsx L6707–6708, L6849–6850) still assert the opposite and are stale (risk #38).

Across all five subsystems: 62 verified claims, 1 refuted, 17 amended. The maps were accurate in substance, with errors concentrated in stale line numbers and overstated universals — "every message", "exactly once", "three consumers", and here "sync engage reads the mirror phase" — rather than in architecture.

### 4.4 Mirror render — verification pass (gap closed)

**Status: closed (July 2, 2026).** The mirror-render subsystem — the single gap in the original dataset — has now been independently mapped, adversarially verified against source, and risk-assessed. §2.5 is a verified section on par with §2.1–2.4; rows 36–40 in §3 are its risk contribution (1 High, 4 Medium).

Twelve claims were checked: **10 confirmed, 1 amended, 1 refuted.**

- *Amended (1):* the "known gate mismatch." The hidden-tab visibilitychange re-anchor is not merely *suspected* dead code — both `<Deck>` instances render with `local` (= `local={true}`) (jsx L11985, L12098), so the effect's `if(local) return` guard (jsx L6895) is unconditionally true and the re-anchor **never runs** — a confirmed dead path, not a subtle per-deck mismatch. It is the leading unmitigated cause of the PARKED waveform-fps-freeze (risk #36).
- *Refuted (1):* the data-flow claim that sync engage reads the mirror follower's displayed position (mirror-phase stability as a sync-idempotency dependency). Engage's `stableProg` (jsx L10925–10953) reads the stable packet anchor for a partner-driven deck instead; the dependency runs the opposite way to the claim. Full detail in §4.3.

No further gaps remain in this document's coverage.

---

*Document assembled July 1, 2026 from the verified subsystem audit dataset. Source of truth for locked visual values: `tools/docs/WAVEFORM_LOCKED.md`. Doc map: `tools/docs/MASTER_INDEX.md`.*
