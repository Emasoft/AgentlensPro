---
trdd-id: FWJXL72Z
title: The review supervisor warns it could not read the transcript on a session's first prompt
column: todo
status: tasked
created: 2026-11-03T21:34:06+0100
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
approval-datetime: 2026-11-03T21:34:06+0100
---

# The review supervisor warns it could not read the transcript on a session's first prompt

## Symptom
The review supervisor warns that it could not read the transcript on a session's first prompt.

## Evidence
4 of 42 sessions over 3 days, each time on the session's first prompt only. ? INFERRED: the UserPromptSubmit hook runs before Claude Code writes the transcript file. This is correlational, not measured. In one case the warning's timestamp is 6 s before the first user entry in the transcript. In another session the hook message comes after the user entry, and that file already held SessionStart lines, so the timing explanation does not cover it. Settling probe: log transcript_path and existsSync(transcript_path) on the supervisor's first-prompt run.

## Suspected location
src/cli/reviewSupervisor.ts, runReviewSupervisor (lines 224-227). `transcript && fs.existsSync(transcript)` is false when the file is missing, so `lines` is null and `judge(scan, registered, false)` runs. The same message is printed when transcript_path is empty (reviewSupervisor.ts:224), when readCurrentTurn fails to open the file (reviewGate.ts:708), and when it fails to read the file (reviewGate.ts:722-723). Which branch fires on a first prompt is not yet established.

## Proposed fix
If the settling probe confirms the missing-file branch: on UserPromptSubmit only, treat a missing transcript file as "no completed turn". Keep the warning when the file exists but cannot be read, and keep it on Stop.

## Context
Found while working TRDD-8D26QVBC (the review gate ignores the AgentlensPro kill-switch; fix committed as e09151d0).

## Approval log

- 2026-11-03T21:34:06+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
