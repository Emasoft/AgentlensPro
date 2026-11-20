---
trdd-id: NEC3PBYU
title: review-gate isolation-credit mismatch, false write attribution after a guard denial, undocumented single-line sentinel (GitHub 28)
column: todo
status: tasked
created: 2026-11-19T23:14:55+0100
updated: 2026-11-19T23:45:25+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T23:14:55+0100
---

# review-gate isolation-credit mismatch, false write attribution after a guard denial, undocumented single-line sentinel (GitHub 28)

Source: GitHub issue Emasoft/AgentlensPro 28, https://github.com/Emasoft/AgentlensPro/issues/28, opened 2026-11-06. Imported 2026-11-19 by owner order (every open GitHub issue becomes a TRDD).

## Approval log

- 2026-11-19T23:14:55+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Problem

The issue reports Defect 1 (VERIFIED): isCreditedFork (about lines 4474-4477) credits a REVIEW fork only when subagent_type is fork and isolation is absent; if the Agent schema requires isolation, no valid spawn earns credit.
The issue reports Defect 2 (VERIFIED): workerWriteDetail (about lines 4675-4724) classes Bash commands as writes without consulting the paired tool_result; a fastedit create refused before execution by a worktree guard re-armed the gate on a no-op turn.
The issue reports Defect 3 (code shape VERIFIED, behaviour INFERRED): isNoReviewSentinel (about lines 4260-4270) accepts the NO REVIEW sentinel only as the whole block, with a reason of 8+ characters and no trailing prose; the directive does not document this.
Line numbers are keyed to the installed bundle at /opt/homebrew/lib/node_modules/agentlenspro/standalone/cli.js, not compared to repo HEAD. Defect 2 may be a root-cause refinement of #22; dedupe deliberately.
Not verified in the issue: worktree cwd mismatch; EnterWorktree needing both name and path; an unproven gateway strict-schema hypothesis (discriminating probe: capture one Agent request on the live route).
Suggested fixes: credit when isolation is absent or schema-mandated (or add a creditable non-isolated channel); consult each Bash tool_result before attributing a write; document the sentinel shape in the directive.

## Next action

Mod work, route to mods-expert-developer-agent. First check whether it still reproduces on agentlenspro-review-mod 0.4.x (TRDD-KZCSO0R2 moved the gate into a mod); if it does not, close this card citing the check.

## Related

Overlaps QQ2XIIZ6 (todo, credits only non-isolated forks), JJIJQN6L (GitHub 27) and DRH4ZRGB (complete, block message).
The links above come from board titles only; read each linked card before using it in a fix.

## Triage

2026-11-19T23:45+0100 mods-expert-developer triage (reports_dev/review-gate-issues/20261119-triage.md, code reading only, no probes): verdict in that report under this id. Repo mod source is 0.7.13, the installed mod 0.7.10; the cited behaviours were re-checked by grep in 0.7.10 (report header), the 320-line register.js diff was not read in full.
