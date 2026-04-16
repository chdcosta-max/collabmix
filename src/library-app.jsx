import { useState, useEffect, useRef, useCallback, useMemo } from "react";

// ═══════════════════════════════════════════════════════════════
//  COLLAB//MIX — MUSIC LIBRARY
//  Standalone app. Shares IndexedDB with the mixer.
//  Scan any folder → auto-analyze BPM, key, energy → browse by DJ utility
// ═══════════════════════════════════════════════════════════════

const DB_NAME = "cm_music_library";
const DB_VER  = 2;
const G = "#C8A96E";

// ── Palette ───────────────────────────────────────────────────
const C = {
  bg:      "#080710",
  surface: "#0E0C1A",
  raised:  "#14101E",
  border:  "#1C1830",
  muted:   "#3A3555",
  subtle:  "#7A7090",
  text:    "#EDE8DF",
  gold:    "#C8A96E",
  cyan:    "#00d4ff",
  orange:  "#ff6b35",
};

const ENERGY_COLOR = {
  "Ambient":   "#4A90D9",
  "Warm-Up":   "#22c55e",
  "Build":     "#f59e0b",
  "Peak Hour": "#ff6b35",
  "Hard":      "#ef4444",
};

const ENERGY_ORDER = ["Ambient","Warm-Up","Build","Peak Hour","Hard"];

const CAMELOT = {
  "C":"8B","G":"9B","D":"10B","A":"11B","E":"12B","B":"1B",
  "F#":"2B","Db":"3B","Ab":"4B","Eb":"5B","Bb":"6B","F":"7B",
  "Am":"8A","Em":"9A","Bm":"10A","F#m":"11A","C#m":"12A","G#m":"1A",
  "D#m":"2A","A#m":"3A","Fm":"4A","Cm":"5A","Gm":"6A","Dm":"7A",
};

// ── IndexedDB helpers ─────────────────────────────────────────
function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("tracks")) {
        const ts = db.createObjectStore("tracks", { keyPath: "id" });
        ts.createIndex("artist",  "artist",  { unique: false });
        ts.createIndex("genre",   "genre",   { unique: false });
        ts.createIndex("energy",  "energy",  { unique: false });
        ts.createIndex("bpm",     "bpm",     { unique: false });
        ts.createIndex("addedAt", "addedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains("crates")) {
        db.createObjectStore("crates", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("handles")) {
        db.createObjectStore("handles", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
    };
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

function dbGet(db, store, key) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

function dbPut(db, store, val) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    const req = tx.objectStore(store).put(val);
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}

function dbGetAll(db, store) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

function dbDelete(db, store, key) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}

function dbClear(db, store) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    const req = tx.objectStore(store).clear();
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}

// ── ID3 parser ────────────────────────────────────────────────
function parseID3(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer), tags = {};
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return tags;
  const ver = bytes[3];
  const size = ((bytes[6]&0x7F)<<21)|((bytes[7]&0x7F)<<14)|((bytes[8]&0x7F)<<7)|(bytes[9]&0x7F);
  let off = 10; const end = Math.min(off+size, buffer.byteLength);
  const fmap = { "TIT2":"title","TPE1":"artist","TBPM":"bpm","TKEY":"key","TCON":"genre","TALB":"album","TRCK":"track","TYER":"year" };
  function rStr(o, len) {
    const enc = bytes[o]; const sl = bytes.slice(o+1, o+len);
    try { return enc===1||enc===2 ? new TextDecoder("utf-16").decode(sl).replace(/\0/g,"").trim() : new TextDecoder("utf-8").decode(sl).replace(/\0/g,"").trim(); }
    catch { return ""; }
  }
  while (off+10 < end) {
    const fid = String.fromCharCode(bytes[off],bytes[off+1],bytes[off+2],bytes[off+3]);
    if (!fid.match(/^[A-Z0-9]{4}$/)) break;
    const fsz = ver>=4 ? ((bytes[off+4]&0x7F)<<21)|((bytes[off+5]&0x7F)<<14)|((bytes[off+6]&0x7F)<<7)|(bytes[off+7]&0x7F) : view.getUint32(off+4);
    if (fmap[fid] && fsz>1) tags[fmap[fid]] = rStr(off+10, fsz);
    off += 10+fsz; if (fsz===0) break;
  }
  return tags;
}

// ── Analysis Worker ───────────────────────────────────────────
const WORKER_SRC = `
function bpf(s,sr,lo,hi){const o=new Float32Array(s.length);const rL=1/(2*Math.PI*hi/sr+1),rH=1/(2*Math.PI*lo/sr+1);let pi=0,po=0;const hp=new Float32Array(s.length);for(let i=0;i<s.length;i++){hp[i]=rH*(po+s[i]-pi);pi=s[i];po=hp[i];}let pv=0;for(let i=0;i<hp.length;i++){pv=o[i]=pv+(1-rL)*(hp[i]-pv);}return o;}
function dbpm(mono,sr){const ar=200,hop=Math.floor(sr/ar),nf=Math.floor(mono.length/hop);const f=bpf(mono,sr,100,400);for(let i=0;i<f.length;i++)f[i]=f[i]>0?f[i]:0;const env=new Float32Array(nf);for(let i=0;i<nf;i++){let s=0;const st=i*hop,en=Math.min(st+hop,mono.length);for(let j=st;j<en;j++)s+=f[j]*f[j];env[i]=Math.sqrt(s/(en-st));}const on=new Float32Array(nf);for(let i=1;i<nf;i++){const d=env[i]-env[i-1];on[i]=d>0?d:0;}const mn=on.reduce((s,v)=>s+v,0)/nf;const sd=Math.sqrt(on.reduce((s,v)=>s+(v-mn)**2,0)/nf)||1;for(let i=0;i<nf;i++)on[i]=(on[i]-mn)/sd;const ml=Math.floor(60/200*ar),xl=Math.ceil(ar),al=xl-ml+1;const ac=new Float32Array(al);for(let li=0;li<al;li++){const lag=li+ml;let s=0;for(let i=0;i<nf-lag;i++)s+=on[i]*on[i+lag];ac[li]=s/(nf-lag);}let best=0,bi=0;for(let i=0;i<ac.length;i++)if(ac[i]>best){best=ac[i];bi=i;}if(!best)return null;const raw=(60/(bi+ml))*ar;let b=raw;while(b<100)b*=2;while(b>175)b/=2;return Math.round(b*10)/10;}
function dkey(mono,sr){const fftSize=4096,hopSize=2048,NOTES=["C","C#","D","Eb","E","F","F#","G","Ab","A","Bb","B"];const chroma=new Float32Array(12);const win=new Float32Array(fftSize);for(let i=0;i<fftSize;i++)win[i]=0.5-0.5*Math.cos(2*Math.PI*i/fftSize);const hops=Math.min(Math.floor((mono.length-fftSize)/hopSize),40);for(let h=0;h<hops;h++){const st=h*hopSize;for(let pc=0;pc<12;pc++){const freq=440*Math.pow(2,(pc-9)/12);let re=0,im=0;for(let i=0;i<fftSize;i+=4){const s=mono[st+i]*win[i];const p=2*Math.PI*freq*i/sr;re+=s*Math.cos(p);im+=s*Math.sin(p);}chroma[pc]+=Math.sqrt(re*re+im*im);}}const mx=Math.max(...chroma);if(mx>0)for(let i=0;i<12;i++)chroma[i]/=mx;const majP=[6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];const minP=[6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];let best=-Infinity,bk="C";for(let r=0;r<12;r++){let ms=0,ns=0;for(let i=0;i<12;i++){ms+=chroma[(r+i)%12]*majP[i];ns+=chroma[(r+i)%12]*minP[i];}if(ms>best){best=ms;bk=NOTES[r];}if(ns>best){best=ns;bk=NOTES[r]+"m";}}return bk;}
function denergy(mono,sr){const chunk=Math.min(mono.length,sr*30);let rms=0;for(let i=0;i<chunk;i++)rms+=mono[i]*mono[i];rms=Math.sqrt(rms/chunk);let zc=0;for(let i=1;i<chunk;i++)if((mono[i]>=0)!==(mono[i-1]>=0))zc++;const rn=Math.min(1,rms*8),zn=Math.min(1,zc/(chunk/sr)/3000),score=rn*.7+zn*.3;const label=score<.25?"Ambient":score<.45?"Warm-Up":score<.65?"Build":score<.82?"Peak Hour":"Hard";return{score:Math.round(score*100),label};}
self.onmessage=function(e){
  const{cd,sr,id}=e.data;
  const mono=new Float32Array(cd[0].length);
  for(let c=0;c<cd.length;c++){const d=cd[c];for(let i=0;i<mono.length;i++)mono[i]+=d[i]/cd.length;}
  const bpm=dbpm(mono,sr);
  const key=dkey(mono,sr);
  const energy=denergy(mono,sr);
  self.postMessage({id,bpm,key,energy});
};`;

function makeWorker() {
  return new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type:"application/javascript" })));
}

// ── iTunes XML parser ─────────────────────────────────────────
function parseiTunesXML(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "text/xml");
  const root = doc.querySelector("plist > dict");
  if (!root) return { tracks: [], playlists: [] };

  function parseDict(dictEl) {
    const obj = {};
    const kids = Array.from(dictEl.children);
    for (let i = 0; i < kids.length - 1; i += 2) {
      const key = kids[i]?.textContent;
      const val = kids[i+1];
      if (!key || !val) continue;
      const t = val.tagName;
      if (t==="string")  obj[key] = val.textContent;
      else if (t==="integer") obj[key] = parseInt(val.textContent, 10);
      else if (t==="real")    obj[key] = parseFloat(val.textContent);
      else if (t==="true")    obj[key] = true;
      else if (t==="false")   obj[key] = false;
      else if (t==="dict")    obj[key] = parseDict(val);
      else if (t==="array")   obj[key] = Array.from(val.children).map(el => el.tagName==="dict" ? parseDict(el) : el.textContent);
    }
    return obj;
  }

  const rootObj = parseDict(root);
  const tracksDict = rootObj["Tracks"] || {};
  const playlistsArr = rootObj["Playlists"] || [];

  const tracks = Object.values(tracksDict)
    .filter(t => t["Location"] && !t["Podcast"] && t["Track Type"] !== "URL")
    .map(t => {
      const loc = decodeURIComponent((t["Location"] || "").replace(/^file:\/\//, ""));
      const filename = loc.split("/").pop();
      const keyRaw = t["Initial Key"] || "";
      return {
        id: `itunes_${t["Track ID"]}`,
        itunesId: String(t["Track ID"]),
        title: t["Name"] || filename.replace(/\.[^.]+$/, ""),
        artist: t["Artist"] || t["Album Artist"] || "",
        album: t["Album"] || "",
        genre: t["Genre"] || "",
        bpm: t["BPM"] ? parseFloat(t["BPM"]) : null,
        key: keyRaw || null,
        duration: t["Total Time"] ? t["Total Time"] / 1000 : null,
        location: loc,
        filename: filename.replace(/\.[^.]+$/, ""),
        year: t["Year"] ? String(t["Year"]) : "",
        playCount: t["Play Count"] || 0,
        analyzed: !!(t["BPM"] || keyRaw),
        energy: null,
        addedAt: Date.now(),
        source: "itunes",
      };
    });

  const playlists = playlistsArr
    .filter(p => !p["Master"] && !p["Distinguished Kind"] && p["Name"] && p["Playlist Items"]?.length > 0)
    .map(p => ({
      name: p["Name"],
      trackIds: (p["Playlist Items"] || []).map(item => `itunes_${item["Track ID"]}`),
    }));

  return { tracks, playlists };
}

// ── Recursive folder scanner ───────────────────────────────────
async function* scanDir(dirHandle, path="") {
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === "file") {
      if (name.match(/\.(mp3|wav|flac|aac|ogg|m4a|aiff?|wma)$/i)) {
        yield { name, handle, path: path ? `${path}/${name}` : name };
      }
    } else if (handle.kind === "directory" && !name.startsWith(".")) {
      yield* scanDir(handle, path ? `${path}/${name}` : name);
    }
  }
}

// ── Format helpers ────────────────────────────────────────────
const fmt = (s) => s != null ? `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,"0")}` : "--";
const fmtBPM = (b) => b ? b.toFixed(1) : "--";

// ── Pill component ────────────────────────────────────────────
function Pill({ label, color, small }) {
  return (
    <span style={{
      display:"inline-flex", alignItems:"center",
      padding: small ? "1px 6px" : "2px 8px",
      borderRadius: 20,
      fontSize: small ? 8 : 9,
      fontFamily:"'DM Mono',monospace",
      letterSpacing: 0.5,
      fontWeight: 500,
      background: color+"18",
      color: color,
      border: `1px solid ${color}33`,
      whiteSpace:"nowrap",
    }}>{label}</span>
  );
}

// ── Track row ─────────────────────────────────────────────────
function TrackRow({ track, selected, onClick, onAddToCrate, crates, onPlay }) {
  const [hov, setHov] = useState(false);
  const [showCrateMenu, setShowCrateMenu] = useState(false);
  const camelot = CAMELOT[track.key];
  const eColor = ENERGY_COLOR[track.energy?.label] || C.muted;
  const isMinor = camelot?.endsWith("A");
  const keyColor = isMinor ? "#8B6EAF" : G;

  return (
    <div
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => { setHov(false); setShowCrateMenu(false); }}
      onClick={() => onClick(track)}
      style={{
        display:"grid",
        gridTemplateColumns:"32px 1fr 80px 60px 100px 56px 80px",
        gap:8,
        alignItems:"center",
        padding:"8px 14px",
        background: selected ? `${G}0a` : hov ? `${C.raised}cc` : "transparent",
        borderBottom: `1px solid ${C.border}55`,
        cursor:"pointer",
        transition:"background .1s",
        position:"relative",
      }}
    >
      {/* # / play */}
      <div style={{ textAlign:"center", color: hov ? G : C.muted, fontSize:10, fontFamily:"'DM Mono',monospace" }}>
        {hov
          ? <span onClick={e=>{e.stopPropagation();onPlay&&onPlay(track);}} style={{fontSize:14,cursor:"pointer"}}>▶</span>
          : <span>{track._rowNum||""}</span>
        }
      </div>

      {/* Title + artist */}
      <div style={{ minWidth:0 }}>
        <div style={{ fontSize:13, fontWeight:500, color:C.text, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", fontFamily:"'DM Sans',sans-serif" }}>
          {track.title || track.filename}
        </div>
        <div style={{ fontSize:10, color:C.subtle, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", fontFamily:"'DM Sans',sans-serif", marginTop:1 }}>
          {[track.artist, track.album].filter(Boolean).join(" · ") || "Unknown Artist"}
        </div>
      </div>

      {/* BPM */}
      <div style={{ textAlign:"right" }}>
        <div style={{ fontSize:14, fontFamily:"'DM Mono',monospace", color:track.bpm?G:C.muted, fontWeight:600 }}>{fmtBPM(track.bpm)}</div>
        {!track.analyzed && <div style={{ fontSize:8, color:C.muted, fontFamily:"'DM Mono',monospace" }}>analyzing</div>}
      </div>

      {/* Key (Camelot) */}
      <div style={{ textAlign:"center" }}>
        {camelot
          ? <div style={{ fontSize:12, fontFamily:"'DM Mono',monospace", color:keyColor, background:keyColor+"18", borderRadius:4, padding:"2px 6px", display:"inline-block", fontWeight:600 }}>{camelot}</div>
          : <span style={{ color:C.muted, fontSize:11 }}>—</span>
        }
      </div>

      {/* Energy */}
      <div>
        {track.energy
          ? <Pill label={track.energy.label} color={eColor}/>
          : <span style={{ color:C.muted, fontSize:11 }}>—</span>
        }
      </div>

      {/* Duration */}
      <div style={{ fontSize:11, fontFamily:"'DM Mono',monospace", color:C.subtle, textAlign:"right" }}>
        {fmt(track.duration)}
      </div>

      {/* Actions */}
      <div style={{ display:"flex", gap:4, justifyContent:"flex-end", opacity: hov ? 1 : 0, transition:"opacity .1s" }}>
        <div style={{ position:"relative" }}>
          <button
            onClick={e=>{ e.stopPropagation(); setShowCrateMenu(v=>!v); }}
            style={{ fontSize:9, fontFamily:"'DM Mono',monospace", padding:"3px 7px", background:`${G}14`, border:`1px solid ${G}33`, color:G, borderRadius:4, cursor:"pointer" }}
          >+ CRATE</button>
          {showCrateMenu && (
            <div style={{ position:"absolute", right:0, top:"100%", zIndex:100, background:C.raised, border:`1px solid ${C.border}`, borderRadius:8, padding:6, minWidth:160, boxShadow:"0 8px 24px rgba(0,0,0,.6)" }}>
              {crates.length === 0
                ? <div style={{ fontSize:10, color:C.muted, padding:"4px 8px", fontFamily:"'DM Mono',monospace" }}>No crates yet</div>
                : crates.map(cr => (
                  <div key={cr.id} onClick={e=>{e.stopPropagation();onAddToCrate(track.id,cr.id);setShowCrateMenu(false);}}
                    style={{ fontSize:11, color:C.text, padding:"5px 8px", borderRadius:4, cursor:"pointer", fontFamily:"'DM Sans',sans-serif" }}
                    onMouseEnter={e=>e.currentTarget.style.background=`${G}14`}
                    onMouseLeave={e=>e.currentTarget.style.background="transparent"}
                  >{cr.name}</div>
                ))
              }
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Column header ─────────────────────────────────────────────
function ColHeader({ cols, sortBy, sortDir, onSort }) {
  return (
    <div style={{ display:"grid", gridTemplateColumns:"32px 1fr 80px 60px 100px 56px 80px", gap:8, padding:"7px 14px", borderBottom:`1px solid ${C.border}`, background:C.surface, flexShrink:0 }}>
      {cols.map(([label, key]) => (
        <div key={label} onClick={() => onSort(key)}
          style={{ fontSize:9, fontFamily:"'DM Mono',monospace", color:sortBy===key?G:C.muted, letterSpacing:1.5, cursor:key?"pointer":"default", userSelect:"none", textAlign: label==="BPM"||label==="TIME" ? "right" : label==="KEY" ? "center" : "left" }}>
          {label}{sortBy===key ? (sortDir===1?" ↑":" ↓") : ""}
        </div>
      ))}
    </div>
  );
}

// ── Track list view ────────────────────────────────────────────
function TrackListView({ tracks, crates, onAddToCrate, onSelect, selected, onPlay }) {
  const [sortBy, setSortBy] = useState("addedAt");
  const [sortDir, setSortDir] = useState(-1);

  const sorted = useMemo(() => {
    return [...tracks].sort((a, b) => {
      const va = a[sortBy] ?? (typeof a[sortBy] === "number" ? -Infinity : "");
      const vb = b[sortBy] ?? (typeof b[sortBy] === "number" ? -Infinity : "");
      if (typeof va === "number") return (va - vb) * sortDir;
      return String(va).localeCompare(String(vb)) * sortDir;
    }).map((t, i) => ({ ...t, _rowNum: i + 1 }));
  }, [tracks, sortBy, sortDir]);

  const handleSort = (key) => {
    if (!key) return;
    if (sortBy === key) setSortDir(d => -d);
    else { setSortBy(key); setSortDir(1); }
  };

  const COLS = [["#",null],["TITLE","title"],["BPM","bpm"],["KEY","key"],["ENERGY","energy"],["TIME","duration"],["",null]];

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", overflow:"hidden" }}>
      <ColHeader cols={COLS} sortBy={sortBy} sortDir={sortDir} onSort={handleSort}/>
      <div style={{ flex:1, overflowY:"auto" }}>
        {sorted.map(t => (
          <TrackRow key={t.id} track={t} selected={selected===t.id} onClick={onSelect}
            onAddToCrate={onAddToCrate} crates={crates} onPlay={onPlay}/>
        ))}
        {tracks.length === 0 && (
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100%", gap:12, color:C.muted, fontFamily:"'DM Mono',monospace", fontSize:11 }}>
            <div style={{ fontSize:32, opacity:.2 }}>♫</div>
            No tracks found
          </div>
        )}
      </div>
    </div>
  );
}

// ── Artist view ───────────────────────────────────────────────
function ArtistView({ tracks, crates, onAddToCrate, onSelect, selected, onPlay }) {
  const [activeArtist, setActiveArtist] = useState(null);

  const byArtist = useMemo(() => {
    const map = {};
    for (const t of tracks) {
      const a = t.artist || "Unknown Artist";
      if (!map[a]) map[a] = [];
      map[a].push(t);
    }
    return Object.entries(map).sort(([a],[b]) => a.localeCompare(b));
  }, [tracks]);

  const artistTracks = activeArtist
    ? tracks.filter(t => (t.artist||"Unknown Artist") === activeArtist)
    : [];

  return (
    <div style={{ display:"flex", height:"100%", overflow:"hidden" }}>
      {/* Artist sidebar */}
      <div style={{ width:220, flexShrink:0, overflowY:"auto", borderRight:`1px solid ${C.border}`, background:C.bg }}>
        <div style={{ padding:"10px 14px", fontSize:9, fontFamily:"'DM Mono',monospace", color:C.muted, letterSpacing:2, borderBottom:`1px solid ${C.border}` }}>
          ARTISTS ({byArtist.length})
        </div>
        {byArtist.map(([artist, atracks]) => (
          <div key={artist} onClick={() => setActiveArtist(artist)}
            style={{ padding:"10px 14px", display:"flex", justifyContent:"space-between", alignItems:"center", cursor:"pointer", background:activeArtist===artist?`${G}0d`:"transparent", borderBottom:`1px solid ${C.border}44` }}
            onMouseEnter={e=>e.currentTarget.style.background=activeArtist===artist?`${G}0d`:C.raised}
            onMouseLeave={e=>e.currentTarget.style.background=activeArtist===artist?`${G}0d`:"transparent"}
          >
            <div style={{ minWidth:0 }}>
              <div style={{ fontSize:12, color:activeArtist===artist?G:C.text, fontFamily:"'DM Sans',sans-serif", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{artist}</div>
            </div>
            <span style={{ fontSize:10, color:C.muted, fontFamily:"'DM Mono',monospace", flexShrink:0, marginLeft:8 }}>{atracks.length}</span>
          </div>
        ))}
      </div>

      {/* Track list for selected artist */}
      <div style={{ flex:1, overflow:"hidden", display:"flex", flexDirection:"column" }}>
        {activeArtist ? (
          <>
            <div style={{ padding:"12px 16px", borderBottom:`1px solid ${C.border}`, background:C.surface, flexShrink:0 }}>
              <div style={{ fontSize:18, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif" }}>{activeArtist}</div>
              <div style={{ fontSize:10, color:C.muted, fontFamily:"'DM Mono',monospace", marginTop:2 }}>{artistTracks.length} tracks</div>
            </div>
            <div style={{ flex:1, overflow:"hidden" }}>
              <TrackListView tracks={artistTracks} crates={crates} onAddToCrate={onAddToCrate} onSelect={onSelect} selected={selected} onPlay={onPlay}/>
            </div>
          </>
        ) : (
          <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100%", color:C.muted, fontFamily:"'DM Mono',monospace", fontSize:11 }}>
            SELECT AN ARTIST
          </div>
        )}
      </div>
    </div>
  );
}

// ── Genre & Energy view ───────────────────────────────────────
function GenreView({ tracks, crates, onAddToCrate, onSelect, selected, onPlay }) {
  const [activeKey, setActiveKey] = useState(null); // "genre:Rock" or "energy:Peak Hour"
  const [mode, setMode] = useState("energy"); // "energy" | "genre"

  const energyGroups = useMemo(() => {
    const map = {};
    for (const e of ENERGY_ORDER) map[e] = [];
    for (const t of tracks) {
      const e = t.energy?.label || "Unknown";
      if (map[e]) map[e].push(t);
      else map[e] = [t];
    }
    return Object.entries(map).filter(([,v]) => v.length > 0);
  }, [tracks]);

  const genreGroups = useMemo(() => {
    const map = {};
    for (const t of tracks) {
      const g = t.genre || "Unknown Genre";
      if (!map[g]) map[g] = [];
      map[g].push(t);
    }
    return Object.entries(map).sort((a,b) => b[1].length - a[1].length);
  }, [tracks]);

  const groups = mode === "energy" ? energyGroups : genreGroups;
  const filteredTracks = activeKey
    ? tracks.filter(t => {
        if (mode === "energy") return (t.energy?.label||"Unknown") === activeKey;
        return (t.genre||"Unknown Genre") === activeKey;
      })
    : [];

  return (
    <div style={{ display:"flex", height:"100%", overflow:"hidden" }}>
      {/* Sidebar */}
      <div style={{ width:220, flexShrink:0, overflowY:"auto", borderRight:`1px solid ${C.border}`, background:C.bg }}>
        <div style={{ display:"flex", gap:0, padding:"8px 10px", borderBottom:`1px solid ${C.border}` }}>
          {[["energy","ENERGY"],["genre","GENRE"]].map(([id,l]) => (
            <button key={id} onClick={() => { setMode(id); setActiveKey(null); }}
              style={{ flex:1, padding:"5px 0", fontSize:9, fontFamily:"'DM Mono',monospace", background:"transparent", color:mode===id?G:C.muted, border:"none", borderBottom:`2px solid ${mode===id?G:"transparent"}`, cursor:"pointer", letterSpacing:1.5 }}>{l}</button>
          ))}
        </div>
        {groups.map(([label, gtracks]) => {
          const color = mode==="energy" ? (ENERGY_COLOR[label]||C.muted) : G;
          const isActive = activeKey === label;
          return (
            <div key={label} onClick={() => setActiveKey(isActive ? null : label)}
              style={{ padding:"10px 14px", display:"flex", alignItems:"center", gap:10, cursor:"pointer", background:isActive?`${color}0d`:"transparent", borderBottom:`1px solid ${C.border}44` }}
              onMouseEnter={e=>e.currentTarget.style.background=isActive?`${color}0d`:C.raised}
              onMouseLeave={e=>e.currentTarget.style.background=isActive?`${color}0d`:"transparent"}
            >
              <div style={{ width:8, height:8, borderRadius:"50%", background:color, flexShrink:0 }}/>
              <div style={{ flex:1, fontSize:12, color:isActive?color:C.text, fontFamily:"'DM Sans',sans-serif" }}>{label}</div>
              <span style={{ fontSize:10, color:C.muted, fontFamily:"'DM Mono',monospace" }}>{gtracks.length}</span>
            </div>
          );
        })}
      </div>

      {/* Tracks */}
      <div style={{ flex:1, overflow:"hidden", display:"flex", flexDirection:"column" }}>
        {activeKey ? (
          <>
            <div style={{ padding:"12px 16px", borderBottom:`1px solid ${C.border}`, background:C.surface, flexShrink:0, display:"flex", alignItems:"center", gap:10 }}>
              {mode==="energy" && <div style={{ width:10, height:10, borderRadius:"50%", background:ENERGY_COLOR[activeKey]||C.muted }}/>}
              <div style={{ fontSize:18, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif" }}>{activeKey}</div>
              <div style={{ fontSize:10, color:C.muted, fontFamily:"'DM Mono',monospace" }}>{filteredTracks.length} tracks</div>
            </div>
            <div style={{ flex:1, overflow:"hidden" }}>
              <TrackListView tracks={filteredTracks} crates={crates} onAddToCrate={onAddToCrate} onSelect={onSelect} selected={selected} onPlay={onPlay}/>
            </div>
          </>
        ) : (
          <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100%", color:C.muted, fontFamily:"'DM Mono',monospace", fontSize:11 }}>
            SELECT A CATEGORY
          </div>
        )}
      </div>
    </div>
  );
}

// ── Crates view ────────────────────────────────────────────────
function CratesView({ tracks, crates, onCreateCrate, onDeleteCrate, onRemoveFromCrate, onSelect, selected, onPlay, onAddToCrate }) {
  const [activeCrate, setActiveCrate] = useState(null);
  const [newName, setNewName] = useState("");

  const crate = crates.find(c => c.id === activeCrate);
  const crateTracks = crate ? (crate.trackIds||[]).map(id => tracks.find(t => t.id===id)).filter(Boolean) : [];

  const create = () => {
    if (!newName.trim()) return;
    onCreateCrate(newName.trim());
    setNewName("");
  };

  return (
    <div style={{ display:"flex", height:"100%", overflow:"hidden" }}>
      {/* Crate list */}
      <div style={{ width:220, flexShrink:0, display:"flex", flexDirection:"column", borderRight:`1px solid ${C.border}`, background:C.bg }}>
        <div style={{ padding:"10px 12px", borderBottom:`1px solid ${C.border}` }}>
          <div style={{ fontSize:9, fontFamily:"'DM Mono',monospace", color:C.muted, letterSpacing:2, marginBottom:8 }}>CRATES ({crates.length})</div>
          <div style={{ display:"flex", gap:6 }}>
            <input value={newName} onChange={e=>setNewName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&create()}
              placeholder="New crate name..." maxLength={30}
              style={{ flex:1, background:C.raised, border:`1px solid ${C.border}`, color:C.text, borderRadius:6, padding:"6px 9px", fontSize:10, fontFamily:"'DM Sans',sans-serif", outline:"none" }}/>
            <button onClick={create} style={{ padding:"6px 10px", background:`${G}18`, border:`1px solid ${G}33`, color:G, borderRadius:6, cursor:"pointer", fontFamily:"'DM Mono',monospace", fontSize:10 }}>+</button>
          </div>
        </div>
        <div style={{ flex:1, overflowY:"auto" }}>
          {crates.map(cr => (
            <div key={cr.id}
              onClick={() => setActiveCrate(cr.id)}
              style={{ padding:"10px 14px", display:"flex", alignItems:"center", gap:8, cursor:"pointer", background:activeCrate===cr.id?`${G}0d`:"transparent", borderBottom:`1px solid ${C.border}44` }}
              onMouseEnter={e=>e.currentTarget.style.background=activeCrate===cr.id?`${G}0d`:C.raised}
              onMouseLeave={e=>e.currentTarget.style.background=activeCrate===cr.id?`${G}0d`:"transparent"}
            >
              <span style={{ fontSize:14 }}>◈</span>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:12, color:activeCrate===cr.id?G:C.text, fontFamily:"'DM Sans',sans-serif", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{cr.name}</div>
                <div style={{ fontSize:9, color:C.muted, fontFamily:"'DM Mono',monospace" }}>{(cr.trackIds||[]).length} tracks</div>
              </div>
              <button onClick={e=>{e.stopPropagation();onDeleteCrate(cr.id);if(activeCrate===cr.id)setActiveCrate(null);}}
                style={{ background:"none", border:"none", color:C.muted, cursor:"pointer", fontSize:12, opacity:.5, padding:0, lineHeight:1 }}>✕</button>
            </div>
          ))}
          {crates.length===0&&<div style={{ padding:"20px 14px", fontSize:10, color:C.muted, fontFamily:"'DM Mono',monospace", lineHeight:2 }}>Create a crate to<br/>organize your tracks</div>}
        </div>
      </div>

      {/* Crate tracks */}
      <div style={{ flex:1, overflow:"hidden", display:"flex", flexDirection:"column" }}>
        {crate ? (
          <>
            <div style={{ padding:"12px 16px", borderBottom:`1px solid ${C.border}`, background:C.surface, flexShrink:0, display:"flex", alignItems:"center", gap:12 }}>
              <span style={{ fontSize:20 }}>◈</span>
              <div>
                <div style={{ fontSize:18, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif" }}>{crate.name}</div>
                <div style={{ fontSize:10, color:C.muted, fontFamily:"'DM Mono',monospace", marginTop:2 }}>{crateTracks.length} tracks</div>
              </div>
            </div>
            <div style={{ flex:1, overflowY:"auto" }}>
              {crateTracks.map((t, i) => (
                <div key={t.id} style={{ display:"flex", alignItems:"center" }}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <TrackRow track={{...t,_rowNum:i+1}} selected={selected===t.id} onClick={onSelect}
                      onAddToCrate={onAddToCrate} crates={crates} onPlay={onPlay}/>
                  </div>
                  <button onClick={()=>onRemoveFromCrate(t.id,crate.id)}
                    style={{ flexShrink:0, margin:"0 8px", background:"none", border:"none", color:C.muted, cursor:"pointer", fontSize:13, opacity:.5, padding:"0 4px" }}>✕</button>
                </div>
              ))}
              {crateTracks.length===0&&(
                <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:200, gap:10, color:C.muted, fontFamily:"'DM Mono',monospace", fontSize:11 }}>
                  <div style={{ fontSize:28, opacity:.2 }}>◈</div>
                  Add tracks by hovering a track and clicking +CRATE
                </div>
              )}
            </div>
          </>
        ) : (
          <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100%", color:C.muted, fontFamily:"'DM Mono',monospace", fontSize:11 }}>SELECT A CRATE</div>
        )}
      </div>
    </div>
  );
}

// ── BPM range filter ──────────────────────────────────────────
function BPMRangeFilter({ min, max, value, onChange }) {
  return (
    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
      <span style={{ fontSize:9, color:C.muted, fontFamily:"'DM Mono',monospace", flexShrink:0 }}>BPM</span>
      <input type="range" min={min} max={max} value={value[0]}
        onChange={e=>onChange([+e.target.value,value[1]])}
        style={{ width:60, accentColor:G, cursor:"pointer" }}/>
      <span style={{ fontSize:9, color:G, fontFamily:"'DM Mono',monospace", minWidth:24, textAlign:"center" }}>{value[0]}</span>
      <span style={{ fontSize:9, color:C.muted }}>–</span>
      <input type="range" min={min} max={max} value={value[1]}
        onChange={e=>onChange([value[0],+e.target.value])}
        style={{ width:60, accentColor:G, cursor:"pointer" }}/>
      <span style={{ fontSize:9, color:G, fontFamily:"'DM Mono',monospace", minWidth:24, textAlign:"center" }}>{value[1]}</span>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────
export default function MusicLibrary() {
  const dbRef    = useRef(null);
  const workerRef = useRef(null);
  const queueRef  = useRef([]);
  const activeRef = useRef(false);
  const audioCtxRef = useRef(null);

  const [tracks,   setTracks]   = useState([]);
  const [crates,   setCrates]   = useState([]);
  const [view,     setView]     = useState("tracks");
  const [scanning, setScanning] = useState(false);
  const [scanProg, setScanProg] = useState({ found:0, analyzed:0, total:0 });
  const [selected, setSelected] = useState(null);
  const [search,   setSearch]   = useState("");
  const [bpmRange, setBpmRange] = useState([60, 180]);
  const [energyFilter, setEnergyFilter] = useState(null);
  const [keyFilter,    setKeyFilter]    = useState(null);
  const [showItunesHelper, setShowItunesHelper] = useState(false);
  useEffect(() => {
    if (!showItunesHelper) return;
    const close = (e) => { if (!e.target.closest("[data-itunes-helper]")) setShowItunesHelper(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [showItunesHelper]);

  // ── Init DB + worker ────────────────────────────────────────
  useEffect(() => {
    openDB().then(db => {
      dbRef.current = db;
      return Promise.all([dbGetAll(db,"tracks"), dbGetAll(db,"crates")]);
    }).then(([ts,cs]) => {
      setTracks(ts.sort((a,b)=>b.addedAt-a.addedAt));
      setCrates(cs);
    });

    const w = makeWorker();
    workerRef.current = w;
    w.onmessage = async (e) => {
      const { id, bpm, key, energy } = e.data;
      setTracks(prev => prev.map(t => t.id===id ? {...t,bpm:bpm??t.bpm,key:key??t.key,energy,analyzed:true} : t));
      if (dbRef.current) {
        const db = dbRef.current;
        const tx = db.transaction("tracks","readwrite");
        const st = tx.objectStore("tracks");
        const existing = await new Promise(r=>{ const rq=st.get(id); rq.onsuccess=()=>r(rq.result); });
        if (existing) { existing.bpm=bpm??existing.bpm; existing.key=key??existing.key; existing.energy=energy; existing.analyzed=true; st.put(existing); }
      }
      setScanProg(p => ({ ...p, analyzed: p.analyzed+1 }));
      activeRef.current = false;
      processQueue();
    };
    return () => w.terminate();
  }, []);

  // ── Analysis queue ──────────────────────────────────────────
  const processQueue = useCallback(async () => {
    if (activeRef.current || queueRef.current.length===0) return;
    const { id } = queueRef.current.shift();
    activeRef.current = true;
    const db = dbRef.current;
    if (!db) { activeRef.current=false; return; }
    const handleRec = await dbGet(db,"handles",id);
    if (!handleRec) { activeRef.current=false; processQueue(); return; }
    try {
      const perm = await handleRec.handle.queryPermission({ mode:"read" });
      if (perm !== "granted") {
        await handleRec.handle.requestPermission({ mode:"read" });
      }
      const file = await handleRec.handle.getFile();
      if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext||window.webkitAudioContext)();
      const ab = await file.arrayBuffer();
      const buf = await audioCtxRef.current.decodeAudioData(ab);
      setTracks(prev => prev.map(t => t.id===id ? {...t,duration:buf.duration} : t));
      if (db) {
        const tx = db.transaction("tracks","readwrite");
        const st = tx.objectStore("tracks");
        const ex = await new Promise(r=>{ const rq=st.get(id); rq.onsuccess=()=>r(rq.result); });
        if (ex) { ex.duration=buf.duration; st.put(ex); }
      }
      const cd = [];
      for (let c=0; c<buf.numberOfChannels; c++) cd.push(buf.getChannelData(c).slice());
      workerRef.current.postMessage({ cd, sr:buf.sampleRate, id });
    } catch(err) {
      console.warn("Analysis failed for", id, err);
      activeRef.current = false;
      processQueue();
    }
  }, []);

  // ── Scan folder ─────────────────────────────────────────────
  const scanFolder = async (preHandle = null) => {
    let dirHandle = preHandle;
    if (!dirHandle) {
      try { dirHandle = await window.showDirectoryPicker({ mode:"read" }); }
      catch { return; }
    }

    setScanning(true);
    setScanProg({ found:0, analyzed:0, total:0 });

    const db = dbRef.current;
    const existing = new Set(tracks.map(t=>t.id));
    let found = 0;

    for await (const { name, handle, path } of scanDir(dirHandle)) {
      found++;
      setScanProg(p => ({ ...p, found }));
      const id = `h_${btoa(path).replace(/[^a-zA-Z0-9]/g,"")}`;
      if (existing.has(id)) continue;

      let tags = {};
      try {
        const sl = await (await handle.getFile()).slice(0, 131072).arrayBuffer();
        tags = parseID3(sl);
      } catch {}

      const track = {
        id, filename: name, path,
        title:  tags.title  || name.replace(/\.[^.]+$/,""),
        artist: tags.artist || "",
        album:  tags.album  || "",
        genre:  tags.genre  || "",
        year:   tags.year   || "",
        bpm:    tags.bpm    ? parseFloat(tags.bpm) : null,
        key:    tags.key    || null,
        duration: null,
        energy:   null,
        analyzed: false,
        addedAt:  Date.now(),
      };

      setTracks(prev => [track, ...prev]);
      await dbPut(db, "tracks",  track);
      await dbPut(db, "handles", { id, handle });
      queueRef.current.push({ id });
    }

    setScanProg(p => ({ ...p, total: found }));
    setScanning(false);
    processQueue();
  };

  // ── iTunes / Apple Music guided scan ─────────────────────────
  const itunesScan = async () => {
    setShowItunesHelper(false);
    // Just reuse scanFolder — user navigates to their iTunes Media / Music folder
    await scanFolder();
  };

  // ── iTunes XML import (advanced / power users) ────────────────
  const importFromItunes = async (file) => {
    if (!file) return;
    setScanning(true);
    setScanProg({ found:0, analyzed:0, total:0 });
    try {
      const text = await file.text();
      const { tracks: itTracks, playlists: itPlaylists } = parseiTunesXML(text);
      if (!itTracks.length) { setScanning(false); alert("No tracks found in this iTunes library file."); return; }

      const db = dbRef.current;
      const existing = new Set(tracks.map(t=>t.id));
      // Also build a filename→id map so we can match against itunes tracks later
      const filenameMap = {};
      tracks.forEach(t => { filenameMap[t.filename] = t.id; });

      let added = 0;
      for (const t of itTracks) {
        if (existing.has(t.id)) continue;
        // Check if we already have a scanned track with same filename (from folder scan)
        const matchId = filenameMap[t.filename];
        if (matchId) {
          // Merge iTunes metadata into existing track
          setTracks(prev => prev.map(tr => tr.id === matchId ? {...tr, bpm:tr.bpm||t.bpm, key:tr.key||t.key, genre:tr.genre||t.genre, album:tr.album||t.album, playCount:t.playCount, itunesId:t.itunesId} : tr));
          const exTrack = tracks.find(tr=>tr.id===matchId);
          if (exTrack) await dbPut(db, "tracks", {...exTrack, bpm:exTrack.bpm||t.bpm, key:exTrack.key||t.key, genre:exTrack.genre||t.genre, itunesId:t.itunesId, playCount:t.playCount});
          continue;
        }
        setTracks(prev => [t, ...prev]);
        await dbPut(db, "tracks", t);
        added++;
        setScanProg(p => ({ ...p, found: added }));
        // Queue for energy analysis if we can match a file later
        // (energy analysis requires actual audio — will run when user scans media folder)
      }

      // Import playlists as crates
      for (const pl of itPlaylists) {
        const existingCrate = crates.find(c=>c.name===pl.name);
        if (!existingCrate && pl.trackIds.some(tid=>!existing.has(tid)||filenameMap[tid])) {
          const cr = { id:`cr_${Date.now()}_${Math.random().toString(36).slice(2,5)}`, name:pl.name, trackIds:pl.trackIds.filter(tid=>itTracks.find(t=>t.id===tid)), createdAt:Date.now() };
          if (cr.trackIds.length>0) { setCrates(p=>[...p,cr]); await dbPut(db,"crates",cr); }
        }
      }

      setScanProg({ found: added, analyzed:0, total: itTracks.length });
    } catch(e) {
      console.error("iTunes import error", e);
      alert("Error reading iTunes library. Make sure you selected an iTunes XML file.");
    }
    setScanning(false);
  };

  // ── Re-analyze (for tracks already in DB) ──────────────────
  const reanalyzeAll = async () => {
    const unanalyzed = tracks.filter(t => !t.analyzed);
    for (const t of unanalyzed) queueRef.current.push({ id: t.id });
    setScanProg({ found: tracks.length, analyzed: tracks.filter(t=>t.analyzed).length, total: tracks.length });
    processQueue();
  };

  // ── Crate operations ────────────────────────────────────────
  const createCrate = async (name) => {
    const cr = { id:`cr_${Date.now()}`, name, trackIds:[], createdAt:Date.now() };
    setCrates(p => [...p, cr]);
    await dbPut(dbRef.current,"crates",cr);
  };

  const deleteCrate = async (id) => {
    setCrates(p => p.filter(c=>c.id!==id));
    await dbDelete(dbRef.current,"crates",id);
  };

  const addToCrate = async (trackId, crateId) => {
    const updated = crates.map(c => c.id===crateId ? {...c, trackIds:[...new Set([...(c.trackIds||[]),trackId])]} : c);
    setCrates(updated);
    const cr = updated.find(c=>c.id===crateId);
    if (cr) await dbPut(dbRef.current,"crates",cr);
  };

  const removeFromCrate = async (trackId, crateId) => {
    const updated = crates.map(c => c.id===crateId ? {...c, trackIds:(c.trackIds||[]).filter(id=>id!==trackId)} : c);
    setCrates(updated);
    const cr = updated.find(c=>c.id===crateId);
    if (cr) await dbPut(dbRef.current,"crates",cr);
  };

  const clearAll = async () => {
    if (!confirm("Remove all tracks from your library? (Your actual music files are safe)")) return;
    setTracks([]); setCrates([]);
    const db = dbRef.current;
    await dbClear(db,"tracks"); await dbClear(db,"handles"); await dbClear(db,"crates");
  };

  // ── Filtered tracks ─────────────────────────────────────────
  const filteredTracks = useMemo(() => {
    let ts = tracks;
    if (search.trim()) {
      const q = search.toLowerCase();
      ts = ts.filter(t =>
        (t.title||"").toLowerCase().includes(q) ||
        (t.artist||"").toLowerCase().includes(q) ||
        (t.genre||"").toLowerCase().includes(q) ||
        (t.album||"").toLowerCase().includes(q)
      );
    }
    if (energyFilter) ts = ts.filter(t => t.energy?.label === energyFilter);
    if (keyFilter) ts = ts.filter(t => CAMELOT[t.key] === keyFilter);
    ts = ts.filter(t => {
      if (!t.bpm) return true;
      return t.bpm >= bpmRange[0] && t.bpm <= bpmRange[1];
    });
    return ts;
  }, [tracks, search, energyFilter, keyFilter, bpmRange]);

  const analyzedCount = tracks.filter(t=>t.analyzed).length;
  const analyzing = queueRef.current.length > 0 || activeRef.current;

  // ── NAV VIEWS ────────────────────────────────────────────────
  const VIEWS = [
    ["tracks",  "♫ ALL TRACKS"],
    ["artists", "👤 ARTISTS"],
    ["genres",  "⚡ ENERGY / GENRE"],
    ["crates",  "◈ CRATES"],
  ];

  return (
    <div style={{ minHeight:"100vh", height:"100vh", background:C.bg, color:C.text, fontFamily:"'DM Sans',sans-serif", display:"flex", flexDirection:"column", overflow:"hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');
        *{box-sizing:border-box}
        ::-webkit-scrollbar{width:4px;height:4px}
        ::-webkit-scrollbar-track{background:${C.bg}}
        ::-webkit-scrollbar-thumb{background:${C.border};border-radius:2px}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
        input::placeholder{color:${C.muted}}
      `}</style>

      {/* ── TOP BAR ── */}
      <div style={{ background:C.surface, borderBottom:`1px solid ${C.border}`, padding:"10px 20px", display:"flex", alignItems:"center", gap:16, flexShrink:0 }}>
        {/* Logo */}
        <a href="/" style={{ textDecoration:"none", display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
          <div style={{ width:32, height:32, borderRadius:8, border:`1px solid ${G}33`, display:"flex", alignItems:"center", justifyContent:"center", background:`${G}0d` }}>
            <span style={{ fontFamily:"'DM Mono',monospace", fontSize:10, color:G }}>//</span>
          </div>
          <div>
            <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:16, fontWeight:700, color:C.text, lineHeight:1 }}>Collab<span style={{color:G}}>//</span>Mix</div>
            <div style={{ fontSize:8, fontFamily:"'DM Mono',monospace", color:`${G}66`, letterSpacing:2 }}>MUSIC LIBRARY</div>
          </div>
        </a>

        {/* Search */}
        <div style={{ flex:1, position:"relative", maxWidth:400 }}>
          <span style={{ position:"absolute", left:11, top:"50%", transform:"translateY(-50%)", color:C.muted, fontSize:13, pointerEvents:"none" }}>⌕</span>
          <input
            value={search} onChange={e=>setSearch(e.target.value)}
            placeholder="Search by title, artist, genre, album..."
            style={{ width:"100%", background:C.raised, border:`1px solid ${C.border}`, color:C.text, borderRadius:8, padding:"9px 12px 9px 32px", fontSize:12, fontFamily:"'DM Sans',sans-serif", outline:"none" }}
          />
        </div>

        {/* BPM filter */}
        <BPMRangeFilter min={60} max={200} value={bpmRange} onChange={setBpmRange}/>

        {/* Energy filter */}
        <div style={{ display:"flex", gap:4 }}>
          {ENERGY_ORDER.map(e => (
            <button key={e} onClick={()=>setEnergyFilter(energyFilter===e?null:e)}
              style={{ padding:"4px 8px", fontSize:8, fontFamily:"'DM Mono',monospace", background:energyFilter===e?ENERGY_COLOR[e]+"22":"transparent", border:`1px solid ${energyFilter===e?ENERGY_COLOR[e]+"66":C.border}`, color:energyFilter===e?ENERGY_COLOR[e]:C.muted, borderRadius:4, cursor:"pointer", letterSpacing:.5, transition:"all .15s" }}>
              {e.split(" ")[0].toUpperCase()}
            </button>
          ))}
        </div>

        {/* Stats + actions */}
        <div style={{ display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
          <div style={{ textAlign:"right" }}>
            <div style={{ fontSize:11, fontFamily:"'DM Mono',monospace", color:G }}>{tracks.length} tracks</div>
            {analyzedCount < tracks.length && (
              <div style={{ fontSize:9, fontFamily:"'DM Mono',monospace", color:C.muted, animation:"pulse 1s infinite" }}>
                {analyzedCount}/{tracks.length} analyzed
              </div>
            )}
          </div>
          <div data-itunes-helper style={{ position:"relative" }}>
            <button onClick={()=>setShowItunesHelper(v=>!v)}
              style={{ padding:"9px 14px", background:"#8B5CF615", border:`1px solid ${showItunesHelper?"#8B5CF688":"#8B5CF655"}`, color:"#8B5CF6", fontFamily:"'DM Mono',monospace", fontSize:10, letterSpacing:1.5, borderRadius:8, cursor:"pointer", display:"flex", alignItems:"center", gap:6, transition:"all .2s", whiteSpace:"nowrap" }}>
              ♪ iTunes
            </button>
            {showItunesHelper && (
              <div data-itunes-helper style={{ position:"absolute", top:"calc(100% + 8px)", right:0, width:300, background:C.raised, border:`1px solid #8B5CF644`, borderRadius:10, padding:16, zIndex:200, boxShadow:"0 12px 40px rgba(0,0,0,.7)" }}>
                <div style={{ fontSize:12, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif", marginBottom:6 }}>Scan iTunes / Apple Music</div>
                <div style={{ fontSize:11, color:C.subtle, lineHeight:1.7, marginBottom:12 }}>
                  Click below, then navigate to your iTunes music folder:
                </div>
                <div style={{ background:C.bg, borderRadius:7, padding:"10px 12px", marginBottom:12, fontSize:10, fontFamily:"'DM Mono',monospace", color:C.muted, lineHeight:2 }}>
                  <div style={{color:G}}>📁 Music</div>
                  <div style={{paddingLeft:14}}>📁 iTunes <span style={{color:C.muted}}>→</span> <span style={{color:G}}>iTunes Media</span> <span style={{color:C.muted}}>→ Music</span></div>
                  <div style={{paddingLeft:14, color:C.muted}}>or: Apple Music <span style={{color:G}}>→ Media → Music</span></div>
                </div>
                <button onClick={itunesScan}
                  style={{ width:"100%", padding:"10px", background:"#8B5CF622", border:"1px solid #8B5CF655", color:"#8B5CF6", fontFamily:"'DM Mono',monospace", fontSize:11, letterSpacing:1, borderRadius:7, cursor:"pointer", marginBottom:8 }}>
                  ⊕ Open Folder Picker
                </button>
                <div style={{ borderTop:`1px solid ${C.border}`, paddingTop:8, marginTop:4 }}>
                  <div style={{ fontSize:9, color:C.muted, marginBottom:6, fontFamily:"'DM Mono',monospace", letterSpacing:.5 }}>ADVANCED — export XML from iTunes first:</div>
                  <label style={{ fontSize:10, color:C.muted, fontFamily:"'DM Mono',monospace", cursor:"pointer", display:"flex", alignItems:"center", gap:6 }}>
                    ↗ File → Library → Export Library...
                    <input type="file" accept=".xml" style={{display:"none"}} onChange={e=>{ if(e.target.files[0]) importFromItunes(e.target.files[0]); e.target.value=""; setShowItunesHelper(false); }}/>
                  </label>
                </div>
              </div>
            )}
          </div>
          <button onClick={scanFolder} disabled={scanning}
            style={{ padding:"9px 16px", background:scanning?"transparent":`${G}22`, border:`1px solid ${G}55`, color:scanning?C.muted:G, fontFamily:"'DM Mono',monospace", fontSize:10, letterSpacing:1.5, borderRadius:8, cursor:scanning?"not-allowed":"pointer", display:"flex", alignItems:"center", gap:8, transition:"all .2s" }}>
            {scanning
              ? <><span style={{ width:10, height:10, border:`1.5px solid ${G}44`, borderTop:`1.5px solid ${G}`, borderRadius:"50%", animation:"spin 1s linear infinite", display:"inline-block" }}/> SCANNING...</>
              : "⊕ SCAN FOLDER"
            }
          </button>
          {tracks.length>0 && analyzedCount<tracks.length && (
            <button onClick={reanalyzeAll} style={{ padding:"9px 12px", background:"transparent", border:`1px solid ${C.border}`, color:C.muted, fontFamily:"'DM Mono',monospace", fontSize:9, letterSpacing:1, borderRadius:8, cursor:"pointer" }}>⟳ ANALYZE</button>
          )}
          {tracks.length>0 && <button onClick={clearAll} style={{ padding:"9px 12px", background:"transparent", border:"1px solid #ef444422", color:"#ef444455", fontFamily:"'DM Mono',monospace", fontSize:9, letterSpacing:1, borderRadius:8, cursor:"pointer" }}>✕ CLEAR</button>}
        </div>
      </div>

      {/* ── SCAN PROGRESS BAR ── */}
      {scanning && (
        <div style={{ height:3, background:C.raised, flexShrink:0 }}>
          <div style={{ height:"100%", background:`linear-gradient(90deg,${G}66,${G})`, width:`${scanProg.total>0?(scanProg.found/scanProg.total)*100:30}%`, transition:"width .3s" }}/>
        </div>
      )}
      {!scanning && analyzedCount < tracks.length && tracks.length>0 && (
        <div style={{ height:2, background:C.raised, flexShrink:0 }}>
          <div style={{ height:"100%", background:`linear-gradient(90deg,#00d4ff44,#00d4ff)`, width:`${(analyzedCount/tracks.length)*100}%`, transition:"width .5s" }}/>
        </div>
      )}

      {/* ── BODY ── */}
      <div style={{ flex:1, display:"flex", overflow:"hidden" }}>

        {/* ── LEFT NAV ── */}
        <div style={{ width:200, flexShrink:0, background:C.surface, borderRight:`1px solid ${C.border}`, display:"flex", flexDirection:"column", padding:"12px 0" }}>
          {VIEWS.map(([id,label]) => (
            <button key={id} onClick={()=>setView(id)}
              style={{ padding:"11px 18px", textAlign:"left", background:"transparent", border:"none", borderLeft:`3px solid ${view===id?G:"transparent"}`, color:view===id?G:C.subtle, fontFamily:"'DM Sans',sans-serif", fontSize:13, fontWeight:view===id?500:400, cursor:"pointer", letterSpacing:.3, transition:"all .15s" }}
              onMouseEnter={e=>{ if(view!==id) e.currentTarget.style.color=C.text; }}
              onMouseLeave={e=>{ if(view!==id) e.currentTarget.style.color=C.subtle; }}
            >{label}</button>
          ))}

          <div style={{ flex:1 }}/>

          {/* Stats block */}
          <div style={{ padding:"16px 18px", borderTop:`1px solid ${C.border}` }}>
            {[
              ["Tracks",    tracks.length],
              ["Analyzed",  analyzedCount],
              ["Crates",    crates.length],
              ["Artists",   new Set(tracks.map(t=>t.artist).filter(Boolean)).size],
            ].map(([l,v]) => (
              <div key={l} style={{ display:"flex", justifyContent:"space-between", marginBottom:5 }}>
                <span style={{ fontSize:10, color:C.muted, fontFamily:"'DM Mono',monospace" }}>{l}</span>
                <span style={{ fontSize:10, color:G, fontFamily:"'DM Mono',monospace" }}>{v}</span>
              </div>
            ))}
          </div>

          {/* Link back to mixer */}
          <div style={{ padding:"10px 18px", borderTop:`1px solid ${C.border}` }}>
            <a href="#" onClick={e=>{
              e.preventDefault();
              // If opened from mixer tab, focus it and close this tab
              if (window.opener && !window.opener.closed) {
                window.opener.focus();
                window.close();
              } else {
                // Navigate with session params for auto-rejoin
                try {
                  const s = JSON.parse(localStorage.getItem("cm_session")||"null");
                  if (s?.room && s?.name) {
                    window.location.href = `/?room=${encodeURIComponent(s.room)}&name=${encodeURIComponent(s.name)}`;
                  } else { window.location.href = "/"; }
                } catch { window.location.href = "/"; }
              }
            }} style={{ fontSize:10, fontFamily:"'DM Mono',monospace", color:C.muted, textDecoration:"none", letterSpacing:1, display:"flex", alignItems:"center", gap:6, cursor:"pointer" }}>
              ← BACK TO MIXER
            </a>
          </div>
        </div>

        {/* ── MAIN CONTENT ── */}
        <div style={{ flex:1, overflow:"hidden", display:"flex", flexDirection:"column" }}>

          {/* Empty state */}
          {tracks.length === 0 && !scanning && (
            <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:24, padding:40 }}>
              <div style={{ fontSize:64, opacity:.15 }}>♫</div>
              <div style={{ textAlign:"center" }}>
                <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:32, fontWeight:700, color:C.text, marginBottom:10 }}>Your music, organized</div>
                <div style={{ fontSize:14, color:C.muted, maxWidth:480, lineHeight:1.8 }}>
                  It doesn't matter how messy your files are. Click <strong style={{color:G}}>Scan Folder</strong> and point it at your music folder. Every track gets automatically analyzed — BPM, musical key, and energy level detected from the actual audio.
                </div>
              </div>
              <div style={{ display:"flex", gap:20 }}>
                {[["⚡","Auto-detects BPM, key, energy from audio"],["◈","Organize into crates & playlists"],["↔","Syncs live into the Collab//Mix session"]].map(([ic,t])=>(
                  <div key={t} style={{ textAlign:"center", maxWidth:160 }}>
                    <div style={{ fontSize:28, marginBottom:8, opacity:.6 }}>{ic}</div>
                    <div style={{ fontSize:11, color:C.muted, lineHeight:1.6 }}>{t}</div>
                  </div>
                ))}
              </div>
              <div style={{ display:"flex", gap:12, flexWrap:"wrap", justifyContent:"center" }}>
                <button onClick={scanFolder}
                  style={{ padding:"14px 36px", background:`linear-gradient(135deg,${G}22,${G}11)`, border:`1px solid ${G}55`, color:G, fontFamily:"'DM Mono',monospace", fontSize:12, letterSpacing:2, borderRadius:10, cursor:"pointer", boxShadow:`0 0 32px ${G}18`, transition:"all .2s" }}>
                  ⊕ SCAN MUSIC FOLDER
                </button>
                <button onClick={()=>setShowItunesHelper(v=>!v)}
                  style={{ padding:"14px 28px", background:"#8B5CF611", border:`1px solid ${showItunesHelper?"#8B5CF677":"#8B5CF644"}`, color:"#8B5CF6", fontFamily:"'DM Mono',monospace", fontSize:12, letterSpacing:2, borderRadius:10, cursor:"pointer", display:"flex", alignItems:"center", gap:8, transition:"all .2s" }}>
                  ♪ iTunes / Apple Music
                </button>
              </div>
              {showItunesHelper && (
                <div style={{ background:C.raised, border:"1px solid #8B5CF633", borderRadius:12, padding:20, maxWidth:380, width:"100%" }}>
                  <div style={{ fontSize:14, fontWeight:600, color:C.text, marginBottom:6 }}>How to scan your iTunes library</div>
                  <div style={{ fontSize:12, color:C.subtle, lineHeight:1.7, marginBottom:14 }}>
                    Click the button below, then navigate to your music folder:
                  </div>
                  <div style={{ background:C.bg, borderRadius:8, padding:"12px 16px", marginBottom:14, fontSize:11, fontFamily:"'DM Mono',monospace", color:C.muted, lineHeight:2.2 }}>
                    <div><span style={{color:G}}>📁 Music</span></div>
                    <div style={{paddingLeft:20}}>📁 iTunes → <span style={{color:G}}>iTunes Media → Music</span></div>
                    <div style={{paddingLeft:20, fontSize:10}}>or: Apple Music → <span style={{color:G}}>Media → Music</span></div>
                  </div>
                  <button onClick={itunesScan}
                    style={{ width:"100%", padding:"12px", background:"#8B5CF622", border:"1px solid #8B5CF655", color:"#8B5CF6", fontFamily:"'DM Mono',monospace", fontSize:12, letterSpacing:1.5, borderRadius:8, cursor:"pointer", marginBottom:10 }}>
                    ⊕ Open Folder Picker
                  </button>
                  <div style={{ fontSize:10, color:C.muted, fontFamily:"'DM Mono',monospace", textAlign:"center" }}>
                    Want playlists imported too?{" "}
                    <label style={{ color:"#8B5CF6", cursor:"pointer", textDecoration:"underline" }}>
                      Export XML from iTunes first
                      <input type="file" accept=".xml" style={{display:"none"}} onChange={e=>{ if(e.target.files[0]) importFromItunes(e.target.files[0]); e.target.value=""; setShowItunesHelper(false); }}/>
                    </label>
                  </div>
                </div>
              )}
              <div style={{ fontSize:10, color:C.muted, fontFamily:"'DM Mono',monospace", letterSpacing:1, textAlign:"center" }}>
                Works with Chrome or Edge · Your files never leave your computer
              </div>
            </div>
          )}

          {/* Views */}
          {tracks.length > 0 && (
            <div style={{ flex:1, overflow:"hidden", display:"flex", flexDirection:"column" }}>
              {view==="tracks"  && <TrackListView  tracks={filteredTracks} crates={crates} onAddToCrate={addToCrate} onSelect={t=>setSelected(t.id)} selected={selected} onPlay={null}/>}
              {view==="artists" && <ArtistView      tracks={filteredTracks} crates={crates} onAddToCrate={addToCrate} onSelect={t=>setSelected(t.id)} selected={selected} onPlay={null}/>}
              {view==="genres"  && <GenreView       tracks={filteredTracks} crates={crates} onAddToCrate={addToCrate} onSelect={t=>setSelected(t.id)} selected={selected} onPlay={null}/>}
              {view==="crates"  && <CratesView      tracks={tracks}         crates={crates} onCreateCrate={createCrate} onDeleteCrate={deleteCrate} onRemoveFromCrate={removeFromCrate} onAddToCrate={addToCrate} onSelect={t=>setSelected(t.id)} selected={selected} onPlay={null}/>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
