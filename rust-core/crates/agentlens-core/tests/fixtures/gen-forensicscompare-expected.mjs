// Regenerates forensicscompare-expected.json from the COMPILED src/forensicsCompare.ts — the
// parity oracle for compare_configs (TRDD-DMWOBWFH).
//
// Run from the repo root AFTER `pnpm run compile-tests` AND AFTER
// gen-forensicssql-expected.mjs — that generator OWNS the fixture DB (writes the fact rows,
// rm -rf's the forensicssql/ dir first). This file only READS forensics.db; running it first
// would either crash on a missing DB or silently score against stale fact rows, so the missing
// case throws a message naming the required order rather than producing an empty oracle.
//
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-forensicssql-expected.mjs
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-forensicscompare-expected.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '../../../../../out/test')
const { buildCompareConfigs } = await import(path.join(OUT, 'forensicsCompare.js'))

const ROOT = path.join(HERE, 'forensicssql')
const DB = path.join(ROOT, 'forensics.db')
const MISSING_DB = path.join(ROOT, 'no-such-forensics.db')

if (!fs.existsSync(DB)) {
  throw new Error(
    `forensics.db missing at ${DB} — run gen-forensicssql-expected.mjs FIRST, it owns this fixture DB`,
  )
}

// ── the case matrix ─────────────────────────────────────────────────────────────
// THIS LIST IS THE SOURCE OF TRUTH. tests/forensicscompare_parity.rs transcribes it and asserts
// both sides are the same SIZE, so a case added here and forgotten there fails loudly instead of
// going quietly untested.
const cases = [
  { name: 'defaults', opts: {} },
  { name: 'group_model', opts: { groupBy: 'model' } },
  { name: 'group_effort', opts: { groupBy: 'effort' } },
  { name: 'group_isolation', opts: { groupBy: 'isolation' } },
  { name: 'group_subagent_type', opts: { groupBy: 'subagent_type' } },
  { name: 'group_frontmatter', opts: { groupBy: 'frontmatter' } },
  { name: 'group_break_cause', opts: { groupBy: 'break_cause' } },
  { name: 'group_account', opts: { groupBy: 'account' } },
  { name: 'group_session', opts: { groupBy: 'session' } },
  { name: 'group_skill', opts: { groupBy: 'skill' } },
  { name: 'group_mcp', opts: { groupBy: 'mcp' } },
  { name: 'group_rule', opts: { groupBy: 'rule' } },
  { name: 'group_content_tag', opts: { groupBy: 'content_tag' } },
  { name: 'metric_cache_read', opts: { metric: 'cache_read' } },
  { name: 'metric_output_tokens', opts: { metric: 'output_tokens' } },
  { name: 'metric_input_tokens', opts: { metric: 'input_tokens' } },
  { name: 'metric_total', opts: { metric: 'total' } },
  { name: 'metric_billable_weighted', opts: { metric: 'billable_weighted' } },
  { name: 'metric_breaks', opts: { metric: 'breaks' } },
  { name: 'agg_sum', opts: { agg: 'sum' } },
  { name: 'agg_median', opts: { agg: 'median' } },
  { name: 'agg_min', opts: { agg: 'min' } },
  { name: 'agg_max', opts: { agg: 'max' } },
  { name: 'agg_p95', opts: { agg: 'p95' } },
  { name: 'agg_count', opts: { agg: 'count' } },
  { name: 'rank_best_first', opts: { rankOrder: 'best-first' } },
  { name: 'top_n_two', opts: { topN: 2 } },
  { name: 'top_n_zero_clamps_to_one', opts: { topN: 0 } },
  { name: 'top_n_above_max', opts: { topN: 9999 } },
  { name: 'filter_model', opts: { filter: { model: 'claude-opus-5' } } },
  { name: 'filter_spawn_kind', opts: { filter: { spawnKind: 'fork' } } },
  { name: 'filter_subagent_type', opts: { filter: { subagentType: 'spark' } } },
  { name: 'filter_effort', opts: { filter: { effort: 'high' } } },
  { name: 'filter_isolation', opts: { filter: { isolation: 'worktree' } } },
  { name: 'filter_account', opts: { filter: { accountUuid: 'acct-1' } } },
  { name: 'filter_session', opts: { filter: { sessionId: 'sess-a' } } },
  { name: 'filter_break_cause', opts: { filter: { breakCause: 'MODEL_SWITCHED' } } },
  { name: 'filter_spawn_resolution', opts: { filter: { spawnResolution: 'unresolved' } } },
  { name: 'filter_min_cache_create', opts: { filter: { minCacheCreate: 1000 } } },
  { name: 'filter_min_output_tokens', opts: { filter: { minOutputTokens: 100 } } },
  { name: 'filter_empty_string_ignored', opts: { filter: { model: '' } } },
  { name: 'filter_window_zero_ignored', opts: { filter: { window: 0 } } },
  // Spans ~114 years so the Date.now()-derived cutoff can't change which rows qualify on either
  // side of the port — same discipline as gen-forensicssql-expected.mjs's params_window_wide.
  { name: 'filter_window_wide', opts: { filter: { window: 1_000_000 } } },
  { name: 'filter_has_skill', opts: { filter: { hasSkill: ['agentlenspro-diagnostics'] } } },
  { name: 'filter_has_skill_multi', opts: { filter: { hasSkill: ['agentlenspro-diagnostics', 'rust'] } } },
  { name: 'filter_has_mcp', opts: { filter: { hasMcp: ['chrome-devtools'] } } },
  { name: 'filter_has_rule', opts: { filter: { hasRule: ['commit-discipline', 'never-git-add-all'] } } },
  { name: 'filter_has_content_tag', opts: { filter: { hasContentTag: ['image'] } } },
  {
    name: 'filter_combined',
    opts: { filter: { model: 'claude-opus-5', effort: 'high', minCacheCreate: 100, hasSkill: ['agentlenspro-diagnostics'] } },
  },
  { name: 'filter_matches_nothing', opts: { filter: { model: 'no-such-model' } } },

  // WRONG-TYPED FILTER VALUES. The MCP schema types `filter` as a bare object with no per-property
  // types and the handler casts without validating, so these reach the engine from any client.
  // The TS BINDS them (a number as INTEGER, per sql.js) rather than ignoring them, so the result
  // NARROWS to nothing; a port that required a JSON string would drop the filter and answer a
  // broader question under the caller's label. Pinned so that can never regress silently.
  { name: 'filter_model_numeric', opts: { filter: { model: 123 } } },
  { name: 'filter_model_bool', opts: { filter: { model: true } } },
  // `f.window && f.window > 0` coerces: a STRING window applies a real cutoff in the TS.
  { name: 'filter_window_string', opts: { filter: { window: '1000000' } } },
  { name: 'filter_window_unparseable', opts: { filter: { window: 'soon' } } },
  // `vals.map` builds one placeholder PER ELEMENT whatever its type. HONEST LIMIT: this case pins
  // the SHAPE, not a difference the rows can show — a bound INTEGER never equals a TEXT skill name,
  // so dropping the 123 yields the same result set here. It fails only if the placeholder/param
  // counts stop agreeing (a bind error). The divergence it documents is in the generated SQL.
  { name: 'filter_has_skill_mixed_types', opts: { filter: { hasSkill: ['agentlenspro-diagnostics', 123] } } },
  { name: 'filter_has_skill_empty_array', opts: { filter: { hasSkill: [] } } },
  { name: 'verdict_output_metric', opts: { groupBy: 'spawn_kind', metric: 'output_tokens' } },
  { name: 'verdict_billable_metric', opts: { groupBy: 'spawn_kind', metric: 'billable_weighted' } },
  { name: 'skill_group_with_agg_count', opts: { groupBy: 'skill', agg: 'count' } },
  { name: 'db_missing', opts: { forensicsDbPath: MISSING_DB } },
]

const results = {}
for (const c of cases) {
  const forensicsDbPath = c.opts.forensicsDbPath ?? DB
  results[c.name] = await buildCompareConfigs({ ...c.opts, forensicsDbPath })
}

const out = { note: 'oracle for compare_configs — generated, do not hand-edit', cases: results }
// No absolute path should reach the file; tokenize the fixture root anyway so a future case that
// echoes a path cannot commit this checkout's home directory.
const json = JSON.stringify(out, null, 2).split(JSON.stringify(ROOT).slice(1, -1)).join('<FIX>')
fs.writeFileSync(path.join(HERE, 'forensicscompare-expected.json'), `${json}\n`)
console.log(`wrote forensicscompare-expected.json — ${Object.keys(results).length} cases`)
