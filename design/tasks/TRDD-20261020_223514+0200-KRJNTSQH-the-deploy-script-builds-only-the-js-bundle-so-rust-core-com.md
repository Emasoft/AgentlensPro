---
trdd-id: KRJNTSQH
title: The deploy script builds only the JS bundle, so rust-core commits are stranded and the running server serves an old binary
column: todo
status: tasked
created: 2026-10-20T22:35:14+0200
updated: 2026-10-20T22:35:14+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-20T22:35:14+0200
---

# The deploy script builds only the JS bundle, so rust-core commits are stranded and the running server serves an old binary

MEASURED 2026-10-20, and this is the mechanism behind the alcore memory work going nowhere.

THE GAP. `scripts/safe-deploy.sh` — the `pnpm run deploy:safe` entry point, the one the project calls its deploy — runs `check-types` ×2, `lint`, `check-mirrors`, `compile-tests`, then `BUILD_CMD="${BUILD_CMD:-node esbuild.js}"`, a smoke test of `standalone/cli.js --version`, and `agentlenspro server restart`. `grep -c cargo scripts/safe-deploy.sh` returns **0**. The Rust workspace is never compiled, never staged into `bin-native/<platform>-<arch>/`, and never codesigned, so the `alcore` binary the server actually executes is whatever was last copied there BY HAND.

THE CONSEQUENCE, MEASURED. `git log --oneline --since="2026-10-03" -- rust-core/ | wc -l` = **81**. The live server was running an Oct 3 binary until 2026-10-20 20:58, when an out-of-band `cargo build --release` plus a manual copy into `bin-native/darwin-arm64/` finally landed the accumulated work. Nothing in the deploy path had shipped ANY of it.

WHY THIS IS WORSE THAN A MISSING STEP. The deployed `alcore` is the WHOLE backend — the TypeScript server was retired in commit 567fc5c2 (2026-09-01, TRDD-1B98LCVR box 4), so a green `safe-deploy.sh` run leaves the running server on the old binary while the JS bundle is fresh. A green deploy therefore says NOTHING about what is actually serving. Every rust-core change — the card-store rewrite, the hook-spool drain, the RSS guard — required an out-of-band manual step that the project has no procedure for.

THE OTHER HALF OF THE SAME GAP. CLAUDE.md records the codesign requirement and that no script performs it: after `cargo build --release` + copying into `bin-native/<platform>/`, `codesign -s - --force bin-native/darwin-arm64/alcore` must run, or macOS SIGKILLs the binary before `main` (the tell: `alcore --version` returns exit 137). The documented deploy path does not do it and `grep -rn codesign scripts/ package.json .github/workflows/` finds nothing. So the deploy path is missing BOTH the build and the signing.

ACCEPTANCE.
- `safe-deploy.sh` builds the Rust workspace and stages `alcore` into `bin-native/<platform>-<arch>/` when the workspace has changed, and the script says so in its output — a deploy that skipped a rust rebuild must be visible, not silent.
- The codesign step runs as part of that staging, on the macOS target, and the script fails if the staged binary is not executable.
- The restart step verifies the RUNNING pid executes the binary that was just staged (inode check), so "the deploy did not take" is a loud failure instead of a stale server that looks healthy.
- A `--dry-run` run reports both halves (JS bundle, Rust binary) so the gap cannot reappear unnoticed.
- The rust build is not run on every deploy when the workspace is unchanged, and the skip is stated rather than implied.

## Approval log

- 2026-10-20T22:35:14+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
