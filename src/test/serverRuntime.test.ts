// TRDD-PJC8N1HO — unit tests for the collector runtime resilience primitives (real fs, no mocks).
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { atomicWriteFileSync, heapPressure, RequestLog } from '../serverRuntime'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-runtime-'))
}

suite('serverRuntime — atomicWriteFileSync', () => {
  test('writes the content and leaves no temp file behind', () => {
    const dir = tmpDir()
    const f = path.join(dir, 'data.json')
    atomicWriteFileSync(f, '{"a":1}')
    assert.strictEqual(fs.readFileSync(f, 'utf8'), '{"a":1}')
    assert.deepStrictEqual(fs.readdirSync(dir), ['data.json'])  // no .tmp-* orphan
  })

  test('overwrites an existing file (rename replaces atomically)', () => {
    const dir = tmpDir()
    const f = path.join(dir, 'data.json')
    atomicWriteFileSync(f, 'old')
    atomicWriteFileSync(f, 'new-longer-content')
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'new-longer-content')
    assert.deepStrictEqual(fs.readdirSync(dir), ['data.json'])
  })

  test('throws when the target directory does not exist and leaves no temp file', () => {
    const dir = tmpDir()
    const f = path.join(dir, 'nope', 'data.json')  // parent dir missing
    assert.throws(() => atomicWriteFileSync(f, 'x'))
    assert.deepStrictEqual(fs.readdirSync(dir), [])  // no partial temp leaked
  })
})

suite('serverRuntime — heapPressure', () => {
  test('an absolute HWM override below current heap reports over=true', () => {
    const prev = process.env.AGENTLENS_HEAP_HWM_MB
    process.env.AGENTLENS_HEAP_HWM_MB = '1'  // 1MB HWM — always exceeded
    try {
      const p = heapPressure()
      assert.strictEqual(p.over, true)
      assert.strictEqual(p.hwmMb, 1)
      assert.ok(p.heapUsedMb > 1)
      assert.ok(p.limitMb > 1)
    } finally { if (prev === undefined) delete process.env.AGENTLENS_HEAP_HWM_MB; else process.env.AGENTLENS_HEAP_HWM_MB = prev }
  })

  test('default HWM is 85% of the V8 heap limit and normal heap is under it', () => {
    const prev = process.env.AGENTLENS_HEAP_HWM_MB
    delete process.env.AGENTLENS_HEAP_HWM_MB
    try {
      const p = heapPressure()
      assert.ok(Math.abs(p.hwmMb - p.limitMb * 0.85) < 1)
      assert.strictEqual(p.over, false)  // a test process uses far less than 85% of the limit
    } finally { if (prev !== undefined) process.env.AGENTLENS_HEAP_HWM_MB = prev }
  })
})

suite('serverRuntime — RequestLog', () => {
  // rss > heap deliberately: that gap IS the diagnostic signal (a healthy server measured heap 860MB
  // against RSS 2624MB), so a fixture with rss == heap would pass a formatter that dropped one.
  const entry = (path: string, status = 200) => ({ ts: new Date().toISOString(), method: 'GET', path, status, durationMs: 1, bytes: 10, heapUsedMb: 5, rssMb: 42 })

  test('ring keeps only the most-recent N entries, oldest-first', () => {
    const log = new RequestLog(null, 3)
    for (let i = 0; i < 5; i++) log.record(entry(`/p${i}`))
    const recent = log.recent()
    assert.strictEqual(recent.length, 3)
    assert.deepStrictEqual(recent.map(e => e.path), ['/p2', '/p3', '/p4'])
  })

  test('recent(limit) returns the last `limit` entries', () => {
    const log = new RequestLog(null, 10)
    for (let i = 0; i < 6; i++) log.record(entry(`/p${i}`))
    assert.deepStrictEqual(log.recent(2).map(e => e.path), ['/p4', '/p5'])
  })

  test('the logged line carries RSS as well as heap — heap alone cannot explain an OOM kill', () => {
    // TRDD-34B9JAZK: the previous post-mortem stalled because this log recorded heap only. Heap sat
    // at 1768MB against a 6144MB cap right up to the death, which looks fine and is why the
    // mechanism was never established — while ~67% of the real footprint (DuckDB's native arena,
    // buffers, the segment index) is off-heap and invisible to that number. `--max-old-space-size`
    // bounds V8's old space, never RSS, and an external SIGKILL acts on RSS.
    const dir = tmpDir()
    const f = path.join(dir, 'requests.log')
    new RequestLog(f, 10, 8 * 1024 * 1024).record(entry('/api/thing'))
    const line = fs.readFileSync(f, 'utf8')
    assert.ok(/heap=5MB/.test(line), `heap must still be there, got: ${line}`)
    assert.ok(/rss=42MB/.test(line), `RSS must be recorded, got: ${line}`)
  })

  test('appends one line per request to the file and rotates at the size cap', () => {
    const dir = tmpDir()
    const f = path.join(dir, 'requests.log')
    const log = new RequestLog(f, 100, 200)  // tiny 200-byte cap forces rotation
    for (let i = 0; i < 20; i++) log.record(entry(`/path-number-${i}`))
    assert.ok(fs.existsSync(f))
    assert.ok(fs.existsSync(`${f}.1`))  // rotated backup exists
    assert.ok(fs.statSync(f).size <= 300)  // active file stays bounded near the cap
  })

  test('record never throws when no file path is configured', () => {
    const log = new RequestLog(null)
    assert.doesNotThrow(() => log.record(entry('/x')))
  })
})
