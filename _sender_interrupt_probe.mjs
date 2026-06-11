import { chromium } from 'playwright-core';
const browser = await chromium.launch({ channel:'chrome', headless:true, args:['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('console', m => { if (m.text().startsWith('[P]')) console.log(m.text()); });

const samples = await page.evaluate(async () => {
  const ctx = new AudioContext(); if (ctx.state==='suspended') await ctx.resume();
  const osc = ctx.createOscillator(); osc.frequency.value=220;
  const msd = ctx.createMediaStreamDestination(); osc.connect(msd); osc.start();
  const track = msd.stream.getAudioTracks()[0];
  const pcA = new RTCPeerConnection(), pcB = new RTCPeerConnection();
  pcA.onicecandidate=e=>e.candidate&&pcB.addIceCandidate(e.candidate);
  pcB.onicecandidate=e=>e.candidate&&pcA.addIceCandidate(e.candidate);
  pcB.ontrack=e=>{ const a=new Audio(); a.autoplay=true; a.srcObject=e.streams[0]; document.body.appendChild(a); a.play().catch(()=>{}); };
  const sender = pcA.addTrack(track, msd.stream);
  const o=await pcA.createOffer(); await pcA.setLocalDescription(o); await pcB.setRemoteDescription(o);
  const an=await pcB.createAnswer(); await pcB.setLocalDescription(an); await pcA.setRemoteDescription(an);
  while(pcB.iceConnectionState!=='connected'&&pcB.iceConnectionState!=='completed'){ await new Promise(r=>setTimeout(r,100)); }

  const out=[]; let phase='base';
  const grab=async()=>{
    const stats=await pcB.getStats(); let inb=null, play=null;
    stats.forEach(r=>{ if(r.type==='inbound-rtp'&&r.kind==='audio')inb=r; if(r.type==='media-playout')play=r; });
    if(inb) out.push({ t:out.length, phase, emitted:inb.jitterBufferEmittedCount, jbd:inb.jitterBufferDelay,
      ppd:play?play.totalPlayoutDelay:0, psc:play?play.totalSamplesCount:0, ts:Date.now() });
  };
  for(let i=0;i<6;i++){ await new Promise(r=>setTimeout(r,700)); await grab(); }
  // SENDER PAUSE: stop sending RTP entirely (drains receiver buffer)
  phase='paused'; await sender.replaceTrack(null);
  for(let i=0;i<5;i++){ await new Promise(r=>setTimeout(r,700)); await grab(); }
  // RESUME
  phase='resumed'; await sender.replaceTrack(track);
  for(let i=0;i<14;i++){ await new Promise(r=>setTimeout(r,700)); await grab(); }
  return out;
});

// ── Replay OLD vs NEW (+health gate) algorithms over the REAL counter stream ──
function old(samples){ let prev=null, comp=0, res=[]; for(const s of samples){
  let jbMs; if(prev&&s.emitted>prev.jbe) jbMs=((s.jbd-prev.jbd)/(s.emitted-prev.jbe))*1000;
  else jbMs=s.emitted>0?(s.jbd/s.emitted)*1000:0;
  comp=Math.max(0,jbMs); prev={jbd:s.jbd,jbe:s.emitted}; res.push({phase:s.phase,comp}); } return res; }

function neu(samples){ const SR=48000, HEALTH_MIN=4; let prev=null, comp=0, health=0, res=[]; let lastTs=null;
  for(const s of samples){ const now=s.ts;
    const dEmit=prev?s.emitted-prev.jbe:0; const dt=prev?(now-lastTs)/1000:0;
    const flowing=prev?dEmit>0.5*(dt*SR):false;
    // Discontinuity (first / counter reset / not flowing) → reset health, HOLD.
    if(!prev||s.emitted<prev.jbe||!flowing){ prev={jbd:s.jbd,jbe:s.emitted}; lastTs=now; health=0; res.push({phase:s.phase,comp,held:true}); continue; }
    const cand=Math.max(0,((s.jbd-prev.jbd)/dEmit)*1000); prev={jbd:s.jbd,jbe:s.emitted}; lastTs=now;
    health++;
    // Require sustained healthy flow; a big DROP needs extra confirmation so a
    // refill transient / spurious-low never drags comp toward zero.
    const bigDrop = comp>5 && cand < 0.5*comp;
    const need = bigDrop ? HEALTH_MIN+3 : HEALTH_MIN;
    if(health<need){ res.push({phase:s.phase,comp,held:true}); continue; } // HOLD last good
    comp=cand; res.push({phase:s.phase,comp,held:false}); }
  return res; }

const o=old(samples), n=neu(samples);
console.log('Sender RTP interruption (replaceTrack null→track). comp value (ms) per poll:\n');
console.log('phase     OLD     NEW');
for(let i=0;i<samples.length;i++){ console.log(samples[i].phase.padEnd(9)+' '+o[i].comp.toFixed(1).padStart(6)+'  '+n[i].comp.toFixed(1).padStart(6)+(n[i].held?'  (held)':'')); }
const lastBase = o.filter(r=>r.phase==='base').slice(-1)[0].comp;
const oldResumeMin = Math.min(...o.filter(r=>r.phase==='resumed').map(r=>r.comp));
const newResumeMin = Math.min(...n.filter(r=>r.phase==='resumed').map(r=>r.comp));
const newFinal = n.slice(-1)[0].comp;
console.log('\nbaseline ~'+lastBase.toFixed(0)+'ms');
console.log('OLD min during resume: '+oldResumeMin.toFixed(1)+'ms '+(oldResumeMin<10?'→ FOLLOWED TO ~0 (bug reproduced)':''));
console.log('NEW min during resume: '+newResumeMin.toFixed(1)+'ms, final '+newFinal.toFixed(1)+'ms '+(newResumeMin>15?'→ HELD, never zeroed ✅':'→ still dipped ❌'));
await browser.close();
