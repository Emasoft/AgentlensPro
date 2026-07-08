import * as assert from 'assert'
import * as path from 'path'
import type { UriLike } from '../../vscodeCompat'
import { SCHEMA_SQL } from '../../database/schema'
import { DatabaseWriter } from '../../database/writer'
import { DatabaseReader } from '../../database/reader'
import type { SessionSummaryCard } from '../../summarizers/summarizerTypes'

// ── Output-file / subfolder tracking (TRDD-ZS1GDXVY) — DB round-trip ──────────
// Proves the generated_files index survives a write→reload: correlated leaves re-attach to their
// tool timeline entry (span_id), and the session-level group (span_id NULL) loads via
// loadSessionGeneratedFiles. This is what makes the index survive a dashboard restart.

type SqlDb = {
  run(sql: string, params?: unknown[]): void
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
  export(): Uint8Array
  close(): void
}

async function openInMemoryDb(): Promise<SqlDb> {
  const sqlJsDir = path.dirname(require.resolve('sql.js'))
  const initSqlJs = require('sql.js') as (cfg: { locateFile: (f: string) => string }) => Promise<{ Database: new () => SqlDb }>
  const SQL = await initSqlJs({ locateFile: (f: string) => path.join(sqlJsDir, f) })
  const db = new SQL.Database()
  db.run(SCHEMA_SQL)
  return db
}

function makeStorageUri(): UriLike {
  return { scheme: 'file', path: '/tmp/agentlens-gf-test' }
}

function makeCard(overrides: Partial<SessionSummaryCard> = {}): SessionSummaryCard {
  return {
    sessionId: 'sess-gf', traceId: 'trace-gf', source: 'claude_code', dataSource: 'log', workspace: '',
    userRequest: 'x', model: 'claude', turns: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheCreateTokens: 0, cacheHitRate: 0, durationMs: 0, startTime: '2026-07-07T00:00:00.000Z',
    filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [], toolCounts: {}, totalToolCalls: 1,
    totalLlmCalls: 1, errors: 0, outcome: 'tool_calls', timeline: [], backgroundSpans: [], loopSignals: [],
    ...overrides,
  }
}

function countRows(db: SqlDb, table: string): number {
  return (db.exec(`SELECT COUNT(*) FROM ${table}`)[0]?.values[0]?.[0] as number) ?? 0
}

const cardWithGenFiles = (): SessionSummaryCard => makeCard({
  timeline: [{
    type: 'tool', spanId: 'sp-1', label: 'Write', durationMs: 0, isError: false, timestamp: '',
    generatedFiles: [
      { path: '/tmp/claude-1/slug/sess-gf/scratchpad/a.md', sizeBytes: 400, mtimeMs: 111, tokenEstimate: 100, origin: 'referenced' },
    ],
  }],
  generatedFiles: [
    { path: '/tmp/claude-1/slug/sess-gf/tasks/b.output', sizeBytes: 800, mtimeMs: 222, tokenEstimate: 200, origin: 'scratch' },
    { path: '/tmp/claude-1/slug/sess-gf/gone.txt', sizeBytes: 0, mtimeMs: 0, tokenEstimate: 0, origin: 'referenced', missing: true },
  ],
})

suite('generated_files — DB write + reload (TRDD-ZS1GDXVY)', () => {
  test('writer persists correlated + group rows; reader re-attaches leaves and loads the group', async () => {
    const db = await openInMemoryDb()
    const w = new DatabaseWriter(db, makeStorageUri(), () => {})
    w.enqueue(cardWithGenFiles(), 'ws')
    await w.drain()

    assert.strictEqual(countRows(db, 'generated_files'), 3)

    const reader = new DatabaseReader(db, makeStorageUri())

    // Correlated leaf re-attaches to its tool entry by span_id.
    const timeline = reader.loadSessionTimeline('sess-gf')
    const tool = timeline.find(e => e.spanId === 'sp-1')
    assert.ok(tool && tool.generatedFiles && tool.generatedFiles.length === 1)
    assert.strictEqual(tool!.generatedFiles![0].path, '/tmp/claude-1/slug/sess-gf/scratchpad/a.md')
    assert.strictEqual(tool!.generatedFiles![0].sizeBytes, 400)
    assert.strictEqual(tool!.generatedFiles![0].origin, 'referenced')

    // Session-level group = the span_id NULL rows.
    const group = reader.loadSessionGeneratedFiles('sess-gf')
    assert.strictEqual(group.length, 2)
    const missing = group.find(g => g.path.endsWith('gone.txt'))
    assert.ok(missing && missing.missing === true)
    const scratch = group.find(g => g.origin === 'scratch')
    assert.ok(scratch && scratch.sizeBytes === 800)
    db.close()
  })

  test('re-writing a session replaces its generated_files (no duplicate accumulation)', async () => {
    const db = await openInMemoryDb()
    const w = new DatabaseWriter(db, makeStorageUri(), () => {})
    w.enqueue(cardWithGenFiles(), 'ws')
    await w.drain()
    w.enqueue(cardWithGenFiles(), 'ws')  // second scan of the same session
    await w.drain()
    assert.strictEqual(countRows(db, 'generated_files'), 3, 'delete-then-reinsert keeps the row count stable')
    db.close()
  })
})
