import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  scanTranscriptLines, decideGate, subagentExempt, JANITOR_AGENT_RE,
  isFloorPrompt, userPromptText, HEARTBEAT_PREFIX, INTERRUPT_PREFIX,
  demandText, mainBlockReason, subagentBlockReason, ARM_CAUSE_TEXT,
  REVIEW_GATE_DIRECTIVE, REVIEW_ROLE_RULE, MEASURE_ROLE_RULE, declaredRole, declaredRoleOwnTranscript,
  runMainGate, runReviewGate, agentCannotSpawn, declaredToolsHaveAgent,
  NO_REVIEW_SENTINEL, NO_REVIEW_SENTINEL_EXAMPLES,
} from '../cli/reviewGate'
import { PROPOSAL_MARKER } from '../cli/reviewGateTriggers'

// `agentlenspro review-gate` — pure decision-function tests (owner order 2026-09-15 rewrite: ONE
// shared scan/decide pair, `scanTranscriptLines` / `decideGate`, replaces the separate main/subagent
// scanners this file used to test).

const CWD = '/repo'
const editBlock = { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/a.ts' } }
const bashBlock = (command: string) => ({ type: 'tool_use', name: 'Bash', input: { command } })
const agentBlock = (subagent_type: string, prompt: string) => ({ type: 'tool_use', name: 'Agent', input: { subagent_type, prompt } })

const assistantLine = (blocks: unknown[]): string => JSON.stringify({ type: 'assistant', message: { content: blocks } })
const userStringLine = (content: string): string => JSON.stringify({ type: 'user', message: { role: 'user', content } })
const userTextLine = (text: string): string => JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text }] } })
const toolResultLine = (toolUseId: string, content: unknown): string =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] } })

// ── KEPT VERBATIM — agentCannotSpawn / declaredToolsHaveAgent (built-in + plugin-cache), unchanged ──
suite('reviewGate — agentCannotSpawn / declaredToolsHaveAgent (built-in + plugin-cache)', () => {
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
})

// ── declaredRole: the CREDIT-path first-line role predicate (TRDD-BA0DCW98, 2026-09-24) ─────────────
//
// declaredRole reads the PARENT's own composed `Agent` tool_use `input.prompt` -- never wrapped by
// the harness, so it is anchored to POSITION as well as shape: the marker must be a WHOLE LINE
// (trailing `\s*` tolerated -- a stray trailing space or `\r` is fine, but prose after the marker is
// not) AND the prompt's literal FIRST non-whitespace line -- no longer matched anywhere in the
// prompt. TRDD-BA0DCW98: matching "anywhere" let a quoted marker line buried in untrusted
// third-party text (a fetched doc, an issue body, a pasted transcript) that the PARENT pasted into a
// spawned agent's brief falsely credit that spawn as the real REVIEW/MEASURE agent -- releasing the
// parent's own gate with no reviewer ever actually asked for. The harness always writes the
// `ROLE: ...` line FIRST and any boilerplate/directive text after it, so first-line anchoring costs
// no legitimate spawn its credit (candidate option 3 in the card). The former LOOSE variant (no
// trailing `$`) is the separate defect fixture K exposed (2026-09-15): a worker fork's prose line
// beginning "ROLE: REVIEW is the marker..." credited the review role with no reviewer ever spawned
// -- whole-line equality (unchanged here) is what keeps fixture K closed; first-line anchoring (new
// here) is what keeps BA0DCW98 closed on the credit path; the two checks are independent and this
// suite covers both. `declaredRoleOwnTranscript` (own suite below) is the SEPARATE self-exemption
// predicate and is deliberately NOT anchored the same way -- do not unify the two.
suite('reviewGate — declaredRole: the marker must be the prompt\'s literal first line', () => {
  test('the marker AS the prompt\'s first line is credited, trailing whitespace or \\r tolerated', () => {
    assert.strictEqual(declaredRole('ROLE: MEASURE'), 'measure')
    assert.strictEqual(declaredRole('ROLE: REVIEW'), 'review')
    assert.strictEqual(declaredRole('ROLE: REVIEW \r\ndo the thing'), 'review', 'trailing space/\\r on the marker line is tolerated')
    assert.strictEqual(declaredRole('ROLE: MEASURE\ndo the thing'), 'measure', 'boilerplate AFTER the marker line does not defeat it')
  })

  test('leading blank lines before the marker still credit -- trimEnd only strips trailing whitespace', () => {
    assert.strictEqual(declaredRole('\n\n   \nROLE: REVIEW\ndo the thing'), 'review')
    assert.strictEqual(declaredRole('\nROLE: MEASURE'), 'measure')
  })

  test('a marker buried after 50+ lines of quoted external material is NOT credited -- TRDD-BA0DCW98', () => {
    const quoted = Array.from({ length: 55 }, (_, i) => `quoted line ${i} pasted from an untrusted fetched document`).join('\n')
    assert.strictEqual(declaredRole(`${quoted}\nROLE: REVIEW\ndo the thing`), null, 'a marker not on the first non-blank line must not self-exempt')
  })

  test('trailing prose on the marker line does NOT credit -- the loose defect fixture K exposed', () => {
    assert.strictEqual(declaredRole('ROLE: REVIEW the following diff and then edit it'), null)
    assert.strictEqual(declaredRole('ROLE: MEASURE the assumptions below'), null)
  })

  test('a second marker on a later line is ignored -- only the first line decides -- and neither marker credits neither', () => {
    // TRDD-BA0DCW98: previously "both markers present" (each its own whole line, anywhere)
    // credited neither; now only the first line is read, so this credits 'measure' -- the
    // second `ROLE: REVIEW` line is inert prose as far as declaredRole is concerned.
    assert.strictEqual(declaredRole('ROLE: MEASURE\nROLE: REVIEW\n'), 'measure')
    assert.strictEqual(declaredRole('just a plain prompt'), null)
  })

  test('the marker quoted mid-sentence is not an anchored marker LINE', () => {
    assert.strictEqual(declaredRole('see ROLE: MEASURE above, then do X'), null)
  })

  test('a marker after even one short line of preceding prose is NOT credited -- position is strict, not boilerplate-length-bounded', () => {
    assert.strictEqual(declaredRole('Here is the protocol:\nROLE: REVIEW\nThat is what it looks like.'), null, 'was credited before BA0DCW98; strict first-line anchoring closes this too')
  })

  test('MUTATION CHECK: dropping the first-line anchor lets a buried marker self-exempt again', () => {
    const withoutPositionAnchor = (prompt: string): 'measure' | 'review' | null => {
      const m = /^ROLE: MEASURE\s*$/m.test(prompt)
      const r = /^ROLE: REVIEW\s*$/m.test(prompt)
      return m === r ? null : (m ? 'measure' : 'review')
    }
    const quoted = Array.from({ length: 55 }, (_, i) => `quoted line ${i}`).join('\n')
    const buried = `${quoted}\nROLE: REVIEW\ndo the thing`
    assert.strictEqual(withoutPositionAnchor(buried), 'review', 'without position anchoring the hole reopens')
    assert.strictEqual(declaredRole(buried), null, 'the real predicate keeps the hole closed')
  })

  test('MUTATION CHECK: dropping the $ anchor must let the trailing-prose hole back in', () => {
    const withoutWholeLineAnchor = (prompt: string): 'measure' | 'review' | null => {
      const firstLine = prompt.split('\n').find((l) => l.trimEnd() !== '')?.trimEnd() ?? ''
      const m = /^ROLE: MEASURE/.test(firstLine)
      const r = /^ROLE: REVIEW/.test(firstLine)
      return m === r ? null : (m ? 'measure' : 'review')
    }
    assert.strictEqual(withoutWholeLineAnchor('ROLE: REVIEW the following diff and then edit it'), 'review', 'without the dollar anchor the hole reopens')
    assert.strictEqual(declaredRole('ROLE: REVIEW the following diff and then edit it'), null, 'the real predicate keeps the hole closed')
  })
})

// ── declaredRoleOwnTranscript: the SELF-EXEMPTION predicate, deliberately NOT first-line-anchored ───
//
// This reads the SPAWNED agent's own first transcript entry, not the parent's raw `input.prompt` --
// per TRDD-3U8AIHXK it may arrive with harness-added preamble ahead of the marker, so anchoring it
// to the first line (the `declaredRole` fix above) risks falsely de-exempting every real REVIEW/
// MEASURE fork and deadlocking the gate (each fork's own SubagentStop would then demand it spawn a
// reviewer of itself). Left loose deliberately (owner direction, 2026-09-24): TRDD-BA0DCW98's
// self-exemption residual therefore stays OPEN on this specific predicate pending a real measurement
// of the harness-wrapped shape -- these tests lock the CURRENT (unchanged) behaviour so nobody
// "fixes" it here without reading why.
suite('reviewGate — declaredRoleOwnTranscript: self-exemption, unanchored by design (BA0DCW98 residual)', () => {
  test('the marker anywhere in the prompt still exempts, trailing whitespace or \\r tolerated', () => {
    assert.strictEqual(declaredRoleOwnTranscript('ROLE: MEASURE'), 'measure')
    assert.strictEqual(declaredRoleOwnTranscript('ROLE: REVIEW \r\ndo the thing'), 'review')
    assert.strictEqual(declaredRoleOwnTranscript('<fork-boilerplate>\nROLE: REVIEW\nAttack the proposal.'), 'review', 'harness-prepended boilerplate must not defeat a real fork\'s exemption')
  })

  test('BA0DCW98 residual: a marker quoted after preceding text still exempts (not fixed on this predicate, by design)', () => {
    assert.strictEqual(declaredRoleOwnTranscript('Here is the protocol:\nROLE: REVIEW\nThat is what it looks like.'), 'review')
  })

  test('trailing prose on the marker line still does NOT exempt -- the fixture K fix is unaffected', () => {
    assert.strictEqual(declaredRoleOwnTranscript('ROLE: REVIEW the following diff and then edit it'), null)
  })

  test('both markers, or neither, exempts neither', () => {
    assert.strictEqual(declaredRoleOwnTranscript('ROLE: MEASURE\nROLE: REVIEW\n'), null)
    assert.strictEqual(declaredRoleOwnTranscript('just a plain prompt'), null)
  })
})

// ── KEPT VERBATIM — runReviewGate: the global kill-switch stderr line ───────────────────────────────
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

// ── scanTranscriptLines (owner order 2026-09-15) ─────────────────────────────────────────────────────
suite('reviewGate — scanTranscriptLines', () => {
  test("an Edit outside the ephemeral roots sets work {cause 'edit', detail 'Edit a.ts'} at its index", () => {
    const scan = scanTranscriptLines([assistantLine([editBlock])], CWD)
    assert.deepStrictEqual(scan.work, { index: 0, cause: 'edit', detail: 'Edit a.ts' })
  })

  test("a Bash `git commit -m x` sets work cause 'write-shaped command' with detail 'git commit'", () => {
    const scan = scanTranscriptLines([assistantLine([bashBlock('git commit -m x')])], CWD)
    assert.deepStrictEqual(scan.work, { index: 0, cause: 'write-shaped command', detail: 'git commit' })
  })

  test('an Edit under /tmp does not arm (work null)', () => {
    const tmpEdit = { type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/x' } }
    const scan = scanTranscriptLines([assistantLine([tmpEdit])], CWD)
    assert.strictEqual(scan.work, null)
  })

  test("a text block starting with `PROPOSAL FOR ACTION - PLEASE REVIEW` sets work cause 'proposal text' AND lastProposal at its index", () => {
    const scan = scanTranscriptLines([assistantLine([{ type: 'text', text: 'PROPOSAL FOR ACTION - PLEASE REVIEW\n\ndo X' }])], CWD)
    assert.deepStrictEqual(scan.work, { index: 0, cause: 'proposal text', detail: '' })
    assert.strictEqual(scan.lastProposal, 0)
  })

  test('`**PROPOSAL FOR ACTION - PLEASE REVIEW**` and `## PROPOSAL FOR ACTION - PLEASE REVIEW` both arm; the old `PROPOSAL: do X` marker and the phrase mid-sentence do not', () => {
    for (const text of ['**PROPOSAL FOR ACTION - PLEASE REVIEW**\nbody', '## PROPOSAL FOR ACTION - PLEASE REVIEW\nbody']) {
      const scan = scanTranscriptLines([assistantLine([{ type: 'text', text }])], CWD)
      assert.strictEqual(scan.work?.cause, 'proposal text', text)
    }
    for (const text of ['PROPOSAL: do X', 'I wrote a PROPOSAL FOR ACTION - PLEASE REVIEW mid-sentence']) {
      const scan = scanTranscriptLines([assistantLine([{ type: 'text', text }])], CWD)
      assert.strictEqual(scan.work, null, text)
    }
  })

  test('an Agent spawn whose prompt starts `ROLE: REVIEW` credits roles.review at its index ONLY for subagent_type fork', () => {
    const forkScan = scanTranscriptLines([assistantLine([agentBlock('fork', 'ROLE: REVIEW\ndo it')])], CWD)
    assert.strictEqual(forkScan.roles.review, 0)
    assert.strictEqual(forkScan.roles.measure, -1)
  })

  test('a `lean-worker` spawn whose prompt starts `ROLE: REVIEW` does NOT credit review — only a fork does', () => {
    const scan = scanTranscriptLines([assistantLine([agentBlock('lean-worker', 'ROLE: REVIEW\ndo it')])], CWD)
    assert.strictEqual(scan.roles.review, -1)
    assert.strictEqual(scan.roles.measure, -1)
  })

  test('fixture K: a fork spawn whose prompt merely DESCRIBES the marker (prose after it on the same line) after an Edit leaves review uncredited and the gate still demands review', () => {
    const lines = [
      assistantLine([editBlock]),
      assistantLine([agentBlock('fork', 'Refactor the parser.\nROLE: REVIEW is the marker the gate looks for; do not use it here.')]),
    ]
    const scan = scanTranscriptLines(lines, CWD)
    assert.strictEqual(scan.roles.review, -1)
    assert.strictEqual(decideGate(scan), 'review')
  })

  test('a fork spawn whose prompt is `ROLE: REVIEW \\r\\nreview this` credits review', () => {
    const scan = scanTranscriptLines([assistantLine([agentBlock('fork', 'ROLE: REVIEW \r\nreview this')])], CWD)
    assert.strictEqual(scan.roles.review, 0)
  })

  test('a `lean-worker` spawn whose prompt starts `ROLE: MEASURE` still credits measure', () => {
    const scan = scanTranscriptLines([assistantLine([agentBlock('lean-worker', 'ROLE: MEASURE\nsettle it')])], CWD)
    assert.strictEqual(scan.roles.measure, 0)
    assert.strictEqual(scan.roles.review, -1)
  })

  test('an Agent spawn whose prompt starts `ROLE: MEASURE` credits roles.measure; a second marker on a later line is ignored, and no marker credits nothing', () => {
    const measureScan = scanTranscriptLines([assistantLine([agentBlock('lean-worker', 'ROLE: MEASURE\nsettle it')])], CWD)
    assert.strictEqual(measureScan.roles.measure, 0)
    assert.strictEqual(measureScan.roles.review, -1)
    // TRDD-BA0DCW98: only the FIRST line is read, so a second marker line can no longer make
    // "both" true — the first line alone decides, and here it is exactly `ROLE: MEASURE`.
    const secondLineIgnoredScan = scanTranscriptLines([assistantLine([agentBlock('lean-worker', 'ROLE: MEASURE\nROLE: REVIEW\n')])], CWD)
    assert.deepStrictEqual(secondLineIgnoredScan.roles, { measure: 0, review: -1 })
    const neitherScan = scanTranscriptLines([assistantLine([agentBlock('lean-worker', 'just do it')])], CWD)
    assert.deepStrictEqual(neitherScan.roles, { measure: -1, review: -1 })
  })

  test('a spawn credit is PERMANENT: a later tool_result for that spawn with no heading, and a later `<task-notification>` string entry, leave roles unchanged', () => {
    const lines = [
      assistantLine([agentBlock('fork', 'ROLE: REVIEW\ndo it')]),
      toolResultLine('t1', 'looks fine, no heading here'),
      userStringLine('<task-notification>fork finished</task-notification>'),
    ]
    const scan = scanTranscriptLines(lines, CWD)
    assert.strictEqual(scan.roles.review, 0)
  })

  test('the no-review sentinel text credits both roles at its index; the sentinel followed by an essay credits nothing', () => {
    const scan = scanTranscriptLines([assistantLine([{ type: 'text', text: `${NO_REVIEW_SENTINEL} — rate-limited` }])], CWD)
    assert.strictEqual(scan.roles.measure, 0)
    assert.strictEqual(scan.roles.review, 0)
    const essayScan = scanTranscriptLines(
      [assistantLine([{ type: 'text', text: `${NO_REVIEW_SENTINEL} — rate-limited\n\nAnyway, here is what I changed.` }])], CWD)
    assert.deepStrictEqual(essayScan.roles, { measure: -1, review: -1 })
  })

  test('a `[janitor-heartbeat]…` string prompt after an Edit is a floor: work null, lastProposal -1; an Edit AFTER the floor arms again', () => {
    const lines = [assistantLine([editBlock]), userStringLine('[janitor-heartbeat] findings: none')]
    const scan = scanTranscriptLines(lines, CWD)
    assert.strictEqual(scan.work, null)
    assert.strictEqual(scan.lastProposal, -1)
    const scan2 = scanTranscriptLines([...lines, assistantLine([editBlock])], CWD)
    assert.deepStrictEqual(scan2.work, { index: 2, cause: 'edit', detail: 'Edit a.ts' })
  })

  test('`[Request interrupted by user]` and `[Request interrupted by user for tool use]` text-block entries are floors; a `Stop hook feedback:` string entry, a `<task-notification>` string entry and a tool_result entry are NOT floors', () => {
    for (const text of ['[Request interrupted by user]', '[Request interrupted by user for tool use]']) {
      const lines = [assistantLine([editBlock]), userTextLine(text)]
      const scan = scanTranscriptLines(lines, CWD)
      assert.strictEqual(scan.work, null, text)
    }
    for (const line of [
      userStringLine('Stop hook feedback: something'),
      userStringLine('<task-notification>done</task-notification>'),
      toolResultLine('t1', 'ok'),
    ]) {
      const scan = scanTranscriptLines([assistantLine([editBlock]), line], CWD)
      assert.deepStrictEqual(scan.work, { index: 0, cause: 'edit', detail: 'Edit a.ts' })
    }
  })

  test('a user entry whose content array pairs a tool_result with an interrupt text block IS a floor', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'x' },
        { type: 'text', text: '[Request interrupted by user for tool use]' },
      ] },
    })
    const scan = scanTranscriptLines([assistantLine([editBlock]), line], CWD)
    assert.strictEqual(scan.work, null)
  })

  test('isSidechain entries and malformed lines are skipped; ownRole comes from the FIRST user entry only (string and text-block shapes), a later `ROLE: MEASURE` user entry does not set it', () => {
    const sidechainLine = JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [editBlock] } })
    const malformed = '{not json'
    const scan = scanTranscriptLines([sidechainLine, malformed, assistantLine([editBlock])], CWD)
    assert.deepStrictEqual(scan.work, { index: 2, cause: 'edit', detail: 'Edit a.ts' })

    const stringOwn = scanTranscriptLines([userStringLine('ROLE: REVIEW\nattack it'), assistantLine([editBlock])], CWD)
    assert.strictEqual(stringOwn.ownRole, 'review')
    const textOwn = scanTranscriptLines([userTextLine('ROLE: MEASURE\nsettle it'), assistantLine([editBlock])], CWD)
    assert.strictEqual(textOwn.ownRole, 'measure')
    const laterRole = scanTranscriptLines([
      userStringLine('do some work'),
      assistantLine([editBlock]),
      userStringLine('ROLE: MEASURE\nsettle it'),
    ], CWD)
    assert.strictEqual(laterRole.ownRole, null)
  })
})

// ── decideGate ────────────────────────────────────────────────────────────────────────────────────
suite('reviewGate — decideGate', () => {
  test('null when work is null', () => {
    assert.strictEqual(decideGate({ work: null, lastProposal: -1, roles: { measure: -1, review: -1 } }), null)
  })

  test("'review' when an edit has no review credit at or after it", () => {
    const s = { work: { index: 2, cause: 'edit' as const, detail: 'Edit a.ts' }, lastProposal: -1, roles: { measure: -1, review: -1 } }
    assert.strictEqual(decideGate(s), 'review')
  })

  test('null when roles.review >= work.index (equal index releases)', () => {
    const s = { work: { index: 2, cause: 'edit' as const, detail: 'Edit a.ts' }, lastProposal: -1, roles: { measure: -1, review: 2 } }
    assert.strictEqual(decideGate(s), null)
  })

  test("'both' when a proposal has neither credit", () => {
    const s = { work: { index: 2, cause: 'proposal text' as const, detail: '' }, lastProposal: 2, roles: { measure: -1, review: -1 } }
    assert.strictEqual(decideGate(s), 'both')
  })

  test("'measure' when a proposal has a review credit after it but no measure credit", () => {
    const s = { work: { index: 2, cause: 'proposal text' as const, detail: '' }, lastProposal: 2, roles: { measure: -1, review: 3 } }
    assert.strictEqual(decideGate(s), 'measure')
  })

  test("'review' when proposal + measure + review are credited in order and a LATER edit follows", () => {
    const s = { work: { index: 4, cause: 'edit' as const, detail: 'Edit a.ts' }, lastProposal: 1, roles: { measure: 2, review: 3 } }
    assert.strictEqual(decideGate(s), 'review')
  })

  test('null when proposal then measure then review, all in order', () => {
    const s = { work: { index: 1, cause: 'proposal text' as const, detail: '' }, lastProposal: 1, roles: { measure: 2, review: 3 } }
    assert.strictEqual(decideGate(s), null)
  })
})

// ── subagentExempt ────────────────────────────────────────────────────────────────────────────────
suite('reviewGate — subagentExempt', () => {
  test("'' and 'fork' (case-folded, padded) are exempt", () => {
    assert.strictEqual(subagentExempt('', null), true)
    assert.strictEqual(subagentExempt('  ', null), true)
    assert.strictEqual(subagentExempt('fork', null), true)
    assert.strictEqual(subagentExempt('FORK', null), true)
    assert.strictEqual(subagentExempt(' fork ', null), true)
  })

  test('`ai-maestro-janitor:janitor-memory-subconscious-agent` and bare `janitor-repair-agent` are exempt', () => {
    assert.strictEqual(subagentExempt('ai-maestro-janitor:janitor-memory-subconscious-agent', null), true)
    assert.strictEqual(subagentExempt('janitor-repair-agent', null), true)
  })

  test('`lean-worker`, `wtfork`, `my-janitor-x` are NOT exempt', () => {
    for (const type of ['lean-worker', 'wtfork', 'my-janitor-x']) {
      assert.strictEqual(subagentExempt(type, null), false, type)
    }
  })

  test("any type with ownRole 'measure' or 'review' is exempt", () => {
    assert.strictEqual(subagentExempt('lean-worker', 'measure'), true)
    assert.strictEqual(subagentExempt('lean-worker', 'review'), true)
  })

  test("JANITOR_AGENT_RE is anchored: 'ai-maestro-janitor:' alone without 'janitor-' after it is not exempt", () => {
    assert.strictEqual(JANITOR_AGENT_RE.test('ai-maestro-janitor:something-else'), false)
    assert.strictEqual(subagentExempt('ai-maestro-janitor:something-else', null), false)
  })
})

// ── isFloorPrompt / userPromptText ───────────────────────────────────────────────────────────────
suite('reviewGate — isFloorPrompt / userPromptText', () => {
  test("userPromptText returns the string content, joins text blocks, and returns '' for a tool_result array", () => {
    assert.strictEqual(userPromptText('hello'), 'hello')
    assert.strictEqual(userPromptText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
    assert.strictEqual(userPromptText([{ type: 'tool_result', tool_use_id: 't1', content: 'x' }]), '')
  })

  test('isFloorPrompt is true for HEARTBEAT_PREFIX and INTERRUPT_PREFIX after leading whitespace', () => {
    assert.strictEqual(isFloorPrompt(`  ${HEARTBEAT_PREFIX} findings: none`), true)
    assert.strictEqual(isFloorPrompt(`\n${INTERRUPT_PREFIX}]`), true)
  })

  test('isFloorPrompt is false for a heartbeat quoted mid-text and for an empty content', () => {
    assert.strictEqual(isFloorPrompt(`quoting ${HEARTBEAT_PREFIX} mid text`), false)
    assert.strictEqual(isFloorPrompt(''), false)
    assert.strictEqual(isFloorPrompt([]), false)
  })

  test('isFloorPrompt is true for an array pairing a tool_result with an interrupt text block, and false for a tool_result-only array', () => {
    assert.strictEqual(isFloorPrompt([
      { type: 'tool_result', tool_use_id: 't1', content: 'x' },
      { type: 'text', text: '[Request interrupted by user for tool use]' },
    ]), true)
    assert.strictEqual(isFloorPrompt([{ type: 'tool_result', tool_use_id: 't1', content: 'x' }]), false)
  })
})

// ── messages ──────────────────────────────────────────────────────────────────────────────────────
suite('reviewGate — messages', () => {
  test("demandText('review') contains REVIEW_ROLE_RULE and not MEASURE_ROLE_RULE", () => {
    const t = demandText('review')
    assert.ok(t.includes(REVIEW_ROLE_RULE))
    assert.ok(!t.includes(MEASURE_ROLE_RULE))
  })

  test("demandText('both') contains both rules with the MEASURE rule first", () => {
    const t = demandText('both')
    assert.ok(t.includes(REVIEW_ROLE_RULE))
    assert.ok(t.includes(MEASURE_ROLE_RULE))
    assert.ok(t.indexOf(MEASURE_ROLE_RULE) < t.indexOf(REVIEW_ROLE_RULE))
  })

  test("demandText('measure') contains only the MEASURE rule", () => {
    const t = demandText('measure')
    assert.ok(t.includes(MEASURE_ROLE_RULE))
    assert.ok(!t.includes(REVIEW_ROLE_RULE))
  })

  test('every demandText carries NO_REVIEW_SENTINEL, PROPOSAL_MARKER, the word LAST and `review-gate --directive`', () => {
    for (const d of ['review', 'measure', 'both'] as const) {
      const t = demandText(d)
      assert.ok(t.includes(NO_REVIEW_SENTINEL), d)
      assert.ok(t.includes(PROPOSAL_MARKER), d)
      assert.ok(/\bLAST\b/.test(t), d)
      assert.ok(t.includes('review-gate --directive'), d)
      assert.ok(t.includes('a line by itself'), d)
    }
  })

  test('mainBlockReason and subagentBlockReason name ARM_CAUSE_TEXT[cause] + detail; the subagent one ends with the sentinel-start sentence', () => {
    const main = mainBlockReason('edit', 'Edit a.ts', 'review')
    assert.ok(main.includes(ARM_CAUSE_TEXT.edit))
    assert.ok(main.includes('Edit a.ts'))
    const sub = subagentBlockReason('edit', 'Edit a.ts', 'review')
    assert.ok(sub.includes(ARM_CAUSE_TEXT.edit))
    assert.ok(sub.includes('Edit a.ts'))
    assert.ok(sub.trim().endsWith('a quoted copy will not count).'), sub)
  })

  test('REVIEW_GATE_DIRECTIVE carries PROPOSAL_MARKER, both role rules, `[janitor-heartbeat]`, `interrupted`, `ai-maestro-janitor` and every NO_REVIEW_SENTINEL_EXAMPLES entry', () => {
    assert.ok(REVIEW_GATE_DIRECTIVE.includes(PROPOSAL_MARKER))
    assert.ok(REVIEW_GATE_DIRECTIVE.includes(REVIEW_ROLE_RULE))
    assert.ok(REVIEW_GATE_DIRECTIVE.includes(MEASURE_ROLE_RULE))
    assert.ok(REVIEW_GATE_DIRECTIVE.includes('[janitor-heartbeat]'))
    assert.ok(REVIEW_GATE_DIRECTIVE.includes('interrupted'))
    assert.ok(REVIEW_GATE_DIRECTIVE.includes('ai-maestro-janitor'))
    assert.ok(REVIEW_GATE_DIRECTIVE.includes('Only a `fork` spawn credits the REVIEW role'))
    for (const ex of NO_REVIEW_SENTINEL_EXAMPLES) assert.ok(REVIEW_GATE_DIRECTIVE.includes(ex), ex)
  })
})

// ── runMainGate / runReviewGate end to end (real temp dir, real transcript files) ───────────────────
suite('reviewGate — runMainGate / runReviewGate end to end', () => {
  const mkTranscript = (lines: string[]): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-e2e-'))
    const file = path.join(dir, 'transcript.jsonl')
    fs.writeFileSync(file, lines.join('\n') + '\n')
    return file
  }

  test("edit-only transcript → a JSON block whose reason contains 'edited a file'", async () => {
    const transcript_path = mkTranscript([assistantLine([editBlock])])
    const out = await runMainGate({ transcript_path, cwd: CWD })
    assert.ok(out !== null)
    const parsed = JSON.parse(out as string) as { decision: string; reason: string }
    assert.strictEqual(parsed.decision, 'block')
    assert.ok(parsed.reason.includes('edited a file'))
  })

  test('edit then a `ROLE: REVIEW` fork spawn → null; edit then heartbeat prompt then text → null; edit then interrupt entry → null', async () => {
    const t1 = mkTranscript([assistantLine([editBlock]), assistantLine([agentBlock('fork', 'ROLE: REVIEW\nattack it')])])
    assert.strictEqual(await runMainGate({ transcript_path: t1, cwd: CWD }), null)
    const t2 = mkTranscript([
      assistantLine([editBlock]),
      userStringLine('[janitor-heartbeat] findings: none'),
      assistantLine([{ type: 'text', text: 'janitor heartbeat' }]),
    ])
    assert.strictEqual(await runMainGate({ transcript_path: t2, cwd: CWD }), null)
    const t3 = mkTranscript([assistantLine([editBlock]), userTextLine('[Request interrupted by user]')])
    assert.strictEqual(await runMainGate({ transcript_path: t3, cwd: CWD }), null)
  })

  test('mutation check: the same heartbeat fixture with the prompt `janitor-heartbeat` (no brackets) → still blocks', async () => {
    const t = mkTranscript([assistantLine([editBlock]), userStringLine('janitor-heartbeat findings: none')])
    const out = await runMainGate({ transcript_path: t, cwd: CWD })
    assert.ok(out !== null, 'without the brackets, the prefix must not match — the gate must still block')
  })

  test('SubagentStop via runReviewGate with a piped payload is out of scope; instead call runMainGate with a missing transcript_path → null, and with an unreadable path → null', async () => {
    assert.strictEqual(await runMainGate({}), null)
    assert.strictEqual(await runMainGate({ transcript_path: '/nonexistent/path/x.jsonl' }), null)
  })

  test("SubagentStop decision through the exported pieces: for an edit-only transcript, subagentExempt('ai-maestro-janitor:janitor-memory-subconscious-agent', null) is true and decideGate(scanTranscriptLines(lines,'/repo')) is 'review' for a non-exempt type", () => {
    const lines = [assistantLine([editBlock])]
    assert.strictEqual(subagentExempt('ai-maestro-janitor:janitor-memory-subconscious-agent', null), true)
    const scan = scanTranscriptLines(lines, '/repo')
    assert.strictEqual(decideGate(scan), 'review')
  })
})
