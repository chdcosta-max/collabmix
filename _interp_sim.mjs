// Simulation of the non-driver playhead interp: OLD (fixed 1×, snap) vs NEW
// (rate-aware + slew). Driver deck plays SYNCED at rate=0.97 (3% slow), which is
// exactly the case that produced the backward sawtooth. We feed 10Hz progress
// packets with jitter and sample the displayed playhead at 60fps, then report
// the largest BACKWARD step the viewer would see (in seconds of track time).

const DUR = 360;           // 6-minute track
const PKT_MS = 100;        // 10Hz progress packets
const FRAME_MS = 1000/60;  // 60fps render
const RUN_MS = 120000;     // 120s — long enough for the sawtooth to cycle
const SLEW_TAU_MS = 220, SEEK_SNAP_SEC = 3;
let RATE = 0.94;           // set per-sweep below
const trueRate = RATE/(DUR*1000); // true progress fraction per ms

// deterministic jitter (no Math.random — keep it reproducible)
let seed = 12345; const jit = () => { seed=(seed*1103515245+12345)&0x7fffffff; return (seed/0x7fffffff-0.5); };

function run(mode){
  let remProg=0, remTime=0, remRate=0, remSlew=0;
  let truth=0.02;                  // driver starts a bit into the track
  let lastVisible=null, maxBack=0, nextPkt=0;
  const visibleAt=(now)=>{
    const since=now-remTime;
    if(mode==='old') return Math.min(1,Math.max(0, remProg+remRate*since));
    const modeled=remProg+remRate*since;
    const slew=remSlew*Math.exp(-since/SLEW_TAU_MS);
    return Math.min(1,Math.max(0, modeled+slew));
  };
  for(let now=0; now<=RUN_MS; now+=FRAME_MS){
    truth = 0.02 + trueRate*now;   // driver's real position
    // packet arrival (with ±15ms jitter on the reported value's timing)
    if(now>=nextPkt){
      const pkt = truth + trueRate*(jit()*30); // small jitter in reported pos
      if(mode==='old'){
        // OLD: fixed 1× rate, snap on >0.5% drift, else accept forward only
        remRate = 1/(DUR*1000);
        const since = remTime?(now-remTime):0;
        const cur = remTime?remProg+remRate*since:pkt;
        const drift = pkt-cur;
        if(remTime===0 || Math.abs(drift)>0.005){ remProg=pkt; remTime=now; }
        else if(drift>0){ remProg=pkt; remTime=now; }
        // else coast
      } else {
        // NEW: rate-aware + slew
        remRate = RATE/(DUR*1000);
        const since = now-remTime;
        const modeledNow = remProg+(remRate||0)*since;
        const slewNow = remSlew*Math.exp(-since/SLEW_TAU_MS);
        const visibleNow = remTime>0?(modeledNow+slewNow):pkt;
        const driftSec = Math.abs(pkt-visibleNow)*DUR;
        if(remTime===0 || driftSec>SEEK_SNAP_SEC){ remProg=pkt; remTime=now; remSlew=0; }
        else { remProg=pkt; remTime=now; remSlew=visibleNow-pkt; }
      }
      nextPkt += PKT_MS;
    }
    const v = visibleAt(now);
    if(lastVisible!=null){ const back=(lastVisible-v)*DUR; if(back>maxBack) maxBack=back; }
    lastVisible=v;
  }
  return maxBack; // seconds of largest backward visual step
}

console.log('Largest BACKWARD visual step (seconds) — 6min track, 120s, 10Hz+jitter');
console.log('rate    OLD algo        NEW algo');
let worstNew = 0, reproduced = false;
for (const r of [0.90, 0.94, 0.97, 1.03, 1.06]) {
  RATE = r; seed = 12345;            // reset jitter per run for comparability
  const oldBack = run('old');
  seed = 12345;
  const newBack = run('new');
  if (oldBack > 0.5) reproduced = true;
  if (newBack > worstNew) worstNew = newBack;
  const tag = oldBack > 0.5 ? '  ← sawtooth' : '';
  console.log(r.toFixed(2)+'    '+oldBack.toFixed(3)+'s         '+newBack.toFixed(3)+'s'+tag);
}
console.log('\nOLD reproduced the sawtooth (>0.5s jumps):', reproduced ? 'YES' : 'no');
console.log('NEW worst backward step across all rates:', worstNew.toFixed(3)+'s',
            worstNew < 0.05 ? '→ FIXED ✅ (imperceptible)' : '→ still jumps ❌');
