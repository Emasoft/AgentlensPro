// The status-line sample store (src/statuslineStore.ts).
//
// These run against a REAL DuckDB and REAL files — no mocks. The whole point of the store is that
// samples survive a seal and a restart byte-for-byte, and a mocked filesystem cannot demonstrate
// that. What is guarded here is everything that could silently lose or mis-report samples:
//   * verify-before-delete — the WAL is the only other copy of an un-sealed chunk;
//   * the seal boundary — a query must see sealed parts AND the live WAL, with no gap;
//   * schema drift — optional blocks (pr, worktree, agent) appear and vanish mid-stream;
//   * malformed day-directory names — a name that is not calendar-real must be neither read nor
//     deleted, because a NaN day defeats a purge cutoff forever (the ndjsonBuckets trap);
//   * absence vs emptiness — no data must be reportable as BLIND, never as "nothing happened".

import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  StatuslineStore, flattenSample, dayKey, dayPartitions, relationFor, queryStatusline,
  filesInWindow, sealRows, retentionDays,
} from '../statuslineStore'

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sl-store-'))
}

/** A sample shaped like the real payload, nested exactly as Claude Code sends it. */
function sample(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: '249c4216-4db4-4b64-9a10-b994b9d7bd80',
    prompt_id: '290eac7a-8e3f-4bb7-ad3a-dba17d3210c0',
    model: { id: 'claude-opus-5', display_name: 'Opus' },
    context_window: {
      total_input_tokens: 377941, context_window_size: 1000000, used_percentage: 38,
      current_usage: { input_tokens: 2, output_tokens: 301, cache_creation_input_tokens: 503, cache_read_input_tokens: 377436 },
    },
    rate_limits: { five_hour: { used_percentage: 57.99999999999999, resets_at: 1785607800 }, seven_day: { used_percentage: 71, resets_at: 1785945600 } },
    cost: { total_cost_usd: 1196.94, total_duration_ms: 354444360 },
    ...over,
  }
}

suite('statuslineStore — flattening keeps queries simple without changing size', () => {
  test('nested objects become dotted keys', () => {
    const f = flattenSample(sample())
    assert.strictEqual(f.context_window_used_percentage, 38)
    assert.strictEqual(f.context_window_current_usage_cache_read_input_tokens, 377436)
    assert.strictEqual(f.rate_limits_five_hour_used_percentage, 57.99999999999999,
      'full float precision must survive — it is what the /api/oauth/usage integers cannot give')
    assert.strictEqual(f.model_display_name, 'Opus')
    assert.ok(!('context_window' in f), 'the nested parent must not linger beside its flattened children')
  })

  test('ARRAYS are left intact so tasks[] can be unnested', () => {
    // Flattening tasks[] into tasks_0_*, tasks_1_* would create an unbounded, drifting column space
    // — the one shape that genuinely would make this store expensive.
    const f = flattenSample({ columns: 80, tasks: [{ id: 't1', tokenCount: 42_000, cwd: '/wt' }] })
    assert.ok(Array.isArray(f.tasks))
    assert.deepStrictEqual((f.tasks as Array<Record<string, unknown>>)[0].id, 't1')
  })

  test('null and absent survive as themselves, never coerced to 0', () => {
    const f = flattenSample({ context_window: { current_usage: null }, a: 0, b: false })
    assert.strictEqual(f.context_window_current_usage, null)
    assert.strictEqual(f.a, 0)
    assert.strictEqual(f.b, false)
  })
})

suite('statuslineStore — WAL, seal, and verify-before-delete', () => {
  test('append + flush writes the day partition, and stats see it', () => {
    const root = tmpRoot()
    try {
      const s = new StatuslineStore({ root, autoTimer: false })
      for (let i = 0; i < 5; i++) s.append(sample(), 'main')
      s.flush()
      const day = dayKey(Date.now())
      const wal = path.join(root, 'main', day, `wal-${process.pid}.ndjson`)
      assert.ok(fs.existsSync(wal), `expected a WAL at ${wal}`)
      assert.strictEqual(fs.readFileSync(wal, 'utf8').trim().split('\n').length, 5)
      assert.ok(s.stats().walBytes > 0)
      assert.strictEqual(s.stats().parts, 0, 'nothing seals below the threshold')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  test('a full WAL seals to Parquet, the WAL is deleted, and every row survives', async () => {
    const root = tmpRoot()
    const prev = process.env['AGENTLENS_STATUSLINE_SEAL_ROWS']
    process.env['AGENTLENS_STATUSLINE_SEAL_ROWS'] = '20'
    try {
      const s = new StatuslineStore({ root, autoTimer: false })
      for (let i = 0; i < 25; i++) s.append(sample({ prompt_id: `p-${i}` }), 'main')
      s.flush()
      assert.strictEqual(await s.maybeSeal(), 1)

      const day = dayKey(Date.now())
      const dir = path.join(root, 'main', day)
      const parts = fs.readdirSync(dir).filter(f => f.endsWith('.parquet'))
      assert.strictEqual(parts.length, 1)
      assert.strictEqual(fs.readdirSync(dir).filter(f => f.startsWith('wal-')).length, 0,
        'the WAL is deleted only after the part is verified — but it MUST be deleted, or rows double')

      const rows = await queryStatusline(root, 'main', 'SELECT count(*) c FROM samples')
      assert.ok(rows)
      assert.strictEqual(Number(rows[0].c), 25, 'no row may be lost across the seal')
    } finally {
      if (prev === undefined) delete process.env['AGENTLENS_STATUSLINE_SEAL_ROWS']
      else process.env['AGENTLENS_STATUSLINE_SEAL_ROWS'] = prev
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('a query spans the seal boundary — sealed part AND live WAL, no gap', async () => {
    // The failure this prevents is invisible: read only the parts and every query is stale by a whole
    // chunk (~16 min at 20 instances); read only the WAL and all history vanishes at each seal.
    const root = tmpRoot()
    const prev = process.env['AGENTLENS_STATUSLINE_SEAL_ROWS']
    process.env['AGENTLENS_STATUSLINE_SEAL_ROWS'] = '10'
    try {
      const s = new StatuslineStore({ root, autoTimer: false })
      for (let i = 0; i < 12; i++) s.append(sample({ prompt_id: `sealed-${i}` }), 'main')
      s.flush()
      await s.maybeSeal()
      for (let i = 0; i < 3; i++) s.append(sample({ prompt_id: `live-${i}` }), 'main')
      s.flush()

      const { parts, wals } = filesInWindow(root, 'main')
      assert.strictEqual(parts.length, 1)
      assert.strictEqual(wals.length, 1, 'a fresh WAL exists beside the sealed part')

      const rows = await queryStatusline(root, 'main', 'SELECT count(*) c FROM samples')
      assert.strictEqual(Number(rows![0].c), 15, 'both halves must be visible at once')
    } finally {
      if (prev === undefined) delete process.env['AGENTLENS_STATUSLINE_SEAL_ROWS']
      else process.env['AGENTLENS_STATUSLINE_SEAL_ROWS'] = prev
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('a PAST day seals regardless of size, so old partitions stop costing raw-JSON reads', async () => {
    const root = tmpRoot()
    try {
      const s = new StatuslineStore({ root, autoTimer: false })
      const yesterday = Date.now() - 86_400_000
      s.append(sample(), 'main', yesterday)
      s.flush()
      // flush() partitions by NOW, so place the WAL in yesterday's dir explicitly.
      const today = path.join(root, 'main', dayKey(Date.now()))
      const yDir = path.join(root, 'main', dayKey(yesterday))
      fs.mkdirSync(yDir, { recursive: true })
      for (const f of fs.readdirSync(today).filter(n => n.startsWith('wal-'))) {
        fs.renameSync(path.join(today, f), path.join(yDir, f))
      }
      assert.strictEqual(await s.maybeSeal(), 1, 'one record from a past day still seals')
      assert.strictEqual(fs.readdirSync(yDir).filter(f => f.endsWith('.parquet')).length, 1)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  test('an ORPHANED WAL from a dead pid seals immediately, whatever its size', async () => {
    // WALs are named per-pid, so every server restart strands one. Three restarts on this machine
    // left 9.4 MB of raw JSON that would have stayed unsealed until midnight — re-read in full by
    // every query, and never compressed.
    const root = tmpRoot()
    try {
      const s = new StatuslineStore({ root, autoTimer: false })
      s.append(sample(), 'main')
      s.flush()
      const dir = path.join(root, 'main', dayKey(Date.now()))
      const mine = path.join(dir, `wal-${process.pid}.ndjson`)
      const orphan = path.join(dir, 'wal-999999.ndjson')
      fs.renameSync(mine, orphan)

      assert.strictEqual(await s.maybeSeal(), 1, 'a one-row orphan still seals')
      assert.ok(!fs.existsSync(orphan), 'the orphan WAL is consumed')
      assert.strictEqual(fs.readdirSync(dir).filter(f => f.endsWith('.parquet')).length, 1)
      const rows = await queryStatusline(root, 'main', 'SELECT count(*) c FROM samples')
      assert.strictEqual(Number(rows![0].c), 1, 'and its row survived the seal')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  test('OUR OWN under-full WAL is left alone — it is still being written to', () => {
    const root = tmpRoot()
    try {
      const s = new StatuslineStore({ root, autoTimer: false })
      s.append(sample(), 'main')
      s.flush()
      const wal = path.join(root, 'main', dayKey(Date.now()), `wal-${process.pid}.ndjson`)
      assert.ok(fs.existsSync(wal), 'sealing our own live WAL at 1 row would defeat the whole chunking scheme')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  test('schema drift is tolerated — an optional block appearing mid-stream does not break reads', async () => {
    // pr / worktree / agent come and go, and a future Claude Code version may add fields. Without
    // union_by_name the second shape would fail the whole query rather than widen it.
    const root = tmpRoot()
    try {
      const s = new StatuslineStore({ root, autoTimer: false })
      s.append(sample(), 'main')
      s.append(sample({ worktree: { name: 'wt', branch: 'feat/x' }, agent: { name: 'Explore' } }), 'main')
      s.flush()
      const rows = await queryStatusline(root, 'main', 'SELECT count(*) c, count(worktree_name) w FROM samples')
      assert.strictEqual(Number(rows![0].c), 2)
      assert.strictEqual(Number(rows![0].w), 1, 'the widened column is present and null for the older shape')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  test('the subagent stream keeps tasks[] queryable via unnest', async () => {
    const root = tmpRoot()
    try {
      const s = new StatuslineStore({ root, autoTimer: false })
      s.append({
        columns: 120,
        tasks: [
          { id: 't1', name: 'Explore', model: 'claude-sonnet-5', effort: 'medium', contextWindowSize: 1000000, tokenCount: 42000, cwd: '/repo' },
          { id: 't2', name: 'Plan', model: 'claude-opus-5', effort: 'high', contextWindowSize: 1000000, tokenCount: 130000, cwd: '/repo/.claude/worktrees/feat-x' },
        ],
      }, 'subagent')
      s.flush()
      const rows = await queryStatusline(root, 'subagent',
        `SELECT t.id AS id, t.tokenCount AS tok, t.cwd AS cwd
         FROM samples, unnest(tasks) AS u(t) ORDER BY tok DESC`)
      assert.strictEqual(rows!.length, 2)
      assert.strictEqual(String(rows![0].id), 't2')
      assert.strictEqual(Number(rows![0].tok), 130000)
      assert.ok(String(rows![0].cwd).includes('worktrees'), 'cwd is what distinguishes a worktree agent')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})

suite('statuslineStore — a non-UUID session id must not blind every view', () => {
  // FOUND LIVE: three of five statusline-history views were dead with
  // `Conversion Error: Could not convert string 'x' to INT128`, from ONE row.
  // DuckDB infers a UUID-SHAPED string as the UUID type PER FILE: sealed parts had inferred UUID,
  // the live WAL held a non-UUID id and inferred VARCHAR, and UNION ALL BY NAME reconciled the two
  // to UUID. The failure is in the union, so a CAST in the SELECT list cannot reach it.

  test('a sealed (UUID-inferred) part unions with a WAL holding a NON-UUID id', async () => {
    const root = tmpRoot()
    const prev = process.env['AGENTLENS_STATUSLINE_SEAL_ROWS']
    process.env['AGENTLENS_STATUSLINE_SEAL_ROWS'] = '3'
    try {
      const s = new StatuslineStore({ root, autoTimer: false })
      // Part 1: every id UUID-shaped ⇒ DuckDB seals it as a UUID column.
      for (let i = 0; i < 3; i++) s.append(sample({ prompt_id: `p-${i}` }), 'main', Date.now() - 10_000 + i)
      s.flush()
      assert.strictEqual(await s.maybeSeal(), 1, 'precondition: the part sealed')
      // Then a live WAL row whose session id is NOT UUID-shaped.
      s.append(sample({ session_id: 'x' }), 'main', Date.now())
      s.flush()

      const rows = await queryStatusline(root, 'main',
        'SELECT session_id, count(*) n FROM samples GROUP BY session_id ORDER BY n DESC')
      assert.ok(rows, 'store seeded but read BLIND')
      assert.strictEqual(rows.length, 2, 'both the sealed UUID session and the non-UUID one')
      const ids = rows.map(r => String(r.session_id))
      assert.ok(ids.includes('x'), "the non-UUID id must survive as 'x', not error and not vanish")
      assert.ok(ids.includes('249c4216-4db4-4b64-9a10-b994b9d7bd80'),
        'a UUID must come back as its canonical TEXT, not as a {hugeint} object')
      assert.ok(rows.every(r => typeof r.session_id === 'string'),
        'session_id must be VARCHAR everywhere — an object is truthy and sails through a check')
    } finally {
      if (prev === undefined) delete process.env['AGENTLENS_STATUSLINE_SEAL_ROWS']
      else process.env['AGENTLENS_STATUSLINE_SEAL_ROWS'] = prev
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('a LEGACY UUID-typed part and a new VARCHAR-typed part coexist', async () => {
    // THE REGRESSION THIS SUITE EXISTS FOR. The first fix normalized the OUTPUT of a multi-file
    // `read_parquet([...])`, which is too late: that reader resolves ONE schema across its whole file
    // list — taking it from the first file — and when a UUID-typed part meets a VARCHAR-typed one it
    // coerces to UUID, failing INSIDE the reader with `failed to cast column "session_id" from type
    // VARCHAR to UUID`. Sealing as VARCHAR stops NEW parts being UUID, but parts written before that
    // fix are on disk for the whole 90-day retention, so the reader must tolerate a mixed store
    // permanently. Hence one normalized relation per FILE.
    const root = tmpRoot()
    const prev = process.env['AGENTLENS_STATUSLINE_SEAL_ROWS']
    process.env['AGENTLENS_STATUSLINE_SEAL_ROWS'] = '3'
    try {
      const s = new StatuslineStore({ root, autoTimer: false })
      for (let i = 0; i < 3; i++) s.append(sample({ prompt_id: `p-${i}` }), 'main', Date.now() - 10_000 + i)
      s.flush()
      assert.strictEqual(await s.maybeSeal(), 1)          // a NEW part: VARCHAR
      const dir = path.join(root, 'main', dayKey(Date.now()))

      // Hand-write a LEGACY part exactly as the pre-fix seal did: no cast, so DuckDB's own inference
      // types the UUID-shaped column as UUID. Writing it any other way would not reproduce the bug.
      const legacyWal = path.join(dir, 'legacy-src.ndjson')
      fs.writeFileSync(legacyWal, `${JSON.stringify({ ts: Date.now() - 5_000, session_id: '249c4216-4db4-4b64-9a10-b994b9d7bd80', v: 1 })}\n`)
      const { DuckDBInstance } = await import('@duckdb/node-api')
      const inst = await DuckDBInstance.create(':memory:')
      const con = await inst.connect()
      const legacyPart = path.join(dir, 'part-1-legacy-0.parquet')
      await con.run(`COPY (SELECT * FROM read_json_auto('${legacyWal}')) TO '${legacyPart}' (FORMAT PARQUET, COMPRESSION ZSTD)`)
      const t = (await con.runAndReadAll(`SELECT typeof(session_id) t FROM read_parquet('${legacyPart}')`)).getRowObjects()[0].t
      con.closeSync(); inst.closeSync()
      fs.unlinkSync(legacyWal)
      assert.strictEqual(String(t), 'UUID', 'precondition: the legacy part really is UUID-typed')

      // The non-UUID id must end up INSIDE A PART, not merely in the WAL. That distinction is what
      // makes this test non-vacuous: with `x` only in the WAL, the parquet branch still holds nothing
      // but UUID-shaped strings, the VARCHAR→UUID cast succeeds, and the broken code passes.
      for (let i = 0; i < 3; i++) s.append(sample({ session_id: 'x', prompt_id: `q-${i}` }), 'main', Date.now() + i)
      s.flush()
      assert.strictEqual(await s.maybeSeal(), 1, 'precondition: the non-UUID id is sealed into a part')
      assert.ok(fs.readdirSync(dir).filter(f => f.endsWith('.parquet')).length >= 3,
        'precondition: three parts on disk — legacy UUID, new VARCHAR, and the non-UUID one')

      const rows = await queryStatusline(root, 'main', 'SELECT DISTINCT session_id FROM samples')
      assert.ok(rows, 'mixed-type store read BLIND')
      const ids = rows.map(r => String(r.session_id)).sort()
      assert.deepStrictEqual(ids, ['249c4216-4db4-4b64-9a10-b994b9d7bd80', 'x'],
        'the legacy UUID part, the new VARCHAR part and the non-UUID WAL row must all read')
      assert.ok(rows.every(r => typeof r.session_id === 'string'))
    } finally {
      if (prev === undefined) delete process.env['AGENTLENS_STATUSLINE_SEAL_ROWS']
      else process.env['AGENTLENS_STATUSLINE_SEAL_ROWS'] = prev
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('a column NO file in the window carries still BINDS — absence is empty, not an error', async () => {
    // `union_by_name` fills a column SOME file has; a column NO file has simply does not exist, and
    // referencing it is `Binder Error: Referenced column "..." not found in FROM clause`. MEASURED:
    // one sample lacking the optional `rate_limits` and `current_usage` blocks — what an older Claude
    // Code build, or any turn before those blocks existed, produces — killed ALL FIVE main-stream
    // views. That breaks this module's own contract: no data reads as BLIND, never as a crash.
    const root = tmpRoot()
    try {
      const s = new StatuslineStore({ root, autoTimer: false })
      s.append({ session_id: '249c4216-4db4-4b64-9a10-b994b9d7bd80', model: { id: 'claude-opus-5' } }, 'main', Date.now())
      s.flush()
      const rows = await queryStatusline(root, 'main', `
        SELECT count(*) n,
               count(rate_limits_five_hour_used_percentage)                 rl,
               count(context_window_current_usage_cache_read_input_tokens)  cu,
               count(model_display_name)                                    md,
               count(cost_total_cost_usd)                                   c
        FROM samples`)
      assert.ok(rows, 'a sample without the optional blocks must not read BLIND')
      assert.strictEqual(Number(rows[0].n), 1)
      for (const k of ['rl', 'cu', 'md', 'c']) {
        assert.strictEqual(Number(rows[0][k]), 0, `${k}: an unobserved column binds and is NULL`)
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  test('a source with NO session_id column at all does not break the query', async () => {
    // The normalization uses `* REPLACE`, which is a BINDER error when the column is absent — so a
    // malformed WAL would trade one total failure for another without the zero-row typed template.
    const root = tmpRoot()
    try {
      const dir = path.join(root, 'main', dayKey(Date.now()))
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'wal-99999.ndjson'), `${JSON.stringify({ ts: Date.now(), foo: 2 })}\n`)
      const rows = await queryStatusline(root, 'main', 'SELECT count(*) n, count(session_id) nn FROM samples')
      assert.ok(rows)
      assert.strictEqual(Number(rows[0].n), 1)
      assert.strictEqual(Number(rows[0].nn), 0, 'the column exists and is NULL, rather than not binding')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  test('a sealed part stores session_id as VARCHAR, so no later repair is needed', async () => {
    // The ROOT fix. Repairing at read time works, but every seal of an all-UUID WAL would otherwise
    // mint another UUID-typed part and the repair would be load-bearing forever.
    const root = tmpRoot()
    const prev = process.env['AGENTLENS_STATUSLINE_SEAL_ROWS']
    process.env['AGENTLENS_STATUSLINE_SEAL_ROWS'] = '3'
    try {
      const s = new StatuslineStore({ root, autoTimer: false })
      for (let i = 0; i < 3; i++) s.append(sample({ prompt_id: `p-${i}` }), 'main', Date.now() - 10_000 + i)
      s.flush()
      assert.strictEqual(await s.maybeSeal(), 1)
      // Read the PART directly: through `samples` the read-time repair would mask a UUID column.
      const day = dayKey(Date.now())
      const part = fs.readdirSync(path.join(root, 'main', day)).find(f => f.endsWith('.parquet'))!
      const rows = await queryStatusline(root, 'main',
        `SELECT typeof(session_id) t FROM read_parquet('${path.join(root, 'main', day, part)}') LIMIT 1`)
      assert.strictEqual(String(rows![0].t), 'VARCHAR')
    } finally {
      if (prev === undefined) delete process.env['AGENTLENS_STATUSLINE_SEAL_ROWS']
      else process.env['AGENTLENS_STATUSLINE_SEAL_ROWS'] = prev
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

suite('statuslineStore — absence, malformed partitions, and retention', () => {
  test('an empty store reads as BLIND (null), never as an empty result set', async () => {
    // The distinction is the whole honesty contract: "no rows" from a store with no data means we
    // cannot see, not that nothing burned. It is also why a bare glob is never handed to DuckDB —
    // an empty glob is an ERROR there, not an empty set.
    const root = tmpRoot()
    try {
      assert.strictEqual(relationFor(root, 'main'), null)
      assert.strictEqual(await queryStatusline(root, 'main', 'SELECT count(*) FROM samples'), null)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  test('a record filed under the NEXT day is still found by a window covering its own day', async () => {
    // flush() files a whole batch under the day it is WRITTEN, so a batch appended just before UTC
    // midnight and flushed just after puts those records in the NEXT day's partition. Partition
    // selection is by day, so without slack a query for the earlier day skips that partition and the
    // records vanish — and it returned BLIND, which in this module means "we cannot see", for data
    // that existed and matched. Reporting absence as blindness is the one failure this store must
    // not have, so the slack in filesInWindow and the batch-partitioning in flush() are a PAIR.
    const root = tmpRoot()
    try {
      const tsInDayN = Date.UTC(2026, 6, 10, 23, 59, 50)
      const writtenDay = dayKey(Date.UTC(2026, 6, 11, 0, 0, 5))     // flushed 15 s later, next UTC day
      const dir = path.join(root, 'main', writtenDay)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'wal-1.ndjson'),
        `${JSON.stringify({ ts: tsInDayN, session_id: '249c4216-4db4-4b64-9a10-b994b9d7bd80', cost_total_cost_usd: 1 })}\n`)

      const rows = await queryStatusline(root, 'main', 'SELECT count(*) n FROM samples',
        { sinceMs: Date.UTC(2026, 6, 10), untilMs: Date.UTC(2026, 6, 10, 23, 59, 59) })
      assert.ok(rows, 'a record inside the window must never read as BLIND because of its partition')
      assert.strictEqual(Number(rows[0].n), 1)

      // The slack widens FILE selection only — rows are still filtered on ts, so a genuinely
      // out-of-window row from a slack-admitted partition must NOT come back.
      const none = await queryStatusline(root, 'main', 'SELECT count(*) n FROM samples',
        { sinceMs: Date.UTC(2026, 6, 11), untilMs: Date.UTC(2026, 6, 11, 23, 59) })
      assert.ok(none, 'the partition is admitted by slack, so this is a real look, not BLIND')
      assert.strictEqual(Number(none[0].n), 0, 'but the row itself is outside the window and filtered out')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  test('a calendar-invalid day directory is neither read nor deleted', () => {
    // '2026-13-99' matches a naive \d{4}-\d{2}-\d{2} regex but parses to NaN, and NaN silently
    // defeats both the read window and the purge cutoff — an unpurgeable directory forever.
    const root = tmpRoot()
    try {
      for (const bad of ['2026-13-99', '2026-02-31', 'not-a-day', '2026-01-01.bak']) {
        fs.mkdirSync(path.join(root, 'main', bad), { recursive: true })
        fs.writeFileSync(path.join(root, 'main', bad, 'wal-1.ndjson'), '{"ts":1}\n')
      }
      assert.deepStrictEqual(dayPartitions(root, 'main'), [], 'none of these are ours')

      const s = new StatuslineStore({ root, autoTimer: false })
      const r = s.purge(0)
      assert.deepStrictEqual(r.removed, [], 'a foreign/malformed directory must never be deleted')
      for (const bad of ['2026-13-99', '2026-02-31', 'not-a-day', '2026-01-01.bak']) {
        assert.ok(fs.existsSync(path.join(root, 'main', bad)), `${bad} must survive`)
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  test('purge removes whole expired partitions and keeps current ones', () => {
    const root = tmpRoot()
    try {
      const s = new StatuslineStore({ root, autoTimer: false })
      const old = dayKey(Date.now() - 120 * 86_400_000)
      const recent = dayKey(Date.now() - 1 * 86_400_000)
      for (const d of [old, recent]) {
        fs.mkdirSync(path.join(root, 'main', d), { recursive: true })
        fs.writeFileSync(path.join(root, 'main', d, 'wal-1.ndjson'), '{"ts":1}\n')
      }
      const r = s.purge(90)
      assert.deepStrictEqual(r.removed, [path.join('main', old)])
      assert.ok(r.freedBytes > 0)
      assert.ok(fs.existsSync(path.join(root, 'main', recent)), 'inside the window must survive')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  test('the tunables default sanely and reject junk', () => {
    assert.strictEqual(retentionDays({} as NodeJS.ProcessEnv), 90)
    assert.strictEqual(retentionDays({ AGENTLENS_STATUSLINE_RETENTION_DAYS: 'soon' } as unknown as NodeJS.ProcessEnv), 90,
      'a non-numeric knob must fall back, not become NaN and purge everything or nothing')
    assert.strictEqual(retentionDays({ AGENTLENS_STATUSLINE_RETENTION_DAYS: '7' } as unknown as NodeJS.ProcessEnv), 7)
    assert.strictEqual(sealRows({} as NodeJS.ProcessEnv), 10_000)
    assert.strictEqual(sealRows({ AGENTLENS_STATUSLINE_SEAL_ROWS: '0' } as unknown as NodeJS.ProcessEnv), 10_000)
  })

  test('a time window filters rows, and ts is always present to filter on', async () => {
    const root = tmpRoot()
    try {
      const s = new StatuslineStore({ root, autoTimer: false })
      const t0 = Date.now()
      s.append(sample({ prompt_id: 'a' }), 'main', t0 - 10_000)
      s.append(sample({ prompt_id: 'b' }), 'main', t0)
      s.flush()
      const rows = await queryStatusline(root, 'main', 'SELECT count(*) c FROM samples', { sinceMs: t0 - 1000 })
      assert.strictEqual(Number(rows![0].c), 1, 'the payload carries no timestamp — the store must stamp one')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})
