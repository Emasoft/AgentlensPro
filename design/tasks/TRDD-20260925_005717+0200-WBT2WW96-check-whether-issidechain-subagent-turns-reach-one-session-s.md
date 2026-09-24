---
trdd-id: WBT2WW96
title: Check whether isSidechain subagent turns reach one session's cache-break timeline
column: todo
status: tasked
created: 2026-09-25T00:57:17+0200
updated: 2026-09-25T00:57:17+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: spike
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-09-25T00:57:17+0200
---

# Check whether isSidechain subagent turns reach one session's cache-break timeline

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-25

Next action: find whether any upstream layer drops isSidechain lines before agentlens-logscan's
lib.rs builds the per-turn timeline, then test with a real older transcript containing
isSidechain subagent turns to see whether they land in the main session's timeline.

Fact: agentlens-logscan's lib.rs builds the per-turn timeline with no isSidechain filter. If
older transcripts' subagent turns land in the main session timeline, I6c2's backward lookback
can cross streams and judge a main-thread gap by a subagent's write tier. Cites
reports/cc-alignment/20260925_005341+0200-head-156a6768-clean-checks.md.

## Approval log

- 2026-09-25T00:57:17+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
