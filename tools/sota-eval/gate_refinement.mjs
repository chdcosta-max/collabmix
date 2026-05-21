// gate_refinement.mjs — reuses cluster_offset_data.json to test additional
// gate variants without re-running feature extraction. Specifically:
//   - normalized attackSlope (= slope / peakPower; amplitude-invariant)
//   - combinations of slope + other signals
//   - per-bucket median offset (not just one global +22.8ms)

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(resolve(__dirname, "cluster_offset_data.json"), "utf8"));
const tracks = data.tracks.filter(t => !t.error && t.peakPower != null);

const SUB_B_OFFSET = 22.8;
const TOL = 20;

// Compute normalized features per track
for (const t of tracks) {
  t.normSlope = t.peakPower > 0 ? t.attackSlope / t.peakPower : 0;
  t.kickIsEarly = t.anaMs < 100; // proxy for "near time 0" candidate
}

const subB = tracks.filter(t => t.isSubB);
const subBNormSlopes = subB.map(t => t.normSlope).sort((a, b) => a - b);
console.log("Sub-cause B normSlope distribution:");
for (const t of subB) console.log("  " + t.basename.slice(0, 42).padEnd(43) + " normSlope=" + t.normSlope.toExponential(2) + "  attackSlope=" + (t.attackSlope || 0).toExponential(2));

// Distribution stats for normSlope
const allNormSlopes = tracks.map(t => t.normSlope).filter(v => v > 0).sort((a, b) => a - b);
function pct(arr, p) { return arr[Math.floor(arr.length * p)]; }
console.log("\nnormSlope percentiles (all tracks):");
for (const p of [0.10, 0.25, 0.50, 0.75, 0.90]) console.log(`  p${(p * 100).toFixed(0)}: ${pct(allNormSlopes, p).toExponential(2)}`);
console.log("normSlope percentiles (sub-B):");
for (const p of [0.10, 0.25, 0.50, 0.75, 0.90]) console.log(`  p${(p * 100).toFixed(0)}: ${pct(subBNormSlopes, p).toExponential(2)}`);

function evalGate(name, predicate, offsetMs) {
  const sel = tracks.filter(predicate);
  let rescued = 0, regressed = 0;
  const r = [], reg = [];
  for (const t of sel) {
    const newDelta = t.deltaMs + offsetMs;
    const wasPass = Math.abs(t.deltaMs) <= TOL;
    const becomesPass = Math.abs(newDelta) <= TOL;
    if (!wasPass && becomesPass) { rescued++; if (r.length < 8) r.push(`${t.basename.slice(0, 40)} Δ ${t.deltaMs.toFixed(1)} → ${newDelta.toFixed(1)}`); }
    if (wasPass && !becomesPass) { regressed++; if (reg.length < 8) reg.push(`${t.basename.slice(0, 40)} Δ ${t.deltaMs.toFixed(1)} → ${newDelta.toFixed(1)}`); }
  }
  return { name, selected: sel.length, rescued, regressed, net: rescued - regressed, r, reg };
}

const gates = [];
for (const t of [1e-3, 2e-3, 3e-3, 5e-3, 1e-2, 2e-2]) {
  gates.push(evalGate(`normSlope ≤ ${t.toExponential(0)}`, x => x.normSlope <= t, SUB_B_OFFSET));
}
// Combine with first-kick-near-zero
for (const t of [2e-3, 5e-3, 1e-2]) {
  gates.push(evalGate(`normSlope ≤ ${t.toExponential(0)} AND anaBar1 < 250ms`,
    x => x.normSlope <= t && x.anaMs < 250, SUB_B_OFFSET));
}
// Combine with attackRampMs
for (const ns of [5e-3, 1e-2]) {
  for (const ar of [15, 25]) {
    gates.push(evalGate(`normSlope ≤ ${ns.toExponential(0)} AND attackRampMs ≤ ${ar}`,
      x => x.normSlope <= ns && (x.attackRampMs || 0) <= ar, SUB_B_OFFSET));
  }
}

console.log("\n=== Gate sweep ===");
console.log("Gate".padEnd(60) + " selected  rescued regressed  net");
console.log("-".repeat(94));
for (const g of gates) {
  console.log(g.name.padEnd(60) + " " + String(g.selected).padStart(8) + " " + String(g.rescued).padStart(8) + " " + String(g.regressed).padStart(9) + "  " + (g.net >= 0 ? "+" + g.net : g.net));
}

gates.sort((a, b) => b.net - a.net);
const best = gates[0];
console.log("\n=== Best ===");
console.log(best.name, `selected=${best.selected} rescued=${best.rescued} regressed=${best.regressed} net=${best.net}`);
console.log("Rescues:");
for (const x of best.r) console.log("  " + x);
console.log("Regressions:");
for (const x of best.reg) console.log("  " + x);

// Also: what would happen if we ONLY applied to currently-FAIL tracks?
// (just a thought experiment — production can't know status, but it bounds the upside)
const subB_fail = subB.filter(t => Math.abs(t.deltaMs) > TOL);
console.log(`\nSub-B tracks currently FAILING: ${subB_fail.length}/13`);
const subB_fixedByOffset = subB_fail.filter(t => Math.abs(t.deltaMs + SUB_B_OFFSET) <= TOL).length;
console.log(`  ...of which +22.8ms offset would fix: ${subB_fixedByOffset}/${subB_fail.length}`);
