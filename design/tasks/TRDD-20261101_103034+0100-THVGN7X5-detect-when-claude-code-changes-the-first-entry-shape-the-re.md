---
trdd-id: THVGN7X5
title: Detect when Claude Code changes the first-entry shape the review gate's self-exemption relies on
column: backburner
status: tasked
created: 2026-11-01T10:30:34+0100
updated: 2026-11-01T10:30:34+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: infra
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-01T10:30:34+0100
---

# Detect when Claude Code changes the first-entry shape the review gate's self-exemption relies on

TRDD-8YM21R5X (closed) anchored declaredRoleOwnTranscript to the first non-blank line on the measured shape of 2 background cheap-worker transcripts, Claude Code 2.1.316, 2026-11-01; no non-fork role agent was measured, and the real-shape test uses a fixture frozen at that version, so it cannot detect a change. If Claude Code or a SubagentStart hook puts a line ahead of a non-fork brief, non-fork role agents silently lose self-exemption (stricter, not looser). Signals: non-fork agents ending "REVIEW-GATE: NO REVIEW POSSIBLE"; repeated SubagentStop blocks on agents whose brief starts with ROLE; ownRole null in the gate log for such a spawn. Fix direction: re-measure the shape on each Claude Code upgrade, or log and flag a null ownRole on a first-line-ROLE spawn.

## Approval log

- 2026-11-01T10:30:34+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
