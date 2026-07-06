#!/usr/bin/env bash
# AgentLens local launcher.
#
#   scripts/agentlens-up.sh            build, start the standalone server
#                                      (web :3000 + MCP :4316 + OTLP :4318),
#                                      wait for the UI, open the browser.
#   scripts/agentlens-up.sh --ensure   idempotent keep-alive for the SessionStart
#                                      hook: if nothing is serving the MCP port,
#                                      start the server in the background. No
#                                      rebuild, no browser. Safe to call repeatedly.
#
# The standalone server (standalone/server.js) is the single process that hosts
# all three ports, so one command covers "MCP + web app". When the VS Code
# extension is already serving these ports we DON'T start a second server —
# both bind the same ports and the second would EADDRINUSE.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

UI_PORT="${UI_PORT:-3000}"
MCP_PORT="${MCP_PORT:-4316}"
LOG="$ROOT/reports/agentlens-server.log"   # reports/ is gitignored
mkdir -p "$ROOT/reports"

port_listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

start_server_bg() {
  # nohup so it outlives this shell / the hook; log to a gitignored file.
  nohup node standalone/server.js >>"$LOG" 2>&1 &
  echo "agentlens: standalone server starting (pid $!), logging to $LOG"
}

ENSURE=0
[ "${1:-}" = "--ensure" ] && ENSURE=1

if [ "$ENSURE" = "1" ]; then
  # Keep-alive path (SessionStart hook): start only if the MCP port is dead.
  if port_listening "$MCP_PORT"; then
    exit 0   # already served (extension or a prior standalone) — nothing to do
  fi
  # Assume a build already exists; if not, the server import will fail and log it.
  [ -f standalone/server.js ] || node esbuild.js >>"$LOG" 2>&1
  start_server_bg
  exit 0
fi

# Full launch path: (re)build, then serve, then open the browser.
if port_listening "$UI_PORT"; then
  echo "agentlens: UI already listening on :$UI_PORT — opening browser only."
else
  echo "agentlens: building (node esbuild.js)…"
  node esbuild.js
  start_server_bg
  # Wait up to ~20s for the UI port to come up before opening the browser.
  for _ in $(seq 1 40); do
    port_listening "$UI_PORT" && break
    sleep 0.5
  done
fi

URL="http://localhost:$UI_PORT"
if command -v open >/dev/null 2>&1; then open "$URL"        # macOS
elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"  # Linux
else echo "agentlens: open $URL in your browser."; fi
echo "agentlens: dashboard at $URL  ·  MCP at http://localhost:$MCP_PORT/mcp"
