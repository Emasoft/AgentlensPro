// TRDD-RBBEX59R increment (b): while ANY half of the off switch is armed (whatever the recorded reason), setup /
// auto-repair / the spool migration / the forced install must never write OTEL_LOG_RAW_API_BODIES into settings.json —
// the disable verb strips it, and disabled mode stops raw-body collection (owner rule 2026-11-03). Every lift (enable,
// both foreign lifts, the forced install) is followed by one telemetry converge, so the key comes back in that run.
// Every test runs against a temp HOME + data dir; AGENTLENS_DATA_DIR points at it, so the default-dir helpers the enable
// verb uses (agentlensDisabled(), enableAgentlensSurfaces()) and ctx.dataDir name the SAME flag. No test starts a
// server: ensureInstalled runs with stubbed non-telemetry repairs.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Ctx, REPAIR_STEPS, SpoolMigrationDeps, otelDrift, runSpoolMigration } from '../cli/setup'
import { AutoSetupDeps, ensureInstalled, forceInstallTelemetry } from '../cli/autoSetup'
import { runEnableCli, type EnableRestartDeps } from '../cli/disableCli'
import { FOREIGN_REASON } from '../cli/foreignTelemetry'
import { agentlensDisabled, overrideKillSwitchEnv } from '../cli/killSwitch'
import { EXIT } from '../cli/cliErrors'
import { RAW_BODIES_KEY, effectiveBodiesDir } from '../captureConfig'
import { ensureTelemetryConfig, ownedTelemetryKeys, removeTelemetryConfig } from '../telemetryConfig'

const OTLP_PORT = 4318
const SPOOL_VALUE = 'file:/Volumes/AgentLensSpool/otel-bodies'
const ENV_KEYS = ['AGENTLENS_DISABLED', 'AGENTLENS_DATA_DIR', 'HOME'] as const

suite('raw-body key under the off switch (TRDD-RBBEX59R)', () => {
  let dir: string
  let ctx: Ctx
  let saved: Record<string, string | undefined>

  setup(() => {
    // The env half of the switch must not leak in from the shell running mocha; the data dir and HOME are pinned to
    // the temp dir so the enable verb's default-dir helpers act on this test's flag. All saved and restored.
    saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
    delete process.env.AGENTLENS_DISABLED
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-rawoff-'))
    const dataDir = path.join(dir, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    process.env.AGENTLENS_DATA_DIR = dataDir
    process.env.HOME = dir
    ctx = {
      dryRun: false, yes: true, forceInstall: false, telemetryProbe: { managedSettingsPaths: [], processEnv: {} },
      home: dir, dataDir, settingsPath: path.join(dir, 'settings.json'),
      skillsDir: path.join(dir, 'skills'), agentsDir: path.join(dir, 'agents'), repoRoot: dir,
      uiPort: 0, mcpPort: 0, otlpPort: OTLP_PORT, pathEnv: '', log: () => { /* quiet */ }, serverPid: null,
    }
  })
  teardown(() => {
    overrideKillSwitchEnv(false) // module-level state: a forced-install test must not leak it into later tests
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const flag = (): string => path.join(ctx.dataDir, 'DISABLED')
  const arm = (reason = 'operator test'): void => { fs.writeFileSync(flag(), `AgentlensPro is DISABLED.\nReason: ${reason}\n`) }
  const disarm = (): void => { fs.rmSync(flag(), { force: true }) }
  const envOf = (): Record<string, string> => (JSON.parse(fs.readFileSync(ctx.settingsPath, 'utf8')) as { env?: Record<string, string> }).env ?? {}
  const writeEnv = (env: Record<string, string>): void => { fs.writeFileSync(ctx.settingsPath, JSON.stringify({ env }, null, 2)) }
  const markerPath = (): string => path.join(ctx.dataDir, 'telemetry-managed.json')
  const marker = (): { keys: Record<string, { hadKey: boolean; priorValue: string | null }>; written?: Record<string, string[]> } =>
    JSON.parse(fs.readFileSync(markerPath(), 'utf8'))
  const ours = (): string => `file:${effectiveBodiesDir(ctx.dataDir)}`
  const expected = (): Record<string, string> => ownedTelemetryKeys(effectiveBodiesDir(ctx.dataDir), OTLP_PORT)
  const runOtel = (c: Ctx = ctx) => REPAIR_STEPS['otel-env'].run(c)
  // Only the telemetry step runs for real (with the ctx ensureInstalled built); nothing can start a server.
  const deps = (stderr: string[] = []): AutoSetupDeps => ({
    ctx, stderr: (line: string) => { stderr.push(line) },
    repair: async (step, c) => step === 'otel-env'
      ? { ok: (await REPAIR_STEPS[step].run(c)).result.verify === 'PASS', detail: 'otel' }
      : { ok: true, detail: 'stubbed' },
    fullSetup: async () => { throw new Error('full setup must not run') },
  })
  /** runEnableCli prints its summary with console.log; keep the test output clean. */
  const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
    const log = console.log
    console.log = (): void => { /* quiet */ }
    try { return await fn() } finally { console.log = log }
  }

  test('setup otel step under the switch writes every telemetry key except the raw-body key; without it, writes it as today', async () => {
    arm()
    const armed = await runOtel()
    assert.strictEqual(armed.result.verify, 'PASS', armed.result.detail)
    const env = envOf()
    assert.ok(!(RAW_BODIES_KEY in env), 'raw-body key must stay absent under the switch')
    for (const [k, v] of Object.entries(expected())) if (k !== RAW_BODIES_KEY) assert.strictEqual(env[k], v, k)
    // Marker: the key stays OWNED (prior state recorded for uninstall), but nothing was written for it.
    assert.deepStrictEqual(marker().keys[RAW_BODIES_KEY], { hadKey: false, priorValue: null })
    assert.strictEqual(marker().written?.[RAW_BODIES_KEY], undefined)

    disarm() // same process, only the temp flag toggled: the same step now converges the key as today
    const free = await runOtel()
    assert.strictEqual(free.result.verify, 'PASS', free.result.detail)
    assert.strictEqual(envOf()[RAW_BODIES_KEY], ours())
    assert.deepStrictEqual(marker().written?.[RAW_BODIES_KEY], [ours()])
  })

  test('repair under the switch removes a raw-body key of ours, keeps the marker consistent, and uninstall leaves it absent', async () => {
    await runOtel() // enabled install: key written, marker records it
    assert.strictEqual(envOf()[RAW_BODIES_KEY], ours())
    const before = marker()
    arm()
    const drift = otelDrift(ctx)
    assert.ok(drift !== 'unparseable')
    assert.strictEqual(drift.converged, false, 'a present raw-body key under the switch is drift')
    assert.deepStrictEqual(drift.converge, [RAW_BODIES_KEY])
    const r = await runOtel()
    assert.strictEqual(r.result.verify, 'PASS', r.result.detail)
    assert.ok(!(RAW_BODIES_KEY in envOf()))
    assert.deepStrictEqual(marker().keys, before.keys, 'prior-state records untouched')
    assert.deepStrictEqual(marker().written, before.written, 'ownership evidence untouched: nothing new was written')
    const again = otelDrift(ctx)
    assert.ok(again !== 'unparseable' && again.converged, 'converged after the removal')

    // A leftover key (a session re-wrote settings by hand) is still OURS for uninstall, which removes it.
    writeEnv({ ...envOf(), [RAW_BODIES_KEY]: ours() })
    await removeTelemetryConfig({ settingsPath: ctx.settingsPath, markerPath: markerPath(), dataDir: ctx.dataDir })
    assert.ok(!(RAW_BODIES_KEY in envOf()))
    assert.ok(!fs.existsSync(markerPath()))
  })

  test('dry-run verdict under the switch reports no raw-body write', async () => {
    arm()
    const drift = otelDrift(ctx)
    assert.ok(drift !== 'unparseable')
    const row = drift.rows.find(x => x.scope === 'user' && x.key === RAW_BODIES_KEY)
    assert.ok(row)
    assert.strictEqual(row.state, 'OURS')
    assert.ok(!/will be written/.test(row.detail), row.detail)
    const dry = await runOtel({ ...ctx, dryRun: true })
    const line = (dry.result.detail ?? '').split('\n').find(l => l.includes(RAW_BODIES_KEY)) ?? ''
    assert.ok(line.includes('OURS') && !line.includes('will be written'), line)
    assert.ok(!fs.existsSync(ctx.settingsPath), 'dry-run wrote nothing')
  })

  test('the choke point: ensureTelemetryConfig with only a dataDir reads that dir switch and never writes the key', async () => {
    arm()
    const opts = { settingsPath: ctx.settingsPath, markerPath: markerPath(), dataDir: ctx.dataDir, otlpPort: OTLP_PORT, managedSettingsPaths: [], processEnv: {} }
    await ensureTelemetryConfig(opts)
    assert.ok(!(RAW_BODIES_KEY in envOf()))
    disarm()
    await ensureTelemetryConfig(opts)
    assert.strictEqual(envOf()[RAW_BODIES_KEY], ours())
  })

  test('the enable verb: the converge before the lift removes the key and says so, the converge after it writes it back', async () => {
    await runOtel() // enabled install, key present
    arm()
    const lines: string[] = []
    assert.strictEqual(await quietly(() => runEnableCli(false, deps(lines))), EXIT.OK)
    assert.ok(!fs.existsSync(flag()), 'flag lifted')
    assert.strictEqual(envOf()[RAW_BODIES_KEY], ours(), 'key written back in the same run')
    // R5: the pre-lift converge REMOVED the key; the line must say so, not "converged".
    assert.ok(lines.includes(`agentlenspro: removed ${RAW_BODIES_KEY} (off switch armed)`), lines.join('|'))
    const after = otelDrift(ctx)
    assert.ok(after !== 'unparseable' && after.converged)
  })

  test('the enable verb under the env half lifts the flag file but keeps the key absent', async () => {
    arm()
    process.env.AGENTLENS_DISABLED = '1' // env half: deleting the file cannot lift it
    assert.strictEqual(await quietly(() => runEnableCli(false, deps())), EXIT.UNKNOWN)
    assert.ok(!fs.existsSync(flag()), 'flag file removed')
    assert.ok(!(RAW_BODIES_KEY in envOf()), 'raw-body key stays absent while AGENTLENS_DISABLED=1')
  })

  test('the enable verb under the env half says it cannot lift it, and does not restart a no-collection server (TRDD-RBBEX59R c2)', async () => {
    arm()
    process.env.AGENTLENS_DISABLED = '1'
    const out: string[] = []
    const log = console.log
    console.log = (...a: unknown[]): void => { out.push(a.join(' ')) }
    const never = async (): Promise<void> => { throw new Error('must not restart under the env half') }
    let code: number
    try {
      code = await runEnableCli(false, deps(), {
        fetchStats: async () => ({ pid: 4242, dataDir: ctx.dataDir, collection: 'off', startedBy: 'server start' }),
        stopServer: never, ensureServer: never,
      })
    } finally { console.log = log }
    assert.strictEqual(code, EXIT.UNKNOWN)
    const text = out.join('\n')
    assert.match(text, /AGENTLENS_DISABLED=1 is set/)
    assert.match(text, /pid 4242 stays in no-collection mode — not restarted, since the enable verb cannot lift the env half/)
  })

  // Round 2, A: no early return on "already enabled" — a re-run still reads the server and restarts an "off" one, which
  // is what makes every "re-run `agentlenspro enable`" remedy true. The rig answers "off" for this dir on every read.
  const restartRig = (stopFails: () => boolean): { ran: string[]; out: string[]; deps: EnableRestartDeps } => {
    const ran: string[] = []
    const out: string[] = []
    return {
      ran, out,
      deps: {
        fetchStats: async () => ({ pid: 4242, dataDir: ctx.dataDir, collection: 'off', startedBy: 'server start' }),
        stopServer: async () => { ran.push('stop'); if (stopFails()) throw new Error('server (pid 4242) is still running 15s after SIGTERM') },
        ensureServer: async () => { ran.push('ensure') },
        say: (l: string) => { out.push(l) },
      },
    }
  }
  const captured = async (fn: () => Promise<number>): Promise<{ code: number; text: string }> => {
    const out: string[] = []
    const log = console.log
    console.log = (...a: unknown[]): void => { out.push(a.join(' ')) }
    try { const code = await fn(); return { code, text: out.join('\n') } } finally { console.log = log }
  }

  test('enable twice: a failed stop leaves the server off; the second run (no flag left) restarts it (TRDD-RBBEX59R c2 round 2)', async () => {
    arm()
    let fail = true
    const r = restartRig(() => fail)
    const first = await captured(() => runEnableCli(false, deps(), r.deps))
    assert.strictEqual(first.code, EXIT.ABORT)
    assert.ok(!fs.existsSync(flag()), 'the first run lifted the flag')
    assert.match(r.out.join('\n'), /re-run|server restart/)
    assert.deepStrictEqual(r.ran, ['stop'], 'nothing started after the failed stop')
    fail = false
    r.ran.length = 0
    const second = await captured(() => runEnableCli(false, deps(), r.deps))
    assert.strictEqual(second.code, EXIT.OK, r.out.join('\n'))
    assert.match(second.text, /already enabled/)
    assert.deepStrictEqual(r.ran, ['stop', 'ensure'], 'the re-run restarts the server that still reports "off"')
  })

  test('a re-run after the env half is unset restarts the no-collection server (TRDD-RBBEX59R c2 round 2)', async () => {
    arm()
    process.env.AGENTLENS_DISABLED = '1'
    const r = restartRig(() => false)
    assert.strictEqual((await captured(() => runEnableCli(false, deps(), r.deps))).code, EXIT.UNKNOWN)
    assert.deepStrictEqual(r.ran, [], 'not restarted under the env half')
    delete process.env.AGENTLENS_DISABLED
    const again = await captured(() => runEnableCli(false, deps(), r.deps))
    assert.strictEqual(again.code, EXIT.OK, r.out.join('\n'))
    assert.deepStrictEqual(r.ran, ['stop', 'ensure'])
  })

  test('under the --force-install-telemetry override the env half does not count: enable restarts the server (TRDD-RBBEX59R c2 round 2, D)', async () => {
    arm()
    process.env.AGENTLENS_DISABLED = '1'
    overrideKillSwitchEnv(true) // what forceInstallTelemetry sets for its own invocation; teardown resets it
    const r = restartRig(() => false)
    const run = await captured(() => runEnableCli(false, deps(), r.deps))
    assert.strictEqual(run.code, EXIT.OK, run.text + r.out.join('\n'))
    assert.doesNotMatch(run.text, /AGENTLENS_DISABLED=1 is set/)
    assert.deepStrictEqual(r.ran, ['stop', 'ensure'])
  })

  test('a FOREIGN-armed switch holds the key absent too; the setup step lifts it and converges once more', async () => {
    arm(FOREIGN_REASON)
    const r = await runOtel()
    assert.strictEqual(r.result.verify, 'PASS', r.result.detail)
    assert.ok(!fs.existsSync(flag()), 'foreign flag lifted')
    assert.strictEqual(envOf().OTEL_EXPORTER_OTLP_ENDPOINT, expected().OTEL_EXPORTER_OTLP_ENDPOINT, 'endpoint is ours')
    assert.strictEqual(envOf()[RAW_BODIES_KEY], ours(), 'key written by the converge after the lift')
  })

  test('a foreign lift for ctx removes ctx.dataDir flag, never the env-default dir operator flag', async () => {
    // TRDD-RBBEX59R: the check (enableIfForeign on dirs.dataDir) and the removal (disarmKillSwitch) must hit the SAME file.
    // Dir A is the env default and holds an OPERATOR flag; ctx's own data dir B holds a FOREIGN flag; no foreign config.
    const a = path.join(dir, 'env-default-data')
    fs.mkdirSync(a, { recursive: true })
    process.env.AGENTLENS_DATA_DIR = a
    const aFlag = path.join(a, 'DISABLED')
    fs.writeFileSync(aFlag, 'AgentlensPro is DISABLED.\nReason: operator test\n')
    const aBytes = fs.readFileSync(aFlag)
    arm(FOREIGN_REASON) // ctx.dataDir (B)
    const r = await runOtel()
    assert.strictEqual(r.result.verify, 'PASS', r.result.detail)
    assert.ok(!fs.existsSync(flag()), 'B foreign flag lifted')
    assert.ok(fs.existsSync(aFlag), 'A operator flag still present')
    assert.ok(fs.readFileSync(aFlag).equals(aBytes), 'A operator flag byte-identical')
    assert.strictEqual(envOf()[RAW_BODIES_KEY], ours(), 'raw-body key written for B')
  })

  test('a launch that lifts a FOREIGN switch (telemetry otherwise current) converges once more and writes the key', async () => {
    const { [RAW_BODIES_KEY]: _raw, ...rest } = expected()
    void _raw
    writeEnv(rest)
    arm(FOREIGN_REASON)
    const pre = otelDrift(ctx)
    assert.ok(pre !== 'unparseable' && pre.converged, 'under the switch an absent key is converged: no otel repair before the lift')
    const lines: string[] = []
    assert.strictEqual(await ensureInstalled('launch', 'budget', deps(lines)), null)
    assert.ok(!fs.existsSync(flag()), 'foreign flag lifted')
    assert.strictEqual(envOf().OTEL_EXPORTER_OTLP_ENDPOINT, expected().OTEL_EXPORTER_OTLP_ENDPOINT, 'endpoint is ours')
    assert.strictEqual(envOf()[RAW_BODIES_KEY], ours(), lines.join('|'))
  })

  test('round trip: a prior value of ours, install under the switch, enable, re-converge, uninstall restores the prior value', async () => {
    writeEnv({ [RAW_BODIES_KEY]: SPOOL_VALUE, KEEP_ME: 'x' }) // the legacy spool value: owned by value, not by marker
    arm() // armed FIRST, then the first install (R3)
    const drift = otelDrift(ctx)
    assert.ok(drift !== 'unparseable')
    // R2: an owned value under the switch reads "will be removed" — never a write text, never FOREIGN.
    const row = drift.rows.find(x => x.scope === 'user' && x.key === RAW_BODIES_KEY)
    assert.ok(row && row.state === 'CONVERGE' && row.detail.includes('will be removed') && !row.detail.includes('wants'), JSON.stringify(row))
    const first = await runOtel()
    assert.strictEqual(first.result.verify, 'PASS', first.result.detail)
    assert.ok(!(RAW_BODIES_KEY in envOf()))
    assert.deepStrictEqual(marker().keys[RAW_BODIES_KEY], { hadKey: true, priorValue: SPOOL_VALUE })

    assert.strictEqual(await quietly(() => runEnableCli(false, deps())), EXIT.OK)
    assert.strictEqual(envOf()[RAW_BODIES_KEY], ours())
    const second = await runOtel()
    assert.strictEqual(second.result.verify, 'PASS', second.result.detail)
    assert.deepStrictEqual(marker().keys[RAW_BODIES_KEY], { hadKey: true, priorValue: SPOOL_VALUE }, 'prior state recorded once, never overwritten')

    await removeTelemetryConfig({ settingsPath: ctx.settingsPath, markerPath: markerPath(), dataDir: ctx.dataDir })
    assert.deepStrictEqual(envOf(), { [RAW_BODIES_KEY]: SPOOL_VALUE, KEEP_ME: 'x' })
  })

  test('first install under the switch with every other key already equal still records the raw-body prior state (R3)', async () => {
    const { [RAW_BODIES_KEY]: _raw, ...rest } = expected()
    void _raw
    writeEnv(rest)
    const bytes = fs.readFileSync(ctx.settingsPath, 'utf8')
    arm()
    const r = await ensureTelemetryConfig({ settingsPath: ctx.settingsPath, markerPath: markerPath(), dataDir: ctx.dataDir, otlpPort: OTLP_PORT, managedSettingsPaths: [], processEnv: {} })
    assert.strictEqual(r.changed, false)
    assert.strictEqual(fs.readFileSync(ctx.settingsPath, 'utf8'), bytes, 'settings untouched')
    assert.deepStrictEqual(marker().keys[RAW_BODIES_KEY], { hadKey: false, priorValue: null })
  })

  // R4, as changed by TRDD-RBBEX59R d2 (D17). The force install lifts ONLY a switch armed for the foreign setup it overwrites, and
  // the key is written by the converge that follows that lift. An operator switch is not undone by it. (The env half holding the key
  // absent against the override is B13; its discriminating test is in autoSetup.test.ts, because the file half here already holds the key.)
  test('--force-install-telemetry over a FOREIGN-armed flag lifts it and writes the key (R4)', async () => {
    arm(FOREIGN_REASON)
    assert.strictEqual(await forceInstallTelemetry('budget', deps()), null)
    assert.ok(!fs.existsSync(flag()), 'flag lifted')
    assert.strictEqual(envOf()[RAW_BODIES_KEY], ours())
  })

  test('--force-install-telemetry under AGENTLENS_DISABLED=1 and an armed OPERATOR flag: the flag stays and the key stays absent (D17)', async () => {
    arm() // reason "operator test"
    process.env.AGENTLENS_DISABLED = '1'
    assert.strictEqual(await forceInstallTelemetry('budget', deps()), null)
    assert.ok(fs.existsSync(flag()), 'an operator disable is not undone by a force install')
    assert.strictEqual(agentlensDisabled(ctx.dataDir), true, 'the file half still stands')
    assert.ok(!(RAW_BODIES_KEY in envOf()), 'the key is collection: absent while either half stands')
  })

  test('spool migration ACT 3 removes a spool-pointing raw-body key under the switch, re-points it without', async () => {
    const spoolDeps: SpoolMigrationDeps = {
      volumeMounted: () => false,
      detachVolume: () => { throw new Error('no volume') },
      drain: async () => { throw new Error('no drain') },
      alstoreBin: () => null,
      bootoutAgent: () => { /* none */ },
      plistPath: () => path.join(dir, 'absent.plist'),
      listSpoolBodies: () => [],
    }
    writeEnv({ [RAW_BODIES_KEY]: SPOOL_VALUE, KEEP_ME: 'x' })
    arm()
    const armed = await runSpoolMigration(ctx, spoolDeps)
    assert.strictEqual(armed.result.verify, 'PASS', armed.result.detail)
    assert.ok(armed.result.action.includes('removed the raw-body key'), armed.result.action)
    assert.deepStrictEqual(envOf(), { KEEP_ME: 'x' })

    disarm()
    writeEnv({ [RAW_BODIES_KEY]: SPOOL_VALUE, KEEP_ME: 'x' })
    const free = await runSpoolMigration(ctx, spoolDeps)
    assert.strictEqual(free.result.verify, 'PASS', free.result.detail)
    assert.deepStrictEqual(envOf(), { [RAW_BODIES_KEY]: ours(), KEEP_ME: 'x' })
  })
})
