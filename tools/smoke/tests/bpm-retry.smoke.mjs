// bpm-retry.smoke.mjs — gate for the ?bpmretry tempo-guard retry (July 3).
// Locks the SAFETY CONTRACT (the resolution-rate calibration is a corpus
// question — tools/audit — not a unit property):
//   1. flag OFF → payload BYTE-IDENTICAL in shape to the pre-retry worker:
//      no lowConfidence / bpmRetried / bpmRetryRatio keys leak.
//   2. flag ON + clean track (guards pass) → NO retry attempted; result
//      values identical to flag-off; lowConfidence=false.
//   3. flag ON never CHANGES a result without validation — on the fixture the
//      guards pass so retried must be false.
// Runs the real worker on the deterministic 120 BPM fixture (audio kind).
import { Suite } from "../lib/result.mjs";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decode } from "../lib/audio.mjs";
import { WORKER_SRC } from "../../../src/bpm-worker-source.js";
import { ensureFixture } from "../lib/gen-fixture.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const t = new Suite("bpm-retry");
await ensureFixture();
const FX = resolve(__dirname, "../../../public/test-fixtures/kick120.wav");
if (!existsSync(FX)) t.skip("fixture missing");

const run = (cd, sr, extra) => {
  let cap = null; const logs = [];
  const self = { onmessage: null, postMessage: (r) => { cap = r; } };
  const ol = console.log; console.log = (...a) => logs.push(a.join(" "));
  try { new Function("self", WORKER_SRC)(self); self.onmessage({ data: { cd, sr, id: "t", onsetAnchor: true, ...extra } }); } // eslint-disable-line no-new-func
  finally { console.log = ol; }
  return { cap, logs };
};
const fx = await decode(FX);
const mk = () => fx.channelData.map((a) => Float32Array.from(a));

const off = run(mk(), fx.sr, {});
t.check("flag OFF: no retry keys leak into the payload",
  !("lowConfidence" in off.cap) && !("bpmRetried" in off.cap) && !("bpmRetryRatio" in off.cap),
  Object.keys(off.cap).join(","));
t.check("flag OFF: fixture analyzes 120 snapped", off.cap.bpm === 120 && off.cap.snapped === true, `bpm=${off.cap.bpm} snapped=${off.cap.snapped}`);

const on = run(mk(), fx.sr, { bpmRetry: true });
t.check("flag ON + clean track: no retry attempted", on.cap.bpmRetried === false && !on.logs.some((l) => l.includes("[BPM-RETRY]")), `retried=${on.cap.bpmRetried}`);
t.check("flag ON + clean track: lowConfidence=false", on.cap.lowConfidence === false, `lowConfidence=${on.cap.lowConfidence}`);
t.check("flag ON: bpm/period/beats identical to flag OFF",
  on.cap.bpm === off.cap.bpm && on.cap.beatPeriodSec === off.cap.beatPeriodSec && on.cap.beatTimes.length === off.cap.beatTimes.length,
  `bpm ${on.cap.bpm}/${off.cap.bpm} beats ${on.cap.beatTimes.length}/${off.cap.beatTimes.length}`);
t.check("flag ON: exactly three new keys",
  Object.keys(on.cap).filter((k) => !(k in off.cap)).sort().join(",") === "bpmRetried,bpmRetryRatio,lowConfidence",
  Object.keys(on.cap).filter((k) => !(k in off.cap)).join(","));

t.done();
