import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { WORKER_SRC } from "./bpm-worker-source.js";
import { logEvent, setSessionContext, captureHandledError } from "./utils/telemetry.js";

// ═══════════════════════════════════════════════════════════════
//  MIX//SYNC  — PRODUCTION READY
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

function buildInviteLink(roomId, mixName) {
  const base = window.location.origin + window.location.pathname;
  const params = new URLSearchParams();
  params.set("room", roomId);
  if (mixName) params.set("mix", mixName);
  return `${base}?${params.toString()}`;
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
    const flt = ctx.createBiquadFilter(); flt.type = "allpass"; // DJ filter (swept by knob)
    const vol = ctx.createGain(); vol.gain.value = 1;
    const xf  = ctx.createGain(); xf.gain.value  = 1;
    const an  = ctx.createAnalyser(); an.fftSize  = 512;
    trim.connect(hi); hi.connect(mid); mid.connect(lo);
    lo.connect(flt); flt.connect(vol); vol.connect(xf); xf.connect(master); xf.connect(an);
    return { trim, hi, mid, lo, flt, vol, xf, an };
  }
  return { ctx, master, masterAn, A: chain(), B: chain() };
}
function xg(p) { const a = p * Math.PI / 2; return { a: Math.cos(a), b: Math.sin(a) }; }

// ── Design tokens (Mix//Sync design system) ─────────────────────
// Named TOK (not D) because an existing local `const D = "#0c0c14"` uses the D
// identifier inside the Deck component scope. Future refactors can swap
// hard-coded color literals for TOK.* references without a mass rename.
const TOK = {
  gold:   "#C8A96E", // primary brand, CTAs, accents
  deckA:  "#7B61FF", // your deck — electric violet
  deckB:  "#00BFA5", // partner deck — deep teal
  bg:     "#07070F", // primary background (near-black w/ blue undertone)
  bg2:    "#0D0C1A", // panels / cards
  bg3:    "#13122A", // hover / active panels
  border: "#1A1830", // borders, dividers
  text:   "#EDE8DF", // primary text — warm off-white
  subtle: "#9B96B0", // muted purple-grey (secondary text)
  muted:  "#4A4560", // disabled / very muted
};


function createBPMWorker() {
  return new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: "application/javascript" })));
}

function useBPM() {
  const [results, setResults] = useState({});
  const worker = useRef(null);
  useEffect(() => {
    worker.current = createBPMWorker();
    worker.current.onmessage = (e) => {
      const { id, bpm, confidence, candidates, beatPhaseFrac, beatPeriodSec, beatPhaseSec, snapped, error, _debug } = e.data;
      if (id === '__err') { console.error('[BPM Worker global error]', e.data.error); return; }
      if (error) console.error('[BPM Worker caught error]', error);
      console.log('[BPM result] id='+id+' bpm='+bpm+' bpf='+beatPhaseFrac+' bps='+beatPeriodSec+' bphs='+beatPhaseSec+' snapped='+(snapped??false)+' debug='+JSON.stringify(_debug));
      console.log('[BPM] analysis complete for deck', id, 'bpm=', bpm);
      setResults(prev => ({ ...prev, [id]: { bpm, confidence, candidates, beatPhaseFrac: beatPhaseFrac||0, beatPeriodSec: beatPeriodSec||null, beatPhaseSec: beatPhaseSec??null, analyzing: false } }));
    };
    worker.current.onerror = (e) => { console.error('[BPM Worker onerror]', e.message, e.lineno); };
    return () => worker.current?.terminate();
  }, []);
  const analyze = useCallback((buf, id) => {
    if (!buf || !worker.current) return;
    console.log('[BPM] analysis started for deck', id, '(track loaded)');
    setResults(prev => ({ ...prev, [id]: { ...(prev[id] || {}), analyzing: true } }));
    const cd = [];
    for (let c = 0; c < buf.numberOfChannels; c++) cd.push(buf.getChannelData(c).slice());
    // Transfer ArrayBuffers (O(1) vs O(n) structured clone) — avoids 10-30s stall on large tracks
    worker.current.postMessage({ cd, sr: buf.sampleRate, id }, cd.map(a => a.buffer));
  }, []);
  return { results, analyze };
}

// ── Camelot wheel + recommendation engine ────────────────────
const CAMELOT = {
  "C":"8B","G":"9B","D":"10B","A":"11B","E":"12B","B":"1B","F#":"2B","Db":"3B","Ab":"4B","Eb":"5B","Bb":"6B","F":"7B",
  "Am":"8A","Em":"9A","Bm":"10A","F#m":"11A","C#m":"12A","G#m":"1A","D#m":"2A","A#m":"3A","Fm":"4A","Cm":"5A","Gm":"6A","Dm":"7A",
  // Synonyms — alternate spellings DJ tools (rekordbox, Mixed In Key, Beatport) emit.
  // Majors:
  "Cmaj":"8B","Gmaj":"9B","Dmaj":"10B","Amaj":"11B","Emaj":"12B","Bmaj":"1B",
  "F#maj":"2B","Gb":"2B","Gbmaj":"2B","Dbmaj":"3B","C#maj":"3B","Abmaj":"4B","G#maj":"4B",
  "Ebmaj":"5B","D#maj":"5B","Bbmaj":"6B","A#maj":"6B","Fmaj":"7B",
  // Minors (CAMELOT canonical uses sharps; map flat synonyms in):
  "Amin":"8A","Emin":"9A","Bmin":"10A","Fmin":"4A","Cmin":"5A","Gmin":"6A","Dmin":"7A",
  "F#min":"11A","Gbm":"11A","Gbmin":"11A",
  "C#min":"12A","Dbm":"12A","Dbmin":"12A",
  "G#min":"1A","Abm":"1A","Abmin":"1A",
  "D#min":"2A","Ebm":"2A","Ebmin":"2A",
  "A#min":"3A","Bbm":"3A","Bbmin":"3A",
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

// ── ID3 parser (robust v2) ────────────────────────────────────
function parseID3(buffer){
  const bytes=new Uint8Array(buffer),view=new DataView(buffer),tags={};
  if(bytes.length<10||bytes[0]!==0x49||bytes[1]!==0x44||bytes[2]!==0x33)return tags;
  const ver=bytes[3]; // 2, 3, or 4
  const flags=bytes[5];
  const tagSize=((bytes[6]&0x7F)<<21)|((bytes[7]&0x7F)<<14)|((bytes[8]&0x7F)<<7)|(bytes[9]&0x7F);
  let off=10;
  // Skip extended header if present (flag bit 6)
  if(flags&0x40){
    const extSz=ver>=4?((bytes[off]&0x7F)<<21)|((bytes[off+1]&0x7F)<<14)|((bytes[off+2]&0x7F)<<7)|(bytes[off+3]&0x7F):view.getUint32(off);
    off+=extSz;
  }
  const end=Math.min(10+tagSize,buffer.byteLength);
  const fmap={"TIT2":"title","TPE1":"artist","TBPM":"bpm","TKEY":"key","TCON":"genre","TALB":"album","TOPE":"originalArtist","TPUB":"label"};
  function rStr(o,len){
    if(o>=buffer.byteLength)return"";
    const enc=bytes[o];
    const sl=bytes.slice(o+1,o+len);
    try{
      if(enc===1||enc===2)return new TextDecoder(enc===2?"utf-16be":"utf-16").decode(sl).replace(/\0/g,"").trim();
      if(enc===0)return new TextDecoder("iso-8859-1").decode(sl).replace(/\0/g,"").trim();
      return new TextDecoder("utf-8").decode(sl).replace(/\0/g,"").trim();
    }catch{return"";}
  }
  while(off+10<=end){
    const fid=String.fromCharCode(bytes[off],bytes[off+1],bytes[off+2],bytes[off+3]);
    if(!fid.match(/^[A-Z0-9]{4}$/))break;
    const fsz=ver>=4?((bytes[off+4]&0x7F)<<21)|((bytes[off+5]&0x7F)<<14)|((bytes[off+6]&0x7F)<<7)|(bytes[off+7]&0x7F):view.getUint32(off+4);
    if(fsz===0||off+10+fsz>end+1){off+=10+fsz;continue;}
    if(fmap[fid]&&fsz>1)tags[fmap[fid]]=rStr(off+10,fsz);
    // Extract APIC (artwork) frame
    if(fid==="APIC"&&fsz>20&&!tags.artwork){
      try{
        const aEnc=bytes[off+10];
        let p=off+11;
        // skip MIME type (always ASCII, single-null terminated)
        while(p<off+10+fsz&&bytes[p]!==0)p++;
        p++; // skip mime null
        p++; // skip picture type byte
        // skip description — UTF-16 uses double-null, others use single-null
        if(aEnc===1||aEnc===2){
          while(p+1<off+10+fsz&&!(bytes[p]===0&&bytes[p+1]===0))p+=2;
          p+=2; // skip double-null
        }else{
          while(p<off+10+fsz&&bytes[p]!==0)p++;
          p++; // skip single-null
        }
        if(p<off+10+fsz){
          const picBytes=bytes.slice(p,off+10+fsz);
          const mime=(picBytes[0]===0xFF&&picBytes[1]===0xD8)?"image/jpeg":(picBytes[0]===0x89&&picBytes[1]===0x50)?"image/png":"image/jpeg";
          const b64=btoa(Array.from(picBytes.slice(0,Math.min(picBytes.length,500000))).map(b=>String.fromCharCode(b)).join(""));
          tags.artwork=`data:${mime};base64,${b64}`;
        }
      }catch{}
    }
    off+=10+fsz;
  }
  // ID3v1 fallback (last 128 bytes) for artist/title/album if ID3v2 had none
  if(!tags.title&&!tags.artist&&buffer.byteLength>=128){
    try{
      const v1=bytes.slice(buffer.byteLength-128);
      if(v1[0]===0x54&&v1[1]===0x41&&v1[2]===0x47){// "TAG"
        const d=new TextDecoder("iso-8859-1");
        const t=d.decode(v1.slice(3,33)).replace(/\0/g,"").trim();
        const a=d.decode(v1.slice(33,63)).replace(/\0/g,"").trim();
        const al=d.decode(v1.slice(63,93)).replace(/\0/g,"").trim();
        if(t)tags.title=t; if(a)tags.artist=a; if(al)tags.album=al;
      }
    }catch{}
  }
  return tags;
}

// Downscale artwork data URL to a 200x200 JPEG at quality 0.7. Cuts each
// embedded ID3 APIC from ~500-666 KB to ~10-20 KB — ~35× memory reduction.
// Returns null on failure; caller should keep the original in that case.
async function downscaleArtwork(dataUrl) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          const SIZE = 200;
          canvas.width = SIZE;
          canvas.height = SIZE;
          const ctx = canvas.getContext('2d');
          // Cover-fit: fill the 200x200 square, crop overflow, center
          const ratio = Math.max(SIZE / img.width, SIZE / img.height);
          const dw = img.width * ratio;
          const dh = img.height * ratio;
          const dx = (SIZE - dw) / 2;
          const dy = (SIZE - dh) / 2;
          ctx.drawImage(img, dx, dy, dw, dh);
          resolve(canvas.toDataURL('image/jpeg', 0.7));
        } catch (err) {
          console.warn('[ARTWORK-COMPRESS-FAIL]', err);
          resolve(null);
        }
      };
      img.onerror = () => {
        console.warn('[ARTWORK-COMPRESS-FAIL] image load error');
        resolve(null);
      };
      img.src = dataUrl;
    } catch (err) {
      console.warn('[ARTWORK-COMPRESS-FAIL]', err);
      resolve(null);
    }
  });
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
const ENERGY_COLOR={"Ambient":"#4A90D9","Warm-Up":"#22C55E","Build":"#F59E0B","Peak Hour":"#FF6B35","Hard":"#EF4444"};

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
async function cmDbPut(store,item){
  const t0=performance.now();
  const key=item?.id??'<no-id>';
  console.log('[IDB-PUT-START]',{store,key,at:Date.now()});
  const db=await openCmDB();
  return new Promise((res,rej)=>{
    const tx=db.transaction(store,"readwrite");
    const r=tx.objectStore(store).put(item);
    r.onsuccess=()=>{
      console.log('[IDB-PUT-OK]',{store,key,ms:Math.round(performance.now()-t0)});
      res();
    };
    r.onerror=e=>{
      const err=e.target.error;
      console.error('[IDB-PUT-FAIL]',{store,key,error:err?.message||String(err),ms:Math.round(performance.now()-t0)});
      rej(err);
    };
  });
}
// Store FileSystemFileHandle with explicit out-of-line key (handles store uses no keyPath in Library app)
async function cmDbPutHandle(trackId,handle){
  const db=await openCmDB();
  return new Promise((res,rej)=>{
    const tx=db.transaction("handles","readwrite");
    const store=tx.objectStore("handles");
    // Try out-of-line key first (Library app pattern), fall back to inline id property
    try{store.put(handle,trackId);}catch{try{store.put({id:trackId,...handle});}catch{}}
    tx.oncomplete=()=>res();
    tx.onerror=e=>rej(e.target.error);
  });
}

// ── OPFS helpers — Origin Private File System, zero-permission persistent audio storage ──
// Files stored here survive page reloads and browser restarts with NO user gesture needed.
const OPFS_DIR="cm_audio";
async function opfsStore(trackId,file){
  const t0=performance.now();
  console.log('[OPFS-WRITE-START]',{id:trackId,fileSize:file?.size??'unknown',at:Date.now()});
  try{
    const root=await navigator.storage.getDirectory();
    const dir=await root.getDirectoryHandle(OPFS_DIR,{create:true});
    const fh=await dir.getFileHandle(trackId,{create:true});
    const wr=await fh.createWritable();
    await wr.write(file);
    await wr.close();
    console.log('[OPFS-WRITE-OK]',{id:trackId,ms:Math.round(performance.now()-t0)});
    return true;
  }catch(err){
    console.error('[OPFS-WRITE-FAIL]',{id:trackId,error:err?.message||String(err),ms:Math.round(performance.now()-t0)});
    throw err;
  }
}
async function opfsGet(trackId){
  try{
    const root=await navigator.storage.getDirectory();
    const dir=await root.getDirectoryHandle(OPFS_DIR,{create:false});
    const fh=await dir.getFileHandle(trackId);
    const file=await fh.getFile();
    console.log('[OPFS-READ-OK]',{id:trackId,fileSize:file?.size});
    return file;
  }catch(err){
    console.warn('[OPFS-READ-FAIL]',{id:trackId,error:err?.message||String(err),name:err?.name});
    return null;
  }
}
async function opfsDelete(trackId){
  try{
    const root=await navigator.storage.getDirectory();
    const dir=await root.getDirectoryHandle(OPFS_DIR,{create:false});
    await dir.removeEntry(trackId);
  }catch{}
}
async function opfsClear(){
  try{
    const root=await navigator.storage.getDirectory();
    await root.removeEntry(OPFS_DIR,{recursive:true});
  }catch{}
}

// Strip extension + leading "01 " / "01-" / "1. " / "01) " track-number prefix.
function cleanFilename(filename) {
  let name = filename;
  name = name.replace(/\.(mp3|wav|flac|aac|ogg|m4a)$/i, "");
  name = name.replace(/^[\s\-_]*\d+[\s\.\-_\)]+/, "");
  return name.trim();
}

// "Artist - Title" → { artist, title }. Keeps trailing " - (Mix)" parts in title.
function parseArtistTitle(cleanedName) {
  const parts = cleanedName.split(/\s+-\s+/);
  if (parts.length >= 2) {
    return { artist: parts[0].trim(), title: parts.slice(1).join(" - ").trim() };
  }
  return { artist: null, title: cleanedName };
}

// Normalize artist/title for duplicate detection (case-insensitive, punctuation-stripped).
function normalizeForDedupe(str) {
  if (!str) return "";
  return String(str)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")          // collapse whitespace
    .replace(/[^\w\s]/g, "")        // strip punctuation
    .replace(/\s*\(.*?\)\s*/g, "")  // strip parenthetical (extended mix), (original mix), etc.
    .trim();
}

// Two tracks match for dedupe purposes if normalized artist+title both match.
// Tracks without artist OR title are never considered dupes (keep all empties).
function tracksMatch(t1, t2) {
  if (!t1.artist && !t1.title) return false;
  if (!t2.artist && !t2.title) return false;
  return normalizeForDedupe(t1.artist) === normalizeForDedupe(t2.artist)
      && normalizeForDedupe(t1.title) === normalizeForDedupe(t2.title);
}

// ── useLibrary hook — reads from shared cm_music_library IDB ─────────────────
function useLibrary(){
  const [library,setLibrary]=useState([]);
  const [queue,setQueue]=useState([]);   // ordered array of trackIds in session queue
  const [crates,setCrates]=useState([]); // playlists from shared IDB
  const [importing,setImporting]=useState(false);
  const [analyzing,setAnalyzing]=useState(false);
  const workerRef=useRef(null),queueRef=useRef([]),activeRef=useRef(false),fileMap=useRef({});
  const audioCtx=useRef(null);
  const artworkCache=useRef({}); // trackId → data URL, kept in memory
  const processQRef=useRef(null); // forward ref so startup effect can call processQ
  const hasAutoQueued=useRef(false); // ensure startup analysis runs once
  // Fingerprints to skip setState when nothing actually changed (avoids RAF stutter)
  const libFingerprintRef=useRef('');
  const queueFingerprintRef=useRef('');
  const cratesFingerprintRef=useRef('');

  // Load tracks + crates from shared IDB and poll for updates from the library app
  useEffect(()=>{
    const load=async()=>{
      try{
        const tracks=await cmDbAll("tracks");
        if(tracks.length>0){
          // Only call setLibrary when something actually changed — avoids 5s RAF stutter.
          // The freshly-deserialized tracks array (incl. artwork strings) is GC-eligible
          // after this function returns when the fingerprint matches. With downscaled
          // artwork (~15 KB per track), per-tick allocation is ~5 MB at 300 tracks
          // instead of the ~177 MB it would be with full-res artwork.
          const fp=tracks.map(t=>t.id+'|'+(t.analyzed?1:0)+'|'+(t.bpm||0)).join(',');
          if(fp!==libFingerprintRef.current){
            libFingerprintRef.current=fp;
            setLibrary(tracks);
          }
          // Library-side analysis is now deferred until handleLibLoad triggers
          // queueAnalysis on user track-load. Auto-queueing every unanalyzed
          // track on app mount caused OOM on 300+ track libraries — each File
          // reference pinned its underlying blob (~5-15 MB) for the lifetime
          // of the analyzer queue, totaling multiple GB of RAM pressure.
        }
        const q=await cmDbAll("queue");
        const qfp=q.map(r=>r.trackId+'|'+r.order).join(',');
        if(qfp!==queueFingerprintRef.current){
          queueFingerprintRef.current=qfp;
          setQueue(q.sort((a,b)=>a.order-b.order).map(r=>r.trackId));
        }
        const cr=await cmDbAll("crates");
        const cfp=cr.map(c=>c.id+'|'+(c.tracks||[]).length).join(',');
        if(cfp!==cratesFingerprintRef.current){
          cratesFingerprintRef.current=cfp;
          setCrates(cr);
        }
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
      setLibrary(prev=>{
        const updated=prev.map(t=>t.id===id?{...t,bpm:bpm||t.bpm,key:key||t.key,energy,analyzed:true}:t);
        // Persist analyzed state to IDB so spinner doesn't reappear on next page load
        const track=updated.find(t=>t.id===id);
        if(track) cmDbPut("tracks",track).catch(()=>{});
        return updated;
      });
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
  // Keep ref current so startup effect (which has empty deps) can call processQ
  useEffect(()=>{ processQRef.current=processQ; },[processQ]);

  // Core import logic — works with File objects or FileSystemFileHandle arrays.
  // opts.skipDedup: when true, bypass internal artist+title dedup. Set this when
  // the caller (e.g. commitImport after the preview modal) has already made the
  // dedup decision and explicitly asked for the dupes to be imported anyway.
  const _importFileObjects=useCallback(async(files,handles=[],opts={})=>{
    const audio=[...files].filter(f=>f.type.startsWith("audio/")||f.name.match(/\.(mp3|wav|flac|aac|ogg|m4a)$/i));
    if(!audio.length)return;
    // Request persistent storage from Chrome on first import. Without this,
    // Chrome treats our storage as "best effort" and may evict between sessions.
    if (navigator.storage && navigator.storage.persist) {
      try {
        const persisted = await navigator.storage.persisted();
        if (!persisted) {
          const granted = await navigator.storage.persist();
          console.log('[STORAGE-PERSIST]', { requested: true, granted });
          if (!granted) {
            console.warn('[STORAGE-PERSIST] Browser denied persistent storage. Library may be evicted between sessions.');
          }
        } else {
          console.log('[STORAGE-PERSIST]', { alreadyPersisted: true });
        }
      } catch (err) {
        console.warn('[STORAGE-PERSIST] Error requesting persistent storage:', err);
      }
    }
    const tImport0=performance.now();
    setImporting(true);
    let importedCount=0;
    let skippedCount=0;
    const batchAdded=[]; // tracks added in THIS batch — used for in-batch dedupe
    for(let i=0;i<audio.length;i++){
      const file=audio[i];
      const handle=handles[i]||null;
      const id=`t_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
      console.log('[IMPORT-ITER]',{index:i,total:audio.length,filename:file.name,id});
      let tags={};
      try{const sl=file.slice(0,1048576);tags=parseID3(await sl.arrayBuffer());}catch{}
      // Downscale artwork to 200x200 JPEG @0.7 — keeps thumbnails visible while
      // dropping per-track memory from ~666 KB to ~10-20 KB (~35× reduction).
      // If compression fails, keep the original — better than losing artwork.
      if (tags.artwork) {
        const compressed = await downscaleArtwork(tags.artwork);
        if (compressed) tags.artwork = compressed;
      }
      // Filename → clean + parse "Artist - Title" so messy library filenames produce nice titles
      const cleaned=cleanFilename(file.name);
      const parsed=parseArtistTitle(cleaned);
      const title=tags.title||parsed.title;
      const artist=tags.artist||parsed.artist||"Unknown Artist";
      // Duplicate detection: skip if an existing or in-batch track matches normalized artist+title.
      // Skipped when opts.skipDedup is true (user opted to import duplicates explicitly).
      const candidate={artist,title};
      const isDupe = !opts.skipDedup && (
        library.some(existing=>tracksMatch(existing,candidate))
        || batchAdded.some(prior=>tracksMatch(prior,candidate))
      );
      if(isDupe){skippedCount++;continue;}
      // Store artwork in both memory cache and track record so it survives page reloads
      if(tags.artwork){artworkCache.current[id]=tags.artwork;}
      const track={id,filename:file.name.replace(/\.[^.]+$/,""),title,artist,album:tags.album||"",genre:tags.genre||"",label:tags.label||"",bpm:tags.bpm?parseFloat(tags.bpm):null,key:tags.key||null,duration:null,energy:null,analyzed:false,error:false,addedAt:Date.now(),artwork:tags.artwork||null};
      // Don't pin File in fileMap or queue for analysis — both retained the File
      // reference for the whole session, and 300+ pinned blobs caused OOM. getFile
      // will hit OPFS first; analysis is deferred to handleLibLoad → queueAnalysis.
      // Await OPFS write: if it fails, skip the rest of this iteration so we
      // don't end up with IDB metadata that points at non-existent OPFS files.
      // (No importedCount-- needed: the increment is at the end of the loop;
      // `continue` here means it's never reached for this track.)
      try {
        await opfsStore(id, file);
      } catch (err) {
        console.error('[IMPORT-OPFS-FAIL]', { id, filename: file.name, error: err?.message || String(err) });
        continue;
      }
      setLibrary(prev=>{
        if(prev.find(t=>t.filename===track.filename)){
          console.log('[STATE-SET-SKIP]',{id,reason:'filename-dupe',length:prev.length});
          return prev;
        }
        const next=[...prev,track];
        console.log('[STATE-SET]',{id,prevLength:prev.length,nextLength:next.length});
        return next;
      });
      batchAdded.push(track);
      // Persist metadata + handle to IDB so tracks survive page reloads
      try{await cmDbPut("tracks",track);}catch(err){console.error('[IMPORT-ITER-IDB-CAUGHT]',{id,error:err?.message||String(err)});}
      if(handle){try{await cmDbPutHandle(id,handle);}catch(err){console.error('[IMPORT-ITER-HANDLE-CAUGHT]',{id,error:err?.message||String(err)});}}
      importedCount++;
    }
    console.log('[IMPORT-DONE]',{importedCount,skippedCount,totalCandidates:audio.length,ms:Math.round(performance.now()-tImport0)});
    if(skippedCount>0){
      console.log(`[library] Imported ${importedCount} tracks, skipped ${skippedCount} duplicate${skippedCount===1?"":"s"}`);
    }
    setImporting(false); processQ();
  },[processQ,library]);

  // Preview phase: parse files + detect duplicates against the existing library
  // and within the batch itself. Does NOT commit anything. Used by the import
  // confirmation modal so the user can decide what to do about duplicates.
  const previewImport=useCallback(async(files)=>{
    const audio=[...files].filter(f=>(f.type&&f.type.startsWith("audio/"))||/\.(mp3|wav|flac|aac|ogg|m4a)$/i.test(f.name));
    const items=[];
    const seenInBatch=[];
    for(const file of audio){
      let id3={};
      try{const sl=file.slice(0,1048576);id3=parseID3(await sl.arrayBuffer());}catch{}
      const cleaned=cleanFilename(file.name);
      const parsed=parseArtistTitle(cleaned);
      const title=id3.title||parsed.title;
      const artist=id3.artist||parsed.artist||"Unknown Artist";
      const candidate={artist,title};
      const isDupeInLib=library.some(t=>tracksMatch(t,candidate));
      const isDupeInBatch=seenInBatch.some(t=>tracksMatch(t,candidate));
      const isDupe=isDupeInLib||isDupeInBatch;
      if(!isDupe) seenInBatch.push(candidate);
      items.push({file,title,artist,isDupe});
    }
    return items;
  },[library]);

  // Commit phase: take the preview items + a strategy and actually import.
  // strategy: "skipDupes" filters out items.isDupe; "importAll" imports everything.
  // Always calls _importFileObjects with skipDedup:true since the dedup decision
  // has already been made by the caller (preview + user choice).
  const commitImport=useCallback(async(previewItems,strategy)=>{
    const toImport=strategy==="skipDupes"
      ? previewItems.filter(item=>!item.isDupe)
      : previewItems;
    const filesToImport=toImport.map(item=>item.file);
    if(filesToImport.length>0){
      await _importFileObjects(filesToImport,[],{skipDedup:true});
    }
  },[_importFileObjects]);

  // Import via showOpenFilePicker (preferred — handles persist in IDB)
  const importFromPicker=useCallback(async()=>{
    if(!window.showOpenFilePicker){
      // Fallback handled by caller (file input click)
      return false;
    }
    try{
      const handles=await window.showOpenFilePicker({
        multiple:true,
        types:[{description:"Audio Files",accept:{"audio/*":[".mp3",".wav",".flac",".aac",".ogg",".m4a"]}}]
      });
      const files=await Promise.all(handles.map(h=>h.getFile()));
      await _importFileObjects(files,handles);
      return true;
    }catch(e){
      if(e.name==="AbortError")return true; // user cancelled
      return false;
    }
  },[_importFileObjects]);

  // Fallback: import from File objects (drag-drop or input — handles NOT persisted)
  const importFiles=useCallback(async(files)=>{
    await _importFileObjects([...files],[]);
  },[_importFileObjects]);

  // Analyze all unanalyzed tracks in library (also extracts + persists artwork for tracks missing it)
  const analyzeAll=useCallback(async(getFileFn)=>{
    setAnalyzing(true);
    const toProcess=library||[];
    for(const track of toProcess){
      const file=await getFileFn(track.id);
      if(!file) continue;
      // Queue for BPM/key analysis if needed
      if(!track.analyzed||track.error){
        queueRef.current.push({id:track.id,file,skipBPM:!!track.bpm,skipKey:!!track.key});
      }
      // Extract and persist artwork if this track is missing it
      if(!track.artwork&&artworkCache.current[track.id]!==false){
        try{
          const sl=file.slice(0,1048576);
          const tags=parseID3(await sl.arrayBuffer());
          if(tags.artwork){
            artworkCache.current[track.id]=tags.artwork;
            try{
              const existing=await cmDbGet("tracks",track.id);
              if(existing&&!existing.artwork){
                await cmDbPut("tracks",{...existing,artwork:tags.artwork});
                setLibrary(prev=>prev.map(t=>t.id===track.id?{...t,artwork:tags.artwork}:t));
              }
            }catch{}
          }else{
            artworkCache.current[track.id]=false;
          }
        }catch{}
      }
    }
    processQ();
    setTimeout(()=>setAnalyzing(false),500);
  },[library,processQ]);

  // Background artwork extraction for IDB tracks that have accessible file handles
  const extractArtworkForTrack=useCallback(async(trackId,getFileFn)=>{
    if(artworkCache.current[trackId])return artworkCache.current[trackId];
    const file=await getFileFn(trackId);
    if(!file)return null;
    try{
      const sl=file.slice(0,1048576);
      const tags=parseID3(await sl.arrayBuffer());
      if(tags.artwork){
        artworkCache.current[trackId]=tags.artwork;
        // Persist artwork back into the IDB track record so it survives future reloads
        try{
          const existing=await cmDbGet("tracks",trackId);
          if(existing&&!existing.artwork){await cmDbPut("tracks",{...existing,artwork:tags.artwork});}
        }catch{}
        return tags.artwork;
      }
    }catch{}
    artworkCache.current[trackId]=false; // mark as checked, no artwork
    return null;
  },[]);

  // Reconnect all tracks from a folder the user selects — one click restores file access + artwork
  const reconnectFromFolder=useCallback(async()=>{
    try{
      const dir=await window.showDirectoryPicker({mode:"read"});
      // Recursively build filename→fileHandle map so subfolders are included
      const nameMap={};
      const scanDir=async(dirHandle)=>{
        for await(const[name,h]of dirHandle.entries()){
          if(h.kind==="file"){
            const ext=name.split(".").pop().toLowerCase();
            if(["mp3","wav","flac","aiff","aif","ogg","m4a","opus","weba"].includes(ext)){
              nameMap[name.replace(/\.[^.]+$/,"").toLowerCase()]=h;
            }
          }else if(h.kind==="directory"){
            try{await scanDir(h);}catch{}
          }
        }
      };
      await scanDir(dir);
      const artworkUpdates=[];
      for(const track of library||[]){
        const baseFn=track.filename.replace(/\.[^.]+$/,"").toLowerCase(); // strip extension if stored with one
        const h=nameMap[baseFn]||nameMap[track.title.toLowerCase()];
        if(!h)continue;
        let file;
        try{file=await h.getFile();}catch{continue;}
        fileMap.current[track.id]=file;
        opfsStore(track.id,file); // write to OPFS so future sessions need zero clicks
        // Also store handle in IDB so future sessions work
        try{await cmDbPut("handles",h,track.id);}catch{}
        // Populate in-memory artwork cache — cover tracks already in IDB and those missing artwork
        if(track.artwork&&!artworkCache.current[track.id]){
          artworkCache.current[track.id]=track.artwork; // restore cache from IDB value
        }
        if(!track.artwork&&artworkCache.current[track.id]!==false){
          try{
            const sl=file.slice(0,1048576);
            const tags=parseID3(await sl.arrayBuffer());
            if(tags.artwork){
              artworkCache.current[track.id]=tags.artwork;
              try{
                const existing=await cmDbGet("tracks",track.id);
                if(existing&&!existing.artwork){
                  await cmDbPut("tracks",{...existing,artwork:tags.artwork});
                  artworkUpdates.push({id:track.id,artwork:tags.artwork});
                }
              }catch{}
            }else{artworkCache.current[track.id]=false;}
          }catch{}
        }
      }
      if(artworkUpdates.length){
        setLibrary(prev=>prev.map(t=>{const u=artworkUpdates.find(x=>x.id===t.id);return u?{...t,artwork:u.artwork}:t;}));
      }
    }catch{} // user cancelled
  },[library]);

  // Get File object — in-memory first, then OPFS (zero-click, survives restarts), then IDB handle
  const getFile=useCallback(async(id)=>{
    if(fileMap.current[id]){
      console.log('[GET-FILE]',{id,branch:'fileMap-hit'});
      return fileMap.current[id];
    }
    // OPFS: zero permissions, always works, survives browser restarts
    const opfsFile=await opfsGet(id);
    if(opfsFile){
      console.log('[GET-FILE]',{id,branch:'opfs-hit',size:opfsFile.size});
      fileMap.current[id]=opfsFile;
      return opfsFile;
    }
    // Fall back to IDB file handle (requires browser session or user gesture)
    try{
      const handle=await cmDbGet("handles",id);
      if(!handle){
        console.log('[GET-FILE]',{id,branch:'no-handle-null'});
        return null;
      }
      const perm=await handle.queryPermission({mode:"read"});
      if(perm!=="granted"){
        const req=await handle.requestPermission({mode:"read"});
        if(req!=="granted"){
          console.log('[GET-FILE]',{id,branch:'permission-denied'});
          return null;
        }
      }
      const file=await handle.getFile();
      console.log('[GET-FILE]',{id,branch:'idb-handle-hit',size:file?.size});
      fileMap.current[id]=file;
      opfsStore(id,file).catch(()=>{}); // migrate to OPFS so future sessions need zero clicks
      return file;
    }catch(err){
      console.warn('[GET-FILE]',{id,branch:'idb-handle-error',error:err?.message||String(err)});
      return null;
    }
  },[]);

  // Re-scan ID3 APIC artwork for every track currently missing an artwork blob.
  // Reads the first 1MB of the source file, parses ID3v2, pulls the APIC frame
  // as a base64 data URL, and persists it back to the IDB track record.
  const scanArtwork=useCallback(async()=>{
    setAnalyzing(true);
    const toProcess=(library||[]).filter(t=>!t.artwork);
    for(const track of toProcess){
      let file=null;
      try{file=await getFile(track.id);}catch{}
      if(!file)continue;
      try{
        const sl=file.slice(0,1048576);
        const tags=parseID3(await sl.arrayBuffer());
        if(tags.artwork){
          artworkCache.current[track.id]=tags.artwork;
          try{
            const existing=await cmDbGet("tracks",track.id);
            if(existing){
              await cmDbPut("tracks",{...existing,artwork:tags.artwork});
              setLibrary(prev=>prev.map(t=>t.id===track.id?{...t,artwork:tags.artwork}:t));
            }
          }catch{}
        }else{
          artworkCache.current[track.id]=false;
        }
      }catch{}
    }
    setTimeout(()=>setAnalyzing(false),300);
  },[library,getFile]);

  const clear=()=>{setLibrary([]);fileMap.current={};opfsClear();};

  const reload=useCallback(async()=>{
    try{
      const tracks=await cmDbAll("tracks");
      if(tracks.length>0){
        // Pre-populate artworkCache from IDB so artwork shows immediately without file access
        tracks.forEach(t=>{
          if(t.artwork&&!artworkCache.current[t.id])artworkCache.current[t.id]=t.artwork;
        });
        setLibrary(tracks);
      }
      const q=await cmDbAll("queue");
      setQueue(q.sort((a,b)=>a.order-b.order).map(r=>r.trackId));
      const cr=await cmDbAll("crates");
      setCrates(cr);
    }catch{}
  },[]);

  // Lazy library-side analysis trigger. Called from handleLibLoad when the user
  // actually loads a track to a deck — bounds analysis to user activity rather
  // than bulk on import or app mount.
  const queueAnalysis=useCallback((id,file)=>{
    if(queueRef.current.some(q=>q.id===id))return; // already enqueued
    const t=library.find(x=>x.id===id);
    if(t?.analyzed)return; // already analyzed since handleLibLoad started
    queueRef.current.push({id,file,skipBPM:!!t?.bpm,skipKey:!!t?.key});
    processQ();
  },[library,processQ]);

  return{library,queue,crates,importing,importFiles,importFromPicker,previewImport,commitImport,queueAnalysis,getFile,clear,reload,setLibrary,fileMap,analyzing,analyzeAll,extractArtworkForTrack,artworkCache,reconnectFromFolder,scanArtwork};
}

// ── Library Panel UI ──────────────────────────────────────────

// Avatar colour-hash for artwork placeholder
const SES_AVATAR_COLORS=[["#8B5CF6","#6D28D9"],["#C8A96E","#A07840"],["#C8A96E","#0099bb"],["#22c55e","#16a34a"],["#f59e0b","#d97706"],["#ef4444","#dc2626"],["#ec4899","#db2777"],["#14b8a6","#0d9488"]];
function sesAvatarColor(str=""){let h=0;for(let i=0;i<str.length;i++)h=(h<<5)-h+str.charCodeAt(i);return SES_AVATAR_COLORS[Math.abs(h)%SES_AVATAR_COLORS.length];}

function TrackRow({track, onLoadA, onLoadB, isRec, reasons, canLoad, previewTrackId, onPreview, onDelete, onRemoveFromPlaylist, onDragStart, extractArtwork}){
  const [hov,setHov]=useState(false);
  const [showDeckMenu,setShowDeckMenu]=useState(false);
  const [ctxMenu,setCtxMenu]=useState(null); // {x,y}
  const [artworkSrc,setArtworkSrc]=useState(track.artwork||null);
  const deckMenuRef=useRef(null);
  const G="#C8A96E";
  const eColor=ENERGY_COLOR[track.energy?.label]||"#555562";
  const fmt=(s)=>s?`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,"0")}`:"--";
  const camelot=CAMELOT[track.key];
  const isMinor=camelot?.endsWith("A");
  const keyColor=isMinor?"#8B6EAF":G;
  const [ac,ac2]=sesAvatarColor(track.artist||track.title||"");
  const initial=(track.artist||track.title||"?")[0].toUpperCase();
  const isPreviewing=previewTrackId===track.id;

  // Sync artworkSrc when track.artwork is updated externally (e.g. after reconnect or analyzeAll)
  useEffect(()=>{
    if(track.artwork&&!artworkSrc)setArtworkSrc(track.artwork);
  },[track.artwork,artworkSrc]);

  // Lazy artwork extraction for IDB tracks (fallback when not in IDB record)
  useEffect(()=>{
    if(artworkSrc||!extractArtwork)return;
    let cancelled=false;
    extractArtwork(track.id).then(src=>{if(!cancelled&&src)setArtworkSrc(src);});
    return()=>{cancelled=true;};
  },[track.id,artworkSrc,extractArtwork]);

  // Close deck menu on outside click
  useEffect(()=>{
    if(!showDeckMenu)return;
    const close=(e)=>{if(deckMenuRef.current&&!deckMenuRef.current.contains(e.target))setShowDeckMenu(false);};
    document.addEventListener("mousedown",close);
    return()=>document.removeEventListener("mousedown",close);
  },[showDeckMenu]);

  // Close context menu on click outside
  useEffect(()=>{
    if(!ctxMenu)return;
    const close=()=>setCtxMenu(null);
    document.addEventListener("mousedown",close);
    return()=>document.removeEventListener("mousedown",close);
  },[ctxMenu]);

  return(
    <div
      onMouseEnter={()=>setHov(true)}
      onMouseLeave={()=>setHov(false)}
      draggable={true}
      onDragStart={e=>{
        e.dataTransfer.setData("application/json",JSON.stringify({trackId:track.id,title:track.title,artist:track.artist}));
        e.dataTransfer.effectAllowed="copy";
        if(onDragStart)onDragStart(track);
      }}
      onContextMenu={e=>{e.preventDefault();setCtxMenu({x:e.clientX,y:e.clientY});}}
      style={{display:"grid",gridTemplateColumns:"28px 36px 1fr 70px 44px 70px 44px 84px",gap:6,alignItems:"center",padding:"5px 10px",background:isRec?"#22c55e07":hov?"#18182299":"transparent",borderBottom:"1px solid #14141e88",transition:"background .1s",position:"relative",cursor:"grab"}}
    >
      {/* Context menu */}
      {ctxMenu&&(
        <div onMouseDown={e=>e.stopPropagation()} style={{position:"fixed",left:ctxMenu.x,top:ctxMenu.y,zIndex:9999,background:"#111118",border:"1px solid #252535",borderRadius:8,padding:"4px 0",minWidth:160,boxShadow:"0 12px 32px rgba(0,0,0,.9)"}}>
          <div style={{padding:"2px 14px 6px",fontSize:7,fontFamily:"'DM Mono',monospace",color:"#555562",letterSpacing:1.2}}>{track.title?.substring(0,24)||track.filename}</div>
          <div style={{height:1,background:"#1e1e28",margin:"0 0 4px"}}/>
          {onLoadA&&<div onClick={()=>{onLoadA(track);setCtxMenu(null);}} style={{padding:"7px 14px",fontSize:10,fontFamily:"'DM Sans',sans-serif",color:"#7B61FF",cursor:"pointer",background:"transparent"}} onMouseEnter={e=>e.currentTarget.style.background="#7B61FF0e"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>▶ Load to Deck A</div>}
          {onLoadB&&<div onClick={()=>{onLoadB(track);setCtxMenu(null);}} style={{padding:"7px 14px",fontSize:10,fontFamily:"'DM Sans',sans-serif",color:"#00BFA5",cursor:"pointer",background:"transparent"}} onMouseEnter={e=>e.currentTarget.style.background="#00BFA50e"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>▶ Load to Deck B</div>}
          {onPreview&&<div onClick={()=>{onPreview(track);setCtxMenu(null);}} style={{padding:"7px 14px",fontSize:10,fontFamily:"'DM Sans',sans-serif",color:"#888898",cursor:"pointer",background:"transparent"}} onMouseEnter={e=>e.currentTarget.style.background="#18182299"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>{isPreviewing?"⏸ Stop Preview":"▶ Preview"}</div>}
          <div style={{height:1,background:"#1e1e28",margin:"4px 0"}}/>
          {onRemoveFromPlaylist&&<div onClick={()=>{onRemoveFromPlaylist(track.id);setCtxMenu(null);}} style={{padding:"7px 14px",fontSize:10,fontFamily:"'DM Sans',sans-serif",color:"#C8A96E",cursor:"pointer",background:"transparent"}} onMouseEnter={e=>e.currentTarget.style.background="#C8A96E10"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>↩ Remove from Playlist</div>}
          {onDelete&&<div onClick={()=>{onDelete(track.id);setCtxMenu(null);}} style={{padding:"7px 14px",fontSize:10,fontFamily:"'DM Sans',sans-serif",color:"#ef4444",cursor:"pointer",background:"transparent"}} onMouseEnter={e=>e.currentTarget.style.background="#ef444410"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>🗑 Remove from Library</div>}
        </div>
      )}
      {/* + Quick-add to deck */}
      <div style={{position:"relative"}} ref={deckMenuRef}>
        <button onClick={e=>{e.stopPropagation();setShowDeckMenu(v=>!v);}}
          style={{width:22,height:22,borderRadius:5,background:showDeckMenu?`${G}22`:hov?`${G}12`:"transparent",border:`1px solid ${hov||showDeckMenu?G+"44":"transparent"}`,color:hov||showDeckMenu?G:"transparent",fontSize:14,lineHeight:1,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",transition:"all .15s",fontFamily:"'DM Mono',monospace"}}>＋</button>
        {showDeckMenu&&(
          <div onClick={e=>e.stopPropagation()} style={{position:"absolute",left:0,top:"calc(100% + 4px)",zIndex:500,background:"#111118",border:"1px solid #252535",borderRadius:10,padding:6,minWidth:130,boxShadow:"0 12px 32px rgba(0,0,0,.85)"}}>
            <div style={{fontSize:8,color:"#555562",fontFamily:"'DM Mono',monospace",padding:"2px 8px 6px",letterSpacing:1.2}}>LOAD TO DECK</div>
            <div style={{display:"flex",gap:4,padding:"0 4px"}}>
              {onLoadA&&<button onClick={e=>{e.stopPropagation();onLoadA(track);setShowDeckMenu(false);}} style={{flex:1,padding:"7px 4px",background:`${G}18`,border:`1px solid ${G}44`,color:G,borderRadius:7,cursor:"pointer",fontFamily:"'DM Mono',monospace",fontSize:11,fontWeight:700}}>▶ A</button>}
              {onLoadB&&<button onClick={e=>{e.stopPropagation();onLoadB(track);setShowDeckMenu(false);}} style={{flex:1,padding:"7px 4px",background:"#C8A96E18",border:"1px solid #C8A96E44",color:"#C8A96E",borderRadius:7,cursor:"pointer",fontFamily:"'DM Mono',monospace",fontSize:11,fontWeight:700}}>▶ B</button>}
            </div>
          </div>
        )}
      </div>

      {/* Artwork — click to preview */}
      <div onClick={e=>{e.stopPropagation();if(onPreview)onPreview(track);}} title={isPreviewing?"Stop preview":"Preview"}
        style={{width:36,height:36,borderRadius:4,flexShrink:0,background:(artworkSrc||track.artwork)?"#000":"#13122A",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:700,color:eColor,fontFamily:"'DM Sans',sans-serif",userSelect:"none",position:"relative",overflow:"hidden",cursor:"pointer",outline:isPreviewing?`2px solid ${G}`:"none",transition:"outline .1s"}}>
        {(artworkSrc||track.artwork)?<img src={artworkSrc||track.artwork} alt="" style={{width:"100%",height:"100%",objectFit:"cover",position:"absolute",inset:0}}/>:<span style={{position:"relative",zIndex:1}}>{initial}</span>}
        {isPreviewing&&<div style={{position:"absolute",inset:0,background:"rgba(0,0,0,.6)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:2}}><span style={{fontSize:11}}>⏸</span></div>}
        {!isPreviewing&&hov&&<div style={{position:"absolute",inset:0,background:"rgba(0,0,0,.45)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:2}}><span style={{fontSize:10,color:"#fff"}}>▶</span></div>}
      </div>

      {/* Title + artist + label */}
      <div style={{overflow:"hidden",minWidth:0}}>
        <div style={{display:"flex",gap:5,alignItems:"center"}}>
          {isRec&&<div style={{width:4,height:4,borderRadius:"50%",background:"#22c55e",boxShadow:"0 0 4px #22c55e",flexShrink:0}}/>}
          {!track.analyzed&&!track.error&&<div style={{width:8,height:8,border:`1.5px solid ${G}33`,borderTop:`1.5px solid ${G}`,borderRadius:"50%",animation:"spin 1s linear infinite",flexShrink:0}}/>}
          <div style={{fontSize:11,color:hov?"#e8e8f0":"#d8d8e2",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",fontFamily:"'DM Sans',sans-serif",fontWeight:400}}>{track.title||track.filename}</div>
        </div>
        <div style={{fontSize:9,color:"#888898",fontFamily:"'DM Sans',sans-serif",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",marginTop:1}}>
          {track.artist||"Unknown Artist"}
          {track.label&&<span style={{color:"#555562"}}> · <span style={{color:`${G}cc`,fontFamily:"'DM Mono',monospace",fontSize:8}}>{track.label}</span></span>}
        </div>
        {reasons?.length>0&&(<div style={{display:"flex",gap:3,marginTop:2}}>{reasons.map(r=><span key={r} style={{fontSize:7,fontFamily:"'DM Mono',monospace",color:"#22c55e",background:"#22c55e11",borderRadius:2,padding:"0 4px",letterSpacing:.5}}>{r}</span>)}</div>)}
      </div>

      {/* BPM — single number, no label */}
      <div style={{textAlign:"right",fontSize:12,fontFamily:"'DM Mono',monospace",color:track.bpm?"#C8A96E":"#2a2a3a",fontWeight:500}}>{track.bpm?track.bpm.toFixed(1):"--"}</div>

      {/* Key — rounded pill, gold for major, violet for minor, white text */}
      <div style={{textAlign:"center"}}>
        {camelot?<span style={{fontSize:9,fontFamily:"'DM Mono',monospace",color:"#ffffff",background:isMinor?"#7B61FF":"#C8A96E",borderRadius:4,padding:"2px 6px",display:"inline-block",letterSpacing:.3,fontWeight:500}}>{camelot}</span>:<span style={{fontSize:11,color:"#555562",fontFamily:"'DM Mono',monospace"}}>--</span>}
      </div>

      {/* Energy — colored text label, no bar */}
      <div style={{fontSize:11,fontFamily:"'DM Mono',monospace",color:track.energy?eColor:"#555562",letterSpacing:.3,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{track.energy?track.energy.label:"--"}</div>

      {/* Duration */}
      <div style={{fontSize:11,fontFamily:"'DM Mono',monospace",color:"#888898",textAlign:"right"}}>{fmt(track.duration)}</div>

      {/* A / B load buttons — color-coded to deck identity (violet / teal) so
          users can see they have two destinations, not one. Always visible at
          55% opacity so users discover them without needing to hover-and-wait;
          full opacity on row hover. */}
      <div style={{display:"flex",gap:4,opacity:canLoad?(hov?1:0.55):0,transition:"opacity .15s"}}>
        {onLoadA&&<button onClick={e=>{e.stopPropagation();onLoadA(track);}} title="Load to Deck A" style={{padding:"4px 10px",fontSize:11,fontWeight:700,fontFamily:"'DM Mono',monospace",background:"#7B61FF1f",border:"1px solid #7B61FF66",color:"#7B61FF",borderRadius:5,cursor:"pointer",letterSpacing:.5}}>→A</button>}
        {onLoadB&&<button onClick={e=>{e.stopPropagation();onLoadB(track);}} title="Load to Deck B" style={{padding:"4px 10px",fontSize:11,fontWeight:700,fontFamily:"'DM Mono',monospace",background:"#00BFA51f",border:"1px solid #00BFA566",color:"#00BFA5",borderRadius:5,cursor:"pointer",letterSpacing:.5}}>→B</button>}
      </div>
    </div>
  );
}

// ── Library Panel V2 — redesigned three-column layout (PROTOTYPE) ──
// Left rail: folders (smart + user crates) · Center: tabs + search + filter
// pills + track list · Right rail: queue (top) + chat (bottom). Uses the same
// props as LibraryPanel so the parent render site is a one-line swap. The old
// LibraryPanel function is kept immediately below as a reference while we
// iterate on this new layout — nothing else in the app references it directly
// once the swap is made.
function LibraryPanelV2({ lib, onLoad, playingTrack, previewTrackId, onPreview, onDelete, chat, onSendChat, me }) {
  const G = "#C8A96E";
  const BG = "#080810";
  const BG2 = "#0D0C1A";
  const BG3 = "#13122A";
  const BORDER = "#1c1c24";
  const TEXT = "#EDE8DF";
  const SUBTLE = "#9B96B0";
  const MUTED = "#555562";
  const PARTNER = "#00BFA5";

  // ── Mock data for empty library (prototype — replaced by real data on first import). ──
  const MOCK_TRACKS = [
    { id:"m1", title:"Brighter Days",     artist:"Lane 8",           album:"Colour in Nature",     label:"This Never Happened", genre:"Melodic Techno",  bpm:124.0, key:"8A",  energy:72, energyLabel:"Build",     duration:368, analyzed:true  },
    { id:"m2", title:"Nova",              artist:"Yotto",            album:"Erased Dreams",        label:"Anjunadeep",          genre:"Melodic House",   bpm:122.0, key:"7A",  energy:65, energyLabel:"Warm-Up",   duration:412, analyzed:true  },
    { id:"m3", title:"Elysium",           artist:"Tinlicker",        album:"In Another Life",      label:"Anjunadeep",          genre:"Melodic Techno",  bpm:123.5, key:"9B",  energy:68, energyLabel:"Build",     duration:395, analyzed:true  },
    { id:"m4", title:"Velocity",          artist:"Jody Wisternoff",  album:"Olympia",              label:"Anjunadeep",          genre:"Progressive House", bpm:125.0, key:"6A",  energy:78, energyLabel:"Peak Hour", duration:342, analyzed:true  },
    { id:"m5", title:"Submerged",         artist:"Cubicolor",        album:"Brainsugar",           label:"Anjunadeep",          genre:"Deep House",      bpm:120.0, key:"4A",  energy:55, energyLabel:"Warm-Up",   duration:428, analyzed:true  },
    { id:"m6", title:"Solstice",          artist:"Ben Böhmer",       album:"Begin Again",          label:"Anjunadeep",          genre:"Melodic House",   bpm:118.0, key:"11A", energy:48, energyLabel:"Ambient",   duration:446, analyzed:true  },
    { id:"m7", title:"Through the Lens",  artist:"Marsh",            album:"Lailonie",             label:"Anjunadeep",          genre:"Progressive House", bpm:121.5, key:"5A",  energy:70, energyLabel:"Build",     duration:384, analyzed:true  },
    { id:"m8", title:"Afterglow",         artist:"Kasablanca",       album:"Stormchild",           label:"Anjunabeats",         genre:"Progressive House", bpm:126.0, key:"3B",  energy:82, energyLabel:"Peak Hour", duration:356, analyzed:true  },
    { id:"m9", title:"Reverie",           artist:"Nils Hoffmann",    album:"A Romantic Notion",    label:"Poesie",              genre:"Melodic House",   bpm:null,  key:null,  energy:null, duration:null,         analyzed:false },
    { id:"m10", title:"Drift Awake",      artist:"Luttrell",         album:"After All This Time",  label:"Anjunadeep",          genre:"Melodic House",   bpm:null,  key:null,  energy:null, duration:null,         analyzed:false },
  ];
  const MOCK_CRATES = [
    { id:"mf1", name:"Saturday Set", trackIds:["m1","m2","m4","m7","m8"] },
    { id:"mf2", name:"Warm-up",      trackIds:["m2","m5","m6","m3","m7","m1","m9","m10"] },
  ];
  const MOCK_QUEUE = ["m3","m4","m1"];

  const realTracks = lib.library || [];
  const realCrates = lib.crates || [];
  const realQueue  = lib.queue   || [];
  // Mock library disabled — empty state CTA renders instead. MOCK_* constants
  // above are kept in place for easy re-enable during testing.
  const useMock = false;
  const allTracks = realTracks;
  const crates    = realCrates;
  const queueIds  = realQueue;
  // Mock "loaded on deck" state so the row indicator can be visually demonstrated
  // in the prototype. When real tracks are loaded this would come from the parent's
  // deck-track state.
  const deckATrackId = useMock ? "m2"  : (playingTrack?.id || null);
  const deckBTrackId = useMock ? "m5"  : null;
  const DECK_A_CLR = "#7B61FF"; // violet
  const DECK_B_CLR = "#00BFA5"; // teal

  // Suggestion source: prefer deck A, else deck B. Panel is disabled when neither loaded.
  const suggestionSourceId = deckATrackId || deckBTrackId || null;
  const suggestionSourceDeck = deckATrackId ? "A" : (deckBTrackId ? "B" : null);
  const suggestionSource = suggestionSourceId ? allTracks.find(t => t.id === suggestionSourceId) : null;
  const suggestions = suggestionSource ? recommendTracks(suggestionSource, allTracks, 10) : [];

  // View state model:
  //   kind = "tab"    — persistent dimension tabs (all / artists / labels / genres / energy).
  //                     drill = null shows the group list; drill = <value> shows tracks in that group.
  //   kind = "smart"  — sidebar smart section (smartId = "recent" | "session").
  //   kind = "folder" — sidebar user folder/crate (folderId = crate.id).
  // Tabs are ALWAYS visible; they slice the library by dimension. Sidebar clicks REPLACE the view
  // (they do not open tabs). Search + filter pills refine whatever view is active.
  const PERSISTENT_TABS = [
    { id: "all",     label: "All Tracks" },
    { id: "artists", label: "Artists" },
    { id: "labels",  label: "Labels" },
    { id: "genres",  label: "Genres" },
    { id: "energy",  label: "Energy" },
  ];
  const [view, setView] = useState({ kind: "tab", tab: "all", drill: null });
  const selectTab    = (tab) => setView({ kind: "tab", tab, drill: null });
  const drillInto    = (value) => setView(v => ({ ...v, kind: "tab", drill: value }));
  const clearDrill   = () => setView(v => ({ ...v, drill: null }));
  const selectSmart  = (smartId) => setView({ kind: "smart", smartId });
  const selectFolder = (folderId) => setView({ kind: "folder", folderId });

  // Suggestions panel — slides in from the right. Source deck is whichever is
  // currently loaded (A takes priority if both are loaded).
  const [showSuggestions, setShowSuggestions] = useState(false);

  // Queue/chat split — persisted fraction of the right rail devoted to the queue.
  const [queueFraction, setQueueFraction] = useState(() => {
    let raw = "";
    try { raw = localStorage.getItem("queueFraction") || ""; } catch (e) { console.warn('localStorage.getItem failed', 'queueFraction', e); }
    const saved = parseFloat(raw);
    return isFinite(saved) && saved >= 0.15 && saved <= 0.85 ? saved : 0.4;
  });
  const queueFractionRef = useRef(queueFraction);
  useEffect(() => { queueFractionRef.current = queueFraction; }, [queueFraction]);
  const startSplitDrag = (e) => {
    e.preventDefault();
    const col = e.currentTarget.parentElement;
    const rect = col.getBoundingClientRect();
    const onMove = (ev) => {
      const frac = Math.max(0.15, Math.min(0.85, (ev.clientY - rect.top) / rect.height));
      setQueueFraction(frac);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      try { localStorage.setItem("queueFraction", String(queueFractionRef.current)); } catch (e) { console.warn('localStorage.setItem failed', 'queueFraction', e); }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
  const [search, setSearch] = useState("");
  const [matchDeckA, setMatchDeckA] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [playedIds, setPlayedIds] = useState(() => new Set());
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [importPreview, setImportPreview] = useState(null); // { items, dupeCount, newCount } | null
  const fileInputRef = useRef(null);
  const chatEndRef = useRef(null);

  // Preview-then-commit wrapper. Always parses + dedup-checks first; if any
  // duplicates are found, surfaces a confirmation modal. Silent path when no dupes.
  const handleImportFiles = async (files) => {
    if (!files || files.length === 0) return;
    const audioFiles = [...files].filter(f =>
      /\.(mp3|wav|flac|aac|ogg|m4a)$/i.test(f.name) || (f.type && f.type.startsWith("audio/"))
    );
    if (audioFiles.length === 0) return;
    const items = await lib.previewImport(audioFiles);
    if (items.length === 0) return;
    const dupeCount = items.filter(i => i.isDupe).length;
    const newCount = items.length - dupeCount;
    if (dupeCount === 0) {
      await lib.commitImport(items, "skipDupes");
    } else {
      setImportPreview({ items, dupeCount, newCount });
    }
  };

  const handleAddMusic = async () => {
    try {
      if (window.showOpenFilePicker) {
        const handles = await window.showOpenFilePicker({
          multiple: true,
          types: [{
            description: "Audio Files",
            accept: { "audio/*": [".mp3",".wav",".flac",".aac",".ogg",".m4a"] }
          }],
        });
        const files = await Promise.all(handles.map(h => h.getFile()));
        await handleImportFiles(files);
      } else {
        // Fallback for browsers without File System Access API (Safari, Firefox)
        fileInputRef.current?.click();
      }
    } catch (err) {
      if (err.name !== "AbortError") console.error("Import error:", err);
    }
  };

  // Recursively traverse dropped DataTransferItems (handles folders via webkitGetAsEntry)
  const handleDroppedItems = async (items) => {
    const allFiles = [];
    const traverse = async (entry) => {
      if (entry.isFile) {
        return new Promise((resolve) => {
          entry.file((file) => { allFiles.push(file); resolve(); },
                     (err) => { console.warn("Could not read file:", entry.name, err); resolve(); });
        });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        return new Promise((resolve) => {
          const readBatch = () => {
            reader.readEntries(async (entries) => {
              if (entries.length === 0) { resolve(); return; }
              for (const sub of entries) await traverse(sub);
              readBatch(); // readEntries returns ≤100 at a time; keep reading until empty
            }, (err) => { console.warn("Could not read directory:", entry.name, err); resolve(); });
          };
          readBatch();
        });
      }
    };
    const promises = [];
    for (const item of items) {
      const entry = item.webkitGetAsEntry();
      if (entry) promises.push(traverse(entry));
    }
    await Promise.all(promises);
    const audioFiles = allFiles.filter(f =>
      /\.(mp3|wav|flac|aac|ogg|m4a)$/i.test(f.name) || f.type.startsWith("audio/")
    );
    if (audioFiles.length > 0) await handleImportFiles(audioFiles);
  };

  useEffect(() => {
    if (playingTrack?.id) setPlayedIds(prev => new Set(prev).add(playingTrack.id));
  }, [playingTrack?.id]);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chat]);

  const fmtDur = s => s ? `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,"0")}` : "—";

  // Helper: extract the group-key for a track given a dimension tab.
  const groupFieldFor = (t, tab) => {
    if (tab === "artists") return t.artist || "Unknown Artist";
    if (tab === "labels")  return t.label  || "Unknown Label";
    if (tab === "genres")  return t.genre  || "Unknown Genre";
    if (tab === "energy")  return t.energyLabel || "Unrated";
    return null;
  };

  // Base universe for the current view. Filters and drill narrow this further below.
  const baseTracks = (() => {
    if (view.kind === "smart") return allTracks.filter(t => playedIds.has(t.id));
    if (view.kind === "folder") {
      const cr = crates.find(c => c.id === view.folderId);
      return (cr?.trackIds || []).map(id => allTracks.find(t => t.id === id)).filter(Boolean);
    }
    return allTracks; // tab view — always starts from full library
  })();

  // Breadcrumb parts for the context header (label + optional clickable parent).
  const headerParts = (() => {
    if (view.kind === "smart") return [{ text: view.smartId === "recent" ? "Recently Played" : "Played This Session" }];
    if (view.kind === "folder") { const cr = crates.find(c => c.id === view.folderId); return [{ text: cr?.name || "Folder" }]; }
    if (view.tab === "all") return [{ text: "All Tracks" }];
    const tabLabel = PERSISTENT_TABS.find(t => t.id === view.tab)?.label || view.tab;
    const parts = [{ text: tabLabel, onClick: view.drill ? clearDrill : null }];
    if (view.drill) parts.push({ text: view.drill });
    return parts;
  })();

  const tabTracks = baseTracks; // keep name stable for existing search/filter code below

  // Search parser: BPM (int or range), Camelot key (8A/12B), energy label, else text.
  const parsed = (() => {
    const f = { text: [], bpm: null, bpmRange: null, key: null, energy: null };
    for (const tok of search.trim().split(/\s+/).filter(Boolean)) {
      const mR = tok.match(/^(\d{2,3})-(\d{2,3})$/);
      if (mR) { f.bpmRange = [parseInt(mR[1]), parseInt(mR[2])]; continue; }
      if (/^\d{2,3}$/.test(tok)) { f.bpm = parseInt(tok); continue; }
      if (/^([1-9]|1[0-2])[ab]$/i.test(tok)) { f.key = tok.toUpperCase(); continue; }
      if (/^(low|mid|high|peak|ambient|warm|hard|build)$/i.test(tok)) { f.energy = tok.toLowerCase(); continue; }
      f.text.push(tok.toLowerCase());
    }
    return f;
  })();

  const filteredUniverse = (() => {
    let t = tabTracks;
    if (parsed.text.length) {
      const q = parsed.text.join(" ");
      t = t.filter(x => ((x.title||"")+" "+(x.artist||"")+" "+(x.label||"")+" "+(x.album||"")+" "+(x.genre||"")).toLowerCase().includes(q));
    }
    if (parsed.bpm != null) t = t.filter(x => x.bpm && Math.abs(x.bpm - parsed.bpm) <= 2);
    if (parsed.bpmRange) t = t.filter(x => x.bpm && x.bpm >= parsed.bpmRange[0] && x.bpm <= parsed.bpmRange[1]);
    if (parsed.key) t = t.filter(x => x.key && x.key.toUpperCase() === parsed.key);
    if (parsed.energy) t = t.filter(x => (x.energyLabel||"").toLowerCase().includes(parsed.energy));
    if (matchDeckA && playingTrack?.bpm) {
      t = t.filter(x => x.bpm && Math.abs(x.bpm - playingTrack.bpm) <= 4);
      if (playingTrack.key && CAMELOT[playingTrack.key]) {
        t = t.filter(x => !x.key || !CAMELOT[x.key] || camelotScore(CAMELOT[playingTrack.key], CAMELOT[x.key]) >= 3);
      }
    }
    return t;
  })();

  // Decide: show group list or track list?
  // Group list renders when viewing a dimension tab (artists/labels/genres/energy) without a drill.
  // Drilled-in or "All Tracks"/smart/folder views show the track list directly.
  const isDimensionTab = view.kind === "tab" && view.tab !== "all";
  const showGroups = isDimensionTab && view.drill == null;
  const groups = showGroups
    ? (() => {
        const m = new Map();
        for (const t of filteredUniverse) {
          const k = groupFieldFor(t, view.tab);
          if (!m.has(k)) m.set(k, []);
          m.get(k).push(t);
        }
        return [...m.entries()]
          .map(([name, items]) => ({ name, items }))
          .sort((a, b) => b.items.length - a.items.length);
      })()
    : [];
  const tracks = showGroups
    ? []
    : (isDimensionTab && view.drill != null
        ? filteredUniverse.filter(t => groupFieldFor(t, view.tab) === view.drill)
        : filteredUniverse);

  const queueTracks = queueIds.map(id => allTracks.find(t => t.id === id)).filter(Boolean);

  const sendChat = () => { if (!chatInput.trim()) return; onSendChat(chatInput); setChatInput(""); };

  const removeSearchToken = re => setSearch(s => s.replace(re, "").replace(/\s+/g," ").trim());

  // Active-highlighting for sidebar items. Smart items match view.smartId; folder items
  // match view.folderId; nothing in the sidebar highlights while a tab view is active.
  const sidebarActive = (kind, id) => view.kind === kind && (view.smartId === id || view.folderId === id);
  const FolderItem = ({ kind, id, label, count, onClick }) => {
    const isActive = sidebarActive(kind, id);
    return (
      <div onClick={onClick} style={{
        padding: "6px 10px 6px 9px", cursor: "pointer",
        display: "flex", justifyContent: "space-between", alignItems: "center",
        borderLeft: `3px solid ${isActive ? G : "transparent"}`,
        background: isActive ? `${G}0e` : "transparent",
        color: isActive ? TEXT : SUBTLE, fontSize: 12,
      }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        <span style={{ fontSize: 10, color: MUTED, fontFamily: "'DM Mono',monospace", marginLeft: 6 }}>{count}</span>
      </div>
    );
  };

  const FilterPill = ({ children, onRemove }) => (
    <span style={{
      padding: "3px 4px 3px 9px", background: `${G}15`, border: `1px solid ${G}44`, color: G,
      borderRadius: 12, fontSize: 10, fontFamily: "'DM Mono',monospace",
      display: "inline-flex", alignItems: "center", gap: 2,
    }}>
      <span>{children}</span>
      <span onClick={onRemove} style={{ cursor: "pointer", opacity: 0.7, padding: "0 4px" }}>×</span>
    </span>
  );

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); if (!isDraggingOver) setIsDraggingOver(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setIsDraggingOver(false); }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDraggingOver(false);
        // items API gives directory traversal via webkitGetAsEntry
        if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
          handleDroppedItems([...e.dataTransfer.items]);
        } else {
          // Fallback: only flat files (no folders)
          const files = [...e.dataTransfer.files];
          if (files.length > 0) handleImportFiles(files);
        }
      }}
      style={{ display: "flex", height: "100%", background: BG, fontFamily: "'DM Sans',sans-serif", color: TEXT, position: "relative", overflow: "hidden", outline: isDraggingOver ? `2px dashed ${G}` : "2px dashed transparent", outlineOffset: -2, transition: "outline-color .15s" }}>

      {/* ── LEFT RAIL ── */}
      <div style={{ width: 180, flexShrink: 0, borderRight: `1px solid ${BORDER}`, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "14px 10px 6px", fontSize: 9, letterSpacing: 2, color: MUTED, fontFamily: "'DM Mono',monospace" }}>SMART</div>
        <FolderItem kind="smart" id="recent"  label="Recently Played"     count={playedIds.size} onClick={() => selectSmart("recent")} />
        <FolderItem kind="smart" id="session" label="Played This Session" count={playedIds.size} onClick={() => selectSmart("session")} />
        <div style={{ padding: "14px 10px 6px", fontSize: 9, letterSpacing: 2, color: MUTED, fontFamily: "'DM Mono',monospace" }}>FOLDERS</div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {crates.length === 0
            ? <div style={{ padding: "8px 12px", color: MUTED, fontSize: 11, fontStyle: "italic" }}>No folders yet</div>
            : crates.map(c => <FolderItem key={c.id} kind="folder" id={c.id} label={c.name} count={c.trackIds?.length || 0} onClick={() => selectFolder(c.id)} />)}
        </div>
        <div style={{ padding: 10, borderTop: `1px solid ${BORDER}`, display: "flex", flexDirection: "column", gap: 6 }}>
          <button onClick={handleAddMusic} style={{
            width: "100%", height: 28, background: `${G}14`, border: `1px solid ${G}44`,
            color: G, fontSize: 9, letterSpacing: 2, fontFamily: "'DM Mono',monospace",
            borderRadius: 4, cursor: "pointer", fontWeight: 600,
          }}>+ ADD MUSIC</button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="audio/*,.mp3,.wav,.flac,.aac,.ogg,.m4a"
            style={{ display: "none" }}
            onChange={(e) => {
              const files = [...e.target.files];
              e.target.value = "";
              if (files.length > 0) handleImportFiles(files);
            }}
          />
          <button style={{
            width: "100%", height: 28, background: "transparent", border: `1px dashed ${BORDER}`,
            color: SUBTLE, fontSize: 9, letterSpacing: 2, fontFamily: "'DM Mono',monospace",
            borderRadius: 4, cursor: "pointer",
          }}>+ NEW FOLDER</button>
        </div>
      </div>

      {/* ── CENTER ── */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>

        {/* Persistent tab strip — slices the library by dimension. Always visible. */}
        <div style={{ display: "flex", padding: "0 8px", gap: 0, borderBottom: `1px solid ${BORDER}`, alignItems: "stretch", background: BG, height: 38 }}>
          {PERSISTENT_TABS.map(tab => {
            const active = view.kind === "tab" && view.tab === tab.id;
            return (
              <div key={tab.id} onClick={() => selectTab(tab.id)}
                onMouseEnter={e => { if (!active) e.currentTarget.style.color = TEXT; }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.color = MUTED; }}
                style={{
                  padding: "0 14px", cursor: "pointer",
                  display: "flex", alignItems: "center",
                  color: active ? TEXT : MUTED,
                  borderBottom: active ? `2px solid ${G}` : "2px solid transparent",
                  marginBottom: -1,
                  fontSize: 11, fontFamily: "'DM Mono',monospace", letterSpacing: 1.5,
                  fontWeight: active ? 700 : 500,
                  textTransform: "uppercase",
                  transition: "color 0.12s",
                }}>
                {tab.label}
              </div>
            );
          })}
        </div>

        {/* Context header — breadcrumb path + count. */}
        <div style={{ padding: "10px 14px 0", display: "flex", alignItems: "baseline", gap: 8 }}>
          {headerParts.map((p, i) => {
            const isLast = i === headerParts.length - 1;
            return (
              <span key={i} style={{ display: "inline-flex", alignItems: "baseline", gap: 8 }}>
                {i > 0 && <span style={{ color: MUTED, fontSize: 13 }}>/</span>}
                <span onClick={p.onClick || undefined} style={{
                  fontSize: 15,
                  color: isLast ? TEXT : SUBTLE,
                  fontWeight: isLast ? 600 : 500,
                  cursor: p.onClick ? "pointer" : "default",
                  textDecoration: p.onClick ? "none" : "none",
                }}>{p.text}</span>
              </span>
            );
          })}
          <span style={{ fontSize: 11, color: MUTED, fontFamily: "'DM Mono',monospace" }}>
            · {showGroups ? `${groups.length} group${groups.length === 1 ? "" : "s"}` : `${tracks.length} track${tracks.length === 1 ? "" : "s"}`}
          </span>
        </div>

        {/* Search */}
        <div style={{ padding: "12px 14px 8px", background: BG2, borderBottom: `1px solid ${BORDER}` }}>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search tracks, artists, labels…  or  '124 8a high'"
            style={{
              width: "100%", padding: "9px 12px", background: BG, border: `1px solid ${BORDER}`,
              color: TEXT, fontFamily: "'DM Sans',sans-serif", fontSize: 12, borderRadius: 6, outline: "none",
              boxShadow: "inset 0 1px 0 rgba(0,0,0,0.4)",
            }} />
          <div style={{ marginTop: 8, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", minHeight: 22 }}>
            {parsed.bpm != null && <FilterPill onRemove={() => removeSearchToken(/\b\d{2,3}\b/)}>BPM ±2 of {parsed.bpm}</FilterPill>}
            {parsed.bpmRange && <FilterPill onRemove={() => removeSearchToken(/\b\d{2,3}-\d{2,3}\b/)}>BPM {parsed.bpmRange.join("–")}</FilterPill>}
            {parsed.key && <FilterPill onRemove={() => removeSearchToken(/\b([1-9]|1[0-2])[ab]\b/i)}>Key {parsed.key}</FilterPill>}
            {parsed.energy && <FilterPill onRemove={() => removeSearchToken(/\b(low|mid|high|peak|ambient|warm|hard|build)\b/i)}>Energy: {parsed.energy}</FilterPill>}
            <button onClick={() => setShowSuggestions(v => !v)} disabled={!suggestionSource}
              title={suggestionSource ? `Suggestions for Deck ${suggestionSourceDeck}` : "Load a track to see suggestions."}
              style={{
                marginLeft: "auto",
                padding: "4px 10px", height: 22,
                background: showSuggestions ? `${G}22` : "transparent",
                border: `1px solid ${showSuggestions ? G : BORDER}`,
                color: showSuggestions ? G : (suggestionSource ? SUBTLE : MUTED),
                borderRadius: 4, cursor: suggestionSource ? "pointer" : "not-allowed",
                fontFamily: "'DM Mono',monospace", fontSize: 10, letterSpacing: 1, outline: "none",
                display: "flex", alignItems: "center", gap: 5,
              }}>
              <span style={{ fontSize: 12 }}>✦</span> SUGGESTIONS
            </button>
          </div>
        </div>

        {/* Track list or group list depending on view */}
        <div style={{ flex: 1, overflowY: "auto", padding: "4px 6px" }}>
          {!showGroups && allTracks.length === 0 && (
            <div
              onClick={handleAddMusic}
              style={{
                margin: 24, padding: "60px 40px", textAlign: "center",
                border: `2px dashed ${G}33`, borderRadius: 12, cursor: "pointer",
                display: "flex", flexDirection: "column", alignItems: "center", gap: 10,
                transition: "all .2s",
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = `${G}66`; e.currentTarget.style.background = `${G}06`; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = `${G}33`; e.currentTarget.style.background = "transparent"; }}
            >
              <div style={{ fontSize: 32, opacity: 0.35 }}>🎵</div>
              <div style={{ fontSize: 14, fontFamily: "'DM Mono',monospace", color: G, letterSpacing: 1.5, fontWeight: 600 }}>ADD YOUR MUSIC</div>
              <div style={{ fontSize: 11, fontFamily: "'DM Sans',sans-serif", color: SUBTLE, lineHeight: 1.6, fontWeight: 300 }}>
                Drop tracks here or click to add
              </div>
              <div style={{ fontSize: 10, fontFamily: "'DM Sans',sans-serif", color: MUTED, lineHeight: 1.6, fontWeight: 300, marginTop: -4 }}>
                Drag a folder for bulk import
              </div>
              <div style={{ fontSize: 9, fontFamily: "'DM Mono',monospace", color: MUTED, letterSpacing: 1, marginTop: 4 }}>
                MP3 · WAV · FLAC · AAC · OGG · M4A
              </div>
            </div>
          )}
          {showGroups && (
            <>
              {groups.length === 0 && (
                <div style={{ padding: 48, textAlign: "center", color: MUTED, fontSize: 12 }}>
                  No {view.tab} match these filters.
                </div>
              )}
              {groups.map(g => (
                <div key={g.name} onClick={() => drillInto(g.name)}
                  onMouseEnter={e => e.currentTarget.style.background = BG2}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "12px 16px", cursor: "pointer",
                    borderRadius: 4, marginBottom: 2,
                    borderLeft: `3px solid transparent`,
                  }}>
                  <span style={{ fontSize: 14, color: TEXT, fontWeight: 500, letterSpacing: 0.2 }}>{g.name}</span>
                  <span style={{ display: "flex", gap: 12, alignItems: "center" }}>
                    <span style={{ fontSize: 10, color: MUTED, fontFamily: "'DM Mono',monospace" }}>
                      {g.items.length} track{g.items.length === 1 ? "" : "s"}
                    </span>
                    <span style={{ color: MUTED, fontSize: 16, lineHeight: 1 }}>›</span>
                  </span>
                </div>
              ))}
            </>
          )}
          {!showGroups && tracks.length === 0 && (
            <div style={{ padding: 48, textAlign: "center", color: MUTED, fontSize: 12 }}>
              {allTracks.length === 0 ? "Your library is empty. Drop some tracks in." : "No tracks match these filters."}
            </div>
          )}
          {tracks.map(t => {
            const played = playedIds.has(t.id);
            const artwork = lib.artworkCache?.[t.id] || t.artwork;
            const onDeckA = t.id === deckATrackId;
            const onDeckB = t.id === deckBTrackId;
            const deckClr = onDeckA ? DECK_A_CLR : onDeckB ? DECK_B_CLR : null;
            const baseBg = deckClr ? `${deckClr}12` : "transparent";
            return (
              <div key={t.id} onClick={() => { console.log('[ROW-CLICK]',{id:t.id,title:t.title,artist:t.artist}); onLoad(t, "A"); }}
                onMouseEnter={e => e.currentTarget.style.background = deckClr ? `${deckClr}22` : BG2}
                onMouseLeave={e => e.currentTarget.style.background = baseBg}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "6px 10px 6px 7px", cursor: "pointer", opacity: played && !deckClr ? 0.55 : 1,
                  borderRadius: 4, marginBottom: 1,
                  background: baseBg,
                  borderLeft: `3px solid ${deckClr || "transparent"}`,
                }}>
                {/* Deck badge (replaces analysis dot when loaded on a deck), else analysis dot. */}
                {deckClr ? (
                  <div title={`Loaded on Deck ${onDeckA ? "A" : "B"}`} style={{
                    width: 18, height: 18, borderRadius: 3, flexShrink: 0,
                    background: deckClr, color: "#0a0a10",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 10, fontFamily: "'DM Mono',monospace", fontWeight: 700,
                    boxShadow: `0 0 8px ${deckClr}88`,
                  }}>{onDeckA ? "A" : "B"}</div>
                ) : (
                  <div title={t.analyzed ? "Analyzed" : "Metadata only"} style={{
                    width: 6, height: 6, borderRadius: 3, flexShrink: 0,
                    background: t.analyzed ? G : MUTED,
                    boxShadow: t.analyzed ? `0 0 6px ${G}55` : "none",
                    opacity: t.analyzed ? 1 : 0.55,
                    marginLeft: 6, marginRight: 6,
                  }} />
                )}
                <div style={{
                  width: 32, height: 32, background: BG3, borderRadius: 3, flexShrink: 0,
                  backgroundImage: artwork ? `url(${artwork})` : undefined,
                  backgroundSize: "cover", backgroundPosition: "center",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  {!artwork && <span style={{ fontSize: 11, color: MUTED }}>♪</span>}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: TEXT, display: "flex", alignItems: "center", gap: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {played && <span style={{ color: G, fontSize: 10 }}>✓</span>}
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{t.title || "(untitled)"}</span>
                  </div>
                  <div style={{ fontSize: 11, color: SUBTLE, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.artist || ""}</div>
                </div>
                <div style={{ width: 52, textAlign: "right", fontFamily: "'DM Mono',monospace", fontSize: 11, color: t.bpm ? G : MUTED }}>
                  {t.bpm ? t.bpm.toFixed(1) : "—"}
                </div>
                <div style={{ width: 38, display: "flex", justifyContent: "center" }}>
                  {t.key && <span style={{ fontSize: 9, padding: "2px 5px", background: `${G}15`, border: `1px solid ${G}33`, color: G, borderRadius: 3, fontFamily: "'DM Mono',monospace", letterSpacing: 0.5 }}>{t.key}</span>}
                </div>
                <div style={{ width: 50 }}>
                  {t.energy != null && (
                    <div style={{ height: 4, background: BG3, borderRadius: 2, overflow: "hidden" }}>
                      <div style={{ width: `${Math.min(100, t.energy)}%`, height: "100%", background: G }} />
                    </div>
                  )}
                </div>
                <div style={{ width: 42, textAlign: "right", fontFamily: "'DM Mono',monospace", fontSize: 10, color: MUTED }}>
                  {fmtDur(t.duration)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── RIGHT RAIL ── split ratio persisted via queueFraction (default 0.4) ── */}
      <div style={{ width: 280, flexShrink: 0, borderLeft: `1px solid ${BORDER}`, display: "flex", flexDirection: "column" }}>

        {/* QUEUE (top) */}
        <div style={{ flex: `${queueFraction} 1 0`, minHeight: 80, display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "10px 14px", fontSize: 10, letterSpacing: 2, fontFamily: "'DM Mono',monospace", color: G, borderBottom: `1px solid ${BORDER}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>QUEUE</span>
            <span style={{ color: MUTED, fontSize: 9 }}>{queueTracks.length} up next</span>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 6 }}>
            {queueTracks.length === 0
              ? <div style={{ padding: 28, textAlign: "center", color: MUTED, fontSize: 11, lineHeight: 1.5 }}>Drag tracks from library<br/>to queue them up</div>
              : queueTracks.slice(0, 8).map(t => (
                  <div key={t.id} onClick={() => onLoad(t, "B")}
                    onMouseEnter={e => e.currentTarget.style.background = BG2}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", cursor: "pointer", borderRadius: 3 }}>
                    <div style={{ width: 26, height: 26, background: BG3, borderRadius: 2, flexShrink: 0,
                      backgroundImage: (lib.artworkCache?.[t.id] || t.artwork) ? `url(${lib.artworkCache?.[t.id] || t.artwork})` : undefined,
                      backgroundSize: "cover", backgroundPosition: "center",
                      display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: MUTED,
                    }}>{!(lib.artworkCache?.[t.id] || t.artwork) && "♪"}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, color: TEXT, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</div>
                      <div style={{ fontSize: 10, color: SUBTLE, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.artist}</div>
                    </div>
                    <div style={{ fontSize: 10, color: G, fontFamily: "'DM Mono',monospace" }}>{t.bpm?.toFixed(0) || "—"}</div>
                  </div>
                ))}
          </div>
        </div>

        {/* Drag handle — resize queue/chat split. Persists on mouseup. */}
        <div onMouseDown={startSplitDrag}
          style={{
            height: 6, cursor: "ns-resize", flexShrink: 0,
            background: BORDER, position: "relative",
            transition: "background 0.1s",
          }}
          onMouseEnter={e => e.currentTarget.style.background = `${G}44`}
          onMouseLeave={e => e.currentTarget.style.background = BORDER}>
          <div style={{ position: "absolute", top: 2, left: "50%", transform: "translateX(-50%)", width: 24, height: 2, background: MUTED, borderRadius: 1 }} />
        </div>

        {/* CHAT (bottom) */}
        <div style={{ flex: `${1 - queueFraction} 1 0`, minHeight: 120, display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "10px 14px", fontSize: 10, letterSpacing: 2, fontFamily: "'DM Mono',monospace", color: G, borderBottom: `1px solid ${BORDER}`, display: "flex", alignItems: "center", gap: 8 }}>
            <span>CHAT</span>
            <div style={{ width: 6, height: 6, borderRadius: 3, background: "#22c55e", boxShadow: "0 0 6px #22c55e88" }} />
            <span style={{ color: MUTED, fontSize: 9, fontFamily: "'DM Sans',sans-serif", letterSpacing: 0, textTransform: "none" }}>partner online</span>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "8px 12px" }}>
            {(!chat || chat.length === 0)
              ? <div style={{ color: MUTED, fontSize: 11, fontStyle: "italic", textAlign: "center", padding: 16 }}>No messages yet.</div>
              : chat.map((m, i) => (
                  <div key={i} style={{ fontSize: 11, marginBottom: 4, lineHeight: 1.4 }}>
                    {m.type === "system"
                      ? <span style={{ color: MUTED, fontStyle: "italic" }}>— {m.msg} —</span>
                      : <>
                          <span style={{ color: m.self || m.from === me ? G : PARTNER, fontWeight: 600 }}>{m.from}: </span>
                          <span style={{ color: TEXT }}>{m.msg}</span>
                        </>}
                  </div>
                ))}
            <div ref={chatEndRef} />
          </div>
          <div style={{ padding: 8, display: "flex", gap: 6, borderTop: `1px solid ${BORDER}` }}>
            <input value={chatInput} onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && sendChat()} placeholder="Message…"
              style={{
                flex: 1, height: 28, padding: "0 10px", background: BG2, border: `1px solid ${BORDER}`,
                color: TEXT, fontFamily: "'DM Sans',sans-serif", fontSize: 11, borderRadius: 4, outline: "none",
              }} />
            <button onClick={sendChat} style={{
              height: 28, width: 32, background: `${G}18`, border: `1px solid ${G}33`, color: G,
              borderRadius: 4, cursor: "pointer", fontFamily: "'DM Mono',monospace", fontSize: 13, outline: "none",
            }}>→</button>
          </div>
        </div>

      </div>

      {/* ── SUGGESTIONS PANEL — slides in from the right over the queue/chat column ── */}
      <div onClick={() => setShowSuggestions(false)}
        style={{
          position: "absolute", inset: 0,
          background: "rgba(0,0,0,0.5)",
          opacity: showSuggestions ? 1 : 0,
          pointerEvents: showSuggestions ? "auto" : "none",
          transition: "opacity 0.18s",
          zIndex: 9,
        }} />
      <div style={{
        position: "absolute", top: 0, right: 0, width: 320, height: "100%",
        background: BG2, borderLeft: `1px solid ${BORDER}`,
        transform: showSuggestions ? "translateX(0)" : "translateX(100%)",
        transition: "transform 0.22s ease-out",
        zIndex: 10,
        display: "flex", flexDirection: "column",
        boxShadow: showSuggestions ? "-10px 0 28px rgba(0,0,0,0.5)" : "none",
      }}>
        <div style={{ padding: "14px 16px", borderBottom: `1px solid ${BORDER}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 9, letterSpacing: 2, color: MUTED, fontFamily: "'DM Mono',monospace", marginBottom: 2 }}>SUGGESTIONS FOR</div>
            <div style={{ fontSize: 14, color: TEXT, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{
                width: 18, height: 18, borderRadius: 3,
                background: suggestionSourceDeck === "A" ? DECK_A_CLR : DECK_B_CLR,
                color: "#0a0a10", display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 10, fontFamily: "'DM Mono',monospace", fontWeight: 700,
              }}>{suggestionSourceDeck || "—"}</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {suggestionSource?.title || "—"}
              </span>
            </div>
          </div>
          <button onClick={() => setShowSuggestions(false)} aria-label="Close"
            style={{ width: 24, height: 24, background: "transparent", border: "none", color: SUBTLE, cursor: "pointer", fontSize: 18, outline: "none" }}>×</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 6 }}>
          {suggestions.length === 0 && (
            <div style={{ padding: 32, textAlign: "center", color: MUTED, fontSize: 11, lineHeight: 1.5 }}>
              No compatible tracks in the library yet.
            </div>
          )}
          {suggestions.map(t => {
            const targetDeck = deckATrackId && !deckBTrackId ? "B" : (!deckATrackId && deckBTrackId ? "A" : "A");
            const artwork = lib.artworkCache?.[t.id] || t.artwork;
            return (
              <div key={t.id} onClick={() => { onLoad(t, targetDeck); setShowSuggestions(false); }}
                onMouseEnter={e => e.currentTarget.style.background = BG3}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "8px 10px",
                  cursor: "pointer", borderRadius: 4, marginBottom: 2,
                }}>
                <div style={{
                  width: 36, height: 36, background: BG3, borderRadius: 3, flexShrink: 0,
                  backgroundImage: artwork ? `url(${artwork})` : undefined,
                  backgroundSize: "cover", backgroundPosition: "center",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>{!artwork && <span style={{ fontSize: 11, color: MUTED }}>♪</span>}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: TEXT, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>{t.title}</div>
                  <div style={{ fontSize: 10, color: SUBTLE, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.artist}</div>
                  {t.reasons && t.reasons.length > 0 && (
                    <div style={{ marginTop: 3, display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {t.reasons.map(r => (
                        <span key={r} style={{
                          fontSize: 8, padding: "1px 5px", background: "#22c55e14",
                          border: "1px solid #22c55e33", color: "#22c55e",
                          borderRadius: 3, fontFamily: "'DM Mono',monospace", letterSpacing: 0.3,
                        }}>{r}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 10, color: G, fontFamily: "'DM Mono',monospace", textAlign: "right" }}>
                  {t.bpm ? t.bpm.toFixed(1) : "—"}
                  {t.key && <div style={{ fontSize: 9, color: SUBTLE, marginTop: 2 }}>{t.key}</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── IMPORT PREVIEW MODAL ── shown only when duplicates are detected ── */}
      {importPreview && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setImportPreview(null); }}
          style={{
            position: "fixed", inset: 0, background: "rgba(4,3,12,0.78)",
            display: "flex", alignItems: "center", justifyContent: "center",
            zIndex: 9999, backdropFilter: "blur(6px)",
            fontFamily: "'DM Sans',sans-serif",
          }}
        >
          <div style={{
            width: 460, maxWidth: "92%", background: "#0E0C1A",
            border: `1px solid ${G}22`, borderRadius: 16, padding: 32,
            display: "flex", flexDirection: "column", gap: 14,
            boxShadow: `0 40px 80px rgba(0,0,0,.7), 0 0 0 1px #1C1830`,
          }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontFamily: "'Cormorant Garamond',serif", fontWeight: 700, fontSize: 22, letterSpacing: -0.3, color: TEXT }}>
                Found {importPreview.items.length} {importPreview.items.length === 1 ? "track" : "tracks"}
              </div>
              <div style={{ fontSize: 9, fontFamily: "'DM Mono',monospace", color: `${G}55`, letterSpacing: 3, marginTop: 6 }}>READY TO IMPORT</div>
            </div>

            <div style={{ fontSize: 12, fontFamily: "'DM Sans',sans-serif", color: SUBTLE, lineHeight: 1.6, fontWeight: 300, textAlign: "center" }}>
              {importPreview.dupeCount} {importPreview.dupeCount === 1 ? "is" : "are"} already in your library.
              <br />What would you like to do?
            </div>

            {importPreview.dupeCount > 0 && importPreview.dupeCount <= 5 && (
              <div style={{
                background: "#080710", border: `1px solid ${G}14`, borderRadius: 8,
                padding: "10px 14px", display: "flex", flexDirection: "column", gap: 4,
              }}>
                <div style={{ fontSize: 8, fontFamily: "'DM Mono',monospace", color: `${G}55`, letterSpacing: 2 }}>DUPLICATES</div>
                {importPreview.items.filter(i => i.isDupe).map((item, i) => (
                  <div key={i} style={{ fontSize: 11, color: TEXT, fontFamily: "'DM Sans',sans-serif", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {item.artist} — {item.title}
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
              <button
                onClick={async () => {
                  const items = importPreview.items;
                  setImportPreview(null);
                  await lib.commitImport(items, "skipDupes");
                }}
                style={{
                  background: G, border: "none", color: "#080710",
                  fontFamily: "'DM Mono',monospace", fontWeight: 500, fontSize: 11, letterSpacing: 2,
                  padding: "13px 16px", borderRadius: 10, cursor: "pointer",
                  boxShadow: `0 0 24px ${G}28`, transition: "all .2s",
                }}
              >
                SKIP DUPLICATES (ADD {importPreview.newCount} NEW) →
              </button>
              <button
                onClick={async () => {
                  const items = importPreview.items;
                  setImportPreview(null);
                  await lib.commitImport(items, "importAll");
                }}
                style={{
                  background: "transparent", border: `1px solid ${G}33`, color: G,
                  fontFamily: "'DM Mono',monospace", fontWeight: 500, fontSize: 10, letterSpacing: 2,
                  padding: "10px 16px", borderRadius: 8, cursor: "pointer", transition: "all .2s",
                }}
              >
                IMPORT ALL (INCLUDING DUPLICATES)
              </button>
              <button
                onClick={() => setImportPreview(null)}
                style={{
                  background: "transparent", border: "none", color: MUTED,
                  fontFamily: "'DM Mono',monospace", fontWeight: 500, fontSize: 9, letterSpacing: 2,
                  padding: "6px", borderRadius: 6, cursor: "pointer",
                }}
              >
                CANCEL
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

function LibraryPanel({lib, onLoad, playingTrack, previewTrackId, onPreview, onDelete, chat, onSendChat, me}){
  const [filter,setFilter]=useState("");
  const [sortBy,setSortBy]=useState("addedAt");
  const [sortDir,setSortDir]=useState(-1);
  const [view,setView]=useState("tracks"); // "tracks"|"artists"|"labels"|"energy"|"queue"
  const [drillValue,setDrillValue]=useState(null); // e.g. selected artist/label/energy
  const [activeCrateId,setActiveCrateId]=useState(null);
  const [cratesExpanded,setCratesExpanded]=useState(true);
  const [showNewCrateInput,setShowNewCrateInput]=useState(false);
  const [newCrateName,setNewCrateName]=useState("");
  const [chatInput,setChatInput]=useState("");
  const [energyFilter,setEnergyFilter]=useState(null);
  const [bpmRange,setBpmRange]=useState([60,200]);
  const [keyFilter,setKeyFilter]=useState(null);
  const [showFilters,setShowFilters]=useState(false);
  const [showImportModal,setShowImportModal]=useState(false);
  const [importTab,setImportTab]=useState("local"); // "local"|"itunes"|"rekordbox"
  const [dragOverCrate,setDragOverCrate]=useState(null);
  const chatEndRef=useRef(null);
  const fileRef=useRef(null);
  const newCrateRef=useRef(null);
  const itunesRef=useRef(null);
  const rekordboxRef=useRef(null);
  const G="#C8A96E";

  useEffect(()=>chatEndRef.current?.scrollIntoView({behavior:"smooth"}),[chat]);
  useEffect(()=>{if(showNewCrateInput)newCrateRef.current?.focus();},[showNewCrateInput]);
  const sendChat=()=>{if(!chatInput.trim())return;onSendChat(chatInput);setChatInput("");};

  const allTracks=lib.library||[];
  const queuedTracks=(lib.queue||[]).map(id=>allTracks.find(t=>t.id===id)).filter(Boolean);
  const activeCrate=activeCrateId?(lib.crates||[]).find(c=>c.id===activeCrateId):null;
  const selfRecs=playingTrack&&allTracks.length>0?recommendTracks(playingTrack,allTracks):[];
  const recIds=new Set(selfRecs.map(r=>r.id));

  // Unique values for drill-down views
  const uniqueArtists=[...new Set(allTracks.map(t=>t.artist).filter(Boolean))].sort();
  const uniqueLabels=[...new Set(allTracks.map(t=>t.label).filter(Boolean))].sort();
  const ENERGY_ORDER=["Ambient","Warm-Up","Build","Peak Hour","Hard"];
  const uniqueEnergies=ENERGY_ORDER.filter(e=>allTracks.some(t=>t.energy?.label===e));

  // Base tracks by view/crate/drill
  let baseTracks;
  if(activeCrate) baseTracks=(activeCrate.trackIds||[]).map(id=>allTracks.find(t=>t.id===id)).filter(Boolean);
  else if(view==="queue") baseTracks=queuedTracks;
  else if(view==="artists"&&drillValue) baseTracks=allTracks.filter(t=>t.artist===drillValue);
  else if(view==="labels"&&drillValue) baseTracks=allTracks.filter(t=>t.label===drillValue);
  else if(view==="energy"&&drillValue) baseTracks=allTracks.filter(t=>t.energy?.label===drillValue);
  else baseTracks=allTracks;

  // Are we in a drill-down list view (no tracks, show values to pick from)?
  const isDrillList=(view==="artists"||view==="labels"||view==="energy")&&!drillValue&&!activeCrateId;

  const ENERGY_LABELS=["Ambient","Warm-Up","Build","Peak Hour","Hard"];
  const CAMELOT_KEYS=["1A","2A","3A","4A","5A","6A","7A","8A","9A","10A","11A","12A",
                       "1B","2B","3B","4B","5B","6B","7B","8B","9B","10B","11B","12B"];
  const hasActiveFilter=energyFilter!=null||keyFilter!=null||bpmRange[0]>60||bpmRange[1]<200;

  const filtered=baseTracks
    .filter(t=>{
      const q=filter.toLowerCase();
      if(q&&!t.title?.toLowerCase().includes(q)&&!t.artist?.toLowerCase().includes(q)&&
         !t.label?.toLowerCase().includes(q)&&!t.genre?.toLowerCase().includes(q))return false;
      if(energyFilter!=null&&t.energy?.label!==energyFilter)return false;
      if(t.bpm&&(t.bpm<bpmRange[0]||t.bpm>bpmRange[1]))return false;
      if(keyFilter&&CAMELOT[t.key]!==keyFilter)return false;
      return true;
    })
    .sort((a,b)=>{
      const key=sortBy;
      const va=key==="energyScore"?(a.energy?.score??-1):key==="key"?(CAMELOT[a.key]||a.key||""):(a[key]??0);
      const vb=key==="energyScore"?(b.energy?.score??-1):key==="key"?(CAMELOT[b.key]||b.key||""):(b[key]??0);
      return(typeof va==="string"?va.localeCompare(vb):(va-vb))*sortDir;
    });

  const colHdr=(label,key)=>(
    <div onClick={()=>{if(sortBy===key)setSortDir(d=>-d);else{setSortBy(key);setSortDir(1);}}}
      style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:sortBy===key?G:"#555562",cursor:"pointer",letterSpacing:.5,userSelect:"none",whiteSpace:"nowrap"}}>
      {label}{sortBy===key?(sortDir===1?" ↑":" ↓"):""}
    </div>
  );

  const createCrate=async()=>{
    if(!newCrateName.trim())return;
    const id=`crate_${Date.now()}`;
    await cmDbPut("crates",{id,name:newCrateName.trim(),trackIds:[],createdAt:Date.now()});
    setNewCrateName("");setShowNewCrateInput(false);
    lib.reload?.();
  };

  const removeFromPlaylist=useCallback(async(trackId)=>{
    if(!activeCrateId)return;
    const crate=(lib.crates||[]).find(c=>c.id===activeCrateId);
    if(!crate)return;
    const updated={...crate,trackIds:(crate.trackIds||[]).filter(id=>id!==trackId)};
    await cmDbPut("crates",updated);
    lib.reload?.();
  },[activeCrateId,lib]);

  const NAV=[
    ["tracks","All Tracks",null],
    ["artists","Artists",null],
    ["labels","Record Label",null],
    ["energy","Energy",null],
    ["queue","Session Queue",queuedTracks.length||null],
  ];

  const navItemStyle=(id,isQueue)=>({
    padding:"6px 12px",fontSize:11,fontFamily:"'DM Sans',sans-serif",
    color:!activeCrateId&&view===id?(isQueue?"#22c55e":G):"#888898",
    background:!activeCrateId&&view===id?(isQueue?"#22c55e10":`${G}10`):"transparent",
    cursor:"pointer",
    borderLeft:`2px solid ${!activeCrateId&&view===id?(isQueue?"#22c55e":G):"transparent"}`,
    transition:"all .1s",display:"flex",justifyContent:"space-between",alignItems:"center"
  });

  return(
    <div style={{display:"flex",height:"100%",overflow:"hidden"}}>

      {/* ── CHAT SIDEBAR ── */}
      <div style={{width:240,flexShrink:0,display:"flex",flexDirection:"column",borderRight:"1px solid #1e1e28",background:"#08080e"}}>
        <div style={{padding:"8px 10px 6px",borderBottom:"1px solid #1e1e28",flexShrink:0}}>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#888898",letterSpacing:2}}>CHAT</div>
        </div>
        <div style={{flex:1,overflowY:"auto",padding:"6px 8px",display:"flex",flexDirection:"column",gap:5}}>
          {chat.length===0
            ?<span style={{fontSize:9,fontFamily:"'DM Mono',monospace",color:"#333340",fontStyle:"italic",marginTop:8}}>No messages yet</span>
            :chat.map((m,i)=>(
              <div key={i} style={{fontSize:9,fontFamily:"'DM Mono',monospace"}}>
                {m.type==="system"
                  ?<span style={{color:"#555562",fontStyle:"italic",fontSize:8}}>— {m.msg} —</span>
                  :<>
                    <div style={{display:"flex",gap:4,alignItems:"baseline"}}>
                      <span style={{color:m.self||m.from===me?"#C8A96E":"#00BFA5",fontWeight:500,fontSize:9}}>{m.from}</span>
                      <span style={{color:"#555562",fontSize:7}}>{m.time}</span>
                    </div>
                    <div style={{color:"#c0c0cc",marginTop:1,wordBreak:"break-word",lineHeight:1.4,fontSize:9}}>{m.msg}</div>
                  </>
                }
              </div>
            ))
          }
          <div ref={chatEndRef}/>
        </div>
        <div style={{flexShrink:0,padding:"5px 6px",borderTop:"1px solid #1e1e28",display:"flex",gap:4}}>
          <input value={chatInput} onChange={e=>setChatInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendChat()} placeholder="Message..."
            style={{flex:1,background:"#0c0c14",border:"1px solid #252535",color:"#d8d8e2",borderRadius:5,padding:"4px 7px",fontSize:9,fontFamily:"'DM Mono',monospace",outline:"none",minWidth:0}}/>
          <button onClick={sendChat} style={{height:26,padding:"0 8px",background:`${G}18`,border:`1px solid ${G}33`,color:G,borderRadius:5,cursor:"pointer",fontFamily:"'DM Mono',monospace",fontSize:11,flexShrink:0}}>→</button>
        </div>
      </div>

      {/* ── LIBRARY NAV SIDEBAR ── */}
      <div style={{width:155,flexShrink:0,display:"flex",flexDirection:"column",borderRight:"1px solid #1e1e28",background:"#0a0a10"}}>
        <div style={{padding:"8px 10px 6px",borderBottom:"1px solid #1e1e28",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:11,color:"#d8d8e2",letterSpacing:1,fontWeight:600}}>Library</div>
          <div style={{display:"flex",alignItems:"center",gap:4}}>
          {/* Reconnect folder — restores file access + artwork after browser restart */}
          <button title="Reconnect music folder (restores artwork & playback after browser restart)" onClick={()=>lib.reconnectFromFolder?.()} style={{background:"none",border:"none",cursor:"pointer",padding:"2px 3px",borderRadius:4,display:"flex",alignItems:"center",opacity:0.7,transition:"opacity 0.2s"}} onMouseEnter={e=>e.currentTarget.style.opacity=1} onMouseLeave={e=>e.currentTarget.style.opacity=0.7}>
            <svg width="16" height="14" viewBox="0 0 16 14" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M1 3C1 2.44772 1.44772 2 2 2H6.5L7.5 3.5H14C14.5523 3.5 15 3.94772 15 4.5V11C15 11.5523 14.5523 12 14 12H2C1.44772 12 1 11.5523 1 11V3Z" stroke="#C8A96E" strokeWidth="1.5" strokeLinejoin="round" fill="none"/>
              <path d="M5.5 8L7.5 10L10.5 6.5" stroke="#C8A96E" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          {/* SCAN ARTWORK — re-reads ID3 APIC for tracks missing artwork */}
          <button title="Re-scan ID3 artwork for tracks missing cover art" disabled={lib.analyzing} onClick={()=>lib.scanArtwork?.()} style={{background:"transparent",border:"1px solid #C8A96E44",color:"#C8A96E",fontFamily:"'DM Mono',monospace",fontSize:8,letterSpacing:1,padding:"3px 6px",borderRadius:4,cursor:lib.analyzing?"default":"pointer",opacity:lib.analyzing?0.4:1,transition:"opacity 0.2s, border-color 0.2s"}} onMouseEnter={e=>{if(!lib.analyzing)e.currentTarget.style.borderColor="#C8A96E";}} onMouseLeave={e=>{e.currentTarget.style.borderColor="#C8A96E44";}}>SCAN ARTWORK</button>
          <button title={lib.analyzing?"Analyzing...":"Analyze library"} onClick={()=>lib.analyzeAll?.(lib.getFile)} style={{background:"none",border:"none",cursor:"pointer",padding:"2px 3px",borderRadius:4,opacity:lib.analyzing?0.5:1,transition:"opacity 0.2s",display:"flex",alignItems:"center"}}>
            <svg width="18" height="14" viewBox="0 0 18 14" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="0"  y="5"  width="2" height="4" rx="1" fill={lib.analyzing?"#C8A96E":"#888898"}/>
              <rect x="3"  y="2"  width="2" height="10" rx="1" fill={lib.analyzing?"#C8A96E":"#888898"}/>
              <rect x="6"  y="0"  width="2" height="14" rx="1" fill={lib.analyzing?"#C8A96E":"#aaa8b8"}/>
              <rect x="9"  y="3"  width="2" height="8"  rx="1" fill={lib.analyzing?"#C8A96E":"#888898"}/>
              <rect x="12" y="1"  width="2" height="12" rx="1" fill={lib.analyzing?"#C8A96E":"#aaa8b8"}/>
              <rect x="15" y="4"  width="2" height="6"  rx="1" fill={lib.analyzing?"#C8A96E":"#888898"}/>
            </svg>
          </button>
          </div>
        </div>
        <div style={{flex:1,overflowY:"auto",padding:"4px 0"}}>

          {/* Main nav items */}
          {NAV.map(([id,label,count])=>(
            <div key={id} onClick={()=>{setActiveCrateId(null);setView(id);setDrillValue(null);}} style={navItemStyle(id,id==="queue")}>
              <span>{label}</span>
              {count!=null&&(
                <span style={{fontSize:8,fontFamily:"'DM Mono',monospace",
                  color:!activeCrateId&&view===id&&id==="queue"?"#22c55e":"#555562",
                  background:!activeCrateId&&view===id&&id==="queue"?"#22c55e18":"transparent",
                  borderRadius:8,padding:"1px 6px",fontSize:9}}>{count}</span>
              )}
            </div>
          ))}

          {/* Divider + PLAYLISTS collapsible */}
          <div style={{height:1,background:"#1e1e28",margin:"6px 8px 2px"}}/>
          <div onClick={()=>setCratesExpanded(e=>!e)}
            style={{padding:"5px 12px 4px",display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}}>
            <span style={{fontSize:9,fontFamily:"'DM Mono',monospace",color:"#555562",letterSpacing:1}}>PLAYLISTS</span>
            <span style={{fontSize:9,fontFamily:"'DM Mono',monospace",color:"#555562"}}>{cratesExpanded?"▾":"▸"}</span>
          </div>

          {cratesExpanded&&(
            <div style={{maxHeight:200,overflowY:"auto"}}>
              {(lib.crates||[]).map(cr=>(
                <div key={cr.id}
                  onClick={()=>{setActiveCrateId(cr.id);setView("tracks");setDrillValue(null);}}
                  onContextMenu={e=>{e.preventDefault();if(window.confirm(`Delete playlist "${cr.name}"?`)){cmDbDelete("crates",cr.id).then(()=>lib.reload?.());}}}
                  onDragOver={e=>{e.preventDefault();setDragOverCrate(cr.id);}}
                  onDragLeave={()=>setDragOverCrate(null)}
                  onDrop={async e=>{
                    e.preventDefault();setDragOverCrate(null);
                    try{const d=JSON.parse(e.dataTransfer.getData("application/json"));
                      if(!d.trackId)return;
                      const updated={...cr,trackIds:[...new Set([...(cr.trackIds||[]),d.trackId])]};
                      await cmDbPut("crates",updated);lib.reload?.();
                    }catch{}
                  }}
                  style={{padding:"5px 12px 5px 20px",fontSize:10,fontFamily:"'DM Sans',sans-serif",
                    color:activeCrateId===cr.id?G:dragOverCrate===cr.id?"#d8d8e2":"#888898",
                    background:activeCrateId===cr.id?`${G}10`:dragOverCrate===cr.id?`${G}18`:"transparent",
                    cursor:"pointer",
                    borderLeft:`2px solid ${activeCrateId===cr.id?G:dragOverCrate===cr.id?G+"88":"transparent"}`,
                    transition:"all .1s",display:"flex",justifyContent:"space-between",alignItems:"center",
                    outline:dragOverCrate===cr.id?`1px dashed ${G}44`:"none"}}>
                  <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}>{cr.name}</span>
                  <span style={{fontSize:9,color:"#555562",fontFamily:"'DM Mono',monospace",flexShrink:0,marginLeft:4}}>{(cr.trackIds||[]).length}</span>
                </div>
              ))}
              {showNewCrateInput
                ?<div style={{padding:"4px 8px",display:"flex",gap:4}}>
                    <input ref={newCrateRef} value={newCrateName}
                      onChange={e=>setNewCrateName(e.target.value)}
                      onKeyDown={e=>{if(e.key==="Enter")createCrate();if(e.key==="Escape"){setShowNewCrateInput(false);setNewCrateName("");}}}
                      placeholder="Playlist name..."
                      style={{flex:1,background:"#0c0c14",border:`1px solid ${G}33`,color:"#d8d8e2",borderRadius:4,padding:"3px 6px",fontSize:9,fontFamily:"'DM Mono',monospace",outline:"none",minWidth:0}}/>
                    <button onClick={createCrate}
                      style={{padding:"2px 6px",background:`${G}18`,border:`1px solid ${G}44`,color:G,borderRadius:4,cursor:"pointer",fontSize:10,fontFamily:"'DM Mono',monospace"}}>✓</button>
                  </div>
                :<div onClick={()=>setShowNewCrateInput(true)}
                    style={{padding:"4px 20px",fontSize:9,fontFamily:"'DM Mono',monospace",color:"#555562",cursor:"pointer",letterSpacing:.5}}>
                    + New Playlist
                  </div>
              }
            </div>
          )}
        </div>

        {/* ADD TRACKS */}
        <div style={{flexShrink:0,padding:"6px 8px",borderTop:"1px solid #1e1e28",display:"flex",flexDirection:"column",gap:4}}>
          <button
            onClick={async () => {
              try {
                // Open a folder picker — user clicks their Music folder once
                const dirHandle = await window.showDirectoryPicker({ mode: "read" });
                // Save for auto-reconnect next session
                try {
                  const db = await new Promise((res, rej) => {
                    const r = indexedDB.open("mm_db", 1);
                    r.onupgradeneeded = e => e.target.result.createObjectStore("handles");
                    r.onsuccess = e => res(e.target.result);
                    r.onerror = e => rej(e);
                  });
                  const tx = db.transaction("handles", "readwrite");
                  tx.objectStore("handles").put(dirHandle, "folder");
                  try { localStorage.setItem("mm_folder", dirHandle.name); } catch (e) { console.warn('localStorage.setItem failed', 'mm_folder', e); }
                } catch {}
                // Recursively collect all audio files
                const files = [];
                async function collect(dh) {
                  for await (const [name, handle] of dh.entries()) {
                    if (handle.kind === "directory") {
                      await collect(handle);
                    } else if (handle.kind === "file" && name.match(/\.(mp3|wav|flac|aac|ogg|m4a)$/i)) {
                      const file = await handle.getFile();
                      files.push(file);
                    }
                  }
                }
                await collect(dirHandle);
                // Import all files into the library
                if (files.length > 0) {
                  lib.importFiles(files);
                }
              } catch (e) {
                if (e.name !== "AbortError") console.error(e);
              }
            }}
            style={{
              padding: "8px 16px",
              background: "#C8A96E",
              border: "none",
              color: "#07070f",
              fontFamily: "'DM Mono', monospace",
              fontWeight: 500,
              fontSize: 10,
              letterSpacing: 2,
              borderRadius: 7,
              cursor: "pointer",
              boxShadow: "0 0 20px #C8A96E28",
              transition: "all .2s",
              whiteSpace: "nowrap",
              width: "100%",
            }}
            onMouseEnter={e => e.currentTarget.style.transform = "translateY(-1px)"}
            onMouseLeave={e => e.currentTarget.style.transform = "none"}
          >
            ⊕ SELECT MUSIC FOLDER
          </button>
          <input ref={fileRef} type="file" accept="audio/*" multiple style={{display:"none"}} onChange={e=>{lib.importFiles(e.target.files);setShowImportModal(false);}}/>
          <input ref={itunesRef} type="file" accept=".xml" style={{display:"none"}} onChange={e=>{
            const f=e.target.files?.[0]; if(!f)return;
            const reader=new FileReader();
            reader.onload=async ev=>{
              try{
                const parser=new DOMParser();
                const xml=parser.parseFromString(ev.target.result,"text/xml");
                const dicts=xml.querySelectorAll("dict > dict > dict");
                const tracks=[];
                dicts.forEach(d=>{
                  const keys=[...d.querySelectorAll("key")];
                  const vals=[...d.children];
                  const get=k=>{const i=keys.findIndex(el=>el.textContent===k);return i>=0?vals[i*2+1]?.textContent:null;};
                  const loc=get("Location");if(!loc)return;
                  const id=`itunes_${Date.now()}_${Math.random().toString(36).slice(2,5)}`;
                  tracks.push({id,filename:loc.split("/").pop().replace(/\.[^.]+$/,""),title:get("Name")||"",artist:get("Artist")||"",album:get("Album")||"",genre:get("Genre")||"",label:"",bpm:get("BPM")?parseFloat(get("BPM")):null,key:get("Key Signature")||null,duration:get("Total Time")?parseInt(get("Total Time"))/1000:null,energy:null,analyzed:true,error:false,addedAt:Date.now(),artwork:null,itunesLoc:loc});
                });
                if(tracks.length){lib.setLibrary?.(prev=>[...prev,...tracks.filter(t=>!prev.find(p=>p.title===t.title&&p.artist===t.artist))]);alert(`Imported ${tracks.length} tracks from iTunes library. Note: to play them, load a track and re-select the file when prompted.`);}
              }catch{alert("Could not parse iTunes XML — please check the file.");}
            };
            reader.readAsText(f);
          }}/>
          <input ref={rekordboxRef} type="file" accept=".xml" style={{display:"none"}} onChange={e=>{
            const f=e.target.files?.[0]; if(!f)return;
            const reader=new FileReader();
            reader.onload=async ev=>{
              try{
                const parser=new DOMParser();
                const xml=parser.parseFromString(ev.target.result,"text/xml");
                const tels=xml.querySelectorAll("TRACK[Artist]");
                const tracks=[];
                tels.forEach(t=>{
                  const id=`rbx_${Date.now()}_${Math.random().toString(36).slice(2,5)}`;
                  tracks.push({id,filename:(t.getAttribute("Location")||"").split("/").pop().replace(/\.[^.]+$/,""),title:t.getAttribute("Name")||"",artist:t.getAttribute("Artist")||"",album:t.getAttribute("Album")||"",genre:t.getAttribute("Genre")||"",label:t.getAttribute("Label")||"",bpm:t.getAttribute("AverageBpm")?parseFloat(t.getAttribute("AverageBpm")):null,key:t.getAttribute("Tonality")||null,duration:t.getAttribute("TotalTime")?parseFloat(t.getAttribute("TotalTime")):null,energy:null,analyzed:true,error:false,addedAt:Date.now(),artwork:null});
                });
                if(tracks.length){lib.setLibrary?.(prev=>[...prev,...tracks.filter(t=>!prev.find(p=>p.title===t.title&&p.artist===t.artist))]);alert(`Imported ${tracks.length} tracks from Rekordbox. Note: to play them, re-select the files when prompted.`);}
              }catch{alert("Could not parse Rekordbox XML — please check the file.");}
            };
            reader.readAsText(f);
          }}/>
        </div>
      </div>

      {/* ── TRACK LIST + SUGGEST PANEL ── */}
      <div style={{flex:1,display:"flex",overflow:"hidden",minWidth:0}}>

      {/* Main track list column */}
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minWidth:0}}>

        {/* Header: breadcrumb + search + FILTER */}
        <div style={{padding:"6px 10px",borderBottom:"1px solid #181820",flexShrink:0}}>
          {/* Breadcrumb for drill views */}
          {drillValue&&(
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:5}}>
              <button onClick={()=>setDrillValue(null)} style={{fontSize:8,fontFamily:"'DM Mono',monospace",color:G,background:"transparent",border:`1px solid ${G}33`,borderRadius:4,padding:"2px 7px",cursor:"pointer",letterSpacing:.5}}>← {view==="artists"?"Artists":view==="labels"?"Labels":"Energy"}</button>
              <span style={{fontSize:9,fontFamily:"'DM Sans',sans-serif",color:"#d8d8e2",fontWeight:500}}>{drillValue}</span>
              <span style={{fontSize:8,fontFamily:"'DM Mono',monospace",color:"#555562"}}>({filtered.length})</span>
            </div>
          )}
          <div style={{display:"flex",gap:6,alignItems:"center"}}>
            <input value={filter} onChange={e=>setFilter(e.target.value)} placeholder={drillValue?`Search in ${drillValue}...`:"Search tracks..."}
              style={{flex:1,background:"#0c0c14",border:"1px solid #252535",color:"#d0d0e0",borderRadius:5,padding:"4px 9px",fontSize:9,fontFamily:"'DM Mono',monospace",outline:"none"}}/>
            <button onClick={()=>setShowFilters(f=>!f)}
              style={{padding:"3px 10px",fontSize:7,fontFamily:"'DM Mono',monospace",letterSpacing:1,
                background:hasActiveFilter||showFilters?`${G}22`:"transparent",
                color:hasActiveFilter||showFilters?G:"#888898",
                border:`1px solid ${hasActiveFilter||showFilters?G+"44":"#252535"}`,
                borderRadius:4,cursor:"pointer",outline:"none",whiteSpace:"nowrap",flexShrink:0}}>
              FILTER{hasActiveFilter?" ●":""}</button>
            {!isDrillList&&<span style={{fontSize:9,fontFamily:"'DM Mono',monospace",color:"#555562",flexShrink:0}}>{filtered.length}</span>}
            {lib.importing&&<div style={{width:8,height:8,border:`1.5px solid ${G}33`,borderTop:`1.5px solid ${G}`,borderRadius:"50%",animation:"spin 1s linear infinite",flexShrink:0}}/>}
          </div>

          {/* Filter panel */}
          {showFilters&&(
            <div style={{marginTop:8,padding:"10px 12px",background:"#0c0c14",borderRadius:6,border:"1px solid #252535",display:"flex",flexDirection:"column",gap:10}}>
              {/* Energy pills */}
              <div>
                <div style={{fontSize:7,fontFamily:"'DM Mono',monospace",color:"#555562",letterSpacing:1.5,marginBottom:5}}>ENERGY</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                  {ENERGY_LABELS.map(e=>(
                    <button key={e} onClick={()=>setEnergyFilter(ef=>ef===e?null:e)}
                      style={{padding:"3px 9px",fontSize:7,fontFamily:"'DM Mono',monospace",borderRadius:12,
                        background:energyFilter===e?ENERGY_COLOR[e]:`${ENERGY_COLOR[e]}22`,
                        color:energyFilter===e?"#000":ENERGY_COLOR[e],
                        border:`1px solid ${ENERGY_COLOR[e]}55`,cursor:"pointer",letterSpacing:.5,
                        fontWeight:energyFilter===e?700:400}}>{e}</button>
                  ))}
                </div>
              </div>
              {/* BPM range */}
              <div>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:7,fontFamily:"'DM Mono',monospace",color:"#555562",letterSpacing:1.5,marginBottom:4}}>
                  <span>BPM RANGE</span><span style={{color:G}}>{bpmRange[0]} – {bpmRange[1]}</span>
                </div>
                <input type="range" min={60} max={200} value={bpmRange[0]}
                  onChange={e=>{const v=Math.min(+e.target.value,bpmRange[1]-1);setBpmRange([v,bpmRange[1]]);}}
                  style={{width:"100%",accentColor:G,marginBottom:4}}/>
                <input type="range" min={60} max={200} value={bpmRange[1]}
                  onChange={e=>{const v=Math.max(+e.target.value,bpmRange[0]+1);setBpmRange([bpmRange[0],v]);}}
                  style={{width:"100%",accentColor:G}}/>
              </div>
              {/* Key/Camelot grid */}
              <div>
                <div style={{fontSize:7,fontFamily:"'DM Mono',monospace",color:"#555562",letterSpacing:1.5,marginBottom:5}}>KEY (CAMELOT)</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(12,1fr)",gap:2}}>
                  {CAMELOT_KEYS.map(k=>(
                    <button key={k} onClick={()=>setKeyFilter(kf=>kf===k?null:k)}
                      style={{padding:"3px 1px",fontSize:7,fontFamily:"'DM Mono',monospace",
                        background:keyFilter===k?G:"transparent",
                        color:keyFilter===k?"#000":k.endsWith("A")?"#8B6EAF":G,
                        border:`1px solid ${keyFilter===k?G:k.endsWith("A")?"#8B6EAF44":G+"33"}`,
                        borderRadius:3,cursor:"pointer",textAlign:"center"}}>{k}</button>
                  ))}
                </div>
              </div>
              {hasActiveFilter&&(
                <button onClick={()=>{setEnergyFilter(null);setBpmRange([60,200]);setKeyFilter(null);}}
                  style={{padding:"4px",fontSize:7,fontFamily:"'DM Mono',monospace",background:"transparent",border:"1px solid #252535",color:"#555562",borderRadius:4,cursor:"pointer",letterSpacing:1}}>
                  RESET FILTERS</button>
              )}
            </div>
          )}
        </div>

        {/* Column headers */}
        <div style={{display:"grid",gridTemplateColumns:"28px 36px 1fr 70px 44px 70px 44px 64px",gap:6,padding:"4px 10px",borderBottom:"1px solid #181820",flexShrink:0}}>
          <div/><div/>
          {colHdr("TITLE / ARTIST","title")}
          {colHdr("BPM","bpm")}
          {colHdr("KEY","key")}
          {colHdr("ENERGY","energyScore")}
          {colHdr("TIME","duration")}
          <div/>
        </div>

        {/* Drill-down list OR track rows */}
        {isDrillList?(
          /* Artist / Label / Energy drill-down selector */
          <div style={{flex:1,overflowY:"auto",padding:"4px 0"}}>
            {(view==="artists"?uniqueArtists:view==="labels"?uniqueLabels:uniqueEnergies).map(val=>{
              const count=allTracks.filter(t=>view==="artists"?t.artist===val:view==="labels"?t.label===val:t.energy?.label===val).length;
              const eCol=view==="energy"?ENERGY_COLOR[val]:null;
              return(
                <div key={val} onClick={()=>setDrillValue(val)}
                  style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",borderBottom:"1px solid #14141e",cursor:"pointer",background:"transparent",transition:"background .1s"}}
                  onMouseEnter={e=>e.currentTarget.style.background="#181822"}
                  onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                  {eCol&&<div style={{width:8,height:8,borderRadius:"50%",background:eCol,flexShrink:0,boxShadow:`0 0 6px ${eCol}`}}/>}
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:11,fontFamily:"'DM Sans',sans-serif",color:"#d8d8e2",fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{val||"Unknown"}</div>
                    <div style={{fontSize:8,fontFamily:"'DM Mono',monospace",color:"#555562",marginTop:1}}>{count} {count===1?"track":"tracks"}</div>
                  </div>
                  <span style={{fontSize:10,color:"#555562",flexShrink:0}}>›</span>
                </div>
              );
            })}
            {(view==="artists"?uniqueArtists:view==="labels"?uniqueLabels:uniqueEnergies).length===0&&(
              <div style={{padding:24,textAlign:"center",fontSize:9,fontFamily:"'DM Mono',monospace",color:"#555562"}}>
                {view==="artists"?"No artists found":view==="labels"?"No labels — import tracks with label tags":"Analyze tracks to see energy levels"}
              </div>
            )}
          </div>
        ):(
          <div style={{flex:1,overflowY:"auto",padding:"2px 0"}} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();lib.importFiles([...e.dataTransfer.files]);}}>
            {filtered.length===0?(
              <div onClick={()=>setShowImportModal(true)} style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",gap:12,cursor:"pointer",padding:20,border:`2px dashed #C8A96E18`,borderRadius:8,margin:8}}>
                <div style={{fontSize:28,opacity:.15}}>♫</div>
                <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#555562",textAlign:"center",letterSpacing:1,lineHeight:2}}>{allTracks.length===0?"DROP TRACKS HERE\nOR CLICK TO ADD\n\nMP3 · WAV · FLAC · AAC":"NO TRACKS MATCH"}</div>
              </div>
            ):filtered.map(track=>{
              const recData=selfRecs.find(r=>r.id===track.id);
              return(
                <TrackRow
                  key={track.id}
                  track={track}
                  onLoadA={()=>onLoad(track,"A")}
                  onLoadB={()=>onLoad(track,"B")}
                  isRec={recIds.has(track.id)}
                  reasons={recData?.reasons}
                  canLoad={true}
                  previewTrackId={previewTrackId}
                  onPreview={onPreview}
                  onDelete={onDelete}
                  onRemoveFromPlaylist={activeCrateId?removeFromPlaylist:undefined}
                  extractArtwork={lib.extractArtworkForTrack?(id)=>lib.extractArtworkForTrack(id,lib.getFile):undefined}
                />
              );
            })}
          </div>
        )}
      </div>{/* end main track list column */}

      {/* ── ALWAYS-ON SUGGEST PANEL ── */}
      <div style={{width:220,flexShrink:0,display:"flex",flexDirection:"column",borderLeft:"1px solid #1e1e28",background:"#09090f",overflow:"hidden"}}>
        <div style={{padding:"6px 10px 5px",borderBottom:"1px solid #1e1e28",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div style={{fontSize:9,fontFamily:"'DM Mono',monospace",color:`${G}cc`,letterSpacing:1.5}}>SUGGESTIONS</div>
          {selfRecs.length>0&&<span style={{fontSize:8,fontFamily:"'DM Mono',monospace",color:"#555562"}}>{selfRecs.length}</span>}
        </div>
        <div style={{flex:1,overflowY:"auto",padding:"2px 0"}}>
          {selfRecs.length===0?(
            <div style={{padding:16,fontSize:8,fontFamily:"'DM Mono',monospace",color:"#555562",textAlign:"center",lineHeight:1.8,marginTop:8}}>
              Load a track to<br/>see mix suggestions<br/><br/>
              <span style={{color:"#333340"}}>Matches by key,<br/>BPM &amp; energy</span>
            </div>
          ):selfRecs.map(track=>{
            return(
              <div key={track.id}
                draggable
                onDragStart={e=>{e.dataTransfer.setData("application/json",JSON.stringify({trackId:track.id,title:track.title,artist:track.artist}));e.dataTransfer.effectAllowed="copy";}}
                style={{padding:"7px 10px",borderBottom:"1px solid #12121c",cursor:"grab"}}
                onMouseEnter={e=>e.currentTarget.style.background="#151520"}
                onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                <div style={{display:"flex",gap:7,alignItems:"center"}}>
                  {/* mini artwork */}
                  {(()=>{const[ac,ac2]=sesAvatarColor(track.artist||track.title||"");const init=(track.artist||track.title||"?")[0].toUpperCase();return(
                    <div style={{width:26,height:26,borderRadius:4,flexShrink:0,background:track.artwork?`#000`:`linear-gradient(135deg,${ac},${ac2})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,color:"#fff",position:"relative",overflow:"hidden"}}>
                      {track.artwork?<img src={track.artwork} alt="" style={{width:"100%",height:"100%",objectFit:"cover",position:"absolute",inset:0}}/>:<span>{init}</span>}
                    </div>
                  );})()}
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:9,color:"#d8d8e2",fontFamily:"'DM Sans',sans-serif",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontWeight:500}}>{track.title||track.filename}</div>
                    <div style={{fontSize:8,color:"#888898",fontFamily:"'DM Sans',sans-serif",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{track.artist}</div>
                  </div>
                </div>
                {/* reasons */}
                {track.reasons?.length>0&&<div style={{display:"flex",gap:2,flexWrap:"wrap",marginTop:4}}>{track.reasons.map(r=><span key={r} style={{fontSize:6,fontFamily:"'DM Mono',monospace",color:"#22c55e",background:"#22c55e10",borderRadius:2,padding:"0 4px",letterSpacing:.4}}>{r}</span>)}</div>}
                {/* load buttons */}
                <div style={{display:"flex",gap:3,marginTop:5}}>
                  <button onClick={()=>onLoad(track,"A")} style={{flex:1,padding:"3px 0",fontSize:8,fontFamily:"'DM Mono',monospace",background:`${G}12`,border:`1px solid ${G}2a`,color:G,borderRadius:3,cursor:"pointer"}}>→ A</button>
                  <button onClick={()=>onLoad(track,"B")} style={{flex:1,padding:"3px 0",fontSize:8,fontFamily:"'DM Mono',monospace",background:"#C8A96E10",border:"1px solid #C8A96E28",color:"#C8A96E",borderRadius:3,cursor:"pointer"}}>→ B</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      </div>{/* end track list + suggest row */}

      {/* ── IMPORT MODAL ── */}
      {showImportModal&&(
        <div onClick={e=>{if(e.target===e.currentTarget)setShowImportModal(false);}} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.8)",zIndex:9998,display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(8px)"}}>
          <div style={{width:480,background:"#0E0C1A",border:"1px solid #252535",borderRadius:14,padding:28,display:"flex",flexDirection:"column",gap:18,boxShadow:"0 40px 80px rgba(0,0,0,.8)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:13,color:G,letterSpacing:1}}>ADD MUSIC</div>
              <button onClick={()=>setShowImportModal(false)} style={{background:"transparent",border:"none",color:"#555562",fontSize:16,cursor:"pointer",padding:"2px 6px"}}>✕</button>
            </div>
            {/* Tab selector */}
            <div style={{display:"flex",gap:0,borderRadius:7,overflow:"hidden",border:"1px solid #252535"}}>
              {[["local","📁 Local Files"],["itunes","🎵 iTunes"],["rekordbox","🎛 Rekordbox"]].map(([tab,label])=>(
                <button key={tab} onClick={()=>setImportTab(tab)} style={{flex:1,padding:"8px 4px",fontSize:9,fontFamily:"'DM Mono',monospace",background:importTab===tab?`${G}18`:"transparent",color:importTab===tab?G:"#555562",border:"none",borderRight:tab!=="rekordbox"?"1px solid #252535":"none",cursor:"pointer",letterSpacing:.5}}>{label}</button>
              ))}
            </div>

            {importTab==="local"&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <div style={{fontSize:10,fontFamily:"'DM Sans',sans-serif",color:"#888898",lineHeight:1.6}}>Select individual audio files or hold <span style={{color:G,fontFamily:"'DM Mono',monospace"}}>⌘/Ctrl</span> to select multiple files at once.</div>
                <div onClick={()=>fileRef.current?.click()} style={{border:`2px dashed ${G}33`,borderRadius:8,padding:24,textAlign:"center",cursor:"pointer",display:"flex",flexDirection:"column",gap:8}} onMouseEnter={e=>e.currentTarget.style.borderColor=G+"66"} onMouseLeave={e=>e.currentTarget.style.borderColor=G+"33"}>
                  <div style={{fontSize:24,opacity:.4}}>♫</div>
                  <div style={{fontSize:10,fontFamily:"'DM Mono',monospace",color:G,letterSpacing:.5}}>CLICK TO BROWSE</div>
                  <div style={{fontSize:9,fontFamily:"'DM Sans',sans-serif",color:"#555562"}}>MP3 · WAV · FLAC · AAC · OGG · M4A</div>
                </div>
                <div style={{fontSize:9,fontFamily:"'DM Sans',sans-serif",color:"#555562",textAlign:"center"}}>You can also drag &amp; drop files directly into the track list</div>
              </div>
            )}

            {importTab==="itunes"&&(
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                <div style={{fontSize:10,fontFamily:"'DM Sans',sans-serif",color:"#888898",lineHeight:1.7}}>Export your iTunes/Apple Music library XML and import it here to see all your tracks, BPM, keys and artwork.</div>
                <div style={{background:"#0c0c14",border:"1px solid #1e1e28",borderRadius:8,padding:14,display:"flex",flexDirection:"column",gap:6}}>
                  <div style={{fontSize:9,fontFamily:"'DM Mono',monospace",color:G,letterSpacing:.5,marginBottom:4}}>HOW TO EXPORT FROM ITUNES / MUSIC APP</div>
                  {["1. Open iTunes or Apple Music on your Mac","2. Go to File → Library → Export Library…","3. Save the file as iTunes Music Library.xml","4. Click the button below to select it"].map((s,i)=>(
                    <div key={i} style={{fontSize:9,fontFamily:"'DM Sans',sans-serif",color:"#888898",display:"flex",gap:8,alignItems:"flex-start"}}>
                      <span style={{color:G,fontFamily:"'DM Mono',monospace",fontSize:8,flexShrink:0,marginTop:1}}>{i+1}.</span>{s.slice(3)}
                    </div>
                  ))}
                </div>
                <button onClick={()=>itunesRef.current?.click()} style={{padding:"10px",fontSize:10,fontFamily:"'DM Mono',monospace",background:`${G}18`,border:`1px solid ${G}44`,color:G,borderRadius:7,cursor:"pointer",letterSpacing:.5}}>SELECT ITUNES XML FILE</button>
              </div>
            )}

            {importTab==="rekordbox"&&(
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                <div style={{fontSize:10,fontFamily:"'DM Sans',sans-serif",color:"#888898",lineHeight:1.7}}>Export your Rekordbox collection as XML and import it here to sync your tracks, cue points and playlists.</div>
                <div style={{background:"#0c0c14",border:"1px solid #1e1e28",borderRadius:8,padding:14,display:"flex",flexDirection:"column",gap:6}}>
                  <div style={{fontSize:9,fontFamily:"'DM Mono',monospace",color:G,letterSpacing:.5,marginBottom:4}}>HOW TO EXPORT FROM REKORDBOX</div>
                  {["1. Open Rekordbox on your computer","2. Go to File → Export Collection in xml format","3. Choose a save location and click Export","4. Click the button below to select the exported XML"].map((s,i)=>(
                    <div key={i} style={{fontSize:9,fontFamily:"'DM Sans',sans-serif",color:"#888898",display:"flex",gap:8,alignItems:"flex-start"}}>
                      <span style={{color:"#00BFA5",fontFamily:"'DM Mono',monospace",fontSize:8,flexShrink:0,marginTop:1}}>{i+1}.</span>{s.slice(3)}
                    </div>
                  ))}
                </div>
                <button onClick={()=>rekordboxRef.current?.click()} style={{padding:"10px",fontSize:10,fontFamily:"'DM Mono',monospace",background:"#00BFA518",border:"1px solid #00BFA544",color:"#00BFA5",borderRadius:7,cursor:"pointer",letterSpacing:.5}}>SELECT REKORDBOX XML FILE</button>
              </div>
            )}
          </div>
        </div>
      )}

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
        logEvent("ws", "connected", { roomCode: roomId });
        w.send(JSON.stringify({ type:"join", roomId, djName }));
        pt.current = setInterval(() => send({ type:"ping", clientTime:Date.now() }), 3000);
      };
      w.onmessage = (e) => {
        let m; try{m=JSON.parse(e.data);}catch{return;}
        if(m.type==="joined"){setPartner(m.partnerName);}
        if(m.type==="partner_joined"){setPartner(m.djName);send({type:"sync_request"});}
        if(m.type==="partner_left")  setPartner(null);
        if(m.type==="pong")          setPing(Date.now()-m.clientTime);
        if(m.type==="error")         setConnErr(m.msg);
        cb.current?.(m);
      };
      w.onerror = () => { setStatus("error"); setConnErr("Could not connect to server. Check the URL."); };
      w.onclose = (ev) => { logEvent("ws", "disconnected", { roomCode: roomId, reason: ev?.reason || null, code: ev?.code ?? null }); setStatus("disconnected"); clearInterval(pt.current); };
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
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const pc=useRef(null),dest=useRef(null),remAudio=useRef(null),pend=useRef([]),sRef=useRef(send);
  useEffect(()=>{sRef.current=send;},[send]);

  const capture = useCallback(() => {
    const eng=engineRef.current; if(!eng)throw new Error("No engine");
    const d=eng.ctx.createMediaStreamDestination(); eng.master.connect(d); dest.current=d; return d.stream;
  },[engineRef]);

  const tryPlayRemote = useCallback(() => {
    const a = remAudio.current;
    if (!a) return;
    a.play().then(() => {
      console.log('[RTC] audio element play() succeeded');
      setAutoplayBlocked(false);
    }).catch(err => {
      console.log('[RTC] audio element play() failed:', err.name, err.message);
      setAutoplayBlocked(true);
    });
  }, []);

  const mkPC = useCallback(() => {
    if(pc.current)pc.current.close();
    const p=new RTCPeerConnection(ICE); pc.current=p;
    p.onicecandidate=({candidate})=>{if(candidate)sRef.current({type:"rtc_ice",candidate:candidate.toJSON()});};
    p.oniceconnectionstatechange=()=>{
      const s=p.iceConnectionState;
      console.log('[RTC] ice state:', s);
      if(s==="connected"||s==="completed")setState("connected");
      if(s==="failed")setState("failed");
      if(s==="closed")setState("idle");
    };
    p.onconnectionstatechange=()=>{ console.log('[RTC] connection state:', p.connectionState); logEvent("rtc", "connection_state", { state: p.connectionState }); };
    p.ontrack=({streams})=>{
      console.log('[RTC] incoming track received');
      if(!streams[0])return;
      if(!remAudio.current){
        remAudio.current=new Audio();
        remAudio.current.autoplay=true;
        // Append to DOM — some browsers won't drive playback for detached
        // <audio> elements, even with a live srcObject. Hidden via display:none.
        remAudio.current.style.display='none';
        document.body.appendChild(remAudio.current);
      }
      remAudio.current.srcObject=streams[0];
      remAudio.current.volume=Math.min(1,remVol);
      // Explicit play() so we can observe autoplay-policy rejections and surface them.
      tryPlayRemote();
    };
    return p;
  },[remVol,tryPlayRemote]);

  useEffect(()=>{ if(remAudio.current)remAudio.current.volume=Math.min(1,remVol); },[remVol]);

  // One-time document click handler that retries play() once user has interacted.
  // Browser autoplay policy blocks <audio>.play() until a user gesture has occurred
  // on the page; this catches that case without forcing the user to click an exact
  // banner button.
  useEffect(()=>{
    if(!autoplayBlocked) return;
    const handler = () => { tryPlayRemote(); };
    document.addEventListener('click', handler, { once: true });
    return () => document.removeEventListener('click', handler);
  },[autoplayBlocked,tryPlayRemote]);

  const startCall = useCallback(async()=>{
    console.log('[RTC] startCall fired');
    setState("connecting");
    try{
      const s=capture(); const p=mkPC();
      s.getTracks().forEach(t=>p.addTrack(t,s));
      const o=await p.createOffer({offerToReceiveAudio:true});
      await p.setLocalDescription(o);
      sRef.current({type:"rtc_offer",sdp:p.localDescription});
      console.log('[RTC] offer created and sent');
      setState("offering");
    } catch(e){ console.error('[RTC] startCall error:',e); captureHandledError(e, { operation: "rtc_startCall" }); setState("failed"); }
  },[capture,mkPC]);

  const handleOffer = useCallback(async({sdp})=>{
    console.log('[RTC] offer received, answering');
    setState("answering");
    try{
      const s=capture(); const p=mkPC();
      s.getTracks().forEach(t=>p.addTrack(t,s));
      await p.setRemoteDescription(new RTCSessionDescription(sdp));
      for(const c of pend.current){try{await p.addIceCandidate(new RTCIceCandidate(c));}catch{}} pend.current=[];
      const a=await p.createAnswer();
      await p.setLocalDescription(a);
      sRef.current({type:"rtc_answer",sdp:p.localDescription});
      setState("connecting");
    } catch(e){ console.error('[RTC] handleOffer error:',e); captureHandledError(e, { operation: "rtc_handleOffer" }); setState("failed"); }
  },[capture,mkPC]);

  const handleAnswer = useCallback(async({sdp})=>{
    console.log('[RTC] answer received');
    if(!pc.current)return;
    try{
      await pc.current.setRemoteDescription(new RTCSessionDescription(sdp));
      for(const c of pend.current){try{await pc.current.addIceCandidate(new RTCIceCandidate(c));}catch{}} pend.current=[];
    } catch(e){
      if (e.name === 'InvalidStateError') {
        console.log('[RTC] handleAnswer: peer already stable, ignoring late answer (likely glare resolved by remote offer)');
      } else {
        console.error('[RTC] handleAnswer error:',e);
        captureHandledError(e, { operation: "rtc_handleAnswer" });
      }
    }
  },[]);
  const handleIce   = useCallback(async({candidate})=>{ if(!candidate)return; if(pc.current?.remoteDescription){try{await pc.current.addIceCandidate(new RTCIceCandidate(candidate));}catch{}}else pend.current.push(candidate); },[]);
  const endCall     = useCallback(()=>{
    sRef.current({type:"rtc_hangup"});
    pc.current?.close(); pc.current=null;
    // Guard disconnect: passing null to AudioNode.disconnect() severs ALL outputs in Chrome,
    // not just the named one. Only disconnect if we actually have a destination to sever.
    if (dest.current && engineRef.current) {
      try { engineRef.current.master.disconnect(dest.current); } catch {}
    }
    dest.current=null;
    if(remAudio.current)remAudio.current.srcObject=null;
    setAutoplayBlocked(false);
    setState("idle");
  },[engineRef]);
  const toggleMute  = useCallback(()=>{ dest.current?.stream.getTracks().forEach(t=>{t.enabled=muted;}); setMuted(m=>!m); },[muted]);
  const handleRtc   = useCallback((msg)=>{ switch(msg.type){case"rtc_offer":handleOffer(msg);break;case"rtc_answer":handleAnswer(msg);break;case"rtc_ice":handleIce(msg);break;case"rtc_hangup":endCall();break;} },[handleOffer,handleAnswer,handleIce,endCall]);

  useEffect(()=>()=>endCall(),[]);
  return { state, muted, remVol, setRemVol, autoplayBlocked, startCall, endCall, toggleMute, handleRtc };
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

function WF({ bands, peaks, freq, prog, onSeek, h=80, hotCues=[], loopStart=null, loopEnd=null, loopActive=false, bpm=null, dur=0, beatPhaseFrac=null, color='#ffffff' }) {
  const ref=useRef(null);
  useEffect(()=>{
    if(!ref.current)return;
    const canvas=ref.current;
    const dpr=window.devicePixelRatio||1;
    const W=canvas.clientWidth||900, H=h;
    canvas.width=W*dpr; canvas.height=H*dpr;
    const ctx=canvas.getContext("2d");
    ctx.scale(dpr,dpr);
    ctx.clearRect(0,0,W,H);
    const px=Math.floor(prog*W);

    // ── Resolve band data ──
    let bArr=null,mArr=null,hArr=null;
    if(bands&&bands.bass&&bands.bass.length){
      bArr=bands.bass; mArr=bands.mid; hArr=bands.high;
    } else if(peaks&&peaks.length){
      bArr=peaks.map((p,i)=>p*Math.max(0.2,1-(freq?.[i]||0.3)*1.8));
      mArr=peaks.map((p,i)=>p*(0.3+(freq?.[i]||0.3)*0.8));
      hArr=peaks.map((p,i)=>p*Math.min(0.6,(freq?.[i]||0)*1.5));
    }

    if(bArr){
      const len=bArr.length;
      // Beatport-style smooth filled envelope, mirrored around center.
      // Per-pixel envelope = max of bass/mid/high. Trace as single closed
      // path for the silhouette, then layer per-column brightness + centerline
      // weight on top to give loud sections visual pop without rounding off
      // transient peaks.
      const center=H/2;
      const maxH=H/2 - 1;
      const GAMMA=1.4;
      const heights=new Float32Array(W);
      const envs=new Float32Array(W);
      for(let x=0;x<W;x++){
        const i0=Math.floor(x*len/W), i1=Math.min(len-1,Math.floor((x+1)*len/W));
        let bv=0,mv=0,hv=0;
        for(let k=i0;k<=i1;k++){
          const bk=bArr[k]||0; if(bk>bv)bv=bk;
          const mk=mArr?mArr[k]||0:0; if(mk>mv)mv=mk;
          const hk=hArr?hArr[k]||0:0; if(hk>hv)hv=hk;
        }
        const env=bv>mv?(bv>hv?bv:hv):(mv>hv?mv:hv);
        envs[x]=env;
        heights[x]=env<=0?0:Math.min(maxH,Math.pow(env,GAMMA)*maxH);
      }

      // Parse color → rgb. Played portion (left of playhead) gets a brighter
      // alpha multiplier so you can still read progress at a glance.
      const c=color||'#ffffff';
      let r=255,g=255,b=255;
      if(c.length>=7&&c[0]==='#'){
        r=parseInt(c.slice(1,3),16)|0;
        g=parseInt(c.slice(3,5),16)|0;
        b=parseInt(c.slice(5,7),16)|0;
      }

      // ── Pass 1: smooth filled envelope path at DIM baseline (silhouette).
      const baseGrad=ctx.createLinearGradient(0,center-maxH,0,center+maxH);
      baseGrad.addColorStop(0,`rgba(${r},${g},${b},0.18)`);
      baseGrad.addColorStop(0.5,`rgba(${r},${g},${b},0.32)`);
      baseGrad.addColorStop(1,`rgba(${r},${g},${b},0.18)`);
      ctx.fillStyle=baseGrad;
      ctx.beginPath();
      ctx.moveTo(0,center);
      for(let x=0;x<W;x++) ctx.lineTo(x+0.5,center-heights[x]);
      ctx.lineTo(W,center);
      for(let x=W-1;x>=0;x--) ctx.lineTo(x+0.5,center+heights[x]);
      ctx.closePath();
      ctx.fill();

      // ── Pass 2: per-column amplitude overlay. Brightens loud columns with
      // a 1px vertical rect across the envelope at alpha ∝ amplitude. Played
      // columns get a 1.4× multiplier so the played region reads brighter.
      ctx.fillStyle=`rgb(${r},${g},${b})`;
      for(let x=0;x<W;x++){
        const h=heights[x];
        if(h<=0) continue;
        const env=envs[x];
        const playedMul=x<px?1.40:1.0;
        ctx.globalAlpha=Math.min(1,Math.pow(env,0.75)*0.55*playedMul);
        ctx.fillRect(x,center-h,1,h*2+1);
      }
      ctx.globalAlpha=1;

      // (Centerline weight band intentionally omitted on the small WF —
      // at h=40 there's not enough vertical space; it read as a divider
      // line rather than "energy" and added visual noise.)

      // ── Playhead marker ──
      ctx.fillStyle='rgba(0,0,0,0.35)'; ctx.fillRect(px-1,0,4,H);
      ctx.fillStyle='#ffffff'; ctx.shadowColor='#ffffff'; ctx.shadowBlur=8;
      ctx.fillRect(px,0,2,H); ctx.shadowBlur=0;

      // ── Loop region ──
      if(loopStart!==null&&loopEnd!==null){
        const lx1=Math.floor(loopStart*W),lx2=Math.floor(loopEnd*W);
        ctx.fillStyle=loopActive?"rgba(200,169,110,0.22)":"rgba(200,169,110,0.09)";
        ctx.fillRect(lx1,0,lx2-lx1,H);
        ctx.fillStyle=loopActive?"#C8A96Ecc":"#C8A96E66";
        ctx.fillRect(lx1,0,2,H); ctx.fillRect(Math.max(lx1,lx2-2),0,2,H);
      }

      // ── Hot cue markers ──
      const CUE_CLR=["#C8A96E","#ef4444","#22c55e","#f59e0b"];
      hotCues.forEach((cue,ci)=>{
        if(cue===null)return;
        const cx=Math.floor(cue*W);
        ctx.fillStyle=CUE_CLR[ci]; ctx.shadowColor=CUE_CLR[ci]; ctx.shadowBlur=6;
        ctx.fillRect(cx,0,2,H); ctx.shadowBlur=0;
        if(cx>4&&cx<W-4){ctx.beginPath();ctx.moveTo(cx-4,0);ctx.lineTo(cx+5,0);ctx.lineTo(cx+1,9);ctx.fillStyle=CUE_CLR[ci];ctx.fill();}
      });
    } else {
      // Empty state
      ctx.fillStyle="#ffffff08"; ctx.fillRect(0,H-1,W,1);
    }
  },[bands,peaks,freq,prog,hotCues,loopStart,loopEnd,loopActive,bpm,dur,beatPhaseFrac,color]);

  const onClick=e=>{
    if(!onSeek||!ref.current)return;
    const r=ref.current.getBoundingClientRect();
    onSeek((e.clientX-r.left)/r.width);
  };
  return <canvas ref={ref} onClick={onClick} style={{width:"100%",height:h,background:"#030306",cursor:onSeek?"crosshair":"default",display:"block"}}/>;
}

// ── AnimatedZoomedWF — Beatport-style smooth zoomed waveform ──
// Per-column max amplitude is sampled into a heights buffer, then traced as
// a single filled path: top sweep left→right at center-h, bottom sweep
// right→left at center+h, closed and filled in one stroke. Antialiased path
// edges produce a continuous organic silhouette rather than the staircase
// look of per-column 1px rects. Single deck-identity color with a subtle
// vertical gradient (brighter at center, dimmer at peaks) for body.
//
// 60fps RAF. ResizeObserver watches the canvas — the draw loop never reads
// clientWidth.
function AnimatedZoomedWF({ bands, dur, progRef, onSeek, h=96, windowSec=8, beatPhaseFrac=null, beatPeriodSec=null, gridOffsetMs=0, bpmNudge=0, deckColor="#FFFFFF" }) {
  const ref=useRef(null);
  const raf=useRef(null);
  const colBufRef=useRef(null); // {bv, mv, hv, heights: Float32Array, len} — per-column scratch
  const sizeRef=useRef({physW:0,physH:0,dirty:true});
  const durRef=useRef(dur);
  const seekRef=useRef(onSeek);
  // bands needs a ref too — the RAF useEffect only depends on [h, windowSec, progRef],
  // so without this the draw loop closure would hold a stale (initial) bands value
  // and never pick up new arrays when a track finishes analyzing.
  const bandsRef=useRef(bands);
  // Cached per-track max of bass-weighted env (0.7b+0.2m+0.1h) across the
  // full 24k source columns. Used to renormalize the per-column env in
  // Pass 2 so the loudest column on the track maps to 1.0 after the
  // weighted-sum reduction (which otherwise tops out around 0.85-0.95
  // because no column has bass=mid=high=1.0 simultaneously). Recomputed
  // once per bands-identity change; cheap (one linear pass over 24k).
  const envMaxRef=useRef({bands:null,maxVal:1});
  // Temporary one-shot diagnostic — fires once per bands change.
  const diagRef=useRef({bands:null,done:false});
  const beatPhaseFracRef=useRef(beatPhaseFrac);
  const beatPeriodSecRef=useRef(beatPeriodSec);
  const gridOffsetMsRef=useRef(gridOffsetMs);
  const bpmNudgeRef=useRef(bpmNudge);
  const deckColorRef=useRef(deckColor);
  useEffect(()=>{durRef.current=dur;},[dur]);
  useEffect(()=>{seekRef.current=onSeek;},[onSeek]);
  useEffect(()=>{bandsRef.current=bands;},[bands]);
  useEffect(()=>{beatPhaseFracRef.current=beatPhaseFrac;},[beatPhaseFrac]);
  useEffect(()=>{beatPeriodSecRef.current=beatPeriodSec;},[beatPeriodSec]);
  useEffect(()=>{gridOffsetMsRef.current=gridOffsetMs;},[gridOffsetMs]);
  useEffect(()=>{bpmNudgeRef.current=bpmNudge;},[bpmNudge]);
  useEffect(()=>{deckColorRef.current=deckColor;},[deckColor]);

  useEffect(()=>{
    const canvas=ref.current; if(!canvas) return;
    let physW=0,physH=0,ctx=null;
    const dpr=window.devicePixelRatio||1;

    const ro=new ResizeObserver(entries=>{
      const e=entries[0]; if(!e) return;
      const pw=Math.round(e.contentRect.width*dpr);
      const ph=Math.round(e.contentRect.height*dpr);
      sizeRef.current={physW:pw,physH:ph,dirty:true};
    });
    ro.observe(canvas);

    const draw=()=>{
      raf.current=requestAnimationFrame(draw);

      const sz=sizeRef.current;
      if(sz.dirty||physW===0){
        sz.dirty=false;
        const newPW=sz.physW||Math.round((canvas.offsetWidth||1200)*dpr);
        const newPH=sz.physH||Math.round(h*dpr);
        if(newPW!==physW||newPH!==physH){
          physW=newPW; physH=newPH;
          canvas.width=physW; canvas.height=physH;
          ctx=canvas.getContext('2d');
          colBufRef.current=null; // force realloc on next frame
        }
      }
      if(!ctx) return;

      const dur2=durRef.current;
      const prog2=progRef?.current??0;
      // Two independent paddings:
      //  - tickRailPad governs where beat-grid ticks center vertically (visual
      //    positioning, anchored relative to the canvas edges).
      //  - ampPad governs how far the audio amplitude renders from the edge —
      //    making it larger than tickRailPad compresses the waveform toward the
      //    centerline so there's empty space between the audio shape and the
      //    tick marks above/below.
      const tickRailPad=Math.round(18*dpr);
      const ampPad=Math.round(26*dpr);
      const ampTop=ampPad;
      const ampBottom=physH-ampPad;
      const drawH=ampBottom-ampTop;
      const center=(ampTop+ampBottom)>>1;
      // maxH keeps top (center-envH ≥ ampTop) and bottom (center+1+envH ≤ ampBottom).
      const maxH=Math.max(0,Math.min(center-ampTop,ampBottom-1-center));
      const bands=bandsRef.current;

      ctx.fillStyle='#030308';
      ctx.fillRect(0,0,physW,physH);

      if(bands&&bands.bass&&bands.bass.length&&dur2&&maxH>0){
        const bArr=bands.bass, mArr=bands.mid, hArr=bands.high;
        const len=bArr.length;
        const viewPx=(windowSec/dur2)*len;
        const srcX=prog2*len-viewPx/2;
        const spp=viewPx/physW;

        if(!colBufRef.current||colBufRef.current.len<physW){
          colBufRef.current={
            bv:new Float32Array(physW+64),
            mv:new Float32Array(physW+64),
            hv:new Float32Array(physW+64),
            heights:new Float32Array(physW+64),
            envs:new Float32Array(physW+64),
            len:physW+64,
          };
        }
        const {bv:colB,mv:colM,hv:colH,heights,envs}=colBufRef.current;

        // ── Pass 1: MAX amplitude per column. For sub-sample zoom (spp<1),
        // nearest-neighbor replication keeps the source peaks visible. ──
        for(let dx=0;dx<physW;dx++){
          const f0=srcX+dx*spp;
          const f1=f0+spp;
          const i0=f0|0, i1=f1|0;
          const s0=i0<0?0:(i0>=len?len-1:i0);
          const s1=i1<s0?s0:(i1>=len?len-1:i1);
          let b=0,m=0,hh=0;
          if(f1>=0&&f0<len){
            for(let k=s0;k<=s1;k++){
              const bk=bArr[k]; if(bk>b)b=bk;
              const mk=mArr[k]; if(mk>m)m=mk;
              const hk=hArr[k]; if(hk>hh)hh=hk;
            }
          }
          colB[dx]=b; colM[dx]=m; colH[dx]=hh;
        }

        // Compute heights + cache env per column. Env is BASS-WEIGHTED
        // (0.7 bass + 0.2 mid + 0.1 high), then renormalized to per-track
        // max so the loudest column maps to 1.0 (otherwise weighted sum
        // tops out around 0.85-0.95 and drops never touch full height).
        // envs[] is also consumed by the brightness overlay and centerline
        // weight band, so drops also visibly brighten + thicken on the
        // same signal.
        //
        // Gamma 1.4 tuned for the renormalized bass-weighted distribution:
        // breakdowns ~5% maxH (thin line), verses ~34% maxH (medium),
        // drops 80-100% maxH (tower with headroom). Small WF keeps
        // env=max(b,m,h) for full detail at h=40.

        // Recompute per-track bass-weighted max if bands changed (cached
        // by bands identity; one linear pass over ~24k source columns).
        if(envMaxRef.current.bands!==bands){
          const srcLen=bArr.length;
          let mx=0;
          for(let i=0;i<srcLen;i++){
            const v=0.7*bArr[i]+0.2*mArr[i]+0.1*hArr[i];
            if(v>mx) mx=v;
          }
          envMaxRef.current={bands,maxVal:mx>0.0001?mx:1};
        }
        const envDivisor=envMaxRef.current.maxVal;

        // Heights: gamma 1.4 base curve + strong additive lift (0.35*maxH at
        // env=1.0) for env > 0.7. Drops at p99 saturate freely at maxH;
        // verses and breakdowns sit at the unmodified gamma curve. No
        // additive floor — breakdowns stay thin (~4% maxH) but remain
        // visible via the centerline weight band that scales with env in
        // Pass 2c. Hard silence (env ≤ 0.01) gates to zero. envs[] holds
        // the pre-lift bass-weighted env so the brightness overlay and
        // centerline weight band consume the same signal they did before.
        const GAMMA=1.4;
        const LIFT_TH=0.7, LIFT_AMT=0.35;
        for(let dx=0;dx<physW;dx++){
          const bv=colB[dx], mv=colM[dx], hv=colH[dx];
          const env=(0.7*bv+0.2*mv+0.1*hv)/envDivisor;
          envs[dx]=env;
          if(env<=0.01){heights[dx]=0;continue;}
          let h=Math.pow(env,GAMMA)*maxH;
          if(env>LIFT_TH) h+=maxH*LIFT_AMT*(env-LIFT_TH)/(1-LIFT_TH);
          heights[dx]=h<maxH?h:maxH;
        }

        if(diagRef.current.bands!==bands){
          const sortedH=Array.from(heights.slice(0,physW)).sort((a,b)=>a-b);
          const sortedE=Array.from(envs.slice(0,physW)).sort((a,b)=>a-b);
          const pctH=p=>sortedH[Math.min(physW-1,Math.floor(physW*p))];
          const pctE=p=>sortedE[Math.min(physW-1,Math.floor(physW*p))];
          const deckId=deckColorRef.current==='#7B61FF'?'A':deckColorRef.current==='#00BFA5'?'B':'?';
          console.log(`[WF-DIAG ${deckId}]`,{
            canvasCss:{w:canvas.clientWidth,h:canvas.clientHeight},
            canvasPhys:{w:physW,h:physH},
            dpr,
            ampPad,
            maxH_phys:maxH,
            maxH_css:(maxH/dpr).toFixed(1),
            env:{p50:pctE(0.5)?.toFixed(3),p99:pctE(0.99)?.toFixed(3),max:sortedE[physW-1]?.toFixed(3)},
            height_phys:{p50:pctH(0.5)?.toFixed(1),p99:pctH(0.99)?.toFixed(1),max:sortedH[physW-1]?.toFixed(1)},
            height_css:{p50:(pctH(0.5)/dpr).toFixed(1),p99:(pctH(0.99)/dpr).toFixed(1),max:(sortedH[physW-1]/dpr).toFixed(1)},
            height_pctMaxH:{p50:(pctH(0.5)/maxH*100).toFixed(0)+'%',p99:(pctH(0.99)/maxH*100).toFixed(0)+'%',max:(sortedH[physW-1]/maxH*100).toFixed(0)+'%'},
          });
          diagRef.current={bands,done:true};
        }

        // Parse deck color → rgb for all three passes below.
        const dc=deckColorRef.current||'#FFFFFF';
        let dr=255,dg=255,db=255;
        if(dc.length>=7&&dc[0]==='#'){
          dr=parseInt(dc.slice(1,3),16)|0;
          dg=parseInt(dc.slice(3,5),16)|0;
          db=parseInt(dc.slice(5,7),16)|0;
        }

        // Faint center hairline behind the envelope so silent sections still
        // read as a defined waveform line, not a void.
        ctx.fillStyle='rgba(255,255,255,0.06)';
        ctx.fillRect(0,center,physW,1);

        // ── Pass 2a: smooth filled envelope path at very DIM baseline.
        // This is the silhouette floor only — fills gaps between per-column
        // brightness rects with antialiased diagonals so the overall shape
        // reads continuous. Kept low so the brightness overlay does the
        // visual work; quiet sections should look almost translucent.
        const baseGrad=ctx.createLinearGradient(0,center-maxH,0,center+maxH);
        baseGrad.addColorStop(0,`rgba(${dr},${dg},${db},0.10)`);
        baseGrad.addColorStop(0.5,`rgba(${dr},${dg},${db},0.18)`);
        baseGrad.addColorStop(1,`rgba(${dr},${dg},${db},0.10)`);
        ctx.fillStyle=baseGrad;
        ctx.beginPath();
        ctx.moveTo(0,center);
        for(let dx=0;dx<physW;dx++) ctx.lineTo(dx+0.5,center-heights[dx]);
        ctx.lineTo(physW,center);
        for(let dx=physW-1;dx>=0;dx--) ctx.lineTo(dx+0.5,center+heights[dx]);
        ctx.closePath();
        ctx.fill();

        // ── Pass 2b: per-column brightness overlay. Aggressive dynamic range —
        // gamma 0.55 stretches the curve so peaks dominate (env=0.5 → ~0.69
        // alpha, env=1.0 → ~0.95). Combined with the very dim Pass 2a baseline,
        // quiet sections stay translucent (~0.15 total) while loud drops
        // composite up near 0.98. Per-column 1px rects keep amplitude
        // transitions vertically sharp — kicks/snares pop as crisp edges.
        ctx.fillStyle=`rgb(${dr},${dg},${db})`;
        for(let dx=0;dx<physW;dx++){
          const h=heights[dx];
          if(h<=0) continue;
          const env=envs[dx];
          ctx.globalAlpha=Math.min(1,Math.pow(env,0.55)*0.95);
          ctx.fillRect(dx,center-h,1,h*2+1);
        }
        ctx.globalAlpha=1;

        // ── Pass 2c: centerline weight band. Per-column 1px rect centered on
        // the centerline whose height scales 0..10 css px with amplitude,
        // drawn in a brightened version of the deck color. The "bass weight"
        // — visually obvious thicker pulse under loud drops.
        const cr=Math.min(255,dr+40), cg=Math.min(255,dg+40), cb=Math.min(255,db+40);
        ctx.fillStyle=`rgb(${cr},${cg},${cb})`;
        const bandMaxPx=Math.round(10*dpr);
        for(let dx=0;dx<physW;dx++){
          const env=envs[dx];
          if(env<0.05) continue; // skip near-silence
          const tPx=Math.max(1,Math.min(bandMaxPx,Math.round(env*10*dpr)));
          const tHalf=tPx>>1;
          ctx.globalAlpha=Math.min(1,Math.pow(env,0.5));
          ctx.fillRect(dx,center-tHalf,1,tPx);
        }
        ctx.globalAlpha=1;
      }

      // ── Premium beat grid — three-tier edge markers with downbeat + phrase emphasis.
      // Off-beats: small edge ticks only (no through-line). Downbeats: bigger edge
      // ticks + faint full-height white line. Phrase markers (every 16 beats): largest
      // edge ticks in deck identity color + slightly stronger identity-colored full
      // line. Hidden when BPM analysis hasn't run yet (refs null) or deck empty.
      const beatPhaseFrac=beatPhaseFracRef.current;
      const beatPeriodSec=beatPeriodSecRef.current;
      if(beatPhaseFrac!=null&&beatPeriodSec!=null&&dur2>0){
        const bpmNudge=bpmNudgeRef.current;
        const effectivePeriod=bpmNudge!==0
          ?60/(60/beatPeriodSec+bpmNudge)
          :beatPeriodSec;
        const firstDownbeatSec=beatPhaseFrac*beatPeriodSec+gridOffsetMsRef.current/1000;
        const currentTimeSec=prog2*dur2;
        const pxPerSec=physW/windowSec;
        const halfWinSec=windowSec/2;
        const minTime=currentTimeSec-halfWinSec-effectivePeriod;
        const maxTime=currentTimeSec+halfWinSec+effectivePeriod;
        const startN=Math.ceil((minTime-firstDownbeatSec)/effectivePeriod);
        const endN=Math.floor((Math.min(dur2,maxTime)-firstDownbeatSec)/effectivePeriod);

        // Zoom thinning: if off-beat density would exceed ~50 ticks per 100px,
        // suppress off-beats (downbeats + phrase markers always render).
        const visibleBeats=Math.max(0,endN-startN+1);
        const densityPer100px=(visibleBeats*100)/Math.max(1,physW);
        const showOffBeats=densityPer100px<=50;

        // Tick sizes — fixed CSS-pixel sizes scaled by dpr. Ticks render CENTERED
        // in the top + bottom rails (not flush to canvas edge) so they float with
        // visible breathing room above and below each marker.
        const offTickH=Math.max(1,Math.round(5*dpr));
        const downTickH=Math.max(1,Math.round(12*dpr));
        const phraseTickH=Math.max(1,Math.round(16*dpr));
        const lineW=Math.max(1,Math.round(1*dpr));      // 1px — off-beats + downbeat through-line
        const downTickW=Math.max(1,Math.round(2*dpr));  // 2px — downbeat ticks
        const phraseTickW=Math.max(1,Math.round(2*dpr));// 2px — phrase ticks + phrase through-line

        // Centered Y positions (precomputed; constant per frame). Uses tickRailPad
        // so tick placement stays anchored to the canvas edges even when ampPad
        // grows independently to compress the waveform.
        const offTopY=Math.max(0,Math.floor((tickRailPad-offTickH)/2));
        const offBotY=physH-offTickH-offTopY;
        const downTopY=Math.max(0,Math.floor((tickRailPad-downTickH)/2));
        const downBotY=physH-downTickH-downTopY;
        const phraseTopY=Math.max(0,Math.floor((tickRailPad-phraseTickH)/2));
        const phraseBotY=physH-phraseTickH-phraseTopY;

        // Parse deck identity color once for rgba alpha blends.
        const dc=deckColorRef.current||'#FFFFFF';
        let dr=255,dg=255,db=255;
        if(dc.length>=7&&dc[0]==='#'){
          dr=parseInt(dc.slice(1,3),16)|0;
          dg=parseInt(dc.slice(3,5),16)|0;
          db=parseInt(dc.slice(5,7),16)|0;
        }
        const phraseRGB=`${dr},${dg},${db}`;

        // Pre-build fill styles (avoid string churn in hot loop).
        const OFF_FILL='rgba(255,255,255,0.60)';
        const DOWN_FILL='rgba(255,255,255,1.0)';
        const DOWN_LINE='rgba(255,255,255,0.15)';
        const PHRASE_FILL=`rgba(${phraseRGB},1.0)`;
        const PHRASE_LINE=`rgba(${phraseRGB},0.50)`;

        for(let n=startN;n<=endN;n++){
          const beatTime=firstDownbeatSec+n*effectivePeriod;
          if(beatTime<0) continue; // no grid before t=0 — audio doesn't exist there
          const x=(physW>>1)+(beatTime-currentTimeSec)*pxPerSec;
          if(x<-phraseTickW||x>physW+phraseTickW) continue;
          const isPhrase=(n%16===0);
          const isDownbeat=(n%4===0);

          if(isPhrase){
            // Phrase: full-height 2px identity-color line + 2px×16px centered ticks.
            ctx.fillStyle=PHRASE_LINE;
            ctx.fillRect(Math.floor(x)-(phraseTickW>>1),0,phraseTickW,physH);
            ctx.fillStyle=PHRASE_FILL;
            const px=Math.floor(x-phraseTickW/2);
            ctx.fillRect(px,phraseTopY,phraseTickW,phraseTickH);
            ctx.fillRect(px,phraseBotY,phraseTickW,phraseTickH);
          }else if(isDownbeat){
            // Downbeat: 1px white through-line + 2px×12px centered ticks.
            ctx.fillStyle=DOWN_LINE;
            ctx.fillRect(Math.floor(x),0,lineW,physH);
            ctx.fillStyle=DOWN_FILL;
            const dx=Math.floor(x-downTickW/2);
            ctx.fillRect(dx,downTopY,downTickW,downTickH);
            ctx.fillRect(dx,downBotY,downTickW,downTickH);
          }else if(showOffBeats){
            // Off-beat: 1px×5px centered ticks, no through-line.
            ctx.fillStyle=OFF_FILL;
            ctx.fillRect(Math.floor(x),offTopY,lineW,offTickH);
            ctx.fillRect(Math.floor(x),offBotY,lineW,offTickH);
          }
        }
      }

      // Playhead — FIXED at canvas center (physW/2). It does NOT move with progress;
      // progress is encoded by the waveform scrolling LEFT as the track plays.
      const cx=physW>>1; // physW/2
      ctx.fillStyle='rgba(0,0,0,0.55)';
      ctx.fillRect(cx-3,0,8,physH);
      ctx.fillStyle='#ffffff';
      ctx.shadowColor='#ffffff';
      ctx.shadowBlur=16;
      ctx.fillRect(cx-1,0,3,physH);
      ctx.shadowBlur=0;
    };

    draw();
    return()=>{cancelAnimationFrame(raf.current); ro.disconnect();};
  },[h,windowSec,progRef]);

  const onClick=e=>{
    const canvas=ref.current;
    const b=bandsRef.current;
    if(!seekRef.current||!canvas||!durRef.current||!b?.bass?.length) return;
    const r=canvas.getBoundingClientRect(), W=r.width, clickX=e.clientX-r.left;
    const len=b.bass.length;
    const viewPx=(windowSec/durRef.current)*len;
    const srcX=(progRef?.current??0)*len-viewPx/2;
    seekRef.current(Math.max(0,Math.min(1,(srcX+clickX/W*viewPx)/len)));
  };
  return <canvas ref={ref} onClick={onClick} style={{width:'100%',height:h,background:'#030308',cursor:'crosshair',display:'block'}}/>;
}

// ── Scrolling zoomed waveform (Rekordbox-style) ───────────────
// Playhead fixed at center — waveform scrolls through it.
function ZoomedWF({ bands, peaks, freq, prog, dur, onSeek, h=72, hotCues=[], loopStart=null, loopEnd=null, loopActive=false, windowSec=8 }) {
  const ref=useRef(null);
  useEffect(()=>{
    if(!ref.current)return;
    const canvas=ref.current;
    const dpr=window.devicePixelRatio||1;
    const W=canvas.clientWidth||900, H=h;
    canvas.width=W*dpr; canvas.height=H*dpr;
    const ctx=canvas.getContext("2d");
    ctx.scale(dpr,dpr);
    ctx.clearRect(0,0,W,H);
    const centerX=Math.floor(W/2);

    let bArr=null,mArr=null,hArr=null;
    if(bands&&bands.bass&&bands.bass.length){
      bArr=bands.bass; mArr=bands.mid; hArr=bands.high;
    } else if(peaks&&peaks.length){
      bArr=peaks.map((p,i)=>p*Math.max(0.2,1-(freq?.[i]||0.3)*1.8));
      mArr=peaks.map((p,i)=>p*(0.3+(freq?.[i]||0.3)*0.8));
      hArr=peaks.map((p,i)=>p*Math.min(0.6,(freq?.[i]||0)*1.5));
    }

    if(!bArr||!dur){
      ctx.fillStyle="#ffffff08"; ctx.fillRect(0,H/2-0.5,W,1);
      ctx.fillStyle="#ffffffaa"; ctx.fillRect(centerX-1,0,3,H);
      return;
    }

    const len=bArr.length;
    const samplesPerPx=(windowSec/dur)*len/W;
    const currentSample=prog*len;
    const startSample=currentSample-samplesPerPx*centerX;
    const midY=H/2;

    // ── Leaf-shaped bars (Rekordbox/Serato style) ──
    // Each bar is pointed at top & bottom, widest at center — bezier curves
    const BAR=6, GAP=2, STEP=BAR+GAP;
    const hw=BAR/2; // half-width at widest point

    // Helper: draw a leaf/flame shape centered at (cx, midY), height h above+below
    const leaf=(cx,hTop,hBot,fillStyle)=>{
      if(hTop<0.5&&hBot<0.5)return;
      ctx.fillStyle=fillStyle;
      ctx.beginPath();
      ctx.moveTo(cx, midY-hTop);
      ctx.bezierCurveTo(cx+hw, midY-hTop*0.45, cx+hw, midY-hTop*0.1, cx+hw, midY);
      ctx.bezierCurveTo(cx+hw, midY+hBot*0.1, cx+hw, midY+hBot*0.45, cx, midY+hBot);
      ctx.bezierCurveTo(cx-hw, midY+hBot*0.45, cx-hw, midY+hBot*0.1, cx-hw, midY);
      ctx.bezierCurveTo(cx-hw, midY-hTop*0.1, cx-hw, midY-hTop*0.45, cx, midY-hTop);
      ctx.closePath();
      ctx.fill();
    };

    for(let x=0;x<W;x+=STEP){
      const cx=x+hw;
      // Sample averaging across bar range
      const s0=startSample+x*samplesPerPx;
      const s1=startSample+(x+STEP)*samplesPerPx;
      const i0=Math.max(0,Math.floor(s0)), i1=Math.min(len-1,Math.ceil(s1));
      if(i0>=len)continue;
      let bv=0,mv=0,hv=0,cnt=0;
      if(samplesPerPx<1){
        // Interpolate for sub-sample zoom
        const fi=s0+samplesPerPx*hw;
        const lo=Math.max(0,Math.floor(fi)), hi2=Math.min(len-1,lo+1);
        const t=fi-lo;
        bv=(bArr[lo]||0)*(1-t)+(bArr[hi2]||0)*t;
        mv=(mArr?mArr[lo]||0:0)*(1-t)+(mArr?mArr[hi2]||0:0)*t;
        hv=(hArr?hArr[lo]||0:0)*(1-t)+(hArr?hArr[hi2]||0:0)*t;
        cnt=1;
      } else {
        for(let k=i0;k<=i1;k++){bv+=bArr[k]||0;mv+=mArr?mArr[k]||0:0;hv+=hArr?hArr[k]||0:0;cnt++;}
        if(cnt>0){bv/=cnt;mv/=cnt;hv/=cnt;}
      }

      // Strong gamma for punchy transients
      const rawAmp=bv*0.52+mv*0.34+hv*0.14;
      const amp=Math.pow(rawAmp, 0.32);
      const maxH=midY-3;
      const totalH=Math.max(2, amp*maxH);

      // Color zones: orange body (full envelope), blue inner bass, white tips
      // Proportional band heights
      const bw2=bv*2.5, mw2=mv*1.6, hw2=hv*0.9;
      const sum2=bw2+mw2+hw2||1;
      const bassH=Math.max(0,(bw2/sum2)*totalH);
      const midH_=Math.max(0,(mw2/sum2)*totalH);
      const highH=Math.max(0,(hw2/sum2)*totalH);

      const played=x<centerX;

      // Layer 1: orange/amber outer envelope (mids + highs define the shape)
      leaf(cx, totalH, totalH, played?'#ffb833':'#7d5010');

      // Layer 2: blue bass core (inner diamond overlaid)
      if(bassH>1.5){
        leaf(cx, bassH, bassH, played?'#44aaff':'#1a4d99');
      }

      // Layer 3: bright white tip flash (high freq energy at very tips)
      if(highH>1){
        const tipH=Math.min(highH*0.7, 6);
        leaf(cx, tipH, tipH, played?'rgba(255,255,255,0.92)':'rgba(200,220,255,0.35)');
      }
    }

    // ── Center line ──
    ctx.fillStyle='#ffffff1a'; ctx.fillRect(0,midY-0.5,W,1);

    // ── Loop region ──
    if(loopStart!==null&&loopEnd!==null){
      const lx1=Math.floor(((loopStart*len)-startSample)/samplesPerPx);
      const lx2=Math.floor(((loopEnd*len)-startSample)/samplesPerPx);
      if(lx2>0&&lx1<W){
        ctx.fillStyle=loopActive?"rgba(200,169,110,0.2)":"rgba(200,169,110,0.08)";
        ctx.fillRect(Math.max(0,lx1),0,Math.min(W,lx2)-Math.max(0,lx1),H);
        ctx.fillStyle=loopActive?"#C8A96Ecc":"#C8A96E66";
        if(lx1>=0&&lx1<W)ctx.fillRect(lx1,0,2,H);
        if(lx2>=0&&lx2<W)ctx.fillRect(lx2-1,0,2,H);
      }
    }

    // ── Hot cue markers ──
    const CUE_CLR=["#C8A96E","#ef4444","#22c55e","#f59e0b"];
    hotCues.forEach((cue,ci)=>{
      if(cue===null)return;
      const cxm=Math.floor(((cue*len)-startSample)/samplesPerPx);
      if(cxm<-6||cxm>W+6)return;
      ctx.fillStyle=CUE_CLR[ci]; ctx.shadowColor=CUE_CLR[ci]; ctx.shadowBlur=8;
      ctx.fillRect(cxm,0,2,H); ctx.shadowBlur=0;
      if(cxm>4&&cxm<W-4){ctx.beginPath();ctx.moveTo(cxm-4,0);ctx.lineTo(cxm+5,0);ctx.lineTo(cxm+1,9);ctx.fillStyle=CUE_CLR[ci];ctx.fill();}
    });

    // ── Fixed playhead — shadow + bright white ──
    ctx.fillStyle='rgba(0,0,0,0.45)'; ctx.fillRect(centerX-2,0,7,H);
    ctx.fillStyle='#ffffff'; ctx.shadowColor='#ffffff'; ctx.shadowBlur=20;
    ctx.fillRect(centerX,0,3,H); ctx.shadowBlur=0;

  },[bands,peaks,freq,prog,dur,hotCues,loopStart,loopEnd,loopActive,windowSec]);

  const onClick=e=>{
    if(!onSeek||!ref.current||!dur)return;
    const r=ref.current.getBoundingClientRect();
    const W=r.width, clickX=e.clientX-r.left;
    const len=(bands?.bass?.length||peaks?.length||1);
    const samplesPerPx=(windowSec/dur)*len/W;
    const startSample=prog*len-samplesPerPx*(W/2);
    const clickSample=startSample+clickX*samplesPerPx;
    onSeek(Math.max(0,Math.min(1,clickSample/len)));
  };

  return <canvas ref={ref} onClick={onClick} style={{width:"100%",height:h,background:"#030306",cursor:onSeek?"crosshair":"default",display:"block"}}/>;
}

function BeatGrid({ bpm, dur, prog, color, beatPhaseFrac=null }) {
  const ref=useRef(null);
  useEffect(()=>{
    if(!ref.current||!bpm||!dur)return;
    const c=ref.current,ctx=c.getContext("2d"),W=c.width,H=c.height;
    ctx.clearRect(0,0,W,H);
    const spb=60/bpm;
    // beatPhaseFrac: how many beats from track start to first detected kick
    // e.g. 2.07 means the first kick lands 2.07 beat-lengths into the track
    // We start the grid at the fractional remainder so it aligns with real kicks
    const phFrac = beatPhaseFrac !== null ? beatPhaseFrac : 0;
    const firstBeatSec = (phFrac % 1) * spb;  // offset of first beat within its beat period
    const barOffset = Math.round(phFrac) % 4;  // which beat-in-bar the first beat lands on
    // Scrolling grid: playhead is locked at canvas center, beats slide past it.
    // Show a fixed window of `beatsVisible` beats around the current time so the
    // grid scale stays consistent regardless of track length.
    const beatsVisible = 16;
    const pxPerSec = W / (beatsVisible * spb);
    const ct = prog * dur;                    // current time in seconds
    const halfWinSec = (beatsVisible * spb) / 2;
    const minTime = ct - halfWinSec - spb;    // pad by a beat to cover edges
    const maxTime = ct + halfWinSec + spb;
    // Beat n lives at time firstBeatSec + n*spb; find the visible range.
    const startN = Math.max(0, Math.ceil((minTime - firstBeatSec) / spb));
    const endN = Math.floor((Math.min(dur, maxTime) - firstBeatSec) / spb);
    for(let bn = startN; bn <= endN; bn++){
      const bt = firstBeatSec + bn * spb;
      const x = W/2 + (bt - ct) * pxPerSec;
      if(x < 0 || x > W) continue;
      const isBar = ((bn - barOffset + 400) % 4 === 0);
      ctx.strokeStyle = isBar ? color+"88" : color+"28";
      ctx.lineWidth = isBar ? 1.5 : 0.5;
      ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke();
    }
    // Fixed playhead at center
    const px = Math.floor(W/2);
    ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.arc(px,H/2,3,0,Math.PI*2); ctx.fill();
    ctx.shadowBlur = 0;
  },[bpm,dur,prog,color,beatPhaseFrac]);
  return <canvas ref={ref} width={460} height={18} style={{width:"100%",height:18,background:"#04040b",borderRadius:4}}/>;
}

function Knob({ v, set, min=-12, max=12, ctr=0, label, color="#C8A96E", size=38, off }) {
  const dr=useRef(false),sy=useRef(0),sv=useRef(0); const pct=(v-min)/(max-min);
  const md=(e)=>{ if(off)return; e.preventDefault();dr.current=true;sy.current=e.clientY;sv.current=v; const mm=(ev)=>{if(dr.current)set(Math.max(min,Math.min(max,sv.current+(sy.current-ev.clientY)/100*(max-min))));};const mu=()=>{dr.current=false;window.removeEventListener("mousemove",mm);window.removeEventListener("mouseup",mu);};window.addEventListener("mousemove",mm);window.addEventListener("mouseup",mu); };
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2,userSelect:"none",opacity:off?.35:1}}>
      <div onMouseDown={md} onDoubleClick={()=>!off&&set(ctr)} style={{width:size,height:size,borderRadius:"50%",background:"#0a0a1c",border:`2px solid ${color}33`,cursor:off?"default":"ns-resize",position:"relative",boxShadow:v!==ctr?`0 0 8px ${color}22`:"none"}}>
        <div style={{position:"absolute",width:3,height:3,borderRadius:"50%",background:color,top:"50%",left:"50%",transform:`translate(-50%,-50%) rotate(${-135+pct*270}deg) translateY(-${size*.26}px)`}}/>
      </div>
      <span style={{fontSize:7,color:"#888898",fontFamily:"'DM Mono',monospace",letterSpacing:.5}}>{label}</span>
    </div>
  );
}

// ── Deck ─────────────────────────────────────────────────────
const HOT_CUE_COLORS=["#C8A96E","#ef4444","#22c55e","#f59e0b"];

function Deck({ id, ch, ctx:ac, color, local, remote, onChange, midi:mt, bpmResult, bpmAnalyze, eqHi=0, eqMid=0, eqLo=0, chanVol=1, loadFromLibrary=null, onTrackInfo=null, onSync=null, syncReady=true, syncRole=null, isMaster=false, onMasterToggle=null, onLibraryTrackDrop=null, onProgUpdate=null, onWaveform=null, onSeekReady=null, remoteSeek=null, onToggleReady=null, onCueReady=null, remoteToggle=null, remoteCue=null, onTransportFire=null, isDriver=true }) {
  const [buf,setBuf]=useState(null),[name,setName]=useState(null),[play,setPlay]=useState(false);
  const [prog,setProg]=useState(0),[dur,setDur]=useState(0);
  const progRef=useRef(0); // mirror of prog for parent AnimatedZoomedWF without 60fps setState
  const [hi,setHi]=useState(0),[mid,setMid]=useState(0),[lo,setLo]=useState(0),[vol,setVol]=useState(1);
  const [rate,setRate]=useState(1); // FIX: track actual playback rate
  const [dragOver,setDragOver]=useState(false);
  const [wfPeaks,setWfPeaks]=useState(null),[wfFreq,setWfFreq]=useState(null);
  const [wfBass,setWfBass]=useState(null),[wfMid,setWfMid]=useState(null),[wfHigh,setWfHigh]=useState(null);
  // Hot cues + loop
  const [deckKey,setDeckKey]=useState(null);
  const [trackArtist,setTrackArtist]=useState(null);
  const [hotCues,setHotCues]=useState([null,null,null,null]);
  const [loopActive,setLoopActive]=useState(false);
  const [loopStart,setLoopStart]=useState(null);
  const [loopEnd,setLoopEnd]=useState(null);
  const loopRef=useRef({active:false,start:null,end:null});
  const src=useRef(null),st=useRef(0),off=useRef(0),raf=useRef(null),fr=useRef(null);
  // EQ is now passed as props: eqHi, eqMid, eqLo, chanVol
  const remProgRef=useRef(0),remTimeRef=useRef(0),remRateRef=useRef(0),remRaf=useRef(null);
  const lastProgBroadcastRef=useRef(0);

  // Keep loop ref in sync with state
  useEffect(()=>{loopRef.current={active:loopActive,start:loopStart,end:loopEnd};},[loopActive,loopStart,loopEnd]);
  // Apply loop changes to active AudioBufferSourceNode
  useEffect(()=>{
    if(!src.current||!buf)return;
    src.current.loop=loopActive;
    if(loopActive&&loopStart!==null){
      src.current.loopStart=loopStart*buf.duration;
      src.current.loopEnd=(loopEnd??1)*buf.duration;
    }
  },[loopActive,loopStart,loopEnd,buf]);

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

  // Mirror remote state + smooth interpolation for playhead.
  // Shared-decks (Option C): mirror whenever there's no LOCAL audio loaded —
  // partner's actions paint our visual until we load a track ourselves, then
  // local state takes over. Last-write-wins.
  useEffect(()=>{
    if(!remote||buf)return;
    const wasPlaying=play; const nowPlaying=remote.playing||false;
    setPlay(nowPlaying);
    // EQ values now come from parent props when remote is true
    if(remote.trackName)setName(remote.trackName);
    if(remote.duration)setDur(remote.duration);
    if(remote.waveformPeaks)setWfPeaks(remote.waveformPeaks);
    if(remote.waveformFreq)setWfFreq(remote.waveformFreq);
    if(remote.waveformBass)setWfBass(remote.waveformBass);
    if(remote.waveformMid)setWfMid(remote.waveformMid);
    if(remote.waveformHigh)setWfHigh(remote.waveformHigh);
    // Update interpolation refs when we get a new progress value
    if(remote.progress!=null){
      const now=performance.now();
      // Compute rate from track duration, not from packet arrivals.
      // Packets arrive with variable network latency (2-200ms inter-arrival),
      // making packet-derived rate too noisy. Using duration: rate = 1 / duration_in_ms
      // gives a perfectly stable rate equal to real-time playback.
      const trackDurSec=remote.duration||dur;
      if(trackDurSec&&trackDurSec>0){
        remRateRef.current=nowPlaying?(1/(trackDurSec*1000)):0;
      }
      // Compute where our current interp would be RIGHT NOW
      const elapsed=remTimeRef.current?(now-remTimeRef.current):0;
      const currentInterp=remProgRef.current!=null
        ?remProgRef.current+(remRateRef.current||0)*elapsed
        :remote.progress;
      const drift=remote.progress-currentInterp;
      // First packet ever, or huge drift (e.g., scrub/seek): hard snap
      const SNAP_THRESHOLD=0.005; // 0.5% of track = ~1.8s on a 6min track
      if(remProgRef.current==null||Math.abs(drift)>SNAP_THRESHOLD){
        // Hard snap — first time, or major position change (seek/scrub on B1)
        remProgRef.current=remote.progress;
        remTimeRef.current=now;
      } else if(drift>0){
        // Truth is slightly ahead — accept the correction (B2 was running slow)
        remProgRef.current=remote.progress;
        remTimeRef.current=now;
      }
      // Else: drift is small AND backward (B2 is slightly ahead of truth).
      // Don't update — let the duration-based rate keep running. The next packet
      // that catches up to current interp will resync. This eliminates the
      // freeze-on-correction by letting B2 coast forward at the correct rate
      // until truth catches up.
      // DO NOT setProg here — the RAF interp loop below reads the refs and
      // computes the visible position smoothly.
    }
    // Start/stop smooth interpolation RAF
    cancelAnimationFrame(remRaf.current);
    if(nowPlaying){
      const animate=()=>{
        const elapsed=performance.now()-remTimeRef.current;
        const interp=Math.min(1,Math.max(0,remProgRef.current+remRateRef.current*elapsed));
        setProg(interp); progRef.current=interp; onProgUpdate?.(interp);
        remRaf.current=requestAnimationFrame(animate);
      };
      remRaf.current=requestAnimationFrame(animate);
    }
    return()=>cancelAnimationFrame(remRaf.current);
  },[remote,local,buf]);

  // MIDI routing — EQ now handled by parent component when local
  const sfx=`DECK_${id}`;
  useEffect(()=>{ if(!mt||!local)return; const{actionKey:ak,value:v}=mt; if(ak===`${sfx}_PLAY`&&v===true)toggle(); if(ak===`${sfx}_CUE`&&v===true)cue(); },[mt]);

  const stop_=()=>{ if(src.current){src.current.onended=null;try{src.current.stop();}catch{}src.current.disconnect();src.current=null;}cancelAnimationFrame(raf.current); };

  const play_=(o)=>{ if(!buf||!ch||!ac)return; stop_(); if(ac.state==="suspended")ac.resume();
    const s=ac.createBufferSource(); s.buffer=buf; s.playbackRate.value=rate; s.connect(ch.trim);
    const lr=loopRef.current;
    if(lr.active&&lr.start!==null){s.loop=true;s.loopStart=lr.start*buf.duration;s.loopEnd=(lr.end??1)*buf.duration;}
    s.start(0,o);
    s.onended=()=>{if(!loopRef.current.active){setPlay(false);setProg(0);off.current=0;onChange?.("playing",false);}};
    src.current=s; st.current=ac.currentTime; off.current=o;
    const tick=()=>{
      const elapsed=ac.currentTime-st.current;
      const lr2=loopRef.current;
      let p;
      if(lr2.active&&lr2.start!==null&&lr2.end!==null){
        const lDur=(lr2.end-lr2.start)*buf.duration;
        const pos=(o-lr2.start*buf.duration+elapsed);
        p=lr2.start+(pos%lDur)/buf.duration;
      } else {
        p=Math.min(1,(o+elapsed)/buf.duration);
      }
      setProg(p); progRef.current=p; onProgUpdate?.(p);
      // Throttle progress broadcasts to 10Hz to reduce network jitter on partner side
      const nowMs=performance.now();
      if(nowMs-lastProgBroadcastRef.current>=100){
        onChange?.("progress",p);
        lastProgBroadcastRef.current=nowMs;
      }
      if(elapsed<buf.duration||lr2.active) raf.current=requestAnimationFrame(tick);
    }; tick(); };

  const toggle=useCallback((fromRemote=false)=>{
    // Driver model: only the driver mutates audio + broadcasts the new state.
    // Non-driver click → send toggle_request to driver (one-way), do nothing
    // locally. Non-driver receive of toggle_request → ignore (not addressed
    // to me). Driver receive of toggle_request → execute as if local click,
    // suppressing the outgoing request (it was sent BY the asker, not us).
    if (!isDriver) {
      if (!fromRemote) onTransportFire?.({ type:"toggle_request", deckId:id });
      return;
    }
    // Driver path: toggle locally + broadcast via dh→deck_update. The
    // deck_update IS the state sync — no toggle_request needed from the driver.
    if(!buf){
      // Driver with no buf shouldn't happen (loader-is-driver), but defensively
      // flip local play state so UI doesn't lock.
      if(!fromRemote) setPlay(p=>!p);
      return;
    }
    if(play){
      off.current=Math.min(buf.duration,off.current+(ac.currentTime-st.current));
      stop_();setPlay(false);onChange?.("playing",false);
      logEvent("deck", "play_toggled", { deck: id, isPlaying: false });
    } else {
      play_(off.current);setPlay(true);onChange?.("playing",true);
      logEvent("deck", "play_toggled", { deck: id, isPlaying: true });
    }
  },[buf,play,ac,rate,id,onTransportFire,isDriver]);
  const seek  =useCallback((p, fromRemote=false)=>{
    // Clamp to [0, 1] — guards against unclamped callers (small WF onClick,
    // network seek_request) feeding negative or >1 fractions. Without this,
    // negative p stores a negative off.current that crashes the next play_()
    // with "AudioBufferSourceNode.start: offset less than minimum bound (0)".
    const pc=Math.max(0,Math.min(1,p));
    // Driver model gate (same shape as toggle).
    if (!isDriver) {
      if (!fromRemote) onTransportFire?.({ type:"seek_request", deckId:id, value:pc });
      return;
    }
    const o=pc*(buf?.duration||0);off.current=o;if(play)play_(o);else{setProg(pc);progRef.current=pc;onProgUpdate?.(pc);}onChange?.("progress",pc);
  },[buf,play,rate,id,onTransportFire,isDriver]);
  const cue   =useCallback((fromRemote=false)=>{
    // Driver model gate (same shape as toggle).
    if (!isDriver) {
      if (!fromRemote) onTransportFire?.({ type:"cue_request", deckId:id });
      return;
    }
    off.current=0;setProg(0);progRef.current=0;onProgUpdate?.(0);
    if(play){stop_();setPlay(false);onChange?.("playing",false);}
    onChange?.("progress",0);
  },[play,id,onTransportFire,isDriver]);
  // Driver handoff — when partner takes over this deck (isDriver transitions
  // true→false), stop local audio and clear local track state so the display
  // falls back to remote.* (partner's track info via deck_update). Without
  // this, stale local buf + name would shadow remote and the visual would
  // show the OLD track even after partner loaded a new one.
  const prevIsDriverRef = useRef(undefined);
  useEffect(() => {
    const wasDriver = prevIsDriverRef.current;
    prevIsDriverRef.current = isDriver;
    if (wasDriver === true && isDriver === false) {
      stop_();
      setPlay(false);
      setBuf(null);
      setName(null);
      setTrackArtist(null);
      setDur(0);
      setDeckKey(null);
      setProg(0);
      off.current = 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDriver]);

  useEffect(()=>{onSeekReady?.(seek);},[seek,onSeekReady]);
  useEffect(()=>{onToggleReady?.(toggle);},[toggle,onToggleReady]);
  useEffect(()=>{onCueReady?.(cue);},[cue,onCueReady]);
  useEffect(()=>{ if(bpmResult?.bpm!=null) onChange?.("bpm", bpmResult.bpm); },[bpmResult?.bpm,onChange]);
  // Broadcast phase data so partner can phase-align when SYNC fires against a
  // partner-driven deck. Only the deck owner has these from the analyzer; the
  // mirror lets the syncing side compute beat offsets across browsers.
  useEffect(()=>{ if(bpmResult?.beatPhaseSec!=null) onChange?.("beatPhaseSec", bpmResult.beatPhaseSec); },[bpmResult?.beatPhaseSec,onChange]);
  useEffect(()=>{ if(bpmResult?.beatPeriodSec!=null) onChange?.("beatPeriodSec", bpmResult.beatPeriodSec); },[bpmResult?.beatPeriodSec,onChange]);
  // Mirror remote `playing` state for Deck B button glyph.
  // Driver-aware: when partner drives this deck, show their play state from
  // remote.playing (mirrored via deck_update). When I drive, show my local
  // `play`. Old `local` flag is true for both decks now (shared decks); the
  // isDriver check replaces it as the source-of-truth gate.
  const remotePlaying=remote?.playing||false;
  const playVisual=isDriver?play:remotePlaying;
  const enabled=local||!!remoteToggle;
  const cueEnabled=local||!!remoteCue;

  // Load a file, optionally with library track metadata
  const load=async(f, trackMeta=null)=>{
    const ab=await f.arrayBuffer();
    const d=await ac.decodeAudioData(ab);
    stop_();setPlay(false);setProg(0);off.current=0;
    // Reset rate to 1 — old sync-imposed rate from a prior track would scale
    // the new track's BPM display incorrectly. Parent's rateA/B mirror via dh.
    setRate(1);onChange?.("rate",1);
    setBuf(d);setDur(d.duration);onChange?.("duration",d.duration);
    const n=(trackMeta?.title)||f.name.replace(/\.[^.]+$/,"");
    setName(n);onChange?.("trackName",n);
    setTrackArtist(trackMeta?.artist||null);
    onChange?.("artist", trackMeta?.artist || null);
    onChange?.("key", trackMeta?.key || null);
    // Extract key from metadata or ID3
    setDeckKey(trackMeta?.key||null);
    // Reset hot cues + loop on new track load
    setHotCues([null,null,null,null]);
    setLoopActive(false);setLoopStart(null);setLoopEnd(null);
    loopRef.current={active:false,start:null,end:null};
    bpmAnalyze?.(d, id);
    // If from library, report track info for recommendations
    if(trackMeta) onTrackInfo?.(id, trackMeta);
    else onTrackInfo?.(id, null);
    // Compute 3-band waveform (Rekordbox-style: bass/mid/high) via IIR filters.
    // 48000 frames → ~4ms resolution per WF sample on a 3-min track, enough for
    // individual transients to land on a single display column even at 4s zoom.
    const WF_W=24000;
    const sr=d.sampleRate;
    // One-pole IIR lowpass coefficients: bass<300Hz, bass+mid<3500Hz
    const aB=Math.exp(-2*Math.PI*300/sr);
    const aM=Math.exp(-2*Math.PI*3500/sr);
    const bassArr=new Float32Array(WF_W);
    const midArr=new Float32Array(WF_W);
    const highArr=new Float32Array(WF_W);
    // Float step — flooring here quantized away the tail ~0.25% of coverage at
    // 44.1 kHz (step=165 → bands cover 179.6 s of a 180 s track). That made the
    // effective bands frame-rate (sr/step) exceed the renderer's assumed rate
    // (WF_W/dur), so the waveform drifted visually from the grid by ~200 ms
    // mid-track on a 3-min track. Float step makes each band frame cover
    // exactly dur/WF_W seconds, so renderer's math (len/dur frames/sec) is
    // dead-on. Math.floor(i/step) still returns integer indices.
    const step=Math.max(1,d.length/WF_W);
    for(let ch=0;ch<d.numberOfChannels;ch++){
      const data=d.getChannelData(ch);
      let lpB=0,lpM=0;
      for(let i=0;i<d.length;i++){
        const s=data[i];
        lpB=aB*lpB+(1-aB)*s;   // low-pass → bass only (<300Hz)
        lpM=aM*lpM+(1-aM)*s;   // low-pass → bass+mid (<3500Hz)
        const x=Math.min(WF_W-1,Math.floor(i/step));
        const bv=Math.abs(lpB);
        const mv=Math.abs(lpM-lpB);  // band: 300-3500Hz
        const hv=Math.abs(s-lpM);    // band: >3500Hz
        if(bv>bassArr[x])bassArr[x]=bv;
        if(mv>midArr[x])midArr[x]=mv;
        if(hv>highArr[x])highArr[x]=hv;
      }
    }
    // Normalize each band independently to 0-1
    const normBand=(arr)=>{let mx=0;for(let i=0;i<arr.length;i++)mx=Math.max(mx,arr[i]);if(mx<0.0001)return new Array(arr.length).fill(0);const out=new Array(arr.length);for(let i=0;i<arr.length;i++)out[i]=Math.round(arr[i]/mx*1000)/1000;return out;};
    const bN=normBand(bassArr),mN=normBand(midArr),hN=normBand(highArr);
    setWfBass(bN);setWfMid(mN);setWfHigh(hN);
    // Broadcast at WF_W samples per band (24,000 → ~400KB total per track load).
    // Original 48,000-sample resolution caused ~800KB and WebSocket backpressure
    // that blocked progress packets for tens of seconds.
    onChange?.("waveformBass",bN);onChange?.("waveformMid",mN);onChange?.("waveformHigh",hN);
    onWaveform?.({bass:bN,mid:mN,high:hN,dur:d.duration,name:n});
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

  const D="#0c0c14", BD="1px solid #1e1e28";
  return (
    <div style={{background:D, border:`1px solid ${play?color+"44":"#1e1e28"}`, borderRadius:10, overflow:"hidden", display:"flex", flexDirection:"column", boxShadow:play?`0 0 24px ${color}14`:`0 2px 12px rgba(0,0,0,.5)`, transition:"all .3s"}}>

      {/* ── HEADER: badge | track | bpm ── */}
      <div style={{display:"flex", alignItems:"stretch", minHeight:54, borderBottom:BD}}>
        <div style={{width:52, flexShrink:0, background:`linear-gradient(180deg,${color}12,${color}06)`, borderRight:`1px solid ${color}22`, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:4}}>
          <span style={{fontFamily:"'DM Mono',monospace", fontWeight:500, fontSize:24, color, lineHeight:1, letterSpacing:-1}}>{id}</span>
          <span style={{fontSize:7, color:color+"88", fontFamily:"'DM Mono',monospace", fontWeight:500, letterSpacing:2}}>{local?"YOU":"PRTNR"}</span>
          {play&&<div style={{width:4,height:4,borderRadius:"50%",background:color,boxShadow:`0 0 8px ${color}`,animation:"blink 1s infinite"}}/>}
        </div>

        <div onClick={()=>fr.current?.click()}
          onDragOver={e=>{e.preventDefault();e.stopPropagation();setDragOver(true);}}
          onDragLeave={()=>setDragOver(false)}
          onDrop={e=>{e.preventDefault();e.stopPropagation();setDragOver(false);const f=e.dataTransfer.files[0];if(f&&f.type.startsWith("audio/")){load(f);return;}try{const d=JSON.parse(e.dataTransfer.getData("application/json"));if(d?.trackId&&onLibraryTrackDrop)onLibraryTrackDrop(d.trackId);}catch{}}}
          style={{flex:1, padding: buf ? "0 14px" : "6px 10px", cursor:"pointer", display:"flex", flexDirection:"column", justifyContent:"center", background:dragOver?color+"08":"transparent", transition:"background .12s", minWidth:0}}>
          {(buf||remote?.trackName)?(
            <>
              <div style={{fontSize:13, fontWeight:500, color:"#d8d8e2", fontFamily:"'DM Sans',sans-serif", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{name||remote?.trackName||"—"}</div>
              <div style={{fontSize:9, color:"#888898", fontFamily:"'DM Mono',monospace", marginTop:3, letterSpacing:.3}}>{buf?`${fmt(dur)} · ${trackArtist||`${(buf.sampleRate/1000).toFixed(1)}kHz · ${buf.numberOfChannels===2?"STEREO":"MONO"}`}`:`${fmt(remote?.duration||0)} · ${remote?.artist||"—"}`}</div>
            </>
          ):(
            <div style={{
              display:"flex", alignItems:"center", gap:12, padding:"8px 12px",
              border:`1.5px dashed ${dragOver?color:color+"44"}`,
              borderRadius:8,
              background: dragOver ? color+"10" : "transparent",
              transition:"all .12s",
            }}>
              <div style={{
                width:36, height:36, borderRadius:"50%",
                border:`1.5px solid ${dragOver?color:color+"66"}`,
                display:"flex", alignItems:"center", justifyContent:"center",
                color:dragOver?color:color+"cc",
                fontSize:22, fontWeight:300, flexShrink:0,
                background: dragOver ? color+"22" : "transparent",
              }}>+</div>
              <div>
                <div style={{fontSize:12, fontWeight:600, color:dragOver?color:color+"dd", fontFamily:"'DM Mono',monospace", letterSpacing:1.5}}>{dragOver?"DROP HERE":"LOAD TRACK"}</div>
                <div style={{fontSize:9, color:"#555562", marginTop:2, fontFamily:"'DM Mono',monospace", letterSpacing:.5}}>click or drag · mp3 wav flac aac</div>
              </div>
            </div>
          )}
        </div>
        <input ref={fr} type="file" accept="audio/*" style={{display:"none"}} onChange={e=>{ const f=e.target.files[0]; e.target.value=""; if(f) load(f); }}/>

        {/* KEY display */}
        {(()=>{const effectiveKey=deckKey||remote?.key;const ck=effectiveKey?CAMELOT[effectiveKey]:null;const km=ck?.endsWith("A");return ck?(
          <div style={{flexShrink:0,padding:"0 10px",borderLeft:BD,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:2,minWidth:52}}>
            <div style={{fontSize:11,fontFamily:"'DM Mono',monospace",fontWeight:500,color:km?"#9B7EC8":color,background:(km?"#9B7EC8":color)+"18",borderRadius:4,padding:"2px 6px",letterSpacing:.5}}>{ck}</div>
            <div style={{fontSize:7,color:"#888898",fontFamily:"'DM Mono',monospace",letterSpacing:1}}>{effectiveKey}</div>
          </div>
        ):null;})()}
        <div style={{flexShrink:0, padding:"0 14px", borderLeft:BD, display:"flex", flexDirection:"column", alignItems:"flex-end", justifyContent:"center", gap:4, minWidth:96}}>
          {bpmResult?.analyzing&&<div style={{fontSize:7,color:"#f59e0b",fontFamily:"'DM Mono',monospace",animation:"pulse .8s infinite"}}>ANA...</div>}
          <div style={{textAlign:"right"}}>
            {(()=>{
              const effectiveBpm = bpmResult?.bpm ?? remote?.bpm;
              const rateApplies  = !!bpmResult?.bpm; // local rate only scales when WE'RE driving the deck
              const adjustedBpm  = effectiveBpm ? effectiveBpm * (rateApplies ? rate : 1) : null;
              const pctOff       = rateApplies && Math.abs(rate - 1) > 0.001 ? (rate - 1) * 100 : null;
              const pctColor     = pctOff === null ? null
                : Math.abs(pctOff) > 10 ? "#ef4444"
                : Math.abs(pctOff) > 6  ? "#f59e0b"
                : "#888898";
              return (
                <div style={{display:"flex", alignItems:"baseline", gap:6, justifyContent:"flex-end"}}>
                  <div title={effectiveBpm?`Natural BPM ${effectiveBpm.toFixed(1)}${pctOff!==null?` · pitch ${pctOff>0?"+":""}${pctOff.toFixed(1)}%`:""}`:undefined} style={{fontSize:32, fontFamily:"'DM Mono',monospace", fontWeight:600, color:effectiveBpm?"#C8A96E":"#2a2a3a", lineHeight:0.95, letterSpacing:-0.5, textShadow:effectiveBpm?"0 0 18px #C8A96E22":"none"}}>{adjustedBpm!=null?adjustedBpm.toFixed(1):"—"}</div>
                  {pctOff !== null && (
                    <div title={`Track natural BPM ${effectiveBpm.toFixed(1)} pitch-adjusted ${pctOff>0?"+":""}${pctOff.toFixed(1)}%`} style={{fontSize:9, fontFamily:"'DM Mono',monospace", color:pctColor, letterSpacing:.3}}>
                      {pctOff>0?"+":""}{pctOff.toFixed(1)}%
                    </div>
                  )}
                </div>
              );
            })()}
            <div style={{fontSize:7, color:"#888898", fontFamily:"'DM Mono',monospace", letterSpacing:2.5, marginTop:2}}>BPM</div>
          </div>
          <VU an={ch?.an} color={color}/>
        </div>
      </div>

      {/* ── OVERVIEW STRIP — full track structure ── */}
      <div style={{borderTop:BD, borderBottom:BD, background:"#03030a"}}>
        <WF bands={wfBass?{bass:wfBass,mid:wfMid,high:wfHigh}:null} peaks={wfPeaks} freq={wfFreq} prog={prog} onSeek={local?seek:remoteSeek} h={40} hotCues={hotCues} loopStart={loopStart} loopEnd={loopEnd} loopActive={loopActive} bpm={bpmResult?.bpm?(bpmResult.bpm*rate):null} dur={dur} beatPhaseFrac={bpmResult?.beatPhaseFrac??null} color={color}/>
      </div>

      {/* ── HOT CUES + LOOP CONTROLS ── */}
      <div style={{display:"flex",gap:3,padding:"5px 10px",background:"#08080e",borderBottom:"1px solid #141420",alignItems:"center"}}>
          {/* Hot cue buttons 1-4 */}
          {HOT_CUE_COLORS.map((c,i)=>(
            <button key={i}
              onClick={()=>{if(!buf)return;if(hotCues[i]!==null){seek(hotCues[i]);}else{setHotCues(p=>{const n=[...p];n[i]=prog;return n;});}}}
              onContextMenu={e=>{e.preventDefault();if(buf)setHotCues(p=>{const n=[...p];n[i]=null;return n;});}}
              title={hotCues[i]!==null?"Click:recall  Right-click:clear":"Click to set cue"}
              style={{width:36,height:28,background:hotCues[i]!==null?`${c}30`:"#0e0e18",border:`1px solid ${hotCues[i]!==null?c+"88":c+"33"}`,color:hotCues[i]!==null?c:c+"66",borderRadius:5,cursor:"pointer",fontFamily:"'DM Mono',monospace",fontSize:11,fontWeight:700,transition:"all .1s",flexShrink:0,boxShadow:hotCues[i]!==null?`0 0 6px ${c}44`:"none"}}>
              {i+1}
            </button>
          ))}
          <div style={{width:1,height:22,background:"#252535",margin:"0 3px",flexShrink:0}}/>
          {/* Beat loop buttons: 1, 2, 4, 8, 16 beats */}
          {[[1,"1"],[2,"2"],[4,"4"],[8,"8"],[16,"16"]].map(([beats,label])=>(
            <button key={beats}
              onClick={()=>{
                if(!buf)return;
                const bps=(bpmResult?.bpm||120)/60;
                const lDur=beats/bps;
                const lStart=prog;
                const lEnd=Math.min(1,lStart+lDur/(buf?.duration||1));
                setLoopStart(lStart);setLoopEnd(lEnd);setLoopActive(true);
              }}
              style={{height:28,padding:"0 8px",background:"#0e0e18",border:"1px solid #C8A96E33",color:"#C8A96E88",borderRadius:4,cursor:"pointer",fontFamily:"'DM Mono',monospace",fontSize:10,fontWeight:600,letterSpacing:.3,flexShrink:0}}>
              {label}
            </button>
          ))}
          {/* Loop active toggle */}
          {loopStart!==null&&(
            <button
              onClick={()=>{
                const nv=!loopActive;
                setLoopActive(nv);
                if(!nv&&src.current)src.current.loop=false;
              }}
              style={{height:24,padding:"0 8px",background:loopActive?"#C8A96E1e":"#08080e",border:`1px solid ${loopActive?"#C8A96E66":"#C8A96E1a"}`,color:loopActive?"#C8A96E":"#C8A96E44",borderRadius:4,cursor:"pointer",fontFamily:"'DM Mono',monospace",fontSize:9,fontWeight:loopActive?500:400}}>
              {loopActive?"⟳ LOOP":"LOOP"}
            </button>
          )}
          {loopStart!==null&&(
            <button
              onClick={()=>{setLoopActive(false);setLoopStart(null);setLoopEnd(null);if(src.current)src.current.loop=false;}}
              style={{height:26,width:26,background:"transparent",border:"1px solid #ef444422",color:"#ef444455",borderRadius:4,cursor:"pointer",fontSize:10}}>
              ✕
            </button>
          )}
      </div>

      {/* ── LCD TIME ── */}
      <div style={{display:"flex", alignItems:"center", justifyContent:"space-between", padding:"6px 14px", background:"#08080e", borderBottom:BD}}>
        <div>
          <div style={{fontFamily:"'DM Mono',monospace", fontWeight:600, fontSize:22, color, letterSpacing:0.5, lineHeight:1, textShadow:`0 0 16px ${color}55`, fontVariantNumeric:"tabular-nums"}}>{fmt(cur)}</div>
          <div style={{fontSize:7, color:"#555562", fontFamily:"'DM Mono',monospace", letterSpacing:2.5, marginTop:4, textTransform:"uppercase"}}>Elapsed</div>
        </div>
        <div style={{display:"flex", flexDirection:"column", alignItems:"center", gap:3}}>
          {play&&<div style={{width:5,height:5,borderRadius:"50%",background:color,boxShadow:`0 0 8px ${color}`,animation:"pulse .7s infinite"}}/>}
          <div style={{fontSize:9, color:"#888898", fontFamily:"'DM Mono',monospace"}}>{buf?`${(prog*100).toFixed(0)}%`:""}</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontFamily:"'DM Mono',monospace", fontWeight:600, fontSize:22, color:"#383848", letterSpacing:0.5, lineHeight:1, fontVariantNumeric:"tabular-nums"}}>-{fmt(Math.max(0,dur-cur))}</div>
          <div style={{fontSize:7, color:"#555562", fontFamily:"'DM Mono',monospace", letterSpacing:2.5, marginTop:4, textTransform:"uppercase"}}>Remain</div>
        </div>
      </div>

      {/* ── TRANSPORT ── */}
      <div style={{display:"flex", alignItems:"center", gap:6, padding:"8px 12px", borderBottom:BD}}>
        <button onClick={(e)=>{ if(local&&cue) cue(); else if(remoteCue) remoteCue(); }} disabled={!cueEnabled} style={{height:48,padding:"0 12px",background:"#111118",border:`1px solid ${cueEnabled?"#2a2a38":"#1e1e28"}`,color:cueEnabled?"#C8A96E":"#2a2a38",borderRadius:7,cursor:cueEnabled?"pointer":"default",fontFamily:"'DM Mono',monospace",fontSize:10,fontWeight:700,letterSpacing:1.5,outline:"none",flexShrink:0}}>CUE</button>
        <button onClick={local?()=>seek(Math.max(0,prog-.005)):undefined} disabled={!local} style={{height:48,width:36,background:"#111118",border:"1px solid #1e1e28",color:local?"#888898":"#2a2a38",borderRadius:6,cursor:local?"pointer":"default",fontFamily:"'DM Mono',monospace",fontSize:13,outline:"none"}}>◂◂</button>
        <button onClick={(e)=>{ if(local&&toggle) toggle(); else if(remoteToggle) remoteToggle(); }} disabled={!enabled} style={{flex:1,height:48,background:playVisual?color+"33":(enabled?"#1a1a26":"#141420"),border:`2px solid ${playVisual?color:(enabled?color+"66":color+"22")}`,color:playVisual?color:(enabled?color:color+"44"),borderRadius:8,cursor:enabled?"pointer":"default",fontSize:24,fontWeight:600,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:playVisual?`0 0 24px ${color}55`:"none",outline:"none",transition:"all .15s"}}>
          {playVisual?"⏸":"▶"}
        </button>
        <button onClick={local?()=>seek(Math.min(1,prog+.005)):undefined} disabled={!local} style={{height:48,width:36,background:"#111118",border:"1px solid #1e1e28",color:local?"#888898":"#2a2a38",borderRadius:6,cursor:local?"pointer":"default",fontFamily:"'DM Mono',monospace",fontSize:13,outline:"none"}}>▸▸</button>
        {onMasterToggle&&(
          <button
            onClick={()=>onMasterToggle(id)}
            title={isMaster ? "This deck is the master (reference) — click to clear" : "Mark this deck as the SYNC master"}
            style={{
              height:48, width:32,
              background: isMaster ? "#22c55e22" : "transparent",
              border: `1px solid ${isMaster ? "#22c55e" : "#22c55e44"}`,
              color: isMaster ? "#22c55e" : "#22c55e88",
              borderRadius:7,
              cursor:"pointer",
              fontFamily:"'DM Mono',monospace",
              fontSize:11, fontWeight:700, letterSpacing:1,
              outline:"none", flexShrink:0,
              boxShadow: isMaster ? "0 0 10px #22c55e55" : "none",
              transition:"all .15s",
              display:"flex", alignItems:"center", justifyContent:"center",
            }}>M</button>
        )}
        {onSync&&(()=>{
          const isAnalyzing = !!buf && !bpmResult?.bpm && !!bpmResult?.analyzing;
          const canSync = !!buf && !!bpmResult?.bpm && syncReady;
          const isSlave  = syncRole === "slave";
          const isMasterRole = syncRole === "master";
          const isLocked = isSlave || isMasterRole;
          const clickable = canSync || isLocked; // locked is clickable too — click to release
          // States: slave (filled green + glow + dot, label "SYNC"), master
          // (outlined green, label "MASTER"), canSync (green outline, "SYNC"),
          // analyzing (amber pulse, "SYNC"), disabled (greyed, "SYNC").
          const tone =
            isSlave        ? { bg:"#22c55e44",   border:"#22c55e",   color:"#0a1a10",   cursor:"pointer",      opacity:1,   pulse:false, glow:true,  dot:true  }
            : isMasterRole ? { bg:"transparent", border:"#22c55e",   color:"#22c55e",   cursor:"pointer",      opacity:1,   pulse:false, glow:false, dot:false }
            : canSync      ? { bg:"#22c55e18",   border:"#22c55e66", color:"#22c55e",   cursor:"pointer",      opacity:1,   pulse:false, glow:false, dot:false }
            : isAnalyzing  ? { bg:"#f59e0b14",   border:"#f59e0b55", color:"#f59e0b",   cursor:"progress",     opacity:1,   pulse:true,  glow:false, dot:false }
            :                { bg:"transparent", border:"#22c55e22", color:"#22c55e44", cursor:"not-allowed",  opacity:0.4, pulse:false, glow:false, dot:false };
          const label = isMasterRole ? "MASTER" : "SYNC";
          const tip = isSlave    ? "This deck is the slave (locked) — click to release"
            : isMasterRole       ? "This deck is the master (reference) — click to release"
            : !buf             ? "Load a track"
            : isAnalyzing      ? "Analyzing BPM…"
            : !bpmResult?.bpm  ? "Waiting for BPM"
            : !syncReady       ? "Other deck has no BPM yet"
            :                    "Match this deck's BPM to the other";
          return (
            <button
              onClick={clickable ? onSync : undefined}
              disabled={!clickable}
              title={tip}
              style={{height:48,padding:"0 10px",background:tone.bg,border:`1px solid ${tone.border}`,color:tone.color,borderRadius:7,cursor:tone.cursor,opacity:tone.opacity,fontFamily:"'DM Mono',monospace",fontSize:10,fontWeight:700,letterSpacing:1.5,outline:"none",flexShrink:0,boxShadow:tone.glow?`0 0 12px #22c55e88`:"none",animation:tone.pulse?"pulse 1.1s ease-in-out infinite":"none",display:"flex",alignItems:"center",gap:6}}>
              {tone.dot && <span style={{width:6,height:6,borderRadius:"50%",background:"#22c55e",boxShadow:"0 0 6px #22c55e"}}/>}
              {label}
            </button>
          );
        })()}
      </div>

      <div style={{display:"none"}} data-set-rate={id} ref={el=>{if(el)el._setRate=setRate;}}/>
    </div>
  );
}
const TB=(c)=>({height:28,padding:"0 8px",background:"#0a0a14",border:`1px solid ${c}33`,color:c,borderRadius:5,cursor:"pointer",fontFamily:"'DM Mono',monospace",fontSize:9,outline:"none",display:"flex",alignItems:"center",justifyContent:"center"});
const TB2=(c,h=28)=>({height:h,width:h+8,background:"#0a0a14",border:`1px solid ${c}44`,color:c+"bb",borderRadius:7,cursor:"pointer",fontFamily:"'DM Mono',monospace",fontSize:11,outline:"none",display:"flex",alignItems:"center",justifyContent:"center",transition:"all .1s"});
const sBtn=(c)=>({padding:"5px 9px",fontSize:9,fontFamily:"'DM Mono',monospace",background:c+"0e",border:`1px solid ${c}2a`,color:c,borderRadius:6,cursor:"pointer",letterSpacing:.5,display:"flex",alignItems:"center",justifyContent:"center",gap:4});

// ── VerticalFader Component ──────────────────────────────────
function VerticalFader({ val, set, color="#C8A96E", h=130 }) {
  const pct = Math.min(1, Math.max(0, val / 1.5));
  const trackH = h - 8;
  const capTop = 4 + (1 - pct) * (trackH - 22);
  return (
    <div style={{position:"relative", width:38, height:h, margin:"0 auto", flexShrink:0}}>
      {/* Track groove */}
      <div style={{position:"absolute", left:"50%", top:4, height:trackH, transform:"translateX(-50%)", width:7, background:"#040408", border:"1px solid #1e1e28", borderRadius:4, boxShadow:"inset 0 1px 4px rgba(0,0,0,.7)"}}>
        {/* Tick marks */}
        {[0.25,0.5,0.67,0.75].map(t=>(
          <div key={t} style={{position:"absolute", right:-4, top:`${(1-t)*100}%`, width:3, height:1, background:"#2e2e40", borderRadius:1}}/>
        ))}
        {/* Level fill */}
        <div style={{position:"absolute", bottom:0, left:0, right:0, background:`linear-gradient(0deg,${color}88,${color}22)`, height:`${pct*100}%`, borderRadius:3, transition:"height .05s"}}/>
      </div>
      {/* Invisible rotated range input */}
      <input type="range" min={0} max={1.5} step={0.01} value={val}
        onChange={e=>set(Number(e.target.value))}
        style={{position:"absolute", width:h, height:38, left:`${(38-h)/2}px`, top:`${(h-38)/2}px`,
          transform:"rotate(-90deg)", opacity:0, cursor:"ns-resize", margin:0, padding:0, zIndex:2}}/>
      {/* Fader cap */}
      <div style={{
        position:"absolute", left:"50%", transform:"translateX(-50%)",
        top:capTop+"px", width:34, height:22,
        background:"linear-gradient(180deg,#303040,#181820)",
        border:"1px solid #3c3c50", borderRadius:5,
        boxShadow:"0 3px 10px rgba(0,0,0,.7), inset 0 1px 0 rgba(255,255,255,.08)",
        pointerEvents:"none", display:"flex", alignItems:"center", justifyContent:"center", gap:3
      }}>
        <div style={{width:1, height:13, background:"#2e2c46", borderRadius:1}}/>
        <div style={{width:12, height:2, background:`${color}77`, borderRadius:1}}/>
        <div style={{width:1, height:13, background:"#2e2c46", borderRadius:1}}/>
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
      <div style={{display:"flex",gap:8,justifyContent:"space-around",background:"#0a0a12",borderRadius:8,padding:"10px",border:"1px solid #1e1e28"}}>
        {[["A","#7B61FF",effA,rateA],["B","#00BFA5",effB,rateB]].map(([id,c,eff,r])=>(
          <div key={id} style={{textAlign:"center"}}>
            <div style={{fontSize:7,fontFamily:"'DM Mono',monospace",color:c+"44",letterSpacing:2}}>DECK {id}</div>
            <div style={{fontSize:20,fontFamily:"'DM Mono',monospace",fontWeight:700,color:eff?c:"#555562"}}>{eff?eff.toFixed(1):"—"}</div>
            {r!==1&&<div style={{fontSize:6,color:c+"66",fontFamily:"'DM Mono',monospace"}}>{r>1?"+":""}{((r-1)*100).toFixed(1)}%</div>}
          </div>
        ))}
      </div>
      {diff&&<div style={{textAlign:"center",fontSize:8,fontFamily:"'DM Mono',monospace",color:inSync?"#22c55e":"#555562"}}>Δ{diff} BPM {inSync?"✓ IN SYNC":""}</div>}
      <div style={{display:"flex",gap:5}}>
        <button onClick={onSyncB} disabled={!bpmA||!bpmB} style={{flex:1,...sBtn("#C8A96E")}}>SYNC B→A</button>
        <button onClick={onSyncA} disabled={!bpmA||!bpmB} style={{flex:1,...sBtn("#00BFA5")}}>SYNC A→B</button>
      </div>
      {(!bpmA||!bpmB)&&<div style={{fontSize:7,fontFamily:"'DM Mono',monospace",color:"#555562",textAlign:"center",lineHeight:1.9}}>Load tracks to detect BPM<br/>Analysis runs automatically</div>}
    </div>
  );
}

function RTCPanel({ rtc, partner, syncOk }) {
  const ST={idle:{c:"#555562",l:"OFFLINE"},offering:{c:"#f59e0b",l:"OFFERING"},answering:{c:"#f59e0b",l:"ANSWERING"},connecting:{c:"#f59e0b",l:"CONNECTING"},connected:{c:"#22c55e",l:"● STREAMING"},failed:{c:"#ef4444",l:"FAILED"}};
  const s=ST[rtc.state]||ST.idle,live=rtc.state==="connected",busy=["offering","answering","connecting"].includes(rtc.state),canCall=syncOk&&partner&&!live&&!busy;
  return (
    <div style={{padding:10,display:"flex",flexDirection:"column",gap:8}}>
      <div style={{display:"flex",justifyContent:"space-between"}}><span style={{fontSize:8,fontFamily:"'DM Mono',monospace",color:"#888898",letterSpacing:1}}>P2P AUDIO</span><span style={{fontSize:7,fontFamily:"'DM Mono',monospace",color:s.c}}>{s.l}</span></div>
      {live&&<div style={{display:"flex",gap:2,height:16,alignItems:"center",justifyContent:"center"}}>{Array.from({length:12}).map((_,i)=><div key={i} style={{width:3,borderRadius:2,background:"#22c55e",height:"100%",animation:`wave ${.4+(i%4)*.1}s ease-in-out ${i*.06}s infinite`,transformOrigin:"bottom"}}/>)}</div>}
      <div style={{fontSize:7,fontFamily:"'DM Mono',monospace",color:"#888898",display:"flex",justifyContent:"space-between"}}><span>PARTNER</span><span style={{color:partner?"#00BFA5":"#555562"}}>{partner||"—"}</span></div>
      <div style={{display:"flex",flexDirection:"column",gap:2}}><div style={{display:"flex",justifyContent:"space-between",fontSize:7,fontFamily:"'DM Mono',monospace",color:"#888898"}}><span>PARTNER VOL</span><span style={{color:"#22c55e"}}>{Math.round(rtc.remVol*100)}%</span></div><input type="range" min={0} max={1.5} step={.01} value={rtc.remVol} onChange={e=>rtc.setRemVol(Number(e.target.value))} style={{width:"100%",cursor:"pointer",accentColor:"#22c55e"}}/></div>
      <div style={{display:"flex",gap:5}}>
        {canCall&&<button onClick={rtc.startCall} style={{flex:1,...sBtn("#22c55e"),fontWeight:700}}>▶ START STREAM</button>}
        {busy&&<button disabled style={{flex:1,...sBtn("#f59e0b")}}>◌ CONNECTING...</button>}
        {(live||busy)&&<><button onClick={rtc.toggleMute} style={{...sBtn(rtc.muted?"#ef4444":"#888898"),padding:"5px 8px"}}>{rtc.muted?"🔇":"🎙"}</button><button onClick={rtc.endCall} style={{...sBtn("#ef4444"),padding:"5px 8px"}}>✕</button></>}
      </div>
      {!live&&!busy&&!canCall&&<div style={{fontSize:7,fontFamily:"'DM Mono',monospace",color:"#555562",lineHeight:1.9}}>{!syncOk?"Connect via WebSocket first":!partner?"Waiting for partner to join":"Ready — click Start Stream"}</div>}
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
      {isActive&&<div style={{fontSize:22,fontFamily:"'DM Mono',monospace",fontWeight:700,color:isRec?"#ef4444":"#f59e0b",letterSpacing:2,textAlign:"center"}}>{fmt(rec.dur)}</div>}
      {isActive&&<div style={{height:3,background:"#0a0a18",borderRadius:2}}><div style={{height:"100%",width:`${rec.level*100}%`,background:rec.level>.8?"#ef4444":rec.level>.6?"#f59e0b":"#22c55e",transition:"width .05s"}}/></div>}
      {!isActive&&<input value={label} onChange={e=>setLabel(e.target.value)} placeholder="Label (optional)" style={{background:"#07070f",border:"1px solid #141424",color:"#e8e8f0",borderRadius:6,padding:"5px 8px",fontSize:9,fontFamily:"'DM Mono',monospace",outline:"none"}}/>}
      <div style={{display:"flex",gap:5}}>
        {!isActive&&<button onClick={()=>rec.start(label||null)} disabled={!ready} style={{flex:1,padding:"8px",...sBtn("#ef4444"),fontWeight:700,opacity:ready?1:.4}}>● REC</button>}
        {isRec&&<><button onClick={rec.pause} style={{flex:1,padding:"7px",...sBtn("#f59e0b"),fontWeight:700}}>⏸</button><button onClick={rec.stop} style={{flex:1,padding:"7px",...sBtn("#ef4444"),fontWeight:700}}>⏹ STOP</button></>}
        {isPaused&&<><button onClick={rec.resume} style={{flex:1,padding:"7px",...sBtn("#22c55e"),fontWeight:700}}>▶</button><button onClick={rec.stop} style={{flex:1,padding:"7px",...sBtn("#ef4444"),fontWeight:700}}>⏹ STOP</button></>}
      </div>
      {rec.recs.length>0&&(
        <div style={{display:"flex",flexDirection:"column",gap:5,borderTop:"1px solid #0f0f1e",paddingTop:8}}>
          <div style={{fontSize:7,fontFamily:"'DM Mono',monospace",color:"#888898",letterSpacing:2}}>SAVED ({rec.recs.length})</div>
          {rec.recs.map(r=>(
            <div key={r.id} style={{background:"#07070f",border:"1px solid #0f0f1e",borderRadius:7,padding:"6px 9px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div><div style={{fontSize:9,fontFamily:"'DM Mono',monospace",color:"#d8d8e2"}}>{r.label}</div><div style={{fontSize:7,fontFamily:"'DM Mono',monospace",color:"#555562"}}>{fsz(r.size)} · {r.ext}</div></div>
              <div style={{display:"flex",gap:4}}><button onClick={()=>rec.dl(r)} style={{...sBtn("#C8A96E"),padding:"2px 7px",fontSize:7}}>↓</button><button onClick={()=>rec.del(r.id)} style={{...sBtn("#ef4444"),padding:"2px 6px",fontSize:7}}>✕</button></div>
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
          <button key={id} onClick={()=>setTab(id)} style={{flex:1,padding:"6px 3px",fontSize:7,fontFamily:"'DM Mono',monospace",background:tab===id?"#0d0d20":"transparent",color:tab===id?"#C8A96E":"#555562",border:"none",borderBottom:`1px solid ${tab===id?"#C8A96E":"transparent"}`,cursor:"pointer",outline:"none"}}>{l}</button>
        ))}
      </div>
      <div style={{flex:1,overflowY:"auto",padding:7}}>
        {tab==="dev"&&(<div style={{display:"flex",flexDirection:"column",gap:5}}>{!midi.granted?<button onClick={midi.request} style={{...sBtn("#f59e0b"),width:"100%",justifyContent:"center",padding:"7px"}}>ENABLE MIDI ACCESS</button>:<>{midi.devices.length===0&&<div style={{fontSize:7,color:"#555562",fontFamily:"'DM Mono',monospace",textAlign:"center",padding:"10px 0"}}>No MIDI devices found.<br/>Plug in your controller.</div>}{midi.devices.map(d=><div key={d.id} onClick={()=>midi.connect(d.id)} style={{padding:"5px 7px",borderRadius:5,cursor:"pointer",background:midi.active?.id===d.id?"#C8A96E0d":"#07070f",border:`1px solid ${midi.active?.id===d.id?"#C8A96E33":"#0f0f1e"}`}}><div style={{fontSize:8,color:"#d8d8e2",fontFamily:"'DM Mono',monospace"}}>{d.name}</div>{midi.active?.id===d.id&&<div style={{fontSize:6,color:"#C8A96E",fontFamily:"'DM Mono',monospace"}}>● ACTIVE</div>}</div>)}</> }</div>)}
        {tab==="map"&&(<div style={{display:"flex",flexDirection:"column",gap:2}}>{midi.learning&&<div style={{fontSize:7,fontFamily:"'DM Mono',monospace",color:"#C8A96E",background:"#C8A96E0a",border:"1px solid #C8A96E22",borderRadius:4,padding:"4px 7px",marginBottom:3,animation:"pulse .8s infinite"}}>● Move a control on your controller...<button onClick={()=>midi.setLearning(null)} style={{float:"right",background:"none",border:"none",color:"#C8A96E",cursor:"pointer",fontSize:8}}>✕</button></div>}{ACTS.map(ak=>{const mp=Object.entries(midi.mappings).find(([,v])=>v===ak);const il=midi.learning===ak;return(<div key={ak} style={{display:"flex",gap:3,alignItems:"center",padding:"2px 3px",borderRadius:3,background:il?"#C8A96E08":"transparent"}}><span style={{flex:1,fontSize:7,fontFamily:"'DM Mono',monospace",color:mp?"#8888aa":"#555562",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{ak.replace(/_/g," ")}</span>{mp&&<span style={{fontSize:5,color:"#C8A96E44",fontFamily:"'DM Mono',monospace"}}>{mp[0].slice(0,6)}</span>}<button onClick={()=>midi.setLearning(il?null:ak)} style={{padding:"1px 4px",fontSize:5,fontFamily:"'DM Mono',monospace",background:il?"#C8A96E22":"#0a0a18",border:`1px solid ${il?"#C8A96E44":"#141424"}`,color:il?"#C8A96E":"#555562",borderRadius:3,cursor:"pointer"}}>{il?"●":"LRN"}</button></div>);})}</div>)}
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
        {log.length===0&&<div style={{fontSize:8,color:"#555562",fontFamily:"'DM Mono',monospace",textAlign:"center",marginTop:20}}>Chat with your partner here</div>}
        {log.map((m,i)=><div key={i} style={{fontSize:9,fontFamily:"'DM Mono',monospace"}}>{m.type==="system"?<span style={{color:"#555562",fontStyle:"italic"}}>— {m.msg} —</span>:<><span style={{color:"#555562",fontSize:6}}>{m.time} </span><span style={{color:m.self||m.from===me?"#C8A96E":"#00BFA5",fontWeight:700}}>{m.from}: </span><span style={{color:"#c0c0cc"}}>{m.msg}</span></>}</div>)}
        <div ref={end}/>
      </div>
      <div style={{display:"flex",gap:5,padding:"5px 7px",borderTop:"1px solid #0f0f1e"}}>
        <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&go()} placeholder="Message your partner..." style={{flex:1,background:"#07070f",border:"1px solid #141424",color:"#e8e8f0",borderRadius:5,padding:"4px 7px",fontSize:9,fontFamily:"'DM Mono',monospace",outline:"none"}}/>
        <button onClick={go} style={{...sBtn("#C8A96E"),padding:"4px 9px",fontSize:10}}>→</button>
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
            ? <span style={{ fontSize:9, fontFamily:"'DM Mono',monospace", color:"#555562", fontStyle:"italic" }}>No messages yet — say hi to your partner</span>
            : log.map((m,i)=>(
                <div key={i} style={{ fontSize:9, fontFamily:"'DM Mono',monospace" }}>
                  {m.type==="system"
                    ? <span style={{ color:"#555562", fontStyle:"italic" }}>— {m.msg} —</span>
                    : <><span style={{ color:"#555562", fontSize:7 }}>{m.time} </span><span style={{ color:m.self||m.from===me?"#C8A96E":"#00BFA5", fontWeight:500 }}>{m.from}: </span><span style={{ color:"#888898" }}>{m.msg}</span></>
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
          <span style={{ fontSize:8, fontFamily:"'DM Mono',monospace", color:"#555562", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1 }}>
            <span style={{ color:last.from===me?"#C8A96E55":"#00BFA555" }}>{last.from}: </span>{last.msg}
          </span>
        ) : <span style={{ flex:1, fontSize:8, fontFamily:"'DM Mono',monospace", color:"#555562" }}>Message your partner...</span>; })()}
        {expanded && <div style={{ flex:1 }}/>}
        <input
          value={input}
          onChange={e=>setInput(e.target.value)}
          onKeyDown={e=>e.key==="Enter"&&go()}
          placeholder="Type a message..."
          style={{ width:220, background:"#0E0C1A", border:`1px solid ${G}22`, color:"#d8d8e2", borderRadius:6, padding:"5px 10px", fontSize:9, fontFamily:"'DM Mono',monospace", outline:"none", flexShrink:0 }}
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
        .feat-card:hover { border-color: #C8A96E44 !important; transform: translateY(-3px); box-shadow: 0 8px 30px rgba(0,212,255,.08) !important; }
        .feat-card { transition: all .2s ease !important; }
        .cta-btn:hover { box-shadow: 0 0 40px #C8A96E55, 0 0 80px #C8A96E22 !important; transform: scale(1.02); }
        .cta-btn { transition: all .2s ease !important; }
        .nav-link:hover { color: #C8A96E !important; }
        .nav-link { transition: color .15s !important; }
      `}</style>
      <link href="https://fonts.googleapis.com/css2?family=Barlow:wght@300;400;600;700&family=Barlow+Condensed:wght@600;700;800;900&display=swap" rel="stylesheet"/>

      {/* NAV */}
      <nav style={{ position:"fixed", top:0, left:0, right:0, zIndex:100, padding:"14px 40px", display:"flex", justifyContent:"space-between", alignItems:"center", background:"linear-gradient(180deg,#020208ee,transparent)", backdropFilter:"blur(8px)" }}>
        <div style={{ fontFamily:"'DM Mono',monospace", fontWeight:900, fontSize:22, letterSpacing:3, background:"linear-gradient(90deg,#C8A96E,#00BFA5)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>MIX//SYNC</div>
        <div style={{ display:"flex", gap:28, alignItems:"center" }}>
          {["Features","How It Works","Get Started"].map(l=>(
            <span key={l} className="nav-link" style={{ fontSize:11, fontFamily:"'DM Mono',monospace", color:"#888898", letterSpacing:1, cursor:"pointer" }}>{l.toUpperCase()}</span>
          ))}
          <button onClick={onEnter} className="cta-btn" style={{ padding:"8px 20px", background:"linear-gradient(135deg,#C8A96E,#0099bb)", border:"none", color:"#000", fontFamily:"'DM Mono',monospace", fontWeight:800, fontSize:12, letterSpacing:2, borderRadius:6, cursor:"pointer" }}>
            START A MIX →
          </button>
        </div>
      </nav>

      {/* HERO */}
      <section style={{ minHeight:"100vh", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", textAlign:"center", padding:"100px 40px 60px", position:"relative", overflow:"hidden" }}>

        {/* Background glow orbs */}
        <div style={{ position:"absolute", top:"20%", left:"15%", width:400, height:400, borderRadius:"50%", background:"radial-gradient(circle,#C8A96E08,transparent 70%)", animation:"glow 4s ease-in-out infinite", pointerEvents:"none" }}/>
        <div style={{ position:"absolute", top:"30%", right:"10%", width:300, height:300, borderRadius:"50%", background:"radial-gradient(circle,#00BFA508,transparent 70%)", animation:"glow 5s ease-in-out 1s infinite", pointerEvents:"none" }}/>
        <div style={{ position:"absolute", bottom:"20%", left:"40%", width:500, height:200, borderRadius:"50%", background:"radial-gradient(circle,#a855f706,transparent 70%)", animation:"glow 6s ease-in-out 2s infinite", pointerEvents:"none" }}/>

        {/* Animated grid lines */}
        <div style={{ position:"absolute", inset:0, backgroundImage:"linear-gradient(#ffffff04 1px,transparent 1px),linear-gradient(90deg,#ffffff04 1px,transparent 1px)", backgroundSize:"60px 60px", pointerEvents:"none" }}/>

        <div style={{ animation:"slide .8s ease forwards", maxWidth:760 }}>
          <div style={{ fontSize:10, fontFamily:"'DM Mono',monospace", color:"#C8A96E", letterSpacing:4, marginBottom:20, display:"flex", alignItems:"center", justifyContent:"center", gap:10 }}>
            <div style={{ width:20, height:1, background:"#C8A96E" }}/>
            THE FUTURE OF REMOTE DJing
            <div style={{ width:20, height:1, background:"#C8A96E" }}/>
          </div>

          <h1 style={{ fontFamily:"'DM Mono',monospace", fontWeight:900, fontSize:"clamp(48px,8vw,96px)", lineHeight:.95, letterSpacing:-1, margin:"0 0 24px" }}>
            <span style={{ display:"block", background:"linear-gradient(135deg,#ffffff,#aaaacc)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>MIX TOGETHER.</span>
            <span style={{ display:"block", background:"linear-gradient(135deg,#C8A96E,#0066ff)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>ANYWHERE.</span>
          </h1>

          <p style={{ fontSize:16, color:"#8888aa", lineHeight:1.7, maxWidth:520, margin:"0 auto 40px", fontWeight:300 }}>
            Two DJs. Real-time audio sync. MIDI controllers. Beat detection. Live audio streaming. All in your browser — no software to install.
          </p>

          <div style={{ display:"flex", gap:12, justifyContent:"center", flexWrap:"wrap" }}>
            <button onClick={onEnter} className="cta-btn" style={{ padding:"16px 40px", background:"linear-gradient(135deg,#C8A96E,#0077cc)", border:"none", color:"#000", fontFamily:"'DM Mono',monospace", fontWeight:800, fontSize:15, letterSpacing:2, borderRadius:8, cursor:"pointer", boxShadow:"0 0 30px #C8A96E33" }}>
              START A MIX →
            </button>
            <button style={{ padding:"16px 32px", background:"transparent", border:"1px solid #ffffff22", color:"#888", fontFamily:"'DM Mono',monospace", fontWeight:700, fontSize:14, letterSpacing:2, borderRadius:8, cursor:"pointer" }}>
              WATCH DEMO ▶
            </button>
          </div>

          <div style={{ marginTop:24, fontSize:9, fontFamily:"'DM Mono',monospace", color:"#888898", letterSpacing:1 }}>
            No account required · Works in Chrome & Edge · Free to use
          </div>
        </div>

        {/* Floating mixer preview */}
        <div style={{ marginTop:60, width:"100%", maxWidth:860, animation:"float 6s ease-in-out infinite", position:"relative" }}>
          <div style={{ background:"linear-gradient(150deg,#0d0d22,#07070f)", border:"1px solid #1a1a30", borderRadius:16, padding:"20px 24px", boxShadow:"0 40px 80px rgba(0,0,0,.6), 0 0 60px rgba(0,212,255,.06)", display:"grid", gridTemplateColumns:"1fr 80px 1fr", gap:16, alignItems:"center" }}>
            {["#C8A96E","#00BFA5"].map((c,i)=>(
              <div key={i} style={{ background:"#06060f", borderRadius:10, padding:12, border:`1px solid ${c}22` }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
                  <span style={{ fontSize:9, fontFamily:"'DM Mono',monospace", color:c, letterSpacing:2 }}>DECK {i===0?"A":"B"}</span>
                  <div style={{ display:"flex", gap:1 }}>{Array.from({length:8}).map((_,j)=><div key={j} style={{ width:4, height:4+Math.random()*12, background:c+(j<5?"cc":"33"), borderRadius:1 }}/>)}</div>
                </div>
                <div style={{ height:28, background:"#03030a", borderRadius:4, marginBottom:8, overflow:"hidden", display:"flex", alignItems:"center" }}>
                  {Array.from({length:60}).map((_,j)=>{ const h=Math.sin(j*.4+(i*.5))*.4+.5; return <div key={j} style={{ flex:1, height:`${h*100}%`, background:j<30?c:c+"44", borderRadius:1 }}/>; })}
                </div>
                <div style={{ display:"flex", gap:4, justifyContent:"center" }}>
                  {["⏮","◂◂","▶","▸▸"].map(btn=><div key={btn} style={{ width:24, height:20, background:"#0a0a18", border:`1px solid ${c}22`, borderRadius:3, display:"flex", alignItems:"center", justifyContent:"center", fontSize:8, color:btn==="▶"?c:"#555562" }}>{btn}</div>)}
                </div>
              </div>
            ))}
            <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:8 }}>
              <div style={{ fontSize:7, fontFamily:"'DM Mono',monospace", color:"#888898", letterSpacing:1 }}>XF</div>
              <div style={{ width:"100%", height:4, background:"linear-gradient(90deg,#C8A96E,#00BFA5)", borderRadius:2, position:"relative" }}>
                <div style={{ position:"absolute", left:"calc(50% - 8px)", top:-6, width:16, height:16, background:"#e8e8f0", borderRadius:3, boxShadow:"0 0 8px rgba(255,255,255,.3)" }}/>
              </div>
              <div style={{ fontSize:7, fontFamily:"'DM Mono',monospace", color:"#22c55e" }}>124.0 BPM</div>
            </div>
          </div>
          {/* Reflection */}
          <div style={{ position:"absolute", bottom:-40, left:"10%", right:"10%", height:40, background:"linear-gradient(180deg,rgba(0,212,255,.04),transparent)", borderRadius:"50%", filter:"blur(10px)" }}/>
        </div>
      </section>

      {/* FEATURES */}
      <section style={{ padding:"80px 40px", maxWidth:1100, margin:"0 auto" }}>
        <div style={{ textAlign:"center", marginBottom:56 }}>
          <div style={{ fontSize:9, fontFamily:"'DM Mono',monospace", color:"#C8A96E", letterSpacing:4, marginBottom:14 }}>WHAT'S INSIDE</div>
          <h2 style={{ fontFamily:"'DM Mono',monospace", fontWeight:900, fontSize:"clamp(32px,5vw,52px)", letterSpacing:-1, margin:0, color:"#e8e8f0" }}>EVERYTHING A DJ NEEDS</h2>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))", gap:16 }}>
          {features.map((f,i)=>(
            <div key={i} className="feat-card" style={{ background:"linear-gradient(150deg,#0d0d1e,#07070f)", border:"1px solid #141428", borderRadius:12, padding:"24px 22px" }}>
              <div style={{ fontSize:28, marginBottom:12 }}>{f.icon}</div>
              <div style={{ fontFamily:"'DM Mono',monospace", fontWeight:800, fontSize:17, letterSpacing:1, color:"#e8e8f0", marginBottom:8 }}>{f.title}</div>
              <div style={{ fontSize:11, color:"#888898", lineHeight:1.7, fontWeight:300 }}>{f.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section style={{ padding:"80px 40px", background:"linear-gradient(180deg,transparent,#0a0a1800,transparent)" }}>
        <div style={{ maxWidth:800, margin:"0 auto", textAlign:"center" }}>
          <div style={{ fontSize:9, fontFamily:"'DM Mono',monospace", color:"#C8A96E", letterSpacing:4, marginBottom:14 }}>SIMPLE AS IT GETS</div>
          <h2 style={{ fontFamily:"'DM Mono',monospace", fontWeight:900, fontSize:"clamp(28px,4vw,46px)", letterSpacing:-1, marginBottom:48, color:"#e8e8f0" }}>THREE STEPS TO GO LIVE</h2>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:24 }}>
            {[
              { n:"01", title:"Open the App", desc:"No install. No account. Just click Launch App and you're in." },
              { n:"02", title:"Share Room ID", desc:"Copy your Room ID and send it to your partner. They join the same room." },
              { n:"03", title:"Start Mixing", desc:"Load your tracks, hit play. You're live. Your mix streams to their ears in real time." },
            ].map((s,i)=>(
              <div key={i} style={{ textAlign:"center" }}>
                <div style={{ fontSize:40, fontFamily:"'DM Mono',monospace", fontWeight:900, color:"#C8A96E11", letterSpacing:-2, marginBottom:12 }}>{s.n}</div>
                <div style={{ fontFamily:"'DM Mono',monospace", fontWeight:800, fontSize:18, color:"#e8e8f0", marginBottom:8 }}>{s.title}</div>
                <div style={{ fontSize:11, color:"#888898", lineHeight:1.7 }}>{s.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* BOTTOM CTA */}
      <section style={{ padding:"80px 40px", textAlign:"center" }}>
        <div style={{ maxWidth:600, margin:"0 auto" }}>
          <h2 style={{ fontFamily:"'DM Mono',monospace", fontWeight:900, fontSize:"clamp(32px,5vw,56px)", letterSpacing:-1, margin:"0 0 16px", background:"linear-gradient(135deg,#ffffff,#aaaacc)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>
            READY TO MIX?
          </h2>
          <p style={{ fontSize:13, color:"#888898", marginBottom:32, lineHeight:1.7 }}>
            Invite a friend, load up your tracks, and start playing together right now. No credit card. No software.
          </p>
          <button onClick={onEnter} className="cta-btn" style={{ padding:"18px 48px", background:"linear-gradient(135deg,#C8A96E,#0077cc)", border:"none", color:"#000", fontFamily:"'DM Mono',monospace", fontWeight:900, fontSize:16, letterSpacing:3, borderRadius:8, cursor:"pointer", boxShadow:"0 0 40px #C8A96E33" }}>
            START A MIX →
          </button>
        </div>
      </section>

      {/* FOOTER */}
      <footer style={{ borderTop:"1px solid #0f0f1e", padding:"24px 40px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div style={{ fontFamily:"'DM Mono',monospace", fontWeight:800, fontSize:14, letterSpacing:3, background:"linear-gradient(90deg,#C8A96E,#00BFA5)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>MIX//SYNC</div>
        <div style={{ fontSize:8, fontFamily:"'DM Mono',monospace", color:"#555562" }}>Built for DJs who refuse to be in the same room.</div>
        <div style={{ fontSize:8, fontFamily:"'DM Mono',monospace", color:"#555562" }}>Chrome & Edge · HTTPS required for MIDI + WebRTC</div>
      </footer>
    </div>
  );
}

// ── Share Button (used in session top bar) ───────────────────
function ShareButton({ room, mixName }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(buildInviteLink(room, mixName)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  };
  return (
    <button onClick={copy} style={{ background: copied ? "#22c55e22" : "#C8A96E11", border: copied ? "1px solid #22c55e55" : "1px solid #C8A96E44", color: copied ? "#22c55e" : "#C8A96E", fontFamily:"'DM Mono',monospace", fontWeight:800, fontSize:7, letterSpacing:1, height:22, padding:"0 9px", borderRadius:5, cursor:"pointer", transition:"all .3s" }}>
      {copied ? "✓ COPIED" : "⎘ INVITE"}
    </button>
  );
}

// ── Session Lobby (after clicking Launch) ────────────────────
function Lobby({ onJoin, djName = null }) {
  const [room] = useState(() => getOrCreateRoomId());
  const [name, setName] = useState(djName || "DJ " + ["Apex","Nova","Flux","Orbit","Prism","Echo"][Math.floor(Math.random()*6)]);
  const [mixName, setMixName] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("mix") || "";
  });
  const [copied, setCopied] = useState(false);
  const isJoining = useMemo(() => {
    return new URLSearchParams(window.location.search).has("room");
  }, []);

  // Auto-join immediately if a name was passed in from the landing page
  useEffect(() => {
    if (djName) onJoin({ url: SERVER_URL, room, name: djName, mixName: mixName || "Untitled Mix" });
  }, []);

  const inviteLink = buildInviteLink(room, mixName);

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
          <div style={{ fontFamily:"'Cormorant Garamond',serif", fontWeight:700, fontSize:28, letterSpacing:-0.5, color:"#d8d8e2" }}>
            Mix<span style={{ color:G }}>//</span>Sync
          </div>
          <div style={{ fontSize:9, fontFamily:"'DM Mono',monospace", color:`${G}55`, letterSpacing:3, marginTop:6 }}>{isJoining?"JOIN MIX":"START A MIX"}</div>
        </div>

        {/* Mix Name */}
        <div style={{ display:"flex", flexDirection:"column", gap:7 }}>
          <label style={{ fontSize:8, fontFamily:"'DM Mono',monospace", color:`${G}77`, letterSpacing:2 }}>{isJoining?"JOINING MIX":"MIX NAME"}</label>
          {isJoining ? (
            <div style={{ fontFamily:"'Cormorant Garamond',serif", fontWeight:700, fontSize:22, letterSpacing:0.5, color:"#d8d8e2", padding:"6px 0" }}>{mixName || "Untitled Mix"}</div>
          ) : (
            <input
              value={mixName}
              onChange={e => setMixName(e.target.value)}
              placeholder="e.g., Saturday Late Night"
              style={{ background:"#080710", border:`1px solid ${G}33`, color:"#d8d8e2", borderRadius:8, padding:"11px 14px", fontSize:16, fontFamily:"'DM Sans',sans-serif", fontWeight:500, outline:"none" }}
            />
          )}
        </div>

        {/* DJ Name */}
        <div style={{ display:"flex", flexDirection:"column", gap:7 }}>
          <label style={{ fontSize:8, fontFamily:"'DM Mono',monospace", color:`${G}77`, letterSpacing:2 }}>YOUR DJ NAME</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            style={{ background:"#080710", border:`1px solid ${G}33`, color:"#d8d8e2", borderRadius:8, padding:"11px 14px", fontSize:16, fontFamily:"'DM Sans',sans-serif", fontWeight:500, outline:"none" }}
          />
        </div>

        {/* Mix Code */}
        <div style={{ background:"#080710", border:`1px solid ${G}18`, borderRadius:12, padding:16, display:"flex", flexDirection:"column", gap:8 }}>
          <div style={{ fontSize:8, fontFamily:"'DM Mono',monospace", color:`${G}55`, letterSpacing:2 }}>MIX CODE</div>
          <div style={{ fontFamily:"'Cormorant Garamond',serif", fontWeight:700, fontSize:22, letterSpacing:1, color:"#d8d8e2" }}>{room}</div>
          <div style={{ fontSize:8, fontFamily:"'DM Mono',monospace", color:"#555562", wordBreak:"break-all" }}>{inviteLink}</div>
          <button
            onClick={copyLink}
            style={{ background: copied ? "#22c55e14" : `${G}14`, border: copied ? "1px solid #22c55e33" : `1px solid ${G}33`, color: copied ? "#22c55e" : G, fontFamily:"'DM Mono',monospace", fontWeight:500, fontSize:10, letterSpacing:2, padding:"10px 16px", borderRadius:8, cursor:"pointer", transition:"all .3s", textAlign:"center" }}
          >
            {copied ? "✓ LINK COPIED!" : "⎘ COPY MIX LINK"}
          </button>
          <div style={{ fontSize:8, fontFamily:"'DM Sans',sans-serif", color:"#888898", lineHeight:1.6, fontWeight:300 }}>Send this link to your partner — they'll join the same mix instantly.</div>
        </div>

        {/* Join button — matches App.jsx btn-gold */}
        <button
          onClick={() => onJoin({ url: SERVER_URL, room, name, mixName: mixName || "Untitled Mix" })}
          style={{ background:G, border:"none", color:"#080710", fontFamily:"'DM Mono',monospace", fontWeight:500, fontSize:12, letterSpacing:2, padding:"15px", borderRadius:10, cursor:"pointer", boxShadow:`0 0 32px ${G}30, 0 8px 20px rgba(0,0,0,.4)`, transition:"all .2s" }}
        >
          {isJoining?"JOIN MIX →":"START MIX →"}
        </button>

        <div style={{ fontSize:8, fontFamily:"'DM Mono',monospace", color:"#555562", textAlign:"center", letterSpacing:1 }}>
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
  const [ready, setReady]       = useState(true);
  const [session, setSession]   = useState({ url:SERVER_URL, room:"preview", name:"DJ Preview" });
  const [xf, setXf]             = useState(.5);
  const [mvol, setMvol]         = useState(.85);
  const [chat, setChat]         = useState([]);
  const [pA, setPA]             = useState(null);
  const [pB, setPB]             = useState(null);
  const [midiEvt, setMidiEvt]   = useState(null);
  const [panel, setPanel]       = useState(null);
  // FIX: track actual playback rates so BPM sync display is correct
  const [rateA, setRateA]       = useState(1);
  const [rateB, setRateB]       = useState(1);
  // SYNC lock — Beatport-B2B style global toggle. One boolean for the whole
  // session. Click on either deck → both decks light up locked together.
  // The clicked deck is the slave; the other is the master. Re-fires one-shot
  // sync when the master's BPM changes. Lock state mirrors across browsers.
  // TODO: implement continuous tempo lock at the audio engine level.
  // Currently toggle is visual + master-BPM-change-driven only.
  const [syncLocked, setSyncLocked] = useState(false);
  // Slave-deck identity needs both a ref (for stale-deps callbacks) and state
  // (so the SYNC button visual can branch master vs slave on render).
  const [lastSlaveDeck, setLastSlaveDeck] = useState(null);
  const lastSlaveDeckRef = useRef(null);
  // Explicit master selection. null = no explicit master (fall back to implicit
  // "other deck = master" when SYNC engages). Mirrored across browsers.
  const [masterDeck, setMasterDeck] = useState(null);
  const masterDeckRef = useRef(null);
  // Per-deck play-start timestamp for auto-master detection on SYNC engage.
  // The deck that started playing FIRST is the natural master.
  // Updated from BOTH local owner-driven play (via dh) and partner-driven play
  // (via handleWS deck_update branch) so it tracks whichever side is driving.
  const deckPlayStartRef = useRef({ A: null, B: null });
  // Re-entry guard for handleSyncToggle. Production logs showed OFF→ON
  // sequences firing twice in succession without user double-clicks. Drop
  // invocations within 200ms of the last one to suppress duplicates.
  const lastSyncToggleMsRef = useRef(0);
  // Locked session tempo (effective BPM at the moment of sync engagement).
  // Once stored, BOTH decks target this BPM until sync is released — including
  // the master deck. Loading a new track on EITHER deck while locked re-rates
  // that deck to match the session tempo, not the new track's natural BPM.
  // Master role is preserved (visual indicator, phase reference) but its
  // current effective BPM is held to the session tempo.
  const sessionTempoRef = useRef(null);
  // Auto re-align when user scrubs while locked (Problem 1)
  const scrubResyncTimerRef     = useRef(null);
  const lastScrubResyncTimeRef  = useRef(0);
  const [eqA, setEqA]           = useState({hi:0, mid:0, lo:0, vol:1.0, filter:0});
  const [eqB, setEqB]           = useState({hi:0, mid:0, lo:0, vol:1.0, filter:0});
  const lsRef                   = useRef({ deckA:{}, deckB:{}, xfade:.5 });
  const rateARef                = useRef(null); // DOM refs to call setRate on Deck
  const rateBRef                = useRef(null);
  // RTC auto-start / auto-reconnect plumbing.
  // Refs track the latest values so handleWS (a stale-deps useCallback) and
  // setTimeout callbacks can read them without stale-closure bugs.
  const partnerRef              = useRef(null); // mirrors sync.partner
  const rtcRef                  = useRef(null); // mirrors latest rtc
  const sessionRef              = useRef(null); // mirrors session (DJ name + room)
  const syncRef                 = useRef(null); // mirrors sync (send / status)
  const isInitiatorRef          = useRef(()=>false); // mirrors latest role-election helper
  const rtcReconnectAttemptsRef = useRef(0);    // increments per rtc_hangup retry
  const rtcReconnectTimerRef    = useRef(null); // pending reconnect timer
  const [rtcReconnectExhausted, setRtcReconnectExhausted] = useState(false);

  const bpm = useBPM();
  const rec = useRecorder({ engineRef: eng });
  const lib = useLibrary();

  // Initialize audio engine when session is ready but engine hasn't been created yet
  // (covers preview/bypass mode where join() is skipped)
  useEffect(() => {
    if (ready && !eng.current) { eng.current = createEngine(); }
  }, [ready]);

  // Diagnostic surface for library state↔IDB desync investigation. Exposes the
  // current library state and a verifyLibrary() helper to the browser console
  // via window._mmDebug. Run window._mmDebug.verifyLibrary() to compare counts.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window._mmDebug = window._mmDebug || {};
    window._mmDebug.library = lib.library;
    window._mmDebug.verifyLibrary = async () => {
      const idbTracks = await cmDbAll("tracks");
      const stateIds = new Set((lib.library || []).map(t => t.id));
      const idbIds = new Set(idbTracks.map(t => t.id));
      const inStateNotIdb = [...stateIds].filter(id => !idbIds.has(id));
      const inIdbNotState = [...idbIds].filter(id => !stateIds.has(id));
      const result = {
        stateCount: stateIds.size,
        idbCount: idbIds.size,
        inStateNotIdb,
        inIdbNotState,
      };
      console.log('[VERIFY]', result);
      return result;
    };
  }, [lib.library]);

  // ── Full-width waveform state (lifted from Deck components) ──
  const [wfA, setWfA] = useState(null); // {bass, mid, high, dur} — only updates on track load
  const [wfB, setWfB] = useState(null);
  const [wfZoom, setWfZoom] = useState(0); // 0=WIDE(16s) 1=MED(8s) 2=ZOOM(4s)
  const WF_WINDOWS = [16, 8, 4]; // seconds — WIDE / MED / ZOOM per spec
  const WF_ZOOM_LABELS = ["WIDE","MED","ZOOM"];
  const progRefA = useRef(0);
  const progRefB = useRef(0);
  const handleProgA = useCallback((p) => { progRefA.current = p; }, []);
  const handleProgB = useCallback((p) => { progRefB.current = p; }, []);
  const seekFnsRef = useRef({ A:null, B:null });
  const toggleFnsRef = useRef({ A:null, B:null });
  const cueFnsRef = useRef({ A:null, B:null });
  const onDeckASeekReady = useCallback((fn) => { seekFnsRef.current.A = fn; }, []);
  const onDeckBSeekReady = useCallback((fn) => { seekFnsRef.current.B = fn; }, []);
  const onDeckAToggleReady = useCallback((fn) => { toggleFnsRef.current.A = fn; }, []);
  const onDeckACueReady = useCallback((fn) => { cueFnsRef.current.A = fn; }, []);
  const onDeckBToggleReady = useCallback((fn) => { toggleFnsRef.current.B = fn; }, []);
  const onDeckBCueReady = useCallback((fn) => { cueFnsRef.current.B = fn; }, []);
  const seekDeckA = useCallback((p) => { seekFnsRef.current.A?.(p); }, []);
  const seekDeckB = useCallback((p) => { seekFnsRef.current.B?.(p); }, []);
  // Partner-mirror waveforms — when a deck_update from partner brings
  // waveform arrays for THEIR loaded track, paint them into wfA/wfB so the
  // top zoomed waveform shows what they're playing. Local loads on the
  // same deck override (the local Deck's onWaveform fires AFTER, last-write-wins).
  useEffect(() => {
    if (pA?.waveformBass && pA?.waveformMid && pA?.waveformHigh) {
      setWfA({ bass: pA.waveformBass, mid: pA.waveformMid, high: pA.waveformHigh, dur: pA.duration||0, name: pA.trackName });
    }
  }, [pA?.waveformBass, pA?.waveformMid, pA?.waveformHigh]);
  useEffect(() => {
    if (pB?.waveformBass && pB?.waveformMid && pB?.waveformHigh) {
      setWfB({ bass: pB.waveformBass, mid: pB.waveformMid, high: pB.waveformHigh, dur: pB.duration||0, name: pB.trackName });
    }
  }, [pB?.waveformBass, pB?.waveformMid, pB?.waveformHigh]);

  // ── Per-track beat-grid manual adjustments ──
  // Auto-detection isn't reliable on every track (reverb-heavy kicks, sub-bass
  // bleed, unusual bar-1 emphasis). Two escape hatches, both keyed per-track:
  //   gridOffset (ms) — shifts the first downbeat earlier/later. Fixes WHERE
  //                     the grid starts. ±5 ms per click.
  //   bpmNudge   (in 0.01-BPM units) — changes the SPACING between beats. Fixes
  //                     tempo drift across the track when the detected period
  //                     is slightly off. ±0.01 BPM per click.
  // Keyed by track name (library title or filename minus extension).
  const [gridOffsetA, setGridOffsetA] = useState(0); // milliseconds
  const [bpmNudgeA, setBpmNudgeA] = useState(0);     // in 0.01-BPM clicks
  useEffect(() => {
    if (!wfA?.name) return;
    let savedOff = null, savedBpm = null;
    try { savedOff = localStorage.getItem(`gridOffset:${wfA.name}`); } catch (e) { console.warn('localStorage.getItem failed', `gridOffset:${wfA.name}`, e); }
    try { savedBpm = localStorage.getItem(`bpmNudge:${wfA.name}`); } catch (e) { console.warn('localStorage.getItem failed', `bpmNudge:${wfA.name}`, e); }
    setGridOffsetA(savedOff ? parseFloat(savedOff) : 0);
    setBpmNudgeA(savedBpm ? parseInt(savedBpm, 10) : 0);
  }, [wfA?.name]);
  useEffect(() => {
    if (!wfA?.name) return;
    try { localStorage.setItem(`gridOffset:${wfA.name}`, String(gridOffsetA)); } catch (e) { console.warn('localStorage.setItem failed', `gridOffset:${wfA.name}`, e); }
  }, [gridOffsetA, wfA?.name]);
  useEffect(() => {
    if (!wfA?.name) return;
    try { localStorage.setItem(`bpmNudge:${wfA.name}`, String(bpmNudgeA)); } catch (e) { console.warn('localStorage.setItem failed', `bpmNudge:${wfA.name}`, e); }
  }, [bpmNudgeA, wfA?.name]);
  const nudgeGridA = (deltaMs) => setGridOffsetA((v) => v + deltaMs);
  const resetGridA = () => setGridOffsetA(0);
  const nudgeBpmA = (deltaClicks) => setBpmNudgeA((v) => v + deltaClicks);
  const resetBpmA = () => setBpmNudgeA(0);

  const [gridOffsetB, setGridOffsetB] = useState(0); // milliseconds
  const [bpmNudgeB, setBpmNudgeB] = useState(0);     // in 0.01-BPM clicks
  useEffect(() => {
    if (!wfB?.name) return;
    let savedOff = null, savedBpm = null;
    try { savedOff = localStorage.getItem(`gridOffset:${wfB.name}`); } catch (e) { console.warn('localStorage.getItem failed', `gridOffset:${wfB.name}`, e); }
    try { savedBpm = localStorage.getItem(`bpmNudge:${wfB.name}`); } catch (e) { console.warn('localStorage.getItem failed', `bpmNudge:${wfB.name}`, e); }
    setGridOffsetB(savedOff ? parseFloat(savedOff) : 0);
    setBpmNudgeB(savedBpm ? parseInt(savedBpm, 10) : 0);
  }, [wfB?.name]);
  useEffect(() => {
    if (!wfB?.name) return;
    try { localStorage.setItem(`gridOffset:${wfB.name}`, String(gridOffsetB)); } catch (e) { console.warn('localStorage.setItem failed', `gridOffset:${wfB.name}`, e); }
  }, [gridOffsetB, wfB?.name]);
  useEffect(() => {
    if (!wfB?.name) return;
    try { localStorage.setItem(`bpmNudge:${wfB.name}`, String(bpmNudgeB)); } catch (e) { console.warn('localStorage.setItem failed', `bpmNudge:${wfB.name}`, e); }
  }, [bpmNudgeB, wfB?.name]);

  // Library: track which deck is playing + metadata for recommendations
  const [playingTrack, setPlayingTrack] = useState(null);
  const [libLoadA, setLibLoadA] = useState(null);
  const [libLoadB, setLibLoadB] = useState(null);
  const [partnerLibrary, setPartnerLibrary] = useState([]);

  // Driver model — loader-is-driver. Server-authoritative: room.deckDrivers
  // arrives in the "joined" message and changes via "deck_driver_change"
  // broadcasts. Mirrored into a ref so handleWS / setTimeout closures see
  // the latest value without re-creating callbacks.
  const [deckDrivers, setDeckDrivers] = useState({ A: null, B: null });
  const deckDriversRef = useRef(deckDrivers);
  useEffect(() => { deckDriversRef.current = deckDrivers; }, [deckDrivers]);

  // Driver audio routing: when partner drives a deck, mute its local engine
  // chain so my master mix only contains decks I drive. Audio for the
  // partner-driven deck reaches me via their WebRTC stream (their master is
  // the mix of decks they drive). Without this, both browsers would double-
  // play any deck both have loaded, and partner-driven decks I never loaded
  // would emit silence locally while WebRTC delivers the real audio — but
  // since I can't drive a deck I don't have a buffer for, the only case that
  // matters is: partner drives → mute local. setTargetAtTime ramps over
  // ~20ms to avoid a click on driver handoff.
  useEffect(() => {
    const e = eng.current;
    if (!e?.ctx || !e?.A || !e?.B) return;
    const myName = session?.name;
    const tc = 0.02;
    for (const id of ["A", "B"]) {
      const driver = deckDrivers[id];
      const open = !driver || driver === myName;
      try { e[id].trim.gain.setTargetAtTime(open ? 1 : 0, e.ctx.currentTime, tc); } catch {}
    }
  }, [deckDrivers, session, ready]);

  const handleTrackInfo = useCallback((deckId, trackMeta) => {
    if (trackMeta) setPlayingTrack(trackMeta);
  }, []);

  const handleLibLoad = useCallback(async (track, deck) => {
    console.log('[LIB-LOAD]',{step:'entry',id:track.id,deck,title:track.title,artist:track.artist});
    // Get the file FIRST — requestPermission and showOpenFilePicker both need the user gesture.
    // Do NOT call AudioContext.resume() before this or it consumes the gesture.
    let file = await lib.getFile(track.id);
    console.log('[LIB-LOAD]',{step:'after-getFile',id:track.id,fileFound:!!file,size:file?.size});
    if (!file) {
      console.warn('[LIB-LOAD]',{step:'picker-fallback-FIRING',id:track.id,reason:'getFile returned null/undefined'});
      // File handle expired — open picker so user can re-locate the track
      try {
        const [fileHandle] = await window.showOpenFilePicker({ types:[{description:"Audio",accept:{"audio/*":[]}}], multiple:false });
        file = await fileHandle.getFile();
        lib.fileMap?.current && (lib.fileMap.current[track.id] = file);
      } catch { return; } // user cancelled — do nothing
    }
    // Resume audio context after we have the file (still within user gesture window)
    if (eng.current?.ctx?.state === "suspended") {
      try { await eng.current.ctx.resume(); } catch {}
    }
    if (deck === "A") setLibLoadA({ track, file, ts: Date.now() });
    else              setLibLoadB({ track, file, ts: Date.now() });
    setPlayingTrack(track);
    logEvent("deck", "track_loaded", { deck, trackId: track.id, title: track.title, artist: track.artist });
    // Loader-is-driver: this user is now the audio source of truth for this deck.
    // Optimistic local set + broadcast; server echoes back to confirm (also
    // notifies partner). When solo, sync.send is a no-op.
    // Track metadata is included so partner can paint title/artist/BPM/key
    // immediately on receive, before the audio-decode-triggered deck_update
    // chain fires with the rest (waveform, duration).
    const driverName = sessionRef.current?.name || null;
    const wsState = syncRef.current?.status;
    console.log('[DRIVER-SEND]', { deck, driverName, wsState, hasSync: !!syncRef.current?.send, trackTitle: track.title });
    if (driverName) {
      setDeckDrivers(prev => prev[deck] === driverName ? prev : { ...prev, [deck]: driverName });
      const trackMeta = {
        id: track.id,
        title: track.title || track.filename || null,
        artist: track.artist || null,
        bpm: track.bpm || null,
        key: track.key || null,
        duration: track.duration || null,
      };
      syncRef.current?.send?.({ type: "deck_driver_change", deckId: deck, driverName, track: trackMeta });
      console.log('[DRIVER-SEND] dispatched', { deck, driverName });
    } else {
      console.warn('[DRIVER-SEND] no driverName — sessionRef.current?.name was null/empty');
    }
    // Defer library-side BPM/key analysis until track is loaded onto a deck.
    // Prevents bulk decoding 100s of tracks at import time which causes OOM.
    if (file && !track.analyzed && lib.queueAnalysis) {
      lib.queueAnalysis(track.id, file);
    }
  }, [lib]);

  // Delete track from local library (in-memory + IDB)
  const handleDeleteTrack = useCallback(async (trackId) => {
    lib.setLibrary?.(prev => prev.filter(t => t.id !== trackId));
    try { await cmDbDelete("tracks", trackId); await cmDbDelete("handles", trackId); } catch {}
    if (lib.fileMap?.current) delete lib.fileMap.current[trackId];
  }, [lib]);

  // Audio preview in library
  const [previewTrackId, setPreviewTrackId] = useState(null);
  const previewAudioRef = useRef(null);
  const handlePreview = useCallback(async (track) => {
    // Resume audio context on gesture
    if (eng.current?.ctx?.state === "suspended") {
      try { await eng.current.ctx.resume(); } catch {}
    }
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      try { URL.revokeObjectURL(previewAudioRef.current._url); } catch {}
      previewAudioRef.current = null;
    }
    if (previewTrackId === track.id) { setPreviewTrackId(null); return; }
    const file = await lib.getFile(track.id);
    if (!file) { alert("Preview not available — the file can't be accessed."); return; }
    const url = URL.createObjectURL(file);
    const audio = new Audio(url);
    audio._url = url;
    previewAudioRef.current = audio;
    setPreviewTrackId(track.id);
    try { await audio.play(); } catch(err) {
      // If blocked by autoplay, show helpful message
      if (err.name === "NotAllowedError") alert("Click anywhere on the page first, then try previewing.");
      setPreviewTrackId(null); previewAudioRef.current = null;
    }
    audio.onended = () => { setPreviewTrackId(null); previewAudioRef.current = null; };
  }, [previewTrackId, lib]);

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

  // DJ Filter (low-pass ↔ high-pass sweep) per channel
  const applyFilter = useCallback((ch, val) => {
    if(!eng.current) return;
    const node = ch==="A" ? eng.current.A.flt : eng.current.B.flt;
    if(!node) return;
    if(Math.abs(val)<0.04){ node.type="allpass"; return; }
    if(val<0){
      node.type="lowpass";
      node.frequency.value=Math.max(20,22000*Math.pow(10,val*2.3));
      node.Q.value=1+Math.abs(val)*4;
    } else {
      node.type="highpass";
      node.frequency.value=Math.min(18000,20*Math.pow(10,val*2.3));
      node.Q.value=1+val*4;
    }
  },[]);
  useEffect(()=>{ if(ready) applyFilter("A",eqA.filter); },[eqA.filter,ready]);
  useEffect(()=>{ if(ready) applyFilter("B",eqB.filter); },[eqB.filter,ready]);

  const handleWS = useCallback((m) => {
    if (m.type==="rtc_hangup") {
      // Schedule reconnect BEFORE rtc.handleRtc runs endCall, so we use the
      // most recent attempt count. Skip if partner already gone (server sends
      // partner_left BEFORE rtc_hangup on close). Only the elected initiator
      // retries — the answerer waits for the new offer.
      if (partnerRef.current && isInitiatorRef.current()) {
        if (rtcReconnectAttemptsRef.current < 3) {
          const attempt = rtcReconnectAttemptsRef.current + 1;
          rtcReconnectAttemptsRef.current = attempt;
          console.log(`[RTC] rtc_hangup received, attempting reconnect (attempt ${attempt}/3)`);
          clearTimeout(rtcReconnectTimerRef.current);
          rtcReconnectTimerRef.current = setTimeout(() => {
            if (partnerRef.current && rtcRef.current) {
              rtcRef.current.startCall();
            } else {
              console.log('[RTC] partner left during reconnect wait, skipping retry');
            }
          }, 1000);
        } else {
          console.log('[RTC] reconnect retries exhausted, giving up');
          setRtcReconnectExhausted(true);
        }
      } else if (partnerRef.current) {
        console.log('[RTC] rtc_hangup received as answerer, waiting for initiator to reconnect');
      }
    }
    if (m.type==="joined")        {
      if(m.partnerState?.deckA)setPA(m.partnerState.deckA);
      if(m.partnerState?.deckB)setPB(m.partnerState.deckB);
      // Server sends current per-deck drivers so a fresh joiner sees who
      // already owns each deck (if anything).
      if (m.deckDrivers) setDeckDrivers({ A: m.deckDrivers.A ?? null, B: m.deckDrivers.B ?? null });
    }
    if (m.type==="deck_driver_change") {
      const { deckId, driverName, track } = m;
      console.log('[DRIVER-RECV]', { deckId, driverName, from: m.from, myName: sessionRef.current?.name, hasTrack: !!track, trackTitle: track?.title });
      if (deckId === "A" || deckId === "B") {
        setDeckDrivers(prev => prev[deckId] === (driverName ?? null) ? prev : { ...prev, [deckId]: driverName ?? null });
        // If the broadcast carries track metadata AND it's not from me, paint
        // it into partner state immediately. Maps the trackMeta fields onto
        // the same pA/pB shape that the Deck's existing remote.* fallback
        // reads, so the partner deck shows title/artist/bpm/key without
        // waiting for the loader's decode-triggered deck_update broadcasts.
        if (track && m.from !== sessionRef.current?.name) {
          const setter = deckId === "A" ? setPA : setPB;
          setter(p => ({
            ...(p||{}),
            trackName: track.title || null,
            artist: track.artist || null,
            bpm: track.bpm || null,
            key: track.key || null,
            duration: track.duration || null,
          }));
        }
      } else {
        console.warn('[DRIVER-RECV] ignored — invalid deckId', deckId);
      }
    }
    if (m.type==="master_vol_update") {
      // Shared master fader — mirror partner's level into my engine + UI.
      setMvol(m.value);
    }
    if (m.type==="deck_update")    {
      // 1) Mirror partner's deck state for visuals
      (m.deckId==="A"?setPA:setPB)(p=>({...(p||{}),[m.field]:m.value}));
      // Track partner-driven play-start for auto-master detection. The local
      // owner-driven path updates deckPlayStartRef inside dh; this branch
      // covers the case where the partner is driving the deck.
      if (m.field === "playing" && (m.deckId === "A" || m.deckId === "B")) {
        deckPlayStartRef.current[m.deckId] = m.value ? Date.now() : null;
      }
      // SHARED mixer (both users see + control every knob). Apply remote
      // EQ / vol / filter changes to MY local engine + UI state so partner's
      // knob moves alter the mix on both browsers. Field names on the wire:
      // eqHi/eqMid/eqLo/vol/filter. Local eq state keys: hi/mid/lo/vol/filter.
      const FIELD_MAP = { eqHi:"hi", eqMid:"mid", eqLo:"lo", vol:"vol", filter:"filter" };
      const localKey = FIELD_MAP[m.field];
      if (localKey != null) {
        if (m.deckId==="A") setEqA(e=>({...e,[localKey]:m.value}));
        else if (m.deckId==="B") setEqB(e=>({...e,[localKey]:m.value}));
      }
      // Mirror global SYNC lock across browsers — both sides see the same lock
      // visual regardless of who clicked. m.deckId carries which deck the
      // remote-clicker designated as slave; we remember that so the re-sync
      // effect on this side knows which deck to re-align if BPM changes.
      // Setters/refs from useState/useRef are stable so safe from stale-deps.
      if (m.field === "syncLocked") {
        setSyncLocked(!!m.value);
        if (m.value && (m.deckId === "A" || m.deckId === "B")) {
          lastSlaveDeckRef.current = m.deckId;
          setLastSlaveDeck(m.deckId);
        }
      }
      // Mirror explicit master selection across browsers. Value is "A", "B",
      // or null. m.deckId is ignored for this field — masterDeck is global.
      if (m.field === "masterDeck") {
        const v = m.value === "A" || m.value === "B" ? m.value : null;
        masterDeckRef.current = v;
        setMasterDeck(v);
      }
    }
    if (m.type==="seek_request")   seekFnsRef.current[m.deckId]?.(m.value, true);
    if (m.type==="toggle_request") toggleFnsRef.current[m.deckId]?.(true);
    if (m.type==="cue_request")    cueFnsRef.current[m.deckId]?.(true);
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

  // Keep refs synced with the latest values so handleWS / setTimeout callbacks
  // never read stale closures.
  useEffect(() => { partnerRef.current = sync.partner; }, [sync.partner]);
  useEffect(() => { rtcRef.current = rtc; });
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => { syncRef.current = sync; });
  useEffect(() => { masterDeckRef.current = masterDeck; }, [masterDeck]);

  // Mirror live session data (partner, ping) into Sentry context for crash reports.
  useEffect(() => {
    if (!session) return;
    const isHost = !new URLSearchParams(window.location.search).has("room");
    setSessionContext({
      djName: session.name,
      roomCode: session.room,
      isHost,
      partnerName: sync.partner || null,
      ping: sync.ping ?? null,
    });
  }, [session, sync.partner, sync.ping]);

  // Cmd+Shift+E (or Ctrl+Shift+E) — throw a test error so Sentry capture can be verified.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "E" || e.key === "e")) {
        e.preventDefault();
        throw new Error("Sentry test error — triggered by Cmd+Shift+E");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Deterministic role election to avoid WebRTC offer/answer glare.
  // Lexicographically smaller name initiates; same-name fallback uses URL
  // ?room= presence (host = no param = initiator). The handleAnswer
  // InvalidStateError catch is the safety net for any election ambiguity.
  const isInitiatorRole = useCallback(() => {
    const myName = session?.name || "";
    const partnerName = partnerRef.current;
    if (!partnerName) return false;
    if (myName !== partnerName) return myName < partnerName;
    return !new URLSearchParams(window.location.search).get('room');
  }, [session]);

  // Mirror role-election helper into a ref so handleWS (stale-deps useCallback)
  // can call the freshest version. Must follow isInitiatorRole declaration.
  useEffect(() => { isInitiatorRef.current = isInitiatorRole; }, [isInitiatorRole]);

  // Reset reconnect counter when WebRTC successfully connects.
  useEffect(() => {
    if (rtc.state === "connected") {
      rtcReconnectAttemptsRef.current = 0;
      setRtcReconnectExhausted(false);
    }
  }, [rtc.state]);

  // Auto-start WebRTC ~500ms after a partner is detected. Only the elected
  // initiator calls startCall; the answerer waits for the incoming offer.
  // Skip if rtc is already past idle (partner's offer beat us to it).
  useEffect(() => {
    if (!sync.partner) return;
    rtcReconnectAttemptsRef.current = 0;
    setRtcReconnectExhausted(false);
    const initiator = isInitiatorRole();
    console.log(`[RTC] role determination: localName=${session?.name}, partnerName=${sync.partner}, role=${initiator?"initiator":"answerer"}`);
    if (!initiator) {
      console.log('[RTC] answerer waiting for incoming offer (not calling startCall)');
      return;
    }
    console.log('[RTC] initiator scheduling startCall in 500ms');
    const timer = setTimeout(() => {
      const r = rtcRef.current;
      if (r && r.state === "idle") r.startCall();
      else console.log('[RTC] auto-start skipped, rtc state was:', r?.state);
    }, 500);
    return () => clearTimeout(timer);
  }, [sync.partner, session, isInitiatorRole]);

  // Cancel any pending reconnect on unmount.
  useEffect(() => () => clearTimeout(rtcReconnectTimerRef.current), []);

  // Auto-connect WebSocket on session mount. The original flow opened the
  // socket from <Lobby>'s join() call, but the landing-page bypass shortcut
  // (initial page="session") skipped Lobby entirely. Without this effect,
  // sync.connect() was never invoked and partner sync silently no-op'd.
  // Honors ?room= URL param so two browser windows can land on the same room.
  useEffect(() => {
    if (page !== "session") return;
    if (sync.status !== "disconnected") return;
    const params = new URLSearchParams(window.location.search);
    const roomFromUrl = params.get("room");
    const roomId = roomFromUrl || session.room;
    sync.connect(roomId, session.name);
    return () => { sync.disconnect(); };
    // sync.connect/disconnect are stable useCallbacks; depending only on page
    // ensures we open one socket per session entry, cleanly torn down on leave.
  }, [page]);

  const handleMidi = useCallback(({actionKey,value}) => {
    setMidiEvt({actionKey,value,ts:Date.now()});
    if (actionKey==="CROSSFADER") { setXf(value); applyXF(value); sync.send({type:"xfade_update",value}); }
    if (actionKey==="MASTER_VOL") { const mv=value*1.5; setMvol(mv); lsRef.current.masterVol=mv; sync.send({type:"master_vol_update",value:mv}); }
  }, [applyXF, sync]);

  const midi = useMidi({ onAction: handleMidi });

  // Master's EFFECTIVE BPM (natural × current rate). When a deck has been
  // rate-adjusted by a prior sync, sync targets must use its effective BPM,
  // not its raw natural BPM — otherwise the slave aligns to the wrong tempo.
  // Local-driven deck: rate lives in rateA/rateB. Partner-driven deck: rate
  // is mirrored in pA?.rate / pB?.rate (broadcast by syncDecks via deck_update).
  const getEffectiveMasterBpm = useCallback((master) => {
    const natural = bpm.results[master]?.bpm || (master === "A" ? pA?.bpm : pB?.bpm);
    if (!natural) return null;
    const localRate = master === "A" ? rateA : rateB;
    const partnerRate = master === "A" ? pA?.rate : pB?.rate;
    // Use local rate when we have local BPM (we own the analysis path), else
    // fall back to partner-broadcast rate. Default 1.
    const rate = bpm.results[master]?.bpm ? localRate : (partnerRate || 1);
    const effective = natural * (rate || 1);
    console.log("[SYNC] master effective BPM: natural=" + natural.toFixed(2) + " rate=" + (rate||1).toFixed(4) + " effective=" + effective.toFixed(2));
    return effective;
  }, [bpm.results, pA, pB, rateA, rateB]);

  // BPM match + beat-phase alignment.
  // Slave = the deck the user clicked SYNC on (modified). Master = the OTHER deck.
  const syncDecks = useCallback((slave, targetBPM) => {
    const srcBPM = bpm.results[slave]?.bpm;
    console.log("[SYNC] triggered for deck", slave, "sourceBPM=", srcBPM, "targetBPM=", targetBPM);
    if (!srcBPM || !targetBPM) {
      console.log("[SYNC] no target BPM available, ignoring (srcBPM=", srcBPM, "targetBPM=", targetBPM, ")");
      return;
    }
    const rate = targetBPM / srcBPM;
    if (Math.abs(rate-1) > 0.12) {
      console.log("[SYNC] ignored, rate", rate, "outside ±12% safety window");
      return;
    }
    if (slave==="A") {
      setRateA(rate);
      const el = document.querySelector("[data-set-rate='A']");
      if (el?._setRate) el._setRate(rate);
    } else {
      setRateB(rate);
      const el = document.querySelector("[data-set-rate='B']");
      if (el?._setRate) el._setRate(rate);
    }
    console.log("[SYNC] applied rate=", rate);

    // Phase alignment — fall back to partner-broadcast phase data when the
    // master deck is partner-driven and we have no local analyzer result.
    const master = slave==="A" ? "B" : "A";
    const masterPartnerState = master==="A" ? pA : pB;
    const slavePartnerState  = slave==="A"  ? pA : pB;
    const slaveBps   = bpm.results[slave]?.beatPeriodSec   ?? slavePartnerState?.beatPeriodSec;
    const slaveBphs  = bpm.results[slave]?.beatPhaseSec    ?? slavePartnerState?.beatPhaseSec;
    const masterBps  = bpm.results[master]?.beatPeriodSec  ?? masterPartnerState?.beatPeriodSec;
    const masterBphs = bpm.results[master]?.beatPhaseSec   ?? masterPartnerState?.beatPhaseSec;
    const slaveDur   = slave==="A"  ? wfA?.dur : wfB?.dur;
    const slaveProg  = slave==="A"  ? progRefA.current : progRefB.current;
    const masterProg = master==="A" ? progRefA.current : progRefB.current;
    const masterDur  = master==="A" ? wfA?.dur : wfB?.dur;
    const slaveCurTime  = (slaveProg  || 0) * (slaveDur  || 0);
    const masterCurTime = (masterProg || 0) * (masterDur || 0);

    if (slaveBps == null || slaveBphs == null || masterBps == null || masterBphs == null || !slaveDur) {
      console.log("[SYNC] phase data missing, skipping phase alignment", { slaveBps, slaveBphs, masterBps, masterBphs, slaveDur });
    } else {
      // Bar-level (4-beat) alignment so we land on the same beat-1 of the bar,
      // not just any beat. Max nudge is 0.5 bars = 2 beats = ~1s at 120 BPM.
      // TODO: downbeat detection. Currently assumes first detected beat is
      // bar 1 beat 1 — sometimes wrong. Beat-grid editing tools are the fix.
      const beatsPerBar  = 4;
      const masterBarSec = masterBps * beatsPerBar;
      const slaveBarSec  = slaveBps  * beatsPerBar;
      const masterBarPos  = (masterCurTime - masterBphs) / masterBarSec;
      const masterBarFrac = masterBarPos - Math.floor(masterBarPos);
      const slaveBarPos   = (slaveCurTime  - slaveBphs)  / slaveBarSec;
      const slaveBarFrac  = slaveBarPos  - Math.floor(slaveBarPos);
      let phaseOffsetBars = masterBarFrac - slaveBarFrac;
      if (phaseOffsetBars >  0.5) phaseOffsetBars -= 1;
      if (phaseOffsetBars < -0.5) phaseOffsetBars += 1;
      const phaseOffsetSeconds = phaseOffsetBars * slaveBarSec;
      console.log("[SYNC] bar phase before: master=", masterBarFrac.toFixed(3), "slave=", slaveBarFrac.toFixed(3), "(in bars)");
      const newSlaveTime = slaveCurTime + phaseOffsetSeconds;
      const newSlaveProg = Math.max(0, Math.min(1, newSlaveTime / slaveDur));
      // seekFnsRef.current[slave] is the local Deck's seek; it already
      // broadcasts seek_request to the partner so their playhead follows.
      seekFnsRef.current[slave]?.(newSlaveProg);
      console.log("[SYNC] bar phase nudged slave by", phaseOffsetSeconds.toFixed(3), "seconds (newProg=", newSlaveProg.toFixed(4), ")");
      const newSlaveBarPos = (newSlaveTime - slaveBphs) / slaveBarSec;
      const newSlaveBarFrac = newSlaveBarPos - Math.floor(newSlaveBarPos);
      console.log("[SYNC] bar phase after: master=", masterBarFrac.toFixed(3), "slave=", newSlaveBarFrac.toFixed(3), "(in bars)");
    }

    // Broadcast rate so partner mirrors the speed change. Mirrors lsRef pattern
    // used elsewhere for deck_update so sync_response carries rate too.
    const k = `deck${slave}`;
    lsRef.current[k] = { ...(lsRef.current[k]||{}), rate };
    sync.send({ type:"deck_update", deckId: slave, field: "rate", value: rate });
  }, [bpm.results, sync, pA, pB, wfA, wfB]);

  // Global SYNC toggle. The slave is the clicked deck (or the not-master deck
  // when an explicit master is set). Master is whichever has M turned on,
  // else implicit "the other deck". OFF→ON: run syncDecks(slave→masterBPM),
  // set lock, broadcast (carrying the slave's deckId so partners know which
  // side is being driven). ON→OFF: just clear lock, broadcast.
  const handleSyncToggle = useCallback((clickedDeck) => {
    const now = Date.now();
    if (now - lastSyncToggleMsRef.current < 200) {
      console.log("[SYNC] toggle ignored: re-entry guard (<200ms since last toggle)");
      return;
    }
    lastSyncToggleMsRef.current = now;
    if (syncLocked) {
      console.log("[SYNC] toggle OFF");
      setSyncLocked(false);
      const broadcastDeck = lastSlaveDeckRef.current || clickedDeck;
      const k = `deck${broadcastDeck}`;
      lsRef.current[k] = { ...(lsRef.current[k]||{}), syncLocked: false };
      sync.send({ type:"deck_update", deckId: broadcastDeck, field: "syncLocked", value: false });
      logEvent("sync", "toggle", { locked: false, slave: broadcastDeck });
      return;
    }
    const explicitMaster = masterDeckRef.current; // "A" | "B" | null
    let effectiveMaster, slaveDeck = clickedDeck, masterMode;
    if (explicitMaster) {
      if (clickedDeck === explicitMaster) {
        console.log("[SYNC] toggle blocked: clicked deck is the explicit master (can't sync a deck to itself)");
        return;
      }
      effectiveMaster = explicitMaster;
      masterMode      = "explicit";
      console.log("[SYNC] explicit master: deck", effectiveMaster);
    } else {
      // Auto-detect: deck that started playing FIRST is master.
      const tA = deckPlayStartRef.current.A;
      const tB = deckPlayStartRef.current.B;
      let auto = null;
      if (tA && tB)      auto = tA < tB ? "A" : "B";
      else if (tA)       auto = "A";
      else if (tB)       auto = "B";
      if (auto && auto !== clickedDeck) {
        effectiveMaster = auto;
        masterMode      = "auto";
        console.log("[SYNC] auto-master: deck", effectiveMaster, "(playing longer)");
      } else {
        // No auto signal, or user clicked the deck that's been playing longer.
        // Fall back to implicit "other deck" rule — clicked deck is slave.
        effectiveMaster = clickedDeck === "A" ? "B" : "A";
        masterMode      = "implicit";
        console.log("[SYNC] implicit master: deck", effectiveMaster, "(no auto signal or clicked auto-master)");
      }
    }
    const masterBPM = getEffectiveMasterBpm(effectiveMaster);
    if (!masterBPM) {
      console.log("[SYNC] toggle blocked: no master BPM available (mode=" + masterMode + ", master=" + effectiveMaster + ")");
      return;
    }
    console.log("[SYNC] toggle ON — slave=", slaveDeck, "master=", effectiveMaster, "mode=", masterMode, "effectiveBpm=", masterBPM);
    syncDecks(slaveDeck, masterBPM);
    lastSlaveDeckRef.current = slaveDeck;
    setLastSlaveDeck(slaveDeck);
    setSyncLocked(true);
    const k = `deck${slaveDeck}`;
    lsRef.current[k] = { ...(lsRef.current[k]||{}), syncLocked: true };
    sync.send({ type:"deck_update", deckId: slaveDeck, field: "syncLocked", value: true });
    // Light up the M indicator on the effective master so the user sees which
    // deck is the reference. They can override with the M button at any time.
    // Skip if already set explicitly (no need to re-broadcast).
    if (!explicitMaster) {
      masterDeckRef.current = effectiveMaster;
      setMasterDeck(effectiveMaster);
      sync.send({ type:"deck_update", deckId: effectiveMaster, field: "masterDeck", value: effectiveMaster });
    }
    logEvent("sync", "toggle", { locked: true, slave: slaveDeck, master: effectiveMaster, mode: masterMode });
  }, [syncLocked, syncDecks, bpm.results, pA, pB, sync, getEffectiveMasterBpm]);

  // Explicit master toggle. Click M on a deck → mark as master; click again
  // → clear (no explicit master, SYNC will fall back to implicit logic).
  // Clicking M on the OTHER deck moves master to that deck (only one master
  // at a time). Broadcasts to partner. When syncLocked, swapping master also
  // re-runs syncDecks with the new slave/master roles (handled by the master-
  // change effect below). Clearing master while locked keeps the current
  // slave (the re-sync effect will continue using lastSlaveDeck-implicit).
  const handleMasterToggle = useCallback((deck) => {
    const cur = masterDeckRef.current;
    const next = cur === deck ? null : deck;
    masterDeckRef.current = next;
    setMasterDeck(next);
    sync.send({ type:"deck_update", deckId: deck, field: "masterDeck", value: next });
    if (next == null) {
      console.log("[MASTER] cleared (no explicit master)");
      logEvent("sync", "master_set", { master: null });
    } else {
      console.log("[MASTER] explicitly set to deck", next);
      logEvent("sync", "master_set", { master: next });
    }
  }, [sync]);

  // Wrapper around sync.send for the Deck's onTransportFire prop. Forwards
  // every transport event to the partner (existing behavior) AND, when the
  // event is a scrub (seek_request) while the global lock is engaged, schedules
  // an auto re-align of the slave to the master. 100ms debounce so the timer
  // resets if the user keeps dragging; 200ms throttle so the auto-resync
  // itself (which seeks the slave) can't trigger a sync storm. Re-syncs on
  // EITHER deck's scrub — slave moved → realign; master moved → reference
  // changed → realign.
  const handleTransportFire = useCallback((msg) => {
    sync.send(msg);
    if (!syncLocked) return;
    if (msg?.type !== "seek_request") return;
    clearTimeout(scrubResyncTimerRef.current);
    scrubResyncTimerRef.current = setTimeout(() => {
      const now = Date.now();
      if (now - lastScrubResyncTimeRef.current < 200) return;
      const slave = lastSlaveDeckRef.current;
      if (slave !== "A" && slave !== "B") return;
      const explicitMaster = masterDeckRef.current;
      const master = explicitMaster && explicitMaster !== slave ? explicitMaster : (slave === "A" ? "B" : "A");
      // Once locked, session tempo is the target — not the master's current
      // effective BPM, which may have drifted (e.g., master just loaded a new
      // track and hasn't been re-rated by the track-change effect yet).
      const target = sessionTempoRef.current ?? getEffectiveMasterBpm(master);
      if (!target) return;
      lastScrubResyncTimeRef.current = now;
      console.log("[SYNC] scrub detected while locked — auto re-aligning slave to session tempo", target.toFixed(2));
      syncDecks(slave, target);
    }, 100);
  }, [syncLocked, bpm.results, pA, pB, syncDecks, sync, getEffectiveMasterBpm]);

  const bpmAValue = bpm.results["A"]?.bpm;
  const bpmBValue = bpm.results["B"]?.bpm;

  // Capture or release the session tempo on syncLocked transitions. Both
  // engagement and partner-driven mirror updates go through this single
  // effect, so the tempo stays consistent on both browsers.
  useEffect(() => {
    if (syncLocked) {
      const slave = lastSlaveDeckRef.current;
      const explicitMaster = masterDeckRef.current;
      const master = explicitMaster && explicitMaster !== slave ? explicitMaster : (slave === "A" ? "B" : "A");
      const tempo = getEffectiveMasterBpm(master);
      if (tempo) {
        sessionTempoRef.current = tempo;
        console.log("[SYNC] session tempo locked at", tempo.toFixed(2), "(master=", master, ")");
      }
    } else {
      if (sessionTempoRef.current !== null) {
        console.log("[SYNC] session tempo released (was", sessionTempoRef.current.toFixed(2), ")");
      }
      sessionTempoRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncLocked]);

  // Track-change detection. Once sync is locked, the session tempo is the
  // source of truth for BOTH decks. When a new track is loaded and analyzed
  // on EITHER deck, re-rate that deck to match the session tempo (and re-
  // align its phase to the other deck via syncDecks's existing phase logic).
  // Detection uses each deck's natural BPM (bpm.results[X].bpm, with partner
  // pX.bpm fallback). Per-deck prev refs skip the initial baseline read so
  // we only fire on actual changes, not on first detection after lock.
  const prevBpmARef = useRef(null);
  const prevBpmBRef = useRef(null);
  useEffect(() => {
    if (!syncLocked) {
      prevBpmARef.current = null;
      prevBpmBRef.current = null;
      return;
    }
    const tempo = sessionTempoRef.current;
    if (!tempo) return;
    for (const deck of ["A", "B"]) {
      const localBpm = bpm.results[deck]?.bpm;
      const remoteBpm = deck === "A" ? pA?.bpm : pB?.bpm;
      const naturalBpm = localBpm || remoteBpm;
      if (!naturalBpm) continue;
      const prevRef = deck === "A" ? prevBpmARef : prevBpmBRef;
      if (prevRef.current === null) {
        prevRef.current = naturalBpm;
        continue;
      }
      if (prevRef.current === naturalBpm) continue;
      prevRef.current = naturalBpm;
      console.log(`[SYNC] track changed on deck ${deck} while locked — re-aligning to session tempo ${tempo.toFixed(2)}`);
      syncDecks(deck, tempo);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncLocked, bpmAValue, bpmBValue, pA?.bpm, pB?.bpm]);

  // Mid-lock master change. Metadata-only — never touches audio rates.
  // - If masterDeck moved onto the deck that was slave, swap roles
  //   (update lastSlaveDeckRef → the other deck). Rates STAY.
  // - Clear scrub-resync throttle so a fresh scrub can re-align with the
  //   new master/slave pairing.
  // - Session tempo is NOT changed by an M-button flip — switching master
  //   is metadata only, the session tempo stays where it was locked.
  useEffect(() => {
    if (!syncLocked) return;
    if (!masterDeck) return;
    const currentSlave = lastSlaveDeckRef.current;
    if (masterDeck === currentSlave) {
      const newSlave = masterDeck === "A" ? "B" : "A";
      lastSlaveDeckRef.current = newSlave;
      setLastSlaveDeck(newSlave);
      console.log("[SYNC] role swap via M — new slave=", newSlave, "new master=", masterDeck, "(audio unchanged)");
    } else {
      console.log("[SYNC] master changed mid-lock — slave=", currentSlave, "master=", masterDeck, "(audio unchanged)");
    }
    lastScrubResyncTimeRef.current = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [masterDeck, syncLocked]);

  // EQ / channel volume / filter are SHARED CONTROLS — both users see and
  // adjust every knob, all changes broadcast both directions in real time.
  // Note: NOT driver-gated. Shared mixer state is control state, not audio
  // source state — anyone can twist anyone's knobs (Option C in driver-model
  // terminology, see dh below for the SHARED_FIELDS allowlist).
  const updateEqA = useCallback((field, val) => {
    setEqA(e => ({...e, [field]:val}));
    const wsField = field==="vol"?"vol":field==="filter"?"filter":`eq${field.charAt(0).toUpperCase()+field.slice(1)}`;
    lsRef.current.deckA = {...(lsRef.current.deckA||{}), [wsField]:val};
    sync.send({type:"deck_update", deckId:"A", field:wsField, value:val});
  }, []);

  const updateEqB = useCallback((field, val) => {
    setEqB(e => ({...e, [field]:val}));
    const wsField = field==="vol"?"vol":field==="filter"?"filter":`eq${field.charAt(0).toUpperCase()+field.slice(1)}`;
    lsRef.current.deckB = {...(lsRef.current.deckB||{}), [wsField]:val};
    sync.send({type:"deck_update", deckId:"B", field:wsField, value:val});
  }, []);

  // SHARED fields bypass the driver gate — both users twist any knob on any
  // deck and all changes broadcast/apply both ways. These are CONTROL fields
  // (mixer state), not AUDIO source fields. Crossfader + master volume use
  // their own message types (xfade_update / master_vol_update) and never
  // reach dh. "masterVol" is in the set for defensive consistency in case
  // any future code path routes master vol through dh.
  // DRIVER-ONLY fields (the implicit complement): playing, progress, rate,
  // duration, trackName, artist, key, bpm, beatPhaseSec, beatPeriodSec,
  // waveformBass/Mid/High — i.e. anything that describes WHAT is playing or
  // WHERE the playhead is. Only the deck's driver should overwrite those.
  const SHARED_FIELDS = new Set(["eqHi","eqMid","eqLo","vol","filter","masterVol"]);
  const dh = (id) => (field, value) => {
    if (field === "playing") {
      deckPlayStartRef.current[id] = value ? Date.now() : null;
    }
    if (field === "rate") {
      if (id === "A") setRateA(value);
      else if (id === "B") setRateB(value);
    }
    const k = `deck${id}`;
    lsRef.current[k] = { ...(lsRef.current[k]||{}), [field]: value };
    // Driver-only broadcast (audio source state). Skips the gate for SHARED
    // control fields so the mixer stays bidirectional. Empty-deck case (no
    // driver yet) also broadcasts — preserves solo + pre-load behavior.
    if (!SHARED_FIELDS.has(field)) {
      const driver = deckDriversRef.current?.[id];
      const myName = sessionRef.current?.name;
      if (driver && myName && driver !== myName) return;
    }
    sync.send({ type:"deck_update", deckId:id, field, value });
  };

  const setXfLocal = (v) => { setXf(v); applyXF(v); lsRef.current.xfade=v; sync.send({type:"xfade_update",value:v}); };
  // Shared master fader — wrap setMvol so every move broadcasts. lsRef carries
  // it forward as masterVol for sync_response replay to new joiners.
  const setMvolLocal = (v) => { setMvol(v); lsRef.current.masterVol=v; sync.send({type:"master_vol_update",value:v}); };

  const join = (info) => {
    eng.current = createEngine();
    setReady(true); setSession(info); setPage("session");
    sync.connect(info.room, info.name);
    const isHost = !new URLSearchParams(window.location.search).has("room");
    setSessionContext({ djName: info.name, roomCode: info.room, isHost });
    logEvent("session", "room_joined", { roomCode: info.room, isHost });
    // Persist session so library app can link back and page reloads auto-rejoin
    try {
      localStorage.setItem("cm_session", JSON.stringify({
        room: info.room,
        name: info.name,
        mixName: info.mixName || "Untitled Mix",
      }));
    } catch {}
  };

  const leave = () => {
    rtc.endCall(); sync.disconnect();
    setReady(false); setSession(null); setPage("landing");
    eng.current = null; setRateA(1); setRateB(1);
    try { localStorage.removeItem("cm_session"); } catch {}
    window.history.replaceState({}, "", window.location.pathname);
  };

  // Auto-rejoin on mount.
  // Path 1: URL has both ?room and ?name (library app handoff) — use directly.
  // Path 2: localStorage has cm_session from a previous join — refresh-during-session
  //         should land back in the same Mix instead of bouncing to Landing.
  // leave() clears cm_session, so post-leave refresh correctly returns to Landing.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const paramRoom = params.get("room");
    const paramName = params.get("name");
    const paramMix  = params.get("mix");
    if (paramRoom && paramName) {
      window.history.replaceState({}, "", window.location.pathname);
      join({ room: paramRoom, name: paramName, mixName: paramMix || "Untitled Mix" });
      return;
    }
    try {
      const saved = localStorage.getItem("cm_session");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed?.room && parsed?.name) {
          // Strip URL params (e.g., ?room= from invite link) — localStorage is source of truth
          window.history.replaceState({}, "", window.location.pathname);
          join({
            room: parsed.room,
            name: parsed.name,
            mixName: parsed.mixName || "Untitled Mix",
          });
        }
      }
    } catch (err) {
      console.warn("Could not parse cm_session:", err);
    }
  }, []);

  // Sync library metadata to partner when library changes
  useEffect(() => {
    if (!session) return;
    const meta = lib.library.map(({ file, ...rest }) => rest);
    sync.send({ type:"library_sync", tracks: meta });
  }, [lib.library, session]);

  const SC = { connected:"#22c55e", connecting:"#f59e0b", disconnected:"#555562", error:"#ef4444" };
  const PANELS = [["rtc","⚡ AUDIO"],["rec","⏺ REC"],["midi","⎍ MIDI"]];

  if (page==="landing") return <Landing onEnter={()=>setPage("lobby")}/>;
  if (page==="lobby")   return <Lobby onJoin={join} djName={djName}/>;

  const G = "#C8A96E"; // gold accent — matches App.jsx landing
  return (
    <div style={{ height:"100vh", overflow:"hidden", background:"#0a0a0f", fontFamily:"'DM Sans',sans-serif", color:"#d8d8e2", display:"flex", flexDirection:"column" }}>
      <style>{`
        @keyframes blink{0%,100%{box-shadow:0 0 5px currentColor}50%{box-shadow:0 0 14px currentColor}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
        @keyframes wave{0%,100%{transform:scaleY(.3)}50%{transform:scaleY(1)}}
        @keyframes spin{to{transform:rotate(360deg)}}
        *{box-sizing:border-box}
        ::-webkit-scrollbar{width:3px}::-webkit-scrollbar-track{background:#080808}::-webkit-scrollbar-thumb{background:#252530;border-radius:2px}
      `}</style>
      <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=DM+Sans:wght@300;400;500&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>

      {/* TOP BAR — matches App.jsx nav */}
      <div style={{ background:"#08080cf0", backdropFilter:"blur(16px)", borderBottom:"1px solid #1c1c24", padding:"8px 18px", display:"flex", alignItems:"center", gap:12, flexShrink:0 }}>
        <div onClick={()=>leave()} style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer" }}>
          <div style={{ width:28, height:28, borderRadius:7, border:`1px solid ${G}38`, display:"flex", alignItems:"center", justifyContent:"center", background:`${G}08` }}>
            <span style={{ fontFamily:"'DM Mono',monospace", fontSize:9, color:G }}>{"//"}</span>
          </div>
          <span style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:18, fontWeight:700, color:"#d8d8e2", letterSpacing:-0.3 }}>Mix<span style={{ color:G }}>//</span>Sync</span>
        </div>
        <div style={{ flex:1, display:"flex", gap:10, alignItems:"center" }}>
          <div style={{ display:"flex", gap:5, alignItems:"center", fontSize:7, fontFamily:"'DM Mono',monospace" }}>
            <div style={{ width:5, height:5, borderRadius:"50%", background:SC[sync.status], boxShadow:sync.status==="connected"?`0 0 8px ${SC[sync.status]}`:""}}/>
            <span style={{ color:SC[sync.status], letterSpacing:1 }}>{sync.status.toUpperCase()}</span>
            {sync.ping&&<span style={{ color:"#555562" }}>· {sync.ping}ms</span>}
          </div>
          {sync.connErr && <span style={{ fontSize:9, fontFamily:"'DM Mono',monospace", color:"#ef4444", background:"#ef444411", border:"1px solid #ef444422", borderRadius:4, padding:"1px 8px" }}>{sync.connErr}</span>}
          {sync.partner&&<div style={{ fontSize:9, fontFamily:"'DM Mono',monospace", color:G, background:`${G}0e`, border:`1px solid ${G}28`, borderRadius:5, padding:"2px 10px", letterSpacing:.5 }}>⟺ {sync.partner}</div>}
          {(() => {
            // AUDIO status pill — surfaces WebRTC state so users know if partner audio is flowing.
            const isBusy = ["offering","answering","connecting"].includes(rtc.state);
            const status =
              !sync.partner            ? { label:"AUDIO: OFFLINE",       c:"#555562", pulse:false }
              : rtcReconnectExhausted  ? { label:"AUDIO: FAILED",        c:"#ef4444", pulse:false }
              : rtc.state==="connected"? { label:"AUDIO: STREAMING",     c:"#22c55e", pulse:false }
              : rtc.state==="failed"   ? { label:"AUDIO: FAILED",        c:"#ef4444", pulse:false }
              : isBusy                 ? { label:"AUDIO: CONNECTING…",   c:"#f59e0b", pulse:true  }
              :                          { label:"AUDIO: CONNECTING…",   c:"#f59e0b", pulse:true  };
            return (
              <div style={{ fontSize:9, fontFamily:"'DM Mono',monospace", color:status.c, background:`${status.c}0d`, border:`1px solid ${status.c}33`, borderRadius:5, padding:"2px 10px", letterSpacing:.5, display:"flex", gap:6, alignItems:"center" }}>
                <div style={{ width:5, height:5, borderRadius:"50%", background:status.c, boxShadow:`0 0 6px ${status.c}`, animation: status.pulse?"pulse .9s infinite":"none" }}/>
                <span>{status.label}</span>
              </div>
            );
          })()}
          {rec.state==="recording"&&<div style={{ fontSize:9, fontFamily:"'DM Mono',monospace", color:"#ef4444", background:"#ef444411", border:"1px solid #ef444428", borderRadius:5, padding:"2px 10px", animation:"pulse .8s infinite", letterSpacing:.5 }}>REC {String(Math.floor(rec.dur/60)).padStart(2,"0")}:{String(Math.floor(rec.dur%60)).padStart(2,"0")}</div>}
          {midi.active&&<div style={{ fontSize:9, fontFamily:"'DM Mono',monospace", color:G, background:`${G}0d`, border:`1px solid ${G}28`, borderRadius:5, padding:"2px 10px", letterSpacing:.5 }}>MIDI</div>}
        </div>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          <span style={{ fontSize:9, fontFamily:"'DM Mono',monospace", color:"#888898", letterSpacing:.5 }}>{session.name}</span>
          <ShareButton room={session.room} mixName={session.mixName}/>
          <button onClick={leave} style={{ height:24, padding:"0 10px", background:"transparent", border:"1px solid #ef444433", color:"#ef4444", borderRadius:6, cursor:"pointer", fontFamily:"'DM Mono',monospace", fontSize:9, letterSpacing:.5 }}>LEAVE</button>
        </div>
      </div>

      {/* AUTOPLAY-BLOCKED BANNER — shown when the browser blocked the partner audio
          element from playing. The document-level click handler in useRTC will
          retry play() on the next click anywhere, so the banner is informational. */}
      {rtc.autoplayBlocked && (
        <div style={{ flexShrink:0, padding:"8px 14px", background:"#f59e0b18", borderBottom:"1px solid #f59e0b44", color:"#f59e0b", fontSize:11, fontFamily:"'DM Mono',monospace", letterSpacing:.5, textAlign:"center" }}>
          🔇 Click anywhere to enable partner audio
        </div>
      )}

      {/* MAIN CONTENT AREA */}
      <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"visible", minHeight:0 }}>

      {/* ── FULL-WIDTH WAVEFORM SECTION — dynamic heights based on how many decks are loaded ── */}
      {(() => {
        const hasA = !!wfA?.bass;
        const hasB = !!wfB?.bass;
        if (!hasA && !hasB) {
          return (
            <div style={{ flexShrink:0, height:40, background:"#020208", borderBottom:"1px solid #16161e", display:"flex", alignItems:"center", justifyContent:"center", color:"#4a4a5a", fontSize:9, fontFamily:"'DM Mono',monospace", letterSpacing:3, textTransform:"uppercase" }}>
              No track loaded — drop tracks below to start
            </div>
          );
        }
        // Each waveform always renders at the single-deck height — when both
        // decks are loaded the waveform SECTION doubles in total vertical
        // area instead of each canvas shrinking. Splitting fixed space made
        // maxH collapse, which was visually flattening drops despite the
        // height math being correct. Deck panels below shift down to make
        // room; their fixed 288px row stays intact.
        const wfH = 90;
        return (
          <div style={{ flexShrink:0, background:"#020208", borderBottom:"1px solid #16161e" }}>
            {hasA && (
              <div
                onDragOver={e=>e.preventDefault()}
                onDrop={e=>{
                  e.preventDefault(); e.stopPropagation();
                  try {
                    const d = JSON.parse(e.dataTransfer.getData("application/json"));
                    if (d?.trackId) {
                      const t = lib.library.find(x => x.id === d.trackId);
                      if (t) handleLibLoad(t, "A");
                    }
                  } catch {}
                }}
                style={{ position:"relative", minHeight:wfH, flexShrink:0 }}>
                <div style={{ position:"absolute", top:6, left:10, zIndex:2, display:"flex", gap:8, alignItems:"center", pointerEvents:"none" }}>
                  <div style={{ width:5, height:5, borderRadius:"50%", background:"#C8A96E", boxShadow:"0 0 6px #C8A96E" }}/>
                  <span style={{ fontSize:9, fontFamily:"'DM Mono',monospace", fontWeight:700, color:"#C8A96E88", letterSpacing:2 }}>A</span>
                </div>
                <div style={{ position:"absolute", top:6, right:10, zIndex:2, display:"flex", gap:6, alignItems:"center" }}>
                  <div style={{ display:"flex", gap:2, alignItems:"center", opacity:wfA?.name?1:0.35 }}>
                    <button onClick={()=>nudgeGridA(-5)} disabled={!wfA?.name} title="Shift grid 5ms earlier" style={{ height:18, width:18, padding:0, fontSize:10, fontFamily:"'DM Mono',monospace", background:"transparent", border:"1px solid #ffffff18", color:"#ffffff88", borderRadius:3, cursor:wfA?.name?"pointer":"default", outline:"none" }}>←</button>
                    <div onDoubleClick={resetGridA} title="Double-click to reset" style={{ minWidth:44, textAlign:"center", height:18, lineHeight:"18px", padding:"0 4px", fontSize:8, fontFamily:"'DM Mono',monospace", color: gridOffsetA===0 ? "#ffffff44" : "#ef4444", background: gridOffsetA===0 ? "transparent" : "#ef444411", border: `1px solid ${gridOffsetA===0 ? "#ffffff14" : "#ef444433"}`, borderRadius:3, userSelect:"none" }}>{gridOffsetA>0?"+":""}{gridOffsetA}ms</div>
                    <button onClick={()=>nudgeGridA(5)} disabled={!wfA?.name} title="Shift grid 5ms later" style={{ height:18, width:18, padding:0, fontSize:10, fontFamily:"'DM Mono',monospace", background:"transparent", border:"1px solid #ffffff18", color:"#ffffff88", borderRadius:3, cursor:wfA?.name?"pointer":"default", outline:"none" }}>→</button>
                  </div>
                  <div style={{ display:"flex", gap:2, alignItems:"center", opacity:wfA?.name?1:0.35 }}>
                    <button onClick={()=>nudgeBpmA(-1)} disabled={!wfA?.name} title="Decrease BPM by 0.01" style={{ height:18, padding:"0 4px", fontSize:8, fontFamily:"'DM Mono',monospace", background:"transparent", border:"1px solid #ffffff18", color:"#ffffff88", borderRadius:3, cursor:wfA?.name?"pointer":"default", outline:"none" }}>BPM−</button>
                    <div onDoubleClick={resetBpmA} title="Double-click to reset" style={{ minWidth:60, textAlign:"center", height:18, lineHeight:"18px", padding:"0 4px", fontSize:8, fontFamily:"'DM Mono',monospace", color: bpmNudgeA===0 ? "#ffffff44" : "#ef4444", background: bpmNudgeA===0 ? "transparent" : "#ef444411", border: `1px solid ${bpmNudgeA===0 ? "#ffffff14" : "#ef444433"}`, borderRadius:3, userSelect:"none" }}>{bpmNudgeA>0?"+":""}{(bpmNudgeA*0.01).toFixed(2)} BPM</div>
                    <button onClick={()=>nudgeBpmA(1)} disabled={!wfA?.name} title="Increase BPM by 0.01" style={{ height:18, padding:"0 4px", fontSize:8, fontFamily:"'DM Mono',monospace", background:"transparent", border:"1px solid #ffffff18", color:"#ffffff88", borderRadius:3, cursor:wfA?.name?"pointer":"default", outline:"none" }}>BPM+</button>
                  </div>
                  <div style={{ width:1, height:12, background:"#ffffff18" }}/>
                  {WF_ZOOM_LABELS.map((lbl,i)=>(
                    <button key={i} onClick={()=>setWfZoom(i)} style={{ height:18, padding:"0 7px", fontSize:8, fontFamily:"'DM Mono',monospace", letterSpacing:.5, background:wfZoom===i?"#C8A96E22":"transparent", border:`1px solid ${wfZoom===i?"#C8A96E88":"#ffffff18"}`, color:wfZoom===i?"#C8A96E":"#ffffff44", borderRadius:4, cursor:"pointer", outline:"none" }}>{lbl}</button>
                  ))}
                </div>
                <AnimatedZoomedWF bands={wfA} dur={wfA?.dur||0} progRef={progRefA} onSeek={seekDeckA} h={wfH} windowSec={WF_WINDOWS[wfZoom]} beatPhaseFrac={bpm.results["A"]?.beatPhaseFrac??null} beatPeriodSec={bpm.results["A"]?.beatPeriodSec??null} gridOffsetMs={gridOffsetA} bpmNudge={bpmNudgeA*0.01} deckColor="#7B61FF"/>
              </div>
            )}
            {hasA && hasB && <div style={{ height:1, background:"#0d0d18" }}/>}
            {hasB && (
              <div
                onDragOver={e=>e.preventDefault()}
                onDrop={e=>{
                  e.preventDefault(); e.stopPropagation();
                  try {
                    const d = JSON.parse(e.dataTransfer.getData("application/json"));
                    if (d?.trackId) {
                      const t = lib.library.find(x => x.id === d.trackId);
                      if (t) handleLibLoad(t, "B");
                    }
                  } catch {}
                }}
                style={{ position:"relative", minHeight:wfH, flexShrink:0 }}>
                <div style={{ position:"absolute", top:6, left:10, zIndex:2, display:"flex", gap:8, alignItems:"center", pointerEvents:"none" }}>
                  <div style={{ width:5, height:5, borderRadius:"50%", background:"#00BFA5", boxShadow:"0 0 6px #00BFA5" }}/>
                  <span style={{ fontSize:9, fontFamily:"'DM Mono',monospace", fontWeight:700, color:"#00BFA588", letterSpacing:2 }}>B</span>
                </div>
                <AnimatedZoomedWF bands={wfB} dur={wfB?.dur||0} progRef={progRefB} onSeek={seekDeckB} h={wfH} windowSec={WF_WINDOWS[wfZoom]} beatPhaseFrac={bpm.results["B"]?.beatPhaseFrac??null} beatPeriodSec={bpm.results["B"]?.beatPeriodSec??null} gridOffsetMs={gridOffsetB} bpmNudge={bpmNudgeB*0.01} deckColor="#00BFA5"/>
              </div>
            )}
          </div>
        );
      })()}

      {/* DECKS + MIXER ROW */}
      <div style={{ flexShrink:0, display:"grid", gridTemplateColumns:"1fr 260px 1fr", gap:8, padding:"8px 12px 0", height:"288px", overflow:"hidden" }}>

        {/* ── DECK A (shared) ── */}
        <div style={{ display:"flex", flexDirection:"column", minWidth:0, minHeight:0, overflow:"hidden", background:"#0c0c12", border:`1px solid ${deckDrivers.A?"#7B61FF44":"#1e1e28"}`, borderRadius:10, transition:"border-color .3s" }}>
          <div style={{ display:"flex", gap:8, alignItems:"center", padding:"6px 12px", borderBottom:"1px solid #1e1e28", background:"#080810", flexShrink:0 }}>
            <div style={{ width:6, height:6, borderRadius:"50%", background:deckDrivers.A?"#7B61FF":"#282835", boxShadow:deckDrivers.A?"0 0 8px #7B61FF":"none", transition:"all .3s" }}/>
            <span style={{ fontSize:11, fontFamily:"'DM Mono',monospace", fontWeight:700, color:deckDrivers.A?"#7B61FF":"#444454", letterSpacing:2 }}>DECK A</span>
            {deckDrivers.A && <span style={{ fontSize:11, fontFamily:"'DM Sans',sans-serif", fontWeight:500, color:"#7B61FFaa", letterSpacing:.3 }}>{deckDrivers.A === session.name ? `${deckDrivers.A} (you)` : deckDrivers.A}</span>}
          </div>
          <div style={{ flex:1, overflow:"hidden", minHeight:0 }}>
            <Deck id="A" ch={eng.current?.A} ctx={eng.current?.ctx} color="#7B61FF" local remote={pA} onChange={dh("A")} midi={midiEvt} bpmResult={bpm.results["A"]} bpmAnalyze={bpm.analyze} eqHi={eqA.hi} eqMid={eqA.mid} eqLo={eqA.lo} chanVol={eqA.vol} loadFromLibrary={libLoadA} onTrackInfo={handleTrackInfo} onSync={()=>handleSyncToggle("A")} syncReady={!!(bpm.results["B"]?.bpm || pB?.bpm)} syncRole={syncLocked ? (lastSlaveDeck === "A" ? "slave" : "master") : null} isMaster={masterDeck === "A"} onMasterToggle={handleMasterToggle} onLibraryTrackDrop={(trackId)=>{const t=lib.library.find(x=>x.id===trackId);if(t)handleLibLoad(t,"A");}} onProgUpdate={handleProgA} onWaveform={setWfA} onSeekReady={onDeckASeekReady} onToggleReady={onDeckAToggleReady} onCueReady={onDeckACueReady} onTransportFire={handleTransportFire} isDriver={!deckDrivers.A || deckDrivers.A === session.name}/>
          </div>
        </div>

        {/* ── CENTER MIXER ── */}
        <div style={{ display:"flex", flexDirection:"column", background:"#0e0e14", border:"1px solid #222230", borderRadius:10, overflow:"hidden", minHeight:0, boxShadow:"0 8px 32px rgba(0,0,0,.8), inset 0 1px 0 #2a2a38" }}>

          {/* HEADER */}
          <div style={{ padding:"5px 8px", background:"#0a0a10", borderBottom:"1px solid #202028", display:"flex", flexDirection:"column", alignItems:"center", gap:3, flexShrink:0 }}>
            <VU an={eng.current?.masterAn} color="#C8A96E" w={80}/>
            <div style={{ display:"flex", gap:6, alignItems:"center" }}>
              <div style={{ fontSize:7, fontFamily:"'DM Mono',monospace", color:"#C8A96E", letterSpacing:1.5, fontWeight:600 }}>MASTER OUT</div>
              <div style={{ width:1, height:8, background:"#2a2a38" }}/>
              <div style={{ fontSize:7, fontFamily:"'DM Mono',monospace", color:"#555562", letterSpacing:1 }}>{session.room}</div>
            </div>
          </div>

          {/* CHANNEL STRIPS — 3-column: [CH A] [CENTER] [CH B] */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 78px 1fr", flex:1, minHeight:0, overflow:"hidden" }}>

            {/* ─── CH A STRIP ─── */}
            <div style={{ display:"flex", flexDirection:"column", borderRight:"1px solid #202028", overflow:"hidden" }}>
              {/* Header: label + VU inline */}
              <div style={{ padding:"3px 6px", background:"#0a0a10", borderBottom:"1px solid #202028", display:"flex", justifyContent:"space-between", alignItems:"center", flexShrink:0 }}>
                <span style={{ fontFamily:"'DM Mono',monospace", fontSize:11, color:"#7B61FF", fontWeight:600, letterSpacing:1 }}>A</span>
                <VU an={eng.current?.A?.an} color="#7B61FF" w={50}/>
              </div>
              {/* Channel fader LEFT, EQ knobs RIGHT — outer edge layout */}
              <div style={{ flex:1, display:"flex", flexDirection:"row", minHeight:0, overflow:"hidden" }}>
                {/* Channel volume fader — far left (outer edge) */}
                <div style={{ flexShrink:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"5px 4px", borderRight:"1px solid #181820", gap:2 }}>
                  <div style={{ fontSize:6, fontFamily:"'DM Mono',monospace", color:"#7B61FF55", letterSpacing:1 }}>VOL</div>
                  <VerticalFader val={eqA.vol} set={v=>updateEqA("vol",v)} color="#7B61FF" h={150}/>
                  <div style={{ fontSize:7, fontFamily:"'DM Mono',monospace", color:"#7B61FF88" }}>{(eqA.vol/1.5*100).toFixed(0)}%</div>
                </div>
                {/* Knobs column — inner side */}
                <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"space-evenly", padding:"5px 2px" }}>
                  <Knob v={eqA.vol} set={v=>updateEqA("vol",v)} min={0} max={1.5} ctr={1} label="GAIN" color="#7B61FF" size={20}/>
                  <Knob v={eqA.hi}  set={v=>updateEqA("hi",v)}  min={-12} max={12} ctr={0} label="HI"   color="#7B61FF" size={20}/>
                  <Knob v={eqA.mid} set={v=>updateEqA("mid",v)} min={-12} max={12} ctr={0} label="MID"  color="#7B61FF" size={20}/>
                  <Knob v={eqA.lo}  set={v=>updateEqA("lo",v)}  min={-12} max={12} ctr={0} label="LO"   color="#7B61FF" size={20}/>
                </div>
              </div>
            </div>

            {/* ─── CENTER COLUMN ─── */}
            <div style={{ display:"flex", flexDirection:"column", background:"#0a0a12", overflow:"hidden" }}>
              {/* Master fader */}
              <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:3, minHeight:0 }}>
                <div style={{ fontSize:7, fontFamily:"'DM Mono',monospace", color:"#C8A96E99", letterSpacing:2 }}>MASTER</div>
                <VerticalFader val={mvol} set={setMvolLocal} color="#C8A96E" h={150}/>
                <div style={{ fontSize:7, fontFamily:"'DM Mono',monospace", color:"#C8A96E99" }}>{(mvol/1.5*100).toFixed(0)}%</div>
              </div>
              {/* Session info */}
              <div style={{ padding:"5px 6px 4px", borderTop:"1px solid #202028", flexShrink:0 }}>
                {[["ROOM",session.room,"#C8A96E"],["PING",sync.ping?`${sync.ping}ms`:"—","#7a9aaa"],["NET",rtc.state==="connected"?"LIVE":"OFF",rtc.state==="connected"?"#22c55e":"#444454"]].map(([l,v,c])=>(
                  <div key={l} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"1px 0" }}>
                    <span style={{ fontSize:7, fontFamily:"'DM Mono',monospace", color:"#555562", letterSpacing:.5 }}>{l}</span>
                    <span style={{ fontSize:9, fontFamily:"'DM Mono',monospace", color:c, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:42 }}>{v}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* ─── CH B STRIP (local) ─── */}
            <div style={{ display:"flex", flexDirection:"column", borderLeft:"1px solid #202028", overflow:"hidden" }}>
              {/* Header: label + VU inline */}
              <div style={{ padding:"3px 6px", background:"#0a0a10", borderBottom:"1px solid #202028", display:"flex", justifyContent:"space-between", alignItems:"center", flexShrink:0 }}>
                <span style={{ fontFamily:"'DM Mono',monospace", fontSize:11, color:"#00BFA5", fontWeight:600, letterSpacing:1 }}>B</span>
                <VU an={eng.current?.B?.an} color="#00BFA5" w={50}/>
              </div>
              {/* EQ knobs LEFT, channel fader RIGHT — outer edge layout */}
              <div style={{ flex:1, display:"flex", flexDirection:"row", minHeight:0, overflow:"hidden" }}>
                {/* Knobs column — inner side */}
                <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"space-evenly", padding:"5px 2px" }}>
                  <Knob v={eqB.vol} set={v=>updateEqB("vol",v)} min={0} max={1.5} ctr={1} label="GAIN" color="#00BFA5" size={20}/>
                  <Knob v={eqB.hi}  set={v=>updateEqB("hi",v)}  min={-12} max={12} ctr={0} label="HI"   color="#00BFA5" size={20}/>
                  <Knob v={eqB.mid} set={v=>updateEqB("mid",v)} min={-12} max={12} ctr={0} label="MID"  color="#00BFA5" size={20}/>
                  <Knob v={eqB.lo}  set={v=>updateEqB("lo",v)}  min={-12} max={12} ctr={0} label="LO"   color="#00BFA5" size={20}/>
                </div>
                {/* Channel volume fader — far right (outer edge) */}
                <div style={{ flexShrink:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"5px 4px", borderLeft:"1px solid #181820", gap:2 }}>
                  <div style={{ fontSize:6, fontFamily:"'DM Mono',monospace", color:"#00BFA555", letterSpacing:1 }}>VOL</div>
                  <VerticalFader val={eqB.vol} set={v=>updateEqB("vol",v)} color="#00BFA5" h={150}/>
                  <div style={{ fontSize:7, fontFamily:"'DM Mono',monospace", color:"#00BFA588" }}>{(eqB.vol/1.5*100).toFixed(0)}%</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── DECK B (shared) ── */}
        <div style={{ display:"flex", flexDirection:"column", minWidth:0, minHeight:0, overflow:"hidden", background:"#0c0c12", border:`1px solid ${deckDrivers.B?"#00BFA544":"#1e1e28"}`, borderRadius:10, transition:"border-color .3s" }}>
          <div style={{ display:"flex", gap:8, alignItems:"center", padding:"6px 12px", borderBottom:"1px solid #1e1e28", background:"#080810", flexShrink:0 }}>
            <div style={{ width:6, height:6, borderRadius:"50%", background:deckDrivers.B?"#00BFA5":"#282835", boxShadow:deckDrivers.B?"0 0 8px #00BFA5":"none", transition:"all .3s" }}/>
            <span style={{ fontSize:11, fontFamily:"'DM Mono',monospace", fontWeight:700, color:deckDrivers.B?"#00BFA5":"#444454", letterSpacing:2 }}>DECK B</span>
            {deckDrivers.B && <span style={{ fontSize:11, fontFamily:"'DM Sans',sans-serif", fontWeight:500, color:"#00BFA5aa", letterSpacing:.3 }}>{deckDrivers.B === session.name ? `${deckDrivers.B} (you)` : deckDrivers.B}</span>}
          </div>
          <div style={{ flex:1, overflow:"hidden", minHeight:0 }}>
            <Deck id="B" ch={eng.current?.B} ctx={eng.current?.ctx} color="#00BFA5" local remote={pB} onChange={dh("B")} midi={midiEvt} bpmResult={bpm.results["B"]} bpmAnalyze={bpm.analyze} eqHi={eqB.hi} eqMid={eqB.mid} eqLo={eqB.lo} chanVol={eqB.vol} loadFromLibrary={libLoadB} onTrackInfo={handleTrackInfo} onSync={()=>handleSyncToggle("B")} syncReady={!!(bpm.results["A"]?.bpm || pA?.bpm)} syncRole={syncLocked ? (lastSlaveDeck === "B" ? "slave" : "master") : null} isMaster={masterDeck === "B"} onMasterToggle={handleMasterToggle} onLibraryTrackDrop={(trackId)=>{const t=lib.library.find(x=>x.id===trackId);if(t)handleLibLoad(t,"B");}} onProgUpdate={handleProgB} onWaveform={setWfB} onSeekReady={onDeckBSeekReady} onToggleReady={onDeckBToggleReady} onCueReady={onDeckBCueReady} onTransportFire={handleTransportFire} isDriver={!deckDrivers.B || deckDrivers.B === session.name}/>
          </div>
        </div>

      </div>

      {/* ── PANELS (AUDIO / REC / MIDI) — full-width, below decks ── */}
      {(panel||true) && <div style={{ flexShrink:0, borderTop:"1px solid #181828", background:"#07070e" }}>
        <div style={{ display:"flex", borderBottom:"1px solid #111118" }}>
          {PANELS.map(([pid,l])=>(
            <button key={pid} onClick={()=>setPanel(p=>p===pid?null:pid)} style={{ padding:"4px 16px", fontSize:9, fontFamily:"'DM Mono',monospace", background:"transparent", color:panel===pid?"#C8A96E":"#555562", border:"none", borderBottom:`2px solid ${panel===pid?"#C8A96E":"transparent"}`, cursor:"pointer", outline:"none", letterSpacing:.5 }}>{l}</button>
          ))}
        </div>
        {panel && <div style={{ maxHeight:120, overflow:"auto", background:"#0a0a12" }}>
          {panel==="rtc"  && <RTCPanel rtc={rtc} partner={sync.partner} syncOk={sync.status==="connected"}/>}
          {panel==="rec"  && <RecPanel rec={rec} ready={ready}/>}
          {panel==="midi" && <MidiPanel midi={midi}/>}
        </div>}
      </div>}

      {/* ── CROSSFADER ROW — same grid as deck row, only center column has content ── */}
      <div style={{ flexShrink:0, display:"grid", gridTemplateColumns:"1fr 260px 1fr", gap:8, padding:"4px 12px", background:"#070710", borderTop:"1px solid #181828", borderBottom:"1px solid #181828" }}>
        <div/>{/* empty left */}
        <div style={{ display:"flex", alignItems:"center", gap:8, padding:"4px 6px" }}>
          {/* invisible spacer matching CTR button width so slider is visually centered */}
          <button aria-hidden="true" tabIndex={-1} style={{ fontSize:7, height:16, padding:"0 8px", background:"transparent", border:"1px solid transparent", color:"transparent", borderRadius:3, cursor:"default", fontFamily:"'DM Mono',monospace", letterSpacing:.5, flexShrink:0, pointerEvents:"none", userSelect:"none" }}>CTR</button>
          <span style={{ fontSize:11, fontFamily:"'DM Mono',monospace", color:"#C8A96E99", fontWeight:700, lineHeight:1, flexShrink:0 }}>A</span>
          <div style={{ flex:1, position:"relative", height:24, display:"flex", alignItems:"center" }}>
            <div style={{ width:"100%", height:6, borderRadius:4, background:"#030310", border:"1px solid #181828", boxShadow:"inset 0 1px 3px rgba(0,0,0,.7)" }}>
              <div style={{ height:"100%", width:`${xf*100}%`, background:"linear-gradient(90deg,#C8A96E44,#00BFA533)", borderRadius:4 }}/>
            </div>
            <input type="range" min={0} max={1} step={.005} value={xf} onChange={e=>setXfLocal(Number(e.target.value))} style={{ position:"absolute", width:"100%", opacity:0, cursor:"pointer", height:24 }}/>
            <div style={{ position:"absolute", left:`calc(${xf*100}% - 13px)`, width:26, height:20, background:"linear-gradient(180deg,#2c2a3e,#16142a)", border:"1px solid #38364e", borderRadius:4, boxShadow:"0 2px 8px rgba(0,0,0,.8), inset 0 1px 0 rgba(255,255,255,.06)", pointerEvents:"none", display:"flex", alignItems:"center", justifyContent:"center" }}>
              <div style={{ width:2, height:10, background:"#C8A96E88", borderRadius:1 }}/>
            </div>
          </div>
          <span style={{ fontSize:11, fontFamily:"'DM Mono',monospace", color:"#00BFA599", fontWeight:700, lineHeight:1, flexShrink:0 }}>B</span>
          <button onClick={()=>setXfLocal(.5)} style={{ fontSize:7, height:16, padding:"0 8px", background:"transparent", border:"1px solid #252535", color:"#555562", borderRadius:3, cursor:"pointer", fontFamily:"'DM Mono',monospace", letterSpacing:.5, flexShrink:0 }}>CTR</button>
        </div>
        <div/>{/* empty right */}
      </div>

      {/* ── EMBEDDED LIBRARY — fills remaining space below decks ── */}
      <div style={{ flex:1, overflow:"hidden", borderTop:"1px solid #1c1c24", background:"#080810", minHeight:0 }}>
        <LibraryPanelV2
          lib={lib}
          onLoad={handleLibLoad}
          playingTrack={playingTrack}
          previewTrackId={previewTrackId}
          onPreview={handlePreview}
          onDelete={handleDeleteTrack}
          chat={chat}
          onSendChat={msg=>sync.send({type:"chat",msg})}
          me={session.name}
        />
      </div>

      </div>{/* end main content area */}

    </div>
  );
}
