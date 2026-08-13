// The COMPLETE evidence base for raw-body diagnostics (TRDD-34B9JAZK sibling work, owner directive
// 2026-08-13: "make them use duckdb super efficient query of jsonl and parquet files").
//
// WHY THIS EXISTS — measured, not theorized. `get_cache_break_timeline` (and every forensics read
// path that followed its pattern) listed `*.request.json` FILES in the spool and JSON.parsed each
// one in JS. Two consequences, both observed on 2026-08-13:
//
//   1. VOLATILE EVIDENCE. The ingest drain deletes a raw file the moment the Parquet store provably
//      holds its bytes — so a break event at 01:08Z was classifiable at 01:40 and GONE from the
//      tool's evidence base by 02:00 (the session's turn count visibly shrank 172 → 145 between two
//      runs on identical history). The tool's answer depended on when you asked.
//   2. WRONG COST SHAPE. Selecting one session's turns required reading EVERY file. One scoped
//      timeline run measured 13.5 s of JS file reads, while the Parquet `body` table carries
//      `session_id` and `ts` as first-class columns — the same selection is a millisecond
//      column-pruned Parquet scan.
//
// THE INVARIANT THAT MAKES THIS MODULE CORRECT: the delete gate (verifyInStore, "verify-before-
// delete", USER directive 2026-07-15) deletes a spool file ONLY after the flushed store provably
// holds its exact bytes and its (src_name, ts) row. Therefore at every instant a captured body
// exists in the SPOOL, or in the SEALED PARQUET, or briefly in both — never in neither. The union
// queried here is complete BY CONSTRUCTION, not by hope. (Bodies ingested but not yet flushed live
// in the store's in-memory staging, invisible to a parquet-only reader — and that is fine, because
// their spool file cannot have been deleted yet.)
//
// Division of labour: SELECTION is DuckDB over Parquet (pushdown on session/ts/kind — pay for what
// you ask about); LOADING is per-body and chunked (never the corpus — 200 × ~881 KB bodies is
// ~176 MB of strings in one result set, the named memory risk of TRDD-KB17X5G2, and unbounded
// materialization on this exact read path is the standing suspect for the server's silent
// RSS kills). Reconstruction re-proves byte identity against the stored sha256 on every load; the
// body_id IS that sha, so the proof is end-to-end, not self-consistency.
import * as fs from 'fs'
import * as path from 'path'
import { BLOBS_DIR, BODIES_DIR, PARTS_DIR, parquetScan } from './db'
import { Part, reassemble, sha256 } from './sections'

export interface EvidenceRow {
  srcName: string
  /** sha256 of the original bytes for store rows; null for a spool row (not yet ingested/known). */
  bodyId: string | null
  /** Known for store rows (a first-class Parquet column); null for spool rows — the spool file name
   *  is an opaque uuid, and reading the file to learn its session would reintroduce the exact
   *  read-everything cost this module removes. Callers filtering by session must keep null rows and
   *  filter them after parsing; the drain keeps the spool small, so that JS-side cost is bounded by
   *  current inflow, never by history. */
  sessionId: string | null
  tsMs: number | null
  rawBytes: number
  kind: 'request' | 'response'
  location: 'store' | 'spool'
}

export interface EvidenceFilter {
  sessionId?: string
  tsFromMs?: number
  tsToMs?: number
  kind?: 'request' | 'response'
}

function sq(v: string): string { return `'${v.replace(/'/g, "''")}'` }

type DuckConn = {
  run(sql: string): Promise<unknown>
  runAndReadAll(sql: string): Promise<{ getRowObjects(): Record<string, unknown>[] }>
}

/** Fileless DuckDB, per call. ':memory:' is not a preference — a persistent .duckdb measured 300x
 *  write amplification (src/store/db.ts:3-21). No temp_directory: an over-limit query must fail
 *  loudly, never quietly write gigabytes to the SSD (src/test/bodyStore.test.ts pins the same for
 *  the store proper). Opened per call because evidence queries are occasional and the parquet
 *  metadata scan is milliseconds; a resident instance would be held RSS for nothing. */
async function withDuck<T>(fn: (con: DuckConn) => Promise<T>): Promise<T> {
  const { DuckDBInstance } = await import('@duckdb/node-api')
  const inst = await DuckDBInstance.create(':memory:', {
    memory_limit: process.env['AGENTLENS_DUCKDB_MEMORY_LIMIT']?.trim() || '2GB',
    threads: '2',
  })
  const con = await inst.connect()
  try {
    await con.run("SET temp_directory = ''")
    await con.run('SET preserve_insertion_order = false')
    return await fn(con as unknown as DuckConn)
  } finally {
    con.closeSync()
    inst.closeSync()
  }
}

/** Every body the diagnostics may reason about, selected by pushdown where the columns exist.
 *  Store rows come pre-filtered by DuckDB; spool rows are appended unfiltered on session/ts (their
 *  metadata is unknown until parsed) except for `kind`, which the file suffix carries. A body
 *  present in both places yields ONE row (the store one — its metadata is richer and its bytes are
 *  proven), so a caller never double-counts a turn mid-drain. */
export async function listBodyEvidence(
  storeDir: string, spoolDir: string | null, f: EvidenceFilter = {},
): Promise<EvidenceRow[]> {
  const rows: EvidenceRow[] = []
  const scan = parquetScan(storeDir, BODIES_DIR)
  if (scan) {
    const where: string[] = []
    if (f.sessionId !== undefined) where.push(`session_id = ${sq(f.sessionId)}`)
    if (f.kind !== undefined) where.push(`kind = ${sq(f.kind)}`)
    if (f.tsFromMs !== undefined) where.push(`ts >= epoch_ms(${Math.floor(f.tsFromMs)})`)
    if (f.tsToMs !== undefined) where.push(`ts <= epoch_ms(${Math.floor(f.tsToMs)})`)
    const got = await withDuck(async (con) => (await con.runAndReadAll(`
      SELECT src_name, body_id, session_id, epoch_ms(ts) AS ts_ms, raw_bytes, kind
      FROM ${scan}
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    `)).getRowObjects())
    for (const r of got) {
      rows.push({
        srcName: String(r.src_name), bodyId: String(r.body_id),
        sessionId: r.session_id === null ? null : String(r.session_id),
        tsMs: r.ts_ms === null ? null : Number(r.ts_ms),
        rawBytes: Number(r.raw_bytes ?? 0),
        kind: r.kind === 'response' ? 'response' : 'request',
        location: 'store',
      })
    }
  }
  if (spoolDir) {
    const inStore = new Set(rows.map((r) => r.srcName))
    let names: string[] = []
    try { names = fs.readdirSync(spoolDir) } catch { /* no spool = empty half, not an error */ }
    for (const name of names) {
      const kind: EvidenceRow['kind'] = name.includes('.response.') ? 'response'
        : name.includes('.request.') ? 'request' : 'request'
      if (!name.endsWith('.json') || inStore.has(name)) continue
      if (f.kind !== undefined && kind !== f.kind) continue
      let size = 0
      try { size = fs.statSync(path.join(spoolDir, name)).size } catch { continue /* drained mid-list */ }
      rows.push({ srcName: name, bodyId: null, sessionId: null, tsMs: null, rawBytes: size, kind, location: 'spool' })
    }
  }
  return rows
}

/** Load the selected bodies' raw text, srcName → bytes-as-string.
 *
 *  Spool rows are plain reads; a file drained between list and load falls through to the store by
 *  name (the delete gate guarantees it arrived there first) rather than failing — the race is
 *  routine, not exceptional. Store rows reconstruct in CHUNKS of `chunk` bodies (default 32, the
 *  bound TRDD-KB17X5G2 measured against ~176 MB single-result blowups), each proven against its
 *  sha256 before it is handed back. A body that fails its proof THROWS — handing back bytes we
 *  cannot prove are the original would quietly poison every diagnosis built on them. */
export async function loadBodyTexts(
  storeDir: string, spoolDir: string | null, selection: EvidenceRow[], chunk = 32,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const fromStore: EvidenceRow[] = []
  for (const row of selection) {
    if (row.location === 'spool' && spoolDir) {
      try {
        out.set(row.srcName, fs.readFileSync(path.join(spoolDir, row.srcName), 'utf8'))
        continue
      } catch { /* drained since listing — the store must hold it now; fall through */ }
    }
    fromStore.push(row)
  }
  if (fromStore.length === 0) return out

  const partScan = parquetScan(storeDir, PARTS_DIR)
  const blobScan = parquetScan(storeDir, BLOBS_DIR)
  const bodyScan = parquetScan(storeDir, BODIES_DIR)
  if (!partScan || !bodyScan) {
    throw new Error(`bodiesEvidence: ${fromStore.length} body(ies) need the store but ${storeDir} has no sealed parts`)
  }
  await withDuck(async (con) => {
    // A spool row that fell through carries no bodyId — resolve it by src_name first.
    const unresolved = fromStore.filter((r) => r.bodyId === null)
    if (unresolved.length) {
      const got = (await con.runAndReadAll(`
        SELECT src_name, body_id FROM ${bodyScan}
        WHERE src_name IN (${unresolved.map((r) => sq(r.srcName)).join(',')})
      `)).getRowObjects()
      const byName = new Map(got.map((g) => [String(g.src_name), String(g.body_id)]))
      for (const r of unresolved) {
        const id = byName.get(r.srcName)
        if (!id) throw new Error(`bodiesEvidence: ${r.srcName} is in neither the spool nor the store — the verify-before-delete invariant is broken, refuse to continue`)
        r.bodyId = id
      }
    }
    for (let i = 0; i < fromStore.length; i += chunk) {
      const batch = fromStore.slice(i, i + chunk)
      const ids = batch.map((r) => sq(r.bodyId as string)).join(',')
      const parts = (await con.runAndReadAll(`
        SELECT body_id, pos, kind, lit, sha FROM ${partScan}
        WHERE body_id IN (${ids}) ORDER BY body_id, pos
      `)).getRowObjects()
      const shas = [...new Set(parts.filter((p) => p.sha !== null).map((p) => sq(String(p.sha))))]
      const spans = new Map<string, string>()
      if (shas.length && blobScan) {
        const got = (await con.runAndReadAll(
          `SELECT sha, data FROM ${blobScan} WHERE sha IN (${shas.join(',')})`,
        )).getRowObjects()
        for (const g of got) spans.set(String(g.sha), String(g.data))
      }
      const byBody = new Map<string, Part[]>()
      for (const p of parts) {
        const list = byBody.get(String(p.body_id)) ?? []
        list.push(p.kind === 'lit'
          ? { kind: 'lit', text: String(p.lit ?? '') }
          : { kind: 'blob', sha: String(p.sha), n: 0, path: '', idx: -1 })
        byBody.set(String(p.body_id), list)
      }
      for (const row of batch) {
        const partList = byBody.get(row.bodyId as string)
        if (!partList) throw new Error(`bodiesEvidence: store has no parts for ${row.srcName} (${row.bodyId})`)
        const raw = reassemble(partList, (sha) => spans.get(sha))
        if (sha256(raw) !== row.bodyId) {
          throw new Error(`RECONSTRUCTION MISMATCH for ${row.srcName} — the store cannot return what it was given`)
        }
        out.set(row.srcName, raw)
      }
    }
  })
  return out
}
