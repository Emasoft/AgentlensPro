// Does the migrated parquet answer the product's questions the way the product answers them today?
//
// THE REFERENCE SIDE IS sql.js, NOT DuckDB-reading-SQLite. That is the whole design, and it took
// three wrong versions to get here:
//
//   v1  typed DuckDB attach vs parquet. CRASHED the moment `ts` was tested — `api_calls.ts` is
//       DECLARED INTEGER and STORES 1783602300487.7, so a typed scan aborts. The oracle could not
//       read the column that carries the ${TIME} predicate in nearly every forensicsSql.ts query.
//   v2  DuckDB `all_varchar` attach vs parquet. Both sides text, same engine, same casts — it
//       proved DuckDB is deterministic, not that the parquet can replace the database.
//   v3  the same, after the migration switched to `printf('%!.20g')`. It began FAILING, and the
//       failure was the parquet being MORE CORRECT than its own reference:
//           min(ts):       sqlite 1783590196747.99   parquet 1783590196747.9863
//           sum(cost_usd): sqlite 3637.877679        parquet 3637.876389   (a $0.00129 gap)
//       because `all_varchar` routes REALs through SQLite's default 15-digit text conversion. An
//       oracle that reads its reference through a lossy path cannot certify a fix to that loss.
//
// So the reference is `sql.js` — the engine `forensicsDb.ts`/`forensicsSql.ts` actually use. Now a
// PASS means "a user would see the same numbers after the repoint", which is the only claim that
// justifies repointing anything.
//
// Values are normalised to strings on both sides before comparison, because sql.js returns JS
// numbers and DuckDB returns BigInt-as-string for integer aggregates; without that, a
// representation difference masquerades as a data difference and the oracle cries wolf.
'use strict'
import initSqlJs from 'sql.js'
import { DuckDBInstance } from '@duckdb/node-api'
import { createRequire } from 'module'
import fs from 'fs'
import os from 'os'
import path from 'path'

const SRC = process.env.FORENSICS_DB || path.join(os.homedir(), '.agentlens', 'forensics.db')
const DIR = process.env.FORENSICS_PARQUET_DIR || path.join(os.homedir(), '.agentlens', 'store', 'forensics')

const require = createRequire(import.meta.url)
const SQL = await initSqlJs({ locateFile: (f) => path.join(path.dirname(require.resolve('sql.js')), f) })
const db = new SQL.Database(fs.readFileSync(SRC))

const con = await (await DuckDBInstance.create(':memory:')).connect()
// Typed views over the parquet, built by the same planner the repoint will use — so this oracle
// tests the ACTUAL shape a reader would see, not a hand-written cast that happens to work.
const { createViews } = await import(path.join(path.dirname(new URL(import.meta.url).pathname), 'build-forensics-views.mjs'))
await createViews(con, DIR)

const norm = (rows) =>
  JSON.stringify(rows.map((o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === null ? null : String(v)]))))

// Query text is IDENTICAL on both sides. No `::BIGINT` sprinkled on the parquet side — if the views
// need a cast to answer a product query, that is a finding about the repoint, not something for the
// oracle to paper over.
const QUERIES = [
  ['injections by kind',
   `SELECT ci.kind, count(*) n, sum(a.cache_creation_tokens) cc FROM api_calls a JOIN call_injections ci ON ci.call_id=a.call_id GROUP BY 1 ORDER BY 1`],
  ['content by tag',
   `SELECT cc.tag, count(*) n, sum(cc.tokens) tok FROM api_calls a JOIN call_content cc ON cc.call_id=a.call_id GROUP BY 1 ORDER BY 1`],
  // TOLERANCE, and only here. Every other check demands exact equality. A sum of 4,061 doubles is
  // ORDER-DEPENDENT: sql.js accumulates left-to-right in JS, DuckDB vectorises and accumulates in
  // lanes, so the last ULPs differ by construction. That is arithmetic, not data — the per-value
  // comparison elsewhere proves every stored cost is byte-identical to the source.
  //
  // 1e-12, and the number is MEASURED, not guessed. The first version said 1e-9 "because the
  // measured divergence is ~3e-9" — which was wrong twice over: the real worst-case relative
  // divergence across all six models is 2.2e-15 (356.0504535 vs 356.0504534999999 is 3.2e-16
  // relative, not 1e-6), and a tolerance BELOW the claimed divergence could not have passed at all.
  // The stated justification and the stated number contradicted each other and both were wrong.
  // 1e-12 sits ~450x above the observed noise floor — loose enough that ULP jitter can never
  // redden it, and ~1,000,000x tighter than the 1e-9 it replaces, which would have waved through
  // a corruption of nearly a microdollar per dollar.
  ['cost by model (float sums, 1e-12 relative tolerance)',
   `SELECT a.model, count(*) n, sum(a.cost_usd) usd FROM api_calls a GROUP BY 1 ORDER BY 1`,
   null, { tolerant: ['usd'], rel: 1e-12 }],
  // The ${TIME} predicate every preset carries. v1 could not run this at all; leaving `ts` as
  // VARCHAR (an over-strict type planner) made it fail to BIND ("Cannot compare VARCHAR and
  // INTEGER_LITERAL"). It is here so neither regression can return silently.
  ['time window predicate (a.ts >= :since)',
   `SELECT count(*) n, min(a.ts) lo, max(a.ts) hi FROM api_calls a WHERE a.ts >= 1783000000000`],
  // An all-NULL column: sum() over it is NULL, not 0, and a column that became empty-string instead
  // of NULL would still hash identically in the migration while diverging here.
  ['all-NULL column (break_cause)',
   `SELECT count(*) n_rows, count(break_cause) non_null FROM api_calls a`],
  // CONTROL, and it is ABSOLUTE rather than comparative. Every other check tests AGREEMENT: a join
  // matching zero rows returns [] on both sides and prints MATCH. This one asserts the real numbers
  // measured when it was written, so "both sides equally broken" fails instead of passing.
  ['join cardinality (absolute)',
   `SELECT count(*) joined FROM api_calls a JOIN call_injections ci ON ci.call_id=a.call_id`,
   { joined: '48037' }],
]

/** Exact on every column except the named float aggregates, which compare within a relative
 *  tolerance. Shape, row count and every other value must still match exactly. */
const equalWithin = (left, right, tol) => {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) {
    const a = left[i], b = right[i]
    const keys = Object.keys(a)
    if (keys.length !== Object.keys(b).length) return false
    for (const k of keys) {
      if (tol.tolerant.includes(k)) {
        const x = Number(a[k]), y = Number(b[k])
        if (!Number.isFinite(x) || !Number.isFinite(y)) return String(a[k]) === String(b[k])
        if (Math.abs(x - y) > tol.rel * Math.max(Math.abs(x), Math.abs(y), 1e-12)) return false
      } else if (String(a[k]) !== String(b[k])) return false
    }
  }
  return true
}

let bad = 0
for (const [name, Q, absolute, tol] of QUERIES) {
  const r = db.exec(Q)[0]
  const left = r ? r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : []
  let right
  try {
    right = await (await con.run(Q)).getRowObjectsJson()
  } catch (e) {
    bad++
    console.log(`ERROR  ${name}: parquet side failed to run the product's own query — ${String(e.message).split('\n')[0]}`)
    continue
  }
  const ok = tol ? equalWithin(left, right, tol) : norm(left) === norm(right)
  if (!ok) {
    bad++
    console.log(`DIFFER ${name}\n  sql.js : ${norm(left).slice(0, 260)}\n  parquet: ${norm(right).slice(0, 260)}`)
  } else if (absolute) {
    // Comparative agreement is not enough for the control — check the value itself.
    const got = Object.fromEntries(Object.entries(left[0] || {}).map(([k, v]) => [k, String(v)]))
    const wrong = Object.entries(absolute).filter(([k, want]) => got[k] !== want)
    if (wrong.length) {
      bad++
      console.log(`DIFFER ${name} (absolute): expected ${JSON.stringify(absolute)}, got ${JSON.stringify(got)}`)
    } else console.log(`MATCH  ${name}  (absolute check ok)`)
  } else console.log(`MATCH  ${name}  (${left.length} rows)`)
}

console.log(
  bad
    ? `FAIL: ${bad} check(s) differ — the parquet does NOT yet answer as the product does`
    : 'PASS: the product path (sql.js over forensics.db) and the parquet path return identical results'
)
process.exit(bad ? 1 : 0)
