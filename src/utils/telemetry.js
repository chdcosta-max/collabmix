import * as Sentry from "@sentry/react";
import { pushEvent, mergeSessionMeta } from "./sessionLog.js";

export function logEvent(category, message, data) {
  try {
    Sentry.addBreadcrumb({
      category,
      message,
      level: "info",
      data: data || undefined,
      timestamp: Date.now() / 1000,
    });
  } catch {}
  try { pushEvent(category, message, data); } catch {}
}

export function setSessionContext({ djName, roomCode, ping, isHost, partnerName } = {}) {
  try {
    if (djName != null) Sentry.setTag("dj_name", String(djName));
    if (roomCode != null) Sentry.setTag("room_code", String(roomCode));
    if (typeof isHost === "boolean") Sentry.setTag("is_host", isHost ? "true" : "false");
    Sentry.setContext("session", {
      djName: djName ?? null,
      roomCode: roomCode ?? null,
      ping: ping ?? null,
      isHost: typeof isHost === "boolean" ? isHost : null,
      partnerName: partnerName ?? null,
    });
  } catch {}
  try { mergeSessionMeta({ djName, roomCode, ping, isHost, partnerName }); } catch {}
}

export function captureHandledError(error, context) {
  try {
    Sentry.withScope((scope) => {
      if (context && typeof context === "object") {
        scope.setContext("handled_error_context", context);
        if (context.operation) scope.setTag("operation", String(context.operation));
      }
      scope.setLevel("warning");
      Sentry.captureException(error);
    });
  } catch {}
  try {
    pushEvent("error", "handled_error", {
      operation: context?.operation || null,
      message: error?.message || String(error),
    });
  } catch {}
}
