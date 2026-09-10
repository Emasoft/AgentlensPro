// src/cli/reviewGateEffects.ts — WHAT the review gate sees as unreviewed (TRDD-9FG0LSPG).
//
// Stateless by design: everything here is recomputed from `sinceMs` (the last-fork timestamp
// the caller passes in) at every Stop. No stored fingerprint, no cross-Stop refresh invariant —
// the design review (§Design, TRDD-9FG0LSPG) rejected that shape for its silent-release holes
// (a worker write landing between Stops, a missing snapshot after `/clear`, a timed-out walk).
// A path is "unreviewed" here purely because its mtime (or HEAD's commit time) is newer than the
// last review fork — whatever wrote it: a worker subagent, a script, a fork, or `git commit`.
// Since TRDD-3U8AIHXK the caller also passes the session's tool-activity intervals, and a
// path counts only if its mtime falls inside one — a write nobody in this session could have made
// (another session's guard, a plugin update, a server regenerating an agent file) is not ours to review.
//
// Known evasions, stated rather than hidden: `touch -t` and `GIT_COMMITTER_DATE` can backdate an
// mtime or a commit past `sinceMs` and slip through. Accepted — closing this needs content
// hashing, which is out of scope for a per-Stop hook that must stay fast.

import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export interface EffectsOptions { home?: string; watched?: string[]; maxEntries?: number; activity?: Activity[] }
export interface Effects { paths: string[]; truncated: boolean }

/** One span during which THIS session's tools were running — the only time its own writes
 *  (foreground tools, workers, scripts, background jobs) can land. `end` is `Infinity` while the
 *  tool has not reported back: fail closed, everything after `start` counts as ours. */
export interface Activity { start: number; end: number }
/** mtimes and transcript timestamps come from the same clock; git times are whole seconds. */
export const ATTRIBUTION_SLACK_MS = 1000
/** "Newer than the last fork AND written while one of this session's tools was running"
 *  (TRDD-3U8AIHXK). With no `activity` (a caller or test of the walk alone) the second half is
 *  vacuously true — the pre-3U8AIHXK behaviour, which arms on every writer on the machine. */
function freshness(sinceMs: number, activity: Activity[] | undefined): (ms: number) => boolean {
  return (ms) => ms > sinceMs && (activity === undefined
    || activity.some((a) => ms >= a.start - ATTRIBUTION_SLACK_MS && ms <= a.end + ATTRIBUTION_SLACK_MS))
}

/** Parses `git log -g -1 --date=unix --format=%gd HEAD` output into epoch milliseconds, or
 *  `null` when the shape isn't the expected `...@{<epoch-seconds>}` — e.g. the bare ordinal
 *  form `HEAD@{0}` that git prints when `--date` isn't honored for some reason, or an empty/
 *  unrelated string. `null` here means "fall back to `%ct`, exactly as an empty reflog would"
 *  — a guard so a surprise format never fails OPEN by treating an ordinal like `0` as a real
 *  timestamp and silently missing a HEAD move. Requires 9+ digits so a plausible near-term
 *  epoch second (10 digits today) is never confused with a small ordinal. */
export function reflogEpochMs(output: string): number | null {
  const m = /@\{(\d{9,})\}/.exec(output)
  return m ? Number(m[1]) * 1000 : null
}

/** Paths the gate must never arm on just because a watch rebuild touched them. */
export const BUILD_OUTPUT: RegExp[] = [/^standalone\/[^/]+\.js$/, /^media\/[^/]+\.(js|css)$/, /^out\//]

const DEFAULT_MAX_ENTRIES = 100000
// Never descend into these — node_modules/.git churn constantly and carry no reviewable work;
// memgrep's own sidecars are excluded by name pattern (checked per-file below, not here).
const SKIP_DIRS = new Set(['node_modules', '.git'])
const isMemgrepSidecar = (name: string): boolean =>
  /\.sqlite(-.*)?$/.test(name) || name.startsWith('.memgrep')

/** Shared mutable walk state so the recursive directory walk and the flat watched-entry loop
 *  stop at the exact same `maxEntries` boundary and report one `truncated` flag.
 *  `guardRoots` are canonical paths a followed symlink must never resolve to (or contain) —
 *  cwd, home, and every watched root — so a symlink pointing at `~` or `/` can't turn the
 *  bounded one-level follow into an unbounded walk of the whole machine. */
interface WalkState {
  paths: string[]; visited: number; maxEntries: number; truncated: boolean; guardRoots: string[]
  fresh: (ms: number) => boolean
  // Absolute directory paths never descended into — hook RUNTIME state, not config.
  excluded: Set<string>
}

/** True when `target` (a canonical/realpath'd directory) equals or CONTAINS any of `guardRoots`
 *  — i.e. following into `target` would walk into cwd, home, or a watched root. */
function targetContainsGuardRoot(target: string, guardRoots: string[]): boolean {
  return guardRoots.some((root) => {
    const rel = path.relative(target, root)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  })
}

function walkDir(dir: string, state: WalkState, depth = 0): void {
  if (state.truncated) return
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    state.visited++
    if (state.visited > state.maxEntries) { state.truncated = true; return }
    const full = path.join(dir, e.name)
    if (e.isSymbolicLink()) {
      // Follow a symlink ONLY at depth 0 (a direct child of the dir this call started from) —
      // e.g. a symlinked skill dir under ~/.claude/skills/, common on this machine, would
      // otherwise never be walked and its link's own mtime never changes when the target does.
      // Bounded to one level: the recursive call below passes depth+1, so a symlink nested
      // inside the followed target is still skipped. Still an evasion (a symlink chain can hide
      // content past the bound), but a bounded one, same spirit as the old blanket skip.
      if (depth !== 0) continue
      let target: fs.Stats
      try { target = fs.statSync(full) } catch { continue } // dangling link — skip, never throw
      if (target.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        // A symlink resolving to (or containing) cwd/home/a watched root would turn the
        // bounded one-level follow into an unbounded walk of the whole tree — hit maxEntries
        // and re-arm the gate on every Stop forever. realpathSync is wrapped: a broken link
        // or a permission error must be skipped, never an uncaught throw (that would be a
        // silent allow in the calling hook).
        let real: string
        try { real = fs.realpathSync(full) } catch { continue }
        if (targetContainsGuardRoot(real, state.guardRoots)) continue
        walkDir(full, state, depth + 1)
        if (state.truncated) return
      } else if (target.isFile() && !isMemgrepSidecar(e.name)) {
        if (state.fresh(target.mtimeMs)) state.paths.push(full)
      }
      continue
    }
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      // ~/.claude/hooks/state/ is the checkout guard's append-only ledger, written for EVERY
      // session's checkouts — runtime state, never config (TRDD-3U8AIHXK, reports 1 and 4).
      if (state.excluded.has(full)) continue
      walkDir(full, state, depth + 1)
      if (state.truncated) return
    } else if (e.isFile() && !isMemgrepSidecar(e.name)) {
      let st: fs.Stats
      try { st = fs.lstatSync(full) } catch { continue }
      if (state.fresh(st.mtimeMs)) state.paths.push(full)
    }
  }
}

/** The watched set: config/rules/skills/etc. outside the repo whose edit is reviewable work even
 *  though it never shows up in `git status` for `cwd`. Deliberately NOT walked: the rest of
 *  `~/.claude/projects/<slug>/` (session transcripts churn every turn — walking them would arm on
 *  every turn) and `~/.claude/plugins/data/**` (janitor's own runtime state, not user work). */
export function defaultWatchedSet(cwd: string, home: string): string[] {
  const out = [
    path.join(home, '.claude', 'CLAUDE.md'),
    path.join(home, '.claude', 'settings.json'),
    path.join(home, '.claude', 'settings.local.json'),
    path.join(home, '.claude', 'keybindings.json'),
    path.join(home, '.claude', 'rules'),
    path.join(home, '.claude', 'skills'),
    path.join(home, '.claude', 'agents'),
    path.join(home, '.claude', 'hooks'),
    path.join(home, '.claude', 'commands'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json'),
    path.join(cwd, '.mcp.json'),
    path.join(home, '.codex', 'config.toml'),
    path.join(home, '.zshrc'),
    path.join(home, '.zprofile'),
  ]

  // Launch agents: one bounded readdir, files only — no recursion needed, the dir is flat.
  const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents')
  try {
    for (const e of fs.readdirSync(launchAgentsDir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.plist')) out.push(path.join(launchAgentsDir, e.name))
    }
  } catch { /* no LaunchAgents dir on this machine */ }

  // Plugin-cache hook registrations: `<home>/.claude/plugins/cache/<marketplace>/<plugin>/<version>/hooks/hooks.json`
  // — three bounded readdirs by construction, never a recursive walk.
  const cacheDir = path.join(home, '.claude', 'plugins', 'cache')
  try {
    for (const marketplace of fs.readdirSync(cacheDir, { withFileTypes: true })) {
      if (!marketplace.isDirectory()) continue
      const mDir = path.join(cacheDir, marketplace.name)
      let plugins: fs.Dirent[]
      try { plugins = fs.readdirSync(mDir, { withFileTypes: true }) } catch { continue }
      for (const plugin of plugins) {
        if (!plugin.isDirectory()) continue
        const pDir = path.join(mDir, plugin.name)
        let versions: fs.Dirent[]
        try { versions = fs.readdirSync(pDir, { withFileTypes: true }) } catch { continue }
        for (const version of versions) {
          if (version.isDirectory()) out.push(path.join(pDir, version.name, 'hooks', 'hooks.json'))
        }
      }
    }
  } catch { /* no plugin cache on this machine */ }

  // LOCAL memory + design for THIS project only — the reviewable subset of the project's slug dir.
  const slug = cwd.replace(/[^A-Za-z0-9]/g, '-')
  out.push(path.join(home, '.claude', 'projects', slug, 'memory'))
  out.push(path.join(home, '.claude', 'projects', slug, 'design'))
  return out
}

function walkWatched(entries: string[], state: WalkState): void {
  for (const entry of entries) {
    if (state.truncated) return
    let st: fs.Stats
    try { st = fs.lstatSync(entry) } catch { continue } // missing entry — skip silently
    if (st.isSymbolicLink()) {
      // A watched root itself may be a symlink — follow it ONE level (same bound as walkDir).
      // One level is already spent on this hop, so the directory case starts its own walk at
      // depth 1: a symlink among ITS direct children is still skipped, never deeper.
      let target: fs.Stats
      try { target = fs.statSync(entry) } catch { continue } // dangling link — skip, never throw
      if (target.isDirectory()) {
        let real: string
        try { real = fs.realpathSync(entry) } catch { continue }
        if (targetContainsGuardRoot(real, state.guardRoots)) continue
        walkDir(entry, state, 1)
      } else if (target.isFile()) {
        state.visited++
        if (state.visited > state.maxEntries) { state.truncated = true; return }
        if (state.fresh(target.mtimeMs)) state.paths.push(entry)
      }
      continue
    }
    if (st.isDirectory()) {
      walkDir(entry, state)
    } else if (st.isFile()) {
      state.visited++
      if (state.visited > state.maxEntries) { state.truncated = true; return }
      if (state.fresh(st.mtimeMs)) state.paths.push(entry)
    }
  }
}

/** git status --porcelain=v1 -z entries: `XY path\0` normally, but a rename/copy (X or Y is
 *  `R`/`C`) is followed by a SEPARATE NUL-terminated field carrying the old path — consumed and
 *  discarded here, per §Design ("take the first field's path, i.e. the new one"). */
// A deletion has no mtime of its own — POSIX unlink/rmdir bumps the PARENT directory's mtime
// instead, so use that as the deletion's "when it happened". Without this, an uncommitted
// deletion re-arms the gate at EVERY Stop forever: fork sees the delete, Stop, same delete is
// still `D` in `git status` with no mtime to compare, so the naive rule ("always keep") flags
// it again next Stop, and the one after that — a livelock the deletion never escapes short of
// a commit.
//
// `path.dirname(rel)` itself may no longer exist — a whole-directory removal (`git rm -r dir/`,
// `rm -r dir`) deletes the parent along with the file. Stat-fails-so-keep at that level would
// just re-create the same livelock one directory up, so climb to the nearest EXISTING ancestor
// (bounded at `cwd`, which always exists for a git work tree) and key off ITS mtime instead —
// that is the directory whose rmdir/unlink call actually landed most recently.
//
// No same-second tolerance here (unlike the HEAD reflog/`%ct` comparison below): APFS (and
// ext4/NTFS) directory mtimes are nanosecond-resolution, not whole-second, so `>` alone is
// exact.
function deletionStillUnreviewed(cwd: string, rel: string, fresh: (ms: number) => boolean): boolean {
  const cwdResolved = path.resolve(cwd)
  let dir = path.dirname(path.resolve(cwd, rel))
  for (;;) {
    try {
      return fresh(fs.lstatSync(dir).mtimeMs)
    } catch {
      if (dir === cwdResolved) return true // even cwd itself failed to stat — fail closed
      const parent = path.dirname(dir)
      if (parent === dir) return true // hit the filesystem root without finding cwd — fail closed
      dir = parent
    }
  }
}

function inRepoEffects(cwd: string, fresh: (ms: number) => boolean): string[] {
  let statusOut: string
  try {
    statusOut = execFileSync(
      'git', ['-C', cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { encoding: 'utf8' },
    )
  } catch {
    process.stderr.write(`[review-gate] effects: ${cwd} is not a git work tree; in-repo changes unobserved\n`)
    return []
  }

  const paths: string[] = []
  const fields = statusOut.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]
    if (entry === '') continue
    const xy = entry.slice(0, 2)
    const rel = entry.slice(3)
    if (/[RC]/.test(xy)) i++ // discard the accompanying old-path field of a rename/copy
    // `rel` is relative to `cwd` (`git -C cwd status`), so this match assumes the hook cwd IS the
    // repo root — true for a session opened at the repo root, which is how this project's
    // sessions are opened (not measured from the hook). From a subdirectory `rel` would read
    // `../standalone/x.js`, the exclusion would miss and a watch rebuild would arm once: fail
    // closed, not open (the mtime check below resolves against cwd and is unaffected).
    if (BUILD_OUTPUT.some((re) => re.test(rel))) continue
    if (xy.includes('D')) { // deletion: no mtime of its own — key off the parent dir's mtime
      if (deletionStillUnreviewed(cwd, rel, fresh)) paths.push(rel)
      continue
    }
    try {
      const st = fs.lstatSync(path.resolve(cwd, rel))
      if (fresh(st.mtimeMs)) paths.push(rel)
    } catch {
      // stat failed (e.g. ENOENT) — same "no mtime of its own" situation as a `D` entry above.
      if (deletionStillUnreviewed(cwd, rel, fresh)) paths.push(rel)
    }
  }

  try {
    const ct = execFileSync('git', ['-C', cwd, 'log', '-1', '--format=%ct'], { encoding: 'utf8' }).trim()
    if (ct !== '') {
      let headSec = Number(ct)
      // %ct alone only catches a commit NEWER than sinceMs. A worker running `git checkout
      // <older-commit>` or `git reset --hard HEAD~1` moves HEAD to an OLDER commit and is
      // missed entirely. The reflog's last entry records the move regardless of direction —
      // prefer it, falling back to %ct when the reflog is empty/unavailable.
      try {
        const reflog = execFileSync(
          'git', ['-C', cwd, 'log', '-g', '-1', '--date=unix', '--format=%gd', 'HEAD'],
          { encoding: 'utf8' },
        ).trim()
        const epochMs = reflogEpochMs(reflog)
        if (epochMs !== null) headSec = epochMs / 1000
      } catch { /* no reflog yet — fall back to %ct */ }
      // Both git timestamps are whole SECONDS; round up one full second before comparing so a
      // move landing in the same wall-clock second as the fork is never missed.
      if (fresh((headSec + 1) * 1000)) paths.push('HEAD')
    }
  } catch { /* empty repo — no HEAD yet, skip silently */ }

  return paths
}

/** Paths changed on disk strictly after `sinceMs` (epoch ms) that no review fork has covered. */
export function unreviewedEffects(cwd: string, sinceMs: number, opts: EffectsOptions = {}): Effects {
  const fresh = freshness(sinceMs, opts.activity)
  const paths = inRepoEffects(cwd, fresh)

  const home = opts.home ?? os.homedir()
  const watched = opts.watched ?? defaultWatchedSet(cwd, home)
  const guardRoots = [path.resolve(cwd), path.resolve(home), ...watched.map((w) => path.resolve(w))]
  const state: WalkState = {
    paths: [], visited: 0, maxEntries: opts.maxEntries ?? DEFAULT_MAX_ENTRIES, truncated: false, guardRoots,
    fresh, excluded: new Set([path.join(home, '.claude', 'hooks', 'state')]),
  }
  walkWatched(watched, state)

  return { paths: paths.concat(state.paths), truncated: state.truncated }
}
