// Typed DuckDB views over the migrated parquet, so existing SQL can run against it UNCHANGED.
//
// The parquet is all-VARCHAR by necessity (see migrate-forensics-to-parquet.mjs: `api_calls.ts` is
// declared INTEGER and stores 1783602300487.7, which a typed scan refuses outright). Existing
// queries do `sum(a.cache_creation_tokens)` and `a.ts >= :since`, so something has to restore the
// types — and the obvious move, casting each column to the type `_schema.json` recorded, LOSES
// DATA.
//
// MEASURED: 5,217 of 14,285 `ts` values — 36.5% — carry a fractional part, and
// `CAST('1783602300487.7' AS BIGINT)` ROUNDS to 1783602300488. Honouring the declaration destroys
// sub-millisecond precision on more than a third of the rows, silently, with no error and no NULL.
//
// A NULL-counting check does not see this. The first version of this check asked "how many values
// become NULL under TRY_CAST" and reported zero across all 38 columns — because a rounded value is
// not a null one. The only check that catches it is a ROUND-TRIP: cast, render back to text, and
// compare to the original text. That is the rule below.
//
// So: a column adopts its declared type only if EVERY value survives the round trip. Otherwise it
// widens (BIGINT -> DOUBLE) or stays VARCHAR. The declared type is a hint here, never an
// instruction — which is the same lesson the migration learned when a typed scan aborted on this
// very column.
'use strict'
import { DuckDBInstance } from '@duckdb/node-api'
import fs from 'fs'
import os from 'os'
import path from 'path'

const DIR = process.env.FORENSICS_PARQUET_DIR || path.join(os.homedir(), '.agentlens', 'store', 'forensics')

/** Widening ladder: if the declared type does not round-trip, try these before giving up on VARCHAR.
 *
 *  REAL and FLOAT are the load-bearing entries and the reason this comment exists. SQLite's REAL is
 *  an 8-byte IEEE double; DuckDB's REAL is a 4-byte FLOAT. So casting a full-precision value to the
 *  type the source DECLARES silently drops ~9 significant digits, the round-trip check correctly
 *  rejects it — and without a widening entry the column fell all the way back to VARCHAR. That is
 *  not a cosmetic outcome: `sum(cost_usd)` then fails outright with "No function matches sum(VARCHAR)",
 *  so every cost query in forensicsSql.ts would break on the repoint. A type name that means
 *  different things in the two engines is exactly the kind of thing a declared type cannot be
 *  trusted for. */
const WIDER = {
  BIGINT: ['DOUBLE'],
  INTEGER: ['BIGINT', 'DOUBLE'],
  HUGEINT: ['DOUBLE'],
  DECIMAL: ['DOUBLE'],
  REAL: ['DOUBLE'],
  FLOAT: ['DOUBLE'],
  NUMERIC: ['DOUBLE'],
}

/**
 * Pick the narrowest type that loses nothing, per column.
 * Returns [{table, column, declared, chosen, reason}] — `chosen` is what the view will cast to.
 */
export async function planTypes(con, dir = DIR) {
  const schema = JSON.parse(fs.readFileSync(path.join(dir, '_schema.json'), 'utf8'))
  const q = async (s) => (await (await con.run(s)).getRowObjectsJson())
  const plan = []
  for (const [table, cols] of Object.entries(schema.resolvedTypes)) {
    const src = `read_parquet('${path.join(dir, `${table}.parquet`)}')`
    for (const { name, type } of cols) {
      const candidates = type === 'VARCHAR' ? [] : [type, ...(WIDER[type.replace(/\(.*/, '')] || [])]
      let chosen = 'VARCHAR'
      let reason = type === 'VARCHAR' ? 'already text' : 'no candidate round-tripped'
      for (const cand of candidates) {
        // VALUE preservation, not TEXT equality. Both are round-trips, and the difference matters:
        //   - text equality catches BIGINT ROUNDING a float ('...487.7' -> 487.7 lost). Good.
        //   - but it also REJECTS DOUBLE for a purely FORMATTING difference: '1783632781237'
        //     renders back as '1783632781237.0'. Same number, different text.
        // Measured: text equality reported 9,068 DOUBLE "failures" on `ts`, of which the number of
        // values actually changed was ZERO. That false rejection left `ts` as VARCHAR, which then
        // made `a.ts >= :since` — the ${TIME} predicate in nearly EVERY forensicsSql.ts preset —
        // fail to bind at all ("Cannot compare VARCHAR and INTEGER_LITERAL"). A check that is too
        // strict does not fail safe here; it silently makes the data unusable.
        // So: compare the candidate's value against the original parsed as DOUBLE. A cast that
        // changes the number is rejected; one that only changes the rendering is not.
        const bad = (
          await q(
            `SELECT count(*) AS n FROM ${src}
             WHERE "${name}" IS NOT NULL
               AND (TRY_CAST("${name}" AS ${cand}) IS NULL
                    OR TRY_CAST(TRY_CAST("${name}" AS ${cand}) AS DOUBLE)
                       IS DISTINCT FROM TRY_CAST("${name}" AS DOUBLE))`
          )
        )[0].n
        if (Number(bad) === 0) {
          chosen = cand
          reason = cand === type ? 'declared type round-trips' : `declared ${type} lost values; widened`
          break
        }
      }
      plan.push({ table, column: name, declared: type, chosen, reason })
    }
  }
  return plan
}

/** Create one view per table, casting each column to its planned type. SQL written for the SQLite
 *  schema then runs unchanged, because names and (safe) types match. */
export async function createViews(con, dir = DIR, plan = null) {
  const p = plan || (await planTypes(con, dir))
  const byTable = {}
  for (const r of p) (byTable[r.table] ||= []).push(r)
  for (const [table, cols] of Object.entries(byTable)) {
    const sel = cols
      .map((r) => (r.chosen === 'VARCHAR' ? `"${r.column}"` : `TRY_CAST("${r.column}" AS ${r.chosen}) AS "${r.column}"`))
      .join(', ')
    await con.run(
      `CREATE OR REPLACE VIEW "${table}" AS SELECT ${sel} FROM read_parquet('${path.join(dir, `${table}.parquet`)}')`
    )
  }
  return p
}

// CLI: print the plan, highlighting every column where the declared type had to be abandoned.
if (import.meta.url === `file://${process.argv[1]}`) {
  const con = await (await DuckDBInstance.create(':memory:')).connect()
  const plan = await createViews(con)
  const widened = plan.filter((r) => r.declared !== r.chosen && r.declared !== 'VARCHAR')
  for (const r of plan) {
    if (r.declared !== r.chosen) console.log(`${r.table}.${r.column}: declared ${r.declared} -> ${r.chosen}  (${r.reason})`)
  }
  console.log(`\n${plan.length} columns; ${widened.length} could NOT use the declared type without losing values.`)
  const rows = await (await con.run('SELECT count(*) AS n FROM api_calls')).getRowObjectsJson()
  console.log(`views usable: api_calls has ${rows[0].n} rows`)
}
