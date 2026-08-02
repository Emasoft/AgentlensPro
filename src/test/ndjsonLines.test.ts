import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { forEachNdjsonLine, countNdjsonLines } from '../ndjsonLines'

// ── Streaming NDJSON reader — real-filesystem tests ──────────────────────────
// The reader exists because `readFileSync(f,'utf8')` THROWS past V8's ~512 MB max string
// length, which killed `agentlenspro setup` outright and silently dropped whole days from
// the span store. A 512 MB fixture is not a unit test, so the chunk size is a parameter and
// every boundary case is driven through a 4-16 byte chunk instead — the same code path a
// 568 MB segment takes, only observable.

let seq = 0
function tmpFile(body: string): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `al-ndjson-${process.pid}-${seq++}-`))
  const file = path.join(dir, 'segment.ndjson')
  fs.writeFileSync(file, body)
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

function collect(file: string, chunkBytes: number): string[] {
  const seen: string[] = []
  forEachNdjsonLine(file, (l) => seen.push(l), chunkBytes)
  return seen
}

suite('ndjsonLines — streaming line reader', () => {
  test('skips blank lines, exactly as the readFileSync().split().filter(Boolean) it replaced', () => {
    const { file, cleanup } = tmpFile('{"a":1}\n\n{"a":2}\n\n\n{"a":3}\n')
    try {
      assert.deepStrictEqual(collect(file, 4096), ['{"a":1}', '{"a":2}', '{"a":3}'])
      assert.strictEqual(countNdjsonLines(file), 3)
    } finally { cleanup() }
  })

  test('delivers a final line that has no trailing newline (a segment killed mid-append)', () => {
    const { file, cleanup } = tmpFile('{"a":1}\n{"a":2}')
    try {
      assert.deepStrictEqual(collect(file, 4096), ['{"a":1}', '{"a":2}'])
      assert.strictEqual(countNdjsonLines(file), 2)
    } finally { cleanup() }
  })

  test('reassembles a line split across chunk reads — the whole point of the rewrite', () => {
    const lines = ['{"span":"aaaaaaaaaaaaaaaaaaaa"}', '{"span":"bbbbbbbbbbbbbbbbbbbb"}', '{"span":"cc"}']
    const { file, cleanup } = tmpFile(lines.join('\n') + '\n')
    try {
      // 7 bytes per read: every line spans several chunks and no boundary lands on a newline.
      assert.deepStrictEqual(collect(file, 7), lines)
      assert.strictEqual(countNdjsonLines(file, 7), 3)
      // Same answer at every chunk size, including one that is smaller than a single line.
      for (const size of [1, 2, 3, 5, 16, 64, 4096]) {
        assert.deepStrictEqual(collect(file, size), lines, `chunk size ${size}`)
      }
    } finally { cleanup() }
  })

  test('does not corrupt a multi-byte UTF-8 character split across chunk reads', () => {
    // 'é' is 2 bytes, '→' is 3, '𝄞' is 4 — with a 4-byte chunk each one straddles a read.
    const lines = ['{"t":"café→ok"}', '{"t":"𝄞𝄞𝄞"}', '{"t":"ünïcödé"}']
    const { file, cleanup } = tmpFile(lines.join('\n') + '\n')
    try {
      for (const size of [1, 2, 3, 4, 5, 8]) {
        assert.deepStrictEqual(collect(file, size), lines, `chunk size ${size}`)
      }
      // A naive buf.toString() per chunk would emit U+FFFD here; assert none survived.
      assert.ok(!collect(file, 4).join('').includes('�'), 'no replacement characters')
    } finally { cleanup() }
  })

  test('an empty file reads as zero lines, not as an error', () => {
    const { file, cleanup } = tmpFile('')
    try {
      assert.deepStrictEqual(collect(file, 8), [])
      assert.strictEqual(countNdjsonLines(file), 0)
    } finally { cleanup() }
  })

  test('a file of only newlines reads as zero lines', () => {
    const { file, cleanup } = tmpFile('\n\n\n')
    try {
      assert.strictEqual(countNdjsonLines(file, 2), 0)
    } finally { cleanup() }
  })

  test('names the corruption instead of resurfacing V8 max-string-length', () => {
    const { file, cleanup } = tmpFile('x'.repeat(200)) // one unterminated 200-char line
    try {
      assert.throws(
        () => forEachNdjsonLine(file, () => { /* never reached */ }, 16, 32),
        /exceeds 32 characters — the file is not NDJSON/,
      )
    } finally { cleanup() }
  })

  test('a missing file throws ENOENT — never a silent zero', () => {
    // The count feeds setup's data-preservation assertion (post >= pre); answering 0 on an
    // I/O error would make that comparison permanently true and hide real span loss.
    assert.throws(
      () => countNdjsonLines(path.join(os.tmpdir(), `al-ndjson-absent-${process.pid}-${seq++}.ndjson`)),
      (e: NodeJS.ErrnoException) => e.code === 'ENOENT',
    )
  })

  test('closes its file descriptor even when the callback throws', () => {
    const { file, cleanup } = tmpFile('{"a":1}\n{"a":2}\n')
    try {
      assert.throws(() => forEachNdjsonLine(file, () => { throw new Error('caller blew up') }, 4),
        /caller blew up/)
      // The re-read IS the proof: it succeeds only if the finally-block released the fd.
      assert.strictEqual(countNdjsonLines(file, 4), 2)
    } finally { cleanup() }
  })
})
