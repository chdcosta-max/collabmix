import { chromium } from 'playwright-core';
const BASE = process.env.TARGET || 'http://localhost:5173/';
const Q = '?delaycomp=1&syncdebug=1';
const sA = { lines: [] };
const enterLobby = async p => { await p.locator('.cta-btn').first().click(); await p.getByText('START MIX',{exact:false}).first().waitFor({timeout:8000}); };
const hudMeas = p => p.evaluate(()=>{ const m=document.body.innerText.match(/comp meas\s+([\-\d.]+|—)/); return m?m[1]:null; });

const browser = await chromium.launch({ channel:'chrome', headless:true, args:['--autoplay-policy=no-user-gesture-required'] });

// A creates
const ctxA = await browser.newContext(); const A = await ctxA.newPage();
A.on('console', m=>{ const t=m.text(); if(t.includes('[SYNC-COMP]')||t.includes('[RTC] role')||t.includes('incoming track')) sA.lines.push(Date.now()+' '+t); });
await A.goto(BASE+Q,{waitUntil:'domcontentloaded'}); await enterLobby(A);
await A.getByText('START MIX',{exact:false}).first().click();
await A.waitForFunction(()=>/[a-z]+-[a-z]+-\d{3}/.test(document.body.innerText),null,{timeout:8000});
const code = await A.evaluate(()=>(document.body.innerText.match(/[a-z]+-[a-z]+-\d{3}/)||[])[0]);

// B joins
const ctxB = await browser.newContext(); const B = await ctxB.newPage();
await B.goto(BASE+Q,{waitUntil:'domcontentloaded'}); await enterLobby(B);
await B.getByPlaceholder('e.g., fade-wave-691').fill(code);
await B.getByText('JOIN →',{exact:false}).first().click();

console.log('A room:', code, '| waiting for first comp measurement…');
await B.waitForTimeout(14000);
const before = await hudMeas(A);
console.log('A comp meas BEFORE reneg:', before, 'ms');

// FORCE RENEGOTIATION: reload B (partner refresh) → A rebuilds its receiver
console.log('--- reloading B (partner refresh → A renegotiates) ---');
const tReload = Date.now();
sA.lines.push(tReload + ' [MARK] B reload');
await B.reload({ waitUntil:'domcontentloaded' });
await B.waitForTimeout(16000); // allow A to renegotiate + comp to recover

const after = await hudMeas(A);
console.log('A comp meas AFTER reneg:', after, 'ms');

const rebind = sA.lines.filter(l=>l.includes('rebind'));
const compLines = sA.lines.filter(l=>l.includes('[SYNC-COMP] measured'));
// recovery: first non-zero measured AFTER the reload mark
const afterReload = compLines.filter(l=>parseInt(l)>tReload);
const firstRecovered = afterReload.find(l=>{ const m=l.match(/measured=([\d.]+)/); return m && parseFloat(m[1])>5; });
console.log('\n==== RENEGOTIATION RESULT ====');
console.log('rebind events:', rebind.length, rebind.slice(-1)[0]?.replace(/.*\[SYNC-COMP\]/,'[SYNC-COMP]') || '');
console.log('A measured non-zero after reneg:', after && parseFloat(after) > 5 ? 'YES ✅' : 'NO ❌ (stuck '+after+')');
if (firstRecovered) {
  const dt = (parseInt(firstRecovered) - tReload)/1000;
  console.log('recovered within:', dt.toFixed(1)+'s', dt < 6 ? '✅' : '(slow)');
}
await browser.close();
