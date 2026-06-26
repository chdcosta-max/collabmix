// measure-wf-pixeldiff.mjs — PROVE the render-efficiency optimizations don't change
// the look. Loads the fixture into deck A, renders the top waveform under three
// configs, reads the REAL canvas pixels (getImageData), and byte-compares them:
//
//   A = batch off, glow native   (today's master render — the reference)
//   B = batch on,  glow native   (Path2D batching only)
//   C = batch on,  glow sprite   (batching + pre-rendered glow — the optimized default)
//
//   BATCHING (A vs B)  → expect ZERO differing pixels (byte-identical).
//   GLOW     (B vs C)  → expect a tiny delta confined to the grid-tick rails (the
//                        sub-pixel stamp-resample nuance; the playhead is byte-identical).
//   COMBINED (A vs C)  → the full optimized vs the full reference.
//
// Headless Chrome here rasterizes via SwiftShader (software) — the exact scenario this
// work targets — so the diff is measured under the relevant rasterizer. Needs the dev
// server up (npm run dev) + system Chrome. Run: node tools/smoke/measure-wf-pixeldiff.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockServer } from "./lib/mock-ws-server.mjs";
import { ensureFixture, FIXTURE_REL } from "./lib/gen-fixture.mjs";
import { launch, capture as consoleCapture, createRoom, loadTestTrack } from "./lib/e2e.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "out");

// Write a 32-bit BMP visualizing where two captures differ: the optimized image is
// shown dimmed, and every differing pixel is painted bright red. Preview opens BMP.
function writeDiffBMP(name, ref, var_){
  if(ref.w!==var_.w||ref.h!==var_.h) return null;
  const w=ref.w,h=ref.h, R=Buffer.from(ref.b64,'base64'), V=Buffer.from(var_.b64,'base64');
  const rowSize=w*4, dataSize=rowSize*h, fileSize=54+dataSize;
  const buf=Buffer.alloc(fileSize);
  buf.write('BM',0); buf.writeUInt32LE(fileSize,2); buf.writeUInt32LE(54,10);
  buf.writeUInt32LE(40,14); buf.writeInt32LE(w,18); buf.writeInt32LE(h,22);
  buf.writeUInt16LE(1,26); buf.writeUInt16LE(32,28); buf.writeUInt32LE(0,30); buf.writeUInt32LE(dataSize,34);
  for(let y=0;y<h;y++){
    const srcY=h-1-y, off=54+y*rowSize;          // BMP rows are bottom-up
    for(let x=0;x<w;x++){
      const i=(srcY*w+x)*4, o=off+x*4;
      const d=Math.max(Math.abs(R[i]-V[i]),Math.abs(R[i+1]-V[i+1]),Math.abs(R[i+2]-V[i+2]),Math.abs(R[i+3]-V[i+3]));
      if(d>0){ buf[o]=0; buf[o+1]=0; buf[o+2]=255; buf[o+3]=255; }   // BGRA red
      else { const g=((V[i]+V[i+1]+V[i+2])/3*0.30)|0; buf[o]=g; buf[o+1]=g; buf[o+2]=g; buf[o+3]=255; }
    }
  }
  mkdirSync(OUT_DIR,{recursive:true});
  const p=resolve(OUT_DIR,name); writeFileSync(p,buf); return p;
}

const DEV = process.env.TARGET || "http://localhost:5173/";
const SEEK = 0.4;   // fixed playhead fraction — full waveform + grid both halves, paused

async function ping(url){ try{ const r=await fetch(url); return r.status < 500; }catch{ return false; } }

if(!(await ping(DEV))){ console.error(`✗ Dev server not reachable at ${DEV}. Start it first: npm run dev`); process.exit(2); }
ensureFixture();
const mock = await startMockServer({ port: 8099, log: false });
const browser = await launch();
if(!browser){ console.error("✗ No system Chrome — cannot run the pixel diff."); await mock.close(); process.exit(2); }

function urlFor(flags){
  const u = new URL(DEV);
  u.searchParams.set("smoke","1");
  u.searchParams.set("wsurl", mock.url);
  for(const [k,v] of Object.entries(flags)) u.searchParams.set(k,v);
  return u.toString();
}

// Grab the deck-A top waveform canvas: the only canvases whose parent div uses the
// ew-resize cursor are the two AnimatedZoomedWF instances (A first, B second).
const SELECT = `[...document.querySelectorAll('canvas')].filter(c=>c.parentElement&&/ew-resize/.test(c.parentElement.getAttribute('style')||''))[0]`;

async function capture(label, flags){
  const ctx = await browser.newContext({ viewport:{ width:1280, height:800 }, deviceScaleFactor:2 });
  const page = await ctx.newPage();
  const sink = consoleCapture(page);
  await page.goto(urlFor(flags), { waitUntil:"domcontentloaded" });
  await createRoom(page);
  await loadTestTrack(page, "A", FIXTURE_REL);
  // Wait until analysis finished + the grid data is ready (the WF grid renders from
  // bpm.results once this fires) — same signal the track-mirror test uses.
  const ok = await sink.waitFor("[ANALYZER-BROADCAST] A beats=", 20000);
  if(!ok) throw new Error(`${label}: analysis never completed ([ANALYZER-BROADCAST] not seen)`);
  // PIN the frame so all three captures render the SAME deterministic scroll position:
  // pause if the deck is playing, seek to a fixed fraction, confirm it's not moving.
  const moving = async()=>{ const a=await page.evaluate(`window.__deckProg("A")`); await page.waitForTimeout(250); const b=await page.evaluate(`window.__deckProg("A")`); return Math.abs((a??0)-(b??0))>1e-5; };
  if(await moving()) await page.evaluate(`window.__toggleDeck("A")`);
  await page.waitForTimeout(150);
  await page.evaluate(`window.__seekDeck("A", ${SEEK})`);
  await page.waitForTimeout(150);
  if(await moving()){ await page.evaluate(`window.__toggleDeck("A")`); await page.waitForTimeout(150); await page.evaluate(`window.__seekDeck("A", ${SEEK})`); await page.waitForTimeout(150); }
  // Settle on actual pixel CONTENT (not PNG length): two consecutive identical frames.
  let prev=null, stable=0;
  for(let i=0;i<60;i++){
    const u = await page.evaluate(`(${SELECT})?.toDataURL() ?? ""`);
    if(u && u.length>3000 && u===prev){ if(++stable>=2) break; } else stable=0;
    prev=u; await page.waitForTimeout(120);
  }
  const prog = await page.evaluate(`window.__deckProg("A")`);
  const cap = await page.evaluate(`(()=>{
    const c=(${SELECT}); if(!c) return null;
    const w=c.width,h=c.height,d=c.getContext('2d').getImageData(0,0,w,h).data;
    let s=''; const C=0x8000; for(let i=0;i<d.length;i+=C){ s+=String.fromCharCode.apply(null,d.subarray(i,i+C)); }
    return { w,h, b64: btoa(s) };
  })()`);
  await ctx.close();
  if(!cap) throw new Error(`${label}: could not read the waveform canvas`);
  console.log(`  captured ${label.padEnd(12)} (${JSON.stringify(flags)}) → ${cap.w}×${cap.h}  prog=${(prog??-1).toFixed(6)}`);
  return cap;
}

function diff(a,b){
  if(a.w!==b.w||a.h!==b.h) return { mismatch:true, a:`${a.w}×${a.h}`, b:`${b.w}×${b.h}` };
  const A=Buffer.from(a.b64,'base64'), B=Buffer.from(b.b64,'base64');
  const w=a.w,h=a.h; let nDiff=0,maxD=0,sumD=0,yMin=h,yMax=-1,xMin=w,xMax=-1;
  for(let i=0;i<A.length;i+=4){
    const d=Math.max(Math.abs(A[i]-B[i]),Math.abs(A[i+1]-B[i+1]),Math.abs(A[i+2]-B[i+2]),Math.abs(A[i+3]-B[i+3]));
    if(d>0){ nDiff++; sumD+=d; if(d>maxD)maxD=d; const px=i/4, y=(px/w)|0, x=px%w; if(y<yMin)yMin=y; if(y>yMax)yMax=y; if(x<xMin)xMin=x; if(x>xMax)xMax=x; }
  }
  const total=w*h;
  return { w,h,total,nDiff,pct:100*nDiff/total,maxD,meanD:nDiff?sumD/nDiff:0,yBand:nDiff?[yMin,yMax]:null,xBand:nDiff?[xMin,xMax]:null };
}

function report(label, d, expect){
  console.log(`\n── ${label}`);
  if(d.mismatch){ console.log(`   CANVAS SIZE MISMATCH ${d.a} vs ${d.b} — cannot diff`); return; }
  console.log(`   differing pixels : ${d.nDiff} / ${d.total}  (${d.pct.toFixed(5)}%)`);
  console.log(`   max channel delta: ${d.maxD} / 255`);
  console.log(`   mean delta       : ${d.meanD.toFixed(2)} / 255  (over differing px)`);
  if(d.yBand) console.log(`   diff region      : x[${d.xBand[0]}..${d.xBand[1]}] y[${d.yBand[0]}..${d.yBand[1]}]  (canvas ${d.w}×${d.h})`);
  console.log(`   expect           : ${expect}`);
}

try{
  console.log(`Capturing 3 render variants (viewport 1280×800 @dpr2, fixture, paused, headless=SwiftShader)…`);
  const A  = await capture("A ref",      { wfbatch:"off", wfglow:"native" });
  const A2 = await capture("A ref (ctrl)",{ wfbatch:"off", wfglow:"native" });
  const B  = await capture("B batched",  { wfbatch:"on",  wfglow:"native" });
  const C  = await capture("C optimized",{ wfbatch:"on",  wfglow:"sprite" });

  report("CONTROL   (A vs A) — same config twice (harness noise floor)", diff(A,A2), "0 differing pixels if the harness is deterministic");
  report("BATCHING  (A vs B) — Path2D fills vs per-column fillRect", diff(A,B), "0 differing pixels (byte-identical)");
  report("GLOW      (B vs C) — pre-rendered stamps vs per-frame shadowBlur", diff(B,C), "tiny delta, confined to the grid-tick rails");
  report("COMBINED  (A vs C) — full optimized vs full reference", diff(A,C), "= the glow delta only");

  const pb=writeDiffBMP("diff-batching.bmp", A, B);
  const pg=writeDiffBMP("diff-glow.bmp", B, C);
  const pc=writeDiffBMP("diff-combined.bmp", A, C);
  console.log(`\nDiff images (red = changed pixels, dim grey = unchanged):`);
  for(const p of [pb,pg,pc]) if(p) console.log(`  ${p}`);
} finally {
  await browser.close(); await mock.close();
}
process.exit(0);
