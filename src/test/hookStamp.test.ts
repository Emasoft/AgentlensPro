// TRDD-YL3EWT6N item 5 part B: every hook registration carries a version stamp (`<base> --stamp <version>`), and an older CLI never
// edits a newer CLI's registrations. Real files in a scratch HOME under os.tmpdir(); the registered commands are run through a
// recording `agentlenspro` shim, the settings edits go through the real safeConfigEdit engine.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { detectDrift } from '../cli/autoSetup'
import {
  GATE_CMD, HOOK_CMD, INSTALLED_EVENTS, REVIEW_CMD, SUPERVISOR_CMD, announceKeptSurfaces, buildEventOps, hooksVerdict, installHooks,
  isOurHookCommand, isStaleGeneration, parseOurCommand, rebuildEventMatchers, stampedCommand, type HookMatcher,
} from '../cli/hookInstall'
import { REPAIR_STEPS, hookDriftList, hooksConverged, resolveCtx, verifyHooksState } from '../cli/setup'
import { packageVersion } from '../packageVersion'
import { safeConfigEdit } from '../safeConfigEdit'

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const quiet = (): void => { /* quiet */ }
const RUN = packageVersion()
// Derived from the running version, never literals: the running version moves with every release.
const NEWER = `${Number(RUN.split('.')[0]) + 1}.0.0`
const OLDER = '0.0.1'

type HooksMap = Record<string, HookMatcher[]>

/** The hooks object of a settings.json as the installer of `version` writes it (the real builders, no hand-typed commands). */
function hooksAt(version: string): HooksMap {
  const hooks: HooksMap = {}
  for (const ev of INSTALLED_EVENTS) hooks[ev] = rebuildEventMatchers([], ev, false, version).rebuilt
  return hooks
}

/** The same registrations as an installer from before the stamps wrote them. */
function unstamped(hooks: HooksMap): HooksMap {
  const out: HooksMap = {}
  for (const [ev, ms] of Object.entries(hooks)) {
    out[ev] = ms.map(m => ({ ...m, hooks: m.hooks.map(h => ({ ...h, command: h.command.replace(/ --stamp \S+$/, '') })) }))
  }
  return out
}

const ourCommands = (hooks: HooksMap, ev: string): string[] =>
  (hooks[ev] ?? []).flatMap(m => m.hooks).map(h => h.command).filter(c => isOurHookCommand(c))

interface Fx {
  home: string
  dataDir: string
  settingsPath: string
  pathEnv: string
  argvLog: string
  ctx: ReturnType<typeof resolveCtx>
  cleanup: () => void
}

function makeFx(): Fx {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-hookstamp-'))
  const binDir = path.join(home, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  const argvLog = path.join(home, 'argv.log')
  // The shim records the argument list it was started with, so a test can see WHICH registered string was exec'd.
  fs.writeFileSync(path.join(binDir, 'agentlenspro'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argvLog}'\nexit 0\n`)
  fs.chmodSync(path.join(binDir, 'agentlenspro'), 0o755)
  const dataDir = path.join(home, '.agentlens')
  fs.mkdirSync(dataDir, { recursive: true })
  const settingsPath = path.join(home, '.claude', 'settings.json')
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  const pathEnv = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`
  const managedPath = path.join(home, 'managed', 'managed-settings.json')
  const ctx = resolveCtx({
    home, dataDir, settingsPath, skillsDir: path.join(home, '.claude', 'skills'), agentsDir: path.join(home, '.claude', 'agents'),
    repoRoot: REPO_ROOT, pathEnv, otlpPort: 4318, uiPort: 3000, mcpPort: 4316, log: quiet,
    telemetryProbe: { managedSettingsPaths: [managedPath], processEnv: {} },
  })
  return { home, dataDir, settingsPath, pathEnv, argvLog, ctx, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) }
}

const writeHooks = (f: Fx, hooks: HooksMap): void => fs.writeFileSync(f.settingsPath, JSON.stringify({ hooks }, null, 2))
const readHooks = (f: Fx): HooksMap => (JSON.parse(fs.readFileSync(f.settingsPath, 'utf8')) as { hooks: HooksMap }).hooks

suite('hook stamp (item 5B) — one writer, one parser', () => {
  test('stampedCommand appends the stamp flag and version to the base', () => {
    assert.strictEqual(stampedCommand(HOOK_CMD, '2.40.0'), 'agentlenspro hook --stamp 2.40.0')
  })

  test('parseOurCommand: bare, stamped, prerelease, malformed stamp, extra word, foreign', () => {
    assert.deepStrictEqual(parseOurCommand(HOOK_CMD), { base: HOOK_CMD, stamp: null })
    assert.deepStrictEqual(parseOurCommand('agentlenspro gate --stamp 2.40.0'), { base: GATE_CMD, stamp: '2.40.0' })
    assert.deepStrictEqual(parseOurCommand('agentlenspro review-gate --stamp 2.40.0-rc.1'), { base: REVIEW_CMD, stamp: '2.40.0-rc.1' })
    assert.strictEqual(parseOurCommand('agentlenspro hook --stamp 2.40'), null, 'two-part version')
    assert.strictEqual(parseOurCommand('agentlenspro hook --stamp latest'), null, 'not a version')
    assert.strictEqual(parseOurCommand('agentlenspro hook --stamp 2.40.0 extra'), null, 'extra word')
    assert.strictEqual(parseOurCommand('agentlenspro hook --stamp'), null, 'flag without a version')
    assert.strictEqual(parseOurCommand('some-other-tool --watch'), null, 'foreign command')
    assert.strictEqual(parseOurCommand('agentlenspro-hook'), null, 'v1 bin is not a current generation')
    assert.strictEqual(parseOurCommand(42 as unknown as string), null, 'never throws on a non-string')
  })

  test('isStaleGeneration: false for a current stamped entry and the bare base, true for the legacy bins and a malformed stamp', () => {
    assert.strictEqual(isStaleGeneration(stampedCommand(HOOK_CMD, RUN)), false)
    assert.strictEqual(isStaleGeneration(SUPERVISOR_CMD), false)
    assert.strictEqual(isStaleGeneration('agentlenspro-hook'), true)
    assert.strictEqual(isStaleGeneration('agentlenspro-gate'), true)
    assert.strictEqual(isStaleGeneration('bash /x/spy-agentlens.sh'), true)
    assert.strictEqual(isStaleGeneration('agentlenspro hook --stamp 2.40'), true)
    assert.strictEqual(isStaleGeneration('some-other-tool --watch'), false, 'a foreign command is not ours, so not stale')
  })

  test('the builders stamp every command they register, the supervisor included', () => {
    for (const ev of INSTALLED_EVENTS) {
      for (const c of ourCommands(hooksAt(RUN), ev)) assert.strictEqual(parseOurCommand(c)?.stamp, RUN, `${ev}: ${c}`)
    }
  })
})

suite('hook stamp (item 5B) — unstamped and older registrations are replaced', () => {
  test('an unstamped entry and an older stamp are each replaced by exactly one stamped entry per event', () => {
    const fresh = hooksAt(RUN)
    for (const before of [unstamped(hooksAt(RUN)), hooksAt(OLDER)]) {
      for (const ev of INSTALLED_EVENTS) {
        const after = rebuildEventMatchers(before[ev], ev, false, RUN).rebuilt
        assert.deepStrictEqual(after, fresh[ev], `${ev}: rebuilt must equal a fresh install`)
        const bases = after.flatMap(m => m.hooks).map(h => parseOurCommand(h.command)?.base)
        assert.strictEqual(new Set(bases).size, bases.length, `${ev}: one entry per base`)
      }
    }
  })

  test('verifyHooksState fails on an older stamp and names it; passes for the running stamp', () => {
    assert.strictEqual(verifyHooksState({ hooks: hooksAt(RUN) }, RUN), null)
    const bad = verifyHooksState({ hooks: hooksAt(OLDER) }, RUN)
    assert.ok(bad !== null && bad.includes(OLDER), `must name the stamp found: ${bad}`)
    assert.strictEqual(hooksVerdict({ hooks: hooksAt(OLDER) }, RUN).kind, 'rewrite')
    assert.strictEqual(hooksVerdict({ hooks: hooksAt(RUN) }, RUN).kind, 'converged')
  })
})

suite('hook stamp (item 5B) — a newer stamp is never edited by an older CLI', () => {
  let f: Fx
  let savedHome: string | undefined
  // reviewModInstalled() reads os.homedir(), which follows $HOME: pin it to the fixture, or a review mod installed in the developer's real home
  // changes which entries exist and the exec'd-argv assertion below would depend on the machine (autoSetup.test.ts convergeHooks does the same).
  setup(() => { f = makeFx(); savedHome = process.env.HOME; process.env.HOME = f.home })
  teardown(() => {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome
    f.cleanup()
  })

  test('hookDriftList: empty for a newer stamp; names `stamp X -> Y` for an older one and `unstamped -> Y` for a bare one', () => {
    writeHooks(f, hooksAt(NEWER))
    assert.deepStrictEqual(hookDriftList(f.settingsPath), [])
    writeHooks(f, hooksAt(OLDER))
    assert.ok(hookDriftList(f.settingsPath).some(d => d.problem.startsWith(`stamp ${OLDER} -> ${RUN} (`)), JSON.stringify(hookDriftList(f.settingsPath)))
    writeHooks(f, unstamped(hooksAt(RUN)))
    assert.ok(hookDriftList(f.settingsPath).some(d => d.problem.startsWith(`unstamped -> ${RUN} (`)), JSON.stringify(hookDriftList(f.settingsPath)))
  })
  test('hooksVerdict keeps a newer stamp; hooksConverged is true and verifyHooksState is null', () => {
    const settings = { hooks: hooksAt(NEWER) }
    assert.deepStrictEqual(hooksVerdict(settings, RUN), { kind: 'keep-newer', newest: NEWER })
    assert.strictEqual(hooksConverged(settings), true)
    assert.strictEqual(verifyHooksState(settings, RUN), null)
  })

  test('installHooks with keepNewer writes nothing, reports the newer stamp and prints one notice per pair', async () => {
    writeHooks(f, hooksAt(NEWER))
    const before = fs.readFileSync(f.settingsPath, 'utf8')
    const lines: string[] = []
    const r1 = await installHooks(false, { settingsPath: f.settingsPath, pathEnv: f.pathEnv, log: l => { lines.push(l) }, keepNewer: true, dataDir: f.dataDir })
    assert.strictEqual(r1.changed, false)
    assert.strictEqual(r1.keptNewer, NEWER)
    assert.strictEqual(fs.readFileSync(f.settingsPath, 'utf8'), before, 'settings.json must be byte-identical')
    assert.strictEqual(lines.filter(l => l.includes(NEWER)).length, 1, `one notice: ${lines.join(' | ')}`)
    const again: string[] = []
    await installHooks(false, { settingsPath: f.settingsPath, pathEnv: f.pathEnv, log: l => { again.push(l) }, keepNewer: true, dataDir: f.dataDir })
    assert.strictEqual(again.filter(l => l.includes(NEWER)).length, 0, 'no second notice for the same pair')
  })

  test('a newer stamp beside a stale duplicate in one event: still no write', async () => {
    const hooks = hooksAt(NEWER)
    hooks.Stop = [...hooks.Stop, { hooks: [{ type: 'command', command: 'agentlenspro-hook', timeout: 5 }] }]
    writeHooks(f, hooks)
    const before = fs.readFileSync(f.settingsPath, 'utf8')
    assert.strictEqual(hooksVerdict({ hooks }, RUN).kind, 'keep-newer')
    const r = await installHooks(false, { settingsPath: f.settingsPath, pathEnv: f.pathEnv, log: quiet, keepNewer: true, dataDir: f.dataDir })
    assert.strictEqual(r.changed, false)
    assert.strictEqual(fs.readFileSync(f.settingsPath, 'utf8'), before)
  })

  test('launch path: detectDrift reports no hooks drift for a newer stamp and its kept list announces once', () => {
    writeHooks(f, hooksAt(NEWER))
    const det = detectDrift(f.ctx)
    assert.ok(!det.drifts.some(d => d.piece === 'hooks'), `no hooks drift: ${JSON.stringify(det.drifts)}`)
    const kept = det.kept.filter(k => k.kind === 'hooks')
    assert.strictEqual(kept.length, 1)
    assert.strictEqual(kept[0].installedStamp, NEWER)
    assert.strictEqual(kept[0].shippedStamp, RUN)
    const first: string[] = []
    announceKeptSurfaces(f.dataDir, det.kept, l => { first.push(l) })
    assert.strictEqual(first.filter(l => l.includes(NEWER)).length, 1, `one notice: ${first.join(' | ')}`)
    const second: string[] = []
    announceKeptSurfaces(f.dataDir, detectDrift(f.ctx).kept, l => { second.push(l) })
    assert.strictEqual(second.filter(l => l.includes(NEWER)).length, 0, 'none on a second run')
  })

  test('the explicit install (no keepNewer) rewrites over a newer stamp and logs one line naming the stamp it replaced', async () => {
    writeHooks(f, hooksAt(NEWER))
    const lines: string[] = []
    const r = await installHooks(false, { settingsPath: f.settingsPath, pathEnv: f.pathEnv, log: l => { lines.push(l) } })
    assert.strictEqual(r.changed, true)
    const hooks = readHooks(f)
    for (const ev of INSTALLED_EVENTS) {
      for (const c of ourCommands(hooks, ev)) assert.strictEqual(parseOurCommand(c)?.stamp, RUN, `${ev}: ${c}`)
    }
    assert.strictEqual(lines.filter(l => l.includes(NEWER)).length, 1, `one line naming the replaced stamp: ${lines.join(' | ')}`)
  })

  test('setup hooks step under a newer stamp exec-s the commands as REGISTERED (the newer stamp), not as the running version', async () => {
    writeHooks(f, hooksAt(NEWER))
    const before = fs.readFileSync(f.settingsPath, 'utf8')
    const { result } = await REPAIR_STEPS.hooks.run(f.ctx)
    assert.strictEqual(result.verify, 'PASS', result.detail)
    assert.strictEqual(fs.readFileSync(f.settingsPath, 'utf8'), before, 'the step must not rewrite a newer stamp')
    const argv = fs.readFileSync(f.argvLog, 'utf8')
    assert.ok(argv.includes(`hook --stamp ${NEWER}`), `the registered hook command was exec'd: ${argv}`)
    assert.ok(argv.includes(`gate --stamp ${NEWER}`), `the registered gate command was exec'd: ${argv}`)
    assert.ok(!argv.includes(`--stamp ${RUN}`), `no exec with the running stamp: ${argv}`)
  })
})

suite('hook stamp (item 5B) — the strip needle still removes a stamped entry', () => {
  test('buildEventOps strips stamped entries by the base needle through the real safeConfigEdit engine, foreign hooks survive', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-hookstamp-strip-'))
    try {
      const FOREIGN = 'some-other-tool --watch'
      const file = path.join(dir, 'settings.json')
      const stop: HookMatcher[] = [
        ...hooksAt(NEWER).Stop,
        { hooks: [{ type: 'command', command: FOREIGN }] },
      ]
      fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: stop } }, null, 2))
      const ops = buildEventOps('Stop', stop, true, RUN)
      assert.ok(ops.some(o => o.op === 'remove_by_substring'), 'the strip is a filter')
      await safeConfigEdit(file, 'json', ops)
      const left = (JSON.parse(fs.readFileSync(file, 'utf8')) as { hooks: HooksMap }).hooks.Stop.flatMap(m => m.hooks).map(h => h.command)
      assert.deepStrictEqual(left, [FOREIGN], 'every stamped entry of ours is gone, the foreign hook stays')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
  test('a foreign hook that shares ONE matcher with stamped entries of ours survives the strip (mixed matcher)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-hookstamp-mixed-'))
    try {
      const FOREIGN = 'some-other-tool --watch'
      const file = path.join(dir, 'settings.json')
      // One matcher holds both tools' entries: remove_by_substring must filter INSIDE the matcher (nested_key 'hooks'),
      // never drop the whole matcher because one of its entries is ours.
      const ours = hooksAt(NEWER).Stop.flatMap(m => m.hooks)
      assert.ok(ours.length > 0, 'the fixture holds at least one entry of ours')
      const stop: HookMatcher[] = [{ hooks: [...ours, { type: 'command', command: FOREIGN }] }]
      fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: stop } }, null, 2))
      await safeConfigEdit(file, 'json', buildEventOps('Stop', stop, true, RUN))
      const after = (JSON.parse(fs.readFileSync(file, 'utf8')) as { hooks: HooksMap }).hooks.Stop
      assert.deepStrictEqual(after.flatMap(m => m.hooks).map(h => h.command), [FOREIGN], 'only our entries leave the shared matcher')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
