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

// The supervisor NEVER blocks (owner order): it injects. These pin that contract, because a
// blocking supervisor could deadlock a session on a condition the agent cannot clear.
suite('reviewSupervisor — warns without ever blocking', () => {
  test('an unregistered gate names the remedy that actually works', () => {
    const m = judge({ work: 1, forks: 0, unreviewed: 1 }, false, true).message
    assert.ok(/--install-hooks/.test(m), 'a fork cannot fix a settings-derived condition; say what can')
  })

  test('spawning a fork clears the backlog — the warning is actionable', () => {
    const withFork = scanSupervision([assistant([edit]), assistant([edit]), assistant([edit]), assistant([fork])])
    assert.strictEqual(withFork.unreviewed, 0)
    assert.strictEqual(judge(withFork, true, true).level, 'ok')
  })

  test('a verdict carries no blocking instruction of any kind', () => {
    for (const v of [judge({ work: 1, forks: 0, unreviewed: 1 }, false, true),
                     judge({ work: 9, forks: 1, unreviewed: 4 }, true, true),
                     judge({ work: 2, forks: 0, unreviewed: 2 }, true, true)]) {
      assert.ok(!('decision' in v), 'the verdict must never carry a block decision')
    }
  })
})
