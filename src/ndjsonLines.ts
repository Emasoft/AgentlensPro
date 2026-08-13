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
// Sync on purpose: both call sites are sync (a CLI probe and a store read), and making them
// async would ripple through the server's read path for no gain — the cost here is disk I/O,
// which readSync and a stream pay alike.

import * as fs from 'fs'
import * as zlib from 'zlib'
import { StringDecoder } from 'string_decoder'

const CHUNK_BYTES = 1 << 22 // 4 MiB — big enough that syscall overhead vanishes, small enough to stay off the heap

/** A single line this long is not a span, it is corruption. Named explicitly so the failure
 *  says WHAT is wrong instead of resurfacing V8's max-string-length error one layer down —
 *  the exact error whose cryptic wording hid this bug in the first place. Counted in CHARS,
 *  because that is the unit V8's limit is expressed in and the unit `carry` is measured in. */
const MAX_LINE_CHARS = 64 << 20 // ~64M chars

/** The chunk-splitting core shared by the plain-file and gzip readers below: `readChunk()`
 *  returns the next Buffer of bytes (or null at EOF) from whatever source (a live fd, or an
 *  already-decompressed in-memory Buffer sliced piecewise). Splitting this out is what lets the
 *  gzip reader reuse the exact same line-assembly + corruption-guard logic instead of ever
 *  building one giant decompressed STRING (which would reintroduce the very V8 max-string-length
 *  ceiling this module exists to route around — see the module header). */
function walkNdjsonChunks(
  readChunk: () => Buffer | Uint8Array | null,
  onLine: (line: string) => void,
  maxLineChars: number,
  file: string,
): void {
  // StringDecoder, not buf.toString(): a UTF-8 sequence straddling a chunk boundary would
  // otherwise decode to replacement characters on both sides and corrupt that span's JSON.
  const decoder = new StringDecoder('utf8')
  let carry = ''
  for (;;) {
    const chunk = readChunk()
    if (chunk === null) break
    const text = carry + decoder.write(chunk as Buffer)
    let start = 0
    for (;;) {
      const nl = text.indexOf('\n', start)
      if (nl === -1) break
      const line = text.slice(start, nl)
      if (line) onLine(line)
      start = nl + 1
    }
    carry = text.slice(start)
    if (carry.length > maxLineChars) {
      throw new Error(`${file}: a single line exceeds ${maxLineChars} characters — the file is not NDJSON`)
    }
  }
  carry += decoder.end()
  if (carry) onLine(carry)
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
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.allocUnsafe(chunkBytes)
  try {
    walkNdjsonChunks(() => {
      const read = fs.readSync(fd, buf, 0, chunkBytes, null)
      return read === 0 ? null : buf.subarray(0, read)
    }, onLine, maxLineChars, file)
  } finally {
    fs.closeSync(fd)
  }
}

/** Same contract as `forEachNdjsonLine`, for a gzip-compressed NDJSON file (a SEALED, compressed
 *  span segment — see segmentedSpanStore's `compressSealedSegments`). The compressed bytes are
 *  read whole (small: gzip -9 measured 19.5x on a real segment, so even a 500+MB sealed day is a
 *  ~25MB read) and `gunzipSync`'d to a single decompressed Buffer — Buffer has no 512MB *string*
 *  ceiling, only `walkNdjsonChunks` ever turns bytes into a string, and only CHUNK_BYTES at a
 *  time, so the V8 max-string-length limit this module was built to route around is never hit on
 *  the decompressed side either. */
export function forEachNdjsonLineGz(
  file: string,
  onLine: (line: string) => void,
  chunkBytes: number = CHUNK_BYTES,
  maxLineChars: number = MAX_LINE_CHARS,
): void {
  const decompressed = zlib.gunzipSync(fs.readFileSync(file))
  let offset = 0
  walkNdjsonChunks(() => {
    if (offset >= decompressed.length) return null
    const end = Math.min(offset + chunkBytes, decompressed.length)
    const chunk = decompressed.subarray(offset, end)
    offset = end
    return chunk
  }, onLine, maxLineChars, file)
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
