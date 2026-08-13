// RAM-disk spool for raw-body capture (TRDD-K3WDPR7M Phase 3).
//
// The spool routes Claude Code's ~30 GB/day of raw-body writes into volatile RAM instead of the SSD.
// These tests pin the parts that must be correct WITHOUT a real RAM disk: the durable spool-config
// round-trip, the FAIL-FAST refusal (capture must never enable if the spool can't be made), the
// skip-set that stops a 60s drain from re-hashing durable bodies, and the boot-remount LaunchAgent
// plist. The one test that needs real `hdiutil` self-skips unless AGENTLENS_TEST_RAMDISK=1 — creating
// real RAM disks in CI is hostile.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  loadCaptureConfig, rawBodyCaptureEnabled, setRawBodyCapture, setSpoolDir, spoolDirConfigured,
  RAW_BODIES_ENV,
} from '../captureConfig'
import {
  DEFAULT_SPOOL_MB, SPOOL_MOUNT_POINT, SPOOL_MB_ENV, detachRamDisk, ensureRamDisk, ramDiskInfo,
  spoolDir, spoolSizeMb,
} from '../ramdisk'
import {
  SPOOL_PLIST_LABEL, installSpoolLaunchAgent, removeSpoolLaunchAgent, spoolPlistContent, spoolPlistPath,
} from '../cli/spoolLaunchAgent'
import { applyCaptureSetting, type CaptureToggleDeps } from '../cli/configCli'
import { runSpoolCli } from '../cli/spoolCli'
import { EXIT } from '../cli/cliErrors'
import type { EnsureResult } from '../telemetryConfig'
import { openStore, Store } from '../store/db'
import { ingestPass } from '../store/ingestPass'

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-spool-')) }

function fakeEnsureResult(bodiesDir: string): EnsureResult {
  return { changed: true, added: [], overrode: [], removed: [], settingsPath: '/tmp/settings.json', markerPath: '/tmp/marker.json', bodiesDir }
}

// ── Pure helpers ──────────────────────────────────────────────────────────────
suite('ramdisk — pure helpers (no RAM disk needed)', () => {
  teardown(() => { delete process.env[SPOOL_MB_ENV] })

  test('spoolDir is <mountPoint>/otel-bodies — the ONE layout definition', () => {
    assert.strictEqual(spoolDir('/Volumes/AgentLensSpool'), '/Volumes/AgentLensSpool/otel-bodies')
    assert.strictEqual(spoolDir(), path.join(SPOOL_MOUNT_POINT, 'otel-bodies'))
  })

  test('spoolSizeMb: default, env override, and floor against a nonsense tiny size', () => {
    assert.strictEqual(spoolSizeMb({}), DEFAULT_SPOOL_MB)
    assert.strictEqual(spoolSizeMb({ [SPOOL_MB_ENV]: '512' }), 512)
    // A spool smaller than 64 MB is a mistake — ignore it and use the default.
    assert.strictEqual(spoolSizeMb({ [SPOOL_MB_ENV]: '8' }), DEFAULT_SPOOL_MB)
    assert.strictEqual(spoolSizeMb({ [SPOOL_MB_ENV]: 'nope' }), DEFAULT_SPOOL_MB)
  })
})

// ── Durable spool-config round-trip ─────────────────────────────────────────────
suite('capture spool config — durable round-trip', () => {
  test('setSpoolDir persists and spoolDirConfigured reads it back', () => {
    const dir = tmp()
    assert.strictEqual(spoolDirConfigured(dir), undefined)
    setSpoolDir(dir, '/Volumes/AgentLensSpool/otel-bodies')
    assert.strictEqual(spoolDirConfigured(dir), '/Volumes/AgentLensSpool/otel-bodies')
    assert.strictEqual(loadCaptureConfig(dir).spoolDir, '/Volumes/AgentLensSpool/otel-bodies')
  })

  test('setSpoolDir(undefined) clears it but PRESERVES the rawBodies flag', () => {
    const dir = tmp()
    setRawBodyCapture(dir, true)
    setSpoolDir(dir, '/Volumes/AgentLensSpool/otel-bodies')
    setSpoolDir(dir, undefined)
    assert.strictEqual(spoolDirConfigured(dir), undefined)
    assert.strictEqual(loadCaptureConfig(dir).rawBodies, true, 'clearing the spool must not touch capture')
  })

  test('setSpoolDir PRESERVES the retention section — one file, many sections', () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ retention: { bodiesMaxGb: 4 } }))
    setSpoolDir(dir, '/x/y')
    const obj = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'))
    assert.deepStrictEqual(obj.retention, { bodiesMaxGb: 4 })
    assert.strictEqual(obj.capture.spoolDir, '/x/y')
  })

  test('a corrupt config.json is REFUSED, never clobbered', () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'config.json'), '{ not json')
    assert.throws(() => setSpoolDir(dir, '/x/y'))
    assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'), '{ not json', 'left untouched')
  })
})

// ── applyCaptureSetting: FAIL-FAST + wiring (deps injected, no real RAM disk) ─────
suite('applyCaptureSetting — fail-fast refusal + spool wiring', () => {
  teardown(() => { delete process.env[RAW_BODIES_ENV] })

  function spyDeps(over: Partial<CaptureToggleDeps> = {}): CaptureToggleDeps & {
    calls: { ensureTelemetry: Array<{ captureRawBodies: boolean; bodiesDir?: string }>; install: number; remove: number }
  } {
    const calls = { ensureTelemetry: [] as Array<{ captureRawBodies: boolean; bodiesDir?: string }>, install: 0, remove: 0 }
    const base: CaptureToggleDeps = {
      ensureRamDisk: (mb: number) => ({ mountPoint: '/Volumes/AgentLensSpool', sizeBytes: mb * 1024 * 1024 }),
      ensureTelemetry: async (o) => { calls.ensureTelemetry.push({ captureRawBodies: o.captureRawBodies, bodiesDir: o.bodiesDir }); return fakeEnsureResult(o.bodiesDir ?? '') },
      installSpoolAgent: () => { calls.install++ },
      removeSpoolAgent: () => { calls.remove++ },
    }
    return Object.assign({}, base, over, { calls })
  }

  test('FAIL-FAST: a RAM disk that cannot be created REFUSES capture and persists NOTHING', async () => {
    const dir = tmp()
    const deps = spyDeps({ ensureRamDisk: () => { throw new Error('hdiutil boom') } })
    const code = await applyCaptureSetting(dir, true, deps)
    assert.strictEqual(code, 1, 'must exit non-zero')
    assert.strictEqual(deps.calls.ensureTelemetry.length, 0, 'must NOT wire the sink after a spool failure')
    assert.strictEqual(deps.calls.install, 0, 'must NOT install the boot agent')
    assert.strictEqual(rawBodyCaptureEnabled(dir, {}), false, 'capture must stay OFF')
    assert.strictEqual(spoolDirConfigured(dir), undefined, 'no spool dir persisted')
  })

  test('ON: wires the sink at the spool bodies dir and persists capture + spoolDir', async () => {
    const dir = tmp()
    const deps = spyDeps()
    const code = await applyCaptureSetting(dir, true, deps)
    assert.strictEqual(code, 0)
    assert.strictEqual(deps.calls.ensureTelemetry.length, 1)
    assert.deepStrictEqual(deps.calls.ensureTelemetry[0], { captureRawBodies: true, bodiesDir: '/Volumes/AgentLensSpool/otel-bodies' })
    assert.strictEqual(deps.calls.install, 1, 'installs the boot-remount agent')
    assert.strictEqual(rawBodyCaptureEnabled(dir, {}), true)
    assert.strictEqual(spoolDirConfigured(dir), '/Volumes/AgentLensSpool/otel-bodies')
  })

  test('OFF: deletes the sink at the PREVIOUSLY-configured spool dir, clears spoolDir, removes the agent', async () => {
    const dir = tmp()
    await applyCaptureSetting(dir, true, spyDeps())          // establish the spool config
    const deps = spyDeps()
    const code = await applyCaptureSetting(dir, false, deps)
    assert.strictEqual(code, 0)
    assert.strictEqual(deps.calls.ensureTelemetry.length, 1)
    assert.deepStrictEqual(deps.calls.ensureTelemetry[0], { captureRawBodies: false, bodiesDir: '/Volumes/AgentLensSpool/otel-bodies' },
      'OFF must target the exact sink we wrote, or the delete-guard cannot match it')
    assert.strictEqual(deps.calls.remove, 1, 'removes the boot-remount agent')
    assert.strictEqual(rawBodyCaptureEnabled(dir, {}), false)
    assert.strictEqual(spoolDirConfigured(dir), undefined)
  })
})

// ── boot-remount LaunchAgent plist (HOME → tmp) ─────────────────────────────────
suite('spool LaunchAgent plist', () => {
  const ARGS = ['/usr/local/bin/node', '/pkg/standalone/cli.js', 'spool', 'ensure']

  test('plist content carries the label, RunAtLoad, and every ProgramArgument', () => {
    const xml = spoolPlistContent(ARGS)
    assert.ok(xml.includes(`<string>${SPOOL_PLIST_LABEL}</string>`))
    assert.ok(xml.includes('<key>RunAtLoad</key>\n  <true/>'))
    for (const a of ARGS) assert.ok(xml.includes(`<string>${a}</string>`), `missing arg ${a}`)
  })

  test('install writes it under HOME/Library/LaunchAgents; remove deletes it (idempotent)', () => {
    const home = tmp()
    const target = installSpoolLaunchAgent(ARGS, home)
    assert.strictEqual(target, spoolPlistPath(home))
    assert.strictEqual(target, path.join(home, 'Library', 'LaunchAgents', `${SPOOL_PLIST_LABEL}.plist`))
    assert.strictEqual(fs.readFileSync(target, 'utf-8'), spoolPlistContent(ARGS))

    assert.strictEqual(removeSpoolLaunchAgent(home), true, 'first remove reports it existed')
    assert.ok(!fs.existsSync(target))
    assert.strictEqual(removeSpoolLaunchAgent(home), false, 'second remove is a no-op')
  })
})

// ── spool CLI (`agentlenspro spool ensure`) ─────────────────────────────────────
suite('spool CLI — ensure iff capture is on', () => {
  let savedDataDir: string | undefined
  setup(() => { savedDataDir = process.env.DATA_DIR; delete process.env[RAW_BODIES_ENV] })
  teardown(() => {
    if (savedDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = savedDataDir
    delete process.env[RAW_BODIES_ENV]
  })

  test('capture OFF: a no-op that never touches a RAM disk', () => {
    const dir = tmp()
    process.env.DATA_DIR = dir
    let called = false
    const code = runSpoolCli(['ensure'], { ensureRamDisk: () => { called = true; return { mountPoint: '/x', sizeBytes: 1 } } })
    assert.strictEqual(code, 0)
    assert.strictEqual(called, false, 'an off machine must never allocate a ram disk')
  })

  test('capture ON: calls ensureRamDisk', () => {
    const dir = tmp()
    process.env.DATA_DIR = dir
    setRawBodyCapture(dir, true)
    let called = 0
    const code = runSpoolCli(['ensure'], { ensureRamDisk: () => { called++; return { mountPoint: SPOOL_MOUNT_POINT, sizeBytes: 2048 * 1048576 } } })
    assert.strictEqual(code, 0)
    assert.strictEqual(called, 1)
  })

  test('an unknown subcommand fails with a usage error', () => {
    // EX_USAGE 64 — a caller mistake, distinct from a runtime abort (1); see src/cli/cliErrors.ts.
    assert.strictEqual(runSpoolCli(['bogus'], { ensureRamDisk: () => ({ mountPoint: '/x', sizeBytes: 1 }) }), EXIT.USAGE)
  })
})

// ── ingestPass skipNames (the 60s-drain efficiency lever) ───────────────────────
suite('ingestPass — skipNames avoids re-reading durable bodies', () => {
  let store: Store
  setup(async () => { store = await openStore({ dir: tmp(), memoryLimit: '2GB', threads: 2 }) })
  teardown(async () => { await store.close() })

  function body(turn: number): string {
    const messages = Array.from({ length: turn }, (_, i) => ({ role: 'user', content: `m${i} ${'y'.repeat(300)}` }))
    return JSON.stringify({ model: 'claude-opus-4-8', tools: [{ name: 't', schema: 'x'.repeat(200) }], messages })
  }
  function corpus(n: number): { dir: string; names: string[] } {
    const dir = tmp()
    const names: string[] = []
    for (let i = 1; i <= n; i++) {
      const name = `body-${String(i).padStart(3, '0')}.request.json`
      fs.writeFileSync(path.join(dir, name), body(i))
      names.push(name)
    }
    return { dir, names }
  }

  test('a name already in skipNames is NOT ingested; the set grows with the names it DID ingest', async () => {
    const { dir, names } = corpus(3)
    const skip = new Set<string>([names[0]])
    const r = await ingestPass({ bodiesDir: dir, store, deleteAfter: false, skipNames: skip })
    assert.strictEqual(r.ingested, 2, 'the pre-seeded name must be skipped by the INGEST')
    assert.ok(skip.has(names[1]) && skip.has(names[2]), 'ingested names are added to the set')
    assert.strictEqual(fs.existsSync(path.join(dir, names[0])), true, 'a skipped file is left untouched')
    // The set claimed this name was durable and the store does not have it, so the claim was
    // false and it is DROPPED — the set self-heals and the next pass ingests it for real. Keeping
    // it would strand the file forever: never re-ingested, never verifiable, never deleted.
    assert.strictEqual(skip.has(names[0]), false, 'a name the store cannot confirm leaves the set')
    assert.ok(r.failed.some(f => f.includes(names[0])), 'and the unverifiable name is reported')
  })

  test('a second pass with the grown set ingests nothing — no re-read, no re-hash', async () => {
    const { dir } = corpus(4)
    const skip = new Set<string>()
    const first = await ingestPass({ bodiesDir: dir, store, deleteAfter: false, skipNames: skip })
    assert.strictEqual(first.ingested, 4)
    const second = await ingestPass({ bodiesDir: dir, store, deleteAfter: false, skipNames: skip })
    assert.strictEqual(second.ingested, 0, 'every name is now in the skip-set')
  })

  test('an already-durable body is RECLAIMED, not stranded — the skip is on the ingest, not the delete', async () => {
    // The bug this pins: skipNames filtered candidates out of the pass entirely, so a body the store
    // already held was never re-ingested (right) AND never deleted (wrong). On a fixed-size RAM spool
    // that is fatal — it fills with files the store already has until capture silently dies. Measured
    // on this machine: 3,615 bodies stranded in a 2 GB spool at 100%.
    const { dir, names } = corpus(3)
    const skip = new Set<string>()
    const first = await ingestPass({ bodiesDir: dir, store, deleteAfter: false, skipNames: skip })
    assert.strictEqual(first.ingested, 3)
    assert.strictEqual(first.deleted, 0, 'deleteAfter:false must delete nothing')

    const second = await ingestPass({ bodiesDir: dir, store, deleteAfter: true, skipNames: skip })
    assert.strictEqual(second.ingested, 0, 'nothing to re-ingest — every name is durable')
    assert.strictEqual(second.deleted, 3, 'but every durable file must still be reclaimed')
    assert.strictEqual(second.reclaimedDurable, 3, 'and counted as having needed no re-ingest')
    assert.deepStrictEqual(second.failed, [], 'a durable body has nothing to fail on')
    for (const n of names) {
      assert.strictEqual(fs.existsSync(path.join(dir, n)), false, `${n} must be gone from the spool`)
    }
  })

  test('a durable NAME whose BYTES differ is KEPT and named — never deleted on the strength of its filename', async () => {
    // The counter-case that keeps the widening honest: reclaiming by name alone would delete a body
    // the store cannot return. The gate re-reads and re-proves, so this file survives.
    const { dir, names } = corpus(2)
    const skip = new Set<string>()
    await ingestPass({ bodiesDir: dir, store, deleteAfter: false, skipNames: skip })

    // Same name, same mtime, different bytes — so the ONLY thing that can fail the gate is the content.
    const victim = path.join(dir, names[0])
    const mtime = fs.statSync(victim).mtime
    fs.writeFileSync(victim, JSON.stringify({ model: 'x', tools: [], messages: [{ role: 'user', content: 'tampered' }] }))
    fs.utimesSync(victim, mtime, mtime)

    const r = await ingestPass({ bodiesDir: dir, store, deleteAfter: true, skipNames: skip })
    assert.strictEqual(fs.existsSync(victim), true, 'a body the store cannot return must survive')
    assert.strictEqual(r.failed.length, 1, 'and it must be NAMED — a silent skip looks like success')
    assert.ok(r.failed[0].includes(names[0]), `failed should name ${names[0]}, got: ${r.failed[0]}`)
    assert.strictEqual(r.reclaimedDurable, 1, 'only the untampered sibling counts as reclaimed')
    assert.strictEqual(fs.existsSync(path.join(dir, names[1])), false, 'the untampered sibling still reclaims')

    // AND it must not be stranded: a name whose bytes no longer match is not durable, so it leaves
    // the skip-set and the NEXT pass re-ingests the true bytes. Without this the file is skipped
    // forever AND never deleted — it holds a slot in a fixed-size spool permanently, which is the
    // fills-until-capture-dies failure this whole pass exists to prevent.
    assert.strictEqual(skip.has(names[0]), false, 'a failed durable name must leave the skip-set')
    const second = await ingestPass({ bodiesDir: dir, store, deleteAfter: true, skipNames: skip })
    assert.strictEqual(second.ingested, 1, 'the next pass re-ingests the true bytes')
    assert.strictEqual(fs.existsSync(victim), false, 'and then reclaims it')
    assert.deepStrictEqual(second.failed, [])
  })

  test('a body that VANISHES mid-pass is not reported as a verification failure', () => new Promise<void>((done, fail) => {
    // The ingest path has always treated a vanished file as fine; the durable path must too, or a
    // drained/rotated file raises a "could NOT be verified and were KEPT on disk" alarm about a
    // file that no longer exists.
    void (async () => {
      try {
        const { dir, names } = corpus(2)
        const skip = new Set<string>()
        await ingestPass({ bodiesDir: dir, store, deleteAfter: false, skipNames: skip })
        const gone = path.join(dir, names[0])
        const r = await ingestPass({
          bodiesDir: dir, store, deleteAfter: true, skipNames: skip,
          readFile: (p: string) => {
            if (p === gone) { const e = new Error('ENOENT') as NodeJS.ErrnoException; e.code = 'ENOENT'; throw e }
            return fs.readFileSync(p, 'utf8')
          },
        })
        assert.deepStrictEqual(r.failed, [], 'a vanished file is not a failure')
        assert.strictEqual(r.deleted, 1, 'the file that IS there still reclaims')
        done()
      } catch (e) { fail(e as Error) }
    })()
  }))
})

// ── Real RAM disk (opt-in; macOS only) ──────────────────────────────────────────
suite('ramdisk — real hdiutil RAM disk (opt-in)', () => {
  test('creates, reuses, and detaches a real RAM disk', function () {
    if (process.env.AGENTLENS_TEST_RAMDISK !== '1' || process.platform !== 'darwin') { this.skip(); return }
    this.timeout(30000)
    const r = ensureRamDisk(64)
    try {
      assert.strictEqual(r.mountPoint, SPOOL_MOUNT_POINT)
      assert.ok(ramDiskInfo().mounted, 'must be mounted after ensure')
      assert.ok(fs.existsSync(spoolDir(r.mountPoint)), 'the otel-bodies subdir must exist on the volume')
      const r2 = ensureRamDisk(64) // idempotent reuse — must not throw
      assert.strictEqual(r2.mountPoint, r.mountPoint)
    } finally {
      detachRamDisk(r.mountPoint)
    }
    assert.ok(!ramDiskInfo().mounted, 'detached')
  })
})
