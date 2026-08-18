import * as assert from 'assert'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { spawn } from 'child_process'
import type { AddressInfo } from 'net'

// ── the single `agentlenspro` executable — dispatch contracts (TRDD-7284WCW7) ─────────────
// Spawns the REAL built CLI (standalone/cli.js) with HOME pointed at an EMPTY temp dir and
// endpoints pointed at ephemeral stubs. No mocks of the CLI itself; the resident server and
// the real ~/.agentlens / ~/.claude are never touched.

const CLI_JS = path.resolve(__dirname, '..', '..', '..', 'standalone', 'cli.js')
const PKG_VERSION = (JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'package.json'), 'utf8')
) as { version: string }).version

interface RunResult { code: number | null; stdout: string; stderr: string }
function runCli(args: string[], env: NodeJS.ProcessEnv, stdin?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_JS, ...args], { env })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    if (stdin !== undefined) child.stdin?.write(stdin)
    child.stdin?.end()
  })
}

/** Isolated child env: empty temp HOME, no ambient AgentlensPro endpoint/knob leakage. */
function isolatedEnv(home: string, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const k of Object.keys(env)) {
    if (k.startsWith('AGENTLENS_')) delete env[k]
  }
  delete env.DATA_DIR
  delete env.UI_PORT
  delete env.MCP_PORT
  delete env.OTLP_PORT
  return { ...env, HOME: home, USERPROFILE: home, ...overrides }
}

function mkHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'al-cli-home-'))
}

suite('agentlenspro — zero-side-effect global flags', () => {
  test('--version prints the exact package.json version, exits 0, and creates NOTHING under HOME', async () => {
    // Field defect: v1 booted the whole span store to parse --version (and then exited 1).
    // The empty-HOME-stays-empty assertion is the no-side-effects proof.
    const home = mkHome()
    try {
      const r = await runCli(['--version'], isolatedEnv(home))
      assert.strictEqual(r.code, 0, `stderr: ${r.stderr}`)
      assert.strictEqual(r.stdout, `${PKG_VERSION}\n`)
      assert.deepStrictEqual(fs.readdirSync(home), [], 'HOME must remain empty — no ~/.agentlens, no ~/.claude')
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('-v is an alias for --version with the same no-side-effects guarantee', async () => {
    const home = mkHome()
    try {
      const r = await runCli(['-v'], isolatedEnv(home))
      assert.strictEqual(r.code, 0)
      assert.strictEqual(r.stdout, `${PKG_VERSION}\n`)
      assert.deepStrictEqual(fs.readdirSync(home), [])
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('--help prints the usage text, exits 0, and creates NOTHING under HOME (no server checks)', async () => {
    const home = mkHome()
    try {
      const r = await runCli(['--help'], isolatedEnv(home))
      assert.strictEqual(r.code, 0, `stderr: ${r.stderr}`)
      assert.ok(r.stdout.includes('agentlenspro setup'), 'usage must document the setup verb')
      assert.ok(r.stdout.includes('server start|stop|restart|status'), 'usage must document the server verbs')
      assert.deepStrictEqual(fs.readdirSync(home), [], 'HOME must remain empty')
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })
})

// A minimal MCP stub: answers initialize, tools/list, tools/call over plain JSON (the CLI
// accepts plain-JSON responses on the Streamable-HTTP endpoint). Real HTTP, real CLI child.
interface McpStub { url: string; calls: Array<{ method: string; params: unknown }>; close: () => Promise<void> }
function startMcpStub(tools: Array<Record<string, unknown>>, callResult: (name: string) => unknown): Promise<McpStub> {
  return new Promise((resolve) => {
    const calls: Array<{ method: string; params: unknown }> = []
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: number; method: string; params: unknown }
        calls.push({ method: body.method, params: body.params })
        let result: unknown = {}
        if (body.method === 'tools/list') result = { tools }
        if (body.method === 'tools/call') {
          const name = (body.params as { name: string }).name
          result = { content: [{ type: 'text', text: JSON.stringify(callResult(name)) }] }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        calls,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}

suite('agentlenspro — diagnostics dispatch parity (absorbed agentlens-cli.js surface)', () => {
  test('`list --desc` prints every tool from the live tools/list schema, one per line', async () => {
    // The CLI must have no local tool registry — names/descriptions come from the server.
    const home = mkHome()
    const stub = await startMcpStub(
      [{ name: 'get_burn_status', description: 'Burn status. More text.' }, { name: 'get_recent_sessions', description: 'Recent.' }],
      () => ({}),
    )
    try {
      const r = await runCli(['list', '--desc'], isolatedEnv(home, { AGENTLENS_MCP_URL: stub.url }))
      assert.strictEqual(r.code, 0, `stderr: ${r.stderr}`)
      assert.ok(r.stdout.includes('get_burn_status — Burn status'), r.stdout)
      assert.ok(r.stdout.includes('get_recent_sessions — Recent'), r.stdout)
    } finally { await stub.close(); fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('`list --definitely-not-a-real-flag` exits 64 instead of silently ignoring the typo (TRDD-PIB6T4RU)', async () => {
    const home = mkHome()
    const stub = await startMcpStub([{ name: 'get_burn_status', description: 'x' }], () => ({}))
    try {
      const r = await runCli(['list', '--definitely-not-a-real-flag'], isolatedEnv(home, { AGENTLENS_MCP_URL: stub.url }))
      assert.strictEqual(r.code, 64, `stderr: ${r.stderr}`)
      assert.ok(r.stderr.includes('--definitely-not-a-real-flag'), r.stderr)
    } finally { await stub.close(); fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('a tool subcommand maps --flags by the live schema and prints the tool result JSON', async () => {
    // Flag coercion (number) + dispatch through tools/call with the parsed arguments.
    const home = mkHome()
    const stub = await startMcpStub(
      [{ name: 'get_burn_status', description: 'x', inputSchema: { properties: { topN: { type: 'number' } } } }],
      (name) => ({ verdict: `ok:${name}` }),
    )
    try {
      const r = await runCli(['get_burn_status', '--topN', '5'], isolatedEnv(home, { AGENTLENS_MCP_URL: stub.url }))
      assert.strictEqual(r.code, 0, `stderr: ${r.stderr}`)
      assert.ok(r.stdout.includes('ok:get_burn_status'), r.stdout)
      const call = stub.calls.find(c => c.method === 'tools/call')
      assert.ok(call, 'tools/call must have been issued')
      assert.deepStrictEqual((call.params as { arguments: unknown }).arguments, { topN: 5 })
    } finally { await stub.close(); fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('an unknown flag exits 64 (EX_USAGE) with the valid flag list — never silently ignored, never mistaken for an abort', async () => {
    const home = mkHome()
    const stub = await startMcpStub(
      [{ name: 'get_burn_status', description: 'x', inputSchema: { properties: { topN: { type: 'number' } } } }],
      () => ({}),
    )
    try {
      const r = await runCli(['get_burn_status', '--nope', '1'], isolatedEnv(home, { AGENTLENS_MCP_URL: stub.url }))
      assert.strictEqual(r.code, 64, 'a bad flag must exit EX_USAGE 64 — the tool help promises it, and 1 is the watch ABORT signal')
      assert.ok(r.stderr.includes('unknown flag --nope'), r.stderr)
      assert.ok(!stub.calls.some(c => c.method === 'tools/call'), 'no tool call may be issued for a bad flag')
    } finally { await stub.close(); fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('an unknown COMMAND exits 64 (EX_USAGE) and names the valid tools — a typo must not look like a runtime failure', async () => {
    // Field defect (issue #9 follow-up): a typo'd tool name exited 1 — the same code budget/watch
    // use for "abort the guarded run" — while the tool help had promised "64 = bad command line".
    const home = mkHome()
    const stub = await startMcpStub([{ name: 'get_burn_status', description: 'x' }], () => ({}))
    try {
      const r = await runCli(['get_burn_statsu'], isolatedEnv(home, { AGENTLENS_MCP_URL: stub.url }))
      assert.strictEqual(r.code, 64, `stderr: ${r.stderr}`)
      assert.ok(r.stderr.includes('get_burn_status'), 'the refusal must name the valid tools')
      assert.ok(!stub.calls.some(c => c.method === 'tools/call'), 'nothing may execute on a typo')
    } finally { await stub.close(); fs.rmSync(home, { recursive: true, force: true }) }
  })

  // ── the refusal contract (issue #9 §1) ───────────────────────────────────────────────────
  // A tool that REFUSES used to print `{error: …}` on stdout and exit 0, so a consuming program
  // doing `if rc != 0: don't parse` — the near-universal habit, and what the janitor's rotator was
  // about to rely on — read the refusal as an answer. exit 0 must mean "stdout is a result".
  test('a tool-level refusal exits non-zero, keeps stdout EMPTY, and reports on stderr', async () => {
    const home = mkHome()
    const stub = await startMcpStub(
      [{ name: 'get_agent_tokens', description: 'x', inputSchema: { properties: { agentId: { type: 'string' } } } }],
      () => ({ error: 'Agent "nope" not found. Accepted forms: bare agent id, agent-<id>, or a full sessionId.' }),
    )
    try {
      const r = await runCli(['get_agent_tokens', '--agentId', 'nope'], isolatedEnv(home, { AGENTLENS_MCP_URL: stub.url }))
      assert.notStrictEqual(r.code, 0, 'a refusal must not exit 0')
      assert.strictEqual(r.stdout.trim(), '', `stdout must stay parse-safe, got: ${r.stdout}`)
      const payload = JSON.parse(r.stderr) as { tool: string; error: string }
      assert.strictEqual(payload.tool, 'get_agent_tokens')
      assert.ok(payload.error.includes('not found'), r.stderr)
    } finally { await stub.close(); fs.rmSync(home, { recursive: true, force: true }) }
  })

  // ── `--json` is a GLOBAL (issue #9 §2) ───────────────────────────────────────────────────
  // It was accepted by the hand-written subcommands and rejected as "unknown flag --json" by every
  // schema-driven tool, so a program had to know which kind of command it was calling before it
  // could ask for JSON.
  test('--json is accepted by a schema-driven tool and yields parseable JSON', async () => {
    const home = mkHome()
    const stub = await startMcpStub(
      [{ name: 'get_burn_status', description: 'x' }],
      () => ({ format: 'table', text: 'a rendered table\nwith lines', extra: 1 }),
    )
    try {
      const r = await runCli(['get_burn_status', '--json'], isolatedEnv(home, { AGENTLENS_MCP_URL: stub.url }))
      assert.strictEqual(r.code, 0, `stderr: ${r.stderr}`)
      const parsed = JSON.parse(r.stdout) as { format: string; extra: number }
      assert.strictEqual(parsed.format, 'table', 'the caller asked for JSON, so the rendering must NOT win')
      assert.strictEqual(parsed.extra, 1)
    } finally { await stub.close(); fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('without --json a self-rendering tool still prints its table, not JSON', async () => {
    const home = mkHome()
    const stub = await startMcpStub(
      [{ name: 'get_burn_status', description: 'x' }],
      () => ({ format: 'table', text: 'a rendered table' }),
    )
    try {
      const r = await runCli(['get_burn_status'], isolatedEnv(home, { AGENTLENS_MCP_URL: stub.url }))
      assert.strictEqual(r.code, 0, `stderr: ${r.stderr}`)
      assert.ok(r.stdout.includes('a rendered table'), r.stdout)
      assert.ok(!r.stdout.trim().startsWith('{'), 'the human default must survive the new global')
    } finally { await stub.close(); fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('a refusal does NOT write --out — a file containing an error is worse than no file', async () => {
    const home = mkHome()
    const out = path.join(home, 'result.json')
    const stub = await startMcpStub(
      [{ name: 'get_agent_tokens', description: 'x', inputSchema: { properties: { agentId: { type: 'string' } } } }],
      () => ({ error: 'nope' }),
    )
    try {
      const r = await runCli(['get_agent_tokens', '--agentId', 'x', '--out', out], isolatedEnv(home, { AGENTLENS_MCP_URL: stub.url }))
      assert.notStrictEqual(r.code, 0)
      assert.ok(!fs.existsSync(out), 'the next reader would find that file and trust it')
    } finally { await stub.close(); fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('a SUCCESS still exits 0 with the payload on stdout — the contract cuts one way only', async () => {
    const home = mkHome()
    const stub = await startMcpStub(
      [{ name: 'get_burn_status', description: 'x' }],
      () => ({ verdict: 'quiet', errorRate: 0.02 }), // an `error`-ish KEY that is not a refusal
    )
    try {
      const r = await runCli(['get_burn_status'], isolatedEnv(home, { AGENTLENS_MCP_URL: stub.url }))
      assert.strictEqual(r.code, 0, `stderr: ${r.stderr}`)
      assert.ok(r.stdout.includes('quiet'), r.stdout)
    } finally { await stub.close(); fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('one refused member makes a batch non-zero, and the siblings still run', async () => {
    const home = mkHome()
    const stub = await startMcpStub(
      [{ name: 'a', description: 'x' }, { name: 'b', description: 'x' }],
      (name) => (name === 'a' ? { error: 'refused' } : { ok: 'second ran' }),
    )
    try {
      const r = await runCli(['batch', '[{"tool":"a"},{"tool":"b"}]'], isolatedEnv(home, { AGENTLENS_MCP_URL: stub.url }))
      assert.notStrictEqual(r.code, 0, 'a refused member must not be hidden by a successful sibling')
      assert.ok(r.stderr.includes('refused'), r.stderr)
      assert.ok(r.stdout.includes('second ran'), r.stdout)
    } finally { await stub.close(); fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('`heartbeat-cost --oneline` prints the verdict from get_heartbeat_cost (absorbed bin parity)', async () => {
    const home = mkHome()
    const stub = await startMcpStub([], () => ({
      fireDetected: true, verdict: 'fire cost $0.1234 (42,000 tokens)', fireStartedAt: '', durationSeconds: 1,
      apiCalls: 2, agentSpawns: 0, sessionId: 's', byModel: [], callsByToolSurface: [], concurrent: { calls: 0, note: '' },
      tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, totalTokens: 42000, ephemeral5mTokens: 0, ephemeral1hTokens: 0 },
      cost: { inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, cacheWriteUsd: 0, totalUsd: 0.1234 },
    }))
    try {
      const r = await runCli(['heartbeat-cost', '--oneline'], isolatedEnv(home, { AGENTLENS_MCP_URL: stub.url }))
      assert.strictEqual(r.code, 0, `stderr: ${r.stderr}`)
      assert.strictEqual(r.stdout.trim(), 'fire cost $0.1234 (42,000 tokens)')
    } finally { await stub.close(); fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('`heartbeat-cost` fails fast (non-zero) when the server is unreachable — no silent fallback', async () => {
    const home = mkHome()
    try {
      const r = await runCli(['heartbeat-cost'], isolatedEnv(home, { AGENTLENS_MCP_URL: 'http://127.0.0.1:1/mcp' }))
      assert.notStrictEqual(r.code, 0)
      assert.ok(r.stderr.includes('FAIL'), r.stderr)
      assert.deepStrictEqual(fs.readdirSync(home), [], 'a failed call must not create anything under HOME')
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('`server status` against dead ports reports NOT RUNNING and exits 0 (a status probe is not an error)', async () => {
    const home = mkHome()
    try {
      const r = await runCli(['server', 'status'], isolatedEnv(home, {
        AGENTLENS_UI_URL: 'http://127.0.0.1:1',
        AGENTLENS_MCP_URL: 'http://127.0.0.1:1/mcp',
        DATA_DIR: path.join(home, '.agentlens'),
      }))
      assert.strictEqual(r.code, 0, `stderr: ${r.stderr}`)
      assert.ok(r.stdout.includes('NOT RUNNING'), r.stdout)
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('`server status` against a stalled probe with a LIVE pidfile reports RUNNING, never NOT RUNNING (TRDD-TABN063T)', async () => {
    // MEASURED false negative: a busy/GC-thrashing server can lose the 800ms connect deadline even
    // though the process is alive. Simulated here with a live pid (our own test runner) and a
    // connect target that never answers (127.0.0.1:1 refuses instantly, so this proves the pid
    // check alone is enough to flip the verdict, independent of which flavor of unreachable fired).
    const home = mkHome()
    const dataDir = path.join(home, '.agentlens')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'server.pid'), JSON.stringify({ pid: process.pid, start: null }))
    try {
      const r = await runCli(['server', 'status'], isolatedEnv(home, {
        AGENTLENS_UI_URL: 'http://127.0.0.1:1',
        AGENTLENS_MCP_URL: 'http://127.0.0.1:1/mcp',
        DATA_DIR: dataDir,
      }))
      assert.strictEqual(r.code, 0, `stderr: ${r.stderr}`)
      assert.ok(r.stdout.includes('RUNNING'), r.stdout)
      assert.ok(!r.stdout.includes('NOT RUNNING'), r.stdout)
      assert.ok(r.stdout.includes(String(process.pid)), r.stdout)
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('`server status --x` exits 64 instead of silently ignoring the typo (TRDD-PIB6T4RU)', async () => {
    const home = mkHome()
    try {
      const r = await runCli(['server', 'status', '--x'], isolatedEnv(home, {
        AGENTLENS_UI_URL: 'http://127.0.0.1:1',
        AGENTLENS_MCP_URL: 'http://127.0.0.1:1/mcp',
        DATA_DIR: path.join(home, '.agentlens'),
      }))
      assert.strictEqual(r.code, 64, `stderr: ${r.stderr}`)
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  // ── `cache-expired`: a boolean a shell can branch on (2026-08-04) ────────────────────────────
  // The verdict itself is check_cache_expiry's; what is pinned here is the SHAPE, because that is
  // the whole reason the verb exists: one word on stdout, an exit code that separates EXPIRED from
  // fresh from cannot-answer, and — the load-bearing one — never the word 'false' for a question
  // that could not be resolved. "Warm" and "I don't know" lead to opposite decisions.
  function expiryStub(row: Record<string, unknown> | null, scope?: Record<string, unknown>): Promise<McpStub> {
    return startMcpStub(
      [{ name: 'check_cache_expiry', description: 'x', inputSchema: { properties: { project: { type: 'string' }, sessionId: { type: 'string' } } } }],
      () => ({ sessions: row ? [row] : [], ...(scope ? { scope } : {}) }),
    )
  }
  const EXPIRED = { verdict: 'expired', sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', workspace: '/my/repo', idleHuman: '2h 5m', ttlMin: 60 }
  const FRESH = { ...EXPIRED, verdict: 'fresh', idleHuman: '3m 0s' }

  test('an EXPIRED cache prints exactly `true` on stdout and exits 0', async () => {
    const home = mkHome()
    const stub = await expiryStub(EXPIRED)
    try {
      const r = await runCli(['cache-expired'], isolatedEnv(home, { AGENTLENS_MCP_URL: stub.url }))
      assert.strictEqual(r.code, 0, `stderr: ${r.stderr}`)
      assert.strictEqual(r.stdout, 'true\n', 'stdout must be the word alone — it is parsed as a value')
      assert.ok(r.stderr.includes('/my/repo'), 'the measured session goes to stderr, never stdout')
    } finally { await stub.close(); fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('a FRESH cache prints exactly `false` and still exits 0 — the word is the answer', async () => {
    const home = mkHome()
    const stub = await expiryStub(FRESH)
    try {
      const r = await runCli(['cache-expired'], isolatedEnv(home, { AGENTLENS_MCP_URL: stub.url }))
      assert.strictEqual(r.code, 0, `stderr: ${r.stderr}`)
      assert.strictEqual(r.stdout, 'false\n')
    } finally { await stub.close(); fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('--quiet is a pure predicate: 0 = expired, 1 = fresh, and NOTHING on stdout', async () => {
    const home = mkHome()
    const hot = await expiryStub(EXPIRED)
    try {
      const r = await runCli(['cache-expired', '-q'], isolatedEnv(home, { AGENTLENS_MCP_URL: hot.url }))
      assert.strictEqual(r.code, 0, `expired must be the shell-true branch: ${r.stderr}`)
      assert.strictEqual(r.stdout, '', 'quiet means quiet')
    } finally { await hot.close() }
    const warm = await expiryStub(FRESH)
    try {
      const r = await runCli(['cache-expired', '--quiet'], isolatedEnv(home, { AGENTLENS_MCP_URL: warm.url }))
      assert.strictEqual(r.code, 1, `fresh must be the shell-false branch: ${r.stderr}`)
      assert.strictEqual(r.stdout, '')
    } finally { await warm.close(); fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('the CLI scopes the question to the caller\'s project by default', async () => {
    const home = mkHome()
    const stub = await expiryStub(EXPIRED)
    try {
      await runCli(['cache-expired'], isolatedEnv(home, { AGENTLENS_MCP_URL: stub.url }))
      const call = stub.calls.find(c => c.method === 'tools/call')
      const sent = (call?.params as { arguments: { project?: string } }).arguments
      assert.strictEqual(sent.project, process.cwd(), 'an unscoped question answers about the wrong repo')
    } finally { await stub.close(); fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('an UNKNOWN verdict exits 2 with stdout EMPTY — never the word `false`', async () => {
    // The defect this guards: 'unknown' means no LLM call was ever recorded, which is not "warm".
    const home = mkHome()
    const stub = await expiryStub({ verdict: 'unknown', sessionId: 'bbbb2222-1111-2222-3333-444444444444', reason: 'no LLM request recorded for this session' })
    try {
      const r = await runCli(['cache-expired'], isolatedEnv(home, { AGENTLENS_MCP_URL: stub.url }))
      assert.strictEqual(r.code, 2, `stderr: ${r.stderr}`)
      assert.strictEqual(r.stdout, '', 'an unresolvable question must print no verdict at all')
      assert.ok(r.stderr.includes('cannot answer'), r.stderr)
    } finally { await stub.close(); fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('no session in scope exits 2 and names the project it looked in', async () => {
    const home = mkHome()
    const stub = await expiryStub(null, { project: '/my/repo', sessionsInScope: 0 })
    try {
      const r = await runCli(['cache-expired'], isolatedEnv(home, { AGENTLENS_MCP_URL: stub.url }))
      assert.strictEqual(r.code, 2)
      assert.strictEqual(r.stdout, '')
      assert.ok(r.stderr.includes('/my/repo'), r.stderr)
    } finally { await stub.close(); fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('an unreachable server exits 2, NOT 1 — in --quiet mode 1 would read as "fresh"', async () => {
    const home = mkHome()
    try {
      const r = await runCli(['cache-expired', '-q'], isolatedEnv(home, { AGENTLENS_MCP_URL: 'http://127.0.0.1:1/mcp' }))
      assert.strictEqual(r.code, 2, `a transport failure must never be reported as a verdict: ${r.stderr}`)
      assert.strictEqual(r.stdout, '')
      assert.ok(r.stderr.includes('server'), r.stderr)
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('a bad flag exits 64 (EX_USAGE), so a typo can never masquerade as a verdict', async () => {
    const home = mkHome()
    try {
      const r = await runCli(['cache-expired', '--treshold-minutes', '60'], isolatedEnv(home))
      assert.strictEqual(r.code, 64, `stderr: ${r.stderr}`)
      assert.strictEqual(r.stdout, '')
      // The message must name the TYPO'D FLAG. Asserting only the exit code passed against a build
      // where the verb did not exist at all (unknown *command* is also 64) — a test that is green
      // before the feature ships is measuring nothing.
      assert.ok(r.stderr.includes('--treshold-minutes'), `the refusal must name the flag: ${r.stderr}`)
      assert.ok(r.stderr.includes('cache-expired --help'), `and point at the verb's own help: ${r.stderr}`)
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  // ── `last-compact`: the delta, off disk, with no server (2026-08-04) ─────────────────────────
  // Spawns the REAL bundle against a temp DATA_DIR holding a real hook-event bucket — no MCP stub,
  // because the whole point of this verb is that it answers while the server is down.
  function seedCompact(home: string, atMs: number, cwd: string, trigger = 'manual'): string {
    const dataDir = path.join(home, '.agentlens')
    const dir = path.join(dataDir, 'hook-events')
    fs.mkdirSync(dir, { recursive: true })
    const rec = {
      ts: atMs, ev: 'PreCompact', session: 'cccc3333-1111-2222-3333-444444444444',
      payload: { hook_event_name: 'PreCompact', session_id: 'cccc3333-1111-2222-3333-444444444444', cwd, trigger },
    }
    fs.appendFileSync(path.join(dir, `${new Date(atMs).toISOString().slice(0, 10)}.ndjsonl`), `${JSON.stringify(rec)}\n`)
    return dataDir
  }

  test('prints the AGE of the last compaction, with the trigger on stderr', async () => {
    const home = mkHome()
    try {
      const project = fs.mkdtempSync(path.join(os.tmpdir(), 'al-proj-'))
      const dataDir = seedCompact(home, Date.now() - (2 * 3600 + 14 * 60) * 1000, project, 'auto')
      const r = await runCli(['last-compact', '--project', project], isolatedEnv(home, { DATA_DIR: dataDir }))
      assert.strictEqual(r.code, 0, `stderr: ${r.stderr}`)
      assert.strictEqual(r.stdout.trim(), '2h 14m', 'stdout is the delta alone')
      assert.ok(r.stderr.includes('auto compact'), `the trigger belongs in the answer: ${r.stderr}`)
      fs.rmSync(project, { recursive: true, force: true })
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('--seconds prints a bare integer a shell can compare', async () => {
    const home = mkHome()
    try {
      const project = fs.mkdtempSync(path.join(os.tmpdir(), 'al-proj-'))
      const dataDir = seedCompact(home, Date.now() - 90_000, project)
      const r = await runCli(['last-compact', '--project', project, '--seconds'], isolatedEnv(home, { DATA_DIR: dataDir }))
      assert.strictEqual(r.code, 0, `stderr: ${r.stderr}`)
      const secs = Number(r.stdout.trim())
      assert.ok(Number.isInteger(secs) && secs >= 89 && secs <= 95, `expected ~90, got "${r.stdout.trim()}"`)
      fs.rmSync(project, { recursive: true, force: true })
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('NO compaction on record exits 2 with stdout EMPTY — never "0"', async () => {
    // The mistake this forbids: `age=$(last-compact --seconds)` yielding 0 for a project that has
    // never compacted would assert the opposite of the truth (just compacted).
    const home = mkHome()
    try {
      const project = fs.mkdtempSync(path.join(os.tmpdir(), 'al-proj-'))
      const other = fs.mkdtempSync(path.join(os.tmpdir(), 'al-other-'))
      const dataDir = seedCompact(home, Date.now() - 60_000, other)
      const r = await runCli(['last-compact', '--project', project], isolatedEnv(home, { DATA_DIR: dataDir }))
      assert.strictEqual(r.code, 2, `stderr: ${r.stderr}`)
      assert.strictEqual(r.stdout, '', 'an unknown age must print no number at all')
      assert.ok(r.stderr.includes('cannot answer'), r.stderr)
      fs.rmSync(project, { recursive: true, force: true })
      fs.rmSync(other, { recursive: true, force: true })
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('an empty store (capture never installed) exits 2 and says so', async () => {
    const home = mkHome()
    try {
      const r = await runCli(['last-compact'], isolatedEnv(home, { DATA_DIR: path.join(home, '.agentlens') }))
      assert.strictEqual(r.code, 2)
      assert.strictEqual(r.stdout, '')
      assert.ok(r.stderr.includes('install-hooks'), `the cause must be actionable: ${r.stderr}`)
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('--json carries the record; --trigger narrows to one kind', async () => {
    const home = mkHome()
    try {
      const project = fs.mkdtempSync(path.join(os.tmpdir(), 'al-proj-'))
      const dataDir = seedCompact(home, Date.now() - 3 * 3_600_000, project, 'manual')
      seedCompact(home, Date.now() - 600_000, project, 'auto')
      const env = isolatedEnv(home, { DATA_DIR: dataDir })
      const j = await runCli(['last-compact', '--project', project, '--json'], env)
      assert.strictEqual(j.code, 0, `stderr: ${j.stderr}`)
      const parsed = JSON.parse(j.stdout) as { found: boolean; trigger: string; ageSeconds: number }
      assert.strictEqual(parsed.found, true)
      assert.strictEqual(parsed.trigger, 'auto', 'the newest wins by default')
      const m = await runCli(['last-compact', '--project', project, '--trigger', 'manual', '--seconds'], env)
      assert.ok(Number(m.stdout.trim()) > 10_000, `--trigger manual must reach past the auto one: ${m.stdout}`)
      fs.rmSync(project, { recursive: true, force: true })
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('a bad flag or a bad --trigger exits 64, naming what was wrong', async () => {
    const home = mkHome()
    try {
      const bad = await runCli(['last-compact', '--windodays', '3'], isolatedEnv(home))
      assert.strictEqual(bad.code, 64, `stderr: ${bad.stderr}`)
      assert.ok(bad.stderr.includes('--windodays'), bad.stderr)
      assert.ok(bad.stderr.includes('last-compact --help'), bad.stderr)
      const trig = await runCli(['last-compact', '--trigger', 'sometimes'], isolatedEnv(home))
      assert.strictEqual(trig.code, 64, `stderr: ${trig.stderr}`)
      assert.ok(trig.stderr.includes('manual|auto'), trig.stderr)
      assert.strictEqual(trig.stdout, '')
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('`server frobnicate` rejects the unknown verb with a usage error (non-zero)', async () => {
    const home = mkHome()
    try {
      const r = await runCli(['server', 'frobnicate'], isolatedEnv(home))
      assert.notStrictEqual(r.code, 0)
      assert.ok(r.stderr.includes('start|stop|restart|status'), r.stderr)
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })
})

suite('agentlenspro — help is TOTAL: --help anywhere never executes the verb', () => {
  // Owner directive 2026-08-05, from a live incident: `agentlenspro disable --help` EXECUTED the
  // disable — it armed <dataDir>/DISABLED, stopped the running server, disarmed every hook on the
  // machine and stripped the telemetry env, because runDisableCli folds non-flag args into the
  // reason and acts unconditionally. The guarantee cannot live verb-by-verb (any new verb can
  // regress it), so it lives in the dispatcher: `--help`/`-h` anywhere in argv routes to help and
  // NOTHING is dispatched — the git/npm contract (`git commit --help` never commits).

  test('disable --help does NOT arm the kill-switch (the incident, exactly)', async () => {
    const home = mkHome()
    try {
      const r = await runCli(['disable', '--help'], isolatedEnv(home))
      assert.strictEqual(r.code, 0, `stderr: ${r.stderr}`)
      const flag = path.join(home, '.agentlens', 'DISABLED')
      assert.ok(!fs.existsSync(flag), 'a help probe must never create the DISABLED flag')
      assert.match(r.stdout, /usage/i, 'help output must actually be help')
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('disable -h is the same contract as --help', async () => {
    const home = mkHome()
    try {
      const r = await runCli(['disable', '-h'], isolatedEnv(home))
      assert.strictEqual(r.code, 0, `stderr: ${r.stderr}`)
      assert.ok(!fs.existsSync(path.join(home, '.agentlens', 'DISABLED')))
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('every management verb with --help exits 0, prints help, and leaves HOME untouched', async function () {
    this.timeout(60_000)
    // The full verb surface from the dispatch switch. Hot-path verbs (hook/gate/statusline) are
    // included deliberately: help must win over their read-stdin behavior too, or a probe hangs.
    const verbs = [
      'disable', 'enable', 'telemetry', 'setup', 'server', 'daemon', 'config', 'env', 'spool',
      'budget', 'watch', 'heartbeat-cost', 'statusline-history', 'cache-expired', 'last-compact',
      'ctxmap', 'ctxvis', 'hook', 'gate', 'statusline', 'list',
    ]
    for (const verb of verbs) {
      const home = mkHome()
      try {
        const r = await runCli([verb, '--help'], isolatedEnv(home))
        assert.strictEqual(r.code, 0, `\`${verb} --help\` must exit 0 — stderr: ${r.stderr}`)
        assert.ok(r.stdout.length > 0, `\`${verb} --help\` must print SOMETHING`)
        assert.deepStrictEqual(
          fs.readdirSync(home), [],
          `\`${verb} --help\` mutated HOME — a help probe executed the verb`,
        )
      } finally { fs.rmSync(home, { recursive: true, force: true }) }
    }
  })

  test('--help placed late in a longer argv still wins (flags after real-looking args)', async () => {
    const home = mkHome()
    try {
      const r = await runCli(['disable', 'because', 'reasons', '--help'], isolatedEnv(home))
      assert.strictEqual(r.code, 0)
      assert.ok(!fs.existsSync(path.join(home, '.agentlens', 'DISABLED')),
        'the reason-looking args must not smuggle the verb past the help intercept')
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })
})

suite('agentlenspro — management help never touches the network (PR-15 review)', () => {
  test('disable --help completes fast against an accept-then-hang MCP endpoint', async function () {
    this.timeout(30_000)
    // The first help-total cut routed EVERY `X --help` through the diagnostics help path, which
    // initializes the MCP client — so static help for a management verb waited on a wedged
    // socket. A management verb's help must come from USAGE with zero I/O: against a server
    // that accepts and never answers, it must return in well under the client's connect/read
    // deadlines (the unfixed path burned them in full).
    // The falsifier is the CONNECTION COUNT, not wall-clock: the diagnostics client's own
    // connect deadline keeps even the unfixed path under any sane timing bound (measured — a
    // duration assertion passed both ways). Unfixed code opens ≥1 connection to fetch a schema
    // it will never use for static text; fixed code opens exactly 0.
    let connections = 0
    const hang = http.createServer(() => { /* accept, never respond */ })
    hang.on('connection', () => { connections++ })
    await new Promise<void>(r => hang.listen(0, '127.0.0.1', r))
    const port = String((hang.address() as AddressInfo).port)
    const home = mkHome()
    try {
      // The wedged-server precondition: a live-looking pidfile, so the client would dial.
      fs.mkdirSync(path.join(home, '.agentlens'), { recursive: true })
      fs.writeFileSync(path.join(home, '.agentlens', 'server.pid'), String(process.pid))
      const r = await runCli(['disable', '--help'], isolatedEnv(home, { MCP_PORT: port, UI_PORT: port }))
      assert.strictEqual(r.code, 0, `stderr: ${r.stderr}`)
      assert.match(r.stdout, /usage/i)
      assert.ok(!fs.existsSync(path.join(home, '.agentlens', 'DISABLED')))
      assert.strictEqual(connections, 0, 'management help must open ZERO connections')
    } finally { hang.close(); fs.rmSync(home, { recursive: true, force: true }) }
  })
})
