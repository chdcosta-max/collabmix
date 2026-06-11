import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
page.on('console', m => { if (m.text().startsWith('[PROBE]')) console.log(m.text()); });

const result = await page.evaluate(async () => {
  const log = (...a) => console.log('[PROBE]', ...a);
  // Oscillator → MediaStreamDestination = a live audio track (no mic needed).
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') { try { await ctx.resume(); } catch {} }
  const osc = ctx.createOscillator(); osc.frequency.value = 220;
  const msd = ctx.createMediaStreamDestination();
  osc.connect(msd); osc.start();

  // Loopback: pcA sends the track, pcB receives. Host candidates → connects locally.
  const pcA = new RTCPeerConnection(); const pcB = new RTCPeerConnection();
  pcA.onicecandidate = e => e.candidate && pcB.addIceCandidate(e.candidate);
  pcB.onicecandidate = e => e.candidate && pcA.addIceCandidate(e.candidate);
  let recvTrack = false;
  pcB.ontrack = (e) => {
    recvTrack = true;
    // PLAY the received track (like the app's remAudio element) so the jitter
    // buffer actually emits samples — otherwise emittedCount stays 0.
    const a = new Audio(); a.autoplay = true; a.srcObject = e.streams[0] || new MediaStream([e.track]);
    document.body.appendChild(a); a.play().catch(() => {});
  };
  msd.stream.getTracks().forEach(t => pcA.addTrack(t, msd.stream));
  const offer = await pcA.createOffer({ offerToReceiveAudio: true });
  await pcA.setLocalDescription(offer); await pcB.setRemoteDescription(offer);
  const answer = await pcB.createAnswer(); await pcB.setLocalDescription(answer);
  await pcA.setRemoteDescription(answer);

  // wait for connection
  const t0 = performance.now();
  while (pcB.iceConnectionState !== 'connected' && pcB.iceConnectionState !== 'completed') {
    if (performance.now() - t0 > 8000) { log('ICE did not connect:', pcB.iceConnectionState); break; }
    await new Promise(r => setTimeout(r, 100));
  }
  log('ICE state:', pcB.iceConnectionState, '| track received:', recvTrack);

  const samples = [];
  let fieldDump = null;
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const stats = await pcB.getStats();
    let inbound = null, remoteInbound = null, playout = null;
    stats.forEach(r => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') inbound = r;
      if (r.type === 'remote-inbound-rtp' && r.kind === 'audio') remoteInbound = r;
      if (r.type === 'media-playout') playout = r;
    });
    if (inbound) {
      if (!fieldDump) fieldDump = Object.keys(inbound).filter(k => /jitter|delay|playout|packet|emitted|target/i.test(k));
      const avgJbMs = inbound.jitterBufferEmittedCount > 0
        ? (inbound.jitterBufferDelay / inbound.jitterBufferEmittedCount) * 1000 : null;
      const targetMs = (inbound.jitterBufferTargetDelay != null && inbound.jitterBufferEmittedCount > 0)
        ? (inbound.jitterBufferTargetDelay / inbound.jitterBufferEmittedCount) * 1000 : null;
      const minMs = (inbound.jitterBufferMinimumDelay != null && inbound.jitterBufferEmittedCount > 0)
        ? (inbound.jitterBufferMinimumDelay / inbound.jitterBufferEmittedCount) * 1000 : null;
      const playoutMs = (playout && playout.totalPlayoutDelay != null && playout.totalSamplesCount > 0)
        ? (playout.totalPlayoutDelay / playout.totalSamplesCount) * 1000 : null;
      const procMs = (inbound.totalProcessingDelay != null && inbound.jitterBufferEmittedCount > 0)
        ? (inbound.totalProcessingDelay / inbound.jitterBufferEmittedCount) * 1000 : null;
      samples.push({ avgJbMs, targetMs, minMs, playoutMs,
        rtt: remoteInbound?.roundTripTime ?? null, jitter: inbound.jitter ?? null,
        pkts: inbound.packetsReceived });
      log(`t${i}: avgJitterBuf=${avgJbMs?.toFixed(1)}ms target=${targetMs?.toFixed(1)}ms min=${minMs?.toFixed(1)}ms proc=${procMs?.toFixed(1)}ms playout=${playoutMs?.toFixed(1)}ms emitted=${inbound.jitterBufferEmittedCount} pkts=${inbound.packetsReceived}`);
    } else {
      log(`t${i}: no inbound-rtp audio report yet`);
    }
  }
  log('inbound-rtp audio fields available:', JSON.stringify(fieldDump));
  return { connected: pcB.iceConnectionState, samples, fieldDump };
});

console.log('\n==== SUMMARY ====');
console.log('ICE:', result.connected);
console.log('Available jitter/delay fields:', JSON.stringify(result.fieldDump));
const valid = result.samples.filter(s => s.avgJbMs != null);
if (valid.length) {
  const last = valid[valid.length - 1];
  console.log('Last sample: avgJitterBuf=' + last.avgJbMs?.toFixed(1) + 'ms target=' + last.targetMs?.toFixed(1) + 'ms playout=' + (last.playoutMs?.toFixed(1) ?? 'n/a') + 'ms');
  console.log('MEASURABLE:', last.avgJbMs > 0 ? 'YES ✅' : 'reports 0 (silent/DTX?)');
} else {
  console.log('No usable jitter-buffer numbers — see notes.');
}
await browser.close();
