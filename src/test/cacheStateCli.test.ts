import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { cacheStateOf, runCacheStateCli, CACHE_STATE_EXIT } from '../cli/cacheStateCli'
import { EXIT, UsageError } from '../cli/cliErrors'

// TRDD-DCWJY2JJ — `agentlenspro cache-state`: the harness-reported prompt_cache row projected to one
// word with predicate exit codes. One test per exit code, on a fixture statusline store (no server).
// Field names mirror a LIVE captured row (flattened by the store), not the docs.

suite('cache-state — warm/cold verb over the persisted prompt_cache block (TRDD-DCWJY2JJ)', () => {
  let tmp: string
  let savedDataDir: string | undefined
  let out: string[]
  let err: string[]
  const realLog = console.log
  const realErr = console.error

  const day = new Date().toISOString().slice(0, 10)
  const SID = 'aaaaaaaa-0000-0000-0000-000000000000'
  const row = (over: Record<string, unknown>): string => JSON.stringify({
    session_id: SID,
    workspace_project_dir: '/proj/alpha',
    prompt_cache_ttl: '1h',
    prompt_cache_warm: true,
    prompt_cache_caching_observed: true,
    prompt_cache_expires_at: Math.floor(Date.now() / 1000) + 3600,
    prompt_cache_probe: null,
    ts: Date.now(),
    ...over,
  })
  const writeWal = (lines: string[]): void => {
    fs.writeFileSync(path.join(tmp, 'statusline', 'main', day, 'wal-1.ndjson'), lines.join('\n') + '\n')
  }

  setup(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'al-cachestate-'))
    savedDataDir = process.env.DATA_DIR
    process.env.DATA_DIR = tmp
    fs.mkdirSync(path.join(tmp, 'statusline', 'main', day), { recursive: true })
    out = []; err = []
    console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')) }
    console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ')) }
  })
  teardown(() => {
    console.log = realLog
    console.error = realErr
    if (savedDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = savedDataDir
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('exit 0: a live deadline with the harness saying warm prints exactly "warm"', () => {
    writeWal([row({})])
    assert.strictEqual(runCacheStateCli(['--project', '/proj/alpha']), CACHE_STATE_EXIT.WARM)
    assert.deepStrictEqual(out, ['warm'])
    assert.ok(err[0].includes('aaaaaaaa'), 'the measured session is announced on stderr')
  })

  test('exit 1: a passed deadline is "cold" even though the stale row still says warm:true', () => {
    // The stale-in-one-direction case the verb exists for: the status line refreshes only on activity.
    writeWal([row({ prompt_cache_expires_at: Math.floor(Date.now() / 1000) - 10 })])
    assert.strictEqual(runCacheStateCli(['--project', '/proj/alpha']), CACHE_STATE_EXIT.COLD)
    assert.deepStrictEqual(out, ['cold'])
  })

  test('exit 1: the harness saying warm:false is "cold" even with a live deadline (formula pinned)', () => {
    const future = Date.now() + 60_000
    assert.strictEqual(cacheStateOf({ expiresAtMs: future, warm: false }), 'cold')
    assert.strictEqual(cacheStateOf({ expiresAtMs: future, warm: true }), 'warm')
    assert.strictEqual(cacheStateOf({ expiresAtMs: future, warm: true }, future), 'cold')
    writeWal([row({ prompt_cache_warm: false })])
    assert.strictEqual(runCacheStateCli(['--project', '/proj/alpha']), CACHE_STATE_EXIT.COLD)
    assert.deepStrictEqual(out, ['cold'])
  })

  test('exit 2 with EMPTY stdout: no sample carries the block (pre-2.1.252 row, or another project only)', () => {
    writeWal([
      row({ workspace_project_dir: '/proj/beta' }),
      JSON.stringify({ session_id: SID, workspace_project_dir: '/proj/alpha', ts: Date.now() }),
    ])
    assert.strictEqual(runCacheStateCli(['--project', '/proj/alpha']), EXIT.UNKNOWN)
    assert.deepStrictEqual(out, [], 'never a word on stdout for a question it could not resolve')
    assert.ok(err[0].startsWith('cannot answer:'))
  })

  test('exit 2, not cold: a row with a live deadline but NO warm bit cannot be answered (adversarial-review finding)', () => {
    // The proxy trap: collapsing the bit to `=== true` turned "no bit" into "not warm" → `cold`.
    const future = Date.now() + 60_000
    assert.strictEqual(cacheStateOf({ expiresAtMs: future, warm: null }), null)
    assert.strictEqual(cacheStateOf({ expiresAtMs: future - 120_000, warm: null }), 'cold', 'a PASSED deadline settles it alone')
    writeWal([JSON.stringify({ session_id: SID, workspace_project_dir: '/proj/alpha', prompt_cache_ttl: '1h',
      prompt_cache_expires_at: Math.floor(future / 1000), ts: Date.now() })])
    assert.strictEqual(runCacheStateCli(['--project', '/proj/alpha']), EXIT.UNKNOWN)
    assert.deepStrictEqual(out, [])
    assert.ok(err[0].includes('no warm bit'))
  })

  test('exit 64: an unknown flag is refused, never silently ignored', () => {
    writeWal([row({})])
    assert.throws(() => runCacheStateCli(['--sesion', SID]), UsageError)
    assert.deepStrictEqual(out, [])
  })

  test('--json prints the stored prompt_cache_* fields verbatim plus state, session_id, captured_at', () => {
    const ts = Date.now()
    writeWal([row({ ts })])
    assert.strictEqual(runCacheStateCli(['--session', SID, '--json']), CACHE_STATE_EXIT.WARM)
    const j = JSON.parse(out.join('\n')) as Record<string, unknown>
    assert.strictEqual(j.state, 'warm')
    assert.strictEqual(j.session_id, SID)
    assert.strictEqual(j.captured_at, ts)
    assert.strictEqual(j.prompt_cache_warm, true)
    assert.strictEqual(j.prompt_cache_ttl, '1h')
    assert.strictEqual(j.prompt_cache_caching_observed, true)
    assert.ok('prompt_cache_probe' in j, 'a field the verb does not interpret still rides through')
    assert.ok(!('workspace_project_dir' in j), 'only the prompt_cache block is echoed')
  })
})
