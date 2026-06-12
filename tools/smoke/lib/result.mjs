// result.mjs — tiny assertion/result helper shared by every smoke test.
// A test is a standalone process; its EXIT CODE is the contract the runner
// reads:  0 = PASS,  1 = FAIL,  2 = SKIP (deps unavailable, not a failure).
//
//   const t = new Suite("engage-align");
//   t.check("post-engage offset <10ms", offset < 10, `offset=${offset.toFixed(2)}ms`);
//   t.done();                       // prints summary, exits 0/1
//   t.skip("no dev server reachable");  // prints reason, exits 2

export class Suite {
  constructor(name) { this.name = name; this.checks = []; this.t0 = Date.now(); }
  check(label, cond, detail = "") {
    const ok = !!cond;
    this.checks.push({ label, ok, detail });
    console.log(`   ${ok ? "✓" : "✗"} ${label}${detail ? "  — " + detail : ""}`);
    return ok;
  }
  skip(reason) {
    console.log(`   ⊘ SKIP ${this.name}: ${reason}`);
    process.exit(2);
  }
  fail(reason) {
    console.log(`   ✗ ${this.name}: ${reason}`);
    process.exit(1);
  }
  done() {
    const failed = this.checks.filter((c) => !c.ok);
    const ms = Date.now() - this.t0;
    if (!this.checks.length) { console.log(`   (no checks ran) — ${this.name}`); process.exit(1); }
    console.log(`   → ${this.name}: ${this.checks.length - failed.length}/${this.checks.length} checks, ${ms}ms ${failed.length ? "❌" : "✅"}`);
    process.exit(failed.length ? 1 : 0);
  }
}

// stats helpers reused across the audio/render tests
export const med = (xs) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
export const pct = (xs, p) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
