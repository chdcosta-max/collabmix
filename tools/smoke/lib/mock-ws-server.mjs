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

export function startMockServer({ port = 8090, log = false } = {}) {
  const rooms = new Map();
  // netem state is a no-op in Commit 1 (installed in Commit 2). Outbound sends go
  // through emit() so the network-emulation layer has a single seam to wrap.
  const netem = makeNoopNetem();

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
      res.end(JSON.stringify({ status: "ok", mock: true, rooms: rooms.size, djs: djCount, uptime: process.uptime() }));
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
      if (log) console.log(`[mock] WS  → ws://localhost:${port}\n[mock] HTTP → http://localhost:${port}/health`);
      resolve({
        port,
        url: `ws://localhost:${port}`,
        netem,
        close: () => new Promise((r) => { try { wss.close(); httpServer.close(() => r()); } catch { r(); } }),
      });
    });
  });
}

// Commit-1 placeholder: sends immediately, never drops. The network-emulation
// layer (latency / jitter / loss / reorder, seeded) replaces this in Commit 2.
function makeNoopNetem() {
  return {
    send(ws, payload /*, ctx */) { try { ws.send(payload); } catch {} },
    configure() {},
  };
}

// CLI entry: `node tools/smoke/lib/mock-ws-server.mjs [port]` for manual use.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2]) || 8090;
  startMockServer({ port, log: true });
}
