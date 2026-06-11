import { chromium } from 'playwright-core';

const URL = 'http://localhost:5173/';
// A stale room code that NO fresh Landing created this server-session —
// simulates Chad's Window 1 reviving yesterday's cm_session into the booth.
const STALE = 'stale-ghost-' + String(100 + Math.floor(Math.random()*899));
const logs = { A: [], B: [] };
const cap = ['[JOIN-DIAG]', '[WS-JOINED]', 'closed', 'partner'];
function attach(p, t){ p.on('console', m => { const s=m.text(); if(cap.some(w=>s.includes(w))) logs[t].push(s); }); p.on('pageerror',e=>logs[t].push('ERR:'+e.message)); }
async function enterLobby(p){ await p.locator('.cta-btn').first().click(); await p.getByText('START MIX',{exact:false}).first().waitFor({timeout:8000}); }
const partnerOf = p => p.evaluate(()=>{ const m=document.body.innerText.match(/⟺\s*([^\n]+)/); return m?m[1].trim():null; });

const browser = await chromium.launch({ channel:'chrome', headless:true });

// ---- Window A: revive a STALE cm_session straight into the booth ----
const ctxA = await browser.newContext();
await ctxA.addInitScript(([code]) => {
  localStorage.setItem('cm_session', JSON.stringify({ room: code, name: 'DJ Ghost A', mixName: 'Revived Mix', isHost: true }));
}, [STALE]);
const A = await ctxA.newPage(); attach(A,'A');
await A.goto(URL, { waitUntil:'domcontentloaded' });
// should auto-rejoin into the booth (no Landing click)
await A.waitForFunction(c => document.body.innerText.includes(c), STALE, { timeout: 9000 }).catch(()=>{});
const aInBooth = await A.evaluate(c => document.body.innerText.includes(c), STALE);
console.log('WINDOW A stale code:', STALE, '| reached booth:', aInBooth);
await A.waitForTimeout(2500);

// ---- Window B: join-by-code the SAME stale code ----
const ctxB = await browser.newContext();
const B = await ctxB.newPage(); attach(B,'B');
await B.goto(URL, { waitUntil:'domcontentloaded' });
await enterLobby(B);
await B.getByPlaceholder('e.g., fade-wave-691').fill(STALE);
await B.getByText('JOIN →',{exact:false}).first().click();
await B.waitForTimeout(4000);

const pa = await partnerOf(A), pb = await partnerOf(B);
console.log('\n========== STALE-ROOM RESULT ==========');
console.log('A sees partner:', pa, '| B sees partner:', pb);
console.log('PAIRED:', (pa && pb) ? 'YES ✅' : 'NO ❌ (separate rooms — REPRODUCED)');
console.log('\n-- A console --\n' + (logs.A.join('\n')||'(none)'));
console.log('\n-- B console --\n' + (logs.B.join('\n')||'(none)'));
await browser.close();
