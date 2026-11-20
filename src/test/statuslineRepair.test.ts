// TRDD-YL3EWT6N item 8b: the launch check and `agentlenspro setup` refresh a stale status line stamp of ours (the repairOnly install of item 8a), keep a
// newer one, and never create, wrap or touch anything else. Real files in a temp HOME; AGENTLENS_DATA_DIR points at the temp data dir.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { detectDrift } from '../cli/autoSetup'
import { STATUSLINE_CMD, SUBAGENT_STATUSLINE_CMD, announceKeptSurfaces, statuslineCommand } from '../cli/hookInstall'
import { Ctx, REPAIR_STEPS, resolveCtx } from '../cli/setup'
import { packageVersion } from '../packageVersion'

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const RUN = packageVersion()
const NEWER = `${Number(RUN.split('.')[0]) + 1}.0.0`
const quiet = (): void => { /* quiet */ }
const UNPARSEABLE = "agentlenspro statusline --inner 'unterminated"

interface Fx {
  home: string
  dataDir: string
  settingsPath: string
  ctx: Ctx
}

function makeFx(): Fx {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-statusline-repair-'))
  const binDir = path.join(home, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  fs.writeFileSync(path.join(binDir, 'agentlenspro'), '#!/bin/sh\nexit 0\n')
  fs.chmodSync(path.join(binDir, 'agentlenspro'), 0o755)
  const dataDir = path.join(home, '.agentlens')
  fs.mkdirSync(dataDir, { recursive: true })
  const settingsPath = path.join(home, '.claude', 'settings.json')
  const ctx = resolveCtx({
    home, dataDir, settingsPath, skillsDir: path.join(home, '.claude', 'skills'), agentsDir: path.join(home, '.claude', 'agents'),
    repoRoot: REPO_ROOT, pathEnv: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`, otlpPort: 4318, uiPort: 3000, mcpPort: 4316, log: quiet,
    telemetryProbe: { managedSettingsPaths: [path.join(home, 'managed', 'managed-settings.json')], processEnv: {} },
  })
  return { home, dataDir, settingsPath, ctx }
}

const writeSettings = (f: Fx, obj: unknown): void => {
  fs.mkdirSync(path.dirname(f.settingsPath), { recursive: true })
  fs.writeFileSync(f.settingsPath, JSON.stringify(obj, null, 2))
}
const readSettings = (f: Fx): Record<string, { command: string }> => JSON.parse(fs.readFileSync(f.settingsPath, 'utf8')) as Record<string, { command: string }>
const bytes = (f: Fx): string => fs.readFileSync(f.settingsPath, 'utf8')
const entry = (command: string): { type: string; command: string } => ({ type: 'command', command })
const slDrifts = (f: Fx) => detectDrift(f.ctx).drifts.filter(d => d.piece === 'status line')

suite('status line launch repair (TRDD-YL3EWT6N item 8b)', () => {
  let fx: Fx
  let savedDir: string | undefined
  setup(() => {
    fx = makeFx()
    savedDir = process.env.AGENTLENS_DATA_DIR
    process.env.AGENTLENS_DATA_DIR = fx.dataDir
  })
  teardown(() => {
    if (savedDir === undefined) delete process.env.AGENTLENS_DATA_DIR; else process.env.AGENTLENS_DATA_DIR = savedDir
    fs.rmSync(fx.home, { recursive: true, force: true })
  })

  test('unstamped entries of ours are exactly one status line drift', () => {
    writeSettings(fx, { statusLine: entry("agentlenspro statusline --inner 'x.sh'"), subagentStatusLine: entry('agentlenspro statusline --subagent') })
    const d = slDrifts(fx)
    assert.strictEqual(d.length, 1)
    assert.strictEqual(d[0].step, 'statusline')
    assert.ok(d[0].reason.includes('statusLine unstamped'), d[0].reason)
    assert.ok(d[0].reason.includes('subagentStatusLine unstamped'), d[0].reason)
  })

  test('current, foreign, absent and unparseable entries are no status line drift', () => {
    writeSettings(fx, { statusLine: entry(statuslineCommand(STATUSLINE_CMD, RUN, 'x.sh')), subagentStatusLine: entry(statuslineCommand(SUBAGENT_STATUSLINE_CMD, RUN, '')) })
    assert.deepStrictEqual(slDrifts(fx), [])
    writeSettings(fx, { statusLine: entry('/usr/bin/foo.sh') })
    assert.deepStrictEqual(slDrifts(fx), [])
    writeSettings(fx, { other: 1 })
    assert.deepStrictEqual(slDrifts(fx), [])
    writeSettings(fx, { statusLine: entry(UNPARSEABLE) })
    assert.deepStrictEqual(slDrifts(fx), [])
  })

  test('a newer stamp is kept and announced exactly once', () => {
    writeSettings(fx, { statusLine: entry(statuslineCommand(STATUSLINE_CMD, NEWER, '/x.sh')) })
    const det = detectDrift(fx.ctx)
    assert.deepStrictEqual(det.drifts.filter(d => d.piece === 'status line'), [])
    const k = det.kept.filter(e => e.kind === 'statusline')
    assert.strictEqual(k.length, 1)
    assert.strictEqual(k[0].name, 'statusLine')
    assert.strictEqual(k[0].installedStamp, NEWER)
    const first: string[] = []
    announceKeptSurfaces(fx.dataDir, k, l => { first.push(l) })
    assert.strictEqual(first.length, 1)
    assert.ok(first[0].includes(NEWER) && first[0].includes('statusLine'), first[0])
    const second: string[] = []
    announceKeptSurfaces(fx.dataDir, k, l => { second.push(l) })
    assert.deepStrictEqual(second, [])
  })

  test('the step refreshes a stale stamp and keeps the inner command byte-identical', async () => {
    writeSettings(fx, { statusLine: entry("agentlenspro statusline --inner '/opt/my dir/x.sh'") })
    const { result } = await REPAIR_STEPS.statusline.run(fx.ctx)
    assert.strictEqual(result.verify, 'PASS', result.detail)
    assert.strictEqual(result.action, 'refreshed')
    assert.strictEqual(readSettings(fx).statusLine.command, statuslineCommand(STATUSLINE_CMD, RUN, '/opt/my dir/x.sh'))
    assert.deepStrictEqual(slDrifts(fx), [])
  })

  test('the step writes nothing when no entry of ours exists', async () => {
    writeSettings(fx, { other: 1 })
    const before = bytes(fx)
    const { result } = await REPAIR_STEPS.statusline.run(fx.ctx)
    assert.strictEqual(bytes(fx), before)
    assert.strictEqual(result.verify, 'PASS', result.detail)
    assert.strictEqual(result.action, 'none')
    assert.ok(result.found.includes('no agentlenspro status line capture installed'), result.found)
  })

  test('the step in dry-run leaves a stale entry alone', async () => {
    writeSettings(fx, { statusLine: entry('agentlenspro statusline --subagent') })
    const before = bytes(fx)
    const { result } = await REPAIR_STEPS.statusline.run({ ...fx.ctx, dryRun: true })
    assert.strictEqual(bytes(fx), before)
    assert.strictEqual(result.verify, 'SKIP')
  })

  test('the step fails and writes nothing when the CLI is not on PATH', async () => {
    writeSettings(fx, { statusLine: entry('agentlenspro statusline --subagent') })
    const before = bytes(fx)
    const emptyDir = path.join(fx.home, 'empty')
    fs.mkdirSync(emptyDir)
    const { result } = await REPAIR_STEPS.statusline.run({ ...fx.ctx, pathEnv: emptyDir })
    assert.strictEqual(result.verify, 'FAIL')
    assert.ok((result.detail ?? '').includes('not on PATH'), result.detail)
    assert.strictEqual(bytes(fx), before)
  })

  test('an unparseable entry: the other key is still refreshed and the step passes with the fix-by-hand detail', async () => {
    writeSettings(fx, { statusLine: entry(UNPARSEABLE), subagentStatusLine: entry('agentlenspro statusline --subagent') })
    const { result } = await REPAIR_STEPS.statusline.run(fx.ctx)
    assert.strictEqual(result.verify, 'PASS', result.detail)
    assert.ok((result.detail ?? '').includes('statusLine') && (result.detail ?? '').includes('not parseable'), result.detail)
    const s = readSettings(fx)
    assert.strictEqual(s.subagentStatusLine.command, statuslineCommand(SUBAGENT_STATUSLINE_CMD, RUN, ''))
    assert.strictEqual(s.statusLine.command, UNPARSEABLE)
  })

  test('an unparseable entry alone is a SKIP row and the file is not touched', async () => {
    writeSettings(fx, { statusLine: entry(UNPARSEABLE) })
    const before = bytes(fx)
    const { result } = await REPAIR_STEPS.statusline.run(fx.ctx)
    assert.strictEqual(result.verify, 'SKIP', result.detail)
    assert.strictEqual(result.action, 'none')
    assert.ok((result.detail ?? '').includes('not parseable'), result.detail)
    assert.strictEqual(bytes(fx), before)
  })

  test('a newer stamp is kept by the step and the file is not touched', async () => {
    writeSettings(fx, { statusLine: entry(statuslineCommand(STATUSLINE_CMD, NEWER, '/x.sh')) })
    const before = bytes(fx)
    const { result } = await REPAIR_STEPS.statusline.run(fx.ctx)
    assert.strictEqual(result.verify, 'PASS', result.detail)
    assert.strictEqual(result.action, 'none')
    assert.ok(result.found.includes('kept'), result.found)
    assert.strictEqual(bytes(fx), before)
  })

  test('current entries on both keys are a PASS with nothing to do', async () => {
    writeSettings(fx, { statusLine: entry(statuslineCommand(STATUSLINE_CMD, RUN, 'x.sh')), subagentStatusLine: entry(statuslineCommand(SUBAGENT_STATUSLINE_CMD, RUN, '')) })
    const { result } = await REPAIR_STEPS.statusline.run(fx.ctx)
    assert.strictEqual(result.verify, 'PASS', result.detail)
    assert.strictEqual(result.action, 'none')
    assert.strictEqual(result.found, 'no stale status line stamp')
  })
})
