// src/cli/reviewGate.ts — `agentlenspro review-gate`: the adversarial-review Stop/SubagentStop
// gate, as ONE verb that dispatches on `hook_event_name` (TRDD ai-review-gate-cli-verb).
//
// WHY A VERB, NOT SHIPPED .js FILES. The two source-of-truth implementations
// (~/.claude/hooks/stop-spawn-review-fork.js and subagent-stop-spawn-review-fork.js) are loose
// user-scope files this package never shipped and `--install-hooks` never registered. Absolute
// script paths in settings.json break on reinstall (a different prefix per npm/Homebrew version);
// a subcommand of the one published bin does not, because HOOK_EVENTS/GATE_EVENTS registration
// already resolves `agentlenspro` on PATH. Ported here FAITHFULLY — same decision logic, same
// breakers, same fail-open direction — just merged behind one dispatch instead of two files.

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { agentlensDisabled, killSwitchHalf, killSwitchPath } from './killSwitch'
import { readStdin } from './hookHandlers'
import { commandWriteReason, isEphemeralTarget, textArms } from './reviewGateTriggers'
import type { ArmCause } from './reviewGateTriggers'
import { unreviewedEffects } from './reviewGateEffects'
import type { Effects, Activity } from './reviewGateEffects'

/** The main gate's cause enum widens `ArmCause` with one value ONLY the main gate can produce:
 *  a disk effect (a worker's edit, a script's write, a fork-as-worker) that the transcript never
 *  shows as a tool_use at all. The subagent gate has no equivalent — it scans its OWN transcript,
 *  where every one of its own edits already IS a tool_use — so this stays local rather than
 *  widening the shared `ArmCause` in reviewGateTriggers.ts, which the subagent gate also imports. */
export type MainArmCause = ArmCause | 'unreviewed change'

// ── Step 2: the directive, embedded (not a shipped file) ──────────────────────────────────────
// Both gates' block reason used to point at ~/.claude/hooks/review-fork-directive.md, which the
// package would not ship either. `agentlenspro review-gate --directive` prints this instead, and
// the block reason below points at that command.
// THE ONE-TURN RULE. It admits NO exception, because the previous wording did and that was the
// defect: REVIEW_GATE_DIRECTIVE used to order "NO tool calls except a single SendMessage to main".
// Measured over this project's fork corpus (2026-09-03, 209 of 216 spawns joined to their usage;
// evidence: reports/review-fork-economics/): 186 fork prompts carried that carve-out and 177 of
// them made exactly one tool call — the sanctioned one. A tool_result must be answered, and that
// answer is a second assistant turn. So the forks obeyed; naming a permitted tool reads as a
// licence, not an exception.
//
// WHAT IS NOT ESTABLISHED, so the next reader does not inherit it as fact:
//   - The COST of that second turn. `subagent_tokens` is dominated by the context a fork inherits
//     at spawn, not by its turn count — the one fork ever given a proper one-turn rule used MORE
//     (819k, zero tool calls) than the SENDMSG median (373k). A fork's second turn re-reads a warm
//     prefix at 0.1x, so this may be untidy rather than expensive. Unmeasured either way; the
//     "~6 forks / ~4.6M tokens" figure from a session handoff is not restated because nothing here
//     confirms it.
//   - That parents fail to transcribe the rule. That was the first diagnosis and it is not
//     supported: 186/216 transcribed it faithfully, in broken form. The 23 prompts carrying no
//     turn constraint were read in full and are mostly review forks deliberately told to `git show`
//     a commit they did not inherit — their tool calls are the task, not a missing constraint.
//     The channels below still order the rule PASTED, because a fork is bound only by the prompt
//     its parent writes; that is cheap insurance, not a measured repair.
export const REVIEW_ROLE_RULE = 'Begin your prompt with a line that is exactly "ROLE: REVIEW", and '
  + 'begin your final message with the heading ADVERSARIAL-REVIEW. Answer in ONE turn. Make ZERO '
  + 'tool calls — no SendMessage, no Read, no Bash, none. Put every finding INLINE in your final '
  + 'message and stop.'

export const MEASURE_ROLE_RULE = 'Begin your prompt with a line that is exactly "ROLE: MEASURE", and '
  + 'begin your final message with the heading MEASURE-AND-VERIFY-REPORT. Settle EVERY load-bearing '
  + 'assumption the proposal rests on and report each as ASSUMPTION / COMMAND / OBSERVED / VERDICT '
  + '(confirmed | refuted | unmeasurable). There is NO cap on how many tool calls this takes — measure '
  + 'properly; a half-measured report that stops mid-way is worse than none, and a cap is what makes '
  + 'fabricating an OBSERVED row cheaper than running the command. Keep each call cheap instead: '
  + '`tldr` (structure | search | definition | impact | slice) rather than reading whole source files, '
  + '`llm-ext` for bounded read-only analysis whose output never enters your context, and pipe verbose '
  + 'output through `distill` with an explicit prompt. READ-ONLY only: no edit, no write, no commit, '
  + 'no push, no install, no redirect outside /tmp — a write of yours lands on disk and arms the gate '
  + 'that spawned you. Settle exactly the assumptions your prompt names and do not explore beyond '
  + 'them — the bound is the assumption list, not a call count. An assumption you could not settle is '
  + 'reported unmeasurable, which is a finding, not a failure.'


export const MEASURE_HEADING = 'MEASURE-AND-VERIFY-REPORT'
export const REVIEW_HEADING = 'ADVERSARIAL-REVIEW'
export type Role = 'measure' | 'review'

/** Role claimed by a PROMPT the parent wrote. An anchored marker LINE, never a bare mention: an
 *  agent reviewing this gate quotes both names in prose. Both or neither => null, because one
 *  agent doing both jobs is the shape this replaces. */
export function forkRole(prompt: string): Role | null {
  const m = /^ROLE: MEASURE$/m.test(prompt)
  const r = /^ROLE: REVIEW$/m.test(prompt)
  return m === r ? null : (m ? 'measure' : 'review')
}

/** Role claimed by an OUTPUT. Same anchoring rationale: the heading must START a line (optionally
 *  after markdown heading/bold punctuation), so a result that merely DISCUSSES the gate does not
 *  credit a role it did not fill. Both or neither => null.
 *  HORIZONTAL WHITESPACE ONLY in the punctuation class -- \s matches \n too, which would let the
 *  class span lines and defeat the "must START a line" anchor (owner correction 2026-09-13, C2). */
export function resultRole(text: string): Role | null {
  const m = /^[#*\t ]*MEASURE-AND-VERIFY-REPORT/m.test(text)
  const r = /^[#*\t ]*ADVERSARIAL-REVIEW/m.test(text)
  return m === r ? null : (m ? 'measure' : 'review')
}

/** The sentinel an agent emits when it CANNOT spawn a reviewer — the only exit from either gate
 *  that does not require spawning one. ONE definition serves both gates deliberately: two copies
 *  would drift, and an agent that learned the phrase from one gate's message would be wedged by
 *  the other. Must be the FIRST thing in a text block (anchor rationale at each read site), and
 *  must carry a reason — so "I can't" is a statement someone can act on, not a magic word. The
 *  reason is never parsed; requiring it is what stops the phrase becoming a reflex.
 *  Declared ABOVE the directive, which interpolates it: a `const` is in its TDZ until its line runs. */
export const NO_REVIEW_SENTINEL = 'REVIEW-GATE: NO REVIEW POSSIBLE'

/** Canonical example reasons, shared between the block-message prose and the sentinel-floor test
 *  (`isNoReviewSentinel`) so the two can never drift apart — a message that offers an example the
 *  predicate itself would reject wedges the very agent it is telling how to exit. */
export const NO_REVIEW_SENTINEL_EXAMPLES = ['rate-limited', 'at a depth limit', 'tool denied'] as const

export const REVIEW_GATE_DIRECTIVE = `# Review-fork gate directive (read on every Stop-hook fire)

Spawn TWO agents, not one: a MEASURE agent and a REVIEW agent.

- The REVIEW agent uses the Agent tool, \`subagent_type: "fork"\`, with a prompt that:
  - states what you did this turn and every claim you are asserting;
  - carries THIS LINE VERBATIM, because it reads nothing else you were told:
    "${REVIEW_ROLE_RULE}"
  - tells it to hunt the recurring failure shape — a PROXY read in place of the thing (a pipe's
    exit status for the tool's, a preview for the file, a profile for the workload rate, one run
    for the variance, an assumed format for the real one);
  - asks it to name the single WEAKEST link and give ONE settling command for it.
- The MEASURE agent may be any subagent type — a \`lean-worker\` (sonnet[1m], no inherited
  conversation context) is the PREFERRED choice, MEASURED at 143,363 tokens against a fork's
  306,777 on the identical task, with an equally usable report. Its prompt carries THIS LINE
  VERBATIM:
  "${MEASURE_ROLE_RULE}"

Extra turns are not free, so measure only what the proposal actually rests on.

THE EXIT IS POSITIONAL, and this is the part that is easy to get wrong. The gate compares
positions: it releases when BOTH the measure and the review are credited AT OR AFTER the last
block that armed it. A SPAWNED agent's credit lasts only until IT RETURNS — once its own tool_use
closes (its result lands, or its background job's notification arrives), only what that result
says decides: a result carrying its heading credits the role permanently, a result without the
heading costs it. So the turn that launches both agents in the background still releases its own
Stop (neither has returned yet); an agent that comes back later without its heading blocks the
NEXT Stop. WHAT ARMS IT
(owner directive 2026-09-08): an Edit/Write/NotebookEdit outside /tmp and the project's reports/
and *_dev/ dirs; a write-shaped Bash command — git commit/push/pull/mv/rm/checkout/reset/rebase/
merge/stash/clean…, gh create/comment/edit/merge…, sed -i / perl -i, a package add/remove,
agentlenspro setup / --install-*, a memgrep *-mem-* verb, the string given to \`sh -c\` / \`eval\`,
or a redirect / tee / cp / mv / rm / touch whose target is not a LITERAL path under /tmp,
/dev/null or those dirs; or a text block with a line starting \`PROPOSAL\`; or any file under the
repo or the watched config set (rules, skills, agents, hooks, settings, memory) whose mtime is
newer than the last fork — whoever wrote it, a worker included — and any HEAD move newer than the
last fork. Plain prose, status lines, heartbeat output and
read-only commands do NOT arm it; an undecidable target (a $VAR, a glob, after a \`cd\`) counts as
a write. So:

- put both agents' tool_use blocks LAST, in the SAME response as your user-visible text: put the fork tool_use LAST,
  after the measure tool_use — at least after the turn's last edit, write-shaped command or PROPOSAL line;
- an edit, a write-shaped command or a PROPOSAL line after the fork re-arms the gate; plain
  text after it does not.

A BACKGROUND fork's completion notification starts a fresh turn; that turn re-arms the gate only
if it itself edits, writes or proposes. Whether to consume the fork in-turn instead is your call
under your own rules — some agents are forbidden to block, and this gate does not require it
either way.

If you CANNOT spawn either — ${NO_REVIEW_SENTINEL_EXAMPLES.join(', ')} — a text block whose
ENTIRE content is "${NO_REVIEW_SENTINEL} — <reason>", as the turn's last block, releases the
gate. It is the only other exit.

Then read both reports and act on them — if acting on them edits, writes or proposes, that turn is
new work and needs its own pair. Do NOT restate this directive to the user — spawn them and
continue. This gate CANNOT be disabled — \`AGENTLENS_REVIEW_FORK=off\` is ignored.
`

export interface ReviewGateInput {
  hook_event_name?: unknown
  hookEventName?: unknown
  transcript_path?: unknown
  session_id?: unknown
  agent_id?: unknown
  agent_type?: unknown
  agent_transcript_path?: unknown
  /** The session's working directory, which relative write targets resolve against. */
  cwd?: unknown
  /** Set by Claude Code when a Stop hook already blocked this same stop — the harness's own
   *  loop breaker. The SUBAGENT gate honours it (see `runSubagentGate`'s early return): an
   *  unwritable tmpdir (the counter never persists) blocked every fire forever (review of
   *  dca6c45, F1). The MAIN gate deliberately does NOT honour it — see `runMainGate`, which
   *  never reads this field; a one-block cap by another name is exactly what the owner's
   *  "no give-up" order (2026-09-03) forbids. */
  stop_hook_active?: unknown
}

/** True when the agent's definition lists a `tools:` line WITHOUT the Agent tool — it cannot
 *  spawn a reviewer, so a demand costs it a full turn to say so (review F2). Absent or unreadable
 *  definition ⇒ unknown ⇒ demand as usual. */
// EVERY built-in that lacks the Agent tool must be listed here, not just the two obvious ones.
// A built-in has no definition file, so it falls to `text === null` → `plugin !== ''` → for a BARE
// name that is FALSE, i.e. DEMAND — a fork it cannot spawn. `claude-code-guide` (Bash, Read,
// WebFetch, WebSearch) and `statusline-setup` (Read, Edit) were wedged exactly that way, verified
// against the live agent listing 2026-09-07. `claude` and `general-purpose` hold `*`, so demanding
// them is right. Adding a name here is release-direction: the cost of a wrong entry is one skipped
// review, the cost of a missing one is an agent that cannot finish its turn.
export const BUILTIN_WITHOUT_AGENT_TOOL = new Set(['Explore', 'Plan', 'claude-code-guide', 'statusline-setup'])

export function pluginCacheRoot(): string {
  return path.join(os.homedir(), '.claude', 'plugins', 'cache')
}

/** Read a plugin agent's definition. A plugin agent is addressed `<plugin>:<name>` and its file
 *  normally lives under the INSTALLED plugin cache. Not a walk, but not two readdirs either: it is
 *  1 + M readdirs (M = marketplaces) plus up to M×V stats, all bounded and only for namespaced
 *  types. It handles ONE of the four layouts observed on this machine —
 *  `<cache>/<marketplace>/<plugin>/<version>/agents/<n>.md`. The other three are under
 *  `plugins/marketplaces/`, which is deliberately NOT searched: that
 *  tree is upstream source for plugins that may not be installed, and 4,029 of the 4,761 agent
 *  definitions on this machine live there — resolving against one would answer for an agent the
 *  harness never dispatches. Unresolvable is handled by the caller, which releases.
 *
 *  NEWEST VERSION BY MTIME, not readdir order. MEASURED 2026-09-07: ai-maestro-janitor has 14
 *  versions cached and readdirSync yields them lexicographically — `3.4.1` first, `3.4.14` seventh
 *  from last — so taking the first match read a THIRTEEN-VERSION-STALE definition and let it decide
 *  whether the agent is demanded or released. mtime tracks install order without parsing semver
 *  (a string sort gets `3.4.9` > `3.4.10` wrong, which is the same bug with extra steps). */
function readPluginAgentDef(plugin: string, bare: string, cache = pluginCacheRoot()): string | null {
  let markets: string[]
  try { markets = fs.readdirSync(cache) } catch { return null }
  const found: { file: string; mtime: number }[] = []
  for (const mp of markets) {
    const pluginDir = path.join(cache, mp, plugin)
    let versions: string[]
    try { versions = fs.readdirSync(pluginDir) } catch { continue }
    for (const v of versions) {
      const file = path.join(pluginDir, v, 'agents', `${bare}.md`)
      try { found.push({ file, mtime: fs.statSync(file).mtimeMs }) } catch { /* next */ }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime)
  // FALL THROUGH ON AN UNREADABLE CANDIDATE rather than abandoning the rest. `statSync` succeeds on
  // a directory and on a file we may not read, so the newest entry can be one `readFileSync` then
  // throws on — and returning null there discarded every OTHER version that would have read fine,
  // releasing the agent unreviewed for a reason having nothing to do with its tools.
  for (const c of found) {
    try { return fs.readFileSync(c.file, 'utf8') } catch { /* next candidate */ }
  }
  return null
}

/**
 * Does a definition's frontmatter declare the Agent tool? `null` = it declares no `tools:` key at
 * all, which is NOT the same as declaring none.
 *
 * THE OLD ONE-LINE REGEX WAS WRONG IN THE DIRECTION NOBODY NOTICES. `/^tools:\s*(.+)$/m` captures
 * nothing on a YAML block list (the value is on the following lines) and captures `*` on an
 * all-tools declaration; neither contains the literal `Agent`, so both answered "cannot spawn" and
 * RELEASED an agent that can in fact spawn. A wedge announces itself; a skipped review does not,
 * and it subtracts directly from what this gate exists to do.
 *
 * BUT THIS IS NOT A PURE IMPROVEMENT, and the trade is worth stating. The old regex could only ever
 * FAIL to find `Agent`; it could not find one spuriously. Every one of its errors therefore fell
 * toward release. This one infers Agent from `*` and from a list, so a misparse can now DEMAND —
 * and a demand on an agent that cannot spawn is a permanent wedge, which is the worse failure. The
 * guards below (case-insensitive key, `except` anchored to the all-tools head, and the caller's
 * frontmatter-fence check) each exist to close one such path.
 */
export function declaredToolsHaveAgent(front: string): boolean | null {
  // CASE-INSENSITIVE: a `Tools:` key fell through to null, which the caller reads as "demand" — a
  // wedge over a capital letter. Pre-existing, but only reachable now that misparses can demand.
  const m = /^tools:[ \t]*(.*)$/im.exec(front)
  if (!m) return null
  const strip = (s: string) => s.trim().replace(/^["']|["']$/g, '')
  // STRIP THE WHOLE VALUE, not just the list items. A bare `*` opens a YAML alias node, so `tools: *`
  // is a syntax error and any file a linter has touched spells it `tools: "*"` — i.e. the branch
  // below would have handled only the spelling that cannot legally exist. Same for `"All tools"`.
  const inline = strip(m[1])
  if (inline === '') {
    // BLOCK LIST: the value is the run of `  - item` lines immediately below. Stop at the first
    // line that is not one, so a later key's own list is never read as this one's.
    const items: string[] = []
    for (const line of front.slice(m.index + m[0].length).split('\n')) {
      const item = /^[ \t]+-[ \t]*(.+)$/.exec(line)
      if (!item) { if (line.trim() === '') continue; break }
      items.push(strip(item[1]))
    }
    return items.includes('Agent')
  }
  if (inline === '*') return true
  // `All tools` means every tool — Agent included — unless an `except` clause takes it back out.
  // That clause is a real shape: Explore and Plan are written `All tools except Agent, …`, and
  // reading only the head of the line would invert their answer. ANCHOR `except` TO THE ALL-TOOLS
  // HEAD rather than searching the line: a free `\bexcept\b` also matches a tool NAMED
  // `except-handler`, and `tools: All tools, except-handler, Agent` then reads Agent as excepted and
  // releases an agent that explicitly declares it. Unanchored, this pattern falls through to the
  // plain-list branch below, which answers it correctly.
  // `except[ \t]+`, NOT `except\b` — `\b` holds between `t` and `-`, so `except-handler` (a plausible
  // tool name) parses as a clause and takes the following `Agent` out with it. Requiring whitespace
  // after the keyword makes that fall through to the plain-list branch, which answers it correctly.
  // `,?` covers `All tools, except X`. A dangling `except` captures '' — falsy, hence the truthiness
  // test rather than `=== undefined`, which would have taken the wrong branch on it.
  const all = /^all tools\b[ \t]*,?[ \t]*(?:except[ \t]+(.*))?$/i.exec(inline)
  if (all) return all[1] ? !all[1].split(',').map(strip).includes('Agent') : true
  return inline.replace(/^\[/, '').replace(/\]$/, '').split(',').map(strip).includes('Agent')
}

export function agentCannotSpawn(
  agentType: string,
  agentsDir = path.join(os.homedir(), '.claude', 'agents'),
  cacheDir = pluginCacheRoot(),
): boolean {
  // GUARD THE NAME COMPONENT, NOT THE WHOLE ADDRESS. This regex is a path-traversal defence (its
  // test pins `../etc/passwd`), and a colon is legitimate plugin syntax, not an attack — but a
  // namespaced type failed it and returned false, i.e. "demand as usual". That was harmless while
  // work meant an edit; under the text-is-work predicate above it BRICKED every plugin agent
  // without the Agent tool, which could then never return. Measured live 2026-09-07.
  const colon = agentType.lastIndexOf(':')
  const bare = colon >= 0 ? agentType.slice(colon + 1) : agentType
  const plugin = colon >= 0 ? agentType.slice(0, colon) : ''
  if (!/^[A-Za-z0-9_-]+$/.test(bare)) return false
  if (plugin && !/^[A-Za-z0-9_-]+$/.test(plugin)) return false
  // BUILT-INS HAVE NO DEFINITION FILE, so the reads below fall through to "unknown". Harmless while
  // work meant an edit — Explore and Plan never edit — but under the new predicate every one of
  // their returns is work and neither has the Agent tool. A hardcoded set is deliberate over a
  // cleverer probe: greppable, and it fails VISIBLY on a rename where a missing file fails silently.
  if (BUILTIN_WITHOUT_AGENT_TOOL.has(bare)) return true
  // CACHE FIRST FOR A NAMESPACED TYPE — the plugin's own definition is authoritative for it, and
  // agentsDir is keyed on the BARE name, so `someplugin:known` and `otherplugin:known` both hit one
  // `~/.claude/agents/known.md`. With 38 generically-named user agents (scout, judge, reviewer,
  // spark…) a collision is a matter of time, and its worse branch — local lists Agent, the plugin
  // does not — DEMANDS a fork from an agent that cannot spawn one, i.e. it recreates the very
  // outage this function was fixed for, while looking like a successful resolve.
  let text: string | null = plugin ? readPluginAgentDef(plugin, bare, cacheDir) : null
  if (text === null) {
    try { text = fs.readFileSync(path.join(agentsDir, `${bare}.md`), 'utf8') } catch { /* unresolved */ }
  }
  // A NAMESPACED AGENT WE CANNOT FIND CANNOT BE PROVEN ABLE TO SPAWN, and an unprovable demand is a
  // permanent wedge — the agent has no exit. Release it: a missed review is recoverable, a bricked
  // agent is not. A BARE name still defaults to "demand", which is the pre-existing behaviour.
  if (text === null) return plugin !== ''
  // REQUIRE BOTH FENCES, OVER NORMALIZED TEXT. Two defects meet here. `split('\n---')[0]` yields the
  // WHOLE FILE when the CLOSING fence is missing, so a markdown body documenting its tools as
  // `tools:` then `  - Agent` parses as a declaration and answers DEMAND — a wedge, off prose. And
  // the obvious guard, `startsWith('---\n')`, does not fix that at all (the hole is the closing
  // fence) while releasing every CRLF file, every BOM file, and every `--- ` with a trailing space —
  // all three of which parsed CORRECTLY before, so it would have turned right answers into silent
  // skipped reviews. Normalizing first and requiring both fences closes all four at once.
  const norm = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const fm = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(norm)
  if (fm === null) return true
  // NO `tools:` KEY MEANS ALL TOOLS, which includes Agent — so an agent that declares no surface is
  // demanded. That is the answer the old regex gave too, but by accident rather than on purpose.
  const has = declaredToolsHaveAgent(fm[1])
  return has === null ? false : !has
}

// Also describes a `user` entry's `tool_result` block.
export interface AssistantContentBlock {
  type?: unknown
  name?: unknown
  // Present only on `type: 'text'` blocks. Read to recognize the no-review sentinel — the gate's
  // only exit that does not require spawning an agent. `unknown`, not `string`, because this is
  // parsed from an on-disk JSONL a different process wrote: a malformed entry must reach the
  // String() coercion at the read site, not throw here.
  text?: unknown
  input?: { subagent_type?: unknown; command?: unknown; file_path?: unknown; notebook_path?: unknown; prompt?: unknown }
  /** On a `tool_use` block: its id, which the later `tool_result`'s `tool_use_id` names. */
  id?: unknown
  /** On a `tool_result` block (a `user` entry): the tool_use it answers, and the result body —
   *  a string, or an array of `{ type: 'text', text }` blocks. */
  tool_use_id?: unknown
  content?: unknown
}
/** Does this text block open with the sentinel AND carry a reason? Written as a predicate rather
 *  than one regex because the regex form was WRONG in a way that read fine: with an optional
 *  separator class, `^\s*SENTINEL\s*[—:-]?\s*\S.{2,}` backtracks — it declines to consume the
 *  em-dash as the separator and counts it as the reason's first character instead, so a bare
 *  `SENTINEL — ab` satisfied the "≥3 characters of reason" rule with a dash and two letters.
 *  Caught by the test that asserts a reasonless sentinel does NOT release; a stricter-looking
 *  pattern that silently accepts the empty case is exactly the shape this gate cannot afford.
 *
 *  ANCHORED at the start of the trimmed block: a fork REVIEWING this gate quotes the sentinel in
 *  its findings (this file's own reviewers did), and a substring test would let that quotation
 *  release the agent under review. Nothing is stripped first, so `> SENTINEL` and `# SENTINEL`
 *  correctly fail — stripping the marker would be the very smuggling the anchor exists to stop. */
export function isNoReviewSentinel(text: string): boolean {
  const t = text.replace(/^\s+/, '')
  if (!t.startsWith(NO_REVIEW_SENTINEL)) return false
  const [firstLine, ...tail] = t.slice(NO_REVIEW_SENTINEL.length).split('\n')
  // NOTHING may follow the reason line, and this check is the load-bearing half of the escape.
  // Prose in a SEPARATE block does re-arm the gate positionally — its own index sets `lastWork`
  // above the sentinel's — so that case was always safe. But prose on a LATER LINE OF THE SAME
  // block carries no index of its own and cannot re-arm anything, and one text block is exactly
  // how a model emits contiguous prose. Constraining only `split('\n')[0]` therefore released
  // sentinel-then-entire-essay: the likely shape, not the unlikely one.
  if (tail.some((line) => line.trim() !== '')) return false
  // Any of — : - is accepted as the separator, because an agent told to write an em-dash types a
  // hyphen often enough that keying the escape on punctuation would re-wedge an agent that obeyed
  // in substance. The reason itself must survive stripping them and be at least 8 characters — a
  // bound picked so every example the block message itself offers (`NO_REVIEW_SENTINEL_EXAMPLES`:
  // "rate-limited", "at a depth limit", "tool denied") passes it, while a token like "foo" does
  // not. Adversarial review 2026-09-10: a floor of ">=3 chars" let "foo" through, and a proposed
  // ">=12 chars AND a space" rejected "rate-limited" (no space) and "tool denied" (11 chars) — a
  // rejected sentinel leaves the agent that emitted it with no exit from the gate.
  const reason = firstLine.replace(/^[\s—:-]+/, '').trim()
  return reason.length >= 8
}

interface TranscriptEntry {
  type?: unknown
  isSidechain?: unknown
  message?: { content?: AssistantContentBlock[] | string }
  /** ISO timestamp Claude Code stamps on every transcript entry — read only for `lastForkTs`. */
  timestamp?: unknown
}

/** The epoch ms of an entry's own `timestamp`, or 0 (fail closed: everything on disk is newer
 *  than the epoch) when the field is absent or does not parse. */
function entryTs(e: TranscriptEntry): number {
  if (typeof e?.timestamp !== 'string') return 0
  const ms = Date.parse(e.timestamp)
  return Number.isNaN(ms) ? 0 : ms
}

const EDITORS = new Set(['Edit', 'Write', 'NotebookEdit'])

/** A background tool's result names the job it started; the job's exit arrives later as a
 *  `<task-id>` notification. Keyed by TOOL: a foreground Read or Bash whose OUTPUT quotes one of
 *  these lines (a probe of a transcript, a `cat` of a task file) must not be mistaken for a
 *  launch — that would leave its interval open forever (review finding 2, TRDD-3U8AIHXK). */
const BACKGROUND_BASH_ID = /^Command running in background with ID: ([A-Za-z0-9]+)/
const BACKGROUND_AGENT_ID = /agentId: ([A-Za-z0-9]+)/
const AGENT_LAUNCHED = 'Async agent launched successfully'
/** A command that detaches work from its own Bash call — the result returns while the job runs
 *  on. Text heuristic, deliberately fail-CLOSED: a match keeps the interval open (the pre-3U8AIHXK
 *  behaviour for that session); a detached job the pattern does not name is a named residual.
 *  A trailing `&` covers `cmd &`; a MID-line `&` after whitespace or `)` also backgrounds a job
 *  — `( sleep 5; touch x ) & echo started` keeps writing after the shell itself exits, and the
 *  old end-anchored form missed it entirely. Guarded against false positives: `&&` (a chain, not
 *  a backgrounder — `(?![&>])` excludes it) and a URL query string like `curl '…?a=1&b=2'` (the
 *  `&` follows `1`, not whitespace or `)`, so `(?<=[\s)])` never matches it) and `cmd 2>&1` (the
 *  `&` follows `>`, excluded by the lookahead). */
const DETACHED_JOB = /\b(?:nohup|setsid|disown|detach-run\.py)\b|(?<=[\s)])&(?![&>])|(?<![&>])&\s*$/m

export function resultText(c: unknown): string {
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c.map((x) => String((x as { text?: unknown })?.text ?? '')).join('\n')
}
/** `tool === '*'` means "unknown" — a tool_result whose tool_use fell before the scan window, so
 *  we never saw which tool opened it (TRDD-3U8AIHXK). Try BOTH anchored shapes rather than none:
 *  a pre-window background Bash whose result lands inside the window must still be recognized as
 *  a launch and kept open, not closed at that very result for lack of a known tool name. */
function backgroundJobId(tool: string, text: string): string | null {
  if (tool === 'Bash' || tool === '*') {
    const m = BACKGROUND_BASH_ID.exec(text)?.[1]
    if (m) return m
  }
  if ((tool === 'Agent' || tool === '*') && text.includes(AGENT_LAUNCHED)) {
    return BACKGROUND_AGENT_ID.exec(text)?.[1] ?? null
  }
  return null
}

/** The one arming block of a turn, and WHY. `null` from the editor branch means the edit landed
 *  under an ephemeral root (the scratchpad, reports/) and is not work. */
export function toolUseWork(b: AssistantContentBlock, cwd: string): { cause: ArmCause; detail: string } | null {
  if (typeof b.name === 'string' && EDITORS.has(b.name)) {
    const file = String(b.input?.file_path ?? b.input?.notebook_path ?? '')
    return isEphemeralTarget(file, cwd) ? null : { cause: 'edit', detail: `${b.name} ${path.basename(file)}` }
  }
  if (b.name === 'Bash') {
    const why = commandWriteReason(String(b.input?.command ?? ''), cwd)
    return why === null ? null : { cause: 'write-shaped command', detail: why }
  }
  return null
}

export function hookCwd(input: ReviewGateInput): string {
  return typeof input?.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd()
}

// ── MAIN AGENT GATE (Stop) ──────────────────────────────────────────────────────────────────────

/** Read only the tail of a (possibly huge) transcript — the answer is always near the end. */
export function readTranscriptTail(transcriptPath: string, maxBytes = 4 * 1024 * 1024): string[] | null {
  try {
    const fd = fs.openSync(transcriptPath, 'r')
    const size = fs.fstatSync(fd).size
    const span = Math.min(size, maxBytes)
    const buf = Buffer.alloc(span)
    fs.readSync(fd, buf, 0, span, size - span)
    fs.closeSync(fd)
    // Drop the first line when the window started mid-record; a torn record is not JSON.
    let lines = buf.toString('utf8').split('\n')
    if (span < size) lines = lines.slice(1)
    return lines.filter(Boolean)
  } catch {
    return null
  }
}

export interface MainScan {
  lastFork: number
  /** Epoch ms of the last fork (the entry that set `lastFork`), so `runMainGate` can ask
   *  `unreviewedEffects` for disk writes newer than it. No fork in the window ⇒ the timestamp of
   *  the window's FIRST parsed entry (still a valid lower bound — anything before the window
   *  opened is out of scope for this Stop); an absent/unparsable field ⇒ 0 (fail closed: 0 makes
   *  every mtime on disk "newer", i.e. arms rather than silently trusting a clock it cannot read). */
  lastForkTs: number
  /** The last arming block, or null when nothing in the window is work. Index + cause travel
   *  together so the block message can never name a cause the scan did not find. */
  work: { index: number; cause: MainArmCause; detail: string } | null
  /** Every tool_use in the window, as an attribution interval (TRDD-3U8AIHXK) — see
   *  `scanMainTranscriptLines`. */
  activity: Activity[]
  /** Highest index at which each role (MEASURE / REVIEW) was credited, -1 when absent. A SPAWN
   *  (an Agent tool_use whose prompt carries `ROLE: MEASURE`/`ROLE: REVIEW`) credits its role only
   *  while it is still open — see `scanMainTranscriptLines`'s pending-spawn resolution. A RESULT
   *  (a tool_result or background-job notification carrying the matching heading) credits its role
   *  permanently, whatever the spawn's open/closed state. */
  roles: { measure: number; review: number }
}
/** The positional pair `decideMainGate` reads; `lastWork` is -1 when nothing armed. */
export const scanPositions = (s: MainScan): { roles: { measure: number; review: number }; lastWork: number } =>
  ({ roles: s.roles, lastWork: s.work?.index ?? -1 })

/** Scan the main transcript's tail for the last fork spawn and the last arming block, and WHY it
 *  armed. Pure — the whole "relative position, not turn boundaries" rule lives here, so it is
 *  testable without a real transcript file. WHAT counts as work is decided in the triggers module
 *  (TRDD-0E3W5C45); `cwd` is the hook's, for resolving relative write targets. */
export function scanMainTranscriptLines(lines: string[], cwd = process.cwd()): MainScan {
  let lastFork = -1
  let lastForkTs = 0
  let firstTs = 0
  let firstTsSeen = false
  let work: MainScan['work'] = null
  const activity: Activity[] = []
  const roles: MainScan['roles'] = { measure: -1, review: -1 }
  // A SPAWN credits its role ONLY while its agent has not yet returned — i.e. while the interval
  // opened for its tool_use is still open (Infinity), whether kept open by `openByToolUse` (no
  // tool_result yet) or by `openByTask` (a background job whose notification has not arrived).
  // Checked ONCE, after the whole window is scanned, because "still open" can only be known then.
  // Once a result DOES land, only `resultRole` on that result counts — permanently, whatever the
  // heading says. This is what makes the turn that launches both agents release its OWN Stop
  // (neither has returned yet) while an agent that returns later WITHOUT its heading still blocks
  // the next Stop (owner correction 2026-09-13, C5 — retracts an earlier "string-content user
  // entry expires the spawn" design: that design expired credit on a heartbeat, on the owner
  // typing mid-turn, and on the gate's own block message, none of which is the agent returning).
  // HONEST LIMITATION: an agent that never returns keeps its interval open forever, so it also
  // keeps its spawn credit forever — the no-review sentinel is the intended exit for that case;
  // this is not patched with a timeout or an entry-count heuristic.
  const pendingSpawns: { role: Role; index: number; activity: Activity }[] = []
  // Open intervals, by the tool_use id its tool_result will carry, and — once a background job's
  // result named it — by the job id its `<task-id>` notification will carry.
  const openByToolUse = new Map<string, { a: Activity; tool: string }>()
  const openByTask = new Map<string, Activity>()
  for (let i = 0; i < lines.length; i++) {
    let e: TranscriptEntry
    try { e = JSON.parse(lines[i]) as TranscriptEntry } catch { continue }
    // The FIRST parsed entry's own timestamp is the fallback `lastForkTs` when no fork is found —
    // read before the sidechain/type filters below, because it is a property of the WINDOW, not
    // of an assistant block.
    if (!firstTsSeen) { firstTs = entryTs(e); firstTsSeen = true }
    // Subagent turns are marked `isSidechain: true` — skipping them means a sidechain transcript
    // yields no work and no fork, so the gate allows the stop and stays silent.
    if (e?.isSidechain === true) continue
    // A background job's EXIT is recorded by the harness as an `attachment` entry or a
    // string-content `user` entry, both carrying `<task-id>ID</task-id>` (measured on this
    // project's own JSONL, 2026-09-10) — the first one closes the job's interval.
    // `queue-operation` is deliberately EXCLUDED: the harness writes one on ENQUEUE too, so a
    // queue-operation naming the id can precede the job's actual exit and close the interval
    // early. Array-content user entries are tool_results and may QUOTE a notification (a Read
    // of the job's output file), so they never close anything either.
    if (e?.type === 'attachment' || (e?.type === 'user' && typeof e?.message?.content === 'string')) {
      // RESULT source (background): a task-notification names the job whose result it is — its
      // role is credited from the RAW LINE whether or not that job's interval is still tracked
      // open (a notification for an agent spawned before the scan window still proves the review
      // ran). GATED ON THE TASK-ID TAG, deliberately: without it, the gate's OWN block message
      // (which must publish "ROLE: MEASURE"/"ROLE: REVIEW" and both headings so agents can obey
      // it) lands as a string-content `user` entry too and would credit both roles from its own
      // text — a self-crediting hole (owner correction 2026-09-13, C8). The explicit
      // `Stop hook feedback:` exclusion is a second, redundant net over the same hole.
      if (lines[i].includes('<task-id>') && !lines[i].includes('Stop hook feedback:')) {
        const role = resultRole(lines[i])
        if (role !== null) roles[role] = Math.max(roles[role], i)
      }
      if (openByTask.size > 0) {
        for (const [id, a] of openByTask) {
          if (lines[i].includes(`<task-id>${id}</task-id>`)) { a.end = entryTs(e) || a.end; openByTask.delete(id) }
        }
      }
    }
    const content = e?.message?.content
    if (!Array.isArray(content)) continue
    if (e?.type === 'user') {
      for (const b of content) {
        if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
        // A result whose tool_use fell before the window opened: the tool ran from (at least) the
        // window's start until now — open that span rather than lose the write (review finding 4).
        const open = openByToolUse.get(b.tool_use_id)
        openByToolUse.delete(b.tool_use_id)
        const a = open?.a ?? { start: firstTs, end: Infinity }
        if (open === undefined) activity.push(a)
        const text = resultText(b.content)
        // RESULT source (foreground): permanent, whatever the outcome — a result WITHOUT the
        // heading costs the role its credit even though the agent DID return (owner correction
        // 2026-09-13, C5's third test case).
        const role = resultRole(text)
        if (role !== null) roles[role] = Math.max(roles[role], i)
        // A background tool returns at once and keeps running: its result names the job, and the
        // interval stays open until that job's notification (above).
        const job = backgroundJobId(open?.tool ?? '*', text)
        if (job !== null) openByTask.set(job, a)
        else a.end = entryTs(e) || a.end
      }
      continue
    }
    if (e?.type !== 'assistant') continue
    for (const b of content) {
      if (b?.type === 'text') {
        // THE SAME EXIT THE SUBAGENT GATE HAS, and it is needed here for a reason the positional
        // rule hides. `lastFork >= lastWork` is always *reachable* — but only by an agent that can
        // actually SPAWN. An agent whose Agent tool is declared yet whose spawn cannot succeed —
        // rate-limited (this machine saw a 7994 s limit on 2026-09-07), at a depth or concurrency
        // ceiling, or denied by a PreToolUse rule — has no exit at all: `agentCannotSpawn` releases
        // only agents with no Agent tool DECLARED, which is a different population.
        // Sets `lastFork` and NOT `work` — the sentinel is an exit, not a proposal. Prose on a
        // later LINE of the SAME block has no index and cannot re-arm — `isNoReviewSentinel`
        // rejects a block carrying anything after the reason line.
        const text = String(b.text ?? '')
        if (isNoReviewSentinel(text)) {
          // A definitive statement, not a pending spawn — credit BOTH roles permanently.
          lastFork = i; lastForkTs = entryTs(e)
          roles.measure = Math.max(roles.measure, i); roles.review = Math.max(roles.review, i)
          continue
        }
        // A PROPOSAL IS WORK (owner order 2026-09-07) — a MARKED one (owner order 2026-09-08). For
        // one day EVERY text block was work, and that livelocked idle turns: a heartbeat's
        // `janitor heartbeat` line armed the gate, and every reply to the block re-armed it
        // (TRDD-0E3W5C45). The marker is decided in the triggers module.
        if (textArms(text)) work = { index: i, cause: 'proposal text', detail: '' }
        continue
      }
      if (b?.type !== 'tool_use') continue
      // Every tool_use opens an attribution interval (TRDD-3U8AIHXK): this session's own writes —
      // foreground tools, workers, scripts, background jobs — can only land while one of its tools
      // is running. `end` stays Infinity (fail closed) until the tool reports back.
      const a: Activity = { start: entryTs(e), end: Infinity }
      activity.push(a)
      const tool = typeof b.name === 'string' ? b.name : ''
      // A detached job outlives its own result — leave the interval open (see DETACHED_JOB).
      const detached = tool === 'Bash' && DETACHED_JOB.test(String(b.input?.command ?? ''))
      if (typeof b.id === 'string' && !detached) openByToolUse.set(b.id, { a, tool })
      if (b.name === 'Agent') {
        // SPAWN source: ANY Agent tool_use, whatever its subagent_type — a cheap lean-worker is a
        // valid MEASURE agent. Deferred: resolved only after the whole window is scanned, and only
        // credited if `a` is still open then (see the pendingSpawns comment above).
        const role = forkRole(String(b.input?.prompt ?? ''))
        if (role !== null) pendingSpawns.push({ role, index: i, activity: a })
      }
      // CASE-FOLDED, same as the subagent scanner: a subagent_type of "Fork" is still a fork.
      // A review fork's interval closes like any other spawn's — its result or its notification.
      // A zero-length interval keyed on its prompt was proposed and REJECTED in review: a fork
      // spawned with the ONE-turn line pasted and then used as a worker would write unattributed.
      if (b.name === 'Agent' && String(b.input?.subagent_type ?? '').trim().toLowerCase() === 'fork') {
        lastFork = i; lastForkTs = entryTs(e); continue
      }
      const w = toolUseWork(b, cwd)
      if (w !== null) work = { index: i, ...w }
    }
  }
  for (const p of pendingSpawns) {
    if (p.activity.end === Infinity) roles[p.role] = Math.max(roles[p.role], p.index)
  }
  return { lastFork, lastForkTs: lastFork === -1 ? firstTs : lastForkTs, work, activity, roles }
}

/** Fold a `unreviewedEffects()` result into the scan. Additive and positional, mirroring how a
 *  transcript fork/edit already work: an effect is placed at `lastFork + 1` — "a fork must
 *  follow it" — UNLESS a text arm already sits strictly after the last fork, in which case that
 *  arm already blocks and is left alone (both would block identically; keeping the more specific
 *  transcript-derived cause is more useful to the agent reading the message). The write may have
 *  been made by a worker, a script, a fork-as-worker, or a background job the transcript never
 *  shows at all — the effects walk sees it regardless of who made it.
 *  Returns `scan` BY REFERENCE when there is nothing to fold in, so a caller can skip work on the
 *  common (nothing changed) case. */
export function applyEffects(scan: MainScan, fx: Effects): MainScan {
  if (!fx.truncated && fx.paths.length === 0) return scan
  if (scan.work !== null && scan.work.index > scan.lastFork) return scan // an existing arm already blocks
  const shown = fx.paths.slice(0, 8).join(', ')
  const overflow = fx.paths.length > 8 ? ` (+${fx.paths.length - 8} more)` : ''
  const detail = (fx.truncated ? 'walk truncated — ' : '') + shown + overflow
  return { ...scan, work: { index: scan.lastFork + 1, cause: 'unreviewed change', detail } }
}

/** The rule: allow the stop iff BOTH roles are credited AT OR AFTER the last consequential action.
 *  Pure decision over an already-scanned transcript. NO BREAKER STATE — see the NO GIVE-UP
 *  paragraph below. A missing role is -1, so `Math.min` degenerates to -1 and blocks whenever
 *  either role was never credited — one role alone is not enough (owner spec 2026-09-13). */
export function decideMainGate(scan: { roles: { measure: number; review: number }; lastWork: number }): { block: boolean } {
  if (scan.lastWork === -1) return { block: false } // nothing claimed this window
  // `>=`, not `>`: two blocks CAN share an index when a harness writes one transcript entry per
  // assistant message, and a tie must go to the fork or that turn can never end. MEASURED
  // 2026-09-07 on this project's own session JSONL: this Claude Code build writes ONE ENTRY PER
  // CONTENT BLOCK (thinking / text / tool_use each got their own index), so the tie never occurs
  // here and `>=` is degenerate on this format. It is kept because it is correct on both shapes.
  // THE EXIT IS POSITIONAL, so both roles must be credited AT OR AFTER the last arming block of the
  // turn. Because this build writes one entry per content block (see below), prose emitted AFTER a
  // fork re-arms the gate and the turn is blocked again. Spawn the review as the turn's final act,
  // not mid-turn.
  if (Math.min(scan.roles.measure, scan.roles.review) >= scan.lastWork) return { block: false } // both reviewed — the only way past the gate
  // NO GIVE-UP. The consecutive and per-session breakers were REMOVED (owner order, 2026-09-03:
  // "it must NEVER BE STOPPED OR BYPASSED, no matter what") and their state (`MainBreakerState`,
  // `total`/`consecutive`) is gone too — it was read every call and then discarded, decided nothing
  // (nothing in this repo ever branched on it once the give-up path was deleted), and the tmpdir
  // persistence that used to consume it was removed in 53a30222. They used to fail OPEN on the
  // reasoning that a wedged session costs more than a skipped review — but the measured outcome was
  // worse: on 2026-09-03 this session ignored the demand twice, `consecutive` reached 2, the gate
  // went silent, and EVERY subsequent change went unreviewed with nothing announcing it. A silent
  // stop is the one failure a safety gate must not have.
  //
  // The exit is always available and is the thing being asked for: spawn both agents and the
  // branch above returns immediately once they are credited. The caller ALSO applies
  // `agentCannotSpawn` so an agent that has no Agent tool is released rather than wedged — a
  // capability check, not a give-up. That check was missing from the main gate when this comment
  // first claimed it (review finding G2).
  return { block: true }
}

// The ONE-TURN rule lives HERE, in the text the agent reads on every single fire, because that is
// what actually changes behaviour. A PreToolUse deny was tried and reverted: nothing registers
// review-gate on PreToolUse, it could not tell a review fork from any other fork (they all share
// `subagent_type: 'fork'`), and it would not have prevented turn 2 anyway — the deny returns as a
// tool RESULT and reacting to it is the cold request. Measured 2026-09-03: six multi-turn review
// forks cost ~4.6M tokens; the first zero-tool-call fork answered in 18s off one warm read.
export const ARM_CAUSE_TEXT: Record<MainArmCause, string> = {
  'edit': 'edited a file',
  'write-shaped command': 'ran a write-shaped command',
  'proposal text': 'made a proposal (a PROPOSAL line)',
  'unreviewed change': 'left unreviewed changes on disk',
}
/** The block message names WHAT armed the gate. It said "edited or committed" unconditionally from
 *  2026-09-07, when a proposal became work, until TRDD-0E3W5C45 — so a blocked agent that had edited
 *  nothing was told it had, and could not tell which of its blocks to review. */
export function mainBlockReason(cause: MainArmCause, detail = ''): string {
  const what = detail === '' ? ARM_CAUSE_TEXT[cause] : `${ARM_CAUSE_TEXT[cause]}: ${detail}`
  // NAMES THE SCANNED WINDOW, NOT "THIS TURN" — but the window differs BY CAUSE, because the two
  // causes come from two DIFFERENT scans. Every cause but 'unreviewed change' is found by
  // `scanMainTranscriptLines` over `readTranscriptTail`'s last 4 MB (see its `maxBytes` default),
  // so "this turn" would claim certainty the scan does not have — a long turn's earlier blocks can
  // be outside that window. 'unreviewed change' instead comes from `unreviewedEffects`'s mtime walk
  // (`applyEffects`, `runMainGate`), which never reads the transcript at all — saying "scanned: the
  // transcript's last 4 MB" for it would name the wrong scan and mislead the agent about where to
  // look. Matches `reviewSupervisor.ts`'s own care about the identical overclaim.
  const window = cause === 'unreviewed change'
    ? 'files on disk newer than that fork'
    : "the transcript's last 4 MB"
  return `Review-fork gate: ${what} landed after the last review fork `
    + `(scanned: ${window}). ` + MAIN_BLOCK_DEMAND
}
export const MAIN_BLOCK_DEMAND = 'Spawn TWO agents: a MEASURE agent (any subagent type — a `lean-worker` '
  + '(sonnet[1m], no inherited conversation context) is the PREFERRED choice, MEASURED at 143,363 tokens '
  + "against a fork's 306,777 on the identical task, with an equally usable report) and a REVIEW agent "
  + '(Agent tool, subagent_type "fork"). COPY '
  + 'THIS LINE VERBATIM INTO THE MEASURE PROMPT: "' + MEASURE_ROLE_RULE + '" COPY THIS LINE VERBATIM '
  + 'INTO THE REVIEW PROMPT: "' + REVIEW_ROLE_RULE + '" Neither agent can see this message, so a rule '
  + 'you do not paste into its prompt never reaches it. Extra turns are not free, so measure only what '
  + 'the proposal actually rests on. Run `agentlenspro '
  + 'review-gate --directive` for the full directive, then act on the findings. THE EXIT IS POSITIONAL: '
  + 'put the fork tool_use LAST, after the measure tool_use, in the SAME response as any user-visible text '
  + "you have, at or after the turn's last edit, write-shaped command or PROPOSAL line — one of those "
  + 'after the fork re-arms this gate; plain text after it does not. If you CANNOT spawn either — '
  + NO_REVIEW_SENTINEL_EXAMPLES.join(', ') + ' '
  + '— emit a text block whose ENTIRE content is "' + NO_REVIEW_SENTINEL + ' — <reason>", nothing '
  + 'after the reason; that is the only other way out.'

// Exported for the end-to-end test in src/test/reviewGate.test.ts, whose mutation check is
// dropping the `applyEffects(rawScan, unreviewedEffects(...))` fold below (TRDD-9FG0LSPG).
export async function runMainGate(input: ReviewGateInput): Promise<string | null> {
  const transcript = input?.transcript_path
  if (typeof transcript !== 'string' || !fs.existsSync(transcript)) {
    process.stderr.write('[review-gate] allowing UNREVIEWED: transcript_path is missing or does not exist\n')
    return null
  }
  const lines = readTranscriptTail(transcript)
  if (lines === null) {
    process.stderr.write('[review-gate] allowing UNREVIEWED: could not read the transcript tail\n')
    return null
  }
  const cwd = hookCwd(input)
  const rawScan = scanMainTranscriptLines(lines, cwd)
  // Fold in disk effects newer than the last fork (TRDD-9FG0LSPG) — a worker's edit, a script's
  // write, or a fork-as-worker's own change never appears as a tool_use in THIS transcript, so
  // the transcript scan alone would release it unreviewed.
  const scan = applyEffects(rawScan, unreviewedEffects(cwd, rawScan.lastForkTs, { activity: rawScan.activity }))
  const verdict = decideMainGate(scanPositions(scan))
  // A block implies an arming block was found (`lastWork !== -1` ⇔ `work !== null`); the second
  // test only narrows the type, so the message can never name a cause the scan did not find.
  if (!verdict.block || scan.work === null) return null
  // CAPABILITY CHECK, not a give-up: an agent that has no Agent tool cannot satisfy the demand, and
  // blocking it forever wedges the session with no exit. The subagent gate already did this; the
  // main gate did not, which made the "this cannot wedge" comment above false until now (G2).
  // `stop_hook_active` is deliberately NOT honoured — that would be a one-block cap by another name.
  if (agentCannotSpawn(String(input?.agent_type ?? ''))) {
    process.stderr.write('[review-gate] the Agent tool is unavailable here, so the review cannot be demanded — allowing the stop UNREVIEWED.\n')
    return null
  }
  return JSON.stringify({ decision: 'block', suppressOutput: true, reason: mainBlockReason(scan.work.cause, scan.work.detail) })
}

// ── SUBAGENT GATE (SubagentStop) ───────────────────────────────────────────────────────────────

/** Agent types that ARE the adversarial reviewer and must never be reviewed themselves. Compared
 *  whole and case-folded — never as a substring, or every `*-fork-*` agent inherits the exemption.
 *  Adding a name here skips that agent's review, so add only a genuine reviewer. */
export const REVIEWER_AGENT_TYPES = new Set(['fork'])

/** Scan a subagent's OWN transcript for whether it did consequential work and whether it already
 *  spawned its own reviewer. Pure — mirrors scanMainTranscriptLines but without the fork-position
 *  logic (a subagent gets at most ONE demand, never a relative-position check). */
export function scanSubagentTranscriptLines(lines: string[], cwd = process.cwd()): { didWork: boolean; reviewed: boolean; ownRole: Role | null } {
  let didWork = false
  let reviewed = false
  let ownRole: Role | null = null
  let sawFirstUser = false
  for (const line of lines) {
    if (!line) continue
    let e: TranscriptEntry
    try { e = JSON.parse(line) as TranscriptEntry } catch { continue }
    // Symmetric with scanMainTranscriptLines. Whether an agent's own file can contain its
    // CHILDREN's entries is unverified; filtering makes this correct under both answers instead of
    // betting on one, and stops a child's prose from being scored as the parent's work.
    if (e?.isSidechain === true) continue
    // The subagent's OWN spawning prompt is its FIRST non-sidechain `user` entry — read ONCE, so a
    // later human-authored `user` turn mid-conversation is never mistaken for it (owner correction
    // 2026-09-13, C3/C6 — a role-marked agent is exempt from being told to spawn its own reviewer).
    if (!sawFirstUser && e?.type === 'user') {
      sawFirstUser = true
      const c = e?.message?.content
      const promptText = typeof c === 'string' ? c : Array.isArray(c) ? resultText(c) : ''
      ownRole = forkRole(promptText)
    }
    const content = e?.message?.content
    if (e?.type !== 'assistant' || !Array.isArray(content)) continue
    for (const b of content) {
      // A MARKED PROPOSAL IS WORK — see scanMainTranscriptLines. A subagent's plain-prose report
      // (an Explore result, a status line) is not, or every returning worker owes a fork.
      if (b?.type === 'text') {
        // THE TERMINATOR. Without it the block is a LIVELOCK: the demand tells a subagent to state
        // its inability and return, but that statement is itself a `text` block, so it re-arms
        // `didWork` and the identical demand fires again over a strictly longer transcript. Every
        // other brake on this path is gone by design (no enforcement switch, no per-agent demand
        // cap), so `reviewed` is the ONLY exit and until now the only way to set it was spawning a
        // fork — impossible for an agent that has the
        // Agent tool but is out of turns, budget, or depth. The escape must therefore set the same
        // flag the fork sets.
        //
        // ANCHORED AT THE START of a trimmed block, deliberately: a fork REVIEWING this gate quotes
        // the sentinel mid-prose (this file's own reviewers did), and a substring test would let
        // that quotation release the very agent under review. Nothing is stripped first — a
        // markdown-quoted `> REVIEW-GATE: ...` or a `# REVIEW-GATE: ...` heading must NOT match,
        // and stripping the marker would be the very smuggling this anchor exists to stop.
        const text = String(b.text ?? '')
        if (isNoReviewSentinel(text)) { reviewed = true; didWork = true; continue }
        if (textArms(text)) didWork = true
        continue
      }
      if (b?.type !== 'tool_use') continue
      // CASE-FOLDED, same as scanMainTranscriptLines — a subagent_type of "Fork" is still a fork.
      if (b.name === 'Agent' && String(b.input?.subagent_type ?? '').trim().toLowerCase() === 'fork') reviewed = true
      else if (toolUseWork(b, cwd) !== null) didWork = true
    }
  }
  return { didWork, reviewed, ownRole }
}

/** Pure decision: demand a review from a subagent, and only when it (a) is not the reviewer
 *  itself (recursion guard on `agent_type`), (b) its own transcript proves it did work and has
 *  not already reviewed itself. There is no enforcement switch and no per-agent demand cap — see
 *  the "NOT BYPASSABLE" comment below. */
export function decideSubagentGate(
  agentType: string,
  scan: { didWork: boolean; reviewed: boolean; ownRole?: Role | null } | null,
): { block: boolean } {
  // THE RECURSION GUARD — a review fork is itself a subagent; reviewing it spawns a reviewer for
  // the reviewer. Empty type is the internal micro-lookup class — skipped for cost, and because an
  // agent that will not name itself cannot be told apart from a reviewer.
  //
  // WHOLE-TOKEN, not a substring. `/fork/i` exempted every agent type with "fork" anywhere in it —
  // `worktree-fork`, `fork-worker`, `wtfork` — none of which is the adversarial reviewer, all of
  // which then returned unreviewed for free. The owner's carve-out (2026-09-07) is for "the
  // adversarial review fork agents themselves, of course, to avoid infinite recursion", i.e. the
  // agents spawned as `subagent_type: "fork"`, whose `agent_type` is exactly `fork`.
  //
  // Narrowing a release guard is DEMAND-direction, so it is the dangerous direction: getting it
  // wrong wedges a reviewer instead of skipping a review. That is safe here only because the
  // sentinel above is now a real exit — a reviewer this list failed to name can still terminate by
  // stating why. Before the sentinel existed, this narrowing would have been a livelock generator.
  if (agentType === '' || REVIEWER_AGENT_TYPES.has(agentType.trim().toLowerCase())) {
    return { block: false }
  }
  // A subagent whose OWN prompt declares it the REVIEW role is exempt for the same reason a
  // `subagent_type: "fork"` reviewer is: REVIEW_ROLE_RULE demands ZERO tool calls, so it cannot
  // itself arm the gate. MEASURE is DELIBERATELY NOT exempt here — it has an unbounded tool budget
  // (MEASURE_ROLE_RULE) and must be reviewed like any other worker that did consequential work.
  // Narrowed from `forkRole(...) !== null` to `=== 'review'` (owner correction 2026-09-13, C6):
  // exempting MEASURE too would let its writes through unreviewed.
  if (scan?.ownRole === 'review') return { block: false }
  // NOT BYPASSABLE (owner order, 2026-09-03: "Not even for the subagents!"). There is no
  // enforcement switch and no per-agent demand cap: a subagent that did work and has not reviewed
  // itself is asked EVERY time it tries to return, not once.
  if (!scan || !scan.didWork || scan.reviewed) return { block: false }
  return { block: true }
}

function readSubagentScan(transcriptPath: string, cwd: string): { didWork: boolean; reviewed: boolean; ownRole: Role | null } | null {
  try { return scanSubagentTranscriptLines(fs.readFileSync(transcriptPath, 'utf8').split('\n'), cwd) } catch { return null }
}

// Carries the same pasted rule as the main gate. It did not until 2026-09-03, which made every
// subagent-spawned review a multi-turn one by default — the gate that costs the most forks was the
// one channel that never stated the constraint.
export const SUBAGENT_BLOCK_REASON = 'Subagent review gate: before returning, spawn TWO agents over your '
  + 'work — a MEASURE agent (any subagent type — a `lean-worker` (sonnet[1m], no inherited conversation '
  + "context) is the PREFERRED choice, MEASURED at 143,363 tokens against a fork's 306,777 on the "
  + 'identical task, with an equally usable report) and a REVIEW agent (Agent tool, subagent_type '
  + '"fork"). COPY THIS LINE VERBATIM INTO THE MEASURE PROMPT: "'
  + MEASURE_ROLE_RULE + '" COPY THIS LINE VERBATIM INTO THE REVIEW PROMPT: "' + REVIEW_ROLE_RULE + '" '
  + 'Neither agent can see this message, so a rule you do not paste into its prompt never reaches it. '
  + 'Run `agentlenspro review-gate --directive` for the full directive, then act '
  + 'on their findings. If you CANNOT spawn either — no Agent tool, rate-limited, at a depth limit — '
  + `then emit a text block whose ENTIRE content is "${NO_REVIEW_SENTINEL} — <reason>" and return; `
  + 'that is the only other way out. It must START the block and nothing may follow the reason (a '
  + 'quoted copy will not count).'

async function runSubagentGate(input: ReviewGateInput): Promise<string | null> {
  if (input?.stop_hook_active === true) return null
  const type = String(input?.agent_type ?? '')
  if (agentCannotSpawn(type)) return null
  const own = input?.agent_transcript_path
  // `agent_transcript_path` is the subagent's OWN file — `transcript_path` names the PARENT's and
  // would measure the wrong agent entirely.
  const scan = typeof own === 'string' && fs.existsSync(own) ? readSubagentScan(own, hookCwd(input)) : null
  const verdict = decideSubagentGate(type, scan)
  if (!verdict.block) return null
  return JSON.stringify({ decision: 'block', suppressOutput: true, reason: SUBAGENT_BLOCK_REASON })
}

// ── Process entry for `agentlenspro review-gate` ───────────────────────────────────────────────

/** `agentlenspro review-gate [--directive]`. Always resolves 0 — a Stop/SubagentStop hook that
 *  can throw or hang can wedge the session, which is worse than a missed review. Dispatches on
 *  `hook_event_name`: `PreToolUse` -> the fork one-turn deny, `SubagentStop` -> the subagent gate,
 *  `Stop` (or an absent field, honored the same way the ported scripts did) -> the main gate. Any
 *  other event is a silent allow. */
export async function runReviewGate(argv: string[]): Promise<number> {
  if (argv[0] === '--directive') {
    process.stdout.write(REVIEW_GATE_DIRECTIVE)
    return 0
  }
  // GLOBAL kill-switch, before stdin — mirrors runHookCommand('gate'): a disabled AgentlensPro
  // must never block the user's work. Named on stderr, matching the four other silent-allow
  // lines in this file — a silent bypass is exactly the failure class this gate exists to close
  // (review finding G3). Names WHICH half fired rather than claiming it was "disabled by the
  // owner": the env half can be set by anything in the process tree, not just a human act.
  if (agentlensDisabled()) {
    const half = killSwitchHalf() === 'env'
      ? 'env AGENTLENS_DISABLED=1'
      : `the kill-switch flag file (${killSwitchPath()})`
    process.stderr.write(`[review-gate] allowing UNREVIEWED: ${half} is set.\n`)
    return 0
  }
  const payload = await readStdin(process.stdin)
  // THE ENV KILL-SWITCH IS GONE (owner order, 2026-09-03: "it must NEVER BE STOPPED OR BYPASSED, no
  // matter what"). `AGENTLENS_REVIEW_FORK=off` and `AGENTLENS_SUBAGENT_REVIEW=off` are now ignored:
  // an env var is settable by anything in the process tree, so it was a bypass available to the very
  // agent the gate exists to constrain. The standing order already forbade using it
  // (memory: review-fork-gate-never-disabled); this makes the forbiddance structural instead of
  // honour-based. Uninstalling the hook remains possible and is deliberately a visible, human act.
  if ((process.env.AGENTLENS_REVIEW_FORK || '').trim() === 'off') {
    process.stderr.write('[review-gate] AGENTLENS_REVIEW_FORK=off is IGNORED — the review gate cannot be disabled.\n')
  }
  let input: ReviewGateInput
  try { input = JSON.parse(payload.toString('utf8')) as ReviewGateInput } catch {
    process.stderr.write('[review-gate] allowing UNREVIEWED: the hook payload is not valid JSON\n')
    return 0
  }
  const evt = input?.hook_event_name ?? input?.hookEventName
  let out: string | null = null
  if (evt === 'SubagentStop') {
    out = await runSubagentGate(input)
  } else if (typeof evt !== 'string' || evt === 'Stop') {
    out = await runMainGate(input)
  } else {
    process.stderr.write(`[review-gate] allowing UNREVIEWED: unknown hook_event_name ${JSON.stringify(evt)}\n`)
  }
  if (out) process.stdout.write(out + '\n')
  return 0
}
