// TRDD-PJC8N1HO — standalone-collector runtime resilience primitives.
//
// Four concerns, all pure Node (no VS Code), unit-testable in isolation:
//   1. atomicWriteFileSync  — crash-safe file write (temp + rename) so a crash mid-write can never
//      leave a truncated spans.json / offset file (spec 4).
//   2. heapPressure/guard   — a high-water-mark check on V8's old-space so a heavy request is SHED
//      with a loud 503 instead of tipping an already-near-full heap into a fatal OOM (spec 7).
//   3. RequestLog           — one line per HTTP request (method/path/status/duration/bytes/heap) to a
//      ring buffer + rotating file, so any future crash is attributable to the request that caused it
//      (spec 6). Before this existed the crash logs showed only span-ingestion lines and the offending
//      endpoint could not be identified.
//   4. atomicExclusiveWriteFileSync + the pid-lock primitives (TRDD-PIDFILEAT) — the single-instance
//      pidfile guard's write/verify/takeover logic, extracted so the decision is a pure, testable
//      function instead of living inline in standalone/server.ts's module-init block.
import * as fs from 'fs'
import * as os from 'os'
import * as v8 from 'v8'
import { execFileSync } from 'child_process'

// TRDD-34B9JAZK — heapPressure() (below) is blind to ~67% of this process's real footprint: at
// steady state 860 MB heap sits inside a 2624 MB RSS, because DuckDB's native arena, Buffers and the
// segment index never touch V8's old space. The server has died twice from a silent external kill
// (no V8 OOM banner — heap looked comfortable both times) while serving the raw-body-scan tool
// family. An external kill acts on RSS, not on `--max-old-space-size`, so heapPressure alone cannot
// see it coming. rssPressure() (below) is the RSS-aware sibling.

// ── 1. Atomic file write ──────────────────────────────────────────────────────

/**
 * Write `data` to `file` atomically: serialize to a sibling temp file, fsync, then rename over the
 * target. rename(2) is atomic on POSIX, so a reader (or a crash) sees either the whole old file or the
 * whole new one — never a half-written file. The temp lives in the same directory as the target so the
 * rename stays on one filesystem (a cross-device rename is not atomic and would fall back to copy).
 *
 * `mode` (optional): the permission bits for the created file (subject to umask), e.g. `0o600` for a
 * secret. Applied at open time so the file is never briefly world-readable between create and chmod.
 * Omitted ⇒ Node's default (0o666 & ~umask), matching every pre-existing caller.
 */
export function atomicWriteFileSync(file: string, data: string | Buffer, mode?: number): void {
  // Unique-ish temp suffix so two writers to the same path can't clobber each other's temp file.
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  let fd: number | undefined
  try {
    fd = mode === undefined ? fs.openSync(tmp, 'w') : fs.openSync(tmp, 'w', mode)
    fs.writeSync(fd, data as string)
    // fsync so the bytes are on disk before the rename — otherwise a crash right after rename could
    // still expose an empty file if the data write was still buffered.
    try { fs.fsyncSync(fd) } catch { /* fsync unsupported on some FS — best effort */ }
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(tmp, file)
  } catch (e) {
    // On any failure, close+remove the temp so we never leak partial temp files.
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* ignore */ } }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch { /* ignore */ }
    throw e
  }
}

/**
 * Write `data` to `file` ATOMICALLY *and* EXCLUSIVELY: the target is created only if it did not
 * already exist, and readers only ever see the whole new content or the whole prior content —
 * never a partial/interleaved write. Returns `true` on success, `false` if `file` already existed
 * (the caller lost the race; nothing was touched).
 *
 * A bare `fs.writeFileSync(file, data, {flag:'wx'})` is *almost* this — O_CREAT|O_EXCL makes the
 * CREATE exclusive, but the write of `data` itself is a separate write() syscall with no atomicity
 * guarantee against a concurrent reader/writer of a REGULAR file (POSIX only guarantees that for
 * pipes, up to PIPE_BUF). This helper removes that gap by writing the full content to a private
 * temp file FIRST (so it's never partially visible to anyone) and then publishing it with a single
 * `link(2)` — link() is atomic AND fails with EEXIST if the target already exists, which is exactly
 * the exclusive-create semantics a single-instance lock needs. The temp file is always unlinked
 * afterward (its job was only to stage the bytes for the link).
 */
export function atomicExclusiveWriteFileSync(file: string, data: string | Buffer, mode?: number): boolean {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  let fd: number | undefined
  try {
    fd = mode === undefined ? fs.openSync(tmp, 'w') : fs.openSync(tmp, 'w', mode)
    fs.writeSync(fd, data as string)
    try { fs.fsyncSync(fd) } catch { /* fsync unsupported on some FS — best effort */ }
    fs.closeSync(fd)
    fd = undefined
    fs.linkSync(tmp, file) // atomic + exclusive: throws EEXIST if `file` is already there
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    return false
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* ignore */ } }
    try { fs.unlinkSync(tmp) } catch { /* already consumed by link(), or never created — fine either way */ }
  }
}

// ── 1b. Pid-lock format + takeover decision (TRDD-PIDFILEAT) ─────────────────

/** A parsed pidfile lock. `start` is the recorded process-start reference (see `processStartRef`)
 *  used to detect a RECYCLED pid; `null` means the lock is in the legacy pid-only format. */
export interface PidLock { pid: number; start: string | null }

/** Serialize a pid lock. `start === null` deliberately produces the legacy bare-numeric format
 *  (not `"pid:null"`) so a build that could not determine its own start reference still writes a
 *  file every pre-PIDFILEAT reader/writer understands. */
export function formatPidLock(pid: number, start: string | null): string {
  return start === null ? String(pid) : JSON.stringify({ pid, start })
}

/** Parse a pidfile's content. Accepts both the new JSON `{"pid":N,"start":"..."}` shape and the
 *  legacy bare-numeric shape (`start: null`). Returns `null` for anything unparseable/empty — the
 *  caller treats that exactly like a stale/missing lock. */
export function parsePidLock(content: string): PidLock | null {
  const trimmed = content.trim()
  if (trimmed === '') return null
  if (/^\d+$/.test(trimmed)) {
    const pid = Number(trimmed)
    return pid > 0 ? { pid, start: null } : null
  }
  try {
    const j = JSON.parse(trimmed) as { pid?: unknown; start?: unknown }
    const pid = Number(j.pid)
    const start = typeof j.start === 'string' ? j.start : null
    return Number.isFinite(pid) && pid > 0 ? { pid, start } : null
  } catch {
    return null
  }
}

/** The OS's own record of when `pid` started, as an opaque comparable string — used only to tell a
 *  LIVE-BUT-RECYCLED pid apart from the process that actually claimed the lock. `ps -o lstart=` is
 *  available on both macOS and Linux (unlike `/proc/<pid>` which is Linux-only), so this works on
 *  every platform the server ships to. `null` means "could not determine" (process gone between the
 *  liveness check and this call, `ps` unavailable, sandboxed environment, …) — callers MUST treat
 *  that as "cannot verify" and fall back to the conservative legacy kill-0-only rule, never as
 *  "definitely recycled". */
export function processStartRef(pid: number): string | null {
  try {
    // LC_ALL=C is LOAD-BEARING, not cosmetic: `lstart` renders via strftime, so its day/month
    // names follow LC_TIME. Without pinning, a starter spawned under a different locale than the
    // lock's owner (launchd vs terminal, a localized shell) reads a DIFFERENT string for the SAME
    // live process, the comparison misjudges it 'recycled-takeover', and a live owner gets taken
    // over — re-opening the exact double-owner window this reference exists to close.
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' },
    }).trim()
    return out === '' ? null : out
  } catch {
    return null
  }
}

/** The single-instance lock's takeover decision, as a pure function over what can be observed —
 *  named and extracted (TRDD-PIDFILEAT) so the four cases are pinned by a unit test instead of
 *  living inline in the takeover branch of standalone/server.ts's module-init block.
 *
 *  - `dead-takeover`       — the recorded pid answers no kill(pid,0): always safe to reclaim.
 *  - `live-owner`          — the recorded pid is alive AND its current start reference matches the
 *    one recorded in the lock: a genuine, still-running owner. NEVER take over.
 *  - `recycled-takeover`   — the recorded pid is alive but its CURRENT start reference does not
 *    match the recorded one: the OS reused the pid after the real owner exited. Safe to reclaim.
 *  - `legacy-kill0-only`   — the lock carries no start reference (old-format lock, or the start
 *    reference could not be determined for either side) — falls back to today's behavior:
 *    kill(pid,0) alone decides, i.e. "alive" is trusted as a live owner. This keeps a pre-PIDFILEAT
 *    lock file (or a `ps`-less environment) from being wrongly treated as recycled just because we
 *    have no start reference to compare. */
export type LockTakeoverVerdict = 'live-owner' | 'dead-takeover' | 'recycled-takeover' | 'legacy-kill0-only'
export function lockTakeoverVerdict(o: {
  lockPid: number
  lockStartRef: string | null
  pidAlive: boolean
  currentStartRef: string | null
}): LockTakeoverVerdict {
  if (!o.pidAlive) return 'dead-takeover'
  if (o.lockStartRef === null || o.currentStartRef === null) return 'legacy-kill0-only'
  return o.currentStartRef === o.lockStartRef ? 'live-owner' : 'recycled-takeover'
}

// ── 2. Heap-pressure guard ────────────────────────────────────────────────────

const MB = 1024 * 1024

/**
 * Current old-space pressure vs the V8 heap limit. `limitMb` comes from V8 itself
 * (`--max-old-space-size` when set, else the platform default), so the guard tracks the REAL ceiling
 * the process will OOM at rather than a hardcoded guess. The high-water mark is a fraction of that
 * limit (env `AGENTLENS_HEAP_HWM_PCT`, default 0.85), or an absolute MB override
 * (`AGENTLENS_HEAP_HWM_MB`). Above the mark, heavy handlers must shed rather than allocate.
 */
export function heapPressure(): { heapUsedMb: number; limitMb: number; hwmMb: number; over: boolean } {
  const heapUsedMb = process.memoryUsage().heapUsed / MB
  const limitMb = v8.getHeapStatistics().heap_size_limit / MB
  const absOverride = Number(process.env.AGENTLENS_HEAP_HWM_MB)
  const pct = Number(process.env.AGENTLENS_HEAP_HWM_PCT)
  const hwmMb = absOverride > 0
    ? absOverride
    : limitMb * (pct > 0 && pct < 1 ? pct : 0.85)
  return { heapUsedMb, limitMb, hwmMb, over: heapUsedMb >= hwmMb }
}

/**
 * Current RSS pressure vs a configurable high-water mark. Unlike `heapPressure()`, there is no
 * runtime-reported "true ceiling" for RSS the way V8 reports `heap_size_limit` for old-space — RSS
 * is bounded by whatever external mechanism kills the process (a supervisor's memory cap, a cgroup,
 * OS memory pressure), and that ceiling is not discoverable from inside the process. So `limitMb`
 * is NOT a detected cap; it is `os.totalmem()`, reported only as context.
 *
 * The default high-water mark (`AGENTLENS_RSS_HWM_MB`, default 4096) is a fixed absolute constant,
 * not a fraction of total system memory: this machine has 64 GB of RAM, and the kill mechanism is
 * macOS system memory pressure, whose decision ignores our share of total RAM — a percent-of-total
 * default (e.g. 75%) would compute to ~48 GB and never fire.
 *
 * 4096 is a COMPROMISE between two measured regimes, not a line the killer respects (the review
 * called out an earlier draft of this comment for claiming 4096 "leaves headroom below 2547" —
 * arithmetically backwards; this is the corrected account). Measured on 2026-08-13: one kill
 * struck with the request log's last reading at rss=2547 MB (same gate source), while later the
 * same day the server SURVIVED a sweep that `ps` scored at 5.4 GB — the killer's threshold moves
 * with system-wide load, so no fixed constant can sit "safely below" it. 4096 is chosen ABOVE the
 * gate-rss peaks of real, healthy heavy scans (a 10-run no-window acceptance stayed under 4096 by
 * this gate while `ps` read 4.5-4.8 GB — the two accountings differ by compressed/reclaimable
 * pages, so tune ONLY against this gate's own number, i.e. the `rss=` field in requests.log,
 * never against `ps`) and BELOW the 5.4 GB residency that preceded the one instrumented kill.
 * Lower it and the gate sheds scans that demonstrably complete; raise it and it stops shedding
 * before the only residency ever seen to precede a death. Override with `AGENTLENS_RSS_HWM_MB`
 * (absolute) or `AGENTLENS_RSS_HWM_PCT` (fraction of `os.totalmem()`, for a deployment where the
 * kill mechanism genuinely does scale with total RAM).
 */
export function rssPressure(totalMemMb = os.totalmem() / MB): { rssMb: number; limitMb: number; hwmMb: number; over: boolean } {
  const rssMb = process.memoryUsage().rss / MB
  const absOverride = Number(process.env.AGENTLENS_RSS_HWM_MB)
  const pct = Number(process.env.AGENTLENS_RSS_HWM_PCT)
  const DEFAULT_HWM_MB = 4096
  const hwmMb = absOverride > 0
    ? absOverride
    : (pct > 0 && pct < 1 ? totalMemMb * pct : DEFAULT_HWM_MB)
  return { rssMb, limitMb: totalMemMb, hwmMb, over: rssMb >= hwmMb }
}

/** RSS/heap sampling from INSIDE a synchronous scan loop, every `everyN` units.
 *
 *  WHY (TRDD-34B9JAZK, third silent kill 2026-08-13 22:09): requests.log samples rss only when the
 *  event loop serves a request, and the heavy diagnostic scans are SYNCHRONOUS — so every fatal
 *  memory climb happened inside a window the instrumentation structurally could not see. Three
 *  times, the log's last line was the tool start and the final rss reading (2790MB, under the
 *  4096 HWM) was a FLOOR from before the climb. This sampler is called per scan unit and logs from
 *  within the blocking loop itself, so the next climb leaves a progressive trail that brackets the
 *  allocation site instead of vanishing. `memoryUsage()` is only read on the every-N branch —
 *  the per-unit cost is one increment and one modulo. */
export function makeRssSampler(label: string, everyN: number, log: (m: string) => void = console.log): () => void {
  let n = 0
  return () => {
    n += 1
    if (n % everyN !== 0) return
    const m = process.memoryUsage()
    log(`[AgentLens] rss-sample ${label} units=${n} rss=${Math.round(m.rss / MB)}MB heap=${Math.round(m.heapUsed / MB)}MB`)
  }
}

// ── 3. Request log (ring buffer + rotating file) ──────────────────────────────

export interface RequestLogEntry {
  ts: string          // ISO timestamp
  method: string
  path: string        // query-stripped
  status: number
  durationMs: number
  bytes: number       // response body bytes
  heapUsedMb: number  // heap at completion — so a growth trend is visible per request
  /** RSS at completion. Recorded because heap ALONE cannot diagnose the death this log exists to
   *  explain (TRDD-34B9JAZK). Measured on a healthy server: heap 860 MB against RSS 2624 MB — 67% of
   *  the footprint is off-heap (DuckDB's native arena, buffers, the segment index), and
   *  `--max-old-space-size` bounds only V8's old space, never RSS. So a log that records heap alone
   *  shows a comfortable 1768/6144 MB right up to a kill that RSS would have predicted, and the
   *  post-mortem stalls exactly where the last one did. A V8 heap OOM is also self-announcing
   *  (`FATAL ERROR: Ineffective mark-compacts`); a silent gap followed by a fresh pid is the
   *  signature of an external SIGKILL, which acts on RSS. */
  rssMb: number
}

/**
 * Fixed-size ring of recent requests + an append to a rotating file. Kept deliberately tiny (the ring
 * holds only metadata lines, never bodies) so it can never itself become a memory leak — the exact
 * failure mode this whole TRDD is about. The file rotates at `maxFileBytes` (one `.1` backup) so it
 * can't grow without bound on a long-lived collector.
 */
export class RequestLog {
  private ring: RequestLogEntry[] = []
  private head = 0
  private filled = false

  constructor(
    private readonly filePath: string | null,
    private readonly ringSize = 500,
    private readonly maxFileBytes = 8 * MB,
  ) {}

  record(e: RequestLogEntry): void {
    // Ring insert (overwrite oldest) — O(1), bounded memory.
    this.ring[this.head] = e
    this.head = (this.head + 1) % this.ringSize
    if (this.head === 0) this.filled = true
    if (this.filePath) this.appendToFile(e)
  }

  /** Recent entries, oldest-first. */
  recent(limit = this.ringSize): RequestLogEntry[] {
    const all = this.filled
      ? [...this.ring.slice(this.head), ...this.ring.slice(0, this.head)]
      : this.ring.slice(0, this.head)
    return limit >= all.length ? all : all.slice(all.length - limit)
  }

  private appendToFile(e: RequestLogEntry): void {
    const line = `${e.ts} ${e.method} ${e.status} ${e.durationMs}ms ${e.bytes}b heap=${e.heapUsedMb.toFixed(0)}MB rss=${e.rssMb.toFixed(0)}MB ${e.path}\n`
    try {
      // Rotate BEFORE the write when the file is already at/over the cap, so the active file stays
      // bounded. One backup generation is enough for post-mortem attribution.
      let size = 0
      try { size = fs.statSync(this.filePath!).size } catch { /* no file yet */ }
      if (size + line.length > this.maxFileBytes) {
        try { fs.renameSync(this.filePath!, `${this.filePath!}.1`) } catch { /* first rotation or race — ignore */ }
      }
      fs.appendFileSync(this.filePath!, line)
    } catch { /* logging must never throw into the request path */ }
  }
}
