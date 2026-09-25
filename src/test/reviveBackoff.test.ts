import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { reviveBackoffGate, resetReviveBackoff, reviveBackoffStatus } from '../cli/hookHandlers'

// TRDD-JJLI6GEH — hook-revive had NO health probe: the only gate between a boot crash loop and an
// unbounded spawn rate was a 15s stampede debounce, and a measured incident spawned ~40k alcore boots
// through it. reviveBackoffGate() is the crash-loop backoff this card asks for: keyed on "died within
// T seconds of being spawned" (not "died before listening" — TWDGR75R's OOM dies just AFTER listening
// and would slip past that weaker test), state kept in one file per data dir written atomically
// (temp + rename, via serverRuntime's atomicWriteFileSync), reset by a run that outlives the crash
// window OR by a manual `server start`/`restart`, and visible on stderr while holding AND via
// `agentlenspro server status` (reviveBackoffStatus).
//
// FIX b (2026-09-25) rewrote the state machine: classification (quick-death-or-not) now happens
// exactly ONCE, at the FIRST hook call that finds the previous owner dead, BEFORE any hold that
// classification produces is applied — so a hold we impose on ourselves can never leak into a LATER
// classification's elapsed-time measurement. Concretely this means a call that DETECTS a quick death
// now HOLDS IMMEDIATELY (returns true) rather than letting that same call's spawn through — the
// actual next spawn only happens once a later call finds the hold has elapsed. This is a genuine
// behavior change from the pre-fix version, so every test below is written against the NEW contract.
//
// Real fs against a real temp data dir throughout — no mocks. reviveBackoffGate() takes an explicit
// `now` so the whole state machine is driven synthetically (no real sleeping needed) while still
// exercising the real file reads/writes; tests deliberately do NOT hardcode the module's internal
// backoff constants — they only assert the STRUCTURAL properties the card requires.

suite('hook-revive crash-loop backoff (TRDD-JJLI6GEH)', () => {
  let tmp = ''
  const saved: Record<string, string | undefined> = {}
  const setEnv = (k: string, v: string) => { saved[k] = process.env[k]; process.env[k] = v }

  setup(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'al-revive-backoff-'))
    // Pin BOTH env spellings: AGENTLENS_DATA_DIR (canonical) outranks DATA_DIR, and in a FULL
    // suite run a leak of either from an earlier spec would redirect dataDir() away from tmp —
    // the gate would then read the live machine's real .revive-backoff.json (mutated by
    // running sessions' hooks) and a first-ever call could observe a genuine hold.
    setEnv('DATA_DIR', tmp)
    setEnv('AGENTLENS_DATA_DIR', tmp)
  })
  teardown(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
  })

  const statePath = () => path.join(tmp, '.revive-backoff.json')
  interface RawState { consecutiveQuickDeaths: number; lastSpawnMs: number; backoffUntilMs: number; deathClassified: boolean }
  const readState = (): RawState => JSON.parse(fs.readFileSync(statePath(), 'utf-8')) as RawState

  /** Capture stderr writes made by the gate during `fn`, without mocking fs — only process.stderr. */
  function captureStderr(fn: () => void): string {
    const orig = process.stderr.write.bind(process.stderr)
    let out = ''
    process.stderr.write = ((chunk: string | Uint8Array) => { out += chunk.toString(); return true }) as typeof process.stderr.write
    try { fn() } finally { process.stderr.write = orig }
    return out
  }

  // A far-in-the-future base, deliberately not 0/near-0 — the state's "no previous spawn" sentinel is
  // lastSpawnMs === 0, and starting near that value would make a real first spawn indistinguishable
  // from the sentinel in these assertions.
  const T0 = 10_000_000

  test('first-ever spawn: not held, records the attempt, no backoff message', () => {
    const msg = captureStderr(() => { assert.strictEqual(reviveBackoffGate(T0), false, 'nothing to back off from yet') })
    assert.strictEqual(msg, '', 'no message on a plain, non-backed-off spawn')
    const state = readState()
    assert.strictEqual(state.consecutiveQuickDeaths, 0)
    assert.strictEqual(state.lastSpawnMs, T0)
    assert.strictEqual(state.backoffUntilMs, T0, 'zero hold — backoffUntilMs equals now')
    assert.strictEqual(state.deathClassified, false, 'a fresh spawn has no death to classify yet')
  })

  test('a server that died after 20s is counted as quick; holds during the hold are not re-counted', () => {
    // Spawn #1.
    captureStderr(() => reviveBackoffGate(T0))
    assert.strictEqual(readState().deathClassified, false)

    // Server #1 died 20s later — the FIRST hook to notice classifies it immediately as a quick
    // death and HOLDS this very call (fix-b1 contract: classify, then hold — never proceed on the
    // same call that just detected a quick death).
    const deathAt = T0 + 20_000
    const msg = captureStderr(() => { assert.strictEqual(reviveBackoffGate(deathAt), true, 'a freshly-detected quick death holds immediately') })
    assert.match(msg, /reviving after 1 quick crash/, 'growth is visible in the log')
    assert.match(msg, /revive backoff.*holding off/is, 'and the hold itself is visible in the same call')
    const s1 = readState()
    assert.strictEqual(s1.consecutiveQuickDeaths, 1)
    assert.strictEqual(s1.deathClassified, true, 'classified exactly once')
    assert.strictEqual(s1.lastSpawnMs, T0, 'lastSpawnMs is untouched by classification — only a real spawn stamps it')
    const hold1 = s1.backoffUntilMs - deathAt
    assert.ok(hold1 > 0, 'a quick death must impose a non-zero hold')

    // A hook firing mid-hold must be held again, WITHOUT re-classifying (no state mutation at all).
    const heldMsg = captureStderr(() => { assert.strictEqual(reviveBackoffGate(s1.backoffUntilMs - 1), true) })
    assert.match(heldMsg, /revive backoff.*holding off/is)
    assert.match(heldMsg, /agentlenspro server start/, 'the held message names how to clear it')
    assert.doesNotMatch(heldMsg, /reviving after/, 'a held-again call must not re-announce growth')
    assert.deepStrictEqual(readState(), s1, 'a held attempt mid-hold must not mutate the recorded state')
  })

  test('after the hold, the spawn stamps lastSpawnMs, and a second 20s death grows the streak', () => {
    captureStderr(() => reviveBackoffGate(T0))
    const deathAt = T0 + 20_000
    captureStderr(() => reviveBackoffGate(deathAt)) // detects + holds
    const s1 = readState()

    // The hold elapses: this call is the actual next spawn — not held, and it stamps a fresh
    // lastSpawnMs while clearing the classification flag for the death that will follow it.
    const spawn2At = s1.backoffUntilMs
    const spawnMsg = captureStderr(() => { assert.strictEqual(reviveBackoffGate(spawn2At), false, 'the hold has elapsed — this call proceeds to spawn') })
    assert.strictEqual(spawnMsg, '', 'a plain proceed-to-spawn call prints nothing')
    const s2 = readState()
    assert.strictEqual(s2.lastSpawnMs, spawn2At, 'the new spawn is stamped at the moment the hold cleared')
    assert.strictEqual(s2.deathClassified, false, 'fresh spawn — nothing classified yet')
    assert.strictEqual(s2.consecutiveQuickDeaths, 1, 'the streak survives a plain proceed (it is not a reset)')

    // Server #2 also dies quickly, 20s later — this grows the streak to 2.
    const death2At = spawn2At + 20_000
    const growMsg = captureStderr(() => { assert.strictEqual(reviveBackoffGate(death2At), true) })
    assert.match(growMsg, /reviving after 2 quick crash/)
    const s3 = readState()
    assert.strictEqual(s3.consecutiveQuickDeaths, 2)
    const hold1 = s1.backoffUntilMs - deathAt
    const hold2 = s3.backoffUntilMs - death2At
    assert.ok(hold2 >= hold1 * 2 - 1, `the hold must (at least) double per consecutive quick death: hold1=${hold1} hold2=${hold2}`)
  })

  test('a server that died after 35 minutes, detected by the next hook at 36 minutes, RESETS the streak', () => {
    // Precondition: build up a real quick-death streak first, so a reset is actually observable.
    captureStderr(() => reviveBackoffGate(T0))
    captureStderr(() => reviveBackoffGate(T0 + 20_000)) // quick death #1, holds
    const afterHold = readState().backoffUntilMs
    captureStderr(() => reviveBackoffGate(afterHold)) // hold elapsed — spawn #2
    assert.strictEqual(readState().consecutiveQuickDeaths, 1, 'precondition: one quick death recorded, not yet reset')
    const spawn3At = readState().lastSpawnMs

    // Server #3 runs HEALTHILY for 35 minutes, then dies; the next hook only notices a minute later
    // — this is the review's exact scenario (TRDD-JJLI6GEH fix b1): a run this long must NOT be
    // folded into the crash-loop streak, however narrow the "quick death" window is sized.
    const nextHookAt = spawn3At + 36 * 60_000
    const held = captureStderr(() => { assert.strictEqual(reviveBackoffGate(nextHookAt), false, '35 minutes is not a quick death — proceeds, not held') })
    assert.strictEqual(held, '', 'a genuine reset prints no "reviving after" growth message')
    const after = readState()
    assert.strictEqual(after.consecutiveQuickDeaths, 0, 'a 35-minute run resets the streak')
    assert.strictEqual(after.lastSpawnMs, nextHookAt, 'this call is itself the next spawn')
    assert.strictEqual(after.backoffUntilMs, nextHookAt, 'zero hold after a reset')
  })

  test('`agentlenspro server status` reports an active hold via the exported reviveBackoffStatus()', () => {
    assert.strictEqual(reviveBackoffStatus(T0).holding, false, 'nothing recorded yet — no hold')

    captureStderr(() => reviveBackoffGate(T0))
    const deathAt = T0 + 20_000
    captureStderr(() => reviveBackoffGate(deathAt)) // quick death — holds
    const state = readState()

    const midHold = reviveBackoffStatus(state.backoffUntilMs - 1)
    assert.strictEqual(midHold.holding, true, 'status agrees with the gate about an active hold')
    assert.strictEqual(midHold.consecutiveQuickDeaths, 1)
    assert.strictEqual(midHold.backoffUntilMs, state.backoffUntilMs)

    const afterHold = reviveBackoffStatus(state.backoffUntilMs)
    assert.strictEqual(afterHold.holding, false, 'status agrees the hold has elapsed once it has')
  })

  test('resetReviveBackoff (the manual `server start`/`restart` hook) clears the state entirely', () => {
    captureStderr(() => reviveBackoffGate(T0))
    captureStderr(() => reviveBackoffGate(T0 + 20_000))
    assert.ok(fs.existsSync(statePath()), 'precondition: state file exists after a quick death')

    resetReviveBackoff()
    assert.ok(!fs.existsSync(statePath()), 'the state file is gone — a fresh manual start has no memory of a past crash loop')
    assert.strictEqual(reviveBackoffStatus(T0 + 21_000).holding, false, 'status agrees nothing is held after a reset')

    // The very next spawn attempt (even immediately after) is therefore NOT held and NOT counted as
    // a repeat quick death, exactly like a first-ever spawn.
    const held = reviveBackoffGate(T0 + 22_000)
    assert.strictEqual(held, false)
    assert.strictEqual(readState().consecutiveQuickDeaths, 0, 'the counter starts fresh, not carried over')
  })

  test('resetReviveBackoff is idempotent when no state file exists yet', () => {
    assert.ok(!fs.existsSync(statePath()))
    assert.doesNotThrow(() => resetReviveBackoff())
  })

  test('the state file is written atomically — no torn temp file, every field present', () => {
    captureStderr(() => reviveBackoffGate(T0))
    captureStderr(() => reviveBackoffGate(T0 + 20_000))
    // atomicWriteFileSync cleans up its temp file on success — nothing named `<file>.tmp-*` survives.
    const files = fs.readdirSync(tmp)
    assert.ok(!files.some((f) => f.includes('.tmp-')), `no leftover temp file: ${JSON.stringify(files)}`)
    const state = readState()
    assert.strictEqual(typeof state.consecutiveQuickDeaths, 'number')
    assert.strictEqual(typeof state.lastSpawnMs, 'number')
    assert.strictEqual(typeof state.backoffUntilMs, 'number')
    assert.strictEqual(typeof state.deathClassified, 'boolean')
  })

  test('a malformed state file fails OPEN (zero state) and names the file on stderr', () => {
    fs.mkdirSync(tmp, { recursive: true })
    fs.writeFileSync(statePath(), '{ not valid json')
    const msg = captureStderr(() => {
      const held = reviveBackoffGate(T0)
      assert.strictEqual(held, false, 'a corrupt file must not permanently block reviving')
    })
    assert.match(msg, /revive backoff:.*\.revive-backoff\.json.*not valid JSON/is, 'names the exact file that was discarded')
    assert.strictEqual(readState().consecutiveQuickDeaths, 0)
  })

  test('a missing state file is treated as zero state silently (no stderr noise on the common case)', () => {
    assert.ok(!fs.existsSync(statePath()))
    const msg = captureStderr(() => { assert.strictEqual(reviveBackoffGate(T0), false) })
    assert.strictEqual(msg, '', 'a first-ever read with nothing on disk yet must not print a discard warning')
  })
})
