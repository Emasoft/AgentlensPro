// src/cli/reviewGate.ts — `agentlenspro review-gate`: the adversarial-review Stop/SubagentStop
// gate, as ONE verb that dispatches on `hook_event_name` (TRDD ai-review-gate-cli-verb).
//
// WHAT ARMS IT (owner order 2026-09-15, replacing every earlier arming rule):
//   - a WRITE — an Edit/Write/NotebookEdit outside the ephemeral roots, or a write-shaped Bash
//     command (git commit, sed -i, a redirect outside /tmp, …; `commandWriteReason`) — demands ONE
//     adversarial REVIEW fork (`ROLE: REVIEW`, heading REVIEW_HEADING);
//   - a PROPOSAL — a text block with a line that starts `PROPOSAL FOR ACTION - PLEASE REVIEW`
//     (`PROPOSAL_LINE`) — demands a MEASURE agent (`ROLE: MEASURE`, heading
//     MEASURE_HEADING) AND the REVIEW fork. A proposal without that exact line is not a
//     proposal to this gate; it triggers nothing on Stop or SubagentStop.
// WHAT NEVER ARMS IT: a janitor heartbeat turn (`[janitor-heartbeat]`), a turn the user interrupted
// (`[Request interrupted by user…]`, Esc / Ctrl-C), a janitor subagent, the review fork itself, an
// agent whose own prompt declares a role — and files on disk. The mtime walk (`unreviewedEffects`)
// was REMOVED: it armed the MAIN gate on every heartbeat for writes made by the janitor's own
// agents and by background workers, so every 5-minute cron fire spawned a review pair. That, plus
// role credit that EXPIRED when a measure agent returned (a background notification is one JSONL
// line, so its heading can never sit at a line start and the credit was lost every time), is the
// loop that drained the owner's window on 2026-09-14/15. A worker that can spawn is reviewed by its
// own SubagentStop gate; a worker without the Agent tool is reviewed by the main gate at its return
// (TRDD-9YWTNFU8); the main agent's writes by its Stop gate; nobody's by a clock.
// A ROLED SPAWN NOW CREDITS ITS ROLE PERMANENTLY at the spawn index. Both gates share one scan and
// one decision (`scanTranscriptLines` / `decideGate`), so the criteria cannot drift between them.

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { readStdin } from './hookHandlers'
import { DELEGATE_DENY_REASON } from './delegateGate'
import {
  commandWriteReason, isNeverGatedTarget, textArms, PROPOSAL_MARKER, commandWriteReasons, recordWrite,
  NO_REVIEW_SENTINEL, NO_REVIEW_SENTINEL_EXAMPLES, isNoReviewSentinel, shellWords, stripHeredocBodies,
} from './reviewGateTriggers'
import type { ArmCause } from './reviewGateTriggers'
import { markerOpening, MEASURE_HEADING, REVIEW_HEADING } from './reviewLoop'
// Re-exported so existing importers of these three names from THIS module keep working — the
// definitions themselves live in reviewGateTriggers.ts.
export { NO_REVIEW_SENTINEL, NO_REVIEW_SENTINEL_EXAMPLES, isNoReviewSentinel }

// ── The role rules pasted into the spawned agents' prompts ──────────────────────────────────────
// THE ONE-TURN RULE for the reviewer admits NO exception: measured over this project's fork corpus
// (2026-09-03, reports/review-fork-economics/), a prompt that names one permitted tool call gets
// exactly that call — and a tool_result must be answered, which is a second turn.
// TRDD-BA0DCW98: "the FIRST line" (not just "a line") is load-bearing — `declaredRole` credits a
// spawn only when the marker is the prompt's literal first non-blank line, so a rule that only says
// "a line" describes a laxer contract than the code enforces and a compliant-looking prompt with one
// line of prose before the marker would silently fail to credit.
export const REVIEW_ROLE_RULE = 'Begin your prompt with its FIRST line being exactly "ROLE: REVIEW" '
  + '(nothing before it), and '
  + 'begin your final message with the heading ' + REVIEW_HEADING + '. Answer in ONE turn. Make ZERO '
  + 'tool calls — no SendMessage, no Read, no Bash, none. Put every finding INLINE in your final '
  + 'message and stop.'
  + ' You cannot see the response that spawned you: tool calls and results from it are invisible to you. Their absence from your transcript is not evidence they did not happen; review only what your prompt states, and never mark a claim about the spawning response VERIFIED.'

export const MEASURE_ROLE_RULE = 'Begin your prompt with its FIRST line being exactly "ROLE: MEASURE" '
  + '(nothing before it), and '
  + 'begin your final message with the heading ' + MEASURE_HEADING + '. Settle EVERY load-bearing '
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
 *  Since TRDD-8YM21R5X this ALSO feeds `ownRole` through `declaredRoleOwnTranscript` (the spawned
 *  agent's self-exemption), so editing it changes self-exemption too. These are not the only role
 *  readers: the worker-write scan (`workerDeclaredRole`) reads `Your directive: ` lines separately. */
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

/** Role claimed by the SPAWNED agent's OWN first transcript entry (feeds ONLY `ownRole`, the
 *  self-exemption from the agent's own SubagentStop gate). Anchored exactly like `declaredRole`: the
 *  marker must be the FIRST NON-BLANK line, whole-line equality, trailing whitespace tolerated.
 *  WHY (TRDD-8YM21R5X, shapes measured 2026-11-01, Claude Code 2.1.316): a freshly spawned non-fork
 *  worker's first user entry is a plain string holding the brief verbatim, no harness preamble, so the
 *  brief's first line IS the entry's first line. A fork's first entry is [tool_result, text]; userPromptText
 *  returns '' for it, so this predicate never sees a fork (forks are exempted by the separate review-fork
 *  rule). An agent resumed into a new session file starts with a tool_result or a "[SYSTEM NOTIFICATION…"
 *  string, so it declares no role. Unanchored matching let a bare marker line buried in untrusted quoted
 *  text self-exempt the agent (TRDD-BA0DCW98); anchoring closes that. No non-fork role agent was
 *  measured, and under the gate's current rules role agents are forks. If a future Claude Code or a
 *  SubagentStart hook puts a line ahead of a non-fork brief, non-fork role agents lose self-exemption
 *  (the gate gets stricter, never looser). */
export function declaredRoleOwnTranscript(prompt: string): Role | null {
  return declaredRole(prompt)
}

/** A declared role for the worker-write scan. `investigate` relaxes that scan only; it never credits a gate role
 *  (`declaredRole` and `Role` stay MEASURE/REVIEW), so an INVESTIGATE fork cannot satisfy a MEASURE demand. */
export type WorkerRole = Role | 'investigate'

/** The TEXT blocks of a transcript entry, joined; a tool_result block is skipped, never read. Unlike
 *  `userPromptText`, an entry that ALSO carries a tool_result still yields its text, because a fork's first
 *  user entry is exactly that shape (measured, TRDD-QQ2XIIZ6). */
function firstEntryText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => (b as AssistantContentBlock)?.type === 'text')
    .map((b) => String((b as { text?: unknown }).text ?? ''))
    .join('\n')
}

/** The ROLE a background worker declared in its OWN first transcript entry, for workerWriteDetail only.
 *  WHY (TRDD-QQ2XIIZ6, measured 2026-10-14): a fork's first user entry is `[tool_result, text]`, the text being
 *  `<fork-boilerplate>…</fork-boilerplate>` then a line `Your directive: ROLE: X`. The old read
 *  (`userPromptText`, which returns '' for any entry holding a tool_result, then declaredRoleOwnTranscript)
 *  therefore never matched a fork, so the role exemption never ran and every role fork's report or scratch
 *  write armed the gate. The line read is the first one starting `Your directive: ` (fork shape), else the
 *  first non-blank line (a plain prompt); the marker must START that line, so a ROLE line anywhere else — quoted
 *  later in a directive, on line 5 of a fresh worker's prompt, or after other text — never counts. Text AFTER
 *  the role word is allowed: the investigation forks' real line is `ROLE: INVESTIGATE (read-only; …)`, which a
 *  whole-line match missed (review of df8bfc70). The word must still END there: `(?![\w-])` refuses a longer word
 *  (`ROLE: MEASUREMENT`) and a hyphenated one (`ROLE: REVIEW-ish`, review of 668fc421), which `\b` let through.
 *  This is deliberately looser than declaredRole's credit test (first line exactly `ROLE: MEASURE`/`ROLE: REVIEW`,
 *  fixture K): a role here only relaxes the scan of unresolvable scratch targets (isRoleScratchTarget), it never
 *  credits a gate role. */
export function workerDeclaredRole(content: unknown): WorkerRole | null {
  const lines = firstEntryText(content).split('\n')
  const line = lines.find((l) => l.startsWith('Your directive: ')) ?? lines.find((l) => l.trim() !== '') ?? ''
  const m = /^(?:Your directive: )?ROLE: (MEASURE|REVIEW|INVESTIGATE)(?![\w-])/.exec(line)
  return m === null ? null : (m[1].toLowerCase() as WorkerRole)
}


/** The credit test BOTH roles share (owner spec 2026-10-14). A spawn credits its ROLE only when it is a
 *  `fork` (case-folded) with NO `isolation` parameter. WHY a fork: it inherits the parent's conversation
 *  and reuses its prompt cache, so the reviewer reads that context at the cached rate. WHY no isolation:
 *  an isolated spawn runs in a fresh git worktree, which fails outside a git repository, so it is not a
 *  reviewer the gate can rely on and it earns nothing. Any non-empty `isolation` value counts. Shared with
 *  reviewSupervisor so the gate and the supervisor cannot disagree. */
export function isCreditedFork(agentInput: { subagent_type?: unknown; isolation?: unknown }): boolean {
  const isFork = String(agentInput.subagent_type ?? '').trim().toLowerCase() === 'fork'
  return isFork && String(agentInput.isolation ?? '') === ''
}

// ── The directive, embedded (not a shipped file): `agentlenspro review-gate --directive` ─────────
export const REVIEW_GATE_DIRECTIVE = `# Review gate directive (read on every Stop / SubagentStop fire)

SCOPE (owner ruling 2026-10-14): only the turn that just ended decides. A turn starts at a non-sidechain user
entry with an object turnPosition: a human prompt, a heartbeat, a task notification, a peer message or a compact
summary. A message typed mid-turn does not start one. Work, proposals and reviews from an earlier turn do not count.

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
- a WORKER RETURN: a non-roled, non-janitor agent you spawned returns having written files → demands ONE REVIEW fork; run \`git status --short\` and \`git diff\` on its files in an earlier response first;
- NOT a write, though it looks like one: after a fork REVIEW, ONE \`trddgrep append\` to a card that review's prompt names, and ONE path-limited card commit (\`git add <card> && git commit -F msg -- <card>\`, paths under design/tasks, design/proposals, design/archived or .claude/project/memory) do not arm — recording a review is not new work. Everything else does: trddgrep edit/set/move/new, memgrep writes, a commit without \`-- <paths>\`, a second append.

WHAT NEVER ARMS IT: plain prose, status lines, read-only commands, files changed on disk by someone
else (there is no mtime walk), a janitor heartbeat prompt (\`[janitor-heartbeat]\`) or a user interrupt (Esc / Ctrl-C,
\`[Request interrupted by user…]\`) — each is a FLOOR: nothing before it is ever demanded, while a
write the main agent makes AFTER it still arms — a janitor subagent (\`ai-maestro-janitor:*\`), any fork
(\`subagent_type: "fork"\`: REVIEW and MEASURE forks alike, exempt by agent type), or a non-fork agent whose OWN
first transcript entry has \`ROLE: MEASURE\` / \`ROLE: REVIEW\` as its first non-blank line, that line whole by itself
(self-exemption; TRDD-8YM21R5X).
Self-exemption and crediting use the same first-line anchoring and differ in whose text is read and what it unlocks:
self-exemption reads the first entry of the spawned agent itself and exempts that agent; crediting reads the prompt
you wrote and credits your spawn to the gate scanning YOU (below). A marker buried later in the prompt you wrote,
e.g. quoted from untrusted third-party text, credits nothing (TRDD-BA0DCW98).

THE AGENTS:
- REVIEW: the Agent tool, \`subagent_type: "fork"\`, with NO \`isolation\` parameter. Its prompt states what you did this turn and
  every claim you assert, and carries THIS LINE VERBATIM, because it reads nothing else you were told:
  "${REVIEW_ROLE_RULE}"
  Tell it to hunt the recurring failure shape — a PROXY read in place of the thing (a pipe's exit
  status for the tool's, a preview for the file, one run for the variance, an assumed format for the
  real one) — and to name the single WEAKEST link with ONE settling command.
- MEASURE (proposals only): a fork too (Agent tool, \`subagent_type: "fork"\`, NO \`isolation\` parameter). It may run read-only commands and read files with \`tldr\`. Its prompt is a numbered step list (one assumption per step, each with the exact command to run and what to report), and carries THIS LINE VERBATIM:
  "${MEASURE_ROLE_RULE}"
Only a \`fork\` spawn with NO \`isolation\` parameter credits a role; a ROLE line in any other spawn credits nothing.
Each agent does its one job and returns; neither spawns reviewers of its own (a roled agent is
exempt from this gate, so the regress stops there).

THE EXIT IS POSITIONAL. A spawn whose prompt's FIRST line is its ROLE marker credits that role AT THE
SPAWN, permanently — what the agent later returns does not un-credit it. The gate compares indexes:
it releases when the REVIEW credit sits at or after the last write / proposal, and (for a proposal)
the MEASURE credit sits at or after the last proposal line. So put the spawn tool_use(s) LAST in
the response, after the turn's last write, write-shaped command or proposal line. Plain text after
the spawn is fine; another write or proposal after it re-arms the gate.

If you CANNOT spawn — ${NO_REVIEW_SENTINEL_EXAMPLES.join(', ')} — a text block whose ENTIRE content
is "${NO_REVIEW_SENTINEL} — <reason>", as the turn's last block, releases the gate. It is the only
other exit.
The sentinel must be the ENTIRE text block (no trailing prose after the reason line), and the reason must be at least 8 characters — a token like "foo" does not release the gate.

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
  /** SubagentStop only: the text of the agent's final message (Claude Code hook input). The review display
   *  shows a finished review to the USER from it; it is never sent to the model. */
  last_assistant_message?: unknown
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
  input?: { subagent_type?: unknown; isolation?: unknown; command?: unknown; file_path?: unknown; notebook_path?: unknown; prompt?: unknown }
  id?: unknown
  tool_use_id?: unknown
  content?: unknown
  is_error?: unknown
}
interface TranscriptEntry {
  type?: unknown
  isSidechain?: unknown
  agentId?: unknown
  message?: { content?: AssistantContentBlock[] | string }
}

const EDITORS = new Set(['Edit', 'Write', 'NotebookEdit'])

export function resultText(c: unknown): string {
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c.map((x) => String((x as { text?: unknown })?.text ?? '')).join('\n')
}


/** tool_use ids whose paired tool_result is the delegate gate's own PreToolUse deny (TRDD-PNB9FNJ0).
 *  A denied Edit leaves its tool_use in the transcript though nothing was written, so arming on it
 *  demanded a review fork per denied edit. Requires `is_error === true` AND the deny reason's own
 *  lead sentence: a successful Edit result echoes file content, which can quote that sentence (this
 *  very repo does), and matching it alone would let a real write un-arm itself. The marker is read
 *  from `DELEGATE_DENY_REASON` inside the function — delegateGate imports this module, so a
 *  module-level read would see it undefined when this file loads first. The tool_result wrapper the
 *  harness puts around a hook deny is unmeasured; a substring match tolerates any wrapper. */
export function deniedToolUseIds(lines: string[]): Set<string> {
  const marker = DELEGATE_DENY_REASON.split(' (')[0]
  const ids = new Set<string>()
  for (const line of lines) {
    if (!line.includes(marker)) continue
    let e: TranscriptEntry
    try { e = JSON.parse(line) as TranscriptEntry } catch { continue }
    const content = e?.message?.content
    if (e?.type !== 'user' || !Array.isArray(content)) continue
    for (const b of content) {
      if (b?.type === 'tool_result' && b.is_error === true && typeof b.tool_use_id === 'string' && resultText(b.content).includes(marker)) ids.add(b.tool_use_id)
    }
  }
  return ids
}


/** A tool_use the delegate gate denied. EDITOR tools only: the gate denies Edit/Write/NotebookEdit,
 *  while a Bash command that really ran can exit non-zero and print the deny sentence (a grep over
 *  this repo does) — skipping it as "never ran" would hide a real write from both gates. */
export function isDeniedEdit(b: AssistantContentBlock, denied: Set<string>): boolean {
  return typeof b.id === 'string' && denied.has(b.id) && typeof b.name === 'string' && EDITORS.has(b.name)
}

/** The one arming block of a turn, and WHY. `null` from the editor branch means the edit landed
 *  under an ephemeral root (the scratchpad, reports/) and is not work. */
export function toolUseWork(b: AssistantContentBlock, cwd: string): { cause: ArmCause; detail: string } | null {
  if (typeof b.name === 'string' && EDITORS.has(b.name)) {
    const file = String(b.input?.file_path ?? b.input?.notebook_path ?? '')
    // WHY: plan files under ~/.claude/plans/ are documents, not code, so a Write there must not arm the gate.
    return isNeverGatedTarget(file, cwd) ? null : { cause: 'edit', detail: `${b.name} ${path.basename(file)}` }
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

/** Writes that are not a reviewable diff: a build, a deploy, or a card or memory record. */
// `agentlenspro server` only: `agentlenspro config write` rewrites ~/.claude/settings.json, which IS reviewable.
// A worker's own trddgrep/memgrep record writes are ignored ON PURPOSE: demanding a fork at every card- or memory-writing worker's return would bring the review-of-a-record chain back through workers.
// A worker's card text is covered when the main agent commits the card, because a card commit not preceded by a review arms.
const DEPLOY_OR_RECORD_RE = /^(node esbuild\.js|(pnpm|npm) run |agentlenspro server |trddgrep |prrdgrep |specgrep |memgrep )/


const NESTED_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])

/** Whether a Bash command runs a nested shell (`bash -c`, `/bin/bash -lc`) or an `eval`: its argument is
 *  a command the classifier never reads whole, so one reason may hide a write behind it. Judged on shell
 *  words, so a quoted mention of `bash -c` inside a card line does not count. */
function runsNestedShell(command: string): boolean {
  const words = shellWords(stripHeredocBodies(command, true))
  return words.some((w, i) => {
    if (w.quoted) return false
    if (w.word === 'eval') return true
    if (!NESTED_SHELLS.has(path.basename(w.word))) return false
    for (let j = i + 1; j < words.length; j++) {
      const n = words[j]
      if (!n.quoted && /^(\||\|\||&&|;|&)$/.test(n.word)) break
      if (!n.quoted && /^-[A-Za-z]*c$/.test(n.word)) return true
    }
    return false
  })
}

/** What ONE background worker wrote, as the detail of a `worker write` block, or null. The worker's
 *  transcript sits beside the main one at `<base>/subagents/agent-<x>.jsonl`, and its `.meta.json`
 *  holds the tool_use id the return names. Skipped: a janitor agent (its writes are the janitor's, as
 *  everywhere in this file). A ROLED agent (workerDeclaredRole) is scanned like any worker, except that an
 *  unresolvable write target inside an ephemeral directory is its scratch, not work (TRDD-QQ2XIIZ6). Never
 *  throws: a read or parse error is named on stderr and allowed, because a throw here would wedge the
 *  main session's Stop. */
export function workerWriteDetail(transcriptPath: string, toolUseId: string, cwd: string): string | null {
  try {
    const dir = path.join(path.dirname(transcriptPath), path.basename(transcriptPath, '.jsonl'), 'subagents')
    let meta: { file: string; agentType: string } | null = null
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.meta.json')) continue
      const m = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as { toolUseId?: unknown; agentType?: unknown }
      if (m.toolUseId === toolUseId) { meta = { file, agentType: String(m.agentType ?? '') }; break }
    }
    if (meta === null) return null
    if (JANITOR_AGENT_RE.test(meta.agentType.trim().toLowerCase())) return null
    const rawLines = fs.readFileSync(path.join(dir, meta.file.replace(/\.meta\.json$/, '.jsonl')), 'utf8').split('\n').filter(Boolean)
    // A torn last line (the worker is still appending) is skipped: a throw here released the worker's code.
    const entries: TranscriptEntry[] = []
    for (const l of rawLines) { try { entries.push(JSON.parse(l) as TranscriptEntry) } catch { /* torn line */ } }
    const firstUser = entries.find((e) => e?.type === 'user')
    // A declared role no longer skips the worker (TRDD-QQ2XIIZ6, amendment A): it relaxes ONLY an unresolvable
    // target inside an ephemeral directory (a `$(date +%s)` stamp, a loop variable), so a role fork's resolvable
    // write outside those directories still arms. workerDeclaredRole, not userPromptText: see its WHY.
    const roleScratch = firstUser !== undefined && workerDeclaredRole(firstUser.message?.content) !== null
    const denied = deniedToolUseIds(rawLines)
    const details: string[] = []
    for (const e of entries) {
      const content = e?.message?.content
      if (e?.type !== 'assistant' || !Array.isArray(content)) continue
      for (const b of content) {
        if (b?.type !== 'tool_use' || isDeniedEdit(b, denied)) continue
        if (b.name !== 'Bash') {
          const w = toolUseWork(b, cwd)
          if (w !== null) details.push(w.detail)
          continue
        }
        // Each reason of a Bash command is judged on its own, so a card record chained before a real write
        // does not hide that write. A nested shell string or eval reports ONE reason for all its text
        // (see the commandWriteReasons shortcut), and that reason may be the record while the write sits
        // behind it, so nothing is dropped there.
        // Token-based (runsNestedShell): a quoted mention of bash -c in a card line is not a nested shell,
        // while a path-qualified shell or a clustered -lc-style option still counts.
        const command = String(b.input?.command ?? '')
        const nested = runsNestedShell(command)
        for (const reason of commandWriteReasons(command, cwd, { roleScratch })) {
          if (nested || !DEPLOY_OR_RECORD_RE.test(reason)) details.push(reason)
        }
      }
    }
    const distinct = Array.from(new Set(details))
    if (distinct.length === 0) return null
    const more = distinct.length > 3 ? ` (+${distinct.length - 3} more)` : ''
    return `${meta.agentType}: ${distinct.slice(0, 3).join(', ')}${more}`
  } catch (err) {
    process.stderr.write(`[review-gate] worker transcript unreadable for ${toolUseId}: ${String(err)}\n`)
    return null
  }
}

/** Read only the tail of a (possibly huge) transcript; the answer is always near the end. Used by delegateGate only:
 *  the review gate reads its current turn with readCurrentTurn, not this window. */
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


/** Bytes per backward step in `readCurrentTurn`. A step size, not a cap: the walk continues until the
 *  turn's start is found, however far back that is. */
const TURN_READ_CHUNK_BYTES = 1024 * 1024

/** Whether a transcript entry starts a turn. Measured 2026-10-14 on real transcripts: a turn starts at a
 *  non-sidechain `user` entry with an object `turnPosition`. That covers human prompts, heartbeat cron
 *  prompts (`turnOrigin: "scheduled"`, and `isMeta: true`, so isMeta must NOT exclude a turn start),
 *  task-notification turns, peer messages and compact summaries. It is absent on Stop-hook feedback (isMeta,
 *  no turnPosition), tool results, /clear and /exit. A message the user types MID-turn does not start one:
 *  it is recorded as a queue-operation and an attachment (queued_command), then a user entry with no
 *  turnPosition. Of 293 measured turn starts, none followed an assistant tool_use mid-turn.
 *  KNOWN LIMIT: an auto-compact written mid-turn would carry a turnPosition and start a new turn here, so
 *  the turn after it would be judged alone. Not measured yet; upgrade this predicate when its shape is known.
 *  An attachment containing `[janitor-heartbeat]` is NOT a turn start: four of six such attachments sit
 *  mid-turn with assistant entries after them, so counting them would split a turn and release its earlier
 *  writes unreviewed. */
export function isTurnStart(e: { type?: unknown; isSidechain?: unknown; turnPosition?: unknown }): boolean {
  return e?.type === 'user' && typeof e.turnPosition === 'object' && e.turnPosition !== null && e.isSidechain !== true
}


/** One transcript line's head fields, or null when the line is not JSON. Its own function, because a
 *  `let` assigned inside a try block narrows to `null` for TypeScript and every later read reads `never`. */
function parseLineHead(text: string): { type?: unknown; isSidechain?: unknown; turnPosition?: unknown } | null {
  try { return JSON.parse(text) as { type?: unknown; isSidechain?: unknown; turnPosition?: unknown } } catch { return null }
}


/** Options for `readCurrentTurn`. */
export interface CurrentTurnOptions {
  /** Bytes per backward step. A step size, not a cap: the walk continues until the turn start is found. */
  chunkBytes?: number
  /** For a UserPromptSubmit hook, which can run after the new prompt is already written: when the newest
   *  turn has no assistant entry yet, return the turn before it (the last COMPLETED turn). */
  skipUnstartedTurn?: boolean
  /** Write one stderr line when the file has no turn start, so a dropped `turnPosition` is visible. The
   *  whole file is still returned. Main transcripts only: a subagent's own file has no turn start by design. */
  warnNoTurnStart?: boolean
}

/** One backward walk over the bytes before `endOffset`: the turn that ends there. `startOffset` is where its
 *  first line begins; `sawTurnStart` is false when no turn start was met, so the whole prefix was taken. */
function walkTurnBefore(fd: number, endOffset: number, chunkBytes: number): { lines: string[]; startOffset: number; sawTurnStart: boolean } {
  const newestFirst: string[] = []
  let startOffset = endOffset
  let sawTurnStart = false
  // 'seeking': no turn start met yet, so every line is taken. 'extending': the turn start is found, so
  // only non-conversation lines are taken, and the first conversation entry ends the run.
  let extending = false
  let done = false
  // Hands one complete line to the walk, newest first, with its byte offset; true once the walk has its answer.
  const take = (raw: Buffer, offset: number): boolean => {
    const text = raw.toString('utf8')
    if (text.trim() === '') return false
    const e = parseLineHead(text)
    if (!extending) {
      newestFirst.push(text)
      startOffset = offset
      if (e !== null && isTurnStart(e)) { extending = true; sawTurnStart = true }
      return false
    }
    if (e !== null && (isTurnStart(e) || e.type === 'user' || e.type === 'assistant')) return true
    newestFirst.push(text)
    startOffset = offset
    return false
  }
  let pos = endOffset
  // The head of the line that begins before the bytes read so far.
  let carry = Buffer.alloc(0)
  while (pos > 0 && !done) {
    const start = Math.max(0, pos - chunkBytes)
    const chunk = Buffer.alloc(pos - start)
    if (fs.readSync(fd, chunk, 0, chunk.length, start) !== chunk.length) throw new Error('short read of the transcript')
    pos = start
    // Split at the BYTE level: a multi-byte UTF-8 character can straddle a chunk boundary, so a line is
    // decoded only once it is complete.
    const data = Buffer.concat([chunk, carry])
    let end = data.length
    let nl = data.lastIndexOf(0x0a)
    while (nl !== -1) {
      if (take(data.subarray(nl + 1, end), start + nl + 1)) { done = true; break }
      end = nl
      nl = end > 0 ? data.lastIndexOf(0x0a, end - 1) : -1
    }
    carry = data.subarray(0, end)
  }
  // At file start the carry is the first line, complete because nothing precedes it.
  if (!done) take(carry, 0)
  return { lines: newestFirst.reverse(), startOffset, sawTurnStart }
}

/** The lines of the CURRENT turn, from its turn-start entry (`isTurnStart`) to the end of the file. Read
 *  BACKWARD in chunks and stopped at that start, so no fixed window can cut a long turn short. Owner
 *  ruling 2026-10-14: only the work, proposals and reviews of the turn that just ended decide whether a
 *  review is demanded; a tail window let an earlier turn's edit carry over into a later turn. The run of
 *  non-conversation entries (queue-operation, system, attachment) directly before the turn start belongs
 *  to the turn: a background worker's return is a queue-operation enqueue that sits just before the
 *  task-notification turn it starts, and that return is this turn's work. A file with no turn start (a
 *  subagent's own transcript, every entry a sidechain) is read whole, because the whole file is its one
 *  turn; `warnNoTurnStart` says so on stderr for a main transcript. Returns null when the file cannot be
 *  read; callers then allow the stop UNREVIEWED and say so. */
export function readCurrentTurn(transcriptPath: string, opts: CurrentTurnOptions = {}): string[] | null {
  const chunkBytes = opts.chunkBytes ?? TURN_READ_CHUNK_BYTES
  let fd: number
  try { fd = fs.openSync(transcriptPath, 'r') } catch { return null }
  try {
    const size = fs.fstatSync(fd).size
    const turn = walkTurnBefore(fd, size, chunkBytes)
    if (opts.skipUnstartedTurn === true && turn.sawTurnStart && !turn.lines.some((l) => parseLineHead(l)?.type === 'assistant')) {
      // The newest turn has not answered yet, so the last COMPLETED turn is the one before it. A file with
      // nothing before that turn has no completed turn to judge.
      const before = turn.startOffset > 0 ? walkTurnBefore(fd, turn.startOffset, chunkBytes) : null
      return before !== null && before.sawTurnStart ? before.lines : []
    }
    if (opts.warnNoTurnStart === true && !turn.sawTurnStart && size > 0) {
      process.stderr.write(`[review-gate] no turn start found in ${transcriptPath}; judging the whole transcript\n`)
    }
    return turn.lines
  } catch {
    return null
  } finally {
    fs.closeSync(fd)
  }
}

/** A background worker's RETURN, as the main transcript records it: a `queue-operation` enqueue
 *  whose content is a `<task-notification>` with the spawning Agent's tool_use id and a `<status>`.
 *  Returns that id, or null. The same text is also copied into `user` and `attachment` entries, and
 *  those copies must not count (they would double-count, and other entries can quote the text), so
 *  only the queue-operation shape is accepted. The pre-check keeps JSON.parse off almost every line. */
export function workerReturnId(line: string): string | null {
  if (!line.includes('<tool-use-id>')) return null
  let e: { type?: unknown; operation?: unknown; content?: unknown }
  try { e = JSON.parse(line) as typeof e } catch { return null }
  if (e?.type !== 'queue-operation' || e.operation !== 'enqueue' || typeof e.content !== 'string') return null
  if (!e.content.trimStart().startsWith('<task-notification>') || !e.content.includes('<status>')) return null
  const m = /<tool-use-id>([^<\s]+)<\/tool-use-id>/.exec(e.content)
  return m === null ? null : m[1]
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
   *  no-review sentinel (both roles). REVIEW and MEASURE both credit ONLY an Agent spawn that passes
   *  `isCreditedFork` (a `fork` with no isolation parameter) and whose prompt carries that role's
   *  marker. -1 when never. */
  roles: { measure: number; review: number }
  /** The role the transcript's OWN first prompt declares (a subagent's spawning brief), which
   *  exempts that agent from the SubagentStop gate. Meaningless for the main transcript. */
  ownRole: Role | null
}

/** ONE scan for both gates. Pure: it judges the lines it is handed by their relative position. WHICH
 *  lines it is handed is the reader's decision (`readCurrentTurn`): the scan never sees past the current
 *  turn's start, so a review or record write from an earlier turn cannot release this turn's work. WHAT
 *  counts as work is decided in the triggers module; `cwd` is the hook's, for resolving relative write
 *  targets. */
export function scanTranscriptLines(lines: string[], cwd = process.cwd(), ownAgentId?: string, workerWrote?: (toolUseId: string) => string | null): GateScan {
  let work: GateScan['work'] = null
  let lastProposal = -1
  const roles: GateScan['roles'] = { measure: -1, review: -1 }
  let ownRole: Role | null = null
  let sawFirstUser = false
  // The last REVIEW fork's prompt, and which record writes it has already exempted (TRDD-9YWTNFU8). Reset at every REVIEW credit.
  let lastReviewPrompt: string | null = null
  let recordUsed = { append: false, commit: false }
  const denied = deniedToolUseIds(lines)
  for (let i = 0; i < lines.length; i++) {
    // WORKER WRITES (TRDD-9YWTNFU8). A background worker (lean/cheap/fast/smart-worker) has no Agent
    // tool, so its own SubagentStop gate releases it, and nothing looked at what it wrote: two Rust fix
    // rounds went unreviewed on 2026-10-09. Its return, a `queue-operation` line, is where those writes
    // become the main agent's to review, so only the main gate passes `workerWrote`.
    // KNOWN LIMITS: a return counts only when its queue-operation line is in the run just before its
    // task-notification turn start (see readCurrentTurn), so a return recorded earlier is not seen; a
    // worker whose notification was never recorded (session cleared first) is not seen; workers spawned
    // by workers are not scanned; a heartbeat turn is blocked when a worker returns inside it (intended:
    // that is the 2026-10-09 15:15 case). Without `workerWrote` this branch never runs.
    // a worker that ran in another cwd (a worktree) has its relative targets judged against the main session's cwd.
    if (workerWrote !== undefined) {
      const returned = workerReturnId(lines[i])
      if (returned !== null) {
        const detail = workerWrote(returned)
        if (detail !== null) work = { index: i, cause: 'worker write', detail }
        continue
      }
    }
    let e: TranscriptEntry
    try { e = JSON.parse(lines[i]) as TranscriptEntry } catch { continue }
    // Sidechain entries are a child agent's turns — their prose must never be scored as the
    // parent's work. EXCEPT a subagent's OWN transcript: every one of its entries is
    // `isSidechain: true` and carries its own `agentId`, so skipping them all made the SubagentStop
    // gate scan nothing and always allow (TRDD-LZ2JDIJP: 382 of 387 writing subagents since
    // 2026-09-15 were never reviewed). Keep an entry whose agentId is the caller's own; its nested
    // grandchildren carry a different agentId and stay excluded. The main gate passes no id.
    if (e?.isSidechain === true && !(ownAgentId !== undefined && e.agentId === ownAgentId)) continue
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
        if (isNoReviewSentinel(text)) {
          roles.measure = Math.max(roles.measure, i)
          roles.review = Math.max(roles.review, i)
          lastReviewPrompt = null
          recordUsed = { append: false, commit: false }
          continue
        }
        // A MARKED proposal is work. Plain prose is not — for one day EVERY text block was, and that
        // livelocked idle turns (TRDD-0E3W5C45). The marker is decided in the triggers module.
        if (textArms(text)) { work = { index: i, cause: 'proposal text', detail: '' }; lastProposal = i }
        continue
      }
      if (b?.type !== 'tool_use') continue
      if (b.name === 'Agent') {
        // SPAWN credit. REVIEW and MEASURE both credit only a fork with no isolation parameter
        // (isCreditedFork, shared with reviewSupervisor). WHY the whole-line marker: a worker brief that
        // merely mentions "ROLE: REVIEW" while DESCRIBING this gate's protocol (e.g. this very file's
        // own prose) must not release the gate with no reviewer ever spawned (adversarial review of
        // 268f3080, finding b). WHY no isolation: an isolated spawn fails outside git and is not a
        // reviewer the gate can rely on. Permanent from the spawn index on; nothing the agent returns
        // un-credits it.
        const role = declaredRole(String(b.input?.prompt ?? ''))
        if (role !== null && isCreditedFork(b.input ?? {})) {
          if (role === 'review') {
            roles.review = Math.max(roles.review, i)
            lastReviewPrompt = String(b.input?.prompt ?? '')
            recordUsed = { append: false, commit: false }
          } else {
            roles.measure = Math.max(roles.measure, i)
          }
        }
        continue
      }
      // A delegate-gate-denied call never ran (TRDD-PNB9FNJ0) — not work.
      if (isDeniedEdit(b, denied)) continue
      // RECORD WRITES ARE NOT NEW WORK (TRDD-9YWTNFU8): one card append and one path-limited card commit ride each review,
      // and only a record naming that review's card; a review's own bookkeeping must not spawn a review of its note.
      if (b.name === 'Bash') {
        // The exemption is granted on the command TEXT, so a denied or failed append still uses up this review's one append (the safe direction: the retry arms).
        const rec = recordWrite(String(b.input?.command ?? ''), cwd)
        if (rec !== null && lastReviewPrompt !== null && roles.review !== -1 && (work === null || work.index <= roles.review) && !recordUsed[rec.kind]
          && (rec.kind === 'commit' || new RegExp(`(^|[^A-Za-z0-9])${rec.id}([^A-Za-z0-9]|$)`, 'i').test(lastReviewPrompt))) {
          recordUsed[rec.kind] = true
          continue
        }
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
  'worker write': 'a worker you spawned wrote files',
}

// NO isolation parameter: an isolated spawn earns no credit (isCreditedFork), so demanding one wastes the turn.
const REVIEW_DEMAND = 'Spawn ONE adversarial REVIEW fork (Agent tool, subagent_type "fork", NO isolation parameter) and COPY THIS LINE '
  + 'VERBATIM INTO ITS PROMPT: "' + REVIEW_ROLE_RULE + '"'
// owner decision 2026-10-14: MEASURE is a fork too, because a fresh agent earns no credit. A fork reuses
// the parent's prompt cache, and a measurer only runs read-only commands and reads files with tldr.
const MEASURE_DEMAND = 'Spawn ONE MEASURE fork (Agent tool, subagent_type "fork", NO isolation parameter; its prompt is a '
  + 'numbered step list, one assumption per step, each with the exact command to run and what to report) and COPY THIS LINE VERBATIM '
  + 'INTO ITS PROMPT: "' + MEASURE_ROLE_RULE + '"'

/** What the blocked agent must spawn, and how the gate releases. One text for both gates so the
 *  two can never drift. */
export function demandText(d: Demand): string {
  const parts = d === 'review' ? [REVIEW_DEMAND] : d === 'measure' ? [MEASURE_DEMAND] : [MEASURE_DEMAND, REVIEW_DEMAND]
  return parts.join(' ') + ' A spawn counts ONLY if it is a fork with NO isolation parameter and the ROLE marker is the FIRST NON-BLANK line of its prompt. '
    + 'Put the spawn tool_use(s) LAST in the response, after the turn\'s last edit, write-shaped command or "' + PROPOSAL_MARKER + '" line: a write or proposal after the spawn re-arms this gate. '
    + 'If you CANNOT spawn — ' + NO_REVIEW_SENTINEL_EXAMPLES.join(', ') + ' — emit a text block whose ENTIRE content is "' + NO_REVIEW_SENTINEL + ' — <reason>"; that is the only other way out. '
    + 'Full rules: `agentlenspro review-gate --directive`.'
}

/** The block message names WHAT armed the gate and WHICH agents it wants. It names the scanned window
 *  as this turn only (`readCurrentTurn`): an earlier turn's work is not in the scan, so the message never
 *  cites it. */
export function mainBlockReason(cause: ArmCause, detail: string, demand: Demand): string {
  const what = detail === '' ? ARM_CAUSE_TEXT[cause] : `${ARM_CAUSE_TEXT[cause]}: ${detail}`
  // WHY: a worker's files are already on disk and its report only describes them, so the fork must review the real diff.
  const gitFirst = cause === 'worker write'
    ? 'FIRST, in an earlier response than the fork spawn, run `git status --short` and `git diff` on the files the worker changed (print new files too, or `cat` a file that is outside git), so the fork reviews the real change and not a description. '
    : ''
  return `Review gate: ${what} after the last review (scanned: this turn only). ${gitFirst}${demandText(demand)}`
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
  // THIS TURN ONLY (owner ruling 2026-10-14): work from an earlier turn must not carry over into this one.
  // warnNoTurnStart: a main transcript without a turn start means CC dropped turnPosition; say so.
  const lines = readCurrentTurn(transcript, { warnNoTurnStart: true })
  if (lines === null) {
    process.stderr.write('[review-gate] allowing UNREVIEWED: could not read the current turn of the transcript\n')
    return null
  }
  // Only the main gate passes workerWrote: a worker's writes are reviewed at its return (see scanTranscriptLines).
  const scan = scanTranscriptLines(lines, hookCwd(input), undefined, (id) => workerWriteDetail(transcript, id, hookCwd(input)))
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

/** The SubagentStop block decision: the block JSON, or null when this agent may stop. */
async function subagentBlock(input: ReviewGateInput): Promise<string | null> {
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
  // The subagent's own file has no turn start, so readCurrentTurn returns all of it: its one turn.
  const lines = readCurrentTurn(own)
  if (lines === null) {
    process.stderr.write('[review-gate] allowing UNREVIEWED: agent_transcript_path is unreadable for ' + JSON.stringify(type) + '\n')
    return null
  }
  // `agent_id` lets the scan keep this agent's own sidechain entries (TRDD-LZ2JDIJP).
  const ownAgentId = typeof input?.agent_id === 'string' ? input.agent_id : undefined
  const scan = scanTranscriptLines(lines, hookCwd(input), ownAgentId)
  if (subagentExempt(type, scan.ownRole)) return null
  const demand = decideGate(scan)
  if (demand === null || scan.work === null) return null
  return JSON.stringify({ decision: 'block', suppressOutput: true, reason: subagentBlockReason(scan.work.cause, scan.work.detail, demand) })
}

/** SubagentStop: a block when the agent owes a review; otherwise the review display, so a finished review
 *  or measure report reaches the user's terminal. The display runs only when the agent is NOT blocked: a
 *  block already tells the agent what to do, and a second message would be noise. */
export async function runSubagentGate(input: ReviewGateInput): Promise<string | null> {
  return (await subagentBlock(input)) ?? reviewDisplay(input)
}

// ── `--json-verdict`: the SAME scan, as machine-readable data for a mod (TRDD-KZCSO0R2 Phase 0) ───
// A mod (hooks module) runs `agentlenspro review-gate --json-verdict` to ask the gate's own question —
// "does this turn demand an adversarial review?" — and get data back instead of the hook-shaped block
// JSON. It reuses readCurrentTurn -> scanTranscriptLines -> decideGate, so the criteria live in ONE place
// and cannot drift from the hook behavior (the check-no-mirrors rule). Read-only: it never writes and, at
// the call site, never blocks. It does NOT apply the gates' agent-capability check — the verdict is the
// scanner's decision (the same reason strings the gates would block on); the caller decides what to do.

export interface GateVerdict {
  /** True when the scan demands a review/measure fork for this payload's turn. */
  demands: boolean
  /** The block reason string(s) the gate would emit — the SAME text mainBlockReason/subagentBlockReason
   *  produce — so a caller can show or log exactly what the hook would have said. Empty when demands=false. */
  reasons: string[]
  /** A short summary of what was scanned. */
  scan: { transcript: string | null; kind: 'main' | 'subagent'; lines: number }
}

/** The verdict the Stop/SubagentStop gate would reach for this payload's turn, as data. Read-only. A
 *  missing/unreadable transcript is "no demand", the same fail-open allow the gates take. */
export function computeVerdict(input: ReviewGateInput): GateVerdict {
  const evt = input?.hook_event_name ?? input?.hookEventName
  const subagent = evt === 'SubagentStop'
  const kind: GateVerdict['scan']['kind'] = subagent ? 'subagent' : 'main'
  const transcript = subagent ? input?.agent_transcript_path : input?.transcript_path
  if (typeof transcript !== 'string' || !fs.existsSync(transcript)) {
    return { demands: false, reasons: [], scan: { transcript: null, kind, lines: 0 } }
  }
  // The subagent gate honours the harness loop-breaker and the exemption list BEFORE scanning; mirror that
  // so a subagent the hook would release never reads as a demand here.
  const agentType = String(input?.agent_type ?? '')
  if (subagent && (input?.stop_hook_active === true || subagentExempt(agentType, null))) {
    return { demands: false, reasons: [], scan: { transcript, kind, lines: 0 } }
  }
  const lines = subagent ? readCurrentTurn(transcript) : readCurrentTurn(transcript, { warnNoTurnStart: true })
  if (lines === null) return { demands: false, reasons: [], scan: { transcript, kind, lines: 0 } }
  const ownAgentId = subagent && typeof input?.agent_id === 'string' ? input.agent_id : undefined
  const scan = subagent
    ? scanTranscriptLines(lines, hookCwd(input), ownAgentId)
    : scanTranscriptLines(lines, hookCwd(input), undefined, (id) => workerWriteDetail(transcript, id, hookCwd(input)))
  if (subagent && subagentExempt(agentType, scan.ownRole)) {
    return { demands: false, reasons: [], scan: { transcript, kind, lines: lines.length } }
  }
  const demand = decideGate(scan)
  if (demand === null || scan.work === null) {
    return { demands: false, reasons: [], scan: { transcript, kind, lines: lines.length } }
  }
  const reason = subagent
    ? subagentBlockReason(scan.work.cause, scan.work.detail, demand)
    : mainBlockReason(scan.work.cause, scan.work.detail, demand)
  return { demands: true, reasons: [reason], scan: { transcript, kind, lines: lines.length } }
}

/** Longest `systemMessage` the review display emits. WHY a cap: a review is long, and the terminal is not
 *  a file viewer; the full text stays one `Read` away at the transcript path. */
const REVIEW_DISPLAY_MAX_CHARS = 9500

/** The `systemMessage` for a finished agent whose last message OPENS with a report marker, or null. The first
 *  non-blank line decides, through `markerOpening`: decoration such as `**`, backticks or surrounding whitespace
 *  is not a barrier, but the marker must be at the START of that line. A marker quoted mid-line or on a later
 *  line does not trigger the display. WHY `systemMessage` and not `additionalContext`: it is shown to the USER
 *  only and never enters the model's context, so the review does not spend the model's window twice. */
function reviewDisplay(input: ReviewGateInput): string | null {
  const text = typeof input?.last_assistant_message === 'string' ? input.last_assistant_message : ''
  const firstLine = text.split('\n').find((line) => line.trim() !== '')
  if (firstLine === undefined || markerOpening(firstLine) === null) return null
  if (text.length <= REVIEW_DISPLAY_MAX_CHARS) return JSON.stringify({ systemMessage: text })
  const transcriptPath = input.agent_transcript_path
  if (typeof transcriptPath !== 'string') {
    process.stderr.write('[review-gate] review display skipped: the review is longer than the display cap and agent_transcript_path is missing\n')
    return null
  }
  // The cut is counted INCLUDING the pointer, so the emitted message never exceeds the cap.
  const pointer = `… (truncated; full text: ${transcriptPath})`
  return JSON.stringify({ systemMessage: text.slice(0, REVIEW_DISPLAY_MAX_CHARS - pointer.length) + pointer })
}

// ── Process entry for `agentlenspro review-gate` ─────────────────────────────────────────────────

/** `agentlenspro review-gate [--directive] [--json-verdict]`. Always resolves 0 — a Stop/SubagentStop hook that
 *  can throw or hang can wedge the session, which is worse than a missed review. Dispatches on
 *  `hook_event_name`: `SubagentStop` -> the subagent gate, `Stop` (or an absent field) -> the main
 *  gate. Any other event is a silent allow. `--json-verdict` (TRDD-KZCSO0R2 Phase 0) runs the SAME
 *  readCurrentTurn -> scan -> decide pipeline but prints the verdict as ONE JSON object and ALWAYS
 *  exits 0 (read-only: never blocks, unlike hook mode). */
export async function runReviewGate(argv: string[]): Promise<number> {
  if (argv[0] === '--directive') {
    process.stdout.write(REVIEW_GATE_DIRECTIVE)
    return 0
  }
  // --json-verdict: the read-only mode a mod calls. It shares the hook-mode parse path below (same
  // payload, same kill-switch stance), and only the OUTPUT differs — a data object instead of a block.
  const jsonVerdict = argv.includes('--json-verdict')
  // NO KILL-SWITCH CHECK HERE, on purpose. The global switch (the DISABLED flag file, or AGENTLENS_DISABLED=1)
  // exists to stop side-effects: disk writes and server revive. This gate has none: it reads the transcript
  // and prints a block to stdout. While the switch silenced it, every stop was allowed UNREVIEWED and no
  // adversarial review was demanded (owner order 2026-09-03: never stopped or bypassed; owner directive
  // 2026-11-03: the review must work at every turn and for every agent). The brake is a sequence:
  // `agentlenspro enable`, then `agentlenspro --uninstall-hooks` (refused by `disabledNotice` in
  // foreignTelemetry.ts while the switch is armed), then `agentlenspro disable` again. Each running
  // session keeps the hook until it restarts; the next launch of a verb outside
  // `AUTOSETUP_EXCLUDED_VERBS` (autoSetup.ts) re-registers it through `ensureInstalled` unless the
  // switch is armed afterwards.
  const payload = await readStdin(process.stdin)
  // THE ENV KILL-SWITCH IS GONE (owner order, 2026-09-03: "it must NEVER BE STOPPED OR BYPASSED, no
  // matter what"). `AGENTLENS_REVIEW_FORK=off` is ignored: an env var is settable by anything in the
  // process tree, so it was a bypass available to the very agent the gate exists to constrain.
  if ((process.env.AGENTLENS_REVIEW_FORK || '').trim() === 'off') {
    process.stderr.write('[review-gate] AGENTLENS_REVIEW_FORK=off is IGNORED — the review gate cannot be disabled.\n')
  }
  let input: ReviewGateInput
  try { input = JSON.parse(payload.toString('utf8')) as ReviewGateInput } catch {
    if (jsonVerdict) {
      process.stdout.write(JSON.stringify({ demands: false, reasons: [], scan: { transcript: null, kind: 'main', lines: 0 } }) + '\n')
      process.stderr.write('[review-gate] allowing UNREVIEWED: the hook payload is not valid JSON\n')
      return 0
    }
    process.stderr.write('[review-gate] allowing UNREVIEWED: the hook payload is not valid JSON\n')
    return 0
  }
  if (jsonVerdict) {
    // ALWAYS exit 0: read-only, it never blocks. The verdict is the scanner's own decision; a bad
    // payload yields demands:false.
    process.stdout.write(JSON.stringify(computeVerdict(input)) + '\n')
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
