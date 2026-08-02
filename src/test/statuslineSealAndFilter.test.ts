// Greptile PR#6 hardening (2026-08-02): LIKE-wildcard escape, subagent-stream filtering, corrupt-WAL
// visibility, and live-WAL rotation. All against a REAL DuckDB and REAL files — the store's standing
// rule (a mocked filesystem cannot demonstrate that samples survive a seal).

import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { StatuslineStore, queryStatusline } from '../statuslineStore'
import { VIEWS, projectPredicate } from '../cli/statuslineHistoryCli'

function mkRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'al-seal-filter-'))
}

/** BigInt-safe stringify for assertion MESSAGES — DuckDB returns BIGINT columns as BigInt, and a
 *  plain JSON.stringify in a message argument throws BEFORE the assertion even runs. */
function js(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x))
}

suite('projectPredicate — a path is a literal, not a pattern', () => {
  test('escapes _ and % so /a/my_project cannot match /a/myXproject', () => {
    const p = projectPredicate('/a/my_project')
    assert.ok(p.includes("LIKE '/a/my\\_project/%' ESCAPE '\\'"), p)
    assert.ok(p.includes("= '/a/my_project'"), 'the exact-match arm keeps the raw path')
  })

  test('behavioral: an underscore path filters to itself only (real DuckDB)', async () => {
    const root = mkRoot()
    try {
      const s = new StatuslineStore({ root, autoTimer: false })
      const now = Date.now()
      s.append({ session_id: '249c4216-4db4-4b64-9a10-b994b9d7bd80', cwd: '/a/my_project/sub', cost: { total_cost_usd: 1 } }, 'main', now)
      s.append({ session_id: '667293ab-cf8d-4640-a69e-a406ba19e2b4', cwd: '/a/myXproject/sub', cost: { total_cost_usd: 2 } }, 'main', now)
      s.flush()
      const rows = await queryStatusline(root, 'main', VIEWS.sessions.sql(10, { project: '/a/my_project' }), { sinceMs: now - 60_000 })
      assert.ok(rows !== null, 'seeded but BLIND')
      assert.strictEqual(rows.length, 1, js(rows))
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})

suite('subagents view — --project and --session filter on the stream\'s real top-level columns', () => {
  test('project filter keeps agents whose PARENT cwd is under the root, drops others', async () => {
    const root = mkRoot()
    try {
      const s = new StatuslineStore({ root, autoTimer: false })
      const now = Date.now()
      const task = (id: string): Record<string, unknown> => ({
        id, type: 'local_agent', status: 'running', description: 'worker', label: 'working',
        startTime: now - 1000, model: 'claude-sonnet-5', effort: 'medium',
        contextWindowSize: 1_000_000, tokenCount: 50_000, tokenSamples: [50_000],
        cwd: '/a/my_project/.claude/worktrees/w1',
      })
      // The LIVE subagent payload shape: top-level session_id + cwd (the parent's) are present,
      // workspace.* absent — measured 6,740/6,740 and 6,737/6,740 on the real store 2026-08-02.
      s.append({ session_id: '249c4216-4db4-4b64-9a10-b994b9d7bd80', cwd: '/a/my_project', tasks: [task('ag1')] }, 'subagent', now)
      s.append({ session_id: '667293ab-cf8d-4640-a69e-a406ba19e2b4', cwd: '/b/other', tasks: [task('ag2')] }, 'subagent', now)
      s.flush()
      const hit = await queryStatusline(root, 'subagent', VIEWS.subagents.sql(10, { project: '/a/my_project' }), { sinceMs: now - 60_000 })
      assert.ok(hit !== null, 'seeded but BLIND')
      assert.strictEqual(hit.length, 1, js(hit))
      assert.strictEqual(String(hit[0].agent_id), 'ag1')
      const bySession = await queryStatusline(root, 'subagent', VIEWS.subagents.sql(10, { session: '667293ab-cf8d-4640-a69e-a406ba19e2b4' }), { sinceMs: now - 60_000 })
      assert.ok(bySession !== null)
      assert.strictEqual(bySession.length, 1, js(bySession))
      assert.strictEqual(String(bySession[0].agent_id), 'ag2')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})

suite('seal path — corruption is visible, the live WAL is rotated', () => {
  test('a torn line seals as a NULL row — counted in corruptWals, never silent', async () => {
    const root = mkRoot()
    try {
      const s = new StatuslineStore({ root, autoTimer: false })
      const dir = path.join(root, 'main', '2020-01-01')          // a past day → sealed regardless of size
      fs.mkdirSync(dir, { recursive: true })
      const wal = path.join(dir, 'wal-999999.ndjson')            // an orphan pid — never rotated
      const good = (sid: string, ts: number): string => JSON.stringify({ session_id: sid, ts })
      // MEASURED DuckDB behavior, which overturned the reviewer's premise: ignore_errors does NOT
      // drop an unparseable line — it lands as an all-NULL row, so the count verify PASSES and the
      // seal proceeds. The store's contract is therefore not "refuse", but "never silently": the
      // NULL row is detected via count(ts) and counted in corruptWals.
      fs.writeFileSync(wal, `${good('aaaa', 1)}\n${good('bbbb', 2)}\n{"session_id": "cccc", "ts": }\n`)
      const sealed = await s.maybeSeal(Date.now())
      assert.strictEqual(sealed, 1, 'the seal proceeds — the torn line becomes a NULL row')
      assert.ok(!fs.existsSync(wal), 'the WAL is gone — its rows (incl. the NULL one) are in the part')
      assert.strictEqual(s.stats().corruptWals, 1, 'the degradation must be VISIBLE, not silent')
      const rows = await queryStatusline(root, 'main', 'SELECT count(*) c, count(ts) ct FROM samples', {})
      assert.ok(rows !== null)
      assert.strictEqual(Number(rows![0].c), 3, 'all three source lines are accounted for')
      assert.strictEqual(Number(rows![0].ct), 2, 'exactly the torn line lacks ts')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  test('our own live WAL is rotated before sealing and still seals completely', async () => {
    const root = mkRoot()
    const prev = process.env.AGENTLENS_STATUSLINE_SEAL_ROWS
    process.env.AGENTLENS_STATUSLINE_SEAL_ROWS = '2'
    try {
      const s = new StatuslineStore({ root, autoTimer: false })
      const now = Date.now()
      for (let i = 0; i < 3; i++) {
        s.append({ session_id: `249c4216-4db4-4b64-9a10-b994b9d7bd8${i}`, cost: { total_cost_usd: i } }, 'main', now)
      }
      s.flush()
      const sealed = await s.maybeSeal(now)
      assert.strictEqual(sealed, 1, 'the full live WAL must seal (through the rotation)')
      const stream = path.join(root, 'main')
      const dayDir = path.join(stream, fs.readdirSync(stream)[0])
      const left = fs.readdirSync(dayDir)
      assert.ok(left.some(f => f.endsWith('.parquet')), `a part must exist: ${left.join(', ')}`)
      assert.ok(!left.some(f => f.endsWith('.ndjson')), `no WAL (live or rotated) may remain: ${left.join(', ')}`)
      const rows = await queryStatusline(root, 'main', 'SELECT count(*) c FROM samples', { sinceMs: now - 60_000 })
      assert.ok(rows !== null)
      assert.strictEqual(Number(rows![0].c), 3, 'every appended row must be in the part')
    } finally {
      if (prev === undefined) delete process.env.AGENTLENS_STATUSLINE_SEAL_ROWS; else process.env.AGENTLENS_STATUSLINE_SEAL_ROWS = prev
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
