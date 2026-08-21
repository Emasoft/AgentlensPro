// Regenerates the forensicssql fixture DB AND forensicssql-expected.json from the COMPILED
// src/forensicsSql.ts — the parity oracle for run_diagnostics_sql (TRDD-DMWOBWFH).
//
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-forensicssql-expected.mjs
//
// THE FACT ROWS ARE WRITTEN DIRECTLY, not produced by the indexer. run_diagnostics_sql is a SHAPER
// over the fact tables — what it must reproduce is how it QUERIES and RENDERS them, so the fixture
// is chosen to exercise every preset (each injection kind, a content tag, a null spawn_kind, an
// output spike, a break cause, both cache tiers) rather than to re-test the indexer, which
// forensicsindexer_parity already pins.
//
// EVERY VALUE HERE IS TIME-INDEPENDENT. `cost_usd` resolves rates through calcTokenCostUsd against
// Date.now() with no seam, so the fixture uses only claude-opus-5 / claude-mythos-5 — never
// claude-sonnet-5, the one model carrying a `scheduledChange` (its introductory pricing ends
// 2026-08-31, which would silently change this oracle's numbers on 2026-09-01). For the same reason
// no case relies on the exact value of a `window`-derived `:since`: the one window case uses a span
// so wide that every row is inside it on both sides of the port.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '../../../../../out/test')
const { runDiagnosticsSql, PRESETS } = await import(path.join(OUT, 'forensicsSql.js'))
const { openForensicsDb } = await import(path.join(OUT, 'forensicsDb.js'))

const ROOT = path.join(HERE, 'forensicssql')
fs.rmSync(ROOT, { recursive: true, force: true })
fs.mkdirSync(ROOT, { recursive: true })
const DB = path.join(ROOT, 'forensics.db')
const MISSING_DB = path.join(ROOT, 'no-such-forensics.db')

const BASE = 1_760_000_000_000
const MIN = 60_000
const AT = BASE // indexed_at, pinned so no Date.now() reaches the file

// A 700-char value: longer than MAX_CELL_CHARS (500), so selecting it proves the cell truncation.
const LONG_FP = 'fp'.repeat(350)

// call_id, ts, session, account, model, effort, spawn_kind, subagent, override, isolation,
// sidechain, parent, resolution, in, out, cread, ccreate, t5m, t1h, cause, culprit, gap, fmfp
const CALLS = [
  ['c1', BASE - 9 * MIN, 'sess-a', 'acct-1', 'claude-opus-5', 'high', 'fork', 'spark', null, 'none', 0, 'sess-root', 'direct', 100, 500, 3000, 1000, 600, 400, 'MODEL_SWITCHED', 'fp-a', 3.5, 'fm-1'],
  ['c2', BASE - 8 * MIN, 'sess-a', 'acct-1', 'claude-opus-5', 'high', 'fresh', 'spark', null, 'none', 1, 'sess-root', 'direct', 120, 200, 100, 5000, 5000, 0, 'MODEL_SWITCHED', 'fp-a', 61, 'fm-1'],
  ['c3', BASE - 7 * MIN, 'sess-b', 'acct-1', 'claude-mythos-5', 'low', 'worktree', 'kraken', 'claude-opus-5', 'worktree', 1, 'sess-root', 'direct', 90, 100, 50, 20000, 0, 20000, 'TOOLS_CHANGED', 'fp-b', 0.5, 'fm-2'],
  // No spawn attribution at all: the 'unresolved' bucket every honesty check looks for.
  ['c4', BASE - 6 * MIN, 'sess-b', null, null, null, null, null, null, null, 0, null, 'unresolved', 10, 8000, 0, 10, 0, 0, null, null, null, null],
  ['c5', BASE - 5 * MIN, 'sess-c', 'acct-2', 'claude-opus-5', 'none', 'fork', null, null, 'none', 0, 'sess-root', 'direct', 40, 50, 900, 300, 300, 0, 'UNCLASSIFIED', null, 12, 'fm-1'],
  ['c6', BASE - 4 * MIN, null, 'acct-2', 'claude-opus-5', 'high', 'fresh', 'spark', null, 'none', 1, null, 'heuristic', 70, 60, 20, 800, 800, 0, null, null, null, 'fm-3'],
  ['c7', BASE - 3 * MIN, 'sess-c', 'acct-2', 'claude-opus-5', 'high', 'root', null, null, 'none', 0, null, 'direct', 55, 40, 15, 400, 400, 0, null, null, null, 'fm-1'],
  ['c8', BASE - 2 * MIN, 'sess-d', 'acct-1', 'claude-mythos-5', 'low', 'worktree', 'kraken', null, 'worktree', 1, 'sess-root', 'direct', 30, 30, 5, 60000, 0, 60000, null, null, null, 'fm-2'],
  // Carries the over-long frontmatter fingerprint — nothing else selects it, so only the explicit
  // truncation case sees it.
  ['c9', BASE - 1 * MIN, 'sess-d', 'acct-1', 'claude-opus-5', 'high', 'fork', null, null, 'none', 0, null, 'direct', 5, 5, 5, 5, 5, 0, null, null, null, LONG_FP],
]

const INJECTIONS = [
  ['c1', 'skill', 'agentlenspro-diagnostics', 1200],
  ['c1', 'mcp', 'chrome-devtools', 800],
  ['c1', 'rule', 'commit-discipline', 300],
  ['c2', 'skill', 'agentlenspro-diagnostics', 1200],
  ['c2', 'rule', 'commit-discipline', 300],
  ['c3', 'skill', 'rust', 500],
  ['c3', 'mcp', 'chrome-devtools', 800],
  // The output-spike row carries a skill, so output_peaks_by_skill has something to rank.
  ['c4', 'skill', 'agentlenspro-diagnostics', 1200],
  ['c5', 'rule', 'never-git-add-all', 100],
]

const CONTENT = [
  ['c1', 'image', 3252, 1],
  ['c3', 'image', 6504, 2],
  ['c4', 'transcript', 900, 1],
  ['c8', 'toolresult', 40, 3],
]

const STATE = [
  ['responses_indexed', '9'],
  ['responses_total', '11'],
  ['last_run_ms', String(BASE)],
  ['coverage_note', 'fixture — 9 of 11 responses indexed'],
]

const fdb = await openForensicsDb(DB)
const raw = fdb.raw
const AC_COLS = `call_id, response_ref, request_ref, ts, session_id, account_uuid, model, effort,
  spawn_kind, subagent_type, spawn_model_override, spawn_isolation, is_sidechain, parent_session, spawn_resolution,
  input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, tier_5m_tokens, tier_1h_tokens,
  break_cause, culprit_fingerprint, gap_minutes, frontmatter_fp, cost_usd, billable_weight, indexed_at`
for (const c of CALLS) {
  const [id, ts, sess, acct, model, effort, kind, sub, ovr, iso, side, parent, res, i, o, cr, cc, t5, t1, cause, culprit, gap, fm] = c
  raw.run(`INSERT INTO api_calls (${AC_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    id, `resp/${id}.json`, `req/${id}.json`, ts, sess, acct, model, effort,
    kind, sub, ovr, iso, side, parent, res,
    i, o, cr, cc, t5, t1,
    cause, culprit, gap, fm, 0, 0, AT,
  ])
}
// cost_usd / billable_weight through the DB's OWN custom fns — the same numbers the port must
// reproduce, and it proves the fns are registered on a writable handle too.
raw.run(`UPDATE api_calls SET
  cost_usd = cost_usd(input_tokens, cache_read_tokens, cache_creation_tokens, output_tokens, model),
  billable_weight = billable_weight(tier_5m_tokens, tier_1h_tokens, cache_read_tokens, output_tokens, input_tokens, model)`)
for (const [id, kind, name, tok] of INJECTIONS) {
  raw.run('INSERT INTO call_injections (call_id, kind, name, tokens) VALUES (?,?,?,?)', [id, kind, name, tok])
}
for (const [id, tag, tok, n] of CONTENT) {
  raw.run('INSERT INTO call_content (call_id, tag, tokens, count) VALUES (?,?,?,?)', [id, tag, tok, n])
}
for (const [k, v] of STATE) {
  raw.run('INSERT INTO index_state (k, v) VALUES (?,?)', [k, v])
}
fdb.save()
fdb.close()

// FORENSICS_SCHEMA_SQL opens with `PRAGMA journal_mode = WAL`, and sql.js stamps that into the
// exported header (bytes 18/19 = the file-format write/read version; 2 means WAL). A COMMITTED
// fixture must not be WAL: opening one makes SQLite create `-shm`/`-wal` sidecars next to it, which
// then show up as untracked files after every test run — and on a read-only checkout the open FAILS
// outright, because a WAL database cannot be read without writing its shared-memory file. This
// serialization has no WAL frames, so resetting the two bytes to 1 is exactly what
// `PRAGMA journal_mode = DELETE` would do, and it is the only way to reach the header from sql.js
// (the pragma is a no-op against an in-memory database).
const bytes = fs.readFileSync(DB)
bytes[18] = 1
bytes[19] = 1
fs.writeFileSync(DB, bytes)

// ── the case matrix ─────────────────────────────────────────────────────────────
const cases = [
  { name: 'list_presets', opts: {} },
  ...Object.keys(PRESETS).map((p) => ({ name: `preset_${p}`, opts: { preset: p } })),

  // Parameter paths.
  { name: 'params_min_count_2', opts: { preset: 'cache_by_skill', params: { minCount: 2 } } },
  { name: 'params_chronic_min_count_2', opts: { preset: 'chronic_offenders', params: { minCount: 2 } } },
  { name: 'params_mult_k2', opts: { preset: 'unclassified_events', params: { k: 2 } } },
  { name: 'params_mult_raw', opts: { preset: 'unclassified_events', params: { mult: 2 } } },
  // A non-numeric minCount is REPLACED by the default 3, not passed through.
  { name: 'params_min_count_bogus', opts: { preset: 'cache_by_skill', params: { minCount: 'two' } } },
  // The mcp/rule lift presets return nothing at the default minCount of 3; these are the variants
  // that actually exercise their JOIN + lift arithmetic.
  { name: 'params_cache_by_mcp_min2', opts: { preset: 'cache_by_mcp', params: { minCount: 2 } } },
  { name: 'params_cache_by_rule_min2', opts: { preset: 'cache_by_rule', params: { minCount: 2 } } },
  { name: 'params_explicit_since', opts: { preset: 'session_hotlist', params: { since: BASE - 4 * MIN } } },
  // window > 0 derives :since from Date.now(); the span is wide enough that the cutoff cannot
  // change which rows qualify on either side of the port.
  { name: 'params_window_wide', opts: { preset: 'session_hotlist', params: { window: 1_000_000 } } },
  // window: 0 is FALSY — it falls through to `user.since ?? null` rather than meaning "now".
  { name: 'params_window_zero', opts: { preset: 'session_hotlist', params: { window: 0, since: BASE - 4 * MIN } } },

  // Formats.
  { name: 'format_table', opts: { preset: 'fork_vs_fresh', format: 'table' } },
  { name: 'format_markdown', opts: { preset: 'fork_vs_fresh', format: 'markdown' } },
  { name: 'format_table_empty', opts: { sql: 'SELECT call_id FROM api_calls WHERE 0', format: 'table' } },
  { name: 'format_markdown_empty', opts: { sql: 'SELECT call_id FROM api_calls WHERE 0', format: 'markdown' } },
  // '🔥' is ONE char and TWO UTF-16 units. The column is 1 unit wide and the floor is 3, so the
  // pad is 1 space under JS semantics and 2 under a char-counting port — the cheapest possible
  // discriminator for the padEnd unit.
  { name: 'format_table_astral', opts: { sql: "SELECT '🔥' AS e, 'ascii' AS b, 1.5 AS n, 7 AS i, NULL AS z", format: 'table' } },
  { name: 'format_markdown_astral', opts: { sql: "SELECT '🔥' AS e, 'ascii' AS b, 1.5 AS n, 7 AS i, NULL AS z", format: 'markdown' } },

  // Raw SQL.
  { name: 'raw_select', opts: { sql: 'SELECT call_id, model, cache_creation_tokens FROM api_calls ORDER BY call_id' } },
  { name: 'raw_with_cte', opts: { sql: 'WITH t AS (SELECT call_id AS c FROM api_calls) SELECT c FROM t ORDER BY c' } },
  { name: 'raw_trailing_semicolon', opts: { sql: 'SELECT 1 AS one;' } },
  { name: 'raw_block_comment_stripped', opts: { sql: 'SELECT 1 AS one /* DROP TABLE api_calls */' } },
  { name: 'raw_custom_fns', opts: { sql: `SELECT call_id, tier_classify(gap_minutes) AS tier,
      spike(cache_creation_tokens, 1000, 2) AS sp,
      billable_weight(tier_5m_tokens, tier_1h_tokens, cache_read_tokens, output_tokens, input_tokens, model) AS bw,
      cost_usd(input_tokens, cache_read_tokens, cache_creation_tokens, output_tokens, model) AS cost
      FROM api_calls ORDER BY call_id` } },
  // ':notaparam' sits inside a string literal, so SQLite never exposes it as a parameter — the
  // regex finds it and the bind must SKIP it rather than fail.
  { name: 'raw_param_in_string_literal', opts: { sql: "SELECT ':notaparam' AS s, :since AS since", params: { since: 42 } } },
  // A :name the pool has no entry for binds NULL.
  { name: 'raw_unknown_param_binds_null', opts: { sql: 'SELECT :nosuch AS v' } },
  { name: 'raw_cell_truncation', opts: { sql: "SELECT call_id, frontmatter_fp FROM api_calls WHERE call_id = 'c9'" } },
  { name: 'raw_query_failure', opts: { sql: 'SELECT no_such_column FROM api_calls' } },

  // Row cap.
  { name: 'cap_default_no_note', opts: { sql: 'SELECT call_id FROM api_calls ORDER BY call_id' } },
  { name: 'cap_three', opts: { sql: 'SELECT call_id FROM api_calls ORDER BY call_id', limit: 3 } },
  { name: 'cap_zero_clamps_to_one', opts: { sql: 'SELECT call_id FROM api_calls ORDER BY call_id', limit: 0 } },
  { name: 'cap_above_hard_max', opts: { sql: 'SELECT call_id FROM api_calls ORDER BY call_id', limit: 99999 } },

  // The statement gate.
  { name: 'gate_blank', opts: { sql: '   ' } },
  { name: 'gate_comment_only', opts: { sql: '-- nothing here' } },
  { name: 'gate_two_statements', opts: { sql: 'SELECT 1; SELECT 2' } },
  { name: 'gate_not_a_select', opts: { sql: 'EXPLAIN SELECT 1' } },
  { name: 'gate_delete', opts: { sql: 'DELETE FROM api_calls' } },
  // REPLACE is a scalar FUNCTION here, not DML — the gate rejects it anyway. Pinned because it is
  // a deliberate false positive, not an oversight.
  { name: 'gate_replace_function', opts: { sql: "SELECT replace(model,'a','b') FROM api_calls" } },
  // `pragma_table_info` does NOT trip \bPRAGMA\b — `_` is a word character, so there is no boundary
  // after the keyword. The gate is lexical, not semantic; pinned so the port keeps that shape. Also
  // proves the line-comment strip (the `-- x` swallows nothing but itself).
  { name: 'gate_pragma_prefixed_identifier_passes', opts: { sql: 'SELECT 1 FROM api_calls WHERE 1 = (SELECT 1) AND 1 -- x\nUNION SELECT 1 FROM pragma_table_info' } },

  // Mode errors.
  { name: 'mode_unknown_preset', opts: { preset: 'no_such_preset' } },
  { name: 'mode_both_preset_and_sql', opts: { preset: 'schema', sql: 'SELECT 1' } },
  // Empty strings are FALSY, so this is the no-args list, not "the preset named ''".
  { name: 'mode_empty_strings_list', opts: { preset: '', sql: '' } },

  // DB unavailable.
  { name: 'db_missing_preset', opts: { preset: 'schema', forensicsDbPath: MISSING_DB } },
  { name: 'db_missing_raw', opts: { sql: 'SELECT 1', forensicsDbPath: MISSING_DB } },
]

const results = {}
for (const c of cases) {
  results[c.name] = await runDiagnosticsSql({ forensicsDbPath: DB, ...c.opts })
}

const out = { note: 'oracle for run_diagnostics_sql — generated, do not hand-edit', longFpLength: LONG_FP.length, cases: results }
// No absolute path should reach the file; tokenize the fixture root anyway so a future case that
// echoes a path cannot commit this checkout's home directory.
const json = JSON.stringify(out, null, 2).split(JSON.stringify(ROOT).slice(1, -1)).join('<FIX>')
fs.writeFileSync(path.join(HERE, 'forensicssql-expected.json'), `${json}\n`)
console.log(`wrote forensicssql-expected.json — ${Object.keys(results).length} cases`)
