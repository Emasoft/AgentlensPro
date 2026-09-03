---
trdd-id: SVCUAPES
title: A fresh checkout has no build outputs, so harness failure is indistinguishable from commit failure
column: todo
created: 2026-09-03T22:52:00+0200
updated: 2026-09-03T23:12:00+0200
current-owner: main-session
task-type: infra
project-id: agentlenspro
scope: project
min-approval-requirement: none
labels: [tooling, safety, verification]
severity: high
effort: S
relevant-rules: [0]
npt: []
eht: []
external-refs: []
---

# Verifying a commit in a scratch worktree has no safe recipe

## Why this exists

On 2026-09-03, verifying that commit `09acee40` stood on its own required checking it out in
isolation. `git stash` is forbidden on this machine (global hooks destroy uncommitted work), so the
correct tool is `git worktree`. There is no scripted recipe for the rest, so the steps were
improvised — and the improvisation was destructive.

**The near-miss.** `node_modules` was symlinked from the main repo into the worktree to avoid a
slow install. The next `pnpm run compile-tests` ran pnpm's deps check, which decided the modules
directory was wrong and tried to **purge it — through the symlink, at the real target**. It stopped
only because no TTY was attached:

```
ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY
If you are running pnpm in CI, set the CI environment variable to "true", or set
"confirmModulesPurge" to "false".
```

The suggested remedy is the thing that removes the last protection. An agent following the error
text — the normal, cooperative response — deletes the repository's dependencies.

**Two more failures followed from the same absence of a recipe**, each of which read as "the
product is broken" when it was the scaffolding:

1. Removing the symlink to defuse the purge left the worktree unable to resolve any module.
   `MODULE_NOT_FOUND` on `@modelcontextprotocol/sdk` presented as 7 failing tests.
2. A fresh checkout carries no build OUTPUTS. `standalone/cli.js` is untracked, so the 7 runner
   tests — which spawn the bundled CLI — failed until `node esbuild.js` ran in the worktree. The
   commit was fine; the tree was incomplete.

Each was diagnosed only by reading the captured output **in full**. A filtered read would have
recorded a false verdict about the commit, which is exactly what the verification existed to
prevent.

## What is wrong

Verification-in-isolation is a routine operation (every "does this commit stand alone?" question,
every bisect, every clean-tree reproduction) with **no executable form**. It survives as prose in a
transcript, so every attempt re-derives it, and the re-derivation has a destructive failure mode
one keystroke away from the error message's own advice.

The general shape, worth stating because it recurs: **an untested harness fails toward "the product
is broken."** Three of this session's scaffolding failures were reported by their tooling as
product failures.

## SUPERSEDED IN PART — read this before working the card

The destructive half of this card is DONE and shipped as the guard in `85ffa079` + `c6aca2ed`
(`scripts/deny-pkgmanager-symlink-purge.js`, installed at user scope): a package-manager command
whose `node_modules` resolves outside its project is denied. That closes the purge hazard for the
direct-invocation shape.

What the guard structurally CANNOT do, and what this card is now only about:

- A fresh checkout carries no BUILD OUTPUTS. `standalone/cli.js` is untracked, so tests that spawn
  the bundled CLI fail with `MODULE_NOT_FOUND` until `node esbuild.js` runs there. Measured
  2026-09-03: 7 of 10 tests "failed" for exactly this reason while the commit was fine.
- Nothing distinguishes a HARNESS failure from a COMMIT failure. Every scaffolding failure this
  session was reported by its tooling as though the code under test were broken.

The `verify-commit` verb below is therefore narrowed to those two, and the guard is NOT part of it.

## Proposed safeguard

A single command that owns the whole recipe, so it is never improvised:

`agentlenspro verify-commit <ref> [--tests <grep>]`

- create the worktree under a scratch path, never inside the repo;
- populate dependencies **without** the purge hazard — a real install in the worktree, or a
  read-only mount/copy; never a symlink that a package manager may follow and delete;
- run the build (`node esbuild.js`), because tests that spawn a bundled CLI need it and its absence
  is otherwise indistinguishable from a broken commit;
- run type-check + tests by invoking the tools directly (`node_modules/.bin/tsc`, `.../mocha`),
  bypassing any package-manager wrapper that performs its own deps reconciliation;
- report per-stage exit codes captured to a file, distinguishing HARNESS failure from COMMIT
  failure in the summary line;
- remove the worktree on success, and on failure leave it with the path printed.

## Acceptance criteria

- [ ] The verb exists and is discoverable (`agentlenspro list --desc`).
- [ ] A test asserts a missing build output is reported as a HARNESS problem, never as a test
      failure of the commit under verification.
- [ ] Running it against `09acee40` reproduces this session's result: tsc 0, 10/10 tests pass.
- [ ] Running it against a deliberately broken ref reports COMMIT failure, not harness failure.
- [ ] `CLAUDE.md` gains one line pointing at the verb, replacing the improvised recipe.

## Evidence

- Near-miss and both follow-on failures: this session's transcript, 2026-09-03 ~22:45-22:50.
- Memory: `global-git-hooks-reset-uncommitted-work.md` atom `5P38ERK3`, lesson `ATOM-1X3K-M3Y0`
  (LOCAL scope — the pnpm purge mechanism and the two corollaries).
- The prohibition on `git stash` that forces the worktree route: same page, atom `QE4OS96X`.

## Notes

`git_safety_guard.py` blocking `git worktree remove` is NOT part of this defect — that guard
behaved correctly, gating a destructive command once by design. Its tokenizer treating every word
of a compound command as an `rm` target is likewise already recorded (atom `XLOUCSJF`: run the `rm`
alone in its own call). Neither needs new work here.
