// The install heals itself at every CLI launch (TRDD-AGZ0XZKW). Everything here is REAL files in a temp HOME:
// real skill/agent copies, real hook registrations through safeConfigEdit, real telemetry env, real kill-switch
// flag (AGENTLENS_DATA_DIR points at the temp data dir, so the developer's ~/.agentlens and ~/.claude are never
// touched). Only the REPAIR RUNNER is injected where a test needs to count or order invocations — it never
// replaces the detection under test.
import * as assert from 'assert'
import * as cp from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AUTOSETUP_EXCLUDED_VERBS, LOCK_STALE_MS, RepairOutcome, Step, autoSetupOnServerStart, claudeCodePresent, detectDrift, forceInstallTelemetry, maybeAutoSetup } from '../cli/autoSetup'
import { EXIT } from '../cli/cliErrors'
import { ensureServer } from '../cli/serverControl'
import { runEnableCli } from '../cli/disableCli'
import { FOREIGN_REASON, HOOK_PATH_VERBS, disabledNotice, killSwitchArmedForForeign } from '../cli/foreignTelemetry'
import { AGENT_NAMES, SKILL_NAMES, SUPERVISOR_CMD, installAgents, installHooks, installSkills, skillFiles } from '../cli/hookInstall'
import { agentlensDisabled, armKillSwitch, killSwitchPath, overrideKillSwitchEnv } from '../cli/killSwitch'
import { beginLaunchNotices, endLaunchNotices, pushNotice, takeNotices } from '../cli/launchNotices'
import { DISPATCHED_VERBS, cliMain } from '../cli/main'
import { Ctx, REPAIR_STEPS, hookDriftList, hooksConverged, resolveCtx, runSetup } from '../cli/setup'
import { freePort } from './helpers/freePort'
import { startMcpStub } from './helpers/mcpStub'
import { RULE_NAMES, disableAgentlensSurfaces, enableAgentlensSurfaces } from '../cli/surfaces'
import { TelemetryVerdictRow, ensureTelemetryConfig, telemetryVerdict } from '../telemetryConfig'

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const MANAGED_FOREIGN = 'https://otel.corp.example/v1'
const quiet = (): void => { /* quiet */ }

interface Fx {
  home: string
  dataDir: string
  settingsPath: string
  skillsDir: string
  agentsDir: string
  markerPath: string
  managedPath: string
  pathEnv: string
  ctx: Ctx
  cleanup: () => void
}

/** A temp HOME with an `agentlenspro` PATH shim (installHooks refuses without one), nothing installed yet. */
function makeFx(processEnv: NodeJS.ProcessEnv = {}): Fx {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-autosetup-'))
  const binDir = path.join(home, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  fs.writeFileSync(path.join(binDir, 'agentlenspro'), '#!/bin/sh\nexit 0\n')
  fs.chmodSync(path.join(binDir, 'agentlenspro'), 0o755)
  const dataDir = path.join(home, '.agentlens')
  fs.mkdirSync(dataDir, { recursive: true })
  const settingsPath = path.join(home, '.claude', 'settings.json')
  const managedPath = path.join(home, 'managed', 'managed-settings.json')
  const pathEnv = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`
  const ctx = resolveCtx({
    home, dataDir, settingsPath, skillsDir: path.join(home, '.claude', 'skills'), agentsDir: path.join(home, '.claude', 'agents'),
    repoRoot: REPO_ROOT, pathEnv, otlpPort: 4318, uiPort: 3000, mcpPort: 4316, log: quiet,
    // A developer's company config / OTEL_* exports must never leak into a fixture run.
    telemetryProbe: { managedSettingsPaths: [managedPath], processEnv },
  })
  return {
    home, dataDir, settingsPath, skillsDir: ctx.skillsDir, agentsDir: ctx.agentsDir, markerPath: path.join(dataDir, 'telemetry-managed.json'),
    managedPath, pathEnv, ctx, cleanup: () => { try { fs.chmodSync(managedPath, 0o644) } catch { /* absent */ } fs.rmSync(home, { recursive: true, force: true }) },
  }
}

/** Install EVERYTHING through the real installers, so the "all current" baseline is the real thing. */
async function installAll(f: Fx): Promise<void> {
  installSkills({ repoRoot: REPO_ROOT, skillsDir: f.skillsDir, log: quiet })
  installAgents({ repoRoot: REPO_ROOT, agentsDir: f.agentsDir, log: quiet })
  await installHooks(false, { settingsPath: f.settingsPath, pathEnv: f.pathEnv, log: quiet })
  await ensureTelemetryConfig({
    settingsPath: f.settingsPath, markerPath: f.markerPath, dataDir: f.dataDir, otlpPort: 4318,
    managedSettingsPaths: [f.managedPath], processEnv: {},
  })
}

type Settings = { env?: Record<string, string>; hooks?: unknown; [k: string]: unknown }

function readSettings(f: Fx): Settings {
  return JSON.parse(fs.readFileSync(f.settingsPath, 'utf8')) as Settings
}

function writeSettings(f: Fx, obj: unknown): void {
  fs.mkdirSync(path.dirname(f.settingsPath), { recursive: true })
  fs.writeFileSync(f.settingsPath, JSON.stringify(obj, null, 2))
}

/** Inject a repair runner that records every call (and runs the REAL step for the named ones). */
function recorder(realFor: Step[] = []): { calls: Step[]; repair: (s: Step, c: Ctx) => Promise<RepairOutcome> } {
  const calls: Step[] = []
  return {
    calls,
    repair: async (step, ctx) => {
      calls.push(step)
      if (realFor.includes(step)) {
        const { result } = await REPAIR_STEPS[step].run(ctx)
        return { ok: result.verify === 'PASS', detail: result.detail ?? result.found }
      }
      return { ok: true, detail: 'recorded' }
    },
  }
}

function lines(): { out: string[]; say: (l: string) => void } {
  const out: string[] = []
  return { out, say: l => { out.push(l) } }
}

/** Per-suite fixture + isolation: the kill-switch flag lives under AGENTLENS_DATA_DIR, so it is pointed at the temp
 *  data dir (and AGENTLENS_DISABLED cleared) for every test, then restored. */
function fixtureSuite(installFirst: boolean): { f: () => Fx } {
  let fx: Fx
  let savedDir: string | undefined
  let savedDisabled: string | undefined
  setup(async () => {
    fx = makeFx()
    if (installFirst) await installAll(fx)
    savedDir = process.env.AGENTLENS_DATA_DIR
    savedDisabled = process.env.AGENTLENS_DISABLED
    process.env.AGENTLENS_DATA_DIR = fx.dataDir
    delete process.env.AGENTLENS_DISABLED
  })
  teardown(() => {
    overrideKillSwitchEnv(false)
    if (savedDir === undefined) delete process.env.AGENTLENS_DATA_DIR; else process.env.AGENTLENS_DATA_DIR = savedDir
    if (savedDisabled === undefined) delete process.env.AGENTLENS_DISABLED; else process.env.AGENTLENS_DISABLED = savedDisabled
    fx.cleanup()
  })
  return { f: () => fx }
}

suite('autoSetup — every launch checks presence + drift and repairs only what failed', () => {
  const s = fixtureSuite(true)

  test('everything current: no repair, silent, verb runs (fast path)', async () => {
    const f = s.f(); const r = recorder(); const l = lines()
    assert.strictEqual(await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: r.repair, stderr: l.say }), null)
    assert.deepStrictEqual(r.calls, [])
    assert.deepStrictEqual(l.out, [])
  })

  test('fast-path cost with everything current: measured over 20 launches (budget < 50 ms each)', async () => {
    const f = s.f(); const r = recorder(); const l = lines()
    await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: r.repair, stderr: l.say }) // warm the fs cache
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < 20; i++) await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: r.repair, stderr: l.say })
    const perLaunchMs = Number(process.hrtime.bigint() - t0) / 1e6 / 20
    // eslint-disable-next-line no-console
    console.log(`      autoSetup fast path: ${perLaunchMs.toFixed(2)} ms per launch (20 runs, all current)`)
    assert.ok(perLaunchMs < 50, `fast path took ${perLaunchMs.toFixed(1)} ms per launch`)
    assert.deepStrictEqual(r.calls, [])
  })

  test('a missing skill dir restores ONLY the skill step', async () => {
    const f = s.f()
    fs.rmSync(path.join(f.skillsDir, SKILL_NAMES[1]), { recursive: true })
    const r = recorder(['skill']); const l = lines()
    assert.strictEqual(await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: r.repair, stderr: l.say }), null)
    assert.deepStrictEqual(r.calls, ['skill'])
    assert.ok(l.out.some(x => x.includes('restored skills') && x.includes(`${SKILL_NAMES[1]} missing`)), l.out.join('|'))
    assert.ok(fs.existsSync(path.join(f.skillsDir, SKILL_NAMES[1], 'SKILL.md')), 'the real step put it back')
  })

  test('a stale skill (content drift) is refreshed', async () => {
    const f = s.f()
    fs.appendFileSync(path.join(f.skillsDir, SKILL_NAMES[0], 'SKILL.md'), '\nlocal edit\n')
    const r = recorder(['skill']); const l = lines()
    await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: r.repair, stderr: l.say })
    assert.deepStrictEqual(r.calls, ['skill'])
    assert.ok(l.out.some(x => x.includes(`${SKILL_NAMES[0]} stale`)))
  })

  // installSkill deliberately leaves unshipped files in place, and the drift check used to hash EVERY file in the
  // installed dir: one extra file made installed ≠ shipped forever, so every launch re-ran the skill repair,
  // rewrote nothing, failed verify and printed "could not restore skills". Only shipped paths are compared now.
  test('an unshipped extra file in an installed skill is NOT drift: no repair, silent, and setup verifies PASS', async () => {
    const f = s.f()
    const extra = path.join(f.skillsDir, SKILL_NAMES[0], 'my-own-note.md')
    fs.writeFileSync(extra, 'user content\n')
    assert.deepStrictEqual(detectDrift(f.ctx).drifts, [], 'an extra file must not read as drift')
    const r = recorder(['skill']); const l = lines()
    assert.strictEqual(await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: r.repair, stderr: l.say }), null)
    assert.deepStrictEqual(r.calls, [])
    assert.deepStrictEqual(l.out, [])
    const { result } = await REPAIR_STEPS.skill.run(f.ctx)
    assert.strictEqual(result.verify, 'PASS', `setup's skill step must verify with an extra present: ${JSON.stringify(result)}`)
    assert.strictEqual(result.action, 'none')
    assert.ok(fs.existsSync(extra), 'the extra file is never deleted')
  })

  test('a CHANGED shipped payload file (not SKILL.md) is drift and is repaired', async () => {
    const f = s.f()
    const name = 'agentlenspro-scan-and-fix'
    const rel = skillFiles(path.join(REPO_ROOT, 'skills', name)).find(x => x !== 'SKILL.md')
    assert.ok(rel, 'the fixture skill must ship a payload file beyond SKILL.md')
    const victim = path.join(f.skillsDir, name, rel as string)
    fs.writeFileSync(victim, 'tampered\n')
    const r = recorder(['skill']); const l = lines()
    await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: r.repair, stderr: l.say })
    assert.deepStrictEqual(r.calls, ['skill'])
    assert.ok(l.out.some(x => x.includes(`${name} stale`)), l.out.join('|'))
    assert.ok(fs.readFileSync(victim).equals(fs.readFileSync(path.join(REPO_ROOT, 'skills', name, rel as string))), 'the real step restored the shipped bytes')
    assert.deepStrictEqual(detectDrift(f.ctx).drifts, [])
  })

  test('a DELETED shipped payload file (not SKILL.md) is drift and is repaired', async () => {
    const f = s.f()
    const name = 'agentlenspro-scan-and-fix'
    const rel = skillFiles(path.join(REPO_ROOT, 'skills', name)).find(x => x !== 'SKILL.md')
    assert.ok(rel, 'the fixture skill must ship a payload file beyond SKILL.md')
    const victim = path.join(f.skillsDir, name, rel as string)
    fs.rmSync(victim)
    const r = recorder(['skill']); const l = lines()
    await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: r.repair, stderr: l.say })
    assert.deepStrictEqual(r.calls, ['skill'])
    assert.ok(l.out.some(x => x.includes(`${name} stale`)), l.out.join('|'))
    assert.ok(fs.existsSync(victim), 'the real step put the shipped file back')
    assert.deepStrictEqual(detectDrift(f.ctx).drifts, [])
  })

  test('a missing agent restores ONLY the skill step (it owns skills + agents)', async () => {
    const f = s.f()
    fs.rmSync(path.join(f.agentsDir, `${AGENT_NAMES[0]}.md`))
    const r = recorder(['skill']); const l = lines()
    await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: r.repair, stderr: l.say })
    assert.deepStrictEqual(r.calls, ['skill'])
    assert.ok(l.out.some(x => x.includes('restored agents') && x.includes(`${AGENT_NAMES[0]} missing`)))
    assert.ok(fs.existsSync(path.join(f.agentsDir, `${AGENT_NAMES[0]}.md`)))
  })

  test('a stale agent (bytes differ) is detected', () => {
    const f = s.f()
    fs.appendFileSync(path.join(f.agentsDir, `${AGENT_NAMES[1]}.md`), 'x')
    assert.ok(detectDrift(f.ctx).drifts.some(x => x.piece === 'agents' && x.reason.includes(`${AGENT_NAMES[1]} stale`)))
  })

  test('hook registrations at the OLD 30 s timeout are detected and repaired alone', async () => {
    const f = s.f()
    const cfg = readSettings(f)
    const hooks = cfg.hooks as Record<string, Array<{ hooks: Array<{ timeout?: number }> }>>
    for (const ev of Object.keys(hooks)) for (const m of hooks[ev]) for (const h of m.hooks) if (h.timeout !== undefined) h.timeout = 30
    writeSettings(f, cfg)
    const r = recorder()
    await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: r.repair, stderr: lines().say })
    assert.deepStrictEqual(r.calls, ['hooks'])
  })

  // The two drift checks once iterated the HOOK/GATE/REVIEW events only, so a settings.json with NO
  // UserPromptSubmit key read as "converged" and the supervisor's registration was never restored —
  // not by a launch, not even by `setup` (whose verify then failed with nothing able to repair it).
  // Both checks now read hookInstall's INSTALLED_EVENTS, the installer's own list.
  test('the supervisor UserPromptSubmit registration removed entirely is detected and repaired', async () => {
    const f = s.f()
    const cfg = readSettings(f)
    const hooks = cfg.hooks as Record<string, unknown>
    assert.ok(JSON.stringify(hooks.UserPromptSubmit ?? null).includes(SUPERVISOR_CMD), 'baseline: the installer registered the supervisor on UserPromptSubmit')
    delete hooks.UserPromptSubmit
    writeSettings(f, cfg)
    assert.strictEqual(hooksConverged(readSettings(f)), false, 'the drift check must see the missing event')
    assert.ok(hookDriftList(f.settingsPath).some(d => d.event === 'UserPromptSubmit'), 'the --json drift list must name it')
    const r = recorder(['hooks'])
    await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: r.repair, stderr: lines().say })
    assert.deepStrictEqual(r.calls, ['hooks'])
    const after = readSettings(f).hooks as Record<string, unknown>
    assert.ok(JSON.stringify(after.UserPromptSubmit ?? null).includes(SUPERVISOR_CMD), 'the repair put the supervisor back on UserPromptSubmit')
    assert.strictEqual(hooksConverged(readSettings(f)), true)
  })
  test('a missing telemetry key AND a wrong local endpoint are restored; every OTHER key is preserved and a backup is made', async () => {
    const f = s.f()
    const cfg = readSettings(f)
    delete cfg.env!.OTEL_LOGS_EXPORT_INTERVAL
    cfg.env!.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:9999' // a port agentlenspro itself may have used: ours, not foreign
    cfg.env!.MY_OWN_KEY = 'keep-me'
    cfg.model = 'opus'
    writeSettings(f, cfg)
    const before = readSettings(f)
    const r = recorder(['otel-env']); const l = lines()
    assert.strictEqual(await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: r.repair, stderr: l.say }), null)
    assert.deepStrictEqual(r.calls, ['otel-env'])
    const after = readSettings(f)
    assert.strictEqual(after.env!.OTEL_LOGS_EXPORT_INTERVAL, '5000')
    assert.strictEqual(after.env!.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://localhost:4318')
    assert.strictEqual(after.env!.MY_OWN_KEY, 'keep-me')
    assert.strictEqual(after.model, 'opus')
    assert.deepStrictEqual(after.hooks, before.hooks, 'hooks byte-preserved')
    for (const k of Object.keys(before.env!).filter(k => k !== 'OTEL_LOGS_EXPORT_INTERVAL' && k !== 'OTEL_EXPORTER_OTLP_ENDPOINT')) {
      assert.strictEqual(after.env![k], before.env![k], `${k} untouched`)
    }
    const backups = fs.readdirSync(path.dirname(f.settingsPath)).filter(n => n.startsWith('settings.json.agentlens-bak-'))
    assert.ok(backups.length >= 1, 'the safeConfigEdit transaction must leave a backup')
    assert.ok(l.out.some(x => x.includes('restored telemetry env')), l.out.join('|'))
  })

  test('the raw body dumps key is restored when it goes missing', async () => {
    const f = s.f()
    const cfg = readSettings(f)
    delete cfg.env!.OTEL_LOG_RAW_API_BODIES
    writeSettings(f, cfg)
    await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: recorder(['otel-env']).repair, stderr: lines().say })
    assert.strictEqual(readSettings(f).env!.OTEL_LOG_RAW_API_BODIES, `file:${path.join(f.dataDir, 'otel-bodies')}`)
  })

  test('an unparseable settings.json: NO repair of hooks/telemetry, one line naming `agentlenspro setup`, file untouched', async () => {
    const f = s.f()
    fs.writeFileSync(f.settingsPath, '{ not json')
    const r = recorder(); const l = lines()
    assert.strictEqual(await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: r.repair, stderr: l.say }), null)
    assert.deepStrictEqual(r.calls, [])
    assert.strictEqual(l.out.length, 1)
    assert.ok(l.out[0].includes('agentlenspro setup'), l.out[0])
    assert.strictEqual(fs.readFileSync(f.settingsPath, 'utf8'), '{ not json')
  })

  test('ORDER: with everything broken the repairs run telemetry first, then hooks, then skills', async () => {
    const f = s.f()
    fs.rmSync(f.settingsPath)
    fs.rmSync(path.join(f.skillsDir, SKILL_NAMES[0]), { recursive: true })
    const r = recorder()
    await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: r.repair, stderr: lines().say })
    assert.deepStrictEqual(r.calls, ['otel-env', 'hooks', 'skill'])
  })

  test('every excluded verb (hook-path, server, daemon, setup, disable, enable, telemetry) never repairs and stays silent', async () => {
    const f = s.f()
    fs.rmSync(path.join(f.skillsDir, SKILL_NAMES[0]), { recursive: true })
    for (const verb of AUTOSETUP_EXCLUDED_VERBS) {
      const r = recorder(); const l = lines()
      assert.strictEqual(await maybeAutoSetup([verb], { ctx: f.ctx, repair: r.repair, stderr: l.say }), null, verb)
      assert.deepStrictEqual(r.calls, [], `${verb} must not trigger a repair`)
      assert.deepStrictEqual(l.out, [], `${verb} must stay silent`)
    }
    for (const v of ['hook', 'gate', 'review-gate', 'review-supervisor', 'delegate-gate', 'statusline']) {
      assert.ok(AUTOSETUP_EXCLUDED_VERBS.has(v) && HOOK_PATH_VERBS.has(v), `${v} is a hook-path verb`)
    }
  })

  test('AGENTLENS_NO_AUTOSETUP=1 never repairs', async () => {
    const f = s.f()
    fs.rmSync(path.join(f.skillsDir, SKILL_NAMES[0]), { recursive: true })
    const r = recorder()
    assert.strictEqual(await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: r.repair, stderr: lines().say, env: { AGENTLENS_NO_AUTOSETUP: '1' } }), null)
    assert.deepStrictEqual(r.calls, [])
  })

  test('a failing repair prints one line naming `agentlenspro setup`, never throws, and the verb still runs', async () => {
    const f = s.f()
    fs.rmSync(path.join(f.skillsDir, SKILL_NAMES[0]), { recursive: true })
    const l = lines()
    const result = await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: async () => ({ ok: false, detail: 'verify failed' }), stderr: l.say })
    assert.strictEqual(result, null)
    assert.ok(l.out.some(x => x.includes('could not restore skills') && x.includes('agentlenspro setup')), l.out.join('|'))
    assert.ok(!fs.existsSync(path.join(f.dataDir, '.autosetup.lock')), 'the lock is released after a failure')
  })

  test('a repair that THROWS is caught: one line, no throw out of maybeAutoSetup', async () => {
    const f = s.f()
    fs.rmSync(path.join(f.skillsDir, SKILL_NAMES[0]), { recursive: true })
    const l = lines()
    const result = await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: async () => { throw new Error('boom') }, stderr: l.say })
    assert.strictEqual(result, null)
    assert.ok(l.out.some(x => x.includes('boom') && x.includes('agentlenspro setup')))
  })

  test('a fresh lock held by another launch: this one skips; a STALE lock (>10 min) is taken over', async () => {
    const f = s.f()
    fs.rmSync(path.join(f.skillsDir, SKILL_NAMES[0]), { recursive: true })
    const lock = path.join(f.dataDir, '.autosetup.lock')
    fs.writeFileSync(lock, '')
    let r = recorder()
    await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: r.repair, stderr: lines().say })
    assert.deepStrictEqual(r.calls, [], 'the loser skips')
    const old = new Date(Date.now() - LOCK_STALE_MS - 60_000)
    fs.utimesSync(lock, old, old)
    r = recorder()
    await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: r.repair, stderr: lines().say })
    assert.deepStrictEqual(r.calls, ['skill'], 'a stale lock is broken, the repair runs')
  })

  test('nothing installed: one full setup (not the partial repairs) — but never for a bare launch (that IS the server)', async () => {
    const empty = makeFx()
    try {
      let full = 0
      const r = recorder()
      await maybeAutoSetup(['budget'], { ctx: empty.ctx, repair: r.repair, fullSetup: async () => { full++; return true }, stderr: lines().say })
      assert.strictEqual(full, 1)
      assert.deepStrictEqual(r.calls, [])
      await maybeAutoSetup([], { ctx: empty.ctx, repair: r.repair, fullSetup: async () => { full++; return true }, stderr: lines().say })
      assert.strictEqual(full, 1, 'a bare launch must not start a full setup')
      assert.deepStrictEqual(r.calls, ['otel-env', 'hooks', 'skill'])
    } finally { empty.cleanup() }
  })

  test('source guard: autoSetup.ts never writes settings.json itself (every mutation is safeConfigEdit, inside the setup steps)', () => {
    const src = fs.readFileSync(path.resolve(REPO_ROOT, 'src', 'cli', 'autoSetup.ts'), 'utf8')
    assert.ok(!/writeFile/.test(src), 'no writeFile anywhere in autoSetup.ts')
    assert.ok(!/JSON\.stringify/.test(src), 'no hand-serialised JSON either')
    for (const name of ['foreignTelemetry.ts', 'surfaces.ts']) {
      const other = fs.readFileSync(path.resolve(REPO_ROOT, 'src', 'cli', name), 'utf8')
      assert.ok(!/writeFile|JSON\.stringify/.test(other), `${name} must not write settings.json (or serialise JSON) itself`)
    }
  })

  test('source guard: every kill-switch arm/disarm goes through surfaces.ts, so the skills always follow the switch', () => {
    const cliDir = path.resolve(REPO_ROOT, 'src', 'cli')
    const srcDir = path.resolve(REPO_ROOT, 'src')
    const offenders: string[] = []
    for (const dir of [cliDir, srcDir]) {
      for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.ts'))) {
        if (name === 'killSwitch.ts' || name === 'surfaces.ts') continue
        const text = fs.readFileSync(path.join(dir, name), 'utf8')
        if (/\b(armKillSwitch|disarmKillSwitch)\(/.test(text)) offenders.push(name)
      }
    }
    assert.deepStrictEqual(offenders, [], 'armKillSwitch/disarmKillSwitch may only be called from surfaces.ts')
  })
})

suite('surfaces — disabling parks the skills (agents stay), enabling puts them back', () => {
  const s = fixtureSuite(true)

  test('disable arms the switch with the reason and moves ONLY the shipped skills; agents stay; the rule list is empty today', () => {
    const f = s.f()
    const dirs = { dataDir: f.dataDir, skillsDir: f.skillsDir, rulesDir: path.join(f.home, '.claude', 'rules') }
    fs.mkdirSync(path.join(f.skillsDir, 'someone-elses-skill'), { recursive: true })
    fs.writeFileSync(path.join(f.skillsDir, 'someone-elses-skill', 'SKILL.md'), 'not ours')
    const { flag, moved } = disableAgentlensSurfaces('SSD burning', dirs)
    assert.strictEqual(flag, killSwitchPath())
    assert.strictEqual(moved.length, SKILL_NAMES.length)
    assert.deepStrictEqual(RULE_NAMES, [], 'the package ships no rule today')
    for (const name of SKILL_NAMES) assert.ok(!fs.existsSync(path.join(f.skillsDir, name)))
    assert.ok(fs.existsSync(path.join(f.skillsDir, 'someone-elses-skill', 'SKILL.md')), 'a skill that is not ours is never touched')
    for (const name of AGENT_NAMES) assert.ok(fs.existsSync(path.join(f.agentsDir, `${name}.md`)), `agent ${name} stays`)
    assert.ok(agentlensDisabled())
  })

  test('enable disarms and restores the parked skills byte-identical; a second disable/enable cycle works too', () => {
    const f = s.f()
    const dirs = { dataDir: f.dataDir, skillsDir: f.skillsDir, rulesDir: path.join(f.home, '.claude', 'rules') }
    const original = fs.readFileSync(path.join(f.skillsDir, SKILL_NAMES[0], 'SKILL.md'), 'utf8')
    for (let cycle = 0; cycle < 2; cycle++) {
      disableAgentlensSurfaces('cycle', dirs)
      const { disarmed, restored } = enableAgentlensSurfaces(dirs)
      assert.ok(disarmed)
      assert.strictEqual(restored.length, SKILL_NAMES.length)
      assert.strictEqual(fs.readFileSync(path.join(f.skillsDir, SKILL_NAMES[0], 'SKILL.md'), 'utf8'), original)
      assert.ok(!agentlensDisabled())
    }
  })
})

suite('foreign telemetry — never overwritten without --force-install-telemetry', () => {
  const s = fixtureSuite(true)

  /** Make the user settings carry a company pipeline. Returns the file bytes AFTER the edit. */
  function makeForeign(f: Fx, extra: Record<string, string> = {}): string {
    const cfg = readSettings(f)
    // userinfo@host assembled at runtime: check-no-identities is shape-based and reads a literal `x@host` as an email
    cfg.env!.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://user:hunter2' + '@' + 'otel.corp.example:4318/v1?token=SECRETQ'
    cfg.env!.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer SUPERSECRET'
    cfg.env!.COMPANY_KEY = 'stays'
    Object.assign(cfg.env!, extra)
    writeSettings(f, cfg)
    return fs.readFileSync(f.settingsPath, 'utf8')
  }

  test('no flag + foreign endpoint/headers: exit CONFIG, nothing written, kill-switch armed, skills parked, agents stay', async () => {
    const f = s.f()
    const bytes = makeForeign(f)
    const r = recorder(); const l = lines()
    const code = await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: r.repair, stderr: l.say })
    assert.strictEqual(code, EXIT.CONFIG)
    assert.strictEqual(fs.readFileSync(f.settingsPath, 'utf8'), bytes, 'settings.json byte-identical')
    assert.deepStrictEqual(r.calls, [])
    assert.ok(agentlensDisabled() && killSwitchArmedForForeign(), 'kill-switch armed with the foreign-telemetry reason')
    assert.ok(fs.readFileSync(killSwitchPath(), 'utf8').includes(FOREIGN_REASON))
    for (const name of SKILL_NAMES) {
      assert.ok(!fs.existsSync(path.join(f.skillsDir, name)), `${name} moved out`)
      assert.ok(fs.existsSync(path.join(f.dataDir, 'disabled-surfaces', 'skills', name, 'SKILL.md')), `${name} parked in <dataDir>/disabled-surfaces/skills`)
    }
    for (const name of AGENT_NAMES) assert.ok(fs.existsSync(path.join(f.agentsDir, `${name}.md`)), `agent ${name} stays installed`)
    const msg = l.out.join('\n')
    assert.ok(msg.includes('OTEL_EXPORTER_OTLP_ENDPOINT') && msg.includes(f.settingsPath), 'names the key and the file')
    assert.ok(msg.includes('OTEL_EXPORTER_OTLP_HEADERS') && msg.includes('value withheld'))
    for (const secret of ['SUPERSECRET', 'hunter2', 'SECRETQ']) assert.ok(!msg.includes(secret), `${secret} must never be printed`)
    assert.ok(msg.includes('remove the existing telemetry setup') && msg.includes('--force-install-telemetry'), 'both remedies')
    assert.ok(msg.startsWith('agentlenspro is DISABLED — budget did not run.'))
  })

  test('mixed state (one foreign key + absent keys) writes NOTHING — no partial telemetry config, no marker', async () => {
    const f = s.f()
    writeSettings(f, { ...readSettings(f), env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://gw.corp.example/otlp', KEEP: '1' } })
    fs.rmSync(f.markerPath)
    const bytes = fs.readFileSync(f.settingsPath, 'utf8')
    assert.strictEqual(await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: recorder().repair, stderr: lines().say }), EXIT.CONFIG)
    assert.strictEqual(fs.readFileSync(f.settingsPath, 'utf8'), bytes)
    assert.ok(!fs.existsSync(f.markerPath))
  })

  test('a foreign value in the ENTERPRISE managed-settings file is reported with that file, and never written', async () => {
    const f = s.f()
    fs.mkdirSync(path.dirname(f.managedPath), { recursive: true })
    fs.writeFileSync(f.managedPath, JSON.stringify({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: MANAGED_FOREIGN } }))
    const managedBytes = fs.readFileSync(f.managedPath, 'utf8')
    const l = lines()
    assert.strictEqual(await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: recorder().repair, stderr: l.say }), EXIT.CONFIG)
    assert.ok(l.out.join('\n').includes(f.managedPath))
    assert.strictEqual(fs.readFileSync(f.managedPath, 'utf8'), managedBytes)
  })

  test('a conflicting variable exported in the SHELL is named, with the unset advice', async () => {
    const shellFx = makeFx({ OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' })
    try {
      await installAll(shellFx)
      const l = lines()
      assert.strictEqual(await maybeAutoSetup(['budget'], { ctx: shellFx.ctx, repair: recorder().repair, stderr: l.say }), EXIT.CONFIG)
      const msg = l.out.join('\n')
      assert.ok(msg.includes('OTEL_EXPORTER_OTLP_PROTOCOL') && msg.includes('process environment') && msg.includes('unset OTEL_EXPORTER_OTLP_PROTOCOL'), msg)
    } finally { shellFx.cleanup() }
  })

  test('what agentlenspro itself wrote earlier (a local endpoint on another port) is NOT foreign', async () => {
    const f = s.f()
    const cfg = readSettings(f)
    cfg.env!.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:7777'
    writeSettings(f, cfg)
    const r = recorder()
    assert.strictEqual(await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: r.repair, stderr: lines().say }), null)
    assert.deepStrictEqual(r.calls, ['otel-env'])
  })

  test('a hook-path verb with a foreign config: the check is not even run (it must never block a Claude turn)', async () => {
    const f = s.f()
    const bytes = makeForeign(f)
    for (const verb of HOOK_PATH_VERBS) {
      assert.strictEqual(await maybeAutoSetup([verb], { ctx: f.ctx, repair: recorder().repair, stderr: lines().say }), null, verb)
    }
    assert.strictEqual(fs.readFileSync(f.settingsPath, 'utf8'), bytes)
    assert.ok(!agentlensDisabled(), 'nothing was disabled either')
  })

  test('foreign removed by hand: the next launch restores everything and lifts the switch (no flag needed)', async () => {
    const f = s.f()
    makeForeign(f)
    await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: recorder().repair, stderr: lines().say })
    assert.ok(killSwitchArmedForForeign())
    const cfg = readSettings(f) // the user removes the company setup by hand
    cfg.env!.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318'
    delete cfg.env!.OTEL_EXPORTER_OTLP_HEADERS
    writeSettings(f, cfg)
    const r = recorder(['skill']); const l = lines()
    assert.strictEqual(await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: r.repair, stderr: l.say }), null)
    assert.ok(!agentlensDisabled(), 'switch lifted')
    for (const name of SKILL_NAMES) assert.ok(fs.existsSync(path.join(f.skillsDir, name, 'SKILL.md')), `${name} restored`)
    assert.ok(l.out.some(x => x.includes('re-enabled')), l.out.join('|'))
  })

  test('an operator-armed kill-switch (another reason) is never repaired around and never lifted by a launch', async () => {
    const f = s.f()
    disableAgentlensSurfaces('SSD burning', { dataDir: f.dataDir, skillsDir: f.skillsDir, rulesDir: path.join(f.home, '.claude', 'rules') })
    const r = recorder()
    assert.strictEqual(await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: r.repair, stderr: lines().say }), null)
    assert.deepStrictEqual(r.calls, [])
    assert.ok(agentlensDisabled() && !killSwitchArmedForForeign())
  })

  test('--force-install-telemetry: foreign overwritten AND absent keys written in ONE transaction, headers removed, backup printed, other keys kept', async () => {
    const f = s.f()
    const cfg = readSettings(f)
    delete cfg.env!.OTEL_LOGS_EXPORT_INTERVAL // absent
    writeSettings(f, cfg)
    makeForeign(f)
    const real = recorder(['otel-env', 'skill', 'hooks']); const l = lines()
    assert.strictEqual(await forceInstallTelemetry('budget', { ctx: f.ctx, repair: real.repair, stderr: l.say }), null)
    const after = readSettings(f)
    assert.strictEqual(after.env!.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://localhost:4318')
    assert.ok(!('OTEL_EXPORTER_OTLP_HEADERS' in after.env!), 'foreign-only headers key removed')
    assert.strictEqual(after.env!.OTEL_LOGS_EXPORT_INTERVAL, '5000', 'the absent key was written in the same run')
    assert.strictEqual(after.env!.COMPANY_KEY, 'stays', 'non-agentlenspro keys preserved')
    assert.ok(l.out.join('\n').includes('backup ') && l.out.join('\n').includes('agentlens-bak-'), 'the backup path is printed')
    const marker = JSON.parse(fs.readFileSync(f.markerPath, 'utf8')) as { keys: Record<string, { hadKey: boolean }> }
    assert.ok(marker.keys.OTEL_EXPORTER_OTLP_HEADERS?.hadKey, 'ownership + prior value recorded in the marker')
    assert.strictEqual(real.calls[0], 'otel-env', 'telemetry first')
  })

  test('--force-install-telemetry = enable + overwrite + restore: lifts an operator-armed switch and restores the skills', async () => {
    const f = s.f()
    disableAgentlensSurfaces('operator reason', { dataDir: f.dataDir, skillsDir: f.skillsDir, rulesDir: path.join(f.home, '.claude', 'rules') })
    const real = recorder(['skill'])
    assert.strictEqual(await forceInstallTelemetry('budget', { ctx: f.ctx, repair: real.repair, stderr: lines().say }), null)
    assert.ok(!agentlensDisabled(), 'the explicit command lifts the operator switch too')
    for (const name of SKILL_NAMES) assert.ok(fs.existsSync(path.join(f.skillsDir, name, 'SKILL.md')), `${name} restored`)
  })

  test('--force-install-telemetry with no foreign config and no drift: nothing to do, exits null, one report line', async () => {
    const f = s.f(); const l = lines(); const r = recorder()
    assert.strictEqual(await forceInstallTelemetry('', { ctx: f.ctx, repair: r.repair, stderr: l.say }), null)
    assert.deepStrictEqual(r.calls, [])
    assert.ok(l.out.some(x => x.includes('--force-install-telemetry applied')))
  })

  test('--force-install-telemetry overrides AGENTLENS_DISABLED=1 for THIS run only: full restore runs, warning printed; the next run without the flag is disabled again', async () => {
    const f = s.f()
    fs.rmSync(path.join(f.skillsDir, SKILL_NAMES[0]), { recursive: true })
    process.env.AGENTLENS_DISABLED = '1'
    const real = recorder(['skill']); const l = lines()
    assert.strictEqual(await forceInstallTelemetry('budget', { ctx: f.ctx, repair: real.repair, stderr: l.say, env: { AGENTLENS_DISABLED: '1' } }), null)
    assert.deepStrictEqual(real.calls, ['skill'], 'the full restore ran despite the env var')
    assert.ok(fs.existsSync(path.join(f.skillsDir, SKILL_NAMES[0], 'SKILL.md')))
    assert.ok(l.out.some(x => x.includes('overrode AGENTLENS_DISABLED') && x.includes('next run')), l.out.join('|'))
    assert.strictEqual(disabledNotice(['budget']), null, 'during the flagged run the env half is overridden (in-process flag)')
    assert.strictEqual(process.env.AGENTLENS_DISABLED, '1', 'process.env is NOT mutated — nothing persists, children inherit it as it was')
    // the very next run, without the flag: the override is gone
    overrideKillSwitchEnv(false)
    fs.rmSync(path.join(f.skillsDir, SKILL_NAMES[1]), { recursive: true })
    const next = recorder(); const l2 = lines()
    assert.strictEqual(await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: next.repair, stderr: l2.say }), null)
    assert.deepStrictEqual(next.calls, [], 'disabled by the env var: nothing is restored')
    const n = disabledNotice(['budget'])!
    assert.strictEqual(n.code, EXIT.DISABLED)
    assert.ok(n.text.includes('To reactivate: unset AGENTLENS_DISABLED'))
  })

  test('--force-install-telemetry with a SHELL OTEL_* conflict: settings.json is written anyway, the warning names the variable', async () => {
    const shellFx = makeFx({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://shell.corp.example/otlp' })
    try {
      await installAll(shellFx)
      const cfg = readSettings(shellFx)
      delete cfg.env!.OTEL_LOGS_EXPORT_INTERVAL
      writeSettings(shellFx, cfg)
      const l = lines()
      assert.strictEqual(await forceInstallTelemetry('budget', { ctx: shellFx.ctx, repair: recorder(['otel-env']).repair, stderr: l.say }), null)
      assert.strictEqual(readSettings(shellFx).env!.OTEL_LOGS_EXPORT_INTERVAL, '5000', 'settings.json written as if the shell variable were absent')
      assert.ok(l.out.some(x => x.includes('overrode OTEL_EXPORTER_OTLP_ENDPOINT')), l.out.join('|'))
    } finally { shellFx.cleanup() }
  })

  test('--force-install-telemetry overwrites a WRITABLE managed file (backup made) and the user file together', async () => {
    const f = s.f()
    makeForeign(f)
    fs.mkdirSync(path.dirname(f.managedPath), { recursive: true })
    fs.writeFileSync(f.managedPath, JSON.stringify({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: MANAGED_FOREIGN, ORG_KEY: 'org' } }))
    const real = recorder(['otel-env'])
    assert.strictEqual(await forceInstallTelemetry('budget', { ctx: f.ctx, repair: real.repair, stderr: lines().say }), null)
    const managed = JSON.parse(fs.readFileSync(f.managedPath, 'utf8')) as { env: Record<string, string> }
    assert.strictEqual(managed.env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://localhost:4318')
    assert.strictEqual(managed.env.ORG_KEY, 'org', "the organisation's other keys are kept")
    assert.ok(fs.readdirSync(path.dirname(f.managedPath)).some(n => n.includes('agentlens-bak-')), 'managed-file backup')
    assert.strictEqual(readSettings(f).env!.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://localhost:4318')
  })

  test('--force-install-telemetry with an UNWRITABLE managed file: exit CONFIG, "administrator" message, file untouched', async function () {
    if (process.getuid && process.getuid() === 0) this.skip() // root can write anything
    const f = s.f()
    fs.mkdirSync(path.dirname(f.managedPath), { recursive: true })
    fs.writeFileSync(f.managedPath, JSON.stringify({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: MANAGED_FOREIGN } }))
    fs.chmodSync(f.managedPath, 0o444)
    const bytes = fs.readFileSync(f.managedPath, 'utf8')
    const l = lines()
    assert.strictEqual(await forceInstallTelemetry('budget', { ctx: f.ctx, repair: recorder(['otel-env']).repair, stderr: l.say }), EXIT.CONFIG)
    assert.ok(/administrator/.test(l.out.join('\n')), l.out.join('|'))
    assert.ok(l.out.join('\n').includes(f.managedPath))
    assert.strictEqual(fs.readFileSync(f.managedPath, 'utf8'), bytes)
  })

  test('plain enable and the setup telemetry step never overwrite a foreign value (file unchanged)', async () => {
    const f = s.f()
    const bytes = makeForeign(f)
    assert.strictEqual(await runEnableCli(false, { ctx: f.ctx, repair: recorder().repair, stderr: lines().say }), EXIT.CONFIG)
    assert.strictEqual(fs.readFileSync(f.settingsPath, 'utf8'), bytes)
    const { result } = await REPAIR_STEPS['otel-env'].run({ ...f.ctx, forceInstall: false })
    assert.strictEqual(result.verify, 'FAIL')
    assert.strictEqual(fs.readFileSync(f.settingsPath, 'utf8'), bytes)
  })
})

suite('enable — the telemetry verdict comes first, then the restore, then the switch is lifted', () => {
  const s = fixtureSuite(true)

  test('enable with foreign present ends DISABLED: switch armed, skills moved, nothing written, no restore ran', async () => {
    const f = s.f()
    const cfg = readSettings(f)
    cfg.env!.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://gw.corp.example/otlp'
    writeSettings(f, cfg)
    armKillSwitch('operator reason') // the operator had disabled it, then runs `enable`
    const bytes = fs.readFileSync(f.settingsPath, 'utf8')
    const r = recorder(); const l = lines()
    assert.strictEqual(await runEnableCli(false, { ctx: f.ctx, repair: r.repair, stderr: l.say }), EXIT.CONFIG)
    assert.deepStrictEqual(r.calls, [], 'a restore running before the verdict (or at all) would be a bug')
    assert.ok(killSwitchArmedForForeign(), 're-armed with the foreign reason, even though enable was just run')
    assert.strictEqual(fs.readFileSync(f.settingsPath, 'utf8'), bytes)
    assert.ok(!fs.existsSync(path.join(f.skillsDir, SKILL_NAMES[0])), 'skills moved aside')
    assert.ok(l.out.join('\n').startsWith('agentlenspro is DISABLED — enable did not run.'))
  })

  test('foreign removed, then enable: telemetry written FIRST, then skills restored, then the switch is disarmed', async () => {
    const f = s.f()
    disableAgentlensSurfaces('operator reason', { dataDir: f.dataDir, skillsDir: f.skillsDir, rulesDir: path.join(f.home, '.claude', 'rules') })
    const cfg = readSettings(f)
    delete cfg.env!.OTEL_LOGS_EXPORT_INTERVAL
    writeSettings(f, cfg)
    const r = recorder(['otel-env', 'skill'])
    const log = console.log
    console.log = quiet
    let code: number
    try { code = await runEnableCli(false, { ctx: f.ctx, repair: r.repair, stderr: lines().say }) } finally { console.log = log }
    assert.strictEqual(code, EXIT.OK)
    assert.deepStrictEqual(r.calls, ['otel-env', 'skill'], 'the telemetry repair is the FIRST action')
    assert.ok(!agentlensDisabled(), 'switch disarmed')
    assert.strictEqual(readSettings(f).env!.OTEL_LOGS_EXPORT_INTERVAL, '5000')
    for (const name of SKILL_NAMES) assert.ok(fs.existsSync(path.join(f.skillsDir, name, 'SKILL.md')), `${name} restored`)
  })
})

suite('a disabled agentlenspro tells whoever runs it how to reactivate (owner order 2026-10-02)', () => {
  fixtureSuite(false)

  test('enabled: no notice', () => {
    assert.strictEqual(disabledNotice(['budget']), null)
  })

  test('operator disable: names the reason and `agentlenspro enable`, exit DISABLED', () => {
    armKillSwitch('SSD burning')
    const n = disabledNotice(['budget'])!
    assert.strictEqual(n.code, EXIT.DISABLED)
    const l = n.text.split('\n')
    assert.strictEqual(l[0], 'agentlenspro is DISABLED — budget did not run.')
    assert.ok(l[1].includes('SSD burning'))
    assert.ok(l[2].includes('To reactivate: agentlenspro enable'))
  })

  test('env var: tells to UNSET it and says enable cannot clear an environment variable', () => {
    process.env.AGENTLENS_DISABLED = '1'
    const n = disabledNotice(['budget'])!
    assert.ok(n.text.includes('To reactivate: unset AGENTLENS_DISABLED') && n.text.includes('enable cannot clear an environment variable'))
  })

  test('foreign telemetry reason: the remove-or---force-install-telemetry line', () => {
    armKillSwitch(FOREIGN_REASON)
    const n = disabledNotice(['budget'])!
    assert.ok(n.text.includes('To reactivate: remove the existing telemetry setup') && n.text.includes('agentlenspro --force-install-telemetry <any command>'), n.text)
  })

  test('hook-path verbs stay SILENT; enable/disable/setup/server status pass; other verbs and the bare launch are refused', () => {
    armKillSwitch('x')
    for (const v of HOOK_PATH_VERBS) assert.strictEqual(disabledNotice([v]), null, v)
    for (const v of ['enable', 'disable', 'setup']) assert.strictEqual(disabledNotice([v]), null, v)
    assert.strictEqual(disabledNotice(['server', 'status']), null)
    assert.strictEqual(disabledNotice(['server', 'start']), null, 'server/daemon keep their own terminal handling')
    assert.notStrictEqual(disabledNotice([]), null)
  })

  test('the dispatcher prints it to stderr and exits EXIT.DISABLED without running the verb', async () => {
    armKillSwitch('SSD burning')
    const savedNo = process.env.AGENTLENS_NO_AUTOSETUP
    process.env.AGENTLENS_NO_AUTOSETUP = '1' // never let a dispatcher test touch the real ~/.claude
    const err = console.error
    let printed = ''
    console.error = (...a: unknown[]): void => { printed += `${a.join(' ')}\n` }
    try {
      assert.strictEqual(await cliMain(['budget'], async () => undefined), EXIT.DISABLED)
    } finally {
      console.error = err
      if (savedNo === undefined) delete process.env.AGENTLENS_NO_AUTOSETUP; else process.env.AGENTLENS_NO_AUTOSETUP = savedNo
    }
    assert.ok(printed.includes('agentlenspro is DISABLED — budget did not run.') && printed.includes('agentlenspro enable'))
  })

  test('--force-install-telemetry is consumed by the dispatcher: no verb ever sees it', async () => {
    const log = console.log
    let printed = ''
    console.log = (...a: unknown[]): void => { printed += `${a.join(' ')}\n` }
    try {
      assert.strictEqual(await cliMain(['--force-install-telemetry', '--version'], async () => undefined), 0)
    } finally { console.log = log }
    assert.ok(/^\d+\.\d+\.\d+/.test(printed.trim()), printed)
  })
})

suite('telemetry verdict — only ROUTING keys can be foreign; under Claude Code the shell env is a snapshot', () => {
  const s = fixtureSuite(true)
  const verdictOf = (f: Fx, processEnv: NodeJS.ProcessEnv = {}): TelemetryVerdictRow[] => telemetryVerdict({
    settingsPath: f.settingsPath, markerPath: f.markerPath, dataDir: f.dataDir, otlpPort: 4318, managedSettingsPaths: [f.managedPath], processEnv,
  })
  const stateOf = (rows: TelemetryVerdictRow[], key: string, scope = 'user'): string | undefined => rows.find(r => r.key === key && r.scope === scope)?.state

  test('a loopback spelling of our endpoint (127.0.0.1, ::1, trailing slash) is OURS, not foreign, and needs no repair', async () => {
    const f = s.f()
    for (const spelling of ['http://127.0.0.1:4318', 'http://[::1]:4318/', 'http://localhost:4318/']) {
      const cfg = readSettings(f)
      cfg.env!.OTEL_EXPORTER_OTLP_ENDPOINT = spelling
      writeSettings(f, cfg)
      assert.strictEqual(stateOf(verdictOf(f), 'OTEL_EXPORTER_OTLP_ENDPOINT'), 'OURS', spelling)
      const r = recorder()
      assert.strictEqual(await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: r.repair, stderr: lines().say }), null, spelling)
      assert.deepStrictEqual(r.calls, [], spelling)
    }
  })

  test('a changed export interval is CONVERGED (one "converged <key>" line), never foreign', async () => {
    const f = s.f()
    const cfg = readSettings(f)
    cfg.env!.OTEL_LOGS_EXPORT_INTERVAL = '60000'
    writeSettings(f, cfg)
    assert.strictEqual(stateOf(verdictOf(f), 'OTEL_LOGS_EXPORT_INTERVAL'), 'CONVERGE')
    const l = lines()
    assert.strictEqual(await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: recorder(['otel-env']).repair, stderr: l.say }), null)
    assert.strictEqual(readSettings(f).env!.OTEL_LOGS_EXPORT_INTERVAL, '5000')
    assert.ok(l.out.includes('agentlenspro: converged OTEL_LOGS_EXPORT_INTERVAL'), l.out.join('|'))
    assert.ok(!agentlensDisabled())
  })

  test('OTEL_LOG_USER_PROMPTS=0 is CONVERGED to agentlenspro\'s value, not foreign', async () => {
    const f = s.f()
    const cfg = readSettings(f)
    cfg.env!.OTEL_LOG_USER_PROMPTS = '0'
    writeSettings(f, cfg)
    assert.strictEqual(stateOf(verdictOf(f), 'OTEL_LOG_USER_PROMPTS'), 'CONVERGE')
    assert.strictEqual(await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: recorder(['otel-env']).repair, stderr: lines().say }), null)
    assert.strictEqual(readSettings(f).env!.OTEL_LOG_USER_PROMPTS, '1')
  })

  test('OTEL_RESOURCE_ATTRIBUTES / OTEL_SERVICE_NAME (not managed, not routing) are ignored everywhere', async () => {
    const f = s.f()
    const cfg = readSettings(f)
    cfg.env!.OTEL_RESOURCE_ATTRIBUTES = 'team=x'
    cfg.env!.OTEL_SERVICE_NAME = 'corp-claude'
    writeSettings(f, cfg)
    const shell = { OTEL_RESOURCE_ATTRIBUTES: 'a=b', OTEL_SERVICE_NAME: 'svc' }
    const rows = verdictOf(f, shell)
    assert.ok(!rows.some(r => /RESOURCE_ATTRIBUTES|SERVICE_NAME/.test(r.key)))
    assert.deepStrictEqual(rows.filter(r => r.state === 'FOREIGN'), [])
    const r = recorder()
    assert.strictEqual(await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: r.repair, stderr: lines().say }), null)
    assert.deepStrictEqual(r.calls, [])
  })

  test('a real remote endpoint is FOREIGN', () => {
    const f = s.f()
    const cfg = readSettings(f)
    cfg.env!.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otel.corp.example/otlp'
    writeSettings(f, cfg)
    assert.strictEqual(stateOf(verdictOf(f), 'OTEL_EXPORTER_OTLP_ENDPOINT'), 'FOREIGN')
  })

  test('tuning keys differing in the SHELL or managed settings are ignored (only the user file converges them)', () => {
    const f = s.f()
    fs.mkdirSync(path.dirname(f.managedPath), { recursive: true })
    fs.writeFileSync(f.managedPath, JSON.stringify({ env: { OTEL_LOGS_EXPORT_INTERVAL: '1', OTEL_LOG_USER_PROMPTS: '0' } }))
    const rows = verdictOf(f, { OTEL_LOGS_EXPORT_INTERVAL: '1' })
    assert.deepStrictEqual(rows.filter(r => r.scope !== 'user'), [])
  })

  test('under Claude Code a differing shell OTEL_* value is a STALE snapshot: one warning, NOT disabled; equal to the file = fine; outside Claude Code the same value is FOREIGN', async () => {
    const stale = makeFx({ CLAUDECODE: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://old.corp.example/otlp' })
    try {
      await installAll(stale)
      const r = recorder(); const l = lines()
      assert.strictEqual(await maybeAutoSetup(['budget'], { ctx: stale.ctx, repair: r.repair, stderr: l.say }), null)
      assert.ok(!agentlensDisabled(), 'a stale snapshot must never disable')
      assert.deepStrictEqual(r.calls, [])
      assert.strictEqual(l.out.filter(x => x.includes('stale session env')).length, 1)
      assert.ok(l.out[0].includes('restart Claude Code') && l.out[0].includes('OTEL_EXPORTER_OTLP_ENDPOINT'))
    } finally { stale.cleanup() }
    const fresh = makeFx({ CLAUDECODE: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' })
    try {
      await installAll(fresh)
      const l = lines()
      assert.strictEqual(await maybeAutoSetup(['budget'], { ctx: fresh.ctx, repair: recorder().repair, stderr: l.say }), null)
      assert.deepStrictEqual(l.out, [], 'equal to the current file: nothing to say')
    } finally { fresh.cleanup() }
    const outside = makeFx({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://old.corp.example/otlp' })
    try {
      await installAll(outside)
      assert.strictEqual(await maybeAutoSetup(['budget'], { ctx: outside.ctx, repair: recorder().repair, stderr: lines().say }), EXIT.CONFIG)
    } finally { outside.cleanup() }
  })
})

suite('setup --dry-run and per-launch opt-out never mutate anything', () => {
  const s = fixtureSuite(true)

  function snapshot(f: Fx): string {
    const files = [f.settingsPath, f.markerPath]
    return files.map(p => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'absent')).join('|')
      + `|${fs.readdirSync(path.dirname(f.settingsPath)).sort().join(',')}|${SKILL_NAMES.filter(n => fs.existsSync(path.join(f.skillsDir, n))).length}|${agentlensDisabled()}`
  }

  test('the otel-env step in dry-run prints the per-key verdict for a FOREIGN config and writes/arms/moves nothing', async () => {
    const f = s.f()
    const cfg = readSettings(f)
    cfg.env!.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otel.corp.example/otlp'
    delete cfg.env!.OTEL_LOGS_EXPORT_INTERVAL
    cfg.env!.OTEL_LOG_USER_PROMPTS = '0'
    writeSettings(f, cfg)
    const before = snapshot(f)
    const { result } = await REPAIR_STEPS['otel-env'].run({ ...f.ctx, dryRun: true })
    const d = result.detail ?? ''
    for (const w of ['FOREIGN', 'ABSENT', 'CONVERGE', 'OURS']) assert.ok(d.includes(w), `${w} missing from: ${d}`)
    assert.strictEqual(snapshot(f), before, 'settings, marker, backups, skills and the kill-switch are all untouched')
    assert.ok(!agentlensDisabled())
  })

  test('the otel-env step in dry-run on a healthy-but-incomplete config lists ABSENT rows and writes nothing', async () => {
    const f = s.f()
    const cfg = readSettings(f)
    delete cfg.env!.OTEL_LOGS_EXPORT_INTERVAL
    writeSettings(f, cfg)
    const before = snapshot(f)
    const { result } = await REPAIR_STEPS['otel-env'].run({ ...f.ctx, dryRun: true })
    assert.ok((result.detail ?? '').includes('ABSENT') && (result.detail ?? '').includes('OTEL_LOGS_EXPORT_INTERVAL'))
    assert.strictEqual(snapshot(f), before)
  })

  test('AGENTLENS_NO_AUTOSETUP=1 and every excluded verb touch NO ctx path at all (zero settings reads or writes)', async () => {
    const f = s.f()
    const touched: string[] = []
    const spy = new Proxy(f.ctx, { get(t, k, r) { touched.push(String(k)); return Reflect.get(t, k, r) } })
    for (const verb of AUTOSETUP_EXCLUDED_VERBS) {
      assert.strictEqual(await maybeAutoSetup([verb], { ctx: spy, repair: recorder().repair, stderr: lines().say }), null, verb)
    }
    assert.deepStrictEqual(touched, [], `excluded verbs read ctx: ${touched.join(',')}`)
    for (const verb of ['statusline', 'hook', 'gate', 'review-gate', 'review-supervisor', 'delegate-gate']) assert.ok(AUTOSETUP_EXCLUDED_VERBS.has(verb), verb)
    const foreign = makeFx(); // opt-out with a foreign config: still nothing, not even a read
    try {
      assert.strictEqual(await maybeAutoSetup(['budget'], { ctx: spy, repair: recorder().repair, stderr: lines().say, env: { AGENTLENS_NO_AUTOSETUP: '1' } }), null)
      assert.deepStrictEqual(touched, [], 'AGENTLENS_NO_AUTOSETUP=1 must stop at the env check')
    } finally { foreign.cleanup() }
  })
})

suite('server verbs under DISABLED hit serverControl\'s own terminal handling, not the dispatcher 69', () => {
  fixtureSuite(false)

  test('server/daemon pass the dispatcher notice; `server start` and `server start --supervise` refuse before spawning anything', async () => {
    armKillSwitch('x')
    for (const argv of [['server', 'start'], ['server', 'start', '--supervise'], ['daemon', 'start', '--supervise']]) {
      assert.strictEqual(disabledNotice(argv), null, argv.join(' '))
      const savedNo = process.env.AGENTLENS_NO_AUTOSETUP
      process.env.AGENTLENS_NO_AUTOSETUP = '1'
      try {
        await assert.rejects(() => cliMain(argv, async () => undefined), /DISABLED[\s\S]*refusing to (start|supervise)/, argv.join(' '))
      } finally { if (savedNo === undefined) delete process.env.AGENTLENS_NO_AUTOSETUP; else process.env.AGENTLENS_NO_AUTOSETUP = savedNo }
    }
  })
})

// TRDD-YL3EWT6N item 3: `server|daemon start|restart` run the install check too — they are excluded from the
// per-launch check (maybeAutoSetup) because hooks reach them, so before this a server start never repaired anything.
// Real files in a temp HOME; only the repair runner is injected (it runs the REAL step where a test restores).
suite('server start — the install heals itself when the server is started (TRDD-YL3EWT6N)', () => {
  const s = fixtureSuite(true)
  const skill0 = (f: Fx): string => path.join(f.skillsDir, SKILL_NAMES[0])

  test('server start/restart and daemon start/restart restore a missing skill; stop, status and revive never run the check', async () => {
    const f = s.f()
    for (const argv of [['server', 'start'], ['server', 'restart'], ['daemon', 'start', '--supervise'], ['daemon', 'restart']]) {
      fs.rmSync(skill0(f), { recursive: true })
      const r = recorder(['skill']); const l = lines()
      await autoSetupOnServerStart(argv, { ctx: f.ctx, repair: r.repair, stderr: l.say })
      assert.deepStrictEqual(r.calls, ['skill'], argv.join(' '))
      assert.ok(fs.existsSync(path.join(skill0(f), 'SKILL.md')), `${argv.join(' ')} must restore the skill`)
      assert.ok(l.out.some(x => x.includes('restored skills')), l.out.join('|'))
    }
    fs.rmSync(skill0(f), { recursive: true })
    for (const argv of [['server', 'stop'], ['server', 'status'], ['server', 'revive'], ['daemon', 'status'], ['daemon'], ['budget']]) {
      const r = recorder(['skill']); const l = lines()
      await autoSetupOnServerStart(argv, { ctx: f.ctx, repair: r.repair, stderr: l.say })
      assert.deepStrictEqual(r.calls, [], `${argv.join(' ')} must not run the check (revive is the hook path)`)
      assert.deepStrictEqual(l.out, [])
    }
  })

  test('AGENTLENS_NO_AUTOSETUP=1: a server start does not repair', async () => {
    const f = s.f()
    fs.rmSync(skill0(f), { recursive: true })
    const r = recorder(['skill']); const l = lines()
    await autoSetupOnServerStart(['server', 'start'], { ctx: f.ctx, repair: r.repair, stderr: l.say, env: { AGENTLENS_NO_AUTOSETUP: '1' } })
    assert.deepStrictEqual(r.calls, [])
    assert.deepStrictEqual(l.out, [])
    assert.ok(!fs.existsSync(skill0(f)), 'nothing restored')
  })

  test('a fresh lock held by another process: the server start skips the repair AND says so in one line', async () => {
    const f = s.f()
    fs.rmSync(skill0(f), { recursive: true })
    fs.writeFileSync(path.join(f.dataDir, '.autosetup.lock'), '')
    const r = recorder(['skill']); const l = lines()
    await autoSetupOnServerStart(['server', 'start'], { ctx: f.ctx, repair: r.repair, stderr: l.say })
    assert.deepStrictEqual(r.calls, [])
    assert.deepStrictEqual(l.out, ['agentlenspro: install check skipped: another agentlenspro is repairing'])
    // The launch path keeps its silent skip — only the server trigger reports it.
    const l2 = lines()
    await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: recorder().repair, stderr: l2.say })
    assert.deepStrictEqual(l2.out, [], 'a launch still skips silently')
  })

  test('Claude Code absent (no ~/.claude, no `claude` on PATH): skipped and nothing created; a `claude` on PATH alone counts as present', async () => {
    const e = makeFx()
    try {
      const binOnly = path.join(e.home, 'bin')
      const ctx: Ctx = { ...e.ctx, pathEnv: binOnly }
      assert.strictEqual(claudeCodePresent(ctx), false)
      const r = recorder(); const l = lines()
      await autoSetupOnServerStart(['server', 'start'], { ctx, repair: r.repair, stderr: l.say, fullSetup: async () => { throw new Error('full setup must not run') } })
      assert.deepStrictEqual(r.calls, [])
      assert.deepStrictEqual(l.out, [])
      assert.ok(!fs.existsSync(path.join(e.home, '.claude')), 'no ~/.claude tree is created where Claude Code is absent')
      fs.writeFileSync(path.join(binOnly, 'claude'), '#!/bin/sh\nexit 0\n')
      fs.chmodSync(path.join(binOnly, 'claude'), 0o755)
      assert.strictEqual(claudeCodePresent(ctx), true)
      // fullSetup is injected so a regression onto the launch-only first-run path is a FAILED assert, never a real
      // runSetup — which would start a real collector on the fixture's data dir.
      let full = 0
      const r2 = recorder()
      await autoSetupOnServerStart(['server', 'start'], { ctx, repair: r2.repair, stderr: lines().say, fullSetup: async () => { full++; return true } })
      assert.strictEqual(full, 0, 'a server start never runs the first-run full setup (it starts a server)')
      assert.deepStrictEqual(r2.calls, ['otel-env', 'hooks', 'skill'], 'nothing installed + Claude present: the per-piece repairs, never a full setup')
    } finally { e.cleanup() }
  })

  test('a parked surface stays parked across a server start, whoever armed the switch (operator or foreign telemetry)', async () => {
    for (const reason of ['operator reason', FOREIGN_REASON]) {
      const f = s.f()
      disableAgentlensSurfaces(reason, { dataDir: f.dataDir, skillsDir: f.skillsDir, rulesDir: path.join(f.home, '.claude', 'rules') })
      assert.ok(!fs.existsSync(skill0(f)), 'baseline: the skill is parked')
      const r = recorder(['skill']); const l = lines()
      await autoSetupOnServerStart(['server', 'start'], { ctx: f.ctx, repair: r.repair, stderr: l.say })
      assert.deepStrictEqual(r.calls, [], reason)
      assert.ok(!fs.existsSync(skill0(f)), `${reason}: the skill stays parked`)
      assert.ok(agentlensDisabled(), `${reason}: the switch stays armed`)
      enableAgentlensSurfaces({ dataDir: f.dataDir, skillsDir: f.skillsDir, rulesDir: path.join(f.home, '.claude', 'rules') })
    }
  })

  test('foreign telemetry: a server start writes nothing, arms nothing, prints one line, and never refuses', async () => {
    const f = s.f()
    const cfg = readSettings(f)
    cfg.env!.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otel.corp.example:4318/v1'
    writeSettings(f, cfg)
    const bytes = fs.readFileSync(f.settingsPath, 'utf8')
    fs.rmSync(skill0(f), { recursive: true })
    const r = recorder(['skill']); const l = lines()
    await autoSetupOnServerStart(['server', 'start'], { ctx: f.ctx, repair: r.repair, stderr: l.say })
    assert.deepStrictEqual(r.calls, [])
    assert.strictEqual(fs.readFileSync(f.settingsPath, 'utf8'), bytes, 'settings.json byte-identical')
    assert.strictEqual(agentlensDisabled(), false, 'a server start never arms the kill-switch')
    assert.ok(!fs.existsSync(path.join(f.dataDir, 'disabled-surfaces')), 'nothing parked')
    assert.deepStrictEqual(l.out.filter(x => x.includes('install check skipped')).length, 1, l.out.join('|'))
  })

  test('a check that throws never escapes: one line, and the start goes on', async () => {
    const f = s.f()
    fs.rmSync(skill0(f), { recursive: true })
    const l = lines()
    await autoSetupOnServerStart(['server', 'start'], { ctx: f.ctx, repair: async () => { throw new Error('boom') }, stderr: l.say })
    assert.ok(l.out.some(x => x.includes('boom')), l.out.join('|'))
  })

  // The wiring itself: the tests above call autoSetupOnServerStart directly, so deleting its call from main.ts failed
  // nothing. This drives cliMain with the verb and the check injected (no collector is ever spawned) and pins both
  // that the check runs and that it runs AFTER the verb — run first, the check was collector downtime.
  test('cliMain runs the install check AFTER the verb for server/daemon start|restart (deleting either call fails this)', async () => {
    const f = s.f()
    for (const argv of [['server', 'start'], ['server', 'restart'], ['daemon', 'start'], ['daemon', 'restart']]) {
      const order: string[] = []
      const verb = async (a: string[]): Promise<void> => { order.push(`verb ${a.join(' ')}`) }
      const code = await cliMain(argv, async () => undefined, {
        serverCommand: verb,
        daemonCommand: verb,
        serverStartCheck: async (a: string[]) => { order.push(`check ${a.join(' ')}`) },
      })
      assert.strictEqual(code, 0, argv.join(' '))
      assert.deepStrictEqual(order, [`verb ${argv.slice(1).join(' ')}`, `check ${argv.join(' ')}`], argv.join(' '))
    }
    assert.ok(!fs.existsSync(path.join(f.dataDir, 'server.pid')), 'no collector was started')
  })

  // The wiring test above INJECTS serverStartCheck, so a cliMain whose DEFAULT check were a no-op would still pass it.
  // This drives cliMain with only the verb stubbed: the REAL autoSetupOnServerStart must run after it. A fresh repair
  // lock keeps it from writing anything, so its server trigger prints one "install check skipped" line (or, when this
  // machine's own telemetry env reads as foreign, the foreign-telemetry skip line, which has the same prefix).
  test('the DEFAULT check of cliMain is the real autoSetupOnServerStart (a no-op default fails this)', async () => {
    const f = s.f()
    fs.writeFileSync(path.join(f.dataDir, '.autosetup.lock'), '')
    // Without a ~/.claude dir, an armed kill-switch or AGENTLENS_DISABLED, the real check returns before printing its line.
    fs.mkdirSync(path.join(f.home, '.claude'), { recursive: true })
    overrideKillSwitchEnv(false)
    const savedEnv: Record<string, string | undefined> = {}
    for (const k of ['HOME', 'DATA_DIR', 'AGENTLENS_NO_AUTOSETUP', 'AGENTLENS_CLAUDE_SETTINGS', 'AGENTLENS_DISABLED']) savedEnv[k] = process.env[k]
    process.env.HOME = f.home
    process.env.DATA_DIR = f.dataDir
    delete process.env.AGENTLENS_NO_AUTOSETUP
    delete process.env.AGENTLENS_CLAUDE_SETTINGS
    delete process.env.AGENTLENS_DISABLED
    const err: string[] = []
    const realWrite = process.stderr.write
    process.stderr.write = ((chunk: string | Uint8Array): boolean => { err.push(String(chunk)); return true }) as typeof process.stderr.write
    try {
      assert.strictEqual(await cliMain(['server', 'start'], async () => undefined, { serverCommand: async () => undefined }), 0)
    } finally {
      process.stderr.write = realWrite
      for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
      overrideKillSwitchEnv(false)
    }
    assert.ok(err.some(x => x.startsWith('agentlenspro: install check skipped:')), `the default check never ran: ${err.join('|')}`)
    assert.ok(!fs.existsSync(path.join(f.dataDir, 'server.pid')), 'no collector was started')
  })
})
// TRDD-YL3EWT6N item 7: the launch install check's notices are HELD (launchNotices.ts) and print where they belong —
// folded into a single tool call's refusal (the exit-2 contract: stderr is exactly one JSON object), after a single
// tool call's output otherwise, and BEFORE every other verb runs, as they always did. In-process, so the order of
// stdout and stderr writes is observable in one sequence.
suite('launch notices — held for a single tool call, printed before every other verb (TRDD-YL3EWT6N item 7)', () => {
  const s = fixtureSuite(false)
  type Seq = Array<['out' | 'err', string]>
  const NOTICE = 'agentlenspro: restored skills (a test notice)'
  const holdNotice = async (): Promise<null> => { pushNotice(NOTICE); return null }
  const indexOf = (seq: Seq, stream: 'out' | 'err', text: string): number => seq.findIndex(([s2, t]) => s2 === stream && t.includes(text))

  /** Run `fn` with HOME/DATA_DIR on the fixture and every switch that could stop a launch cleared; restores all. */
  async function inFixtureEnv<T>(f: Fx, extra: Record<string, string>, fn: () => Promise<T>): Promise<T> {
    overrideKillSwitchEnv(false)
    const keys = ['HOME', 'DATA_DIR', 'AGENTLENS_NO_AUTOSETUP', 'AGENTLENS_DISABLED', 'AGENTLENS_MCP_URL']
    const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]))
    process.env.HOME = f.home
    process.env.DATA_DIR = f.dataDir
    for (const k of ['AGENTLENS_NO_AUTOSETUP', 'AGENTLENS_DISABLED', 'AGENTLENS_MCP_URL']) delete process.env[k]
    Object.assign(process.env, extra)
    try { return await fn() } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
      overrideKillSwitchEnv(false)
    }
  }

  /** stdout and stderr writes into ONE ordered sequence; process.exitCode restored (a refusal sets it to 2). */
  async function captured(seq: Seq, fn: () => Promise<number>): Promise<number> {
    const out = process.stdout.write
    const err = process.stderr.write
    const exitCode = process.exitCode
    process.stdout.write = ((c: string | Uint8Array): boolean => { seq.push(['out', String(c)]); return true }) as typeof process.stdout.write
    process.stderr.write = ((c: string | Uint8Array): boolean => { seq.push(['err', String(c)]); return true }) as typeof process.stderr.write
    try { return await fn() } finally {
      process.stdout.write = out
      process.stderr.write = err
      process.exitCode = exitCode
    }
  }

  test('a single tool call prints the held notices AFTER its own output (seam: injected diagnostics surface)', async () => {
    const seq: Seq = []
    const code = await inFixtureEnv(s.f(), {}, () => captured(seq, () => cliMain(['get_burn_status'], async () => undefined, {
      launchCheck: holdNotice, diagnostics: async () => { console.log('TOOL RESULT') },
    })))
    assert.strictEqual(code, 0)
    const iOut = indexOf(seq, 'out', 'TOOL RESULT')
    const iNote = indexOf(seq, 'err', NOTICE)
    assert.ok(iOut >= 0 && iNote > iOut, JSON.stringify(seq))
  })

  test('a real single tool call holds the notices past the server round trip and prints them after the result', async () => {
    const seq: Seq = []
    let noticeAtFirstRequest: boolean | null = null
    const stub = await startMcpStub([{ name: 'get_burn_status', description: 'x' }], () => ({ ok: 'the result' }),
      () => { if (noticeAtFirstRequest === null) noticeAtFirstRequest = indexOf(seq, 'err', NOTICE) >= 0 })
    try {
      const code = await inFixtureEnv(s.f(), { AGENTLENS_MCP_URL: stub.url }, () => captured(seq, () =>
        cliMain(['get_burn_status'], async () => undefined, { launchCheck: holdNotice })))
      assert.strictEqual(code, 0)
      assert.strictEqual(noticeAtFirstRequest, false, 'the notice must still be held while the tool runs')
      const iOut = indexOf(seq, 'out', 'the result')
      assert.ok(iOut >= 0 && indexOf(seq, 'err', NOTICE) > iOut, JSON.stringify(seq))
    } finally { await stub.close() }
  })

  test('a real refusal folds the held notices into its ONE JSON object and prints nothing else', async () => {
    const seq: Seq = []
    const stub = await startMcpStub([{ name: 'get_burn_status', description: 'x' }], () => ({ error: 'nothing to report' }))
    try {
      await inFixtureEnv(s.f(), { AGENTLENS_MCP_URL: stub.url }, () => captured(seq, () =>
        cliMain(['get_burn_status'], async () => undefined, { launchCheck: holdNotice })))
      assert.strictEqual(seq.filter(([st]) => st === 'out').map(([, t]) => t).join(''), '', 'stdout stays empty on a refusal')
      const payload = JSON.parse(seq.filter(([st]) => st === 'err').map(([, t]) => t).join('')) as Record<string, unknown>
      assert.deepStrictEqual(payload, { tool: 'get_burn_status', error: 'nothing to report', notices: [NOTICE] })
    } finally { await stub.close() }
  })

  test('a non-tool diagnostics sub-command (batch) prints the held notices BEFORE it reaches the server', async () => {
    const seq: Seq = []
    let noticeAtFirstRequest: boolean | null = null
    const stub = await startMcpStub([], () => ({}),
      () => { if (noticeAtFirstRequest === null) noticeAtFirstRequest = indexOf(seq, 'err', NOTICE) >= 0 })
    try {
      const code = await inFixtureEnv(s.f(), { AGENTLENS_MCP_URL: stub.url }, () => captured(seq, () =>
        cliMain(['batch', '[]'], async () => undefined, { launchCheck: holdNotice })))
      assert.strictEqual(code, 0)
      assert.strictEqual(noticeAtFirstRequest, true, `batch must print the notice before it runs: ${JSON.stringify(seq)}`)
    } finally { await stub.close() }
  })

  test('a verb the switch handles prints the held notices BEFORE it runs (watch and the foreground server never return)', async () => {
    const seq: Seq = []
    const code = await inFixtureEnv(s.f(), {}, () => captured(seq, () => cliMain(['server', 'status'], async () => undefined, {
      launchCheck: holdNotice, serverCommand: async () => { console.log('SERVER VERB') }, serverStartCheck: async () => undefined,
    })))
    assert.strictEqual(code, 0)
    const iNote = indexOf(seq, 'err', NOTICE)
    assert.ok(iNote >= 0 && iNote < indexOf(seq, 'out', 'SERVER VERB'), JSON.stringify(seq))
  })

  test('a launch check that STOPS the verb prints its held lines, and the verb never runs', async () => {
    const seq: Seq = []
    let ran = false
    const code = await inFixtureEnv(s.f(), {}, () => captured(seq, () => cliMain(['server', 'status'], async () => undefined, {
      launchCheck: async () => { pushNotice('agentlenspro: BLOCKED by another telemetry setup'); return EXIT.CONFIG },
      serverCommand: async () => { ran = true }, serverStartCheck: async () => undefined,
    })))
    assert.strictEqual(code, EXIT.CONFIG)
    assert.strictEqual(ran, false)
    assert.ok(indexOf(seq, 'err', 'BLOCKED by another telemetry setup') >= 0, JSON.stringify(seq))
  })

  test('held lines never leak from an earlier in-process invocation into the next one', async () => {
    // An earlier invocation that never ended (an active buffer still holding a line): the reset must drop it.
    beginLaunchNotices()
    pushNotice('agentlenspro: LEFTOVER from an earlier call')
    const seq: Seq = []
    await inFixtureEnv(s.f(), {}, () => captured(seq, () => cliMain(['server', 'status'], async () => undefined, {
      launchCheck: async () => null, serverCommand: async () => undefined, serverStartCheck: async () => undefined,
    })))
    assert.strictEqual(indexOf(seq, 'err', 'LEFTOVER'), -1, JSON.stringify(seq))
  })

  // A caller of the launch check that is NOT inside a cliMain invocation has nobody to flush the buffer: its lines
  // must print at once, never wait in a buffer that vanishes with the process (review of 6a31062d).
  test('outside a cliMain invocation a notice prints at once; inside one it is held', () => {
    endLaunchNotices()
    const err: string[] = []
    const realWrite = process.stderr.write
    process.stderr.write = ((c: string | Uint8Array): boolean => { err.push(String(c)); return true }) as typeof process.stderr.write
    try {
      pushNotice('agentlenspro: OUTSIDE an invocation')
      assert.ok(err.some(t => t.includes('OUTSIDE an invocation')), 'a notice outside an invocation must print at once')
      beginLaunchNotices()
      pushNotice('agentlenspro: INSIDE an invocation')
      assert.ok(!err.some(t => t.includes('INSIDE an invocation')), 'a notice inside an invocation must be held')
      assert.deepStrictEqual(takeNotices(), ['agentlenspro: INSIDE an invocation'])
    } finally {
      process.stderr.write = realWrite
      endLaunchNotices()
    }
  })
  test('DISPATCHED_VERBS is exactly the set of case labels of the cliMain switch', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'cli', 'main.ts'), 'utf8')
    const labels = [...src.matchAll(/case '([^']+)':/g)].map(m => m[1])
    assert.deepStrictEqual([...new Set(labels)].sort(), [...DISPATCHED_VERBS].sort())
  })
})
suite('round 4 — shell-set pipelines, write ordering, read-only diagnostics', () => {
  const s = fixtureSuite(true)

  test('CLAUDECODE=1, key ABSENT from settings.json, shell exports a company endpoint: FOREIGN (never overwritten without the flag)', async () => {
    const fx = makeFx({ CLAUDECODE: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://corp.example/otlp' })
    try {
      await installAll(fx)
      const cfg = readSettings(fx)
      delete cfg.env!.OTEL_EXPORTER_OTLP_ENDPOINT
      writeSettings(fx, cfg)
      const bytes = fs.readFileSync(fx.settingsPath, 'utf8')
      assert.strictEqual(await maybeAutoSetup(['budget'], { ctx: fx.ctx, repair: recorder().repair, stderr: lines().say }), EXIT.CONFIG)
      assert.strictEqual(fs.readFileSync(fx.settingsPath, 'utf8'), bytes)
    } finally { fx.cleanup() }
  })

  test('CLAUDECODE=1, file holds OUR endpoint, env differs: STALE (warning, no disable) — the state right after --force-install-telemetry', async () => {
    const fx = makeFx({ CLAUDECODE: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://old.corp.example/otlp' })
    try {
      await installAll(fx)
      const l = lines()
      assert.strictEqual(await maybeAutoSetup(['budget'], { ctx: fx.ctx, repair: recorder().repair, stderr: l.say }), null)
      assert.ok(l.out.some(x => x.includes('stale session env')))
    } finally { fx.cleanup() }
  })

  test('foreign config + setup step / telemetry install / legacy --install-otel path: verdict first, settings.json byte-unchanged', async () => {
    const f = s.f()
    const cfg = readSettings(f)
    cfg.env!.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otel.corp.example/otlp'
    delete cfg.env!.OTEL_LOGS_EXPORT_INTERVAL
    writeSettings(f, cfg)
    const bytes = fs.readFileSync(f.settingsPath, 'utf8')
    const { result } = await REPAIR_STEPS['otel-env'].run({ ...f.ctx, forceInstall: false })
    assert.strictEqual(result.verify, 'FAIL')
    const opts = { settingsPath: f.settingsPath, markerPath: f.markerPath, dataDir: f.dataDir, managedSettingsPaths: [f.managedPath], processEnv: {} }
    // `telemetry install` and `--install-otel` both end in ensureTelemetryConfig, which computes the verdict before any op
    await assert.rejects(() => ensureTelemetryConfig(opts), /another telemetry setup/)
    assert.strictEqual(fs.readFileSync(f.settingsPath, 'utf8'), bytes)
    const src = fs.readFileSync(path.resolve(REPO_ROOT, 'src', 'cli', 'hookInstall.ts'), 'utf8')
    assert.ok(/installOtel[\s\S]*ensureTelemetryConfig\(common\)/.test(src), 'installOtel routes through ensureTelemetryConfig')
  })

  test('read-only diagnostics (cache-state, last-compact, model-headroom, statusline-history) skip the check and the DISABLED stop with a foreign config', async () => {
    const f = s.f()
    const cfg = readSettings(f)
    cfg.env!.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otel.corp.example/otlp'
    writeSettings(f, cfg)
    const bytes = fs.readFileSync(f.settingsPath, 'utf8')
    for (const verb of ['cache-state', 'last-compact', 'model-headroom', 'statusline-history']) {
      assert.strictEqual(await maybeAutoSetup([verb], { ctx: f.ctx, repair: recorder().repair, stderr: lines().say }), null, verb)
      assert.strictEqual(disabledNotice([verb]), null, verb)
    }
    assert.strictEqual(fs.readFileSync(f.settingsPath, 'utf8'), bytes)
    assert.ok(!agentlensDisabled())
    armKillSwitch('x')
    for (const verb of ['cache-state', 'last-compact', 'model-headroom', 'statusline-history']) assert.strictEqual(disabledNotice([verb]), null, verb)
  })
})

suite('round 5 — deploy gates', () => {
  const s = fixtureSuite(true)

  async function dryRun(f: Fx): Promise<{ exitCode: number; table: string }> {
    const out: string[] = []
    const o = await runSetup({
      dryRun: true, yes: true, home: f.home, dataDir: f.dataDir, settingsPath: f.settingsPath, skillsDir: f.skillsDir, agentsDir: f.agentsDir,
      repoRoot: REPO_ROOT, pathEnv: f.pathEnv, uiPort: await freePort(), mcpPort: await freePort(), otlpPort: await freePort(),
      telemetryProbe: { managedSettingsPaths: [f.managedPath], processEnv: {} }, log: l => { out.push(l) },
    })
    return { exitCode: o.exitCode, table: out.join('\n') + JSON.stringify(o.steps) }
  }
  const state = (f: Fx): string => {
    const st = fs.statSync(f.settingsPath)
    return `${crypto.createHash('sha256').update(fs.readFileSync(f.settingsPath)).digest('hex')}|${st.mtimeMs}|${fs.readdirSync(path.dirname(f.settingsPath)).sort().join(',')}|${SKILL_NAMES.filter(n => fs.existsSync(path.join(f.skillsDir, n, 'SKILL.md'))).length}|${agentlensDisabled()}`
  }

  for (const [name, mutate, want, wantExit] of [
    ['foreign config', (c: Settings) => { c.env!.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otel.corp.example/otlp' }, 'FOREIGN', 78],
    ['drifted-ours config', (c: Settings) => { delete c.env!.OTEL_LOGS_EXPORT_INTERVAL; c.env!.OTEL_LOG_USER_PROMPTS = '0' }, 'CONVERGE', 0],
  ] as const) {
    test(`setup --dry-run with a ${name}: exit ${wantExit}, verdict printed, settings bytes+mtime, backups, skills and kill-switch all unchanged`, async function () {
      this.timeout(60_000)
      const f = s.f()
      const cfg = readSettings(f)
      mutate(cfg)
      writeSettings(f, cfg)
      const before = state(f)
      await new Promise(r => setTimeout(r, 20))
      const r = await dryRun(f)
      assert.strictEqual(r.exitCode, wantExit)
      assert.ok(r.table.includes(want), `verdict ${want} missing`)
      assert.strictEqual(state(f), before)
    })
  }

  test('diagnostics while DISABLED spawn no server and exit cleanly', async function () {
    this.timeout(60_000)
    const f = s.f()
    armKillSwitch('x')
    const savedHome = process.env.HOME
    const savedNo = process.env.AGENTLENS_NO_AUTOSETUP
    process.env.HOME = f.home
    process.env.AGENTLENS_NO_AUTOSETUP = '1'
    const err = console.error, log = console.log
    console.error = quiet; console.log = quiet
    try {
      for (const argv of [['cache-state'], ['last-compact'], ['model-headroom', 'fable'], ['statusline-history', 'project']]) {
        const verb = argv[0]
        const code = await cliMain(argv, async () => undefined)
        assert.notStrictEqual(code, EXIT.DISABLED, `${verb} must not take the DISABLED stop`)
        assert.ok(!fs.existsSync(path.join(f.dataDir, 'server.pid')), `${verb} must not start a server`)
      }
    } finally {
      console.error = err; console.log = log
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome
      if (savedNo === undefined) delete process.env.AGENTLENS_NO_AUTOSETUP; else process.env.AGENTLENS_NO_AUTOSETUP = savedNo
    }
  })
})

suite('content-logging override warning', () => {
  const s = fixtureSuite(true)

  test('an explicit OTEL_LOG_USER_PROMPTS=0 is converged with a multi-line WARNING, exactly once', async () => {
    const f = s.f()
    const cfg = readSettings(f)
    cfg.env!.OTEL_LOG_USER_PROMPTS = '0'
    writeSettings(f, cfg)
    const l = lines()
    await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: recorder(['otel-env']).repair, stderr: l.say })
    const w = l.out.filter(x => x.includes('WARNING'))
    assert.strictEqual(w.length, 1)
    assert.ok(w[0].includes('OTEL_LOG_USER_PROMPTS') && w[0].includes('explicitly set to 0') && w[0].includes('agentlenspro disable') && w[0].split('\n').length >= 3, w[0])
    assert.strictEqual(readSettings(f).env!.OTEL_LOG_USER_PROMPTS, '1')
    const l2 = lines()
    await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: recorder(['otel-env']).repair, stderr: l2.say })
    assert.deepStrictEqual(l2.out, [], 'no warning on later launches')
  })

  test('already 1: no warning', async () => {
    const f = s.f()
    const l = lines()
    await maybeAutoSetup(['budget'], { ctx: f.ctx, repair: recorder(['otel-env']).repair, stderr: l.say })
    assert.ok(!l.out.some(x => x.includes('WARNING')))
  })
})

suite('ensureServer under DISABLED refuses without spawning', () => {
  fixtureSuite(false)

  test('throws the DISABLED refusal and starts no child: no server.pid, no alcore in the process table', async () => {
    armKillSwitch('x')
    await assert.rejects(() => ensureServer('test'), /DISABLED[\s\S]*refusing to start the server/)
    assert.ok(!fs.existsSync(path.join(process.env.AGENTLENS_DATA_DIR!, 'server.pid')))
    const snap = path.join(process.env.AGENTLENS_DATA_DIR!, 'ps.txt')
    cp.execSync(`ps -eo pid,command > ${JSON.stringify(snap)}`)
    assert.ok(!fs.readFileSync(snap, 'utf8').split('\n').some(l => l.includes(`--data-dir ${process.env.AGENTLENS_DATA_DIR}`)), 'no server was started on the isolated data dir')
  })
})

suite('setup --dry-run under Claude Code: stale snapshot vs shell-set pipeline', () => {
  async function dry(f: Fx): Promise<{ exitCode: number; text: string }> {
    const out: string[] = []
    const o = await runSetup({
      dryRun: true, yes: true, home: f.home, dataDir: f.dataDir, settingsPath: f.settingsPath, skillsDir: f.skillsDir, agentsDir: f.agentsDir,
      repoRoot: REPO_ROOT, pathEnv: f.pathEnv, uiPort: await freePort(), mcpPort: await freePort(), otlpPort: 4318,
      telemetryProbe: { managedSettingsPaths: [f.managedPath], processEnv: f.ctx.telemetryProbe.processEnv }, log: l => { out.push(l) },
    })
    return { exitCode: o.exitCode, text: out.join('\n') + JSON.stringify(o.steps) }
  }
  const snap = (f: Fx): string => `${fs.statSync(f.settingsPath).mtimeMs}|${fs.readFileSync(f.settingsPath, 'utf8')}|${fs.readdirSync(path.dirname(f.settingsPath)).sort().join(',')}`

  test('file holds OUR value, env (CLAUDECODE=1) differs: exit 0, STALE-ENV printed, nothing mutated', async function () {
    this.timeout(60_000)
    const f = makeFx({ CLAUDECODE: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://old.corp.example/otlp' })
    try {
      await installAll(f)
      const before = snap(f)
      const r = await dry(f)
      assert.strictEqual(r.exitCode, 0)
      assert.ok(r.text.includes('STALE-ENV'))
      assert.strictEqual(snap(f), before)
    } finally { f.cleanup() }
  })

  test('file LACKS the key, env (CLAUDECODE=1) carries a non-ours routing value: exit 78 (FOREIGN), nothing mutated', async function () {
    this.timeout(60_000)
    const f = makeFx({ CLAUDECODE: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://corp.example/otlp' })
    try {
      await installAll(f)
      const cfg = readSettings(f)
      delete cfg.env!.OTEL_EXPORTER_OTLP_ENDPOINT
      writeSettings(f, cfg)
      const before = snap(f)
      const r = await dry(f)
      assert.strictEqual(r.exitCode, 78)
      assert.ok(r.text.includes('FOREIGN'))
      assert.strictEqual(snap(f), before)
    } finally { f.cleanup() }
  })
})

suite('setup --json: one untruncated document, same exit codes, nothing mutated', () => {
  const s = fixtureSuite(true)
  async function js(f: Fx): Promise<{ exitCode: number; doc: { exitCode: number; steps: Array<{ step: string; detail?: string }>; telemetryVerdict: Array<{ key: string; verdict: string; fileValue: string | null; wouldWrite: string | null }>; hookDrift: Array<{ event: string; problem: string }> } }> {
    const o = await runSetup({
      dryRun: true, yes: true, json: true, home: f.home, dataDir: f.dataDir, settingsPath: f.settingsPath, skillsDir: f.skillsDir, agentsDir: f.agentsDir,
      repoRoot: REPO_ROOT, pathEnv: f.pathEnv, uiPort: await freePort(), mcpPort: await freePort(), otlpPort: 4318,
      telemetryProbe: { managedSettingsPaths: [f.managedPath], processEnv: {} },
    })
    return { exitCode: o.exitCode, doc: JSON.parse(JSON.stringify(o.json)) }
  }

  test('--dry-run --json on a foreign config: exit 78, FOREIGN key present, header value redacted, nothing mutated', async function () {
    this.timeout(60_000)
    const f = s.f()
    const cfg = readSettings(f)
    cfg.env!.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otel.corp.example/otlp'
    cfg.env!.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer SUPERSECRET'
    writeSettings(f, cfg)
    const before = fs.readFileSync(f.settingsPath, 'utf8')
    const r = await js(f)
    assert.strictEqual(r.exitCode, 78)
    assert.strictEqual(r.doc.exitCode, 78)
    assert.ok(r.doc.telemetryVerdict.some(k => k.key === 'OTEL_EXPORTER_OTLP_ENDPOINT' && k.verdict === 'FOREIGN'))
    assert.ok(!JSON.stringify(r.doc).includes('SUPERSECRET'))
    assert.strictEqual(fs.readFileSync(f.settingsPath, 'utf8'), before)
    assert.ok(r.doc.steps.every(x => x.step.length > 0))
  })

  test('--dry-run --json on drifted-ours: exit 0, CONVERGE keys listed with would-write, hook timeout drift listed in full', async function () {
    this.timeout(60_000)
    const f = s.f()
    const cfg = readSettings(f)
    cfg.env!.OTEL_LOG_USER_PROMPTS = '0'
    const hooks = cfg.hooks as Record<string, Array<{ hooks: Array<{ timeout?: number }> }>>
    for (const ev of Object.keys(hooks)) for (const m of hooks[ev]) for (const h of m.hooks) if (h.timeout !== undefined) h.timeout = 30
    writeSettings(f, cfg)
    const before = fs.readFileSync(f.settingsPath, 'utf8')
    const r = await js(f)
    assert.strictEqual(r.exitCode, 0)
    const row = r.doc.telemetryVerdict.find(k => k.key === 'OTEL_LOG_USER_PROMPTS')!
    assert.strictEqual(row.verdict, 'CONVERGE')
    assert.strictEqual(row.fileValue, '0')
    assert.strictEqual(row.wouldWrite, '1')
    assert.ok(r.doc.hookDrift.some(d => /timeout 30 → 120/.test(d.problem)), JSON.stringify(r.doc.hookDrift))
    assert.strictEqual(fs.readFileSync(f.settingsPath, 'utf8'), before)
  })
})
