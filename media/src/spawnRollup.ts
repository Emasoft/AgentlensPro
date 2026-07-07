import type {
  SessionSummaryCard, SpawnRollup, SpawnKindMix, SpawnDetection,
} from './types'

// ── Spawn-cost rollup + cache-friendly-spawn advisor (TRDD-62E8UU41) ──────────
// Pure, runtime-neutral aggregation over a parent's sub-agent children (all children of a session, or
// the children spawned by one turn). It answers the question the founding fable-5 burn made manual:
// "this ONE fan-out caused N children × M cache-create = X tokens / $Y — and here is the cheaper spawn
// shape." The cost function is injected (`costOf`) so each runtime supplies its own pricing (the MCP's
// normalizing sessionCost, or the webview's calcSessionCost) without this module depending on either.
// MIRRORED verbatim from src/spawnRollup.ts — change both (like cacheBreak.ts / residentCost.ts).

// A child that WROTE a big prefix (cache_creation ≥ this) but did NOT read a comparably big prefix is
// cache-COLD: it re-billed the inherited context at write rate (~1.25×) instead of reading the parent
// cache (~0.1×). 100k is the "large inherited prefix" floor — below it the re-bill is not worth a flag.
export const COLD_CACHE_CREATE_MIN = 100_000
// "near-zero cache-read": a cold child reads back at most this FRACTION of what it wrote. A fork, by
// contrast, reads the parent cache so cache_read dominates — that is exactly what this ratio excludes.
export const NEAR_ZERO_READ_RATIO = 0.2
// A fan-out is a "fleet" once ≥3 cold children re-bill their own prefixes (the founding-burn shape).
export const FLEET_COLD_MIN_CHILDREN = 3
// "Scatter" / "mix" need ≥2 implicated children — a single one is not a pattern worth a fleet-level flag.
export const WORKTREE_SCATTER_MIN_CHILDREN = 2
export const MODEL_MIX_MIN_CHILDREN = 2

export interface SpawnRollupOptions {
  parentModel: string
  costOf: (c: SessionSummaryCard) => number
}

// The model a child actually ran on: its requested override if any, else its resolved model. Used for
// MODEL-MIX (a child on a different model than the parent shares no cache — caches are model-specific).
function childModel(c: SessionSummaryCard): string {
  return c.spawnModelOverride || c.model || ''
}

// Cache-COLD signature: wrote a big prefix, read back almost none of it. This is deliberately derived
// from the RECORDED buckets (not spawnKind) so a mislabeled/unknown-kind child that still re-billed a
// huge prefix is caught — the detection is about observed cache behavior, not the spawn label.
function isColdChild(c: SessionSummaryCard): boolean {
  return c.cacheCreateTokens >= COLD_CACHE_CREATE_MIN
    && c.cacheReadTokens <= c.cacheCreateTokens * NEAR_ZERO_READ_RATIO
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return Math.round(n / 1_000) + 'k'
  return String(n)
}

function fmtUsd(n: number): string {
  if (n <= 0) return '$0'
  if (n < 0.01) return '<$0.01'
  return '$' + n.toFixed(2)
}

// Σ cost of a child set, rounded once (avoids compounding float noise across many children).
function sumCost(cards: SessionSummaryCard[], costOf: (c: SessionSummaryCard) => number): number {
  return +cards.reduce((n, c) => n + costOf(c), 0).toFixed(4)
}

// Σ cache_creation of a child set — the tokens they re-billed as writes (the avoidable prefix write).
function sumCacheCreate(cards: SessionSummaryCard[]): number {
  return cards.reduce((n, c) => n + c.cacheCreateTokens, 0)
}

export function detectSpawnAntipatterns(
  children: SessionSummaryCard[],
  opts: SpawnRollupOptions,
): SpawnDetection[] {
  const out: SpawnDetection[] = []

  // FLEET-COLD — ≥3 children each wrote a large prefix and read back almost none of it. Each re-billed
  // the inherited context instead of reading the parent cache: the founding fleet-of-cold-forks burn.
  const cold = children.filter(isColdChild)
  if (cold.length >= FLEET_COLD_MIN_CHILDREN) {
    const wastedTokens = sumCacheCreate(cold)
    const wastedCostUsd = sumCost(cold, opts.costOf)
    out.push({
      code: 'FLEET-COLD', severity: 'HIGH', childCount: cold.length,
      wastedTokens, wastedCostUsd,
      message: `${cold.length} cold children each re-billed a large inherited prefix `
        + `(Σ ${fmtTokens(wastedTokens)} cache-create, ${fmtUsd(wastedCostUsd)}) instead of reading the parent cache.`,
      remediation: 'Fork the children (subagent_type: "fork") so each reads the parent cache, or trim the inherited context before fanning out.',
    })
  }

  // WORKTREE-SCATTER — ≥2 worktree-isolated children doing cache-heavy work. A worktree has its own cwd,
  // so the system-prompt prefix (cwd/OS/git) differs from the parent's → a separate cache scope that
  // shares nothing with the parent; each such child pays a full cold start.
  const wt = children.filter(c =>
    (c.spawnKind === 'worktree' || c.spawnIsolation === 'worktree') && c.cacheCreateTokens >= COLD_CACHE_CREATE_MIN)
  if (wt.length >= WORKTREE_SCATTER_MIN_CHILDREN) {
    const wastedTokens = sumCacheCreate(wt)
    const wastedCostUsd = sumCost(wt, opts.costOf)
    out.push({
      code: 'WORKTREE-SCATTER', severity: 'MEDIUM', childCount: wt.length,
      wastedTokens, wastedCostUsd,
      message: `${wt.length} worktree-isolated children ran cache-heavy work `
        + `(Σ ${fmtTokens(wastedTokens)} cache-create, ${fmtUsd(wastedCostUsd)}); each worktree's own cwd is a separate cache scope that shares nothing with the parent.`,
      remediation: 'Run cache-heavy fan-out in the parent cwd (no worktree isolation) so children share the parent prefix; reserve worktrees for work that truly needs an isolated checkout.',
    })
  }

  // MODEL-MIX — ≥2 children on a DIFFERENT model than the parent with large prefixes. Caches are
  // model-specific, so a child on another model cannot reuse the parent cache and must re-warm its own.
  const parent = opts.parentModel || ''
  const mixed = parent
    ? children.filter(c => {
        const m = childModel(c)
        return m !== '' && m !== parent && c.cacheCreateTokens >= COLD_CACHE_CREATE_MIN
      })
    : []
  if (mixed.length >= MODEL_MIX_MIN_CHILDREN) {
    const wastedTokens = sumCacheCreate(mixed)
    const wastedCostUsd = sumCost(mixed, opts.costOf)
    out.push({
      code: 'MODEL-MIX', severity: 'MEDIUM', childCount: mixed.length,
      wastedTokens, wastedCostUsd,
      message: `${mixed.length} children ran on a different model than the parent (${parent}) with large prefixes `
        + `(Σ ${fmtTokens(wastedTokens)} cache-create, ${fmtUsd(wastedCostUsd)}); caches are model-specific, so none reused the parent cache.`,
      remediation: 'Keep the fan-out on the parent model unless a child truly needs another model — a model override starts a separate cache the child must re-warm.',
    })
  }

  return out
}

export function buildSpawnRollup(children: SessionSummaryCard[], opts: SpawnRollupOptions): SpawnRollup {
  const mix: SpawnKindMix = { fresh: 0, fork: 0, worktree: 0, fleet: 0, modelOverride: 0, unknown: 0 }
  let totalInput = 0, totalOutput = 0, totalRead = 0, totalCreate = 0
  for (const c of children) {
    totalInput  += c.inputTokens
    totalOutput += c.outputTokens
    totalRead   += c.cacheReadTokens
    totalCreate += c.cacheCreateTokens
    // FAIL-FAST: an absent or unrecognized spawnKind is counted `unknown`, never assumed `fresh` — a
    // mislabeled cold fork must show up as unknown so the mix stays honest.
    switch (c.spawnKind) {
      case 'fresh':    mix.fresh++; break
      case 'fork':     mix.fork++; break
      case 'worktree': mix.worktree++; break
      case 'fleet':    mix.fleet++; break
      default:         mix.unknown++; break
    }
    if (c.spawnModelOverride) mix.modelOverride++
  }
  return {
    childCount: children.length,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCacheReadTokens: totalRead,
    totalCacheCreateTokens: totalCreate,
    totalCostUsd: sumCost(children, opts.costOf),
    kindMix: mix,
    detections: detectSpawnAntipatterns(children, opts),
  }
}
