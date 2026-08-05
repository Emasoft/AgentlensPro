import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { installHooks, buildEventOps, HOOK_CMD } from '../cli/hookInstall'
import { safeConfigEdit } from '../safeConfigEdit'

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

// ── TRDD-T0CT9U4X — the STRIP path had the same TOCTOU, and it deletes rather than adds ──────────
// The pure-add path above was fixed with append_unique; the strip path (migrating a previous
// generation, or removing dead spyglass entries) still computed the surviving array from the read
// taken BEFORE the lock and committed it as a whole-array `set`. A hook another tool appended to the
// same event in between was silently deleted — from the user's OWN settings.json, by a tool whose
// verified-transaction engine exists precisely because this project once destroyed one.
//
// These tests do NOT race the clock. They take the ops installHooks would send for a strip and apply
// them, through the REAL engine, to a tree that already contains the foreign entry those ops were
// NOT computed from. That IS the interleave, made deterministic.
suite('installHooks strip path preserves foreign hooks (TRDD-T0CT9U4X)', () => {
  const LEGACY = '/Users/tester/.claude/spy-agentlens.sh'
  const FOREIGN = 'some-other-tool --watch'

  test('the strip path emits NO whole-array set — the op list is filter-based', () => {
    const ops = buildEventOps('Stop', [{ hooks: [{ type: 'command', command: LEGACY }] }], false)
    assert.ok(ops.length > 0, 'a legacy entry must produce ops')
    assert.strictEqual(ops.filter(o => o.op === 'set').length, 0, 'a whole-array set reintroduces the TOCTOU')
    assert.ok(ops.some(o => o.op === 'remove_by_substring'), 'the strip must be expressed as a filter')
    assert.ok(ops.some(o => o.op === 'append_unique'), 'ours is re-added with the idempotent op')
  })

  test('a foreign hook appended AFTER the ops were computed survives the strip', async () => {
    const fx = fixture()
    try {
      // Ops computed from a tree that holds ONLY our legacy entry...
      const ops = buildEventOps('Stop', [{ hooks: [{ type: 'command', command: LEGACY }] }], false)
      // ...applied to the tree as it exists at COMMIT time, after a foreign tool appended its own.
      const target = path.join(path.dirname(fx.settingsPath), 'commit-time.json')
      fs.writeFileSync(target, JSON.stringify({
        hooks: { Stop: [
          { hooks: [{ type: 'command', command: LEGACY }] },
          { hooks: [{ type: 'command', command: FOREIGN }] },
        ] },
      }, null, 2))
      await safeConfigEdit(target, 'json', ops)
      const s = readSettings(target)
      assert.strictEqual(countCmd(s, 'Stop', FOREIGN), 1, 'the foreign hook must survive a strip it was invisible to')
      assert.strictEqual(countCmd(s, 'Stop', LEGACY), 0, 'our legacy entry is gone')
      assert.strictEqual(countCmd(s, 'Stop', HOOK_CMD), 1, 'ours is re-registered exactly once')
    } finally { fx.cleanup() }
  })

  test('uninstall leaves a foreign hook that arrived mid-flight, and takes the key only when empty', async () => {
    const fx = fixture()
    try {
      const ops = buildEventOps('Stop', [{ hooks: [{ type: 'command', command: HOOK_CMD }] }], true)
      assert.strictEqual(ops.filter(o => o.op === 'delete').length, 0, 'an unconditional delete clobbers a fresh foreign entry')

      const withForeign = path.join(path.dirname(fx.settingsPath), 'uninstall-foreign.json')
      fs.writeFileSync(withForeign, JSON.stringify({
        hooks: { Stop: [
          { hooks: [{ type: 'command', command: HOOK_CMD }] },
          { hooks: [{ type: 'command', command: FOREIGN }] },
        ] },
      }, null, 2))
      await safeConfigEdit(withForeign, 'json', ops)
      const kept = readSettings(withForeign)
      assert.strictEqual(countCmd(kept, 'Stop', FOREIGN), 1, 'the foreign hook survives our uninstall')
      assert.strictEqual(countCmd(kept, 'Stop', HOOK_CMD), 0, 'ours is gone')

      // Nothing foreign: the event key is pruned rather than left as an empty array — decided
      // INSIDE the lock, which is the whole difference from the `delete` this replaced.
      const alone = path.join(path.dirname(fx.settingsPath), 'uninstall-alone.json')
      fs.writeFileSync(alone, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: HOOK_CMD }] }] } }, null, 2))
      await safeConfigEdit(alone, 'json', ops)
      const empty = readSettings(alone)
      assert.strictEqual(empty.hooks?.Stop, undefined, 'an event left with nothing of ours is removed, not left as []')
    } finally { fx.cleanup() }
  })

  test('a command no literal needle can express falls back to the whole-array replace, never a silent no-op', () => {
    // `agentlenspro<TAB>hook` is ours (the generation matcher is a regex, and \s matches a tab), yet
    // it contains none of the fixed generation literals, and its own text cannot be a needle either:
    // the engine matches against json.dumps(element), where a tab is escaped to \t, so the raw
    // string would be found nowhere. Emitting a filter for it would report a strip that removed
    // nothing. The builder falls back to the pre-existing whole-array replace for that event ALONE —
    // narrower than before, and honest about it.
    const exotic = 'agentlenspro\thook'
    const ops = buildEventOps('Stop', [{ hooks: [{ type: 'command', command: exotic }] }], true)
    assert.ok(ops.some(o => o.op === 'set' || o.op === 'delete'), 'an inexpressible strip must still be performed')
  })
})
