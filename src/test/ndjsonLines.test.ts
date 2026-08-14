import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as zlib from 'zlib'
import { forEachNdjsonLine, countNdjsonLines, forEachNdjsonLineGz, forEachGunzipChunkSync, countNdjsonLinesAuto, forEachNdjsonLineAutoYielding } from '../ndjsonLines'

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

// ── Streaming SYNC gunzip driver — the tests forEachGunzipChunkSync's header promises ─────────
// The driver rides Node's internal `Gunzip._processChunk` (the only sync streaming path Node
// has — see the source comment). These tests are the pin that turns that internal dependency
// from a hope into a checked contract: byte-equality against the PUBLIC gunzipSync on every
// shape (multi-chunk, chunk-straddling UTF-8, empty), plus the truncation-throws claim.

function tmpGzFile(plain: Buffer | string): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `al-ndjson-gz-${process.pid}-${seq++}-`))
  const file = path.join(dir, 'segment.ndjson.gz')
  fs.writeFileSync(file, zlib.gzipSync(plain))
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

function gunzipStreamed(file: string, inChunkBytes: number): Buffer {
  const chunks: Buffer[] = []
  forEachGunzipChunkSync(file, (c) => chunks.push(Buffer.from(c)), inChunkBytes)
  return Buffer.concat(chunks)
}

suite('ndjsonLines — sync streaming gunzip', () => {
  test('streamed output is byte-identical to gunzipSync at every input chunk size', () => {
    // Big enough that a 16-byte input chunk forces hundreds of engine calls, with content that
    // does not compress away to nothing (varied lines), so the inflate dictionary must survive
    // across calls — the exact property the close-interception exists to protect.
    const plain = Buffer.from(
      Array.from({ length: 500 }, (_, i) => `{"span":"s${i}","payload":"${'x'.repeat(i % 97)}"}`).join('\n') + '\n',
    )
    const { file, cleanup } = tmpGzFile(plain)
    try {
      const oneShot = zlib.gunzipSync(fs.readFileSync(file))
      for (const size of [16, 64, 1024, 1 << 18]) {
        assert.ok(gunzipStreamed(file, size).equals(oneShot), `input chunk ${size} diverged from gunzipSync`)
      }
    } finally { cleanup() }
  })

  test('gz line reader delivers the same lines as the plain reader, multibyte chars included', () => {
    const lines = ['{"t":"café→ok"}', '{"t":"𝄞𝄞𝄞"}', `{"t":"${'ü'.repeat(300)}"}`]
    const body = lines.join('\n') + '\n'
    const { file, cleanup } = tmpGzFile(body)
    const plainFixture = tmpFile(body)
    try {
      for (const size of [3, 16, 4096]) {
        const seen: string[] = []
        forEachNdjsonLineGz(file, (l) => seen.push(l), size)
        assert.deepStrictEqual(seen, lines, `gz chunk size ${size}`)
      }
      assert.strictEqual(countNdjsonLinesAuto(file), countNdjsonLinesAuto(plainFixture.file))
    } finally { cleanup(); plainFixture.cleanup() }
  })

  test('an empty gz member reads as zero bytes and zero lines', () => {
    const { file, cleanup } = tmpGzFile('')
    try {
      assert.strictEqual(gunzipStreamed(file, 64).length, 0)
      assert.strictEqual(countNdjsonLinesAuto(file), 0)
    } finally { cleanup() }
  })

  test('a TRUNCATED gz file throws instead of returning partial data as if complete', () => {
    const plain = Buffer.from(Array.from({ length: 200 }, (_, i) => `{"s":${i}}`).join('\n'))
    const { file, cleanup } = tmpGzFile(plain)
    try {
      const whole = fs.readFileSync(file)
      fs.writeFileSync(file, whole.subarray(0, whole.length - 12)) // cut into the deflate body + trailer
      assert.throws(() => gunzipStreamed(file, 32), /unexpected end|invalid|truncated/i)
    } finally { cleanup() }
  })

  test('a many-chunk walk does not accumulate error listeners (CI MaxListenersExceededWarning)', function (done) {
    // processChunkSync adds an 'error' listener per call; un-dropped, the 11th chunk fires
    // MaxListenersExceededWarning (caught on CI, run 31741393697). 64-byte input chunks over this
    // payload force well past 11 calls; any warning fails the test.
    const plain = Buffer.from(Array.from({ length: 400 }, (_, i) => `{"s":"${i}-${'y'.repeat(i % 53)}"}`).join('\n'))
    const { file, cleanup } = tmpGzFile(plain)
    const onWarning = (w: Error): void => {
      cleanup()
      process.removeListener('warning', onWarning)
      done(new Error(`process warning during chunked gz walk: ${w.name} ${w.message}`))
    }
    process.on('warning', onWarning)
    try {
      const streamed = gunzipStreamed(file, 64)
      assert.ok(streamed.equals(zlib.gunzipSync(fs.readFileSync(file))))
    } catch (e) { process.removeListener('warning', onWarning); cleanup(); done(e as Error); return }
    // Warnings are emitted async (process.nextTick) — give them one macrotask to land.
    setTimeout(() => { process.removeListener('warning', onWarning); cleanup(); done() }, 50)
  })

  test('a corrupt (non-gzip) file throws — never silent zero output', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `al-ndjson-gz-${process.pid}-${seq++}-`))
    const file = path.join(dir, 'segment.ndjson.gz')
    fs.writeFileSync(file, 'this is not gzip data at all')
    try {
      assert.throws(() => gunzipStreamed(file, 32), /incorrect header|invalid/i)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

// ── forEachNdjsonLineAutoYielding — the async driver (TRDD-9NAUEUUR) ─────────────────────────
// Same generators, same assembler, same lines in the same order as the sync `*Auto` driver — the
// only difference is an `await setImmediate` between chunks so a long walk stops starving every
// other pending listener. These pin: byte-for-byte equivalence with the sync drivers (plain and
// gz), THE DISCRIMINATOR that the loop genuinely breathes (proven against a sync control that
// starves it), and that a throwing callback still releases the fd.

async function collectYielding(file: string, chunkBytes: number): Promise<string[]> {
  const seen: string[] = []
  await forEachNdjsonLineAutoYielding(file, (l) => seen.push(l), chunkBytes)
  return seen
}

suite('ndjsonLines — yielding async driver', () => {
  test('plain file: identical lines to forEachNdjsonLine at every chunk size, multibyte included', async () => {
    const lines = ['{"t":"café→ok"}', '{"t":"𝄞𝄞𝄞"}', '{"t":"ünïcödé"}']
    const { file, cleanup } = tmpFile(lines.join('\n') + '\n')
    try {
      for (const size of [3, 16, 4096]) {
        assert.deepStrictEqual(await collectYielding(file, size), lines, `chunk size ${size}`)
        assert.deepStrictEqual(await collectYielding(file, size), collect(file, size), `matches sync driver at chunk size ${size}`)
      }
    } finally { cleanup() }
  })

  test('gz file: identical lines to forEachNdjsonLineGz on the same body', async () => {
    const lines = ['{"t":"café→ok"}', '{"t":"𝄞𝄞𝄞"}', `{"t":"${'ü'.repeat(300)}"}`]
    const body = lines.join('\n') + '\n'
    const { file, cleanup } = tmpGzFile(body)
    try {
      for (const size of [3, 16, 4096]) {
        const sync: string[] = []
        forEachNdjsonLineGz(file, (l) => sync.push(l), size)
        assert.deepStrictEqual(await collectYielding(file, size), sync, `gz chunk size ${size}`)
        assert.deepStrictEqual(await collectYielding(file, size), lines, `gz chunk size ${size} vs source lines`)
      }
    } finally { cleanup() }
  })

  test('THE DISCRIMINATOR — the event loop breathes under the yielding driver, and only there', async () => {
    // A sync control run FIRST proves the counter genuinely discriminates: the synchronous walk
    // must starve the loop (ticks stay 0) or an assertion of "ticks > 0" for the yielding driver
    // would prove nothing — it could just be ambient event-loop activity unrelated to this API.
    const lines = Array.from({ length: 200 }, (_, i) => `{"i":${i},"pad":"${'x'.repeat(20)}"}`)
    const { file, cleanup } = tmpFile(lines.join('\n') + '\n')
    try {
      let ticks = 0
      let done = false
      const pump = (): void => {
        if (done) return
        ticks++
        setImmediate(pump)
      }

      ticks = 0
      setImmediate(pump)
      forEachNdjsonLine(file, () => { /* discard */ }, 16) // SYNC walk — must starve the pump
      const ticksDuringSync = ticks
      assert.strictEqual(ticksDuringSync, 0, 'the sync walk must starve the event loop — the control that makes the next assertion meaningful')

      ticks = 0
      await forEachNdjsonLineAutoYielding(file, () => { /* discard */ }, 16)
      assert.ok(ticks > 0, 'the yielding walk must let at least one scheduled setImmediate run mid-walk')

      done = true
    } finally { cleanup() }
  })

  test('onLine throws → the fd is released (re-read of the same file afterwards succeeds)', async () => {
    const { file, cleanup } = tmpFile('{"a":1}\n{"a":2}\n')
    try {
      await assert.rejects(
        forEachNdjsonLineAutoYielding(file, () => { throw new Error('caller blew up') }, 4),
        /caller blew up/,
      )
      // The re-read IS the proof: it succeeds only if the finally-block released the fd.
      assert.strictEqual(countNdjsonLines(file, 4), 2)
    } finally { cleanup() }
  })
})
