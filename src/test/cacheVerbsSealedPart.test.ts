import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { StatuslineStore } from '../statuslineStore'
import { authoritativeFromStore, authoritativeFromWals, readWalTail } from '../cli/cacheExpiredCli'
import { runCacheStateCli, CACHE_STATE_EXIT } from '../cli/cacheStateCli'

// TRDD-ETFX9JFM — the cache verbs answer from a SEALED part, not only from a write-ahead file. Real files and
// real DuckDB, no server: a StatuslineStore on the root the CLI reads (DATA_DIR/statusline).

suite('cache verbs answer from a sealed part (TRDD-ETFX9JFM)', () => {
  let tmp: string
  let savedDataDir: string | undefined
  let savedSealRows: string | undefined
  let out: string[]
  let err: string[]
  const realLog = console.log
  const realErr = console.error

  const SID = 'aaaaaaaa-0000-0000-0000-000000000000'
  const OTHER = 'bbbbbbbb-0000-0000-0000-000000000000'
  const expiresInAnHour = (): number => Math.floor(Date.now() / 1000) + 3600
  const store = (): StatuslineStore => new StatuslineStore({ root: path.join(tmp, 'statusline'), autoTimer: false })
  const storeFiles = (): string[] => {
    const main = path.join(tmp, 'statusline', 'main')
    return fs.readdirSync(path.join(main, fs.readdirSync(main)[0]))
  }

  setup(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'al-cache-part-'))
    savedDataDir = process.env.DATA_DIR
    savedSealRows = process.env.AGENTLENS_STATUSLINE_SEAL_ROWS
    process.env.DATA_DIR = tmp
    process.env.AGENTLENS_STATUSLINE_SEAL_ROWS = '1'
    out = []
    err = []
    console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')) }
    console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ')) }
  })
  teardown(() => {
    console.log = realLog
    console.error = realErr
    if (savedDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = savedDataDir
    if (savedSealRows === undefined) delete process.env.AGENTLENS_STATUSLINE_SEAL_ROWS
    else process.env.AGENTLENS_STATUSLINE_SEAL_ROWS = savedSealRows
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('cache-state --json gives the same prompt_cache fields from a part as from the write-ahead file', async () => {
    // A sealed part must answer the same CLI call with the same prompt_cache_* values as the WAL it came from.
    const s = store()
    s.append({ session_id: SID, workspace_project_dir: '/proj/alpha', prompt_cache_ttl: '1h', prompt_cache_warm: true, prompt_cache_expires_at: expiresInAnHour(), prompt_cache_probe: null }, 'main', Date.now())
    s.flush()
    const firstCode = await runCacheStateCli(['--session', SID, '--json'])
    const j1 = JSON.parse(out.join('\n')) as Record<string, unknown>
    out = []
    assert.strictEqual(await s.maybeSeal(Date.now()), 1)
    const files = storeFiles()
    assert.ok(files.some(f => /^part-.*\.parquet$/.test(f)), files.join(', '))
    assert.ok(!files.some(f => f.startsWith('wal-') && f.endsWith('.ndjson')), files.join(', '))
    const secondCode = await runCacheStateCli(['--session', SID, '--json'])
    const j2 = JSON.parse(out.join('\n')) as Record<string, unknown>
    assert.strictEqual(firstCode, CACHE_STATE_EXIT.WARM)
    assert.strictEqual(secondCode, CACHE_STATE_EXIT.WARM)
    assert.strictEqual(j2.state, j1.state)
    assert.strictEqual(j2.session_id, j1.session_id)
    assert.strictEqual(j2.captured_at, j1.captured_at)
    for (const k of Object.keys(j1).filter(key => key.startsWith('prompt_cache_'))) {
      assert.ok(k in j2, `part answer lacks ${k}: ${Object.keys(j2).join(', ')}`)
      assert.deepStrictEqual(j2[k], j1[k], k)
    }
  })

  test('authoritativeFromStore answers after the seal and authoritativeFromWals does not', async () => {
    // Once the row is sealed the WAL reader is blind; the store reader must return the verdict it gave before.
    const s = store()
    s.append({ session_id: SID, workspace_project_dir: '/proj/alpha', prompt_cache_ttl: '1h', prompt_cache_warm: true, prompt_cache_expires_at: expiresInAnHour() }, 'main', Date.now())
    s.flush()
    const w = authoritativeFromWals(undefined, SID)
    assert.ok(w !== null, 'the write-ahead row is visible before the seal')
    assert.strictEqual(await s.maybeSeal(Date.now()), 1)
    assert.strictEqual(authoritativeFromWals(undefined, SID), null)
    const sv = await authoritativeFromStore(undefined, SID)
    assert.ok(sv !== null, 'the sealed part answers')
    assert.strictEqual(sv.expiresAtMs, w.expiresAtMs)
    assert.strictEqual(sv.sampleTs, w.sampleTs)
    assert.strictEqual(sv.warm, w.warm)
    assert.strictEqual(sv.ttl, w.ttl)
    for (const k of Object.keys(w.promptCache)) assert.deepStrictEqual(sv.promptCache[k], w.promptCache[k], k)
  })

  test('the project filter holds on the part path', async () => {
    // A part row is kept for its own project and dropped for another, as a write-ahead row is.
    const s = store()
    s.append({ session_id: SID, workspace_project_dir: '/proj/alpha', prompt_cache_ttl: '1h', prompt_cache_warm: true, prompt_cache_expires_at: expiresInAnHour() }, 'main', Date.now())
    s.flush()
    assert.strictEqual(await s.maybeSeal(Date.now()), 1)
    assert.notStrictEqual(await authoritativeFromStore('/proj/alpha', undefined), null)
    assert.strictEqual(await authoritativeFromStore('/proj/other', undefined), null)
  })

  test('readWalTail returns only whole trailing lines', () => {
    // A file cut mid-line must yield only complete lines: the partial first line is never parsed.
    const file = path.join(tmp, 'wal-test.ndjson')
    fs.writeFileSync(file, '{"n":1}\n{"n":2}\n{"n":3}\n')
    assert.strictEqual(readWalTail(file), '{"n":1}\n{"n":2}\n{"n":3}\n')
    assert.strictEqual(readWalTail(file, 12), '{"n":3}\n')
  })

  test('a part row carries a null for a field only another sample sent', async () => {
    // A field one sample sent must appear as null, not be dropped, on the sample that never sent it.
    const s = store()
    const now = Date.now()
    s.append({ session_id: SID, workspace_project_dir: '/proj/alpha', prompt_cache_ttl: '1h', prompt_cache_warm: true, prompt_cache_expires_at: expiresInAnHour() }, 'main', now)
    s.append({ session_id: OTHER, workspace_project_dir: '/proj/beta', prompt_cache_ttl: '1h', prompt_cache_warm: true, prompt_cache_expires_at: expiresInAnHour(), prompt_cache_probe: 'x' }, 'main', now)
    s.flush()
    assert.strictEqual(await s.maybeSeal(now), 1)
    const first = await authoritativeFromStore(undefined, SID)
    assert.ok(first !== null, 'the first session answers from its part')
    assert.ok('prompt_cache_probe' in first.promptCache, 'the probe key is present on the sample that never sent it')
    assert.strictEqual(first.promptCache.prompt_cache_probe, null)
    const second = await authoritativeFromStore(undefined, OTHER)
    assert.ok(second !== null, 'the second session answers from its part')
    assert.strictEqual(second.promptCache.prompt_cache_probe, 'x')
  })
  test('an oversized write-ahead file is answered from its last 32 MiB: the tail row is found, a head-only row is not', () => {
    // authoritativeFromWals must read through readWalTail: a row that sits only in the first bytes of a file
    // over 32 MiB is not read, so the verdict comes from the tail alone.
    const dayDir = path.join(tmp, 'statusline', 'main', new Date().toISOString().slice(0, 10))
    fs.mkdirSync(dayDir, { recursive: true })
    const wal = path.join(dayDir, 'wal-test.ndjson')
    const row = (ts: number): string => JSON.stringify({
      session_id: SID, workspace_project_dir: '/proj/alpha', prompt_cache_ttl: '1h', prompt_cache_warm: true,
      prompt_cache_expires_at: expiresInAnHour(), ts,
    })
    const filler = Array.from({ length: 36_000 }, () => JSON.stringify({ session_id: OTHER, ts: 1, pad: 'x'.repeat(1000) })).join('\n')
    const tailTs = Date.now()
    fs.writeFileSync(wal, `${row(1000)}\n${filler}\n${row(tailTs)}\n`)
    const tail = authoritativeFromWals(undefined, SID)
    assert.ok(tail !== null, 'the row in the last 32 MiB is found')
    assert.strictEqual(tail.sampleTs, tailTs)
    fs.writeFileSync(wal, `${row(1000)}\n${filler}\n`)
    assert.strictEqual(authoritativeFromWals(undefined, SID), null, 'the head-only row is outside the tail and is not read')
  })
})
