// TRDD-6TQ2FBUR — cache-break ROOT-CAUSE timeline. Answers the last forensic question the
// cache_creation tools leave open: "WHICH specific element broke the prompt-cache prefix on this
// turn, and is the SAME element breaking it every turn (a systematic misconfiguration)?"
//
// MECHANICS (Anthropic prompt-caching docs, confirmed 2026-07-09): the cache is a PREFIX cache keyed
// on the EXACT byte sequence of [tools, system, messages], in that hierarchy. A change at any layer
// invalidates that layer AND everything after it, re-billing the tail as cache_creation (1.25x/2x the
// input rate) instead of cache_read (0.1x). Request-level parameters also key the cache: the MODEL,
// the extended-thinking / reasoning-effort setting, tool_choice, and adding/removing images. So a turn
// can re-write the whole prefix WITHOUT any block bytes changing (a pure model / effort switch), which
// is why those are classified from the request fields, not the block diff.
//
// TURN RECONSTRUCTION (proven on real data, TRDD-CCFORNSC + this TRDD): group REQUEST bodies by
// session_id (metadata.user_id blob), order by mtime; turn i's response id == turn i+1's
// diagnostics.previous_message_id (verified byte-exact). cache_creation of turn i is billed on turn i's
// request context, so the CULPRIT is the first element of prefix(req_i) that diverges from
// prefix(req_{i-1}). We diff in the docs hierarchy order (model -> tools -> effort -> system ->
// message-prefix) and STOP at the first divergence — the most-invalidating layer that changed is the
// root cause; deeper changes are its consequence.
//
// POINTER-ONLY: a prefix element carries a stable HASH of its cache-relevant bytes, never the bytes
// themselves. No raw block text, no base64 image data, no metadata.user_id token blob crosses the
// boundary — only derived identifiers (session_id, account_uuid), token counts, kinds, and labels.
//
// LAZY + BOUNDED: a single recency-first, capped scan (never the 30k+-file directory whole); every
// report carries a `coverage` block stating exactly what was scanned. Prefixes are extracted during
// the one scan pass and the multi-MB raw body is dropped immediately, so memory stays bounded.

import { parseUserId } from './rawBodyContext'
import { claudeProjectsDirs } from './logReader'
import { estimateTokensFromBytes } from './tokenEstimator'
import { calcTokenCostUsd } from './shared/pricing'
import {
  defaultBodiesDir, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, RESPONSE_SCAN_CAP,
  bucketValueOf, tokenCountsFullCost, tokenCountsTotal,
  type TokenCounts, type CacheCreationReport, type CacheCreationGroupRow,
  type CostBucket, type OutputSpike, type CacheCreationScanCoverage,
} from './cacheCreationForensics'
import * as fs from 'fs'
import * as path from 'path'
import { listBodyEvidence, loadBodyTexts, type EvidenceRow } from './store/bodiesEvidence'
import { dataPath } from './dataDir'
import { readHookEvents } from './hookEventStore'

export { defaultBodiesDir }

// ── Cause taxonomy ──────────────────────────────────────────────────────────────
export type CacheBreakTimelineCause =
  | 'TOOLSET_CHANGED'            // a tool added/removed/definition-changed (the #1 structural cause)
  | 'TOOLS_REORDERED'           // identical tool set, different order (cache is byte-order sensitive)
  | 'TOOL_SEARCH_DEFERRED'      // a newly-present deferred (defer_loading) tool — tool-search loaded it mid-session
  | 'MCP_TOOLS_CHANGED'         // mcp__ tools added/removed (an MCP server / plugin toggled)
  | 'PLUGINS_RELOADED'          // /reload-plugins re-registered ≥2 catalogs (tools+skills+agents) in one turn
  | 'MODEL_SWITCH'              // model changed mid-session (caches are model-specific)
  | 'EFFORT_SWITCH'             // extended-thinking / reasoning-effort setting changed
  | 'HOOK_INJECTION'            // a per-turn injected hook block mutated (writes into the cached prefix)
  | 'SKILL_INJECTION'           // a skill catalog / skill block newly injected
  | 'SKILL_DESCRIPTION_TRUNCATION' // a skill description shrank (truncated) turn-to-turn
  | 'SKILL_CHANGED'             // a skill catalog / skill block changed content
  | 'INLINE_EXEC_RESULT_CHANGED'// a skill `!`-operator inline shell result differs turn-to-turn
  | 'CLAUDE_MD_CHANGED'         // an injected CLAUDE.md / rules instruction file changed
  | 'MEMORY_FILE_CHANGED'       // an injected memory file (MEMORY.md / a wiki page) was rewritten mid-session
  | 'AGENT_METADATA_CHANGED'    // harness/agent metadata (billing header cc_version, agent-types list) changed
  | 'SYSTEM_TIMESTAMP'          // the only diff is a moving date/clock inside an otherwise-stable block
  | 'CONTEXT_ORDER_CHANGED'     // identical block content, different injection order (cache still breaks)
  | 'TTL_EXPIRY'                // no prefix change; a TTL gap let the cache entry expire (5m or 1h tier)
  | 'COLD_START'                // first turn / no prior cache_read to break / >1h resume
  | 'COMPACTION'                // conversation compaction rebuilt the message layer
  | 'SUBAGENT_INTERLEAVE'       // A→B→A: this request matches turn-2's stream, not turn-1's — a sub-agent's calls share the parent session id
  | 'NORMAL_GROWTH'             // append-only growth: the NEW tail cached for the first time (expected incremental write, NOT a break)
  | 'MESSAGE_TRIMMED'           // a cached message block was REMOVED (harness context-editing / tool-result clearing)
  | 'MESSAGE_SPLICED'           // a NEW block was INSERTED mid-prefix, shifting every later block (harness re-homing an injection)
  | 'ATTACHMENT_CHANGED'        // a non-text block (image / tool_use input) inside the cached prefix changed
  // ── TRDD-B9ERTBZ9 (2026-08-04): documented causes the taxonomy lacked. Each one is detectable from
  //    the raw request bodies we ALREADY capture; a documented cause we cannot emit from captured data
  //    was deliberately left out, because an enum value nothing can ever produce implies coverage that
  //    does not exist. (That list — plan-mode toggles, citations/web-search, workspace isolation,
  //    gateway breakpoint rejection — is TIER 2 of the TRDD, doc knowledge only.)
  | 'WORKING_DIR_CHANGED'       // the environment block (cwd/platform/shell/OS) differs — the cache is scoped to one directory, worktrees included
  | 'GIT_STATE_CHANGED'         // the startup git snapshot (branch / status / recent commits) carried in the system prefix differs
  | 'THINKING_CONFIG_CHANGED'   // body.thinking differs — it is rendered into the prompt, so message blocks always miss
  | 'EFFORT_PARAM_CHANGED'      // body.output_config.effort differs between two EXPLICIT values
  | 'TOOL_CHOICE_CHANGED'       // body.tool_choice differs — invalidates the message blocks only
  | 'LOOKBACK_OVERFLOW'         // unchanged prefix, zero cache_read: ≥20 blocks appended since the last write overran the 20-block lookback window
  | 'BELOW_MIN_CACHEABLE'       // the prompt is under this model's minimum cacheable length — silently never cached, no error
  | 'CACHING_DISABLED'          // the request carried no cache_control marker at all — nothing was ever offered to the cache
  | 'UNCLASSIFIED'              // a break with no localizable structural cause (raw diff summary attached)

// Causes that are EXPECTED cache behavior (unavoidable / not a misconfiguration): a cold warm, a
// compaction rebuild, incremental first-write of new content, and the interleave ARTIFACT (each stream
// keeps its own cache — the diff crossed streams, nothing actually broke). The verdict/ranking uses
// this to point the user at the top AVOIDABLE perpetrator instead of crowning the noise floor.
export const EXPECTED_CAUSES: ReadonlySet<CacheBreakTimelineCause> = new Set<CacheBreakTimelineCause>([
  'COLD_START', 'COMPACTION', 'NORMAL_GROWTH', 'SUBAGENT_INTERLEAVE',
])

// TTL tier a timing-driven break landed in (mirrors buildCacheBreakGapReport's gap buckets).
export type TtlTier = '5m' | '1h' | 'none'

/** Exported for tests: every cause must carry a remediation that states the CONDITION it fires
 *  under. Commit c6802f0 shipped reload/MCP text asserting an UNCONDITIONAL reset the docs
 *  contradict, and an absolute remediation is how that error gets re-shipped. */
export const CACHE_BREAK_REMEDIATION: Record<CacheBreakTimelineCause, string> = {
  TOOLSET_CHANGED:            'A tool was added/removed/redefined mid-session. Keep the tool catalog byte-identical: use defer-loading stubs + tool-search rather than mutating the live tool set.',
  TOOLS_REORDERED:            'The tool set is the same but its ORDER shuffled. Emit tools in a stable sorted order so the catalog bytes never move.',
  TOOL_SEARCH_DEFERRED:       'A deferred tool keeps loading mid-session (tool-search). Pre-load the tools you know you need at session start, or accept the one-time load cost.',
  MCP_TOOLS_CHANGED:          'An MCP server / plugin toggled its non-deferred tools mid-session. Keep MCP servers connected for the whole session, or make their tools deferred.',
  PLUGINS_RELOADED:           'A /reload-plugins re-registered the tool + skill + agent catalogs together, rewriting the whole prefix at the write rate. Reload plugins at session start or in a fresh session, never mid-conversation.',
  MODEL_SWITCH:               'The model changed mid-session — caches are model-specific. Hand off to a sub-agent instead of switching model in place.',
  EFFORT_SWITCH:              'The extended-thinking / reasoning-effort setting changed. Fix the effort level once at session start; changing it invalidates system + messages.',
  HOOK_INJECTION:             'A per-turn hook writes a mutating block INTO the cached prefix. Move the hook output after the last cache breakpoint (into the current user message), or make it stable.',
  SKILL_INJECTION:            'A skill block was injected into the cached prefix. Load skills before the cache breakpoint stabilizes, or keep the skill set fixed.',
  SKILL_DESCRIPTION_TRUNCATION:'A skill description was truncated turn-to-turn, changing the catalog bytes. Keep skill descriptions stable-length within a session.',
  SKILL_CHANGED:              'A skill catalog / skill block changed content mid-session. Keep the available-skills set and their text fixed within a session.',
  INLINE_EXEC_RESULT_CHANGED: 'A skill `!`-operator shell result differs each turn (e.g. a clock/`date`/`git status`), so its injected block re-writes the prefix. Pin or remove the volatile inline command.',
  CLAUDE_MD_CHANGED:          'An injected instruction file (CLAUDE.md / a rule) changed mid-session. Do not edit instruction files during a live session; a date inside them is SYSTEM_TIMESTAMP, not this.',
  MEMORY_FILE_CHANGED:        'An injected memory file (MEMORY.md / a wiki page) was rewritten while sessions were live, mutating msg[0] and re-writing the whole prefix — in EVERY session that injects it, not just the one that wrote it. Batch memory maintenance into one pass, run it when sessions are idle, or keep the injected index stable and put churn in pages that are not injected.',
  AGENT_METADATA_CHANGED:     'Harness/agent metadata (the billing header cc_version, the agent-types list) changed — usually a Claude Code upgrade. Unavoidable once; avoid resuming huge sessions right after upgrading.',
  SYSTEM_TIMESTAMP:           'A moving date/clock inside an otherwise-static block breaks the cache every day/turn. Move the timestamp out of the cached prefix into the current user message.',
  CONTEXT_ORDER_CHANGED:      'The same blocks are injected in a DIFFERENT order — the cache is byte-order sensitive, so this still breaks it. Fix the injection order to be deterministic.',
  TTL_EXPIRY:                 'No prefix change — the cache entry simply expired between turns. A heartbeat within the TTL (5m/1h) would convert these writes back to cache_read.',
  COLD_START:                 'A cold cache warm (first turn / resume / no prior cached prefix). Expected once per session; not an avoidable per-turn break.',
  COMPACTION:                 'Conversation compaction rebuilt the message layer. Expected once per compaction; avoid compacting more than necessary.',
  SUBAGENT_INTERLEAVE:        'Two requests grouped under one session id belong to DIFFERENT streams — sub-agent calls carry the parent\'s session id. Claimed on either of two signatures: the A→B→A pattern (this request matches turn-2\'s tool catalog + model, not turn-1\'s), or a different msg[0] prompt (the conversation\'s own opening words, immutable within one conversation). Each stream keeps its OWN cache, so nothing actually broke and there is nothing to fix; the child bills its own (smaller) prefix. Pin the sub-agent\'s tools + model in its frontmatter to shrink that footprint.',
  NORMAL_GROWTH:              'Not a break — append-only growth: this turn\'s NEW content was cached for the first time (expected incremental write). Reduce it only by producing/ingesting less content per turn.',
  MESSAGE_TRIMMED:            'A block was REMOVED from the cached message prefix (harness context-editing / tool-result clearing / message deletion) — everything after the removal point re-writes. Prefer compaction or a fresh session over mid-session trimming of a huge transcript.',
  MESSAGE_SPLICED:            'A NEW block was INSERTED into the middle of the cached prefix, shifting every later block — everything after the splice point re-writes. The actor is whatever injected the block (typically the harness re-homing a hook/system message), never the shifted bystanders after it.',
  ATTACHMENT_CHANGED:         'A non-text block (image / tool_use input) inside the cached prefix changed or moved. Past attachments should be immutable; an image riding in the prefix re-bills the tail on any change.',
  WORKING_DIR_CHANGED:        'The environment block (working directory / platform / shell / OS) differs between these two turns, and it sits inside the cached system prefix — so a cache entry is scoped to ONE directory, and a second worktree of the same repository is a different prefix. This fires only ACROSS directories, never within one: `/cd` is engineered cache-safe (the new directory\'s CLAUDE.md is appended as a message instead of rebuilding the system prompt). Keep long-running work in one directory, or accept one cold warm per directory.',
  GIT_STATE_CHANGED:          'The startup git snapshot (branch, status, recent commits) carried in the system prefix differs. It is captured ONCE at session start and never updates during a session, so this can only fire between turns that started from different snapshots — a resume, or a second stream sharing this session id. Sequential sessions share a prefix only when that snapshot matches, so branch/commit churn between sessions costs one cold warm each; nothing to fix mid-session.',
  THINKING_CONFIG_CHANGED:    'The thinking configuration changed (type or budget_tokens). It is rendered into the prompt itself, so message-level breakpoints ALWAYS miss; tools and system miss only on models that render the configuration ahead of them, and the docs do not enumerate which. Fix the thinking config once at session start.',
  EFFORT_PARAM_CHANGED:       'output_config.effort changed between two EXPLICIT values. Message blocks always miss; the effect on tools/system is model-specific. Setting effort explicitly to the model default is a documented no-op, so this never fires on an absent↔present transition — only on two different explicit values. Pick one effort level per conversation.',
  TOOL_CHOICE_CHANGED:        'tool_choice changed between two explicit values. Per the docs this invalidates MESSAGE blocks only — tools and system stay cached — so the write is bounded by the message layer rather than the whole prefix. Keep tool_choice constant for the lifetime of a cached conversation.',
  LOOKBACK_OVERFLOW:          'No block changed, yet the cache found nothing to read: at least 20 blocks were appended since the last cache WRITE, and the lookback window is 20 blocks, so it walked past the last entry. This is claimed only when cache_read is 0 with an unchanged prefix — ordinary growth still reads. Add a second breakpoint closer to the growing tail so a write accumulates there before the window overruns.',
  BELOW_MIN_CACHEABLE:        'Both usage counters are 0 while the request DID carry cache_control markers, and the prompt is under this model\'s minimum cacheable length — a below-minimum prompt is silently not cached, with no error. The minimum is per model (512 to 4,096 tokens, an 8x spread), so this fires only when the estimate is under THIS model\'s threshold. Expand the cached content to reach it, or accept the full input rate on these calls.',
  CACHING_DISABLED:           'The request carried NO cache_control marker anywhere, so nothing was offered to the cache and both counters are 0 by construction. That happens when DISABLE_PROMPT_CACHING (or its per-model variant) is set, and also when the caller deliberately does not cache a class of calls — Claude Code\'s small Haiku utility calls historically did not (measured on CC ≤2.1.220; since 2.1.221 its auto-mode permission checks reuse the cached conversation prefix, so that class is shrinking). Unset the environment variable only if this was not intended.',
  UNCLASSIFIED:               'A break whose cause could not be localised from the prefix diff. Inspect the attached raw diff summary and the raw bodies around this turn.',
}

// ── Minimum cacheable prompt length, per model ───────────────────────────────────
// A prompt below its model's minimum is NOT cached and NO error is raised: both usage counters come
// back 0 and the call silently pays the full input rate. The spread is 8x (512 -> 4,096), so a
// threshold keyed on one model id is wrong for every other model — hence a table, and hence an
// UNKNOWN model yields NO verdict rather than a borrowed number.
// Source: the API "Cache limitations" section, quoted verbatim in
// reports/cache-invalidation-research/20260804_142700+0200-prompt-caching-docs.md §2.5. That report
// also records (§4.1) that two fetches of the SAME page returned two different lists — §2.5's is the
// one taken from the verbatim section and is the one used here. Re-verify against the live page
// before trusting a row for a model not measured on this machine.
const MIN_CACHEABLE_TOKENS: ReadonlyArray<{ match: RegExp; min: number }> = [
  { match: /opus-5|fable-5|mythos-5/, min: 512 },
  { match: /opus-4[-.]8|sonnet-5|sonnet-4[-.]6|sonnet-4[-.]5|opus-4[-.]1|opus-4(?![-.\d])|sonnet-4(?![-.\d])/, min: 1024 },
  { match: /opus-4[-.]7|mythos-preview|3[-.]5-haiku|haiku-3[-.]5/, min: 2048 },
  { match: /opus-4[-.]6|opus-4[-.]5|haiku-4[-.]5/, min: 4096 },
]

/** The model's documented minimum cacheable prompt length, or undefined when we have no row for it.
 *  Undefined means "no claim" — never a default: a borrowed threshold would make BELOW_MIN_CACHEABLE
 *  fire on models whose real minimum is up to 8x away. */
export function minCacheableTokensFor(model: string): number | undefined {
  const m = model.toLowerCase()
  for (const row of MIN_CACHEABLE_TOKENS) if (row.match.test(m)) return row.min
  return undefined
}

// ── Environment / git-snapshot regions of the system prompt ──────────────────────
// Both live INSIDE one big system block (measured across the live spool, 2026-08-04: sys[2] for
// SDK/sub-agent requests, sys[3] for the CLI), so the positional block diff can only ever say "that
// block changed" and would file two documented causes under UNCLASSIFIED. Extracting the two regions
// by hand is what lets the classifier name them. POINTER-ONLY: only a hash of the region is kept —
// the cwd is an absolute home path and must never reach a report.
const ENV_SDK_RE = /<env>[\s\S]*?<\/env>/
// The CLI spelling has no closing delimiter; it runs to the next markdown heading of the prompt
// (`# Scratchpad Directory`, …). Anchored on the heading + its lead-in sentence so a stray
// "# Environment" inside quoted prose does not start a region.
const ENV_CLI_RE = /# Environment\nYou have been invoked in the following environment:[\s\S]*?(?=\n# |$)/

function extractEnvRegion(systemText: string): string {
  return ENV_SDK_RE.exec(systemText)?.[0] ?? ENV_CLI_RE.exec(systemText)?.[0] ?? ''
}

/** The git snapshot: from `gitStatus:` through the end of the `Recent commits:` list. It STOPS at the
 *  blank line that ends that list, because harness prose follows it in the CLI spelling and blaming a
 *  harness-upgrade wording change on "git state changed" would be a confident lie. */
function extractGitRegion(systemText: string): string {
  const start = systemText.indexOf('gitStatus:')
  if (start < 0) return ''
  const commits = systemText.indexOf('Recent commits:', start)
  // No commit list (a repo with no commits, or a truncated block): keep the region to the end rather
  // than guess a boundary — an over-wide region can only make the detector fire on prose that in
  // practice only changes with the harness, which is already visible as a model/metadata change.
  if (commits < 0) return systemText.slice(start)
  const end = systemText.indexOf('\n\n', commits)
  return end < 0 ? systemText.slice(start) : systemText.slice(start, end)
}

// ── Stable fingerprint + volatile normalization ──────────────────────────────────
// FNV-1a 32-bit — a cheap, dependency-free stable hash. We store this hash of a block's cache-relevant
// bytes, NEVER the bytes, so the prefix stays pointer-only. Two turns' blocks are "the same" iff their
// fingerprints match (which is exactly the cache's own byte-identity test, at hash granularity).
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// Strip the volatile bits (ISO dates, clock times, "Today's date is X", relative-time phrases) so two
// blocks that differ ONLY by a moving timestamp normalize to the same string — that is how a
// SYSTEM_TIMESTAMP break is told apart from a real content change (CLAUDE_MD_CHANGED etc.).
function normalizeVolatile(text: string): string {
  return text
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<TS>')
    .replace(/\d{4}-\d{2}-\d{2}/g, '<DATE>')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|am|pm)?\b/g, '<TIME>')
    .replace(/Today'?s date is[^\n.]*/gi, "Today's date is <DATE>")
    .replace(/\b\d+\s*(?:second|minute|hour|day|week|month|year)s?\s+ago\b/gi, '<AGO>')
}

// ── Content classification of an injected text block ──────────────────────────────
export type BlockContentKind =
  | 'claudemd' | 'rule' | 'memory' | 'agentmeta' | 'skillcatalog' | 'agentcatalog'
  | 'hook' | 'date' | 'execresult' | 'postcompact' | 'system' | 'usertext' | 'history' | 'attachment'

/** Exported for tests: it is a pure text→kind function, and the kinds it MISSES are exactly how a
 *  real perpetrator ends up filed as UNCLASSIFIED. */
export function classifyContentKind(text: string): BlockContentKind {
  if (/x-anthropic-billing-header|cc_version=|cc_entrypoint=/.test(text)) return 'agentmeta'
  if (/This session is being continued from a previous|conversation summary so far|compacted the (?:previous )?conversation|<compaction_summary|Analysis:[\s\S]{0,80}Summary:/i.test(text)) return 'postcompact'
  if (/Contents of .{0,300}CLAUDE\.md|^#\s*CLAUDE\.md/m.test(text)) return 'claudemd'
  if (/Contents of .{0,300}[/\\]\.claude[/\\]rules[/\\]/.test(text)) return 'rule'
  // The auto-memory file is injected into msg[0] exactly like CLAUDE.md and the rules, but its path
  // is neither `CLAUDE.md` nor under `.claude/rules/`, so it matched NEITHER matcher above and fell
  // through to 'usertext' → UNCLASSIFIED. That mattered here more than anywhere: a memory curator
  // rewrites these files while sessions are live, and each rewrite mutates msg[0] and re-writes the
  // whole prefix — 19% of all classified break tokens on this machine were sitting in UNCLASSIFIED
  // with the actor recorded only as "usertext block changed at pos 38: msg[0] user".
  // Verified against the real injected header:
  //   "Contents of …/memory/MEMORY.md (user's auto-memory, persists across conversations):"
  // Checked BEFORE 'hook' on purpose: a memory PAGE body can quote a hook marker like
  // "[janitor-memory]", and a real file injection must outrank a coincidental mention inside it.
  if (/Contents of .{0,300}[/\\]memory[/\\]|auto-memory, persists across conversations/.test(text)) return 'memory'
  if (/<local-command-stdout>|<command-output>|command-stdout|<function_results>/.test(text)) return 'execresult'
  if (/skills are available for use with the Skill tool|The following skills are available|Available skills:/.test(text)) return 'skillcatalog'
  if (/Available agent types|available agent types for the Agent tool|subagent_type/.test(text)) return 'agentcatalog'
  // Per-turn injections that land INSIDE user messages (not <system-reminder>-wrapped): the
  // UserPromptSubmit / PostToolUse hook context (<pss-skills>, [janitor-memory], …) and the harness
  // task-list nudge. These previously fell to 'usertext', hiding chronic per-turn mutators in
  // UNCLASSIFIED — naming them is the whole point of the perpetrator backtrace.
  // `PreToolUse:` was missing from this alternation and cost $2.84 in one turn: the harness moved
  // its token-spike warning into a standalone role:"system" message spliced mid-array
  // (2026-08-13T01:08:10Z, 453,881 tokens), the block classified as usertext, and the break landed
  // in UNCLASSIFIED with the actor unnamed. Match the header SHAPE (`<hookname> hook additional
  // context`), never the message content — a matcher keyed on "Token spike" goes blind the moment
  // the hook's wording changes, which is how this class of gap gets reintroduced.
  if (/<pss-skills>|\[janitor-memory\]|UserPromptSubmit hook additional context|(?:Pre|Post)ToolUse:\S* hook additional context|task tools haven't been used recently/i.test(text)) return 'hook'
  if (/<system-reminder>/.test(text) && /hook|inbox|heartbeat|reminder/i.test(text)) return 'hook'
  if (/Today'?s date is|# *currentDate|Current date:/.test(text)) return 'date'
  if (/<system-reminder>/.test(text)) return 'system'
  return 'usertext'
}

function causeForContentKind(kind: BlockContentKind): CacheBreakTimelineCause {
  switch (kind) {
    case 'claudemd': case 'rule': return 'CLAUDE_MD_CHANGED'
    case 'memory': return 'MEMORY_FILE_CHANGED'
    case 'agentmeta': case 'agentcatalog': return 'AGENT_METADATA_CHANGED'
    case 'skillcatalog': return 'SKILL_CHANGED'
    case 'hook': return 'HOOK_INJECTION'
    case 'date': return 'SYSTEM_TIMESTAMP'
    case 'execresult': return 'INLINE_EXEC_RESULT_CHANGED'
    case 'postcompact': return 'COMPACTION'
    case 'attachment': return 'ATTACHMENT_CHANGED'
    default: return 'UNCLASSIFIED'
  }
}

// Split one injected text block into classified SEGMENTS at "Contents of <path>" boundaries — Claude
// Code concatenates CLAUDE.md + every rule + memory + the skills list into ONE giant system-reminder,
// so segmenting lets the diff pinpoint the CLAUDE.md segment vs a rule vs the skills list vs a date,
// instead of blaming the whole mega-block. Fail-soft: a block with no boundary markers is one segment.
export interface Segment { kind: BlockContentKind; label: string; text: string }
/** Exported for tests and for offline forensics on real bodies: the SEGMENTATION is what decides
 *  which culprit a break can be pinned to, so a segment nothing classifies is how a real perpetrator
 *  ends up as UNCLASSIFIED (TRDD-00NOBU9W). */
export function segmentInjected(text: string, blockLabel: string): Segment[] {
  const boundary = /Contents of ([^\n(]+?\.[A-Za-z0-9_]+)/g
  const marks: { idx: number; label: string }[] = []
  let m: RegExpExecArray | null
  while ((m = boundary.exec(text)) !== null) marks.push({ idx: m.index, label: m[1].trim() })
  if (marks.length === 0) {
    const kind = classifyContentKind(text)
    return [{ kind, label: labelFor(kind, text, blockLabel), text }]
  }
  const segs: Segment[] = []
  // The leading region before the first "Contents of" (harness prose / billing header / date).
  if (marks[0].idx > 0) {
    const lead = text.slice(0, marks[0].idx)
    const kind = classifyContentKind(lead)
    segs.push({ kind, label: labelFor(kind, lead, blockLabel), text: lead })
  }
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].idx : text.length
    const body = text.slice(marks[i].idx, end)
    const kind = classifyContentKind(body)
    segs.push({ kind, label: marks[i].label, text: body })
  }
  return segs
}

function labelForKind(kind: BlockContentKind, fallback: string): string {
  switch (kind) {
    case 'agentmeta': return 'harness/billing header'
    case 'skillcatalog': return 'available-skills catalog'
    case 'agentcatalog': return 'agent-types catalog'
    case 'hook': return 'hook injection'
    case 'date': return 'system date/clock'
    case 'execresult': return 'inline command result'
    default: return fallback
  }
}

// BACKTRACE TO THE PERPETRATOR (the user's core ask): a HOOK_INJECTION break must name WHICH injector
// wrote the mutating block, not a generic "hook injection" — because the culprit is the hook/skill/
// harness process, not the transcript it perturbed. We identify it from a stable content signature and
// keep ONLY the short name (pointer-only — never the block text). This name flows into the block label →
// mkBlock's culpritId → the repeat-offender rollup, so two breaks from the SAME injector collapse into
// ONE chronic perpetrator ("pss-skills broke the cache on 40 turns").
function hookSignature(text: string): string | null {
  if (/<pss-skills>/.test(text)) return 'pss-skills (perfect-skill-suggester)'
  if (/\[janitor-memory\]/.test(text)) return 'janitor-memory recall'
  if (/\[janitor-heartbeat\]/.test(text)) return 'janitor-heartbeat'
  if (/task tools haven't been used recently/i.test(text)) return 'harness task-list reminder'
  if (/UserPromptSubmit hook additional context/.test(text)) return 'UserPromptSubmit injection'
  if (/PostToolUse:\S* hook additional context/.test(text)) return 'PostToolUse injection'
  if (/token-guard|hard budget|token budget still exceeded/i.test(text)) return 'token-guard'
  if (/Context window:\s*\d|pre-tool-context-usage|context watchdog/i.test(text)) return 'context-usage watchdog'
  if (/post-mcp-sanitizer|prompt-injection shape/i.test(text)) return 'mcp-sanitizer'
  if (/AI Maestro|inbox notification|unread messages/i.test(text)) return 'ai-maestro inbox'
  if (/spyglass/i.test(text)) return 'spyglass'
  if (/worktree|task-notification/i.test(text)) return 'worktree/task notifier'
  return null
}

// Resolve the label for an injected segment, preferring the specific injector name for hook/system
// blocks so the backtrace points at the perpetrator, falling back to the generic per-kind label.
function labelFor(kind: BlockContentKind, text: string, fallback: string): string {
  if (kind === 'hook' || kind === 'system') {
    const sig = hookSignature(text)
    if (sig) return `hook: ${sig}`
  }
  return labelForKind(kind, fallback)
}

// The built-in tools the harness defer-loads and toggles via ToolSearch (AskUserQuestion/Cron*/Task*/
// Web*/…). When a cache break's changed tool set is entirely within this set, the perpetrator is the
// harness ToolSearch mechanism churning its deferred built-ins — NOT the user's own MCP/tool config —
// so we attribute it to a single stable actor instead of the volatile add/remove list.
const DEFERRED_BUILTINS = new Set<string>([
  'AskUserQuestion', 'CronCreate', 'CronDelete', 'CronList', 'SendMessage',
  'TaskCreate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop', 'TaskUpdate',
  'WebFetch', 'WebSearch', 'NotebookEdit', 'LSP', 'Monitor', 'PushNotification',
  'RemoteTrigger', 'DesignSync', 'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree',
  'ExitWorktree', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool', 'ListMcpResourcesTool',
])

// Extract the distinct MCP server names from tool names of the form mcp__<server>__<tool>, so an
// MCP_TOOLS_CHANGED break backtraces to the SERVER that connected/disconnected (chrome-devtools,
// lean-ctx, agentlens, …) rather than to the individual tools it carried.
function mcpServersOf(names: string[]): string[] {
  const s = new Set<string>()
  for (const n of names) { const m = /^mcp__(.+?)__/.exec(n); if (m) s.add(m[1]) }
  return [...s].sort()
}

// ── Turn prefix (compact, pointer-only) ──────────────────────────────────────────
export interface PrefixTool { name: string; deferred: boolean; isMcp: boolean; fp: string }
export interface PrefixBlock {
  layer: 'system' | 'message'
  kind: BlockContentKind
  label: string
  fp: string        // fingerprint of the raw bytes (byte identity, hashed)
  norm: string      // fingerprint of the timestamp-normalized bytes (for SYSTEM_TIMESTAMP detection)
  len: number       // char length (SKILL_DESCRIPTION_TRUNCATION shrink detection)
  tokensApprox: number
}
export interface TurnPrefix {
  model: string
  // Request parameters rendered into the prompt. Kept SEPARATE (they were one blended `effort`
  // signature until TRDD-B9ERTBZ9) because the docs give each a different blast radius and a
  // different remedy, and a blended signature could only ever report the generic EFFORT_SWITCH.
  // '' means the parameter was ABSENT — which is NOT the same as any explicit value, see
  // classifyCacheBreak step 3.
  thinking: string      // body.thinking
  effortParam: string   // body.output_config.effort
  toolChoice: string    // body.tool_choice
  speed: string         // body.speed (fast mode) — the residual, no specific cause of its own
  // The environment / git-snapshot regions of the system prompt, hashed. `norm` is the same region
  // with timestamps normalized away, so a region that differs ONLY by a clock is left to the block
  // diff (which names SYSTEM_TIMESTAMP) instead of being blamed on a directory change.
  envFp: string; envNorm: string
  gitFp: string; gitNorm: string
  // Whole-request signals for the no-cache-activity diagnosis (CACHING_DISABLED/BELOW_MIN_CACHEABLE).
  hasCacheControl: boolean
  promptTokensApprox: number   // estimated, over EVERY message + system + tools (not just the prefix)
  messageCount: number         // messages.length — the conservative unit for the 20-block lookback
  tools: PrefixTool[]
  systemBlocks: PrefixBlock[]
  messageBlocks: PrefixBlock[]  // cached message-prefix injected blocks (up to the last message cache_control)
}

interface RawBlockLike { type?: string; text?: string; cache_control?: unknown; content?: unknown; source?: unknown }
interface RawMessageLike { role?: string; content?: string | RawBlockLike[] }
interface RawSystemLike { type?: string; text?: string; cache_control?: unknown }
interface RawToolLike { name?: string; description?: string; input_schema?: unknown; defer_loading?: unknown; cache_control?: unknown }
export interface RawRequestForBreak {
  model?: unknown
  thinking?: unknown
  speed?: unknown
  /** Present on EVERY request sampled from the live spool (`{"effort":"high"|"xhigh"|…}`), and
   *  invisible to the classifier until TRDD-B9ERTBZ9 — an effort change simply landed in UNCLASSIFIED. */
  output_config?: unknown
  tool_choice?: unknown
  system?: string | RawSystemLike[]
  tools?: RawToolLike[]
  messages?: RawMessageLike[]
  metadata?: { user_id?: unknown }
  diagnostics?: { previous_message_id?: unknown }
}

/** A stable signature for one request parameter. Returns '' for ABSENT — the distinction is
 *  load-bearing: the docs say "setting a parameter explicitly to its default value is equivalent to
 *  omitting it", so absent↔present cannot be judged without a per-model defaults table that no
 *  documentation page provides. Only two different EXPLICIT values are decidable. */
function paramSignature(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'object') {
    const o = v as { type?: unknown; budget_tokens?: unknown; name?: unknown }
    // thinking / tool_choice both key on `type` (+ budget / tool name) — stringify those explicitly
    // so key-order churn in the raw JSON can never read as a parameter change.
    if (typeof o.type === 'string') {
      const extra = typeof o.budget_tokens === 'number' ? `:${o.budget_tokens}` : typeof o.name === 'string' ? `:${o.name}` : ''
      return `${o.type}${extra}`
    }
    return JSON.stringify(v)
  }
  return String(v)
}

function effortParamOf(body: RawRequestForBreak): string {
  const oc = body.output_config
  if (!oc || typeof oc !== 'object') return ''
  const e = (oc as { effort?: unknown }).effort
  return typeof e === 'string' ? e : ''
}

function toPrefixBlock(layer: 'system' | 'message', kind: BlockContentKind, label: string, text: string): PrefixBlock {
  return {
    layer, kind, label,
    fp: fnv1a(text),
    norm: fnv1a(normalizeVolatile(text)),
    len: text.length,
    tokensApprox: estimateTokensFromBytes(Buffer.byteLength(text)),
  }
}

// Non-text blocks (images, tool_use inputs) were previously SKIPPED from the prefix, so a change there
// was an invisible prefix mutation landing in UNCLASSIFIED. Fingerprint them by type+name+SIZE only —
// pointer-only (never the input JSON or base64 bytes) — so the diff can name ATTACHMENT_CHANGED.
function attachmentPrefixBlock(b: RawBlockLike & { name?: string; input?: unknown }, msgIndex: number): PrefixBlock | null {
  if (b.type !== 'tool_use' && b.type !== 'image') return null
  const name = typeof b.name === 'string' ? b.name : '?'
  const imgLen = typeof (b.source as { data?: string } | undefined)?.data === 'string'
    ? (b.source as { data: string }).data.length : 0
  const sig = b.type === 'tool_use' ? `tool_use:${name}:${JSON.stringify(b.input ?? {}).length}` : `image:${imgLen}`
  return {
    layer: 'message', kind: 'attachment',
    label: `msg[${msgIndex}] ${b.type}${b.type === 'tool_use' ? ' ' + name : ''}`,
    fp: fnv1a(sig), norm: fnv1a(sig), len: sig.length, tokensApprox: 0,
  }
}

// Flatten the injected TEXT of a message content block (string, {type:text}, tool_result text). We
// deliberately ignore tool_use inputs and base64 image data — the former is stable history, the latter
// is never touched (pointer-only). Returns '' for a non-text block (skipped from the diff).
/** The BYTE length of what messageBlockText would return, without building the string. The prompt
 *  total is needed for EVERY message of EVERY scanned body, and materializing a whole conversation's
 *  tool_result text per body — for one integer — measurably slowed the bounded scan. */
function messageBlockTextBytes(b: RawBlockLike): number {
  if (b.type === 'text' && typeof b.text === 'string') return Buffer.byteLength(b.text)
  if (b.type === 'tool_result') {
    const c = b.content
    if (typeof c === 'string') return Buffer.byteLength(c)
    if (Array.isArray(c)) {
      let n = 0
      for (const x of c) {
        const t = x && typeof x === 'object' ? (x as { text?: string }).text : undefined
        n += (typeof t === 'string' ? Buffer.byteLength(t) : 0) + 1   // +1 for the '\n' the join adds
      }
      return n > 0 ? n - 1 : 0
    }
  }
  return 0
}

function messageBlockText(b: RawBlockLike): string {
  if (b.type === 'text' && typeof b.text === 'string') return b.text
  if (b.type === 'tool_result') {
    const c = b.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return c.map(x => (x && typeof x === 'object' && (x as { text?: string }).text) || '').join('\n')
  }
  return ''
}

/** Parse a raw request body into a compact, pointer-only TurnPrefix. The cached prefix = the whole
 *  tools array + the whole system array + the message blocks up to and including the LAST message-level
 *  cache_control breakpoint (everything after that is the volatile current-turn tail, expected to
 *  change — excluded from the break diff). Returns null for a body with no model (unparseable). */
export function extractTurnPrefix(body: RawRequestForBreak | null): TurnPrefix | null {
  if (!body || typeof body !== 'object') return null
  const model = typeof body.model === 'string' ? body.model : ''

  // Whole-request counters for the no-cache-activity diagnosis (CACHING_DISABLED /
  // BELOW_MIN_CACHEABLE). Accumulated during the passes we already make — a separate walk would
  // re-traverse a multi-MB body for two integers.
  let ccMarkers = 0
  let promptBytes = 0

  const tools: PrefixTool[] = (Array.isArray(body.tools) ? body.tools : []).map(t => {
    const name = typeof t.name === 'string' ? t.name : '?'
    // NUL (U+0000) as the fingerprint field separator (no description/schema can contain it) —
    // ALWAYS spelled as the escape, never a raw 0x00 byte: a raw NUL in the source makes
    // grep/file/diff classify this whole file as binary (bitten 2026-07-16). Same for the
    // order-sensitive joins in diffTools below.
    const defBytes = `${typeof t.description === 'string' ? t.description : ''}\u0000${JSON.stringify(t.input_schema ?? {})}`
    promptBytes += Buffer.byteLength(defBytes)
    if (t.cache_control) ccMarkers += 1
    return { name, deferred: t.defer_loading === true, isMcp: name.startsWith('mcp__'), fp: fnv1a(defBytes) }
  })

  const systemBlocks: PrefixBlock[] = []
  const systemTexts: string[] = []
  if (typeof body.system === 'string' && body.system) {
    systemTexts.push(body.system)
    promptBytes += Buffer.byteLength(body.system)
    for (const seg of segmentInjected(body.system, 'system prompt')) {
      systemBlocks.push(toPrefixBlock('system', seg.kind, seg.label, seg.text))
    }
  } else if (Array.isArray(body.system)) {
    body.system.forEach((s, i) => {
      if (s?.cache_control) ccMarkers += 1
      const text = typeof s?.text === 'string' ? s.text : ''
      if (!text) return
      systemTexts.push(text)
      promptBytes += Buffer.byteLength(text)
      for (const seg of segmentInjected(text, `system[${i}]`)) {
        systemBlocks.push(toPrefixBlock('system', seg.kind, seg.label, seg.text))
      }
    })
  }

  // Message cached prefix: find the LAST message index that carries (or whose content carries) a
  // cache_control marker — the cache breakpoint. Everything up to and including it is cached prefix.
  // The SAME pass totals the prompt over EVERY message, not just the prefix: a request whose only
  // breakpoint sits in system[] has an EMPTY message prefix, and sizing the prompt from that would
  // report ~0 tokens for a huge conversation and fire BELOW_MIN_CACHEABLE on it.
  const messages = Array.isArray(body.messages) ? body.messages : []
  let lastBreakpoint = -1
  messages.forEach((mm, i) => {
    const c = mm?.content
    if (typeof c === 'string') { promptBytes += Buffer.byteLength(c); return }
    if (!Array.isArray(c)) return
    let hasCC = false
    for (const b of c) {
      if (!b || typeof b !== 'object') continue
      const rb = b as RawBlockLike
      if (rb.cache_control) { hasCC = true; ccMarkers += 1 }
      promptBytes += messageBlockTextBytes(rb)
    }
    if (hasCC) lastBreakpoint = i
  })
  const messageBlocks: PrefixBlock[] = []
  const upTo = lastBreakpoint >= 0 ? lastBreakpoint : -1
  for (let i = 0; i <= upTo; i++) {
    const mm = messages[i]
    const content = mm?.content
    if (typeof content === 'string') {
      if (!content) continue
      for (const seg of segmentInjected(content, `msg[${i}] ${mm?.role ?? ''}`)) {
        // Plain conversation history rarely carries injected markers → 'usertext' segments are stable
        // history; keep them so a genuine reorder/compaction is still visible, but they classify as
        // UNCLASSIFIED (never falsely blamed for a specific cause).
        messageBlocks.push(toPrefixBlock('message', seg.kind, seg.label, seg.text))
      }
      continue
    }
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (!b || typeof b !== 'object') continue
      const text = messageBlockText(b as RawBlockLike)
      if (!text) {
        const att = attachmentPrefixBlock(b as RawBlockLike, i)
        if (att) messageBlocks.push(att)
        continue
      }
      for (const seg of segmentInjected(text, `msg[${i}] ${mm?.role ?? ''}`)) {
        messageBlocks.push(toPrefixBlock('message', seg.kind, seg.label, seg.text))
      }
    }
  }

  const systemText = systemTexts.join('\n')
  const envRegion = extractEnvRegion(systemText)
  const gitRegion = extractGitRegion(systemText)

  return {
    model,
    thinking: paramSignature(body.thinking),
    effortParam: effortParamOf(body),
    toolChoice: paramSignature(body.tool_choice),
    speed: paramSignature(body.speed),
    envFp: envRegion ? fnv1a(envRegion) : '',
    envNorm: envRegion ? fnv1a(normalizeVolatile(envRegion)) : '',
    gitFp: gitRegion ? fnv1a(gitRegion) : '',
    gitNorm: gitRegion ? fnv1a(normalizeVolatile(gitRegion)) : '',
    hasCacheControl: ccMarkers > 0,
    promptTokensApprox: estimateTokensFromBytes(promptBytes),
    messageCount: messages.length,
    tools, systemBlocks, messageBlocks,
  }
}

// ── The classifier ───────────────────────────────────────────────────────────────
export interface CacheBreakVerdict {
  cause: CacheBreakTimelineCause
  culpritLayer: 'model' | 'effort' | 'tools' | 'system' | 'message' | 'timing'
  culpritId: string          // STABLE identity of the offending element (grouping key for repeat-offenders)
  culpritSummary: string     // pointer-only, human-readable — never full content
  ttlTier?: TtlTier
  rawDiffSummary?: string     // attached only for UNCLASSIFIED
  confidence?: 'high' | 'medium' // set for PLUGINS_RELOADED: high = 3 catalogs churned, medium = 2
}

export interface BreakTiming {
  gapMs?: number
  cacheReadTokens: number
  cacheCreateTokens: number
  ephemeral5mTokens: number
  ephemeral1hTokens: number
  /** Blocks appended since the last turn that actually WROTE to the cache — the distance the 20-block
   *  lookback window has to cover. Undefined when no write has been observed yet in this stream.
   *  Counted in MESSAGES, which is the conservative unit: a message contributes at least one content
   *  block, so "≥20 messages" guarantees "≥20 blocks" and the detector can only fire LATE, never early. */
  blocksAddedSinceLastWrite?: number
}

const FIVE_MIN = 5 * 60_000
const ONE_HOUR = 60 * 60_000
/** "The lookback window is 20 blocks. The system checks at most 20 positions per breakpoint, counting
 *  the breakpoint itself as the first." — API prompt-caching docs, quoted in
 *  reports/cache-invalidation-research/20260804_142700+0200-prompt-caching-docs.md (A-13). */
const LOOKBACK_WINDOW_BLOCKS = 20

// Diff the tools layer: added/removed by set, then order, then per-tool definition change. Returns the
// most-specific tools cause, or null when the tool catalog is byte-identical.
function diffTools(prev: TurnPrefix, cur: TurnPrefix): CacheBreakVerdict | null {
  const prevNames = prev.tools.map(t => t.name)
  const curNames = cur.tools.map(t => t.name)
  const prevSet = new Set(prevNames)
  const curSet = new Set(curNames)
  const added = curNames.filter(n => !prevSet.has(n))
  const removed = prevNames.filter(n => !curSet.has(n))
  if (added.length || removed.length) {
    const changed = [...added, ...removed]
    // A newly-present DEFERRED tool (and no removals) = tool-search deferred loading — the most specific.
    const addedDeferred = added.filter(n => cur.tools.find(t => t.name === n)?.deferred)
    if (added.length > 0 && removed.length === 0 && addedDeferred.length === added.length) {
      return mkTools('TOOL_SEARCH_DEFERRED', added, `deferred tool(s) loaded mid-session: ${fmtList(added)}`)
    }
    // All changed tools are MCP — an MCP server / plugin toggled. Backtrace to the SERVER(s) so the
    // culpritId groups by the connecting/disconnecting server, not the individual tool churn.
    if (changed.every(n => n.startsWith('mcp__'))) {
      const servers = mcpServersOf(changed)
      const srvTag = servers.length ? ` [server: ${fmtList(servers)}]` : ''
      return mkTools('MCP_TOOLS_CHANGED', servers.length ? servers : changed,
        `MCP tool(s) ${added.length ? 'added ' + fmtList(added) : ''}${removed.length ? ' removed ' + fmtList(removed) : ''}${srvTag}`.trim())
    }
    // The changed set is entirely harness deferred built-ins (AskUserQuestion/Cron*/Task*/…) → the
    // perpetrator is the harness ToolSearch mechanism toggling its deferred set, attributed to ONE
    // stable actor so the repeat-offender rollup names the harness, not the volatile add/remove list.
    if (changed.every(n => DEFERRED_BUILTINS.has(n))) {
      return mkTools('TOOL_SEARCH_DEFERRED', ['harness:deferred-builtins'],
        `harness ToolSearch toggled deferred built-ins (${changed.length}): ${fmtList(changed)}`)
    }
    return mkTools('TOOLSET_CHANGED', changed, `tool(s) ${added.length ? 'added ' + fmtList(added) : ''}${removed.length ? ' removed ' + fmtList(removed) : ''}`.trim())
  }
  // Same set: order change?
  if (curNames.join('\u0000') !== prevNames.join('\u0000')) {
    const firstMoved = curNames.find((n, i) => prevNames[i] !== n) ?? curNames[0]
    return mkTools('TOOLS_REORDERED', [firstMoved], `same ${curNames.length} tools, order changed (first at "${firstMoved}")`)
  }
  // Same set + order: a tool DEFINITION (description/schema) changed?
  for (const t of cur.tools) {
    const p = prev.tools.find(x => x.name === t.name)
    if (p && p.fp !== t.fp) return mkTools('TOOLSET_CHANGED', [t.name], `tool definition changed: ${t.name}`)
  }
  return null
}

function mkTools(cause: CacheBreakTimelineCause, names: string[], summary: string): CacheBreakVerdict {
  return { cause, culpritLayer: 'tools', culpritId: `tools:${cause}:${names.slice(0, 3).sort().join(',')}`, culpritSummary: summary }
}
function fmtList(xs: string[]): string { return xs.length <= 3 ? xs.join(', ') : `${xs.slice(0, 3).join(', ')} +${xs.length - 3} more` }

// Did the blocks of ONE content kind (e.g. skillcatalog, agentcatalog) change between two turns? Set
// diff by fingerprint — a plugin reload re-registers a whole catalog, so its fp-set shifts. Used only
// by the cross-layer plugin-reload detector below. (TRDD-EYA3X5MQ)
function catalogKindChurned(prev: PrefixBlock[], cur: PrefixBlock[], kind: BlockContentKind): boolean {
  const fps = (bs: PrefixBlock[]) => bs.filter(b => b.kind === kind).map(b => b.fp).sort().join('|')
  return fps(prev) !== fps(cur)
}

// Diff a block layer POSITIONALLY — the prompt cache breaks at the first differing BYTE position, so
// the first differing block POSITION in the cached prefix is the true break point. This is what makes
// normal conversation GROWTH not a false break: appended blocks beyond the previous prefix's length are
// ignored (that's the one-time cache_creation of new content, expected); only a change/removal/reorder
// WITHIN the previously-cached common prefix is an avoidable break. Returns the classified verdict, or
// null when cur is a byte-identical extension of prev (pure growth).
function diffBlocks(prevBlocksRaw: PrefixBlock[], curBlocksRaw: PrefixBlock[], layer: 'system' | 'message'): CacheBreakVerdict | null {
  // Drop cache-transparent blocks BEFORE the positional diff. The harness billing header
  // (kind 'agentmeta' — the leading `cc_prev_req` block at system pos 0) changes on EVERY turn but is
  // EXCLUDED from Anthropic's prompt-cache key. Proven empirically: were it in the key, every turn
  // would rewrite the whole ~context-size prefix as cache_creation (it always changes), yet long
  // sessions measure >95% cache_read. So a divergence there is NOT a real break — comparing it would
  // pin every idle-TTL / message-prefix / sub-agent break on a constant ("billing header"), the exact
  // false-SYSTEMATIC verdict this masks. Skipping it lets the classifier fall through to the true
  // culprit (or to the TTL-timing check when the cache-relevant prefix is byte-identical).
  // NOTE: 'agentcatalog' (the agent-types list) is a DIFFERENT kind and IS cache-relevant — not dropped.
  const prevBlocks = prevBlocksRaw.filter(b => b.kind !== 'agentmeta')
  const curBlocks = curBlocksRaw.filter(b => b.kind !== 'agentmeta')
  const prevFps = new Set(prevBlocks.map(b => b.fp))
  const curFps = new Set(curBlocks.map(b => b.fp))
  const prevKinds = new Set(prevBlocks.map(b => b.kind))
  const n = Math.min(prevBlocks.length, curBlocks.length)
  for (let i = 0; i < n; i++) {
    const p = prevBlocks[i], c = curBlocks[i]
    if (p.fp === c.fp) continue
    // First divergence at position i. Classify most-specific-first.
    if (c.kind === 'postcompact' || p.kind === 'postcompact') return mkBlock('COMPACTION', layer, c, `conversation compaction rebuilt the ${layer} prefix at ${c.label}`)
    if (p.norm === c.norm) return mkBlock('SYSTEM_TIMESTAMP', layer, c, `moving date/clock in ${c.label}`)
    // msg[0] carries the CONVERSATION'S IDENTITY, and its `usertext` segment is the caller's own
    // opening words — which are immutable within one conversation. So a divergence THERE does not
    // mean a block changed; it means these two requests are different conversations that happen to
    // share a session id, which is the norm for sub-agents (their calls carry the PARENT's id).
    // Nothing broke: each stream keeps its own cache entry.
    //
    // Measured over 2,003 consecutive real turn-pairs (TRDD-00NOBU9W): 397 diverge first exactly
    // here, and every sampled one is a different sub-agent TASK PROMPT ("You are doing a CODE
    // REVIEW of…", "You are auditing source files…"). They were landing in UNCLASSIFIED, which then
    // ranked as the "Dominant AVOIDABLE perpetrator" at 23.2% — a report telling the operator to go
    // fix something that never happened. The existing A→B→A signature cannot catch them: it keys on
    // model + tool catalog, and two sub-agents of the same type share both.
    //
    // The KIND is the load-bearing part of the test. The harness injects CLAUDE.md, the rules and the
    // memory index INTO msg[0], and those DO change mid-conversation — a memory rewrite alone was 19%
    // of classified break tokens on this machine. Those segments carry their own kinds
    // (claudemd/rule/memory/skillcatalog/hook/date), so requiring `usertext` on BOTH sides leaves
    // every one of them exactly where it was. A compaction rewrite of msg[0] is `postcompact` and was
    // already claimed above.
    if (layer === 'message' && c.label.startsWith('msg[0]') && c.kind === 'usertext' && p.kind === 'usertext') {
      return { cause: 'SUBAGENT_INTERLEAVE', culpritLayer: 'message', culpritId: 'interleave:root-differs',
        culpritSummary: 'msg[0]\'s own prompt text differs — these two requests are DIFFERENT conversations sharing one session id (a sub-agent\'s calls carry the parent\'s session id), so neither one broke the other\'s cache' }
    }
    // Same content, different position (this block existed earlier in prev, and prev's block still
    // exists later in cur) → a pure reorder, not a content change.
    if (prevFps.has(c.fp) && curFps.has(p.fp)) {
      return { cause: 'CONTEXT_ORDER_CHANGED', culpritLayer: layer, culpritId: `${layer}:order`, culpritSummary: `${layer} blocks reordered at ${c.label} (identical content, different order)` }
    }
    // Skill-catalog specifics: a block whose kind prev never carried = a fresh injection; a shrink =
    // a truncation; otherwise a content change. Deliberately BEFORE the generic insertion detector —
    // a spliced-in skill catalog is still SKILL_INJECTION (the more specific verdict), and running
    // the generic branch first demoted it to SKILL_CHANGED, which an existing test caught.
    if (c.kind === 'skillcatalog') {
      if (!prevKinds.has('skillcatalog')) return mkBlock('SKILL_INJECTION', layer, c, `skill catalog injected at pos ${i}: ${c.label}`)
      if (p.kind === 'skillcatalog' && c.len < p.len * 0.9) return mkBlock('SKILL_DESCRIPTION_TRUNCATION', layer, c, `skill catalog shrank ${p.len}→${c.len} chars: ${c.label}`)
    }
    // An INSERTION, not a change: something was spliced in front of prev's block here, shifting it
    // down. Measured incident (2026-08-13T01:08:10Z, 453,881 tokens): the harness spliced a
    // standalone role:"system" hook message into the middle of `messages`, shifting every later
    // message +1. Reporting that as "<kind> block changed" misattributes the break to the SHIFTED
    // bystander and — whenever the spliced content matches no kind matcher — manufactures an
    // UNCLASSIFIED with the real actor unnamed.
    //
    // TWO conditions, both load-bearing (review finding 8 killed the set-membership version): the
    // count guard, because an insertion GROWS the block list while an in-place rewrite keeps it —
    // and prevFps/curFps are content-only sets that collapse duplicates, so a rewrite of X→Y with a
    // byte-identical copy of X elsewhere satisfied the old test and reported a splice for a turn
    // where nothing shifted; and the POSITIONAL lookahead, because "the very next cur block is
    // exactly prev's block at this position" is the shift itself, not an inference from membership.
    if (curBlocks.length > prevBlocks.length && curBlocks[i + 1]?.fp === p.fp) {
      const inserted = causeForContentKind(c.kind)
      // A recognised kind keeps its own cause (the ACTOR is named: hook, memory, …); content no
      // matcher knows still gets the STRUCTURE named — MESSAGE_SPLICED, never UNCLASSIFIED, and
      // never CONTEXT_ORDER_CHANGED, whose "identical content" claim would be false here.
      return mkBlock(inserted === 'UNCLASSIFIED' ? 'MESSAGE_SPLICED' : inserted, layer, c,
        `${c.kind} block spliced in at pos ${i}: ${c.label} — later ${layer} blocks shifted, invalidating everything after the splice point`)
    }
    // The mirror image (review finding 9): prev's block here was REMOVED, shifting cur's up —
    // cur[i] is exactly prev[i+1]. Without this branch a mid-array trim fell to the generic
    // "changed" verdict blaming the shifted bystander; MESSAGE_TRIMMED's tail-shrink handler below
    // never fires for it because the common-prefix walk diverges first. The culprit is the REMOVED
    // block (p), never c — c is untouched content that merely moved.
    if (curBlocks.length < prevBlocks.length && prevBlocks[i + 1]?.fp === c.fp) {
      return mkBlock('MESSAGE_TRIMMED', layer, p,
        `${p.kind} block removed at pos ${i}: ${p.label} — later ${layer} blocks shifted up (context-editing/trim), invalidating everything after the removal point`)
    }
    const changed = causeForContentKind(c.kind)
    return mkBlock(changed, layer, c, `${c.kind} block changed at pos ${i}: ${c.label}`)
  }
  // No divergence within the common prefix.
  if (prevBlocks.length > curBlocks.length) {
    // The cached prefix SHRANK — a block that was cached got dropped (compaction or removal).
    const dropped = prevBlocks[curBlocks.length]
    if (dropped.kind === 'postcompact') return mkBlock('COMPACTION', layer, dropped, `compaction dropped ${layer} blocks from ${dropped.label}`)
    if (dropped.kind === 'skillcatalog') return mkBlock('SKILL_CHANGED', layer, dropped, `skill catalog removed from the ${layer} prefix: ${dropped.label}`)
    // A plain conversation/tool block dropped from the MESSAGE prefix = harness context-editing /
    // tool-result clearing / message deletion — a named cause, not UNCLASSIFIED: the removal point
    // invalidates everything after it, which is exactly the "trim a huge transcript mid-session" cost.
    if (layer === 'message' && (dropped.kind === 'usertext' || dropped.kind === 'history' || dropped.kind === 'attachment' || dropped.kind === 'execresult')) {
      return mkBlock('MESSAGE_TRIMMED', layer, dropped, `${dropped.kind} block removed from the message prefix (context-editing/trim): ${dropped.label}`)
    }
    return mkBlock(causeForContentKind(dropped.kind), layer, dropped, `${dropped.kind} block removed from the ${layer} prefix: ${dropped.label}`)
  }
  // cur is longer (pure append growth) or identical — NOT an avoidable break.
  return null
}

/** The two causes that are NOT a break at all but a turn that was never cached in the first place —
 *  both counters 0. Returns null the moment there is ANY cache activity, so it can never displace a
 *  real break verdict. Shared by classifyCacheBreak (which names the cause) and classifyTurns (which
 *  uses it to admit such a turn past the cache_creation floor — a 0-token turn is invisible to a
 *  floor written for cache WRITES, yet "this call is never cached" is exactly what the operator needs
 *  to see: it pays the full input rate on every single call). */
function diagnoseNoCacheActivity(cur: TurnPrefix, timing: BreakTiming): CacheBreakVerdict | null {
  if (timing.cacheCreateTokens !== 0 || timing.cacheReadTokens !== 0) return null
  // No marker anywhere ⇒ nothing was ever offered to the cache. Checked FIRST: such a request is
  // often also below the minimum, but "the prompt was too small" would name a condition that never
  // got the chance to apply.
  if (!cur.hasCacheControl) {
    return { cause: 'CACHING_DISABLED', culpritLayer: 'timing', culpritId: 'config:no-cache-control',
      culpritSummary: 'the request carried no cache_control marker anywhere — nothing was offered to the cache', ttlTier: 'none' }
  }
  // Markers present and STILL nothing cached: the documented silent failure. The counters are the
  // load-bearing evidence (the harness asked for caching and got none); the size check is
  // corroboration, and it is skipped entirely for a model we have no documented minimum for.
  const min = minCacheableTokensFor(cur.model)
  if (min !== undefined && cur.promptTokensApprox < min) {
    return { cause: 'BELOW_MIN_CACHEABLE', culpritLayer: 'timing', culpritId: `config:below-min:${cur.model || '?'}`,
      culpritSummary: `cache_control present but nothing cached: ~${cur.promptTokensApprox.toLocaleString()} est. tokens is under this model's ${min.toLocaleString()}-token minimum`, ttlTier: 'none' }
  }
  return null
}

function mkBlock(cause: CacheBreakTimelineCause, layer: 'system' | 'message', b: PrefixBlock, summary: string): CacheBreakVerdict {
  return { cause, culpritLayer: layer, culpritId: `${layer}:${cause}:${b.kind}:${b.label.slice(0, 48)}`, culpritSummary: summary }
}

/** Classify ONE turn's cache_creation into a root cause by diffing its prefix against the previous
 *  turn's, in the docs hierarchy order (model → tools → effort → system → message-prefix). A structural
 *  prefix change ALWAYS beats a timing gap — the change is the real culprit. When the prefix is
 *  byte-identical, the break is timing (TTL expiry / cold start). */
export function classifyCacheBreak(prev: TurnPrefix | null, cur: TurnPrefix, timing: BreakTiming, prev2?: TurnPrefix | null): CacheBreakVerdict {
  // -1. NO cache activity at all (both counters 0). Checked before everything, including the
  //     first-turn guard: calling a turn that was never eligible for caching a "cold warm" names a
  //     cache event that did not happen. Measured on the live spool: 4 of 1,377 requests carry no
  //     cache_control marker and 4 of 1,355 responses report 0/0 — same model, same count.
  //     (That measurement predates CC 2.1.221, which moved auto-mode permission checks onto the
  //     cached conversation prefix — expect this population to shrink, not grow; TRDD-0YG37FXM.)
  const noActivity = diagnoseNoCacheActivity(cur, timing)
  if (noActivity) return noActivity
  if (!prev) {
    return { cause: 'COLD_START', culpritLayer: 'timing', culpritId: 'timing:COLD_START', culpritSummary: 'first observed turn for this session (cold cache warm)', ttlTier: 'none' }
  }
  // 0. Sub-agent INTERLEAVE artifact — checked BEFORE model/tools, because it explains both. Sub-agent
  //    API calls carry the PARENT's session_id, so the mtime-ordered "turn" sequence can alternate
  //    between two independent streams (parent A, child B): the diff then sees A→B→A "model switches"
  //    and 15-tools-removed-then-re-added-in-3ms "toolset churn" that never happened — each stream keeps
  //    its OWN cache. Signature: this turn matches turn-2's stream (model + tool catalog byte-identical)
  //    while differing from turn-1. Without this check those artifacts pollute MODEL_SWITCH and
  //    TOOLSET_CHANGED and make the avoidable-cause ranking dishonest.
  if (prev2) {
    const streamFp = (p: TurnPrefix) => `${p.model}|${p.tools.map(t => `${t.name}:${t.fp}`).join(' ')}`
    const differsFromPrev = prev.model !== cur.model || streamFp(prev) !== streamFp(cur)
    if (differsFromPrev && streamFp(cur) === streamFp(prev2)) {
      const pair = [prev.model || '?', cur.model || '?'].sort().join(' <-> ')
      return { cause: 'SUBAGENT_INTERLEAVE', culpritLayer: 'timing', culpritId: `interleave:${pair}`, culpritSummary: `A→B→A interleave (${pair}): this request matches turn-2's stream, not turn-1's — a sub-agent's calls share the parent session id`, ttlTier: 'none' }
    }
  }
  // 1. Model — model-specific cache, invalidates everything.
  if (prev.model !== cur.model) {
    return { cause: 'MODEL_SWITCH', culpritLayer: 'model', culpritId: 'model', culpritSummary: `model ${prev.model || '?'} → ${cur.model || '?'}` }
  }
  // 2. Tools — invalidates tools + system + messages (higher than effort, which keeps tools cached).
  const toolsV = diffTools(prev, cur)
  // 2a. Plugin reload — /reload-plugins re-registers the tool + skill + agent catalogs TOGETHER, so it
  //     churns multiple layers at once (tools layer + system skillcatalog/agentcatalog blocks). The
  //     per-layer classifier would name only the first (usually TOOLSET_CHANGED) and hide the reload —
  //     the machine's #1 cache-break cost. Detect the ≥2-catalog co-churn signature FIRST and name it.
  //     Confidence: high = all 3 churned, medium = 2. (TRDD-EYA3X5MQ)
  // Require each catalog to have EXISTED in prev (a reload RE-registers established catalogs; a
  // first-appearance is session warmup, not a reload).
  const prevSysKinds = new Set(prev.systemBlocks.map(b => b.kind))
  const skillChurned = prevSysKinds.has('skillcatalog') && catalogKindChurned(prev.systemBlocks, cur.systemBlocks, 'skillcatalog')
  const agentChurned = prevSysKinds.has('agentcatalog') && catalogKindChurned(prev.systemBlocks, cur.systemBlocks, 'agentcatalog')
  const toolsChurned = prev.tools.length > 0 && toolsV !== null
  const churn = [toolsChurned ? 'tools' : null, skillChurned ? 'skills' : null, agentChurned ? 'agents' : null].filter(Boolean) as string[]
  if (churn.length >= 2) {
    return { cause: 'PLUGINS_RELOADED', culpritLayer: 'tools', culpritId: 'plugins:reloaded',
      culpritSummary: `plugin reload — ${churn.length} catalogs churned together (${churn.join(', ')})`,
      confidence: churn.length >= 3 ? 'high' : 'medium' }
  }
  if (toolsV) return toolsV
  // 3. Request PARAMETERS rendered into the prompt (thinking / effort / tool_choice / speed). Each
  //    fires ONLY when BOTH turns carry the parameter EXPLICITLY and the two values differ.
  //    An absent↔present transition is UNDECIDABLE from captured data: the docs say "setting a
  //    parameter explicitly to its default value is equivalent to omitting it", and no page
  //    enumerates the per-model defaults — so absent→'high' is a real break if 'high' is not this
  //    model's default and a documented NO-OP if it is. Two DIFFERENT explicit values cannot both be
  //    the default, which is exactly the case that needs no defaults table. An unnamed break is
  //    honest; a guessed one is the false positive this rule exists to prevent.
  const paramChanged = (a: string, b: string) => a !== '' && b !== '' && a !== b
  if (paramChanged(prev.thinking, cur.thinking)) {
    return { cause: 'THINKING_CONFIG_CHANGED', culpritLayer: 'effort', culpritId: 'param:thinking', culpritSummary: `thinking ${prev.thinking} → ${cur.thinking}` }
  }
  if (paramChanged(prev.effortParam, cur.effortParam)) {
    return { cause: 'EFFORT_PARAM_CHANGED', culpritLayer: 'effort', culpritId: 'param:effort', culpritSummary: `output_config.effort ${prev.effortParam} → ${cur.effortParam}` }
  }
  if (paramChanged(prev.toolChoice, cur.toolChoice)) {
    return { cause: 'TOOL_CHOICE_CHANGED', culpritLayer: 'effort', culpritId: 'param:tool_choice', culpritSummary: `tool_choice ${prev.toolChoice} → ${cur.toolChoice}` }
  }
  if (paramChanged(prev.speed, cur.speed)) {
    return { cause: 'EFFORT_SWITCH', culpritLayer: 'effort', culpritId: 'param:speed', culpritSummary: `speed/fast-mode ${prev.speed} → ${cur.speed}` }
  }
  // 4. The environment and git-snapshot REGIONS of the system prompt, before the generic block diff.
  //    Both sit inside one big system block, so the positional diff can only report "that block
  //    changed" and would file two documented causes as UNCLASSIFIED. The `norm` guard runs the
  //    other way: a region differing ONLY by a timestamp is left to the block diff, which names
  //    SYSTEM_TIMESTAMP — so this pair can never steal a clock move.
  if (prev.envFp !== cur.envFp && prev.envNorm !== cur.envNorm) {
    const shape = !prev.envFp ? 'appeared' : !cur.envFp ? 'disappeared' : 'changed'
    return { cause: 'WORKING_DIR_CHANGED', culpritLayer: 'system', culpritId: 'system:env-block',
      culpritSummary: `the environment block (working directory / platform / shell / OS) ${shape} between these turns` }
  }
  if (prev.gitFp !== cur.gitFp && prev.gitNorm !== cur.gitNorm) {
    const shape = !prev.gitFp ? 'appeared' : !cur.gitFp ? 'disappeared' : 'changed'
    return { cause: 'GIT_STATE_CHANGED', culpritLayer: 'system', culpritId: 'system:git-snapshot',
      culpritSummary: `the startup git snapshot (branch / status / recent commits) ${shape} between these turns` }
  }
  // 5. System blocks.
  const sysV = diffBlocks(prev.systemBlocks, cur.systemBlocks, 'system')
  if (sysV) return sysV
  // 5. Message cached-prefix blocks. Any structural change (even an unlocalised one) beats a timing
  //    gap — a real byte change in the cached prefix is the true culprit, never TTL expiry.
  const msgV = diffBlocks(prev.messageBlocks, cur.messageBlocks, 'message')
  if (msgV) {
    if (msgV.cause === 'UNCLASSIFIED') msgV.rawDiffSummary = `${msgV.culpritSummary}; sys=${cur.systemBlocks.length} msg=${cur.messageBlocks.length} (was ${prev.messageBlocks.length})`
    return msgV
  }

  // 6. No localizable structural change → timing. Pure-timing means the whole cached prefix is
  //    byte-identical to the previous turn, so the only thing that could have re-written it is a TTL
  //    expiry (the entry aged out) or a cold warm.
  const gap = timing.gapMs
  if (gap !== undefined) {
    if (gap >= ONE_HOUR) return { cause: 'TTL_EXPIRY', culpritLayer: 'timing', culpritId: 'timing:TTL_EXPIRY:1h', culpritSummary: `no prefix change; ${(gap / 60000).toFixed(1)}m gap > 1h TTL`, ttlTier: '1h' }
    if (gap >= 4.5 * 60_000 && gap < 6 * 60_000) return { cause: 'TTL_EXPIRY', culpritLayer: 'timing', culpritId: 'timing:TTL_EXPIRY:5m', culpritSummary: `no prefix change; ${(gap / 60000).toFixed(1)}m gap ≈ 5m TTL`, ttlTier: '5m' }
    if (gap >= FIVE_MIN) return { cause: 'TTL_EXPIRY', culpritLayer: 'timing', culpritId: 'timing:TTL_EXPIRY:5m', culpritSummary: `no prefix change; ${(gap / 60000).toFixed(1)}m gap > 5m TTL`, ttlTier: '5m' }
  }
  // 6.4. LOOKBACK OVERFLOW — the prefix is byte-identical, yet the cache read NOTHING. The lookback
  //      only finds entries earlier requests actually WROTE, and it checks at most 20 positions; a
  //      conversation that grew ≥20 blocks past the last write pushes the entry outside that window.
  //      `cacheRead === 0` is the discriminator against NORMAL_GROWTH, which finds its entry and reads
  //      it — growth writes only the new tail, an overflow re-writes everything. Checked after the TTL
  //      gaps: when both explanations fit, an elapsed TTL is the simpler one and stays named.
  const grown = timing.blocksAddedSinceLastWrite
  if (grown !== undefined && grown >= LOOKBACK_WINDOW_BLOCKS && timing.cacheReadTokens === 0 && timing.cacheCreateTokens > 0) {
    return { cause: 'LOOKBACK_OVERFLOW', culpritLayer: 'message', culpritId: 'lookback:overflow',
      culpritSummary: `unchanged prefix, zero cache_read: ${grown} block(s) appended since the last cache write > the ${LOOKBACK_WINDOW_BLOCKS}-block lookback window`, ttlTier: 'none' }
  }
  if (timing.cacheReadTokens === 0) {
    return { cause: 'COLD_START', culpritLayer: 'timing', culpritId: 'timing:COLD_START', culpritSummary: 'no cache_read this turn — nothing cached to break (cold warm)', ttlTier: 'none' }
  }
  // 6.5. Pure APPEND growth: the previously-cached prefix is byte-identical AND this turn's message
  //      prefix is LONGER — the cache_creation is the NEW tail (this turn's fresh content) being cached
  //      for the first time. That is the incremental cache WORKING, not a break. This was the single
  //      biggest population previously dumped into UNCLASSIFIED ("unlocalised re-write"), hiding the
  //      fact that most of it was expected cost.
  if (cur.messageBlocks.length > prev.messageBlocks.length) {
    const added = cur.messageBlocks.length - prev.messageBlocks.length
    return { cause: 'NORMAL_GROWTH', culpritLayer: 'message', culpritId: 'growth:new-tail', culpritSummary: `append-only growth: +${added} new message block(s) cached for the first time (expected incremental write, not a break)`, ttlTier: 'none' }
  }
  // 7. Every layer's fingerprints matched yet a real re-write happened — an effect we cannot localise
  //    (e.g. a cache_control breakpoint moved, or an estimator blind spot). Attach a diff summary
  //    rather than guess.
  const raw = `prefix byte-identical by fingerprint but cache_creation=${timing.cacheCreateTokens}; tools=${cur.tools.length} sys=${cur.systemBlocks.length} msg=${cur.messageBlocks.length}`
  return { cause: 'UNCLASSIFIED', culpritLayer: 'timing', culpritId: 'timing:UNCLASSIFIED', culpritSummary: 'unlocalised re-write', rawDiffSummary: raw }
}

// ── Bounded scan: reconstruct sessions' ordered turns ────────────────────────────
interface ScannedTurn {
  bodyRef: string
  mtimeMs: number
  previousMessageId?: string
  sessionId?: string
  accountUuid?: string
  prefix: TurnPrefix | null
}
// inputTokens/outputTokens are additive to TRDD-6TQ2FBUR's original shape — carried so
// buildCauseCostPeakReport (TRDD-6TQ2FBUR D2) can rank cause groups by ANY cost bucket, not just
// cache_creation; the single-session timeline itself still only uses cacheCreate/cacheRead/tiers.
interface ResponseUsage { cacheCreate: number; cacheRead: number; ephemeral5m: number; ephemeral1h: number; inputTokens: number; outputTokens: number; model?: string; ts: number }

export interface CacheBreakTimelineOptions {
  bodiesDir?: string
  /** The Parquet body store (default `<dataDir>/store`) — the durable half of the evidence union. */
  storeDir?: string
  sessionId?: string
  scope?: string
  minTokens?: number
  windowHours?: number
  scanCap?: number
  topN?: number   // cap on the returned `events` array (default 25, max 100) — repeatOffenders/causeHistogram are unaffected
  /** Claude projects roots searched for a sub-agent child's transcript (test override; defaults
   *  to claudeProjectsDirs() — the same roots the log reader ingests from). */
  projectsDirs?: string[]
  /** TRDD-8ENYLEIO phase 3 — the lifecycle hook-event store (append-only NDJSON daily buckets).
   *  Default `<dataDir>/hook-events`. PreCompact/PostCompact events turn the COMPACTION cause from
   *  a text-shape inference into hook-corroborated evidence; a session with no hook coverage keeps
   *  the heuristic, tagged 'inferred'. */
  hookEventsDir?: string
}

function numOr0(v: unknown): number { return typeof v === 'number' && isFinite(v) ? v : 0 }
function strOrUndef(v: unknown): string | undefined { return typeof v === 'string' && v.length > 0 ? v : undefined }

interface RawResponseForBreak {
  id?: unknown
  model?: unknown
  usage?: {
    input_tokens?: unknown; output_tokens?: unknown
    cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown
    cache_creation?: { ephemeral_5m_input_tokens?: unknown; ephemeral_1h_input_tokens?: unknown }
  }
}

// ── The timeline report ──────────────────────────────────────────────────────────
export interface CacheBreakEvent {
  turn: number
  ts: string
  cause: CacheBreakTimelineCause
  culpritLayer: string
  culpritId: string
  culprit: string            // pointer-only human summary
  cacheCreateTokens: number
  cacheReadTokens: number
  inputTokens: number        // TRDD-6TQ2FBUR D2 — carried for buildCauseCostPeakReport's bucket ranking
  outputTokens: number       // (billed ~5x; can be the real cost peak even when cacheCreate is modest)
  costUsd: number
  gapMinutes?: number
  ttlTier?: TtlTier
  model?: string
  remediation: string
  rawDiffSummary?: string
  confidence?: 'high' | 'medium' // set for PLUGINS_RELOADED: high = 3 catalogs churned, medium = 2
  /** TRDD-8ENYLEIO phase 3 — set ONLY on COMPACTION events. 'hook' = a PreCompact/PostCompact
   *  lifecycle hook event for this session corroborates the compaction (positive identification);
   *  'inferred' = the prefix-diff/text-shape heuristic alone (sessions with no hook coverage).
   *  Never present a hook-proven compaction and a lookalike as the same claim. */
  causeEvidence?: 'hook' | 'inferred'
}

export interface RepeatOffender {
  cause: CacheBreakTimelineCause
  culpritId: string
  culprit: string
  occurrences: number        // turns this exact element broke the cache
  totalCacheCreateTokens: number
  medianCacheCreateTokens: number
  totalCostUsd: number
  pctOfSessionCacheCreate: number   // % of the session's total cache_creation
  firstTurn: number
  lastTurn: number
  systematic: boolean        // occurrences >= systematicThreshold
  verdict: string            // plain-language "here is your misconfigured X" line
}

export interface CacheBreakTimelineReport {
  sessionId?: string
  accountUuid?: string
  model?: string
  minTokens: number
  systematicThreshold: number
  turnsInSession: number
  turnsClassified: number             // TOTAL classified break events, before any topN truncation of `events`
  totalCacheCreateTokens: number       // Σ over the classified break events
  events: CacheBreakEvent[]            // most-recent-first-truncated to topN — see eventsNote when capped
  eventsNote?: string                  // set only when `events` was truncated; causeHistogram/repeatOffenders below are ALWAYS computed over the full set, never truncated
  causeHistogram: { cause: CacheBreakTimelineCause; events: number; cacheCreateTokens: number }[]
  repeatOffenders: RepeatOffender[]
  coverage: {
    bodiesDir: string
    dirExists: boolean
    requestFilesTotal: number
    requestFilesScanned: number
    responseFilesTotal: number
    responseFilesScanned: number
    sessionsFound: number
    scanCap: number
    windowHours?: number
    complete: boolean
    note: string
  }
}

const DEFAULT_MIN_TOKENS = 5000
const SYSTEMATIC_THRESHOLD = 3
const DEFAULT_EVENTS_TOPN = 25
const MAX_EVENTS_TOPN = 100

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

interface SessionScanResult {
  bySession: Map<string, ScannedTurn[]>
  respById: Map<string, ResponseUsage>
  coverage: CacheBreakTimelineReport['coverage']
}

// Shared bounded scan: index every response by message id -> usage, and every request into ordered
// per-session turns. Both buildCacheBreakTimeline (ONE target session) and buildCauseCostPeakReport
// (EVERY session, for the cost-peak finder's groupBy=cause) build on this ONE scan so the
// evidence-read contract lives in exactly one place.
//
// EVIDENCE = SPOOL ∪ PARQUET STORE (bodiesEvidence.ts), not raw files alone. The raw-files-only
// version had a measured defect that is easy to re-introduce, so it is spelled out: the ingest
// drain deletes a raw file the moment the store provably holds it, so this scan's history SHRANK as
// the drain ran — the same session showed 172 turns at 01:40 and 145 at 02:00 on 2026-08-13, and a
// $2.84 break event was classifiable in the first run and nonexistent in the second. Selection is a
// column-pruned Parquet scan (session_id/ts are first-class columns — one scoped run measured
// 13.5 s of JS file reads for what the pushdown answers in milliseconds); loading stays CHUNKED
// (32 bodies at a time, parsed then dropped) because ~200 × ~881 KB bodies in one result set is the
// ~176 MB memory spike this read path is suspected of killing the server with (TRDD-34B9JAZK).
const EVIDENCE_LOAD_CHUNK = 32

async function scanSessionsAndResponses(
  bodiesDir: string, storeDir: string, windowHours: number | undefined, scanCap: number,
): Promise<SessionScanResult> {
  const spool = fs.existsSync(bodiesDir) ? bodiesDir : null
  const tsFromMs = windowHours !== undefined && windowHours > 0 ? Date.now() - windowHours * 3_600_000 : undefined
  const reqAll = await listBodyEvidence(storeDir, spool, { kind: 'request', tsFromMs })
  const respAll = await listBodyEvidence(storeDir, spool, { kind: 'response', tsFromMs })

  // Store rows carry the capture ts; a spool row's ts is unknown until parsed, so stamp its file
  // mtime (the spool is small by construction — the drain keeps it at current inflow, never history).
  // A row whose file vanished mid-scan (drained) keeps tsMs === null — NOT Date.now(), which
  // FABRICATED a capture ts and pulled a stale drained call into live windows (review finding,
  // same defect as forensicsIndex.resolveTs). Null rows are excluded from any window below (their
  // bytes are in the store; the next pass sees them with the true ts) and sort last unwindowed.
  const stamp = (rows: EvidenceRow[]): void => {
    for (const r of rows) {
      if (r.tsMs !== null || !spool) continue
      try { r.tsMs = fs.statSync(path.join(spool, r.srcName)).mtimeMs } catch { /* drained mid-scan */ }
    }
  }
  stamp(reqAll); stamp(respAll)
  const inWindow = (rows: EvidenceRow[]): EvidenceRow[] =>
    tsFromMs === undefined ? rows : rows.filter((r) => r.tsMs !== null && r.tsMs >= tsFromMs)
  const recent = (rows: EvidenceRow[]): { slice: EvidenceRow[]; matched: number } => {
    const m = inWindow(rows)
    const sorted = [...m].sort((a, b) => (b.tsMs ?? 0) - (a.tsMs ?? 0))
    return { slice: sorted.slice(0, scanCap), matched: m.length }
  }
  const { slice: reqSlice, matched: reqMatched } = recent(reqAll)
  const { slice: respSlice } = recent(respAll)

  const parseBounded = <T>(raw: string | undefined, maxBytes: number): T | null => {
    if (raw === undefined || Buffer.byteLength(raw, 'utf8') > maxBytes) return null
    try { return JSON.parse(raw) as T } catch { return null }
  }

  // Index responses by message id → usage. Chunked load: each chunk's texts are dropped before the
  // next chunk is fetched, so peak memory is EVIDENCE_LOAD_CHUNK bodies, never the corpus.
  const respById = new Map<string, ResponseUsage>()
  for (let i = 0; i < respSlice.length; i += EVIDENCE_LOAD_CHUNK) {
    const chunk = respSlice.slice(i, i + EVIDENCE_LOAD_CHUNK)
    const texts = await loadBodyTexts(storeDir, spool, chunk, EVIDENCE_LOAD_CHUNK)
    for (const row of chunk) {
      const body = parseBounded<RawResponseForBreak>(texts.get(row.srcName), MAX_RESPONSE_BYTES)
      const id = strOrUndef(body?.id)
      if (!body?.usage || !id) continue
      const tier = body.usage.cache_creation
      respById.set(id, {
        cacheCreate: numOr0(body.usage.cache_creation_input_tokens),
        cacheRead: numOr0(body.usage.cache_read_input_tokens),
        ephemeral5m: numOr0(tier?.ephemeral_5m_input_tokens),
        ephemeral1h: numOr0(tier?.ephemeral_1h_input_tokens),
        inputTokens: numOr0(body.usage.input_tokens),
        outputTokens: numOr0(body.usage.output_tokens),
        model: strOrUndef(body.model),
        ts: row.tsMs ?? Date.now(),
      })
    }
  }

  // Parse requests → compact turns, grouped by session. Same chunk discipline.
  const bySession = new Map<string, ScannedTurn[]>()
  for (let i = 0; i < reqSlice.length; i += EVIDENCE_LOAD_CHUNK) {
    const chunk = reqSlice.slice(i, i + EVIDENCE_LOAD_CHUNK)
    const texts = await loadBodyTexts(storeDir, spool, chunk, EVIDENCE_LOAD_CHUNK)
    for (const row of chunk) {
      const body = parseBounded<RawRequestForBreak>(texts.get(row.srcName), MAX_REQUEST_BYTES)
      if (!body) continue
      const uid = parseUserId(body.metadata?.user_id)
      const sid = uid.sessionId ?? '(no-session)'
      const turn: ScannedTurn = {
        bodyRef: row.location === 'spool' && spool ? path.join(spool, row.srcName) : `store:${row.bodyId ?? row.srcName}`,
        mtimeMs: row.tsMs ?? Date.now(),
        previousMessageId: strOrUndef(body.diagnostics?.previous_message_id),
        sessionId: uid.sessionId, accountUuid: uid.accountUuid,
        prefix: extractTurnPrefix(body),
      }
      const list = bySession.get(sid)
      if (list) list.push(turn); else bySession.set(sid, [turn])
    }
  }

  const complete = reqSlice.length === reqMatched
  const fromStore = reqSlice.filter((r) => r.location === 'store').length
  const coverage: CacheBreakTimelineReport['coverage'] = {
    bodiesDir, dirExists: spool !== null,
    requestFilesTotal: reqAll.length, requestFilesScanned: reqSlice.length,
    responseFilesTotal: respAll.length, responseFilesScanned: respSlice.length,
    sessionsFound: bySession.size, scanCap, windowHours, complete,
    note: complete
      ? `Scanned all ${reqMatched} request body(ies)${windowHours ? ` in the last ${windowHours}h` : ''} across ${bySession.size} session(s) — ${fromStore} from the Parquet store, ${reqSlice.length - fromStore} from the raw spool (drained history stays in evidence).`
      : `SAMPLE: ${reqSlice.length} most-recent of ${reqMatched} matching request body(ies) across ${bySession.size} session(s) (cap ${scanCap}; ${fromStore} store / ${reqSlice.length - fromStore} spool). Not full history.`,
  }
  return { bySession, respById, coverage }
}

// ── agent-* child sessions (2026-07-11 field fix) ────────────────────────────────
// A sub-agent card's session id is `agent-<agentId>` (the subagents/*.jsonl filename convention),
// but the child's API calls carry the PARENT's session_id in metadata.user_id — so the raw-bodies
// scan groups every child turn under the parent, an exact `sessionId: 'agent-…'` lookup matched
// nothing, and every child timeline came back turnsClassified 0 (per-child cache forensics were
// impossible). The child's OWN transcript (<projects>/<mangled>/<parentSessionId>/subagents/
// agent-<agentId>.jsonl) holds the missing link: its assistant `message.id`s ARE the child's API
// response ids, and turn i+1 of the same stream carries turn i's response id as
// previous_message_id — so the child's turns are exactly the parent-bucket turns whose
// previous_message_id is one of the child's message ids, plus the stream head (recovered below).

const SUBAGENT_TRANSCRIPT_CAP = 64 * 1024 * 1024 // a child transcript beyond this is pathological — honest miss, never a hang

function findSubagentTranscript(fileName: string, projectsDirs: string[]): string | null {
  for (const dir of projectsDirs) {
    let projects: string[]
    try { projects = fs.readdirSync(dir) } catch { continue }
    for (const proj of projects) {
      let entries: fs.Dirent[]
      try { entries = fs.readdirSync(path.join(dir, proj), { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        if (!e.isDirectory()) continue // session dirs only — .jsonl siblings can never contain subagents/
        const candidate = path.join(dir, proj, e.name, 'subagents', fileName)
        if (fs.existsSync(candidate)) return candidate
      }
    }
  }
  return null
}

interface SubagentStream { turns: ScannedTurn[]; note: string }

function resolveSubagentStream(
  sessionId: string,
  bySession: Map<string, ScannedTurn[]>,
  projectsDirs?: string[],
): SubagentStream | null {
  // Accept both the served card id (`agent-<agentId>`) and the bare agentId a spawn placeholder uses.
  const fileName = (sessionId.startsWith('agent-') ? sessionId : `agent-${sessionId}`) + '.jsonl'
  const transcript = findSubagentTranscript(fileName, projectsDirs ?? claudeProjectsDirs())
  if (!transcript) return null
  let raw: string
  try {
    if (fs.statSync(transcript).size > SUBAGENT_TRANSCRIPT_CAP) return null
    raw = fs.readFileSync(transcript, 'utf-8')
  } catch { return null }
  // The child's assistant message ids ARE its API response ids (verified byte-exact on real data).
  const ids = new Set<string>()
  for (const line of raw.split('\n')) {
    if (!line.includes('"id":"msg_')) continue
    try {
      const e = JSON.parse(line) as { type?: string; message?: { id?: string } }
      if (e.type === 'assistant' && typeof e.message?.id === 'string' && e.message.id.startsWith('msg_')) ids.add(e.message.id)
    } catch { /* partial/foreign line — skip */ }
  }
  // The directory that CONTAINS subagents/ IS the parent session id (deterministic, no guessing —
  // the same linkage logReader uses to parent these transcripts at ingest).
  const parentSessionId = path.basename(path.dirname(path.dirname(transcript)))
  const parentTurns = bySession.get(parentSessionId)
  if (!parentTurns || ids.size === 0) return null
  // Chain membership: a request whose previous_message_id names one of the child's responses is
  // the child's NEXT call — that identifies every child turn except the stream head.
  const chained = parentTurns
    .filter(t => t.previousMessageId !== undefined && ids.has(t.previousMessageId))
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
  if (chained.length === 0) return null
  // Stream-head recovery: the child's FIRST request produced its first message id but carries no
  // chain link of its own. It shares the child conversation's first message block byte-for-byte
  // with the chained turns and, being a fresh stream, has NO previous_message_id — take the latest
  // such head before the first chained turn. (A fork child inherits the parent's history, so its
  // head DOES carry a previous id and is simply not recovered; the chain still covers every later
  // turn, and classifyTurns marks the earliest included turn COLD_START either way.)
  const head = chained[0]
  const headFp = head.prefix?.messageBlocks[0]?.fp
  let turns = chained
  if (headFp !== undefined) {
    const candidate = parentTurns
      .filter(t => t.previousMessageId === undefined && t.mtimeMs < head.mtimeMs && t.prefix?.messageBlocks[0]?.fp === headFp)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
    if (candidate) turns = [candidate, ...chained]
  }
  return {
    turns,
    note: `Resolved '${sessionId}' as a sub-agent CHILD via its subagents transcript: ${turns.length} of ` +
      `parent ${parentSessionId}'s ${parentTurns.length} scanned turn(s) belong to this child ` +
      `(${ids.size} child response id(s) harvested from the transcript).`,
  }
}

/** Build a session's cache-break ROOT-CAUSE timeline + repeat-offender rollup. Reconstructs the
 *  session's ordered turns from the raw OTEL bodies, classifies each significant cache_creation turn's
 *  break, and rolls repeated (cause, culprit-element) pairs into chronic offenders (flagged SYSTEMATIC
 *  at ≥ threshold turns). `agent-<agentId>` child sessions resolve via their subagents transcript (see
 *  resolveSubagentStream). LAZY + BOUNDED: one recency-first capped scan; honest coverage. */
export async function buildCacheBreakTimeline(opts: CacheBreakTimelineOptions = {}): Promise<CacheBreakTimelineReport> {
  const bodiesDir = opts.bodiesDir ?? defaultBodiesDir()
  const minTokens = opts.minTokens ?? DEFAULT_MIN_TOKENS
  const scanCap = opts.scanCap ?? RESPONSE_SCAN_CAP
  const dirExists = fs.existsSync(bodiesDir)
  const emptyCoverage = (note: string) => ({
    bodiesDir, dirExists, requestFilesTotal: 0, requestFilesScanned: 0, responseFilesTotal: 0,
    responseFilesScanned: 0, sessionsFound: 0, scanCap, windowHours: opts.windowHours, complete: true, note,
  })
  // The raw dir alone no longer decides whether evidence exists — drained history lives in the
  // Parquet store, and a missing spool with a populated store is a NORMAL state, not "no data".
  const storeDir = opts.storeDir ?? dataPath('store')
  if (!dirExists && !fs.existsSync(path.join(storeDir, 'bodies'))) {
    return baseReport(minTokens, emptyCoverage(`No raw-body evidence: neither ${bodiesDir} nor the Parquet store at ${storeDir} exists — set OTEL_LOG_RAW_API_BODIES to capture bodies.`))
  }

  const { bySession, respById, coverage } = await scanSessionsAndResponses(bodiesDir, storeDir, opts.windowHours, scanCap)
  const hookInfo = loadCompactionHookInfo(opts.hookEventsDir ?? dataPath('hook-events'))

  // Resolve the target session: exact sessionId > scope-prefix heaviest > overall heaviest by cache_creation.
  const target = resolveTarget(bySession, respById, opts)
  if (target) {
    return buildReportForSession(target.sid, target.turns, respById, minTokens, coverage, opts.topN, hookInfo.get(target.sid))
  }
  if (opts.sessionId) {
    // Not a metadata session id — try the sub-agent child path before giving up (2026-07-11 fix).
    const sub = resolveSubagentStream(opts.sessionId, bySession, opts.projectsDirs)
    if (sub) {
      return buildReportForSession(opts.sessionId, sub.turns, respById, minTokens,
        { ...coverage, note: `${coverage.note} ${sub.note}` }, opts.topN, hookInfo.get(opts.sessionId))
    }
    if (opts.sessionId.startsWith('agent-')) {
      return baseReport(minTokens, {
        ...coverage,
        note: `${coverage.note} '${opts.sessionId}' looks like a sub-agent child id, but no subagents ` +
          `transcript (or no scanned parent turn) matched it — child timelines resolve via ` +
          `<projects>/<mangled>/<parentSessionId>/subagents/${opts.sessionId}.jsonl plus the parent's raw bodies.`,
      })
    }
  }
  return baseReport(minTokens, coverage)
}

function baseReport(minTokens: number, coverage: CacheBreakTimelineReport['coverage']): CacheBreakTimelineReport {
  return {
    minTokens, systematicThreshold: SYSTEMATIC_THRESHOLD, turnsInSession: 0, turnsClassified: 0,
    totalCacheCreateTokens: 0, events: [], causeHistogram: [], repeatOffenders: [], coverage,
  }
}

// The cache_creation billed on turn i is read from turn i's RESPONSE, whose id == turn i+1's
// previous_message_id (the proven chain link). Returns 0 for the last turn (no following request).
function ccOfTurn(turns: ScannedTurn[], i: number, respById: Map<string, ResponseUsage>): ResponseUsage | undefined {
  const next = turns[i + 1]
  const respId = next?.previousMessageId
  return respId ? respById.get(respId) : undefined
}

function sessionCacheCreate(turns: ScannedTurn[], respById: Map<string, ResponseUsage>): number {
  let sum = 0
  for (let i = 0; i < turns.length; i++) sum += ccOfTurn(turns, i, respById)?.cacheCreate ?? 0
  return sum
}

function resolveTarget(
  bySession: Map<string, ScannedTurn[]>,
  respById: Map<string, ResponseUsage>,
  opts: CacheBreakTimelineOptions,
): { sid: string; turns: ScannedTurn[] } | null {
  const sort = (turns: ScannedTurn[]) => [...turns].sort((a, b) => a.mtimeMs - b.mtimeMs)
  if (opts.sessionId) {
    const t = bySession.get(opts.sessionId)
    return t ? { sid: opts.sessionId, turns: sort(t) } : null
  }
  const candidates = [...bySession.entries()].filter(([sid]) => sid !== '(no-session)' && (!opts.scope || sid.startsWith(opts.scope)))
  if (candidates.length === 0) return null
  let best: { sid: string; turns: ScannedTurn[]; cc: number } | null = null
  for (const [sid, turns] of candidates) {
    const cc = sessionCacheCreate(turns, respById)
    if (!best || cc > best.cc) best = { sid, turns: sort(turns), cc }
  }
  return best ? { sid: best.sid, turns: best.turns } : null
}

// Classify every significant cache_creation turn of ONE session into a break event. Shared by the
// single-session timeline AND the cross-session cause aggregator so the classification lives in one place.
function classifyTurns(turns: ScannedTurn[], respById: Map<string, ResponseUsage>, minTokens: number): CacheBreakEvent[] {
  const events: CacheBreakEvent[] = []
  // The message count at the last turn that actually WROTE to the cache — the lookback window is
  // measured from the last WRITE, not from the previous turn. Updated for EVERY turn with usage,
  // including the ones the minTokens floor drops, or the distance would be measured from the last
  // *reported* write instead of the last real one.
  let lastWriteMessageCount: number | null = null
  for (let i = 0; i < turns.length; i++) {
    const usage = ccOfTurn(turns, i, respById)
    const curPrefix = turns[i].prefix
    if (!usage || !curPrefix) continue
    const blocksAddedSinceLastWrite = lastWriteMessageCount === null ? undefined : curPrefix.messageCount - lastWriteMessageCount
    const timing: BreakTiming = {
      gapMs: i > 0 ? turns[i].mtimeMs - turns[i - 1].mtimeMs : undefined,
      cacheReadTokens: usage.cacheRead, cacheCreateTokens: usage.cacheCreate,
      ephemeral5mTokens: usage.ephemeral5m, ephemeral1hTokens: usage.ephemeral1h,
      blocksAddedSinceLastWrite,
    }
    if (usage.cacheCreate > 0) lastWriteMessageCount = curPrefix.messageCount  // AFTER this turn's delta
    // The floor is a cache_creation floor, so it drops every 0-token turn — including the ones whose
    // whole finding is that they are never cached at all. Admit exactly those two diagnoses through it.
    if (usage.cacheCreate < minTokens && !diagnoseNoCacheActivity(curPrefix, timing)) continue
    const prevPrefix = i > 0 ? turns[i - 1].prefix : null
    const prev2Prefix = i > 1 ? turns[i - 2].prefix : null   // for the A→B→A interleave signature
    const gapMs = timing.gapMs
    const verdict = classifyCacheBreak(prevPrefix, curPrefix, timing, prev2Prefix)
    const evModel = usage.model ?? curPrefix.model
    events.push({
      turn: i + 1,
      ts: new Date(turns[i].mtimeMs).toISOString(),
      cause: verdict.cause,
      culpritLayer: verdict.culpritLayer,
      culpritId: verdict.culpritId,
      culprit: verdict.culpritSummary,
      cacheCreateTokens: usage.cacheCreate,
      cacheReadTokens: usage.cacheRead,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: evModel ? +calcTokenCostUsd(0, 0, usage.cacheCreate, 0, evModel).toFixed(4) : 0,
      gapMinutes: gapMs !== undefined ? +(gapMs / 60000).toFixed(1) : undefined,
      ttlTier: verdict.ttlTier,
      model: evModel,
      remediation: CACHE_BREAK_REMEDIATION[verdict.cause],
      rawDiffSummary: verdict.rawDiffSummary,
      confidence: verdict.confidence,
    })
  }
  return events
}

// ── Compaction hook evidence (TRDD-8ENYLEIO phase 3) ─────────────────────────────
// The COMPACTION cause was pure inference: a text-shape regex over msg[0] (classifyContentKind's
// 'postcompact'). PreCompact/PostCompact lifecycle hook events STATE the compaction outright, so a
// break they corroborate is evidence, not a lookalike. The heuristic stays as the fallback for
// sessions with no hook coverage — tagged 'inferred', never dropped.

/** Clock slack between the hook's server-receive ts and the API call's own timestamp. */
const COMPACTION_HOOK_SLACK_MS = 60_000
/** A PreCompact with no matching PostCompact closes after this long (the burnGuard
 *  COMPACTION_REWRITE precedent: a compaction rewrite lands within ~5min of its PreCompact). */
const COMPACTION_WINDOW_FALLBACK_MS = 5 * 60_000

export interface CompactionHookInfo {
  /** PreCompact receive times, ascending. Any one at or before an event corroborates a
   *  COMPACTION-classified break (the rebuilt prefix may first be SENT minutes later — the first
   *  post-compaction call — so corroboration is precedes-based, not window-based). */
  preTimes: number[]
  /** [PreCompact.ts, PostCompact.ts] pairs (fallback close after 5min). Only a break INSIDE a
   *  window may be UPGRADED to COMPACTION — the compaction's own summarization call and the
   *  immediate rewrite; anything later must earn the cause from its body shape. */
  windows: Array<[number, number]>
}

/** Read PreCompact/PostCompact hook events and group them per session. Sessions without a
 *  session_id in the payload are dropped — corroboration must never guess whose compaction it saw. */
export function loadCompactionHookInfo(hookEventsDir: string): Map<string, CompactionHookInfo> {
  const out = new Map<string, CompactionHookInfo>()
  let pres: ReturnType<typeof readHookEvents>
  let posts: ReturnType<typeof readHookEvents>
  try {
    pres = readHookEvents(hookEventsDir, { ev: 'PreCompact', limit: 1000 })   // 1000 = the reader's hard cap
    posts = readHookEvents(hookEventsDir, { ev: 'PostCompact', limit: 1000 })
  } catch {
    return out // no hook store — every session falls back to 'inferred'
  }
  const bySession = (recs: typeof pres): Map<string, number[]> => {
    const m = new Map<string, number[]>()
    for (const r of recs) {
      if (!r.session) continue
      const arr = m.get(r.session) ?? []
      arr.push(r.ts)
      m.set(r.session, arr)
    }
    for (const arr of m.values()) arr.sort((a, b) => a - b)
    return m
  }
  const preBy = bySession(pres)
  const postBy = bySession(posts)
  for (const [sid, preTimes] of preBy) {
    const postTimes = postBy.get(sid) ?? []
    const windows: Array<[number, number]> = preTimes.map((pre) => {
      const post = postTimes.find((p) => p > pre)
      return [pre, post ?? pre + COMPACTION_WINDOW_FALLBACK_MS]
    })
    out.set(sid, { preTimes, windows })
  }
  return out
}

/** Annotate one session's classified events with compaction hook evidence. Exported for tests. */
export function applyCompactionHookEvidence(events: CacheBreakEvent[], info?: CompactionHookInfo): CacheBreakEvent[] {
  for (const e of events) {
    const ms = Date.parse(e.ts)
    if (Number.isNaN(ms)) {
      if (e.cause === 'COMPACTION') e.causeEvidence = 'inferred'
      continue
    }
    if (e.cause === 'COMPACTION') {
      e.causeEvidence = info?.preTimes.some((pre) => pre <= ms + COMPACTION_HOOK_SLACK_MS) ? 'hook' : 'inferred'
    } else if (e.cause === 'UNCLASSIFIED' && info?.windows.some(([a, b]) => ms >= a - COMPACTION_HOOK_SLACK_MS && ms <= b + COMPACTION_HOOK_SLACK_MS)) {
      // Positive identification the regex missed: an unlocalized break DURING a hook-attested
      // compaction window IS the compaction (its summarization call / immediate rewrite). Only
      // UNCLASSIFIED is upgraded — a named mechanical cause (MODEL_SWITCH, ...) during the window
      // is still that cause, and overriding it would hide a real misconfiguration behind an
      // expected one. rawDiffSummary is kept: the upgrade adds evidence, it does not erase any.
      e.cause = 'COMPACTION'
      e.causeEvidence = 'hook'
      e.remediation = CACHE_BREAK_REMEDIATION.COMPACTION
    }
  }
  return events
}

function buildReportForSession(
  sid: string,
  turns: ScannedTurn[],
  respById: Map<string, ResponseUsage>,
  minTokens: number,
  coverage: CacheBreakTimelineReport['coverage'],
  topN?: number,
  hookInfo?: CompactionHookInfo,
): CacheBreakTimelineReport {
  const sessionCC = sessionCacheCreate(turns, respById)
  const events = applyCompactionHookEvidence(classifyTurns(turns, respById, minTokens), hookInfo)
  const accountUuid = turns.find(t => t.accountUuid)?.accountUuid
  const model = events.find(e => e.model)?.model

  // Bound the returned `events` log to the most recent topN — histogram/repeatOffenders below are built
  // from the FULL `events` first (unaffected by this truncation), so the aggregate picture stays exact
  // even when the raw per-turn log is capped for a lean default payload.
  const cap = Math.min(Math.max(1, topN ?? DEFAULT_EVENTS_TOPN), MAX_EVENTS_TOPN)
  const shownEvents = events.length > cap ? events.slice(-cap) : events

  return {
    sessionId: sid, accountUuid, model,
    minTokens, systematicThreshold: SYSTEMATIC_THRESHOLD,
    turnsInSession: turns.length, turnsClassified: events.length,
    totalCacheCreateTokens: events.reduce((n, e) => n + e.cacheCreateTokens, 0),
    events: shownEvents,
    eventsNote: events.length > cap
      ? `Showing the most recent ${shownEvents.length} of ${events.length} classified break events (raise topN to see more, max ${MAX_EVENTS_TOPN}). repeatOffenders/causeHistogram below already summarize ALL ${events.length}.`
      : undefined,
    causeHistogram: buildHistogram(events),
    repeatOffenders: buildRepeatOffenders(events, sessionCC),
    coverage,
  }
}

function buildHistogram(events: CacheBreakEvent[]): CacheBreakTimelineReport['causeHistogram'] {
  const m = new Map<CacheBreakTimelineCause, { events: number; cacheCreateTokens: number }>()
  for (const e of events) {
    const g = m.get(e.cause) ?? { events: 0, cacheCreateTokens: 0 }
    g.events += 1; g.cacheCreateTokens += e.cacheCreateTokens
    m.set(e.cause, g)
  }
  return [...m.entries()].map(([cause, v]) => ({ cause, ...v })).sort((a, b) => b.cacheCreateTokens - a.cacheCreateTokens)
}

// The CHRONIC-OFFENDER rollup (the point of the tool): group break events by (cause, culprit element
// identity) — NOT just cause — so two breaks from the SAME element are ONE recurring offender. Rank by
// recurrence × wasted tokens; flag ≥ SYSTEMATIC_THRESHOLD-turn recurrences as SYSTEMATIC with a
// plain-language verdict naming the exact element + its fix.
function buildRepeatOffenders(events: CacheBreakEvent[], sessionCacheCreate: number): RepeatOffender[] {
  interface Acc { cause: CacheBreakTimelineCause; culpritId: string; culprit: string; tokens: number[]; cost: number; first: number; last: number }
  const byKey = new Map<string, Acc>()
  for (const e of events) {
    const key = `${e.cause}::${e.culpritId}`
    const a = byKey.get(key) ?? { cause: e.cause, culpritId: e.culpritId, culprit: e.culprit, tokens: [], cost: 0, first: e.turn, last: e.turn }
    a.tokens.push(e.cacheCreateTokens)
    a.cost += e.costUsd
    a.first = Math.min(a.first, e.turn)
    a.last = Math.max(a.last, e.turn)
    byKey.set(key, a)
  }
  const rows: RepeatOffender[] = [...byKey.values()].map(a => {
    const total = a.tokens.reduce((n, t) => n + t, 0)
    const occurrences = a.tokens.length
    const systematic = occurrences >= SYSTEMATIC_THRESHOLD
    return {
      cause: a.cause, culpritId: a.culpritId, culprit: a.culprit,
      occurrences, totalCacheCreateTokens: total, medianCacheCreateTokens: median(a.tokens),
      totalCostUsd: +a.cost.toFixed(4),
      pctOfSessionCacheCreate: sessionCacheCreate > 0 ? +(100 * total / sessionCacheCreate).toFixed(1) : 0,
      firstTurn: a.first, lastTurn: a.last, systematic,
      verdict: (systematic ? `SYSTEMATIC — ` : '') + `${a.cause}: ${a.culprit} broke the cache on ${occurrences} turn(s) (${total.toLocaleString()} cache_creation tokens). ${CACHE_BREAK_REMEDIATION[a.cause]}`,
    }
  })
  // Rank by recurrence × wasted tokens (the chronic + costly first).
  return rows.sort((a, b) =>
    (b.occurrences * b.totalCacheCreateTokens) - (a.occurrences * a.totalCacheCreateTokens)
    || b.totalCacheCreateTokens - a.totalCacheCreateTokens)
}

// ── buildCauseCostPeakReport — the 'cause' dimension of the cost-peak finder ──────
// TRDD-6TQ2FBUR D2: get_cache_creation_report generalizes into a COST-PEAK finder with
// groupBy {session|account|model|cause}. The first three stay in buildCacheCreationReport
// (cacheCreationForensics.ts, a lightweight response-only scan); 'cause' needs the full prefix-diff
// classifier this module owns, so it lives here as a SEPARATE builder returning the identical
// CacheCreationReport shape — the MCP tool dispatches on groupBy and formats either result with the
// SAME formatCostPeaks, so callers see one uniform contract regardless of which builder ran.
export interface CauseCostPeakOptions {
  bodiesDir?: string
  storeDir?: string
  windowHours?: number
  scanCap?: number
  minTokens?: number         // floor: only classify turns whose cache_creation >= this (default DEFAULT_MIN_TOKENS)
  bucket?: CostBucket
  topN?: number
  /** See CacheBreakTimelineOptions.hookEventsDir (TRDD-8ENYLEIO phase 3). */
  hookEventsDir?: string
}

function emptyCauseCostPeakReport(bucket: CostBucket, bodiesDir: string, scanCap: number, windowHours?: number): CacheCreationReport {
  return {
    bucket, groupBy: 'cause', windowHours,
    totalCacheCreateTokens: 0, totalCacheReadTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0,
    unattributed: { events: 0, cacheCreateTokens: 0, costUsd: 0, note: 'groupBy=cause has no unattributed bucket — every classified turn already belongs to a known session.' },
    outputSpikes: { note: 'The biggest single OUTPUT-token break events (output is billed ~5x — sometimes the real cost peak, not the cache write).', top: [] },
    groups: [],
    coverage: {
      bodiesDir, dirExists: false, responseFilesTotal: 0, responseFilesScanned: 0,
      requestFilesTotal: 0, requestFilesIndexed: 0, scanCap, windowHours, complete: true,
      note: `No OTEL raw-body directory at ${bodiesDir} — set OTEL_LOG_RAW_API_BODIES to capture bodies.`,
    },
  }
}

/** The 'cause' dimension of the cost-peak finder: scans EVERY session in the bounded window (not just
 *  one target, unlike buildCacheBreakTimeline), classifies each session's significant cache_creation
 *  turns via the SAME root-cause classifier the timeline uses, and ranks CAUSES by the chosen cost
 *  bucket {cache_creation|output|input|total|billable_weighted} — answering "which BREAK CAUSE is
 *  burning the most money", not just "which session/account/model". LAZY + BOUNDED: one shared scan
 *  (scanSessionsAndResponses); classification cost is O(turns already read), not an extra disk pass. */
export async function buildCauseCostPeakReport(opts: CauseCostPeakOptions = {}): Promise<CacheCreationReport> {
  const bodiesDir = opts.bodiesDir ?? defaultBodiesDir()
  const minTokens = opts.minTokens ?? DEFAULT_MIN_TOKENS
  const scanCap = opts.scanCap ?? RESPONSE_SCAN_CAP
  const bucket = opts.bucket ?? 'cache_creation'
  const topN = Math.min(opts.topN ?? 15, 50)
  const storeDir = opts.storeDir ?? dataPath('store')
  if (!fs.existsSync(bodiesDir) && !fs.existsSync(path.join(storeDir, 'bodies'))) {
    return emptyCauseCostPeakReport(bucket, bodiesDir, scanCap, opts.windowHours)
  }

  const { bySession, respById, coverage: timelineCoverage } = await scanSessionsAndResponses(bodiesDir, storeDir, opts.windowHours, scanCap)
  // Adapt the timeline scan's coverage shape (sessionsFound/requestFilesScanned) into the cost-peak
  // finder's CacheCreationScanCoverage shape (responseFilesScanned/requestFilesIndexed) — same numbers,
  // different field names — so get_cache_creation_report's coverage contract is identical regardless
  // of which builder produced the report.
  const coverage: CacheCreationScanCoverage = {
    bodiesDir: timelineCoverage.bodiesDir, dirExists: timelineCoverage.dirExists,
    responseFilesTotal: timelineCoverage.responseFilesTotal, responseFilesScanned: timelineCoverage.responseFilesScanned,
    requestFilesTotal: timelineCoverage.requestFilesTotal, requestFilesIndexed: timelineCoverage.requestFilesScanned,
    scanCap: timelineCoverage.scanCap, windowHours: timelineCoverage.windowHours,
    complete: timelineCoverage.complete, note: timelineCoverage.note,
  }

  const groups = new Map<CacheBreakTimelineCause, CacheCreationGroupRow>()
  let totalCC = 0, totalCR = 0, totalIn = 0, totalOut = 0, totalCost = 0
  const outputEvents: OutputSpike[] = []
  const hookInfo = loadCompactionHookInfo(opts.hookEventsDir ?? dataPath('hook-events'))

  for (const [sid, turnsRaw] of bySession) {
    if (sid === '(no-session)') continue
    const turns = [...turnsRaw].sort((a, b) => a.mtimeMs - b.mtimeMs)
    const accountUuid = turns.find(t => t.accountUuid)?.accountUuid
    for (const e of applyCompactionHookEvidence(classifyTurns(turns, respById, minTokens), hookInfo.get(sid))) {
      const t: TokenCounts = { inputTokens: e.inputTokens, cacheReadTokens: e.cacheReadTokens, cacheCreateTokens: e.cacheCreateTokens, outputTokens: e.outputTokens, model: e.model }
      const fullCost = tokenCountsFullCost(t)
      totalCC += e.cacheCreateTokens; totalCR += e.cacheReadTokens; totalIn += e.inputTokens; totalOut += e.outputTokens; totalCost += fullCost

      const g = groups.get(e.cause) ?? {
        key: e.cause, cacheCreateTokens: 0, cacheReadTokens: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
        costUsd: 0, events: 0, maxSingleCacheCreateTokens: 0, maxSingleOutputTokens: 0, bucketValue: 0,
      }
      g.cacheCreateTokens += e.cacheCreateTokens
      g.cacheReadTokens += e.cacheReadTokens
      g.inputTokens += e.inputTokens
      g.outputTokens += e.outputTokens
      g.totalTokens += tokenCountsTotal(t)
      g.costUsd += fullCost
      g.events += 1
      g.maxSingleCacheCreateTokens = Math.max(g.maxSingleCacheCreateTokens, e.cacheCreateTokens)
      g.maxSingleOutputTokens = Math.max(g.maxSingleOutputTokens, e.outputTokens)
      g.bucketValue += bucketValueOf(t, bucket)
      groups.set(e.cause, g)

      if (e.outputTokens > 0) {
        outputEvents.push({ sessionId: sid, accountUuid, model: e.model, outputTokens: e.outputTokens, cacheCreateTokens: e.cacheCreateTokens, ts: e.ts })
      }
    }
  }

  const ranked = [...groups.values()]
    .map(g => ({ ...g, costUsd: +g.costUsd.toFixed(4), bucketValue: +g.bucketValue.toFixed(4) }))
    .sort((a, b) => b.bucketValue - a.bucketValue)

  const outputTop = [...outputEvents].sort((a, b) => b.outputTokens - a.outputTokens).slice(0, 5)

  return {
    bucket, groupBy: 'cause', windowHours: opts.windowHours,
    totalCacheCreateTokens: totalCC, totalCacheReadTokens: totalCR, totalInputTokens: totalIn, totalOutputTokens: totalOut,
    totalCostUsd: +totalCost.toFixed(4),
    unattributed: {
      events: 0, cacheCreateTokens: 0, costUsd: 0,
      note: 'groupBy=cause has no unattributed bucket — every classified turn already belongs to a known session (an un-joinable response is simply not part of any session\'s turn sequence, so it is never classified).',
    },
    outputSpikes: {
      note: 'The biggest single OUTPUT-token break events (output is billed ~5x the input rate — sometimes the real cost peak, not the cache write). Rank by bucket=output or bucket=billable_weighted to surface these in the groups.',
      top: outputTop,
    },
    groups: ranked.slice(0, topN),
    coverage,
  }
}

// ── Cross-session cause + actor backtrace (get_cache_break_causes) ────────────────
// The user's two-step forensic question, answered across ALL sessions at once: (1) which BREAK CAUSE is
// the most common / most expensive (the causeRanking) — and then (2) backtrace each break to the actual
// PERPETRATOR (the actorLeaderboard, keyed on the enriched culpritId = the MCP server / hook / sub-agent
// model / harness ToolSearch that CAUSED the tools/system/model change). The transcript is only ever the
// victim; this report names who keeps breaking it, ranked, across the whole bounded scan.
export interface CacheBreakCauseRow {
  cause: CacheBreakTimelineCause
  expected: boolean           // true = expected cache behavior (cold warm / compaction / growth / interleave artifact), not a misconfiguration
  events: number
  sessionsAffected: number
  cacheCreateTokens: number
  pct: number                 // % of total classified cache_creation
  remediation: string
}
export interface CacheBreakActorRow {
  actorId: string             // the enriched culpritId = the stable perpetrator identity
  cause: CacheBreakTimelineCause
  expected: boolean           // mirrors EXPECTED_CAUSES — the verdict ranks only the avoidable actors
  actor: string               // human-readable "who" (pointer-only)
  occurrences: number         // break turns caused by this actor
  sessionsAffected: number
  totalCacheCreateTokens: number
  totalCostUsd: number
  pct: number                 // % of total classified cache_creation
  remediation: string
}
export interface CacheBreakCausesReport {
  minTokens: number
  totalClassifiedEvents: number
  totalCacheCreateTokens: number
  causeRanking: CacheBreakCauseRow[]
  actorLeaderboard: CacheBreakActorRow[]
  verdict: string             // one-line plain-language "the dominant perpetrator is X"
  coverage: CacheBreakTimelineReport['coverage']
}

export interface CacheBreakCausesOptions {
  bodiesDir?: string
  storeDir?: string
  windowHours?: number
  scanCap?: number
  minTokens?: number
  scope?: string              // optional session-id prefix filter
  topN?: number               // cap on the actorLeaderboard (default 20, max 100)
  /** See CacheBreakTimelineOptions.hookEventsDir (TRDD-8ENYLEIO phase 3). */
  hookEventsDir?: string
}

/** Cross-session cause ranking + perpetrator backtrace. Scans EVERY session in the bounded window,
 *  classifies each significant cache_creation turn via the SAME root-cause classifier, and returns both
 *  (1) the causes ranked by wasted cache_creation and (2) the actor leaderboard — grouped on the
 *  enriched culpritId, so "MCP server chrome-devtools" / "hook: pss-skills" / "harness ToolSearch" /
 *  "model claude-sonnet-5" surface as chronic perpetrators. LAZY + BOUNDED: one shared scan. */
export async function buildCacheBreakCauses(opts: CacheBreakCausesOptions = {}): Promise<CacheBreakCausesReport> {
  const bodiesDir = opts.bodiesDir ?? defaultBodiesDir()
  const minTokens = opts.minTokens ?? DEFAULT_MIN_TOKENS
  const scanCap = opts.scanCap ?? RESPONSE_SCAN_CAP
  const topN = Math.min(Math.max(1, opts.topN ?? 20), 100)
  const dirExists = fs.existsSync(bodiesDir)
  const emptyCoverage = (note: string): CacheBreakTimelineReport['coverage'] => ({
    bodiesDir, dirExists, requestFilesTotal: 0, requestFilesScanned: 0, responseFilesTotal: 0,
    responseFilesScanned: 0, sessionsFound: 0, scanCap, windowHours: opts.windowHours, complete: true, note,
  })
  const storeDir = opts.storeDir ?? dataPath('store')
  if (!dirExists && !fs.existsSync(path.join(storeDir, 'bodies'))) {
    return { minTokens, totalClassifiedEvents: 0, totalCacheCreateTokens: 0, causeRanking: [], actorLeaderboard: [], verdict: 'no data', coverage: emptyCoverage(`No raw-body evidence: neither ${bodiesDir} nor the Parquet store at ${storeDir} exists — set OTEL_LOG_RAW_API_BODIES to capture bodies.`) }
  }

  const { bySession, respById, coverage } = await scanSessionsAndResponses(bodiesDir, storeDir, opts.windowHours, scanCap)

  interface CauseAcc { events: number; cc: number; sessions: Set<string> }
  interface ActorAcc { cause: CacheBreakTimelineCause; actor: string; occ: number; cc: number; cost: number; sessions: Set<string> }
  const causeMap = new Map<CacheBreakTimelineCause, CauseAcc>()
  const actorMap = new Map<string, ActorAcc>()
  let total = 0, totalEvents = 0

  const hookInfo = loadCompactionHookInfo(opts.hookEventsDir ?? dataPath('hook-events'))
  for (const [sid, turnsRaw] of bySession) {
    if (sid === '(no-session)') continue
    if (opts.scope && !sid.startsWith(opts.scope)) continue
    const turns = [...turnsRaw].sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const e of applyCompactionHookEvidence(classifyTurns(turns, respById, minTokens), hookInfo.get(sid))) {
      total += e.cacheCreateTokens; totalEvents += 1
      const c = causeMap.get(e.cause) ?? { events: 0, cc: 0, sessions: new Set<string>() }
      c.events += 1; c.cc += e.cacheCreateTokens; c.sessions.add(sid); causeMap.set(e.cause, c)
      const a = actorMap.get(e.culpritId) ?? { cause: e.cause, actor: e.culprit, occ: 0, cc: 0, cost: 0, sessions: new Set<string>() }
      a.occ += 1; a.cc += e.cacheCreateTokens; a.cost += e.costUsd; a.sessions.add(sid); actorMap.set(e.culpritId, a)
    }
  }

  const pct = (n: number) => total > 0 ? +(100 * n / total).toFixed(1) : 0
  const causeRanking: CacheBreakCauseRow[] = [...causeMap.entries()]
    .map(([cause, v]) => ({ cause, expected: EXPECTED_CAUSES.has(cause), events: v.events, sessionsAffected: v.sessions.size, cacheCreateTokens: v.cc, pct: pct(v.cc), remediation: CACHE_BREAK_REMEDIATION[cause] }))
    .sort((a, b) => b.cacheCreateTokens - a.cacheCreateTokens)
  const actorLeaderboard: CacheBreakActorRow[] = [...actorMap.entries()]
    .map(([actorId, v]) => ({ actorId, cause: v.cause, expected: EXPECTED_CAUSES.has(v.cause), actor: v.actor, occurrences: v.occ, sessionsAffected: v.sessions.size, totalCacheCreateTokens: v.cc, totalCostUsd: +v.cost.toFixed(4), pct: pct(v.cc), remediation: CACHE_BREAK_REMEDIATION[v.cause] }))
    .sort((a, b) => b.totalCacheCreateTokens - a.totalCacheCreateTokens)
    .slice(0, topN)

  // The verdict names the top AVOIDABLE perpetrator — ranking by raw tokens alone crowns COLD_START /
  // NORMAL_GROWTH (expected behavior, unactionable) and buries the actual misconfiguration.
  const top = actorLeaderboard[0]
  const topAvoidable = actorLeaderboard.find(a => !a.expected)
  let verdict: string
  if (!top) {
    verdict = 'No significant cache_creation breaks classified in the scanned window.'
  } else if (!topAvoidable) {
    verdict = `All classified break cost is EXPECTED cache behavior (cold warms / compaction / incremental growth / interleave) — no avoidable perpetrator found. Largest: ${top.actor} (${top.cause}) at ${top.pct}%.`
  } else {
    const overallNote = topAvoidable.actorId !== top.actorId
      ? ` (Largest overall is ${top.actor} (${top.cause}) at ${top.pct}%, but that cause is expected/unavoidable.)`
      : ''
    verdict = `Dominant AVOIDABLE perpetrator: ${topAvoidable.actor} (${topAvoidable.cause}) — ${topAvoidable.totalCacheCreateTokens.toLocaleString()} cache_creation tokens across ${topAvoidable.sessionsAffected} session(s), ${topAvoidable.pct}% of all classified breaks. ${topAvoidable.remediation}${overallNote}`
  }

  return { minTokens, totalClassifiedEvents: totalEvents, totalCacheCreateTokens: total, causeRanking, actorLeaderboard, verdict, coverage }
}

// ── Output formatting ────────────────────────────────────────────────────────────
export type TimelineFormat = 'json' | 'table' | 'markdown' | 'timeline'

/** Render a timeline report in the requested format. json → the object itself; the others → a compact
 *  string wrapped as { format, text } so the MCP result stays JSON-serializable. */
export function formatTimeline(report: CacheBreakTimelineReport, format: TimelineFormat): unknown {
  if (format === 'json') return report
  const lines: string[] = []
  const hdr = `cache-break timeline — session ${report.sessionId ?? '(none)'}${report.model ? ` [${report.model}]` : ''}`
  if (format === 'markdown') {
    lines.push(`# ${hdr}`)
    lines.push('', `- turns: ${report.turnsInSession}, classified breaks: ${report.turnsClassified}, total cache_creation: ${report.totalCacheCreateTokens.toLocaleString()}`, '')
    lines.push('## Repeat offenders (chronic first)', '')
    lines.push('| cause | culprit | turns | tokens | % | systematic |', '|---|---|---|---|---|---|')
    for (const o of report.repeatOffenders) lines.push(`| ${o.cause} | ${o.culprit} | ${o.occurrences} | ${o.totalCacheCreateTokens.toLocaleString()} | ${o.pctOfSessionCacheCreate}% | ${o.systematic ? '⚠️ YES' : ''} |`)
    lines.push('', '## Timeline', '')
    for (const e of report.events) lines.push(`- turn ${e.turn} \`${e.ts}\` **${e.cause}** — ${e.culprit} (${e.cacheCreateTokens.toLocaleString()} tok${e.gapMinutes !== undefined ? `, +${e.gapMinutes}m` : ''})`)
  } else if (format === 'table') {
    lines.push(hdr)
    lines.push('turn  cause                       tokens      gap    culprit')
    for (const e of report.events) lines.push(`${String(e.turn).padStart(4)}  ${e.cause.padEnd(26)} ${String(e.cacheCreateTokens).padStart(9)}  ${(e.gapMinutes !== undefined ? e.gapMinutes + 'm' : '-').padStart(6)}  ${e.culprit}`)
    lines.push('', 'REPEAT OFFENDERS:')
    for (const o of report.repeatOffenders) lines.push(`  ${o.systematic ? '⚠️ ' : '  '}${o.cause} ×${o.occurrences} (${o.totalCacheCreateTokens} tok, ${o.pctOfSessionCacheCreate}%) — ${o.culprit}`)
  } else { // timeline
    lines.push(hdr)
    for (const e of report.events) {
      const bar = e.cause.startsWith('TOOL') ? '🔧' : e.cause === 'MODEL_SWITCH' ? '🔀' : e.cause === 'TTL_EXPIRY' ? '⏱️' : e.cause === 'COLD_START' ? '❄️' : e.cause.includes('SKILL') ? '📎' : e.cause === 'HOOK_INJECTION' ? '🪝' : '⚠️'
      lines.push(`${e.ts}  ${bar} turn ${e.turn}  ${e.cause}  ${e.cacheCreateTokens.toLocaleString()} tok — ${e.culprit}`)
    }
    const worst = report.repeatOffenders.find(o => o.systematic)
    if (worst) lines.push('', `VERDICT: ${worst.verdict}`)
  }
  if (report.eventsNote) lines.push('', report.eventsNote)
  return { format, text: lines.join('\n'), sessionId: report.sessionId, coverage: report.coverage }
}
