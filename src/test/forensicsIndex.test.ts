import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  scanApiCallEvents, indexApiCalls, resolveSpawn, loadSpawnMap,
  classifyEffort, computeFrontmatterFp, extractInjections, deriveContentTags, type SpawnRow,
} from '../forensicsIndex'
import type { CallComposition } from '../contextCompositionIndex'
import {
  openForensicsDb, openReadonlyForensicsSnapshot, loadSqlJs,
  billableWeight, tierClassify, DEFAULT_FORENSICS_DB, DEFAULT_MAIN_DB, type SqlDatabase,
} from '../forensicsDb'

// TRDD-FB5RG4P1 Phase 1 — REAL tests: no mocked bodies, no mocked join, no mocked DB. Every test
// writes real request/response JSON to a tmp otel-bodies dir + a real sql.js main DB with a sessions
// table, then drives the ACTUAL bounded scan → previous_message_id join → spawn resolve → fact insert.
// The only skip-if-absent test reads the machine's real ~/.agentlens (absent in CI).

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fal-p1-'))
const bodiesDir = path.join(tmpRoot, 'otel-bodies')
const forensicsDbPath = path.join(tmpRoot, 'forensics.db')
const mainDbPath = path.join(tmpRoot, 'agentlens.db')
fs.mkdirSync(bodiesDir, { recursive: true })
suiteTeardown(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* best effort */ } })

let counter = 0
function writeBody(suffix: 'request' | 'response', body: unknown): string {
  const p = path.join(bodiesDir, `${++counter}.${suffix}.json`)
  fs.writeFileSync(p, JSON.stringify(body))
  return p
}
function responseBody(id: string, u: { input?: number; output?: number; cacheRead?: number; cc?: number; e5m?: number; e1h?: number; model?: string }): void {
  writeBody('response', {
    id, model: u.model ?? 'claude-opus-4-8',
    usage: {
      input_tokens: u.input ?? 0, output_tokens: u.output ?? 0,
      cache_read_input_tokens: u.cacheRead ?? 0, cache_creation_input_tokens: u.cc ?? 0,
      cache_creation: (u.e5m !== undefined || u.e1h !== undefined)
        ? { ephemeral_5m_input_tokens: u.e5m ?? 0, ephemeral_1h_input_tokens: u.e1h ?? 0 } : undefined,
    },
  })
}
function requestBody(prev: string, o: { session?: string; account?: string; model?: string; budget?: number; withRule?: boolean }): void {
  const system: unknown[] = [{ type: 'text', text: 'You are a helpful assistant.' }]
  if (o.withRule) {
    system.push({ type: 'text', text: 'Contents of /Users/x/.claude/rules/never-git-add-all.md (private):\n- rule body' })
    system.push({ type: 'text', text: 'Contents of /repo/CLAUDE.md (project):\n# CLAUDE.md\nstuff' })
  }
  writeBody('request', {
    model: o.model ?? 'claude-opus-4-8',
    metadata: { user_id: JSON.stringify({ device_id: 'dev', account_uuid: o.account ?? 'acct-1', session_id: o.session }) },
    diagnostics: { previous_message_id: prev },
    thinking: o.budget !== undefined ? { type: 'enabled', budget_tokens: o.budget } : undefined,
    system,
    tools: [{ name: 'Bash' }, { name: 'Read' }, { name: 'Edit' }],
  })
}

// Build a real main agentlens.db with a sessions table carrying spawn config.
async function buildMainDb(): Promise<void> {
  const SQL = await loadSqlJs()
  assert.ok(SQL, 'sql.js must resolve in the test runner')
  const db = new SQL!.Database()
  db.run(`CREATE TABLE sessions (session_id TEXT PRIMARY KEY, spawn_kind TEXT, spawn_model_override TEXT,
          spawn_isolation TEXT, is_sidechain INTEGER, parent_session_id TEXT, model TEXT)`)
  db.run(`INSERT INTO sessions VALUES ('sess-fork','fork',NULL,NULL,1,'sess-root','claude-opus-4-8')`)
  db.run(`INSERT INTO sessions VALUES ('sess-wt','worktree',NULL,'worktree',1,'sess-root','claude-opus-4-8')`)
  db.run(`INSERT INTO sessions VALUES ('sess-root',NULL,NULL,NULL,0,NULL,'claude-opus-4-8')`)
  fs.writeFileSync(mainDbPath, Buffer.from(db.export()))
  db.close()
}

function queryOne(db: SqlDatabase, sql: string): Record<string, unknown> | null {
  const st = db.prepare(sql)
  try { return st.step() ? st.getAsObject() : null } finally { st.free() }
}

suite('FAL Phase 1 — pure helpers', () => {
  test('classifyEffort buckets thinking budget into none/low/medium/high', () => {
    assert.equal(classifyEffort(undefined), 'none')
    assert.equal(classifyEffort(0), 'none')
    assert.equal(classifyEffort(4096), 'low')
    assert.equal(classifyEffort(16384), 'medium')
    assert.equal(classifyEffort(31999), 'high')
  })

  test('tierClassify maps the CCFORNSC gap taxonomy (null→COLD, <4.5→BREAK, 5m/1h windows)', () => {
    assert.equal(tierClassify(null), 'COLD')
    assert.equal(tierClassify(2), 'BREAK')
    assert.equal(tierClassify(5), 'TTL_5m')
    assert.equal(tierClassify(30), 'MID')
    assert.equal(tierClassify(120), 'TTL_1h')
  })

  test('billableWeight returns 0 for an unknown model and a positive weighted cost for a known one', () => {
    assert.equal(billableWeight(1000, 500, 200, 50, 300, 'totally-unknown-model'), 0)
    assert.ok(billableWeight(1000, 500, 200, 50, 300, 'claude-opus-4-8') > 0)
  })

  test('computeFrontmatterFp is stable + differs when the rule/claudemd set differs', () => {
    const a = computeFrontmatterFp({ tools: [{ name: 'Bash' }], system: 'plain system' })
    const b = computeFrontmatterFp({ tools: [{ name: 'Bash' }], system: 'plain system' })
    const c = computeFrontmatterFp({ tools: [{ name: 'Bash' }], system: [{ type: 'text', text: 'Contents of /x/.claude/rules/foo.md (p)\n' }] })
    assert.equal(a, b)
    assert.notEqual(a, c)
    assert.equal(computeFrontmatterFp({}), undefined)
  })
})

suite('FAL Phase 1 — spawn resolver ladder', () => {
  const map = new Map<string, SpawnRow>([
    ['sess-fork', { spawnKind: 'fork', isSidechain: true, parentSessionId: 'sess-root' }],
    ['sess-root', { spawnKind: undefined, isSidechain: false, parentSessionId: undefined }],
    ['sess-childless-kind', { spawnKind: undefined, isSidechain: true, parentSessionId: 'sess-root' }],
  ])

  test('direct: a row with a spawn_kind resolves direct + copies the kind', () => {
    const r = resolveSpawn('sess-fork', map)
    assert.equal(r.spawnResolution, 'direct')
    assert.equal(r.spawnKind, 'fork')
    assert.equal(r.isSidechain, 1)
  })
  test('root: a kind-less row with no parent synthesizes root', () => {
    const r = resolveSpawn('sess-root', map)
    assert.equal(r.spawnResolution, 'root')
    assert.equal(r.spawnKind, 'root')
  })
  test('unresolved: no session_id and no matching row are both honest unresolved buckets (never fabricated)', () => {
    assert.equal(resolveSpawn(undefined, map).spawnResolution, 'unresolved')
    assert.equal(resolveSpawn('never-seen', map).spawnResolution, 'unresolved')
    assert.equal(resolveSpawn('never-seen', map).spawnKind, null)
  })
  test('a kind-less child row matches direct but keeps spawn_kind null (never guessed)', () => {
    const r = resolveSpawn('sess-childless-kind', map)
    assert.equal(r.spawnResolution, 'direct')
    assert.equal(r.spawnKind, null)
    assert.equal(r.parentSession, 'sess-root')
  })
})

suite('FAL Phase 1 — end-to-end index over real bodies + real main DB', () => {
  suiteSetup(async () => {
    // R1: fork session, cache_creation split, high effort, rules present.
    responseBody('msg_R1', { input: 300, output: 50, cacheRead: 200, cc: 1500, e5m: 1000, e1h: 500 })
    requestBody('msg_R1', { session: 'sess-fork', budget: 30000, withRule: true })
    // R2: root session, cache-READ-ONLY (cc=0) — proves ALL usage is kept, not just cc>0.
    responseBody('msg_R2', { input: 10, output: 10, cacheRead: 5000, cc: 0 })
    requestBody('msg_R2', { session: 'sess-root', budget: 0 })
    // R3: session present but NOT in the sessions map → unresolved.
    responseBody('msg_R3', { input: 100, output: 5 })
    requestBody('msg_R3', { session: 'sess-ghost', budget: 4096 })
    // R4: NO following request → unattributed (session_id null → unresolved).
    responseBody('msg_R4', { input: 20, output: 3 })
    // R5: worktree session.
    responseBody('msg_R5', { input: 40, output: 8, cc: 900, e5m: 900 })
    requestBody('msg_R5', { session: 'sess-wt', budget: 12000 })
    await buildMainDb()
  })

  test('scanApiCallEvents keeps every response with a usage block (incl. cache-read-only and unattributed)', async () => {
    const { events, coverage } = await scanApiCallEvents({ bodiesDir })
    assert.equal(coverage.dirExists, true)
    const ids = events.map(e => e.callId).sort()
    assert.deepEqual(ids, ['msg_R1', 'msg_R2', 'msg_R3', 'msg_R4', 'msg_R5'])
    const r2 = events.find(e => e.callId === 'msg_R2')!
    assert.equal(r2.cacheCreationTokens, 0)
    assert.equal(r2.cacheReadTokens, 5000)
    const r4 = events.find(e => e.callId === 'msg_R4')!
    assert.equal(r4.attributed, false)
    assert.equal(r4.sessionId, undefined)
  })

  test('indexApiCalls writes fact rows with correct tokens/tiers/spawn_resolution/cost/effort', async () => {
    const res = await indexApiCalls({ bodiesDir, forensicsDbPath, mainDbPath })
    assert.equal(res.dbAvailable, true)
    assert.equal(res.inserted, 5)
    assert.ok(res.highWaterMs > 0)

    const fdb = await openForensicsDb(forensicsDbPath)
    assert.ok(fdb)
    const db = fdb!.raw
    try {
      const total = queryOne(db, 'SELECT COUNT(*) AS n FROM api_calls')!
      assert.equal(total.n, 5)

      const r1 = queryOne(db, "SELECT * FROM api_calls WHERE call_id='msg_R1'")!
      assert.equal(r1.spawn_kind, 'fork')
      assert.equal(r1.spawn_resolution, 'direct')
      assert.equal(r1.tier_5m_tokens, 1000)
      assert.equal(r1.tier_1h_tokens, 500)
      assert.equal(r1.effort, 'high')
      assert.ok(typeof r1.frontmatter_fp === 'string' && (r1.frontmatter_fp as string).length > 0)
      assert.ok((r1.cost_usd as number) > 0)
      assert.ok((r1.billable_weight as number) > 0)

      const r2 = queryOne(db, "SELECT * FROM api_calls WHERE call_id='msg_R2'")!
      assert.equal(r2.spawn_kind, 'root')
      assert.equal(r2.spawn_resolution, 'root')
      assert.equal(r2.effort, 'none')

      const r3 = queryOne(db, "SELECT * FROM api_calls WHERE call_id='msg_R3'")!
      assert.equal(r3.spawn_resolution, 'unresolved')
      assert.equal(r3.spawn_kind, null)

      const r4 = queryOne(db, "SELECT * FROM api_calls WHERE call_id='msg_R4'")!
      assert.equal(r4.session_id, null)
      assert.equal(r4.spawn_resolution, 'unresolved')

      const r5 = queryOne(db, "SELECT * FROM api_calls WHERE call_id='msg_R5'")!
      assert.equal(r5.spawn_kind, 'worktree')
      assert.equal(r5.spawn_isolation, 'worktree')
    } finally { fdb!.close() }
  })

  test('re-running the indexer is idempotent (INSERT OR REPLACE keyed on call_id)', async () => {
    await indexApiCalls({ bodiesDir, forensicsDbPath, mainDbPath })
    await indexApiCalls({ bodiesDir, forensicsDbPath, mainDbPath })
    const fdb = await openForensicsDb(forensicsDbPath)
    try {
      const n = queryOne(fdb!.raw, 'SELECT COUNT(*) AS n FROM api_calls')!
      assert.equal(n.n, 5)
    } finally { fdb!.close() }
  })

  test('call_injections is populated from the joined request (rules + claudemd for msg_R1)', async () => {
    await indexApiCalls({ bodiesDir, forensicsDbPath, mainDbPath })
    const fdb = await openForensicsDb(forensicsDbPath)
    try {
      const rules = queryOne(fdb!.raw, "SELECT COUNT(*) AS n FROM call_injections WHERE call_id='msg_R1' AND kind='rule'")!
      assert.ok((rules.n as number) >= 1, 'msg_R1 request injected at least one .claude/rules file')
      const cmd = queryOne(fdb!.raw, "SELECT COUNT(*) AS n FROM call_injections WHERE call_id='msg_R1' AND kind='claudemd'")!
      assert.ok((cmd.n as number) >= 1, 'msg_R1 request carried a CLAUDE.md injection')
    } finally { fdb!.close() }
  })

  test('custom SQL fns are callable on a read-only snapshot (billable_weight/tier_classify/cost_usd/spike)', async () => {
    const snap = await openReadonlyForensicsSnapshot(forensicsDbPath)
    assert.ok(snap)
    try {
      const row = queryOne(snap!, `SELECT
        billable_weight(1000,500,200,50,300,'claude-opus-4-8') AS w,
        tier_classify(3.0) AS bk, tier_classify(NULL) AS cold,
        cost_usd(300,200,1500,50,'claude-opus-4-8') AS c,
        spike(10,5,1.5) AS s`)!
      assert.ok((row.w as number) > 0)
      assert.equal(row.bk, 'BREAK')
      assert.equal(row.cold, 'COLD')
      assert.ok((row.c as number) > 0)
      assert.equal(row.s, 1)
    } finally { snap!.close() }
  })

  test('loadSpawnMap reads the real main DB read-only', async () => {
    const map = await loadSpawnMap(mainDbPath)
    assert.equal(map.get('sess-fork')?.spawnKind, 'fork')
    assert.equal(map.get('sess-root')?.spawnKind, undefined)
    assert.equal(map.get('sess-wt')?.spawnIsolation, 'worktree')
  })
})

suite('FAL Phase 2 — spawn_subagent_type EHT', () => {
  test('subagent_type flows from the main DB column into api_calls.subagent_type', async () => {
    const sub = fs.mkdtempSync(path.join(os.tmpdir(), 'fal-sat-'))
    const bd = path.join(sub, 'otel-bodies'); fs.mkdirSync(bd)
    const mdb = path.join(sub, 'agentlens.db'); const fdbp = path.join(sub, 'forensics.db')
    try {
      fs.writeFileSync(path.join(bd, 'r.response.json'), JSON.stringify({ id: 'msg_S1', model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 5 } }))
      fs.writeFileSync(path.join(bd, 'q.request.json'), JSON.stringify({
        model: 'claude-opus-4-8', metadata: { user_id: JSON.stringify({ account_uuid: 'a', session_id: 'sess-spark' }) },
        diagnostics: { previous_message_id: 'msg_S1' }, system: [{ type: 'text', text: 's' }], tools: [{ name: 'Bash' }], messages: [],
      }))
      const SQL = await loadSqlJs()
      const db = new SQL!.Database()
      db.run(`CREATE TABLE sessions (session_id TEXT PRIMARY KEY, spawn_kind TEXT, spawn_model_override TEXT,
              spawn_isolation TEXT, is_sidechain INTEGER, parent_session_id TEXT, model TEXT, spawn_subagent_type TEXT)`)
      db.run(`INSERT INTO sessions VALUES ('sess-spark','fresh',NULL,NULL,1,'sess-root','claude-opus-4-8','spark')`)
      fs.writeFileSync(mdb, Buffer.from(db.export())); db.close()

      await indexApiCalls({ bodiesDir: bd, forensicsDbPath: fdbp, mainDbPath: mdb })
      const fdb = await openForensicsDb(fdbp)
      try {
        const row = queryOne(fdb!.raw, "SELECT subagent_type FROM api_calls WHERE call_id='msg_S1'")!
        assert.equal(row.subagent_type, 'spark')
      } finally { fdb!.close() }
    } finally { fs.rmSync(sub, { recursive: true, force: true }) }
  })

  test('loadSpawnMap degrades when the main DB predates the spawn_subagent_type column (no throw)', async () => {
    // The Phase-1 main DB (mainDbPath) was built WITHOUT spawn_subagent_type — loadSpawnMap must still
    // resolve spawn_kind and simply return subagentType undefined (defensive column check).
    const map = await loadSpawnMap(mainDbPath)
    assert.equal(map.get('sess-fork')?.spawnKind, 'fork')
    assert.equal(map.get('sess-fork')?.subagentType, undefined)
  })
})

suite('FAL Phase 4/5 — content taxonomy + injection attribution', () => {
  test('extractInjections pulls rules + claudemd (exact) + mcp servers + invoked skills', () => {
    const rows = extractInjections({
      system: [
        { type: 'text', text: 'Contents of /u/.claude/rules/never-git-add-all.md (x)\nContents of /u/.claude/rules/commit-discipline.md (y)' },
        { type: 'text', text: 'Contents of /repo/CLAUDE.md (project)\n# CLAUDE.md' },
      ],
      tools: [{ name: 'Bash' }, { name: 'mcp__agentlens__get_recent_sessions' }, { name: 'mcp__agentlens__get_burn_status' }, { name: 'mcp__codegraph__codegraph_search' }],
      messages: [{ role: 'assistant', content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'distill' } }] }],
    })
    const byKind = (k: string) => rows.filter(r => r.kind === k).map(r => r.name).sort()
    assert.deepEqual(byKind('rule'), ['commit-discipline.md', 'never-git-add-all.md'])
    assert.deepEqual(byKind('claudemd'), ['/repo/CLAUDE.md'])
    // distinct mcp servers, deduped (two agentlens tools collapse to one server)
    assert.deepEqual(byKind('mcp'), ['mcp__agentlens', 'mcp__codegraph'])
    assert.deepEqual(byKind('skill'), ['distill'])
  })

  test('deriveContentTags tags image / big_file_read / tool_result:<Kind> / thinking_heavy from a composition', () => {
    const comp = {
      images: { count: 3, tokens: 90000 },
      blocks: [
        { index: 0, kind: 'toolOutput', label: 'Read', tokens: 40000, tokenSource: 'estimated', bytes: 0, role: 'input', toolName: 'Read', isImage: false },
        { index: 1, kind: 'bashOutput', label: 'Bash', tokens: 500, tokenSource: 'estimated', bytes: 0, role: 'input', toolName: 'Bash', isImage: false },
      ],
      toolResultTokens: 40500, textTokens: 0, thinkingTokens: 30000, systemTokens: 0, toolCatalogTokens: 15000,
    } as unknown as CallComposition
    const tags = deriveContentTags(comp)
    const names = tags.map(t => t.tag).sort()
    assert.ok(names.includes('image'))
    assert.ok(names.includes('big_file_read'))         // the 40k Read block ≥ 25k
    assert.ok(names.includes('tool_result:Read'))
    assert.ok(names.includes('tool_result:Bash'))
    assert.ok(names.includes('tool_catalog_large'))    // 15k ≥ 10k
    assert.ok(names.includes('thinking_heavy'))        // 30k ≥ 20k
    const imgTag = tags.find(t => t.tag === 'image')!
    assert.equal(imgTag.count, 3)
    assert.equal(imgTag.tokens, 90000)
  })
})

suite('FAL Phase 1 — 🐌 real machine data (skips when ~/.agentlens absent)', () => {
  test('indexApiCalls over the real ~/.agentlens degrades honestly whether or not bodies exist', async function () {
    // 🐌 real-machine slow test: indexes up to REQUEST_INDEX_CAP request bodies off disk (each up to
    // 64MB) — far past the 10s default. Skipped entirely in CI (no ~/.agentlens/otel-bodies there).
    this.timeout(180000)
    const realBodies = path.join(os.homedir(), '.agentlens', 'otel-bodies')
    if (!fs.existsSync(realBodies)) { this.skip(); return }
    const tmpDb = path.join(tmpRoot, 'real-forensics.db')
    const res = await indexApiCalls({ forensicsDbPath: tmpDb, mainDbPath: DEFAULT_MAIN_DB, scanCap: 200 })
    assert.equal(res.dbAvailable, true)
    assert.ok(res.coverage.responseFilesTotal >= 0)
    // Every inserted row must carry an explicit spawn_resolution (honesty invariant).
    const fdb = await openForensicsDb(tmpDb)
    try {
      const bad = queryOne(fdb!.raw, "SELECT COUNT(*) AS n FROM api_calls WHERE spawn_resolution IS NULL")!
      assert.equal(bad.n, 0)
    } finally { fdb!.close() }
    assert.ok(DEFAULT_FORENSICS_DB.length > 0)
  })
})
