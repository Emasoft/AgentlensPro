---
trdd-id: D2KY0ZR9
title: No gate stopped seven commits that pushed the store-opener counts over the caps
column: backburner
status: tasked
created: 2026-10-17T12:08:11+0200
updated: 2026-10-17T12:16:13+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: infra
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-17T12:08:11+0200
project-id: agentlenspro
---

# No gate stopped seven commits that pushed the store-opener counts over the caps

## Problem

Seven commits landed on main while pnpm run compile was red on check-duckdb-only: cbe06222, cc49a819, fb09facf, 69b7d406, 94125a8d, cdb13539 and d74c74dd. Each one pushed a store-opener count over its cap in scripts/check-duckdb-only.js.

## Question to answer

Which of these let a red compile reach main, decided from evidence:
- compile is not required in CI: read .github/workflows and list which jobs run pnpm run compile and on which events.
- compile is not run per commit: check whether a pre-commit or pre-push hook exists and is enabled (.githooks is opt-in).
- worktree merges bypass the gate: check the merge path those commits took.
- Per commit: was compile green before it and red after, or already red for an earlier reason (check-types, lint, an earlier over-cap commit)? An already-red gate whose signal was ignored is a different mechanism from a gate that never ran.

## Acceptance

- Name the gate that would have stopped each of the seven commits, or state that no gate existed.
- Then either add that gate, or record in this card why it was not added.

## Origin

TRDD-4BZPAQWM (the red compile), commit 728b143b.

## Approval log

- 2026-10-17T12:08:11+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
