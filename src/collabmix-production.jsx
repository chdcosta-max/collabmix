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

// ── Camelot wheel + recommendation engine ────────────────────
const CAMELOT = {
  "C":"8B","G":"9B","D":"10B","A":"11B","E":"12B","B":"1B","F#":"2B","Db":"3B","Ab":"4B","Eb":"5B","Bb":"6B","F":"7B",
  "Am":"8A","Em":"9A","Bm":"10A","F#m":"11A","C#m":"12A","G#m":"1A","D#m":"2A","A#m":"3A","Fm":"4A","Cm":"5A","Gm":"6A","Dm":"7A",
};
function camelotScore(a,b){
  if(!a||!b)return 0; if(a===b)return 1;
  const nA=parseInt(a),nB=parseInt(b),tA=a.slice(-1),tB=b.slice(-1);
  const diff=Math.min(Math.abs(nA-nB),12-Math.abs(nA-nB));
  if(tA===tB&&diff<=1)return .9; if(tA!==tB&&diff===0)return .8;
  if(tA===tB&&diff===2)return .5; return Math.max(0,.4-diff*.1);
}
function recommendTracks(current,library,limit=6){
  if(!current||library.length===0)return [];
  return library.filter(t=>t.id!==current.id&&t.analyzed).map(t=>{
    const bpmDiff=Math.abs((t.bpm||0)-(current.bpm||0));
    const bpmScore=bpmDiff===0?1:Math.max(0,1-bpmDiff/12);
    const keyScore=camelotScore(CAMELOT[current.key],CAMELOT[t.key]);
    const energyDiff=Math.abs((t.energy?.score||50)-(current.energy?.score||50));
    const energyScore=Math.max(0,1-energyDiff/100);
    const total=bpmScore*.40+keyScore*.35+energyScore*.25;
    const reasons=[];
    if(bpmDiff<=2)reasons.push(bpmDiff===0?"Same BPM":`${t.bpm>current.bpm?"+":""}${Math.round(t.bpm-current.bpm)} BPM`);
    if(keyScore>=.8)reasons.push(keyScore===1?"Same key":"Harmonic");
    if(energyDiff<=10)reasons.push("Matched energy");
    return {...t,score:total,bpmDiff,reasons:reasons.slice(0,2)};
  }).sort((a,b)=>b.score-a.score).slice(0,limit);
}

// ── ID3 parser (minimal) ──────────────────────────────────────
function parseID3(buffer){
  const bytes=new Uint8Array(buffer),view=new DataView(buffer),tags={};
  if(bytes[0]!==0x49||bytes[1]!==0x44||bytes[2]!==0x33)return tags;
  const ver=bytes[3];
  const size=((bytes[6]&0x7F)<<21)|((bytes[7]&0x7F)<<14)|((bytes[8]&0x7F)<<7)|(bytes[9]&0x7F);
  let off=10;const end=Math.min(off+size,buffer.byteLength);
  const fmap={"TIT2":"title","TPE1":"artist","TBPM":"bpm","TKEY":"key","TCON":"genre","TALB":"album"};
  function rStr(o,len){const enc=bytes[o];const sl=bytes.slice(o+1,o+len);try{return enc===1||enc===2?new TextDecoder("utf-16").decode(sl).replace(/\0/g,"").trim():new TextDecoder("utf-8").decode(sl).replace(/\0/g,"").trim();}catch{return "";}}
  while(off+10<end){
    const fid=String.fromCharCode(bytes[off],bytes[off+1],bytes[off+2],bytes[off+3]);
    if(!fid.match(/^[A-Z0-9]{4}$/))break;
    const fsz=ver>=4?((bytes[off+4]&0x7F)<<21)|((bytes[off+5]&0x7F)<<14)|((bytes[off+6]&0x7F)<<7)|(bytes[off+7]&0x7F):view.getUint32(off+4);
    if(fmap[fid]&&fsz>1)tags[fmap[fid]]=rStr(off+10,fsz);
    off+=10+fsz; if(fsz===0)break;
  }
  return tags;
}

// ── Library analysis worker ───────────────────────────────────
const LIB_WORKER=`
function bpf(s,sr,lo,hi){const o=new Float32Array(s.length);const rL=1/(2*Math.PI*hi/sr+1),rH=1/(2*Math.PI*lo/sr+1);let pi=0,po=0;const hp=new Float32Array(s.length);for(let i=0;i<s.length;i++){hp[i]=rH*(po+s[i]-pi);pi=s[i];po=hp[i];}let pv=0;for(let i=0;i<hp.length;i++){pv=o[i]=pv+(1-rL)*(hp[i]-pv);}return o;}
function dbpm(mono,sr){const ar=200,hop=Math.floor(sr/ar),nf=Math.floor(mono.length/hop);const f=bpf(mono,sr,100,400);for(let i=0;i<f.length;i++)f[i]=f[i]>0?f[i]:0;const env=new Float32Array(nf);for(let i=0;i<nf;i++){let s=0;const st=i*hop,en=Math.min(st+hop,mono.length);for(let j=st;j<en;j++)s+=f[j]*f[j];env[i]=Math.sqrt(s/(en-st));}const on=new Float32Array(nf);for(let i=1;i<nf;i++){const d=env[i]-env[i-1];on[i]=d>0?d:0;}const mn=on.reduce((s,v)=>s+v,0)/nf;const sd=Math.sqrt(on.reduce((s,v)=>s+(v-mn)**2,0)/nf)||1;for(let i=0;i<nf;i++)on[i]=(on[i]-mn)/sd;const ml=Math.floor(60/200*ar),xl=Math.ceil(ar),al=xl-ml+1;const ac=new Float32Array(al);for(let li=0;li<al;li++){const lag=li+ml;let s=0;for(let i=0;i<nf-lag;i++)s+=on[i]*on[i+lag];ac[li]=s/(nf-lag);}let best=0,bi=0;for(let i=0;i<ac.length;i++)if(ac[i]>best){best=ac[i];bi=i;}if(!best)return null;const raw=(60/(bi+ml))*ar;let b=raw;while(b<100)b*=2;while(b>175)b/=2;return Math.round(b*10)/10;}
function dkey(mono,sr){const fftSize=4096,hopSize=2048,NOTES=["C","C#","D","Eb","E","F","F#","G","Ab","A","Bb","B"];const chroma=new Float32Array(12);const win=new Float32Array(fftSize);for(let i=0;i<fftSize;i++)win[i]=0.5-0.5*Math.cos(2*Math.PI*i/fftSize);const hops=Math.min(Math.floor((mono.length-fftSize)/hopSize),40);for(let h=0;h<hops;h++){const st=h*hopSize;for(let pc=0;pc<12;pc++){const freq=440*Math.pow(2,(pc-9)/12);let re=0,im=0;for(let i=0;i<fftSize;i+=4){const s=mono[st+i]*win[i];const p=2*Math.PI*freq*i/sr;re+=s*Math.cos(p);im+=s*Math.sin(p);}chroma[pc]+=Math.sqrt(re*re+im*im);}}const mx=Math.max(...chroma);if(mx>0)for(let i=0;i<12;i++)chroma[i]/=mx;const majP=[6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];const minP=[6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];let best=-Infinity,bk="C";for(let r=0;r<12;r++){let ms=0,ns=0;for(let i=0;i<12;i++){ms+=chroma[(r+i)%12]*majP[i];ns+=chroma[(r+i)%12]*minP[i];}if(ms>best){best=ms;bk=NOTES[r];}if(ns>best){best=ns;bk=NOTES[r]+"m";}}return bk;}
function denergy(mono,sr){const chunk=Math.min(mono.length,sr*30);let rms=0;for(let i=0;i<chunk;i++)rms+=mono[i]*mono[i];rms=Math.sqrt(rms/chunk);let zc=0;for(let i=1;i<chunk;i++)if((mono[i]>=0)!==(mono[i-1]>=0))zc++;const rn=Math.min(1,rms*8),zn=Math.min(1,zc/(chunk/sr)/3000),score=rn*.7+zn*.3;const labels=["Ambient","Warm-Up","Build","Peak Hour","Hard"];const label=score<.25?"Ambient":score<.45?"Warm-Up":score<.65?"Build":score<.82?"Peak Hour":"Hard";return{score:Math.round(score*100),label};}
self.onmessage=function(e){
  const{cd,sr,id,skipBPM,skipKey}=e.data;
  const mono=new Float32Array(cd[0].length);
  for(let c=0;c<cd.length;c++){const d=cd[c];for(let i=0;i<mono.length;i++)mono[i]+=d[i]/cd.length;}
  const bpm=skipBPM?null:dbpm(mono,sr);
  const key=skipKey?null:dkey(mono,sr);
  const energy=denergy(mono,sr);
  self.postMessage({id,bpm,key,energy});
};`;
function createLibWorker(){return new Worker(URL.createObjectURL(new Blob([LIB_WORKER],{type:"application/javascript"})));}

// ── Energy color map ──────────────────────────────────────────
const ENERGY_COLOR={"Ambient":"#4A90D9","Warm-Up":"#22c55e","Build":"#f59e0b","Peak Hour":"#ff6b35","Hard":"#ef4444"};

// ── Shared IndexedDB helpers (cm_music_library — same DB as standalone library app) ──
const CM_DB_NAME="cm_music_library", CM_DB_VER=4;
function openCmDB(){
  return new Promise((res,rej)=>{
    const req=indexedDB.open(CM_DB_NAME,CM_DB_VER);
    req.onupgradeneeded=e=>{
      const db=e.target.result;
      if(!db.objectStoreNames.contains("tracks"))   db.createObjectStore("tracks",{keyPath:"id"});
      if(!db.objectStoreNames.contains("crates"))   db.createObjectStore("crates",{keyPath:"id"});
      if(!db.objectStoreNames.contains("handles"))  db.createObjectStore("handles",{keyPath:"id"});
      if(!db.objectStoreNames.contains("settings")) db.createObjectStore("settings");
      if(!db.objectStoreNames.contains("requests")) db.createObjectStore("requests",{keyPath:"id"});
      if(!db.objectStoreNames.contains("queue"))    db.createObjectStore("queue",{keyPath:"trackId"});
    };
    req.onsuccess=e=>res(e.target.result);
    req.onerror=e=>rej(e.target.error);
  });
}
async function cmDbAll(store){
  const db=await openCmDB();
  return new Promise((res,rej)=>{const tx=db.transaction(store,"readonly");const r=tx.objectStore(store).getAll();r.onsuccess=e=>res(e.target.result);r.onerror=e=>rej(e.target.error);});
}
async function cmDbGet(store,key){
  const db=await openCmDB();
  return new Promise((res,rej)=>{const tx=db.transaction(store,"readonly");const r=tx.objectStore(store).get(key);r.onsuccess=e=>res(e.target.result);r.onerror=e=>rej(e.target.error);});
}
async function cmDbDelete(store,key){
  const db=await openCmDB();
  return new Promise((res,rej)=>{const tx=db.transaction(store,"readwrite");const r=tx.objectStore(store).delete(key);r.onsuccess=()=>res();r.onerror=e=>rej(e.target.error);});
}

// ── useLibrary hook — reads from shared cm_music_library IDB ─────────────────
function useLibrary(){
  const [library,setLibrary]=useState([]);
  const [queue,setQueue]=useState([]);   // ordered array of trackIds in session queue
  const [importing,setImporting]=useState(false);
  const workerRef=useRef(null),queueRef=useRef([]),activeRef=useRef(false),fileMap=useRef({});
  const audioCtx=useRef(null);

  // Load tracks from shared IDB and poll for updates from the library app
  useEffect(()=>{
    const load=async()=>{
      try{
        const tracks=await cmDbAll("tracks");
        if(tracks.length>0) setLibrary(tracks);
        const q=await cmDbAll("queue");
        setQueue(q.sort((a,b)=>a.order-b.order).map(r=>r.trackId));
      }catch{}
    };
    load();
    const iv=setInterval(load,5000);
    return()=>clearInterval(iv);
  },[]);

  useEffect(()=>{
    workerRef.current=createLibWorker();
    workerRef.current.onmessage=(e)=>{
      const{id,bpm,key,energy}=e.data;
      setLibrary(prev=>prev.map(t=>t.id===id?{...t,bpm:bpm||t.bpm,key:key||t.key,energy,analyzed:true}:t));
      activeRef.current=false; processQ();
    };
    return()=>workerRef.current?.terminate();
  },[]);

  const processQ=useCallback(()=>{
    if(activeRef.current||queueRef.current.length===0)return;
    const{id,file,skipBPM,skipKey}=queueRef.current.shift();
    activeRef.current=true;
    (async()=>{
      try{
        if(!audioCtx.current)audioCtx.current=new(window.AudioContext||window.webkitAudioContext)();
        const ab=await file.arrayBuffer();
        const buf=await audioCtx.current.decodeAudioData(ab);
        setLibrary(prev=>prev.map(t=>t.id===id?{...t,duration:buf.duration}:t));
        const cd=[];for(let c=0;c<buf.numberOfChannels;c++)cd.push(buf.getChannelData(c).slice());
        workerRef.current.postMessage({cd,sr:buf.sampleRate,id,skipBPM,skipKey});
      }catch{
        setLibrary(prev=>prev.map(t=>t.id===id?{...t,analyzed:true,error:true}:t));
        activeRef.current=false; processQ();
      }
    })();
  },[]);

  // Quick-add files directly in the mixer (in-memory only, doesn't save to IDB)
  const importFiles=useCallback(async(files)=>{
    const audio=[...files].filter(f=>f.type.startsWith("audio/")||f.name.match(/\.(mp3|wav|flac|aac|ogg|m4a)$/i));
    if(!audio.length)return;
    setImporting(true);
    for(const file of audio){
      const id=`t_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
      let tags={};
      try{const sl=file.slice(0,262144);tags=parseID3(await sl.arrayBuffer());}catch{}
      const track={id,filename:file.name.replace(/\.[^.]+$/,""),title:tags.title||file.name.replace(/\.[^.]+$/,""),artist:tags.artist||"",album:tags.album||"",genre:tags.genre||"",bpm:tags.bpm?parseFloat(tags.bpm):null,key:tags.key||null,duration:null,energy:null,analyzed:false,error:false,addedAt:Date.now()};
      fileMap.current[id]=file;
      setLibrary(prev=>{if(prev.find(t=>t.filename===track.filename))return prev;return [...prev,track];});
      queueRef.current.push({id,file,skipBPM:!!track.bpm,skipKey:!!track.key});
    }
    setImporting(false); processQ();
  },[processQ]);

  // Get File object — in-memory first, then IDB handle (from library app)
  const getFile=useCallback(async(id)=>{
    if(fileMap.current[id]) return fileMap.current[id];
    try{
      const handle=await cmDbGet("handles",id);
      if(!handle) return null;
      const perm=await handle.queryPermission({mode:"read"});
      if(perm!=="granted"){
        const req=await handle.requestPermission({mode:"read"});
        if(req!=="granted") return null;
      }
      const file=await handle.getFile();
      fileMap.current[id]=file;
      return file;
    }catch{return null;}
  },[]);

  const clear=()=>{setLibrary([]);fileMap.current={};};

  return{library,queue,importing,importFiles,getFile,clear};
}

// ── Library Panel UI ──────────────────────────────────────────
function TrackRow({track, onLoadA, onLoadB, isRec, reasons, isPartner, canLoad}){
  const [hov,setHov]=useState(false);
  const G="#C8A96E";
  const eColor=ENERGY_COLOR[track.energy?.label]||"#444";
  const fmt=(s)=>s?`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,"0")}`:"--";
  const camelot=CAMELOT[track.key];
  const isMinor=camelot?.endsWith("A");
  const keyColor=isMinor?"#8B6EAF":G;

  return(
    <div
      onMouseEnter={()=>setHov(true)}
      onMouseLeave={()=>setHov(false)}
      style={{
        display:"grid",
        gridTemplateColumns:"1fr 52px 44px 72px 40px 64px",
        gap:6,
        alignItems:"center",
        padding:"7px 10px",
        borderRadius:5,
        marginBottom:1,
        background:isRec?"#22c55e07":hov?"#1C183099":"transparent",
        border:`1px solid ${isRec?"#22c55e18":hov?"#C8A96E14":"transparent"}`,
        transition:"all .1s",
        cursor:"default",
      }}
    >
      <div style={{overflow:"hidden",minWidth:0}}>
        <div style={{display:"flex",gap:5,alignItems:"center"}}>
          {isRec&&<div style={{width:4,height:4,borderRadius:"50%",background:"#22c55e",boxShadow:"0 0 4px #22c55e",flexShrink:0}}/>}
          {!track.analyzed&&!track.error&&<div style={{width:8,height:8,border:`1.5px solid ${G}33`,borderTop:`1.5px solid ${G}`,borderRadius:"50%",animation:"spin 1s linear infinite",flexShrink:0}}/>}
          <div style={{fontSize:11,color:hov?"#EDE8DF":"#c0bcd8",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",fontFamily:"'DM Sans',sans-serif",fontWeight:400}}>{track.title||track.filename}</div>
        </div>
        <div style={{fontSize:9,color:"#5a556a",fontFamily:"'DM Mono',monospace",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",marginTop:1}}>{track.artist||"Unknown Artist"}</div>
        {reasons?.length>0&&(
          <div style={{display:"flex",gap:3,marginTop:2}}>
            {reasons.map(r=><span key={r} style={{fontSize:7,fontFamily:"'DM Mono',monospace",color:"#22c55e",background:"#22c55e11",borderRadius:2,padding:"0 4px",letterSpacing:.5}}>{r}</span>)}
          </div>
        )}
      </div>
      <div style={{textAlign:"right"}}>
        <div style={{fontSize:11,fontFamily:"'DM Mono',monospace",color:track.bpm?G:"#2a2a3a",fontWeight:500}}>{track.bpm?track.bpm.toFixed(1):"--"}</div>
        <div style={{fontSize:7,color:"#3A3555",fontFamily:"'DM Mono',monospace",letterSpacing:1}}>BPM</div>
      </div>
      <div style={{textAlign:"center"}}>
        {camelot?(
          <>
            <div style={{fontSize:9,fontFamily:"'DM Mono',monospace",color:keyColor,background:keyColor+"18",borderRadius:3,padding:"1px 4px",display:"inline-block"}}>{camelot}</div>
            <div style={{fontSize:7,color:"#3A3555",fontFamily:"'DM Mono',monospace",marginTop:1}}>{track.key}</div>
          </>
        ):<div style={{fontSize:9,color:"#3A3555",fontFamily:"'DM Mono',monospace"}}>--</div>}
      </div>
      <div>
        {track.energy?(
          <>
            <div style={{height:3,background:"#0a0a18",borderRadius:2,marginBottom:3,overflow:"hidden"}}>
              <div style={{height:"100%",width:`${track.energy.score}%`,background:eColor,borderRadius:2}}/>
            </div>
            <div style={{fontSize:7,fontFamily:"'DM Mono',monospace",color:eColor,letterSpacing:.5,whiteSpace:"nowrap"}}>{track.energy.label}</div>
          </>
        ):<div style={{fontSize:8,color:"#3A3555",fontFamily:"'DM Mono',monospace"}}>--</div>}
      </div>
      <div style={{fontSize:9,fontFamily:"'DM Mono',monospace",color:"#5a556a",textAlign:"right"}}>{fmt(track.duration)}</div>
      <div style={{display:"flex",gap:3,opacity:hov&&canLoad?1:0,transition:"opacity .1s"}}>
        {onLoadA&&<button onClick={e=>{e.stopPropagation();onLoadA(track);}} style={{padding:"2px 6px",fontSize:7,fontFamily:"'DM Mono',monospace",background:"#00d4ff15",border:"1px solid #00d4ff30",color:"#00d4ff",borderRadius:3,cursor:"pointer",letterSpacing:.5}}>A</button>}
        {onLoadB&&<button onClick={e=>{e.stopPropagation();onLoadB(track);}} style={{padding:"2px 6px",fontSize:7,fontFamily:"'DM Mono',monospace",background:"#C8A96E15",border:"1px solid #C8A96E30",color:"#C8A96E",borderRadius:3,cursor:"pointer",letterSpacing:.5}}>B</button>}
      </div>
    </div>
  );
}

function LibraryCol({title, color, tracks, queue, onLoadA, onLoadB, playingTrack, partnerTracks, importing, onImport, onDrop, isOwn}){
  const [filter,setFilter]=useState("");
  const [sortBy,setSortBy]=useState("title");
  const [sortDir,setSortDir]=useState(1);
  // Default to "queue" if there are queued tracks, else "suggest" if playing, else "all"
  const defaultTab = queue?.length>0 ? "queue" : "all";
  const [tab,setTab]=useState(defaultTab);
  const fileRef=useRef(null);
  const G="#C8A96E";

  const selfRecs  = playingTrack&&tracks?.length>0 ? recommendTracks(playingTrack, tracks) : [];
  const crossRecs = playingTrack&&partnerTracks?.length>0 ? recommendTracks(playingTrack, partnerTracks) : [];
  const activeRecs= tab==="suggest" ? (isOwn ? selfRecs : crossRecs) : [];
  const recIds    = new Set(activeRecs.map(r=>r.id));

  // Queued tracks (in queue order)
  const queuedTracks = (queue||[]).map(id=>tracks.find(t=>t.id===id)).filter(Boolean);

  const baseTracks = tab==="queue" ? queuedTracks : tab==="suggest" ? activeRecs : tracks;
  const filtered = baseTracks
    .filter(t=>{const q=filter.toLowerCase();return !q||t.title?.toLowerCase().includes(q)||t.artist?.toLowerCase().includes(q)||t.genre?.toLowerCase().includes(q);})
    .sort((a,b)=>{const va=a[sortBy]||0,vb=b[sortBy]||0;return(typeof va==="string"?va.localeCompare(vb):(va-vb))*sortDir;});

  const colHdr=(label,key)=>(
    <div onClick={()=>{if(sortBy===key)setSortDir(d=>-d);else{setSortBy(key);setSortDir(1);}}} style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:sortBy===key?G:"#3A3555",cursor:"pointer",letterSpacing:1,userSelect:"none",whiteSpace:"nowrap"}}>
      {label}{sortBy===key?(sortDir===1?" ↑":" ↓"):""}
    </div>
  );

  const tabs = isOwn
    ? [["queue",`QUEUE${queuedTracks.length>0?` (${queuedTracks.length})`:""}`],["suggest",`SUGGEST (${selfRecs.length})`],["all","ALL"]]
    : [["suggest",`SUGGEST (${crossRecs.length})`],["all","ALL"]];

  return(
    <div style={{display:"flex",flexDirection:"column",height:"100%",overflow:"hidden"}}>
      <div style={{padding:"10px 10px 8px",borderBottom:`1px solid ${color}18`,flexShrink:0}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
          <div style={{display:"flex",gap:6,alignItems:"center"}}>
            <div style={{width:7,height:7,borderRadius:"50%",background:color,boxShadow:`0 0 6px ${color}`}}/>
            <span style={{fontFamily:"'DM Mono',monospace",fontSize:10,color,letterSpacing:2}}>{title}</span>
            <span style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#3A3555"}}>{tracks.length} tracks</span>
            {importing&&<div style={{width:9,height:9,border:`1.5px solid ${G}33`,borderTop:`1.5px solid ${G}`,borderRadius:"50%",animation:"spin 1s linear infinite"}}/>}
          </div>
          {isOwn&&(
            <button onClick={()=>fileRef.current?.click()} style={{padding:"3px 10px",fontSize:8,fontFamily:"'DM Mono',monospace",background:G+"11",border:`1px solid ${G}33`,color:G,borderRadius:5,cursor:"pointer",letterSpacing:1}}>+ ADD</button>
          )}
        </div>
        <div style={{display:"flex",gap:3,marginBottom:8}}>
          {tabs.map(([id,l])=>(
            <button key={id} onClick={()=>setTab(id)} style={{padding:"3px 9px",fontSize:7,fontFamily:"'DM Mono',monospace",letterSpacing:1,background:tab===id?color+"18":"transparent",color:tab===id?color:"#3A3555",border:`1px solid ${tab===id?color+"33":"#1C1830"}`,borderRadius:4,cursor:"pointer",outline:"none"}}>{l}</button>
          ))}
        </div>
        <input value={filter} onChange={e=>setFilter(e.target.value)} placeholder="Search..." style={{width:"100%",background:"#080710",border:`1px solid #1C1830`,color:"#d0d0e0",borderRadius:5,padding:"5px 9px",fontSize:9,fontFamily:"'DM Mono',monospace",outline:"none"}}/>
      </div>
      {baseTracks.length>0&&(
        <div style={{display:"grid",gridTemplateColumns:"1fr 52px 44px 72px 40px 64px",gap:6,padding:"6px 10px",borderBottom:"1px solid #0a0a14",flexShrink:0}}>
          {colHdr("TITLE","title")}
          {colHdr("BPM","bpm")}
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#3A3555",letterSpacing:1,textAlign:"center"}}>KEY</div>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#3A3555",letterSpacing:1}}>ENERGY</div>
          {colHdr("TIME","duration")}
          <div/>
        </div>
      )}
      <div style={{flex:1,overflowY:"auto",padding:"3px 4px"}} onDragOver={isOwn?e=>{e.preventDefault();}:undefined} onDrop={isOwn?onDrop:undefined}>
        {tab==="queue"&&queuedTracks.length===0?(
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",gap:10,padding:16}}>
            <div style={{fontSize:28,opacity:.15}}>◉</div>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#3A3555",textAlign:"center",letterSpacing:1,lineHeight:2}}>
              NO TRACKS QUEUED<br/>
              <span style={{color:"#22c55e55"}}>Open the Music Library →<br/>hover a track → click + QUEUE</span>
            </div>
          </div>
        ):tracks.length===0&&isOwn?(
          <div onClick={()=>fileRef.current?.click()} style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",gap:12,cursor:"pointer",padding:20,border:`2px dashed #C8A96E18`,borderRadius:8,margin:8}}>
            <div style={{fontSize:32,opacity:.2}}>♫</div>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#3A3555",textAlign:"center",letterSpacing:1,lineHeight:2}}>DROP TRACKS HERE<br/>OR CLICK ADD<br/><br/>MP3 WAV FLAC AAC</div>
          </div>
        ):tracks.length===0?(
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",gap:8,padding:16}}>
            <div style={{fontSize:24,opacity:.15}}>♫</div>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#1e1e2e",textAlign:"center",letterSpacing:1,lineHeight:1.8}}>WAITING FOR<br/>PARTNER LIBRARY</div>
          </div>
        ):(
          filtered.map(track=>{
            const recData=activeRecs.find(r=>r.id===track.id);
            return(
              <TrackRow
                key={track.id}
                track={track}
                onLoadA={isOwn?()=>onLoadA(track):null}
                onLoadB={isOwn?()=>onLoadB(track):null}
                isRec={recIds.has(track.id)}
                reasons={recData?.reasons}
                isPartner={!isOwn}
                canLoad={isOwn}
              />
            );
          })
        )}
      </div>
      {isOwn&&<input ref={fileRef} type="file" accept="audio/*" multiple style={{display:"none"}} onChange={e=>onImport(e.target.files)}/>}
    </div>
  );
}

function LibraryPanel({lib, onLoad, playingTrack}){
  const handleDrop=(e)=>{e.preventDefault();lib.importFiles([...e.dataTransfer.files]);};
  return(
    <div style={{display:"flex",flexDirection:"column",height:"100%",overflow:"hidden"}}>
      <LibraryCol
        title="YOUR LIBRARY"
        color="#00d4ff"
        tracks={lib.library}
        queue={lib.queue}
        onLoadA={(t)=>onLoad(t,"A")}
        onLoadB={(t)=>onLoad(t,"B")}
        playingTrack={playingTrack}
        partnerTracks={[]}
        importing={lib.importing}
        onImport={lib.importFiles}
        onDrop={handleDrop}
        isOwn
      />
    </div>
  );
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
        if(m.type==="joined"){setPartner(m.partnerName);}
        if(m.type==="partner_joined"){setPartner(m.djName);sync.send({type:"sync_request"});}
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

function WF({ buf, peaks, freq, prog, onSeek, h=80 }) {
  const ref=useRef(null);
  useEffect(()=>{
    if(!ref.current)return;
    const canvas=ref.current;
    const dpr=window.devicePixelRatio||1;
    const W=canvas.clientWidth||460, H=h;
    canvas.width=W*dpr; canvas.height=H*dpr;
    const ctx=canvas.getContext("2d");
    ctx.scale(dpr,dpr);
    ctx.clearRect(0,0,W,H);
    const px=Math.floor(prog*W);
    let rawAmp=null,rawFreq=null;

    if(buf){
      const step=Math.max(1,Math.floor(buf.length/W));
      rawAmp=new Float32Array(W); rawFreq=new Float32Array(W);
      for(let ch=0;ch<buf.numberOfChannels;ch++){
        const d=buf.getChannelData(ch);
        for(let x=0;x<W;x++){
          let mx=0,zcr=0; const s=x*step;
          for(let j=0;j<step;j++) mx=Math.max(mx,Math.abs(d[s+j]||0));
          for(let j=1;j<step;j++) if((d[s+j]>=0)!==(d[s+j-1]>=0))zcr++;
          if(mx>rawAmp[x]){rawAmp[x]=mx; rawFreq[x]=Math.min(1,(zcr/step)*4);}
        }
      }
    } else if(peaks&&peaks.length){
      rawAmp=peaks; rawFreq=freq||null;
    }

    if(rawAmp){
      let maxP=0; for(let x=0;x<rawAmp.length;x++)maxP=Math.max(maxP,rawAmp[x]); if(maxP<0.001)maxP=1;
      const step=rawAmp.length/W, mid=H/2;
      // Center line
      ctx.fillStyle="#ffffff08"; ctx.fillRect(0,mid-1,W,1);
      for(let x=0;x<W;x++){
        const i=Math.min(rawAmp.length-1,Math.floor(x*step));
        // Power 0.3 — much more aggressive than sqrt, fills the canvas
        const norm=Math.pow((rawAmp[i]||0)/maxP, 0.3);
        const bh=Math.max(1.5, norm*(mid-2)*0.98);
        const fr=rawFreq?(rawFreq[i]||0):0.5;
        const hue=fr*180; // 0=red, 90=yellow, 180=cyan
        const played=x<px;
        // Draw bar with gradient: bright peak, slightly dimmer root
        const grad=ctx.createLinearGradient(0,mid-bh,0,mid+bh);
        if(played){
          grad.addColorStop(0,  `hsl(${hue},100%,72%)`);
          grad.addColorStop(0.4,`hsl(${hue},100%,55%)`);
          grad.addColorStop(0.5,`hsl(${hue}, 80%,30%)`);
          grad.addColorStop(0.6,`hsl(${hue},100%,55%)`);
          grad.addColorStop(1,  `hsl(${hue},100%,72%)`);
        } else {
          grad.addColorStop(0,  `hsl(${hue},70%,32%)`);
          grad.addColorStop(0.4,`hsl(${hue},70%,22%)`);
          grad.addColorStop(0.5,`hsl(${hue},40%,12%)`);
          grad.addColorStop(0.6,`hsl(${hue},70%,22%)`);
          grad.addColorStop(1,  `hsl(${hue},70%,32%)`);
        }
        ctx.fillStyle=grad;
        ctx.fillRect(x,mid-bh,1,bh*2);
      }
      // Playhead
      const phGrad=ctx.createLinearGradient(px,0,px+2,0);
      phGrad.addColorStop(0,"#ffffff");phGrad.addColorStop(1,"#ffffff99");
      ctx.fillStyle=phGrad; ctx.shadowColor="#fff"; ctx.shadowBlur=12;
      ctx.fillRect(px,0,2,H); ctx.shadowBlur=0;
    } else {
      // Empty state — visible center line + subtle grid
      ctx.fillStyle="#ffffff12";
      ctx.fillRect(0,H/2-1,W,1);
      ctx.fillStyle="#ffffff07";
      for(let x=0;x<W;x+=20)ctx.fillRect(x,0,1,H);
      for(let y=0;y<H;y+=Math.floor(H/4))ctx.fillRect(0,y,W,1);
    }
  },[buf,peaks,freq,prog]);

  const onClick=e=>{
    if(!onSeek||!ref.current)return;
    const r=ref.current.getBoundingClientRect();
    onSeek((e.clientX-r.left)/r.width);
  };
  return <canvas ref={ref} onClick={onClick} style={{width:"100%",height:h,background:"#03030e",borderRadius:6,cursor:onSeek?"crosshair":"default",display:"block"}}/>;
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
function Deck({ id, ch, ctx:ac, color, local, remote, onChange, midi:mt, bpmResult, bpmAnalyze, eqHi=0, eqMid=0, eqLo=0, chanVol=1, loadFromLibrary=null, onTrackInfo=null }) {
  const [buf,setBuf]=useState(null),[name,setName]=useState(null),[play,setPlay]=useState(false);
  const [prog,setProg]=useState(0),[dur,setDur]=useState(0);
  const [hi,setHi]=useState(0),[mid,setMid]=useState(0),[lo,setLo]=useState(0),[vol,setVol]=useState(1);
  const [rate,setRate]=useState(1); // FIX: track actual playback rate
  const [dragOver,setDragOver]=useState(false);
  const [wfPeaks,setWfPeaks]=useState(null),[wfFreq,setWfFreq]=useState(null);
  const src=useRef(null),st=useRef(0),off=useRef(0),raf=useRef(null),fr=useRef(null);
  // EQ is now passed as props: eqHi, eqMid, eqLo, chanVol
  const remProgRef=useRef(0),remTimeRef=useRef(0),remRateRef=useRef(0),remRaf=useRef(null);

  // Prevent browser from navigating to dropped files
  useEffect(()=>{
    if(!local)return;
    const stop=(e)=>{e.preventDefault();e.stopPropagation();};
    document.addEventListener("dragover",stop);
    document.addEventListener("drop",stop);
    return()=>{document.removeEventListener("dragover",stop);document.removeEventListener("drop",stop);};
  },[local]);

  // Apply EQ and channel vol from props
  useEffect(()=>{if(ch){ch.hi.gain.value=eqHi;ch.mid.gain.value=eqMid;ch.lo.gain.value=eqLo;ch.vol.gain.value=chanVol;}},[ch,eqHi,eqMid,eqLo,chanVol]);

  // Mirror remote state + smooth interpolation for playhead
  useEffect(()=>{
    if(!remote||local)return;
    const wasPlaying=play; const nowPlaying=remote.playing||false;
    setPlay(nowPlaying);
    // EQ values now come from parent props when remote is true
    if(remote.trackName)setName(remote.trackName);
    if(remote.duration)setDur(remote.duration);
    if(remote.waveformPeaks)setWfPeaks(remote.waveformPeaks);
    if(remote.waveformFreq)setWfFreq(remote.waveformFreq);
    // Update interpolation refs when we get a new progress value
    if(remote.progress!=null){
      const now=performance.now();
      if(remTimeRef.current>0&&remProgRef.current!=null){
        const dt=now-remTimeRef.current;
        if(dt>0) remRateRef.current=(remote.progress-remProgRef.current)/dt;
      }
      remProgRef.current=remote.progress;
      remTimeRef.current=now;
      setProg(remote.progress);
    }
    // Start/stop smooth interpolation RAF
    cancelAnimationFrame(remRaf.current);
    if(nowPlaying){
      const animate=()=>{
        const elapsed=performance.now()-remTimeRef.current;
        const interp=Math.min(1,Math.max(0,remProgRef.current+remRateRef.current*elapsed));
        setProg(interp);
        remRaf.current=requestAnimationFrame(animate);
      };
      remRaf.current=requestAnimationFrame(animate);
    }
    return()=>cancelAnimationFrame(remRaf.current);
  },[remote,local]);

  // MIDI routing — EQ now handled by parent component when local
  const sfx=`DECK_${id}`;
  useEffect(()=>{ if(!mt||!local)return; const{actionKey:ak,value:v}=mt; if(ak===`${sfx}_PLAY`&&v===true)toggle(); if(ak===`${sfx}_CUE`&&v===true)cue(); },[mt]);

  const stop_=()=>{ if(src.current){try{src.current.stop();}catch{}src.current.disconnect();src.current=null;}cancelAnimationFrame(raf.current); };

  const play_=(o)=>{ if(!buf||!ch||!ac)return; stop_(); if(ac.state==="suspended")ac.resume();
    const s=ac.createBufferSource(); s.buffer=buf; s.playbackRate.value=rate; s.connect(ch.trim); s.start(0,o);
    s.onended=()=>{setPlay(false);setProg(0);off.current=0;onChange?.("playing",false);};
    src.current=s; st.current=ac.currentTime; off.current=o;
    const tick=()=>{ const c=off.current+(ac.currentTime-st.current); const p=Math.min(1,c/buf.duration); setProg(p); onChange?.("progress",p); if(c<buf.duration)raf.current=requestAnimationFrame(tick); }; tick(); };

  const toggle=useCallback(()=>{ if(!buf)return; if(play){off.current=Math.min(buf.duration,off.current+(ac.currentTime-st.current));stop_();setPlay(false);onChange?.("playing",false);}else{play_(off.current);setPlay(true);onChange?.("playing",true);} },[buf,play,ac,rate]);
  const seek  =useCallback((p)=>{ const o=p*(buf?.duration||0);off.current=o;if(play)play_(o);else setProg(p);onChange?.("progress",p); },[buf,play,rate]);
  const cue   =useCallback(()=>{ off.current=0;setProg(0);if(play){stop_();setPlay(false);onChange?.("playing",false);}onChange?.("progress",0); },[play]);

  // Load a file, optionally with library track metadata
  const load=async(f, trackMeta=null)=>{
    const ab=await f.arrayBuffer();
    const d=await ac.decodeAudioData(ab);
    stop_();setPlay(false);setProg(0);off.current=0;
    setBuf(d);setDur(d.duration);onChange?.("duration",d.duration);
    const n=(trackMeta?.title)||f.name.replace(/\.[^.]+$/,"");
    setName(n);onChange?.("trackName",n);
    bpmAnalyze?.(d, id);
    // If from library, report track info for recommendations
    if(trackMeta) onTrackInfo?.(id, trackMeta);
    else onTrackInfo?.(id, null);
    // Compute compact peaks + frequency ratio (ZCR-based) for all channels
    const W=460,step=Math.max(1,Math.floor(d.length/W));
    const pk=new Array(W).fill(0),fq=new Array(W).fill(0);
    for(let ch=0;ch<d.numberOfChannels;ch++){
      const data=d.getChannelData(ch);
      for(let x=0;x<W;x++){
        let mx=0,zcr=0; const s=x*step;
        for(let j=0;j<step;j++)mx=Math.max(mx,Math.abs(data[s+j]||0));
        for(let j=1;j<step;j++)if((data[s+j]>=0)!==(data[s+j-1]>=0))zcr++;
        if(mx>pk[x]){pk[x]=mx;fq[x]=Math.min(1,(zcr/step)*4);}
      }
    }
    const pkR=pk.map(v=>Math.round(v*1000)/1000);
    const fqR=fq.map(v=>Math.round(v*1000)/1000);
    setWfPeaks(pkR);setWfFreq(fqR);
    onChange?.("waveformPeaks",pkR);onChange?.("waveformFreq",fqR);
  };

  // Handle library load trigger from parent
  useEffect(()=>{
    if(!loadFromLibrary||!local)return;
    const{track,file}=loadFromLibrary;
    load(file, track);
  },[loadFromLibrary]);

  // Expose rate setter for beat sync (called from parent)
  useEffect(()=>{ if(src.current?.playbackRate){ src.current.playbackRate.setTargetAtTime(rate,ac?.currentTime||0,.05); } },[rate,ac]);

  const fmt=(s)=>`${String(Math.floor(Math.max(0,s)/60)).padStart(2,"0")}:${String(Math.floor(Math.max(0,s)%60)).padStart(2,"0")}`;
  const cur=prog*dur;

  const D="#14101E", BD="1px solid #C8A96E14";
  return (
    <div style={{background:D, border:`1px solid ${play?color+"55":"#C8A96E18"}`, borderRadius:12, overflow:"hidden", display:"flex", flexDirection:"column", boxShadow:play?`0 0 30px ${color}18, 0 0 0 1px #1C1830`:`0 4px 20px rgba(0,0,0,.6), 0 0 0 1px #1C1830`, transition:"all .3s"}}>

      {/* ── HEADER: badge | track | bpm ── */}
      <div style={{display:"flex", alignItems:"stretch", minHeight:54, borderBottom:BD}}>
        <div style={{width:52, flexShrink:0, background:`linear-gradient(180deg,${color}15,${color}08)`, borderRight:`1px solid ${color}33`, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:3}}>
          <span style={{fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:26, color, lineHeight:1, textShadow:`0 0 16px ${color}aa`}}>{id}</span>
          <span style={{fontSize:9, color:color+"99", fontFamily:"'Barlow Condensed',sans-serif", fontWeight:700, letterSpacing:2}}>{local?"YOU":"PRTNR"}</span>
          {play&&<div style={{width:5,height:5,borderRadius:"50%",background:color,boxShadow:`0 0 10px ${color}`,animation:"blink 1s infinite"}}/>}
        </div>

        {local?(
          <div onClick={()=>fr.current?.click()}
            onDragOver={e=>{e.preventDefault();e.stopPropagation();setDragOver(true);}}
            onDragLeave={()=>setDragOver(false)}
            onDrop={e=>{e.preventDefault();e.stopPropagation();setDragOver(false);const f=e.dataTransfer.files[0];if(f&&f.type.startsWith("audio/"))load(f);}}
            style={{flex:1, padding:"0 14px", cursor:"pointer", display:"flex", flexDirection:"column", justifyContent:"center", background:dragOver?color+"08":"transparent", transition:"background .12s", minWidth:0}}>
            {buf?(
              <>
                <div style={{fontSize:14, fontWeight:700, color:"#e0e0f2", fontFamily:"'Barlow',sans-serif", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{name}</div>
                <div style={{fontSize:8, color:"#5a5a78", fontFamily:"monospace", marginTop:3}}>{fmt(dur)} · {(buf.sampleRate/1000).toFixed(1)}kHz · {buf.numberOfChannels===2?"STEREO":"MONO"}</div>
              </>
            ):(
              <div style={{display:"flex", alignItems:"center", gap:10}}>
                <div style={{width:32, height:32, borderRadius:"50%", border:`1px solid ${dragOver?color:color+"33"}`, display:"flex", alignItems:"center", justifyContent:"center", color:dragOver?color:color+"44", fontSize:18, flexShrink:0}}>+</div>
                <div>
                  <div style={{fontSize:12, fontWeight:700, color:dragOver?color:"#5050aa", fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:1}}>{dragOver?"DROP HERE":"LOAD TRACK"}</div>
                  <div style={{fontSize:8, color:"#404060", marginTop:2, fontFamily:"monospace"}}>click or drag · mp3 wav flac aac</div>
                </div>
              </div>
            )}
          </div>
        ):(
          <div style={{flex:1, padding:"0 14px", display:"flex", flexDirection:"column", justifyContent:"center", minWidth:0}}>
            {name?(
              <>
                <div style={{fontSize:14, fontWeight:700, color:color+"bb", fontFamily:"'Barlow',sans-serif", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{name}</div>
                <div style={{fontSize:8, color:"#6060a0", fontFamily:"monospace", marginTop:3}}>{fmt(dur)}</div>
              </>
            ):(
              <div style={{fontSize:9, color:"#404060", fontFamily:"monospace", letterSpacing:2}}>WAITING FOR PARTNER</div>
            )}
          </div>
        )}
        <input ref={fr} type="file" accept="audio/*" style={{display:"none"}} onChange={e=>e.target.files[0]&&load(e.target.files[0])}/>

        <div style={{flexShrink:0, padding:"0 12px", borderLeft:BD, display:"flex", flexDirection:"column", alignItems:"flex-end", justifyContent:"center", gap:4, minWidth:72}}>
          {bpmResult?.analyzing&&<div style={{fontSize:7,color:"#f59e0b",fontFamily:"monospace",animation:"pulse .8s infinite"}}>ANA...</div>}
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:22, fontFamily:"monospace", fontWeight:800, color, lineHeight:1, letterSpacing:1}}>{bpmResult?.bpm?(bpmResult.bpm*rate).toFixed(1):"—"}</div>
            <div style={{fontSize:9, color:"#7A7090", fontFamily:"monospace", letterSpacing:2}}>BPM</div>
          </div>
          <VU an={ch?.an} color={color}/>
        </div>
      </div>

      {/* ── OVERVIEW mini waveform ── */}
      <WF buf={buf} peaks={wfPeaks} freq={wfFreq} prog={prog} color={color} onSeek={local?seek:null} h={18}/>

      {/* ── MAIN WAVEFORM ── */}
      <div style={{borderTop:BD, borderBottom:BD}}>
        <WF buf={buf} peaks={wfPeaks} freq={wfFreq} prog={prog} color={color} onSeek={local?seek:null} h={96}/>
        {bpmResult?.bpm&&dur>0&&<BeatGrid bpm={bpmResult.bpm*rate} dur={dur} prog={prog} color={color}/>}
      </div>

      {/* ── LCD TIME ── */}
      <div style={{display:"flex", alignItems:"center", justifyContent:"space-between", padding:"10px 16px", background:"#0E0C1A", borderBottom:BD}}>
        <div>
          <div style={{fontFamily:"monospace", fontWeight:800, fontSize:26, color, letterSpacing:3, lineHeight:1, textShadow:`0 0 18px ${color}66`}}>{fmt(cur)}</div>
          <div style={{fontSize:9, color:"#7A7090", fontFamily:"monospace", letterSpacing:2, marginTop:3}}>ELAPSED</div>
        </div>
        <div style={{display:"flex", flexDirection:"column", alignItems:"center", gap:4}}>
          {play&&<div style={{width:7,height:7,borderRadius:"50%",background:color,boxShadow:`0 0 10px ${color}`,animation:"pulse .7s infinite"}}/>}
          <div style={{fontSize:8, color:"#7A7090", fontFamily:"monospace"}}>{buf?`${(prog*100).toFixed(1)}%`:""}</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontFamily:"monospace", fontWeight:800, fontSize:26, color:"#3A3555", letterSpacing:3, lineHeight:1}}>-{fmt(Math.max(0,dur-cur))}</div>
          <div style={{fontSize:9, color:"#7A7090", fontFamily:"monospace", letterSpacing:2, marginTop:3}}>REMAIN</div>
        </div>
      </div>

      {/* ── TRANSPORT ── */}
      {local?(
        <div style={{display:"flex", alignItems:"center", gap:6, padding:"10px 14px", borderBottom:BD}}>
          <button onClick={cue} disabled={!buf} style={{height:34,padding:"0 12px",background:"#1C1830",border:"1px solid #C8A96E18",color:"#7A7090",borderRadius:6,cursor:buf?"pointer":"default",fontFamily:"monospace",fontSize:9,letterSpacing:1,outline:"none",flexShrink:0}}>⏮ CUE</button>
          <button onClick={()=>seek(Math.max(0,prog-.005))} disabled={!buf} style={{height:34,width:38,background:"#1C1830",border:"1px solid #C8A96E18",color:"#7A7090",borderRadius:6,cursor:buf?"pointer":"default",fontFamily:"monospace",fontSize:13,outline:"none"}}>◂◂</button>
          <button onClick={toggle} disabled={!buf} style={{flex:1,height:44,background:play?color+"22":"#252527",border:`1px solid ${play?color+"88":color+"33"}`,color:play?color:color+"66",borderRadius:8,cursor:buf?"pointer":"default",fontSize:24,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:play?`0 0 24px ${color}33`:"",outline:"none",transition:"all .15s"}}>
            {play?"⏸":"▶"}
          </button>
          <button onClick={()=>seek(Math.min(1,prog+.005))} disabled={!buf} style={{height:34,width:38,background:"#1C1830",border:"1px solid #C8A96E18",color:"#7A7090",borderRadius:6,cursor:buf?"pointer":"default",fontFamily:"monospace",fontSize:13,outline:"none"}}>▸▸</button>
        </div>
      ):(
        <div style={{height:64,display:"flex",alignItems:"center",justifyContent:"center",borderBottom:BD}}>
          <span style={{fontSize:9,fontFamily:"monospace",color:play?color+"77":"#1c1c2c",letterSpacing:3}}>{play?"● PLAYING":"■ STOPPED"}</span>
        </div>
      )}

      <div style={{display:"none"}} data-set-rate={id} ref={el=>{if(el)el._setRate=setRate;}}/>
    </div>
  );
}
const TB=(c)=>({height:28,padding:"0 7px",background:"#0a0a18",border:`1px solid ${c}44`,color:c,borderRadius:5,cursor:"pointer",fontFamily:"monospace",fontSize:8,outline:"none",display:"flex",alignItems:"center",justifyContent:"center"});
const TB2=(c,h=28)=>({height:h,width:h+8,background:"#080818",border:`1px solid ${c}55`,color:c+"bb",borderRadius:7,cursor:"pointer",fontFamily:"monospace",fontSize:10,outline:"none",display:"flex",alignItems:"center",justifyContent:"center",transition:"all .1s"});
const sBtn=(c)=>({padding:"5px 8px",fontSize:8,fontFamily:"monospace",background:c+"11",border:`1px solid ${c}33`,color:c,borderRadius:6,cursor:"pointer",letterSpacing:1,display:"flex",alignItems:"center",justifyContent:"center",gap:4});

// ── VerticalFader Component ──────────────────────────────────
function VerticalFader({ val, set, color="#C8A96E", h=130 }) {
  const pct = Math.min(1, Math.max(0, val / 1.5));
  const capTop = (1 - pct) * (h - 18);
  return (
    <div style={{position:"relative", width:32, height:h, margin:"0 auto", flexShrink:0, cursor:"pointer"}}>
      {/* Track */}
      <div style={{position:"absolute", left:"50%", top:4, bottom:4, transform:"translateX(-50%)", width:5, background:"#080710", border:`1px solid ${color}18`, borderRadius:3, overflow:"hidden"}}>
        <div style={{position:"absolute", bottom:0, width:"100%", background:`linear-gradient(0deg,${color}66,${color}22)`, height:`${pct*100}%`, borderRadius:3}}/>
      </div>
      {/* Invisible rotated range input for interaction */}
      <input
        type="range" min={0} max={1.5} step={0.01} value={val}
        onChange={e=>set(Number(e.target.value))}
        style={{
          position:"absolute",
          width:h, height:32,
          left:`${(32-h)/2}px`, top:`${(h-32)/2}px`,
          transform:"rotate(-90deg)",
          opacity:0, cursor:"pointer",
          margin:0, padding:0, zIndex:2
        }}
      />
      {/* Fader cap */}
      <div style={{
        position:"absolute", left:"50%", transform:"translateX(-50%)",
        top: capTop + "px", width:28, height:18,
        background:"linear-gradient(180deg,#2a2438,#1C1830)",
        border:`1px solid ${color}44`, borderRadius:3,
        boxShadow:"0 2px 8px #000b, inset 0 1px 0 #ffffff08",
        pointerEvents:"none", display:"flex", alignItems:"center", justifyContent:"center"
      }}>
        <div style={{width:14, height:2, background:`${color}55`, borderRadius:1}}/>
      </div>
    </div>
  );
}

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
            <div style={{fontSize:20,fontFamily:"monospace",fontWeight:700,color:eff?c:"#5a5a7a"}}>{eff?eff.toFixed(1):"—"}</div>
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
      <div style={{fontSize:7,fontFamily:"monospace",color:"#333",display:"flex",justifyContent:"space-between"}}><span>PARTNER</span><span style={{color:partner?"#ff6b35":"#5a5a7a"}}>{partner||"—"}</span></div>
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
        {tab==="dev"&&(<div style={{display:"flex",flexDirection:"column",gap:5}}>{!midi.granted?<button onClick={midi.request} style={{...sBtn("#f59e0b"),width:"100%",justifyContent:"center",padding:"7px"}}>ENABLE MIDI ACCESS</button>:<>{midi.devices.length===0&&<div style={{fontSize:7,color:"#5a5a7a",fontFamily:"monospace",textAlign:"center",padding:"10px 0"}}>No MIDI devices found.<br/>Plug in your controller.</div>}{midi.devices.map(d=><div key={d.id} onClick={()=>midi.connect(d.id)} style={{padding:"5px 7px",borderRadius:5,cursor:"pointer",background:midi.active?.id===d.id?"#00d4ff0d":"#07070f",border:`1px solid ${midi.active?.id===d.id?"#00d4ff33":"#0f0f1e"}`}}><div style={{fontSize:8,color:"#c8c8d8",fontFamily:"monospace"}}>{d.name}</div>{midi.active?.id===d.id&&<div style={{fontSize:6,color:"#00d4ff",fontFamily:"monospace"}}>● ACTIVE</div>}</div>)}</> }</div>)}
        {tab==="map"&&(<div style={{display:"flex",flexDirection:"column",gap:2}}>{midi.learning&&<div style={{fontSize:7,fontFamily:"monospace",color:"#00d4ff",background:"#00d4ff0a",border:"1px solid #00d4ff22",borderRadius:4,padding:"4px 7px",marginBottom:3,animation:"pulse .8s infinite"}}>● Move a control on your controller...<button onClick={()=>midi.setLearning(null)} style={{float:"right",background:"none",border:"none",color:"#00d4ff",cursor:"pointer",fontSize:8}}>✕</button></div>}{ACTS.map(ak=>{const mp=Object.entries(midi.mappings).find(([,v])=>v===ak);const il=midi.learning===ak;return(<div key={ak} style={{display:"flex",gap:3,alignItems:"center",padding:"2px 3px",borderRadius:3,background:il?"#00d4ff08":"transparent"}}><span style={{flex:1,fontSize:6,fontFamily:"monospace",color:mp?"#8888aa":"#5a5a7a",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{ak.replace(/_/g," ")}</span>{mp&&<span style={{fontSize:5,color:"#00d4ff44",fontFamily:"monospace"}}>{mp[0].slice(0,6)}</span>}<button onClick={()=>midi.setLearning(il?null:ak)} style={{padding:"1px 4px",fontSize:5,fontFamily:"monospace",background:il?"#00d4ff22":"#0a0a18",border:`1px solid ${il?"#00d4ff44":"#141424"}`,color:il?"#00d4ff":"#333",borderRadius:3,cursor:"pointer"}}>{il?"●":"LRN"}</button></div>);})}</div>)}
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
        {log.map((m,i)=><div key={i} style={{fontSize:9,fontFamily:"monospace"}}>{m.type==="system"?<span style={{color:"#5a5a7a",fontStyle:"italic"}}>— {m.msg} —</span>:<><span style={{color:"#5a5a7a",fontSize:6}}>{m.time} </span><span style={{color:m.self||m.from===me?"#00d4ff":"#ff6b35",fontWeight:700}}>{m.from}: </span><span style={{color:"#5555aa"}}>{m.msg}</span></>}</div>)}
        <div ref={end}/>
      </div>
      <div style={{display:"flex",gap:5,padding:"5px 7px",borderTop:"1px solid #0f0f1e"}}>
        <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&go()} placeholder="Message your partner..." style={{flex:1,background:"#07070f",border:"1px solid #141424",color:"#e8e8f0",borderRadius:5,padding:"4px 7px",fontSize:9,fontFamily:"monospace",outline:"none"}}/>
        <button onClick={go} style={{...sBtn("#00d4ff"),padding:"4px 9px",fontSize:10}}>→</button>
      </div>
    </div>
  );
}

// ── BOTTOM CHAT BAR ───────────────────────────────────────────
function ChatBar({ log, send, me }) {
  const [input, setInput] = useState("");
  const [expanded, setExpanded] = useState(false);
  const end = useRef(null);
  useEffect(()=>end.current?.scrollIntoView({behavior:"smooth"}),[log]);
  const go = () => { if(!input.trim()) return; send(input); setInput(""); };

  const G = "#C8A96E";
  return (
    <div style={{ borderTop:`1px solid ${G}18`, background:"#080710", flexShrink:0 }}>
      {expanded && (
        <div style={{ maxHeight:140, overflowY:"auto", padding:"8px 18px", display:"flex", flexDirection:"column", gap:4, borderBottom:`1px solid ${G}14` }}>
          {log.length===0
            ? <span style={{ fontSize:9, fontFamily:"'DM Mono',monospace", color:"#1C1830", fontStyle:"italic" }}>No messages yet — say hi to your partner</span>
            : log.map((m,i)=>(
                <div key={i} style={{ fontSize:9, fontFamily:"'DM Mono',monospace" }}>
                  {m.type==="system"
                    ? <span style={{ color:"#3A3555", fontStyle:"italic" }}>— {m.msg} —</span>
                    : <><span style={{ color:"#3A3555", fontSize:7 }}>{m.time} </span><span style={{ color:m.self||m.from===me?"#00d4ff":"#ff6b35", fontWeight:500 }}>{m.from}: </span><span style={{ color:"#7A7090" }}>{m.msg}</span></>
                  }
                </div>
              ))
          }
          <div ref={end}/>
        </div>
      )}
      <div style={{ display:"flex", alignItems:"center", gap:10, padding:"6px 18px" }}>
        <button onClick={()=>setExpanded(e=>!e)} style={{ fontSize:7, fontFamily:"'DM Mono',monospace", letterSpacing:2, color:expanded?G:`${G}55`, background:"transparent", border:"none", cursor:"pointer", padding:0, flexShrink:0, display:"flex", alignItems:"center", gap:4 }}>
          💬 {expanded ? "▾ CHAT" : "▸ CHAT"}
          {!expanded && log.filter(m=>m.type!=="system").length>0 && <span style={{ background:G, color:"#080710", borderRadius:8, fontSize:6, padding:"1px 5px", fontWeight:700 }}>{log.filter(m=>m.type!=="system").length}</span>}
        </button>
        {!expanded && (() => { const last=log.filter(m=>m.type!=="system").slice(-1)[0]; return last ? (
          <span style={{ fontSize:8, fontFamily:"'DM Mono',monospace", color:"#3A3555", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1 }}>
            <span style={{ color:last.from===me?"#00d4ff55":"#ff6b3555" }}>{last.from}: </span>{last.msg}
          </span>
        ) : <span style={{ flex:1, fontSize:8, fontFamily:"'DM Mono',monospace", color:"#1C1830" }}>Message your partner...</span>; })()}
        {expanded && <div style={{ flex:1 }}/>}
        <input
          value={input}
          onChange={e=>setInput(e.target.value)}
          onKeyDown={e=>e.key==="Enter"&&go()}
          placeholder="Type a message..."
          style={{ width:220, background:"#0E0C1A", border:`1px solid ${G}22`, color:"#EDE8DF", borderRadius:6, padding:"5px 10px", fontSize:9, fontFamily:"'DM Mono',monospace", outline:"none", flexShrink:0 }}
        />
        <button onClick={go} style={{ height:26, padding:"0 12px", background:`${G}18`, border:`1px solid ${G}33`, color:G, borderRadius:6, cursor:"pointer", fontFamily:"'DM Mono',monospace", fontSize:11, flexShrink:0 }}>→</button>
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
        <div style={{ fontSize:8, fontFamily:"monospace", color:"#5a5a7a" }}>Built for DJs who refuse to be in the same room.</div>
        <div style={{ fontSize:8, fontFamily:"monospace", color:"#5a5a7a" }}>Chrome & Edge · HTTPS required for MIDI + WebRTC</div>
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

  const G = "#C8A96E";
  return (
    <div style={{ minHeight:"100vh", background:"#080710", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'DM Sans',sans-serif", position:"relative", overflow:"hidden" }}>
      <style>{`@keyframes drift2{0%,100%{transform:translateY(0)}50%{transform:translateY(-12px)}}`}</style>
      <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=DM+Sans:wght@300;400;500&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>
      <div style={{ position:"absolute", top:"15%", right:"10%", width:"50%", height:"60%", borderRadius:"50%", background:`radial-gradient(ellipse,${G}07 0%,transparent 65%)`, animation:"drift2 18s ease-in-out infinite", pointerEvents:"none" }}/>
      <div style={{ position:"absolute", bottom:"10%", left:"5%", width:"35%", height:"45%", borderRadius:"50%", background:"radial-gradient(ellipse,#4A308008 0%,transparent 60%)", animation:"drift2 24s ease-in-out 4s infinite", pointerEvents:"none" }}/>

      <div style={{ position:"relative", zIndex:1, width:460, background:"#0E0C1A", border:`1px solid ${G}18`, borderRadius:16, padding:36, display:"flex", flexDirection:"column", gap:20, boxShadow:`0 40px 80px rgba(0,0,0,.7), 0 0 0 1px #1C1830` }}>

        {/* Header — matches App.jsx logo */}
        <div style={{ textAlign:"center" }}>
          <div style={{ fontFamily:"'Cormorant Garamond',serif", fontWeight:700, fontSize:28, letterSpacing:-0.5, color:"#EDE8DF" }}>
            Collab<span style={{ color:G }}>//</span>Mix
          </div>
          <div style={{ fontSize:9, fontFamily:"'DM Mono',monospace", color:`${G}55`, letterSpacing:3, marginTop:6 }}>SET UP YOUR SESSION</div>
        </div>

        {/* DJ Name */}
        <div style={{ display:"flex", flexDirection:"column", gap:7 }}>
          <label style={{ fontSize:8, fontFamily:"'DM Mono',monospace", color:`${G}77`, letterSpacing:2 }}>YOUR DJ NAME</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            style={{ background:"#080710", border:`1px solid ${G}33`, color:"#EDE8DF", borderRadius:8, padding:"11px 14px", fontSize:16, fontFamily:"'DM Sans',sans-serif", fontWeight:500, outline:"none" }}
          />
        </div>

        {/* Room Code */}
        <div style={{ background:"#080710", border:`1px solid ${G}18`, borderRadius:12, padding:16, display:"flex", flexDirection:"column", gap:8 }}>
          <div style={{ fontSize:8, fontFamily:"'DM Mono',monospace", color:`${G}55`, letterSpacing:2 }}>YOUR ROOM CODE</div>
          <div style={{ fontFamily:"'Cormorant Garamond',serif", fontWeight:700, fontSize:22, letterSpacing:1, color:"#EDE8DF" }}>{room}</div>
          <div style={{ fontSize:8, fontFamily:"'DM Mono',monospace", color:"#3A3555", wordBreak:"break-all" }}>{inviteLink}</div>
          <button
            onClick={copyLink}
            style={{ background: copied ? "#22c55e14" : `${G}14`, border: copied ? "1px solid #22c55e33" : `1px solid ${G}33`, color: copied ? "#22c55e" : G, fontFamily:"'DM Mono',monospace", fontWeight:500, fontSize:10, letterSpacing:2, padding:"10px 16px", borderRadius:8, cursor:"pointer", transition:"all .3s", textAlign:"center" }}
          >
            {copied ? "✓ LINK COPIED!" : "⎘ COPY INVITE LINK"}
          </button>
          <div style={{ fontSize:8, fontFamily:"'DM Sans',sans-serif", color:"#7A7090", lineHeight:1.6, fontWeight:300 }}>Send this link to your partner — they'll join the same room instantly.</div>
        </div>

        {/* Join button — matches App.jsx btn-gold */}
        <button
          onClick={() => onJoin({ url: SERVER_URL, room, name })}
          style={{ background:G, border:"none", color:"#080710", fontFamily:"'DM Mono',monospace", fontWeight:500, fontSize:12, letterSpacing:2, padding:"15px", borderRadius:10, cursor:"pointer", boxShadow:`0 0 32px ${G}30, 0 8px 20px rgba(0,0,0,.4)`, transition:"all .2s" }}
        >
          OPEN THE ROOM →
        </button>

        <div style={{ fontSize:8, fontFamily:"'DM Mono',monospace", color:"#1C1830", textAlign:"center", letterSpacing:1 }}>
          Chrome · Edge · Free
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
  const [eqA, setEqA]           = useState({hi:0, mid:0, lo:0, vol:1.0});
  const lsRef                   = useRef({ deckA:{}, deckB:{}, xfade:.5 });
  const rateARef                = useRef(null); // DOM refs to call setRate on Deck
  const rateBRef                = useRef(null);

  const bpm = useBPM();
  const rec = useRecorder({ engineRef: eng });
  const lib = useLibrary();

  // Library: track which deck is playing + metadata for recommendations
  const [playingTrack, setPlayingTrack] = useState(null);
  const [libLoadA, setLibLoadA] = useState(null);
  const [libLoadB, setLibLoadB] = useState(null);
  const [partnerLibrary, setPartnerLibrary] = useState([]);

  const handleTrackInfo = useCallback((deckId, trackMeta) => {
    if (trackMeta) setPlayingTrack(trackMeta);
  }, []);

  const handleLibLoad = useCallback(async (track, deck) => {
    const file = await lib.getFile(track.id);
    if (!file) { alert("File not available — open the Music Library app to grant folder access, then try again."); return; }
    if (deck === "A") setLibLoadA({ track, file, ts: Date.now() });
    else              setLibLoadB({ track, file, ts: Date.now() });
    setPlayingTrack(track);
  }, [lib]);

  // Poll library "requests" store — picks up tracks sent from the Library app (→ A / → B buttons)
  useEffect(() => {
    const poll = async () => {
      try {
        const reqs = await cmDbAll("requests");
        for (const req of reqs) {
          if (!req.trackId || !req.deck) continue;
          // Only act on fresh requests (< 10s old)
          if (Date.now() - req.ts > 10000) { await cmDbDelete("requests", req.id); continue; }
          const track = lib.library.find(t => t.id === req.trackId);
          if (track) {
            await handleLibLoad(track, req.deck);
            await cmDbDelete("requests", req.id);
          }
        }
      } catch {}
    };
    const iv = setInterval(poll, 2000);
    return () => clearInterval(iv);
  }, [lib.library, handleLibLoad]);

  const applyXF = useCallback((v) => {
    if (!eng.current) return;
    const {a,b} = xg(v);
    eng.current.A.xf.gain.setTargetAtTime(a, eng.current.ctx.currentTime, .01);
    eng.current.B.xf.gain.setTargetAtTime(b, eng.current.ctx.currentTime, .01);
  }, []);

  useEffect(() => { if (ready) applyXF(xf); }, [xf, ready]);
  useEffect(() => { if (eng.current) eng.current.master.gain.setTargetAtTime(mvol, eng.current.ctx.currentTime, .01); }, [mvol]);

  const handleWS = useCallback((m) => {
    if (m.type==="joined")        { if(m.partnerState?.deckA)setPA(m.partnerState.deckA); if(m.partnerState?.deckB)setPB(m.partnerState.deckB); }
    if (m.type==="deck_update")    (m.deckId==="A"?setPA:setPB)(p=>({...(p||{}),[m.field]:m.value}));
    if (m.type==="xfade_update")   { setXf(m.value); applyXF(m.value); }
    if (m.type==="chat")           setChat(p=>[...p,m]);
    if (m.type==="partner_joined") setChat(p=>[...p,{type:"system",msg:`${m.djName} joined the session`}]);
    if (m.type==="partner_left")   { setChat(p=>[...p,{type:"system",msg:`${m.djName} left`}]); setPA(null); setPB(null); setPartnerLibrary([]); }
    if (m.type==="library_sync")   setPartnerLibrary(m.tracks||[]);
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

  const updateEqA = useCallback((field, val) => {
    setEqA(e => ({...e, [field]:val}));
    const wsField = field==="vol" ? "vol" : `eq${field.charAt(0).toUpperCase()+field.slice(1)}`;
    lsRef.current.deckA = {...(lsRef.current.deckA||{}), [wsField]:val};
    sync.send({type:"deck_update", deckId:"A", field:wsField, value:val});
  }, []);

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
    // Persist session so library app can link back and page reloads auto-rejoin
    try { localStorage.setItem("cm_session", JSON.stringify({room: info.room, name: info.name})); } catch {}
  };

  const leave = () => {
    rtc.endCall(); sync.disconnect();
    setReady(false); setSession(null); setPage("lobby");
    eng.current = null; setRateA(1); setRateB(1);
    try { localStorage.removeItem("cm_session"); } catch {}
    window.history.replaceState({}, "", window.location.pathname);
  };

  // Auto-rejoin if library app (or any link) navigates back with ?room=X&name=Y
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const paramRoom = params.get("room");
    const paramName = params.get("name");
    if (paramRoom && paramName) {
      window.history.replaceState({}, "", window.location.pathname);
      join({ room: paramRoom, name: paramName });
    }
  }, []);

  // Sync library metadata to partner when library changes
  useEffect(() => {
    if (!session) return;
    const meta = lib.library.map(({ file, ...rest }) => rest);
    sync.send({ type:"library_sync", tracks: meta });
  }, [lib.library, session]);

  const SC = { connected:"#22c55e", connecting:"#f59e0b", disconnected:"#444", error:"#ef4444" };
  const PANELS = [["sync","⟳ SYNC"],["rtc","⚡ AUDIO"],["rec","⏺ REC"],["midi","⎍ MIDI"]];

  if (page==="landing") return <Landing onEnter={()=>setPage("lobby")}/>;
  if (page==="lobby")   return <Lobby onJoin={join} djName={djName}/>;

  const G = "#C8A96E"; // gold accent — matches App.jsx landing
  return (
    <div style={{ height:"100vh", overflow:"hidden", background:"#0E0C1A", fontFamily:"'DM Sans',sans-serif", color:"#EDE8DF", display:"flex", flexDirection:"column" }}>
      <style>{`
        @keyframes blink{0%,100%{box-shadow:0 0 5px currentColor}50%{box-shadow:0 0 14px currentColor}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
        @keyframes wave{0%,100%{transform:scaleY(.3)}50%{transform:scaleY(1)}}
        @keyframes spin{to{transform:rotate(360deg)}}
        *{box-sizing:border-box}
        ::-webkit-scrollbar{width:3px}::-webkit-scrollbar-track{background:#080710}::-webkit-scrollbar-thumb{background:#1C1830;border-radius:2px}
      `}</style>
      <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=DM+Sans:wght@300;400;500&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>

      {/* TOP BAR — matches App.jsx nav */}
      <div style={{ background:"#080710f2", backdropFilter:"blur(16px)", borderBottom:`1px solid ${G}14`, padding:"8px 18px", display:"flex", alignItems:"center", gap:12, flexShrink:0 }}>
        <div onClick={()=>leave()} style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer" }}>
          <div style={{ width:28, height:28, borderRadius:7, border:`1px solid ${G}38`, display:"flex", alignItems:"center", justifyContent:"center", background:`${G}08` }}>
            <span style={{ fontFamily:"'DM Mono',monospace", fontSize:9, color:G }}>{"//"}</span>
          </div>
          <span style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:18, fontWeight:700, color:"#EDE8DF", letterSpacing:-0.3 }}>Collab<span style={{ color:G }}>//</span>Mix</span>
        </div>
        <div style={{ flex:1, display:"flex", gap:10, alignItems:"center" }}>
          <div style={{ display:"flex", gap:5, alignItems:"center", fontSize:7, fontFamily:"'DM Mono',monospace" }}>
            <div style={{ width:5, height:5, borderRadius:"50%", background:SC[sync.status], boxShadow:sync.status==="connected"?`0 0 8px ${SC[sync.status]}`:""}}/>
            <span style={{ color:SC[sync.status], letterSpacing:1 }}>{sync.status.toUpperCase()}</span>
            {sync.ping&&<span style={{ color:"#3A3555" }}>· {sync.ping}ms</span>}
          </div>
          {sync.connErr && <span style={{ fontSize:7, fontFamily:"'DM Mono',monospace", color:"#ef4444", background:"#ef444411", border:"1px solid #ef444422", borderRadius:4, padding:"1px 7px" }}>{sync.connErr}</span>}
          {sync.partner&&<div style={{ fontSize:7, fontFamily:"'DM Mono',monospace", color:G, background:`${G}11`, border:`1px solid ${G}22`, borderRadius:5, padding:"2px 8px", letterSpacing:1 }}>⟺ {sync.partner}</div>}
          {rtc.state==="connected"&&<div style={{ fontSize:7, fontFamily:"'DM Mono',monospace", color:"#22c55e", background:"#22c55e0d", border:"1px solid #22c55e22", borderRadius:5, padding:"2px 8px", letterSpacing:1 }}>⚡ LIVE</div>}
          {rec.state==="recording"&&<div style={{ fontSize:7, fontFamily:"'DM Mono',monospace", color:"#ef4444", background:"#ef444411", border:"1px solid #ef444422", borderRadius:5, padding:"2px 8px", animation:"pulse .8s infinite", letterSpacing:1 }}>● REC {String(Math.floor(rec.dur/60)).padStart(2,"0")}:{String(Math.floor(rec.dur%60)).padStart(2,"0")}</div>}
          {midi.active&&<div style={{ fontSize:7, fontFamily:"'DM Mono',monospace", color:G, background:`${G}0d`, border:`1px solid ${G}22`, borderRadius:5, padding:"2px 8px", letterSpacing:1 }}>⎍ MIDI</div>}
        </div>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          <span style={{ fontSize:8, fontFamily:"'DM Mono',monospace", color:"#3A3555", letterSpacing:1 }}>{session.name}</span>
          <ShareButton room={session.room}/>
          <button onClick={leave} style={{ height:24, padding:"0 10px", background:"transparent", border:"1px solid #ef444433", color:"#ef4444", borderRadius:6, cursor:"pointer", fontFamily:"'DM Mono',monospace", fontSize:7, letterSpacing:1 }}>✕ LEAVE</button>
        </div>
      </div>

      {/* MAIN CONTENT AREA */}
      <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", minHeight:0 }}>

      {/* DECKS + MIXER ROW */}
      <div style={{ flexShrink:0, display:"grid", gridTemplateColumns:"1fr 270px 1fr", gap:8, padding:"8px 12px", height:"52vh", overflow:"hidden" }}>

        {/* ── YOUR DECK ── */}
        <div style={{ display:"flex", flexDirection:"column", gap:6, minWidth:0, overflowY:"auto" }}>
          <div style={{ display:"flex", gap:6, alignItems:"center", paddingLeft:2, paddingBottom:4, borderBottom:`1px solid ${G}14`, paddingTop:2 }}>
            <div style={{ width:6, height:6, borderRadius:"50%", background:"#00d4ff", boxShadow:"0 0 8px #00d4ff" }}/>
            <span style={{ fontSize:10, fontFamily:"'DM Mono',monospace", fontWeight:500, color:"#00d4ff", letterSpacing:2 }}>{session.name} · YOU</span>
          </div>
          <Deck id="A" ch={eng.current?.A} ctx={eng.current?.ctx} color="#00d4ff" local onChange={dh("A")} midi={midiEvt} bpmResult={bpm.results["A"]} bpmAnalyze={bpm.analyze} eqHi={eqA.hi} eqMid={eqA.mid} eqLo={eqA.lo} chanVol={eqA.vol} loadFromLibrary={libLoadA} onTrackInfo={handleTrackInfo}/>
        </div>

        {/* ── CENTER MIXER — Rekordbox style ── */}
        <div style={{ display:"flex", flexDirection:"column", background:"#1C1830", border:`1px solid #C8A96E18`, borderRadius:12, overflow:"hidden", boxShadow:`0 8px 40px rgba(0,0,0,.6), 0 0 0 1px #2a2438` }}>

          {/* HEADER */}
          <div style={{ padding:"8px 12px", borderBottom:`1px solid #C8A96E14`, display:"flex", alignItems:"center", justifyContent:"space-between", background:"#0E0C1A", flexShrink:0 }}>
            <div>
              <div style={{ fontFamily:"'Cormorant Garamond',serif", fontWeight:700, fontSize:14, color:"#EDE8DF" }}>Collab<span style={{color:"#C8A96E"}}>//</span>Mix</div>
              <div style={{ fontSize:8, fontFamily:"'DM Mono',monospace", color:"#C8A96E66", letterSpacing:2 }}>MIXER · LIVE</div>
            </div>
            <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:2 }}>
              <VU an={eng.current?.masterAn} color="#C8A96E" w={44}/>
              <div style={{ fontSize:6, fontFamily:"'DM Mono',monospace", color:"#C8A96E44", letterSpacing:1 }}>MASTER</div>
            </div>
          </div>

          {/* CHANNEL STRIP — both channels side by side */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", flex:1, minHeight:0 }}>

            {/* --- CH A --- */}
            <div style={{ display:"flex", flexDirection:"column", alignItems:"center", padding:"8px 6px", gap:6, borderRight:`1px solid #C8A96E14`, background:"#00d4ff04" }}>
              <div style={{ fontFamily:"'DM Mono',monospace", fontSize:11, color:"#00d4ff", letterSpacing:3, fontWeight:500 }}>CH A</div>
              <div style={{ fontSize:9, fontFamily:"'DM Mono',monospace", color:"#00d4ff77", letterSpacing:1, marginTop:-2 }}>{session.name}</div>
              {/* GAIN */}
              <Knob v={eqA.vol>1?eqA.vol-1:0} set={v=>updateEqA("vol", 1+Math.max(0,v))} min={0} max={0.5} ctr={0} label="GAIN" color="#00d4ff" size={36}/>
              {/* EQ */}
              <Knob v={eqA.hi} set={v=>updateEqA("hi",v)} min={-12} max={12} ctr={0} label="HI" color="#00d4ff" size={36}/>
              <Knob v={eqA.mid} set={v=>updateEqA("mid",v)} min={-12} max={12} ctr={0} label="MID" color="#00d4ff" size={36}/>
              <Knob v={eqA.lo} set={v=>updateEqA("lo",v)} min={-12} max={12} ctr={0} label="LO" color="#00d4ff" size={36}/>
              {/* Channel fader */}
              <div style={{ fontSize:9, fontFamily:"'DM Mono',monospace", color:"#00d4ff66", letterSpacing:1.5, marginTop:6 }}>VOL</div>
              <VerticalFader val={eqA.vol} set={v=>updateEqA("vol",v)} color="#00d4ff" h={110}/>
              <div style={{ fontSize:10, fontFamily:"'DM Mono',monospace", color:"#00d4ffbb", marginTop:2 }}>{(eqA.vol/1.5*100).toFixed(0)}%</div>
            </div>

            {/* --- CH B (partner — read-only) --- */}
            <div style={{ display:"flex", flexDirection:"column", alignItems:"center", padding:"8px 6px", gap:6, background:"#ff6b3504" }}>
              <div style={{ fontFamily:"'DM Mono',monospace", fontSize:11, color:"#ff6b35", letterSpacing:3, fontWeight:500 }}>CH B</div>
              <div style={{ fontSize:9, fontFamily:"'DM Mono',monospace", color:"#ff6b3577", letterSpacing:1, marginTop:-2 }}>{sync.partner||"PARTNER"}</div>
              {/* GAIN - read only */}
              <Knob v={pA?.vol>1?(pA?.vol||1)-1:0} set={()=>{}} min={0} max={0.5} ctr={0} label="GAIN" color="#ff6b35" size={36} off={true}/>
              {/* EQ - read only */}
              <Knob v={pA?.eqHi||0} set={()=>{}} min={-12} max={12} ctr={0} label="HI" color="#ff6b35" size={36} off={true}/>
              <Knob v={pA?.eqMid||0} set={()=>{}} min={-12} max={12} ctr={0} label="MID" color="#ff6b35" size={36} off={true}/>
              <Knob v={pA?.eqLo||0} set={()=>{}} min={-12} max={12} ctr={0} label="LO" color="#ff6b35" size={36} off={true}/>
              {/* Channel fader - read only */}
              <div style={{ fontSize:9, fontFamily:"'DM Mono',monospace", color:"#ff6b3566", letterSpacing:1.5, marginTop:6 }}>VOL</div>
              <VerticalFader val={pA?.vol||1} set={()=>{}} color="#ff6b35" h={110}/>
              <div style={{ fontSize:10, fontFamily:"'DM Mono',monospace", color:"#ff6b35aa", marginTop:2 }}>{((pA?.vol||1)/1.5*100).toFixed(0)}%</div>
            </div>
          </div>

          {/* MASTER VOL */}
          <div style={{ padding:"8px 12px 6px", borderTop:`1px solid #C8A96E14`, flexShrink:0 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:5 }}>
              <span style={{ fontSize:9, fontFamily:"'DM Mono',monospace", color:"#C8A96E88", letterSpacing:2 }}>MASTER</span>
              <span style={{ fontSize:8, fontFamily:"'DM Mono',monospace", color:"#C8A96E" }}>{(mvol*100).toFixed(0)}%</span>
            </div>
            <div style={{ position:"relative", height:24, display:"flex", alignItems:"center" }}>
              <div style={{ width:"100%", height:4, borderRadius:2, background:"#080710", border:`1px solid #C8A96E14`, overflow:"hidden" }}>
                <div style={{ height:"100%", width:`${(mvol/1.2)*100}%`, background:`linear-gradient(90deg,#C8A96E44,#C8A96E)` }}/>
              </div>
              <input type="range" min={0} max={1.2} step={.01} value={mvol} onChange={e=>setMvol(Number(e.target.value))} style={{ position:"absolute", width:"100%", opacity:0, cursor:"pointer", height:24 }}/>
              <div style={{ position:"absolute", left:`calc(${(mvol/1.2)*100}% - 7px)`, width:14, height:20, background:"linear-gradient(180deg,#2a2438,#1C1830)", border:`1px solid #C8A96E44`, borderRadius:3, boxShadow:"0 2px 6px #000a", pointerEvents:"none" }}/>
            </div>
          </div>

          {/* CROSSFADER */}
          <div style={{ padding:"8px 12px 10px", borderTop:`1px solid #C8A96E14`, flexShrink:0, background:"#0E0C1A" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:7 }}>
              <div>
                <div style={{ fontSize:11, fontFamily:"'DM Mono',monospace", color:"#00d4ff", fontWeight:600 }}>A</div>
                <div style={{ fontSize:7, fontFamily:"'DM Mono',monospace", color:"#00d4ff66" }}>{(xg(xf).a*100).toFixed(0)}%</div>
              </div>
              <div style={{ fontSize:9, fontFamily:"'DM Mono',monospace", color:"#C8A96E66", letterSpacing:2 }}>CROSSFADER</div>
              <div style={{ textAlign:"right" }}>
                <div style={{ fontSize:11, fontFamily:"'DM Mono',monospace", color:"#ff6b35", fontWeight:600 }}>B</div>
                <div style={{ fontSize:7, fontFamily:"'DM Mono',monospace", color:"#ff6b3566" }}>{(xg(xf).b*100).toFixed(0)}%</div>
              </div>
            </div>
            <div style={{ position:"relative", height:34, display:"flex", alignItems:"center" }}>
              <div style={{ width:"100%", height:7, borderRadius:4, background:"#080710", border:`1px solid #C8A96E14`, overflow:"hidden" }}>
                <div style={{ height:"100%", width:`${xf*100}%`, background:"linear-gradient(90deg,#00d4ff22,#ff6b3511)" }}/>
              </div>
              <input type="range" min={0} max={1} step={.005} value={xf} onChange={e=>setXfLocal(Number(e.target.value))} style={{ position:"absolute", width:"100%", opacity:0, cursor:"pointer", height:34 }}/>
              <div style={{ position:"absolute", left:`calc(${xf*100}% - 13px)`, width:26, height:28, background:"linear-gradient(180deg,#2a2438,#1C1830)", border:`1px solid #C8A96E44`, borderRadius:4, boxShadow:`0 2px 10px #000b, 0 0 8px #C8A96E0a`, pointerEvents:"none", display:"flex", alignItems:"center", justifyContent:"center" }}>
                <div style={{ width:2, height:14, background:"#C8A96E66", borderRadius:1 }}/>
              </div>
            </div>
            <div style={{ display:"flex", justifyContent:"space-between", marginTop:5, alignItems:"center" }}>
              <div style={{ width:36, height:1, background:"linear-gradient(90deg,#00d4ff44,transparent)" }}/>
              <button onClick={()=>setXfLocal(.5)} style={{ fontSize:6, height:18, padding:"0 8px", background:"#C8A96E0d", border:`1px solid #C8A96E22`, color:"#C8A96E77", borderRadius:4, cursor:"pointer", fontFamily:"'DM Mono',monospace", letterSpacing:1 }}>CENTER</button>
              <div style={{ width:36, height:1, background:"linear-gradient(90deg,transparent,#ff6b3544)" }}/>
            </div>
          </div>

          {/* SESSION INFO - compact grid */}
          <div style={{ padding:"6px 10px", borderTop:`1px solid #C8A96E14`, flexShrink:0 }}>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"2px 4px" }}>
              {[["ROOM",session.room,"#00d4ff"],["PARTNER",sync.partner||"—","#ff6b35"],["PING",sync.ping?`${sync.ping}ms`:"—","#C8A96E"],["AUDIO",rtc.state==="connected"?"● LIVE":"OFFLINE",rtc.state==="connected"?"#22c55e":"#3A3555"]].map(([l,v,c])=>(
                <div key={l} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"2px 5px", background:"#080710", borderRadius:3, border:`1px solid #C8A96E0d` }}>
                  <span style={{ fontSize:9, color:"#C8A96E66", fontFamily:"'DM Mono',monospace", letterSpacing:1 }}>{l}</span>
                  <span style={{ fontSize:9, color:c, fontFamily:"'DM Mono',monospace", maxWidth:60, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{v}</span>
                </div>
              ))}
            </div>
          </div>

          {/* TOOL PANELS */}
          <div style={{ flex:0, display:"flex", flexDirection:"column", overflow:"hidden", borderTop:`1px solid #C8A96E14` }}>
            <div style={{ display:"flex", flexShrink:0, background:"#0E0C1A" }}>
              {PANELS.map(([pid,l])=>(
                <button key={pid} onClick={()=>setPanel(pid)} style={{ flex:1, padding:"6px 2px", fontSize:9, fontFamily:"'DM Mono',monospace", background:"transparent", color:panel===pid?"#C8A96E":"#C8A96E55", border:"none", borderBottom:`2px solid ${panel===pid?"#C8A96E":"transparent"}`, cursor:"pointer", outline:"none", letterSpacing:1 }}>{l}</button>
              ))}
            </div>
            <div style={{ maxHeight:140, overflow:"auto" }}>
              {panel==="sync" && <SyncPanel bpmA={bpm.results.A?.bpm} bpmB={bpm.results.B?.bpm} rateA={rateA} rateB={rateB} onSyncB={()=>syncDecks("B",bpm.results.A?.bpm)} onSyncA={()=>syncDecks("A",bpm.results.B?.bpm)}/>}
              {panel==="rtc"  && <RTCPanel rtc={rtc} partner={sync.partner} syncOk={sync.status==="connected"}/>}
              {panel==="rec"  && <RecPanel rec={rec} ready={ready}/>}
              {panel==="midi" && <MidiPanel midi={midi}/>}
            </div>
          </div>
        </div>

        {/* ── PARTNER DECK ── */}
        <div style={{ display:"flex", flexDirection:"column", gap:6, minWidth:0, overflowY:"auto" }}>
          <div style={{ display:"flex", gap:6, alignItems:"center", paddingLeft:2, paddingBottom:4, borderBottom:"1px solid #C8A96E14", paddingTop:2 }}>
            <div style={{ width:6, height:6, borderRadius:"50%", background:sync.partner?"#ff6b35":"#1C1830", boxShadow:sync.partner?"0 0 8px #ff6b35":"none", transition:"all .3s" }}/>
            <span style={{ fontSize:10, fontFamily:"'DM Mono',monospace", fontWeight:500, color:sync.partner?"#ff6b35":"#3A3555", letterSpacing:2 }}>{sync.partner||"WAITING FOR PARTNER..."}</span>
          </div>
          <Deck id="A" ch={null} ctx={null} color="#ff6b35" remote={pA} bpmResult={null} bpmAnalyze={null} eqHi={pA?.eqHi||0} eqMid={pA?.eqMid||0} eqLo={pA?.eqLo||0} chanVol={pA?.vol||1}/>
        </div>

      </div>

      {/* ── EMBEDDED LIBRARY — fills remaining space below decks ── */}
      <div style={{ flex:1, overflow:"hidden", borderTop:`1px solid ${G}14`, background:"#080710", minHeight:0 }}>
        <LibraryPanel lib={lib} onLoad={handleLibLoad} playingTrack={playingTrack}/>
      </div>

      </div>{/* end main content area */}

      {/* PERSISTENT BOTTOM CHAT BAR */}
      <ChatBar log={chat} send={msg=>sync.send({type:"chat",msg})} me={session.name}/>

    </div>
  );
}
