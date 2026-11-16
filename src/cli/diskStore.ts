// src/cli/diskStore.ts — the dedicated DuckDB file of the disk-space monitor (TRDD-HTARKH87).
//
// `<dataDir>/disk.duckdb` is its OWN file, never cards.duckdb: the sampler runs every 5 minutes from
// launchd, and a writer that shared the cards store would contend with the collector for the one
// DuckDB writer lock. DuckDB allows ONE read-write process OR several read-only ones, never both, so
// every opener here holds the file only for the milliseconds it needs: the sampler opens, inserts and
// closes TWICE per run (before and after the slow tree walks), and readers retry briefly on the lock.

import * as fs from "fs"
import * as path from "path"
import type { DuckDBConnection } from "@duckdb/node-api"
import { dataDir } from "../dataDir"

export const DISK_DB_FILE = "disk.duckdb"

export function diskDbPath(): string {
  return path.join(dataDir(), DISK_DB_FILE)
}

/** DDL. Volume rows carry NO symlink split on purpose: statfs reports a whole volume and cannot tell
 *  which bytes are reached through links; the with/without-symlink view lives in disk_tree. */
const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS disk_volume(
    ts TIMESTAMPTZ NOT NULL, mount TEXT NOT NULL, device TEXT, fs_type TEXT, container TEXT, volume_uuid TEXT,
    total_b BIGINT, used_b BIGINT, free_b BIGINT, avail_b BIGINT, vol_used_b BIGINT, container_free_b BIGINT,
    purgeable_b BIGINT, important_avail_b BIGINT, trash_b BIGINT, used_minus_trash_b BIGINT, error TEXT)`,
  `CREATE TABLE IF NOT EXISTS disk_tree(
    ts_start TIMESTAMPTZ NOT NULL, ts_end TIMESTAMPTZ NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL,
    apparent_b BIGINT, allocated_b BIGINT, apparent_follow_b BIGINT, allocated_follow_b BIGINT,
    files BIGINT, partial BOOLEAN NOT NULL, elapsed_ms BIGINT, error TEXT)`,
  `CREATE TABLE IF NOT EXISTS disk_watch(path TEXT PRIMARY KEY, kind TEXT NOT NULL)`,
  // A walk that outlives the per-run budget is RESUMED by the next run instead of restarted: ~ and ~/Code
  // cannot finish inside 40 s (measured), so without a persisted cursor they would never complete.
  `CREATE TABLE IF NOT EXISTS disk_walk_state(
    path TEXT PRIMARY KEY, ts_start TIMESTAMPTZ NOT NULL, last_segment TIMESTAMPTZ NOT NULL, root_real TEXT NOT NULL,
    root_dev BIGINT NOT NULL, apparent_b BIGINT, allocated_b BIGINT, apparent_follow_b BIGINT, allocated_follow_b BIGINT,
    files BIGINT, unreadable BIGINT, elapsed_ms BIGINT, first_error TEXT)`,
  `CREATE TABLE IF NOT EXISTS disk_walk_pending(path TEXT NOT NULL, seq BIGINT NOT NULL, dir TEXT NOT NULL, follow_only BOOLEAN NOT NULL, hops INTEGER NOT NULL)`,
  // Symlink targets (outside the walked root) already counted by an unfinished walk — the dedupe state of the "with symlinks" totals.
  // Cleared when the walk completes; without it a resumed walk would count the same target again.
  `CREATE TABLE IF NOT EXISTS disk_walk_followed(path TEXT NOT NULL, real TEXT NOT NULL, dev BIGINT NOT NULL, ino BIGINT NOT NULL)`,
]

export interface DiskDb {
  con: DuckDBConnection
  close: () => void
  /** When the writer lock was taken: stamped just BEFORE the successful DuckDBInstance.create (the lock is taken inside it), so the hold also covers the schema work done under it. */
  lockedAtMs: number
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** Open with a bounded retry on the DuckDB file lock — the other side (the sampler, or a reader) holds
 *  it for milliseconds, so a short wait is the right answer and a long one would hide a stuck process. */
async function openWithRetry(access: "READ_WRITE" | "READ_ONLY", waitMs: number): Promise<DiskDb> {
  // Lazy: --version/hook/gate must not pay for the native binding (same reason as searchCli.ts).
  const { DuckDBInstance } = await import("@duckdb/node-api")
  const file = diskDbPath()
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      // enable_external_access=false on the READ_ONLY side: `disk sql` takes a user-typed query, and
      // without it a SELECT could read any file the user can (read_text, read_csv, ...).
      const options: Record<string, string> = access === "READ_ONLY" ? { access_mode: "READ_ONLY", enable_external_access: "false" } : { access_mode: "READ_WRITE" }
      const lockedAtMs = Date.now()
      const inst = await DuckDBInstance.create(file, options)
      const con = await inst.connect()
      return { con, close: () => { con.closeSync(); inst.closeSync() }, lockedAtMs }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!/lock/i.test(msg) || Date.now() >= deadline) throw e
      await sleep(200)
    }
  }
}

/** Read-write open; creates the file and the schema. `created` is true when disk_watch did not exist
 *  yet — the caller seeds the default watch list exactly then, so a user who removes a default is not
 *  re-seeded on the next run. */
export async function openWritable(waitMs = 5000): Promise<DiskDb & { created: boolean }> {
  fs.mkdirSync(dataDir(), { recursive: true })
  const db = await openWithRetry("READ_WRITE", waitMs)
  try {
    const had = Number((await db.con.runAndReadAll("SELECT count(*) AS n FROM information_schema.tables WHERE table_name = 'disk_watch'")).getRowObjects()[0].n) > 0
    for (const ddl of SCHEMA) await db.con.run(ddl)
    return { ...db, created: !had }
  } catch (e) {
    db.close()
    throw e
  }
}

/** Read-only open for the query verbs. A missing file is its own answer, not a lock to wait on. */
export async function openReadOnly(waitMs = 5000): Promise<DiskDb> {
  if (!fs.existsSync(diskDbPath())) {
    throw new DiskDbMissingError(`no disk monitor data yet (${diskDbPath()} does not exist) — run: agentlenspro disk-sample, or install the monitor jobs: agentlenspro disk-monitor install`)
  }
  return openWithRetry("READ_ONLY", waitMs)
}

export class DiskDbMissingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DiskDbMissingError"
  }
}

/** True for the DuckDB refusal to take the writer lock held by another process ("IO Error: Could not set lock on file ..."). Narrower than the retry test in openWithRetry
 *  on purpose: /lock/i also matches "block", "deadlock" and "clock", and the resident sampler keeps a batch only for a real lock refusal (TRDD-T16ZQH9F). */
export function isWriterLockError(e: unknown): boolean {
  return /could not set lock/i.test(e instanceof Error ? e.message : String(e))
}

export type SqlValue = string | number | boolean | Date | null

/** One multi-row INSERT with a CAST per column, so JS numbers land as BIGINT/TIMESTAMPTZ exactly
 *  (a bare number binds as DOUBLE and a Date has no implicit TIMESTAMPTZ path). */
export async function insertRows(con: DuckDBConnection, table: string, cols: readonly (readonly [string, string])[], rows: readonly (readonly SqlValue[])[]): Promise<void> {
  if (rows.length === 0) return
  const one = `(${cols.map(([, t]) => `CAST(? AS ${t})`).join(", ")})`
  const sql = `INSERT INTO ${table}(${cols.map(([c]) => c).join(", ")}) VALUES ${rows.map(() => one).join(", ")}`
  const values = rows.flat().map(v => (v instanceof Date ? v.toISOString() : v))
  await con.run(sql, values)
}
