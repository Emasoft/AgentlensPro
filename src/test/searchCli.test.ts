// src/test/searchCli.test.ts — `agentlenspro search` (TRDD-P31SWA8I, TRDD-UIQS9RXZ): the DuckDB
// transcript query engine, project-wide scope and the verb's usage contract. Real DuckDB against
// real fixture files — no mocks.

import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  searchTranscript, searchTranscripts, discoverTranscripts, parseTimeArg, runSearchCli, TranscriptFile,
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
const result = (id: string, content: unknown, extra: Record<string, unknown> = {}, isError = false): Record<string, unknown> =>
  ({ type: "user", timestamp: stamp(10), ...extra, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] } })
const sys = (subtype: string, extra: Record<string, unknown>): Record<string, unknown> => ({ type: "system", subtype, timestamp: stamp(20), ...extra })
const asLine = (obj: Record<string, unknown>): string => JSON.stringify(obj)
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
})
