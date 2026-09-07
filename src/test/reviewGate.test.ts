import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  scanMainTranscriptLines, decideMainGate,
  scanSubagentTranscriptLines, decideSubagentGate, agentCannotSpawn, declaredToolsHaveAgent,
  REVIEW_GATE_DIRECTIVE, ONE_TURN_RULE, MAIN_BLOCK_REASON, SUBAGENT_BLOCK_REASON,
  NO_REVIEW_SENTINEL, REVIEWER_AGENT_TYPES,
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
      assistantLine([textBlock]),
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
      assistantLine([textBlock]),
      assistantLine([{ type: 'text', text: 'I cannot spawn a reviewer, sorry.' }]),
    ])
    assert.strictEqual(scan.reviewed, false)
    assert.strictEqual(decideSubagentGate('lean-worker', true, scan, 0, 1).block, true)
  })

  test('the main gate honours the sentinel as its last block', () => {
    const scan = scanMainTranscriptLines([
      assistantLine([textBlock]),
      assistantLine([sentinelLine()]),
    ])
    assert.ok(scan.lastFork >= scan.lastWork, 'sentinel must satisfy the positional rule')
    assert.strictEqual(decideMainGate(scan, { total: 0, consecutive: 0 }, { maxPerSession: 9, maxConsecutive: 9 }).block, false)
  })

  test('prose after the sentinel re-arms the main gate, exactly as prose after a fork does', () => {
    const scan = scanMainTranscriptLines([
      assistantLine([sentinelLine()]),
      assistantLine([textBlock]),
    ])
    assert.strictEqual(decideMainGate(scan, { total: 0, consecutive: 0 }, { maxPerSession: 9, maxConsecutive: 9 }).block, true)
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
      const scan = scanSubagentTranscriptLines([assistantLine([textBlock]), assistantLine([{ type: 'text', text }])])
      assert.strictEqual(scan.reviewed, false, `quoted/embedded sentinel released the gate: ${text.slice(0, 40)}`)
    }
  })

  test('the sentinel without a reason does not release — "I cannot" must stay a statement, not a magic word', () => {
    for (const text of [NO_REVIEW_SENTINEL, `${NO_REVIEW_SENTINEL} — `, `${NO_REVIEW_SENTINEL} — ab`]) {
      const scan = scanSubagentTranscriptLines([assistantLine([textBlock]), assistantLine([{ type: 'text', text }])])
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
      const sub = scanSubagentTranscriptLines([assistantLine([textBlock]), assistantLine([{ type: 'text', text }])])
      assert.strictEqual(sub.reviewed, false, `sentinel-then-essay released the subagent gate: ${JSON.stringify(text.slice(0, 50))}`)
      const main = scanMainTranscriptLines([assistantLine([textBlock]), assistantLine([{ type: 'text', text }])])
      assert.strictEqual(
        decideMainGate(main, { total: 0, consecutive: 0 }, { maxPerSession: 9, maxConsecutive: 9 }).block,
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
})
