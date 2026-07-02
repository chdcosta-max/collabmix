// mock-ws-server.mjs — a LOCAL, protocol-exact stand-in for the production
// COLLAB//MIX sync server (../../collabmix-server-repo/server.js), built for the
// smoke suite.
//
// WHY THIS EXISTS
// The e2e smoke tests connect every two-client run to the SHARED PRODUCTION WS
// server. That server runs on a fast, clean network during tests, so the
// conditions that actually break the app — latency, jitter, packet loss, message
// reordering, sparse progress packets — never occur in the gate. The mirror /
// stale-position bug class (backward slews, rapid-toggle snaps, self-pause near
// track-end, mirror-under-latency) lives in exactly those conditions, so the
// production gate is structurally BLIND to it (VISION_5 "NEXT INFRA PRIORITY").
//
// This mock speaks the identical wire protocol but runs on localhost and (in
// Commit 2) lets a test inject those conditions DETERMINISTICALLY. The relay
// logic below is a near-verbatim copy of server.js — KEEP IN SYNC if the real
// server's protocol changes (join / deck_update / xfade / master_vol / chat /
// sync_request|response / ping / rtc_* / seek|toggle|cue_request / sync_ping|pong
// / deck_driver_change / close-cleanup).
//
// SCOPE BOUNDARY: this mock relays the WS CONTROL plane only. Audio is
// peer-to-peer WebRTC (browser-managed) and is NOT affected by the netem layer —
// the comp / jitter-buffer tests are unchanged. The mirror bugs we target are
// driven by the WS deck_update progress packets, which this mock fully controls.

import { WebSocketServer } from "ws";
import http from "node:http";

// ── room model (verbatim shape from server.js) ──────────────────────────────
let djCounter = 0;
function generateDjId() {
  // Deterministic-friendly: monotonic counter + fixed suffix (no Math.random, so
  // a smoke run is reproducible). The real server uses a random suffix, but
  // clients only require djId UNIQUENESS, which the counter already guarantees.
  return `dj_${++djCounter}_mock`;
}

export function startMockServer({ port = 8090, log = false, netem: netemInit = {} } = {}) {
  const rooms = new Map();
  // Deterministic network-emulation layer. Every server→client message flows
  // through netem.send() (the single outbound seam below), so latency / jitter /
  // loss / reordering apply at exactly one place. Reconfigurable live via the
  // POST /netem control endpoint so a test can ramp conditions mid-run.
  const netem = makeNetem(netemInit);

  function getRoomOrCreate(roomId) {
    if (!rooms.has(roomId)) {
      rooms.set(roomId, { djs: new Map(), deckDrivers: { A: null, B: null } });
    }
    return rooms.get(roomId);
  }
  function getPartner(room, djId) {
    for (const [id, dj] of room.djs) if (id !== djId) return { id, ...dj };
    return null;
  }
  // Single outbound seam. Every server→client message flows through here, so the
  // netem layer (Commit 2) can delay / drop / reorder at exactly one place.
  function emit(ws, message, ctx) {
    if (!ws || ws.readyState !== ws.OPEN) return;
    netem.send(ws, JSON.stringify(message), ctx);
  }
  function sendTo(ws, message, ctx) { emit(ws, message, ctx); }
  function broadcastToRoom(room, senderId, message, ctx) {
    for (const [djId, dj] of room.djs) {
      if (djId !== senderId) emit(dj.ws, message, ctx);
    }
  }

  const httpServer = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.url === "/health") {
      const djCount = [...rooms.values()].reduce((s, r) => s + r.djs.size, 0);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", mock: true, rooms: rooms.size, djs: djCount, uptime: process.uptime(), netem: netem.config }));
      return;
    }
    // ── netem control: GET returns current conditions; POST {latencyMs, jitterMs,
    // lossPct, seed, types} reconfigures live (resets the seeded RNG). Tests drive
    // this over HTTP (they run as child processes; see lib/e2e.mjs setNetem).
    if (req.url === "/netem") {
      if (req.method === "POST") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          let next = {}; try { next = JSON.parse(body || "{}"); } catch {}
          netem.configure(next);
          if (log) console.log(`[mock][netem] ${JSON.stringify(netem.config)}`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(netem.config));
        });
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(netem.config));
      return;
    }
    res.writeHead(200); res.end("COLLAB//MIX MOCK Server");
  });

  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws) => {
    // ws.OPEN is a built-in constant (1); emit() guards on ws.readyState === ws.OPEN.
    let djId = null, roomId = null;

    ws.on("message", (raw) => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      const { type } = msg;
      const ctx = { type }; // hook for netem per-type filtering (Commit 2)

      // ── JOIN ──────────────────────────────────────────────────────────────
      if (type === "join") {
        const { roomId: rid, djName } = msg;
        if (!rid || !djName) return;
        const room = getRoomOrCreate(rid);
        if (room.djs.size >= 2) { sendTo(ws, { type: "error", msg: "Room full" }, ctx); return; }
        djId = generateDjId(); roomId = rid;
        const initialState = { deckA: {}, deckB: {}, xfade: 0.5 };
        room.djs.set(djId, { ws, name: djName, state: initialState });
        const partner = getPartner(room, djId);
        sendTo(ws, { type: "joined", djId, roomId, djName, partnerName: partner?.name || null, partnerState: partner?.state || null, deckDrivers: room.deckDrivers }, ctx);
        if (partner) sendTo(partner.ws, { type: "partner_joined", djName }, ctx);
        if (log) console.log(`[mock][join] ${djName} → room ${roomId} (${room.djs.size}/2)`);
        return;
      }

      if (!djId || !roomId) return;
      const room = rooms.get(roomId); if (!room) return;
      const me = room.djs.get(djId); if (!me) return;

      // ── DJ STATE SYNC ─────────────────────────────────────────────────────
      if (type === "deck_update") {
        const { deckId, field, value } = msg;
        const key = `deck${deckId}`;
        if (me.state[key]) me.state[key][field] = value;
        broadcastToRoom(room, djId, { ...msg, from: me.name }, ctx);
        return;
      }
      if (type === "xfade_update") {
        me.state.xfade = msg.value;
        broadcastToRoom(room, djId, { ...msg, from: me.name }, ctx);
        return;
      }
      if (type === "master_vol_update") {
        me.state.masterVol = msg.value;
        broadcastToRoom(room, djId, { ...msg, from: me.name }, ctx);
        return;
      }
      if (type === "chat") {
        const time = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
        const chatMsg = { ...msg, from: me.name, time };
        broadcastToRoom(room, djId, chatMsg, ctx);
        sendTo(ws, { ...chatMsg, self: true }, ctx);
        return;
      }
      if (type === "sync_request") {
        const partner = getPartner(room, djId);
        if (partner) sendTo(partner.ws, { ...msg, from: me.name }, ctx);
        return;
      }
      if (type === "sync_response") {
        broadcastToRoom(room, djId, { ...msg, from: me.name }, ctx);
        return;
      }
      if (type === "ping") {
        // Client↔server RTT probe. NOT subject to netem latency — the client uses
        // it as a baseline; the production server replies immediately.
        sendTo(ws, { type: "pong", clientTime: msg.clientTime, serverTime: Date.now() }, { type: "pong", bypassNetem: true });
        return;
      }

      // ── WEBRTC SIGNALING (pure relay) ─────────────────────────────────────
      if (["rtc_offer", "rtc_answer", "rtc_ice", "rtc_hangup"].includes(type)) {
        broadcastToRoom(room, djId, { ...msg, from: me.name }, ctx);
        return;
      }

      // ── TRANSPORT (pure relay) ────────────────────────────────────────────
      if (["seek_request", "toggle_request", "cue_request"].includes(type)) {
        broadcastToRoom(room, djId, { ...msg, from: me.name }, ctx);
        return;
      }

      // ── SYNC PHASE 1 clock-offset ping/pong (pure relay) ──────────────────
      if (type === "sync_ping" || type === "sync_pong") {
        broadcastToRoom(room, djId, { ...msg, from: me.name }, ctx);
        return;
      }

      // ── DRIVER CHANGE ─────────────────────────────────────────────────────
      if (type === "deck_driver_change") {
        const { deckId, driverName, track } = msg;
        if (deckId !== "A" && deckId !== "B") return;
        room.deckDrivers[deckId] = driverName ? { id: djId, name: driverName } : null;
        const driverIdOut = room.deckDrivers[deckId]?.id ?? null;
        const driverNameOut = room.deckDrivers[deckId]?.name ?? null;
        const payload = { type, deckId, driverId: driverIdOut, driverName: driverNameOut, track: track || null, from: me.name, timestamp: Date.now() };
        sendTo(ws, payload, ctx);                 // echo to sender (server-authoritative)
        broadcastToRoom(room, djId, payload, ctx);
        if (log) console.log(`[mock][driver] room=${roomId} deck=${deckId} driver=${driverNameOut}`);
        return;
      }
    });

    ws.on("close", () => {
      if (!djId || !roomId) return;
      const room = rooms.get(roomId); if (!room) return;
      const me = room.djs.get(djId);
      room.djs.delete(djId);
      for (const d of ["A", "B"]) {
        if (room.deckDrivers[d]?.id === djId) {
          room.deckDrivers[d] = null;
          broadcastToRoom(room, djId, { type: "deck_driver_change", deckId: d, driverId: null, driverName: null, from: "system", timestamp: Date.now() });
        }
      }
      broadcastToRoom(room, djId, { type: "partner_left", djName: me?.name });
      broadcastToRoom(room, djId, { type: "rtc_hangup", from: me?.name });
      if (room.djs.size === 0) rooms.delete(roomId);
      if (log) console.log(`[mock][leave] ${me?.name} left room ${roomId}`);
    });

    ws.on("error", () => {}); // a client vanishing is normal in tests
  });

  return new Promise((resolve) => {
    httpServer.listen(port, () => {
      const bound = httpServer.address().port; // resolves port 0 (ephemeral) to the real one
      if (log) console.log(`[mock] WS  → ws://localhost:${bound}\n[mock] HTTP → http://localhost:${bound}/health`);
      resolve({
        port: bound,
        url: `ws://localhost:${bound}`,
        netem,
        close: () => new Promise((r) => { try { wss.close(); httpServer.close(() => r()); } catch { r(); } }),
      });
    });
  });
}

// ── Deterministic network emulation ─────────────────────────────────────────
// Seeded PRNG (mulberry32) so a given (seed, profile, message-sequence) yields
// the EXACT same drop/delay decisions every run — a reproducible gate, not a new
// flavor of flaky. NO Math.random anywhere on the netem path.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Conditions:
//   latencyMs — base one-way delay added to every eligible relayed message.
//   jitterMs  — ± uniform random added to latency (independent per message →
//               naturally REORDERS, the real-network condition the gate lacked).
//   lossPct   — probability [0..1] an eligible message is dropped entirely.
//               High loss on deck_update = SPARSE progress packets (the
//               backgrounded-driver / stale-mirror condition) via the relay.
//   seed      — RNG seed; same seed reproduces the run exactly.
//   types     — optional array of message types the conditions apply to. null =
//               ALL relayed messages (full real-network sim). Restricting to
//               e.g. ["deck_update"] degrades only progress packets while leaving
//               join / driver / transport crisp so setup isn't disrupted.
function makeNetem(initial = {}) {
  const normalize = (c) => ({
    latencyMs: Math.max(0, +c.latencyMs || 0),
    jitterMs: Math.max(0, +c.jitterMs || 0),
    lossPct: Math.min(1, Math.max(0, +c.lossPct || 0)),
    // stall-and-flush (TCP-faithful clumping): the real WS rides TCP, which under
    // jitter/loss delivers IN-ORDER BURSTS (head-of-line hold, then flush) — the
    // independent per-message jitter above REORDERS, which TCP never does (and
    // which the mirror's reorder-drop partially masks; July 3). With stallMs +
    // stallEveryMs set, the path cycles [stallMs hold][stallEveryMs clear]:
    // messages arriving during a hold queue FIFO per-connection and flush
    // together at hold end; clear-phase messages pass with base latency only
    // (jitter is ignored in this mode — clumping IS the disturbance).
    stallMs: Math.max(0, +c.stallMs || 0),
    stallEveryMs: Math.max(0, +c.stallEveryMs || 0),
    seed: (c.seed ?? 1) >>> 0,
    types: Array.isArray(c.types) && c.types.length ? c.types.slice() : null,
  });
  let cfg = normalize(initial);
  let typeSet = cfg.types ? new Set(cfg.types) : null;
  let rng = mulberry32(cfg.seed);
  let stallT0 = Date.now();               // stall cycle phase anchor (reset on configure)
  const stallQ = new Map();               // ws → { msgs: [], timer } — per-connection FIFO
  const deliver = (ws, payload) => { try { if (ws.readyState === ws.OPEN) ws.send(payload); } catch {} };
  return {
    get config() { return { ...cfg }; },
    configure(next) {
      cfg = normalize({ ...cfg, ...next });
      typeSet = cfg.types ? new Set(cfg.types) : null;
      rng = mulberry32(cfg.seed); // re-seed on every reconfigure → deterministic from that point
      stallT0 = Date.now();
      // flush anything a previous profile left queued — never strand messages
      for (const [ws, q] of stallQ) { clearTimeout(q.timer); q.timer = null; for (const p of q.msgs.splice(0)) deliver(ws, p); }
      stallQ.clear();
    },
    send(ws, payload, ctx = {}) {
      if (!ws || ws.readyState !== ws.OPEN) return;
      // Client↔server RTT replies (ping→pong) must be immediate, like the real
      // server — they're a measurement baseline, not part of the emulated path.
      if (ctx.bypassNetem) { try { ws.send(payload); } catch {} return; }
      const stallOn = cfg.stallMs > 0 && cfg.stallEveryMs > 0;
      const eligible = !typeSet || typeSet.has(ctx.type);
      const idle = cfg.latencyMs === 0 && cfg.jitterMs === 0 && cfg.lossPct === 0 && !stallOn;
      if (!eligible || idle) { try { ws.send(payload); } catch {} return; }
      // Deterministic loss (one draw per eligible message when loss is on).
      if (cfg.lossPct > 0 && rng() < cfg.lossPct) return; // dropped
      if (stallOn) {
        const cyc = cfg.stallMs + cfg.stallEveryMs;
        const phase = (Date.now() - stallT0) % cyc;
        const inStall = phase < cfg.stallMs;   // hold-first: shaping-on shows a clump immediately
        let q = stallQ.get(ws);
        if (!q) { q = { msgs: [], timer: null }; stallQ.set(ws, q); }
        if (inStall || q.msgs.length) {        // in-order: never overtake a pending queue
          q.msgs.push(payload);
          if (!q.timer) {
            const flushIn = (inStall ? cfg.stallMs - phase : 0) + cfg.latencyMs;
            q.timer = setTimeout(() => { q.timer = null; for (const p of q.msgs.splice(0)) deliver(ws, p); }, flushIn);
          }
        } else if (cfg.latencyMs > 0) {
          setTimeout(() => deliver(ws, payload), cfg.latencyMs);
        } else {
          deliver(ws, payload);
        }
        return;
      }
      // Deterministic delay = latency ± jitter (one draw for jitter when on).
      let delay = cfg.latencyMs;
      if (cfg.jitterMs > 0) delay += (rng() * 2 - 1) * cfg.jitterMs;
      delay = Math.max(0, delay);
      if (delay === 0) { try { ws.send(payload); } catch {} return; }
      setTimeout(() => { try { if (ws.readyState === ws.OPEN) ws.send(payload); } catch {} }, delay);
    },
  };
}

// CLI entry: `node tools/smoke/lib/mock-ws-server.mjs [port]` for manual use.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2]) || 8090;
  startMockServer({ port, log: true });
}
