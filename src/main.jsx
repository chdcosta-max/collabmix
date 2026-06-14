import * as Sentry from "@sentry/react";
import { initSession, pushEvent, downloadSessionLog } from "./utils/sessionLog.js";

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN || "https://250727774480086ad89445a3d938a223@o4511385896943616.ingest.us.sentry.io/4511385926107137",
  integrations: [
    Sentry.browserTracingIntegration(),
    Sentry.replayIntegration({
      maskAllText: false,
      maskAllInputs: true,
      blockAllMedia: false,
    }),
  ],
  // Session Replay DISABLED (June 13) — its quota was exhausted (the 429s in Jake's
  // logs). Errors/logs/performance are the priority; Replay is a bonus. Re-enable by
  // bumping these once the Replay quota resets or the plan is upgraded.
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
  // Performance: 20% (was 1.0, which was also burning the transactions quota).
  // Error capture is unaffected by this — errors are always sent.
  tracesSampleRate: 0.2,
  ignoreErrors: [
    /extension/i,
    /chrome-extension/i,
    "ResizeObserver loop limit exceeded",
    "ResizeObserver loop completed with undelivered notifications",
    "NetworkError when attempting to fetch resource",
    "Failed to fetch",
    "AbortError",
    "The user aborted a request",
  ],
  sendDefaultPii: false,
  environment: import.meta.env.MODE,
  release: import.meta.env.VITE_SENTRY_RELEASE || "dev",
  beforeSend(event, hint) {
    if (window.location.hostname === "localhost") return null;
    return event;
  },
});

initSession({ release: import.meta.env.VITE_SENTRY_RELEASE || "dev" });

try {
  window.addEventListener("error", (e) => {
    pushEvent("error", "window_error", {
      message: e?.message || null,
      source: e?.filename || null,
      lineno: e?.lineno ?? null,
      colno: e?.colno ?? null,
    });
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e?.reason;
    pushEvent("error", "unhandled_rejection", {
      message: reason?.message || String(reason || ""),
    });
  });
  // Cmd+Option+L (macOS) / Ctrl+Alt+L (Win/Linux) — download session log.
  // Capture phase + e.code keep this robust against layout + descendant
  // listeners. Strict exact-match modifiers prevent accidental triggers on
  // adjacent combos and avoid preventDefault on any other shortcut.
  window.addEventListener("keydown", (e) => {
    if (
      (e.metaKey || e.ctrlKey) &&
      e.altKey === true &&
      e.shiftKey === false &&
      e.code === "KeyL"
    ) {
      e.preventDefault();
      downloadSessionLog();
    }
  }, { capture: true });
  try { console.log("[sessionLog] download shortcut: Cmd+Option+L (Ctrl+Alt+L on Win/Linux)"); } catch {}
} catch {}

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import CollabMix from './collabmix-production.jsx'

function Root() {
  const params = new URLSearchParams(window.location.search);
  const hasRoomParam = params.has("room");
  return <CollabMix initialPage={hasRoomParam ? "lobby" : "landing"} />
}

function ErrorFallback() {
  return (
    <div style={{
      position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
      background: "#0a0a0a", color: "#e6e6e6", fontFamily: "'DM Mono', monospace", padding: 24,
    }}>
      <div style={{
        maxWidth: 420, width: "100%", textAlign: "center",
        background: "#141414", border: "1px solid #2a2a2a", borderRadius: 12, padding: "32px 28px",
      }}>
        <div style={{
          fontFamily: "'Cormorant Garamond', serif", fontSize: 28, marginBottom: 12, color: "#f0f0f0",
        }}>Something went wrong</div>
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 24, lineHeight: 1.5 }}>
          An unexpected error occurred. The error has been reported.
        </div>
        <button
          onClick={() => window.location.reload()}
          style={{
            background: "#5B8FF9", color: "#0a0a0a", border: "none", borderRadius: 6,
            padding: "10px 22px", fontFamily: "'DM Mono', monospace", fontSize: 12,
            letterSpacing: 1, cursor: "pointer", textTransform: "uppercase", fontWeight: 600,
          }}
        >Try again</button>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<ErrorFallback />} showDialog={false}>
      <Root />
    </Sentry.ErrorBoundary>
  </StrictMode>,
)
