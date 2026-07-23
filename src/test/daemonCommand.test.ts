import * as assert from 'assert'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import {
  hookSpoolDepth, daemonCommand, daemonInstall, daemonUninstall, DEFAULT_MAX_OLD_SPACE_MB,
} from '../cli/serverControl'

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

  test('hookSpoolDepth THROWS on an unreadable spool instead of reporting a healthy 0', () => {
    // "0 events awaiting drain" is what an operator reads as healthy. A permission denial that
    // answers 0 hides undelivered hooks piling up — only a genuinely ABSENT directory means zero.
    const dir = path.join(tmp, 'hook-spool')
    fs.mkdirSync(dir, { recursive: true })
    fs.chmodSync(dir, 0o000)
    try {
      // Running as root defeats the permission bit — skip rather than assert a false pass.
      let readable = true
      try { fs.readdirSync(dir) } catch { readable = false }
      if (!readable) assert.throws(() => hookSpoolDepth(), /cannot read the hook spool/)
    } finally {
      fs.chmodSync(dir, 0o755)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('daemonCommand rejects an unknown verb with a helpful message (no server contact)', async () => {
    await assert.rejects(() => daemonCommand(['bogus']), /daemon expects start\|stop\|restart\|status/)
  })
})

// ── D3K7QM2P/1d — launchd install/uninstall (no real system change: load:false + a tmp dir) ──────
suite('daemon launchd supervision (D3K7QM2P/1d)', () => {
  let tmp = ''
  suiteSetup(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'al-launchd-')) })
  suiteTeardown(() => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ } })

  test('install writes a fully-substituted plist (macOS) or prints a systemd recipe (linux); uninstall removes it', () => {
    if (process.platform !== 'darwin') {
      // Nothing is installed off macOS, so the command must FAIL rather than exit 0 — a script
      // that reads a success code would otherwise believe a daemon exists. The systemd recipe
      // travels in the error message.
      assert.throws(() => daemonInstall({ launchAgentsDir: tmp, load: false }), /macOS-only/)
      return
    }
    const r = daemonInstall({ launchAgentsDir: tmp, load: false })
    assert.strictEqual(r.installed, true)
    assert.ok(fs.existsSync(r.path), 'the plist was written')
    const plist = fs.readFileSync(r.path, 'utf-8')
    assert.ok(!/@[A-Z]+@/.test(plist), `every @PLACEHOLDER@ was substituted (found: ${plist.match(/@[A-Z]+@/g)})`)
    assert.ok(plist.includes('<string>daemon</string>') && plist.includes('<string>--supervise</string>'), 'runs the supervised daemon')
    assert.ok(plist.includes(process.execPath), 'points at this node binary')
    assert.ok(plist.includes('com.agentlens.collector'), 'carries the launchd label')

    const u = daemonUninstall({ launchAgentsDir: tmp })
    assert.strictEqual(u.removed, true, 'uninstall removes the plist')
    assert.ok(!fs.existsSync(r.path), 'the plist is gone')
    // Idempotent: a second uninstall is a no-op, not an error.
    assert.strictEqual(daemonUninstall({ launchAgentsDir: tmp }).removed, false)
  })

  test('the plist carries the shared heap cap, not a third hardcoded copy', function () {
    if (process.platform !== 'darwin') { this.skip(); return }
    // 6144 used to appear in the direct spawn, the supervisor and this template. Tuning one and
    // missing the others is a silent config drift that only shows up as an OOM under load.
    const r = daemonInstall({ launchAgentsDir: tmp, load: false })
    try {
      assert.ok(
        fs.readFileSync(r.path, 'utf-8').includes(`<string>${DEFAULT_MAX_OLD_SPACE_MB}</string>`),
        'the plist heap cap follows DEFAULT_MAX_OLD_SPACE_MB',
      )
    } finally { daemonUninstall({ launchAgentsDir: tmp }) }
  })

})
