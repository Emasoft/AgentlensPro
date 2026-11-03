---
trdd-id: 64JLBR3X
title: The review gate arms on a tool_use the harness denied
column: todo
status: tasked
created: 2026-11-03T21:34:07+0100
updated: 2026-11-03T21:34:07+0100
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

# The review gate arms on a tool_use the harness denied

## Symptom
A Bash `git restore` that the git-safety PreToolUse hook blocked never ran, yet the Stop gate demanded a review ("ran a write-shaped command: git restore").

## Evidence
The denied tool_use stayed in the transcript and was counted as work.

## Suspected location
src/cli/reviewGate.ts, scanTranscriptLines (line 808) counts a tool_use without checking that its paired tool_result is a hook denial. deniedToolUseIds (line 452) matches only the delegate gate's own deny sentence, and isDeniedEdit (line 472) applies only to EDITOR tools (Edit, Write, NotebookEdit), so a Bash deny from another hook is not skipped.

## Context
Found while working TRDD-8D26QVBC (the review gate ignores the AgentlensPro kill-switch; fix committed as e09151d0).

## Approval log

- 2026-11-03T21:34:07+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
