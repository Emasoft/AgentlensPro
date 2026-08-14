// Streaming NDJSON line reader — the one way this codebase walks a span segment.
//
// WHY THIS EXISTS: `fs.readFileSync(file, 'utf8')` cannot return a string longer than V8's
// hard limit (0x1fffffe8 chars ≈ 512 MB); past it, it THROWS
// "Cannot create a string longer than 0x1fffffe8 characters". Segments have no size cap by
// design (see segmentedSpanStore's header: no eviction, retention deletes whole expired days),
// so a busy day crosses that line on its own. Measured 2026-08-02 on a live store: two
// segments at 568 MB and 531 MB, and BOTH readers of those files were broken by it —
// `agentlenspro setup` died outright, and the store's own loadRange silently skipped the day
// inside a `catch { continue }`, which is precisely the silent data loss the store was built
// to end. Streaming removes the ceiling and the peak memory with it: a segment is walked in
// chunks, never materialized whole.
//
// Sync on purpose for the sync callers (a CLI probe and the store's sync reads): making THOSE
// async would ripple through call chains for no gain — the cost is disk I/O, which readSync and
// a stream pay alike. The ONE deliberate exception is `forEachNdjsonLineAutoYielding`
// (TRDD-9NAUEUUR): the server's long walks (a no-window scan is 60s+ over 5M+ spans) ran on the
// main thread and starved EVERY listener for their whole duration — `server status` reported NOT
// RUNNING against a healthy server. The yielding driver awaits setImmediate between chunks so
// pending I/O events are served mid-walk. It is a thin async driver over the SAME chunk
// generators the sync drivers use — one version of the read logic, two pump schedules.

import * as fs from 'fs'
import * as zlib from 'zlib'
import { StringDecoder } from 'string_decoder'

const CHUNK_BYTES = 1 << 22 // 4 MiB — big enough that syscall overhead vanishes, small enough to stay off the heap

/** A single line this long is not a span, it is corruption. Named explicitly so the failure
 *  says WHAT is wrong instead of resurfacing V8's max-string-length error one layer down —
 *  the exact error whose cryptic wording hid this bug in the first place. Counted in CHARS,
 *  because that is the unit V8's limit is expressed in and the unit `carry` is measured in. */
const MAX_LINE_CHARS = 64 << 20 // ~64M chars

/** The line-assembly core shared by the plain-file and gzip readers below, PUSH-shaped so both a
 *  pull loop (a live fd) and a push producer (the streaming gunzip driver) can feed it. Sharing
 *  this is what lets the gzip reader reuse the exact same line-assembly + corruption-guard logic
 *  instead of ever building one giant decompressed STRING (which would reintroduce the very V8
 *  max-string-length ceiling this module exists to route around — see the module header). */
class NdjsonLineAssembler {
  // StringDecoder, not buf.toString(): a UTF-8 sequence straddling a chunk boundary would
  // otherwise decode to replacement characters on both sides and corrupt that span's JSON.
  private decoder = new StringDecoder('utf8')
  private carry = ''
  constructor(
    private readonly onLine: (line: string) => void,
    private readonly maxLineChars: number,
    private readonly file: string,
  ) {}

  push(chunk: Buffer | Uint8Array): void {
    const text = this.carry + this.decoder.write(chunk as Buffer)
    let start = 0
    for (;;) {
      const nl = text.indexOf('\n', start)
      if (nl === -1) break
      const line = text.slice(start, nl)
      if (line) this.onLine(line)
      start = nl + 1
    }
    this.carry = text.slice(start)
    if (this.carry.length > this.maxLineChars) {
      throw new Error(`${this.file}: a single line exceeds ${this.maxLineChars} characters — the file is not NDJSON`)
    }
  }

  end(): void {
    this.carry += this.decoder.end()
    if (this.carry) this.onLine(this.carry)
  }
}

/** Raw file bytes as a chunk sequence. Each yielded chunk is a view over ONE reused buffer, so
 *  it is valid only until the next `next()` call — every consumer below copies it immediately
 *  (the assembler's StringDecoder copies on write). The generator shape is what lets one read
 *  loop serve both pump schedules (sync drive-to-completion, and the yielding async drive);
 *  `finally` releases the fd on completion, early exit, and throw alike, because for-of calls
 *  `return()` on the generator in all three cases. */
function* fileChunks(file: string, chunkBytes: number): Generator<Buffer> {
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.allocUnsafe(chunkBytes)
  try {
    for (;;) {
      const read = fs.readSync(fd, buf, 0, chunkBytes, null)
      if (read === 0) return
      yield buf.subarray(0, read)
    }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Walk a newline-delimited file, calling `onLine` once per NON-EMPTY line (blank lines are
 * skipped, matching the `split('\n').filter(Boolean)` semantics every caller had before).
 * A final line without a trailing newline is delivered.
 *
 * `chunkBytes` and `maxLineChars` are test seams: pass tiny values to exercise the
 * chunk-boundary paths (a line split across reads, a multi-byte character split across reads)
 * and the corruption guard without writing multi-megabyte fixtures.
 */
export function forEachNdjsonLine(
  file: string,
  onLine: (line: string) => void,
  chunkBytes: number = CHUNK_BYTES,
  maxLineChars: number = MAX_LINE_CHARS,
): void {
  const assembler = new NdjsonLineAssembler(onLine, maxLineChars, file)
  for (const chunk of fileChunks(file, chunkBytes)) assembler.push(chunk)
  assembler.end()
}

/** Compressed bytes fed to the inflate engine per call. Small on purpose: the engine returns that
 *  call's ENTIRE decompressed output as one Buffer, so the input chunk bounds the output spike —
 *  256 KiB compressed is ~5 MB out at the measured 19.5x segment ratio (pathological all-zeros
 *  input tops out near the deflate format's own ~1000x ceiling, still only ~256 MB, once). */
const GZ_IN_CHUNK_BYTES = 1 << 18

/** Engine surface the sync streaming driver needs. `_processChunk` is Node's own internal
 *  synchronous inflate step — see `forEachGunzipChunkSync` for why touching an underscore API is
 *  the deliberate, tested choice here rather than an accident. */
interface SyncZlibEngine {
  _processChunk?: (chunk: Buffer, flushFlag: number) => Buffer | undefined
  _handle?: { close: () => void } | null
  close: () => void
}

/**
 * Walk a gzip file's DECOMPRESSED bytes chunk-by-chunk, synchronously, without ever holding the
 * whole decompressed day in memory.
 *
 * WHY THE INTERNAL API: public zlib has sync one-shot calls (`gunzipSync` — whole output in one
 * Buffer, the exact unbounded allocation this helper exists to kill: a sealed day measured 568 MB
 * decompressed, and repeated day-sized transients are what ratcheted RSS into the kill band in
 * TRDD-34B9JAZK) and async streams (unusable: every caller of the segment readers is sync by
 * design — see the module header). The ONLY sync streaming path Node has is
 * `Gunzip.prototype._processChunk`, the internal step `gunzipSync` itself is built on; driving it
 * chunk-by-chunk is exactly what minizlib does for node-tar's sync mode, so the mechanism is
 * exercised by one of npm's most-installed packages on every Node release. Two guards keep this
 * honest rather than hopeful: the engine shape is asserted up front (a Node that removes the API
 * fails LOUDLY here, never silently mis-reads), and `ndjsonLines.test.ts` pins byte-equality
 * against `gunzipSync` so an internal-behaviour change fails the suite, not production.
 *
 * The close-interception inside the loop mirrors minizlib: `_processChunk`'s sync path closes the
 * native handle when it believes the one-shot convenience call is done, which would destroy the
 * inflate dictionary state the NEXT chunk needs — so close is a no-op for the duration of each
 * call and restored after. Single-member gzip only (what `compressSealedSegments` writes);
 * trailing garbage after the member is ignored, as `gunzipSync` also ignores it.
 */
export function forEachGunzipChunkSync(
  file: string,
  onChunk: (chunk: Buffer) => void,
  inChunkBytes: number = GZ_IN_CHUNK_BYTES,
): void {
  for (const chunk of gunzipChunks(file, inChunkBytes)) onChunk(chunk)
}

/** The engine loop behind `forEachGunzipChunkSync`, as a generator so the yielding async driver
 *  can pump the same loop with awaits in between (see the module header). Every yielded chunk is
 *  a FRESH Buffer from the engine (never a reused view), so holding one across `next()` is safe
 *  here — unlike `fileChunks` above. All three `_processChunk` interceptions live in this one
 *  place; the `finally` (fd close + engine close) runs on completion, early exit, and throw
 *  alike via the generator `return()` protocol. */
function* gunzipChunks(file: string, inChunkBytes: number): Generator<Buffer> {
  const engine = new zlib.Gunzip({ chunkSize: 1 << 20 }) as unknown as SyncZlibEngine
  if (typeof engine._processChunk !== 'function' || !engine._handle) {
    engine.close()
    throw new Error(
      'zlib.Gunzip no longer exposes the sync _processChunk engine on this Node version — ' +
      'the streaming .gz segment reader cannot run (see forEachGunzipChunkSync in ndjsonLines.ts)',
    )
  }
  // ONE persistent error absorber, attached for the engine's whole life. A zlib error is
  // delivered TWICE: synchronously (processChunkSync catches its own listener's capture and
  // THROWS — the error path our callers see) and again as an async 'error' EMIT on a later
  // tick. With no listener at that moment the re-emit is an uncaught-exception crash — which
  // the pre-fix accumulated stale listeners were silently absorbing (found when dropping them
  // for CI's MaxListenersExceededWarning turned the truncation test into an uncaught crash).
  // One deliberate absorber keeps the count flat AND keeps the re-emit harmless.
  const absorbAsyncReEmit = (): void => { /* the sync throw already reported this error */ }
  ;(engine as unknown as NodeJS.EventEmitter).on('error', absorbAsyncReEmit)
  const fd = fs.openSync(file, 'r')
  const inBuf = Buffer.allocUnsafe(inChunkBytes)
  try {
    for (;;) {
      const read = fs.readSync(fd, inBuf, 0, inChunkBytes, null)
      // A regular file only short-reads at EOF, so a short read means this call carries the gzip
      // trailer: hand the engine Z_FINISH. A TRUNCATED file is caught by zlib itself — inflate
      // with Z_FINISH and no remaining stream raises "unexpected end of file", which propagates
      // (pinned by the truncation case in ndjsonLines.test.ts, so this is a tested claim, not a
      // hoped-for one).
      const last = read < inChunkBytes
      const input = read === 0 ? Buffer.alloc(0) : inBuf.subarray(0, read)
      // Explicit annotation: the `engine._handle = handle` restore below would otherwise make
      // this initializer circular for the inference (TS7022).
      const handle: { close: () => void } | null | undefined = engine._handle
      if (!handle) break // engine reached stream end on a previous chunk (trailer already seen)
      const nativeClose = handle.close
      const jsClose = engine.close
      handle.close = () => {}
      engine.close = () => {}
      let out: Buffer | undefined
      try {
        out = engine._processChunk!(input, last ? zlib.constants.Z_FINISH : zlib.constants.Z_NO_FLUSH)
      } finally {
        // processChunkSync's internal _close() does TWO things: it calls handle.close() (noop'd
        // above, so the native inflate state survives) AND it nulls engine._handle — which,
        // un-restored, made this loop stop after ONE chunk and silently truncate the output
        // (caught red by the byte-equality test). Restoring the reference is the second half of
        // the minizlib interception; both halves are load-bearing.
        engine._handle = handle
        handle.close = nativeClose
        engine.close = jsClose
        // THIRD interception (caught by CI's MaxListenersExceededWarning): processChunkSync
        // registers a fresh 'error' listener on the engine at EVERY call and, in one-shot use,
        // discards the engine before it matters — reused across chunks, the listeners accumulate
        // (11 by the 11th chunk). Its purpose for this call is done (a sync error THREW above),
        // so drop everything and re-attach the ONE persistent absorber — never zero listeners,
        // or the async error re-emit (see the absorber's comment) becomes an uncaught crash.
        const em = engine as unknown as NodeJS.EventEmitter
        em.removeAllListeners('error')
        em.on('error', absorbAsyncReEmit)
      }
      if (out && out.length > 0) yield out
      if (last) break
    }
  } finally {
    fs.closeSync(fd)
    try { engine.close() } catch { /* engine already closed itself at stream end */ }
  }
}

/** Same contract as `forEachNdjsonLine`, for a gzip-compressed NDJSON file (a SEALED, compressed
 *  span segment — see segmentedSpanStore's `compressSealedSegments`). Decompression is STREAMED
 *  (`forEachGunzipChunkSync` above): only one bounded chunk of decompressed bytes exists at a
 *  time, so neither the V8 max-string-length ceiling nor a decompressed-day-sized Buffer
 *  allocation (568 MB measured — the review-confirmed RSS spike) is ever reachable from a read. */
export function forEachNdjsonLineGz(
  file: string,
  onLine: (line: string) => void,
  chunkBytes: number = CHUNK_BYTES,
  maxLineChars: number = MAX_LINE_CHARS,
): void {
  const assembler = new NdjsonLineAssembler(onLine, maxLineChars, file)
  // chunkBytes here bounds the compressed read per engine call; the test seam still exercises
  // chunk-boundary line assembly because a smaller input chunk yields smaller output chunks.
  forEachGunzipChunkSync(file, (chunk) => assembler.push(chunk), Math.min(chunkBytes, GZ_IN_CHUNK_BYTES))
  assembler.end()
}

/** Dispatches to `forEachNdjsonLine` or `forEachNdjsonLineGz` by filename suffix — the one call
 *  site every segment reader should use so a `.gz` segment is transparent by construction rather
 *  than by every caller remembering to branch. */
export function forEachNdjsonLineAuto(
  file: string,
  onLine: (line: string) => void,
  chunkBytes: number = CHUNK_BYTES,
  maxLineChars: number = MAX_LINE_CHARS,
): void {
  if (file.endsWith('.gz')) forEachNdjsonLineGz(file, onLine, chunkBytes, maxLineChars)
  else forEachNdjsonLine(file, onLine, chunkBytes, maxLineChars)
}

/**
 * `forEachNdjsonLineAuto` with an `await setImmediate` between chunks (TRDD-9NAUEUUR): the same
 * generators, the same assembler, the same lines in the same order — but the event loop breathes
 * once per chunk, so a 60s walk no longer starves every pending listener (the failure this fixes:
 * `server status` reported NOT RUNNING against a healthy server because its 800ms probe could not
 * be served while a synchronous no-window scan held the thread).
 *
 * setImmediate, not `Promise.resolve()`: a resolved-promise await only drains the microtask
 * queue, which is still the SAME macrotask — pending socket I/O would keep waiting. setImmediate
 * schedules after the poll phase, which is exactly where pending I/O callbacks run.
 *
 * The per-await gap is bounded by the chunk size (4 MiB plain; a 256 KiB compressed input chunk
 * is ~5 MB decompressed at the measured segment ratio) — single-digit-ms of line assembly per
 * chunk, far under any probe timeout.
 */
export async function forEachNdjsonLineAutoYielding(
  file: string,
  onLine: (line: string) => void,
  chunkBytes: number = CHUNK_BYTES,
  maxLineChars: number = MAX_LINE_CHARS,
): Promise<void> {
  const assembler = new NdjsonLineAssembler(onLine, maxLineChars, file)
  const chunks = file.endsWith('.gz')
    ? gunzipChunks(file, Math.min(chunkBytes, GZ_IN_CHUNK_BYTES))
    : fileChunks(file, chunkBytes)
  for (const chunk of chunks) {
    // Push BEFORE the await: fileChunks yields a view over a reused buffer that is only valid
    // until the next next() call, and the push copies it (StringDecoder) — so the await never
    // holds a stale view.
    assembler.push(chunk)
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assembler.end()
}

/** Non-empty line count, streamed. Same answer as the old
 *  `readFileSync(f,'utf8').split('\n').filter(Boolean).length`, minus the 512 MB ceiling. */
export function countNdjsonLines(file: string, chunkBytes: number = CHUNK_BYTES): number {
  let n = 0
  forEachNdjsonLine(file, () => { n++ }, chunkBytes)
  return n
}

/** `countNdjsonLines`, transparent over a `.gz` file. */
export function countNdjsonLinesAuto(file: string, chunkBytes: number = CHUNK_BYTES): number {
  let n = 0
  forEachNdjsonLineAuto(file, () => { n++ }, chunkBytes)
  return n
}
