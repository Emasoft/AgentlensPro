import * as assert from 'assert'
import * as path from 'path'
import { SCHEMA_SQL } from '../../database/schema'
import { reIngestLogRowsIfStale, type SqlDatabase } from '../../database/db'
import { LOG_INGEST_VERSION } from '../../collectorState'

// ── Why this file exists ──────────────────────────────────────────────────────
// The v6 ingest bump (P3, tokenBuckets) normalizes persisted OTEL TIMELINE ENTRIES to the RAW
// disjoint-buckets convention IN PLACE — mirroring the v5 card migration one level down. Persisted
// OTEL llm entries stored incl-cache input_tokens until v6; serving them next to freshly-ingested
// raw entries would be exactly the mixed-convention split the whole fix exists to kill. These are
// REAL sql.js round-trips (schema → seed → migrate → read back), no mocks.

async function openDb(): Promise<SqlDatabase> {
  const sqlJsDir = path.dirname(require.resolve('sql.js'))
  const initSqlJs = require('sql.js') as (cfg: { locateFile: (f: string) => string }) => Promise<{ Database: new () => SqlDatabase }>
  const SQL = await initSqlJs({ locateFile: (f: string) => path.join(sqlJsDir, f) })
  const db = new SQL.Database()
  db.run(SCHEMA_SQL)
  return db
}

function seedSession(db: SqlDatabase, sessionId: string, dataSource: 'otel' | 'log'): void {
  db.run(
    `INSERT INTO sessions (session_id, trace_id, source, workspace, start_time, data_source)
     VALUES (?,?,?,?,?,?)`,
    [sessionId, 't-' + sessionId, 'claude_code', '/w', 1700000000000, dataSource],
  )
}

function seedEntry(
  db: SqlDatabase, sessionId: string, type: string,
  tokens: { input: number | null; cr: number | null; cc: number | null },
): void {
  db.run(
    `INSERT INTO timeline_entries (session_id, span_id, position, type, input_tokens, cache_read_tokens, cache_create_tokens)
     VALUES (?,?,?,?,?,?,?)`,
    [sessionId, 's-' + Math.random().toString(36).slice(2, 8), 0, type, tokens.input, tokens.cr, tokens.cc],
  )
}

function entryInputs(db: SqlDatabase, sessionId: string): Array<number | null> {
  return (db.exec(`SELECT input_tokens FROM timeline_entries WHERE session_id = '${sessionId}'`)[0]?.values ?? [])
    .map(r => r[0] as number | null)
}

suite('reIngestLogRowsIfStale — v6 timeline-entry normalization', () => {
  test('normalizes a persisted OTEL llm entry from incl-cache to the raw disjoint input', async () => {
    const db = await openDb()
    seedSession(db, 'otel-1', 'otel')
    // Pre-v6 convention: 150 raw + 800 cacheRead + 50 cacheCreate stored as input_tokens=1000.
    seedEntry(db, 'otel-1', 'llm', { input: 1000, cr: 800, cc: 50 })
    db.run('PRAGMA user_version = 5')
    reIngestLogRowsIfStale(db)
    assert.deepStrictEqual(entryInputs(db, 'otel-1'), [150])
    db.close()
  })

  test('leaves api_request entries (always raw) and NULL-usage rows arithmetically untouched', async () => {
    const db = await openDb()
    seedSession(db, 'otel-2', 'otel')
    seedEntry(db, 'otel-2', 'api_request', { input: 150, cr: 800, cc: 50 })  // raw since ingest
    seedEntry(db, 'otel-2', 'llm', { input: null, cr: null, cc: null })      // no usage on this row
    seedEntry(db, 'otel-2', 'llm', { input: 300, cr: null, cc: null })       // cache cols never populated (pre-v6 codex/copilot)
    db.run('PRAGMA user_version = 5')
    reIngestLogRowsIfStale(db)
    const rows = db.exec(`SELECT type, input_tokens FROM timeline_entries WHERE session_id = 'otel-2' ORDER BY id`)[0].values
    assert.deepStrictEqual(rows, [['api_request', 150], ['llm', null], ['llm', 300]])
    db.close()
  })

  test('clamps an inconsistent row (caches exceed input) at 0 instead of going negative', async () => {
    const db = await openDb()
    seedSession(db, 'otel-3', 'otel')
    seedEntry(db, 'otel-3', 'llm', { input: 100, cr: 800, cc: 50 })
    db.run('PRAGMA user_version = 5')
    reIngestLogRowsIfStale(db)
    assert.deepStrictEqual(entryInputs(db, 'otel-3'), [0])
    db.close()
  })

  test('log sessions are wiped for cold re-ingest (not arithmetically patched) and the stamp advances', async () => {
    const db = await openDb()
    seedSession(db, 'log-1', 'log')
    seedEntry(db, 'log-1', 'llm', { input: 1000, cr: 800, cc: 50 })
    db.run('PRAGMA user_version = 5')
    reIngestLogRowsIfStale(db)
    assert.strictEqual((db.exec(`SELECT COUNT(*) FROM sessions WHERE data_source = 'log'`)[0].values[0][0] as number), 0)
    assert.strictEqual((db.exec(`SELECT COUNT(*) FROM timeline_entries WHERE session_id = 'log-1'`)[0].values[0][0] as number), 0)
    assert.strictEqual((db.exec('PRAGMA user_version')[0].values[0][0] as number), LOG_INGEST_VERSION)
    db.close()
  })

  test('idempotent — a second run at the current version changes nothing', async () => {
    const db = await openDb()
    seedSession(db, 'otel-4', 'otel')
    seedEntry(db, 'otel-4', 'llm', { input: 1000, cr: 800, cc: 50 })
    db.run('PRAGMA user_version = 5')
    reIngestLogRowsIfStale(db)
    assert.deepStrictEqual(entryInputs(db, 'otel-4'), [150])
    reIngestLogRowsIfStale(db)  // must NOT subtract the caches a second time
    assert.deepStrictEqual(entryInputs(db, 'otel-4'), [150])
    db.close()
  })
})
