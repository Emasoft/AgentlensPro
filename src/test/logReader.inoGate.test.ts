// Review-sweep hardening — the unchanged-file short-circuit (mtime+size) in every LogReader gate
// must ALSO match the inode when one is recorded: a file REPLACED by rename can land on identical
// mtime+size (Claude Code prunes transcripts via replace-by-rename), and an early `return null`
// there would skip the new file FOREVER — the deeper ino check in _readNewLines never runs when
// the gate fires first.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { LogReader, type LogSessionResult } from '../logReader'

type ClaudeScanner = { _scanClaude(): LogSessionResult[] }
const scanClaude = (r: LogReader): LogSessionResult[] => (r as unknown as ClaudeScanner)._scanClaude()

// Same-shape session bodies whose ONLY difference is an equal-length prompt string, so the
// replacement lands on the exact same byte size — the precondition the gate mistake needs.
const sessionBody = (cwd: string, prompt: string): string =>
  JSON.stringify({ type: 'user', timestamp: '2026-07-14T10:00:00.000Z', cwd, message: { content: prompt } }) + '\n' +
  JSON.stringify({
    type: 'assistant', timestamp: '2026-07-14T10:00:01.000Z', cwd,
    message: {
      id: 'msg-1', model: 'claude-sonnet-4-5',
      usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: 'text', text: 'ok' }],
    },
  }) + '\n'

suite('LogReader — same-mtime+size replace-by-rename is re-parsed (inode gate)', () => {
  let root = ''
  let savedClaudeDir: string | undefined

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'al-inogate-'))
    fs.mkdirSync(path.join(root, 'projects', 'proj'), { recursive: true })
    savedClaudeDir = process.env['CLAUDE_CONFIG_DIR']
    process.env['CLAUDE_CONFIG_DIR'] = root
  })

  teardown(() => {
    if (savedClaudeDir === undefined) delete process.env['CLAUDE_CONFIG_DIR']
    else process.env['CLAUDE_CONFIG_DIR'] = savedClaudeDir
    fs.rmSync(root, { recursive: true, force: true })
  })

  test('a rename-replaced file with identical mtime+size (new inode) is re-parsed, not skipped forever', () => {
    const cwd = path.join(root, 'workspace')
    const file = path.join(root, 'projects', 'proj', 'sess-ino.jsonl')
    const before = sessionBody(cwd, 'prompt-AAAA')
    const after = sessionBody(cwd, 'prompt-BBBB')
    assert.strictEqual(Buffer.byteLength(after), Buffer.byteLength(before), 'fixture precondition: equal byte size')

    fs.writeFileSync(file, before)
    // Pin the mtime to a whole-second value FIRST: APFS stores sub-ms mtimes that a Date (ms
    // precision) can't reproduce, so pinning both sides is what makes mtimeMs comparable at all.
    const pinned = new Date('2026-07-14T10:05:00.000Z')
    fs.utimesSync(file, pinned, pinned)
    const st0 = fs.statSync(file)

    const r = new LogReader()
    const first = scanClaude(r)
    assert.strictEqual(first.length, 1, 'initial scan parses the session')
    assert.ok(first[0].card.userRequest?.includes('prompt-AAAA'), 'initial card carries the first prompt')

    // Replace by rename (new inode), then pin mtime back to the original — the exact disguise the
    // mtime+size gate cannot see through without the inode.
    const swap = path.join(root, 'projects', 'proj', '.sess-ino.jsonl.tmp')
    fs.writeFileSync(swap, after)
    fs.renameSync(swap, file)
    fs.utimesSync(file, pinned, pinned)
    const st1 = fs.statSync(file)
    assert.strictEqual(st1.size, st0.size, 'replaced file has the same size')
    assert.strictEqual(st1.mtimeMs, st0.mtimeMs, 'replaced file has the same mtime')
    assert.notStrictEqual(st1.ino, st0.ino, 'replaced file is a different inode')

    const second = scanClaude(r)
    assert.strictEqual(second.length, 1, 'the swapped file must be re-parsed (offset advanced from 0)')
    assert.ok(second[0].card.userRequest?.includes('prompt-BBBB'),
      `card must reflect the REPLACED content (got "${second[0].card.userRequest}")`)
  })

  test('negative control: unchanged file (same inode) still short-circuits to zero results', () => {
    const cwd = path.join(root, 'workspace')
    const file = path.join(root, 'projects', 'proj', 'sess-idle.jsonl')
    fs.writeFileSync(file, sessionBody(cwd, 'prompt-idle'))

    const r = new LogReader()
    assert.strictEqual(scanClaude(r).length, 1, 'initial scan parses the session')
    assert.strictEqual(scanClaude(r).length, 0, 'an untouched file is skipped by the gate')
  })
})
