---
trdd-id: PV5BIND2
title: The review gate and supervisor count writes under /private/tmp as consequential work
column: todo
status: tasked
created: 2026-11-03T21:34:07+0100
updated: 2026-11-03T21:40:34+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-03T21:34:07+0100
---

# The review gate and supervisor count writes under /private/tmp as consequential work

## Symptom
A scratchpad write under /private/tmp/claude-<uid>/... (the macOS real path of /tmp) armed the supervisor's "1 change(s) with NO adversarial review fork" warning. Scratch output should not count as work.

## Evidence
One observed case: a scratchpad write under /private/tmp/claude-<uid>/... armed the warning. Hypothesis from the report: the ephemeral-root test matches only /tmp. Checked: src/cli/reviewGateTriggers.ts isEphemeralTarget (lines 166-184) also tests the /private/tmp/ prefix (lines 175 and 182), so that hypothesis does not explain the case. The cause is not yet located.

## Suspected location
src/cli/reviewGateTriggers.ts, isEphemeralTarget (lines 166-184). It is used at line 213 (isRoleScratchTarget), line 541 (Bash command targets) and line 700 (write-target gate). Next step: trace which branch the scratchpad write takes.

## Context
Found while working TRDD-8D26QVBC (the review gate ignores the AgentlensPro kill-switch; fix committed as e09151d0).

## Approval log

- 2026-11-03T21:34:07+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
