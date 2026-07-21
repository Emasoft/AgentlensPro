import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { buildAttributionReport } from '../skillAttribution'

// ── Per-skill / per-plugin cost attribution (TRDD-A4BA8IU5) ────────────────────────────────────
// Fixtures are written to a real temp transcript tree, because the dedupe rule this module lives or
// dies by (one message id = one usage count, however many JSONL rows it spans) is only meaningful
// against the on-disk row shape Claude Code actually writes.

let root: string

function writeTranscript(name: string, records: Array<Record<string, unknown>>): void {
  const dir = path.join(root, 'project-slug')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), records.map(r => JSON.stringify(r)).join('\n') + '\n')
}

const assistant = (over: Record<string, unknown>): Record<string, unknown> => ({
  type: 'assistant',
  timestamp: '2026-07-21T10:00:00.000Z',
  ...over,
})

const usage = (input: number, cacheRead: number, cacheWrite: number, output: number) => ({
  input_tokens: input,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  output_tokens: output,
})

suite('skillAttribution — per-skill/plugin cost from the transcript (TRDD-A4BA8IU5)', () => {
  setup(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-attr-')) })
  teardown(() => { fs.rmSync(root, { recursive: true, force: true }) })

  test('rolls tokens and cost up by skill and by plugin', () => {
    writeTranscript('a.jsonl', [
      assistant({
        attributionSkill: 'ai-maestro-janitor:janitor-arm',
        attributionPlugin: 'ai-maestro-janitor',
        message: { id: 'msg_1', model: 'claude-opus-4-8', usage: usage(10, 1_000_000, 0, 100) },
      }),
      assistant({
        attributionSkill: 'tldr-code',
        message: { id: 'msg_2', model: 'claude-opus-4-8', usage: usage(0, 0, 1_000_000, 0) },
      }),
    ])
    const r = buildAttributionReport({ dirs: [root] })
    assert.strictEqual(r.attributedMessages, 2)
    assert.strictEqual(r.pricedMessages, 2)
    const arm = r.bySkill.find(s => s.name === 'ai-maestro-janitor:janitor-arm')
    assert.strictEqual(arm?.messages, 1)
    assert.strictEqual(arm?.cacheReadTokens, 1_000_000)
    // opus-4-8: cache read $0.50/MTok, output $25/MTok, input $5/MTok
    assert.ok(Math.abs((arm?.costUsd ?? 0) - (0.50 + 0.0025 + 0.00005)) < 0.001, `got ${arm?.costUsd}`)
    // plugin rollup aggregates only the record that named a plugin
    assert.strictEqual(r.byPlugin.length, 1)
    assert.strictEqual(r.byPlugin[0].name, 'ai-maestro-janitor')
    assert.strictEqual(r.byPlugin[0].messages, 1)
  })

  test('sorts by cost, highest first — the whole point is naming the expensive one', () => {
    writeTranscript('a.jsonl', [
      assistant({ attributionSkill: 'cheap', message: { id: 'm1', model: 'claude-opus-4-8', usage: usage(0, 0, 1000, 0) } }),
      assistant({ attributionSkill: 'expensive', message: { id: 'm2', model: 'claude-opus-4-8', usage: usage(0, 0, 5_000_000, 0) } }),
    ])
    const r = buildAttributionReport({ dirs: [root] })
    assert.deepStrictEqual(r.bySkill.map(s => s.name), ['expensive', 'cheap'])
  })

  // THE load-bearing rule: Claude Code repeats the FULL usage on every content-block row of one
  // message. Summing per row over-counts 2-5x on exactly the tool-heavy sessions this report exists
  // to explain.
  test('counts usage ONCE per message id, however many rows the message spans', () => {
    const shared = { attributionSkill: 'multi-block', message: { id: 'msg_same', model: 'claude-opus-4-8', usage: usage(0, 0, 1_000_000, 0) } }
    writeTranscript('a.jsonl', [assistant(shared), assistant(shared), assistant(shared)])
    const r = buildAttributionReport({ dirs: [root] })
    assert.strictEqual(r.attributedMessages, 1, 'three rows are ONE message')
    assert.strictEqual(r.duplicateRowsSkipped, 2, 'and the skipped rows are reported, not hidden')
    assert.strictEqual(r.bySkill[0].cacheWriteTokens, 1_000_000, 'not 3,000,000')
  })

  test('an attributed message with no usage still counts, it just is not priced', () => {
    writeTranscript('a.jsonl', [
      assistant({ attributionSkill: 'no-usage', message: { id: 'm1', model: 'claude-opus-4-8' } }),
    ])
    const r = buildAttributionReport({ dirs: [root] })
    assert.strictEqual(r.attributedMessages, 1)
    assert.strictEqual(r.pricedMessages, 0)
    assert.strictEqual(r.totalCostUsd, 0)
  })

  test('records without an attribution stamp, and non-assistant records, are ignored', () => {
    writeTranscript('a.jsonl', [
      assistant({ message: { id: 'm1', model: 'claude-opus-4-8', usage: usage(0, 0, 1_000_000, 0) } }),
      { type: 'user', timestamp: '2026-07-21T10:00:00.000Z', attributionSkill: 'not-an-assistant-turn', message: { id: 'm2', usage: usage(0, 0, 1_000_000, 0) } },
    ])
    const r = buildAttributionReport({ dirs: [root] })
    assert.strictEqual(r.attributedMessages, 0)
    assert.strictEqual(r.bySkill.length, 0)
  })

  test('sinceMs excludes older messages', () => {
    writeTranscript('a.jsonl', [
      assistant({ attributionSkill: 'old', timestamp: '2026-07-01T00:00:00.000Z', message: { id: 'm1', model: 'claude-opus-4-8', usage: usage(0, 0, 1000, 0) } }),
      assistant({ attributionSkill: 'new', timestamp: '2026-07-21T00:00:00.000Z', message: { id: 'm2', model: 'claude-opus-4-8', usage: usage(0, 0, 1000, 0) } }),
    ])
    const r = buildAttributionReport({ dirs: [root], sinceMs: Date.parse('2026-07-10T00:00:00.000Z') })
    assert.deepStrictEqual(r.bySkill.map(s => s.name), ['new'])
  })

  test('topN caps each list without changing the totals', () => {
    writeTranscript('a.jsonl', [
      assistant({ attributionSkill: 'a', message: { id: 'm1', model: 'claude-opus-4-8', usage: usage(0, 0, 3000, 0) } }),
      assistant({ attributionSkill: 'b', message: { id: 'm2', model: 'claude-opus-4-8', usage: usage(0, 0, 2000, 0) } }),
      assistant({ attributionSkill: 'c', message: { id: 'm3', model: 'claude-opus-4-8', usage: usage(0, 0, 1000, 0) } }),
    ])
    const full = buildAttributionReport({ dirs: [root] })
    const capped = buildAttributionReport({ dirs: [root], topN: 2 })
    assert.strictEqual(full.bySkill.length, 3)
    assert.strictEqual(capped.bySkill.length, 2)
    assert.strictEqual(capped.totalCostUsd, full.totalCostUsd, 'a cap must not change the total')
    assert.strictEqual(capped.attributedMessages, full.attributedMessages)
  })
})
