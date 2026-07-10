// ── Token buckets — the ONE constructor for the four-disjoint-buckets invariant ──────────────────
//
// Every SessionSummaryCard and every timeline entry carries FOUR DISJOINT token buckets, each billed
// at its own rate (src/shared/pricing.ts):
//
//   inputTokens        RAW uncached input — new tokens billed at the full input rate. NEVER includes
//                      either cache bucket.
//   cacheReadTokens    prompt-cache re-reads (≈10% of the input rate)
//   cacheCreateTokens  prompt-cache writes (≈125% of the input rate)
//   outputTokens       completion tokens
//
// The invariant is grounded by measurement, not convention preference: the 2026-07-10 OTEL-vs-JSONL
// investigation (reports/token-discrepancy/20260710_141134+0200-otel-vs-jsonl.md) found the SAME
// session reading up to ~1,246× apart between feeds because one ingestion path stored inputTokens
// INCLUDING the cache buckets while another stored it raw — and the incl-cache rows double-billed
// every cache token at the full input rate in the write-time cost. The fix is structural: every
// producer routes its usage through disjointBuckets() below, so the invariant lives HERE, in one
// compile-shaped place, instead of in per-site comments that drift.
//
// This module is runtime-neutral (src/shared/): no Node imports, no DOM APIs — it is imported by the
// extension host, the standalone server, AND the webview.

export interface TokenBuckets {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
}

/** How the upstream provider shaped its `usage` payload.
 *  - 'anthropic': input_tokens is ALREADY raw/uncached — the cache buckets are reported separately
 *    and are disjoint from input (Claude API, Claude Code transcripts + OTEL spans, OpenCode,
 *    Copilot CLI shutdown metrics).
 *  - 'openai': cached tokens are a SUBSET of input_tokens (`cached ⊂ input`) — the cacheRead share
 *    must be shed from input at construction or every cached token double-bills at the full input
 *    rate (GPT/o-series usage: Codex, Copilot on OpenAI models). */
export type UsageShape = 'anthropic' | 'openai'

/** Raw usage figures as the provider reported them, BEFORE normalization. */
export interface RawUsage {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
}

// A usage figure must be a non-negative finite number; anything else (NaN from a missing attr,
// a negative from a corrupt row) collapses to 0 rather than poisoning downstream sums/costs.
function clamp(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * THE constructor of the four disjoint buckets. Every card / timeline-entry producer routes its
 * usage through here; no ingestion site subtracts or adds cache tokens inline.
 *
 * 'openai'-shaped usage sheds cacheRead from input at construction (cached ⊂ input upstream);
 * 'anthropic'-shaped usage passes through (already disjoint at the source). Either way the result
 * satisfies: inputTokens contains NO cache tokens, and the four buckets sum to the true traffic.
 */
export function disjointBuckets(usage: RawUsage, shape: UsageShape): TokenBuckets {
  const input = clamp(usage.input)
  const cacheRead = clamp(usage.cacheRead)
  return {
    // Math.max guards an inconsistent OpenAI payload (cached > input) from going negative.
    inputTokens: shape === 'openai' ? Math.max(input - cacheRead, 0) : input,
    outputTokens: clamp(usage.output),
    cacheReadTokens: cacheRead,
    cacheCreateTokens: clamp(usage.cacheCreate),
  }
}

/**
 * Context-window occupancy of a call/turn/session under the disjoint-buckets convention:
 * everything the model READ = raw input + cache re-reads + cache writes. This is the ONE derivation
 * consumers use for "how big was the prompt/context" — never entry.inputTokens alone (that is only
 * the raw uncached share since the entry normalization of 2026-07-10).
 */
export function contextTokens(b: { inputTokens?: number; cacheReadTokens?: number; cacheCreateTokens?: number }): number {
  return (b.inputTokens ?? 0) + (b.cacheReadTokens ?? 0) + (b.cacheCreateTokens ?? 0)
}
