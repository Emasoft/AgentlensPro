import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import {
  scanMainTranscriptLines, decideMainGate, applyEffects,
  scanSubagentTranscriptLines, decideSubagentGate, agentCannotSpawn, declaredToolsHaveAgent,
  REVIEW_GATE_DIRECTIVE, ONE_TURN_RULE, mainBlockReason, scanPositions, hookCwd, SUBAGENT_BLOCK_REASON,
  NO_REVIEW_SENTINEL, REVIEWER_AGENT_TYPES, runMainGate,
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
const nothing = { lastFork: -1, lastForkTs: 0, work: null }

suite('reviewGate — main (Stop) gate', () => {
  test('scanMainTranscriptLines: an edit, a marked proposal and a write-shaped command arm; prose, a heartbeat and reads do not', () => {
    assert.deepStrictEqual(scanMainTranscriptLines([assistantLine([editBlock]), assistantLine([forkBlock])], CWD),
      { lastFork: 1, lastForkTs: 0, work: { index: 0, cause: 'edit', detail: 'Edit x.ts' } })
    // Measured on a real session JSONL, this build writes ONE ENTRY PER BLOCK, so a proposing turn
    // is a lone `text` entry with no tool_use anywhere near it.
    assert.deepStrictEqual(scanMainTranscriptLines([assistantLine([proposalBlock])], CWD),
      { lastFork: -1, lastForkTs: 0, work: { index: 0, cause: 'proposal text', detail: '' } })
    assert.deepStrictEqual(scanMainTranscriptLines([assistantLine([proposalBlock]), assistantLine([forkBlock])], CWD),
      { lastFork: 1, lastForkTs: 0, work: { index: 0, cause: 'proposal text', detail: '' } }, 'proposal then fork ⇒ reviewed')
    assert.deepStrictEqual(scanMainTranscriptLines([assistantLine([bashBlock('git commit -m x')])], CWD),
      { lastFork: -1, lastForkTs: 0, work: { index: 0, cause: 'write-shaped command', detail: 'git commit' } })
    // THE LIVELOCK (TRDD-0E3W5C45). For one day every text block was work, so a heartbeat's
    // mandated `janitor heartbeat` line armed the gate and every reply to the block re-armed it —
    // ~40 blocked turns and 5 forks over zero edits. None of these is work:
    for (const turn of [
      [proseBlock], [thinkBlock],
      [bashBlock('/x/dispatcher-stub.py 2>&1'), { type: 'text', text: 'janitor heartbeat' }],
      [bashBlock('grep -rn foo /proj/src')],
      [{ type: 'tool_use', name: 'Write', input: { file_path: '/private/tmp/claude-1/s/x.py' } }],
    ]) {
      assert.deepStrictEqual(scanMainTranscriptLines([assistantLine(turn)], CWD), nothing, JSON.stringify(turn).slice(0, 80))
    }
  })

  test('a NotebookEdit follows the same ephemeral-root rule, and the hook cwd comes from the input', () => {
    const nb = (notebook_path: string) => ({ type: 'tool_use', name: 'NotebookEdit', input: { notebook_path } })
    assert.deepStrictEqual(scanMainTranscriptLines([assistantLine([nb('/proj/n.ipynb')])], CWD),
      { lastFork: -1, lastForkTs: 0, work: { index: 0, cause: 'edit', detail: 'NotebookEdit n.ipynb' } })
    assert.deepStrictEqual(scanMainTranscriptLines([assistantLine([nb('/tmp/n.ipynb')])], CWD), nothing)
    assert.strictEqual(hookCwd({ cwd: '/elsewhere' }), '/elsewhere')
    assert.strictEqual(hookCwd({ cwd: '' }), process.cwd(), 'an empty cwd falls back, it is not a root')
    assert.strictEqual(hookCwd({}), process.cwd())
  })

  test('the block message names the actual arming cause — it said "edited or committed" for every cause', () => {
    assert.ok(mainBlockReason('proposal text').includes('PROPOSAL'))
    assert.ok(!mainBlockReason('proposal text').includes('edited'))
    assert.ok(mainBlockReason('write-shaped command', 'git push').includes('git push'))
    assert.ok(mainBlockReason('edit', 'Write y.md').startsWith('Review-fork gate: this turn edited a file: Write y.md. '))
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

  test('scanMainTranscriptLines case-folds subagent_type, like the subagent scanner already does', () => {
    const capsForkBlock = { type: 'tool_use', name: 'Agent', input: { subagent_type: 'Fork' } }
    const scan = scanMainTranscriptLines([assistantLine([editBlock]), assistantLine([capsForkBlock])], CWD)
    assert.strictEqual(scan.lastFork, 1, 'a subagent_type of "Fork" must still count as the fork')
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
  const baseScan = { lastFork: 3, lastForkTs: 1000, work: null }

  test('no existing work + unreviewed paths ⇒ arms at lastFork + 1 with cause "unreviewed change"', () => {
    const out = applyEffects(baseScan, { paths: ['src/a.ts'], truncated: false })
    assert.deepStrictEqual(out, { lastFork: 3, lastForkTs: 1000, work: { index: 4, cause: 'unreviewed change', detail: 'src/a.ts' } })
  })

  test('an existing text arm strictly after the last fork is KEPT, not overwritten', () => {
    const scanWithArm = { lastFork: 3, lastForkTs: 1000, work: { index: 5, cause: 'proposal text' as const, detail: '' } }
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
})

// ── mainBlockReason names the new cause (TRDD-9FG0LSPG) ────────────────────────────────────────────
suite('reviewGate — mainBlockReason: unreviewed change', () => {
  test('names the cause and lists the path', () => {
    assert.ok(mainBlockReason('unreviewed change', 'src/a.ts').includes('left unreviewed changes on disk: src/a.ts'))
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

  test('a MARKED proposal in a subagent return is work; plain prose is not (owner orders 2026-09-07/08)', () => {
    assert.deepStrictEqual(scanSubagentTranscriptLines([assistantLine([proposalBlock])]), { didWork: true, reviewed: false })
    assert.deepStrictEqual(scanSubagentTranscriptLines([assistantLine([proseBlock])]), { didWork: false, reviewed: false })
    // The subagent gate shares the tool_use classifier: a write-shaped command is work, a Write into
    // the scratchpad is not. Without these two, commenting out the shared branch stays green here.
    assert.deepStrictEqual(scanSubagentTranscriptLines([assistantLine([bashBlock('sed -i "" s/a/b/ f')])], CWD), { didWork: true, reviewed: false })
    assert.deepStrictEqual(
      scanSubagentTranscriptLines([assistantLine([{ type: 'tool_use', name: 'Write', input: { file_path: '/tmp/x' } }])], CWD),
      { didWork: false, reviewed: false })
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
      decideSubagentGate('lean-worker', true, scan, 0, 1),
      { block: false, nextDemands: 0 },
    )
  })

  test('without the sentinel that same transcript is blocked — proving the release came from it', () => {
    // The discriminating control. Without this, the test above passes for any reason at all.
    const scan = scanSubagentTranscriptLines([
      assistantLine([proposalBlock]),
      assistantLine([{ type: 'text', text: 'I cannot spawn a reviewer, sorry.' }]),
    ])
    assert.strictEqual(scan.reviewed, false)
    assert.strictEqual(decideSubagentGate('lean-worker', true, scan, 0, 1).block, true)
  })

  test('the main gate honours the sentinel as its last block', () => {
    const scan = scanMainTranscriptLines([
      assistantLine([proposalBlock]),
      assistantLine([sentinelLine()]),
    ])
    assert.ok(scanPositions(scan).lastFork >= scanPositions(scan).lastWork, 'sentinel must satisfy the positional rule')
    assert.strictEqual(decideMainGate(scanPositions(scan), { total: 0, consecutive: 0 }, { maxPerSession: 9, maxConsecutive: 9 }).block, false)
  })

  test('prose after the sentinel re-arms the main gate, exactly as prose after a fork does', () => {
    const scan = scanMainTranscriptLines([
      assistantLine([sentinelLine()]),
      assistantLine([proposalBlock]),
    ])
    assert.strictEqual(decideMainGate(scanPositions(scan), { total: 0, consecutive: 0 }, { maxPerSession: 9, maxConsecutive: 9 }).block, true)
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
        decideMainGate(scanPositions(main), { total: 0, consecutive: 0 }, { maxPerSession: 9, maxConsecutive: 9 }).block,
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

  test('both block reasons tell the agent the escape exists — an unnamed exit is not an exit', () => {
    for (const [name, reason] of [['MAIN', MAIN_BLOCK_REASON], ['SUBAGENT', SUBAGENT_BLOCK_REASON]] as const) {
      assert.ok(reason.includes(NO_REVIEW_SENTINEL), `${name}_BLOCK_REASON omits the sentinel`)
    }
    assert.ok(
      !SUBAGENT_BLOCK_REASON.includes('asked once'),
      'the "asked once" promise is false — maxDemands is voided, so nothing enforces it',
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
    assert.strictEqual(decideSubagentGate('fork', true, workScan, 0, 1).block, false)
    assert.strictEqual(decideSubagentGate('FORK', true, workScan, 0, 1).block, false, 'case-folded')
    assert.strictEqual(decideSubagentGate('', true, workScan, 0, 1).block, false, 'unnamed micro-lookup class')
  })

  test('an agent that merely CONTAINS "fork" is NOT exempt — the substring test gave it a free pass', () => {
    // `/fork/i` matched every one of these. None is the adversarial reviewer; each returned
    // unreviewed for free. This test fails the moment the guard goes back to a substring match.
    for (const type of ['worktree-fork', 'fork-worker', 'wtfork', 'forklift', 'my-fork-agent']) {
      assert.strictEqual(
        decideSubagentGate(type, true, workScan, 0, 1).block,
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
      assert.ok(text.includes('POSITIONAL'), `${name} no longer names the positional exit`)
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
  // strict inequality and all pass a ban on one word. Measured against the previous revision of
  // this file: deleting "AT OR AFTER" from the directive left every assertion here green, which
  // made the commit subject "assert it cannot silently rot" false. Only the directive states the
  // mechanism — MAIN_BLOCK_REASON deliberately gives imperatives only, so it is not asserted here.
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
      REVIEW_GATE_DIRECTIVE.includes('BACKGROUND fork'),
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
  test('decideMainGate: equal indices release, work after the fork blocks', () => {
    const opts = { maxPerSession: 20, maxConsecutive: 2 }
    const fresh = () => ({ total: 0, consecutive: 0 })
    assert.strictEqual(
      decideMainGate({ lastWork: 4, lastFork: 4 }, fresh(), opts).block, false,
      'equal indices must RELEASE — the predicate is >=, not >',
    )
    assert.strictEqual(
      decideMainGate({ lastWork: 4, lastFork: 3 }, fresh(), opts).block, true,
      'work after the fork must BLOCK — without this, a never-blocking gate passes',
    )
  })

  // The fail-open pinned so a change to it is visible. `lastWork === -1` returns BEFORE `lastFork`
  // is consulted, so an empty scan window allows the stop whatever the fork state — a silent bypass
  // of a gate the owner ordered never bypassed. Sought on real transcripts and not reproduced; the
  // mechanism is in the code regardless. This test asserts today's behaviour, so whoever changes it
  // must do so deliberately. (TRDD-W0ZTTUBA)
  test('decideMainGate fails OPEN on an empty window — pinned, not endorsed', () => {
    const opts = { maxPerSession: 20, maxConsecutive: 2 }
    for (const lastFork of [-1, 7]) {
      assert.strictEqual(
        decideMainGate({ lastWork: -1, lastFork }, { total: 0, consecutive: 0 }, opts).block, false,
        `lastWork === -1 currently allows the stop (lastFork ${lastFork}); see TRDD-W0ZTTUBA`,
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

  const writeTranscript = (forkIso: string): string => {
    const p = path.join(root, 'transcript.jsonl')
    fs.writeFileSync(p, assistantLine([forkBlock], { timestamp: forkIso }) + '\n')
    return p
  }

  test('a file written after the last fork, with no tool_use in the transcript, BLOCKS and names the path', async () => {
    const forkIso = new Date(Date.now() - 5000).toISOString()
    const transcript_path = writeTranscript(forkIso)
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'v2\n')
    const out = await runMainGate({ transcript_path, cwd: repo, session_id: `e2e-${Date.now()}` })
    assert.notStrictEqual(out, null, 'expected a block, got release')
    const v = JSON.parse(out as string)
    assert.strictEqual(v.decision, 'block')
    assert.ok(v.reason.includes('left unreviewed changes on disk'), v.reason)
    assert.ok(v.reason.includes('tracked.txt'), v.reason)
  })

  test('a fork spawned AFTER the write releases the stop', async () => {
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'v2\n')
    const forkIso = new Date(Date.now() + 60_000).toISOString()
    const transcript_path = writeTranscript(forkIso)
    const out = await runMainGate({ transcript_path, cwd: repo, session_id: `e2e-${Date.now()}` })
    assert.strictEqual(out, null)
  })
})
