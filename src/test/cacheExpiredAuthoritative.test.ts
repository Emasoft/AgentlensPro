import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { authoritativeFromWals, latestResumeStaleness } from '../cli/cacheExpiredCli'

// TRDD-YE15B2JK — the authoritative cache-expiry read: Claude Code ≥2.1.252 states the prompt-cache
// deadline in the statusline payload (`prompt_cache_expires_at`, epoch SECONDS); `cache-expired`
// reads the newest captured WAL row off disk instead of inferring from idle time. Field names here
// mirror a LIVE captured row (flattened), not the docs.

suite('cache-expired — authoritative statusline read (TRDD-YE15B2JK)', () => {
  let tmp: string
  let savedDataDir: string | undefined

  const day = new Date().toISOString().slice(0, 10)
  const row = (over: Record<string, unknown>): string => JSON.stringify({
    session_id: 'aaaaaaaa-0000-0000-0000-000000000000',
    workspace_project_dir: '/proj/alpha',
    prompt_cache_ttl: '1h',
    prompt_cache_warm: true,
    prompt_cache_expires_at: Math.floor(Date.now() / 1000) + 3600,
    ts: Date.now(),
    ...over,
  })

  setup(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'al-cacheexp-'))
    savedDataDir = process.env.DATA_DIR
    process.env.DATA_DIR = tmp
    fs.mkdirSync(path.join(tmp, 'statusline', 'main', day), { recursive: true })
  })
  teardown(() => {
    if (savedDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = savedDataDir
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const writeWal = (lines: string[]): void => {
    fs.writeFileSync(path.join(tmp, 'statusline', 'main', day, 'wal-1.ndjson'), lines.join('\n') + '\n')
  }

  test('a fresh harness-reported deadline answers false without any server', () => {
    writeWal([row({})])
    const v = authoritativeFromWals('/proj/alpha', undefined)
    assert.ok(v, 'must resolve a verdict from the WAL')
    assert.strictEqual(v!.expired, false)
    assert.strictEqual(v!.ttl, '1h')
  })

  test('a passed deadline answers true, and the NEWEST row wins over an older fresh one', () => {
    writeWal([
      row({ ts: Date.now() - 60_000, prompt_cache_expires_at: Math.floor(Date.now() / 1000) + 3600 }),
      row({ ts: Date.now(), prompt_cache_expires_at: Math.floor(Date.now() / 1000) - 10 }),
    ])
    const v = authoritativeFromWals('/proj/alpha', undefined)
    assert.strictEqual(v!.expired, true)
  })

  test('another project\'s rows never answer for this one; a pre-2.1.252 row (no prompt_cache) falls through', () => {
    writeWal([
      row({ workspace_project_dir: '/proj/beta' }),
      JSON.stringify({ session_id: 'bbbb2222-0000-0000-0000-000000000000', workspace_project_dir: '/proj/alpha', ts: Date.now() }),
    ])
    assert.strictEqual(authoritativeFromWals('/proj/alpha', undefined), null)
  })

  test('a torn final WAL line is skipped, not fatal', () => {
    fs.writeFileSync(
      path.join(tmp, 'statusline', 'main', day, 'wal-1.ndjson'),
      row({}) + '\n' + '{"session_id":"aaaaaaaa-0000-0000-0000-0000000',
    )
    const v = authoritativeFromWals('/proj/alpha', undefined)
    assert.ok(v)
    assert.strictEqual(v!.expired, false)
  })

  test('--session addressing matches by id regardless of project', () => {
    writeWal([row({ workspace_project_dir: '/proj/beta' })])
    const v = authoritativeFromWals(undefined, 'aaaaaaaa-0000-0000-0000-000000000000')
    assert.ok(v)
    assert.strictEqual(authoritativeFromWals(undefined, 'cccc3333-0000-0000-0000-000000000000'), null)
  })
})

// TRDD-ZQQYRYBO/I11 — SessionStart(resume) staleness (CC 2.1.251) is captured on a DIFFERENT store
// (the hook-event NDJSON buckets, not the statusline WAL) than the rows above; `latestResumeStaleness`
// is the read side that joins the two by session id, --json only.
suite('cache-state / cache-expired --json — the harness\'s own resume verdict (TRDD-ZQQYRYBO/I11)', () => {
  let tmp: string
  let savedDataDir: string | undefined

  setup(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'al-resume-'))
    savedDataDir = process.env.DATA_DIR
    process.env.DATA_DIR = tmp
    fs.mkdirSync(path.join(tmp, 'hook-events'), { recursive: true })
  })
  teardown(() => {
    if (savedDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = savedDataDir
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const writeHookEvents = (lines: Array<Record<string, unknown>>): void => {
    const day = new Date().toISOString().slice(0, 10)
    fs.writeFileSync(
      path.join(tmp, 'hook-events', `${day}.ndjsonl`),
      lines.map(l => JSON.stringify(l)).join('\n') + '\n',
    )
  }

  test('a stored resume payload renders the estimated re-cache cost', () => {
    const sid = 'e1b4c900-d366-4fc0-93a4-353bb259fe18'
    writeHookEvents([{
      ts: Date.now(),
      ev: 'SessionStart',
      session: sid,
      payload: {
        session_id: sid, hook_event_name: 'SessionStart', source: 'resume',
        seconds_since_last_response: 6_386_262, context_tokens: 569_470,
        prompt_cache_likely_expired: true, estimated_cache_write_usd: 5.6947,
      },
    }])
    const s = latestResumeStaleness(sid)
    assert.ok(s, 'a resumed session with a stored payload must resolve')
    assert.strictEqual(s!.estimatedCacheWriteUsd, 5.6947)
    assert.strictEqual(s!.promptCacheLikelyExpired, true)
  })

  test('no SessionStart on record for the session answers null, not a crash', () => {
    writeHookEvents([{ ts: Date.now(), ev: 'SessionStart', session: 'other-session', payload: { source: 'resume' } }])
    assert.strictEqual(latestResumeStaleness('missing-session'), null)
  })
})
