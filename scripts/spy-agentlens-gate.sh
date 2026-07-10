#!/usr/bin/env bash
# spy-agentlens-gate.sh — the agent-launch burn gate (TRDD-GOD0108C). Registered by
# `agentlens-cli --install-hooks` on PreToolUse AND PostToolUse, matcher ^(Task|Agent|Workflow)$
# ONLY — agent launches are rare, so this never adds per-tool-call overhead the way
# claude-spyglass's every-event collector did.
#
# Contract with the server (POST /api/agent-gate):
#   - The response body IS this hook's stdout. Empty/204 = allow, print nothing.
#   - Deny: the server returns the PreToolUse permissionDecision JSON (reason goes to the
#     model so it can adapt: warm one agent first, pin a cheap model, wait out a wave).
#   - Advisory: on PostToolUse the server returns additionalContext JSON (deduped server-side).
#
# Fail-open by construction: kill-switch before any network; curl capped at 2s; ANY curl
# failure or server absence → print nothing, exit 0. A gate that can block a launch because
# AgentLens is down would be worse than no gate.
[ "${AGENTLENS_GATE:-on}" = "off" ] && exit 0
out=$(curl -s --max-time "${AGENTLENS_GATE_TIMEOUT:-2}" \
  -X POST -H 'Content-Type: application/json' --data-binary @- \
  "${AGENTLENS_UI_URL:-http://localhost:3000}/api/agent-gate" 2>/dev/null) || exit 0
[ -n "$out" ] && printf '%s' "$out"
exit 0
