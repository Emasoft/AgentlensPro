import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { summarizeSpans } from '../spanSummarizer'
import { LogReader, type LogSessionResult } from '../logReader'
import { calcTokenCostUsd } from '../shared/pricing'
import type { Span } from '../shared/telemetryTypes'

// ── Why this file exists ──────────────────────────────────────────────────────
// The user-reported OTEL-vs-JSONL discrepancy (2026-07-10): the SAME session read up to ~1000×
// apart between the two feeds because OTEL cards stored inputTokens INCLUDING the cache buckets
// while log cards stored it RAW — two conventions inside one schema field, papered over by a
// read-time detection heuristic. The fix normalized every ingestion site to RAW disjoint buckets
// and deleted the heuristic. This test is the standing parity contract: one identical API call
// fed through BOTH feeds must produce byte-identical four-bucket values and identical cost.

const USAGE = { input: 150, output: 50, cacheRead: 800, cacheCreate: 50 }
const MODEL = 'claude-opus-4-8'

function attr(key: string, value: string | number) {
  return { key, value: typeof value === 'number' ? { intValue: value } : { stringValue: value } }
}

function otelClaudeCard() {
  const interaction: Span = {
    traceId: 'parity-claude', spanId: 'parity-root', name: 'claude_code.interaction',
    startTime: '1700000000000000000', endTime: '1700000001000000000',
    attributes: [attr('user_prompt', 'parity check')],
  }
  const llm: Span = {
    traceId: 'parity-claude', spanId: 'parity-llm', parentSpanId: 'parity-root',
    name: 'claude_code.llm_request',
    startTime: '1700000000100000000', endTime: '1700000000900000000',
    attributes: [
      attr('gen_ai.request.model', MODEL),
      attr('gen_ai.usage.input_tokens', USAGE.input),
      attr('gen_ai.usage.output_tokens', USAGE.output),
      attr('gen_ai.usage.cache_read.input_tokens', USAGE.cacheRead),
      attr('gen_ai.usage.cache_creation.input_tokens', USAGE.cacheCreate),
    ],
  }
  const card = summarizeSpans([interaction, llm]).sessions.find(s => s.source === 'claude_code')
  assert.ok(card, 'OTEL claude card produced')
  return card!
}

function logClaudeCard() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'al-parity-'))
  const sub = path.join(root, 'projects', 'proj')
  fs.mkdirSync(sub, { recursive: true })
  const id = `parity-${process.pid}`
  const cwd = path.join(root, 'workspace')
  const lines =
    JSON.stringify({ type: 'user', timestamp: '2026-07-10T10:00:00Z', cwd, message: { content: 'parity check' } }) + '\n'
    + JSON.stringify({
      type: 'assistant', timestamp: '2026-07-10T10:00:01Z', cwd,
      message: {
        model: MODEL,
        usage: {
          input_tokens: USAGE.input, output_tokens: USAGE.output,
          cache_read_input_tokens: USAGE.cacheRead, cache_creation_input_tokens: USAGE.cacheCreate,
        },
        content: [{ type: 'text', text: 'ok' }],
      },
    }) + '\n'
  fs.writeFileSync(path.join(sub, `${id}.jsonl`), lines)
  const orig = process.env['CLAUDE_CONFIG_DIR']
  process.env['CLAUDE_CONFIG_DIR'] = root
  try {
    const results = (new LogReader({}) as unknown as { _scanClaude(): LogSessionResult[] })._scanClaude()
    const card = results.find(r => r.card.sessionId === id)?.card
    assert.ok(card, 'log claude card produced')
    return card!
  } finally {
    if (orig === undefined) delete process.env['CLAUDE_CONFIG_DIR']
    else process.env['CLAUDE_CONFIG_DIR'] = orig
    fs.rmSync(root, { recursive: true, force: true })
  }
}

suite('token-convention parity — the same call through both feeds', () => {
  test('OTEL and JSONL cards carry identical four disjoint buckets for the same usage', () => {
    const otel = otelClaudeCard()
    const log = logClaudeCard()
    const buckets = (c: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number }) =>
      ({ input: c.inputTokens, output: c.outputTokens, cacheRead: c.cacheReadTokens, cacheCreate: c.cacheCreateTokens })
    assert.deepStrictEqual(buckets(otel), USAGE, 'OTEL card stores the raw disjoint buckets')
    assert.deepStrictEqual(buckets(log), USAGE, 'log card stores the raw disjoint buckets')
    assert.deepStrictEqual(buckets(otel), buckets(log), 'both feeds agree bucket-for-bucket')
  })

  test('both feeds price the same usage to the same dollar figure', () => {
    const otel = otelClaudeCard()
    const log = logClaudeCard()
    const cost = (c: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number; model: string }) =>
      calcTokenCostUsd(c.inputTokens, c.cacheReadTokens, c.cacheCreateTokens, c.outputTokens, c.model)
    assert.ok(cost(otel) > 0, 'model is priced')
    assert.strictEqual(cost(otel), cost(log))
  })
})
