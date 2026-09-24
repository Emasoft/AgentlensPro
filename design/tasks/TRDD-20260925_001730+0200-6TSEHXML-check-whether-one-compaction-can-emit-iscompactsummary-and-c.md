---
trdd-id: 6TSEHXML
title: Check whether one compaction can emit isCompactSummary and compact_boundary in separate steps
column: todo
status: tasked
created: 2026-09-25T00:17:30+0200
updated: 2026-09-25T00:17:30+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: spike
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-09-25T00:17:30+0200
---

# Check whether one compaction can emit isCompactSummary and compact_boundary in separate steps

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-25

Next action: scan real transcripts that have both signals, and record per compaction whether they share a step.

Facts: since e02bb80a, context_history renders a postCompact block for each signal. If one compaction emits both in separate steps, two blocks with the same id appear. One real 657-step transcript rendered 1.

Evidence: reports/cc-alignment/20260924_194753+0200-I9b2.md (review finding 1) and reports/cc-alignment/20260924_234354+0200-I9b2-main-verify.md (Step 1c).

## Approval log

- 2026-09-25T00:17:30+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
