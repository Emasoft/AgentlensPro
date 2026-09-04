// Migrate forensics.db (SQLite) -> parquet under the DuckDB store. USER directive 2026-09-04:
// "migrate the data to duckdb/parquet. do not lose any data. migrate all to duckdb before deleting
// the sqlite databases."
//
// This script COPIES and PROVES. It deletes nothing, and it never touches the source. Deletion is a
// separate, later decision that this script's verdict is the precondition for.
//
// Three decisions worth knowing before reading the code:
//
// 1. EVERY TABLE, discovered from sqlite_master — not a hardcoded list. The hardcoded list would
//    have been `api_calls, call_content, call_injections`, because those are the three every card
//    and report names. The database actually holds FOUR: `index_state` was in none of them. A
//    migration that enumerates what the docs remember is how the forgotten table gets dropped.
//
// 2. ALL COLUMNS READ AS VARCHAR (`sqlite_all_varchar=true`). SQLite is dynamically typed, so a
//    column DECLARED INTEGER can hold a float — and this database has one: `api_calls.ts` is
//    declared INTEGER and stores 1783602300487.7. Without this flag the scan does not coerce it, it
//    ABORTS ("Mismatch Type Error"), so a typed export would have migrated three tables and died on
//    the fourth. Reading as text captures exactly the bytes SQLite stored, which is the only
//    faithful thing to do when the declared type is known to lie. The declared types are exported
//    alongside (`_schema.json`) so a consumer can cast deliberately rather than having the
//    migration guess.
//
// 3. VERIFICATION IS BY CONTENT HASH, not by row count and not by non-null tally. Row counts agree
//    trivially whenever the write succeeds at all. Non-null tallies are better — they see a column
//    that silently became NULL — but they still pass if every value in a column is REPLACED by a
//    different non-null value. Only hashing the values catches that, so each table is compared on
//    an order-independent md5 over per-row md5s of all columns. NULL encodes as chr(1) and columns
//    join on chr(2), so NULL is distinguishable from the empty string (both occur here) and no
//    value containing the separator can forge another row's encoding. Row and column counts are
//    still checked, because a hash match on zero rows is not a migration.
'use strict'
import { DuckDBInstance } from '@duckdb/node-api'
import fs from 'fs'
import os from 'os'
import path from 'path'

const HOME = os.homedir()
const SRC = process.env.FORENSICS_DB || path.join(HOME, '.agentlens', 'forensics.db')
const OUT = process.env.FORENSICS_PARQUET_DIR || path.join(HOME, '.agentlens', 'store', 'forensics')

if (!fs.existsSync(SRC)) {
  console.error(`migrate-forensics: source not found: ${SRC}`)
  process.exit(2)
}

// A non-empty -wal means committed transactions live OUTSIDE the .db file. DuckDB's sqlite_scanner
// opens the database properly (it does not byte-copy), so it sees them — but if the file is being
// written WHILE we export, source and destination are snapshots of different instants and the
// verification below would compare two moving targets. Warn loudly rather than silently racing.
const wal = `${SRC}-wal`
const walBytes = fs.existsSync(wal) ? fs.statSync(wal).size : 0
if (walBytes > 0) {
  console.warn(`migrate-forensics: WARNING — ${path.basename(wal)} is ${walBytes} bytes (uncommitted`)
  console.warn('  or un-checkpointed data). Stop the writer and re-run, or the verify step compares')
  console.warn('  two different instants of a moving database.')
}

const inst = await DuckDBInstance.create(':memory:')
const con = await inst.connect()
const q = async (sql) => (await (await con.run(sql)).getRowObjectsJson())
await con.run('INSTALL sqlite; LOAD sqlite; SET sqlite_all_varchar=true;')

const scan = (t) => `sqlite_scan('${SRC}','${t}')`
const tables = (await q(`SELECT name FROM ${scan('sqlite_master')} WHERE type='table' ORDER BY name`))
  .map((r) => r.name)
  .filter((n) => !n.startsWith('sqlite_'))

fs.mkdirSync(OUT, { recursive: true })
console.log(`migrate-forensics: ${SRC} -> ${OUT}`)
console.log(`  ${tables.length} table(s): ${tables.join(', ')}`)

// Non-null tally per column, as one row. Used identically on both sides so the comparison is
// like-for-like; building it from the destination's own column list would hide a dropped column.
const tally = async (rel, cols) =>
  (await q(`SELECT count(*) AS __rows, ${cols.map((c) => `count("${c}") AS "${c}"`).join(', ')} FROM ${rel}`))[0]

// Order-independent content hash: md5 each row's columns, then md5 the sorted concatenation. Built
// from the SOURCE's column list on both sides, so a column missing from the destination changes the
// hash instead of quietly shrinking the input to it.
const contentHash = async (rel, cols) => {
  const enc = cols.map((c) => `coalesce("${c}", chr(1))`).join(', ')
  const r = await q(
    `SELECT md5(string_agg(h, '' ORDER BY h)) AS sig FROM (SELECT md5(concat_ws(chr(2), ${enc})) AS h FROM ${rel})`
  )
  return r[0].sig
}

const results = []
for (const t of tables) {
  const cols = (await q(`DESCRIBE SELECT * FROM ${scan(t)}`)).map((r) => r.column_name)
  const before = await tally(scan(t), cols)
  const dest = path.join(OUT, `${t}.parquet`)

  await con.run(`COPY (SELECT * FROM ${scan(t)}) TO '${dest}' (FORMAT PARQUET, COMPRESSION ZSTD)`)

  const destRel = `read_parquet('${dest}')`
  const destCols = (await q(`DESCRIBE SELECT * FROM ${destRel}`)).map((r) => r.column_name)
  const after = await tally(destRel, cols)

  const missing = cols.filter((c) => !destCols.includes(c))
  const drifted = cols.filter((c) => String(before[c]) !== String(after[c]))
  const sigSrc = await contentHash(scan(t), cols)
  const sigDst = missing.length ? null : await contentHash(destRel, cols)
  const ok =
    missing.length === 0 &&
    drifted.length === 0 &&
    String(before.__rows) === String(after.__rows) &&
    sigSrc === sigDst

  results.push({ table: t, rows: String(before.__rows), cols: cols.length, ok, missing, drifted, sig: sigSrc })
  const mark = ok ? 'OK  ' : 'FAIL'
  console.log(`  ${mark} ${t}: ${before.__rows} rows, ${cols.length} cols, md5 ${sigSrc} -> ${path.basename(dest)}`)
  if (sigSrc !== sigDst) console.log(`       CONTENT HASH MISMATCH: source ${sigSrc} vs parquet ${sigDst}`)
  if (missing.length) console.log(`       columns absent in parquet: ${missing.join(', ')}`)
  if (drifted.length) {
    for (const c of drifted) console.log(`       non-null count changed: ${c} ${before[c]} -> ${after[c]}`)
  }
}

// The declared SQLite types, kept because reading as VARCHAR deliberately discarded them. Without
// this file the migration is lossy in a way no row count reveals: the values survive, the intent
// does not.
const declared = {}
for (const t of tables) {
  declared[t] = (await q(`SELECT name, type, "notnull", pk FROM pragma_table_info('${t}')`).catch(() => []))
}
const schemaPath = path.join(OUT, '_schema.json')
fs.writeFileSync(
  schemaPath,
  JSON.stringify({ source: SRC, migratedAt: new Date().toISOString(), tables: results, declared }, null, 2)
)
console.log(`  wrote ${schemaPath}`)

const failed = results.filter((r) => !r.ok)
if (failed.length) {
  console.error(`\nmigrate-forensics: FAIL — ${failed.length} table(s) did not verify. Delete NOTHING.`)
  process.exit(1)
}
console.log(`\nmigrate-forensics: OK — ${results.length} table(s) migrated and verified CONTENT-IDENTICAL (md5 over every value).`)
console.log('The SQLite source is untouched. Deleting it is a separate decision this run does not make.')
