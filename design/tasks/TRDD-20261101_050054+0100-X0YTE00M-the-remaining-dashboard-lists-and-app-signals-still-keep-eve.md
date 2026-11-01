---
trdd-id: X0YTE00M
title: The remaining dashboard lists and App signals still keep everything resident
column: backburner
status: tasked
created: 2026-11-01T05:00:54+0100
updated: 2026-11-01T05:01:34+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-01T05:00:54+0100
---

# The remaining dashboard lists and App signals still keep everything resident

## Approval log

- 2026-11-01T05:00:54+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Scope

Step 5a of PLAN v3 (TRDD-7YPQWKPG, merged as 54d55f3f on feat/duckdb-is-the-memory) windowed the Sessions list and made tabs drop their data. Still resident, found by the 5a review (minor m7): the Context list, the Transcript "earlier turns", the History step list; the App-level signals toolCalls, dailyStats, lifetimeStats, burnRateData (media/src/App.tsx ~380) and searchResults, rangedSearchResults (~486).

## Why

Owner ruling 2026-10-30 (verbatim in TRDD-7YPQWKPG WHY): "what is not visible is discared". Each list should use WindowedTable and each signal should live in the tab that fetches it, once the paged endpoints of steps 3-4 exist.
