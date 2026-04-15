import { useState, useEffect, useRef, useCallback } from "react";

// ═══════════════════════════════════════════════════════════════
//  COLLAB//MIX  — PRODUCTION READY
//  All bugs fixed. Landing page. Full app.
// ═══════════════════════════════════════════════════════════════

// ── Server Configuration ─────────────────────────────────────
// After deploying to Railway, replace this URL with your Railway server URL.
// It should look like: wss://collabmix-server-production.up.railway.app
const SERVER_URL = "wss://collabmix-server-production.up.railway.app";

// ── Room ID Utilities ────────────────────────────────────────
function getOrCreateRoomId() {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("room");
  if (fromUrl) return fromUrl;
  // Generate a fun, readable room ID
  const words = ["neon","bass","drop","fade","vibe","rave","flux","echo","beam","wave","haze","sync"];
  const w1 = words[Math.floor(Math.random() * words.length)];
  const w2 = words[Math.floor(Math.random() * words.length)];
  const num = Math.floor(Math.random() * 900) + 100;
  return `${w1}-${w2}-${num}`;
}

function buildInviteLink(roomId) {
  const base = window.location.origin + window.location.pathname;
  return `${base}?room=${roomId}`;
}

const ICE = { iceServers: [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
]};

// ── Audio Engine ─────────────────────────────────────────────
function createEngine() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const master = ctx.createGain(); master.gain.value = 0.85;
  const masterAn = ctx.createAnalyser(); masterAn.fftSize = 256;
  master.connect(masterAn); masterAn.connect(ctx.destination);
  function chain() {
    const trim = ctx.createGain(); trim.gain.value = 1;
    const hi  = ctx.createBiquadFilter(); hi.type  = "highshelf"; hi.frequency.value  = 8000;
    const mid = ctx.createBiquadFilter(); mid.type = "peaking";   mid.frequency.value = 1200; mid.Q.value = 0.8;
    const lo  = ctx.createBiquadFilter(); lo.type  = "lowshelf";  lo.frequency.value  = 200;
    const vol = ctx.createGain(); vol.gain.value = 1;
    const xf  = ctx.createGain(); xf.gain.value  = 1;
    const an  = ctx.createAnalyser(); an.fftSize  = 512;
    trim.connect(hi); hi.connect(mid); mid.connect(lo);
    lo.connect(vol); vol.connect(xf); xf.connect(master); xf.connect(an);
    return { trim, hi, mid, lo, vol, xf, an };
  }
  return { ctx, master, masterAn, A: chain(), B: chain() };
}
function xg(p) { const a = p * Math.PI / 2; return { a: Math.cos(a), b: Math.sin(a) }; }

// ── BPM Worker ───────────────────────────────────────────────
const WORKER_SRC = `
function bp(sig,sr,low,high){const o=new Float32Array(sig.length);const rL=1/(2*Math.PI*high/sr+1),rH=1/(2*Math.PI*low/sr+1);let pi=0,po=0;const hp=new Float32Array(sig.length);for(let i=0;i<sig.length;i++){hp[i]=rH*(po+sig[i]-pi);pi=sig[i];po=hp[i];}let pv=0;for(let i=0;i<hp.length;i++){pv=o[i]=pv+(1-rL)*(hp[i]-pv);}return o;}
function pk(a){const r=[];for(let i=1;i<a.length-1;i++){if(a[i]>a[i-1]&&a[i]>a[i+1]){const lm=Math.min(...a.slice(Math.max(0,i-10),i),...a.slice(i+1,Math.min(a.length,i+11)));r.push({idx:i,val:a[i],p:a[i]-lm});}}return r.sort((a,b)=>b.val-a.val);}
function rv(b,mn,mx){let v=b;while(v<mn)v*=2;while(v>mx)v/=2;return Math.round(v*10)/10;}
self.onmessage=function(e){
  const{cd,sr,id}=e.data;const len=cd[0].length,nc=cd.length;
  const mono=new Float32Array(len);for(let c=0;c<nc;c++){const d=cd[c];for(let i=0;i<len;i++)mono[i]+=d[i]/nc;}
  const f=bp(mono,sr,100,400);for(let i=0;i<f.length;i++)f[i]=f[i]>0?f[i]:0;
  const ar=200,hop=Math.floor(sr/ar),nf=Math.floor(len/hop);
  const env=new Float32Array(nf);for(let i=0;i<nf;i++){let s=0;const st=i*hop,en=Math.min(st+hop,len);for(let j=st;j<en;j++)s+=f[j]*f[j];env[i]=Math.sqrt(s/(en-st));}
  const on=new Float32Array(nf);for(let i=1;i<nf;i++){const d=env[i]-env[i-1];on[i]=d>0?d:0;}
  const mn=on.reduce((s,v)=>s+v,0)/nf;const sd=Math.sqrt(on.reduce((s,v)=>s+(v-mn)**2,0)/nf)||1;
  for(let i=0;i<nf;i++)on[i]=(on[i]-mn)/sd;
  const ml=Math.floor(60/200*ar),xl=Math.ceil(60/60*ar),al=xl-ml+1;
  const ac=new Float32Array(al);for(let li=0;li<al;li++){const lag=li+ml;let s=0;for(let i=0;i<nf-lag;i++)s+=on[i]*on[i+lag];ac[li]=s/(nf-lag);}
  const peaks=pk(ac);if(!peaks.length){self.postMessage({id,bpm:null,confidence:0,candidates:[]});return;}
  const top=peaks[0];const lag=top.idx+ml;const raw=(60/lag)*ar;
  const bpm=rv(raw,100,175);
  const mxA=Math.max(...ac),mnA=Math.min(...ac),rng=mxA-mnA||1;
  const conf=Math.min(100,Math.round(((top.val-mnA)/rng)*100));
  const cands=peaks.slice(0,5).map(p=>({bpm:rv((60/(p.idx+ml))*ar,100,175),score:p.val}));
  self.postMessage({id,bpm,confidence:conf,candidates:cands});
};`;

function createBPMWorker() {
  return new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: "application/javascript" })));
}

function useBPM() {
  const [results, setResults] = useState({});
  const worker = useRef(null);
  useEffect(() => {
    worker.current = createBPMWorker();
    worker.current.onmessage = (e) => {
      const { id, bpm, confidence, candidates } = e.data;
      setResults(prev => ({ ...prev, [id]: { bpm, confidence, candidates, analyzing: false } }));
    };
    return () => worker.current?.terminate();
  }, []);
  const analyze = useCallback((buf, id) => {
    if (!buf || !worker.current) return;
    setResults(prev => ({ ...prev, [id]: { ...(prev[id] || {}), analyzing: true } }));
    const cd = [];
    for (let c = 0; c < buf.numberOfChannels; c++) cd.push(buf.getChannelData(c).slice());
    worker.current.postMessage({ cd, sr: buf.sampleRate, id });
  }, []);
  return { results, analyze };
}

// ── Recording ────────────────────────────────────────────────
function useRecorder({ engineRef }) {
  const [state, setState] = useState("idle");
  const [dur, setDur]     = useState(0);
  const [recs, setRecs]   = useState([]);
  const [level, setLevel] = useState(0);
  const rec=useRef(null),chunks=useRef([]),dest=useRef(null);
  const t0=useRef(0),pAcc=useRef(0),timer=useRef(null),raf=useRef(null),wv=useRef([]);

  const start = useCallback((label) => {
    const eng = engineRef.current; if (!eng) return;
    const d = eng.ctx.createMediaStreamDestination();
    eng.master.connect(d); dest.current = d;
    const types = ["audio/webm;codecs=opus","audio/webm","audio/ogg"];
    const mime = types.find(t => MediaRecorder.isTypeSupported(t)) || "";
    let mr; try { mr = new MediaRecorder(d.stream, mime ? { mimeType: mime } : {}); } catch { mr = new MediaRecorder(d.stream); }
    chunks.current = []; wv.current = []; t0.current = Date.now(); pAcc.current = 0;
    mr.ondataavailable = e => { if (e.data.size > 0) chunks.current.push(e.data); };
    mr.onstop = () => {
      const blob = new Blob(chunks.current, { type: mr.mimeType || "audio/webm" });
      const url  = URL.createObjectURL(blob);
      const d2   = (Date.now() - t0.current - pAcc.current) / 1000;
      setRecs(p => [{ id: Date.now(), label: label || `REC ${new Date().toLocaleTimeString("en-US",{hour12:false})}`, url, blob, dur: d2, size: blob.size, ext: mr.mimeType?.includes("ogg") ? "ogg" : "webm", waveform: [...wv.current] }, ...p]);
      setState("idle"); clearInterval(timer.current); cancelAnimationFrame(raf.current);
      setLevel(0); setDur(0);
    };
    mr.start(250); rec.current = mr; setState("recording");
    timer.current = setInterval(() => setDur((Date.now()-t0.current-pAcc.current)/1000), 100);
    const an=eng.masterAn, fd=new Uint8Array(an.frequencyBinCount); let wa=0,wc=0;
    const sample=()=>{ an.getByteFrequencyData(fd); const avg=fd.reduce((s,v)=>s+v,0)/fd.length/255; setLevel(avg); wa+=avg; wc++; if(wc>=15){wv.current.push(wa/wc);wa=0;wc=0;} if(rec.current?.state!=="inactive")raf.current=requestAnimationFrame(sample); };
    sample();
  }, [engineRef]);

  const pause  = useCallback(() => { if(rec.current?.state!=="recording")return; rec.current.pause(); setState("paused"); clearInterval(timer.current); pAcc.current-=Date.now(); }, []);
  const resume = useCallback(() => { if(rec.current?.state!=="paused")return; rec.current.resume(); setState("recording"); pAcc.current+=Date.now(); timer.current=setInterval(()=>setDur((Date.now()-t0.current-pAcc.current)/1000),100); }, []);
  const stop   = useCallback(() => { if(!rec.current||rec.current.state==="inactive")return; rec.current.stop(); try{engineRef.current?.master.disconnect(dest.current);}catch{} dest.current=null; clearInterval(timer.current); cancelAnimationFrame(raf.current); }, [engineRef]);
  const del    = useCallback((id) => { setRecs(p=>{const r=p.find(x=>x.id===id);if(r)URL.revokeObjectURL(r.url);return p.filter(x=>x.id!==id);}); }, []);
  const dl     = useCallback((r) => { const a=document.createElement("a");a.href=r.url;a.download=`${r.label}.${r.ext}`;document.body.appendChild(a);a.click();document.body.removeChild(a); }, []);

  useEffect(() => () => { clearInterval(timer.current); cancelAnimationFrame(raf.current); recs.forEach(r=>URL.revokeObjectURL(r.url)); }, []);
  return { state, dur, recs, level, start, pause, resume, stop, del, dl };
}

// ── WebSocket Sync ───────────────────────────────────────────
function useSync({ url, onMsg }) {
  const ws=useRef(null);
  const [status, setStatus]   = useState("disconnected");
  const [partner, setPartner] = useState(null);
  const [ping, setPing]       = useState(null);
  const [connErr, setConnErr] = useState(null);
  const pt=useRef(null), cb=useRef(onMsg);
  useEffect(()=>{cb.current=onMsg;},[onMsg]);

  const send = useCallback((m) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(m));
  }, []);

  const connect = useCallback((roomId, djName) => {
    if (ws.current) ws.current.close();
    setStatus("connecting"); setConnErr(null);
    try {
      const w = new WebSocket(url); ws.current = w;
      w.onopen = () => {
        setStatus("connected");
        w.send(JSON.stringify({ type:"join", roomId, djName }));
        pt.current = setInterval(() => send({ type:"ping", clientTime:Date.now() }), 3000);
      };
      w.onmessage = (e) => {
        let m; try{m=JSON.parse(e.data);}catch{return;}
        if(m.type==="joined")        setPartner(m.partnerName);
        if(m.type==="partner_joined")setPartner(m.djName);
        if(m.type==="partner_left")  setPartner(null);
        if(m.type==="pong")          setPing(Date.now()-m.clientTime);
        if(m.type==="error")         setConnErr(m.msg);
        cb.current?.(m);
      };
      w.onerror = () => { setStatus("error"); setConnErr("Could not connect to server. Check the URL."); };
      w.onclose = () => { setStatus("disconnected"); clearInterval(pt.current); };
    } catch(e) {
      setStatus("error"); setConnErr("Invalid server URL.");
    }
  }, [url, send]);

  const disconnect = useCallback(() => {
    ws.current?.close(); clearInterval(pt.current); setPartner(null);
  }, []);

  useEffect(()=>()=>{ ws.current?.close(); clearInterval(pt.current); },[]);
  return { status, partner, ping, connErr, send, connect, disconnect };
}

// ── WebRTC ───────────────────────────────────────────────────
function useRTC({ engineRef, send }) {
  const [state, setState] = useState("idle");
  const [muted, setMuted] = useState(false);
  const [remVol, setRemVol] = useState(0.85);
  const pc=useRef(null),dest=useRef(null),remAudio=useRef(null),pend=useRef([]),sRef=useRef(send);
  useEffect(()=>{sRef.current=send;},[send]);

  const capture = useCallback(() => {
    const eng=engineRef.current; if(!eng)throw new Error("No engine");
    const d=eng.ctx.createMediaStreamDestination(); eng.master.connect(d); dest.current=d; return d.stream;
  },[engineRef]);

  const mkPC = useCallback(() => {
    if(pc.current)pc.current.close();
    const p=new RTCPeerConnection(ICE); pc.current=p;
    p.onicecandidate=({candidate})=>{if(candidate)sRef.current({type:"rtc_ice",candidate:candidate.toJSON()});};
    p.oniceconnectionstatechange=()=>{ const s=p.iceConnectionState; if(s==="connected"||s==="completed")setState("connected"); if(s==="failed")setState("failed"); if(s==="closed")setState("idle"); };
    p.ontrack=({streams})=>{ if(streams[0]){if(!remAudio.current){remAudio.current=new Audio();remAudio.current.autoplay=true;} remAudio.current.srcObject=streams[0]; remAudio.current.volume=Math.min(1,remVol);} };
    return p;
  },[remVol]);

  useEffect(()=>{ if(remAudio.current)remAudio.current.volume=Math.min(1,remVol); },[remVol]);

  const startCall = useCallback(async()=>{
    setState("connecting");
    try{ const s=capture(); const p=mkPC(); s.getTracks().forEach(t=>p.addTrack(t,s)); const o=await p.createOffer({offerToReceiveAudio:true}); await p.setLocalDescription(o); sRef.current({type:"rtc_offer",sdp:p.localDescription}); setState("offering"); }
    catch(e){console.error(e);setState("failed");}
  },[capture,mkPC]);

  const handleOffer = useCallback(async({sdp})=>{
    setState("answering");
    try{ const s=capture(); const p=mkPC(); s.getTracks().forEach(t=>p.addTrack(t,s)); await p.setRemoteDescription(new RTCSessionDescription(sdp)); for(const c of pend.current){try{await p.addIceCandidate(new RTCIceCandidate(c));}catch{}} pend.current=[]; const a=await p.createAnswer(); await p.setLocalDescription(a); sRef.current({type:"rtc_answer",sdp:p.localDescription}); setState("connecting"); }
    catch(e){console.error(e);setState("failed");}
  },[capture,mkPC]);

  const handleAnswer = useCallback(async({sdp})=>{ if(!pc.current)return; try{await pc.current.setRemoteDescription(new RTCSessionDescription(sdp)); for(const c of pend.current){try{await pc.current.addIceCandidate(new RTCIceCandidate(c));}catch{}} pend.current=[];}catch(e){console.error(e);} },[]);
  const handleIce   = useCallback(async({candidate})=>{ if(!candidate)return; if(pc.current?.remoteDescription){try{await pc.current.addIceCandidate(new RTCIceCandidate(candidate));}catch{}}else pend.current.push(candidate); },[]);
  const endCall     = useCallback(()=>{ sRef.current({type:"rtc_hangup"}); pc.current?.close(); pc.current=null; try{engineRef.current?.master.disconnect(dest.current);}catch{} dest.current=null; if(remAudio.current)remAudio.current.srcObject=null; setState("idle"); },[engineRef]);
  const toggleMute  = useCallback(()=>{ dest.current?.stream.getTracks().forEach(t=>{t.enabled=muted;}); setMuted(m=>!m); },[muted]);
  const handleRtc   = useCallback((msg)=>{ switch(msg.type){case"rtc_offer":handleOffer(msg);break;case"rtc_answer":handleAnswer(msg);break;case"rtc_ice":handleIce(msg);break;case"rtc_hangup":endCall();break;} },[handleOffer,handleAnswer,handleIce,endCall]);

  useEffect(()=>()=>endCall(),[]);
  return { state, muted, remVol, setRemVol, startCall, endCall, toggleMute, handleRtc };
}

// ── MIDI ─────────────────────────────────────────────────────
function useMidi({ onAction }) {
  const [granted,setGranted]=useState(false);
  const [devices,setDevices]=useState([]);
  const [active,setActive]=useState(null);
  const [mappings,setMappings]=useState({});
  const [learning,setLearning]=useState(null);
  const midi=useRef(null),lr=useRef(null),mr=useRef({}),cb=useRef(onAction);
  useEffect(()=>{lr.current=learning;},[learning]);
  useEffect(()=>{mr.current=mappings;},[mappings]);
  useEffect(()=>{cb.current=onAction;},[onAction]);
  const key=(s,d1)=>`${(s&0xF0).toString(16)}-${(s&0xF)}-${d1}`;
  const handle=useCallback((e)=>{
    const[s,d1,d2]=e.data; const t=s&0xF0; if(s>=0xF0)return; const k=key(s,d1);
    if(lr.current){if((t===0x90&&d2>0)||(t===0xB0&&d2>0)||t===0xE0){setMappings(p=>({...p,[k]:lr.current}));setLearning(null);}return;}
    const ak=mr.current[k]; if(!ak)return;
    const TYPES={DECK_A_PLAY:"button",DECK_A_CUE:"button",DECK_A_EQ_HI:"knob",DECK_A_EQ_MID:"knob",DECK_A_EQ_LO:"knob",DECK_A_VOL:"fader",DECK_B_PLAY:"button",DECK_B_CUE:"button",DECK_B_EQ_HI:"knob",DECK_B_EQ_MID:"knob",DECK_B_EQ_LO:"knob",DECK_B_VOL:"fader",CROSSFADER:"fader",MASTER_VOL:"fader"};
    const tp=TYPES[ak]; if(!tp)return; let v;
    if(tp==="button"){if(t===0x90&&d2>0)v=true;else if(t===0x80||(t===0x90&&d2===0))v=false;else return;}
    else v=d2/127;
    cb.current?.({actionKey:ak,value:v});
  },[]);
  const request=useCallback(async()=>{ if(!navigator.requestMIDIAccess)return; try{const acc=await navigator.requestMIDIAccess({sysex:false});midi.current=acc;setGranted(true);const upd=()=>setDevices([...acc.inputs.values()].map(i=>({id:i.id,name:i.name})));upd();acc.onstatechange=upd;}catch{} },[]);
  const connect=useCallback((id)=>{ if(!midi.current)return; for(const i of midi.current.inputs.values())i.onmidimessage=null; if(!id){setActive(null);return;} const inp=midi.current.inputs.get(id); if(inp){inp.onmidimessage=handle;setActive({id,name:inp.name});} },[handle]);
  return { granted, devices, active, mappings, learning, setMappings, setLearning, request, connect };
}

// ── UI Primitives ─────────────────────────────────────────────
function VU({ an, color, w=100 }) {
  const ref=useRef(null),raf=useRef(null);
  useEffect(()=>{ if(!an||!ref.current)return; const c=ref.current,ctx=c.getContext("2d"),d=new Uint8Array(an.frequencyBinCount); const draw=()=>{ raf.current=requestAnimationFrame(draw); an.getByteFrequencyData(d); const lv=d.reduce((s,v)=>s+v,0)/d.length/255; ctx.clearRect(0,0,c.width,c.height); const n=12; for(let i=0;i<n;i++){ctx.fillStyle=lv*n>i?(i>10?"#ef4444":i>8?"#f59e0b":color):"#0b0b18";ctx.fillRect(i*(c.width/n+.3),0,c.width/n-1,c.height);} }; draw(); return()=>cancelAnimationFrame(raf.current); },[an,color]);
  return <canvas ref={ref} width={w} height={6} style={{width:"100%",borderRadius:2}}/>;
}

function WF({ buf, prog, color, onSeek, h=50 }) {
  const ref=useRef(null);
  useEffect(()=>{ if(!ref.current)return; const c=ref.current,ctx=c.getContext("2d"),W=c.width,H=c.height; ctx.clearRect(0,0,W,H); if(!buf){ctx.fillStyle="#0c0c18";for(let x=0;x<W;x+=3)ctx.fillRect(x,H/2-1,1,2);return;} const data=buf.getChannelData(0),step=Math.floor(data.length/W),px=Math.floor(prog*W); for(let x=0;x<W;x++){let mx=0;for(let j=0;j<step;j++)mx=Math.max(mx,Math.abs(data[x*step+j]||0));const bh=mx*H*.9;ctx.fillStyle=x<px?color:x===px?"#fff":color+"33";ctx.fillRect(x,(H-bh)/2,1,Math.max(1,bh));} ctx.fillStyle="#fff";ctx.shadowColor="#fff";ctx.shadowBlur=6;ctx.fillRect(Math.floor(prog*W),0,2,H);ctx.shadowBlur=0; },[buf,prog,color]);
  return <canvas ref={ref} width={460} height={h} onClick={e=>{if(!onSeek||!ref.current)return;const r=ref.current.getBoundingClientRect();onSeek((e.clientX-r.left)/r.width);}} style={{width:"100%",height:h,background:"#04040b",borderRadius:6,cursor:onSeek?"crosshair":"default"}}/>;
}

function BeatGrid({ bpm, dur, prog, color }) {
  const ref=useRef(null);
  useEffect(()=>{ if(!ref.current||!bpm||!dur)return; const c=ref.current,ctx=c.getContext("2d"),W=c.width,H=c.height; ctx.clearRect(0,0,W,H); const spb=60/bpm; let bt=0,bn=0; while(bt<dur){const x=(bt/dur)*W;ctx.strokeStyle=bn%4===0?color+"66":color+"22";ctx.lineWidth=bn%4===0?1:.5;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();bt+=spb;bn++;} const px=Math.floor(prog*W);ctx.fillStyle=color;ctx.shadowColor=color;ctx.shadowBlur=8;ctx.beginPath();ctx.arc(px,H/2,3,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0; },[bpm,dur,prog,color]);
  return <canvas ref={ref} width={460} height={18} style={{width:"100%",height:18,background:"#04040b",borderRadius:4}}/>;
}

function Knob({ v, set, min=-12, max=12, ctr=0, label, color="#00d4ff", size=38, off }) {
  const dr=useRef(false),sy=useRef(0),sv=useRef(0); const pct=(v-min)/(max-min);
  const md=(e)=>{ if(off)return; e.preventDefault();dr.current=true;sy.current=e.clientY;sv.current=v; const mm=(ev)=>{if(dr.current)set(Math.max(min,Math.min(max,sv.current+(sy.current-ev.clientY)/100*(max-min))));};const mu=()=>{dr.current=false;window.removeEventListener("mousemove",mm);window.removeEventListener("mouseup",mu);};window.addEventListener("mousemove",mm);window.addEventListener("mouseup",mu); };
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2,userSelect:"none",opacity:off?.35:1}}>
      <div onMouseDown={md} onDoubleClick={()=>!off&&set(ctr)} style={{width:size,height:size,borderRadius:"50%",background:"#0a0a1c",border:`2px solid ${color}33`,cursor:off?"default":"ns-resize",position:"relative",boxShadow:v!==ctr?`0 0 8px ${color}22`:"none"}}>
        <svg width={size} height={size} style={{position:"absolute"}}><circle cx={size/2} cy={size/2} r={size/2-3} fill="none" stroke="#151525" strokeWidth={2.5} strokeDasharray={`${2.36*(size/2-3)} 999`} transform={`rotate(135 ${size/2} ${size/2})`}/><circle cx={size/2} cy={size/2} r={size/2-3} fill="none" stroke={color} strokeWidth={2.5} strokeDasharray={`${pct*2.36*(size/2-3)} 999`} transform={`rotate(135 ${size/2} ${size/2})`} strokeLinecap="round"/></svg>
        <div style={{position:"absolute",width:3,height:3,borderRadius:"50%",background:color,top:"50%",left:"50%",transform:`translate(-50%,-50%) rotate(${-135+pct*270}deg) translateY(-${size*.26}px)`}}/>
      </div>
      <span style={{fontSize:6,color:"#3a3a4a",fontFamily:"monospace",letterSpacing:1}}>{label}</span>
    </div>
  );
}

// ── Deck ─────────────────────────────────────────────────────
function Deck({ id, ch, ctx:ac, color, local, remote, onChange, midi:mt, bpmResult, bpmAnalyze }) {
  const [buf,setBuf]=useState(null),[name,setName]=useState(null),[play,setPlay]=useState(false);
  const [prog,setProg]=useState(0),[dur,setDur]=useState(0);
  const [hi,setHi]=useState(0),[mid,setMid]=useState(0),[lo,setLo]=useState(0),[vol,setVol]=useState(1);
  const [rate,setRate]=useState(1); // FIX: track actual playback rate
  const [dragOver,setDragOver]=useState(false);
  const src=useRef(null),st=useRef(0),off=useRef(0),raf=useRef(null),fr=useRef(null);

  // Prevent browser from navigating to dropped files
  useEffect(()=>{
    if(!local)return;
    const stop=(e)=>{e.preventDefault();e.stopPropagation();};
    document.addEventListener("dragover",stop);
    document.addEventListener("drop",stop);
    return()=>{document.removeEventListener("dragover",stop);document.removeEventListener("drop",stop);};
  },[local]);

  useEffect(()=>{if(ch){ch.hi.gain.value=hi;}},[hi,ch]);
  useEffect(()=>{if(ch){ch.mid.gain.value=mid;}},[mid,ch]);
  useEffect(()=>{if(ch){ch.lo.gain.value=lo;}},[lo,ch]);
  useEffect(()=>{if(ch){ch.vol.gain.value=vol;}},[vol,ch]);

  // Mirror remote state
  useEffect(()=>{ if(!remote||local)return; setPlay(remote.playing||false);setProg(remote.progress||0);setHi(remote.eqHi??0);setMid(remote.eqMid??0);setLo(remote.eqLo??0);setVol(remote.vol??1);if(remote.trackName)setName(remote.trackName); },[remote,local]);

  // MIDI routing
  const sfx=`DECK_${id}`;
  useEffect(()=>{ if(!mt||!local)return; const{actionKey:ak,value:v}=mt; if(ak===`${sfx}_PLAY`&&v===true)toggle(); if(ak===`${sfx}_CUE`&&v===true)cue(); if(ak===`${sfx}_EQ_HI`){const n=v*24-12;setHi(n);onChange?.("eqHi",n);} if(ak===`${sfx}_EQ_MID`){const n=v*24-12;setMid(n);onChange?.("eqMid",n);} if(ak===`${sfx}_EQ_LO`){const n=v*24-12;setLo(n);onChange?.("eqLo",n);} if(ak===`${sfx}_VOL`){setVol(v);onChange?.("vol",v);} },[mt]);

  const stop_=()=>{ if(src.current){try{src.current.stop();}catch{}src.current.disconnect();src.current=null;}cancelAnimationFrame(raf.current); };

  const play_=(o)=>{ if(!buf||!ch||!ac)return; stop_(); if(ac.state==="suspended")ac.resume();
    const s=ac.createBufferSource(); s.buffer=buf; s.playbackRate.value=rate; s.connect(ch.trim); s.start(0,o);
    s.onended=()=>{setPlay(false);setProg(0);off.current=0;onChange?.("playing",false);};
    src.current=s; st.current=ac.currentTime; off.current=o;
    let ls=0; const tick=()=>{ const c=off.current+(ac.currentTime-st.current); const p=Math.min(1,c/buf.duration); setProg(p); if(c-ls>.5){onChange?.("progress",p);ls=c;} if(c<buf.duration)raf.current=requestAnimationFrame(tick); }; tick(); };

  const toggle=useCallback(()=>{ if(!buf)return; if(play){off.current=Math.min(buf.duration,off.current+(ac.currentTime-st.current));stop_();setPlay(false);onChange?.("playing",false);}else{play_(off.current);setPlay(true);onChange?.("playing",true);} },[buf,play,ac,rate]);
  const seek  =useCallback((p)=>{ const o=p*(buf?.duration||0);off.current=o;if(play)play_(o);else setProg(p);onChange?.("progress",p); },[buf,play,rate]);
  const cue   =useCallback(()=>{ off.current=0;setProg(0);if(play){stop_();setPlay(false);onChange?.("playing",false);}onChange?.("progress",0); },[play]);

  // FIX: actually call bpmAnalyze when buffer loads
  const load=async(f)=>{
    const ab=await f.arrayBuffer();
    const d=await ac.decodeAudioData(ab);
    stop_();setPlay(false);setProg(0);off.current=0;
    setBuf(d);setDur(d.duration);
    const n=f.name.replace(/\.[^.]+$/,"");
    setName(n);onChange?.("trackName",n);
    bpmAnalyze?.(d, id); // ← FIX: trigger BPM analysis
  };

  // Expose rate setter for beat sync (called from parent)
  useEffect(()=>{ if(src.current?.playbackRate){ src.current.playbackRate.setTargetAtTime(rate,ac?.currentTime||0,.05); } },[rate,ac]);

  const fmt=(s)=>`${String(Math.floor(Math.max(0,s)/60)).padStart(2,"0")}:${String(Math.floor(Math.max(0,s)%60)).padStart(2,"0")}`;
  const sy=(setter,field)=>(v)=>{setter(v);onChange?.(field,v);};
  const cur=prog*dur;

  return (
    <div style={{background:"linear-gradient(155deg,#0d0d1f,#07070f)",border:`1px solid ${play?color+"55":"#141424"}`,borderRadius:12,padding:12,display:"flex",flexDirection:"column",gap:7,boxShadow:play?`0 0 22px ${color}14`:"none",transition:"border-color .3s,box-shadow .3s"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          <span style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:13,letterSpacing:3,color}}> DECK {id}</span>
          {!local&&<span style={{fontSize:6,fontFamily:"monospace",color:color+"88",background:color+"11",borderRadius:3,padding:"1px 5px"}}>PARTNER</span>}
          {play&&<div style={{width:4,height:4,borderRadius:"50%",background:color,boxShadow:`0 0 7px ${color}`,animation:"blink 1s ease-in-out infinite"}}/>}
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {/* FIX: show live BPM accounting for rate */}
          {bpmResult?.bpm&&<span style={{fontSize:9,fontFamily:"monospace",fontWeight:700,color:color+"cc"}}>{(bpmResult.bpm*rate).toFixed(1)} <span style={{fontSize:6,color:"#444"}}>BPM</span></span>}
          {bpmResult?.analyzing&&<span style={{fontSize:7,fontFamily:"monospace",color:"#f59e0b",animation:"pulse .8s infinite"}}>ANALYZING</span>}
          <VU an={ch?.an} color={color}/>
        </div>
      </div>

      {local?(
        <div
          onClick={()=>fr.current?.click()}
          onDragOver={e=>{e.preventDefault();e.stopPropagation();setDragOver(true);}}
          onDragLeave={()=>setDragOver(false)}
          onDrop={e=>{e.preventDefault();e.stopPropagation();setDragOver(false);const f=e.dataTransfer.files[0];if(f&&f.type.startsWith("audio/"))load(f);}}
          style={{background:dragOver?color+"11":"#07070f",border:`1px dashed ${dragOver?color:buf?color+"22":"#141424"}`,borderRadius:7,padding:"6px 10px",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center",transition:"all .15s"}}>
          <div><div style={{fontSize:10,fontWeight:600,color:buf?"#d8d8e8":dragOver?color:"#2a2a3a",fontFamily:"'Barlow Condensed',sans-serif"}}>{dragOver?"DROP TO LOAD":name||"CLICK OR DRAG TRACK"}</div>{buf&&<div style={{fontSize:6,color:"#444",fontFamily:"monospace",marginTop:1}}>{fmt(dur)} · {(buf.sampleRate/1000).toFixed(1)}kHz</div>}</div>
          <span style={{color:dragOver?color:color+"44",fontSize:13}}>⊕</span>
        </div>
      ):(
        <div style={{background:"#07070f",border:"1px solid #111",borderRadius:7,padding:"6px 10px"}}><div style={{fontSize:10,color:name?"#6666aa":"#1e1e2e",fontFamily:"'Barlow Condensed',sans-serif"}}>{name||"WAITING FOR PARTNER..."}</div></div>
      )}
      <input ref={fr} type="file" accept="audio/*" style={{display:"none"}} onChange={e=>e.target.files[0]&&load(e.target.files[0])}/>

      <WF buf={buf} prog={prog} color={color} onSeek={local?seek:null}/>
      {bpmResult?.bpm&&dur>0&&<BeatGrid bpm={bpmResult.bpm*rate} dur={dur} prog={prog} color={color}/>}

      <div style={{display:"flex",justifyContent:"space-between",fontFamily:"monospace"}}>
        <span style={{fontSize:10,color,fontWeight:700}}>{fmt(cur)}</span>
        <span style={{fontSize:6,color:"#2a2a3a"}}>{buf?`${(prog*100).toFixed(1)}%`:""}</span>
        <span style={{fontSize:10,color:"#333"}}>-{fmt(dur-cur)}</span>
      </div>

      {local&&(
        <div style={{display:"flex",gap:4,justifyContent:"center"}}>
          <button onClick={cue} disabled={!buf} style={TB("#223")}>⏮</button>
          <button onClick={()=>seek(Math.max(0,prog-.01))} disabled={!buf} style={TB("#223")}>◂◂</button>
          <button onClick={toggle} disabled={!buf} style={{...TB(color),width:38,height:38,fontSize:14,background:play?color+"22":color+"0d",boxShadow:play&&buf?`0 0 12px ${color}55`:""}}>{play?"⏸":"▶"}</button>
          <button onClick={()=>seek(Math.min(1,prog+.01))} disabled={!buf} style={TB("#223")}>▸▸</button>
        </div>
      )}

      <div style={{display:"flex",gap:4,justifyContent:"space-around",alignItems:"flex-end",background:"#05050c",borderRadius:7,padding:"6px 3px",border:"1px solid #0f0f1e"}}>
        <Knob v={hi}  set={local?sy(setHi,"eqHi"):()=>{}}  min={-12} max={12} ctr={0} label="HI"  color={color} size={34} off={!local}/>
        <Knob v={mid} set={local?sy(setMid,"eqMid"):()=>{}} min={-12} max={12} ctr={0} label="MID" color={color} size={34} off={!local}/>
        <Knob v={lo}  set={local?sy(setLo,"eqLo"):()=>{}}  min={-12} max={12} ctr={0} label="LO"  color={color} size={34} off={!local}/>
        <div style={{width:1,background:"#1a1a2e",alignSelf:"stretch",margin:"0 1px"}}/>
        <Knob v={vol} set={local?(v)=>{setVol(v);onChange?.("vol",v);}:()=>{}} min={0} max={1.5} ctr={1} label="VOL" color="#666" size={34} off={!local}/>
      </div>

      {/* FIX: expose setRate so parent can do beat sync */}
      <div style={{display:"none"}} data-set-rate={id} ref={el=>{if(el)el._setRate=setRate;}}/>
    </div>
  );
}
const TB=(c)=>({height:28,padding:"0 7px",background:"#0a0a18",border:`1px solid ${c}44`,color:c,borderRadius:5,cursor:"pointer",fontFamily:"monospace",fontSize:8,outline:"none",display:"flex",alignItems:"center",justifyContent:"center"});
const sBtn=(c)=>({padding:"5px 8px",fontSize:8,fontFamily:"monospace",background:c+"11",border:`1px solid ${c}33`,color:c,borderRadius:6,cursor:"pointer",letterSpacing:1,display:"flex",alignItems:"center",justifyContent:"center",gap:4});

// ── Sidebar Panels ────────────────────────────────────────────
function SyncPanel({ bpmA, bpmB, rateA, rateB, onSyncB, onSyncA }) {
  const effA=bpmA?bpmA*rateA:null, effB=bpmB?bpmB*rateB:null;
  const diff=effA&&effB?Math.abs(effA-effB).toFixed(2):null;
  const inSync=diff!==null&&parseFloat(diff)<0.5;
  return (
    <div style={{padding:10,display:"flex",flexDirection:"column",gap:8}}>
      <div style={{display:"flex",gap:8,justifyContent:"space-around",background:"#07070f",borderRadius:8,padding:"10px",border:"1px solid #0f0f1e"}}>
        {[["A","#00d4ff",effA,rateA],["B","#ff6b35",effB,rateB]].map(([id,c,eff,r])=>(
          <div key={id} style={{textAlign:"center"}}>
            <div style={{fontSize:6,fontFamily:"monospace",color:c+"44",letterSpacing:2}}>DECK {id}</div>
            <div style={{fontSize:20,fontFamily:"monospace",fontWeight:700,color:eff?c:"#2a2a3a"}}>{eff?eff.toFixed(1):"—"}</div>
            {r!==1&&<div style={{fontSize:6,color:c+"66",fontFamily:"monospace"}}>{r>1?"+":""}{((r-1)*100).toFixed(1)}%</div>}
          </div>
        ))}
      </div>
      {diff&&<div style={{textAlign:"center",fontSize:8,fontFamily:"monospace",color:inSync?"#22c55e":"#555"}}>Δ{diff} BPM {inSync?"✓ IN SYNC":""}</div>}
      <div style={{display:"flex",gap:5}}>
        <button onClick={onSyncB} disabled={!bpmA||!bpmB} style={{flex:1,...sBtn("#00d4ff")}}>SYNC B→A</button>
        <button onClick={onSyncA} disabled={!bpmA||!bpmB} style={{flex:1,...sBtn("#ff6b35")}}>SYNC A→B</button>
      </div>
      {(!bpmA||!bpmB)&&<div style={{fontSize:7,fontFamily:"monospace",color:"#1e1e2e",textAlign:"center",lineHeight:1.9}}>Load tracks to detect BPM<br/>Analysis runs automatically</div>}
    </div>
  );
}

function RTCPanel({ rtc, partner, syncOk }) {
  const ST={idle:{c:"#333",l:"OFFLINE"},offering:{c:"#f59e0b",l:"OFFERING"},answering:{c:"#f59e0b",l:"ANSWERING"},connecting:{c:"#f59e0b",l:"CONNECTING"},connected:{c:"#22c55e",l:"● STREAMING"},failed:{c:"#ef4444",l:"FAILED"}};
  const s=ST[rtc.state]||ST.idle,live=rtc.state==="connected",busy=["offering","answering","connecting"].includes(rtc.state),canCall=syncOk&&partner&&!live&&!busy;
  return (
    <div style={{padding:10,display:"flex",flexDirection:"column",gap:8}}>
      <div style={{display:"flex",justifyContent:"space-between"}}><span style={{fontSize:8,fontFamily:"monospace",color:"#444",letterSpacing:1}}>P2P AUDIO</span><span style={{fontSize:7,fontFamily:"monospace",color:s.c}}>{s.l}</span></div>
      {live&&<div style={{display:"flex",gap:2,height:16,alignItems:"center",justifyContent:"center"}}>{Array.from({length:12}).map((_,i)=><div key={i} style={{width:3,borderRadius:2,background:"#22c55e",height:"100%",animation:`wave ${.4+(i%4)*.1}s ease-in-out ${i*.06}s infinite`,transformOrigin:"bottom"}}/>)}</div>}
      <div style={{fontSize:7,fontFamily:"monospace",color:"#333",display:"flex",justifyContent:"space-between"}}><span>PARTNER</span><span style={{color:partner?"#ff6b35":"#2a2a3a"}}>{partner||"—"}</span></div>
      <div style={{display:"flex",flexDirection:"column",gap:2}}><div style={{display:"flex",justifyContent:"space-between",fontSize:7,fontFamily:"monospace",color:"#444"}}><span>PARTNER VOL</span><span style={{color:"#22c55e"}}>{Math.round(rtc.remVol*100)}%</span></div><input type="range" min={0} max={1.5} step={.01} value={rtc.remVol} onChange={e=>rtc.setRemVol(Number(e.target.value))} style={{width:"100%",cursor:"pointer",accentColor:"#22c55e"}}/></div>
      <div style={{display:"flex",gap:5}}>
        {canCall&&<button onClick={rtc.startCall} style={{flex:1,...sBtn("#22c55e"),fontWeight:700}}>▶ START STREAM</button>}
        {busy&&<button disabled style={{flex:1,...sBtn("#f59e0b")}}>◌ CONNECTING...</button>}
        {(live||busy)&&<><button onClick={rtc.toggleMute} style={{...sBtn(rtc.muted?"#ef4444":"#555"),padding:"5px 8px"}}>{rtc.muted?"🔇":"🎙"}</button><button onClick={rtc.endCall} style={{...sBtn("#ef4444"),padding:"5px 8px"}}>✕</button></>}
      </div>
      {!live&&!busy&&!canCall&&<div style={{fontSize:7,fontFamily:"monospace",color:"#1e1e2e",lineHeight:1.9}}>{!syncOk?"Connect via WebSocket first":!partner?"Waiting for partner to join":"Ready — click Start Stream"}</div>}
    </div>
  );
}

function RecPanel({ rec, ready }) {
  const [label,setLabel]=useState("");
  const isRec=rec.state==="recording",isPaused=rec.state==="paused",isActive=isRec||isPaused;
  const fmt=(s)=>`${String(Math.floor(Math.max(0,s)/60)).padStart(2,"0")}:${String(Math.floor(Math.max(0,s)%60)).padStart(2,"0")}.${Math.floor((s%1)*10)}`;
  const fsz=(b)=>b>1e6?`${(b/1e6).toFixed(1)}MB`:`${(b/1e3).toFixed(0)}KB`;
  return (
    <div style={{padding:10,display:"flex",flexDirection:"column",gap:8}}>
      {isActive&&<div style={{fontSize:22,fontFamily:"monospace",fontWeight:700,color:isRec?"#ef4444":"#f59e0b",letterSpacing:2,textAlign:"center"}}>{fmt(rec.dur)}</div>}
      {isActive&&<div style={{height:3,background:"#0a0a18",borderRadius:2}}><div style={{height:"100%",width:`${rec.level*100}%`,background:rec.level>.8?"#ef4444":rec.level>.6?"#f59e0b":"#22c55e",transition:"width .05s"}}/></div>}
      {!isActive&&<input value={label} onChange={e=>setLabel(e.target.value)} placeholder="Label (optional)" style={{background:"#07070f",border:"1px solid #141424",color:"#e8e8f0",borderRadius:6,padding:"5px 8px",fontSize:9,fontFamily:"monospace",outline:"none"}}/>}
      <div style={{display:"flex",gap:5}}>
        {!isActive&&<button onClick={()=>rec.start(label||null)} disabled={!ready} style={{flex:1,padding:"8px",...sBtn("#ef4444"),fontWeight:700,opacity:ready?1:.4}}>● REC</button>}
        {isRec&&<><button onClick={rec.pause} style={{flex:1,padding:"7px",...sBtn("#f59e0b"),fontWeight:700}}>⏸</button><button onClick={rec.stop} style={{flex:1,padding:"7px",...sBtn("#ef4444"),fontWeight:700}}>⏹ STOP</button></>}
        {isPaused&&<><button onClick={rec.resume} style={{flex:1,padding:"7px",...sBtn("#22c55e"),fontWeight:700}}>▶</button><button onClick={rec.stop} style={{flex:1,padding:"7px",...sBtn("#ef4444"),fontWeight:700}}>⏹ STOP</button></>}
      </div>
      {rec.recs.length>0&&(
        <div style={{display:"flex",flexDirection:"column",gap:5,borderTop:"1px solid #0f0f1e",paddingTop:8}}>
          <div style={{fontSize:6,fontFamily:"monospace",color:"#333",letterSpacing:2}}>SAVED ({rec.recs.length})</div>
          {rec.recs.map(r=>(
            <div key={r.id} style={{background:"#07070f",border:"1px solid #0f0f1e",borderRadius:7,padding:"6px 9px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div><div style={{fontSize:9,fontFamily:"monospace",color:"#c8c8d8"}}>{r.label}</div><div style={{fontSize:6,fontFamily:"monospace",color:"#333"}}>{fsz(r.size)} · {r.ext}</div></div>
              <div style={{display:"flex",gap:4}}><button onClick={()=>rec.dl(r)} style={{...sBtn("#00d4ff"),padding:"2px 7px",fontSize:7}}>↓</button><button onClick={()=>rec.del(r.id)} style={{...sBtn("#ef4444"),padding:"2px 6px",fontSize:7}}>✕</button></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MidiPanel({ midi }) {
  const [tab,setTab]=useState("dev");
  const ACTS=["DECK_A_PLAY","DECK_A_CUE","DECK_A_EQ_HI","DECK_A_EQ_MID","DECK_A_EQ_LO","DECK_A_VOL","DECK_B_PLAY","DECK_B_CUE","DECK_B_EQ_HI","DECK_B_EQ_MID","DECK_B_EQ_LO","DECK_B_VOL","CROSSFADER","MASTER_VOL"];
  const mc=new Set(Object.values(midi.mappings)).size;
  return (
    <div style={{display:"flex",flexDirection:"column",height:"100%"}}>
      <div style={{display:"flex",borderBottom:"1px solid #0f0f1e",flexShrink:0}}>
        {[["dev","DEV"],["map",`MAP(${mc})`]].map(([id,l])=>(
          <button key={id} onClick={()=>setTab(id)} style={{flex:1,padding:"6px 3px",fontSize:7,fontFamily:"monospace",background:tab===id?"#0d0d20":"transparent",color:tab===id?"#00d4ff":"#333",border:"none",borderBottom:`1px solid ${tab===id?"#00d4ff":"transparent"}`,cursor:"pointer",outline:"none"}}>{l}</button>
        ))}
      </div>
      <div style={{flex:1,overflowY:"auto",padding:7}}>
        {tab==="dev"&&(<div style={{display:"flex",flexDirection:"column",gap:5}}>{!midi.granted?<button onClick={midi.request} style={{...sBtn("#f59e0b"),width:"100%",justifyContent:"center",padding:"7px"}}>ENABLE MIDI ACCESS</button>:<>{midi.devices.length===0&&<div style={{fontSize:7,color:"#2a2a3a",fontFamily:"monospace",textAlign:"center",padding:"10px 0"}}>No MIDI devices found.<br/>Plug in your controller.</div>}{midi.devices.map(d=><div key={d.id} onClick={()=>midi.connect(d.id)} style={{padding:"5px 7px",borderRadius:5,cursor:"pointer",background:midi.active?.id===d.id?"#00d4ff0d":"#07070f",border:`1px solid ${midi.active?.id===d.id?"#00d4ff33":"#0f0f1e"}`}}><div style={{fontSize:8,color:"#c8c8d8",fontFamily:"monospace"}}>{d.name}</div>{midi.active?.id===d.id&&<div style={{fontSize:6,color:"#00d4ff",fontFamily:"monospace"}}>● ACTIVE</div>}</div>)}</> }</div>)}
        {tab==="map"&&(<div style={{display:"flex",flexDirection:"column",gap:2}}>{midi.learning&&<div style={{fontSize:7,fontFamily:"monospace",color:"#00d4ff",background:"#00d4ff0a",border:"1px solid #00d4ff22",borderRadius:4,padding:"4px 7px",marginBottom:3,animation:"pulse .8s infinite"}}>● Move a control on your controller...<button onClick={()=>midi.setLearning(null)} style={{float:"right",background:"none",border:"none",color:"#00d4ff",cursor:"pointer",fontSize:8}}>✕</button></div>}{ACTS.map(ak=>{const mp=Object.entries(midi.mappings).find(([,v])=>v===ak);const il=midi.learning===ak;return(<div key={ak} style={{display:"flex",gap:3,alignItems:"center",padding:"2px 3px",borderRadius:3,background:il?"#00d4ff08":"transparent"}}><span style={{flex:1,fontSize:6,fontFamily:"monospace",color:mp?"#8888aa":"#2a2a3a",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{ak.replace(/_/g," ")}</span>{mp&&<span style={{fontSize:5,color:"#00d4ff44",fontFamily:"monospace"}}>{mp[0].slice(0,6)}</span>}<button onClick={()=>midi.setLearning(il?null:ak)} style={{padding:"1px 4px",fontSize:5,fontFamily:"monospace",background:il?"#00d4ff22":"#0a0a18",border:`1px solid ${il?"#00d4ff44":"#141424"}`,color:il?"#00d4ff":"#333",borderRadius:3,cursor:"pointer"}}>{il?"●":"LRN"}</button></div>);})}</div>)}
      </div>
    </div>
  );
}

function ChatPanel({ log, send, me }) {
  const [input,setInput]=useState(""); const end=useRef(null);
  useEffect(()=>end.current?.scrollIntoView({behavior:"smooth"}),[log]);
  const go=()=>{if(!input.trim())return;send(input);setInput("");};
  return (
    <div style={{display:"flex",flexDirection:"column",height:"100%"}}>
      <div style={{flex:1,overflowY:"auto",padding:"7px 9px",display:"flex",flexDirection:"column",gap:3}}>
        {log.length===0&&<div style={{fontSize:8,color:"#1e1e2e",fontFamily:"monospace",textAlign:"center",marginTop:20}}>Chat with your partner here</div>}
        {log.map((m,i)=><div key={i} style={{fontSize:9,fontFamily:"monospace"}}>{m.type==="system"?<span style={{color:"#2a2a3a",fontStyle:"italic"}}>— {m.msg} —</span>:<><span style={{color:"#2a2a3a",fontSize:6}}>{m.time} </span><span style={{color:m.self||m.from===me?"#00d4ff":"#ff6b35",fontWeight:700}}>{m.from}: </span><span style={{color:"#5555aa"}}>{m.msg}</span></>}</div>)}
        <div ref={end}/>
      </div>
      <div style={{display:"flex",gap:5,padding:"5px 7px",borderTop:"1px solid #0f0f1e"}}>
        <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&go()} placeholder="Message your partner..." style={{flex:1,background:"#07070f",border:"1px solid #141424",color:"#e8e8f0",borderRadius:5,padding:"4px 7px",fontSize:9,fontFamily:"monospace",outline:"none"}}/>
        <button onClick={go} style={{...sBtn("#00d4ff"),padding:"4px 9px",fontSize:10}}>→</button>
      </div>
    </div>
  );
}

// ── LANDING PAGE ──────────────────────────────────────────────
function Landing({ onEnter }) {
  const [hovered, setHovered] = useState(null);

  const features = [
    { icon: "🎚", title: "Dual Deck Mixing", desc: "Full two-deck setup per DJ. Load any MP3, WAV, or FLAC from your device. Real waveforms, click-to-seek." },
    { icon: "⚡", title: "Real-Time Sync", desc: "Every EQ move, crossfade, and play/pause syncs to your partner instantly. Sub-50ms latency." },
    { icon: "🎛", title: "MIDI Controllers", desc: "Connect any DDJ, CDJ, or MIDI controller. Map every knob and fader to the mixer with one-click learn mode." },
    { icon: "🔊", title: "P2P Audio Stream", desc: "Hear each other's mix live via WebRTC. Direct peer-to-peer — no audio passes through any server." },
    { icon: "🎯", title: "BPM Detection", desc: "Automatic tempo analysis on every loaded track. Beat grid overlay. One-click sync to lock two decks together." },
    { icon: "⏺", title: "Session Recording", desc: "Record your live mix to a file. Pause and resume. Download as WebM or WAV." },
  ];

  return (
    <div style={{ minHeight:"100vh", background:"#020208", color:"#e8e8f0", fontFamily:"'Barlow', sans-serif", overflowX:"hidden" }}>
      <style>{`
        @keyframes float { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-12px)} }
        @keyframes glow  { 0%,100%{opacity:.4} 50%{opacity:.9} }
        @keyframes slide { from{opacity:0;transform:translateY(24px)} to{opacity:1;transform:translateY(0)} }
        @keyframes spin  { to{transform:rotate(360deg)} }
        .feat-card:hover { border-color: #00d4ff44 !important; transform: translateY(-3px); box-shadow: 0 8px 30px rgba(0,212,255,.08) !important; }
        .feat-card { transition: all .2s ease !important; }
        .cta-btn:hover { box-shadow: 0 0 40px #00d4ff55, 0 0 80px #00d4ff22 !important; transform: scale(1.02); }
        .cta-btn { transition: all .2s ease !important; }
        .nav-link:hover { color: #00d4ff !important; }
        .nav-link { transition: color .15s !important; }
      `}</style>
      <link href="https://fonts.googleapis.com/css2?family=Barlow:wght@300;400;600;700&family=Barlow+Condensed:wght@600;700;800;900&display=swap" rel="stylesheet"/>

      {/* NAV */}
      <nav style={{ position:"fixed", top:0, left:0, right:0, zIndex:100, padding:"14px 40px", display:"flex", justifyContent:"space-between", alignItems:"center", background:"linear-gradient(180deg,#020208ee,transparent)", backdropFilter:"blur(8px)" }}>
        <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:22, letterSpacing:3, background:"linear-gradient(90deg,#00d4ff,#ff6b35)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>COLLAB//MIX</div>
        <div style={{ display:"flex", gap:28, alignItems:"center" }}>
          {["Features","How It Works","Get Started"].map(l=>(
            <span key={l} className="nav-link" style={{ fontSize:11, fontFamily:"monospace", color:"#555", letterSpacing:1, cursor:"pointer" }}>{l.toUpperCase()}</span>
          ))}
          <button onClick={onEnter} className="cta-btn" style={{ padding:"8px 20px", background:"linear-gradient(135deg,#00d4ff,#0099bb)", border:"none", color:"#000", fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:12, letterSpacing:2, borderRadius:6, cursor:"pointer" }}>
            LAUNCH APP →
          </button>
        </div>
      </nav>

      {/* HERO */}
      <section style={{ minHeight:"100vh", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", textAlign:"center", padding:"100px 40px 60px", position:"relative", overflow:"hidden" }}>

        {/* Background glow orbs */}
        <div style={{ position:"absolute", top:"20%", left:"15%", width:400, height:400, borderRadius:"50%", background:"radial-gradient(circle,#00d4ff08,transparent 70%)", animation:"glow 4s ease-in-out infinite", pointerEvents:"none" }}/>
        <div style={{ position:"absolute", top:"30%", right:"10%", width:300, height:300, borderRadius:"50%", background:"radial-gradient(circle,#ff6b3508,transparent 70%)", animation:"glow 5s ease-in-out 1s infinite", pointerEvents:"none" }}/>
        <div style={{ position:"absolute", bottom:"20%", left:"40%", width:500, height:200, borderRadius:"50%", background:"radial-gradient(circle,#a855f706,transparent 70%)", animation:"glow 6s ease-in-out 2s infinite", pointerEvents:"none" }}/>

        {/* Animated grid lines */}
        <div style={{ position:"absolute", inset:0, backgroundImage:"linear-gradient(#ffffff04 1px,transparent 1px),linear-gradient(90deg,#ffffff04 1px,transparent 1px)", backgroundSize:"60px 60px", pointerEvents:"none" }}/>

        <div style={{ animation:"slide .8s ease forwards", maxWidth:760 }}>
          <div style={{ fontSize:10, fontFamily:"monospace", color:"#00d4ff", letterSpacing:4, marginBottom:20, display:"flex", alignItems:"center", justifyContent:"center", gap:10 }}>
            <div style={{ width:20, height:1, background:"#00d4ff" }}/>
            THE FUTURE OF REMOTE DJing
            <div style={{ width:20, height:1, background:"#00d4ff" }}/>
          </div>

          <h1 style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:"clamp(48px,8vw,96px)", lineHeight:.95, letterSpacing:-1, margin:"0 0 24px" }}>
            <span style={{ display:"block", background:"linear-gradient(135deg,#ffffff,#aaaacc)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>MIX TOGETHER.</span>
            <span style={{ display:"block", background:"linear-gradient(135deg,#00d4ff,#0066ff)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>ANYWHERE.</span>
          </h1>

          <p style={{ fontSize:16, color:"#8888aa", lineHeight:1.7, maxWidth:520, margin:"0 auto 40px", fontWeight:300 }}>
            Two DJs. Real-time audio sync. MIDI controllers. Beat detection. Live audio streaming. All in your browser — no software to install.
          </p>

          <div style={{ display:"flex", gap:12, justifyContent:"center", flexWrap:"wrap" }}>
            <button onClick={onEnter} className="cta-btn" style={{ padding:"16px 40px", background:"linear-gradient(135deg,#00d4ff,#0077cc)", border:"none", color:"#000", fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:15, letterSpacing:2, borderRadius:8, cursor:"pointer", boxShadow:"0 0 30px #00d4ff33" }}>
              START A SESSION FREE →
            </button>
            <button style={{ padding:"16px 32px", background:"transparent", border:"1px solid #ffffff22", color:"#888", fontFamily:"'Barlow Condensed',sans-serif", fontWeight:700, fontSize:14, letterSpacing:2, borderRadius:8, cursor:"pointer" }}>
              WATCH DEMO ▶
            </button>
          </div>

          <div style={{ marginTop:24, fontSize:9, fontFamily:"monospace", color:"#333", letterSpacing:1 }}>
            No account required · Works in Chrome & Edge · Free to use
          </div>
        </div>

        {/* Floating mixer preview */}
        <div style={{ marginTop:60, width:"100%", maxWidth:860, animation:"float 6s ease-in-out infinite", position:"relative" }}>
          <div style={{ background:"linear-gradient(150deg,#0d0d22,#07070f)", border:"1px solid #1a1a30", borderRadius:16, padding:"20px 24px", boxShadow:"0 40px 80px rgba(0,0,0,.6), 0 0 60px rgba(0,212,255,.06)", display:"grid", gridTemplateColumns:"1fr 80px 1fr", gap:16, alignItems:"center" }}>
            {["#00d4ff","#ff6b35"].map((c,i)=>(
              <div key={i} style={{ background:"#06060f", borderRadius:10, padding:12, border:`1px solid ${c}22` }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
                  <span style={{ fontSize:9, fontFamily:"monospace", color:c, letterSpacing:2 }}>DECK {i===0?"A":"B"}</span>
                  <div style={{ display:"flex", gap:1 }}>{Array.from({length:8}).map((_,j)=><div key={j} style={{ width:4, height:4+Math.random()*12, background:c+(j<5?"cc":"33"), borderRadius:1 }}/>)}</div>
                </div>
                <div style={{ height:28, background:"#03030a", borderRadius:4, marginBottom:8, overflow:"hidden", display:"flex", alignItems:"center" }}>
                  {Array.from({length:60}).map((_,j)=>{ const h=Math.sin(j*.4+(i*.5))*.4+.5; return <div key={j} style={{ flex:1, height:`${h*100}%`, background:j<30?c:c+"44", borderRadius:1 }}/>; })}
                </div>
                <div style={{ display:"flex", gap:4, justifyContent:"center" }}>
                  {["⏮","◂◂","▶","▸▸"].map(btn=><div key={btn} style={{ width:24, height:20, background:"#0a0a18", border:`1px solid ${c}22`, borderRadius:3, display:"flex", alignItems:"center", justifyContent:"center", fontSize:8, color:btn==="▶"?c:"#444" }}>{btn}</div>)}
                </div>
              </div>
            ))}
            <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:8 }}>
              <div style={{ fontSize:7, fontFamily:"monospace", color:"#333", letterSpacing:1 }}>XF</div>
              <div style={{ width:"100%", height:4, background:"linear-gradient(90deg,#00d4ff,#ff6b35)", borderRadius:2, position:"relative" }}>
                <div style={{ position:"absolute", left:"calc(50% - 8px)", top:-6, width:16, height:16, background:"#e8e8f0", borderRadius:3, boxShadow:"0 0 8px rgba(255,255,255,.3)" }}/>
              </div>
              <div style={{ fontSize:7, fontFamily:"monospace", color:"#22c55e" }}>124.0 BPM</div>
            </div>
          </div>
          {/* Reflection */}
          <div style={{ position:"absolute", bottom:-40, left:"10%", right:"10%", height:40, background:"linear-gradient(180deg,rgba(0,212,255,.04),transparent)", borderRadius:"50%", filter:"blur(10px)" }}/>
        </div>
      </section>

      {/* FEATURES */}
      <section style={{ padding:"80px 40px", maxWidth:1100, margin:"0 auto" }}>
        <div style={{ textAlign:"center", marginBottom:56 }}>
          <div style={{ fontSize:9, fontFamily:"monospace", color:"#00d4ff", letterSpacing:4, marginBottom:14 }}>WHAT'S INSIDE</div>
          <h2 style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:"clamp(32px,5vw,52px)", letterSpacing:-1, margin:0, color:"#e8e8f0" }}>EVERYTHING A DJ NEEDS</h2>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))", gap:16 }}>
          {features.map((f,i)=>(
            <div key={i} className="feat-card" style={{ background:"linear-gradient(150deg,#0d0d1e,#07070f)", border:"1px solid #141428", borderRadius:12, padding:"24px 22px" }}>
              <div style={{ fontSize:28, marginBottom:12 }}>{f.icon}</div>
              <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:17, letterSpacing:1, color:"#e8e8f0", marginBottom:8 }}>{f.title}</div>
              <div style={{ fontSize:11, color:"#666", lineHeight:1.7, fontWeight:300 }}>{f.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section style={{ padding:"80px 40px", background:"linear-gradient(180deg,transparent,#0a0a1800,transparent)" }}>
        <div style={{ maxWidth:800, margin:"0 auto", textAlign:"center" }}>
          <div style={{ fontSize:9, fontFamily:"monospace", color:"#00d4ff", letterSpacing:4, marginBottom:14 }}>SIMPLE AS IT GETS</div>
          <h2 style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:"clamp(28px,4vw,46px)", letterSpacing:-1, marginBottom:48, color:"#e8e8f0" }}>THREE STEPS TO GO LIVE</h2>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:24 }}>
            {[
              { n:"01", title:"Open the App", desc:"No install. No account. Just click Launch App and you're in." },
              { n:"02", title:"Share Room ID", desc:"Copy your Room ID and send it to your partner. They join the same room." },
              { n:"03", title:"Start Mixing", desc:"Load your tracks, hit play. You're live. Your mix streams to their ears in real time." },
            ].map((s,i)=>(
              <div key={i} style={{ textAlign:"center" }}>
                <div style={{ fontSize:40, fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, color:"#00d4ff11", letterSpacing:-2, marginBottom:12 }}>{s.n}</div>
                <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:18, color:"#e8e8f0", marginBottom:8 }}>{s.title}</div>
                <div style={{ fontSize:11, color:"#555", lineHeight:1.7 }}>{s.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* BOTTOM CTA */}
      <section style={{ padding:"80px 40px", textAlign:"center" }}>
        <div style={{ maxWidth:600, margin:"0 auto" }}>
          <h2 style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:"clamp(32px,5vw,56px)", letterSpacing:-1, margin:"0 0 16px", background:"linear-gradient(135deg,#ffffff,#aaaacc)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>
            READY TO MIX?
          </h2>
          <p style={{ fontSize:13, color:"#555", marginBottom:32, lineHeight:1.7 }}>
            Invite a friend, load up your tracks, and start playing together right now. No credit card. No software.
          </p>
          <button onClick={onEnter} className="cta-btn" style={{ padding:"18px 48px", background:"linear-gradient(135deg,#00d4ff,#0077cc)", border:"none", color:"#000", fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:16, letterSpacing:3, borderRadius:8, cursor:"pointer", boxShadow:"0 0 40px #00d4ff33" }}>
            LAUNCH COLLAB//MIX →
          </button>
        </div>
      </section>

      {/* FOOTER */}
      <footer style={{ borderTop:"1px solid #0f0f1e", padding:"24px 40px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:14, letterSpacing:3, background:"linear-gradient(90deg,#00d4ff,#ff6b35)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>COLLAB//MIX</div>
        <div style={{ fontSize:8, fontFamily:"monospace", color:"#2a2a3a" }}>Built for DJs who refuse to be in the same room.</div>
        <div style={{ fontSize:8, fontFamily:"monospace", color:"#2a2a3a" }}>Chrome & Edge · HTTPS required for MIDI + WebRTC</div>
      </footer>
    </div>
  );
}

// ── Share Button (used in session top bar) ───────────────────
function ShareButton({ room }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(buildInviteLink(room)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  };
  return (
    <button onClick={copy} style={{ background: copied ? "#22c55e22" : "#00d4ff11", border: copied ? "1px solid #22c55e55" : "1px solid #00d4ff33", color: copied ? "#22c55e" : "#00d4ff", fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:7, letterSpacing:1, height:22, padding:"0 9px", borderRadius:5, cursor:"pointer", transition:"all .3s" }}>
      {copied ? "✓ COPIED" : "⎘ INVITE"}
    </button>
  );
}

// ── Session Lobby (after clicking Launch) ────────────────────
function Lobby({ onJoin, djName = null }) {
  const [room] = useState(() => getOrCreateRoomId());
  const [name, setName] = useState(djName || "DJ " + ["Apex","Nova","Flux","Orbit","Prism","Echo"][Math.floor(Math.random()*6)]);
  const [copied, setCopied] = useState(false);

  // Auto-join immediately if a name was passed in from the landing page
  useEffect(() => {
    if (djName) onJoin({ url: SERVER_URL, room, name: djName });
  }, []);

  const inviteLink = buildInviteLink(room);

  const copyLink = () => {
    navigator.clipboard.writeText(inviteLink).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  };

  return (
    <div style={{ minHeight:"100vh", background:"radial-gradient(ellipse at 50% 40%,#0e0e28,#060610 60%,#020208)", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'Barlow',sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;600;700&family=Barlow+Condensed:wght@600;700;800&display=swap" rel="stylesheet"/>
      <div style={{ width:440, background:"#0a0a1a", border:"1px solid #1a1a30", borderRadius:18, padding:36, display:"flex", flexDirection:"column", gap:20 }}>

        {/* Header */}
        <div style={{ textAlign:"center" }}>
          <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:30, letterSpacing:4, background:"linear-gradient(90deg,#00d4ff,#ff6b35)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>COLLAB//MIX</div>
          <div style={{ fontSize:7, fontFamily:"monospace", color:"#2a2a3a", letterSpacing:3, marginTop:4 }}>SET UP YOUR SESSION</div>
        </div>

        {/* DJ Name */}
        <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
          <label style={{ fontSize:8, fontFamily:"monospace", color:"#555", letterSpacing:2 }}>YOUR DJ NAME</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            style={{ background:"#06060f", border:"1px solid #1a1a2e", color:"#e8e8f0", borderRadius:8, padding:"11px 14px", fontSize:14, fontFamily:"'Barlow Condensed',sans-serif", fontWeight:700, letterSpacing:1, outline:"none" }}
          />
        </div>

        {/* Room Code */}
        <div style={{ background:"#07071a", border:"1px solid #1a1a30", borderRadius:12, padding:16, display:"flex", flexDirection:"column", gap:8 }}>
          <div style={{ fontSize:8, fontFamily:"monospace", color:"#555", letterSpacing:2 }}>YOUR ROOM</div>
          <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:22, letterSpacing:3, color:"#e8e8f0" }}>{room}</div>
          <div style={{ fontSize:9, fontFamily:"monospace", color:"#333", wordBreak:"break-all" }}>{inviteLink}</div>
          <button
            onClick={copyLink}
            style={{ background: copied ? "linear-gradient(135deg,#22c55e22,#22c55e11)" : "linear-gradient(135deg,#00d4ff22,#00d4ff11)", border: copied ? "1px solid #22c55e55" : "1px solid #00d4ff33", color: copied ? "#22c55e" : "#00d4ff", fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:11, letterSpacing:2, padding:"9px 16px", borderRadius:8, cursor:"pointer", transition:"all .3s", textAlign:"center" }}
          >
            {copied ? "✓ LINK COPIED!" : "⎘ COPY INVITE LINK"}
          </button>
          <div style={{ fontSize:8, fontFamily:"monospace", color:"#2a2a3a" }}>Send this link to your DJ partner — they'll join instantly.</div>
        </div>

        {/* Join button */}
        <button
          onClick={() => onJoin({ url: SERVER_URL, room, name })}
          style={{ background:"linear-gradient(135deg,#00d4ff,#0077cc)", border:"none", color:"#000", fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:16, letterSpacing:3, padding:"15px", borderRadius:10, cursor:"pointer", boxShadow:"0 0 30px #00d4ff33" }}
        >
          ▶ OPEN THE ROOM
        </button>

        <div style={{ fontSize:7, fontFamily:"monospace", color:"#1e1e2e", textAlign:"center" }}>
          Works best in Chrome or Edge
        </div>
      </div>
    </div>
  );
}

// ── MAIN APP ─────────────────────────────────────────────────
export default function CollabMix({ initialPage = "landing", djName = null }) {
  const [page, setPage]         = useState(initialPage); // "landing"|"lobby"|"session"
  const eng                     = useRef(null);
  const [ready, setReady]       = useState(false);
  const [session, setSession]   = useState(null);
  const [xf, setXf]             = useState(.5);
  const [mvol, setMvol]         = useState(.85);
  const [chat, setChat]         = useState([]);
  const [pA, setPA]             = useState(null);
  const [pB, setPB]             = useState(null);
  const [midiEvt, setMidiEvt]   = useState(null);
  const [panel, setPanel]       = useState("sync");
  // FIX: track actual playback rates so BPM sync display is correct
  const [rateA, setRateA]       = useState(1);
  const [rateB, setRateB]       = useState(1);
  const lsRef                   = useRef({ deckA:{}, deckB:{}, xfade:.5 });
  const rateARef                = useRef(null); // DOM refs to call setRate on Deck
  const rateBRef                = useRef(null);

  const bpm = useBPM();
  const rec = useRecorder({ engineRef: eng });

  const applyXF = useCallback((v) => {
    if (!eng.current) return;
    const {a,b} = xg(v);
    eng.current.A.xf.gain.setTargetAtTime(a, eng.current.ctx.currentTime, .01);
    eng.current.B.xf.gain.setTargetAtTime(b, eng.current.ctx.currentTime, .01);
  }, []);

  useEffect(() => { if (ready) applyXF(xf); }, [xf, ready]);
  useEffect(() => { if (eng.current) eng.current.master.gain.setTargetAtTime(mvol, eng.current.ctx.currentTime, .01); }, [mvol]);

  const handleWS = useCallback((m) => {
    if (m.type==="deck_update")    (m.deckId==="A"?setPA:setPB)(p=>({...(p||{}),[m.field]:m.value}));
    if (m.type==="xfade_update")   { setXf(m.value); applyXF(m.value); }
    if (m.type==="chat")           setChat(p=>[...p,m]);
    if (m.type==="partner_joined") setChat(p=>[...p,{type:"system",msg:`${m.djName} joined the session`}]);
    if (m.type==="partner_left")   { setChat(p=>[...p,{type:"system",msg:`${m.djName} left`}]); setPA(null); setPB(null); }
    if (m.type==="sync_request")   sync.send({type:"sync_response",state:lsRef.current});
    if (m.type==="sync_response")  { if(m.state?.deckA)setPA(m.state.deckA); if(m.state?.deckB)setPB(m.state.deckB); if(m.state?.xfade!=null){setXf(m.state.xfade);applyXF(m.state.xfade);} }
    rtc.handleRtc(m);
  }, [applyXF]);

  const sync = useSync({ url: SERVER_URL, onMsg: handleWS });
  const rtc  = useRTC({ engineRef: eng, send: sync.send });

  const handleMidi = useCallback(({actionKey,value}) => {
    setMidiEvt({actionKey,value,ts:Date.now()});
    if (actionKey==="CROSSFADER") { setXf(value); applyXF(value); sync.send({type:"xfade_update",value}); }
    if (actionKey==="MASTER_VOL") setMvol(value*1.5);
  }, [applyXF, sync]);

  const midi = useMidi({ onAction: handleMidi });

  // FIX: beat sync now updates rateA/rateB state AND deck playback rate
  const syncDecks = useCallback((slave, targetBPM) => {
    const srcBPM = bpm.results[slave]?.bpm;
    if (!srcBPM || !targetBPM) return;
    const rate = targetBPM / srcBPM;
    if (Math.abs(rate-1) > 0.12) return;
    if (slave==="A") {
      setRateA(rate);
      const el = document.querySelector("[data-set-rate='A']");
      if (el?._setRate) el._setRate(rate);
    } else {
      setRateB(rate);
      const el = document.querySelector("[data-set-rate='B']");
      if (el?._setRate) el._setRate(rate);
    }
  }, [bpm.results]);

  const dh = (id) => (field, value) => {
    const k = `deck${id}`;
    lsRef.current[k] = { ...(lsRef.current[k]||{}), [field]: value };
    sync.send({ type:"deck_update", deckId:id, field, value });
  };

  const setXfLocal = (v) => { setXf(v); applyXF(v); lsRef.current.xfade=v; sync.send({type:"xfade_update",value:v}); };

  const join = (info) => {
    eng.current = createEngine();
    setReady(true); setSession(info); setPage("session");
    sync.connect(info.room, info.name);
  };

  const leave = () => {
    rtc.endCall(); sync.disconnect();
    setReady(false); setSession(null); setPage("lobby");
    eng.current = null; setRateA(1); setRateB(1);
    // Clear room from URL so a fresh room is generated on next visit
    window.history.replaceState({}, "", window.location.pathname);
  };

  const SC = { connected:"#22c55e", connecting:"#f59e0b", disconnected:"#444", error:"#ef4444" };
  const PANELS = [["sync","⟳ SYNC"],["rtc","⚡ AUDIO"],["rec","⏺ REC"],["chat","💬 CHAT"],["midi","⎍ MIDI"]];

  if (page==="landing") return <Landing onEnter={()=>setPage("lobby")}/>;
  if (page==="lobby")   return <Lobby onJoin={join} djName={djName}/>;

  return (
    <div style={{ minHeight:"100vh", background:"radial-gradient(ellipse at 25% 10%,#0e0e28,#060610 50%,#020208)", fontFamily:"'Barlow',sans-serif", color:"#e8e8f0", display:"flex", flexDirection:"column" }}>
      <style>{`
        @keyframes blink{0%,100%{box-shadow:0 0 5px currentColor}50%{box-shadow:0 0 14px currentColor}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
        @keyframes wave{0%,100%{transform:scaleY(.3)}50%{transform:scaleY(1)}}
        *{box-sizing:border-box}
        ::-webkit-scrollbar{width:3px}::-webkit-scrollbar-track{background:#0a0a18}::-webkit-scrollbar-thumb{background:#1a1a2e;border-radius:2px}
      `}</style>
      <link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;600;700&family=Barlow+Condensed:wght@600;700;800&display=swap" rel="stylesheet"/>

      {/* TOP BAR */}
      <div style={{ background:"#06060f99", backdropFilter:"blur(12px)", borderBottom:"1px solid #0f0f1e", padding:"6px 14px", display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
        <div onClick={()=>leave()} style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:18, letterSpacing:3, background:"linear-gradient(90deg,#00d4ff,#ff6b35)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent", cursor:"pointer" }}>COLLAB//MIX</div>
        <div style={{ flex:1, display:"flex", gap:10, alignItems:"center" }}>
          <div style={{ display:"flex", gap:5, alignItems:"center", fontSize:7, fontFamily:"monospace" }}>
            <div style={{ width:5, height:5, borderRadius:"50%", background:SC[sync.status], boxShadow:sync.status==="connected"?`0 0 8px ${SC[sync.status]}`:""}}/>
            <span style={{ color:SC[sync.status] }}>{sync.status.toUpperCase()}</span>
            {sync.ping&&<span style={{ color:"#2a2a3a" }}>· {sync.ping}ms</span>}
          </div>
          {sync.connErr && <span style={{ fontSize:7, fontFamily:"monospace", color:"#ef4444", background:"#ef444411", border:"1px solid #ef444422", borderRadius:4, padding:"1px 7px" }}>{sync.connErr}</span>}
          {sync.partner&&<div style={{ fontSize:7, fontFamily:"monospace", color:"#ff6b35", background:"#ff6b3511", border:"1px solid #ff6b3522", borderRadius:5, padding:"2px 7px" }}>⟺ {sync.partner}</div>}
          {rtc.state==="connected"&&<div style={{ fontSize:7, fontFamily:"monospace", color:"#22c55e", background:"#22c55e11", border:"1px solid #22c55e22", borderRadius:5, padding:"2px 7px" }}>⚡ AUDIO LIVE</div>}
          {rec.state==="recording"&&<div style={{ fontSize:7, fontFamily:"monospace", color:"#ef4444", background:"#ef444411", border:"1px solid #ef444422", borderRadius:5, padding:"2px 7px", animation:"pulse .8s infinite" }}>● REC {String(Math.floor(rec.dur/60)).padStart(2,"0")}:{String(Math.floor(rec.dur%60)).padStart(2,"0")}</div>}
          {midi.active&&<div style={{ fontSize:7, fontFamily:"monospace", color:"#a855f7", background:"#a855f711", border:"1px solid #a855f722", borderRadius:5, padding:"2px 7px" }}>⎍ {midi.active.name}</div>}
        </div>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          <VU an={eng.current?.masterAn} color="#22c55e" w={45}/>
          <input type="range" min={0} max={1.2} step={.01} value={mvol} onChange={e=>setMvol(Number(e.target.value))} style={{ width:50, cursor:"pointer", accentColor:"#22c55e" }}/>
          <span style={{ fontSize:6, fontFamily:"monospace", color:"#333" }}>MASTER</span>
          <ShareButton room={session.room}/>
          <button onClick={leave} style={{ ...sBtn("#ef4444"), fontSize:7, height:22, padding:"0 8px" }}>✕ LEAVE</button>
        </div>
      </div>

      {/* MAIN LAYOUT */}
      <div style={{ flex:1, display:"grid", gridTemplateColumns:"1fr 155px 1fr 195px", gap:8, padding:9, minHeight:0, overflow:"hidden" }}>

        {/* MY DECKS */}
        <div style={{ display:"flex", flexDirection:"column", gap:6, overflowY:"auto" }}>
          <div style={{ display:"flex", gap:5, alignItems:"center" }}>
            <div style={{ width:5, height:5, borderRadius:"50%", background:"#00d4ff", boxShadow:"0 0 7px #00d4ff" }}/>
            <span style={{ fontSize:7, fontFamily:"monospace", color:"#00d4ff", letterSpacing:2 }}>{session.name} (YOU)</span>
          </div>
          <Deck id="A" ch={eng.current?.A} ctx={eng.current?.ctx} color="#00d4ff" local onChange={dh("A")} midi={midiEvt} bpmResult={bpm.results["A"]} bpmAnalyze={bpm.analyze}/>
          <Deck id="B" ch={eng.current?.B} ctx={eng.current?.ctx} color="#3b82f6" local onChange={dh("B")} midi={midiEvt} bpmResult={bpm.results["B"]} bpmAnalyze={bpm.analyze}/>
        </div>

        {/* CENTER MIXER */}
        <div style={{ display:"flex", flexDirection:"column", gap:8, overflowY:"auto" }}>
          <div style={{ background:"#09091a", border:"1px solid #141424", borderRadius:12, padding:"11px 9px", display:"flex", flexDirection:"column", gap:8 }}>
            <div style={{ fontSize:6, fontFamily:"monospace", color:"#333", letterSpacing:2, textAlign:"center" }}>CROSSFADER</div>
            <div style={{ display:"flex", justifyContent:"space-between", fontSize:7, fontFamily:"monospace" }}>
              <span style={{ color:"#00d4ff" }}>A {(xg(xf).a*100).toFixed(0)}%</span>
              <span style={{ color:"#ff6b35" }}>B {(xg(xf).b*100).toFixed(0)}%</span>
            </div>
            <div style={{ position:"relative", height:24, display:"flex", alignItems:"center" }}>
              <div style={{ width:"100%", height:4, borderRadius:2, background:`linear-gradient(90deg,#00d4ff ${xf*100}%,#ff6b35 ${xf*100}%)`, border:"1px solid #141424" }}/>
              <input type="range" min={0} max={1} step={.005} value={xf} onChange={e=>setXfLocal(Number(e.target.value))} style={{ position:"absolute", width:"100%", opacity:0, cursor:"pointer", height:24 }}/>
              <div style={{ position:"absolute", left:`calc(${xf*100}% - 10px)`, width:20, height:20, background:"linear-gradient(135deg,#1c1c30,#0e0e1e)", border:"2px solid #e8e8f077", borderRadius:4, boxShadow:"0 2px 8px rgba(0,0,0,.6)", pointerEvents:"none", display:"flex", alignItems:"center", justifyContent:"center" }}>
                <div style={{ width:2, height:10, background:"#e8e8f0", borderRadius:1 }}/>
              </div>
            </div>
            <button onClick={()=>setXfLocal(.5)} style={{ ...sBtn("#334"), fontSize:6, height:16, width:"100%", justifyContent:"center" }}>CENTER</button>
            <div style={{ height:1, background:"#0f0f1e" }}/>
            {[["ROOM",session.room],["YOU",session.name],["PARTNER",sync.partner||"—"],["PING",sync.ping?`${sync.ping}ms`:"—"],["AUDIO",rtc.state==="connected"?"LIVE":"OFF"],["REC",rec.state==="recording"?"● LIVE":rec.recs.length>0?`${rec.recs.length} SAVED`:"OFF"]].map(([l,v])=>(
              <div key={l} style={{ display:"flex", justifyContent:"space-between", fontSize:6, fontFamily:"monospace" }}>
                <span style={{ color:"#2a2a3a" }}>{l}</span>
                <span style={{ color:l==="AUDIO"&&rtc.state==="connected"?"#22c55e":l==="REC"&&rec.state==="recording"?"#ef4444":"#444" }}>{v}</span>
              </div>
            ))}
          </div>
        </div>

        {/* PARTNER DECKS */}
        <div style={{ display:"flex", flexDirection:"column", gap:6, overflowY:"auto" }}>
          <div style={{ display:"flex", gap:5, alignItems:"center" }}>
            <div style={{ width:5, height:5, borderRadius:"50%", background:sync.partner?"#ff6b35":"#333", transition:"all .3s" }}/>
            <span style={{ fontSize:7, fontFamily:"monospace", color:sync.partner?"#ff6b35":"#333", letterSpacing:2 }}>{sync.partner||"WAITING FOR PARTNER..."}</span>
          </div>
          <Deck id="A" ch={null} ctx={null} color="#ff6b35" remote={pA} bpmResult={null} bpmAnalyze={null}/>
          <Deck id="B" ch={null} ctx={null} color="#f59e0b" remote={pB} bpmResult={null} bpmAnalyze={null}/>
        </div>

        {/* RIGHT SIDEBAR */}
        <div style={{ background:"#07070f", border:"1px solid #0f0f1e", borderRadius:12, display:"flex", flexDirection:"column", overflow:"hidden" }}>
          <div style={{ display:"flex", borderBottom:"1px solid #0f0f1e", flexShrink:0, flexWrap:"wrap" }}>
            {PANELS.map(([id,l])=>(
              <button key={id} onClick={()=>setPanel(id)} style={{ flex:1, padding:"6px 2px", fontSize:6, fontFamily:"monospace", letterSpacing:.5, background:panel===id?"#0d0d20":"transparent", color:panel===id?"#00d4ff":"#333", border:"none", borderBottom:`1px solid ${panel===id?"#00d4ff":"transparent"}`, cursor:"pointer", outline:"none", minWidth:32 }}>{l}</button>
            ))}
          </div>
          <div style={{ flex:1, overflow:"auto", display:"flex", flexDirection:"column" }}>
            {panel==="sync" && <SyncPanel bpmA={bpm.results.A?.bpm} bpmB={bpm.results.B?.bpm} rateA={rateA} rateB={rateB} onSyncB={()=>syncDecks("B",bpm.results.A?.bpm)} onSyncA={()=>syncDecks("A",bpm.results.B?.bpm)}/>}
            {panel==="rtc"  && <RTCPanel rtc={rtc} partner={sync.partner} syncOk={sync.status==="connected"}/>}
            {panel==="rec"  && <RecPanel rec={rec} ready={ready}/>}
            {panel==="chat" && <ChatPanel log={chat} send={msg=>sync.send({type:"chat",msg})} me={session.name}/>}
            {panel==="midi" && <MidiPanel midi={midi}/>}
          </div>
        </div>
      </div>
    </div>
  );
}
