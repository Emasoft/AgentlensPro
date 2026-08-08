// Shared DuckDB helpers for reading Claude transcript NDJSON. Three call sites (burnSeismic.ts,
// causingToolCall.ts, transcriptSql.ts) had each grown their own copy of these fragments; this
// module is the single source so the copies stop drifting.

// DuckDB's per-line object cap for read_json's `maximum_object_size`. 256 MB: a single
// image-bloated transcript turn (~100 MB base64) must SKIP under ignore_errors, not abort the
// whole read. This value was duplicated in 3 copies that had DIVERGED: src/burnSeismic.ts and
// src/causingToolCall.ts used 256 MB (this value); src/transcriptSql.ts used 67_108_864 (64 MB).
// Measured 2026-08-08: 0 of 3,128,613 local transcript lines exceed 64 MB, largest observed is
// 4.1 MB — so the divergence was latent, NOT active data loss. All three now import this constant.
export const MAX_OBJECT_SIZE = 268_435_456

const sqlStr = (s: string): string => `'${s.replace(/'/g, "''")}'`

/**
 * The DuckDB `read_json(...)` table-function text for reading Claude transcript NDJSON, with the
 * shared column projection (timestamp/type/message) and `filename=true` so a multi-file scan can
 * attribute each row back to its source session. Byte-for-byte the spec duplicated at
 * src/burnSeismic.ts:485-488 and src/causingToolCall.ts:167-170 before this module existed.
 */
export function transcriptReadSpec(paths: string[]): string {
  const fileList = paths.map(sqlStr).join(', ')
  return `read_json([${fileList}], format='newline_delimited',
      columns={timestamp:'VARCHAR', type:'VARCHAR', message:'JSON'},
      maximum_object_size=${MAX_OBJECT_SIZE}, ignore_errors=true, filename=true)`
}

/**
 * `ignore_errors=true` does NOT drop an unparseable NDJSON line — MEASURED (src/statuslineStore.ts
 * :511-517): a torn/malformed line lands as an ALL-NULL row, so `count(*)` alone still passes
 * while the data is silently degraded. Comparing `count(*)` against `count(<a column always
 * written on a real record>)` is the only way to see the loss.
 */
export function tornLineSql(table: string, requiredCol: string): string {
  return `SELECT count(*) AS total, count(${requiredCol}) AS withCol FROM ${table}`
}
