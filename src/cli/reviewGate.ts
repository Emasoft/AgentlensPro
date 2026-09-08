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
import { agentlensDisabled } from './killSwitch'
import { readStdin } from './hookHandlers'

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
export const ONE_TURN_RULE = 'Answer in ONE turn. Make ZERO tool calls — no SendMessage, no Read, '
  + 'no Bash, none. Put every finding INLINE in your final message and stop.'

export const REVIEW_GATE_DIRECTIVE = `# Review-fork gate directive (read on every Stop-hook fire)

Spawn ONE adversarial reviewer with the Agent tool, \`subagent_type: "fork"\`, with a prompt that:

- states what you did this turn and every claim you are asserting;
- carries THIS LINE VERBATIM, because the fork reads nothing else you were told:
  "${ONE_TURN_RULE}"
  (a second turn rewrites the shared prefix at the cache-WRITE rate and destroys the economics);
- tells it to hunt the recurring failure shape — a PROXY read in place of the thing (a pipe's
  exit status for the tool's, a preview for the file, a profile for the workload rate, one run
  for the variance, an assumed format for the real one);
- asks it to name the single WEAKEST link and give ONE settling command for it.

THE EXIT IS POSITIONAL, and this is the part that is easy to get wrong. The gate releases when
the fork sits at a HIGHER transcript index than the last thing that armed it, and an assistant
text block arms it. So:

- put the fork \`tool_use\` LAST, in the SAME response as your user-visible text;
- emit NOTHING after it — text after the fork re-arms the gate;
- do NOT split the text and the fork across two responses. A fork-only response has no visible
  output, the harness injects a complaint turn, and answering THAT complaint is what fires the
  gate. Measured 2026-09-08: ten forks and ~2.4M subagent tokens went to this one mistake.

A BACKGROUND fork's completion notification manufactures a fresh turn, that turn must emit text,
and the text re-arms the gate — a self-sustaining loop that ends only on user input. Consume the
fork in-turn (\`TaskOutput\` with \`block: true\`; it is not an arming block) so no notification
is left to force the next turn.

Then read its findings and act on them — in the NEXT turn, which is the earliest a report-out can
happen without re-arming. Do NOT restate this directive to the user — spawn the fork and
continue. This gate CANNOT be disabled — \`AGENTLENS_REVIEW_FORK=off\` is ignored.
`

interface ReviewGateInput {
  hook_event_name?: unknown
  hookEventName?: unknown
  transcript_path?: unknown
  session_id?: unknown
  agent_id?: unknown
  agent_type?: unknown
  agent_transcript_path?: unknown
  /** Set by Claude Code when a Stop hook already blocked this same stop — the harness's own
   *  loop breaker. Honoured before anything else: with it ignored, an unwritable tmpdir (the
   *  counter never persists) blocked every fire forever (review of dca6c45, F1). */
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

interface AssistantContentBlock {
  type?: unknown
  name?: unknown
  // Present only on `type: 'text'` blocks. Read to recognize the no-review sentinel — the gate's
  // only exit that does not require spawning an agent. `unknown`, not `string`, because this is
  // parsed from an on-disk JSONL a different process wrote: a malformed entry must reach the
  // String() coercion at the read site, not throw here.
  text?: unknown
  input?: { subagent_type?: unknown; command?: unknown }
}
/** The sentinel an agent emits when it CANNOT spawn a reviewer — the only exit from either gate
 *  that does not require spawning one. ONE definition serves both gates deliberately: two copies
 *  would drift, and an agent that learned the phrase from one gate's message would be wedged by
 *  the other. Must be the FIRST thing in a text block (anchor rationale at each read site), and
 *  must carry a reason — so "I can't" is a statement someone can act on, not a magic word. The
 *  reason is never parsed; requiring it is what stops the phrase becoming a reflex. */
export const NO_REVIEW_SENTINEL = 'REVIEW-GATE: NO REVIEW POSSIBLE'
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
function isNoReviewSentinel(text: string): boolean {
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
  // in substance. The reason itself must survive stripping them: >=3 characters.
  const reason = firstLine.replace(/^[\s—:-]+/, '').trim()
  return reason.length >= 3
}

interface TranscriptEntry {
  type?: unknown
  isSidechain?: unknown
  message?: { content?: AssistantContentBlock[] }
}

const EDITORS = new Set(['Edit', 'Write', 'NotebookEdit'])
// Shell quoting is stripped before matching so prose ABOUT committing is not mistaken for a
// commit — `echo "run git commit"` must not trigger a review.
const unquoted = (s: string): string => s.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '')

// ── MAIN AGENT GATE (Stop) ──────────────────────────────────────────────────────────────────────

const MAIN_MAX_PER_SESSION_DEFAULT = 20
const MAIN_MAX_CONSECUTIVE = 2

interface MainBreakerState { total: number; consecutive: number }

/** Read per-call so a live AGENTLENS_REVIEW_FORK_MAX change is honored. */
export function mainGateMaxPerSession(): number {
  const v = Number(process.env.AGENTLENS_REVIEW_FORK_MAX)
  return v > 0 ? v : MAIN_MAX_PER_SESSION_DEFAULT
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

/** Scan the main transcript's tail for the last fork spawn and the last consequential edit. Pure —
 *  the whole "relative position, not turn boundaries" rule lives here, so it is testable without a
 *  real transcript file. */
export function scanMainTranscriptLines(lines: string[]): { lastFork: number; lastWork: number } {
  let lastFork = -1
  let lastWork = -1
  for (let i = 0; i < lines.length; i++) {
    let e: TranscriptEntry
    try { e = JSON.parse(lines[i]) as TranscriptEntry } catch { continue }
    // Subagent turns are marked `isSidechain: true` — skipping them means a sidechain transcript
    // yields no work and no fork, so the gate allows the stop and stays silent.
    if (e?.isSidechain === true) continue
    if (e?.type !== 'assistant') continue
    const content = e?.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      // A PROPOSAL IS WORK (owner order, 2026-09-07). The gate used to fire only on Edit/Write/
      // NotebookEdit/commit, so the turn that PROPOSES a change while writing nothing to disk was
      // invisible to it — exactly the turn propose-then-review-then-implement needs reviewed.
      if (b?.type === 'text') {
        // THE SAME EXIT THE SUBAGENT GATE HAS, and it is needed here for a reason the positional
        // rule hides. `lastFork >= lastWork` is always *reachable* — but only by an agent that can
        // actually SPAWN. An agent whose Agent tool is declared yet whose spawn cannot succeed —
        // rate-limited (this machine saw a 7994 s limit on 2026-09-07), at a depth or concurrency
        // ceiling, or denied by a PreToolUse rule — has no exit at all: `agentCannotSpawn` releases
        // only agents with no Agent tool DECLARED, which is a different population. That agent is
        // wedged exactly as the subagent was, so it gets the same escape: say so, in the sentinel
        // form, and the gate treats the review as resolved.
        //
        // Sets `lastFork` and NOT `lastWork` — the sentinel is an exit, not a proposal, so it must
        // not arm the gate it is closing. Prose in a LATER BLOCK re-arms it positionally, so the
        // sentinel does have to be the turn's last block. That rule does NOT cover prose on a
        // later LINE of the SAME block, which has no index and cannot re-arm — `isNoReviewSentinel`
        // rejects a block carrying anything after the reason line, and this comment previously
        // claimed a protection the code did not have.
        if (isNoReviewSentinel(String(b.text ?? ''))) { lastFork = i; continue }
        lastWork = i
        continue
      }
      if (b?.type !== 'tool_use') continue
      if (b.name === 'Agent' && b.input?.subagent_type === 'fork') { lastFork = i; continue }
      if (typeof b.name === 'string' && EDITORS.has(b.name)) { lastWork = i; continue }
      if (b.name === 'Bash' && /\bgit\s+commit\b/.test(unquoted(String(b.input?.command ?? '')))) lastWork = i
    }
  }
  return { lastFork, lastWork }
}

/** The rule: allow the stop iff the last fork spawn is NEWER than the last consequential action.
 *  Pure decision over an already-scanned transcript + breaker state. Returns `nextState` by
 *  REFERENCE-equal to `state` when nothing changed, so the caller can skip an unnecessary write. */
export function decideMainGate(
  scan: { lastFork: number; lastWork: number },
  state: MainBreakerState,
  opts: { maxPerSession: number; maxConsecutive: number },
): { block: boolean; nextState: MainBreakerState } {
  if (scan.lastWork === -1) return { block: false, nextState: state } // nothing claimed this window
  // `>=`, not `>`: two blocks CAN share an index when a harness writes one transcript entry per
  // assistant message, and a tie must go to the fork or that turn can never end. MEASURED
  // 2026-09-07 on this project's own session JSONL: this Claude Code build writes ONE ENTRY PER
  // CONTENT BLOCK (thinking / text / tool_use each got their own index), so the tie never occurs
  // here and `>=` is degenerate on this format. It is kept because it is correct on both shapes.
  // THE EXIT IS POSITIONAL, so the fork must be the LAST arming block of the turn. Because this
  // build writes one entry per content block (see below), prose emitted AFTER a fork re-arms the
  // gate and the turn is blocked again. Spawn the review as the turn's final act, not mid-turn.
  if (scan.lastFork >= scan.lastWork) {
    // The review landed. THIS IS THE ONLY WAY PAST THE GATE.
    return { block: false, nextState: state.consecutive !== 0 ? { total: state.total, consecutive: 0 } : state }
  }
  // NO GIVE-UP. The consecutive and per-session breakers were REMOVED (owner order, 2026-09-03:
  // "it must NEVER BE STOPPED OR BYPASSED, no matter what"). They used to fail OPEN on the reasoning
  // that a wedged session costs more than a skipped review — but the measured outcome was worse: on
  // 2026-09-03 this session ignored the demand twice, `consecutive` reached 2, the gate went silent,
  // and EVERY subsequent change went unreviewed with nothing announcing it. A silent stop is the one
  // failure a safety gate must not have.
  //
  // The exit is always available and is the thing being asked for: spawn the fork and the branch
  // above returns immediately. The caller ALSO applies `agentCannotSpawn` so an agent that has no
  // Agent tool is released rather than wedged — a capability check, not a give-up. That check was
  // missing from the main gate when this comment first claimed it (review finding G2).
  // `opts` is retained for the tests that pin this behaviour and for callers still passing limits.
  void opts
  return { block: true, nextState: { total: (state.total || 0) + 1, consecutive: (state.consecutive || 0) + 1 } }
}

function mainStatePath(key: string): string {
  const safe = String(key).replace(/[^A-Za-z0-9]/g, '_').slice(-64)
  return path.join(os.tmpdir(), `agentlens-review-fork-${safe}.json`)
}
function readMainState(p: string): MainBreakerState {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as MainBreakerState } catch { return { total: 0, consecutive: 0 } }
}
/** False when the breaker could not be persisted — the caller must then NOT block: a demand that
 *  cannot be counted is a demand repeated forever (review of dca6c45, F1: an unwritable tmpdir
 *  blocked every fire with `demands` stuck at 0). */
function writeMainState(p: string, s: MainBreakerState): boolean {
  try { fs.writeFileSync(p, JSON.stringify(s)); return true } catch { return false }
}

// The ONE-TURN rule lives HERE, in the text the agent reads on every single fire, because that is
// what actually changes behaviour. A PreToolUse deny was tried and reverted: nothing registers
// review-gate on PreToolUse, it could not tell a review fork from any other fork (they all share
// `subagent_type: 'fork'`), and it would not have prevented turn 2 anyway — the deny returns as a
// tool RESULT and reacting to it is the cold request. Measured 2026-09-03: six multi-turn review
// forks cost ~4.6M tokens; the first zero-tool-call fork answered in 18s off one warm read.
export const MAIN_BLOCK_REASON = 'Review-fork gate: this turn edited or committed. Spawn ONE adversarial '
  + 'fork (Agent tool, subagent_type "fork"), and COPY THIS LINE VERBATIM INTO ITS PROMPT: "'
  + ONE_TURN_RULE + '" The fork cannot see this message, so a rule you do not paste into its prompt '
  + 'never reaches it; it inherits your context, so any tool call only buys a second turn that '
  + 'rewrites the whole prefix at the cache-WRITE rate. Run `agentlenspro review-gate --directive` '
  // Symmetric with SUBAGENT_BLOCK_REASON. The positional exit (`lastFork >= lastWork`) is always
  // REACHABLE, but only by an agent whose spawn can succeed; a rate-limited or depth-capped agent
  // has the Agent tool declared, so `agentCannotSpawn` never releases it, and before the sentinel
  // it had no exit whatsoever. Naming the escape in the message is half the fix — an escape nobody
  // is told about is not one.
  + 'for the full directive, then act on the findings. THE EXIT IS POSITIONAL: put the fork '
  // The rule the blocked agent most needs was stated ONLY in the source comment above
  // `scanMainTranscriptLines`, which that agent never reads. Measured 2026-09-08: a session
  // spawned the fork and then reported to the user, so the report's text block took the higher
  // index and re-armed the gate — ten forks and ~2.4M subagent tokens before the shape was
  // read out of the source. An instruction whose correct execution is undocumented is a trap,
  // not an instruction. (TRDD-DRH4ZRGB)
  + 'tool_use LAST, in the SAME response as your user-visible text, and emit NOTHING after it: '
  + 'any text block after the fork re-arms this gate, and splitting the text and the fork across '
  + 'two responses is what makes that happen. If you CANNOT spawn one — rate-limited, at '
  + `a depth limit, tool denied — emit a text block whose ENTIRE content is "${NO_REVIEW_SENTINEL} `
  + '— <reason>", nothing after the reason; that is the only other way out.'

async function runMainGate(input: ReviewGateInput): Promise<string | null> {
  const transcript = input?.transcript_path
  if (typeof transcript !== 'string' || !fs.existsSync(transcript)) return null
  const lines = readTranscriptTail(transcript)
  if (lines === null) return null
  const scan = scanMainTranscriptLines(lines)
  const key = typeof input?.session_id === 'string' && input.session_id ? input.session_id : transcript
  const statePath = mainStatePath(key)
  const state = readMainState(statePath)
  const verdict = decideMainGate(scan, state, { maxPerSession: mainGateMaxPerSession(), maxConsecutive: MAIN_MAX_CONSECUTIVE })
  // Persist for observability only. The stored counters no longer gate anything, so a failed write
  // must NOT skip the review: an unwritable tmpdir, a full disk or a chmod on the state file would
  // otherwise be a silent bypass reachable by the very agent being constrained — the same class of
  // escape as the env var just closed, and quieter (review finding G3).
  if (verdict.nextState !== state) writeMainState(statePath, verdict.nextState)
  if (!verdict.block) return null
  // CAPABILITY CHECK, not a give-up: an agent that has no Agent tool cannot satisfy the demand, and
  // blocking it forever wedges the session with no exit. The subagent gate already did this; the
  // main gate did not, which made the "this cannot wedge" comment above false until now (G2).
  // `stop_hook_active` is deliberately NOT honoured — that would be a one-block cap by another name.
  if (agentCannotSpawn(String(input?.agent_type ?? ''))) {
    process.stderr.write('[review-gate] the Agent tool is unavailable here, so the review cannot be demanded — allowing the stop UNREVIEWED.\n')
    return null
  }
  return JSON.stringify({ decision: 'block', suppressOutput: true, reason: MAIN_BLOCK_REASON })
}

// ── SUBAGENT GATE (SubagentStop) ───────────────────────────────────────────────────────────────

const SUBAGENT_MAX_DEMANDS_PER_AGENT = 1

interface SubagentState { demands: number }

/** Agent types that ARE the adversarial reviewer and must never be reviewed themselves. Compared
 *  whole and case-folded — never as a substring, or every `*-fork-*` agent inherits the exemption.
 *  Adding a name here skips that agent's review, so add only a genuine reviewer. */
export const REVIEWER_AGENT_TYPES = new Set(['fork'])

/** Scan a subagent's OWN transcript for whether it did consequential work and whether it already
 *  spawned its own reviewer. Pure — mirrors scanMainTranscriptLines but without the fork-position
 *  logic (a subagent gets at most ONE demand, never a relative-position check). */
export function scanSubagentTranscriptLines(lines: string[]): { didWork: boolean; reviewed: boolean } {
  let didWork = false
  let reviewed = false
  for (const line of lines) {
    if (!line) continue
    let e: TranscriptEntry
    try { e = JSON.parse(line) as TranscriptEntry } catch { continue }
    // Symmetric with scanMainTranscriptLines. Whether an agent's own file can contain its
    // CHILDREN's entries is unverified; filtering makes this correct under both answers instead of
    // betting on one, and stops a child's prose from being scored as the parent's work.
    if (e?.isSidechain === true) continue
    const content = e?.message?.content
    if (e?.type !== 'assistant' || !Array.isArray(content)) continue
    for (const b of content) {
      // A PROPOSAL IS WORK — see scanMainTranscriptLines. A subagent that reasons out a change and
      // returns it as prose has done the thing the owner asked to be reviewed.
      if (b?.type === 'text') {
        // THE TERMINATOR. Without it the block is a LIVELOCK: the demand tells a subagent to state
        // its inability and return, but that statement is itself a `text` block, so it re-arms
        // `didWork` and the identical demand fires again over a strictly longer transcript. Every
        // other brake on this path is gone by design (`enforceOn` and `maxDemands` are voided, the
        // state write is explicitly not allowed to gate), so `reviewed` is the ONLY exit and until
        // now the only way to set it was spawning a fork — impossible for an agent that has the
        // Agent tool but is out of turns, budget, or depth. The escape must therefore set the same
        // flag the fork sets.
        //
        // ANCHORED AT THE START of a trimmed block, deliberately: a fork REVIEWING this gate quotes
        // the sentinel mid-prose (this file's own reviewers did), and a substring test would let
        // that quotation release the very agent under review. Nothing is stripped first — a
        // markdown-quoted `> REVIEW-GATE: ...` or a `# REVIEW-GATE: ...` heading must NOT match,
        // and stripping the marker would be the very smuggling this anchor exists to stop.
        if (isNoReviewSentinel(String(b.text ?? ''))) { reviewed = true; didWork = true; continue }
        didWork = true
        continue
      }
      if (b?.type !== 'tool_use') continue
      if (b.name === 'Agent' && b.input?.subagent_type === 'fork') reviewed = true
      else if (typeof b.name === 'string' && EDITORS.has(b.name)) didWork = true
      else if (b.name === 'Bash' && /\bgit\s+commit\b/.test(unquoted(String(b.input?.command ?? '')))) didWork = true
    }
  }
  return { didWork, reviewed }
}

/** Pure decision: demand a review from a subagent at most once, and only when it (a) is not the
 *  reviewer itself (recursion guard on `agent_type`), (b) enforcement is armed
 *  (AGENTLENS_SUBAGENT_REVIEW=off disables it — ENFORCED by default, like the main gate;
 *  it shipped observe-only-unless-`on`, and since no hook environment ever set that, the
 *  subagent gate had never blocked once — TRDD-6QV50JNN), (c) its own transcript proves it did
 *  work and has not already reviewed itself, (d) it has not already been asked. */
export function decideSubagentGate(
  agentType: string,
  enforceOn: boolean,
  scan: { didWork: boolean; reviewed: boolean } | null,
  demands: number,
  maxDemands: number,
): { block: boolean; nextDemands: number } {
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
    return { block: false, nextDemands: demands }
  }
  // NOT BYPASSABLE (owner order, 2026-09-03: "Not even for the subagents!"). `enforceOn` and the
  // per-agent demand cap are both ignored: a subagent that did work and has not reviewed itself is
  // asked EVERY time it tries to return, not once. The parameters stay in the signature so the
  // existing callers and their tests keep compiling, and so the removal is visible here rather than
  // silently absent.
  void enforceOn; void maxDemands
  if (!scan || !scan.didWork || scan.reviewed) return { block: false, nextDemands: demands }
  return { block: true, nextDemands: demands + 1 }
}

function subagentStatePath(key: string): string {
  const safe = String(key).replace(/[^A-Za-z0-9]/g, '_').slice(-64)
  return path.join(os.tmpdir(), `agentlens-subagent-review-${safe}.json`)
}
function readSubagentState(p: string): SubagentState {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as SubagentState } catch { return { demands: 0 } }
}
function writeSubagentState(p: string, s: SubagentState): boolean {
  try { fs.writeFileSync(p, JSON.stringify(s)); return true } catch { return false }
}

function readSubagentScan(transcriptPath: string): { didWork: boolean; reviewed: boolean } | null {
  try { return scanSubagentTranscriptLines(fs.readFileSync(transcriptPath, 'utf8').split('\n')) } catch { return null }
}

// Carries the same pasted rule as the main gate. It did not until 2026-09-03, which made every
// subagent-spawned review a multi-turn one by default — the gate that costs the most forks was the
// one channel that never stated the constraint.
export const SUBAGENT_BLOCK_REASON = 'Subagent review gate: before returning, spawn ONE adversarial fork '
  + '(Agent tool, subagent_type "fork") over your work and COPY THIS LINE VERBATIM INTO ITS PROMPT: "'
  + ONE_TURN_RULE + '" The fork cannot see this message, so a rule you do not paste into its prompt '
  + 'never reaches it. Run `agentlenspro review-gate --directive` for the full directive, then act '
  // The old tail promised "asked once" and told a wedged agent to "state that in one line and
  // return". Both were false: `maxDemands` is voided so nothing enforces "once", and the statement
  // is itself a text block, which re-arms `didWork` and reproduces the identical demand over a
  // longer transcript — a LIVELOCK whose instructions were the trap. The sentinel is the fix: it
  // is the one text a subagent can emit that sets `reviewed`, so complying now terminates.
  + 'on its findings. If you CANNOT spawn one — no Agent tool, rate-limited, at a depth limit — '
  + `then emit a text block whose ENTIRE content is "${NO_REVIEW_SENTINEL} — <reason>" and return; `
  + 'that is the only other way out. It must START the block and nothing may follow the reason (a '
  + 'quoted copy will not count).'

async function runSubagentGate(input: ReviewGateInput): Promise<string | null> {
  if (input?.stop_hook_active === true) return null
  const type = String(input?.agent_type ?? '')
  if (agentCannotSpawn(type)) return null
  // Same polarity as the main gate's AGENTLENS_REVIEW_FORK: on unless explicitly `off`. Measured
  // 2026-08-29: a subagent whose transcript held one Write and no fork review was allowed live AND
  // on replay, solely because this read `=== 'on'` and nothing sets the variable (TRDD-6QV50JNN).
  // Hardcoded true — the env switch is ignored, same reason as the main gate's above.
  const enforceOn = true
  const own = input?.agent_transcript_path
  // `agent_transcript_path` is the subagent's OWN file — `transcript_path` names the PARENT's and
  // would measure the wrong agent entirely.
  const scan = typeof own === 'string' && fs.existsSync(own) ? readSubagentScan(own) : null
  const agentKey = typeof input?.agent_id === 'string' && input.agent_id
    ? input.agent_id
    : (typeof input?.session_id === 'string' && input.session_id ? input.session_id : 'unknown')
  const statePath = subagentStatePath(agentKey)
  const state = readSubagentState(statePath)
  const verdict = decideSubagentGate(type, enforceOn, scan, state.demands, SUBAGENT_MAX_DEMANDS_PER_AGENT)
  // Same rule as the main gate: an uncounted demand is never issued.
  // Persist for observability only — the demand counter no longer gates anything, so a failed write
  // must not skip the review (review finding G3: an unwritable tmpdir was a silent bypass).
  writeSubagentState(statePath, { demands: verdict.nextDemands })
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
  // must never block the user's work.
  if (agentlensDisabled()) return 0
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
  try { input = JSON.parse(payload.toString('utf8')) as ReviewGateInput } catch { return 0 }
  const evt = input?.hook_event_name ?? input?.hookEventName
  let out: string | null = null
  if (evt === 'SubagentStop') {
    out = await runSubagentGate(input)
  } else if (typeof evt !== 'string' || evt === 'Stop') {
    out = await runMainGate(input)
  }
  if (out) process.stdout.write(out + '\n')
  return 0
}
