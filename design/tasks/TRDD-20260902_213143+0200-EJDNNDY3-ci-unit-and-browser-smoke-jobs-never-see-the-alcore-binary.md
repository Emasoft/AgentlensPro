---
trdd-id: EJDNNDY3
title: CI unit and browser-smoke jobs never see the alcore binary
column: planned
created: 2026-09-02T21:31:43+0200
updated: 2026-09-03T11:08:50+0200
current-owner: main-session
task-type: infra
priority: high
min-approval-requirement: manager
blocked-by: []
related: [1B98LCVR]
external-refs: [https://github.com/Emasoft/AgentlensPro/actions/runs/33667160582]
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-02

Not started. **NEXT ACTION:** await MANAGER/USER approval (`min-approval-requirement:
manager` — this edits `.github/workflows/ci.yml`, a Tier-2 baseline/workflow surface). On
approval: `git mv` this file to `design/tasks/`, set `column: planned`, then apply the two
edits below, commit (the USER pushes — never push unprompted), and verify the next `main` CI run is green.

## Why

CI on `main` has been red since commit `a306d12e` (last green: `f8b7560e`,
2026-09-01T20:35:04Z) — 3+ hours and several commits before the failure was even noticed
(3e294e16). A red `main` hides real regressions behind noise everyone learns to ignore.
Root cause is CI-config-only: no product code is broken.

Evidence: `reports/ci-triage/20260902_212902+0200-run-3366716058.md` (run 33667160582).
Likely introduced by `eb7a6a5f` ("ci: provide release alcore before test:unit in ci.yml and
publish.yml", TRDD-1B98LCVR box-4 precondition), which added binary *staging* but not the
*env var* the consumers actually read.

## Root cause (verified)

`.github/workflows/ci.yml`, `build-and-test` job:
- Downloads the pre-built `alcore` binary to `rust-core/target/release/alcore` ("Download
  alcore binary", lines 109–113) and chmods it executable (lines 116–117).
- The **`Unit tests`** step (lines 122–123, `run: npx mocha`) never sets `AGENTLENS_ALCORE`
  in its env. `src/test/setupVerb.test.ts` and `src/test/hookSpool.test.ts` exercise the real
  `setup` verb, which resolves the server binary via `alcoreBin(process.env, …)`
  (`src/rustBinResolve.ts`) — reading `process.env.AGENTLENS_ALCORE` or a packaged
  `bin-native/<platform>-<arch>/` dir that CI never stages. Neither is populated → 6 test
  failures (2510 passing, 6 failing) on both Node 20 and 22 matrix legs.
- Other integration tests pass because `src/test/helpers/freePort.ts` independently falls
  back to `rust-core/target/release/alcore` as a path — only the `setup`/`hookSpool` real-spawn
  tests go through `alcoreBin()` and fail.

`browser-smoke` job (lines 130–178): has **no `needs: [build-alcore]`** and **no binary
download step at all** — `dashboardSmoke.test.js`'s `before all` hook asserts "no alcore
binary found" and fails outright.

## Proposed edits to `.github/workflows/ci.yml`

1. `build-and-test` job's **Unit tests** step (currently lines 122–123):
   ```yaml
      - name: Unit tests
        env:
          AGENTLENS_ALCORE: ${{ github.workspace }}/rust-core/target/release/alcore
        run: npx mocha
   ```

2. `browser-smoke` job (currently lines 130–178): add, mirroring `build-and-test`'s existing
   pattern (lines 109–117) —
   - `needs: [build-alcore]` on the job (it already exists on `build-and-test` at line 23).
   - A "Download alcore binary" step (same as lines 109–113, `path:
     rust-core/target/release`) + "Make alcore executable" step (same as lines 116–117),
     inserted before the "Browser smoke suite" step.
   - `AGENTLENS_ALCORE: ${{ github.workspace }}/rust-core/target/release/alcore` added to the
     existing `env:` block on the "Browser smoke suite" step (currently lines 175–178, which
     only sets `AGENTLENSPRO_BROWSER_TESTS: '1'`).

## Acceptance

- [ ] `git push` to a branch triggers a green `build-and-test` (both Node 20 and 22 legs) and
      a green `browser-smoke` job.
- [ ] The 6 previously-failing tests (`setupVerb.test.ts`, `hookSpool.test.ts`) pass.
- [ ] `dashboardSmoke.test.js`'s `before all` hook no longer raises "no alcore binary found".
- [ ] `gh run view <run-id> --repo Emasoft/AgentlensPro` shows every job `success`.
- [ ] Merged to `main`; the next `main` CI run is green.

## Verification steps

```bash
gh workflow run ci.yml --repo Emasoft/AgentlensPro --ref <branch>
gh run watch <run-id> --repo Emasoft/AgentlensPro
gh run view <run-id> --repo Emasoft/AgentlensPro --json jobs --jq '.jobs[] | {name,conclusion}'
```

## Approval log

- 2026-09-03T11:08:50+0200 — APPROVED by main-session on the USER's delegation
  (min-approval-requirement: manager). Failure reconfirmed live on CI run 33667160582 (main
  red since f8b7560e); diagnosis verified line-by-line in the review sweep.
