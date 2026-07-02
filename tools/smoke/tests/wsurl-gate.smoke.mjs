// wsurl-gate.smoke.mjs — permanent gate for the ?wsurl security fix
// (src/ws-url-gate.js, SECURITY_REVIEW_2026-07-03 Vuln 1). Pure logic, no
// browser. Locks three properties:
//   1. THE EXPLOIT STAYS DEAD — a production build given ?smoke=1&wsurl=<any
//      non-loopback host> must resolve to the default relay, never the
//      attacker's. Hostname is exact-matched, so lookalike hosts
//      (localhost.evil.com) and unparseable values also fall back.
//   2. THE SUITE'S WORKFLOW SURVIVES — prod build + ?smoke=1 + loopback wsurl
//      (the runner's mock relay, TARGET=<deploy> runs) still overrides.
//   3. DEV IS UNCHANGED — a dev build honors any ?wsurl (compile-time gate,
//      unreachable from a production link).
import { Suite } from "../lib/result.mjs";
import { resolveServerUrl, isLoopbackWsUrl } from "../../../src/ws-url-gate.js";

const t = new Suite("wsurl-gate");
const DEFAULT = "wss://collabmix-server-production.up.railway.app";
const prod = (smokeFlag, wsurl) =>
  resolveServerUrl({ dev: false, smokeFlag, wsurl, defaultUrl: DEFAULT });

// ── 1. the exploit class → default relay, always ─────────────────────────────
t.check("prod: crafted ?smoke=1&wsurl=wss://evil → default relay",
  prod(true, "wss://evil.example.com") === DEFAULT);
t.check("prod: lookalike host localhost.evil.com → default relay",
  prod(true, "ws://localhost.evil.com:8090") === DEFAULT);
t.check("prod: userinfo trick wss://localhost@evil.com → default relay",
  prod(true, "wss://localhost@evil.example.com") === DEFAULT);
t.check("prod: unparseable wsurl (no scheme) → default relay",
  prod(true, "localhost:8090") === DEFAULT);
t.check("prod: ?wsurl WITHOUT ?smoke → default relay (pre-fix behavior kept)",
  prod(false, "ws://localhost:8090") === DEFAULT);
t.check("prod: no flags → default relay",
  prod(false, undefined) === DEFAULT);

// ── 2. the smoke suite's legitimate path survives ────────────────────────────
t.check("prod+smoke: mock relay ws://localhost:<port> honored",
  prod(true, "ws://localhost:8090") === "ws://localhost:8090");
t.check("prod+smoke: ws://127.0.0.1:<port> honored",
  prod(true, "ws://127.0.0.1:8090") === "ws://127.0.0.1:8090");
t.check("prod+smoke: IPv6 loopback ws://[::1]:<port> honored",
  prod(true, "ws://[::1]:8090") === "ws://[::1]:8090");

// ── 3. dev build unchanged ───────────────────────────────────────────────────
t.check("dev: any ?wsurl honored (compile-time gate)",
  resolveServerUrl({ dev: true, smokeFlag: false, wsurl: "wss://anything.example.com", defaultUrl: DEFAULT })
    === "wss://anything.example.com");
t.check("dev: no ?wsurl → default relay",
  resolveServerUrl({ dev: true, smokeFlag: false, wsurl: undefined, defaultUrl: DEFAULT }) === DEFAULT);

// isLoopbackWsUrl sanity (the primitive the gate rests on)
t.check("isLoopbackWsUrl: localhost/127.0.0.1/[::1] true, evil false",
  isLoopbackWsUrl("ws://localhost:1") && isLoopbackWsUrl("ws://127.0.0.1:1") &&
  isLoopbackWsUrl("ws://[::1]:1") && !isLoopbackWsUrl("wss://evil.example.com"));

t.done();
