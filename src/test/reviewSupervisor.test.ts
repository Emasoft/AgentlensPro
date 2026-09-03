import * as assert from 'assert'
import { judge, scanSupervision, gateIsRegistered, UNREVIEWED_ALARM } from '../cli/reviewSupervisor'

// The supervisor's whole purpose is to be the check that STILL WORKS when the review gate does not,
// so shipping it untested would have been the same mistake it exists to catch. Its own review said
// exactly that: "zero tests for a component whose whole purpose is to be the check that still works".

const assistant = (blocks: unknown[], isSidechain = false): string =>
  JSON.stringify({ type: 'assistant', isSidechain, message: { content: blocks } })
const edit = { type: 'tool_use', name: 'Edit', input: {} }
const fork = { type: 'tool_use', name: 'Agent', input: { subagent_type: 'fork' } }
const commit = { type: 'tool_use', name: 'Bash', input: { command: 'git commit -m x' } }
const talkAboutCommit = { type: 'tool_use', name: 'Bash', input: { command: 'echo "run git commit"' } }

const settings = (cmd: string): string => JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: cmd }] }] } })

suite('reviewSupervisor — scan', () => {
  test('counts edits and commits as work, and forks as reviews', () => {
    const s = scanSupervision([assistant([edit]), assistant([commit]), assistant([fork])])
    assert.deepStrictEqual(s, { work: 2, forks: 1, unreviewed: 0 })
  })

  test('a fork clears the unreviewed backlog; later work rebuilds it', () => {
    const s = scanSupervision([assistant([edit]), assistant([fork]), assistant([edit]), assistant([edit])])
    assert.strictEqual(s.unreviewed, 2, 'only the work AFTER the last fork is unreviewed')
    assert.strictEqual(s.forks, 1)
  })

  test('prose about committing is not a commit', () => {
    assert.strictEqual(scanSupervision([assistant([talkAboutCommit])]).work, 0)
  })

  test('subagent (sidechain) turns are not the main agent\'s work', () => {
    assert.deepStrictEqual(scanSupervision([assistant([edit], true)]), { work: 0, forks: 0, unreviewed: 0 })
  })

  test('malformed lines are skipped rather than throwing', () => {
    const s = scanSupervision(['not json', '', JSON.stringify({ type: 'user' }), assistant([edit])])
    assert.strictEqual(s.work, 1)
  })
})

suite('reviewSupervisor — gate registration probe', () => {
  test('finds the gate in the settings cascade', () => {
    assert.ok(gateIsRegistered(['a'], () => settings('agentlenspro review-gate')))
  })

  test('a MISSING gate is detected — the failure that started all this', () => {
    assert.ok(!gateIsRegistered(['a'], () => settings('agentlenspro hook')))
  })

  test('the supervisor itself must not be mistaken for the gate', () => {
    assert.ok(!gateIsRegistered(['a'], () => settings('agentlenspro review-supervisor')),
      'review-supervisor is not review-gate; matching it would let the gate vanish unnoticed')
  })

  test('an unreadable or unparseable settings file does not count as registered', () => {
    assert.ok(!gateIsRegistered(['a'], () => { throw new Error('EACCES') }))
    assert.ok(!gateIsRegistered(['a'], () => 'not json {'))
  })
})

suite('reviewSupervisor — judgement', () => {
  test('an unregistered gate is an ALARM, whatever the counts say', () => {
    const v = judge({ work: 0, forks: 0, unreviewed: 0 }, false, true)
    assert.strictEqual(v.level, 'alarm')
    assert.ok(/NOT REGISTERED/.test(v.message))
  })

  test('an unreviewed backlog at the threshold is an ALARM', () => {
    assert.strictEqual(judge({ work: 9, forks: 1, unreviewed: UNREVIEWED_ALARM }, true, true).level, 'alarm')
    assert.strictEqual(judge({ work: 9, forks: 1, unreviewed: UNREVIEWED_ALARM - 1 }, true, true).level, 'ok')
  })

  test('work with no review at all warns', () => {
    assert.strictEqual(judge({ work: 2, forks: 0, unreviewed: 2 }, true, true).level, 'warn')
  })

  test('a healthy session is silent', () => {
    assert.strictEqual(judge({ work: 5, forks: 3, unreviewed: 0 }, true, true).level, 'ok')
  })

  // The supervisor must never report a reassuring zero it did not measure.
  test('an unreadable transcript WARNS instead of reporting all-clear', () => {
    const v = judge({ work: 0, forks: 0, unreviewed: 0 }, true, false)
    assert.strictEqual(v.level, 'warn')
    assert.ok(/UNVERIFIED/.test(v.message))
  })

  // Its own review caught this: the scan reads a bounded TAIL, so a session-wide claim can be false.
  test('messages never claim to describe the whole session', () => {
    const msgs = [
      judge({ work: 9, forks: 1, unreviewed: 4 }, true, true).message,
      judge({ work: 2, forks: 0, unreviewed: 2 }, true, true).message,
      judge({ work: 5, forks: 3, unreviewed: 0 }, true, true).message,
    ]
    for (const m of msgs) assert.ok(!/this session/i.test(m), `claims session-wide truth from a tail scan: ${m}`)
  })
})

// The Stop-blocking branch had ZERO tests when its own review ran, which is how the wedge below
// survived to production. These cover the decision the branch makes, via `judge`'s contract.
suite('reviewSupervisor — the Stop block must always have an exit', () => {
  test('the unregistered-gate alarm is flagged as NOT fixable by spawning a fork', () => {
    const v = judge({ work: 1, forks: 0, unreviewed: 1 }, false, true)
    assert.strictEqual(v.level, 'alarm')
    assert.strictEqual(v.unsatisfiableByFork, true,
      'a settings-derived alarm cannot be cleared from the transcript; blocking on it repeatedly is a deadlock')
  })

  test('its message names the remedy that actually works, and warns off the one that does not', () => {
    const m = judge({ work: 1, forks: 0, unreviewed: 1 }, false, true).message
    assert.ok(/--install-hooks/.test(m), 'must name the fix')
    assert.ok(/will NOT/i.test(m), 'must say a fork will not clear it')
  })

  test('the backlog alarm IS fork-clearable, so it may block repeatedly', () => {
    const v = judge({ work: 9, forks: 1, unreviewed: 4 }, true, true)
    assert.strictEqual(v.level, 'alarm')
    assert.ok(!v.unsatisfiableByFork, 'a fork clears it, so repeating the block is correct')
  })

  test('spawning a fork clears the backlog — the exit is real', () => {
    const withFork = scanSupervision([assistant([edit]), assistant([edit]), assistant([edit]), assistant([fork])])
    assert.strictEqual(withFork.unreviewed, 0)
    assert.strictEqual(judge(withFork, true, true).level, 'ok')
  })
})
