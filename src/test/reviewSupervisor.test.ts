import * as assert from 'assert'
import { judge, scanSupervision, gateIsRegistered, contextEvent, UNREVIEWED_ALARM } from '../cli/reviewSupervisor'
import { commandWriteReason } from '../cli/reviewGateTriggers'
import { NO_REVIEW_SENTINEL } from '../cli/reviewGate'

// The supervisor's whole purpose is to be the check that STILL WORKS when the review gate does not,
// so shipping it untested would have been the same mistake it exists to catch. Its own review said
// exactly that: "zero tests for a component whose whole purpose is to be the check that still works".

const CWD = '/proj'
const assistant = (blocks: unknown[], isSidechain = false): string =>
  JSON.stringify({ type: 'assistant', isSidechain, message: { content: blocks } })
const edit = { type: 'tool_use', name: 'Edit', input: {} }
// A BARE fork (no `ROLE: …` marker) — kept for the tests that are specifically about the FORKS
// COUNTER (case-folding), which counts any `subagent_type: "fork"` spawn whatever its role.
const fork = { type: 'tool_use', name: 'Agent', input: { subagent_type: 'fork' } }
// Owner order 2026-09-15: only a ROLE: REVIEW spawn clears the backlog — a ROLE: MEASURE spawn is
// tracked (measure agents are reviewed one level up) but does not itself count as a review here.
const measureFork = { type: 'tool_use', name: 'Agent', input: { subagent_type: 'lean-worker', prompt: 'ROLE: MEASURE\ndo it' } }
const reviewFork = { type: 'tool_use', name: 'Agent', input: { subagent_type: 'fork', prompt: 'ROLE: REVIEW\ndo it' } }
const commit = { type: 'tool_use', name: 'Bash', input: { command: 'git commit -m x' } }
const talkAboutCommit = { type: 'tool_use', name: 'Bash', input: { command: 'echo "run git commit"' } }

const settings = (cmd: string): string => JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: cmd }] }] } })

suite('reviewSupervisor — scan', () => {
  test('counts edits and commits as work, and a REVIEW spawn as a review', () => {
    const s = scanSupervision([assistant([edit]), assistant([commit]), assistant([measureFork]), assistant([reviewFork])], CWD)
    assert.deepStrictEqual(s, { work: 2, forks: 1, unreviewed: 0 })
  })

  test('a spawn whose prompt starts `ROLE: REVIEW` clears the backlog; a `ROLE: MEASURE` spawn alone does not', () => {
    const withReview = scanSupervision([assistant([edit]), assistant([reviewFork]), assistant([edit]), assistant([edit])], CWD)
    assert.strictEqual(withReview.unreviewed, 2, 'only the work AFTER the REVIEW spawn landed is unreviewed')
    assert.strictEqual(withReview.forks, 1)
    const withMeasureOnly = scanSupervision([assistant([edit]), assistant([measureFork])], CWD)
    assert.strictEqual(withMeasureOnly.unreviewed, 1, 'a MEASURE-only spawn must not clear the backlog')
    assert.strictEqual(withMeasureOnly.forks, 0, 'forks counts only a REVIEW-credited spawn, not a MEASURE one')
  })

  test('a lone, unmarked fork spawn does NOT clear the backlog — it carries no ROLE marker', () => {
    const s = scanSupervision([assistant([edit]), assistant([fork])], CWD)
    assert.strictEqual(s.unreviewed, 1, 'a bare fork carries no ROLE marker, so no role is credited')
    assert.strictEqual(s.forks, 0, 'the forks counter only counts a ROLE: REVIEW-credited spawn')
  })

  test('prose about committing is not a commit', () => {
    assert.strictEqual(scanSupervision([assistant([talkAboutCommit])], CWD).work, 0)
  })

  test('subagent (sidechain) turns are not the main agent\'s work', () => {
    assert.deepStrictEqual(scanSupervision([assistant([edit], true)], CWD), { work: 0, forks: 0, unreviewed: 0 })
  })

  test('malformed lines are skipped rather than throwing', () => {
    const s = scanSupervision(['not json', '', JSON.stringify({ type: 'user' }), assistant([edit])], CWD)
    assert.strictEqual(s.work, 1)
  })

  // TRDD-2CYTNLY1: scanSupervision now shares the gate's own work predicate (toolUseWork/textArms)
  // instead of an EDITORS set plus a bare git-commit regex — parity proved on shapes neither of the
  // old checks could ever see.
  test('parity with the gate\'s work predicate: sed -i, git push and a marked proposal count — none caught by the old EDITORS set or the git-commit-only regex', () => {
    const sed = { type: 'tool_use', name: 'Bash', input: { command: `sed -i "" s/a/b/ ${CWD}/f.ts` } }
    const push = { type: 'tool_use', name: 'Bash', input: { command: 'git push' } }
    const proposal = { type: 'text', text: 'PROPOSAL FOR ACTION - PLEASE REVIEW\nchange X to Y.' }
    const s = scanSupervision([assistant([sed]), assistant([push]), assistant([proposal])], CWD)
    assert.strictEqual(s.work, 3, 'sed -i / git push / a marked proposal must all count as work')
    // Prove the classification directly too — sed is not in the exported writer lists
    // (GIT_WRITE_SUBCOMMANDS / GH_MUTATING_VERBS / PKG_WRITE_VERBS), it is a dedicated branch in
    // reviewGateTriggers.ts's segmentWriteReason, so this is not tautological.
    assert.ok(commandWriteReason(`sed -i "" s/a/b/ ${CWD}/f.ts`, CWD) !== null, 'sed -i must classify as a write on its own')
  })

  test('scanSupervision case-folds subagent_type, like the gate\'s own scanners already do', () => {
    const capsFork = { type: 'tool_use', name: 'Agent', input: { subagent_type: 'Fork' } }
    const s = scanSupervision([assistant([edit]), assistant([capsFork])], CWD)
    // Case-folding is orthogonal to role-credit here: `capsFork` carries no ROLE marker, so
    // `unreviewed` is NOT cleared (that needs a ROLE: REVIEW credit, tested separately above).
    assert.deepStrictEqual(s, { work: 1, forks: 0, unreviewed: 1 })
  })

  test('a no-review sentinel counts as a review, like a fork — or the sentinel path would nag forever', () => {
    const sentinel = { type: 'text', text: `${NO_REVIEW_SENTINEL} — rate-limited` }
    const s = scanSupervision([assistant([edit]), assistant([sentinel])], CWD)
    assert.strictEqual(s.unreviewed, 0, 'the sentinel must clear the backlog like a fork does')
    assert.strictEqual(s.forks, 1)
  })

  test('a [janitor-heartbeat] string prompt resets unreviewed to 0 (work count unchanged)', () => {
    const heartbeat = JSON.stringify({ type: 'user', message: { role: 'user', content: '[janitor-heartbeat] findings: none' } })
    const s = scanSupervision([assistant([edit]), heartbeat], CWD)
    assert.strictEqual(s.unreviewed, 0)
    assert.strictEqual(s.work, 1)
  })

  test('an interrupt text-block entry resets unreviewed to 0 (work count unchanged)', () => {
    const interrupt = JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } })
    const s = scanSupervision([assistant([edit]), interrupt], CWD)
    assert.strictEqual(s.unreviewed, 0)
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

  test('spawning a ROLE: REVIEW fork clears the backlog — the warning is actionable', () => {
    const withFork = scanSupervision([assistant([edit]), assistant([edit]), assistant([edit]), assistant([reviewFork])], CWD)
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

// The harness pins hookEventName per event schema, so echoing an unexpected value makes the whole
// hookSpecificOutput fail validation and the injection vanish SILENTLY — the failure this component
// exists to catch, in the component itself.
suite('reviewSupervisor — the injection channel cannot be silently dropped', () => {
  const supported = ['Stop', 'SubagentStop', 'UserPromptSubmit']

  test('only events whose schema accepts additionalContext are echoed back', () => {
    for (const e of supported) assert.strictEqual(contextEvent(e), e)
  })

  test('an unsupported or empty event falls back to a channel known to work', () => {
    for (const e of ['SessionStart', 'PreToolUse', 'Bogus', '']) {
      assert.strictEqual(contextEvent(e), 'UserPromptSubmit', `${e} must not be echoed back`)
    }
  })
})
