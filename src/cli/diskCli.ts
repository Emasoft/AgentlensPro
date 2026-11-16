// src/cli/diskCli.ts — `agentlenspro disk` (read-only queries) and `agentlenspro disk-watch` (TRDD-HTARKH87).
//
// `disk` opens disk.duckdb READ_ONLY with external file access disabled: whatever SQL reaches it, it
// cannot write the table and cannot read any other file. DISABLED-exempt (foreignTelemetry.ts
// READ_ONLY_VERBS) like the other read-only diagnostics — it needs no server and writes nothing.

import * as fs from "fs"
import * as path from "path"
import { assertKnownFlags, flagValue } from "./argHelpers"
import { EXIT, UsageError } from "./cliErrors"
import { DiskDbMissingError, insertRows, openReadOnly, openWritable } from "./diskStore"
import { effectiveWatch, type WatchKind } from "./diskWatch"

const KNOWN: ReadonlySet<string> = new Set(["--json", "--volume", "--since", "--every", "--min", "--top", "--folder", "--limit", "--progress"])
const VALUED: ReadonlySet<string> = new Set(["--volume", "--since", "--every", "--min", "--top", "--folder", "--limit"])

export const DISK_USAGE = `usage: agentlenspro disk <view> [flags]      (read-only; works with the server down and while DISABLED)
  now                                  latest sample of every volume: used, free, avail, trash, used-minus-trash
  history [--volume V] [--since 6h] [--every 1m|1h|1d]
                                       used/free per volume, bucketed (last sample of each bucket)
  changes [--volume V] [--since 6h] [--min 1M]
                                       every minute-to-minute change of used or free space of at least --min,
                                       with the exact sample time, the signed delta and the gap since the previous sample
  top-change [--volume V] [--since 6h] [--top 10]
                                       the biggest single minute-to-minute changes
  trees [--folder PATH] [--since 7d] [--progress]
                                       watch-list folder sizes (apparent/allocated, with/without symlinks); no --folder =
                                       the latest finished walk of each; --folder = that folder's history; --progress = walks in flight
  sql "<one SELECT>"                   any query over disk_volume, disk_tree, disk_watch (single SELECT/WITH, READ_ONLY)
  flags: --json (raw bytes, machine-readable)  --limit N (rows, default 500)  --volume matches mount, device, volume UUID or volume name
  sizes: --min takes 512, 10K, 1M, 2.5G, 1T (binary multiples). --since takes 90s, 30m, 6h, 2d, 1w or a date.
tables: disk_volume(ts, mount, device, fs_type, container, volume_uuid, total_b, used_b, free_b, avail_b, vol_used_b,
        container_free_b, purgeable_b, important_avail_b, trash_b, used_minus_trash_b, error)  one row per volume per minute
        disk_tree(ts_start, ts_end, path, kind, apparent_b, allocated_b, apparent_follow_b, allocated_follow_b, files, partial, elapsed_ms, error)
        disk_watch(path, kind)`

export const DISK_WATCH_USAGE = `usage: agentlenspro disk-watch add <path> [--kind folder|trash] | remove <path> | list
  edit the folders whose size the monitor measures every 15 minutes (resumable walks, see: agentlenspro disk trees --progress).
  Trash folders under /Volumes/*/.Trashes/<uid> are discovered automatically and listed as source=auto.`

// ── parsing ───────────────────────────────────────────────────────────────────────────────────────────

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

/** `6h` / `90m` / `2d` relative to `nowMs`, or an absolute date. */
export function parseSince(v: string, nowMs: number = Date.now()): Date {
  const m = /^(\d+)([smhdw])$/.exec(v)
  if (m) return new Date(nowMs - Number(m[1]) * UNIT_MS[m[2]])
  const t = Date.parse(v)
  if (Number.isNaN(t)) throw new UsageError(`--since expects 90s, 30m, 6h, 2d, 1w or a date, got "${v}"`)
  return new Date(t)
}

const BUCKET_UNIT: Record<string, string> = { m: "minute", h: "hour", d: "day" }

/** `1m|1h|1d` as the text of a DuckDB INTERVAL literal. Only digits and a fixed unit word ever reach the SQL. */
export function parseEvery(v: string): string {
  const m = /^(\d+)([mhd])$/.exec(v)
  if (!m || Number(m[1]) < 1) throw new UsageError(`--every expects 1m, 15m, 1h, 1d ..., got "${v}"`)
  return `${Number(m[1])} ${BUCKET_UNIT[m[2]]}`
}

export function parseSize(v: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([KMGT]?)B?$/i.exec(v)
  if (!m) throw new UsageError(`--min expects a size such as 512, 10K, 1M, 2.5G, got "${v}"`)
  // No unit = plain bytes. (indexOf("") is 0, which would silently turn "512" into 512 KiB.)
  return Math.round(Number(m[1]) * 1024 ** (m[2] === "" ? 0 : "KMGT".indexOf(m[2].toUpperCase()) + 1))
}

export function formatBytes(n: number): string {
  const sign = n < 0 ? "-" : ""
  let v = Math.abs(n)
  const units = ["B", "KiB", "MiB", "GiB", "TiB"]
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${sign}${i === 0 ? v : v.toFixed(2)} ${units[i]}`
}

/** `disk sql` accepts ONE statement that starts with SELECT or WITH. The READ_ONLY open is the real write
 *  guard (a WITH can wrap a DELETE; the engine refuses it); this check gives a clear message first and
 *  rejects stacked statements. A `;` inside a quoted string is fine, one outside is a second statement. */
export function assertSingleSelect(sql: string): string {
  const text = sql.trim().replace(/;+\s*$/, "").trim()
  let quote: string | null = null
  for (const ch of text) {
    if (quote) { if (ch === quote) quote = null }
    else if (ch === "'" || ch === "\"") quote = ch
    else if (ch === ";") throw new UsageError("disk sql runs ONE statement; found a second after \";\"")
  }
  if (!/^(select|with)\b/i.test(text)) throw new UsageError("disk sql accepts only a SELECT (or WITH ... SELECT) — the data is read-only")
  return text
}

// ── queries ───────────────────────────────────────────────────────────────────────────────────────────

interface Query {
  sql: string
  params: (string | number)[]
}

/** A `--volume` filter on disk_volume columns: mount, device, volume UUID or the volume name (last path segment of the mount). */
function volumeFilter(volume: string | undefined): Query {
  if (volume === undefined) return { sql: "TRUE", params: [] }
  return { sql: "(mount = ? OR device = ? OR volume_uuid = ? OR regexp_extract(mount, '[^/]+$') = ?)", params: [volume, volume, volume, volume] }
}

/** The newest `limit` rows of `inner`, shown oldest first — a time series reads top to bottom. */
const newest = (inner: string, limit: number): string => `SELECT * FROM (${inner} ORDER BY ts DESC LIMIT ${limit}) ORDER BY ts, mount`

/** Consecutive-sample deltas per volume. `gap_s` is the time since the previous sample, so a missed minute is visible rather than hidden inside a delta. */
function deltaCte(since: Date, volume: string | undefined): Query {
  const v = volumeFilter(volume)
  return {
    sql: `WITH s AS (
      SELECT ts, mount, used_b, free_b, lag(ts) OVER w AS prev_ts, lag(used_b) OVER w AS prev_used, lag(free_b) OVER w AS prev_free
      FROM disk_volume WHERE ts >= CAST(? AS TIMESTAMPTZ) AND ${v.sql}
      WINDOW w AS (PARTITION BY mount ORDER BY ts))
    SELECT ts, mount, used_b - prev_used AS delta_used_b, free_b - prev_free AS delta_free_b, used_b, free_b, CAST(epoch(ts - prev_ts) AS BIGINT) AS gap_s
    FROM s WHERE prev_used IS NOT NULL`,
    params: [since.toISOString(), ...v.params],
  }
}

export function buildQuery(view: string, o: { volume?: string; since: Date; every: string; min: number; top: number; folder?: string; limit: number; progress: boolean }): Query {
  const v = volumeFilter(o.volume)
  switch (view) {
    case "now":
      return {
        sql: `WITH last AS (SELECT mount AS m, max(ts) AS mts FROM disk_volume GROUP BY mount)
          SELECT ts, mount, used_b, free_b, avail_b, vol_used_b, trash_b, used_minus_trash_b, error FROM disk_volume JOIN last ON mount = m AND ts = mts WHERE ${v.sql} ORDER BY mount`,
        params: v.params,
      }
    case "history":
      return {
        sql: newest(`SELECT time_bucket(INTERVAL '${o.every}', ts) AS ts, mount, arg_max(used_b, ts) AS used_b, arg_max(free_b, ts) AS free_b, arg_max(avail_b, ts) AS avail_b,
          arg_max(trash_b, ts) AS trash_b, count(*) AS samples FROM disk_volume WHERE ts >= CAST(? AS TIMESTAMPTZ) AND ${v.sql} GROUP BY 1, 2`, o.limit),
        params: [o.since.toISOString(), ...v.params],
      }
    case "changes": {
      const d = deltaCte(o.since, o.volume)
      return { sql: newest(`${d.sql} AND (abs(used_b - prev_used) >= ? OR abs(free_b - prev_free) >= ?)`, o.limit), params: [...d.params, o.min, o.min] }
    }
    case "top-change": {
      const d = deltaCte(o.since, o.volume)
      return { sql: `${d.sql} ORDER BY greatest(abs(used_b - prev_used), abs(free_b - prev_free)) DESC LIMIT ${o.top}`, params: d.params }
    }
    case "trees":
      if (o.progress) {
        return { sql: "SELECT path, ts_start, last_segment, apparent_b, allocated_b, files, unreadable, (SELECT count(*) FROM disk_walk_pending p WHERE p.path = s.path) AS dirs_pending FROM disk_walk_state s ORDER BY path", params: [] }
      }
      if (o.folder !== undefined) {
        return {
          sql: `SELECT ts_end AS ts, path, kind, apparent_b, allocated_b, apparent_follow_b, allocated_follow_b, files, partial, elapsed_ms, error FROM disk_tree
            WHERE path = ? AND ts_end >= CAST(? AS TIMESTAMPTZ) ORDER BY ts_end LIMIT ${o.limit}`,
          params: [path.resolve(o.folder), o.since.toISOString()],
        }
      }
      return {
        sql: `WITH last AS (SELECT path AS p, max(ts_end) AS mts FROM disk_tree GROUP BY path)
          SELECT ts_end AS ts, path, kind, apparent_b, allocated_b, apparent_follow_b, allocated_follow_b, files, partial, elapsed_ms, error FROM disk_tree JOIN last ON path = p AND ts_end = mts ORDER BY path`,
        params: [],
      }
    default:
      throw new UsageError(`unknown disk view "${view}" — run: agentlenspro disk`)
  }
}

// ── output ────────────────────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>

function cell(col: string, v: unknown, human: boolean): string {
  if (v === null || v === undefined) return "-"
  if (human && col.endsWith("_b") && /^-?\d+$/.test(String(v))) {
    const n = Number(v)
    return col.startsWith("delta_") && n > 0 ? `+${formatBytes(n)}` : formatBytes(n)
  }
  return String(v)
}

export function renderTable(rows: readonly Row[], human: boolean): string {
  if (rows.length === 0) return "(no rows)"
  const cols = Object.keys(rows[0])
  const cells = rows.map(r => cols.map(c => cell(c, r[c], human)))
  const width = cols.map((c, i) => Math.max(c.length, ...cells.map(r => r[i].length)))
  const line = (vals: readonly string[]): string => vals.map((v, i) => v.padEnd(width[i])).join("  ").trimEnd()
  return [line(cols), ...cells.map(line)].join("\n")
}

async function runQuery(q: Query): Promise<Row[]> {
  const db = await openReadOnly()
  try {
    return (await db.con.runAndReadAll(q.sql, q.params)).getRowObjectsJson() as Row[]
  } finally {
    db.close()
  }
}

export async function runDiskCli(argv: string[]): Promise<number> {
  assertKnownFlags(argv, KNOWN, VALUED, "agentlenspro disk")
  // `--help` never gets here: main.ts answers it for every management verb. No arguments = the view list.
  if (argv.length === 0) {
    console.log(DISK_USAGE)
    return EXIT.USAGE
  }
  const positionals: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (VALUED.has(argv[i])) { i++; continue }
    if (!argv[i].startsWith("-")) positionals.push(argv[i])
  }
  const view = positionals[0]
  const json = argv.includes("--json")
  const limitRaw = flagValue(argv, "--limit")
  const limit = limitRaw === undefined ? 500 : Number(limitRaw)
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError("--limit needs a positive integer")
  const topRaw = flagValue(argv, "--top")
  const top = topRaw === undefined ? 10 : Number(topRaw)
  if (!Number.isInteger(top) || top < 1) throw new UsageError("--top needs a positive integer")
  const defaultSince = view === "trees" ? "7d" : "6h"
  const since = parseSince(flagValue(argv, "--since") ?? defaultSince)
  const every = parseEvery(flagValue(argv, "--every") ?? "1m")
  const min = parseSize(flagValue(argv, "--min") ?? "1M")

  let q: Query
  if (view === "sql") {
    if (positionals.length !== 2) throw new UsageError("disk sql takes exactly one quoted query — run: agentlenspro disk")
    q = { sql: assertSingleSelect(positionals[1]), params: [] }
  } else {
    q = buildQuery(view, { volume: flagValue(argv, "--volume"), since, every, min, top, folder: flagValue(argv, "--folder"), limit, progress: argv.includes("--progress") })
  }
  let rows: Row[]
  try {
    rows = await runQuery(q)
  } catch (e) {
    if (e instanceof DiskDbMissingError) {
      console.error(e.message)
      return EXIT.UNKNOWN
    }
    throw e
  }
  // `sql` shows what the query returned, byte for byte; only the canned views humanize `_b` columns.
  console.log(json ? JSON.stringify(rows) : renderTable(rows, view !== "sql"))
  return EXIT.OK
}

// ── disk-watch ────────────────────────────────────────────────────────────────────────────────────────

export async function runDiskWatchCli(argv: string[]): Promise<number> {
  assertKnownFlags(argv, new Set(["--kind"]), new Set(["--kind"]), "agentlenspro disk-watch")
  // `--help` never gets here: main.ts answers it for every management verb. No arguments = the usage text.
  if (argv.length === 0) {
    console.log(DISK_WATCH_USAGE)
    return EXIT.USAGE
  }
  const positionals: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--kind") { i++; continue }
    if (!argv[i].startsWith("-")) positionals.push(argv[i])
  }
  const [sub, target] = positionals
  const db = await openWritable()
  try {
    if (sub === "list") {
      const stored = (await db.con.runAndReadAll("SELECT path, kind FROM disk_watch ORDER BY path")).getRowObjects()
        .map(r => ({ path: String(r.path), kind: String(r.kind) as WatchKind }))
      console.log(renderTable(effectiveWatch(stored).map(e => ({ path: e.path, kind: e.kind, source: e.source })), false))
      return EXIT.OK
    }
    if (sub !== "add" && sub !== "remove") throw new UsageError("disk-watch expects add <path> | remove <path> | list")
    if (!target || positionals.length !== 2) throw new UsageError(`disk-watch ${sub} takes exactly one path`)
    const abs = path.resolve(target)
    if (sub === "add") {
      const kind = flagValue(argv, "--kind") ?? "folder"
      if (kind !== "folder" && kind !== "trash") throw new UsageError(`--kind expects folder or trash, got "${kind}"`)
      if (!fs.existsSync(abs)) throw new UsageError(`${abs} does not exist`)
      await db.con.run("DELETE FROM disk_watch WHERE path = ?", [abs])
      await insertRows(db.con, "disk_watch", [["path", "TEXT"], ["kind", "TEXT"]], [[abs, kind]])
      console.log(`watching ${abs} (${kind})`)
      return EXIT.OK
    }
    const n = Number((await db.con.runAndReadAll("SELECT count(*) AS n FROM disk_watch WHERE path = ?", [abs])).getRowObjects()[0].n)
    if (n === 0) {
      console.error(`${abs} is not in the watch list (an auto-discovered trash cannot be removed; unmount the volume)`)
      return EXIT.UNKNOWN
    }
    await db.con.run("DELETE FROM disk_watch WHERE path = ?", [abs])
    await db.con.run("DELETE FROM disk_walk_state WHERE path = ?", [abs])
    await db.con.run("DELETE FROM disk_walk_pending WHERE path = ?", [abs])
    await db.con.run("DELETE FROM disk_walk_followed WHERE path = ?", [abs])
    console.log(`no longer watching ${abs} (its history stays in disk_tree)`)
    return EXIT.OK
  } finally {
    db.close()
  }
}
