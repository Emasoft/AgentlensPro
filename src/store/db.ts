// The body store's DuckDB layer (TRDD-K3WDPR7M Phase 2) — FILELESS DuckDB + IMMUTABLE zstd Parquet.
//
// THE MEASUREMENT THAT DICTATES THIS SHAPE (real device writes via ri_diskio_byteswritten, NOT
// file-size growth — file size lies: a row-group rewrite burns writes without growing the file):
//
//   layout                                   write/turn      stored
//   append-only zstd floor (no engine)            14 KB      1.98 MB
//   FILELESS DuckDB -> immutable Parquet          15 KB      1.21 MB   <-- this
//   tuned SQLite                                  65 KB      3.30 MB
//   naive SQLite                                 125 KB      2.96 MB
//   PERSISTENT DuckDB .db                      5,018 KB      4.01 MB   <-- 300x WORSE
//
// So: NEVER a persistent .duckdb file. DuckDB rewrites row-groups inside it, and a 881 KB turn cost
// 5 MB of device writes. The win comes from being fileless and flushing to Parquet parts that are
// written ONCE and never rewritten.
//
// AND NOTE WHAT memory_limit IS *NOT*: it does not remove the write amplification — the persistent
// .db burned 5 MB/turn WITH memory_limit set. Its real job here is to stop DuckDB SPILLING to disk.
// (Verified: `temp_directory` defaults to `.tmp` — DuckDB will happily page gigabytes onto the SSD
// mid-query. We set it to '' so an over-limit query FAILS LOUDLY instead of quietly burning the disk,
// which is also the fail-fast contract this project holds everywhere else.)
import type { DuckDBConnection } from '@duckdb/node-api'
import * as fs from 'fs'
import * as path from 'path'

export interface StoreOptions {
  /** Where the immutable Parquet parts live (usually <dataDir>/store). */
  dir: string
  /** DuckDB memory ceiling. Generous on purpose: we must never need to spill. */
  memoryLimit?: string
  threads?: number
}

export interface Store {
  con: DuckDBConnection
  dir: string
  /** sha256 of every span already DURABLE in a Parquet part — the cross-part dedup set. Parquet has
   *  no cross-file content-addressing, so the dedup has to be OURS or every flush would re-store
   *  spans that are already on disk. */
  known: Set<string>
  /** Per-store sequence used in part names — see partName() for why names must be collision-free. */
  nextPart: number
  close(): Promise<void>
}

/**
 * A part name that CANNOT collide across concurrent writers. This is load-bearing: DuckDB's
 * `COPY TO` SILENTLY OVERWRITES an existing file (verified by experiment, 2026-07-14), so if two
 * processes — the server's hourly ingest pass and a CLI backfill, say — ever derived the same name,
 * the second flush would silently DESTROY the first's spans: dangling references, unrecoverable
 * bodies, and nothing notices until someone asks for one. The first scheme did exactly that (a
 * monotonic counter seeded from the directory's FILE COUNT — two writers, same count, same name).
 *
 * epoch-ms + pid + per-store sequence needs no coordination: different processes differ in pid,
 * different stores in one process differ in seq, and one store is single-threaded per flush. Order
 * never mattered anyway — reads glob every part, and assembly order comes from the `pos` column.
 */
function partName(seq: number): string {
  return `part-${Date.now()}-${process.pid}-${seq}.parquet`
}

export const DEFAULT_MEMORY_LIMIT = '8GB'
export const DEFAULT_THREADS = 4

/** Resolve the memory ceiling: env > option > default. Generous by design — see the spill note above. */
export function memoryLimit(opts: StoreOptions, env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.AGENTLENS_DUCKDB_MEMORY_LIMIT?.trim()
  return raw && raw.length > 0 ? raw : (opts.memoryLimit ?? DEFAULT_MEMORY_LIMIT)
}

export const BLOBS_DIR = 'blobs'
export const BODIES_DIR = 'bodies'
export const PARTS_DIR = 'parts'

function partFiles(dir: string, sub: string): string[] {
  try {
    return fs.readdirSync(path.join(dir, sub))
      .filter((f) => f.endsWith('.parquet'))
      .map((f) => path.join(dir, sub, f))
  } catch { return [] }
}

/** SQL-quote a path for a COPY/read_parquet literal. */
function q(p: string): string { return `'${p.replace(/'/g, "''")}'` }

/** Every Parquet part in a sub-dir as a readable relation, or null when none exist yet (a bare glob
 *  over an empty dir is an ERROR in DuckDB, not an empty set — the classic first-run crash). */
export function parquetScan(dir: string, sub: string): string | null {
  const files = partFiles(dir, sub)
  if (files.length === 0) return null
  // `union_by_name := true` is LOAD-BEARING once parts span two schema generations (TRDD-219K7C1N).
  // A file LIST without it resolves ONE schema from the FIRST file, and measured on a two-part
  // fixture the outcome depends on READ ORDER: old-file-first DROPS the newer column from every row
  // with NO error, new-file-first throws `schema mismatch in glob`, and any query naming that column
  // throws a Binder Error. `partFiles` uses readdirSync over `part-<Date.now()>-…` names, so older
  // parts sort first in practice — the drop is the reachable one.
  // Reconciling by name costs ~0-40 ms across this store's 2,610 parts (84-134 ms either way, within
  // noise once the object cache is warm).
  // This is HALF the fix: it makes the parts agree with each other. Making them agree with the
  // staging table is `allOf`'s `UNION ALL BY NAME` — neither alone is sufficient.
  // NOTE this deliberately differs from statuslineStore's per-file normalization: THERE the schema is
  // INFERRED per file by read_json_auto (which can also collapse), so only a per-file relation is
  // safe. Parquet carries an explicit schema, so name-reconciliation is sufficient here — and a
  // 2,610-way UNION would be the slower answer to a problem this store does not have.
  return `read_parquet([${files.map(q).join(',')}], union_by_name := true)`
}

export async function openStore(opts: StoreOptions): Promise<Store> {
  // Imported lazily: the native binding is only needed by paths that actually touch the store, and a
  // top-level import would make every CLI invocation (--version, hook, gate) pay for loading it.
  const { DuckDBInstance } = await import('@duckdb/node-api')

  for (const sub of [BLOBS_DIR, BODIES_DIR, PARTS_DIR]) {
    fs.mkdirSync(path.join(opts.dir, sub), { recursive: true })
  }

  // ':memory:' — FILELESS. This is the single most important character in the file.
  const inst = await DuckDBInstance.create(':memory:', {
    memory_limit: memoryLimit(opts),
    threads: String(opts.threads ?? DEFAULT_THREADS),
  })
  const con = await inst.connect()
  // No spill. An over-limit query must fail, not silently write gigabytes to the SSD.
  await con.run("SET temp_directory = ''")
  // We never rely on row order (every read is keyed by body_id/pos), so let DuckDB parallelize freely.
  await con.run('SET preserve_insertion_order = false')
  // Cache Parquet footers/metadata across the part-glob re-scans (dedup reload at open, every body
  // reconstruction, ingest verification). Safe HERE because parts are immutable + content-addressed
  // (never rewritten in place), so a cached footer can never go stale (TRDD-802FP7ZL).
  await con.run('SET enable_object_cache = true')

  // Staging lives in RAM. It is flushed to immutable Parquet and then DELETEd — and a DELETE from an
  // in-memory table costs NO disk write, which is what keeps the per-turn cost at ~15 KB.
  await con.run(`
    CREATE TABLE blob (sha VARCHAR, n INTEGER, data VARCHAR);
    CREATE TABLE body (
      body_id VARCHAR, src_name VARCHAR, kind VARCHAR, session_id VARCHAR, ts TIMESTAMP,
      model VARCHAR, raw_bytes BIGINT, body_sha256 VARCHAR
    );
    CREATE TABLE part (
      body_id VARCHAR, pos INTEGER, kind VARCHAR, lit VARCHAR,
      sha VARCHAR, path VARCHAR, idx INTEGER, n INTEGER
    );
  `)

  // Re-load the dedup set from the durable parts, so a restart does not re-store spans we already have.
  const known = new Set<string>()
  const scan = parquetScan(opts.dir, BLOBS_DIR)
  if (scan) {
    const rows = (await con.runAndReadAll(`SELECT DISTINCT sha FROM ${scan}`)).getRowObjects()
    for (const r of rows) known.add(String(r.sha))
  }

  return {
    // nextPart starts at 0 per store instance: it only disambiguates flushes WITHIN this store —
    // cross-process uniqueness comes from the pid+timestamp in partName(). Deriving it from the
    // directory's file count (the first scheme) was the collision bug.
    con, dir: opts.dir, known, nextPart: 0,
    async close() { con.closeSync(); inst.closeSync() },
  }
}

export interface FlushResult {
  /** Number of blob spans made durable (0 when nothing was staged — same meaning as flush()'s old
   *  return value). */
  n: number
  /** Every part file this flush actually wrote (one per non-empty table: blob/body/part), so a caller
   *  that needs a durability barrier (fsync) knows EXACTLY which files to sync — never a guess at the
   *  name, which depends on partName()'s internal Date.now()+pid+seq. Empty when nothing was staged. */
  partPaths: string[]
}

/**
 * Flush staging to a NEW immutable Parquet part per table, then clear staging (in RAM — free).
 * Parts are never rewritten: that immutability IS the fix. Returns both the blob count (flush()'s
 * historical contract) and the paths actually written (needed by the fsync barrier — ingestPass.ts).
 */
export async function flushDetailed(store: Store): Promise<FlushResult> {
  const n = Number((await store.con.runAndReadAll('SELECT count(*) c FROM blob')).getRowObjects()[0].c)
  const bodies = Number((await store.con.runAndReadAll('SELECT count(*) c FROM body')).getRowObjects()[0].c)
  if (n === 0 && bodies === 0) return { n: 0, partPaths: [] }

  const tag = partName(store.nextPart++)
  const partPaths: string[] = []
  const write = async (table: string, sub: string) => {
    const c = Number((await store.con.runAndReadAll(`SELECT count(*) c FROM ${table}`)).getRowObjects()[0].c)
    if (c === 0) return
    const out = path.join(store.dir, sub, tag)
    // Defence in depth behind the unique name: COPY TO silently overwrites, and an overwritten part
    // is destroyed data. If this ever fires, the naming invariant is broken — stop, don't clobber.
    if (fs.existsSync(out)) throw new Error(`refusing to overwrite existing part ${out} — part naming must be collision-free`)
    await store.con.run(`COPY ${table} TO ${q(out)} (FORMAT PARQUET, COMPRESSION ZSTD)`)
    await store.con.run(`DELETE FROM ${table}`) // in-memory only — costs no disk write
    partPaths.push(out)
  }
  await write('blob', BLOBS_DIR)
  await write('body', BODIES_DIR)
  await write('part', PARTS_DIR)
  return { n, partPaths }
}

/** Back-compat wrapper: every existing caller only ever wanted the blob count. */
export async function flush(store: Store): Promise<number> {
  return (await flushDetailed(store)).n
}

/** A relation covering BOTH the durable Parquet parts and the not-yet-flushed staging table, so a read
 *  is correct whether or not a flush has happened. Without the staging half, a body ingested and read
 *  back in the same process would look like it did not exist. */
export function allOf(store: Store, table: 'blob' | 'body' | 'part'): string {
  const sub = table === 'blob' ? BLOBS_DIR : table === 'body' ? BODIES_DIR : PARTS_DIR
  const scan = parquetScan(store.dir, sub)
  // `UNION ALL BY NAME`, not positional — the OTHER half of TRDD-219K7C1N, and the scan's
  // union_by_name does not fix this one. Durable parts written before a column existed simply do not
  // have it, so mid-transition the scan yields N columns and the staging table N+1. Positional
  // `UNION ALL` then fails the arity check (`Set operations can only apply to expressions with the
  // same number of result columns`) and takes down EVERY store read until the last old part ages out
  // — measured on a two-generation fixture. BY NAME matches on column name instead, filling the
  // absent column with NULL for the old rows, which is the truth about them.
  // Keep BY NAME even though the arity error is loud: positional matching is also silently WRONG when
  // the counts happen to agree but the order does not (a column added in the MIDDLE of CREATE TABLE),
  // and that failure has no symptom at all.
  return scan ? `(SELECT * FROM ${scan} UNION ALL BY NAME SELECT * FROM ${table})` : `(SELECT * FROM ${table})`
}
