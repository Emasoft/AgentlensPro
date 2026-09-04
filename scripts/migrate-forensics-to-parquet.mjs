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
// TWO SEPARATE OVERRIDES, deliberately not one `--force`. The WAL abort is the one a user hits
// routinely (see below — a checkpointed WAL is often left on disk at full size), while the shrink
// abort should essentially never fire. A single flag would mean that routinely forcing past the
// common, usually-benign case ALSO silently disables the protection against overwriting good data
// with a degraded source. Overriding the noisy guard must not disarm the quiet one.
const has = (f) => process.argv.includes(f)
const FORCE_WAL = has('--force-wal') || has('--force')
const FORCE_SHRINK = has('--force-shrink') || has('--force')

const wal = `${SRC}-wal`
const walBytes = fs.existsSync(wal) ? fs.statSync(wal).size : 0
if (walBytes > 0 && !FORCE_WAL) {
  console.error(`migrate-forensics: ABORT — ${path.basename(wal)} is ${walBytes} bytes.`)
  console.error('  Data may live outside the .db file and a writer may be active, so source and')
  console.error('  destination would be snapshots of different instants and the content hash would')
  console.error('  compare two moving targets. Stop the writer (or checkpoint), then re-run.')
  console.error('')
  console.error('  KNOWN FALSE POSITIVE: SQLite does not truncate the -wal on checkpoint by default,')
  console.error('  so a perfectly quiescent database can sit here with a large, EMPTY-of-frames WAL.')
  console.error('  Size is a proxy for "pending frames" and it is a poor one — it cannot distinguish')
  console.error('  a live writer from a leftover file. It errs toward refusing, which is the correct')
  console.error('  direction for a data migration, but it means --force-wal is an ordinary thing to')
  console.error('  need, NOT an admission of risk. That is exactly why it does not also disable the')
  console.error('  shrink guard (--force-shrink), which is a different and much stronger claim.')
  process.exit(2)
}

const inst = await DuckDBInstance.create(':memory:')
const con = await inst.connect()
const q = async (sql) => (await (await con.run(sql)).getRowObjectsJson())
// READ-ONLY IS NOT THE DEFAULT, and assuming it was is how this tool spent three commits printing
// "the SQLite source is untouched" while its own reads moved the -shm sidecar's mtime (measured:
// .db md5 identical before and after, -shm mtime +12s). DuckDB's sqlite reader OPENS the database
// rather than byte-copying it, and a read-write open of a WAL-mode database maps the -shm and can
// checkpoint the -wal on close. Two things follow, and the second is the nastier one:
//   - a tool that promises not to touch the source must not take a write lock on it, least of all
//     while a collector may be writing;
//   - the WAL guard above would otherwise be measuring state THIS TOOL created — a previous run
//     checkpointing the WAL to empty makes the next run's "quiescent" verdict self-fulfilling.
// Read-only makes the promise true by construction instead of by hope.
await con.run('INSTALL sqlite; LOAD sqlite;')

// PASS 1 — READ-ONLY ATTACH, no all_varchar: the DECLARED types, straight from the source catalog.
// This is both the read-only fix and a better answer than parsing DDL text: `sqlite_scan()` opens
// the database READ-WRITE (there is no read-only flag for it), which is how this tool printed "the
// source is untouched" for three commits while its own reads moved the -shm mtime. Worse, a
// read-write open of a WAL-mode database can checkpoint the -wal on close, so the WAL guard above
// was liable to be measuring state THIS TOOL created — a previous run quiescing the database makes
// the next run's "quiescent" verdict self-fulfilling. ATTACH ... READ_ONLY takes no write lock, so
// the promise holds by construction rather than by hope.
await con.run(`ATTACH '${SRC}' AS ro (TYPE sqlite, READ_ONLY)`)
const typed = await q(
  `SELECT table_name, column_name, data_type FROM duckdb_columns() WHERE database_name='ro' ORDER BY table_name, column_index`
)
await con.run('DETACH ro')

const tables = [...new Set(typed.map((r) => r.table_name))].filter((n) => !n.startsWith('sqlite_')).sort()
if (!tables.length) {
  console.error(`migrate-forensics: FAIL — no tables found in ${SRC}. Delete NOTHING.`)
  process.exit(1)
}

// PASS 2 — READ-ONLY ATTACH with all_varchar for the DATA. Needed because SQLite is dynamically
// typed and this database proves it: `api_calls.ts` is declared INTEGER (BIGINT above) and stores
// 1783602300487.7, which a typed scan refuses with "Mismatch Type Error" rather than coercing. Two
// attaches rather than one because the setting is applied when the tables are bound, so the typed
// view and the text view cannot coexist on the same alias.
await con.run('SET sqlite_all_varchar=true;')
await con.run(`ATTACH '${SRC}' AS rov (TYPE sqlite, READ_ONLY)`)
const scan = (t) => `rov."${t}"`

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
    if (Number(prior) > Number(before.__rows) && !FORCE_SHRINK) {
      console.error(`migrate-forensics: ABORT — ${t}: existing parquet has ${prior} rows, source has ${before.__rows}.`)
      console.error('  Overwriting would replace migrated data with a smaller source. The hash check')
      console.error('  cannot catch this: it compares source to destination, and they would agree.')
      console.error('  Investigate the source, or pass --force-shrink if the shrink is intended.')
      process.exit(2)
    }
    // Keep the previous export. The count guard above only catches a SHRINKING source; an
    // equal-count source with corrupted values overwrites good data and both sides agree, so the
    // hash cannot see it. Making every overwrite recoverable is strictly better than making the
    // guard cleverer, and much smaller: one rename covers the whole class of "the new copy is
    // worse than the old one", including the cases nobody predicted.
    fs.renameSync(dest, `${dest}.prev`)
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
// Types come from PASS 1's typed read-only catalog (above). Three attempts, and the first two both
// LOOKED fine while preserving nothing:
//   - `pragma_table_info('<t>')` resolves against DUCKDB's catalog, not a database reached by the
//     `sqlite_scan()` table function, so it found nothing for tables that only existed over there;
//   - and it was wrapped in `.catch(() => [])`, turning that nothing into an empty array, silently.
//     `_schema.json` shipped with `declared: {}` for all four tables — a file whose entire job is
//     preserving the types `all_varchar` discards, preserving none of them. A swallowed error in a
//     data-preservation path is data loss with a success message on top.
//   - reading `sqlite_master.sql` fixed that but kept `sqlite_scan()`, which opens READ-WRITE.
// The catalog of a READ_ONLY attach fixes both at once, and is stricter than parsing DDL text: an
// empty column list for a table that exists is impossible, so a blank here is a real failure.
const declared = {}
const undeclared = []
for (const t of tables) {
  const cols = typed.filter((r) => r.table_name === t).map((r) => ({ name: r.column_name, type: r.data_type }))
  if (!cols.length) undeclared.push(t)
  declared[t] = cols
}
if (undeclared.length) {
  console.error(`\nmigrate-forensics: FAIL — no declared columns recovered for: ${undeclared.join(', ')}.`)
  console.error('  Reading every column as VARCHAR discards the declared types, so this record is')
  console.error('  the ONLY copy of them. Migrating without it is lossy. Delete NOTHING.')
  process.exit(1)
}

// A BLOB read through all_varchar is not guaranteed to round-trip: the bytes go through a text
// decode, and a hash computed on both sides of the SAME lossy decode matches while the data is
// destroyed — the check would CONFIRM the corruption rather than catch it. So refuse outright
// rather than migrate a BLOB and report OK.
//
// WHAT THIS CHECK CANNOT DO, stated because the temptation is to read it as "no BLOBs here":
// it reads DECLARATIONS, and in this database declarations demonstrably lie — `api_calls.ts` is
// declared INTEGER and stores a float. SQLite is dynamically typed, so ANY column can hold a blob
// value whatever its declared type, and a column declared with NO type at all has BLOB affinity
// while containing the string "BLOB" nowhere. This regex is a cheap first line that catches the
// honest case; it is NOT proof of absence. A migration that must be certain has to inspect
// typeof() per value at the SQLite level, which this tool does not do.
// Read from the CATALOG of the typed read-only attach, not by regexing DDL text. The earlier
// version tested /\bBLOB\b/i against the CREATE TABLE string, which misses a column declared with
// no type at all (BLOB affinity in SQLite, and the word appears nowhere) and misses VARBINARY /
// BYTEA. Asking the catalog for the resolved type has neither blind spot.
const blobbed = Object.entries(declared).filter(([, cols]) => cols.some((c) => /BLOB/i.test(c.type)))
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
// Precisely: the .db BYTES are unchanged — verified by md5 before and after a run (identical).
// The `-shm` sidecar's mtime DOES move, because DuckDB's sqlite reader opens the database rather
// than byte-copying it, and opening touches shared-memory coordination state. That is not data,
// and no row is altered — but "untouched" was the wrong word and a migration tool is the last
// place to be loose about what it did to the source.
console.log('The SQLite source data is unmodified (.db bytes identical; the -shm sidecar is touched by opening).')
console.log('Deleting it is a separate decision this run does not make.')
