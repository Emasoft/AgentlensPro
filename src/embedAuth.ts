// TRDD-1ZH1D5EG — signed viewer-role assertion (the AgentlensPro#4 contract, spec B1-B5).
//
// ai-maestro's reverse proxy stamps `X-Agentlens-Viewer` on every request it forwards; this
// module is the ONLY verifier. Wire format (pinned by src/test/embedAuth.test.ts — including
// the cross-repo test vector from #4 §B4 — reshapes go through AgentlensPro#4 first):
//
//   X-Agentlens-Viewer: <b64url(payload)>.<b64url(HMAC-SHA256(b64url(payload), key))>
//   payload = {"v":1,"role":"maestro"|"user","iat":<unix_ms>,"exp":<unix_ms>,"nonce":"<hex>"}
//
// The HMAC is over the ASCII of the base64url-ENCODED payload string — never the raw JSON —
// so verification never re-serializes (no dependence on key order, whitespace, or unicode
// escaping). base64url is unpadded; Node's 'base64url' codec matches.
//
// Verdicts (decision table #4 §B5, fail-CLOSED everywhere):
//   header absent                                → 'standalone'  (full access — solo users,
//                                                   hooks, CLI: today's behavior, unchanged)
//   valid sig + v:1 + unexpired + role 'maestro' → 'maestro'     (full access)
//   valid sig + v:1 + unexpired + role 'user'    → 'restricted'  (viewer: reads only,
//                                                   settings chrome hidden)
//   ANYTHING else present (bad sig, expired,     → 'invalid'     (403 the whole request —
//     malformed, unknown v, unknown role)           NOT a downgrade to standalone: if garbage
//                                                   fell back to full access, sending a
//                                                   deliberately broken header would BE the
//                                                   attack. Invalid must be stricter than
//                                                   restricted, or the check is theatre.)
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

export type ViewerRole = 'standalone' | 'maestro' | 'restricted' | 'invalid'

/**
 * Read (or create on first boot) the shared HMAC key at `<dataDir>/embed-key`: 32 random
 * bytes as 64 lowercase hex chars, single line, mode 0600. ai-maestro reads the same file as
 * the same user — that file IS the key exchange (#4 §B1).
 *
 * Fail-fast, never fail-quiet:
 * - a corrupt existing file THROWS instead of regenerating — a silent regenerate would desync
 *   the consumer's copy and every assertion it signs would quietly become invalid;
 * - a mode wider than 0600 THROWS — a world-readable shared secret is not a shared secret,
 *   and quietly using it would let any local account mint maestro assertions.
 */
export function ensureEmbedKey(dataDir: string): Buffer {
  const file = path.join(dataDir, 'embed-key')
  if (fs.existsSync(file)) {
    const mode = fs.statSync(file).mode & 0o777
    if ((mode & 0o077) !== 0) {
      throw new Error(`[AgentLens] embed-key at ${file} has mode 0${mode.toString(8)} — wider than 0600; refusing to use a shared secret other accounts can read (chmod 600 it; see AgentlensPro#4)`)
    }
    const hex = fs.readFileSync(file, 'utf8').trim()
    if (!/^[0-9a-f]{64}$/.test(hex)) {
      throw new Error(`[AgentLens] corrupt embed-key at ${file} — expected 64 lowercase hex chars; refusing to regenerate (ai-maestro reads this file; see AgentlensPro#4)`)
    }
    return Buffer.from(hex, 'hex')
  }
  fs.mkdirSync(dataDir, { recursive: true })
  const key = crypto.randomBytes(32)
  // Atomic create: write-tmp + rename so a concurrent reader never sees a partial key.
  const tmp = `${file}.tmp.${process.pid}`
  fs.writeFileSync(tmp, key.toString('hex') + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
  return key
}

/**
 * Resolve the viewer role for one request. `headerValue` is `req.headers['x-agentlens-viewer']`
 * (undefined when absent). Never throws. Zero clock-skew tolerance on `exp` — signer and
 * verifier share one host clock (#4 Q6).
 */
export function resolveViewerRole(headerValue: string | undefined, key: Buffer, nowMs: number): ViewerRole {
  if (headerValue === undefined) return 'standalone'
  try {
    const parts = headerValue.split('.')
    if (parts.length !== 2 || !parts[0] || !parts[1]) return 'invalid'
    const [payloadB64, sigB64] = parts
    const expected = crypto.createHmac('sha256', key).update(payloadB64).digest()
    const given = Buffer.from(sigB64, 'base64url')
    // timingSafeEqual throws on length mismatch — a short/garbage signature must not crash
    // the request handler, so length is checked first (length is not secret).
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return 'invalid'
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
    if (payload.v !== 1) return 'invalid' // unknown contract version — reject, never best-effort
    if (typeof payload.exp !== 'number' || nowMs > payload.exp) return 'invalid'
    if (payload.role === 'maestro') return 'maestro'
    if (payload.role === 'user') return 'restricted'
    return 'invalid' // unknown role — a spec violation, not a viewer
  } catch {
    return 'invalid'
  }
}

/**
 * Reference signer — the shape ai-maestro's proxy implements, kept here so the contract's two
 * halves live in one file and the round-trip is unit-locked. Also used by the live-verify
 * probes and any local tooling that needs a maestro assertion.
 */
export function signViewerAssertion(role: 'maestro' | 'user', key: Buffer, nowMs: number, ttlMs: number): string {
  const payload = { v: 1, role, iat: nowMs, exp: nowMs + ttlMs, nonce: crypto.randomBytes(8).toString('hex') }
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', key).update(p).digest().toString('base64url')
  return `${p}.${sig}`
}
