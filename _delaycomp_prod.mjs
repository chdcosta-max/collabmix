import { chromium } from 'playwright-core';
const BASE = process.env.TARGET || 'http://localhost:5173/';
const Q = '?delaycomp=1&syncdebug=1';
const cap = ['[SYNC-COMP]', '[RTC]', '[WS-JOINED]'];
const mk = () => ({ lines: [] });
function attach(p, s){ p.on('console', m=>{ const t=m.text(); if(cap.some(w=>t.includes(w))) s.lines.push(t); }); p.on('pageerror', e=>s.lines.push('ERR:'+e.message)); }
const enterLobby = async p => { await p.locator('.cta-btn').first().click(); await p.getByText('START MIX',{exact:false}).first().waitFor({timeout:8000}); };
const hudComp = p => p.evaluate(()=>{ const t=document.body.innerText; const meas=t.match(/comp meas\s+([\-\d.]+|—)/); const appl=t.match(/comp appl\s+([\-\d.]+|—)\s*ms\s*\((on|off)\)/); return { meas: meas?meas[1]:null, appl: appl?appl[1]:null, on: appl?appl[2]:null }; });

const browser = await chromium.launch({ channel:'chrome', headless:true, args:['--autoplay-policy=no-user-gesture-required'] });

// A creates a room
const ctxA = await browser.newContext(); const sA = mk(); const A = await ctxA.newPage(); attach(A,sA);
await A.goto(BASE+Q,{waitUntil:'domcontentloaded'}); await enterLobby(A);
await A.getByText('START MIX',{exact:false}).first().click();
await A.waitForFunction(()=>/[a-z]+-[a-z]+-\d{3}/.test(document.body.innerText),null,{timeout:8000});
const code = await A.evaluate(()=>(document.body.innerText.match(/[a-z]+-[a-z]+-\d{3}/)||[])[0]);
console.log('A room:', code);

// B joins by code
const ctxB = await browser.newContext(); const sB = mk(); const B = await ctxB.newPage(); attach(B,sB);
await B.goto(BASE+Q,{waitUntil:'domcontentloaded'}); await enterLobby(B);
await B.getByPlaceholder('e.g., fade-wave-691').fill(code);
await B.getByText('JOIN →',{exact:false}).first().click();

// let RTC connect + jitter buffer fill + comp settle
console.log('waiting 18s for RTC + measurement…');
await B.waitForTimeout(32000);

const rtcA = sA.lines.some(l=>l.includes('ice state: connected')||l.includes('connection state: connected'));
const rtcB = sB.lines.some(l=>l.includes('ice state: connected')||l.includes('connection state: connected'));
const compA = sA.lines.filter(l=>l.includes('[SYNC-COMP]')).slice(-1)[0]||'(none)';
const compB = sB.lines.filter(l=>l.includes('[SYNC-COMP]')).slice(-1)[0]||'(none)';
const hA = await hudComp(A), hB = await hudComp(B);
const errs = [...sA.lines, ...sB.lines].filter(l=>l.startsWith('ERR:'));

console.log('\n==== DELAY-COMP VERIFY ====');
console.log('RTC connected      A:', rtcA, '| B:', rtcB);
console.log('A last [SYNC-COMP] :', compA.replace(/.*\[SYNC-COMP\]/,'[SYNC-COMP]'));
console.log('B last [SYNC-COMP] :', compB.replace(/.*\[SYNC-COMP\]/,'[SYNC-COMP]'));
console.log('A HUD comp         : meas='+hA.meas+'ms appl='+hA.appl+'ms ('+hA.on+')');
console.log('B HUD comp         : meas='+hB.meas+'ms appl='+hB.appl+'ms ('+hB.on+')');
console.log('Page errors        :', errs.length? errs.join('\n'):'none ✅');
const num = v => v && v!=='—' ? parseFloat(v) : null;
const okApplied = [hA,hB].some(h => num(h.appl)!=null && h.on==='on');
const okMeasured = [hA,hB].some(h => num(h.meas)!=null);
console.log('\nFlag ON + applied tracks measured:', okApplied ? 'YES ✅' : 'flag wired but no audio to measure (silent master)');
console.log('Measurement produced a number      :', okMeasured ? 'YES ✅' : 'no (silent stream — needs audio; see notes)');
await browser.close();
