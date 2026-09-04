import { DuckDBInstance } from '@duckdb/node-api'
import os from 'os'
const D = os.homedir() + '/.agentlens/store/forensics'
const DB = os.homedir() + '/.agentlens/forensics.db'
const c = await (await DuckDBInstance.create(':memory:')).connect()
const q = async (s) => (await (await c.run(s)).getRowObjectsJson())
await c.run('INSTALL sqlite; LOAD sqlite;')
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
