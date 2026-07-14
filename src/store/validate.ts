// INDEPENDENT store validation (TRDD-K3WDPR7M). This is the gate that decides whether data may be
// deleted or a migrated store may replace the live one — so it must not be capable of rubber-stamping
// a corrupt store.
//
// THE DESIGN RULE: never ask the store whether it agrees with itself. A validator built out of the
// same assumptions as the writer will happily confirm a store that is internally consistent and
// completely wrong (right structure, wrong bytes). Both checks below are anchored OUTSIDE the store,
// in a hash taken from the ORIGINAL source bytes at ingest time:
//
//   V1 — CONTENT-ADDRESS INTEGRITY (structural, every span):
//        for every blob row,  sha256(data) MUST equal its own `sha` key, and `n` MUST equal the real
//        byte length. A bit-flip in a Parquet page, a truncated span, a mis-encoded UTF-8 round trip
//        — all change the hash. This checks spans NOTHING references too, so it catches rot in parts
//        of the corpus no test body happens to touch.
//
//   V2 — END-TO-END CRYPTOGRAPHIC (every body):
//        reconstruct the body from its parts and assert sha256(bytes) == body_id. body_id IS the
//        sha256 of the ORIGINAL FILE, computed at ingest before anything was stored. So this compares
//        today's reconstruction against a fingerprint of bytes that no longer exist anywhere else.
//        Wrong part order, a dropped literal, a swapped blob, a bad migration — every one of them
//        changes the reassembled bytes, and no amount of internal consistency can forge the hash.
//
// V1 without V2 would miss structure errors (correct spans, wrong assembly). V2 without V1 would miss
// rot in unreferenced spans. Together they are the double verification.
import { allOf, Store } from './db'
import { reconstructBody } from './bodyStore'
import { sha256 } from './sections'

export interface ValidationReport {
  bodies: number
  bodiesOk: number
  blobs: number
  blobsOk: number
  /** Parts referencing a sha that does not exist — a body that CANNOT be rebuilt. */
  danglingRefs: number
  /** Human-readable failures, capped (the first few are what a human acts on). */
  errors: string[]
  /** The ONLY thing a caller should branch on. True iff every check passed with zero failures. */
  valid: boolean
}

const MAX_ERRORS = 20

export interface ValidateOptions {
  /** Validate only a random sample of bodies (V2). V1 always covers EVERY blob — it is cheap. Use a
   *  sample for a fast health check; use full (undefined) before deleting or swapping anything. */
  sampleBodies?: number
  onProgress?: (done: number, total: number) => void
}

/**
 * Validate a store. Returns a report — it NEVER throws on invalid data (an exception would be
 * indistinguishable from a bug in the validator itself; the caller must see the counts and decide).
 */
export async function validateStore(store: Store, opts: ValidateOptions = {}): Promise<ValidationReport> {
  const r: ValidationReport = { bodies: 0, bodiesOk: 0, blobs: 0, blobsOk: 0, danglingRefs: 0, errors: [], valid: false }
  const note = (m: string) => { if (r.errors.length < MAX_ERRORS) r.errors.push(m) }

  // ── V1: every blob is what its content-address says it is ────────────────────────────────────
  // Streamed in chunks: the corpus is larger than RAM, and a validator that OOMs is a validator that
  // does not run when it matters.
  const CHUNK = 5000
  for (let off = 0; ; off += CHUNK) {
    const rows = (await store.con.runAndReadAll(
      `SELECT sha, n, data FROM ${allOf(store, 'blob')} LIMIT ${CHUNK} OFFSET ${off}`,
    )).getRowObjects()
    if (rows.length === 0) break
    for (const row of rows) {
      r.blobs++
      const sha = String(row.sha)
      const data = String(row.data)
      const actual = sha256(data)
      const nActual = Buffer.byteLength(data, 'utf8')
      if (actual !== sha) { note(`blob ${sha.slice(0, 12)}: content hashes to ${actual.slice(0, 12)} — CORRUPT`); continue }
      if (Number(row.n) !== nActual) { note(`blob ${sha.slice(0, 12)}: n=${row.n} but is ${nActual} bytes`); continue }
      r.blobsOk++
    }
  }

  // ── Dangling references: a part pointing at a span that is not there ──────────────────────────
  // Cheaper to catch here in one query than to discover body-by-body, and it names a whole class of
  // damage (a lost/never-flushed Parquet part) that V2 would otherwise report as N separate failures.
  const dangling = (await store.con.runAndReadAll(`
    SELECT count(*) c FROM ${allOf(store, 'part')} p
    WHERE p.sha IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM ${allOf(store, 'blob')} b WHERE b.sha = p.sha)
  `)).getRowObjects()
  r.danglingRefs = Number(dangling[0].c)
  if (r.danglingRefs > 0) note(`${r.danglingRefs} part(s) reference a span that does not exist — those bodies cannot be rebuilt`)

  // ── V2: every body reconstructs to bytes whose sha256 IS its id ───────────────────────────────
  const ids = (await store.con.runAndReadAll(
    `SELECT DISTINCT body_id FROM ${allOf(store, 'body')}${opts.sampleBodies ? ` USING SAMPLE ${opts.sampleBodies} ROWS` : ''}`,
  )).getRowObjects().map((x) => String(x.body_id))

  for (const [i, id] of ids.entries()) {
    r.bodies++
    try {
      const raw = await reconstructBody(store, id)
      // reconstructBody already asserts this, but we re-assert it HERE rather than trusting it: this
      // function is the delete/swap gate, and it must not inherit its verdict from the code it is
      // meant to be checking.
      if (sha256(raw) === id) r.bodiesOk++
      else note(`body ${id.slice(0, 12)}: reconstruction hashes to ${sha256(raw).slice(0, 12)} — NOT the original`)
    } catch (e) {
      note(`body ${id.slice(0, 12)}: ${(e as Error).message}`)
    }
    if (i % 250 === 0) opts.onProgress?.(i, ids.length)
  }
  opts.onProgress?.(ids.length, ids.length)

  r.valid =
    r.bodies > 0 &&
    r.bodiesOk === r.bodies &&
    r.blobsOk === r.blobs &&
    r.danglingRefs === 0
  return r
}
