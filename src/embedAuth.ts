// TRDD-1ZH1D5EG — signed viewer-role assertion (the AgentlensPro#4 contract).
//
// ai-maestro's reverse proxy stamps `X-Agentlens-Viewer` on every request it forwards; this
// module is the ONLY verifier. Wire format (pinned by src/test/embedAuth.test.ts and consumed
// cross-repo — reshapes go through AgentlensPro#4 first):
//
//   X-Agentlens-Viewer: <b64url(payload)>.<b64url(HMAC-SHA256(b64url(payload), key))>
//   payload = {"role":"maestro"|"user","iat":<unix_ms>,"exp":<unix_ms>,"nonce":"<random>"}
//
// The signature is computed over the base64url-ENCODED payload string (JWT-style) — never the
// raw JSON — so there is no canonicalization ambiguity between signer and verifier.
//
// Trust model: the header is only trustworthy because the proxy DELETES any inbound copy and
// re-stamps it server-side; a browser cannot set it on an iframe document load. Therefore a
// PRESENT header always means "embedded behind the proxy", and every verification failure
// (bad signature, expired, malformed, unknown role) must land on 'restricted' — failing open
// to 'standalone' would hand full access to exactly the requests the proxy tried to restrict.
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

export type ViewerRole = 'standalone' | 'maestro' | 'restricted'

/**
 * Read (or create on first boot) the shared HMAC key at `<dataDir>/embed-key`: 32 random
 * bytes as 64 lowercase hex chars, mode 0600. ai-maestro reads the same file as the same
 * user — that file IS the key exchange.
 *
 * A corrupt existing file THROWS instead of regenerating: a silent regenerate would desync
 * the consumer's copy and every assertion it signs would quietly become 'restricted'.
 */
export function ensureEmbedKey(dataDir: string): Buffer {
  const file = path.join(dataDir, 'embed-key')
  if (fs.existsSync(file)) {
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
 * (undefined when absent). Absent → 'standalone'; a valid unexpired `role:"maestro"` assertion
 * → 'maestro'; EVERYTHING else present → 'restricted'. Never throws.
 */
export function resolveViewerRole(headerValue: string | undefined, key: Buffer, nowMs: number): ViewerRole {
  if (headerValue === undefined) return 'standalone'
  try {
    const parts = headerValue.split('.')
    if (parts.length !== 2 || !parts[0] || !parts[1]) return 'restricted'
    const [payloadB64, sigB64] = parts
    const expected = crypto.createHmac('sha256', key).update(payloadB64).digest()
    const given = Buffer.from(sigB64, 'base64url')
    // timingSafeEqual throws on length mismatch — a short/garbage signature must not crash
    // the request handler, so length is checked first (length is not secret).
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return 'restricted'
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
    if (typeof payload.exp !== 'number' || nowMs > payload.exp) return 'restricted'
    return payload.role === 'maestro' ? 'maestro' : 'restricted'
  } catch {
    return 'restricted'
  }
}

/**
 * Reference signer — the shape ai-maestro's proxy implements, kept here so the contract's two
 * halves live in one file and the round-trip is unit-locked. Also used by the live-verify
 * probes and any local tooling that needs a maestro assertion.
 */
export function signViewerAssertion(role: 'maestro' | 'user', key: Buffer, nowMs: number, ttlMs: number): string {
  const payload = { role, iat: nowMs, exp: nowMs + ttlMs, nonce: crypto.randomBytes(8).toString('hex') }
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', key).update(p).digest().toString('base64url')
  return `${p}.${sig}`
}
