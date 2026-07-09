import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { buildHeartbeatCost } from '../heartbeatCost'

// REAL tests: they write actual OTEL request/response bodies to a tmp dir and drive the real disk scan,
// the real fire detection, and the real previous_message_id chain — no mocks.

const MARKER = '[janitor-heartbeat]'
const SESSION = 'hb00feed-1111-2222'

function userId(sessionId: string): string {
  return JSON.stringify({ device_id: 'dev-1', account_uuid: 'acct-1', session_id: sessionId })
}

/** A request body modelled on what Claude Code ACTUALLY emits.
 *
 *  Critically: the harness appends the UserPromptSubmit hook's output as a TRAILING `role:"system"`
 *  message, so the real user prompt is NOT the last message. An earlier fixture omitted this and the
 *  detector passed every test while failing on every real fire. `hookTail` reproduces it.
 */
function reqBody(o: { lastUserText?: string; lastIsToolResult?: boolean; prev?: string; history?: string; tools?: number; hookTail?: boolean }): string {
  const messages: unknown[] = [{ role: 'user', content: [{ type: 'text', text: o.history ?? 'earlier conversation' }] }]
  messages.push(o.lastIsToolResult
    ? { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] }
    : { role: 'user', content: [{ type: 'text', text: o.lastUserText ?? 'hello' }] })
  if (o.hookTail !== false) {
    messages.push({ role: 'system', content: [{ type: 'text', text: 'UserPromptSubmit hook additional context: <pss-skills> foo (HIGH)' }] })
  }
  return JSON.stringify({
    model: 'claude-opus-4-8',
    tools: Array.from({ length: o.tools ?? 5 }, (_, i) => ({ name: `T${i}` })),
    messages,
    metadata: { user_id: userId(SESSION) },
    diagnostics: o.prev ? { previous_message_id: o.prev } : undefined,
  })
}

function respBody(id: string, u: { input: number; output: number; read: number; create: number }): string {
  return JSON.stringify({
    id, model: 'claude-opus-4-8',
    usage: {
      input_tokens: u.input, output_tokens: u.output,
      cache_read_input_tokens: u.read, cache_creation_input_tokens: u.create,
      cache_creation: { ephemeral_5m_input_tokens: u.create, ephemeral_1h_input_tokens: 0 },
    },
  })
}

/** Write a body and stamp its mtime so the scan's ordering is deterministic. */
function write(dir: string, name: string, content: string, mtimeMs: number): void {
  const p = path.join(dir, name)
  fs.writeFileSync(p, content)
  const t = mtimeMs / 1000
  fs.utimesSync(p, t, t)
}

function makeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-hb-'))
  const t0 = Date.now() - 10 * 60_000

  // c0 = FIRE START. c1, c2 = the fire's follow-up calls (one is a sub-agent: different tool count).
  // c3 = the NEXT fire start, which closes the first fire and settles c2's usage.
  write(dir, 'c0.request.json', reqBody({ lastUserText: `${MARKER}\n/path/to/stub.py`, prev: 'msg_seed' }), t0)
  write(dir, 'c1.request.json', reqBody({ lastIsToolResult: true, prev: 'msg_A', history: `mentions ${MARKER} in history` }), t0 + 1000)
  write(dir, 'c2.request.json', reqBody({ lastIsToolResult: true, prev: 'msg_B', tools: 9 }), t0 + 2000)
  write(dir, 'c3.request.json', reqBody({ lastUserText: `${MARKER}\n/path/to/stub.py`, prev: 'msg_C' }), t0 + 300_000)

  write(dir, 'req_a.response.json', respBody('msg_A', { input: 10, output: 100, read: 1000, create: 50 }), t0 + 500)
  write(dir, 'req_b.response.json', respBody('msg_B', { input: 20, output: 200, read: 2000, create: 60 }), t0 + 1500)
  write(dir, 'req_c.response.json', respBody('msg_C', { input: 30, output: 300, read: 3000, create: 70 }), t0 + 2500)
  return dir
}

suite('heartbeatCost — exact per-fire accounting', () => {
  let dir: string
  suiteSetup(() => { dir = makeFixture() })
  suiteTeardown(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  test('detects the fire and sums EVERY bucket exactly across all its calls', async () => {
    const r = await buildHeartbeatCost({ bodiesDir: dir, marker: MARKER, windowHours: 1 })
    assert.strictEqual(r.fireDetected, true)
    assert.strictEqual(r.sessionId, SESSION)
    assert.strictEqual(r.apiCalls, 3, 'the fire is c0..c2 (c3 starts the next fire)')
    assert.strictEqual(r.tokens.inputTokens, 60)
    assert.strictEqual(r.tokens.outputTokens, 600)
    assert.strictEqual(r.tokens.cacheReadTokens, 6000)
    assert.strictEqual(r.tokens.cacheCreateTokens, 180)
    assert.strictEqual(r.tokens.totalTokens, 6840)
    assert.strictEqual(r.inFlight, null, 'every call of a completed fire has settled')
  })

  test('the marker appearing in message HISTORY is not a fire start', async () => {
    // c1 carries the marker in an earlier message but its LAST message is a tool_result. A naive
    // raw.includes(marker) would treat it as a fire and split the fire in two, halving the reported cost.
    const r = await buildHeartbeatCost({ bodiesDir: dir, marker: MARKER, windowHours: 1 })
    assert.strictEqual(r.apiCalls, 3)
    assert.strictEqual(r.fireStartedAt, new Date(fs.statSync(path.join(dir, 'c0.request.json')).mtimeMs).toISOString())
  })

  test('REGRESSION: a trailing hook/system message must not hide the fire start', async () => {
    // Claude Code appends the UserPromptSubmit hook output as a trailing role:"system" message, so the
    // real user prompt is second-to-last. A detector that only inspects messages[last] finds ZERO fires
    // on real data while passing a fixture that omits the tail. Every fixture body here carries the tail.
    const r = await buildHeartbeatCost({ bodiesDir: dir, marker: MARKER, windowHours: 1 })
    assert.strictEqual(r.fireDetected, true, 'fire must be detected despite the trailing system message')
    assert.strictEqual(r.apiCalls, 3)
  })

  test('a differing tool count surfaces the sub-agent stream', async () => {
    const r = await buildHeartbeatCost({ bodiesDir: dir, marker: MARKER, windowHours: 1 })
    const surfaces = r.callsByToolSurface.map(s => s.tools).sort((a, b) => a - b)
    assert.deepStrictEqual(surfaces, [5, 9], 'c2 ran with a different tool surface (a sub-agent)')
  })

  test('per-bucket dollars sum to the reported total', async () => {
    const r = await buildHeartbeatCost({ bodiesDir: dir, marker: MARKER, windowHours: 1 })
    const sum = r.cost.inputUsd + r.cost.outputUsd + r.cost.cacheReadUsd + r.cost.cacheWriteUsd
    assert.ok(Math.abs(sum - r.cost.totalUsd) < 1e-6, `${sum} != ${r.cost.totalUsd}`)
    assert.ok(r.cost.totalUsd > 0)
  })

  test('fire:"current" reports the newest fire and DISCLOSES its unsettled tail', async () => {
    // c3 is the newest fire start and has no following call, so its usage cannot exist yet. It must be
    // excluded from the totals AND surfaced in inFlight — never silently dropped.
    const r = await buildHeartbeatCost({ bodiesDir: dir, marker: MARKER, windowHours: 1, fire: 'current' })
    assert.strictEqual(r.apiCalls, 1)
    assert.strictEqual(r.tokens.totalTokens, 0)
    assert.ok(r.inFlight, 'the unsettled call must be disclosed')
    assert.strictEqual(r.inFlight?.calls, 1)
  })

  test('reports no fire (rather than guessing) when the marker never starts a message', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-hb-empty-'))
    try {
      write(empty, 'x.request.json', reqBody({ lastUserText: 'no marker here', prev: 'msg_z' }), Date.now() - 60_000)
      const r = await buildHeartbeatCost({ bodiesDir: empty, marker: MARKER, windowHours: 1 })
      assert.strictEqual(r.fireDetected, false)
      assert.strictEqual(r.tokens.totalTokens, 0)
    } finally { fs.rmSync(empty, { recursive: true, force: true }) }
  })
})
