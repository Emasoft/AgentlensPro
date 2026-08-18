// src/test/searchCli.test.ts — `agentlenspro search` (TRDD-P31SWA8I): the DuckDB transcript
// query engine and the verb's usage contract. Real DuckDB against a real fixture file — no mocks.

import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { searchTranscript, runSearchCli } from '../cli/searchCli'
import { UsageError } from '../cli/cliErrors'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-search-'))
const fixture = path.join(tmpDir, 'aaaaaaaa-1111-2222-3333-444444444444.jsonl')

// Shapes mirror a real Claude transcript: user prompt, assistant text, a tool_result carried in a
// user-role entry, a summary line, and one MB-scale tool_result to prove big lines stay in SQL.
const LINES = [
  { type: 'user', timestamp: '2026-08-18T10:00:00.000Z', message: { role: 'user', content: 'please fix the ENOENT crash in the loader' } },
  { type: 'assistant', timestamp: '2026-08-18T10:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: "reading the loader now — O'Brien's parser looks suspect" }] } },
  { type: 'user', timestamp: '2026-08-18T10:00:10.000Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'Error: ENOENT: no such file or directory, open /tmp/x' }] } },
  { type: 'summary', summary: 'session about a loader crash' },
  { type: 'assistant', timestamp: '2026-08-18T10:00:20.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'fixed: the path was built before mkdir ran (enoent root cause)' }] } },
  { type: 'user', timestamp: '2026-08-18T10:00:30.000Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'PAYLOAD ' + 'x'.repeat(2_000_000) + ' NEEDLE_IN_BIG_LINE' }] } },
]
fs.writeFileSync(fixture, LINES.map(l => JSON.stringify(l)).join('\n') + '\n')

suite('searchCli — DuckDB transcript search', () => {
  test('literal search is case-insensitive and reports true line numbers + full total', async function () {
    this.timeout(30_000)
    const r = await searchTranscript(fixture, 'enoent')
    assert.strictEqual(r.total, 3, 'ENOENT appears on lines 1, 3 and 5 regardless of case')
    assert.deepStrictEqual(r.hits.map(h => h.line), [1, 3, 5], 'line numbers must match the file, in file order')
    assert.strictEqual(r.hits[0].role, 'user')
    assert.strictEqual(r.hits[1].type, 'user')
    assert.ok(r.hits[2].excerpt.toLowerCase().includes('enoent'), 'the excerpt must contain the match')
  })

  test('--role and --type filters narrow the result set', async function () {
    this.timeout(30_000)
    const byRole = await searchTranscript(fixture, 'enoent', { role: 'assistant' })
    assert.deepStrictEqual(byRole.hits.map(h => h.line), [5], 'only the assistant entry matches')
    const byType = await searchTranscript(fixture, 'loader', { type: 'summary' })
    assert.deepStrictEqual(byType.hits.map(h => h.line), [4], 'the summary line has no message.role but a type')
  })

  test('--regex mode matches by pattern and excerpts the capture', async function () {
    this.timeout(30_000)
    const r = await searchTranscript(fixture, 'ENOENT: no such [a-z]+', { regex: true })
    assert.strictEqual(r.total, 1, 'the regex only fits the tool_result error line')
    assert.strictEqual(r.hits[0].line, 3)
    assert.strictEqual(r.hits[0].excerpt, 'ENOENT: no such file')
  })

  test('--limit bounds the hits but total still reports the honest match count', async function () {
    this.timeout(30_000)
    const r = await searchTranscript(fixture, 'enoent', { limit: 1 })
    assert.strictEqual(r.hits.length, 1)
    assert.strictEqual(r.total, 3, 'truncation must never masquerade as a smaller result set')
  })

  test("a pattern containing a single quote is escaped, not a SQL break", async function () {
    this.timeout(30_000)
    const r = await searchTranscript(fixture, "O'Brien's")
    assert.deepStrictEqual(r.hits.map(h => h.line), [2])
  })

  test('a match inside an MB-scale tool_result line is found and the excerpt stays bounded', async function () {
    this.timeout(30_000)
    const r = await searchTranscript(fixture, 'NEEDLE_IN_BIG_LINE')
    assert.deepStrictEqual(r.hits.map(h => h.line), [6])
    assert.ok(r.hits[0].excerpt.length <= 300, `excerpt must be windowed, got ${r.hits[0].excerpt.length} chars`)
    assert.ok(r.hits[0].excerpt.includes('NEEDLE_IN_BIG_LINE'))
  })
})

suite('searchCli — usage contract', () => {
  test('an unknown flag is a UsageError (maps to exit 64), checked BEFORE any other validation', async () => {
    await assert.rejects(() => runSearchCli(['--definitely-not-a-real-flag']),
      (e: unknown) => e instanceof UsageError)
  })

  test('a missing pattern and a missing --session are each a UsageError', async () => {
    await assert.rejects(() => runSearchCli(['--session', 'abc123']),
      (e: unknown) => e instanceof UsageError && /pattern/.test((e as Error).message))
    await assert.rejects(() => runSearchCli(['needle']),
      (e: unknown) => e instanceof UsageError && /--session/.test((e as Error).message))
  })

  test('a non-numeric --limit is refused', async () => {
    await assert.rejects(() => runSearchCli(['needle', '--session', 'abc123', '--limit', 'lots']),
      (e: unknown) => e instanceof UsageError)
  })
})
