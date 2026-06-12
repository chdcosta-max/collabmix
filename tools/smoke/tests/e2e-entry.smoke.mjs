// e2e-entry.smoke.mjs — two clients join ONE room and pair. Covers join-by-code
// and the paste-full-invite-URL variant (Chad's historical bug). Asserts both
// sides see a partner, distinct djIds, and no page errors.
import { Suite } from "../lib/result.mjs";
import { launch, capture, createRoom, joinByCode, partnerOf, djIdOf } from "../lib/e2e.mjs";

const TARGET = process.env.TARGET || "http://localhost:5173/";
const t = new Suite("e2e-entry");
const browser = await launch();
if (!browser) t.skip("no system Chrome (channel=chrome) — e2e unavailable here");

async function pairUp(paste) {
  const ctxA = await browser.newContext(); const A = await ctxA.newPage(); const sA = capture(A);
  await A.goto(TARGET, { waitUntil: "domcontentloaded" });
  const code = await createRoom(A);
  await A.waitForTimeout(2000);                 // let WS settle + partner-detection window
  const ctxB = await browser.newContext(); const B = await ctxB.newPage(); const sB = capture(B);
  await B.goto(TARGET, { waitUntil: "domcontentloaded" });
  await joinByCode(B, code, { paste, base: TARGET });
  await A.waitForFunction(() => /⟺/.test(document.body.innerText), null, { timeout: 12000 }).catch(() => {});
  await B.waitForTimeout(3000);
  const out = { code, pa: await partnerOf(A), pb: await partnerOf(B), idA: djIdOf(sA), idB: djIdOf(sB), errs: [...sA.errors(), ...sB.errors()] };
  await ctxA.close(); await ctxB.close();
  return out;
}

try {
  const r1 = await pairUp(false);
  t.check("join-by-code: A sees a partner", !!r1.pa, `A⟺ ${r1.pa}`);
  t.check("join-by-code: B sees a partner", !!r1.pb, `B⟺ ${r1.pb}`);
  t.check("join-by-code: distinct djIds", !!(r1.idA && r1.idB && r1.idA !== r1.idB), `A=${r1.idA} B=${r1.idB}`);

  const r2 = await pairUp(true);
  t.check("paste-full-URL: both sides paired", !!(r2.pa && r2.pb), `A⟺ ${r2.pa} | B⟺ ${r2.pb}`);

  t.check("no page errors", r1.errs.length === 0 && r2.errs.length === 0, [...r1.errs, ...r2.errs].slice(0, 2).join(" | ") || "clean");
} catch (e) {
  t.check("no exceptions during run", false, e.message);
} finally {
  await browser.close();
}
t.done();
