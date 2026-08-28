import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  scanMainTranscriptLines, decideMainGate,
  scanSubagentTranscriptLines, decideSubagentGate, agentCannotSpawn,
  REVIEW_GATE_DIRECTIVE,
} from '../cli/reviewGate'

// `agentlenspro review-gate` — pure decision-function tests, ported faithfully from
// ~/.claude/hooks/stop-spawn-review-fork.js and subagent-stop-spawn-review-fork.js.

const assistantLine = (blocks: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'assistant', message: { content: blocks }, ...extra })

const editBlock = { type: 'tool_use', name: 'Edit' }
const forkBlock = { type: 'tool_use', name: 'Agent', input: { subagent_type: 'fork' } }

suite('reviewGate — main (Stop) gate', () => {
  test('scanMainTranscriptLines finds the last edit and the last fork by index', () => {
    const lines = [assistantLine([editBlock]), assistantLine([forkBlock])]
    assert.deepStrictEqual(scanMainTranscriptLines(lines), { lastFork: 1, lastWork: 0 })
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

  test('decideMainGate fails OPEN once MAX_CONSECUTIVE is reached with no fork landing', () => {
    const scan = { lastFork: -1, lastWork: 0 }
    const v = decideMainGate(scan, { total: 2, consecutive: 2 }, { maxPerSession: 20, maxConsecutive: 2 })
    assert.strictEqual(v.block, false, 'the breaker must allow rather than wedge the session')
  })

  test('decideMainGate fails OPEN once MAX_PER_SESSION is reached', () => {
    const scan = { lastFork: -1, lastWork: 0 }
    const v = decideMainGate(scan, { total: 20, consecutive: 0 }, { maxPerSession: 20, maxConsecutive: 2 })
    assert.strictEqual(v.block, false)
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

  test('decideSubagentGate never blocks when enforcement is switched OFF (AGENTLENS_SUBAGENT_REVIEW=off)', () => {
    // enforceOn=false is the explicit OFF switch, no longer the default: the gate shipped
    // observe-only-unless-`on`, nothing ever set `on`, and a subagent with one Write and no fork
    // review was allowed live and on replay (TRDD-6QV50JNN). The default is now the main gate's.
    const v = decideSubagentGate('lean-worker', false, { didWork: true, reviewed: false }, 0, 1)
    assert.strictEqual(v.block, false)
  })

  test('decideSubagentGate DEMANDS once for a worker that edited and has not reviewed itself', () => {
    const v = decideSubagentGate('lean-worker', true, { didWork: true, reviewed: false }, 0, 1)
    assert.strictEqual(v.block, true)
    assert.strictEqual(v.nextDemands, 1)
  })

  test('decideSubagentGate ALLOWS the second stop — the one-demand cap', () => {
    const v = decideSubagentGate('lean-worker', true, { didWork: true, reviewed: false }, 1, 1)
    assert.strictEqual(v.block, false, 'a worker already asked once must not be asked again')
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
