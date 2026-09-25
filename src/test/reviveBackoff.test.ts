import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { reviveBackoffGate, resetReviveBackoff } from '../cli/hookHandlers'

// TRDD-JJLI6GEH — hook-revive had NO health probe: the only gate between a boot crash loop and an
// unbounded spawn rate was a 15s stampede debounce, and a measured incident spawned ~40k alcore boots
// through it. reviveBackoffGate() is the crash-loop backoff this card asks for: keyed on "died within
// T seconds of being spawned" (not "died before listening" — TWDGR75R's OOM dies just AFTER listening
// and would slip past that weaker test), state kept in one file per data dir written atomically
// (temp + rename, via serverRuntime's atomicWriteFileSync), reset by a run that outlives the crash
// window OR by a manual `server start`/`restart`, and visible on stderr while holding.
//
// Real fs against a real temp data dir throughout — no mocks. reviveBackoffGate() takes an explicit
// `now` so the whole state machine is driven synthetically (no real sleeping needed) while still
// exercising the real file reads/writes; tests deliberately do NOT hardcode the module's internal
// backoff/window constants — they only assert the STRUCTURAL properties the card requires.

suite('hook-revive crash-loop backoff (TRDD-JJLI6GEH)', () => {
  let tmp = ''
  const saved: Record<string, string | undefined> = {}
  const setEnv = (k: string, v: string) => { saved[k] = process.env[k]; process.env[k] = v }

  setup(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'al-revive-backoff-'))
    setEnv('DATA_DIR', tmp)
  })
  teardown(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
  })

  const statePath = () => path.join(tmp, '.revive-backoff.json')
  const readState = (): { consecutiveQuickDeaths: number; lastSpawnMs: number; backoffUntilMs: number } =>
    JSON.parse(fs.readFileSync(statePath(), 'utf-8')) as { consecutiveQuickDeaths: number; lastSpawnMs: number; backoffUntilMs: number }

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
  })

  test('a quick death backs off, growing the hold on each further consecutive quick death', () => {
    // Spawn #1.
    reviveBackoffGate(T0)
    // Spawn #2, an instant later — well inside the crash window => quick death #1.
    const msg1 = captureStderr(() => { assert.strictEqual(reviveBackoffGate(T0 + 1), false) })
    assert.match(msg1, /reviving after 1 quick crash/, 'growth is visible in the log, not just internal state')
    const s1 = readState()
    assert.strictEqual(s1.consecutiveQuickDeaths, 1)
    const hold1 = s1.backoffUntilMs - s1.lastSpawnMs
    assert.ok(hold1 > 0, 'a quick death must impose a non-zero hold')

    // While still inside that hold, the very next attempt must be HELD, not counted as a spawn, and
    // must say why AND how to clear it (the card's "must never be a silent outage" constraint).
    const heldMsg = captureStderr(() => { assert.strictEqual(reviveBackoffGate(s1.backoffUntilMs - 1), true) })
    assert.match(heldMsg, /revive backoff.*holding off/is)
    assert.match(heldMsg, /agentlenspro server start/, 'the held message names how to clear it')
    assert.deepStrictEqual(readState(), s1, 'a held attempt must not mutate the recorded state')

    // The hold elapses and a new spawn is attempted right at that moment — which, relative to spawn
    // #2, is ITSELF a quick death (elapsed since spawn #2 is exactly hold1, still inside the crash
    // window), so a single call here is both "spawn #3" and "spawn #2 died quickly" — deaths grows.
    const msg2 = captureStderr(() => { assert.strictEqual(reviveBackoffGate(s1.backoffUntilMs), false) })
    assert.match(msg2, /reviving after 2 quick crash/)
    const s2 = readState()
    assert.strictEqual(s2.consecutiveQuickDeaths, 2)
    const hold2 = s2.backoffUntilMs - s2.lastSpawnMs
    assert.ok(hold2 >= hold1 * 2 - 1, `the hold must (at least) double per consecutive quick death: hold1=${hold1} hold2=${hold2}`)
  })

  test('a run that survives long enough resets the streak to zero', () => {
    // Build up two consecutive quick deaths (see the growth test above for why each call here is
    // both "a new spawn" and "the previous spawn's death verdict").
    reviveBackoffGate(T0)
    captureStderr(() => reviveBackoffGate(T0 + 1))
    captureStderr(() => reviveBackoffGate(readState().backoffUntilMs))
    const s = readState()
    assert.strictEqual(s.consecutiveQuickDeaths, 2, 'precondition: two consecutive quick deaths recorded')

    // Wait out the current hold, spawn again, then simulate this run SURVIVING far past any crash
    // window (a huge, deliberately constant-agnostic gap) before the next hook failure notices it's
    // dead. A run that lived that long proves the install works — the streak must not survive it.
    reviveBackoffGate(s.backoffUntilMs)
    const survivedFor = 365 * 24 * 60 * 60 * 1000 // one year — exceeds any sane crash-window constant
    const held = reviveBackoffGate(readState().lastSpawnMs + survivedFor)
    assert.strictEqual(held, false, 'far past any crash window — not held')
    const after = readState()
    assert.strictEqual(after.consecutiveQuickDeaths, 0, 'a long-surviving run resets the streak')
    assert.strictEqual(after.backoffUntilMs, after.lastSpawnMs, 'zero hold after a reset')
  })

  test('resetReviveBackoff (the manual `server start`/`restart` hook) clears the state entirely', () => {
    reviveBackoffGate(T0)
    captureStderr(() => reviveBackoffGate(T0 + 1))
    assert.ok(fs.existsSync(statePath()), 'precondition: state file exists after a quick death')

    resetReviveBackoff()
    assert.ok(!fs.existsSync(statePath()), 'the state file is gone — a fresh manual start has no memory of a past crash loop')

    // The very next spawn attempt (even immediately after) is therefore NOT held and NOT counted as
    // a repeat quick death, exactly like a first-ever spawn.
    const held = reviveBackoffGate(T0 + 2)
    assert.strictEqual(held, false)
    assert.strictEqual(readState().consecutiveQuickDeaths, 0, 'the counter starts fresh, not carried over')
  })

  test('resetReviveBackoff is idempotent when no state file exists yet', () => {
    assert.ok(!fs.existsSync(statePath()))
    assert.doesNotThrow(() => resetReviveBackoff())
  })

  test('the state file is written atomically — no torn temp file, every field present', () => {
    reviveBackoffGate(T0)
    captureStderr(() => reviveBackoffGate(T0 + 1))
    // atomicWriteFileSync cleans up its temp file on success — nothing named `<file>.tmp-*` survives.
    const files = fs.readdirSync(tmp)
    assert.ok(!files.some((f) => f.includes('.tmp-')), `no leftover temp file: ${JSON.stringify(files)}`)
    const state = readState()
    assert.strictEqual(typeof state.consecutiveQuickDeaths, 'number')
    assert.strictEqual(typeof state.lastSpawnMs, 'number')
    assert.strictEqual(typeof state.backoffUntilMs, 'number')
  })

  test('a corrupt state file fails OPEN (treated as zero state), never wedges the reviver', () => {
    fs.mkdirSync(tmp, { recursive: true })
    fs.writeFileSync(statePath(), '{ not valid json')
    const held = reviveBackoffGate(T0)
    assert.strictEqual(held, false, 'a corrupt file must not permanently block reviving')
    assert.strictEqual(readState().consecutiveQuickDeaths, 0)
  })
})
