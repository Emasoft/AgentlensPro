import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { LineLog, clampFlushMs, DEFAULT_FLUSH_MS, MAX_FLUSH_MS } from '../cli/lineLog'

// ── LineLog: write-coalescing append log ──────────────────────────────────────
// Real files in a real tmpdir — the whole point of this class is what lands on disk, so a mocked
// fs would test nothing. Every case below is a corruption mode we are promising cannot happen.

let seq = 0
function tmpFile(): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `al-linelog-${process.pid}-${seq++}-`))
  return { file: path.join(dir, 'nested', 'watch.log'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}
const read = (f: string): string => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')

suite('lineLog: coalescing without losing integrity', () => {
  test('creates missing parent directories at construction instead of failing at the first event', () => {
    const { file, cleanup } = tmpFile()
    try {
      const log = new LineLog(file, { flushMs: 0 })
      assert.ok(fs.existsSync(file), 'the file must exist as soon as the log is constructed')
      log.close()
    } finally { cleanup() }
  })

  test('buffers instead of writing on every line, then lands them all in one flush', () => {
    const { file, cleanup } = tmpFile()
    try {
      const log = new LineLog(file, { flushMs: 60_000 })
      log.write('a'); log.write('b'); log.write('c')
      assert.strictEqual(read(file), '', 'nothing may hit the disk before the window elapses')
      assert.strictEqual(log.stats().pendingLines, 3)
      log.flush()
      assert.strictEqual(read(file), 'a\nb\nc\n')
      log.close()
    } finally { cleanup() }
  })

  test('flushMs 0 writes through — the no-loss-window setting really has no window', () => {
    const { file, cleanup } = tmpFile()
    try {
      const log = new LineLog(file, { flushMs: 0 })
      log.write('now')
      assert.strictEqual(read(file), 'now\n')
      log.close()
    } finally { cleanup() }
  })

  test('every buffered line ends in a newline — a reader can never see a torn record', () => {
    const { file, cleanup } = tmpFile()
    try {
      const log = new LineLog(file, { flushMs: 60_000 })
      for (const l of ['one', 'two', 'three']) log.write(l)
      log.close()
      const body = read(file)
      assert.ok(body.endsWith('\n'))
      assert.deepStrictEqual(body.split('\n').filter(Boolean), ['one', 'two', 'three'])
    } finally { cleanup() }
  })

  test('an embedded newline is neutralised so one event stays exactly one line', () => {
    const { file, cleanup } = tmpFile()
    try {
      const log = new LineLog(file, { flushMs: 0 })
      log.write('peak\nsplit\r\nagain')
      log.close()
      assert.strictEqual(read(file).split('\n').filter(Boolean).length, 1,
        'a multi-line event must not masquerade as several events')
    } finally { cleanup() }
  })

  test('APPENDS to an existing file — a restarted watch never truncates its own history', () => {
    const { file, cleanup } = tmpFile()
    try {
      const a = new LineLog(file, { flushMs: 0 })
      a.write('first run'); a.close()
      const b = new LineLog(file, { flushMs: 0 })
      b.write('second run'); b.close()
      assert.deepStrictEqual(read(file).split('\n').filter(Boolean), ['first run', 'second run'])
    } finally { cleanup() }
  })

  test('two concurrent logs on ONE file interleave whole lines, losing none', () => {
    const { file, cleanup } = tmpFile()
    try {
      const a = new LineLog(file, { flushMs: 60_000 })
      const b = new LineLog(file, { flushMs: 60_000 })
      for (let i = 0; i < 50; i++) { a.write(`a${i}`); b.write(`b${i}`) }
      a.flush(); b.flush()
      const lines = read(file).split('\n').filter(Boolean)
      assert.strictEqual(lines.length, 100, 'O_APPEND must not let one writer clobber the other')
      assert.strictEqual(lines.filter(l => l.startsWith('a')).length, 50)
      assert.strictEqual(lines.filter(l => l.startsWith('b')).length, 50)
      assert.ok(lines.every(l => /^[ab]\d+$/.test(l)), 'no line may be a fragment of two writes')
      a.close(); b.close()
    } finally { cleanup() }
  })

  test('a full buffer force-flushes, bounding both memory and the loss window', () => {
    const { file, cleanup } = tmpFile()
    try {
      const log = new LineLog(file, { flushMs: 60_000, maxBufferBytes: 4096 })
      for (let i = 0; i < 500; i++) log.write(`line ${i} ${'x'.repeat(40)}`)
      assert.ok(log.stats().pendingBytes < 4096, 'the cap must have forced a write before now')
      assert.ok(read(file).length > 0, 'lines must already be on disk despite the 60s window')
      log.close()
      assert.strictEqual(read(file).split('\n').filter(Boolean).length, 500, 'no line lost to the cap')
    } finally { cleanup() }
  })

  test('close() flushes the tail and is idempotent', () => {
    const { file, cleanup } = tmpFile()
    try {
      const log = new LineLog(file, { flushMs: 60_000 })
      log.write('tail')
      log.close(); log.close()
      assert.strictEqual(read(file), 'tail\n')
      log.write('after close')
      assert.strictEqual(read(file), 'tail\n', 'a closed log accepts nothing further')
    } finally { cleanup() }
  })

  test('flush on an empty buffer is a no-op, not an empty write', () => {
    const { file, cleanup } = tmpFile()
    try {
      const log = new LineLog(file, { flushMs: 60_000 })
      log.flush(); log.flush()
      assert.strictEqual(read(file), '')
      log.close()
    } finally { cleanup() }
  })

  test('a failing disk degrades the LOG, never the watch: reports once, keeps a bounded buffer', () => {
    const { file, cleanup } = tmpFile()
    try {
      const errs: string[] = []
      const log = new LineLog(file, { flushMs: 60_000, maxBufferBytes: 4096, onError: m => errs.push(m) })
      // Replace the file with a directory — every subsequent append now fails for real.
      fs.rmSync(file)
      fs.mkdirSync(file)
      for (let i = 0; i < 400; i++) log.write(`line ${i} ${'y'.repeat(40)}`)
      assert.ok(errs.length >= 1, 'the failure must be reported')
      assert.strictEqual(errs.filter(e => e.includes('write failed')).length, 1, 'reported ONCE per episode, not per line')
      assert.ok(log.stats().dropped > 0, 'the oldest lines are dropped and counted, not silently kept')
      assert.ok(log.stats().pendingBytes <= 4096 + 200, 'memory stays bounded while the disk is broken')
    } finally { cleanup() }
  })

  test('recovery reports how many lines were lost rather than pretending the log is complete', () => {
    const { file, cleanup } = tmpFile()
    try {
      const errs: string[] = []
      const log = new LineLog(file, { flushMs: 60_000, maxBufferBytes: 4096, onError: m => errs.push(m) })
      fs.rmSync(file); fs.mkdirSync(file)
      for (let i = 0; i < 400; i++) log.write(`line ${i} ${'y'.repeat(40)}`)
      fs.rmdirSync(file)                       // disk "comes back"
      log.flush()
      const recovered = errs.find(e => e.includes('recovered'))
      assert.ok(recovered, 'recovery must be announced')
      assert.match(recovered as string, /\d+ line\(s\) were dropped/)
      assert.strictEqual(log.stats().dropped, 0, 'the drop counter resets once reported')
      log.close()
    } finally { cleanup() }
  })

  test('the flush timer never keeps the process alive by itself', () => {
    const { file, cleanup } = tmpFile()
    try {
      const log = new LineLog(file, { flushMs: 60_000 })
      log.write('x')
      const t = (log as unknown as { timer: NodeJS.Timeout | null }).timer
      assert.ok(t, 'a timer should be pending')
      assert.ok((t as NodeJS.Timeout & { hasRef?: () => boolean }).hasRef?.() === false,
        'the timer must be unref()d or a finished CLI would hang for the whole window')
      log.close()
    } finally { cleanup() }
  })
})

suite('lineLog: clampFlushMs', () => {
  test('keeps a sane value, floors nonsense to the default, and caps the maximum', () => {
    assert.strictEqual(clampFlushMs(500), 500)
    assert.strictEqual(clampFlushMs(0), 0)
    assert.strictEqual(clampFlushMs(-1), DEFAULT_FLUSH_MS)
    assert.strictEqual(clampFlushMs(Number.NaN), DEFAULT_FLUSH_MS)
    assert.strictEqual(clampFlushMs(10 ** 9), MAX_FLUSH_MS)
  })
})
