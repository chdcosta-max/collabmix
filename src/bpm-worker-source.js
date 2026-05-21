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
  const peaks=pk(ac);if(!peaks.length){self.postMessage({id,bpm:null,confidence:0,candidates:[],beatPhaseFrac:0,beatPeriodSec:null,beatPhaseSec:0,firstBar1AnchorSec:0});return;}
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

  // ── PHASE 1: SUB-BASS band for bass-continuity downbeat disambiguation ──
  // 20-80 Hz captures sub-bass content (bassline fundamentals + kick sub).
  // Cascaded bandpass: bp() is 1-pole (12 dB/oct), running twice gives
  // ~24 dB/oct rolloff so 100-200 Hz punch/clap energy is suppressed
  // ~12 dB more than the kick band's 40-60 filter. envB is per-frame RMS
  // (sustained energy / body); onB is the z-scored half-wave-rectified
  // first difference (bass-note ARTICULATION). The product onB×envB lights
  // up beats where a new bass note is articulated AND has sustained body —
  // the bar-1 signature in per-bar-bassline EDM, structurally orthogonal
  // to kick-band energy (which clap-on-3 inflates uniformly across bars).
  let fB=bp(mono,sr,20,80); fB=bp(fB,sr,20,80);
  for(let i=0;i<fB.length;i++)fB[i]=fB[i]>0?fB[i]:0;
  const envB=new Float32Array(nf);for(let i=0;i<nf;i++){let s=0;const st=i*hop,en=Math.min(st+hop,len);for(let j=st;j<en;j++)s+=fB[j]*fB[j];envB[i]=Math.sqrt(s/(en-st));}
  const onB=new Float32Array(nf);for(let i=1;i<nf;i++){const d=envB[i]-envB[i-1];onB[i]=d>0?d:0;}
  const mnB=onB.reduce((s,v)=>s+v,0)/nf;const sdB=Math.sqrt(onB.reduce((s,v)=>s+(v-mnB)**2,0)/nf)||1;
  for(let i=0;i<nf;i++)onB[i]=(onB[i]-mnB)/sdB;

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

  // ── Per-beat beat-position refinement. Two algorithms behind one kill-
  // switch: legacy frame-resolution snap (USE_LEGACY_FRAME_SNAP=true) or
  // sample-resolution refinement using raw audio (default). Both produce
  // dpBeatsFloat[] — fractional frame positions for downstream period +
  // bar-anchor computation. Bar phase scoring downstream floors to int
  // when indexing onK/onP (bucket-resolution).
  const USE_LEGACY_FRAME_SNAP = false;
  const halfBeatFrames=floatBeatLag*0.5;
  const msPerFrame=1000/ar;
  const dpBeatsFloat = new Float64Array(dpBeats.length);
  // Per-beat attackSlope, captured in the refinement loop; used by the
  // Sub-cause F post-processing gate to detect "beat 0 anchored to a
  // no-kick position" (Rocket Jam / Symbiotic Symphony / Boundless Heart
  // class). 0 if a beat skipped refinement (silence/flat/edge/mono).
  const beatAttackSlopes = new Float64Array(dpBeats.length);

  if (USE_LEGACY_FRAME_SNAP) {
    // Legacy frame-resolution kick snap (first-rise rollback on onK−onP).
    // Preserved verbatim for one-flag revert. Produces integer-frame snaps
    // and stores them in dpBeatsFloat as integers for downstream interop.
    const SNAP_WIN=20;
    const SNAP_THRESH=onKMx*0.30;
    let snapCount=0,maxDelta=0;
    for(let i=0;i<dpBeats.length;i++){
      const f=dpBeats[i];
      const s=f-SNAP_WIN<0?0:f-SNAP_WIN, e=f+SNAP_WIN>=nf?nf-1:f+SNAP_WIN;
      let argmaxF=-1, argmaxVal=SNAP_THRESH;
      for(let j=s;j<=e;j++){
        const k=onK[j]-onP[j];
        if(k>argmaxVal){argmaxVal=k;argmaxF=j;}
      }
      let snapTargetF=argmaxF;
      if(argmaxF>=0&&argmaxVal>SNAP_THRESH*2){
        const firstRiseThresh=argmaxVal*0.4;
        for(let j=s;j<argmaxF;j++){
          if(onK[j]-onP[j]>firstRiseThresh){snapTargetF=j;break;}
        }
      }
      const noKick=argmaxF<0;
      const onSameFrame=!noKick&&snapTargetF===f;
      const monoBlock=!noKick&&!onSameFrame&&i>0&&snapTargetF<dpBeats[i-1]+halfBeatFrames;
      const willSnap=!noKick&&!onSameFrame&&!monoBlock;
      if(willSnap){
        const delta=snapTargetF>f?snapTargetF-f:f-snapTargetF;
        if(delta>maxDelta) maxDelta=delta;
        dpBeats[i]=snapTargetF;
        snapCount++;
      }
      dpBeatsFloat[i] = dpBeats[i];
    }
    console.log('[BPM-SNAP] track',id,'(legacy): snapped '+snapCount+'/'+dpBeats.length+' beats, max delta '+maxDelta+' frames');
  } else {
    // ── Sample-level transient refinement ──────────────────────────────────
    // Per beat: extract a ±50ms window of raw audio centered on the DP frame,
    // bandpass to 40-200Hz, compute power envelope smoothed over 1.5ms,
    // half-wave-rectified first derivative, argmax with parabolic interp for
    // sub-sample precision. Filter is fed a slightly larger window (+10ms
    // each side) so warmup happens in padding, not in the analysis region.
    //
    // Three confidence gates (silence / flat / edge) fall back to the DP
    // integer frame when refinement isn't trustworthy. Monotonic guard
    // prevents reordering. dpBeatsFloat[] is sample-accurate fractional
    // frame index; downstream period + anchor get sub-frame precision.
    //
    // Estimated accuracy: ±1-2ms on sharp-kick tracks, ±3-5ms on soft-kick
    // (deep house/dub techno) where attack ramp is gentler.
    const beatPeriodSecEst = floatBeatLag / ar;
    const halfWinSec = Math.min(0.05, beatPeriodSecEst * 0.4); // ±50ms cap
    const halfWinSamples = Math.round(sr * halfWinSec);
    const padSamples = Math.round(sr * 0.010); // 10ms IIR warmup pad
    const smoothWin = Math.max(8, Math.round(sr * 0.0015)); // ~1.5ms (64 samples @ 44.1k)
    const edgeMargin = Math.max(4, Math.round(sr * 0.001)); // 1ms edge margin
    const halfBeatSamples = floatBeatLag * hop / 2;
    const TRANSIENT_RATIO = 3.0;

    // Cheap global silence reference — mean of mono squared over whole track.
    let monoSumSq = 0;
    for (let i = 0; i < len; i++) { const s = mono[i]; monoSumSq += s * s; }
    const monoMeanPower = monoSumSq / Math.max(1, len);
    const SILENCE_POWER = monoMeanPower * 0.05; // 5% of mean ≈ effectively silent

    let refineCount = 0, refineSkipSilence = 0, refineSkipFlat = 0;
    let refineSkipEdge = 0, refineSkipMono = 0;
    let deltaSumMs = 0, deltaAbsSumMs = 0;
    const debugBeats = { 50: null, 100: null, 200: null };

    for (let i = 0; i < dpBeats.length; i++) {
      const f = dpBeats[i];
      const centerSample = f * hop;
      const winStart = Math.max(0, centerSample - halfWinSamples);
      const winEnd = Math.min(len, centerSample + halfWinSamples);
      const winLen = winEnd - winStart;
      const isDebugBeat = (i === 50 || i === 100 || i === 200);

      let refinedSample = -1, reason = 'ok';
      let argmaxIdx = -1, frac = 0, maxPow = 0, maxDiff = 0, meanDiff = 0;

      if (winLen < smoothWin * 4) {
        reason = 'too-narrow'; refineSkipEdge++;
      } else {
        // Extract with padding for filter warmup
        const padStart = Math.max(0, winStart - padSamples);
        const padEnd = Math.min(len, winEnd + padSamples);
        const padded = mono.subarray(padStart, padEnd);
        const filtered = bp(padded, sr, 40, 200);
        // Analyze only the inner [winStart..winEnd] region of the filtered output
        const innerOffset = winStart - padStart;

        const power = new Float32Array(winLen);
        for (let j = 0; j < winLen; j++) {
          const v = filtered[innerOffset + j];
          const p = v * v;
          power[j] = p;
          if (p > maxPow) maxPow = p;
        }

        if (maxPow < SILENCE_POWER) {
          reason = 'silence'; refineSkipSilence++;
        } else {
          // Smoothed power via running sum (O(N))
          const smoothed = new Float32Array(winLen);
          let runSum = 0;
          for (let j = 0; j < winLen; j++) {
            runSum += power[j];
            if (j >= smoothWin) runSum -= power[j - smoothWin];
            const denom = j + 1 < smoothWin ? j + 1 : smoothWin;
            smoothed[j] = runSum / denom;
          }
          // Half-wave-rectified first difference
          const diff = new Float32Array(winLen);
          let sumDiff = 0;
          for (let j = 1; j < winLen; j++) {
            const d = smoothed[j] - smoothed[j - 1];
            const dr = d > 0 ? d : 0;
            diff[j] = dr;
            if (dr > maxDiff) maxDiff = dr;
            sumDiff += dr;
          }
          meanDiff = sumDiff / Math.max(1, winLen - 1);
          if (maxDiff / Math.max(1e-12, meanDiff) < TRANSIENT_RATIO) {
            reason = 'flat'; refineSkipFlat++;
          } else {
            // argmax(diff)
            argmaxIdx = 1;
            for (let j = 2; j < winLen; j++) {
              if (diff[j] > diff[argmaxIdx]) argmaxIdx = j;
            }
            // ── Sub-cause A fix (Class 1, Step 3): beat 0 ONLY ─────────────
            // argmax(dE/dt) lands on the steepest-slope point of the kick
            // attack (mid-attack). Rekordbox-style anchoring lands earlier —
            // typically on a secondary peak at 60-80% of the global argmax
            // amplitude, slightly before the steepest-slope point. If such
            // a clear secondary peak exists earlier in the window, prefer
            // it. This fix targets the ~15 Class 1 FAILs in the +20 to +35ms
            // band (Phase Sync, In The Smoke pattern). Beat 0 only — beats
            // 1+ already work well with argmax and changing them risks
            // breaking the ~234 currently on-grid tracks.
            let subAFired = false;
            if (i === 0 && argmaxIdx > edgeMargin) {
              const EARLY_PEAK_THRESHOLD = 0.75;
              const minDiff = diff[argmaxIdx] * EARLY_PEAK_THRESHOLD;
              for (let j = edgeMargin; j < argmaxIdx; j++) {
                if (diff[j] >= minDiff &&
                    diff[j] > diff[j - 1] &&
                    diff[j] >= diff[j + 1]) {
                  argmaxIdx = j;
                  subAFired = true;
                  break;
                }
              }
            }
            // ── Sub-cause B fix (Class 1, Step 5, Phase 1): beat 0 ONLY ────
            // argmax(dE/dt) lands on the steepest-slope point of the kick
            // attack. For the Body Stars / Hymn Of The Fern class (~14 tracks
            // failing -15 to -27ms EARLY of truth), Rekordbox anchors LATER —
            // on the envelope peak (kick body), not the mid-attack slope.
            // Walk forward through the smoothed power envelope from argmaxIdx
            // until it stops rising, capped at WALK_FORWARD_MS.
            //
            // Gates:
            // - beat 0 only (beats 1+ are already tightly aligned by argmax)
            // - skipped if Sub-cause A fired (it walks BACKWARD to an earlier
            //   peak; walking forward from there would land near or past the
            //   original argmax and undo Sub-cause A)
            // - walk capped so a flat-top envelope can't drag the anchor by
            //   more than WALK_FORWARD_MS
            let walkForwardFired = false;
            if (i === 0 && !subAFired && argmaxIdx >= edgeMargin) {
              const WALK_FORWARD_MS = 20;
              const walkLimitSamples = Math.round(sr * WALK_FORWARD_MS / 1000);
              const walkLimit = Math.min(winLen - edgeMargin - 1,
                                          argmaxIdx + walkLimitSamples);
              let peakIdx = argmaxIdx;
              let peakVal = smoothed[argmaxIdx];
              for (let j = argmaxIdx + 1; j <= walkLimit; j++) {
                if (smoothed[j] >= peakVal) {
                  peakVal = smoothed[j];
                  peakIdx = j;
                } else if (smoothed[j] < peakVal * 0.98) {
                  break;
                }
              }
              if (peakIdx !== argmaxIdx) {
                argmaxIdx = peakIdx;
                walkForwardFired = true;
              }
            }
            if (argmaxIdx < edgeMargin || argmaxIdx > winLen - edgeMargin - 1) {
              reason = 'edge'; refineSkipEdge++;
            } else {
              // Parabolic interpolation for sub-sample precision.
              // Skip when walk-forward fired: argmaxIdx is the envelope peak,
              // not the diff peak, so parabolic interp on diff[] is invalid.
              if (!walkForwardFired) {
                const yL = diff[argmaxIdx - 1], yC = diff[argmaxIdx], yR = diff[argmaxIdx + 1];
                const denom = yL - 2 * yC + yR;
                if (denom < 0) {
                  frac = (yL - yR) / (2 * denom);
                  if (frac > 0.5) frac = 0.5;
                  else if (frac < -0.5) frac = -0.5;
                }
              }
              const candidate = winStart + argmaxIdx + frac;
              // Monotonic guard
              const prevSample = i > 0 ? dpBeatsFloat[i - 1] * hop : -Infinity;
              if (candidate < prevSample + halfBeatSamples) {
                reason = 'mono'; refineSkipMono++;
              } else {
                refinedSample = candidate;
              }
            }
          }
        }
      }

      if (refinedSample >= 0) {
        dpBeatsFloat[i] = refinedSample / hop;
        refineCount++;
        const dMs = (refinedSample - centerSample) / sr * 1000;
        deltaSumMs += dMs;
        deltaAbsSumMs += Math.abs(dMs);
        beatAttackSlopes[i] = maxDiff; // for Sub-cause F gate downstream
      } else {
        dpBeatsFloat[i] = f; // fall back to DP integer frame
      }

      if (isDebugBeat) {
        const targetSample = refinedSample >= 0 ? refinedSample : centerSample;
        const dMs = (targetSample - centerSample) / sr * 1000;
        console.log('[REFINE-DEBUG] ' + id + ' beat ' + i +
          ': dpFrame=' + f + ' dpMs=' + (centerSample / sr * 1000).toFixed(2) +
          ' refinedMs=' + (targetSample / sr * 1000).toFixed(2) +
          ' delta=' + (dMs >= 0 ? '+' : '') + dMs.toFixed(2) + 'ms' +
          ' reason=' + reason +
          (reason === 'ok' ? ' (argmaxIdx=' + argmaxIdx + '/' + winLen + ' frac=' + frac.toFixed(3) + ')' :
            ' (maxPow=' + maxPow.toExponential(2) + ' maxDiff/mean=' + (meanDiff > 0 ? (maxDiff / meanDiff).toFixed(2) : 'NA') + ')'));
      }
    }
    const meanDeltaMs = refineCount > 0 ? deltaSumMs / refineCount : 0;
    const meanAbsDeltaMs = refineCount > 0 ? deltaAbsSumMs / refineCount : 0;
    console.log('[REFINE-STATS] track ' + id + ': refined ' + refineCount + '/' + dpBeats.length +
      ' beats, mean delta=' + (meanDeltaMs >= 0 ? '+' : '') + meanDeltaMs.toFixed(2) + 'ms' +
      ' mean|delta|=' + meanAbsDeltaMs.toFixed(2) + 'ms' +
      ' (skipSilence=' + refineSkipSilence + ' skipFlat=' + refineSkipFlat +
      ' skipEdge=' + refineSkipEdge + ' skipMono=' + refineSkipMono + ')');
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
  const phSc16=new Float32Array(16);   // phrase-level: positions within a 16-beat phrase
  const phSc32=new Float32Array(32);   // phrase-level: positions within a 32-beat super-phrase
  // Bass-band counterparts. Scored from mid-beat sustained envB rather
  // than onset, so the bass feature is structurally orthogonal to the
  // kick feature (onset×env in both bands fires on the same kick attacks,
  // since 20-80 Hz includes the kick fundamental — defeating the
  // orthogonality the tie-breaker depends on).
  const phScBass=[0,0,0,0];
  const phSc16Bass=new Float32Array(16);
  const phSc32Bass=new Float32Array(32);
  const phScWin=5;
  // Mid-beat sampling window for bass continuity. Centered halfway to the
  // next beat (~250ms at 120 BPM), half-width 15% of the beat. This window
  // sits AFTER any kick has fully decayed (~100ms typical) and BEFORE the
  // next beat's anticipation — so envB here reads pure sustained bass.
  const midOffset=Math.round(floatBeatLag*0.5);
  const midHalfWin=Math.max(2,Math.round(floatBeatLag*0.15));
  for(let i=0;i<dpBeats.length;i++){
    // Use floor(dpBeatsFloat) so phase scoring centers on the refined kick
    // position. onK/envK are 5ms-hop arrays, so frame-resolution is fine
    // for the ±5-frame scoring window.
    const f=Math.floor(dpBeatsFloat[i]);
    const s=f-phScWin<0?0:f-phScWin, e=f+phScWin>=nf?nf-1:f+phScWin;
    let acc=0;
    for(let k=s;k<=e;k++){
      // Kick-exclusive onset: onK − onP, clamped to ≥0. The block comment
      // above describes this as the scoring rule; the prior implementation
      // dropped the subtraction and used onK alone, so beats with kick+
      // snare bleed (e.g., Shadow Work's beat 3) scored higher than
      // kick-only beats (beat 1). Restoring the subtraction lets the
      // punch-band signal cancel snare-bleed energy at scoring time.
      const okEx=(onK[k]-onP[k])>0?(onK[k]-onP[k]):0;
      acc+=okEx*envK[k];
    }
    phSc[i%4]+=acc;
    phSc16[i%16]+=acc;
    phSc32[i%32]+=acc;
    // Mid-beat bass continuity: sustained sub-bass energy in the window
    // BETWEEN this beat and the next, after kick decay. Per-bar basslines
    // produce a falling pattern across the bar (high after bar-1, lower
    // after each subsequent beat); clap-on-3 doesn't elevate mid-beat
    // bass because the clap's transient has decayed by midpoint.
    const midF=f+midOffset;
    const ms=midF-midHalfWin<0?0:midF-midHalfWin;
    const me=midF+midHalfWin>=nf?nf-1:midF+midHalfWin;
    let midAcc=0;
    for(let k=ms;k<=me;k++) midAcc+=envB[k];
    const midMean=midAcc/Math.max(1,me-ms+1);
    phScBass[i%4]+=midMean;
    phSc16Bass[i%16]+=midMean;
    phSc32Bass[i%32]+=midMean;
  }

  // ── PHASE 2: beat-synchronized chroma + novelty ───────────────────────
  // Harmonic-change detection as a third independent signal for downbeat
  // disambiguation. Bandpass the mid range (80-2000 Hz) to isolate chord
  // and lead content, then project each beat's audio window onto 4 octaves
  // × 12 pitch classes via direct DFT (Goertzel-equivalent without the
  // recurrence). Cosine distance between adjacent beats' L2-normalized
  // chroma vectors gives a novelty curve — high values mark harmonic
  // boundaries. Phases where novelty clusters on bar boundaries score
  // highest. Structurally orthogonal to both kick energy (irrelevant
  // here) and bass continuity (catches harmonic-only changes that
  // sustained-bass features miss).
  const fH=bp(mono,sr,80,2000);
  // 4 octaves × 12 PCs spanning ~131-1976 Hz (C3 to B6). Octave shift
  // CHROMA_OCT0=-1 places A4 reference at oct=1 (so oct=0 is one octave
  // below A4 ≈ A3=220 Hz; pc=0 is C of that octave).
  const CHROMA_OCTS=4, CHROMA_OCT0=-1;
  const chromaFreqs=new Float32Array(CHROMA_OCTS*12);
  for(let o=0;o<CHROMA_OCTS;o++){
    for(let pc=0;pc<12;pc++){
      chromaFreqs[o*12+pc]=440*Math.pow(2,(pc-9)/12+(o+CHROMA_OCT0));
    }
  }
  // Per-beat chroma vectors. Window ±100ms around the beat (~9k samples
  // at sr=44.1k), stride 4 for ~2.2k effective samples. Per beat, 48
  // freqs × 2.2k samples × 2 ops = ~210k ops. ~100M total for a 500-beat
  // track, ~100ms in Node.
  const chromaWinSamples=Math.round(sr*0.10);
  const chromaStride=4;
  const chromaPerBeat=new Float32Array(dpBeats.length*12);
  const pcAccum=new Float32Array(12);
  for(let i=0;i<dpBeats.length;i++){
    for(let pc=0;pc<12;pc++) pcAccum[pc]=0;
    const beatSample=Math.floor(dpBeatsFloat[i]*hop);
    const ws=beatSample-chromaWinSamples<0?0:beatSample-chromaWinSamples;
    const we=beatSample+chromaWinSamples>len?len:beatSample+chromaWinSamples;
    for(let oct=0;oct<CHROMA_OCTS;oct++){
      for(let pc=0;pc<12;pc++){
        const freq=chromaFreqs[oct*12+pc];
        if(freq>sr*0.45) continue;
        const omega=2*Math.PI*freq/sr;
        let re=0,im=0;
        for(let k=ws;k<we;k+=chromaStride){
          const s=fH[k];
          const phase=omega*(k-ws);
          re+=s*Math.cos(phase);
          im+=s*Math.sin(phase);
        }
        pcAccum[pc]+=re*re+im*im;
      }
    }
    // sqrt to magnitudes, L2-normalize across PCs.
    let normSq=0;
    for(let pc=0;pc<12;pc++){
      pcAccum[pc]=Math.sqrt(pcAccum[pc]);
      normSq+=pcAccum[pc]*pcAccum[pc];
    }
    const norm=Math.sqrt(normSq);
    if(norm>0) for(let pc=0;pc<12;pc++) pcAccum[pc]/=norm;
    for(let pc=0;pc<12;pc++) chromaPerBeat[i*12+pc]=pcAccum[pc];
  }
  // Novelty curve: cosine distance between adjacent beats. novelty[0]=0
  // (no predecessor). Higher = bigger harmonic change between beats.
  const chromaNovelty=new Float32Array(dpBeats.length);
  for(let i=1;i<dpBeats.length;i++){
    let dot=0;
    for(let pc=0;pc<12;pc++){
      dot+=chromaPerBeat[(i-1)*12+pc]*chromaPerBeat[i*12+pc];
    }
    const dist=1-dot;
    chromaNovelty[i]=dist>0?dist:0;
  }
  // Per-phase chroma scoring. Phases where harmonic changes cluster
  // score highest — bar boundaries are where chord/note changes
  // statistically concentrate. argmax = bar-1 candidate.
  const phScChroma=[0,0,0,0];
  const phSc16Chroma=new Float32Array(16);
  const phSc32Chroma=new Float32Array(32);
  for(let i=1;i<dpBeats.length;i++){
    const n=chromaNovelty[i];
    phScChroma[i%4]+=n;
    phSc16Chroma[i%16]+=n;
    phSc32Chroma[i%32]+=n;
  }
  let bestPhChroma=0;
  for(let k=1;k<4;k++) if(phScChroma[k]>phScChroma[bestPhChroma]) bestPhChroma=k;
  const phMaxChroma=Math.max(phScChroma[0],phScChroma[1],phScChroma[2],phScChroma[3]);
  const phMinChroma=Math.min(phScChroma[0],phScChroma[1],phScChroma[2],phScChroma[3]);
  const chromaSpread=phMaxChroma>0?(phMaxChroma-phMinChroma)/phMaxChroma:0;

  // ── PHASE 3: SSM novelty at phrase scales ─────────────────────────────
  // Per-beat 14-dim feature vector combines kick energy, bass continuity,
  // and chroma. Self-similarity matrix is computed on the fly (no NxN
  // storage). Multi-scale checkerboard kernel (Foote 2000) detects
  // structural boundaries at bar/motif/phrase/section scales. Phase
  // scoring sums novelty per i%4 — phases where boundaries cluster
  // identify bar-1 position. Standard EDM phrase structure (intro/build/
  // drop on 16/32-bar boundaries) has boundaries land on bar-1.
  const N=dpBeats.length;
  const FEAT_DIM=14;
  let phScSSM=[0,0,0,0];
  const phSc16SSM=new Float32Array(16);
  const phSc32SSM=new Float32Array(32);
  let bestPhSSM=0;
  let ssmSpread=0;
  let ssmMultiScaleAgree=0;
  let ssmPeakCount=0;
  if (N >= 16) {
    // Per-beat kick peak (max envK in ±5 frames) and bass mid (midEnvB).
    const kickPeakPerBeat=new Float32Array(N);
    const bassMidPerBeat=new Float32Array(N);
    for(let i=0;i<N;i++){
      const f=Math.floor(dpBeatsFloat[i]);
      const ks=f-5<0?0:f-5, ke=f+5>=nf?nf-1:f+5;
      let kMx=0; for(let k=ks;k<=ke;k++) if(envK[k]>kMx) kMx=envK[k];
      kickPeakPerBeat[i]=kMx;
      const midF2=f+midOffset;
      const ms2=midF2-midHalfWin<0?0:midF2-midHalfWin;
      const me2=midF2+midHalfWin>=nf?nf-1:midF2+midHalfWin;
      let mAcc=0; for(let k=ms2;k<=me2;k++) mAcc+=envB[k];
      bassMidPerBeat[i]=mAcc/Math.max(1,me2-ms2+1);
    }
    // Component-wise normalization so kick + bass scalars don't dominate
    // chroma in the combined feature vector. Target: each component
    // contributes roughly equal L2 mass across the track.
    let kSq=0, bSq=0;
    for(let i=0;i<N;i++){
      kSq+=kickPeakPerBeat[i]*kickPeakPerBeat[i];
      bSq+=bassMidPerBeat[i]*bassMidPerBeat[i];
    }
    const kScale=kSq>0?Math.sqrt(N/kSq):0;
    const bScale=bSq>0?Math.sqrt(N/bSq):0;
    // Build feature vectors [0]=kick, [1]=bass, [2..13]=chroma (already
    // L2-normalized per beat from Phase 2). L2-normalize the full vector
    // so cosine similarity is dot product.
    const featPerBeat=new Float32Array(N*FEAT_DIM);
    for(let i=0;i<N;i++){
      featPerBeat[i*FEAT_DIM+0]=kickPeakPerBeat[i]*kScale;
      featPerBeat[i*FEAT_DIM+1]=bassMidPerBeat[i]*bScale;
      for(let pc=0;pc<12;pc++) featPerBeat[i*FEAT_DIM+2+pc]=chromaPerBeat[i*12+pc];
      let nsq=0;
      for(let d=0;d<FEAT_DIM;d++){
        const v=featPerBeat[i*FEAT_DIM+d];
        nsq+=v*v;
      }
      const nrm=Math.sqrt(nsq);
      if(nrm>0) for(let d=0;d<FEAT_DIM;d++) featPerBeat[i*FEAT_DIM+d]/=nrm;
    }
    // Foote checkerboard novelty at multiple scales. Cells (di,dj) with
    // sign +1 in past-past and future-future quadrants, -1 in cross
    // quadrants. Gaussian taper sigma=L/2 suppresses kernel-edge noise.
    // High novelty = past block is similar within, future is similar
    // within, but past ≠ future (structural boundary).
    const SCALES=[4,8,16,32].filter(L=>L*2<N);
    const noveltyCurve=new Float32Array(N);
    const phPerScale=[]; // per-scale per-phase scores for agreement check
    for(let s=0;s<SCALES.length;s++) phPerScale.push([0,0,0,0]);
    for(let i=0;i<N;i++){
      let maxNov=0;
      for(let s=0;s<SCALES.length;s++){
        const L=SCALES[s];
        if(i-L<0 || i+L>N-1) continue;
        const sigma=L*0.5;
        const sig2=2*sigma*sigma;
        let acc=0;
        for(let di=-L;di<L;di++){
          for(let dj=-L;dj<L;dj++){
            // Cosine similarity (vectors L2-normalized → dot product)
            const a=i+di, b=i+dj;
            let dot=0;
            for(let d=0;d<FEAT_DIM;d++) dot+=featPerBeat[a*FEAT_DIM+d]*featPerBeat[b*FEAT_DIM+d];
            const taper=Math.exp(-(di*di+dj*dj)/sig2);
            const sgn=((di<0)===(dj<0))?1:-1;
            acc+=sgn*taper*dot;
          }
        }
        if(acc>0) phPerScale[s][i%4]+=acc;
        if(acc>maxNov) maxNov=acc;
      }
      noveltyCurve[i]=maxNov;
    }
    // Per-phase scoring via PEAK DETECTION (not raw novelty sum).
    // Structural boundaries appear as local maxima in the novelty curve
    // — typically 5-8 per track for EDM (intro/build/drop/break
    // transitions). Summing the full curve across all ~600 beats
    // drowns those boundary peaks in non-boundary noise. Detect peaks
    // above (mean + threshold × stddev), enforce minimum spacing to
    // avoid double-counting neighboring beats of the same boundary,
    // then score per-phase by weighted peak novelty.
    let novMean=0;
    for(let i=0;i<N;i++) novMean+=noveltyCurve[i];
    novMean/=N;
    let novVar=0;
    for(let i=0;i<N;i++){
      const d=noveltyCurve[i]-novMean;
      novVar+=d*d;
    }
    const novStd=Math.sqrt(novVar/N);
    const novThresh=novMean+1.5*novStd;
    const peaks=[];
    const minPeakSpacing=4; // beats — at least 1 bar between detected peaks
    for(let i=1;i<N-1;i++){
      if(noveltyCurve[i]>novThresh &&
         noveltyCurve[i]>=noveltyCurve[i-1] &&
         noveltyCurve[i]>=noveltyCurve[i+1]){
        if(peaks.length===0 || i-peaks[peaks.length-1].i>=minPeakSpacing){
          peaks.push({i:i,v:noveltyCurve[i]});
        }
      }
    }
    // Weight each peak by its novelty value so big section boundaries
    // dominate over small motif transitions.
    for(let i=0;i<4;i++) phScSSM[i]=0;
    for(let p=0;p<peaks.length;p++){
      phScSSM[peaks[p].i%4]+=peaks[p].v;
      phSc16SSM[peaks[p].i%16]+=peaks[p].v;
      phSc32SSM[peaks[p].i%32]+=peaks[p].v;
    }
    bestPhSSM=0;
    for(let k=1;k<4;k++) if(phScSSM[k]>phScSSM[bestPhSSM]) bestPhSSM=k;
    const phMaxSSM=Math.max(phScSSM[0],phScSSM[1],phScSSM[2],phScSSM[3]);
    const phMinSSM=Math.min(phScSSM[0],phScSSM[1],phScSSM[2],phScSSM[3]);
    ssmSpread=phMaxSSM>0?(phMaxSSM-phMinSSM)/phMaxSSM:0;
    // ssmPeakCount: number of detected structural-boundary peaks. With
    // peak-based scoring, ssmSpread can spike to 1.0 from just 1-2 peaks
    // landing in one phase — artificially confident when sample size is
    // too small to be meaningful. SSM "clear" gating downstream requires
    // BOTH high spread AND adequate peak count (≥5: enough for at least
    // 4 phrase-scale boundaries in a typical 6-8 min EDM track).
    ssmPeakCount=peaks.length;
    // Multi-scale agreement: did each individual scale pick the same
    // phase as the combined? Higher = more structural confidence.
    ssmMultiScaleAgree=0;
    for(let s=0;s<SCALES.length;s++){
      let bp=0;
      for(let k=1;k<4;k++) if(phPerScale[s][k]>phPerScale[s][bp]) bp=k;
      if(bp===bestPhSSM) ssmMultiScaleAgree++;
    }
    // Diagnostic: log top peaks and their phase distribution.
    if(peaks.length>0){
      const topPeaks=peaks.slice().sort((a,b)=>b.v-a.v).slice(0,8);
      console.log('[phase] SSM peaks (top 8): '+
        topPeaks.map(p=>'beat'+p.i+'(%4='+(p.i%4)+',v='+p.v.toFixed(1)+')').join(' '));
    }
  }

  // Raw argmax of phSc (kick-exclusive). Used both as the default bestPh
  // and as a reference for whether phrase voting brings new information.
  let rawBestPh=0;
  for(let k=1;k<4;k++) if(phSc[k]>phSc[rawBestPh]) rawBestPh=k;
  let bestPh=rawBestPh;

  // Compute phrase-vote winners up front so we can decide whether they
  // bring new info BEFORE running the bass tie-breaker. Order matters:
  // bass should not override a phrase-vote that already disagrees with
  // the raw kick argmax — that disagreement IS the signal that phrase
  // voting has information beyond per-beat scoring.
  let best16=-1, best16Mod4=-1;
  if (dpBeats.length >= 32) {
    let best16Sc=-1;
    for(let k=0;k<16;k++){if(phSc16[k]>best16Sc){best16Sc=phSc16[k];best16=k;}}
    best16Mod4=best16%4;
  }
  let best32=-1, best32Mod4=-1;
  if (dpBeats.length >= 64) {
    let best32Sc=-1;
    for(let k=0;k<32;k++){if(phSc32[k]>best32Sc){best32Sc=phSc32[k];best32=k;}}
    best32Mod4=best32%4;
  }
  const phraseBringsNewInfo =
    (best16Mod4 >= 0 && best16Mod4 !== rawBestPh) ||
    (best32Mod4 >= 0 && best32Mod4 !== rawBestPh);

  // Spreads for ambiguity / discrimination gating.
  const phMax=Math.max(phSc[0],phSc[1],phSc[2],phSc[3]);
  const phMin=Math.min(phSc[0],phSc[1],phSc[2],phSc[3]);
  const kickSpread = phMax>0 ? (phMax-phMin)/phMax : 0;
  const phMaxBass=Math.max(phScBass[0],phScBass[1],phScBass[2],phScBass[3]);
  const phMinBass=Math.min(phScBass[0],phScBass[1],phScBass[2],phScBass[3]);
  const bassSpread = phMaxBass>0 ? (phMaxBass-phMinBass)/phMaxBass : 0;

  // Bass-derived bar-1 candidate: the bucket BEFORE the lowest midEnvB
  // bucket. Rationale: per-bar basslines decay toward the bar boundary
  // before re-articulating at the next bar-1, so the lowest sustained
  // sub-bass sits just BEFORE bar-1. (Empirically validated on Sunbeam,
  // Shadow Work, Tuesday Maybe; the argmax interpretation tested first
  // failed because the wide 20-80 Hz band picks up kick-fundamental
  // energy, making argmax conflate with kick-band scoring.)
  let bassArgMin=0;
  for(let k=1;k<4;k++) if(phScBass[k]<phScBass[bassArgMin]) bassArgMin=k;
  const bestPhBass=(bassArgMin+1)%4;

  // ── PHASE 2 DECISION TREE ─────────────────────────────────────────────
  // Unified priority order replaces Phase 1's bass tie-breaker + phrase
  // override + ambiguity fallback cascade. Inputs: rawBestPh (kick),
  // best16Mod4/best32Mod4 (phrase voting), bestPhBass (bass continuity),
  // bestPhChroma (harmonic novelty), with their respective spreads.
  //
  // Priority:
  //   0. kickSpread > 0.35 — kick has clear winner, trust raw
  //   1. phrase16 == phrase32 != raw — phrase consensus picks alternative
  //      (Home In The Sky case: bass would pick wrong; phrase rescues)
  //   2. phrase16 != phrase32 — phrase internally inconsistent, defer
  //      to raw (YWNK safety: prevents bass/chroma overriding correct
  //      raw when phrase voting itself is noisy)
  //   3. bass clear AND chroma clear AND agree — high confidence
  //   4. bass clear, chroma unclear — bass alone
  //   5. chroma clear, bass unclear — chroma alone
  //   6. bass and chroma clear but DISAGREE — defer to raw (avoids the
  //      As Fate Has It regression where bass fires confidently on the
  //      wrong answer; requires agreement before overriding)
  //   7. all unclear — raw
  let decision='raw';
  if (kickSpread > 0.35) {
    decision='raw (kickSpread > 0.35)';
  } else {
    const phraseAgree =
      best16Mod4 >= 0 && best32Mod4 >= 0 && best16Mod4 === best32Mod4;
    const phraseInternalDisagree =
      best16Mod4 >= 0 && best32Mod4 >= 0 && best16Mod4 !== best32Mod4;
    if (phraseAgree && best16Mod4 !== rawBestPh) {
      bestPh = best16Mod4;
      decision = 'phrase agree → '+best16Mod4;
    } else if (phraseInternalDisagree) {
      bestPh = rawBestPh;
      decision = 'raw (phrase internal disagree: 16='+best16Mod4+' 32='+best32Mod4+')';
    } else {
      // Three independent signals: bass continuity (Phase 1), chroma
      // novelty (Phase 2), and SSM phrase-scale novelty (Phase 3).
      // Thresholds tuned per signal: kick spread is the most reliable
      // when present (0.30), chroma is weaker on EDM (0.25), SSM
      // novelty values can be small in absolute terms but the
      // (max-min)/max spread is the meaningful metric — start at 0.20.
      const bassClear = bassSpread > 0.30;
      const chromaClear = chromaSpread > 0.25;
      // SSM clear requires BOTH high spread AND enough detected
      // structural-boundary peaks. Peak-based scoring can produce
      // spurious high spread from 1-2 peaks landing in one phase;
      // ≥5 peaks indicates real structural pattern.
      const ssmClear = ssmSpread > 0.30 && ssmPeakCount >= 5;

      // Tally votes across clear signals. Triple-agreement = highest
      // confidence; pair agreement = medium; single signal = lower;
      // disagreement among clear signals or all-unclear = defer to raw.
      const sigPicks = [];
      if (bassClear) sigPicks.push({n:'bass',p:bestPhBass});
      if (chromaClear) sigPicks.push({n:'chroma',p:bestPhChroma});
      if (ssmClear) sigPicks.push({n:'SSM',p:bestPhSSM});
      const votes = [0,0,0,0];
      for (const s of sigPicks) votes[s.p]++;
      let maxVotes = 0, maxBucket = -1;
      for (let k = 0; k < 4; k++) if (votes[k] > maxVotes) { maxVotes = votes[k]; maxBucket = k; }

      if (maxVotes === 3) {
        bestPh = maxBucket;
        decision = 'bass+chroma+SSM triple-agree → '+maxBucket;
      } else if (maxVotes === 2) {
        bestPh = maxBucket;
        const names = sigPicks.filter(s=>s.p===maxBucket).map(s=>s.n).join('+');
        decision = names+' pair-agree → '+maxBucket;
      } else if (sigPicks.length === 1) {
        bestPh = sigPicks[0].p;
        decision = sigPicks[0].n+' alone → '+bestPh+' (other signals unclear)';
      } else if (sigPicks.length >= 2) {
        bestPh = rawBestPh;
        decision = 'raw ('+sigPicks.length+' clear signals all disagree)';
      } else {
        bestPh = rawBestPh;
        decision = 'raw (all signals unclear)';
      }
    }
  }
  console.log('[phase] decision: '+decision+' → bestPh='+bestPh+
              ' (kickSp='+kickSpread.toFixed(2)+
              ' bassSp='+bassSpread.toFixed(2)+
              ' chromaSp='+chromaSpread.toFixed(2)+')');
  // Precise beat period from snap-corrected DP beats — plain MEAN
  // (lastBeat-firstBeat / n-1). Median/trimmed-mean alternatives tested
  // and rejected: median snaps to a single integer-frame interval and
  // loses sub-frame precision; trimmed mean still drifted on long tracks.
  // Plain mean's frame-quantization averaging gives best precision on
  // clean tracks AND the BPM-snap below catches integer-tempo'd tracks
  // where mean is slightly off. Computed BEFORE the bar-1 anchor so we
  // can extrapolate the anchor by bars.
  const beatPeriodSec=dpBeats.length>=2
    ?(dpBeatsFloat[dpBeats.length-1]-dpBeatsFloat[0])/(dpBeats.length-1)/ar
    :(60/bChk);
  console.log('[BPM-PERIOD] track',id,': mean='+beatPeriodSec.toFixed(6)+'s ('+(60/beatPeriodSec).toFixed(3)+')');

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
  // Branch 2: two independent estimators both round to the same integer.
  // Symmetric form — autocorrelation BPM (bpm) AND beat-mean BPM
  // (bpmFromPeriod) must each individually be within 0.25 of intBpm. The
  // old form gated on |bpm - bpmFromPeriod| < 0.07 which was too tight:
  // estimator noise routinely exceeded 0.1 even on integer-tempo'd tracks
  // (e.g. Home In The Sky: bpm=121.1, bpmFromPeriod=120.892, both round to
  // 121, but |Δ|=0.208 failed the old check). Symmetric form catches that
  // track AND stays safe against false-snap on truly fractional BPMs
  // because both estimators must independently sit within 0.25 of integer
  // (a true 121.4 BPM track fails first check the same as before).
  const crossValidated = bpmFromPeriod !== null
    && Math.abs(bpm - intBpm) < 0.25
    && Math.abs(bpmFromPeriod - intBpm) < 0.25;
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
  console.log('[phase] phSc kick-exclusive:',phSc.map(x=>x.toFixed(2)),
    'best16%4:',best16Mod4,'best32%4:',best32Mod4,'bestPh:',bestPh,
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

  // First bar-1 downbeat anchor — Rekordbox-style. Strategy: place bar-1
  // at the first mathematical beat near time 0. Start from dpBeatsFloat[0]
  // (the first DP-detected beat — typically the first audible kick) and
  // walk BACKWARD by single beats until one more step would go negative.
  // Result lands in [0, beatPeriodSec) — matching Rekordbox's "bar-1 at
  // or near time 0" convention. Forward bar boundaries are extrapolated
  // by the renderer/sync at firstDownbeatSec + N × beatPeriodSec.
  //
  // This intentionally IGNORES the Phase 1-3 bestPh computation: that
  // logic identified the *musical* downbeat phase (which of every 4 beats
  // is the structural bar-1), which is a different problem from where
  // Rekordbox marks bar-1. Empirical validation: on a 272-track random
  // sample, this walk-back approach matched Rekordbox truth on ~95% of
  // tracks; the old "musical bar-1" approach matched only 28%. Phase 1-3
  // code is kept computed but dormant; bestPh now diagnostic-only and
  // may move to an opt-in "musical mode" later.
  const beatFrames=beatPeriodSec*ar;
  let barDownbeatFrame=dpBeatsFloat[0]||0;
  while(barDownbeatFrame-beatFrames>=0) barDownbeatFrame-=beatFrames;

  // ── Sub-cause C fix (Class 1, Step 4): sampler / one-shot convention ──
  // Rekordbox places bar-1 at sample 0 for sampler / one-shot WAV files
  // (loop kits, drum hits, short demo clips). Our envelope-peak refinement
  // naturally lands 20-40ms in — the natural attack-to-peak time of a kick
  // through our 1.5ms smoothing window. For short / few-beat tracks where
  // the first detected beat is close enough to file start that "snap to 0"
  // is the right call, override the walk-back result.
  //
  // Detection: durSec < 30 OR dpBeats.length < 8 (i.e., short loop or
  // few-beat one-shot). Action gate: only snap if the walk-back result is
  // already within 40ms of file start (otherwise this isn't a "kick-at-0"
  // sampler — leave it alone). Empirical: catches Techno1, House2, House4
  // among known FAILs. Zero predicted regressions on currently-passing
  // samplers (House1 already at 9ms — snap improves to 0).
  const durSec = len / sr;
  const isSampler = durSec < 30 || dpBeats.length < 8;
  if (isSampler && barDownbeatFrame / ar < 0.040) {
    console.log('[BPM-SAMPLER] track ' + id + ': snap to 0 (durSec=' +
      durSec.toFixed(2) + ' beats=' + dpBeats.length + ' was=' +
      (barDownbeatFrame / ar * 1000).toFixed(1) + 'ms)');
    barDownbeatFrame = 0;
  }

  let dropDetectionFired = false;
  // ── Sub-cause D fix (Class 2, Phase 2): drop-detection grid validation ──
  // For off-by-N-beats failures (analyzer locked to first transient at ~0ms,
  // Rekordbox places bar-1 1-2 sec in at the actual phrase drop), use kick
  // breakdown → return events as a vote on bar phase.
  //
  // Algorithm: bandpass 40-100Hz, frame energy at 100ms hops, smooth 2s,
  // threshold at 40% of p70. Find inactive runs ≥4s (breakdowns); each is
  // followed by a drop. Snap the drop to the earliest analyzer-grid beat
  // within ±2 beats that has substantial kick energy AND ≥2× energy rise
  // from the previous beat. For each snapped drop, compute beat-of-bar
  // relative to current bar-1; vote on the dominant. If ALL valid drops
  // agree on a non-zero bob (conf=1.0) AND ≥2 drops AND anaBar1 < 50ms,
  // shift bar-1 forward by dominantBeat × period.
  //
  // The conf=1.0 + anaBar1<50ms + drops≥2 gate was tuned in
  // tools/docs/DROP_DETECTION_INVESTIGATION.md against the 272-track library:
  // +2 PASS (Shuttered, White Moon) / 0 regressions on PASS tracks.
  if ((barDownbeatFrame / ar) < 0.050 && finalPeriod > 0) {
    const HOP_SEC = 0.1;
    const hopS = Math.max(1, Math.round(sr * HOP_SEC));
    const n = Math.floor(len / hopS);
    if (n > 50) { // need a few seconds of audio
      const band = bp(mono, sr, 40, 100);
      const fE = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const st = i * hopS;
        let s = 0;
        const end = Math.min(band.length, st + hopS);
        for (let j = st; j < end; j++) { const v = band[j]; s += v * v; }
        fE[i] = Math.sqrt(s / hopS);
      }
      const sw = Math.max(3, Math.round(2.0 / HOP_SEC));
      const fS = new Float32Array(n);
      const q = [];
      let acc = 0;
      for (let i = 0; i < n; i++) {
        acc += fE[i];
        q.push(fE[i]);
        if (q.length > sw) acc -= q.shift();
        fS[i] = acc / q.length;
      }
      const sortedFS = [];
      for (let i = 0; i < n; i++) if (fS[i] > 0) sortedFS.push(fS[i]);
      sortedFS.sort(function(a, b) { return a - b; });
      if (sortedFS.length > 10) {
        const p70 = sortedFS[Math.floor(sortedFS.length * 0.70)];
        const thresh = p70 * 0.40;
        const active = new Uint8Array(n);
        for (let i = 0; i < n; i++) active[i] = fS[i] > thresh ? 1 : 0;
        const minBreakFrames = Math.ceil(4.0 / HOP_SEC);
        const anaBar1Sec = barDownbeatFrame / ar;
        const drops = [];
        let inactiveStart = active[0] ? -1 : 0;
        for (let i = 1; i < n; i++) {
          if (!active[i] && active[i - 1]) {
            inactiveStart = i;
          } else if (active[i] && !active[i - 1] && inactiveStart >= 0) {
            const breakFrames = i - inactiveStart;
            if (breakFrames >= minBreakFrames) {
              const tDrop = i * HOP_SEC;
              const N0 = Math.round((tDrop - anaBar1Sec) / finalPeriod);
              // Local-future median for energy threshold
              const winHi = Math.min(n - 1, i + Math.round(2.0 / HOP_SEC));
              const winArr = [];
              for (let k = i; k <= winHi; k++) winArr.push(fE[k]);
              winArr.sort(function(a, b) { return a - b; });
              const winMedian = winArr[Math.floor(winArr.length / 2)] || 0;
              const minEnergy = winMedian * 0.4;
              const rad = Math.max(1, Math.round(0.06 / HOP_SEC));
              let snappedT = -1;
              for (let dN = -2; dN <= 2; dN++) {
                const N = N0 + dN;
                const tBeat = anaBar1Sec + N * finalPeriod;
                if (tBeat < 0 || tBeat >= len / sr) continue;
                const fIdx = Math.round(tBeat / HOP_SEC);
                if (fIdx < 1 || fIdx >= n - 1) continue;
                let eHere = 0;
                for (let k = Math.max(0, fIdx - rad); k <= Math.min(n - 1, fIdx + rad); k++) {
                  if (fE[k] > eHere) eHere = fE[k];
                }
                if (eHere < minEnergy) continue;
                const prevFIdx = Math.round((tBeat - finalPeriod) / HOP_SEC);
                let ePrev = 0;
                if (prevFIdx >= 0 && prevFIdx < n) {
                  for (let k = Math.max(0, prevFIdx - rad); k <= Math.min(n - 1, prevFIdx + rad); k++) {
                    if (fE[k] > ePrev) ePrev = fE[k];
                  }
                }
                if (eHere < 2 * ePrev) continue;
                snappedT = tBeat;
                break;
              }
              if (snappedT > 0.5) drops.push(snappedT);
            }
            inactiveStart = -1;
          }
        }
        if (drops.length >= 2) {
          const hist = [0, 0, 0, 0];
          for (let d = 0; d < drops.length; d++) {
            const bob = ((Math.round((drops[d] - anaBar1Sec) / finalPeriod) % 4) + 4) % 4;
            hist[bob]++;
          }
          let dom = 0;
          for (let b = 1; b < 4; b++) if (hist[b] > hist[dom]) dom = b;
          const total = hist[0] + hist[1] + hist[2] + hist[3];
          const conf = total > 0 ? hist[dom] / total : 0;
          if (conf >= 0.999 && dom !== 0) {
            const newBar1Sec = anaBar1Sec + dom * finalPeriod;
            console.log('[BPM-DROPSHIFT] track ' + id +
              ': votedShift=' + dom + 'β drops=' + drops.length +
              ' bar1: ' + (anaBar1Sec * 1000).toFixed(1) + 'ms → ' +
              (newBar1Sec * 1000).toFixed(1) + 'ms');
            barDownbeatFrame = newBar1Sec * ar;
            dropDetectionFired = true;
          }
        }
      }
    }
  }

  // ── Sub-cause F fix: advance bar-1 to first real kick (no-kick beat 0) ──
  // Targets Rocket Jam / Symbiotic Symphony / Boundless Heart class:
  // the DP+walk-back anchored bar-1 to a position with NO kick at all
  // (beat 0 attackSlope effectively zero). The real first kick is N beats
  // later. Visible result: every bar marker in the track is offset by
  // N beats from where it should be — the drop visibly doesn't land on
  // a bar boundary.
  //
  // Detect: beat 0 attackSlope < 1e-6 AND the first beat[k>=1] with
  // slope >= 50% × median(slopes[1..N-1]) has slope > 100 × beat 0 slope.
  // Action: shift bar-1 forward by k beats (capped at 3).
  //
  // The shift cap is the safety belt: if beats 1, 2, 3 are ALSO weak
  // (e.g., In This World — track legitimately starts with quiet kicks
  // but bar-1 is still at the beginning), we don't advance. Diagnostic
  // in tools/sota-eval/ROCKET_JAM_FIX.md showed cap=3 gives +2 rescues
  // (Boundless Heart, It Has To Be Like This) with 0 regressions on the
  // 272-track harness, plus correctly anchors Rocket Jam off-harness.
  // Skip if drop-detection already shifted — the beatAttackSlopes array was
  // computed at the ORIGINAL dpBeats positions, so post-drop-detection the
  // "beat 0" position no longer corresponds to slopes[0]. Re-firing on the
  // original silence signature would double-shift correctly-rescued tracks
  // (Shuttered and White Moon hit this in pre-guard testing).
  if (!dropDetectionFired && beatAttackSlopes.length >= 8 && beatAttackSlopes[0] < 1e-6) {
    // Need beats 1..N for the median baseline
    const otherSlopes = [];
    const probeUpTo = Math.min(beatAttackSlopes.length, 30);
    for (let k = 1; k < probeUpTo; k++) {
      if (beatAttackSlopes[k] > 0) otherSlopes.push(beatAttackSlopes[k]);
    }
    if (otherSlopes.length >= 4) {
      otherSlopes.sort(function (a, b) { return a - b; });
      const medianSlope = otherSlopes[Math.floor(otherSlopes.length / 2)];
      const firstKickMinSlope = medianSlope * 0.50;
      let firstKickBeat = -1;
      for (let k = 1; k < probeUpTo; k++) {
        if (beatAttackSlopes[k] >= firstKickMinSlope) { firstKickBeat = k; break; }
      }
      if (firstKickBeat > 0 && firstKickBeat <= 3 &&
          beatAttackSlopes[firstKickBeat] > beatAttackSlopes[0] * 100) {
        const beatFrames = finalPeriod * ar;
        const newBar1Frame = barDownbeatFrame + firstKickBeat * beatFrames;
        console.log('[BPM-NOKICK-BEAT0] track ' + id +
          ': beat0Slope=' + beatAttackSlopes[0].toExponential(2) +
          ' firstKickBeat=' + firstKickBeat +
          ' slope=' + beatAttackSlopes[firstKickBeat].toExponential(2) +
          ' shift +' + firstKickBeat + 'β  bar1: ' + (barDownbeatFrame/ar*1000).toFixed(1) +
          'ms → ' + (newBar1Frame/ar*1000).toFixed(1) + 'ms');
        barDownbeatFrame = newBar1Frame;
      }
    }
  }

  // beatPhaseFrac is the anchor's beat-index from track start. Using beatPeriodSec
  // keeps firstDownbeatSec = beatPhaseFrac × beatPeriodSec = barDownbeatFrame/ar
  // exactly, which is what the grid draw loop needs.
  const beatPhaseFrac=finalPeriod>0?(barDownbeatFrame/ar)/finalPeriod:0;
  // beatPhaseSec — used by sync alignment to align two tracks' beats.
  // Derived from firstBar1AnchorSec so both decks use the same convention
  // (consistency matters for cross-deck sync more than the absolute value).
  const firstBar1AnchorSec=barDownbeatFrame/ar;
  const beatPhaseSec=finalPeriod>0?(firstBar1AnchorSec%finalPeriod):0;
  console.log('[phase] anchor (Rekordbox-style walk-back): firstBar1AnchorSec='+
    firstBar1AnchorSec.toFixed(4)+' beatPhaseSec='+beatPhaseSec.toFixed(4)+
    ' (dpBeats[0]='+(dpBeatsFloat[0]?(dpBeatsFloat[0]/ar).toFixed(4):'-')+
    ' bestPh='+bestPh+' [diagnostic-only])');
  // firstBar1AnchorSec posted explicitly so the client doesn't have to
  // derive it as beatPhaseFrac × beatPeriodSec (which is correct but
  // depends on beatPhaseFrac being the UNWRAPPED beats-from-start, and
  // is fragile to anyone assuming it's a [0,1) fraction). Use this field
  // directly for first-downbeat auto-position.
  // phase diagnostics — non-breaking addition for the test harness. Client
  // ignores. Phase 1 added bass scores; Phase 2 adds chroma scores and
  // the decision-tree branch label.
  const phase={
    bestPh,
    phSc:[phSc[0],phSc[1],phSc[2],phSc[3]],
    phSpread:kickSpread,
    phScBass:[phScBass[0],phScBass[1],phScBass[2],phScBass[3]],
    phSpreadBass:bassSpread,
    bestPhBass,
    phScChroma:[phScChroma[0],phScChroma[1],phScChroma[2],phScChroma[3]],
    phSpreadChroma:chromaSpread,
    bestPhChroma,
    phScSSM:[phScSSM[0],phScSSM[1],phScSSM[2],phScSSM[3]],
    phSpreadSSM:ssmSpread,
    bestPhSSM,
    ssmMultiScaleAgree,
    ssmPeakCount,
    decision,
    best16Mod4,
    best32Mod4,
    dpBeatsLen:dpBeats.length,
  };
  self.postMessage({id,bpm:finalBpm,confidence:conf,candidates:cands,beatPhaseFrac,beatPeriodSec:finalPeriod,beatPhaseSec,firstBar1AnchorSec,snapped,phase});
};`;
