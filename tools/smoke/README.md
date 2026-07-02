# Mix//Sync smoke suite

The permanent regression net. One command runs every check — pure-logic sims,
real-analyzer audio tests, and two-client browser tests — with per-test
PASS/FAIL/SKIP and a CI exit code.

```bash
npm run smoke          # everything available
npm run smoke:unit     # unit + audio only (no browser, ~1s)
npm run smoke:e2e      # two-client browser tests only
node tools/smoke/run.mjs --list          # list tests + what each gates
TARGET=https://collabmix.vercel.app npm run smoke:e2e   # run e2e against a deploy
```

Exit `0` = every test that ran passed. Non-zero = ≥1 FAIL. **SKIP never fails the
run** — a test skips when its deps are missing (no system Chrome, no dev server,
no audio), which is an environment gap, not a regression.

## What each test gates

| Test | Kind | Gates |
|---|---|---|
| `engage`         | unit  | SYNC engage <10ms + repeat-engage idempotent (no wander) |
| `interp`         | unit  | non-driver playhead has no backward sawtooth at off-1.0 rates |
| `comp-rebaseline`| unit  | delay-comp re-converges after a transport interruption |
| `onset-anchor`   | audio | refined beatTimes sit on the kick onset (<4ms) — runs the real analyzer worker |
| `desmear`        | audio | the drawn kick leading edge lands on the onset (de-smear closes the gap) |
| `e2e-entry`      | e2e   | two clients join one room (by code + paste-URL); distinct djIds; both paired |
| `e2e-track-mirror`| e2e  | driver load → partner mirrors title/BPM/waveform/beatTimes (counts match) |
| `e2e-transport`  | e2e   | play/pause both directions; non-driver seek SEND→RECV→EXEC round-trip |
| `e2e-sync`       | e2e   | engage end-to-end; re-engage idempotent (the wander regression) |
| `e2e-comp`       | e2e   | delaycomp measures nonzero on live audio; survives a partner reload |
| `e2e-drift`      | e2e   | `[SYNC-DRIFT]` emits during a locked remote B2B |

## How it works

- **Runner** (`run.mjs`) — registry of tests; spawns each as a child process and
  reads its exit code (`0`/`1`/`2`). For e2e it ensures the audio fixture exists
  and starts a vite dev server if one isn't already up (skips spawning if you set
  a remote `TARGET`), then tears it down.
- **Fixture** (`lib/gen-fixture.mjs`) — a deterministic synthetic 120 BPM kick
  loop, generated at setup (gitignored — no binary in the repo). The analyzer
  detects it at 100% confidence; played through WebRTC it gives the comp test a
  real live stream to measure (the old seeds had only a silent master).
- **Load hook** — the app exposes `window.__loadTestTrack(deck, url)` plus
  `__toggleDeck/__seekDeck/__cueDeck/__syncDeck` behind `TEST_HOOKS` (dev server
  or `?smoke=1`; absent for production users). The hook runs a fixture through
  the **real** load path (decode → analysis → broadcast → driver-send), so e2e
  exercises real behavior, not a bypass.
- **e2e helpers** (`lib/e2e.mjs`) — playwright-core over system Chrome; lobby /
  create / join, console capture with `waitFor`, partner + djId readers.

Requirements for e2e: Google Chrome installed (`channel: "chrome"`). Without it,
the e2e tests SKIP. Unit + audio tests need only Node.

## Adding a test

1. Create `tests/<name>.smoke.mjs`. Use the result helper:
   ```js
   import { Suite } from "../lib/result.mjs";
   const t = new Suite("my-test");
   t.check("the thing holds", value < bound, `value=${value}`);
   t.done();                 // exits 0 if all checks pass, else 1
   // t.skip("reason")        // exit 2 when a dep is missing
   ```
   e2e tests: `const b = await launch(); if (!b) t.skip("no Chrome");` and read
   `TARGET` for the app URL.
2. Register it in the `TESTS` array in `run.mjs` (`kind` + one-line `gates`).
3. Run `node tools/smoke/run.mjs --kind=<kind>` to verify.

Audio tests default to the fixture; set `SMOKE_TRACKS="a.mp3,b.mp3"` (files in
`tools/bpm-test-harness/tracks/`) to run the strict gates against real tracks.

## Local mock WS server + deterministic network conditions (`--mock`)

By default every e2e test connects to the **shared production** WS relay, which
during tests runs on a clean fast network — so latency, jitter, packet loss and
reordering never happen and the partner mirror always looks perfect (~4ms). The
mirror / stale-position bug class (backward slews, rapid-toggle snaps, near-end
self-pause, mirror-under-latency) lives in exactly those conditions, so the
default gate is structurally **blind** to it.

`tools/smoke/lib/mock-ws-server.mjs` is a protocol-exact local stand-in for the
production server (`../collabmix-server-repo/server.js` — keep the relay logic in
sync) with a **seeded** network-emulation layer.

```bash
npm run smoke                    # the mock is spawned BY DEFAULT (July 3) —
                                 # mock-aware tests (e2e-sync, mirror trio) route
                                 # through it; direct-goto tests still hit prod
npm run smoke:e2e -- --no-mock   # opt out (old behavior; e2e-sync back on prod)
node tools/smoke/lib/mock-ws-server.mjs 8090   # run the mock standalone (manual)
```

- The runner (`--mock`) spawns the mock and exports `MOCK_WS_URL`. Tests that use
  `gotoApp()` (instead of `page.goto(TARGET)`) route the app's sockets to it via a
  **`?wsurl=` override gated behind `TEST_HOOKS`** — inert for real users, so a
  crafted link can never redirect a production socket.
- **netem conditions** (live via `setNetem()` → `POST /netem`): `latencyMs`,
  `jitterMs` (± per message → reordering), `lossPct`, `seed`, and `types[]` (limit
  conditions to specific message types, e.g. `["deck_update"]` to make only the
  progress stream sparse while join/driver/transport stay crisp). **Same
  `(seed, profile, message-sequence)` reproduces the run exactly** — no
  `Math.random` on the path. `GET /netem` returns current conditions.
- **Scope:** netem shapes the WS **control plane** only. Audio is P2P WebRTC
  (browser-managed) and is unaffected — the comp/jitter-buffer tests don't change.
  The mirror bugs ride the `deck_update` progress packets, which the mock controls.
- **Rollout (incremental):** existing tests still hit production; mock-based tests
  opt in. `e2e-mirror-latency` is the first. Flipping the whole suite onto the
  mock (load-independent, deterministic gate) is the deliberate next step.

### xfail — repro tests that drive a fix

A test registered with `xfail: true` in the `TESTS` array documents a **known bug**:
it asserts the *post-fix* property and is **expected to fail** until the fix lands.

- A failing xfail test reports 🟡 **XFAIL** and **does not fail the suite** (it is a
  known bug, not a regression).
- When the fix makes it pass, it reports 🎯 **XPASS** — the signal to remove the
  `xfail` flag and promote it to a normal hard gate.

`e2e-mirror-slew` is the first: it deterministically reproduces the dogfood
**backward slew** (driver pitched down + blacked-out progress packets → the mirror
coasts at a stale fast rate, overshoots, then eases backward ~0.8s — Jake's
−0.5/−1.53s). Move #2 (the mirror coast/snap refactor) is verified by driving this
test from XFAIL → XPASS.

## Notes / quarantine log

- `e2e-sync` idempotency bound is **30ms** (not the unit test's exact <0.5ms):
  the master phase comes from 10Hz partner progress packets, so a live 2-client
  re-engage jitters a few ms. 30ms still catches the wander regression (which was
  ~a full beat, 250–500ms). The exact math is proven by the unit `engage` test.
- `e2e-comp` runs ~45s (WebRTC connect + jitter-buffer fill + measurement + a
  partner-reload recovery). It SKIPs if RTC never connects in the environment.
