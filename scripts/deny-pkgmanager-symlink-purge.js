#!/usr/bin/env node
// PreToolUse(Bash) guard: refuse a package-manager invocation whose `node_modules` RESOLVES
// OUTSIDE the checkout it is running in.
//
// WHY THIS EXISTS. On 2026-09-03, verifying that a commit stood on its own meant checking it out
// with `git worktree` (`git stash` is unsafe on this machine — global hooks destroy uncommitted
// work). To skip a slow install, the main repo's node_modules was symlinked into the worktree.
// The next `cd <worktree> && pnpm run compile-tests` ran pnpm's dependency reconciliation, which
// decided the modules directory was wrong and tried to PURGE it — following the symlink to the
// REAL node_modules. It stopped only because no TTY was attached:
//
//     ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY
//     If you are running pnpm in CI, set the CI environment variable to "true", or set
//     "confirmModulesPurge" to "false".
//
// The error's own suggested remedy removes the last protection. An agent following the error text
// — the normal, cooperative response — deletes the repository's dependencies.
//
// WHAT IS ACTUALLY GUARDED: the BLAST RADIUS, not pnpm's decision to purge. An early draft keyed
// on `islink`, which was wrong — pnpm's purge fires on a config/lockfile mismatch
// (`confirmModulesPurge`) and never consults linkage, so a stale REAL node_modules is purged too.
// But a purge confined to the tree destroys only reinstallable files. The damage requires the
// removal to ESCAPE the checkout, so the predicate is realpath containment against the checkout
// root — and leaves the contained case (correctly) alone.
//
// UNMEASURED: containment SHOULD also catch a bind-mount or any other escape a symlink test would
// miss, because realpath resolves them. That has never been tested — every run has been on darwin,
// which has no Linux-style bind mounts — so treat it as a property of the predicate's shape, not as
// a verified behaviour.
//
// The destructive target never appears in the command text — `pnpm run compile-tests` names no
// path — so this cannot be an argument matcher like the `rm -rf` guards. It has to inspect the
// filesystem at the effective cwd.
//
// EFFECTIVE CWD, not the session cwd. The real incident was `cd /tmp/<worktree> && pnpm run ...`
// issued from a session sitting in the repo, so reading only the session cwd would have missed it.
// A leading `cd <path>` in the same segment is honoured.
//
// Deliberately NOT a deny for package managers in a worktree generally: `pnpm install` inside a
// worktree with no symlink is the correct fix this guard wants people to reach for, and a guard
// that blocks the remedy teaches people to disable it.
//
// WHAT THIS DOES NOT COVER — read before relying on it. The matcher fires on the COMMAND WORD, so
// it sees a direct `pnpm`/`npm`/`yarn`/`bun` invocation and nothing else. Measured 2026-09-03
// against the escaping-symlink fixture:
//
//     cd <wt> && pnpm install     DENY        cd <wt> && make test          allow
//     cd <wt> && npm test         DENY        cd <wt> && ./scripts/ci.sh    allow
//     cd <wt> && npx pnpm i       DENY        cd <wt> && node esbuild.js    allow
//     pushd <wt> && pnpm i        DENY        cd <wt> & pnpm install        allow (correct:
//     ( cd <wt> && pnpm i )       DENY          `&` backgrounds the cd, pnpm runs elsewhere)
//
// This table is a record of PROBES, not a proof of coverage: the allow column is the routes I
// thought to try, and the space of ways to reach a package manager is open-ended.
//
// So a package manager reached through a Makefile, a shell script, a node script, or a lifecycle
// hook runs unguarded. This covers the shape the accident actually took — a human or agent typing
// the command — which is also the most likely way it recurs, but it is ONE command shape of one
// risk, NOT machine-wide protection against the hazard. Saying otherwise would create exactly the
// false confidence that gets someone to symlink node_modules into a worktree and run `make test`.
//
// The stronger predicate, if this proves insufficient: refuse to CREATE a scratch checkout whose
// node_modules escapes, rather than policing every command afterwards. One check, no command-shape
// dependency, covers every route. Recorded in TRDD-SVCUAPES.

const fs = require('fs')
const path = require('path')

// Any package manager that reconciles a modules directory. Compared by BASENAME so `pnpm`,
// `/opt/homebrew/bin/pnpm` and `corepack pnpm` all match.
const MANAGERS = new Set(['pnpm', 'npm', 'yarn', 'bun'])

// Words that PRECEDE the real command word and must be stepped over to find it. Every one is a
// measured gap, not a guess: on 2026-09-03 `time`/`exec`/`command`/`nice`/`sudo pnpm install` all
// slipped through, because the command word was the launcher. An earlier round DELETED three of
// these as "speculative and unpinned" — that was wrong. They are ordinary shell idioms, and
// removing them traded an untested claim for a silent false negative. The whole set is exercised
// by one matrix case, so none of them is a claim without a check.
// `sudo` is here deliberately: a root-privileged purge is the WORST case, not an exempt one, so the
// guard must see through it rather than treat `sudo` as an unknown command and stand aside.
const LAUNCHERS = new Set(['env', 'corepack', 'npx', 'time', 'exec', 'command', 'nice', 'sudo'])

/** The command's effective working directory: an explicit `cd <path>` in the same segment wins
 *  over the session cwd, because that is the shape the real incident took. */
function effectiveCwd(segment, sessionCwd) {
  // `pushd` changes the directory exactly like `cd` for the command that follows; ignoring it
  // was a silent false NEGATIVE (measured 2026-09-03: `pushd <wt> && pnpm install` was allowed).
  const m = /(?:^|\s)(?:cd|pushd)\s+(?:--\s+)?(['"]?)([^'"&;|]+)\1(?:\s|$)/.exec(segment)
  if (!m) return sessionCwd
  const target = m[2].trim()
  if (!target || target === '-') return sessionCwd
  const expanded = target.startsWith('~') ? path.join(process.env.HOME || '', target.slice(1)) : target
  return path.isAbsolute(expanded) ? expanded : path.resolve(sessionCwd, expanded)
}

/** The project root `dir` belongs to: the nearest ancestor carrying a DEFINITIVE root marker —
 *  `.git` (a dir in a clone, a FILE in a worktree), `pnpm-workspace.yaml`, or a package.json that
 *  declares `"workspaces"`. Null when none is found; the caller then falls back to the cwd.
 *
 *  This, not the cwd, is the boundary that matters: a purge confined to the tree you are working in
 *  destroys only reinstallable files, and the fix this guard steers people toward (`pnpm install`
 *  right there) must stay allowed. In a monorepo `packages/a`'s node_modules links into the store
 *  at the WORKSPACE root, so anchoring on the package would make that legitimate link an escape and
 *  deny every command in the repo — measured 2026-09-03 for a workspace that is not a git checkout.
 *
 *  Why only definitive markers, and never a bare package.json: it appears in every package of a
 *  monorepo AND in stray places like `~/package.json`. Accepting it made the boundary the outermost
 *  such ancestor, so on a machine with a home-directory package.json every non-git tree beneath it
 *  got `$HOME` as its boundary — and an escape into a sibling project's node_modules was ALLOWED,
 *  which is the original incident re-enabled. Measured 2026-09-03. */
function checkoutRoot(dir) {
  let cur = path.resolve(dir)
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur
    if (fs.existsSync(path.join(cur, 'pnpm-workspace.yaml'))) return cur
    // npm/yarn workspaces declare the root inside package.json instead of a sibling file.
    // PARSED, never regex-matched. A text match on `"workspaces"` also hits a dependency named
    // `workspaces` or the word inside any string, and a false positive here WIDENS the boundary —
    // the same failure that let an escape into a sibling project be allowed. Parsing is shorter and
    // has no such surface; an unparseable file is simply not a root claim.
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cur, 'package.json'), 'utf8'))
      if (pkg && pkg.workspaces) return cur
    } catch { /* absent or unreadable package.json is not a root claim */ }
    const parent = path.dirname(cur)
    if (parent === cur) return null // no root found: caller falls back to the cwd
    cur = parent
  }
}

/** The node_modules a manager running in `dir` would reconcile, if it RESOLVES OUTSIDE the
 *  checkout. Returns {link, target, root} or null.
 *
 *  Keyed on realpath containment, NOT on `islink`. Two reasons, both learned the hard way:
 *  - pnpm's purge decision is about config mismatch (`confirmModulesPurge`) and never consults
 *    linkage, so `islink` describes the blast radius, not the trigger. Containment describes the
 *    blast radius directly and also covers a bind-mount or any other escape.
 *  - The boundary MUST be the checkout root, not the cwd. In a pnpm workspace a package's own
 *    `node_modules` resolves into the root store — outside that package dir but inside the
 *    checkout. Anchoring on the cwd would deny every pnpm command in every workspace repo, which
 *    at user scope means every project on the machine. A guard that reddens on correct work gets
 *    disabled, and then it protects nothing. */
function escapingModules(dir) {
  // No `.git` ancestor is NOT a reason to allow: a plain scratch dir, an extracted tarball or a
  // `cp -r` of a project can all hold an escaping node_modules, and that is the original incident
  // with one file removed. Fall back to the cwd as the boundary — the workspace false positive that
  // forced the checkout-root anchor only arises INSIDE a checkout, so this cannot resurrect it.
  const root = checkoutRoot(dir) ?? path.resolve(dir)
  let realRoot
  try { realRoot = fs.realpathSync(root) } catch { return null }
  let cur = path.resolve(dir)
  for (;;) {
    const link = path.join(cur, 'node_modules')
    if (fs.existsSync(link)) {
      let target
      try { target = fs.realpathSync(link) } catch { return null }
      const inside = target === realRoot || target.startsWith(realRoot + path.sep)
      return inside ? null : { link, target, root }
    }
    if (cur === root) return null
    const parent = path.dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

let raw = ''
process.stdin.on('data', (d) => { raw += d })
process.stdin.on('end', () => {
  let cmd = ''
  // Lazy, and never at module scope: `process.cwd()` THROWS (ENOENT: uv_cwd) when the session's
  // directory has been deleted — which is exactly what happens after a worktree is removed while a
  // shell sits in it, the very workflow this guard exists for. Evaluating it eagerly would crash
  // the hook on every call in that state.
  let sessionCwd = ''
  const safeCwd = () => { try { return process.cwd() } catch { return '' } }
  try {
    const payload = JSON.parse(raw)
    cmd = String(payload?.tool_input?.command ?? '')
    sessionCwd = (typeof payload?.cwd === 'string' && payload.cwd) ? payload.cwd : safeCwd()
    if (!sessionCwd) process.exit(0) // no resolvable cwd: nothing to judge, allow
  } catch {
    // Unparseable payload: stay silent and let the call proceed. A guard that blocks every Bash
    // call because it could not read its own input is worse than the thing it guards against.
    process.exit(0)
  }

  // cwd CARRIES ACROSS SEGMENTS. The real incident was `cd <worktree> && pnpm run compile-tests`,
  // where the `cd` and the `pnpm` land in different segments — checking each segment in isolation
  // loses the `cd` entirely and the guard never fires on the one command it was written for.
  //
  // A `cd` carries only across separators that mean "the cd RAN and we are still in that shell":
  // `;`, `&&`, newline. It must NOT carry across `||` (the right side runs only when the left
  // FAILED, so the cd did not happen) or out of a subshell `( … )` (whose cd never affects the
  // parent). Measured 2026-09-03: carrying unconditionally denied `cd /tmp/wt || pnpm install` and
  // `( cd /tmp/wt && true ) ; pnpm install`, neither of which enters that directory. At user scope
  // a false positive on a package-manager command is what gets a guard switched off, so the
  // conservative direction here is to FORGET the cd, not to keep it.
  // A subshell INHERITS the current directory and discards its own `cd` on exit, so `(` PUSHES and
  // `)` POPS — it must not reset. Resetting on `(` was wrong in the other direction: it threw away
  // a cd that was genuinely in effect, so `cd <wt> ; ( pnpm install )` went from deny to allow.
  // Braces `{ …; }` are not a subshell at all — they run in the current shell, so they neither
  // push nor reset; they are split out only so `{` cannot be mistaken for the command word.
  let dir = sessionCwd
  const stack = []
  const parts = cmd.split(/(\|\||&&|[;&|\n]|[(){}])/)
  for (const part of parts) {
    if (part === '(') { stack.push(dir); continue }
    if (part === ')') { dir = stack.length ? stack.pop() : sessionCwd; continue }
    if (part === '{' || part === '}') continue
    // A `cd` carries ONLY across separators meaning "it ran and we are still in that shell".
    // `||` runs the right side only if the left FAILED; a bare `&` backgrounds the cd in its own
    // subshell; a `|` stage is a subshell too. All three leave the parent's cwd unchanged, so a
    // carried `dir` would deny a command that never enters it — measured 2026-09-03 for `&`.
    if (part === '||' || part === '&' || part === '|') { dir = sessionCwd; continue }
    if (/^(?:&&|[;\n])$/.test(part)) continue
    const trimmed = part.trim()
    if (!trimmed) continue
    dir = effectiveCwd(trimmed, dir)

    // Only the COMMAND WORD counts, never any token. Matching anywhere makes prose match: with
    // quotes stripped, `echo "pnpm run build"` and `git commit -m "fix pnpm guard"` both contain a
    // bare `pnpm`. Leading `VAR=value` assignments and the `env`/`corepack`/`npx` launchers are
    // skipped so the real command word is found underneath them — all three are exercised by one
    // matrix case. `command`/`exec`/`time` were listed here speculatively and are now REMOVED: an
    // entry no case pins is a claim the comment makes and nothing backs, which is the exact defect
    // this file has already shipped twice (the comment listed `npx` while the array did not).
    const tokens = trimmed.split(/\s+/)
    let i = 0
    while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || LAUNCHERS.has(tokens[i]))) i++
    const word = tokens[i]
    // A quoted command word is not a command word — it is prose inside someone's argument.
    if (!word || /^['"]/.test(word)) continue
    if (!MANAGERS.has(word.split('/').pop())) continue
    let hit = null
    // NEVER let this guard raise. An exception in a PreToolUse hook can take the whole guard
    // out — including any protection it shares a process with — and the session keeps looking
    // normal. Fail OPEN, loudly on stderr, never silently and never closed.
    try { hit = escapingModules(dir) } catch (e) {
      process.stderr.write(`[deny-pkgmanager-symlink-purge] check failed, allowing: ${e.message}\n`)
    }
    if (!hit) continue

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `Blocked a package-manager command in ${dir}: node_modules resolves to ${hit.target}, `
          + `OUTSIDE the checkout at ${hit.root}. pnpm/npm/yarn reconcile the modules directory `
          + 'and may REMOVE it — following the link and destroying the real one. Measured '
          + '2026-09-03: `pnpm run` attempted exactly this and aborted only because no TTY was '
          + 'attached; its error suggests CI=true, which removes that protection. '
          + 'Instead: run a real install in this directory, or invoke the tool directly '
          + '(node_modules/.bin/tsc, node_modules/.bin/mocha) which skips the deps check. '
          + 'Guard: deny-pkgmanager-symlink-purge.js (user scope: ~/.claude/hooks/; source: <repo>/scripts/)',
      },
    }))
    process.exit(0)
  }
  process.exit(0)
})
