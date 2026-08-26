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
import { allOf, dedupedParts, Store } from './db'

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

/** Makes each call's batch table unique — see `batchTable` in validateStore. */
let batchTableSeq = 0

export interface ValidateOptions {
  /** Validate only a random sample of bodies (V2). V1 always covers EVERY blob — it is cheap. Use a
   *  sample for a fast health check; use full (undefined) before deleting or swapping anything. */
  sampleBodies?: number
  onProgress?: (done: number, total: number) => void
  /**
   * STARTING bodies per batch. This is only a starting point: peak memory is the batch's reassembled
   * BYTES, which depends on the store's body sizes and on the DuckDB ceiling, and neither is known
   * before the scan. So the loop HALVES on an out-of-memory error and retries the same offset rather
   * than carrying a constant fitted to whichever corpus happened to be measured.
   *
   * Measured on a 757,092-body corpus (~0.5 MB/body), DuckDB ceiling in brackets — note these are
   * CEILINGS, a configuration, not RSS: a 4 GB ceiling measures ~6-7 GB resident, because Parquet
   * read buffers and the node heap sit outside DuckDB's accounting.
   *
   * Since the batch became a temp table (see the loop), 2,000 runs at 4 GB in ~2.6 s. BEFORE that,
   * the same batch OOM'd at 4 GB at every size tried — 2,000 and 25 alike — because the cost was
   * never the batch at all but a hash join built on the 2.3M-row blob side. That is the reason this
   * knob is a starting point rather than a tuned constant: the number that mattered was not this one.
   */
  chunkBodies?: number
}

/**
 * Validate a store. Returns a report — it NEVER throws on invalid data (an exception would be
 * indistinguishable from a bug in the validator itself; the caller must see the counts and decide).
 */
export async function validateStore(store: Store, opts: ValidateOptions = {}): Promise<ValidationReport> {
  const r: ValidationReport = { bodies: 0, bodiesOk: 0, blobs: 0, blobsOk: 0, danglingRefs: 0, errors: [], valid: false }
  const note = (m: string) => { if (r.errors.length < MAX_ERRORS) r.errors.push(m) }

  // ── V1: every blob is what its content-address says it is ────────────────────────────────────
  // Done as ONE streaming aggregate rather than a paged read. Two reasons, both measured on the real
  // 2,326,679-blob corpus (2026-08-26): pulling every span's bytes across the binding cost ~1.3 s per
  // 5,000-row page, and — worse — the paged form was `LIMIT/OFFSET` with NO total order, which is not
  // stable pagination at all: without an ORDER BY the engine may legally return a row on two pages or
  // on none, so the old loop could count a blob twice and never look at another. An aggregate has no
  // pages to misalign. Memory is bounded because only the counters cross the boundary, not the corpus.
  //
  // sha256() here is DuckDB's, not the store's — which keeps the anchor OUTSIDE the code under test
  // exactly as the header demands: `sha` was computed from the ORIGINAL bytes at ingest, and the
  // engine that re-derives it shares no code with the writer.
  const v1 = (await store.con.runAndReadAll(`
    SELECT count(*) AS blobs,
           count(*) FILTER (WHERE sha256(data) = sha AND strlen(data) = n) AS ok
    FROM ${allOf(store, 'blob')}
  `)).getRowObjects()[0]
  r.blobs = Number(v1.blobs)
  r.blobsOk = Number(v1.ok)
  if (r.blobsOk !== r.blobs) {
    const bad = (await store.con.runAndReadAll(`
      -- strlen() is DuckDB's UTF-8 BYTE length (length() counts characters) — the same number
      -- Buffer.byteLength(data, utf8) produced when n was written. Verified, not assumed.
      SELECT sha, n, sha256(data) AS actual, strlen(data) AS nActual FROM ${allOf(store, 'blob')}
      WHERE sha256(data) <> sha OR strlen(data) <> n LIMIT ${MAX_ERRORS}
    `)).getRowObjects()
    for (const b of bad) {
      const sha = String(b.sha)
      if (String(b.actual) !== sha) note(`blob ${sha.slice(0, 12)}: content hashes to ${String(b.actual).slice(0, 12)} — CORRUPT`)
      else note(`blob ${sha.slice(0, 12)}: n=${b.n} but is ${b.nActual} bytes`)
    }
  }

  // ── Dangling references: a part pointing at a span that is not there ──────────────────────────
  // Cheaper to catch here in one query than to discover body-by-body, and it names a whole class of
  // damage (a lost/never-flushed Parquet part) that V2 would otherwise report as N separate failures.
  //
  // Asked via DISTINCT-then-anti-join, NOT `NOT EXISTS` over every part row. Same answer; the
  // difference is which side the join builds on. The corpus has 369,964,058 part rows but only
  // 2,324,352 distinct span references, so collapsing first turns an unbounded correlated subquery
  // into two small joins: measured at a 4 GB ceiling, the `NOT EXISTS` form died in 1.0 s and this one
  // answered in 2.3 s. (The store sets temp_directory='' on purpose, so an over-limit query fails
  // rather than spilling — which is why "it worked before" only meant "the ceiling was ~30 GB".)
  const dangling = (await store.con.runAndReadAll(`
    WITH used AS (SELECT DISTINCT sha FROM ${allOf(store, 'part')} WHERE sha IS NOT NULL),
         miss AS (SELECT u.sha FROM used u ANTI JOIN ${allOf(store, 'blob')} b ON b.sha = u.sha)
    SELECT (SELECT count(*) FROM miss) AS shas,
           (SELECT count(*) FROM ${allOf(store, 'part')} p SEMI JOIN miss m ON m.sha = p.sha) AS rows
  `)).getRowObjects()
  r.danglingRefs = Number(dangling[0].rows)
  if (r.danglingRefs > 0) {
    note(`${r.danglingRefs} part(s) reference ${dangling[0].shas} span(s) that do not exist — those bodies cannot be rebuilt`)
  }

  // ── V2: every body reconstructs to bytes whose sha256 IS its id ───────────────────────────────
  // Set-based, in batches. The old shape called reconstructBody() once per body, and each call ran
  // two UNPRUNED scans of the whole Parquet union — measured at 7-22 s PER BODY on the real corpus,
  // i.e. ~112 days for 757,092 bodies. A gate nobody can afford to run is a gate that does not exist:
  // a real repair sat in here for 12.6 h and was ~0.5 % done. One join per batch does the same proof
  // in seconds — measured, same verdicts.
  //
  // It re-derives the bytes instead of calling reconstructBody, which STRENGTHENS the header's rule:
  // the gate no longer inherits any verdict from the read path it is meant to check. What it must NOT
  // do is disagree with that path about what a body is made of, so both sides read their parts through
  // the one `dedupedParts` definition.
  // `?? 2000` does NOT catch 0, and chunk 0 is a silent hang, not an error: `LIMIT 0` returns no rows,
  // so nothing is counted, `off += chunk` adds nothing, and the loop spins forever issuing queries
  // while onProgress repeats the same numbers — the exact "busy but not advancing" shape this whole
  // change set exists to remove. Reachable by ordinary use: `Number(process.env.CHUNK || 500)` yields
  // 0 for CHUNK=0, and the sibling audit script uses 0 to mean "no cap". Verified: it hung a 30 s
  // probe with zero output. `!(x >= 1)` also rejects NaN and a fraction, which LIMIT would otherwise
  // turn into an obscure binder error.
  const requested = Math.floor(opts.chunkBodies ?? 2000)
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new Error(`chunkBodies must be an integer >= 1, got ${opts.chunkBodies}`)
  }
  let chunk = requested
  const MIN_CHUNK = 25
  // Connection-scoped, so a FIXED name would let two validateStore calls sharing one Store trample
  // each other's batch — silently, returning a WRONG verdict from a delete/swap gate rather than an
  // error. Unique per call is one counter.
  const batchTable = `v_batch_parts_${++batchTableSeq}`
  // ONE definition of the id population, used by both the total and the pages. Two expressions that
  // merely agree today would not do: `count(DISTINCT body_id)` SKIPS NULL while `SELECT DISTINCT
  // body_id` RETURNS it as a row, so a single NULL id would make the pages yield something the total
  // never counted — and `allOf` fills an absent column with NULL by design (that is what BY NAME is
  // for), so that is a reachable shape, not a hypothetical one.
  // A body_id is not "some string" — it IS the sha256 of the original bytes, which is the anchor the
  // whole gate rests on, and sha256 produces exactly one shape. An id that is empty, uppercase, or
  // the wrong length passes a mere IS NOT NULL, then fails downstream as "reconstruction is NOT the
  // original" — a red gate pointing the operator at corruption when the fault is a malformed key.
  // So the population is defined by SHAPE, and everything outside it is counted below, never dropped.
  const WELL_FORMED = `body_id IS NOT NULL AND regexp_matches(body_id, '^[0-9a-f]{64}$')`
  const bodyIds = `(SELECT DISTINCT body_id FROM ${allOf(store, 'body')} WHERE ${WELL_FORMED})`
  const total = opts.sampleBodies ??
    Number((await store.con.runAndReadAll(`SELECT count(*) AS c FROM ${bodyIds}`)).getRowObjects()[0].c)

  // …and the rows that filter EXCLUDES are counted here rather than quietly dropped. Excluding a NULL
  // id from both the total and the pages is what keeps the reconciliation honest, but on its own it
  // would turn the worst damage this gate exists to catch into the one thing it cannot see:
  // `body_id` IS the sha256 of the original bytes, so a body row that lost it is a body with no
  // external fingerprint left. A part row with a NULL body_id is the same wound from the other side —
  // `body_id IN (SELECT ...)` never matches NULL, so it belongs to no body any page can reach.
  const orphan = (await store.con.runAndReadAll(`
    SELECT (SELECT count(*) FROM ${allOf(store, 'body')} WHERE NOT (${WELL_FORMED})) AS bodies,
           (SELECT count(*) FROM ${allOf(store, 'part')} WHERE NOT (${WELL_FORMED})) AS parts
  `)).getRowObjects()[0]
  const orphanBodies = Number(orphan.bodies)
  const orphanParts = Number(orphan.parts)
  if (orphanBodies > 0) note(`${orphanBodies} body row(s) have a missing or malformed body_id (not a sha256) — their content-address is gone, so nothing can verify them`)
  if (orphanParts > 0) note(`${orphanParts} part row(s) have a missing or malformed body_id — they belong to no body and are unreachable`)

  // Paged on the ID COUNT, never on whether the join returned rows. A body with no parts at all
  // contributes no group to `asm`, so `rows.length === 0` does not mean "out of ids" — it means "this
  // page joined to nothing". Terminating on it would silently skip every REMAINING page and still let
  // r.valid come back true, and even a single partless body would vanish from the counts entirely
  // (the old per-body loop threw `unknown body` and FAILED it). The reconciliation after the loop is
  // what turns that back into a visible failure.
  try {
  for (let off = 0; off < total;) {
    const idsSql = opts.sampleBodies
      ? `(SELECT body_id FROM ${bodyIds} USING SAMPLE ${opts.sampleBodies} ROWS)`
      : `(SELECT body_id FROM ${bodyIds} ORDER BY body_id LIMIT ${chunk} OFFSET ${off})`
    // ORDER BY body_id is load-bearing on the paged branch: it is what makes the pages a partition of
    // the corpus instead of an arbitrary redraw per query (the V1 bug, one layer up).
    let rows
    try {
      // The batch's parts go into a REAL temp table before the join, and that is the whole reason
      // this fits in a modest ceiling. As an inline CTE the optimizer has no cardinality for it, so it
      // built the hash join on the 2,326,679-row BLOB side and materialised every `data` value —
      // measured: OOM at a 4 GB ceiling in ~1 s, and identically at chunk 2,000 or chunk 25, because
      // the cost never depended on the batch size at all. Given a real table it builds on the small
      // side: 2,000 bodies in 2.6 s at the SAME 4 GB ceiling. Anything that turns this back into a
      // subquery re-creates a bug that looks like "validation needs 30 GB".
      await store.con.run(`DROP TABLE IF EXISTS ${batchTable}`)
      await store.con.run(
        `CREATE TEMP TABLE ${batchTable} AS
         SELECT * FROM ${dedupedParts(store, `body_id IN ${idsSql}`)}`,
      )
      rows = (await store.con.runAndReadAll(`
      WITH bd AS (SELECT b.sha AS s, any_value(b.data) AS d
                  FROM ${allOf(store, 'blob')} b
                  SEMI JOIN (SELECT DISTINCT sha FROM ${batchTable} WHERE sha IS NOT NULL) n
                    ON n.sha = b.sha
                  GROUP BY b.sha),
           asm AS (SELECT p.body_id AS bid,
                          -- bool_or, not max: one clean position must never mask a conflicting one.
                          bool_or(p.conflicting) AS conflicting,
                          count(*) FILTER (WHERE p.kind <> 'lit' AND bd.d IS NULL) AS missing,
                          string_agg(CASE WHEN p.kind = 'lit' THEN coalesce(p.lit, '') ELSE bd.d END,
                                     '' ORDER BY p.pos) AS txt
                   FROM ${batchTable} p LEFT JOIN bd ON bd.s = p.sha GROUP BY p.body_id)
      SELECT bid, conflicting, missing, sha256(txt) = bid AS ok FROM asm
      `)).getRowObjects()
    } catch (e) {
      // A batch's peak memory is its reassembled BYTES, which nothing knows before the scan: it turns
      // on this store's body sizes and on the DuckDB ceiling, and the store runs with
      // temp_directory='' so an over-limit query FAILS rather than spilling. So the batch size is
      // discovered instead of guessed — halve and retry the SAME offset, which loses only the work of
      // the failed attempt. Nothing has been counted yet at this point, so a retry cannot double-count.
      // Not on the SAMPLE branch: its page size is `sampleBodies`, not `chunk`, so halving would
      // re-draw a fresh sample of the SAME size and demand the same memory — seven identical
      // attempts before throwing the error it was always going to throw.
      const msg = (e as Error).message
      if (/Out of Memory/i.test(msg) && chunk > MIN_CHUNK && !opts.sampleBodies) {
        chunk = Math.max(MIN_CHUNK, Math.floor(chunk / 2))
        continue
      }
      throw e
    }
    for (const row of rows) {
      r.bodies++
      const id = String(row.bid)
      if (row.ok === true) { r.bodiesOk++; continue }
      if (row.conflicting === true) note(`body ${id.slice(0, 12)}: conflicting parts at one position — cannot reconstruct`)
      else if (Number(row.missing) > 0) note(`body ${id.slice(0, 12)}: ${row.missing} part(s) reference a span that is not in the store`)
      else note(`body ${id.slice(0, 12)}: reconstruction is NOT the original`)
    }
    off += chunk
    opts.onProgress?.(r.bodies, total)
    if (opts.sampleBodies) break
  }
  } finally {
    // In a FINALLY, not after the loop: the throwing paths are exactly the ones that leave the table
    // behind (halving exhausted, or any query error), and a leaked batch table pins that batch's
    // parts — `lit` included — against memory_limit for the life of the connection. stagedRewrite
    // closes right after, but a long-lived caller like the server-as-delete-gate does not.
    //
    // BEST-EFFORT, because a rejection here would REPLACE the exception that caused it — and the two
    // ways into this finally are an OOM at the memory ceiling and a dead connection, i.e. precisely
    // the states where a DROP can fail too. Losing "Out of Memory" and reporting a catalog error in
    // its place would hide the only useful thing the failure had to say. The leak this guards against
    // is one batch on one connection; an unreadable error is worse.
    try { await store.con.run(`DROP TABLE IF EXISTS ${batchTable}`) } catch { /* see above */ }
  }
  opts.onProgress?.(r.bodies, total)

  // Every id the body table declares must have been reached. Reported with its DIRECTION, because a
  // bare `> 0` test would let the negative case fail r.valid while printing no reason at all: fewer
  // means ids that joined to no parts, MORE means the corpus grew underneath the ~379 page queries and
  // the run covered an unstable population. Both are failures; only one of them is about parts, and
  // the note says which was actually observed rather than asserting a cause. Skipped for a sample,
  // where `USING SAMPLE n ROWS` legitimately returns fewer than n and a shortfall means nothing.
  const unreached = opts.sampleBodies ? 0 : total - r.bodies
  if (unreached > 0) note(`${unreached} of ${total} body id(s) reached no parts in this pass — nothing to reconstruct them from`)
  else if (unreached < 0) note(`saw ${-unreached} more body id(s) than the ${total} counted at the start — the store was written to during validation, so this result covers a population that changed underneath it`)

  r.valid =
    r.bodies > 0 &&
    r.bodiesOk === r.bodies &&
    unreached === 0 &&
    orphanBodies === 0 &&
    orphanParts === 0 &&
    r.blobsOk === r.blobs &&
    r.danglingRefs === 0
  return r
}
