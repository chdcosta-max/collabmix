// Source of the BPM analyzer Web Worker. Imported by:
//   - src/collabmix-production.jsx (production app, runs as a Web Worker)
//   - tools/bpm-test-harness/analyze.mjs (test harness, evaluated in Node)
// Both consumers feed (cd, sr, id) into the worker via self.onmessage and
// receive results via self.postMessage. Keep this file pure JS (no DOM,
// no AudioContext) so it remains Node-runnable.

export const WORKER_SRC = `
function bp(sig,sr,low,high){const o=new Float32Array(sig.length);const rL=1/(2*Math.PI*high/sr+1),rH=1/(2*Math.PI*low/sr+1);let pi=0,po=0;const hp=new Float32Array(sig.length);for(let i=0;i<sig.length;i++){hp[i]=rH*(po+sig[i]-pi);pi=sig[i];po=hp[i];}let pv=0;for(let i=0;i<hp.length;i++){pv=o[i]=pv+(1-rL)*(hp[i]-pv);}return o;}
function pk(a){const r=[];for(let i=1;i<a.length-1;i++){if(a[i]>a[i-1]&&a[i]>a[i+1]){const lm=Math.min(...a.slice(Math.max(0,i-10),i),...a.slice(i+1,Math.min(a.length,i+11)));r.push({idx:i,val:a[i],p:a[i]-lm});}}return r.sort((a,b)=>b.val-a.val);}
function rv(b,mn,mx){let v=b;while(v<mn)v*=2;while(v>mx)v/=2;return Math.round(v*10)/10;}
function dphase(mono,sr,bpm){
  if(!bpm||bpm<=0)return{beatPhaseSec:0,beatPeriodSec:60/bpm};
  let beatPeriodSec=60/bpm;
  const beatPeriodSamples=sr*beatPeriodSec;

  // Build kick-drum onset envelope at FULL sample rate
  // Bandpass 40-120Hz to isolate kick fundamental.
  // Target ~5 ms hops but use the ACTUAL hop/sr for all seconds conversions —
  // otherwise beatPeriodSec drifts 0.23% per beat at 44.1 kHz (same bug as main
  // worker body).
  const hop=Math.floor(sr*0.005);
  const hopSec=hop/sr;
  const nf=Math.floor(mono.length/hop);

  // Simple lowpass to get kick energy
  const env=new Float32Array(nf);
  let prev=0;
  const alpha=1/(2*Math.PI*(100/sr)+1);
  for(let i=0;i<nf;i++){
    const st=i*hop;
    let s=0;
    for(let j=0;j<hop&&st+j<mono.length;j++){
      const v=mono[st+j];
      s+=v*v;
    }
    const rms=Math.sqrt(s/hop);
    prev=prev+(1-alpha)*(rms-prev);
    env[i]=Math.max(0,rms-prev*0.7); // onset = RMS minus smoothed baseline
  }

  // Beat period in frames (nominal, from calculated BPM — used for search windows only)
  const beatFrames=beatPeriodSec/hopSec;

  // Find first strong onset after 0.5s (skip intro silence)
  const skipFrames=Math.round(0.5/hopSec);
  let maxVal=0;
  for(let i=skipFrames;i<nf;i++)if(env[i]>maxVal)maxVal=env[i];
  const thresh=maxVal*0.35;

  // Find the peak of the first strong kick
  let firstKick=skipFrames;
  for(let i=skipFrames;i<Math.min(nf,skipFrames+beatFrames*8);i++){
    if(env[i]>thresh){
      // Find local maximum around this onset
      let peak=i;
      for(let j=i;j<Math.min(nf,i+Math.round(beatFrames*0.1));j++){
        if(env[j]>env[peak])peak=j;
      }
      firstKick=peak;
      break;
    }
  }
  // Shift back 2 hop frames — onset detection lands on the attack ramp,
  // not the perceived beat center. Subtracting ~10ms brings the grid onto the kick.
  firstKick=Math.max(0,firstKick-2);

  // Measure beat period across MANY kicks (up to 32 beats out) for precision.
  // At each expected beat position (firstKick + i*beatFrames) search a ±20% window for
  // the strongest above-threshold peak. Use the latest-found kick and its beat index N
  // to compute period = (lastKick - firstKick) * hopSec / N — long baseline, low noise.
  let lastKick=firstKick;
  let lastKickBeatIdx=0;
  const maxKicks=32;
  const winRad=Math.round(beatFrames*0.2);
  for(let i=1;i<=maxKicks;i++){
    const expected=firstKick+Math.round(i*beatFrames);
    if(expected>=nf)break;
    const winStart=Math.max(0,expected-winRad);
    const winEnd=Math.min(nf,expected+winRad);
    let peak=-1;
    let peakVal=thresh;
    for(let j=winStart;j<winEnd;j++){
      if(env[j]>peakVal){peakVal=env[j];peak=j;}
    }
    if(peak>=0){lastKick=peak;lastKickBeatIdx=i;}
  }
  if(lastKickBeatIdx>0){
    beatPeriodSec=(lastKick-firstKick)*hopSec/lastKickBeatIdx;
  }

  // Convert back to seconds
  const firstKickSec=firstKick*hopSec;

  // Phase within beat period (0 to beatPeriodSec)
  const beatPhaseSec=firstKickSec%beatPeriodSec;

  return{beatPhaseSec,beatPeriodSec};
}
self.onmessage=function(e){
  const{cd,sr,id}=e.data;const len=cd[0].length,nc=cd.length;
  const mono=new Float32Array(len);for(let c=0;c<nc;c++){const d=cd[c];for(let i=0;i<len;i++)mono[i]+=d[i]/nc;}
  // BPM detection: 100-400Hz bandpass captures kick + snare transients for autocorrelation
  const f=bp(mono,sr,100,400);for(let i=0;i<f.length;i++)f[i]=f[i]>0?f[i]:0;
  // Target onset-envelope frame rate ~200 Hz. hop is an integer sample count, so
  // the ACTUAL frame rate ar = sr/hop drifts from 200 (e.g. for 44.1 kHz,
  // hop=220 → ar=200.4545). Every frames↔seconds conversion below uses this
  // exact ar — not 200 — or beatPeriodSec accumulates ~0.23% error per beat and
  // the grid drifts ~1 s across a 5-minute track at 44.1 kHz.
  const hop=Math.floor(sr/200),ar=sr/hop,nf=Math.floor(len/hop);
  const env=new Float32Array(nf);for(let i=0;i<nf;i++){let s=0;const st=i*hop,en=Math.min(st+hop,len);for(let j=st;j<en;j++)s+=f[j]*f[j];env[i]=Math.sqrt(s/(en-st));}
  const on=new Float32Array(nf);for(let i=1;i<nf;i++){const d=env[i]-env[i-1];on[i]=d>0?d:0;}
  const mn=on.reduce((s,v)=>s+v,0)/nf;const sd=Math.sqrt(on.reduce((s,v)=>s+(v-mn)**2,0)/nf)||1;
  for(let i=0;i<nf;i++)on[i]=(on[i]-mn)/sd;
  const ml=Math.floor(60/200*ar),xl=Math.ceil(60/60*ar),al=xl-ml+1;
  const ac=new Float32Array(al);for(let li=0;li<al;li++){const lag=li+ml;let s=0;for(let i=0;i<nf-lag;i++)s+=on[i]*on[i+lag];ac[li]=s/(nf-lag);}
  const peaks=pk(ac);if(!peaks.length){self.postMessage({id,bpm:null,confidence:0,candidates:[],beatPhaseFrac:0,beatPeriodSec:null,beatPhaseSec:0});return;}
  // Parabolic interpolation around the autocorrelation peak for sub-integer lag
  // precision. Fit y = a*(x-x₀)² + b through (idx-1, idx, idx+1) and take x₀.
  // Closed-form: x₀ = idx + (yL - yR) / (2 * (yL - 2·yC + yR)), bounded to ±0.5.
  // This nudges BPM estimation below the 1.3-BPM gap between integer lags.
  const top=peaks[0];
  let frac=0;
  if(top.idx>=1 && top.idx<ac.length-1){
    const yL=ac[top.idx-1], yC=ac[top.idx], yR=ac[top.idx+1];
    const denom=yL-2*yC+yR;
    if(denom<0){ // must be concave-down at a true peak
      frac=(yL-yR)/(2*denom);
      if(frac>0.5)frac=0.5; else if(frac<-0.5)frac=-0.5;
    }
  }
  const lag=top.idx+ml+frac;const raw=(60/lag)*ar;
  const bpm=rv(raw,100,175);
  const mxA=Math.max(...ac),mnA=Math.min(...ac),rng=mxA-mnA||1;
  const conf=Math.min(100,Math.round(((top.val-mnA)/rng)*100));
  const cands=peaks.slice(0,5).map(p=>({bpm:rv((60/(p.idx+ml))*ar,100,175),score:p.val}));
  // Beat phase detection — octave-adjust lag to match folded BPM range (100-175)
  let adjLag=lag;let bChk=raw;while(bChk<100){bChk*=2;adjLag=Math.floor(adjLag/2);}while(bChk>175){bChk/=2;adjLag=adjLag*2;}
  adjLag=Math.max(1,adjLag);
  // Float beat lag: eliminates drift for fractional BPMs (e.g. 120.6 BPM)
  const floatBeatLag=(60/bChk)*ar;

  // ── DP BEAT TRACKER (Ellis 2007-style) ─────────────────────────────────────────
  // Unlike simple phase search, DP finds the globally optimal beat sequence across
  // the FULL track — this is what Rekordbox/Traktor do during track analysis.
  // Each beat is scored by its onset strength PLUS the quality of the transition
  // from the previous beat. The log-Gaussian transition penalty keeps tempo tight.
  const dpLo=Math.round(floatBeatLag*0.75);  // min beat interval (allows ±25% tempo flex)
  const dpHi=Math.round(floatBeatLag*1.35);  // max beat interval
  const dpAlpha=100;                           // tempo tightness (higher = stricter)
  const dpLogP=Math.log(floatBeatLag);
  const dpSc=new Float32Array(nf);
  const dpBk=new Int32Array(nf).fill(-1);
  for(let t=dpLo;t<nf;t++){
    const ov=Math.max(0,on[t]);
    let bsc=-1e30,bp=-1;
    for(let p=Math.max(0,t-dpHi);p<=t-dpLo;p++){
      const lg=Math.log(t-p);
      const pen=dpAlpha*(lg-dpLogP)*(lg-dpLogP);
      const sc=dpSc[p]-pen;
      if(sc>bsc){bsc=sc;bp=p;}
    }
    dpSc[t]=ov+(bp>=0&&bsc>-1e29?bsc:0);
    if(bp>=0)dpBk[t]=bp;
  }
  // Find best endpoint in last beat period
  let dpEnd=nf-1,dpMx=-1e30;
  for(let t=Math.max(0,nf-dpHi);t<nf;t++){if(dpSc[t]>dpMx){dpMx=dpSc[t];dpEnd=t;}}
  // Backtrack to collect full beat sequence (most recent → oldest)
  const dpBeats=[];let dpt=dpEnd;
  while(dpt>0&&dpBk[dpt]>=0){dpBeats.push(dpt);dpt=dpBk[dpt];}
  dpBeats.push(dpt);
  dpBeats.reverse(); // now oldest→newest

  // ── KICK-FOCUSED onset for bar downbeat detection ────────────────────────────
  // Two bands: kick fundamental (40-60 Hz) and punch/snare (100-200 Hz). The
  // biquad's 12 dB/oct rolloff isn't sharp enough to fully reject snare sub-thump
  // from the kick band alone, so we compute BOTH and score beats by their
  // kick-EXCLUSIVE onset = max(0, onK - onP). Real kicks have high onK and low
  // onP; snares/claps have both. This differentiates backbeats from kicks even
  // when the snare has significant sub content, which otherwise anchored
  // "downbeat" markers to the snare on Sunday-Sunrise-style tracks.
  const fK=bp(mono,sr,40,60);for(let i=0;i<fK.length;i++)fK[i]=fK[i]>0?fK[i]:0;
  const envK=new Float32Array(nf);for(let i=0;i<nf;i++){let s=0;const st=i*hop,en=Math.min(st+hop,len);for(let j=st;j<en;j++)s+=fK[j]*fK[j];envK[i]=Math.sqrt(s/(en-st));}
  const onK=new Float32Array(nf);for(let i=1;i<nf;i++){const d=envK[i]-envK[i-1];onK[i]=d>0?d:0;}
  const mnK=onK.reduce((s,v)=>s+v,0)/nf;const sdK=Math.sqrt(onK.reduce((s,v)=>s+(v-mnK)**2,0)/nf)||1;
  for(let i=0;i<nf;i++)onK[i]=(onK[i]-mnK)/sdK;
  const fP=bp(mono,sr,100,200);for(let i=0;i<fP.length;i++)fP[i]=fP[i]>0?fP[i]:0;
  const envP=new Float32Array(nf);for(let i=0;i<nf;i++){let s=0;const st=i*hop,en=Math.min(st+hop,len);for(let j=st;j<en;j++)s+=fP[j]*fP[j];envP[i]=Math.sqrt(s/(en-st));}
  const onP=new Float32Array(nf);for(let i=1;i<nf;i++){const d=envP[i]-envP[i-1];onP[i]=d>0?d:0;}
  const mnP=onP.reduce((s,v)=>s+v,0)/nf;const sdP=Math.sqrt(onP.reduce((s,v)=>s+(v-mnP)**2,0)/nf)||1;
  for(let i=0;i<nf;i++)onP[i]=(onP[i]-mnP)/sdP;

  // Find the first KICK-audible beat. Using onK (40-60 Hz kick band) instead of
  // on (broadband) prevents latching onto pad/arpeggio onsets during ambient
  // intros. Onset peaks are narrow (1-2 frames wide) and DP beat positions are
  // approximate — reading onK at a single frame often misses a real kick. A ±3
  // frame (±15 ms) windowed max around each DP beat gives a robust kick-presence
  // measure. Threshold 0.30 of peak kick onset ensures we wait for a real kick.
  // Two windowed readouts around each DP beat frame (±3 frames = ±15 ms, robust
  // to small DP placement offsets from the true onset peak):
  //   onKAt  — raw kick-band onset, used for first-beat detection (threshold
  //            scaled to onK peak, so we need the same feature here).
  //   kickExAt — kick-EXCLUSIVE onset = max(0, onK - onP). Rewards beats whose
  //            40-60 Hz attack isn't matched by a 100-200 Hz punch, which is
  //            how kicks look and how snares/claps DON'T. Used only for phase
  //            scoring, where we need to distinguish kicks from backbeats.
  const onKAt=(frame)=>{
    const s=frame-3<0?0:frame-3, e=frame+3>=nf?nf-1:frame+3;
    let mx=0; for(let j=s;j<=e;j++) if(onK[j]>mx) mx=onK[j];
    return mx;
  };
  const kickExAt=(frame)=>{
    const s=frame-3<0?0:frame-3, e=frame+3>=nf?nf-1:frame+3;
    let mK=0,mP=0;
    for(let j=s;j<=e;j++){ if(onK[j]>mK) mK=onK[j]; if(onP[j]>mP) mP=onP[j]; }
    return mK-mP>0?mK-mP:0;
  };
  let onKMx=0;for(let i=0;i<nf;i++)if(onK[i]>onKMx)onKMx=onK[i];
  const onKTh=onKMx*0.3;
  let firstBeatDpIdx=-1;
  for(let i=0;i<dpBeats.length;i++){if(onKAt(dpBeats[i])>onKTh){firstBeatDpIdx=i;break;}}
  // Fallback for tracks with no distinct kicks (pure ambient, drumless).
  if(firstBeatDpIdx<0){
    let onMx=0;for(let i=0;i<nf;i++)if(on[i]>onMx)onMx=on[i];
    const onTh=onMx*0.25;
    firstBeatDpIdx=0;
    for(let i=0;i<dpBeats.length;i++){if(Math.max(0,on[dpBeats[i]])>onTh){firstBeatDpIdx=i;break;}}
  }

  // Determine BAR PHASE: which of 4 beats is the bar downbeat (beat 1)?
  // Score each of 4 phase offsets (0,1,2,3) against kick onset across all dpBeats.
  // The offset with the highest cumulative kick strength = bar downbeat phase.
  // Phase scoring: kick-exclusive onset (onK minus onP) per beat. A kick has
  // strong 40-60 Hz attack with little 100-200 Hz content → high score. A
  // snare/clap has 40-60 Hz BLEED plus strong 100-200 Hz punch → subtraction
  // zeros most of it. So the "bar 1 is the kick" hypothesis wins robustly even
  // when the snare's sub-bleed is large enough to beat a raw kick-band reading.
  //
  // Scoring across ALL dpBeats (from index 0), NOT from firstBeatDpIdx. This
  // way bestPh is DIRECTLY the DP-index-mod-4 of bar-1 positions, so anchoring
  // on dpBeats[bestPh] gives the earliest bar-1 in the sequence. Previously
  // we offset from firstBeatDpIdx, which shifted the anchor by (firstBeatDpIdx
  // mod 4) beats — landing the red marker on kick #3 instead of kick #1 on
  // tracks like Sunday Sunrise.
  // Onset-gated sub-bass scoring. Real kicks have BOTH a sharp onset AND
  // sustained sub-bass body. Mid-band syncopation (vocal chops, stabs) has
  // an onset but weak body. Sustained sub without attack has body but no
  // onset. Multiplying onK * envK selects beats with both — i.e., real kicks.
  // Window is ±5 frames (~25ms) to capture the kick body without bleeding
  // into the next beat (~250+ frames apart at 124 BPM).
  const phSc=[0,0,0,0];
  const phScWin=5;
  for(let i=0;i<dpBeats.length;i++){
    const f=dpBeats[i];
    const s=f-phScWin<0?0:f-phScWin, e=f+phScWin>=nf?nf-1:f+phScWin;
    let acc=0;
    for(let k=s;k<=e;k++){
      const ok=onK[k]>0?onK[k]:0;
      acc+=ok*envK[k];
    }
    phSc[i%4]+=acc;
  }
  let bestPh=0,bestPhSc=-1;
  for(let k=0;k<4;k++){if(phSc[k]>bestPhSc){bestPhSc=phSc[k];bestPh=k;}}
  // Ambiguity guard: if phase scores are near-tied (spread < 25% of peak),
  // the scoring isn't reliably picking bar-1 — typical of tracks with even
  // 4-on-the-floor kicks where every beat carries roughly the same kick
  // energy. Observed on Sunday Sunrise: scores [66.4, 65.3, 70.9, 61.0],
  // bucket 2 wins by a 7% margin and anchors on kick #3 instead of kick #1.
  // Fall back to phase 0 so the anchor lands on the earliest DP beat. Only
  // keep the detected phase when one bucket dominates cleanly — that's where
  // bar-phase info is actually trustworthy.
  const phMax=Math.max(phSc[0],phSc[1],phSc[2],phSc[3]);
  const phMin=Math.min(phSc[0],phSc[1],phSc[2],phSc[3]);
  if(phMax>0 && (phMax-phMin)/phMax < 0.25) bestPh=0;
  // Precise beat period from DP-tracked beats — mean interval across all detected beats.
  // Avoids the rounding drift that comes from using bpm (rv rounds to 0.1 BPM).
  // Over a 5-min track this is accurate to under 0.1ms per beat vs ~100ms+ from rounded bpm.
  // Computed BEFORE the bar-1 anchor so we can extrapolate the anchor backward by bars.
  const beatPeriodSec=dpBeats.length>=2
    ?(dpBeats[dpBeats.length-1]-dpBeats[0])/(dpBeats.length-1)/ar
    :(60/bChk);

  // BPM snap: snap bpm and beatPeriodSec to clean integer values when we have
  // strong evidence the track is integer-tempo'd. Modern EDM is produced at
  // integer BPMs, but precision detectors land slightly off (e.g. 121.2 when
  // track is 121). Without snap, grids visibly drift over a long track.
  // Two independent evidence paths, gated by a conservative outer guard.
  const bpmFromPeriod = beatPeriodSec > 0 ? 60 / beatPeriodSec : null;
  const intBpm = Math.round(bpm);
  // Branch 1: period is mathematically integer-locked (DP-mean evidence).
  // DP-mean averages over hundreds of beats — when it lands within 0.05 of an
  // integer, the track is genuinely integer-tempo'd.
  const periodIntegerLocked = bpmFromPeriod !== null && Math.abs(bpmFromPeriod - intBpm) < 0.05;
  // Branch 2: two independent estimators converge near integer.
  // For tracks where DP-mean is slightly off (e.g. Starseed at 121.155) but
  // both DP-mean and autocorrelation agree closely AND both are near integer,
  // we have strong evidence the track is integer-tempo'd despite estimator noise.
  const crossValidated = bpmFromPeriod !== null
    && Math.abs(bpm - intBpm) < 0.25
    && Math.abs(bpm - bpmFromPeriod) < 0.07;
  // Outer guard: never snap if autocorrelation BPM is more than 0.5 from integer.
  const withinOuterGuard = Math.abs(bpm - intBpm) < 0.5;
  let finalBpm = bpm;
  let finalPeriod = beatPeriodSec;
  let snapped = false;
  if ((periodIntegerLocked || crossValidated) && withinOuterGuard) {
    finalBpm = intBpm;
    finalPeriod = 60 / intBpm;
    snapped = true;
  }

  // Diagnostic — remove once Issue 1 is closed.
  console.log('[phase] phSc:',phSc.map(x=>x.toFixed(4)),'bestPh:',bestPh,
    'spread/peak:',(phSc.length?((Math.max(...phSc)-Math.min(...phSc))/(Math.max(...phSc)||1)).toFixed(3):'NA'),
    'firstBeatDpIdx:',firstBeatDpIdx,
    'dpBeats.length:',dpBeats.length,
    'dpBeats[0..3] secs:',[dpBeats[0],dpBeats[1],dpBeats[2],dpBeats[3]].map(f=>f==null?'-':(f/ar).toFixed(4)),
    'snapped:',snapped,
    'snap-debug:','bpm:',bpm,
    'bpmFromPeriod:',bpmFromPeriod==null?'-':bpmFromPeriod.toFixed(3),
    'intBpm:',intBpm,
    '|bpmFromPeriod-intBpm|:',bpmFromPeriod==null?'-':Math.abs(bpmFromPeriod-intBpm).toFixed(3),
    '|bpm-intBpm|:',Math.abs(bpm-intBpm).toFixed(3),
    '|bpm-bpmFromPeriod|:',bpmFromPeriod==null?'-':Math.abs(bpm-bpmFromPeriod).toFixed(3),
    'periodIntegerLocked:',periodIntegerLocked,
    'crossValidated:',crossValidated,
    'withinOuterGuard:',withinOuterGuard);

  // First bar-1 downbeat anchor. Strategy: the kick-exclusive phase scoring
  // locks which of every 4 DP beats is bar-1. Then we walk BACKWARD through
  // the bar grid in whole-bar jumps, past the first detected DP beat, until
  // we hit the earliest bar-1 position still inside the track (frame ≥ 0).
  //
  // This matters because the DP tracker can miss the first 1-2 kicks entirely
  // on tracks with soft intros (Anjunadeep-style buildups) — dpBeats[0] is
  // already a few beats into the track, so we can't rely on DP to place the
  // anchor in the intro. But we don't need DP once the period and phase are
  // locked: we can extrapolate bar positions back indefinitely using
  // beatPeriodSec × ar × 4 frames per bar.
  // bestPh is already the bar-1 phase in dpBeats-index-mod-4 terms (scoring
  // ran from i=0, so no firstBeatDpIdx offset needed).
  const earliestDpIdx=Math.min(bestPh,dpBeats.length-1);
  const barFrames=beatPeriodSec*ar*4;
  let barDownbeatFrame=dpBeats[earliestDpIdx]||0;
  while(barDownbeatFrame-barFrames>=0) barDownbeatFrame-=barFrames;

  // beatPhaseFrac is the anchor's beat-index from track start. Using beatPeriodSec
  // keeps firstDownbeatSec = beatPhaseFrac × beatPeriodSec = barDownbeatFrame/ar
  // exactly, which is what the grid draw loop needs.
  const beatPhaseFrac=finalPeriod>0?(barDownbeatFrame/ar)/finalPeriod:0;
  // Full-sample-rate phase detection via dphase (used by AnimatedZoomedWF)
  const dphaseResult=finalBpm?dphase(mono,sr,finalBpm):{beatPhaseSec:0};
  self.postMessage({id,bpm:finalBpm,confidence:conf,candidates:cands,beatPhaseFrac,beatPeriodSec:finalPeriod,beatPhaseSec:dphaseResult.beatPhaseSec,snapped});
};`;
