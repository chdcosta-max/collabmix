import { chromium } from 'playwright-core';
const browser = await chromium.launch({ channel:'chrome', headless:true, args:['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('console', m => { if (m.text().startsWith('[P]')) console.log(m.text()); });

await page.evaluate(async () => {
  const log = (...a) => console.log('[P]', ...a);
  const ctx = new AudioContext(); if (ctx.state==='suspended') await ctx.resume();
  let osc = ctx.createOscillator(); osc.frequency.value=220;
  const gain = ctx.createGain();                         // deck "output"
  const msd = ctx.createMediaStreamDestination();
  osc.connect(gain); gain.connect(msd); osc.start();
  const track = msd.stream.getAudioTracks()[0];
  const pcA = new RTCPeerConnection(), pcB = new RTCPeerConnection();
  pcA.onicecandidate=e=>e.candidate&&pcB.addIceCandidate(e.candidate);
  pcB.onicecandidate=e=>e.candidate&&pcA.addIceCandidate(e.candidate);
  let recvTrack=null;
  pcB.ontrack=e=>{ recvTrack=e.track;
    e.track.onmute   = ()=>log('>>> receiver track MUTE   (muted='+e.track.muted+' readyState='+e.track.readyState+')');
    e.track.onunmute = ()=>log('>>> receiver track UNMUTE (muted='+e.track.muted+')');
    e.track.onended  = ()=>log('>>> receiver track ENDED');
    const a=new Audio(); a.autoplay=true; a.srcObject=e.streams[0]; document.body.appendChild(a); a.play().catch(()=>{}); };
  pcA.addTrack(track, msd.stream);
  const o=await pcA.createOffer(); await pcA.setLocalDescription(o); await pcB.setRemoteDescription(o);
  const an=await pcB.createAnswer(); await pcB.setLocalDescription(an); await pcA.setRemoteDescription(an);
  while(pcB.iceConnectionState!=='connected'&&pcB.iceConnectionState!=='completed'){ await new Promise(r=>setTimeout(r,100)); }

  let prev=null;
  const grab=async(tag)=>{
    const stats=await pcB.getStats(); let inb=null;
    stats.forEach(r=>{ if(r.type==='inbound-rtp'&&r.kind==='audio')inb=r; });
    if(!inb){ log(tag,'no inbound'); return; }
    const e=inb.jitterBufferEmittedCount, jbd=inb.jitterBufferDelay;
    let dEmit=null,delta=null; if(prev){ dEmit=e-prev.e; delta=dEmit>0?((jbd-prev.d)/dEmit)*1000:null; }
    log(`${tag} muted=${recvTrack?.muted} rs=${recvTrack?.readyState} dEmit=${dEmit} delta=${delta?.toFixed(1)??'-'}ms tgt=${inb.jitterBufferTargetDelay!=null?((inb.jitterBufferTargetDelay/e)*1000).toFixed(1):'?'}`);
    prev={e,d:jbd};
  };

  log('--- streaming ---');
  for(let i=0;i<5;i++){ await new Promise(r=>setTimeout(r,800)); await grab('base'); }
  log('--- SENDER DECK PAUSE: silence content (gain→0, osc stays) ---');
  gain.gain.value=0;                                     // silent content, track stays live
  for(let i=0;i<5;i++){ await new Promise(r=>setTimeout(r,800)); await grab('silent'); }
  log('--- SENDER STOP (osc.stop, source gone) ---');
  try{ osc.stop(); }catch{}
  for(let i=0;i<4;i++){ await new Promise(r=>setTimeout(r,800)); await grab('stopped'); }
  log('--- RESUME: new osc, gain→1 ---');
  osc=ctx.createOscillator(); osc.frequency.value=220; osc.connect(gain); osc.start(); gain.gain.value=1;
  for(let i=0;i<8;i++){ await new Promise(r=>setTimeout(r,800)); await grab('resumed'); }
});
await browser.close();
