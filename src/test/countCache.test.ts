import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { openCountCache, cacheKey, nullCountCache, CACHE_DIR, CACHE_FILE, MAX_ROWS } from '../countCache'

// The cache exists to make a 152s measurement cost 2s. Every test here guards a way it could instead
// make it FAST AND WRONG, which is strictly worse than slow — the tool's whole claim is that its
// numbers are measured.

const API = '2023-06-01'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'countcache-'))
}

suite('countCache — fast, or honest about not knowing', () => {
  test('round-trips a count, and persists it to a new handle', () => {
    const dir = tmpDir()
    const body = '{"model":"m","messages":[]}'
    const k = cacheKey(body)

    const a = openCountCache({ dir, apiVersion: API })
    assert.strictEqual(a.get(k, body), null, 'empty cache must not invent a number')
    a.put(k, 'm', 1234)
    a.stats() // flushes

    const b = openCountCache({ dir, apiVersion: API })
    assert.strictEqual(b.get(k, body), 1234)
  })

  test('a different body is a different key — changed content can never hit', () => {
    const dir = tmpDir()
    const before = '{"model":"m","messages":[{"t":"a"}]}'
    const after = '{"model":"m","messages":[{"t":"b"}]}'
    const c = openCountCache({ dir, apiVersion: API })
    c.put(cacheKey(before), 'm', 999)
    assert.strictEqual(c.get(cacheKey(after), after), null,
      'editing the request must miss, not serve the old count')
  })

  test('rows from another API version are ignored rather than guessed at', () => {
    const dir = tmpDir()
    const body = '{"x":1}'
    const k = cacheKey(body)
    const a = openCountCache({ dir, apiVersion: API })
    a.put(k, 'm', 500)
    a.stats()
    const b = openCountCache({ dir, apiVersion: '2099-01-01' })
    assert.strictEqual(b.get(k, body), null)
  })

  // THE REGRESSION THIS SUITE EXISTS FOR. The first implementation wrote the tombstone under its own
  // key, so reloading replayed the drifted rows and served them again — a stale hit surviving the
  // very mechanism meant to forget it. Order-of-replay is what makes the drop stick.
  test('dropModel survives a reload, and does not eat entries written after it', () => {
    const dir = tmpDir()
    const oldBody = '{"old":1}', newBody = '{"new":1}'
    const a = openCountCache({ dir, apiVersion: API })
    a.put(cacheKey(oldBody), 'opus', 111)
    a.dropModel('opus')
    a.put(cacheKey(newBody), 'opus', 222)
    a.stats()

    const b = openCountCache({ dir, apiVersion: API })
    assert.strictEqual(b.get(cacheKey(oldBody), oldBody), null, 'dropped entry came back after reload')
    assert.strictEqual(b.get(cacheKey(newBody), newBody), 222, 're-measured entry must survive the drop')
  })

  test('a remembered 400 is returned as an error, never as a count', () => {
    const dir = tmpDir()
    const body = '{"bad":1}'
    const k = cacheKey(body)
    const a = openCountCache({ dir, apiVersion: API })
    a.putError(k, 'm', 'count_tokens 400: final block in an assistant message cannot be thinking')
    a.stats()

    const b = openCountCache({ dir, apiVersion: API })
    assert.strictEqual(b.get(k, body), null, 'an error row must not be served as a token count')
    assert.match(b.getError(k, body) ?? '', /400/)
  })

  // Without this the sentinel could only ever probe successful counts, so a remembered 400 would be
  // served forever even if the endpoint started accepting that body.
  test('a remembered 400 is eligible for the freshness probe', () => {
    const dir = tmpDir()
    const body = '{"bad":2}'
    const k = cacheKey(body)
    const c = openCountCache({ dir, apiVersion: API })
    c.putError(k, 'm', 'count_tokens 400: nope')
    c.stats()

    const d = openCountCache({ dir, apiVersion: API })
    assert.strictEqual(d.largestHit(), null, 'nothing probed before a lookup happens')
    d.getError(k, body)
    const probe = d.largestHit()
    assert.ok(probe, 'an error row must be probeable')
    assert.strictEqual(probe?.tokens, -1, '-1 is what marks the probe as expecting another 400')
    assert.strictEqual(probe?.wireBody, body, 'the probe must carry the exact bytes to re-post')
  })

  // A real count always outranks an error row, so the probe stays as strong as possible.
  test('a successful count outranks an error row as the probe', () => {
    const dir = tmpDir()
    const good = '{"good":1}', bad = '{"bad":3}'
    const c = openCountCache({ dir, apiVersion: API })
    c.put(cacheKey(good), 'm', 5000)
    c.putError(cacheKey(bad), 'm', 'count_tokens 400: nope')
    c.stats()

    const d = openCountCache({ dir, apiVersion: API })
    d.getError(cacheKey(bad), bad)
    d.get(cacheKey(good), good)
    assert.strictEqual(d.largestHit()?.tokens, 5000)
  })

  test('compaction bounds the file and keeps the newest rows', () => {
    const dir = tmpDir()
    const c = openCountCache({ dir, apiVersion: API })
    for (let i = 0; i < MAX_ROWS + 500; i++) c.put(cacheKey(`{"i":${i}}`), 'm', i + 1)
    c.stats()

    const before = fs.readFileSync(path.join(dir, CACHE_DIR, CACHE_FILE), 'utf8').trim().split('\n').length
    assert.ok(before > MAX_ROWS, 'precondition: the file is oversized before compaction')

    const d = openCountCache({ dir, apiVersion: API })   // compacts on open
    const after = fs.readFileSync(path.join(dir, CACHE_DIR, CACHE_FILE), 'utf8').trim().split('\n').length
    assert.strictEqual(after, MAX_ROWS, 'compaction must bound the file')

    const newest = `{"i":${MAX_ROWS + 499}}`
    assert.strictEqual(d.get(cacheKey(newest), newest), MAX_ROWS + 500, 'newest row must survive')
    const oldest = '{"i":0}'
    assert.strictEqual(d.get(cacheKey(oldest), oldest), null, 'oldest row is the one dropped')
  })

  test('bypassReads serves nothing but still records — --refresh must not leave the cache stale', () => {
    const dir = tmpDir()
    const body = '{"y":2}'
    const k = cacheKey(body)
    const seed = openCountCache({ dir, apiVersion: API })
    seed.put(k, 'm', 7)
    seed.stats()

    const refresh = openCountCache({ dir, apiVersion: API, bypassReads: true })
    assert.strictEqual(refresh.get(k, body), null, 'refresh must not serve a stored count')
    refresh.put(k, 'm', 8)
    refresh.stats()

    const after = openCountCache({ dir, apiVersion: API })
    assert.strictEqual(after.get(k, body), 8, 'refresh must leave the NEW measurement behind')
  })

  test('a torn trailing line is skipped, not fatal — the file is appended to concurrently', () => {
    const dir = tmpDir()
    const body = '{"z":3}'
    const k = cacheKey(body)
    const a = openCountCache({ dir, apiVersion: API })
    a.put(k, 'm', 42)
    a.stats()
    fs.appendFileSync(path.join(dir, CACHE_DIR, CACHE_FILE), '{"v":1,"api":"2023-06-0')

    const b = openCountCache({ dir, apiVersion: API })
    assert.strictEqual(b.get(k, body), 42)
  })

  test('AGENTLENS_COUNT_CACHE=off disables it entirely', () => {
    const dir = tmpDir()
    const c = openCountCache({ dir, apiVersion: API, env: { AGENTLENS_COUNT_CACHE: 'off' } })
    c.put(cacheKey('{"a":1}'), 'm', 5)
    assert.strictEqual(c.get(cacheKey('{"a":1}'), '{"a":1}'), null)
    assert.ok(!fs.existsSync(path.join(dir, CACHE_DIR, CACHE_FILE)), 'disabled cache must not write')
  })

  test('nullCountCache never hits and never throws', () => {
    const n = nullCountCache()
    n.put('k', 'm', 1)
    n.putError('k', 'm', 'boom')
    assert.strictEqual(n.get('k', 'body'), null)
    assert.strictEqual(n.getError('k', 'body'), null)
    assert.strictEqual(n.largestHit(), null)
    assert.strictEqual(n.stats().hits, 0)
  })
})
