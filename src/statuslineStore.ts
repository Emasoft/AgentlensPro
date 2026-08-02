// src/statuslineStore.ts — the high-frequency status-line sample store.
//
// WHAT LANDS HERE. Every payload Claude Code hands `statusLine` / `subagentStatusLine`, forwarded by
// `agentlenspro statusline`. Measured live: 396 samples/min across 13 sessions (~30/min each, mean
// 1509 B) ⇒ ~609/min ≈ 1.29 GB/day of raw JSON at 20 concurrent instances. That volume is why these
// samples cannot live in the shared hook-event bucket (they were evicting the 600-slot lifecycle ring
// down to an ~87 s span) and why they are stored columnar and compressed.
//
// THE LAYOUT, and every part of it is a measured choice, not a preference:
//
//   <root>/<stream>/YYYY-MM-DD/part-<epochMs>-<pid>-<seq>.parquet   sealed, immutable
//   <root>/<stream>/YYYY-MM-DD/wal-<pid>.ndjson                     active, un-sealed
//
// * PARQUET+ZSTD, not zstd-NDJSON. Measured over 40k real-but-perturbed samples: parquet wins at
//   every realistic chunk size (10k rows: 823 KB vs 933 KB; 40k: 3197 KB vs 3724 KB) AND answers a
//   column-pruned GROUP BY in 12 ms. It only loses below ~1k rows, where its ~40-leaf footer
//   metadata dominates — hence SEAL_ROWS is large.
// * FLAT DOTTED KEYS, not nested structs. Measured identical in size (3194.6 KB vs 3196.6 KB) and
//   far simpler to query: `context_window_used_percentage`, not `(context_window).used_percentage`.
//   Arrays are NOT flattened — `tasks[]` stays a LIST so the subagent stream can be `unnest`ed.
// * NO PACKING OF N SAMPLES PER ROW. Measured 2% WORSE (3257 KB vs 3195 KB). Parquet's
//   dictionary+RLE already collapses an unchanging column across the whole row group, not a
//   10-sample window: over 40,000 samples `context_window_context_window_size` costs 71 BYTES total
//   (0.002 B/sample) and `session_id` 434 B. Packing can only take ~0 to ~0 while adding
//   list-repetition overhead to the ~68% of fields that do vary.
// * NO UUID TYPING. Measured to save exactly 0 bytes: ZSTD already compresses a 36-char UUID string
//   to 16.0 B/sample, which IS a UUID's 122-bit entropy — native 16-byte storage cannot beat the
//   entropy floor either. `prompt_id` costs 20% of the file because that is what it is worth, and it
//   earns it as the only join key to the OTEL span store (docs: it equals the `prompt.id` attribute).
//
// WAL-THEN-SEAL. A 10k-row chunk is ~16 minutes at 20 instances; losing that to a crash is not
// acceptable, so samples are first appended to a plain NDJSON WAL and only converted to Parquet once
// the chunk is full. The WAL is written with the exact discipline of src/accountStateTimeline.ts:
// buffer, one open+write, ONE fsync per BATCH (never per record), re-buffer on failure, never throw.

import * as fs from 'fs'
import * as path from 'path'
import { dayKeyMs } from './ndjsonBuckets'

/** The two capture surfaces. Separate trees because their schemas share almost nothing: the main
 *  stream is one sample per row, the subagent stream carries a `tasks[]` list of live agents. */
export type StatuslineStream = 'main' | 'subagent'
export const STATUSLINE_STREAMS: readonly StatuslineStream[] = ['main', 'subagent']

/** Rows per sealed part. Large on purpose — see the footer-metadata note in the header. Read per
 *  call, not frozen at import, so a test (or an operator) can change it without reloading the module. */
export function sealRows(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env['AGENTLENS_STATUSLINE_SEAL_ROWS'])
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000
}

/** Day-partitions older than this are purged whole. */
export function retentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env['AGENTLENS_STATUSLINE_RETENTION_DAYS'])
  return Number.isFinite(raw) && raw > 0 ? raw : 90
}

const FLUSH_MAX_RECORDS = 32
const FLUSH_MAX_BYTES = 16 * 1024

/** Flatten nested OBJECTS to dotted keys; leave ARRAYS and scalars alone.
 *
 *  Arrays are deliberately untouched: `tasks[]` is the subagent stream's payload and must stay a LIST
 *  so DuckDB can `unnest` it. Flattening it into tasks_0_*, tasks_1_* would create an unbounded,
 *  drifting column space — the one thing that actually would make this store expensive. */
export function flattenSample(v: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(v ?? {})) {
    const key = `${prefix}${k}`
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      Object.assign(out, flattenSample(val as Record<string, unknown>, `${key}_`))
    } else {
      out[key] = val
    }
  }
  return out
}

/** UTC day key for a timestamp — the partition directory name. */
export function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

/** A part name that CANNOT collide across concurrent writers. Load-bearing, and copied deliberately
 *  from src/store/db.ts:58: DuckDB's `COPY TO` SILENTLY OVERWRITES an existing file, so a scheme that
 *  can repeat a name silently DESTROYS a sealed chunk. Deriving it from a directory file count is the
 *  exact bug that did so once — epoch-ms + pid + per-instance seq needs no coordination. */
function partName(seq: number): string {
  return `part-${Date.now()}-${process.pid}-${seq}.parquet`
}

/** SQL-quote a path for a COPY / read_* literal. */
function q(p: string): string { return `'${p.replace(/'/g, "''")}'` }

function listFiles(dir: string, pred: (f: string) => boolean): string[] {
  try { return fs.readdirSync(dir).filter(pred).map(f => path.join(dir, f)) } catch { return [] }
}

/** Every day-partition directory of a stream, oldest first, with its parsed day. Directories whose
 *  name is not a calendar-real 'YYYY-MM-DD' are IGNORED, never touched — the same rule (and the same
 *  parser) that keeps a foreign or malformed name from becoming an unpurgeable file forever. */
export function dayPartitions(root: string, stream: StatuslineStream): Array<{ dir: string; dayMs: number }> {
  const base = path.join(root, stream)
  let names: string[]
  try { names = fs.readdirSync(base) } catch { return [] }
  const out: Array<{ dir: string; dayMs: number }> = []
  for (const n of names) {
    const ms = dayKeyMs(n)
    if (ms === null) continue
    out.push({ dir: path.join(base, n), dayMs: ms })
  }
  return out.sort((a, b) => a.dayMs - b.dayMs)
}

/** One extra day of slack on each end of a window's PARTITION selection.
 *
 *  A record's `ts` and the partition it lives in are not guaranteed to agree: `flush()` files a whole
 *  batch under the day it is WRITTEN, so a batch appended just before UTC midnight and flushed just
 *  after lands its records in the NEXT day's partition. Without slack, a query whose window is that
 *  earlier day skips the later partition entirely and the records vanish — MEASURED: such a record
 *  made the query return **BLIND**, which in this module means "we cannot see", when the data existed
 *  and matched the window. Reporting absence as blindness is the one failure this store must not have.
 *
 *  Widening only admits more candidate FILES; `queryStatusline` still filters every row on `ts`, so
 *  no out-of-window row can be returned. Cost is at most two extra partitions per query. */
const PARTITION_SLACK_MS = 86_400_000

/** Sealed parts + un-sealed WALs across a stream, optionally limited to a time window. The window is
 *  applied at DAY granularity only — a partition is included when its day overlaps [since, until],
 *  widened by PARTITION_SLACK_MS because a record's day and its partition's day can differ. */
export function filesInWindow(
  root: string, stream: StatuslineStream, sinceMs?: number, untilMs?: number,
): { parts: string[]; wals: string[] } {
  const parts: string[] = []
  const wals: string[] = []
  for (const { dir, dayMs } of dayPartitions(root, stream)) {
    if (sinceMs !== undefined && dayMs + 86_400_000 + PARTITION_SLACK_MS <= sinceMs) continue
    if (untilMs !== undefined && dayMs > untilMs + PARTITION_SLACK_MS) continue
    parts.push(...listFiles(dir, f => f.endsWith('.parquet')))
    wals.push(...listFiles(dir, f => f.startsWith('wal-') && f.endsWith('.ndjson')))
  }
  return { parts, wals }
}

/** The relation covering a window: sealed parts UNION the live WALs.
 *
 *  Both halves matter. Reading only the parts would make every query stale by up to a whole chunk
 *  (~16 min); reading only the WAL would see nothing older than the last seal. Returns null when
 *  there is genuinely nothing — a caller must report that as BLIND, and must NOT hand DuckDB a bare
 *  glob, which is an ERROR on an empty directory rather than an empty set (src/store/db.ts:86-87).
 *
 *  `union_by_name` is what tolerates schema drift: optional blocks (`pr`, `worktree`, `agent`) appear
 *  and vanish mid-stream, and a future Claude Code version may add fields. */
/** The columns a query may reference even when NO file in the window happens to carry them.
 *
 *  WITHOUT THIS, ABSENCE IS AN ERROR RATHER THAN AN EMPTY RESULT. `union_by_name` fills a column
 *  that SOME file has; a column NO file in the window has simply does not exist, and referencing it
 *  is `Binder Error: Referenced column "..." not found in FROM clause`. Measured: a single sample
 *  lacking the optional `rate_limits` and `current_usage` blocks — exactly what an older Claude Code
 *  build, or any turn before those blocks existed, produces — killed ALL FIVE main-stream views.
 *  That breaks this module's own contract: no data must read as BLIND, never as a crash.
 *
 *  Declared as a zero-row typed relation, so every name below is guaranteed to bind and to be NULL
 *  when unobserved. It is a CONTRACT, not a schema: files still contribute any other column they
 *  carry, and a genuinely mistyped reference still fails loudly rather than silently returning NULL.
 *
 *  `tasks` is deliberately ABSENT from this list. It is the subagent stream's own payload so it is
 *  never missing there, and declaring a LIST type here risks conflicting with the real
 *  LIST(STRUCT(...)) during reconciliation — the exact class of failure this is meant to prevent. */
const GUARANTEED_COLUMNS: ReadonlyArray<[string, string]> = [
  // `ts` first because it is the ONE column every query touches unconditionally: queryStatusline
  // splices `ts >= …` / `ts <= …` into the window predicate, so a file without it would fail the
  // same way the optional blocks did. `append()` always writes it — which is exactly the reasoning
  // that was wrong about session_id always being a UUID, so it is guaranteed rather than assumed.
  ['ts', 'BIGINT'],
  ['session_id', 'VARCHAR'],
  ['model_display_name', 'VARCHAR'],
  ['model_id', 'VARCHAR'],
  ['effort_level', 'VARCHAR'],
  ['context_window_used_percentage', 'DOUBLE'],
  ['context_window_total_input_tokens', 'BIGINT'],
  ['context_window_current_usage_input_tokens', 'BIGINT'],
  ['context_window_current_usage_output_tokens', 'BIGINT'],
  ['context_window_current_usage_cache_creation_input_tokens', 'BIGINT'],
  ['context_window_current_usage_cache_read_input_tokens', 'BIGINT'],
  ['cost_total_cost_usd', 'DOUBLE'],
  ['rate_limits_five_hour_used_percentage', 'DOUBLE'],
  ['rate_limits_seven_day_used_percentage', 'DOUBLE'],
  ['rate_limits_five_hour_resets_at', 'BIGINT'],
  // The workspace block, which the `--project` filter matches on. Three location fields because a
  // session can legitimately sit at any of them: `workspace_project_dir` is the root Claude Code was
  // opened at, `workspace_current_dir`/`cwd` follow the agent (a worktree agent runs under
  // <root>/.claude/worktrees/<x>). The subagent stream does NOT carry the workspace_* pair at the
  // top level (MEASURED on the live store: 0 of 6,740 samples) — but it DOES carry top-level
  // `session_id` and `cwd` (6,740 and 6,737 of 6,740; the PARENT session's cwd), which is what lets
  // --session and --project filter that stream: in the OR-chain the populated `cwd` term decides the
  // row while the NULL workspace_* terms fall away. The per-agent worktree cwd additionally lives
  // inside `tasks[]`. The absent pair is precisely why these are guaranteed rather than assumed:
  // referencing an absent column is a binder error that kills the whole view.
  ['workspace_project_dir', 'VARCHAR'],
  ['workspace_current_dir', 'VARCHAR'],
  ['cwd', 'VARCHAR'],
  ['workspace_repo_owner', 'VARCHAR'],
  ['workspace_repo_name', 'VARCHAR'],
  ['version', 'VARCHAR'],
  // The rest of what the `project` view reports. `fast_mode` and `exceeds_200k_tokens` are here
  // because both change what a turn COSTS (fast mode, and the 1M-context tier), so a view that
  // silently dropped them would answer a cost question with a number that cannot be interpreted.
  ['session_name', 'VARCHAR'],
  ['fast_mode', 'BOOLEAN'],
  ['thinking_enabled', 'BOOLEAN'],
  ['exceeds_200k_tokens', 'BOOLEAN'],
  ['rate_limits_seven_day_resets_at', 'BIGINT'],
]

/** The zero-row template: guarantees every GUARANTEED_COLUMNS name binds, whatever the files hold. */
const COLUMN_TEMPLATE = `SELECT ${GUARANTEED_COLUMNS.map(([c, t]) => `NULL::${t} AS ${c}`).join(', ')} WHERE false`

/** Normalize ONE source: force `session_id` to VARCHAR and guarantee the contract columns bind.
 *
 *  WHY the session_id half — and it is not theoretical, three of five views were dead on the live
 *  store when this was written. DuckDB infers a UUID-*shaped* string as the UUID type, PER FILE.
 *  Sealed parts had inferred UUID (35,788 rows); the live WAL held one session whose id was not
 *  UUID-shaped and so inferred VARCHAR (8,007 rows); `UNION ALL BY NAME` reconciles those to UUID,
 *  and the whole query dies with `Could not convert string 'x' to INT128`. ONE row with a non-UUID
 *  session id blinds every view that touches the column. A `CAST(... AS VARCHAR)` in the SELECT list
 *  cannot help — the failure happens in the union, before any projection.
 *
 *  The template is doing TWO jobs. `* REPLACE` is a BINDER error when the column is absent, so
 *  without a template a malformed source with no `session_id` would trade one total failure for
 *  another; and it supplies the guaranteed columns above. (The template alone does NOT fix the
 *  session_id TYPE — measured: UUID still wins the reconciliation, hence the outer REPLACE.)
 *  Casting UUID→VARCHAR is lossless: the id comes back as its canonical text. */
function varcharSessionId(inner: string): string {
  return 'SELECT * REPLACE (CAST(session_id AS VARCHAR) AS session_id)'
    + ` FROM (${COLUMN_TEMPLATE} UNION ALL BY NAME ${inner})`
}

export function relationFor(
  root: string, stream: StatuslineStream, sinceMs?: number, untilMs?: number,
): string | null {
  const { parts, wals } = filesInWindow(root, stream, sinceMs, untilMs)
  // ONE normalized relation PER FILE, deliberately not one multi-file read_parquet/read_json_auto.
  // Both readers resolve a single schema across their file list — `read_parquet` takes it from the
  // FIRST file and casts the rest to it, and when a UUID-typed part meets a VARCHAR-typed one it
  // picks UUID, so a non-UUID id fails with `failed to cast column "session_id" from type VARCHAR to
  // UUID`. That coercion happens INSIDE the reader, before any wrapper can project, so normalizing
  // the reader's output is too late: the cast must be applied to each file's own relation.
  // Cheap — the file list is already bounded by the query window, and DuckDB still scans in parallel.
  const rels = [
    ...parts.map(p => varcharSessionId(`SELECT * FROM read_parquet(${q(p)})`)),
    ...wals.map(w => varcharSessionId(`SELECT * FROM read_json_auto(${q(w)}, ignore_errors=true)`)),
  ]
  if (rels.length === 0) return null
  return `(${rels.join(' UNION ALL BY NAME ')})`
}

/** Open the FILELESS DuckDB used for every read and every seal.
 *
 *  ':memory:' is not a preference — a persistent .duckdb measured 300x write amplification
 *  (5,018 KB/turn), and memory_limit does NOT fix it (src/store/db.ts:3-21). The import is lazy so
 *  the hook / gate / --version paths never load the native binding. */
async function openDuck(): Promise<{ con: DuckConn; close: () => void }> {
  const { DuckDBInstance } = await import('@duckdb/node-api')
  const inst = await DuckDBInstance.create(':memory:', {
    memory_limit: process.env['AGENTLENS_DUCKDB_MEMORY_LIMIT']?.trim() || '2GB',
    threads: '2',
  })
  const con = await inst.connect()
  // No spill: an over-limit query must fail loudly, not quietly write gigabytes to the SSD.
  await con.run("SET temp_directory = ''")
  await con.run('SET preserve_insertion_order = false')
  return { con: con as unknown as DuckConn, close: () => { con.closeSync(); inst.closeSync() } }
}

/** The sliver of the DuckDB API this module uses — declared locally so the lazy import stays lazy
 *  (a top-level `import type` from the native package would be erased, but the shape is tiny). */
interface DuckConn {
  run(sql: string): Promise<unknown>
  runAndReadAll(sql: string): Promise<{ getRowObjects(): Array<Record<string, unknown>> }>
}

export interface StatuslineStoreStats {
  parts: number
  partBytes: number
  walBytes: number
  bufferedRows: number
  sealedParts: number
  droppedRows: number
  /** WALs the seal REFUSED because their record structure could not be inferred. Non-zero means raw
   *  JSON is sitting unsealed and unqueryable-by-field — visible here rather than silent. */
  corruptWals: number
}

/**
 * One instance per server process. `append()` is called at the full sample rate, so it must stay a
 * push onto an array; everything expensive happens on the flush/seal boundaries.
 */
export class StatuslineStore {
  private readonly root: string
  private readonly flushMs: number
  private buffers = new Map<StatuslineStream, string[]>()
  private bufferedBytes = new Map<StatuslineStream, number>()
  private walRows = new Map<string, number>()   // wal path → rows written since it was created
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private seq = 0
  private sealing = false
  sealedParts = 0
  droppedRows = 0
  /** WALs refused because the reader could not infer their record structure — see inferenceCollapsed.
   *  Surfaced in stats() so a corrupt WAL is visible instead of silently re-read raw forever. */
  corruptWals = 0

  constructor(opts: { root: string; flushMs?: number; autoTimer?: boolean }) {
    this.root = opts.root
    this.flushMs = opts.flushMs ?? Math.max(1000, Number(process.env['AGENTLENS_STATUSLINE_FLUSH_MS']) || 5000)
    if (opts.autoTimer !== false) {
      this.flushTimer = setInterval(() => { this.flush() }, this.flushMs)
      this.flushTimer.unref?.()   // never keep the process alive just for this timer
    }
  }

  /** Buffer one sample. Flattens to dotted keys and stamps `ts` (server receive time) — the payload
   *  itself carries no timestamp, and every query and every partition boundary needs one. */
  append(payload: Record<string, unknown>, stream: StatuslineStream = 'main', ts: number = Date.now()): void {
    const flat = flattenSample(payload)
    flat.ts = ts
    const line = JSON.stringify(flat)
    const buf = this.buffers.get(stream) ?? []
    buf.push(line)
    this.buffers.set(stream, buf)
    this.bufferedBytes.set(stream, (this.bufferedBytes.get(stream) ?? 0) + line.length + 1)
    if (buf.length >= FLUSH_MAX_RECORDS || (this.bufferedBytes.get(stream) ?? 0) >= FLUSH_MAX_BYTES) {
      this.flush(stream)
    }
  }

  /** Append the buffered batch to the day's WAL — one open, one write, ONE fsync per BATCH. Never
   *  throws: a write failure re-buffers the batch so the next flush retries it in order. */
  flush(only?: StatuslineStream): void {
    for (const stream of STATUSLINE_STREAMS) {
      if (only && stream !== only) continue
      const batch = this.buffers.get(stream)
      if (!batch || batch.length === 0) continue
      this.buffers.set(stream, [])
      this.bufferedBytes.set(stream, 0)
      // Partition by the day this batch is WRITTEN, not by any record's own ts. A batch appended
      // just before UTC midnight and flushed just after therefore files those records under the NEXT
      // day — deliberately, because splitting every batch by day would cost a day-key computation and
      // a possible second open/fsync on every flush, at the full sample rate, to fix a skew of at
      // most one flush interval per boundary.
      //
      // The skew is NOT free, though, and the comment here used to claim the opposite ("harmless"):
      // partition selection is by day, so an un-slacked window would skip the partition holding those
      // records and report BLIND. That is why filesInWindow carries PARTITION_SLACK_MS — the two are
      // a pair, and neither is safe to change without the other.
      const wal = this.walPath(stream, Date.now())
      const lines = batch.join('\n') + '\n'
      try {
        fs.mkdirSync(path.dirname(wal), { recursive: true })
        const fd = fs.openSync(wal, 'a')          // O_APPEND: atomic append at EOF
        try {
          fs.writeSync(fd, lines)
          fs.fsyncSync(fd)                         // durability once per BATCH, never per record
        } finally {
          fs.closeSync(fd)
        }
        this.walRows.set(wal, (this.walRows.get(wal) ?? this.countLines(wal) - batch.length) + batch.length)
      } catch {
        // Transient failure — put the batch back in FRONT of anything enqueued meanwhile so order is
        // preserved, and drop it only if the backlog becomes absurd (a full disk must not OOM us).
        const cur = this.buffers.get(stream) ?? []
        if (cur.length + batch.length > FLUSH_MAX_RECORDS * 200) {
          this.droppedRows += batch.length
        } else {
          this.buffers.set(stream, batch.concat(cur))
          this.bufferedBytes.set(stream, (this.bufferedBytes.get(stream) ?? 0) + lines.length)
        }
      }
    }
  }

  private walPath(stream: StatuslineStream, ts: number): string {
    return path.join(this.root, stream, dayKey(ts), `wal-${process.pid}.ndjson`)
  }

  private countLines(file: string): number {
    try {
      const raw = fs.readFileSync(file, 'utf8')
      if (raw.length === 0) return 0
      return raw.split('\n').filter(l => l.length > 0).length
    } catch { return 0 }
  }

  /** Seal every WAL that is full (or belongs to a past day) into an immutable Parquet part.
   *
   *  Safe to call on a timer: it is a no-op when nothing qualifies, and re-entrancy is guarded
   *  because a seal is async while `append` keeps running. */
  async maybeSeal(nowMs: number = Date.now()): Promise<number> {
    if (this.sealing) return 0
    this.sealing = true
    let sealed = 0
    try {
      const today = dayKey(nowMs)
      for (const stream of STATUSLINE_STREAMS) {
        for (const { dir } of dayPartitions(this.root, stream)) {
          const isPastDay = path.basename(dir) !== today
          for (const wal of listFiles(dir, f => f.startsWith('wal-') && f.endsWith('.ndjson'))) {
            let rows = this.countLines(wal)
            if (rows === 0) { if (isPastDay) { try { fs.unlinkSync(wal) } catch { /* raced */ } } continue }
            // A WAL is sealed early in two cases where it will NEVER grow again, because leaving it
            // open costs every query a raw-JSON re-read of a file that can only get colder:
            //   * a PAST day's partition, and
            //   * an ORPHAN — a WAL named for a pid that is not ours. WALs are per-pid, so every
            //     server restart strands one; three restarts left 9.4 MB of raw JSON here that
            //     would have sat unsealed until midnight.
            const orphan = path.basename(wal) !== `wal-${process.pid}.ndjson`
            if (!isPastDay && !orphan && rows < sealRows()) continue
            let target = wal
            if (!isPastDay && !orphan) {
              // ROTATE our own LIVE WAL before sealing it. flush() keeps appending to the fixed
              // per-pid name, and sealOne awaits between the count and the COPY — so sealing the
              // live file in place races the appender: COPY reads more rows than were counted,
              // the verify fails, and a whole DuckDB instance is wasted per tick. After the atomic
              // rename the rotated file can never grow again (flush recreates the live name on its
              // next write), so the recount below is exact and the race is gone by construction.
              const rot = wal.replace(/\.ndjson$/, `.rot-${Date.now().toString(36)}${this.seq}.ndjson`)
              try { fs.renameSync(wal, rot) } catch { continue }   // raced with a purge — next tick
              // Drop the stale row-count cache: flush() derives the fresh WAL's count from it, and
              // a leftover entry for the old path would over-count the file that replaces it.
              this.walRows.delete(wal)
              target = rot
              rows = this.countLines(rot)   // appends between count and rename landed in the rotation
              if (rows === 0) continue
            }
            if (await this.sealOne(target, rows)) sealed++
          }
        }
      }
    } finally {
      this.sealing = false
    }
    this.sealedParts += sealed
    return sealed
  }

  /** Did `read_json_auto` give up on this file's RECORD structure and fall back to one opaque column?
   *
   *  MEASURED, and this is the nastiest failure the store has: ONE line containing a bare scalar
   *  (`42`) makes the reader infer the WHOLE file as a single `json` column instead of the record
   *  fields — `DESCRIBE` returns exactly `[json]`. Every real field then reads NULL. Sealing that
   *  writes a part of all-NULL rows and DELETES the WAL, so recoverable raw JSON is destroyed and the
   *  row COUNT still matches, meaning verify-before-delete waves it straight through.
   *
   *  It stayed hidden because it used to fail for an unrelated reason: without `ts` guaranteed, the
   *  seal's `ORDER BY session_id, ts` could not bind against the degenerate schema, so the seal threw
   *  and the WAL survived BY ACCIDENT. Guaranteeing `ts` (correct on its own — every query references
   *  it) removed that accident and turned a recoverable degradation into permanent data loss. Hence
   *  this explicit check: refuse deliberately, keep the raw lines, and COUNT it so it is not silent. */
  private inferenceCollapsed(cols: string[]): boolean {
    return cols.length === 1 && cols[0] === 'json'
  }

  /** Convert ONE WAL to a Parquet part and delete it — but only after PROVING the part holds every
   *  row. Verify-before-delete is the store's standing rule: the WAL is the only other copy. */
  private async sealOne(wal: string, expectRows: number): Promise<boolean> {
    const dir = path.dirname(wal)
    const out = path.join(dir, partName(this.seq++))
    // Defence in depth behind the collision-free name: COPY TO silently overwrites, and an
    // overwritten part is destroyed data. If this fires, the naming invariant is broken — stop.
    if (fs.existsSync(out)) throw new Error(`refusing to overwrite existing part ${out} — part naming must be collision-free`)
    let duck: { con: DuckConn; close: () => void } | null = null
    try {
      // openDuck INSIDE the try: a native-module/OOM failure here used to escape sealOne entirely,
      // turning the 60 s seal timer into an unhandled-rejection warning on every tick — the exact
      // failure the never-throw contract below exists to prevent.
      duck = await openDuck()
      // Refuse a file whose record structure the reader could not infer — see inferenceCollapsed.
      // Metadata-only, and only on the seal path (a 60 s timer), never on the append path.
      const cols = (await duck.con.runAndReadAll(
        `SELECT column_name FROM (DESCRIBE SELECT * FROM read_json_auto(${q(wal)}, union_by_name=true, ignore_errors=true))`,
      )).getRowObjects().map(r => String(r.column_name))
      if (this.inferenceCollapsed(cols)) {
        this.corruptWals += 1
        return false   // keep the WAL: its raw JSON is the only readable copy of these samples
      }
      // ORDER BY session_id measured 1.24x better compression than arrival order: it clusters each
      // session's near-identical consecutive samples into single dictionary/RLE runs.
      //
      // The VARCHAR normalization is the ROOT fix for the UUID-inference trap (see varcharSessionId):
      // without it every seal of an all-UUID WAL writes a UUID-typed column, so the union with any
      // later VARCHAR source has to be repaired at read time forever. Sealing as VARCHAR means new
      // parts need no repair at all. Costs nothing — measured, UUID typing saved exactly 0 bytes,
      // because ZSTD already compresses the text to a UUID's 122-bit entropy.
      await duck.con.run(
        `COPY (SELECT * FROM (${varcharSessionId(`SELECT * FROM read_json_auto(${q(wal)}, union_by_name=true, ignore_errors=true)`)}) ORDER BY session_id, ts)`
        + ` TO ${q(out)} (FORMAT PARQUET, COMPRESSION ZSTD)`,
      )
      const got = Number((await duck.con.runAndReadAll(`SELECT count(*) c FROM read_parquet(${q(out)})`)).getRowObjects()[0].c)
      if (got !== expectRows) {
        // Do NOT delete the WAL. Remove the untrustworthy part instead and leave the raw rows for the
        // next attempt — a short read here would otherwise silently destroy samples.
        try { fs.unlinkSync(out) } catch { /* best effort */ }
        // A SHORT part means rows were LOST in conversion outright. MEASURED, this shape does not
        // occur for a malformed line (see the NULL-row check below) — but if a DuckDB version ever
        // does short-read, the retry can never converge, so COUNT it or the WAL re-fails forever
        // while stats() shows nothing wrong. got > expectRows cannot happen any more (live WALs
        // are rotated before sealing, and orphans never grow); if it ever does, plain retry.
        if (got < expectRows) this.corruptWals += 1
        return false
      }
      // ignore_errors does NOT drop an unparseable line — MEASURED: it lands as an all-NULL row,
      // so the count matches and the verify passes. Sealing then converts a torn line (a crash
      // mid-write) into a NULL row and deletes its raw bytes. Acceptable — the line was garbage —
      // but never silently: count(ts) < count(*) can only mean broken source lines, because
      // append() writes ts on every record.
      const withTs = Number((await duck.con.runAndReadAll(`SELECT count(ts) c FROM read_parquet(${q(out)})`)).getRowObjects()[0].c)
      if (withTs < got) this.corruptWals += got - withTs
      fs.unlinkSync(wal)
      this.walRows.delete(wal)
      return true
    } catch {
      try { if (fs.existsSync(out)) fs.unlinkSync(out) } catch { /* best effort */ }
      return false   // never throw out of the seal path — the next tick retries
    } finally {
      duck?.close()
    }
  }

  /** Graceful shutdown: stop the timer and flush the buffer to the WAL. Deliberately SYNCHRONOUS and
   *  deliberately NOT sealing — the server's shutdown path is sync and ends in process.exit, and a
   *  seal is unnecessary there because the WAL is already fsynced and every read unions the WALs.
   *  The next boot's seal timer converts it. */
  stop(): void {
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null }
    this.flush()
  }

  /** Delete whole day-partitions older than retentionDays. Malformed directory names are ignored,
   *  never deleted (dayPartitions gate) — deleting an unrecognised directory is how a store eats
   *  something that was not its own. */
  purge(days: number = retentionDays(), nowMs: number = Date.now()): { removed: string[]; freedBytes: number } {
    const removed: string[] = []
    let freedBytes = 0
    const cutoffMs = dayKeyMs(dayKey(nowMs - days * 86_400_000)) ?? 0
    for (const stream of STATUSLINE_STREAMS) {
      for (const { dir, dayMs } of dayPartitions(this.root, stream)) {
        if (dayMs >= cutoffMs) continue
        try {
          for (const f of fs.readdirSync(dir)) {
            try { freedBytes += fs.statSync(path.join(dir, f)).size } catch { /* raced */ }
          }
          fs.rmSync(dir, { recursive: true, force: true })
          removed.push(path.relative(this.root, dir))
        } catch { /* raced — skip */ }
      }
    }
    return { removed, freedBytes }
  }

  stats(): StatuslineStoreStats {
    let parts = 0, partBytes = 0, walBytes = 0
    for (const stream of STATUSLINE_STREAMS) {
      for (const { dir } of dayPartitions(this.root, stream)) {
        for (const f of listFiles(dir, () => true)) {
          let size = 0
          try { size = fs.statSync(f).size } catch { continue }
          if (f.endsWith('.parquet')) { parts++; partBytes += size } else if (f.endsWith('.ndjson')) { walBytes += size }
        }
      }
    }
    let bufferedRows = 0
    for (const b of this.buffers.values()) bufferedRows += b.length
    return { parts, partBytes, walBytes, bufferedRows, sealedParts: this.sealedParts, droppedRows: this.droppedRows, corruptWals: this.corruptWals }
  }
}

/** Run one read-only SELECT against a stream. `sql` must reference the relation as `samples`.
 *
 *  Returns null when the window holds no data at all, which a caller MUST surface as BLIND rather
 *  than as "nothing happened" — the honesty contract burnInvestigator's `coverage.blind` sets. */
export async function queryStatusline(
  root: string, stream: StatuslineStream, sql: string,
  opts: { sinceMs?: number; untilMs?: number } = {},
): Promise<Array<Record<string, unknown>> | null> {
  const rel = relationFor(root, stream, opts.sinceMs, opts.untilMs)
  if (!rel) return null
  const duck = await openDuck()
  try {
    const where: string[] = []
    if (opts.sinceMs !== undefined) where.push(`ts >= ${Number(opts.sinceMs)}`)
    if (opts.untilMs !== undefined) where.push(`ts <= ${Number(opts.untilMs)}`)
    const scoped = where.length ? `(SELECT * FROM ${rel} WHERE ${where.join(' AND ')})` : rel
    const rows = (await duck.con.runAndReadAll(`WITH samples AS ${scoped} ${sql}`)).getRowObjects()
    return rows
  } finally {
    duck.close()
  }
}
