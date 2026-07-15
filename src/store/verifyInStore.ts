// The verify-before-delete contract (TRDD-K3WDPR7M, USER directive 2026-07-15): a source file may
// be deleted ONLY after the durable store provably holds ALL of its data — the exact bytes AND the
// capture metadata. Byte-identity alone is not enough: the first backfill proved that a store can
// hold every byte perfectly while stamping 100k bodies with the wrong capture time, silently
// breaking every time-window query. "All data" means bytes + the (src_name, ts) row.
//
// Every deletion gate goes through THIS function — ingestPass (live/spool reclaim), the archive
// drain, the archive retention purge, and the explicit purge endpoint — so the invariant cannot
// drift apart across call sites.
import { allOf, Store } from './db'
import { bodyIdOf, reconstructBody } from './bodyStore'
import { sha256 } from './sections'

export interface VerifyResult {
  ok: boolean
  /** Why verification failed — named, never silent. Empty on success. */
  reason?: string
}

/** ts must match capture time to the second; an ingest-time stamp is off by minutes-to-days, so the
 *  tolerance can absorb mtime float/TIMESTAMP rounding without ever masking real damage. */
export const TS_TOLERANCE_MS = 2000

/** SQL-quote a string literal (src_name/body_id are hex/uuid-ish, but never trust that). */
function q(s: string): string { return `'${s.replace(/'/g, "''")}'` }

/**
 * Prove the durable store fully holds one source body:
 *   1. BYTES — reconstruct by content hash and compare against the source's own bytes. The hash IS
 *      the identity, so a store that cannot return the exact bytes fails here.
 *   2. ROW   — a body row exists for THIS src_name (not merely the same content under another name:
 *      the row is what time-window queries and exports see).
 *   3. TS    — when the caller knows the capture time, the row's ts must match it (±TS_TOLERANCE_MS).
 *
 * The caller must have FLUSHED the store first: this reads the durable+staging union, but the whole
 * point of the gate is that the data survives a crash, which only a flushed Parquet part guarantees.
 */
export async function verifyBodyInStore(
  store: Store,
  srcName: string,
  raw: string,
  tsMs?: number,
): Promise<VerifyResult> {
  const bodyId = bodyIdOf(raw)

  // 1. BYTES — reconstructBody verifies sha256(reconstruction) === bodyId internally and throws on
  // any mismatch; bodyId is derived from `raw` right here, so success == byte-identity with `raw`.
  try {
    const back = await reconstructBody(store, bodyId)
    if (sha256(back) !== sha256(raw)) return { ok: false, reason: `${srcName}: reconstruction != source bytes` }
  } catch (e) {
    return { ok: false, reason: `${srcName}: ${(e as Error).message}` }
  }

  // 2 + 3. ROW + TS — one query answers both.
  const rows = (await store.con.runAndReadAll(
    `SELECT CAST(epoch_ms(ts) AS BIGINT) AS ts_ms FROM ${allOf(store, 'body')}
     WHERE body_id = ${q(bodyId)} AND src_name = ${q(srcName)} LIMIT 1`,
  )).getRowObjects()
  if (rows.length === 0) {
    return { ok: false, reason: `${srcName}: no body row for this src_name (content may exist under another name)` }
  }
  if (tsMs !== undefined) {
    const got = Number(rows[0].ts_ms)
    if (Math.abs(got - tsMs) > TS_TOLERANCE_MS) {
      return {
        ok: false,
        reason: `${srcName}: stored ts ${new Date(got).toISOString()} != capture time ${new Date(tsMs).toISOString()}`,
      }
    }
  }
  return { ok: true }
}
