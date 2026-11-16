// src/test/searchCli.test.ts — `agentlenspro search` (TRDD-P31SWA8I, TRDD-UIQS9RXZ): the DuckDB
// transcript query engine, project-wide scope and the verb's usage contract. Real DuckDB against
// real fixture files — no mocks.

import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  searchTranscript, searchTranscripts, discoverTranscripts, parseTimeArg, runSearchCli, TranscriptFile,
  SearchScopeError, SearchHit, SearchOptions, ScopeOptions,
} from '../cli/searchCli'
import { UsageError } from '../cli/cliErrors'
import { projectSlugOf } from '../projectSlug'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-search-'))
const fixture = path.join(tmpDir, 'aaaaaaaa-1111-2222-3333-444444444444.jsonl')

// Shapes mirror a real Claude transcript: user prompt, assistant text, a tool_result carried in a
// user-role entry, a summary line, and one MB-scale tool_result to prove big lines stay in SQL.
const LINES = [
  { type: 'user', timestamp: '2026-08-18T10:00:00.000Z', message: { role: 'user', content: 'please fix the ENOENT crash in the loader' } },
  { type: 'assistant', timestamp: '2026-08-18T10:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: "reading the loader now — O'Brien's parser looks suspect" }] } },
  { type: 'user', timestamp: '2026-08-18T10:00:10.000Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'Error: ENOENT: no such file or directory, open /tmp/x' }] } },
  { type: 'summary', summary: 'session about a loader crash' },
  { type: 'assistant', timestamp: '2026-08-18T10:00:20.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'fixed: the path was built before mkdir ran (enoent root cause)' }] } },
  { type: 'user', timestamp: '2026-08-18T10:00:30.000Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'PAYLOAD ' + 'x'.repeat(2_000_000) + ' NEEDLE_IN_BIG_LINE' }] } },
]
fs.writeFileSync(fixture, LINES.map(l => JSON.stringify(l)).join('\n') + '\n')

suite('searchCli — DuckDB transcript search', () => {
  test('literal search is case-insensitive and reports true line numbers + full total', async function () {
    this.timeout(30_000)
    const r = await searchTranscript(fixture, 'enoent')
    assert.strictEqual(r.total, 3, 'ENOENT appears on lines 1, 3 and 5 regardless of case')
    assert.deepStrictEqual(r.hits.map(h => h.line), [1, 3, 5], 'line numbers must match the file, in file order')
    assert.strictEqual(r.hits[0].role, 'user')
    assert.strictEqual(r.hits[1].type, 'user')
    assert.ok(r.hits[2].excerpt.toLowerCase().includes('enoent'), 'the excerpt must contain the match')
  })

  test('--role and --type filters narrow the result set', async function () {
    this.timeout(30_000)
    const byRole = await searchTranscript(fixture, 'enoent', { role: 'assistant' })
    assert.deepStrictEqual(byRole.hits.map(h => h.line), [5], 'only the assistant entry matches')
    const byType = await searchTranscript(fixture, 'loader', { type: 'summary' })
    assert.deepStrictEqual(byType.hits.map(h => h.line), [4], 'the summary line has no message.role but a type')
  })

  test('--regex mode matches by pattern and excerpts the capture', async function () {
    this.timeout(30_000)
    const r = await searchTranscript(fixture, 'ENOENT: no such [a-z]+', { regex: true })
    assert.strictEqual(r.total, 1, 'the regex only fits the tool_result error line')
    assert.strictEqual(r.hits[0].line, 3)
    assert.strictEqual(r.hits[0].excerpt, 'ENOENT: no such file')
  })

  test('--limit bounds the hits but total still reports the honest match count', async function () {
    this.timeout(30_000)
    const r = await searchTranscript(fixture, 'enoent', { limit: 1 })
    assert.strictEqual(r.hits.length, 1)
    assert.strictEqual(r.total, 3, 'truncation must never masquerade as a smaller result set')
  })

  test("a pattern containing a single quote is escaped, not a SQL break", async function () {
    this.timeout(30_000)
    const r = await searchTranscript(fixture, "O'Brien's")
    assert.deepStrictEqual(r.hits.map(h => h.line), [2])
  })

  test('a match inside an MB-scale tool_result line is found and the excerpt stays bounded', async function () {
    this.timeout(30_000)
    const r = await searchTranscript(fixture, 'NEEDLE_IN_BIG_LINE')
    assert.deepStrictEqual(r.hits.map(h => h.line), [6])
    assert.ok(r.hits[0].excerpt.length <= 300, `excerpt must be windowed, got ${r.hits[0].excerpt.length} chars`)
    assert.ok(r.hits[0].excerpt.includes('NEEDLE_IN_BIG_LINE'))
  })
})

// ── project-wide fixture: 3 main transcripts' worth of shapes, a sub-agent, a sibling worktree folder ──

const PROJECT = '/fake/proj'
const CFG = path.join(tmpDir, 'cfg')
const PROJ_DIR = path.join(CFG, 'projects', projectSlugOf(PROJECT))
const WT_DIR = path.join(CFG, 'projects', `${projectSlugOf(PROJECT)}--claude-worktrees-x`)
const SID_A = 'aaaaaaaa-1111-2222-3333-444444444444'
const SID_B = 'aaaaaaab-1111-2222-3333-444444444444'
const SID_W = 'dddddddd-1111-2222-3333-444444444444'
const AGENT = 'cccc3333dddd4444'
const FILE_A = path.join(PROJ_DIR, `${SID_A}.jsonl`)
const FILE_B = path.join(PROJ_DIR, `${SID_B}.jsonl`)
const FILE_SUB = path.join(PROJ_DIR, SID_A, 'subagents', `agent-${AGENT}.jsonl`)
const FILE_W = path.join(WT_DIR, `${SID_W}.jsonl`)

function writeJsonl(file: string, lines: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
}

const DUP = { type: 'user', timestamp: '2026-08-18T11:00:01.000Z', message: { role: 'user', content: 'dup NEEDLE' } }
// A: branch/cwd/model/timestamp variety, a no-timestamp line, a 2 MB line, two attachments.
writeJsonl(FILE_A, [
  { type: 'user', timestamp: '2026-08-18T10:00:00.000Z', gitBranch: 'main', cwd: '/fake/proj', message: { role: 'user', content: 'alpha NEEDLE one' } },
  { type: 'assistant', timestamp: '2026-08-19T10:00:05.000Z', gitBranch: 'feat/x', cwd: '/fake/proj/.claude/worktrees/wt1', message: { role: 'assistant', model: 'claude-opus-x', content: [{ type: 'text', text: 'beta NEEDLE two' }] } },
  { type: 'summary', summary: 'NEEDLE summary without a timestamp' },
  { type: 'user', timestamp: '2026-08-18T10:00:30.000Z', gitBranch: 'main', message: { role: 'user', content: 'PAYLOAD ' + 'x'.repeat(2_000_000) + ' NEEDLE big' } },
  { type: 'attachment', timestamp: '2026-08-18T10:00:40.000Z', attachment: { type: 'total_tokens_reminder', content: 'REMINDERWORD' } },
  { type: 'attachment', timestamp: '2026-08-18T10:00:41.000Z', attachment: { type: 'hook_additional_context', content: 'HOOKWORD' } },
])
// B: a quote, two IDENTICAL matching lines (2 and 4), a newline, a request blob. Old mtime for pruning.
writeJsonl(FILE_B, [
  { type: 'user', timestamp: '2026-08-18T11:00:00.000Z', message: { role: 'user', content: 'he said "hello" there' } },
  DUP,
  { type: 'user', timestamp: '2026-08-18T11:00:02.000Z', message: { role: 'user', content: 'first line\nsecond line' } },
  DUP,
  { type: 'api-request-blob', timestamp: '2026-08-18T11:00:03.000Z', message: { role: 'user', content: 'BLOBONLY marker' } },
])
fs.utimesSync(FILE_B, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))
writeJsonl(FILE_SUB, [
  { type: 'user', timestamp: '2026-08-18T12:00:00.000Z', message: { role: 'user', content: 'sub start' } },
  { type: 'assistant', timestamp: '2026-08-18T12:00:01.000Z', message: { role: 'assistant', content: 'sub reply' } },
  { type: 'user', timestamp: '2026-08-18T12:00:02.000Z', message: { role: 'user', content: 'sub NEEDLE hit' } },
])
writeJsonl(FILE_W, [
  { type: 'user', timestamp: '2026-08-18T13:00:00.000Z', cwd: '/fake/proj/.claude/worktrees/x', message: { role: 'user', content: 'wt NEEDLE' } },
])

/** Ground truth: the 1-based lines of a fixture file that contain `needle`, read in JS — never from SQL. */
function linesOf(file: string, needle: string): number[] {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.flatMap((l, i) => (l.includes(needle) ? [i + 1] : []))
}
const spot = (hits: SearchHit[]): string[] =>
  hits.map(h => `${h.session.slice(0, 8)}${h.agent ? `:${h.agent.slice(0, 8)}` : ''}#${h.line}`).sort()
const want = (file: string, needle: string, tag: string): string[] => linesOf(file, needle).map(n => `${tag}#${n}`)
const names = (scope: ScopeOptions): string[] => discoverTranscripts(PROJECT, scope).map(f => path.basename(f.path)).sort()
const run = (pattern: string, opts: SearchOptions = {}, scope: ScopeOptions = {}) =>
  searchTranscripts(discoverTranscripts(PROJECT, scope), pattern, { limit: 500, ...opts })

async function runCli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  // The verb writes through process.stdout/stderr (not console), so those are what the capture swaps.
  const stdoutWrite = process.stdout.write
  const stderrWrite = process.stderr.write
  let out = ''
  let err = ''
  process.stdout.write = ((chunk: string | Uint8Array) => { out += String(chunk); return true }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => { err += String(chunk); return true }) as typeof process.stderr.write
  try { return { code: await runSearchCli(argv), out, err } } finally { process.stdout.write = stdoutWrite; process.stderr.write = stderrWrite }
}

let savedConfigDir: string | undefined
function pointAtFixture(): void {
  savedConfigDir = process.env['CLAUDE_CONFIG_DIR']
  process.env['CLAUDE_CONFIG_DIR'] = CFG
}
function restoreConfig(): void {
  if (savedConfigDir === undefined) delete process.env['CLAUDE_CONFIG_DIR']
  else process.env['CLAUDE_CONFIG_DIR'] = savedConfigDir
}

suite('searchCli — project-wide search (TRDD-UIQS9RXZ)', () => {
  suiteSetup(pointAtFixture)
  suiteTeardown(restoreConfig)

  test('without --session a pattern in two main transcripts and a sub-agent is found with each true line', async function () {
    this.timeout(60_000)
    const r = await run('NEEDLE')
    const expected = [
      ...want(FILE_A, 'NEEDLE', 'aaaaaaaa'), ...want(FILE_B, 'NEEDLE', 'aaaaaaab'), ...want(FILE_SUB, 'NEEDLE', 'aaaaaaaa:cccc3333'),
    ].sort()
    assert.deepStrictEqual(spot(r.hits), expected, 'lines from JS ground truth; includes the 2 MB line of A and the sub-agent')
    assert.strictEqual(r.total, expected.length)
  })

  test('two identical matching lines of one transcript get their own distinct line numbers', async function () {
    this.timeout(60_000)
    const r = await run('dup NEEDLE', {}, { sessions: ['aaaaaaab'] })
    assert.deepStrictEqual(r.hits.map(h => h.line).sort(), linesOf(FILE_B, 'dup NEEDLE'), 'lines 2 and 4, each once')
  })

  test('--session (prefix), --agent, --main-only, --subagents-only and --worktrees select the expected files', () => {
    const a = `${SID_A}.jsonl`
    const b = `${SID_B}.jsonl`
    const sub = `agent-${AGENT}.jsonl`
    assert.deepStrictEqual(names({}), [a, b, sub].sort(), 'default: every transcript of the project, no worktree folders')
    assert.deepStrictEqual(names({ sessions: ['aaaaaaaa'] }), [a, sub].sort(), 'a session brings its sub-agent transcripts')
    assert.deepStrictEqual(names({ sessions: ['aaaaaaab'] }), [b])
    assert.throws(() => names({ sessions: ['aaaaaa'] }), (e: unknown) => e instanceof SearchScopeError && /ambiguous/.test((e as Error).message))
    assert.deepStrictEqual(names({ agents: ['cccc'] }), [sub], '--agent selects sub-agent transcripts only')
    assert.deepStrictEqual(names({ mainOnly: true }), [a, b].sort())
    assert.deepStrictEqual(names({ subagentsOnly: true }), [sub])
    assert.deepStrictEqual(names({ worktrees: true }), [a, b, sub, `${SID_W}.jsonl`].sort())
  })

  test('--since / --until (ISO and relative) keep only entries inside the window, and old files are not opened', async function () {
    this.timeout(60_000)
    const since = await run('NEEDLE', { since: parseTimeArg('2026-08-19', '--since') })
    assert.deepStrictEqual(spot(since.hits), ['aaaaaaaa#2'], 'only the 08-19 entry; the no-timestamp line is excluded too')
    const until = await run('NEEDLE', { until: parseTimeArg('2026-08-18T23:59:59Z', '--until') })
    assert.ok(until.hits.every(h => h.ts !== null && h.ts <= '2026-08-18T23:59:59.000Z'))
    assert.ok(!spot(until.hits).includes('aaaaaaaa#2'), 'the 08-19 entry is after --until')
    assert.strictEqual(parseTimeArg('2h', '--since', 1_000_000_000_000), new Date(1_000_000_000_000 - 7_200_000).toISOString())
    assert.ok(!names({ sinceMs: Date.parse('2026-08-01') }).includes(`${SID_B}.jsonl`), 'B has an old mtime: pruned without being opened')
  })

  test('--branch, --cwd, --worktree and --model each keep the matching entry and drop the other', async function () {
    this.timeout(60_000)
    for (const [opts, miss] of [
      [{ branch: 'feat/x' }, { branch: 'nope' }],
      [{ cwd: '/fake/proj/.claude' }, { cwd: '/elsewhere' }],
      [{ worktree: 'wt1' }, { worktree: 'zzz' }],
      [{ model: 'opus-x' }, { model: 'sonnet' }],
    ] as Array<[SearchOptions, SearchOptions]>) {
      assert.deepStrictEqual(spot((await run('NEEDLE', opts)).hits), ['aaaaaaaa#2'], JSON.stringify(opts))
      assert.strictEqual((await run('NEEDLE', miss)).total, 0, JSON.stringify(miss))
    }
  })

  test('a hit in an api-request-blob entry is absent by default, present with --include-requests or --type', async function () {
    this.timeout(60_000)
    assert.strictEqual((await run('BLOBONLY')).total, 0)
    assert.deepStrictEqual(spot((await run('BLOBONLY', { includeRequests: true })).hits), ['aaaaaaab#5'])
    assert.strictEqual((await run('BLOBONLY', { type: 'api-request-blob' })).total, 1)
  })

  test('a hit in a total_tokens_reminder attachment is absent by default, a hook_additional_context one is present', async function () {
    this.timeout(60_000)
    assert.strictEqual((await run('REMINDERWORD')).total, 0)
    assert.strictEqual((await run('REMINDERWORD', { includeAttachments: true })).total, 1)
    assert.strictEqual((await run('REMINDERWORD', { type: 'attachment' })).total, 1)
    assert.strictEqual((await run('HOOKWORD')).total, 1)
  })

  test('--count and --files print one row per matching transcript, largest first', async function () {
    this.timeout(60_000)
    const count = await runCli(['NEEDLE', '--project', PROJECT, '--count'])
    assert.strictEqual(count.code, 0)
    assert.strictEqual(count.out, '4\taaaaaaaa\n2\taaaaaaab\n1\taaaaaaaa:cccc3333\n')
    const files = await runCli(['NEEDLE', '--project', PROJECT, '--files'])
    assert.strictEqual(files.out, `${FILE_A}\n${FILE_B}\n${FILE_SUB}\n`)
  })

  test('--order old reverses newest-first, --width cuts the excerpt, --json carries session, agent and file', async function () {
    this.timeout(60_000)
    const tsOf = (o: string): Array<string | null> => (JSON.parse(o) as { hits: Array<{ ts: string | null }> }).hits.map(h => h.ts)
    const fresh = await runCli(['NEEDLE', '--project', PROJECT, '--json', '--limit', '500'])
    const newest = tsOf(fresh.out)
    assert.strictEqual(newest[newest.length - 1], null, 'the entry with no timestamp comes last')
    assert.deepStrictEqual(newest.slice(0, -1), [...newest.slice(0, -1)].sort().reverse(), 'newest first')
    const oldest = tsOf((await runCli(['NEEDLE', '--project', PROJECT, '--json', '--limit', '500', '--order', 'old'])).out)
    assert.deepStrictEqual(oldest.slice(0, -1), [...newest.slice(0, -1)].reverse(), 'oldest first')
    assert.strictEqual(oldest[oldest.length - 1], null)
    const narrow = JSON.parse((await runCli(['NEEDLE', '--project', PROJECT, '--json', '--width', '40'])).out) as { total: number; hits: Array<Record<string, unknown>> }
    assert.ok(narrow.hits.every(h => String(h.excerpt).length <= 40))
    assert.deepStrictEqual(Object.keys(narrow.hits[0]).sort(), ['agent', 'excerpt', 'file', 'line', 'role', 'session', 'ts', 'type'])
    assert.strictEqual(narrow.total, 7)
    const text = await runCli(['NEEDLE', '--project', PROJECT])
    assert.match(text.out.split('\n')[0], /^[a-z0-9]{8}(:[a-z0-9]{8})?\t#\d+\t\S+\t\[[a-z]+\]\t/)
  })

  test('the CLI names the invalid lines it skipped on stderr and stays silent for a clean scope', async function () {
    this.timeout(60_000)
    const badDir = path.join(CFG, 'projects', projectSlugOf('/fake/bad-proj'))
    fs.mkdirSync(badDir, { recursive: true })
    fs.writeFileSync(path.join(badDir, 'bbbbbbbb-1111-2222-3333-444444444444.jsonl'), [JSON.stringify(DUP), '{"type":"user","message":{"content":"NEEDLE torn', JSON.stringify(DUP)].join('\n') + '\n')
    const bad = await runCli(['NEEDLE', '--project', '/fake/bad-proj'])
    assert.strictEqual(bad.code, 0)
    assert.ok(bad.err.includes('1 invalid line(s) in 1 transcript(s) skipped'), bad.err)
    const clean = await runCli(['NEEDLE', '--project', PROJECT])
    assert.ok(!clean.err.includes('invalid line'), clean.err)
  })

  test('a single quote in any string flag does not break the SQL or the scope lookup', async function () {
    this.timeout(60_000)
    const r = await run('NEEDLE', { role: "x'y", type: "x'y", branch: "x'y", cwd: "x'y", worktree: "x'y", model: "x'y", since: '2026-01-01T00:00:00.000Z' })
    assert.strictEqual(r.total, 0)
    for (const flag of ['--session', '--agent', '--project']) {
      const c = await runCli(['NEEDLE', '--project', PROJECT, flag, "a'b'c'dddd"])
      assert.notStrictEqual(c.code, 64, `${flag} must not be a usage error`)
    }
    assert.strictEqual((await runCli(['NEEDLE', '--project', PROJECT, '--session', "a'b'c'dddd"])).code, 2, 'unknown session: exit 2')
  })

  test('a literal pattern containing a double quote matches the JSON-escaped text', async function () {
    this.timeout(60_000)
    assert.deepStrictEqual(spot((await run('said "hello"')).hits), want(FILE_B, 'hello', 'aaaaaaab'))
  })

  test('a literal pattern containing a newline matches the JSON-escaped text', async function () {
    this.timeout(60_000)
    assert.deepStrictEqual(spot((await run('first line\nsecond')).hits), want(FILE_B, 'first line', 'aaaaaaab'))
  })

  test('conflicting or malformed flags are each a UsageError', async () => {
    for (const bad of [
      ['x', '--main-only', '--subagents-only'], ['x', '--count', '--files'], ['x', '--since', 'yesterday'],
      ['x', '--until', '2026-13-45'], ['x', '--limit', 'lots'], ['x', '--width', 'wide'], ['x', '--order', 'sideways'],
    ]) {
      await assert.rejects(() => runSearchCli(bad), (e: unknown) => e instanceof UsageError, bad.join(' '))
    }
  })
})

suite('searchCli — usage contract', () => {
  suiteSetup(pointAtFixture)
  suiteTeardown(restoreConfig)

  test('an unknown flag is a UsageError (maps to exit 64), checked BEFORE any other validation', async () => {
    await assert.rejects(() => runSearchCli(['--definitely-not-a-real-flag']),
      (e: unknown) => e instanceof UsageError)
  })

  test('a missing pattern is a UsageError, and without --session the whole fixture project is searched', async function () {
    this.timeout(60_000)
    await assert.rejects(() => runSearchCli(['--session', 'abc123']),
      (e: unknown) => e instanceof UsageError && /pattern/.test((e as Error).message))
    const r = await runCli(['NEEDLE', '--project', PROJECT, '--json'])
    assert.strictEqual(r.code, 0)
    assert.strictEqual((JSON.parse(r.out) as { total: number }).total, 7, 'every transcript of the project, no --session needed')
  })

  test('a non-numeric --limit is refused', async () => {
    await assert.rejects(() => runSearchCli(['needle', '--session', 'abc123', '--limit', 'lots']),
      (e: unknown) => e instanceof UsageError)
  })
})

suite('searchCli — timing, stage-2 numbering and torn lines (TRDD-UIQS9RXZ)', () => {
  const entry = (content: string): string => JSON.stringify({ type: 'user', timestamp: '2026-08-18T10:00:00.000Z', message: { role: 'user', content } })
  const rawFile = (name: string, text: string): TranscriptFile => {
    const p = path.join(tmpDir, name)
    fs.writeFileSync(p, text)
    return { path: p, session: name.replace(/\.jsonl$/, ''), agent: null, size: Buffer.byteLength(text), mtimeMs: 0 }
  }
  /** Ground truth in JS: the 1-based lines that parse as JSON and contain NEEDLE (a torn or malformed line yields no hit). */
  const validNeedleLines = (f: TranscriptFile): number[] =>
    fs.readFileSync(f.path, 'utf8').split('\n').flatMap((l, i) => {
      try { JSON.parse(l) } catch { return [] }
      return l.includes('NEEDLE') ? [i + 1] : []
    })
  const other = (): TranscriptFile => rawFile('other-file.jsonl', entry('NEEDLE elsewhere') + '\n')

  test('the engine result carries timing with two non-negative numbers', async function () {
    this.timeout(30_000)
    const r = await searchTranscripts([rawFile('timing.jsonl', entry('NEEDLE t') + '\n'), other()], 'NEEDLE')
    assert.ok(Number.isFinite(r.timing.scanMs) && r.timing.scanMs >= 0)
    assert.ok(Number.isFinite(r.timing.linesMs) && r.timing.linesMs >= 0)
  })

  test('stage-2 line numbers stay true among repeated lines that share a long prefix (the match filter itself is a pure speed-up)', async function () {
    this.timeout(30_000)
    const shared = 'shared prefix of a long line '.repeat(20)
    const f = rawFile('prefix.jsonl', [entry(shared), entry(shared + 'NEEDLE'), entry(shared), entry(shared + 'NEEDLE')].join('\n') + '\n')
    const r = await searchTranscripts([f, other()], 'NEEDLE')
    assert.deepStrictEqual(r.hits.filter(h => h.session === 'prefix').map(h => h.line).sort(), validNeedleLines(f), 'lines 2 and 4')
    assert.deepStrictEqual(r.skipped, { lines: 0, files: 0 }, 'a clean scope skips nothing')
    assert.deepStrictEqual((await searchTranscripts([f, other()], 'NEEDLE', { mode: 'count' })).skipped, { lines: 0, files: 0 }, 'count mode too')
  })

  test('a torn last line (live transcript) does not fail the search and earlier hits keep their true lines', async function () {
    this.timeout(30_000)
    const f = rawFile('torn-tail.jsonl', [entry('NEEDLE 1'), entry('plain'), entry('NEEDLE 3')].join('\n') + '\n{"type":"user","message":{"content":"NEEDLE torn')
    for (const files of [[f], [f, other()]]) {
      const r = await searchTranscripts(files, 'NEEDLE')
      assert.deepStrictEqual(r.hits.filter(h => h.session === 'torn-tail').map(h => h.line).sort(), validNeedleLines(f), `${files.length} file(s)`)
      assert.deepStrictEqual(r.skipped, { lines: 1, files: 1 }, `${files.length} file(s)`)
    }
  })

  test('a malformed line in the middle is skipped and the lines after it keep their physical numbers', async function () {
    this.timeout(30_000)
    const f = rawFile('torn-mid.jsonl', [entry('NEEDLE 1'), entry('NEEDLE 2'), '{"type":"user","message":{"content":"NEEDLE bad', entry('NEEDLE 4'), entry('plain'), entry('NEEDLE 6')].join('\n') + '\n')
    for (const files of [[f], [f, other()]]) {
      const r = await searchTranscripts(files, 'NEEDLE')
      assert.deepStrictEqual(r.hits.filter(h => h.session === 'torn-mid').map(h => h.line).sort(), validNeedleLines(f), `${files.length} file(s)`)
      assert.deepStrictEqual(r.skipped, { lines: 1, files: 1 }, `${files.length} file(s)`)
      const c = await searchTranscripts(files, 'NEEDLE', { mode: 'count' })
      assert.strictEqual(c.counts.find(x => x.session === 'torn-mid')?.count, validNeedleLines(f).length, 'count mode does not count the invalid line')
      assert.strictEqual(c.total, validNeedleLines(f).length + files.length - 1, 'count mode total')
      assert.deepStrictEqual(c.skipped, { lines: 1, files: 1 }, 'count mode')
      assert.deepStrictEqual((await searchTranscripts(files, 'NEEDLE', { role: 'user' })).skipped, { lines: 1, files: 1 }, 'a role filter keeps the invalid line in the count')
    }
  })

  test('multi-MB small files (4-thread scan group): single and two-file scopes report the physical lines of every needle', async function () {
    this.timeout(60_000)
    // ~6 MB each, a needle on every 97th line: spans many reader buffers, so a thread-ordering slip in row_number() would show.
    const bulk = (name: string): TranscriptFile => {
      const lines = Array.from({ length: 3000 }, (_, i) => entry(`${(i + 1) % 97 === 0 ? 'NEEDLE ' : 'plain '}${i} ${'z'.repeat(2000)}`))
      return rawFile(name, lines.join('\n') + '\n')
    }
    const a = bulk('bulk-a.jsonl')
    const b = bulk('bulk-b.jsonl')
    assert.ok(a.size > 5_000_000 && a.size < 32 * 1048576, 'fixture must land in the small-file group')
    const want = validNeedleLines(a)
    const one = await searchTranscripts([a], 'NEEDLE', { limit: 500 })
    assert.deepStrictEqual(one.hits.map(h => h.line), want, 'one transcript: file order, physical lines')
    const two = await searchTranscripts([a, b], 'NEEDLE', { limit: 500 })
    assert.deepStrictEqual(two.hits.filter(h => h.session === 'bulk-a').map(h => h.line).sort((x, y) => (x ?? 0) - (y ?? 0)), want, 'two transcripts: stage 2 lines')
    assert.deepStrictEqual(two.hits.filter(h => h.session === 'bulk-b').map(h => h.line).sort((x, y) => (x ?? 0) - (y ?? 0)), validNeedleLines(b))
  })
})
