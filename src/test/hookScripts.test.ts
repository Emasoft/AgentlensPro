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

import * as fs from 'fs'

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
  // AGENTLENS_NO_REVIVE brakes reviveDaemonDetached() (src/cli/hookHandlers.ts): the
  // 'server-down'/'hangs' tests below deliberately fail the hook's POST, and on a failed
  // POST forwardHookEvent() falls through to a real detached `alcore serve` spawn using this
  // file's UNMODIFIED HOME/DATA_DIR — i.e. the developer's REAL ~/.agentlens on the default
  // ports. This file only overrides AGENTLENS_UI_URL (the POST target), so without the brake
  // a "server down" test run while the real production server happens to be down (measured:
  // TRDD-YGEV6QDD/TRDD-4EV3OJ19, an ongoing crash-loop) spawns a real production revive as a
  // side effect of the test — never what "fail-open exit 0" is testing here.
  env.AGENTLENS_NO_REVIVE = '1'
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
      // Two spawns of the real CLI; under machine starvation each can spend seconds on startup alone.
      this.timeout(60_000)
      const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { prompt: 'x' } })
      const timeouts = { AGENTLENS_GATE_TIMEOUT: '1', AGENTLENS_HOOK_TIMEOUT: '1' }
      // CONTROL: the same subcommand against a port that REFUSES at once. Same process startup and
      // bundle load, same fail-open exit path (spool, braked revive, exitNow), no abort wait, so
      // its duration is what the machine charges for one spawn right now.
      const dead = await freePort()
      const c0 = Date.now()
      const control = await run(sub, baseEnv({ AGENTLENS_UI_URL: `http://127.0.0.1:${dead}`, ...timeouts }), payload)
      const controlMs = Date.now() - c0
      assert.strictEqual(control.code, 0, 'control: a refused connection fails open')
      // 10.255.255.1 DROPS. A dead port REFUSES instantly and hides this entirely — which is exactly
      // why every other test in this file (they use freePort()) passed while the bug was live.
      const t0 = Date.now()
      const r = await run(sub, baseEnv({ AGENTLENS_UI_URL: 'http://10.255.255.1:3000', ...timeouts }), payload)
      const hangMs = Date.now() - t0
      assert.strictEqual(r.code, 0, 'fail-open is unconditional: an unreachable server never fails the tool call')
      // WHY the difference against the control, not an absolute bound: an absolute bound measures the
      // machine. Gate run A1 (TRDD-CS2W7E77) took 5444 ms here at load average 300, where it is
      // normally about 1.2 s, and the deadline had worked — the time was process startup. The hang
      // case adds only the 1 s abort over the control; the regression this guards (a socket holding
      // the process open until the OS connect timeout) adds 9 s or more (10.6 s measured).
      assert.ok(hangMs - controlMs < 4_000,
        `${sub} took ${hangMs}ms against a ${controlMs}ms refused-port control — a hung socket is holding the process open`)
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

  test('round-2 default isolation: a server-down hook run writes its spool + revive-lock artefacts under the TEMP data dir, never the real one', async () => {
    // src/test/setup.js overrides DATA_DIR/HOME for the whole run BEFORE this file's own
    // baseEnv() spreads process.env into the child — this proves the redirection actually reaches
    // the two writes that used to land in the REAL ~/.agentlens (spoolHookEvent + the
    // .daemon-revive.lock write in reviveDaemonDetached()), both of which run BEFORE that
    // function's own AGENTLENS_NO_REVIVE check.
    const testDataDir = process.env.DATA_DIR
    assert.ok(testDataDir, 'this suite must run under the global test DATA_DIR override (src/test/setup.js)')
    const realHome = process.env.AGENTLENS_TEST_REAL_HOME
    assert.ok(realHome, 'src/test/setup.js must have captured the real HOME')
    const marker = `hookScripts-regression-${process.pid}-${Date.now()}`
    const dead = await freePort()
    const payload = JSON.stringify({ hook_event_name: 'Stop', session_id: marker })
    const r = await run('hook', baseEnv({ AGENTLENS_UI_URL: `http://127.0.0.1:${dead}`, AGENTLENS_HOOK_TIMEOUT: '1' }), payload)
    assert.strictEqual(r.code, 0)

    const hookSpoolDir = path.join(testDataDir as string, 'hook-spool')
    const spooled = fs.readdirSync(hookSpoolDir).filter((n) => n.endsWith('.json'))
      .some((n) => fs.readFileSync(path.join(hookSpoolDir, n), 'utf-8').includes(marker))
    assert.ok(spooled, `expected a spooled event carrying ${marker} under ${hookSpoolDir}`)

    assert.ok(fs.existsSync(path.join(testDataDir as string, '.daemon-revive.lock')),
      'expected the revive lock under the TEMP data dir')

    const realHookSpoolDir = path.join(realHome as string, '.agentlens', 'hook-spool')
    let realLeaked = false
    try {
      realLeaked = fs.readdirSync(realHookSpoolDir).some((n) => {
        try { return fs.readFileSync(path.join(realHookSpoolDir, n), 'utf-8').includes(marker) } catch { return false }
      })
    } catch { /* no real spool dir on this machine — nothing to leak into */ }
    assert.strictEqual(realLeaked, false, `this run's marker leaked into the REAL spool dir ${realHookSpoolDir}`)
  })

  test('round-2 isolation guard: assertContained throws on a real-HOME path, not just a temp one', () => {
    // Exercises the ACTUAL guard exported by src/test/setup.js (not a re-implementation of its
    // logic) — proves it refuses a path outside its own temp root rather than trusting it never
    // fired during a normal run.
    // setup.js is a plain .js file (not compiled by tsc.test.json), and mocha's own `require:`
    // entry in .mocharc.cjs already loaded it from THIS path relative to the repo root — resolve
    // it the same way here rather than relative to this test's own (compiled, differently-located)
    // out/test/test/ path.
    const setup = require(path.join(process.cwd(), 'src', 'test', 'setup.js')) as {
      assertContained: (label: string, p: string) => void
    }
    const realHome = process.env.AGENTLENS_TEST_REAL_HOME as string
    // Round-3: the guard's containment root was broadened from "this run's own TEST_ROOT" to
    // "the whole system tmp root" (many pre-existing tests legitimately point HOME/DATA_DIR at a
    // SIBLING mkdtemp, not nested under our TEST_ROOT — see setup.js's assertContained comment).
    // A real HOME path is under neither, so it must still throw either way.
    assert.throws(() => setup.assertContained('HOME', realHome), /not inside the system temp root/,
      'the guard must refuse a real-HOME path')
  })
})
