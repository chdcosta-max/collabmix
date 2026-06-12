// onset-anchor.smoke.mjs — onset-anchored beatTimes (?onsetgrid) must sit on the
// kick ONSET. Runs the REAL analyzer worker on the bundled fixture (or
// SMOKE_TRACKS for local real-track runs) and asserts median |beatTime−onset|.
// Gates: anchored median < 4ms; anchored beats earlier than legacy (re-anchor
// actually moved them).
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Suite, med } from "../lib/result.mjs";
import { decode, runWorker, kickEnvelope, envFloor, onsetOf } from "../lib/audio.mjs";
import { ensureFixture } from "../lib/gen-fixture.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKIP_BEATS = 4, N_KICKS = 24, TOL_MS = 4;
const t = new Suite("onset-anchor");

// Default: the bundled fixture (CI-safe). Override with SMOKE_TRACKS="a.mp3,b.mp3".
let tracks;
if (process.env.SMOKE_TRACKS) {
  const dir = resolve(__dirname, "../../bpm-test-harness/tracks");
  tracks = process.env.SMOKE_TRACKS.split(",").map((f) => resolve(dir, f.trim())).filter(existsSync);
  if (!tracks.length) t.skip("SMOKE_TRACKS set but no listed files found in bpm-test-harness/tracks");
} else {
  tracks = [ensureFixture()];
}

const anchoredErrs = [], legacyErrs = [];
for (const path of tracks) {
  const { sr, channelData, length, dur, mono } = await decode(path);
  const env = kickEnvelope(mono, sr), floor = envFloor(env);
  const measure = (beats) => {
    const errs = []; let used = 0;
    for (let k = SKIP_BEATS; k < beats.length && used < N_KICKS; k++) {
      const b = beats[k]; if (b < 0.2 || b > dur - 0.2) continue;
      const a = onsetOf(env, sr, b, floor); if (a == null) continue;
      errs.push((b - a) * 1000); used++;
    }
    return errs;
  };
  legacyErrs.push(...measure(runWorker(channelData, sr, "leg", false).beatTimes));
  anchoredErrs.push(...measure(runWorker(channelData, sr, "anc", true).beatTimes));
}
if (!anchoredErrs.length) t.fail("no reliable kicks measured");
const aMed = med(anchoredErrs.map(Math.abs)), lMed = med(legacyErrs.map(Math.abs));
t.check(`anchored median |beatTime−onset| < ${TOL_MS}ms`, aMed < TOL_MS, `anchored=${aMed.toFixed(2)}ms (n=${anchoredErrs.length})`);
t.check("anchoring moved beats toward the onset", aMed < lMed, `legacy=${lMed.toFixed(2)}ms → anchored=${aMed.toFixed(2)}ms`);
t.done();
