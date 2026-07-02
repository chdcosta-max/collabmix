// turn-jitter-proxy.mjs — UNPRIVILEGED jitter harness (no sudo, no pf/dummynet).
// A local UDP forwarder in front of the real TURN server. Point the app's TURN
// config at it and force relay:
//
//   node tools/netem/turn-jitter-proxy.mjs &                     # proxy on :3479, control on :3480
//   VITE_TURN_URLS="turn:127.0.0.1:3479" npm run dev             # process env beats .env.local
//   … open two tabs with ?ice=relay → all media transits the proxy twice
//     (tabA→proxy→TURN on A's leg, TURN→proxy→tabB on B's leg)
//
// Shaping is applied ONLY to media frames (TURN ChannelData 0x40–0x7F + STUN
// Send/Data indications) — allocation/refresh/binding control stays crisp, so
// the connection always establishes; the run script turns shaping on once
// [ICE-PATH] confirms relay. Because media crosses the proxy twice, EFFECTIVE
// added delay ≈ 2× the per-crossing profile and effective loss ≈ 2× plr —
// calibrate empirically via the self-verify run, then FREEZE the profile.
//
// Deterministic: seeded PRNG (mulberry32) + a square-wave delay keyed to
// shaping-on time. Same profile+seed = same statistical jitter every run (the
// same guarantee dummynet's toggling gives — packet-exact timing is not
// reproducible in either).
//
// Control (HTTP 127.0.0.1:3480):
//   POST /shape {"highMs":75,"lowMs":20,"periodMs":600,"plr":0.005,"noiseMs":10,"seed":1}
//   POST /shape {"off":true}
//   GET  /shape   → current profile + counters
//
// Optional "bwKbps" (+ "maxQueueMs", default 800) adds a per-leg bandwidth cap
// with a virtual-clock queue: queueing delay BUILDS when the stream's byte rate
// exceeds the cap and drains when it doesn't (tail-drop past maxQueueMs). This
// models LOAD-DEPENDENT jitter — the congested-WiFi mechanism ?audiolite
// actually targets — which a fixed delay toggle (exogenous jitter) cannot show
// by construction: no bitrate change can affect a delay the shaper adds
// regardless of load.
//
// Scope: only traffic the app explicitly sends to 127.0.0.1:3479. Nothing else
// on the machine is touched; Ctrl-C leaves zero residue.
import dgram from "node:dgram";
import http from "node:http";
import { lookup } from "node:dns/promises";

const LISTEN_PORT = parseInt(process.env.PROXY_PORT || "3479", 10);
const CTRL_PORT = parseInt(process.env.CTRL_PORT || "3480", 10);
const UPSTREAM_HOST = process.env.TURN_HOST || "global.relay.metered.ca";
const UPSTREAM_PORT = parseInt(process.env.TURN_PORT || "80", 10);

const upstream = { address: (await lookup(UPSTREAM_HOST, { family: 4 })).address, port: UPSTREAM_PORT };
console.log(`[proxy] upstream TURN ${UPSTREAM_HOST} → ${upstream.address}:${upstream.port}`);

// ── deterministic shaping ────────────────────────────────────────────────────
let shape = null; // {highMs,lowMs,periodMs,plr,noiseMs,seed,t0}
let rnd = null;
const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const stats = { media: 0, mediaBytes: 0, control: 0, dropped: 0, qDropped: 0, delayedMs: 0, shapedPkts: 0, qMsMax: 0, t0: 0 };

const isMedia = (buf) => {
  if (buf.length < 4) return false;
  const b0 = buf[0];
  if ((b0 & 0xc0) === 0x40) return true;                    // TURN ChannelData
  const type = (buf[0] << 8) | buf[1];                      // STUN Send/Data indication
  return type === 0x0016 || type === 0x0017;
};

const currentDelay = () => {
  const t = Date.now() - shape.t0;
  const half = shape.periodMs / 2;
  const base = t % shape.periodMs < half ? shape.highMs : shape.lowMs;
  const noise = shape.noiseMs ? (rnd() - 0.5) * 2 * shape.noiseMs : 0;
  return Math.max(0, base + noise);
};

// forward with shaping — media only, and only while a profile is active.
// `leg` is the virtual-clock state for this direction (bwKbps queue model);
// it also accumulates per-leg byte/packet counts so GET /shape can report the
// per-stream wire rate (the silent partner legs vs the music leg).
const send = (sock, buf, port, address, leg) => {
  if (!shape || !isMedia(buf)) {
    if (shape) stats.control++;
    sock.send(buf, port, address);
    return;
  }
  stats.media++; stats.mediaBytes += buf.length;
  if (leg) { leg.pkts = (leg.pkts || 0) + 1; leg.bytes = (leg.bytes || 0) + buf.length; }
  if (shape.plr && rnd() < shape.plr) { stats.dropped++; return; }
  let d = currentDelay();
  if (shape.bwKbps && leg) {
    const now = Date.now();
    const txMs = (buf.length * 8) / shape.bwKbps;
    const depart = Math.max(now, leg.clock) + txMs;
    const qMs = depart - now;
    if (qMs > (shape.maxQueueMs ?? 800)) { stats.dropped++; stats.qDropped++; return; } // tail-drop: queue full
    leg.clock = depart;
    d += qMs;
    stats.qMsMax = Math.max(stats.qMsMax, qMs);
  }
  stats.shapedPkts++; stats.delayedMs += d;
  setTimeout(() => { try { sock.send(buf, port, address); } catch {} }, d);
};

// ── UDP forwarder: one upstream socket per client 5-tuple ────────────────────
const listener = dgram.createSocket("udp4");
const sessions = new Map(); // "addr:port" → { sock, up, down } (up/down = per-leg queue clocks)
listener.on("message", (buf, rinfo) => {
  const key = rinfo.address + ":" + rinfo.port;
  let s = sessions.get(key);
  if (!s) {
    const sock = dgram.createSocket("udp4");
    s = { sock, up: { clock: 0 }, down: { clock: 0 } };
    sock.on("message", (ubuf) => send(listener, ubuf, rinfo.port, rinfo.address, s.down));
    sock.on("error", () => { try { sock.close(); } catch {} sessions.delete(key); });
    sessions.set(key, s);
    console.log(`[proxy] new client ${key} (${sessions.size} sessions)`);
  }
  send(s.sock, buf, upstream.port, upstream.address, s.up);
});
listener.on("error", (e) => { console.error("[proxy] listener error", e.message); process.exit(1); });
listener.bind(LISTEN_PORT, "127.0.0.1", () => console.log(`[proxy] UDP listening 127.0.0.1:${LISTEN_PORT}`));

// ── control endpoint ─────────────────────────────────────────────────────────
http.createServer((req, res) => {
  if (req.url !== "/shape") { res.writeHead(404); res.end(); return; }
  if (req.method === "GET") {
    const secs = stats.t0 ? (Date.now() - stats.t0) / 1000 : 0;
    const legs = {};
    for (const [k, s] of sessions) {
      legs[k] = {
        upKbps: secs > 0 ? +((s.up.bytes || 0) * 8 / 1000 / secs).toFixed(1) : 0, upPkts: s.up.pkts || 0,
        downKbps: secs > 0 ? +((s.down.bytes || 0) * 8 / 1000 / secs).toFixed(1) : 0, downPkts: s.down.pkts || 0,
      };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ shape, stats, sessions: sessions.size, legs }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const p = JSON.parse(body || "{}");
      if (p.off) {
        shape = null; rnd = null;
        console.log("[proxy] shaping OFF");
      } else {
        shape = { highMs: p.highMs ?? 75, lowMs: p.lowMs ?? 20, periodMs: p.periodMs ?? 600,
                  plr: p.plr ?? 0, noiseMs: p.noiseMs ?? 0, seed: p.seed ?? 1,
                  bwKbps: p.bwKbps ?? 0, maxQueueMs: p.maxQueueMs ?? 800, t0: Date.now() };
        rnd = mulberry32(shape.seed);
        for (const k of Object.keys(stats)) stats[k] = 0;
        stats.t0 = Date.now();
        // reset per-leg counters too — stale sessions from a previous run would
        // otherwise report phantom rates against the new window
        for (const s of sessions.values()) { s.up.pkts = s.up.bytes = 0; s.down.pkts = s.down.bytes = 0; }
        console.log("[proxy] shaping ON " + JSON.stringify(shape));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, shape }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
  });
}).listen(CTRL_PORT, "127.0.0.1", () => console.log(`[proxy] control http://127.0.0.1:${CTRL_PORT}/shape`));

setInterval(() => {
  if (shape) {
    const secs = (Date.now() - stats.t0) / 1000;
    const kbps = secs > 0 ? (stats.mediaBytes * 8 / 1000 / secs).toFixed(0) : "?";
    console.log(`[proxy] media=${stats.media} (${kbps}kbps all legs) dropped=${stats.dropped} (queue=${stats.qDropped}) control=${stats.control} avgDelay=${stats.shapedPkts ? (stats.delayedMs / stats.shapedPkts).toFixed(0) : 0}ms qMax=${stats.qMsMax.toFixed(0)}ms sessions=${sessions.size}`);
  }
}, 5000).unref();
