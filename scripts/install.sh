#!/usr/bin/env bash
# AgentLens one-command installer: deps -> build -> global CLI -> skill -> server.
#
#   bash scripts/install.sh
#
# Idempotent — safe to re-run after a git pull. Deliberately does NOT touch
# ~/.claude/settings.json: telemetry wiring is a separate, explicit opt-in
# (agentlens-cli --install-otel), because that file is user config and every
# mutation of it must be a deliberate, verified transaction.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

step() { printf '\n==> %s\n' "$1"; }

step "Checking prerequisites"
command -v node >/dev/null 2>&1 || { echo "FAIL: node is not installed (need Node 18+)" >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "FAIL: Node $(node -v) is too old — AgentLens needs Node 18+" >&2
  exit 1
fi
echo "node $(node -v) OK"

step "Installing dependencies"
if command -v pnpm >/dev/null 2>&1; then
  pnpm install --frozen-lockfile
else
  # The repo ships a pnpm lockfile only, so `npm ci` cannot work here —
  # plain `npm install` is the functional fallback when pnpm is absent.
  echo "pnpm not found — falling back to npm install (pnpm is recommended)"
  npm install
fi

step "Building bundles"
node esbuild.js

step "Linking the agentlens-cli globally"
# npm link, not `pnpm link --global`: pnpm's global bin dir is typically not
# on PATH, so the linked binary would be unreachable (hit in the field).
npm link
command -v agentlens-cli >/dev/null 2>&1 || {
  echo "FAIL: agentlens-cli did not land on PATH after npm link" >&2; exit 1;
}
echo "agentlens-cli -> $(command -v agentlens-cli)"

step "Installing the agentlens-diagnostics skill"
agentlens-cli --install-skill

step "Starting the AgentLens server"
agentlens-cli --start-server
agentlens-cli --status

printf '\nAgentLens installed. Dashboard: agentlens-cli --dashboard\n'
printf 'NOTE: Claude Code telemetry env vars were NOT installed. For much better\n'
printf 'data (per-call usage, cache forensics, raw bodies) it is RECOMMENDED to run:\n'
printf '\n  agentlens-cli --install-otel\n\n'
printf 'and, for lifecycle signals (rate-limit turn deaths, compaction boundaries):\n'
printf '\n  agentlens-cli --install-hooks\n\n'
printf '(both are safe verified transactions on ~/.claude/settings.json; removable\n'
printf 'anytime with --uninstall-otel / --uninstall-hooks)\n'
