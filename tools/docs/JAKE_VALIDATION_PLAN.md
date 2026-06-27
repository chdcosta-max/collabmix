# Jake Two-Machine Validation Plan — TWO categories, scored SEPARATELY

> **Core principle:** the dogfood issues come from **two distinct sources**. Validate
> both in the Jake session, but **evaluate them independently** — a failure in one is
> NOT attributed to the other, and **today's LOCAL fixes are NOT assumed to fix the
> NETWORK/audio category.** Nothing is "DONE" until Jake confirms its own category by
> ear/eye on real machines over the real network. Core sync + audio also get a
> **human-engineer review before launch/sale.**

---

## Category A — LOCAL logic (sync reliability + visual correctness)

These are **browser-local**: they'd misbehave even on one machine or a perfect network —
the root cause is local state/rendering, not the wire. They surface in a B2B session but
fixing the network won't fix them. **Goal: sync stays reliable and grids/tempos are
correct over a long, multi-track session.**

| Item | Flag (A/B) | Status | By-ear/eye test | Pass |
|---|---|---|---|---|
| Sync tempo precision (rate from full-precision tempo, not rounded BPM) | `?syncprecision=` (default ON, `=0` legacy) | SHIPPED | Two tracks at the SAME displayed BPM but different decimals → sync → 2-min blend | Kicks stay locked, no growing flam (vs `=0` which drifts) |
| Uniform beat grid (lines at snapped period) | `?griduniform=` (default ON, `=0` legacy) | SHIPPED | Synced decks, scan center→edges | Grids parallel edge-to-edge, sit on kicks (vs `=0` wobble) |
| Sync-state reliability (natural-BPM sticky session tempo + master freeze + clean reset + de-churn) | `?synctempo=1` (default OFF) | BUILT, smoke GREEN, shipped behind flag — **awaiting Desktop confirm, then Jake** | Load 4+ tracks, toggle sync on/off, play each; reassign master (M on B) | Sync does NOT degrade/fail by the 4th; master takes (LOCKED master=B); session period from natural (not contaminated); new tracks adopt it; full release resets clean |
| Paused-drag grid placement | (transport/seek) | **UNDER INVESTIGATION** | Paused drag-release; playing drag-release | Paused = stays exactly where released (no snap); playing = snaps cleanly to the grid line |

**Category-A pass:** over a long session with multiple track loads + sync toggles, sync
stays reliable — tempo locks, grids parallel, no 4th-track failure, manual grid placement
works. **Independent of audio quality.**

---

## Category B — REAL-NETWORK / audio (over the wire)

These only appear over the **actual internet** between two machines — jitter, dropouts,
audio wobble/pitch-stretch. The connection fixes target them. **Goal: partner audio is
clean over the real network for the session duration.**

| Item | Flag (A/B) | Status | By-ear test | Pass |
|---|---|---|---|---|
| TURN relay fallback + recoverable echo-guard | — | SHIPPED (a8538a8) | Connect from two networks; survive a brief drop | Connects/recovers without a full re-join |
| Visual-behind-audio coupling | `?gridcouple=` (default ON, `=0` legacy) | SHIPPED | Watch playhead vs audible beat | Playhead sits on the audible position |
| Prog framerate throttle | `?progthrottle=` (default ON, `=0` legacy) | SHIPPED | Watch waveform smoothness on a slower machine | Smooth (vs `=0` ~23fps) |
| Jitter-buffer target | `?jbtarget=220` (tune: 160/180/260) | SHIPPED | Partner audio over a long blend | No wobble/stretch/underrun; A/B the values by ear |

**Category-B pass:** partner audio is clean over the real network for the session.
**Known ceiling:** genuine packet loss (`lostΔ`) needs **Opus FEC/RED — a SEPARATE lever,
NOT yet built.** If dropouts persist under real packet loss, that's the **FEC ceiling, NOT
a failure of the shipped connection fixes** — log it as the FEC item, don't re-tune jbtarget.

---

## Keeping them distinct during the session

- Score **A** (sync reliability + visuals) and **B** (audio cleanliness) on **separate
  checklists**. Don't let a bad-audio session mask a sync win, or vice-versa.
- **If sync is unreliable → Category A** (local logic), even if the audio is also bad.
- **If audio glitches but sync is locked → Category B** (network / FEC ceiling), NOT a
  failure of today's local fixes.
- Record, per test: which **A/B flags** were set, and the relevant console logs —
  `[SYNC] / [SYNC-ENGAGE-QUALITY] / [SEEK-QUANTIZE]` for A, `[SYNC-COMP] / jbtarget` for B.

## Build gate before the session
- **A:** `syncprecision` + `griduniform` shipped. **Sync-state (#3) and paused-drag are
  NOT built yet** — each gets: empirical confirm → design walk-through → implement behind a
  flag → full `npm run smoke` → then into this plan.
- **B:** all connection fixes shipped, awaiting Jake.
- See VISION_5.md (June 26 entries) + memory `project_reconcile_contention` (B) and
  `project_sync_bpm_precision` (A).
