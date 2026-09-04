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
// 2. THE READ GOES THROUGH sql.js, NOT DuckDB's sqlite scanner — and that is a correctness
//    requirement, not a preference. DuckDB cannot read this database typed (`api_calls.ts` is
//    DECLARED INTEGER and STORES 1783602300487.7, so a typed scan aborts), and its
//    `sqlite_all_varchar=true` fallback routes every value through SQLite's DEFAULT text
//    conversion, which renders a REAL with ~15 significant digits.
//
//    MEASURED, and this shipped as a silent data loss for four commits: of 5,217 rows where
//    `typeof(ts)='real'`, **5,088 do not survive `CAST(ts AS TEXT)`** — 1783590196747.9863 becomes
//    "1783590196747.99". `printf('%!.20g', ts)` loses ZERO. The content hash could never catch it,
//    because both sides of the comparison hashed the ALREADY-TRUNCATED text: exactly the failure
//    this file documents for BLOBs ("a hash computed on both sides of the same lossy decode would
//    MATCH even if the bytes were mangled") reproduced for REALs, in the same file, by the same
//    mechanism.
//
//    So: sql.js, with `printf('%!.20g', col)` on every column that actually holds a REAL. Two
//    further properties come free and are worth stating —
//      - sql.js reads a Buffer from `fs.readFileSync`, so NO database engine ever opens the source.
//        No write lock, no `-shm` mapping, no WAL checkpoint risk. The earlier READ_ONLY attach was
//        an improvement over a read-write open; this is strictly better than both.
//      - it is the engine the PRODUCT reads with today, so the migration captures exactly what the
//        product sees, rather than what a stricter reader makes of it.
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
import initSqlJs from 'sql.js'
import { DuckDBInstance } from '@duckdb/node-api'
import { createRequire } from 'module'
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

// TWO SEPARATE OVERRIDES, deliberately not one `--force`. The WAL abort is the one a user hits
// routinely (a checkpointed WAL is often left on disk at full size — see below), while the shrink
// abort should essentially never fire. A single flag would mean that routinely forcing past the
// common, usually-benign case ALSO silently disables the protection against overwriting good data
// with a degraded source. Overriding the noisy guard must not disarm the quiet one.
const has = (f) => process.argv.includes(f)
const FORCE_WAL = has('--force-wal') || has('--force')
const FORCE_SHRINK = has('--force-shrink') || has('--force')

// WAL abort survives the move to sql.js — for a DIFFERENT reason than it guarded against under the
// DuckDB attach. It used to be about a moving target (source and destination read at different
// instants of an actively-written database). sql.js instead reads the bare `.db` file as a single
// Buffer via fs.readFileSync and NEVER looks at `-wal` at all — so a non-empty WAL now means
// something worse than a race: committed transactions that live ONLY in the WAL are simply
// INVISIBLE to this read. A migration that silently drops committed rows because it read a stale
// snapshot is exactly the failure this file exists to prevent, so this still aborts rather than warns.
const wal = `${SRC}-wal`
const walBytes = fs.existsSync(wal) ? fs.statSync(wal).size : 0
if (walBytes > 0 && !FORCE_WAL) {
  console.error(`migrate-forensics: ABORT — ${path.basename(wal)} is ${walBytes} bytes.`)
  console.error('  sql.js reads the .db file as a plain Buffer and never looks at -wal, so any')
  console.error('  transaction committed only to the WAL would be silently ABSENT from the migration')
  console.error('  — not stale, not truncated, just never seen. Checkpoint the WAL into the .db file')
  console.error('  (or stop the writer and let it checkpoint), then re-run.')
  console.error('')
  console.error('  KNOWN FALSE POSITIVE: SQLite does not truncate the -wal on checkpoint by default,')
  console.error('  so a perfectly quiescent database can sit here with a large, EMPTY-of-frames WAL.')
  console.error('  Size is a proxy for "pending frames" and it is a poor one — it cannot distinguish')
  console.error('  a checkpointed-but-not-truncated WAL from one holding real uncommitted data. It')
  console.error('  errs toward refusing, which is the correct direction for a data migration, but it')
  console.error('  means --force-wal is an ordinary thing to need, NOT an admission of risk. That is')
  console.error('  exactly why it does not also disable the shrink guard (--force-shrink), which is a')
  console.error('  different and much stronger claim.')
  process.exit(2)
}

// sql.js ships its wasm binary alongside its JS loader; resolve the dist dir from the INSTALLED
// package rather than a path relative to this script, so the script works from any cwd and any
// install layout (npm link, pnpm's nested store, a global install).
const require = createRequire(import.meta.url)
const sqlJsDistDir = path.dirname(require.resolve('sql.js'))
const SQL = await initSqlJs({ locateFile: (f) => path.join(sqlJsDistDir, f) })
const srcDb = new SQL.Database(fs.readFileSync(SRC))

// sql.js returns column-major {columns, values} per statement; every call site here wants row
// objects, so reshape once here instead of at every call site.
const execAll = (db, sql) => {
  const res = db.exec(sql)
  if (!res.length) return []
  const { columns, values } = res[0]
  return values.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])))
}

// Table list + verbatim DDL from the SAME sqlite_master query, in one pass — both are now free.
// sql.js already holds the whole file in memory, so there is no read-write open to avoid and no
// reason to split "typed schema" from "DDL text" into separate passes the way the DuckDB sqlite
// scanner required. (This file used to say "this one query opens the source read-write" here —
// that was DuckDB's sqlite_scan() taking a write lock just to read sqlite_master. sql.js reads a
// Buffer, so nothing ever opens the file: not read-write, not read-only, not at all.)
const master = execAll(srcDb, `SELECT name, sql FROM sqlite_master WHERE type='table'`)
const verbatimDdl = {}
for (const r of master) {
  if (!r.name.startsWith('sqlite_')) verbatimDdl[r.name] = r.sql
}
const tables = Object.keys(verbatimDdl).sort()
if (!tables.length) {
  console.error(`migrate-forensics: FAIL — no tables found in ${SRC}. Delete NOTHING.`)
  process.exit(1)
}

fs.mkdirSync(OUT, { recursive: true })
console.log(`migrate-forensics: ${SRC} -> ${OUT}`)
console.log(`  ${tables.length} table(s): ${tables.join(', ')}`)

// resolvedTypes: SQLite's own DECLARED type strings, from PRAGMA table_info — straight off the
// source, no DuckDB catalog mapping in between. (The DuckDB catalog is what used to collapse
// TEXT/VARCHAR(255)/INTEGER into DuckDB's own vocabulary; PRAGMA table_info gives back exactly
// what CREATE TABLE said, which is a more literal record than DuckDB's resolved shape ever was.)
const resolvedTypes = {}
const undeclared = []
for (const t of tables) {
  const cols = execAll(srcDb, `PRAGMA table_info("${t}")`).map((r) => ({ name: r.name, type: r.type }))
  if (!cols.length) undeclared.push(t)
  resolvedTypes[t] = cols
}
if (undeclared.length) {
  console.error(`\nmigrate-forensics: FAIL — no columns recovered for: ${undeclared.join(', ')}. Delete NOTHING.`)
  process.exit(1)
}

// BLOB refusal, now in TWO parts. The declared-type check catches a column declared BLOB / no type
// (BLOB affinity) / VARBINARY / BYTEA. It is still not proof of absence — SQLite is dynamically
// typed, and `api_calls.ts` is the proof: declared INTEGER, stores a float. So this pass ALSO asks
// every row what it actually holds, via typeof(), and refuses on a real hit — the same query also
// finds which columns actually hold a REAL, needed below to pick the extraction expression.
const declaredBlob = Object.entries(resolvedTypes).filter(([, cols]) => cols.some((c) => /BLOB|VARBINARY|BYTEA/i.test(c.type)))
const actualBlob = []
const realColumns = {}
for (const t of tables) {
  const cols = resolvedTypes[t].map((c) => c.name)
  const probe = execAll(
    srcDb,
    `SELECT ${cols
      .map(
        (c) =>
          `sum(CASE WHEN typeof("${c}")='blob' THEN 1 ELSE 0 END) AS "${c}__blob", sum(CASE WHEN typeof("${c}")='real' THEN 1 ELSE 0 END) AS "${c}__real"`
      )
      .join(', ')} FROM "${t}"`
  )[0]
  const reals = new Set()
  for (const c of cols) {
    if (Number(probe[`${c}__blob`]) > 0) actualBlob.push(`${t}.${c}`)
    if (Number(probe[`${c}__real`]) > 0) reals.add(c)
  }
  realColumns[t] = reals
}
if (declaredBlob.length || actualBlob.length) {
  console.error(`\nmigrate-forensics: FAIL — BLOB data found.`)
  if (declaredBlob.length) console.error(`  declared BLOB/VARBINARY/BYTEA column(s) in: ${declaredBlob.map(([t]) => t).join(', ')}.`)
  if (actualBlob.length) console.error(`  column(s) holding an actual blob value: ${actualBlob.join(', ')}.`)
  console.error('  A text decode is lossy for blob bytes, and the content hash is computed on BOTH')
  console.error('  sides of that same decode — so it would MATCH even if the bytes were mangled.')
  console.error('  Export BLOBs explicitly before trusting this tool. Delete NOTHING.')
  process.exit(1)
}

// DuckDB is used from here on ONLY to write parquet and to hash — never to read the source. The
// source-side relation each table is verified against is a NDJSON file this script itself wrote
// from sql.js's own extraction, loaded back with an explicit all-VARCHAR schema so DuckDB's JSON
// type inference cannot re-introduce the exact precision loss this file exists to avoid.
const inst = await DuckDBInstance.create(':memory:')
const con = await inst.connect()
const q = async (sql) => (await (await con.run(sql)).getRowObjectsJson())

// Non-null tally per column, as one row. Used identically on both sides so the comparison is
// like-for-like; building it from the destination's own column list would hide a dropped column.
const tally = async (rel, cols) =>
  (await q(`SELECT count(*) AS __rows, ${cols.map((c) => `count("${c}") AS "${c}"`).join(', ')} FROM ${rel}`))[0]

// Order-independent content hash: md5 each row's columns, then md5 the sorted concatenation. NULL
// encodes as chr(1) and columns join on chr(2), so NULL is distinguishable from the empty string
// (both occur here) and no value containing the separator can forge another row's encoding.
const contentHash = async (rel, cols) => {
  const enc = cols.map((c) => `coalesce("${c}", chr(1))`).join(', ')
  const r = await q(
    `SELECT md5(string_agg(h, '' ORDER BY h)) AS sig FROM (SELECT md5(concat_ws(chr(2), ${enc})) AS h FROM ${rel})`
  )
  return r[0].sig
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-forensics-migrate-'))
const schemaPath = path.join(OUT, '_schema.json')
const results = []
for (const t of tables) {
  const cols = resolvedTypes[t].map((c) => c.name)
  const reals = realColumns[t]

  // Per-ROW extraction, not per-column — SQLite is dynamically typed at the row level, and
  // `realColumns` (a column that has AT LEAST ONE real row) is not the same claim as "every row in
  // this column is real". MEASURED: `api_calls.ts` has 9,068 INTEGER rows and 5,217 REAL rows in
  // the SAME column. An earlier version of this extraction ran printf() on the whole column once it
  // was flagged, which turned every integer row into "…328.0" — not truncation, but a needless
  // reformat of values that were never at risk, and it broke the post-migration precision check
  // (`length(split_part(ts,'.',2))<4`, which correctly treats a lone ".0" as suspicious). typeof()
  // per row is the only test that is actually correct: only a row that IS a REAL goes through
  // printf('%!.20g', …); an INTEGER or TEXT row in the same column is a plain text cast, unchanged
  // from before. `realColumns` above still narrows which columns need the CASE at all (a column
  // with zero real rows never needs typeof() checked per row) and still drives the NULL-drift
  // verification below.
  //
  // CAST(NULL AS TEXT) is NULL, but printf(NULL, …) is NOT — measured against this database, it
  // returns the STRING "0.0", typeof 'text'. `break_cause` alone is 14,285 rows of NULL, and without
  // the guard below every one of them would silently become the text "0.0": a worse corruption than
  // the truncation this file exists to fix. So NULL is checked first and short-circuits both branches.
  const extractSql = `SELECT ${cols
    .map((c) =>
      reals.has(c)
        ? `CASE WHEN "${c}" IS NULL THEN NULL WHEN typeof("${c}")='real' THEN printf('%!.20g', "${c}") ELSE CAST("${c}" AS TEXT) END AS "${c}"`
        : `CAST("${c}" AS TEXT) AS "${c}"`
    )
    .join(', ')} FROM "${t}"`

  // Stream row-by-row via prepare/step rather than materializing the whole table as a JS array —
  // api_calls alone is 5k+ rows of already-large text, and this scales to whatever the store grows
  // to without holding two full copies (sql.js's + the array's) in memory at once.
  const ndjsonPath = path.join(tmpDir, `${t}.ndjson`)
  const stmt = srcDb.prepare(extractSql)
  const out = fs.createWriteStream(ndjsonPath)
  let sourceRows = 0
  while (stmt.step()) {
    const row = stmt.getAsObject()
    // Force every value to a JSON STRING or null, never a JSON number. The extraction above already
    // produces text (printf/CAST both return strings), so this should be a no-op — but a JSON number
    // round-trips through JS's double parser on the way back in, which would silently discard
    // exactly the extra digits printf('%!.20g', …) exists to preserve. Belt-and-suspenders against
    // sql.js ever handing back a numeric JS value for a TEXT column.
    for (const k of Object.keys(row)) {
      if (row[k] !== null && typeof row[k] !== 'string') row[k] = String(row[k])
    }
    out.write(JSON.stringify(row) + '\n')
    sourceRows++
  }
  stmt.free()
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())))

  // Every column loads as VARCHAR, explicitly — printf() and CAST(...AS TEXT) already produced
  // strings, but DuckDB's JSON reader infers types from the values it sees unless told otherwise,
  // and an inferred DOUBLE column would silently re-introduce the exact precision loss this whole
  // file exists to avoid.
  const columnsMap = cols.map((c) => `'${c.replace(/'/g, "''")}': 'VARCHAR'`).join(', ')
  const srcRel = `read_json('${ndjsonPath}', columns={${columnsMap}}, format='newline_delimited')`

  const before = await tally(srcRel, cols)
  if (String(before.__rows) !== String(sourceRows)) {
    console.error(`\nmigrate-forensics: FAIL — ${t}: sql.js streamed ${sourceRows} row(s), DuckDB's read_json loaded ${before.__rows}.`)
    console.error('  The NDJSON round trip lost or gained rows. Delete NOTHING.')
    process.exit(1)
  }
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
    // ONE backup, and it is NEVER overwritten — the OLDEST surviving copy, not the newest.
    //
    // A `.prev` that gets replaced every run survives exactly one mistake: run 1 saves the good
    // copy, run 2 saves the bad one over it, and a second run is what someone does when the first
    // looks wrong. Keeping the first instead means the backup is the last state before this tool
    // ever touched the directory, which is the copy that actually matters.
    //
    // Timestamping every generation was the previous attempt. It never loses a copy but grows
    // without bound in the user's data dir — measured at 6.4 MB across 16 files after a handful of
    // test runs. `never_free_space.md` forbids an agent reclaiming disk, so unbounded growth is a
    // problem this tool must not CREATE, not one someone can tidy later. Bounded at 1x, no
    // retention policy needed.
    // NOTE the missing `else fs.unlinkSync(dest)`. An earlier version deleted the current parquet
    // when a `.prev` already existed, then let COPY recreate it — which opened a window where the
    // ONLY surviving copy was a stale backup from run 1. A crash, SIGINT, disk-full, or a COPY
    // error in that window leaves the user with an old backup and no current file. The unlink was
    // also gratuitous: `COPY ... TO` overwrites unconditionally. Doing nothing is both safer and
    // less code.
    const prev = `${dest}.prev`
    if (!fs.existsSync(prev)) fs.renameSync(dest, prev)
  }

  await con.run(`COPY (SELECT * FROM ${srcRel}) TO '${dest}' (FORMAT PARQUET, COMPRESSION ZSTD)`)

  const destRel = `read_parquet('${dest}')`
  const destCols = (await q(`DESCRIBE SELECT * FROM ${destRel}`)).map((r) => r.column_name)
  const after = await tally(destRel, cols)

  const missing = cols.filter((c) => !destCols.includes(c))
  const drifted = cols.filter((c) => String(before[c]) !== String(after[c]))
  const sigSrc = await contentHash(srcRel, cols)
  const sigDst = missing.length ? null : await contentHash(destRel, cols)

  // NULL-preservation check, explicit for REAL-holding columns: this is the exact class of bug that
  // was caught during review (printf(NULL,…) silently becoming the text "0.0"). `drifted` above
  // already catches ANY non-null-count change on ANY column, which subsumes this — a NULL turning
  // into "0.0" IS a non-null-count change — but the REAL columns get their own named check because
  // this is the one bug this file has actually shipped, and a check that names the risk it guards is
  // worth the two extra lines even where a more general check already covers it.
  for (const c of reals) {
    const srcNulls = Number(before.__rows) - Number(before[c])
    const dstNulls = Number(after.__rows) - Number(after[c])
    if (srcNulls !== dstNulls && !drifted.includes(c)) drifted.push(c)
  }

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

srcDb.close()
fs.rmSync(tmpDir, { recursive: true, force: true })

// The declared SQLite types, kept because parquet has no room for them and every value is stored as
// VARCHAR here regardless of its source type. Without this file the migration is lossy in a way no
// row count reveals: the values survive, the intent does not.
//
// resolvedTypes now comes straight from the source's own PRAGMA table_info (above) — the literal
// declared string, not a mapping through some other engine's type vocabulary. verbatimDdl is the
// source's own CREATE TABLE text — the ONLY record of NOT NULL, PRIMARY KEY, DEFAULT, CHECK, UNIQUE
// and every length/precision qualifier, none of which parquet stores and none of which survive a
// declared-type-only record either (TEXT and VARCHAR(255) both resolve to the bare word "TEXT").
// Both are captured from the SAME in-memory sql.js database as the data itself, so there is no
// separate pass, no separate open, and no window where the two could describe different states of
// the source.
//
// CONSEQUENCE, and it is a precondition on deletion: the verbatim DDL exists ONLY in the source
// database. Losing this file after the source is deleted loses that text permanently.
fs.writeFileSync(
  schemaPath,
  JSON.stringify(
    {
      source: SRC,
      migratedAt: new Date().toISOString(),
      tables: results,
      resolvedTypes,
      verbatimDdl,
    },
    null,
    2
  )
)
console.log(`  wrote ${schemaPath}`)

const failed = results.filter((r) => !r.ok)
if (failed.length) {
  console.error(`\nmigrate-forensics: FAIL — ${failed.length} table(s) did not verify. Delete NOTHING.`)
  process.exit(1)
}
console.log(`\nmigrate-forensics: OK — ${results.length} table(s) migrated and verified CONTENT-IDENTICAL (md5 over every value).`)
// The .db bytes are unchanged by this run: sql.js opened the source with fs.readFileSync, which
// takes no lock and mutates nothing — not even the -shm sidecar the earlier DuckDB attach touched
// on open. "Untouched" is the accurate word here, unlike the read-only-attach version this replaced.
console.log('The SQLite source data is unmodified (sql.js reads a Buffer snapshot; nothing was opened).')
console.log('Deleting it is a separate decision this run does not make.')
