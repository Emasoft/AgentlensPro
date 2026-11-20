---
trdd-id: JJIJQN6L
title: review-supervisor does not credit a background review fork and re-fires every turn (GitHub 27)
column: complete
status: archived
created: 2026-11-19T23:14:41+0100
updated: 2026-11-19T23:45:36+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T23:14:41+0100
---

# review-supervisor does not credit a background review fork and re-fires every turn (GitHub 27)

Source: GitHub issue Emasoft/AgentlensPro 27, https://github.com/Emasoft/AgentlensPro/issues/27, opened 2026-10-27. Imported 2026-11-19 by owner order (every open GitHub issue becomes a TRDD).

## Approval log

- 2026-11-19T23:14:41+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T23:45:36+0100 — COMPLETE by main-agent@agentlenspro. gone on the mod path by code reading (reports_dev/review-gate-issues/20261119-triage.md); GitHub issue left open for the owner.

## Problem

Symptom: the review-supervisor Stop hook prints that 3 changes have landed with no adversarial review after them on every turn, even after review forks covering those changes returned findings.
It fired on six consecutive turns with no new change, so each turn existed only to answer the hook; each turn re-read about 420,000 tokens of context.
Repro: commit source files and a TRDD card, spawn Agent with subagent_type fork and a ROLE: REVIEW prompt and no isolation (it runs in the background), then end the turn; the hook reports 0 review forks.
Expected: a fork whose prompt starts ROLE: REVIEW credits the changes before it, whether it runs synchronously or in the background (turn-protocol rule: each spawn credits its role at spawn time).
Suspected cause, low confidence per the issue: the hook counts review forks from the transcript and may recognise only a synchronous fork result, not the background Async agent launched record.

## Next action

Mod work, route to mods-expert-developer-agent. First check whether it still reproduces on agentlenspro-review-mod 0.4.x (TRDD-KZCSO0R2 moved the gate into a mod); if it does not, close this card citing the check.

## Related

Overlaps QQ2XIIZ6 (todo, credits only non-isolated forks) and NEC3PBYU (GitHub 28, isolation-credit mismatch).
The links above come from board titles only; read each linked card before using it in a fix.

## Triage

2026-11-19T23:45+0100 mods-expert-developer triage (reports_dev/review-gate-issues/20261119-triage.md, code reading only, no probes): verdict in that report under this id. Repo mod source is 0.7.13, the installed mod 0.7.10; the cited behaviours were re-checked by grep in 0.7.10 (report header), the 320-line register.js diff was not read in full.

## Acceptance

- [x] review-supervisor is not registered while the mod is installed (hookInstall.ts:304-310, 406-410) and the mod never asks for a fork; the legacy credit reads the Agent tool_use whether sync or background (reviewSupervisor.ts:82-87).
