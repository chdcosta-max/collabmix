import { useState, useEffect, useRef, useCallback, useMemo } from "react";

// ═══════════════════════════════════════════════════════════════
//  COLLAB//MIX — MUSIC LIBRARY
//  Standalone app. Shares IndexedDB with the mixer.
//  Scan any folder → auto-analyze BPM, key, energy → browse by DJ utility
// ═══════════════════════════════════════════════════════════════

const DB_NAME = "cm_music_library";
const DB_VER  = 4;
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
const CAMELOT_TO_KEY = Object.fromEntries(Object.entries(CAMELOT).map(([k,v])=>[v,k]));

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
      if (!db.objectStoreNames.contains("requests")) {
        db.createObjectStore("requests", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("queue")) {
        db.createObjectStore("queue", { keyPath: "trackId" });
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
  const fmap = { "TIT2":"title","TPE1":"artist","TBPM":"bpm","TKEY":"key","TCON":"genre","TALB":"album","TRCK":"track","TYER":"year","TPUB":"label" };
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

// ── Artwork cache + fetcher (iTunes Search API — no key needed) ──
const artworkCache = new Map(); // "artist|title" → url string | null
async function fetchArtwork(artist, title) {
  const key = `${artist}|${title}`;
  if (artworkCache.has(key)) return artworkCache.get(key);
  artworkCache.set(key, null); // mark in-flight to avoid duplicate requests
  try {
    const term = encodeURIComponent(`${artist} ${title}`.trim().slice(0, 100));
    const r = await fetch(`https://itunes.apple.com/search?term=${term}&media=music&entity=song&limit=1`);
    if (!r.ok) return null;
    const data = await r.json();
    const url = data.results?.[0]?.artworkUrl100?.replace("100x100bb", "300x300bb") || null;
    artworkCache.set(key, url);
    return url;
  } catch { return null; }
}

// ── sql.js lazy loader for Rekordbox SQLite ──────────────────
let sqlJsInstance = null;
async function getSqlJs() {
  if (sqlJsInstance) return sqlJsInstance;
  return new Promise((resolve, reject) => {
    const load = () =>
      window.initSqlJs({ locateFile: f => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${f}` })
        .then(sql => { sqlJsInstance = sql; resolve(sql); })
        .catch(reject);
    if (window.initSqlJs) { load(); return; }
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/sql-wasm.js";
    s.onload = load;
    s.onerror = () => reject(new Error("Failed to load sql.js"));
    document.head.appendChild(s);
  });
}

// Rekordbox 6 numeric key → Camelot notation
const RB_KEY_MAP = {
  1:"8B",2:"3B",3:"10B",4:"5B",5:"12B",6:"7B",
  7:"2B",8:"9B",9:"4B",10:"11B",11:"6B",12:"1B",
  13:"5A",14:"12A",15:"7A",16:"2A",17:"9A",18:"4A",
  19:"11A",20:"6A",21:"1A",22:"8A",23:"3A",24:"10A",
};

async function parseRekordboxDB(arrayBuffer) {
  const SQL = await getSqlJs();
  const db = new SQL.Database(new Uint8Array(arrayBuffer));
  let tracks = [], playlists = [];
  try {
    // Tracks
    const tr = db.exec(
      "SELECT ID,Title,ArtistName,AlbumName,GenreName,BPM,Key,FolderPath,FileNameL,Duration,Year,Label " +
      "FROM Track WHERE Title IS NOT NULL AND Title!='' ORDER BY ArtistName,Title"
    );
    if (tr.length > 0) {
      const { columns, values } = tr[0];
      const ci = n => columns.indexOf(n);
      for (const row of values) {
        const bpmRaw = row[ci("BPM")];
        const keyIdx = row[ci("Key")];
        tracks.push({
          id: `rb_${row[ci("ID")]}`,
          title:  row[ci("Title")]     || "",
          artist: row[ci("ArtistName")]|| "",
          album:  row[ci("AlbumName")] || "",
          genre:  row[ci("GenreName")] || "",
          label:  row[ci("Label")]     || "",
          bpm:    bpmRaw ? Math.round(parseFloat(bpmRaw)*10)/10 : null,
          key:    RB_KEY_MAP[keyIdx] || null,
          duration: row[ci("Duration")] ? parseInt(row[ci("Duration")]) : null,
          year:   row[ci("Year")] ? String(row[ci("Year")]) : null,
          loc:    (row[ci("FolderPath")]||"") + (row[ci("FileNameL")]||""),
          source: "rekordbox",
          addedAt: Date.now(),
        });
      }
    }
    // Playlists (Attribute=0 = playlist, Attribute=1 = folder)
    const pr = db.exec("SELECT ID,Title FROM Playlist WHERE Attribute=0 ORDER BY Title");
    const plMap = new Map();
    if (pr.length > 0) {
      for (const [id, title] of pr[0].values)
        plMap.set(id, { id:`rb_pl_${id}`, name:title, trackIds:[] });
    }
    // Playlist songs
    const sr = db.exec("SELECT PlaylistID,TrackID FROM PlaylistSong ORDER BY PlaylistID,TrackNo");
    if (sr.length > 0) {
      for (const [plId, trackId] of sr[0].values) {
        const pl = plMap.get(plId);
        if (pl) pl.trackIds.push(`rb_${trackId}`);
      }
    }
    playlists = Array.from(plMap.values()).filter(p => p.trackIds.length > 0);
  } finally { db.close(); }
  return { tracks, playlists };
}

// ── iTunes XML parser ─────────────────────────────────────────
function parseiTunesXML(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "text/xml");
  const root = doc.querySelector("plist > dict");
  if (!root) return { tracks: [], playlists: [] };

  // Strip comma/space artifacts from auto-generated XML values (e.g. ", value,")
  const clean = (t) => t ? t.replace(/^[,\s]+/, "").replace(/[,\s]+$/, "") : t;

  function parseDict(dictEl) {
    const obj = {};
    const kids = Array.from(dictEl.children);
    for (let i = 0; i < kids.length - 1; i += 2) {
      const key = clean(kids[i]?.textContent);
      const val = kids[i+1];
      if (!key || !val) continue;
      const t = val.tagName;
      if (t==="string")  obj[key] = clean(val.textContent);
      else if (t==="integer") obj[key] = parseInt(clean(val.textContent), 10);
      else if (t==="real")    obj[key] = parseFloat(clean(val.textContent));
      else if (t==="true")    obj[key] = true;
      else if (t==="false")   obj[key] = false;
      else if (t==="dict")    obj[key] = parseDict(val);
      else if (t==="array")   obj[key] = Array.from(val.children).map(el => el.tagName==="dict" ? parseDict(el) : clean(el.textContent));
    }
    return obj;
  }

  const rootObj = parseDict(root);
  const tracksDict = rootObj["Tracks"] || {};
  const playlistsArr = rootObj["Playlists"] || [];

  const tracks = Object.values(tracksDict)
    .filter(t => t["Location"] && !t["Podcast"] && t["Track Type"] !== "URL")
    .map(t => {
      const rawLoc = (t["Location"] || "").replace(/^file:\/\/,?\s*/, "file://");
      const loc = decodeURIComponent(rawLoc.replace(/^file:\/\/+/, "/"));
      const filename = loc.split("/").pop();
      const keyRaw = t["Initial Key"] || "";
      return {
        id: `itunes_${t["Track ID"]}`,
        itunesId: String(t["Track ID"]),
        title: t["Name"] || filename.replace(/\.[^.]+$/, ""),
        artist: t["Artist"] || t["Album Artist"] || "",
        album: t["Album"] || "",
        genre: t["Genre"] || "",
        label: t["Publisher"] || "",
        bpm: t["BPM"] ? parseFloat(t["BPM"]) : null,
        key: keyRaw || null,
        duration: t["Total Time"] ? t["Total Time"] / 1000 : null,
        location: loc,
        filename: filename.replace(/\.[^.]+$/, ""),
        year: t["Year"] ? String(t["Year"]) : "",
        playCount: t["Play Count"] || 0,
        analyzed: !!(t["BPM"] || keyRaw),
        energy: null,
        cloudOnly: true,   // assume cloud until a local scan matches the file
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

// ── Parse Rekordbox XML ───────────────────────────────────────
function parseRekordboxXML(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "text/xml");

  // Check it's actually a Rekordbox XML
  if (!doc.querySelector("DJ_PLAYLISTS")) return { tracks: [], playlists: [] };

  const trackEls = doc.querySelectorAll("COLLECTION > TRACK");
  const tracks = [];
  const trackById = {}; // TrackID → track object

  for (const el of trackEls) {
    const location = el.getAttribute("Location") || "";
    // Rekordbox location: "file://localhost/path/..." or "file:///path/..."
    const filePath = decodeURIComponent(
      location.replace(/^file:\/\/localhost/, "").replace(/^file:\/\//, "")
    );
    const filename = filePath.split("/").pop() || "";
    const trackId  = el.getAttribute("TrackID") || "";

    const bpmStr   = el.getAttribute("AverageBpm");
    const bpm      = bpmStr ? parseFloat(bpmStr) : null;
    const totalTime = el.getAttribute("TotalTime");
    const duration  = totalTime ? parseFloat(totalTime) : null;
    const tonality  = el.getAttribute("Tonality") || "";
    // Convert Camelot → musical key (e.g. "9B" → "G") so our key filter works
    const key = CAMELOT_TO_KEY[tonality] || tonality || null;

    const track = {
      id:         `rb_${trackId}`,
      rbTrackId:  trackId,
      itunesId:   null,
      title:      el.getAttribute("Name")   || filename.replace(/\.[^.]+$/, ""),
      artist:     el.getAttribute("Artist") || "",
      album:      el.getAttribute("Album")  || "",
      genre:      el.getAttribute("Genre")  || "",
      label:      el.getAttribute("Label")  || "",
      year:       el.getAttribute("Year")   || "",
      bpm,
      key,
      duration,
      energy:     null,
      analyzed:   !!(bpm || key),   // Rekordbox pre-analyzed — no need to re-analyze
      cloudOnly:  false,
      filename:   filename.replace(/\.[^.]+$/, ""),
      path:       filePath,
      source:     "rekordbox",
      playCount:  parseInt(el.getAttribute("PlayCount") || "0", 10) || 0,
      addedAt:    Date.now(),
    };

    tracks.push(track);
    trackById[trackId] = track;
  }

  // Parse playlists recursively (TYPE="0" = folder, TYPE="1" = playlist)
  const playlists = [];
  const parseNode = (node, folderPath = "") => {
    const type = node.getAttribute("Type");
    const name = node.getAttribute("Name") || "";
    if (type === "1") {
      // Playlist node
      const trackIds = Array.from(node.querySelectorAll(":scope > TRACK"))
        .map(t => trackById[t.getAttribute("Key")]?.id)
        .filter(Boolean);
      if (trackIds.length > 0) {
        playlists.push({ name: folderPath ? `${folderPath} / ${name}` : name, trackIds });
      }
    } else {
      // Folder or root — recurse, passing folder name as prefix
      const prefix = (name && name !== "ROOT") ? (folderPath ? `${folderPath} / ${name}` : name) : folderPath;
      for (const child of node.querySelectorAll(":scope > NODE")) parseNode(child, prefix);
    }
  };
  const rootNode = doc.querySelector("PLAYLISTS > NODE");
  if (rootNode) parseNode(rootNode);

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

// ── Open Apple Music (deep-link via anchor click — works in Chrome/Safari/Edge) ──
function openAppleMusic(artist, title) {
  const term = encodeURIComponent(`${artist||""} ${title||""}`.trim());
  const a = document.createElement("a");
  a.href = `music://music.apple.com/search?term=${term}`;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { try { document.body.removeChild(a); } catch {} }, 200);
}

// ── Colour-hash for artwork avatars ──────────────────────────
const AVATAR_COLORS = [
  ["#8B5CF6","#6D28D9"], ["#C8A96E","#A07840"], ["#00d4ff","#0099bb"],
  ["#22c55e","#16a34a"], ["#f59e0b","#d97706"], ["#ef4444","#dc2626"],
  ["#ec4899","#db2777"], ["#14b8a6","#0d9488"],
];
function avatarColor(str="") {
  let h = 0;
  for (let i=0;i<str.length;i++) h = (h<<5)-h+str.charCodeAt(i);
  return AVATAR_COLORS[Math.abs(h)%AVATAR_COLORS.length];
}

const SOURCE_BADGE = { rekordbox:"RB", itunes:"iTu", local:"" };

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
function TrackRow({ track, selected, onClick, onAddToCrate, crates, onPlay, onSendToDeck, queueIds, onToggleQueue }) {
  const [hov, setHov] = useState(false);
  const [showCrateMenu, setShowCrateMenu] = useState(false);
  const [artworkUrl, setArtworkUrl] = useState(() => artworkCache.get(`${track.artist}|${track.title}`) || null);
  const camelot = CAMELOT[track.key] || (track.key?.match(/^\d+[AB]$/) ? track.key : null);
  const eColor = ENERGY_COLOR[track.energy?.label] || C.muted;
  const isMinor = camelot?.endsWith("A");
  const keyColor = isMinor ? "#8B6EAF" : G;
  const [ac, ac2] = avatarColor(track.artist || track.title || "");
  const initial = (track.artist || track.title || "?")[0].toUpperCase();
  const srcBadge = SOURCE_BADGE[track.source];
  const inQ = queueIds?.has(track.id);

  // Fetch artwork lazily
  useEffect(() => {
    if (artworkUrl) return; // already have it
    let cancelled = false;
    fetchArtwork(track.artist || "", track.title || "").then(url => {
      if (!cancelled && url) setArtworkUrl(url);
    });
    return () => { cancelled = true; };
  }, [track.artist, track.title]);

  return (
    <div
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => { setHov(false); setShowCrateMenu(false); }}
      onClick={() => onClick(track)}
      style={{
        display:"grid",
        gridTemplateColumns:"28px 36px 1fr 90px 56px 80px 52px 96px",
        gap:8,
        alignItems:"center",
        padding:"6px 14px",
        background: selected ? `${G}0e` : hov ? `${C.raised}ee` : "transparent",
        borderBottom: `1px solid ${C.border}44`,
        cursor:"pointer",
        transition:"background .1s",
        position:"relative",
      }}
    >
      {/* # / play */}
      <div style={{ textAlign:"center", color: hov ? G : C.muted, fontSize:10, fontFamily:"'DM Mono',monospace" }}>
        {hov
          ? track.cloudOnly
            ? <span onClick={e=>{e.stopPropagation();openAppleMusic(track.artist,track.title);}} title="Open in Apple Music to download" style={{fontSize:15,cursor:"pointer",color:"#60a5fa"}}>⬇</span>
            : <span onClick={e=>{e.stopPropagation();onPlay&&onPlay(track);}} style={{fontSize:15,cursor:"pointer",color:G}}>▶</span>
          : track.cloudOnly
            ? <span title="Cloud only" style={{fontSize:10,color:"#60a5fa",opacity:.7}}>☁</span>
            : <span style={{opacity:.4}}>{track._rowNum||""}</span>
        }
      </div>

      {/* Artwork avatar — real art when available, gradient fallback */}
      <div style={{
        width:34, height:34, borderRadius:6, flexShrink:0,
        background: artworkUrl ? "#000" : `linear-gradient(135deg,${ac},${ac2})`,
        display:"flex", alignItems:"center", justifyContent:"center",
        fontSize:13, fontWeight:700, color:"#fff", fontFamily:"'DM Sans',sans-serif",
        boxShadow:`0 2px 8px ${ac}44`, userSelect:"none",
        position:"relative", overflow:"hidden",
      }}>
        {artworkUrl
          ? <img src={artworkUrl} alt="" style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }} onError={()=>setArtworkUrl(null)}/>
          : initial
        }
        {srcBadge && (
          <div style={{ position:"absolute", bottom:0, right:0, background:"rgba(0,0,0,.7)", fontSize:6, fontFamily:"'DM Mono',monospace", color:"#fff", padding:"1px 3px", lineHeight:1.4, letterSpacing:.5, borderRadius:"4px 0 0 0" }}>{srcBadge}</div>
        )}
      </div>

      {/* Title + artist */}
      <div style={{ minWidth:0 }}>
        <div style={{ display:"flex", alignItems:"center", gap:5 }}>
          <div style={{ fontSize:13, fontWeight:500, color: track.cloudOnly ? C.subtle : C.text, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", fontFamily:"'DM Sans',sans-serif" }}>
            {track.title || track.filename}
          </div>
          {track.cloudOnly && <span onClick={e=>{e.stopPropagation();openAppleMusic(track.artist,track.title);}} title="Click to open in Apple Music and download" style={{fontSize:8,color:"#60a5fa",background:"#60a5fa15",border:"1px solid #60a5fa33",borderRadius:3,padding:"1px 4px",flexShrink:0,fontFamily:"'DM Mono',monospace",cursor:"pointer"}}>☁</span>}
          {inQ && <span style={{fontSize:8,color:"#22c55e",background:"#22c55e15",border:"1px solid #22c55e33",borderRadius:3,padding:"1px 4px",flexShrink:0,fontFamily:"'DM Mono',monospace"}}>Q</span>}
        </div>
        <div style={{ fontSize:10, color:C.subtle, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", fontFamily:"'DM Sans',sans-serif", marginTop:1 }}>
          {track.artist || "Unknown Artist"}
          {track.genre ? <span style={{color:C.muted}}> · {track.genre}</span> : null}
        </div>
      </div>

      {/* BPM */}
      <div style={{ textAlign:"right" }}>
        <div style={{ fontSize:13, fontFamily:"'DM Mono',monospace", color:track.bpm?G:C.muted, fontWeight:600 }}>{fmtBPM(track.bpm)}</div>
        {!track.analyzed && <div style={{ fontSize:7, color:C.muted, fontFamily:"'DM Mono',monospace", letterSpacing:.5 }}>analyzing</div>}
      </div>

      {/* Key (Camelot) */}
      <div style={{ textAlign:"center" }}>
        {camelot
          ? <div style={{ fontSize:11, fontFamily:"'DM Mono',monospace", color:keyColor, background:keyColor+"18", borderRadius:4, padding:"2px 6px", display:"inline-block", fontWeight:700 }}>{camelot}</div>
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

      {/* Actions (always show deck buttons, queue on hover) */}
      <div style={{ display:"flex", gap:3, justifyContent:"flex-end", alignItems:"center" }}>
        {onToggleQueue && (
          <button
            onClick={e=>{ e.stopPropagation(); onToggleQueue(track.id); }}
            title={inQ ? "Remove from queue" : "Add to queue"}
            style={{ fontSize:9, fontFamily:"'DM Mono',monospace", padding:"3px 6px", background:inQ?"#22c55e18":"transparent", border:`1px solid ${inQ?"#22c55e44":C.border}`, color:inQ?"#22c55e":C.muted, borderRadius:4, cursor:"pointer", opacity: hov||inQ ? 1 : 0, transition:"all .15s" }}
          >{inQ ? "✓" : "+"}</button>
        )}
        {track.cloudOnly ? (
          <button
            onClick={e=>{ e.stopPropagation(); openAppleMusic(track.artist, track.title); }}
            style={{ fontSize:9, fontFamily:"'DM Mono',monospace", padding:"3px 6px", background:"#60a5fa14", border:"1px solid #60a5fa44", color:"#60a5fa", borderRadius:4, cursor:"pointer", opacity: hov ? 1 : 0.4, transition:"opacity .15s" }}
          >⬇</button>
        ) : onSendToDeck ? (
          <div style={{ display:"flex", gap:2 }}>
            <button
              onClick={e=>{ e.stopPropagation(); onSendToDeck(track,"A"); }}
              title="Load to Deck A"
              style={{ fontSize:9, fontFamily:"'DM Mono',monospace", padding:"3px 7px", background:`${G}18`, border:`1px solid ${G}44`, color:G, borderRadius:4, cursor:"pointer", fontWeight:600, opacity: hov ? 1 : 0.5, transition:"all .15s" }}
            >A</button>
            <button
              onClick={e=>{ e.stopPropagation(); onSendToDeck(track,"B"); }}
              title="Load to Deck B"
              style={{ fontSize:9, fontFamily:"'DM Mono',monospace", padding:"3px 7px", background:"#00d4ff18", border:"1px solid #00d4ff44", color:"#00d4ff", borderRadius:4, cursor:"pointer", fontWeight:600, opacity: hov ? 1 : 0.5, transition:"all .15s" }}
            >B</button>
          </div>
        ) : null}
        <div style={{ position:"relative" }}>
          <button
            onClick={e=>{ e.stopPropagation(); setShowCrateMenu(v=>!v); }}
            style={{ fontSize:11, padding:"2px 6px", background:"transparent", border:`1px solid ${C.border}`, color:C.muted, borderRadius:4, cursor:"pointer", opacity: hov ? 1 : 0, transition:"opacity .15s" }}
          >⋮</button>
          {showCrateMenu && (
            <div style={{ position:"absolute", right:0, top:"100%", zIndex:100, background:C.raised, border:`1px solid ${C.border}`, borderRadius:8, padding:6, minWidth:160, boxShadow:"0 8px 24px rgba(0,0,0,.6)" }}>
              <div style={{ fontSize:9, color:C.muted, fontFamily:"'DM Mono',monospace", padding:"2px 8px 6px", letterSpacing:1 }}>ADD TO CRATE</div>
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
    <div style={{ display:"grid", gridTemplateColumns:"28px 36px 1fr 90px 56px 80px 52px 96px", gap:8, padding:"7px 14px", borderBottom:`1px solid ${C.border}`, background:C.surface, flexShrink:0 }}>
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
function TrackListView({ tracks, crates, onAddToCrate, onSelect, selected, onPlay, onSendToDeck, queueIds, onToggleQueue }) {
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

  const COLS = [["#",null],["",null],["TITLE / ARTIST","title"],["BPM","bpm"],["KEY","key"],["ENERGY","energy"],["TIME","duration"],["",null]];

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", overflow:"hidden" }}>
      <ColHeader cols={COLS} sortBy={sortBy} sortDir={sortDir} onSort={handleSort}/>
      <div style={{ flex:1, overflowY:"auto" }}>
        {sorted.map(t => (
          <TrackRow key={t.id} track={t} selected={selected===t.id} onClick={onSelect}
            onAddToCrate={onAddToCrate} crates={crates} onPlay={onPlay} onSendToDeck={onSendToDeck}
            queueIds={queueIds} onToggleQueue={onToggleQueue}/>
        ))}
        {tracks.length === 0 && (
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100%", gap:16, fontFamily:"'DM Mono',monospace" }}>
            <div style={{ fontSize:40, opacity:.15 }}>♫</div>
            <div style={{ fontSize:11, color:C.muted }}>No tracks found</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Artist view ───────────────────────────────────────────────
function ArtistView({ tracks, crates, onAddToCrate, onSelect, selected, onPlay, onSendToDeck, queueIds, onToggleQueue }) {
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
              <TrackListView tracks={artistTracks} crates={crates} onAddToCrate={onAddToCrate} onSelect={onSelect} selected={selected} onPlay={onPlay} onSendToDeck={onSendToDeck} queueIds={queueIds} onToggleQueue={onToggleQueue}/>
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

// ── Generic grouped sidebar + tracklist view ───────────────────
function GroupedView({ tracks, crates, onAddToCrate, onSelect, selected, onPlay, onSendToDeck, queueIds, onToggleQueue, getKey, sortGroups, colorFn, accentColor, emptyText }) {
  const [activeKey, setActiveKey] = useState(null);
  const color = accentColor || G;

  const groups = useMemo(() => {
    const map = {};
    for (const t of tracks) {
      const k = getKey(t) || "Unknown";
      if (!map[k]) map[k] = [];
      map[k].push(t);
    }
    const entries = Object.entries(map);
    return sortGroups ? sortGroups(entries) : entries.sort((a,b) => b[1].length - a[1].length);
  }, [tracks]);

  const filteredTracks = useMemo(() =>
    activeKey ? tracks.filter(t => (getKey(t) || "Unknown") === activeKey) : [],
  [tracks, activeKey]);

  return (
    <div style={{ display:"flex", height:"100%", overflow:"hidden" }}>
      <div style={{ width:220, flexShrink:0, overflowY:"auto", borderRight:`1px solid ${C.border}`, background:C.bg }}>
        {groups.map(([label, gtracks]) => {
          const c = colorFn ? colorFn(label) : color;
          const isActive = activeKey === label;
          return (
            <div key={label} onClick={() => setActiveKey(isActive ? null : label)}
              style={{ padding:"10px 14px", display:"flex", alignItems:"center", gap:10, cursor:"pointer", background:isActive?`${c}0d`:"transparent", borderBottom:`1px solid ${C.border}44`, transition:"background .1s" }}
              onMouseEnter={e=>e.currentTarget.style.background=isActive?`${c}0d`:C.raised}
              onMouseLeave={e=>e.currentTarget.style.background=isActive?`${c}0d`:"transparent"}
            >
              <div style={{ width:8, height:8, borderRadius:"50%", background:c, flexShrink:0 }}/>
              <div style={{ flex:1, fontSize:12, color:isActive?c:C.text, fontFamily:"'DM Sans',sans-serif", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{label}</div>
              <span style={{ fontSize:10, color:C.muted, fontFamily:"'DM Mono',monospace", flexShrink:0 }}>{gtracks.length}</span>
            </div>
          );
        })}
        {groups.length === 0 && (
          <div style={{ padding:"20px 14px", fontSize:10, color:C.muted, fontFamily:"'DM Mono',monospace", lineHeight:1.8 }}>
            {emptyText || "No data yet.\nAnalysis will fill this in."}
          </div>
        )}
      </div>
      <div style={{ flex:1, overflow:"hidden", display:"flex", flexDirection:"column" }}>
        {activeKey ? (
          <>
            <div style={{ padding:"12px 16px", borderBottom:`1px solid ${C.border}`, background:C.surface, flexShrink:0, display:"flex", alignItems:"center", gap:10 }}>
              <div style={{ width:10, height:10, borderRadius:"50%", background:colorFn?colorFn(activeKey):color, flexShrink:0 }}/>
              <div style={{ fontSize:18, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif" }}>{activeKey}</div>
              <div style={{ fontSize:10, color:C.muted, fontFamily:"'DM Mono',monospace" }}>{filteredTracks.length} tracks</div>
            </div>
            <div style={{ flex:1, overflow:"hidden" }}>
              <TrackListView tracks={filteredTracks} crates={crates} onAddToCrate={onAddToCrate} onSelect={onSelect} selected={selected} onPlay={onPlay} onSendToDeck={onSendToDeck} queueIds={queueIds} onToggleQueue={onToggleQueue}/>
            </div>
          </>
        ) : (
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100%", gap:6, color:C.muted, fontFamily:"'DM Mono',monospace", fontSize:11, letterSpacing:1 }}>
            <div style={{ fontSize:22, opacity:.15 }}>←</div>
            SELECT A CATEGORY
          </div>
        )}
      </div>
    </div>
  );
}

// ── Energy view ───────────────────────────────────────────────
function EnergyView(props) {
  return (
    <GroupedView {...props}
      getKey={t => t.energy?.label || null}
      sortGroups={entries => {
        const order = ENERGY_ORDER;
        return entries.sort((a,b) => order.indexOf(a[0]) - order.indexOf(b[0]));
      }}
      colorFn={label => ENERGY_COLOR[label] || C.muted}
      emptyText={"Tracks are analyzed as they load.\nEnergy levels will appear here."}
    />
  );
}

// ── Genre view ────────────────────────────────────────────────
function GenreView(props) {
  return (
    <GroupedView {...props}
      getKey={t => t.genre || null}
      accentColor={G}
      emptyText={"No genre tags found yet.\nID3 tags will fill this in."}
    />
  );
}

// ── Label view ────────────────────────────────────────────────
function LabelView(props) {
  return (
    <GroupedView {...props}
      getKey={t => t.label || null}
      accentColor={"#00d4ff"}
      emptyText={"No record label tags found.\nLabels come from ID3 TPUB tags\nor iTunes Publisher field."}
    />
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
  const [sourceFilter, setSourceFilter] = useState(null); // "itunes" | "rekordbox" | null
  const [scanning, setScanning] = useState(false);
  const [scanProg, setScanProg] = useState({ found:0, analyzed:0, total:0 });
  const [selected, setSelected] = useState(null);
  const [search,   setSearch]   = useState("");
  const [bpmRange, setBpmRange] = useState([60, 180]);
  const [energyFilter, setEnergyFilter] = useState(null);
  const [keyFilter,    setKeyFilter]    = useState(null);
  const [showItunesHelper,  setShowItunesHelper]  = useState(false);
  const [cratesExpanded,    setCratesExpanded]     = useState(true);
  const [activeCrateId,     setActiveCrateId]      = useState(null);
  const [showNewCrateInput, setShowNewCrateInput]  = useState(false);
  const [newCrateName,      setNewCrateName]        = useState("");
  const [queueIds,          setQueueIds]            = useState(() => new Set());
  const [itunesPicker,      setItunesPicker]       = useState(null); // { tracks, playlists, selectedPls, importMode }
  const [itunesDirHandle,   setItunesDirHandle]    = useState(null); // remembered file handle for re-sync
  const [rbPicker,          setRbPicker]           = useState(null); // { tracks, playlists, selectedPls, importMode }
  const [rbFileHandle,      setRbFileHandle]       = useState(null); // legacy XML file handle
  const [rbDirHandle,       setRbDirHandle]        = useState(null); // directory handle → reads master.db
  const [scanDirHandle,     setScanDirHandle]      = useState(null); // remembered music folder → skip picker on rescan
  const searchRef = useRef(null);

  useEffect(() => {
    if (!showItunesHelper) return;
    const close = (e) => { if (!e.target.closest("[data-itunes-helper]")) setShowItunesHelper(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [showItunesHelper]);

  // Keyboard shortcuts: "/" = focus search, Escape = clear search
  useEffect(() => {
    const handler = (e) => {
      if (e.key === "/" && !e.target.matches("input,textarea,select")) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Helper: switch standard view and clear crate selection
  const selectView = (id) => { setView(id); setActiveCrateId(null); };
  // Helper: select a crate
  const selectCrate = (id) => { setActiveCrateId(id); setView("crate"); };

  // ── Init DB + worker ────────────────────────────────────────
  useEffect(() => {
    openDB().then(async db => {
      dbRef.current = db;
      const [ts, cs, qs, savedItunes, savedRb, savedRbDir, savedScanDir] = await Promise.all([
        dbGetAll(db,"tracks"), dbGetAll(db,"crates"), dbGetAll(db,"queue"),
        dbGet(db,"handles","itunes_file"),
        dbGet(db,"handles","rb_file"),
        dbGet(db,"handles","rb_dir"),
        dbGet(db,"handles","scan_dir"),
      ]);
      setTracks(ts.sort((a,b)=>b.addedAt-a.addedAt));
      setCrates(cs);
      setQueueIds(new Set(qs.map(q=>q.trackId)));
      if (savedItunes?.handle) setItunesDirHandle(savedItunes.handle);
      if (savedRb?.handle) setRbFileHandle(savedRb.handle);
      if (savedRbDir?.handle) setRbDirHandle(savedRbDir.handle);
      // Restore the saved music folder handle and auto-rescan if permission is still granted.
      // Passing `ts` avoids re-importing tracks already in the library.
      if (savedScanDir?.handle) {
        setScanDirHandle(savedScanDir.handle);
        try {
          const perm = await savedScanDir.handle.queryPermission({ mode: "read" });
          if (perm === "granted") {
            setTimeout(() => scanFolder(savedScanDir.handle, ts), 500);
          }
        } catch {}
      }
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
  // existingTracks can be passed explicitly (e.g. on auto-rescan at startup before React
  // state is populated) — falls back to the current `tracks` state for manual scans.
  const scanFolder = async (preHandle = null, existingTracks = null) => {
    // Use a previously-saved folder handle so the user doesn't have to pick again
    let dirHandle = preHandle ?? scanDirHandle;
    if (!dirHandle) {
      try { dirHandle = await window.showDirectoryPicker({ mode:"read", startIn:"downloads" }); }
      catch { return; }
    }

    setScanning(true);
    setScanProg({ found:0, analyzed:0, total:0 });

    const db = dbRef.current;
    const trackList = existingTracks ?? tracks;
    const existing = new Set(trackList.map(t=>t.id));
    // Build a filename→track map for cloud tracks so we can link local files to them
    const cloudByFilename = {};
    trackList.forEach(t => { if (t.cloudOnly && t.filename) cloudByFilename[t.filename] = t; });
    const cloudByFilenameNoExt = {};
    trackList.forEach(t => { if (t.cloudOnly && t.filename) cloudByFilenameNoExt[t.filename.replace(/\.[^.]+$/,"")] = t; });

    let found = 0;

    try {
      for await (const { name, handle, path } of scanDir(dirHandle)) {
        found++;
        setScanProg(p => ({ ...p, found }));
        const nameNoExt = name.replace(/\.[^.]+$/,"");

        // Check if a cloud-imported iTunes track matches this file
        const cloudMatch = cloudByFilename[name] || cloudByFilenameNoExt[nameNoExt];
        if (cloudMatch) {
          // Link the local file handle to the existing cloud track
          const updated = { ...cloudMatch, cloudOnly: false };
          setTracks(prev => prev.map(t => t.id === cloudMatch.id ? updated : t));
          await dbPut(db, "tracks",  updated);
          await dbPut(db, "handles", { id: cloudMatch.id, handle });
          if (!cloudMatch.analyzed) queueRef.current.push({ id: cloudMatch.id });
          continue;
        }

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
          label:  tags.label  || "",
          year:   tags.year   || "",
          bpm:    tags.bpm    ? parseFloat(tags.bpm) : null,
          key:    tags.key    || null,
          duration: null,
          energy:   null,
          analyzed: false,
          cloudOnly: false,
          source: "local",
          addedAt:  Date.now(),
        };

        setTracks(prev => [track, ...prev]);
        await dbPut(db, "tracks",  track);
        await dbPut(db, "handles", { id, handle });
        queueRef.current.push({ id });
      }
    } catch(scanErr) {
      console.error("Scan error:", scanErr);
    } finally {
      setScanProg(p => ({ ...p, total: found }));
      setScanning(false);
      processQueue();
      // Save the folder handle so future button clicks and page loads skip the picker
      if (db) await dbPut(db, "handles", { id: "scan_dir", handle: dirHandle });
      setScanDirHandle(dirHandle);
    }
  };

  // ── iTunes / Apple Music guided scan ─────────────────────────
  const itunesScan = async () => {
    setShowItunesHelper(false);
    await scanFolder();
  };

  // ── iTunes: pick Library.xml file directly ────────────────────
  const autoImportItunes = async (preHandle = null) => {
    let fileHandle = preHandle;
    if (!fileHandle) {
      try {
        [fileHandle] = await window.showOpenFilePicker({
          id: "itunes-library",
          types: [{ description: "iTunes / Apple Music Library XML", accept: { "text/xml": [".xml"] } }],
          startIn: "music",
          multiple: false,
        });
      } catch { return; } // user cancelled
    }

    try {
      const perm = await fileHandle.queryPermission({ mode: "read" });
      if (perm !== "granted") await fileHandle.requestPermission({ mode: "read" });
      const file = await fileHandle.getFile();
      const text = await file.text();
      const { tracks: itTracks, playlists: itPlaylists } = parseiTunesXML(text);

      if (!itTracks.length) {
        alert(
          "No tracks found in this file.\n\n" +
          "Make sure you selected your Library.xml from Apple Music.\n\n" +
          "One-time setup: Open Apple Music → Settings → Advanced\n" +
          "→ Enable \"Share iTunes Library XML with other applications\"\n" +
          "The file appears automatically at ~/Music/Music/Library.xml"
        );
        return;
      }

      // Save file handle for auto re-sync
      if (dbRef.current) {
        await dbPut(dbRef.current, "handles", { id: "itunes_file", handle: fileHandle });
        setItunesDirHandle(fileHandle);
      }

      setShowItunesHelper(false);
      setItunesPicker({
        tracks:      itTracks,
        playlists:   itPlaylists,
        selectedPls: new Set(itPlaylists.map(p => p.name)),
        importMode:  "all",
      });
    } catch(e) {
      console.error("iTunes parse error", e);
      alert("Could not read that file. Please select a valid Library.xml from Apple Music.");
    }
  };

  // ── Re-sync iTunes using remembered file handle ───────────────
  const resyncItunes = async () => {
    if (!itunesDirHandle) return;
    try {
      const perm = await itunesDirHandle.queryPermission({ mode: "read" });
      if (perm !== "granted") await itunesDirHandle.requestPermission({ mode: "read" });
      await autoImportItunes(itunesDirHandle);
    } catch(e) {
      console.warn("iTunes re-sync failed, resetting handle", e);
      setItunesDirHandle(null);
      if (dbRef.current) await dbDelete(dbRef.current, "handles", "itunes_file");
    }
  };

  // ── Rekordbox: read master.db from a directory handle ────────
  const loadRekordboxDir = async (dirHandle) => {
    try {
      const perm = await dirHandle.queryPermission({ mode: "read" });
      if (perm !== "granted") await dirHandle.requestPermission({ mode: "read" });

      // Search for master.db across common known sub-paths so the user can
      // pick ~/Music, ~/Music/PioneerDJ, or the exact rekordbox6 folder
      const searchPaths = [
        [],                                          // picked folder itself
        ["PioneerDJ"],                               // ~/Music/PioneerDJ/
        ["rekordbox6"],
        ["Pioneer", "rekordbox6"],
        ["rekordbox"],
        ["Application Support", "Pioneer", "rekordbox6"],
      ];

      let dbFileHandle = null;
      outer: for (const parts of searchPaths) {
        let cur = dirHandle;
        try {
          for (const p of parts) cur = await cur.getDirectoryHandle(p);
          for (const name of ["master.db", "rekordbox.db"]) {
            try { dbFileHandle = await cur.getFileHandle(name); break outer; }
            catch {}
          }
        } catch {}
      }

      if (!dbFileHandle) {
        alert(
          "Rekordbox database not found.\n\n" +
          "Try selecting one of these folders in the picker:\n" +
          "• ~/Music/PioneerDJ\n" +
          "• ~/Library/Application Support/Pioneer/rekordbox6\n\n" +
          "To reach the Library folder, press ⌘⇧G in the picker and paste the path."
        );
        return;
      }

      const file = await dbFileHandle.getFile();
      const buf  = await file.arrayBuffer();
      const { tracks: rbTracks, playlists: rbPlaylists } = await parseRekordboxDB(buf);

      if (!rbTracks.length) {
        alert("No tracks found in the Rekordbox database. Make sure Rekordbox has tracks imported.");
        return;
      }

      // Save directory handle for future auto-sync
      if (dbRef.current) {
        await dbPut(dbRef.current, "handles", { id: "rb_dir", handle: dirHandle });
        setRbDirHandle(dirHandle);
      }

      setRbPicker({
        tracks:      rbTracks,
        playlists:   rbPlaylists,
        selectedPls: new Set(rbPlaylists.map(p => p.name)),
        importMode:  "all",
      });
    } catch(e) {
      console.error("Rekordbox DB read error", e);
      alert("Could not read the Rekordbox database. " + (e.message || ""));
    }
  };

  // ── Rekordbox: open directory picker → reads master.db ───────
  const importRekordbox = async () => {
    let dirHandle;
    try {
      dirHandle = await window.showDirectoryPicker({ id: "rekordbox-db6", mode: "read" });
    } catch { return; } // user cancelled
    await loadRekordboxDir(dirHandle);
  };

  // ── Re-sync Rekordbox using saved directory handle ────────────
  const resyncRekordbox = async () => {
    const handle = rbDirHandle || (rbFileHandle ? null : null);
    if (rbDirHandle) {
      try { await loadRekordboxDir(rbDirHandle); }
      catch(e) {
        console.warn("Rekordbox re-sync failed", e);
        setRbDirHandle(null);
        if (dbRef.current) await dbDelete(dbRef.current, "handles", "rb_dir");
      }
    } else if (rbFileHandle) {
      // Legacy XML fallback
      try {
        const perm = await rbFileHandle.queryPermission({ mode: "read" });
        if (perm !== "granted") await rbFileHandle.requestPermission({ mode: "read" });
        const file = await rbFileHandle.getFile();
        const text = await file.text();
        const { tracks: rbTracks, playlists: rbPlaylists } = parseRekordboxXML(text);
        if (rbTracks.length) setRbPicker({ tracks:rbTracks, playlists:rbPlaylists, selectedPls:new Set(rbPlaylists.map(p=>p.name)), importMode:"all" });
      } catch(e) {
        setRbFileHandle(null);
        if (dbRef.current) await dbDelete(dbRef.current, "handles", "rb_file");
      }
    }
  };

  // ── Perform Rekordbox import after playlist selection ────────────
  const doRekordboxImport = async () => {
    if (!rbPicker) return;
    const { tracks: rbTracks, playlists: rbPlaylists, selectedPls, importMode } = rbPicker;
    setRbPicker(null);
    setScanning(true);
    setScanProg({ found: 0, analyzed: 0, total: 0 });

    try {
      let tracksToImport = rbTracks;
      if (importMode === "playlists") {
        const selectedTrackIds = new Set(
          rbPlaylists.filter(p => selectedPls.has(p.name)).flatMap(p => p.trackIds)
        );
        tracksToImport = rbTracks.filter(t => selectedTrackIds.has(t.id));
      }

      const db = dbRef.current;
      const existing = new Set(tracks.map(t => t.id));

      let added = 0;
      for (const t of tracksToImport) {
        if (existing.has(t.id)) continue;
        setTracks(prev => [t, ...prev]);
        await dbPut(db, "tracks", t);
        added++;
        setScanProg(p => ({ ...p, found: added }));
      }

      // Create crates from playlists
      const playlistsToProcess = importMode === "playlists"
        ? rbPlaylists.filter(p => selectedPls.has(p.name))
        : rbPlaylists;

      for (const pl of playlistsToProcess) {
        const existingCrate = crates.find(c => c.name === pl.name);
        if (!existingCrate && pl.trackIds.length > 0) {
          const validIds = pl.trackIds.filter(tid => tracksToImport.find(t => t.id === tid));
          if (validIds.length > 0) {
            const cr = {
              id: `cr_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
              name: pl.name,
              trackIds: validIds,
              createdAt: Date.now(),
            };
            setCrates(p => [...p, cr]);
            await dbPut(db, "crates", cr);
          }
        }
      }

      setScanProg({ found: added, analyzed: 0, total: tracksToImport.length });
    } catch(e) {
      console.error("Rekordbox import error", e);
      alert("Import error. Please try again.");
    }

    setScanning(false);
  };

  // ── iTunes XML: parse → show playlist picker ───────────────────
  const prepareItunesImport = async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      const { tracks: itTracks, playlists: itPlaylists } = parseiTunesXML(text);
      if (!itTracks.length) {
        alert("Library.xml found but no tracks inside.\n\nMake sure Apple Music has tracks and that you enabled:\nMusic → Settings → Advanced → Share iTunes Library XML.");
        return;
      }
      setShowItunesHelper(false);
      setItunesPicker({
        tracks: itTracks,
        playlists: itPlaylists,
        selectedPls: new Set(itPlaylists.map(p => p.name)),
        importMode: "all",
      });
    } catch(e) {
      console.error("iTunes parse error", e);
      alert("Error reading Library.xml. The file may be corrupted — try exporting it again from Apple Music.");
    }
  };

  // ── Perform the iTunes import after playlist selection ─────────
  const doItunesImport = async () => {
    if (!itunesPicker) return;
    const { tracks: itTracks, playlists: itPlaylists, selectedPls, importMode } = itunesPicker;
    setItunesPicker(null);
    setScanning(true);
    setScanProg({ found:0, analyzed:0, total:0 });
    try {
      let tracksToImport = itTracks;
      if (importMode === "playlists") {
        const selectedTrackIds = new Set(
          itPlaylists.filter(p => selectedPls.has(p.name)).flatMap(p => p.trackIds)
        );
        tracksToImport = itTracks.filter(t => selectedTrackIds.has(t.id));
      }

      const db = dbRef.current;
      const existing = new Set(tracks.map(t => t.id));
      const filenameMap = {};
      tracks.forEach(t => { filenameMap[t.filename] = t.id; });

      let added = 0;
      for (const t of tracksToImport) {
        if (existing.has(t.id)) continue;
        const matchId = filenameMap[t.filename];
        if (matchId) {
          setTracks(prev => prev.map(tr => tr.id === matchId ? {...tr, bpm:tr.bpm||t.bpm, key:tr.key||t.key, genre:tr.genre||t.genre, album:tr.album||t.album, playCount:t.playCount, itunesId:t.itunesId} : tr));
          const exTrack = tracks.find(tr => tr.id === matchId);
          if (exTrack) await dbPut(db, "tracks", {...exTrack, bpm:exTrack.bpm||t.bpm, key:exTrack.key||t.key, genre:exTrack.genre||t.genre, itunesId:t.itunesId, playCount:t.playCount});
          continue;
        }
        setTracks(prev => [t, ...prev]);
        await dbPut(db, "tracks", t);
        added++;
        setScanProg(p => ({ ...p, found: added }));
      }

      // Create crates from playlists
      const playlistsToProcess = importMode === "playlists"
        ? itPlaylists.filter(p => selectedPls.has(p.name))
        : itPlaylists;
      for (const pl of playlistsToProcess) {
        const existingCrate = crates.find(c => c.name === pl.name);
        if (!existingCrate && pl.trackIds.length > 0) {
          const validIds = pl.trackIds.filter(tid => tracksToImport.find(t => t.id === tid));
          if (validIds.length > 0) {
            const cr = { id:`cr_${Date.now()}_${Math.random().toString(36).slice(2,5)}`, name:pl.name, trackIds:validIds, createdAt:Date.now() };
            setCrates(p => [...p, cr]);
            await dbPut(db, "crates", cr);
          }
        }
      }
      setScanProg({ found: added, analyzed:0, total: tracksToImport.length });
    } catch(e) {
      console.error("iTunes import error", e);
      alert("Import error. Please try again.");
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

  // ── Session Queue operations ─────────────────────────────────
  const addToQueue = async (trackId) => {
    const db = dbRef.current; if (!db) return;
    await dbPut(db, "queue", { trackId, order: Date.now() });
    setQueueIds(prev => new Set([...prev, trackId]));
  };
  const removeFromQueue = async (trackId) => {
    const db = dbRef.current; if (!db) return;
    await dbDelete(db, "queue", trackId);
    setQueueIds(prev => { const n = new Set(prev); n.delete(trackId); return n; });
  };
  const toggleQueue = (trackId) => queueIds.has(trackId) ? removeFromQueue(trackId) : addToQueue(trackId);
  const clearQueue  = async () => {
    const db = dbRef.current; if (!db) return;
    await dbClear(db, "queue");
    setQueueIds(new Set());
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
    if (sourceFilter) ts = ts.filter(t => t.source === sourceFilter);
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
    if (keyFilter) ts = ts.filter(t => CAMELOT[t.key] === keyFilter || t.key === keyFilter);
    ts = ts.filter(t => {
      if (!t.bpm) return true;
      return t.bpm >= bpmRange[0] && t.bpm <= bpmRange[1];
    });
    return ts;
  }, [tracks, search, energyFilter, keyFilter, bpmRange, sourceFilter]);

  const analyzedCount = tracks.filter(t=>t.analyzed).length;
  const cloudCount    = tracks.filter(t=>t.cloudOnly).length;
  const analyzing = queueRef.current.length > 0 || activeRef.current;

  // ── sendToDeck — writes a "load this track to deck X" request to IDB ────────
  const sendToDeck = useCallback(async (track, deck) => {
    const db = dbRef.current;
    if (!db) return;
    await dbPut(db, "requests", { id: `deck_${deck}`, deck, trackId: track.id, ts: Date.now() });
  }, []);

  // ── NAV VIEWS (no crates — handled inline in sidebar) ────────
  const VIEWS = [
    ["tracks",  "♫ ALL TRACKS"],
    ["artists", "👤 ARTISTS"],
    ["energy",  "⚡ ENERGY"],
    ["genres",  "◎ GENRE"],
    ["labels",  "🏷 LABEL"],
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
        @keyframes scanPulse{0%,100%{width:20%;opacity:.6}50%{width:60%;opacity:1}}
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
            ref={searchRef}
            value={search} onChange={e=>setSearch(e.target.value)}
            onKeyDown={e=>{ if(e.key==="Escape"){ setSearch(""); e.currentTarget.blur(); } }}
            placeholder="Search titles, artists, genres… ( / )"
            style={{ width:"100%", background:C.raised, border:`1px solid ${search?G+66:C.border}`, color:C.text, borderRadius:8, padding:"9px 12px 9px 32px", fontSize:12, fontFamily:"'DM Sans',sans-serif", outline:"none", transition:"border-color .15s" }}
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

        {/* Clear filters */}
        {(search || energyFilter || keyFilter || bpmRange[0] > 60 || bpmRange[1] < 200) && (
          <button onClick={()=>{ setSearch(""); setEnergyFilter(null); setKeyFilter(null); setBpmRange([60,200]); }}
            style={{ padding:"4px 9px", fontSize:9, fontFamily:"'DM Mono',monospace", background:"transparent", border:`1px solid #ef444433`, color:"#ef4444aa", borderRadius:5, cursor:"pointer", whiteSpace:"nowrap", letterSpacing:.5 }}>
            ✕ CLEAR
          </button>
        )}

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
            {/* Re-sync button if we have a remembered handle */}
            {itunesDirHandle ? (
              <div style={{ display:"flex", gap:6 }}>
                <button onClick={()=>resyncItunes()}
                  style={{ padding:"9px 14px", background:"#22c55e15", border:"1px solid #22c55e55", color:"#22c55e", fontFamily:"'DM Mono',monospace", fontSize:10, letterSpacing:1.5, borderRadius:8, cursor:"pointer", whiteSpace:"nowrap" }}>
                  ↻ SYNC LIBRARY
                </button>
                <button onClick={()=>setShowItunesHelper(v=>!v)}
                  style={{ padding:"9px 10px", background:"#8B5CF615", border:`1px solid #8B5CF633`, color:"#8B5CF6", fontFamily:"'DM Mono',monospace", fontSize:10, borderRadius:8, cursor:"pointer" }}>
                  ▾
                </button>
              </div>
            ) : (
              <button onClick={()=>setShowItunesHelper(v=>!v)}
                style={{ padding:"9px 14px", background:"#8B5CF615", border:`1px solid ${showItunesHelper?"#8B5CF688":"#8B5CF655"}`, color:"#8B5CF6", fontFamily:"'DM Mono',monospace", fontSize:10, letterSpacing:1.5, borderRadius:8, cursor:"pointer", display:"flex", alignItems:"center", gap:6, transition:"all .2s", whiteSpace:"nowrap" }}>
                ♪ iTunes
              </button>
            )}
            {showItunesHelper && (
              <div data-itunes-helper style={{ position:"absolute", top:"calc(100% + 8px)", right:0, width:320, background:C.raised, border:`1px solid #8B5CF644`, borderRadius:12, padding:16, zIndex:200, boxShadow:"0 16px 48px rgba(0,0,0,.8)" }}>
                <div style={{ fontSize:12, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif", marginBottom:10 }}>Apple Music Import</div>

                {/* Primary action */}
                <button onClick={()=>{ setShowItunesHelper(false); autoImportItunes(); }}
                  style={{ width:"100%", padding:"11px", background:"#8B5CF622", border:"1px solid #8B5CF666", color:"#8B5CF6", fontFamily:"'DM Mono',monospace", fontSize:11, letterSpacing:1, borderRadius:8, cursor:"pointer", marginBottom:10, display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
                  ♪ Select Library.xml
                </button>
                <div style={{ fontSize:9, color:C.muted, fontFamily:"'DM Mono',monospace", marginBottom:12, lineHeight:1.7 }}>
                  Select your <span style={{color:G}}>Library.xml</span> file — Apple Music maintains it automatically.<br/>
                  First time? Enable in Apple Music: <span style={{color:"#8B5CF6"}}>Settings → Advanced → Share iTunes Library XML</span><br/>
                  File lives at: <span style={{color:G}}>~/Music/Music/Library.xml</span>
                </div>

                {/* Divider + fallback */}
                <div style={{ borderTop:`1px solid ${C.border}`, paddingTop:10, display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                  <span style={{ fontSize:9, color:C.muted, fontFamily:"'DM Mono',monospace" }}>Local files only?</span>
                  <button onClick={()=>{ setShowItunesHelper(false); itunesScan(); }}
                    style={{ padding:"4px 10px", background:"transparent", border:`1px solid ${C.border}`, color:C.muted, fontFamily:"'DM Mono',monospace", fontSize:9, letterSpacing:1, borderRadius:5, cursor:"pointer" }}>
                    ⊕ Scan folder
                  </button>
                </div>
                {itunesDirHandle && (
                  <button onClick={()=>{ setItunesDirHandle(null); if(dbRef.current) dbDelete(dbRef.current,"handles","itunes_dir"); setShowItunesHelper(false); }}
                    style={{ marginTop:8, width:"100%", padding:"5px", background:"transparent", border:"none", color:"#ef444455", fontFamily:"'DM Mono',monospace", fontSize:9, cursor:"pointer", textAlign:"center" }}>
                    ✕ Forget saved folder
                  </button>
                )}
              </div>
            )}
          </div>
          <button onClick={()=>scanFolder()} disabled={scanning}
            style={{ padding:"9px 16px", background:scanning?"transparent":`${G}22`, border:`1px solid ${G}55`, color:scanning?G:G, fontFamily:"'DM Mono',monospace", fontSize:10, letterSpacing:1.5, borderRadius:8, cursor:scanning?"not-allowed":"pointer", display:"flex", alignItems:"center", gap:8, transition:"all .2s" }}>
            {scanning
              ? <><span style={{ width:10, height:10, border:`1.5px solid ${G}44`, borderTop:`1.5px solid ${G}`, borderRadius:"50%", animation:"spin 1s linear infinite", display:"inline-block" }}/> {scanProg.found > 0 ? `${scanProg.found} found…` : "SCANNING…"}</>
              : <><span style={{ fontSize:14, lineHeight:1 }}>＋</span> ADD MUSIC</>
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
        <div style={{ flexShrink:0 }}>
          <div style={{ height:3, background:C.raised }}>
            <div style={{ height:"100%", background:`linear-gradient(90deg,${G}66,${G})`, width:`${scanProg.total>0?(scanProg.found/scanProg.total)*100:30}%`, transition:"width .3s", animation: scanProg.total===0?"scanPulse 1.2s ease-in-out infinite":undefined }}/>
          </div>
          {scanProg.found > 0 && (
            <div style={{ padding:"4px 20px", fontSize:9, fontFamily:"'DM Mono',monospace", color:G, opacity:.7, display:"flex", gap:16 }}>
              <span>📂 {scanProg.found} tracks found</span>
              {scanProg.analyzed > 0 && <span>⚡ {scanProg.analyzed} analyzed</span>}
            </div>
          )}
        </div>
      )}
      {!scanning && analyzedCount < tracks.length && tracks.length>0 && (
        <div style={{ height:2, background:C.raised, flexShrink:0 }}>
          <div style={{ height:"100%", background:`linear-gradient(90deg,#00d4ff44,#00d4ff)`, width:`${(analyzedCount/tracks.length)*100}%`, transition:"width .5s" }}/>
        </div>
      )}

      {/* ── iTunes PLAYLIST PICKER MODAL ── */}
      {itunesPicker && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.75)", zIndex:500, display:"flex", alignItems:"center", justifyContent:"center", padding:24 }}
          onClick={e=>{ if(e.target===e.currentTarget) setItunesPicker(null); }}>
          <div style={{ background:C.raised, border:"1px solid #8B5CF644", borderRadius:16, width:"100%", maxWidth:560, maxHeight:"80vh", display:"flex", flexDirection:"column", boxShadow:"0 24px 64px rgba(0,0,0,.8)" }}>

            {/* Modal header */}
            <div style={{ padding:"20px 24px 16px", borderBottom:`1px solid ${C.border}`, display:"flex", alignItems:"center", gap:12, flexShrink:0 }}>
              <span style={{ fontSize:22 }}>♪</span>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:17, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif" }}>Apple Music Library</div>
                <div style={{ fontSize:10, color:C.muted, fontFamily:"'DM Mono',monospace", marginTop:2 }}>
                  Found {itunesPicker.tracks.length} tracks · {itunesPicker.playlists.length} playlists
                </div>
              </div>
              <button onClick={()=>setItunesPicker(null)}
                style={{ background:"none", border:"none", color:C.muted, cursor:"pointer", fontSize:18, lineHeight:1, padding:"0 4px" }}>✕</button>
            </div>

            {/* Import mode selector */}
            <div style={{ padding:"16px 24px 12px", borderBottom:`1px solid ${C.border}`, flexShrink:0 }}>
              <div style={{ fontSize:11, fontFamily:"'DM Mono',monospace", color:C.muted, letterSpacing:1, marginBottom:10 }}>WHAT TO IMPORT</div>
              {[
                ["all", `All tracks (${itunesPicker.tracks.length} total)`, "Everything in your Apple Music library"],
                ["playlists", "Selected playlists only", "Choose which playlists to import — other tracks are skipped"],
              ].map(([mode, label, desc]) => (
                <label key={mode} style={{ display:"flex", gap:10, marginBottom:10, cursor:"pointer", alignItems:"flex-start" }}>
                  <input type="radio" checked={itunesPicker.importMode===mode}
                    onChange={() => setItunesPicker(p => ({...p, importMode:mode}))}
                    style={{ marginTop:3, accentColor:"#8B5CF6", flexShrink:0 }}/>
                  <div>
                    <div style={{ fontSize:13, color:C.text, fontFamily:"'DM Sans',sans-serif", fontWeight:500 }}>{label}</div>
                    <div style={{ fontSize:10, color:C.muted, fontFamily:"'DM Mono',monospace", marginTop:2 }}>{desc}</div>
                  </div>
                </label>
              ))}
            </div>

            {/* Playlist list */}
            {itunesPicker.importMode === "playlists" && (
              <div style={{ flex:1, overflowY:"auto", padding:"8px 24px" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 0", position:"sticky", top:0, background:C.raised }}>
                  <div style={{ fontSize:10, fontFamily:"'DM Mono',monospace", color:C.muted, letterSpacing:1 }}>
                    PLAYLISTS ({itunesPicker.selectedPls.size}/{itunesPicker.playlists.length} selected)
                  </div>
                  <div style={{ display:"flex", gap:8 }}>
                    <button onClick={()=>setItunesPicker(p=>({...p,selectedPls:new Set(p.playlists.map(pl=>pl.name))}))}
                      style={{ fontSize:9, fontFamily:"'DM Mono',monospace", background:"transparent", border:`1px solid ${C.border}`, color:C.muted, borderRadius:4, padding:"2px 8px", cursor:"pointer" }}>ALL</button>
                    <button onClick={()=>setItunesPicker(p=>({...p,selectedPls:new Set()}))}
                      style={{ fontSize:9, fontFamily:"'DM Mono',monospace", background:"transparent", border:`1px solid ${C.border}`, color:C.muted, borderRadius:4, padding:"2px 8px", cursor:"pointer" }}>NONE</button>
                  </div>
                </div>
                {itunesPicker.playlists.length === 0 && (
                  <div style={{ padding:"20px 0", textAlign:"center", fontSize:11, color:C.muted, fontFamily:"'DM Mono',monospace" }}>
                    No regular playlists found in this library
                  </div>
                )}
                {itunesPicker.playlists.map(pl => {
                  const checked = itunesPicker.selectedPls.has(pl.name);
                  return (
                    <label key={pl.name} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 0", cursor:"pointer", borderBottom:`1px solid ${C.border}44` }}>
                      <input type="checkbox" checked={checked}
                        onChange={() => setItunesPicker(p => {
                          const s = new Set(p.selectedPls);
                          checked ? s.delete(pl.name) : s.add(pl.name);
                          return {...p, selectedPls:s};
                        })}
                        style={{ accentColor:"#8B5CF6", flexShrink:0 }}/>
                      <span style={{ flex:1, fontSize:13, color:checked?C.text:C.muted, fontFamily:"'DM Sans',sans-serif", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{pl.name}</span>
                      <span style={{ fontSize:10, color:C.muted, fontFamily:"'DM Mono',monospace", flexShrink:0 }}>{pl.trackIds.length}</span>
                    </label>
                  );
                })}
              </div>
            )}

            {/* Footer */}
            <div style={{ padding:"16px 24px", borderTop:`1px solid ${C.border}`, display:"flex", gap:12, alignItems:"center", flexShrink:0 }}>
              <div style={{ flex:1, fontSize:10, color:C.muted, fontFamily:"'DM Mono',monospace" }}>
                {itunesPicker.importMode === "playlists"
                  ? `${itunesPicker.playlists.filter(p=>itunesPicker.selectedPls.has(p.name)).reduce((s,p)=>s+p.trackIds.length,0)} tracks from selected playlists · each playlist becomes a crate`
                  : `${itunesPicker.tracks.length} tracks + ${itunesPicker.playlists.length} playlists imported as crates`
                }
              </div>
              <button onClick={()=>setItunesPicker(null)}
                style={{ padding:"9px 16px", background:"transparent", border:`1px solid ${C.border}`, color:C.muted, fontFamily:"'DM Mono',monospace", fontSize:10, borderRadius:8, cursor:"pointer" }}>
                Cancel
              </button>
              <button onClick={doItunesImport}
                disabled={itunesPicker.importMode==="playlists" && itunesPicker.selectedPls.size===0}
                style={{ padding:"9px 20px", background:`linear-gradient(135deg,#8B5CF622,#8B5CF611)`, border:`1px solid #8B5CF688`, color:"#8B5CF6", fontFamily:"'DM Mono',monospace", fontSize:11, letterSpacing:1, borderRadius:8, cursor:"pointer", fontWeight:500 }}>
                IMPORT →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── REKORDBOX PICKER MODAL ── */}
      {rbPicker && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.75)", zIndex:500, display:"flex", alignItems:"center", justifyContent:"center", padding:24 }}
          onClick={e=>{ if(e.target===e.currentTarget) setRbPicker(null); }}>
          <div style={{ background:C.raised, border:`1px solid ${G}33`, borderRadius:16, width:"100%", maxWidth:560, maxHeight:"80vh", display:"flex", flexDirection:"column", boxShadow:"0 24px 64px rgba(0,0,0,.8)" }}>

            {/* Header */}
            <div style={{ padding:"20px 24px 16px", borderBottom:`1px solid ${C.border}`, display:"flex", alignItems:"center", gap:12, flexShrink:0 }}>
              <span style={{ fontSize:22 }}>🎛️</span>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:17, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif" }}>Rekordbox Library</div>
                <div style={{ fontSize:10, color:C.muted, fontFamily:"'DM Mono',monospace", marginTop:2 }}>
                  {rbPicker.tracks.length} tracks · {rbPicker.playlists.length} playlists · BPM & key pre-analyzed ⚡
                </div>
              </div>
              <button onClick={()=>setRbPicker(null)}
                style={{ background:"none", border:"none", color:C.muted, cursor:"pointer", fontSize:18, lineHeight:1, padding:"0 4px" }}>✕</button>
            </div>

            {/* Import mode */}
            <div style={{ padding:"16px 24px 12px", borderBottom:`1px solid ${C.border}`, flexShrink:0 }}>
              <div style={{ fontSize:11, fontFamily:"'DM Mono',monospace", color:C.muted, letterSpacing:1, marginBottom:10 }}>WHAT TO IMPORT</div>
              {[
                ["all",       `All tracks (${rbPicker.tracks.length} total)`,    "Everything in your Rekordbox collection"],
                ["playlists", "Selected playlists only",                           "Choose which playlists — other tracks are skipped"],
              ].map(([mode, label, desc]) => (
                <label key={mode} style={{ display:"flex", gap:10, marginBottom:10, cursor:"pointer", alignItems:"flex-start" }}>
                  <input type="radio" checked={rbPicker.importMode===mode}
                    onChange={() => setRbPicker(p => ({...p, importMode:mode}))}
                    style={{ marginTop:3, accentColor:G, flexShrink:0 }}/>
                  <div>
                    <div style={{ fontSize:13, color:C.text, fontFamily:"'DM Sans',sans-serif", fontWeight:500 }}>{label}</div>
                    <div style={{ fontSize:10, color:C.muted, fontFamily:"'DM Mono',monospace", marginTop:2 }}>{desc}</div>
                  </div>
                </label>
              ))}
            </div>

            {/* Playlist list */}
            {rbPicker.importMode === "playlists" && (
              <div style={{ flex:1, overflowY:"auto", padding:"8px 24px" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 0", position:"sticky", top:0, background:C.raised }}>
                  <div style={{ fontSize:10, fontFamily:"'DM Mono',monospace", color:C.muted, letterSpacing:1 }}>
                    PLAYLISTS ({rbPicker.selectedPls.size}/{rbPicker.playlists.length} selected)
                  </div>
                  <div style={{ display:"flex", gap:8 }}>
                    <button onClick={()=>setRbPicker(p=>({...p,selectedPls:new Set(p.playlists.map(pl=>pl.name))}))}
                      style={{ fontSize:9, fontFamily:"'DM Mono',monospace", background:"transparent", border:`1px solid ${C.border}`, color:C.muted, borderRadius:4, padding:"2px 8px", cursor:"pointer" }}>ALL</button>
                    <button onClick={()=>setRbPicker(p=>({...p,selectedPls:new Set()}))}
                      style={{ fontSize:9, fontFamily:"'DM Mono',monospace", background:"transparent", border:`1px solid ${C.border}`, color:C.muted, borderRadius:4, padding:"2px 8px", cursor:"pointer" }}>NONE</button>
                  </div>
                </div>
                {rbPicker.playlists.length === 0 && (
                  <div style={{ padding:"20px 0", textAlign:"center", fontSize:11, color:C.muted, fontFamily:"'DM Mono',monospace" }}>
                    No playlists found in this collection
                  </div>
                )}
                {rbPicker.playlists.map(pl => {
                  const checked = rbPicker.selectedPls.has(pl.name);
                  return (
                    <label key={pl.name} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 0", cursor:"pointer", borderBottom:`1px solid ${C.border}44` }}>
                      <input type="checkbox" checked={checked}
                        onChange={() => setRbPicker(p => {
                          const s = new Set(p.selectedPls);
                          checked ? s.delete(pl.name) : s.add(pl.name);
                          return {...p, selectedPls:s};
                        })}
                        style={{ accentColor:G, flexShrink:0 }}/>
                      <span style={{ flex:1, fontSize:13, color:checked?C.text:C.muted, fontFamily:"'DM Sans',sans-serif", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{pl.name}</span>
                      <span style={{ fontSize:10, color:C.muted, fontFamily:"'DM Mono',monospace", flexShrink:0 }}>{pl.trackIds.length}</span>
                    </label>
                  );
                })}
              </div>
            )}

            {/* Footer */}
            <div style={{ padding:"16px 24px", borderTop:`1px solid ${C.border}`, display:"flex", gap:12, alignItems:"center", flexShrink:0 }}>
              <div style={{ flex:1, fontSize:10, color:C.muted, fontFamily:"'DM Mono',monospace" }}>
                {rbPicker.importMode === "playlists"
                  ? `${rbPicker.playlists.filter(p=>rbPicker.selectedPls.has(p.name)).reduce((s,p)=>s+p.trackIds.length,0)} tracks from selected playlists · each playlist becomes a crate`
                  : `${rbPicker.tracks.length} tracks + ${rbPicker.playlists.length} playlists → DJ crates`
                }
              </div>
              <button onClick={()=>setRbPicker(null)}
                style={{ padding:"9px 16px", background:"transparent", border:`1px solid ${C.border}`, color:C.muted, fontFamily:"'DM Mono',monospace", fontSize:10, borderRadius:8, cursor:"pointer" }}>
                Cancel
              </button>
              <button onClick={doRekordboxImport}
                disabled={rbPicker.importMode==="playlists" && rbPicker.selectedPls.size===0}
                style={{ padding:"9px 20px", background:`linear-gradient(135deg,${G}22,${G}11)`, border:`1px solid ${G}88`, color:G, fontFamily:"'DM Mono',monospace", fontSize:11, letterSpacing:1, borderRadius:8, cursor:"pointer", fontWeight:500 }}>
                IMPORT →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── BODY ── */}
      <div style={{ flex:1, display:"flex", overflow:"hidden" }}>

        {/* ── LEFT NAV ── */}
        <div style={{ width:200, flexShrink:0, background:C.surface, borderRight:`1px solid ${C.border}`, display:"flex", flexDirection:"column", padding:"12px 0" }}>

          {/* ── SOURCES section ── */}
          <div style={{ padding:"0 12px 8px" }}>
            <div style={{ fontSize:9, fontFamily:"'DM Mono',monospace", color:C.muted, letterSpacing:1.5, marginBottom:6, paddingLeft:4, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span>SOURCES</span>
              {sourceFilter && <button onClick={()=>setSourceFilter(null)} style={{ background:"none", border:"none", color:C.muted, cursor:"pointer", fontSize:9, fontFamily:"'DM Mono',monospace", padding:0 }}>× all</button>}
            </div>
            {(() => {
              const itunesCount = tracks.filter(t=>t.source==="itunes").length;
              const rbCount = tracks.filter(t=>t.source==="rekordbox").length;
              return (
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                {[
                  { src:"itunes",    icon:"🎵", label:"Apple Music", count:itunesCount,  color:"#8B5CF6",
                    onImport:()=>autoImportItunes(),   onSync:()=>resyncItunes(),    synced:!!itunesDirHandle },
                  { src:"rekordbox", icon:"🎛️", label:"Rekordbox",   count:rbCount,      color:G,
                    onImport:()=>importRekordbox(),    onSync:()=>resyncRekordbox(), synced:!!(rbDirHandle||rbFileHandle) },
                ].map(({ src, icon, label, count, color, onImport, onSync, synced }) => {
                  const active = sourceFilter === src;
                  return (
                    <div key={src} style={{ display:"flex", gap:2 }}>
                      {/* Filter button (left) */}
                      <button
                        onClick={()=>{ setSourceFilter(active ? null : src); setActiveCrateId(null); setView("tracks"); }}
                        style={{ flex:1, padding:"7px 8px", textAlign:"left", background:active?`${color}14`:"transparent", border:`1px solid ${active?color+"55":C.border}`, color:active?color:C.subtle, fontFamily:"'DM Sans',sans-serif", fontSize:11, borderRadius:7, cursor:"pointer", display:"flex", alignItems:"center", gap:6, transition:"all .15s" }}
                        onMouseEnter={e=>{ if(!active){e.currentTarget.style.borderColor=color+"44";e.currentTarget.style.color=color;} }}
                        onMouseLeave={e=>{ if(!active){e.currentTarget.style.borderColor=C.border;e.currentTarget.style.color=C.subtle;} }}
                      >
                        <span style={{ fontSize:12 }}>{icon}</span>
                        <span style={{ flex:1 }}>{label}</span>
                        {count > 0 && <span style={{ fontSize:9, fontFamily:"'DM Mono',monospace", color:active?color:C.muted }}>{count}</span>}
                        {synced && count === 0 && <span style={{ fontSize:7, color:color, fontFamily:"'DM Mono',monospace", opacity:.7 }}>●</span>}
                      </button>
                      {/* Sync button if connected, Import (+) if not */}
                      <button
                        onClick={synced ? onSync : onImport}
                        title={synced ? `Re-sync ${label}` : `Connect ${label}`}
                        style={{ padding:"7px 8px", background:"transparent", border:`1px solid ${C.border}`, color:C.muted, fontSize:synced?10:12, fontFamily:"'DM Mono',monospace", borderRadius:7, cursor:"pointer", flexShrink:0, lineHeight:1, transition:"all .15s" }}
                        onMouseEnter={e=>{ e.currentTarget.style.borderColor=color+"55"; e.currentTarget.style.color=color; }}
                        onMouseLeave={e=>{ e.currentTarget.style.borderColor=C.border; e.currentTarget.style.color=C.muted; }}
                      >{synced ? "↻" : "+"}</button>
                    </div>
                  );
                })}
                {/* Tidal — coming soon */}
                <button disabled style={{ padding:"7px 10px", textAlign:"left", background:"transparent", border:`1px solid ${C.border}44`, color:`${C.muted}66`, fontFamily:"'DM Sans',sans-serif", fontSize:11, borderRadius:7, cursor:"default", display:"flex", alignItems:"center", gap:6, opacity:.5 }}>
                  <span style={{ fontSize:12 }}>🌊</span>
                  <span style={{ flex:1 }}>Tidal</span>
                  <span style={{ fontSize:7, fontFamily:"'DM Mono',monospace", background:C.raised, color:C.muted, padding:"1px 4px", borderRadius:3, border:`1px solid ${C.border}`, letterSpacing:.5 }}>SOON</span>
                </button>
              </div>
            );})()}
          </div>

          <div style={{ height:1, background:C.border, margin:"4px 0 8px" }}/>

          {VIEWS.map(([id,label]) => (
            <button key={id} onClick={()=>selectView(id)}
              style={{ padding:"11px 18px", textAlign:"left", background:"transparent", border:"none", borderLeft:`3px solid ${view===id&&!activeCrateId?G:"transparent"}`, color:view===id&&!activeCrateId?G:C.subtle, fontFamily:"'DM Sans',sans-serif", fontSize:13, fontWeight:view===id&&!activeCrateId?500:400, cursor:"pointer", letterSpacing:.3, transition:"all .15s" }}
              onMouseEnter={e=>{ if(!(view===id&&!activeCrateId)) e.currentTarget.style.color=C.text; }}
              onMouseLeave={e=>{ if(!(view===id&&!activeCrateId)) e.currentTarget.style.color=C.subtle; }}
            >{label}</button>
          ))}

          {/* ── SESSION QUEUE ── */}
          <div style={{ marginTop:2 }}>
            <button
              onClick={()=>selectView("queue")}
              style={{ width:"100%", padding:"11px 18px", textAlign:"left", background:"transparent", border:"none", borderLeft:`3px solid ${view==="queue"&&!activeCrateId?"#22c55e":"transparent"}`, color:view==="queue"&&!activeCrateId?"#22c55e":C.subtle, fontFamily:"'DM Sans',sans-serif", fontSize:13, fontWeight:view==="queue"&&!activeCrateId?500:400, cursor:"pointer", letterSpacing:.3, transition:"all .15s", display:"flex", alignItems:"center", justifyContent:"space-between" }}
              onMouseEnter={e=>{ if(!(view==="queue"&&!activeCrateId)) e.currentTarget.style.color=C.text; }}
              onMouseLeave={e=>{ if(!(view==="queue"&&!activeCrateId)) e.currentTarget.style.color=C.subtle; }}
            >
              <span>◉ SESSION QUEUE</span>
              {queueIds.size > 0 && <span style={{ fontSize:9, fontFamily:"'DM Mono',monospace", background:"#22c55e22", color:"#22c55e", padding:"1px 6px", borderRadius:10, border:"1px solid #22c55e44" }}>{queueIds.size}</span>}
            </button>
          </div>

          {/* ── ADD MUSIC button ── */}
          <div style={{ padding:"10px 12px 4px", borderTop:`1px solid ${C.border}` }}>
            <button onClick={()=>scanFolder()} disabled={scanning}
              style={{ width:"100%", padding:"9px 12px", background:scanning?`${G}08`:`${G}12`, border:`1px solid ${G}${scanning?"22":"44"}`, color:scanning?C.muted:G, fontFamily:"'DM Mono',monospace", fontSize:10, letterSpacing:1.5, borderRadius:8, cursor:scanning?"not-allowed":"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:7, transition:"all .2s" }}>
              {scanning
                ? <><span style={{ width:8, height:8, border:`1.5px solid ${G}44`, borderTop:`1.5px solid ${G}`, borderRadius:"50%", animation:"spin 1s linear infinite", display:"inline-block" }}/> SCANNING...</>
                : <><span style={{ fontSize:14 }}>＋</span> ADD MUSIC</>
              }
            </button>
          </div>

          {/* ── DJ CRATES section ── */}
          <div style={{ marginTop:6, borderTop:`1px solid ${C.border}` }}>
            {/* Header row */}
            <div style={{ display:"flex", alignItems:"center", padding:"10px 14px 6px", cursor:"pointer", userSelect:"none" }}>
              <div onClick={()=>setCratesExpanded(v=>!v)} style={{ display:"flex", alignItems:"center", gap:6, flex:1 }}>
                <span style={{ fontSize:12, color:G, fontFamily:"'DM Mono',monospace", letterSpacing:.5 }}>◈ DJ CRATES</span>
                <span style={{ fontSize:10, color:C.muted }}>{cratesExpanded?"▾":"▸"}</span>
              </div>
              <button
                onClick={e=>{ e.stopPropagation(); setShowNewCrateInput(v=>!v); setCratesExpanded(true); }}
                title="New crate"
                style={{ background:"transparent", border:`1px solid ${G}33`, color:G, borderRadius:4, padding:"1px 7px", fontSize:13, lineHeight:1, cursor:"pointer", flexShrink:0 }}
              >+</button>
            </div>

            {cratesExpanded && (
              <div>
                {/* New crate inline input */}
                {showNewCrateInput && (
                  <div style={{ padding:"4px 12px 8px" }}>
                    <input
                      autoFocus
                      value={newCrateName}
                      onChange={e=>setNewCrateName(e.target.value)}
                      onKeyDown={e=>{
                        if(e.key==="Enter" && newCrateName.trim()){
                          createCrate(newCrateName.trim());
                          setNewCrateName("");
                          setShowNewCrateInput(false);
                        }
                        if(e.key==="Escape"){ setShowNewCrateInput(false); setNewCrateName(""); }
                      }}
                      onBlur={()=>{ if(!newCrateName.trim()){ setShowNewCrateInput(false); } }}
                      placeholder="Crate name…"
                      maxLength={30}
                      style={{ width:"100%", background:C.raised, border:`1px solid ${G}44`, color:C.text, borderRadius:6, padding:"6px 9px", fontSize:11, fontFamily:"'DM Sans',sans-serif", outline:"none" }}
                    />
                    <div style={{ fontSize:9, color:C.muted, fontFamily:"'DM Mono',monospace", marginTop:3 }}>↵ enter to save · esc to cancel</div>
                  </div>
                )}

                {/* Crate list */}
                {crates.map(cr => {
                  const isActive = activeCrateId === cr.id;
                  return (
                    <div key={cr.id}
                      onClick={()=>selectCrate(cr.id)}
                      style={{ padding:"8px 12px 8px 20px", display:"flex", alignItems:"center", gap:6, cursor:"pointer", background:isActive?`${G}0d`:"transparent", borderLeft:`3px solid ${isActive?G:"transparent"}`, transition:"all .12s" }}
                      onMouseEnter={e=>e.currentTarget.style.background=isActive?`${G}0d`:C.raised}
                      onMouseLeave={e=>e.currentTarget.style.background=isActive?`${G}0d`:"transparent"}
                    >
                      <span style={{ fontSize:10, color:isActive?G:C.muted, flexShrink:0 }}>◈</span>
                      <span style={{ flex:1, fontSize:12, color:isActive?G:C.text, fontFamily:"'DM Sans',sans-serif", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{cr.name}</span>
                      <span style={{ fontSize:9, color:C.muted, fontFamily:"'DM Mono',monospace", flexShrink:0, marginRight:2 }}>{(cr.trackIds||[]).length}</span>
                      <button
                        onClick={e=>{ e.stopPropagation(); deleteCrate(cr.id); if(activeCrateId===cr.id){setActiveCrateId(null);setView("tracks");} }}
                        style={{ background:"none", border:"none", color:C.muted, cursor:"pointer", fontSize:11, opacity:.4, padding:0, lineHeight:1, flexShrink:0 }}
                        onMouseEnter={e=>e.currentTarget.style.opacity=1}
                        onMouseLeave={e=>e.currentTarget.style.opacity=.4}
                      >✕</button>
                    </div>
                  );
                })}
                {crates.length===0 && !showNewCrateInput && (
                  <div style={{ padding:"6px 20px 10px", fontSize:10, color:C.muted, fontFamily:"'DM Mono',monospace", lineHeight:1.8, opacity:.7 }}>
                    No crates yet.<br/>Click <span style={{color:G}}>+</span> to create one.
                  </div>
                )}
              </div>
            )}
          </div>

          <div style={{ flex:1 }}/>

          {/* ── SESSION panel (Beatport-inspired) ── */}
          <div style={{ borderTop:`1px solid ${C.border}`, padding:"10px 12px 8px" }}>
            <div style={{ fontSize:9, fontFamily:"'DM Mono',monospace", color:C.muted, letterSpacing:1.5, marginBottom:8, paddingLeft:2 }}>SESSION</div>
            {/* Active DJ (you) */}
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
              <div style={{ width:28, height:28, borderRadius:"50%", background:`linear-gradient(135deg,${G},${G}88)`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:700, color:"#000", flexShrink:0 }}>C</div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:11, color:C.text, fontFamily:"'DM Sans',sans-serif", fontWeight:500 }}>You (Host)</div>
                <div style={{ fontSize:9, color:"#22c55e", fontFamily:"'DM Mono',monospace", display:"flex", alignItems:"center", gap:3 }}>
                  <span style={{ width:5, height:5, borderRadius:"50%", background:"#22c55e", display:"inline-block" }}/>
                  Live
                </div>
              </div>
              <div style={{ fontSize:9, fontFamily:"'DM Mono',monospace", color:C.muted }}>{tracks.length} tracks</div>
            </div>
            {/* B2B invite */}
            <button
              title="B2B collaboration coming soon"
              style={{ width:"100%", padding:"7px 10px", background:"transparent", border:`1px dashed ${C.border}`, color:C.muted, fontFamily:"'DM Mono',monospace", fontSize:9, letterSpacing:1, borderRadius:7, cursor:"default", display:"flex", alignItems:"center", justifyContent:"center", gap:6, opacity:.6 }}>
              <span style={{ fontSize:11 }}>＋</span> INVITE DJ
              <span style={{ fontSize:7, background:C.raised, border:`1px solid ${C.border}`, color:C.muted, padding:"1px 4px", borderRadius:3 }}>SOON</span>
            </button>
          </div>

          {/* Stats block */}
          <div style={{ padding:"16px 18px", borderTop:`1px solid ${C.border}` }}>
            {[
              ["Tracks",    tracks.length],
              ["☁ Cloud",   cloudCount],
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

          {/* ── EMPTY STATE / ONBOARDING ── */}
          {tracks.length === 0 && !scanning && (
            <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:40 }}>
              {/* Card */}
              <div style={{ width:"100%", maxWidth:560, background:C.surface, border:`1px solid ${C.border}`, borderRadius:20, padding:"48px 40px", display:"flex", flexDirection:"column", alignItems:"center", gap:28, boxShadow:`0 32px 80px rgba(0,0,0,.5), 0 0 0 1px ${G}08` }}>

                {/* Icon */}
                <div style={{ width:72, height:72, borderRadius:20, background:`${G}10`, border:`1px solid ${G}25`, display:"flex", alignItems:"center", justifyContent:"center" }}>
                  <span style={{ fontSize:34 }}>🎵</span>
                </div>

                {/* Headline */}
                <div style={{ textAlign:"center" }}>
                  <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:30, fontWeight:700, color:C.text, marginBottom:8, lineHeight:1.2 }}>Find your music</div>
                  <div style={{ fontSize:13, color:C.subtle, lineHeight:1.8, maxWidth:380 }}>
                    Point it at any folder — your Downloads, Music library, a USB drive, or an external hard drive. Tracks appear instantly, BPM and key detected automatically.
                  </div>
                </div>

                {/* Primary CTA */}
                <button onClick={()=>scanFolder()}
                  style={{ width:"100%", padding:"16px 24px", background:`linear-gradient(135deg,${G}28,${G}14)`, border:`1px solid ${G}66`, color:G, fontFamily:"'DM Mono',monospace", fontSize:13, letterSpacing:2, borderRadius:12, cursor:"pointer", boxShadow:`0 0 40px ${G}18`, transition:"all .2s", display:"flex", alignItems:"center", justifyContent:"center", gap:10 }}>
                  <span style={{ fontSize:16 }}>📂</span> FIND MY MUSIC
                </button>

                {/* Feature pills */}
                <div style={{ display:"flex", gap:8, flexWrap:"wrap", justifyContent:"center" }}>
                  {[["⚡","BPM & key detected"],["🎚️","Energy classified"],["◈","Crates & playlists"],["🔒","Files stay on your computer"]].map(([ic,t])=>(
                    <div key={t} style={{ display:"flex", alignItems:"center", gap:5, padding:"5px 11px", background:C.raised, border:`1px solid ${C.border}`, borderRadius:20 }}>
                      <span style={{ fontSize:11 }}>{ic}</span>
                      <span style={{ fontSize:10, color:C.subtle, fontFamily:"'DM Mono',monospace" }}>{t}</span>
                    </div>
                  ))}
                </div>

                {/* Divider */}
                <div style={{ width:"100%", display:"flex", alignItems:"center", gap:12 }}>
                  <div style={{ flex:1, height:1, background:C.border }}/>
                  <span style={{ fontSize:10, color:C.muted, fontFamily:"'DM Mono',monospace" }}>OR</span>
                  <div style={{ flex:1, height:1, background:C.border }}/>
                </div>

                {/* Secondary: Apple Music */}
                <div style={{ width:"100%", display:"flex", flexDirection:"column", gap:8 }}>
                  <button onClick={()=>{ autoImportItunes(); }}
                    style={{ width:"100%", padding:"12px 20px", background:"#8B5CF610", border:`1px solid #8B5CF640`, color:"#8B5CF6", fontFamily:"'DM Mono',monospace", fontSize:11, letterSpacing:1.5, borderRadius:10, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:8, transition:"all .2s" }}>
                    🎵 IMPORT FROM APPLE MUSIC
                  </button>
                  <div style={{ fontSize:9, color:C.muted, fontFamily:"'DM Mono',monospace", textAlign:"center", lineHeight:1.7 }}>
                    Pulls playlists, BPM & genre tags from your Apple Music library
                  </div>
                </div>

              </div>

              <div style={{ marginTop:16, fontSize:10, color:C.muted, fontFamily:"'DM Mono',monospace", letterSpacing:1 }}>
                Works in Chrome or Edge
              </div>
            </div>
          )}

          {/* ── SOURCE EMPTY STATE — when a source filter is active but has no tracks for that source ── */}
          {sourceFilter && filteredTracks.length === 0 && !scanning && (() => {
            const isItunes = sourceFilter === "itunes";
            const isRb = sourceFilter === "rekordbox";
            const color = isItunes ? "#8B5CF6" : G;
            const icon = isItunes ? "🎵" : "🎛️";
            const label = isItunes ? "Apple Music" : "Rekordbox";
            const onConnect = isItunes ? ()=>autoImportItunes() : ()=>importRekordbox();
            const hint = isItunes
              ? <><strong style={{color:C.text}}>One-time setup:</strong> Open Apple Music → Settings → Advanced<br/>→ turn on <span style={{color}}>"Share iTunes Library XML"</span><br/><br/>Then click Connect below → navigate to <span style={{color:G}}>Music → Music</span> folder<br/>→ select <span style={{color:G}}>Library.xml</span> — Apple keeps it updated automatically</>
              : <><strong style={{color:C.text}}>No export needed.</strong> We read your Rekordbox database directly.<br/><br/>Click Connect below → a folder picker opens in your Music folder<br/>→ double-click <span style={{color}}>PioneerDJ</span> → click <span style={{color}}>Select</span><br/>All BPM, key &amp; playlists load automatically ⚡<br/><br/><span style={{color:C.muted,fontSize:9}}>Don't see PioneerDJ? Press ⌘⇧G and paste:<br/>~/Library/Application Support/Pioneer/rekordbox6</span></>;
            return (
              <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:40 }}>
                <div style={{ width:"100%", maxWidth:480, background:C.surface, border:`1px solid ${color}22`, borderRadius:20, padding:"44px 40px", display:"flex", flexDirection:"column", alignItems:"center", gap:24, boxShadow:`0 24px 64px rgba(0,0,0,.5)` }}>
                  <div style={{ width:64, height:64, borderRadius:18, background:`${color}14`, border:`1px solid ${color}33`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:30 }}>{icon}</div>
                  <div style={{ textAlign:"center" }}>
                    <div style={{ fontSize:22, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif", marginBottom:8 }}>{label} not connected</div>
                    <div style={{ fontSize:11, color:C.muted, fontFamily:"'DM Mono',monospace", lineHeight:1.9 }}>{hint}</div>
                  </div>
                  <button onClick={onConnect}
                    style={{ width:"100%", padding:"14px 24px", background:`${color}18`, border:`1px solid ${color}66`, color, fontFamily:"'DM Mono',monospace", fontSize:12, letterSpacing:1.5, borderRadius:10, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:10, transition:"all .2s" }}
                    onMouseEnter={e=>{ e.currentTarget.style.background=`${color}28`; }}
                    onMouseLeave={e=>{ e.currentTarget.style.background=`${color}18`; }}>
                    {icon} CONNECT {label.toUpperCase()}
                  </button>
                  <div style={{ fontSize:9, color:C.muted, fontFamily:"'DM Mono',monospace", textAlign:"center", opacity:.7 }}>
                    {isItunes ? "Picker opens in ~/Music → go into Music folder → select Library.xml" : "Picker opens in ~/Music → double-click PioneerDJ → click Select"}
                  </div>
                  <button onClick={()=>setSourceFilter(null)} style={{ fontSize:9, fontFamily:"'DM Mono',monospace", background:"transparent", border:"none", color:C.muted, cursor:"pointer", letterSpacing:1 }}>← back to all tracks</button>
                </div>
              </div>
            );
          })()}

          {/* Views */}
          {tracks.length > 0 && !(sourceFilter && filteredTracks.length === 0 && !scanning) && (
            <div style={{ flex:1, overflow:"hidden", display:"flex", flexDirection:"column" }}>
              {view==="tracks"  && <TrackListView  tracks={filteredTracks} crates={crates} onAddToCrate={addToCrate} onSelect={t=>setSelected(t.id)} selected={selected} onPlay={null} onSendToDeck={sendToDeck} queueIds={queueIds} onToggleQueue={toggleQueue}/>}
              {view==="artists" && <ArtistView     tracks={filteredTracks} crates={crates} onAddToCrate={addToCrate} onSelect={t=>setSelected(t.id)} selected={selected} onPlay={null} onSendToDeck={sendToDeck} queueIds={queueIds} onToggleQueue={toggleQueue}/>}
              {view==="energy"  && <EnergyView     tracks={filteredTracks} crates={crates} onAddToCrate={addToCrate} onSelect={t=>setSelected(t.id)} selected={selected} onPlay={null} onSendToDeck={sendToDeck} queueIds={queueIds} onToggleQueue={toggleQueue}/>}
              {view==="genres"  && <GenreView      tracks={filteredTracks} crates={crates} onAddToCrate={addToCrate} onSelect={t=>setSelected(t.id)} selected={selected} onPlay={null} onSendToDeck={sendToDeck} queueIds={queueIds} onToggleQueue={toggleQueue}/>}
              {view==="labels"  && <LabelView      tracks={filteredTracks} crates={crates} onAddToCrate={addToCrate} onSelect={t=>setSelected(t.id)} selected={selected} onPlay={null} onSendToDeck={sendToDeck} queueIds={queueIds} onToggleQueue={toggleQueue}/>}
              {view==="queue" && (() => {
                const queuedTracks = [...queueIds].map(id => tracks.find(t=>t.id===id)).filter(Boolean);
                const totalSec = queuedTracks.reduce((s, t) => s + (t.duration || 0), 0);
                const totalMin = Math.floor(totalSec / 60);
                const bpms = queuedTracks.map(t=>t.bpm).filter(Boolean);
                const bpmRange2 = bpms.length ? `${Math.round(Math.min(...bpms))}–${Math.round(Math.max(...bpms))} BPM` : null;
                return (
                  <div style={{ flex:1, overflow:"hidden", display:"flex", flexDirection:"column" }}>
                    <div style={{ padding:"12px 16px", borderBottom:`1px solid ${C.border}`, background:C.surface, flexShrink:0, display:"flex", alignItems:"center", gap:12 }}>
                      <span style={{ fontSize:20, color:"#22c55e" }}>◉</span>
                      <div style={{ flex:1 }}>
                        <div style={{ fontSize:18, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif" }}>Session Queue</div>
                        <div style={{ fontSize:10, color:C.muted, fontFamily:"'DM Mono',monospace", marginTop:2, display:"flex", gap:12 }}>
                          <span>{queuedTracks.length} tracks</span>
                          {totalMin > 0 && <span>{totalMin} min</span>}
                          {bpmRange2 && <span style={{color:G}}>{bpmRange2}</span>}
                          {queuedTracks.length === 0 && <span>hover any track and click <span style={{color:"#22c55e"}}>+ QUEUE</span> to add</span>}
                        </div>
                      </div>
                      {queueIds.size > 0 && (
                        <button onClick={clearQueue} style={{ fontSize:9, fontFamily:"'DM Mono',monospace", padding:"4px 10px", background:"transparent", border:"1px solid #ef444433", color:"#ef444466", borderRadius:5, cursor:"pointer" }}>
                          ✕ CLEAR QUEUE
                        </button>
                      )}
                    </div>
                    <div style={{ flex:1, overflowY:"auto" }}>
                      {queuedTracks.length === 0 ? (
                        <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100%", gap:12, color:C.muted, fontFamily:"'DM Mono',monospace", fontSize:11 }}>
                          <div style={{ fontSize:40, opacity:.1 }}>◉</div>
                          <div style={{ textAlign:"center", lineHeight:1.8 }}>
                            Your session queue is empty.<br/>
                            Browse your library and hover any track,<br/>
                            then click <span style={{color:"#22c55e"}}>+ QUEUE</span> to add it here.
                          </div>
                        </div>
                      ) : (
                        queuedTracks.map((t,i) => (
                          <div key={t.id} style={{ display:"flex", alignItems:"center" }}>
                            <div style={{ flex:1, minWidth:0 }}>
                              <TrackRow track={{...t,_rowNum:i+1}} selected={selected===t.id} onClick={tr=>setSelected(tr.id)}
                                onAddToCrate={addToCrate} crates={crates} onPlay={null} onSendToDeck={sendToDeck}
                                queueIds={queueIds} onToggleQueue={toggleQueue}/>
                            </div>
                            <button onClick={()=>removeFromQueue(t.id)} title="Remove from queue"
                              style={{ flexShrink:0, margin:"0 10px", background:"none", border:"none", color:C.muted, cursor:"pointer", fontSize:13, opacity:.4, padding:"0 2px" }}
                              onMouseEnter={e=>e.currentTarget.style.opacity=1}
                              onMouseLeave={e=>e.currentTarget.style.opacity=.4}>✕</button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                );
              })()}
              {view==="crate" && activeCrateId && (() => {
                const crate = crates.find(c=>c.id===activeCrateId);
                const crateTracks = crate ? (crate.trackIds||[]).map(id=>tracks.find(t=>t.id===id)).filter(Boolean) : [];
                return (
                  <div style={{ flex:1, overflow:"hidden", display:"flex", flexDirection:"column" }}>
                    {/* Crate header */}
                    <div style={{ padding:"12px 16px", borderBottom:`1px solid ${C.border}`, background:C.surface, flexShrink:0, display:"flex", alignItems:"center", gap:12 }}>
                      <span style={{ fontSize:22, color:G }}>◈</span>
                      <div style={{ flex:1 }}>
                        <div style={{ fontSize:18, fontWeight:600, color:C.text, fontFamily:"'DM Sans',sans-serif" }}>{crate?.name}</div>
                        <div style={{ fontSize:10, color:C.muted, fontFamily:"'DM Mono',monospace", marginTop:2 }}>{crateTracks.length} tracks · hover a track and click <span style={{color:G}}>+ CRATE</span> to add</div>
                      </div>
                      {crateTracks.length > 0 && (
                        <button
                          onClick={() => crateTracks.forEach(t => !queueIds.has(t.id) && addToQueue(t.id))}
                          title="Add all crate tracks to session queue"
                          style={{ fontSize:9, fontFamily:"'DM Mono',monospace", padding:"5px 11px", background:"#22c55e11", border:"1px solid #22c55e44", color:"#22c55e", borderRadius:6, cursor:"pointer", whiteSpace:"nowrap" }}>
                          + QUEUE ALL
                        </button>
                      )}
                    </div>
                    {/* Crate tracks */}
                    <div style={{ flex:1, overflowY:"auto" }}>
                      {crateTracks.length === 0 ? (
                        <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:200, gap:10, color:C.muted, fontFamily:"'DM Mono',monospace", fontSize:11 }}>
                          <div style={{ fontSize:28, opacity:.2 }}>◈</div>
                          Browse any view and hover a track — click <span style={{color:G,margin:"0 4px"}}>+ CRATE</span> to add it here
                        </div>
                      ) : (
                        crateTracks.map((t,i) => (
                          <div key={t.id} style={{ display:"flex", alignItems:"center" }}>
                            <div style={{ flex:1, minWidth:0 }}>
                              <TrackRow track={{...t,_rowNum:i+1}} selected={selected===t.id} onClick={tr=>setSelected(tr.id)}
                                onAddToCrate={addToCrate} crates={crates} onPlay={null} onSendToDeck={sendToDeck}
                                queueIds={queueIds} onToggleQueue={toggleQueue}/>
                            </div>
                            <button
                              onClick={()=>removeFromCrate(t.id, activeCrateId)}
                              title="Remove from crate"
                              style={{ flexShrink:0, margin:"0 10px", background:"none", border:"none", color:C.muted, cursor:"pointer", fontSize:13, opacity:.4, padding:"0 2px", lineHeight:1 }}
                              onMouseEnter={e=>e.currentTarget.style.opacity=1}
                              onMouseLeave={e=>e.currentTarget.style.opacity=.4}
                            >✕</button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
