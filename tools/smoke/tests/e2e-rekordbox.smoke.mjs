// e2e-rekordbox.smoke.mjs — Library Door 3 end-to-end, two surfaces:
//
//   PART A (library page): parse the bundled rekordbox-sample.xml through the
//   REAL library-app parser (window.__parseRekordboxXML). Asserts 3 tracks, 2
//   playlists with intact membership, a single-tempo grid (anchor + 0.5s step),
//   a multi-tempo piecewise grid (120→140 spacing change), and hot/memory cues.
//
//   PART B (mixer page): load an imported-grid track (gridSource:'rekordbox')
//   onto a deck via the __loadTestTrack override and prove the HARD requirement —
//   the imported beatTimes flow through the SAME unified bpm.results path the
//   analyzer uses, the de-smear gate is OFF for it, analyzer onset-anchoring is
//   SKIPPED (analyzed:true → no analysis pass), and engage is idempotent (<10ms)
//   on the imported grid.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Suite } from "../lib/result.mjs";
import { launch, capture, createRoom, loadTestTrack, FIXTURE_URL } from "../lib/e2e.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET = (process.env.TARGET || "http://localhost:5173/").replace(/\/$/, "/");
const BASE = TARGET.replace(/\/$/, "");
const XML = readFileSync(resolve(__dirname, "../fixtures/rekordbox-sample.xml"), "utf8");

const t = new Suite("e2e-rekordbox");
const browser = await launch();
if (!browser) t.skip("no system Chrome — e2e unavailable here");

const phaseSeekMs = (line) => { const m = (line || "").match(/phaseSeekMs=([\-\d.]+)/); return m ? parseFloat(m[1]) : null; };

try {
  // ── PART A: parse on the real library page ────────────────────────────────
  const ctxL = await browser.newContext(); const L = await ctxL.newPage(); const sL = capture(L);
  await L.goto(`${BASE}/library.html?smoke=1`, { waitUntil: "domcontentloaded" });
  await L.waitForFunction(() => typeof window.__parseRekordboxXML === "function", null, { timeout: 12000 });
  const parsed = await L.evaluate((xml) => window.__parseRekordboxXML(xml), XML);

  t.check("parsed 3 tracks", parsed.tracks.length === 3, `${parsed.tracks.length} tracks`);
  t.check("parsed 2 playlists", parsed.playlists.length === 2, parsed.playlists.map((p) => p.name).join(", "));

  const warmup = parsed.playlists.find((p) => /Warmup/.test(p.name));
  const peak = parsed.playlists.find((p) => /Peak/.test(p.name));
  t.check("Warmup playlist holds its 2 tracks (rb_101, rb_103)",
    !!warmup && warmup.trackIds.length === 2 && warmup.trackIds.includes("rb_101") && warmup.trackIds.includes("rb_103"),
    warmup ? warmup.trackIds.join(",") : "missing");
  t.check("Peak playlist holds rb_102",
    !!peak && peak.trackIds.length === 1 && peak.trackIds[0] === "rb_102", peak ? peak.trackIds.join(",") : "missing");

  const single = parsed.tracks.find((x) => x.rbTrackId === "101");
  t.check("single-tempo track tagged gridSource=rekordbox", single?.gridSource === "rekordbox", `gridSource=${single?.gridSource}`);
  t.check("single-tempo grid anchored at 0.025 with 0.5s step",
    single && Math.abs(single.beatTimes[0] - 0.025) < 1e-3 && Math.abs(single.beatTimes[1] - single.beatTimes[0] - 0.5) < 1e-3,
    `first=${single?.beatTimes?.[0]} step=${single ? (single.beatTimes[1] - single.beatTimes[0]).toFixed(3) : "?"}`);
  t.check("single-tempo imported hot cues (Num 0,1) + memory cue (Num -1)",
    single?.hotCues?.length === 2 && single?.memoryCues?.length === 1,
    `hot=${single?.hotCues?.length} mem=${single?.memoryCues?.length}`);

  const multi = parsed.tracks.find((x) => x.rbTrackId === "102");
  const before = (multi?.beatTimes || []).filter((b) => b < 4);
  const after = (multi?.beatTimes || []).filter((b) => b >= 4);
  const spB = before.length > 1 ? before[1] - before[0] : NaN;
  const spA = after.length > 1 ? after[1] - after[0] : NaN;
  t.check("multi-tempo track is piecewise (120→140 spacing change)",
    multi?.gridSource === "rekordbox" && Math.abs(spB - 0.5) < 1e-2 && Math.abs(spA - 60 / 140) < 1e-2,
    `before=${spB?.toFixed(3)}s after=${spA?.toFixed(3)}s`);
  await ctxL.close();

  // ── PART B: mixer consumes the imported grid through the unified path ──────
  const ctxA = await browser.newContext(); const A = await ctxA.newPage(); const sA = capture(A);
  // ?libwizard=1 — Door 3 lives behind that flag (and keeps smoke hooks on in dev).
  await A.goto(`${BASE}/?libwizard=1`, { waitUntil: "domcontentloaded" });
  await createRoom(A);
  await A.waitForTimeout(1200);

  // Imported-grid track for deck A: SAME audio as the analyzer fixture (so it
  // plays + engages), but the grid arrives pre-baked as if from rekordbox.xml.
  // 120 BPM, beats every 0.5s from 0.025 across the 12s fixture → 24 beats.
  const beatTimes = Array.from({ length: 24 }, (_, i) => +(0.025 + i * 0.5).toFixed(4));
  const imported = {
    analyzed: true, gridSource: "rekordbox", bpm: 120,
    beatTimes, beatPeriodSec: 0.5, gridAnchorSec: 0.025, firstBar1AnchorSec: 0.025,
    hotCues: [{ time: 0.025, num: 0 }, { time: 6.0, num: 1 }],
    memoryCues: [{ time: 3.0, num: -1 }],
  };
  await loadTestTrack(A, "A", FIXTURE_URL, imported);
  await loadTestTrack(A, "B"); // analyzer fixture on B (normal path) as the engage partner
  await sA.waitFor("[REKORDBOX-A] imported xml grid", 8000).catch(() => {});
  await sA.waitFor("[BPM] analysis complete for deck B", 15000);
  await A.waitForTimeout(600);

  const gridA = await A.evaluate(() => window.__deckGrid("A"));
  t.check("deck A consumes the imported grid (gridSource=rekordbox)", gridA?.gridSource === "rekordbox", `gridSource=${gridA?.gridSource}`);
  t.check("imported beatTimes flow through bpm.results (24 beats, first 0.025)",
    gridA?.beatCount === 24 && Math.abs((gridA?.firstBeatSec ?? -1) - 0.025) < 1e-3,
    `beats=${gridA?.beatCount} first=${gridA?.firstBeatSec}`);
  t.check("de-smear gate OFF for the imported grid", gridA?.desmearOn === false, `desmearOn=${gridA?.desmearOn}`);
  // Onset re-anchoring is gated off for the imported deck (onsetAnchor=false in
  // the dispatch), while a normal analyzer deck (B) still onset-anchors. The
  // analyzer itself still runs on A so its beatAttacks can feed the B2B broadcast.
  const dispatchA = sA.last("[ONSET-GRID] deck A analysis dispatch") || "";
  const dispatchB = sA.last("[ONSET-GRID] deck B analysis dispatch") || "";
  t.check("onset-anchor SKIPPED on the imported deck (onsetAnchor=false)", /onsetAnchor=false/.test(dispatchA), dispatchA.slice(-40) || "no dispatch");
  t.check("onset-anchor ACTIVE on the normal analyzer deck (sanity)", /onsetAnchor=true/.test(dispatchB), dispatchB.slice(-40) || "no dispatch");

  // Engage on the imported-grid deck: prove the unified nearest-beat path runs +
  // is idempotent. Play both, engage A, then re-engage from the aligned state.
  await A.evaluate(() => window.__toggleDeck("B")); // master first
  await A.waitForTimeout(300);
  await A.evaluate(() => window.__toggleDeck("A")); // imported-grid slave
  await A.waitForTimeout(2200);

  const i0 = sA.all("[SYNC-ENGAGE-QUALITY]").length;
  await A.evaluate(() => window.__syncDeck("A"));
  await sA.waitFor("[SYNC-ENGAGE-QUALITY]", 6000);
  await A.waitForTimeout(700);
  const q1 = sA.all("[SYNC-ENGAGE-QUALITY]")[i0] || sA.last("[SYNC-ENGAGE-QUALITY]");
  t.check("engage on imported grid succeeds (result=ok)", /result=ok/.test(q1 || ""),
    (q1 || "").replace(/.*\[SYNC-ENGAGE-QUALITY\]/, "").slice(0, 70));

  await A.evaluate(() => window.__syncDeck("A")); // off
  await A.waitForTimeout(600);
  const i1 = sA.all("[SYNC-ENGAGE-QUALITY]").length;
  await A.evaluate(() => window.__syncDeck("A")); // re-engage
  await sA.waitFor("[SYNC-ENGAGE-QUALITY]", 6000);
  await A.waitForTimeout(500);
  const q2 = sA.all("[SYNC-ENGAGE-QUALITY]")[i1] || sA.last("[SYNC-ENGAGE-QUALITY]");
  const seek2 = phaseSeekMs(q2);
  // Single client (no network jitter) → re-engage on the imported grid should
  // land <10ms, the unification idempotency target.
  t.check("re-engage on imported grid idempotent (|phaseSeek| < 10ms)",
    seek2 != null && Math.abs(seek2) < 10, `re-engage phaseSeekMs=${seek2}`);

  t.check("no page errors", sA.errors().length === 0 && sL.errors().length === 0,
    [...sA.errors(), ...sL.errors()].slice(0, 2).join(" | ") || "clean");
} catch (e) {
  t.check("no exceptions during run", false, e.message);
} finally {
  await browser.close();
}
t.done();
