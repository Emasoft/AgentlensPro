// get_body_writers (TRDD-1FEIW17E) — the scan attributes writers from real request-tail metadata,
// the merge must never double-count a file present in both the live dir and the store, and the
// ranking is the user-facing contract (rate desc, then total desc). No mocks: real files, real store.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { flush, openStore, Store } from '../store/db'
import { ingestBody } from '../store/bodyStore'
import {
  buildBodyWritersReport, queryStoreWriterTotals, scanLiveBodyWriters,
} from '../bodyWriters'

const NOW = Date.UTC(2026, 6, 15, 9, 0, 0)
const WIN = 30 * 60_000
const ACT = 10 * 60_000
const SESS_A = 'aaaa1111-2222-3333-4444-555566667777'
const SESS_B = 'bbbb1111-2222-3333-4444-555566667777'

/** A request body with the REAL tail layout: metadata.user_id is a STRING of escaped JSON —
 *  exactly what extractRequestAttribution's bounded read parses on production bodies. */
function reqBody(session: string, model: string, pad = 500): string {
  return JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'x'.repeat(pad) }],
    metadata: { user_id: JSON.stringify({ device_id: 'd', session_id: session }) },
  })
}

function writeFile(dir: string, name: string, content: string, mtimeMs: number): number {
  const p = path.join(dir, name)
  fs.writeFileSync(p, content)
  fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs))
  return Buffer.byteLength(content)
}

suite('scanLiveBodyWriters — one-shot attribution scan over the live bodies dir', () => {
  let dir: string
  setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-bw-')) })

  test('attributes requests to their session and aggregates bytes, files, first/last, model', () => {
    const b1 = writeFile(dir, 'r1.request.json', reqBody(SESS_A, 'claude-fable-5'), NOW - 20 * 60_000)
    const b2 = writeFile(dir, 'r2.request.json', reqBody(SESS_A, 'claude-fable-5', 900), NOW - 5 * 60_000)
    const scan = scanLiveBodyWriters(dir, NOW, WIN)
    assert.strictEqual(scan.available, true)
    assert.strictEqual(scan.sessions.length, 1)
    const s = scan.sessions[0]
    assert.strictEqual(s.sessionId, SESS_A)
    assert.strictEqual(s.bytes, b1 + b2)
    assert.strictEqual(s.files.length, 2)
    assert.strictEqual(s.model, 'claude-fable-5')
    assert.strictEqual(s.lastMs, NOW - 5 * 60_000)
  })

  test('recent window counts only files whose mtime falls inside it', () => {
    writeFile(dir, 'old.request.json', reqBody(SESS_A, 'm'), NOW - 2 * 3600_000)
    const recent = writeFile(dir, 'new.request.json', reqBody(SESS_A, 'm'), NOW - 60_000)
    const scan = scanLiveBodyWriters(dir, NOW, WIN)
    assert.strictEqual(scan.sessions[0].recentFiles, 1)
    assert.strictEqual(scan.sessions[0].recentBytes, recent)
  })

  test('responses are aggregated, never attributed to a session', () => {
    writeFile(dir, 'x.response.json', '{"id":"msg_01","usage":{}}', NOW - 60_000)
    writeFile(dir, 'r.request.json', reqBody(SESS_A, 'm'), NOW - 60_000)
    const scan = scanLiveBodyWriters(dir, NOW, WIN)
    assert.strictEqual(scan.responses.files.length, 1)
    assert.strictEqual(scan.sessions.length, 1) // the response created no session entry
  })

  test('a request without session metadata lands in the null bucket, never dropped or guessed', () => {
    writeFile(dir, 'anon.request.json', '{"model":"m","messages":[]}', NOW - 60_000)
    const scan = scanLiveBodyWriters(dir, NOW, WIN)
    assert.strictEqual(scan.sessions.length, 1)
    assert.strictEqual(scan.sessions[0].sessionId, null)
  })

  test('an absent dir degrades to available:false instead of throwing', () => {
    const scan = scanLiveBodyWriters(path.join(dir, 'nope'), NOW, WIN)
    assert.strictEqual(scan.available, false)
    assert.strictEqual(scan.scannedFiles, 0)
  })
})

suite('queryStoreWriterTotals — all-time per-session totals from the durable store', () => {
  let dir: string
  let store: Store
  setup(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-bwq-'))
    store = await openStore({ dir, memoryLimit: '2GB', threads: 2 })
  })
  teardown(async () => { await store.close() })

  test('groups request bytes by session, aggregates responses separately, returns recent src_names', async () => {
    const rawA1 = reqBody(SESS_A, 'claude-fable-5')
    const rawA2 = reqBody(SESS_A, 'claude-fable-5', 900)
    const rawB = reqBody(SESS_B, 'claude-opus-4-8')
    await ingestBody(store, 'a1.request.json', rawA1, NOW - 3600_000)
    await ingestBody(store, 'a2.request.json', rawA2, NOW - 60_000)
    await ingestBody(store, 'b1.request.json', rawB, NOW - 60_000)
    await ingestBody(store, 'x.response.json', '{"id":"msg_9","usage":{"output_tokens":1}}', NOW - 60_000)
    await flush(store)
    const t = await queryStoreWriterTotals(store, NOW - 96 * 3600_000)
    const a = t.sessions.find(s => s.sessionId === SESS_A)!
    assert.strictEqual(a.files, 2)
    assert.strictEqual(a.bytes, Buffer.byteLength(rawA1) + Buffer.byteLength(rawA2))
    assert.strictEqual(a.model, 'claude-fable-5')
    assert.strictEqual(t.sessions.find(s => s.sessionId === SESS_B)!.files, 1)
    assert.strictEqual(t.responses.files, 1)
    assert.ok(t.recentSrcNames.has('a2.request.json'))
  })

  test('recentSrcNames excludes rows older than the floor (the live-overlap window is bounded)', async () => {
    await ingestBody(store, 'ancient.request.json', reqBody(SESS_A, 'm'), NOW - 200 * 3600_000)
    await flush(store)
    const t = await queryStoreWriterTotals(store, NOW - 96 * 3600_000)
    assert.strictEqual(t.recentSrcNames.has('ancient.request.json'), false)
    assert.strictEqual(t.sessions[0].files, 1) // still counted in the all-time totals
  })
})

suite('buildBodyWritersReport — merge, exact union, ranking, degradation', () => {
  const CARDS = [{ sessionId: SESS_A, workspace: '/w/proj-a', source: 'claude_code' }]

  function liveScanOf(sessions: Parameters<typeof buildBodyWritersReport>[0]['live']['sessions']) {
    return {
      available: true, dir: '/d', scannedFiles: 9, sessions,
      responses: { files: [], bytes: 0, recentBytes: 0, lastMs: 0 },
    }
  }

  test('a file present in BOTH live dir and store is counted once (exact union, no double count)', () => {
    const r = buildBodyWritersReport({
      live: liveScanOf([{
        sessionId: SESS_A, files: [{ name: 'seen.request.json', bytes: 100 }, { name: 'fresh.request.json', bytes: 40 }],
        bytes: 140, recentFiles: 2, recentBytes: 140, firstMs: NOW - 60_000, lastMs: NOW - 60_000, model: 'm',
      }]),
      store: {
        sessions: [{ sessionId: SESS_A, files: 5, bytes: 1000, firstMs: NOW - 9e6, lastMs: NOW - 3600_000, model: 'm' }],
        responses: { files: 0, bytes: 0 },
        recentSrcNames: new Set(['seen.request.json']),
      },
      cards: CARDS, nowMs: NOW, windowMs: WIN, activeMs: ACT, limit: 20,
    })
    assert.strictEqual(r.writers[0].totalBytes, 1000 + 40) // 100 already ingested — not re-added
    assert.strictEqual(r.writers[0].workspace, '/w/proj-a')
  })

  test('ranks by recent rate first, total second; the active flag follows the last live write', () => {
    const r = buildBodyWritersReport({
      live: liveScanOf([
        { sessionId: SESS_A, files: [{ name: 'a.request.json', bytes: 30 * 1e6 }], bytes: 30 * 1e6, recentFiles: 1, recentBytes: 30 * 1e6, firstMs: NOW - 60_000, lastMs: NOW - 60_000, model: 'm' },
        { sessionId: SESS_B, files: [{ name: 'b.request.json', bytes: 1e6 }], bytes: 1e6, recentFiles: 1, recentBytes: 1e6, firstMs: NOW - 20 * 60_000, lastMs: NOW - 20 * 60_000, model: 'm' },
      ]),
      store: null, cards: CARDS, nowMs: NOW, windowMs: WIN, activeMs: ACT, limit: 20,
    })
    assert.strictEqual(r.writers[0].sessionId, SESS_A) // 1 MB/min beats 0.03 MB/min
    assert.strictEqual(r.writers[0].active, true)      // wrote 1m ago
    assert.strictEqual(r.writers[1].active, false)     // wrote 20m ago > active window
    assert.strictEqual(r.writers[0].rateMBmin.toFixed(1), '1.0')
  })

  test('zero-rate writers fall back to total-bytes order (historic hogs stay visible)', () => {
    const r = buildBodyWritersReport({
      live: liveScanOf([]),
      store: {
        sessions: [
          { sessionId: SESS_A, files: 1, bytes: 5e6, firstMs: 0, lastMs: 1, model: null },
          { sessionId: SESS_B, files: 9, bytes: 9e9, firstMs: 0, lastMs: 1, model: null },
        ],
        responses: { files: 0, bytes: 0 }, recentSrcNames: new Set(),
      },
      cards: [], nowMs: NOW, windowMs: WIN, activeMs: ACT, limit: 20,
    })
    assert.strictEqual(r.writers[0].sessionId, SESS_B)
  })

  test('without a store the live bytes ARE the total, and the note says the store was unavailable', () => {
    const r = buildBodyWritersReport({
      live: liveScanOf([{
        sessionId: SESS_A, files: [{ name: 'a.request.json', bytes: 77 }], bytes: 77,
        recentFiles: 0, recentBytes: 0, firstMs: 1, lastMs: 1, model: null,
      }]),
      store: null, cards: [], nowMs: NOW, windowMs: WIN, activeMs: ACT, limit: 20,
    })
    assert.strictEqual(r.writers[0].totalBytes, 77)
    assert.match(r.note, /STORE UNAVAILABLE/)
  })

  test('the text table names the active writer, its rate, and the unattributed responses line', () => {
    const r = buildBodyWritersReport({
      live: liveScanOf([{
        sessionId: SESS_A, files: [{ name: 'a.request.json', bytes: 3e6 }], bytes: 3e6,
        recentFiles: 1, recentBytes: 3e6, firstMs: NOW - 60_000, lastMs: NOW - 60_000, model: 'claude-fable-5',
      }]),
      store: null, cards: CARDS, nowMs: NOW, windowMs: WIN, activeMs: ACT, limit: 20,
    })
    assert.match(r.text, /●ACTIVE aaaa1111…/)
    assert.match(r.text, /0\.10MB\/min/)
    assert.match(r.text, /responses \(unattributable by design\)/)
  })

  test('the limit caps the list but totalWriters reports the full population', () => {
    const sessions = Array.from({ length: 5 }, (_, i) => ({
      sessionId: `${i}${SESS_A.slice(1)}`, files: [{ name: `${i}.request.json`, bytes: 10 }], bytes: 10,
      recentFiles: 0, recentBytes: 0, firstMs: 1, lastMs: 1, model: null,
    }))
    const r = buildBodyWritersReport({
      live: liveScanOf(sessions), store: null, cards: [], nowMs: NOW, windowMs: WIN, activeMs: ACT, limit: 2,
    })
    assert.strictEqual(r.writers.length, 2)
    assert.strictEqual(r.totalWriters, 5)
  })
})
