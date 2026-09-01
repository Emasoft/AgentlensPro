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
export const PRICING_LAST_UPDATED = '2026-09-01'

// Three Copilot billing modes (webview cost toggle):
//   'token'          — new token-based AI Credits billing, effective Jun 1, 2026
//   'request'        — request-based billing with multipliers, active before Jun 1, 2026
//   'request-annual' — request-based billing for annual plan holders staying on old billing after Jun 1
//                      (multipliers increase significantly on Jun 1 for this group)
export type PricingMode = 'token' | 'request' | 'request-annual'

export interface ModelRates {
  inputPerMTok: number              // USD per 1M input tokens (token mode)
  cacheReadPerMTok: number          // USD per 1M cache-read tokens (token mode, 0 if n/a)
  cacheWritePerMTok: number         // USD per 1M cache-write tokens, 5-MINUTE TTL tier (0 if n/a)
  // USD per 1M cache-write tokens at the 1-HOUR TTL tier. Optional: when absent it is derived (see
  // cacheWrite1hRate). The tier is NOT cosmetic — Claude Code puts every main-conversation turn on
  // a subscription into the 1h tier automatically, so this is the rate most writes on such a
  // machine actually pay, and pricing them at the 5m rate under-reports by 60%.
  cacheWrite1hPerMTok?: number
  outputPerMTok: number             // USD per 1M output tokens (token mode)
  contextWindowTokens: number       // max context window for Projection estimates; 0 = unknown
  multiplier: number                // Pre-Jun 1 Copilot request multiplier × $0.04/prompt (0 = included/free)
  multiplierAnnualPostJun1: number  // Post-Jun 1 multiplier for annual plan holders staying on request billing
  // Optional long-context surcharge rates. When absent, flat rates apply.
  //
  // SEMANTICS (settled from the LIVE provider rate pages, 2026-08-26 — TRDD-R4DHDK7L): every
  // provider that tiers prices it as a WHOLE-REQUEST STEP keyed on the request's total input size
  // (input + cacheRead + cacheWrite; output does not count toward the threshold). Once the total
  // crosses `surchargeThresholdTokens`, ALL buckets of that request — including output — bill at
  // the Above rates; below it, everything bills flat. It is NOT marginal per-bucket tiering.
  //   - Gemini: "$1.25, prompts <= 200k tokens / $2.50, prompts > 200k" — rate keyed by prompt size
  //     (ai.google.dev/gemini-api/docs/pricing)
  //   - OpenAI: rate tables keyed "(<272K context length)" vs long-context
  //     (developers.openai.com/api/docs/pricing)
  //   - Anthropic (historical Sonnet 4 1M beta): premium keyed on requests exceeding 200K input
  //     tokens. Current Claude models have NO surcharge: "Claude 4.6 and later models include the
  //     full 1M token context window at standard pricing. (A 900k-token request is billed at the
  //     same per-token rate as a 9k-token request.)"
  //     (platform.claude.com/docs/en/about-claude/pricing#long-context-pricing)
  // Field names keep the historical "Above200k" spelling for 1:1 Rust field mapping; the actual
  // threshold is `surchargeThresholdTokens` (default 200_000 when absent).
  // Applied per call by calcTokenCostUsd; NOT applied by calcTokenCost (which operates on session
  // totals and cannot reconstruct per-turn call sizes).
  inputAbove200kPerMTok?: number
  outputAbove200kPerMTok?: number
  cacheReadAbove200kPerMTok?: number
  cacheWriteAbove200kPerMTok?: number
  surchargeThresholdTokens?: number
  // An ANNOUNCED future rate change, applied by lookupRates once the CALL's own timestamp reaches
  // `from` (an ISO date, UTC). This exists because a promotional rate with a published end date is
  // the one pricing error that arrives on a schedule with no code change and no signal: the number
  // simply goes quiet-wrong overnight. A comment saying "flip this after <date>" (which is what
  // claude-sonnet-5 carried) only works if a human happens to read it that morning.
  //
  // Gating on the CALL's timestamp, not on today's date, is the load-bearing part: a session
  // recorded during the promo must keep pricing at what it ACTUALLY cost forever, the same reason
  // `claude-opus-4-7-fast` is retained at its old premium rates. A single "current rate" table
  // silently rewrites history every time a rate changes.
  scheduledChange?: { from: string; rates: Partial<ModelRates>; note: string }
}

// TWO documented ways the harness's own `cost_usd` legitimately diverges from this table
// (CC 2.1.239/2.1.243, TRDD-SIGBCMGL) — neither is an anomaly and neither should be "fixed" here:
//  * a `modelPricing` managed setting substitutes an org's CONTRACTED per-model rates and discount
//    multiplier into /cost, the status line, and telemetry cost figures;
//  * data-residency (US-only inference) workspaces carry a 1.1x premium the harness includes.
// This table stays LIST price. Doctrine already prefers a harness-reported cost_usd over
// recomputing; a diagnostic comparing the two must label a systematic org-wide offset as
// contracted/premium rates rather than flagging a pricing-table bug.

// Keyed by normalized model ID (lowercase, no date suffix).
// Exported ONLY for scripts/export-pricing.js, which derives rust-core's embedded pricing.json
// from this table (TRDD-DMWOBWFH): the Rust core must never carry a hand-maintained rates
// mirror, so it consumes a generated artifact that `pnpm run check-pricing-export` keeps in
// lockstep. Code paths keep using lookupRates/calcTokenCostUsd — never read RATES directly.
export const RATES: Record<string, ModelRates> = {
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
  // gpt-5.4/gpt-5.5 window: 1,050,000 per the live model pages (the old 272_000/256_000 were
  // stale — the surcharge threshold 272K would have been unreachable inside its own window).
  'gpt-5.4':            { inputPerMTok: 2.50,  cacheReadPerMTok: 0.25,   cacheWritePerMTok: 0, outputPerMTok: 15.00, contextWindowTokens: 1_050_000, multiplier: 1,    multiplierAnnualPostJun1: 6,
                          inputAbove200kPerMTok: 5.00, outputAbove200kPerMTok: 22.50, cacheReadAbove200kPerMTok: 0.50, cacheWriteAbove200kPerMTok: 0, surchargeThresholdTokens: 272_000 },
  'gpt-5.4-mini':       { inputPerMTok: 0.75,  cacheReadPerMTok: 0.075,  cacheWritePerMTok: 0, outputPerMTok: 4.50,  contextWindowTokens: 200_000,   multiplier: 0.33, multiplierAnnualPostJun1: 6 },
  'gpt-5.4-nano':       { inputPerMTok: 0.20,  cacheReadPerMTok: 0.02,   cacheWritePerMTok: 0, outputPerMTok: 1.25,  contextWindowTokens: 128_000,   multiplier: 0.25, multiplierAnnualPostJun1: 0.25 },
  'gpt-5.5':            { inputPerMTok: 5.00,  cacheReadPerMTok: 0.50,   cacheWritePerMTok: 0, outputPerMTok: 30.00, contextWindowTokens: 1_050_000, multiplier: 7.5,  multiplierAnnualPostJun1: 7.5,
                          inputAbove200kPerMTok: 10.00, outputAbove200kPerMTok: 45.00, cacheReadAbove200kPerMTok: 1.00, cacheWriteAbove200kPerMTok: 0, surchargeThresholdTokens: 272_000 },
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
  // 2026-08-31; sticker is $3/$15. The flip is now DATA (`scheduledChange`), not a comment asking a
  // future human to hand-edit these four numbers on the right morning — that comment was here, was
  // correct, and would still have under-reported every sonnet-5 call by 50% from 2026-09-01 because
  // nothing fires on a date. Was MISSING entirely until 2026-07-07 — lookupRates returned null and
  // 14 real sessions silently billed $0 (the exact failure the unpriced flag now surfaces). Not yet
  // in Copilot billing docs.
  'claude-sonnet-5':    { inputPerMTok:  2.00, cacheReadPerMTok: 0.20,  cacheWritePerMTok:  2.50, outputPerMTok: 10.00, contextWindowTokens: 1_000_000, multiplier: 0,    multiplierAnnualPostJun1: 0,
                          scheduledChange: { from: '2026-09-01', note: 'introductory pricing ends 2026-08-31; reverts to $3/$15 sticker',
                                             rates: { inputPerMTok: 3.00, cacheReadPerMTok: 0.30, cacheWritePerMTok: 3.75, outputPerMTok: 15.00 } } },
  // Mythos 5 (Project Glasswing) — same pricing/limits as Fable 5. Not yet in Copilot billing docs.
  'claude-mythos-5':    { inputPerMTok: 10.00, cacheReadPerMTok: 1.00,  cacheWritePerMTok: 12.50, outputPerMTok:  50.00, contextWindowTokens: 1_000_000, multiplier: 0,   multiplierAnnualPostJun1: 0 },
  'claude-opus-4-5':    { inputPerMTok:  5.00, cacheReadPerMTok: 0.50,  cacheWritePerMTok:  6.25, outputPerMTok: 25.00, contextWindowTokens: 1_000_000, multiplier: 3,    multiplierAnnualPostJun1: 15 },
  'claude-opus-4-6':    { inputPerMTok:  5.00, cacheReadPerMTok: 0.50,  cacheWritePerMTok:  6.25, outputPerMTok: 25.00, contextWindowTokens: 1_000_000, multiplier: 3,    multiplierAnnualPostJun1: 27 },
  'claude-opus-4-7':    { inputPerMTok:  5.00, cacheReadPerMTok: 0.50,  cacheWritePerMTok:  6.25, outputPerMTok: 25.00, contextWindowTokens: 1_000_000, multiplier: 15,   multiplierAnnualPostJun1: 27 },
  'claude-opus-4-8':    { inputPerMTok:  5.00, cacheReadPerMTok: 0.50,  cacheWritePerMTok:  6.25, outputPerMTok: 25.00, contextWindowTokens: 1_000_000, multiplier: 15,   multiplierAnnualPostJun1: 27 },
  // Opus 5 — same sticker as 4.8 ($5/$6.25/$0.50/$25). Was MISSING until 2026-07-26: lookupRates
  // prefix-matches only LONGER ids, so `claude-opus-5` matched no key at all and every opus-5 call
  // priced at $0 (the same silent-$0 failure claude-sonnet-5 hit). Copilot multipliers unknown for
  // a model this new — left 0 rather than copied from 4.8, so an absent multiplier reads as absent.
  'claude-opus-5':      { inputPerMTok:  5.00, cacheReadPerMTok: 0.50,  cacheWritePerMTok:  6.25, outputPerMTok: 25.00, contextWindowTokens: 1_000_000, multiplier: 0,    multiplierAnnualPostJun1: 0 },
  // fast mode (/fast toggle in Claude Code) — model ID appended with -fast by logReader when usage.speed === 'fast'
  // Opus 4.6 ACCEPTS speed:'fast' but runs at standard speed and is "billed at standard rates"
  // (pricing doc, re-read 2026-07-26). So a 4.6 call tagged -fast must price at the STANDARD 4.6
  // rates — the old 30.00/150.00 here over-billed such a call 6x. Kept as an entry rather than
  // deleted because logReader still appends -fast whenever usage.speed === 'fast'.
  'claude-opus-4-6-fast':{ inputPerMTok:  5.00, cacheReadPerMTok: 0.50, cacheWritePerMTok:  6.25, outputPerMTok:  25.00, contextWindowTokens: 1_000_000, multiplier: 30,  multiplierAnnualPostJun1: 30 },
  // Opus 4.7 was REMOVED from fast mode in Claude Code 2.1.219 — speed:'fast' now returns an error,
  // so no NEW call can carry this id. Retained at the old premium rates because sessions recorded
  // while 4.7 fast mode existed are still on disk and must keep pricing at what they actually cost.
  'claude-opus-4-7-fast':{ inputPerMTok: 30.00, cacheReadPerMTok: 3.00, cacheWritePerMTok: 37.50, outputPerMTok: 150.00, contextWindowTokens: 1_000_000, multiplier: 30,  multiplierAnnualPostJun1: 30 },
  'claude-opus-4-8-fast':{ inputPerMTok: 10.00, cacheReadPerMTok: 1.00, cacheWritePerMTok: 12.50, outputPerMTok:  50.00, contextWindowTokens: 1_000_000, multiplier: 30,  multiplierAnnualPostJun1: 30 },
  // Fast mode applies to Opus 5 + Opus 4.8 only (CC 2.1.219). $10 in / $50 out; cache write and read
  // stay at the standard 1.25x / 0.1x of THIS (premium) input rate, not of the standard one.
  'claude-opus-5-fast': { inputPerMTok: 10.00, cacheReadPerMTok: 1.00, cacheWritePerMTok: 12.50, outputPerMTok:  50.00, contextWindowTokens: 1_000_000, multiplier: 0,   multiplierAnnualPostJun1: 0 },
  'claude-fable-5':      { inputPerMTok: 10.00, cacheReadPerMTok: 1.00, cacheWritePerMTok: 12.50, outputPerMTok:  50.00, contextWindowTokens: 1_000_000, multiplier: 0,   multiplierAnnualPostJun1: 0 },  // not yet in Copilot billing docs
  // claude-fable-5-1 (CC 2.1.257, 2026-09-01, the new default Fable): $10/$50 with a $0.25/MTok cache
  // READ — 2.5% of input, NOT the usual 10% — per the changelog (DOC-SOURCED; too few local samples to
  // solve it from cost_usd yet — re-verify with `statusline-history cache` once a session has turns).
  // The key MUST exist explicitly: lookupRates prefix-matches a LONGER id onto a shorter family key,
  // so without it `claude-fable-5-1` silently billed at fable-5's $1.00 reads (4x high). Write stays
  // the 1.25x shape so the 1h tier derives to 2x like every other Anthropic entry.
  'claude-fable-5-1':    { inputPerMTok: 10.00, cacheReadPerMTok: 0.25, cacheWritePerMTok: 12.50, outputPerMTok:  50.00, contextWindowTokens: 1_000_000, multiplier: 0,   multiplierAnnualPostJun1: 0 },
  // ── Google ─────────────────────────────────────────────────────────────────
  'gemini-2.5-pro':  { inputPerMTok: 1.25, cacheReadPerMTok: 0.125, cacheWritePerMTok: 0, outputPerMTok: 10.00, contextWindowTokens: 1_000_000, multiplier: 1,    multiplierAnnualPostJun1: 1,
                       inputAbove200kPerMTok: 2.50, outputAbove200kPerMTok: 15.00, cacheReadAbove200kPerMTok: 0.25, cacheWriteAbove200kPerMTok: 0 },
  'gemini-3-flash':  { inputPerMTok: 0.50, cacheReadPerMTok: 0.05,  cacheWritePerMTok: 0, outputPerMTok:  3.00, contextWindowTokens: 1_000_000, multiplier: 0.33, multiplierAnnualPostJun1: 0.33 },
  // gemini-3-pro is DELISTED from the live pricing page (superseded by 3.1); it launched with the
  // identical <=200k / >200k tier split 3.1 still shows. Retained with that tiering so recorded
  // sessions keep pricing at what they actually cost (same precedent as claude-opus-4-7-fast).
  'gemini-3-pro':    { inputPerMTok: 2.00, cacheReadPerMTok: 0.20,  cacheWritePerMTok: 0, outputPerMTok: 12.00, contextWindowTokens: 1_000_000, multiplier: 1,    multiplierAnnualPostJun1: 6,
                       inputAbove200kPerMTok: 4.00, outputAbove200kPerMTok: 18.00, cacheReadAbove200kPerMTok: 0.40, cacheWriteAbove200kPerMTok: 0 },
  'gemini-3.1-pro':  { inputPerMTok: 2.00, cacheReadPerMTok: 0.20,  cacheWritePerMTok: 0, outputPerMTok: 12.00, contextWindowTokens: 1_000_000, multiplier: 1,    multiplierAnnualPostJun1: 6,
                       inputAbove200kPerMTok: 4.00, outputAbove200kPerMTok: 18.00, cacheReadAbove200kPerMTok: 0.40, cacheWriteAbove200kPerMTok: 0 },
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

/** Resolve a scheduled rate change against the timestamp of the call being priced.
 *
 *  `atIso` is the CALL's own timestamp, not the current time. Omitting it means "price at today's
 *  rate", which is the right answer for a caller that has no timestamp (a live estimate, a
 *  what-does-this-cost question) but the WRONG one for historical data — so every call site that
 *  knows when the call happened must pass it. An unparseable value is treated as absent rather than
 *  as epoch 0, because NaN comparisons are false and would silently pin such a call to the pre-change
 *  rate forever — the exact silent-wrong-number failure this whole mechanism exists to prevent. */
function applyScheduledChange(rates: ModelRates, atIso?: string): ModelRates {
  const change = rates.scheduledChange
  if (!change) return rates
  const at = atIso === undefined ? Date.now() : Date.parse(atIso)
  const effective = Date.parse(change.from)
  if (!Number.isFinite(effective)) return rates
  const when = Number.isFinite(at) ? at : Date.now()
  return when >= effective ? { ...rates, ...change.rates } : rates
}

export function lookupRates(modelId: string, atIso?: string): ModelRates | null {
  if (!modelId) return null
  const normalized = normalizeModelId(modelId)
  if (RATES[normalized]) return applyScheduledChange(RATES[normalized], atIso)
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
  return best ? applyScheduledChange(RATES[best], atIso) : null
}

// The long-context surcharge is a WHOLE-REQUEST STEP, not marginal per-bucket tiering: once the
// request's total input size (input + cacheRead + cacheWrite) crosses the threshold, EVERY bucket
// bills at the Above rates. Settled from the live provider rate pages (see the ModelRates field
// comment); the previous per-bucket marginal tieredCost under-billed — e.g. 150K input + 150K
// cacheRead never tripped any bucket's 200K even though the provider bills the whole request at
// the premium rate.

/** The 1-HOUR cache-write rate for a model.
 *
 *  Anthropic prices a 5-minute cache write at 1.25x base input and a 1-hour write at 2x. Verified
 *  against Claude Code's OWN `cost_usd` (2026-07-26): solving the implied rate over ~700 opus calls
 *  gives a median of exactly $10.00/MTok (= 2x the $5.00 input rate) with a p10 of exactly $6.25
 *  (= 1.25x), and joining those calls to their raw bodies the implied rate matches the body's
 *  `usage.cache_creation.ephemeral_{5m,1h}` tier 26/26.
 *
 *  An explicit `cacheWrite1hPerMTok` always wins. Otherwise the 2x rule is applied ONLY when the
 *  table's write rate has the Anthropic 1.25x shape — a provider that prices writes differently, or
 *  not at all (`cacheWritePerMTok: 0`, as every non-Anthropic entry here does), must never be handed
 *  a derived rate it does not charge. Deriving rather than hand-editing ~15 entries also means a
 *  future Claude model is priced correctly the moment its input rate is added. */
export function cacheWrite1hRate(rates: ModelRates): number {
  if (rates.cacheWrite1hPerMTok !== undefined) return rates.cacheWrite1hPerMTok
  const anthropicShape = rates.cacheWritePerMTok > 0
    && Math.abs(rates.cacheWritePerMTok - rates.inputPerMTok * 1.25) < 1e-9
  return anthropicShape ? rates.inputPerMTok * 2 : rates.cacheWritePerMTok
}

// Model-id-keyed cost with the >200K per-call tiered surcharge — the write-time path (cost_usd
// stored in the sessions table) where the caller has per-call buckets.
//
// `cacheWrite1hTokens` is the portion OF `cacheWriteTokens` that was written at the 1-hour TTL
// (from `usage.cache_creation.ephemeral_1h_input_tokens`). It defaults to 0, so a caller that does
// not know the split keeps today's all-5m pricing exactly — the correction is opt-in per call site
// and can never silently move a number the caller did not intend to change.
export function calcTokenCostUsd(
  inputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  outputTokens: number,
  modelId: string,
  cacheWrite1hTokens = 0,
  // The call's own timestamp, used only to resolve an announced rate change (see `scheduledChange`).
  // Omitted = price at today's rate. Pass it wherever the call's time is known so historical data
  // keeps billing at what it actually cost.
  atIso?: string,
): number {
  const rates = lookupRates(modelId, atIso)
  if (!rates) return 0
  // Clamp: the 1h portion cannot exceed the total, and a caller passing a bogus negative must not
  // produce a credit. Whatever is left over is the 5-minute tier.
  const w1h = Math.max(0, Math.min(cacheWrite1hTokens, cacheWriteTokens))
  const w5m = cacheWriteTokens - w1h
  const rate1h = cacheWrite1hRate(rates)
  const totalInput = inputTokens + cacheReadTokens + cacheWriteTokens
  const threshold = rates.surchargeThresholdTokens ?? 200_000
  if (rates.inputAbove200kPerMTok !== undefined && totalInput > threshold) {
    // Whole-request step (see tieredCost comment above): every bucket at the premium rate.
    // Premium 1h write: same derivation rule as cacheWrite1hRate — 2x premium input only when the
    // premium 5m write has the Anthropic 1.25x shape (sonnet-4's 7.50 = 1.25 x 6.00); a provider
    // that does not price writes (Above 0) must never be handed a derived rate it does not charge.
    const wAbove = rates.cacheWriteAbove200kPerMTok!
    const anthropicShape = wAbove > 0 && Math.abs(wAbove - rates.inputAbove200kPerMTok * 1.25) < 1e-9
    const w1hAboveRate = anthropicShape ? rates.inputAbove200kPerMTok * 2 : wAbove
    return (inputTokens     / 1_000_000) * rates.inputAbove200kPerMTok
         + (cacheReadTokens / 1_000_000) * rates.cacheReadAbove200kPerMTok!
         + (w5m             / 1_000_000) * wAbove
         + (w1h             / 1_000_000) * w1hAboveRate
         + (outputTokens    / 1_000_000) * rates.outputAbove200kPerMTok!
  }
  return (inputTokens     / 1_000_000) * rates.inputPerMTok
       + (cacheReadTokens / 1_000_000) * rates.cacheReadPerMTok
       + (w5m             / 1_000_000) * rates.cacheWritePerMTok
       + (w1h             / 1_000_000) * rate1h
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
