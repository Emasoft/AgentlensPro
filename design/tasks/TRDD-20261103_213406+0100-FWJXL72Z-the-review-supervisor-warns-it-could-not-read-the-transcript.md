---
trdd-id: FWJXL72Z
title: The review supervisor warns it could not read the transcript on a session's first prompt
column: testing
status: tasked
created: 2026-11-03T21:34:06+0100
updated: 2026-11-03T22:22:49+0100
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
implementation-commits: [78a5bd0f]
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

## Findings 2026-11-03

✓ VERIFIED: the warning's only producer is judge() (reviewSupervisor.ts:143), reached when lines is null. Four null branches: empty transcript_path, missing file, open failure (reviewGate.ts:708), read failure (reviewGate.ts:722-723).
Measured: in 24 of 25 first-prompt warnings over 5 days the transcript file was born 0.5-6.4 s after the warning (three re-measured by the orchestrator). So the hook ran before the file existed.
Not separated: transcripts cannot tell the empty-path branch from the missing-file branch. The fix covers only the missing-file branch.
Not covered: one mid-session warning (session ff701ebd, 2026-11-03T19:05:26Z) on a file that had existed for days. Its cause is an empty path or an open/read failure; it still warns, by design.
Fix: on UserPromptSubmit, a non-empty path to a missing file means no completed turn (lines = []). Stop, SubagentStop and an empty path still warn. Trade-off (review): a wrong or stale path mid-session is no longer flagged at prompt time, only at Stop.
Follow-up: the env-gated probe (log transcript_path, its type, existsSync, and the readCurrentTurn null reason) would separate the empty-path branch from the missing-file branch and explain the mid-session case.
Live check: passive. After the bundle rebuild at 2026-11-03T21:14:03Z, count first-prompt warnings in transcripts born after that time. Baseline about 5 a day (24 in 5 days); 0 over a day confirms the fix.
Correction (review of 797fe357): the "over 5 days" window and the "about 5 a day" baseline above are wrong; they came from a file-modification filter, and the 24 hits span about 40 days. Measured instead: 58 of 254 main sessions born from 2026-10-20 to the rebuild got the first-prompt warning (p about 0.23). Live check: confirmed when at least 15 sessions born after 2026-11-03T21:14:03Z show 0 first-prompt warnings (0.77^15 is about 0.02), with the supervisor shown to still run in them. The registered hook command `agentlenspro review-supervisor` was run directly on 2026-11-03: it printed nothing for UserPromptSubmit with a missing transcript, and the UNVERIFIED warning for Stop (the liveness control). Minor: the worker measured 0.0-6.4 s (the code comment says 0.5-6.4 s), and the full 3345-test mocha run predates the comment-only follow-up.
Correction 2 (review of f3134813): re-measured by population, counting only the supervisor's own hook_system_message, and only sessions with a user prompt in their first 40 lines. Real sessions: 42 of 214 warned (p about 0.20). Scripted sessions under -private-tmp project dirs: 16 of 35 (p about 0.46). The pooled 58/254 above mixed the two. Live check, replacing the criterion above: confirmed when at least 15 real sessions (not under -private-tmp) born after 2026-11-03T21:14:03Z, each with a user prompt, show 0 first-prompt warnings (0.80^15 is about 0.04, assuming sessions are independent). Liveness: ~/.claude/settings.json registers review-supervisor on UserPromptSubmit and Stop, and review-gate on Stop and SubagentStop (checked 2026-11-03). After each rebuild, rerun the registered command with a missing-transcript Stop payload; it must warn. which -a agentlenspro finds one binary, /opt/homebrew/bin/agentlenspro.
