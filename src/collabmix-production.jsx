import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { WORKER_SRC } from "./bpm-worker-source.js";
import { logEvent, setSessionContext, captureHandledError } from "./utils/telemetry.js";
import { createClockSync } from "./utils/clockSync.js";
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
  getLibraryMode, setLibraryMode,
  LIBRARY_MODE_DEFAULT,
} from "./utils/storage.js";
import {
  isFSASupported,
  requestFolder as fsaRequestFolder,
  restoreHandles as fsaRestoreHandles,
  requestPermissionFor as fsaRequestPermission,
  removeFolderById as fsaRemoveFolderById,
  setFolderEnabled as fsaSetFolderEnabled,
  scanWatchedFolders,
  setFolderLastScanned as fsaSetFolderLastScanned,
} from "./utils/fsa.js";

// ═══════════════════════════════════════════════════════════════
//  MIX//SYNC  — PRODUCTION READY
//  All bugs fixed. Landing page. Full app.
// ═══════════════════════════════════════════════════════════════

// ── URL feature flags, captured ONCE at module load ──────────────
// The app strips the query string via history.replaceState during
// auto-rejoin / leave (see ~line 8857/8878), so reading
// window.location.search LATER (e.g. when a deck analyzes a track)
// returns empty and the flag is lost. Capture at module evaluation —
// which runs before React mounts and before the strip — so the flags
// survive. This is the fix for ?onsetgrid not reaching the analyzer.
const URL_FLAGS = (() => {
  try { return new URLSearchParams(window.location.search); }
  catch { return new URLSearchParams(); }
})();
// Full Phase-1+2 stack (onset-anchored beatTimes + de-smear). PROMOTED
// default-on June 11 2026 after the full-stack zoom A/B (threshold locked 15%);
// gridlines ride the kick fronts. Kill switch: ?onsetgrid=0.
const ONSET_GRID = URL_FLAGS.get("onsetgrid") !== "0";
// ?beatsv2=0 kill-switch (default on). Read from the captured flags so the
// kill-switch also survives the query-string strip.
const BEATS_V2 = URL_FLAGS.get("beatsv2") !== "0";
// Library Import V2 (first-run wizard + Door 1/5 + mix detection). Default OFF —
// gated so existing LIB-PHASE behavior is unchanged until promotion.
const LIB_WIZARD = URL_FLAGS.get("libwizard") === "1";
// ?mirrordiag=1 — partner-mirror / render-starvation diagnostics. Per-deck draw
// RAF logs effective fps + worst frame gap + drawn position (1/sec), and the
// non-driver interp logs output vs last-packet vs packet-age. Reveals whether
// the mirror misbehaves because the DRAW is starved (main-thread budget) vs the
// interp being wrong vs packets absent. Off by default — pure logging.
const MIRROR_DIAG = URL_FLAGS.get("mirrordiag") === "1";
// ?smoothdiag=1 — "why isn't the scroll glass?" instrumentation. Per deck, once
// a second, logs over the last second: scroll-delta stats (mean / stddev / max
// px the playhead moved per frame) to quantify motion smoothness; zeroFrames
// (frames where the playhead did NOT move — high = STEPPED position updates, the
// classic judder source; low = per-frame interpolation); frame cadence (fps,
// dropped frames, worst frame gap); and per-frame DRAW cost (mean/max ms) to
// catch hitches from de-smear / band rendering. Tagged role=local|mirror so the
// driver deck and the partner-mirrored deck are compared directly. Pure logging.
const SMOOTH_DIAG = URL_FLAGS.get("smoothdiag") === "1";
// Delay compensation — PROMOTED default-on June 11 2026 after the 30-min
// production endurance soak (comp held 55.3–55.9ms for the full run, survived 3
// track-ends + re-engages, zero errors/disconnects). Kill switch: ?delaycomp=0.
const DELAY_COMP = URL_FLAGS.get("delaycomp") !== "0";
// Test hooks (window.__loadTestTrack) — ON in dev (the smoke suite runs the vite
// dev server) or with ?smoke=1 against a build. NEVER on for a plain production
// load, so real users never get the hook.
const TEST_HOOKS = (import.meta.env && import.meta.env.DEV) || URL_FLAGS.get("smoke") === "1";
// ?wfpulse=<0..1> — scales the big-WF beat-pulse emphasis: the centerline weight
// band that thickens on each kick + the amplitude-driven brightness overlay.
// These are what make the playing waveform appear to "breathe/pulse" at the
// playhead (vs Rekordbox's constant-velocity glass). The base amplitude SHAPE is
// untouched (Rekordbox shows that too) — only the per-kick emphasis scales.
//   absent / =1 → current look   ·   0.5 → half   ·   0 → truly static (no pulse)
// For an A/B against the Rekordbox reference. Default unchanged.
const WF_PULSE = (() => {
  const v = URL_FLAGS.get("wfpulse");
  if (v == null || v === "") return 1;
  const n = parseFloat(v);
  return isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
})();

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

// Normalize whatever the user typed/pasted in the join field down to a bare
// room code. Pasting a full invite URL (or any "…room=CODE…" fragment) was
// being sent verbatim as the roomId — the server then created a room literally
// NAMED that URL (the production room-split bug; [JOIN-DIAG] caught it). Extract
// the room param when present; otherwise treat the input as a bare code. Trim +
// lowercase to match generated codes (lowercase word-word-###).
function normalizeRoomCode(raw) {
  let s = (raw || "").trim();
  if (!s) return "";
  if (/room=/i.test(s)) {
    let code = null;
    try { code = new URL(s).searchParams.get("room"); } catch { /* not a full URL */ }
    if (!code) { const m = s.match(/[?&]?room=([^&#\s]+)/i); if (m) code = m[1]; }
    if (code) { try { s = decodeURIComponent(code); } catch { s = code; } }
  }
  return s.trim().toLowerCase();
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
  // Local-monitor delay (Gap #4 compensation). Sits ONLY on the path to the
  // local speakers — the partner-send tap (capture) and the recorder tap both
  // read `master` upstream of this, so the delay never colours what we send or
  // record. Default 0 = no-op; driven only when ?delaycomp=1.
  const monitorDelay = ctx.createDelay(1.0); monitorDelay.delayTime.value = 0;
  master.connect(masterAn); masterAn.connect(monitorDelay); monitorDelay.connect(ctx.destination);
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
  return { ctx, master, masterAn, monitorDelay, A: chain(), B: chain() };
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
      const { id, bpm, confidence, candidates, beatPhaseFrac, beatPeriodSec, beatPhaseSec, firstBar1AnchorSec, snapped, beatTimes, beatAttacks, error, _debug } = e.data;
      if (id === '__err') { console.error('[BPM Worker global error]', e.data.error); return; }
      if (error) console.error('[BPM Worker caught error]', error);
      console.log('[BPM result] id='+id+' bpm='+bpm+' bpf='+beatPhaseFrac+' bps='+beatPeriodSec+' bphs='+beatPhaseSec+' anchor='+firstBar1AnchorSec+' snapped='+(snapped??false)+' debug='+JSON.stringify(_debug));
      console.log('[BPM] analysis complete for deck', id, 'bpm=', bpm);
      setResults(prev => ({ ...prev, [id]: { bpm, confidence, candidates, beatPhaseFrac: beatPhaseFrac||0, beatPeriodSec: beatPeriodSec||null, beatPhaseSec: beatPhaseSec??null, firstBar1AnchorSec: firstBar1AnchorSec??null, beatTimes: beatTimes||null, beatAttacks: beatAttacks||null, analyzing: false } }));
    };
    worker.current.onerror = (e) => { console.error('[BPM Worker onerror]', e.message, e.lineno); };
    return () => worker.current?.terminate();
  }, []);
  const analyze = useCallback((buf, id, opts) => {
    if (!buf || !worker.current) return;
    console.log('[BPM] analysis started for deck', id, '(track loaded)');
    // CLEAR stale fields from the previous track's analysis. Previously this
    // spread-preserved prev[id], leaving beatPhaseFrac / beatPeriodSec /
    // firstBar1AnchorSec at the OLD track's values until the worker message
    // for the new track arrived. The Deck auto-position useEffect could fire
    // in that window with stale data and lock itself out of re-firing when
    // the real result came in.
    setResults(prev => ({ ...prev, [id]: { ...(prev[id] || {}), bpm: null, beatPhaseFrac: null, beatPeriodSec: null, beatPhaseSec: null, firstBar1AnchorSec: null, beatTimes: null, beatAttacks: null, analyzing: true } }));
    const cd = [];
    for (let c = 0; c < buf.numberOfChannels; c++) cd.push(buf.getChannelData(c).slice());
    // Phase 1 grid re-anchor: ?onsetgrid=1 (captured at module load — the URL
    // query is stripped after join, so a late read here would always be false)
    // tells the worker to anchor beatTimes on the kick ONSET instead of the
    // diff-argmax mid-attack point. SKIPPED for tracks carrying an imported
    // (rekordbox) grid — that grid is authoritative and overrides the analyzer's
    // beatTimes downstream, so onset re-anchoring would be wasted/irrelevant
    // work. The analyzer still RUNS (its beatAttacks feed the B2B broadcast);
    // only the onset-anchor refinement of beatTimes is gated off.
    const onsetAnchor = ONSET_GRID && !opts?.skipOnsetAnchor;
    console.log("[ONSET-GRID] deck " + id + " analysis dispatch — onsetAnchor=" + onsetAnchor);
    // Transfer ArrayBuffers (O(1) vs O(n) structured clone) — avoids 10-30s stall on large tracks
    worker.current.postMessage({ cd, sr: buf.sampleRate, id, onsetAnchor }, cd.map(a => a.buffer));
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
// Background-immune heartbeat. A backgrounded tab PAUSES requestAnimationFrame
// and throttles main-thread setInterval, so a RAF/setInterval-driven progress
// broadcast starves (~0.4Hz) and the partner's mirror starves. A Worker timer
// is far less throttled when the page is hidden, so it keeps the heartbeat
// flowing; the main thread computes the live position from ac.currentTime (the
// audio clock keeps running in background) on each beat. cmd 'start'{ms} / 'stop'.
const TIMER_WORKER = `let iv=null;self.onmessage=function(e){var d=e.data||{};if(d.cmd==='start'){if(iv)clearInterval(iv);iv=setInterval(function(){self.postMessage(1);},d.ms||100);}else if(d.cmd==='stop'){if(iv)clearInterval(iv);iv=null;}};`;
function createTimerWorker(){ try{ return new Worker(URL.createObjectURL(new Blob([TIMER_WORKER],{type:"application/javascript"}))); }catch{ return null; } }

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

// ── Mix/recording detection (Library V2 Item 2) ─────────────────────────────
// Cheap duration via the audio element's metadata (no full decode), then
// classify: <12min = track, >20min = a long recording auto-shelved to "Mixes &
// Recordings", 12-20min = track + long marker. Filename/genre votes refine the
// gray zone and cover the duration-unknown case. Reversible per-file later.
const MIX_TRACK_MAX_SEC = 12 * 60;   // below this is always a track
const MIX_SHELVE_SEC    = 20 * 60;   // above this auto-shelves to Mixes & Recordings
function getAudioDuration(file) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; try { URL.revokeObjectURL(url); } catch {} resolve(v); };
    let url;
    try {
      url = URL.createObjectURL(file);
      const a = new Audio();
      a.preload = "metadata";
      a.onloadedmetadata = () => finish(isFinite(a.duration) && a.duration > 0 ? a.duration : null);
      a.onerror = () => finish(null);
      a.src = url;
      setTimeout(() => finish(null), 6000);   // safety — don't hang the import
    } catch { finish(null); }
  });
}
function mixVoteCount(filename, genre) {
  const n = (filename || "").toLowerCase(), g = (genre || "").toLowerCase();
  let v = 0;
  if (/\b(mix|set|liveset|live set|dj ?set|podcast|episode|mixtape|continuous)\b/.test(n)) v++;
  if (/\bep\.?\s?\d|ep\d|\bvol\.?\s?\d/.test(n)) v++;
  if (n.includes("@")) v++;
  if (/dj ?mix|mixtape|continuous|live ?set/.test(g)) v++;
  return v;
}
// → { section: "tracks"|"mixes", long: bool }. durSec may be null (unknown).
function classifyLibrarySection(durSec, filename, genre) {
  const votes = mixVoteCount(filename, genre);
  if (durSec != null) {
    if (durSec >= MIX_SHELVE_SEC) return { section: "mixes", long: true };
    if (durSec >= MIX_TRACK_MAX_SEC) return { section: "tracks", long: true }; // 12-20 gray → track + marker
    return { section: "tracks", long: false };
  }
  // Duration unknown: lean on votes (2+ strong signals → treat as a mix).
  return votes >= 2 ? { section: "mixes", long: true } : { section: "tracks", long: false };
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
  // Phase 1 library auto-import — watched folders + selected mode. Populated
  // mount-time via the FSA restoreHandles() helper. No scanning in Phase 1;
  // this is plumbing-only state that the settings UI reads/writes.
  const [watchedFolders,setWatchedFolders]=useState([]);
  const [libraryMode,setLibraryModeState]=useState(LIBRARY_MODE_DEFAULT);
  const [lastImportSummary,setLastImportSummary]=useState(null); // V2 wizard payoff {imported,skipped,shelved,at}
  // Phase 2 — scan-driven import pipeline. pendingNewTracks holds the
  // dedup-filtered scanner output between scan completion and user decision
  // (Import / Skip / Review-first). scanning gates re-entry while a scan is
  // in flight. scanAbortRef holds the AbortController for cancellation.
  // No scan triggers in Commit 2 — runLibraryScan exists as a callable but
  // nothing calls it until Commit 4 wires mount / post-grant / manual button.
  const [pendingNewTracks,setPendingNewTracks]=useState([]);
  const [scanning,setScanning]=useState(false);
  const scanAbortRef=useRef(null);
  // Phase 2 — { current, total } | null. Populated while commitPendingNewTracks
  // is in flight so the banner can render "Importing N of M…" with per-file
  // granularity (each import iteration inside _importFileObjects calls back
  // via opts.onProgress; commitPendingNewTracks translates batch-local index
  // into the global current count).
  const [importProgress,setImportProgress]=useState(null);
  // Phase 2 Commit 4 — running counter during scanWatchedFolders so the
  // empty-state copy can say "Scanning… found N tracks so far." rather than
  // a static spinner. Cleared back to null on scan completion.
  const [scanProgress,setScanProgress]=useState(null); // { found, folderName? } | null
  // Forward ref to runLibraryScan so addWatchedFolder's post-grant auto-scan
  // can fire without creating a circular useCallback dependency (addWatched
  // Folder is declared before runLibraryScan in this body, and depending
  // on runLibraryScan in its useCallback deps would hit the TDZ at component-
  // body evaluation time).
  const runLibraryScanRef=useRef(null);
  // Mount-time auto-scan guard. Ensures the scan only fires once per mount
  // even though the watching effect's dep array includes watchedFolders,
  // which can change later when the user adds a folder.
  const mountScanStartedRef=useRef(false);
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
  // opts.skipDedup:   when true, bypass internal artist+title dedup. Set this
  //                   when the caller (e.g. commitImport after the preview
  //                   modal, or Phase 2's commitPendingNewTracks after the
  //                   scanner already vetted dedup) has explicitly asked for
  //                   import-as-is.
  // opts.phase2Meta:  Array<{folderId, sourcePath}> aligned with `files`.
  //                   Set by the Phase 2 scan-driven import path so the new
  //                   track records carry their watched-folder identity.
  //                   Looked up via a Map<file, meta> built once to stay
  //                   robust against the internal audio filter dropping any
  //                   entry (shouldn't happen with the expanded regex below,
  //                   but the Map is the defensive path).
  const _importFileObjects=useCallback(async(files,handles=[],opts={})=>{
    // Phase 2 expanded the regex to cover the full scanner-audible extension
    // set (.aiff/.aif/.opus/.alac added; .mp4 still excluded — see fsa.js
    // AUDIO_EXTENSIONS comment). Manual-import UI paths (drag-drop /
    // showOpenFilePicker) still restrict upstream to the original six, so no
    // manual-import behavior change. The expansion only matters when the
    // Phase 2 scanner is the caller, in which case the upstream filter at
    // scanWatchedFolder already enforces the same set so this is a no-op.
    const audio=[...files].filter(f=>f.type.startsWith("audio/")||f.name.match(/\.(mp3|wav|flac|aiff?|m4a|aac|ogg|opus|alac)$/i));
    if(!audio.length)return;
    // Build a per-file metadata lookup for the Phase 2 import path so the
    // track record can be stamped with folderId + sourcePath. Map keyed by
    // the File reference — robust against the audio filter dropping any
    // entry (in which case its phase2Meta entry simply never gets read).
    let phase2ByFile=null;
    if(opts.phase2Meta){
      if(opts.phase2Meta.length!==files.length){
        console.warn('[IMPORT-PHASE2] phase2Meta length mismatch with files; ignoring metadata',{
          metaLen:opts.phase2Meta.length,filesLen:files.length,
        });
      }else{
        phase2ByFile=new Map();
        for(let k=0;k<files.length;k++)phase2ByFile.set(files[k],opts.phase2Meta[k]);
      }
    }
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
    let shelvedMixCount=0; // long recordings auto-shelved to Mixes & Recordings (V2)
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
      // folderId + sourcePath populated from opts.phase2Meta when the Phase 2
      // scanner is the caller; null otherwise (manual import paths). hash
      // stays null in Phase 2 — file content hash is reserved for Phase 2.5
      // SHA-256 work, not in scope here. Existing 136 tracks remain untouched
      // per P1-Q1 (no backfill — only NEW track records get the new fields).
      const p2=phase2ByFile?.get(file)||null;
      // Library V2 mix detection (gated). Probe duration cheaply + classify so
      // long DJ sets/recordings auto-shelve to "Mixes & Recordings" instead of
      // polluting the track list. Sets duration early as a bonus. Off → untouched.
      let librarySection="tracks", longTrack=false, probedDur=null;
      if (LIB_WIZARD) {
        probedDur = await getAudioDuration(file);
        const cls = classifyLibrarySection(probedDur, file.name, tags.genre);
        librarySection = cls.section; longTrack = cls.long;
        if (librarySection==="mixes") shelvedMixCount++;
      }
      const track={id,filename:file.name.replace(/\.[^.]+$/,""),title,artist,album:tags.album||"",genre:tags.genre||"",label:tags.label||"",bpm:tags.bpm?parseFloat(tags.bpm):null,key:tags.key||null,duration:probedDur,energy:null,analyzed:false,error:false,addedAt:Date.now(),artwork:tags.artwork||null,artworkVersion:tags.artwork?ARTWORK_PARSER_VERSION:undefined,folderId:p2?.folderId||null,sourcePath:p2?.sourcePath||null,hash:null,librarySection,longTrack};
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
          queueRef.current.push({id,skipBPM:false,skipKey:!!track.key});
        }
      }
      importedCount++;
      // Per-iteration progress hook — Phase 2 banner subscribes via
      // commitPendingNewTracks so the "Importing N of M…" copy updates per
      // file instead of per chunked batch. opts.onProgress is undefined for
      // the manual import paths, so they pay zero cost.
      try{opts.onProgress?.({filename:file.name,index:i,total:audio.length});}catch{}
    }
    console.log('[IMPORT-DONE]',{importedCount,skippedCount,shelvedMixCount,totalCandidates:audio.length,ms:Math.round(performance.now()-tImport0)});
    if(skippedCount>0){
      console.log(`[library] Imported ${importedCount} tracks, skipped ${skippedCount} duplicate${skippedCount===1?"":"s"}`);
    }
    if(LIB_WIZARD){
      setLastImportSummary({imported:importedCount,skipped:skippedCount,shelved:shelvedMixCount,at:Date.now()});
      if(shelvedMixCount>0) console.log(`[LIB-V2] ${shelvedMixCount} long recording${shelvedMixCount===1?"":"s"} moved to Mixes & Recordings`);
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
          queueRef.current.push({id:track.id,skipBPM:false,skipKey:!!track.key});
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
    queueRef.current.push({id,file,skipBPM:false,skipKey:!!t?.key});
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

  // ── Phase 1 library auto-import — plumbing only (no scanning) ───────────
  // Mount-time: restore any previously granted folder handles + load the
  // user's selected library mode. Both are non-blocking; failures are
  // logged and the UI continues with empty state. No prompts on mount per
  // P1-Q2 — silent queryPermission only; the user re-grants deliberately
  // from the settings UI when they choose to.
  useEffect(()=>{
    let cancelled=false;
    (async()=>{
      try{
        const folders=await fsaRestoreHandles();
        if(!cancelled)setWatchedFolders(folders);
      }catch(err){
        console.warn('[LIB-PHASE1] restoreHandles unexpectedly threw',err);
      }
      try{
        const mode=await getLibraryMode();
        if(!cancelled)setLibraryModeState(mode);
        console.log('[LIB-PHASE1] libraryMode →',mode);
      }catch(err){
        console.warn('[LIB-PHASE1] getLibraryMode failed, falling back to default',err);
      }
    })();
    return()=>{cancelled=true;};
  },[]);

  // Add a new watched folder via the system picker. `startIn` biases the
  // picker ("downloads", "music", etc.) but the user still has to confirm.
  // Returns the added record or null on user cancel; throws on spike failure
  // so the UI can surface it.
  const addWatchedFolder=useCallback(async({startIn}={})=>{
    const rec=await fsaRequestFolder({startIn});
    if(!rec)return null;
    // Newly added folders always have permission "granted" (the picker just
    // gave it). Avoid round-tripping queryPermission for nothing.
    const enriched={...rec,permission:"granted"};
    setWatchedFolders(prev=>[...prev,enriched]);
    // Phase 2 Commit 4 — post-grant auto-scan, scoped to just this folder.
    // Mount-scan's one-shot guard does not (re-)fire when the user adds a
    // folder later in the session, so the trigger lives here. setTimeout(0)
    // defers a tick so setWatchedFolders has committed before runLibraryScan
    // captures the watchedFolders snapshot via its closure. Fire-and-forget;
    // failures are logged inside runLibraryScan.
    setTimeout(()=>{
      console.log('[LIB-PHASE2] post-grant auto-scan trigger',{folderId:enriched.id,folderName:enriched.name});
      runLibraryScanRef.current?.({folderIds:[enriched.id]}).catch(err=>{
        console.warn('[LIB-PHASE2] post-grant auto-scan threw',{error:err?.message||String(err)});
      });
    },0);
    return enriched;
  },[]);

  const removeWatchedFolder=useCallback(async(id)=>{
    const ok=await fsaRemoveFolderById(id);
    if(ok)setWatchedFolders(prev=>prev.filter(f=>f.id!==id));
    return ok;
  },[]);

  const setWatchedFolderEnabled=useCallback(async(id,enabled)=>{
    const next=await fsaSetFolderEnabled(id,enabled);
    if(next)setWatchedFolders(prev=>prev.map(f=>f.id===id?{...f,enabled:next.enabled}:f));
    return next;
  },[]);

  // Re-grant a folder that's currently "prompt" or "denied". Must be invoked
  // from a user gesture (Chrome enforces). Updates local state with the new
  // permission so the UI re-renders the row.
  const requestPermissionForFolder=useCallback(async(id)=>{
    const folder=watchedFolders.find(f=>f.id===id);
    if(!folder||!folder.handle){
      console.warn('[LIB-PHASE1] requestPermissionForFolder: no folder or no handle',id);
      return "denied";
    }
    const state=await fsaRequestPermission(folder.handle);
    setWatchedFolders(prev=>prev.map(f=>f.id===id?{...f,permission:state}:f));
    return state;
  },[watchedFolders]);

  const changeLibraryMode=useCallback(async(mode)=>{
    try{
      await setLibraryMode(mode);
      setLibraryModeState(mode);
      console.log('[LIB-PHASE1] libraryMode changed →',mode);
      return true;
    }catch(err){
      console.warn('[LIB-PHASE1] setLibraryMode failed',err);
      return false;
    }
  },[]);

  // ── Phase 2 library auto-import — scan + dedup + commit ─────────────────
  // runLibraryScan walks every enabled+granted watched folder via the
  // scanWatchedFolders orchestrator, then filters scan results down to
  // "new" tracks using a two-tier dedup:
  //   PRIMARY  — tracksMatch(artist, title) against the existing library
  //              (artist/title derived from filename via cleanFilename +
  //              parseArtistTitle; full ID3 isn't parsed at scan time
  //              because doing so would require reading every file's bytes,
  //              defeating the streaming-handle design)
  //   FALLBACK — (folderId, sourcePath) composite match against existing
  //              library tracks. Only matches Phase 2-imported tracks, since
  //              pre-Phase-2 records have folderId=null. Catches the case
  //              where a re-scan finds the same file but its filename-
  //              derived artist/title differs from what was parsed at the
  //              first import (e.g. due to filename cleanup changes).
  // A scan result is "new" only if BOTH checks miss.
  //
  // commitPendingNewTracks routes pendingNewTracks through the existing
  // _importFileObjects path with { skipDedup: true } since the scanner has
  // already vetted dedup. Internal pre-confirmed pattern: the existing
  // opts.skipDedup flag (used by manual commitImport after preview-modal
  // user choice) covers Phase 2 cleanly — no new flag added.
  //
  // Handles are batched in chunks of 100 before per-batch h.getFile() so
  // peak File-blob retention stays bounded even for 5000-track libraries.

  // Default chunk size for the post-scan import. 100 is well above any
  // realistic batch where peak File-blob retention matters (each File is
  // a thin wrapper around an internal blob ref; 100 of them is bounded
  // in main-thread memory) and small enough that even pathological 5000-
  // track imports drain through the streaming analyzer at a steady pace.
  const PHASE2_IMPORT_CHUNK=100;

  // opts.folderIds — optional array of watchedFolder ids to restrict the
  // scan to. Used by the post-grant auto-scan to scope work to the just-
  // added folder. Mount-time auto-scan and the manual "Check for new
  // music" button both omit it (scan everything).
  const runLibraryScan=useCallback(async(opts={})=>{
    if(scanning){
      console.warn('[LIB-PHASE2] runLibraryScan: scan already in progress — ignoring re-entry');
      return null;
    }
    const targetFolders=opts.folderIds && opts.folderIds.length
      ?watchedFolders.filter(f=>opts.folderIds.includes(f.id))
      :watchedFolders;
    setScanning(true);
    setScanProgress({found:0,folderName:targetFolders[0]?.name||null});
    const controller=new AbortController();
    scanAbortRef.current=controller;
    const t0=performance.now();
    let summary=null;
    try{
      console.log('[LIB-PHASE2] scan start',{folders:targetFolders.length,scope:opts.folderIds?'subset':'all'});
      const agg=await scanWatchedFolders(targetFolders,{
        signal:controller.signal,
        onProgress:({found,folderName})=>{
          // Aggregator-level callback fires per audio file across every
          // folder being scanned, so `found` already counts across folders.
          // folderName follows the current folder for the UI's
          // "Scanning… in beatport_tracks_2026-05-2" hint when desired.
          setScanProgress({found,folderName});
        },
      });
      // Two-tier dedup against current library state. Filename-derived
      // artist/title for the primary tracksMatch, (folderId, sourcePath)
      // composite for the fallback. A scan result is "new" only if BOTH
      // miss.
      const newTracks=agg.results.filter(item=>{
        // Fallback check: same folder + same relative path already imported
        const sameLocation=library.some(t=>
          t.folderId===item.folderId && t.sourcePath===item.relativePath
        );
        if(sameLocation)return false;
        // Primary check: artist+title (filename-derived) match against library
        const cleaned=cleanFilename(item.name);
        const parsed=parseArtistTitle(cleaned);
        const candidate={
          artist:parsed.artist||"Unknown Artist",
          title:parsed.title,
        };
        return !library.some(existing=>tracksMatch(existing,candidate));
      });
      setPendingNewTracks(newTracks);
      // Persist lastScannedAt on every successfully-scanned folder. UI state
      // refresh mirrors what IDB now holds so the "last checked" copy stays
      // truthful even before the next mount-time restoreHandles.
      const now=Date.now();
      for(const folderId of agg.scannedFolderIds){
        try{await fsaSetFolderLastScanned(folderId,now);}
        catch(err){console.warn('[LIB-PHASE2] setFolderLastScanned failed',{folderId,error:err?.message||String(err)});}
      }
      const scannedSet=new Set(agg.scannedFolderIds);
      setWatchedFolders(prev=>prev.map(f=>scannedSet.has(f.id)?{...f,lastScannedAt:now}:f));
      summary={
        scanned:agg.scannedFolderIds.length,
        found:agg.results.length,
        new:newTracks.length,
        skippedFolders:agg.skippedFolders,
        ms:Math.round(performance.now()-t0),
      };
      console.log('[LIB-PHASE2] scan complete',summary);
    }catch(err){
      if(err?.name==="AbortError"){
        console.log('[LIB-PHASE2] scan cancelled');
      }else{
        console.warn('[LIB-PHASE2] scan failed',{error:err?.message||String(err)});
      }
    }finally{
      setScanning(false);
      setScanProgress(null);
      scanAbortRef.current=null;
    }
    return summary;
  },[scanning,watchedFolders,library]);

  // Mirror runLibraryScan into a ref so callbacks that need to trigger it
  // (e.g. addWatchedFolder's post-grant auto-scan) can call through the ref
  // without listing runLibraryScan in their useCallback deps — avoids the
  // TDZ that would otherwise apply since addWatchedFolder is declared
  // earlier in this hook body than runLibraryScan.
  useEffect(()=>{runLibraryScanRef.current=runLibraryScan;},[runLibraryScan]);

  // Phase 2 Commit 4 — mount-time auto-scan. Fires once per mount when the
  // first batch of restored watchedFolders includes at least one enabled
  // + granted folder. The mountScanStartedRef guard makes this a strict
  // one-shot even though the effect's deps include watchedFolders (which
  // changes later when the user adds folders — those go through the
  // post-grant trigger inside addWatchedFolder instead). setTimeout(0)
  // defers to the next event-loop tick so the initial render commits
  // before the scan starts pulling on the FSA bridge.
  useEffect(()=>{
    if(mountScanStartedRef.current)return;
    if(!watchedFolders.length)return;
    const eligible=watchedFolders.some(f=>f.enabled!==false&&f.permission==="granted");
    if(!eligible)return;
    mountScanStartedRef.current=true;
    const t=setTimeout(()=>{
      console.log('[LIB-PHASE2] mount-time auto-scan trigger');
      runLibraryScanRef.current?.().catch(err=>{
        console.warn('[LIB-PHASE2] mount auto-scan threw',{error:err?.message||String(err)});
      });
    },0);
    return()=>clearTimeout(t);
  },[watchedFolders]);

  const dismissPendingNewTracks=useCallback(()=>{
    setPendingNewTracks([]);
    console.log('[LIB-PHASE2] pendingNewTracks dismissed');
  },[]);

  // commitPendingNewTracks imports the pending tracks via the existing
  // _importFileObjects path with skipDedup:true. selectedKeys (optional Set
  // of "folderId:relativePath" composite strings) lets the Phase 3
  // Review-first UI pass a user-chosen subset; omitted = import everything.
  const commitPendingNewTracks=useCallback(async(selectedKeys=null)=>{
    const toImport=selectedKeys
      ?pendingNewTracks.filter(t=>selectedKeys.has(`${t.folderId}:${t.relativePath}`))
      :pendingNewTracks;
    if(toImport.length===0){
      console.log('[LIB-PHASE2] commitPendingNewTracks: nothing to import');
      setPendingNewTracks([]);
      return{imported:0,batches:0};
    }
    console.log('[LIB-PHASE2] commitPendingNewTracks start',{tracks:toImport.length,chunkSize:PHASE2_IMPORT_CHUNK});
    const totalCount=toImport.length;
    // Seed progress so the banner immediately switches into the importing
    // state even for tiny libraries (sub-100-track batches would otherwise
    // see no progress update before the entire import finished).
    setImportProgress({current:0,total:totalCount});
    let imported=0,batches=0;
    try{
      for(let i=0;i<toImport.length;i+=PHASE2_IMPORT_CHUNK){
        const batch=toImport.slice(i,i+PHASE2_IMPORT_CHUNK);
        let files;
        try{files=await Promise.all(batch.map(item=>item.handle.getFile()));}
        catch(err){
          console.warn('[LIB-PHASE2] batch getFile failed; skipping batch',{batchStart:i,error:err?.message||String(err)});
          continue;
        }
        const batchHandles=batch.map(item=>item.handle);
        const phase2Meta=batch.map(item=>({folderId:item.folderId,sourcePath:item.relativePath}));
        await _importFileObjects(files,batchHandles,{
          skipDedup:true,
          phase2Meta,
          onProgress:({index})=>{
            // index is 0-based within the current batch; offset by i for the
            // global count. +1 because we report "imported so far" (after this
            // file completes), not "currently working on file N".
            setImportProgress({current:i+index+1,total:totalCount});
          },
        });
        imported+=batch.length;
        batches++;
      }
    }finally{
      setImportProgress(null);
      setPendingNewTracks([]);
    }
    console.log('[LIB-PHASE2] commitPendingNewTracks done',{imported,batches});
    return{imported,batches};
  },[pendingNewTracks,_importFileObjects]);

  const fsaSupported=isFSASupported();

  // V2 mix detection: move a track between Tracks ↔ Mixes & Recordings (reversible).
  const setTrackSection=useCallback(async(id,section)=>{
    const sec=section==="mixes"?"mixes":"tracks";
    setLibrary(prev=>prev.map(t=>t.id===id?{...t,librarySection:sec}:t));
    try{const t=(library||[]).find(x=>x.id===id); if(t) await cmDbPut("tracks",{...t,librarySection:sec});}catch{}
  },[library]);
  return{library,queue,crates,importing,importFiles,importFromPicker,previewImport,commitImport,queueAnalysis,reanalyze,reExtractArtwork,setGridEdit,getFile,clear,reload,setLibrary,fileMap,setFile,removeFile,analyzing,progress,analyzeAll,extractArtworkForTrack,artworkCache,reconnectFromFolder,scanArtwork,exportLibrary,importLibraryJson,watchedFolders,libraryMode,addWatchedFolder,removeWatchedFolder,setWatchedFolderEnabled,requestPermissionForFolder,changeLibraryMode,fsaSupported,pendingNewTracks,scanning,scanProgress,importProgress,runLibraryScan,dismissPendingNewTracks,commitPendingNewTracks,lastImportSummary,setTrackSection};
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

// ── Library V2 first-run wizard (Item 1) — "Where's your music?" ────────────
// Five named doors; Door 1 (scan computer) + Door 5 (drop anything) live, the
// rest marked soon. Skippable (never blocks the booth). Quiet-pro copy:
// sentence case, no exclamation marks. Metrics at console level.
function LibraryWizard({ lib, onClose }) {
  const W = "rgba(255,255,255,0.92)", M = "rgba(255,255,255,0.6)", F = "rgba(255,255,255,0.32)";
  const PANEL = "rgba(20,20,24,0.97)", LINE = "rgba(255,255,255,0.1)";
  const [door, setDoor] = useState(null);                 // null | 'scan' | 'drop'
  const [folderState, setFolderState] = useState({});     // {music:{status,added}, …}
  const folderBeforeRef = useRef({});                     // library count when each folder's scan started
  const [dropActive, setDropActive] = useState(false);
  const openedAtRef = useRef(performance.now());
  const firstTrackRef = useRef(false);
  const doorUsedRef = useRef(null);
  const count = (lib.library || []).length;

  // Metric: time-to-first-track (the magic-moment latency we optimize for).
  useEffect(() => {
    if (!firstTrackRef.current && count > 0) {
      firstTrackRef.current = true;
      console.log(`[LIB-V2-METRIC] time-to-first-track=${Math.round(performance.now() - openedAtRef.current)}ms door=${doorUsedRef.current || "?"}`);
    }
  }, [count]);
  // Auto-import what the scans find — no review-gate inside the wizard (dedupe
  // already ran in the scanner). Only while the wizard is open.
  useEffect(() => {
    if ((lib.pendingNewTracks || []).length > 0 && !lib.scanning) lib.commitPendingNewTracks?.();
  }, [lib.pendingNewTracks, lib.scanning]);

  const STD = [
    { key: "music", label: "Music", startIn: "music" },
    { key: "downloads", label: "Downloads", startIn: "downloads" },
    { key: "desktop", label: "Desktop", startIn: "desktop" },
    { key: "documents", label: "Documents", startIn: "documents" },
  ];
  const scanFolder = async (f) => {
    doorUsedRef.current = "scan";
    console.log(`[LIB-V2-METRIC] door-open=scan folder=${f.key}`);
    folderBeforeRef.current[f.key] = (lib.library || []).length;
    setFolderState(s => ({ ...s, [f.key]: { status: "scanning" } }));
    try { const rec = await lib.addWatchedFolder?.({ startIn: f.startIn }); if (!rec) setFolderState(s => ({ ...s, [f.key]: { status: "skipped" } })); }
    catch { setFolderState(s => ({ ...s, [f.key]: { status: "skipped" } })); }
    // The per-folder count is filled in by the settle effect when the scan +
    // auto-commit finishes (so each click pays off visibly before the next).
  };
  // When a scan settles, mark any scanning folder done with its track delta.
  useEffect(() => {
    if (lib.scanning || (lib.pendingNewTracks || []).length > 0) return;
    const now = (lib.library || []).length;
    setFolderState(s => {
      let changed = false; const next = { ...s };
      for (const k of Object.keys(s)) {
        if (s[k]?.status === "scanning") { next[k] = { status: "done", added: Math.max(0, now - (folderBeforeRef.current[k] ?? now)) }; changed = true; }
      }
      return changed ? next : s;
    });
  }, [lib.scanning, lib.pendingNewTracks, lib.library]);
  const onFiles = (files) => {
    if (!files || !files.length) return;
    doorUsedRef.current = "drop";
    console.log(`[LIB-V2-METRIC] door-open=drop files=${files.length}`);
    lib.importFiles?.([...files]);
  };

  const DOORS = [
    { id: "scan", title: "Scan my computer", sub: "Music, Downloads, Desktop, Documents", live: true },
    { id: "itunes", title: "iTunes or Apple Music", sub: "Bring your playlists across", live: false },
    { id: "rekordbox", title: "rekordbox", sub: "Your cues and grids, intact", live: true },
    { id: "usb", title: "USB drive", sub: "DJ with a stick? Plug it in", live: false },
    { id: "drop", title: "Drop anything", sub: "Drag files or folders here", live: true },
  ];
  const skip = () => { console.log(`[LIB-V2-METRIC] wizard-skip afterMs=${Math.round(performance.now() - openedAtRef.current)} tracks=${count}`); onClose(); };

  const card = (active) => ({
    textAlign: "left", padding: "16px 18px", borderRadius: 10, cursor: active ? "pointer" : "default",
    background: active ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.015)",
    border: `1px solid ${active ? LINE : "rgba(255,255,255,0.05)"}`, transition: "background .12s, border-color .12s",
  });

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.82)", backdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ width: 720, maxWidth: "100%", maxHeight: "92vh", overflow: "auto", background: PANEL, border: `1px solid ${LINE}`, borderRadius: 16, padding: "32px 34px", fontFamily: "'Inter',sans-serif" }}>
        <div style={{ fontSize: 22, fontWeight: 600, color: W, letterSpacing: -0.2 }}>Where's your music?</div>
        <div style={{ fontSize: 13, color: M, marginTop: 6 }}>Mix//Sync hunts it down. Pick a door — you can add more anytime.</div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 22 }}>
          {DOORS.map(d => (
            <div key={d.id} onClick={() => d.live && setDoor(door === d.id ? null : d.id)} style={card(d.live)}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: d.live ? W : F }}>{d.title}</span>
                {!d.live && <span style={{ fontSize: 10, color: F, letterSpacing: 1, textTransform: "uppercase" }}>Soon</span>}
              </div>
              <div style={{ fontSize: 12, color: d.live ? M : F, marginTop: 4 }}>{d.sub}</div>

              {d.id === "scan" && door === "scan" && (
                <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }} onClick={e => e.stopPropagation()}>
                  {/* One-time framing — users tolerate 30s of setup they never repeat. */}
                  <div style={{ fontSize: 11.5, color: M, marginBottom: 2, lineHeight: 1.45 }}>
                    Your browser asks permission for each folder — one click apiece, about 30 seconds, one time only.
                  </div>
                  {STD.map(f => {
                    const st = folderState[f.key]?.status;
                    const added = folderState[f.key]?.added;
                    const right = st === "scanning" ? "scanning…"
                      : st === "done" ? `✓ ${added ?? 0} track${added === 1 ? "" : "s"}`
                      : st === "skipped" ? "—" : "grant";
                    return (
                      <button key={f.key} onClick={() => scanFolder(f)} disabled={st === "scanning"} style={{
                        display: "flex", justifyContent: "space-between", alignItems: "center",
                        padding: "8px 11px", borderRadius: 7, border: `1px solid ${LINE}`, cursor: st === "scanning" ? "default" : "pointer",
                        background: st === "done" ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.03)", color: W, fontSize: 12, fontFamily: "inherit",
                      }}>
                        <span>{st === "done" ? f.label : `Scan ${f.label}`}</span>
                        <span style={{ color: st === "done" ? W : M, fontSize: 11 }}>{right}</span>
                      </button>
                    );
                  })}
                  {(lib.watchedFolders || []).length > 0 && (
                    <div style={{ fontSize: 11, color: F, marginTop: 2 }}>{(lib.watchedFolders || []).length} folder{(lib.watchedFolders || []).length === 1 ? "" : "s"} already connected — re-scans are deduped, never re-granted.</div>
                  )}
                </div>
              )}

              {d.id === "drop" && door === "drop" && (
                <div onClick={e => e.stopPropagation()}
                  onDragOver={e => { e.preventDefault(); setDropActive(true); }}
                  onDragLeave={() => setDropActive(false)}
                  onDrop={e => { e.preventDefault(); setDropActive(false); onFiles(e.dataTransfer.files); }}
                  style={{ marginTop: 12, padding: "20px 12px", borderRadius: 8, textAlign: "center",
                    border: `1px dashed ${dropActive ? "rgba(255,255,255,0.5)" : LINE}`, background: dropActive ? "rgba(255,255,255,0.05)" : "transparent",
                    color: M, fontSize: 12 }}>
                  Drop audio files here
                  <div style={{ marginTop: 8 }}>
                    <label style={{ color: W, cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 3 }}>
                      or browse
                      <input type="file" multiple accept="audio/*,.mp3,.wav,.flac,.aac,.ogg,.m4a" style={{ display: "none" }} onChange={e => onFiles(e.target.files)} />
                    </label>
                  </div>
                </div>
              )}

              {d.id === "rekordbox" && door === "rekordbox" && (
                <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }} onClick={e => e.stopPropagation()}>
                  {/* The rekordbox importer (database + XML, with the grid/cue
                      parser) lives in the dedicated library app — one parser, one
                      truth. The wizard routes there rather than duplicating it. */}
                  <div style={{ fontSize: 11.5, color: M, lineHeight: 1.45 }}>
                    Bring your rekordbox collection — BPM, beat grids and hot cues import intact and feed the decks directly. The importer opens in your library.
                  </div>
                  <button onClick={() => { console.log("[LIB-V2-METRIC] door-open=rekordbox route=library.html"); window.location.href = "library.html"; }}
                    style={{ padding: "9px 13px", borderRadius: 7, border: `1px solid ${LINE}`, background: "rgba(255,255,255,0.05)", color: W, fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                    Open the rekordbox importer →
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 24, paddingTop: 18, borderTop: `1px solid ${LINE}` }}>
          <div style={{ fontSize: 13, color: count > 0 ? W : F }}>
            {count > 0 ? `Found ${count} track${count === 1 ? "" : "s"}` : "No music yet"}
            {lib.lastImportSummary?.shelved > 0 && <span style={{ color: M }}>  ·  {lib.lastImportSummary.shelved} moved to mixes & recordings</span>}
            {lib.scanning && <span style={{ color: M }}>  ·  scanning…</span>}
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={skip} style={{ padding: "9px 16px", borderRadius: 8, border: `1px solid ${LINE}`, background: "transparent", color: M, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Skip for now</button>
            <button onClick={onClose} style={{ padding: "9px 18px", borderRadius: 8, border: "none", background: count > 0 ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.14)", color: count > 0 ? "#111" : M, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{count > 0 ? "Start mixing" : "Done"}</button>
          </div>
        </div>
      </div>
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
  // Library V2: split Tracks vs Mixes & Recordings. Off → one combined list.
  const [sectionView, setSectionView] = useState("tracks");
  const mixesCount = LIB_WIZARD ? realTracks.filter(t => t.librarySection === "mixes").length : 0;
  const allTracks = LIB_WIZARD
    ? realTracks.filter(t => (t.librarySection === "mixes") === (sectionView === "mixes"))
    : realTracks;
  // First-run wizard (Item 1). Opens once on a fresh/empty library; re-openable
  // via "Add music". Skippable — never blocks the booth. ~900ms grace so the
  // IDB-loaded library doesn't flash the wizard before it populates.
  const [wizardOpen, setWizardOpen] = useState(false);
  const wizardSeenRef = useRef(false);
  useEffect(() => {
    if (!LIB_WIZARD || wizardSeenRef.current) return;
    const t = setTimeout(() => { wizardSeenRef.current = true; if ((lib.library || []).length === 0) { console.log("[LIB-V2-METRIC] wizard-first-run-open"); setWizardOpen(true); } }, 900);
    return () => clearTimeout(t);
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
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
  // Phase 2 — "Review first" modal open/close. State owned by LibraryPanelV2
  // so the modal renders alongside the banner (modal is a fixed overlay).
  const [reviewOpen, setReviewOpen] = useState(false);
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
    if (LIB_WIZARD) { console.log("[LIB-V2-METRIC] wizard-reopen=add-music"); setWizardOpen(true); return; }
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
    <>
    {LIB_WIZARD && wizardOpen && <LibraryWizard lib={lib} onClose={() => setWizardOpen(false)} />}
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
          {/* Phase 1 — only shows once the user has connected at least one
              folder. First-time path goes through the LibraryEmptyState CTA
              in the main panel; this sibling button covers "I want to add
              another music source" without surfacing folder-management UI. */}
          {lib.fsaSupported && lib.watchedFolders.length > 0 && (
            <button
              onClick={() => lib.addWatchedFolder({}).catch(() => {})}
              style={{
                width: "100%", height: 26, background: "transparent", border: "none",
                color: SUBTLE, fontSize: 11, letterSpacing: 0.2, fontFamily: "'Inter',sans-serif",
                borderRadius: 3, cursor: "pointer", textAlign: "left", padding: "0 4px",
                transition: "color .12s",
              }}
              onMouseEnter={e => e.currentTarget.style.color = TEXT}
              onMouseLeave={e => e.currentTarget.style.color = SUBTLE}
            >+ Add another location</button>
          )}
          {/* Phase 2 Commit 4 — manual scan trigger. Same gate as "+ Add
              another location" (visible only once at least one folder is
              connected). Disables itself + shows "Scanning…" while a scan
              is in flight; the existing runLibraryScan re-entry guard makes
              this a strict no-op even if the click happens during the disabled
              state. */}
          {lib.fsaSupported && lib.watchedFolders.length > 0 && (
            <button
              onClick={() => { if (!lib.scanning) lib.runLibraryScan?.().catch(() => {}); }}
              disabled={lib.scanning}
              style={{
                width: "100%", height: 26, background: "transparent", border: "none",
                color: lib.scanning ? MUTED : SUBTLE, fontSize: 11, letterSpacing: 0.2,
                fontFamily: "'Inter',sans-serif",
                borderRadius: 3, cursor: lib.scanning ? "default" : "pointer",
                textAlign: "left", padding: "0 4px",
                transition: "color .12s",
              }}
              onMouseEnter={e => { if (!lib.scanning) e.currentTarget.style.color = TEXT; }}
              onMouseLeave={e => { if (!lib.scanning) e.currentTarget.style.color = SUBTLE; }}
            >{lib.scanning ? "Scanning…" : "Check for new music"}</button>
          )}
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

        {/* V2 section toggle — Tracks vs Mixes & Recordings (long DJ sets/recordings
            auto-shelved out of the track list). Only shown when mixes exist. */}
        {LIB_WIZARD && mixesCount > 0 && (
          <div style={{ display: "flex", gap: 6, padding: "8px 14px 0", alignItems: "center" }}>
            {[{ id: "tracks", label: "Tracks" }, { id: "mixes", label: `Mixes & recordings (${mixesCount})` }].map(s => {
              const active = sectionView === s.id;
              return (
                <div key={s.id} onClick={() => setSectionView(s.id)} style={{
                  padding: "4px 11px", cursor: "pointer", borderRadius: 13,
                  fontSize: 11, fontFamily: "'Inter',sans-serif", letterSpacing: 0.3,
                  color: active ? TEXT : MUTED,
                  background: active ? "rgba(255,255,255,0.09)" : "transparent",
                  border: `1px solid ${active ? "rgba(255,255,255,0.18)" : "transparent"}`,
                  transition: "color .12s, background .12s",
                }}>{s.label}</div>
              );
            })}
          </div>
        )}

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

        {/* Phase 2 — NewTracksBanner. Returns null when there's nothing to
            announce (no pending tracks AND not importing), so this slot is
            visually empty in the steady state. When pending tracks exist
            or commitPendingNewTracks is running, the banner takes over with
            either the action buttons or the live "Importing M of N…" copy. */}
        <NewTracksBanner lib={lib} onReview={() => setReviewOpen(true)} />

        {/* Phase 2 — "Review first" selection modal. Fixed overlay; only
            renders when reviewOpen is true AND pending tracks exist (the
            modal handles its own selection state and closes itself on
            Cancel / Escape / backdrop click / Import). */}
        {reviewOpen && (lib.pendingNewTracks?.length > 0) && (
          <ReviewTracksModal lib={lib} onClose={() => setReviewOpen(false)} />
        )}

        {/* Track list or group list depending on view */}
        <div style={{ flex: 1, overflowY: "auto", padding: "4px 6px" }}>
          {/* Phase 1 redesign (May 29 evening pivot) — the previous
              "Add your music" dashed-border hero with onClick handleAddMusic
              was removed in favor of LibraryEmptyState (rendered below),
              which provides the Connect-your-music CTA plus drag-drop and
              "+ Add music" sidebar paths. The root <div> of LibraryPanelV2
              (line ~1787) owns the global drag-drop handler — drop anywhere
              in the library panel still routes through handleDroppedItems
              → _importFileObjects, unchanged. */}
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
            allTracks.length === 0
              ? <LibraryEmptyState lib={lib}/>
              : <div style={{ padding: 48, textAlign: "center", color: MUTED, fontSize: 12 }}>No tracks match these filters.</div>
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
                {LIB_WIZARD && lib.setTrackSection && (
                  <>
                    <div style={{ height: 1, background: "rgba(255,255,255,0.06)", margin: "4px 0" }}/>
                    <div onClick={() => { lib.setTrackSection(t.id, t.librarySection === "mixes" ? "tracks" : "mixes"); setRowCtxMenu(null); }} onMouseEnter={onHover} onMouseLeave={onLeave} style={itemStyle}>
                      {t.librarySection === "mixes" ? "Move to Tracks" : "Move to Mixes & recordings"}
                    </div>
                  </>
                )}
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
    </>
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
  // Server-generated djId captured from the "joined" payload. Used as the
  // authoritative IDENTITY for driver checks and the phase-error monitor —
  // displayName collisions (two tabs auto-rejoining the same cm_session
  // with the identical persisted name) no longer break driver routing.
  const [djId, setDjId]       = useState(null);
  const pt=useRef(null), cb=useRef(onMsg);
  useEffect(()=>{cb.current=onMsg;},[onMsg]);
  // ── Auto-reconnect state ─────────────────────────────────────
  // A mid-session WS drop (network blip, server restart) used to set status
  // "disconnected" and silently die. Now we re-dial with backoff and re-join
  // the room for up to RECONNECT_WINDOW_MS, then re-pull partner state. The
  // [RECONNECT] log family confesses reason/phase/outcome.
  const lastJoinRef = useRef(null);          // {roomId, djName} for rejoin
  const deliberateRef = useRef(false);       // true = disconnect() asked, suppress reconnect
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectStartRef = useRef(0);
  const connectRef = useRef(null);
  const RECONNECT_WINDOW_MS = 30000;         // give up after ~30s of trying

  // All outbound WS payloads carry t_send (performance.now() at queue time).
  // Receivers ignore unknown fields today (handlers destructure specific
  // keys), so this is backward-safe. Used by the phase-error monitor to
  // estimate partner playhead position accounting for one-way latency.
  const send = useCallback((m) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ ...m, t_send: performance.now() }));
    }
  }, []);

  const connect = useCallback((roomId, djName, isReconnect=false) => {
    const hadOpenSocket = !!ws.current;
    console.log('[JOIN-DIAG] connect() roomId="'+roomId+'" djName="'+djName+'" (closing prior socket='+hadOpenSocket+' reconnect='+isReconnect+')');
    lastJoinRef.current = { roomId, djName };
    deliberateRef.current = false;
    clearTimeout(reconnectTimerRef.current);
    if (!isReconnect) { reconnectAttemptsRef.current = 0; reconnectStartRef.current = 0; }
    if (ws.current) { try { ws.current.onclose = null; } catch {} ws.current.close(); } // suppress the prior socket's close → no spurious reconnect
    setStatus(isReconnect ? "reconnecting" : "connecting"); setConnErr(null);
    try {
      const w = new WebSocket(url); ws.current = w;
      w.onopen = () => {
        // Guard against a torn-down socket (StrictMode double-mount / rapid
        // reconnect) winning a late onopen and sending join on a stale ws.
        if (ws.current !== w) { console.warn('[JOIN-DIAG] onopen on STALE socket roomId="'+roomId+'" — ignoring'); try{w.close();}catch{} return; }
        setStatus("connected");
        logEvent("ws", "connected", { roomCode: roomId });
        if (isReconnect || reconnectAttemptsRef.current > 0) {
          console.log('[RECONNECT] phase=success roomId="'+roomId+'" afterAttempts='+reconnectAttemptsRef.current+' elapsedMs='+(reconnectStartRef.current?Date.now()-reconnectStartRef.current:0));
          logEvent("ws", "reconnected", { roomCode: roomId, attempts: reconnectAttemptsRef.current });
        }
        reconnectAttemptsRef.current = 0; reconnectStartRef.current = 0;
        console.log('[JOIN-DIAG] WS open → send join roomId="'+roomId+'" djName="'+djName+'"');
        w.send(JSON.stringify({ type:"join", roomId, djName }));
        // After a reconnect, re-pull the partner's full current state.
        if (isReconnect) { try { w.send(JSON.stringify({ type:"sync_request", t_send: performance.now() })); } catch {} }
        pt.current = setInterval(() => send({ type:"ping", clientTime:Date.now() }), 3000);
      };
      w.onmessage = (e) => {
        let m; try{m=JSON.parse(e.data);}catch{return;}
        if(m.type==="joined"){
          setPartner(m.partnerName);
          if(m.djId) setDjId(m.djId);
          console.log("[WS-JOINED] djId=" + m.djId + " room=\"" + (m.roomId||m.room||"?") + "\" partner=" + (m.partnerName||"(none)"));
        }
        if(m.type==="partner_joined"){setPartner(m.djName);send({type:"sync_request"});}
        if(m.type==="partner_left")  setPartner(null);
        if(m.type==="pong")          setPing(Date.now()-m.clientTime);
        if(m.type==="error")         setConnErr(m.msg);
        cb.current?.(m);
      };
      w.onerror = () => {
        // Only surface a connection error for the CURRENT socket — a stale
        // socket erroring during a reconnect must not paint "Could not connect"
        // over a healthy live connection (the contradictory CONNECTED + error
        // banner Chad saw on restore came from a torn-down first socket).
        if (ws.current !== w) { console.warn('[JOIN-DIAG] onerror on STALE socket — suppressed'); return; }
        console.warn('[JOIN-DIAG] WS error roomId="'+roomId+'"');
        setStatus("error"); setConnErr("Could not connect to server. Check the URL.");
      };
      w.onclose = (ev) => {
        console.warn('[JOIN-DIAG] WS closed roomId="'+roomId+'" code='+(ev?.code ?? '?')+' reason="'+(ev?.reason||'')+'" wasCurrent='+(ws.current===w));
        logEvent("ws", "disconnected", { roomCode: roomId, reason: ev?.reason || null, code: ev?.code ?? null });
        if (ws.current !== w) return;        // a superseded socket closed — ignore
        clearInterval(pt.current);
        if (deliberateRef.current) { setStatus("disconnected"); return; }
        // Unexpected drop → re-dial with backoff and re-join, up to the window.
        if (!reconnectStartRef.current) reconnectStartRef.current = Date.now();
        const elapsed = Date.now() - reconnectStartRef.current;
        if (elapsed > RECONNECT_WINDOW_MS) {
          console.warn('[RECONNECT] phase=gaveup roomId="'+roomId+'" elapsedMs='+elapsed+' attempts='+reconnectAttemptsRef.current);
          logEvent("ws", "reconnect_gaveup", { roomCode: roomId, attempts: reconnectAttemptsRef.current });
          setStatus("disconnected"); return;
        }
        const attempt = ++reconnectAttemptsRef.current;
        const delay = Math.min(8000, 500 * Math.pow(2, attempt - 1)); // 0.5,1,2,4,8s…
        console.warn('[RECONNECT] phase=schedule roomId="'+roomId+'" attempt='+attempt+' delayMs='+delay+' code='+(ev?.code ?? '?'));
        setStatus("reconnecting");
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = setTimeout(() => {
          console.warn('[RECONNECT] phase=attempt roomId="'+roomId+'" attempt='+attempt);
          connectRef.current?.(roomId, djName, true);
        }, delay);
      };
    } catch(e) {
      setStatus("error"); setConnErr("Invalid server URL.");
    }
  }, [url, send]);
  connectRef.current = connect;

  const disconnect = useCallback(() => {
    deliberateRef.current = true;            // suppress auto-reconnect on this close
    clearTimeout(reconnectTimerRef.current);
    ws.current?.close(); clearInterval(pt.current); setPartner(null); setDjId(null);
    setStatus("disconnected");
  }, []);

  useEffect(()=>()=>{ deliberateRef.current = true; clearTimeout(reconnectTimerRef.current); ws.current?.close(); clearInterval(pt.current); },[]);
  // Sleep/wake + network-restore liveness. On laptop sleep the socket dies but
  // onclose may not fire until wake; the OS may also restore the network without
  // a clean close. When the tab becomes visible or the browser reports online,
  // if we have an active room and the socket isn't OPEN, re-dial immediately
  // (honest behavior: rejoin cleanly beats pretending nothing happened). The
  // onclose backoff path covers the case where the close DID fire.
  useEffect(() => {
    const wake = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const j = lastJoinRef.current;
      if (!j || deliberateRef.current) return;
      const open = ws.current && ws.current.readyState === WebSocket.OPEN;
      if (!open) {
        console.warn('[RECONNECT] phase=wake — visible/online with dead socket, re-dialing room="'+j.roomId+'"');
        if (!reconnectStartRef.current) reconnectStartRef.current = Date.now();
        connectRef.current?.(j.roomId, j.djName, true);
      }
    };
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => { window.removeEventListener("online", wake); document.removeEventListener("visibilitychange", wake); };
  }, []);
  // Test-only: drop the socket as if the network blipped (NOT deliberate, so
  // the auto-reconnect path runs). Exposed via the smoke hook behind TEST_HOOKS.
  const forceDrop = useCallback(() => { console.warn('[RECONNECT] phase=forced-drop (test)'); try { ws.current?.close(); } catch {} }, []);
  return { status, partner, ping, connErr, djId, send, connect, disconnect, forceDrop };
}

// ── WebRTC ───────────────────────────────────────────────────
function useRTC({ engineRef, send, onIceRecover }) {
  const [state, setState] = useState("idle");
  const [muted, setMuted] = useState(false);
  const [remVol, setRemVol] = useState(0.85);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const pc=useRef(null),dest=useRef(null),remAudio=useRef(null),pend=useRef([]),sRef=useRef(send);
  useEffect(()=>{sRef.current=send;},[send]);
  // ICE-failure recovery: a network change (wifi switch, sleep/wake) can drop
  // ICE to "disconnected" (often self-heals) or "failed" (dead). Previously
  // "failed" only painted state — nothing renegotiated. Now we call onIceRecover
  // so the App can trigger an initiator-gated ICE restart over the (auto-
  // reconnected) WS. "disconnected" gets a grace timer first.
  const onIceRecoverRef = useRef(onIceRecover);
  useEffect(()=>{ onIceRecoverRef.current = onIceRecover; }, [onIceRecover]);
  const iceDiscTimerRef = useRef(null);

  // ── RTC receive-delay measurement (Gap #4 monitoring compensation) ──
  // Poll the inbound audio jitter-buffer + playout delay so CollabMix can delay
  // the LOCAL deck monitor to land with this (jitter-buffered) partner stream.
  // Delta-based (recent average, not lifetime) so it tracks the buffer adapting.
  // Always measures when connected (cheap); APPLYING the delay is gated by
  // ?delaycomp=1 in CollabMix. compRef.compMs = jitterBuffer + playout delay.
  const compRef = useRef({ jbMs:0, playoutMs:0, targetMs:null, compMs:0, rttMs:null, settleUntil:0, ts:0 });
  const prevStatsRef = useRef(null);
  // A transport event (play/pause/seek/engage — local OR partner's) can interrupt
  // the inbound stream and make the jitter buffer re-converge to a new delay.
  // CollabMix calls this so the next poll RE-BASELINES instead of averaging a
  // stale value across the discontinuity. Also auto-detected below (counter reset
  // / emit-rate collapse) so it self-heals even without the hook.
  const transportEventRef = useRef(0);
  const markTransportEvent = useCallback(()=>{ transportEventRef.current = Date.now(); }, []);
  const lastTrackRef = useRef(null), healthRef = useRef(0);
  useEffect(()=>{
    if(state!=="connected") return;
    let stop=false;
    const SAMPLE_HZ = 48000; // Opus
    const HEALTH_MIN = 4;    // consecutive healthy windows before trusting a value
    const poll=async()=>{
      const p=pc.current; if(!p||stop) return;
      try{
        // Bind to the CURRENT live audio receiver every tick. On renegotiation
        // (partner refresh / transport / track replace) Chrome makes a NEW
        // receiver; polling pc.getStats() and last-wins could read the DEAD one
        // → jb=0/playout=0 forever → applied slewed to 0 → double kick never
        // recovers. getReceivers() always returns the live receiver; scope
        // getStats() to it so dead inbound reports can't poison the read.
        // Prefer a LIVE audio receiver (ended tracks from prior negotiations can
        // linger). Among live ones, the most recent is the active receiver.
        const recvs = (p.getReceivers?.()||[]).filter(r=>r.track && r.track.kind==="audio" && r.track.readyState==="live");
        const recv = recvs[recvs.length-1] || null;
        if(!recv){ healthRef.current=0; compRef.current={ ...compRef.current, noFrames:true }; return; }
        if(recv.track.id !== lastTrackRef.current){
          // Rebind: new receiver/track. Re-baseline; keep last good compMs.
          lastTrackRef.current = recv.track.id;
          prevStatsRef.current = null; healthRef.current = 0;
          compRef.current = { ...compRef.current, settleUntil: Date.now()+4000 };
          console.log("[SYNC-COMP] rebind → live receiver track=" + recv.track.id.slice(0,8));
        }
        const stats=await recv.getStats();
        let inb=null, play=null, rem=null;
        stats.forEach(r=>{
          if(r.type==="inbound-rtp"&&r.kind==="audio")inb=r;
          if(r.type==="media-playout")play=r;
          if(r.type==="remote-inbound-rtp"&&r.kind==="audio")rem=r;
        });
        // No measurable frames (silent/empty inbound — e.g. partner has no deck
        // loaded) → HOLD last good compMs (never follow to 0) and flag noFrames
        // so telemetry shows "no inbound frames" instead of a masking measured=0.
        if(!inb || !(inb.jitterBufferEmittedCount>0)){ healthRef.current=0; compRef.current={ ...compRef.current, noFrames:true }; return; }
        const now=Date.now();
        const prev=prevStatsRef.current;
        const emitted=inb.jitterBufferEmittedCount;
        const dEmit = prev ? emitted - prev.jbe : 0;
        const dt    = prev ? (now - prev.ts)/1000 : 0;
        const flowing = prev ? dEmit > 0.5*(dt*SAMPLE_HZ) : false;
        const transportSince = prev ? transportEventRef.current > prev.ts : true;
        // Discontinuity (first / counter reset / not flowing / transport) →
        // re-baseline, reset health, HOLD last good compMs (do NOT write 0).
        if(!prev || emitted < prev.jbe || !flowing || transportSince){
          prevStatsRef.current = { jbd:inb.jitterBufferDelay, jbe:emitted,
            ppd:play?play.totalPlayoutDelay:0, psc:play?play.totalSamplesCount:0, ts:now };
          healthRef.current = 0;
          compRef.current = { ...compRef.current, settleUntil: now + 4000, noFrames:false };
          return;
        }
        // Flowing window → candidate recent-average delta (never lifetime mean).
        const jbMs = ((inb.jitterBufferDelay - prev.jbd)/dEmit)*1000;
        let playoutMs = compRef.current.playoutMs || 0;
        if(play && prev.psc!=null && play.totalSamplesCount>prev.psc){
          playoutMs = ((play.totalPlayoutDelay - prev.ppd)/(play.totalSamplesCount - prev.psc))*1000;
        }
        const cand = Math.max(0,(jbMs||0)+(playoutMs||0));
        prevStatsRef.current = { jbd:inb.jitterBufferDelay, jbe:emitted,
          ppd:play?play.totalPlayoutDelay:0, psc:play?play.totalSamplesCount:0, ts:now };
        healthRef.current += 1;
        // Require sustained healthy flow before trusting; a big DROP needs extra
        // confirmation so a refill transient / spurious-low never zeroes comp.
        const lastGood = compRef.current.compMs || 0;
        const bigDrop = lastGood>5 && cand < 0.5*lastGood;
        const need = bigDrop ? HEALTH_MIN+3 : HEALTH_MIN;
        if(healthRef.current < need){ compRef.current = { ...compRef.current, settleUntil: Math.max(compRef.current.settleUntil, now+1500), noFrames:false }; return; }
        const targetMs = inb.jitterBufferTargetDelay!=null ? (inb.jitterBufferTargetDelay/emitted)*1000 : null;
        const rttMs = rem&&rem.roundTripTime!=null?rem.roundTripTime*1000:null;
        compRef.current = { jbMs, playoutMs, targetMs, compMs:cand, rttMs,
          settleUntil: compRef.current.settleUntil, ts:now, noFrames:false };
      }catch{ /* getStats can throw mid-teardown */ }
    };
    const iv=setInterval(poll,700); poll();
    return ()=>{ stop=true; clearInterval(iv); };
  },[state]);

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
      if(s==="connected"||s==="completed"){
        setState("connected");
        clearTimeout(iceDiscTimerRef.current); iceDiscTimerRef.current=null; // recovered
      }
      if(s==="failed"){
        setState("failed");
        console.warn('[RTC-RECOVER] phase=ice-failed → requesting renegotiation');
        clearTimeout(iceDiscTimerRef.current); iceDiscTimerRef.current=null;
        onIceRecoverRef.current?.("failed");
      }
      if(s==="disconnected"){
        // Often transient — give it a grace window to self-heal before forcing
        // a restart. If still not connected after 6s, recover.
        clearTimeout(iceDiscTimerRef.current);
        iceDiscTimerRef.current=setTimeout(()=>{
          const cur=pc.current?.iceConnectionState;
          if(cur==="disconnected"||cur==="failed"){
            console.warn('[RTC-RECOVER] phase=ice-disconnected-timeout ('+cur+') → requesting renegotiation');
            onIceRecoverRef.current?.("disconnected-timeout");
          }
        },6000);
      }
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

  // NOTE: deliberately NO global "any click resumes partner audio" handler.
  // It made an UNRELATED gesture (e.g. a deck pause/play click) silently start
  // the partner-audio element — on a one-machine two-browser test that surfaced
  // as a permanent "double kick" (local deck + the other browser's speakers),
  // and it's dishonest UX. Partner audio now starts ONLY via the explicit
  // "enable partner audio" control (enablePartnerAudio), surfaced when blocked.

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
  return { state, muted, remVol, setRemVol, autoplayBlocked, startCall, endCall, toggleMute, handleRtc, compRef, markTransportEvent, enablePartnerAudio: tryPlayRemote };
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

// Sync Phase 1 debug HUD. Tiny mono overlay shown when ?syncdebug=1 is
// in the URL. Reads its state from a ref (no per-tick re-render storm)
// and polls at 5 Hz for display refresh. Removable in production — gated
// behind URL param so it never lights up for real users.
function SyncDebugHUD({ statsRef }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => tick((t) => t + 1), 200);
    return () => clearInterval(iv);
  }, []);
  const s = statsRef.current || {};
  const fmt = (v, digits = 1, unit = "") => v == null ? "—" : v.toFixed(digits) + unit;
  return (
    <div style={{
      position: "fixed", top: 8, right: 8, zIndex: 99999,
      background: "rgba(0,0,0,0.72)", color: "rgba(255,255,255,0.88)",
      border: "1px solid rgba(255,255,255,0.12)", borderRadius: 4,
      padding: "8px 10px", minWidth: 220,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 10, lineHeight: 1.55, letterSpacing: 0.2,
      pointerEvents: "none", opacity: 0.85,
    }}>
      <div style={{ opacity: 0.55, marginBottom: 4 }}>SYNC DEBUG</div>
      <div>offset    {fmt(s.offset, 2, " ms")}</div>
      <div>rtt med   {fmt(s.rttMedian, 0, " ms")}</div>
      <div>rtt sprd  {fmt(s.rttSpread, 0, " ms")}</div>
      <div>conf      {fmt(s.confidence, 2)}</div>
      <div>samples   {s.sampleCount ?? 0}</div>
      <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)", marginTop: 4, paddingTop: 4 }}>
        drift     {fmt(s.phaseErrorMs, 2, " ms")}
      </div>
      <div>engage   {fmt(s.msSinceEngage != null ? s.msSinceEngage / 1000 : null, 1, " s")}</div>
      <div style={{ opacity: 0.55 }}>state    {s.monitorReason || "idle"}</div>
      <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)", marginTop: 4, paddingTop: 4 }}>
        comp meas {s.compNoFrames ? "no inbound frames" : fmt(s.compMeasuredMs, 1, " ms")}
      </div>
      <div style={{ opacity: 0.7 }}>· jb={fmt(s.compJbMs, 0)} play={fmt(s.compPlayoutMs, 0)}</div>
      <div>comp appl {fmt(s.compAppliedMs, 1, " ms")} {s.compOn ? "(on)" : "(off)"}</div>
      {s.myDeck && s.partnerDeck && (
        <div style={{ opacity: 0.55 }}>me={s.myDeck} / them={s.partnerDeck}</div>
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

function WF({ bands, peaks, freq, prog, onSeek, h=80, hotCues=[], loopStart=null, loopEnd=null, loopActive=false, bpm=null, dur=0, beatPhaseFrac=null, color='#ffffff', analyzing=false, beatTimes=null, beatAttacks=null }) {
  const ref=useRef(null);
  // Step B: per-track envelope-percentile cache. 5th and 95th percentiles
  // of the combined env (max of bass/mid/high) across the full source
  // array — normalization stretches that [envFloor, envCeil] band to [0,1]
  // so dense tracks read with the same dynamic range as dynamic tracks.
  // Cache keys on bArr (Float32Array reference, stable across renders)
  // rather than the wrapper bands object literal which the parent rebuilds
  // every render. Soft-clip (tanh) variant was tried and reverted — looked
  // like uniform tubes on both dense AND dynamic tracks.
  const envNormRef=useRef({bArr:null,envFloor:0,envCeil:1});
  // Inner-core kick-presence cache. Median of non-zero beatAttacks values
  // (track-relative reference for normalizing per-beat kick strength).
  // Keyed on the beatAttacks Float32Array reference.
  const kickCacheRef=useRef({beatAttacks:null,median:0});
  // Phase 1 Tier 6: responsive density. ResizeObserver bumps resizeTick whenever
  // the canvas's CSS dimensions change, which retriggers the main draw effect at
  // the new physical width. Previously the WF rendered once at mount and never
  // re-binned on viewport resize.
  const [resizeTick,setResizeTick]=useState(0);
  useEffect(()=>{
    if(!ref.current)return;
    const ro=new ResizeObserver(()=>setResizeTick(t=>t+1));
    ro.observe(ref.current);
    return ()=>ro.disconnect();
  },[]);
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
      // Slice A polish #1 (kept): peak height capped at PEAK_HEIGHT_RATIO of
      // the available half-canvas so the silhouette sits with visible
      // breathing room above and below instead of touching the canvas edges.
      // At h=40, 0.85 leaves ~3 css px padding on each side.
      const PEAK_HEIGHT_RATIO=0.85;
      const center=H/2;
      const maxH=(H/2)*PEAK_HEIGHT_RATIO;
      // Phase 1 Tier 2: gamma was 1.4 → 0.9 (Slice A) → 0.7 (Path Conservative).
      // GAMMA=0.7 keeps breakdowns visible at h=40 (env=0.1 → ~3.4 px tall);
      // LIFT pushes drops (env>0.8) extra height on top of the gamma curve so
      // drops "punch" above verses without raising the verse floor. Scaled
      // down from big WF's 0.7/0.35 — small WF respects "calmer at small size"
      // locked design intent.
      const GAMMA=0.7;
      // DIM_GAMMA lifts quiet sections inside kick-out regions (breakdowns,
      // no-kick intros/outros). Bright (kick-present) columns render at the
      // standard GAMMA; dim columns use heightsDim[x] computed below, so a
      // breakdown's envelope shape stays readable instead of collapsing to a
      // sliver. Single-knob tuning — DIM_GAMMA<GAMMA lifts, ==GAMMA matches
      // pre-change behavior.
      const DIM_GAMMA=0.55;
      // Run-length filter knobs (FIX — morphological cleanup on kickClass).
      // Refiner skips ~23/834 beats on dense tracks; a single skipped beat
      // inside a kick region cuts a 1-column dim slit. Real kick-out
      // sections are ≥4 bars. Minimum run lengths are expressed in BARS so
      // they scale across short/long tracks; converted to columns at render
      // time using bpm + dur. Clamped to safe pixel ranges for outliers.
      // Fallback values fire when bpm is unavailable (analyzing or failed).
      const MIN_DIM_RUN_BARS=4,    MIN_DIM_RUN_FALLBACK=5;
      const MIN_BRIGHT_RUN_BARS=2, MIN_BRIGHT_RUN_FALLBACK=3;
      // Diagnostic console output for the env / normalization pipeline
      // (samples raw env, normalized, heightPx at 9 fixed track positions
      // on every fresh bArr ref). Off by default — flip to true to debug
      // height extraction or per-track normalization regressions.
      const WF_DIAG=false;
      // Lift removed: every variant (0.7/0.35, 0.8/0.18, 0.85/0.10) produced
      // the same flat-top "border outline" symptom on sustained loud sections
      // at h=40. Adjacent columns near maxH lit up Fill 1's peak-tip stop as a
      // continuous bright line — works on big WF because halo softens it,
      // breaks on small WF without halo. Per-track normalization (below) now
      // carries the dynamic-range work; gamma 0.7 still shapes the curve.

      // Step B percentile pre-pass. Recompute envFloor/envCeil only when
      // the underlying Float32Array reference changes — cache hit on every
      // subsequent render of the same track.
      let logThisRender=false;
      if(envNormRef.current.bArr!==bArr){
        const srcLen=bArr.length;
        const envArr=new Float32Array(srcLen);
        for(let i=0;i<srcLen;i++){
          const bv=bArr[i]||0;
          const mv=mArr?mArr[i]||0:0;
          const hv=hArr?hArr[i]||0:0;
          envArr[i]=hv;
        }
        envArr.sort();
        envNormRef.current={
          bArr,
          envFloor:envArr[Math.floor(srcLen*0.05)],
          envCeil: envArr[Math.floor(srcLen*0.95)],
        };
        if(WF_DIAG) logThisRender=true;
      }
      const {envFloor,envCeil}=envNormRef.current;
      const envRange=Math.max(0.0001,envCeil-envFloor);

      const heights=new Float32Array(W);
      // Parallel envelope height array using DIM_GAMMA (gentler curve) for
      // kick-out columns — see FIX 2 above. Indexing matches heights[].
      const heightsDim=new Float32Array(W);
      // Diagnostic sampling — fills as the height loop runs so we can log
      // raw env / normalized / hVal at fixed track positions on track load.
      const diagPcts=[0.05,0.15,0.25,0.35,0.50,0.65,0.75,0.85,0.95];
      const diagSamples=logThisRender?diagPcts.map(()=>null):null;
      for(let x=0;x<W;x++){
        const i0=Math.floor(x*len/W), i1=Math.min(len-1,Math.floor((x+1)*len/W));
        let bv=0,mv=0,hv=0;
        for(let k=i0;k<=i1;k++){
          const bk=bArr[k]||0; if(bk>bv)bv=bk;
          const mk=mArr?mArr[k]||0:0; if(mk>mv)mv=mk;
          const hk=hArr?hArr[k]||0:0; if(hk>hv)hv=hk;
        }
        const env=hv;
        if(env<=0){heights[x]=0;heightsDim[x]=0;continue;}
        const normalized=Math.max(0,Math.min(1,(env-envFloor)/envRange));
        let hVal=Math.pow(normalized,GAMMA)*maxH;
        if(env>0.02&&hVal<1.5) hVal=1.5;
        heights[x]=hVal<maxH?hVal:maxH;
        let hValDim=Math.pow(normalized,DIM_GAMMA)*maxH;
        if(env>0.02&&hValDim<1.5) hValDim=1.5;
        heightsDim[x]=hValDim<maxH?hValDim:maxH;
        if(diagSamples){
          for(let di=0;di<diagPcts.length;di++){
            if(diagSamples[di]===null){
              const targetX=Math.floor(diagPcts[di]*W);
              if(x===targetX){
                diagSamples[di]={
                  pct:(diagPcts[di]*100).toFixed(0)+'%',
                  x,
                  env:+env.toFixed(3),
                  normalized:+normalized.toFixed(3),
                  heightPx:+heights[x].toFixed(2),
                };
              }
            }
          }
        }
      }
      if(logThisRender){
        console.log('[WF-DIAG]',{
          color,
          W,
          maxH:+maxH.toFixed(2),
          envFloor:+envFloor.toFixed(3),
          envCeil:+envCeil.toFixed(3),
          envRange:+envRange.toFixed(3),
          samples:diagSamples,
        });
      }

      // Parse color → rgb.
      const c=color||'#ffffff';
      let r=255,g=255,b=255;
      if(c.length>=7&&c[0]==='#'){
        r=parseInt(c.slice(1,3),16)|0;
        g=parseInt(c.slice(3,5),16)|0;
        b=parseInt(c.slice(5,7),16)|0;
      }

      // Analyzing dim is folded into every alpha so re-analysis of an already-
      // loaded track reads as provisional data without globalAlpha thrash.
      const a=(alpha)=>analyzing?alpha*0.4:alpha;

      const splitPos=Math.max(0.001,Math.min(0.999,px/W));

      // ── PER-COLUMN SHAPE SELECT ──────────────────────────────────────────
      // Per column x → nearest analyzer beat k → strength = beatAttacks[k].
      // Where the analyzer found a kick (strength > 0), the rendered shape
      // is the CORE: normalizedStrength × envH × 0.9 — punchy kick-driven
      // height. Where the analyzer found no kick (strength === 0) or x falls
      // before first / after last beat, the rendered shape is the ENVELOPE:
      // the full hv envelope height (heights[x]).
      //
      // Heights ramp linearly across kick-in/out boundaries (5-tap moving
      // average) so the silhouette has no vertical cliff. Brightness is a
      // binary step at the exact class boundary — bright class fills with
      // full Step A alphas, dim class fills at ~37.5% of those alphas. The
      // shape is ONE silhouette path; per-column 1-px-wide fillRects inside
      // a single ctx.clip(silhouettePath) deliver per-column brightness with
      // zero overlap haze.
      //
      // Guard: pre-change track results lack beatTimes/beatAttacks → fall
      // through to the original two-fill envelope render at full brightness
      // (pre-kick visual behavior).
      const hasKickData=beatTimes&&beatAttacks&&beatTimes.length>=2&&dur>0;
      let renderHeights=heights, kickClass=null;
      if(hasKickData){
        if(kickCacheRef.current.beatAttacks!==beatAttacks){
          const nz=[];
          for(let i=0;i<beatAttacks.length;i++){if(beatAttacks[i]>0)nz.push(beatAttacks[i]);}
          nz.sort((a,b)=>a-b);
          kickCacheRef.current={
            beatAttacks,
            median:nz.length?nz[nz.length>>1]:0,
          };
        }
        const median=kickCacheRef.current.median;
        if(median>0){
          const targetH=new Float32Array(W);
          const maxStrengthArr=new Float32Array(W);
          kickClass=new Uint8Array(W);
          // FIX 1 — At W=264 / ~600 beats, every column spans ~2-3 beats.
          // Nearest-beat lookup let a single refinement-skipped beat
          // (strength=0) blank a column inside an otherwise solid kick
          // region. The fix: per column, take the MAX of beatAttacks over
          // ALL beats whose beatTime falls within the column's time span.
          // Any kick in the span makes the column read as kick-present.
          // Running pointer over the sorted beatTimes (no per-column search).
          //
          // No explicit tFirst/tLast check needed: columns whose span
          // contains no beats naturally collect maxStrength=0 → dim class.
          //
          // Phase 1 — build raw kickClass + record per-column maxStrength.
          let k=0;
          for(let x=0;x<W;x++){
            const tStart=(x/W)*dur;
            const tEnd=((x+1)/W)*dur;
            while(k<beatTimes.length&&beatTimes[k]<tStart)k++;
            let maxStrength=0;
            let j=k;
            while(j<beatTimes.length&&beatTimes[j]<tEnd){
              const s=beatAttacks[j];
              if(s>maxStrength)maxStrength=s;
              j++;
            }
            maxStrengthArr[x]=maxStrength;
            kickClass[x]=maxStrength>0?1:0;
          }

          // Phase 2 — morphological cleanup. Short dim runs are slits from
          // individually skipped beats inside a real kick region; short
          // bright runs are stray kicks inside an otherwise quiet section.
          // Thresholds in BARS, converted to columns via bpm + dur. Order
          // matters: absorb short dim runs first, then prune short bright
          // runs — a dim-flip can join two bright runs into one long bright
          // run that survives the bright-prune step.
          let minDimRun, minBrightRun;
          if(bpm&&bpm>0&&dur>0){
            const barSec=4*60/bpm;
            const colsPerBar=W*barSec/dur;
            minDimRun=Math.ceil(MIN_DIM_RUN_BARS*colsPerBar);
            if(minDimRun<3)minDimRun=3;else if(minDimRun>12)minDimRun=12;
            minBrightRun=Math.ceil(MIN_BRIGHT_RUN_BARS*colsPerBar);
            if(minBrightRun<2)minBrightRun=2;else if(minBrightRun>8)minBrightRun=8;
          } else {
            minDimRun=MIN_DIM_RUN_FALLBACK;
            minBrightRun=MIN_BRIGHT_RUN_FALLBACK;
          }
          // Flip short dim runs → bright.
          for(let i=0;i<W;){
            if(kickClass[i]===0){
              const runStart=i;
              while(i<W&&kickClass[i]===0)i++;
              if(i-runStart<minDimRun){
                for(let x=runStart;x<i;x++)kickClass[x]=1;
              }
            } else i++;
          }
          // Flip short bright runs → dim.
          for(let i=0;i<W;){
            if(kickClass[i]===1){
              const runStart=i;
              while(i<W&&kickClass[i]===1)i++;
              if(i-runStart<minBrightRun){
                for(let x=runStart;x<i;x++)kickClass[x]=0;
              }
            } else i++;
          }

          // Phase 3 — fill targetH from cleaned kickClass + maxStrengthArr.
          // Flipped columns: a dim→bright flip has maxStrength=0 → norm=0
          // → coreH=0; the 0.35×envH floor kicks in and the column reads as
          // a weak fill-in inside the kick region. A bright→dim flip uses
          // the lifted DIM_GAMMA envelope height like any other kick-out
          // column.
          for(let x=0;x<W;x++){
            if(kickClass[x]===0){
              targetH[x]=heightsDim[x];
            } else {
              const envH=heights[x];
              let norm=maxStrengthArr[x]/median;
              if(norm>1)norm=1;else if(norm<0)norm=0;
              const coreH=norm*envH*0.9;
              const floor=0.35*envH;
              targetH[x]=floor>coreH?floor:coreH;
            }
          }
          // 5-tap moving average smooths the coreH↔envH height transition
          // across ~3 columns so the boundary reads as a soft swell rather
          // than a vertical cliff.
          const smoothH=new Float32Array(W);
          for(let x=0;x<W;x++){
            let s=0,cnt=0;
            for(let d=-2;d<=2;d++){
              const xi=x+d;
              if(xi>=0&&xi<W){s+=targetH[xi];cnt++;}
            }
            smoothH[x]=s/cnt;
          }
          renderHeights=smoothH;
        } else {
          // No non-zero strengths resolved → treat as no kick data.
          kickClass=null;
        }
      }

      // Phase 1 Tier 1: buildSilhouettePath replaces the inline path-building.
      const silhouettePath=buildSilhouettePath(renderHeights,center,W,maxH);

      if(!kickClass){
        // Guard path — original two-fill render at full brightness.
        // Fill 1: vertical bright-at-center gradient.
        const baseGrad=ctx.createLinearGradient(0,center-maxH,0,center+maxH);
        baseGrad.addColorStop(0,   `rgba(${r},${g},${b},${a(0.25)})`);
        baseGrad.addColorStop(0.5, `rgba(${r},${g},${b},${a(0.65)})`);
        baseGrad.addColorStop(1,   `rgba(${r},${g},${b},${a(0.25)})`);
        ctx.fillStyle=baseGrad;
        ctx.fill(silhouettePath);
        // Fill 2: horizontal played/unplayed sweep.
        const sweep=ctx.createLinearGradient(0,0,W,0);
        sweep.addColorStop(0,        `rgba(${r},${g},${b},${a(0.30)})`);
        sweep.addColorStop(splitPos, `rgba(${r},${g},${b},${a(0.30)})`);
        sweep.addColorStop(splitPos, `rgba(${r},${g},${b},${a(0.10)})`);
        sweep.addColorStop(1,        `rgba(${r},${g},${b},${a(0.10)})`);
        ctx.fillStyle=sweep;
        ctx.fill(silhouettePath);
      } else {
        // Kick-data path — clip to silhouette, per-column 1-px fillRect
        // with one of 4 precomputed composite gradients. Each gradient
        // pre-composes the vertical bright-at-center alphas (0.25/0.65/0.25)
        // with the played/unplayed horizontal boost (+0.30 played, +0.10
        // unplayed) via source-over math, then optionally × 0.375 for the
        // dim class. Source-over composite: outA = vert + horiz × (1 − vert).
        const DIM=0.375;
        const mkV=(a0,a05,a1)=>{
          const gr=ctx.createLinearGradient(0,center-maxH,0,center+maxH);
          gr.addColorStop(0,   `rgba(${r},${g},${b},${a(a0)})`);
          gr.addColorStop(0.5, `rgba(${r},${g},${b},${a(a05)})`);
          gr.addColorStop(1,   `rgba(${r},${g},${b},${a(a1)})`);
          return gr;
        };
        const brightPlayed   =mkV(0.475,      0.755,      0.475);
        const brightUnplayed =mkV(0.325,      0.685,      0.325);
        const dimPlayed      =mkV(0.475*DIM,  0.755*DIM,  0.475*DIM);
        const dimUnplayed    =mkV(0.325*DIM,  0.685*DIM,  0.325*DIM);

        ctx.save();
        ctx.clip(silhouettePath);
        let curStyle=null;
        for(let x=0;x<W;x++){
          const style=kickClass[x]
            ?(x<px?brightPlayed:brightUnplayed)
            :(x<px?dimPlayed:dimUnplayed);
          if(style!==curStyle){ctx.fillStyle=style;curStyle=style;}
          ctx.fillRect(x,0,1,H);
        }
        ctx.restore();
      }

      // Minute time markers — 1 CSS px tick every 60 s of track time.
      // Position y in [32, 36] at h=40: above the silhouette's nominal
      // bottom edge (y=37 at PEAK_HEIGHT_RATIO=0.85) without touching it,
      // and above the canvas bottom edge (y=40) so the deck card's
      // beatgrid row has visible separation below.
      if(dur>=60){
        const tickHeight=4;
        const tickY=H-tickHeight-4;
        ctx.fillStyle=`rgba(255,255,255,${a(0.50)})`;
        for(let t=60;t<dur;t+=60){
          const mx=(t/dur)*W;
          ctx.fillRect(mx,tickY,1,tickHeight);
        }
      }

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
    } else if(analyzing){
      // Phase 1 Tier 7 — loading / analyzing state with no bands yet.
      // Subtle horizontal gradient hairline at the centerline. Reads as
      // "something is happening" without spinner / motion / chrome.
      const cy=H/2;
      const grad=ctx.createLinearGradient(0,0,W,0);
      grad.addColorStop(0,   "rgba(255,255,255,0.04)");
      grad.addColorStop(0.5, "rgba(255,255,255,0.14)");
      grad.addColorStop(1,   "rgba(255,255,255,0.04)");
      ctx.fillStyle=grad;
      ctx.fillRect(0,cy-0.5,W,1);
    } else {
      // Phase 1 Tier 7 — empty state. Centered thin neutral-gray line
      // (was a 1-px line at the BOTTOM of the canvas — looked like a stray
      // border, not an intentional empty deck affordance).
      const cy=H/2;
      ctx.fillStyle="rgba(156,163,175,0.20)";
      ctx.fillRect(0,cy-0.5,W,1);
    }
  },[bands,peaks,freq,prog,hotCues,loopStart,loopEnd,loopActive,bpm,dur,beatPhaseFrac,color,analyzing,resizeTick,h,beatTimes,beatAttacks]);

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

function AnimatedZoomedWF({ bands, dur, progRef, onSeek, h=96, windowSec=8, beatPhaseFrac=null, beatPeriodSec=null, gridOffsetMs=0, barOneOffsetSec=0, deckColor="#FFFFFF", rate=1, beatTimes=null, beatsV2=false, desmear=false, isDriver=true, deckId=null }) {
  // Path A glow tuning. Lower canvas renders a single solid-fill silhouette
  // and gets CSS filter:blur applied via inline style; the browser composites
  // the blur on the GPU. Tune visually by adjusting these three values.
  const LOWER_CANVAS_BLUR_PX = 20;             // CSS blur radius on the lower canvas
  const LOWER_CANVAS_OPACITY = 0.55;           // opacity multiplier on the lower canvas
  const SILHOUETTE_FILL_ALPHA = 1.0;           // alpha of the silhouette fill (pre-blur)
  const UPPER_CANVAS_SILHOUETTE_ALPHA = 1.0;   // alpha of the crisp body on the upper canvas

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
  const beatTimesRef=useRef(beatTimes);
  const beatsV2Ref=useRef(beatsV2);
  const desmearRef=useRef(desmear);
  useEffect(()=>{beatTimesRef.current=beatTimes;},[beatTimes]);
  useEffect(()=>{beatsV2Ref.current=beatsV2;},[beatsV2]);
  useEffect(()=>{desmearRef.current=desmear;},[desmear]);
  useEffect(()=>{gridOffsetMsRef.current=gridOffsetMs;},[gridOffsetMs]);
  useEffect(()=>{barOneOffsetSecRef.current=barOneOffsetSec;},[barOneOffsetSec]);
  useEffect(()=>{deckColorRef.current=deckColor;},[deckColor]);
  // role (local|mirror) + deck label for the smoothdiag log.
  const isDriverRef=useRef(isDriver);
  const deckIdRef=useRef(deckId);
  useEffect(()=>{isDriverRef.current=isDriver;},[isDriver]);
  useEffect(()=>{deckIdRef.current=deckId;},[deckId]);

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

    // Render-starvation diagnostic (?mirrordiag=1). Measures the draw RAF's own
    // cadence: if the main thread is starved (the load theory), fps drops + the
    // worst frame gap spikes — which makes BOTH this deck's and the mirror's
    // waveforms stutter even when the interp output (progRef) is correct.
    let _fLast=0,_fN=0,_fAcc=0,_fWorst=0,_fLogAt=0;
    // smoothdiag accumulators (last-second window, reset on each log).
    let _sLast=0,_sPrevProg=null,_sFrames=0,_sDtSum=0,_sDtMax=0,_sDropped=0,
        _sScrollSum=0,_sScrollSqSum=0,_sScrollMax=0,_sZero=0,_sMove=0,
        _sDrawSum=0,_sDrawMax=0,_sLogAt=0;
    const draw=()=>{
      raf.current=requestAnimationFrame(draw);
      const _sT0=SMOOTH_DIAG?performance.now():0;
      if(MIRROR_DIAG){
        const _tn=performance.now();
        if(_fLast){ const _dt=_tn-_fLast; _fN++; _fAcc+=_dt; if(_dt>_fWorst)_fWorst=_dt; }
        _fLast=_tn;
        if(_tn-_fLogAt>1000 && _fN>0){
          console.log('[MIRROR-DIAG] deck='+(deckColorRef.current||'?')+' drawFps='+Math.round(_fN*1000/(_fAcc||1))+' worstFrameGapMs='+_fWorst.toFixed(0)+' drawnProg='+((progRef.current||0)).toFixed(4)+' hidden='+(typeof document!=="undefined"?document.hidden:'?'));
          _fLogAt=_tn; _fN=0; _fAcc=0; _fWorst=0;
        }
      }

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

        // ── Phase 2 hybrid: sharp kick leading edges from re-anchored onsets ──
        // The 24000-bucket peak-hold bleeds each kick's energy ~1 bucket
        // BACKWARD, so the drawn blob starts ~14ms before the true onset — a
        // correct (onset-anchored) grid line then reads as sitting "inside" the
        // blob. Using the onset beatTimes, snap each kick's leading edge to its
        // onset: in the short smear window just before each onset, clamp the
        // drawn env/height DOWN to the pre-smear baseline so the rise lands ON
        // the onset column (a crisp vertical front). Only the kick's own
        // backward bleed above the baseline is removed — real pre-kick content
        // is preserved. Body resolution (24000) + broadcast payload unchanged.
        // Gated by `desmear` (?onsetgrid=1) so it always pairs with onset beats.
        const dsOnsets = desmearRef.current ? beatTimesRef.current : null;
        if(dsOnsets && dsOnsets.length>1 && spp>0 && dur2>0){
          const bucketSec=dur2/len;                                 // = dur/WF_W
          const SMEAR_SEC=Math.min(0.025,Math.max(0.008,bucketSec*1.5));
          const tLeft=(srcX/len)*dur2;
          const tRight=((srcX+viewPx)/len)*dur2;
          let lo=0,hi=dsOnsets.length-1; const tMin=tLeft-SMEAR_SEC; // first onset ≥ tMin
          while(lo<hi){ const mid=(lo+hi)>>1; if(dsOnsets[mid]<tMin) lo=mid+1; else hi=mid; }
          for(let oi=lo;oi<dsOnsets.length&&dsOnsets[oi]<=tRight;oi++){
            const t=dsOnsets[oi];
            const xOnset=((t/dur2)*len-srcX)/spp;
            const xStart=(((t-SMEAR_SEC)/dur2)*len-srcX)/spp;
            const c0=Math.max(0,Math.ceil(xStart));
            const c1=Math.min(physW-1,Math.floor(xOnset)-1);        // columns strictly before the onset
            if(c1<c0) continue;
            const baseline=envs[c0];                                // pre-smear level at the window's left edge
            for(let dx=c0;dx<=c1;dx++){
              if(envs[dx]>baseline){
                envs[dx]=baseline;
                if(baseline<=0.01){ heights[dx]=0; }
                else { let h2=Math.pow(baseline,GAMMA)*maxH; if(baseline>LIFT_TH) h2+=maxH*LIFT_AMT*(baseline-LIFT_TH)/(1-LIFT_TH); heights[dx]=h2<maxH?h2:maxH; }
              }
            }
          }
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
        // Brightness overlay: bars brighten with amplitude. WF_PULSE dials the
        // amplitude-driven part toward a flat alpha so ?wfpulse=0 stops the
        // per-kick brightness pulse at the playhead (constant-glass A/B).
        const FLAT_A=0.92; // the mid color-stop alpha (constant base)
        for(let dx=0;dx<physW;dx++){
          const h=heights[dx];
          if(h<=0) continue;
          const env=envs[dx];
          const dynA=Math.min(1,Math.pow(env,0.55)*0.95);
          ctx.globalAlpha=WF_PULSE>=1?dynA:(FLAT_A+(dynA-FLAT_A)*WF_PULSE);
          ctx.fillRect(dx,center-h,1,h*2+1);
        }
        ctx.globalAlpha=1;

        // ── Pass 2c: centerline weight band. Per-column 1px rect centered on
        // the centerline whose height scales 0..10 css px with amplitude,
        // drawn in a brightened version of the deck color. The "bass weight"
        // — visually obvious thicker pulse under loud drops.
        // WF_PULSE scales the band's amplitude (its "bass weight" pulse). At 0 the
        // band is suppressed entirely → no per-kick centerline thickening.
        if(WF_PULSE>0){
          const cr=Math.min(255,dr+40), cg=Math.min(255,dg+40), cb=Math.min(255,db+40);
          ctx.fillStyle=`rgb(${cr},${cg},${cb})`;
          const bandMaxPx=Math.round(10*dpr*WF_PULSE);
          for(let dx=0;dx<physW;dx++){
            const env=envs[dx];
            if(env<0.05) continue; // skip near-silence
            const tPx=Math.max(1,Math.min(bandMaxPx,Math.round(env*10*dpr*WF_PULSE)));
            const tHalf=tPx>>1;
            ctx.globalAlpha=Math.min(1,Math.pow(env,0.5));
            ctx.fillRect(dx,center-tHalf,1,tPx);
          }
          ctx.globalAlpha=1;
        }
      }

      // ── Premium beat grid — three-tier edge markers with downbeat + phrase emphasis.
      // Off-beats: small edge ticks only (no through-line). Downbeats: bigger edge
      // ticks + faint full-height white line. Phrase markers (every 16 beats): largest
      // edge ticks in deck identity color + slightly stronger identity-colored full
      // line. Hidden when BPM analysis hasn't run yet (refs null) or deck empty.
      const beatPhaseFrac=beatPhaseFracRef.current;
      const beatPeriodSec=beatPeriodSecRef.current;
      if(beatPhaseFrac!=null&&beatPeriodSec!=null&&dur2>0){
        const effectivePeriod=beatPeriodSec;
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
        // Grid markers — {beatTime (sec), n (beat index for tier emphasis)}.
        // beatsv2 draws gridlines AT the refined beatTimes (the actual kicks,
        // matching the seek-quantize + kick markers + the engage alignment) and
        // labels downbeat/phrase tiers from the linear downbeat anchor; legacy
        // draws the uniform linear grid. The draw loop below is identical for
        // both — only the marker positions differ.
        const gridMarkers=[];
        const bts=beatTimesRef.current;
        if(beatsV2Ref.current && bts && bts.length>1){
          const gridOff=gridOffsetMsRef.current/1000;   // manual fine-tune still honored
          let lo=0,hi=bts.length-1;                      // first beat >= minTime
          while(lo<hi){ const mid=(lo+hi)>>1; if(bts[mid]<minTime) lo=mid+1; else hi=mid; }
          for(let i=lo;i<bts.length&&bts[i]<=maxTime;i++){
            // Tier from the established downbeat anchor (incorporates
            // beatPhaseFrac + barOneOffset); round() absorbs the refine deltas.
            const nLinear=Math.round((bts[i]-firstDownbeatSec)/effectivePeriod);
            gridMarkers.push({beatTime:bts[i]+gridOff,n:nLinear});
          }
        }else{
          const startN=Math.ceil((minTime-firstDownbeatSec)/effectivePeriod);
          const endN=Math.floor((Math.min(dur2,maxTime)-firstDownbeatSec)/effectivePeriod);
          for(let n=startN;n<=endN;n++) gridMarkers.push({beatTime:firstDownbeatSec+n*effectivePeriod,n});
        }

        // Zoom thinning: if off-beat density would exceed ~50 ticks per 100px,
        // suppress off-beats (downbeats + phrase markers always render).
        const visibleBeats=gridMarkers.length;
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

        for(const mk of gridMarkers){
          const beatTime=mk.beatTime;
          if(beatTime<0) continue; // no grid before t=0 — audio doesn't exist there
          const x=(physW>>1)+(beatTime-currentTimeSec)*pxPerSec;
          if(x<-phraseTickW||x>physW+phraseTickW) continue;
          const isPhrase=(mk.n%16===0);
          const isDownbeat=(mk.n%4===0);

          if(isPhrase){
            // v5.2: phrase columns no longer get a red full-height through-line
            // (was too visually heavy, competed with waveform content). They
            // render as a normal downbeat (deck-color through-line + downbeat
            // ticks) PLUS red top/bottom phrase ticks for identity.
            //
            // Sub-pixel positions (no Math.floor) so canvas-2D anti-aliasing
            // splits the fill across the two adjacent pixels proportionally
            // to the fractional part of x. At non-1.0 rate, the inter-beat
            // gap becomes non-integer and floor-snapping alternated adjacent
            // beats between two pixel positions each frame — visible as a
            // ~10 Hz shimmer on the grid. Sub-pixel rendering eliminates it.
            ctx.fillStyle=DOWN_LINE;
            ctx.fillRect(x,0,lineW,physH);
            ctx.fillStyle=DOWN_FILL;
            const dx=x-downTickW/2;
            ctx.fillRect(dx,downTopY,downTickW,downTickH);
            ctx.fillRect(dx,downBotY,downTickW,downTickH);
            // Red phrase ticks on the outer rails — color-coherent red glow.
            ctx.shadowColor=`rgba(${PHRASE_RGB},0.7)`;
            ctx.shadowBlur=4;
            ctx.fillStyle=PHRASE_FILL;
            const px=x-phraseTickW/2;
            ctx.fillRect(px,phraseTopY,phraseTickW,phraseTickH);
            ctx.fillRect(px,phraseBotY,phraseTickW,phraseTickH);
            // Restore deck-color glow for subsequent off/downbeat draws.
            ctx.shadowColor=`rgba(${DECK_RGB},0.65)`;
            ctx.shadowBlur=4;
          }else if(isDownbeat){
            // Downbeat: 1px deck-color through-line + 2px×12px centered ticks.
            ctx.fillStyle=DOWN_LINE;
            ctx.fillRect(x,0,lineW,physH);
            ctx.fillStyle=DOWN_FILL;
            const dx=x-downTickW/2;
            ctx.fillRect(dx,downTopY,downTickW,downTickH);
            ctx.fillRect(dx,downBotY,downTickW,downTickH);
          }else if(showOffBeats){
            // Off-beat: 1px×5px centered ticks, no through-line.
            ctx.fillStyle=OFF_FILL;
            ctx.fillRect(x,offTopY,lineW,offTickH);
            ctx.fillRect(x,offBotY,lineW,offTickH);
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

      // ── smoothdiag finalize: account this frame, log once a second ──────────
      if(SMOOTH_DIAG){
        const _tn=performance.now();
        if(_sLast){
          const dt=_tn-_sLast;
          _sFrames++; _sDtSum+=dt; if(dt>_sDtMax)_sDtMax=dt;
          if(dt>28) _sDropped++;                // missed ≥1 vsync at 60Hz (~16.7ms)
        }
        _sLast=_tn;
        // Playhead scroll this frame, in screen px. scrollPx = dProg·dur·(px per
        // buffer-sec). pxPerBufSec = physW / (windowSec·rate). Measures how far
        // the waveform actually moved — constant = glass, variance = judder.
        const _r=rateRef.current||1; const _vbs=Math.max(1e-6,windowSec*_r);
        if(_sPrevProg!=null && dur2>0){
          const scrollPx=Math.abs(prog2-_sPrevProg)*dur2*(physW/_vbs);
          _sScrollSum+=scrollPx; _sScrollSqSum+=scrollPx*scrollPx;
          if(scrollPx>_sScrollMax)_sScrollMax=scrollPx;
          if(scrollPx<0.01)_sZero++; else _sMove++;   // zeroFrames → stepped position
        }
        _sPrevProg=prog2;
        const drawMs=_tn-_sT0;                  // full draw-body cost this frame
        _sDrawSum+=drawMs; if(drawMs>_sDrawMax)_sDrawMax=drawMs;

        if(_tn-_sLogAt>1000 && _sFrames>0){
          const movef=_sMove+_sZero;
          const mean=movef>0?_sScrollSum/movef:0;
          const variance=movef>0?Math.max(0,_sScrollSqSum/movef-mean*mean):0;
          const sd=Math.sqrt(variance);
          const fps=Math.round(_sFrames*1000/(_sDtSum||1));
          const role=isDriverRef.current?'local':'mirror';
          console.log('[SMOOTH-DIAG] deck='+(deckIdRef.current||deckColorRef.current||'?')+' role='+role+
            ' fps='+fps+' frames='+_sFrames+
            ' scrollPx/f{mean='+mean.toFixed(2)+' sd='+sd.toFixed(2)+' max='+_sScrollMax.toFixed(2)+'}'+
            ' zeroFrames='+_sZero+'/'+movef+
            ' frameMs{mean='+(_sDtSum/Math.max(1,_sFrames)).toFixed(1)+' max='+_sDtMax.toFixed(0)+'} dropped='+_sDropped+
            ' drawMs{mean='+(_sDrawSum/Math.max(1,_sFrames)).toFixed(2)+' max='+_sDrawMax.toFixed(2)+'}'+
            ' desmear='+(desmearRef.current?1:0)+' hidden='+(typeof document!=="undefined"?document.hidden:'?')+
            ' prog='+prog2.toFixed(4));
          _sLogAt=_tn; _sFrames=0; _sDtSum=0; _sDtMax=0; _sDropped=0;
          _sScrollSum=0; _sScrollSqSum=0; _sScrollMax=0; _sZero=0; _sMove=0; _sDrawSum=0; _sDrawMax=0;
        }
      }
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

// Pitch nudge buttons — [−][+]. Mutates the deck's rate. Web Audio's
// playbackRate shifts pitch + tempo together (no time-stretch), matching
// CDJ/Rekordbox pitch-fader semantics. Range ±8% from native rate.
// Click ±0.1 BPM, Shift-click ±1.0, press-and-hold = accelerated repeat.
// The readout (PitchReadout below) handles scroll + drag + double-click reset.
const PITCH_RANGE = 0.08; // ±8% from rate=1
// Press-and-hold timing — first step fires on mousedown so quick taps still
// register, then a 500 ms silence before the slow phase starts; after another
// 1000 ms in slow phase (1500 ms total from press) the cadence + step both
// grow. The shift variants use 10× the per-step BPM delta.
const HOLD_INITIAL_DELAY_MS = 500;
const HOLD_FAST_DELAY_MS = 1000;
const HOLD_SLOW_INTERVAL_MS = 100;
const HOLD_FAST_INTERVAL_MS = 50;
const HOLD_SLOW_STEP_BPM = 0.1;
const HOLD_FAST_STEP_BPM = 0.5;
const HOLD_SHIFT_SLOW_STEP_BPM = 1.0;
const HOLD_SHIFT_FAST_STEP_BPM = 5.0;
// Drag on readout: 3 px slop before drag activates (so single click + double-
// click still register cleanly), then 5 px of vertical travel per 0.1 % step.
const DRAG_THRESHOLD_PX = 3;
const DRAG_PX_PER_STEP = 5;
// Drag fires applyRate() on every step boundary crossed — that can be 10-20 Hz
// during continuous drag. Throttle telemetry to ~10 Hz so the analytics
// pipeline isn't flooded; setRate + RTC broadcast are unaffected.
const DRAG_TELEMETRY_DEBOUNCE_MS = 100;

function PitchNudge({ rate, nativeBpm, enabled, synced, onApply }) {
  // Latest-prop refs so setInterval callbacks (created at press time) read the
  // current rate / native BPM / enabled flag rather than the values captured
  // at interval creation. Without these, a hold that started at rate=1 would
  // keep applying deltas relative to rate=1 even after the rate moved.
  const rateRef = useRef(rate);
  const nativeBpmRef = useRef(nativeBpm);
  const enabledRef = useRef(enabled);
  useEffect(() => { rateRef.current = rate; }, [rate]);
  useEffect(() => { nativeBpmRef.current = nativeBpm; }, [nativeBpm]);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  // initialTimeout = the 500 ms gate before slow phase starts.
  // fastDelayTimeout = the 1000 ms gate (during slow phase) before fast starts.
  // intervalId = whichever phase's repeat interval is currently active.
  const holdRef = useRef({ initialTimeout: null, fastDelayTimeout: null, intervalId: null });
  const clearHoldTimers = () => {
    const h = holdRef.current;
    if (h.initialTimeout) { clearTimeout(h.initialTimeout); h.initialTimeout = null; }
    if (h.fastDelayTimeout) { clearTimeout(h.fastDelayTimeout); h.fastDelayTimeout = null; }
    if (h.intervalId) { clearInterval(h.intervalId); h.intervalId = null; }
  };
  // Clean up timers on unmount — otherwise a deck removal during hold would
  // leak intervals that keep firing applyRate against a stale onApply.
  useEffect(() => clearHoldTimers, []);

  // Apply one step. Returns false when the clamp blocks the change so the
  // caller can stop the hold (otherwise the interval would keep firing
  // no-op updates against the clamped rate).
  const applyStep = (dir, stepBpm, method) => {
    if (!enabledRef.current) return false;
    const nb = nativeBpmRef.current;
    if (!(nb > 0)) return false;
    const cur = rateRef.current;
    const target = Math.max(1 - PITCH_RANGE, Math.min(1 + PITCH_RANGE, cur + dir * stepBpm / nb));
    if (Math.abs(target - cur) < 1e-6) return false;
    onApply(target, method);
    return true;
  };

  const startHold = (dir, shift) => {
    const slowStep = shift ? HOLD_SHIFT_SLOW_STEP_BPM : HOLD_SLOW_STEP_BPM;
    const fastStep = shift ? HOLD_SHIFT_FAST_STEP_BPM : HOLD_FAST_STEP_BPM;
    // First step fires immediately. Quick-tap path: mouseup arrives before the
    // 500 ms timeout, hold timers get cleared, the user only sees the single step.
    applyStep(dir, slowStep, shift ? "shift_button" : "button");
    holdRef.current.initialTimeout = setTimeout(() => {
      holdRef.current.initialTimeout = null;
      holdRef.current.intervalId = setInterval(() => {
        if (!applyStep(dir, slowStep, "hold")) clearHoldTimers();
      }, HOLD_SLOW_INTERVAL_MS);
      // Schedule the slow → fast transition relative to slow-phase start, so
      // the total time from press to fast phase is initial + fastDelay.
      holdRef.current.fastDelayTimeout = setTimeout(() => {
        holdRef.current.fastDelayTimeout = null;
        if (holdRef.current.intervalId) clearInterval(holdRef.current.intervalId);
        holdRef.current.intervalId = setInterval(() => {
          if (!applyStep(dir, fastStep, "hold")) clearHoldTimers();
        }, HOLD_FAST_INTERVAL_MS);
      }, HOLD_FAST_DELAY_MS);
    }, HOLD_INITIAL_DELAY_MS);
  };

  const onMinusDown = (e) => { if (!enabled || e.button !== 0) return; startHold(-1, e.shiftKey); };
  const onPlusDown  = (e) => { if (!enabled || e.button !== 0) return; startHold( 1, e.shiftKey); };
  const onUp = () => clearHoldTimers();
  const onLeave = () => clearHoldTimers();

  const btnBase = {
    width: 24, height: 24, background: "transparent",
    border: "1px solid rgba(255,255,255,0.12)",
    color: enabled ? "#9CA3AF" : "#5A5E66",
    fontFamily: "'Inter',sans-serif", fontSize: 12, fontWeight: 500,
    cursor: enabled ? "pointer" : "default", outline: "none",
    padding: 0, display: "flex", alignItems: "center", justifyContent: "center",
    transition: "all 150ms cubic-bezier(0.4, 0, 0.2, 1)",
    flexShrink: 0, lineHeight: 1, userSelect: "none",
  };
  const minusTip = !enabled ? undefined : synced ? "Pitch −0.1 BPM (shift: −1.0, hold to repeat) · disengages Sync" : "Pitch −0.1 BPM (shift: −1.0, hold to repeat)";
  const plusTip  = !enabled ? undefined : synced ? "Pitch +0.1 BPM (shift: +1.0, hold to repeat) · disengages Sync" : "Pitch +0.1 BPM (shift: +1.0, hold to repeat)";
  return (
    <div style={{ display:"flex", gap:0, flexShrink:0 }}>
      <button onMouseDown={onMinusDown} onMouseUp={onUp} onMouseLeave={onLeave}
        disabled={!enabled} title={minusTip}
        style={{ ...btnBase, borderTopLeftRadius:4, borderBottomLeftRadius:4, borderRight:"none" }}>−</button>
      <button onMouseDown={onPlusDown} onMouseUp={onUp} onMouseLeave={onLeave}
        disabled={!enabled} title={plusTip}
        style={{ ...btnBase, borderTopRightRadius:4, borderBottomRightRadius:4 }}>+</button>
    </div>
  );
}

// Pitch readout — `+0.0%` text with three orthogonal interactions:
//   - Scroll wheel: ±0.05 BPM/notch fine adjust (method "scroll")
//   - Vertical drag: 5 px per 0.1 % step, target = startRate + steps × 0.001
//     (method "drag"); 3 px slop before drag activates so single click /
//     double-click don't accidentally trigger drag
//   - Double-click: reset to 0.0 % (method "reset")
// Pointer Events + setPointerCapture so drag tracking survives the cursor
// leaving the element. Drag's startRate is captured at pointerdown — external
// rate changes mid-drag get overridden by the drag's next move event ("most
// recent input wins" per spec).
function PitchReadout({ rate, nativeBpm, enabled, displayText, tooltip, color, onApply, onReset }) {
  const dragRef = useRef({ pointerId: null, startY: 0, startRate: 1, threshold: false });

  const onPointerDown = (e) => {
    if (!enabled || e.button !== 0) return;
    if (dragRef.current.pointerId != null) return; // already dragging another pointer
    dragRef.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      startRate: rate,
      threshold: false,
    };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (d.pointerId !== e.pointerId) return;
    const verticalDelta = d.startY - e.clientY; // positive = dragged UP = +pitch
    if (!d.threshold) {
      if (Math.abs(verticalDelta) < DRAG_THRESHOLD_PX) return;
      d.threshold = true;
    }
    const steps = Math.trunc(verticalDelta / DRAG_PX_PER_STEP);
    const target = Math.max(1 - PITCH_RANGE, Math.min(1 + PITCH_RANGE, d.startRate + steps * 0.001));
    if (Math.abs(target - rate) < 1e-6) return;
    onApply(target, "drag");
  };
  const releasePointer = (e) => {
    const d = dragRef.current;
    if (d.pointerId !== e.pointerId) return;
    try { e.currentTarget.releasePointerCapture(d.pointerId); } catch {}
    d.pointerId = null;
    d.threshold = false;
  };

  const onWheel = (e) => {
    if (!enabled) return;
    e.preventDefault();
    if (!(nativeBpm > 0)) return;
    const delta = (e.deltaY < 0 ? 0.05 : -0.05) / nativeBpm;
    const target = Math.max(1 - PITCH_RANGE, Math.min(1 + PITCH_RANGE, rate + delta));
    if (Math.abs(target - rate) < 1e-6) return;
    onApply(target, "scroll");
  };

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={releasePointer}
      onPointerCancel={releasePointer}
      onDoubleClick={enabled ? onReset : undefined}
      onWheel={onWheel}
      title={tooltip}
      style={{
        fontSize:11, fontFamily:"'Inter',sans-serif", fontWeight:500,
        color,
        fontVariantNumeric:"tabular-nums", letterSpacing:0.3,
        cursor: enabled ? "ns-resize" : "default",
        userSelect:"none",
        touchAction:"none", // let pointermove fire instead of native vertical scroll
        transition:"color 150ms cubic-bezier(0.4, 0, 0.2, 1)",
      }}>
      {displayText}
    </div>
  );
}

function Deck({ id, ch, ctx:ac, color, local, remote, onChange, midi:mt, bpmResult, bpmAnalyze, eqHi=0, eqMid=0, eqLo=0, chanVol=1, loadFromLibrary=null, onTrackInfo=null, onSync=null, syncReady=true, syncRole=null, isMaster=false, onMasterToggle=null, onLibraryTrackDrop=null, onProgUpdate=null, onWaveform=null, onSeekReady=null, remoteSeek=null, onToggleReady=null, onCueReady=null, remoteToggle=null, remoteCue=null, onTransportFire=null, isDriver=true, onNudgeReady=null, acNowRef=null, onBufferReady=null, barOneOffsetSec=0, onGridEdit=null, hasOverride=false, userGridOverride=null, onPitchInteract=null }) {
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
  // Phase 3 Commit 1 — Beat Grid panel open/close state, per-deck.
  const [gridPanelOpen,setGridPanelOpen]=useState(false);
  // Phase 3 Commit A — Beat Grid panel BPM type-in. Local string state so
  // mid-typing values (e.g. "12" en route to "122") don't briefly write
  // through to the override; commit on Enter or blur only.
  const [bpmInputValue,setBpmInputValue]=useState("");
  const [bpmInputError,setBpmInputError]=useState(false);
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
  const remProgRef=useRef(0),remTimeRef=useRef(0),remRateRef=useRef(0),remRaf=useRef(null),remSlewRef=useRef(0);
  const remPktRef=useRef(0);          // performance.now() of the last progress packet (staleness)
  const remStaleLoggedRef=useRef(false);
  const remDiagAtRef=useRef(0);       // throttle for [MIRROR-DIAG] interp log
  const lastRemProgRef=useRef(null);  // last remote.progress we re-anchored on (skip non-progress re-runs)
  const remAwaitPktRef=useRef(false); // play just started → hold at paused pos until first fresh packet
  const lastProgBroadcastRef=useRef(0);
  // Drag telemetry timestamp. applyRate skips logEvent when method==="drag" and
  // the last drag log was <DRAG_TELEMETRY_DEBOUNCE_MS ago. Hold, scroll, button,
  // shift_button, and reset always log.
  const lastDragTelemetryRef=useRef(0);

  // Escape closes the Beat Grid panel when it is open. Scoped per-deck —
  // each Deck attaches its own listener and only acts on its own state.
  useEffect(()=>{
    if(!gridPanelOpen)return;
    const onKey=(e)=>{ if(e.key==="Escape")setGridPanelOpen(false); };
    window.addEventListener("keydown",onKey);
    return ()=>window.removeEventListener("keydown",onKey);
  },[gridPanelOpen]);

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
    // On play-START, HOLD at the paused position until the first genuinely-new
    // progress packet arrives, then hard-snap to the partner's restart position
    // and coast. Previously this reset remTimeRef=0, which made the RAF coast
    // from performance.now() (a huge elapsed) → the playhead jumped to the END
    // for the ~100-200ms gap before the first packet — the visible per-press
    // jump on remote pause→play. The await flag suppresses the coast in that gap.
    if(nowPlaying && !wasPlaying){
      remAwaitPktRef.current=true;
      // Anchor the model to WHAT'S CURRENTLY DISPLAYED (progRef), so the hold and
      // the first-packet slew both start from the visible position — no jump in
      // either direction. The first fresh packet then eases (slews) onto truth.
      remProgRef.current=progRef.current; remTimeRef.current=performance.now(); remSlewRef.current=0;
    }
    // EQ values now come from parent props when remote is true
    if(remote.trackName)setName(remote.trackName);
    if(remote.duration)setDur(remote.duration);
    if(remote.waveformPeaks)setWfPeaks(remote.waveformPeaks);
    if(remote.waveformFreq)setWfFreq(remote.waveformFreq);
    if(remote.waveformBass)setWfBass(remote.waveformBass);
    if(remote.waveformMid)setWfMid(remote.waveformMid);
    if(remote.waveformHigh)setWfHigh(remote.waveformHigh);
    // Non-driver playhead model — anchor + rate-aware extrapolation + slew:
    //   visible(t) = clamp( remProg + remRate*(t-remTime) + remSlew*e^(-(t-remTime)/TAU) )
    // remProg/remTime = truth anchor; remRate = per-ms progress at the DRIVER'S
    // actual rate; remSlew = a visual offset (set so the screen never JUMPS on a
    // correction) that decays to 0, easing the playhead onto truth.
    const SLEW_TAU_MS=220;     // slew half-life feel — eases a correction over ~½s
    const FWD_SNAP_SEC=3;      // forward jump beyond this = a genuine seek → hard snap
    const BACK_SNAP_SEC=8;     // ONLY a large backward jump (a genuine rewind) hard-snaps
    // Re-anchor ONLY on a genuinely NEW progress value. This effect re-runs on
    // ANY `remote` (pA/pB) field change — analyzer re-broadcast, rate, waveform,
    // etc. — and re-anchoring to the (unchanged, now-stale) progress on those
    // would reset the coast backward to a stale position. When progress is
    // sparse (a backgrounded driver) but other fields update, that was the
    // residual bounce + lag. Coast continues undisturbed between real packets.
    if(remote.progress!=null && remote.progress!==lastRemProgRef.current){
      lastRemProgRef.current=remote.progress;
      const now=performance.now();
      remPktRef.current=now; remStaleLoggedRef.current=false;   // fresh packet → staleness clears
      const trackDurSec=remote.duration||dur;
      // Rate-aware: extrapolate at the driver's ACTUAL playback rate, not a fixed
      // 1×. A synced/pitched driver deck (rate≠1, the norm in a beatmatched set)
      // otherwise makes our interp drift off truth; the periodic snap-back that
      // produced was the backward sawtooth. remote.rate is broadcast on the wire.
      const driverRate=(typeof remote.rate==="number"&&remote.rate>0)?remote.rate:1;
      if(trackDurSec&&trackDurSec>0){
        remRateRef.current=nowPlaying?(driverRate/(trackDurSec*1000)):0;
      }
      // Where the playhead is VISIBLE right now (model + decaying slew).
      const since=now-remTimeRef.current;
      const modeledNow=remProgRef.current+(remRateRef.current||0)*since;
      const slewNow=remSlewRef.current*Math.exp(-since/SLEW_TAU_MS);
      const visibleNow=(remTimeRef.current>0)?(modeledNow+slewNow):remote.progress;
      const signedDriftSec=(remote.progress-visibleNow)*(trackDurSec||1); // + = truth AHEAD of us
      remAwaitPktRef.current=false;   // a fresh packet → stop holding, resume coasting
      const isFirst=remTimeRef.current===0;
      const fwdSeek=signedDriftSec>FWD_SNAP_SEC;       // driver jumped ahead (cue/seek)
      const bigRewind=-signedDriftSec>BACK_SNAP_SEC;   // driver genuinely rewound a long way
      if(isFirst||fwdSeek||bigRewind){
        if(bigRewind) console.warn('[MIRROR-SNAP] deck',id,'large rewind '+signedDriftSec.toFixed(1)+'s — hard snap');
        else if(fwdSeek) console.warn('[MIRROR-SNAP] deck',id,'forward seek/catch-up +'+signedDriftSec.toFixed(1)+'s — hard snap');   // triage c: forward snaps now confess too
        remProgRef.current=remote.progress; remTimeRef.current=now; remSlewRef.current=0;
      } else {
        // Sub-seek drift (incl. moderate backward from packet starvation/jitter):
        // re-anchor the model to truth but CARRY the current visible offset into
        // slew so there is NEVER a visible backward jump — it decays to 0, easing
        // onto truth as the partner advances. This is the fix for the "mirror
        // skips back multiple bars" report under real-network jitter.
        if(signedDriftSec<-0.5) console.log('[MIRROR-SNAP] deck',id,'absorbed backward drift '+signedDriftSec.toFixed(2)+'s via slew (no jump)');
        remProgRef.current=remote.progress; remTimeRef.current=now;
        remSlewRef.current=visibleNow-remote.progress;
      }
      // DO NOT setProg here — the RAF loop below renders the smooth position.
    }
    // Start/stop smooth interpolation RAF
    cancelAnimationFrame(remRaf.current);
    if(!nowPlaying && remote.progress!=null){
      // PAUSED: no RAF runs, so snap the displayed playhead to the delivered
      // (frozen) truth here — otherwise the mirror keeps showing its last
      // coasted position and lurches on the next play.
      const fp=Math.min(1,Math.max(0,remote.progress));
      remProgRef.current=fp; setProg(fp); progRef.current=fp; onProgUpdate?.(fp);
    }
    if(nowPlaying){
      const animate=()=>{
        const tnow=performance.now();
        const sincePkt=tnow-remPktRef.current;
        // Coast at the driver's TRUE rate the WHOLE time the partner is playing —
        // even across sparse packets (a backgrounded driver tab broadcasting at
        // ~1Hz). The audio is genuinely advancing at this rate, so coasting
        // tracks truth; an arriving packet just nudges via slew. (The earlier
        // "hold after 2.5s" caused the freeze — a playing deck must not stop.)
        let interp;
        if(remAwaitPktRef.current){
          // Play just started — HOLD at the paused position until the first fresh
          // packet anchors the restart (prevents the per-press jump-to-end).
          interp=Math.min(1,Math.max(0,remProgRef.current));
        } else {
          const since=tnow-remTimeRef.current;
          const modeled=remProgRef.current+remRateRef.current*since;
          const slew=remSlewRef.current*Math.exp(-since/SLEW_TAU_MS);
          interp=Math.min(1,Math.max(0,modeled+slew));
        }
        if(sincePkt>1500 && !remStaleLoggedRef.current){ console.warn('[MIRROR-STALE] deck',id,'packets sparse ('+Math.round(sincePkt)+'ms) — coasting at true rate'); remStaleLoggedRef.current=true; }
        setProg(interp); progRef.current=interp; onProgUpdate?.(interp);
        if(MIRROR_DIAG && tnow-remDiagAtRef.current>1000){
          remDiagAtRef.current=tnow;
          // interp = what the interp OUTPUTS this frame; anchor = last packet value;
          // pktAgeMs = how long since a packet arrived; rafLive proves the interp RAF is running.
          console.log('[MIRROR-DIAG] deck '+id+' interp='+interp.toFixed(4)+' anchorPkt='+(remProgRef.current||0).toFixed(4)+' pktAgeMs='+Math.round(sincePkt)+' rate='+(remRateRef.current*1e6).toFixed(2)+'e-6 rafLive=1 hidden='+(typeof document!=="undefined"?document.hidden:'?'));
        }
        remRaf.current=requestAnimationFrame(animate);
      };
      remRaf.current=requestAnimationFrame(animate);
    }
    return()=>cancelAnimationFrame(remRaf.current);
  },[remote,local,buf]);

  // Root Cause 2 — hidden-tab refocus. While the tab is hidden the RAF is
  // paused (the mirror needn't draw — fine), but on returning to VISIBLE the
  // interp RAF resumes from a possibly-huge elapsed (remTimeRef stale) → it
  // would coast to the end (jump). Re-anchor TIME to now + hold at the last
  // known position until the next packet repaints truth — an immediate, clean
  // redraw at current truth, no lingering stutter.
  useEffect(()=>{
    if(local) return;   // only the mirror (non-local) deck interps remote progress
    const onVis=()=>{
      if(typeof document!=="undefined" && document.visibilityState==="visible"){
        remTimeRef.current=performance.now(); remSlewRef.current=0;
        remAwaitPktRef.current=true; remStaleLoggedRef.current=false;
      }
    };
    document.addEventListener("visibilitychange",onVis);
    return()=>document.removeEventListener("visibilitychange",onVis);
  },[local]);

  // MIDI routing — EQ now handled by parent component when local
  const sfx=`DECK_${id}`;
  useEffect(()=>{ if(!mt||!local)return; const{actionKey:ak,value:v}=mt; if(ak===`${sfx}_PLAY`&&v===true)toggle(); if(ak===`${sfx}_CUE`&&v===true)cue(); },[mt]);

  const stop_=()=>{ console.log('[PLAY-STATE] deck',id,'stop_() called, destroying source (hadSrc='+!!src.current+')'); if(src.current){src.current.onended=null;try{src.current.stop();}catch{}src.current.disconnect();src.current=null;}cancelAnimationFrame(raf.current); };

  // Broadcast the driver's progress computed from the AUDIO CLOCK (ac.currentTime),
  // self-throttled to 10Hz. Driven from BOTH the RAF tick (foreground) AND the
  // Worker heartbeat below (background-immune). Using ac.currentTime — not the
  // parent RAF snapshot (acNowRef, which FREEZES when the tab is backgrounded) —
  // means even a throttled/sparse send carries the LIVE position, so the
  // partner's mirror never gets a stale anchor to snap backward to.
  const broadcastProgress=useCallback(()=>{
    if(!isDriverRef.current||!playRef.current||!src.current||!ac) return;
    const b=bufRef.current; if(!b) return;
    const nowMs=performance.now();
    // 10Hz cap. Test-only: __progressThrottleMs simulates a backgrounded tab's
    // sparse send so the smoke can measure receiver coast accuracy.
    const capMs=(TEST_HOOKS&&typeof window!=="undefined"&&window.__progressThrottleMs)||100;
    if(nowMs-lastProgBroadcastRef.current<capMs) return;
    lastProgBroadcastRef.current=nowMs;
    const elapsedBuf=(ac.currentTime-st.current)*rateRef.current;
    const lr2=loopRef.current;
    let p;
    if(lr2.active&&lr2.start!=null&&lr2.end!=null){
      const lDur=(lr2.end-lr2.start)*b.duration;
      const pos=(off.current-lr2.start*b.duration+elapsedBuf);
      p=lr2.start+(pos%lDur)/b.duration;
    } else { p=Math.min(1,(off.current+elapsedBuf)/b.duration); }
    onChange?.("progress",p);
  },[ac,onChange]);
  const broadcastProgressRef=useRef(broadcastProgress);
  useEffect(()=>{broadcastProgressRef.current=broadcastProgress;},[broadcastProgress]);
  // Worker heartbeat — keeps progress flowing when the tab is backgrounded
  // (RAF paused + main-thread setInterval throttled to ~1/min). One per local
  // deck; started/stopped with play below.
  const timerWorkerRef=useRef(null);
  useEffect(()=>{
    if(!local) return;
    const w=createTimerWorker();
    if(w){ w.onmessage=()=>broadcastProgressRef.current?.(); timerWorkerRef.current=w; }
    return()=>{ try{w?.postMessage({cmd:"stop"});w?.terminate();}catch{} timerWorkerRef.current=null; };
  },[local]);
  useEffect(()=>{
    const w=timerWorkerRef.current; if(!w) return;
    if(isDriver&&play) w.postMessage({cmd:"start",ms:100}); else w.postMessage({cmd:"stop"});
  },[isDriver,play]);

  const play_=(o)=>{ if(!buf||!ch||!ac){console.log('[PLAY-STATE] deck',id,'play_() bailed early: hasBuf='+!!buf+' hasCh='+!!ch+' hasAc='+!!ac); return;} console.log('[PLAY-STATE] deck',id,'play_() creating source at offset',o); stop_();
    // ── one-shot audio diagnostics (booth-silence investigation) ──
    const _stateBefore=ac.state;
    if(ac.state==="suspended")ac.resume().then(()=>console.log('[AUDIO-DIAG] deck',id,'resume() resolved → ac.state='+ac.state)).catch(e=>console.warn('[AUDIO-DIAG] deck',id,'resume() FAILED',e?.message||e));
    try{ console.log('[AUDIO-DIAG] deck '+id+' play_ source-create | ac.state(before)='+_stateBefore+' trim='+ch.trim.gain.value.toFixed(3)+' vol='+ch.vol.gain.value.toFixed(3)+' xf='+ch.xf.gain.value.toFixed(3)+' rate='+rate); }catch(err){ console.warn('[AUDIO-DIAG] deck',id,'gain read failed',err?.message||err); }
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
        const pos=(off.current-lr2.start*buf.duration+elapsedBuf);
        p=lr2.start+(pos%lDur)/buf.duration;
      } else {
        p=Math.min(1,(off.current+elapsedBuf)/buf.duration);
      }
      setProg(p); progRef.current=p; onProgUpdate?.(p);
      // Wire broadcast moved to broadcastProgress() (computes from ac.currentTime,
      // also driven by the background-immune worker heartbeat). The self-throttle
      // to 10Hz lives there, so foreground RAF + worker can't double-send.
      broadcastProgress();
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
      stop_();setPlay(false);
      // Deliver the EXACT frozen position WITH the pause — the worker heartbeat
      // stops on pause, so without this the partner's mirror is stuck at its
      // last coasted position (behind truth) and lurches forward on the next
      // play. progress first so the mirror anchors before it sees playing=false.
      onChange?.("progress",Math.min(1,off.current/buf.duration));
      onChange?.("playing",false);
      logEvent("deck", "play_toggled", { deck: id, isPlaying: false });
    } else {
      // User has now interacted with this track — auto-position should
      // not override their action even if BPM analysis is still pending.
      userMovedRef.current=true;
      // Parked-at-end guard: if the playhead sits at/past the buffer end (a
      // track left at its end, a seek-to-end, or a re-engage that landed near
      // the end), play_(off.current) would start a source at buf.duration → 0
      // samples → instant onended → a dead flip-flop with no audio (the
      // "transport inert after a long session" report). Wrap to the start so
      // pressing play replays instead of going inert. Works for both a local
      // press and a partner's toggle_request (the driver runs this path).
      if (off.current >= buf.duration - 0.05) {
        console.log('[PLAY-STATE] deck',id,'parked-at-end → wrapping to start before play');
        off.current=0; setProg(0); progRef.current=0; onProgUpdate?.(0); onChange?.("progress",0);
      }
      // Deliver the exact start position WITH the play, so the mirror anchors
      // its restart there (no lurch) before coasting.
      onChange?.("progress",Math.min(1,off.current/buf.duration));
      play_(off.current);setPlay(true);onChange?.("playing",true);
      logEvent("deck", "play_toggled", { deck: id, isPlaying: true });
    }
  },[buf,play,ac,rate,id,onTransportFire,isDriver,onProgUpdate]);
  // Latest analyzed beat times (seconds), via ref so `seek`'s quantize reads
  // fresh data without re-creating the callback. Driver uses its own analysis;
  // remote.beatTimes is the fallback.
  const beatTimesRef=useRef(null);
  useEffect(()=>{ beatTimesRef.current = bpmResult?.beatTimes ?? remote?.beatTimes ?? null; }, [bpmResult?.beatTimes, remote?.beatTimes]);
  const seek  =useCallback((p, fromRemote=false, noQuantize=false)=>{
    // Clamp to [0, 1] — guards against unclamped callers (small WF onClick,
    // network seek_request) feeding negative or >1 fractions. Without this,
    // negative p stores a negative off.current that crashes the next play_()
    // with "AudioBufferSourceNode.start: offset less than minimum bound (0)".
    const pc=Math.max(0,Math.min(1,p));
    // Driver model gate (same shape as toggle).
    if (!isDriver) {
      if (!fromRemote) {
        console.log("[SEEK-SEND]", { deckId: id, value: pc, reason: "non-driver -> seek_request" });
        onTransportFire?.({ type:"seek_request", deckId:id, value:pc });
      } else {
        console.warn("[SEEK-EXEC] dropped — fromRemote=true on non-driver Deck", id);
      }
      return;
    }
    if (fromRemote) console.log("[SEEK-EXEC]", { deckId: id, value: pc, isDriver, hasBuf: !!buf, play });
    // SMART QUANTIZE — snap to the nearest analyzed beat when PLAYING (keeps a
    // synced blend locked); FREE seek when paused (cue placement) and while
    // dragging (the drag commits one seek on release, so this only snaps the
    // landing). Quantized HERE at execution on the driver, so the broadcast
    // progress IS the landed beat and both sides agree on the position.
    // noQuantize=true is the SYNC engage's own phase-align seek: it lands the
    // slave at the master's sub-beat PHASE (generally off-beat), so re-snapping
    // it to the nearest beat here would destroy the alignment and cause the
    // repeat-engage wander. Engage is the alignment authority; only user scrubs
    // get quantized.
    let pq=pc;
    const durSec=buf?.duration||0;
    const beats=beatTimesRef.current;
    if(play && !noQuantize && beats && beats.length>1 && durSec>0){
      const targetSec=pc*durSec;
      const nearest=nearestBeatTime(beats,targetSec);   // shared helper (beatsv2)
      pq=Math.max(0,Math.min(1,nearest/durSec));
      console.log("[SEEK-QUANTIZE]",{deckId:id,fromSec:+targetSec.toFixed(3),toSec:+nearest.toFixed(3),deltaMs:+((nearest-targetSec)*1000).toFixed(1)});
    }
    const o=pq*durSec;off.current=o;if(play)play_(o);else{setProg(pq);progRef.current=pq;onProgUpdate?.(pq);}onChange?.("progress",pq);
    // User interacted — block auto-position-to-first-downbeat on this track.
    userMovedRef.current=true;
    // Local-only hook for sync re-align (see handleTransportFire). seek_local
    // never goes on the wire — handleTransportFire suppresses broadcast for
    // this type and uses it solely to trigger the scrub-resync scheduler.
    // Without this, driver-path seeks (drag-release, small-WF click, beat
    // arrows) bypassed handleScrubResync entirely and the slave drifted out
    // of sync after any user-initiated seek while syncLocked.
    onTransportFire?.({ type:"seek_local", deckId:id, value:pq, fromRemote });
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
    logEvent("deck", "cue", { deck: id, trackId: loadFromLibrary?.track?.id || null });
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
    // Reset hot cues + loop on new track load. Door 3: seed imported rekordbox
    // hot cues (time sec → prog fraction, placed by slot Num). Memory cues are
    // data-only until Slice B.
    {
      const seeded=[null,null,null,null];
      const imported=trackMeta?.hotCues;
      if(Array.isArray(imported)&&d.duration>0){
        for(const c of imported){ if(c&&c.num>=0&&c.num<seeded.length&&isFinite(c.time)) seeded[c.num]=Math.min(1,Math.max(0,c.time/d.duration)); }
        console.log('[REKORDBOX] deck',id,'seeded',imported.filter(c=>c.num>=0&&c.num<4).length,'imported hot cues');
      }
      setHotCues(seeded);
    }
    setLoopActive(false);setLoopStart(null);setLoopEnd(null);
    loopRef.current={active:false,start:null,end:null};
    bpmAnalyze?.(d, id, { skipOnsetAnchor: trackMeta?.gridSource === "rekordbox" });
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
          {/* BPM + pitch cluster — compact two-row stack:
                Row 1: BPM number (hero, 28 px)
                Row 2: pitch % readout (left) + ± buttons (right), inline.
              Per Rekordbox/Beatport reference, pitch lives with the BPM
              display (not the transport row) so adjustments read as "tuning
              the BPM" rather than "another transport action".
              Inline pct+buttons layout was chosen over a 3-row vertical
              stack to keep the deck card vertical budget within the (now
              260 px) container — the 3-row version overflowed by ~50 px.
              The "BPM" label below the number was dropped; the big tabular
              number is unambiguously BPM in deck-card context (matches the
              Beatport reference layout).
              Readout supports scroll (±0.05 BPM/notch) and double-click reset.
              Color stays neutral gray at all offsets — no amber/red escalation
              (Pro tool restraint; user is responsible for knowing their range). */}
          <div style={{flexShrink:0, textAlign:"right", alignSelf:"flex-end"}}>
            {(() => {
              const effectiveBpm = bpmResult?.bpm ?? remote?.bpm;
              const rateApplies  = !!effectiveBpm;
              const nativeBpm    = rateApplies ? effectiveBpm : 0;
              const adjustedBpm  = effectiveBpm ? effectiveBpm * (rateApplies ? rate : 1) : null;
              const pctOff       = (rate - 1) * 100;
              const atNative     = Math.abs(pctOff) < 0.05;
              const synced       = syncRole !== null;
              const enabled      = isDriver && nativeBpm > 0;
              const bpmStep      = (bpmDelta) => nativeBpm > 0 ? bpmDelta / nativeBpm : 0;
              // applyRate is called by ± buttons (method: "button"/"shift_button"),
              // press-and-hold repeats ("hold"), scroll-wheel ("scroll"), and
              // drag ("drag"). Drag fires at ~10-20 Hz so its telemetry is
              // throttled to ~10 Hz via lastDragTelemetryRef — setRate +
              // onChange broadcast still run every call regardless.
              const applyRate = (newRate, method) => {
                onPitchInteract?.(id);
                setRate(newRate);
                onChange?.("rate", newRate);
                const now = Date.now();
                const shouldLog = method !== "drag" || (now - lastDragTelemetryRef.current >= DRAG_TELEMETRY_DEBOUNCE_MS);
                if (shouldLog) {
                  if (method === "drag") lastDragTelemetryRef.current = now;
                  logEvent("pitch", "offset_changed", {
                    deck: id,
                    trackId: loadFromLibrary?.track?.id || null,
                    prevRate: rate,
                    newRate,
                    prevPct: (rate - 1) * 100,
                    newPct: (newRate - 1) * 100,
                    nativeBpm,
                    effectiveBpm: nativeBpm * newRate,
                    wasSynced: synced,
                    method,
                  });
                  console.log(`[PITCH-OFFSET] deck ${id} ${((newRate-1)*100).toFixed(2)}% (rate=${newRate.toFixed(4)}, method=${method}, effBpm=${(nativeBpm*newRate).toFixed(2)}${synced?", was synced":""})`);
                }
              };
              const resetRate = () => {
                if (Math.abs(rate - 1) < 1e-6) return;
                onPitchInteract?.(id);
                setRate(1);
                onChange?.("rate", 1);
                logEvent("pitch", "reset", {
                  deck: id,
                  trackId: loadFromLibrary?.track?.id || null,
                  prevPct: (rate - 1) * 100,
                  wasSynced: synced,
                  method: "reset",
                });
                console.log(`[PITCH-RESET] deck ${id} prevRate=${rate.toFixed(4)}${synced?", was synced":""}`);
              };
              const bpmTip = effectiveBpm
                ? `Natural BPM ${effectiveBpm.toFixed(1)}${atNative?"":` · pitch ${pctOff>0?"+":""}${pctOff.toFixed(1)}%`}`
                : undefined;
              const pctTip = !enabled ? undefined
                : synced ? "Pitch (synced) · drag, scroll, or double-click to reset"
                : "Pitch · drag, scroll, or double-click to reset";
              const pctColor = enabled ? "#9CA3AF" : "#5A5E66";
              const pctText = atNative ? "0.0%" : `${pctOff>0?"+":""}${pctOff.toFixed(1)}%`;
              return (
                <div style={{display:"flex", flexDirection:"column", alignItems:"flex-end", gap:4}}>
                  {/* BPM number — hero, 28 px */}
                  <div title={bpmTip} style={{fontSize:28, fontFamily:"'Inter',sans-serif", fontWeight:600, color:effectiveBpm?"#F5F5F7":"#2a2a2a", lineHeight:0.95, letterSpacing:-0.5, fontVariantNumeric:"tabular-nums"}}>
                    {adjustedBpm!=null?adjustedBpm.toFixed(1):"—"}
                  </div>
                  {/* Inline pitch row — readout left, ± buttons right.
                      Buttons drive the row height (24 px). Readout is
                      vertically centered. Gap separates the two halves so
                      the eye reads "value · controls" cleanly. */}
                  <div style={{display:"flex", alignItems:"center", gap:8}}>
                    <PitchReadout rate={rate} nativeBpm={nativeBpm} enabled={enabled} displayText={pctText} tooltip={pctTip} color={pctColor} onApply={applyRate} onReset={resetRate}/>
                    <PitchNudge rate={rate} nativeBpm={nativeBpm} enabled={enabled} synced={synced} onApply={applyRate}/>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
        <input ref={fr} type="file" accept="audio/*" style={{display:"none"}} onChange={e=>{ const f=e.target.files[0]; e.target.value=""; if(f) load(f); }}/>
      </div>

      {/* ── OVERVIEW STRIP — full track structure ──
           Collapses to zero height when the Beat Grid panel below opens,
           freeing vertical space for the panel without growing the deck card.
           The big zoomed waveform above the deck row remains the primary
           grid-editing visual, so losing the small overview during editing
           is acceptable. */}
      <div style={{borderTop:BD, borderBottom: gridPanelOpen ? "none" : BD, background:"#06070A",
                   maxHeight: gridPanelOpen ? 0 : 42, overflow: "hidden",
                   transition: "max-height 200ms cubic-bezier(0.4, 0, 0.2, 1), border-bottom 200ms cubic-bezier(0.4, 0, 0.2, 1)"}}>
        <WF bands={wfBass?{bass:wfBass,mid:wfMid,high:wfHigh}:null} peaks={wfPeaks} freq={wfFreq} prog={prog} onSeek={local?seek:remoteSeek} h={40} hotCues={hotCues} loopStart={loopStart} loopEnd={loopEnd} loopActive={loopActive} bpm={(bpmResult?.bpm??remote?.bpm)?((bpmResult?.bpm??remote?.bpm)*rate):null} dur={dur} beatPhaseFrac={bpmResult?.beatPhaseFrac??remote?.beatPhaseFrac??null} color={color} analyzing={!!bpmResult?.analyzing} beatTimes={bpmResult?.beatTimes??remote?.beatTimes??null} beatAttacks={bpmResult?.beatAttacks??remote?.beatAttacks??null}/>
      </div>

      {/* ── BEAT GRID PANEL (Phase 3, Commits 1+2) ──
           Slides down into the space the overview strip + cue chips row
           vacate. Two rows:
             Row 1 (BEAT 1) — migrated Set-Beat-1 control + close ×.
             Row 2 (ANCHOR) — ±10 ms nudge stepper (Commit 2).
           Future commits will add BPM override stepper (Commit 3) and
           Auto/Manual badges + Reset (Commit 4). */}
      <div style={{borderBottom: gridPanelOpen ? BD : "none", background: "#15171A",
                   maxHeight: gridPanelOpen ? 126 : 0, overflow: "hidden",
                   transition: "max-height 200ms cubic-bezier(0.4, 0, 0.2, 1), border-bottom 200ms cubic-bezier(0.4, 0, 0.2, 1)"}}>
        {/* Row 1 — BEAT 1 */}
        <div style={{padding: "10px 14px 8px", display: "flex", alignItems: "center", gap: 14, height: 42, boxSizing: "border-box"}}>
          {/* Section label — same uppercase-9px Inter pattern used for other
              meta labels in the deck card (BPM label at line 4499). */}
          <span style={{fontSize: 9, color: "rgba(255,255,255,0.6)", letterSpacing: 2, fontFamily: "'Inter',sans-serif", minWidth: 46}}>BEAT 1</span>
          {/* Migrated Set-Beat-1 vertical bar — same two-tone red/white
              styling as the original transport-row button. Click writes the
              current playhead to gridAnchorSec via onGridEdit (unchanged
              behavior). Bumped 4×18 → 6×22 for the panel context where it is
              the primary action rather than a small chip in a busy row. */}
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
                  logEvent("grid", "snap", {
                    deck: id,
                    trackId: loadFromLibrary?.track?.id || null,
                    prevAnchorSec: Number(clamped.toFixed(4)),
                    newAnchorSec: Number(result.position.toFixed(4)),
                    source: "snap_to_transient",
                  });
                  onGridEdit({ gridAnchorSec: result.position });
                }}
                disabled={!canEdit}
                title={canEdit ? "Set beat 1 at playhead" : "Load a track to edit the grid"}
                style={{
                  width: 6, height: 22, padding: 0,
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
                <div style={{ flex: 1, background: "rgba(255,255,255,0.9)", cursor: "inherit" }}/>
                <div style={{ flex: 5.5, background: "#FF3B30", cursor: "inherit" }}/>
              </button>
            );
          })()}
          <span style={{fontSize: 11, color: "rgba(255,255,255,0.6)", fontFamily: "'Inter',sans-serif", letterSpacing: 0.2}}>
            Set beat 1 at playhead
          </span>
          {/* Spacer */}
          <div style={{flex: 1}}/>
          {/* Close affordance — also accessible via Escape and via the Grid
              transport button itself (which toggles). */}
          <button onClick={() => setGridPanelOpen(false)}
            title="Close grid panel"
            style={{
              background: "transparent", border: "none", color: "rgba(255,255,255,0.6)",
              cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "2px 4px",
              fontFamily: "'Inter',sans-serif", outline: "none",
              transition: "color 150ms cubic-bezier(0.4, 0, 0.2, 1)",
            }}
            onMouseEnter={(e)=>{ e.currentTarget.style.color = "rgba(255,255,255,0.9)"; }}
            onMouseLeave={(e)=>{ e.currentTarget.style.color = "rgba(255,255,255,0.6)"; }}>
            ×
          </button>
        </div>
        {/* Row 2 — ANCHOR nudge (Phase 3, Commit 2).
            Reads the current effective anchor from bpmResult.firstBar1AnchorSec
            (which the parent already merges with any prior user override via
            effectiveBpmResults). Writes a new gridAnchorSec via onGridEdit. The
            override survives re-analysis by construction — setGridEdit's
            gridEditedAt stamp + the parent's _buildUserGrid override layer
            ensure the analyzer can never clobber it. */}
        {(()=>{
          const trackId = loadFromLibrary?.track?.id;
          const effAnchor = bpmResult?.firstBar1AnchorSec;
          const canNudge = !!buf && !!onGridEdit && !!trackId && effAnchor != null && dur > 0;
          const nudge = (offsetSec) => {
            if (!canNudge) return;
            const newAnchor = Math.max(0, Math.min(dur, effAnchor + offsetSec));
            const offsetMs = Math.round(offsetSec * 1000);
            console.log('[GRID-NUDGE]', { deck: id, trackId, offsetMs,
              prevAnchor: effAnchor.toFixed(4), newAnchor: newAnchor.toFixed(4),
              fromOverride: hasOverride });
            onGridEdit({ gridAnchorSec: newAnchor });
            logEvent("grid", "anchor_nudge", {
              deck: id, trackId,
              offsetMs,
              prevAnchorSec: Number(effAnchor.toFixed(4)),
              newAnchorSec: Number(newAnchor.toFixed(4)),
              fromOverride: hasOverride,
            });
          };
          const nudgeBtn = (label, offsetSec, tip) => (
            <button onClick={() => nudge(offsetSec)} disabled={!canNudge} title={tip}
              style={{
                height: 26, padding: "0 12px", minWidth: 64,
                background: "transparent",
                border: `1px solid ${canNudge ? "rgba(255,255,255,0.20)" : "rgba(255,255,255,0.06)"}`,
                color: canNudge ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.30)",
                borderRadius: 5,
                fontFamily: "'Inter',sans-serif", fontSize: 11, fontWeight: 500, letterSpacing: 0.2,
                cursor: canNudge ? "pointer" : "default", outline: "none", flexShrink: 0,
                transition: "all 150ms cubic-bezier(0.4, 0, 0.2, 1)",
                fontVariantNumeric: "tabular-nums",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
              {label}
            </button>
          );
          return (
            <div style={{padding: "0 14px 10px", display: "flex", alignItems: "center", gap: 8, height: 42, boxSizing: "border-box"}}>
              <span style={{fontSize: 9, color: "rgba(255,255,255,0.6)", letterSpacing: 2, fontFamily: "'Inter',sans-serif", minWidth: 46}}>ANCHOR</span>
              {nudgeBtn("− 10 ms", -0.010, canNudge ? "Nudge anchor 10 ms earlier" : "Load a track with an analyzed grid to nudge")}
              {nudgeBtn("+ 10 ms", +0.010, canNudge ? "Nudge anchor 10 ms later" : "Load a track with an analyzed grid to nudge")}
            </div>
          );
        })()}
        {/* Row 3 — BPM override (Phase 3 Commit A).
            Tempo correction for analyzer mis-detection (Palindrome 90→120
            class, half/double-time errors, 3/4-vs-4/4 errors). The override
            pipeline (bpmOverride in IDB → _buildUserGrid → effectiveBpmResults
            merge) was built in earlier commits; this is the UI surface for
            it. Writing bpmOverride via onGridEdit propagates to bpm.results.X
            through the same memo path that anchor edits use — no separate
            grid-rebuild code path. */}
        {(()=>{
          const trackId = loadFromLibrary?.track?.id;
          const effBpm = bpmResult?.bpm;
          const baseEnabled = !!buf && !!onGridEdit && !!trackId && effBpm > 0;
          const inRange = (v) => v >= 60 && v <= 200;
          const applyBpm = (newBpm, method, multiplier) => {
            if (!baseEnabled) return;
            const rounded = Math.round(newBpm * 10) / 10;
            if (!inRange(rounded)) return;
            console.log('[GRID-BPM-OVERRIDE]', { deck: id, trackId,
              prevBpm: Number(effBpm.toFixed(2)), newBpm: rounded, method,
              ...(multiplier != null ? { multiplier } : {}) });
            logEvent("grid", "bpm_override", {
              deck: id, trackId,
              prevBpm: Number(effBpm.toFixed(2)),
              newBpm: rounded,
              method,
              ...(multiplier != null ? { multiplier } : {}),
            });
            onGridEdit({ bpmOverride: rounded });
          };
          const multBtn = (label, factor, tip) => {
            const candidate = effBpm * factor;
            const enabled = baseEnabled && inRange(Math.round(candidate * 10) / 10);
            const tooltip = !baseEnabled
              ? "Load a track with an analyzed BPM to override"
              : enabled
                ? tip
                : `${label} would give ${Math.round(candidate * 10) / 10} — out of range (60-200)`;
            return (
              <button onClick={() => applyBpm(candidate, "multiplier", factor)}
                disabled={!enabled} title={tooltip}
                style={{
                  height: 26, padding: "0 10px", minWidth: 52,
                  background: "transparent",
                  border: `1px solid ${enabled ? "rgba(255,255,255,0.20)" : "rgba(255,255,255,0.06)"}`,
                  color: enabled ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.30)",
                  borderRadius: 5,
                  fontFamily: "'Inter',sans-serif", fontSize: 11, fontWeight: 500, letterSpacing: 0.2,
                  cursor: enabled ? "pointer" : "default", outline: "none", flexShrink: 0,
                  transition: "all 150ms cubic-bezier(0.4, 0, 0.2, 1)",
                  fontVariantNumeric: "tabular-nums",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                {label}
              </button>
            );
          };
          const commitTyped = () => {
            if (!baseEnabled) return;
            const parsed = parseFloat(bpmInputValue);
            if (!Number.isFinite(parsed) || !inRange(parsed)) {
              setBpmInputError(true);
              setTimeout(() => {
                setBpmInputError(false);
                setBpmInputValue("");
              }, 800);
              return;
            }
            applyBpm(parsed, "typed");
            setBpmInputValue("");
          };
          const resetEnabled = !!onGridEdit && !!trackId && hasOverride;
          const reset = () => {
            if (!resetEnabled) return;
            // Read from userGridOverride (fresh — derived from lib.library by
            // the parent's useEffect after every setGridEdit). loadFromLibrary
            // .track is the load-time snapshot and does NOT see overrides
            // applied in-session, so reading hadAnchor/hadBpm from it would
            // miss the just-applied override. _buildUserGrid sets
            // `firstBar1AnchorSec` iff gridAnchorSec was overridden, and `bpm`
            // iff bpmOverride was overridden — so field presence on the
            // override object is the authoritative signal.
            const hadAnchor = userGridOverride?.firstBar1AnchorSec != null;
            const hadBpm = userGridOverride?.bpm != null;
            console.log('[GRID-RESET]', { deck: id, trackId, hadAnchor, hadBpm });
            logEvent("grid", "reset", { deck: id, trackId, hadAnchor, hadBpm });
            onGridEdit({ gridAnchorSec: null, bpmOverride: null });
            setBpmInputValue("");
            setBpmInputError(false);
          };
          const placeholder = effBpm > 0 ? effBpm.toFixed(1) : "—";
          return (
            <div style={{padding: "0 14px 10px", display: "flex", alignItems: "center", gap: 8, height: 42, boxSizing: "border-box"}}>
              <span style={{fontSize: 9, color: "rgba(255,255,255,0.6)", letterSpacing: 2, fontFamily: "'Inter',sans-serif", minWidth: 46}}>BPM</span>
              {multBtn("÷ 2", 0.5, "Halve detected BPM (double-time error fix)")}
              {multBtn("× 2", 2,   "Double detected BPM (half-time error fix)")}
              <input
                type="text" inputMode="decimal"
                value={bpmInputValue}
                placeholder={placeholder}
                onChange={(e) => { setBpmInputValue(e.target.value); if (bpmInputError) setBpmInputError(false); }}
                onKeyDown={(e) => { if (e.key === "Enter") commitTyped(); }}
                onBlur={() => { if (bpmInputValue.trim() !== "") commitTyped(); }}
                disabled={!baseEnabled}
                title={baseEnabled ? "Type a BPM (60-200), Enter to apply" : "Load a track with an analyzed BPM"}
                style={{
                  height: 26, width: 76, padding: "0 10px",
                  background: "transparent",
                  border: `1px solid ${bpmInputError ? "rgba(255,59,48,0.7)" : "rgba(255,255,255,0.20)"}`,
                  color: baseEnabled ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.30)",
                  borderRadius: 5,
                  fontFamily: "'Inter',sans-serif", fontSize: 11, fontWeight: 500, letterSpacing: 0.2,
                  fontVariantNumeric: "tabular-nums",
                  outline: "none", textAlign: "center",
                  transition: "border-color 150ms cubic-bezier(0.4, 0, 0.2, 1)",
                  flexShrink: 0,
                }}
              />
              <button onClick={reset} disabled={!resetEnabled}
                title={resetEnabled ? "Clear all grid overrides for this track" : "No overrides to clear"}
                style={{
                  height: 26, padding: "0 12px",
                  background: "transparent",
                  border: `1px solid ${resetEnabled ? "rgba(255,255,255,0.20)" : "rgba(255,255,255,0.06)"}`,
                  color: resetEnabled ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.30)",
                  borderRadius: 5,
                  fontFamily: "'Inter',sans-serif", fontSize: 11, fontWeight: 500, letterSpacing: 0.2,
                  cursor: resetEnabled ? "pointer" : "default", outline: "none", flexShrink: 0,
                  transition: "all 150ms cubic-bezier(0.4, 0, 0.2, 1)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                Reset
              </button>
            </div>
          );
        })()}
      </div>

      {/* ── A–D CUE CHIPS (inline) + COMPACT LOOP ROW ──
           Per design brief: 4 cue chips below transport, NOT a side column.
           Each chip: small color dot · cue letter · timestamp (or em-dash).
           Phase 3 Commit 2: row collapses to zero height when the Beat Grid
           panel above is open, freeing vertical room for the second-row
           anchor nudge stepper without changing the deck card total height.
           Cue/loop interactions while editing the grid are out of mental
           scope — different mental modes, fine to hide one while the other
           is in use. ──
           Outer collapse wrapper:
        */}
      <div style={{maxHeight: gridPanelOpen ? 0 : 60, overflow: "hidden",
                   transition: "max-height 200ms cubic-bezier(0.4, 0, 0.2, 1)"}}>
      {/* Original styling preserved inside the collapse wrapper:
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
      </div>

      {/* ── TRANSPORT — Grid · Cue · Skip · Play · Skip · Sync · M.
           Elapsed/Remain moved inline with the track title (v5) so this row
           is now just transport actions, centered.
           Phase 3 Commit 1: the standalone Set-Beat-1 vertical bar that
           used to live at the leftmost position was migrated INTO the Beat
           Grid panel (rendered above the cue chips row). The Grid button
           here toggles that panel.
           Pitch nudge is intentionally NOT in this row — it lives in the
           BPM cluster up in the header (Rekordbox/Beatport convention,
           reads as "tuning the BPM" rather than another transport action). ── */}
      <div style={{display:"flex", alignItems:"center", gap:8, padding:"8px 12px", borderBottom:BD, justifyContent:"center"}}>
        {/* Grid panel toggle. Carries a small white-at-0.9 dot when the
            currently-loaded track has a user override (gridAnchorSec or
            bpmOverride set), so users can see at a glance from the transport
            row that this track is on manual values. The dot indicator is
            scaffolded here in Commit 1; the inside-panel Auto/Manual badges
            land in Commit 4. */}
        <button onClick={() => setGridPanelOpen(o => !o)}
          title={gridPanelOpen ? "Close grid panel" : "Open grid panel"}
          style={{height:38, padding:"0 12px", minWidth: 56,
            background: gridPanelOpen ? "rgba(255,255,255,0.10)" : "transparent",
            border: `1px solid ${gridPanelOpen ? "rgba(255,255,255,0.30)" : "rgba(255,255,255,0.12)"}`,
            color: gridPanelOpen ? "#F5F5F7" : (hasOverride ? "#F5F5F7" : "#9CA3AF"),
            borderRadius:6,
            fontFamily:"'Inter',sans-serif", fontSize:12, fontWeight:500, letterSpacing:.3,
            cursor:"pointer", outline:"none", flexShrink:0,
            transition:"all 150ms cubic-bezier(0.4, 0, 0.2, 1)",
            display:"flex", alignItems:"center", gap:6, justifyContent:"center",
          }}>
          Grid
          {hasOverride && (
            <span style={{width:5, height:5, borderRadius:"50%", background:"rgba(255,255,255,0.9)", flexShrink:0}}/>
          )}
        </button>
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

// ── NewTracksBanner — Phase 2 in-context surface ─────────────────────────
// Renders above the library track list (or inline inside LibraryEmptyState's
// connected state when the library is empty) whenever the most recent scan
// has produced unimported candidates OR an import is in progress. Three
// visual states, switched purely on hook state:
//
//   1. Default              — "N new tracks found in <folder>." + buttons
//   2. Importing in flight  — "Importing M of N…" + thin progress rail
//   3. Empty                — returns null (no banner)
//
// Aesthetic per Phase 2 plan: Quiet Pro Tool — sentence case, white at
// varying opacity, no glassmorphism, 150ms cubic-bezier transitions.
function NewTracksBanner({ lib, onReview }) {
  const tracks = lib.pendingNewTracks || [];
  const progress = lib.importProgress;
  // Shared shell so the importing/default variants visually agree.
  // Background is bumped one opacity tier above the row-hover tone
  // (rgba 0.04) and border is in the third white-at-opacity tier
  // (0.14 — between divider 0.10 and primary 0.18) so the banner
  // reads as a discrete action surface against the panel background
  // without resorting to glassmorphism, shadow, or gradient.
  const shell = {
    padding: "16px 18px",
    margin: "12px 14px",
    background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.14)",
    borderRadius: 6,
    fontFamily: "'Inter',sans-serif",
  };
  if (progress) {
    const pct = progress.total
      ? Math.min(100, Math.round((progress.current / progress.total) * 100))
      : 0;
    return (
      <div style={shell}>
        <div style={{ fontSize: 13, color: "#F5F5F7", letterSpacing: 0.2, marginBottom: 10 }}>
          Importing {progress.current} of {progress.total}…
        </div>
        <div style={{ height: 3, background: "rgba(255,255,255,0.06)", borderRadius: 2, overflow: "hidden" }}>
          <div style={{
            height: "100%",
            width: pct + "%",
            background: "rgba(255,255,255,0.6)",
            transition: "width 150ms cubic-bezier(0.4, 0, 0.2, 1)",
          }}/>
        </div>
      </div>
    );
  }
  if (tracks.length === 0) return null;
  const folderNames = Array.from(new Set(tracks.map(t => t.folderName).filter(Boolean)));
  const folderLabel = folderNames.length === 0
    ? ""
    : folderNames.length === 1
      ? " in " + folderNames[0]
      : " across " + folderNames.length + " folders";
  const btn = {
    padding: "7px 14px",
    fontSize: 12,
    fontFamily: "'Inter',sans-serif",
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.18)",
    color: "#F5F5F7",
    borderRadius: 5,
    cursor: "pointer",
    letterSpacing: 0.2,
    transition: "all 150ms cubic-bezier(0.4, 0, 0.2, 1)",
    outline: "none",
  };
  const btnSubtle = { ...btn, background: "transparent", color: "rgba(255,255,255,0.6)" };
  const hoverOn = (e, primary = true) => {
    e.currentTarget.style.background = primary ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.04)";
    e.currentTarget.style.borderColor = "rgba(255,255,255,0.30)";
    if (!primary) e.currentTarget.style.color = "#F5F5F7";
  };
  const hoverOff = (e, primary = true) => {
    e.currentTarget.style.background = primary ? "rgba(255,255,255,0.06)" : "transparent";
    e.currentTarget.style.borderColor = "rgba(255,255,255,0.18)";
    if (!primary) e.currentTarget.style.color = "rgba(255,255,255,0.6)";
  };
  return (
    <div style={{ ...shell, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
      <div style={{ fontSize: 13, color: "#F5F5F7", letterSpacing: 0.2 }}>
        {tracks.length} new track{tracks.length === 1 ? "" : "s"} found{folderLabel}.
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => lib.commitPendingNewTracks()}
          onMouseEnter={e => hoverOn(e, true)} onMouseLeave={e => hoverOff(e, true)}
          style={btn}>Import them</button>
        <button onClick={onReview}
          onMouseEnter={e => hoverOn(e, true)} onMouseLeave={e => hoverOff(e, true)}
          style={btn}>Review first</button>
        <button onClick={() => lib.dismissPendingNewTracks()}
          onMouseEnter={e => hoverOn(e, false)} onMouseLeave={e => hoverOff(e, false)}
          style={btnSubtle}>Skip</button>
      </div>
    </div>
  );
}

// ── ReviewTracksModal — Phase 2 "Review first" selection surface ─────────
// Centered overlay; lets the user uncheck individual scan results before
// committing. Composite key (folderId:relativePath) per track — same key
// commitPendingNewTracks expects. Closes on Cancel / Escape / backdrop
// click. Reuses module-level cleanFilename + parseArtistTitle so the
// modal shows a parsed Title / Artist where the filename gives one.
function ReviewTracksModal({ lib, onClose }) {
  const tracks = lib.pendingNewTracks || [];
  const keyOf = (t) => t.folderId + ":" + t.relativePath;
  const [selected, setSelected] = useState(() => new Set(tracks.map(keyOf)));
  // Escape-key close — registered once, cleaned up on unmount.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const allSelected = tracks.length > 0 && selected.size === tracks.length;
  const noneSelected = selected.size === 0;
  const toggleOne = (k) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(tracks.map(keyOf)));
  const onImport = async () => {
    const snapshot = new Set(selected);
    onClose();
    await lib.commitPendingNewTracks(snapshot);
  };
  // Filename-derived display name. parseArtistTitle returns {artist, title}
  // when the filename matches "Artist - Title" — otherwise title falls back
  // to the cleaned filename and artist is empty.
  const display = (t) => {
    const cleaned = cleanFilename(t.name);
    const parsed = parseArtistTitle(cleaned);
    return { title: parsed.title || cleaned, artist: parsed.artist || "" };
  };
  return (
    <div onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 10000, fontFamily: "'Inter',sans-serif",
      }}>
      <div onClick={e => e.stopPropagation()}
        style={{
          width: "min(520px, 92vw)", maxHeight: "70vh",
          background: "#0D0F12", border: "1px solid rgba(255,255,255,0.10)",
          borderRadius: 8, display: "flex", flexDirection: "column",
          boxShadow: "0 12px 48px rgba(0,0,0,0.5)",
        }}>
        {/* Header */}
        <div style={{ padding: "16px 18px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 14, color: "#F5F5F7", letterSpacing: 0.3, marginBottom: 2 }}>Review new tracks</div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", letterSpacing: 0.2 }}>
              {selected.size} of {tracks.length} selected
            </div>
          </div>
          <button onClick={onClose} aria-label="Close"
            style={{
              background: "transparent", border: "none", color: "rgba(255,255,255,0.6)",
              fontSize: 18, cursor: "pointer", padding: "4px 10px", lineHeight: 1,
              transition: "color 150ms cubic-bezier(0.4, 0, 0.2, 1)",
            }}
            onMouseEnter={e => e.currentTarget.style.color = "#F5F5F7"}
            onMouseLeave={e => e.currentTarget.style.color = "rgba(255,255,255,0.6)"}>×</button>
        </div>
        {/* Select-all row */}
        <div style={{ padding: "10px 18px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", gap: 10 }}>
          <input type="checkbox" checked={allSelected}
            ref={el => { if (el) el.indeterminate = !allSelected && !noneSelected; }}
            onChange={toggleAll}
            style={{ width: 14, height: 14, accentColor: "rgba(255,255,255,0.85)", cursor: "pointer" }}/>
          <span style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", letterSpacing: 0.2, cursor: "pointer" }} onClick={toggleAll}>
            {allSelected ? "Deselect all" : "Select all"}
          </span>
        </div>
        {/* Scrollable list */}
        <div style={{ overflow: "auto", flex: 1 }}>
          {tracks.map(t => {
            const k = keyOf(t);
            const checked = selected.has(k);
            const { title, artist } = display(t);
            return (
              <label key={k}
                style={{
                  display: "flex", alignItems: "center", gap: 12,
                  padding: "10px 18px", cursor: "pointer",
                  borderBottom: "1px solid rgba(255,255,255,0.04)",
                  transition: "background 150ms cubic-bezier(0.4, 0, 0.2, 1)",
                }}
                onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.025)"}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <input type="checkbox" checked={checked} onChange={() => toggleOne(k)}
                  style={{ width: 14, height: 14, accentColor: "rgba(255,255,255,0.85)", cursor: "pointer", flexShrink: 0 }}/>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12, color: "#F5F5F7", letterSpacing: 0.15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.55)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", letterSpacing: 0.2 }}>
                    {artist ? artist + " · " : ""}{t.folderName}/{t.relativePath}
                  </div>
                </div>
              </label>
            );
          })}
        </div>
        {/* Footer */}
        <div style={{ padding: "12px 18px", borderTop: "1px solid rgba(255,255,255,0.06)", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose}
            style={{
              padding: "7px 14px", fontSize: 12, fontFamily: "'Inter',sans-serif",
              background: "transparent", border: "1px solid rgba(255,255,255,0.18)",
              color: "rgba(255,255,255,0.7)", borderRadius: 5, cursor: "pointer", letterSpacing: 0.2,
              transition: "all 150ms cubic-bezier(0.4, 0, 0.2, 1)",
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.30)"; e.currentTarget.style.color = "#F5F5F7"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.18)"; e.currentTarget.style.color = "rgba(255,255,255,0.7)"; }}>Cancel</button>
          <button onClick={onImport} disabled={noneSelected}
            style={{
              padding: "7px 14px", fontSize: 12, fontFamily: "'Inter',sans-serif",
              background: noneSelected ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.10)",
              border: "1px solid " + (noneSelected ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.30)"),
              color: noneSelected ? "rgba(255,255,255,0.4)" : "#F5F5F7",
              borderRadius: 5, cursor: noneSelected ? "default" : "pointer", letterSpacing: 0.2,
              transition: "all 150ms cubic-bezier(0.4, 0, 0.2, 1)",
            }}
            onMouseEnter={e => { if (!noneSelected) { e.currentTarget.style.background = "rgba(255,255,255,0.14)"; } }}
            onMouseLeave={e => { if (!noneSelected) { e.currentTarget.style.background = "rgba(255,255,255,0.10)"; } }}>
            Import {selected.size} selected
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Library empty-state CTA (Phase 1 redesign — May 29 evening pivot) ────
// Replaces the original Commit-3 strip + modal + mode-toggle surface. Per
// the strategic pivot in VISION_5.md: pro DJs think in "where's my music,"
// not in "watched folders" or "Auto-Finder / Manager / Hybrid modes." This
// component is the single user-facing surface for Phase 1 — one CTA, one
// folder pick, honest expectation-setting about Phase 2 scanning.
//
// Phase 2 update: the connected-state branch is now state-aware. When a
// scan is in flight, when scan-found pending tracks exist, or when the
// library has been scanned recently with no new tracks, the copy reflects
// the actual state instead of the Phase 1 "Auto-scanning launches soon"
// placeholder. The actionable "N new tracks found" surface is rendered by
// NewTracksBanner above the empty-state in LibraryPanelV2's CENTER, so
// when hasPending is true this component intentionally stays quiet to
// avoid duplicating the announcement.
function LibraryEmptyState({ lib }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const supported = lib.fsaSupported;
  const folders = lib.watchedFolders;
  const connected = folders.length > 0;
  // Bias the picker toward ~/Downloads — the highest-traffic location for
  // newly acquired DJ music across Beatport / Bandcamp / DJ pools / AirDrop /
  // promo emails. Chrome's startIn parameter only positions the picker; the
  // user still has to confirm. For the 5% of users with music elsewhere
  // they navigate from the picker just as before.
  const onConnect = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try { await lib.addWatchedFolder({ startIn: "downloads" }); }
    catch (err) { setError(err?.message || String(err)); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"96px 32px", fontFamily:"'Inter',sans-serif", textAlign:"center", color:"#F5F5F7" }}>
      {!connected && (
        <>
          <div style={{ fontSize:18, letterSpacing:0.3, color:"#F5F5F7", marginBottom:24 }}>No tracks yet</div>
          {supported ? (
            <button onClick={onConnect} disabled={busy}
              style={{
                padding:"10px 22px", fontSize:13, fontFamily:"'Inter',sans-serif",
                background: busy ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.06)",
                border:`1px solid ${busy ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.18)"}`,
                color: busy ? "rgba(255,255,255,0.5)" : "#F5F5F7",
                borderRadius:6, cursor: busy ? "default" : "pointer", outline:"none",
                letterSpacing:0.3,
                transition:"all 150ms cubic-bezier(0.4, 0, 0.2, 1)",
              }}
              onMouseEnter={e => { if (!busy) { e.currentTarget.style.background = "rgba(255,255,255,0.10)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.30)"; } }}
              onMouseLeave={e => { if (!busy) { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.18)"; } }}
            >{busy ? "Connecting…" : "Connect your music"}</button>
          ) : (
            <div style={{ fontSize:13, color:"rgba(255,255,255,0.7)", lineHeight:1.55, letterSpacing:0.2, maxWidth:380 }}>
              Folder connect requires Chrome or Edge. Drop tracks here or use &ldquo;+ Add music&rdquo; to import manually.
            </div>
          )}
          {supported && <div style={{ fontSize:11, color:"#5A5E66", marginTop:14, letterSpacing:0.2 }}>or drop tracks here</div>}
          {supported && <div style={{ fontSize:11, color:"#5A5E66", marginTop:40, maxWidth:340, lineHeight:1.55, letterSpacing:0.2 }}>Mix//Sync scans the folder and imports the music it finds.</div>}
          {supported && <div style={{ fontSize:10, color:"rgba(255,255,255,0.25)", marginTop:14, letterSpacing:0.4 }}>Supports MP3, WAV, FLAC, AAC, OGG, M4A</div>}
        </>
      )}
      {connected && (() => {
        // Phase 2 — copy reflects ACTUAL state instead of the Phase 1
        // "Auto-scanning launches soon" placeholder. Banner above the empty
        // state (in LibraryPanelV2) carries the actionable "X new tracks
        // found" surface, so the empty-state copy here only needs to
        // disambiguate the no-banner cases.
        const hasPending = (lib.pendingNewTracks || []).length > 0;
        const lastScannedAt = folders.reduce((acc, f) => Math.max(acc, f.lastScannedAt || 0), 0);
        const since = lastScannedAt ? Date.now() - lastScannedAt : 0;
        // Inline relative-time. Beyond a few hours we just say "earlier"
        // so the copy doesn't claim more precision than is useful.
        let lastChecked = "";
        if (lastScannedAt) {
          if (since < 60_000) lastChecked = "just now";
          else if (since < 60 * 60_000) lastChecked = Math.floor(since / 60_000) + "m ago";
          else if (since < 24 * 60 * 60_000) lastChecked = Math.floor(since / (60 * 60_000)) + "h ago";
          else lastChecked = "earlier";
        }
        let primaryLine, secondaryLine;
        if (lib.scanning) {
          const found = lib.scanProgress?.found || 0;
          primaryLine = found > 0
            ? "Scanning… found " + found + " track" + (found === 1 ? "" : "s") + " so far."
            : "Scanning…";
          secondaryLine = null;
        } else if (hasPending) {
          // Banner above renders the actionable surface. Empty state stays quiet.
          primaryLine = null;
          secondaryLine = null;
        } else if (lastScannedAt) {
          primaryLine = "Library up to date.";
          secondaryLine = "Last checked " + lastChecked + ".";
        } else {
          primaryLine = null;
          secondaryLine = "Drop tracks here or use “+ Add music” to import manually.";
        }
        return (
          <>
            <div style={{ display:"flex", alignItems:"center", gap:8, fontSize:13, color:"#F5F5F7", letterSpacing:0.3, marginBottom:18 }}>
              <span style={{ display:"inline-block", width:6, height:6, borderRadius:"50%", background:"#22c55e", boxShadow:"0 0 8px rgba(34,197,94,0.4)" }}/>
              Connected: {folders.map(f => f.name).join(", ")}
            </div>
            {primaryLine && (
              <div style={{ fontSize:12, color:"rgba(255,255,255,0.7)", maxWidth:380, lineHeight:1.55, letterSpacing:0.2, marginBottom:secondaryLine ? 14 : 0 }}>
                {primaryLine}
              </div>
            )}
            {secondaryLine && (
              <div style={{ fontSize:11, color:"#5A5E66", maxWidth:380, lineHeight:1.55, letterSpacing:0.2 }}>
                {secondaryLine}
              </div>
            )}
          </>
        );
      })()}
      {error && (
        <div style={{ marginTop:22, padding:"8px 12px", background:"rgba(239,68,68,0.08)", border:"1px solid rgba(239,68,68,0.2)", borderRadius:5, fontSize:11, color:"#ef4444", letterSpacing:0.2, maxWidth:380 }}>
          {error}
        </div>
      )}
    </div>
  );
}

// ── (removed May 29 evening — see VISION_5.md "Library architecture
//     strategic pivot") The LibraryControlStrip, LibrarySettingsModal,
//     SuggestionRow, and FolderRow components shipped in commit f9f3ab1
//     were removed in the same-session pivot. The underlying FSA helpers
//     in src/utils/fsa.js and useLibrary plumbing remain — only the UI
//     surface was redesigned, replaced by LibraryEmptyState above and the
//     "+ Add another location" sidebar button.

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
  const [hover, setHover]   = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(buildInviteLink(room, mixName)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  };
  const bg = copied
    ? "rgba(34,197,94,0.10)"
    : hover ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.05)";
  const color = copied ? "#22c55e" : hover ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.7)";
  const border = copied ? "1px solid rgba(34,197,94,0.35)" : "1px solid rgba(255,255,255,0.12)";
  return (
    <button
      onClick={copy}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: bg, border, color,
        fontFamily:"'Inter',sans-serif", fontWeight:500, fontSize:10, letterSpacing:.4,
        height:22, padding:"0 12px", borderRadius:5,
        cursor:"pointer", outline:"none",
        transition:"background 150ms cubic-bezier(0.4, 0, 0.2, 1), color 150ms cubic-bezier(0.4, 0, 0.2, 1), border-color 150ms cubic-bezier(0.4, 0, 0.2, 1)",
      }}>
      {copied ? "Link copied" : "Invite partner"}
    </button>
  );
}

// ── Session Lobby (after clicking Launch) ────────────────────
function Lobby({ onJoin, djName = null }) {
  const [room] = useState(() => getOrCreateRoomId());
  // Default name combines a word from a small pool with a 4-char hex
  // suffix. The pool alone collided at ~16.7% per pair (e.g. tonight's
  // Jake/Chad both rolled "DJ Nova"). 6-pool × 65,536 suffix lowers that
  // to ~1 in 400k — effectively zero for any realistic session size. The
  // suffix is visible in the Lobby input so users can either keep it,
  // overwrite it, or simply edit the word part.
  const [name, setName] = useState(djName || (() => {
    const word = ["Apex","Nova","Flux","Orbit","Prism","Echo"][Math.floor(Math.random()*6)];
    const suffix = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
    return `DJ ${word} ${suffix}`;
  })());
  const [mixName, setMixName] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("mix") || "";
  });
  const [copied, setCopied] = useState(false);
  // Join-by-code: lets a partner type a mix code (e.g., "fade-wave-691")
  // when they only have the code verbally, no invite link. Without this,
  // the only path into an existing room was the ?room= URL — users on
  // the bare base URL always got a fresh random room.
  const [joinCode, setJoinCode] = useState("");
  const isJoining = useMemo(() => {
    return new URLSearchParams(window.location.search).has("room");
  }, []);
  const submitJoinCode = () => {
    const code = normalizeRoomCode(joinCode);
    if (!code) return;
    // JOIN BY MIX CODE is always a joiner — the user typed an existing
    // partner's mix code, they didn't create the room.
    onJoin({ url: SERVER_URL, room: code, name, mixName: mixName || "Untitled Mix", isHost: false });
  };

  // Auto-join immediately if a name was passed in from the landing page.
  // isJoining reflects whether the URL had ?room= at mount — that's the
  // only signal we have here for whether the user is creating or joining.
  useEffect(() => {
    if (djName) onJoin({ url: SERVER_URL, room, name: djName, mixName: mixName || "Untitled Mix", isHost: !isJoining });
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

        {/* Join button — matches App.jsx btn-gold. isHost reflects the
            mode: START MIX (no ?room= in URL → creator) vs JOIN MIX
            (?room= in URL → joiner via invite link). */}
        <button
          onClick={() => onJoin({ url: SERVER_URL, room, name, mixName: mixName || "Untitled Mix", isHost: !isJoining })}
          style={{ background:G, border:"none", color:"#0D0F12", fontFamily:"'Inter',sans-serif", fontWeight:500, fontSize:12, letterSpacing:2, padding:"15px", borderRadius:10, cursor:"pointer", boxShadow:`0 0 32px ${G}30, 0 8px 20px rgba(0,0,0,.4)`, transition:"all .2s" }}
        >
          {isJoining?"JOIN MIX →":"START MIX →"}
        </button>

        {/* Join-by-code — only in START A MIX mode (an invite link already
            specifies a room, so the input would be redundant there). */}
        {!isJoining && (
          <div style={{ display:"flex", flexDirection:"column", gap:8, paddingTop:4 }}>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <div style={{ flex:1, height:1, background:`${G}18` }}/>
              <div style={{ fontSize:8, fontFamily:"'Inter',sans-serif", color:`${G}55`, letterSpacing:2 }}>OR</div>
              <div style={{ flex:1, height:1, background:`${G}18` }}/>
            </div>
            <label style={{ fontSize:8, fontFamily:"'Inter',sans-serif", color:`${G}77`, letterSpacing:2 }}>JOIN BY MIX CODE</label>
            <div style={{ display:"flex", gap:8 }}>
              <input
                value={joinCode}
                onChange={e => setJoinCode(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") submitJoinCode(); }}
                placeholder="e.g., fade-wave-691"
                style={{ flex:1, background:"#0D0F12", border:`1px solid ${G}33`, color:"#F5F5F7", borderRadius:8, padding:"11px 14px", fontSize:14, fontFamily:"'Inter',sans-serif", fontWeight:500, outline:"none", transition:"border-color 150ms cubic-bezier(0.4, 0, 0.2, 1)" }}
              />
              <button
                onClick={submitJoinCode}
                disabled={!joinCode.trim()}
                style={{ background:"transparent", border:`1px solid ${G}33`, color: joinCode.trim() ? G : `${G}55`, fontFamily:"'Inter',sans-serif", fontWeight:500, fontSize:10, letterSpacing:2, padding:"0 16px", borderRadius:8, cursor: joinCode.trim() ? "pointer" : "default", transition:"all 150ms cubic-bezier(0.4, 0, 0.2, 1)" }}
              >
                JOIN →
              </button>
            </div>
          </div>
        )}

        <div style={{ fontSize:8, fontFamily:"'Inter',sans-serif", color:"#5A5E66", textAlign:"center", letterSpacing:1 }}>
          Chrome · Edge · Free
        </div>
      </div>
    </div>
  );
}

// ── Beat-grid v2 (refined beatTimes) shared helpers ───────────
// Single source of truth for "where the beats are", used by the
// seek-quantize, the SYNC engage phase-align, and the big-waveform
// grid when ?beatsv2=1. Before unification these three disagreed:
// quantize + kick markers read the REFINED beatTimes[] (the actual
// kicks, per-beat REFINE-shifted ±5-25ms) while engage + grid read
// the LINEAR beatPhaseSec/beatPeriodSec reconstruction — they
// differ by the refine deltas, which is the sync regression.
//
// NOTE: nearestBeatTime + refinedBeatPhase are duplicated verbatim
// in tools/smoke/engage_align.smoke.mjs so the headless idempotency
// assertion exercises the SAME math. Keep them in sync.

// Nearest analyzed beat time (seconds) to t. beats[] sorted ascending.
// Binary search, O(log n). Returns null on empty input.
function nearestBeatTime(beats, t) {
  if (!beats || beats.length === 0) return null;
  let lo = 0, hi = beats.length - 1;            // first beat >= t
  while (lo < hi) { const mid = (lo + hi) >> 1; if (beats[mid] < t) lo = mid + 1; else hi = mid; }
  let nearest = beats[lo];
  if (lo > 0 && Math.abs(beats[lo - 1] - t) <= Math.abs(beats[lo] - t)) nearest = beats[lo - 1];
  return nearest;
}

// Local refined-beat phase at time t: the beat interval containing t,
// the fraction elapsed through it, and that interval's period (sec).
// Clamps to the first/last interval at the analyzed-range edges so the
// engage phase math never divides by zero. Returns null if <2 beats or
// a degenerate (non-positive) interval. frac can be <0 / >1 when t sits
// outside the analyzed beats — callers wrap the master/slave difference
// to [-0.5,0.5] so that is harmless.
function refinedBeatPhase(beats, t) {
  if (!beats || beats.length < 2) return null;
  let lo = 0, hi = beats.length - 1;            // index of last beat <= t
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (beats[mid] <= t) lo = mid; else hi = mid - 1; }
  let i = lo;
  if (i >= beats.length - 1) i = beats.length - 2;   // clamp to last interval
  const period = beats[i + 1] - beats[i];
  if (!(period > 0)) return null;
  const frac = (t - beats[i]) / period;
  return { index: i, frac, period };
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
  // ── Sync Phase 1 measurement plumbing ────────────────────────────────
  // Cristian's clock-offset estimator. Fed by sync_ping/sync_pong round
  // trips bounced off the partner via the WS relay. Read by the phase-
  // error monitor and the debug HUD. Measurement-only — never used to
  // change behavior in Phase 1.
  const clockSyncRef = useRef(createClockSync());
  // Latest progress packet metadata per deck, captured from partner's
  // deck_update field:"progress" broadcasts. tSend = partner's
  // performance.now() at queue time (added by useSync.send); value = the
  // progress fraction [0,1]; tRecvLocal = my performance.now() at receive.
  // Used to estimate partner playhead "now" via lastValue + (myNow_adjusted
  // - tSend) × rate. Engage timestamp for "ms since engage" telemetry.
  const partnerProgressMetaRef = useRef({ A: null, B: null });
  const engageTimeMsRef        = useRef(null);
  // Throttle the [SYNC-DRIFT] console log + telemetry. The monitor effect
  // re-runs on every pA/pB progress packet (and calls sample() immediately each
  // time), so unthrottled it emitted 400-600 lines/sec on the slave — a log
  // firehose that drowned every other event over an hour-long session. The HUD
  // (syncStatsRef) still updates every sample; only the logging is gated.
  const driftLogTsRef          = useRef(0);
  // Latest computed sync stats — drives the debug HUD without triggering
  // re-renders on every monitor tick.
  const syncStatsRef = useRef({
    offset: 0, confidence: 0, rttMedian: null, rttSpread: null, sampleCount: 0,
    phaseErrorMs: null, msSinceEngage: null, monitorReason: "idle",
  });
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
  // Authoritative "did this client create the room" flag — written by
  // join() from info.isHost (set explicitly by each call site). Prior
  // approach inferred host-ness from URL `?room=` presence at mount,
  // which broke for the JOIN BY MIX CODE path (joiner arrives at bare
  // URL same as creator, so URL-based inference saw both as host) and
  // for cm_session restore after URL stripping (joiner refreshes,
  // gets stripped URL, flips to host). Now every call site declares
  // its own role and join() persists it into cm_session for refresh
  // resilience.
  const iAmHostRef              = useRef(null);
  const [rtcReconnectExhausted, setRtcReconnectExhausted] = useState(false);
  // Output-truth flag: true when a deck I drive is playing but my master bus is
  // emitting no signal (the booth-silence failure mode). Drives the AUDIO chip
  // so the indicator reflects ACTUAL local output, not just the WebRTC link.
  const [outputSilent, setOutputSilent] = useState(false);

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
  // Mirror the effective per-deck grid into a ref so the smoke __deckGrid hook
  // can read what the deck ACTUALLY consumes (analyzer vs imported rekordbox)
  // at call time, not the stale value captured when the hook effect mounted.
  const effGridRef = useRef(null);
  effGridRef.current = effectiveBpmResults;
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
  // The pre-Commit-1 nudge state (gridOffsetA/B, barOneA/B) was never
  // exposed via UI, so the localStorage values were always 0 in practice.
  // User grid edits now live on the IDB track record (gridAnchorSec,
  // bpmOverride) and flow through effectiveBpmResults declared above —
  // every consumer of bpm.results.X automatically picks up the effective
  // grid, including the sync path, the beat-skip buttons, and the partner
  // broadcast. The variables below are kept as zero constants only to
  // satisfy the downstream JSX in <AnimatedZoomedWF> and <Deck> until a
  // future commit retires those props alongside the new Grid Edit toolbar.
  // The math at AnimatedZoomedWF:firstDownbeatSec is
  //   beatPhaseFrac × beatPeriodSec + gridOffsetMs/1000 + barOneOffsetSec
  // with the new pipeline, gridOffsetMs and barOneOffsetSec contribute 0
  // and the first two terms already include any user override via
  // effectiveBpmResults.
  // bpmNudge (originally part of this retired triplet) was fully removed
  // when the Pitch Nudge cluster shipped — pitch offset now lives in each
  // deck's `rate` state, not in a separate per-track override. The legacy
  // localStorage `bpmNudge:` key migration below still sweeps any stale
  // entries from old builds.
  const gridOffsetA = 0, gridOffsetB = 0;
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
  // Door 3: build the rekordbox-grid override from the LOADED TRACK RECORD when
  // it was imported from rekordbox.xml (carries beatTimes + gridSource). Carries
  // beatTimes so the unified path (grid/engage/quantize) consumes it; the linear
  // fields are derived for legacy fallback. Higher precedence than the analyzer.
  const rkGridFromRecord = (track) => {
    if (!track || track.gridSource !== "rekordbox" || !Array.isArray(track.beatTimes) || track.beatTimes.length < 2) return null;
    const period = track.beatPeriodSec || (track.bpm ? 60 / track.bpm : null);
    const anchor = track.firstBar1AnchorSec ?? track.gridAnchorSec ?? track.beatTimes[0];
    return {
      bpm: track.bpm || null, beatTimes: track.beatTimes, beatPeriodSec: period, firstBar1AnchorSec: anchor,
      beatPhaseSec: (period > 0 && anchor != null) ? anchor % period : null,
      beatPhaseFrac: (period > 0 && anchor != null) ? anchor / period : null,
      gridSource: "rekordbox",
    };
  };
  useEffect(() => {
    const rec = rkGridFromRecord(libLoadA?.track);
    if (rec) { console.log("[REKORDBOX-A] imported xml grid:", rec.beatTimes.length, "beats, anchor", rec.firstBar1AnchorSec); setRkGridA(rec); return; }
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
    const rec = rkGridFromRecord(libLoadB?.track);
    if (rec) { console.log("[REKORDBOX-B] imported xml grid:", rec.beatTimes.length, "beats, anchor", rec.firstBar1AnchorSec); setRkGridB(rec); return; }
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
    // Identity is djId, NOT display name. deckDrivers[id] is { id, name } | null
    // since the identity fix (33273e5). Comparing that OBJECT to session.name
    // (a string) was the June-2026 booth-silence bug: object !== name is ALWAYS
    // true, so `open` was always false the moment any driver was assigned —
    // muting the driver's OWN decks to trim=0 while the AUDIO chip still read
    // STREAMING. Open the local trim when the deck is unowned OR I drive it;
    // mute only when the PARTNER drives it (their audio reaches me via WebRTC).
    // Read djId via syncRef (populated each render at the syncRef.current=sync
    // effect) — `sync` itself is declared BELOW this effect, so referencing it
    // here (or in the deps) is a temporal-dead-zone crash. deckDrivers only
    // gains my own driver object AFTER djId is known, so re-running on
    // deckDrivers/ready is sufficient to pick up the id.
    const myDjId = syncRef.current?.djId;
    const tc = 0.02;
    for (const id of ["A", "B"]) {
      const driver = deckDrivers[id];
      const open = !driver || driver.id === myDjId;
      try { e[id].trim.gain.setTargetAtTime(open ? 1 : 0, e.ctx.currentTime, tc); } catch {}
    }
  }, [deckDrivers, ready]);

  // Output-truth monitor — the AUDIO chip historically read only rtc.state, so
  // a silent local master (suspended context, or a gain/trim desync) showed
  // "STREAMING" while nothing reached the speakers. This polls the master
  // analyser: if a deck I DRIVE is playing but the master bus reads flat for a
  // sustained window, flag outputSilent so the chip can show NO OUTPUT.
  // Partner-driven audio arrives via a separate <audio> element, never through
  // eng.master, so this level reflects only my own decks — no false positives
  // from partner playback.
  useEffect(() => {
    if (!ready) return;
    const SILENT_LEVEL = 2;   // byte-FFT max below this ≈ digital silence
    const SUSTAIN = 5;        // consecutive silent polls (×400ms ≈ 2s) before flagging
    let silentCount = 0;
    let bins = null;
    const tick = () => {
      const e = eng.current;
      if (!e?.ctx || !e?.masterAn) { silentCount = 0; setOutputSilent(false); return; }
      const myDjId = syncRef.current?.djId; // syncRef, not `sync` (declared below — TDZ)
      const drives = (id) => { const d = deckDriversRef.current?.[id]; return !d || d.id === myDjId; };
      const expectOutput =
        (!!deckPlayStartRef.current.A && drives("A")) ||
        (!!deckPlayStartRef.current.B && drives("B"));
      if (!expectOutput) { silentCount = 0; setOutputSilent(false); return; }
      if (!bins || bins.length !== e.masterAn.frequencyBinCount) bins = new Uint8Array(e.masterAn.frequencyBinCount);
      e.masterAn.getByteFrequencyData(bins);
      let max = 0;
      for (let i = 0; i < bins.length; i++) if (bins[i] > max) max = bins[i];
      const silentNow = e.ctx.state !== "running" || max < SILENT_LEVEL;
      if (silentNow) { silentCount++; if (silentCount >= SUSTAIN) setOutputSilent(true); }
      else { silentCount = 0; setOutputSilent(false); }
    };
    const iv = setInterval(tick, 400);
    return () => clearInterval(iv);
  }, [ready]);

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
    const myDjId = syncRef.current?.djId || null;
    const wsState = syncRef.current?.status;
    console.log('[DRIVER-SEND]', { deck, driverName, myDjId, wsState, hasSync: !!syncRef.current?.send, trackTitle: track.title });
    if (driverName) {
      // Optimistic local set so the loader sees their own driver claim
      // immediately. Only set when djId is known — otherwise skip and rely
      // on the server's echo broadcast (deck_driver_change comes back to
      // sender too). Prevents accidentally nulling the driver during the
      // brief window before the "joined" payload arrives.
      if (myDjId) {
        const optimistic = { id: myDjId, name: driverName };
        setDeckDrivers(prev => prev[deck]?.id === optimistic.id ? prev : { ...prev, [deck]: optimistic });
      }
      const trackMeta = {
        id: track.id,
        title: track.title || track.filename || null,
        artist: track.artist || null,
        bpm: track.bpm || null,
        key: track.key || null,
        duration: track.duration || null,
      };
      syncRef.current?.send?.({ type: "deck_driver_change", deckId: deck, driverName, track: trackMeta });
      console.log('[DRIVER-SEND] dispatched', { deck, driverName, myDjId });
    } else {
      console.warn('[DRIVER-SEND] no driverName — sessionRef.current?.name was null/empty');
    }
    // Defer library-side BPM/key analysis until track is loaded onto a deck.
    // Prevents bulk decoding 100s of tracks at import time which causes OOM.
    if (file && !track.analyzed && lib.queueAnalysis) {
      lib.queueAnalysis(track.id, file);
    }
  }, [lib]);

  // ── Test-only load hook for the two-client smoke suite ───────────────────
  // window.__loadTestTrack(deck, url) fetches a bundled audio fixture and runs
  // it through the EXACT normal load path (inject File → handleLibLoad → decode
  // → analysis → ANALYZER-BROADCAST → driver-send → waveform), not a bypass —
  // so the suite exercises real analysis + mirror + transport. Gated by
  // TEST_HOOKS (dev server or ?smoke=1); absent for production users.
  useEffect(() => {
    if (!TEST_HOOKS || typeof window === "undefined") return;
    window.__loadTestTrack = async (deck, url, overrides) => {
      const d = deck === "B" ? "B" : "A";
      const resp = await fetch(url);
      if (!resp.ok) throw new Error("fixture fetch failed: " + resp.status);
      const file = new File([await resp.blob()], "kick120.wav", { type: "audio/wav" });
      const id = "smoketest-" + d;
      // overrides lets a test inject an imported-grid track (gridSource:'rekordbox',
      // beatTimes, hotCues, analyzed:true) to exercise Door 3.
      const track = { id, title: "Smoke Kick 120", artist: "smoke-fixture", filename: "kick120.wav", analyzed: false, ...(overrides || {}) };
      lib.setFile?.(id, file);            // so handleLibLoad's getFile resolves it
      await handleLibLoad(track, d);
      console.log("[SMOKE-HOOK] loaded test track on deck " + d + " from " + url);
      return true;
    };
    // Programmatic transport so the e2e suite drives play/seek/cue/sync without
    // flaky canvas clicks. These call the deck's REAL fns (same as the UI), so
    // the driver gate, seek_request round-trip, and sync engage all run for real.
    window.__toggleDeck = (deck) => { toggleFnsRef.current[deck === "B" ? "B" : "A"]?.(); return true; };
    window.__seekDeck = (deck, value) => { seekFnsRef.current[deck === "B" ? "B" : "A"]?.(value); return true; };
    window.__cueDeck = (deck) => { cueFnsRef.current[deck === "B" ? "B" : "A"]?.(); return true; };
    window.__syncDeck = (deck) => { handleSyncToggle(deck === "B" ? "B" : "A"); return true; };
    window.__dropWS = () => { syncRef.current?.forceDrop?.(); return true; };   // simulate a network blip
    window.__deckProg = (deck) => (deck === "B" ? progRefB : progRefA).current;  // displayed playhead 0..1 (mirror-motion test)
    // What the deck ACTUALLY consumes through the unified grid path — used by the
    // Door 3 smoke to prove imported rekordbox beatTimes flow into bpm.results and
    // that the desmear gate (the SAME expression the WF prop uses) is off for them.
    window.__deckGrid = (deck) => {
      const g = (effGridRef.current || {})[deck === "B" ? "B" : "A"] || null;
      if (!g) return null;
      const gridSource = g.gridSource || "analyzer";
      return {
        gridSource,
        bpm: g.bpm ?? null,
        beatCount: Array.isArray(g.beatTimes) ? g.beatTimes.length : 0,
        firstBeatSec: Array.isArray(g.beatTimes) ? g.beatTimes[0] : null,
        beatPeriodSec: g.beatPeriodSec ?? null,
        desmearOn: ONSET_GRID && gridSource !== "rekordbox", // mirrors the WF desmear prop
      };
    };
    window.__smokeReady = true;
    console.log("[SMOKE-HOOK] window.__loadTestTrack installed");
    return () => { try { delete window.__loadTestTrack; delete window.__smokeReady; delete window.__deckGrid; } catch {} };
  }, [handleLibLoad, lib]);

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
      const { deckId, driverId, driverName, track } = m;
      const myDjId = syncRef.current?.djId;
      console.log('[DRIVER-RECV]', { deckId, driverId, driverName, from: m.from, myDjId, hasTrack: !!track, trackTitle: track?.title });
      if (deckId === "A" || deckId === "B") {
        const next = driverId ? { id: driverId, name: driverName ?? null } : null;
        setDeckDrivers(prev => prev[deckId]?.id === next?.id ? prev : { ...prev, [deckId]: next });
        // If the broadcast carries track metadata AND it's not from me
        // (id-based, NOT name-based — display-name collisions exist), paint
        // it into partner state immediately. Maps the trackMeta fields onto
        // the same pA/pB shape that the Deck's existing remote.* fallback
        // reads, so the partner deck shows title/artist/bpm/key without
        // waiting for the loader's decode-triggered deck_update broadcasts.
        if (track && driverId && driverId !== myDjId) {
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
      // Symmetric counterpart to [ANALYZER-BROADCAST] — proves the partner
      // actually RECEIVED the refined beat grid (B2B mirror debugging + smoke).
      if (m.field === "beatTimes" && Array.isArray(m.value)) console.log("[ANALYZER-RECV] " + m.deckId + " beats=" + m.value.length);
      if (m.field === "playing") console.log("[TRANSPORT-RECV] " + m.deckId + " playing=" + m.value);
      // Partner play/pause interrupts the stream I receive — re-baseline delay
      // comp. Only on "playing" (NOT every 10Hz "progress" packet).
      if (m.field==="playing") rtcRef.current?.markTransportEvent?.();
      // Capture progress packet metadata for the phase-error monitor.
      // Stores partner's send-time (their performance.now() via useSync.send
      // t_send injection) + value + my receive-time. Lets the monitor
      // estimate partner's playhead position "now" without rebroadcasting.
      if (m.field === "progress" && (m.deckId === "A" || m.deckId === "B") && typeof m.t_send === "number") {
        partnerProgressMetaRef.current[m.deckId] = {
          tSend: m.t_send,
          value: m.value,
          tRecvLocal: performance.now(),
        };
      }
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
      // Mirror driver-broadcast rate to the local Deck audio + visual. The
      // sync engine independently runs syncDecks on the partner side (driven
      // by syncLocked mirror), so for sync-driven rate changes this is a
      // redundant idempotent set. For pitch-nudge-driven rate changes (which
      // bypass the sync engine), this is the only path that makes the
      // partner's audio source + header BPM follow. setRate is idempotent for
      // identical values, so the driver's own loopback (if any) is a no-op.
      if (m.field === "rate" && (m.deckId === "A" || m.deckId === "B")) {
        if (m.deckId === "A") setRateA(m.value);
        else                  setRateB(m.value);
        const el = document.querySelector(`[data-set-rate='${m.deckId}']`);
        if (el?._setRate) el._setRate(m.value);
      }
    }
    // ── Sync Phase 1: clock-offset estimator (Cristian's) ─────────────
    // sync_ping: partner asked for the time → echo their t0 + my current
    // performance.now() back as sync_pong. Cheap: one WS round-trip.
    // sync_pong: partner answered → feed clockSync (t0=their original send,
    // t1=their processing time, t2=my receive time). RTT outliers and
    // confidence handled inside clockSync.
    if (m.type==="sync_ping") {
      sync.send({ type:"sync_pong", t0: m.t0, t1: performance.now() });
    }
    if (m.type==="sync_pong") {
      const t2 = performance.now();
      clockSyncRef.current.addSample(m.t0, m.t1, t2);
    }
    if (m.type==="seek_request") {
      const fn = seekFnsRef.current[m.deckId];
      console.log("[SEEK-RECV]", { deckId: m.deckId, value: m.value, hasFn: !!fn, from: m.from });
      if (fn) fn(m.value, true);
      else console.warn("[SEEK-RECV] dropped — no seek function registered for deck", m.deckId);
    }
    if (m.type==="toggle_request") toggleFnsRef.current[m.deckId]?.(true);
    if (m.type==="cue_request")    cueFnsRef.current[m.deckId]?.(true);
    if (m.type==="xfade_update")   { setXf(m.value); applyXF(m.value); }
    if (m.type==="chat")           setChat(p=>[...p,m]);
    if (m.type==="partner_joined") {
      setChat(p=>[...p,{type:"system",msg:`${m.djName} joined the session`}]);
      // A partner (re)joined — rebuild their view completely. Re-broadcast my
      // driven deck's full analyzer payload (refined grid) via the verified
      // path, and re-push my lsRef snapshot. Covers reload/rejoin mid-blend so
      // the late-joiner doesn't just get forward deltas. Small delay so their
      // join + RTC settle and their deck_update handler is mounted.
      setTimeout(() => {
        console.log("[REJOIN-REPLAY] partner joined → re-broadcasting analyzer + state");
        broadcastAnalyzerRef.current?.("A");
        broadcastAnalyzerRef.current?.("B");
        try { syncRef.current?.send?.({ type:"sync_response", state: lsRef.current }); } catch {}
      }, 700);
    }
    if (m.type==="partner_left")   { setChat(p=>[...p,{type:"system",msg:`${m.djName} left`}]); setPA(null); setPB(null); setPartnerLibrary([]); }
    if (m.type==="library_sync")   setPartnerLibrary(m.tracks||[]);
    if (m.type==="sync_request")   sync.send({type:"sync_response",state:lsRef.current});
    if (m.type==="sync_response")  { if(m.state?.deckA)setPA(m.state.deckA); if(m.state?.deckB)setPB(m.state.deckB); if(m.state?.xfade!=null){setXf(m.state.xfade);applyXF(m.state.xfade);} }
    rtc.handleRtc(m);
  }, [applyXF]);

  const sync = useSync({ url: SERVER_URL, onMsg: handleWS });
  // ICE-failure recovery: when useRTC reports the connection dropped on a
  // network change, the elected INITIATOR re-runs startCall() (a fresh offer →
  // ICE restart) over the auto-reconnected WS; the answerer waits for it. Reuses
  // the rtc_hangup retry budget so a flapping network can't storm. This is the
  // CONNECTION-layer renegotiation trigger that was missing (comp already
  // survives the renegotiation once it happens — verified by e2e-comp/reload).
  const handleIceRecover = useCallback((reason) => {
    if (!partnerRef.current) return;
    if (!isInitiatorRef.current()) { console.log('[RTC-RECOVER] ('+reason+') answerer — waiting for initiator offer'); return; }
    if (rtcReconnectAttemptsRef.current >= 3) { console.warn('[RTC-RECOVER] phase=exhausted reason='+reason); setRtcReconnectExhausted(true); return; }
    const attempt = ++rtcReconnectAttemptsRef.current;
    console.warn('[RTC-RECOVER] phase=restart reason='+reason+' attempt='+attempt+'/3 (initiator → new offer)');
    clearTimeout(rtcReconnectTimerRef.current);
    rtcReconnectTimerRef.current = setTimeout(() => { if (partnerRef.current && rtcRef.current) rtcRef.current.startCall(); }, 800);
  }, []);
  const rtc  = useRTC({ engineRef: eng, send: sync.send, onIceRecover: handleIceRecover });

  // ── Gap #4: local-monitor delay compensation ──
  // Delay the LOCAL deck monitor to land with the (jitter-buffered) partner
  // stream so both decks hit the ear together (one booth, one truth — we DELAY
  // local, never speed up). Measured by useRTC's getStats poll; applied only
  // when ?delaycomp=1. Slewed slowly (never clicks), clamped 0–400ms. Measure +
  // telemetry run regardless so the HUD shows numbers even with the flag off.
  const delayCompOn = DELAY_COMP;   // default-on, ?delaycomp=0 kill-switch (module-load capture)
  // Beat-grid unification: SYNC engage, seek-quantize, and the big-waveform
  // grid all read the REFINED beatTimes[] (one source of truth). PROMOTED
  // default-on June 11 2026 after the 7-point A/B passed by ear + eye. Kill
  // switch: ?beatsv2=0 restores the legacy LINEAR engage + grid.
  const beatsV2On = BEATS_V2;   // captured at module load (survives query-string strip)
  const beatsV2Ref = useRef(beatsV2On); beatsV2Ref.current = beatsV2On;
  // ?onsetgrid=1 — full Phase-1+2 stack: worker anchors beatTimes on the kick
  // ONSET (analysis-time) AND the big-WF de-smears each kick's drawn leading
  // edge onto that onset (render-time). Captured at module load so it survives
  // the post-join query-string strip.
  const onsetGridOn = ONSET_GRID;
  useEffect(() => {
    const iv = setInterval(() => {
      const e = eng.current; if (!e?.ctx || !e.monitorDelay) return;
      const c = rtc.compRef?.current || {};
      const noFrames = !!c.noFrames; // inbound silent/empty — measurement not meaningful
      const measured = Math.max(0, Math.min(400, c.compMs || 0)); // clamp 0–400ms
      // Hold the last applied delay while there are no inbound frames (don't slew
      // toward a meaningless 0). Apply the measured value only with real frames.
      const appliedMs = delayCompOn && !noFrames ? measured : 0;
      // Fast settle right after a transport event (re-baseline window), then
      // slow-follow so steady-state never clicks.
      const settling = Date.now() < (c.settleUntil || 0);
      const slewTC = settling ? 0.3 : 1.5;
      if (delayCompOn && !noFrames) { try { e.monitorDelay.delayTime.setTargetAtTime(measured / 1000, e.ctx.currentTime, slewTC); } catch {} }
      syncStatsRef.current = { ...syncStatsRef.current,
        compMeasuredMs: noFrames ? null : (c.compMs != null ? +c.compMs.toFixed(1) : null),
        compJbMs:       c.jbMs != null ? +c.jbMs.toFixed(1) : null,
        compPlayoutMs:  c.playoutMs != null ? +c.playoutMs.toFixed(1) : null,
        compAppliedMs:  +(delayCompOn && !noFrames ? measured : 0).toFixed(1),
        compOn: delayCompOn, compSettling: settling, compNoFrames: noFrames };
      if (delayCompOn) {
        if (noFrames) {
          console.log("[SYNC-COMP] no inbound frames (partner silent / no deck) — holding");
        } else if (c.compMs != null) {
          console.log("[SYNC-COMP] measured=" + c.compMs.toFixed(1) + "ms (jb=" +
            (c.jbMs?.toFixed(1) ?? "?") + " playout=" + (c.playoutMs?.toFixed(1) ?? "?") +
            " target=" + (c.targetMs?.toFixed(1) ?? "?") + ") applied=" + appliedMs.toFixed(1) +
            "ms" + (settling ? " [settling]" : ""));
        }
      }
    }, 1000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delayCompOn]);

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
    setSessionContext({
      djName: session.name,
      roomCode: session.room,
      isHost: iAmHostRef.current,
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
  // Lexicographically smaller name initiates; same-name fallback uses
  // iAmHostRef (room creator = initiator). With hex-suffix default names
  // the tiebreaker is rarely reached, but if two users manually pick
  // identical handles the creator-vs-joiner signal still resolves
  // cleanly. The handleAnswer InvalidStateError catch is the safety net
  // for any election ambiguity.
  const isInitiatorRole = useCallback(() => {
    const myName = session?.name || "";
    const partnerName = partnerRef.current;
    if (!partnerName) return false;
    if (myName !== partnerName) return myName < partnerName;
    return !!iAmHostRef.current;
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

  // ── Sync Phase 1: sync_ping interval (clock-offset sampler) ────────────
  // Bounces a small ping off the partner every 3s while a partner is
  // present. Each round trip feeds clockSyncRef via the sync_pong handler.
  // Independent of the WS-level server ping (which measures client↔server
  // RTT only and uses Date.now); this measures client↔client offset in
  // performance.now() units, which the phase-error monitor needs.
  useEffect(() => {
    if (!sync.partner) {
      clockSyncRef.current.reset();
      return;
    }
    const tick = () => sync.send({ type:"sync_ping", t0: performance.now() });
    tick(); // immediate first sample
    const iv = setInterval(tick, 3000);
    return () => clearInterval(iv);
  }, [sync.partner, sync.send]);

  // ── Sync Phase 1: phase-error monitor (measurement only) ───────────────
  // Every 2s while syncLocked, estimate partner's playhead "now" by
  // projecting their last progress packet forward via the clock offset,
  // then compute beat-fractional drift vs my local synced deck. Logs
  // [SYNC-DRIFT] + emits a telemetry sample. NEVER applies a correction —
  // that's a deliberate Phase 1 design boundary. Stats also stashed in
  // syncStatsRef for the debug HUD.
  //
  // Monitor bails out (and records monitorReason) when:
  //   - no partner / not syncLocked / not a remote B2B (I drive both decks)
  //   - clock offset confidence too low (insufficient samples)
  //   - no recent progress packet on the partner-driven deck
  //   - missing beatPhaseSec / beatPeriodSec on either deck
  useEffect(() => {
    if (!syncLocked || !sync.partner) {
      syncStatsRef.current = { ...syncStatsRef.current,
        phaseErrorMs: null, msSinceEngage: null,
        monitorReason: !syncLocked ? "not_locked" : "no_partner",
      };
      return;
    }
    const sample = () => {
      const myDjId = syncRef.current?.djId;
      const drivers = deckDrivers; // {A, B} of {id, name}|null
      // Phase-error monitor only meaningful in remote B2B: I drive exactly
      // one deck, partner drives the other. Local two-deck mode (I drive
      // both) needs no cross-machine measurement. Identity check is djId,
      // NOT display name — name collisions otherwise pinned us to
      // not_remote_b2b even in real remote B2B.
      const myDecks = ["A","B"].filter(d => drivers[d]?.id && drivers[d].id === myDjId);
      const partnerDecks = ["A","B"].filter(d => drivers[d]?.id && drivers[d].id !== myDjId);
      if (myDecks.length !== 1 || partnerDecks.length !== 1) {
        syncStatsRef.current = { ...syncStatsRef.current,
          phaseErrorMs: null, monitorReason: "not_remote_b2b" };
        return;
      }
      const myDeck = myDecks[0];
      const partnerDeck = partnerDecks[0];
      const clk = clockSyncRef.current.getOffset();
      if (clk.sampleCount < 3) {
        syncStatsRef.current = { ...syncStatsRef.current, ...clk,
          phaseErrorMs: null, monitorReason: "clock_warmup" };
        return;
      }
      const meta = partnerProgressMetaRef.current[partnerDeck];
      if (!meta || (performance.now() - meta.tRecvLocal) > 3000) {
        syncStatsRef.current = { ...syncStatsRef.current, ...clk,
          phaseErrorMs: null, monitorReason: "no_recent_progress" };
        return;
      }
      // Partner playhead estimate.
      // tSend is in partner's performance.now() timebase. My local "now"
      // remapped to partner timebase = myNow + offset. Elapsed time in
      // partner's timebase since their send = partnerNowMapped - tSend.
      const partnerState = partnerDeck === "A" ? pA : pB;
      const partnerDur   = partnerState?.duration ?? null;
      const partnerRate  = partnerState?.rate ?? 1;
      const partnerBps   = partnerState?.beatPeriodSec ?? null;
      const partnerBphs  = partnerState?.beatPhaseSec ?? null;
      const myBps        = bpm.results[myDeck]?.beatPeriodSec ?? (myDeck==="A"?pA:pB)?.beatPeriodSec ?? null;
      const myBphs       = bpm.results[myDeck]?.beatPhaseSec  ?? (myDeck==="A"?pA:pB)?.beatPhaseSec  ?? null;
      const myDur        = (myDeck === "A" ? wfA?.dur : wfB?.dur) ?? null;
      const myProg       = myDeck === "A" ? progRefA.current : progRefB.current;
      const myRate       = myDeck === "A" ? rateA : rateB;
      if (!partnerDur || !partnerBps || partnerBphs == null ||
          !myBps || myBphs == null || !myDur || myProg == null) {
        syncStatsRef.current = { ...syncStatsRef.current, ...clk,
          phaseErrorMs: null, monitorReason: "missing_phase_data" };
        return;
      }
      const myNow = performance.now();
      const partnerNowMapped = myNow + clk.offset;
      const elapsedPartnerMs = partnerNowMapped - meta.tSend;
      const partnerNowSec = meta.value * partnerDur + (elapsedPartnerMs / 1000) * partnerRate;
      const mySec = myProg * myDur;
      // Drift in beats — both decks at session tempo, so their effective
      // beat periods match within rate-quantization. Wrap to ±0.5 beat.
      const myBeatPos      = (mySec - myBphs) / myBps;
      const myBeatFrac     = myBeatPos - Math.floor(myBeatPos);
      const partnerBeatPos = (partnerNowSec - partnerBphs) / partnerBps;
      const partnerBeatFrac= partnerBeatPos - Math.floor(partnerBeatPos);
      let beatDiff = partnerBeatFrac - myBeatFrac;
      if (beatDiff >  0.5) beatDiff -= 1;
      if (beatDiff < -0.5) beatDiff += 1;
      // Convert beat-frac diff to wall-time ms using slave's effective beat
      // period at its current rate. Sign convention: positive ms = partner
      // ahead of me (partner playhead is later in the beat).
      const effBeatPeriodMs = (myBps / Math.max(0.001, myRate)) * 1000;
      const phaseErrorMs = beatDiff * effBeatPeriodMs;
      const msSinceEngage = engageTimeMsRef.current
        ? performance.now() - engageTimeMsRef.current
        : null;
      // Throttle log + telemetry to ≤2/sec (the HUD update below is every call).
      const nowTs = performance.now();
      if (nowTs - driftLogTsRef.current > 500) {
        driftLogTsRef.current = nowTs;
        console.log("[SYNC-DRIFT]" +
          " phaseMs=" + phaseErrorMs.toFixed(2) +
          " offsetMs=" + clk.offset.toFixed(2) +
          " rttMs=" + (clk.rttMedian ?? 0).toFixed(0) +
          " conf=" + clk.confidence.toFixed(2) +
          " sinceEngageMs=" + (msSinceEngage != null ? msSinceEngage.toFixed(0) : "—") +
          " myDeck=" + myDeck + " partnerDeck=" + partnerDeck);
        logEvent("sync", "drift_sample", {
          phaseMs: +phaseErrorMs.toFixed(2),
          offsetMs: +clk.offset.toFixed(2),
          rttMedian: clk.rttMedian != null ? +clk.rttMedian.toFixed(0) : null,
          confidence: +clk.confidence.toFixed(2),
          msSinceEngage: msSinceEngage != null ? +msSinceEngage.toFixed(0) : null,
          myDeck, partnerDeck,
        });
      }
      syncStatsRef.current = {
        ...clk, phaseErrorMs, msSinceEngage,
        monitorReason: "sampling", myDeck, partnerDeck,
      };
    };
    sample();
    const iv = setInterval(sample, 2000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncLocked, sync.partner, deckDrivers, pA, pB, wfA, wfB, rateA, rateB, bpm.results]);

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
    // Phase 1 engage-quality snapshot. Populated as each step completes
    // (rate → phase → xcorr) and emitted at function exit on the success
    // path. Numbers feed both the [SYNC-ENGAGE-QUALITY] log and the
    // telemetry sample so we can correlate engage accuracy with drift
    // observed by the phase-error monitor afterwards.
    const tEngageStart = performance.now();
    const engageStats = {
      slave, targetBPM, phaseAlign,
      rateDelta: null,                 // |rate − 1|
      phaseSeekMs: null,               // beat-phase seek amount in ms
      xcorr: null,                     // { applied|skipped, peakRatio, peakSec }
      durationMs: null,                // total syncDecks runtime
      result: "ok",                    // ok | rate_invalid | no_bpm | safety_clamp
    };
    const emitEngageQuality = () => {
      engageStats.durationMs = +(performance.now() - tEngageStart).toFixed(2);
      console.log("[SYNC-ENGAGE-QUALITY]" +
        " result=" + engageStats.result +
        " rateDelta=" + (engageStats.rateDelta != null ? engageStats.rateDelta.toFixed(4) : "—") +
        " phaseSeekMs=" + (engageStats.phaseSeekMs != null ? engageStats.phaseSeekMs.toFixed(2) : "—") +
        " xcorr=" + (engageStats.xcorr ? JSON.stringify(engageStats.xcorr) : "—") +
        " durationMs=" + engageStats.durationMs +
        " phaseAlign=" + phaseAlign +
        " slave=" + slave);
      logEvent("sync", "engage_quality", engageStats);
      // Anchor the "ms since engage" clock for the phase-error monitor.
      // Captured only on successful full engages (phaseAlign=true and not
      // rate-only re-rates).
      if (phaseAlign && engageStats.result === "ok") {
        engageTimeMsRef.current = performance.now();
      }
    };
    const srcBPM = bpm.results[slave]?.bpm;
    console.log("[SYNC] triggered for deck", slave, "sourceBPM=", srcBPM, "targetBPM=", targetBPM);
    if (!srcBPM || !targetBPM) {
      console.log("[SYNC] no target BPM available, ignoring (srcBPM=", srcBPM, "targetBPM=", targetBPM, ")");
      engageStats.result = "no_bpm";
      emitEngageQuality();
      return;
    }
    const rate = targetBPM / srcBPM;
    engageStats.rateDelta = Math.abs(rate - 1);
    if (Math.abs(rate-1) > 0.12) {
      console.log("[SYNC] ignored, rate", rate, "outside ±12% safety window");
      engageStats.result = "safety_clamp";
      emitEngageQuality();
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
    // REFINED beat positions (the actual kicks) for beatsv2 engage. Same
    // local-then-partner fallback shape as the linear phase fields above.
    const slaveBeats  = bpm.results[slave]?.beatTimes   ?? slavePartnerState?.beatTimes;
    const masterBeats = bpm.results[master]?.beatTimes  ?? masterPartnerState?.beatTimes;
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
      // beatsv2: align on the REFINED beat grids (the actual kicks) instead of
      // the LINEAR single-period reconstruction. Falls back to linear if the
      // refined beatTimes aren't available on either deck.
      const beatsV2 = beatsV2Ref.current;
      const mPhase = beatsV2 ? refinedBeatPhase(masterBeats, masterCurTime) : null;
      const sPhase = beatsV2 ? refinedBeatPhase(slaveBeats,  slaveCurTime)  : null;
      const useRefined = beatsV2 && mPhase && sPhase;

      let masterBeatFrac, slaveBeatFrac, newSlaveTime;
      if (useRefined) {
        // Align slave's local refined-beat phase to master's. Iterate the
        // minimal (wrap-bounded ≤0.5-beat) nudge to a fixed point: the refine
        // jitter means a single seek lands in a neighbouring interval with a
        // slightly different period, leaving a small residual — iterating to
        // convergence makes repeat-engage IDEMPOTENT (no wander). First step is
        // the minimal move; subsequent steps are sub-ms. master's fraction is
        // fixed (only the slave moves). Verified by tools/smoke/engage_align.
        masterBeatFrac = mPhase.frac - Math.floor(mPhase.frac);
        slaveBeatFrac  = sPhase.frac - Math.floor(sPhase.frac);
        let t = slaveCurTime;
        for (let iter = 0; iter < 6; iter++) {
          const sp = refinedBeatPhase(slaveBeats, t);
          if (!sp) break;
          let off = masterBeatFrac - (sp.frac - Math.floor(sp.frac));
          if (off >  0.5) off -= 1;
          if (off < -0.5) off += 1;
          if (Math.abs(off) < 1e-4) break;   // <0.01% of a beat → converged
          t += off * sp.period;
        }
        newSlaveTime = t;
      } else {
        masterBeatFrac = ((masterCurTime - masterBphs) / masterBps) % 1;
        slaveBeatFrac  = ((slaveCurTime  - slaveBphs)  / slaveBps)  % 1;
        if (masterBeatFrac < 0) masterBeatFrac += 1;
        if (slaveBeatFrac  < 0) slaveBeatFrac  += 1;
        let phaseOffsetBeats = masterBeatFrac - slaveBeatFrac;
        if (phaseOffsetBeats >  0.5) phaseOffsetBeats -= 1;
        if (phaseOffsetBeats < -0.5) phaseOffsetBeats += 1;
        newSlaveTime = slaveCurTime + phaseOffsetBeats * slaveBps;
      }
      const phaseOffsetSeconds = newSlaveTime - slaveCurTime;
      engageStats.phaseSeekMs = phaseOffsetSeconds * 1000;
      console.log("[SYNC] beat phase before: master=", masterBeatFrac.toFixed(3), "slave=", slaveBeatFrac.toFixed(3),
        "(in beats, " + (useRefined ? "REFINED" : "linear") + ")");
      const newSlaveProg = Math.max(0, Math.min(1, newSlaveTime / slaveDur));
      // seekFnsRef.current[slave] is the local Deck's seek; it already
      // broadcasts seek_request to the partner so their playhead follows.
      // noQuantize=true under beatsv2: engage owns the alignment, so the slave
      // must NOT be re-snapped to its nearest beat (that re-snap, recomputed
      // each press, is the repeat-engage wander). Legacy path keeps the
      // quantizing seek so the A/B baseline is unchanged.
      seekFnsRef.current[slave]?.(newSlaveProg, false, useRefined);
      console.log("[SYNC] beat phase nudged slave by", phaseOffsetSeconds.toFixed(3), "seconds (newProg=", newSlaveProg.toFixed(4), ")");

      // ── Path C: cross-correlation refinement ────────────────────────
      // After beat-phase seek lands slave near master's beat, run a short
      // kick-band cross-correlation on the actual audio to fine-tune
      // alignment. Compensates for per-track beatPhaseSec misdetection
      // (e.g., snare-mistaken-for-kick, wrong-beat-of-bar). Silent fallback
      // on low confidence so breakdowns / ambient passages don't introduce
      // spurious corrections.
      //
      // beatsv2: SKIPPED. Path C existed to patch the LINEAR model's
      // mis-anchoring; the refined beatTimes already sit on the real kicks,
      // and Path C's own seek would re-quantize and break the deterministic
      // (idempotent) refined alignment. Refined phase-align IS the engage.
      if (useRefined) {
        engageStats.xcorr = { applied: false, reason: "beatsv2_refined" };
        console.log("[SYNC-XCORR] skipped — beatsv2 refined phase-align is authoritative");
      } else {
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
            engageStats.xcorr = { applied: false, reason: "low_confidence", peakRatio: +peakRatio.toFixed(2), peakSec: +(peakSec*1000).toFixed(2) };
            console.log("[SYNC-XCORR] peak/RMS=" + peakRatio.toFixed(2) +
              " < threshold " + CONFIDENCE_THRESHOLD +
              " — skipped (fallback to beat-phase only)" +
              " peakLagHops=" + peakLag +
              " peakSec=" + (peakSec * 1000).toFixed(2) + "ms" +
              " fftLen=" + fftLen);
          } else if (Math.abs(peakSec) > maxCorrection) {
            engageStats.xcorr = { applied: false, reason: "above_cap", peakRatio: +peakRatio.toFixed(2), peakSec: +(peakSec*1000).toFixed(2) };
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
            engageStats.xcorr = { applied: true, peakRatio: +peakRatio.toFixed(2), peakSec: +(peakSec*1000).toFixed(2) };
            console.log("[SYNC-XCORR] peak/RMS=" + peakRatio.toFixed(2) +
              " applied: lag=" + peakLag + " hops, correction=" + (peakSec * 1000).toFixed(2) +
              "ms (newProg=" + correctedSlaveProg.toFixed(4) + ")");
          }
        } else {
          engageStats.xcorr = { applied: false, reason: "window_unusable" };
          console.log("[SYNC-XCORR] window unusable, skipped" +
            " (winSec=" + xcWindowSec.toFixed(3) +
            " leftSec=" + leftSec.toFixed(3) +
            " rightSec=" + rightSec.toFixed(3) +
            " minBeats=" + (slaveBps * 1.5).toFixed(3) +
            " slaveStart=" + slaveStart + " masterStart=" + masterStart +
            " winLen=" + xcWinLen + ")");
        }
      } else {
        // Critical for remote B2B audit: when slave or master is partner-
        // driven, our local bufRef for that deck is null and xcorr ALWAYS
        // skips. Beat-phase alignment is the entire engage in that case.
        engageStats.xcorr = { applied: false, reason: "bufrefs_unavailable", haveSlaveBuf: !!slaveBuf, haveMasterBuf: !!masterBuf };
        console.log("[SYNC-XCORR] bufRefs not available, skipped" +
          " (haveSlaveBuf=" + !!slaveBuf + ", haveMasterBuf=" + !!masterBuf + ")");
      }
      } // end else (legacy Path C)
    }
   } // end if (phaseAlign)

    // Broadcast rate so partner mirrors the speed change. Mirrors lsRef pattern
    // used elsewhere for deck_update so sync_response carries rate too.
    const k = `deck${slave}`;
    lsRef.current[k] = { ...(lsRef.current[k]||{}), rate };
    sync.send({ type:"deck_update", deckId: slave, field: "rate", value: rate });
    emitEngageQuality();
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
      // Bug #2 resolution (Chad decision June 10 2026): KEEP this behavior.
      // Intended: rate persists on release per CDJ/Rekordbox convention.
      // Jake's expectation of snap-back is a teaching moment, not a bug.
      // Optional settings toggle for snap-back-on-release is deferred until
      // we see whether the same expectation surfaces from other dogfooders.
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

  // Pitch nudge → sync interaction. Per design decision: nudging pitch on
  // EITHER deck while sync is engaged disengages sync. The deck's own rate
  // setRate + broadcast handles the audio side; this just clears the sync
  // metadata + broadcasts so both browsers' lock visual releases. Same OFF
  // semantics as handleSyncToggle's OFF branch (rate is preserved — the
  // deck keeps whatever rate the user just set; we don't snap back).
  const handlePitchInteract = useCallback((deckId) => {
    if (!syncLockedRef.current) return;
    setSyncLocked(false);
    const broadcastDeck = lastSlaveDeckRef.current || deckId;
    const k = `deck${broadcastDeck}`;
    lsRef.current[k] = { ...(lsRef.current[k]||{}), syncLocked: false };
    sync.send({ type:"deck_update", deckId: broadcastDeck, field: "syncLocked", value: false });
    masterDeckRef.current = null;
    setMasterDeck(null);
    lastSlaveDeckRef.current = null;
    setLastSlaveDeck(null);
    logEvent("sync", "disengaged_by_pitch", { deck: deckId, slave: broadcastDeck });
    console.log("[SYNC] disengaged by pitch nudge on deck", deckId);
  }, [sync]);

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
    rtcRef.current?.markTransportEvent?.(); // re-baseline delay comp on seek/cue/toggle
    // seek_local is a Deck → parent local-only hook (driver-path seeks fire
    // it after the seek completes). Suppress broadcast — partner doesn't
    // need to see it — but still use it to trigger the scrub-resync below.
    // Drives the post-drag, post-arrow, post-cue, post-WF-click re-alignment
    // that the seek_request path (non-driver only) didn't cover.
    if (msg?.type !== "seek_local") sync.send(msg);
    if (!syncLocked) return;
    if (msg?.type !== "seek_request" && msg?.type !== "seek_local") return;
    // Bug #10 fix (Chad decision June 10 2026): a MASTER-deck scrub no
    // longer triggers an auto re-align of the slave. Pro-DJ ergonomics —
    // scrubbing master to preview/find the next cue point shouldn't yank
    // the slave's playhead. Tempo lock stays engaged; user must re-press
    // SYNC to phase-realign, or scrub the slave (preserved below). The
    // slave-scrub path still re-aligns the slave to master, since that's
    // the user explicitly asking to line back up.
    const scrubbedDeck = msg?.deckId;
    const slave = lastSlaveDeckRef.current;
    if (scrubbedDeck && scrubbedDeck !== slave) {
      logEvent("sync", "scrub_realign_suppressed", { scrubbedDeck });
      console.log("[SYNC] master-deck scrub suppressed — slave holds position (#10)", { scrubbedDeck, slave });
      return;
    }
    clearTimeout(scrubResyncTimerRef.current);
    scrubResyncTimerRef.current = setTimeout(() => {
      const now = Date.now();
      if (now - lastScrubResyncTimeRef.current < 200) return;
      if (slave !== "A" && slave !== "B") return;
      const explicitMaster = masterDeckRef.current;
      const master = explicitMaster && explicitMaster !== slave ? explicitMaster : (slave === "A" ? "B" : "A");
      // Once locked, session tempo is the target — not the master's current
      // effective BPM, which may have drifted (e.g., master just loaded a new
      // track and hasn't been re-rated by the track-change effect yet).
      const target = sessionTempoRef.current ?? getEffectiveMasterBpm(master);
      if (!target) return;
      lastScrubResyncTimeRef.current = now;
      console.log("[SYNC] slave scrub detected while locked — auto re-aligning slave to session tempo", target.toFixed(2));
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
      rtcRef.current?.markTransportEvent?.(); // re-baseline delay comp on local play/pause
      // ── one-shot audio diagnostics (booth-silence investigation) ──
      if (value) {
        const e = eng.current;
        const myDjId = sync.djId;
        if (e?.ctx) {
          console.log('[AUDIO-DIAG] PLAY deck '+id+' | ctx.state='+e.ctx.state+' master.gain='+e.master.gain.value.toFixed(3)+' djId='+myDjId);
          for (const d of ["A","B"]) {
            const dr = deckDriversRef.current?.[d];
            const open = !dr || dr.id === myDjId;
            try {
              console.log('[TRIM-GATE] deck '+d+' driver='+JSON.stringify(dr)+' open='+open+' → trim.gain='+e[d].trim.gain.value.toFixed(3)+' vol='+e[d].vol.gain.value.toFixed(3)+' xf='+e[d].xf.gain.value.toFixed(3));
            } catch(err) { console.warn('[TRIM-GATE] deck',d,'read failed',err?.message||err); }
          }
          console.log('[AUDIO-DIAG] playStart A='+deckPlayStartRef.current.A+' B='+deckPlayStartRef.current.B+' deckDrivers='+JSON.stringify(deckDriversRef.current));
        } else {
          console.warn('[AUDIO-DIAG] PLAY deck '+id+' but engine/ctx MISSING — eng.current='+!!e);
        }
      }
      // When the SLAVE deck transitions to play AND sync is engaged, re-run
      // alignment. Engaging SYNC while paused at prog=0 leaves slaveCurTime=0,
      // so the phase-alignment seek gets clamped to [0,1] and the slave can
      // end up off-beat by up to ±0.5 beat (clamp eats negative offsets).
      // Re-running ~50ms after play start gives positive playback positions
      // to work with, so the seek can move freely in either direction and
      // beat alignment lands cleanly. No-op if BPM data not ready or sync
      // metadata absent.
      // Legacy: only the designated slave (lastSlaveDeck) re-aligns on play.
      // That left the canonical mix-in unlocked — a freshly-cued deck that was
      // never part of an engage got no alignment when its play was pressed.
      // beatsv2 broadens the trigger: ANY deck starting under sync aligns to
      // the other deck (syncDecks treats the started deck as slave), EXCEPT the
      // explicit master — that deck is the reference and must not be moved.
      if (value && syncLockedRef.current) {
        const target = sessionTempoRef.current;
        const shouldAlign = beatsV2Ref.current
          ? (masterDeckRef.current !== id)
          : (lastSlaveDeckRef.current === id);
        if (target && shouldAlign) {
          setTimeout(() => {
            console.log("[SYNC] play-start re-align for deck", id, "target=", target.toFixed(2), "(beatsv2=" + beatsV2Ref.current + ")");
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
    // Identity is djId, NOT display name — two tabs with identical persisted
    // names from a shared cm_session would otherwise both pass the gate.
    if (!SHARED_FIELDS.has(field)) {
      const driver = deckDriversRef.current?.[id];
      const myDjId = syncRef.current?.djId;
      if (driver?.id && myDjId && driver.id !== myDjId) return;
    }
    sync.send({ type:"deck_update", deckId:id, field, value });
  };

  // Bug 3 (partner-side analyzer mirror) — broadcast analyzer payload on
  // completion so the non-driver renders the partner deck with the same
  // kick-presence WF + grid markers + sync inputs that the driver sees.
  // Fires only when the underlying Float32Array reference changes, so
  // analyzer completion (one ref change per track load) triggers exactly
  // one broadcast per analysis. The dh driver-gate handles the "I'm not
  // the driver" case → no broadcast on the partner side, which is
  // correct since the partner has no analyzer result of their own.
  //
  // Wire shape: each field broadcast as its own deck_update, matching
  // the existing waveformBass/Mid/High pattern. Float32Arrays converted
  // to JS arrays for JSON; receiver lands them in pA/pB.
  const analyzerBroadcastedRef = useRef({ A: null, B: null });
  // Broadcast a deck's full analyzer payload. dh's driver gate means only the
  // deck I actually drive goes on the wire. Stored in a ref so the partner
  // (re)join handler can re-fire it — a rejoiner/late-joiner then rebuilds the
  // refined grid via the SAME verified [ANALYZER-BROADCAST]→[ANALYZER-RECV] path
  // as an initial load, not just the lsRef snapshot.
  const broadcastAnalyzerRef = useRef(null);
  broadcastAnalyzerRef.current = (deck) => {
    const r = bpm.results[deck];
    if (!r?.beatTimes || !r?.beatAttacks) return false;
    const send = dh(deck);
    send("beatTimes",          Array.from(r.beatTimes));
    send("beatAttacks",        Array.from(r.beatAttacks));
    if (r.beatPhaseSec    != null) send("beatPhaseSec",    r.beatPhaseSec);
    if (r.beatPeriodSec   != null) send("beatPeriodSec",   r.beatPeriodSec);
    if (r.beatPhaseFrac   != null) send("beatPhaseFrac",   r.beatPhaseFrac);
    if (r.firstBar1AnchorSec != null) send("firstBar1AnchorSec", r.firstBar1AnchorSec);
    if (r.bpm             != null) send("bpm",             r.bpm);
    console.log("[ANALYZER-BROADCAST]", deck, "beats=" + r.beatTimes.length);
    return true;
  };
  useEffect(() => {
    for (const deck of ["A", "B"]) {
      const r = bpm.results[deck];
      if (!r?.beatTimes || !r?.beatAttacks) continue;
      if (analyzerBroadcastedRef.current[deck] === r.beatTimes) continue;
      analyzerBroadcastedRef.current[deck] = r.beatTimes;
      broadcastAnalyzerRef.current(deck);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bpm.results.A?.beatTimes, bpm.results.B?.beatTimes]);

  const setXfLocal = (v) => { setXf(v); applyXF(v); lsRef.current.xfade=v; sync.send({type:"xfade_update",value:v}); };
  // Shared master fader — wrap setMvol so every move broadcasts. lsRef carries
  // it forward as masterVol for sync_response replay to new joiners.
  const setMvolLocal = (v) => { setMvol(v); lsRef.current.masterVol=v; sync.send({type:"master_vol_update",value:v}); };

  const join = (info) => {
    eng.current = createEngine();
    setReady(true); setSession(info); setPage("session");
    sync.connect(info.room, info.name);
    // info.isHost is set explicitly by every call site (Lobby buttons,
    // JOIN BY MIX CODE, auto-rejoin paths). Coerce undefined to false
    // for any caller that hasn't been updated or for backwards-compat
    // with cm_session payloads written before this field existed.
    const isHost = !!info.isHost;
    iAmHostRef.current = isHost;
    setSessionContext({ djName: info.name, roomCode: info.room, isHost });
    logEvent("session", "room_joined", { roomCode: info.room, isHost });
    // Persist session so library app can link back and page reloads auto-rejoin
    try {
      localStorage.setItem("cm_session", JSON.stringify({
        room: info.room,
        name: info.name,
        mixName: info.mixName || "Untitled Mix",
        isHost,
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
  // Path 1b: URL has ?room but no ?name (invite link from a partner) —
  //          do NOT auto-rejoin from localStorage. The user came here
  //          deliberately to join a specific room; falling through to
  //          Path 2 would silently send them back to their prior session
  //          and discard the invite. Let the Lobby render (main.jsx has
  //          already routed initialPage="lobby" when ?room= is present)
  //          so they confirm name + join.
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
      // Library app handoff is always a joiner — the library app
      // hands off into a room that already exists.
      join({ room: paramRoom, name: paramName, mixName: paramMix || "Untitled Mix", isHost: false });
      return;
    }
    if (paramRoom) {
      // Invite link without explicit name. Skip Path 2 so localStorage
      // doesn't override the invite.
      return;
    }
    try {
      const saved = localStorage.getItem("cm_session");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed?.room && parsed?.name) {
          // No URL params present — localStorage is the source of truth
          // for refresh-during-session. Preserve isHost from the
          // original join (defaults to false for pre-fix cm_session
          // payloads that lack the field — slight transitional cost,
          // affects telemetry attribution only).
          join({
            room: parsed.room,
            name: parsed.name,
            mixName: parsed.mixName || "Untitled Mix",
            isHost: !!parsed.isHost,
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
  // Sync Phase 1 debug HUD — render only when ?syncdebug=1. URL params
  // don't change without a reload, so this read-once at render is safe.
  const showSyncDebug = (() => {
    try { return new URLSearchParams(window.location.search).get("syncdebug") === "1"; }
    catch { return false; }
  })();
  return (
    <div style={{ height:"100vh", overflow:"hidden", background:"#000000", fontFamily:"'Inter',sans-serif", color:"#F5F5F7", display:"flex", flexDirection:"column" }}>
      {showSyncDebug && <SyncDebugHUD statsRef={syncStatsRef}/>}
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
              outputSilent             ? { label:"AUDIO: NO OUTPUT",     c:"#ef4444", pulse:true  }
              : !sync.partner          ? { label:"AUDIO: OFFLINE",       c:"#5A5E66", pulse:false }
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
          {/* Room code — readable at a glance so the host can say it out
              loud to a partner who only has voice contact. tabular-nums
              keeps the dash-separated digit groups aligned. */}
          <span style={{
            fontSize:10, fontFamily:"'Inter',sans-serif",
            color:"rgba(255,255,255,0.6)", letterSpacing:.3,
            fontVariantNumeric:"tabular-nums",
          }}>{session.room}</span>
          <ShareButton room={session.room} mixName={session.mixName}/>
          <button onClick={leave} style={{ height:24, padding:"0 10px", background:"transparent", border:"1px solid #ef444433", color:"#ef4444", borderRadius:6, cursor:"pointer", fontFamily:"'Inter',sans-serif", fontSize:9, letterSpacing:.5 }}>Leave</button>
        </div>
      </div>

      {/* AUTOPLAY-BLOCKED BANNER — shown when the browser blocked the partner audio
          element from playing. The document-level click handler in useRTC will
          retry play() on the next click anywhere, so the banner is informational. */}
      {rtc.autoplayBlocked && (
        <button
          onClick={() => rtc.enablePartnerAudio?.()}
          style={{ flexShrink:0, width:"100%", padding:"8px 14px", background:"#f59e0b22", borderTop:"none", borderLeft:"none", borderRight:"none", borderBottom:"1px solid #f59e0b44", color:"#f59e0b", fontSize:11, fontFamily:"'Inter',sans-serif", letterSpacing:.5, textAlign:"center", cursor:"pointer" }}
        >
          🔇 Tap here to enable partner audio
        </button>
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
                <AnimatedZoomedWF bands={wfA} dur={wfA?.dur||0} progRef={progRefA} onSeek={seekDeckA} h={wfH} windowSec={WF_WINDOWS[wfZoom]} beatPhaseFrac={bpm.results["A"]?.beatPhaseFrac ?? pA?.beatPhaseFrac ?? null} beatPeriodSec={bpm.results["A"]?.beatPeriodSec ?? pA?.beatPeriodSec ?? null} gridOffsetMs={gridOffsetA} barOneOffsetSec={barOneA * (bpm.results["A"]?.beatPeriodSec || pA?.beatPeriodSec || 0)} deckColor="#2E86DE" rate={rateA} beatTimes={bpm.results["A"]?.beatTimes ?? pA?.beatTimes ?? null} beatsV2={beatsV2On} desmear={onsetGridOn && bpm.results["A"]?.gridSource !== "rekordbox"} deckId="A" isDriver={!deckDrivers.A || deckDrivers.A?.id === sync.djId}/>
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
                <AnimatedZoomedWF bands={wfB} dur={wfB?.dur||0} progRef={progRefB} onSeek={seekDeckB} h={wfH} windowSec={WF_WINDOWS[wfZoom]} beatPhaseFrac={bpm.results["B"]?.beatPhaseFrac ?? pB?.beatPhaseFrac ?? null} beatPeriodSec={bpm.results["B"]?.beatPeriodSec ?? pB?.beatPeriodSec ?? null} gridOffsetMs={gridOffsetB} barOneOffsetSec={barOneB * (bpm.results["B"]?.beatPeriodSec || pB?.beatPeriodSec || 0)} deckColor="#A855F7" rate={rateB} beatTimes={bpm.results["B"]?.beatTimes ?? pB?.beatTimes ?? null} beatsV2={beatsV2On} desmear={onsetGridOn && bpm.results["B"]?.gridSource !== "rekordbox"} deckId="B" isDriver={!deckDrivers.B || deckDrivers.B?.id === sync.djId}/>
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
          current playhead.
          Pitch Nudge (June 9): bumped 248 → 260 (+12 px). The BPM hero
          cluster gained a pitch readout + ± buttons row, which costs ~16 px
          inside the header. The compact inline pct+buttons layout absorbs
          most of that internally; 12 px container grow covers the rest and
          gives the grid-panel-open state (previously ~14 px over budget)
          back some breathing room. Library forfeits 12 px of vertical space —
          ~4% loss at 820 vh, imperceptible at typical track-row heights. */}
      <div style={{ flexShrink:0, display:"grid", gridTemplateColumns:"1fr 200px 1fr", gap:8, padding:"6px 12px 0", height:"260px", overflow:"hidden", width:"100%" }}>

        {/* ── DECK A (shared) — outer "Deck A · driver" header bar removed;
              new inner Deck header has the 3-part identity row at top. ── */}
        <div style={{ display:"flex", flexDirection:"column", minWidth:0, minHeight:0, overflow:"hidden", background:"#15171A", border:`1px solid ${deckDrivers.A?"#2E86DE44":"rgba(255,255,255,0.06)"}`, borderRadius:10, transition:"border-color 150ms cubic-bezier(0.4, 0, 0.2, 1)" }}>
          <div style={{ flex:1, display:"flex", alignItems:"flex-start", gap:10, padding:"10px 0 10px 10px", overflow:"hidden", minHeight:0 }}>
            <DeckArt artwork={libLoadA?.track?.artwork} fallback="A" color="#2E86DE"/>
            <div style={{ flex:1, overflow:"hidden", minHeight:0 }}>
            <Deck id="A" ch={eng.current?.A} ctx={eng.current?.ctx} color="#2E86DE" local remote={pA} onChange={dh("A")} midi={midiEvt} bpmResult={bpm.results["A"]} bpmAnalyze={bpm.analyze} eqHi={eqA.hi} eqMid={eqA.mid} eqLo={eqA.lo} chanVol={eqA.vol} loadFromLibrary={libLoadA} onTrackInfo={handleTrackInfo} onSync={()=>handleSyncToggle("A")} syncReady={!!(bpm.results["B"]?.bpm || pB?.bpm)} syncRole={syncLocked ? (lastSlaveDeck === "A" ? "slave" : "master") : null} isMaster={masterDeck === "A"} onMasterToggle={handleMasterToggle} onLibraryTrackDrop={(trackId)=>{const t=lib.library.find(x=>x.id===trackId);if(t)handleLibLoad(t,"A");}} onProgUpdate={handleProgA} onWaveform={setWfA} onSeekReady={onDeckASeekReady} onToggleReady={onDeckAToggleReady} onCueReady={onDeckACueReady} onNudgeReady={onDeckANudgeReady} onTransportFire={handleTransportFire} isDriver={!deckDrivers.A || deckDrivers.A?.id === sync.djId} acNowRef={acNowRef} onBufferReady={onDeckABufferReady} barOneOffsetSec={barOneA * (bpm.results["A"]?.beatPeriodSec || 0)} onGridEdit={(fields) => libLoadA?.track?.id && lib.setGridEdit?.(libLoadA.track.id, fields)} hasOverride={!!userGridA} userGridOverride={userGridA} onPitchInteract={handlePitchInteract}/>
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
            <Deck id="B" ch={eng.current?.B} ctx={eng.current?.ctx} color="#A855F7" local remote={pB} onChange={dh("B")} midi={midiEvt} bpmResult={bpm.results["B"]} bpmAnalyze={bpm.analyze} eqHi={eqB.hi} eqMid={eqB.mid} eqLo={eqB.lo} chanVol={eqB.vol} loadFromLibrary={libLoadB} onTrackInfo={handleTrackInfo} onSync={()=>handleSyncToggle("B")} syncReady={!!(bpm.results["A"]?.bpm || pA?.bpm)} syncRole={syncLocked ? (lastSlaveDeck === "B" ? "slave" : "master") : null} isMaster={masterDeck === "B"} onMasterToggle={handleMasterToggle} onLibraryTrackDrop={(trackId)=>{const t=lib.library.find(x=>x.id===trackId);if(t)handleLibLoad(t,"B");}} onProgUpdate={handleProgB} onWaveform={setWfB} onSeekReady={onDeckBSeekReady} onToggleReady={onDeckBToggleReady} onCueReady={onDeckBCueReady} onNudgeReady={onDeckBNudgeReady} onTransportFire={handleTransportFire} isDriver={!deckDrivers.B || deckDrivers.B?.id === sync.djId} acNowRef={acNowRef} onBufferReady={onDeckBBufferReady} barOneOffsetSec={barOneB * (bpm.results["B"]?.beatPeriodSec || 0)} onGridEdit={(fields) => libLoadB?.track?.id && lib.setGridEdit?.(libLoadB.track.id, fields)} hasOverride={!!userGridB} userGridOverride={userGridB} onPitchInteract={handlePitchInteract}/>
            </div>
          </div>
        </div>

      </div>

      {/* ── PANEL DETAIL (rtc / rec / midi) — opens when the toggle in the
            top header is active. Wrapper collapses fully when no panel open,
            so the library gets the full vertical strip back. The Phase 1
            library auto-import UI is NOT here — see LibraryEmptyState in
            LibraryPanelV2's main content area. ── */}
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
