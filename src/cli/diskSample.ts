// src/cli/diskSample.ts — `agentlenspro disk-sample`: one sample, then exit (TRDD-HTARKH87, TRDD-RU9A8H7A).
//
// Run by TWO launchd jobs that `disk-monitor install` writes: `--volumes-only` every 60 s and `--walks-only` every 300 s. They are
// separate because a run that also walked folders took up to ~41 s, and launchd counts StartInterval from the previous run's exit
// (measured: a steady ~101.5 s gap between volume rows) — the minute job must be as short as possible. No flag = both, in one run.
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
import { insertRows, openWritable, type DiskDb, type SqlValue } from "./diskStore"
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

/** Open disk.duckdb read-write, seeding the default watch list exactly when the file was just created (both jobs may be the first to run). */
async function openSeeded(): Promise<DiskDb> {
  const db = await openWritable()
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

/** Step 2: insert one row per volume. Touches no walk table except to READ the latest finished trash walks, so it never waits on a walk. */
export async function recordVolumes(volumes: readonly VolumeSample[], nowMs: number): Promise<void> {
  const db = await openSeeded()
  try {
    // Latest FINISHED walk of each trash folder — the trash_b of this sample is that, not a fresh walk.
    const trash = (await rows(db,
      "SELECT t.path, t.allocated_b FROM disk_tree t JOIN (SELECT path, max(ts_end) AS m FROM disk_tree WHERE kind = 'trash' GROUP BY path) l ON t.path = l.path AND t.ts_end = l.m WHERE t.kind = 'trash' AND t.allocated_b IS NOT NULL"))
      .map(r => ({ path: String(r.path), allocated: n(r.allocated_b) }))
    const trashBy = trashPerVolume(volumes, trash)
    const ts = new Date(nowMs)
    await insertRows(db.con, "disk_volume", [
      ["ts", "TIMESTAMPTZ"], ["mount", "TEXT"], ["device", "TEXT"], ["fs_type", "TEXT"], ["container", "TEXT"], ["volume_uuid", "TEXT"],
      ["total_b", "BIGINT"], ["used_b", "BIGINT"], ["free_b", "BIGINT"], ["avail_b", "BIGINT"], ["vol_used_b", "BIGINT"], ["container_free_b", "BIGINT"],
      ["purgeable_b", "BIGINT"], ["important_avail_b", "BIGINT"], ["trash_b", "BIGINT"], ["used_minus_trash_b", "BIGINT"], ["error", "TEXT"],
    ], volumes.map((v): SqlValue[] => {
      const t = trashBy.get(v.mount) ?? null
      return [ts, v.mount, v.device, v.fsType, v.container, v.volumeUuid, v.totalB, v.usedB, v.freeB, v.availB, v.volUsedB, v.containerFreeB,
        v.purgeableB, v.importantAvailB, t, v.usedB !== null && t !== null ? v.usedB - t : null, v.error]
    }))
  } finally {
    db.close()
  }
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

const KNOWN: ReadonlySet<string> = new Set(["--quiet", "--volumes-only", "--walks-only"])

/** `--quiet`: print nothing on success — the launchd jobs pass it so their log stays small. (`--help` never gets here: main.ts answers it.) */
export async function runDiskSampleCli(argv: string[]): Promise<number> {
  assertKnownFlags(argv, KNOWN, new Set(), "agentlenspro disk-sample")
  const volumesOnly = argv.includes("--volumes-only")
  const walksOnly = argv.includes("--walks-only")
  if (volumesOnly && walksOnly) throw new UsageError("disk-sample: --volumes-only and --walks-only are mutually exclusive")
  try {
    const s = await runDiskSample({ mode: volumesOnly ? "volumes" : walksOnly ? "walks" : "all" })
    if (!argv.includes("--quiet")) console.log(`disk-sample: ${s.volumes} volume(s); ${s.finished}/${s.due} due folder walk(s) finished; ${s.elapsedMs} ms`)
    return EXIT.OK
  } catch (e) {
    console.error(`disk-sample failed: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}
