#!/usr/bin/env node
// Matrix for scripts/deny-pkgmanager-symlink-purge.js. Builds REAL directories with REAL symlinks
// in a tmpdir — the guard's whole job is a filesystem judgement, so a mocked fs would test nothing.
//
// The load-bearing cases: an ESCAPING symlink is denied, a real directory is ALLOWED (nothing
// outside the tree can be lost, and denying it would block the very `pnpm install` that fixes the
// hazard), and the `cd <worktree> && pnpm …` shape is caught — that is the exact command that
// caused the 2026-09-03 near-miss, and reading only the session cwd would miss it.

const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const GUARD = path.join(__dirname, 'deny-pkgmanager-symlink-purge.js')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-pm-'))

// A "real repo" with a real node_modules, and a "worktree" whose node_modules links back to it.
// Both carry a `.git` because the guard's boundary is the CHECKOUT root: a dir in a clone, a FILE
// in a worktree — the fixture uses one of each so both spellings are exercised.
const repo = path.join(root, 'repo')
const worktree = path.join(root, 'worktree')
const nested = path.join(worktree, 'packages', 'inner')
fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true })
fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
fs.mkdirSync(nested, { recursive: true })
fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'w')}\n`)
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(worktree, 'node_modules'))

// A directory whose node_modules is a symlink that stays INSIDE the checkout — not an escape.
const selfLink = path.join(root, 'selflink')
fs.mkdirSync(path.join(selfLink, 'real'), { recursive: true })
fs.mkdirSync(path.join(selfLink, '.git'), { recursive: true })
fs.symlinkSync(path.join(selfLink, 'real'), path.join(selfLink, 'node_modules'))

// THE FALSE-POSITIVE CASE THAT KILLED THE FIRST DESIGN. A pnpm workspace: each package's own
// node_modules links into the ROOT store. That escapes the package dir but stays inside the
// checkout, and it is the normal layout of every pnpm monorepo. An earlier predicate anchored on
// the cwd denied it — which at user scope would have blocked pnpm in every workspace repo on the
// machine, and a guard that reddens on correct work gets disabled.
const ws = path.join(root, 'workspace')
const wsPkg = path.join(ws, 'packages', 'a')
fs.mkdirSync(path.join(ws, 'node_modules', '.pnpm', 'dep'), { recursive: true })
fs.mkdirSync(path.join(ws, '.git'), { recursive: true })
fs.mkdirSync(wsPkg, { recursive: true })
fs.symlinkSync(path.join(ws, 'node_modules', '.pnpm', 'dep'), path.join(wsPkg, 'node_modules'))

// NO .git ANYWHERE: a plain scratch dir, an extracted tarball, a `cp -r` of a project. This is the
// original incident with one file removed, and it was ALLOWED until the checkout-root fallback.
const bare = path.join(root, 'bare-scratch')
fs.mkdirSync(bare, { recursive: true })
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(bare, 'node_modules'))

// A pnpm workspace that is NOT a git checkout — a vendored copy, a docker build context, an
// extracted tarball. Keying the boundary on `.git` alone denied every pnpm command here, which is
// the workspace false positive returning by another door (measured 2026-09-03, after the no-.git
// fallback was added). The boundary is the OUTERMOST project marker, so this stays allowed.
const wsNoGit = path.join(root, 'ws-nogit')
const wsNoGitPkg = path.join(wsNoGit, 'packages', 'a')
fs.mkdirSync(path.join(wsNoGit, 'node_modules', '.pnpm', 'dep'), { recursive: true })
fs.mkdirSync(wsNoGitPkg, { recursive: true })
fs.writeFileSync(path.join(wsNoGit, 'package.json'), '{}')
fs.writeFileSync(path.join(wsNoGit, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
fs.writeFileSync(path.join(wsNoGitPkg, 'package.json'), '{}')
fs.symlinkSync(path.join(wsNoGit, 'node_modules', '.pnpm', 'dep'), path.join(wsNoGitPkg, 'node_modules'))

// A STRAY ANCESTOR package.json must not widen the boundary. `~/package.json` is common, and
// accepting a bare package.json as a root made $HOME the boundary for every non-git dir beneath it
// — so an escape into a SIBLING project's node_modules under $HOME was allowed (measured
// 2026-09-03). Only .git / pnpm-workspace.yaml / a package.json declaring "workspaces" is a root.
const strayTop = path.join(root, 'stray')
const strayScratch = path.join(strayTop, 'scratch')
fs.mkdirSync(strayScratch, { recursive: true })
fs.mkdirSync(path.join(strayTop, 'sibling-nm'), { recursive: true })
fs.writeFileSync(path.join(strayTop, 'package.json'), '{}')   // NOT a workspace declaration
fs.symlinkSync(path.join(strayTop, 'sibling-nm'), path.join(strayScratch, 'node_modules'))

// An npm/yarn workspace: the root declares `workspaces` INSIDE package.json rather than in a
// sibling file. This branch of the boundary logic had no fixture and no mutation, so it was
// unpinned while the two beside it were verified — "all fixes pinned" was true of the mutations
// run, not of the code.
const npmWs = path.join(root, 'npm-workspace')
const npmWsPkg = path.join(npmWs, 'packages', 'a')
fs.mkdirSync(path.join(npmWs, 'node_modules', 'dep'), { recursive: true })
fs.mkdirSync(npmWsPkg, { recursive: true })
fs.writeFileSync(path.join(npmWs, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }))
fs.writeFileSync(path.join(npmWsPkg, 'package.json'), '{}')
fs.symlinkSync(path.join(npmWs, 'node_modules', 'dep'), path.join(npmWsPkg, 'node_modules'))

// A package.json that merely CONTAINS the word — a dependency named `workspaces`. A text match
// would treat this as a root and widen the boundary; parsing does not.
const fakeWs = path.join(root, 'fake-ws')
const fakeWsInner = path.join(fakeWs, 'inner')
fs.mkdirSync(fakeWsInner, { recursive: true })
fs.mkdirSync(path.join(fakeWs, 'sibling-nm'), { recursive: true })
fs.writeFileSync(path.join(fakeWs, 'package.json'), JSON.stringify({ dependencies: { workspaces: '^1.0.0' } }))
fs.symlinkSync(path.join(fakeWs, 'sibling-nm'), path.join(fakeWsInner, 'node_modules'))

const run = (command, cwd) => {
  const out = execFileSync('node', [GUARD], {
    input: JSON.stringify({ tool_input: { command }, cwd }),
    encoding: 'utf8',
  })
  return out.includes('permissionDecision') && out.includes('deny')
}

const cases = [
  // [expect deny, command, cwd, description]
  [true, 'pnpm run compile-tests', worktree, 'pnpm in a dir whose node_modules escapes'],
  [true, `cd ${worktree} && pnpm run compile-tests`, repo, 'THE REAL INCIDENT: cd into the worktree from the repo'],
  [true, `cd ${worktree} && npm ci`, repo, 'npm is guarded too'],
  [true, `cd ${worktree} && yarn install`, repo, 'yarn is guarded too'],
  [true, `cd ${worktree} && bun install`, repo, 'bun is guarded too'],
  [true, 'pnpm install', nested, 'nested dir inherits the escaping link by upward walk'],
  [true, '/opt/homebrew/bin/pnpm install', worktree, 'matched by basename, not by bare name'],
  [true, `cd '${worktree}' && pnpm i`, repo, 'quoted cd target'],

  [true, 'pnpm install', bare, 'NO .git: an escaping node_modules is still an escape'],
  [true, `cd ${worktree} && FOO=1 env corepack pnpm install`, repo, 'VAR= + env + corepack chain is skipped to reach the command word'],
  // Every launcher, one case: each was a measured false negative before it was in the set.
  ...['time', 'exec', 'command', 'nice', 'sudo', 'npx'].map((l) => (
    [true, `cd ${worktree} && ${l} pnpm install`, repo, `launcher '${l}' is stepped over, not mistaken for the command`]
  )),
  [true, 'pnpm install', fakeWsInner, 'a dependency NAMED workspaces is not a workspace root'],
  [true, 'pnpm install', strayScratch, 'a stray ancestor package.json must NOT widen the boundary'],

  [false, 'npm install', npmWsPkg, 'npm/yarn workspace: root declares workspaces IN package.json'],
  [false, 'pnpm install', wsNoGitPkg, 'workspace WITHOUT .git: still not an escape (outermost project marker)'],

  [false, 'pnpm install', repo, 'REAL node_modules is allowed — this is the remedy, never block it'],
  [false, 'pnpm install', selfLink, 'a symlink that stays inside the checkout is not an escape'],
  [false, 'pnpm install', root, 'no node_modules anywhere above: nothing to purge'],
  [false, 'pnpm install', wsPkg, 'PNPM WORKSPACE: package node_modules -> root store is normal, never deny'],
  [false, 'pnpm -r build', ws, 'workspace root itself'],
  [false, `cd ${worktree} && ls -l`, repo, 'non-package-manager command in the hazardous dir'],
  [false, `cd ${worktree} && node_modules/.bin/mocha`, repo, 'the SANCTIONED workaround must pass'],
  [false, `cd ${worktree} && node_modules/.bin/tsc -p tsconfig.test.json`, repo, 'ditto for tsc'],
  [false, `cd ${worktree} || pnpm install`, repo, 'cd FAILED branch: pnpm never enters the worktree'],
  [false, `( cd ${worktree} && true ) ; pnpm install`, repo, 'subshell cd does not affect the parent'],
  // SHELL-SEMANTICS ROW SET. Each expectation was verified against a REAL bash on 2026-09-03 by
  // printing the pwd the second command actually sees — not inferred from this guard's code, which
  // is what makes them capable of finding its bugs. They found four: `npx` missing from the
  // launcher skip-list, `&` denying a command that never enters the dir, `pushd` invisible, and a
  // reset-on-`(` that discarded a cd genuinely in effect.
  [true, `cd ${worktree} && npx pnpm install`, repo, 'npx launcher is skipped to reach the real command word'],
  [true, `pushd ${worktree} && pnpm install`, repo, 'pushd changes dir exactly like cd'],
  [true, `( cd ${worktree} && pnpm install )`, repo, 'whole command inside a subshell'],
  [true, `cd ${worktree} ; ( pnpm install )`, repo, 'a subshell INHERITS the parent cwd'],
  [true, `{ cd ${worktree} && pnpm install; }`, repo, 'a brace group runs in the CURRENT shell'],
  [false, `cd ${worktree} & pnpm install`, repo, '`&` backgrounds the cd: pnpm runs in the original dir'],
  [false, `cd ${worktree} | pnpm install`, repo, 'a pipe stage is a subshell: cwd does not propagate'],
  [false, 'echo "pnpm run build"', worktree, 'prose mentioning pnpm inside quotes'],
  [false, 'git commit -m "fix pnpm purge guard"', worktree, 'a commit message naming pnpm'],
]

let failed = 0
for (const [expectDeny, command, cwd, desc] of cases) {
  let got
  try { got = run(command, cwd) } catch (e) { console.log(`ERROR  ${desc}: ${e.message}`); failed++; continue }
  const ok = got === expectDeny
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${expectDeny ? 'deny ' : 'allow'}  ${desc}`)
}

// DRIFT GUARD. The live copy is installed at ~/.claude/hooks/ and is the one that actually runs;
// this repo copy is the source of truth. Nothing else links them, so without this assertion the two
// diverge silently and the tests go on passing against the copy nobody executes — the same shape as
// a stale bundle passing checks that never build it. Skipped (not failed) when no copy is installed,
// so this suite still passes on a machine that never ran the install.
// WARNS by default, FAILS only under GUARD_CHECK_INSTALL=1. `check-guards` runs from `compile`, and
// a build gate must assert properties of the REPO, not of one machine's config: making a stale
// install fail the build breaks the ordinary edit loop (edit guard -> compile fails -> sync ->
// compile), which is every iteration of guard work. The deploy path sets the env var; the build
// does not. Both files are compared — checking only the guard is how "both copies identical" got
// claimed on the evidence of one.
const enforce = process.env.GUARD_CHECK_INSTALL === '1'
for (const [label, local] of [['guard', GUARD], ['matrix', __filename]]) {
  const installed = path.join(os.homedir(), '.claude', 'hooks', path.basename(local))
  if (!fs.existsSync(installed)) {
    console.log(`SKIP  ----   ${label}: not installed at ~/.claude/hooks (nothing to drift from)`)
    continue
  }
  const same = fs.readFileSync(installed, 'utf8') === fs.readFileSync(local, 'utf8')
  if (!same && enforce) failed++
  const tag = same ? 'PASS' : (enforce ? 'FAIL' : 'WARN')
  const note = same ? 'matches the repo source of truth' : 'installed copy is STALE — re-run the install; the REPO is source of truth'
  console.log(`${tag}  ----   ${label}: ${note}`)
}

// Unparseable stdin must not block: a guard that denies every Bash call because it could not read
// its own input is worse than the hazard it guards.
try {
  const out = execFileSync('node', [GUARD], { input: 'not json', encoding: 'utf8' })
  const ok = !out.includes('deny')
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  allow  unparseable payload falls through silently`)
} catch (e) { console.log(`ERROR  unparseable payload: ${e.message}`); failed++ }

fs.rmSync(root, { recursive: true, force: true })
console.log(failed === 0 ? `\nOK — ${cases.length + 1} cases` : `\n${failed} FAILING`)
process.exit(failed === 0 ? 0 : 1)
