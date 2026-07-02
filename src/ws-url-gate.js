// ws-url-gate.js — decides the WS control-plane endpoint. Pure logic, no
// DOM/env reads — imported by both the app and the smoke suite's unit gate,
// following the conn-quality.js pattern.
//
// ?wsurl is a TEST-ONLY override. The old gate was `TEST_HOOKS && ?wsurl`,
// but TEST_HOOKS itself flips on ?smoke=1 — attacker-supplied in the URL — so
// `?smoke=1&wsurl=wss://evil` redirected a victim's entire control plane on
// one click (SECURITY_REVIEW_2026-07-03 Vuln 1: signaling MITM + PII).
//
// The fix keeps both legitimate workflows and closes the link exploit:
//   dev build            → any ?wsurl honored (local dev workflow, unreachable
//                          from a production link — DEV is compile-time false)
//   prod build + ?smoke=1 → ?wsurl honored ONLY for loopback hosts, which is
//                          all the suite ever needs (the smoke runner's mock
//                          relay is ws://localhost:<port>; TARGET=<deploy>
//                          runs keep working)
//   prod build, plain    → default relay, override inert
// A crafted wss://evil link fails the loopback test and falls back to the
// default relay — the victim's socket never leaves our infrastructure.

export function isLoopbackWsUrl(raw) {
  try {
    const h = new URL(raw).hostname; // exact-match the parsed hostname, never
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]"; // substring-test the raw string ("ws://localhost.evil.com" must fail)
  } catch {
    return false; // unparseable (e.g. missing scheme) → not loopback → default relay
  }
}

export function resolveServerUrl({ dev, smokeFlag, wsurl, defaultUrl }) {
  if (!wsurl) return defaultUrl;
  if (dev) return wsurl;
  if (smokeFlag && isLoopbackWsUrl(wsurl)) return wsurl;
  return defaultUrl;
}
