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
