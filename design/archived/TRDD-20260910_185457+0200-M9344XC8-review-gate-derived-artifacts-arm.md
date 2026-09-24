---
trdd-id: M9344XC8
title: The review gate's disk walk arms on derived artifacts such as __pycache__ pyc files and .DS_Store
column: superseded
created: 2026-09-10T18:54:57+0200
updated: 2026-09-24T08:56:36+0200
current-owner: main
task-type: bugfix
min-approval-requirement: none
priority: medium
blocked-by: []
npt: []
eht: []
implementation-commits: []
project-id: agentlenspro
scope: project
labels: [review-gate, effects, noise]
related: [3U8AIHXK, JELDR3KC, 9FG0LSPG]
superseded-by: [A37YM37G]
---

# The review gate's disk walk arms on derived artifacts such as __pycache__ pyc files and .DS_Store

## Defect

`src/cli/reviewGateEffects.ts` has `SKIP_DIRS = {node_modules, .git}` only, so a worker's
`py_compile` into `__pycache__/`, Finder's `.DS_Store`, a tool cache, or a peer hook's growing `.log` (e.g.
`~/.claude/hooks/fable_delegation_gate.log`, appended on every tool call) arms the Stop gate and
demands a ~300k-token fork with nothing reviewable (measured 2026-09-10 by this session and by
the ai-maestro-janitor session). CPython never imports a `__pycache__` pyc whose source is
absent (PEP 3147), so skipping it hides no runnable code.

## Fix

Read `SKIP_DIRS`, `BUILD_OUTPUT`, `walkDir`, `walkWatched` first; add `__pycache__ .mypy_cache
.ruff_cache .pytest_cache .hypothesis .tox` to `SKIP_DIRS`; add ONE shared
`isDerivedArtifact(rel)` predicate matching `/(^|\/)(\.DS_Store|[^/]+\.pyc)$/` applied wherever
the walk decides a FILE counts (both the repo walk and the watched walk — one function, not two
copies). Plugin-cache `hooks.json` and `~/.claude/agents` stay WATCHED by design. Revised per
review fork round 2: `isDerivedArtifact(rel)` is unconditional — `/(^|\/)(\.DS_Store|[^/]+\.(pyc|log))$/`,
no `watched` param. `walkDir`/`walkWatched` walk ONLY the watched config set in production (never
repo content, never routed anywhere else); a repo `.log` reaches the gate through `git status` in
`inRepoEffects`, filtered only by `BUILD_OUTPUT`, and is never checked against `isDerivedArtifact`
at all — pinned by test "a .log added in-repo next to an already-tracked file is listed
(TRDD-M9344XC8)".

## Acceptance

- [ ] A real-tmp test in the effects suite (watched root with `hooks/x.py` older than sinceMs,
      `hooks/__pycache__/x.cpython-314.pyc` and `hooks/.DS_Store` newer → `paths: []`; then
      utimes x.py newer → exactly `['hooks/x.py']`; mutation: removing `__pycache__` from
      SKIP_DIRS fails the first assertion)
- [ ] `pnpm run compile-tests && npx mocha out/test/test/reviewGateEffects.test.js`,
      `check-types`, `lint`, `node esbuild.js` all exit 0
- [ ] Live: one Stop after a worker `py_compile` demands no fork

## Approval log
- 2026-09-24T08:56:36+0200 — SUPERSEDED by main-session. Gen-2 mtime disk-effects mechanism (reviewGateEffects.ts) deleted by commit 268f3080 / TRDD-A37YM37G 2026-09-15; card describes a mechanism that no longer exists (reports/board-triage/20260924_083538+0200-cluster-review-gate.md).
