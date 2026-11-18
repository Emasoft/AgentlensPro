// Quoting for DuckDB SQL built by interpolation (TRDD-E3Y37BU8, TRDD-CXNUWXX7): one source for every module that puts a string or a file path
// into a query, so the copies cannot drift apart.

/** SQL single-quoted literal — the codebase queries by interpolation, so quoting is load-bearing. */
export function sq(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/** A transcript path as a DuckDB string literal that names exactly that file (TRDD-E3Y37BU8). read_ndjson_objects expands * ? and [ in a path as a file
 *  pattern: a folder named star*dir read the files of starXdir too, and br[ac]ket read only the file under braket, with no error (measured 2026-11-17 and
 *  2026-11-18, DuckDB 1.5.4, reports_dev/sonnet-worker/20261118_search-fixes/). A backslash as an escape does NOT work (no files found). A bracket class
 *  does: [*] [?] [[] each match the character itself, and a lone ] is already literal. But a path holding a backslash is not expanded at all (12 of 12 reads,
 *  pattern characters in the same path included; measured on macOS only, where a backslash is an ordinary file-name character; on Windows it is a separator and
 *  this was not measured), and a bracket class in it is misread, so it is passed as it is.
 *  Measured 2026-11-18 also for read_json, read_json_auto, read_ndjson and read_parquet, single path and list form (TRDD-CXNUWXX7). Do NOT use it for a
 *  COPY ... TO target; use sq there. With plain quoting a COPY TO wrote its file into the folder with the special name (measured 2026-11-18, no sibling folder
 *  present), so COPY TO is read as taking its path literally; a COPY TO with an escaped target was not run. */
export function sqPath(p: string): string {
  return sq(p.includes("\\") ? p : p.replace(/[*?[]/g, "[$&]"))
}
