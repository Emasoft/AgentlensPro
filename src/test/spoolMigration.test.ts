// TRDD-Z53IJFE9 step C — the published-install migration for the REMOVED RAM-disk spool.
//
// The spool code is deleted (step D), but an upgrading published install can still carry:
// a mounted /Volumes/AgentLensSpool RAM disk, OTEL_LOG_RAW_API_BODIES pointing at it in
// settings.json, and the dead com.agentlens.spool LaunchAgent. `agentlenspro setup` must
// migrate that state in the card's EXACT order: drain → detach → rewrite settings → bootout
// + move the plist aside. NEVER detach before draining.
//
// These tests drive the REAL decision flow: runSpoolMigration (the exact function the
// production step executes) with stubbed SpoolMigrationDeps. No test re-implements the
// order — a re-implementation would pin nothing (review round 1). No real hdiutil,
// launchctl, alstore, /Volumes mount, or ~/.claude is touched.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { detectLegacySpool, SpoolMigrationDeps, runSpoolMigration, Ctx } from '../cli/setup'
import { RAW_BODIES_KEY, effectiveBodiesDir } from '../captureConfig'

const SPOOL_VALUE = 'file:/Volumes/AgentLensSpool/otel-bodies'
const SPOOL_VOLUME = '/Volumes/AgentLensSpool'

/** Stub deps that RECORD the call order — the tests assert on the order the REAL function
 *  produced, so a reordering in setup.ts fails here. `volume` defaults to a non-existent
 *  fixture path so nothing real is ever mounted. A completed action is recorded; a THROWING
 *  action is not (a failed step is not an acted one), so a detach that throws never appears. */
function stubDeps(opts: {
  volumeMounted?: boolean
  drainOk?: boolean            // drain resolves normally (ok) or throws/returns null
  drainResult?: { failed?: string[]; throttled?: boolean }
  residueAfterDrain?: string[] // what listSpoolBodies reports AFTER the drain ran
  writerBodiesOnPasses?: number // a live writer lands ONE body during each of the first N drain passes
  detachThrows?: boolean
  binAvailable?: boolean
} = {}) {
  const calls: string[] = []
  const volume = fs.mkdtempSync(path.join(os.tmpdir(), 'al-spoolvol-'))
  const bodiesDir = path.join(volume, 'otel-bodies')
  fs.mkdirSync(bodiesDir, { recursive: true })
  // A "mounted" volume: bodies dir exists. listSpoolBodies reports what is in it RIGHT NOW.
  const deps: SpoolMigrationDeps = {
    // Honors the ARGUMENT (the step passes the real SPOOL_VOLUME literal; the stub's volume is a
    // fixture) and models detach = the bodies dir disappears, so the post-migration re-detect
    // sees the volume unmounted exactly like the real hdiutil path.
    volumeMounted: (vol) => (vol === SPOOL_VOLUME ? (opts.volumeMounted ?? true) && fs.existsSync(bodiesDir) : fs.existsSync(path.join(vol, 'otel-bodies'))),
    detachVolume: () => {
      if (opts.detachThrows) throw new Error('hdiutil detach failed (stub)')
      calls.push('detach')
      fs.rmSync(bodiesDir, { recursive: true, force: true }) // detached ⇒ dir gone, like the real thing
    },
    drain: async () => {
      calls.push('drain')
      if (opts.drainOk === false) throw new Error('alstore pass failed (stub)')
      // Model the real pass: files present at pass start are ingested and DELETED, except the
      // residue names (the stranded/skipped bodies the pass leaves on disk, which it also fails
      // to name in its report — the blind spot the readdir gate exists for). A pass over an
      // empty dir with no residue ingests 0 — the drain loop's starved-pass success condition.
      const residue = opts.residueAfterDrain ?? []
      const before = fs.existsSync(bodiesDir)
        ? fs.readdirSync(bodiesDir).filter(n => !residue.includes(n))
        : []
      for (const name of before) fs.rmSync(path.join(bodiesDir, name), { force: true })
      for (const name of residue) fs.writeFileSync(path.join(bodiesDir, name), 'x')
      // The TOCTOU window the drain loop closes (review round 2, F1): a live Claude session
      // (settings still pointing at the spool) can land a body DURING a pass — after the pass's
      // scan, before the caller's readdir gate. Model it as a body appearing after each of the
      // first N passes.
      if ((opts.writerBodiesOnPasses ?? 0) >= calls.filter(c => c === 'drain').length) {
        fs.writeFileSync(path.join(bodiesDir, `late-b-${calls.filter(c => c === 'drain').length}.json`), 'x')
      }
      return { ingested: before.length, deleted: before.length, bytesIn: 1, bytesStored: 1, reclaimedDurable: 0, bytesFreed: 1, strandedRelocated: 0, failed: opts.drainResult?.failed ?? [], strandedTs: [], throttled: opts.drainResult?.throttled ?? false }
    },
    alstoreBin: () => (opts.binAvailable === false ? null : '/stub/alstore'),
    bootoutAgent: () => { calls.push('bootout') },
    plistPath: () => path.join(volume, 'LaunchAgents', 'com.agentlens.spool.plist'),
    listSpoolBodies: () => {
      try { return fs.readdirSync(bodiesDir) } catch { return [] }
    },
  }
  return { deps, calls, volume, bodiesDir }
}

/** A settings.json fixture + a full Ctx stub pointing at it. */
function ctxFixture(env: Record<string, string>): { ctx: Ctx; settingsPath: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-spoolctx-'))
  const settingsPath = path.join(dir, 'settings.json')
  fs.writeFileSync(settingsPath, JSON.stringify({ env }, null, 2))
  const ctx: Ctx = {
    dryRun: false, yes: true, forceInstall: false, telemetryProbe: {}, home: dir, dataDir: dir, settingsPath,
    skillsDir: path.join(dir, 'skills'), agentsDir: path.join(dir, 'agents'), repoRoot: dir,
    uiPort: 0, mcpPort: 0, otlpPort: 0, pathEnv: '', log: () => {}, serverPid: null,
  }
  return { ctx, settingsPath, dir }
}

/** Read the settings file's env block back — the post-migration assertion surface (F3). */
function envOf(settingsPath: string): Record<string, string> {
  const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { env?: Record<string, string> }
  return s.env ?? {}
}

function plistFixture(plistPath: () => string): string {
  const p = plistPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, '<plist/>')
  return p
}

suite('setup spool-migration — detectLegacySpool (settings half, real fs on temp dirs)', () => {
  test('a settings env pointing at the spool path is detected', () => {
    const f = ctxFixture({ OTEL_LOG_RAW_API_BODIES: SPOOL_VALUE })
    try {
      assert.strictEqual(detectLegacySpool(f.settingsPath).settingsPathPointsAtSpool, true)
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }) }
  })

  test('the SSD bodies path is NOT spool legacy', () => {
    const f = ctxFixture({ OTEL_LOG_RAW_API_BODIES: 'file:/Users/x/.agentlens/otel-bodies' })
    try {
      assert.strictEqual(detectLegacySpool(f.settingsPath).settingsPathPointsAtSpool, false)
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }) }
  })

  test('absent or unparseable settings are NOT spool legacy (telemetry step owns that refusal)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-spoolctx-'))
    try {
      assert.strictEqual(detectLegacySpool(path.join(dir, 'nope.json')).settingsPathPointsAtSpool, false)
      const bad = path.join(dir, 'bad.json')
      fs.writeFileSync(bad, '{"env": ')
      assert.strictEqual(detectLegacySpool(bad).settingsPathPointsAtSpool, false)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  test('the removed summary.bodies.spool key and AGENTLENS_BODIES_MAX_AGE_HOURS env are ignored, not errors', () => {
    // Card review condition 2: the step D wire/config surface is gone; a legacy file carrying
    // either residue must migrate cleanly (the migration simply never reads them).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-spoolctx-'))
    try {
      const settingsPath = path.join(dir, 'settings.json')
      fs.writeFileSync(settingsPath, JSON.stringify({
        env: { OTEL_LOG_RAW_API_BODIES: SPOOL_VALUE, AGENTLENS_BODIES_MAX_AGE_HOURS: '72' },
        summary: { bodies: { spool: { files: 12, bytes: 4 } } },
      }, null, 2))
      assert.strictEqual(detectLegacySpool(settingsPath).settingsPathPointsAtSpool, true)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

suite('setup spool-migration — the REAL flow with stubbed seams (order + refusals)', () => {
  test('full legacy state migrates in the card order: drain → detach → settings → bootout', async () => {
    const f = ctxFixture({ OTEL_LOG_RAW_API_BODIES: SPOOL_VALUE })
    const s = stubDeps({ volumeMounted: true, residueAfterDrain: [] })
    try {
      plistFixture(s.deps.plistPath)
      const { result, acted } = await runSpoolMigration(f.ctx, s.deps)
      assert.deepStrictEqual(s.calls, ['drain', 'detach', 'bootout'], 'exact card order: drain → detach → (settings inside safeConfigEdit) → bootout')
      assert.strictEqual(result.verify, 'PASS', result.detail)
      assert.strictEqual(acted, true)
      assert.ok(result.action.includes('drained'), result.action)
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); fs.rmSync(s.volume, { recursive: true, force: true }) }
  })

  test('a failed drain REFUSES: nothing detaches, nothing rewrites, no bootout', async () => {
    const f = ctxFixture({ OTEL_LOG_RAW_API_BODIES: SPOOL_VALUE })
    const s = stubDeps({ volumeMounted: true, drainOk: false })
    try {
      plistFixture(s.deps.plistPath)
      const { result } = await runSpoolMigration(f.ctx, s.deps)
      assert.strictEqual(result.verify, 'FAIL')
      assert.strictEqual(result.action, 'refused')
      assert.deepStrictEqual(s.calls, ['drain'], 'only the drain ran — no detach, no bootout')
      assert.ok((result.detail ?? '').includes('left mounted'), result.detail)
      // Settings untouched.
      assert.strictEqual(JSON.parse(fs.readFileSync(f.settingsPath, 'utf8')).env.OTEL_LOG_RAW_API_BODIES, SPOOL_VALUE)
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); fs.rmSync(s.volume, { recursive: true, force: true }) }
  })

  test('an incomplete drain (failed bodies or throttled) refuses before detach', async () => {
    const f = ctxFixture({ OTEL_LOG_RAW_API_BODIES: SPOOL_VALUE })
    const s = stubDeps({ volumeMounted: true, drainResult: { failed: ['b-003.json'], throttled: false } })
    try {
      plistFixture(s.deps.plistPath)
      const { result } = await runSpoolMigration(f.ctx, s.deps)
      assert.strictEqual(result.verify, 'FAIL')
      assert.deepStrictEqual(s.calls, ['drain'])
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); fs.rmSync(s.volume, { recursive: true, force: true }) }
  })

  test('RESIDUE AFTER A CLEAN REPORT refuses the detach — the airtight readdir gate (review round 1)', async () => {
    // The mutation this test pins: a drain reporting ok/failed=[]/throttled=false while the
    // spool bodies dir still holds files (stranded bodies the report does not name) must NOT
    // detach. The gate reads the dir through readdir, independent of the pass's bookkeeping;
    // the drain loop (review round 2, F1) exhausts its 8 passes — the stranded bodies are
    // skipped forever, so no pass ever starves — and then refuses with the residue named.
    const f = ctxFixture({ OTEL_LOG_RAW_API_BODIES: SPOOL_VALUE })
    const s = stubDeps({ volumeMounted: true, residueAfterDrain: ['stranded-b-007.json'] })
    try {
      plistFixture(s.deps.plistPath)
      const { result } = await runSpoolMigration(f.ctx, s.deps)
      assert.strictEqual(result.verify, 'FAIL')
      assert.strictEqual(result.action, 'refused')
      assert.strictEqual(s.calls.filter(c => c === 'drain').length, 8, 'the loop exhausts its cap before refusing')
      assert.deepStrictEqual(s.calls.filter(c => c !== 'drain'), [], 'detach must NOT run while any file remains in the spool')
      assert.ok((result.detail ?? '').includes('stranded-b-007.json'), result.detail)
      assert.ok((result.detail ?? '').includes('re-run setup'), result.detail)
      // The volume is still "mounted" — bodies dir still exists.
      assert.strictEqual(fs.existsSync(s.bodiesDir), true)
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); fs.rmSync(s.volume, { recursive: true, force: true }) }
  })

  test('a body landing AFTER a pass (live writer) is drained by the NEXT pass — the loop closes the TOCTOU window (review round 2, F1)', async () => {
    // A body lands during pass 1 (after its scan); pass 2 ingests it and reports ingested>0;
    // pass 3 finds nothing (ingested 0 + readdir empty) → starved writer → detach. A body
    // ingested by a pass can never free THAT pass — the starved pass is the one AFTER the
    // last body, which is the whole point: the writer gets no reader-free window.
    const f = ctxFixture({ OTEL_LOG_RAW_API_BODIES: SPOOL_VALUE })
    const s = stubDeps({ volumeMounted: true, writerBodiesOnPasses: 1 })
    try {
      plistFixture(s.deps.plistPath)
      const { result } = await runSpoolMigration(f.ctx, s.deps)
      assert.strictEqual(result.verify, 'PASS', result.detail)
      assert.deepStrictEqual(s.calls, ['drain', 'drain', 'drain', 'detach', 'bootout'], 'one late body = one extra pass, then the starved pass frees the detach')
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); fs.rmSync(s.volume, { recursive: true, force: true }) }
  })

  test('a writer that never starves hits the loop cap and refuses without detaching', async () => {
    // The cap bounds a pathological writer (or a backlog larger than 8 passes): refuse with
    // the RAM disk still mounted — re-running setup is the recovery, never a forced detach.
    const f = ctxFixture({ OTEL_LOG_RAW_API_BODIES: SPOOL_VALUE })
    const s = stubDeps({ volumeMounted: true, writerBodiesOnPasses: 99 })
    try {
      plistFixture(s.deps.plistPath)
      const { result } = await runSpoolMigration(f.ctx, s.deps)
      assert.strictEqual(result.verify, 'FAIL')
      assert.strictEqual(result.action, 'refused')
      assert.strictEqual(s.calls.filter(c => c === 'drain').length, 8, 'exactly the cap')
      assert.deepStrictEqual(s.calls.filter(c => c !== 'drain'), [], 'nothing but drains ran — no detach, no bootout')
      assert.ok((result.detail ?? '').includes('left mounted'), result.detail)
      assert.ok((result.detail ?? '').includes('re-run setup'), result.detail)
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); fs.rmSync(s.volume, { recursive: true, force: true }) }
  })

  test('a DETACH FAILURE fails the step with the volume still mounted and nothing after it', async () => {
    // F4 (review round 2): pins the detach-failure refusal — the drain completed, but the
    // detach throws; the settings rewrite and the bootout must NOT run (they assume the
    // volume is gone), and the run reports FAIL for the re-run to pick up.
    const f = ctxFixture({ OTEL_LOG_RAW_API_BODIES: SPOOL_VALUE })
    const s = stubDeps({ volumeMounted: true, detachThrows: true })
    try {
      plistFixture(s.deps.plistPath)
      await assert.rejects(
        () => runSpoolMigration(f.ctx, s.deps),
        /hdiutil detach failed/,
      )
      assert.deepStrictEqual(s.calls, ['drain'], 'only the drain ran — the failing detach is the last action')
      assert.strictEqual(fs.existsSync(s.bodiesDir), true, 'the volume is still mounted (bodies dir still exists)')
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); fs.rmSync(s.volume, { recursive: true, force: true }) }
  })

  test('no alstore binary refuses BEFORE the drain attempt', async () => {
    const f = ctxFixture({ OTEL_LOG_RAW_API_BODIES: SPOOL_VALUE })
    const s = stubDeps({ volumeMounted: true, binAvailable: false })
    try {
      const { result } = await runSpoolMigration(f.ctx, s.deps)
      assert.strictEqual(result.verify, 'FAIL')
      assert.deepStrictEqual(s.calls, [], 'not even the drain may be attempted without the binary')
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); fs.rmSync(s.volume, { recursive: true, force: true }) }
  })

  test('idempotency: a migrated machine (no spool artifacts) acts on nothing', async () => {
    const f = ctxFixture({ OTEL_LOG_RAW_API_BODIES: `file:${path.join(os.homedir(), '.agentlens', 'otel-bodies')}` })
    const s = stubDeps({ volumeMounted: false })
    try {
      const { result, acted } = await runSpoolMigration(f.ctx, s.deps)
      assert.strictEqual(result.verify, 'PASS')
      assert.strictEqual(acted, false, 'a second run over a migrated machine must act on nothing')
      assert.deepStrictEqual(s.calls, [])
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); fs.rmSync(s.volume, { recursive: true, force: true }) }
  })

  test('dry-run plans the migration, says "by default" for the legacy limits, and acts on nothing', async () => {
    const f = ctxFixture({ OTEL_LOG_RAW_API_BODIES: SPOOL_VALUE })
    const s = stubDeps({ volumeMounted: true })
    try {
      const { result, acted } = await runSpoolMigration({ ...f.ctx, dryRun: true }, s.deps)
      assert.strictEqual(result.verify, 'SKIP')
      assert.strictEqual(acted, false)
      assert.deepStrictEqual(s.calls, [], 'dry-run must act on nothing')
      // The card's wording contract, asserted against the step's ACTUAL dry-run string.
      assert.ok(result.action.includes('by default'), `the dry-run action must say "by default" for the 72h/8GB limits: ${result.action}`)
      assert.ok(result.action.includes('drain') && result.action.includes('detach'), result.action)
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); fs.rmSync(s.volume, { recursive: true, force: true }) }
  })

  test('an existing .bak is never overwritten: a second partial migration gets a timestamped aside', async () => {
    const f = ctxFixture({ OTEL_LOG_RAW_API_BODIES: SPOOL_VALUE })
    const s = stubDeps({ volumeMounted: false }) // no volume: only the plist half runs
    try {
      const plist = plistFixture(s.deps.plistPath)
      const aside = path.join(path.dirname(plist), 'disabled-com.agentlens.spool.plist.bak')
      fs.writeFileSync(aside, 'FIRST BACKUP — DO NOT LOSE')
      const { result } = await runSpoolMigration(f.ctx, s.deps)
      assert.strictEqual(result.verify, 'PASS', result.detail)
      assert.strictEqual(fs.readFileSync(aside, 'utf8'), 'FIRST BACKUP — DO NOT LOSE', 'the first backup must survive')
      const dirContents = fs.readdirSync(path.dirname(plist)).filter(n => n.startsWith('disabled-'))
      assert.strictEqual(dirContents.length, 2, `expected the original .bak plus one timestamped copy, got: ${dirContents.join(', ')}`)
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); fs.rmSync(s.volume, { recursive: true, force: true }) }
  })
})

suite('setup spool-migration — settings rewrite seam', () => {
  test('the migration routes the settings write through safeConfigEdit (structural, at the import seam)', () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..')
    const src = fs.readFileSync(path.join(repoRoot, 'src', 'cli', 'setup.ts'), 'utf8')
    assert.ok(src.includes("from '../safeConfigEdit'"), 'the migration must route through safeConfigEdit')
    const telemetry = fs.readFileSync(path.join(repoRoot, 'src', 'telemetryConfig.ts'), 'utf8')
    assert.ok(!/fs\.writeFile\([^)]*settings/i.test(telemetry), 'telemetryConfig must keep using the transactional editor for settings.json')
  })

  test('the step wrapper is what STEPS runs, and it passes the REAL deps (structural)', () => {
    // Pins that stepSpoolMigration delegates to runSpoolMigration(realSpoolDeps()) — the tests
    // above exercise exactly that function, so production cannot drift from what is tested.
    const repoRoot = path.resolve(__dirname, '..', '..', '..')
    const src = fs.readFileSync(path.join(repoRoot, 'src', 'cli', 'setup.ts'), 'utf8')
    assert.ok(src.includes('return runSpoolMigration(ctx, realSpoolDeps())'), 'the step wrapper must call the tested function with the real seams')
  })
})

// ── F3 (review round 2): the settings CONTENT after migration, through the REAL safeConfigEdit ──
// The stub deps stub only the volume/drain/plist seams — the config write inside ACT 3 is the
// real safeConfigEdit (real python editor over a real temp settings file), so these tests pin
// WHAT it writes, not just that it was called. Raw capture is mandatory (2026-10-02), so the
// migration always points the key at the SSD dir — there is no capture-off state to preserve.

suite('setup spool-migration — the settings file content after migration (F3, real safeConfigEdit)', () => {
  test('the spool value is rewritten to the effective SSD path (capture is mandatory — there is no off state)', async () => {
    const f = ctxFixture({ OTEL_LOG_RAW_API_BODIES: SPOOL_VALUE, UNRELATED_KEY: 'kept' })
    const s = stubDeps({ volumeMounted: true })
    try {
      const { result } = await runSpoolMigration(f.ctx, s.deps)
      assert.strictEqual(result.verify, 'PASS', result.detail)
      const env = envOf(f.settingsPath)
      assert.strictEqual(env[RAW_BODIES_KEY], `file:${effectiveBodiesDir(f.ctx.dataDir)}`,
        'the path moves to the SSD dir resolved through effectiveBodiesDir')
      assert.ok(!env[RAW_BODIES_KEY].includes('/Volumes/AgentLensSpool'), 'no spool path survives in the value')
      // The other env keys the file carried survive the edit (the transactional editor's contract).
      assert.strictEqual(env.UNRELATED_KEY, 'kept', 'safeConfigEdit must not touch anything but the target key')
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); fs.rmSync(s.volume, { recursive: true, force: true }) }
  })
})
