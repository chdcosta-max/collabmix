// Local-capture session log. Sits alongside Sentry telemetry (not in place of
// it) — every call into utils/telemetry.js#logEvent mirrors into the in-memory
// events array here, so the existing Sentry breadcrumb pipeline is unaffected.
//
// Usage from the app: import { initSession, pushEvent, mergeSessionMeta,
// downloadSessionLog } from "./utils/sessionLog". From the browser console:
// window.__sessionLog.events, .meta, .count(), .download().

const MAX_EVENTS = 5000;

const state = {
  meta: {},
  events: [],
  initialized: false,
};

function isoNow() {
  return new Date().toISOString();
}

function safeViewport() {
  try {
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
    };
  } catch {
    return null;
  }
}

export function initSession({ release } = {}) {
  if (state.initialized) return;
  state.meta = {
    startedAt: isoNow(),
    release: release || "dev",
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
    viewport: safeViewport(),
    djName: null,
    roomCode: null,
    isHost: null,
    partnerName: null,
  };
  state.events = [];
  state.initialized = true;
  try {
    window.__sessionLog = {
      get events() { return state.events; },
      get meta() { return state.meta; },
      count() { return state.events.length; },
      download() { downloadSessionLog(); },
    };
  } catch {}
}

export function pushEvent(category, message, data) {
  if (!state.initialized) return;
  state.events.push({
    t: isoNow(),
    category: category || "unknown",
    message: message || "",
    data: data || null,
  });
  if (state.events.length > MAX_EVENTS) {
    state.events.splice(0, state.events.length - MAX_EVENTS);
  }
}

export function mergeSessionMeta(obj) {
  if (!state.initialized || !obj || typeof obj !== "object") return;
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined) state.meta[k] = obj[k];
  }
}

export function downloadSessionLog() {
  if (!state.initialized) return;
  try {
    const payload = { meta: { ...state.meta, endedAt: isoNow() }, events: state.events.slice() };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const stamp = isoNow().replace(/[:.]/g, "-");
    const room = state.meta.roomCode ? `-${state.meta.roomCode}` : "";
    const a = document.createElement("a");
    a.href = url;
    a.download = `mixsync-session-${stamp}${room}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    try { console.error("[sessionLog] download failed", e); } catch {}
  }
}
