// src/test/searchCli.test.ts — `agentlenspro search` (TRDD-P31SWA8I, TRDD-UIQS9RXZ): the DuckDB
// transcript query engine, project-wide scope and the verb's usage contract. Real DuckDB against
// real fixture files — no mocks.

import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  searchTranscript, searchTranscripts, discoverTranscripts, parseTimeArg, runSearchCli, openDuck, TranscriptFile,
  SearchScopeError, SearchHit, SearchOptions, ScopeOptions, ELEMENT_KINDS,
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

// ── element mode (TRDD-OIMXULDJ) ─────────────────────────────────────────────────────────────────
// Every expected value is computed in JavaScript from the fixture below: each line is declared together with the elements it must yield.

const PROJECT_E = "/fake/elem"
const SID_E = "eeeeeeee-1111-2222-3333-444444444444"
const AGENT_E = "ffff4444aaaa5555"
const DIR_E = path.join(CFG, "projects", projectSlugOf(PROJECT_E))
const FILE_E = path.join(DIR_E, `${SID_E}.jsonl`)
const FILE_ESUB = path.join(DIR_E, SID_E, "subagents", `agent-${AGENT_E}.jsonl`)

/** One fixture line and the elements it must yield: kinds most specific first, the tool of a call or of the output answering it, the text. */
interface Fx { obj: Record<string, unknown>; els: Array<{ kinds: string[]; tool?: string; text: string }> }
const stamp = (n: number): string => `2026-08-18T10:00:${String(n).padStart(2, "0")}.000Z`
const call = (name: string, id: string, input: Record<string, unknown>): { block: Record<string, unknown>; text: string } =>
  ({ block: { type: "tool_use", id, name, input }, text: `${name}\n${JSON.stringify(input)}` })
const bashStatus = call("Bash", "tb1", { command: "git status NEEDLE-b" })
const editA = call("Edit", "te1", { file_path: "/x/a.ts", old_string: "NEEDLE-e" })
const agentCall = call("Agent", "ta1", { prompt: "NEEDLE-a" })
const bashCommit = call("Bash", "tb2", { command: "git commit -m x" })
const editQuiet = call("Edit", "te2", { file_path: "/x/b.ts", old_string: "QUIETWORD-diff" })
const agentQuiet = call("Agent", "ta2", { prompt: "QUIETWORD-agent" })
const result = (id: string, content: unknown, extra: Record<string, unknown> = {}, isError = false): Record<string, unknown> =>
  ({ type: "user", timestamp: stamp(10), ...extra, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] } })
const sys = (subtype: string, extra: Record<string, unknown>): Record<string, unknown> => ({ type: "system", subtype, timestamp: stamp(20), ...extra })
const asLine = (obj: Record<string, unknown>): string => JSON.stringify(obj)
const unknownSub = sys("brand_new_subtype", { uuid: "UNKNOWN-ENV-u" })
const twin = { type: "user", timestamp: stamp(34), message: { role: "user", content: "twin TWINWORD" } }
const MAIN: Fx[] = [
  /* 1 */ { obj: { type: "user", timestamp: stamp(0), message: { role: "user", content: "please fix the ENOENT crash" } }, els: [{ kinds: ["prompt"], text: "please fix the ENOENT crash" }] },
  /* 2 */ {
    obj: { type: "assistant", timestamp: stamp(1), message: { role: "assistant", model: "m-a", content: [
      { type: "text", text: "resp NEEDLE-r" }, { type: "thinking", thinking: "think NEEDLE-t" }, bashStatus.block, editA.block] } },
    els: [{ kinds: ["response"], text: "resp NEEDLE-r" }, { kinds: ["thinking"], text: "think NEEDLE-t" },
      { kinds: ["tool-call"], tool: "Bash", text: bashStatus.text }, { kinds: ["diff", "tool-call"], tool: "Edit", text: editA.text }],
  },
  /* 3 */ { obj: result("tb1", "on branch NEEDLE-o\nline2", { toolUseResult: { stdout: "on branch NEEDLE-o\nline2", stderr: "" } }), els: [{ kinds: ["tool-output"], tool: "Bash", text: "on branch NEEDLE-o\nline2" }] },
  /* 4 */ { obj: result("te1", "updated NEEDLE-d", { toolUseResult: { filePath: "/x/a.ts", structuredPatch: [{ oldStart: 1 }] } }), els: [{ kinds: ["diff", "tool-output"], tool: "Edit", text: "updated NEEDLE-d" }] },
  /* 5 */ { obj: { type: "assistant", timestamp: stamp(2), message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "synth NEEDLE-s" }] } }, els: [{ kinds: ["response"], text: "synth NEEDLE-s" }] },
  /* 6 */ { obj: { type: "assistant", timestamp: stamp(3), message: { role: "assistant", model: "m-b", content: [agentCall.block] } }, els: [{ kinds: ["subagent", "tool-call"], tool: "Agent", text: agentCall.text }] },
  /* 7 */ { obj: result("ta1", [{ type: "text", text: "agent said NEEDLE-ao" }], { toolUseResult: { agentId: "x1", status: "completed" } }), els: [{ kinds: ["subagent", "tool-output"], tool: "Agent", text: "agent said NEEDLE-ao" }] },
  /* 8 */ { obj: sys("stop_hook_summary", { hookInfos: [{ command: "NEEDLE-h" }] }), els: [{ kinds: ["hook"], text: "NEEDLE-h" }] },
  /* 9 */ { obj: { type: "attachment", timestamp: stamp(21), attachment: { type: "hook_success", content: "hook says NEEDLE-hk", stdout: "out" } }, els: [{ kinds: ["hook"], text: "hook says NEEDLE-hk" }] },
  /* 10 */ { obj: sys("api_error", { error: { message: "NEEDLE-err" } }), els: [{ kinds: ["error"], text: "NEEDLE-err" }] },
  /* 11 */ { obj: result("tb1", "boom NEEDLE-x", {}, true), els: [{ kinds: ["error", "tool-output"], tool: "Bash", text: "boom NEEDLE-x" }] },
  /* 12 */ { obj: sys("local_command", { content: "<command-name>/foo</command-name> NEEDLE-lc" }), els: [{ kinds: ["command"], text: "NEEDLE-lc" }] },
  /* 13 */ { obj: { type: "user", timestamp: stamp(22), message: { role: "user", content: "<command-name>/bar</command-name> NEEDLE-cp" } }, els: [{ kinds: ["command"], text: "NEEDLE-cp" }] },
  /* 14 */ { obj: sys("scheduled_task_fire", { content: "cron NEEDLE-cr" }), els: [{ kinds: ["cron"], text: "cron NEEDLE-cr" }] },
  /* 15 */ { obj: { type: "summary", summary: "sum NEEDLE-sm" }, els: [{ kinds: ["compact"], text: "sum NEEDLE-sm" }] },
  /* 16 */ { obj: sys("compact_boundary", { content: "NEEDLE-cb" }), els: [{ kinds: ["compact"], text: "NEEDLE-cb" }] },
  /* 17 */ { obj: sys("informational", { content: "info NEEDLE-in" }), els: [{ kinds: ["system"], text: "info NEEDLE-in" }] },
  /* 18 */ { obj: { type: "attachment", timestamp: stamp(23), attachment: { type: "queued_command", prompt: "queued NEEDLE-q" } }, els: [{ kinds: ["command"], text: "queued NEEDLE-q" }] },
  /* 19 */ { obj: { type: "attachment", timestamp: stamp(24), attachment: { type: "total_tokens_reminder", content: "NEEDLE-att" } }, els: [{ kinds: ["attachment"], text: "NEEDLE-att" }] },
  /* 20 */ { obj: { type: "queue-operation", operation: "enqueue", timestamp: stamp(25), content: "NEEDLE-qo" }, els: [{ kinds: ["command"], text: "NEEDLE-qo" }] },
  /* 21 */ { obj: { type: "user", timestamp: stamp(26), isMeta: true, message: { role: "user", content: "meta NEEDLE-meta" } }, els: [] },
  /* 22 */ { obj: { type: "user", timestamp: stamp(27), message: { role: "user", content: "he said \"hello\" there\nsecond line" } }, els: [{ kinds: ["prompt"], text: "he said \"hello\" there\nsecond line" }] },
  /* 23 */ { obj: { type: "assistant", timestamp: stamp(28), message: { role: "assistant", model: "m-b", content: [bashCommit.block] } }, els: [{ kinds: ["tool-call"], tool: "Bash", text: bashCommit.text }] },
  /* 24 */ { obj: result("tb2", "[main] committed msg", { toolUseResult: { gitOperation: { commit: { sha: "abc1234def" } } } }), els: [{ kinds: ["tool-output"], tool: "Bash", text: "[main] committed msg" }] },
  /* 25: the same tool_use id again, as a transcript that repeats an assistant line does */ { obj: { type: "assistant", timestamp: stamp(29), message: { role: "assistant", content: [bashCommit.block] } }, els: [{ kinds: ["tool-call"], tool: "Bash", text: bashCommit.text }] },
  // 26 and 27: request entries holding a copy of a call and its output. els is empty on purpose: they are out of element mode by default (own test).
  /* 26 */ { obj: { type: "api-request-blob", timestamp: stamp(31), message: { role: "assistant", content: [call("Bash", "tb9", { command: "git BLOBX" }).block] } }, els: [] },
  /* 27 */ { obj: { type: "api-request-blob", timestamp: stamp(32), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tb9", content: "result BLOBX" }] } }, els: [] },
  // 28 to 34: text of system and attachment entries. ENVWORD and UNKNOWN-ENV sit only in the ENVELOPE (uuid, identity), PAYLOAD-* and TEXTONLY only in the payload fields.
  /* 28 */ { obj: sys("stop_hook_summary", { hookInfos: [{ command: "PAYLOAD-hs" }], hookErrors: [], stopReason: "", uuid: "ENVWORD-u1" }), els: [{ kinds: ["hook"], text: "PAYLOAD-hs" }] },
  /* 29 */ { obj: sys("api_error", { error: { message: "PAYLOAD-ae" }, source: "repl_main_thread", uuid: "ENVWORD-u2" }), els: [{ kinds: ["error"], text: "PAYLOAD-ae" }] },
  /* 30: turn_duration has no payload text: it never matches, whatever the pattern */ { obj: sys("turn_duration", { durationMs: 1234, messageCount: 5, uuid: "ENVWORD-u3" }), els: [] },
  /* 31: a subtype that is not named keeps the raw line as its text */ { obj: unknownSub, els: [{ kinds: ["system"], text: asLine(unknownSub) }] },
  /* 32: an attachment with only a text field, and an identity object that must not be searched when the text exists */ { obj: { type: "attachment", timestamp: stamp(33), attachment: { type: "model", identity: { name: "ENVWORD-id" }, text: "TEXTONLY-att" } }, els: [{ kinds: ["attachment"], text: "TEXTONLY-att" }] },
  // 33 and 34: two byte-identical lines
  /* 33 */ { obj: twin, els: [{ kinds: ["prompt"], text: "twin TWINWORD" }] },
  /* 34 */ { obj: twin, els: [{ kinds: ["prompt"], text: "twin TWINWORD" }] },
  /* 35: every payload field of stop_hook_summary populated, hookInfos empty */ { obj: sys("stop_hook_summary", { hookInfos: [], hookErrors: ["PAYLOAD-he"], hookAdditionalContext: ["PAYLOAD-hc"], stopReason: "PAYLOAD-sr", uuid: "ENVWORD-u4" }), els: [{ kinds: ["hook"], text: "PAYLOAD-he\nPAYLOAD-hc\nPAYLOAD-sr" }] },
  /* 36: api_error with a source and no error object */ { obj: sys("api_error", { source: "PAYLOAD-src", uuid: "ENVWORD-u5" }), els: [{ kinds: ["error"], text: "PAYLOAD-src" }] },
  /* 37: api_error with an error object and no source */ { obj: sys("api_error", { error: { message: "PAYLOAD-only-error" }, uuid: "ENVWORD-u6" }), els: [{ kinds: ["error"], text: "PAYLOAD-only-error" }] },
  // 38 to 43: the element of each kind below that holds no NEEDLE, beside the matching element of the same kind above (acceptance box 3). QUIETWORD-* is searched by no other test.
  /* 38 */ { obj: { type: "assistant", timestamp: stamp(35), message: { role: "assistant", content: [{ type: "thinking", thinking: "think QUIETWORD-think" }] } }, els: [{ kinds: ["thinking"], text: "think QUIETWORD-think" }] },
  /* 39 */ { obj: { type: "assistant", timestamp: stamp(36), message: { role: "assistant", content: [editQuiet.block] } }, els: [{ kinds: ["diff", "tool-call"], tool: "Edit", text: editQuiet.text }] },
  /* 40 */ { obj: { type: "assistant", timestamp: stamp(37), message: { role: "assistant", content: [agentQuiet.block] } }, els: [{ kinds: ["subagent", "tool-call"], tool: "Agent", text: agentQuiet.text }] },
  /* 41 */ { obj: sys("local_command", { content: "<command-name>/quiet</command-name> QUIETWORD-cmd" }), els: [{ kinds: ["command"], text: "QUIETWORD-cmd" }] },
  /* 42 */ { obj: sys("compact_boundary", { content: "QUIETWORD-compact" }), els: [{ kinds: ["compact"], text: "QUIETWORD-compact" }] },
  /* 43 */ { obj: sys("scheduled_task_fire", { content: "cron QUIETWORD-cron" }), els: [{ kinds: ["cron"], text: "cron QUIETWORD-cron" }] },
]
const SUBF: Fx[] = [
  { obj: { type: "user", timestamp: stamp(30), message: { role: "user", content: "sub start NEEDLE-sp" } }, els: [{ kinds: ["prompt"], text: "sub start NEEDLE-sp" }] },
  { obj: { type: "assistant", timestamp: stamp(31), message: { role: "assistant", content: [{ type: "text", text: "sub reply NEEDLE-sr" }] } }, els: [{ kinds: ["response"], text: "sub reply NEEDLE-sr" }] },
]
writeJsonl(FILE_E, MAIN.map(f => f.obj))
writeJsonl(FILE_ESUB, SUBF.map(f => f.obj))

const DEFAULT_SELECTION = ELEMENT_KINDS.filter(k => k !== "attachment" && k !== "model-change")
/** What a search must return, from the fixture declaration: "main#<line>:<kind>[ <tool>]", sorted. `agentOnly` is the --kind subagent rule. */
function expectedElements(pattern: string, selection: string[], keep: (e: Fx["els"][number]) => boolean = () => true, agentOnly = false): string[] {
  return [["main", MAIN] as const, ["sub", SUBF] as const].flatMap(([tag, fixture]) => fixture.flatMap((f, i) => f.els.flatMap(e => {
    const kind = agentOnly && tag === "sub" ? "subagent" : e.kinds.find(k => selection.includes(k))
    const wanted = agentOnly && tag === "sub" ? true : kind !== undefined
    return wanted && keep(e) && e.text.toLowerCase().includes(pattern.toLowerCase()) ? [`${tag}#${i + 1}:${kind}${e.tool ? ` ${e.tool}` : ""}`] : []
  }))).sort()
}
const gotElements = (hits: SearchHit[]): string[] => hits.map(h => `${h.agent ? "sub" : "main"}#${h.line}:${h.kind}${h.tool ? ` ${h.tool}` : ""}`).sort()
const runE = (pattern: string, opts: SearchOptions = {}) => searchTranscripts(discoverTranscripts(PROJECT_E, {}), pattern, { limit: 500, ...opts })

suite("searchCli — element mode (TRDD-OIMXULDJ)", () => {
  suiteSetup(pointAtFixture)
  suiteTeardown(restoreConfig)

  test("one line holding text, thinking and two tool calls yields one hit per element, and a thinking-only pattern is no response", async function () {
    this.timeout(60_000)
    const r = await runE("NEEDLE", { kinds: DEFAULT_SELECTION })
    assert.deepStrictEqual(gotElements(r.hits).filter(s => s.startsWith("main#2:")), expectedElements("NEEDLE", DEFAULT_SELECTION).filter(s => s.startsWith("main#2:")))
    assert.deepStrictEqual(gotElements(r.hits).filter(s => s.startsWith("main#2:")), ["main#2:diff Edit", "main#2:response", "main#2:thinking", "main#2:tool-call Bash"], "four elements, four kinds")
    assert.strictEqual((await runE("NEEDLE-t", { kinds: ["response"] })).total, 0, "NEEDLE-t is only in the thinking block")
    assert.deepStrictEqual(gotElements((await runE("NEEDLE-t", { kinds: ["thinking"] })).hits), ["main#2:thinking"])
  })

  test("a plain-string user content is a prompt, and a tool output also present as toolUseResult.stdout is counted once", async function () {
    this.timeout(60_000)
    assert.deepStrictEqual(gotElements((await runE("please fix", { kinds: ["prompt"] })).hits), expectedElements("please fix", ["prompt"]))
    const r = await runE("NEEDLE-o", { kinds: ["tool-output"] })
    assert.strictEqual(r.total, 1, "block and toolUseResult.stdout both hold the text: one element")
    assert.deepStrictEqual(gotElements(r.hits), ["main#3:tool-output Bash"])
  })

  test("every kind finds exactly its own elements, and a pattern that no element of the kind holds finds nothing", async function () {
    this.timeout(120_000)
    for (const kind of ELEMENT_KINDS.filter(k => k !== "model-change")) {
      const r = await runE("NEEDLE", { kinds: [kind] })
      // --kind subagent alone also takes every element of a sub-agent transcript (its own test below); the other kinds follow the declared kinds.
      const want = expectedElements("NEEDLE", [kind], () => true, kind === "subagent")
      assert.deepStrictEqual(gotElements(r.hits), want, kind)
      assert.strictEqual(r.total, want.length, `${kind}: total counts elements`)
      assert.strictEqual((await runE("zzz-held-by-no-element", { kinds: [kind] })).total, 0, `${kind}: no match`)
      // Box 3: the non-matching element of each of these kinds (entries 38 to 43, QUIETWORD-*) really is produced, as an element of that kind, by the same engine run.
      if (["thinking", "diff", "subagent", "command", "compact", "cron"].includes(kind)) {
        const quiet = await runE("QUIETWORD", { kinds: [kind] })
        assert.strictEqual(quiet.total, 1, `${kind}: the QUIETWORD element exists`)
        assert.deepStrictEqual(gotElements(quiet.hits), expectedElements("QUIETWORD", [kind], () => true, kind === "subagent"), `${kind}: QUIETWORD element`)
      }
    }
    assert.strictEqual((await runE("NEEDLE-att", { kinds: DEFAULT_SELECTION })).total, 0, "attachment is opt-in")
    assert.strictEqual((await runE("NEEDLE-meta", { kinds: ["prompt"] })).total, 0, "isMeta user entries are not prompts")
  })

  test("hook + attachment + command searched together find the union of the three kinds, each element once (attachment text branches are built per selected kind)", async function () {
    this.timeout(60_000)
    const sel = ["hook", "attachment", "command"]
    const r = await runE("NEEDLE", { kinds: sel })
    assert.deepStrictEqual(gotElements(r.hits), expectedElements("NEEDLE", sel))
    assert.strictEqual(r.total, expectedElements("NEEDLE", sel).length)
    assert.ok(expectedElements("NEEDLE", sel).some(s => s.endsWith(":hook")) && expectedElements("NEEDLE", sel).some(s => s.endsWith(":command")) && expectedElements("NEEDLE", sel).some(s => s.endsWith(":attachment")), "the fixture holds all three kinds")
  })

  test("--tool returns the call and its output, a * mask works, an unknown tool finds nothing", async function () {
    this.timeout(60_000)
    const bash = (e: Fx["els"][number]): boolean => e.tool === "Bash"
    assert.deepStrictEqual(gotElements((await runE("NEEDLE", { tools: ["Bash"] })).hits), expectedElements("NEEDLE", DEFAULT_SELECTION, bash))
    assert.deepStrictEqual(gotElements((await runE("NEEDLE", { tools: ["B*"] })).hits), expectedElements("NEEDLE", DEFAULT_SELECTION, bash), "mask B*")
    assert.deepStrictEqual(gotElements((await runE("NEEDLE", { tools: ["*dit"] })).hits), expectedElements("NEEDLE", DEFAULT_SELECTION, e => e.tool === "Edit"), "mask *dit")
    assert.strictEqual((await runE("NEEDLE", { tools: ["Nope"] })).total, 0)
    assert.deepStrictEqual(gotElements((await runE("NEEDLE", { tools: ["Bash"], kinds: ["tool-output"] })).hits), expectedElements("NEEDLE", ["tool-output"], bash), "--tool with --kind")
  })

  test("request entries are out of element mode by default, and in with --include-requests or --type api-request-blob", async function () {
    this.timeout(60_000)
    const both = ["tool-call", "tool-output"]
    assert.strictEqual((await runE("BLOBX", { kinds: both })).total, 0, "a blob holding a tool_use and a tool_result is absent by default")
    assert.strictEqual((await runE("BLOBX", { tools: ["Bash"] })).total, 0, "also under --tool")
    const want = ["main#26:tool-call Bash", "main#27:tool-output"]
    assert.deepStrictEqual(gotElements((await runE("BLOBX", { kinds: both, includeRequests: true })).hits), want, "--include-requests")
    assert.deepStrictEqual(gotElements((await runE("BLOBX", { kinds: both, type: "api-request-blob" })).hits), want, "--type api-request-blob")
    const cli = await runCli(["BLOBX", "--project", PROJECT_E, "--kind", "tool-call,tool-output", "--include-requests", "--json"])
    assert.strictEqual((JSON.parse(cli.out) as { total: number }).total, 2, "the CLI flag")
  })

  test("a tool_use id repeated on several lines does not multiply the calls or the outputs that carry it", async function () {
    this.timeout(60_000)
    const bash = (e: Fx["els"][number]): boolean => e.tool === "Bash"
    const want = expectedElements("commit", DEFAULT_SELECTION, bash)
    assert.deepStrictEqual(want, ["main#23:tool-call Bash", "main#24:tool-output Bash", "main#25:tool-call Bash"], "fixture: two call blocks with id tb2, one output")
    assert.deepStrictEqual(gotElements((await runE("commit", { tools: ["Bash"] })).hits), want)
  })

  test("--file keeps the calls whose input holds the text and the outputs that answer them or name the file", async function () {
    this.timeout(60_000)
    assert.deepStrictEqual(gotElements((await runE("NEEDLE", { file: "a.ts" })).hits), ["main#2:diff Edit", "main#4:diff Edit"])
    assert.strictEqual((await runE("NEEDLE", { file: "no-such-file.ts" })).total, 0)
  })

  test("--commit matches the gitOperation of an output and refuses a malformed SHA", async function () {
    this.timeout(60_000)
    assert.deepStrictEqual(gotElements((await runE("msg", { commit: "abc1234" })).hits), ["main#24:tool-output Bash"], "the SHA is only in toolUseResult.gitOperation")
    assert.strictEqual((await runE("msg", { commit: "fffffff" })).total, 0)
    await assert.rejects(() => runSearchCli(["msg", "--commit", "xyz"]), (e: unknown) => e instanceof UsageError)
  })

  test("--kind model-change reports the fixture change with its true line, ignores <synthetic>, and needs no pattern", async function () {
    this.timeout(60_000)
    const r = await runE("", { kinds: ["model-change"] })
    assert.deepStrictEqual(r.hits.map(h => [h.line, h.kind, h.excerpt]), [[6, "model-change", "m-a -> m-b"]], "line 5 is <synthetic> and line 23 repeats m-b")
    assert.strictEqual(r.total, 1)
    assert.strictEqual((await runE("m-a", { kinds: ["model-change"] })).total, 1)
    assert.strictEqual((await runE("zzz", { kinds: ["model-change"] })).total, 0)
    const cli = await runCli(["--project", PROJECT_E, "--kind", "model-change"])
    assert.strictEqual(cli.code, 0)
    assert.ok(cli.out.includes("[model-change]\tm-a -> m-b"), cli.out)
  })

  test("a pattern holding a double quote and one holding a newline are found (no raw-line prefilter)", async function () {
    this.timeout(60_000)
    assert.deepStrictEqual(gotElements((await runE("said \"hello\"", { kinds: ["prompt"] })).hits), ["main#22:prompt"])
    assert.deepStrictEqual(gotElements((await runE("there\nsecond", { kinds: ["prompt"] })).hits), ["main#22:prompt"])
    assert.deepStrictEqual(gotElements((await runE("said \\w+ there", { kinds: ["prompt"], regex: true })).hits), [], "a regex sees the unescaped text: the quotes are in the way")
    assert.deepStrictEqual(gotElements((await runE("said .hello. there", { kinds: ["prompt"], regex: true })).hits), ["main#22:prompt"])
  })

  test("--files and --file TEXT are not confused by the flag checks or the positional parser", async function () {
    this.timeout(60_000)
    const withFile = await runCli(["--file", "a.ts", "NEEDLE", "--project", PROJECT_E, "--json"])
    assert.strictEqual(withFile.code, 0)
    assert.deepStrictEqual(gotElements((JSON.parse(withFile.out) as { hits: SearchHit[] }).hits), ["main#2:diff Edit", "main#4:diff Edit"], "the pattern is NEEDLE, a.ts is the --file value")
    const files = await runCli(["NEEDLE", "--project", PROJECT_E, "--files"])
    assert.strictEqual(files.out, `${FILE_E}\n${FILE_ESUB}\n`, "--files still lists transcripts")
    await assert.rejects(() => runSearchCli(["NEEDLE", "--file"]), (e: unknown) => e instanceof UsageError)
  })

  test("total, --count and --files count elements, not lines", async function () {
    this.timeout(60_000)
    const wanted = expectedElements("NEEDLE", ["tool-call"])
    const mainCalls = wanted.filter(s => s.startsWith("main#")).length
    assert.ok(mainCalls > wanted.filter(s => s.startsWith("main#2:")).length, "fixture: calls on more than one line")
    const r = await runE("NEEDLE", { kinds: ["tool-call"] })
    assert.strictEqual(r.total, wanted.length, "total counts elements (line 2 holds two calls)")
    const count = await runCli(["NEEDLE", "--project", PROJECT_E, "--kind", "tool-call", "--count"])
    assert.strictEqual(count.out, `${mainCalls}\teeeeeeee\n`, "one row per transcript, the number of elements")
    const files = await runCli(["NEEDLE", "--project", PROJECT_E, "--kind", "tool-call", "--files"])
    assert.strictEqual(files.out, `${FILE_E}\n`, "only the main transcript holds a matching call")
  })

  test("--kind subagent alone also takes every element of a sub-agent transcript", async function () {
    this.timeout(60_000)
    const r = await runE("NEEDLE", { kinds: ["subagent"] })
    assert.deepStrictEqual(gotElements(r.hits), expectedElements("NEEDLE", ["subagent"], () => true, true))
    assert.deepStrictEqual(gotElements(r.hits), ["main#6:subagent Agent", "main#7:subagent Agent", "sub#1:subagent", "sub#2:subagent"])
    assert.deepStrictEqual(gotElements((await runE("NEEDLE", { kinds: ["subagent"], tools: ["Agent"] })).hits), ["main#6:subagent Agent", "main#7:subagent Agent"], "with --tool the sub-agent rule is off")
  })

  test("a torn line in element mode is counted as skipped, breaks nothing, and the other lines keep their true numbers", async function () {
    this.timeout(60_000)
    const torn = path.join(tmpDir, "elem-torn.jsonl")
    const lines = [asLine(MAIN[0].obj), "{\"type\":\"user\",\"message\":{\"content\":\"NEEDLE torn", asLine(MAIN[1].obj)]
    fs.writeFileSync(torn, lines.join("\n") + "\n")
    const f: TranscriptFile = { path: torn, session: "elem-torn", agent: null, size: fs.statSync(torn).size, mtimeMs: 0 }
    const r = await searchTranscripts([f, { ...f, path: FILE_E, session: "eeeeeeee", size: fs.statSync(FILE_E).size }], "NEEDLE", { kinds: ["response", "thinking"], limit: 500 })
    assert.deepStrictEqual(r.skipped, { lines: 1, files: 1 })
    assert.deepStrictEqual(r.hits.filter(h => h.session === "elem-torn").map(h => `${h.line}:${h.kind}`).sort(), ["3:response", "3:thinking"], "the line after the torn one is physical line 3")
    const alone = await searchTranscripts([f], "NEEDLE", { kinds: ["response"] })
    assert.deepStrictEqual(alone.hits.map(h => h.line), [3], "one transcript: same true line")
  })

  test("element mode on one transcript lists the hits in file order, each with its true line", async function () {
    this.timeout(60_000)
    const f: TranscriptFile = { path: FILE_E, session: "eeeeeeee", agent: null, size: fs.statSync(FILE_E).size, mtimeMs: 0 }
    const r = await searchTranscripts([f], "NEEDLE", { kinds: ["tool-output"], limit: 500 })
    const want = MAIN.flatMap((x, i) => x.els.some(e => e.kinds.includes("tool-output") && e.text.includes("NEEDLE")) ? [i + 1] : [])
    assert.deepStrictEqual(r.hits.map(h => h.line), want)
  })

  test("--kind, --commit and the model-change rule are checked before any transcript is read", async () => {
    for (const bad of [
      ["x", "--kind", "bogus"], ["x", "--kind", "model-change,prompt"], ["x", "--kind", "model-change", "--tool", "Bash"], ["--kind", "prompt"], ["x", "--commit", "12345"], ["x", "--tool"],
    ]) {
      await assert.rejects(() => runSearchCli(bad), (e: unknown) => e instanceof UsageError, bad.join(" "))
    }
    const help = await runCli(["--help"])
    for (const flag of ["--kind", "--tool", "--file TEXT", "--commit", "model-change", "UNESCAPED"]) assert.ok(help.out.includes(flag), flag)
  })

  test("text output prints [kind tool] and --json carries kind and tool in element mode only", async function () {
    this.timeout(60_000)
    const text = await runCli(["NEEDLE-o", "--project", PROJECT_E, "--tool", "Bash"])
    assert.match(text.out.split("\n")[0], /^eeeeeeee\t#3\t\S+\t\[tool-output Bash\]\ton branch NEEDLE-o line2$/)
    const json = JSON.parse((await runCli(["NEEDLE-o", "--project", PROJECT_E, "--kind", "tool-output", "--json"])).out) as { hits: Array<Record<string, unknown>> }
    assert.deepStrictEqual(Object.keys(json.hits[0]).sort(), ["agent", "excerpt", "file", "kind", "line", "role", "session", "tool", "ts", "type"])
    const lineMode = JSON.parse((await runCli(["NEEDLE-o", "--project", PROJECT_E, "--json"])).out) as { hits: Array<Record<string, unknown>> }
    assert.deepStrictEqual(Object.keys(lineMode.hits[0]).sort(), ["agent", "excerpt", "file", "line", "role", "session", "ts", "type"], "line mode is unchanged")
  })

  test("a system entry without content matches on its payload fields, not on its envelope; an unnamed subtype keeps the raw line", async function () {
    this.timeout(60_000)
    const kinds = ["hook", "error", "system", "attachment"]
    assert.strictEqual((await runE("ENVWORD", { kinds })).total, 0, "ENVWORD is only in uuid / identity fields of stop_hook_summary, api_error, turn_duration and an attachment that has text")
    assert.strictEqual((await runE("ENVWORD", { kinds, regex: true })).total, 0, "a regex sees the same text")
    assert.deepStrictEqual(gotElements((await runE("PAYLOAD-hs", { kinds: ["hook"] })).hits), ["main#28:hook"])
    assert.deepStrictEqual(gotElements((await runE("PAYLOAD-ae", { kinds: ["error"] })).hits), ["main#29:error"])
    assert.deepStrictEqual(gotElements((await runE("repl_main_thread", { kinds: ["error"] })).hits), ["main#29:error"], "api_error: the source field is payload")
    assert.deepStrictEqual(gotElements((await runE("UNKNOWN-ENV", { kinds: ["system"] })).hits), ["main#31:system"], "an unnamed subtype: the raw line, envelope included")
    assert.strictEqual((await runE("hookInfos", { kinds: ["hook"] })).total, 0, "a field NAME is not text")
    assert.deepStrictEqual(gotElements((await runE("PAYLOAD-he", { kinds: ["hook"] })).hits), ["main#35:hook"], "hookErrors alone")
    assert.deepStrictEqual(gotElements((await runE("PAYLOAD-hc", { kinds: ["hook"] })).hits), ["main#35:hook"], "hookAdditionalContext alone")
    assert.deepStrictEqual(gotElements((await runE("PAYLOAD-sr", { kinds: ["hook"] })).hits), ["main#35:hook"], "stopReason alone")
    assert.deepStrictEqual(gotElements((await runE("PAYLOAD-src", { kinds: ["error"] })).hits), ["main#36:error"], "api_error with no error object")
    assert.deepStrictEqual(gotElements((await runE("PAYLOAD-only-error", { kinds: ["error"] })).hits), ["main#37:error"], "api_error with no source")
  })

  test("turn_duration has no text: a pattern that matches the empty string hits every other element of the kind and never it", async function () {
    this.timeout(60_000)
    const r = await runE("a?", { kinds: ["system"], regex: true })
    assert.deepStrictEqual(gotElements(r.hits), expectedElements("", ["system"]), "the informational entry and the unnamed subtype, nothing else")
    assert.ok(!gotElements(r.hits).some(s => s.startsWith("main#30:")), "turn_duration (line 30)")
    const hooks = await runE("a?", { kinds: ["hook"], regex: true })
    assert.ok(gotElements(hooks.hits).some(s => s.startsWith("main#28:")), "line 28 holds hookInfos, so it has text")
  })

  test("an attachment with only a text field is found, and its envelope is not", async function () {
    this.timeout(60_000)
    assert.deepStrictEqual(gotElements((await runE("TEXTONLY", { kinds: ["attachment"] })).hits), ["main#32:attachment"])
    assert.deepStrictEqual(gotElements((await runE("^TEXTONLY-att$", { kinds: ["attachment"], regex: true })).hits), ["main#32:attachment"], "the element text is the text field itself, not the attachment JSON")
    assert.strictEqual((await runE("TEXTONLY", { kinds: ["hook", "command"] })).total, 0, "an attachment of another kind")
  })

  test("two byte-identical matching lines of one transcript get two different line numbers in element mode", async function () {
    this.timeout(60_000)
    const r = await runE("TWINWORD", { kinds: ["prompt"] })
    assert.deepStrictEqual(r.hits.map(h => h.line as number).sort((a, b) => a - b), [33, 34])
    const f: TranscriptFile = { path: FILE_E, session: "eeeeeeee", agent: null, size: fs.statSync(FILE_E).size, mtimeMs: 0 }
    assert.deepStrictEqual((await searchTranscripts([f], "TWINWORD", { kinds: ["prompt"], limit: 1 })).hits.map(h => h.line), [33], "limit 1 on one transcript: the first of the two")
  })
})

// ── scope filters in element mode and model-change mode (TRDD-OIMXULDJ) ─────────────────────────────
const PROJECT_F = "/fake/scope"
const DIR_F = path.join(CFG, "projects", projectSlugOf(PROJECT_F))
const entryF = (n: number, role: "user" | "assistant", model: string | null, branch: string, text: string): Record<string, unknown> => ({
  type: role, timestamp: `2026-08-${String(10 + n).padStart(2, "0")}T10:00:00.000Z`, gitBranch: branch,
  message: role === "user" ? { role, content: text } : { role, model, content: [{ type: "text", text }] },
})
writeJsonl(path.join(DIR_F, "ffffffff-1111-2222-3333-444444444444.jsonl"), [
  entryF(0, "user", null, "br-a", "SCOPEWORD one"), entryF(1, "assistant", "m-x", "br-b", "SCOPEWORD two"),
  entryF(2, "assistant", "m-y", "br-a", "SCOPEWORD three"), entryF(3, "assistant", "m-z", "br-b", "SCOPEWORD four"),
])

suite("searchCli — scope filters in element and model-change mode (TRDD-OIMXULDJ)", () => {
  suiteSetup(pointAtFixture)
  suiteTeardown(restoreConfig)
  const runF = (pattern: string, opts: SearchOptions) => searchTranscripts(discoverTranscripts(PROJECT_F, {}), pattern, { limit: 500, ...opts })
  const lines = (hits: SearchHit[]): number[] => hits.map(h => h.line as number).sort((a, b) => a - b)
  const changes = (hits: SearchHit[]): string[] => hits.map(h => `${h.line}:${h.excerpt}`).sort()
  const TEXT_KINDS = ["prompt", "response"]

  test("element mode: --since, --role and --branch each keep exactly the matching elements", async function () {
    this.timeout(60_000)
    assert.deepStrictEqual(lines((await runF("SCOPEWORD", { kinds: TEXT_KINDS })).hits), [1, 2, 3, 4], "no filter")
    assert.deepStrictEqual(lines((await runF("SCOPEWORD", { kinds: TEXT_KINDS, since: "2026-08-12T00:00:00.000Z" })).hits), [3, 4])
    assert.deepStrictEqual(lines((await runF("SCOPEWORD", { kinds: TEXT_KINDS, role: "user" })).hits), [1])
    assert.deepStrictEqual(lines((await runF("SCOPEWORD", { kinds: TEXT_KINDS, role: "assistant" })).hits), [2, 3, 4])
    assert.deepStrictEqual(lines((await runF("SCOPEWORD", { kinds: TEXT_KINDS, branch: "br-b" })).hits), [2, 4])
    assert.deepStrictEqual(lines((await runF("SCOPEWORD", { kinds: TEXT_KINDS, branch: "br-a", role: "assistant", since: "2026-08-12T00:00:00.000Z" })).hits), [3], "the three filters together")
  })

  test("model-change mode: --since and --branch filter the changes, and a filtered-out entry still counts as the previous model (--role is not applied in this mode: known gap, not asserted)", async function () {
    this.timeout(60_000)
    assert.deepStrictEqual(changes((await runF("", { kinds: ["model-change"] })).hits), ["3:m-x -> m-y", "4:m-y -> m-z"], "no filter")
    assert.deepStrictEqual(changes((await runF("", { kinds: ["model-change"], since: "2026-08-13T00:00:00.000Z" })).hits), ["4:m-y -> m-z"])
    assert.deepStrictEqual(changes((await runF("", { kinds: ["model-change"], branch: "br-a" })).hits), ["3:m-x -> m-y"])
    assert.deepStrictEqual(changes((await runF("", { kinds: ["model-change"], branch: "br-b" })).hits), ["4:m-y -> m-z"])
  })
})

// ── match modes, --show and --context (TRDD-O3U0K4HY) ────────────────────────────────────────────
// Every expected value is read off the fixtures below: the entries of a file are numbered 1.. in the order they are written.

const PROJECT_M = "/fake/match"
const DIR_M = path.join(CFG, "projects", projectSlugOf(PROJECT_M))
const SID_M1 = "11111111-aaaa-bbbb-cccc-dddddddddddd"
const SID_M2 = "22222222-aaaa-bbbb-cccc-dddddddddddd"
const FILE_M1 = path.join(DIR_M, `${SID_M1}.jsonl`)
const FILE_M2 = path.join(DIR_M, `${SID_M2}.jsonl`)
const promptAt = (n: number, content: string): Record<string, unknown> => ({
  type: "user", timestamp: `2026-08-20T10:${String(n).padStart(2, "0")}:00.000Z`, message: { role: "user", content },
})
const M1_TEXT = [
  /* 1 */ "report status", /* 2 */ "the port is open", /* 3 */ "Transport layer", /* 4 */ "50% off, 100% done", /* 5 */ "50 percent, 1000 done",
  /* 6 */ "item_x here", /* 7 */ "first line\nsecond word here", /* 8 */ "Hello World", /* 9 */ "hello world", /* 10 */ "ping the server",
  /* 11 */ "she said \"hi\" twice", /* 12 */ "itemXx here", /* 13 */ "the planet is here", /* 14 */ "a plonet appeared", /* 15 */ "a plnet appeared",
  /* 16 */ "a plaanet appeared", /* 17 */ "a plonex appeared", /* 18 */ "a plnaet appeared", /* 19 */ "mango applx", /* 20 */ "a lamq and a planet",
  /* 21 */ "a lamp and a planet", /* 22 */ "mango then apple",
]
writeJsonl(FILE_M1, M1_TEXT.map((t, i) => promptAt(i + 1, t)))
writeJsonl(FILE_M2, ["Hello again", "the port of call"].map((t, i) => promptAt(i + 1, t)))
// A transcript whose TEXT holds a literal backslash before n / r / t (a Windows path, a regex): the raw JSON line spells that as TWO backslashes and the letter (TRDD-RSV3UEJ9).
const FILE_BS = path.join(tmpDir, "33333333-aaaa-bbbb-cccc-dddddddddddd.jsonl")
writeJsonl(FILE_BS, [
  /* 1 */ "C:\\new folder", /* 2 */ "regex \\nabc here", /* 3 */ "one\ntwo", /* 4 */ "x\\\nsecondw", /* 5 */ "plain new here", /* 6 */ "tab \\trail and \\rest",
].map((t, i) => promptAt(i + 1, t)))
// The first literal segment of a mask ("p") occurs 600 characters before the place where the whole mask ("p?rt") matches (TRDD-6DRB39PR).
const FILE_EX = path.join(tmpDir, "44444444-aaaa-bbbb-cccc-dddddddddddd.jsonl")
writeJsonl(FILE_EX, [`p${"z".repeat(600)} the port is open`, `s${"z".repeat(600)} he said "hi" ok`].map((t, i) => promptAt(i + 1, t)))
const fileOf = (file: string, session: string): TranscriptFile => ({ path: file, session, agent: null, size: fs.statSync(file).size, mtimeMs: 0 })
const numeric = (a: number, b: number): number => a - b

/** The lines of M1 that a pattern finds. The four engine paths (one transcript or two, the raw line or the prompt elements) must give the same lines in the same
 *  order, each with a line number and an excerpt: a stage that disagreed with the other would show as a null line or an empty excerpt. */
async function linesM(pattern: string, opts: SearchOptions = {}): Promise<number[]> {
  const answers: number[][] = []
  for (const files of [[fileOf(FILE_M1, SID_M1)], discoverTranscripts(PROJECT_M, {})]) {
    for (const extra of [{}, { kinds: ["prompt"] }]) {
      const r = await searchTranscripts(files, pattern, { limit: 500, order: "old", ...opts, ...extra })
      const mine = r.hits.filter(h => h.session === SID_M1)
      assert.ok(mine.every(h => h.line !== null && h.excerpt !== ""), `${pattern}: every hit has a line and an excerpt (${files.length} file(s), ${JSON.stringify(extra)})`)
      answers.push(mine.map(h => h.line as number))
    }
  }
  for (const a of answers) assert.deepStrictEqual(a, answers[0], `${pattern}: the four engine paths agree`)
  return answers[0]
}

suite("searchCli — match modes (TRDD-O3U0K4HY)", () => {
  suiteSetup(pointAtFixture)
  suiteTeardown(restoreConfig)

  test("--mask: * is any run, ? is one character, a literal % and _ of the pattern are not wildcards", async function () {
    this.timeout(120_000)
    assert.deepStrictEqual(await linesM("rep*status", { mask: true }), [1], "* stands for a run of characters")
    assert.deepStrictEqual(await linesM("stat?s", { mask: true }), [1], "? stands for exactly one character")
    assert.deepStrictEqual(await linesM("p?rt", { mask: true }), [1, 2, 3])
    assert.deepStrictEqual(await linesM("50% *", { mask: true }), [4], "a % is a percent sign: line 5 ('50 percent') would match if it were LIKE's wildcard")
    assert.deepStrictEqual(await linesM("item_x", { mask: true }), [6], "a _ is an underscore: line 12 (itemXx) would match if it were LIKE's wildcard")
    assert.deepStrictEqual(await linesM("item?x", { mask: true }), [6, 12], "while ? is one character")
    assert.deepStrictEqual(await linesM("said \"hi\"", { mask: true }), [11], "a quote is JSON-escaped in the raw line")
    assert.deepStrictEqual(await linesM("HELLO*", { mask: true }), [8, 9], "case-insensitive by default")
    const r = await searchTranscripts([fileOf(FILE_M1, SID_M1)], "rep*status", { mask: true })
    assert.ok(r.hits[0].excerpt.includes("report status"), r.hits[0].excerpt)
  })

  test("--mask: the excerpt shows the match, not an earlier occurrence of the mask first literal segment", async function () {
    this.timeout(120_000)
    // p?rt: its first literal segment, "p", is the first character of the text, 600 characters before the match ("port"); the excerpt window is 100 before and 300 wide.
    // *p?rt* is the same match with the wildcards the wrapping % implies anyway: a lazy leading wildcard must not pull the excerpt back to the start of the text.
    for (const mask of ["p?rt", "*p?rt*"]) for (const extra of [{}, { kinds: ["prompt"] }] as Partial<SearchOptions>[]) {
      const r = await searchTranscripts([fileOf(FILE_EX, "44444444-aaaa-bbbb-cccc-dddddddddddd")], mask, { mask: true, ...extra })
      assert.deepStrictEqual(r.hits.map(h => h.line), [1], `${mask} ${JSON.stringify(extra)}`)
      assert.ok(r.hits[0].excerpt.includes("the port is open"), `${mask} ${JSON.stringify(extra)}: ${r.hits[0].excerpt}`)
    }
    // --case (RE2 without i) and a quote (two characters, \" , in the raw line; ? counts raw characters there, so s?id still spans "said"): the excerpt holds the match too.
    for (const [mask, caseSensitive, want, text] of [["p?rt", true, [1], "the port is open"], ["P?rt", true, [], ""], ["s?id \"hi\"", false, [2], "he said"]] as Array<[string, boolean, number[], string]>) {
      for (const extra of [{}, { kinds: ["prompt"] }] as Partial<SearchOptions>[]) {
        const r = await searchTranscripts([fileOf(FILE_EX, "44444444-aaaa-bbbb-cccc-dddddddddddd")], mask, { mask: true, caseSensitive, ...extra })
        assert.deepStrictEqual(r.hits.map(h => h.line), want, `${mask} case=${caseSensitive} ${JSON.stringify(extra)}`)
        if (want.length > 0) assert.ok(r.hits[0].excerpt.includes(text), `${mask} ${JSON.stringify(extra)}: ${r.hits[0].excerpt}`)
      }
    }
  })

  test("--word does not match inside a longer word, and matches at the start, at the end and next to a newline", async function () {
    this.timeout(120_000)
    assert.deepStrictEqual(await linesM("port"), [1, 2, 3], "a plain search finds 'port' inside 'report' and 'Transport'")
    assert.deepStrictEqual(await linesM("port", { word: true }), [2], "--word finds only the whole word")
    assert.deepStrictEqual(await linesM("report", { word: true }), [1], "at the start of the text")
    assert.deepStrictEqual(await linesM("Transport", { word: true }), [3])
    assert.deepStrictEqual(await linesM("world", { word: true }), [8, 9], "at the end of the text")
    assert.deepStrictEqual(await linesM("second", { word: true }), [7], "a word that starts after a newline (\\n in the raw line)")
    assert.deepStrictEqual(await linesM("line", { word: true }), [7], "a word that ends before a newline")
    assert.deepStrictEqual(await linesM("item_x", { word: true }), [6], "_ is a word character and a regex-special one: escaped")
    assert.deepStrictEqual(await linesM("50%", { word: true }), [4], "a pattern ending in punctuation")
    const r = await searchTranscripts([fileOf(FILE_M1, SID_M1)], "port", { word: true })
    assert.ok(r.hits[0].excerpt.includes("the port is open"), r.hits[0].excerpt)
  })

  test("--word reads a literal backslash before n, r or t as part of the word, not as an escaped newline, tab or carriage return", async function () {
    this.timeout(120_000)
    const lines = async (pattern: string, extra: Partial<SearchOptions>): Promise<number[]> =>
      (await searchTranscripts([fileOf(FILE_BS, "33333333-aaaa-bbbb-cccc-dddddddddddd")], pattern, { limit: 500, order: "old", word: true, ...extra })).hits.map(h => h.line as number)
    // The line mode (raw JSON) and the prompt-element mode (decoded text) must agree: the first is the one that read the escape.
    for (const extra of [{}, { kinds: ["prompt"] }] as Partial<SearchOptions>[]) {
      const mode = JSON.stringify(extra)
      assert.deepStrictEqual(await lines("ew", extra), [], `ew is inside new in C:\\new: not a word (${mode})`)
      assert.deepStrictEqual(await lines("abc", extra), [], `abc follows a literal backslash and an n: not a word (${mode})`)
      assert.deepStrictEqual(await lines("rail", extra), [], `rail follows a literal backslash and a t (${mode})`)
      assert.deepStrictEqual(await lines("est", extra), [], `est follows a literal backslash and an r (${mode})`)
      assert.deepStrictEqual(await lines("new", extra), [1, 5], `new is still a word after a literal backslash (${mode})`)
      assert.deepStrictEqual(await lines("two", extra), [3], `a real newline is still an edge (${mode})`)
      assert.deepStrictEqual(await lines("secondw", extra), [4], `a literal backslash then a real newline: the newline is still an edge (${mode})`)
    }
  })

  test("--case makes literal, mask and word matching case-sensitive, and is refused with --fuzzy", async function () {
    this.timeout(120_000)
    assert.deepStrictEqual(await linesM("Hello"), [8, 9])
    assert.deepStrictEqual(await linesM("Hello", { caseSensitive: true }), [8])
    assert.deepStrictEqual(await linesM("hello", { caseSensitive: true }), [9])
    assert.deepStrictEqual(await linesM("Hello*", { mask: true, caseSensitive: true }), [8])
    assert.deepStrictEqual(await linesM("PORT", { word: true }), [2])
    assert.deepStrictEqual(await linesM("PORT", { word: true, caseSensitive: true }), [])
    assert.deepStrictEqual(await linesM("port", { word: true, caseSensitive: true }), [2])
    await assert.rejects(() => runSearchCli(["x", "--fuzzy", "--case"]), (e: unknown) => e instanceof UsageError && /--case/.test((e as Error).message))
  })

  test("--fuzzy: words in any order; one substitution, deletion and insertion in a 6-letter word match; two edits and a 4-letter word's one edit do not", async function () {
    this.timeout(120_000)
    // planet: 13 exact, 14 substituted (plonet), 15 deleted (plnet), 16 inserted (plaanet), 20 and 21 exact; 17 (plonex) is two edits and 18 (plnaet) a transposition: not found.
    assert.deepStrictEqual((await linesM("planet", { fuzzy: true })).sort(numeric), [13, 14, 15, 16, 20, 21])
    assert.deepStrictEqual((await linesM("apple mango", { fuzzy: true })).sort(numeric), [19, 22], "line 22 holds the words in the other order, line 19 has applx for apple")
    assert.deepStrictEqual((await linesM("mango apple", { fuzzy: true })).sort(numeric), [19, 22])
    assert.deepStrictEqual(await linesM("lamp planet", { fuzzy: true }), [21], "lamq is one edit from the 4-letter lamp: line 20 needs an exact lamp")
    assert.deepStrictEqual((await linesM("plAnet", { fuzzy: true })).sort(numeric), [13, 14, 15, 16, 20, 21], "case-insensitive")
  })

  test("the excerpt of every match mode is a window around the match, also deep inside a long line", async function () {
    this.timeout(60_000)
    const long = path.join(CFG, "projects", projectSlugOf("/fake/long"), "66666666-aaaa-bbbb-cccc-dddddddddddd.jsonl")
    writeJsonl(long, [promptAt(1, `${"z ".repeat(750)}the plonet is here ${"y ".repeat(300)}`)])
    const f = fileOf(long, "66666666-aaaa-bbbb-cccc-dddddddddddd")
    for (const opts of [{}, { mask: true }, { word: true }, { fuzzy: true }] as SearchOptions[]) {
      const pattern = opts.mask ? "plo?et" : opts.fuzzy ? "planet" : "plonet"
      for (const extra of [{}, { kinds: ["prompt"] }]) {
        const r = await searchTranscripts([f, fileOf(FILE_M2, SID_M2)], pattern, { ...opts, ...extra })
        assert.strictEqual(r.hits.length, 1, `${pattern} ${JSON.stringify(opts)}`)
        assert.ok(r.hits[0].excerpt.includes("the plonet is here"), `${pattern} ${JSON.stringify(opts)} ${JSON.stringify(extra)}: ${r.hits[0].excerpt.slice(0, 80)}`)
        assert.ok(r.hits[0].excerpt.length <= 300)
      }
    }
  })

  test("--fuzzy orders the hits by the words held exactly, then by time (file order for one transcript)", async function () {
    this.timeout(120_000)
    const lines = async (files: TranscriptFile[], pattern: string, order?: "new" | "old"): Promise<number[]> =>
      (await searchTranscripts(files, pattern, { fuzzy: true, limit: 500, order })).hits.filter(h => h.session === SID_M1).map(h => h.line as number)
    const one = [fileOf(FILE_M1, SID_M1)]
    const two = discoverTranscripts(PROJECT_M, {})
    assert.deepStrictEqual(await lines(one, "planet"), [13, 20, 21, 14, 15, 16], "exact words first, each group in file order (file order alone would be 13,14,15,16,20,21)")
    assert.deepStrictEqual(await lines(two, "planet", "new"), [21, 20, 13, 16, 15, 14], "two transcripts: exact first, each group newest first")
    assert.deepStrictEqual(await lines(two, "planet", "old"), [13, 20, 21, 14, 15, 16], "--order old: each group oldest first")
    assert.deepStrictEqual(await lines(two, "apple mango", "old"), [22, 19], "both words exact (22) before one word edited (19), although 19 is older")
    assert.deepStrictEqual(await lines(one, "apple mango", "old"), [22, 19], "one transcript with --order: same")
    const el = await searchTranscripts(two, "apple mango", { fuzzy: true, kinds: ["prompt"], order: "old" })
    assert.deepStrictEqual(el.hits.filter(h => h.session === SID_M1).map(h => h.line), [22, 19], "element mode orders the same way")
  })

  test("a --fuzzy pattern with no word or a word over 40 characters is a usage error", async () => {
    for (const bad of ["   ", "x".repeat(41)]) {
      await assert.rejects(() => searchTranscripts([fileOf(FILE_M1, SID_M1)], bad, { fuzzy: true }), (e: unknown) => e instanceof UsageError, JSON.stringify(bad))
    }
    assert.strictEqual((await searchTranscripts([fileOf(FILE_M1, SID_M1)], "x".repeat(40), { fuzzy: true })).total, 0, "40 characters is accepted")
  })

  test("two match modes together are a usage error, whichever pair", async () => {
    for (const pair of [["--regex", "--mask"], ["--regex", "--word"], ["--regex", "--fuzzy"], ["--mask", "--word"], ["--mask", "--fuzzy"], ["--word", "--fuzzy"]]) {
      await assert.rejects(() => runSearchCli(["x", ...pair]), (e: unknown) => e instanceof UsageError && /mutually exclusive/.test((e as Error).message), pair.join(" "))
      await assert.rejects(() => searchTranscripts([fileOf(FILE_M1, SID_M1)], "x", { [pair[0].slice(2)]: true, [pair[1].slice(2)]: true } as SearchOptions), (e: unknown) => e instanceof UsageError, `engine: ${pair.join(" ")}`)
    }
    const help = await runCli(["--help"])
    for (const flag of ["--mask", "--word", "--fuzzy", "--case", "--context", "--show", "--max-chars", "NOT covered"]) assert.ok(help.out.includes(flag), flag)
  })

  test("the CLI flags --mask, --word, --fuzzy and --case reach the engine", async function () {
    this.timeout(60_000)
    const cli = async (...flags: string[]): Promise<number[]> =>
      (JSON.parse((await runCli(["--project", PROJECT_M, "--session", "11111111", "--json", "--order", "old", ...flags])).out) as { hits: SearchHit[] }).hits.map(h => h.line as number)
    assert.deepStrictEqual(await cli("p?rt", "--mask"), [1, 2, 3])
    assert.deepStrictEqual(await cli("port", "--word"), [2])
    assert.deepStrictEqual(await cli("Hello", "--case"), [8])
    assert.deepStrictEqual((await cli("apple mango", "--fuzzy")).sort(numeric), [19, 22])
  })
})

// ── --show and --context fixtures ────────────────────────────────────────────────────────────────

const PROJECT_S = "/fake/show"
const SID_S = "33333333-aaaa-bbbb-cccc-dddddddddddd"
const FILE_S = path.join(CFG, "projects", projectSlugOf(PROJECT_S), `${SID_S}.jsonl`)
const LONG_TEXT = `${"L".repeat(6000)} END-OF-LONG`
fs.mkdirSync(path.dirname(FILE_S), { recursive: true })
// A blank line between entries 2 and 3: the reader does not count it, so the third entry is line 3, and --show must number like the hits do.
fs.writeFileSync(FILE_S, [
  promptAt(1, LONG_TEXT), { type: "progress", timestamp: "2026-08-20T10:02:00.000Z", data: { marker: "PROGRESS-MARKER" } }, "", promptAt(3, "SHOWME third entry"),
].map(l => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n")

const PROJECT_C = "/fake/ctx"
const SID_C1 = "44444444-aaaa-bbbb-cccc-dddddddddddd"
const SID_C2 = "55555555-aaaa-bbbb-cccc-dddddddddddd"
const FILE_C1 = path.join(CFG, "projects", projectSlugOf(PROJECT_C), `${SID_C1}.jsonl`)
const FILE_C2 = path.join(CFG, "projects", projectSlugOf(PROJECT_C), `${SID_C2}.jsonl`)
writeJsonl(FILE_C1, [
  promptAt(1, "c1 line one"), promptAt(2, "c1 line two CTXHIT"), promptAt(3, "c1 line three CTXHIT"),
  { type: "progress", timestamp: "2026-08-20T10:04:00.000Z", data: { n: 4 } }, promptAt(5, "c1 line five CTXHIT"),
])
writeJsonl(FILE_C2, [promptAt(1, "c2 first CTXHIT"), promptAt(2, "c2 second")])

suite("searchCli — --show and --context (TRDD-O3U0K4HY)", () => {
  suiteSetup(pointAtFixture)
  suiteTeardown(restoreConfig)

  test("--show prints every element of the named entry: its kind, its tool and its full text", async function () {
    this.timeout(60_000)
    const r = await runCli(["--show", "eeeeeeee:2", "--project", PROJECT_E])
    assert.strictEqual(r.code, 0)
    const head = r.out.split("\n")[0]
    assert.match(head, /^eeeeeeee\t#2\t2026-08-18T10:00:01\.000Z\t\[assistant\]$/)
    const block = (label: string, text: string): string => `--- [${label}] ${text.length} chars\n${text}\n`
    assert.strictEqual(r.out, `${head}\n${block("response", "resp NEEDLE-r")}${block("thinking", "think NEEDLE-t")}${block("tool-call Bash", bashStatus.text)}${block("diff Edit", editA.text)}`)
    const output = await runCli(["--show", "eeeeeeee:3", "--project", PROJECT_E])
    assert.ok(output.out.includes("--- [tool-output Bash] 24 chars\non branch NEEDLE-o\nline2\n"), `the tool of an output comes from its call: ${output.out}`)
    const json = JSON.parse((await runCli(["--show", "eeeeeeee:2", "--project", PROJECT_E, "--json"])).out) as { line: number; session: string; elements: Array<{ kind: string }>; truncated: boolean }
    assert.deepStrictEqual([json.line, json.session, json.elements.map(e => e.kind), json.truncated], [2, SID_E, ["response", "thinking", "tool-call", "diff"], false])
  })

  test("--show --agent reads the sub-agent transcript, without it the main transcript", async function () {
    this.timeout(60_000)
    const sub = await runCli(["--show", "eeeeeeee:2", "--agent", "ffff", "--project", PROJECT_E])
    assert.strictEqual(sub.code, 0)
    assert.match(sub.out.split("\n")[0], /^eeeeeeee:ffff4444\t#2\t/)
    assert.ok(sub.out.includes("sub reply NEEDLE-sr") && !sub.out.includes("resp NEEDLE-r"), sub.out)
  })

  test("--show refuses an unknown session or line with exit 2, and a malformed request with a usage error", async function () {
    this.timeout(60_000)
    for (const argv of [
      ["--show", "zzzzzzzz:1"], ["--show", "eeeeeeee:999"], ["--show", "eeeeeeee:2", "--agent", "nope"], ["--show", "eeeeeeee:1", "--agent", "ffff", "--project", "/fake/nowhere"],
    ]) {
      const r = await runCli([...argv, ...(argv.includes("--project") ? [] : ["--project", PROJECT_E])])
      assert.strictEqual(r.code, 2, argv.join(" "))
      assert.strictEqual(r.out, "", "nothing on stdout")
    }
    assert.ok((await runCli(["--show", "eeeeeeee:999", "--project", PROJECT_E])).err.includes("has 43 line(s)"), "the error says how many lines there are")
    for (const bad of [
      ["--show", "eeeeeeee"], ["--show", "eeeeeeee:0"], ["--show", "eeeeeeee:x"], ["--show", "eeeeeeee:2", "NEEDLE"], ["--show", "eeeeeeee:2", "--count"],
      ["--show", "eeeeeeee:2", "--limit", "3"], ["--show", "eeeeeeee:2", "--max-chars", "100001"], ["--show"], ["NEEDLE", "--max-chars", "5"],
    ]) {
      await assert.rejects(() => runSearchCli(bad), (e: unknown) => e instanceof UsageError, bad.join(" "))
    }
  })

  test("--show cuts the text at --max-chars (default 4000), says so, and --max-chars 7000 shows it whole", async function () {
    this.timeout(60_000)
    const cut = await runCli(["--show", `${SID_S.slice(0, 8)}:1`, "--project", PROJECT_S])
    assert.strictEqual(cut.code, 0)
    assert.ok(cut.out.includes(`--- [prompt] ${LONG_TEXT.length} chars\n${"L".repeat(4000)}\n--- cut at 4000 chars`), "4000 characters of text, the full size in the header, the cut reported")
    assert.ok(!cut.out.includes("END-OF-LONG"))
    const whole = await runCli(["--show", `${SID_S.slice(0, 8)}:1`, "--project", PROJECT_S, "--max-chars", "7000"])
    assert.ok(whole.out.includes("END-OF-LONG") && !whole.out.includes("--- cut"), "whole")
    const small = JSON.parse((await runCli(["--show", `${SID_S.slice(0, 8)}:1`, "--project", PROJECT_S, "--max-chars", "100", "--json"])).out) as { truncated: boolean; elements: Array<{ chars: number; text: string }> }
    assert.deepStrictEqual([small.truncated, small.elements[0].chars, small.elements[0].text.length], [true, LONG_TEXT.length, 100])
  })

  test("--show numbers the entries like a hit does (a blank line is not counted) and prints an entry with no text as its JSON line", async function () {
    this.timeout(60_000)
    const hit = JSON.parse((await runCli(["SHOWME", "--project", PROJECT_S, "--json"])).out) as { hits: SearchHit[] }
    assert.strictEqual(hit.hits[0].line, 3, "the blank line is skipped by the reader")
    const shown = await runCli(["--show", `${SID_S.slice(0, 8)}:${hit.hits[0].line}`, "--project", PROJECT_S])
    assert.ok(shown.out.includes("SHOWME third entry"), shown.out)
    const progress = await runCli(["--show", `${SID_S.slice(0, 8)}:2`, "--project", PROJECT_S])
    assert.ok(progress.out.includes("--- [progress]") && progress.out.includes("PROGRESS-MARKER"), progress.out)
  })

  test("--context 1 prints the neighbour entries of the same transcript, never another one, and leaves out entries that are hits themselves", async function () {
    this.timeout(120_000)
    const ctx = (hits: SearchHit[], session: string, line: number): Array<[number, string, string]> =>
      (hits.find(h => h.session === session && h.line === line)?.context ?? []).map(c => [c.line, c.kind, c.text])
    for (const files of [[fileOf(FILE_C1, SID_C1)], discoverTranscripts(PROJECT_C, {})]) {
      for (const extra of [{}, { kinds: ["prompt"] }]) {
        const r = await searchTranscripts(files, "CTXHIT", { context: 1, limit: 500, ...extra })
        const label = `${files.length} file(s) ${JSON.stringify(extra)}`
        assert.deepStrictEqual(ctx(r.hits, SID_C1, 2), [[1, "prompt", "c1 line one"]], `line 3 is a hit and not repeated as context (${label})`)
        assert.deepStrictEqual(ctx(r.hits, SID_C1, 3), [[4, "progress", ""]], `line 2 is a hit; an entry without text still counts (${label})`)
        assert.deepStrictEqual(ctx(r.hits, SID_C1, 5), [[4, "progress", ""]], `the last entry has nothing after it (${label})`)
        if (files.length === 2) {
          assert.deepStrictEqual(ctx(r.hits, SID_C2, 1), [[2, "prompt", "c2 second"]], `the first entry has nothing before it: the end of the other transcript is not context (${label})`)
        }
      }
    }
    const wide = await searchTranscripts(discoverTranscripts(PROJECT_C, {}), "CTXHIT", { context: 5, limit: 500 })
    assert.deepStrictEqual(ctx(wide.hits, SID_C1, 5), [[1, "prompt", "c1 line one"], [4, "progress", ""]], "a window of 5 still stays inside the transcript")
    assert.deepStrictEqual(ctx(wide.hits, SID_C2, 1), [[2, "prompt", "c2 second"]])
    assert.ok(wide.hits.every(h => (h.context ?? []).every(c => !c.text.startsWith(h.session === SID_C1 ? "c2" : "c1"))), "no entry of another transcript")
    assert.strictEqual((await searchTranscripts(discoverTranscripts(PROJECT_C, {}), "CTXHIT", { limit: 500 })).hits.some(h => h.context !== undefined), false, "no context without the option")
  })

  test("--context in the CLI: [context ...] rows around each hit, a -- line between hits, a context list in --json, limits refused", async function () {
    this.timeout(60_000)
    const text = await runCli(["CTXHIT", "--project", PROJECT_C, "--session", "44444444", "--context", "1", "--order", "old"])
    assert.strictEqual(text.code, 0)
    const rows = text.out.trimEnd().split("\n").map(l => l.split("\t"))
    assert.deepStrictEqual(rows.map(r => (r.length === 1 ? r[0] : `${r[1]} ${r[3].startsWith("[context") ? "ctx" : "hit"}`)), [
      "#1 ctx", "#2 hit", "--", "#3 hit", "#4 ctx", "--", "#4 ctx", "#5 hit",
    ])
    assert.strictEqual(rows[0][3], "[context prompt]")
    assert.strictEqual(rows[0][4], "c1 line one")
    const json = JSON.parse((await runCli(["CTXHIT", "--project", PROJECT_C, "--context", "1", "--json"])).out) as { hits: SearchHit[] }
    assert.ok(json.hits.every(h => Array.isArray(h.context)))
    for (const bad of [["x", "--context", "6"], ["x", "--context", "0"], ["x", "--context", "2", "--count"], ["x", "--context", "2", "--files"], ["x", "--context", "many"]]) {
      await assert.rejects(() => runSearchCli(bad), (e: unknown) => e instanceof UsageError, bad.join(" "))
    }
  })

  test("a search with --worktrees returns the hit inside the worktree transcript with its true line", async function () {
    this.timeout(60_000)
    const r = await run("NEEDLE", {}, { worktrees: true })
    assert.deepStrictEqual(spot(r.hits.filter(h => h.session === SID_W)), want(FILE_W, "NEEDLE", "dddddddd"), "wt NEEDLE is line 1 of the worktree transcript")
    assert.strictEqual(spot((await run("NEEDLE")).hits).some(s => s.startsWith("dddddddd")), false, "without --worktrees it is not searched")
  })

  test("a search with --agent returns only the sub-agent hit", async function () {
    this.timeout(60_000)
    const r = JSON.parse((await runCli(["NEEDLE", "--project", PROJECT, "--agent", "cccc", "--json"])).out) as { total: number; hits: SearchHit[] }
    assert.deepStrictEqual(spot(r.hits), want(FILE_SUB, "NEEDLE", "aaaaaaaa:cccc3333"))
    assert.strictEqual(r.total, 1)
  })

  test("the search connection has DuckDB spilling switched off: temp_directory reads back empty, so no .tmp folder can appear in the working directory", async function () {
    this.timeout(60_000)
    const { inst, con } = await openDuck()
    try {
      // Read back, not run: DuckDB creates its .tmp folder only when a query spills, and a fixture of a few kilobytes never does, so a run from an empty
      // directory passed with the setting removed (TRDD-WC4VBIMX, mutation run). Without the SET the default reads back as ".tmp".
      const rows = (await con.runAndReadAll("SELECT current_setting('temp_directory') AS t")).getRowObjects()
      assert.deepStrictEqual(rows, [{ t: "" }])
    } finally {
      con.closeSync()
      inst.closeSync()
    }
  })
})
