#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# ── TradingView Desktop ───────────────────────────────────────────────────────
if node src/cli/index.js status > /dev/null 2>&1; then
  echo "TradingView Desktop already running with CDP."
else
  echo "TradingView Desktop not detected on CDP port 9222 — launching..."
  if ! node src/cli/index.js launch; then
    echo "Warning: auto-launch failed. Start TradingView Desktop manually, then retry." >&2
  fi
fi

# ── Where to bind, and which URL the browser should use ───────────────────────
# On ChromeOS (Crostini) the browser runs OUTSIDE this container, so its
# 127.0.0.1 is not ours — binding to loopback makes the viewer unreachable.
# Bind all interfaces instead and hand out the container's routable IP.
# NOT penguin.linux.test: that name is resolved by ChromeOS, and on a rebuilt
# container it may not resolve at all (ERR_NAME_NOT_RESOLVED), so the browser
# never even opens a connection. The IP always works, but changes whenever the
# container is rebuilt — so derive it at runtime rather than hardcoding either.
GARCON=/opt/google/cros-containers/bin/garcon
BRIDGE_PORT="${MCP_BRIDGE_PORT:-3001}"
BRIDGE_TOKEN="${MCP_BRIDGE_TOKEN:-mysecret}"

if [ -x "$GARCON" ]; then
  BRIDGE_HOST="${MCP_BRIDGE_HOST:-0.0.0.0}"
  VIEWER_HOST=$(ip -4 -o addr show scope global 2>/dev/null | awk 'NR==1{split($4,a,"/"); print a[1]}')
  VIEWER_HOST="${VIEWER_HOST:-penguin.linux.test}"
else
  BRIDGE_HOST="${MCP_BRIDGE_HOST:-127.0.0.1}"
  VIEWER_HOST="$BRIDGE_HOST"
fi
VIEWER_URL="http://${VIEWER_HOST}:${BRIDGE_PORT}/viewer"

MCP_BRIDGE_HOST="$BRIDGE_HOST" \
MCP_BRIDGE_PORT="$BRIDGE_PORT" \
MCP_BRIDGE_TOKEN="$BRIDGE_TOKEN" \
  node scripts/http-bridge.js &
BRIDGE_PID=$!
trap 'kill "$BRIDGE_PID" 2>/dev/null' EXIT

# /viewer is public, so a 200 here is a real readiness signal (/health 401s
# whenever a token is set). Loopback always works from inside the container.
for _ in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${BRIDGE_PORT}/viewer" 2>/dev/null || echo 000)
  [ "$code" = "200" ] && break
  sleep 0.5
done

echo
echo "Server is running: $VIEWER_URL"
echo "Bridge token:      $BRIDGE_TOKEN   (paste this into the viewer's token box)"
if [ -x "$GARCON" ]; then
  echo "If that IP changed:  http://penguin.linux.test:${BRIDGE_PORT}/viewer  (only if ChromeOS resolves it)"
fi
echo

if [ -x "$GARCON" ]; then
  "$GARCON" --client --url "$VIEWER_URL" > /dev/null 2>&1 || echo "Open manually: $VIEWER_URL"
elif command -v xdg-open > /dev/null 2>&1; then
  xdg-open "$VIEWER_URL" > /dev/null 2>&1 &
else
  echo "Open manually: $VIEWER_URL"
fi

wait "$BRIDGE_PID"
