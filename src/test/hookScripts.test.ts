import * as assert from 'assert'
import * as http from 'http'
import * as path from 'path'
import { spawn } from 'child_process'
import type { AddressInfo } from 'net'

// ── AgentLens hook scripts (TRDD-GOD0108C) ─────────────────────────────────────
// Runs the FOUR REAL hook scripts (bash + node twins) as child processes against an
// in-test stub HTTP server (port 0 → ephemeral). No mocks of the scripts or of HTTP.
//
// Contracts under test:
//   spy-agentlens.{sh,mjs}      — POST stdin to $AGENTLENS_UI_URL/api/hook-events; print
//                                 NOTHING; always exit 0 (even server-down).
//   spy-agentlens-gate.{sh,mjs} — AGENTLENS_GATE=off ⇒ exit 0, no output, BEFORE any network;
//                                 else POST stdin to /api/agent-gate and print the response body
//                                 VERBATIM; empty body ⇒ no output; server-down ⇒ silent exit 0.

const SCRIPTS_DIR = path.resolve(__dirname, '..', '..', '..', 'scripts')

interface Captured { method: string; url: string; body: string }
interface StubHandle { base: string; requests: Captured[]; close: () => Promise<void> }

// Stub server: records every request (full body) then replies with what `responder` returns.
// The body is fully drained BEFORE the reply is sent, so a script that waits for the response
// (curl / awaited fetch) has guaranteed the request is recorded by the time its child exits.
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

// Build a child env from the real one but with AgentLens hook knobs cleared, so an ambient
// AGENTLENS_GATE=off (etc.) in the developer's shell can't skew a test.
function baseEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.AGENTLENS_GATE
  delete env.AGENTLENS_GATE_TIMEOUT
  delete env.AGENTLENS_HOOK_TIMEOUT
  delete env.AGENTLENS_GATE_MODE
  return { ...env, ...overrides }
}

interface RunResult { code: number | null; stdout: string; stderr: string }
function run(bin: string, script: string, env: NodeJS.ProcessEnv, stdin: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, [script], { env })
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

interface Family { name: string; bin: string; forwarder: string; gate: string }
// The mjs twins run on the SAME node that runs the suite (process.execPath) — global fetch +
// AbortSignal.timeout are present there. The bash twins run on the system bash + curl.
const families: Family[] = [
  { name: 'bash', bin: 'bash', forwarder: path.join(SCRIPTS_DIR, 'spy-agentlens.sh'), gate: path.join(SCRIPTS_DIR, 'spy-agentlens-gate.sh') },
  { name: 'mjs', bin: process.execPath, forwarder: path.join(SCRIPTS_DIR, 'spy-agentlens.mjs'), gate: path.join(SCRIPTS_DIR, 'spy-agentlens-gate.mjs') },
  // P10 PATH-bin wrappers (package.json "bin": agentlenspro-hook / agentlenspro-gate).
  // These are what --install-hooks actually registers since v1.0.0 — running the same
  // four contracts through them proves the wrapper layer passes stdin/stdout/env through
  // untouched and stays fail-open (it execs the platform twin above at fire time).
  { name: 'path-bin', bin: process.execPath, forwarder: path.join(SCRIPTS_DIR, 'agentlenspro-hook.js'), gate: path.join(SCRIPTS_DIR, 'agentlenspro-gate.js') },
]

for (const fam of families) {
  suite(`hook scripts — ${fam.name} family`, () => {
    test('forwards-and-silent: forwarder POSTs stdin to /api/hook-events, prints nothing, exits 0', async () => {
      // Happy path: the raw payload reaches /api/hook-events verbatim and the hook stays a silent pipe.
      const stub = await startStub(() => ({ status: 200, body: '{"ok":true}' }))
      try {
        const payload = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's1' })
        const r = await run(fam.bin, fam.forwarder, baseEnv({ AGENTLENS_UI_URL: stub.base }), payload)
        assert.strictEqual(r.code, 0)
        assert.strictEqual(r.stdout, '', `forwarder must print nothing (got: ${JSON.stringify(r.stdout)})`)
        assert.strictEqual(stub.requests.length, 1)
        assert.strictEqual(stub.requests[0].method, 'POST')
        assert.strictEqual(stub.requests[0].url, '/api/hook-events')
        assert.strictEqual(stub.requests[0].body, payload)
      } finally { await stub.close() }
    })

    test('gate-prints-deny-body: gate POSTs to /api/agent-gate and prints the response body VERBATIM', async () => {
      // The server's response body IS the hook's stdout — a deny JSON must be echoed byte-for-byte.
      const denyBody = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'runaway fan-out' } })
      const stub = await startStub(() => ({ status: 200, body: denyBody }))
      try {
        const launch = JSON.stringify({ hook_event_name: 'PreToolUse', tool_input: { subagent_type: 'general-purpose' } })
        const r = await run(fam.bin, fam.gate, baseEnv({ AGENTLENS_UI_URL: stub.base }), launch)
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
        const r = await run(fam.bin, fam.gate, baseEnv({ AGENTLENS_UI_URL: stub.base, AGENTLENS_GATE: 'off' }), launch)
        assert.strictEqual(r.code, 0)
        assert.strictEqual(r.stdout, '', 'kill-switch must print nothing')
        assert.strictEqual(stub.requests.length, 0, 'kill-switch must exit before any network call')
      } finally { await stub.close() }
    })

    test('gate-fail-open-server-down: unreachable server ⇒ silent exit 0 (fail-open)', async () => {
      // A gate that could error a launch is worse than no gate — a dead server must allow silently.
      const dead = await freePort()
      const launch = JSON.stringify({ hook_event_name: 'PreToolUse', tool_input: {} })
      const r = await run(fam.bin, fam.gate, baseEnv({ AGENTLENS_UI_URL: `http://127.0.0.1:${dead}`, AGENTLENS_GATE_TIMEOUT: '2' }), launch)
      assert.strictEqual(r.code, 0, 'gate must fail open (exit 0) when the server is down')
      assert.strictEqual(r.stdout, '', 'no output when the server is unreachable')
    })
  })
}
