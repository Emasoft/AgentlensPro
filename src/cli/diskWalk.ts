// src/cli/diskWalk.ts — resumable directory-size walker for the disk monitor (TRDD-HTARKH87).
//
// ONE traversal produces both views the owner asked for: the sizes WITHOUT following symlinks
// (a link counts as the few bytes it is) and WITH them (the plain totals plus each DISTINCT symlink target that lies outside the root, counted once, as if it were a
// copy). Sizes are apparent (st_size) and allocated (st_blocks * 512).
//
// WHY RESUMABLE: measured 2026-11-16, `du -sk` of the home directory and of ~/Code both hit a 40 s
// timeout without finishing, so a walk that must fit one run's budget would never complete for exactly
// the folders worth watching. The walk is therefore an explicit stack (`pending`) that the caller
// persists between runs; a walk is complete only when the stack is empty. Hardlink de-duplication
// lives in memory only, so a hardlinked file whose two names are met in different runs is counted
// twice — documented, and bounded by the 24 h WALK_MAX_AGE_MS after which a walk is closed as partial.

import * as fs from "fs"
import * as path from "path"

/** Symlink hops a followed subtree may nest. A cap, not a loop detector: the loop guard is the ancestor test, this bounds a DAG of links. */
const MAX_HOPS = 3
/** A walk spread over many runs drifts from the disk it measures; past this age it is closed as partial rather than resumed forever. */
export const WALK_MAX_AGE_MS = 24 * 3600 * 1000

export interface PendingDir {
  dir: string
  /** Reached through a symlink: counts toward the follow totals only. */
  followOnly: boolean
  hops: number
}

export interface WalkTotals {
  apparent: number
  allocated: number
  apparentFollow: number
  allocatedFollow: number
  files: number
  unreadable: number
}

export interface FollowedTarget {
  /** realpath of a symlink target outside the root that this walk has already taken on (or is walking). */
  real: string
  dev: number
  ino: number
}
export interface WalkState {
  /** Configured watch path, as the user wrote it. */
  path: string
  /** realpath of the root: a root that is itself a symlink (~/Code) is always resolved. */
  rootReal: string
  rootDev: number
  tsStartMs: number
  elapsedMs: number
  totals: WalkTotals
  firstError: string | null
  pending: PendingDir[]
  /** Symlink targets already counted in the follow totals. Persisted with the cursor (disk_walk_followed) so a resumed walk never counts one twice. */
  followed: FollowedTarget[]
}

/** Begin a walk. Returns an error string instead of a state when the root cannot even be resolved (missing, permission denied). */
export function startWalk(watchPath: string, nowMs: number): WalkState | { error: string } {
  let rootReal: string
  let st: fs.Stats
  try {
    rootReal = fs.realpathSync(watchPath)
    st = fs.statSync(rootReal)
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
  const state: WalkState = {
    path: watchPath, rootReal, rootDev: st.dev, tsStartMs: nowMs, elapsedMs: 0,
    totals: { apparent: 0, allocated: 0, apparentFollow: 0, allocatedFollow: 0, files: 0, unreadable: 0 },
    firstError: null, pending: [], followed: [],
  }
  if (st.isDirectory()) state.pending.push({ dir: rootReal, followOnly: false, hops: 0 })
  else addEntry(state.totals, st, true, true)
  return state
}

function addEntry(t: WalkTotals, st: fs.Stats, base: boolean, follow: boolean): void {
  const allocated = st.blocks * 512
  if (base) { t.apparent += st.size; t.allocated += allocated; t.files += 1 }
  if (follow) { t.apparentFollow += st.size; t.allocatedFollow += allocated }
}

/** Files with more than one link are counted once per walk run, per view. Directories are never hardlinked on APFS. */
class LinkSet {
  private readonly byDev = new Map<number, Set<number>>()
  /** True the first time (dev, ino) is seen. */
  first(dev: number, ino: number): boolean {
    let s = this.byDev.get(dev)
    if (!s) { s = new Set(); this.byDev.set(dev, s) }
    if (s.has(ino)) return false
    s.add(ino)
    return true
  }
}

function noteError(state: WalkState, where: string, e: unknown): void {
  state.totals.unreadable += 1
  state.firstError ??= `${where}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`
}

const isUnder = (ancestor: string, p: string): boolean => p === ancestor || p.startsWith(ancestor + path.sep)

/** Process the stack until it is empty or `deadlineMs` passes (checked between directories — one huge directory is read whole).
 *  Returns true when the walk is complete. Mutates `state` so the caller can persist it either way.
 *  `maxDirs` caps the directories read in this segment, a second stop besides the clock; it exists so a test can cut a walk
 *  after a known amount of work instead of racing the clock. */
export function runSegment(state: WalkState, deadlineMs: number, maxDirs = Infinity): boolean {
  const t0 = Date.now()
  const seenBase = new LinkSet()
  const seenFollow = new LinkSet()
  const count = (st: fs.Stats, base: boolean): void => {
    // st_nlink > 1: count the first name only, separately per view (a hardlink seen in base is still new to a follow-only subtree).
    const linked = st.isFile() && st.nlink > 1
    const addBase = base && (!linked || seenBase.first(st.dev, st.ino))
    const addFollow = !linked || seenFollow.first(st.dev, st.ino)
    addEntry(state.totals, st, addBase, addFollow)
  }
  // WHY the "with symlinks" view is plain + each DISTINCT outside target ONCE: the first version re-counted every link target
  // wherever it was met (a link to a dir inside the root, two links to one dir, a link into an already-followed tree) and
  // measured 7.4 TB apparent on a 1.77 TiB volume. A target is taken on only if it lies outside the root (the plain walk counts
  // the inside), is not already followed, and is not inside an already-followed target; the set survives a resume (state.followed).
  const followedKey = (dev: number, ino: number): string => `${dev}:${ino}`
  const followedIno = new Set(state.followed.map(f => followedKey(f.dev, f.ino)))
  const followedReal = new Set(state.followed.map(f => f.real))
  const insideFollowed = (real: string): boolean => {
    for (let a = real; ; a = path.dirname(a)) {
      if (followedReal.has(a)) return true
      if (path.dirname(a) === a) return false
    }
  }
  const takeOn = (real: string, st: fs.Stats): void => {
    state.followed.push({ real, dev: st.dev, ino: st.ino })
    followedIno.add(followedKey(st.dev, st.ino))
    followedReal.add(real)
  }
  let dirsRead = 0
  while (state.pending.length > 0 && Date.now() < deadlineMs && dirsRead++ < maxDirs) {
    const item = state.pending.pop() as PendingDir
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(item.dir, { withFileTypes: true })
    } catch (e) {
      noteError(state, item.dir, e)
      continue
    }
    for (const ent of entries) {
      const p = path.join(item.dir, ent.name)
      let st: fs.Stats
      try { st = fs.lstatSync(p) } catch (e) { noteError(state, p, e); continue }
      if (st.isSymbolicLink()) {
        count(st, !item.followOnly) // the link itself, in whichever tree it sits
        if (item.hops >= MAX_HOPS) continue
        let target: fs.Stats
        let real: string
        try { target = fs.statSync(p); real = fs.realpathSync(p) } catch { continue } // dangling link: nothing to follow
        if (target.dev !== state.rootDev) { noteError(state, p, { code: "symlink to another volume, not followed" }); continue }
        const isDir = target.isDirectory()
        if (!isDir && !target.isFile()) continue
        if (isUnder(state.rootReal, real)) continue // inside the root: the plain walk already counts it
        if (isUnder(real, state.rootReal)) continue // contains the root: following it would count the root again
        if (isUnder(real, item.dir)) continue // ancestor of the directory being read (item.dir is already a realpath): a loop
        if (followedIno.has(followedKey(target.dev, target.ino)) || insideFollowed(real)) continue // already counted once
        takeOn(real, target)
        if (isDir) state.pending.push({ dir: real, followOnly: true, hops: item.hops + 1 })
        else count(target, false)
      } else if (st.isDirectory()) {
        if (st.dev !== state.rootDev) continue // a mount point: not crossed
        count(st, !item.followOnly)
        if (item.followOnly && followedIno.has(followedKey(st.dev, st.ino))) continue // a target followed on its own: its contents are counted by its own walk, its entry here
        state.pending.push({ dir: p, followOnly: item.followOnly, hops: item.hops })
      } else {
        count(st, !item.followOnly)
      }
    }
  }
  state.elapsedMs += Date.now() - t0
  return state.pending.length === 0
}
