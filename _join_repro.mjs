import { chromium } from 'playwright-core';

const URL = 'http://localhost:5173/';
const logs = { A: [], B: [] };
const wantTags = ['[JOIN-DIAG]', '[WS-JOINED]', 'WS open', 'closed before', 'partner_joined'];

function attach(page, tag) {
  page.on('console', msg => {
    const t = msg.text();
    if (wantTags.some(w => t.includes(w)) || /room|join|partner|socket/i.test(t)) {
      logs[tag].push(t);
    }
  });
  page.on('pageerror', e => logs[tag].push('PAGEERROR: ' + e.message));
}

async function enterLobby(page) {
  await page.locator('.cta-btn').first().click();
  await page.getByText('START MIX', { exact: false }).first().waitFor({ timeout: 8000 });
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });

// ---- Window A: create a room ----
const ctxA = await browser.newContext();
const A = await ctxA.newPage();
attach(A, 'A');
await A.goto(URL, { waitUntil: 'domcontentloaded' });
await enterLobby(A);
await A.getByText('START MIX', { exact: false }).first().click();
// booth: room code matches word-word-### ; wait for it to appear
await A.waitForFunction(() => /[a-z]+-[a-z]+-\d{3}/.test(document.body.innerText), null, { timeout: 8000 });
const roomCode = await A.evaluate(() => (document.body.innerText.match(/[a-z]+-[a-z]+-\d{3}/) || [])[0]);
console.log('WINDOW A created room code:', roomCode);
await A.waitForTimeout(2500); // let WS settle + partner detection window

// ---- Window B: join by code (the broken path) ----
const ctxB = await browser.newContext();
const B = await ctxB.newPage();
attach(B, 'B');
await B.goto(URL, { waitUntil: 'domcontentloaded' });
await enterLobby(B);
await B.getByPlaceholder('e.g., fade-wave-691').fill(roomCode);
await B.getByText('JOIN →', { exact: false }).first().click();
await B.waitForTimeout(4000); // allow WS join + (non)pairing

// ---- read partner state from both DOMs ----
const partnerOf = async (p) => p.evaluate(() => {
  const m = document.body.innerText.match(/⟺\s*([^\n]+)/);
  return m ? m[1].trim() : null;
});
const pa = await partnerOf(A);
const pb = await partnerOf(B);

console.log('\n================ RESULT ================');
console.log('Room code:', roomCode);
console.log('A sees partner:', pa);
console.log('B sees partner:', pb);
console.log('PAIRED:', !!(pa && pb) ? 'YES ✅' : 'NO ❌ (separate rooms)');
console.log('\n---- Window A console ----');
console.log(logs.A.join('\n') || '(none)');
console.log('\n---- Window B console ----');
console.log(logs.B.join('\n') || '(none)');

await browser.close();
