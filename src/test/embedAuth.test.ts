// TRDD-1ZH1D5EG — the signed viewer-role assertion IS a cross-repo contract (AgentlensPro#4):
// ai-maestro's proxy stamps X-Agentlens-Viewer per request and this verifier decides
// standalone/maestro/restricted/invalid. The load-bearing invariants pinned here:
//   1. a PRESENT header can NEVER yield 'standalone' — failing open would make a deliberately
//      broken header a downgrade attack (#4 §B5);
//   2. every failure mode (bad sig, expired, malformed, unknown v, unknown role, wrong key)
//      lands on 'invalid' (403-everything), which is STRICTER than 'restricted';
//   3. the #4 §B4 test vector verifies byte-for-byte, so the two repos' implementations
//      cannot silently diverge.
import * as assert from 'assert'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ensureEmbedKey, resolveViewerRole, signViewerAssertion } from '../embedAuth'

const KEY = crypto.randomBytes(32)
const NOW = 1_800_000_000_000

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

/** Hand-rolled signer (independent of signViewerAssertion) so the tests pin the WIRE format. */
function sign(payload: object, key: Buffer): string {
  const p = b64url(Buffer.from(JSON.stringify(payload)))
  const sig = crypto.createHmac('sha256', key).update(p).digest()
  return `${p}.${b64url(sig)}`
}

suite('resolveViewerRole — the X-Agentlens-Viewer contract (TRDD-1ZH1D5EG / AgentlensPro#4 §B5)', () => {
  test('no header at all → standalone (today\'s behavior: solo users, hooks, CLI untouched)', () => {
    assert.strictEqual(resolveViewerRole(undefined, KEY, NOW), 'standalone')
  })

  test('a valid unexpired v1 maestro assertion → maestro', () => {
    const h = sign({ v: 1, role: 'maestro', iat: NOW - 1000, exp: NOW + 60_000, nonce: 'n1' }, KEY)
    assert.strictEqual(resolveViewerRole(h, KEY, NOW), 'maestro')
  })

  test('a valid unexpired v1 user assertion → restricted', () => {
    const h = sign({ v: 1, role: 'user', iat: NOW - 1000, exp: NOW + 60_000, nonce: 'n2' }, KEY)
    assert.strictEqual(resolveViewerRole(h, KEY, NOW), 'restricted')
  })

  test('the AgentlensPro#4 §B4 cross-repo test vector verifies byte-for-byte', () => {
    // Computed by ai-maestro on 2026-07-17 — if this pin ever fails, the two implementations
    // diverged; route the change through issue #4 before touching the expectation.
    const vectorKey = Buffer.from('6b6579', 'hex') // ASCII "key"
    const vector =
      'eyJ2IjoxLCJyb2xlIjoidXNlciIsImlhdCI6MTc1MjcyMDAwMDAwMCwiZXhwIjoxNzUyNzIwMDYwMDAwLCJub25jZSI6IjAxMjM0NTY3ODlhYmNkZWYifQ' +
      '.aj_Q93wQFqYwSQZgXU-KbWCMTbJH8K6mvEBdfouklpo'
    // Inside the validity window (iat=1752720000000, exp=1752720060000) → role user → restricted.
    assert.strictEqual(resolveViewerRole(vector, vectorKey, 1_752_720_030_000), 'restricted')
    // Past exp the SAME vector is invalid (zero skew tolerance, #4 Q6).
    assert.strictEqual(resolveViewerRole(vector, vectorKey, 1_752_720_060_001), 'invalid')
  })

  test('an EXPIRED maestro assertion → invalid (a captured assertion is not durable)', () => {
    const h = sign({ v: 1, role: 'maestro', iat: NOW - 120_000, exp: NOW - 1, nonce: 'n3' }, KEY)
    assert.strictEqual(resolveViewerRole(h, KEY, NOW), 'invalid')
  })

  test('a tampered payload (signature no longer matches) → invalid, never maestro', () => {
    const good = sign({ v: 1, role: 'user', iat: NOW, exp: NOW + 60_000, nonce: 'n4' }, KEY)
    const sig = good.split('.')[1]
    const forged = b64url(Buffer.from(JSON.stringify({ v: 1, role: 'maestro', iat: NOW, exp: NOW + 60_000, nonce: 'n4' })))
    assert.strictEqual(resolveViewerRole(`${forged}.${sig}`, KEY, NOW), 'invalid')
  })

  test('an assertion signed with a DIFFERENT key → invalid', () => {
    const h = sign({ v: 1, role: 'maestro', iat: NOW, exp: NOW + 60_000, nonce: 'n5' }, crypto.randomBytes(32))
    assert.strictEqual(resolveViewerRole(h, KEY, NOW), 'invalid')
  })

  test('an unknown contract version → invalid (reject, never best-effort — #4 Q8)', () => {
    for (const v of [0, 2, '1', undefined]) {
      const h = sign({ v, role: 'maestro', iat: NOW, exp: NOW + 60_000, nonce: 'n6' }, KEY)
      assert.strictEqual(resolveViewerRole(h, KEY, NOW), 'invalid', `v=${String(v)}`)
    }
  })

  test('an unknown role is a spec violation → invalid ("MAESTRO"/"admin"/"maestro-delegate")', () => {
    for (const role of ['MAESTRO', 'admin', 'Maestro', 'maestro-delegate', '']) {
      const h = sign({ v: 1, role, iat: NOW, exp: NOW + 60_000, nonce: 'n7' }, KEY)
      assert.strictEqual(resolveViewerRole(h, KEY, NOW), 'invalid', `role=${role}`)
    }
  })

  test('malformed headers never throw and never grant: empty, one part, bad b64, bad JSON, short sig', () => {
    const p = b64url(Buffer.from(JSON.stringify({ v: 1, role: 'maestro', iat: NOW, exp: NOW + 60_000 })))
    for (const h of ['', 'nodot', `${p}.`, '.sig', `${p}.AAAA`, `not-json.${b64url(Buffer.from('x'))}`, `${p}.${p}.${p}`]) {
      assert.strictEqual(resolveViewerRole(h, KEY, NOW), 'invalid', `header=${JSON.stringify(h)}`)
    }
  })

  test('a payload missing exp or role → invalid (fields are mandatory)', () => {
    const noExp = sign({ v: 1, role: 'maestro', iat: NOW, nonce: 'n8' }, KEY)
    const noRole = sign({ v: 1, iat: NOW, exp: NOW + 60_000, nonce: 'n9' }, KEY)
    assert.strictEqual(resolveViewerRole(noExp, KEY, NOW), 'invalid')
    assert.strictEqual(resolveViewerRole(noRole, KEY, NOW), 'invalid')
  })
})

suite('signViewerAssertion — the reference signer round-trips through the verifier', () => {
  test('signs v1 maestro and user assertions the verifier accepts', () => {
    assert.strictEqual(resolveViewerRole(signViewerAssertion('maestro', KEY, NOW, 60_000), KEY, NOW), 'maestro')
    assert.strictEqual(resolveViewerRole(signViewerAssertion('user', KEY, NOW, 60_000), KEY, NOW), 'restricted')
  })
})

suite('ensureEmbedKey — the shared-secret file ai-maestro reads (TRDD-1ZH1D5EG / #4 §B1)', () => {
  test('creates <dataDir>/embed-key as 64 lowercase hex chars with mode 0600, and is stable across calls', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embedkey-'))
    try {
      const k1 = ensureEmbedKey(dir)
      const file = path.join(dir, 'embed-key')
      const raw = fs.readFileSync(file, 'utf8').trim()
      assert.match(raw, /^[0-9a-f]{64}$/)
      assert.strictEqual(k1.length, 32)
      assert.strictEqual((fs.statSync(file).mode & 0o777), 0o600)
      const k2 = ensureEmbedKey(dir)
      assert.ok(k1.equals(k2), 'second call must return the SAME key, not regenerate')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('reads a pre-existing key file rather than overwriting it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embedkey-'))
    try {
      const hex = crypto.randomBytes(32).toString('hex')
      fs.writeFileSync(path.join(dir, 'embed-key'), hex + '\n', { mode: 0o600 })
      assert.strictEqual(ensureEmbedKey(dir).toString('hex'), hex)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a corrupt key file THROWS (fail-fast) — silently regenerating would desync ai-maestro\'s copy', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embedkey-'))
    try {
      fs.writeFileSync(path.join(dir, 'embed-key'), 'not-hex-at-all', { mode: 0o600 })
      assert.throws(() => ensureEmbedKey(dir), /embed-key/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a key file with mode wider than 0600 is REFUSED — a world-readable shared secret is not a shared secret (#4 §B1)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embedkey-'))
    try {
      const hex = crypto.randomBytes(32).toString('hex')
      fs.writeFileSync(path.join(dir, 'embed-key'), hex + '\n', { mode: 0o644 })
      assert.throws(() => ensureEmbedKey(dir), /wider than 0600/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
