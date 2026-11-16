// src/cli/diskSample.ts — `agentlenspro disk-sample`: one sample then exit, or with `--volumes-only --resident` a minute loop (TRDD-HTARKH87, TRDD-RU9A8H7A, TRDD-T16ZQH9F).
//
// Run by TWO launchd jobs that `disk-monitor install` writes: `--volumes-only --resident` (kept alive, one sample per wall-clock minute) and `--walks-only` every 300 s. They are
// separate because a run that also walked folders took up to ~41 s, and launchd counts StartInterval from the previous run's exit
// (measured: a steady ~101.5 s gap between volume rows). No flag = both, in one run. The minute job
// itself is now the resident loop (`--volumes-only --resident`): see runResident for why it is no longer a fresh process per minute.
// Exempt from the DISABLED kill switch (foreignTelemetry.ts READ_ONLY_VERBS) by owner decision 2026-11-16: the monitor exists to
// watch a disk filling up, and the disk filling up is exactly when everything else has been switched off. It never touches the
// DISABLED file and never talks to the server or cards.duckdb.
//
// Shape of one run (the DuckDB file lock is held only in steps 2 and 4; a lock held by the other job is retried for 5 s, then the
// run exits non-zero with a line in the log — a volume row is never silently dropped):
//   1. probe the volumes (statfs + diskutil + one osascript call, every call time-boxed)      [volumes]
//   2. open, insert the volume rows, close                                                      [volumes]
//   2b. open, read what is due, close                                                           [walks]
//   3. walk the watch-list folders that are due, inside a total time budget, no DB held        [walks]
//   4. open, store finished walks and the cursor of unfinished ones, close                      [walks]

import { assertKnownFlags } from "./argHelpers"
import { EXIT, UsageError } from "./cliErrors"
import { insertRows, isWriterLockError, openWritable, type DiskDb, type SqlValue } from "./diskStore"
import { sampleVolumes, type VolumeSample } from "./diskVolumes"
import { startWalk, runSegment, WALK_MAX_AGE_MS, type PendingDir, type WalkState } from "./diskWalk"
import { defaultWatch, effectiveWatch, type WatchEntry, type WatchKind } from "./diskWatch"
import * as fs from "fs"

/** Total time one run may spend walking folders; the volume rows are already written before it starts. */
export const WALK_BUDGET_MS = 40_000
/** A folder is walked again this long after its last walk ended. */
export const WALK_INTERVAL_MS = 15 * 60_000
/** A folder is walked again no sooner than this many times its last walk cost: measured 2026-11-16, ~ and ~/Code take minutes of walking
 *  each, so a flat 15 min would keep the sampler walking nearly all the time (~19k files/s, mostly system time). 4x caps that at 25% duty. */
export const WALK_COOLDOWN_FACTOR = 4
const FIRST_PASS_SLICE_MS = 500

// Exported for the persistence round-trip test (the cursor must survive a close and reopen of disk.duckdb).
export interface Plan {
  entry: WatchEntry
  resume: WalkState | null
  /** Last time this folder was worked on — least recent goes first, so no folder starves another. */
  activityMs: number
}

export interface Outcome {
  plan: Plan
  /** null when the root could not be resolved at all. */
  state: WalkState | null
  finished: boolean
  partial: boolean
  error: string | null
  tsEndMs: number
}

export interface SampleSummary {
  volumes: number
  due: number
  finished: number
  elapsedMs: number
}

const n = (v: unknown): number => Number(v)

async function rows(db: DiskDb, sql: string): Promise<Record<string, unknown>[]> {
  return (await db.con.runAndReadAll(sql)).getRowObjects() as Record<string, unknown>[]
}

/** Sum of the allocated bytes of the latest finished trash walks that live on each volume. */
function trashPerVolume(volumes: readonly VolumeSample[], trash: readonly { path: string; allocated: number }[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const t of trash) {
    let dev: number
    try { dev = fs.statSync(t.path).dev } catch { continue }
    const vol = volumes.find(v => v.dev === dev)
    if (vol) out.set(vol.mount, (out.get(vol.mount) ?? 0) + t.allocated)
  }
  return out
}

async function loadState(db: DiskDb, path: string, r: Record<string, unknown>): Promise<WalkState> {
  const pend = await db.con.runAndReadAll("SELECT dir, follow_only, hops FROM disk_walk_pending WHERE path = ? ORDER BY seq", [path])
  const pending: PendingDir[] = pend.getRowObjects().map(p => ({ dir: String(p.dir), followOnly: Boolean(p.follow_only), hops: n(p.hops) }))
  const fol = await db.con.runAndReadAll("SELECT real, dev, ino FROM disk_walk_followed WHERE path = ?", [path])
  const followed = fol.getRowObjects().map(f => ({ real: String(f.real), dev: n(f.dev), ino: n(f.ino) }))
  return {
    path, rootReal: String(r.root_real), rootDev: n(r.root_dev), tsStartMs: n(r.start_ms), elapsedMs: n(r.elapsed_ms),
    totals: { apparent: n(r.apparent_b), allocated: n(r.allocated_b), apparentFollow: n(r.apparent_follow_b), allocatedFollow: n(r.allocated_follow_b), files: n(r.files), unreadable: n(r.unreadable) },
    firstError: r.first_error === null ? null : String(r.first_error), pending, followed,
  }
}

/** Open disk.duckdb read-write, seeding the default watch list exactly when the file was just created (both jobs may be the first to run). `waitMs` bounds the writer-lock wait (openWritable's default when absent). */
async function openSeeded(waitMs?: number): Promise<DiskDb> {
  const db = await openWritable(waitMs)
  try {
    if (db.created) {
      await insertRows(db.con, "disk_watch", [["path", "TEXT"], ["kind", "TEXT"]], defaultWatch().map(w => [w.path, w.kind]))
    }
    return db
  } catch (e) {
    db.close()
    throw e
  }
}

/** One stderr line when this process held the writer lock for over a second, measured from db.lockedAtMs (stamped before the lock was taken) to after close().
 *  TRDD-T16ZQH9F: a starved low-priority walk job held the only writer lock past the sampler's wait and the phase (plan or store) that held it could only be inferred, never read from the log. */
function logLongHold(phase: "plan" | "store", db: DiskDb): void {
  const heldMs = Date.now() - db.lockedAtMs
  if (heldMs > 1000) console.error(`disk-sample: held disk.duckdb ${heldMs} ms (${phase}), opened ${new Date(db.lockedAtMs).toISOString()}`)
}

/** Step 2: insert the volume rows of every batch item (each with its own timestamp) in ONE open and ONE transaction: either all of them land or none.
 *  Touches no walk table except to READ the latest finished trash walks, so it never waits on a walk. The trash lookup runs once per batch, so a
 *  carried-over row (TRDD-T16ZQH9F) takes its trash_b from the walks finished at WRITE time, not at the time it was sampled. `waitMs` bounds the writer-lock wait. */
export async function recordVolumeBatch(batch: readonly { volumes: readonly VolumeSample[]; tsMs: number }[], waitMs = 5000): Promise<void> {
  const db = await openSeeded(waitMs)
  try {
    // Latest FINISHED walk of each trash folder — the trash_b of this sample is that, not a fresh walk.
    const trash = (await rows(db,
      "SELECT t.path, t.allocated_b FROM disk_tree t JOIN (SELECT path, max(ts_end) AS m FROM disk_tree WHERE kind = 'trash' GROUP BY path) l ON t.path = l.path AND t.ts_end = l.m WHERE t.kind = 'trash' AND t.allocated_b IS NOT NULL"))
      .map(r => ({ path: String(r.path), allocated: n(r.allocated_b) }))
    await db.con.run("BEGIN")
    try {
      for (const { volumes, tsMs } of batch) {
        const trashBy = trashPerVolume(volumes, trash)
        const ts = new Date(tsMs)
        await insertRows(db.con, "disk_volume", [
          ["ts", "TIMESTAMPTZ"], ["mount", "TEXT"], ["device", "TEXT"], ["fs_type", "TEXT"], ["container", "TEXT"], ["volume_uuid", "TEXT"],
          ["total_b", "BIGINT"], ["used_b", "BIGINT"], ["free_b", "BIGINT"], ["avail_b", "BIGINT"], ["vol_used_b", "BIGINT"], ["container_free_b", "BIGINT"],
          ["purgeable_b", "BIGINT"], ["important_avail_b", "BIGINT"], ["trash_b", "BIGINT"], ["used_minus_trash_b", "BIGINT"], ["error", "TEXT"],
        ], volumes.map((v): SqlValue[] => {
          const t = trashBy.get(v.mount) ?? null
          return [ts, v.mount, v.device, v.fsType, v.container, v.volumeUuid, v.totalB, v.usedB, v.freeB, v.availB, v.volUsedB, v.containerFreeB,
            v.purgeableB, v.importantAvailB, t, v.usedB !== null && t !== null ? v.usedB - t : null, v.error]
        }))
      }
      await db.con.run("COMMIT")
    } catch (e) {
      try { await db.con.run("ROLLBACK") } catch { /* the original error is the one to report */ }
      throw e
    }
  } finally {
    db.close()
  }
}

/** Step 2 of the one-shot run: one sample, one row set. */
export async function recordVolumes(volumes: readonly VolumeSample[], nowMs: number): Promise<void> {
  await recordVolumeBatch([{ volumes, tsMs: nowMs }])
}

/** Step 2b: work out which watch-list folders are due (a resumable cursor, or never walked, or past the cooldown). */
export async function planWalks(nowMs: number): Promise<Plan[]> {
  const db = await openSeeded()
  try {
    const stored = (await rows(db, "SELECT path, kind FROM disk_watch ORDER BY path")).map(r => ({ path: String(r.path), kind: String(r.kind) as WatchKind }))
    const lastEnd = new Map((await rows(db, "SELECT path, epoch_ms(max(ts_end)) AS ms, arg_max(elapsed_ms, ts_end) AS took FROM disk_tree GROUP BY path")).map(r => [String(r.path), { endMs: n(r.ms), walkMs: n(r.took) }]))
    const states = new Map<string, Record<string, unknown>>()
    for (const r of await rows(db, "SELECT *, epoch_ms(ts_start) AS start_ms, epoch_ms(last_segment) AS seg_ms FROM disk_walk_state")) states.set(String(r.path), r)
    const plans: Plan[] = []
    for (const entry of effectiveWatch(stored)) {
      const st = states.get(entry.path)
      if (st) plans.push({ entry, resume: await loadState(db, entry.path, st), activityMs: n(st.seg_ms) })
      else {
        const last = lastEnd.get(entry.path)
        if (last === undefined || nowMs - last.endMs >= Math.max(WALK_INTERVAL_MS, WALK_COOLDOWN_FACTOR * last.walkMs)) plans.push({ entry, resume: null, activityMs: last?.endMs ?? 0 })
      }
    }
    return plans.sort((a, b) => a.activityMs - b.activityMs)
  } finally {
    db.close()
    logLongHold("plan", db)
  }
}

/** Step 3: walk the due folders inside the budget. No DB held.
 *  Two passes, because most folders are tiny and a few are enormous: pass 1 gives EVERY due folder a short slice, which
 *  finishes the small ones at once and returns their unused time; pass 2 splits what is left evenly among the folders still
 *  unfinished. One slice per folder in a single pass starved the enormous ones (measured: 3 s each of a 40 s budget). */
function walkDue(plans: readonly Plan[], budgetMs: number): Outcome[] {
  const deadline = Date.now() + budgetMs
  const done = new Map<Plan, Outcome>()
  const states = new Map<Plan, WalkState>()
  const step = (plan: Plan, sliceEnd: number): void => {
    const state = states.get(plan) ?? plan.resume ?? startWalk(plan.entry.path, Date.now())
    if ("error" in state) {
      done.set(plan, { plan, state: null, finished: true, partial: false, error: state.error, tsEndMs: Date.now() })
      return
    }
    states.set(plan, state)
    let finished = runSegment(state, sliceEnd)
    // Aged out: a walk spread over more than a day no longer describes one moment — close it, flagged.
    const aged = !finished && Date.now() - state.tsStartMs > WALK_MAX_AGE_MS
    if (aged) finished = true
    const unreadable = state.totals.unreadable
    done.set(plan, { plan, state, finished, partial: aged, error: unreadable > 0 ? `${unreadable} unreadable (first: ${state.firstError})` : null, tsEndMs: Date.now() })
  }
  for (const plan of plans) {
    if (deadline - Date.now() < 1000) break
    step(plan, Math.min(deadline, Date.now() + FIRST_PASS_SLICE_MS))
  }
  for (let open = plans.filter(p => done.has(p) && !done.get(p)?.finished); open.length > 0; open = open.filter(p => !done.get(p)?.finished)) {
    const remaining = deadline - Date.now()
    if (remaining < 1000) break
    const slice = remaining / open.length
    for (const plan of open) step(plan, Math.min(deadline, Date.now() + slice))
  }
  // Only folders that got a turn are reported; the rest stay due and go first next run (their activity time is unchanged).
  return plans.flatMap(p => done.get(p) ?? [])
}

/** Step 4: persist finished walks as disk_tree rows and unfinished ones as a resumable cursor. */
export async function storeOutcomes(outcomes: readonly Outcome[]): Promise<void> {
  if (outcomes.length === 0) return
  const db = await openWritable()
  try {
    await db.con.run("BEGIN")
    for (const o of outcomes) {
      const path = o.plan.entry.path
      await db.con.run("DELETE FROM disk_walk_state WHERE path = ?", [path])
      await db.con.run("DELETE FROM disk_walk_pending WHERE path = ?", [path])
      await db.con.run("DELETE FROM disk_walk_followed WHERE path = ?", [path])
      const s = o.state
      if (o.finished) {
        const t = s?.totals
        await insertRows(db.con, "disk_tree", [
          ["ts_start", "TIMESTAMPTZ"], ["ts_end", "TIMESTAMPTZ"], ["path", "TEXT"], ["kind", "TEXT"], ["apparent_b", "BIGINT"], ["allocated_b", "BIGINT"],
          ["apparent_follow_b", "BIGINT"], ["allocated_follow_b", "BIGINT"], ["files", "BIGINT"], ["partial", "BOOLEAN"], ["elapsed_ms", "BIGINT"], ["error", "TEXT"],
        ], [[new Date(s?.tsStartMs ?? o.tsEndMs), new Date(o.tsEndMs), path, o.plan.entry.kind, t?.apparent ?? null, t?.allocated ?? null,
          t?.apparentFollow ?? null, t?.allocatedFollow ?? null, t?.files ?? null, o.partial, s?.elapsedMs ?? 0, o.error]])
      } else if (s) {
        const t = s.totals
        await insertRows(db.con, "disk_walk_state", [
          ["path", "TEXT"], ["ts_start", "TIMESTAMPTZ"], ["last_segment", "TIMESTAMPTZ"], ["root_real", "TEXT"], ["root_dev", "BIGINT"],
          ["apparent_b", "BIGINT"], ["allocated_b", "BIGINT"], ["apparent_follow_b", "BIGINT"], ["allocated_follow_b", "BIGINT"],
          ["files", "BIGINT"], ["unreadable", "BIGINT"], ["elapsed_ms", "BIGINT"], ["first_error", "TEXT"],
        ], [[path, new Date(s.tsStartMs), new Date(o.tsEndMs), s.rootReal, s.rootDev, t.apparent, t.allocated, t.apparentFollow, t.allocatedFollow, t.files, t.unreadable, s.elapsedMs, s.firstError]])
        // Appender, not INSERT ... VALUES: a wide tree leaves hundreds of thousands of pending directories (316k under ~/Code), and the one run that
        // stored that many with 500-row INSERTs took 98 s against ~42 s for the others. The appender wrote 300k rows in 0.6 s in isolation.
        const fol = await db.con.createAppender("disk_walk_followed")
        try {
          for (const f of s.followed) {
            fol.appendVarchar(path)
            fol.appendVarchar(f.real)
            fol.appendBigInt(BigInt(f.dev))
            fol.appendBigInt(BigInt(f.ino))
            fol.endRow()
          }
          fol.flushSync()
        } finally {
          fol.closeSync()
        }
        const app = await db.con.createAppender("disk_walk_pending")
        try {
          s.pending.forEach((p, i) => {
            app.appendVarchar(path)
            app.appendBigInt(BigInt(i))
            app.appendVarchar(p.dir)
            app.appendBoolean(p.followOnly)
            app.appendInteger(p.hops)
            app.endRow()
          })
          app.flushSync()
        } finally {
          app.closeSync()
        }
      }
    }
    await db.con.run("COMMIT")
  } catch (e) {
    try { await db.con.run("ROLLBACK") } catch { /* the original error is the one to report */ }
    throw e
  } finally {
    db.close()
    logLongHold("store", db)
  }
}

/** `all` = today's single run; `volumes` = the minute job (volume rows only, never delayed by a walk); `walks` = the slow job (folder walks only). */
export type SampleMode = "all" | "volumes" | "walks"

export async function runDiskSample(opts: { budgetMs?: number; mode?: SampleMode } = {}): Promise<SampleSummary> {
  const t0 = Date.now()
  const mode = opts.mode ?? "all"
  let volumeCount = 0
  if (mode !== "walks") {
    const volumes = await sampleVolumes()
    await recordVolumes(volumes, t0)
    volumeCount = volumes.length
  }
  let plans: Plan[] = []
  let outcomes: Outcome[] = []
  if (mode !== "volumes") {
    plans = await planWalks(t0)
    outcomes = walkDue(plans, opts.budgetMs ?? WALK_BUDGET_MS)
    await storeOutcomes(outcomes)
  }
  return { volumes: volumeCount, due: plans.length, finished: outcomes.filter(o => o.finished).length, elapsedMs: Date.now() - t0 }
}

/** The first wall-clock minute boundary strictly after `nowMs`. */
export function nextMinuteBoundary(nowMs: number): number {
  return Math.floor(nowMs / 60_000) * 60_000 + 60_000
}

/** One finished sample whose row is not yet written: `slotMs` is the minute slot it was taken for, `tsMs` the clock read before probing (the row's ts). */
export interface PendingSample<S> {
  slotMs: number
  tsMs: number
  sample: S
}

export interface ResidentDeps<S> {
  now(): number
  sleep(ms: number): Promise<void>
  /** One probe of the machine; its result is carried to `record`. */
  sample(): Promise<S>
  /** Writes every sample of `batch` (oldest first) in one go, waiting at most `waitMs` for the writer lock. A writer-lock refusal (isWriterLockError) keeps the batch for the next tick. */
  record(batch: readonly PendingSample<S>[], waitMs: number): Promise<void>
  log(line: string): void
  /** A hard deadline for one tick: `expired` resolves after `ms`; `cancel` disarms it. */
  deadline(ms: number): { expired: Promise<void>; cancel(): void }
  /** Ends the process (the injected form in tests just records the code). */
  exit(code: number): void
  /** Stop after this many ticks, the immediate first one included (tests); absent = run forever. */
  maxTicks?: number
  /** Longest writer-lock wait of one tick; default RESIDENT_LOCK_WAIT_MS. */
  lockWaitMs?: number
  /** A tick still running after this long is stuck; default TICK_WATCHDOG_MS. */
  watchdogMs?: number
  /** Registers the callback that runs when the process is told to stop (SIGTERM); the callback logs the buffered slots that will be lost. */
  onTerminate?(cb: () => void): void
}

/** The minute loop: one sample immediately at start (so a restart leaves no blind spot), then one per wall-clock minute boundary. A sample whose write
 *  is refused by the writer lock (another job holds disk.duckdb) is kept in memory (at most MAX_PENDING, oldest dropped and logged) and written with the
 *  next tick, each with its own timestamp; a sample() failure or any other write failure is logged as one line and the loop goes on. The next
 *  slot is always computed from now() (never slot += 60000), so after a system sleep or clock jump the loop skips to the next boundary: a gap, no backlog of ticks.
 *  A tick that outlives the watchdog is stuck: log one line and exit non-zero so launchd KeepAlive restarts the job — a live process that no longer samples would never be restarted.
 *  The lock wait of a tick shrinks as its sample took longer, so sample + write always ends 10 s before the watchdog.
 *  WHY resident and not a fresh process per minute: measured 2026-11-16 (TRDD-T16ZQH9F) under load 194-258, a fresh node process
 *  per minute missed its 60 s slot (runs took 24-47 s; startup and sampling were both slow), while a resident node loop with a minute-boundary
 *  timer woke 0-5 ms late and finished every sample in under 12 s (that scratch loop left out the DuckDB write; unproven with it under load).
 *  WHY the carry-over (TRDD-T16ZQH9F): the low-priority walk job held the writer lock past the old fixed 5 s wait and that minute's row was lost for good. */
export async function runResident<S>(deps: ResidentDeps<S>): Promise<void> {
  const watchdogMs = deps.watchdogMs ?? TICK_WATCHDOG_MS
  const lockWaitMs = deps.lockWaitMs ?? RESIDENT_LOCK_WAIT_MS
  /** Samples whose write the writer lock refused, oldest first. */
  let pending: PendingSample<S>[] = []
  const slotList = (list: readonly { slotMs: number }[]): string => list.map(p => new Date(p.slotMs).toISOString()).join(", ")
  deps.onTerminate?.(() => {
    if (pending.length > 0) deps.log(`disk-sample resident: stopping with ${pending.length} buffered sample(s) not written, slots ${slotList(pending)}`)
  })
  const tick = async (slot: number): Promise<void> => {
    // The stamp is read BEFORE the probes (as the one-shot path does), so a slow probe does not shift the row.
    const tickStart = deps.now()
    const sample = await deps.sample()
    const sampleMs = deps.now() - tickStart
    const waitMs = Math.min(lockWaitMs, Math.max(1000, watchdogMs - 10_000 - sampleMs))
    const batch = [...pending, { slotMs: slot, tsMs: tickStart, sample }]
    const writeStart = deps.now()
    try {
      await deps.record(batch, waitMs)
      pending = []
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (isWriterLockError(e)) {
        pending = batch
        while (pending.length > MAX_PENDING) {
          const lost = pending.shift()
          if (lost) deps.log(`disk-sample resident: buffer full, sample for slot ${new Date(lost.slotMs).toISOString()} dropped`)
        }
        deps.log(`disk-sample resident: write deferred, ${pending.length} sample(s) buffered: ${msg}`)
      } else {
        // Not a lock: retrying the same batch would fail the same way and block every later minute, so it is dropped (and said).
        pending = []
        deps.log(`disk-sample resident: write failed, ${batch.length} sample(s) dropped, slots ${slotList(batch)}: ${msg}`)
      }
    }
    const writeMs = deps.now() - writeStart
    const tickMs = deps.now() - tickStart
    if (tickMs > SLOW_TICK_MS || writeMs > SLOW_WRITE_MS) {
      deps.log(`disk-sample resident: tick ${new Date(slot).toISOString()} took ${tickMs} ms (sample ${sampleMs} ms, write ${writeMs} ms)`)
    }
  }
  /** false = the watchdog fired and the process was told to exit. */
  const runTick = async (slot: number): Promise<boolean> => {
    const dog = deps.deadline(watchdogMs)
    try {
      const outcome = await Promise.race([tick(slot).then(() => "done" as const), dog.expired.then(() => "stuck" as const)])
      if (outcome === "stuck") {
        // The buffered samples and the one in flight die with the process.
        deps.log(`disk-sample resident: tick ${new Date(slot).toISOString()} still running after ${watchdogMs} ms; exiting so launchd restarts the sampler; samples lost, slots ${slotList([...pending, { slotMs: slot }])}`)
        deps.exit(1)
        return false
      }
    } catch (e) {
      deps.log(`disk-sample resident: tick ${new Date(slot).toISOString()} failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      dog.cancel()
    }
    return true
  }
  let lastSlot = deps.now()
  if (!(await runTick(lastSlot))) return
  for (let ticks = 1; deps.maxTicks === undefined || ticks < deps.maxTicks; ticks++) {
    // max(now, lastSlot): a timer that fires a few ms before its boundary must not make the next boundary the same slot again.
    const slot = nextMinuteBoundary(Math.max(deps.now(), lastSlot))
    // A real setTimeout can fire a few ms early: sleep again until the boundary is reached, so a tick never runs (or stamps its row) before its slot.
    while (deps.now() < slot) await deps.sleep(slot - deps.now())
    lastSlot = slot
    if (!(await runTick(slot))) return
  }
}

/** A resident tick running this long is stuck (every probe is capped at 5 s; the writer-lock wait is capped by RESIDENT_LOCK_WAIT_MS and shrinks so sample + write ends 10 s before this): the process exits so launchd restarts it. */
const TICK_WATCHDOG_MS = 45_000
/** Longest writer-lock wait of one resident tick. Longer than the one-shot 5 s because a refused write is no longer lost, but still far below the watchdog. */
const RESIDENT_LOCK_WAIT_MS = 30_000
/** Samples kept in memory while the writer lock is refused; beyond it the oldest is dropped (and logged). */
const MAX_PENDING = 10
/** A tick longer than this, or a write longer than SLOW_WRITE_MS, logs one line with the sample and write times. */
const SLOW_TICK_MS = 15_000
const SLOW_WRITE_MS = 3000

const KNOWN: ReadonlySet<string> = new Set(["--quiet", "--volumes-only", "--walks-only", "--resident"])

/** `--quiet`: print nothing on success — the launchd jobs pass it so their log stays small. (`--help` never gets here: main.ts answers it.) */
export async function runDiskSampleCli(argv: string[]): Promise<number> {
  assertKnownFlags(argv, KNOWN, new Set(), "agentlenspro disk-sample")
  const volumesOnly = argv.includes("--volumes-only")
  const walksOnly = argv.includes("--walks-only")
  if (volumesOnly && walksOnly) throw new UsageError("disk-sample: --volumes-only and --walks-only are mutually exclusive")
  if (argv.includes("--resident")) {
    if (!volumesOnly) throw new UsageError("disk-sample: --resident is only valid with --volumes-only")
    // Never returns: launchd (KeepAlive) owns its lifetime. recordVolumeBatch opens disk.duckdb and closes it per tick, so the writer lock is free between minutes.
    await runResident({
      now: Date.now,
      sleep: ms => new Promise<void>(resolve => setTimeout(resolve, ms)),
      sample: sampleVolumes,
      record: (batch, waitMs) => recordVolumeBatch(batch.map(b => ({ volumes: b.sample, tsMs: b.tsMs })), waitMs),
      // A launchd stop (SIGTERM) loses whatever is still buffered: say which slots before the process ends.
      onTerminate: cb => { process.on("SIGTERM", () => { cb(); process.exit(143) }) },
      log: line => console.error(line),
      deadline: ms => {
        let timer: NodeJS.Timeout | undefined
        const expired = new Promise<void>(resolve => { timer = setTimeout(resolve, ms) })
        return { expired, cancel: () => clearTimeout(timer) }
      },
      exit: code => process.exit(code),
    })
    return EXIT.OK
  }
  try {
    const s = await runDiskSample({ mode: volumesOnly ? "volumes" : walksOnly ? "walks" : "all" })
    if (!argv.includes("--quiet")) console.log(`disk-sample: ${s.volumes} volume(s); ${s.finished}/${s.due} due folder walk(s) finished; ${s.elapsedMs} ms`)
    return EXIT.OK
  } catch (e) {
    console.error(`disk-sample failed: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}
