import { chromium } from 'playwright-core';
const browser = await chromium.launch({ channel:'chrome', headless:true, args:['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('console', m => { if (m.text().startsWith('[P]')) console.log(m.text()); });

await page.evaluate(async () => {
  const log = (...a) => console.log('[P]', ...a);
  const ctx = new AudioContext(); if (ctx.state==='suspended') await ctx.resume();
  const osc = ctx.createOscillator(); osc.frequency.value=220;
  const msd = ctx.createMediaStreamDestination(); osc.connect(msd); osc.start();
  const track = msd.stream.getAudioTracks()[0];

  const pcA = new RTCPeerConnection(), pcB = new RTCPeerConnection();
  pcA.onicecandidate=e=>e.candidate&&pcB.addIceCandidate(e.candidate);
  pcB.onicecandidate=e=>e.candidate&&pcA.addIceCandidate(e.candidate);
  pcB.ontrack=e=>{ const a=new Audio(); a.autoplay=true; a.srcObject=e.streams[0]; document.body.appendChild(a); a.play().catch(()=>{}); };
  pcA.addTrack(track, msd.stream);
  const o=await pcA.createOffer(); await pcA.setLocalDescription(o); await pcB.setRemoteDescription(o);
  const an=await pcB.createAnswer(); await pcB.setLocalDescription(an); await pcA.setRemoteDescription(an);
  while(pcB.iceConnectionState!=='connected'&&pcB.iceConnectionState!=='completed'){ await new Promise(r=>setTimeout(r,100)); }

  let prev=null;
  const sample=async(tag)=>{
    const stats=await pcB.getStats(); let inb=null;
    stats.forEach(r=>{ if(r.type==='inbound-rtp'&&r.kind==='audio')inb=r; });
    if(!inb){ log(tag,'no inbound'); return; }
    const emitted=inb.jitterBufferEmittedCount, jbd=inb.jitterBufferDelay;
    const lifetimeMs=emitted>0?(jbd/emitted)*1000:null;
    let deltaMs=null, dEmit=null;
    if(prev){ dEmit=emitted-prev.e; deltaMs=dEmit>0?((jbd-prev.d)/dEmit)*1000:null; }
    log(`${tag} emitted=${emitted} dEmit=${dEmit} jbd=${jbd.toFixed(3)} lifetime=${lifetimeMs?.toFixed(1)}ms delta=${deltaMs?.toFixed(1)??'n/a'}ms`);
    prev={ e:emitted, d:jbd };
  };

  log('--- baseline (streaming) ---');
  for(let i=0;i<5;i++){ await new Promise(r=>setTimeout(r,1000)); await sample('base'); }
  log('--- INTERRUPT: track.enabled=false (simulated pause) ---');
  track.enabled=false;
  for(let i=0;i<3;i++){ await new Promise(r=>setTimeout(r,1000)); await sample('paused'); }
  log('--- RESUME: track.enabled=true ---');
  track.enabled=true;
  for(let i=0;i<8;i++){ await new Promise(r=>setTimeout(r,1000)); await sample('resumed'); }
});
await browser.close();
