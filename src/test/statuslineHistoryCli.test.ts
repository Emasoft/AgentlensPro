// `agentlenspro statusline-history` (src/cli/statuslineHistoryCli.ts).
//
// WHY EVERY VIEW IS EXECUTED HERE. Both bugs this file was written after were invisible to the type
// checker and to any test that only inspected the SQL string:
//   1. `peaks` opened with its own `WITH`, and the runner splices each view in after
//      `WITH samples AS (...)` — two consecutive WITH clauses, parser error, whole view dead.
//   2. `subagents` selected `t.name`, which the DOCS list on each task but the LIVE payload does not
//      have (it carries `description` and `label`). A missing struct key is a hard binder error.
// Neither is catchable except by running the query against a real store, so that is what these do.

import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { StatuslineStore, queryStatusline } from '../statuslineStore'
import { VIEWS, parseWhenArg, table, jsonSafe } from '../cli/statuslineHistoryCli'

// UUID-SHAPED on purpose. DuckDB's JSON reader auto-detects a UUID-shaped string as the UUID type and
// the node client returns it as {hugeint:"..."} — the exact bug that shipped. A placeholder like
// "sess-0" is never inferred as UUID, so a test seeded with one passes while the bug is live.
const SESSIONS = ['249c4216-4db4-4b64-9a10-b994b9d7bd80', '667293ab-cf8d-4640-a69e-a406ba19e2b4']

function seed(root: string): void {
  const s = new StatuslineStore({ root, autoTimer: false })
  const now = Date.now()
  for (let i = 0; i < 4; i++) {
    s.append({
      session_id: SESSIONS[i % 2],
      prompt_id: `p-${i}`,
      model: { id: 'claude-opus-5', display_name: 'Opus' },
      effort: { level: 'high' },
      context_window: { total_input_tokens: 100_000 + i * 50_000, used_percentage: 10 + i, context_window_size: 1_000_000 },
      cost: { total_cost_usd: 1 + i * 2 },
      rate_limits: { five_hour: { used_percentage: 57.99999999999999, resets_at: 1785607800 }, seven_day: { used_percentage: 71, resets_at: 1785945600 } },
    }, 'main', now - (4 - i) * 1000)
  }
  // The task struct EXACTLY as the live payload carries it — no `name` key, on purpose.
  s.append({
    session_id: SESSIONS[0], columns: 120,
    tasks: [
      {
        id: 'a1', type: 'local_agent', status: 'completed', description: 'Advisor: namespace design',
        label: 'Grepping', startTime: now - 60_000, model: 'claude-fable-5', effort: 'xhigh',
        contextWindowSize: 1_000_000, tokenCount: 90_502, tokenSamples: [89_339, 90_502],
        cwd: '/Users/x/Code/PROJ',
      },
      {
        id: 'a2', type: 'local_agent', status: 'running', description: 'Explore the store',
        label: 'Reading', startTime: now - 30_000, model: 'claude-sonnet-5', effort: 'medium',
        contextWindowSize: 200_000, tokenCount: 150_000, tokenSamples: [150_000],
        cwd: '/Users/x/Code/PROJ/.claude/worktrees/feat-x',
      },
    ],
  }, 'subagent', now)
  s.flush()
}

suite('statusline-history — every view must actually EXECUTE', () => {
  for (const [name, view] of Object.entries(VIEWS)) {
    test(`view '${name}' runs and returns rows`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-hist-'))
      try {
        seed(root)
        const rows = await queryStatusline(root, view.stream, view.sql(40, undefined), { sinceMs: Date.now() - 3_600_000 })
        assert.ok(rows !== null, `${name}: store seeded but read BLIND`)
        assert.ok(rows.length > 0, `${name}: returned no rows`)
        // Every declared column must exist in the result, or the table renders a column of '-'.
        for (const c of view.cols) {
          assert.ok(c.key in rows[0], `${name}: column '${c.key}' is not in the result set`)
        }
        // THE UUID TRAP. Un-cast, DuckDB hands a UUID-shaped id back as {hugeint:"-4237945…"} — so
        // the table prints "[object" and --json emits an object where an id belongs. Assert the
        // actual JS type, not truthiness: an object is truthy and would sail through.
        if ('session_id' in rows[0]) {
          assert.strictEqual(typeof rows[0].session_id, 'string',
            `${name}: session_id came back as ${typeof rows[0].session_id} — it must be CAST to VARCHAR`)
          assert.ok(SESSIONS.includes(String(rows[0].session_id)), `${name}: session_id is not one of the seeded ids`)
        }
      } finally { fs.rmSync(root, { recursive: true, force: true }) }
    })

    test(`view '${name}' runs with a --session filter`, async () => {
      // The filter is spliced into the SQL, and `windows` switches WHERE/AND on it — a shape that
      // silently produces invalid SQL if the branch is ever wrong.
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-hist-s-'))
      try {
        seed(root)
        const rows = await queryStatusline(root, view.stream, view.sql(40, SESSIONS[0]), { sinceMs: Date.now() - 3_600_000 })
        assert.ok(rows !== null, `${name}: BLIND with a session filter`)
      } finally { fs.rmSync(root, { recursive: true, force: true }) }
    })
  }

  test('the subagent view reports fill% against each agent OWN window size', async () => {
    // The whole point of the view: a 150k-token Sonnet agent in a 200k window (75%) is in far more
    // trouble than a 90k-token Fable agent in a 1M window (9%), and only the ratio shows that.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-fill-'))
    try {
      seed(root)
      const rows = await queryStatusline(root, 'subagent', VIEWS.subagents.sql(40, undefined), { sinceMs: Date.now() - 3_600_000 })
      const byId = new Map(rows!.map(r => [String(r.agent_id), r]))
      assert.strictEqual(Math.round(Number(byId.get('a2')!.fill_pct)), 75)
      assert.strictEqual(Math.round(Number(byId.get('a1')!.fill_pct)), 9)
      assert.ok(String(byId.get('a2')!.cwd).includes('worktrees'), 'cwd is what marks a worktree agent')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  test('peaks reports the DELTA between consecutive samples, not the running total', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-peaks-'))
    try {
      seed(root)
      const rows = await queryStatusline(root, 'main', VIEWS.peaks.sql(40, SESSIONS[0]), { sinceMs: Date.now() - 3_600_000 })
      assert.ok(rows!.length > 0)
      // SESSIONS[0]'s samples are i=0,2 → ctx 100k then 200k, cost 1 then 5.
      assert.strictEqual(Number(rows![0].d_ctx), 100_000)
      assert.strictEqual(Number(rows![0].d_cost), 4)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})

suite('statusline-history — argument parsing and rendering', () => {
  test('--since accepts hours-back as a bare number and an ISO timestamp', () => {
    const now = Date.parse('2026-08-01T12:00:00Z')
    assert.strictEqual(parseWhenArg('2', now), now - 7_200_000)
    assert.strictEqual(parseWhenArg('2026-08-01T06:00:00Z', now), Date.parse('2026-08-01T06:00:00Z'))
    assert.strictEqual(parseWhenArg(undefined, now), undefined)
  })

  test('an unparseable time throws rather than silently becoming NaN', () => {
    // NaN would flow into the window predicate and quietly match nothing, which reads as "no burn".
    assert.throws(() => parseWhenArg('last tuesday'), /unparseable time/)
  })

  test('--json survives DuckDB BigInts, which JSON.stringify throws on', async () => {
    // Every BIGINT column (token counts, epoch ms, count(*)) arrives as a JS BigInt. The table view
    // hid this behind String(); --json failed outright with "Do not know how to serialize a BigInt".
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-json-'))
    try {
      seed(root)
      const rows = await queryStatusline(root, 'main', VIEWS.sessions.sql(40, undefined), { sinceMs: Date.now() - 3_600_000 })
      assert.ok(rows!.some(r => Object.values(r).some(v => typeof v === 'bigint')), 'precondition: a BigInt is present')
      const text = JSON.stringify(jsonSafe({ rows }))          // must not throw
      assert.ok(JSON.parse(text).rows.length > 0)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  test('jsonSafe keeps exact integers as numbers and only stringifies beyond 2^53', () => {
    assert.strictEqual(jsonSafe(42n), 42)
    assert.strictEqual(jsonSafe(-42n), -42)
    assert.strictEqual(jsonSafe(BigInt(Number.MAX_SAFE_INTEGER) + 10n), '9007199254741001',
      'silently rounding past 2^53 would corrupt a token count rather than flag it')
    assert.deepStrictEqual(jsonSafe({ a: [1n, { b: 2n }] }), { a: [1, { b: 2 }] })
  })

  test('the table pads columns and never crashes on a missing key', () => {
    const out = table([{ a: 1 }, { a: 22, b: 'x' }], [{ key: 'a', label: 'A' }, { key: 'b', label: 'BB' }])
    const lines = out.split('\n')
    assert.strictEqual(lines.length, 4, 'header + rule + 2 rows')
    assert.ok(lines[2].includes('-'), 'a missing value renders as a dash, not "undefined"')
  })
})
