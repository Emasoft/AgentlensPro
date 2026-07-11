// The ONE pricing table for the whole codebase — consumed by the extension host / standalone
// server (write-time `cost_usd` via calcTokenCostUsd) AND the webview (display-time cost via
// calcTokenCost + the request-billing multipliers). This file merged the two hand-synced copies
// (src/pricing.ts and media/src/pricing.ts) that drifted apart — never re-split it. It must stay
// runtime-neutral: no Node imports, no DOM APIs.
//
// Rate sources:
//   Token rates (post Jun 1, 2026):        https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
//   Request multipliers (pre Jun 1, 2026): https://docs.github.com/en/copilot/concepts/billing/copilot-requests
//   Annual-plan multipliers (post Jun 1):  https://docs.github.com/en/copilot/reference/copilot-billing/model-multipliers-for-annual-plans
//   Per-provider rate URLs: PRICING_SOURCES.md
export const PRICING_LAST_UPDATED = '2026-07-07'

// Three Copilot billing modes (webview cost toggle):
//   'token'          — new token-based AI Credits billing, effective Jun 1, 2026
//   'request'        — request-based billing with multipliers, active before Jun 1, 2026
//   'request-annual' — request-based billing for annual plan holders staying on old billing after Jun 1
//                      (multipliers increase significantly on Jun 1 for this group)
export type PricingMode = 'token' | 'request' | 'request-annual'

export interface ModelRates {
  inputPerMTok: number              // USD per 1M input tokens (token mode)
  cacheReadPerMTok: number          // USD per 1M cache-read tokens (token mode, 0 if n/a)
  cacheWritePerMTok: number         // USD per 1M cache-write tokens (token mode, 0 if n/a)
  outputPerMTok: number             // USD per 1M output tokens (token mode)
  contextWindowTokens: number       // max context window for Projection estimates; 0 = unknown
  multiplier: number                // Pre-Jun 1 Copilot request multiplier × $0.04/prompt (0 = included/free)
  multiplierAnnualPostJun1: number  // Post-Jun 1 multiplier for annual plan holders staying on request billing
  // Optional tiered rates for the >200K tokens-per-call surcharge. When absent, flat rates apply.
  // Applied per call by calcTokenCostUsd; NOT applied by calcTokenCost (which operates on session
  // totals and cannot reconstruct per-turn call sizes).
  inputAbove200kPerMTok?: number
  outputAbove200kPerMTok?: number
  cacheReadAbove200kPerMTok?: number
  cacheWriteAbove200kPerMTok?: number
}

// Keyed by normalized model ID (lowercase, no date suffix).
const RATES: Record<string, ModelRates> = {
  // ── OpenAI ─────────────────────────────────────────────────────────────────
  // included models: 0× pre-Jun1 AND $0 in token mode (included in Copilot subscription per footnote 1)
  'gpt-4.1':            { inputPerMTok: 0,     cacheReadPerMTok: 0,      cacheWritePerMTok: 0, outputPerMTok: 0,     contextWindowTokens: 1_000_000, multiplier: 0,    multiplierAnnualPostJun1: 1 },
  'gpt-5-mini':         { inputPerMTok: 0,     cacheReadPerMTok: 0,      cacheWritePerMTok: 0, outputPerMTok: 0,     contextWindowTokens: 200_000,   multiplier: 0,    multiplierAnnualPostJun1: 0.33 },
  'gpt-5 mini':         { inputPerMTok: 0,     cacheReadPerMTok: 0,      cacheWritePerMTok: 0, outputPerMTok: 0,     contextWindowTokens: 200_000,   multiplier: 0,    multiplierAnnualPostJun1: 0.33 },
  // older included models kept for historical sessions
  'gpt-4o':             { inputPerMTok: 2.50,  cacheReadPerMTok: 1.25,   cacheWritePerMTok: 0, outputPerMTok: 10.00, contextWindowTokens: 128_000,   multiplier: 0,    multiplierAnnualPostJun1: 0.33 },
  'gpt-4o-mini':        { inputPerMTok: 0.15,  cacheReadPerMTok: 0.075,  cacheWritePerMTok: 0, outputPerMTok: 0.60,  contextWindowTokens: 128_000,   multiplier: 0,    multiplierAnnualPostJun1: 0.33 },
  // GPT-5.1 family — in the annual-plan table but not in new token pricing (request-only models)
  'gpt-5.1':            { inputPerMTok: 1.75,  cacheReadPerMTok: 0.175,  cacheWritePerMTok: 0, outputPerMTok: 14.00, contextWindowTokens: 256_000,   multiplier: 1,    multiplierAnnualPostJun1: 3 },
  'gpt-5.1-codex':      { inputPerMTok: 1.75,  cacheReadPerMTok: 0.175,  cacheWritePerMTok: 0, outputPerMTok: 14.00, contextWindowTokens: 256_000,   multiplier: 1,    multiplierAnnualPostJun1: 3 },
  'gpt-5.1-codex-mini': { inputPerMTok: 0.75,  cacheReadPerMTok: 0.075,  cacheWritePerMTok: 0, outputPerMTok: 4.50,  contextWindowTokens: 256_000,   multiplier: 0.33, multiplierAnnualPostJun1: 0.33 },
  'gpt-5.1-codex-max':  { inputPerMTok: 1.75,  cacheReadPerMTok: 0.175,  cacheWritePerMTok: 0, outputPerMTok: 14.00, contextWindowTokens: 256_000,   multiplier: 1,    multiplierAnnualPostJun1: 3 },
  // premium models
  'gpt-5.2':            { inputPerMTok: 1.75,  cacheReadPerMTok: 0.175,  cacheWritePerMTok: 0, outputPerMTok: 14.00, contextWindowTokens: 256_000,   multiplier: 1,    multiplierAnnualPostJun1: 3 },
  'gpt-5.2-codex':      { inputPerMTok: 1.75,  cacheReadPerMTok: 0.175,  cacheWritePerMTok: 0, outputPerMTok: 14.00, contextWindowTokens: 256_000,   multiplier: 1,    multiplierAnnualPostJun1: 3 },
  'gpt-5.3-codex':      { inputPerMTok: 1.75,  cacheReadPerMTok: 0.175,  cacheWritePerMTok: 0, outputPerMTok: 14.00, contextWindowTokens: 256_000,   multiplier: 1,    multiplierAnnualPostJun1: 6 },
  'gpt-5.4':            { inputPerMTok: 2.50,  cacheReadPerMTok: 0.25,   cacheWritePerMTok: 0, outputPerMTok: 15.00, contextWindowTokens: 272_000,   multiplier: 1,    multiplierAnnualPostJun1: 6 },  // long-context surcharge (>272K tokens) not implemented
  'gpt-5.4-mini':       { inputPerMTok: 0.75,  cacheReadPerMTok: 0.075,  cacheWritePerMTok: 0, outputPerMTok: 4.50,  contextWindowTokens: 200_000,   multiplier: 0.33, multiplierAnnualPostJun1: 6 },
  'gpt-5.4-nano':       { inputPerMTok: 0.20,  cacheReadPerMTok: 0.02,   cacheWritePerMTok: 0, outputPerMTok: 1.25,  contextWindowTokens: 128_000,   multiplier: 0.25, multiplierAnnualPostJun1: 0.25 },
  'gpt-5.5':            { inputPerMTok: 5.00,  cacheReadPerMTok: 0.50,   cacheWritePerMTok: 0, outputPerMTok: 30.00, contextWindowTokens: 256_000,   multiplier: 7.5,  multiplierAnnualPostJun1: 7.5 },  // TBD per docs; long-context surcharge (>unknown threshold) not implemented
  // ── Codex-only ─────────────────────────────────────────────────────────────
  // codex-mini-latest: fine-tuned o4-mini; 75% cache discount (not the usual 90%); deprecated
  'codex-mini-latest':  { inputPerMTok: 1.50,  cacheReadPerMTok: 0.375,  cacheWritePerMTok: 0, outputPerMTok: 6.00,  contextWindowTokens: 200_000,   multiplier: 0,    multiplierAnnualPostJun1: 0 },
  // ── Anthropic ──────────────────────────────────────────────────────────────
  // deprecated — for historical Claude Code sessions
  'claude-opus-4':      { inputPerMTok: 15.00, cacheReadPerMTok: 1.50,  cacheWritePerMTok: 18.75, outputPerMTok: 75.00, contextWindowTokens: 200_000,   multiplier: 0,    multiplierAnnualPostJun1: 0 },
  'claude-opus-4-1':    { inputPerMTok: 15.00, cacheReadPerMTok: 1.50,  cacheWritePerMTok: 18.75, outputPerMTok: 75.00, contextWindowTokens: 200_000,   multiplier: 0,    multiplierAnnualPostJun1: 0 },
  'claude-haiku-3-5':   { inputPerMTok:  0.80, cacheReadPerMTok: 0.08,  cacheWritePerMTok:  1.00, outputPerMTok:  4.00, contextWindowTokens: 200_000,   multiplier: 0,    multiplierAnnualPostJun1: 0 },
  // current
  'claude-haiku-4-5':   { inputPerMTok:  1.00, cacheReadPerMTok: 0.10,  cacheWritePerMTok:  1.25, outputPerMTok:  5.00, contextWindowTokens: 200_000,   multiplier: 0.33, multiplierAnnualPostJun1: 0.33 },
  'claude-sonnet-4':    { inputPerMTok:  3.00, cacheReadPerMTok: 0.30,  cacheWritePerMTok:  3.75, outputPerMTok: 15.00, contextWindowTokens: 1_000_000, multiplier: 1,    multiplierAnnualPostJun1: 1,
                          inputAbove200kPerMTok: 6.00, outputAbove200kPerMTok: 22.50, cacheReadAbove200kPerMTok: 0.60, cacheWriteAbove200kPerMTok: 7.50 },
  'claude-sonnet-4-5':  { inputPerMTok:  3.00, cacheReadPerMTok: 0.30,  cacheWritePerMTok:  3.75, outputPerMTok: 15.00, contextWindowTokens: 1_000_000, multiplier: 1,    multiplierAnnualPostJun1: 6 },
  'claude-sonnet-4-6':  { inputPerMTok:  3.00, cacheReadPerMTok: 0.30,  cacheWritePerMTok:  3.75, outputPerMTok: 15.00, contextWindowTokens: 1_000_000, multiplier: 1,    multiplierAnnualPostJun1: 9 },
  // Sonnet 5 INTRODUCTORY pricing ($2/$10 per MTok, cache 0.1x/1.25x of input) bills through
  // 2026-08-31; sticker is $3/$15. Flip to 3.00/0.30/3.75/15.00 after that date. Was MISSING
  // entirely until 2026-07-07 — lookupRates returned null and 14 real sessions silently
  // billed $0 (the exact failure the unpriced flag now surfaces). Not yet in Copilot billing docs.
  'claude-sonnet-5':    { inputPerMTok:  2.00, cacheReadPerMTok: 0.20,  cacheWritePerMTok:  2.50, outputPerMTok: 10.00, contextWindowTokens: 1_000_000, multiplier: 0,    multiplierAnnualPostJun1: 0 },
  // Mythos 5 (Project Glasswing) — same pricing/limits as Fable 5. Not yet in Copilot billing docs.
  'claude-mythos-5':    { inputPerMTok: 10.00, cacheReadPerMTok: 1.00,  cacheWritePerMTok: 12.50, outputPerMTok:  50.00, contextWindowTokens: 1_000_000, multiplier: 0,   multiplierAnnualPostJun1: 0 },
  'claude-opus-4-5':    { inputPerMTok:  5.00, cacheReadPerMTok: 0.50,  cacheWritePerMTok:  6.25, outputPerMTok: 25.00, contextWindowTokens: 1_000_000, multiplier: 3,    multiplierAnnualPostJun1: 15 },
  'claude-opus-4-6':    { inputPerMTok:  5.00, cacheReadPerMTok: 0.50,  cacheWritePerMTok:  6.25, outputPerMTok: 25.00, contextWindowTokens: 1_000_000, multiplier: 3,    multiplierAnnualPostJun1: 27 },
  'claude-opus-4-7':    { inputPerMTok:  5.00, cacheReadPerMTok: 0.50,  cacheWritePerMTok:  6.25, outputPerMTok: 25.00, contextWindowTokens: 1_000_000, multiplier: 15,   multiplierAnnualPostJun1: 27 },
  'claude-opus-4-8':    { inputPerMTok:  5.00, cacheReadPerMTok: 0.50,  cacheWritePerMTok:  6.25, outputPerMTok: 25.00, contextWindowTokens: 1_000_000, multiplier: 15,   multiplierAnnualPostJun1: 27 },
  // fast mode (/fast toggle in Claude Code) — model ID appended with -fast by logReader when usage.speed === 'fast'
  'claude-opus-4-6-fast':{ inputPerMTok: 30.00, cacheReadPerMTok: 3.00, cacheWritePerMTok: 37.50, outputPerMTok: 150.00, contextWindowTokens: 1_000_000, multiplier: 30,  multiplierAnnualPostJun1: 30 },
  'claude-opus-4-7-fast':{ inputPerMTok: 30.00, cacheReadPerMTok: 3.00, cacheWritePerMTok: 37.50, outputPerMTok: 150.00, contextWindowTokens: 1_000_000, multiplier: 30,  multiplierAnnualPostJun1: 30 },
  'claude-opus-4-8-fast':{ inputPerMTok: 10.00, cacheReadPerMTok: 1.00, cacheWritePerMTok: 12.50, outputPerMTok:  50.00, contextWindowTokens: 1_000_000, multiplier: 30,  multiplierAnnualPostJun1: 30 },
  'claude-fable-5':      { inputPerMTok: 10.00, cacheReadPerMTok: 1.00, cacheWritePerMTok: 12.50, outputPerMTok:  50.00, contextWindowTokens: 1_000_000, multiplier: 0,   multiplierAnnualPostJun1: 0 },  // not yet in Copilot billing docs
  // ── Google ─────────────────────────────────────────────────────────────────
  'gemini-2.5-pro':  { inputPerMTok: 1.25, cacheReadPerMTok: 0.125, cacheWritePerMTok: 0, outputPerMTok: 10.00, contextWindowTokens: 1_000_000, multiplier: 1,    multiplierAnnualPostJun1: 1 },  // long-context surcharge (>200K tokens) not implemented
  'gemini-3-flash':  { inputPerMTok: 0.50, cacheReadPerMTok: 0.05,  cacheWritePerMTok: 0, outputPerMTok:  3.00, contextWindowTokens: 1_000_000, multiplier: 0.33, multiplierAnnualPostJun1: 0.33 },
  'gemini-3-pro':    { inputPerMTok: 2.00, cacheReadPerMTok: 0.20,  cacheWritePerMTok: 0, outputPerMTok: 12.00, contextWindowTokens: 1_000_000, multiplier: 1,    multiplierAnnualPostJun1: 6 },
  'gemini-3.1-pro':  { inputPerMTok: 2.00, cacheReadPerMTok: 0.20,  cacheWritePerMTok: 0, outputPerMTok: 12.00, contextWindowTokens: 1_000_000, multiplier: 1,    multiplierAnnualPostJun1: 6 },  // long-context surcharge (>200K tokens) not implemented
  'gemini-3.5-flash':{ inputPerMTok: 1.50, cacheReadPerMTok: 0.15,  cacheWritePerMTok: 0, outputPerMTok:  9.00, contextWindowTokens: 1_000_000, multiplier: 14,   multiplierAnnualPostJun1: 14 },
  // ── Fine-tuned ─────────────────────────────────────────────────────────────
  // raptor-mini uses GPT-5 mini pricing per footnote 5 — included ($0) in token mode, same annual multiplier
  'raptor-mini': { inputPerMTok: 0,    cacheReadPerMTok: 0,     cacheWritePerMTok: 0, outputPerMTok:  0,     contextWindowTokens: 0, multiplier: 0, multiplierAnnualPostJun1: 0.33 },
  'goldeneye':   { inputPerMTok: 1.25, cacheReadPerMTok: 0.125, cacheWritePerMTok: 0, outputPerMTok: 10.00, contextWindowTokens: 0, multiplier: 0, multiplierAnnualPostJun1: 0 },
  // ── OpenCode Zen  https://opencode.ai/docs/zen/ ────────────────────────────
  // big-pickle: OpenCode's stealth model, free during limited evaluation period.
  'big-pickle':  { inputPerMTok: 0,    cacheReadPerMTok: 0,     cacheWritePerMTok: 0, outputPerMTok:  0,     contextWindowTokens: 200_000, multiplier: 0, multiplierAnnualPostJun1: 0 },
}

function normalizeModelId(modelId: string): string {
  return modelId
    .toLowerCase()
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')  // strip date suffix e.g. -2025-04-14
    .replace(/-\d{8}$/, '')               // strip YYYYMMDD suffix e.g. -20260501
    .trim()
}

export function lookupRates(modelId: string): ModelRates | null {
  if (!modelId) return null
  const normalized = normalizeModelId(modelId)
  if (RATES[normalized]) return RATES[normalized]
  // Prefix match for versioned/aliased IDs that are LONGER than a family key (e.g. an un-stripped alias
  // of `claude-sonnet-5`). ONLY this direction is valid. The reverse — `key.startsWith(normalized)`,
  // matching when the query is SHORTER than a key — mapped a bare id onto an arbitrary longer key's
  // rates in insertion order: `gpt-5` matched the first-inserted `gpt-5-mini` (input $0), silently
  // pricing a real gpt-5 session at $0; `gemini-3` matched `gemini-3-flash` instead of `-pro`. Among
  // several family-prefix matches, prefer the LONGEST (most specific) key; no match stays null so the
  // caller's `unpriced` flag surfaces an unknown model rather than guessing a wrong rate.
  let best: string | null = null
  for (const key of Object.keys(RATES)) {
    if (normalized.startsWith(key) && (best === null || key.length > best.length)) best = key
  }
  return best ? RATES[best] : null
}

// Applies two-tier pricing: tokens up to the threshold at baseRate, remainder at aboveRate.
function tieredCost(tokens: number, baseRatePerMTok: number, aboveRatePerMTok: number): number {
  const THRESHOLD = 200_000
  if (tokens <= THRESHOLD) return (tokens / 1_000_000) * baseRatePerMTok
  return (THRESHOLD / 1_000_000) * baseRatePerMTok
       + ((tokens - THRESHOLD) / 1_000_000) * aboveRatePerMTok
}

// Model-id-keyed cost with the >200K per-call tiered surcharge — the write-time path (cost_usd
// stored in the sessions table) where the caller has per-call buckets.
export function calcTokenCostUsd(
  inputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  outputTokens: number,
  modelId: string,
): number {
  const rates = lookupRates(modelId)
  if (!rates) return 0
  if (rates.inputAbove200kPerMTok !== undefined) {
    return tieredCost(inputTokens,     rates.inputPerMTok,      rates.inputAbove200kPerMTok)
         + tieredCost(cacheReadTokens,  rates.cacheReadPerMTok,  rates.cacheReadAbove200kPerMTok!)
         + tieredCost(cacheWriteTokens, rates.cacheWritePerMTok, rates.cacheWriteAbove200kPerMTok!)
         + tieredCost(outputTokens,     rates.outputPerMTok,     rates.outputAbove200kPerMTok!)
  }
  return (inputTokens     / 1_000_000) * rates.inputPerMTok
       + (cacheReadTokens / 1_000_000) * rates.cacheReadPerMTok
       + (cacheWriteTokens/ 1_000_000) * rates.cacheWritePerMTok
       + (outputTokens    / 1_000_000) * rates.outputPerMTok
}

// Rates-keyed flat cost — the display-time path (webview session/entry cost). Operates on session
// totals, so the per-call >200K tiered surcharge cannot be reconstructed and is deliberately NOT
// applied here. inputTokens should be the raw (non-cached) input count.
export function calcTokenCost(
  inputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  outputTokens: number,
  rates: ModelRates,
): number {
  return (inputTokens      / 1_000_000) * rates.inputPerMTok
       + (cacheReadTokens  / 1_000_000) * rates.cacheReadPerMTok
       + (cacheWriteTokens / 1_000_000) * rates.cacheWritePerMTok
       + (outputTokens     / 1_000_000) * rates.outputPerMTok
}
