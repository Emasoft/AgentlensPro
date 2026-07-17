// TRDD-1ZH1D5EG — the signed viewer-role assertion IS a cross-repo contract (AgentlensPro#4):
// ai-maestro's proxy stamps X-Agentlens-Viewer per request and this verifier decides
// standalone/maestro/restricted. The load-bearing invariant pinned here: a PRESENT header can
// only ever grant maestro or restricted — every failure mode (bad sig, expired, malformed,
// unknown role, wrong key) lands on 'restricted', NEVER on the full-access paths.
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

suite('resolveViewerRole — the X-Agentlens-Viewer contract (TRDD-1ZH1D5EG)', () => {
  test('no header at all → standalone (today\'s behavior: solo users, hooks, CLI untouched)', () => {
    assert.strictEqual(resolveViewerRole(undefined, KEY, NOW), 'standalone')
  })

  test('a valid unexpired maestro assertion → maestro', () => {
    const h = sign({ role: 'maestro', iat: NOW - 1000, exp: NOW + 60_000, nonce: 'n1' }, KEY)
    assert.strictEqual(resolveViewerRole(h, KEY, NOW), 'maestro')
  })

  test('a valid unexpired user assertion → restricted', () => {
    const h = sign({ role: 'user', iat: NOW - 1000, exp: NOW + 60_000, nonce: 'n2' }, KEY)
    assert.strictEqual(resolveViewerRole(h, KEY, NOW), 'restricted')
  })

  test('an EXPIRED maestro assertion → restricted (a captured assertion is not durable)', () => {
    const h = sign({ role: 'maestro', iat: NOW - 120_000, exp: NOW - 1, nonce: 'n3' }, KEY)
    assert.strictEqual(resolveViewerRole(h, KEY, NOW), 'restricted')
  })

  test('a tampered payload (signature no longer matches) → restricted, never maestro', () => {
    const good = sign({ role: 'user', iat: NOW, exp: NOW + 60_000, nonce: 'n4' }, KEY)
    const sig = good.split('.')[1]
    const forged = b64url(Buffer.from(JSON.stringify({ role: 'maestro', iat: NOW, exp: NOW + 60_000, nonce: 'n4' })))
    assert.strictEqual(resolveViewerRole(`${forged}.${sig}`, KEY, NOW), 'restricted')
  })

  test('an assertion signed with a DIFFERENT key → restricted', () => {
    const h = sign({ role: 'maestro', iat: NOW, exp: NOW + 60_000, nonce: 'n5' }, crypto.randomBytes(32))
    assert.strictEqual(resolveViewerRole(h, KEY, NOW), 'restricted')
  })

  test('role is case-sensitive and exact — "MAESTRO"/"admin" → restricted', () => {
    for (const role of ['MAESTRO', 'admin', 'Maestro', '']) {
      const h = sign({ role, iat: NOW, exp: NOW + 60_000, nonce: 'n6' }, KEY)
      assert.strictEqual(resolveViewerRole(h, KEY, NOW), 'restricted', `role=${role}`)
    }
  })

  test('malformed headers never throw and never grant: empty, one part, bad b64, bad JSON, short sig', () => {
    const p = b64url(Buffer.from(JSON.stringify({ role: 'maestro', iat: NOW, exp: NOW + 60_000 })))
    for (const h of ['', 'nodot', `${p}.`, '.sig', `${p}.AAAA`, `not-json.${b64url(Buffer.from('x'))}`, `${p}.${p}.${p}`]) {
      assert.strictEqual(resolveViewerRole(h, KEY, NOW), 'restricted', `header=${JSON.stringify(h)}`)
    }
  })

  test('a payload missing exp or role → restricted (fields are mandatory)', () => {
    const noExp = sign({ role: 'maestro', iat: NOW, nonce: 'n7' }, KEY)
    const noRole = sign({ iat: NOW, exp: NOW + 60_000, nonce: 'n8' }, KEY)
    assert.strictEqual(resolveViewerRole(noExp, KEY, NOW), 'restricted')
    assert.strictEqual(resolveViewerRole(noRole, KEY, NOW), 'restricted')
  })
})

suite('signViewerAssertion — the reference signer round-trips through the verifier', () => {
  test('signs maestro and user assertions the verifier accepts', () => {
    assert.strictEqual(resolveViewerRole(signViewerAssertion('maestro', KEY, NOW, 60_000), KEY, NOW), 'maestro')
    assert.strictEqual(resolveViewerRole(signViewerAssertion('user', KEY, NOW, 60_000), KEY, NOW), 'restricted')
  })
})

suite('ensureEmbedKey — the shared-secret file ai-maestro reads (TRDD-1ZH1D5EG)', () => {
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
})
