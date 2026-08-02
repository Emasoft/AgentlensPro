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

  test('an unknown flag fails fast (non-zero) with the valid flag list — never a silently-ignored argument', async () => {
    const home = mkHome()
    const stub = await startMcpStub(
      [{ name: 'get_burn_status', description: 'x', inputSchema: { properties: { topN: { type: 'number' } } } }],
      () => ({}),
    )
    try {
      const r = await runCli(['get_burn_status', '--nope', '1'], isolatedEnv(home, { AGENTLENS_MCP_URL: stub.url }))
      assert.notStrictEqual(r.code, 0, 'unknown flag must exit non-zero')
      assert.ok(r.stderr.includes('unknown flag --nope'), r.stderr)
      assert.ok(!stub.calls.some(c => c.method === 'tools/call'), 'no tool call may be issued for a bad flag')
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

  test('`server frobnicate` rejects the unknown verb with a usage error (non-zero)', async () => {
    const home = mkHome()
    try {
      const r = await runCli(['server', 'frobnicate'], isolatedEnv(home))
      assert.notStrictEqual(r.code, 0)
      assert.ok(r.stderr.includes('start|stop|restart|status'), r.stderr)
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })
})
