// Raw-body capture is MANDATORY (owner reversal 2026-10-02 of TRDD-BKF5NZD3, under TRDD-AGZ0XZKW):
// "raw body dumps is not an optin, its mandatory". There is no knob, no env override and no delete
// path any more — OTEL_LOG_RAW_API_BODIES is a plain owned telemetry key, converged on install and on
// every CLI launch. These tests pin that, plus the single bodies-dir resolution and the reader scope.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { RAW_BODIES_KEY, effectiveBodiesDir, resolveBodiesReadScope } from '../captureConfig'
import { TelemetryConflictError, ensureTelemetryConfig, ownedTelemetryKeys, removeTelemetryConfig } from '../telemetryConfig'

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-capture-'))
}

/** A settings.json + the telemetryConfig options pointing at it. Never touches the real ~/.claude, and pins
 *  the managed-settings paths and the process env so a developer's own OTEL_* exports cannot leak in. */
function fixture(): { dir: string; settingsPath: string; markerPath: string; bodiesDir: string; opts: Record<string, unknown> } {
  const dir = tmp()
  const settingsPath = path.join(dir, 'settings.json')
  const markerPath = path.join(dir, 'telemetry-managed.json')
  const bodiesDir = path.join(dir, 'otel-bodies')
  return {
    dir, settingsPath, markerPath, bodiesDir,
    opts: { settingsPath, markerPath, bodiesDir, dataDir: dir, otlpPort: 4318, managedSettingsPaths: [], processEnv: {} },
  }
}

function envOf(settingsPath: string): Record<string, string> {
  const s = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as { env?: Record<string, string> }
  return s.env ?? {}
}

suite('raw-body capture is mandatory — the key is always owned and always converged', () => {
  test('a plain install writes the key, pointing at the bodies dir', async () => {
    const f = fixture()
    await ensureTelemetryConfig(f.opts)
    assert.strictEqual(envOf(f.settingsPath)[RAW_BODIES_KEY], `file:${f.bodiesDir}`)
  })

  test('a key that went missing is RESTORED by the next converge (the per-launch repair path)', async () => {
    const f = fixture()
    await ensureTelemetryConfig(f.opts)
    const s = JSON.parse(fs.readFileSync(f.settingsPath, 'utf-8')) as { env: Record<string, string> }
    delete s.env[RAW_BODIES_KEY]
    fs.writeFileSync(f.settingsPath, JSON.stringify(s, null, 2))
    const r = await ensureTelemetryConfig(f.opts)
    assert.strictEqual(r.changed, true)
    assert.strictEqual(envOf(f.settingsPath)[RAW_BODIES_KEY], `file:${f.bodiesDir}`)
  })

  test('a key pointing at a DIFFERENT dir is another pipeline: refused, nothing written (never silently re-pointed)', async () => {
    const f = fixture()
    fs.writeFileSync(f.settingsPath, JSON.stringify({ env: { [RAW_BODIES_KEY]: 'file:/my/own/dir', USER_KEY: 'kept' } }, null, 2))
    const before = fs.readFileSync(f.settingsPath, 'utf-8')
    await assert.rejects(ensureTelemetryConfig(f.opts), TelemetryConflictError)
    assert.strictEqual(fs.readFileSync(f.settingsPath, 'utf-8'), before)
  })

  test('a repeated converge is idempotent — no change, key still present', async () => {
    const f = fixture()
    await ensureTelemetryConfig(f.opts)
    const again = await ensureTelemetryConfig(f.opts)
    assert.strictEqual(again.changed, false)
    assert.strictEqual(envOf(f.settingsPath)[RAW_BODIES_KEY], `file:${f.bodiesDir}`)
  })

  test('uninstall restores the PRIOR state of the key like every other owned key (there is no capture-off state)', async () => {
    const f = fixture()
    await ensureTelemetryConfig(f.opts)
    await removeTelemetryConfig(f.opts)
    assert.ok(!(RAW_BODIES_KEY in envOf(f.settingsPath)))
  })

  test('ownedTelemetryKeys always carries the key (setup VERIFY demands exactly what ensure writes)', () => {
    assert.strictEqual(ownedTelemetryKeys('/b', 4318)[RAW_BODIES_KEY], 'file:/b')
  })
})

// The single-writer contract (TRDD-Z53IJFE9): the RAM-disk spool is REMOVED, so the bodies dir is
// always the SSD dir under the data dir. There is ONE resolution of the bodies dir
// (effectiveBodiesDir), and every writer of ensureTelemetryConfig must converge the SAME value.
suite('effectiveBodiesDir — the one bodies-dir resolution (TRDD-Z53IJFE9)', () => {
  test('the SSD dir under the data dir', () => {
    const dir = tmp()
    assert.strictEqual(effectiveBodiesDir(dir), path.join(dir, 'otel-bodies'))
  })

  test('a BLIND converge (the server-boot shape) writes that SSD value', async () => {
    const f = fixture()
    const { bodiesDir: _omit, ...blind } = f.opts as { bodiesDir: string } & Record<string, unknown>
    await ensureTelemetryConfig(blind)
    assert.strictEqual(envOf(f.settingsPath)[RAW_BODIES_KEY], `file:${path.join(f.dir, 'otel-bodies')}`)
  })
})

// The READER's counterpart (TRDD-8N3KQW2R). effectiveBodiesDir answers "where should Claude Code
// WRITE" — a single answer. A reader needs to know which dirs exist and which are missing, so it can
// say WHY it is blind instead of reporting an empty window as an empty world.
suite('resolveBodiesReadScope — where a READER looks (TRDD-8N3KQW2R)', () => {
  test('an existing bodies dir is the one scanned dir', () => {
    const dir = tmp()
    fs.mkdirSync(path.join(dir, 'otel-bodies'), { recursive: true })
    const s = resolveBodiesReadScope(dir)
    assert.deepStrictEqual(s.dirs, [path.join(dir, 'otel-bodies')])
    assert.deepStrictEqual(s.missing, [])
    assert.strictEqual(s.spoolConfigured, false)
  })

  test('a body dir that does not exist is reported missing, not silently skipped', () => {
    const dir = tmp()
    const s = resolveBodiesReadScope(dir)
    assert.deepStrictEqual(s.dirs, [])
    assert.deepStrictEqual(s.missing, [path.join(dir, 'otel-bodies')])
  })
})
