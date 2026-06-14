// measure-yellow.mjs — IS the amber onset reliably the KICK, and where does it
// sit vs the grid and the true kick? Compares the current BROAD onset (bass+mid,
// <3500Hz rise) against a TIGHT kick-band onset (40-120Hz rise).
// Reports, per band choice:
//   precision = % of yellow spikes that land on an analyzer beat (vs firing on
//               non-kick transients between beats)
//   recall    = % of beats that get a yellow spike
//   peakVsGrid/peakVsKick = ms offset of on-beat yellow spikes from grid / true kick
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decode, runWorker, kickEnvelope, envFloor, onsetOf } from "./lib/audio.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACKDIR = resolve(__dirname, "../bpm-test-harness/tracks");
const NAMES = ["Kyotto - Home In The Sky (Original Mix).mp3","Tantum - It Has To Be Like This (Original Mix).mp3","Michael A - Sunbeam (HAFT Extended Remix).mp3","Way Out West - Tuesday Maybe (Guy J Remix).mp3"];
const RES = 6000; // env frames/sec (~0.17ms) — plenty for onset timing
const med = (xs)=>{const s=[...xs].sort((a,b)=>a-b);return s.length?s[Math.floor(s.length/2)]:NaN;};

// Build an env-follower amplitude envelope of a band, at RES frames/sec.
// loCut/hiCut in Hz; hiCut=null → lowpass only (lowCut..). Returns Float array.
function bandEnv(mono, sr, loCut, hiCut){
  const aLo = loCut?Math.exp(-2*Math.PI*loCut/sr):0;       // highpass corner (remove below loCut)
  const aHi = hiCut?Math.exp(-2*Math.PI*hiCut/sr):0;       // lowpass corner (remove above hiCut)
  const aAtk=Math.exp(-1/(sr*0.0008)), aRel=Math.exp(-1/(sr*0.020));
  const nf=Math.floor(mono.length/sr*RES); const out=new Float32Array(nf);
  let lpLo=0,lpHi=0,env=0; const step=mono.length/nf;
  for(let i=0;i<mono.length;i++){
    const s=mono[i];
    lpHi = hiCut? aHi*lpHi+(1-aHi)*s : s;                   // lowpassed (≤hiCut)
    lpLo = loCut? aLo*lpLo+(1-aLo)*s : 0;                   // lowpassed (≤loCut)
    const band = lpHi - lpLo;                               // band-passed loCut..hiCut
    const r = band<0?-band:band;
    env = r>env? aAtk*env+(1-aAtk)*r : aRel*env+(1-aRel)*r;
    const x=Math.floor(i/step); if(x<nf && env>out[x]) out[x]=env;
  }
  return out;
}
function onsetPeaks(env){ // positive-rise peaks, ≥30% of max, ≥60ms apart
  const nf=env.length, D=Math.round(0.004*RES); const on=new Float32Array(nf);
  let mx=0; for(let i=D;i<nf;i++){const d=env[i]-env[i-D];on[i]=d>0?d:0;if(on[i]>mx)mx=on[i];}
  const th=0.30*mx, gap=Math.round(0.06*RES), peaks=[]; let last=-1e9;
  for(let i=1;i<nf-1;i++){ if(on[i]>=th&&on[i]>=on[i-1]&&on[i]>on[i+1]&&(i-last)>=gap){peaks.push(i/RES);last=i;} }
  return peaks;
}

console.log("band            precision(yellow→beat)  recall(beat→yellow)  peakVsGrid  peakVsKick");
for(const name of NAMES){
  let dec; try{dec=await decode(resolve(TRACKDIR,name));}catch{continue;}
  const {sr,channelData,mono,dur}=dec;
  const kEnv=kickEnvelope(mono,sr), floor=envFloor(kEnv);
  const beats=runWorker(channelData,sr,"anc",true).beatTimes.filter(b=>b>0.5&&b<dur-0.3);
  const trueKicks=beats.map(b=>onsetOf(kEnv,sr,b,floor)).filter(x=>x!=null);
  for(const [label,lo,hi] of [["BROAD <3500 (current)",0,3500],["TIGHT 40-120 (kick)",40,120]]){
    const env=bandEnv(mono,sr,lo,hi);
    const peaks=onsetPeaks(env);
    if(!peaks.length){console.log(`  ${name.slice(0,16)} ${label}: no peaks`);continue;}
    const near=(arr,t,tol)=>{let best=null,bd=tol;for(const a of arr){const d=Math.abs(a-t);if(d<bd){bd=d;best=a;}}return best;};
    let onBeat=0, vsGrid=[], vsKick=[];
    for(const p of peaks){ const b=near(beats,p,0.05); if(b!=null){onBeat++; vsGrid.push((p-b)*1000); const k=near(trueKicks,p,0.06); if(k!=null)vsKick.push((p-k)*1000);} }
    let beatsHit=0; for(const b of beats){ if(near(peaks,b,0.05)!=null)beatsHit++; }
    const prec=100*onBeat/peaks.length, rec=100*beatsHit/beats.length;
    console.log(`  ${name.slice(0,14).padEnd(15)} ${label.padEnd(22)} ${prec.toFixed(0).padStart(3)}% (${peaks.length} peaks)   ${rec.toFixed(0).padStart(3)}% (${beats.length} beats)   ${med(vsGrid).toFixed(0).padStart(4)}ms     ${med(vsKick).toFixed(0).padStart(4)}ms`);
  }
}
console.log("\nprecision LOW = yellow fires on non-kick low-mid transients (bass/stabs), not just the kick.");
console.log("peakVsGrid negative = yellow draws BEFORE the grid (grid lands past it). peakVsKick ~0 = yellow on the true kick.");
