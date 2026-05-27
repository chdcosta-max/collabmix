import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { WORKER_SRC } from "./bpm-worker-source.js";
import { logEvent, setSessionContext, captureHandledError } from "./utils/telemetry.js";
import { connectRekordboxLibrary } from "./rekordbox-library.js";
import {
  openCmDB,
  dbGet as cmDbGet,
  dbGetAll as cmDbAll,
  dbPut as cmDbPut,
  dbDelete as cmDbDelete,
  putHandle as cmDbPutHandle,
  opfsStore, opfsGet, opfsDelete, opfsClear,
  ensurePersistentStorage,
  resolveHandleRecord,
  hasMigrationRun, markMigrationRun,
  runHandleMigration,
} from "./utils/storage.js";

// ═══════════════════════════════════════════════════════════════
//  MIX//SYNC  — PRODUCTION READY
//  All bugs fixed. Landing page. Full app.
// ═══════════════════════════════════════════════════════════════

// ── Server Configuration ─────────────────────────────────────
// After deploying to Railway, replace this URL with your Railway server URL.
// It should look like: wss://collabmix-server-production.up.railway.app
const SERVER_URL = "wss://collabmix-server-production.up.railway.app";

// ── ID3 / artwork extraction parameters ──────────────────────
// Source-file window read into memory for parseID3. 4 MB covers any
// realistic embedded artwork (audiophile 24-bit/192k releases often embed
// 1.5–3 MB JPEGs; standard releases <1 MB). The previous 1 MB window
// dropped APIC frames entirely whenever total ID3 size pushed past 1 MB,
// which is what produced "Home In The Sky" / "Sunbeam" -style tracks with
// no artwork at all. Bumped together with removing parseID3's internal
// 500 KB JPEG truncation (which produced "Racing Heart"-style half-rendered
// artwork). Per-track import cost is one transient ArrayBuffer of this size
// during _importFileObjects — sequential, so peak is one window not N.
const ID3_READ_WINDOW = 4 * 1024 * 1024;

// Artwork parser version stamp. Bump when the extraction logic changes so
// scanArtwork can re-process tracks whose artwork was produced by an older
// parser. v2 = post-May-26: no 500 KB truncation, 4 MB read window.
const ARTWORK_PARSER_VERSION = 2;

// ── Feature flags ─────────────────────────────────────────────
// USE_RB_GRID: when a track loaded onto a deck matches an entry in the user's
// connected Rekordbox library, override the analyzer's beat grid
// (beatPeriodSec / beatPhaseFrac / beatPhaseSec / firstBar1AnchorSec) with
// Rekordbox's PQTZ-derived values for that deck. Waveform rendering is
// unaffected — every track renders through the local analyzer's 3-band output
// + the new spectral color formula, so all tracks look identical regardless
// of source. Flip to false to use analyzer grid everywhere.
const USE_RB_GRID = true;

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

// ── Design tokens (Cool Pro Tool palette, May 24, 2026) ────────
// Cool dark surfaces, clean white text. Single accent: white at varying
// opacity (amber retired May 24). See tools/docs/DESIGN_PHILOSOPHY.md.
const TOK = {
  // Single accent — white at three opacity tiers
  accent:  "rgba(255,255,255,0.9)",  // primary: active states, primary indicators
  accent2: "rgba(255,255,255,0.6)",  // secondary: hover states, secondary info
  accent3: "rgba(255,255,255,0.3)",  // tertiary: borders, dividers
  deckA:  "#2E86DE", // your deck — Vivid Ocean Blue (high-contrast cool pair)
  deckB:  "#A855F7", // partner deck — Electric Royal Purple (high-contrast cool pair)
  bg:     "#0A0B0E", // primary background — cool near-black
  bg2:    "#15171A", // panels / cards (cool dark, one step lifted)
  bg3:    "#1F2126", // elevated panels / modals (~two steps lifted)
  hover:  "#232529", // hover / active surfaces
  border: "rgba(255,255,255,0.06)", // subtle border
  border2:"rgba(255,255,255,0.12)", // defined border (active / focus)
  text:   "#F5F5F7", // primary text — clean white
  subtle: "#9CA3AF", // secondary text — cool gray
  muted:  "#5A5E66", // disabled / tertiary — cool muted
};

// Semantic green — reserved for status indicators only (online / ready /
// recording). Decoupled from the Deck B identity color so atmospheric-palette
// changes never break the "green = online" convention.
const STATUS_OK = "#22c55e";


function createBPMWorker() {
  return new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: "application/javascript" })));
}

function useBPM() {
  const [results, setResults] = useState({});
  const worker = useRef(null);
  useEffect(() => {
    worker.current = createBPMWorker();
    worker.current.onmessage = (e) => {
      const { id, bpm, confidence, candidates, beatPhaseFrac, beatPeriodSec, beatPhaseSec, firstBar1AnchorSec, snapped, error, _debug } = e.data;
      if (id === '__err') { console.error('[BPM Worker global error]', e.data.error); return; }
      if (error) console.error('[BPM Worker caught error]', error);
      console.log('[BPM result] id='+id+' bpm='+bpm+' bpf='+beatPhaseFrac+' bps='+beatPeriodSec+' bphs='+beatPhaseSec+' anchor='+firstBar1AnchorSec+' snapped='+(snapped??false)+' debug='+JSON.stringify(_debug));
      console.log('[BPM] analysis complete for deck', id, 'bpm=', bpm);
      setResults(prev => ({ ...prev, [id]: { bpm, confidence, candidates, beatPhaseFrac: beatPhaseFrac||0, beatPeriodSec: beatPeriodSec||null, beatPhaseSec: beatPhaseSec??null, firstBar1AnchorSec: firstBar1AnchorSec??null, analyzing: false } }));
    };
    worker.current.onerror = (e) => { console.error('[BPM Worker onerror]', e.message, e.lineno); };
    return () => worker.current?.terminate();
  }, []);
  const analyze = useCallback((buf, id) => {
    if (!buf || !worker.current) return;
    console.log('[BPM] analysis started for deck', id, '(track loaded)');
    // CLEAR stale fields from the previous track's analysis. Previously this
    // spread-preserved prev[id], leaving beatPhaseFrac / beatPeriodSec /
    // firstBar1AnchorSec at the OLD track's values until the worker message
    // for the new track arrived. The Deck auto-position useEffect could fire
    // in that window with stale data and lock itself out of re-firing when
    // the real result came in.
    setResults(prev => ({ ...prev, [id]: { ...(prev[id] || {}), bpm: null, beatPhaseFrac: null, beatPeriodSec: null, beatPhaseSec: null, firstBar1AnchorSec: null, analyzing: true } }));
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
          // No size cap: the previous 500 KB inner slice silently truncated
          // any embedded JPEG larger than half a megabyte mid-stream, so the
          // browser decoded the top portion and filled the rest with default
          // garbage. downscaleArtwork then encoded that half-corrupt image
          // into a 200x200 thumbnail with broken lower scanlines. The
          // bounded-memory rationale for the cap no longer applies because
          // downscaleArtwork already compresses the data URL to ~10-20 KB
          // before it lands in IDB. Caller still bounds the source via the
          // file.slice() window in _importFileObjects (currently 4 MB).
          const b64=btoa(Array.from(picBytes).map(b=>String.fromCharCode(b)).join(""));
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

// IDB + OPFS helpers moved to src/utils/storage.js (shared with /library.html).
// The previous inline cmDbPutHandle had a fatal bug: it spread the
// FileSystemFileHandle into a plain object via `{id, ...handle}`, but Handles
// have no enumerable own properties, so the handle field was silently dropped
// and only `{id}` was written. Lazy migration (Commit 4) rewrites those
// orphaned records by extracting bytes via the existing OPFS copy when one
// exists, or marking the record as needing user-driven reconnect otherwise.

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
  // Background-maintenance progress. {kind, done, total} when work is in
  // flight, null when idle. Surfaces in the subtle bottom-of-library
  // indicator. Updated from inside the processQ worker.onmessage callback
  // (analysis) and from inside scanArtwork's iteration loop (artwork).
  const [progress,setProgress]=useState(null);
  // Running max of the analysis queue size since the last drain. Lets the
  // indicator show "Analyzing N of M…" where M is sticky until the queue
  // empties and resets. Without this, M would shrink as the worker drains.
  const analysisTotalRef=useRef(0);
  const workerRef=useRef(null),queueRef=useRef([]),activeRef=useRef(false),fileMap=useRef({});
  const fileMapOrder=useRef([]); // LRU access order for fileMap eviction
  const audioCtx=useRef(null);
  const audioCtxJobs=useRef(0); // # tracks decoded since last AudioContext recreate
  const artworkCache=useRef({}); // trackId → data URL, kept in memory
  const processQRef=useRef(null); // forward ref so startup effect can call processQ
  const getFileRef=useRef(null);  // forward ref so processQ can lazily resolve a File by id
  const hasAutoQueued=useRef(false); // ensure startup analysis runs once
  // Background maintenance guard — ensures the mount-time auto-trigger fires
  // at most once per app load. Prevents re-triggering when the IDB poll
  // refreshes library state, or when the user toggles views.
  const autoMaintStartedRef=useRef(false);
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
      activeRef.current=false;
      // Surface progress for the bottom-of-library indicator. `done` = how
      // many tracks have completed in the current batch (total minus pending
      // + active). When the queue drains, clear progress and reset the
      // sticky total so the NEXT batch starts fresh.
      const pending=queueRef.current.length+(activeRef.current?1:0);
      if(pending===0){
        setProgress(null);
        analysisTotalRef.current=0;
      }else{
        if(pending>analysisTotalRef.current)analysisTotalRef.current=pending;
        const total=analysisTotalRef.current;
        setProgress({kind:"analysis",done:total-pending,total});
      }
      scheduleNextAnalysis();
    };
    return()=>workerRef.current?.terminate();
  },[]);

  // Bounded fileMap with LRU eviction. fileMap caches resolved File objects
  // (and the underlying OPFS / picker blob references) so repeat library
  // access is fast. Without a cap, every track loaded onto a deck in a long
  // session pinned its blob for the session lifetime — at ~10 MB per blob
  // that's GBs of held memory by the time a DJ has previewed 100 tracks.
  // 16 is well above any realistic working set (decked tracks A/B, recently
  // previewed, recently analyzed) and small enough that pathological loops
  // can't run away.
  const FILE_MAP_LRU_LIMIT=16;
  const fileMapTouch=useCallback((id)=>{
    const idx=fileMapOrder.current.indexOf(id);
    if(idx>=0)fileMapOrder.current.splice(idx,1);
    fileMapOrder.current.push(id);
    while(fileMapOrder.current.length>FILE_MAP_LRU_LIMIT){
      const oldId=fileMapOrder.current.shift();
      delete fileMap.current[oldId];
    }
  },[]);
  const setFile=useCallback((id,file)=>{
    fileMap.current[id]=file;
    fileMapTouch(id);
  },[fileMapTouch]);
  const removeFile=useCallback((id)=>{
    delete fileMap.current[id];
    const idx=fileMapOrder.current.indexOf(id);
    if(idx>=0)fileMapOrder.current.splice(idx,1);
  },[]);

  // Yield to the event loop / GC between analysis items. Without this, the
  // back-to-back decode→downsample→postMessage cycle gives the collector no
  // room to reclaim transient PCM buffers on bulk passes; resident heap
  // creeps upward across hundreds of tracks until the tab is killed.
  const scheduleNextAnalysis=useCallback(()=>{
    if(typeof requestIdleCallback==='function'){
      requestIdleCallback(()=>processQRef.current?.(),{timeout:250});
    }else{
      setTimeout(()=>processQRef.current?.(),50);
    }
  },[]);

  // Serial streaming analyzer.
  // - Queue holds {id, skipBPM, skipKey} (and optionally an inline `file` from
  //   queueAnalysis where the caller already has it in hand). The bulk path
  //   (analyzeAll) pushes ID-only items so 5000 track libraries don't pin
  //   5000 File references at once.
  // - Audio is decoded on the main thread, then downmixed to mono and decimated
  //   to 11025 Hz with a 60 s cap. The three worker analyzers (dbpm/dkey/
  //   denergy) only need a fraction of the input: dbpm bandpasses to 100–400 Hz
  //   (well below 5.5 kHz Nyquist), dkey reads ~2 s of FFT hops at chroma
  //   fundamentals ≤880 Hz, denergy uses the first 30 s of RMS+ZCR. We send the
  //   worker ≈2.6 MB instead of the ≈50 MB full-rate stereo PCM it used to get.
  // - Intermediate buffers (compressed ArrayBuffer, full-rate AudioBuffer) are
  //   nulled before the worker postMessage so they're GC-eligible while the
  //   worker runs. The mono PCM ArrayBuffer is transferred (not cloned),
  //   matching the deck BPM worker's pattern.
  const processQ=useCallback(()=>{
    if(activeRef.current||queueRef.current.length===0)return;
    const item=queueRef.current.shift();
    const{id,skipBPM,skipKey}=item;
    activeRef.current=true;
    (async()=>{
      let ab=null,buf=null,mono11k=null;
      try{
        // Lazy file resolve: inline File if the caller already had one, else
        // hit the live getFile (OPFS → IDB handle fallback) via forward ref.
        const file=item.file||(getFileRef.current?await getFileRef.current(id):null);
        if(!file){
          setLibrary(prev=>prev.map(t=>t.id===id?{...t,analyzed:true,error:true}:t));
          activeRef.current=false;
          scheduleNextAnalysis();
          return;
        }
        if(!audioCtx.current)audioCtx.current=new(window.AudioContext||window.webkitAudioContext)();
        ab=await file.arrayBuffer();
        buf=await audioCtx.current.decodeAudioData(ab);
        ab=null; // PCM is in buf, compressed bytes can be released

        const duration=buf.duration;
        setLibrary(prev=>prev.map(t=>t.id===id?{...t,duration}:t));

        const TARGET_SR=11025;
        const MAX_SEC=60;
        const srcSR=buf.sampleRate;
        const chans=buf.numberOfChannels;
        const srcSamplesMax=Math.min(buf.length,Math.floor(srcSR*MAX_SEC));
        const targetLen=Math.max(1,Math.floor(srcSamplesMax*TARGET_SR/srcSR));
        const ratio=srcSR/TARGET_SR;
        mono11k=new Float32Array(targetLen);
        const chData=[];
        for(let c=0;c<chans;c++)chData.push(buf.getChannelData(c));
        // Box-filter average over each source window: downmix + low-pass +
        // decimate in one pass. Sufficient anti-aliasing for the kick band
        // (100–400 Hz) and chroma band (≤880 Hz) the worker actually uses.
        for(let i=0;i<targetLen;i++){
          const start=Math.floor(i*ratio);
          const end=Math.min(Math.floor((i+1)*ratio),srcSamplesMax);
          let sum=0,n=0;
          for(let j=start;j<end;j++){
            let s=0;
            for(let c=0;c<chans;c++)s+=chData[c][j];
            sum+=s/chans;
            n++;
          }
          mono11k[i]=n>0?sum/n:0;
        }
        buf=null; // full-rate decoded PCM released before worker round-trip

        workerRef.current.postMessage(
          {cd:[mono11k],sr:TARGET_SR,id,skipBPM,skipKey},
          [mono11k.buffer]
        );
        mono11k=null; // ArrayBuffer ownership transferred

        // Periodically recycle the AudioContext — Chrome leaks small internal
        // buffers per decode that aren't reclaimed until close(). At ~50 tracks
        // this is a few MB; over thousands it adds up.
        audioCtxJobs.current+=1;
        if(audioCtxJobs.current>=50){
          try{await audioCtx.current.close();}catch{}
          audioCtx.current=null;
          audioCtxJobs.current=0;
        }
      }catch(err){
        console.warn('[LIB-ANALYZE-ERR]',{id,error:err?.message||String(err)});
        ab=null;buf=null;mono11k=null;
        setLibrary(prev=>prev.map(t=>t.id===id?{...t,analyzed:true,error:true}:t));
        activeRef.current=false;
        scheduleNextAnalysis();
      }
    })();
  },[scheduleNextAnalysis]);
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
      try{const sl=file.slice(0,ID3_READ_WINDOW);tags=parseID3(await sl.arrayBuffer());}catch{}
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
      const track={id,filename:file.name.replace(/\.[^.]+$/,""),title,artist,album:tags.album||"",genre:tags.genre||"",label:tags.label||"",bpm:tags.bpm?parseFloat(tags.bpm):null,key:tags.key||null,duration:null,energy:null,analyzed:false,error:false,addedAt:Date.now(),artwork:tags.artwork||null,artworkVersion:tags.artwork?ARTWORK_PARSER_VERSION:undefined};
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
      // Auto-queue for BPM/key/energy analysis. Push the ID only — processQ
      // resolves the File lazily at decode time and releases it, so the queue
      // does NOT pin Files (the May 6 OOM mode). Same Session 1 pipeline as
      // the manual analyzeAll: serial decode, mono 11 kHz, transferable
      // buffers, AudioContext recycle. New imports therefore auto-analyze
      // without the user clicking anything.
      if(!track.bpm||!track.key){
        if(!queueRef.current.some(q=>q.id===id)){
          queueRef.current.push({id,skipBPM:!!track.bpm,skipKey:!!track.key});
        }
      }
      importedCount++;
    }
    console.log('[IMPORT-DONE]',{importedCount,skippedCount,totalCandidates:audio.length,ms:Math.round(performance.now()-tImport0)});
    if(skippedCount>0){
      console.log(`[library] Imported ${importedCount} tracks, skipped ${skippedCount} duplicate${skippedCount===1?"":"s"}`);
    }
    // Seed progress for the bottom-of-library indicator, then kick processQ.
    const pending=queueRef.current.length+(activeRef.current?1:0);
    if(pending>0){
      if(pending>analysisTotalRef.current)analysisTotalRef.current=pending;
      const total=analysisTotalRef.current;
      setProgress({kind:"analysis",done:total-pending,total});
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
      try{const sl=file.slice(0,ID3_READ_WINDOW);id3=parseID3(await sl.arrayBuffer());}catch{}
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

  // Queue every unanalyzed track for BPM/key/energy. The queue holds metadata
  // only — Files are resolved one at a time by processQ at the moment of
  // analysis (then released). Previously this pre-resolved every File via
  // getFileFn and pushed File-bearing queue items, pinning thousands of blobs
  // at once and OOM'ing on large libraries; same shape as the May 6 import
  // path bug. Artwork extraction lives on the separate "Scan artwork" button
  // (scanArtwork) so analyzeAll stays narrow.
  // Signature keeps `_getFileFn` for backward compatibility with the call site
  // (`lib.analyzeAll?.(lib.getFile)`); the arg is ignored.
  const analyzeAll=useCallback(async(_getFileFn)=>{
    setAnalyzing(true);
    const toProcess=library||[];
    for(const track of toProcess){
      if(!track.analyzed||track.error){
        if(!queueRef.current.some(q=>q.id===track.id)){
          queueRef.current.push({id:track.id,skipBPM:!!track.bpm,skipKey:!!track.key});
        }
      }
    }
    // Seed the progress indicator's sticky total. processQ + worker.onmessage
    // will update done/total as the queue drains. If nothing was queued, no
    // progress is shown.
    const pending=queueRef.current.length+(activeRef.current?1:0);
    if(pending>0){
      if(pending>analysisTotalRef.current)analysisTotalRef.current=pending;
      const total=analysisTotalRef.current;
      setProgress({kind:"analysis",done:total-pending,total});
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
      const sl=file.slice(0,ID3_READ_WINDOW);
      const tags=parseID3(await sl.arrayBuffer());
      if(tags.artwork){
        // Always downscale before persisting — raw embedded JPEGs can be
        // 1-3 MB and would multiply across the library state, the 5s IDB
        // poll's deserialization, and the in-memory cache.
        const compressed=await downscaleArtwork(tags.artwork);
        const art=compressed||tags.artwork;
        artworkCache.current[trackId]=art;
        try{
          const existing=await cmDbGet("tracks",trackId);
          if(existing&&!existing.artwork){await cmDbPut("tracks",{...existing,artwork:art,artworkVersion:ARTWORK_PARSER_VERSION});}
        }catch{}
        return art;
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
        setFile(track.id,file);
        opfsStore(track.id,file); // write to OPFS so future sessions need zero clicks
        // Also store handle in IDB so future sessions work
        try{await cmDbPut("handles",h,track.id);}catch{}
        // Populate in-memory artwork cache — cover tracks already in IDB and those missing artwork
        if(track.artwork&&!artworkCache.current[track.id]){
          artworkCache.current[track.id]=track.artwork; // restore cache from IDB value
        }
        if(!track.artwork&&artworkCache.current[track.id]!==false){
          try{
            const sl=file.slice(0,ID3_READ_WINDOW);
            const tags=parseID3(await sl.arrayBuffer());
            if(tags.artwork){
              const compressed=await downscaleArtwork(tags.artwork);
              const art=compressed||tags.artwork;
              artworkCache.current[track.id]=art;
              try{
                const existing=await cmDbGet("tracks",track.id);
                if(existing&&!existing.artwork){
                  await cmDbPut("tracks",{...existing,artwork:art,artworkVersion:ARTWORK_PARSER_VERSION});
                  artworkUpdates.push({id:track.id,artwork:art});
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
      fileMapTouch(id); // refresh LRU position
      return fileMap.current[id];
    }
    // OPFS: zero permissions, always works, survives browser restarts
    const opfsFile=await opfsGet(id);
    if(opfsFile){
      console.log('[GET-FILE]',{id,branch:'opfs-hit',size:opfsFile.size});
      setFile(id,opfsFile);
      return opfsFile;
    }
    // Fall back to IDB handle record. The record may be any of three shapes
    // in the wild (see resolveHandleRecord in utils/storage.js) — handle in
    // hand, plain File from the library-app legacy <input> path, or an
    // orphaned {id} from the pre-v5 mixer cmDbPutHandle bug. resolveHandleRecord
    // returns a uniform shape so the branch logic below can stay simple.
    try{
      const rec=await cmDbGet("handles",id);
      const resolved=resolveHandleRecord(rec);
      if(!resolved||(!resolved.handle&&!resolved.file)){
        console.log('[GET-FILE]',{id,branch:'no-usable-handle',recShape:rec?Object.keys(rec):null});
        return null;
      }
      // Legacy {id, file} path: File is already in hand. Promote to OPFS so
      // the next session takes the zero-permission path.
      if(resolved.file){
        console.log('[GET-FILE]',{id,branch:'legacy-file-record',size:resolved.file.size});
        setFile(id,resolved.file);
        opfsStore(id,resolved.file).catch(()=>{});
        return resolved.file;
      }
      // Standard handle path: re-grant permission if needed, then read.
      const handle=resolved.handle;
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
      setFile(id,file);
      opfsStore(id,file).catch(()=>{}); // mirror to OPFS so future sessions need zero clicks
      return file;
    }catch(err){
      console.warn('[GET-FILE]',{id,branch:'idb-handle-error',error:err?.message||String(err)});
      return null;
    }
  },[fileMapTouch,setFile]);
  // Forward ref so processQ (declared above getFile) can lazily resolve a File
  // by id without closing over a stale getFile identity.
  useEffect(()=>{ getFileRef.current=getFile; },[getFile]);

  // Re-scan ID3 APIC artwork for every track currently missing an artwork blob.
  // Reads the first 1MB of the source file, parses ID3v2, pulls the APIC frame
  // as a base64 data URL, and persists it back to the IDB track record.
  const scanArtwork=useCallback(async()=>{
    setAnalyzing(true);
    // Process tracks that are either missing artwork OR carry artwork from an
    // older parser version. v2 was introduced when the 500 KB JPEG truncation
    // was removed (commit XXX), so any track without an artworkVersion >= 2
    // marker may have a half-corrupt thumbnail (the "Racing Heart" symptom).
    // Bulk re-processing stamps the version after a successful re-extract
    // so this scan is a no-op for already-clean tracks on subsequent runs.
    const toProcess=(library||[]).filter(t=>!t.artwork||(t.artworkVersion||0)<ARTWORK_PARSER_VERSION);
    const total=toProcess.length;
    if(total>0)setProgress({kind:"artwork",done:0,total});
    let processed=0;
    for(const track of toProcess){
      let file=null;
      try{file=await getFile(track.id);}catch{}
      if(!file){processed++;if(total>0)setProgress({kind:"artwork",done:processed,total});continue;}
      try{
        const sl=file.slice(0,ID3_READ_WINDOW);
        const tags=parseID3(await sl.arrayBuffer());
        if(tags.artwork){
          // Always downscale before persisting — raw embedded JPEGs can be
          // 1-3 MB and would explode resident library state at scale.
          const compressed=await downscaleArtwork(tags.artwork);
          const art=compressed||tags.artwork;
          artworkCache.current[track.id]=art;
          try{
            const existing=await cmDbGet("tracks",track.id);
            if(existing){
              await cmDbPut("tracks",{...existing,artwork:art,artworkVersion:ARTWORK_PARSER_VERSION});
              setLibrary(prev=>prev.map(t=>t.id===track.id?{...t,artwork:art,artworkVersion:ARTWORK_PARSER_VERSION}:t));
            }
          }catch{}
        }else if(!track.artwork){
          // Only mark "no artwork" cache flag when the track had no artwork
          // to begin with. If we're re-scanning an existing artworked track
          // and the new extraction failed, KEEP the existing (possibly
          // imperfect) artwork rather than blanking it.
          artworkCache.current[track.id]=false;
        }
      }catch{}
      processed++;
      if(total>0)setProgress({kind:"artwork",done:processed,total});
    }
    // Clear progress only if the analysis path isn't running. If both happen
    // back-to-back (auto-maint sequences them), the next setProgress call
    // from analyzeAll / processQ takes over.
    if(queueRef.current.length===0&&!activeRef.current)setProgress(null);
    setTimeout(()=>setAnalyzing(false),300);
  },[library,getFile]);

  const clear=()=>{setLibrary([]);fileMap.current={};fileMapOrder.current=[];opfsClear();};

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

  // Force re-analyze a single track. Mark unanalyzed, persist, then enqueue
  // (queue holds id only — file is resolved lazily by processQ). Skip flags
  // are intentionally NOT set: re-analyze means we want fresh BPM/key, not
  // to re-use whatever ID3 had. Recovery path for tracks analyzed under the
  // pre-May 25 full-rate pipeline or with bad ID3-supplied values.
  // Export tracks + crates + queue as a JSON file. Audio bytes are NOT
  // exported (too large for a portable backup). Artwork data URLs ARE
  // included since they're already compressed (~10–20 KB / track) and
  // restoring artwork is the user-visible surface that distinguishes a
  // recovered library from a re-import. Safety net for users where
  // navigator.storage.persist() is denied (Safari, private mode, embedded
  // browsers) or who want a portable backup before a major OS / browser change.
  const exportLibrary=useCallback(async()=>{
    const [tracks,crates,queue]=await Promise.all([
      cmDbAll("tracks"),cmDbAll("crates"),cmDbAll("queue"),
    ]);
    const payload={
      schemaVersion:1,
      exportedAt:Date.now(),
      appName:"mix-sync",
      counts:{tracks:tracks.length,crates:crates.length,queue:queue.length},
      tracks,crates,queue,
    };
    const blob=new Blob([JSON.stringify(payload)],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url;
    a.download=`mixsync-library-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a);a.click();document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return {tracks:tracks.length,crates:crates.length,queue:queue.length};
  },[]);

  // Import a previously exported library JSON. Dedupes by track id. Crates
  // and queue are merged additively. Audio for newly-restored tracks must be
  // reconnected via the existing "Reconnect music folder" flow — the JSON
  // contains metadata only.
  const importLibraryJson=useCallback(async(file)=>{
    let payload;
    try{payload=JSON.parse(await file.text());}
    catch{return {error:"invalid-json"};}
    if(!payload||payload.appName!=="mix-sync"||payload.schemaVersion!==1){
      return {error:"unrecognized-format"};
    }
    const existing=await cmDbAll("tracks");
    const existingIds=new Set(existing.map(t=>t.id));
    let imported=0,skipped=0;
    for(const t of payload.tracks||[]){
      if(existingIds.has(t.id)){skipped++;continue;}
      try{await cmDbPut("tracks",t);imported++;}catch{}
    }
    for(const c of payload.crates||[]){
      try{await cmDbPut("crates",c);}catch{}
    }
    await reload();
    return {imported,skipped,crates:(payload.crates||[]).length};
  },[reload]);

  // Persist a user grid edit for a single track. Writes new gridAnchorSec /
  // bpmOverride / gridEditedAt to the IDB record and updates in-memory
  // library state so the downstream effective-grid merge picks it up
  // immediately. Either field can be cleared by passing `null` explicitly
  // (omitting the key leaves the prior value alone).
  // The gridEditedAt stamp signals to any future re-analysis that the user
  // has manually corrected this track's grid — re-analyzers update bpm /
  // beatPeriodSec via the analyzer worker, but the user override fields are
  // only ever touched by this function, so the user's work is preserved
  // across re-analysis by construction.
  const setGridEdit=useCallback(async(id,fields)=>{
    const existing=await cmDbGet("tracks",id);
    if(!existing){console.warn('[GRID-EDIT] no track for',id);return false;}
    const patch={...existing,gridEditedAt:Date.now()};
    if(Object.prototype.hasOwnProperty.call(fields,'gridAnchorSec'))patch.gridAnchorSec=fields.gridAnchorSec;
    if(Object.prototype.hasOwnProperty.call(fields,'bpmOverride'))patch.bpmOverride=fields.bpmOverride;
    try{await cmDbPut("tracks",patch);}catch(err){console.warn('[GRID-EDIT] persist failed',err);return false;}
    setLibrary(prev=>prev.map(t=>t.id===id?patch:t));
    console.log('[GRID-EDIT]',{id,fields,gridEditedAt:patch.gridEditedAt});
    return true;
  },[]);

  // Force re-extract artwork for a single track. Parallel recovery flow to
  // reanalyze() from Session 1 — for tracks where the embedded source
  // changed, the bulk scanArtwork pass missed something, or the user wants
  // to nudge a single broken thumbnail without running the whole library.
  // Unlike scanArtwork, this bypasses both filters (missing-artwork AND
  // stale-version) and always tries.
  const reExtractArtwork=useCallback(async(id)=>{
    const file=await getFileRef.current?.(id);
    if(!file){console.warn('[REEXTRACT-ARTWORK] no file for',id);return false;}
    try{
      const sl=file.slice(0,ID3_READ_WINDOW);
      const tags=parseID3(await sl.arrayBuffer());
      if(!tags.artwork){
        console.log('[REEXTRACT-ARTWORK] no artwork in source',id);
        return false;
      }
      const compressed=await downscaleArtwork(tags.artwork);
      const art=compressed||tags.artwork;
      artworkCache.current[id]=art;
      const existing=await cmDbGet("tracks",id);
      if(existing){
        await cmDbPut("tracks",{...existing,artwork:art,artworkVersion:ARTWORK_PARSER_VERSION});
        setLibrary(prev=>prev.map(t=>t.id===id?{...t,artwork:art,artworkVersion:ARTWORK_PARSER_VERSION}:t));
      }
      return true;
    }catch(err){
      console.warn('[REEXTRACT-ARTWORK] failed',id,err);
      return false;
    }
  },[]);

  const reanalyze=useCallback(async(id)=>{
    const t=library.find(x=>x.id===id);
    if(!t)return;
    if(queueRef.current.some(q=>q.id===id))return;
    const reset={...t,bpm:null,key:null,energy:null,analyzed:false,error:false};
    setLibrary(prev=>prev.map(x=>x.id===id?reset:x));
    try{await cmDbPut("tracks",reset);}catch{}
    queueRef.current.push({id,skipBPM:false,skipKey:false});
    processQ();
  },[library,processQ]);

  // Automatic background maintenance. Replaces the previous "Scan artwork" +
  // "Analyze library" toolbar buttons with invisible auto-recovery. Fires
  // once per app load after a 4 s post-mount delay (lets initial render +
  // IDB load settle before consuming resources). Runs the two passes
  // SEQUENTIALLY (artwork first, then analysis) to avoid contention on
  // main-thread decodeAudioData. Both passes use the exact same code paths
  // as the manual triggers — the streaming serial-queue + Web Worker pipeline
  // from Session 1 (mono 11 kHz downsample, transferable buffers, idle yield
  // between worker results, AudioContext recycle every 50 tracks). No new
  // memory paths introduced.
  useEffect(()=>{
    if(autoMaintStartedRef.current)return;
    if(!library||library.length===0)return; // wait for IDB load to populate library
    autoMaintStartedRef.current=true;
    const t=setTimeout(async()=>{
      try{
        const lib=library||[];
        const needsArtwork=lib.some(x=>!x.artwork||(x.artworkVersion||0)<ARTWORK_PARSER_VERSION);
        const needsAnalysis=lib.some(x=>!x.analyzed||x.error);
        console.log('[AUTO-MAINT]',{libSize:lib.length,needsArtwork,needsAnalysis});
        if(needsArtwork){
          console.log('[AUTO-MAINT] starting artwork scan');
          await scanArtwork();
          console.log('[AUTO-MAINT] artwork scan complete');
        }
        if(needsAnalysis){
          console.log('[AUTO-MAINT] starting analyzeAll');
          analyzeAll();
          // analyzeAll returns immediately after seeding the queue; the
          // actual worker progress drains in the background via processQ +
          // onmessage. No need to await here.
        }
      }catch(err){
        console.warn('[AUTO-MAINT] failed',err);
      }
    },4000);
    // Intentionally no cleanup: if library changes during the delay we still
    // want the timer to fire. The body re-reads library state at fire time
    // via the closure, and the autoMaintStartedRef guard prevents this
    // effect from re-firing on subsequent library changes.
    return ()=>{}; // satisfy React deps lint without cancelling the timer
  },[library,scanArtwork,analyzeAll]);

  return{library,queue,crates,importing,importFiles,importFromPicker,previewImport,commitImport,queueAnalysis,reanalyze,reExtractArtwork,setGridEdit,getFile,clear,reload,setLibrary,fileMap,setFile,removeFile,analyzing,progress,analyzeAll,extractArtworkForTrack,artworkCache,reconnectFromFolder,scanArtwork,exportLibrary,importLibraryJson};
}

// ── Library Panel UI ──────────────────────────────────────────

// Avatar colour-hash for artwork placeholder
const SES_AVATAR_COLORS=[["#8B5CF6","#6D28D9"],["#9CA3AF","#A07840"],["#9CA3AF","#0099bb"],["#22c55e","#16a34a"],["#f59e0b","#d97706"],["#ef4444","#dc2626"],["#ec4899","#db2777"],["#14b8a6","#0d9488"]];
function sesAvatarColor(str=""){let h=0;for(let i=0;i<str.length;i++)h=(h<<5)-h+str.charCodeAt(i);return SES_AVATAR_COLORS[Math.abs(h)%SES_AVATAR_COLORS.length];}

// Single source of truth for album-art rendering across the mixer. Replaces
// five previous inline render sites that drifted in three ways:
//   - <img> sites had no onError, so a broken data URL rendered as the
//     browser's broken-image icon (Session 2.5 "no art shows broken state").
//   - Some sites used backgroundImage on a div without backgroundSize:cover
//     (queue/suggestions), which rendered the source at intrinsic size and
//     clipped from the top-left ("only half the picture").
//   - Fallback styling was inconsistent (letter initials, "♪" glyph, deck-
//     color gradient) and none matched the Quiet Pro Tool palette.
//
// AlbumArt enforces: square via CSS aspect-ratio 1/1 (belt-and-suspenders to
// width/height), object-fit cover, loading="lazy" so off-screen library rows
// don't decode at mount, single subtle music-note SVG fallback on the spec's
// rgba(255,255,255,0.04) background, onError → fallback so broken sources
// degrade gracefully instead of showing the browser glyph.
function AlbumArt({ src, size = 36, radius = 4, alt = "", isActive = false, onClick, title, style = {}, children }) {
  const [errored, setErrored] = useState(false);
  // Reset error state if the src changes (e.g. after Reconnect folder)
  useEffect(() => { setErrored(false); }, [src]);
  const showImg = !!src && !errored;
  const iconSize = Math.max(10, Math.round(size * 0.42));
  return (
    <div
      onClick={onClick}
      title={title}
      style={{
        width: size, height: size,
        aspectRatio: "1 / 1",
        borderRadius: radius,
        flexShrink: 0,
        overflow: "hidden",
        position: "relative",
        background: showImg ? "#000" : "rgba(255,255,255,0.06)",
        display: "flex", alignItems: "center", justifyContent: "center",
        outline: isActive ? "2px solid rgba(255,255,255,0.9)" : "none",
        transition: "outline 150ms cubic-bezier(0.4, 0, 0.2, 1)",
        cursor: onClick ? "pointer" : "default",
        userSelect: "none",
        ...style,
      }}
    >
      {showImg ? (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          draggable={false}
          onError={() => setErrored(true)}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      ) : (
        // Filled note heads + thicker stem at slightly higher alpha (0.4)
        // so the fallback reads at 11–15px display sizes. Stroked outlines
        // at 1.2px effectively disappeared after AA. Filled ellipses give
        // the glyph visual weight without bumping into the secondary
        // (0.6) accent tier reserved for active states.
        <svg width={iconSize} height={iconSize} viewBox="0 0 16 16" fill="rgba(255,255,255,0.4)" aria-hidden="true">
          <path d="M6 12V3l7-1.5v8" stroke="rgba(255,255,255,0.4)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
          <ellipse cx="4.5" cy="12" rx="2" ry="1.5"/>
          <ellipse cx="11.5" cy="10" rx="2" ry="1.5"/>
        </svg>
      )}
      {children}
    </div>
  );
}

function LibraryPanelV2({ lib, onLoad, playingTrack, deckATrackId:deckATrackIdProp=null, deckBTrackId:deckBTrackIdProp=null, previewTrackId, onPreview, onDelete, chat, onSendChat, me, rkLib=null, rkStatus={phase:"idle"}, onConnectRekordbox=null }) {
  const G = "#9CA3AF";
  const BG = "#0D0F12";
  const BG2 = "#15171A";
  const BG3 = "#1F2126";
  const BORDER = "rgba(255,255,255,0.06)";
  const TEXT = "#F5F5F7";
  const SUBTLE = "#9CA3AF";
  const MUTED = "#5A5E66";
  const PARTNER = "#A855F7";

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
  const deckATrackId = useMock ? "m2"  : (deckATrackIdProp || null);
  const deckBTrackId = useMock ? "m5"  : (deckBTrackIdProp || null);
  const DECK_A_CLR = "#2E86DE"; // deep navy / teal-blue
  const DECK_B_CLR = "#A855F7"; // deep slate / gray-blue

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

  // Per-row right-click context menu. {trackId, x, y} when open, null when closed.
  // Lives at the panel level so only one menu is open at a time. Track rows below
  // call onContextMenu to populate it; menu closes on outside click or item select.
  const [rowCtxMenu, setRowCtxMenu] = useState(null);
  useEffect(() => {
    if (!rowCtxMenu) return;
    const close = () => setRowCtxMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("contextmenu", (e) => {
      // Allow opening a different row's menu without flicker — but close if
      // the right-click landed outside any track row.
      if (!e.target.closest?.("[data-track-row]")) setRowCtxMenu(null);
    });
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [rowCtxMenu]);

  // (Removed hoveredRowId — A/B chips are now always-visible on the left of
  // each row instead of hover-revealed. Hover-reveal hid the load-to-B path
  // for users who didn't move the mouse over the row.)

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
  // Backstop: a drag that ends outside the wrapper (cursor leaves window,
  // Escape, another tab steals the drag) won't fire `drop` or symmetric
  // `dragleave` on us, leaving isDraggingOver stuck `true` and the dashed
  // outline visible until refresh. Window-level dragend/drop always clears
  // the flag regardless of where the drag ended.
  useEffect(() => {
    const reset = () => setIsDraggingOver(false);
    window.addEventListener("dragend", reset);
    window.addEventListener("drop", reset);
    return () => {
      window.removeEventListener("dragend", reset);
      window.removeEventListener("drop", reset);
    };
  }, []);
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
        padding: "8px 14px 8px 11px", cursor: "pointer",
        display: "flex", justifyContent: "space-between", alignItems: "center",
        borderLeft: `3px solid ${isActive ? "rgba(255,255,255,0.9)" : "transparent"}`,
        background: isActive ? "rgba(255,255,255,0.06)" : "transparent",
        color: isActive ? TEXT : SUBTLE, fontSize: 12,
        transition: "color .12s, background .12s",
      }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        <span style={{ fontSize: 10, color: MUTED, fontFamily: "'Inter',sans-serif", marginLeft: 6, fontVariantNumeric: "tabular-nums" }}>{count}</span>
      </div>
    );
  };

  const FilterPill = ({ children, onRemove }) => (
    <span style={{
      padding: "3px 4px 3px 9px", background: `${G}15`, border: `1px solid ${G}44`, color: G,
      borderRadius: 12, fontSize: 10, fontFamily: "'Inter',sans-serif",
      display: "inline-flex", alignItems: "center", gap: 2,
    }}>
      <span>{children}</span>
      <span onClick={onRemove} style={{ cursor: "pointer", opacity: 0.7, padding: "0 4px" }}>×</span>
    </span>
  );

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        // Only flag as a file-drop target when the drag actually carries
        // files. Internal drags (track-row reorder, text selection, image
        // drag, etc.) don't include 'Files' in dataTransfer.types, so they
        // no longer trigger the dashed outline. Fixes the "outline appears
        // after a few minutes" bug where an internal drag-end outside the
        // wrapper left isDraggingOver stuck true.
        const types = e.dataTransfer?.types;
        const hasFiles = types && (typeof types.includes === "function"
          ? types.includes("Files")
          : Array.from(types).indexOf("Files") >= 0);
        if (hasFiles && !isDraggingOver) setIsDraggingOver(true);
      }}
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
      style={{ display: "flex", height: "100%", background: BG, fontFamily: "'Inter',sans-serif", color: TEXT, position: "relative", overflow: "hidden", outline: isDraggingOver ? `2px dashed ${G}` : "none", outlineOffset: -2 }}>

      {/* ── LEFT RAIL ── */}
      <div style={{ width: 180, flexShrink: 0, borderRight: `1px solid ${BORDER}`, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "18px 14px 8px", fontSize: 9, letterSpacing: 2, color: MUTED, fontFamily: "'Inter',sans-serif", textTransform: "uppercase", fontWeight: 500 }}>Smart</div>
        <FolderItem kind="smart" id="recent"  label="Recently Played"     count={playedIds.size} onClick={() => selectSmart("recent")} />
        <FolderItem kind="smart" id="session" label="Played This Session" count={playedIds.size} onClick={() => selectSmart("session")} />
        <div style={{ padding: "18px 14px 8px", fontSize: 9, letterSpacing: 2, color: MUTED, fontFamily: "'Inter',sans-serif", textTransform: "uppercase", fontWeight: 500 }}>Folders</div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {crates.length === 0
            ? <div style={{ padding: "8px 14px", color: MUTED, fontSize: 11, fontStyle: "italic" }}>No folders yet</div>
            : crates.map(c => <FolderItem key={c.id} kind="folder" id={c.id} label={c.name} count={c.trackIds?.length || 0} onClick={() => selectFolder(c.id)} />)}
        </div>
        {/* Footer CTAs — restrained text buttons, not chunky chips. */}
        <div style={{ padding: "10px 12px 14px", borderTop: `1px solid ${BORDER}`, display: "flex", flexDirection: "column", gap: 2 }}>
          <button onClick={handleAddMusic} style={{
            width: "100%", height: 26, background: "transparent", border: "none",
            color: SUBTLE, fontSize: 11, letterSpacing: 0.2, fontFamily: "'Inter',sans-serif",
            borderRadius: 3, cursor: "pointer", textAlign: "left", padding: "0 4px",
            transition: "color .12s",
          }}
            onMouseEnter={e => e.currentTarget.style.color = TEXT}
            onMouseLeave={e => e.currentTarget.style.color = SUBTLE}
          >+ Add music</button>
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
            width: "100%", height: 26, background: "transparent", border: "none",
            color: SUBTLE, fontSize: 11, letterSpacing: 0.2, fontFamily: "'Inter',sans-serif",
            borderRadius: 3, cursor: "pointer", textAlign: "left", padding: "0 4px",
            transition: "color .12s",
          }}
            onMouseEnter={e => e.currentTarget.style.color = TEXT}
            onMouseLeave={e => e.currentTarget.style.color = SUBTLE}
          >+ New folder</button>
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
                  fontSize: 11, fontFamily: "'Inter',sans-serif", letterSpacing: 1.5,
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
          <span style={{ fontSize: 11, color: MUTED, fontFamily: "'Inter',sans-serif" }}>
            · {showGroups ? `${groups.length} group${groups.length === 1 ? "" : "s"}` : `${tracks.length} track${tracks.length === 1 ? "" : "s"}`}
          </span>
        </div>

        {/* Search */}
        <div style={{ padding: "10px 14px 8px", background: "transparent", borderBottom: `1px solid ${BORDER}` }}>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search tracks, artists, labels…  or  '124 8a high'"
            style={{
              width: "100%", padding: "8px 12px", background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.05)",
              color: TEXT, fontFamily: "'Inter',sans-serif", fontSize: 12, borderRadius: 5, outline: "none",
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
                fontFamily: "'Inter',sans-serif", fontSize: 10, letterSpacing: 1, outline: "none",
                display: "flex", alignItems: "center", gap: 5,
              }}>
              <span style={{ fontSize: 12 }}>✦</span> SUGGESTIONS
            </button>
            {/* SCAN ARTWORK + ANALYZE LIBRARY toolbar buttons removed —
                background maintenance now runs automatically on app mount and
                on each new import. Progress surfaces via the subtle indicator
                at the bottom of the track list. Methods stay callable
                (lib.scanArtwork / lib.analyzeAll) for per-track recovery via
                the right-click context menu and for internal triggers. */}
            {/* Rekordbox library connect pill — shown beside SUGGESTIONS. */}
            {onConnectRekordbox && (
              <button
                onClick={() => { if (rkStatus.phase === "idle" || rkStatus.phase === "error") onConnectRekordbox(); }}
                disabled={rkStatus.phase === "connecting"}
                title={
                  rkStatus.phase === "ready"
                    ? `Rekordbox connected · ${rkStatus.trackCount} tracks · waveforms will load from .EXT files`
                    : rkStatus.phase === "connecting"
                      ? `Connecting… (${rkStatus.step || "starting"})`
                      : rkStatus.phase === "error"
                        ? `Connect failed: ${rkStatus.error}`
                        : "Connect to Rekordbox library for native waveforms + cue points"
                }
                style={{
                  padding: "4px 10px", height: 22,
                  background: rkStatus.phase === "ready" ? `${STATUS_OK}22` : "transparent",
                  border: `1px solid ${rkStatus.phase === "ready" ? STATUS_OK : (rkStatus.phase === "error" ? "#ff445566" : BORDER)}`,
                  color: rkStatus.phase === "ready" ? STATUS_OK : (rkStatus.phase === "error" ? "#ff4455" : SUBTLE),
                  borderRadius: 4, cursor: rkStatus.phase === "connecting" ? "wait" : "pointer",
                  fontFamily: "'Inter',sans-serif", fontSize: 10, letterSpacing: 1, outline: "none",
                  display: "flex", alignItems: "center", gap: 5,
                }}>
                <span style={{ fontSize: 11 }}>🎛</span>
                {rkStatus.phase === "ready" ? `Rekordbox · ${rkStatus.trackCount}` :
                 rkStatus.phase === "connecting" ? "CONNECTING…" :
                 rkStatus.phase === "error" ? "Retry" : "Rekordbox"}
              </button>
            )}
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
              <div style={{ fontSize: 14, fontFamily: "'Inter',sans-serif", color: G, letterSpacing: 1.5, fontWeight: 600 }}>Add your music</div>
              <div style={{ fontSize: 11, fontFamily: "'Inter',sans-serif", color: SUBTLE, lineHeight: 1.6, fontWeight: 300 }}>
                Drop tracks here or click to add
              </div>
              <div style={{ fontSize: 10, fontFamily: "'Inter',sans-serif", color: MUTED, lineHeight: 1.6, fontWeight: 300, marginTop: -4 }}>
                Drag a folder for bulk import
              </div>
              <div style={{ fontSize: 9, fontFamily: "'Inter',sans-serif", color: MUTED, letterSpacing: 1, marginTop: 4 }}>
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
                    <span style={{ fontSize: 10, color: MUTED, fontFamily: "'Inter',sans-serif" }}>
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
              <div key={t.id}
                data-track-row={t.id}
                onClick={() => { console.log('[ROW-CLICK]',{id:t.id,title:t.title,artist:t.artist}); onLoad(t, "A"); }}
                onContextMenu={(e) => {
                  // Position menu at the click point, clamped so it doesn't
                  // overflow the viewport for rows near the bottom edge.
                  e.preventDefault();
                  e.stopPropagation();
                  const MENU_W = 220, MENU_H = 220;
                  const x = Math.min(e.clientX, window.innerWidth - MENU_W - 8);
                  const y = Math.min(e.clientY, window.innerHeight - MENU_H - 8);
                  setRowCtxMenu({ trackId: t.id, x, y });
                }}
                onMouseEnter={e => { e.currentTarget.style.background = deckClr ? `${deckClr}22` : "rgba(255,255,255,0.04)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = baseBg; }}
                style={{
                  display: "flex", alignItems: "center", gap: 12,
                  padding: "7px 12px 7px 9px", cursor: "pointer", opacity: played && !deckClr ? 0.55 : 1,
                  borderRadius: 4, marginBottom: 1,
                  background: baseBg,
                  borderLeft: `3px solid ${deckClr || "transparent"}`,
                  transition: "background-color 150ms cubic-bezier(0.4, 0, 0.2, 1)",
                }}>
                {/* Album art — 32px, left edge as visual anchor */}
                <AlbumArt src={artwork} size={32} radius={3} alt={t.title||""}/>
                {/* Title (weight 500) + artist (white at 0.6) */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: TEXT, display: "flex", alignItems: "center", gap: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {played && <span style={{ color: "rgba(255,255,255,0.6)", fontSize: 10, flexShrink: 0 }}>✓</span>}
                    <span title={t.analyzed ? "Analyzed" : "Metadata only"} style={{
                      width: 5, height: 5, borderRadius: 3, flexShrink: 0,
                      background: t.analyzed ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.2)",
                      display: "inline-block",
                    }} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{t.title || "(untitled)"}</span>
                  </div>
                  <div style={{ fontSize: 11, fontWeight: 400, color: "rgba(255,255,255,0.6)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 1 }}>{t.artist || ""}</div>
                </div>
                {/* Energy — thin horizontal bar, replaces underscore/text decoration */}
                <div style={{ width: 56, flexShrink: 0 }}>
                  {t.energy != null && (
                    <div style={{ height: 3, background: "rgba(255,255,255,0.08)", borderRadius: 2, overflow: "hidden" }}>
                      <div style={{ width: `${Math.min(100, t.energy)}%`, height: "100%", background: "rgba(255,255,255,0.6)" }} />
                    </div>
                  )}
                </div>
                {/* Right cluster — BPM, Key, Duration, tight tabular alignment */}
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
                  <div style={{ width: 44, textAlign: "right", fontFamily: "'Inter',sans-serif", fontSize: 12, fontWeight: 500, color: t.bpm ? TEXT : MUTED }}>
                    {t.bpm ? t.bpm.toFixed(1) : "—"}
                  </div>
                  <div style={{ width: 36, display: "flex", justifyContent: "center" }}>
                    {t.key
                      ? <span style={{ fontSize: 9, padding: "2px 5px", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "rgba(255,255,255,0.9)", borderRadius: 3, fontFamily: "'Inter',sans-serif", letterSpacing: 0.5, fontWeight: 500 }}>{t.key}</span>
                      : <span style={{ fontSize: 10, color: MUTED }}>—</span>}
                  </div>
                  <div style={{ width: 40, textAlign: "right", fontFamily: "'Inter',sans-serif", fontSize: 11, color: "rgba(255,255,255,0.6)" }}>
                    {fmtDur(t.duration)}
                  </div>
                </div>
                {/* A / B load buttons — always visible, filled when track is loaded
                    on that deck. stopPropagation so they don't double-fire the
                    row's default-load-to-A click. */}
                <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                  <button onClick={e => { e.stopPropagation(); onLoad(t, "A"); }}
                    title="Load to Deck A"
                    style={{ padding: "3px 9px", fontSize: 11, fontWeight: 700, fontFamily: "'Inter',sans-serif",
                      background: onDeckA ? DECK_A_CLR : `${DECK_A_CLR}1f`,
                      border: `1px solid ${onDeckA ? DECK_A_CLR : DECK_A_CLR + "66"}`,
                      color: onDeckA ? "#0D0F12" : DECK_A_CLR,
                      borderRadius: 4, cursor: "pointer", letterSpacing: 0.5,
                      boxShadow: onDeckA ? `0 0 8px ${DECK_A_CLR}88` : "none" }}>A</button>
                  <button onClick={e => { e.stopPropagation(); onLoad(t, "B"); }}
                    title="Load to Deck B"
                    style={{ padding: "3px 9px", fontSize: 11, fontWeight: 700, fontFamily: "'Inter',sans-serif",
                      background: onDeckB ? DECK_B_CLR : `${DECK_B_CLR}1f`,
                      border: `1px solid ${onDeckB ? DECK_B_CLR : DECK_B_CLR + "66"}`,
                      color: onDeckB ? "#0D0F12" : DECK_B_CLR,
                      borderRadius: 4, cursor: "pointer", letterSpacing: 0.5,
                      boxShadow: onDeckB ? `0 0 8px ${DECK_B_CLR}88` : "none" }}>B</button>
                </div>
              </div>
            );
          })}

          {/* Track row context menu — single instance for the whole panel,
              positioned at the right-click point. Closes on outside click via
              the rowCtxMenu effect above. Items render conditionally — Re-
              analyze only when lib.reanalyze is exposed (it is, since Session
              1), Re-extract artwork when lib.reExtractArtwork is exposed
              (Session 2.6). Quiet Pro Tool styling: rgba-white panel, single
              accent tier, no decoration. */}
          {rowCtxMenu && (() => {
            const t = allTracks.find(x => x.id === rowCtxMenu.trackId);
            if (!t) return null;
            const itemStyle = {
              padding: "8px 14px", fontSize: 11, fontFamily: "'Inter',sans-serif",
              color: "rgba(255,255,255,0.6)", cursor: "pointer", background: "transparent",
              transition: "background-color 150ms cubic-bezier(0.4, 0, 0.2, 1), color 150ms cubic-bezier(0.4, 0, 0.2, 1)",
            };
            const onHover = (e) => { e.currentTarget.style.background = "rgba(255,255,255,0.04)"; e.currentTarget.style.color = "rgba(255,255,255,0.9)"; };
            const onLeave = (e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "rgba(255,255,255,0.6)"; };
            const dangerHover = (e) => { e.currentTarget.style.background = "rgba(239,68,68,0.08)"; e.currentTarget.style.color = "#ef4444"; };
            const dangerLeave = (e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "rgba(239,68,68,0.7)"; };
            return (
              <div
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                onContextMenu={(e) => e.preventDefault()}
                style={{
                  position: "fixed", left: rowCtxMenu.x, top: rowCtxMenu.y,
                  zIndex: 9999, minWidth: 220,
                  background: "rgba(20,20,24,0.96)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 6, padding: "4px 0",
                  boxShadow: "0 12px 32px rgba(0,0,0,0.7)",
                  backdropFilter: "blur(8px)",
                }}>
                <div style={{ padding: "4px 14px 6px", fontSize: 9, color: MUTED, letterSpacing: 1, fontFamily: "'Inter',sans-serif", borderBottom: "1px solid rgba(255,255,255,0.06)", marginBottom: 4 }}>
                  {(t.title || t.filename || "Track").slice(0, 28)}
                </div>
                <div onClick={() => { onLoad(t, "A"); setRowCtxMenu(null); }} onMouseEnter={onHover} onMouseLeave={onLeave} style={itemStyle}>Load to Deck A</div>
                <div onClick={() => { onLoad(t, "B"); setRowCtxMenu(null); }} onMouseEnter={onHover} onMouseLeave={onLeave} style={itemStyle}>Load to Deck B</div>
                {/* Re-analyze and Re-extract artwork items removed — auto-
                    maintenance handles both cases on app mount + on import.
                    lib.reanalyze and lib.reExtractArtwork remain callable
                    internally for developer use via the console. */}
                {onDelete && (
                  <>
                    <div style={{ height: 1, background: "rgba(255,255,255,0.06)", margin: "4px 0" }}/>
                    <div onClick={() => { onDelete(t.id); setRowCtxMenu(null); }} onMouseEnter={dangerHover} onMouseLeave={dangerLeave} style={{ ...itemStyle, color: "rgba(239,68,68,0.7)" }}>Remove from Library</div>
                  </>
                )}
              </div>
            );
          })()}
        </div>
        {/* Background maintenance progress — subtle status text at the bottom
            of the library column. Auto-hides when idle (lib.progress is
            null). Single line, low-opacity, sentence case per Quiet Pro Tool.
            Replaces the prior toolbar SCAN ARTWORK / ANALYZE LIBRARY buttons
            with invisible, automatic recovery. */}
        {lib.progress && (
          <div style={{
            padding: "6px 14px", fontSize: 10, fontFamily: "'Inter',sans-serif",
            color: "rgba(255,255,255,0.4)", letterSpacing: 0.3,
            borderTop: `1px solid ${BORDER}`,
            display: "flex", alignItems: "center", gap: 8,
            background: "transparent",
          }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "rgba(255,255,255,0.4)", animation: "pulse 1.6s ease-in-out infinite", flexShrink: 0 }}/>
            <span>
              {lib.progress.kind === "artwork"
                ? `Updating artwork… ${lib.progress.done} of ${lib.progress.total}`
                : `Analyzing ${lib.progress.done} of ${lib.progress.total}…`}
            </span>
          </div>
        )}
      </div>

      {/* ── RIGHT RAIL ── split ratio persisted via queueFraction (default 0.4) ── */}
      <div style={{ width: 280, flexShrink: 0, borderLeft: `1px solid ${BORDER}`, display: "flex", flexDirection: "column" }}>

        {/* QUEUE (top) */}
        <div style={{ flex: `${queueFraction} 1 0`, minHeight: 80, display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "10px 14px", fontSize: 10, letterSpacing: 2, fontFamily: "'Inter',sans-serif", color: G, borderBottom: `1px solid ${BORDER}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>Queue</span>
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
                    <AlbumArt
                      src={lib.artworkCache?.[t.id] || t.artwork}
                      size={26}
                      radius={2}
                      alt={t.title||""}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, color: TEXT, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</div>
                      <div style={{ fontSize: 10, color: SUBTLE, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.artist}</div>
                    </div>
                    <div style={{ fontSize: 10, color: G, fontFamily: "'Inter',sans-serif" }}>{t.bpm?.toFixed(0) || "—"}</div>
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
          <div style={{ padding: "10px 14px", fontSize: 10, letterSpacing: 2, fontFamily: "'Inter',sans-serif", color: G, borderBottom: `1px solid ${BORDER}`, display: "flex", alignItems: "center", gap: 8 }}>
            <span>Chat</span>
            <div style={{ width: 6, height: 6, borderRadius: 3, background: "#22c55e", boxShadow: "0 0 6px #22c55e88" }} />
            <span style={{ color: MUTED, fontSize: 9, fontFamily: "'Inter',sans-serif", letterSpacing: 0, textTransform: "none" }}>partner online</span>
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
                color: TEXT, fontFamily: "'Inter',sans-serif", fontSize: 11, borderRadius: 4, outline: "none",
              }} />
            <button onClick={sendChat} style={{
              height: 28, width: 32, background: `${G}18`, border: `1px solid ${G}33`, color: G,
              borderRadius: 4, cursor: "pointer", fontFamily: "'Inter',sans-serif", fontSize: 13, outline: "none",
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
            <div style={{ fontSize: 9, letterSpacing: 2, color: MUTED, fontFamily: "'Inter',sans-serif", marginBottom: 2 }}>SUGGESTIONS FOR</div>
            <div style={{ fontSize: 14, color: TEXT, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{
                width: 18, height: 18, borderRadius: 3,
                background: suggestionSourceDeck === "A" ? DECK_A_CLR : DECK_B_CLR,
                color: "#0D0F12", display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 10, fontFamily: "'Inter',sans-serif", fontWeight: 700,
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
                <AlbumArt
                  src={artwork}
                  size={36}
                  radius={3}
                  alt={t.title||""}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: TEXT, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>{t.title}</div>
                  <div style={{ fontSize: 10, color: SUBTLE, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.artist}</div>
                  {t.reasons && t.reasons.length > 0 && (
                    <div style={{ marginTop: 3, display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {t.reasons.map(r => (
                        <span key={r} style={{
                          fontSize: 8, padding: "1px 5px", background: "#22c55e14",
                          border: "1px solid #22c55e33", color: "#22c55e",
                          borderRadius: 3, fontFamily: "'Inter',sans-serif", letterSpacing: 0.3,
                        }}>{r}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 10, color: G, fontFamily: "'Inter',sans-serif", textAlign: "right" }}>
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
            fontFamily: "'Inter',sans-serif",
          }}
        >
          <div style={{
            width: 460, maxWidth: "92%", background: "#15171A",
            border: `1px solid ${G}22`, borderRadius: 16, padding: 32,
            display: "flex", flexDirection: "column", gap: 14,
            boxShadow: `0 40px 80px rgba(0,0,0,.7), 0 0 0 1px #1F2126`,
          }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontFamily: "'Cormorant Garamond',serif", fontWeight: 700, fontSize: 22, letterSpacing: -0.3, color: TEXT }}>
                Found {importPreview.items.length} {importPreview.items.length === 1 ? "track" : "tracks"}
              </div>
              <div style={{ fontSize: 9, fontFamily: "'Inter',sans-serif", color: `${G}55`, letterSpacing: 3, marginTop: 6 }}>Ready to import</div>
            </div>

            <div style={{ fontSize: 12, fontFamily: "'Inter',sans-serif", color: SUBTLE, lineHeight: 1.6, fontWeight: 300, textAlign: "center" }}>
              {importPreview.dupeCount} {importPreview.dupeCount === 1 ? "is" : "are"} already in your library.
              <br />What would you like to do?
            </div>

            {importPreview.dupeCount > 0 && importPreview.dupeCount <= 5 && (
              <div style={{
                background: "#0D0F12", border: `1px solid ${G}14`, borderRadius: 8,
                padding: "10px 14px", display: "flex", flexDirection: "column", gap: 4,
              }}>
                <div style={{ fontSize: 8, fontFamily: "'Inter',sans-serif", color: `${G}55`, letterSpacing: 2 }}>Duplicates</div>
                {importPreview.items.filter(i => i.isDupe).map((item, i) => (
                  <div key={i} style={{ fontSize: 11, color: TEXT, fontFamily: "'Inter',sans-serif", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
                  background: G, border: "none", color: "#0D0F12",
                  fontFamily: "'Inter',sans-serif", fontWeight: 500, fontSize: 11, letterSpacing: 2,
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
                  fontFamily: "'Inter',sans-serif", fontWeight: 500, fontSize: 10, letterSpacing: 2,
                  padding: "10px 16px", borderRadius: 8, cursor: "pointer", transition: "all .2s",
                }}
              >
                IMPORT ALL (INCLUDING DUPLICATES)
              </button>
              <button
                onClick={() => setImportPreview(null)}
                style={{
                  background: "transparent", border: "none", color: MUTED,
                  fontFamily: "'Inter',sans-serif", fontWeight: 500, fontSize: 9, letterSpacing: 2,
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
// 96px album art deck anchor. Sits to the left of each deck card's content;
// pulls compressed JPEG artwork from the loaded track's ID3 / Rekordbox
// metadata. Falls back to a subtle deck-color-tinted square with the deck
// letter — quietly confident, not loud. Crisp 4px corners per Quiet Pro
// Tool philosophy ("no softer than that — pro tools have crisp edges").
function DeckArt({ artwork, fallback, color }) {
  // Local error state so a broken-URL data URL falls back to the deck-color
  // letter glyph instead of showing the browser's broken-image icon. Reset
  // whenever the source changes so a reconnect-or-import re-tries.
  const [errored, setErrored] = useState(false);
  useEffect(() => { setErrored(false); }, [artwork]);
  const showImg = !!artwork && !errored;
  return (
    <div style={{
      width: 96, height: 96, flexShrink: 0,
      aspectRatio: "1 / 1",
      borderRadius: 4, overflow: "hidden",
      background: showImg ? "transparent" : `${color}1F`,  // 12% deck-color wash
      border: "1px solid rgba(255,255,255,0.06)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      {showImg ? (
        <img src={artwork} alt="" draggable={false} loading="lazy"
          onError={() => setErrored(true)}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}/>
      ) : (
        <span style={{
          fontFamily: "'Inter',sans-serif", fontSize: 32, fontWeight: 500,
          color: `${color}80`,  // 50% deck color
          letterSpacing: 0,
        }}>{fallback}</span>
      )}
    </div>
  );
}

function VU({ an, color, w=100 }) {
  const ref=useRef(null),raf=useRef(null);
  useEffect(()=>{ if(!an||!ref.current)return; const c=ref.current,ctx=c.getContext("2d"),d=new Uint8Array(an.frequencyBinCount); const draw=()=>{ raf.current=requestAnimationFrame(draw); an.getByteFrequencyData(d); const lv=d.reduce((s,v)=>s+v,0)/d.length/255; ctx.clearRect(0,0,c.width,c.height); const n=12; for(let i=0;i<n;i++){ctx.fillStyle=lv*n>i?(i>10?"#ef4444":i>8?"#f59e0b":color):"#0b0b18";ctx.fillRect(i*(c.width/n+.3),0,c.width/n-1,c.height);} }; draw(); return()=>cancelAnimationFrame(raf.current); },[an,color]);
  return <canvas ref={ref} width={w} height={6} style={{width:"100%",borderRadius:2}}/>;
}

// (Spectral color helper from Phase 2 v3 removed — both renderers now use
//  calm monochrome amplitude per design brief. See PHASE_2_STATUS.md for
//  the spectral attempt's diagnostic data + future revisit notes.)

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
      // Per-column bv/mv/hv preserved so Pass 2 can drive spectral color from
      // the same source data as the height calculation. Without this we'd be
      // recomputing band peaks per pixel in the color pass.
      const colB=new Float32Array(W);
      const colM=new Float32Array(W);
      const colH=new Float32Array(W);
      for(let x=0;x<W;x++){
        const i0=Math.floor(x*len/W), i1=Math.min(len-1,Math.floor((x+1)*len/W));
        let bv=0,mv=0,hv=0;
        for(let k=i0;k<=i1;k++){
          const bk=bArr[k]||0; if(bk>bv)bv=bk;
          const mk=mArr?mArr[k]||0:0; if(mk>mv)mv=mk;
          const hk=hArr?hArr[k]||0:0; if(hk>hv)hv=hk;
        }
        colB[x]=bv; colM[x]=mv; colH[x]=hv;
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

      // ── Pass 2: per-column amplitude overlay — calm, monochrome.
      // Solid deck-color fill with env-driven alpha. Per design brief: the
      // small in-deck waveform reads as "calm amplitude, not spectral" —
      // spectral colors live only in AnimatedZoomedWF (top zoomed area).
      // Per-column color was Phase 2 v3 work; reverted to monochrome here for
      // visual restraint at small (h=40) size.
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
        ctx.fillStyle=loopActive?"#9CA3AFcc":"#9CA3AF66";
        ctx.fillRect(lx1,0,2,H); ctx.fillRect(Math.max(lx1,lx2-2),0,2,H);
      }

      // ── Hot cue markers ──
      const CUE_CLR=["#9CA3AF","#ef4444","#22c55e","#f59e0b"];
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
  return <canvas ref={ref} onClick={onClick} style={{width:"100%",height:h,background:"#06070A",cursor:onSeek?"crosshair":"default",display:"block"}}/>;
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

// Build the silhouette Path2D for a column-height envelope. Pure geometry,
// no rendering side effects. Top sweep left→right at center-h, bottom sweep
// right→left at center+h. Selective quadratic curves smooth three-column
// monotonic runs; columns with delta > STEEP_THRESH force lineTo so kick/
// snare onsets keep their near-vertical attack edge. Top + bottom sweeps
// share the same check (based on |heights[]|) for symmetric kicks.
//
// Extracted from the AnimatedZoomedWF draw loop as Path A commit 1: pure-
// geometry helper that commit 2 will reuse to render the glow onto a
// stacked layer canvas separate from the crisp-detail canvas.
function buildSilhouettePath(heights,center,physW,maxH){
  const STEEP_THRESH=maxH*0.15;
  const path=new Path2D();
  path.moveTo(0,center);
  // Top sweep.
  if(physW>0) path.lineTo(0.5,center-heights[0]);
  for(let dx=1;dx<physW-1;dx++){
    const hPrev=heights[dx-1], hCur=heights[dx], hNext=heights[dx+1];
    const yPrev=center-hPrev, yCur=center-hCur, yNext=center-hNext;
    const dF=hNext>hCur?hNext-hCur:hCur-hNext;
    const dB=hCur>hPrev?hCur-hPrev:hPrev-hCur;
    const steep=dF>STEEP_THRESH||dB>STEEP_THRESH;
    const monotonic=!steep&&((yPrev<yCur&&yCur<yNext)||(yPrev>yCur&&yCur>yNext));
    if(monotonic){
      const midX=dx+1, midY=(yCur+yNext)*0.5;
      path.quadraticCurveTo(dx+0.5,yCur,midX,midY);
    } else {
      path.lineTo(dx+0.5,yCur);
    }
  }
  if(physW>1) path.lineTo(physW-0.5,center-heights[physW-1]);
  path.lineTo(physW,center);
  // Bottom sweep (mirror).
  if(physW>0) path.lineTo(physW-0.5,center+heights[physW-1]);
  for(let dx=physW-2;dx>0;dx--){
    const hPrev=heights[dx+1], hCur=heights[dx], hNext=heights[dx-1];
    const yPrev=center+hPrev, yCur=center+hCur, yNext=center+hNext;
    const dF=hNext>hCur?hNext-hCur:hCur-hNext;
    const dB=hCur>hPrev?hCur-hPrev:hPrev-hCur;
    const steep=dF>STEEP_THRESH||dB>STEEP_THRESH;
    const monotonic=!steep&&((yPrev<yCur&&yCur<yNext)||(yPrev>yCur&&yCur>yNext));
    if(monotonic){
      const midX=dx, midY=(yCur+yNext)*0.5;
      path.quadraticCurveTo(dx+0.5,yCur,midX,midY);
    } else {
      path.lineTo(dx+0.5,yCur);
    }
  }
  if(physW>1) path.lineTo(0.5,center+heights[0]);
  path.closePath();
  return path;
}

// Path A commit 2: silhouette glow source. Renders a single solid-color
// fill of the silhouette path onto the supplied context. The caller is
// expected to point ctx at the LOWER canvas (a separate <canvas> stacked
// behind the crisp-detail upper canvas, with CSS filter:blur applied via
// inline style). The browser's GPU compositor blurs the lower canvas as
// part of paint — no per-frame JS-side blur work, no shadowBlur cost.
//
// Supersedes the v5.8 multi-pass additive shadowBlur approach (three
// 'lighter'-composited fills at radii 70*dpr / 28*dpr / 0). That worked
// but capped out atmospherically and was the heaviest cost in the draw
// loop. CSS gaussian blur produces a more uniform halo for free.
//
// alpha is exposed as a tuning parameter (SILHOUETTE_FILL_ALPHA constant
// at the call site). 1.0 = full pigment; lower values yield a more
// translucent core after the CSS blur spreads it out.
function renderSilhouetteGlow(ctx,path,dr,dg,db,alpha){
  ctx.fillStyle=`rgba(${dr},${dg},${db},${alpha})`;
  ctx.fill(path);
}

function AnimatedZoomedWF({ bands, dur, progRef, onSeek, h=96, windowSec=8, beatPhaseFrac=null, beatPeriodSec=null, gridOffsetMs=0, barOneOffsetSec=0, bpmNudge=0, deckColor="#FFFFFF", rate=1 }) {
  // Path A glow tuning. Lower canvas renders a single solid-fill silhouette
  // and gets CSS filter:blur applied via inline style; the browser composites
  // the blur on the GPU. Tune visually by adjusting these three values.
  const LOWER_CANVAS_BLUR_PX = 20;             // CSS blur radius on the lower canvas
  const LOWER_CANVAS_OPACITY = 0.85;           // opacity multiplier on the lower canvas
  const SILHOUETTE_FILL_ALPHA = 1.0;           // alpha of the silhouette fill (pre-blur)
  const UPPER_CANVAS_SILHOUETTE_ALPHA = 0.9;   // alpha of the crisp body on the upper canvas

  const ref=useRef(null);       // upper canvas — crisp draws + drag target
  const lowerRef=useRef(null);  // lower canvas — silhouette fill, CSS-blurred
  const raf=useRef(null);
  const colBufRef=useRef(null); // {bv, mv, hv, heights: Float32Array, len} — per-column scratch
  const sizeRef=useRef({physW:0,physH:0,dirty:true});
  const durRef=useRef(dur);
  const seekRef=useRef(onSeek);
  // bands needs a ref too — the RAF useEffect only depends on [h, windowSec, progRef],
  // so without this the draw loop closure would hold a stale (initial) bands value
  // and never pick up new arrays when a track finishes analyzing.
  const bandsRef=useRef(bands);
  // While the user is drag-scrubbing the waveform, the draw loop reads
  // dragProgRef.current INSTEAD of progRef.current. This decouples the
  // displayed playhead from the audio position during a drag — the audio
  // keeps playing at its real position (no source thrashing), while the
  // canvas shows where the cursor is. On mouseup the drag handler calls
  // seek() once and clears this ref, returning the display to live audio.
  const dragProgRef=useRef(null);
  // Cached per-track max of bass-weighted env (0.7b+0.2m+0.1h) across the
  // full 24k source columns. Used to renormalize the per-column env in
  // Pass 2 so the loudest column on the track maps to 1.0 after the
  // weighted-sum reduction (which otherwise tops out around 0.85-0.95
  // because no column has bass=mid=high=1.0 simultaneously). Recomputed
  // once per bands-identity change; cheap (one linear pass over 24k).
  const envMaxRef=useRef({bands:null,maxVal:1});
  const beatPhaseFracRef=useRef(beatPhaseFrac);
  const beatPeriodSecRef=useRef(beatPeriodSec);
  const gridOffsetMsRef=useRef(gridOffsetMs);
  const barOneOffsetSecRef=useRef(barOneOffsetSec);
  const bpmNudgeRef=useRef(bpmNudge);
  const deckColorRef=useRef(deckColor);
  // Mirror rate to a ref so the draw loop and drag handler always see the
  // latest value without re-mounting either useEffect. The grid + waveform
  // math treats windowSec as WALL-time; multiplying by rate gives the visible
  // buffer-time span. Without this, two synced decks at different rates
  // produce different pixel-spacing-per-beat — grids align at the playhead
  // but progressively misalign looking ahead/behind, since each deck's
  // beatPeriodSec is in BUFFER time and the per-deck rate scales buffer-time
  // differently. Scaling windowSec by rate everywhere makes both decks show
  // the same WALL-time window, so their per-beat pixel spacing matches.
  const rateRef=useRef(rate);
  useEffect(()=>{rateRef.current=rate;},[rate]);
  useEffect(()=>{durRef.current=dur;},[dur]);
  useEffect(()=>{seekRef.current=onSeek;},[onSeek]);
  useEffect(()=>{bandsRef.current=bands;},[bands]);
  useEffect(()=>{beatPhaseFracRef.current=beatPhaseFrac;},[beatPhaseFrac]);
  useEffect(()=>{beatPeriodSecRef.current=beatPeriodSec;},[beatPeriodSec]);
  useEffect(()=>{gridOffsetMsRef.current=gridOffsetMs;},[gridOffsetMs]);
  useEffect(()=>{barOneOffsetSecRef.current=barOneOffsetSec;},[barOneOffsetSec]);
  useEffect(()=>{bpmNudgeRef.current=bpmNudge;},[bpmNudge]);
  useEffect(()=>{deckColorRef.current=deckColor;},[deckColor]);

  useEffect(()=>{
    const upper=ref.current;
    const lower=lowerRef.current;
    if(!upper||!lower) return;
    let physW=0,physH=0,ctx=null,lctx=null;
    const dpr=window.devicePixelRatio||1;

    // ResizeObserver watches the upper canvas; the lower canvas always fills
    // the same container at 100%/100% so they have identical CSS dimensions.
    // The dirty-check inside draw() sizes BOTH canvases in lock-step.
    const ro=new ResizeObserver(entries=>{
      const e=entries[0]; if(!e) return;
      const pw=Math.round(e.contentRect.width*dpr);
      const ph=Math.round(e.contentRect.height*dpr);
      sizeRef.current={physW:pw,physH:ph,dirty:true};
    });
    ro.observe(upper);

    const draw=()=>{
      raf.current=requestAnimationFrame(draw);

      const sz=sizeRef.current;
      if(sz.dirty||physW===0){
        sz.dirty=false;
        const newPW=sz.physW||Math.round((upper.offsetWidth||1200)*dpr);
        const newPH=sz.physH||Math.round(h*dpr);
        if(newPW!==physW||newPH!==physH){
          physW=newPW; physH=newPH;
          upper.width=physW; upper.height=physH;
          lower.width=physW; lower.height=physH;
          ctx=upper.getContext('2d');
          lctx=lower.getContext('2d');
          colBufRef.current=null; // force realloc on next frame
        }
      }
      if(!ctx||!lctx) return;

      const dur2=durRef.current;
      // Drag overlay takes precedence — see dragProgRef declaration above.
      const prog2=dragProgRef.current ?? (progRef?.current??0);
      // Two independent paddings:
      //  - tickRailPad governs where beat-grid ticks center vertically (visual
      //    positioning, anchored relative to the canvas edges).
      //  - ampPad governs how far the audio amplitude renders from the edge.
      //    v5: 28 → 6 css px (peaks were under-scaled, dead space at top/bot).
      //    v5.3: 6 → 11 — but peaks were still touching the grid tick rail.
      //    v5.4: 11 → 18. White grid markers should feel like they sit ABOVE
      //    the waveform, not embedded in it — needs visible empty space
      //    between the loudest peaks and the tick rail. tickRailPad is also
      //    18, so the amplitude region and tick rail now exactly meet
      //    (no overlap, no gap).
      const tickRailPad=Math.round(18*dpr);
      const ampPad=Math.round(18*dpr);
      const ampTop=ampPad;
      const ampBottom=physH-ampPad;
      const drawH=ampBottom-ampTop;
      const center=(ampTop+ampBottom)>>1;
      // maxH keeps top (center-envH ≥ ampTop) and bottom (center+1+envH ≤ ampBottom).
      const maxH=Math.max(0,Math.min(center-ampTop,ampBottom-1-center));
      const bands=bandsRef.current;

      // Path A commit 2: both canvases clear to TRANSPARENT each frame.
      // The container element behind them carries the #000000 background.
      // Lower canvas paints the silhouette glow source (CSS-blurred via
      // inline style); upper canvas paints the crisp detail layer.
      lctx.clearRect(0,0,physW,physH);
      ctx.clearRect(0,0,physW,physH);

      // Rate-aware visible-buffer-time span. windowSec is treated as WALL
      // seconds (the user-selected zoom level). At the current playback
      // rate, that wall-time window covers `windowSec * rate` buffer seconds
      // of source audio. With this scaling, two synced decks at different
      // rates both show the same wall-time amount of audio — and their grid
      // tick spacings match in pixels.
      const r=rateRef.current||1;
      const viewBufSec=windowSec*r;
      if(bands&&bands.bass&&bands.bass.length&&dur2&&maxH>0){
        const bArr=bands.bass, mArr=bands.mid, hArr=bands.high;
        const len=bArr.length;
        const viewPx=(viewBufSec/dur2)*len;
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

        // Silhouette rendered TWICE per frame, sharing one Path2D:
        //  1. Lower canvas: solid fill → CSS filter:blur(20px) on the
        //     element produces the atmospheric halo on the GPU compositor.
        //  2. Upper canvas: solid fill at UPPER_CANVAS_SILHOUETTE_ALPHA →
        //     the crisp body that defines the waveform shape against the
        //     blurred halo underneath. v5.8 had this as Pass C of the
        //     additive shadowBlur stack at alpha 0.45; Commit 2 dropped it
        //     by accident, leaving only the AA stroke outline on the upper
        //     canvas — fixed here.
        const silhouettePath=buildSilhouettePath(heights,center,physW,maxH);
        renderSilhouetteGlow(lctx,silhouettePath,dr,dg,db,SILHOUETTE_FILL_ALPHA);
        renderSilhouetteGlow(ctx,silhouettePath,dr,dg,db,UPPER_CANVAS_SILHOUETTE_ALPHA);

        // Thin AA stroke softens the silhouette edge.
        ctx.strokeStyle=`rgba(${dr},${dg},${db},0.55)`;
        ctx.lineWidth=Math.max(0.5,0.5*dpr);
        ctx.stroke(silhouettePath);

        // ── Pass 2b: per-column amplitude overlay — crisp readable core.
        // v5.10: gradient INVERTED from v5.8. Body of the waveform is now
        // the deep base color across nearly the whole column height; only
        // the very top tip (and mirrored bottom tip) gets a subtle peak
        // brightness lift (+40 above base, was +180). Result: the waveform
        // BODY reads as the deep saturated pigment we keep chasing, with a
        // thin highlight at the actual amplitude peak tips of loud columns.
        // Short columns sample only the middle deep-base stops — no
        // accidental "near-white centerline" rendering.
        const peakR=Math.min(255,dr+40), peakG=Math.min(255,dg+40), peakB=Math.min(255,db+40);
        const colGrad=ctx.createLinearGradient(0,ampTop,0,ampBottom);
        colGrad.addColorStop(0,    `rgba(${peakR},${peakG},${peakB},1.0)`);
        colGrad.addColorStop(0.05, `rgba(${dr},${dg},${db},0.95)`);
        colGrad.addColorStop(0.5,  `rgba(${dr},${dg},${db},0.92)`);
        colGrad.addColorStop(0.95, `rgba(${dr},${dg},${db},0.95)`);
        colGrad.addColorStop(1,    `rgba(${peakR},${peakG},${peakB},1.0)`);
        ctx.fillStyle=colGrad;
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
        // firstDownbeatSec = analyzer anchor + ms grid offset (existing
        // ±5ms tweaks) + manual bar-1 beat shift (whole-beat user override).
        const firstDownbeatSec=beatPhaseFrac*beatPeriodSec+gridOffsetMsRef.current/1000+barOneOffsetSecRef.current;
        const currentTimeSec=prog2*dur2;
        // pxPerSec is pixels per BUFFER second. viewBufSec = windowSec*rate
        // is the visible buffer-time span; physW/viewBufSec gives buffer
        // pixels-per-second that, after dividing the wall-time gap by rate
        // (equivalently, multiplying windowSec by rate up front here), maps
        // beats to identical pixel spacing on synced decks.
        const pxPerSec=physW/viewBufSec;
        const halfWinSec=viewBufSec/2;
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
        // 16-bar phrase markers: fixed red (#FF3B30) regardless of deck identity.
        // Red provides strong, unambiguous structural reference against the cool
        // dark waveform background; was previously derived from deck color.
        const PHRASE_RGB='255,59,48';

        // v5.3: grid LINES render in WHITE on both decks (contrast against
        // any deck color, functional reference structure).
        // v5.5: shadow GLOW around white grid lines uses DECK identity color
        // — gives the white markers a deck-toned halo so the waveform area
        // reads as atmospheric "club lighting" rather than flat white-on-dark.
        // White ticks carry the contrast; deck-color glow carries the
        // identity / vibe. Phrase tick branch overrides to red glow.
        const DECK_RGB=`${dr},${dg},${db}`;
        const OFF_FILL='rgba(255,255,255,0.55)';
        const DOWN_FILL='rgba(255,255,255,1.0)';
        const DOWN_LINE='rgba(255,255,255,0.22)';
        const PHRASE_FILL=`rgba(${PHRASE_RGB},1.0)`;
        const PHRASE_LINE=`rgba(${PHRASE_RGB},0.50)`; void PHRASE_LINE;

        ctx.shadowColor=`rgba(${DECK_RGB},0.65)`;
        ctx.shadowBlur=4;

        for(let n=startN;n<=endN;n++){
          const beatTime=firstDownbeatSec+n*effectivePeriod;
          if(beatTime<0) continue; // no grid before t=0 — audio doesn't exist there
          const x=(physW>>1)+(beatTime-currentTimeSec)*pxPerSec;
          if(x<-phraseTickW||x>physW+phraseTickW) continue;
          const isPhrase=(n%16===0);
          const isDownbeat=(n%4===0);

          if(isPhrase){
            // v5.2: phrase columns no longer get a red full-height through-line
            // (was too visually heavy, competed with waveform content). They
            // render as a normal downbeat (deck-color through-line + downbeat
            // ticks) PLUS red top/bottom phrase ticks for identity.
            ctx.fillStyle=DOWN_LINE;
            ctx.fillRect(Math.floor(x),0,lineW,physH);
            ctx.fillStyle=DOWN_FILL;
            const dx=Math.floor(x-downTickW/2);
            ctx.fillRect(dx,downTopY,downTickW,downTickH);
            ctx.fillRect(dx,downBotY,downTickW,downTickH);
            // Red phrase ticks on the outer rails — color-coherent red glow.
            ctx.shadowColor=`rgba(${PHRASE_RGB},0.7)`;
            ctx.shadowBlur=4;
            ctx.fillStyle=PHRASE_FILL;
            const px=Math.floor(x-phraseTickW/2);
            ctx.fillRect(px,phraseTopY,phraseTickW,phraseTickH);
            ctx.fillRect(px,phraseBotY,phraseTickW,phraseTickH);
            // Restore deck-color glow for subsequent off/downbeat draws.
            ctx.shadowColor=`rgba(${DECK_RGB},0.65)`;
            ctx.shadowBlur=4;
          }else if(isDownbeat){
            // Downbeat: 1px deck-color through-line + 2px×12px centered ticks.
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
        // Reset shadow so downstream draws (playhead, hot cues) aren't blurred.
        ctx.shadowBlur=0;
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

  // Drag-only seek with ANCHOR-based tracking (Rekordbox-style) and SEEK-ON-
  // RELEASE. Mousedown captures cursor X + prog AT THAT MOMENT. Mousemove
  // updates a local overlay ref (dragProgRef) — the draw loop prefers this
  // over the parent's progRef during a drag, so the canvas shows the dragged
  // playhead position smoothly without thrashing the audio source. Mouseup
  // fires ONE seek call to commit the audio to the final position. Prior
  // implementation seeked on every mousemove (~60 Hz), each call creating a
  // fresh AudioBufferSourceNode → massive audio-source churn during drags.
  useEffect(()=>{
    const canvas=ref.current; if(!canvas) return;
    let dragging=false;
    let mouseXAtDown=0;
    let progAtDown=0;
    let widthAtDown=0;
    const onDown=(e)=>{
      if(!seekRef.current||!durRef.current) return;
      const r=canvas.getBoundingClientRect();
      dragging=true;
      mouseXAtDown=e.clientX;
      progAtDown=progRef?.current ?? 0;
      widthAtDown=r.width;
      dragProgRef.current=progAtDown;
      e.preventDefault();
    };
    const onMove=(e)=>{
      if(!dragging||!seekRef.current||!durRef.current||!widthAtDown) return;
      const deltaPx=e.clientX-mouseXAtDown;
      // (deltaPx / canvasWidth) is the fraction of the visible window the
      // cursor has traversed; × (windowSec * rate / dur) converts that to a
      // fraction of the whole track. The * rate keeps drag distance
      // consistent in buffer-time terms now that windowSec is wall-time.
      const r=rateRef.current||1;
      const newProg=progAtDown+(deltaPx/widthAtDown)*(windowSec*r/durRef.current);
      dragProgRef.current=Math.max(0,Math.min(1,newProg));
    };
    const onUp=()=>{
      if(dragging&&dragProgRef.current!=null&&seekRef.current){
        // Commit the final dragged position to audio with a single seek call.
        seekRef.current(dragProgRef.current);
      }
      dragging=false;
      dragProgRef.current=null;
    };
    canvas.addEventListener('mousedown',onDown);
    window.addEventListener('mousemove',onMove);
    window.addEventListener('mouseup',onUp);
    return ()=>{
      canvas.removeEventListener('mousedown',onDown);
      window.removeEventListener('mousemove',onMove);
      window.removeEventListener('mouseup',onUp);
    };
  },[windowSec,progRef]);
  // Path A commit 2: two stacked canvases inside a container. The lower
  // canvas paints the silhouette and is CSS-blurred by the browser's GPU
  // compositor (filter:blur on its inline style). pointer-events:none on
  // the lower lets mouse events fall through to the upper canvas, which
  // is what the drag handler binds to (via `ref`). Container background
  // is #000000; both canvases clear to transparent each frame.
  return (
    <div style={{position:'relative',width:'100%',height:h,background:'#000000',cursor:'ew-resize',display:'block',userSelect:'none'}}>
      <canvas ref={lowerRef} style={{position:'absolute',top:0,left:0,width:'100%',height:'100%',filter:`blur(${LOWER_CANVAS_BLUR_PX}px)`,opacity:LOWER_CANVAS_OPACITY,pointerEvents:'none'}}/>
      <canvas ref={ref}      style={{position:'absolute',top:0,left:0,width:'100%',height:'100%'}}/>
    </div>
  );
}

function Knob({ v, set, min=-12, max=12, ctr=0, label, color="#9CA3AF", size=38, off }) {
  const dr=useRef(false),sy=useRef(0),sv=useRef(0); const pct=(v-min)/(max-min);
  const md=(e)=>{ if(off)return; e.preventDefault();dr.current=true;sy.current=e.clientY;sv.current=v; const mm=(ev)=>{if(dr.current)set(Math.max(min,Math.min(max,sv.current+(sy.current-ev.clientY)/100*(max-min))));};const mu=()=>{dr.current=false;window.removeEventListener("mousemove",mm);window.removeEventListener("mouseup",mu);};window.addEventListener("mousemove",mm);window.addEventListener("mouseup",mu); };
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2,userSelect:"none",opacity:off?.35:1}}>
      <div onMouseDown={md} onDoubleClick={()=>!off&&set(ctr)} style={{width:size,height:size,borderRadius:"50%",background:"#0a0a1c",border:`2px solid ${color}33`,cursor:off?"default":"ns-resize",position:"relative",boxShadow:v!==ctr?`0 0 8px ${color}22`:"none"}}>
        <div style={{position:"absolute",width:3,height:3,borderRadius:"50%",background:color,top:"50%",left:"50%",transform:`translate(-50%,-50%) rotate(${-135+pct*270}deg) translateY(-${size*.26}px)`}}/>
      </div>
      <span style={{fontSize:7,color:"#9CA3AF",fontFamily:"'Inter',sans-serif",letterSpacing:.5}}>{label}</span>
    </div>
  );
}

// ── Deck ─────────────────────────────────────────────────────
const HOT_CUE_COLORS=["#9CA3AF","#ef4444","#22c55e","#f59e0b"];

// Snap-to-transient — find the loudest sample within ±50 ms of the target
// time and return its position in seconds. Falls back to the raw target when
// no clear transient exists (peakAbs < 2 × meanAbs of the window). Matches
// the Rekordbox/Serato/Traktor "drop the playhead roughly, app snaps to the
// kick" pattern. Pure function; safe to call on the live AudioBuffer because
// it only reads channel data, never writes.
//
// Returns { position, snapped, peakAbs, meanAbs, ratio } so the caller can
// log which path fired. Defaults tuned for kick-drum detection: 50 ms is
// ~10% of beat period at 120 BPM, wide enough to forgive imprecise dropping
// but narrow enough to avoid bleeding into the next beat.
const GRID_SNAP_WINDOW_SEC = 0.050;
const GRID_SNAP_THRESHOLD = 2.0;
function snapToTransient(buf, targetSec) {
  const target = targetSec;
  if (!buf) return { position: target, snapped: false, reason: "no-buffer" };
  const sr = buf.sampleRate;
  const totalSamples = buf.length;
  const targetSample = Math.round(target * sr);
  const halfWindow = Math.round(GRID_SNAP_WINDOW_SEC * sr);
  const start = Math.max(0, targetSample - halfWindow);
  const end   = Math.min(totalSamples, targetSample + halfWindow);
  if (end - start < 2) return { position: target, snapped: false, reason: "window-too-small" };
  const chans = buf.numberOfChannels;
  const ch0 = buf.getChannelData(0);
  const ch1 = chans > 1 ? buf.getChannelData(1) : null;
  let peakAbs = 0;
  let peakIdx = targetSample;
  let sumAbs = 0;
  for (let i = start; i < end; i++) {
    const v = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
    const a = v < 0 ? -v : v;
    sumAbs += a;
    if (a > peakAbs) { peakAbs = a; peakIdx = i; }
  }
  const meanAbs = sumAbs / (end - start);
  const ratio = meanAbs > 0 ? peakAbs / meanAbs : 0;
  if (ratio < GRID_SNAP_THRESHOLD) {
    return { position: target, snapped: false, reason: "no-clear-transient", peakAbs, meanAbs, ratio };
  }
  return { position: peakIdx / sr, snapped: true, peakAbs, meanAbs, ratio };
}

function Deck({ id, ch, ctx:ac, color, local, remote, onChange, midi:mt, bpmResult, bpmAnalyze, eqHi=0, eqMid=0, eqLo=0, chanVol=1, loadFromLibrary=null, onTrackInfo=null, onSync=null, syncReady=true, syncRole=null, isMaster=false, onMasterToggle=null, onLibraryTrackDrop=null, onProgUpdate=null, onWaveform=null, onSeekReady=null, remoteSeek=null, onToggleReady=null, onCueReady=null, remoteToggle=null, remoteCue=null, onTransportFire=null, isDriver=true, onNudgeReady=null, acNowRef=null, onBufferReady=null, barOneOffsetSec=0, onGridEdit=null }) {
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
  // Pending nudge bookkeeping (see nudgeRate below).
  const nudgeT=useRef(null);
  const nudgeSrcRef=useRef(null);
  // Always-current refs for volatile state read by nudgeRate. Avoids stale
  // closure where nudgeRate captured at registration time held an old
  // play / rate / isDriver value (observed: registered function reported
  // play=false even after user pressed play and audio was audible).
  const playRef=useRef(play);
  const rateRef=useRef(rate);
  // Captures rate BEFORE a rate-state transition so the [rate] useEffect can
  // rebase off.current/st.current using the rate that was active during the
  // just-elapsed wall-time segment. Without rebasing, tick()'s rate-aware
  // position computation would retroactively re-rate the pre-change segment.
  const prevRateRef=useRef(1);
  const isDriverRef=useRef(isDriver);
  const bufRef=useRef(buf);
  useEffect(()=>{ bufRef.current=buf; },[buf]);
  // First-downbeat auto-position: reset on each fresh load(), set to true on
  // any user interaction (play/seek/cue) so the auto-position useEffect knows
  // whether the user has already taken control. positionedBufRef tracks which
  // AudioBuffer we've already positioned for so we fire exactly once per load.
  const userMovedRef = useRef(false);
  const positionedBufRef = useRef(null);
  useEffect(()=>{ playRef.current=play; console.log('[PLAY-STATE] deck',id,'play prop/state changed to '+play+', src.current='+!!src.current+', ac='+!!ac); },[play,id,ac]);
  useEffect(()=>{ rateRef.current=rate; },[rate]);
  useEffect(()=>{ isDriverRef.current=isDriver; console.log('[PLAY-STATE] deck',id,'isDriver changed to '+isDriver); },[isDriver,id]);
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

  const stop_=()=>{ console.log('[PLAY-STATE] deck',id,'stop_() called, destroying source (hadSrc='+!!src.current+')'); if(src.current){src.current.onended=null;try{src.current.stop();}catch{}src.current.disconnect();src.current=null;}cancelAnimationFrame(raf.current); };

  const play_=(o)=>{ if(!buf||!ch||!ac){console.log('[PLAY-STATE] deck',id,'play_() bailed early: hasBuf='+!!buf+' hasCh='+!!ch+' hasAc='+!!ac); return;} console.log('[PLAY-STATE] deck',id,'play_() creating source at offset',o); stop_(); if(ac.state==="suspended")ac.resume();
    const s=ac.createBufferSource(); s.buffer=buf; s.playbackRate.value=rate; s.connect(ch.trim);
    const lr=loopRef.current;
    if(lr.active&&lr.start!==null){s.loop=true;s.loopStart=lr.start*buf.duration;s.loopEnd=(lr.end??1)*buf.duration;}
    s.start(0,o);
    s.onended=()=>{if(!loopRef.current.active){setPlay(false);setProg(0);off.current=0;onChange?.("playing",false);}};
    src.current=s; st.current=(acNowRef?.current ?? ac.currentTime); off.current=o;
    const tick=()=>{
      // Shared frame-snapshot: read parent-RAF-published time so both decks
      // measure elapsed from an identical instant per frame. Eliminates the
      // sub-ms read offset between A and B that caused visual grid oscillation
      // post-rate-aware fix. Fallback to ac.currentTime if snapshot is null
      // (initial mount before parent RAF has populated it).
      const nowAc=acNowRef?.current ?? ac.currentTime;
      const elapsed=nowAc-st.current;
      // Rate-aware: Web Audio rate-adjusts sample consumption internally;
      // we must mirror that here or visual diverges from audio at rate≠1.
      // Rate changes mid-playback rebase off.current/st.current in the
      // [rate] useEffect so this multiplication only applies to the
      // current rate segment.
      const elapsedBuf=elapsed*rateRef.current;
      const lr2=loopRef.current;
      let p;
      if(lr2.active&&lr2.start!==null&&lr2.end!==null){
        const lDur=(lr2.end-lr2.start)*buf.duration;
        const pos=(o-lr2.start*buf.duration+elapsedBuf);
        p=lr2.start+(pos%lDur)/buf.duration;
      } else {
        p=Math.min(1,(o+elapsedBuf)/buf.duration);
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
    console.log('[PLAY-STATE] deck',id,'toggle() called, fromRemote='+fromRemote+' currentPlay='+play+' isDriver='+isDriver+' hasBuf='+!!buf);
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
      // User has now interacted with this track — auto-position should
      // not override their action even if BPM analysis is still pending.
      userMovedRef.current=true;
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
    // User interacted — block auto-position-to-first-downbeat on this track.
    userMovedRef.current=true;
    // Local-only hook for sync re-align (see handleTransportFire). seek_local
    // never goes on the wire — handleTransportFire suppresses broadcast for
    // this type and uses it solely to trigger the scrub-resync scheduler.
    // Without this, driver-path seeks (drag-release, small-WF click, beat
    // arrows) bypassed handleScrubResync entirely and the slave drifted out
    // of sync after any user-initiated seek while syncLocked.
    onTransportFire?.({ type:"seek_local", deckId:id, value:pc, fromRemote });
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
    // CUE is an explicit user action (jump to track start) — block any
    // pending auto-position-to-first-downbeat from overriding.
    userMovedRef.current=true;
    // Same local-only hook as seek — CUE while synced should re-align too.
    onTransportFire?.({ type:"seek_local", deckId:id, value:0, fromRemote });
  },[play,id,onTransportFire,isDriver]);

  // ── nudgeRate(offsetSec, rampDurMs=200) — smooth-seek primitive for small
  // sync-time corrections. Briefly modulates playbackRate in a triangle (up
  // to peakRate at T/2, back to rate at T) so the source plays exactly
  // offsetSec more (or less) audio over rampDurSec wall clock. NO destroy/
  // recreate of the source = no click.
  //
  // Math: ∫ rate(t) dt over [0,T] with triangle = T/2 × (rate + peakRate).
  // Extra over constant-rate baseline = T/2 × (peakRate − rate).
  // For extra == offsetSec: peakRate − rate = 2 × offsetSec / T.
  //
  // Rate excursion capped at ±15% to prevent audible pitch artifacts; if a
  // requested nudge would exceed the cap, the ramp duration extends.
  //
  // off.current bookkeeping fires at ramp end (setTimeout) so the
  // pause/resume offset reflects the audio shift. Pre-existing limitation:
  // tick() is rate-unaware so the visual playhead lags actual audio by up
  // to offsetSec DURING the ramp, then jumps to correct value at end.
  // For sync-time use, offsetSec ≤ 30 ms typical → visual jump is ≤3 px.
  const nudgeRate = useCallback((offsetSec, rampDurMs=200) => {
    // Read volatile state through refs — useCallback closure is stable
    // across play/rate/isDriver changes, so deps include only [id, ac].
    const isDriverNow = isDriverRef.current;
    const playNow = playRef.current;
    const rateNow = rateRef.current;
    console.log('[NUDGE-CHECK] deck', id, {
      playRefCurrent: playRef.current,
      isDriverRefCurrent: isDriverRef.current,
      rateRefCurrent: rateRef.current,
      hasSrc: !!src.current,
      hasAc: !!ac,
      hasBuf: !!bufRef.current,
      offCurrent: off.current,
    });
    if (!isDriverNow || !playNow || !src.current || !ac) {
      console.log('[NUDGE-DEBUG] deck', id, 'skip', { isDriver: isDriverNow, play: playNow, hasSrc: !!src.current });
      return;
    }
    // Clamp magnitude to ±50ms.
    let offSec = offsetSec;
    if (offSec > 0.05) offSec = 0.05;
    if (offSec < -0.05) offSec = -0.05;
    let rampDurSec = rampDurMs / 1000;
    let deltaRate = 2 * offSec / rampDurSec;
    const RATE_CAP = 0.15 * rateNow;
    if (Math.abs(deltaRate) > RATE_CAP) {
      // Extend duration to keep rate change within cap.
      rampDurSec = 2 * Math.abs(offSec) / RATE_CAP;
      rampDurMs = rampDurSec * 1000;
      deltaRate = offSec > 0 ? RATE_CAP : -RATE_CAP;
    }
    const peakRate = rateNow + deltaRate;
    const now = ac.currentTime;
    // Cancel any pending ramp from a prior nudge — both the scheduled rate
    // changes on the source AND the off.current bookkeeping timeout.
    if (nudgeT.current) { clearTimeout(nudgeT.current); nudgeT.current = null; }
    try {
      src.current.playbackRate.cancelScheduledValues(now);
      src.current.playbackRate.setValueAtTime(rateNow, now);
      src.current.playbackRate.linearRampToValueAtTime(peakRate, now + rampDurSec / 2);
      src.current.playbackRate.linearRampToValueAtTime(rateNow, now + rampDurSec);
    } catch (e) {
      console.warn('[NUDGE] rate ramp scheduling failed:', e);
      return;
    }
    // Schedule the bookkeeping update for ramp end. Skip if the source
    // got recreated by a seek/load in the meantime (generation check).
    const stampedSrc = src.current;
    nudgeSrcRef.current = stampedSrc;
    nudgeT.current = setTimeout(() => {
      if (src.current === stampedSrc) {
        off.current += offSec;
      }
      nudgeT.current = null;
    }, rampDurMs + 5);
    console.log('[NUDGE-DEBUG] deck', id, ':', 'offsetMs=' + (offSec * 1000).toFixed(2),
      'rampMs=' + rampDurMs.toFixed(0), 'rate=' + rateNow.toFixed(3),
      'peakRate=' + peakRate.toFixed(3), 'deltaPct=' + ((deltaRate / rateNow) * 100).toFixed(2));
  }, [id, ac]);
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
  useEffect(()=>{onNudgeReady?.(nudgeRate);},[nudgeRate,onNudgeReady]);
  // Path C: register THE REF (not the buffer) with the parent — so the
  // cross-correlation block in syncDecks pulls the current buffer at call
  // time regardless of subsequent loads. bufRef is the already-existing
  // mirror updated via useEffect on [buf].
  useEffect(()=>{onBufferReady?.(bufRef);},[onBufferReady]);

  // First-downbeat auto-position. When BPM analysis completes for a freshly-
  // loaded track and the user hasn't touched the deck yet, snap the playhead
  // from the file's t=0 to the analyzed first bar-1 downbeat — so loaded
  // tracks land on a beat ready to play, matching Rekordbox/Serato/Traktor.
  //
  // Uses firstBar1AnchorSec directly from the worker (unwrapped seconds
  // since track start, range [0, 4 × beatPeriodSec)). The earlier
  // bpf × bps derivation gave the same numeric result mathematically, but
  // the new field is explicit + avoids confusion about whether
  // beatPhaseFrac is unwrapped-beat-index or a [0,1) fraction.
  useEffect(() => {
    if (!buf || !isDriver) return;                       // partner-driven: remote controls
    if (positionedBufRef.current === buf) return;        // already positioned for this buf
    if (bpmResult?.analyzing === true) return;           // wait for fresh analysis
    const anchor = bpmResult?.firstBar1AnchorSec;
    if (anchor == null) return;                          // analysis hasn't produced anchor
    // Mark as handled upfront — covers retries (re-analysis updates) and
    // the user-already-moved / playing bail paths below.
    positionedBufRef.current = buf;
    if (userMovedRef.current) return;                    // user played/seeked/cued already
    if (play) return;                                    // safety: never seek mid-playback
    // Apply manual bar-1 override (whole-beat shift saved per-track in LS).
    // Restores corrected anchor on reload of previously-shifted tracks.
    const adjustedAnchor = anchor + (barOneOffsetSec || 0);
    if (adjustedAnchor < 0 || adjustedAnchor >= buf.duration) return;
    const newProg = adjustedAnchor / buf.duration;
    off.current     = adjustedAnchor;
    progRef.current = newProg;
    setProg(newProg);
    onProgUpdate?.(newProg);
    console.log('[DECK]', id, 'auto-positioned to first downbeat at',
      adjustedAnchor.toFixed(3), 's (anchor=', anchor.toFixed(3),
      '+ barOffset=', (barOneOffsetSec||0).toFixed(3), ', prog=', newProg.toFixed(4), ')');
  }, [buf, bpmResult?.firstBar1AnchorSec, bpmResult?.analyzing, isDriver, play, id, onProgUpdate, barOneOffsetSec]);
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
  // Pulse trigger — bump counter on play activation so the keyed wrapper
  // remounts and the one-shot @keyframes playPulse replays. Single pulse on
  // press, never continuous (would be visual noise during a long set).
  const prevPlayVisualRef=useRef(playVisual);
  const [pulseId,setPulseId]=useState(0);
  useEffect(()=>{
    if(playVisual&&!prevPlayVisualRef.current)setPulseId(p=>p+1);
    prevPlayVisualRef.current=playVisual;
  },[playVisual]);

  // Load a file, optionally with library track metadata
  const load=async(f, trackMeta=null)=>{
    const ab=await f.arrayBuffer();
    const d=await ac.decodeAudioData(ab);
    stop_();setPlay(false);setProg(0);off.current=0;
    // Reset position-bookkeeping refs too. Without this, the visual playhead
    // shows the prior track's last position until tick() runs again, and the
    // parent's progRefA/B remains stale (broadcast to partner, fed into sync
    // engine). Rebase st.current so any tick frame that fires between here
    // and the next play_() computes elapsed=0 (no spurious advancement).
    progRef.current=0;onProgUpdate?.(0);
    if(ac)st.current=(acNowRef?.current ?? ac.currentTime);
    // Fresh track = clean slate for auto-position. positionedBufRef is left
    // alone; it'll naturally fail its identity check against the new buf.
    userMovedRef.current=false;
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
    // Per-band normalization. Each band scales to its own track-wide max.
    // Joint normalization (Phase 2 v2) was only needed for the spectral
    // color formula, which has been reverted in favor of calm monochrome
    // amplitude rendering — see PHASE_2_STATUS.md for the spectral attempt's
    // history. Per-band norm keeps the envelope flat and the silhouette
    // smooth across the full track.
    const normBand=(arr)=>{let mx=0;for(let i=0;i<arr.length;i++)mx=Math.max(mx,arr[i]);if(mx<0.0001)return new Array(arr.length).fill(0);const out=new Array(arr.length);for(let i=0;i<arr.length;i++)out[i]=Math.round(arr[i]/mx*1000)/1000;return out;};
    const bN=normBand(bassArr),mN=normBand(midArr),hN=normBand(highArr);
    console.log('[WF-BANDS] band extract active for deck', id, '(WF_W=', WF_W, ')');
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

  // Expose rate setter for beat sync (called from parent). Use a short
  // linearRamp instead of setTargetAtTime: the latter is asymptotic and
  // NEVER REACHES the target value, leaving a permanent ~10⁻⁵ offset that
  // accumulated as ~30ms drift per 5 min of synced playback. linearRamp
  // hits the exact target value at end of ramp; 5ms ramp duration is
  // inaudible but eliminates the rate-change click.
  useEffect(()=>{
    // Rebase visual position bookkeeping on rate transitions. tick() reads
    // rate via rateRef and multiplies into (elapsed); without rebasing here,
    // a rate change mid-playback would retroactively re-rate the pre-change
    // wall-time segment, snapping the visual playhead forward or back at the
    // moment of rate change.
    //
    // Snapshot the buffer-position advanced under the OLD rate into
    // off.current, then reset st.current so subsequent elapsed measures
    // wall-time under the NEW rate only. Both writes share a single acNow
    // snapshot so the rebase is internally consistent (reading ac.currentTime
    // twice in succession returns slightly different values). Skip when no
    // source is active (paused) — but still update prevRateRef so the next
    // rebase (after resume + another rate change) uses the correct prev rate.
    if(src.current&&ac){
      const acNow=acNowRef?.current ?? ac.currentTime;
      off.current+=(acNow-st.current)*prevRateRef.current;
      st.current=acNow;
    }
    prevRateRef.current=rate;
    if(!src.current?.playbackRate) return;
    const pr=src.current.playbackRate;
    const now=ac?.currentTime||0;
    pr.cancelScheduledValues(now);
    pr.setValueAtTime(pr.value,now);
    pr.linearRampToValueAtTime(rate,now+0.005);
  },[rate,ac]);

  const fmt=(s)=>`${String(Math.floor(Math.max(0,s)/60)).padStart(2,"0")}:${String(Math.floor(Math.max(0,s)%60)).padStart(2,"0")}`;
  const cur=prog*dur;

  const D="#15171A", BD="1px solid rgba(255,255,255,0.06)";
  return (
    <div style={{background:D, border:`1px solid ${play?color+"44":"rgba(255,255,255,0.06)"}`, borderRadius:10, overflow:"hidden", display:"flex", flexDirection:"column", boxShadow:play?`0 0 24px ${color}14`:`0 2px 12px rgba(0,0,0,.5)`, transition:"all .3s"}}>

      {/* ── HEADER: 3-part identity row + title/metadata + BPM display ── */}
      <div style={{padding:"6px 12px 8px", borderBottom:BD, display:"flex", flexDirection:"column", gap:4}}
        onDragOver={e=>{e.preventDefault();e.stopPropagation();setDragOver(true);}}
        onDragLeave={()=>setDragOver(false)}
        onDrop={e=>{e.preventDefault();e.stopPropagation();setDragOver(false);const f=e.dataTransfer.files[0];if(f&&f.type.startsWith("audio/")){load(f);return;}try{const d=JSON.parse(e.dataTransfer.getData("application/json"));if(d?.trackId&&onLibraryTrackDrop)onLibraryTrackDrop(d.trackId);}catch{}}}>
        {/* 3-part identity row: deck letter · you/partner · play indicator */}
        <div style={{display:"flex", alignItems:"center", gap:6, fontSize:10, fontFamily:"'Inter',sans-serif", letterSpacing:0}}>
          <span style={{color, fontWeight:600, letterSpacing:.5}}>{id}</span>
          <span style={{color:"#5A5E66"}}>·</span>
          <span style={{color:"#9CA3AF", fontWeight:500}}>{isDriver?"you":"partner"}</span>
          {play&&<span style={{width:5,height:5,borderRadius:"50%",background:color,boxShadow:`0 0 6px ${color}`,marginLeft:4}}/>}
          {bpmResult?.analyzing&&<span style={{fontSize:8, color:"#f59e0b", marginLeft:"auto", letterSpacing:.5}}>analyzing…</span>}
        </div>
        {/* Title + metadata + key + BPM row */}
        <div onClick={()=>{if(!(buf||remote?.trackName))fr.current?.click();}}
          style={{display:"flex", alignItems:"flex-end", gap:14, background:dragOver?color+"08":"transparent", borderRadius:6, transition:"background .12s", cursor:(buf||remote?.trackName)?"default":"pointer", minWidth:0}}>
          <div style={{flex:1, minWidth:0}}>
            {(buf||remote?.trackName)?(
              <>
                {/* Title + inline time (Rekordbox-style). Time sits to the
                    right of the title on the same row; both ellipsis-safe. */}
                <div style={{display:"flex", alignItems:"baseline", gap:10}}>
                  <div style={{flex:1, minWidth:0, fontSize:20, fontWeight:600, color:"#F5F5F7", fontFamily:"'Inter',sans-serif", letterSpacing:-0.3, lineHeight:1.15, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>
                    {name||remote?.trackName||"—"}
                  </div>
                  {(()=>{
                    const totalDur = buf?dur:(remote?.duration||0);
                    if(!(totalDur>0)) return null;
                    return (
                      <div style={{flexShrink:0, fontSize:13, color:"#9CA3AF", fontFamily:"'Inter',sans-serif", fontVariantNumeric:"tabular-nums", letterSpacing:0.3, lineHeight:1}}>
                        {fmt(cur)}<span style={{color:"#5A5E66", margin:"0 4px"}}>/</span>-{fmt(Math.max(0,totalDur-cur))}
                      </div>
                    );
                  })()}
                </div>
                {/* Metadata: artist only — duration / sample rate / channels
                    stripped per design v5 (too much data, low signal). */}
                {(trackArtist || (!buf && remote?.artist)) && (
                  <div style={{fontSize:11, color:"#9CA3AF", fontFamily:"'Inter',sans-serif", marginTop:3, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>
                    {trackArtist || remote?.artist}
                  </div>
                )}
              </>
            ):(
              <div style={{padding:"4px 0", color:dragOver?color:color+"99", fontFamily:"'Inter',sans-serif", fontSize:13, fontWeight:500, letterSpacing:.3}}>
                {dragOver?"Drop track here":"Click or drag to load track"}
              </div>
            )}
          </div>
          {/* KEY display (compact, optional) */}
          {(()=>{const effectiveKey=deckKey||remote?.key;const ck=effectiveKey?CAMELOT[effectiveKey]:null;const km=ck?.endsWith("A");return ck?(
            <div style={{flexShrink:0, alignSelf:"center"}}>
              <div style={{fontSize:11, fontFamily:"'Inter',sans-serif", fontWeight:500, color:"#F5F5F7", background:"rgba(255,255,255,0.06)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:4, padding:"2px 6px", letterSpacing:.5, fontVariantNumeric:"tabular-nums"}}>{ck}</div>
            </div>
          ):null;})()}
          {/* BPM display — LCD-style oak, tabular-nums, bold */}
          <div style={{flexShrink:0, textAlign:"right", alignSelf:"flex-end"}}>
            {(()=>{
              const effectiveBpm = bpmResult?.bpm ?? remote?.bpm;
              const rateApplies  = !!bpmResult?.bpm;
              const adjustedBpm  = effectiveBpm ? effectiveBpm * (rateApplies ? rate : 1) : null;
              const pctOff       = rateApplies && Math.abs(rate - 1) > 0.001 ? (rate - 1) * 100 : null;
              const pctColor     = pctOff === null ? null
                : Math.abs(pctOff) > 10 ? "#ef4444"
                : Math.abs(pctOff) > 6  ? "#f59e0b"
                : "#9CA3AF";
              return (
                <div style={{display:"flex", alignItems:"baseline", gap:5, justifyContent:"flex-end"}}>
                  <div title={effectiveBpm?`Natural BPM ${effectiveBpm.toFixed(1)}${pctOff!==null?` · pitch ${pctOff>0?"+":""}${pctOff.toFixed(1)}%`:""}`:undefined} style={{fontSize:28, fontFamily:"'Inter',sans-serif", fontWeight:600, color:effectiveBpm?"#F5F5F7":"#2a2a2a", lineHeight:0.95, letterSpacing:-0.5, fontVariantNumeric:"tabular-nums"}}>{adjustedBpm!=null?adjustedBpm.toFixed(1):"—"}</div>
                  {pctOff !== null && (
                    <div title={`Track natural BPM ${effectiveBpm.toFixed(1)} pitch-adjusted ${pctOff>0?"+":""}${pctOff.toFixed(1)}%`} style={{fontSize:9, fontFamily:"'Inter',sans-serif", color:pctColor, fontVariantNumeric:"tabular-nums"}}>
                      {pctOff>0?"+":""}{pctOff.toFixed(1)}%
                    </div>
                  )}
                </div>
              );
            })()}
            <div style={{fontSize:7, color:"#9CA3AF", fontFamily:"'Inter',sans-serif", letterSpacing:2, marginTop:2}}>BPM</div>
          </div>
        </div>
        <input ref={fr} type="file" accept="audio/*" style={{display:"none"}} onChange={e=>{ const f=e.target.files[0]; e.target.value=""; if(f) load(f); }}/>
      </div>

      {/* ── OVERVIEW STRIP — full track structure ── */}
      <div style={{borderTop:BD, borderBottom:BD, background:"#06070A"}}>
        <WF bands={wfBass?{bass:wfBass,mid:wfMid,high:wfHigh}:null} peaks={wfPeaks} freq={wfFreq} prog={prog} onSeek={local?seek:remoteSeek} h={40} hotCues={hotCues} loopStart={loopStart} loopEnd={loopEnd} loopActive={loopActive} bpm={bpmResult?.bpm?(bpmResult.bpm*rate):null} dur={dur} beatPhaseFrac={bpmResult?.beatPhaseFrac??null} color={color}/>
      </div>

      {/* ── A–D CUE CHIPS (inline) + COMPACT LOOP ROW ──
           Per design brief: 4 cue chips below transport, NOT a side column.
           Each chip: small color dot · cue letter · timestamp (or em-dash).
           Click to recall (or set if unset). Right-click to clear. */}
      <div style={{display:"flex",gap:5,padding:"6px 12px",background:"rgba(255,255,255,0.02)",borderBottom:BD,alignItems:"center"}}>
          {HOT_CUE_COLORS.slice(0,4).map((c,i)=>{
            const isSet = hotCues[i] != null;
            const letter = String.fromCharCode(65+i); // A B C D
            const ts = isSet ? fmt(hotCues[i] * dur) : "—";
            return (
              <button key={i}
                onClick={()=>{if(!buf)return;if(hotCues[i]!==null){seek(hotCues[i]);}else{setHotCues(p=>{const n=[...p];n[i]=prog;return n;});}}}
                onContextMenu={e=>{e.preventDefault();if(buf)setHotCues(p=>{const n=[...p];n[i]=null;return n;});}}
                title={isSet?"Click to recall · Right-click to clear":"Click to set cue at playhead"}
                style={{flex:1, height:26, padding:"0 8px",
                  display:"flex", alignItems:"center", gap:6,
                  background:isSet?`${c}14`:"transparent",
                  border:`1px solid ${isSet?c+"55":"rgba(255,255,255,0.06)"}`,
                  borderRadius:5,
                  cursor:buf?"pointer":"default",
                  fontFamily:"'Inter',sans-serif",
                  flexShrink:0, minWidth:0, outline:"none",
                  transition:"all 150ms cubic-bezier(0.4, 0, 0.2, 1)",
                }}>
                <span style={{width:5, height:5, borderRadius:"50%", background:c, opacity:isSet?1:0.35, flexShrink:0}}/>
                <span style={{fontSize:11, fontWeight:600, color:isSet?"#F5F5F7":"#9CA3AF", letterSpacing:.3, flexShrink:0}}>{letter}</span>
                <span style={{fontSize:10, color:isSet?"#9CA3AF":"#5A5E66", marginLeft:"auto", fontVariantNumeric:"tabular-nums", whiteSpace:"nowrap"}}>{ts}</span>
              </button>
            );
          })}
          <div style={{width:1,height:18,background:"rgba(255,255,255,0.06)",margin:"0 4px",flexShrink:0}}/>
          {/* Beat-loop quick buttons — set + activate a loop of N beats at the playhead. */}
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
              title={`Set ${beats}-beat loop at playhead`}
              style={{height:24, width:24, background:"transparent", border:"1px solid rgba(255,255,255,0.06)", color:"#9CA3AF", borderRadius:4, cursor:"pointer", fontFamily:"'Inter',sans-serif", fontSize:10, fontWeight:500, flexShrink:0, outline:"none", padding:0, display:"flex", alignItems:"center", justifyContent:"center"}}>
              {label}
            </button>
          ))}
          {loopStart!==null&&(
            <button onClick={()=>{const nv=!loopActive;setLoopActive(nv);if(!nv&&src.current)src.current.loop=false;}}
              style={{height:24, padding:"0 8px", background:loopActive?"#9CA3AF18":"transparent", border:`1px solid ${loopActive?"#9CA3AF66":"rgba(255,255,255,0.06)"}`, color:loopActive?"#9CA3AF":"#9CA3AF", borderRadius:4, cursor:"pointer", fontFamily:"'Inter',sans-serif", fontSize:9, fontWeight:500, flexShrink:0, outline:"none"}}>
              {loopActive?"⟳ Loop":"Loop"}
            </button>
          )}
          {loopStart!==null&&(
            <button onClick={()=>{setLoopActive(false);setLoopStart(null);setLoopEnd(null);if(src.current)src.current.loop=false;}}
              title="Clear loop"
              style={{height:24, width:24, background:"transparent", border:"1px solid rgba(239,68,68,0.20)", color:"#ef444488", borderRadius:4, cursor:"pointer", fontSize:10, flexShrink:0, outline:"none", padding:0, display:"flex", alignItems:"center", justifyContent:"center"}}>
              ✕
            </button>
          )}
      </div>

      {/* ── TRANSPORT — Set-Beat-1 · Cue · Skip · Play · Skip · Sync · M.
           Elapsed/Remain moved inline with the track title (v5) so this row
           is now just transport actions, centered. ── */}
      <div style={{display:"flex", alignItems:"center", gap:8, padding:"8px 12px", borderBottom:BD, justifyContent:"center"}}>
        {/* Set-Beat-1 marker — Rekordbox-style two-tone vertical bar (red top
            half / white bottom half). Visual language pros recognise as "a
            beat marker on the timeline". Click writes the current playhead
            position to gridAnchorSec via onGridEdit; downstream merge in
            effectiveBpmResults moves the beat grid immediately. Disabled
            (opacity .3) when no track is loaded. */}
        {(()=>{
          const canEdit = !!buf && !!onGridEdit;
          return (
            <button
              onClick={() => {
                if (!canEdit) return;
                if (!(dur > 0)) return;
                const playhead = (progRef.current ?? prog ?? 0) * dur;
                const clamped = Math.max(0, Math.min(dur, playhead));
                const result = snapToTransient(buf, clamped);
                console.log('[GRID-SNAP]', {
                  deck: id,
                  path: result.snapped ? "snapped" : "raw",
                  raw: clamped.toFixed(4),
                  position: result.position.toFixed(4),
                  delta_ms: Math.round((result.position - clamped) * 1000),
                  peakAbs: result.peakAbs?.toFixed(4),
                  meanAbs: result.meanAbs?.toFixed(4),
                  ratio: result.ratio?.toFixed(2),
                  reason: result.reason,
                });
                onGridEdit({ gridAnchorSec: result.position });
              }}
              disabled={!canEdit}
              title={canEdit ? "Set beat 1 at playhead" : "Load a track to edit the grid"}
              style={{
                width: 4, height: 18, padding: 0,
                background: "transparent", border: "none", outline: "none",
                cursor: canEdit ? "pointer" : "default",
                opacity: canEdit ? 1 : 0.3,
                display: "flex", flexDirection: "column",
                flexShrink: 0, alignSelf: "center",
                transition: "opacity 150ms cubic-bezier(0.4, 0, 0.2, 1), filter 150ms cubic-bezier(0.4, 0, 0.2, 1)",
              }}
              onMouseEnter={(e) => {
                if (!canEdit) return;
                e.currentTarget.style.filter = "drop-shadow(0 0 4px rgba(255,59,48,0.7))";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.filter = "none";
              }}>
              {/* White accent on top (~3 of 18 px), solid red below. The
                  inner divs carry explicit cursor:inherit so the parent
                  button's cursor:pointer applies no matter where in the
                  4 × 18 area the cursor lands — needed because the icon is
                  narrow and div elements don't always inherit cursor
                  visibly under some Chrome render paths. */}
              <div style={{ flex: 1, background: "rgba(255,255,255,0.9)", cursor: "inherit" }}/>
              <div style={{ flex: 5.5, background: "#FF3B30", cursor: "inherit" }}/>
            </button>
          );
        })()}
        {/* CUE pill */}
        <button onClick={(e)=>{ if(local&&cue) cue(); else if(remoteCue) remoteCue(); }} disabled={!cueEnabled}
          style={{height:38, padding:"0 16px", minWidth:60,
            background:"transparent",
            border:`1px solid ${cueEnabled?"rgba(255,255,255,0.20)":"rgba(255,255,255,0.06)"}`,
            color:cueEnabled?"#F5F5F7":"#5A5E66",
            borderRadius:6,
            fontFamily:"'Inter',sans-serif", fontSize:12, fontWeight:500, letterSpacing:.3,
            cursor:cueEnabled?"pointer":"default", outline:"none", flexShrink:0,
            transition:"all 150ms cubic-bezier(0.4, 0, 0.2, 1)",
          }}>Cue</button>
        {/* Skip back 1 beat */}
        <button onClick={local?()=>{
          const beatPeriod=bpmResult?.beatPeriodSec;
          const beatPhase=bpmResult?.beatPhaseSec??0;
          const isLocked=syncRole!==null;
          if(isLocked&&beatPeriod&&dur){
            const currentTime=prog*dur;
            const currentBeatPos=(currentTime-beatPhase)/beatPeriod;
            const targetBeatNum=Math.floor(currentBeatPos-0.001);
            const newTime=beatPhase+targetBeatNum*beatPeriod;
            seek(Math.max(0,Math.min(1,newTime/dur)));
          } else {
            const step=(beatPeriod&&dur)?(beatPeriod/dur):0.005;
            seek(Math.max(0,prog-step));
          }
        }:undefined} disabled={!local} title={syncRole!==null?"Snap to previous beat":"Skip back 1 beat"}
          style={{height:38, width:32, background:"transparent", border:"1px solid rgba(255,255,255,0.12)", color:local?"#9CA3AF":"#5A5E66", borderRadius:6, cursor:local?"pointer":"default", fontFamily:"'Inter',sans-serif", fontSize:13, outline:"none", flexShrink:0, padding:0, display:"flex", alignItems:"center", justifyContent:"center"}}>◂</button>
        {/* WHITE PLAY — 52px circle, visual anchor.
            Pulse: keyed wrapper remounts on pulseId change → @keyframes
            playPulse fires once (subtle scale 1 → 1.05 → 1, 200ms). */}
        <div key={pulseId} style={{
          position:"relative", width:52, height:52, flexShrink:0,
          animation: pulseId>0 ? "playPulse 200ms cubic-bezier(0.4, 0, 0.2, 1) 1" : undefined,
        }}>
          {/* Radial halo — same trigger, expands outward and fades. White at
              0.9 reads against the dark background. */}
          {pulseId>0 && (
            <div style={{
              position:"absolute", inset:0, borderRadius:"50%",
              border:"1.5px solid rgba(255,255,255,0.9)",
              pointerEvents:"none",
              animation:"playPulseHalo 200ms cubic-bezier(0.4, 0, 0.2, 1) 1 forwards",
            }}/>
          )}
          <button onClick={(e)=>{ if(local&&toggle) toggle(); else if(remoteToggle) remoteToggle(); }} disabled={!enabled}
            style={{width:52, height:52, borderRadius:"50%",
              background:playVisual?"rgba(255,255,255,0.9)":"transparent",
              border:`1.5px solid ${playVisual?"rgba(255,255,255,0.9)":(enabled?"rgba(255,255,255,0.30)":"rgba(255,255,255,0.10)")}`,
              color:playVisual?"#0A0B0E":(enabled?"#F5F5F7":"#5A5E66"),
              cursor:enabled?"pointer":"default",
              fontSize:18, fontWeight:500,
              display:"flex", alignItems:"center", justifyContent:"center",
              boxShadow:playVisual?"0 0 24px rgba(255,255,255,0.30), 0 0 60px rgba(255,255,255,0.12)":"none",
              outline:"none",
              transition:"background-color 150ms cubic-bezier(0.4, 0, 0.2, 1), border-color 150ms cubic-bezier(0.4, 0, 0.2, 1), color 150ms cubic-bezier(0.4, 0, 0.2, 1), box-shadow 150ms cubic-bezier(0.4, 0, 0.2, 1)",
              padding:0,
            }}>{playVisual?"❚❚":"▶"}</button>
        </div>
        {/* Skip forward 1 beat */}
        <button onClick={local?()=>{
          const beatPeriod=bpmResult?.beatPeriodSec;
          const beatPhase=bpmResult?.beatPhaseSec??0;
          const isLocked=syncRole!==null;
          if(isLocked&&beatPeriod&&dur){
            const currentTime=prog*dur;
            const currentBeatPos=(currentTime-beatPhase)/beatPeriod;
            const targetBeatNum=Math.ceil(currentBeatPos+0.001);
            const newTime=beatPhase+targetBeatNum*beatPeriod;
            seek(Math.max(0,Math.min(1,newTime/dur)));
          } else {
            const step=(beatPeriod&&dur)?(beatPeriod/dur):0.005;
            seek(Math.min(1,prog+step));
          }
        }:undefined} disabled={!local} title={syncRole!==null?"Snap to next beat":"Skip forward 1 beat"}
          style={{height:38, width:32, background:"transparent", border:"1px solid rgba(255,255,255,0.12)", color:local?"#9CA3AF":"#5A5E66", borderRadius:6, cursor:local?"pointer":"default", fontFamily:"'Inter',sans-serif", fontSize:13, outline:"none", flexShrink:0, padding:0, display:"flex", alignItems:"center", justifyContent:"center"}}>▸</button>
        {/* SYNC pill */}
        {onSync&&(()=>{
          const isAnalyzing = !!buf && !bpmResult?.bpm && !!bpmResult?.analyzing;
          const canSync = !!buf && !!bpmResult?.bpm;
          const isSlave  = syncRole === "slave";
          const isMasterRole = syncRole === "master";
          const isLocked = isSlave || isMasterRole;
          const clickable = isLocked || canSync;
          const tone =
            isLocked      ? { bg:"rgba(255,255,255,0.10)", border:"#FFFFFF", color:"#FFFFFF", opacity:1, glow:true }
            : canSync     ? { bg:"transparent", border:"rgba(255,255,255,0.20)", color:"#F5F5F7", opacity:1, glow:false }
            : isAnalyzing ? { bg:"transparent", border:"#f59e0b55", color:"#f59e0b", opacity:1, glow:false }
            :               { bg:"transparent", border:"rgba(255,255,255,0.06)", color:"#5A5E66", opacity:0.6, glow:false };
          const tip = isLocked   ? "Sync engaged — click to release"
            : !buf             ? "Load a track"
            : isAnalyzing      ? "Analyzing BPM…"
            : !bpmResult?.bpm  ? "Waiting for BPM"
            : !syncReady       ? "Load a track on the other deck to enable sync"
            :                    "Engage Sync";
          return (
            <button onClick={clickable ? onSync : undefined} disabled={!clickable} title={tip}
              style={{height:38, padding:"0 16px", minWidth:60,
                background:tone.bg,
                border:`1px solid ${tone.border}`,
                color:tone.color,
                opacity:tone.opacity,
                borderRadius:6,
                fontFamily:"'Inter',sans-serif", fontSize:12, fontWeight:500, letterSpacing:.3,
                cursor:clickable?"pointer":"default", outline:"none", flexShrink:0,
                transition:"all 150ms cubic-bezier(0.4, 0, 0.2, 1)",
                boxShadow:tone.glow?"0 0 12px rgba(255,255,255,0.30)":"none",
                display:"flex", alignItems:"center", gap:6,
              }}>
              {isLocked && <span style={{width:5,height:5,borderRadius:"50%",background:"#FFFFFF",boxShadow:"0 0 6px rgba(255,255,255,0.7)"}}/>}
              Sync
            </button>
          );
        })()}
        {/* M button — master selector */}
        {onMasterToggle&&(
          <button onClick={()=>onMasterToggle(id)} title={isMaster ? "Master deck — click to clear" : "Set this deck as master"}
            style={{height:38, width:32,
              background:isMaster?"rgba(255,255,255,0.10)":"transparent",
              border:`1px solid ${isMaster?"#FFFFFF":"rgba(255,255,255,0.12)"}`,
              color:isMaster?"#FFFFFF":"#9CA3AF",
              borderRadius:6,
              cursor:"pointer", outline:"none", flexShrink:0,
              fontFamily:"'Inter',sans-serif", fontSize:12, fontWeight:600,
              boxShadow:isMaster?"0 0 10px rgba(255,255,255,0.25)":"none",
              transition:"all 150ms cubic-bezier(0.4, 0, 0.2, 1)",
              display:"flex", alignItems:"center", justifyContent:"center",
              padding:0,
            }}>M</button>
        )}
      </div>

      <div style={{display:"none"}} data-set-rate={id} ref={el=>{if(el)el._setRate=setRate;}}/>
    </div>
  );
}
const TB=(c)=>({height:28,padding:"0 8px",background:"#0A0B0E",border:`1px solid ${c}33`,color:c,borderRadius:5,cursor:"pointer",fontFamily:"'Inter',sans-serif",fontSize:9,outline:"none",display:"flex",alignItems:"center",justifyContent:"center"});
const TB2=(c,h=28)=>({height:h,width:h+8,background:"#0A0B0E",border:`1px solid ${c}44`,color:c+"bb",borderRadius:7,cursor:"pointer",fontFamily:"'Inter',sans-serif",fontSize:11,outline:"none",display:"flex",alignItems:"center",justifyContent:"center",transition:"all 150ms cubic-bezier(0.4, 0, 0.2, 1)"});
const sBtn=(c)=>({padding:"5px 9px",fontSize:9,fontFamily:"'Inter',sans-serif",background:c+"0e",border:`1px solid ${c}2a`,color:c,borderRadius:6,cursor:"pointer",letterSpacing:.5,display:"flex",alignItems:"center",justifyContent:"center",gap:4});

// ── VerticalFader Component ──────────────────────────────────
function VerticalFader({ val, set, color="#9CA3AF", h=130 }) {
  const pct = Math.min(1, Math.max(0, val / 1.5));
  const trackH = h - 8;
  const capTop = 4 + (1 - pct) * (trackH - 22);
  return (
    <div style={{position:"relative", width:38, height:h, margin:"0 auto", flexShrink:0}}>
      {/* Track groove */}
      <div style={{position:"absolute", left:"50%", top:4, height:trackH, transform:"translateX(-50%)", width:7, background:"#040408", border:"1px solid rgba(255,255,255,0.06)", borderRadius:4, boxShadow:"inset 0 1px 4px rgba(0,0,0,.7)"}}>
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
        background:"linear-gradient(180deg,#303040,rgba(255,255,255,0.06))",
        border:"1px solid #3c3c50", borderRadius:5,
        boxShadow:"0 3px 10px rgba(0,0,0,.7), inset 0 1px 0 rgba(255,255,255,.08)",
        pointerEvents:"none", display:"flex", alignItems:"center", justifyContent:"center", gap:3
      }}>
        <div style={{width:1, height:13, background:"#232529", borderRadius:1}}/>
        <div style={{width:12, height:2, background:`${color}77`, borderRadius:1}}/>
        <div style={{width:1, height:13, background:"#232529", borderRadius:1}}/>
      </div>
    </div>
  );
}

// ── Sidebar Panels ────────────────────────────────────────────
function RTCPanel({ rtc, partner, syncOk }) {
  const ST={idle:{c:"#5A5E66",l:"OFFLINE"},offering:{c:"#f59e0b",l:"OFFERING"},answering:{c:"#f59e0b",l:"ANSWERING"},connecting:{c:"#f59e0b",l:"CONNECTING"},connected:{c:"#22c55e",l:"● STREAMING"},failed:{c:"#ef4444",l:"FAILED"}};
  const s=ST[rtc.state]||ST.idle,live=rtc.state==="connected",busy=["offering","answering","connecting"].includes(rtc.state),canCall=syncOk&&partner&&!live&&!busy;
  return (
    <div style={{padding:10,display:"flex",flexDirection:"column",gap:8}}>
      <div style={{display:"flex",justifyContent:"space-between"}}><span style={{fontSize:8,fontFamily:"'Inter',sans-serif",color:"#9CA3AF",letterSpacing:1}}>P2P AUDIO</span><span style={{fontSize:7,fontFamily:"'Inter',sans-serif",color:s.c}}>{s.l}</span></div>
      {live&&<div style={{display:"flex",gap:2,height:16,alignItems:"center",justifyContent:"center"}}>{Array.from({length:12}).map((_,i)=><div key={i} style={{width:3,borderRadius:2,background:"#22c55e",height:"100%",animation:`wave ${.4+(i%4)*.1}s ease-in-out ${i*.06}s infinite`,transformOrigin:"bottom"}}/>)}</div>}
      <div style={{fontSize:7,fontFamily:"'Inter',sans-serif",color:"#9CA3AF",display:"flex",justifyContent:"space-between"}}><span>Partner</span><span style={{color:partner?STATUS_OK:"#5A5E66"}}>{partner||"—"}</span></div>
      <div style={{display:"flex",flexDirection:"column",gap:2}}><div style={{display:"flex",justifyContent:"space-between",fontSize:7,fontFamily:"'Inter',sans-serif",color:"#9CA3AF"}}><span>Partner vol</span><span style={{color:"#22c55e"}}>{Math.round(rtc.remVol*100)}%</span></div><input type="range" min={0} max={1.5} step={.01} value={rtc.remVol} onChange={e=>rtc.setRemVol(Number(e.target.value))} style={{width:"100%",cursor:"pointer",accentColor:"#22c55e"}}/></div>
      <div style={{display:"flex",gap:5}}>
        {canCall&&<button onClick={rtc.startCall} style={{flex:1,...sBtn("#22c55e"),fontWeight:700}}>▶ START STREAM</button>}
        {busy&&<button disabled style={{flex:1,...sBtn("#f59e0b")}}>◌ CONNECTING...</button>}
        {(live||busy)&&<><button onClick={rtc.toggleMute} style={{...sBtn(rtc.muted?"#ef4444":"#9CA3AF"),padding:"5px 8px"}}>{rtc.muted?"🔇":"🎙"}</button><button onClick={rtc.endCall} style={{...sBtn("#ef4444"),padding:"5px 8px"}}>✕</button></>}
      </div>
      {!live&&!busy&&!canCall&&<div style={{fontSize:7,fontFamily:"'Inter',sans-serif",color:"#5A5E66",lineHeight:1.9}}>{!syncOk?"Connect via WebSocket first":!partner?"Waiting for partner to join":"Ready — click Start Stream"}</div>}
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
      {isActive&&<div style={{fontSize:22,fontFamily:"'Inter',sans-serif",fontWeight:700,color:isRec?"#ef4444":"#f59e0b",letterSpacing:2,textAlign:"center"}}>{fmt(rec.dur)}</div>}
      {isActive&&<div style={{height:3,background:"#0A0B0E",borderRadius:2}}><div style={{height:"100%",width:`${rec.level*100}%`,background:rec.level>.8?"#ef4444":rec.level>.6?"#f59e0b":"#22c55e",transition:"width .05s"}}/></div>}
      {!isActive&&<input value={label} onChange={e=>setLabel(e.target.value)} placeholder="Label (optional)" style={{background:"#0A0B0E",border:"1px solid #15171A",color:"#e8e8f0",borderRadius:6,padding:"5px 8px",fontSize:9,fontFamily:"'Inter',sans-serif",outline:"none"}}/>}
      <div style={{display:"flex",gap:5}}>
        {!isActive&&<button onClick={()=>rec.start(label||null)} disabled={!ready} style={{flex:1,padding:"8px",...sBtn("#ef4444"),fontWeight:700,opacity:ready?1:.4}}>● REC</button>}
        {isRec&&<><button onClick={rec.pause} style={{flex:1,padding:"7px",...sBtn("#f59e0b"),fontWeight:700}}>⏸</button><button onClick={rec.stop} style={{flex:1,padding:"7px",...sBtn("#ef4444"),fontWeight:700}}>⏹ STOP</button></>}
        {isPaused&&<><button onClick={rec.resume} style={{flex:1,padding:"7px",...sBtn("#22c55e"),fontWeight:700}}>▶</button><button onClick={rec.stop} style={{flex:1,padding:"7px",...sBtn("#ef4444"),fontWeight:700}}>⏹ STOP</button></>}
      </div>
      {rec.recs.length>0&&(
        <div style={{display:"flex",flexDirection:"column",gap:5,borderTop:"1px solid #15171A",paddingTop:8}}>
          <div style={{fontSize:7,fontFamily:"'Inter',sans-serif",color:"#9CA3AF",letterSpacing:2}}>SAVED ({rec.recs.length})</div>
          {rec.recs.map(r=>(
            <div key={r.id} style={{background:"#0A0B0E",border:"1px solid #15171A",borderRadius:7,padding:"6px 9px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div><div style={{fontSize:9,fontFamily:"'Inter',sans-serif",color:"#F5F5F7"}}>{r.label}</div><div style={{fontSize:7,fontFamily:"'Inter',sans-serif",color:"#5A5E66"}}>{fsz(r.size)} · {r.ext}</div></div>
              <div style={{display:"flex",gap:4}}><button onClick={()=>rec.dl(r)} style={{...sBtn("#9CA3AF"),padding:"2px 7px",fontSize:7}}>↓</button><button onClick={()=>rec.del(r.id)} style={{...sBtn("#ef4444"),padding:"2px 6px",fontSize:7}}>✕</button></div>
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
      <div style={{display:"flex",borderBottom:"1px solid #15171A",flexShrink:0}}>
        {[["dev","DEV"],["map",`MAP(${mc})`]].map(([id,l])=>(
          <button key={id} onClick={()=>setTab(id)} style={{flex:1,padding:"6px 3px",fontSize:7,fontFamily:"'Inter',sans-serif",background:tab===id?"#0d0d20":"transparent",color:tab===id?"#9CA3AF":"#5A5E66",border:"none",borderBottom:`1px solid ${tab===id?"#9CA3AF":"transparent"}`,cursor:"pointer",outline:"none"}}>{l}</button>
        ))}
      </div>
      <div style={{flex:1,overflowY:"auto",padding:7}}>
        {tab==="dev"&&(<div style={{display:"flex",flexDirection:"column",gap:5}}>{!midi.granted?<button onClick={midi.request} style={{...sBtn("#f59e0b"),width:"100%",justifyContent:"center",padding:"7px"}}>Enable MIDI access</button>:<>{midi.devices.length===0&&<div style={{fontSize:7,color:"#5A5E66",fontFamily:"'Inter',sans-serif",textAlign:"center",padding:"10px 0"}}>No MIDI devices found.<br/>Plug in your controller.</div>}{midi.devices.map(d=><div key={d.id} onClick={()=>midi.connect(d.id)} style={{padding:"5px 7px",borderRadius:5,cursor:"pointer",background:midi.active?.id===d.id?"#9CA3AF0d":"#0A0B0E",border:`1px solid ${midi.active?.id===d.id?"#9CA3AF33":"#15171A"}`}}><div style={{fontSize:8,color:"#F5F5F7",fontFamily:"'Inter',sans-serif"}}>{d.name}</div>{midi.active?.id===d.id&&<div style={{fontSize:6,color:"#9CA3AF",fontFamily:"'Inter',sans-serif"}}>● ACTIVE</div>}</div>)}</> }</div>)}
        {tab==="map"&&(<div style={{display:"flex",flexDirection:"column",gap:2}}>{midi.learning&&<div style={{fontSize:7,fontFamily:"'Inter',sans-serif",color:"#9CA3AF",background:"#9CA3AF0a",border:"1px solid #9CA3AF22",borderRadius:4,padding:"4px 7px",marginBottom:3,animation:"pulse .8s infinite"}}>● Move a control on your controller...<button onClick={()=>midi.setLearning(null)} style={{float:"right",background:"none",border:"none",color:"#9CA3AF",cursor:"pointer",fontSize:8}}>✕</button></div>}{ACTS.map(ak=>{const mp=Object.entries(midi.mappings).find(([,v])=>v===ak);const il=midi.learning===ak;return(<div key={ak} style={{display:"flex",gap:3,alignItems:"center",padding:"2px 3px",borderRadius:3,background:il?"#9CA3AF08":"transparent"}}><span style={{flex:1,fontSize:7,fontFamily:"'Inter',sans-serif",color:mp?"#8888aa":"#5A5E66",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{ak.replace(/_/g," ")}</span>{mp&&<span style={{fontSize:5,color:"#9CA3AF44",fontFamily:"'Inter',sans-serif"}}>{mp[0].slice(0,6)}</span>}<button onClick={()=>midi.setLearning(il?null:ak)} style={{padding:"1px 4px",fontSize:5,fontFamily:"'Inter',sans-serif",background:il?"#9CA3AF22":"#0A0B0E",border:`1px solid ${il?"#9CA3AF44":"#15171A"}`,color:il?"#9CA3AF":"#5A5E66",borderRadius:3,cursor:"pointer"}}>{il?"●":"LRN"}</button></div>);})}</div>)}
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
    <div style={{ minHeight:"100vh", background:"#06070A", color:"#e8e8f0", fontFamily:"'Inter', sans-serif", overflowX:"hidden" }}>
      <style>{`
        @keyframes float { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-12px)} }
        @keyframes glow  { 0%,100%{opacity:.4} 50%{opacity:.9} }
        @keyframes slide { from{opacity:0;transform:translateY(24px)} to{opacity:1;transform:translateY(0)} }
        @keyframes spin  { to{transform:rotate(360deg)} }
        .feat-card:hover { border-color: #9CA3AF44 !important; transform: translateY(-3px); box-shadow: 0 8px 30px rgba(0,212,255,.08) !important; }
        .feat-card { transition: all .2s ease !important; }
        .cta-btn:hover { box-shadow: 0 0 40px #9CA3AF55, 0 0 80px #9CA3AF22 !important; transform: scale(1.02); }
        .cta-btn { transition: all .2s ease !important; }
        .nav-link:hover { color: #9CA3AF !important; }
        .nav-link { transition: color .15s !important; }
      `}</style>
      <link href="https://fonts.googleapis.com/css2?family=Barlow:wght@300;400;600;700&family=Barlow+Condensed:wght@600;700;800;900&display=swap" rel="stylesheet"/>

      {/* NAV */}
      <nav style={{ position:"fixed", top:0, left:0, right:0, zIndex:100, padding:"14px 40px", display:"flex", justifyContent:"space-between", alignItems:"center", background:"linear-gradient(180deg,#06070Aee,transparent)", backdropFilter:"blur(8px)" }}>
        <div style={{ fontFamily:"'Inter',sans-serif", fontWeight:900, fontSize:22, letterSpacing:3, background:"linear-gradient(90deg,#9CA3AF,#A855F7)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>MIX//SYNC</div>
        <div style={{ display:"flex", gap:28, alignItems:"center" }}>
          {["Features","How It Works","Get Started"].map(l=>(
            <span key={l} className="nav-link" style={{ fontSize:11, fontFamily:"'Inter',sans-serif", color:"#9CA3AF", letterSpacing:1, cursor:"pointer" }}>{l.toUpperCase()}</span>
          ))}
          <button onClick={onEnter} className="cta-btn" style={{ padding:"8px 20px", background:"linear-gradient(135deg,#9CA3AF,#0099bb)", border:"none", color:"#000", fontFamily:"'Inter',sans-serif", fontWeight:800, fontSize:12, letterSpacing:2, borderRadius:6, cursor:"pointer" }}>
            START A MIX →
          </button>
        </div>
      </nav>

      {/* HERO */}
      <section style={{ minHeight:"100vh", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", textAlign:"center", padding:"100px 40px 60px", position:"relative", overflow:"hidden" }}>

        {/* Background glow orbs */}
        <div style={{ position:"absolute", top:"20%", left:"15%", width:400, height:400, borderRadius:"50%", background:"radial-gradient(circle,#9CA3AF08,transparent 70%)", animation:"glow 4s ease-in-out infinite", pointerEvents:"none" }}/>
        <div style={{ position:"absolute", top:"30%", right:"10%", width:300, height:300, borderRadius:"50%", background:"radial-gradient(circle,#A855F708,transparent 70%)", animation:"glow 5s ease-in-out 1s infinite", pointerEvents:"none" }}/>
        <div style={{ position:"absolute", bottom:"20%", left:"40%", width:500, height:200, borderRadius:"50%", background:"radial-gradient(circle,#a855f706,transparent 70%)", animation:"glow 6s ease-in-out 2s infinite", pointerEvents:"none" }}/>

        {/* Animated grid lines */}
        <div style={{ position:"absolute", inset:0, backgroundImage:"linear-gradient(#ffffff04 1px,transparent 1px),linear-gradient(90deg,#ffffff04 1px,transparent 1px)", backgroundSize:"60px 60px", pointerEvents:"none" }}/>

        <div style={{ animation:"slide .8s ease forwards", maxWidth:760 }}>
          <div style={{ fontSize:10, fontFamily:"'Inter',sans-serif", color:"#9CA3AF", letterSpacing:4, marginBottom:20, display:"flex", alignItems:"center", justifyContent:"center", gap:10 }}>
            <div style={{ width:20, height:1, background:"#9CA3AF" }}/>
            THE FUTURE OF REMOTE DJing
            <div style={{ width:20, height:1, background:"#9CA3AF" }}/>
          </div>

          <h1 style={{ fontFamily:"'Inter',sans-serif", fontWeight:900, fontSize:"clamp(48px,8vw,96px)", lineHeight:.95, letterSpacing:-1, margin:"0 0 24px" }}>
            <span style={{ display:"block", background:"linear-gradient(135deg,#ffffff,#aaaacc)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>MIX TOGETHER.</span>
            <span style={{ display:"block", background:"linear-gradient(135deg,#9CA3AF,#0066ff)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>ANYWHERE.</span>
          </h1>

          <p style={{ fontSize:16, color:"#8888aa", lineHeight:1.7, maxWidth:520, margin:"0 auto 40px", fontWeight:300 }}>
            Two DJs. Real-time audio sync. MIDI controllers. Beat detection. Live audio streaming. All in your browser — no software to install.
          </p>

          <div style={{ display:"flex", gap:12, justifyContent:"center", flexWrap:"wrap" }}>
            <button onClick={onEnter} className="cta-btn" style={{ padding:"16px 40px", background:"linear-gradient(135deg,#9CA3AF,#0077cc)", border:"none", color:"#000", fontFamily:"'Inter',sans-serif", fontWeight:800, fontSize:15, letterSpacing:2, borderRadius:8, cursor:"pointer", boxShadow:"0 0 30px #9CA3AF33" }}>
              START A MIX →
            </button>
            <button style={{ padding:"16px 32px", background:"transparent", border:"1px solid #ffffff22", color:"#888", fontFamily:"'Inter',sans-serif", fontWeight:700, fontSize:14, letterSpacing:2, borderRadius:8, cursor:"pointer" }}>
              WATCH DEMO ▶
            </button>
          </div>

          <div style={{ marginTop:24, fontSize:9, fontFamily:"'Inter',sans-serif", color:"#9CA3AF", letterSpacing:1 }}>
            No account required · Works in Chrome & Edge · Free to use
          </div>
        </div>

        {/* Floating mixer preview */}
        <div style={{ marginTop:60, width:"100%", maxWidth:860, animation:"float 6s ease-in-out infinite", position:"relative" }}>
          <div style={{ background:"linear-gradient(150deg,#0d0d22,#0A0B0E)", border:"1px solid #1a1a30", borderRadius:16, padding:"20px 24px", boxShadow:"0 40px 80px rgba(0,0,0,.6), 0 0 60px rgba(0,212,255,.06)", display:"grid", gridTemplateColumns:"1fr 80px 1fr", gap:16, alignItems:"center" }}>
            {["#9CA3AF","#A855F7"].map((c,i)=>(
              <div key={i} style={{ background:"#06060f", borderRadius:10, padding:12, border:`1px solid ${c}22` }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
                  <span style={{ fontSize:9, fontFamily:"'Inter',sans-serif", color:c, letterSpacing:2 }}>DECK {i===0?"A":"B"}</span>
                  <div style={{ display:"flex", gap:1 }}>{Array.from({length:8}).map((_,j)=><div key={j} style={{ width:4, height:4+Math.random()*12, background:c+(j<5?"cc":"33"), borderRadius:1 }}/>)}</div>
                </div>
                <div style={{ height:28, background:"#06070A", borderRadius:4, marginBottom:8, overflow:"hidden", display:"flex", alignItems:"center" }}>
                  {Array.from({length:60}).map((_,j)=>{ const h=Math.sin(j*.4+(i*.5))*.4+.5; return <div key={j} style={{ flex:1, height:`${h*100}%`, background:j<30?c:c+"44", borderRadius:1 }}/>; })}
                </div>
                <div style={{ display:"flex", gap:4, justifyContent:"center" }}>
                  {["⏮","◂◂","▶","▸▸"].map(btn=><div key={btn} style={{ width:24, height:20, background:"#0A0B0E", border:`1px solid ${c}22`, borderRadius:3, display:"flex", alignItems:"center", justifyContent:"center", fontSize:8, color:btn==="▶"?c:"#5A5E66" }}>{btn}</div>)}
                </div>
              </div>
            ))}
            <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:8 }}>
              <div style={{ fontSize:7, fontFamily:"'Inter',sans-serif", color:"#9CA3AF", letterSpacing:1 }}>XF</div>
              <div style={{ width:"100%", height:4, background:"linear-gradient(90deg,#9CA3AF,#A855F7)", borderRadius:2, position:"relative" }}>
                <div style={{ position:"absolute", left:"calc(50% - 8px)", top:-6, width:16, height:16, background:"#e8e8f0", borderRadius:3, boxShadow:"0 0 8px rgba(255,255,255,.3)" }}/>
              </div>
              <div style={{ fontSize:7, fontFamily:"'Inter',sans-serif", color:"#22c55e" }}>124.0 BPM</div>
            </div>
          </div>
          {/* Reflection */}
          <div style={{ position:"absolute", bottom:-40, left:"10%", right:"10%", height:40, background:"linear-gradient(180deg,rgba(0,212,255,.04),transparent)", borderRadius:"50%", filter:"blur(10px)" }}/>
        </div>
      </section>

      {/* FEATURES */}
      <section style={{ padding:"80px 40px", maxWidth:1100, margin:"0 auto" }}>
        <div style={{ textAlign:"center", marginBottom:56 }}>
          <div style={{ fontSize:9, fontFamily:"'Inter',sans-serif", color:"#9CA3AF", letterSpacing:4, marginBottom:14 }}>WHAT'S INSIDE</div>
          <h2 style={{ fontFamily:"'Inter',sans-serif", fontWeight:900, fontSize:"clamp(32px,5vw,52px)", letterSpacing:-1, margin:0, color:"#e8e8f0" }}>Everything a DJ needs</h2>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))", gap:16 }}>
          {features.map((f,i)=>(
            <div key={i} className="feat-card" style={{ background:"linear-gradient(150deg,#0d0d1e,#0A0B0E)", border:"1px solid #141428", borderRadius:12, padding:"24px 22px" }}>
              <div style={{ fontSize:28, marginBottom:12 }}>{f.icon}</div>
              <div style={{ fontFamily:"'Inter',sans-serif", fontWeight:800, fontSize:17, letterSpacing:1, color:"#e8e8f0", marginBottom:8 }}>{f.title}</div>
              <div style={{ fontSize:11, color:"#9CA3AF", lineHeight:1.7, fontWeight:300 }}>{f.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section style={{ padding:"80px 40px", background:"linear-gradient(180deg,transparent,#0A0B0E00,transparent)" }}>
        <div style={{ maxWidth:800, margin:"0 auto", textAlign:"center" }}>
          <div style={{ fontSize:9, fontFamily:"'Inter',sans-serif", color:"#9CA3AF", letterSpacing:4, marginBottom:14 }}>SIMPLE AS IT GETS</div>
          <h2 style={{ fontFamily:"'Inter',sans-serif", fontWeight:900, fontSize:"clamp(28px,4vw,46px)", letterSpacing:-1, marginBottom:48, color:"#e8e8f0" }}>THREE STEPS TO GO LIVE</h2>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:24 }}>
            {[
              { n:"01", title:"Open the App", desc:"No install. No account. Just click Launch App and you're in." },
              { n:"02", title:"Share Room ID", desc:"Copy your Room ID and send it to your partner. They join the same room." },
              { n:"03", title:"Start Mixing", desc:"Load your tracks, hit play. You're live. Your mix streams to their ears in real time." },
            ].map((s,i)=>(
              <div key={i} style={{ textAlign:"center" }}>
                <div style={{ fontSize:40, fontFamily:"'Inter',sans-serif", fontWeight:900, color:"#9CA3AF11", letterSpacing:-2, marginBottom:12 }}>{s.n}</div>
                <div style={{ fontFamily:"'Inter',sans-serif", fontWeight:800, fontSize:18, color:"#e8e8f0", marginBottom:8 }}>{s.title}</div>
                <div style={{ fontSize:11, color:"#9CA3AF", lineHeight:1.7 }}>{s.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* BOTTOM CTA */}
      <section style={{ padding:"80px 40px", textAlign:"center" }}>
        <div style={{ maxWidth:600, margin:"0 auto" }}>
          <h2 style={{ fontFamily:"'Inter',sans-serif", fontWeight:900, fontSize:"clamp(32px,5vw,56px)", letterSpacing:-1, margin:"0 0 16px", background:"linear-gradient(135deg,#ffffff,#aaaacc)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>
            READY TO MIX?
          </h2>
          <p style={{ fontSize:13, color:"#9CA3AF", marginBottom:32, lineHeight:1.7 }}>
            Invite a friend, load up your tracks, and start playing together right now. No credit card. No software.
          </p>
          <button onClick={onEnter} className="cta-btn" style={{ padding:"18px 48px", background:"linear-gradient(135deg,#9CA3AF,#0077cc)", border:"none", color:"#000", fontFamily:"'Inter',sans-serif", fontWeight:900, fontSize:16, letterSpacing:3, borderRadius:8, cursor:"pointer", boxShadow:"0 0 40px #9CA3AF33" }}>
            START A MIX →
          </button>
        </div>
      </section>

      {/* FOOTER */}
      <footer style={{ borderTop:"1px solid #15171A", padding:"24px 40px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div style={{ fontFamily:"'Inter',sans-serif", fontWeight:800, fontSize:14, letterSpacing:3, background:"linear-gradient(90deg,#9CA3AF,#A855F7)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>MIX//SYNC</div>
        <div style={{ fontSize:8, fontFamily:"'Inter',sans-serif", color:"#5A5E66" }}>Built for DJs who refuse to be in the same room.</div>
        <div style={{ fontSize:8, fontFamily:"'Inter',sans-serif", color:"#5A5E66" }}>Chrome & Edge · HTTPS required for MIDI + WebRTC</div>
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
    <button onClick={copy} style={{ background: copied ? "#22c55e22" : "#9CA3AF11", border: copied ? "1px solid #22c55e55" : "1px solid #9CA3AF44", color: copied ? "#22c55e" : "#9CA3AF", fontFamily:"'Inter',sans-serif", fontWeight:800, fontSize:7, letterSpacing:1, height:22, padding:"0 9px", borderRadius:5, cursor:"pointer", transition:"all .3s" }}>
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

  const G = "#9CA3AF";
  return (
    <div style={{ minHeight:"100vh", background:"#0D0F12", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'Inter',sans-serif", position:"relative", overflow:"hidden" }}>
      <style>{`@keyframes drift2{0%,100%{transform:translateY(0)}50%{transform:translateY(-12px)}}`}</style>
      <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=DM+Sans:wght@300;400;500&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>
      <div style={{ position:"absolute", top:"15%", right:"10%", width:"50%", height:"60%", borderRadius:"50%", background:`radial-gradient(ellipse,${G}07 0%,transparent 65%)`, animation:"drift2 18s ease-in-out infinite", pointerEvents:"none" }}/>
      <div style={{ position:"absolute", bottom:"10%", left:"5%", width:"35%", height:"45%", borderRadius:"50%", background:"radial-gradient(ellipse,#4A308008 0%,transparent 60%)", animation:"drift2 24s ease-in-out 4s infinite", pointerEvents:"none" }}/>

      <div style={{ position:"relative", zIndex:1, width:460, background:"#15171A", border:`1px solid ${G}18`, borderRadius:16, padding:36, display:"flex", flexDirection:"column", gap:20, boxShadow:`0 40px 80px rgba(0,0,0,.7), 0 0 0 1px #1F2126` }}>

        {/* Header — matches App.jsx logo */}
        <div style={{ textAlign:"center" }}>
          <div style={{ fontFamily:"'Cormorant Garamond',serif", fontWeight:700, fontSize:28, letterSpacing:-0.5, color:"#F5F5F7" }}>
            Mix<span style={{ color:G }}>//</span>Sync
          </div>
          <div style={{ fontSize:9, fontFamily:"'Inter',sans-serif", color:`${G}55`, letterSpacing:3, marginTop:6 }}>{isJoining?"JOIN MIX":"START A MIX"}</div>
        </div>

        {/* Mix Name */}
        <div style={{ display:"flex", flexDirection:"column", gap:7 }}>
          <label style={{ fontSize:8, fontFamily:"'Inter',sans-serif", color:`${G}77`, letterSpacing:2 }}>{isJoining?"JOINING MIX":"MIX NAME"}</label>
          {isJoining ? (
            <div style={{ fontFamily:"'Cormorant Garamond',serif", fontWeight:700, fontSize:22, letterSpacing:0.5, color:"#F5F5F7", padding:"6px 0" }}>{mixName || "Untitled Mix"}</div>
          ) : (
            <input
              value={mixName}
              onChange={e => setMixName(e.target.value)}
              placeholder="e.g., Saturday Late Night"
              style={{ background:"#0D0F12", border:`1px solid ${G}33`, color:"#F5F5F7", borderRadius:8, padding:"11px 14px", fontSize:16, fontFamily:"'Inter',sans-serif", fontWeight:500, outline:"none" }}
            />
          )}
        </div>

        {/* DJ Name */}
        <div style={{ display:"flex", flexDirection:"column", gap:7 }}>
          <label style={{ fontSize:8, fontFamily:"'Inter',sans-serif", color:`${G}77`, letterSpacing:2 }}>YOUR DJ NAME</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            style={{ background:"#0D0F12", border:`1px solid ${G}33`, color:"#F5F5F7", borderRadius:8, padding:"11px 14px", fontSize:16, fontFamily:"'Inter',sans-serif", fontWeight:500, outline:"none" }}
          />
        </div>

        {/* Mix Code */}
        <div style={{ background:"#0D0F12", border:`1px solid ${G}18`, borderRadius:12, padding:16, display:"flex", flexDirection:"column", gap:8 }}>
          <div style={{ fontSize:8, fontFamily:"'Inter',sans-serif", color:`${G}55`, letterSpacing:2 }}>Mix code</div>
          <div style={{ fontFamily:"'Cormorant Garamond',serif", fontWeight:700, fontSize:22, letterSpacing:1, color:"#F5F5F7" }}>{room}</div>
          <div style={{ fontSize:8, fontFamily:"'Inter',sans-serif", color:"#5A5E66", wordBreak:"break-all" }}>{inviteLink}</div>
          <button
            onClick={copyLink}
            style={{ background: copied ? "#22c55e14" : `${G}14`, border: copied ? "1px solid #22c55e33" : `1px solid ${G}33`, color: copied ? "#22c55e" : G, fontFamily:"'Inter',sans-serif", fontWeight:500, fontSize:10, letterSpacing:2, padding:"10px 16px", borderRadius:8, cursor:"pointer", transition:"all .3s", textAlign:"center" }}
          >
            {copied ? "✓ LINK COPIED!" : "⎘ COPY MIX LINK"}
          </button>
          <div style={{ fontSize:8, fontFamily:"'Inter',sans-serif", color:"#9CA3AF", lineHeight:1.6, fontWeight:300 }}>Send this link to your partner — they'll join the same mix instantly.</div>
        </div>

        {/* Join button — matches App.jsx btn-gold */}
        <button
          onClick={() => onJoin({ url: SERVER_URL, room, name, mixName: mixName || "Untitled Mix" })}
          style={{ background:G, border:"none", color:"#0D0F12", fontFamily:"'Inter',sans-serif", fontWeight:500, fontSize:12, letterSpacing:2, padding:"15px", borderRadius:10, cursor:"pointer", boxShadow:`0 0 32px ${G}30, 0 8px 20px rgba(0,0,0,.4)`, transition:"all .2s" }}
        >
          {isJoining?"JOIN MIX →":"START MIX →"}
        </button>

        <div style={{ fontSize:8, fontFamily:"'Inter',sans-serif", color:"#5A5E66", textAlign:"center", letterSpacing:1 }}>
          Chrome · Edge · Free
        </div>
      </div>
    </div>
  );
}

// ── Sync cross-correlation helpers (Path C) ───────────────────
// Kick-band envelope: 40-200 Hz bandpass via cascaded one-pole IIR
// (highpass-via-subtraction at 40, lowpass at 200), then half-wave
// rectify, then lowpass smooth at 30 to get a positive envelope
// suitable for cross-correlation. Coefficient form matches the
// existing dphase()/bpm-worker filters: a = exp(-2π fc / sr).
function _xcorr_kickEnvelope(data, sr) {
  const aHP  = Math.exp(-2 * Math.PI * 40  / sr);
  const aLP  = Math.exp(-2 * Math.PI * 200 / sr);
  const aEnv = Math.exp(-2 * Math.PI * 30  / sr);
  const env = new Float32Array(data.length);
  let lpHP = 0, lpBand = 0, lpEnv = 0;
  for (let i = 0; i < data.length; i++) {
    const x = data[i];
    lpHP = aHP * lpHP + (1 - aHP) * x;
    const hp = x - lpHP;
    lpBand = aLP * lpBand + (1 - aLP) * hp;
    const rect = lpBand > 0 ? lpBand : 0;
    lpEnv = aEnv * lpEnv + (1 - aEnv) * rect;
    env[i] = lpEnv;
  }
  return env;
}

function _xcorr_downsample(arr, hop) {
  const n = Math.floor(arr.length / hop);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = arr[i * hop];
  return out;
}

// In-place iterative Cooley-Tukey radix-2 FFT. Bit-reversal + butterflies.
// Public-domain reference algorithm (Cooley & Tukey 1965). Re/im are
// Float32Array, length must be a power of 2.
function _xcorr_fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tRe = re[i]; re[i] = re[j]; re[j] = tRe;
      const tIm = im[i]; im[i] = im[j]; im[j] = tIm;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const xRe = re[b] * curRe - im[b] * curIm;
        const xIm = re[b] * curIm + im[b] * curRe;
        re[b] = re[a] - xRe;
        im[b] = im[a] - xIm;
        re[a] += xRe;
        im[a] += xIm;
        const newRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newRe;
      }
    }
  }
}

function _xcorr_ifft(re, im) {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  _xcorr_fft(re, im);
  for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] = -im[i] / n;
  }
}

function _xcorr_nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// Cross-correlate two real-valued signals via FFT. Zero-padded to avoid
// circular wrap-around. Returns the lag (signed, in samples of the input
// arrays) where the two signals best align, along with the peak amplitude
// and the RMS of the correlation output for confidence gating.
//
// Convention (verified with concrete examples below): if a's distinctive
// feature is at index pA and b's is at index pB, the peak lag is pB - pA.
//   - peakLag > 0 → b's pattern arrives LATER than a's (b is "behind" in
//     time, needs to advance to catch up).
//   - peakLag < 0 → b's pattern arrives EARLIER (b is "ahead", needs to
//     retreat).
function _xcorr_crossCorrelate(a, b) {
  const n = _xcorr_nextPow2(a.length + b.length);
  const aRe = new Float32Array(n), aIm = new Float32Array(n);
  const bRe = new Float32Array(n), bIm = new Float32Array(n);
  for (let i = 0; i < a.length; i++) aRe[i] = a[i];
  for (let i = 0; i < b.length; i++) bRe[i] = b[i];
  _xcorr_fft(aRe, aIm);
  _xcorr_fft(bRe, bIm);
  // C = A * conj(B): real cross-correlation in frequency domain
  const cRe = new Float32Array(n), cIm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    cRe[i] = aRe[i] * bRe[i] + aIm[i] * bIm[i];
    cIm[i] = aIm[i] * bRe[i] - aRe[i] * bIm[i];
  }
  _xcorr_ifft(cRe, cIm);
  let peakIdx = 0, peakVal = -Infinity, sumSq = 0;
  for (let i = 0; i < n; i++) {
    const v = cRe[i];
    const mag = v < 0 ? -v : v;
    sumSq += v * v;
    if (mag > peakVal) { peakVal = mag; peakIdx = i; }
  }
  const rmsVal = Math.sqrt(sumSq / n) || 1e-9;
  // Negative lags wrap around to high indices after IFFT — fold back to
  // signed range [-n/2, n/2).
  const peakLag = peakIdx > n / 2 ? peakIdx - n : peakIdx;
  return { peakLag, peakVal, rmsVal, n };
}

// ── MAIN APP ─────────────────────────────────────────────────
export default function CollabMix({ initialPage = "landing", djName = null }) {
  const [page, setPage]         = useState(initialPage); // "landing"|"lobby"|"session"
  const eng                     = useRef(null);
  const [ready, setReady]       = useState(true);
  // Persistence state: drives the Safari/denied banner. Idempotent — runs on
  // every mount, fast no-op if already on the persistent tier. This is the
  // primary fix for the "library disappeared between sessions" report: pre-
  // May-25 builds only requested persistence inside _importFileObjects, so
  // users who imported via /library.html (which never called persist()) or
  // whose first import predated the May 7 fix were silently on Chrome's
  // evictable tier and their data could be wiped under disk pressure.
  const [storagePersistence, setStoragePersistence] = useState(null); // null|"persisted"|"denied"|"unsupported"
  const [migrationResult, setMigrationResult] = useState(null); // null|{migrated,orphaned,total,skipped}
  const [persistenceBannerDismissed, setPersistenceBannerDismissed] = useState(() => {
    try { return localStorage.getItem("cm_storage_banner_dismissed") === "1"; } catch { return false; }
  });
  // Auto-dismiss the upgrade toast 6s after migration completes.
  useEffect(() => {
    if (!migrationResult) return;
    const t = setTimeout(() => setMigrationResult(null), 6000);
    return () => clearTimeout(t);
  }, [migrationResult]);
  const dismissPersistenceBanner = () => {
    try { localStorage.setItem("cm_storage_banner_dismissed", "1"); } catch {}
    setPersistenceBannerDismissed(true);
  };
  useEffect(() => {
    let alive = true;
    ensurePersistentStorage().then(state => {
      if (!alive) return;
      setStoragePersistence(state);
      console.log('[STORAGE-PERSIST-MOUNT]', { state });
    }).catch(() => alive && setStoragePersistence("denied"));
    // Lazy handle-shape migration. Fires after persist() resolves to avoid
    // racing the mount's IDB initial reads. Idempotent — if it already ran,
    // returns { skipped: true } immediately.
    const idle = (cb) => (typeof requestIdleCallback === "function"
      ? requestIdleCallback(cb, { timeout: 1500 })
      : setTimeout(cb, 250));
    idle(() => {
      runHandleMigration().then(result => {
        if (!alive) return;
        if (!result.skipped) setMigrationResult(result);
      }).catch(err => console.warn('[STORAGE-MIGRATION-ERR]', err?.message || err));
    });
    return () => { alive = false; };
  }, []);
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
  // Ref mirror so dh() and other handlers can read the latest syncLocked even
  // when called from a stale memoized callback. Deck's toggle (useCallback at
  // line ~3790) omits onChange from its deps, so the captured `dh` keeps an
  // old closure of syncLocked; reading via this ref bypasses the stale path.
  const syncLockedRef = useRef(false);
  useEffect(() => { syncLockedRef.current = syncLocked; }, [syncLocked]);
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

  const bpmRaw = useBPM();
  const rec = useRecorder({ engineRef: eng });
  const lib = useLibrary();

  // ── Rekordbox library (optional): decrypts master.db + reads .EXT files
  //    to source per-track beat grids (PQTZ) for tracks the user has in
  //    Rekordbox. Waveform rendering always uses the local analyzer's 3-band
  //    output + the spectral color formula so all tracks render identically
  //    regardless of source. PWV5 / PWV4 readers stay available for future
  //    cue-point rendering but are not on the runtime render path. ──
  const [rkLib, setRkLib] = useState(null);
  const [rkStatus, setRkStatus] = useState({ phase: "idle" }); // idle | connecting | ready | error
  const [rkGridA, setRkGridA] = useState(null);
  const [rkGridB, setRkGridB] = useState(null);
  // Per-deck user grid override for the currently-loaded track. Populated
  // from the IDB track record's gridAnchorSec / bpmOverride fields whenever
  // a track loads or its library entry updates (e.g. after the user edits
  // the grid). Shape mirrors bpmRaw.results.* so it can spread cleanly in
  // the effectiveBpmResults merge below — same field names, same units.
  // Null when the loaded track has no user override.
  const [userGridA, setUserGridA] = useState(null);
  const [userGridB, setUserGridB] = useState(null);
  // effectiveBpmResults: per-deck beat-grid values. Precedence (lowest →
  // highest): analyzer → Rekordbox PQTZ override → user manual edit.
  // Drop-in shape match for bpmRaw.results.A / .B — same field names, same
  // units. Consumers below read `bpm.results.X` and transparently get the
  // effective grid regardless of source. After a spread, if the user
  // override changed bpm or anchor, we re-derive beatPhaseSec/beatPhaseFrac
  // so they stay internally consistent with the new beatPeriodSec/anchor.
  const effectiveBpmResults = useMemo(() => {
    const mergeOne = (raw, rk, user) => {
      let r = raw || {};
      if (USE_RB_GRID && rk) r = { ...r, ...rk };
      if (user) {
        r = { ...r, ...user };
        const period = r.beatPeriodSec;
        const anchor = r.firstBar1AnchorSec;
        if (period > 0 && anchor != null) {
          r.beatPhaseSec  = anchor % period;
          r.beatPhaseFrac = anchor / period;
        }
      }
      return r;
    };
    return {
      A: mergeOne(bpmRaw.results.A, rkGridA, userGridA),
      B: mergeOne(bpmRaw.results.B, rkGridB, userGridB),
    };
  }, [bpmRaw.results, rkGridA, rkGridB, userGridA, userGridB]);
  // bpm: shadow of the useBPM return with .results overridden. All other
  // hook properties (analyze, etc.) preserved via spread. Lets every
  // consumer of bpm.results read the overridden grid without any site-by-
  // site rename. To disable Rekordbox grids globally: flip USE_RB_GRID.
  const bpm = useMemo(() => ({
    ...bpmRaw,
    results: effectiveBpmResults,
  }), [bpmRaw, effectiveBpmResults]);
  const connectRekordbox = useCallback(async () => {
    setRkStatus({ phase: "connecting" });
    try {
      const lib = await connectRekordboxLibrary({
        onProgress: (p) => setRkStatus({ phase: "connecting", step: p.phase, ...p }),
      });
      setRkLib(lib);
      setRkStatus({ phase: "ready", trackCount: lib.trackCount() });
    } catch (e) {
      console.warn("[REKORDBOX] connect failed:", e.message);
      setRkStatus({ phase: "error", error: e.message });
    }
  }, []);

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

  // Shared per-frame snapshot of audio-context time. Both decks' tick() loops
  // read this instead of calling ac.currentTime directly so they share an
  // identical time-base each frame. Eliminates the sub-millisecond per-deck
  // read offset that caused visual grid oscillation post-rate-aware fix
  // (b28214b): independent ac.currentTime reads at slightly different sub-frame
  // moments produced ~0.2ms × rate of relative buffer-position offset between
  // A and B, which slid back and forth as frame-to-frame timing varied.
  // Falls back to ac.currentTime if snapshot is null (initial mount / focus
  // lost). Same fallback value for both decks → still relatively locked.
  const acNowRef = useRef(null);
  useEffect(() => {
    let rafId;
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const ctx = eng.current?.ctx;
      if (ctx) acNowRef.current = ctx.currentTime;
    };
    tick();
    return () => cancelAnimationFrame(rafId);
  }, []);
  const seekFnsRef = useRef({ A:null, B:null });
  const toggleFnsRef = useRef({ A:null, B:null });
  const cueFnsRef = useRef({ A:null, B:null });
  const nudgeFnsRef = useRef({ A:null, B:null });
  const onDeckASeekReady = useCallback((fn) => { seekFnsRef.current.A = fn; }, []);
  const onDeckBSeekReady = useCallback((fn) => { seekFnsRef.current.B = fn; }, []);
  const onDeckAToggleReady = useCallback((fn) => { toggleFnsRef.current.A = fn; }, []);
  const onDeckACueReady = useCallback((fn) => { cueFnsRef.current.A = fn; }, []);
  const onDeckBToggleReady = useCallback((fn) => { toggleFnsRef.current.B = fn; }, []);
  const onDeckBCueReady = useCallback((fn) => { cueFnsRef.current.B = fn; }, []);
  const onDeckANudgeReady = useCallback((fn) => { nudgeFnsRef.current.A = fn; }, []);
  const onDeckBNudgeReady = useCallback((fn) => { nudgeFnsRef.current.B = fn; }, []);
  // Path C: each Deck registers its internal `bufRef` (the AudioBuffer mirror)
  // via onBufferReady so the cross-correlation block in syncDecks can pull
  // raw samples for sub-beat alignment. We store the REF itself (not the
  // buffer) so the cross-correlator sees the current track after any later
  // load(), without re-registration.
  const bufRefs = useRef({ A:null, B:null });
  const onDeckABufferReady = useCallback((ref) => { bufRefs.current.A = ref; }, []);
  const onDeckBBufferReady = useCallback((ref) => { bufRefs.current.B = ref; }, []);
  const seekDeckA = useCallback((p) => { seekFnsRef.current.A?.(p); }, []);
  const seekDeckB = useCallback((p) => { seekFnsRef.current.B?.(p); }, []);
  // Test helper — expose nudge on window so we can drive it from the
  // browser console before wiring cross-correlation. Usage:
  //   window.cmNudge('A', 0.02)         // 20ms forward, default 200ms ramp
  //   window.cmNudge('B', -0.015, 300)  // 15ms backward, 300ms ramp
  // Remove once cross-correlation lands and this stops being useful.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.cmNudge = (deck, offsetSec, rampDurMs) => {
      const fn = nudgeFnsRef.current[deck];
      if (!fn) { console.warn('[cmNudge] no nudge fn for deck', deck); return; }
      fn(offsetSec, rampDurMs);
    };
    return () => { try { delete window.cmNudge; } catch {} };
  }, []);
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

  // ── Per-track beat-grid overrides (retired localStorage knobs) ──
  // The pre-Commit-1 nudge state (gridOffsetA/B, bpmNudgeA/B, barOneA/B) was
  // never exposed via UI, so the localStorage values were always 0 in
  // practice. User grid edits now live on the IDB track record
  // (gridAnchorSec, bpmOverride) and flow through effectiveBpmResults
  // declared above — every consumer of bpm.results.X automatically picks
  // up the effective grid, including the sync path, the beat-skip buttons,
  // and the partner broadcast. The variables below are kept as zero
  // constants only to satisfy the downstream JSX in <AnimatedZoomedWF> and
  // <Deck> until Commit 2 retires those props alongside the new Grid Edit
  // toolbar. The math at AnimatedZoomedWF:firstDownbeatSec is
  //   beatPhaseFrac × beatPeriodSec + gridOffsetMs/1000 + barOneOffsetSec
  // with the new pipeline, gridOffsetMs and barOneOffsetSec contribute 0
  // and the first two terms already include any user override via
  // effectiveBpmResults.
  const gridOffsetA = 0, gridOffsetB = 0;
  const bpmNudgeA = 0, bpmNudgeB = 0;
  const barOneA = 0, barOneB = 0;

  // One-time localStorage cleanup. The previous knobs persisted under three
  // key prefixes (gridOffset:, bpmNudge:, barOneOffset:) for any track ever
  // loaded onto a deck — even though the values were never user-edited,
  // each load wrote "0" entries. Drain them on first launch post-deploy
  // and set a flag so we never poll localStorage again. Bridge is gated on
  // the flag so it stays a one-shot.
  useEffect(() => {
    const FLAG = "cm_grid_localstorage_migrated";
    try {
      if (localStorage.getItem(FLAG)) return;
      const stale = Object.keys(localStorage).filter(k =>
        k.startsWith("gridOffset:") ||
        k.startsWith("bpmNudge:") ||
        k.startsWith("barOneOffset:")
      );
      for (const k of stale) localStorage.removeItem(k);
      localStorage.setItem(FLAG, "1");
      if (stale.length) console.log("[GRID-MIGRATE] cleared", stale.length, "legacy localStorage keys");
    } catch (e) { console.warn("[GRID-MIGRATE] failed", e); }
  }, []);

  // Library: track which deck is playing + metadata for recommendations
  const [playingTrack, setPlayingTrack] = useState(null);
  const [libLoadA, setLibLoadA] = useState(null);
  const [libLoadB, setLibLoadB] = useState(null);
  const [partnerLibrary, setPartnerLibrary] = useState([]);

  // Rekordbox beat-grid override — when a track loads onto a deck AND the
  // user has a Rekordbox library connected AND the track matches a Rekordbox
  // entry, fetch the PQTZ-derived grid and store it in rkGridA / rkGridB.
  // effectiveBpmResults (declared above) prefers this over the analyzer's
  // grid for that deck. Waveform rendering is unaffected — every track
  // renders through the local analyzer's 3-band output + spectral color
  // formula for visual uniformity across the entire library. Falls back
  // cleanly to analyzer grid when:
  //   • rkLib not connected, or
  //   • track has no Rekordbox match, or
  //   • PQTZ is absent for that track (rare; ~1-2% of Rekordbox libraries).
  // NOTE: must live AFTER libLoadA/libLoadB declarations — the deps array
  // evaluates at render time and would hit a TDZ if hoisted above.
  useEffect(() => {
    if (!rkLib || !libLoadA?.file) { setRkGridA(null); return; }
    let cancelled = false;
    (async () => {
      const match = rkLib.matchTrack(libLoadA.file);
      if (!match) { if (!cancelled) setRkGridA(null); return; }
      const grid = await rkLib.getBeatGrid(match.id);
      if (cancelled) return;
      setRkGridA(grid || null);
    })().catch(e => console.warn("[REKORDBOX-A] grid fetch failed:", e.message));
    return () => { cancelled = true; setRkGridA(null); };
  }, [rkLib, libLoadA]);
  useEffect(() => {
    if (!rkLib || !libLoadB?.file) { setRkGridB(null); return; }
    let cancelled = false;
    (async () => {
      const match = rkLib.matchTrack(libLoadB.file);
      if (!match) { if (!cancelled) setRkGridB(null); return; }
      const grid = await rkLib.getBeatGrid(match.id);
      if (cancelled) return;
      setRkGridB(grid || null);
    })().catch(e => console.warn("[REKORDBOX-B] grid fetch failed:", e.message));
    return () => { cancelled = true; setRkGridB(null); };
  }, [rkLib, libLoadB]);

  // User grid override population for each deck. Watches the currently-loaded
  // track (libLoadX) AND the library state so that an edit made via
  // lib.setGridEdit immediately reflects in the per-deck override. Synthesizes
  // an override object compatible with bpmRaw.results.X — only the fields the
  // user actually changed are non-null, so the merge in effectiveBpmResults
  // spreads them cleanly without clobbering analyzer values the user didn't
  // touch. Returns null when no override is set.
  const _buildUserGrid = (track) => {
    if (!track) return null;
    const hasOverride = track.gridAnchorSec != null || track.bpmOverride != null;
    if (!hasOverride) return null;
    const override = {};
    if (track.bpmOverride != null) {
      override.bpm = track.bpmOverride;
      if (track.bpmOverride > 0) override.beatPeriodSec = 60 / track.bpmOverride;
    }
    if (track.gridAnchorSec != null) override.firstBar1AnchorSec = track.gridAnchorSec;
    return override;
  };
  useEffect(() => {
    if (!libLoadA?.track?.id) { setUserGridA(null); return; }
    const fresh = lib.library?.find(t => t.id === libLoadA.track.id) || libLoadA.track;
    setUserGridA(_buildUserGrid(fresh));
  }, [libLoadA, lib.library]);
  useEffect(() => {
    if (!libLoadB?.track?.id) { setUserGridB(null); return; }
    const fresh = lib.library?.find(t => t.id === libLoadB.track.id) || libLoadB.track;
    setUserGridB(_buildUserGrid(fresh));
  }, [libLoadB, lib.library]);

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
        lib.setFile?.(track.id, file);
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
    lib.removeFile?.(trackId);
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
  // syncDecks(slave, targetBPM, phaseAlign=true)
  // - phaseAlign=true (default): full sync engage — rate match + beat-phase
  //   seek + Path C cross-correlation refinement. Used by handleSyncToggle,
  //   handleTransportFire (scrub-resync), dh's play-start re-align.
  // - phaseAlign=false: rate-only adjustment, no seek. Used by the
  //   track-change effect so a freshly-loaded track on the slave deck keeps
  //   its playhead at 0 — phase alignment is deferred to the play-start
  //   re-align hook when the user actually presses play. Without this gate,
  //   BPM-detection-completes-after-load would yank the slave to a
  //   phase-aligned offset (looks "random" to the user — depends on the new
  //   track's beatPhaseSec) within a couple seconds of loading.
  const syncDecks = useCallback((slave, targetBPM, phaseAlign = true) => {
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

   if (phaseAlign) {
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
      // Beat-level alignment — align slave's next beat to master's next beat.
      // Max nudge ±0.5 beat = ~250ms at 120 BPM (vs ±0.5 bar ≈ 1s with the
      // prior bar-alignment math, which could jump up to 2 beats in either
      // direction whenever the misdetected "first beat" landed mid-bar).
      // Beat alignment is the DJ-tool standard; phrase alignment (matching
      // downbeats) is a manual mix exercise via cue points and not attempted
      // here. slaveBps / masterBps name is misleading — these are beat PERIODS
      // in seconds, not beats-per-second. Kept as-is to minimize diff churn.
      const masterBeatPos  = (masterCurTime - masterBphs) / masterBps;
      const masterBeatFrac = masterBeatPos - Math.floor(masterBeatPos);
      const slaveBeatPos   = (slaveCurTime  - slaveBphs)  / slaveBps;
      const slaveBeatFrac  = slaveBeatPos  - Math.floor(slaveBeatPos);
      let phaseOffsetBeats = masterBeatFrac - slaveBeatFrac;
      if (phaseOffsetBeats >  0.5) phaseOffsetBeats -= 1;
      if (phaseOffsetBeats < -0.5) phaseOffsetBeats += 1;
      const phaseOffsetSeconds = phaseOffsetBeats * slaveBps;
      console.log("[SYNC] beat phase before: master=", masterBeatFrac.toFixed(3), "slave=", slaveBeatFrac.toFixed(3), "(in beats)");
      const newSlaveTime = slaveCurTime + phaseOffsetSeconds;
      const newSlaveProg = Math.max(0, Math.min(1, newSlaveTime / slaveDur));
      // seekFnsRef.current[slave] is the local Deck's seek; it already
      // broadcasts seek_request to the partner so their playhead follows.
      seekFnsRef.current[slave]?.(newSlaveProg);
      console.log("[SYNC] beat phase nudged slave by", phaseOffsetSeconds.toFixed(3), "seconds (newProg=", newSlaveProg.toFixed(4), ")");
      const newSlaveBeatPos = (newSlaveTime - slaveBphs) / slaveBps;
      const newSlaveBeatFrac = newSlaveBeatPos - Math.floor(newSlaveBeatPos);
      console.log("[SYNC] beat phase after: master=", masterBeatFrac.toFixed(3), "slave=", newSlaveBeatFrac.toFixed(3), "(in beats)");

      // ── Path C: cross-correlation refinement ────────────────────────
      // After beat-phase seek lands slave near master's beat, run a short
      // kick-band cross-correlation on the actual audio to fine-tune
      // alignment. Compensates for per-track beatPhaseSec misdetection
      // (e.g., snare-mistaken-for-kick, wrong-beat-of-bar). Silent fallback
      // on low confidence so breakdowns / ambient passages don't introduce
      // spurious corrections.
      const bufA = bufRefs.current?.A?.current;
      const bufB = bufRefs.current?.B?.current;
      const slaveBuf  = slave  === "A" ? bufA : bufB;
      const masterBuf = master === "A" ? bufA : bufB;
      if (slaveBuf && masterBuf) {
        const sr = slaveBuf.sampleRate;
        // Read POST-SEEK slave position. The beat-phase seek above clamped
        // newSlaveTime to [0, 1] before applying — using the unclamped
        // variable for the cross-correlation window caused negative
        // slaveStart values and "window out of buffer bounds" skips near
        // track start (the most common engage scenario).
        const postSeekSlaveProg = slave === "A" ? progRefA.current : progRefB.current;
        const slaveCenterTime  = (postSeekSlaveProg || 0) * slaveDur;
        const masterCenterTime = masterCurTime;
        // Symmetric clamp: shrink left/right padding to the smallest amount
        // available on BOTH decks. This preserves the "relative to playhead"
        // structure between the two windows, so peakLag=0 still means
        // "playheads aligned" regardless of how much padding we have.
        const desiredHalf = (slaveBps * 4) / 2;            // ±2 beats nominal
        const leftSec  = Math.min(desiredHalf, slaveCenterTime,  masterCenterTime);
        const rightSec = Math.min(desiredHalf, slaveDur - slaveCenterTime, masterDur - masterCenterTime);
        const xcWindowSec = leftSec + rightSec;
        const xcWinLen    = Math.round(xcWindowSec * sr);
        const slaveStart  = Math.round((slaveCenterTime  - leftSec) * sr);
        const masterStart = Math.round((masterCenterTime - leftSec) * sr);
        // Need at least 1.5 beats of audio for a reliable correlation —
        // below that, the peak is more likely a fluke than a real lag.
        if (xcWindowSec >= slaveBps * 1.5 &&
            slaveStart >= 0 && masterStart >= 0 &&
            slaveStart  + xcWinLen <= slaveBuf.length &&
            masterStart + xcWinLen <= masterBuf.length) {
          const slaveAudio  = slaveBuf.getChannelData(0).subarray(slaveStart,  slaveStart  + xcWinLen);
          const masterAudio = masterBuf.getChannelData(0).subarray(masterStart, masterStart + xcWinLen);
          const slaveEnv  = _xcorr_kickEnvelope(slaveAudio,  sr);
          const masterEnv = _xcorr_kickEnvelope(masterAudio, sr);
          const hopSamples = Math.max(1, Math.round(sr * 0.005));    // 5ms hop
          const dsSlave  = _xcorr_downsample(slaveEnv,  hopSamples);
          const dsMaster = _xcorr_downsample(masterEnv, hopSamples);
          // crossCorrelate(a, b) with a=master, b=slave: peakLag is signed.
          // peakLag > 0 → slave's pattern arrives LATER than master → slave
          // is BEHIND → seek forward by +peakLag×hopSec. peakLag < 0 →
          // slave is AHEAD → seek backward. correctedSlaveTime = newSlaveTime
          // + peakSec works in either direction.
          const { peakLag, peakVal, rmsVal, n: fftLen } = _xcorr_crossCorrelate(dsMaster, dsSlave);
          const peakRatio = peakVal / rmsVal;
          const hopSec    = hopSamples / sr;
          const peakSec   = peakLag * hopSec;
          // Correction cap matches the cross-correlation search window
          // (±2 beats). The earlier ±0.5 beat cap was over-conservative:
          // production data showed Path C correctly identifying high-
          // confidence corrections in the 250-400ms range on tracks where
          // beatPhaseSec misanchored (the case Path C exists to fix), and
          // the cap was rejecting them. Confidence (peak/RMS > 2.0) is the
          // real safety gate; magnitude alone shouldn't reject a clear peak.
          const maxCorrection = slaveBps * 2.0;            // clamp ±2 beats
          const CONFIDENCE_THRESHOLD = 2.0;
          if (peakRatio < CONFIDENCE_THRESHOLD) {
            console.log("[SYNC-XCORR] peak/RMS=" + peakRatio.toFixed(2) +
              " < threshold " + CONFIDENCE_THRESHOLD +
              " — skipped (fallback to beat-phase only)" +
              " peakLagHops=" + peakLag +
              " peakSec=" + (peakSec * 1000).toFixed(2) + "ms" +
              " fftLen=" + fftLen);
          } else if (Math.abs(peakSec) > maxCorrection) {
            console.log("[SYNC-XCORR] |peakSec|=" + (Math.abs(peakSec) * 1000).toFixed(2) +
              "ms > " + (maxCorrection * 1000).toFixed(0) + "ms cap" +
              " — skipped (likely misdetection)" +
              " peakLagHops=" + peakLag +
              " peakRatio=" + peakRatio.toFixed(2));
          } else {
            // Use slaveCenterTime (the actual post-seek slave position), not
            // the unclamped newSlaveTime. newSlaveTime could be negative if
            // the beat-phase math wanted to retreat before track start;
            // slaveCenterTime reflects where slave really is after clamp.
            const correctedSlaveTime = slaveCenterTime + peakSec;
            const correctedSlaveProg = Math.max(0, Math.min(1, correctedSlaveTime / slaveDur));
            seekFnsRef.current[slave]?.(correctedSlaveProg);
            console.log("[SYNC-XCORR] peak/RMS=" + peakRatio.toFixed(2) +
              " applied: lag=" + peakLag + " hops, correction=" + (peakSec * 1000).toFixed(2) +
              "ms (newProg=" + correctedSlaveProg.toFixed(4) + ")");
          }
        } else {
          console.log("[SYNC-XCORR] window unusable, skipped" +
            " (winSec=" + xcWindowSec.toFixed(3) +
            " leftSec=" + leftSec.toFixed(3) +
            " rightSec=" + rightSec.toFixed(3) +
            " minBeats=" + (slaveBps * 1.5).toFixed(3) +
            " slaveStart=" + slaveStart + " masterStart=" + masterStart +
            " winLen=" + xcWinLen + ")");
        }
      } else {
        console.log("[SYNC-XCORR] bufRefs not available, skipped" +
          " (haveSlaveBuf=" + !!slaveBuf + ", haveMasterBuf=" + !!masterBuf + ")");
      }
    }
   } // end if (phaseAlign)

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
    console.log('[SYNC-STATE] entering toggle', {
      clickedDeck,
      syncLocked,
      rateA, rateB,
      masterDeck: masterDeckRef.current,
      lastSlave: lastSlaveDeckRef.current,
      progA: progRefA.current,
      progB: progRefB.current,
    });
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
      // DJ-correct behavior: on unsync, rates are PRESERVED. The slave audibly
      // stays at its synced rate; the user manages pitch manually from there
      // via the pitch fader. Snapping back to natural BPM on unsync is jarring
      // and not how Rekordbox / CDJs behave. The earlier reset (commit 2772cb9)
      // was overreach — the actual sync-state-contamination bug it targeted is
      // about sticky master/slave refs, NOT about rate. Clearing those refs
      // below still prevents the contamination cleanly.
      //
      // Clear sticky auto-master + slave so next engage re-detects fresh.
      // (Explicit M-button master selections clear too — user can re-set
      //  if desired. Keeps mental model simple: "unsync = metadata clean slate,
      //  pitch stays where you left it".)
      masterDeckRef.current = null;
      setMasterDeck(null);
      lastSlaveDeckRef.current = null;
      setLastSlaveDeck(null);
      logEvent("sync", "toggle", { locked: false, slave: broadcastDeck });
      return;
    }
    const explicitMaster = masterDeckRef.current; // "A" | "B" | null
    let effectiveMaster, slaveDeck = clickedDeck, masterMode;
    if (explicitMaster) {
      effectiveMaster = explicitMaster;
      masterMode      = "explicit";
      // SYNC is a global toggle reachable from either deck. If the user clicks
      // SYNC on the master deck itself, the OTHER deck becomes the slave —
      // master designation lives entirely on the M button; the SYNC button
      // just engages/disengages sync. (Previously this path was rejected with
      // "can't sync a deck to itself"; reverted because the rejection forced
      // the user to mentally model which button does what per deck.)
      if (clickedDeck === explicitMaster) {
        slaveDeck = clickedDeck === "A" ? "B" : "A";
      }
      console.log("[SYNC] explicit master: deck", effectiveMaster, ", slave=", slaveDeck);
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
  }, [syncLocked, syncDecks, bpm.results, pA, pB, sync, getEffectiveMasterBpm, rateA, rateB]);

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
    // seek_local is a Deck → parent local-only hook (driver-path seeks fire
    // it after the seek completes). Suppress broadcast — partner doesn't
    // need to see it — but still use it to trigger the scrub-resync below.
    // Drives the post-drag, post-arrow, post-cue, post-WF-click re-alignment
    // that the seek_request path (non-driver only) didn't cover.
    if (msg?.type !== "seek_local") sync.send(msg);
    if (!syncLocked) return;
    if (msg?.type !== "seek_request" && msg?.type !== "seek_local") return;
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
      console.log(`[SYNC] track changed on deck ${deck} while locked — rate-only re-rate to session tempo ${tempo.toFixed(2)} (phase deferred to play-start)`);
      syncDecks(deck, tempo, false);  // rate-only — keep playhead at 0; play-start hook handles phase
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
      console.log("[SYNC-DEBUG] role swap via M — new slave=", newSlave, "new master=", masterDeck, "(audio unchanged)");
    } else {
      console.log("[SYNC-DEBUG] master changed mid-lock — slave=", currentSlave, "master=", masterDeck, "(audio unchanged)");
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
      // When the SLAVE deck transitions to play AND sync is engaged, re-run
      // alignment. Engaging SYNC while paused at prog=0 leaves slaveCurTime=0,
      // so the phase-alignment seek gets clamped to [0,1] and the slave can
      // end up off-beat by up to ±0.5 beat (clamp eats negative offsets).
      // Re-running ~50ms after play start gives positive playback positions
      // to work with, so the seek can move freely in either direction and
      // beat alignment lands cleanly. No-op if BPM data not ready or sync
      // metadata absent.
      if (value && syncLockedRef.current && lastSlaveDeckRef.current === id) {
        const target = sessionTempoRef.current;
        if (target) {
          setTimeout(() => {
            console.log("[SYNC] play-start re-align for slave", id, "target=", target.toFixed(2));
            syncDecks(id, target);
          }, 50);
        }
      }
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

  const SC = { connected:"#22c55e", connecting:"#f59e0b", disconnected:"#5A5E66", error:"#ef4444" };
  const PANELS = [["rtc","⚡ AUDIO"],["rec","⏺ REC"],["midi","⎍ MIDI"]];

  if (page==="landing") return <Landing onEnter={()=>setPage("lobby")}/>;
  if (page==="lobby")   return <Lobby onJoin={join} djName={djName}/>;

  const G = "#9CA3AF"; // gold accent — matches App.jsx landing
  return (
    <div style={{ height:"100vh", overflow:"hidden", background:"#000000", fontFamily:"'Inter',sans-serif", color:"#F5F5F7", display:"flex", flexDirection:"column" }}>
      <style>{`
        @keyframes blink{0%,100%{box-shadow:0 0 5px currentColor}50%{box-shadow:0 0 14px currentColor}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
        @keyframes wave{0%,100%{transform:scaleY(.3)}50%{transform:scaleY(1)}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes playPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.05)}}
        @keyframes playPulseHalo{0%{transform:scale(1);opacity:0.9}100%{transform:scale(1.25);opacity:0}}
        @keyframes cmToastIn{0%{opacity:0;transform:translateY(8px)}100%{opacity:1;transform:translateY(0)}}
        *{box-sizing:border-box}
        ::-webkit-scrollbar{width:3px}::-webkit-scrollbar-track{background:#0A0B0E}::-webkit-scrollbar-thumb{background:#3A3D44;border-radius:2px}
      `}</style>

      {/* Storage banner — non-blocking, dismissible. Appears only when the
          browser denies persist() (Safari, private mode) or the API is
          unsupported. Tells the user to use the Export button as backup. */}
      {!persistenceBannerDismissed && (storagePersistence === "denied" || storagePersistence === "unsupported") && (
        <div style={{ background:"rgba(255,255,255,0.04)", borderBottom:"1px solid rgba(255,255,255,0.08)", padding:"6px 18px", display:"flex", alignItems:"center", gap:12, fontSize:10, fontFamily:"'Inter',sans-serif", color:"rgba(255,255,255,0.6)", flexShrink:0 }}>
          <span style={{ flex:1, letterSpacing:0.3 }}>Persistent storage unavailable in this browser. Use Export Library to back up.</span>
          <button onClick={dismissPersistenceBanner} style={{ background:"transparent", border:"none", color:"rgba(255,255,255,0.4)", fontSize:11, cursor:"pointer", padding:"2px 6px", transition:"color 150ms cubic-bezier(0.4, 0, 0.2, 1)" }} onMouseEnter={e=>e.currentTarget.style.color="rgba(255,255,255,0.9)"} onMouseLeave={e=>e.currentTarget.style.color="rgba(255,255,255,0.4)"}>×</button>
        </div>
      )}

      {/* Upgrade toast — subtle, auto-dismisses after 6s. Shown once per
          origin on the first launch after the May-25 storage migration. */}
      {migrationResult && (
        <div style={{ position:"fixed", bottom:24, left:"50%", transform:"translateX(-50%)", background:"rgba(20,20,24,0.95)", border:"1px solid rgba(255,255,255,0.12)", borderRadius:6, padding:"8px 16px", fontSize:10, fontFamily:"'Inter',sans-serif", color:"rgba(255,255,255,0.9)", letterSpacing:0.3, zIndex:9999, animation:"cmToastIn 150ms cubic-bezier(0.4, 0, 0.2, 1)", boxShadow:"0 12px 32px rgba(0,0,0,0.6)" }}>
          Library upgraded — tracks now permanently saved
          {migrationResult.orphaned > 0 && (
            <span style={{ marginLeft:8, color:"rgba(255,255,255,0.5)" }}>· {migrationResult.orphaned} need reconnect</span>
          )}
        </div>
      )}
      <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=DM+Sans:wght@300;400;500&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>

      {/* TOP BAR — matches App.jsx nav */}
      <div style={{ background:"#000000f0", backdropFilter:"blur(16px)", borderBottom:"1px solid rgba(255,255,255,0.06)", padding:"8px 18px", display:"flex", alignItems:"center", gap:12, flexShrink:0 }}>
        <div onClick={()=>leave()} style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer" }}>
          <div style={{ width:28, height:28, borderRadius:7, border:`1px solid ${G}38`, display:"flex", alignItems:"center", justifyContent:"center", background:`${G}08` }}>
            <span style={{ fontFamily:"'Inter',sans-serif", fontSize:9, color:G }}>{"//"}</span>
          </div>
          <span style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:18, fontWeight:700, color:"#F5F5F7", letterSpacing:-0.3 }}>Mix<span style={{ color:G }}>//</span>Sync</span>
        </div>
        <div style={{ flex:1, display:"flex", gap:10, alignItems:"center" }}>
          <div style={{ display:"flex", gap:5, alignItems:"center", fontSize:7, fontFamily:"'Inter',sans-serif" }}>
            <div style={{ width:5, height:5, borderRadius:"50%", background:SC[sync.status], boxShadow:sync.status==="connected"?`0 0 8px ${SC[sync.status]}`:""}}/>
            <span style={{ color:SC[sync.status], letterSpacing:1 }}>{sync.status.toUpperCase()}</span>
            {sync.ping&&<span style={{ color:"#5A5E66" }}>· {sync.ping}ms</span>}
          </div>
          {sync.connErr && <span style={{ fontSize:9, fontFamily:"'Inter',sans-serif", color:"#ef4444", background:"#ef444411", border:"1px solid #ef444422", borderRadius:4, padding:"1px 8px" }}>{sync.connErr}</span>}
          {sync.partner&&<div style={{ fontSize:9, fontFamily:"'Inter',sans-serif", color:G, background:`${G}0e`, border:`1px solid ${G}28`, borderRadius:5, padding:"2px 10px", letterSpacing:.5 }}>⟺ {sync.partner}</div>}
          {(() => {
            // AUDIO status pill — surfaces WebRTC state so users know if partner audio is flowing.
            const isBusy = ["offering","answering","connecting"].includes(rtc.state);
            const status =
              !sync.partner            ? { label:"AUDIO: OFFLINE",       c:"#5A5E66", pulse:false }
              : rtcReconnectExhausted  ? { label:"AUDIO: FAILED",        c:"#ef4444", pulse:false }
              : rtc.state==="connected"? { label:"AUDIO: STREAMING",     c:"#22c55e", pulse:false }
              : rtc.state==="failed"   ? { label:"AUDIO: FAILED",        c:"#ef4444", pulse:false }
              : isBusy                 ? { label:"AUDIO: CONNECTING…",   c:"#f59e0b", pulse:true  }
              :                          { label:"AUDIO: CONNECTING…",   c:"#f59e0b", pulse:true  };
            return (
              <div style={{ fontSize:9, fontFamily:"'Inter',sans-serif", color:status.c, background:`${status.c}0d`, border:`1px solid ${status.c}33`, borderRadius:5, padding:"2px 10px", letterSpacing:.5, display:"flex", gap:6, alignItems:"center" }}>
                <div style={{ width:5, height:5, borderRadius:"50%", background:status.c, boxShadow:`0 0 6px ${status.c}`, animation: status.pulse?"pulse .9s infinite":"none" }}/>
                <span>{status.label}</span>
              </div>
            );
          })()}
          {rec.state==="recording"&&<div style={{ fontSize:9, fontFamily:"'Inter',sans-serif", color:"#ef4444", background:"#ef444411", border:"1px solid #ef444428", borderRadius:5, padding:"2px 10px", animation:"pulse .8s infinite", letterSpacing:.5 }}>REC {String(Math.floor(rec.dur/60)).padStart(2,"0")}:{String(Math.floor(rec.dur%60)).padStart(2,"0")}</div>}
          {midi.active&&<div style={{ fontSize:9, fontFamily:"'Inter',sans-serif", color:G, background:`${G}0d`, border:`1px solid ${G}28`, borderRadius:5, padding:"2px 10px", letterSpacing:.5 }}>MIDI</div>}
        </div>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          {/* Panel toggles — relocated v5.2 from the deck-row strip into the
              top header so the library reclaims the vertical space. Each
              click opens / closes the detail strip below the deck row. */}
          <div style={{ display:"flex", gap:0, alignItems:"center", paddingRight:8, borderRight:"1px solid rgba(255,255,255,0.06)", marginRight:2 }}>
            {PANELS.map(([pid, l]) => {
              const active = panel === pid;
              return (
                <button key={pid} onClick={() => setPanel(p => p === pid ? null : pid)}
                  style={{
                    padding:"3px 9px", fontSize:8, fontFamily:"'Inter',sans-serif",
                    background: active ? "rgba(255,255,255,0.08)" : "transparent",
                    color: active ? "#F5F5F7" : "#5A5E66",
                    border:"none", borderRadius:3,
                    cursor:"pointer", outline:"none", letterSpacing:1,
                    transition:"color .12s, background .12s",
                  }}
                  onMouseEnter={e => { if (!active) e.currentTarget.style.color = "#9CA3AF"; }}
                  onMouseLeave={e => { if (!active) e.currentTarget.style.color = "#5A5E66"; }}
                >{l}</button>
              );
            })}
          </div>
          <span style={{ fontSize:9, fontFamily:"'Inter',sans-serif", color:"#9CA3AF", letterSpacing:.5 }}>{session.name}</span>
          <ShareButton room={session.room} mixName={session.mixName}/>
          <button onClick={leave} style={{ height:24, padding:"0 10px", background:"transparent", border:"1px solid #ef444433", color:"#ef4444", borderRadius:6, cursor:"pointer", fontFamily:"'Inter',sans-serif", fontSize:9, letterSpacing:.5 }}>Leave</button>
        </div>
      </div>

      {/* AUTOPLAY-BLOCKED BANNER — shown when the browser blocked the partner audio
          element from playing. The document-level click handler in useRTC will
          retry play() on the next click anywhere, so the banner is informational. */}
      {rtc.autoplayBlocked && (
        <div style={{ flexShrink:0, padding:"8px 14px", background:"#f59e0b18", borderBottom:"1px solid #f59e0b44", color:"#f59e0b", fontSize:11, fontFamily:"'Inter',sans-serif", letterSpacing:.5, textAlign:"center" }}>
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
            <div style={{ flexShrink:0, height:40, background:"#000000", borderBottom:"1px solid #1F2126", display:"flex", alignItems:"center", justifyContent:"center", color:"#5A5E66", fontSize:9, fontFamily:"'Inter',sans-serif", letterSpacing:3, textTransform:"uppercase" }}>
              No track loaded — drop tracks below to start
            </div>
          );
        }
        // Each waveform always renders at the single-deck height — when both
        // decks are loaded the waveform SECTION doubles in total vertical
        // area instead of each canvas shrinking. Splitting fixed space made
        // maxH collapse, which was visually flattening drops despite the
        // height math being correct. Deck panels below shift down to make
        // room; their fixed row stays intact.
        // May 22: reduced 120 → 78. v5.2: bumped to 90 since chrome rows
        // were removed; each deck's waveform sits directly above the other.
        const wfH = 90;
        return (
          <div style={{ position:"relative", flexShrink:0, background:"#000000", borderBottom:"1px solid #1F2126" }}>
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
                style={{ minHeight:wfH, flexShrink:0 }}>
                <AnimatedZoomedWF bands={wfA} dur={wfA?.dur||0} progRef={progRefA} onSeek={seekDeckA} h={wfH} windowSec={WF_WINDOWS[wfZoom]} beatPhaseFrac={bpm.results["A"]?.beatPhaseFrac??null} beatPeriodSec={bpm.results["A"]?.beatPeriodSec??null} gridOffsetMs={gridOffsetA} barOneOffsetSec={barOneA * (bpm.results["A"]?.beatPeriodSec || 0)} bpmNudge={bpmNudgeA*0.01} deckColor="#2E86DE" rate={rateA}/>
              </div>
            )}
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
                style={{ minHeight:wfH, flexShrink:0 }}>
                <AnimatedZoomedWF bands={wfB} dur={wfB?.dur||0} progRef={progRefB} onSeek={seekDeckB} h={wfH} windowSec={WF_WINDOWS[wfZoom]} beatPhaseFrac={bpm.results["B"]?.beatPhaseFrac??null} beatPeriodSec={bpm.results["B"]?.beatPeriodSec??null} gridOffsetMs={gridOffsetB} barOneOffsetSec={barOneB * (bpm.results["B"]?.beatPeriodSec || 0)} bpmNudge={bpmNudgeB*0.01} deckColor="#A855F7" rate={rateB}/>
              </div>
            )}
            {/* Zoom selector — floats in the top-right corner of the waveform
                section. Restrained, single visual element vs the prior chrome
                rows. v5.2: A/B chrome rows + per-deck nudge controls removed;
                nudge UX needs a new discoverable affordance before dogfood
                (state and handlers still defined in the parent component). */}
            <div style={{ position:"absolute", top:5, right:8, display:"flex", gap:0, alignItems:"center", background:"rgba(10,11,14,0.65)", backdropFilter:"blur(4px)", borderRadius:4, padding:2 }}>
              {WF_ZOOM_LABELS.map((lbl,i)=>(
                <button key={i} onClick={()=>setWfZoom(i)} style={{ height:16, padding:"0 7px", fontSize:7, fontFamily:"'Inter',sans-serif", letterSpacing:.8, background:wfZoom===i?"rgba(255,255,255,0.10)":"transparent", border:"none", color:wfZoom===i?"#F5F5F7":"#5A5E66", borderRadius:3, cursor:"pointer", outline:"none", transition:"color .12s, background .12s" }}>{lbl}</button>
              ))}
            </div>
          </div>
        );
      })()}

      {/* DECKS + MIXER ROW
          May 22: height bumped 220 → 248 so the 68px transport row (52px white
          play + 8+8 vertical padding) fits inside the deck card without
          clipping. Library still gains net vertical room from the shorter
          waveform (above) + removed crossfader row (below).
          Grid-edit redesign (May 26): the PLAY/GRID tab strip that motivated
          the 248 → 280 bump was removed in favour of a single small Set-Beat-1
          button on each deck (no vertical addition), so height returned to
          248. The grid edit data layer + sync migration from Commit 1 stays
          in place — user clicks the red dot to call lib.setGridEdit at the
          current playhead. */}
      <div style={{ flexShrink:0, display:"grid", gridTemplateColumns:"1fr 200px 1fr", gap:8, padding:"6px 12px 0", height:"248px", overflow:"hidden", width:"100%" }}>

        {/* ── DECK A (shared) — outer "Deck A · driver" header bar removed;
              new inner Deck header has the 3-part identity row at top. ── */}
        <div style={{ display:"flex", flexDirection:"column", minWidth:0, minHeight:0, overflow:"hidden", background:"#15171A", border:`1px solid ${deckDrivers.A?"#2E86DE44":"rgba(255,255,255,0.06)"}`, borderRadius:10, transition:"border-color 150ms cubic-bezier(0.4, 0, 0.2, 1)" }}>
          <div style={{ flex:1, display:"flex", alignItems:"flex-start", gap:10, padding:"10px 0 10px 10px", overflow:"hidden", minHeight:0 }}>
            <DeckArt artwork={libLoadA?.track?.artwork} fallback="A" color="#2E86DE"/>
            <div style={{ flex:1, overflow:"hidden", minHeight:0 }}>
            <Deck id="A" ch={eng.current?.A} ctx={eng.current?.ctx} color="#2E86DE" local remote={pA} onChange={dh("A")} midi={midiEvt} bpmResult={bpm.results["A"]} bpmAnalyze={bpm.analyze} eqHi={eqA.hi} eqMid={eqA.mid} eqLo={eqA.lo} chanVol={eqA.vol} loadFromLibrary={libLoadA} onTrackInfo={handleTrackInfo} onSync={()=>handleSyncToggle("A")} syncReady={!!(bpm.results["B"]?.bpm || pB?.bpm)} syncRole={syncLocked ? (lastSlaveDeck === "A" ? "slave" : "master") : null} isMaster={masterDeck === "A"} onMasterToggle={handleMasterToggle} onLibraryTrackDrop={(trackId)=>{const t=lib.library.find(x=>x.id===trackId);if(t)handleLibLoad(t,"A");}} onProgUpdate={handleProgA} onWaveform={setWfA} onSeekReady={onDeckASeekReady} onToggleReady={onDeckAToggleReady} onCueReady={onDeckACueReady} onNudgeReady={onDeckANudgeReady} onTransportFire={handleTransportFire} isDriver={!deckDrivers.A || deckDrivers.A === session.name} acNowRef={acNowRef} onBufferReady={onDeckABufferReady} barOneOffsetSec={barOneA * (bpm.results["A"]?.beatPeriodSec || 0)} onGridEdit={(fields) => libLoadA?.track?.id && lib.setGridEdit?.(libLoadA.track.id, fields)}/>
            </div>
          </div>
        </div>

        {/* ── CENTER MIXER ── */}
        <div style={{ display:"flex", flexDirection:"column", background:"#15171A", border:"1px solid rgba(255,255,255,0.06)", borderRadius:10, overflow:"hidden", minHeight:0, boxShadow:"0 8px 32px rgba(0,0,0,.8), inset 0 1px 0 rgba(255,255,255,0.06)" }}>

          {/* HEADER — VU only; diagnostic text ("Master out · room") removed
              per design v5. Header strip stays as visual separator. */}
          <div style={{ padding:"6px 8px 5px", background:"#0D0F12", borderBottom:"1px solid rgba(255,255,255,0.06)", display:"flex", flexDirection:"column", alignItems:"center", flexShrink:0 }}>
            <VU an={eng.current?.masterAn} color="#9CA3AF" w={80}/>
          </div>

          {/* CHANNEL STRIPS — 3-column: [CH A] [CENTER] [CH B] */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 64px 1fr", flex:1, minHeight:0, overflow:"hidden" }}>

            {/* ─── CH A STRIP ─── */}
            <div style={{ display:"flex", flexDirection:"column", borderRight:"1px solid rgba(255,255,255,0.06)", overflow:"hidden" }}>
              {/* Header: label + VU inline */}
              <div style={{ padding:"3px 6px", background:"#0D0F12", borderBottom:"1px solid rgba(255,255,255,0.06)", display:"flex", justifyContent:"space-between", alignItems:"center", flexShrink:0 }}>
                <span style={{ fontFamily:"'Inter',sans-serif", fontSize:11, color:"#2E86DE", fontWeight:600, letterSpacing:1 }}>A</span>
                <VU an={eng.current?.A?.an} color="#2E86DE" w={50}/>
              </div>
              {/* Channel fader LEFT, EQ knobs RIGHT — outer edge layout */}
              <div style={{ flex:1, display:"flex", flexDirection:"row", minHeight:0, overflow:"hidden" }}>
                {/* Channel volume fader — far left (outer edge) */}
                <div style={{ flexShrink:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"5px 4px", borderRight:"1px solid rgba(255,255,255,0.06)", gap:2 }}>
                  <div style={{ fontSize:6, fontFamily:"'Inter',sans-serif", color:"#2E86DE55", letterSpacing:1 }}>Vol</div>
                  <VerticalFader val={eqA.vol} set={v=>updateEqA("vol",v)} color="#2E86DE" h={130}/>
                  <div style={{ fontSize:7, fontFamily:"'Inter',sans-serif", color:"#2E86DE88" }}>{(eqA.vol/1.5*100).toFixed(0)}%</div>
                </div>
                {/* Knobs column — inner side */}
                <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"space-evenly", padding:"5px 2px" }}>
                  <Knob v={eqA.vol} set={v=>updateEqA("vol",v)} min={0} max={1.5} ctr={1} label="Gain" color="#2E86DE" size={16}/>
                  <Knob v={eqA.hi}  set={v=>updateEqA("hi",v)}  min={-12} max={12} ctr={0} label="Hi"   color="#2E86DE" size={16}/>
                  <Knob v={eqA.mid} set={v=>updateEqA("mid",v)} min={-12} max={12} ctr={0} label="Mid"  color="#2E86DE" size={16}/>
                  <Knob v={eqA.lo}  set={v=>updateEqA("lo",v)}  min={-12} max={12} ctr={0} label="Lo"   color="#2E86DE" size={16}/>
                </div>
              </div>
            </div>

            {/* ─── CENTER COLUMN ─── */}
            <div style={{ display:"flex", flexDirection:"column", background:"#0D0F12", overflow:"hidden" }}>
              {/* Master fader — fills the column now that ROOM/PING/NET
                  diagnostic strip was stripped per design v5. */}
              <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:3, minHeight:0 }}>
                <div style={{ fontSize:7, fontFamily:"'Inter',sans-serif", color:"#9CA3AF99", letterSpacing:2 }}>Master</div>
                <VerticalFader val={mvol} set={setMvolLocal} color="#9CA3AF" h={130}/>
                <div style={{ fontSize:7, fontFamily:"'Inter',sans-serif", color:"#9CA3AF99" }}>{(mvol/1.5*100).toFixed(0)}%</div>
              </div>
            </div>

            {/* ─── CH B STRIP (local) ─── */}
            <div style={{ display:"flex", flexDirection:"column", borderLeft:"1px solid rgba(255,255,255,0.06)", overflow:"hidden" }}>
              {/* Header: label + VU inline */}
              <div style={{ padding:"3px 6px", background:"#0D0F12", borderBottom:"1px solid rgba(255,255,255,0.06)", display:"flex", justifyContent:"space-between", alignItems:"center", flexShrink:0 }}>
                <span style={{ fontFamily:"'Inter',sans-serif", fontSize:11, color:"#A855F7", fontWeight:600, letterSpacing:1 }}>B</span>
                <VU an={eng.current?.B?.an} color="#A855F7" w={50}/>
              </div>
              {/* EQ knobs LEFT, channel fader RIGHT — outer edge layout */}
              <div style={{ flex:1, display:"flex", flexDirection:"row", minHeight:0, overflow:"hidden" }}>
                {/* Knobs column — inner side */}
                <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"space-evenly", padding:"5px 2px" }}>
                  <Knob v={eqB.vol} set={v=>updateEqB("vol",v)} min={0} max={1.5} ctr={1} label="Gain" color="#A855F7" size={16}/>
                  <Knob v={eqB.hi}  set={v=>updateEqB("hi",v)}  min={-12} max={12} ctr={0} label="Hi"   color="#A855F7" size={16}/>
                  <Knob v={eqB.mid} set={v=>updateEqB("mid",v)} min={-12} max={12} ctr={0} label="Mid"  color="#A855F7" size={16}/>
                  <Knob v={eqB.lo}  set={v=>updateEqB("lo",v)}  min={-12} max={12} ctr={0} label="Lo"   color="#A855F7" size={16}/>
                </div>
                {/* Channel volume fader — far right (outer edge) */}
                <div style={{ flexShrink:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"5px 4px", borderLeft:"1px solid rgba(255,255,255,0.06)", gap:2 }}>
                  <div style={{ fontSize:6, fontFamily:"'Inter',sans-serif", color:"#A855F755", letterSpacing:1 }}>Vol</div>
                  <VerticalFader val={eqB.vol} set={v=>updateEqB("vol",v)} color="#A855F7" h={130}/>
                  <div style={{ fontSize:7, fontFamily:"'Inter',sans-serif", color:"#A855F788" }}>{(eqB.vol/1.5*100).toFixed(0)}%</div>
                </div>
              </div>
            </div>
          </div>

          {/* ── CROSSFADER STRIP — lives at the bottom of the mixer card.
                May 22: relocated here from the standalone row between
                decks-and-library so the library can reclaim that vertical
                strip. A label · slider · B label · CTR reset. ── */}
          <div style={{ flexShrink:0, display:"flex", alignItems:"center", gap:6, padding:"6px 8px", borderTop:"1px solid rgba(255,255,255,0.06)", background:"#0A0B0E" }}>
            <span style={{ fontSize:9, fontFamily:"'Inter',sans-serif", color:"#2E86DEaa", fontWeight:700, lineHeight:1, letterSpacing:.5, flexShrink:0 }}>A</span>
            <div style={{ flex:1, position:"relative", height:20, display:"flex", alignItems:"center" }}>
              <div style={{ width:"100%", height:5, borderRadius:3, background:"#06070A", border:"1px solid rgba(255,255,255,0.06)", boxShadow:"inset 0 1px 2px rgba(0,0,0,.7)" }}>
                <div style={{ height:"100%", width:`${xf*100}%`, background:"linear-gradient(90deg, rgba(15,79,160,0.50), rgba(31,201,122,0.45))", borderRadius:3 }}/>
              </div>
              <input type="range" min={0} max={1} step={.005} value={xf} onChange={e=>setXfLocal(Number(e.target.value))} style={{ position:"absolute", width:"100%", opacity:0, cursor:"pointer", height:20 }}/>
              <div style={{ position:"absolute", left:`calc(${xf*100}% - 9px)`, width:18, height:16, background:"#232529", border:"1px solid #3A3D44", borderRadius:3, boxShadow:"0 1px 4px rgba(0,0,0,.7)", pointerEvents:"none" }}/>
            </div>
            <span style={{ fontSize:9, fontFamily:"'Inter',sans-serif", color:"#A855F7aa", fontWeight:700, lineHeight:1, letterSpacing:.5, flexShrink:0 }}>B</span>
            <button onClick={()=>setXfLocal(.5)} title="Center crossfader" style={{ fontSize:7, height:16, padding:"0 6px", background:"transparent", border:"1px solid rgba(255,255,255,0.08)", color:"#5A5E66", borderRadius:3, cursor:"pointer", fontFamily:"'Inter',sans-serif", letterSpacing:.5, flexShrink:0 }}>CTR</button>
          </div>
        </div>

        {/* ── DECK B (shared) — outer header bar removed (see Deck A note). ── */}
        <div style={{ display:"flex", flexDirection:"column", minWidth:0, minHeight:0, overflow:"hidden", background:"#15171A", border:`1px solid ${deckDrivers.B?"#A855F744":"rgba(255,255,255,0.06)"}`, borderRadius:10, transition:"border-color 150ms cubic-bezier(0.4, 0, 0.2, 1)" }}>
          <div style={{ flex:1, display:"flex", alignItems:"flex-start", gap:10, padding:"10px 0 10px 10px", overflow:"hidden", minHeight:0 }}>
            <DeckArt artwork={libLoadB?.track?.artwork} fallback="B" color="#A855F7"/>
            <div style={{ flex:1, overflow:"hidden", minHeight:0 }}>
            <Deck id="B" ch={eng.current?.B} ctx={eng.current?.ctx} color="#A855F7" local remote={pB} onChange={dh("B")} midi={midiEvt} bpmResult={bpm.results["B"]} bpmAnalyze={bpm.analyze} eqHi={eqB.hi} eqMid={eqB.mid} eqLo={eqB.lo} chanVol={eqB.vol} loadFromLibrary={libLoadB} onTrackInfo={handleTrackInfo} onSync={()=>handleSyncToggle("B")} syncReady={!!(bpm.results["A"]?.bpm || pA?.bpm)} syncRole={syncLocked ? (lastSlaveDeck === "B" ? "slave" : "master") : null} isMaster={masterDeck === "B"} onMasterToggle={handleMasterToggle} onLibraryTrackDrop={(trackId)=>{const t=lib.library.find(x=>x.id===trackId);if(t)handleLibLoad(t,"B");}} onProgUpdate={handleProgB} onWaveform={setWfB} onSeekReady={onDeckBSeekReady} onToggleReady={onDeckBToggleReady} onCueReady={onDeckBCueReady} onNudgeReady={onDeckBNudgeReady} onTransportFire={handleTransportFire} isDriver={!deckDrivers.B || deckDrivers.B === session.name} acNowRef={acNowRef} onBufferReady={onDeckBBufferReady} barOneOffsetSec={barOneB * (bpm.results["B"]?.beatPeriodSec || 0)} onGridEdit={(fields) => libLoadB?.track?.id && lib.setGridEdit?.(libLoadB.track.id, fields)}/>
            </div>
          </div>
        </div>

      </div>

      {/* ── PANEL DETAIL (rtc / rec / midi) — opens when the toggle in the
            top header is active. Wrapper collapses fully when no panel open,
            so the library gets the full vertical strip back. ── */}
      {panel && <div style={{ flexShrink:0, borderTop:"1px solid rgba(255,255,255,0.06)", background:"#0D0F12", maxHeight:120, overflow:"auto" }}>
        {panel==="rtc"  && <RTCPanel rtc={rtc} partner={sync.partner} syncOk={sync.status==="connected"}/>}
        {panel==="rec"  && <RecPanel rec={rec} ready={ready}/>}
        {panel==="midi" && <MidiPanel midi={midi}/>}
      </div>}

      {/* ── EMBEDDED LIBRARY — fills remaining space below decks ── */}
      <div style={{ flex:1, overflow:"hidden", borderTop:"1px solid rgba(255,255,255,0.06)", background:"#0D0F12", minHeight:0 }}>
        <LibraryPanelV2
          lib={lib}
          onLoad={handleLibLoad}
          playingTrack={playingTrack}
          deckATrackId={libLoadA?.track?.id || null}
          deckBTrackId={libLoadB?.track?.id || null}
          previewTrackId={previewTrackId}
          onPreview={handlePreview}
          onDelete={handleDeleteTrack}
          chat={chat}
          onSendChat={msg=>sync.send({type:"chat",msg})}
          me={session.name}
          rkLib={rkLib}
          rkStatus={rkStatus}
          onConnectRekordbox={connectRekordbox}
        />
      </div>

      </div>{/* end main content area */}

    </div>
  );
}
