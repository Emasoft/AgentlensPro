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

/** The per-turn split, taken from real captures. i=3 is the ONLY cold rewrite: the prefix lands in
 *  cache_creation with nothing read back. The other three are what a warm turn actually looks like —
 *  the whole prefix re-read at 0.1x while the write is the new suffix only. Both shapes have to be
 *  present or the `cache` view's verdict is untested in one direction. */
const USAGE = [
  { input_tokens: 4, cache_creation_input_tokens: 1_500, cache_read_input_tokens: 630_000, output_tokens: 900 },
  { input_tokens: 4, cache_creation_input_tokens: 2_775, cache_read_input_tokens: 629_400, output_tokens: 1_200 },
  { input_tokens: 4, cache_creation_input_tokens: 239, cache_read_input_tokens: 632_712, output_tokens: 600 },
  { input_tokens: 4, cache_creation_input_tokens: 520_000, cache_read_input_tokens: 0, output_tokens: 300 },
]

function seed(root: string): void {
  const s = new StatuslineStore({ root, autoTimer: false })
  const now = Date.now()
  for (let i = 0; i < 4; i++) {
    s.append({
      session_id: SESSIONS[i % 2],
      prompt_id: `p-${i}`,
      model: { id: 'claude-opus-5', display_name: 'Opus' },
      effort: { level: 'high' },
      context_window: {
        total_input_tokens: 100_000 + i * 50_000, used_percentage: 10 + i, context_window_size: 1_000_000,
        current_usage: USAGE[i],
      },
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
        const raw = await queryStatusline(root, view.stream, view.sql(40, undefined), { sinceMs: Date.now() - 3_600_000 })
        assert.ok(raw !== null, `${name}: store seeded but read BLIND`)
        // post() runs in the CLI between the query and the render, so a column it derives is only
        // present here if it is applied — check the rows the user actually sees, not the SQL result.
        const rows = view.post ? view.post(raw) : raw
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

  test('peaks labels a delta taken ACROSS a sampling gap as an INTERVAL, not a turn', async () => {
    // The bug this guards is one I made and acted on. total_cost_usd is cumulative and sampling stops
    // while a session is idle, so the pair bracketing an idle stretch carries every turn in between.
    // Read as a per-turn cost it over-states by however many turns the gap hid — here 15x.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-gap-'))
    try {
      const s = new StatuslineStore({ root, autoTimer: false })
      const now = Date.now()
      const sample = (ctx: number, cost: number): Record<string, unknown> => ({
        session_id: SESSIONS[0], model: { display_name: 'Opus' },
        context_window: { total_input_tokens: ctx }, cost: { total_cost_usd: cost },
      })
      s.append(sample(100_000, 1.0), 'main', now - 600_000)     // then the session went idle...
      s.append(sample(140_000, 6.0), 'main', now - 60_000)      // ...9 min later: 5 dollars, many turns
      s.append(sample(150_000, 6.4), 'main', now - 57_000)      // 3 s later: one real turn
      s.flush()

      const rows = await queryStatusline(root, 'main', VIEWS.peaks.sql(40, SESSIONS[0]), { sinceMs: now - 3_600_000 })
      const bySpan = new Map(rows!.map(r => [String(r.span), r]))
      assert.ok(bySpan.has('INTERVAL'), 'the 9-minute gap must be flagged, not presented as one turn')
      assert.ok(bySpan.has('turn'), 'the 3-second delta is a genuine per-turn cost')
      assert.strictEqual(Math.round(Number(bySpan.get('INTERVAL')!.gap_s)), 540)
      assert.strictEqual(Math.round(Number(bySpan.get('turn')!.gap_s)), 3)
      // And the flagged one is exactly the number that would have been mis-read as a single turn.
      assert.ok(Math.abs(Number(bySpan.get('INTERVAL')!.d_cost) - 5) < 1e-9)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  test('cache separates a warm turn from a cold rewrite by the write/read ratio', async () => {
    // THE FALSIFIER. A hook on this machine claimed "cache-miss write ~520k" on every turn while the
    // transcript showed cache_read ~630k against cache_creation ~1k. This is the one command that
    // settles it, so both verdicts have to be pinned.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-cache-'))
    try {
      seed(root)
      const raw = await queryStatusline(root, 'main', VIEWS.cache.sql(40, undefined), { sinceMs: Date.now() - 3_600_000 })
      const rows = VIEWS.cache.post!(raw!)
      assert.strictEqual(rows.length, 4)
      assert.ok(rows.every(r => Number(r.renders) === 1), 'four distinct turns, one render each')

      // Ordered by cache_write DESC, so the cold rewrite is first.
      assert.strictEqual(rows[0].verdict, 'COLD-WRITE')
      assert.strictEqual(Number(rows[0].cache_write), 520_000)
      assert.strictEqual(Math.round(Number(rows[0].write_pct)), 100)

      const warm = rows.filter(r => r.verdict === 'warm')
      assert.strictEqual(warm.length, 3, 'the three re-read turns must all read as warm')
      assert.ok(warm.every(r => Number(r.write_pct) < 1), 'a warm turn writes well under 1% of its context')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  test('cache collapses the SAME turn re-rendered many times into one row', async () => {
    // current_usage describes the LAST COMPLETED turn and the status line re-renders every ~3 s
    // regardless, so an idle session republishes one turn indefinitely. Ungrouped, the first live run
    // of this view showed a single compaction rewrite twelve times and nothing else — a table that
    // reads as twelve cold writes when there was one.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-dedup-'))
    try {
      const s = new StatuslineStore({ root, autoTimer: false })
      const now = Date.now()
      const turn = (u: Record<string, number>, tsMs: number): void => {
        s.append({
          session_id: SESSIONS[0], model: { id: 'claude-opus-5' },
          context_window: { current_usage: u },
        }, 'main', tsMs)
      }
      for (let i = 0; i < 12; i++) turn(USAGE[3], now - 60_000 + i * 3_000)   // one turn, 12 renders
      for (let i = 0; i < 3; i++) turn(USAGE[0], now - 20_000 + i * 3_000)    // the next turn, 3
      // The SAME second turn caught mid-stream: identical input buckets, a partial output count.
      // Grouping on output_tokens would split this back out into its own row.
      turn({ ...USAGE[0], output_tokens: 2 }, now - 21_000)
      s.flush()

      const rows = VIEWS.cache.post!((await queryStatusline(
        root, 'main', VIEWS.cache.sql(40, undefined), { sinceMs: now - 3_600_000 }))!)
      assert.strictEqual(rows.length, 2, 'sixteen samples, two turns')
      assert.strictEqual(Number(rows[0].renders), 12)
      assert.strictEqual(Number(rows[1].renders), 4, 'the mid-stream snapshot belongs to its own turn')
      assert.strictEqual(Number(rows[1].out_tok), USAGE[0].output_tokens,
        'the COMPLETED output count wins, not the partial one that happened to be sampled')
      // The reported time is when the turn was FIRST seen, not the last idle re-render.
      assert.ok(Number(rows[0].ts) <= now - 60_000 + 1)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  test('cache brackets the cost by TTL tier instead of guessing one, and never prices at 0', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-cache-cost-'))
    try {
      seed(root)
      const rows = VIEWS.cache.post!((await queryStatusline(
        root, 'main', VIEWS.cache.sql(40, undefined), { sinceMs: Date.now() - 3_600_000 }))!)
      const cold = rows[0]
      // opus-5: input $5, cacheRead $0.50, cacheWrite-5m $6.25, cacheWrite-1h $10.00, output $25 /MTok.
      // 520,000 writes: 5m = 200k*6.25 + 320k*6.25(>200k tier is the same here) ; the point of the
      // assertion is only that the 1h bound is strictly the larger, and both are real money.
      assert.ok(Number(cold.cost_1h) > Number(cold.cost_5m), 'the 1h write tier is 2x, the 5m is 1.25x')
      assert.ok(Number(cold.cost_5m) > 0)
      // The warm turns are ~15x cheaper than the cold one even though their context is LARGER — the
      // fact the whole cache model rests on. Compare like for like: both bounds of each.
      const warm = rows.find(r => r.verdict === 'warm')!
      assert.ok(Number(warm.cost_1h) < Number(cold.cost_5m) / 5,
        'a re-read prefix must cost far less than a re-written one')

      // An unpriced model must render "-", never $0: a zero in a cost column reads as "free".
      const unpriced = VIEWS.cache.post!([{ model_id: 'some-model-we-do-not-price', in_tok: 1, cache_write: 1, cache_read: 1, out_tok: 1 }])
      assert.strictEqual(unpriced[0].cost_5m, null)
      assert.strictEqual(unpriced[0].cost_1h, null)
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
