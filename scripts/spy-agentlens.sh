#!/usr/bin/env bash
# spy-agentlens.sh — forward the raw Claude Code hook payload (stdin) to the local
# AgentLens server. Registered by `agentlens-cli --install-hooks` on LIFECYCLE events
# only (SessionStart/End, Stop, StopFailure, PreCompact/PostCompact, Permission/
# Notification, SubagentStart/Stop) — never on PreToolUse/PostToolUse, whose data is
# already fully captured by the JSONL transcripts + raw OTEL bodies and whose frequency
# is where per-hook overhead lives.
#
# Design constraints (replacing claude-spyglass's collector, which spawned bash+python3+
# curl per fire and leaked a PID to stdout):
#   - ONE child process (curl), no client-side parsing — the server classifies.
#   - Fire-and-forget: 1s cap, silent no-op when the server is down.
#   - NO stdout (hook stdout is captured by the runner) and ALWAYS exit 0 — a telemetry
#     hook must never block or fail a turn.
curl -s -o /dev/null --max-time "${AGENTLENS_HOOK_TIMEOUT:-1}" \
  -X POST -H 'Content-Type: application/json' --data-binary @- \
  "${AGENTLENS_UI_URL:-http://localhost:3000}/api/hook-events" 2>/dev/null || true
exit 0
