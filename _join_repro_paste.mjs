import { chromium } from 'playwright-core';
const URL = process.env.TARGET || 'http://localhost:5173/';
const cap = ['[JOIN-DIAG]', '[WS-JOINED]'];
const mk = () => ({ lines: [] });
function attach(page, sink){ page.on('console', m => { const t=m.text(); if(cap.some(w=>t.includes(w))) sink.lines.push(t); }); page.on('pageerror', e=>sink.lines.push('ERR:'+e.message)); }
const enterLobby = async p => { await p.locator('.cta-btn').first().click(); await p.getByText('START MIX',{exact:false}).first().waitFor({timeout:8000}); };
const partnerOf = p => p.evaluate(()=>{ const m=document.body.innerText.match(/⟺\s*([^\n]+)/); return m?m[1].trim():null; });

const browser = await chromium.launch({ channel:'chrome', headless:true });

async function createRoom() {
  const ctx = await browser.newContext(); const s = mk(); const p = await ctx.newPage(); attach(p,s);
  await p.goto(URL,{waitUntil:'domcontentloaded'}); await enterLobby(p);
  await p.getByText('START MIX',{exact:false}).first().click();
  await p.waitForFunction(()=>/[a-z]+-[a-z]+-\d{3}/.test(document.body.innerText),null,{timeout:8000});
  const code = await p.evaluate(()=>(document.body.innerText.match(/[a-z]+-[a-z]+-\d{3}/)||[])[0]);
  await p.waitForTimeout(2000);
  return { ctx, p, s, code };
}

// ── TEST 1: paste the FULL invite URL into the join field (Chad's exact bug) ──
const A = await createRoom();
const fullUrl = `${URL}?room=${A.code}&mix=untitled+mix`;
const ctxB = await browser.newContext(); const sB = mk(); const B = await ctxB.newPage(); attach(B,sB);
await B.goto(URL,{waitUntil:'domcontentloaded'}); await enterLobby(B);
await B.getByPlaceholder('e.g., fade-wave-691').fill(fullUrl);
await B.getByText('JOIN →',{exact:false}).first().click();
await B.waitForTimeout(4000);
const t1A = await partnerOf(A.p), t1B = await partnerOf(B);
const bSent = (sB.lines.find(l=>l.includes('send join'))||'');
console.log('===== TEST 1: paste FULL invite URL =====');
console.log('A room code        :', A.code);
console.log('B pasted           :', fullUrl);
console.log('B [JOIN-DIAG] sent :', bSent.replace(/.*roomId/,'roomId'));
console.log('A sees partner     :', t1A, '| B sees partner:', t1B);
console.log('RESULT             :', (t1A && t1B) ? 'PAIRED ✅' : 'SPLIT ❌');

// ── TEST 2: open the invite URL directly (its intended use) ──
const A2 = await createRoom();
const ctxC = await browser.newContext(); const sC = mk(); const C = await ctxC.newPage(); attach(C,sC);
await C.goto(`${URL}?room=${A2.code}&mix=untitled+mix`,{waitUntil:'domcontentloaded'});
await C.getByText('JOIN MIX →',{exact:false}).first().click();
await C.waitForTimeout(4000);
const t2A = await partnerOf(A2.p), t2C = await partnerOf(C);
console.log('\n===== TEST 2: open invite URL directly =====');
console.log('A2 room code   :', A2.code);
console.log('A2 sees partner:', t2A, '| C sees partner:', t2C);
console.log('RESULT         :', (t2A && t2C) ? 'PAIRED ✅' : 'SPLIT ❌');

const errs = [...sB.lines, ...sC.lines, ...A.s.lines, ...A2.s.lines].filter(l=>l.startsWith('ERR:'));
console.log('\nPage errors:', errs.length ? errs.join('\n') : 'none ✅');
await browser.close();
