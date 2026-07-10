#!/usr/bin/env node
// spy-agentlens.mjs — node twin of spy-agentlens.sh for platforms without bash (native
// Windows; cross-platform audit blocker #2). Registered by `agentlens-cli --install-hooks`
// as `node <this file>` when process.platform is win32; POSIX keeps the bash+curl script
// (faster: no node boot on the hook path). Same contract: forward stdin to the server,
// fire-and-forget, NO stdout, ALWAYS exit 0 — a telemetry hook must never fail a turn.
const chunks = []
process.stdin.on('data', c => chunks.push(c))
process.stdin.on('end', () => {
  const base = process.env.AGENTLENS_UI_URL || 'http://localhost:3000'
  const timeoutMs = Math.max(200, Number(process.env.AGENTLENS_HOOK_TIMEOUT || 1) * 1000)
  fetch(`${base}/api/hook-events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.concat(chunks),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => {}).finally(() => process.exit(0))
})
process.stdin.on('error', () => process.exit(0))
