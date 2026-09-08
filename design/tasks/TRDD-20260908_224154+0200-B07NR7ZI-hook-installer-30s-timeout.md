---
trdd-id: B07NR7ZI
title: The hook installer emits a 30 s ceiling on every AgentlensPro hook entry
column: dev
created: 2026-09-08T22:41:54+0200
updated: 2026-09-08T22:41:54+0200
current-owner: main
task-type: infra
min-approval-requirement: none
priority: high
severity: medium
blocked-by: []
npt: []
eht: []
implementation-commits: []
project-id: agentlenspro
scope: project
labels: [hooks, installer, settings, timeout]
relevant-rules: []
---

# The hook installer emits a 30 s ceiling on every AgentlensPro hook entry

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-08

NEXT ACTION: a background worker is implementing + verifying the fix (check-types, eslint,
mocha `cliMatchers`, esbuild, `--install-hooks`, `setup --dry-run`); a report will land under
`reports/hook-timeout-30/`. Read that report before closing this card, then verify the
acceptance boxes directly.

## Why

USER order 2026-09-08 22:33: "ensure the installer of the agentlenspro hooks uses a 30 seconds
timeout." The live `~/.claude/settings.json` already carried `timeout: 30` on all 19 agentlens
hook entries (set out-of-band), but `src/cli/hookInstall.ts`'s builders still emitted
10/10/20/10 — so the next `agentlenspro setup` run would have reverted the live config back to
the lower values. This is a single-source-of-truth fix: one exported constant used by all four
builders removes the drift permanently instead of hand-editing the settings file again.

## Evidence

- Live `~/.claude/settings.json`: all 19 agentlens hook entries already at `timeout: 30`.
- `src/cli/hookInstall.ts` builders emit 10/10/20/10 depending on hook type — history: 2s/3s →
  doubled 2026-08-14 → doubled again 2026-09-05 (TRDD-GXKRBK1Q) — never reached 30.
- Memory atom `ATOM-5WTK-6YPU` states 10s/20s and is now superseded by this change.
- Inner soft budgets `AGENTLENS_HOOK_TIMEOUT` (2 s) and `AGENTLENS_GATE_TIMEOUT` (4 s) are
  unaffected — this card changes only the outer ceiling Claude Code enforces.

## Acceptance

- [ ] `src/cli/hookInstall.ts` defines one exported `HOOK_TIMEOUT_SEC = 30` used by all four
      hook builders.
- [ ] `src/test/cliMatchers.test.ts` pins the constant and asserts every builder emits `timeout: 30`.
- [ ] `pnpm run check-types`, `pnpm run lint`, and the `cliMatchers` mocha test pass.
- [ ] `node esbuild.js` rebuilds the bundle with the change.
- [ ] `agentlenspro --install-hooks` followed by inspecting `~/.claude/settings.json` shows all
      agentlens entries at `timeout: 30`.
- [ ] `agentlenspro setup --dry-run` reports no hook-timeout drift.
- [ ] Memory atom `ATOM-5WTK-6YPU` (10s/20s claim) is updated/superseded.

## Approval log

