import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { installHooks, HOOK_CMD } from '../cli/hookInstall'

// A temp HOME with an `agentlenspro` PATH shim so installHooks' pre-install bin probe passes. The
// shim only needs to exist + be executable (resolveOnPath checks X_OK + isFile); it is never run.
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-toctou-'))
  const binDir = path.join(home, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  const shim = path.join(binDir, 'agentlenspro')
  fs.writeFileSync(shim, '#!/bin/sh\nexit 0\n')
  fs.chmodSync(shim, 0o755)
  const settingsPath = path.join(home, '.claude', 'settings.json')
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  return {
    settingsPath,
    pathEnv: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  }
}

type Matcher = { matcher?: string; hooks?: Array<{ type?: string; command?: string }> }
type Settings = { hooks?: Record<string, Matcher[]> }

const readSettings = (p: string): Settings => JSON.parse(fs.readFileSync(p, 'utf8')) as Settings
const countCmd = (s: Settings, ev: string, cmd: string): number =>
  (s.hooks?.[ev] ?? []).flatMap(m => m.hooks ?? []).filter(h => h.command === cmd).length

suite('installHooks preserves foreign hooks + is idempotent (S3-F5 TOCTOU)', () => {
  test('installing onto an event that already holds a foreign hook keeps BOTH', async () => {
    const fx = fixture()
    try {
      const foreign = 'some-other-tool --watch'
      fs.writeFileSync(fx.settingsPath, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: foreign }] }] } }, null, 2))
      await installHooks(false, { settingsPath: fx.settingsPath, pathEnv: fx.pathEnv, log: () => { /* quiet */ } })
      const s = readSettings(fx.settingsPath)
      // append_unique adds ours WITHOUT rebuilding the array from a stale snapshot, so the foreign
      // hook survives (a whole-array `set` from the pre-read value would have clobbered it under a race).
      assert.strictEqual(countCmd(s, 'Stop', foreign), 1, 'foreign hook preserved')
      assert.strictEqual(countCmd(s, 'Stop', HOOK_CMD), 1, 'our hook added')
    } finally { fx.cleanup() }
  })

  test('a second install does not duplicate our hook (append_unique idempotency)', async () => {
    const fx = fixture()
    try {
      fs.writeFileSync(fx.settingsPath, JSON.stringify({ hooks: {} }, null, 2))
      await installHooks(false, { settingsPath: fx.settingsPath, pathEnv: fx.pathEnv, log: () => { /* quiet */ } })
      await installHooks(false, { settingsPath: fx.settingsPath, pathEnv: fx.pathEnv, log: () => { /* quiet */ } })
      const s = readSettings(fx.settingsPath)
      assert.strictEqual(countCmd(s, 'Stop', HOOK_CMD), 1, 'our hook present exactly once after two installs')
    } finally { fx.cleanup() }
  })
})
