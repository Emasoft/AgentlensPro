// Cache-TTL regime module (TRDD-VY1IUVUM) — runtime-neutral (host, webview, standalone).
//
// THE ONE PLACE the prompt-cache TTL numbers live. Every gate/diagnostic consumer (keepWarm,
// burn-gate COLD_RESUME/COLD_FORK, gap-based warnings, the dashboard badge) imports its TTL
// from here — a grep-based test (src/test/ttlLiterals.test.ts) asserts no gate/diagnostic
// file re-declares a 5-minute TTL literal, because the hardcoded 5-min assumption is exactly
// the bug this module removes: field evidence (2026-07-11) showed subscription MAIN sessions
// riding a ~1-hour TTL, so a global 5-min constant misclassified their 20-min gaps as cold.
//
// THE DOC-VERIFIED TTL MATRIX (code.claude.com/docs/en/prompt-caching.md, verified 2026-07-11):
//
//   | Session kind          | Auth                                   | TTL      |
//   |-----------------------|----------------------------------------|----------|
//   | Main conversation     | Claude subscription (within plan)      | 1 hour   |
//   | Main conversation     | subscription drawing USAGE CREDITS     | 5 min    |
//   | Main conversation     | API key / Bedrock / GCP / Foundry      | 5 min (ENABLE_PROMPT_CACHING_1H=1 opts into 1h) |
//   | Subagent (named/gen.) | any                                    | 5 min ALWAYS (own conversation, own cache) |
//   | Fork                  | inherits parent                        | reads the PARENT's entry; every hit RESETS its timer |
//
//   FORCE_PROMPT_CACHING_5M=1 forces 5 min regardless of auth. Every cache hit resets the
//   inactivity timer. Cache scope is per machine+directory (+model +effort).
//
// HONESTY CONTRACT: classification NEVER silently guesses. Every regime carries a ttlSource:
//   'doc-matrix' — a matrix row applied to positively-resolved signals;
//   'config'     — an env override (FORCE_PROMPT_CACHING_5M / ENABLE_PROMPT_CACHING_1H) decided it;
//   'measured'   — observed cache behaviour CONTRADICTED the assumption (see keepWarm's falsifier)
//                  and the measured floor was preferred;
//   'assumed'    — a signal was absent, so the conservative 5-min floor was reported AS an assumption.

/** The only two TTL tiers Anthropic enforces (doc fact). Everything else is derived. */
export const TTL_5M_MIN = 5
export const TTL_1H_MIN = 60
export const TTL_5M_MS = TTL_5M_MIN * 60_000
export const TTL_1H_MS = TTL_1H_MIN * 60_000

/** Slack added on top of the TTL before the burn-gate calls a parent cache "cold": mtime-based
 *  idle measurement lags the real last-request time by seconds, so an exact-TTL cutoff would
 *  flap on the boundary. 30s preserves the gate's historical 5.5-min default under the 5m tier. */
export const COLD_IDLE_SLACK_MS = 30_000
export const DEFAULT_COLD_IDLE_MS = TTL_5M_MS + COLD_IDLE_SLACK_MS

/** Where a TTL number came from — surfaced verbatim on keepWarm output and gap classifications. */
export type TtlSource = 'doc-matrix' | 'config' | 'measured' | 'assumed'

/** Lineage kind for TTL purposes. Derived from the card lineage fields (sessionTtlKindOf):
 *  no parentSessionId → main; spawnKind 'fork' → fork (reads the PARENT's cache entry);
 *  any other child → subagent (own conversation, own 5-min cache). */
export type SessionTtlKind = 'main' | 'subagent' | 'fork'

/** Auth regime resolved from the machine's live account signals (src/ttlContext.ts):
 *  billingType subscription (± usage-credit overflow) vs API key. 'unknown' = signal absent. */
export type AuthRegime = 'subscription' | 'usage-credits' | 'api-key' | 'unknown'

/** Machine-level TTL signals, resolved Node-side (accountInfo + env/settings inspection) and
 *  passed into this pure classifier. null anywhere = "could not resolve" — never a guess. */
export interface TtlContext {
  auth: AuthRegime
  /** FORCE_PROMPT_CACHING_5M=1 detected (env or ~/.claude/settings.json env block). Wins over auth. */
  force5m: boolean
  /** ENABLE_PROMPT_CACHING_1H=1 detected — opts an API-key session into the 1h tier. */
  enable1h: boolean
}

/** A session's resolved TTL regime — what every TTL-aware consumer reads. */
export interface TtlRegime {
  ttlMs: number
  /** The TTL in minutes, named "assumed" because even a doc-matrix row is an assumption the
   *  measured falsifier is allowed to contradict (ttlSource flips to 'measured' when it does). */
  ttlAssumedMin: number
  ttlSource: TtlSource
  /** One human line naming WHICH signal decided the number — so a report never shows a bare
   *  minutes figure whose provenance the reader has to reverse-engineer. */
  ttlBasis: string
}

/** The no-signals fallback: the conservative 5-min floor, labeled as the assumption it is.
 *  Callers with no kind/auth resolution (e.g. the webview without a burn-status feed) use this —
 *  the numbers match the pre-TTL-awareness behaviour, but the report now SAYS it assumed. */
export const ASSUMED_TTL_REGIME: TtlRegime = {
  ttlMs: TTL_5M_MS,
  ttlAssumedMin: TTL_5M_MIN,
  ttlSource: 'assumed',
  ttlBasis: 'no kind/auth signals — conservative 5-min floor assumed',
}

/**
 * Resolve a session's TTL kind from its card lineage. spawnKind is checked BEFORE
 * parentSessionId because a fork IS a child card (parentSessionId set) yet reads the PARENT's
 * cache entry — classifying it 'subagent' would wrongly pin it to the 5-min tier.
 */
export function sessionTtlKindOf(card: { parentSessionId?: string; spawnKind?: string }): SessionTtlKind {
  if (card.spawnKind === 'fork') return 'fork'
  if (card.parentSessionId) return 'subagent'
  return 'main'
}

/**
 * The doc matrix as code. Pure: (kind, machine context) → regime. Order of the rules is
 * load-bearing:
 *   1. subagent → 5 min ALWAYS. This row is auth-INDEPENDENT (the 1h auto applies only to the
 *      main conversation), so it resolves 'doc-matrix' even when ctx is absent — the one kind
 *      whose TTL needs no machine signals.
 *   2. missing ctx / missing kind → 'assumed' (never silently guess a main session's tier).
 *   3. FORCE_PROMPT_CACHING_5M → 5 min 'config' (doc: forces 5m regardless of auth).
 *   4. main/fork by auth. A fork reads the PARENT's entry, so it rides the parent-conversation
 *      regime — for TTL purposes fork ≡ main under the same machine auth.
 */
export function classifyTtlRegime(kind: SessionTtlKind | null, ctx: TtlContext | null | undefined): TtlRegime {
  if (kind === 'subagent') {
    return {
      ttlMs: TTL_5M_MS, ttlAssumedMin: TTL_5M_MIN, ttlSource: 'doc-matrix',
      ttlBasis: 'subagent — own conversation, own 5-min cache (the 1h auto applies only to the main conversation)',
    }
  }
  if (!ctx || kind === null) return ASSUMED_TTL_REGIME
  if (ctx.force5m) {
    return {
      ttlMs: TTL_5M_MS, ttlAssumedMin: TTL_5M_MIN, ttlSource: 'config',
      ttlBasis: 'FORCE_PROMPT_CACHING_5M=1 detected — forces the 5-min tier regardless of auth',
    }
  }
  const kindLabel = kind === 'fork' ? "fork (reads the PARENT conversation's cache entry)" : 'main conversation'
  switch (ctx.auth) {
    case 'subscription':
      return {
        ttlMs: TTL_1H_MS, ttlAssumedMin: TTL_1H_MIN, ttlSource: 'doc-matrix',
        ttlBasis: `${kindLabel} on a Claude subscription within plan — automatic 1-hour tier`,
      }
    case 'usage-credits':
      return {
        ttlMs: TTL_5M_MS, ttlAssumedMin: TTL_5M_MIN, ttlSource: 'doc-matrix',
        ttlBasis: `${kindLabel} on a subscription drawing USAGE CREDITS (over plan limit) — dropped to the 5-min tier`,
      }
    case 'api-key':
      return ctx.enable1h
        ? {
            ttlMs: TTL_1H_MS, ttlAssumedMin: TTL_1H_MIN, ttlSource: 'config',
            ttlBasis: `${kindLabel} on an API key with ENABLE_PROMPT_CACHING_1H=1 — opted into the 1-hour tier`,
          }
        : {
            ttlMs: TTL_5M_MS, ttlAssumedMin: TTL_5M_MIN, ttlSource: 'doc-matrix',
            ttlBasis: `${kindLabel} on an API key / Bedrock / GCP / Foundry — 5-min default tier`,
          }
    case 'unknown':
      return ASSUMED_TTL_REGIME
  }
}

/** Short regime phrase for warning/deny messages: "60-min TTL (doc-matrix)". Message builders
 *  use this instead of a hardcoded "5-min TTL" so every user-facing number carries provenance. */
export function ttlPhrase(regime: TtlRegime): string {
  return `${regime.ttlAssumedMin}-min TTL (${regime.ttlSource})`
}
