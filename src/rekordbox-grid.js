// rekordbox-grid.js — pure beat-grid math for the rekordbox.xml import (Door 3).
// Separated from the DOM parsing in library-app.jsx so it is node-testable
// (the DOM querying needs a browser). One source of truth for "where the
// rekordbox grid says the beats are".

// Build beatTimes (sec) from rekordbox TEMPO anchors. Anchors are
// { inizio (start sec), bpm }. rekordbox supports tempo CHANGES → multiple
// anchors; build piecewise (each anchor's segment steps by that segment's
// period). Single anchor → anchor + k·period across the whole track. Returns
// null if there aren't ≥2 usable beats.
export function beatTimesFromAnchors(anchors, durationSec) {
  const tempos = (anchors || [])
    .filter((t) => t && t.bpm > 0 && isFinite(t.inizio))
    .map((t) => ({ inizio: Math.max(0, t.inizio), bpm: t.bpm }))
    .sort((a, b) => a.inizio - b.inizio);
  if (!tempos.length || !(durationSec > 0)) return null;
  const beats = [];
  const MAX = 100000; // safety cap (3h @ 200bpm ≈ 36k)
  for (let i = 0; i < tempos.length && beats.length < MAX; i++) {
    const period = 60 / tempos[i].bpm;
    if (!(period > 0)) continue;
    const segStart = tempos[i].inizio;
    const segEnd = i + 1 < tempos.length ? tempos[i + 1].inizio : durationSec;
    for (let bt = segStart; bt < segEnd - 1e-6 && beats.length < MAX; bt += period) {
      if (bt >= -1e-6 && bt <= durationSec + 1e-6) beats.push(+bt.toFixed(4));
    }
  }
  if (beats.length < 2) return null;
  return {
    beatTimes: beats,
    firstBar1AnchorSec: tempos[0].inizio,
    beatPeriodSec: 60 / tempos[0].bpm,
    multiTempo: tempos.length > 1,
  };
}
