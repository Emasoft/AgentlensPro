// src/cli/diskWatch.ts — which folders the disk monitor measures (TRDD-HTARKH87).
//
// Stored rows (disk_watch, edited with `agentlenspro disk-watch`) plus trash folders discovered on every
// run: a drive plugged in after install has a `.Trashes/<uid>` the seed list could not have known, and
// "with and without the trashbin" must hold for it too.

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { dataDir } from "../dataDir"

export type WatchKind = "folder" | "trash"

export interface WatchEntry {
  path: string
  kind: WatchKind
  /** `stored` = a disk_watch row; `auto` = discovered this run, never written. */
  source: "stored" | "auto"
}

const TRASHCAN_DEPTH = 3
const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "target", "dist", "build"])

/** `.trashcan/` directories (the janitor's safe-delete staging) under `root`, at most `depth` levels down. */
export function findTrashcans(root: string, depth = TRASHCAN_DEPTH): string[] {
  const found: string[] = []
  const walk = (dir: string, level: number): void => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const p = path.join(dir, e.name)
      if (e.name === ".trashcan") found.push(p)
      else if (level < depth && !SKIP_DIRS.has(e.name)) walk(p, level + 1)
    }
  }
  walk(root, 1)
  return found
}

/** Seed list for a brand-new disk.duckdb: the places disk space actually goes on a dev machine, plus every trash. */
export function defaultWatch(): { path: string; kind: WatchKind }[] {
  const home = os.homedir()
  // `~` itself is NOT seeded (the spec listed it): its walk was still unfinished after ~27 runs of 40 s, with *_follow totals about 2x the plain totals and a
  // pending stack made of followed-symlink directories (which link leads there was not identified), and it overlaps ~/Library/Caches and the data dir. Opt in with: agentlenspro disk-watch add ~
  const folders = [path.join(home, "Code"), dataDir(), path.join(home, "Library", "Caches")]
  const trashes = [path.join(home, ".Trash"), ...findTrashcans(path.join(home, "Code"))]
  return [
    ...folders.filter(p => fs.existsSync(p)).map(p => ({ path: p, kind: "folder" as const })),
    ...trashes.filter(p => fs.existsSync(p)).map(p => ({ path: p, kind: "trash" as const })),
  ]
}

/** The `.Trashes/<uid>` folder of every mounted volume under /Volumes that has one. */
export function volumeTrashes(): string[] {
  const uid = process.getuid?.()
  if (uid === undefined) return []
  let vols: string[]
  try { vols = fs.readdirSync("/Volumes") } catch { return [] }
  return vols.map(v => path.join("/Volumes", v, ".Trashes", String(uid))).filter(p => fs.existsSync(p))
}

/** Stored rows plus the auto-discovered volume trashes, deduplicated by path (a stored row wins). */
export function effectiveWatch(stored: readonly { path: string; kind: WatchKind }[]): WatchEntry[] {
  const out: WatchEntry[] = stored.map(s => ({ ...s, source: "stored" as const }))
  const have = new Set(out.map(e => e.path))
  for (const p of volumeTrashes()) if (!have.has(p)) out.push({ path: p, kind: "trash", source: "auto" })
  return out
}
