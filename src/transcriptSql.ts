// TRDD-YJQXLHPA — run_transcript_sql: ad-hoc DuckDB SQL over the Claude session transcripts.
//
// Answers cost/cause/content questions the hand-written drill handlers don't cover, by querying
// the `.jsonl` transcripts DIRECTLY: a bounded set of files is exposed as ONE relation
// (`transcripts`) via read_ndjson_auto, and the caller runs a frozen preset or a gated read-only
// SELECT against it. NOT a LogReader replacement — the cards/summarizers stay; this is an
// analysis surface beside them (DuckDB-skills corpus mining, synthesis item 1).
//
// BOUNDING (the X2E6OSWK lesson, applied to disk): the projects tree holds 17k+ transcripts, so
// the view is NEVER built over the whole corpus. Files are pre-filtered in JS — one file for a
// sessionId query, else an mtime window (default 24h) — and passed as an EXPLICIT LIST, never a
// bare glob (an empty glob is a DuckDB ERROR, not an empty set; the store learned this first).
// Every result carries an honest `coverage` block naming exactly what was queried.
//
// SAFETY: the proven forensicsSql statement gate is REUSED (single read-only SELECT/WITH;
// DDL/DML/ATTACH/PRAGMA rejected). No user string is ever interpolated into SQL — sessionId
// selects files in JS, and the only embedded values are validated integers. This is a local
// diagnostics surface over the user's own files.

import * as fs from 'fs'
import * as path from 'path'
import { claudeProjectsDirs } from './logReader'
import { assertReadOnlySelect } from './forensicsSql'
import { MAX_OBJECT_SIZE, tornLineSql } from './ndjsonDuck'

export interface RunTranscriptSqlOptions {
  preset?: string
  sql?: string
  /** Query exactly this session's transcript (fast path — one file, no window). */
  sessionId?: string
  /** Only files modified in the last N hours feed the view (default 24; ignored with sessionId). */
  windowHours?: number
  limit?: number
  /** Test override; defaults to claudeProjectsDirs(). */
  projectsDirs?: string[]
}

export interface TranscriptSqlCoverage {
  filesTotal: number
  filesQueried: number
  windowHours?: number
  note: string
}

export interface RunTranscriptSqlResult {
  mode: 'preset' | 'sql' | 'list'
  preset?: string
  columns?: string[]
  rows?: Array<Record<string, unknown>>
  rowCount?: number
  presets?: Array<{ name: string; description: string }>
  coverage: TranscriptSqlCoverage
  error?: string
}

const HARD_MAX_ROWS = 2000
const DEFAULT_ROWS = 50          // token-lean default, same rationale as run_diagnostics_sql
const DEFAULT_WINDOW_HOURS = 24

// Frozen preset library. The view already contains ONLY the bounded file set, so presets need no
// :since windowing of their own. Sparse-schema discipline (union_by_name): always filter
// type='assistant' BEFORE touching message.usage.* — and TRY_CAST the usage numbers so one
// odd-shaped record degrades to NULL instead of failing the aggregate.
export const TRANSCRIPT_PRESETS: Record<string, { description: string; sql: string }> = {
  record_type_histogram: {
    description: 'What record shapes exist in the queried transcripts (the schema-discovery entry point).',
    sql: 'SELECT type, count(*) AS records FROM transcripts GROUP BY type ORDER BY records DESC',
  },
  usage_by_model: {
    description: 'Per-model assistant records + token buckets (input/output/cache read/cache create).',
    sql: `SELECT message.model AS model, count(*) AS assistant_records,
            sum(TRY_CAST(message.usage.input_tokens AS BIGINT)) AS input_tokens,
            sum(TRY_CAST(message.usage.output_tokens AS BIGINT)) AS output_tokens,
            sum(TRY_CAST(message.usage.cache_read_input_tokens AS BIGINT)) AS cache_read_tokens,
            sum(TRY_CAST(message.usage.cache_creation_input_tokens AS BIGINT)) AS cache_create_tokens
          FROM transcripts WHERE type = 'assistant' AND message.usage IS NOT NULL
          GROUP BY 1 ORDER BY output_tokens DESC`,
  },
  cache_heavy_turns: {
    description: 'Assistant records ranked by cache_creation tokens — where the expensive prefix re-writes are.',
    sql: `SELECT filename, "timestamp", message.model AS model,
            TRY_CAST(message.usage.cache_creation_input_tokens AS BIGINT) AS cache_create_tokens,
            TRY_CAST(message.usage.cache_read_input_tokens AS BIGINT) AS cache_read_tokens
          FROM transcripts
          WHERE type = 'assistant' AND message.usage.cache_creation_input_tokens IS NOT NULL
          ORDER BY cache_create_tokens DESC`,
  },
  sessions_by_output: {
    description: 'Per-session assistant records + output tokens, heaviest first.',
    sql: `SELECT coalesce("sessionId", filename) AS session, count(*) AS assistant_records,
            sum(TRY_CAST(message.usage.output_tokens AS BIGINT)) AS output_tokens
          FROM transcripts WHERE type = 'assistant'
          GROUP BY 1 ORDER BY output_tokens DESC`,
  },
}

function listTranscriptFiles(dirs: string[]): Array<{ path: string; mtimeMs: number }> {
  const out: Array<{ path: string; mtimeMs: number }> = []
  for (const dir of dirs) {
    let names: string[]
    // recursive: subagent transcripts live one level deeper (<parent>/subagents/agent-*.jsonl).
    try { names = fs.readdirSync(dir, { recursive: true }).map(String) } catch { continue }
    for (const rel of names) {
      if (!rel.endsWith('.jsonl')) continue
      const p = path.join(dir, rel)
      try { out.push({ path: p, mtimeMs: fs.statSync(p).mtimeMs }) } catch { /* raced a deletion */ }
    }
  }
  return out
}

function presetList(): Array<{ name: string; description: string }> {
  return Object.entries(TRANSCRIPT_PRESETS).map(([name, p]) => ({ name, description: p.description }))
}

export async function runTranscriptSql(opts: RunTranscriptSqlOptions = {}): Promise<RunTranscriptSqlResult> {
  const dirs = opts.projectsDirs ?? claudeProjectsDirs()
  const all = listTranscriptFiles(dirs)

  let files: Array<{ path: string; mtimeMs: number }>
  let windowHours: number | undefined
  if (opts.sessionId) {
    files = all.filter((f) => path.basename(f.path) === `${opts.sessionId}.jsonl`)
  } else {
    windowHours = typeof opts.windowHours === 'number' && opts.windowHours > 0
      ? opts.windowHours : DEFAULT_WINDOW_HOURS
    const cutoff = Date.now() - windowHours * 3_600_000
    files = all.filter((f) => f.mtimeMs >= cutoff)
  }
  const coverage: TranscriptSqlCoverage = {
    filesTotal: all.length,
    filesQueried: files.length,
    ...(windowHours !== undefined ? { windowHours } : {}),
    note: opts.sessionId
      ? `Queried the transcript of session ${opts.sessionId} (${files.length} file(s) of ${all.length} on disk).`
      : `Queried the ${files.length} transcript(s) modified in the last ${windowHours}h (of ${all.length} on disk) — widen with windowHours, or target one file with sessionId.`,
  }

  if (!opts.preset && !opts.sql) {
    return { mode: 'list', presets: presetList(), coverage }
  }
  if (opts.preset && opts.sql) {
    return { mode: 'sql', error: 'Pass preset OR sql, not both.', coverage }
  }

  let sql: string
  let mode: 'preset' | 'sql'
  if (opts.preset) {
    const p = TRANSCRIPT_PRESETS[opts.preset]
    if (!p) {
      return {
        mode: 'preset', preset: opts.preset, coverage,
        error: `Unknown preset '${opts.preset}'. Valid: ${Object.keys(TRANSCRIPT_PRESETS).join(', ')}`,
      }
    }
    sql = p.sql
    mode = 'preset'
  } else {
    try {
      sql = assertReadOnlySelect(opts.sql as string)
    } catch (e) {
      return { mode: 'sql', error: (e as Error).message, coverage }
    }
    mode = 'sql'
  }

  if (files.length === 0) {
    return {
      mode, ...(opts.preset ? { preset: opts.preset } : {}), coverage,
      error: opts.sessionId
        ? `No transcript file found for session ${opts.sessionId}.`
        : `No transcripts modified in the last ${windowHours}h — widen windowHours or pass a sessionId.`,
    }
  }

  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DEFAULT_ROWS)), HARD_MAX_ROWS)

  // Lazy import, same reason as store/db.ts: only paths that actually query pay for the native binding.
  const { DuckDBInstance } = await import('@duckdb/node-api')
  const inst = await DuckDBInstance.create(':memory:', { memory_limit: '2GB', threads: '2' })
  const con = await inst.connect()
  try {
    // Paths come from OUR directory walk (never from the caller); the quote-escape is belt-and-braces.
    const list = files.map((f) => `'${f.path.replace(/'/g, "''")}'`).join(',')
    await con.run(
      `CREATE VIEW transcripts AS SELECT * FROM read_ndjson_auto([${list}], ` +
      `union_by_name=true, ignore_errors=true, filename=true, maximum_object_size=${MAX_OBJECT_SIZE})`,
    )
    // limit+1 so a cap is REPORTED, not silently applied as if it were the full result.
    const reader = await con.runAndReadAll(`SELECT * FROM (${sql}) LIMIT ${limit + 1}`)
    const rowsJson = reader.getRowObjectsJson() as Array<Record<string, unknown>>
    const capped = rowsJson.length > limit
    const rows = capped ? rowsJson.slice(0, limit) : rowsJson

    // Torn-line disclosure: only after the main query succeeded (one extra round-trip). A malformed
    // line lands as an all-NULL row under ignore_errors, not a dropped one — count(*) alone would
    // pass silently, so compare against count(type) ('type' is written on every real record, unlike
    // 'timestamp'/'message' which some record shapes omit).
    const [{ total: tlTotal, withCol: tlWithCol }] =
      (await con.runAndReadAll(tornLineSql('transcripts', 'type'))).getRowObjectsJson()
        .map((r) => ({ total: Number((r as Record<string, unknown>).total ?? 0), withCol: Number((r as Record<string, unknown>).withCol ?? 0) }))
    const tornLines = tlTotal - tlWithCol

    return {
      mode, ...(opts.preset ? { preset: opts.preset } : {}),
      columns: reader.columnNames(), rows, rowCount: rows.length,
      coverage: {
        ...coverage,
        note: coverage.note
          + (capped ? ` Rows capped at ${limit} — pass a larger limit (max ${HARD_MAX_ROWS}).` : '')
          + (tornLines > 0 ? ` ${tornLines} line(s) unparseable and excluded.` : ''),
      },
    }
  } catch (e) {
    // Binder errors on sparse schemas ("no column message") surface honestly — the queried window
    // simply has no such records; the error message says which column, the coverage says which files.
    return { mode, ...(opts.preset ? { preset: opts.preset } : {}), error: `query failed: ${(e as Error).message}`, coverage }
  } finally {
    con.closeSync()
    inst.closeSync()
  }
}
