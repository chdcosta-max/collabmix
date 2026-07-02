// audit-summary.mjs — ranked report from analyzer-audit.mjs NDJSON output.
// Deliverable per Chad's July 3 spec: (a) tempo-guard failures ranked (the
// 88-BPM class), (b) lowest phase-confidence = downbeat candidates, plus
// summary stats (% of library failing guards). Writes AUDIT_REPORT.md.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rows = readFileSync(resolve(__dirname, "out/audit-results.ndjson"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

const ok = rows.filter((r) => !r.error);
const errs = rows.filter((r) => r.error);
const pct = (a, b) => b ? ((100 * a) / b).toFixed(1) + "%" : "—";
const name = (r) => basename(r.file).replace(/\.[^.]+$/, "");

// (a) tempo-guard failures — the Jake-88.2 class. Severity = how far the raw
// period BPM sits from the integer it should have locked to.
const guardFail = ok.filter((r) => r.periodIntegerLocked === false || r.crossValidated === false)
  .sort((x, y) => (y.dIntBpm ?? 0) - (x.dIntBpm ?? 0));
// (b) phase-confidence ranking (downbeat candidates) — result confidence asc,
// spread/peak recorded alongside (both reported; neither over-interpreted).
const phaseRank = ok.filter((r) => r.confidence != null).sort((x, y) => x.confidence - y.confidence);

const L = [];
L.push(`# Analyzer Library Audit — ${new Date().toISOString().slice(0, 10)}`);
L.push("");
L.push(`Corpus: ${rows.length} tracks audited (${ok.length} analyzed, ${errs.length} decode/analysis errors).`);
L.push(`Roots: ~/Music/Music/Media.localized + ~/Music/rekordbox, deduped by filename. READ-ONLY.`);
L.push("");
L.push(`## Summary stats`);
L.push(`- Tempo-guard failures (periodIntegerLocked=false OR crossValidated=false): **${guardFail.length} = ${pct(guardFail.length, ok.length)}** of analyzed tracks`);
L.push(`- …of which BOTH guards failed: ${ok.filter((r) => r.periodIntegerLocked === false && r.crossValidated === false).length}`);
L.push(`- snapped=false (shipped a non-integer-locked grid): ${ok.filter((r) => r.snapped === false).length} = ${pct(ok.filter((r) => r.snapped === false).length, ok.length)}`);
L.push(`- firstBeatDpIdx > 8 (long unanchored intro — the melodic/soft-kick tell): ${ok.filter((r) => r.firstBeatDpIdx > 8).length}`);
L.push(`- |bpmFromPeriod − intBpm| > 1.0 (far from any integer, ratio-error suspects): ${ok.filter((r) => (r.dIntBpm ?? 0) > 1).length}`);
L.push("");
// ── honest interpretation: a guard failure is NOT the same as a wrong BPM ──
const both = ok.filter((r) => r.periodIntegerLocked === false && r.crossValidated === false);
const SHORT = 90; // sample/loop one-shots are seconds long; real tracks are minutes
const shortFail = both.filter((r) => (r.durSec ?? 999) < SHORT);
const realFail = both.filter((r) => (r.durSec ?? 999) >= SHORT);
const realFar = realFail.filter((r) => (r.dIntBpm ?? 0) >= 0.3);
const realNear = realFail.filter((r) => (r.dIntBpm ?? 9) < 0.3);
// bpmretry ratio-reachability heuristic (needs a live ac peak to actually resolve)
let reach = 0;
for (const r of realFar) { if (!r.bpmFromPeriod) continue;
  for (const ratio of [4 / 3, 3 / 2, 2]) { let h = r.bpmFromPeriod * ratio; while (h > 175) h /= 2; while (h < 100) h *= 2;
    if (Math.abs(h - Math.round(h)) < 0.15) { reach++; break; } } }
L.push(`## How to read this (guard failure ≠ wrong BPM)`);
L.push(`A tripped guard means the analyzer lacked strong evidence to SNAP the tempo to a whole number — not that the BPM is wrong. Three sub-cases:`);
L.push(`- **Genuinely fractional-BPM tracks** — non-snap is CORRECT; the grid is fine.`);
L.push(`- **Short sample/loop files** (< ${SHORT}s) — no stable track tempo to lock; expected, and not real DJ tracks. **${shortFail.length} of the ${both.length} double-guard failures are these.**`);
L.push(`- **Real tracks (≥ ${SHORT}s) that are genuinely uncertain** — the actionable set: **${realFar.length} tracks** with the period ≥0.3 BPM off an integer (${realNear.length} more real tracks fail a guard but sit basically on an integer → grid likely fine).`);
L.push(`- Of those ${realFar.length} genuinely-uncertain real tracks, **~${reach} are ratio-reachable** by ?bpmretry's ×4/3/×3/2/×2 hypotheses (heuristic — actual resolution needs a real autocorrelation peak at the hypothesis tempo, which the two tracks hand-tested July 3 did NOT have, so treat ~${reach} as an optimistic ceiling, not a promise).`);
L.push(`- **Bottom line:** the headline "46.6%" overstates the problem. The real remediation target is on the order of **${realFar.length} tracks (${pct(realFar.length, ok.length)} of the library)**, and ?bpmretry addresses at most a subset of those.`);
L.push("");
L.push(`## (a) Tempo-guard failures, ranked by |bpmFromPeriod − intBpm| (the 88-BPM class)`);
L.push(`*(NOTE: the top of this list is dominated by short sample/loop files — see durations — where non-snap is expected. Filter to ≥${SHORT}s durations for real tracks.)*`);
L.push(`| track | shipped bpm | bpmFromPeriod | dInt | intLock | crossVal | dpIdx | beats | dur |`);
L.push(`|---|---|---|---|---|---|---|---|---|`);
for (const r of guardFail.slice(0, 40))
  L.push(`| ${name(r)} | ${r.bpm} | ${r.bpmFromPeriod ?? "?"} | ${r.dIntBpm ?? "?"} | ${r.periodIntegerLocked} | ${r.crossValidated} | ${r.firstBeatDpIdx ?? "?"} | ${r.beats ?? "?"} | ${r.durSec ?? "?"}s |`);
if (guardFail.length > 40) L.push(`| …${guardFail.length - 40} more in the NDJSON | | | | | | | | |`);
L.push("");
L.push(`## (b) Lowest phase-confidence (downbeat candidates), bottom 25`);
L.push(`| track | confidence | spread/peak | bestPh | best16%4 | best32%4 | bpm |`);
L.push(`|---|---|---|---|---|---|---|`);
for (const r of phaseRank.slice(0, 25))
  L.push(`| ${name(r)} | ${r.confidence} | ${r.spreadPeak ?? "?"} | ${r.bestPh ?? "?"} | ${r.best16 ?? "?"} | ${r.best32 ?? "?"} | ${r.bpm} |`);
L.push("");
if (errs.length) {
  L.push(`## Decode/analysis errors (${errs.length})`);
  for (const r of errs.slice(0, 20)) L.push(`- ${name(r)} — ${r.error}`);
  if (errs.length > 20) L.push(`- …${errs.length - 20} more`);
}
const out = resolve(__dirname, "out/AUDIT_REPORT.md");
writeFileSync(out, L.join("\n") + "\n");
console.log(`report → ${out}`);
console.log(L.slice(0, 12).join("\n"));
