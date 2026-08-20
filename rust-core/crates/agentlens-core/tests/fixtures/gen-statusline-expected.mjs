// Regenerates statusline-expected.json + the statusline-tree store fixture. The fixture store
// is WRITTEN AND SEALED by the COMPILED TS statuslineStore.js — the cross-engine law: both
// engines write this store, so a TS-sealed parquet part + a live TS WAL must read identically
// through the Rust query path (partition walk, per-file VARCHAR session_id repair, guaranteed
// columns, ts ordering). The WAL deliberately carries ONLY UUID-shaped session ids (DuckDB
// infers them as the UUID type) while the sealed part holds a non-UUID id — the exact union
// crash the per-file cast exists to repair; the query only succeeds if the repair works in the
// Rust reader too. Ids are visibly fake (fixture law).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-statusline-expected.mjs
import { createRequire } from 'module'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
const require = createRequire(import.meta.url)
const { StatuslineStore, flattenSample, dayKey, queryStatusline } = require('../../../../../out/test/statuslineStore.js')
const dir = new URL('.', import.meta.url).pathname
const root = join(dir, 'statusline-tree')

const NOW = 1787000000000
const J = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x)))

// ── Pure-function cases (flattenSample / dayKey) ───────────────────────────────────────────
const flattenCases = [
  { name: 'nested objects to dotted keys', v: { a: 1, b: { c: 2, d: { e: 'x' } } } },
  { name: 'arrays stay lists', v: { tasks: [{ id: 'aa' }, { id: 'bb' }], n: null, ok: true } },
  { name: 'empty object vanishes', v: { a: {}, b: 1 } },
  { name: 'null is a scalar not an object', v: { a: null, b: { c: null } } },
]
const pure = {
  flatten: flattenCases.map((c) => J(flattenSample(c.v))),
  dayKey: [J(dayKey(NOW)), J(dayKey(0))],
}

// ── The cross-engine store fixture ─────────────────────────────────────────────────────────
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })
process.env.AGENTLENS_STATUSLINE_SEAL_ROWS = '1' // seal everything buffered so far
const store = new StatuslineStore({ root, autoTimer: false })
const sample = (sid, over = {}) => ({
  session_id: sid,
  model: { id: 'claude-opus-5', display_name: 'Opus' },
  context_window: { used_percentage: 41.5, total_input_tokens: 120000 },
  cost: { total_cost_usd: 1.25 },
  workspace: { project_dir: '/tmp/insws' },
  ...over,
})
// Sealed part: a NON-UUID id + a fake-UUID id + one sample carrying the optional rate_limits
// block (the guaranteed-columns contract: the other rows answer NULL for it, never a binder error).
store.append(sample('not-a-uuid-id'), 'main', NOW - 60_000)
store.append(sample('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', { rate_limits: { five_hour: { used_percentage: 55 } } }), 'main', NOW - 50_000)
store.flush()
// Subagent stream: tasks[] stays a LIST through seal.
store.append({ session_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', cwd: '/tmp/insws', tasks: [{ name: 'a' }, { name: 'b' }] }, 'subagent', NOW - 40_000)
store.flush()
await store.maybeSeal(NOW)
// The live WAL (never sealed here): ONLY UUID-shaped ids — the inference trap side.
delete process.env.AGENTLENS_STATUSLINE_SEAL_ROWS
store.append(sample('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), 'main', NOW - 30_000)
store.flush()

const MAIN_SQL = 'SELECT session_id, model_id, context_window_used_percentage, rate_limits_five_hour_used_percentage, ts FROM samples ORDER BY ts'
const SUB_SQL = 'SELECT session_id, len(tasks) AS n_tasks, ts FROM samples ORDER BY ts'
const queries = {
  main: J(await queryStatusline(root, 'main', MAIN_SQL)),
  subagent: J(await queryStatusline(root, 'subagent', SUB_SQL)),
  // sinceMs ONLY: record ts (the fixed NOW) and partition day (the REGENERATION day) disagree
  // by more than the 1-day slack, so an untilMs near NOW would exclude the whole partition and
  // honestly answer BLIND — the documented write-day-vs-record-ts skew, not a bug.
  windowed: J(await queryStatusline(root, 'main', 'SELECT count(*) AS c FROM samples', { sinceMs: NOW - 55_000 })),
  blindStream: await queryStatusline(join(dir, 'no-such-tree'), 'main', 'SELECT 1'),
}

writeFileSync(join(dir, 'statusline-expected.json'), JSON.stringify({
  flattenCases: J(flattenCases), pure, mainSql: MAIN_SQL, subSql: SUB_SQL,
  now: NOW, queries,
}, null, 1))
console.log(`statusline-expected.json: main ${queries.main.length} rows, subagent ${queries.subagent.length}, windowed ${JSON.stringify(queries.windowed)}`)
