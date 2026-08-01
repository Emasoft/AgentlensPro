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
