// Back-pressure for the RAM-disk spool (TRDD-KB17X5G2, Option 3): a single background subagent
// refilled the 2GB spool from 162MB free to 1.4MB free (100%) in ~2 minutes. At 100% the spool
// cannot accept a write, so raw bodies are DROPPED — silent data loss, the exact failure the
// whole capture feature exists to prevent.
//
// WHY THIS OPERATES AT THE CONFIG BOUNDARY, NOT AT A `fs.writeFile` CALL: the raw body write
// itself is NOT performed by this process. Claude Code's own OTEL exporter writes the file
// directly, keyed off the launch-time env var OTEL_LOG_RAW_API_BODIES=file:<dir> (see
// src/rawBodyContext.ts's header comment and src/bodyWriters.ts's "A Claude session keeps its
// launch-time OTEL_LOG_RAW_API_BODIES env until restarted" note). There is no write call in this
// codebase to wrap in a try/catch. What we DO control is which directory a session is TOLD to
// write into — so back-pressure here means: once the spool is at/over capacity, repoint the
// OWNED telemetry env var at the legacy SSD bodies dir (already drain target #2) so any NEWLY
// STARTED session spills there instead of failing writes into a full spool. This is a real trade:
// it protects every session that starts AFTER the redirect, not the bytes an already-running
// session writes in the same instant the spool crosses 100% (that window is unavoidable without
// a write hook this process does not have). Say that plainly rather than claiming elimination —
// this is the same discipline the parent TRDD applies to the "grow the spool" option.
import * as fs from 'fs'
import * as path from 'path'
import { ramDiskInfo, SPOOL_MOUNT_POINT } from './ramdisk'

/** Free-bytes floor under which the spool is treated as "at capacity". 64MB is comfortably above
 *  one burst's worth of bodies (each request/response pair runs ~0.7-1.9MB per bodyWriters.ts),
 *  so back-pressure engages with room left, not after the last bytes are already gone. */
export const DEFAULT_SPOOL_FLOOR_BYTES = 64 * 1024 * 1024
export const SPOOL_FLOOR_MB_ENV = 'AGENTLENS_SPOOL_FLOOR_MB'

/** Floor in bytes: env override `AGENTLENS_SPOOL_FLOOR_MB` (any positive number), else the 64MB
 *  default. Mirrors `spoolSizeMb`'s tolerant-parse shape in ramdisk.ts. */
export function spoolFloorBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[SPOOL_FLOOR_MB_ENV])
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw) * 1024 * 1024
  return DEFAULT_SPOOL_FLOOR_BYTES
}

// ── Bodies flush law (TRDD-K3WDPR7M P1) ────────────────────────────────────────────────────────
// WHY a byte threshold instead of the bare clock it replaces: `standalone/server.ts` used to drive
// the bodies ingest/flush pass off nothing but a fixed interval, and a turn-count ratio (the
// earlier idea) is a poor proxy because turn sizes vary by orders of magnitude — a fixed ratio
// flushes 26MB one hour and 200KB the next. Bytes staged is the direct signal for "how much would
// be lost on an unclean stop", which is the thing the pass exists to bound.
//
// WHY 12MB, the middle of the plan's named 8-16MB band: each flush writes THREE files (blob, body,
// part — src/store/db.ts's COPY TO PARQUET), so any figure here undercounts small-write pressure by
// 3x if read as "one file". 12MB keeps a flush's Parquet footer overhead amortized (P0's bake-off
// measured the loop at ~15KB/turn against a ~14KB append-only floor) while firing well before the
// legacy 60s backstop on a burst, without flushing so often that footer overhead dominates.
export const BODIES_FLUSH_BYTES_THRESHOLD_BYTES = 12 * 1024 * 1024

export interface FlushLawInput {
  /** Bytes currently staged (unflushed) in the bodies dir(s) being drained. */
  stagedBytes: number
  /** Milliseconds since the last bodies pass was attempted. */
  msSinceLastPass: number
  /** Max latency backstop in ms — an idle machine must still settle within this window. */
  backstopMs: number
  /** True when the spool is over its back-pressure floor (checkSpoolCapacity/applySpoolBackpressure) —
   *  the pass must not wait for bytes or time when the spool itself is the thing under pressure. */
  underPressure: boolean
}

/** The flush law, in full: fire a bodies pass when staged bytes reach the threshold, OR the max-
 *  latency backstop has elapsed, OR the spool is under back-pressure — whichever comes first. Pure
 *  and side-effect-free so it is testable without a real filesystem, spool, or timer (TRDD-K3WDPR7M
 *  P1). Deliberately NOT a controller: no ramping, no telemetry-derived ratio, no PID — one
 *  threshold, one timer, one floor, per the plan's "explicitly NOT building" list. */
export function shouldFlushBodies(input: FlushLawInput): boolean {
  return (
    input.underPressure ||
    input.stagedBytes >= BODIES_FLUSH_BYTES_THRESHOLD_BYTES ||
    input.msSinceLastPass >= input.backstopMs
  )
}

export interface SpoolCapacityCheck {
  overCapacity: boolean
  freeBytes: number | null
  floorBytes: number
}

/** Real free-bytes read (`df`, via ramdisk.ts's `ramDiskInfo`) — a pre-check is inherently a
 *  TOCTOU race against whatever writes next (nothing in THIS process performs the write it is
 *  guarding, so there is no error to catch instead), which is why it is re-evaluated on every
 *  caller tick rather than cached. `freeBytes === null` (df failed, or the mount point is not
 *  actually mounted) reads as NOT over capacity — fail OPEN, so a transient `df` hiccup never
 *  wrongly redirects sessions away from a perfectly healthy spool. */
export function checkSpoolCapacity(
  mountPoint: string = SPOOL_MOUNT_POINT,
  floorBytes: number = spoolFloorBytes(),
): SpoolCapacityCheck {
  const info = ramDiskInfo(mountPoint)
  const freeBytes = info.freeBytes
  return { overCapacity: freeBytes !== null && freeBytes < floorBytes, freeBytes, floorBytes }
}

export interface BackpressureState {
  /** True while new sessions are being pointed at the legacy SSD dir instead of the spool. */
  redirected: boolean
  /** Count of transitions INTO redirected state — the visible "we spilled to SSD N times" figure. */
  spills: number
}

export const INITIAL_BACKPRESSURE_STATE: BackpressureState = { redirected: false, spills: 0 }

export interface BackpressureDeps {
  redirectToLegacy: () => void | Promise<void>
  restoreToSpool: () => void | Promise<void>
  onWarn?: (msg: string) => void
  onInfo?: (msg: string) => void
}

/** One controller tick: given the current capacity reading and prior state, decide whether to
 *  (re)direct and apply it via the injected callbacks (kept injectable so tests never touch the
 *  real spool or a user's real Claude Code settings.json). Hysteresis on recovery — free bytes
 *  must exceed 2x the floor before switching back — so a spool oscillating right at the floor
 *  does not flap the config (a redirect writer, per telemetryConfig.ts, is a settings.json
 *  rewrite; flapping it every tick would be its own kind of disk churn). */
export async function applySpoolBackpressure(
  check: SpoolCapacityCheck,
  state: BackpressureState,
  deps: BackpressureDeps,
): Promise<BackpressureState> {
  if (check.overCapacity && !state.redirected) {
    await deps.redirectToLegacy()
    deps.onWarn?.(
      `spool at capacity (${check.freeBytes ?? 'unknown'} bytes free, floor ${check.floorBytes}) — ` +
      `new sessions redirected to the legacy SSD bodies dir until it recovers`,
    )
    return { redirected: true, spills: state.spills + 1 }
  }
  if (!check.overCapacity && state.redirected && check.freeBytes !== null && check.freeBytes > check.floorBytes * 2) {
    await deps.restoreToSpool()
    deps.onInfo?.(`spool recovered (${check.freeBytes} bytes free) — new sessions redirected back to the RAM-disk spool`)
    return { redirected: false, spills: state.spills }
  }
  if (state.redirected) {
    // RE-ASSERT for the WHOLE redirected lifetime — over capacity, inside the recovery band
    // [floor, 2x floor], and while `df` is unreadable alike (review findings, two rounds): this
    // controller is NOT the settings' sole writer — `agentlenspro setup` / `--install-otel`
    // "repair" the bodiesDir back to the expected spool value. The first fix re-asserted only
    // while overCapacity, which left the recovery band silently unprotected: a repair landing
    // with free bytes between floor and 2x floor met NO branch, so new sessions wrote into a
    // spool one burst from full while status reported protection active — the exact silent loss
    // TRDD-KB17X5G2 exists to prevent. The rule that survives both rounds: while `redirected`
    // is asserted, every tick that does not RESTORE (above) re-applies the redirect. The
    // callback is IDEMPOTENT (ensureTelemetryConfig no-ops when the value already matches), so
    // the steady state costs one no-op per tick and an external overwrite heals within one
    // tick. No spill increment and no repeated warning — nothing NEW happened. Deliberately
    // asymmetric: the healthy (not-redirected) direction is NOT re-asserted, because fighting a
    // user's deliberate config every 5s when nothing is at risk would make this controller the
    // hijacker.
    await deps.redirectToLegacy()
    return state
  }
  return state
}

// ── Spool evacuation (TRDD-MW573BGT) ───────────────────────────────────────────────────────────
// The redirect above (`applySpoolBackpressure`) only protects sessions that START after it fires —
// an already-running session's OTEL exporter keeps its launch-time env and keeps writing into the
// spool. If the spool fills anyway, THOSE writes fail (ENOSPC) and the bytes are gone. We cannot
// wrap that write (we do not own it), but we DO own the spool's contents: this evacuates the oldest
// QUIESCENT body files verbatim to `LEGACY_BODIES_DIR` (already a durable drain target — the normal
// ingest pass picks them up from SSD) to free space faster than a burst can fill it. No parsing, no
// verify, no compression here — a raw copy is an order of magnitude faster than ingestion.
//
// Deliberately ABOVE the 64MB redirect floor (DEFAULT_SPOOL_FLOOR_BYTES): evacuation is the
// innermost of the three protection layers and must engage with room still left in the spool, not
// after the redirect has already had to fire.
export const DEFAULT_SPOOL_EVAC_BYTES = 256 * 1024 * 1024
export const SPOOL_EVAC_MB_ENV = 'AGENTLENS_SPOOL_EVAC_MB'
/** A file younger than this is presumed still being written by the exporter — evacuating it would
 *  copy a truncated body and then delete the source, the exact loss this feature forbids. */
export const EVAC_QUIESCENCE_MS = 3000
/** Per-tick byte bound so one tick never runs unbounded; the rest is picked up next tick. */
export const EVAC_MAX_BYTES_PER_TICK = 256 * 1024 * 1024

/** Threshold in bytes: env override `AGENTLENS_SPOOL_EVAC_MB` (any positive number), else the
 *  256MB default. Mirrors `spoolFloorBytes`'s tolerant-parse shape. */
export function spoolEvacThresholdBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[SPOOL_EVAC_MB_ENV])
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw) * 1024 * 1024
  return DEFAULT_SPOOL_EVAC_BYTES
}

export interface EvacCandidate {
  name: string
  mtime: number
  size: number
}

export interface EvacuationPlanInput {
  /** Current spool free bytes (a live reading — the planner does not re-check it per file). */
  freeBytes: number
  /** Stop selecting once `freeBytes + bytesPlanned` reaches this — the hysteresis target
   *  (evacuation trigger's floor callers pass 2x threshold, same shape as the redirect's recovery
   *  band) so a tick doesn't evacuate one byte more than needed to get comfortably clear. */
  targetFreeBytes: number
  files: EvacCandidate[]
  nowMs: number
  quiescenceMs?: number
  maxBytesPerTick?: number
}

export interface EvacuationPlan {
  /** Oldest-first, quiescent-only, within the byte budget. */
  toEvacuate: EvacCandidate[]
  bytesPlanned: number
}

/** Pure planner: given a free-bytes reading and the candidate files, pick which ones to move this
 *  tick. Oldest first (mirrors `ingestPass.ts`'s `bodyFiles` ordering — also the true turn order),
 *  skip anything not yet quiescent, stop at the byte budget OR once the projected free bytes would
 *  reach the target — whichever comes first. Side-effect-free so it is testable without a real
 *  filesystem (TRDD-MW573BGT acceptance box 1). */
export function planEvacuation(input: EvacuationPlanInput): EvacuationPlan {
  const quiescenceMs = input.quiescenceMs ?? EVAC_QUIESCENCE_MS
  const maxBytesPerTick = input.maxBytesPerTick ?? EVAC_MAX_BYTES_PER_TICK
  const quiescent = input.files
    .filter((f) => input.nowMs - f.mtime >= quiescenceMs)
    .slice()
    .sort((a, b) => a.mtime - b.mtime)

  const toEvacuate: EvacCandidate[] = []
  let bytesPlanned = 0
  for (const f of quiescent) {
    if (bytesPlanned >= maxBytesPerTick) break
    if (input.freeBytes + bytesPlanned >= input.targetFreeBytes) break
    toEvacuate.push(f)
    bytesPlanned += f.size
  }
  return { toEvacuate, bytesPlanned }
}

/** List evacuation candidates from a directory — mirrors `ingestPass.ts`'s `bodyFiles` filename
 *  filter exactly (`.request.json` / `.response.json`) so evacuation moves precisely the files the
 *  ingest pass would otherwise read, no more and no less. Fails open (raced dir/file → 0 rows),
 *  since this runs on a timer and a transient race is not a reason to abort the tick. */
export function listEvacuationCandidates(dir: string): EvacCandidate[] {
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return [] }
  const out: EvacCandidate[] = []
  for (const name of names) {
    if (!name.endsWith('.request.json') && !name.endsWith('.response.json')) continue
    const p = path.join(dir, name)
    try {
      const st = fs.statSync(p)
      out.push({ name, mtime: st.mtimeMs, size: st.size })
    } catch { /* raced with a writer — skip it, we'll get it next pass */ }
  }
  return out
}

/** fsync a path (file or directory) — same shape as `ingestPass.ts`'s default `fsyncPath`: a
 *  directory fsync is a POSIX durability nicety Windows cannot do at all, so a failure is swallowed
 *  ONLY when the fd is a directory; a failed FILE fsync must still propagate (an unlink gated on an
 *  fsync that silently failed would reopen the exact page-cache hole the barrier exists to close). */
function fsyncPathOrDir(p: string): void {
  const fd = fs.openSync(p, 'r')
  try {
    fs.fsyncSync(fd)
  } catch (e) {
    let isDir = false
    try { isDir = fs.fstatSync(fd).isDirectory() } catch { /* the throw below stands */ }
    if (!isDir) throw e
  } finally { fs.closeSync(fd) }
}

/** Move ONE body file from the spool to the destination, verbatim, with the crash-safe ordering
 *  the card requires: copy to a `.evac.tmp` in the DEST (rename alone is impossible cross-device —
 *  spool is a RAM disk, dest is SSD), fsync the tmp file's fd, rename to the final name (atomic
 *  within the dest fs — this is also how a same-name collision is handled: the same request-id
 *  keyed filename is the same body, and the store dedups by content anyway), fsync the dest
 *  directory, and ONLY THEN unlink the source. A crash at any point during this sequence leaves
 *  either the untouched source or a durable complete copy in dest — never neither. */
export async function evacuateFile(spoolDir: string, destDir: string, name: string): Promise<void> {
  const srcPath = path.join(spoolDir, name)
  const tmpPath = path.join(destDir, `${name}.evac.tmp`)
  const destPath = path.join(destDir, name)

  const data = fs.readFileSync(srcPath)
  const fd = fs.openSync(tmpPath, 'w')
  try {
    fs.writeSync(fd, data)
    fs.fsyncSync(fd) // durability claim on the copy — a directory fsync is never enough on its own
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmpPath, destPath) // atomic within the dest fs; also how a collision is resolved
  fsyncPathOrDir(destDir) // the rename itself must be durable before we may delete the source
  fs.unlinkSync(srcPath) // ONLY NOW — the copy is proven durable in dest
}

export interface EvacuationDeps {
  spoolDir: string
  destDir: string
  freeBytes: number
  thresholdBytes: number
  nowMs?: number
  quiescenceMs?: number
  maxBytesPerTick?: number
  listFiles?: (dir: string) => EvacCandidate[]
  moveFile?: (spoolDir: string, destDir: string, name: string) => Promise<void>
  onWarn?: (msg: string) => void
}

export interface EvacuationResult {
  planned: number
  moved: number
  bytesMoved: number
  failed: string[]
}

/** Run one evacuation batch: plan (pure), then move each planned file. A single bad file (raced
 *  delete, permission error, disk full on the dest) is logged and skipped — it must NEVER abort the
 *  rest of the batch, and it must NEVER unlink a source whose copy did not complete + fsync (that
 *  ordering lives entirely inside `evacuateFile`, so a caught error here always means the source is
 *  still intact). Injectable `listFiles`/`moveFile` seams keep this testable without a real
 *  filesystem for the planning half and with a real one (temp dirs) for the move half. */
export async function runSpoolEvacuation(deps: EvacuationDeps): Promise<EvacuationResult> {
  const nowMs = deps.nowMs ?? Date.now()
  const listFiles = deps.listFiles ?? listEvacuationCandidates
  const moveFile = deps.moveFile ?? evacuateFile

  // The dest dir is NOT guaranteed to exist: a machine that has always run in spool mode may never
  // have had a legacy bodies dir, and nothing else creates it (the ingest pass SKIPS nonexistent
  // drain targets, it never mkdirs them). Without this, every evacuateFile would fail at open with
  // ENOENT — i.e. the evacuation would fail precisely on the first burst it exists for. Idempotent,
  // once per run, before any planning cost is paid.
  try { fs.mkdirSync(deps.destDir, { recursive: true }) } catch (e) {
    deps.onWarn?.(`spool evacuation: cannot create dest dir ${deps.destDir}: ${String(e)}`)
    return { planned: 0, moved: 0, bytesMoved: 0, failed: [] }
  }

  const files = listFiles(deps.spoolDir)
  const targetFreeBytes = deps.thresholdBytes * 2 // same hysteresis shape as the redirect's recovery band
  const plan = planEvacuation({
    freeBytes: deps.freeBytes,
    targetFreeBytes,
    files,
    nowMs,
    quiescenceMs: deps.quiescenceMs,
    maxBytesPerTick: deps.maxBytesPerTick,
  })

  let moved = 0
  let bytesMoved = 0
  const failed: string[] = []
  for (const f of plan.toEvacuate) {
    try {
      await moveFile(deps.spoolDir, deps.destDir, f.name)
      moved++
      bytesMoved += f.size
    } catch (e) {
      const msg = `${f.name}: ${(e as Error).message}`
      failed.push(msg)
      deps.onWarn?.(`spool evacuation: failed to move ${msg} — source left in place`)
    }
  }
  return { planned: plan.toEvacuate.length, moved, bytesMoved, failed }
}
