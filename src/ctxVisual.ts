// src/ctxVisual.ts — the analysis core behind `agentlenspro ctxvis` and the
// `/agentlenspro-visualize-context` skill: pick a spawned agent's captured turns out of the bodies
// dir, work out what changed between turn 1 and turn 2, and say whether that change broke the
// prompt-cache prefix.
//
// WHY THIS EXISTS. ctxmap answers "what is in ONE request". That is enough to compare agents at
// STARTUP, which is what every measurement here has done so far. It says nothing about what an
// agent costs to KEEP RUNNING, and that is the number that actually decides the bill: a turn whose
// prefix survives byte-exact re-reads at 0.1x, and a turn whose prefix broke pays the full write
// rate on everything from the break onward. A lean agent that breaks its prefix every turn is more
// expensive than a fat agent that never does. Nothing measured that before this module.
//
// THE TWO THINGS THIS MODULE REFUSES TO GUESS.
//
//   1. WHICH captures belong to the agent. `metadata.user_id` carries a session_id, but a subagent
//      shares its parent's session id and one session interleaves concurrent streams — so session
//      id cannot isolate a spawned agent. Correlating by time-and-size is the same heuristic that
//      already died here once (ctxmap's pairUsage: 43 candidate responses inside one window). So
//      the caller plants a nonce in the spawn prompt and selection becomes an exact string test.
//      See selectTurns for why the nonce ALONE is still not enough.
//
//   2. WHETHER the cache was hit. divergence() predicts it from the request bytes; the response's
//      own `usage` reports what was actually billed. Both are printed and compared. Where they
//      disagree the report says so instead of picking the flattering one — a confident wrong number
//      is worse than an admitted uncertainty, which is the same rule ctxmap's residual check
//      enforces on decomposition.

import * as fs from 'fs'
import * as path from 'path'
import { readBody, messageTexts, type RequestBody, type Usage } from './capturedBody'
import { calcTokenCostUsd } from './shared/pricing'

// ── selecting a spawned agent's turns ─────────────────────────────────────────

export interface CapturedTurn {
  /** Absolute path of the .request.json capture. */
  file: string
  /** Wall-clock mtime, used only to CROSS-CHECK the message-count ordering, never to establish it. */
  mtimeMs: number
  req: RequestBody
  /** Number of messages — the primary, monotonic turn ordinal within one agent run. */
  messageCount: number
}

export interface TurnSelection {
  turns: CapturedTurn[]
  /** Captures that carried the nonce but were NOT the agent's own turns (overwhelmingly the parent
   *  session, which necessarily contains the nonce in the Agent tool_use it emitted). Surfaced so a
   *  caller can show that the filter did something, rather than asking for trust. */
  rejected: { file: string; reason: string }[]
  /** Set when mtime order contradicts message-count order. Both orderings should agree for a single
   *  sequential agent run; when they do not, something else is going on (a re-run under the same
   *  nonce, interleaved concurrent agents) and picking one silently would fabricate a turn pair. */
  ambiguous: string | null
}

/** The marker the skill plants in the spawn prompt. Deliberately not a word that occurs in prose. */
export const NONCE_PREFIX = 'AGENTLENS-CTXVIS-'

export function mintNonce(rand: () => number = Math.random): string {
  let s = ''
  while (s.length < 8) s += Math.floor(rand() * 16).toString(16)
  return NONCE_PREFIX + s.slice(0, 8).toUpperCase()
}

/**
 * Find the captures belonging to ONE spawned agent, identified by a nonce in its spawn prompt.
 *
 * THE POSITION RULE, which is the whole trick. The nonce appears in the parent session's requests
 * too — the parent emitted the `Agent` tool_use that carries it, and later receives the tool_result
 * echoing it. Matching on "the body contains the nonce" therefore selects the parent's entire
 * remaining conversation along with the agent's turns, and the parent's requests are both larger and
 * more numerous, so any "pick the biggest / most recent" tiebreak lands on exactly the wrong thing.
 *
 * A subagent's injected prompt is `messages[0]`. The parent's copy is always in a LATER message,
 * because the parent had a conversation before it decided to spawn anything. So: qualify a capture
 * iff the nonce is in messages[0], and reject it (with the reason) otherwise.
 */
export function selectTurns(files: string[], nonce: string): TurnSelection {
  const turns: CapturedTurn[] = []
  const rejected: { file: string; reason: string }[] = []

  for (const file of files) {
    let req: RequestBody
    let mtimeMs: number
    try {
      req = readBody(file) as RequestBody
      mtimeMs = fs.statSync(file).mtimeMs
    } catch {
      continue // half-flushed or vanished capture — not an error, just not evidence
    }
    const msgs = req.messages ?? []
    const inFirst = messageTexts(msgs[0]).some(t => t.includes(nonce))
    if (inFirst) {
      turns.push({ file, mtimeMs, req, messageCount: msgs.length })
      continue
    }
    const anywhere = msgs.some(m => messageTexts(m).some(t => t.includes(nonce)))
    if (anywhere) {
      rejected.push({
        file: path.basename(file),
        reason: 'nonce present but not in messages[0] — this is the spawning session, not the agent',
      })
    }
  }

  turns.sort((a, b) => a.messageCount - b.messageCount)

  // Cross-check: for one sequential agent run, arrival order and message-count order must agree.
  let ambiguous: string | null = null
  for (let i = 1; i < turns.length; i++) {
    if (turns[i].mtimeMs < turns[i - 1].mtimeMs) {
      ambiguous = `turn ordering is contradictory: ${path.basename(turns[i].file)} has more messages ` +
        `than ${path.basename(turns[i - 1].file)} but was written earlier. Two runs may share this ` +
        `nonce, or concurrent agents interleaved. Re-run with a fresh nonce.`
      break
    }
    if (turns[i].messageCount === turns[i - 1].messageCount) {
      ambiguous = `two captures have the same message count (${turns[i].messageCount}), so their ` +
        `turn order cannot be established. Re-run with a fresh nonce.`
      break
    }
  }
  return { turns, rejected, ambiguous }
}

/** List every `.request.json` under the given dirs. Unreadable dirs are skipped, not fatal — a scan
 *  that dies on one dir would report nothing about the others. */
export function listRequestCaptures(dirs: string[]): string[] {
  const out: string[] = []
  for (const d of dirs) {
    let names: string[]
    try { names = fs.readdirSync(d) } catch { continue }
    for (const n of names) if (n.endsWith('.request.json')) out.push(path.join(d, n))
  }
  return out
}

// ── prefix divergence ─────────────────────────────────────────────────────────

/** The cache prefix tiers, in the exact order the API serialises them. Order is load-bearing: a
 *  change in `tools` invalidates everything after it, so the walk must not be reordered. */
export type CacheTier = 'tools' | 'system' | 'messages'

export interface Divergence {
  /** `identical` — the two requests are the same. `append` — every element of A survives byte-exact
   *  in B and B only added messages at the tail (the healthy case). `break` — something inside A's
   *  own extent changed, so everything from that point is re-written. */
  kind: 'identical' | 'append' | 'break'
  tier: CacheTier | null
  /** Index within the tier of the first differing element. */
  index: number | null
  /** For a message divergence, the index of the first differing content block, when the difference
   *  is inside the blocks rather than the message envelope. */
  blockIndex: number | null
  /** Human-readable identification of the element that moved, for the report. */
  label: string
  /** How many messages B appended beyond A. Meaningful for `append`. */
  appended: number
}

function eq(a: unknown, b: unknown): boolean {
  // Structural equality via canonical JSON. The API compares the SERIALISED prefix, so JSON equality
  // is the right notion here — two objects that differ only in key order do serialise differently
  // and would in fact break the cache, and JSON.stringify preserves insertion order, so this
  // faithfully models that rather than over-normalising it away.
  if (a === b) return true
  try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
}

function firstDiffBlock(a: unknown, b: unknown): number | null {
  const am = a as { content?: unknown }
  const bm = b as { content?: unknown }
  if (!Array.isArray(am?.content) || !Array.isArray(bm?.content)) return null
  const n = Math.max(am.content.length, bm.content.length)
  for (let i = 0; i < n; i++) if (!eq(am.content[i], bm.content[i])) return i
  return null
}

/**
 * Find where request B stops matching request A, walking the canonical cache order.
 *
 * The distinction that matters is `append` vs `break`. B always has MORE content than A (it is a
 * later turn), so "the two differ" is trivially true and useless. The question is whether they
 * differ WITHIN A's extent — that is what costs money.
 */
export function divergence(a: RequestBody, b: RequestBody): Divergence {
  const none = (kind: Divergence['kind'], label: string, appended = 0): Divergence =>
    ({ kind, tier: null, index: null, blockIndex: null, label, appended })

  // 1. tools — the worst place to diverge; everything after it is invalidated.
  const at = a.tools ?? [], bt = b.tools ?? []
  for (let i = 0; i < Math.max(at.length, bt.length); i++) {
    if (!eq(at[i], bt[i])) {
      const name = (bt[i]?.name ?? at[i]?.name ?? `#${i}`)
      const what = at[i] === undefined ? 'added' : bt[i] === undefined ? 'removed' : 'changed'
      return { kind: 'break', tier: 'tools', index: i, blockIndex: null, appended: 0,
        label: `tool schema ${what}: ${name}` }
    }
  }

  // 2. system
  const as = a.system ?? [], bs = b.system ?? []
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    if (!eq(as[i], bs[i])) {
      const what = as[i] === undefined ? 'added' : bs[i] === undefined ? 'removed' : 'changed'
      return { kind: 'break', tier: 'system', index: i, blockIndex: null, appended: 0,
        label: `system block #${i} ${what}` }
    }
  }

  // 3. messages — only A's own extent counts as a break; beyond it is an append.
  const am = a.messages ?? [], bm = b.messages ?? []
  for (let i = 0; i < am.length; i++) {
    if (!eq(am[i], bm[i])) {
      const blockIndex = bm[i] === undefined ? null : firstDiffBlock(am[i], bm[i])
      const what = bm[i] === undefined ? 'removed' : 'rewritten'
      return { kind: 'break', tier: 'messages', index: i, blockIndex, appended: 0,
        label: `message #${i} (${am[i]?.role ?? '?'}) ${what}` +
          (blockIndex === null ? '' : ` at content block #${blockIndex}`) }
    }
  }

  const appended = bm.length - am.length
  if (appended === 0) return none('identical', 'nothing changed between the two turns')
  return none('append', `${appended} message${appended === 1 ? '' : 's'} appended; prefix intact`, appended)
}

// ── the cache verdict ─────────────────────────────────────────────────────────

export interface CacheVerdict {
  divergence: Divergence
  /** Tokens of the common prefix, measured by count_tokens when available. null when the caller
   *  could not measure (no auth) — the verdict then reports the SHAPE only, and says so. */
  predictedSurviving: number | null
  predictedRewritten: number | null
  /** What the API actually billed, straight from turn 2's response usage. */
  actualCacheRead: number | null
  actualCacheWrite: number | null
  actual1h: number | null
  actual5m: number | null
  /** Whether prediction and billing tell the same story, and why if not. */
  agreement: 'agree' | 'shortfall-within-tolerance' | 'disagree' | 'unmeasured'
  agreementNote: string
  /** USD actually charged for turn 2's input, at the real per-tier rates. */
  actualCostUsd: number | null
}

/**
 * Cache hits land on `cache_control` breakpoint boundaries, not at an arbitrary byte offset, so the
 * billed cache_read is normally a little BELOW the true common prefix — it is rounded down to the
 * last breakpoint. That is expected and is not evidence of a broken model. A large shortfall IS.
 * 5% (or 2k tokens, whichever is larger) is the band; outside it the verdict says `disagree` and the
 * report shows both numbers rather than asserting a match nobody checked.
 */
export function cacheVerdict(
  div: Divergence,
  predictedSurviving: number | null,
  turn2Total: number | null,
  usage: Usage | undefined,
  model: string | undefined,
): CacheVerdict {
  const read = usage?.cache_read_input_tokens ?? null
  const write = usage?.cache_creation_input_tokens ?? null
  const h1 = usage?.cache_creation?.ephemeral_1h_input_tokens ?? null
  const m5 = usage?.cache_creation?.ephemeral_5m_input_tokens ?? null

  const predictedRewritten = predictedSurviving != null && turn2Total != null
    ? Math.max(0, turn2Total - predictedSurviving)
    : null

  let agreement: CacheVerdict['agreement'] = 'unmeasured'
  let agreementNote = 'no count_tokens measurement was taken, so only the SHAPE of the change is reported'

  if (predictedSurviving != null && read != null) {
    const delta = predictedSurviving - read
    const tol = Math.max(2000, predictedSurviving * 0.05)
    if (Math.abs(delta) <= 1) {
      agreement = 'agree'
      agreementNote = 'predicted surviving prefix matches the billed cache_read exactly'
    } else if (delta > 0 && delta <= tol) {
      agreement = 'shortfall-within-tolerance'
      agreementNote = `billed cache_read is ${delta.toLocaleString('en-US')} tokens below the common ` +
        `prefix — expected, since a hit is rounded down to the last cache_control breakpoint`
    } else if (delta < 0) {
      agreement = 'disagree'
      agreementNote = `the API reused MORE than the common prefix (${(-delta).toLocaleString('en-US')} ` +
        `tokens more), which the prefix model cannot explain — treat the prediction as wrong, not the billing`
    } else {
      agreement = 'disagree'
      agreementNote = `billed cache_read is ${delta.toLocaleString('en-US')} tokens below the common ` +
        `prefix, far more than breakpoint rounding explains — the prefix model does not fit this pair`
    }
  }

  // Bill the input at the REAL per-tier rates. The 1h portion is passed through explicitly: Claude
  // Code puts main-conversation turns on the 1h tier (2x), and a flat 1.25x under-reports those by
  // 60%. Sub-agents are always 5m, but this function is handed whatever the capture actually says
  // rather than assuming which case it is looking at.
  const actualCostUsd = (read != null && write != null && model)
    ? calcTokenCostUsd(usage?.input_tokens ?? 0, read, write, 0, model, h1 ?? 0)
    : null

  return {
    divergence: div,
    predictedSurviving,
    predictedRewritten,
    actualCacheRead: read,
    actualCacheWrite: write,
    actual1h: h1,
    actual5m: m5,
    agreement,
    agreementNote,
    actualCostUsd,
  }
}

// ── the baseline store ────────────────────────────────────────────────────────

/** The three agent types every custom agent is measured against. */
export const BASE_AGENTS = ['Explore', 'Plan', 'general-purpose'] as const

/** The shared elements whose sizes fingerprint the environment. If any of these moved, a cached
 *  baseline was measured under different conditions and comparing against it is comparing two
 *  different worlds while claiming to compare two agents. */
export interface EnvFingerprint {
  claudeCodeVersion: string | null
  projectDir: string | null
  claudeMdTokens: number
  rulesTokens: number
  mcpSchemaTokens: number
  skillListingTokens: number
}

export interface BaselineEntry {
  agent: string
  measuredAt: string
  env: EnvFingerprint
  turns: { total: number; elements: { label: string; tokens: number; full?: string }[] }[]
  verdict: CacheVerdict | null
}

export interface BaselineStore { version: 1; entries: BaselineEntry[] }

export function loadBaselines(file: string): BaselineStore {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as BaselineStore
    if (raw?.version === 1 && Array.isArray(raw.entries)) return raw
    // A store we cannot understand is not a store. Starting fresh loses only a cache, and the
    // alternative — half-reading a future schema — would compare against fields that mean
    // something else now.
    return { version: 1, entries: [] }
  } catch {
    return { version: 1, entries: [] }
  }
}

export function saveBaselines(file: string, store: BaselineStore): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2))
  fs.renameSync(tmp, file) // atomic: a crash mid-write must not leave a truncated store behind
}

export type BaselineVerdict =
  | { agent: string; state: 'missing' }
  | { agent: string; state: 'fresh'; entry: BaselineEntry }
  | { agent: string; state: 'stale'; entry: BaselineEntry; reason: string }

/**
 * Decide, per base agent, whether its cached measurement can still be trusted — by comparing the
 * fingerprint it was stamped with against the environment the SUBJECT was just measured in. The
 * subject's capture is fresh by construction, so this validation costs nothing.
 *
 * Reports only; it deliberately does not decide whether to re-spawn. Keeping the policy out of here
 * is what lets the staleness rules be tested without spawning anything.
 */
export function validateBaselines(
  store: BaselineStore,
  current: EnvFingerprint,
  agents: readonly string[] = BASE_AGENTS,
): BaselineVerdict[] {
  return agents.map(agent => {
    const entry = store.entries.find(e => e.agent === agent)
    if (!entry) return { agent, state: 'missing' as const }
    const reason = fingerprintDrift(entry.env, current)
    return reason
      ? { agent, state: 'stale' as const, entry, reason }
      : { agent, state: 'fresh' as const, entry }
  })
}

/** The first material difference between two fingerprints, or null. Token counts get a 2% band:
 *  these blocks legitimately wobble by a few tokens between turns, and re-spawning three agents
 *  because a rules file gained a comma would make the cache useless. */
export function fingerprintDrift(was: EnvFingerprint, now: EnvFingerprint): string | null {
  if (was.claudeCodeVersion && now.claudeCodeVersion && was.claudeCodeVersion !== now.claudeCodeVersion) {
    return `Claude Code moved ${was.claudeCodeVersion} → ${now.claudeCodeVersion}`
  }
  if (was.projectDir && now.projectDir && was.projectDir !== now.projectDir) {
    return `measured in a different project (${was.projectDir} → ${now.projectDir})`
  }
  const fields: [keyof EnvFingerprint, string][] = [
    ['claudeMdTokens', 'CLAUDE.md'],
    ['rulesTokens', '~/.claude/rules/*'],
    ['mcpSchemaTokens', 'MCP tool schemas'],
    ['skillListingTokens', 'the skill listing'],
  ]
  for (const [k, name] of fields) {
    const a = was[k] as number, b = now[k] as number
    if (typeof a !== 'number' || typeof b !== 'number') continue
    const band = Math.max(50, a * 0.02)
    if (Math.abs(a - b) > band) {
      return `${name} changed ${a.toLocaleString('en-US')} → ${b.toLocaleString('en-US')} tokens`
    }
  }
  return null
}
