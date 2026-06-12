// rekordbox-grid.smoke.mjs — the rekordbox.xml TEMPO→beatTimes math (Door 3).
// Pure unit test of beatTimesFromAnchors: single-anchor builds anchor+k·period;
// multi-anchor builds piecewise (tempo changes); the result is monotonic and
// in-range. The DOM parsing + full import is covered by the e2e import test.
import { Suite } from "../lib/result.mjs";
import { beatTimesFromAnchors } from "../../../src/rekordbox-grid.js";

const t = new Suite("rekordbox-grid");

// ── Single tempo: 120 BPM from 0.025s over a 12s track → 0.5s spacing.
const single = beatTimesFromAnchors([{ inizio: 0.025, bpm: 120 }], 12);
t.check("single-anchor builds beats", !!single && single.beatTimes.length >= 20, `${single?.beatTimes.length} beats`);
t.check("single-anchor anchor + period correct", single && Math.abs(single.beatTimes[0] - 0.025) < 1e-3 && Math.abs(single.beatTimes[1] - single.beatTimes[0] - 0.5) < 1e-3, `first=${single?.beatTimes[0]} step=${(single?.beatTimes[1] - single?.beatTimes[0]).toFixed(3)}`);
t.check("single-anchor flagged single-tempo", single && single.multiTempo === false, `multiTempo=${single?.multiTempo}`);

// ── Multi tempo: 120 BPM for [0,4), then 140 BPM for [4,8) on an 8s track.
const multi = beatTimesFromAnchors([{ inizio: 0, bpm: 120 }, { inizio: 4, bpm: 140 }], 8);
t.check("multi-anchor builds beats", !!multi && multi.beatTimes.length > 2, `${multi?.beatTimes.length} beats`);
t.check("multi-anchor flagged multi-tempo", multi && multi.multiTempo === true, `multiTempo=${multi?.multiTempo}`);
// Spacing before the change ≈ 0.5s (120), after ≈ 0.4286s (140).
const beforeChange = multi.beatTimes.filter((b) => b < 4);
const afterChange = multi.beatTimes.filter((b) => b >= 4);
const spBefore = beforeChange[1] - beforeChange[0];
const spAfter = afterChange.length > 1 ? afterChange[1] - afterChange[0] : NaN;
t.check("multi-anchor: 120 BPM segment spacing ≈ 0.5s", Math.abs(spBefore - 0.5) < 1e-2, `${spBefore?.toFixed(3)}s`);
t.check("multi-anchor: 140 BPM segment spacing ≈ 0.429s", Math.abs(spAfter - 60 / 140) < 1e-2, `${spAfter?.toFixed(3)}s`);

// ── Monotonic + in range.
const mono = multi.beatTimes.every((b, i) => i === 0 || b > multi.beatTimes[i - 1]);
const inRange = multi.beatTimes.every((b) => b >= 0 && b <= 8);
t.check("beats are monotonic increasing", mono, "");
t.check("beats within [0, duration]", inRange, "");

// ── Degenerate inputs return null (fall back to analyzer).
t.check("no anchors → null", beatTimesFromAnchors([], 12) === null, "");
t.check("no duration → null", beatTimesFromAnchors([{ inizio: 0, bpm: 120 }], 0) === null, "");

t.done();
