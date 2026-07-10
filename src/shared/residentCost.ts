// ── Resident-cost itemization (TRDD-W0RRL2FZ) ─────────────────────────────────
// Pure derivation over an existing ContextHistory — no I/O, no new ingestion. The cost model is
// `cost ≈ turns × per-turn-context`: every block occurrence rides forward in the transcript from
// the step it was added until the next compaction evicts it (or the session ends), and is re-read
// (cache-read billed) on every turn in between. This module multiplies the two dimensions the
// history already knows (per-block tokens × turns-resident) and ranks the result, so the
// "conversation remainder" of the inflation report becomes an itemized, named list.
//
// Shared by the host (MCP tools) and the webview (History tab) — this file replaced the
// hand-synced media/src/residentCost.ts mirror. Keep it runtime-neutral: no Node, no DOM.

import type {
  ContextHistory, ContextBlockKind, ResidentCostBlock, ResidentCostReport,
} from './summarizerTypes'

// Per-kind one-line remediation hints (TRDD-W0RRL2FZ spec 4). A Record over the full kind union so
// the compiler forces a hint when a new ContextBlockKind is added — an unknown kind can never fall
// through to a silent empty string.
const KIND_REMEDIATION: Record<ContextBlockKind, string> = {
  postCompact:    'The compaction summary rides every turn after the compaction — compact earlier (smaller transcript to summarize) or keep the summary shorter.',
  toolOutput:     'This tool output rode the transcript for many turns — extract the needed fact and drop the blob (scope reads, filter command output).',
  bashOutput:     'Command output rides forward every turn — pipe through head/grep so only the needed lines enter the transcript.',
  subagentOutput: 'The sub-agent report rides forward — have agents return a one-line summary plus a report path instead of the full report body.',
  file:           'Pasted/loaded file content rides the transcript — read only the needed line range and avoid re-pasting files.',
  hook:           'Per-turn hook injections accumulate one copy per fire — shorten the hook output or fire it less often.',
  cron:           'Each scheduled/local-command ping adds a copy that rides until the next compaction — lengthen the ping interval or compact periodically.',
  harness:        'Harness-injected reminders accumulate per turn — keep injected rules/reminders short.',
  reminder:       'Task reminders re-inject each turn — keep the todo list short.',
  userMsg:        'Long user messages ride the whole session — reference files by path instead of pasting content.',
  assistantMsg:   'Long responses ride forward every later turn — keep answers terse in long sessions.',
  reasoning:      'Extended thinking rides forward in the transcript — lower the reasoning effort for mechanical steps.',
  toolInput:      'Large tool inputs (e.g. full-file Write payloads) ride forward — prefer targeted edits over full-content writes.',
  bashInput:      'Long command lines ride forward — move complex scripts into files and invoke them by path.',
  toolCatalog:    'The tool catalog sits in the prefix — avoid toggling tools/MCP servers mid-session (each change re-caches the prefix).',
  skillCatalog:   'The skill catalog sits in the prefix every turn — trim unused skills.',
  agentCatalog:   'The agent catalog sits in the prefix every turn — trim unused agent definitions.',
  mcp:            'MCP instructions sit in the prefix every turn — disconnect servers the task does not need.',
  skillPrompt:    'A loaded skill prompt stays resident for the rest of the session — load only the skills the task needs.',
  agentPrompt:    'The agent prompt is charged every turn — keep agent definitions lean.',
  system:         'The system prompt is charged every turn — keep global instructions lean.',
  claudemd:       'CLAUDE.md is injected every turn — keep it lean and move detail into on-demand files.',
  rule:           'Rule files are injected every turn — keep always-on rules short and move detail into skills.',
  other:          'Unclassified content riding the transcript — drill into the block to identify and trim it.',
}

export function kindRemediation(kind: ContextBlockKind): string {
  return KIND_REMEDIATION[kind]
}

/**
 * Rank every distinct context block of a session by resident cost = Σ over its occurrences of
 * tokens × turns-resident.
 *
 * Residency model: content attributed to turn T stays in the live context until the turn BEFORE
 * the first compaction turn > T (compaction turns = steps carrying a postCompact block: the
 * summary is attributed to the first post-compaction turn, so everything attributed to EARLIER
 * turns was dropped by that compaction), else until the last turn. This is an approximation —
 * compaction preserves a few anchor messages (preservedMessages) that ride longer than modeled —
 * which is why the report reconciles against exact usage totals and labels the gap (`note`).
 */
export function buildResidentCostReport(history: ContextHistory): ResidentCostReport {
  const steps = history.steps
  const lastTurn = steps.length > 0 ? steps[steps.length - 1].turn : 0

  const compactionTurns: number[] = []
  for (const s of steps) {
    if (s.blocks.some(b => b.kind === 'postCompact')) compactionTurns.push(s.turn)
  }
  // steps are turn-ordered, so compactionTurns is ascending; residencyEnd scans forward.
  const residencyEnd = (turn: number): number => {
    for (const c of compactionTurns) if (c > turn) return c - 1
    return lastTurn
  }

  const agg = new Map<string, ResidentCostBlock>()
  let totalContextTokens = 0
  let stepsWithUsage = 0
  for (const s of steps) {
    if (s.usage) {
      // input already EXCLUDES the cache buckets in the transcript usage shape, so the per-turn
      // context (what the model actually read that call) is the sum of all three.
      totalContextTokens += s.usage.input + s.usage.cacheRead + s.usage.cacheCreate
      stepsWithUsage++
    }
    const end = residencyEnd(s.turn)
    // Math.max(1, …) guards a same-turn eviction edge (a block attributed to the exact turn a later
    // compaction lands on still counted for its own turn) — a 0-turn residency would silently erase
    // real tokens from the itemization.
    const turnsRes = Math.max(1, end - s.turn + 1)
    for (const b of s.blocks) {
      let a = agg.get(b.id)
      if (!a) {
        a = {
          id: b.id, kind: b.kind, label: b.label,
          tokens: 0, peakTokens: 0, occurrences: 0,
          firstSeenTurn: s.turn, lastResidentTurn: end, turnsResident: 0, residentCost: 0,
          remediation: kindRemediation(b.kind),
        }
        agg.set(b.id, a)
      }
      a.tokens += b.tokens
      a.peakTokens = Math.max(a.peakTokens, b.tokens)
      a.occurrences += 1
      a.lastResidentTurn = Math.max(a.lastResidentTurn, end)
      a.residentCost += b.tokens * turnsRes
    }
  }
  for (const a of agg.values()) a.turnsResident = a.lastResidentTurn - a.firstSeenTurn + 1

  const blocks = [...agg.values()].sort((x, y) => y.residentCost - x.residentCost)
  const itemizedResidentTokens = blocks.reduce((n, b) => n + b.residentCost, 0)
  // The remainder stays SIGNED and labeled: a positive gap is content invisible to the transcript
  // (system prompt + tool definitions are never written to the .jsonl) plus estimator drift on
  // uncalibrated steps; a negative gap means the estimates overshot the exact usage. Clamping to 0
  // would hide a real reconciliation failure (FAIL-FAST).
  const unattributedTokens = totalContextTokens - itemizedResidentTokens
  const note = totalContextTokens > 0
    ? 'unattributedTokens = exact per-step usage minus the itemized resident-cost. The positive part is context invisible to the transcript (system prompt + tool definitions ride every turn but are never logged) plus token-estimator drift; the residency model also approximates compaction (a few preserved anchor messages ride longer than modeled). A negative value means the estimates overshot the exact usage.'
    : 'No step carried exact usage buckets — totalContextTokens is 0 and the itemization cannot be reconciled against ground truth (per-block figures remain estimates).'

  return {
    sessionId: history.sessionId,
    stepCount: steps.length,
    stepsWithUsage,
    lastTurn,
    compactionTurns,
    totalContextTokens,
    itemizedResidentTokens,
    unattributedTokens,
    note,
    blocks,
    estimated: true,
    truncated: history.truncated,
  }
}
