// TRDD-RBBEX59R step (e), bug B6 — `last-compact` (and the resumeStaleness read of cache-expired/cache-state) under the kill-switch.
//
// While the switch is armed no hook event reaches the disk: the CLI hook handler only POSTs, and alcore's ingest_hook_event takes the
// ring-only path under no-collection mode (rust-core/crates/agentlens-core/src/hook_events.rs:274-282), so the newest PreCompact on disk
// is only the last one from BEFORE the switch. Reporting it as the latest compaction is a confident wrong answer; the contract is
// "no record = exit 2, stdout EMPTY". The live writer of <data>/hook-events is alcore (append_hook_event, hook_events.rs:155-165:
// `ts` = epoch ms, `ev`, `session`, `payload`). The records here are built by the TS hookEventStore.buildHookEventRecord +
// ndjsonBuckets.appendBucketLine; that this TS builder matches alcore's record shape and unit (epoch ms, the unit of the flag file's
// mtimeMs) rests on READING hook_events.rs, not on a test: lastCompact.test.ts ("appendHookEvent-written records are readable by the
// same finder") only checks the TS writer against the TS reader. runLastCompactCli runs in-process against a temp data dir; the verb
// reads dataDir() and the flag on every call.

import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { runLastCompactCli } from '../cli/lastCompactCli'
import { dataDir } from '../dataDir'
import { latestResumeStaleness } from '../cli/cacheExpiredCli'
import { armKillSwitch, killSwitchPath, overrideKillSwitchEnv } from '../cli/killSwitch'
import { buildHookEventRecord } from '../hookEventStore'
import { appendBucketLine } from '../ndjsonBuckets'

const ENV_KEYS = ['AGENTLENS_DATA_DIR', 'DATA_DIR', 'AGENTLENS_DISABLED'] as const

suite('last-compact / resumeStaleness under the kill-switch (TRDD-RBBEX59R e, B6)', () => {
  let tmp: string
  let project: string
  let hookDir: string
  const saved: Record<string, string | undefined> = {}
  // Set in setup(), not at suite definition: in a long multi-file run the definition-time clock is minutes stale by the time a test runs.
  let now = 0

  setup(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k]
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-lcks-')))
    project = path.join(tmp, 'proj')
    hookDir = path.join(tmp, 'hook-events')
    fs.mkdirSync(project, { recursive: true })
    fs.mkdirSync(hookDir, { recursive: true })
    delete process.env.DATA_DIR
    delete process.env.AGENTLENS_DISABLED
    overrideKillSwitchEnv(false) // module-level state: a force-install test elsewhere must not leak the override in
    process.env.AGENTLENS_DATA_DIR = tmp
    now = Date.now()
    // The real flag is armed on a developer machine: a verb reading the REAL store would pass or fail for the wrong reason.
    // dataDir() honours AGENTLENS_DATA_DIR first (src/dataDir.ts:44 resolveDataDirFrom); pin that the verb under test reads tmp.
    assert.strictEqual(dataDir(), tmp)
  })
  teardown(() => {
    overrideKillSwitchEnv(false)
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  /** One hook event through the production builder + appender, at an explicit epoch-ms `ts`. */
  const record = (ev: string, atMs: number, payload: Record<string, unknown>): void => {
    const rec = buildHookEventRecord({ session_id: 'sess-1', hook_event_name: ev, ...payload }, atMs)
    appendBucketLine(hookDir, rec.ts, JSON.stringify(rec))
  }
  const preCompact = (atMs: number): void => record('PreCompact', atMs, { cwd: project, trigger: 'manual' })

  /** Arm the flag file through the production writer, then pin its mtime to `mtimeMs`. */
  const armFileAt = (mtimeMs: number): string => {
    armKillSwitch('test', tmp)
    const p = killSwitchPath(tmp)
    fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs))
    return p
  }

  interface Out { code: number; stdout: string; stderr: string }
  const run = (extra: string[] = []): Out => {
    const out: string[] = []
    const err: string[] = []
    const log = console.log
    const error = console.error
    console.log = (...a: unknown[]): void => { out.push(a.join(' ')) }
    console.error = (...a: unknown[]): void => { err.push(a.join(' ')) }
    let code: number
    try { code = runLastCompactCli(['--project', project, ...extra]) } finally { console.log = log; console.error = error }
    return { code, stdout: out.join('\n'), stderr: err.join('\n') }
  }


  test('file half armed, newest record OLDER than the flag mtime: exit 2, stdout EMPTY, one stderr line naming the arm time (all output modes)', () => {
    preCompact(now - 3_600_000)
    armFileAt(now - 60_000)
    for (const extra of [[], ['--seconds'], ['--json']]) {
      const r = run(extra)
      assert.strictEqual(r.code, 2, `${extra.join(' ')}: ${r.stderr}`)
      assert.strictEqual(r.stdout, '', 'a pre-switch record must print nothing on stdout')
      assert.ok(r.stderr.includes(`armed at ${new Date(now - 60_000).toISOString()}`), r.stderr)
      assert.strictEqual(r.stderr.split('\n').length, 1, 'exactly one stderr line')
      assert.ok(r.stderr.includes('agentlenspro enable'), 'the line names the remedy')
    }
  })

  test('file half armed, newest record stamped EXACTLY at the flag mtime: trusted (the boundary is strict less-than)', () => {
    const at = Math.floor(now - 60_000)
    preCompact(at)
    armFileAt(at)
    const r = run(['--seconds'])
    assert.strictEqual(r.code, 0, r.stderr)
    assert.ok(Number(r.stdout) >= 59, r.stdout)
  })

  test('file half armed, newest record NEWER than the flag mtime: answers normally', () => {
    armFileAt(now - 3_600_000)
    preCompact(now - 120_000)
    const r = run(['--seconds'])
    assert.strictEqual(r.code, 0, r.stderr)
    const secs = Number(r.stdout)
    // Upper bound from the clock at ASSERT time, not a fixed 130: a loaded multi-file run can take many seconds between setup and here.
    const maxSecs = Math.ceil((Date.now() - (now - 120_000)) / 1000)
    assert.ok(Number.isInteger(secs) && secs >= 119 && secs <= maxSecs, `expected 119..${maxSecs}, got "${r.stdout}"`)
    assert.strictEqual(run().stdout.length > 0, true)
  })

  test('file half armed with NO records at all: exit 2, stdout EMPTY', () => {
    armFileAt(now - 60_000)
    const r = run(['--seconds'])
    assert.strictEqual(r.code, 2, r.stderr)
    assert.strictEqual(r.stdout, '')
    assert.ok(r.stderr.includes('since the kill-switch was armed'), r.stderr)
  })

  test('env half only (no flag file): exit 2, stdout EMPTY, and the stderr line says it is THIS process\'s own env', () => {
    preCompact(now - 60_000)
    process.env.AGENTLENS_DISABLED = '1'
    for (const extra of [[], ['--seconds'], ['--json']]) {
      const r = run(extra)
      assert.strictEqual(r.code, 2, `${extra.join(' ')}: ${r.stderr}`)
      assert.strictEqual(r.stdout, '')
      assert.ok(r.stderr.includes('AGENTLENS_DISABLED=1') && r.stderr.includes('OWN environment'), r.stderr)
      assert.strictEqual(r.stderr.split('\n').length, 1)
    }
  })

  test('BOTH halves armed: the flag file supplies the arm time, so an older record is refused and a newer one answers', () => {
    process.env.AGENTLENS_DISABLED = '1'
    preCompact(now - 3_600_000)
    armFileAt(now - 60_000)
    const old = run(['--seconds'])
    assert.strictEqual(old.code, 2, old.stderr)
    assert.strictEqual(old.stdout, '')
    assert.ok(old.stderr.includes('armed at'), old.stderr)
    preCompact(now - 30_000)
    const fresh = run(['--seconds'])
    assert.strictEqual(fresh.code, 0, fresh.stderr)
    assert.ok(Number(fresh.stdout) >= 29, fresh.stdout)
  })

  test('NOT armed: unchanged — an old record is still the answer, and an empty store is still the plain miss', () => {
    preCompact(now - 3_600_000)
    const r = run(['--seconds'])
    assert.strictEqual(r.code, 0, r.stderr)
    assert.ok(Number(r.stdout) >= 3599, r.stdout)
    fs.rmSync(hookDir, { recursive: true, force: true })
    fs.mkdirSync(hookDir, { recursive: true })
    const miss = run(['--seconds'])
    assert.strictEqual(miss.code, 2)
    assert.strictEqual(miss.stdout, '')
    assert.ok(miss.stderr.includes('install-hooks'), miss.stderr)
  })

  // The same blindness hits the SessionStart(resume) read that feeds cache-expired/cache-state --json.
  const resume = (atMs: number): void => record('SessionStart', atMs, {
    source: 'resume', seconds_since_last_response: 100, context_tokens: 5, prompt_cache_likely_expired: true, estimated_cache_write_usd: 1.5,
  })

  test('latestResumeStaleness: file half — a resume older than the flag mtime is null, a newer one resolves', () => {
    resume(now - 3_600_000)
    assert.ok(latestResumeStaleness('sess-1'), 'unarmed: the old resume resolves')
    armFileAt(now - 60_000)
    assert.strictEqual(latestResumeStaleness('sess-1'), null)
    resume(now - 10_000)
    assert.strictEqual(latestResumeStaleness('sess-1')?.estimatedCacheWriteUsd, 1.5)
  })

  test('latestResumeStaleness: env half only — null (arm time unknown)', () => {
    resume(now - 60_000)
    assert.ok(latestResumeStaleness('sess-1'), 'unarmed: the resume resolves')
    process.env.AGENTLENS_DISABLED = '1'
    assert.strictEqual(latestResumeStaleness('sess-1'), null)
  })

  // `agentlenspro --force-install-telemetry last-compact` runs forceInstallTelemetry (autoSetup.ts) and then the verb in the SAME process;
  // the override is an in-process flag (killSwitch.ts overrideKillSwitchEnv) that stays set for the verb. It only changes what the
  // force install may repair: the hooks of the running sessions still store nothing, so the reader must still refuse.
  test('--force-install-telemetry override active + env half + flag armed + older record: still exit 2, stdout EMPTY, arm time named', () => {
    preCompact(now - 3_600_000)
    armFileAt(now - 60_000)
    process.env.AGENTLENS_DISABLED = '1'
    overrideKillSwitchEnv()
    const r = run(['--seconds'])
    assert.strictEqual(r.code, 2, r.stderr)
    assert.strictEqual(r.stdout, '')
    assert.ok(r.stderr.includes('armed at'), r.stderr)
  })

  test('--force-install-telemetry override active + AGENTLENS_DISABLED=1 only: still exit 2, and latestResumeStaleness is still null', () => {
    preCompact(now - 60_000)
    resume(now - 60_000)
    process.env.AGENTLENS_DISABLED = '1'
    overrideKillSwitchEnv()
    const r = run(['--seconds'])
    assert.strictEqual(r.code, 2, r.stderr)
    assert.strictEqual(r.stdout, '')
    assert.ok(r.stderr.includes('OWN environment'), r.stderr)
    assert.strictEqual(latestResumeStaleness('sess-1'), null)
  })
})
