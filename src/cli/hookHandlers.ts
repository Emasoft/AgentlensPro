// src/cli/hookHandlers.ts — the `agentlenspro hook` / `agentlenspro gate` stdin handlers
// (TRDD-7284WCW7). These absorb scripts/spy-agentlens*.{sh,mjs} and their PATH-bin wrappers
// into the single executable: hooks are now registered as `agentlenspro hook|gate` command
// strings, and this module IS the handler — no wrapper chain, no sibling-script resolution.
//
// Contracts (inherited verbatim from the spy scripts — the tests in cliHookHandlers.test.ts
// pin them):
//   hook — POST the raw stdin payload to $AGENTLENS_UI_URL/api/hook-events. Print NOTHING
//          (hook stdout is captured by the runner). ALWAYS exit 0, even server-down — a
//          telemetry hook that can fail a tool call is worse than no telemetry.
//   gate — AGENTLENS_GATE=off ⇒ exit 0, no output, BEFORE any network. Else POST stdin to
//          /api/agent-gate and print the response body VERBATIM (the body IS the hook's
//          stdout: empty = allow, deny/advisory JSON flows to the model untouched). ANY
//          failure ⇒ silent exit 0 (fail-open): a gate that can block a launch because
//          AgentlensPro is down would be worse than no gate.

import { uiBaseUrl } from './cliCore'

function readStdin(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    stream.on('data', (c: Buffer) => chunks.push(c))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    // A closed/absent stdin must not hang the hook — resolve with whatever arrived.
    stream.on('error', () => resolve(Buffer.concat(chunks)))
  })
}

/** Forward one lifecycle payload. Never throws — the fire-and-forget contract. */
export async function forwardHookEvent(payload: Buffer, opts: { baseUrl?: string; timeoutMs?: number } = {}): Promise<void> {
  const base = opts.baseUrl ?? uiBaseUrl()
  const timeoutMs = opts.timeoutMs ?? Math.max(200, Number(process.env.AGENTLENS_HOOK_TIMEOUT || 1) * 1000)
  try {
    await fetch(`${base}/api/hook-events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: new Uint8Array(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch { /* server down / timeout — silent no-op by contract */ }
}

/** Run one gate check. Returns the server's response body ('' = allow / any failure). */
export async function runGateCheck(payload: Buffer, opts: { baseUrl?: string; timeoutMs?: number } = {}): Promise<string> {
  if ((process.env.AGENTLENS_GATE || 'on') === 'off') return '' // kill-switch BEFORE any network
  const base = opts.baseUrl ?? uiBaseUrl()
  const timeoutMs = opts.timeoutMs ?? Math.max(200, Number(process.env.AGENTLENS_GATE_TIMEOUT || 2) * 1000)
  try {
    const res = await fetch(`${base}/api/agent-gate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: new Uint8Array(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    return await res.text()
  } catch { return '' } // server down / timeout — allow silently
}

/** Process entry for `agentlenspro hook` / `agentlenspro gate`. Always resolves 0. */
export async function runHookCommand(kind: 'hook' | 'gate'): Promise<number> {
  // The gate kill-switch must short-circuit BEFORE stdin is read: the runner may hold the
  // pipe open, and a disabled gate must cost nothing (matches spy-agentlens-gate.sh).
  if (kind === 'gate' && (process.env.AGENTLENS_GATE || 'on') === 'off') return 0
  const payload = await readStdin(process.stdin)
  if (kind === 'hook') {
    await forwardHookEvent(payload)
  } else {
    const out = await runGateCheck(payload)
    if (out) process.stdout.write(out)
  }
  return 0
}
