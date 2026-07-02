#!/bin/bash
# dummynet-jitter.sh — kernel-level jitter harness for the two-tab loopback test.
# Injects variable delay + packet loss into loopback UDP (the two-tab WebRTC
# media path) via pf + dummynet, so NetEQ experiences real arrival variance
# locally. Dummynet's delay is FIXED per pipe, so `on` starts an oscillator that
# toggles the pipe's delay HIGH↔LOW every PERIOD/2 ms — the toggling IS the
# jitter (packets queued during the HIGH window arrive bunched; the drop back to
# LOW reorders). REQUIRES sudo.
#
#   sudo tools/netem/dummynet-jitter.sh on [HIGH_MS LOW_MS PERIOD_MS PLR_PCT]
#   sudo tools/netem/dummynet-jitter.sh off       # ALWAYS run when done
#   sudo tools/netem/dummynet-jitter.sh status
#
# Defaults: HIGH=150 LOW=40 PERIOD=600 PLR=1 (Jake-like WiFi burst profile).
#
# SCOPE: interface-scoped to lo0 (loopback) UDP only — WebRTC two-tab media is
# self-addressed so it traverses lo0; the machine's real internet traffic (en0)
# is untouched. Port-scoping is NOT practical (WebRTC uses ephemeral UDP ports),
# so lo0-only is the containment.
#
# GOTCHA HANDLED: any `set skip on lo…` line is STRIPPED from the ruleset we
# load — if loopback is skipped, pf never sees the packets and the harness
# silently does nothing. (Default macOS /etc/pf.conf has no skip line, but VPNs
# and tools add one.)
#
# CLEANUP GUARANTEE (`off`): kills the oscillator, `dnctl -q flush` (removes all
# pipes), reloads the stock /etc/pf.conf ruleset (the file itself is NEVER
# modified — we only load a merged ruleset into the kernel), and releases our pf
# enable reference (pfctl -X token; pf returns to its prior enabled/disabled
# state). `on` traps failures and auto-runs `off`.
#
# SELF-VERIFICATION (run before trusting ANY conclusion):
#   sudo tools/netem/dummynet-jitter.sh on
#   node tools/smoke/measure-relay.mjs   # baseline two-tab, NO ?jbtarget override
#   → [JITTER-DIAG] jbTargetMs MUST balloon well past 220 on its own.
#   If it stays ~220, the harness is NOT touching the path (pf skip? dummynet
#   inert on this macOS?) — fix that before drawing any conclusions.
#   sudo tools/netem/dummynet-jitter.sh off
set -u

ANCHOR="mixsync-jitter"
PIPE=1
STATE_DIR="/tmp/mixsync-netem"
PF_CONF="/etc/pf.conf"

HIGH_MS="${2:-150}"; LOW_MS="${3:-40}"; PERIOD_MS="${4:-600}"; PLR_PCT="${5:-1}"

die() { echo "✗ $*" >&2; exit 1; }
need_root() { [ "$(id -u)" = "0" ] || die "needs sudo: sudo $0 ${1:-on}"; }

do_off() {
  # 1. stop the oscillator
  if [ -f "$STATE_DIR/oscillator.pid" ]; then
    kill "$(cat "$STATE_DIR/oscillator.pid")" 2>/dev/null
    rm -f "$STATE_DIR/oscillator.pid"
  fi
  pkill -f "dummynet-jitter-oscillator" 2>/dev/null
  # 2. remove all dummynet pipes
  dnctl -q flush
  # 3. reload the stock ruleset (drops our anchor + restores any stripped lines)
  pfctl -q -f "$PF_CONF" 2>/dev/null
  # 4. release our pf enable reference → pf returns to its prior state
  if [ -f "$STATE_DIR/pf.token" ]; then
    pfctl -q -X "$(cat "$STATE_DIR/pf.token")" 2>/dev/null
    rm -f "$STATE_DIR/pf.token"
  fi
  echo "✓ off — pipes flushed, stock $PF_CONF ruleset reloaded, pf reference released"
  echo "  verify: 'sudo dnctl list' should print nothing; 'sudo pfctl -sr' shows no $ANCHOR"
}

do_on() {
  mkdir -p "$STATE_DIR"
  trap 'echo "✗ setup failed — rolling back"; do_off; exit 1' ERR

  # warn if the ACTIVE ruleset skips loopback (VPNs/tools add this)
  if pfctl -sr 2>/dev/null | grep -q "skip.*lo"; then
    echo "⚠ active pf ruleset had 'set skip' on loopback — replacing with a ruleset that does NOT skip lo0"
  fi

  # pipe with the LOW delay to start; PLR is per-packet, applied continuously
  dnctl pipe $PIPE config delay "$LOW_MS" plr "0.0$(printf '%02d' "$PLR_PCT" 2>/dev/null || echo 1)" 2>/dev/null \
    || dnctl pipe $PIPE config delay "$LOW_MS" plr "$(echo "scale=3; $PLR_PCT/100" | bc)"

  # merged ruleset: stock pf.conf (minus any loopback skip) + our dummynet anchor
  { grep -v 'set skip.*lo' "$PF_CONF"; echo "dummynet-anchor \"$ANCHOR\""; } | pfctl -q -f - \
    || die "failed to load merged ruleset"
  echo "dummynet in quick on lo0 proto udp from any to any pipe $PIPE" | pfctl -q -a "$ANCHOR" -f - \
    || die "failed to load $ANCHOR rules"

  # enable pf, capturing the reference token so off() restores prior state
  TOKEN=$(pfctl -E 2>&1 | sed -n 's/.*[Tt]oken *: *\([0-9][0-9]*\).*/\1/p')
  [ -n "$TOKEN" ] && echo "$TOKEN" > "$STATE_DIR/pf.token"

  # oscillator: toggle the pipe delay HIGH↔LOW every PERIOD/2 — this is the jitter
  HALF_S=$(echo "scale=3; $PERIOD_MS/2000" | bc)
  PLR_FRAC=$(echo "scale=3; $PLR_PCT/100" | bc)
  ( # tagged so pkill -f finds it even if the pid file is lost
    exec -a dummynet-jitter-oscillator bash -c "
      while :; do
        dnctl pipe $PIPE config delay $HIGH_MS plr $PLR_FRAC
        sleep $HALF_S
        dnctl pipe $PIPE config delay $LOW_MS plr $PLR_FRAC
        sleep $HALF_S
      done" ) &
  echo $! > "$STATE_DIR/oscillator.pid"
  trap - ERR

  echo "✓ on — lo0 UDP through dummynet pipe $PIPE: delay ${LOW_MS}↔${HIGH_MS}ms every $((PERIOD_MS/2))ms, plr ${PLR_PCT}%"
  echo "  NOW SELF-VERIFY (see header): baseline two-tab → jbTargetMs must balloon past 220"
  echo "  when done: sudo $0 off"
}

do_status() {
  echo "── dummynet pipes ──"; dnctl list 2>/dev/null || echo "(none)"
  echo "── pf $ANCHOR rules ──"; pfctl -a "$ANCHOR" -sr 2>/dev/null || echo "(none)"
  echo "── pf status ──"; pfctl -s info 2>/dev/null | head -2
  [ -f "$STATE_DIR/oscillator.pid" ] && echo "oscillator pid: $(cat "$STATE_DIR/oscillator.pid")"
}

case "${1:-}" in
  on)     need_root on;  do_on ;;
  off)    need_root off; do_off ;;
  status) need_root status; do_status ;;
  *) echo "usage: sudo $0 on [HIGH_MS LOW_MS PERIOD_MS PLR_PCT] | off | status"; exit 1 ;;
esac
