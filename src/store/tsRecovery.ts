// Schema v1 -> v2: recover CAPTURE-time timestamps for backfilled body rows (TRDD-K3WDPR7M #56).
//
// WHY THIS EXISTS: the first backfill and the .wad drain both ran on stale compiled code that did
// not pass tsMs, so 78k+ rows carry the INGEST batch time (all within minutes of each other) instead
// of the capture time (spread over days). The bytes are hash-proven correct; only `ts` lies. The
// archive's .idx sidecars hold the true mtime per src_name, so the damage is exactly recoverable for
// every archived lump. Rows with no .idx entry (live files reclaimed before the fix, sources deleted)
// are left untouched: their capture times are UNRECOVERABLE and inventing them would be fabrication.
//
// v2 additionally materializes ALIAS ROWS: the archive can hold the same content under several
// src_names, but ingestBody dedups on content — so the later names got NO body row at all. v2 adds a
// row per missing (src_name -> existing body_id), each with its own capture ts, so every archive
// entry is queryable by name and the store fully subsumes the archive index.
//
// Rows live in immutable Parquet — there is no UPDATE. The rewrite therefore runs as a staged store
// migration (src/store/migrate.ts): build `<dir>.migrating`, verify EVERYTHING, swap atomically.
import * as fs from 'fs'
import * as readline from 'readline'
import * as path from 'path'
import { allOf, BLOBS_DIR, flush, PARTS_DIR, Store } from './db'
import type { Migration } from './migrate'

export interface TsCorrections {
  /** src_name -> true capture mtimeMs (from the archive .idx). Applied where a row exists. */
  tsBySrcName: Map<string, number>
  /** Archive names with NO body row: same content was ingested under another name. Each becomes a
   *  new row pointing at the EXISTING body_id. bodyId comes from hashing the lump's actual bytes —
   *  never guessed. */
  aliases: Array<{ srcName: string; bodyId: string; tsMs: number }>
}

export function emptyCorrections(): TsCorrections {
  return { tsBySrcName: new Map(), aliases: [] }
}

/** Parse archive .idx sidecars (NDJSON: {n,o,l,s,m}) into src_name -> mtimeMs. Last entry wins on a
 *  duplicate name — the archiver appended, so the last is the newest observation of that file. */
export async function parseIdxTsMap(idxPaths: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  for (const p of idxPaths) {
    const rl = readline.createInterface({ input: fs.createReadStream(p), crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line.trim()) continue
      // A corrupt .idx line is a hard error: this map GATES a rewrite of the whole bodies table, and
      // silently skipping entries would mean silently not correcting them.
      const e = JSON.parse(line) as { n?: unknown; m?: unknown }
      if (typeof e.n !== 'string' || typeof e.m !== 'number') throw new Error(`${p}: malformed idx line: ${line.slice(0, 120)}`)
      // Real .idx mtimes are FLOATS (statSync mtimeMs keeps sub-ms fraction, e.g. …586.0305) and the
      // appender's BigInt(ms*1000) THROWS on a fraction — round HERE, at the one entry point, so no
      // consumer can trip on it. Sub-ms is far inside the ±2s verification tolerance.
      map.set(e.n, Math.round(e.m))
    }
  }
  return map
}

interface BodyRow {
  body_id: string; src_name: string; kind: string; session_id: string | null
  ts_ms: number; model: string | null; raw_bytes: number; body_sha256: string
}

async function readAllBodyRows(s: Store): Promise<BodyRow[]> {
  const rows = (await s.con.runAndReadAll(
    `SELECT body_id, src_name, kind, session_id, CAST(epoch_ms(ts) AS BIGINT) AS ts_ms,
            model, raw_bytes, body_sha256 FROM ${allOf(s, 'body')}`,
  )).getRowObjects()
  return rows.map((r) => ({
    body_id: String(r.body_id), src_name: String(r.src_name), kind: String(r.kind),
    session_id: r.session_id == null ? null : String(r.session_id),
    ts_ms: Number(r.ts_ms), model: r.model == null ? null : String(r.model),
    raw_bytes: Number(r.raw_bytes), body_sha256: String(r.body_sha256),
  }))
}

async function appendBodyRows(to: Store, rows: BodyRow[]): Promise<void> {
  const { DuckDBTimestampValue } = await import('@duckdb/node-api')
  const b = await to.con.createAppender('body')
  for (const r of rows) {
    b.appendVarchar(r.body_id)
    b.appendVarchar(r.src_name)
    b.appendVarchar(r.kind)
    if (r.session_id === null) b.appendNull(); else b.appendVarchar(r.session_id)
    // Defensive round: a float ms (idx mtimes, or any future caller) must never abort a 4-hour
    // migration at the appender — BigInt() throws on non-integers.
    b.appendTimestamp(new DuckDBTimestampValue(BigInt(Math.round(r.ts_ms)) * 1000n))
    if (r.model === null) b.appendNull(); else b.appendVarchar(r.model)
    b.appendBigInt(BigInt(r.raw_bytes))
    b.appendVarchar(r.body_sha256)
    b.endRow()
  }
  b.closeSync()
}

/** kind is derived from the filename, exactly as extractMeta does for a fresh ingest. */
function kindOf(srcName: string): string {
  return srcName.endsWith('.response.json') ? 'response' : 'request'
}

/**
 * Build the v1 -> v2 migration. With empty corrections it is a pure copy (the legal path for stores
 * that never had a backfill). `up` NEVER mutates `from`; blob/part Parquet parts are byte-identical
 * copies (their data is untouched by v2), only the bodies table is rewritten.
 */
export function makeTsRecoveryMigration(c: TsCorrections): Migration {
  return {
    from: 1,
    to: 2,
    describe: `recover capture-time ts (${c.tsBySrcName.size} corrections, ${c.aliases.length} alias rows)`,
    async up(from: Store, to: Store): Promise<void> {
      // blob + part payloads are unchanged in v2 — copy the immutable parts verbatim. Copying beats
      // re-flushing through DuckDB: byte-identical output, no RAM ceiling, no re-compression.
      for (const sub of [BLOBS_DIR, PARTS_DIR]) {
        for (const f of fs.readdirSync(path.join(from.dir, sub)).filter((n) => n.endsWith('.parquet'))) {
          fs.copyFileSync(path.join(from.dir, sub, f), path.join(to.dir, sub, f))
        }
      }

      const rows = await readAllBodyRows(from)
      const byId = new Map<string, BodyRow>()
      for (const r of rows) if (!byId.has(r.body_id)) byId.set(r.body_id, r)

      let corrected = 0
      for (const r of rows) {
        const m = c.tsBySrcName.get(r.src_name)
        if (m !== undefined && Math.abs(r.ts_ms - m) > 2000) { r.ts_ms = m; corrected++ }
      }

      const aliasRows: BodyRow[] = []
      for (const a of c.aliases) {
        const base = byId.get(a.bodyId)
        // An alias naming a body the store does not hold means the corrections were built against a
        // DIFFERENT store — applying them would fabricate a row nothing can reconstruct. Fail the
        // migration (staging is discarded, the live store is untouched).
        if (!base) throw new Error(`alias ${a.srcName} -> ${a.bodyId}: no such body in the store`)
        aliasRows.push({ ...base, src_name: a.srcName, kind: kindOf(a.srcName), ts_ms: a.tsMs })
      }

      await appendBodyRows(to, rows)
      await appendBodyRows(to, aliasRows)
      await flush(to)

      // Row-count parity is asserted HERE, against what was actually written — the framework's
      // verify #2 checks body_id SETS, which cannot see a lost duplicate-id row.
      const n = Number((await to.con.runAndReadAll(`SELECT count(*) c FROM ${allOf(to, 'body')}`)).getRowObjects()[0].c)
      if (n !== rows.length + aliasRows.length) {
        throw new Error(`bodies row count mismatch after rewrite: wrote ${rows.length + aliasRows.length}, store has ${n}`)
      }
    },
  }
}
