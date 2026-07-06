import * as fs from 'fs'
import * as path from 'path'
import { SCHEMA_SQL } from './schema'

// Minimal sql.js surface we use — avoids pulling in @types/sql.js
// which has a transitive @types/emscripten dep that requires browser lib types.
interface SqlDatabase {
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
// are left untouched (they can't be re-derived from logs — see reIngestLogRowsIfStale).
//   v2 (TRDD-TKN5VALS): per-turn `turn` index + de-inflated input_tokens + sub-agent rollup.
const INGEST_VERSION = 2

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
 */
function reIngestLogRowsIfStale(db: SqlDatabase): void {
  const rows = db.exec('PRAGMA user_version')
  const current = (rows[0]?.values[0]?.[0] as number) ?? 0
  if (current >= INGEST_VERSION) return

  // Explicit child-first deletes: sql.js does not reliably honor ON DELETE CASCADE, so we
  // cannot rely on the FK to clean timeline_entries / edit_details for the wiped sessions.
  db.run(`DELETE FROM edit_details WHERE timeline_entry_id IN (
            SELECT te.id FROM timeline_entries te
            JOIN sessions s ON s.session_id = te.session_id
            WHERE s.data_source = 'log')`)
  db.run(`DELETE FROM timeline_entries WHERE session_id IN (
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
