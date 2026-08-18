// src/test/rustOpenCode.test.ts — P3d cross-engine parity (TRDD-DMWOBWFH): the Rust opencode
// SQLite parser (rusqlite, native WAL read) must produce EXACTLY what LogReader._parseOpenCodeDb
// produces (sql.js on a byte copy + hand-rolled _mergeWal), compared on the JSON wire shape.
//
// The fixture exercises the port's parity traps: root-session filter (parent_id), the zero-token
// WHERE filter, model NULL → 'opencode', last-user-text-wins userRequest, llm/tool merge with
// stable order at EQUAL timestamps (llm first — TS concatenates llmEvents ahead of toolEvents),
// callID-null spanId from the part timestamp, empty-string tool output truthiness ('' → no
// resultSummary/fullResult), error parts (errorMessage keeps '' semantics via ??), file
// read/write classification, astral characters (UTF-16 snip parity), and capTimeline eviction
// (timelineTruncatedCount) under a tightened entry bound.

import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { LogReader, type LogSessionResult, type OpenCodeSqlFactory } from '../logReader'
import { finishRustTranscript } from '../rustLogScan'
import { capTimeline } from '../timelineRetention'
import type { TimelineEntry } from '../shared/summarizerTypes'

const BIN = path.join(__dirname, '..', '..', '..', 'rust-core', 'target', 'release', 'allogscan')
const haveBin = fs.existsSync(BIN)

type SqlDb = {
  run(sql: string, params?: unknown[]): void
  export(): Uint8Array
  close(): void
}

async function makeSqlFactory(): Promise<{ factory: OpenCodeSqlFactory; createDb: () => SqlDb }> {
  const sqlJsDir = path.dirname(require.resolve('sql.js'))
  const initSqlJs = require('sql.js') as (cfg: { locateFile: (f: string) => string }) => Promise<{ Database: new (data?: Buffer | Uint8Array) => SqlDb }>
  const SQL = await initSqlJs({ locateFile: (f: string) => path.join(sqlJsDir, f) })
  return { factory: SQL as unknown as OpenCodeSqlFactory, createDb: () => new SQL.Database() }
}

// The legacy (supported) OpenCode schema — session carries model + token columns.
const SCHEMA = `
  CREATE TABLE session (
    id TEXT PRIMARY KEY, parent_id TEXT, title TEXT NOT NULL DEFAULT '',
    directory TEXT NOT NULL DEFAULT '', model TEXT,
    time_created INTEGER NOT NULL DEFAULT 0, time_updated INTEGER NOT NULL DEFAULT 0,
    tokens_input INTEGER NOT NULL DEFAULT 0, tokens_output INTEGER NOT NULL DEFAULT 0,
    tokens_reasoning INTEGER NOT NULL DEFAULT 0,
    tokens_cache_read INTEGER NOT NULL DEFAULT 0, tokens_cache_write INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL
  );
  CREATE TABLE part (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL
  );
`

const T0 = 1704067200000 // 2024-01-01T00:00:00.000Z — deterministic (no strip on this path)

function buildFixtureDb(createDb: () => SqlDb): Uint8Array {
  const db = createDb()
  db.run(SCHEMA)
  const sess = (id: string, parent: string | null, title: string, dir: string, model: string | null,
    t: number, tin: number, tout: number, treas: number, tcr: number, tcw: number) =>
    db.run('INSERT INTO session (id,parent_id,title,directory,model,time_created,tokens_input,tokens_output,tokens_reasoning,tokens_cache_read,tokens_cache_write) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [id, parent, title, dir, model, t, tin, tout, treas, tcr, tcw])
  const msg = (id: string, sid: string, t: number, data: unknown) =>
    db.run('INSERT INTO message (id,session_id,time_created,data) VALUES (?,?,?,?)', [id, sid, t, JSON.stringify(data)])
  const part = (id: string, mid: string, sid: string, t: number, data: unknown) =>
    db.run('INSERT INTO part (id,message_id,session_id,time_created,data) VALUES (?,?,?,?,?)', [id, mid, sid, t, JSON.stringify(data)])

  sess('sess-a', null, 'Fix the bug', '/proj', JSON.stringify({ id: 'claude-sonnet-5', providerID: 'anthropic' }),
    T0, 1800, 350, 50, 800, 100)
  sess('sess-child', 'sess-a', 'sub work', '/proj', JSON.stringify({ id: 'claude-sonnet-5' }), T0 + 10, 5, 5, 0, 0, 0)
  sess('sess-zero', null, 'nothing billed', '/proj', JSON.stringify({ id: 'claude-sonnet-5' }), T0 + 20, 0, 0, 0, 0, 0)
  sess('sess-d', null, 'Untitled work', '', null, T0 - 100000, 5, 0, 0, 0, 0)

  msg('m-u1', 'sess-a', T0 + 400, { role: 'user' })
  msg('m-a1', 'sess-a', T0 + 1000, { role: 'assistant', time: { created: T0 + 1000, completed: T0 + 1800 },
    tokens: { input: 900, output: 150, cache: { read: 400, write: 100 } } })
  msg('m-a2', 'sess-a', T0 + 2000, { role: 'assistant', time: { created: T0 + 2000, completed: T0 + 2600 },
    tokens: { input: 900, output: 200, cache: { read: 400, write: 0 } } })

  // Last user text part wins userRequest (parts ASC); astral char exercises UTF-16 snip parity.
  part('p-u1', 'm-u1', 'sess-a', T0 + 500, { type: 'text', text: 'first ask' })
  part('p-u2', 'm-u1', 'sess-a', T0 + 2500, { type: 'text', text: 'final ask — 𝄞 clef' })
  // read tool with callID + long output (snip 200 vs capText paths diverge if snip is wrong).
  part('p-t1', 'm-a1', 'sess-a', T0 + 1500, { type: 'tool', tool: 'read', callID: 'c1',
    state: { status: 'completed', input: { filePath: '/proj/src/a.ts' }, output: 'line 𝄞 '.repeat(40) } })
  // EQUAL timestamp as m-a2's llm entry — pins the stable llm-before-tool merge order.
  // callID absent → spanId falls back to the part timestamp. Empty output → '' is falsy for
  // resultSummary/fullResult (both absent).
  part('p-t2', 'm-a2', 'sess-a', T0 + 2000, { type: 'tool', tool: 'write',
    state: { status: 'completed', input: { filePath: '/proj/out/b.ts' }, output: '' } })
  // error part without filePath: label is the bare tool name, errorMessage carries the output.
  part('p-t3', 'm-a2', 'sess-a', T0 + 2200, { type: 'tool', tool: 'Bash',
    state: { status: 'error', output: 'boom failed' } })
  part('p-t4', 'm-a2', 'sess-a', T0 + 2600, { type: 'tool', tool: 'grep',
    state: { status: 'completed', input: { filePath: '/proj/src/c.ts' }, output: 'hit' } })
  // A non-tool part that still names a tool — both engines must skip it (type gate).
  part('p-x1', 'm-a2', 'sess-a', T0 + 2650, { type: 'step-start', tool: 'read' })

  const bytes = db.export()
  db.close()
  return bytes
}

function normalize(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v))
}

type OpenCodeParser = { _parseOpenCodeDb(dbPath: string): LogSessionResult[] }

function tsParse(factory: OpenCodeSqlFactory, dbPath: string): unknown {
  const reader = new LogReader({ sqlFactory: factory })
  return normalize((reader as unknown as OpenCodeParser)._parseOpenCodeDb(dbPath))
}

function rustParse(dbPath: string, extra: string[] = []): unknown {
  const out = execFileSync(BIN, ['--opencode', dbPath, ...extra], { maxBuffer: 1 << 28 }).toString()
  const parsed = out.split('\n').filter(Boolean)
    .map(l => finishRustTranscript(JSON.parse(l) as Parameters<typeof finishRustTranscript>[0]))
  return normalize(parsed)
}

suite('rustOpenCode — P3d cross-engine parity', () => {
  const parityTest = haveBin ? test : test.skip
  let factory: OpenCodeSqlFactory
  let createDb: () => SqlDb
  let dbPath: string

  suiteSetup(async function () {
    this.timeout(30_000)
    const made = await makeSqlFactory()
    factory = made.factory
    createDb = made.createDb
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-oc-'))
    dbPath = path.join(dir, 'opencode.db')
    fs.writeFileSync(dbPath, Buffer.from(buildFixtureDb(createDb)))
  })

  parityTest('🐌 the fixture db parses IDENTICALLY through both engines', function () {
    this.timeout(30_000)
    const ts = tsParse(factory, dbPath) as Array<{ card: Record<string, unknown> }>
    const rust = rustParse(dbPath) as Array<{ card: Record<string, unknown> }>
    assert.strictEqual(ts.length, 2, 'root sessions with tokens only (child + zero-token excluded)')
    assert.deepStrictEqual(rust.length, ts.length)
    for (let i = 0; i < ts.length; i++) {
      assert.deepStrictEqual(rust[i], ts[i], `session ${i} must match field-for-field`)
    }
  })

  parityTest('🐌 capTimeline eviction matches under a tightened entry bound', function () {
    this.timeout(30_000)
    // timelineMaxEntries() is memoized per process, so the TS parse cannot be retuned via env
    // here — instead drive the SAME public helper the parser calls (capTimeline) on the
    // TS-parsed timeline and compare against the binary's --max-entries run.
    const ts = tsParse(factory, dbPath) as Array<{ card: { timelineTruncatedCount?: number; timeline: TimelineEntry[] } }>
    const timeline = ts[0].card.timeline
    const evicted = capTimeline(timeline, 3)
    assert.ok(evicted > 0, 'the bound must actually evict')
    const rust = rustParse(dbPath, ['--max-entries', '3']) as typeof ts
    assert.deepStrictEqual(rust[0].card.timeline, normalize(timeline))
    assert.strictEqual(rust[0].card.timelineTruncatedCount, evicted)
  })

  parityTest('🐌 the REAL opencode db on this machine parses identically (native WAL vs _mergeWal)', function () {
    this.timeout(60_000)
    const real = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db')
    if (!fs.existsSync(real)) this.skip()
    // The TS side runs in a CHILD process: sql.js WASM memory never shrinks, and the real db's
    // byte copy + WAL merge would push this mocha process past the 4096MB rssPressure HWM —
    // flipping compressSealedSegments into its defensive skip and failing unrelated gz tests.
    const child = path.join(__dirname, 'helpers', 'opencodeParseChild.js')
    const ts = JSON.parse(execFileSync(process.execPath, [child, real], { maxBuffer: 1 << 28 }).toString())
    assert.deepStrictEqual(rustParse(real), ts)
  })

  parityTest('🐌 wiring: OPENCODE_DATA_DIR + AGENTLENS_ALLOGSCAN routes the scan to Rust', function () {
    this.timeout(30_000)
    const prevDir = process.env['OPENCODE_DATA_DIR']
    const prevBin = process.env['AGENTLENS_ALLOGSCAN']
    process.env['OPENCODE_DATA_DIR'] = path.dirname(dbPath)
    process.env['AGENTLENS_ALLOGSCAN'] = BIN
    try {
      // No sqlFactory: without the Rust channel this reader could only take the JSON fallback
      // (empty here) — sessions coming back proves the exec route ran.
      const reader = new LogReader()
      const results = reader.scanOpenCode()
      assert.strictEqual(results.length, 2)
      assert.strictEqual(results[0].card.source, 'opencode')
      assert.deepStrictEqual(normalize(results), rustParse(dbPath))
    } finally {
      if (prevDir === undefined) delete process.env['OPENCODE_DATA_DIR']
      else process.env['OPENCODE_DATA_DIR'] = prevDir
      if (prevBin === undefined) delete process.env['AGENTLENS_ALLOGSCAN']
      else process.env['AGENTLENS_ALLOGSCAN'] = prevBin
    }
  })
})
