// TRDD-RBBEX59R increment (b): while the operator's off switch is armed, setup / auto-repair / the spool migration
// must never write OTEL_LOG_RAW_API_BODIES back into settings.json — the disable verb strips it, and disabled mode
// stops raw-body collection (owner rule 2026-11-03). Every test runs against a temp HOME + DATA_DIR; the switch is
// armed by writing <tmpDataDir>/DISABLED directly (armKillSwitch has no dir parameter and would write the real one).
// No test starts a server: the enable case drives ensureInstalled with stubbed non-telemetry repairs.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Ctx, REPAIR_STEPS, SpoolMigrationDeps, otelDrift, rawBodiesOffFor, runSpoolMigration } from '../cli/setup'
import { ensureInstalled } from '../cli/autoSetup'
import { FOREIGN_REASON } from '../cli/killSwitch'
import { RAW_BODIES_KEY, effectiveBodiesDir } from '../captureConfig'
import { ensureTelemetryConfig, ownedTelemetryKeys, removeTelemetryConfig } from '../telemetryConfig'

const OTLP_PORT = 4318
const SPOOL_VALUE = 'file:/Volumes/AgentLensSpool/otel-bodies'

suite('raw-body key under the off switch (TRDD-RBBEX59R)', () => {
  let dir: string
  let ctx: Ctx
  let savedEnvHalf: string | undefined

  setup(() => {
    // The env half of the switch must not leak in from the shell running mocha: saved, deleted, restored.
    savedEnvHalf = process.env.AGENTLENS_DISABLED
    delete process.env.AGENTLENS_DISABLED
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-rawoff-'))
    const dataDir = path.join(dir, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    ctx = {
      dryRun: false, yes: true, forceInstall: false, telemetryProbe: { managedSettingsPaths: [], processEnv: {} },
      home: dir, dataDir, settingsPath: path.join(dir, 'settings.json'),
      skillsDir: path.join(dir, 'skills'), agentsDir: path.join(dir, 'agents'), repoRoot: dir,
      uiPort: 0, mcpPort: 0, otlpPort: OTLP_PORT, pathEnv: '', log: () => { /* quiet */ }, serverPid: null,
    }
  })
  teardown(() => {
    if (savedEnvHalf === undefined) delete process.env.AGENTLENS_DISABLED
    else process.env.AGENTLENS_DISABLED = savedEnvHalf
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
  const runOtel = (c: Ctx = ctx) => REPAIR_STEPS['otel-env'].run(c)

  test('setup otel step under the switch writes every telemetry key except the raw-body key; without it, writes it as today', async () => {
    arm()
    const armed = await runOtel()
    assert.strictEqual(armed.result.verify, 'PASS', armed.result.detail)
    const env = envOf()
    assert.ok(!(RAW_BODIES_KEY in env), 'raw-body key must stay absent under the switch')
    const expected = ownedTelemetryKeys(effectiveBodiesDir(ctx.dataDir), OTLP_PORT)
    for (const [k, v] of Object.entries(expected)) if (k !== RAW_BODIES_KEY) assert.strictEqual(env[k], v, k)
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

  test('the enable trigger converges before the lift and writes the raw-body key back; the env half still keeps it absent', async () => {
    arm()
    const deps = {
      ctx, stderr: () => { /* quiet */ },
      // Only the telemetry step runs for real (with the ctx ensureInstalled built); nothing can start a server.
      repair: async (step: keyof typeof REPAIR_STEPS, c: Ctx) => step === 'otel-env'
        ? { ok: (await REPAIR_STEPS[step].run(c)).result.verify === 'PASS', detail: 'otel' }
        : { ok: true, detail: 'stubbed' },
      fullSetup: async () => { throw new Error('full setup must not run') },
    }
    assert.strictEqual(await ensureInstalled('enable', 'enable', deps), null)
    assert.strictEqual(envOf()[RAW_BODIES_KEY], ours())
    disarm() // what the enable verb does next: the converged state needs no further write
    const after = otelDrift(ctx)
    assert.ok(after !== 'unparseable' && after.converged)

    fs.rmSync(ctx.settingsPath)
    process.env.AGENTLENS_DISABLED = '1' // env half: deleting the file cannot lift it, so the key stays absent
    assert.strictEqual(await ensureInstalled('enable', 'enable', deps), null)
    assert.ok(!(RAW_BODIES_KEY in envOf()))
  })

  test('a FOREIGN-armed switch does not hold the key absent (the converging run lifts it)', async () => {
    arm(FOREIGN_REASON)
    assert.strictEqual(rawBodiesOffFor(ctx), false)
    const r = await runOtel()
    assert.strictEqual(r.result.verify, 'PASS', r.result.detail)
    assert.strictEqual(envOf()[RAW_BODIES_KEY], ours())
  })

  test('spool migration ACT 3 removes a spool-pointing raw-body key under the switch, re-points it without', async () => {
    const deps: SpoolMigrationDeps = {
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
    const armed = await runSpoolMigration(ctx, deps)
    assert.strictEqual(armed.result.verify, 'PASS', armed.result.detail)
    assert.ok(armed.result.action.includes('removed the raw-body key'), armed.result.action)
    assert.deepStrictEqual(envOf(), { KEEP_ME: 'x' })

    disarm()
    writeEnv({ [RAW_BODIES_KEY]: SPOOL_VALUE, KEEP_ME: 'x' })
    const free = await runSpoolMigration(ctx, deps)
    assert.strictEqual(free.result.verify, 'PASS', free.result.detail)
    assert.deepStrictEqual(envOf(), { [RAW_BODIES_KEY]: ours(), KEEP_ME: 'x' })
  })
})
