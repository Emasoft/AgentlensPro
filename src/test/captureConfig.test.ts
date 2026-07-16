// Raw-body capture must be OPT-IN, and turning it off must STICK (TRDD-BKF5NZD3).
//
// The defect these tests pin: OTEL_LOG_RAW_API_BODIES was an unconditionally-owned telemetry key that
// the server force-converged on EVERY boot. Deleting it from settings.json was therefore futile — any
// hook that revived the server put it straight back (measured on 2026-07-14: removed 04:22, re-added
// 15:07), and Claude Code kept dumping the whole conversation to disk on every request (~35 GB/day).
// So the contract is: OFF by default; OFF actively DELETES the key; OFF survives a re-converge; and
// no undo path (uninstall) may resurrect it.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  RAW_BODIES_ENV, RAW_BODIES_KEY, effectiveBodiesDir, loadCaptureConfig, rawBodyCaptureEnabled,
  rawBodyCaptureWithSource, setRawBodyCapture, setSpoolDir,
} from '../captureConfig'
import { ensureTelemetryConfig, ownedTelemetryKeys, removeTelemetryConfig } from '../telemetryConfig'

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-capture-'))
}

/** A settings.json + the telemetryConfig options pointing at it. Never touches the real ~/.claude. */
function fixture(): { dir: string; settingsPath: string; markerPath: string; bodiesDir: string; opts: Record<string, unknown> } {
  const dir = tmp()
  const settingsPath = path.join(dir, 'settings.json')
  const markerPath = path.join(dir, 'telemetry-managed.json')
  const bodiesDir = path.join(dir, 'otel-bodies')
  return { dir, settingsPath, markerPath, bodiesDir, opts: { settingsPath, markerPath, bodiesDir, dataDir: dir, otlpPort: 4318 } }
}

function envOf(settingsPath: string): Record<string, string> {
  const s = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as { env?: Record<string, string> }
  return s.env ?? {}
}

suite('captureConfig — the durable opt-in knob', () => {
  teardown(() => { delete process.env[RAW_BODIES_ENV] })

  test('default is OFF — a setting that silently costs ~35 GB/day is not a default', () => {
    const dir = tmp()
    const { enabled, source } = rawBodyCaptureWithSource(dir, {})
    assert.strictEqual(enabled, false)
    assert.strictEqual(source, 'default')
  })

  test('the file setting is honored and round-trips', () => {
    const dir = tmp()
    setRawBodyCapture(dir, true)
    assert.deepStrictEqual(loadCaptureConfig(dir), { rawBodies: true })
    assert.deepStrictEqual(rawBodyCaptureWithSource(dir, {}), { enabled: true, source: 'file' })
    setRawBodyCapture(dir, false)
    assert.deepStrictEqual(rawBodyCaptureWithSource(dir, {}), { enabled: false, source: 'file' })
  })

  test('env overrides the file (ops override, same precedence as retention)', () => {
    const dir = tmp()
    setRawBodyCapture(dir, false)
    assert.strictEqual(rawBodyCaptureEnabled(dir, { [RAW_BODIES_ENV]: 'on' }), true)
    setRawBodyCapture(dir, true)
    assert.strictEqual(rawBodyCaptureEnabled(dir, { [RAW_BODIES_ENV]: 'off' }), false)
  })

  test('a typo in the env var is NOT read as consent — it falls through to the file/default', () => {
    const dir = tmp()
    // "maybe" must not enable a 35 GB/day sink. Anything unrecognized falls through.
    assert.strictEqual(rawBodyCaptureEnabled(dir, { [RAW_BODIES_ENV]: 'maybe' }), false)
    setRawBodyCapture(dir, true)
    assert.strictEqual(rawBodyCaptureEnabled(dir, { [RAW_BODIES_ENV]: 'maybe' }), true) // file still wins
  })

  test('setting capture PRESERVES the retention section — one file, two sections', () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ retention: { bodiesMaxGb: 4 } }))
    setRawBodyCapture(dir, true)
    const obj = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'))
    assert.deepStrictEqual(obj.retention, { bodiesMaxGb: 4 }, 'retention must survive a capture write')
    assert.deepStrictEqual(obj.capture, { rawBodies: true })
  })

  test('a corrupt config.json is REFUSED, never clobbered', () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'config.json'), '{ not json')
    assert.throws(() => setRawBodyCapture(dir, true))
    assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'), '{ not json', 'left untouched')
  })

  test('a missing/corrupt config reads as all-defaults — config must never crash server boot', () => {
    const dir = tmp()
    assert.deepStrictEqual(loadCaptureConfig(dir), {}) // absent
    fs.writeFileSync(path.join(dir, 'config.json'), '{ not json')
    assert.deepStrictEqual(loadCaptureConfig(dir), {}) // corrupt → defaults (and the default is SAFE)
    assert.strictEqual(rawBodyCaptureEnabled(dir, {}), false)
  })
})

suite('telemetry converge — capture off must actually stop the burn', () => {
  test('capture OFF: the key is never written', async () => {
    const f = fixture()
    await ensureTelemetryConfig({ ...f.opts, captureRawBodies: false })
    assert.ok(!(RAW_BODIES_KEY in envOf(f.settingsPath)), 'must not wire a sink the user did not ask for')
    // ...but the rest of the telemetry wiring IS applied — capture is opt-in, not telemetry itself.
    assert.strictEqual(envOf(f.settingsPath).CLAUDE_CODE_ENABLE_TELEMETRY, '1')
  })

  test('capture ON: the key IS written (the feature still works — it is opt-in, not removed)', async () => {
    const f = fixture()
    await ensureTelemetryConfig({ ...f.opts, captureRawBodies: true })
    assert.strictEqual(envOf(f.settingsPath)[RAW_BODIES_KEY], `file:${f.bodiesDir}`)
  })

  test('THE BUG: converging with capture off DELETES a key left over from when it was on', async () => {
    const f = fixture()
    await ensureTelemetryConfig({ ...f.opts, captureRawBodies: true })
    assert.strictEqual(envOf(f.settingsPath)[RAW_BODIES_KEY], `file:${f.bodiesDir}`)

    // The user turns capture off. Merely dropping the key from `owned` would leave it in the file
    // forever (the converge loop only touches OWNED keys) and Claude Code would keep writing.
    const r = await ensureTelemetryConfig({ ...f.opts, captureRawBodies: false })
    assert.ok(r.removed.includes(RAW_BODIES_KEY), 'ensure must REPORT the removal')
    assert.ok(!(RAW_BODIES_KEY in envOf(f.settingsPath)), 'ensure must DELETE the key, not just stop adding it')
  })

  test('THE REGRESSION GUARD: a second boot must NOT re-arm it', async () => {
    const f = fixture()
    await ensureTelemetryConfig({ ...f.opts, captureRawBodies: true })
    await ensureTelemetryConfig({ ...f.opts, captureRawBodies: false })
    // This is the exact loop that defeated the 04:22 fix: a hook revived the server, the server
    // re-converged, and the key came back. It must now stay gone across any number of boots.
    await ensureTelemetryConfig({ ...f.opts, captureRawBodies: false })
    await ensureTelemetryConfig({ ...f.opts, captureRawBodies: false })
    assert.ok(!(RAW_BODIES_KEY in envOf(f.settingsPath)), 'a server boot must never resurrect the burn')
  })

  test('capture off does NOT clobber a sink the user points somewhere else', async () => {
    const f = fixture()
    fs.writeFileSync(f.settingsPath, JSON.stringify({ env: { [RAW_BODIES_KEY]: 'file:/my/own/dir' } }, null, 2))
    const r = await ensureTelemetryConfig({ ...f.opts, captureRawBodies: false })
    assert.ok(!r.removed.includes(RAW_BODIES_KEY))
    assert.strictEqual(envOf(f.settingsPath)[RAW_BODIES_KEY], 'file:/my/own/dir',
      'we only delete the value WE would have written — a user-chosen sink is theirs')
  })

  test('uninstall must NOT restore the key while capture is off', async () => {
    const f = fixture()
    // Reproduce THIS machine's marker: the user had the key BEFORE AgentLens ever ran, so a faithful
    // "restore prior state" uninstall would put the ~35 GB/day sink back — an uninstall that makes
    // the burn WORSE. Capture-off must outlive the removal of our wiring.
    fs.writeFileSync(f.settingsPath, JSON.stringify({ env: { [RAW_BODIES_KEY]: `file:${f.bodiesDir}` } }, null, 2))
    await ensureTelemetryConfig({ ...f.opts, captureRawBodies: true })   // marker records hadKey:true
    await ensureTelemetryConfig({ ...f.opts, captureRawBodies: false })  // user turns it off

    const r = await removeTelemetryConfig({ ...f.opts, captureRawBodies: false })
    assert.ok(!r.restored.includes(RAW_BODIES_KEY), 'uninstall must not resurrect the burn')
    assert.ok(!(RAW_BODIES_KEY in envOf(f.settingsPath)))
  })

  test('ownedTelemetryKeys reflects the same decision ensure acts on (verify cannot drift)', () => {
    const off = ownedTelemetryKeys('/b', 4318, false)
    const on = ownedTelemetryKeys('/b', 4318, true)
    assert.ok(!(RAW_BODIES_KEY in off), 'setup must not VERIFY a key ensure deliberately deleted')
    assert.strictEqual(on[RAW_BODIES_KEY], 'file:/b')
  })
})

// The two-writer defect (2026-07-16): the CLI capture-on flow wired the key at the RAM-disk spool,
// then the server-boot converge — whose bodiesDir default was hard-coded to the legacy SSD dir —
// overwrote it minutes later, silently re-pointing Claude Code's ~35 GB/day at the SSD. The contract:
// there is ONE resolution of the bodies dir (effectiveBodiesDir), and a spool-BLIND caller of
// ensureTelemetryConfig must converge the SAME value the spool-AWARE writer wrote.
suite('effectiveBodiesDir — the one bodies-dir resolution (TRDD-K3WDPR7M spool × TRDD-BKF5NZD3 converge)', () => {
  test('capture on + spool configured → the spool dir', () => {
    const dir = tmp()
    setSpoolDir(dir, '/Volumes/TestSpool/otel-bodies')
    assert.strictEqual(effectiveBodiesDir(dir, true), '/Volumes/TestSpool/otel-bodies')
  })
  test('capture on + no spool configured → the legacy dir', () => {
    const dir = tmp()
    assert.strictEqual(effectiveBodiesDir(dir, true), path.join(dir, 'otel-bodies'))
  })
  test('capture off → the legacy dir even when a spool is configured (off never targets the spool)', () => {
    const dir = tmp()
    setSpoolDir(dir, '/Volumes/TestSpool/otel-bodies')
    assert.strictEqual(effectiveBodiesDir(dir, false), path.join(dir, 'otel-bodies'))
  })

  test('a spool-BLIND converge (the server-boot shape) writes the SPOOL value, not the legacy dir', async () => {
    const f = fixture()
    // A tmp-rooted spool path (ensure mkdir-s the bodies dir, and /Volumes needs root) — the point
    // is only that it differs from the legacy <dataDir>/otel-bodies.
    const spool = path.join(f.dir, 'spool', 'otel-bodies')
    setRawBodyCapture(f.dir, true)
    setSpoolDir(f.dir, spool)
    // No bodiesDir in the options — exactly how the server boot calls ensure. Before the fix this
    // converged file:<legacy> and clobbered the CLI's spool value.
    const { bodiesDir: _omit, ...blind } = f.opts as { bodiesDir: string } & Record<string, unknown>
    await ensureTelemetryConfig(blind)
    assert.strictEqual(envOf(f.settingsPath)[RAW_BODIES_KEY], `file:${spool}`)
  })
})
