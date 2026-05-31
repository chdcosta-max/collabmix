// ─────────────────────────────────────────────────────────────────────────
//  Mix//Sync — /diagnose
//
//  Phase 3 analyzer diagnostic, standalone app sharing the same
//  `cm_music_library` IndexedDB as the mixer and the library app via
//  src/utils/storage.js.
//
//  COMMIT 1 SCOPE — bones only.
//  --------------------------
//  Walk every track in IDB, probe whether the underlying file is silently
//  resolvable (OPFS / handle with granted permission / legacy {id,file} /
//  no-handle), and dump the stored metadata. NO worker invocation, NO
//  measurement pass, NO download — those come in later commits.
//
//  READ-ONLY across the board: this app issues zero writes to IDB / OPFS /
//  the worker source / the mixer's import path. Per the Phase 3 plan, the
//  diagnostic must be safe to run alongside the live mixer with no risk
//  of corrupting library state.
//
//  Silent probe only. We call `queryPermission` to learn whether a handle
//  is already granted; we explicitly do NOT call `requestPermission` (which
//  needs per-handle user gestures and would derail a batch walk over 100+
//  tracks). Tracks in the "prompt" state are reported as needs-grant so
//  Commit 2's measurement pass can decide how to handle them.
// ─────────────────────────────────────────────────────────────────────────
import { useState, useCallback, useMemo } from "react";
import {
  openCmDB,
  dbGetAll,
  dbGet,
  resolveHandleRecord,
  opfsGet,
  CM_DB_NAME,
  CM_DB_VER,
} from "./utils/storage.js";

// ── Visual constants (Quiet Pro Tool — DESIGN_PHILOSOPHY.md) ─────────────
const BG          = "#000000";
const PANEL       = "#0D0F12";
const TEXT        = "#F5F5F7";
const TEXT_2      = "rgba(255,255,255,0.6)";
const TEXT_3      = "rgba(255,255,255,0.3)";
const BORDER      = "rgba(255,255,255,0.06)";
const BORDER_2    = "rgba(255,255,255,0.12)";
const STATUS_OK   = "#22c55e";
const STATUS_WARN = "#f59e0b";
const STATUS_BAD  = "#ef4444";
const FONT        = "'Inter',sans-serif";
const MONO        = "'JetBrains Mono','SF Mono',ui-monospace,monospace";

// ── Silent resolution probe ──────────────────────────────────────────────
// Returns the outcome and the source path used. Per Commit 1 plan, no
// requestPermission call — only queryPermission, which is silent in all
// modern browsers (returns synchronously-ish without prompting).
async function probeResolution(track) {
  const id = track.id;
  try {
    const f = await opfsGet(id);
    if (f) return { state: "yes", source: "opfs" };
  } catch { /* OPFS probe non-fatal, fall through to handle path */ }

  let rec;
  try { rec = await dbGet("handles", id); }
  catch (e) { return { state: "no", source: "error", detail: "handle-read-failed: " + (e?.message || e) }; }
  if (!rec) return { state: "no", source: "no-record" };

  const resolved = resolveHandleRecord(rec);
  if (!resolved) return { state: "no", source: "no-record" };
  if (resolved.file) return { state: "yes", source: "legacy-file" };

  if (resolved.handle) {
    try {
      const perm = await resolved.handle.queryPermission({ mode: "read" });
      if (perm === "granted") return { state: "yes", source: "handle-granted" };
      if (perm === "prompt")  return { state: "grant", source: "handle-prompt" };
      if (perm === "denied")  return { state: "no", source: "handle-denied" };
      return { state: "no", source: "handle-unknown", detail: "queryPermission=" + perm };
    } catch (e) {
      return { state: "no", source: "handle-error", detail: e?.message || String(e) };
    }
  }
  return { state: "no", source: "orphan-handle" };
}

// ── Tiny presentation helpers ────────────────────────────────────────────
const sourceLabel = {
  "opfs":            "OPFS",
  "handle-granted":  "Handle · granted",
  "handle-prompt":   "Handle · needs grant",
  "handle-denied":   "Handle · denied",
  "handle-unknown":  "Handle · unknown",
  "handle-error":    "Handle · error",
  "legacy-file":     "Legacy File",
  "no-record":       "No record",
  "orphan-handle":   "Orphan record",
  "error":           "Read failed",
};

function StateBadge({ state }) {
  const color = state === "yes" ? STATUS_OK : state === "grant" ? STATUS_WARN : STATUS_BAD;
  const label = state === "yes" ? "Resolvable" : state === "grant" ? "Needs grant" : "Unresolvable";
  return (
    <span style={{
      display: "inline-block", padding: "1px 8px", fontSize: 10, letterSpacing: 0.3,
      color, border: `1px solid ${color}55`, borderRadius: 3, background: color + "10",
      fontFamily: FONT, whiteSpace: "nowrap",
    }}>{label}</span>
  );
}

// ── Main component ───────────────────────────────────────────────────────
export default function DiagnoseApp() {
  const [phase, setPhase]       = useState("idle"); // 'idle' | 'walking' | 'done' | 'error'
  const [rows, setRows]         = useState([]);
  const [progress, setProgress] = useState(null);
  const [error, setError]       = useState(null);

  const walk = useCallback(async () => {
    setPhase("walking");
    setError(null);
    setRows([]);
    setProgress({ done: 0, total: 0 });
    try {
      await openCmDB();
      const tracks = await dbGetAll("tracks");
      setProgress({ done: 0, total: tracks.length });
      if (tracks.length === 0) {
        setPhase("done");
        return;
      }
      const out = [];
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        const probe = await probeResolution(t);
        out.push({
          id:            t.id,
          title:         t.title || t.filename || "(untitled)",
          artist:        t.artist || "",
          bpm:           typeof t.bpm === "number" ? t.bpm : null,
          key:           t.key || null,
          duration:      typeof t.duration === "number" ? t.duration : null,
          energy:        t.energy || null,
          analyzed:      !!t.analyzed,
          errored:       !!t.error,
          gridAnchorSec: t.gridAnchorSec ?? null,
          bpmOverride:   t.bpmOverride ?? null,
          folderId:      t.folderId || null,
          probe,
        });
        if ((i % 10) === 9 || i === tracks.length - 1) {
          setRows([...out]);
          setProgress({ done: i + 1, total: tracks.length });
        }
      }
      setPhase("done");
    } catch (e) {
      console.error("[DIAGNOSE-WALK-ERROR]", e);
      setError(e?.message || String(e));
      setPhase("error");
    }
  }, []);

  const summary = useMemo(() => {
    if (rows.length === 0) return null;
    let analyzed = 0, errored = 0;
    let resOk = 0, resGrant = 0, resNo = 0;
    const sourceCounts = {};
    let withAnchor = 0, withOverride = 0, withBpm = 0, withKey = 0;
    for (const r of rows) {
      if (r.analyzed) analyzed++;
      if (r.errored)  errored++;
      if (r.probe.state === "yes")        resOk++;
      else if (r.probe.state === "grant") resGrant++;
      else                                resNo++;
      sourceCounts[r.probe.source] = (sourceCounts[r.probe.source] || 0) + 1;
      if (r.gridAnchorSec != null) withAnchor++;
      if (r.bpmOverride   != null) withOverride++;
      if (r.bpm           != null) withBpm++;
      if (r.key)                   withKey++;
    }
    return {
      total: rows.length,
      analyzed, errored,
      resOk, resGrant, resNo,
      sourceCounts,
      withAnchor, withOverride, withBpm, withKey,
    };
  }, [rows]);

  return (
    <div style={{
      minHeight: "100vh", background: BG, color: TEXT,
      fontFamily: FONT, padding: "32px 28px 80px",
    }}>
      {/* Header */}
      <div style={{ maxWidth: 1240, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
          <div style={{ fontSize: 22, letterSpacing: 0.3 }}>Analyzer diagnostic</div>
          <div style={{ fontSize: 11, color: TEXT_3, letterSpacing: 0.4, fontFamily: MONO }}>
            Phase 3 · Commit 1
          </div>
        </div>
        <div style={{ fontSize: 12, color: TEXT_2, letterSpacing: 0.2, lineHeight: 1.55, maxWidth: 720 }}>
          Read-only walk of <span style={{ fontFamily: MONO }}>{CM_DB_NAME}</span> (v{CM_DB_VER}). Dumps stored
          per-track metadata and probes whether the underlying audio file is silently resolvable. No worker
          invocation, no measurement, no IDB writes this commit.
        </div>

        {/* Run button + progress */}
        <div style={{ marginTop: 28, display: "flex", alignItems: "center", gap: 18 }}>
          <button onClick={walk} disabled={phase === "walking"}
            style={{
              padding: "9px 20px", fontSize: 13, fontFamily: FONT,
              background: phase === "walking" ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.06)",
              border: "1px solid " + (phase === "walking" ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.18)"),
              color: phase === "walking" ? TEXT_3 : TEXT,
              borderRadius: 5, cursor: phase === "walking" ? "default" : "pointer",
              letterSpacing: 0.3, outline: "none",
              transition: "all 150ms cubic-bezier(0.4, 0, 0.2, 1)",
            }}
            onMouseEnter={e => { if (phase !== "walking") { e.currentTarget.style.background = "rgba(255,255,255,0.10)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.30)"; } }}
            onMouseLeave={e => { if (phase !== "walking") { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.18)"; } }}>
            {phase === "walking" ? "Walking…" : phase === "done" ? "Re-run walk" : "Walk library"}
          </button>
          {progress && (
            <div style={{ fontSize: 12, color: TEXT_2, fontFamily: MONO, letterSpacing: 0.2 }}>
              {progress.done} / {progress.total} tracks probed
            </div>
          )}
          {error && (
            <div style={{ fontSize: 12, color: STATUS_BAD, fontFamily: MONO, letterSpacing: 0.2 }}>
              Error: {error}
            </div>
          )}
        </div>

        {/* Summary stats */}
        {summary && (
          <div style={{
            marginTop: 28, padding: "16px 18px",
            background: "rgba(255,255,255,0.025)",
            border: "1px solid " + BORDER_2, borderRadius: 6,
            display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 18,
            fontFamily: FONT,
          }}>
            <Stat label="Total tracks"    value={summary.total} />
            <Stat label="Analyzed"        value={`${summary.analyzed} / ${summary.total}`} />
            <Stat label="Errored"         value={summary.errored} tone={summary.errored ? "bad" : "ok"} />
            <Stat label="Has stored BPM"  value={`${summary.withBpm} / ${summary.total}`} />
            <Stat label="Has stored key"  value={`${summary.withKey} / ${summary.total}`} />
            <Stat label="gridAnchorSec"   value={summary.withAnchor} />
            <Stat label="bpmOverride"     value={summary.withOverride} />
            <Stat label="Resolvable"
              value={`${summary.resOk} ok · ${summary.resGrant} grant · ${summary.resNo} no`}
              tone={summary.resNo ? "warn" : "ok"} />
            <SourceBreakdown counts={summary.sourceCounts} />
          </div>
        )}

        {/* Results table */}
        {rows.length > 0 && (
          <div style={{ marginTop: 28, border: "1px solid " + BORDER_2, borderRadius: 6, overflow: "hidden" }}>
            <table style={{
              width: "100%", borderCollapse: "collapse", background: PANEL,
              fontSize: 11, fontFamily: FONT,
            }}>
              <thead>
                <tr style={{ background: "rgba(255,255,255,0.03)" }}>
                  <Th>#</Th>
                  <Th>Title</Th>
                  <Th>Artist</Th>
                  <Th align="right">BPM</Th>
                  <Th>Key</Th>
                  <Th align="right">Dur</Th>
                  <Th>Analyzed</Th>
                  <Th align="right">gridAnchorSec</Th>
                  <Th align="right">bpmOverride</Th>
                  <Th>File</Th>
                  <Th>Source</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <Row key={r.id} r={r} i={i} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Empty state after walk */}
        {phase === "done" && rows.length === 0 && (
          <div style={{ marginTop: 40, fontSize: 13, color: TEXT_2, letterSpacing: 0.2 }}>
            No tracks in IDB. Import some tracks via the mixer first, then re-run the walk.
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }) {
  const color = tone === "bad" ? STATUS_BAD : tone === "warn" ? STATUS_WARN : TEXT;
  return (
    <div>
      <div style={{ fontSize: 10, color: TEXT_3, letterSpacing: 0.4, marginBottom: 4, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 15, color, letterSpacing: 0.2, fontFamily: MONO }}>{value}</div>
    </div>
  );
}

function SourceBreakdown({ counts }) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return (
    <div style={{ gridColumn: "span 4" }}>
      <div style={{ fontSize: 10, color: TEXT_3, letterSpacing: 0.4, marginBottom: 6, textTransform: "uppercase" }}>Resolution source breakdown</div>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
        {entries.map(([src, n]) => (
          <div key={src} style={{ fontSize: 11, color: TEXT_2, fontFamily: MONO, letterSpacing: 0.2 }}>
            <span style={{ color: TEXT }}>{n}</span> {sourceLabel[src] || src}
          </div>
        ))}
      </div>
    </div>
  );
}

function Th({ children, align = "left" }) {
  return (
    <th style={{
      textAlign: align, padding: "10px 12px",
      fontSize: 10, fontWeight: 500, color: TEXT_3, letterSpacing: 0.4,
      textTransform: "uppercase", borderBottom: "1px solid " + BORDER_2,
      whiteSpace: "nowrap",
    }}>{children}</th>
  );
}

function Td({ children, align = "left", mono = false, color }) {
  return (
    <td style={{
      textAlign: align, padding: "8px 12px",
      color: color || TEXT_2, fontSize: 11,
      fontFamily: mono ? MONO : FONT,
      borderBottom: "1px solid " + BORDER,
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 280,
    }}>{children}</td>
  );
}

function Row({ r, i }) {
  return (
    <tr
      onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.02)"}
      onMouseLeave={e => e.currentTarget.style.background = "transparent"}
      style={{ transition: "background 150ms cubic-bezier(0.4, 0, 0.2, 1)" }}>
      <Td align="right" mono color={TEXT_3}>{i + 1}</Td>
      <Td color={TEXT}>{r.title}</Td>
      <Td>{r.artist || "—"}</Td>
      <Td align="right" mono>{r.bpm ?? "—"}</Td>
      <Td mono>{r.key || "—"}</Td>
      <Td align="right" mono>{r.duration != null ? Math.round(r.duration) + "s" : "—"}</Td>
      <Td color={r.errored ? STATUS_BAD : r.analyzed ? STATUS_OK : TEXT_3}>
        {r.errored ? "error" : r.analyzed ? "yes" : "no"}
      </Td>
      <Td align="right" mono>{r.gridAnchorSec != null ? r.gridAnchorSec.toFixed(3) : "—"}</Td>
      <Td align="right" mono>{r.bpmOverride ?? "—"}</Td>
      <Td><StateBadge state={r.probe.state} /></Td>
      <Td color={TEXT_3} mono>{sourceLabel[r.probe.source] || r.probe.source}</Td>
    </tr>
  );
}
