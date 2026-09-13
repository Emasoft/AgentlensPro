import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import {
  scanMainTranscriptLines, decideMainGate, applyEffects,
  scanSubagentTranscriptLines, decideSubagentGate, agentCannotSpawn, declaredToolsHaveAgent,
  REVIEW_GATE_DIRECTIVE, REVIEW_ROLE_RULE, MEASURE_ROLE_RULE, mainBlockReason, scanPositions, hookCwd,
  SUBAGENT_BLOCK_REASON, NO_REVIEW_SENTINEL, NO_REVIEW_SENTINEL_EXAMPLES, REVIEWER_AGENT_TYPES,
  runMainGate, runReviewGate, forkRole, resultRole, MEASURE_HEADING, REVIEW_HEADING,
} from '../cli/reviewGate'

// `agentlenspro review-gate` — pure decision-function tests, ported faithfully from
// ~/.claude/hooks/stop-spawn-review-fork.js and subagent-stop-spawn-review-fork.js.

// One representative instance; the message's cause-naming is tested on its own below.
const MAIN_BLOCK_REASON = mainBlockReason('edit', 'Edit x.ts')

const assistantLine = (blocks: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'assistant', message: { content: blocks }, ...extra })

const CWD = '/proj'
const editBlock = { type: 'tool_use', name: 'Edit', input: { file_path: '/proj/src/x.ts' } }
const bashBlock = (command: string) => ({ type: 'tool_use', name: 'Bash', input: { command } })
// A MARKED proposal is work; the same sentence as prose is not (owner order 2026-09-08).
const proposalBlock = { type: 'text', text: 'PROPOSAL: change X to Y.' }
const proseBlock = { type: 'text', text: 'I propose changing X to Y.' }
const thinkBlock = { type: 'thinking', thinking: 'internal' }
const forkBlock = { type: 'tool_use', name: 'Agent', input: { subagent_type: 'fork' } }
// `lastForkTs` is always 0 across this suite's fixtures: none of them stamps a `timestamp` field,
// so `entryTs` (fail-closed default) returns 0 for every entry.
// `roles` stays {-1,-1} across this file's plain fixtures: none of them carries a `ROLE: …`
// marker or a heading, so neither role is ever credited — the two-role suites below build their
// own fixtures for that.
const NO_ROLES = { measure: -1, review: -1 }
const nothing = { lastFork: -1, lastForkTs: 0, work: null, roles: NO_ROLES }
// `activity` (TRDD-3U8AIHXK) is exercised by its own suite below — these fixtures assert
// lastFork/lastForkTs/work only, so a `tool_use` fixture's incidental activity entries never
// need to be spelled out here.
const dropActivity = (s: ReturnType<typeof scanMainTranscriptLines>): Omit<typeof s, 'activity'> => {
  const { activity: _activity, ...rest } = s
  return rest
}

suite('reviewGate — main (Stop) gate', () => {
  test('scanMainTranscriptLines: an edit, a marked proposal and a write-shaped command arm; prose, a heartbeat and reads do not', () => {
    assert.deepStrictEqual(dropActivity(scanMainTranscriptLines([assistantLine([editBlock]), assistantLine([forkBlock])], CWD)),
      { lastFork: 1, lastForkTs: 0, work: { index: 0, cause: 'edit', detail: 'Edit x.ts' }, roles: NO_ROLES })
    // Measured on a real session JSONL, this build writes ONE ENTRY PER BLOCK, so a proposing turn
    // is a lone `text` entry with no tool_use anywhere near it.
    assert.deepStrictEqual(dropActivity(scanMainTranscriptLines([assistantLine([proposalBlock])], CWD)),
      { lastFork: -1, lastForkTs: 0, work: { index: 0, cause: 'proposal text', detail: '' }, roles: NO_ROLES })
    // `forkBlock` carries no `prompt`, so it is a bare spawn with no ROLE marker — it still sets
    // `lastFork` (unchanged) but credits neither role (that needs a `ROLE: MEASURE`/`ROLE: REVIEW`
    // marker — see the two-role suites below).
    assert.deepStrictEqual(dropActivity(scanMainTranscriptLines([assistantLine([proposalBlock]), assistantLine([forkBlock])], CWD)),
      { lastFork: 1, lastForkTs: 0, work: { index: 0, cause: 'proposal text', detail: '' }, roles: NO_ROLES }, 'proposal then a bare (unroled) fork spawn')
    assert.deepStrictEqual(dropActivity(scanMainTranscriptLines([assistantLine([bashBlock('git commit -m x')])], CWD)),
      { lastFork: -1, lastForkTs: 0, work: { index: 0, cause: 'write-shaped command', detail: 'git commit' }, roles: NO_ROLES })
    // THE LIVELOCK (TRDD-0E3W5C45). For one day every text block was work, so a heartbeat's
    // mandated `janitor heartbeat` line armed the gate and every reply to the block re-armed it —
    // ~40 blocked turns and 5 forks over zero edits. None of these is work:
    for (const turn of [
      [proseBlock], [thinkBlock],
      [bashBlock('/x/dispatcher-stub.py 2>&1'), { type: 'text', text: 'janitor heartbeat' }],
      [bashBlock('grep -rn foo /proj/src')],
      [{ type: 'tool_use', name: 'Write', input: { file_path: '/private/tmp/claude-1/s/x.py' } }],
    ]) {
      assert.deepStrictEqual(dropActivity(scanMainTranscriptLines([assistantLine(turn)], CWD)), nothing, JSON.stringify(turn).slice(0, 80))
    }
  })

  test('a NotebookEdit follows the same ephemeral-root rule, and the hook cwd comes from the input', () => {
    const nb = (notebook_path: string) => ({ type: 'tool_use', name: 'NotebookEdit', input: { notebook_path } })
    assert.deepStrictEqual(dropActivity(scanMainTranscriptLines([assistantLine([nb('/proj/n.ipynb')])], CWD)),
      { lastFork: -1, lastForkTs: 0, work: { index: 0, cause: 'edit', detail: 'NotebookEdit n.ipynb' }, roles: NO_ROLES })
    assert.deepStrictEqual(dropActivity(scanMainTranscriptLines([assistantLine([nb('/tmp/n.ipynb')])], CWD)), nothing)
    assert.strictEqual(hookCwd({ cwd: '/elsewhere' }), '/elsewhere')
    assert.strictEqual(hookCwd({ cwd: '' }), process.cwd(), 'an empty cwd falls back, it is not a root')
    assert.strictEqual(hookCwd({}), process.cwd())
  })

  test('the block message names the actual arming cause and the scanned window, not "this turn"', () => {
    assert.ok(mainBlockReason('proposal text').includes('PROPOSAL'))
    assert.ok(!mainBlockReason('proposal text').includes('edited'))
    assert.ok(mainBlockReason('write-shaped command', 'git push').includes('git push'))
    assert.ok(!mainBlockReason('edit', 'Write y.md').includes('this turn'),
      'the scan is over a bounded transcript TAIL, never "this turn" — matches reviewSupervisor\'s own care')
    assert.strictEqual(
      mainBlockReason('edit', 'Write y.md').startsWith(
        'Review-fork gate: edited a file: Write y.md landed after the last review fork '
        + '(scanned: the transcript\'s last 4 MB). '), true)
  })

  test('the window text names the DISK scan for "unreviewed change" — a different scan than the transcript', () => {
    assert.strictEqual(
      mainBlockReason('unreviewed change', 'src/a.ts').startsWith(
        'Review-fork gate: left unreviewed changes on disk: src/a.ts landed after the last review fork '
        + '(scanned: files on disk newer than that fork). '), true)
    assert.ok(!mainBlockReason('unreviewed change', 'src/a.ts').includes("transcript's last 4 MB"),
      'unreviewed change comes from the mtime walk, not the transcript tail')
  })

  test('decideMainGate BLOCKS when the last edit is newer than both roles', () => {
    const scan = { roles: { measure: 0, review: 0 }, lastWork: 1 } // work happened AFTER both roles were credited
    const v = decideMainGate(scan)
    assert.strictEqual(v.block, true)
  })

  test('decideMainGate ALLOWS when both roles are credited newer than (or tie) the last edit', () => {
    const scan = { roles: { measure: 1, review: 1 }, lastWork: 0 } // both roles credited AFTER the work
    const v = decideMainGate(scan)
    assert.strictEqual(v.block, false)
  })

  test('decideMainGate ALLOWS when nothing was claimed this window', () => {
    const v = decideMainGate({ roles: { measure: -1, review: -1 }, lastWork: -1 })
    assert.strictEqual(v.block, false)
  })

  // NO BREAKER STATE (TRDD-2CYTNLY1 amendment 8): `MainBreakerState`/`total`/`consecutive` were
  // deleted — they were read every call, then discarded, and decided nothing once the give-up path
  // was removed below. These two titles are KEPT so a reintroduced breaker still has a named test
  // to break, even though `decideMainGate` now takes no state argument at all.
  test('decideMainGate KEEPS BLOCKING past the old MAX_CONSECUTIVE — no give-up', () => {
    const scan = { roles: { measure: -1, review: -1 }, lastWork: 0 }
    // THE CONSECUTIVE BREAKER IS GONE (owner order 2026-09-03). It used to fail open here, which is
    // exactly how this session's gate went silent after two ignored demands and every later change
    // shipped unreviewed. The only way past is now both roles landing.
    const v = decideMainGate(scan)
    assert.strictEqual(v.block, true, 'no give-up: keep demanding until both roles land')
  })

  test('decideMainGate KEEPS BLOCKING past the old MAX_PER_SESSION — no give-up', () => {
    const scan = { roles: { measure: -1, review: -1 }, lastWork: 0 }
    const v = decideMainGate(scan)
    assert.strictEqual(v.block, true, 'the per-session cap is gone too')
  })

  test('scanMainTranscriptLines case-folds subagent_type, like the subagent scanner already does', () => {
    const capsForkBlock = { type: 'tool_use', name: 'Agent', input: { subagent_type: 'Fork' } }
    const scan = scanMainTranscriptLines([assistantLine([editBlock]), assistantLine([capsForkBlock])], CWD)
    assert.strictEqual(scan.lastFork, 1, 'a subagent_type of "Fork" must still count as the fork')
  })
})

// ── scanMainTranscriptLines — activity (TRDD-3U8AIHXK) ────────────────────────────────────────────
// Synthetic JSONL lines with real ISO `timestamp`s, over the shapes measured on this project's own
// session JSONL (2026-09-10): a tool_use/tool_result pair, a background job's launch + exit, and
// the harness's own `attachment` / `queue-operation` / string-content-`user` notification shapes.
suite('scanMainTranscriptLines — activity (TRDD-3U8AIHXK)', () => {
  const iso = (offsetMs: number): string => new Date(1_800_000_000_000 + offsetMs).toISOString()
  const toolUse = (ts: string, id: string, name: string, input: Record<string, unknown> = {}): string =>
    JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id, name, input }] } })
  const toolResult = (ts: string, toolUseId: string, content: unknown): string =>
    JSON.stringify({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] } })
  const attachment = (ts: string, taskId: string): string =>
    JSON.stringify({ type: 'attachment', timestamp: ts, attachment: { x: `<task-id>${taskId}</task-id>` } })
  const queueOp = (ts: string, taskId: string): string =>
    JSON.stringify({ type: 'queue-operation', timestamp: ts, note: `<task-id>${taskId}</task-id>` })
  const stringUser = (ts: string, text: string): string =>
    JSON.stringify({ type: 'user', timestamp: ts, message: { content: text } })

  test('(i) a tool_use/tool_result pair yields one interval {start, end}', () => {
    const A = iso(0); const B = iso(1000)
    const scan = scanMainTranscriptLines([toolUse(A, 't1', 'Bash', { command: 'ls' }), toolResult(B, 't1', 'ok')])
    assert.deepStrictEqual(scan.activity, [{ start: Date.parse(A), end: Date.parse(B) }])
  })

  test('(ii) a background Bash job stays open past its result, closes on the matching attachment', () => {
    const A = iso(0); const B = iso(1000); const C = iso(5000)
    const withoutAttachment = scanMainTranscriptLines([
      toolUse(A, 't1', 'Bash', { command: 'python3 long_task.py' }),
      toolResult(B, 't1', 'Command running in background with ID: job1. Output …'),
    ])
    assert.strictEqual(withoutAttachment.activity[0].end, Infinity)
    const withAttachment = scanMainTranscriptLines([
      toolUse(A, 't1', 'Bash', { command: 'python3 long_task.py' }),
      toolResult(B, 't1', 'Command running in background with ID: job1. Output …'),
      attachment(C, 'job1'),
    ])
    assert.strictEqual(withAttachment.activity[0].end, Date.parse(C))
  })

  test('(iii) only an attachment or a string-content user entry closes a job — never an array-content result or a queue-operation', () => {
    const A = iso(0); const B = iso(1000)
    const arrayQuote = iso(2000); const queueQuote = iso(3000); const D = iso(4000)
    const opened = [
      toolUse(A, 't1', 'Bash', { command: 'python3 long_task.py' }),
      toolResult(B, 't1', 'Command running in background with ID: job1. Output …'),
      toolResult(arrayQuote, 'unrelated', 'quoting <task-id>job1</task-id>'), // array-content — never closes
    ]
    // A queue-operation naming the id ALONE must not close it — the discriminating assertion
    // caught here: without it, this test passed even when queue-operation closed the interval.
    const afterQueueOp = scanMainTranscriptLines([...opened, queueOp(queueQuote, 'job1')])
    assert.strictEqual(afterQueueOp.activity[0].end, Infinity)
    // Only the string-content user entry — the real exit notification — closes it.
    const afterStringUser = scanMainTranscriptLines([...opened, queueOp(queueQuote, 'job1'), stringUser(D, 'closing note <task-id>job1</task-id>')])
    assert.strictEqual(afterStringUser.activity[0].end, Date.parse(D))
  })

  test('(iv) a foreground tool whose result merely CONTAINS launch-shaped text closes at its own result', () => {
    const A = iso(0); const B = iso(1000)
    // A Bash result reading "agentId: zzz" — the Bash branch never looks for agentId at all.
    const bash = scanMainTranscriptLines([toolUse(A, 't1', 'Bash', { command: 'echo hi' }), toolResult(B, 't1', 'agentId: zzz\n')])
    assert.strictEqual(bash.activity[0].end, Date.parse(B))
    // A Read result quoting the Bash launch line — Read is neither Bash nor Agent.
    const read = scanMainTranscriptLines([toolUse(A, 't1', 'Read', {}), toolResult(B, 't1', 'Command running in background with ID: q9')])
    assert.strictEqual(read.activity[0].end, Date.parse(B))
    // An Agent result naming an agentId WITHOUT the launched-text anchor — not recognized as a launch.
    const agent = scanMainTranscriptLines([toolUse(A, 't1', 'Agent', {}), toolResult(B, 't1', 'agentId: q7')])
    assert.strictEqual(agent.activity[0].end, Date.parse(B))
    // A BASH result carrying BOTH the Agent launch phrase and an agentId — the Bash branch is
    // keyed on the OPENING tool_use's own name, never on the result text alone, so it still
    // closes at its own result rather than being mistaken for an Agent-launched background job.
    const bashWithAgentText = scanMainTranscriptLines([
      toolUse(A, 't1', 'Bash', { command: 'echo hi' }),
      toolResult(B, 't1', 'Async agent launched successfully. agentId: b9'),
    ])
    assert.strictEqual(bashWithAgentText.activity[0].end, Date.parse(B))
  })

  test('(v) a BACKGROUND review fork stays open past its own result, closes on its task-id attachment', () => {
    const A = iso(0); const B = iso(1000); const C = iso(5000)
    const scan = scanMainTranscriptLines([
      toolUse(A, 't1', 'Agent', { subagent_type: 'fork' }),
      toolResult(B, 't1', 'Async agent launched successfully. agentId: f1'),
      attachment(C, 'f1'),
    ])
    assert.strictEqual(scan.lastFork, 0, 'the fork tool_use still sets lastFork')
    assert.strictEqual(scan.activity[0].end, Date.parse(C))
  })

  test('(vi) a tool_result with an unknown tool_use_id opens {start: firstTs, end: resultTs} — unless its text IS a launch, then it stays open too', () => {
    const first = iso(0); const B = iso(1000); const C = iso(5000)
    // A leading text-only entry (no tool_use, no activity of its own) sets firstTs before the
    // unknown-id result arrives, so start !== end and the fallback is visibly exercised.
    const lead = JSON.stringify({ type: 'assistant', timestamp: first, message: { content: [{ type: 'text', text: 'hi' }] } })
    const plain = scanMainTranscriptLines([lead, toolResult(B, 'unknown-id', 'ok')])
    assert.deepStrictEqual(plain.activity, [{ start: Date.parse(first), end: Date.parse(B) }])
    // The unknown-id result whose text STARTS the Bash launch line stays open until its attachment
    // — `backgroundJobId` is tried with tool '*' when the opener is unknown (TRDD-3U8AIHXK).
    const launching = scanMainTranscriptLines([lead, toolResult(B, 'unknown-id', 'Command running in background with ID: q1'), attachment(C, 'q1')])
    assert.strictEqual(launching.activity[0].end, Date.parse(C))
  })

  test('(vii) a detached job (nohup / trailing & / mid-line &) stays open past its result; a chain, a query string and a redirect close normally', () => {
    const A = iso(0); const B = iso(1000)
    for (const command of ['nohup ./x.sh &', './x.sh &', '( sleep 5; touch x ) & echo started']) {
      const scan = scanMainTranscriptLines([toolUse(A, 't1', 'Bash', { command }), toolResult(B, 't1', 'started')])
      assert.strictEqual(scan.activity[0].end, Infinity, command)
    }
    for (const command of ['a && b', "curl 'http://x/?a=1&b=2'", 'cmd 2>&1']) {
      const scan = scanMainTranscriptLines([toolUse(A, 't1', 'Bash', { command }), toolResult(B, 't1', 'ok')])
      assert.strictEqual(scan.activity[0].end, Date.parse(B), command)
    }
  })

  test('(viii) a tool_use with no result stays open (Infinity), fail closed', () => {
    const scan = scanMainTranscriptLines([toolUse(iso(0), 't1', 'Bash', { command: 'ls' })])
    assert.deepStrictEqual(scan.activity, [{ start: Date.parse(iso(0)), end: Infinity }])
  })
})

// ── lastForkTs — the timestamp `unreviewedEffects` is anchored to (TRDD-9FG0LSPG) ─────────────────
suite('reviewGate — scanMainTranscriptLines: lastForkTs', () => {
  test('lastForkTs is the fork entry\'s own top-level timestamp, in ms', () => {
    const forkTs = '2026-09-09T11:42:09.715Z'
    const scan = scanMainTranscriptLines([
      assistantLine([editBlock], { timestamp: '2026-09-09T11:00:00.000Z' }),
      assistantLine([forkBlock], { timestamp: forkTs }),
    ], CWD)
    assert.strictEqual(scan.lastForkTs, Date.parse(forkTs))
  })

  test('no fork in the window ⇒ lastForkTs falls back to the FIRST parsed entry\'s timestamp', () => {
    const firstTs = '2026-09-09T11:00:00.000Z'
    const scan = scanMainTranscriptLines([
      assistantLine([editBlock], { timestamp: firstTs }),
      assistantLine([bashBlock('git push')], { timestamp: '2026-09-09T12:00:00.000Z' }),
    ], CWD)
    assert.strictEqual(scan.lastFork, -1)
    assert.strictEqual(scan.lastForkTs, Date.parse(firstTs), 'the FIRST entry, not the last, sets the fallback')
  })

  test('an absent or unparsable timestamp fails CLOSED to 0, never to "now"', () => {
    // No `timestamp` field at all on the fork entry:
    const noField = scanMainTranscriptLines([assistantLine([forkBlock])], CWD)
    assert.strictEqual(noField.lastForkTs, 0)
    // A field that is present but not a valid date string:
    const bad = scanMainTranscriptLines([assistantLine([forkBlock], { timestamp: 'not-a-date' })], CWD)
    assert.strictEqual(bad.lastForkTs, 0)
    // No fork, and the first entry has no timestamp either:
    const noForkNoField = scanMainTranscriptLines([assistantLine([editBlock])], CWD)
    assert.strictEqual(noForkNoField.lastForkTs, 0)
  })
})

// ── applyEffects — folding `unreviewedEffects()` into the scan (TRDD-9FG0LSPG) ─────────────────────
suite('reviewGate — applyEffects', () => {
  const baseScan = { lastFork: 3, lastForkTs: 1000, work: null, activity: [], roles: NO_ROLES }

  test('no existing work + unreviewed paths ⇒ arms at lastFork + 1 with cause "unreviewed change"', () => {
    const out = applyEffects(baseScan, { paths: ['src/a.ts'], truncated: false })
    assert.deepStrictEqual(out, { lastFork: 3, lastForkTs: 1000, work: { index: 4, cause: 'unreviewed change', detail: 'src/a.ts' }, activity: [], roles: NO_ROLES })
  })

  test('an existing text arm strictly after the last fork is KEPT, not overwritten', () => {
    const scanWithArm = { lastFork: 3, lastForkTs: 1000, work: { index: 5, cause: 'proposal text' as const, detail: '' }, activity: [], roles: NO_ROLES }
    const out = applyEffects(scanWithArm, { paths: ['src/a.ts', 'src/b.ts'], truncated: false })
    assert.deepStrictEqual(out, scanWithArm, 'both arms would block identically — keep the more specific one')
  })

  test('truncated with zero paths still arms, and the detail names the truncation', () => {
    const out = applyEffects(baseScan, { paths: [], truncated: true })
    assert.strictEqual(out.work?.cause, 'unreviewed change')
    assert.ok(out.work?.detail.startsWith('walk truncated'), out.work?.detail)
  })

  test('more than 8 paths: the detail lists 8 and an overflow count', () => {
    const paths = Array.from({ length: 12 }, (_, i) => `f${i}.ts`)
    const out = applyEffects(baseScan, { paths, truncated: false })
    assert.strictEqual(out.work?.detail, `${paths.slice(0, 8).join(', ')} (+4 more)`)
  })

  test('empty effects (no paths, not truncated) leave the scan unchanged, BY REFERENCE', () => {
    const out = applyEffects(baseScan, { paths: [], truncated: false })
    assert.strictEqual(out, baseScan, 'must be the SAME object, not merely deep-equal')
  })

  test('(ix) folding paths in preserves the SAME activity array — the fold never touches attribution', () => {
    const out = applyEffects(baseScan, { paths: ['src/a.ts'], truncated: false })
    assert.strictEqual(out.activity, baseScan.activity, 'must be the SAME array, not a copy')
  })
})

// ── mainBlockReason names the new cause (TRDD-9FG0LSPG) ────────────────────────────────────────────
suite('reviewGate — mainBlockReason: unreviewed change', () => {
  test('names the cause and lists the path', () => {
    assert.ok(mainBlockReason('unreviewed change', 'src/a.ts').includes('left unreviewed changes on disk: src/a.ts'))
  })
})

suite('reviewGate — subagent (SubagentStop) gate', () => {
  test('scanSubagentTranscriptLines detects an edit and a self-review independently', () => {
    assert.deepStrictEqual(scanSubagentTranscriptLines([assistantLine([editBlock])]), { didWork: true, reviewed: false, ownRole: null })
    assert.deepStrictEqual(scanSubagentTranscriptLines([assistantLine([editBlock, forkBlock])]), { didWork: true, reviewed: true, ownRole: null })
    assert.deepStrictEqual(scanSubagentTranscriptLines([]), { didWork: false, reviewed: false, ownRole: null })
  })

  test('decideSubagentGate SKIPS an empty agent_type (internal micro-lookups)', () => {
    const v = decideSubagentGate('', { didWork: true, reviewed: false })
    assert.strictEqual(v.block, false)
  })

  test('decideSubagentGate SKIPS a fork (the recursion guard)', () => {
    const v = decideSubagentGate('fork', { didWork: true, reviewed: false })
    assert.strictEqual(v.block, false)
  })

  test('a MARKED proposal in a subagent return is work; plain prose is not (owner orders 2026-09-07/08)', () => {
    assert.deepStrictEqual(scanSubagentTranscriptLines([assistantLine([proposalBlock])]), { didWork: true, reviewed: false, ownRole: null })
    assert.deepStrictEqual(scanSubagentTranscriptLines([assistantLine([proseBlock])]), { didWork: false, reviewed: false, ownRole: null })
    // The subagent gate shares the tool_use classifier: a write-shaped command is work, a Write into
    // the scratchpad is not. Without these two, commenting out the shared branch stays green here.
    assert.deepStrictEqual(scanSubagentTranscriptLines([assistantLine([bashBlock('sed -i "" s/a/b/ f')])], CWD), { didWork: true, reviewed: false, ownRole: null })
    assert.deepStrictEqual(
      scanSubagentTranscriptLines([assistantLine([{ type: 'tool_use', name: 'Write', input: { file_path: '/tmp/x' } }])], CWD),
      { didWork: false, reviewed: false, ownRole: null })
    // A thinking block is NOT speech — it must not arm the gate on its own, or an agent that only
    // reasoned and then called a tool would owe a review for having thought.
    assert.deepStrictEqual(scanSubagentTranscriptLines([assistantLine([thinkBlock])]), { didWork: false, reviewed: false, ownRole: null })
  })

  test('scanSubagentTranscriptLines case-folds subagent_type, like the main scanner already does', () => {
    const capsForkBlock = { type: 'tool_use', name: 'Agent', input: { subagent_type: 'Fork' } }
    assert.deepStrictEqual(scanSubagentTranscriptLines([assistantLine([editBlock, capsForkBlock])]),
      { didWork: true, reviewed: true, ownRole: null }, 'a subagent_type of "Fork" must still count as the fork')
  })

  test('a lean-worker whose OWN prompt declares ROLE: REVIEW is exempt from the subagent gate (C3/C6)', () => {
    const own = [
      JSON.stringify({ type: 'user', message: { content: 'ROLE: REVIEW\nAttack the proposal.' } }),
      assistantLine([editBlock]),
    ]
    const scan = scanSubagentTranscriptLines(own, CWD)
    assert.strictEqual(scan.ownRole, 'review')
    assert.strictEqual(decideSubagentGate('lean-worker', scan).block, false, 'a REVIEW-marked agent must not be told to spawn its own reviewer')
  })

  test('a lean-worker whose OWN prompt declares ROLE: MEASURE is NOT exempt — MEASURE has an unbounded tool budget and must itself be reviewed (owner correction C6)', () => {
    const own = [
      JSON.stringify({ type: 'user', message: { content: 'ROLE: MEASURE\nSettle the assumptions.' } }),
      assistantLine([editBlock]),
    ]
    const scan = scanSubagentTranscriptLines(own, CWD)
    assert.strictEqual(scan.ownRole, 'measure')
    assert.strictEqual(decideSubagentGate('lean-worker', scan).block, true, 'exempting MEASURE would let its writes through unreviewed')
  })

  test('an UNROLED lean-worker is still gated — C3/C6 exempt an announced role, not every lean-worker', () => {
    const own = [
      JSON.stringify({ type: 'user', message: { content: 'Go do some ordinary work.' } }),
      assistantLine([editBlock]),
    ]
    const scan = scanSubagentTranscriptLines(own, CWD)
    assert.strictEqual(scan.ownRole, null)
    assert.strictEqual(decideSubagentGate('lean-worker', scan).block, true)
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
    const emptyCache = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-cache-'))
    // Unresolvable + namespaced => RELEASED. Demanding an agent that cannot be proven able to spawn
    // is a permanent wedge; a missed review is recoverable.
    // A VISIBLY-FAKE namespace, and an EMPTY cache passed explicitly. The previous version named a
    // really-installed plugin and let the resolver read the developer's own ~/.claude/plugins/cache,
    // so its outcome depended on machine state — it would have flipped if that plugin ever shipped
    // `Agent` in its tools. A test that consults the machine is not a test of the code.
    assert.strictEqual(agentCannotSpawn('nosuchplugin:nosuchagent', dir, emptyCache), true, 'unresolvable + namespaced ⇒ released, never wedged')
    // The traversal defence still holds — it just guards the NAME now, not the whole address.
    assert.strictEqual(agentCannotSpawn('plug:../etc/passwd', dir, emptyCache), false)
    assert.strictEqual(agentCannotSpawn('../etc/passwd:name', dir, emptyCache), false, 'a bad plugin part is rejected too')
    // A BARE unresolvable name keeps the old default (demand) — this fix changes only the namespaced case.
    assert.strictEqual(agentCannotSpawn('nosuchagent', dir, emptyCache), false)
    // A namespaced type whose BARE name resolves in agentsDir is parsed, not blanket-released.
    fs.writeFileSync(path.join(dir, 'known.md'), '---\ntools: Read, Agent\n---\n')
    assert.strictEqual(agentCannotSpawn('someplugin:known', dir, emptyCache), false, 'agentsDir is the FALLBACK when the cache has nothing')
  })

  test('the plugin cache OUTRANKS a same-named user agent, and the NEWEST version wins', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-p-'))
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-c-'))
    const mk = (v: string, tools: string, whenMs: number): void => {
      const d = path.join(cache, 'mp', 'plug', v, 'agents')
      fs.mkdirSync(d, { recursive: true })
      const f = path.join(d, 'a.md')
      fs.writeFileSync(f, `---\ntools: ${tools}\n---\n`)
      fs.utimesSync(f, whenMs / 1000, whenMs / 1000)
    }
    // A user agent of the SAME bare name claims the Agent tool. If agentsDir won, `plug:a` would be
    // DEMANDED a fork it cannot spawn — the outage, recreated through a name collision.
    fs.writeFileSync(path.join(dir, 'a.md'), '---\ntools: Read, Agent\n---\n')
    mk('3.4.14', 'Read, Bash', Date.parse('2026-01-01T00:00:00Z'))
    assert.strictEqual(agentCannotSpawn('plug:a', dir, cache), true, 'the plugin definition wins over the same-named local one')
    // '3.4.1' sorts FIRST lexicographically but is older; only mtime picks the installed one.
    mk('3.4.1', 'Read, Agent', Date.parse('2020-01-01T00:00:00Z'))
    assert.strictEqual(agentCannotSpawn('plug:a', dir, cache), true, 'stale 3.4.1 must not outrank 3.4.14')
    fs.utimesSync(path.join(cache, 'mp', 'plug', '3.4.1', 'agents', 'a.md'), Date.now() / 1000, Date.now() / 1000)
    assert.strictEqual(agentCannotSpawn('plug:a', dir, cache), false, 'newest now HAS Agent ⇒ demanded')
  })

  test('every built-in that lacks the Agent tool is released, not just Explore and Plan', () => {
    // A built-in has NO definition file, so it lands on `text === null` → `plugin !== ''`, which for
    // a BARE name is false ⇒ DEMAND ⇒ a fork it cannot spawn. Two real ones were wedged that way;
    // tool lists verified against the live agent listing 2026-09-07.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-bi-'))
    for (const n of ['Explore', 'Plan', 'claude-code-guide', 'statusline-setup']) {
      assert.strictEqual(agentCannotSpawn(n, empty), true, `${n} has no Agent tool ⇒ must be released`)
    }
    // The counter-case: a built-in that DOES hold `*` must still be demanded, or the set is just a
    // blanket release for every unresolvable name and the gate stops covering built-ins at all.
    assert.strictEqual(agentCannotSpawn('general-purpose', empty), false,
      'general-purpose holds * ⇒ it can spawn ⇒ still demanded')
  })

  test('an unreadable newest candidate falls through to the next, it does not discard them all', () => {
    // `statSync` succeeds on a DIRECTORY, so a directory named `a.md` sorts into the candidate list
    // as the newest entry and then throws on read. Abandoning there discarded every OTHER version
    // that would have read fine. The two outcomes are distinguishable only because the readable
    // older file declares Agent: fall-through ⇒ DEMAND (false); give-up ⇒ text null ⇒ RELEASE (true).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-p2-'))
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-c2-'))
    const old = path.join(cache, 'mp', 'plug', '1.0.0', 'agents')
    fs.mkdirSync(old, { recursive: true })
    fs.writeFileSync(path.join(old, 'a.md'), '---\ntools: Read, Agent\n---\n')
    fs.utimesSync(path.join(old, 'a.md'), Date.parse('2020-01-01T00:00:00Z') / 1000, Date.parse('2020-01-01T00:00:00Z') / 1000)
    fs.mkdirSync(path.join(cache, 'mp', 'plug', '2.0.0', 'agents', 'a.md'), { recursive: true })
    assert.strictEqual(agentCannotSpawn('plug:a', dir, cache), false,
      'the readable older version decides; an unreadable newest one is skipped, not fatal')
  })

  test('a child sidechain entry does not count as the parent subagent\'s work', () => {
    const child = JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [proposalBlock] } })
    assert.deepStrictEqual(scanSubagentTranscriptLines([child]), { didWork: false, reviewed: false, ownRole: null })
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

  test('the tools parse handles *, All tools, an except clause, and a YAML block list', () => {
    // THE OLD ONE-LINE REGEX RELEASED ALL OF THESE. It looked for the literal `Agent` inside
    // whatever the `tools:` line itself captured — which is `*` for an all-tools agent and nothing
    // at all for a block list, whose value lives on the lines below. Each miss silently SKIPPED a
    // review for an agent that could have run one: the directive's exact inverse, and unlike a
    // wedge it never announces itself. Found independently by two reviews, 2026-09-07.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-tools-'))
    const def = (n: string, tools: string) => {
      fs.writeFileSync(path.join(dir, `${n}.md`), `---\nname: ${n}\n${tools}\n---\nbody`)
      return n
    }
    assert.strictEqual(agentCannotSpawn(def('star', 'tools: *'), dir), false, '* includes Agent ⇒ demand')
    assert.strictEqual(agentCannotSpawn(def('all', 'tools: All tools'), dir), false)
    assert.strictEqual(
      agentCannotSpawn(def('most', 'tools: All tools except Agent, Artifact'), dir), true,
      'the except clause takes Agent back out ⇒ release')
    assert.strictEqual(
      agentCannotSpawn(def('blockyes', 'tools:\n  - Read\n  - Agent'), dir), false,
      'a block list naming Agent ⇒ demand')
    assert.strictEqual(agentCannotSpawn(def('blockno', 'tools:\n  - Read\n  - Bash'), dir), true)
    assert.strictEqual(agentCannotSpawn(def('flow', 'tools: [Read, Agent]'), dir), false)
    assert.strictEqual(
      agentCannotSpawn(def('qstar', 'tools: "*"'), dir), false,
      'the QUOTED form is the only YAML-legal one — bare * is an alias node, i.e. a syntax error')
    assert.strictEqual(
      agentCannotSpawn(def('someexcept', 'tools: All tools except Artifact, ExitPlanMode'), dir), false,
      'an except clause that does not name Agent leaves Agent in ⇒ demand')
    // A BLOCK LIST STOPS AT THE FIRST NON-ITEM LINE, so a later key's own list can never be read as
    // this one's — without that bound, any `- Agent` further down the frontmatter would count.
    assert.strictEqual(declaredToolsHaveAgent('tools:\n  - Read\nmodel: x\nother:\n  - Agent\n'), false)
    assert.strictEqual(declaredToolsHaveAgent('name: x\nmodel: y\n'), null, 'no tools key ⇒ unknown, not empty')
  })

  test('every shape that could WEDGE an agent releases instead', () => {
    // WIDENING THE PARSE MADE MISPARSES DANGEROUS. The old regex could only fail to FIND Agent, so
    // its errors all fell toward release; this one infers Agent from `*` and from a list, so a
    // misparse can DEMAND a fork from an agent that cannot spawn one — permanent, and silent until
    // something hangs. These four are the shapes that would do it. Found by review, 2026-09-07.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-wedge-'))
    const write = (n: string, body: string) => {
      fs.writeFileSync(path.join(dir, `${n}.md`), body)
      return n
    }
    assert.strictEqual(
      agentCannotSpawn(write('caps', '---\nname: caps\nTools: Read, Bash\n---\nbody'), dir), true,
      'a capital Tools: key must not fall through to demand')
    assert.strictEqual(
      agentCannotSpawn(write('prose', 'No frontmatter here.\n\ntools:\n  - Read\n  - Agent\n'), dir), true,
      'an unfenced file is not a definition — its prose must never be parsed as a declaration')
    assert.strictEqual(
      declaredToolsHaveAgent('tools: All tools, except-handler, Agent'), true,
      'a tool NAMED except-handler is not an except clause — Agent is still declared')
    assert.strictEqual(
      declaredToolsHaveAgent('tools: [Read, "Agent"]'), true, 'quoted items are stripped')
    assert.strictEqual(
      declaredToolsHaveAgent('tools: All tools, except Artifact, Agent'), false,
      'the comma form is still an except clause — Agent IS excepted here')
  })

  test('frontmatter shapes that a byte-exact fence check would have broken', () => {
    // THE FIRST GUARD I WROTE WAS A REGRESSION. `startsWith("---\\n")` released every CRLF file, every
    // BOM file, and every `--- ` with a trailing space — all three parsed CORRECTLY before it, so it
    // converted right answers into silent skipped reviews. It also missed the wedge it was written
    // for: the body-prose hole comes from a missing CLOSING fence, which an opening-fence check
    // cannot see. Normalizing and requiring both fences is what actually closes it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-fence-'))
    const write = (n: string, body: string) => { fs.writeFileSync(path.join(dir, `${n}.md`), body); return n }
    assert.strictEqual(
      agentCannotSpawn(write('crlf', '---\r\nname: crlf\r\ntools: Read, Agent\r\n---\r\nbody'), dir), false,
      'a CRLF definition still declares Agent ⇒ demand')
    assert.strictEqual(
      agentCannotSpawn(write('bom', '﻿---\nname: bom\ntools: Read, Bash\n---\nbody'), dir), true,
      'a BOM must not decide the verdict')
    assert.strictEqual(
      agentCannotSpawn(write('pad', '--- \nname: pad\ntools: Read, Agent\n---\nbody'), dir), false,
      'a trailing space on the fence must not decide the verdict')
    assert.strictEqual(
      agentCannotSpawn(write('unclosed', '---\nname: unclosed\nmodel: x\n\ntools:\n  - Agent\n'), dir), true,
      'no CLOSING fence ⇒ the body is not frontmatter ⇒ release, never wedge')
  })

  test('decideSubagentGate DEMANDS a worker that did work and has not reviewed itself', () => {
    const v = decideSubagentGate('lean-worker', { didWork: true, reviewed: false })
    assert.strictEqual(v.block, true)
  })

  test('decideSubagentGate demands again on a repeat call with the same scan — no per-agent cap, no OFF switch (owner order 2026-09-03: "Not even for the subagents!")', () => {
    // There is no enforcement switch and no per-agent demand cap left in the signature at all — a
    // worker that did work and has not reviewed itself is asked EVERY time it tries to return, and
    // there is no counter to exhaust that would ever change the answer.
    const scan = { didWork: true, reviewed: false }
    assert.strictEqual(decideSubagentGate('lean-worker', scan).block, true)
    assert.strictEqual(decideSubagentGate('lean-worker', scan).block, true, 'identical input, still demanded')
  })

  test('decideSubagentGate ALLOWS a worker that already spawned its own reviewer', () => {
    const v = decideSubagentGate('lean-worker', { didWork: true, reviewed: true })
    assert.strictEqual(v.block, false)
  })

  test('decideSubagentGate ALLOWS when the worker did no consequential work', () => {
    const v = decideSubagentGate('lean-worker', { didWork: false, reviewed: false })
    assert.strictEqual(v.block, false)
  })

  test('decideSubagentGate ALLOWS when its own transcript could not be read (scan=null)', () => {
    const v = decideSubagentGate('lean-worker', null)
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
// states a role rule to the parent without ordering it PASTED reaches the fork not at all, which is
// how six review forks took second turns and cost ~4.6M tokens (2026-09-03).
suite('reviewGate — both role rules reach both agents', () => {
  const channels: [string, string][] = [
    ['MAIN_BLOCK_REASON', MAIN_BLOCK_REASON],
    ['SUBAGENT_BLOCK_REASON', SUBAGENT_BLOCK_REASON],
    ['REVIEW_GATE_DIRECTIVE', REVIEW_GATE_DIRECTIVE],
  ]

  test('every channel carries BOTH REVIEW_ROLE_RULE and MEASURE_ROLE_RULE verbatim, so none can drift out of sync', () => {
    for (const [name, text] of channels) {
      assert.ok(text.includes(REVIEW_ROLE_RULE), `${name} lost the verbatim review-role rule`)
      assert.ok(text.includes(MEASURE_ROLE_RULE), `${name} lost the verbatim measure-role rule`)
    }
  })

  test('every channel orders the rule COPIED VERBATIM into the agent prompt, not merely stated', () => {
    for (const [name, text] of channels) {
      assert.ok(/VERBATIM/.test(text), `${name} states the rule but never orders it pasted`)
    }
  })

  // REPLACES the old countOf('SendMessage', ...) regression pin (2026-09-03: 186 fork prompts
  // pasted a "except a single SendMessage" carve-out and 177 then made exactly one tool call). That
  // ban on NAMING a tool no longer fits: the MEASURE role now has a deliberate, unbounded tool
  // budget (owner correction C4), so a channel that says "READ-ONLY" and names `tldr`/`llm-ext`/
  // `distill` is correct, not a leak. What still matters is that every channel publishes BOTH
  // headings (so an agent complying with either role can be recognized) and states the measure
  // role's read-only constraint.
  test('every channel names both role headings, and states the measure role is read-only', () => {
    for (const [name, text] of channels) {
      assert.ok(text.includes(MEASURE_HEADING), `${name} omits the MEASURE heading`)
      assert.ok(text.includes(REVIEW_HEADING), `${name} omits the REVIEW heading`)
      assert.ok(/READ-ONLY/.test(text), `${name} no longer states the measure role is read-only`)
    }
  })
})

// ── forkRole / resultRole — two-role identification (owner spec 2026-09-13) ───────────────────────
suite('reviewGate — forkRole / resultRole: two-role identification', () => {
  test('forkRole: exactly one ROLE marker credits that role; both or neither credits neither', () => {
    assert.strictEqual(forkRole('ROLE: MEASURE\ndo the thing'), 'measure')
    assert.strictEqual(forkRole('ROLE: REVIEW\ndo the thing'), 'review')
    assert.strictEqual(forkRole('ROLE: MEASURE\nROLE: REVIEW\n'), null, 'both markers ⇒ null')
    assert.strictEqual(forkRole('just a plain prompt'), null, 'neither marker ⇒ null')
    assert.strictEqual(forkRole('see ROLE: MEASURE above, then do X'), null, 'a marker mid-line is not an anchored marker LINE')
  })

  test('resultRole: exactly one heading credits that role; both or neither credits neither', () => {
    assert.strictEqual(resultRole(`${MEASURE_HEADING}\n\nfindings...`), 'measure')
    assert.strictEqual(resultRole(`${REVIEW_HEADING}\n\nfindings...`), 'review')
    assert.strictEqual(resultRole(`${MEASURE_HEADING}\n${REVIEW_HEADING}\n`), null, 'both headings ⇒ null')
    assert.strictEqual(resultRole('just some prose about the gate'), null)
    assert.strictEqual(resultRole(`## ${MEASURE_HEADING}\n\nfindings...`), 'measure', 'a markdown heading prefix still credits')
    assert.strictEqual(resultRole(`**${REVIEW_HEADING}**\n\nfindings...`), 'review', 'bold punctuation prefix still credits')
    // C2: the punctuation class is HORIZONTAL whitespace only (`[#*\t ]`, never `\s`) — `\s` would
    // span lines and let a heading buried after a blank line still "start" a line under the anchor.
    assert.strictEqual(resultRole(`some prose\n\n${MEASURE_HEADING}`), 'measure', 'the heading itself still starts ITS OWN line')
  })
})

// ── two-role gate: SPAWN-while-pending vs RESULT-permanent (owner correction 2026-09-13, C5) ──────
//
// C1 (an earlier design) said a spawn credit expires once a LATER string-content `user` entry
// appears — but that entry shape also covers a `[janitor-heartbeat]` fire, the owner typing
// mid-turn, and the gate's own `Stop hook feedback:` block message, so a single block would have
// been self-sustaining. C5 retracts C1: a spawn credits its role only while its own tool_use is
// still OPEN (no tool_result / task-id notification landed yet); a RESULT credits its role
// permanently, whatever the heading says.
suite('reviewGate — two-role gate: SPAWN-while-pending, RESULT-permanent (C5)', () => {
  const toolUse = (ts: string, id: string, name: string, input: Record<string, unknown> = {}): string =>
    JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id, name, input }] } })
  const toolResult = (ts: string, toolUseId: string, content: unknown): string =>
    JSON.stringify({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] } })
  const iso = (offsetMs: number): string => new Date(1_800_000_000_000 + offsetMs).toISOString()

  test('(C5-1) spawn both, no results yet, work BEFORE them ⇒ RELEASE — the launching turn releases its own Stop', () => {
    const lines = [
      assistantLine([editBlock]), // work at index 0
      toolUse(iso(1000), 'm1', 'Agent', { subagent_type: 'lean-worker', prompt: 'ROLE: MEASURE\nsettle it' }), // index 1
      toolUse(iso(2000), 'r1', 'Agent', { subagent_type: 'fork', prompt: 'ROLE: REVIEW\nattack it' }), // index 2
    ]
    const scan = scanMainTranscriptLines(lines, CWD)
    assert.strictEqual(scan.roles.measure, 1, 'still open ⇒ the spawn credits it')
    assert.strictEqual(scan.roles.review, 2, 'still open ⇒ the spawn credits it')
    assert.strictEqual(decideMainGate(scanPositions(scan)).block, false)
  })

  test('(C5-2) spawn both, BOTH results land carrying their headings ⇒ RELEASE', () => {
    const lines = [
      assistantLine([editBlock]),
      toolUse(iso(1000), 'm1', 'Agent', { subagent_type: 'lean-worker', prompt: 'ROLE: MEASURE\nsettle it' }),
      toolUse(iso(2000), 'r1', 'Agent', { subagent_type: 'fork', prompt: 'ROLE: REVIEW\nattack it' }),
      toolResult(iso(3000), 'm1', `${MEASURE_HEADING}\n\nASSUMPTION 1: ... VERDICT: confirmed`),
      toolResult(iso(4000), 'r1', `${REVIEW_HEADING}\n\nno findings`),
    ]
    const scan = scanMainTranscriptLines(lines, CWD)
    assert.strictEqual(scan.roles.measure, 3, 'the RESULT decides once it lands, permanently')
    assert.strictEqual(scan.roles.review, 4)
    assert.strictEqual(decideMainGate(scanPositions(scan)).block, false)
  })

  test('(C5-3) spawn both, ONE result lands WITHOUT its heading ⇒ BLOCK — returning is not enough, the heading is', () => {
    const lines = [
      assistantLine([editBlock]),
      toolUse(iso(1000), 'm1', 'Agent', { subagent_type: 'lean-worker', prompt: 'ROLE: MEASURE\nsettle it' }),
      toolUse(iso(2000), 'r1', 'Agent', { subagent_type: 'fork', prompt: 'ROLE: REVIEW\nattack it' }),
      toolResult(iso(3000), 'm1', `${MEASURE_HEADING}\n\nASSUMPTION 1: ... VERDICT: confirmed`),
      toolResult(iso(4000), 'r1', 'looks fine to me'), // returned, but WITHOUT the heading
    ]
    const scan = scanMainTranscriptLines(lines, CWD)
    assert.strictEqual(scan.roles.measure, 3)
    assert.strictEqual(scan.roles.review, -1, 'returned without the heading ⇒ no credit, spawn credit is also gone (it is no longer open)')
    assert.strictEqual(decideMainGate(scanPositions(scan)).block, true)
  })

  test('(C5-4) a [janitor-heartbeat] / "Stop hook feedback:" string-content user entry between the spawns and the Stop does NOT change the verdict — the retracted C1 bug, pinned', () => {
    const heartbeat = JSON.stringify({ type: 'user', message: { content: '[janitor-heartbeat]\nfindings: none' } })
    const feedback = JSON.stringify({ type: 'user', message: { content: `Stop hook feedback:\n${MEASURE_HEADING}\n${REVIEW_HEADING}` } })
    for (const noise of [heartbeat, feedback]) {
      const lines = [
        assistantLine([editBlock]),
        toolUse(iso(1000), 'm1', 'Agent', { subagent_type: 'lean-worker', prompt: 'ROLE: MEASURE\nsettle it' }),
        toolUse(iso(2000), 'r1', 'Agent', { subagent_type: 'fork', prompt: 'ROLE: REVIEW\nattack it' }),
        noise,
      ]
      const scan = scanMainTranscriptLines(lines, CWD)
      assert.strictEqual(scan.roles.measure, 1, `noise line changed the measure verdict: ${noise.slice(0, 40)}`)
      assert.strictEqual(scan.roles.review, 2, `noise line changed the review verdict: ${noise.slice(0, 40)}`)
      assert.strictEqual(decideMainGate(scanPositions(scan)).block, false, `noise line flipped the gate: ${noise.slice(0, 40)}`)
    }
  })

  // C8: the gate's OWN block message must publish "ROLE: MEASURE"/"ROLE: REVIEW" and both headings
  // (so agents can comply), and it lands in the transcript as a string-content `user` entry. If the
  // result-credit scan read ANY such entry, the gate would credit both roles from its own output and
  // release itself. Gated on the task-id tag (and a redundant `Stop hook feedback:` exclusion) —
  // this is the test that would catch either guard going missing.
  test('(C8) the gate\'s own block message (no task-id tag) never credits a role, even though it quotes both headings verbatim', () => {
    const ownBlockMessage = JSON.stringify({
      type: 'user',
      message: { content: `Stop hook feedback: COPY THIS LINE VERBATIM INTO THE MEASURE PROMPT: "ROLE: MEASURE ... ${MEASURE_HEADING} ..." COPY THIS LINE VERBATIM INTO THE REVIEW PROMPT: "ROLE: REVIEW ... ${REVIEW_HEADING} ..."` },
    })
    const additionalContext = JSON.stringify({
      type: 'user',
      message: { content: `[review-supervisor] before returning spawn ROLE: MEASURE and ROLE: REVIEW, headings ${MEASURE_HEADING} / ${REVIEW_HEADING}` },
    })
    for (const line of [ownBlockMessage, additionalContext]) {
      const scan = scanMainTranscriptLines([assistantLine([editBlock]), line], CWD)
      assert.strictEqual(scan.roles.measure, -1, `the gate's own output credited MEASURE: ${line.slice(0, 60)}`)
      assert.strictEqual(scan.roles.review, -1, `the gate's own output credited REVIEW: ${line.slice(0, 60)}`)
    }
  })
})

// ── THE NO-REVIEW SENTINEL — the only exit from either gate that does not require spawning ──────
//
// Why these exist: the demand used to instruct a wedged agent to "state that in one line and
// return", but that statement is a `text` block, which re-arms the very predicate that produced
// the demand. Complying reproduced the demand over a longer transcript, forever. Every test below
// fails if the sentinel stops being recognized, is matched as a substring, or is accepted without
// a reason — the three ways the fix silently turns back into the bug.
suite('review-gate: the no-review sentinel', () => {
  const sentinelLine = (reason = 'rate-limited, cannot spawn') =>
    ({ type: 'text', text: `${NO_REVIEW_SENTINEL} — ${reason}` })

  test('a subagent that emits the sentinel is released — the documented compliance path terminates', () => {
    // The exact sequence the block reason instructs: work, then the sentinel.
    const scan = scanSubagentTranscriptLines([
      assistantLine([proposalBlock]),
      assistantLine([sentinelLine()]),
    ])
    assert.strictEqual(scan.reviewed, true, 'sentinel must set reviewed or the demand repeats forever')
    assert.deepStrictEqual(
      decideSubagentGate('lean-worker', scan),
      { block: false },
    )
  })

  test('without the sentinel that same transcript is blocked — proving the release came from it', () => {
    // The discriminating control. Without this, the test above passes for any reason at all.
    const scan = scanSubagentTranscriptLines([
      assistantLine([proposalBlock]),
      assistantLine([{ type: 'text', text: 'I cannot spawn a reviewer, sorry.' }]),
    ])
    assert.strictEqual(scan.reviewed, false)
    assert.strictEqual(decideSubagentGate('lean-worker', scan).block, true)
  })

  test('the main gate honours the sentinel as its last block', () => {
    const scan = scanMainTranscriptLines([
      assistantLine([proposalBlock]),
      assistantLine([sentinelLine()]),
    ])
    const pos = scanPositions(scan)
    assert.ok(Math.min(pos.roles.measure, pos.roles.review) >= pos.lastWork, 'sentinel must satisfy the positional rule for BOTH roles')
    assert.strictEqual(decideMainGate(pos).block, false)
  })

  test('prose after the sentinel re-arms the main gate, exactly as prose after a fork does', () => {
    const scan = scanMainTranscriptLines([
      assistantLine([sentinelLine()]),
      assistantLine([proposalBlock]),
    ])
    assert.strictEqual(decideMainGate(scanPositions(scan)).block, true)
  })

  test('a QUOTED sentinel does not release — a reviewer discussing the gate must not free its subject', () => {
    // This is not hypothetical: the forks that reviewed this very file quoted the sentinel in their
    // findings. A substring test would have released the agent under review.
    for (const text of [
      `> ${NO_REVIEW_SENTINEL} — quoted in a markdown blockquote`,
      `# ${NO_REVIEW_SENTINEL} — as a heading`,
      `The agent may emit ${NO_REVIEW_SENTINEL} — mid-prose, which must not count.`,
      `Here is the rule:\n${NO_REVIEW_SENTINEL} — on a later line of the same block.`,
    ]) {
      const scan = scanSubagentTranscriptLines([assistantLine([proposalBlock]), assistantLine([{ type: 'text', text }])])
      assert.strictEqual(scan.reviewed, false, `quoted/embedded sentinel released the gate: ${text.slice(0, 40)}`)
    }
  })

  test('the sentinel without a reason does not release — "I cannot" must stay a statement, not a magic word', () => {
    for (const text of [NO_REVIEW_SENTINEL, `${NO_REVIEW_SENTINEL} — `, `${NO_REVIEW_SENTINEL} — ab`]) {
      const scan = scanSubagentTranscriptLines([assistantLine([proposalBlock]), assistantLine([{ type: 'text', text }])])
      assert.strictEqual(scan.reviewed, false, `bare sentinel released the gate: ${JSON.stringify(text)}`)
    }
  })

  test('the sentinel followed by an essay does not release — the block reason promises nothing after it', () => {
    // The positional rule only covers prose in a SEPARATE block, whose own index re-arms `lastWork`.
    // Prose on a later LINE of the SAME block carries no index and cannot re-arm anything, and one
    // text block is exactly how a model emits contiguous prose — so this was the LIKELY shape, not
    // the unlikely one. Before the trailing-line check, every case below released the gate.
    for (const text of [
      `${NO_REVIEW_SENTINEL} — depth limit reached\n\nAnyway, here is what I changed and why...`,
      `${NO_REVIEW_SENTINEL} — tool denied\nI went ahead and edited four files.`,
      `${NO_REVIEW_SENTINEL} — rate limited\n\n## Findings\n\n1. ...`,
    ]) {
      const sub = scanSubagentTranscriptLines([assistantLine([proposalBlock]), assistantLine([{ type: 'text', text }])])
      assert.strictEqual(sub.reviewed, false, `sentinel-then-essay released the subagent gate: ${JSON.stringify(text.slice(0, 50))}`)
      const main = scanMainTranscriptLines([assistantLine([proposalBlock]), assistantLine([{ type: 'text', text }])])
      assert.strictEqual(
        decideMainGate(scanPositions(main)).block,
        true,
        `sentinel-then-essay released the main gate: ${JSON.stringify(text.slice(0, 50))}`,
      )
    }
  })

  test('trailing blank lines after the reason are still a release — whitespace is not an essay', () => {
    for (const text of [`${NO_REVIEW_SENTINEL} — depth limit reached\n`, `${NO_REVIEW_SENTINEL} — depth limit reached\n\n   \n`]) {
      const scan = scanSubagentTranscriptLines([assistantLine([{ type: 'text', text }])])
      assert.strictEqual(scan.reviewed, true, `trailing whitespace wrongly rejected: ${JSON.stringify(text)}`)
    }
  })

  test('the separator may be an em-dash, a hyphen or a colon — an agent that obeyed in substance is not re-wedged', () => {
    for (const sep of ['—', '-', ':']) {
      const scan = scanSubagentTranscriptLines([
        assistantLine([{ type: 'text', text: `${NO_REVIEW_SENTINEL} ${sep} depth limit reached` }]),
      ])
      assert.strictEqual(scan.reviewed, true, `separator ${sep} was rejected`)
    }
  })

  test('the reason floor accepts every canonical example the gate\'s own message offers, and rejects a token like "foo"', () => {
    // Adversarial review 2026-09-10: a proposed ">=12 chars AND a space" floor rejected two of the
    // three examples the block message itself hands out ("rate-limited" has no space, "tool denied"
    // is 11 chars) — a rejected sentinel leaves the agent that emitted it with no exit from the gate.
    for (const reason of NO_REVIEW_SENTINEL_EXAMPLES) {
      const scan = scanSubagentTranscriptLines([assistantLine([{ type: 'text', text: `${NO_REVIEW_SENTINEL} — ${reason}` }])])
      assert.strictEqual(scan.reviewed, true, `canonical example reason rejected: ${JSON.stringify(reason)}`)
    }
    const scan = scanSubagentTranscriptLines([assistantLine([{ type: 'text', text: `${NO_REVIEW_SENTINEL} — foo` }])])
    assert.strictEqual(scan.reviewed, false, '"foo" must not satisfy the reason floor')
  })

  test('both block reasons tell the agent the escape exists — an unnamed exit is not an exit', () => {
    for (const [name, reason] of [['MAIN', MAIN_BLOCK_REASON], ['SUBAGENT', SUBAGENT_BLOCK_REASON]] as const) {
      assert.ok(reason.includes(NO_REVIEW_SENTINEL), `${name}_BLOCK_REASON omits the sentinel`)
    }
    assert.ok(
      !SUBAGENT_BLOCK_REASON.includes('asked once'),
      'the "asked once" promise is false — there is no per-agent demand cap, so nothing enforces it',
    )
  })

  test('the shape both block reasons INSTRUCT is a shape the predicate ACCEPTS', () => {
    // The test above only asserts the strings mention the sentinel — it passes identically whether
    // they say "FIRST line", "ENTIRE reply", or nothing coherent at all. That is why a mismatch
    // survived twice: 05fa9128 made the sentinel valid only as a whole block while both strings
    // still said "make the FIRST line ... " (which in plain language permits more lines), and the
    // first repair overcorrected to "your ENTIRE reply" — unsatisfiable for a main agent whose
    // reply already contains tool_use blocks, since the predicate reads one TEXT BLOCK, not a reply.
    // Instruction and predicate are two halves of one contract, and an agent that obeys the half it
    // is shown must pass the half it is judged by. This test is the only thing that holds them
    // together: tighten the predicate without touching the strings, or reword the strings out of the
    // predicate's units, and it goes red.
    for (const [name, reason] of [['MAIN', MAIN_BLOCK_REASON], ['SUBAGENT', SUBAGENT_BLOCK_REASON]] as const) {
      const quoted = reason.match(/"(REVIEW-GATE: NO REVIEW POSSIBLE[^"]*)"/)
      assert.ok(quoted, `${name}_BLOCK_REASON must QUOTE the exact sentinel form it demands`)
      const instructed = quoted[1].replace('<reason>', 'depth limit reached')
      const scan = scanSubagentTranscriptLines([assistantLine([{ type: 'text', text: instructed }])])
      assert.strictEqual(
        scan.reviewed,
        true,
        `${name}_BLOCK_REASON instructs a shape the predicate REJECTS, which wedges any agent that obeys it: ${JSON.stringify(instructed)}`,
      )
    }
  })
})

// ── THE RECURSION GUARD — whole-token, never a substring ────────────────────────────────────────
suite('review-gate: the recursion guard exempts reviewers and nothing else', () => {
  const workScan = { didWork: true, reviewed: false }

  test('the adversarial reviewer is exempt, so reviewing never recurses', () => {
    assert.strictEqual(decideSubagentGate('fork', workScan).block, false)
    assert.strictEqual(decideSubagentGate('FORK', workScan).block, false, 'case-folded')
    assert.strictEqual(decideSubagentGate('', workScan).block, false, 'unnamed micro-lookup class')
  })

  test('an agent that merely CONTAINS "fork" is NOT exempt — the substring test gave it a free pass', () => {
    // `/fork/i` matched every one of these. None is the adversarial reviewer; each returned
    // unreviewed for free. This test fails the moment the guard goes back to a substring match.
    for (const type of ['worktree-fork', 'fork-worker', 'wtfork', 'forklift', 'my-fork-agent']) {
      assert.strictEqual(
        decideSubagentGate(type, workScan).block,
        true,
        `${type} was exempted by a substring match`,
      )
    }
  })

  test('REVIEWER_AGENT_TYPES holds only genuine reviewers — each entry skips that agent\'s review', () => {
    assert.deepStrictEqual([...REVIEWER_AGENT_TYPES], ['fork'])
  })

  // Both surfaces the BLOCKED agent reads must state the positional rule. It used to live only in
  // the source comment above `scanMainTranscriptLines`, which that agent never sees — so the
  // instruction "spawn a fork, then act on the findings" read as spawn-then-reply, and the reply's
  // text block took the higher index and re-armed the gate. tsc and esbuild both pass on a message
  // that has quietly lost the clause, so only an assertion catches a refactor that drops it.
  // (TRDD-DRH4ZRGB)
  test('both block surfaces state the positional rule, so a refactor cannot silently drop it', () => {
    for (const [name, text] of [
      ['MAIN_BLOCK_REASON', MAIN_BLOCK_REASON],
      ['REVIEW_GATE_DIRECTIVE', REVIEW_GATE_DIRECTIVE],
    ] as const) {
      assert.ok(text.includes('POSITIONAL') && !/NOT POSITIONAL/.test(text), `${name} no longer names the positional exit`)
      // The imperative, matched as a PHRASE. An earlier version of this test used
      // /fork[\s\S]{0,80}LAST/, which is co-occurrence dressed as semantics: `fork` appears
      // repeatedly in both strings, so any `LAST` within 80 characters of any `fork` satisfied it —
      // including two unrelated clauses that merely collide. It was also negation-blind, passing
      // happily on "Never put the fork tool_use LAST".
      assert.ok(
        /put the fork `?tool_use`? LAST/.test(text),
        `${name} no longer gives the imperative "put the fork tool_use LAST"`,
      )
      // A blacklist of negations is a spell-check one level up, and this one is NOT a class guard:
      // it enumerates the spellings noticed so far. "Do NOT put the fork tool_use LAST" contains
      // the positive substring verbatim and was green until `[Dd]o NOT` was added; "it is a myth
      // that you must …" still is. Kept because the cheap catches are worth having, named honestly
      // because the test's value must not be read as coverage of negation in general.
      assert.ok(
        !/[Nn]ever put the fork|[Dd]o NOT put the fork|do not put the fork|does not have to be LAST|need not be LAST/.test(text),
        `${name} now NEGATES the imperative it is supposed to give`,
      )
      assert.ok(
        /re-arms this gate|re-arms the gate/.test(text) && !/never re-arms/.test(text),
        `${name} no longer warns what after the fork re-arms the gate`,
      )
    }
  })

  // The BOUNDARY, asserted positively. Guarding only the wrong word (`!/HIGHER/`) is a spell-check:
  // "strictly after", "greater than", "must come later than", "beyond" all express the same wrong
  // strict inequality and all pass a ban on one word. Read off the previous revision's regexes
  // (none referenced the phrase; the deletion was never performed and nothing was re-run — see
  // TRDD-DRH4ZRGB §Acceptance): deleting "AT OR AFTER" from the directive would have left every
  // assertion green, which made the commit subject "assert it cannot silently rot" false. Only the
  // directive states the mechanism — MAIN_BLOCK_REASON deliberately gives imperatives only, so it
  // is not asserted here.
  test('the directive states the >= boundary as AT OR AFTER — one known regression, not a class', () => {
    assert.ok(
      /AT OR AFTER/i.test(REVIEW_GATE_DIRECTIVE),
      'the directive no longer states the at-or-after boundary — a strict reading of >= is wrong',
    )
    // A blacklist of strict-inequality phrasings was here and is REMOVED, not weakened. It
    // reddened on correct writing — "this is not strictly after; an equal index releases too" is
    // the clearest way to state the boundary and the regex banned it — which is the same defect
    // that got the `!/TaskOutput/` ban deleted one test over: a guard that cannot tell asserting
    // from warning. It also promised a class it cannot deliver, since "higher position" and a
    // dozen other spellings walked past it, and it detected nothing the positive assertion above
    // does not. The positive assertion is the whole guard; what neither catches is a CONTRADICTION
    // — a later edit adding a wrong restatement while the correct sentence survives untouched.
  })

  // The directive warns about the background-notification turn and stops there. It deliberately
  // does NOT prescribe `TaskOutput` with `block: true`: that would resolve, for every consumer, a
  // rule conflict unresolved even on the machine that wrote it (a standing IRON RULE forbids
  // blocking the main agent; a second rule claims the review fork as its sole exception). This
  // asserts the CONSEQUENCE is present, not that a token is absent — a `!/TaskOutput/` test would
  // also fire on a sentence WARNING against it, and warning about a mechanism requires naming it.
  test('the directive states the background-notification consequence', () => {
    assert.ok(
      /BACKGROUND fork[^.]*fresh turn[^.]*re-arms/.test(REVIEW_GATE_DIRECTIVE),
      'the directive no longer warns that a background fork\'s notification starts a fresh turn',
    )
    assert.ok(
      /your own rules|forbidden to block/.test(REVIEW_GATE_DIRECTIVE),
      'the directive no longer leaves the blocking decision to the operator',
    )
  })

  // The boundary asserted against the FUNCTION, not the prose — prose can agree with a wrong model.
  // Both directions are needed: `block === false` alone is satisfied by a gate that never blocks,
  // which is the most dangerous mutation a review gate has.
  test('decideMainGate: equal indices release, one role before the work still blocks', () => {
    assert.strictEqual(
      decideMainGate({ lastWork: 4, roles: { measure: 4, review: 4 } }).block, false,
      'equal indices must RELEASE — the predicate is >=, not >',
    )
    assert.strictEqual(
      decideMainGate({ lastWork: 4, roles: { measure: 3, review: 4 } }).block, true,
      'one role before the work must BLOCK — without this, a never-blocking gate passes',
    )
  })

  // The fail-open pinned so a change to it is visible. `lastWork === -1` returns BEFORE the roles
  // are consulted, so an empty scan window allows the stop whatever the role state — a silent
  // bypass of a gate the owner ordered never bypassed. Sought on real transcripts and not
  // reproduced; the mechanism is in the code regardless. This test asserts today's behaviour, so
  // whoever changes it must do so deliberately. (TRDD-W0ZTTUBA)
  test('decideMainGate fails OPEN on an empty window — pinned, not endorsed', () => {
    for (const roleIdx of [-1, 7]) {
      assert.strictEqual(
        decideMainGate({ lastWork: -1, roles: { measure: roleIdx, review: roleIdx } }).block, false,
        `lastWork === -1 allows the stop with roles at ${roleIdx} — ${roleIdx === -1 ? 'the fail-open itself' : 'correct: roles credited after no work'}; see TRDD-W0ZTTUBA`,
      )
    }
  })
})

// Real tmp git repo + real transcript JSONL + the real `runMainGate` — no mocks. The gate's whole
// job is reading a real filesystem and a real transcript, so a fake would test nothing about the
// thing that actually breaks (TRDD-9FG0LSPG).
suite('reviewGate — runMainGate end to end (TRDD-9FG0LSPG)', () => {
  let root: string
  let repo: string
  let savedHome: string | undefined

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'al-gate-e2e-'))
    repo = path.join(root, 'repo')
    fs.mkdirSync(repo)
    execFileSync('git', ['-C', repo, 'init', '-q'])
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'x@example.com'])
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'x'])
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'v1\n')
    execFileSync('git', ['-C', repo, 'add', '-A'])
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'])
    // Pin HOME so the gate's default watched set (~/.claude/...) resolves under root, not the
    // real home — this test must never walk the operator's actual home directory.
    savedHome = process.env.HOME
    process.env.HOME = root
    assert.strictEqual(os.homedir(), root, 'HOME pin did not take')
  })

  teardown(() => {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    fs.rmSync(root, { recursive: true, force: true })
  })

  // A fork tool_use WITH an `id`, closed by its own tool_result 500 ms later — the shape every real
  // transcript has. `forkBlock` (the scanner suites above) carries no `id`; an id-less tool_use can
  // never be closed, so its interval would stay open (Infinity) and cover every later write, making
  // every case in this suite block for a reason no production transcript can produce.
  const forkLines = (forkIso: string): string[] => {
    const forkCloseIso = new Date(Date.parse(forkIso) + 500).toISOString()
    return [
      JSON.stringify({ type: 'assistant', timestamp: forkIso, message: { content: [{ type: 'tool_use', id: 'f1', name: 'Agent', input: { subagent_type: 'fork' } }] } }),
      JSON.stringify({ type: 'user', timestamp: forkCloseIso, message: { content: [{ type: 'tool_result', tool_use_id: 'f1', content: 'reviewed' }] } }),
    ]
  }

  const writeTranscript = (forkIso: string): string => {
    const p = path.join(root, 'transcript.jsonl')
    fs.writeFileSync(p, forkLines(forkIso).join('\n') + '\n')
    return p
  }

  // The fork pair, then a Bash tool_use/tool_result pair (an ordinary non-write command — the point
  // is the ACTIVITY interval it opens, not any arm of its own), written as separate transcript lines.
  const writeActivityTranscript = (forkIso: string, bashStartIso: string, bashEndIso: string): string => {
    const p = path.join(root, 'transcript.jsonl')
    const lines = [
      ...forkLines(forkIso),
      JSON.stringify({ type: 'assistant', timestamp: bashStartIso, message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 1' } }] } }),
      JSON.stringify({ type: 'user', timestamp: bashEndIso, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
    ]
    fs.writeFileSync(p, lines.join('\n') + '\n')
    return p
  }

  // (B) the release twin of (A): the fork reported 500 ms after it spawned and nothing else ran, so
  // a write landing seconds later has no tool activity behind it — a machine-global writer, not this
  // session — and the gate releases. Before TRDD-3U8AIHXK this same fixture BLOCKED (the write was
  // merely newer than the fork); with `freshness` reduced to `ms > sinceMs` it blocks again, which
  // is what makes this case discriminate attribution from recency.
  test('(B) a file written after the last fork, with NO tool activity behind it, releases — attribution, not recency, decides', async () => {
    const forkIso = new Date(Date.now() - 5000).toISOString()
    const transcript_path = writeTranscript(forkIso)
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'v2\n')
    const out = await runMainGate({ transcript_path, cwd: repo, session_id: `e2e-${Date.now()}` })
    assert.strictEqual(out, null)
  })

  // Recency gate alone: the write precedes `sinceMs` (the fork's timestamp), so `ms > sinceMs`
  // already excludes it — the fork's own interval, a minute in the future, never enters into it.
  test('a fork spawned AFTER the write releases the stop', async () => {
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'v2\n')
    const forkIso = new Date(Date.now() + 60_000).toISOString()
    const transcript_path = writeTranscript(forkIso)
    const out = await runMainGate({ transcript_path, cwd: repo, session_id: `e2e-${Date.now()}` })
    assert.strictEqual(out, null)
  })

  // Attribution (TRDD-3U8AIHXK): the write itself is now attributed to this session's tool
  // activity, not merely to "newer than the last fork" — a real file write, a real activity
  // interval computed from a real transcript, a real fork before both.
  test('(A) a file written INSIDE this session\'s tool-activity interval BLOCKS and names the path', async () => {
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'v2\n')
    const m = fs.statSync(path.join(repo, 'tracked.txt')).mtimeMs
    const forkIso = new Date(m - 5000).toISOString()
    const bashStartIso = new Date(m - 1000).toISOString()
    const bashEndIso = new Date(m + 1000).toISOString()
    const transcript_path = writeActivityTranscript(forkIso, bashStartIso, bashEndIso)
    const out = await runMainGate({ transcript_path, cwd: repo, session_id: `e2e-${Date.now()}` })
    assert.notStrictEqual(out, null, 'expected a block, got release')
    const v = JSON.parse(out as string)
    assert.strictEqual(v.decision, 'block')
    assert.ok(v.reason.includes('left unreviewed changes on disk'), v.reason)
    assert.ok(v.reason.includes('tracked.txt'), v.reason)
  })

  // (C) same write, but the activity interval sits well BEFORE the write's mtime — a machine-
  // global writer this session could not have made — so the gate must release, not block.
  test('(C) a file written OUTSIDE every activity interval is not attributed to this session — releases', async () => {
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'v2\n')
    const m = fs.statSync(path.join(repo, 'tracked.txt')).mtimeMs
    const forkIso = new Date(m - 40000).toISOString()
    const bashStartIso = new Date(m - 30000).toISOString()
    const bashEndIso = new Date(m - 20000).toISOString()
    const transcript_path = writeActivityTranscript(forkIso, bashStartIso, bashEndIso)
    const out = await runMainGate({ transcript_path, cwd: repo, session_id: `e2e-${Date.now()}` })
    assert.strictEqual(out, null)
  })
})

// ── the global kill-switch is named on stderr, never a silent allow (TRDD-2CYTNLY1) ──────────────
suite('reviewGate — runReviewGate: the global kill-switch stderr line', () => {
  test('AGENTLENS_DISABLED=1 allows the stop AND names which half of the switch fired', async () => {
    const savedEnv = process.env.AGENTLENS_DISABLED
    const writes: string[] = []
    const originalWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown): boolean => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      process.env.AGENTLENS_DISABLED = '1'
      const code = await runReviewGate([])
      assert.strictEqual(code, 0)
    } finally {
      process.stderr.write = originalWrite
      if (savedEnv === undefined) delete process.env.AGENTLENS_DISABLED
      else process.env.AGENTLENS_DISABLED = savedEnv
    }
    const joined = writes.join('')
    assert.ok(/\[review-gate\]/.test(joined), `no kill-switch line was written: ${JSON.stringify(writes)}`)
    assert.ok(joined.includes('AGENTLENS_DISABLED=1'), `the line must name the env half, not "disabled by the owner": ${joined}`)
  })
})
