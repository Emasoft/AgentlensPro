#!/usr/bin/env node
// spy-agentlens-gate.mjs — node twin of spy-agentlens-gate.sh for platforms without bash
// (native Windows; cross-platform audit blocker #2). Same contract as the bash gate: the
// server's response body IS this hook's stdout (empty = allow, print nothing); kill-switch
// before any network; fail-open on ANY error — a gate that can block a launch because
// AgentLens is down would be worse than no gate.
if ((process.env.AGENTLENS_GATE || 'on') === 'off') process.exit(0)
const chunks = []
process.stdin.on('data', c => chunks.push(c))
process.stdin.on('end', async () => {
  try {
    const base = process.env.AGENTLENS_UI_URL || 'http://localhost:3000'
    const timeoutMs = Math.max(200, Number(process.env.AGENTLENS_GATE_TIMEOUT || 2) * 1000)
    const res = await fetch(`${base}/api/agent-gate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.concat(chunks),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    if (text) process.stdout.write(text)
  } catch { /* server down / timeout — allow silently */ }
  process.exit(0)
})
process.stdin.on('error', () => process.exit(0))
