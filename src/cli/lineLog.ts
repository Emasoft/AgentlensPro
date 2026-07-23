// src/cli/lineLog.ts — write-coalescing append-only line log for the long-lived watchers
// (`watch`, `budget`). One flush = one `appendFileSync` of whole lines.
//
// WHY coalesce: a monitor polling every few seconds and writing each event immediately turns a
// 200-byte line into a full flash page-program cycle. Over a multi-day watch that is pure write
// amplification for no benefit, because nothing reads the file between events. Buffering for a
// second collapses a burst into one syscall and one page.
//
// The bargain, stated plainly: up to `flushMs` of events can be lost if the process dies
// uncleanly. That is the explicit trade the owner asked for. What is NOT traded away is
// integrity — a reader of this file must never see a torn line, and that holds even when the
// process is killed mid-run:
//
//   * only COMPLETE lines enter the buffer (write() appends the newline itself), so a flush can
//     never emit a fragment of an event;
//   * a flush is a SINGLE appendFileSync with flag 'a' — O_APPEND means the offset is chosen
//     atomically by the kernel, so two watchers appending to one file interleave at line
//     boundaries and never overwrite each other. (Interleaving is atomic per write() for the
//     buffer sizes here; a multi-megabyte flush on some network filesystems can still split,
//     which is why maxBufferBytes stays small.)
//   * the buffer is bounded, so a failing disk cannot grow it without limit — the oldest lines
//     are dropped and COUNTED, and the count is reported, because silently losing events would
//     make the log lie by omission;
//   * exit, SIGINT and SIGTERM all flush before the process goes away, so an orderly stop loses
//     nothing at all.

import * as fs from 'fs'
import * as path from 'path'

export interface LineLogOptions {
  /** Coalescing window in ms. 0 writes through immediately (no loss window, maximum wear). */
  flushMs?: number
  /** Hard cap on pending bytes; reaching it forces an immediate flush. */
  maxBufferBytes?: number
  /** Where to report a write failure. Defaults to console.log so the message reaches a Monitor
   *  stream (stderr would be invisible there — silence must never look like success). */
  onError?: (msg: string) => void
}

export const DEFAULT_FLUSH_MS = 1000
export const MAX_FLUSH_MS = 60_000
export const DEFAULT_MAX_BUFFER_BYTES = 256 * 1024

export class LineLog {
  private buf: string[] = []
  private bytes = 0
  private timer: NodeJS.Timeout | null = null
  private dropped = 0
  private failing = false
  private closed = false
  private readonly flushMs: number
  private readonly maxBytes: number
  private readonly onError: (msg: string) => void
  private readonly onProcessExit: () => void

  constructor(private readonly file: string, opts: LineLogOptions = {}) {
    this.flushMs = clampFlushMs(opts.flushMs ?? DEFAULT_FLUSH_MS)
    this.maxBytes = Math.max(4096, opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES)
    this.onError = opts.onError ?? ((m: string) => console.log(m))
    // Fail fast at construction: a log path we cannot create is a setup error the caller must
    // see NOW, not a surprise at the first event an hour into a run.
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
    fs.appendFileSync(file, '')
    this.onProcessExit = () => this.flush()
    process.once('exit', this.onProcessExit)
    process.once('SIGINT', this.onProcessExit)
    process.once('SIGTERM', this.onProcessExit)
  }

  /** Buffer one COMPLETE line. Embedded newlines are stripped so one event stays one line — a
   *  multi-line event would otherwise be indistinguishable from several events to any reader
   *  that splits on '\n'. */
  write(line: string): void {
    if (this.closed) return
    const clean = `${String(line).replace(/\r?\n/g, ' ')}\n`
    this.buf.push(clean)
    this.bytes += Buffer.byteLength(clean)
    if (this.bytes >= this.maxBytes || this.flushMs === 0) { this.flush(); return }
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.flush() }, this.flushMs)
      // Never hold the process open just to flush a log line.
      if (typeof this.timer.unref === 'function') this.timer.unref()
    }
  }

  /** Synchronously append everything pending as ONE write. Safe to call at any time, including
   *  from an exit handler (which is why it must stay sync — an async flush in an 'exit' handler
   *  never runs). */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.buf.length === 0) return
    const payload = this.buf.join('')
    try {
      fs.appendFileSync(this.file, payload)
      this.buf = []
      this.bytes = 0
      if (this.failing) {
        this.failing = false
        this.onError(`[log] writes recovered${this.dropped ? ` — ${this.dropped} line(s) were dropped while the disk was failing` : ''}`)
        this.dropped = 0
      }
    } catch (e) {
      // Keep the events, bounded. A disk that is failing must degrade the LOG, never the watch.
      if (!this.failing) {
        this.failing = true
        this.onError(`[log] write failed: ${(e as Error).message} — buffering, the watch continues`)
      }
      while (this.bytes > this.maxBytes && this.buf.length > 1) {
        const gone = this.buf.shift() as string
        this.bytes -= Buffer.byteLength(gone)
        this.dropped++
      }
    }
  }

  /** Final flush + detach the exit handlers. Idempotent. */
  close(): void {
    if (this.closed) return
    this.flush()
    this.closed = true
    process.removeListener('exit', this.onProcessExit)
    process.removeListener('SIGINT', this.onProcessExit)
    process.removeListener('SIGTERM', this.onProcessExit)
  }

  /** Test/diagnostic view of the coalescing state. */
  stats(): { pendingLines: number; pendingBytes: number; dropped: number; flushMs: number } {
    return { pendingLines: this.buf.length, pendingBytes: this.bytes, dropped: this.dropped, flushMs: this.flushMs }
  }
}

export function clampFlushMs(v: number): number {
  if (!Number.isFinite(v) || v < 0) return DEFAULT_FLUSH_MS
  return Math.min(MAX_FLUSH_MS, Math.round(v))
}
