import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  scanMainTranscriptLines, decideMainGate,
  scanSubagentTranscriptLines, decideSubagentGate, agentCannotSpawn,
  REVIEW_GATE_DIRECTIVE, ONE_TURN_RULE, MAIN_BLOCK_REASON, SUBAGENT_BLOCK_REASON,
} from '../cli/reviewGate'

// `agentlenspro review-gate` — pure decision-function tests, ported faithfully from
// ~/.claude/hooks/stop-spawn-review-fork.js and subagent-stop-spawn-review-fork.js.

const assistantLine = (blocks: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'assistant', message: { content: blocks }, ...extra })

const editBlock = { type: 'tool_use', name: 'Edit' }
const textBlock = { type: 'text', text: 'I propose changing X to Y.' }
const thinkBlock = { type: 'thinking', thinking: 'internal' }
const forkBlock = { type: 'tool_use', name: 'Agent', input: { subagent_type: 'fork' } }

suite('reviewGate — main (Stop) gate', () => {
  test('scanMainTranscriptLines finds the last edit and the last fork by index', () => {
    const lines = [assistantLine([editBlock]), assistantLine([forkBlock])]
    assert.deepStrictEqual(scanMainTranscriptLines(lines), { lastFork: 1, lastWork: 0 })
    // A PROPOSAL IS WORK. Measured on a real session JSONL, this build writes ONE ENTRY PER BLOCK,
    // so a proposing turn is a lone `text` entry with no tool_use anywhere near it — which the old
    // predicate scored as lastWork -1 (nothing claimed) and waved through.
    assert.deepStrictEqual(scanMainTranscriptLines([assistantLine([textBlock])]), { lastFork: -1, lastWork: 0 })
    assert.deepStrictEqual(
      scanMainTranscriptLines([assistantLine([textBlock]), assistantLine([forkBlock])]),
      { lastFork: 1, lastWork: 0 }, 'text then fork ⇒ reviewed')
    assert.deepStrictEqual(scanMainTranscriptLines([assistantLine([thinkBlock])]), { lastFork: -1, lastWork: -1 })
  })

  test('decideMainGate BLOCKS when the last edit is newer than the last fork', () => {
    const scan = { lastFork: 0, lastWork: 1 } // work happened AFTER the fork
    const v = decideMainGate(scan, { total: 0, consecutive: 0 }, { maxPerSession: 20, maxConsecutive: 2 })
    assert.strictEqual(v.block, true)
    assert.deepStrictEqual(v.nextState, { total: 1, consecutive: 1 })
  })

  test('decideMainGate ALLOWS when the fork is newer than (or ties) the last edit', () => {
    const scan = { lastFork: 1, lastWork: 0 } // fork happened AFTER the work
    const v = decideMainGate(scan, { total: 3, consecutive: 1 }, { maxPerSession: 20, maxConsecutive: 2 })
    assert.strictEqual(v.block, false)
    assert.deepStrictEqual(v.nextState, { total: 3, consecutive: 0 }, 'a landed fork resets the streak')
  })

  test('decideMainGate ALLOWS (no state change) when nothing was claimed this window', () => {
    const v = decideMainGate({ lastFork: -1, lastWork: -1 }, { total: 5, consecutive: 0 }, { maxPerSession: 20, maxConsecutive: 2 })
    assert.strictEqual(v.block, false)
    assert.strictEqual(v.nextState.total, 5)
  })

  test('decideMainGate KEEPS BLOCKING past the old MAX_CONSECUTIVE — no give-up', () => {
    const scan = { lastFork: -1, lastWork: 0 }
    // THE CONSECUTIVE BREAKER IS GONE (owner order 2026-09-03). It used to fail open here, which is
    // exactly how this session's gate went silent after two ignored demands and every later change
    // shipped unreviewed. The only way past is now a landed fork.
    const v = decideMainGate(scan, { total: 2, consecutive: 2 }, { maxPerSession: 20, maxConsecutive: 2 })
    assert.strictEqual(v.block, true, 'no give-up: keep demanding until a fork lands')
  })

  test('decideMainGate KEEPS BLOCKING past the old MAX_PER_SESSION — no give-up', () => {
    const scan = { lastFork: -1, lastWork: 0 }
    const v = decideMainGate(scan, { total: 20, consecutive: 0 }, { maxPerSession: 20, maxConsecutive: 2 })
    assert.strictEqual(v.block, true, 'the per-session cap is gone too')
  })
})

suite('reviewGate — subagent (SubagentStop) gate', () => {
  test('scanSubagentTranscriptLines detects an edit and a self-review independently', () => {
    assert.deepStrictEqual(scanSubagentTranscriptLines([assistantLine([editBlock])]), { didWork: true, reviewed: false })
    assert.deepStrictEqual(scanSubagentTranscriptLines([assistantLine([editBlock, forkBlock])]), { didWork: true, reviewed: true })
    assert.deepStrictEqual(scanSubagentTranscriptLines([]), { didWork: false, reviewed: false })
  })

  test('decideSubagentGate SKIPS an empty agent_type (internal micro-lookups)', () => {
    const v = decideSubagentGate('', true, { didWork: true, reviewed: false }, 0, 1)
    assert.strictEqual(v.block, false)
  })

  test('decideSubagentGate SKIPS a fork (the recursion guard)', () => {
    const v = decideSubagentGate('fork', true, { didWork: true, reviewed: false }, 0, 1)
    assert.strictEqual(v.block, false)
  })

  test('a text-only subagent return counts as work (owner order 2026-09-07: a proposal is work)', () => {
    assert.deepStrictEqual(scanSubagentTranscriptLines([assistantLine([textBlock])]), { didWork: true, reviewed: false })
    // A thinking block is NOT speech — it must not arm the gate on its own, or an agent that only
    // reasoned and then called a tool would owe a review for having thought.
    assert.deepStrictEqual(scanSubagentTranscriptLines([assistantLine([thinkBlock])]), { didWork: false, reviewed: false })
  })

  test('a built-in with no Agent tool and no definition file is RELEASED, not wedged', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-builtin-'))
    // No Explore.md is written: the point is that the ABSENT file must not mean "demand as usual".
    assert.strictEqual(agentCannotSpawn('Explore', dir), true)
    assert.strictEqual(agentCannotSpawn('Plan', dir), true)
    assert.strictEqual(agentCannotSpawn('general-purpose', dir), false, 'it HAS the Agent tool — still demanded')
  })

  test('a plugin-namespaced type is not bricked by the path-traversal guard (live outage 2026-09-07)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-ns-'))
    // Unresolvable + namespaced => RELEASED. Demanding an agent that cannot be proven able to spawn
    // is a permanent wedge; a missed review is recoverable.
    assert.strictEqual(agentCannotSpawn('fable-advisor:advisor', dir), true)
    // The traversal defence still holds — it just guards the NAME now, not the whole address.
    assert.strictEqual(agentCannotSpawn('plug:../etc/passwd', dir), false)
    assert.strictEqual(agentCannotSpawn('../etc/passwd:name', dir), false, 'a bad plugin part is rejected too')
    // A BARE unresolvable name keeps the old default (demand) — this fix changes only the namespaced case.
    assert.strictEqual(agentCannotSpawn('nosuchagent', dir), false)
    // A namespaced type whose BARE name resolves in agentsDir is parsed, not blanket-released.
    fs.writeFileSync(path.join(dir, 'known.md'), '---\ntools: Read, Agent\n---\n')
    assert.strictEqual(agentCannotSpawn('someplugin:known', dir), false, 'it HAS Agent — still demanded')
  })

  test('a child sidechain entry does not count as the parent subagent\'s work', () => {
    const child = JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [textBlock] } })
    assert.deepStrictEqual(scanSubagentTranscriptLines([child]), { didWork: false, reviewed: false })
  })

  test('agentCannotSpawn reads the agent definition: a tools line without Agent means no demand (review F2)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-agents-'))
    fs.writeFileSync(path.join(dir, 'lean.md'), '---\nname: lean\ntools: Bash, Read, Write, Edit\n---\nbody')
    fs.writeFileSync(path.join(dir, 'full.md'), '---\nname: full\ntools: Bash, Agent\n---\nbody')
    fs.writeFileSync(path.join(dir, 'star.md'), '---\nname: star\n---\ntools: Agent mentioned only in the body')
    assert.strictEqual(agentCannotSpawn('lean', dir), true)
    assert.strictEqual(agentCannotSpawn('full', dir), false)
    assert.strictEqual(agentCannotSpawn('star', dir), false, 'no tools line ⇒ unknown ⇒ demand')
    assert.strictEqual(agentCannotSpawn('missing', dir), false)
    assert.strictEqual(agentCannotSpawn('../etc/passwd', dir), false, 'a type is a bare name, never a path')
  })

  test('decideSubagentGate IGNORES the OFF switch — it cannot be disabled', () => {
    // enforceOn=false is the explicit OFF switch, no longer the default: the gate shipped
    // observe-only-unless-`on`, nothing ever set `on`, and a subagent with one Write and no fork
    // review was allowed live and on replay (TRDD-6QV50JNN). The default is now the main gate's.
    // The OFF switch is ignored now: enforceOn is voided inside the gate, so passing false changes
    // nothing. A subagent that did work and has not reviewed itself is always asked.
    const v = decideSubagentGate('lean-worker', false, { didWork: true, reviewed: false }, 0, 1)
    assert.strictEqual(v.block, true, 'the subagent OFF switch no longer disables the gate')
  })

  test('decideSubagentGate DEMANDS once for a worker that edited and has not reviewed itself', () => {
    const v = decideSubagentGate('lean-worker', true, { didWork: true, reviewed: false }, 0, 1)
    assert.strictEqual(v.block, true)
    assert.strictEqual(v.nextDemands, 1)
  })

  test('decideSubagentGate ALLOWS the second stop — the one-demand cap', () => {
    // The per-agent demand cap was REMOVED (owner order 2026-09-03: "Not even for the subagents!").
    // A worker that did work and has not reviewed itself is asked EVERY time it tries to return.
    const v = decideSubagentGate('lean-worker', true, { didWork: true, reviewed: false }, 1, 1)
    assert.strictEqual(v.block, true, 'the demand cap is gone: ask again, every time')
  })

  test('decideSubagentGate ALLOWS a worker that already spawned its own reviewer', () => {
    const v = decideSubagentGate('lean-worker', true, { didWork: true, reviewed: true }, 0, 1)
    assert.strictEqual(v.block, false)
  })

  test('decideSubagentGate ALLOWS when the worker did no consequential work', () => {
    const v = decideSubagentGate('lean-worker', true, { didWork: false, reviewed: false }, 0, 1)
    assert.strictEqual(v.block, false)
  })

  test('decideSubagentGate ALLOWS when its own transcript could not be read (scan=null)', () => {
    const v = decideSubagentGate('lean-worker', true, null, 0, 1)
    assert.strictEqual(v.block, false)
  })
})

suite('reviewGate — directive', () => {
  test('REVIEW_GATE_DIRECTIVE carries the fork-spawn instructions and the off-switch', () => {
    assert.ok(REVIEW_GATE_DIRECTIVE.includes('subagent_type: "fork"'))
    assert.ok(REVIEW_GATE_DIRECTIVE.includes('AGENTLENS_REVIEW_FORK=off'))
  })
})

// The fork reads ONLY the prompt its parent writes — never a hook's block reason. So a channel that
// states the one-turn rule to the parent without ordering it PASTED reaches the fork not at all,
// which is how six review forks took second turns and cost ~4.6M tokens (2026-09-03).
suite('reviewGate — the one-turn rule reaches the fork', () => {
  const channels: [string, string][] = [
    ['MAIN_BLOCK_REASON', MAIN_BLOCK_REASON],
    ['SUBAGENT_BLOCK_REASON', SUBAGENT_BLOCK_REASON],
    ['REVIEW_GATE_DIRECTIVE', REVIEW_GATE_DIRECTIVE],
  ]

  test('every channel carries ONE_TURN_RULE verbatim, so none can drift out of sync', () => {
    for (const [name, text] of channels) {
      assert.ok(text.includes(ONE_TURN_RULE), `${name} lost the verbatim one-turn rule`)
    }
  })

  test('every channel orders the rule COPIED VERBATIM into the fork prompt, not merely stated', () => {
    for (const [name, text] of channels) {
      assert.ok(/VERBATIM/.test(text), `${name} states the rule but never orders it pasted`)
    }
  })

  // A REGRESSION PIN FOR ONE HISTORICAL BUG — not a general carve-out guard, and it must not be
  // described as one. Measured 2026-09-03: 186 fork prompts pasted the directive's own "except a
  // single SendMessage" carve-out, and 177 of them then made exactly one tool call, buying a second
  // turn. This pins THAT regression by name. It cannot catch a carve-out that names a different
  // tool ("except one Read"), or none at all ("one verification step is permitted") — expressing
  // "the rule admits no exception" is beyond a substring test, and the earlier /except/i attempt
  // was worse: it missed re-wordings AND reddened on innocent prose like "exception handling".
  // Only the REVIEW_GATE_DIRECTIVE arm has real freedom; the other two interpolate ONE_TURN_RULE,
  // so their counts are near-guaranteed by construction. Effective new coverage is one assertion.
  const countOf = (needle: string, hay: string): number => hay.split(needle).length - 1

  test('no channel names a sanctioned tool call — the only "SendMessage" is the one being forbidden', () => {
    assert.strictEqual(countOf('SendMessage', ONE_TURN_RULE), 1, 'the rule forbids SendMessage exactly once')
    for (const [name, text] of channels) {
      assert.strictEqual(
        countOf('SendMessage', text), countOf('SendMessage', ONE_TURN_RULE),
        `${name} mentions SendMessage outside the prohibition — a named tool reads as a licence`,
      )
    }
  })
})
