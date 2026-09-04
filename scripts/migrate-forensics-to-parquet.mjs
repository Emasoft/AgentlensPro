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
// ABORT, not warn. A non-empty -wal means committed data lives outside the .db file and a writer
// may be active — in which case the `before` tally, the COPY, and the hash read are three different
// instants of a moving database, and the verification compares two moving targets and prints a
// green PASS. The directive is "do not lose any data"; a warning above a PASS line is not
// protection, because the line the reader believes is the last one.
const FORCE = process.argv.includes('--force')
const wal = `${SRC}-wal`
const walBytes = fs.existsSync(wal) ? fs.statSync(wal).size : 0
if (walBytes > 0 && !FORCE) {
  console.error(`migrate-forensics: ABORT — ${path.basename(wal)} is ${walBytes} bytes.`)
  console.error('  Committed data lives outside the .db file and a writer may be active, so source')
  console.error('  and destination would be snapshots of different instants and the content hash')
  console.error('  would compare two moving targets. Stop the writer (or checkpoint), then re-run.')
  console.error('  --force overrides, and accepts that the verification proves less than it says.')
  process.exit(2)
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

  // `COPY ... TO` overwrites unconditionally, and the verification only ever compares the source to
  // what was just written — never to what was ALREADY there. So a source that lost rows (truncated,
  // half-written, restored from an older backup) migrates cleanly OVER a good parquet and reports
  // OK, because both sides genuinely agree. Refuse to shrink an existing export unless forced;
  // growth is normal and passes untouched.
  if (fs.existsSync(dest)) {
    const prior = (await q(`SELECT count(*) AS n FROM read_parquet('${dest}')`))[0].n
    if (Number(prior) > Number(before.__rows) && !FORCE) {
      console.error(`migrate-forensics: ABORT — ${t}: existing parquet has ${prior} rows, source has ${before.__rows}.`)
      console.error('  Overwriting would replace migrated data with a smaller source. The hash check')
      console.error('  cannot catch this: it compares source to destination, and they would agree.')
      console.error('  Investigate the source, or pass --force if the shrink is intended.')
      process.exit(2)
    }
  }

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
// Read the CREATE TABLE text from the source's own sqlite_master. Two earlier attempts were wrong
// in ways that both LOOKED fine:
//   - `pragma_table_info('<t>')` resolves against DUCKDB's catalog, not the attached SQLite file,
//     so it finds nothing for a table that only exists over there;
//   - and it was wrapped in `.catch(() => [])`, so that nothing became an empty array, silently.
// The result shipped as a `_schema.json` whose `declared` map was `{}` for all four tables — a
// file whose entire job is preserving the types `all_varchar` discarded, preserving none of them.
// A swallowed error in a data-preservation path is data loss with a success message on top.
// sqlite_master.sql is the authoritative DDL and cannot be empty for a table that exists, so a
// blank here is a real failure and is treated as one.
const declared = {}
const undeclared = []
for (const t of tables) {
  const rows = await q(`SELECT sql FROM ${scan('sqlite_master')} WHERE type='table' AND name='${t}'`)
  const ddl = rows.length ? rows[0].sql : null
  if (!ddl) undeclared.push(t)
  declared[t] = ddl
}
if (undeclared.length) {
  console.error(`\nmigrate-forensics: FAIL — no CREATE TABLE recovered for: ${undeclared.join(', ')}.`)
  console.error('  Reading every column as VARCHAR discards the declared types, so this DDL is the')
  console.error('  ONLY record of them. Migrating without it is lossy. Delete NOTHING.')
  process.exit(1)
}

// A BLOB read through all_varchar is not guaranteed to round-trip: the bytes go through a text
// decode, and a hash computed on both sides of the SAME lossy decode matches while the data is
// destroyed — the check would confirm the corruption rather than catch it. So refuse outright
// rather than migrate a BLOB and report OK.
const blobbed = Object.entries(declared).filter(([, ddl]) => /\bBLOB\b/i.test(ddl || ''))
if (blobbed.length) {
  console.error(`\nmigrate-forensics: FAIL — BLOB column(s) in: ${blobbed.map(([t]) => t).join(', ')}.`)
  console.error('  all_varchar routes values through a text decode, and the content hash is computed')
  console.error('  on BOTH sides of that same decode — so it would MATCH even if the bytes were')
  console.error('  mangled. Export BLOBs explicitly before trusting this tool. Delete NOTHING.')
  process.exit(1)
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
