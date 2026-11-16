---
trdd-id: 22BOPTBU
title: setup run in an isolated HOME still runs a global npm rm -g for the old package
column: todo
status: tasked
created: 2026-10-14T17:39:38+0200
updated: 2026-10-14T17:41:37+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-14T17:39:38+0200
---

# setup run in an isolated HOME still runs a global npm rm -g for the old package

## Approval log

- 2026-10-14T17:39:38+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Problem

2026-10-14, found by the review of 857cc34a: `agentlenspro setup --yes` includes an old-package step that runs a GLOBAL `npm rm -g` (for the retired agentlens-dashboard package). Isolated instances (own HOME + DATA_DIR, the recipe CLAUDE.md documents and the 3c measurement used) and any test that runs setup in a fake HOME therefore reach outside their sandbox on a real machine. In the 3c run it was a no-op only because the worker first checked the old package was absent.
Fix candidates: skip the old-package step when HOME is not the real user home (or when DATA_DIR/HOME are overridden), or require an explicit flag; add a test that setup in a fixture HOME never spawns npm; add a warning to CLAUDE.md's isolated-instance recipe. Verify first which tests run setup --yes and whether any reaches the npm step (grep the old-package step's function name in src/cli/setup.ts and its callers).
Related: TRDD-YL3EWT6N (self-heal), where the hazard was found.
2026-10-14 17:50, VERIFIED by reading src/cli/setup.ts:1142-1168: the old-package step resolves agentlens-dashboard on ctx.pathEnv (:1145) and, only when it resolves AND --yes is given, runs execFileSync('npm', ['rm','-g','agentlens-dashboard']) with the caller's PATH (:1161); dry-run and no --yes only report it (:1153, :1158). So the hazard is narrower than stated above: only a machine that still has the old global package on PATH is affected — but there an isolated setup (fake HOME, real PATH) uninstalls the REAL global package. Still unknown: whether any existing test runs setup --yes with a PATH that can resolve agentlens-dashboard.
2026-10-14 17:41: the whole step was read (src/cli/setup.ts:1140-1170): `if (!oldBin)` returns PASS, `if (ctx.dryRun)` reports, `if (!ctx.yes)` reports, and only then `npm rm -g agentlens-dashboard` runs — so the branch conditions in the previous line are now read, not inferred. `npm rm -g` acts on npm's global prefix (from process.env / npmrc), not on the fake HOME, so an isolated run really uninstalls the machine's actual global package. Correction: the previous line is stamped 17:50 but was written at 17:40.
