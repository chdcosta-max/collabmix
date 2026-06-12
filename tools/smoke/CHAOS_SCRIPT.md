# Manual chaos script — network/session survival

The headless suite (`e2e-chaos`, `e2e-reconnect`, `e2e-rejoin`, `e2e-trackend`)
covers what a browser can fake. These are the breaks a machine **can't** fake —
real radios, real sleep, real cables. Run them by hand on two laptops in one
room and fill in the **Actual** column. Watch the console for the confession
logs in the "Watch for" column.

Setup: two laptops, `collabmix.vercel.app/?delaycomp=1`, join one room, load a
track on each deck, start the stream, engage SYNC. Keep both consoles open.

| # | Break | Expected | Watch for | Actual |
|---|---|---|---|---|
| 1 | **Wi-Fi off ~10s on B, then on** | B reconnects, re-joins, partner + grid restored; A shows B drop then return | `[RECONNECT] phase=schedule` → `phase=success`; `[RTC-RECOVER]` if ICE dropped; `[REJOIN-REPLAY]` on A | |
| 2 | **Yank ethernet on B (hard drop), replug after 20s** | Same as #1 but harder; recovers within the 30s window or surfaces "disconnected" honestly | `[RECONNECT] phase=attempt` retries; `phase=gaveup` only if >30s | |
| 3 | **Sleep B's laptop ~2 min, wake** | On wake B re-dials immediately (not a dead session); audio + grid restore without a reload | `[RECONNECT] phase=wake`; `[RTC-RECOVER] phase=ice-failed/restart` | |
| 4 | **Server restart (Railway redeploy) mid-blend** | Both clients reconnect + re-join when the server returns; session resumes | both consoles `[RECONNECT] phase=success` | |
| 5 | **Switch B Wi-Fi → cellular hotspot mid-blend** | ICE restarts on the new path; audio recovers without reload | `[RTC-RECOVER] phase=ice-disconnected-timeout` → `restart` → `[RTC] ice state: connected` | |
| 6 | **Background B's tab 10+ min (timer throttling), then foreground** | On foreground, drift/comp resume, partner position re-tracks; no runaway or frozen state | `[RECONNECT] phase=wake` if socket died; drift/comp logs resume | |
| 7 | **Both DJs press SYNC + transport frantically during a drop** | No crash, no stuck "AUDIO: FAILED" that won't clear; controls live after | no uncaught errors; `[RTC] reconnect retries exhausted` only after 3 real tries | |
| 8 | **Track plays to the very end on one deck, idle 5 min, press play** | Plays from the start (no inert dead press) | `[PLAY-STATE] … parked-at-end → wrapping to start` | |

Honest expectations:
- A drop longer than **30s** intentionally gives up (`[RECONNECT] phase=gaveup`)
  and shows "disconnected" — rejoin by reload. A clean honest failure beats a
  zombie session.
- A reload always rebuilds the partner view (the rejoiner pulls full state); the
  rejoiner's OWN loaded track is not auto-restored — they re-drag it. (Ticket:
  persist+restore the local deck's track across reload.)
- ICE recovery depends on the network actually offering a usable path; a totally
  dead network can't renegotiate until it returns.

If a row's Actual diverges from Expected, paste the console block — the
`[RECONNECT]`/`[RTC-RECOVER]`/`[PLAY-STATE]` lines make failures self-describe.
