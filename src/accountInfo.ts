/**
 * Account + plan awareness (TRDD-BURNWDGT). Resolves the CURRENTLY-active Claude Code OAuth account
 * (identity + plan type) so the per-account window budget can label its buckets and answer "which
 * account am I on, what plan, how much of its window is left".
 *
 * TWO live-only sources (never persisted — this is display metadata that drifts, and one source holds
 * a secret):
 *   1. ~/.claude.json  `oauthAccount`  → accountUuid, emailAddress, organizationName/Uuid, billingType,
 *      hasExtraUsageEnabled, rate-limit tiers, displayName. These are IDENTITY fields, no secret.
 *   2. macOS keychain `Claude Code-credentials` → the credential JSON carries the OAuth TOKENS **and**
 *      `subscriptionType` (max / pro / team / enterprise / free). We read the blob, extract ONLY
 *      `subscriptionType`, and drop the rest. The access/refresh TOKEN is NEVER returned, logged, or
 *      persisted — parseSubscriptionType is the single choke-point and returns a plain plan string.
 *
 * Everything is fail-soft: a missing/malformed file, a denied keychain read, or a non-macOS host yields
 * nulls, never a throw and never a secret. The keychain read is injectable so it is unit-testable
 * without touching the real keychain (and defaults to a short-timeout, non-shell execFile).
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'

/** The identity fields lifted from ~/.claude.json `oauthAccount` (no secrets live here). */
export interface OauthIdentity {
  accountUuid: string | null
  email: string | null
  organizationName: string | null
  organizationUuid: string | null
  billingType: string | null           // e.g. "subscription" | "api" — subscription = window-limited
  hasExtraUsageEnabled: boolean         // true = opted into token billing once the window is hit
  organizationRateLimitTier: string | null
  userRateLimitTier: string | null
  displayName: string | null
}

/** The fully-resolved, live-only account view surfaced to the MCP / budget layer. */
export interface AccountInfo extends OauthIdentity {
  planType: string | null              // keychain subscriptionType (max/pro/team/enterprise/free)
  rateLimitTier: string | null         // organizationRateLimitTier ?? userRateLimitTier
  label: string                        // human label: email ?? displayName ?? short accountUuid
  source: 'claude.json' | 'none'
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** Parse ~/.claude.json's `oauthAccount` into the identity fields. Pure + fail-soft: returns null on any
 *  malformed input so a corrupt config never crashes the monitor. No secret is present in this object. */
export function parseOauthAccount(claudeJsonText: string): OauthIdentity | null {
  let oa: Record<string, unknown>
  try {
    const root = JSON.parse(claudeJsonText) as Record<string, unknown>
    const acct = root.oauthAccount
    if (!acct || typeof acct !== 'object') { return null }
    oa = acct as Record<string, unknown>
  } catch {
    return null
  }
  return {
    accountUuid: str(oa.accountUuid),
    email: str(oa.emailAddress),
    organizationName: str(oa.organizationName),
    organizationUuid: str(oa.organizationUuid),
    billingType: str(oa.billingType),
    hasExtraUsageEnabled: oa.hasExtraUsageEnabled === true,
    organizationRateLimitTier: str(oa.organizationRateLimitTier),
    userRateLimitTier: str(oa.userRateLimitTier),
    displayName: str(oa.displayName),
  }
}

/** Extract ONLY the plan type (`subscriptionType`) from the keychain credential JSON. THE SECURITY
 *  CHOKE-POINT: the credential blob also holds the OAuth access/refresh tokens; this function reads a
 *  single non-secret string and returns it — it never returns, logs, or exposes any token field.
 *  Fail-soft: null on any parse failure or a missing subscriptionType. */
export function parseSubscriptionType(credentialJsonText: string): string | null {
  try {
    const o = JSON.parse(credentialJsonText) as Record<string, unknown>
    // Claude Code stores the OAuth blob under `claudeAiOauth`; older shapes put it at the top level.
    const inner = (o.claudeAiOauth && typeof o.claudeAiOauth === 'object')
      ? o.claudeAiOauth as Record<string, unknown>
      : o
    return str(inner.subscriptionType)
  } catch {
    return null
  }
}

/** One-shot latch for the keychain plan read. WHY THIS EXISTS (bug autopsy, 2026-07-09): reading the
 *  `Claude Code-credentials` item triggers a macOS "Security wants to use the login keychain" password
 *  dialog whenever the item's ACL does NOT include our binary — which happens after EVERY account
 *  rotation, because Claude Code re-creates the item with a Claude-Code-only ACL that excludes node.
 *  A per-tick reader (burn tick / per-request / per-respawn) then FLOODS the user with hundreds of
 *  un-dismissable prompts (macOS offers no "Always Allow" because the reader isn't in the ACL). The
 *  60s getCurrentAccount cache did not prevent it (opts-callers bypass it, and each supervisor respawn
 *  starts a cold process that prompts on its first tick). So the plan-from-keychain read is now
 *  STRICTLY OPT-IN and attempted AT MOST ONCE per process: any outcome (success, denial, timeout,
 *  off-macOS, not-opted-in) latches permanently so it can NEVER re-prompt. The plan label is
 *  display-only; identity + billingType + rate-limit tiers already come from ~/.claude.json with no
 *  prompt, so losing the keychain plan degrades to null, never to a flood. */
let keychainPlanLatch: { done: boolean; value: string | null } = { done: false, value: null }

/** Read the keychain credential blob on macOS and return ONLY the subscriptionType — but ONLY when the
 *  user explicitly opts in via AGENTLENS_READ_KEYCHAIN_PLAN=1, and AT MOST ONCE per process (latched).
 *  Off-macOS, not-opted-in, denied, or any error → null, latched, never retried. The raw blob (which
 *  holds the OAuth tokens) is confined to this function's local scope and never surfaced. */
function readKeychainSubscriptionType(): string | null {
  if (keychainPlanLatch.done) { return keychainPlanLatch.value }
  // Default OFF: never touch the keychain unless explicitly opted in — a single un-ACL'd read prompts.
  if (process.platform !== 'darwin' || process.env.AGENTLENS_READ_KEYCHAIN_PLAN !== '1') {
    keychainPlanLatch = { done: true, value: null }
    return null
  }
  let value: string | null = null
  try {
    const raw = execFileSync('security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
    value = parseSubscriptionType(raw)
  } catch {
    value = null   // denial / timeout / errSecAuthFailed — latch OFF, never re-prompt this process
  }
  keychainPlanLatch = { done: true, value }
  return value
}

/** A human label for the account: email, else org display name, else a short account_uuid, else 'unknown'. */
export function accountLabelFor(id: OauthIdentity | null, accountUuid?: string | null): string {
  if (id && (accountUuid == null || id.accountUuid === accountUuid)) {
    return id.email || id.displayName || (id.accountUuid ? id.accountUuid.slice(0, 8) : 'unknown')
  }
  // A different (rotated-away) account is not resolvable to an email — only its id is known.
  return accountUuid ? accountUuid.slice(0, 8) : 'unknown'
}

let cached: { info: AccountInfo; ts: number } | null = null
const ACCOUNT_TTL_MS = 60_000   // avoid re-reading claude.json + the keychain on every burn tick

/** The current live account (identity + plan), cached ~60s to avoid repeated keychain reads. `homeDir`
 *  + `readKeychain` are injectable for tests (so the real keychain is never touched under test). */
export function getCurrentAccount(opts?: {
  homeDir?: string
  readKeychain?: () => string | null
  now?: number
}): AccountInfo {
  const now = opts?.now ?? Date.now()
  if (!opts && cached && now - cached.ts < ACCOUNT_TTL_MS) { return cached.info }

  const home = opts?.homeDir ?? os.homedir()
  let identity: OauthIdentity | null = null
  try {
    identity = parseOauthAccount(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'))
  } catch {
    identity = null
  }
  const planType = (opts?.readKeychain ?? readKeychainSubscriptionType)()

  const info: AccountInfo = identity
    ? {
        ...identity,
        planType,
        rateLimitTier: identity.organizationRateLimitTier ?? identity.userRateLimitTier,
        label: accountLabelFor(identity),
        source: 'claude.json',
      }
    : {
        accountUuid: null, email: null, organizationName: null, organizationUuid: null,
        billingType: null, hasExtraUsageEnabled: false,
        organizationRateLimitTier: null, userRateLimitTier: null, displayName: null,
        planType, rateLimitTier: null, label: 'unknown', source: 'none',
      }

  if (!opts) { cached = { info, ts: now } }
  return info
}
