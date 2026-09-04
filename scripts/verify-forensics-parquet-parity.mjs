import { DuckDBInstance } from '@duckdb/node-api'
import os from 'os'
const D = os.homedir() + '/.agentlens/store/forensics'
const DB = os.homedir() + '/.agentlens/forensics.db'
const c = await (await DuckDBInstance.create(':memory:')).connect()
const q = async (s) => (await (await c.run(s)).getRowObjectsJson())
// all_varchar on the SQLITE side too, so both sides are compared like-for-like: text in, cast out.
//
// This was NOT the first version, and the reason it changed is worth keeping. Attached typed, the
// SQLite side cannot read `api_calls.ts` AT ALL — DuckDB aborts with "column was declared as
// integer, found 1783602300487.7 of type float". So the first three checks were comparing TYPED
// SQLite values against TEXT parquet values cast back, which is a real comparison but not the one
// this oracle claims to make, and it silently could not cover the one column most likely to break.
//
// Note what that error also establishes: DuckDB's typed sqlite reader is STRICTER than `sql.js`,
// which is dynamically typed and reads that float without complaint. So "the product reads it
// today" does not imply "a typed DuckDB reader can". Any repointing must go through the text
// representation, which is exactly what the parquet holds — the all_varchar choice was not merely
// convenient, it is the only shape that can carry this database.
await c.run('SET sqlite_all_varchar=true;')
await c.run(`ATTACH '${DB}' AS ro (TYPE sqlite, READ_ONLY)`)
const P = (t) => `read_parquet('${D}/${t}.parquet')`
const checks = [
  ['injections by kind',
   (a, x) => `SELECT ci.kind, count(*) AS n, sum(a.cache_creation_tokens::BIGINT) AS cc FROM ${a} a JOIN ${x} ci ON ci.call_id=a.call_id GROUP BY 1 ORDER BY 1`,
   ['api_calls', 'call_injections']],
  ['content by tag',
   (a, x) => `SELECT cc.tag, count(*) AS n, sum(cc.tokens::BIGINT) AS tok FROM ${a} a JOIN ${x} cc ON cc.call_id=a.call_id GROUP BY 1 ORDER BY 1`,
   ['api_calls', 'call_content']],
  ['cost by model',
   (a) => `SELECT a.model, count(*) AS n, round(sum(a.cost_usd::DOUBLE),4) AS usd FROM ${a} a GROUP BY 1 ORDER BY 1`,
   ['api_calls']],
  // THE HARD CASES. The three above touch only 100%-populated columns and clean casts — the easy
  // path, and a parity suite that tests only the easy path is how a migration ships broken.
  //
  // `ts` is the column that broke a typed scan outright: declared INTEGER, stores 1783602300487.7.
  // Under all_varchar the parquet side holds the TEXT of that float, so `::BIGINT` has to survive a
  // decimal point that a genuine integer column would never contain. This is the single most likely
  // place the VARCHAR round-trip diverges, and it is exactly what the content hash cannot see: the
  // hash compares stored text, not what a cast makes of it.
  ['ts round-trip (declared INTEGER, stores a float)',
   (a) => `SELECT count(*) AS n, min(ts::DOUBLE) AS lo, max(ts::DOUBLE) AS hi, count(DISTINCT ts) AS distinct_ts FROM ${a} a`,
   ['api_calls']],
  // A column that is 0% populated. NULL is encoded as chr(1) by the migration's hash, so the hash
  // proves the NULLs are all still there — but not that an aggregate over an entirely-NULL column
  // behaves the same on both sides. `sum()` over all-NULL is NULL, not 0, and a VARCHAR column that
  // silently became empty-string instead of NULL would still hash identically while making count()
  // and sum() disagree here.
  ['all-NULL column aggregates (break_cause, 0% populated)',
   (a) => `SELECT count(*) AS rows, count(break_cause) AS non_null, count(DISTINCT break_cause) AS distinct_vals FROM ${a} a`,
   ['api_calls']],
  // DECIMAL, not DOUBLE. Float summation is order-dependent and DuckDB may parallelise the parquet
  // scan differently from the sqlite scan, so `round(sum(x::DOUBLE),4)` above proves "agrees to
  // 4dp", not "identical" — the rounding is doing real work and hiding exactly the reordering noise
  // that lives below 5e-5. DECIMAL summation is exact and order-independent, so a difference HERE
  // is a real difference. It is also simply the right type for money.
  ['cost sum, exact (DECIMAL — order-independent, unlike DOUBLE)',
   (a) => `SELECT sum(a.cost_usd::DECIMAL(18,6)) AS usd, sum(a.input_tokens::BIGINT) AS inp FROM ${a} a`,
   ['api_calls']],
  // The CONTROL for the join checks above. `JSON.stringify(sqlite)===JSON.stringify(parquet)` tests
  // AGREEMENT, not correctness: a join matching zero rows returns [] on both sides and prints
  // MATCH. So assert the join preserves cardinality rather than trusting that it did.
  // Measured when this was added: 48,037 injection rows, 48,037 joined — nothing dropped. And
  // `kind` genuinely has 2 distinct values (mcp 46,162 / skill 1,875) read straight off the base
  // table with no join, which is why the grouped query returning 2 groups is correct and not a
  // symptom. Worth knowing separately: `forensicsSql.ts` also queries `kind='rule'`, and this
  // database contains none — a product fact, not a migration defect.
  ['join cardinality control (injections must not be dropped)',
   (a, x) => `SELECT (SELECT count(*) FROM ${x}) AS inj_rows, (SELECT count(DISTINCT kind) FROM ${x}) AS kinds, (SELECT count(*) FROM ${a} a JOIN ${x} ci ON ci.call_id=a.call_id) AS joined FROM ${a} LIMIT 1`,
   ['api_calls', 'call_injections']],
]
let bad = 0
for (const [name, mk, tabs] of checks) {
  const s = await q(mk(...tabs.map((t) => `ro.${t}`)))
  const p = await q(mk(...tabs.map(P)))
  const ok = JSON.stringify(s) === JSON.stringify(p)
  if (!ok) { bad++; console.log(`DIFFER ${name}\n  sqlite : ${JSON.stringify(s)}\n  parquet: ${JSON.stringify(p)}`) }
  else console.log(`MATCH  ${name}  (${s.length} groups)`)
}
console.log(bad ? `FAIL: ${bad} query/queries differ` : 'PASS: parquet answers real product-shaped queries identically to SQLite')
process.exit(bad ? 1 : 0)
// WHY THIS EXISTS, and why it is not the migration's content hash:
//
// The hash proves the parquet holds the same VALUES as forensics.db. It cannot prove the parquet
// can ANSWER the questions the product asks — and after `all_varchar=true` every column is text, so
// every numeric aggregate goes through a cast that exists only on the parquet side. A migration
// that hashes clean and cannot serve a JOIN with a SUM is a migration nobody can switch to.
//
// So these are product-SHAPED queries, run both ways and compared: a JOIN across two migrated
// tables on call_id with an aggregate (twice, in the shape forensicsSql.ts uses) and a GROUP BY
// with a rounded currency sum. They are the precondition for repointing any reader, and they are
// what makes `forensics.db` deletable rather than merely copied.
