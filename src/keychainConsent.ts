// Consent to read the OAuth credential from the macOS keychain — persisted, not env-only.
//
// WHY THIS EXISTS: the keychain read is opt-in because an un-ACL'd read pops a password prompt, and
// this code runs from status lines and hooks where a prompt storm is unacceptable. That part is
// right. What was wrong is that the opt-in lived ONLY in `AGENTLENS_READ_KEYCHAIN_USAGE`, i.e. in
// the environment of whichever process happened to start the server. Any restart that did not carry
// it — a deploy, a hook-triggered `ensureServer`, a launchd revival — silently dropped consent, the
// usage refresh started answering `opt_in_required`, and the per-account archive stopped filling
// while every row it had kept ageing. The symptom is the worst kind: nothing errors, the data just
// quietly goes stale, and `get_account_status --all` serves an old number as if it were current.
//
// Consent is a DECISION the user makes once about this machine, so it belongs where the other such
// decisions live: `<dataDir>/config.json`, AgentlensPro's own store — not in a plugin directory, and
// not in a shell profile the server may or may not inherit. Precedence matches retention and capture
// (src/retentionConfig.ts, src/captureConfig.ts): env > config.json > built-in default.
//
// The default stays FALSE. A persisted knob makes consent durable; it must never make it implicit.

import * as fs from 'fs'
import { configPath } from './retentionConfig'

/** Ops override. 1/true/on/yes to allow, 0/false/off/no to refuse; anything else is ignored. */
export const KEYCHAIN_ENV = 'AGENTLENS_READ_KEYCHAIN_USAGE'

/** The `config.json` key, under the same `usage` section the archive settings use. */
export const KEYCHAIN_KEY = 'readKeychainUsage'

/** OFF. Reading a credential store is not something to start doing on a user's behalf. */
export const KEYCHAIN_DEFAULT = false

export type KeychainConsentSource = 'env' | 'file' | 'default'

/** Tri-state parse: true / false / "not set" (undefined ⇒ fall through to the file, then default).
 *  A typo must never read as consent. */
function parseBool(raw: string | undefined): boolean | undefined {
  if (raw == null) return undefined
  const v = raw.trim().toLowerCase()
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false
  return undefined
}

/** The persisted value, or undefined when unset. Fail-soft: a missing/corrupt config never crashes
 *  boot — it just means "no persisted consent", which is the safe answer. */
export function loadKeychainConsent(dataDir: string): boolean | undefined {
  try {
    const obj = JSON.parse(fs.readFileSync(configPath(dataDir), 'utf-8')) as { usage?: Record<string, unknown> }
    const v = obj.usage?.[KEYCHAIN_KEY]
    return typeof v === 'boolean' ? v : undefined
  } catch {
    return undefined
  }
}

/** Effective consent + which input decided it, so diagnostics can say WHY rather than the user
 *  guessing whether their setting took. */
export function keychainConsentWithSource(
  dataDir: string,
  env: NodeJS.ProcessEnv,
): { allowed: boolean; source: KeychainConsentSource } {
  const fromEnv = parseBool(env[KEYCHAIN_ENV])
  if (fromEnv !== undefined) return { allowed: fromEnv, source: 'env' }
  const fromFile = loadKeychainConsent(dataDir)
  if (fromFile !== undefined) return { allowed: fromFile, source: 'file' }
  return { allowed: KEYCHAIN_DEFAULT, source: 'default' }
}

/** May this process read the keychain? */
export function keychainReadAllowed(dataDir: string, env: NodeJS.ProcessEnv): boolean {
  return keychainConsentWithSource(dataDir, env).allowed
}

/**
 * Persist (or revoke) consent. Atomic temp+rename and non-destructive: every other key in
 * config.json is preserved, and an existing file that is not JSON makes this THROW rather than be
 * clobbered — the same contract as setRawBodyCapture, for the same reason (a "start fresh on parse
 * failure" writer once destroyed a user's whole settings file).
 */
export function setKeychainConsent(dataDir: string, allowed: boolean): void {
  const p = configPath(dataDir)
  let obj: { usage?: Record<string, unknown>; [k: string]: unknown } = {}
  if (fs.existsSync(p)) {
    obj = JSON.parse(fs.readFileSync(p, 'utf-8')) as typeof obj
  }
  obj.usage = { ...(obj.usage ?? {}), [KEYCHAIN_KEY]: allowed }
  fs.mkdirSync(dataDir, { recursive: true })
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf-8')
  fs.renameSync(tmp, p) // atomic replace
}
