// TRDD-OCNHOHE9 — collectFileMeta() is a full recursive readdir+stat of every session file.
// reparseSession() re-ran it from scratch on EVERY call; a 12-session probe loop (the cache-expiry
// newest-session heuristic) therefore paid 12 redundant full walks for one boolean answer. This
// asserts the walk happens ONCE for a multi-session reparse burst, not N times.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { LogReader } from '../logReader'

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

suite('LogReader — reparseSession() must not re-walk the whole log tree on every call', () => {
  let root = ''
  let savedClaudeDir: string | undefined

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'al-filemetacache-'))
    fs.mkdirSync(path.join(root, 'projects', 'proj'), { recursive: true })
    savedClaudeDir = process.env['CLAUDE_CONFIG_DIR']
    process.env['CLAUDE_CONFIG_DIR'] = root
  })

  teardown(() => {
    if (savedClaudeDir === undefined) delete process.env['CLAUDE_CONFIG_DIR']
    else process.env['CLAUDE_CONFIG_DIR'] = savedClaudeDir
    fs.rmSync(root, { recursive: true, force: true })
  })

  test('reparsing several sessions back-to-back triggers exactly ONE directory walk, not one per session', () => {
    const cwd = path.join(root, 'workspace')
    const ids = ['sess-a', 'sess-b', 'sess-c', 'sess-d']
    for (const id of ids) {
      fs.writeFileSync(path.join(root, 'projects', 'proj', `${id}.jsonl`), sessionBody(cwd, `prompt-${id}`))
    }

    const r = new LogReader()
    assert.strictEqual(r.getFileMetaWalkCount(), 0, 'no walk has happened yet')

    for (const id of ids) {
      const result = r.reparseSession(id)
      assert.ok(result, `reparseSession must resolve ${id} to its file`)
      assert.ok(result?.card.userRequest?.includes(`prompt-${id}`), `card content must match ${id}`)
    }

    // THE ASSERTION: 4 reparseSession() calls => 1 real walk (memoized), not 4.
    assert.strictEqual(r.getFileMetaWalkCount(), 1,
      `expected exactly 1 directory walk across ${ids.length} reparseSession() calls, got ${r.getFileMetaWalkCount()}`)
  })

  test('clearFileState() drops the walk cache so a forced rescan sees newly written files', () => {
    const cwd = path.join(root, 'workspace')
    fs.writeFileSync(path.join(root, 'projects', 'proj', 'sess-1.jsonl'), sessionBody(cwd, 'prompt-1'))

    const r = new LogReader()
    assert.ok(r.reparseSession('sess-1'), 'first session resolves')
    assert.strictEqual(r.getFileMetaWalkCount(), 1)

    fs.writeFileSync(path.join(root, 'projects', 'proj', 'sess-2.jsonl'), sessionBody(cwd, 'prompt-2'))
    // Without clearFileState this would still be served from the (still-fresh) TTL cache and miss
    // sess-2 — clearFileState is the explicit "force fresh" escape hatch used by the debug rescan.
    r.clearFileState()
    assert.ok(r.reparseSession('sess-2'), 'new session resolves after clearFileState()')
    assert.strictEqual(r.getFileMetaWalkCount(), 2, 'clearFileState() must force a second real walk')
  })
})
