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
import {
  VIEWS, parseWhenArg, table, jsonSafe, projectPredicate, whereOf,
  tzLabel, coverageLine, storeFreshness,
} from '../cli/statuslineHistoryCli'

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
        const raw = await queryStatusline(root, view.stream, view.sql(40, {}), { sinceMs: Date.now() - 3_600_000 })
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
        const rows = await queryStatusline(root, view.stream, view.sql(40, { session: SESSIONS[0] }), { sinceMs: Date.now() - 3_600_000 })
        assert.ok(rows !== null, `${name}: BLIND with a session filter`)
      } finally { fs.rmSync(root, { recursive: true, force: true }) }
    })

    test(`view '${name}' runs with a --project filter`, async () => {
      // Every view must BIND the three workspace columns, on BOTH streams. The subagent stream
      // carries none of them in its own payload — they exist only because the store's zero-row
      // template guarantees them — so a view that binds fine on `main` can still be a binder error
      // on `subagent`. Running each view under a project filter is the only thing that proves it.
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-hist-p-'))
      try {
        seed(root)
        const rows = await queryStatusline(root, view.stream, view.sql(40, { project: '/Users/x/Code/PROJ' }), { sinceMs: Date.now() - 3_600_000 })
        assert.ok(rows !== null, `${name}: BLIND with a project filter`)
      } finally { fs.rmSync(root, { recursive: true, force: true }) }
    })

    test(`view '${name}' runs with BOTH filters at once`, async () => {
      // The shape this file's WHERE-composition replaced could only ever emit ONE condition; a
      // second filter produced `WHERE a WHERE b`. Type-invisible, since it is a string.
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-hist-sp-'))
      try {
        seed(root)
        const rows = await queryStatusline(root, view.stream,
          view.sql(40, { session: SESSIONS[0], project: '/Users/x/Code/PROJ' }), { sinceMs: Date.now() - 3_600_000 })
        assert.ok(rows !== null, `${name}: BLIND with both filters`)
      } finally { fs.rmSync(root, { recursive: true, force: true }) }
    })
  }

  test('the subagent view reports fill% against each agent OWN window size', async () => {
    // The whole point of the view: a 150k-token Sonnet agent in a 200k window (75%) is in far more
    // trouble than a 90k-token Fable agent in a 1M window (9%), and only the ratio shows that.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-fill-'))
    try {
      seed(root)
      const rows = await queryStatusline(root, 'subagent', VIEWS.subagents.sql(40, {}), { sinceMs: Date.now() - 3_600_000 })
      const byId = new Map(rows!.map(r => [String(r.agent_id), r]))
      assert.strictEqual(Math.round(Number(byId.get('a2')!.fill_pct)), 75)
      assert.strictEqual(Math.round(Number(byId.get('a1')!.fill_pct)), 9)
      assert.ok(String(byId.get('a2')!.cwd).includes('worktrees'), 'cwd is what marks a worktree agent')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  test('subagents survives a tasks[] struct that is MISSING a field entirely', async () => {
    // MEASURED on the live store: DuckDB infers the `tasks` struct type PER FILE, so a part in which
    // no task ever reported `effort` gets a struct with NO `effort` key — and `t.effort` against it
    // is a hard `Binder Error: Could not find key "effort" in struct` that kills the whole view. One
    // of six live subagent parts was exactly that; another carried the field on 1 of 413 tasks. It
    // survives in production only because file selection is by DAY partition, so a sibling part that
    // does have the key joins the union — a day whose parts all lack it would go down.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-drift-'))
    try {
      const s = new StatuslineStore({ root, autoTimer: false })
      const now = Date.now()
      // Every task here omits `effort`, `label` and `cwd` — the whole store has no such key.
      s.append({
        session_id: SESSIONS[0],
        tasks: [{ id: 'a1', type: 'local_agent', status: 'running', description: 'no-effort agent', startTime: now, model: 'claude-sonnet-5', contextWindowSize: 1_000_000, tokenCount: 400_000 }],
      }, 'subagent', now)
      s.flush()

      const rows = await queryStatusline(root, 'subagent', VIEWS.subagents.sql(40, {}), { sinceMs: now - 3_600_000 })
      assert.ok(rows, 'a struct missing a field must not read BLIND')
      assert.strictEqual(rows.length, 1)
      assert.strictEqual(rows[0].effort, null, 'an absent key is NULL, not a binder error')
      assert.strictEqual(String(rows[0].task), 'no-effort agent', 'the fields that ARE present still resolve')
      assert.strictEqual(Number(rows[0].peak_tokens), 400_000)
      assert.strictEqual(Math.round(Number(rows[0].fill_pct)), 40)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  test('peaks reports the DELTA between consecutive samples, not the running total', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-peaks-'))
    try {
      seed(root)
      const rows = await queryStatusline(root, 'main', VIEWS.peaks.sql(40, { session: SESSIONS[0] }), { sinceMs: Date.now() - 3_600_000 })
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

      const rows = await queryStatusline(root, 'main', VIEWS.peaks.sql(40, { session: SESSIONS[0] }), { sinceMs: now - 3_600_000 })
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
      const raw = await queryStatusline(root, 'main', VIEWS.cache.sql(40, {}), { sinceMs: Date.now() - 3_600_000 })
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
        root, 'main', VIEWS.cache.sql(40, {}), { sinceMs: now - 3_600_000 }))!)
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
        root, 'main', VIEWS.cache.sql(40, {}), { sinceMs: Date.now() - 3_600_000 }))!)
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
      const rows = await queryStatusline(root, 'main', VIEWS.sessions.sql(40, {}), { sinceMs: Date.now() - 3_600_000 })
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

suite('statusline-history — project scoping', () => {
  test('projectPredicate matches the root and anything under it, never a same-prefix sibling', () => {
    const p = projectPredicate('/p/alpha')
    assert.ok(p.includes("= '/p/alpha'"), 'the root itself must match')
    assert.ok(p.includes("LIKE '/p/alpha/%'"),
      "the slash in the LIKE is what stops '/p/alpha' from also matching '/p/alpha-old'")
    assert.ok(!p.includes("LIKE '/p/alpha%'"), 'a bare-prefix LIKE would swallow every sibling project')
    for (const c of ['workspace_project_dir', 'workspace_current_dir', 'cwd']) {
      assert.ok(p.includes(c), `${c} must be matched — a worktree agent is only findable via cwd`)
    }
    assert.strictEqual(projectPredicate('/p/alpha/'), p, 'a trailing slash must not change the meaning')
    assert.ok(projectPredicate("/p/o'brien").includes("''"), "an apostrophe in a path must be escaped, not injected")
  })

  test('whereOf composes BOTH filters into ONE where clause', () => {
    // The shape this replaced switched `${session ? 'AND' : 'WHERE'}` per view, which produces
    // invalid SQL the moment a second filter exists — silently, since it is a string.
    assert.strictEqual(whereOf({}), '', 'no filters means no WHERE at all')
    const both = whereOf({ session: 's1', project: '/p/alpha' }, 'ts IS NOT NULL')
    assert.strictEqual((both.match(/WHERE/g) ?? []).length, 1, 'exactly one WHERE')
    assert.strictEqual((both.match(/ AND /g) ?? []).length, 2, 'session AND project AND the extra')
    assert.ok(whereOf({}, 'x IS NOT NULL').startsWith('WHERE '), 'a view-specific condition alone still opens the WHERE')
    assert.ok(whereOf({ session: "a'b" }).includes("'a''b'"), 'a session id is escaped too')
  })

  test('the project view scopes to one project and reports the LATEST model, not an arbitrary one', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-proj-'))
    try {
      const s = new StatuslineStore({ root, autoTimer: false })
      const now = Date.now()
      const sample = (session: string, i: number, model: string, ws: Record<string, unknown>, cwd: string) => ({
        session_id: session, model: { id: model }, effort: { level: 'high' }, cwd, workspace: ws,
        context_window: { total_input_tokens: 1000 * (i + 1), used_percentage: i + 1, context_window_size: 1_000_000 },
        cost: { total_cost_usd: (i + 1) * 0.5 },
        rate_limits: { five_hour: { used_percentage: 80 }, seven_day: { used_percentage: 91 } },
      })
      // The target project. The model CHANGES mid-session, which is what separates arg_max (latest)
      // from any_value (whichever row the aggregate happened to see first).
      for (let i = 0; i < 3; i++) {
        s.append(sample(SESSIONS[0], i, i === 2 ? 'claude-opus-5' : 'claude-sonnet-5',
          { project_dir: '/p/alpha', current_dir: '/p/alpha' }, '/p/alpha'), 'main', now - (3 - i) * 1000)
      }
      // A sibling whose path SHARES the target's prefix — the case a bare-prefix LIKE gets wrong.
      s.append(sample(SESSIONS[1], 0, 'claude-sonnet-5',
        { project_dir: '/p/alpha-old', current_dir: '/p/alpha-old' }, '/p/alpha-old'), 'main', now)
      // No workspace block at all, only a cwd UNDER the root — a worktree-shaped session. It must be
      // found, which is why the predicate ORs three columns instead of trusting project_dir.
      s.append(sample('c0ffee00-0000-4000-8000-000000000000', 0, 'claude-sonnet-5',
        {}, '/p/alpha/.claude/worktrees/w'), 'main', now)
      s.flush()

      const rows = await queryStatusline(root, 'main', VIEWS.project.sql(40, { project: '/p/alpha' }),
        { sinceMs: now - 3_600_000 })
      assert.ok(rows !== null, 'seeded but BLIND')
      const ids = rows.map(r => String(r.session_id)).sort()
      assert.deepStrictEqual(ids, [SESSIONS[0], 'c0ffee00-0000-4000-8000-000000000000'].sort(),
        'the sibling /p/alpha-old must be excluded and the worktree-cwd session included')
      const target = rows.find(r => r.session_id === SESSIONS[0])!
      assert.strictEqual(target.model, 'claude-opus-5', 'model must be the LATEST sample, not an arbitrary one')
      assert.strictEqual(Number(target.ctx), 3000, 'ctx is the latest reading')
      assert.strictEqual(Number(target.peak_ctx), 3000, 'peak_ctx is the high-water mark')
      assert.strictEqual(Number(target.cost_usd), 1.5, 'cost is a CUMULATIVE field — its max is its latest value')
      assert.strictEqual(Number(target.five_h_pct), 80)
      assert.strictEqual(typeof target.session_id, 'string', 'session_id must be CAST to VARCHAR')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})

// THE CLOCK AND THE COVERAGE CONTRACT.
//
// Written after a real failure on 2026-08-04: the `cache` view — THE falsifier for a claimed cache
// miss — was declared BLIND and abandoned mid-measurement while capture was live and 41s fresh. Two
// independent defects combined to produce a convincing illusion of staleness, and neither was
// visible to the type checker:
//   1. times rendered UTC under a bare `time` header, while every sibling surface renders local, so
//      on a +0200 machine the newest row always looked two hours old;
//   2. the view is RANKED by write and CAPPED by --limit, so recent low-write turns fall off the
//      list entirely and the newest row shown is unrelated to the newest row stored.
// Both are regressions a future edit could reintroduce silently, so both are pinned here.
suite('statusline-history — the clock and the coverage contract', () => {
  test('renders LOCAL wall-clock time, never UTC', () => {
    const t = Date.parse('2026-08-04T12:43:16.000Z')
    const d = new Date(t)
    const p = (x: number): string => String(x).padStart(2, '0')
    const col = VIEWS.cache.cols.find(c => c.key === 'ts')!
    assert.strictEqual(col.fmt!(t), `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
      'the cache view must print the instant\'s LOCAL wall clock')
    // On any machine actually offset from UTC, the old rendering must now be provably absent —
    // otherwise this test passes vacuously in CI (UTC) while the bug is live on a developer's box.
    if (d.getTimezoneOffset() !== 0) {
      assert.notStrictEqual(col.fmt!(t), new Date(t).toISOString().slice(11, 19),
        'a UTC render is the regression: it reads as offset-hours of staleness')
    }
  })

  test('tzLabel is the ±HHMM offset that makes the clock unambiguous', () => {
    assert.match(tzLabel(new Date('2026-08-04T12:43:16.000Z')), /^[+-]\d{4}$/,
      'must be the %z spelling this repo uses for every dated artefact')
  })

  test('every view declares how it is sorted', () => {
    for (const [name, v] of Object.entries(VIEWS)) {
      assert.ok(typeof v.sortedBy === 'string' && v.sortedBy.length > 0,
        `${name} must declare sortedBy — the footer cannot name a sort that does not exist`)
    }
  })

  test('coverageLine reports rows, sort, sample count and freshness', () => {
    const now = Date.parse('2026-08-04T12:44:00.000Z')
    const line = coverageLine(40, 'cache WRITE, largest first', { newestTs: now - 41_000, samples: 1234 }, now)
    for (const part of ['40 row(s)', 'cache WRITE, largest first', '1234 sample(s)', '41s ago']) {
      assert.ok(line.includes(part), `coverage line must carry "${part}": ${line}`)
    }
  })

  test('an unknown freshness says so rather than fabricating a timestamp', () => {
    assert.ok(coverageLine(0, 'time, newest first', { newestTs: null, samples: 0 }, Date.now())
      .includes('newest sample: unknown'))
  })

  test('storeFreshness reports the STORE\'s newest sample, not the newest row a ranked+capped view shows', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-fresh-'))
    try {
      seed(root)
      const fresh = await storeFreshness(root, 'main', {}, {})
      const all = await queryStatusline(root, 'main', 'SELECT ts FROM samples', {})
      const trueMax = Math.max(...all!.map(r => Number(r.ts)))
      assert.strictEqual(fresh.newestTs, trueMax,
        'freshness must be max(ts) over the whole window, independent of any view ranking')
      assert.strictEqual(fresh.samples, all!.length, 'and the honest sample count for that window')

      // The decisive case: rank by WRITE and cap at 1, and the single row returned is the cold
      // rewrite — NOT the newest sample. A reader taking that row's time for "now" concludes the
      // capture died. Freshness must be unaffected by the cap.
      const ranked = await queryStatusline(root, 'main', VIEWS.cache.sql(1, {}), {})
      assert.strictEqual(ranked!.length, 1)
      assert.ok(Number(ranked![0].ts) <= fresh.newestTs!,
        'the ranked view\'s row can only be older than or equal to the store\'s newest sample')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})
