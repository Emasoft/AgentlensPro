// TRDD-RBBEX59R c2 items 4 and 8: leaving no-collection mode (`agentlenspro enable`). The enable branch choice is ONE
// pure function (enableRestartPlan) and the supervisor branch's verdict another (supervisorRespawnVerdict), so every
// branch is asserted here without a server; restartIntoCollection runs each branch against injected effects.
// (The ts-repair precondition suite moved to tsRepairBrake.test.ts in round 2.)
import * as assert from 'assert'
import * as os from 'os'
import * as path from 'path'
import { EXIT } from '../cli/cliErrors'
import { enableRestartPlan, restartIntoCollection, supervisorRespawnVerdict, type EnableRestartDeps, type EnableStats } from '../cli/disableCli'
import { noRevivePath } from '../cli/killSwitch'

const DIR = path.join(os.tmpdir(), 'al-enable-plan-dir')
const off = (over: Partial<EnableStats> = {}): EnableStats => ({ pid: 4242, dataDir: DIR, collection: 'off', startedBy: 'server start', ...over })
const base = { dir: DIR, envDir: DIR, noRevive: false, envHalfArmed: false }

suite('enable — the restart branch is one pure function of the stats answer, NO_REVIVE and the env half', () => {
  test('each no-restart case has its own plan: no answer (with and without NO_REVIVE), another dir, already on, env-dir mismatch', () => {
    assert.strictEqual(enableRestartPlan(null, base), 'no-answer', 'no server answered')
    assert.strictEqual(enableRestartPlan(null, { ...base, noRevive: true }), 'no-answer-braked', 'no server, and no revive will come')
    assert.strictEqual(enableRestartPlan(off({ collection: 'on' }), base), 'already-on', 'already collecting')
    assert.strictEqual(enableRestartPlan(off({ collection: undefined }), base), 'already-on', 'a build without the field (always collects)')
    assert.strictEqual(enableRestartPlan(off({ dataDir: '/elsewhere' }), base), 'other-dir', 'another dir\'s server')
    assert.strictEqual(enableRestartPlan(off({ dataDir: undefined }), base), 'other-dir', 'a server that reports no dir is not provably ours')
    assert.strictEqual(enableRestartPlan(off(), { ...base, envDir: '/env-default' }), 'env-dir-mismatch', 'stopServer would act on another dir')
    assert.strictEqual(enableRestartPlan(off({ collection: 'on' }), { ...base, envDir: '/env-default' }), 'already-on', 'a collecting server needs nothing, whatever the env dir')
  })
  test('NO_REVIVE is honoured: no restart', () => {
    assert.strictEqual(enableRestartPlan(off(), { ...base, noRevive: true }), 'braked')
    assert.strictEqual(enableRestartPlan(off({ startedBy: 'supervisor' }), { ...base, noRevive: true }), 'braked')
  })
  test('no restart while the env half stays armed', () => {
    assert.strictEqual(enableRestartPlan(off(), { ...base, envHalfArmed: true }), 'env-armed')
  })
  test('the supervisor branch exactly when startedBy is "supervisor"; stop-and-start otherwise', () => {
    assert.strictEqual(enableRestartPlan(off({ startedBy: 'supervisor' }), base), 'supervisor')
    for (const s of ['hook-revive', 'server start', 'setup', null, undefined, 'Supervisor', ' supervisor']) {
      assert.strictEqual(enableRestartPlan(off({ startedBy: s }), base), 'stop-and-start', String(s))
    }
  })
  test('the supervisor respawn passes only on collection "on" AND startedBy "supervisor"', () => {
    assert.strictEqual(supervisorRespawnVerdict(null), 'no-answer')
    assert.strictEqual(supervisorRespawnVerdict(off({ startedBy: 'supervisor' })), 'still-off')
    assert.strictEqual(supervisorRespawnVerdict(off({ collection: 'on', startedBy: 'hook-revive' })), 'other-starter')
    assert.strictEqual(supervisorRespawnVerdict(off({ collection: 'on', startedBy: 'supervisor' })), 'ok')
  })
})

suite('enable — restartIntoCollection carries out each branch', () => {
  /** Injected effects that record what ran; `answers` are the server-stats answers the respawn poll sees, in order. */
  const rig = (answers: (EnableStats | null)[], over: Partial<EnableRestartDeps> = {}): { deps: EnableRestartDeps; lines: string[]; ran: string[] } => {
    const lines: string[] = []
    const ran: string[] = []
    let t = 0
    const deps: EnableRestartDeps = {
      fetchStats: async () => { ran.push('stats'); return answers.length > 1 ? answers.shift() ?? null : answers[0] ?? null },
      stopServer: async () => { ran.push('stop') },
      ensureServer: async () => { ran.push('ensure') },
      parentPid: () => 777,
      sleep: async (ms) => { t += ms },
      now: () => t,
      say: (l) => { lines.push(l) },
      ...over,
    }
    return { deps, lines, ran }
  }

  test('S2: the respawned server was started by someone else — exit 1, collection is on now, both pids named, the stop warned about', async () => {
    const r = rig([off({ pid: 5151, collection: 'on', startedBy: 'hook-revive' })])
    const code = await restartIntoCollection('supervisor', off({ startedBy: 'supervisor' }), DIR, r.deps)
    assert.strictEqual(code, 1)
    const text = r.lines.join('\n')
    assert.match(text, /collection is on now/)
    assert.match(text, /pid 5151, started by "hook-revive"/, 'the serving pid and its startedBy')
    assert.match(text, /supervisor \(pid 777\)/, 'the supervisor pid, read before the stop')
    // Round 2, E: two explicit options — keep the supervisor (server stop: its respawn takes over), or drop it (kill).
    assert.match(text, /\(a\) keep the supervisor: `agentlenspro server stop` stops pid 5151 \(not the supervisor\); its next respawn, or else the next failed hook POST, takes over, collecting/)
    assert.match(text, /\(b\) drop the supervisor: kill -TERM 777; pid 5151 keeps collecting/)
    assert.deepStrictEqual(r.ran.filter(x => x !== 'stats'), ['stop'], 'the child only is stopped; nothing is spawned')
  })
  test('supervisor branch: the respawn collects under the supervisor — exit 0', async () => {
    const r = rig([off({ pid: 6, collection: 'on', startedBy: 'supervisor' })])
    assert.strictEqual(await restartIntoCollection('supervisor', off({ startedBy: 'supervisor' }), DIR, r.deps), EXIT.OK)
    assert.ok(!r.ran.includes('ensure'))
  })
  test('supervisor branch: the poll ends at the first answer for THIS dir (a foreign answer is skipped)', async () => {
    const r = rig([off({ dataDir: '/other', collection: 'on', startedBy: 'x' }), off({ pid: 6, collection: 'on', startedBy: 'supervisor' })])
    assert.strictEqual(await restartIntoCollection('supervisor', off({ startedBy: 'supervisor' }), DIR, r.deps), EXIT.OK)
  })
  test('supervisor branch: the respawn still reports "off" — exit 1, names the supervisor env', async () => {
    const r = rig([off({ startedBy: 'supervisor' })])
    assert.strictEqual(await restartIntoCollection('supervisor', off({ startedBy: 'supervisor' }), DIR, r.deps), 1)
    assert.match(r.lines.join('\n'), /still sets AGENTLENS_DISABLED=1/)
  })
  test('supervisor branch: no answer within the max backoff + 5 s — exit 1, says the respawn may still come', async () => {
    const saved = process.env.AGENTLENS_SUPERVISE_MAX_BACKOFF_MS
    process.env.AGENTLENS_SUPERVISE_MAX_BACKOFF_MS = '1000'
    try {
      const r = rig([null])
      assert.strictEqual(await restartIntoCollection('supervisor', off({ startedBy: 'supervisor' }), DIR, r.deps), 1)
      const text = r.lines.join('\n')
      assert.match(text, /did not respawn a server for .* within 6s/)
      assert.match(text, /may still come/)
      assert.ok(!r.ran.includes('ensure'), 'no server is spawned')
    } finally { if (saved === undefined) delete process.env.AGENTLENS_SUPERVISE_MAX_BACKOFF_MS; else process.env.AGENTLENS_SUPERVISE_MAX_BACKOFF_MS = saved }
  })
  test('a failed stop is reported verbatim, spawns nothing, and names the branch remedy', async () => {
    const boom = async (): Promise<void> => { throw new Error('server (pid 9) is still running 15s after SIGTERM') }
    const sup = rig([null], { stopServer: boom })
    assert.strictEqual(await restartIntoCollection('supervisor', off({ startedBy: 'supervisor' }), DIR, sup.deps), 1)
    assert.match(sup.lines.join('\n'), /still running 15s after SIGTERM[\s\S]*re-run `agentlenspro enable`/)
    const plain = rig([null], { stopServer: boom })
    assert.strictEqual(await restartIntoCollection('stop-and-start', off(), DIR, plain.deps), 1)
    assert.match(plain.lines.join('\n'), /still running 15s after SIGTERM[\s\S]*`agentlenspro server restart`/)
    assert.ok(!plain.ran.includes('ensure') && !sup.ran.includes('ensure'))
  })
  test('stop-and-start: stops, then starts', async () => {
    const r = rig([null])
    assert.strictEqual(await restartIntoCollection('stop-and-start', off(), DIR, r.deps), EXIT.OK)
    assert.deepStrictEqual(r.ran, ['stop', 'ensure'])
  })
  test('braked: exit non-zero (the env-armed code), names `agentlenspro server restart` as the deliberate override, restarts nothing', async () => {
    const b = rig([null])
    assert.strictEqual(await restartIntoCollection('braked', off(), DIR, b.deps), EXIT.UNKNOWN)
    assert.strictEqual(await restartIntoCollection('env-armed', off(), DIR, rig([null]).deps), EXIT.UNKNOWN, 'the same code as env-armed')
    assert.deepStrictEqual(b.ran, [])
    const text = b.lines.join('\n')
    assert.ok(text.includes(`NO_REVIVE brake is armed (${noRevivePath(DIR)})`), text)
    assert.match(text, /`agentlenspro server restart` is the deliberate override/)
  })
  test('each no-restart case prints its own message and restarts nothing', async () => {
    const say = async (plan: Parameters<typeof restartIntoCollection>[0], stats: EnableStats | null, over: Partial<EnableRestartDeps> = {}): Promise<{ code: number; text: string; ran: string[] }> => {
      const r = rig([null], over)
      const code = await restartIntoCollection(plan, stats, DIR, r.deps)
      return { code, text: r.lines.join('\n'), ran: r.ran }
    }
    const none = await say('no-answer', null)
    assert.strictEqual(none.code, EXIT.OK)
    assert.match(none.text, /none answered for this data dir — the next failed hook POST revives one, collecting/)
    const braked = await say('no-answer-braked', null)
    assert.strictEqual(braked.code, EXIT.OK)
    assert.match(braked.text, /NO_REVIVE brake is armed .* no hook revives one while it stands/)
    assert.match(braked.text, /`agentlenspro server start` lifts the brake/)
    const other = await say('other-dir', off({ pid: 9, dataDir: '/elsewhere' }))
    assert.strictEqual(other.code, EXIT.OK)
    assert.match(other.text, /pid 9\) is for \/elsewhere, not .* not restarted/)
    const on = await say('already-on', off({ collection: 'on' }))
    assert.strictEqual(on.code, EXIT.OK)
    assert.match(on.text, /pid 4242 already collects/)
    assert.doesNotMatch(on.text, /revived by the next hook/, 'the old message is gone')
    const mismatch = await say('env-dir-mismatch', off(), { envDir: '/env-default' })
    assert.strictEqual(mismatch.code, EXIT.UNKNOWN, 'an "off" server keeps running: not a success')
    assert.match(mismatch.text, /pid 4242 for .* keeps running in no-collection mode: this process resolves its data dir to \/env-default/)
    assert.ok(mismatch.text.includes(`Remedy: AGENTLENS_DATA_DIR=${DIR} agentlenspro enable`), mismatch.text)
    for (const r of [none, braked, other, on, mismatch]) assert.deepStrictEqual(r.ran, [], 'no stop, no start, no stats read')
  })
})
