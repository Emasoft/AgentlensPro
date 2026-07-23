// causingToolCall — verbatim spawn-call extraction from a session JSONL via DuckDB read_json.
//
// These pin the parts that must be correct WITHOUT a live burn: the timestamp-window join, the
// "last spawn before the peak" pick, that a malformed line is skipped (ignore_errors) and a line
// over DuckDB's 16 MB default object size does NOT abort the read (we raise maximum_object_size),
// and that an absent/empty result returns a typed reason rather than a fabricated call.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { causingToolCall, renderCausingCall } from '../causingToolCall'

function tmpJsonl(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-causing-'))
  const p = path.join(dir, 'session.jsonl')
  fs.writeFileSync(p, lines.join('\n') + '\n')
  return p
}
const assistantLine = (ts: string, blocks: unknown[]): string =>
  JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: blocks } })
const toolUse = (name: string, input: unknown): unknown => ({ type: 'tool_use', name, id: `tu_${name}`, input })

suite('causingToolCall — verbatim spawn-call extraction from JSONL', () => {
  test('returns the VERBATIM spawn input for a peak in the window', async () => {
    const ts = '2026-07-23T12:00:00.000Z'
    const p = tmpJsonl([
      assistantLine('2026-07-23T11:00:00.000Z', [toolUse('Read', { file_path: '/x' })]),
      assistantLine(ts, [{ type: 'text', text: 'fanning out' },
        toolUse('Workflow', { script: 'export const meta={name:"x"}\nconst FINDERS=[1,2]' })]),
    ])
    const r = await causingToolCall({ jsonlPath: p, atMs: Date.parse(ts) + 1000, windowMs: 10 * 60_000 })
    assert.ok(r.call, `expected a call, got null (${r.reason})`)
    assert.strictEqual(r.call.tool, 'Workflow')
    // Verbatim = the JSON serialization of the input (quotes escaped, newlines preserved as \n) —
    // the exact call args, not a digest. Assert on content that survives JSON escaping.
    assert.ok(r.call.input.includes('export const meta') && r.call.input.includes('FINDERS'),
      `input must be verbatim, got: ${r.call.input.slice(0, 120)}`)
    assert.match(renderCausingCall(r), /cause-call: Workflow\(/)
  })

  test('picks the LAST spawn before the peak and ignores non-spawn tools', async () => {
    const p = tmpJsonl([
      assistantLine('2026-07-23T11:58:00.000Z', [toolUse('Agent', { prompt: 'first fanout' })]),
      assistantLine('2026-07-23T11:59:00.000Z', [toolUse('Bash', { command: 'ls' })]), // non-spawn, ignored
      assistantLine('2026-07-23T11:59:30.000Z', [toolUse('Agent', { prompt: 'second fanout' })]),
    ])
    const r = await causingToolCall({ jsonlPath: p, atMs: Date.parse('2026-07-23T12:00:00.000Z'), windowMs: 10 * 60_000 })
    assert.ok(r.call, `expected a call, got null (${r.reason})`)
    assert.strictEqual(r.call.tool, 'Agent')
    assert.ok(r.call.input.includes('second fanout'), 'must pick the LATEST spawn, not the first')
  })

  test('a malformed line is skipped (ignore_errors), the valid spawn after it is still found', async () => {
    const ts = '2026-07-23T12:00:00.000Z'
    const p = tmpJsonl([
      'garbage-not-json-line', // a COMPLETE but invalid line — ignore_errors skips it, no swallow
      assistantLine(ts, [toolUse('Task', { description: 'do it' })]),
    ])
    const r = await causingToolCall({ jsonlPath: p, atMs: Date.parse(ts) + 1000, windowMs: 10 * 60_000 })
    assert.ok(r.call, `a malformed line must not abort the read; got null (${r.reason})`)
    assert.strictEqual(r.call.tool, 'Task')
  })

  test('🐌 a line over DuckDB\'s 16MB default does NOT abort the read (raised maximum_object_size)', async function () {
    this.timeout(30000)
    // 17 MB > DuckDB's 16 MiB default object size — without our override this line would fail the read.
    const bigData = 'A'.repeat(17 * 1024 * 1024)
    const ts = '2026-07-23T12:00:00.000Z'
    const p = tmpJsonl([
      assistantLine('2026-07-23T11:59:00.000Z', [{ type: 'tool_result', content: [{ type: 'image', source: { data: bigData } }] }]),
      assistantLine(ts, [toolUse('Agent', { subagent_type: 'fork', prompt: 'go' })]),
    ])
    const r = await causingToolCall({ jsonlPath: p, atMs: Date.parse(ts) + 1000, windowMs: 10 * 60_000 })
    assert.ok(r.call, `an oversize image line must skip, not abort; got null (${r.reason})`)
    assert.strictEqual(r.call.tool, 'Agent')
  })

  test('no spawn in the window → null with reason none-in-window (never fabricated)', async () => {
    const p = tmpJsonl([assistantLine('2026-07-23T09:00:00.000Z', [toolUse('Agent', { x: 1 })])])
    const r = await causingToolCall({ jsonlPath: p, atMs: Date.parse('2026-07-23T12:00:00.000Z'), windowMs: 5 * 60_000 })
    assert.strictEqual(r.call, null)
    assert.strictEqual(r.reason, 'none-in-window')
  })

  test('a missing transcript → null with reason no-transcript; no locator at all → no-locator', async () => {
    const missing = await causingToolCall({ jsonlPath: '/no/such/agentlens/file.jsonl', atMs: Date.now() })
    assert.strictEqual(missing.call, null)
    assert.strictEqual(missing.reason, 'no-transcript')
    const none = await causingToolCall({ atMs: Date.now() })
    assert.strictEqual(none.call, null)
    assert.strictEqual(none.reason, 'no-locator')
  })
})
