import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { indexApiCalls } from '../forensicsIndex'
import { buildCompareConfigs } from '../forensicsCompare'
import { runDiagnosticsSql, assertReadOnlySelect, PRESETS } from '../forensicsSql'
import { loadSqlJs } from '../forensicsDb'

// TRDD-FB5RG4P1 Phase 3/6 — REAL tests for compare_configs + run_diagnostics_sql: write real bodies +
// a real main DB, run the REAL indexer, then drive the REAL compare engine + SQL engine over the
// resulting forensics.db. No mocks.

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fal-p36-'))
const bodiesDir = path.join(tmpRoot, 'otel-bodies')
const forensicsDbPath = path.join(tmpRoot, 'forensics.db')
const mainDbPath = path.join(tmpRoot, 'agentlens.db')
// indexApiCalls now also reads a Parquet STORE (default dataPath('store') — this developer's real
// ~/.agentlens/store). A never-created dir keeps this fixture's exact-count assertions isolated from
// that real corpus (see forensicsIndex.test.ts's noStoreDir for the same rationale).
const noStoreDir = path.join(tmpRoot, 'no-store')
fs.mkdirSync(bodiesDir, { recursive: true })
suiteTeardown(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* best effort */ } })

let counter = 0
function write(suffix: 'request' | 'response', body: unknown): void {
  fs.writeFileSync(path.join(bodiesDir, `${++counter}.${suffix}.json`), JSON.stringify(body))
}
// One "call" = a response + the FOLLOWING request that carries the join key + session.
function emitCall(session: string, cc: number, opts: { withMcp?: boolean; withImage?: boolean; budget?: number } = {}): void {
  const id = `msg_${session}_${counter}`
  write('response', {
    id, model: 'claude-opus-4-8',
    usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 500, cache_creation_input_tokens: cc,
      cache_creation: { ephemeral_5m_input_tokens: Math.round(cc * 0.7), ephemeral_1h_input_tokens: Math.round(cc * 0.3) } },
  })
  const tools: unknown[] = [{ name: 'Bash' }, { name: 'Read' }]
  if (opts.withMcp) { tools.push({ name: 'mcp__agentlens__get_burn_status' }) }
  const messages: unknown[] = [{ role: 'user', content: [{ type: 'text', text: 'do it' }] }]
  if (opts.withImage) {
    messages.push({ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA'.repeat(2000) } }] })
  }
  messages.push({ role: 'assistant', content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'distill' } }] })
  write('request', {
    model: 'claude-opus-4-8',
    metadata: { user_id: JSON.stringify({ device_id: 'd', account_uuid: 'acct-1', session_id: session }) },
    diagnostics: { previous_message_id: id },
    thinking: { type: 'enabled', budget_tokens: opts.budget ?? 10000 },
    system: [{ type: 'text', text: 'Contents of /u/.claude/rules/commit-discipline.md (x)\n- rule' }],
    tools, messages,
  })
}

async function buildMainDb(): Promise<void> {
  const SQL = await loadSqlJs()
  const db = new SQL!.Database()
  db.run(`CREATE TABLE sessions (session_id TEXT PRIMARY KEY, spawn_kind TEXT, spawn_model_override TEXT,
          spawn_isolation TEXT, is_sidechain INTEGER, parent_session_id TEXT, model TEXT)`)
  db.run(`INSERT INTO sessions VALUES ('sess-fork','fork',NULL,NULL,1,'sess-root','claude-opus-4-8')`)
  db.run(`INSERT INTO sessions VALUES ('sess-fresh','fresh',NULL,NULL,1,'sess-root','claude-opus-4-8')`)
  db.run(`INSERT INTO sessions VALUES ('sess-wt','worktree',NULL,'worktree',1,'sess-root','claude-opus-4-8')`)
  db.run(`INSERT INTO sessions VALUES ('sess-root',NULL,NULL,NULL,0,NULL,'claude-opus-4-8')`)
  fs.writeFileSync(mainDbPath, Buffer.from(db.export()))
  db.close()
}

suite('FAL Phase 3/6 — indexed fixture setup', () => {
  suiteSetup(async () => {
    // fork = cheapest (warm), fresh = mid, worktree = most expensive (cold+isolated), root = mid.
    for (let i = 0; i < 3; i++) { emitCall('sess-fork', 3000, { withMcp: true }) }
    for (let i = 0; i < 3; i++) { emitCall('sess-fresh', 100000) }
    for (let i = 0; i < 3; i++) { emitCall('sess-wt', 300000, { withImage: true }) }
    for (let i = 0; i < 3; i++) { emitCall('sess-root', 90000) }
    await buildMainDb()
    const res = await indexApiCalls({ bodiesDir, forensicsDbPath, mainDbPath, storeDir: noStoreDir })
    assert.equal(res.dbAvailable, true)
    assert.equal(res.inserted, 12)
  })

  test('placeholder to force suiteSetup ordering', () => { assert.ok(fs.existsSync(forensicsDbPath)) })
})

suite('FAL Phase 3 — compare_configs', () => {
  test('groupBy spawn_kind ranks worktree>fresh>fork worst-first with full per-group stats', async () => {
    const r = await buildCompareConfigs({ groupBy: 'spawn_kind', metric: 'cache_creation', forensicsDbPath })
    assert.equal(r.dbAvailable, true)
    const keys = r.groups.map(g => g.key)
    for (const k of ['fork', 'fresh', 'worktree', 'root']) { assert.ok(keys.includes(k), `group ${k} present`) }
    const g = (k: string) => r.groups.find(x => x.key === k)!
    // every group carries min/max/avg/median/p95/count/sum (task requirement)
    for (const k of ['fork', 'fresh', 'worktree']) {
      const grp = g(k)
      for (const f of ['min', 'max', 'avg', 'median', 'p95', 'sum'] as const) { assert.equal(typeof grp[f], 'number') }
      assert.ok(grp.calls >= 3)
    }
    assert.ok(g('worktree').avg > g('fresh').avg, 'worktree costlier than fresh')
    assert.ok(g('fresh').avg > g('fork').avg, 'fresh costlier than fork')
    // worst-first: first group has the highest avg
    assert.equal(r.groups[0].key, 'worktree')
    assert.ok(r.verdict.length >= 1, 'plain-language verdict computed')
  })

  test('best-first flips the order; billable_weighted + total metrics work', async () => {
    const best = await buildCompareConfigs({ groupBy: 'spawn_kind', agg: 'avg', rankOrder: 'best-first', forensicsDbPath })
    assert.equal(best.groups[0].key, 'fork')
    const bw = await buildCompareConfigs({ groupBy: 'spawn_kind', metric: 'billable_weighted', forensicsDbPath })
    assert.ok(bw.groups.every(g => typeof g.billableWeightedUsd === 'number'))
  })

  test('injection + content groupBys resolve (rule always present, mcp/skill/image where emitted)', async () => {
    const byRule = await buildCompareConfigs({ groupBy: 'rule', forensicsDbPath })
    assert.ok(byRule.groups.some(g => g.key === 'commit-discipline.md'))
    const byMcp = await buildCompareConfigs({ groupBy: 'mcp', forensicsDbPath })
    assert.ok(byMcp.groups.some(g => g.key === 'mcp__agentlens'))
    const byTag = await buildCompareConfigs({ groupBy: 'content_tag', forensicsDbPath })
    assert.ok(byTag.groups.some(g => g.key === 'image'), 'image content tag surfaced')
  })

  test('filter narrows the population (minCacheCreate drops the cheap fork calls)', async () => {
    const r = await buildCompareConfigs({ groupBy: 'spawn_kind', filter: { minCacheCreate: 50000 }, forensicsDbPath })
    assert.ok(!r.groups.some(g => g.key === 'fork'), 'fork (3k cc) excluded by minCacheCreate 50k')
    assert.ok(r.groups.some(g => g.key === 'worktree'))
  })

  test('missing DB degrades honestly (dbAvailable false, explanatory coverage)', async () => {
    const r = await buildCompareConfigs({ groupBy: 'spawn_kind', forensicsDbPath: path.join(tmpRoot, 'does-not-exist.db') })
    assert.equal(r.dbAvailable, false)
    assert.ok(typeof r.coverage.note === 'string')
  })
})

suite('FAL Phase 6 — run_diagnostics_sql', () => {
  test('no args lists all 16 presets', async () => {
    const r = await runDiagnosticsSql({})
    assert.equal(r.mode, 'list')
    assert.equal(r.presets!.length, Object.keys(PRESETS).length)
    assert.equal(r.presets!.length, 16)
  })

  test('preset fork_vs_fresh returns fork + fresh rows', async () => {
    const r = await runDiagnosticsSql({ preset: 'fork_vs_fresh', forensicsDbPath })
    assert.equal(r.mode, 'preset')
    const kinds = (r.rows ?? []).map(row => row.spawn_kind)
    assert.ok(kinds.includes('fork') && kinds.includes('fresh'))
  })

  test('preset unresolved_audit + tier_split_by_config run without break-cause data', async () => {
    const a = await runDiagnosticsSql({ preset: 'unresolved_audit', forensicsDbPath })
    assert.ok((a.rows ?? []).some(row => row.spawn_resolution === 'direct'))
    const b = await runDiagnosticsSql({ preset: 'tier_split_by_config', forensicsDbPath })
    assert.ok((b.rows ?? []).length >= 1)
  })

  test('raw read-only SELECT runs and custom fns are callable', async () => {
    const r = await runDiagnosticsSql({ sql: "SELECT billable_weight(1000,500,200,50,300,'claude-opus-4-8') AS w, tier_classify(2.0) AS bk", forensicsDbPath })
    assert.equal(r.mode, 'sql')
    assert.ok((r.rows![0].w as number) > 0)
    assert.equal(r.rows![0].bk, 'BREAK')
  })

  test('table + markdown formats render', async () => {
    const t = await runDiagnosticsSql({ preset: 'worst_configs_by_cache_creation', format: 'table', forensicsDbPath })
    assert.ok(typeof t.rendered === 'string' && t.rendered!.includes('┃'))
    const m = await runDiagnosticsSql({ preset: 'worst_configs_by_cache_creation', format: 'markdown', forensicsDbPath })
    assert.ok(typeof m.rendered === 'string' && m.rendered!.includes('|'))
  })

  test('statement gate REJECTS every non-read-only shape (fail-closed, returns error not throw)', async () => {
    for (const bad of [
      'INSERT INTO api_calls (call_id) VALUES (1)',
      'DROP TABLE api_calls',
      'UPDATE api_calls SET cost_usd = 0',
      'DELETE FROM api_calls',
      'PRAGMA table_info(api_calls)',
      "ATTACH DATABASE 'x.db' AS y",
      'SELECT 1; SELECT 2',
    ]) {
      const r = await runDiagnosticsSql({ sql: bad, forensicsDbPath })
      assert.ok(r.error, `must reject: ${bad}`)
      assert.ok(!r.rows, `no rows for rejected: ${bad}`)
    }
  })

  test('assertReadOnlySelect accepts SELECT/WITH, strips comments + one trailing semicolon', () => {
    assert.equal(assertReadOnlySelect('SELECT 1; '), 'SELECT 1')
    assert.ok(assertReadOnlySelect('WITH t AS (SELECT 1 AS x) SELECT x FROM t').startsWith('WITH'))
    assert.equal(assertReadOnlySelect('SELECT 1 -- comment\n').trim(), 'SELECT 1')
    assert.throws(() => assertReadOnlySelect('DELETE FROM api_calls'))
    assert.throws(() => assertReadOnlySelect('SELECT 1; DROP TABLE api_calls'))
  })

  test('preset + sql together is rejected; unknown preset is rejected', async () => {
    const both = await runDiagnosticsSql({ preset: 'fork_vs_fresh', sql: 'SELECT 1', forensicsDbPath })
    assert.ok(both.error)
    const unk = await runDiagnosticsSql({ preset: 'nope', forensicsDbPath })
    assert.ok(unk.error)
  })
})
