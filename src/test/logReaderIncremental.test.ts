// TRDD-X2E6OSWK — the INCREMENTAL (fs.watch-driven) scan path of LogReader.
//
// The bug: every scan did a recursive readdir of every log root plus one statSync per file found
// (~12,508 files on the profiled machine), on a 5s timer AND on every watch burst — ~8.5% of the
// process's CPU, forever. The fix: fs.watch already names the changed file, so the steady-state scan
// touches only those paths; the full sweep stays as a slow correctness backstop.
//
// These tests pin BOTH halves: the targeted scan must be cheap (stat count == changed files) and it
// must not lose a single appended line (the reason a "cheap" scan is worth having at all).
//
// They exercise the CLAUDE + CODEX roots, which have env overrides (CLAUDE_CONFIG_DIR / CODEX_HOME)
// and can therefore be pointed at a temp dir. The full-sweep assertion goes through the private
// _scanClaude (the sibling logReader tests reach it the same way) rather than the public scan() with
// no args: an unqualified full scan would walk the DEVELOPER'S real ~/.copilot and VS Code
// workspaceStorage trees, which have no env override — slow, and it would pollute the stat counts
// these tests assert on.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { LogReader, type LogSessionResult } from '../logReader'

type ClaudeScanner = { _scanClaude(): LogSessionResult[] }
const scanClaude = (r: LogReader): LogSessionResult[] => (r as unknown as ClaudeScanner)._scanClaude()

const userText = (ts: string, cwd: string, text: string): string =>
  JSON.stringify({ type: 'user', timestamp: ts, cwd, message: { content: text } }) + '\n'

// One assistant turn. A distinct message.id is required or the usage record is deduped away.
const turn = (ts: string, cwd: string, msgId: string): string =>
  JSON.stringify({
    type: 'assistant', timestamp: ts, cwd,
    message: {
      id: msgId, model: 'claude-sonnet-4-5',
      usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: 'text', text: 'ok' }],
    },
  }) + '\n'

interface Fixture {
  root: string
  cwd: string
  claudeFile(id: string, turns: number): string
  codexFile(id: string): string
  cleanup(): void
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'al-incr-'))
  const projects = path.join(root, 'projects', 'proj')
  const codexHome = path.join(root, 'codexhome')
  const openCodeDir = path.join(root, 'opencode')
  fs.mkdirSync(projects, { recursive: true })
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true })
  fs.mkdirSync(openCodeDir, { recursive: true })

  const saved = {
    claude: process.env['CLAUDE_CONFIG_DIR'],
    codex: process.env['CODEX_HOME'],
    opencode: process.env['OPENCODE_DATA_DIR'],
  }
  process.env['CLAUDE_CONFIG_DIR'] = root
  process.env['CODEX_HOME'] = codexHome
  // Point OpenCode at an EMPTY dir: the targeted scan always re-checks the OpenCode DB (its writes
  // land on the -wal sibling, so a path filter would miss them). Without this it would read the
  // developer's real OpenCode store.
  process.env['OPENCODE_DATA_DIR'] = openCodeDir

  const cwd = path.join(root, 'workspace')
  return {
    root, cwd,
    claudeFile(id: string, turns: number): string {
      const file = path.join(projects, `${id}.jsonl`)
      let body = userText('2026-07-14T10:00:00.000Z', cwd, 'do the thing')
      for (let i = 0; i < turns; i++) body += turn(`2026-07-14T10:0${i}:01.000Z`, cwd, `${id}-msg${i}`)
      fs.writeFileSync(file, body)
      return file
    },
    codexFile(id: string): string {
      const file = path.join(codexHome, 'sessions', `${id}.jsonl`)
      fs.writeFileSync(file, '{"not":"a codex session"}\n')
      return file
    },
    cleanup(): void {
      const restore = (k: string, v: string | undefined): void => { if (v === undefined) delete process.env[k]; else process.env[k] = v }
      restore('CLAUDE_CONFIG_DIR', saved.claude)
      restore('CODEX_HOME', saved.codex)
      restore('OPENCODE_DATA_DIR', saved.opencode)
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

suite('LogReader — targeted scan (fs.watch-driven, TRDD-X2E6OSWK)', () => {
  test('stats ONLY the named file, not every log file on disk', () => {
    const fx = fixture()
    try {
      const a = fx.claudeFile('sess-a', 1)
      fx.claudeFile('sess-b', 1)   // a second log that must NOT be touched
      fx.claudeFile('sess-c', 1)   // …nor a third
      const r = new LogReader()

      const before = r.getLogScanStats().filesStatted
      const results = r.scan([a])
      const statted = r.getLogScanStats().filesStatted - before

      assert.strictEqual(statted, 1, 'a targeted scan must stat exactly the files it was given')
      assert.strictEqual(results.length, 1)
      assert.strictEqual(results[0].card.sessionId, 'sess-a')
    } finally { fx.cleanup() }
  })

  test('an unchanged file is re-stat-ed but NOT re-parsed (the change gate still applies)', () => {
    const fx = fixture()
    try {
      const a = fx.claudeFile('sess-a', 1)
      const r = new LogReader()
      assert.strictEqual(r.scan([a]).length, 1)

      const before = r.getLogScanStats()
      const again = r.scan([a])
      const after = r.getLogScanStats()

      assert.strictEqual(again.length, 0, 'an unchanged file yields no result')
      assert.strictEqual(after.filesStatted - before.filesStatted, 1, 'one stat: the gate')
      assert.strictEqual(after.fullReads, before.fullReads, 'and no re-read of its bytes')
      assert.strictEqual(after.incrementalReads, before.incrementalReads)
    } finally { fx.cleanup() }
  })

  test('an append is picked up in full — no line is missed, and the file is not re-read from byte 0', () => {
    const fx = fixture()
    try {
      const a = fx.claudeFile('sess-a', 1)
      const r = new LogReader()
      const first = r.scan([a])
      assert.strictEqual(first.length, 1)
      const callsBefore = first[0].card.totalLlmCalls
      const fullReadsAfterColdParse = r.getLogScanStats().fullReads

      // A live session appends a turn; the watcher names the file; the targeted scan tails it.
      fs.appendFileSync(a, turn('2026-07-14T10:05:00.000Z', fx.cwd, 'sess-a-msg-appended'))
      const second = r.scan([a])
      const stats = r.getLogScanStats()

      assert.strictEqual(second.length, 1, 'the grown file must come back as a changed session')
      assert.strictEqual(second[0].card.totalLlmCalls, callsBefore + 1, 'the appended turn must be in the card')
      assert.strictEqual(stats.fullReads, fullReadsAfterColdParse, 'the file must not be re-read from 0')
      assert.ok(stats.incrementalReads >= 1, 'the append must be read as an incremental tail')
    } finally { fx.cleanup() }
  })

  test('a brand-new file the watcher names is ingested by the targeted scan (no full sweep needed)', () => {
    const fx = fixture()
    try {
      const r = new LogReader()
      const fresh = fx.claudeFile('sess-new', 2)
      const results = r.scan([fresh])
      assert.strictEqual(results.length, 1)
      assert.strictEqual(results[0].card.sessionId, 'sess-new')
      assert.strictEqual(results[0].card.totalLlmCalls, 2)
    } finally { fx.cleanup() }
  })

  test('a path no agent owns is ignored — no stat, no result', () => {
    const fx = fixture()
    try {
      const r = new LogReader()
      const stray = path.join(fx.root, 'not-a-log.jsonl')          // inside the fixture, outside every root
      fs.writeFileSync(stray, 'noise\n')
      const lock = path.join(fx.root, 'projects', 'proj', 'sess.lock')  // inside a root, but not a log
      fs.writeFileSync(lock, 'noise\n')

      const before = r.getLogScanStats().filesStatted
      const results = r.scan([stray, lock])
      assert.strictEqual(results.length, 0)
      assert.strictEqual(r.getLogScanStats().filesStatted - before, 0, 'unclaimed paths cost nothing')
    } finally { fx.cleanup() }
  })

  test('a duplicate path in one watch burst is scanned once', () => {
    const fx = fixture()
    try {
      const a = fx.claudeFile('sess-a', 1)
      const r = new LogReader()
      const before = r.getLogScanStats().filesStatted
      const results = r.scan([a, a, a])
      assert.strictEqual(r.getLogScanStats().filesStatted - before, 1)
      assert.strictEqual(results.length, 1)
    } finally { fx.cleanup() }
  })

  test('a Codex log is routed to the codex parser by the path classifier', () => {
    const fx = fixture()
    try {
      const c = fx.codexFile('codex-1')
      const r = new LogReader()
      const before = r.getLogScanStats().filesStatted
      r.scan([c])   // the body is not a real Codex session, so no card — routing is what is asserted
      assert.strictEqual(r.getLogScanStats().filesStatted - before, 1, 'the codex root must be recognised')
    } finally { fx.cleanup() }
  })

  test('an empty hint set touches nothing at all', () => {
    const fx = fixture()
    try {
      fx.claudeFile('sess-a', 1)
      const r = new LogReader()
      const before = r.getLogScanStats().filesStatted
      assert.deepStrictEqual(r.scan([]), [])
      assert.strictEqual(r.getLogScanStats().filesStatted - before, 0)
    } finally { fx.cleanup() }
  })
})

suite('LogReader — the full sweep remains the correctness backstop', () => {
  test('the full sweep finds a file no watch event ever named', () => {
    const fx = fixture()
    try {
      const r = new LogReader()
      fx.claudeFile('sess-missed', 1)   // written while the watcher was, say, coalescing events away
      const ids = scanClaude(r).map(x => x.card.sessionId)
      assert.ok(ids.includes('sess-missed'), 'a dropped watch event must not lose the session')
    } finally { fx.cleanup() }
  })

  test('the full sweep and the targeted scan share ONE tail-offset gate (no double-parse)', () => {
    const fx = fixture()
    try {
      const a = fx.claudeFile('sess-a', 1)
      const r = new LogReader()

      // Targeted scan consumes the file…
      assert.strictEqual(r.scan([a]).length, 1)
      const fullReadsAfter = r.getLogScanStats().fullReads

      // …so the backstop sweep that follows must find NOTHING new in it, and must not re-read it.
      assert.strictEqual(scanClaude(r).length, 0, 'the backstop must not re-emit an already-consumed file')
      assert.strictEqual(r.getLogScanStats().fullReads, fullReadsAfter)
    } finally { fx.cleanup() }
  })
})
