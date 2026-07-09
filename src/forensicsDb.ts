// TRDD-FB5RG4P1 — Forensics Analytics Layer (FAL) DB layer.
//
// A DEDICATED sql.js SQLite database at ~/.agentlens/forensics.db — a sibling of otel-bodies/ and
// the main agentlens.db, deliberately NOT a set of tables inside agentlens.db. Rationale (design §1.1):
//   - Different lifecycle: DatabaseWriter.replaceAll() does a full DELETE FROM sessions on every
//     rescan; a derived OTEL-body fact table living there would be clobbered. forensics.db has its
//     own incremental (high-water-mark) lifecycle.
//   - Different grain: main DB is one row / SESSION (hundreds); FAL is one row / API CALL (15k-32k+).
//   - Read-only safety: run_diagnostics_sql opens a fresh in-memory snapshot of THIS file, so a raw
//     query can never reach source session data (separate file, snapshot copy).
//
// POINTER-ONLY: this DB stores token counts, tier splits, ids, fingerprints, and file-path pointers.
// It NEVER stores base64 image bytes, raw block text, the metadata.user_id token blob, or OAuth
// tokens — only derived, non-secret identifiers cross into it (same guarantee CCFORNSC upholds).

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { lookupRates } from './pricing'

export const DEFAULT_FORENSICS_DB = path.join(os.homedir(), '.agentlens', 'forensics.db')
export const DEFAULT_MAIN_DB = path.join(os.homedir(), '.agentlens', 'agentlens.db')

// ── Minimal sql.js surface ──────────────────────────────────────────────────────
// We avoid @types/sql.js (its transitive @types/emscripten pulls in browser lib types). Only the
// members FAL actually touches are declared. `create_function` is confirmed present in the shipped
// sql.js 1.14.1 build (e.prototype.create_function = e.prototype.Kb) — it powers the custom SQL fns.
export interface SqlStatement {
  bind(params?: unknown[] | Record<string, unknown>): boolean
  step(): boolean
  get(): unknown[]
  getAsObject(): Record<string, unknown>
  free(): boolean
}
export interface SqlDatabase {
  run(sql: string, params?: unknown[] | Record<string, unknown>): void
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>
  prepare(sql: string, params?: unknown[] | Record<string, unknown>): SqlStatement
  create_function(name: string, fn: (...args: never[]) => unknown): void
  export(): Uint8Array
  close(): void
}
export interface SqlJsStatic {
  Database: new (data?: Buffer | Uint8Array) => SqlDatabase
}
type InitSqlJs = (config?: { locateFile?: (file: string) => string }) => Promise<SqlJsStatic>

// ── sql.js loader (context-independent) ─────────────────────────────────────────
// Mirrors standalone/server.ts exactly: require('sql.js') + require.resolve('sql.js') to locate the
// WASM. This resolves in the standalone bundle (esbuild inlines sql.js) and when tests/CI run from the
// repo (node_modules present). If sql.js is unresolvable (a packaged extension host with sql.js
// externalized to dist/), the loader returns null and every FAL tool degrades honestly rather than
// throwing — the primary FAL consumer is the standalone/npx MCP path this project dogfoods.
let cachedSqlJs: SqlJsStatic | null | undefined
export async function loadSqlJs(): Promise<SqlJsStatic | null> {
  if (cachedSqlJs !== undefined) { return cachedSqlJs }
  try {
    const initSqlJs = require('sql.js') as InitSqlJs
    const sqlJsDir = path.dirname(require.resolve('sql.js'))
    cachedSqlJs = await initSqlJs({ locateFile: (f: string) => path.join(sqlJsDir, f) })
  } catch {
    cachedSqlJs = null
  }
  return cachedSqlJs
}

// ── Schema (design §2) ──────────────────────────────────────────────────────────
export const FORENSICS_SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS api_calls (
  call_id               TEXT PRIMARY KEY,
  response_ref          TEXT NOT NULL,
  request_ref           TEXT,
  ts                    INTEGER NOT NULL,

  session_id            TEXT,
  account_uuid          TEXT,
  model                 TEXT,
  effort                TEXT,

  spawn_kind            TEXT,
  subagent_type         TEXT,
  spawn_model_override  TEXT,
  spawn_isolation       TEXT,
  is_sidechain          INTEGER NOT NULL DEFAULT 0,
  parent_session        TEXT,
  spawn_resolution      TEXT NOT NULL,

  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  tier_5m_tokens        INTEGER NOT NULL DEFAULT 0,
  tier_1h_tokens        INTEGER NOT NULL DEFAULT 0,

  break_cause           TEXT,
  culprit_fingerprint   TEXT,
  gap_minutes           REAL,

  frontmatter_fp        TEXT,

  cost_usd              REAL NOT NULL DEFAULT 0,
  billable_weight       REAL NOT NULL DEFAULT 0,
  indexed_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ac_ts          ON api_calls (ts DESC);
CREATE INDEX IF NOT EXISTS idx_ac_session     ON api_calls (session_id);
CREATE INDEX IF NOT EXISTS idx_ac_account     ON api_calls (account_uuid);
CREATE INDEX IF NOT EXISTS idx_ac_model       ON api_calls (model);
CREATE INDEX IF NOT EXISTS idx_ac_spawn_kind  ON api_calls (spawn_kind);
CREATE INDEX IF NOT EXISTS idx_ac_break_cause ON api_calls (break_cause);
CREATE INDEX IF NOT EXISTS idx_ac_frontmatter ON api_calls (frontmatter_fp);
CREATE INDEX IF NOT EXISTS idx_ac_culprit     ON api_calls (culprit_fingerprint);

CREATE TABLE IF NOT EXISTS call_content (
  call_id  TEXT NOT NULL REFERENCES api_calls(call_id) ON DELETE CASCADE,
  tag      TEXT NOT NULL,
  tokens   INTEGER NOT NULL DEFAULT 0,
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (call_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_cc_tag ON call_content (tag);

CREATE TABLE IF NOT EXISTS call_injections (
  call_id  TEXT NOT NULL REFERENCES api_calls(call_id) ON DELETE CASCADE,
  kind     TEXT NOT NULL,
  name     TEXT NOT NULL,
  tokens   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (call_id, kind, name)
);
CREATE INDEX IF NOT EXISTS idx_ci_kind_name ON call_injections (kind, name);

CREATE TABLE IF NOT EXISTS index_state (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`

// ── Cost / weighting helpers (pure TS — shared by the index-time column AND the SQL custom fns) ──

/** Tier-aware "how much did this call really cost me" number, in USD-ish weighted dollars. The
 *  expensive buckets dominate spend but hide in raw token counts: cache_creation is billed 1.25x
 *  (5m tier) / 2x (1h tier) the input rate, output ≈5x input. Collapsing every bucket to one
 *  comparable number lets "worst config" rankings reflect real dollars, not token volume. Returns 0
 *  when the model's rates are unknown (fail-soft — never throws on an unseen model id). */
export function billableWeight(
  cc5m: number, cc1h: number, cacheRead: number, output: number, input: number, model: string | null | undefined,
): number {
  const rates = model ? lookupRates(model) : null
  if (!rates) { return 0 }
  const inputRate = rates.inputPerMTok / 1_000_000
  const outputRate = rates.outputPerMTok / 1_000_000
  return num(input) * inputRate
       + num(cc5m) * 1.25 * inputRate
       + num(cc1h) * 2 * inputRate
       + num(cacheRead) * 0.1 * inputRate
       + num(output) * outputRate
}

/** The CCFORNSC gap taxonomy as a classifier: which TTL/break bucket a call's since-previous gap
 *  falls in. NULL/negative gap (first call in a session, or unattributed) → 'COLD'. */
export function tierClassify(gapMinutes: number | null | undefined): string {
  if (gapMinutes === null || gapMinutes === undefined || !isFinite(gapMinutes) || gapMinutes < 0) { return 'COLD' }
  if (gapMinutes < 4.5) { return 'BREAK' }
  if (gapMinutes <= 6) { return 'TTL_5m' }
  if (gapMinutes <= 65) { return 'MID' }
  return 'TTL_1h'
}

function num(v: unknown): number { return typeof v === 'number' && isFinite(v) ? v : 0 }

// ── Custom SQL functions (design §6.3) — registered on every opened forensics DB ────────────────
/** Register billable_weight / tier_classify / cost_usd / spike on a sql.js Database. sql.js passes SQL
 *  NULL through as JS null, so every fn is null-tolerant (a null model → 0 cost, a null gap → 'COLD').
 *  Registered on BOTH the writable index DB and the read-only raw-SQL snapshot so ad-hoc SQL can call
 *  them. calcTokenCostUsd is imported lazily inside cost_usd to keep this module's import graph flat. */
export function registerCustomFns(db: SqlDatabase): void {
  // Lazy require avoids a static import cycle risk and matches the "thin wrapper over the same rates"
  // contract — cost_usd is exactly the AgentLens per-call cost formula.
  const { calcTokenCostUsd } = require('./pricing') as typeof import('./pricing')

  db.create_function('billable_weight', ((cc5m, cc1h, cread, out, input, model) =>
    billableWeight(num(cc5m), num(cc1h), num(cread), num(out), num(input),
      typeof model === 'string' ? model : null)) as (...a: never[]) => unknown)

  db.create_function('tier_classify', ((gap) =>
    tierClassify(gap === null || gap === undefined ? null : Number(gap))) as (...a: never[]) => unknown)

  db.create_function('cost_usd', ((input, cread, cwrite, out, model) =>
    typeof model === 'string' ? calcTokenCostUsd(num(input), num(cread), num(cwrite), num(out), model) : 0) as (...a: never[]) => unknown)

  db.create_function('spike', ((value, median, mult) =>
    (num(value) >= num(median) * num(mult) ? 1 : 0)) as (...a: never[]) => unknown)
}

// ── Handle ────────────────────────────────────────────────────────────────────
/** A writable forensics.db handle. Mirrors AgentLensDb: the sql.js Database lives in memory; save()
 *  flushes it to disk (sql.js has no incremental disk sync). */
export class ForensicsDb {
  constructor(private readonly db: SqlDatabase, private readonly dbPath: string) {}
  get raw(): SqlDatabase { return this.db }
  save(): void {
    const data = this.db.export()
    fs.writeFileSync(this.dbPath, Buffer.from(data))
  }
  close(): void { this.db.close() }
}

/** Open (or create) forensics.db, apply the schema, register the custom fns. Returns null when sql.js
 *  is unavailable in this runtime (see loadSqlJs) — callers surface a graceful "engine unavailable". */
export async function openForensicsDb(dbPath: string = DEFAULT_FORENSICS_DB): Promise<ForensicsDb | null> {
  const SQL = await loadSqlJs()
  if (!SQL) { return null }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  let db: SqlDatabase
  try {
    const buf = fs.readFileSync(dbPath)
    db = new SQL.Database(buf)
  } catch {
    db = new SQL.Database()
  }
  db.run(FORENSICS_SCHEMA_SQL)
  registerCustomFns(db)
  return new ForensicsDb(db, dbPath)
}

/** Open a fresh in-memory READ-ONLY snapshot of forensics.db for run_diagnostics_sql (design §6.2).
 *  It is a copy of the on-disk bytes, so even a hypothetical write cannot reach the file — and the
 *  file is a separate DB from agentlens.db, so source session data is doubly protected. The custom
 *  fns are registered so ad-hoc SQL can call them. Returns null when the DB is absent or sql.js is
 *  unavailable. */
export async function openReadonlyForensicsSnapshot(dbPath: string = DEFAULT_FORENSICS_DB): Promise<SqlDatabase | null> {
  const SQL = await loadSqlJs()
  if (!SQL) { return null }
  let buf: Buffer
  try { buf = fs.readFileSync(dbPath) } catch { return null }
  const db = new SQL.Database(buf)
  registerCustomFns(db)
  return db
}

// ── index_state KV helpers ──────────────────────────────────────────────────────
export function readIndexState(db: SqlDatabase, key: string): string | null {
  // exec() cannot bind params; use a prepared statement for the single-key read.
  const st = db.prepare('SELECT v FROM index_state WHERE k = :k')
  try {
    st.bind({ ':k': key })
    if (st.step()) { const v = st.get()[0]; return typeof v === 'string' ? v : String(v) }
    return null
  } finally { st.free() }
}

export function writeIndexState(db: SqlDatabase, key: string, value: string): void {
  db.run('INSERT OR REPLACE INTO index_state (k, v) VALUES (:k, :v)', { ':k': key, ':v': value })
}
