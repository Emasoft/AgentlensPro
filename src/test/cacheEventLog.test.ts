// Tests for the per-call cache ledger (src/cacheEventLog.ts).
//
// Real fixtures on disk — real OTEL-shaped response/request bodies in a temp bodies dir, and a real
// temp ~/.claude/projects/<slug>/<sessionId>.jsonl ownership tree. Nothing is mocked: the project
// scoping IS the feature's security boundary, so a test that stubbed the ownership lookup would
// prove nothing about the thing that must not break.

import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  buildCacheEventLog, formatCacheEventLog, projectSlugOf, writeScaleOf, WRITE_SCALE_EMOJI,
  type CacheEventLog,
} from '../cacheEventLog'
import { lookupRates } from '../shared/pricing'

const MODEL = 'claude-opus-5'   // input 5.00 · cacheRead 0.50 · cacheWrite 6.25 · output 25.00 /MTok
const PROJECT_A = '-tmp-project-alpha'
const PROJECT_B = '-tmp-project-beta'

interface CallSpec {
  name: string
  session: string
  minute: number                 // minutes after the base instant, controls ordering
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  ttl?: '5m' | '1h'
}

const BASE_MS = Date.parse('2026-07-26T08:00:00Z')

function writeCall(bodiesDir: string, spec: CallSpec): void {
  const id = `msg_${spec.name}`
  const ttl5 = spec.ttl === '5m' ? spec.cacheWrite : 0
  const ttl1 = spec.ttl === '1h' ? spec.cacheWrite : 0
  fs.writeFileSync(path.join(bodiesDir, `${spec.name}.response.json`), JSON.stringify({
    id, model: MODEL,
    usage: {
      input_tokens: spec.input,
      output_tokens: spec.output,
      cache_read_input_tokens: spec.cacheRead,
      cache_creation_input_tokens: spec.cacheWrite,
      cache_creation: { ephemeral_5m_input_tokens: ttl5, ephemeral_1h_input_tokens: ttl1 },
    },
  }))
  // The FOLLOWING request is what attributes the response to a session (previous_message_id chain).
  fs.writeFileSync(path.join(bodiesDir, `${spec.name}.request.json`), JSON.stringify({
    model: MODEL,
    metadata: { user_id: JSON.stringify({ session_id: spec.session, account_uuid: 'acct-1' }) },
    diagnostics: { previous_message_id: id },
  }))
  const when = (BASE_MS + spec.minute * 60_000) / 1000
  fs.utimesSync(path.join(bodiesDir, `${spec.name}.response.json`), when, when)
  fs.utimesSync(path.join(bodiesDir, `${spec.name}.request.json`), when, when)
}

// 8 calls owned by project A (the 4th is by far the costliest — a 200k cache write) plus 2 calls
// owned by project B that must never be printed.
const CALLS: CallSpec[] = [
  { name: 'a1', session: 'sess-a', minute: 1, input: 2, cacheWrite: 300,     cacheRead: 100_000, output: 100, ttl: '1h' },
  { name: 'a2', session: 'sess-a', minute: 2, input: 2, cacheWrite: 300,     cacheRead: 100_000, output: 100, ttl: '1h' },
  { name: 'a3', session: 'sess-a', minute: 3, input: 2, cacheWrite: 300,     cacheRead: 100_000, output: 100, ttl: '1h' },
  { name: 'a4', session: 'sess-a', minute: 4, input: 2, cacheWrite: 200_000, cacheRead: 100_000, output: 100, ttl: '1h' },
  { name: 'a5', session: 'sess-a', minute: 5, input: 2, cacheWrite: 300,     cacheRead: 100_000, output: 100, ttl: '1h' },
  { name: 'a6', session: 'sess-a', minute: 6, input: 2, cacheWrite: 300,     cacheRead: 100_000, output: 100, ttl: '1h' },
  { name: 'a7', session: 'sess-a', minute: 7, input: 2, cacheWrite: 300,     cacheRead: 100_000, output: 100, ttl: '1h' },
  { name: 'a8', session: 'sess-a', minute: 8, input: 2, cacheWrite: 0,       cacheRead: 120_000, output: 50 },
  { name: 'b1', session: 'sess-b', minute: 4, input: 2, cacheWrite: 900_000, cacheRead: 0,       output: 9_000, ttl: '5m' },
  { name: 'b2', session: 'sess-b', minute: 5, input: 2, cacheWrite: 500_000, cacheRead: 0,       output: 500,   ttl: '5m' },
]

let tmpRoot = ''
let bodiesDir = ''
let priorConfigDir: string | undefined

function setup(): void {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-event-log-'))
  bodiesDir = path.join(tmpRoot, 'bodies')
  fs.mkdirSync(bodiesDir, { recursive: true })
  for (const slug of [PROJECT_A, PROJECT_B]) {
    fs.mkdirSync(path.join(tmpRoot, 'claude', 'projects', slug), { recursive: true })
  }
  fs.writeFileSync(path.join(tmpRoot, 'claude', 'projects', PROJECT_A, 'sess-a.jsonl'), '')
  fs.writeFileSync(path.join(tmpRoot, 'claude', 'projects', PROJECT_B, 'sess-b.jsonl'), '')
  for (const c of CALLS) writeCall(bodiesDir, c)
  priorConfigDir = process.env['CLAUDE_CONFIG_DIR']
  process.env['CLAUDE_CONFIG_DIR'] = path.join(tmpRoot, 'claude')
}

function teardown(): void {
  if (priorConfigDir === undefined) delete process.env['CLAUDE_CONFIG_DIR']
  else process.env['CLAUDE_CONFIG_DIR'] = priorConfigDir
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}

// spansDir points at an empty temp dir on purpose: these fixtures exercise the RAW-BODY fallback,
// and without the override the builder would read this machine's real OTEL span store and assert
// against live data.
const build = (over: Parameters<typeof buildCacheEventLog>[0] = {}): Promise<CacheEventLog> =>
  buildCacheEventLog({ project: PROJECT_A, bodiesDir, spansDir: path.join(tmpRoot, 'no-spans'), ...over })

suite('cacheEventLog', () => {
  suiteSetup(setup)
  suiteTeardown(teardown)

  test('maps a cache-write size onto a 0-5 order-of-magnitude marker', () => {
    assert.strictEqual(writeScaleOf(0), 0, 'no write must carry no marker at all')
    assert.strictEqual(writeScaleOf(1), 1)
    assert.strictEqual(writeScaleOf(9_999), 1)
    assert.strictEqual(writeScaleOf(10_000), 2)
    assert.strictEqual(writeScaleOf(50_000), 3)
    assert.strictEqual(writeScaleOf(150_000), 4)
    assert.strictEqual(writeScaleOf(400_000), 5)
    assert.strictEqual(writeScaleOf(9_000_000), 5, 'the scale saturates at 5, it does not overflow')
  })

  test('accepts either an absolute path or an already-formed project slug', () => {
    assert.strictEqual(projectSlugOf('/Users/me/Code/AgentlensPro'), '-Users-me-Code-AgentlensPro')
    assert.strictEqual(projectSlugOf('-Users-me-Code-AgentlensPro'), '-Users-me-Code-AgentlensPro')
  })

  test('prices claude-opus-5 and resolves the -fast id to the premium entry, not the base one', () => {
    const base = lookupRates('claude-opus-5')
    const fast = lookupRates('claude-opus-5-fast')
    assert.ok(base, 'claude-opus-5 must be priced — an unpriced current model bills every session $0')
    assert.strictEqual(base.inputPerMTok, 5.00)
    assert.strictEqual(base.cacheWritePerMTok, 6.25)
    assert.strictEqual(base.cacheReadPerMTok, 0.50)
    assert.strictEqual(base.outputPerMTok, 25.00)
    assert.ok(fast)
    assert.strictEqual(fast.inputPerMTok, 10.00, 'longest-prefix match must win over claude-opus-5')
    assert.strictEqual(fast.outputPerMTok, 50.00)
  })

  test('never emits a row belonging to another project, and counts what it withheld', async () => {
    const log = await build({ mode: 'recent', limit: 100 })
    assert.strictEqual(log.rows.length, 8, 'exactly project A\'s 8 calls')
    assert.ok(log.rows.every(r => r.sessionId === 'sess-a'))
    assert.ok(log.excluded.calls >= 2, 'project B\'s 2 calls must be counted as excluded, not dropped silently')
    const maxWrite = Math.max(...log.rows.map(r => r.cacheWriteTokens))
    assert.strictEqual(maxWrite, 200_000, 'project B\'s 900k write must not leak in as the peak')
  })

  test('centres the costliest call and shows the calls before and after it', async () => {
    const log = await build({ mode: 'peak', contextEvents: 2 })
    assert.strictEqual(log.rows.length, 5, '2 before + peak + 2 after')
    assert.deepStrictEqual(log.rows.map(r => r.role), ['before', 'before', 'peak', 'after', 'after'])
    const peak = log.rows[2]
    assert.strictEqual(peak.cacheWriteTokens, 200_000)
    assert.strictEqual(peak.writeScale, 4)
    assert.strictEqual(peak.writeMarker, WRITE_SCALE_EMOJI.repeat(4))
    assert.strictEqual(peak.cacheWriteTtl, '1-hour')
    // The surrounding rows are the cheap warm turns — the comparison the whole mode exists for.
    assert.ok(log.rows.filter(r => r.role !== 'peak').every(r => r.cacheWriteTokens === 300))
  })

  test('reports cost and input-equivalents from the model rates, never a hardcoded weighting', async () => {
    const log = await build({ mode: 'peak', contextEvents: 0 })
    const peak = log.rows[0]
    // 2 input + 100,000 read + 200,000 write + 100 output at the opus-5 rates. The write is in the
    // 1-HOUR tier (the fixture says so), which bills at 2x base input = $10.00/MTok — NOT the
    // $6.25 5-minute rate. Pricing it at 6.25 would give 1.3025 here; that 60% under-count is
    // exactly the bug this asserts against.
    const expected = (2 * 5.00 + 100_000 * 0.50 + 200_000 * 10.00 + 100 * 25.00) / 1_000_000
    // costUsd is rounded to 4 decimals for display; the weighting below is taken from the UNROUNDED
    // value, so a long ledger cannot accumulate rounding drift into its total.
    assert.strictEqual(peak.costUsd, +expected.toFixed(4))
    // Input-equivalents = cost expressed in plain input tokens: the cache read contributes 0.1x and
    // the write 1.25x, which is why a 200k write outweighs a 100k read six-fold.
    assert.strictEqual(peak.weightedInputEquivalentTokens, Math.round(expected / (5.00 / 1_000_000)))
  })

  test('prices a 5-minute write at 1.25x and a 1-hour write at 2x — the tier is not cosmetic', () => {
    const { calcTokenCostUsd, cacheWrite1hRate, lookupRates } = require('../shared/pricing') as
      typeof import('../shared/pricing')
    const W = 1_000_000
    const fiveMin = calcTokenCostUsd(0, 0, W, 0, MODEL)          // no 1h portion → all 5m
    const oneHour = calcTokenCostUsd(0, 0, W, 0, MODEL, W)       // the whole write in the 1h tier
    assert.strictEqual(fiveMin, 6.25, '5-minute write = 1.25x the $5.00 input rate')
    assert.strictEqual(oneHour, 10.00, '1-hour write = 2x the $5.00 input rate')
    // Half and half, to prove the split is applied per-portion rather than all-or-nothing.
    assert.strictEqual(calcTokenCostUsd(0, 0, W, 0, MODEL, W / 2), 8.125)
    // A provider that does not price cache writes must never be handed a derived 2x rate.
    const gpt = lookupRates('gpt-4o')
    assert.ok(gpt && gpt.cacheWritePerMTok === 0)
    assert.strictEqual(cacheWrite1hRate(gpt), 0, 'no write rate → no derived 1h rate')
  })

  test('keeps zero-cache-write calls in recent mode — a ledger of writes only cannot show a warm turn', async () => {
    const log = await build({ mode: 'recent', limit: 3 })
    assert.deepStrictEqual(log.rows.map(r => r.cacheWriteTokens), [300, 300, 0])
    const warm = log.rows[2]
    assert.strictEqual(warm.writeMarker, '', 'a call with no write carries no marker')
    assert.strictEqual(warm.cacheWriteTtl, null)
    assert.strictEqual(warm.cacheReadTokens, 120_000)
    assert.ok(log.rows.every(r => r.role === 'recent'))
  })

  test('totals only the printed rows, so the total can never include a hidden project', async () => {
    const log = await build({ mode: 'recent', limit: 3 })
    assert.strictEqual(log.totals.events, 3)
    assert.strictEqual(log.totals.cacheWriteTokens, 600)
    assert.strictEqual(log.totals.cacheReadTokens, 320_000)
    assert.strictEqual(log.totals.outputTokens, 250)
  })

  test('renders a table with spelled-out headers, the marker, and a total row', async () => {
    const out = formatCacheEventLog(await build({ mode: 'peak', contextEvents: 1 }), 'table') as { text: string }
    for (const header of ['Input tokens', 'Cache write', 'Cache read', 'Output tokens', 'Cache write TTL', 'Cost USD']) {
      assert.ok(out.text.includes(header), `table must spell out "${header}" rather than abbreviate it`)
    }
    assert.ok(out.text.includes(WRITE_SCALE_EMOJI.repeat(4)), 'the peak row carries its 4-step marker')
    assert.ok(out.text.includes('TOTAL'))
    assert.ok(out.text.includes(PROJECT_A), 'the table states which project it is scoped to')
    assert.ok(!out.text.includes('sess-b'), 'no trace of another project may reach the rendered output')
  })

  test('returns the raw object unchanged in json format', async () => {
    const log = await build({ mode: 'peak', contextEvents: 1 })
    assert.strictEqual(formatCacheEventLog(log, 'json'), log)
  })
})
