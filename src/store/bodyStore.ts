// Ingest + reconstruct one raw API body (TRDD-K3WDPR7M Phase 2).
//
// MEMORY DISCIPLINE (an explicit requirement): ONE body at a time — read, section, hash, insert,
// FREE. The corpus is never held. Reconstruction fetches only the requested body's spans, concatenates
// once, verifies, returns, drops. Peak RSS stays flat whether the corpus is 40 MB or 22 GB; only the
// command's own output survives.
//
// THE TWO GATES THAT MAKE THIS TRUSTWORTHY:
//   1. A body must reconstruct BYTE-IDENTICALLY (whole-body sha256) — checked on ingest, before the
//      caller is ever told the body is safely stored. A store that cannot give back exactly what it
//      was given is worse than no store, and the failure would stay invisible until someone needed a
//      body back. Nothing may delete a source file until this has passed.
//   2. Re-ingesting a body adds ZERO new bytes. That is what makes a repeated turn nearly free, and
//      it is the property the whole 59x saving rests on.
import { DuckDBTimestampValue } from '@duckdb/node-api'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { allOf, dedupedParts, flush, Store } from './db'
import { Part, reassemble, sectionize, sha256 } from './sections'

export interface IngestResult {
  bodyId: string
  /** Bytes of the source body. */
  rawBytes: number
  /** Spans that were NEW to the store (a re-ingest reports 0 — the dedup gate). */
  newBlobs: number
  /** Bytes of those new spans — the marginal cost of this body. */
  newBytes: number
  /** True when a body row with this content already existed: NO new row was written, so a tsMs passed
   *  to this call was NOT applied (rows live in immutable Parquet and are never updated in place). */
  existed?: boolean
}

/** Metadata we keep IN CLEAR (never compressed) so the analytics the user asked for — what is in this
 *  context, what changed between turns, what is growing — run without decompressing anything. */
export interface BodyMeta {
  sessionId: string | null
  model: string | null
  kind: 'request' | 'response'
  ts: Date
}

/** Pull the few fields worth indexing. Tolerant by design: an unparseable or unexpected body must
 *  still be STORED (its bytes are the point) — it just gets null metadata.
 *
 *  `tsMs` is the body's CAPTURE time (the source file's mtime / the archive entry's mtimeMs) and the
 *  caller must pass it whenever it knows it: defaulting to "now" stamps a backfilled body with its
 *  INGEST time, which silently breaks every time-window query over the store. (The first backfill did
 *  exactly that — recoverable later via the retained .wad .idx entries and the span body-pointer
 *  events, see TRDD-K3WDPR7M — but new ingests must never add to the damage.) */
export function extractMeta(raw: string, srcName: string, tsMs?: number): BodyMeta {
  const kind: BodyMeta['kind'] = srcName.includes('.response.') ? 'response' : 'request'
  let sessionId: string | null = null
  let model: string | null = null
  try {
    const d = JSON.parse(raw) as { model?: string; metadata?: { user_id?: string } }
    model = typeof d.model === 'string' ? d.model : null
    // Claude Code buries the session id in metadata.user_id as an EMBEDDED JSON STRING:
    //   {"user_id": "{\"device_id\":…,\"session_id\":\"…\"}"}
    // (Reading the wrong field here silently attributes every body to '?' — it cost me a wrong
    //  conclusion about which sessions were writing, so the shape is spelled out.)
    const uid = d.metadata?.user_id
    if (typeof uid === 'string') {
      const u = JSON.parse(uid) as { session_id?: string }
      if (typeof u.session_id === 'string') sessionId = u.session_id
    }
  } catch { /* keep the bytes, lose the index — never the other way round */ }
  return { sessionId, model, kind, ts: tsMs !== undefined ? new Date(tsMs) : new Date() }
}

/** The body's identity IS its content hash: ingesting the same bytes twice is idempotent by
 *  construction, so a crash mid-backfill can be retried without producing duplicates. */
export function bodyIdOf(raw: string): string {
  return createHash('sha256').update(Buffer.from(raw, 'utf8')).digest('hex')
}

async function bodyExists(store: Store, bodyId: string): Promise<boolean> {
  const r = (await store.con.runAndReadAll(
    `SELECT count(*) c FROM ${allOf(store, 'body')} WHERE body_id = '${bodyId}'`,
  )).getRowObjects()
  return Number(r[0].c) > 0
}

/** SQL-quote a string literal — src_names come from the filesystem; never trust them in SQL. */
function sqlq(s: string): string { return `'${s.replace(/'/g, "''")}'` }

/** Append ONE body row (metadata extracted from the raw content; ts = capture time when given).
 *  Shared by the fresh-ingest path and the dedup path — both record the same row shape. */
async function appendBodyRow(
  store: Store, bodyId: string, srcName: string, raw: string, rawBytes: number, tsMs?: number,
): Promise<void> {
  const meta = extractMeta(raw, srcName, tsMs)
  const b = await store.con.createAppender('body')
  b.appendVarchar(bodyId)
  b.appendVarchar(srcName)
  b.appendVarchar(meta.kind)
  if (meta.sessionId === null) b.appendNull(); else b.appendVarchar(meta.sessionId)
  b.appendTimestamp(new DuckDBTimestampValue(BigInt(meta.ts.getTime()) * 1000n))
  if (meta.model === null) b.appendNull(); else b.appendVarchar(meta.model)
  b.appendBigInt(BigInt(rawBytes))
  b.appendVarchar(bodyId) // body_sha256 == body_id (content-addressed)
  b.endRow()
  b.closeSync()
}

/**
 * Ingest one body. Idempotent: re-ingesting the same bytes writes NOTHING and reports newBlobs = 0.
 * THROWS if the body would not reconstruct byte-identically — we refuse to store what we cannot
 * return.
 */
export async function ingestBody(store: Store, srcName: string, raw: string, tsMs?: number): Promise<IngestResult> {
  const bodyId = bodyIdOf(raw)
  const rawBytes = Buffer.byteLength(raw, 'utf8')

  if (await bodyExists(store, bodyId)) {
    // Content dedup — but each CAPTURE EVENT still deserves its own (src_name, ts) body row: without
    // it, a file whose bytes dedup against an earlier capture would have no row, so the
    // verify-before-delete gate could never pass for it and time-window queries would miss it.
    // Blobs/parts are shared by body_id; only the ~200-byte row is added.
    const named = (await store.con.runAndReadAll(
      `SELECT count(*) c FROM ${allOf(store, 'body')} WHERE body_id = '${bodyId}' AND src_name = ${sqlq(srcName)}`,
    )).getRowObjects()
    if (Number(named[0].c) === 0) {
      await appendBodyRow(store, bodyId, srcName, raw, rawBytes, tsMs)
    }
    // `existed` is explicit because newBlobs===0 is NOT a reliable "already present" signal: a brand-new
    // body whose every span dedups also reports 0 new blobs.
    return { bodyId, rawBytes, newBlobs: 0, newBytes: 0, existed: true }
  }

  const { parts, blobs } = sectionize(raw)

  // GATE 1 — prove reconstruction BEFORE anything is written. Verifying after the fact would mean
  // discovering the corruption with the bad data already persisted (and, in the backfill, with the
  // source file already a candidate for deletion).
  const rebuilt = reassemble(parts, (sha) => blobs.get(sha))
  if (sha256(rebuilt) !== sha256(raw)) {
    throw new Error(`refusing to store ${srcName}: it does not reconstruct byte-identically`)
  }

  // Only spans we do NOT already have, anywhere (staging or a durable part).
  let newBlobs = 0
  let newBytes = 0
  const app = await store.con.createAppender('blob')
  for (const [sha, span] of blobs) {
    if (store.known.has(sha)) continue
    store.known.add(sha)
    app.appendVarchar(sha)
    app.appendInteger(Buffer.byteLength(span, 'utf8'))
    app.appendVarchar(span)
    app.endRow()
    newBlobs++
    newBytes += Buffer.byteLength(span, 'utf8')
  }
  app.closeSync()

  await appendBodyRow(store, bodyId, srcName, raw, rawBytes, tsMs)

  const p = await store.con.createAppender('part')
  let pos = 0
  for (const part of parts) {
    p.appendVarchar(bodyId)
    p.appendInteger(pos++)
    p.appendVarchar(part.kind)
    if (part.kind === 'lit') {
      p.appendVarchar(part.text); p.appendNull(); p.appendNull(); p.appendNull(); p.appendNull()
    } else {
      p.appendNull()
      p.appendVarchar(part.sha)
      p.appendVarchar(part.path)
      p.appendInteger(part.idx)
      p.appendInteger(part.n)
    }
    p.endRow()
  }
  p.closeSync()

  return { bodyId, rawBytes, newBlobs, newBytes }
}

/**
 * Rebuild a body byte-for-byte. Reads ONLY this body's parts + the spans they reference (never the
 * corpus), verifies the result against the stored whole-body sha256, and THROWS on any mismatch —
 * handing back a body we cannot prove is the original would defeat the point of storing it.
 */
export async function reconstructBody(store: Store, bodyId: string): Promise<string> {
  // Deduped, not raw: a part re-written into a later Parquet generation comes back TWICE from
  // `allOf`, and concatenating both copies doubles the body. See dedupedParts() for the measurement.
  const rows = (await store.con.runAndReadAll(`
    SELECT pos, kind, lit, sha, conflicting FROM ${dedupedParts(store, `body_id = '${bodyId}'`)}
    ORDER BY pos
  `)).getRowObjects()
  if (rows.length === 0) throw new Error(`unknown body ${bodyId}`)
  // Fail fast: collapsing duplicates is only sound while they agree. Two DIFFERENT parts at one
  // position mean the store cannot say what this body is, and returning either one would be a guess
  // dressed up as data.
  const clash = rows.find((r) => r.conflicting === true)
  if (clash) throw new Error(`body ${bodyId}: position ${clash.pos} has conflicting parts — cannot reconstruct`)

  const shas = [...new Set(rows.filter((r) => r.sha !== null).map((r) => `'${String(r.sha)}'`))]
  const spans = new Map<string, string>()
  if (shas.length > 0) {
    const got = (await store.con.runAndReadAll(
      `SELECT sha, data FROM ${allOf(store, 'blob')} WHERE sha IN (${shas.join(',')})`,
    )).getRowObjects()
    for (const g of got) spans.set(String(g.sha), String(g.data))
  }

  const parts: Part[] = rows.map((r) =>
    r.kind === 'lit'
      ? { kind: 'lit', text: String(r.lit ?? '') }
      : { kind: 'blob', sha: String(r.sha), n: 0, path: '', idx: -1 },
  )
  const raw = reassemble(parts, (sha) => spans.get(sha))

  // The body id IS the sha256 of the original bytes, so this is a real end-to-end proof, not a
  // self-consistency check against something we derived from the same rows.
  if (sha256(raw) !== bodyId) {
    throw new Error(`RECONSTRUCTION MISMATCH for ${bodyId} — the store cannot return what it was given`)
  }
  return raw
}

/** Make everything ingested so far durable. Returns the number of spans written. */
export async function flushStore(store: Store): Promise<number> {
  return flush(store)
}

/**
 * Export bodies from the store as plain files into `destDir` — the store half of the
 * `/api/bodies/export` read path (TRDD-K3WDPR7M). Once ingestPass reclaims a source file, the store
 * is the ONLY place that body exists; without this, "export last week's bodies" would silently return
 * only whatever the legacy .wad happened to hold, and the caller would read the gap as "no traffic".
 *
 * One body at a time (reconstruct → write → free), never the corpus — the memory discipline the whole
 * store follows. A name that already exists in destDir is SKIPPED, so this composes with the legacy
 * archive extraction (whichever runs first wins; the bytes are identical when both have the body).
 * Every reconstruction passes through reconstructBody's sha256 gate, so an exported file is PROVEN to
 * be the original — this endpoint must never fabricate evidence.
 */
export async function exportBodiesFromStore(
  store: Store,
  destDir: string,
  sinceMs: number,
  untilMs: number,
): Promise<{ files: number; bytes: number; failed: string[] }> {
  fs.mkdirSync(destDir, { recursive: true })
  // NOTE on `ts`: capture time for bodies ingested after the tsMs plumbing landed; INGEST time for the
  // first backfill (recoverable — see extractMeta). Over-inclusive beats silently missing, so the
  // window filters on what we have.
  const rows = (await store.con.runAndReadAll(`
    SELECT body_id, src_name FROM ${allOf(store, 'body')}
    WHERE epoch_ms(ts) >= ${Math.floor(sinceMs)} AND epoch_ms(ts) <= ${untilMs === Infinity ? Number.MAX_SAFE_INTEGER : Math.floor(untilMs)}
  `)).getRowObjects()

  let files = 0
  let bytes = 0
  const failed: string[] = []
  for (const r of rows) {
    const name = String(r.src_name)
    // Path safety: src_name is data (it came off a filename we once read, but the store contents
    // could in principle be anything) — never let it climb out of destDir.
    const out = path.join(destDir, path.basename(name))
    if (fs.existsSync(out)) continue // the archive half already produced it
    try {
      const raw = await reconstructBody(store, String(r.body_id))
      fs.writeFileSync(out, raw)
      files++
      bytes += Buffer.byteLength(raw, 'utf8')
    } catch (e) {
      failed.push(`${name}: ${(e as Error).message}`) // named, never silently skipped
    }
  }
  return { files, bytes, failed }
}
