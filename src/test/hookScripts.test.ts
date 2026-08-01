import * as assert from 'assert'
import * as http from 'http'
import * as path from 'path'
import { spawn } from 'child_process'
import type { AddressInfo } from 'net'

// ── AgentlensPro hook handlers (TRDD-GOD0108C contracts; TRDD-7284WCW7 single executable) ──
// Runs the REAL built CLI (standalone/cli.js — the ONE published bin) as a child process
// against an in-test stub HTTP server (port 0 → ephemeral). No mocks of the CLI or of HTTP.
// These are the exact commands ~/.claude/settings.json registrations execute at hook fire.
//
// Contracts under test (inherited verbatim from the absorbed spy-agentlens*.{sh,mjs}):
//   agentlenspro hook — POST stdin to $AGENTLENS_UI_URL/api/hook-events; print NOTHING;
//                       always exit 0 (even server-down).
//   agentlenspro gate — AGENTLENS_GATE=off ⇒ exit 0, no output, BEFORE any network;
//                       else POST stdin to /api/agent-gate and print the response body
//                       VERBATIM; empty body ⇒ no output; server-down ⇒ silent exit 0.

const CLI_JS = path.resolve(__dirname, '..', '..', '..', 'standalone', 'cli.js')

interface Captured { method: string; url: string; body: string }
interface StubHandle { base: string; requests: Captured[]; close: () => Promise<void> }

// Stub server: records every request (full body) then replies with what `responder` returns.
// The body is fully drained BEFORE the reply is sent, so a handler that waits for the response
// has guaranteed the request is recorded by the time its child exits.
function startStub(responder: (c: Captured) => { status: number; body: string }): Promise<StubHandle> {
  return new Promise((resolve) => {
    const requests: Captured[] = []
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const cap: Captured = { method: req.method ?? '', url: req.url ?? '', body: Buffer.concat(chunks).toString('utf-8') }
        requests.push(cap)
        const r = responder(cap)
        res.writeHead(r.status, { 'Content-Type': 'application/json' })
        res.end(r.body)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        base: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise<void>((res) => server.close(() => res())),
      })
    })
  })
}

// A port that nothing listens on (bound then released) → connections get ECONNREFUSED fast.
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

// Build a child env from the real one but with AgentlensPro hook knobs cleared, so an ambient
// AGENTLENS_GATE=off (etc.) in the developer's shell can't skew a test.
function baseEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.AGENTLENS_GATE
  delete env.AGENTLENS_GATE_TIMEOUT
  delete env.AGENTLENS_HOOK_TIMEOUT
  delete env.AGENTLENS_GATE_MODE
  delete env.AGENTLENS_UI_URL
  return { ...env, ...overrides }
}

interface RunResult { code: number | null; stdout: string; stderr: string }
function run(subcommand: 'hook' | 'gate', env: NodeJS.ProcessEnv, stdin: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_JS, subcommand], { env })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    // The kill-switch path exits before reading stdin — writing then triggers EPIPE, which is fine.
    child.stdin?.on('error', () => { /* child already gone — expected on the kill-switch path */ })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin?.write(stdin)
    child.stdin?.end()
  })
}

suite('agentlenspro hook/gate — the exit path must be fast AND complete', () => {
  // These two pull in opposite directions, and satisfying one alone breaks the other.
  //
  // FAST: an aborted fetch does not destroy its TCP socket, so the socket holds the event loop open
  // until the OS connect timeout. A CLI that ends by setting `process.exitCode` waits for that drain
  // — measured 10.6 s against an address that DROPS, on paths Claude Code runs per render and per
  // tool call. `AbortSignal.timeout` is NOT the fix: it fires correctly (704 ms) and bounds only the
  // REQUEST. The fix is process.exit().
  //
  // COMPLETE: process.exit() DISCARDS a pending piped stdout write past the ~64 KiB pipe buffer
  // (measured: 262,144 written, 65,536 received). `gate` writes the verdict Claude Code READS to
  // decide whether to block a tool call, so truncating it corrupts a safety decision. Hence flush,
  // with a bounded wait so a reader that never drains cannot restore the hang.

  test('gate: a verdict larger than the pipe buffer arrives WHOLE, not one buffer of it', async () => {
    const BIG = 'D'.repeat(262_144)
    const stub = await startStub(() => ({ status: 200, body: BIG }))
    try {
      const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { prompt: 'x' } })
      const r = await run('gate', baseEnv({ AGENTLENS_UI_URL: stub.base }), payload)
      assert.strictEqual(r.code, 0)
      assert.strictEqual(r.stdout.length, BIG.length,
        `the verdict was truncated to ${r.stdout.length} bytes — process.exit() dropped a queued pipe write`)
    } finally { await stub.close() }
  })

  for (const sub of ['hook', 'gate'] as const) {
    test(`${sub}: a server that HANGS (not refuses) must not stall the tool call`, async function () {
      this.timeout(20_000)
      // 10.255.255.1 DROPS. A dead port REFUSES instantly and hides this entirely — which is exactly
      // why every other test in this file (they use freePort()) passed while the bug was live.
      const t0 = Date.now()
      const r = await run(sub, baseEnv({ AGENTLENS_UI_URL: 'http://10.255.255.1:3000', AGENTLENS_GATE_TIMEOUT: '1', AGENTLENS_HOOK_TIMEOUT: '1' }),
        JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { prompt: 'x' } }))
      const ms = Date.now() - t0
      assert.strictEqual(r.code, 0, 'fail-open is unconditional: an unreachable server never fails the tool call')
      assert.ok(ms < 5_000, `${sub} took ${ms}ms — a hung socket is holding the process open`)
    })
  }
})

suite('agentlenspro hook/gate — single-executable handler contracts', () => {
  test('forwards-and-silent: `agentlenspro hook` POSTs stdin to /api/hook-events, prints nothing, exits 0', async () => {
    // Happy path: the raw payload reaches /api/hook-events verbatim and the hook stays a silent pipe.
    const stub = await startStub(() => ({ status: 200, body: '{"ok":true}' }))
    try {
      const payload = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's1' })
      const r = await run('hook', baseEnv({ AGENTLENS_UI_URL: stub.base }), payload)
      assert.strictEqual(r.code, 0)
      assert.strictEqual(r.stdout, '', `hook must print nothing (got: ${JSON.stringify(r.stdout)})`)
      assert.strictEqual(stub.requests.length, 1)
      assert.strictEqual(stub.requests[0].method, 'POST')
      assert.strictEqual(stub.requests[0].url, '/api/hook-events')
      assert.strictEqual(stub.requests[0].body, payload)
    } finally { await stub.close() }
  })

  test('hook-fail-open-server-down: unreachable server ⇒ silent exit 0', async () => {
    // A telemetry hook that can fail a tool call is worse than no telemetry.
    const dead = await freePort()
    const payload = JSON.stringify({ hook_event_name: 'Stop', session_id: 's2' })
    const r = await run('hook', baseEnv({ AGENTLENS_UI_URL: `http://127.0.0.1:${dead}`, AGENTLENS_HOOK_TIMEOUT: '1' }), payload)
    assert.strictEqual(r.code, 0, 'hook must exit 0 when the server is down')
    assert.strictEqual(r.stdout, '', 'no output when the server is unreachable')
  })

  test('gate-prints-deny-body: `agentlenspro gate` POSTs to /api/agent-gate and prints the response body VERBATIM', async () => {
    // The server's response body IS the hook's stdout — a deny JSON must be echoed byte-for-byte.
    const denyBody = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'runaway fan-out' } })
    const stub = await startStub(() => ({ status: 200, body: denyBody }))
    try {
      const launch = JSON.stringify({ hook_event_name: 'PreToolUse', tool_input: { subagent_type: 'general-purpose' } })
      const r = await run('gate', baseEnv({ AGENTLENS_UI_URL: stub.base }), launch)
      assert.strictEqual(r.code, 0)
      assert.strictEqual(r.stdout, denyBody, 'gate must print the server response VERBATIM')
      assert.strictEqual(stub.requests.length, 1)
      assert.strictEqual(stub.requests[0].method, 'POST')
      assert.strictEqual(stub.requests[0].url, '/api/agent-gate')
    } finally { await stub.close() }
  })

  test('gate-kill-switch: AGENTLENS_GATE=off exits 0 with no output BEFORE any network', async () => {
    // The kill-switch short-circuits before contacting the server — zero requests, empty stdout.
    const stub = await startStub(() => ({ status: 200, body: 'SHOULD_NOT_BE_SENT' }))
    try {
      const launch = JSON.stringify({ hook_event_name: 'PreToolUse', tool_input: {} })
      const r = await run('gate', baseEnv({ AGENTLENS_UI_URL: stub.base, AGENTLENS_GATE: 'off' }), launch)
      assert.strictEqual(r.code, 0)
      assert.strictEqual(r.stdout, '', 'kill-switch must print nothing')
      assert.strictEqual(stub.requests.length, 0, 'kill-switch must exit before any network call')
    } finally { await stub.close() }
  })

  test('gate-fail-open-server-down: unreachable server ⇒ silent exit 0 (fail-open)', async () => {
    // A gate that could error a launch is worse than no gate — a dead server must allow silently.
    const dead = await freePort()
    const launch = JSON.stringify({ hook_event_name: 'PreToolUse', tool_input: {} })
    const r = await run('gate', baseEnv({ AGENTLENS_UI_URL: `http://127.0.0.1:${dead}`, AGENTLENS_GATE_TIMEOUT: '2' }), launch)
    assert.strictEqual(r.code, 0, 'gate must fail open (exit 0) when the server is down')
    assert.strictEqual(r.stdout, '', 'no output when the server is unreachable')
  })
})
