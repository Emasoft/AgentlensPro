// TRDD-YJQXLHPA — run_transcript_sql over REAL DuckDB and real tmp-dir transcripts (no mocks).
// The engine's promises under test: bounded file selection (window/sessionId, never the whole
// corpus), honest coverage on every result, the reused read-only gate, the row cap that reports
// itself, and presets that survive the sparse union_by_name schema.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { runTranscriptSql, TRANSCRIPT_PRESETS } from '../transcriptSql'

function tmpProjects(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'al-tsql-'))
}

function assistantRec(sessionId: string, model: string, out: number, cacheCreate: number): string {
  return JSON.stringify({
    type: 'assistant', uuid: `a-${Math.random().toString(36).slice(2)}`, sessionId,
    timestamp: '2026-07-16T10:00:01.000Z', cwd: '/w',
    message: {
      id: 'msg-1', model,
      usage: {
        input_tokens: 10, output_tokens: out,
        cache_read_input_tokens: 1_000, cache_creation_input_tokens: cacheCreate,
      },
      content: [{ type: 'text', text: 'hi' }],
    },
  })
}

function userRec(sessionId: string): string {
  return JSON.stringify({
    type: 'user', uuid: `u-${Math.random().toString(36).slice(2)}`, sessionId,
    timestamp: '2026-07-16T10:00:00.000Z', cwd: '/w', message: { content: 'hello' },
  })
}

/** A projects tree with two session transcripts (one old by mtime) + one subagent transcript. */
function seedTree(root: string): { fresh: string; stale: string; sub: string } {
  const proj = path.join(root, '-Users-x-proj')
  fs.mkdirSync(path.join(proj, 'parent-1', 'subagents'), { recursive: true })
  const fresh = path.join(proj, 'sess-fresh.jsonl')
  fs.writeFileSync(fresh, [userRec('sess-fresh'), assistantRec('sess-fresh', 'claude-opus-4-8', 500, 90_000)].join('\n') + '\n')
  const stale = path.join(proj, 'sess-stale.jsonl')
  fs.writeFileSync(stale, [userRec('sess-stale'), assistantRec('sess-stale', 'claude-sonnet-5', 30, 1_000)].join('\n') + '\n')
  const old = (Date.now() - 72 * 3_600_000) / 1000
  fs.utimesSync(stale, old, old)
  const sub = path.join(proj, 'parent-1', 'subagents', 'agent-abc.jsonl')
  fs.writeFileSync(sub, assistantRec('agent-abc', 'claude-sonnet-5', 70, 2_000) + '\n')
  return { fresh, stale, sub }
}

suite('runTranscriptSql — bounded DuckDB SQL over the transcripts (TRDD-YJQXLHPA)', () => {
  test('no preset/sql lists the frozen presets with honest coverage', async () => {
    const root = tmpProjects()
    seedTree(root)
    const r = await runTranscriptSql({ projectsDirs: [root] })
    assert.strictEqual(r.mode, 'list')
    assert.ok(r.presets && r.presets.length === Object.keys(TRANSCRIPT_PRESETS).length)
    assert.strictEqual(r.coverage.filesTotal, 3, 'the walk must find both sessions AND the subagent transcript')
  })

  test('the default 24h window EXCLUDES stale files — and says so in coverage', async () => {
    const root = tmpProjects()
    seedTree(root)
    const r = await runTranscriptSql({ projectsDirs: [root], sql: "SELECT DISTINCT \"sessionId\" AS s FROM transcripts ORDER BY 1" })
    assert.strictEqual(r.error, undefined, r.error)
    assert.strictEqual(r.coverage.filesQueried, 2, 'fresh session + subagent; the 72h-old file is out of window')
    assert.strictEqual(r.coverage.windowHours, 24)
    const sessions = (r.rows ?? []).map((x) => x.s)
    assert.ok(!sessions.includes('sess-stale'), 'the stale transcript must not be queried')
  })

  test('windowHours widens the file set', async () => {
    const root = tmpProjects()
    seedTree(root)
    const r = await runTranscriptSql({ projectsDirs: [root], windowHours: 100, sql: 'SELECT count(*) AS n FROM transcripts' })
    assert.strictEqual(r.error, undefined, r.error)
    assert.strictEqual(r.coverage.filesQueried, 3)
  })

  test('sessionId is the one-file fast path (no window applies)', async () => {
    const root = tmpProjects()
    seedTree(root)
    const r = await runTranscriptSql({ projectsDirs: [root], sessionId: 'sess-stale', sql: 'SELECT count(*) AS n FROM transcripts' })
    assert.strictEqual(r.error, undefined, r.error)
    assert.strictEqual(r.coverage.filesQueried, 1, 'even an out-of-window file is queryable by sessionId')
    assert.strictEqual(Number((r.rows ?? [])[0]?.n), 2)
  })

  test('the read-only gate REJECTS DDL/PRAGMA/second statements (reused from forensicsSql)', async () => {
    const root = tmpProjects()
    seedTree(root)
    for (const bad of ['DROP TABLE transcripts', 'PRAGMA database_size', 'SELECT 1; SELECT 2']) {
      const r = await runTranscriptSql({ projectsDirs: [root], sql: bad })
      assert.ok(r.error, `'${bad}' must be rejected`)
    }
  })

  test('preset usage_by_model aggregates the token buckets per model', async () => {
    const root = tmpProjects()
    seedTree(root)
    const r = await runTranscriptSql({ projectsDirs: [root], windowHours: 100, preset: 'usage_by_model' })
    assert.strictEqual(r.error, undefined, r.error)
    const rows = r.rows ?? []
    const opus = rows.find((x) => x.model === 'claude-opus-4-8')
    assert.ok(opus, 'the opus fixture row must aggregate')
    assert.strictEqual(Number(opus!.output_tokens), 500)
    assert.strictEqual(Number(opus!.cache_create_tokens), 90_000)
    const sonnet = rows.find((x) => x.model === 'claude-sonnet-5')
    assert.strictEqual(Number(sonnet!.assistant_records), 2, 'stale session + subagent are both sonnet')
  })

  test('preset cache_heavy_turns ranks by cache_creation descending', async () => {
    const root = tmpProjects()
    seedTree(root)
    const r = await runTranscriptSql({ projectsDirs: [root], windowHours: 100, preset: 'cache_heavy_turns' })
    assert.strictEqual(r.error, undefined, r.error)
    assert.strictEqual(Number((r.rows ?? [])[0]?.cache_create_tokens), 90_000, 'the 90k write must rank first')
  })

  test('the row cap is REPORTED, never silent', async () => {
    const root = tmpProjects()
    const proj = path.join(root, '-Users-x-proj')
    fs.mkdirSync(proj, { recursive: true })
    const lines = Array.from({ length: 12 }, () => userRec('big'))
    fs.writeFileSync(path.join(proj, 'big.jsonl'), lines.join('\n') + '\n')
    const r = await runTranscriptSql({ projectsDirs: [root], sql: 'SELECT uuid FROM transcripts', limit: 5 })
    assert.strictEqual(r.error, undefined, r.error)
    assert.strictEqual(r.rowCount, 5)
    assert.ok(/capped at 5/.test(r.coverage.note), `coverage must name the cap: ${r.coverage.note}`)
  })

  test('an empty window is an honest error naming the widening levers, not a crash or a bare glob error', async () => {
    const root = tmpProjects()
    const { fresh, stale, sub } = seedTree(root)
    // Backdate EVERYTHING past the default 24h window → a non-empty corpus, zero files selected.
    const old = (Date.now() - 72 * 3_600_000) / 1000
    for (const f of [fresh, stale, sub]) fs.utimesSync(f, old, old)
    const r = await runTranscriptSql({ projectsDirs: [root], sql: 'SELECT 1' })
    assert.ok(r.error && /windowHours|sessionId/.test(r.error), r.error)
    assert.strictEqual(r.coverage.filesTotal, 3, 'the corpus is still visible in coverage')
    assert.strictEqual(r.coverage.filesQueried, 0)
  })

  test('a live still-growing file (truncated last line) does not fail the scan (ignore_errors)', async () => {
    const root = tmpProjects()
    const { fresh } = seedTree(root)
    fs.appendFileSync(fresh, '{"type":"assistant","truncated-mid-wri')
    const r = await runTranscriptSql({ projectsDirs: [root], sql: "SELECT count(*) AS n FROM transcripts WHERE type='user'" })
    assert.strictEqual(r.error, undefined, r.error)
    assert.ok(Number((r.rows ?? [])[0]?.n) >= 1)
  })

  test('rows are JSON-safe (BIGINT sums must not leak BigInt into the MCP payload)', async () => {
    const root = tmpProjects()
    seedTree(root)
    const r = await runTranscriptSql({ projectsDirs: [root], windowHours: 100, preset: 'sessions_by_output' })
    assert.strictEqual(r.error, undefined, r.error)
    assert.doesNotThrow(() => JSON.stringify(r), 'the whole result must JSON.stringify cleanly')
  })

  test('unknown preset error names the valid ones', async () => {
    const root = tmpProjects()
    seedTree(root)
    const r = await runTranscriptSql({ projectsDirs: [root], preset: 'nope' })
    assert.ok(r.error && r.error.includes('usage_by_model'), r.error)
  })
})
