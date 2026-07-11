/**
 * Machine-level TTL-signal resolution (TRDD-VY1IUVUM) — the Node-side, I/O half feeding the pure
 * classifier in src/shared/cacheTtl. It answers: which AUTH regime is this machine's Claude Code
 * running under, and are the prompt-caching env overrides set?
 *
 * Signals used (all best-effort, all fail-soft — an unresolvable signal yields 'unknown'/false so
 * the classifier reports 'assumed' instead of guessing):
 *   - auth: getCurrentAccount() (~/.claude.json oauthAccount) — billingType 'subscription' vs the
 *     API-key/other shapes. The usage-credit overflow state (a subscription drawing credits past
 *     its plan window → the doc drops the TTL to 5 min) is derivable ONLY when the window budget
 *     has a configured/observed capacity AND the account opted into extra usage
 *     (hasExtraUsageEnabled): pct ≥ 100 with the opt-in = drawing credits. Without a capacity
 *     signal it stays 'subscription' — the within-plan matrix row, the normal state.
 *   - env overrides: FORCE_PROMPT_CACHING_5M / ENABLE_PROMPT_CACHING_1H. Checked in BOTH the
 *     server's own process.env (inherited from the user shell that launched it) and the `env`
 *     block of ~/.claude/settings.json (the place Claude Code sessions get their env from).
 *     LIMITATION stated plainly: env detection is machine/process-scoped, not per-observed-
 *     session — the measured falsifier (shared/keepWarm) exists precisely to catch a wrong
 *     detection with physical evidence.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { getCurrentAccount, type AccountInfo } from './accountInfo'
import type { AuthRegime, TtlContext } from './shared/cacheTtl'

/** Truthy env-flag semantics: Claude Code treats '1'/'true' as on; ''/'0'/'false'/absent as off. */
function flagOn(v: unknown): boolean {
  return v === '1' || v === 'true' || v === 1 || v === true
}

/** Pure override detection over injected env maps — unit-testable without fs.
 *  `settingsEnv` is the parsed `env` object of ~/.claude/settings.json (or null). */
export function detectTtlEnvOverrides(
  processEnv: Record<string, string | undefined>,
  settingsEnv: Record<string, unknown> | null,
): { force5m: boolean; enable1h: boolean } {
  return {
    force5m: flagOn(processEnv.FORCE_PROMPT_CACHING_5M) || flagOn(settingsEnv?.FORCE_PROMPT_CACHING_5M),
    enable1h: flagOn(processEnv.ENABLE_PROMPT_CACHING_1H) || flagOn(settingsEnv?.ENABLE_PROMPT_CACHING_1H),
  }
}

/** Pure auth-regime resolution from the account + the 5h window fill. Exported for tests. */
export function resolveAuthRegime(account: AccountInfo | null, fiveHourPctConsumed: number | null): AuthRegime {
  const billing = account?.billingType ?? null
  if (billing === null) return 'unknown'
  // ROOT-CAUSE BUG (TRDD-VY1IUVUM ADDENDUM, 2026-07-11): this used to compare `billing ===
  // 'subscription'` exactly, but the REAL ~/.claude.json oauthAccount.billingType value observed
  // live (via get_account_status on a Max-5x account) is "stripe_subscription" — Anthropic
  // prefixes the billing shape with the payment processor. The exact-match silently fell through
  // to the 'api-key' branch below, misclassifying every subscription account and reporting the
  // wrong 5-min TTL on a session that actually rides the 1-hour tier (false cold-rewrite
  // warnings). Fix: match any billingType whose lowercased value CONTAINS 'subscription' — this
  // also covers any other processor prefix Anthropic might add later without another silent miss.
  if (billing.toLowerCase().includes('subscription')) {
    // Drawing usage credits requires BOTH the opt-in and positive over-plan evidence; either
    // signal absent → the within-plan row. The falsifier corrects a wrong call the honest way.
    if (account?.hasExtraUsageEnabled === true && fiveHourPctConsumed !== null && fiveHourPctConsumed >= 100) {
      return 'usage-credits'
    }
    return 'subscription'
  }
  // Any non-subscription billingType (observed value: 'api') means the account bills per token —
  // the API-key matrix row (Bedrock/GCP/Foundry land here too when they surface a billingType).
  return 'api-key'
}

/** Read the `env` block of ~/.claude/settings.json, fail-soft (null on any problem). READ-ONLY:
 *  config WRITES must go through safeConfigEdit — this never writes. */
function readSettingsEnv(homeDir: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(path.join(homeDir, '.claude', 'settings.json'), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const env = parsed.env
    return env && typeof env === 'object' ? (env as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// The slow signals (settings.json read + account resolution) cache for ~60s — the gate endpoint
// sits on the PreToolUse hot path and the burn tick fires every few seconds; a per-call fs read
// would be waste. The 5h window fill is CHEAP caller state and changes per call, so it stays a
// parameter and never disables the cache.
let cachedSlow: { account: AccountInfo | null; force5m: boolean; enable1h: boolean; ts: number } | null = null
const TTL_CTX_CACHE_MS = 60_000 // same cadence as the account cache — these signals drift slowly

/**
 * The machine's current TtlContext. `fiveHourPctConsumed` is the caller's window-budget fill
 * (null when capacity is unconfigured — the usage-credit row then never fires, honestly).
 * Injectable inputs for tests; injected calls bypass the cache (same convention as
 * getCurrentAccount).
 */
export function getTtlContext(fiveHourPctConsumed: number | null, opts?: {
  homeDir?: string
  account?: AccountInfo | null
  processEnv?: Record<string, string | undefined>
  now?: number
}): TtlContext {
  const now = opts?.now ?? Date.now()
  let slow: { account: AccountInfo | null; force5m: boolean; enable1h: boolean }
  if (!opts && cachedSlow && now - cachedSlow.ts < TTL_CTX_CACHE_MS) {
    slow = cachedSlow
  } else {
    const home = opts?.homeDir ?? os.homedir()
    const account = opts?.account !== undefined ? opts.account : getCurrentAccount()
    const overrides = detectTtlEnvOverrides(opts?.processEnv ?? process.env, readSettingsEnv(home))
    slow = { account, ...overrides }
    if (!opts) cachedSlow = { ...slow, ts: now }
  }
  return {
    auth: resolveAuthRegime(slow.account, fiveHourPctConsumed),
    force5m: slow.force5m,
    enable1h: slow.enable1h,
  }
}
