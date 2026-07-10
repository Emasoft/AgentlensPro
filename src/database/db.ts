import * as fs from 'fs'
import * as path from 'path'
import { SCHEMA_SQL } from './schema'
import { LOG_INGEST_VERSION } from '../collectorState'
import { calcTokenCostUsd } from '../shared/pricing'

// Minimal sql.js surface we use — avoids pulling in @types/sql.js
// which has a transitive @types/emscripten dep that requires browser lib types.
// Exported so the re-ingest guard's tests can pass a structurally-compatible sql.js handle.
export interface SqlDatabase {
  run(sql: string, params?: unknown[]): void
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
  export(): Uint8Array
  close(): void
}
export interface SqlJsStatic {
  Database: new (data?: Buffer | Uint8Array) => SqlDatabase
}
type InitSqlJs = (config?: { locateFile?: (file: string) => string }) => Promise<SqlJsStatic>

const DB_FILENAME = 'agentlens.db'
const BLOBS_DIR = 'blobs'

// Bump when the log-ingest semantics change in a way that makes previously-stored
// log-sourced rows stale (new columns the incremental parser can't back-fill in place,
// or a corrected accounting formula). On a bump, all data_source='log' rows are wiped so
// the next scan re-ingests every local session file with the current semantics. OTEL rows
// can't be re-derived from logs, so they are normalized IN PLACE instead (v5 session rows,
// v6 timeline-entry rows) — see reIngestLogRowsIfStale. The version history + the standalone
// sidecar gate share one constant: LOG_INGEST_VERSION in src/collectorState.ts.
const INGEST_VERSION = LOG_INGEST_VERSION

/**
 * Opens (or creates) the AgentLens SQLite database at storagePath/agentlens.db
 * and applies the schema. The extensionPath is needed to locate the sql.js
 * WASM binary, which is copied to dist/ during the build.
 */
export async function openDatabase(storagePath: string, extensionPath: string): Promise<AgentLensDb> {
  // sql.js is loaded dynamically to keep it out of the main extension bundle.
  // Require by path so the packaged extension can resolve it from dist/.
  const initSqlJs = require(path.join(extensionPath, 'dist', 'sql-wasm.js')) as InitSqlJs
  const SQL = await initSqlJs({
    locateFile: (file: string) => path.join(extensionPath, 'dist', file),
  })

  const dbPath = path.join(storagePath, DB_FILENAME)
  let db: SqlDatabase

  try {
    const fileBuffer = fs.readFileSync(dbPath)
    db = new SQL.Database(fileBuffer)
  } catch {
    db = new SQL.Database()
  }

  db.run(SCHEMA_SQL)
  applyMigrations(db)
  reIngestLogRowsIfStale(db)

  ensureBlobsDir(storagePath)

  return new AgentLensDb(db, SQL, dbPath, path.join(storagePath, BLOBS_DIR))
}

export class AgentLensDb {
  constructor(
    private readonly db: SqlDatabase,
    readonly sqlFactory: SqlJsStatic,
    private readonly dbPath: string,
    readonly blobsDir: string,
  ) {}

  /** Flush the in-memory database to disk. Called periodically and on deactivate. */
  save(): void {
    const data = this.db.export()
    fs.writeFileSync(this.dbPath, Buffer.from(data))
  }

  /** Save and close. Added to context.subscriptions so VS Code calls it on deactivation. */
  dispose(): void {
    try {
      this.save()
    } finally {
      this.db.close()
    }
  }

  /** Direct access for query/write operations added in later phases. */
  get raw(): SqlDatabase {
    return this.db
  }
}

function applyMigrations(db: SqlDatabase): void {
  // Each migration is guarded so re-running on an already-migrated DB is safe.
  const cols = db.exec('PRAGMA table_info(sessions)')
  const colNames = cols[0]?.values.map(row => row[1] as string) ?? []
  if (!colNames.includes('cost_usd')) {
    db.run('ALTER TABLE sessions ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0')
  }
  if (!colNames.includes('data_source')) {
    db.run("ALTER TABLE sessions ADD COLUMN data_source TEXT NOT NULL DEFAULT 'otel'")
  }
  if (!colNames.includes('files_written')) {
    db.run("ALTER TABLE sessions ADD COLUMN files_written TEXT NOT NULL DEFAULT '[]'")
  }
  // Sub-agent linkage (TRDD-TKN5VALS): child→parent SESSION id + the parent turn that spawned it.
  if (!colNames.includes('parent_session_id')) {
    db.run('ALTER TABLE sessions ADD COLUMN parent_session_id TEXT')
  }
  if (!colNames.includes('spawned_by_turn')) {
    db.run('ALTER TABLE sessions ADD COLUMN spawned_by_turn INTEGER')
  }
  // Peak single-turn context occupancy (input + cacheRead + cacheCreate) — computed in ingestion but
  // was lost on DB round-trip; persist it so the Context tab's growth ceiling survives re-open.
  if (!colNames.includes('peak_context_per_turn')) {
    db.run('ALTER TABLE sessions ADD COLUMN peak_context_per_turn INTEGER')
  }
  // Sub-agent spawn taxonomy (TRDD-TKN5VALS P4): how the child was spawned (fork/fresh/worktree/
  // fleet) + the requested model/isolation, so the spawn-kind badge survives a DB round-trip.
  if (!colNames.includes('spawn_kind')) {
    db.run('ALTER TABLE sessions ADD COLUMN spawn_kind TEXT')
  }
  if (!colNames.includes('spawn_model_override')) {
    db.run('ALTER TABLE sessions ADD COLUMN spawn_model_override TEXT')
  }
  if (!colNames.includes('spawn_isolation')) {
    db.run('ALTER TABLE sessions ADD COLUMN spawn_isolation TEXT')
  }
  // TRDD-FB5RG4P1 EHT: the requested sub-agent type (e.g. spark), so it survives a DB round-trip and
  // feeds FAL's compare_configs groupBy:subagent_type. Nullable + guarded → safe forward migration.
  if (!colNames.includes('spawn_subagent_type')) {
    db.run('ALTER TABLE sessions ADD COLUMN spawn_subagent_type TEXT')
  }
  // Async-launch marker: a child card whose zero token buckets mean "not reported in the parent
  // transcript", not "measured zero". Must survive the round-trip or a reload silently converts
  // honest absence into a fake $0 measurement.
  if (!colNames.includes('spawn_async')) {
    db.run('ALTER TABLE sessions ADD COLUMN spawn_async INTEGER')
  }
  // Token-figure provenance (P7): which feed backs the card's served numbers ('log'|'otel'|
  // 'merged') + the optional displacement note. Nullable ON PURPOSE — rows persisted before the
  // field stay NULL and serve as "unknown"; the value is never backfilled (honest absence).
  if (!colNames.includes('tokens_source')) {
    db.run('ALTER TABLE sessions ADD COLUMN tokens_source TEXT')
  }
  if (!colNames.includes('coverage_note')) {
    db.run('ALTER TABLE sessions ADD COLUMN coverage_note TEXT')
  }

  // timeline_entries cache token columns
  const teCols = db.exec('PRAGMA table_info(timeline_entries)')
  const teColNames = teCols[0]?.values.map(row => row[1] as string) ?? []
  if (!teColNames.includes('cache_read_tokens')) {
    db.run('ALTER TABLE timeline_entries ADD COLUMN cache_read_tokens INTEGER')
  }
  if (!teColNames.includes('cache_create_tokens')) {
    db.run('ALTER TABLE timeline_entries ADD COLUMN cache_create_tokens INTEGER')
  }
  // turn: 1-based assistant-turn index this entry belongs to (backbone for the trace tree).
  if (!teColNames.includes('turn')) {
    db.run('ALTER TABLE timeline_entries ADD COLUMN turn INTEGER')
  }

  // instruction_applied table (feat-instruction-advisor)
  const appliedCols = db.exec('PRAGMA table_info(instruction_applied)')
  if (!appliedCols[0]) {
    db.run(`CREATE TABLE IF NOT EXISTS instruction_applied (
      id                     TEXT PRIMARY KEY,
      workspace              TEXT NOT NULL,
      category               TEXT NOT NULL,
      title                  TEXT NOT NULL,
      suggested_text         TEXT NOT NULL DEFAULT '',
      applied_to             TEXT NOT NULL DEFAULT '',
      applied_text           TEXT NOT NULL DEFAULT '',
      applied_at             TEXT NOT NULL,
      baseline_cost_avg      REAL NOT NULL DEFAULT 0,
      baseline_turns_avg     REAL NOT NULL DEFAULT 0,
      baseline_error_rate    REAL NOT NULL DEFAULT 0,
      baseline_loop_rate     REAL NOT NULL DEFAULT 0,
      baseline_insufficient  INTEGER NOT NULL DEFAULT 0
    )`)
    db.run('CREATE INDEX IF NOT EXISTS idx_instruction_applied_workspace ON instruction_applied (workspace)')
  }

  // instruction_dismissed table (feat-instruction-advisor)
  const dismissedCols = db.exec('PRAGMA table_info(instruction_dismissed)')
  if (!dismissedCols[0]) {
    db.run(`CREATE TABLE IF NOT EXISTS instruction_dismissed (
      id           TEXT NOT NULL,
      workspace    TEXT NOT NULL,
      dismissed_at TEXT NOT NULL,
      PRIMARY KEY (id, workspace)
    )`)
    db.run('CREATE INDEX IF NOT EXISTS idx_instruction_dismissed_workspace ON instruction_dismissed (workspace)')
  }
}

/**
 * Back-fill / re-ingest guard. When the stored PRAGMA user_version is behind INGEST_VERSION,
 * every log-sourced session (and its timeline_entries + edit_details) is deleted so the next
 * LogReader scan — which starts each process with an empty in-memory fileState and therefore
 * re-reads every session file from scratch — rewrites those rows with the current ingest
 * semantics (per-turn `turn` index, de-inflated input_tokens, sub-agent rollup).
 *
 * Only data_source='log' rows are wiped: they are losslessly reproducible from the local
 * session files. OTEL rows live only in the (ephemeral) span window and cannot be re-derived,
 * so they are preserved and carry the documented accounting discontinuity for pre-v2 history.
 * Idempotent: the version stamp is advanced after the wipe, so it runs exactly once per bump.
 *
 * Exported for its tests (src/test/database/reingest.test.ts) — openDatabase stays the sole
 * production caller.
 */
export function reIngestLogRowsIfStale(db: SqlDatabase): void {
  const rows = db.exec('PRAGMA user_version')
  const current = (rows[0]?.values[0]?.[0] as number) ?? 0
  if (current >= INGEST_VERSION) return

  // v5 — normalize persisted OTEL rows to the RAW disjoint-buckets convention IN PLACE (they
  // cannot be re-derived: the span window is ephemeral). Every OTEL summarizer stored
  // input_tokens INCLUDING the cache buckets until v5, which also double-billed cache tokens at
  // the full input rate in the stored cost_usd. Subtract the caches (clamped at 0) and recompute
  // the cost from the now-disjoint buckets. Log rows are simply wiped below and re-ingested.
  if (current < 5) {
    const otel = db.exec(
      `SELECT session_id, input_tokens, cache_read_tokens, cache_create_tokens, output_tokens, model
       FROM sessions WHERE data_source = 'otel'`,
    )
    for (const row of otel[0]?.values ?? []) {
      const [sid, input, cr, cc, output, model] = row as [string, number, number, number, number, string]
      const rawInput = Math.max(input - cr - cc, 0)
      const cost = calcTokenCostUsd(rawInput, cr, cc, output, model)
      db.run(
        'UPDATE sessions SET input_tokens = ?, cost_usd = ? WHERE session_id = ?',
        [rawInput, cost, sid],
      )
    }
  }

  // v6 — the v5 story, one level down: persisted OTEL TIMELINE ENTRIES stored incl-cache
  // input_tokens (claude.ts llm entries) until the P3 entry normalization. Mirror the card
  // migration in place — subtract the row's OWN cache columns (clamped at 0, NULLs as 0) — so one
  // convention lives on disk, ever. Rows whose cache columns were never populated (codex/copilot
  // OTEL entries carried no per-entry cache data pre-v6) are left arithmetically unchanged: their
  // incl-cache share is unknowable and the span window they came from is gone — the documented
  // pre-v6 accounting discontinuity, identical to the v5 stance on unrecoverable OTEL history.
  // Log-side entries need no arithmetic: their sessions are wiped below and cold-rescanned.
  if (current < 6) {
    db.run(
      `UPDATE timeline_entries
       SET input_tokens = MAX(input_tokens - COALESCE(cache_read_tokens, 0) - COALESCE(cache_create_tokens, 0), 0)
       WHERE type = 'llm' AND input_tokens IS NOT NULL
         AND session_id IN (SELECT session_id FROM sessions WHERE data_source = 'otel')`,
    )
  }

  // Explicit child-first deletes: sql.js does not reliably honor ON DELETE CASCADE, so we
  // cannot rely on the FK to clean timeline_entries / edit_details for the wiped sessions.
  db.run(`DELETE FROM edit_details WHERE timeline_entry_id IN (
            SELECT te.id FROM timeline_entries te
            JOIN sessions s ON s.session_id = te.session_id
            WHERE s.data_source = 'log')`)
  db.run(`DELETE FROM timeline_entries WHERE session_id IN (
            SELECT session_id FROM sessions WHERE data_source = 'log')`)
  // generated_files (TRDD-ZS1GDXVY) is a child of the wiped log sessions; delete it explicitly too
  // (sql.js does not reliably cascade) so no orphan output-file rows survive the re-ingest.
  db.run(`DELETE FROM generated_files WHERE session_id IN (
            SELECT session_id FROM sessions WHERE data_source = 'log')`)
  db.run(`DELETE FROM sessions WHERE data_source = 'log'`)
  // PRAGMA user_version takes a literal, not a bound param.
  db.run(`PRAGMA user_version = ${INGEST_VERSION}`)
}

function ensureBlobsDir(storagePath: string): void {
  const dir = path.join(storagePath, BLOBS_DIR)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}
