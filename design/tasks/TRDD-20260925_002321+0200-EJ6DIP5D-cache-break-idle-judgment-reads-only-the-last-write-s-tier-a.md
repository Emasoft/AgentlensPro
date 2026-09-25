---
trdd-id: EJ6DIP5D
title: Cache-break idle judgment reads only the last write's tier and overstates expiry after mixed writes
column: dev
status: tasked
created: 2026-09-25T00:23:21+0200
updated: 2026-09-25T05:34:00+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-09-25T00:23:21+0200
---

# Cache-break idle judgment reads only the last write's tier and overstates expiry after mixed writes

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-25

Facts: I6c2 (TRDD-ZQQYRYBO) judges an idle gap by the tier of the last turn that wrote the cache. If an earlier 1h write is followed by a later 5m write and then a 5-60 min gap, the turn is reported as a full IDLE_TTL_EXPIRY although part of the prefix is still resident. The cost figure is still correct; only the cause label can be too strong.

Evidence: reports/cc-alignment/20260924_234821+0200-I6c2.md

## Approval log

- 2026-09-25T00:23:21+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-09-25T05:34:00+0200 — column → dev by main-agent@agentlenspro. owner default taken 2026-09-25: label 'assumed' on mixed-tier writes
