import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { flush, openStore, Store } from '../store/db'
import { ingestBody } from '../store/bodyStore'
import { listBodyEvidence, loadBodyTexts } from '../store/bodiesEvidence'

// The evidence-base contract (owner directive 2026-08-13). The incident these tests pin: the break
// timeline's evidence was the raw spool ONLY, so the ingest drain — working correctly — silently
// shrank the tool's history between two runs (a classified break at 01:08Z ceased to exist by the
// next invocation). The union queried by bodiesEvidence must make "the drain ran" invisible to
// every diagnostic built on it.

function rawFor(session: string, marker: string): string {
  // The REAL Claude Code shape: session id buried in metadata.user_id as an embedded JSON string
  // (bodyStore.extractMeta documents that reading any other field mis-attributes every body).
  return JSON.stringify({
    model: 'claude-opus-5',
    metadata: { user_id: JSON.stringify({ device_id: 'dev-1', session_id: session }) },
    messages: [{ role: 'user', content: [{ type: 'text', text: `body ${marker} `.repeat(50) }] }],
  })
}

suite('bodiesEvidence — the spool ∪ parquet union is complete and cheap to filter', () => {
  let dir = ''
  let spool = ''
  let store: Store

  const T0 = Date.UTC(2026, 7, 13, 1, 0, 0)   // 2026-08-13T01:00:00Z, fixed clock — deterministic
  const NAMES = ['aaa.request.json', 'bbb.request.json', 'ccc.response.json'] as const
  const RAWS = [rawFor('sess-A', 'one'), rawFor('sess-A', 'two'), rawFor('sess-B', 'three')]

  suiteSetup(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-evidence-'))
    spool = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-evidence-spool-'))
    store = await openStore({ dir, memoryLimit: '2GB', threads: 2 })
    // Three bodies: two sessions, one response, distinct capture times an hour apart.
    for (let i = 0; i < NAMES.length; i++) {
      fs.writeFileSync(path.join(spool, NAMES[i]), RAWS[i])
      await ingestBody(store, NAMES[i], RAWS[i], T0 + i * 3_600_000)
    }
    await flush(store)
    // THE DRAIN: the first body's raw file is deleted — exactly what ingestPass does once the store
    // provably holds it. Any evidence reader that still depends on this file has the measured bug.
    fs.rmSync(path.join(spool, NAMES[0]))
    // And one body that ONLY the spool knows (captured after the last flush).
    fs.writeFileSync(path.join(spool, 'ddd.request.json'), rawFor('sess-C', 'four'))
  })
  suiteTeardown(() => {
    try { store?.con.closeSync() } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(spool, { recursive: true, force: true })
  })

  test('a body whose raw file the drain deleted is STILL evidence — the vanished-turn regression', async () => {
    const rows = await listBodyEvidence(dir, spool)
    const names = rows.map((r) => r.srcName).sort()
    assert.deepStrictEqual(names, ['aaa.request.json', 'bbb.request.json', 'ccc.response.json', 'ddd.request.json'])
    const drained = rows.find((r) => r.srcName === 'aaa.request.json')
    assert.strictEqual(drained?.location, 'store', 'the drained body is served by the store')
    const texts = await loadBodyTexts(dir, spool, rows)
    // Byte-identity, not mere presence: a diagnosis built on approximately-right bytes is worse
    // than one that fails loudly.
    assert.strictEqual(texts.get('aaa.request.json'), RAWS[0])
    assert.strictEqual(texts.get('ddd.request.json'), rawFor('sess-C', 'four'))
    assert.strictEqual(texts.size, 4)
  })

  test('a body in BOTH spool and store yields ONE row (store wins), so mid-drain never double-counts', async () => {
    const rows = await listBodyEvidence(dir, spool)
    const dupes = rows.filter((r) => r.srcName === 'bbb.request.json')
    assert.strictEqual(dupes.length, 1)
    assert.strictEqual(dupes[0].location, 'store')
  })

  test('session pushdown filters store rows in SQL but NEVER hides unparsed spool rows', async () => {
    const rows = await listBodyEvidence(dir, spool, { sessionId: 'sess-A' })
    const storeRows = rows.filter((r) => r.location === 'store')
    assert.deepStrictEqual(storeRows.map((r) => r.srcName).sort(), ['aaa.request.json', 'bbb.request.json'])
    // The spool row's session is unknown until parsed — dropping it here would silently exclude the
    // newest turns from every session-scoped diagnosis, which is the volatility bug reborn.
    assert.ok(rows.some((r) => r.srcName === 'ddd.request.json' && r.sessionId === null),
      'the unattributed spool row must survive a session filter')
  })

  test('time-window pushdown uses the CAPTURE ts, and kind matches the suffix taxonomy', async () => {
    const rows = await listBodyEvidence(dir, spool, { tsFromMs: T0 + 1, tsToMs: T0 + 2 * 3_600_000 - 1 })
    const storeRows = rows.filter((r) => r.location === 'store')
    assert.deepStrictEqual(storeRows.map((r) => r.srcName), ['bbb.request.json'])
    const resp = await listBodyEvidence(dir, spool, { kind: 'response' })
    assert.deepStrictEqual(resp.filter((r) => r.location === 'store').map((r) => r.srcName), ['ccc.response.json'])
    assert.ok(!resp.some((r) => r.srcName === 'ddd.request.json'), 'kind IS known for spool rows (the suffix) — filter applies')
  })

  test('a spool row drained between list and load falls through to the store instead of failing', async () => {
    // Stage the race: list while the file exists, drain it, then load from the stale listing.
    const raw = rawFor('sess-D', 'five')
    fs.writeFileSync(path.join(spool, 'eee.request.json'), raw)
    await ingestBody(store, 'eee.request.json', raw, T0 + 10 * 3_600_000)
    const rows = await listBodyEvidence(dir, spool)
    await flush(store)
    fs.rmSync(path.join(spool, 'eee.request.json'))
    const stale = rows.find((r) => r.srcName === 'eee.request.json')
    assert.ok(stale, 'listed while present')
    const texts = await loadBodyTexts(dir, spool, [stale as NonNullable<typeof stale>])
    assert.strictEqual(texts.get('eee.request.json'), raw, 'the delete-gate invariant covers the race')
  })
})
