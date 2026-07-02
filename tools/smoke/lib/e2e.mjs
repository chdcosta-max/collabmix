// e2e.mjs — shared two-client browser harness for the e2e smoke tests.
// Wraps playwright-core driving system Chrome. If Chrome/the target can't be
// reached, launch() returns null and the test SKIPs (not a failure).
//
// Console markers the app emits, used by the assertions:
//   [WS-JOINED] djId=…       — join + identity
//   [ANALYZER-BROADCAST] …   — driver→partner analyzer mirror
//   [SEEK-SEND]/[SEEK-RECV]/[SEEK-EXEC] — seek round-trip
//   [SYNC-COMP] measured=…   — delay comp
//   [SYNC-DRIFT] …           — locked-B2B drift telemetry
//   [ONSET-GRID] active …    — analysis participation
//   [SMOKE-HOOK] …           — the test load hook

import { chromium } from "playwright-core";

export const FIXTURE_URL = "/test-fixtures/kick120.wav";
export const FIXTURE_BPM = 120;

export async function launch() {
  try {
    return await chromium.launch({
      channel: "chrome",
      // HEADFUL=1 opens real windows — needed when a measurement depends on real
      // audio rendering energy (headless renders WebAudio silent on this rig).
      headless: process.env.HEADFUL === "1" ? false : true,
      args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--mute-audio"],
    });
  } catch (e) {
    return null; // no system Chrome → caller SKIPs
  }
}

// Console sink with query helpers.
export function capture(page, tag = "") {
  const lines = [];
  page.on("console", (m) => lines.push(m.text()));
  page.on("pageerror", (e) => lines.push("PAGEERROR: " + e.message));
  return {
    lines,
    has: (s) => lines.some((l) => l.includes(s)),
    last: (s) => [...lines].reverse().find((l) => l.includes(s)) || null,
    all: (s) => lines.filter((l) => l.includes(s)),
    errors: () => lines.filter((l) => l.startsWith("PAGEERROR:")),
    async waitFor(s, ms = 12000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (lines.some((l) => l.includes(s))) return true; await page.waitForTimeout(200); }
      return false;
    },
  };
}

// Build the app URL for goto(). When the runner started the mock WS server it
// sets MOCK_WS_URL; we then append ?wsurl=<mock> (honored only behind TEST_HOOKS,
// which the dev server / ?smoke=1 satisfy) so the app's sockets hit the local
// mock instead of production. ?smoke=1 is added so the override is honored against
// a built target too. Returns TARGET unchanged when no mock is configured.
export function appUrl(target = process.env.TARGET || "http://localhost:5173/") {
  const ws = process.env.MOCK_WS_URL;
  if (!ws) return target;
  const u = new URL(target);
  u.searchParams.set("wsurl", ws);
  u.searchParams.set("smoke", "1");
  return u.toString();
}

// Navigate to the app, routing through the mock WS server when one is configured.
export async function gotoApp(page, opts = {}) {
  await page.goto(appUrl(opts.target), { waitUntil: opts.waitUntil || "domcontentloaded" });
}

// True when the runner started the local mock WS server (so netem is available).
export const hasMock = () => !!process.env.MOCK_WS_URL;

// Set the mock's network conditions live (latencyMs, jitterMs, lossPct, seed,
// types[]). No-op + returns null when no mock is configured, so a test can guard
// with hasMock() and SKIP. Drives the mock's HTTP control endpoint (tests run as
// child processes; in-process netem isn't reachable from here).
export async function setNetem(conditions) {
  const ws = process.env.MOCK_WS_URL;
  if (!ws) return null;
  const httpUrl = ws.replace(/^ws/, "http") + "/netem";
  const res = await fetch(httpUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(conditions) });
  return res.json();
}
export const resetNetem = () => setNetem({ latencyMs: 0, jitterMs: 0, lossPct: 0, types: null });

export async function enterLobby(page) {
  await page.locator(".cta-btn").first().click();
  await page.getByText("START MIX", { exact: false }).first().waitFor({ timeout: 10000 });
}

export async function createRoom(page) {
  await enterLobby(page);
  await page.getByText("START MIX", { exact: false }).first().click();
  await page.waitForFunction(() => /[a-z]+-[a-z]+-\d{3}/.test(document.body.innerText), null, { timeout: 10000 });
  const code = await page.evaluate(() => (document.body.innerText.match(/[a-z]+-[a-z]+-\d{3}/) || [])[0]);
  return code;
}

export async function joinByCode(page, code, { paste = false, base = "" } = {}) {
  await enterLobby(page);
  const value = paste ? `${base}?room=${code}&mix=untitled+mix` : code;
  await page.getByPlaceholder("e.g., fade-wave-691").fill(value);
  await page.getByText("JOIN →", { exact: false }).first().click();
}

export const partnerOf = (page) =>
  page.evaluate(() => { const m = document.body.innerText.match(/⟺\s*([^\n]+)/); return m ? m[1].trim() : null; });

export const djIdOf = (sink) => {
  const l = sink.last("[WS-JOINED] djId="); if (!l) return null;
  const m = l.match(/djId=([^\s]+)/); return m ? m[1] : null;
};

// Wait until the test hook is installed (Mix view mounted), then load a fixture.
// `overrides` (optional) is merged onto the track record — used by the Door 3
// smoke to inject an imported-grid track (gridSource:'rekordbox', beatTimes,
// hotCues, analyzed:true).
export async function loadTestTrack(page, deck, url = FIXTURE_URL, overrides = null) {
  await page.waitForFunction(() => !!window.__smokeReady, null, { timeout: 12000 });
  return page.evaluate(async ([d, u, o]) => window.__loadTestTrack(d, u, o), [deck, url, overrides]);
}

// Click a control on a given deck by visible text (e.g. PLAY, SYNC). Deck panels
// are ordered A then B in the DOM; nth(0)=A, nth(1)=B.
export async function clickDeckButton(page, deck, text) {
  const idx = deck === "B" ? 1 : 0;
  await page.getByText(text, { exact: false }).nth(idx).click();
}
