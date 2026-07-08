import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  CallBodyRegistry, callBodyRegistry, parseUserId, resolveCallContext,
} from '../rawBodyContext'

// TRDD-BURNWDGT — REAL tests for per-account attribution at ingest. No mocks: the registry is exercised
// through its public API, and the backfill test writes a real request-body JSON to a tmp dir and drives
// the real resolveCallContext parse. account_uuid is an identifier (safe to persist); the OAuth token is
// never touched by this path.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-attr-'))
suiteTeardown(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ } })

interface Body { model: string; metadata: { user_id: string }; system: Array<{ type: string; text: string }>; messages: Array<{ role: string; content: unknown }> }
function makeBody(sessionId: string, accountUuid: string): Body {
  return {
    model: 'claude-opus-4-8',
    metadata: { user_id: JSON.stringify({ device_id: 'dev', account_uuid: accountUuid, session_id: sessionId }) },
    system: [{ type: 'text', text: 'You are a helpful assistant.' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }
}
function writeBody(name: string, body: unknown): string {
  const p = path.join(tmpDir, name)
  fs.writeFileSync(p, JSON.stringify(body))
  return p
}

suite('account attribution — CallBodyRegistry account map', () => {
  test('recordAccount then accountFor round-trips the account_uuid', () => {
    const reg = new CallBodyRegistry()
    reg.recordAccount('sess-A', 'acct-uuid-1')
    assert.strictEqual(reg.accountFor('sess-A'), 'acct-uuid-1')
  })

  test('accountFor is undefined for an unknown session (fail-soft, never fabricated)', () => {
    const reg = new CallBodyRegistry()
    assert.strictEqual(reg.accountFor('nope'), undefined)
  })

  test('recordAccount ignores empty session or account (fail-soft)', () => {
    const reg = new CallBodyRegistry()
    reg.recordAccount('', 'acct')
    reg.recordAccount('sess', undefined)
    reg.recordAccount('sess', '')
    assert.strictEqual(reg.accountFor('sess'), undefined)
  })

  test('the account map is bounded by maxSessions (oldest evicts FIFO)', () => {
    const reg = new CallBodyRegistry(3, 400)
    for (const id of ['s1', 's2', 's3', 's4']) { reg.recordAccount(id, `a-${id}`) }
    // s1 was the oldest of 4 with a cap of 3 → evicted; the newest 3 remain.
    assert.strictEqual(reg.accountFor('s1'), undefined)
    assert.strictEqual(reg.accountFor('s4'), 'a-s4')
    assert.strictEqual(reg.accountFor('s3'), 'a-s3')
  })

  test('re-recording a session refreshes it to MRU so it is not the eviction victim', () => {
    const reg = new CallBodyRegistry(2, 400)
    reg.recordAccount('s1', 'a1')
    reg.recordAccount('s2', 'a2')
    reg.recordAccount('s1', 'a1')   // touch s1 → s2 becomes oldest
    reg.recordAccount('s3', 'a3')   // evicts the oldest (s2)
    assert.strictEqual(reg.accountFor('s1'), 'a1')
    assert.strictEqual(reg.accountFor('s2'), undefined)
    assert.strictEqual(reg.accountFor('s3'), 'a3')
  })
})

suite('account attribution — parseUserId + resolveCallContext backfill', () => {
  test('parseUserId extracts account_uuid + session_id from the metadata blob', () => {
    const blob = JSON.stringify({ device_id: 'd', account_uuid: 'acct-9', session_id: 'sess-9' })
    const parsed = parseUserId(blob)
    assert.strictEqual(parsed.accountUuid, 'acct-9')
    assert.strictEqual(parsed.sessionId, 'sess-9')
  })

  test('parseUserId is fail-soft on a non-JSON user_id', () => {
    assert.deepStrictEqual(parseUserId('not-json'), {})
    assert.deepStrictEqual(parseUserId(undefined), {})
  })

  test('resolveCallContext backfills the shared registry account from the parsed body', async () => {
    const sessionId = 'sess-backfill'
    const ref = writeBody('backfill.request.json', makeBody(sessionId, 'acct-backfill'))
    // The registry has a body pointer but no account yet (the OTEL event never carried it).
    callBodyRegistry.record(sessionId, { kind: 'request', bodyRef: ref, ts: 1 })
    assert.strictEqual(callBodyRegistry.accountFor(sessionId), undefined)
    const ctx = await resolveCallContext(sessionId, {})
    assert.ok(ctx, 'resolveCallContext should parse the body')
    assert.strictEqual(ctx?.accountUuid, 'acct-backfill')
    // After the read, the session→account map is populated (attributes log/statusline sessions too).
    assert.strictEqual(callBodyRegistry.accountFor(sessionId), 'acct-backfill')
  })
})
