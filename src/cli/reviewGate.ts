// src/cli/reviewGate.ts — `agentlenspro review-gate`: the adversarial-review Stop/SubagentStop
// gate, as ONE verb that dispatches on `hook_event_name` (TRDD ai-review-gate-cli-verb).
//
// WHAT ARMS IT (owner order 2026-09-15, replacing every earlier arming rule):
//   - a WRITE — an Edit/Write/NotebookEdit outside the ephemeral roots, or a write-shaped Bash
//     command (git commit, sed -i, a redirect outside /tmp, …; `commandWriteReason`) — demands ONE
//     adversarial REVIEW fork (`ROLE: REVIEW`, heading ADVERSARIAL-REVIEW);
//   - a PROPOSAL — a text block with a line that starts `PROPOSAL FOR ACTION - PLEASE REVIEW`
//     (`PROPOSAL_LINE`) — demands a MEASURE agent (`ROLE: MEASURE`, heading
//     MEASURE-AND-VERIFY-REPORT) AND the REVIEW fork. A proposal without that exact line is not a
//     proposal to this gate; it triggers nothing on Stop or SubagentStop.
// WHAT NEVER ARMS IT: a janitor heartbeat turn (`[janitor-heartbeat]`), a turn the user interrupted
// (`[Request interrupted by user…]`, Esc / Ctrl-C), a janitor subagent, the review fork itself, an
// agent whose own prompt declares a role — and files on disk. The mtime walk (`unreviewedEffects`)
// was REMOVED: it armed the MAIN gate on every heartbeat for writes made by the janitor's own
// agents and by background workers, so every 5-minute cron fire spawned a review pair. That, plus
// role credit that EXPIRED when a measure agent returned (a background notification is one JSONL
// line, so its heading can never sit at a line start and the credit was lost every time), is the
// loop that drained the owner's window on 2026-09-14/15. A worker's writes are reviewed by its
// own SubagentStop gate; the main agent's by its Stop gate; nobody's by a clock.
// A ROLED SPAWN NOW CREDITS ITS ROLE PERMANENTLY at the spawn index. Both gates share one scan and
// one decision (`scanTranscriptLines` / `decideGate`), so the criteria cannot drift between them.

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { agentlensDisabled, killSwitchHalf, killSwitchPath } from './killSwitch'
import { readStdin } from './hookHandlers'
import {
  commandWriteReason, isEphemeralTarget, textArms, PROPOSAL_MARKER,
  NO_REVIEW_SENTINEL, NO_REVIEW_SENTINEL_EXAMPLES, isNoReviewSentinel,
} from './reviewGateTriggers'
import type { ArmCause } from './reviewGateTriggers'
// Re-exported so existing importers of these three names from THIS module keep working — the
// definitions themselves live in reviewGateTriggers.ts.
export { NO_REVIEW_SENTINEL, NO_REVIEW_SENTINEL_EXAMPLES, isNoReviewSentinel }

// ── The role rules pasted into the spawned agents' prompts ──────────────────────────────────────
// THE ONE-TURN RULE for the reviewer admits NO exception: measured over this project's fork corpus
// (2026-09-03, reports/review-fork-economics/), a prompt that names one permitted tool call gets
// exactly that call — and a tool_result must be answered, which is a second turn.
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
  + 'no push, no install, no redirect outside /tmp. Do not spawn agents of your own. Settle exactly the '
  + 'assumptions your prompt names and do not explore beyond them — the bound is the assumption list, '
  + 'not a call count. An assumption you could not settle is reported unmeasurable, which is a finding, '
  + 'not a failure. Report, then return.'

export type Role = 'measure' | 'review'

/** Role claimed by a PROMPT the PARENT wrote — the literal string an assistant's own `Agent`
 *  tool_use `input.prompt` carries (scanTranscriptLines' spawn-credit branch, and
 *  reviewSupervisor's equivalent scan). This is exactly what the calling agent composed, never
 *  wrapped or reframed by the harness before it lands in the parent's own transcript, so it is
 *  safe to anchor to POSITION: the marker must be the prompt's literal FIRST non-whitespace line
 *  (trailing `\s*` tolerated — a stray space or `\r` is fine, prose after the marker is not) —
 *  TRDD-BA0DCW98: matching "anywhere" let a quoted marker line buried in untrusted third-party
 *  text the parent pasted into a spawned agent's brief (a fetched doc, an issue body, a pasted
 *  transcript) falsely credit that spawn as the real REVIEW/MEASURE agent, releasing the parent's
 *  own gate with no reviewer ever having actually been asked for one. The harness's own directive
 *  strings put the marker line first (`REVIEW_GATE_DIRECTIVE`'s spawn instructions), so first-line
 *  anchoring costs no legitimate spawn its credit — candidate option 3 in the card, chosen over
 *  N-line/boilerplate-length bookkeeping (drift-prone) and a marker-shape change (breaks the live
 *  prompt contract with deployed roled agents). Both or neither => null, one agent claiming both
 *  jobs is the shape this replaces. Exact whole-line equality (kept here) is what fixture K needs
 *  (2026-09-15: a `.startsWith` variant credited REVIEW from a prose line merely BEGINNING
 *  "ROLE: REVIEW is the marker…"); first-line anchoring (added here) is what BA0DCW98 needs — the
 *  two are independent and both required.
 *
 *  NOT used for `ownRole` (the self-exemption check, below): that reads a DIFFERENT string — the
 *  first user entry of the SPAWNED agent's own transcript, which per `declaredRoleOwnTranscript`'s
 *  own doc comment may arrive with harness-added preamble ahead of the marker line, so anchoring
 *  THIS function's position rule onto that read would falsely de-exempt every real REVIEW/MEASURE
 *  fork and deadlock the gate (each fork's own SubagentStop would then demand it spawn a reviewer
 *  of itself). Keep the two predicates separate; do not unify them. */
export function declaredRole(prompt: string): Role | null {
  let firstLine: string | undefined
  for (const line of prompt.split('\n')) {
    const trimmed = line.trimEnd()
    if (trimmed !== '') { firstLine = trimmed; break }
  }
  const m = firstLine === 'ROLE: MEASURE'
  const r = firstLine === 'ROLE: REVIEW'
  return m === r ? null : (m ? 'measure' : 'review')
}

/** Role claimed by the SPAWNED agent's OWN first transcript entry — its spawning brief as Claude
 *  Code actually delivered and recorded it, which (per a prior measurement, TRDD-3U8AIHXK) may
 *  carry harness-added preamble ahead of the `ROLE: …` line, unlike the parent's raw `input.prompt`
 *  string `declaredRole` reads above. Feeds ONLY `ownRole` (self-exemption from the agent's own
 *  SubagentStop gate) — NOT anchored to the first line, so this predicate still carries the
 *  BA0DCW98 residual: untrusted text quoted early in a spawned agent's own brief that happens to
 *  contain a bare marker line self-exempts that agent. Left open deliberately (orchestrator
 *  decision, 2026-09-24, pending a measurement of the wrapped shape): anchoring it requires
 *  knowing the actual harness-wrapped shape, which is
 *  unmeasured here, and a wrong anchor point deadlocks every real role fork — worse than the
 *  residual it would close. Whole-line equality with trailing-whitespace tolerance (the fixture K
 *  fix) still applies, so a marker with trailing prose does not exempt. Follow-up: measure the
 *  real wrapped shape (a MEASURE agent's own first transcript entry) and anchor this predicate the
 *  same way once that shape is known. */
export function declaredRoleOwnTranscript(prompt: string): Role | null {
  const m = /^ROLE: MEASURE\s*$/m.test(prompt)
  const r = /^ROLE: REVIEW\s*$/m.test(prompt)
  return m === r ? null : (m ? 'measure' : 'review')
}

// ── The directive, embedded (not a shipped file): `agentlenspro review-gate --directive` ─────────
export const REVIEW_GATE_DIRECTIVE = `# Review gate directive (read on every Stop / SubagentStop fire)

WHAT ARMS IT (owner order 2026-09-15):
- a WRITE: an Edit/Write/NotebookEdit outside /tmp and the project's reports/ and *_dev/ dirs, or a
  write-shaped Bash command — git commit/push/pull/mv/rm/checkout/reset/rebase/merge/stash/clean…,
  gh create/comment/edit/merge…, sed -i / perl -i, a package add/remove, agentlenspro setup /
  --install-*, a memgrep *-mem-* verb, the string given to \`sh -c\` / \`eval\`, or a redirect / tee /
  cp / mv / rm / touch whose target is not a LITERAL path under /tmp, /dev/null or those dirs (an
  undecidable target — a $VAR, a glob, after a \`cd\` — counts as a write) → demands ONE adversarial
  REVIEW fork;
- a PROPOSAL: a text block with a line that starts "${PROPOSAL_MARKER}" (a heading or bold prefix is
  fine), followed by the proposal → demands a MEASURE agent AND the REVIEW fork. A proposal that
  lacks that exact line is not a proposal to this gate and triggers nothing.

WHAT NEVER ARMS IT: plain prose, status lines, read-only commands, files changed on disk by someone
else (there is no mtime walk), a janitor heartbeat prompt (\`[janitor-heartbeat]\`) or a user interrupt (Esc / Ctrl-C,
\`[Request interrupted by user…]\`) — each is a FLOOR: nothing before it is ever demanded, while a
write the main agent makes AFTER it still arms — a janitor subagent (\`ai-maestro-janitor:*\`), the review fork itself, or
an agent whose own prompt's literal FIRST non-blank line is exactly \`ROLE: MEASURE\` / \`ROLE: REVIEW\`
(TRDD-BA0DCW98: a marker buried later in the prompt, e.g. quoted from untrusted third-party text,
no longer self-exempts).

THE AGENTS:
- REVIEW: the Agent tool, \`subagent_type: "fork"\`. Its prompt states what you did this turn and
  every claim you assert, and carries THIS LINE VERBATIM, because it reads nothing else you were told:
  "${REVIEW_ROLE_RULE}"
  Tell it to hunt the recurring failure shape — a PROXY read in place of the thing (a pipe's exit
  status for the tool's, a preview for the file, one run for the variance, an assumed format for the
  real one) — and to name the single WEAKEST link with ONE settling command. Only a \`fork\` spawn credits the REVIEW role; a \`ROLE: REVIEW\` line in any other agent's prompt credits nothing.
- MEASURE (proposals only): any subagent type; a \`lean-worker\` (sonnet[1m], no inherited
  conversation context) is PREFERRED — measured at less than half a fork's tokens on the identical
  task with an equally usable report. Its prompt carries THIS LINE VERBATIM:
  "${MEASURE_ROLE_RULE}"
Each agent does its one job and returns; neither spawns reviewers of its own (a roled agent is
exempt from this gate, so the regress stops there).

THE EXIT IS POSITIONAL. A spawn whose prompt starts with its ROLE line credits that role AT THE
SPAWN, permanently — what the agent later returns does not un-credit it. The gate compares indexes:
it releases when the REVIEW credit sits at or after the last write / proposal, and (for a proposal)
the MEASURE credit sits at or after the last proposal line. So put the spawn tool_use(s) LAST in
the response, after the turn's last write, write-shaped command or proposal line. Plain text after
the spawn is fine; another write or proposal after it re-arms the gate.

If you CANNOT spawn — ${NO_REVIEW_SENTINEL_EXAMPLES.join(', ')} — a text block whose ENTIRE content
is "${NO_REVIEW_SENTINEL} — <reason>", as the turn's last block, releases the gate. It is the only
other exit.

Then read the report(s) and act on them — if acting edits, writes or proposes, that is new work
and needs its own review. Do NOT restate this directive to the user — spawn and continue. This
gate cannot be disabled — \`AGENTLENS_REVIEW_FORK=off\` is ignored.
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
   *  loop breaker. The SUBAGENT gate honours it (one demand per return, see `runSubagentGate`).
   *  The MAIN gate deliberately does NOT: a one-block cap is what the owner's "no give-up" order
   *  (2026-09-03) forbids. The main gate cannot loop on its own any more — a roled spawn credits
   *  permanently, so one compliant response releases it. */
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
  // Present only on `type: 'text'` blocks. `unknown`, not `string`, because this is parsed from an
  // on-disk JSONL a different process wrote: a malformed entry must reach the String() coercion at
  // the read site, not throw here.
  text?: unknown
  input?: { subagent_type?: unknown; command?: unknown; file_path?: unknown; notebook_path?: unknown; prompt?: unknown }
  id?: unknown
  tool_use_id?: unknown
  content?: unknown
}
interface TranscriptEntry {
  type?: unknown
  isSidechain?: unknown
  message?: { content?: AssistantContentBlock[] | string }
}

const EDITORS = new Set(['Edit', 'Write', 'NotebookEdit'])

export function resultText(c: unknown): string {
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c.map((x) => String((x as { text?: unknown })?.text ?? '')).join('\n')
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

// ── The shared scan and decision (Stop AND SubagentStop) ─────────────────────────────────────────

/** A janitor heartbeat turn: the cron fire's prompt is a string-content `user` entry that starts
 *  with this (measured on this project's own JSONL, 4,787 entries). */
export const HEARTBEAT_PREFIX = '[janitor-heartbeat]'
/** A user interrupt (Esc / Ctrl-C): the harness records `[Request interrupted by user]` or
 *  `[Request interrupted by user for tool use]` as a text block in a `user` entry. */
export const INTERRUPT_PREFIX = '[Request interrupted by user'

/** The text of a `user` entry that is a PROMPT — string content, or text blocks with no
 *  tool_result among them — and '' for a tool_result entry. */
export function userPromptText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  if (content.some((b) => (b as AssistantContentBlock)?.type === 'tool_result')) return ''
  return resultText(content)
}

/** A FLOOR: a `user` entry after which nothing earlier owes a review. A heartbeat turn is the
 *  janitor's; an interrupted turn is the user's call to stop. Work AFTER the floor still arms — a
 *  main-agent edit inside a `[janitor-resume]` turn is not the janitor's action. Task
 *  notifications, the gate's own `Stop hook feedback:` message and mid-turn user messages are NOT
 *  floors (C1, 2026-09-13: those land inside a running turn).
 *
 *  ARRAY CONTENT: true iff ANY `text` block, after stripping leading whitespace, starts with a
 *  floor prefix — regardless of any `tool_result` block beside it. MEASURED on this project's own
 *  JSONL (2026-09-15): 131 real interrupt entries, every one a lone leading `text` block, 0 paired
 *  with a `tool_result` in the same content array — so a text+tool_result pairing is UNOBSERVED
 *  today. But `userPromptText` returns '' for any array holding a tool_result (it exists to feed
 *  `ownRole`, which must not read a tool_result as a spawning prompt), and reusing it here would
 *  silently defeat the floor the day a harness change pairs interrupt text with a tool_result — the
 *  exact "interrupted during a tool call" Esc this floor is meant to catch. So this scans the
 *  blocks directly instead of going through `userPromptText`. */
export function isFloorPrompt(content: unknown): boolean {
  const isFloorText = (t: string) => {
    const s = t.replace(/^\s+/, '')
    return s.startsWith(HEARTBEAT_PREFIX) || s.startsWith(INTERRUPT_PREFIX)
  }
  if (typeof content === 'string') return isFloorText(content)
  if (!Array.isArray(content)) return false
  return content.some((b) => (b as AssistantContentBlock)?.type === 'text' && isFloorText(String((b as AssistantContentBlock).text ?? '')))
}

export interface GateScan {
  /** The last arming block after the last floor, or null. Index + cause travel together so the
   *  block message can never name a cause the scan did not find. */
  work: { index: number; cause: ArmCause; detail: string } | null
  /** Index of the last proposal block after the last floor, -1 when none. */
  lastProposal: number
  /** Highest index at which each role was credited — permanent, whatever the agent returns, or the
   *  no-review sentinel (both roles). REVIEW credits ONLY an Agent spawn with `subagent_type: "fork"`
   *  whose prompt carries the ROLE: REVIEW marker; MEASURE credits ANY subagent type whose prompt
   *  carries the ROLE: MEASURE marker. -1 when never. */
  roles: { measure: number; review: number }
  /** The role the transcript's OWN first prompt declares (a subagent's spawning brief), which
   *  exempts that agent from the SubagentStop gate. Meaningless for the main transcript. */
  ownRole: Role | null
}

/** ONE scan for both gates. Pure — the whole "relative position, not turn boundaries" rule lives
 *  here, so it is testable without a real transcript file. WHAT counts as work is decided in the
 *  triggers module; `cwd` is the hook's, for resolving relative write targets. */
export function scanTranscriptLines(lines: string[], cwd = process.cwd()): GateScan {
  let work: GateScan['work'] = null
  let lastProposal = -1
  const roles: GateScan['roles'] = { measure: -1, review: -1 }
  let ownRole: Role | null = null
  let sawFirstUser = false
  for (let i = 0; i < lines.length; i++) {
    let e: TranscriptEntry
    try { e = JSON.parse(lines[i]) as TranscriptEntry } catch { continue }
    // Subagent turns are marked `isSidechain: true` — a child's prose must never be scored as the
    // parent's work.
    if (e?.isSidechain === true) continue
    const content = e?.message?.content
    if (e?.type === 'user') {
      // The transcript's OWN spawning prompt is its FIRST non-sidechain `user` entry — read ONCE,
      // so a later human-authored `user` turn is never mistaken for it.
      if (!sawFirstUser) { sawFirstUser = true; ownRole = declaredRoleOwnTranscript(userPromptText(content)) }
      if (isFloorPrompt(content)) { work = null; lastProposal = -1 }
      continue
    }
    if (e?.type !== 'assistant' || !Array.isArray(content)) continue
    for (const b of content) {
      if (b?.type === 'text') {
        const text = String(b.text ?? '')
        // The sentinel is a definitive statement, not a pending spawn — credit BOTH roles.
        // `isNoReviewSentinel` rejects a block carrying anything after the reason line, so prose
        // after it cannot ride along.
        if (isNoReviewSentinel(text)) { roles.measure = Math.max(roles.measure, i); roles.review = Math.max(roles.review, i); continue }
        // A MARKED proposal is work. Plain prose is not — for one day EVERY text block was, and that
        // livelocked idle turns (TRDD-0E3W5C45). The marker is decided in the triggers module.
        if (textArms(text)) { work = { index: i, cause: 'proposal text', detail: '' }; lastProposal = i }
        continue
      }
      if (b?.type !== 'tool_use') continue
      if (b.name === 'Agent') {
        // SPAWN credit. MEASURE: any subagent type whose prompt carries the marker — a lean-worker
        // is a valid MEASURE agent. REVIEW REQUIRES A FORK and a whole-line marker: a worker brief
        // that merely mentions "ROLE: REVIEW" while DESCRIBING this gate's protocol (e.g. this very
        // file's own prose) must not release the gate with no reviewer ever spawned (adversarial
        // review of 268f3080, finding b) — the owner's spec names the review agent a fork, the
        // measure agent any type. Permanent from the spawn index on; nothing the agent returns
        // un-credits it.
        const role = declaredRole(String(b.input?.prompt ?? ''))
        const isFork = String(b.input?.subagent_type ?? '').trim().toLowerCase() === 'fork'
        if (role === 'review' && isFork) roles.review = Math.max(roles.review, i)
        if (role === 'measure') roles.measure = Math.max(roles.measure, i)
        continue
      }
      const w = toolUseWork(b, cwd)
      if (w !== null) work = { index: i, ...w }
    }
  }
  return { work, lastProposal, roles, ownRole }
}

export type Demand = 'review' | 'measure' | 'both'

/** The rule, shared by both gates: release iff the REVIEW credit sits AT OR AFTER the last arming
 *  block, and — when a proposal was made — the MEASURE credit sits at or after the last proposal
 *  line. A write alone needs only the review. `>=`, not `>`: two blocks CAN share an index on a
 *  harness that writes one transcript entry per assistant message, and a tie must go to the
 *  spawn or that turn could never end (this build writes one entry per content block, so the tie
 *  is degenerate here; kept because it is correct on both shapes). NO BREAKER STATE (owner order
 *  2026-09-03: never stopped or bypassed) — and none is needed: one compliant response releases. */
export function decideGate(s: Pick<GateScan, 'work' | 'lastProposal' | 'roles'>): Demand | null {
  if (s.work === null) return null
  const needReview = s.roles.review < s.work.index
  const needMeasure = s.lastProposal !== -1 && s.roles.measure < s.lastProposal
  if (needReview && needMeasure) return 'both'
  if (needReview) return 'review'
  if (needMeasure) return 'measure'
  return null
}

// ── The block messages ───────────────────────────────────────────────────────────────────────────

export const ARM_CAUSE_TEXT: Record<ArmCause, string> = {
  'edit': 'edited a file',
  'write-shaped command': 'ran a write-shaped command',
  'proposal text': `wrote a "${PROPOSAL_MARKER}" proposal`,
}

const REVIEW_DEMAND = 'Spawn ONE adversarial REVIEW fork (Agent tool, subagent_type "fork") and COPY THIS LINE '
  + 'VERBATIM INTO ITS PROMPT: "' + REVIEW_ROLE_RULE + '"'
const MEASURE_DEMAND = 'Spawn ONE MEASURE agent (any subagent type — a `lean-worker` (sonnet[1m], no inherited '
  + 'conversation context) is PREFERRED, at less than half a fork\'s tokens) and COPY THIS LINE VERBATIM '
  + 'INTO ITS PROMPT: "' + MEASURE_ROLE_RULE + '"'

/** What the blocked agent must spawn, and how the gate releases. One text for both gates so the
 *  two can never drift. */
export function demandText(d: Demand): string {
  const parts = d === 'review' ? [REVIEW_DEMAND] : d === 'measure' ? [MEASURE_DEMAND] : [MEASURE_DEMAND, REVIEW_DEMAND]
  return parts.join(' ') + ' A spawned agent cannot see this message, so a rule you do not paste into its '
    + 'prompt never reaches it. A spawn whose prompt starts with its ROLE line credits that role at the '
    + 'spawn, permanently. A spawn counts ONLY if its prompt has the ROLE marker as a line by itself and, for '
    + 'REVIEW, only if the spawn is a fork — extra words on the marker line, a non-fork REVIEW spawn, or a '
    + 'prompt carrying both markers credit nothing. THE EXIT IS POSITIONAL: put the spawn tool_use(s) LAST in the response, after the '
    + 'turn\'s last edit, write-shaped command or "' + PROPOSAL_MARKER + '" line — one of those after the spawn '
    + 're-arms this gate; plain text after it does not. Run `agentlenspro review-gate --directive` for the full '
    + 'directive, then act on the findings. If you CANNOT spawn — ' + NO_REVIEW_SENTINEL_EXAMPLES.join(', ')
    + ' — emit a text block whose ENTIRE content is "' + NO_REVIEW_SENTINEL + ' — <reason>", nothing after the '
    + 'reason; that is the only other way out.'
}

/** The block message names WHAT armed the gate and WHICH agents it wants. It names the scanned
 *  window, never "this turn": the scan reads the transcript's last 4 MB (`readTranscriptTail`), so
 *  a long turn's earlier blocks can be outside it. */
export function mainBlockReason(cause: ArmCause, detail: string, demand: Demand): string {
  const what = detail === '' ? ARM_CAUSE_TEXT[cause] : `${ARM_CAUSE_TEXT[cause]}: ${detail}`
  return `Review gate: ${what} after the last review (scanned: the transcript's last 4 MB). ${demandText(demand)}`
}

export function subagentBlockReason(cause: ArmCause, detail: string, demand: Demand): string {
  const what = detail === '' ? ARM_CAUSE_TEXT[cause] : `${ARM_CAUSE_TEXT[cause]}: ${detail}`
  return `Subagent review gate: before returning — you ${what} after the last review. ${demandText(demand)} `
    + 'The sentinel must START the block and nothing may follow the reason (a quoted copy will not count).'
}

// ── MAIN AGENT GATE (Stop) ───────────────────────────────────────────────────────────────────────

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
  const scan = scanTranscriptLines(lines, hookCwd(input))
  const demand = decideGate(scan)
  // A demand implies an arming block was found (`work !== null`); the second test only narrows
  // the type, so the message can never name a cause the scan did not find.
  if (demand === null || scan.work === null) return null
  // CAPABILITY CHECK, not a give-up: an agent that has no Agent tool cannot satisfy the demand, and
  // blocking it forever wedges the session with no exit.
  if (agentCannotSpawn(String(input?.agent_type ?? ''))) {
    process.stderr.write('[review-gate] the Agent tool is unavailable here, so the review cannot be demanded — allowing the stop UNREVIEWED.\n')
    return null
  }
  return JSON.stringify({ decision: 'block', suppressOutput: true, reason: mainBlockReason(scan.work.cause, scan.work.detail, demand) })
}

// ── SUBAGENT GATE (SubagentStop) ─────────────────────────────────────────────────────────────────

/** Agent types that ARE the adversarial reviewer and must never be reviewed themselves. Compared
 *  whole and case-folded — never as a substring, or every `*-fork-*` agent inherits the exemption.
 *  Adding a name here skips that agent's review, so add only a genuine reviewer. */
export const REVIEWER_AGENT_TYPES = new Set(['fork'])

/** The janitor's own agents (`ai-maestro-janitor:janitor-*`, or the bare `janitor-*` form some
 *  sessions list) — excluded by owner order 2026-09-15: their memory/state writes are the janitor's
 *  actions, not work to be reviewed. Anchored at the start, on the case-folded type. */
export const JANITOR_AGENT_RE = /^(?:ai-maestro-janitor:)?janitor-/

/** Never demanded: the reviewer itself (recursion guard), a janitor agent, an agent that will not
 *  name itself (the internal micro-lookup class), or a ROLED agent — its own prompt declares
 *  MEASURE or REVIEW, so forcing it to spawn its own pair would regress two agents per level,
 *  forever. Its writes are the dispatching agent's to review one level up. */
export function subagentExempt(agentType: string, ownRole: Role | null): boolean {
  const t = agentType.trim().toLowerCase()
  return t === '' || REVIEWER_AGENT_TYPES.has(t) || JANITOR_AGENT_RE.test(t) || ownRole !== null
}

async function runSubagentGate(input: ReviewGateInput): Promise<string | null> {
  // ONE demand per return: the harness sets this once a Stop hook already blocked this same stop.
  if (input?.stop_hook_active === true) return null
  const type = String(input?.agent_type ?? '')
  if (subagentExempt(type, null)) return null
  if (agentCannotSpawn(type)) return null
  // `agent_transcript_path` is the subagent's OWN file — `transcript_path` names the PARENT's and
  // would measure the wrong agent entirely.
  const own = input?.agent_transcript_path
  if (typeof own !== 'string' || !fs.existsSync(own)) {
    process.stderr.write('[review-gate] allowing UNREVIEWED: agent_transcript_path is missing or does not exist for ' + JSON.stringify(type) + '\n')
    return null
  }
  let scan: GateScan
  try { scan = scanTranscriptLines(fs.readFileSync(own, 'utf8').split('\n'), hookCwd(input)) } catch {
    process.stderr.write('[review-gate] allowing UNREVIEWED: agent_transcript_path is unreadable for ' + JSON.stringify(type) + '\n')
    return null
  }
  if (subagentExempt(type, scan.ownRole)) return null
  const demand = decideGate(scan)
  if (demand === null || scan.work === null) return null
  return JSON.stringify({ decision: 'block', suppressOutput: true, reason: subagentBlockReason(scan.work.cause, scan.work.detail, demand) })
}

// ── Process entry for `agentlenspro review-gate` ─────────────────────────────────────────────────

/** `agentlenspro review-gate [--directive]`. Always resolves 0 — a Stop/SubagentStop hook that
 *  can throw or hang can wedge the session, which is worse than a missed review. Dispatches on
 *  `hook_event_name`: `SubagentStop` -> the subagent gate, `Stop` (or an absent field) -> the main
 *  gate. Any other event is a silent allow. */
export async function runReviewGate(argv: string[]): Promise<number> {
  if (argv[0] === '--directive') {
    process.stdout.write(REVIEW_GATE_DIRECTIVE)
    return 0
  }
  // GLOBAL kill-switch, before stdin — mirrors runHookCommand('gate'): a disabled AgentlensPro
  // must never block the user's work. Named on stderr, matching the other silent-allow lines in
  // this file — a silent bypass is exactly the failure class this gate exists to close.
  if (agentlensDisabled()) {
    const half = killSwitchHalf() === 'env'
      ? 'env AGENTLENS_DISABLED=1'
      : `the kill-switch flag file (${killSwitchPath()})`
    process.stderr.write(`[review-gate] allowing UNREVIEWED: ${half} is set.\n`)
    return 0
  }
  const payload = await readStdin(process.stdin)
  // THE ENV KILL-SWITCH IS GONE (owner order, 2026-09-03: "it must NEVER BE STOPPED OR BYPASSED, no
  // matter what"). `AGENTLENS_REVIEW_FORK=off` is ignored: an env var is settable by anything in the
  // process tree, so it was a bypass available to the very agent the gate exists to constrain.
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
