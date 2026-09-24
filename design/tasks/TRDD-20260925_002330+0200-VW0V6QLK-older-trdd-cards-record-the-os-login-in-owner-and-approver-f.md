---
trdd-id: VW0V6QLK
title: Older TRDD cards record the OS login in owner and approver fields
column: backburner
status: tasked
created: 2026-09-25T00:23:30+0200
updated: 2026-09-25T00:23:30+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-09-25T00:23:30+0200
---

# Older TRDD cards record the OS login in owner and approver fields

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-25

Facts: 21 cards under design/tasks and design/proposals carry the OS login (not main-agent@agentlenspro or user) in current-owner, created-by, or approval-judge frontmatter fields (grep -rl count, paths only — the login itself is not pasted here). trddgrep no longer writes it (ai-maestro#168), so this is historical debt only.

Next action: decide whether to rewrite those fields, and to what value.

## Approval log

- 2026-09-25T00:23:30+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
