---
trdd-id: B07NR7ZI
title: The hook installer emits a 30 s ceiling on every AgentlensPro hook entry
column: ai_review
created: 2026-09-08T22:41:54+0200
updated: 2026-09-23T12:57:03+0200
current-owner: main
task-type: infra
min-approval-requirement: none
priority: high
severity: medium
blocked-by: []
npt: []
eht: []
implementation-commits: [a2303f91]
project-id: agentlenspro
scope: project
labels: [hooks, installer, settings, timeout]
relevant-rules: []
---

# The hook installer emits a 30 s ceiling on every AgentlensPro hook entry

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-08 22:53

LANDED in `a2303f91`: `HOOK_TIMEOUT_SEC = 30` drives all four builders; `cliMatchers.test.ts` pins
the constant and asserts every builder emits it. Coordinator re-ran the scoped test (13 passing),
rebuilt the bundle (`HOOK_TIMEOUT_SEC` present 5×), and the live settings.json shows 30 on every
agentlens entry; `--install-hooks` reported nothing to change and `setup --dry-run` reported the
registrations current. Report: `reports/hook-timeout-30/20260908_224450+0200-installer-ceiling-30s.md`.
One claim was softened before commit: whether the OLD builders (10/20) would have reverted the
live 30 on the next rebuild was never measured — the code comment says so.
NEXT ACTION: the Stop-time adversarial review of `a2303f91`; then supersede memory atom
ATOM-5WTK-6YPU (it still says 10 s / 20 s) and close.

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


## AI-REVIEW VERDICT

APPROVE — 2026-09-23T12:55:54+0200
Box1 (one exported HOOK_TIMEOUT_SEC=30 used by all builders): met, VERIFIED. src/cli/hookInstall.ts:188 exports HOOK_TIMEOUT_SEC = 30; used at lines 194,203,212,216,229 (5 builders now, incl. delegateGateMatcher added by a later card).
Box2 (cliMatchers.test.ts pins the constant): met, VERIFIED. src/test/cliMatchers.test.ts:7 imports HOOK_TIMEOUT_SEC; lines 36-44 assert strictEqual(HOOK_TIMEOUT_SEC, 30) and every builder emits it.
Box3 (check-types/lint/cliMatchers test pass): not re-run by this review — cannot execute pnpm; RUN pnpm run check-types && pnpm run lint && (compile tests) npx mocha out/test/test/cliMatchers.test.js to reconfirm.
Box4 (esbuild rebuilds the bundle with the change): PARTIALLY met at landing (a2303f91) — standalone/cli.js:1160-1171 carries HOOK_TIMEOUT_SEC=30 and 4 of the then-existing builders; but the bundle now lacks the 5th (delegateGateMatcher) usage added by a later card (X8MW8K92) — the bundle is stale relative to current src/cli/hookInstall.ts, not a defect this card introduced, but RUN node esbuild.js before shipping.
Box5 (--install-hooks -> settings.json shows 30 on all agentlens entries): met, VERIFIED against the live ~/.claude/settings.json — 19 agentlens hook entries all at timeout 30, one unrelated non-agentlens Stop entry untouched.
Box6 (setup --dry-run reports no drift): not re-run by this review; STATE's own claim (registrations current) plus the live settings.json read-back is consistent with it.
Box7 (memory atom ATOM-5WTK-6YPU superseded): met, VERIFIED. .claude/project/memory/hook-events-pipeline.md footnote [^2] ATOM-6OC6-575F carries supersedes: ATOM-5WTK-6YPU and states the 30 s ceiling correctly.
Finding: all seven acceptance checkboxes in this card are still literally unchecked ([ ]) even though the STATE block and code both show the work landed — a board-hygiene gap (governance-trdd-kanban), not a code defect; the owner or a follow-up edit should tick them before/at human_review.
Ready for human_review; the owner makes that move.
