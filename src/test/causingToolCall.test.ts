// causingToolCalls — full spawn-COMPOSITION extraction from a session JSONL via DuckDB read_json.
//
// These pin the parts that must be correct WITHOUT a live burn: EVERY spawn in the window is
// returned (not one nearest call), time-ordered + numbered; the timestamp-window join; a malformed
// line is skipped (ignore_errors) and a line over DuckDB's 16 MB default does NOT abort the read
// (raised maximum_object_size); and an absent/empty result returns a typed reason, never a
// fabricated call.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { causingToolCalls, renderCausingCalls, composition } from '../causingToolCall'

function tmpJsonl(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-causing-'))
  const p = path.join(dir, 'session.jsonl')
  fs.writeFileSync(p, lines.join('\n') + '\n')
  return p
}
const assistantLine = (ts: string, blocks: unknown[]): string =>
  JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: blocks } })
const toolUse = (name: string, input: unknown): unknown => ({ type: 'tool_use', name, id: `tu_${name}`, input })

suite('causingToolCalls — full spawn composition from JSONL', () => {
  test('returns EVERY spawn in the window, numbered + time-ordered, verbatim, non-spawn excluded', async () => {
    const p = tmpJsonl([
      assistantLine('2026-07-23T11:58:00.000Z', [toolUse('Agent', { subagent_type: 'general-purpose', prompt: 'first fanout' })]),
      assistantLine('2026-07-23T11:59:00.000Z', [toolUse('Bash', { command: 'ls' })]), // non-spawn, excluded
      assistantLine('2026-07-23T11:59:30.000Z', [{ type: 'text', text: 'again' },
        toolUse('Workflow', { script: 'export const meta={name:"x"}\nconst FINDERS=[1,2]' })]),
    ])
    const r = await causingToolCalls({ jsonlPath: p, atMs: Date.parse('2026-07-23T12:00:00.000Z'), windowMs: 10 * 60_000 })
    assert.strictEqual(r.calls.length, 2, `expected both spawns, got ${r.calls.length} (${r.reason ?? ''})`)
    assert.deepStrictEqual(r.calls.map(c => c.n), [1, 2], 'numbered 1..N in time order')
    assert.strictEqual(r.calls[0].tool, 'Agent')
    assert.strictEqual(r.calls[0].subagentType, 'general-purpose')
    assert.strictEqual(r.calls[1].tool, 'Workflow')
    assert.ok(r.calls[1].input.includes('export const meta') && r.calls[1].input.includes('FINDERS'),
      'input must be verbatim, not a digest')
    assert.match(renderCausingCalls(r), /cause-calls: 2 spawn call/)
  })

  test('composition tallies by tool/subagent_type/model, most-frequent first', async () => {
    const p = tmpJsonl([
      assistantLine('2026-07-23T11:58:00.000Z', [toolUse('Agent', { subagent_type: 'general-purpose' })]),
      assistantLine('2026-07-23T11:58:10.000Z', [toolUse('Agent', { subagent_type: 'general-purpose' })]),
      assistantLine('2026-07-23T11:58:20.000Z', [toolUse('Agent', { subagent_type: 'spark', model: 'opus' })]),
    ])
    const r = await causingToolCalls({ jsonlPath: p, atMs: Date.parse('2026-07-23T12:00:00.000Z'), windowMs: 10 * 60_000 })
    assert.strictEqual(r.calls.length, 3)
    assert.strictEqual(composition(r.calls), 'Agent/general-purpose×2, Agent/spark/opus×1')
  })

  test('a malformed line is skipped (ignore_errors), the valid spawn after it is still found', async () => {
    const ts = '2026-07-23T12:00:00.000Z'
    const p = tmpJsonl([
      'garbage-not-json-line', // a COMPLETE but invalid line — ignore_errors skips it, no swallow
      assistantLine(ts, [toolUse('Task', { description: 'do it' })]),
    ])
    const r = await causingToolCalls({ jsonlPath: p, atMs: Date.parse(ts) + 1000, windowMs: 10 * 60_000 })
    assert.strictEqual(r.calls.length, 1, `a malformed line must not abort the read (${r.reason ?? ''})`)
    assert.strictEqual(r.calls[0].tool, 'Task')
  })

  test('🐌 a line over DuckDB\'s 16MB default does NOT abort the read (raised maximum_object_size)', async function () {
    this.timeout(30000)
    const bigData = 'A'.repeat(17 * 1024 * 1024) // 17 MB > DuckDB's 16 MiB default object size
    const ts = '2026-07-23T12:00:00.000Z'
    const p = tmpJsonl([
      assistantLine('2026-07-23T11:59:00.000Z', [{ type: 'tool_result', content: [{ type: 'image', source: { data: bigData } }] }]),
      assistantLine(ts, [toolUse('Agent', { subagent_type: 'fork', prompt: 'go' })]),
    ])
    const r = await causingToolCalls({ jsonlPath: p, atMs: Date.parse(ts) + 1000, windowMs: 10 * 60_000 })
    assert.strictEqual(r.calls.length, 1, `an oversize image line must skip, not abort (${r.reason ?? ''})`)
    assert.strictEqual(r.calls[0].tool, 'Agent')
  })

  test('no spawn in the window → empty calls with reason none-in-window (never fabricated)', async () => {
    const p = tmpJsonl([assistantLine('2026-07-23T09:00:00.000Z', [toolUse('Agent', { x: 1 })])])
    const r = await causingToolCalls({ jsonlPath: p, atMs: Date.parse('2026-07-23T12:00:00.000Z'), windowMs: 5 * 60_000 })
    assert.strictEqual(r.calls.length, 0)
    assert.strictEqual(r.reason, 'none-in-window')
    assert.match(renderCausingCalls(r), /cause-calls: none \(none-in-window\)/)
  })

  test('a missing transcript → no-transcript; no locator at all → no-locator', async () => {
    const missing = await causingToolCalls({ jsonlPath: '/no/such/agentlens/file.jsonl', atMs: Date.now() })
    assert.strictEqual(missing.calls.length, 0)
    assert.strictEqual(missing.reason, 'no-transcript')
    const none = await causingToolCalls({ atMs: Date.now() })
    assert.strictEqual(none.calls.length, 0)
    assert.strictEqual(none.reason, 'no-locator')
  })
})
