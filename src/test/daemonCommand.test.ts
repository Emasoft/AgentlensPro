import * as assert from 'assert'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { hookSpoolDepth, daemonCommand } from '../cli/serverControl'

// ── D3K7QM2P/1b — daemon CLI helpers ─────────────────────────────────────────────────────────────
// hookSpoolDepth is what `daemon status` reports (undelivered hooks safe on disk); daemonCommand
// rejects an unknown verb. start/stop/restart delegate to the server lifecycle (covered by
// serverCommand + the 1a integration test) and are not exercised here — they would spawn a server.

suite('daemon command helpers (D3K7QM2P/1b)', () => {
  let tmp = ''
  let savedDataDir: string | undefined
  suiteSetup(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'al-daemon-'))
    savedDataDir = process.env.DATA_DIR
    process.env.DATA_DIR = tmp
  })
  suiteTeardown(() => {
    if (savedDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = savedDataDir
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
  })

  test('hookSpoolDepth is 0 when no spool dir exists', () => {
    assert.strictEqual(hookSpoolDepth(), 0)
  })

  test('hookSpoolDepth counts only .json spool files', () => {
    const dir = path.join(tmp, 'hook-spool')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '1-a.json'), '{}')
    fs.writeFileSync(path.join(dir, '2-b.json'), '{}')
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignore me') // not a spool file
    assert.strictEqual(hookSpoolDepth(), 2)
  })

  test('daemonCommand rejects an unknown verb with a helpful message (no server contact)', async () => {
    await assert.rejects(() => daemonCommand(['bogus']), /daemon expects start\|stop\|restart\|status/)
  })
})
