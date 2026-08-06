import * as assert from 'assert'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  ensureTelemetryConfig,
  removeTelemetryConfig,
  telemetryConfigStatus,
  type TelemetryConfigOptions,
} from '../telemetryConfig'

// All tests run entirely against fixture files in a per-test temp dir — the real
// ~/.claude/settings.json is NEVER touched (TRDD-M36W16L0).

type Opts = Required<Pick<TelemetryConfigOptions, 'settingsPath' | 'markerPath' | 'bodiesDir' | 'otlpPort' | 'dataDir'>>
type Marker = { keys: Record<string, { hadKey: boolean; priorValue: string | null }> }

suite('telemetryConfig', () => {
  let dir: string
  let opts: Opts

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentlens-tel-'))
    opts = {
      settingsPath: path.join(dir, 'settings.json'),
      markerPath:   path.join(dir, 'telemetry-managed.json'),
      bodiesDir:    path.join(dir, 'otel-bodies'),
      otlpPort:     4318,
      // Pin the data dir at the tmp fixture: capture is resolved from <dataDir>/config.json, so
      // without this the suite would read the REAL ~/.agentlens/config.json and pass or fail
      // depending on whether the developer happens to have raw-body capture on (TRDD-BKF5NZD3).
      dataDir:      dir,
    }
  })

  teardown(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  async function writeSettings(obj: unknown): Promise<void> {
    await fs.writeFile(opts.settingsPath, JSON.stringify(obj, null, 2), 'utf-8')
  }
  async function readEnv(): Promise<Record<string, string> | undefined> {
    const raw = await fs.readFile(opts.settingsPath, 'utf-8')
    return (JSON.parse(raw) as { env?: Record<string, string> }).env
  }

  test('install then uninstall restores the env exactly (user keys + prior values preserved)', async () => {
    const original = {
      includeCoAuthoredBy: false,
      env: {
        ANTHROPIC_MODEL: 'opus',
        OTEL_TRACES_EXPORTER: 'console',   // user had a DIFFERENT value → must be restored
        CUSTOM_USER_KEY: 'keep-me',
      },
    }
    await writeSettings(original)

    const ins = await ensureTelemetryConfig(opts)
    assert.strictEqual(ins.changed, true)
    const envAfter = await readEnv()
    assert.strictEqual(envAfter?.OTEL_TRACES_EXPORTER, 'otlp')          // overridden to enable telemetry
    assert.strictEqual(envAfter?.CLAUDE_CODE_ENABLE_TELEMETRY, '1')     // added
    assert.strictEqual(envAfter?.CUSTOM_USER_KEY, 'keep-me')            // non-owned key untouched

    await removeTelemetryConfig(opts)
    const restored = await readEnv()
    assert.deepStrictEqual(restored, original.env)                      // structurally byte-identical
  })

  test('re-install is idempotent (no change the second time)', async () => {
    await writeSettings({ env: { X: '1' } })
    const first = await ensureTelemetryConfig(opts)
    assert.strictEqual(first.changed, true)

    const second = await ensureTelemetryConfig(opts)
    assert.strictEqual(second.changed, false)
    assert.deepStrictEqual(second.added, [])
    assert.deepStrictEqual(second.overrode, [])
  })

  test('records and restores a user value that differs from ours', async () => {
    await writeSettings({ env: { OTEL_LOG_USER_PROMPTS: '0' } })        // user opted OUT
    await ensureTelemetryConfig(opts)

    const marker = JSON.parse(await fs.readFile(opts.markerPath, 'utf-8')) as Marker
    assert.strictEqual(marker.keys.OTEL_LOG_USER_PROMPTS.hadKey, true)
    assert.strictEqual(marker.keys.OTEL_LOG_USER_PROMPTS.priorValue, '0')
    assert.strictEqual((await readEnv())?.OTEL_LOG_USER_PROMPTS, '1')   // we enabled it

    await removeTelemetryConfig(opts)
    assert.strictEqual((await readEnv())?.OTEL_LOG_USER_PROMPTS, '0')   // restored user's choice
  })

  test('creates settings.json when absent, then removes the env it created on uninstall', async () => {
    const ins = await ensureTelemetryConfig(opts)                       // no settings file exists yet
    assert.strictEqual(ins.changed, true)
    assert.strictEqual((await readEnv())?.CLAUDE_CODE_ENABLE_TELEMETRY, '1')

    await removeTelemetryConfig(opts)
    const raw = JSON.parse(await fs.readFile(opts.settingsPath, 'utf-8')) as { env?: unknown }
    assert.strictEqual(raw.env, undefined)                             // env we created is gone
  })

  test('fails fast on an unparseable settings.json and never clobbers it', async () => {
    const garbage = '{ this is not: valid json ,,,'
    await fs.writeFile(opts.settingsPath, garbage, 'utf-8')

    await assert.rejects(ensureTelemetryConfig(opts), /not valid JSON/)
    assert.strictEqual(await fs.readFile(opts.settingsPath, 'utf-8'), garbage)   // untouched
    await assert.rejects(fs.access(opts.markerPath))                             // no marker written
  })

  test('creates the raw-body export directory on install', async () => {
    await ensureTelemetryConfig(opts)
    assert.strictEqual((await fs.stat(opts.bodiesDir)).isDirectory(), true)
  })

  test('OTEL_LOG_RAW_API_BODIES points at the configured bodies dir — but ONLY when opted in', async () => {
    // CONTRACT CHANGE (TRDD-BKF5NZD3): raw-body capture used to be wired unconditionally, which made
    // it impossible to turn off — the server re-added the key on every boot while Claude Code dumped
    // the whole conversation to disk on every request (~35 GB/day). It is now opt-in.
    await ensureTelemetryConfig({ ...opts, captureRawBodies: false })
    assert.strictEqual((await readEnv())?.OTEL_LOG_RAW_API_BODIES, undefined, 'off by default')

    await ensureTelemetryConfig({ ...opts, captureRawBodies: true })
    assert.strictEqual((await readEnv())?.OTEL_LOG_RAW_API_BODIES, `file:${opts.bodiesDir}`)
  })

  test('capture OFF removes a key we wrote at the SPOOL dir, not just the legacy dir', async () => {
    // THE OUTAGE THIS PINS (2026-08-06): the delete guard compared the live key against
    // `file:${effectiveBodiesDir(dataDir, /*captureOn*/ false)}` — which ignores the spool by
    // construction. So the ordinary lifecycle (capture ON writes the SPOOL path → capture OFF
    // resolves the LEGACY path) left the key behind: Claude Code kept honouring it and kept
    // dumping bodies until the 2 GB RAM disk hit 100% full, at which point capture silently died
    // (332 zero-byte files). Meanwhile the DETECTOR tests PRESENCE, so `setup` reported drift,
    // "wired" it, verified, and FAILED — a repairer that could not repair, forever.
    // Both halves must agree on what "a key we wrote" means: legacy dir OR configured spool.
    const spoolDir = path.join(dir, 'spool-otel-bodies')
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ capture: { rawBodies: false, spoolDir } }, null, 2),
      'utf-8',
    )
    await writeSettings({ env: { OTEL_LOG_RAW_API_BODIES: `file:${spoolDir}` } })

    await ensureTelemetryConfig({ ...opts, captureRawBodies: false })

    assert.strictEqual(
      (await readEnv())?.OTEL_LOG_RAW_API_BODIES, undefined,
      'capture is off, so the spool key we wrote must be DELETED — leaving it is the ~35 GB/day burn',
    )
  })

  test('capture OFF leaves a raw-body key pointing somewhere we never wrote', async () => {
    // The counter-case that keeps the fix honest: widening the delete must not become
    // "delete any OTEL_LOG_RAW_API_BODIES". A user who points the sink at their OWN directory
    // made that choice deliberately; silently deleting a value we never wrote is overreach.
    const foreign = 'file:/somewhere/the/user/chose'
    await writeSettings({ env: { OTEL_LOG_RAW_API_BODIES: foreign } })

    await ensureTelemetryConfig({ ...opts, captureRawBodies: false })

    assert.strictEqual((await readEnv())?.OTEL_LOG_RAW_API_BODIES, foreign, 'not ours — leave it')
  })

  test('status reports managed / user / absent per key', async () => {
    await writeSettings({ env: { OTEL_TRACES_EXPORTER: 'console' } })

    const pre = await telemetryConfigStatus(opts)
    assert.strictEqual(pre.installed, false)
    assert.strictEqual(pre.keys.find(k => k.key === 'OTEL_TRACES_EXPORTER')?.status, 'user')
    assert.strictEqual(pre.keys.find(k => k.key === 'OTEL_LOGS_EXPORTER')?.status, 'absent')

    await ensureTelemetryConfig(opts)
    const post = await telemetryConfigStatus(opts)
    assert.strictEqual(post.installed, true)
    assert.ok(post.keys.every(k => k.status === 'managed'))
  })

  test('uninstall with nothing installed is a no-op', async () => {
    await writeSettings({ env: { X: '1' } })
    const r = await removeTelemetryConfig(opts)
    assert.strictEqual(r.changed, false)
    assert.deepStrictEqual(await readEnv(), { X: '1' })
  })
})
