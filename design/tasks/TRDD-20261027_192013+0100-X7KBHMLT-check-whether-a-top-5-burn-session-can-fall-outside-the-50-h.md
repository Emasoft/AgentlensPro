---
trdd-id: X7KBHMLT
title: Check whether a top-5 burn session can fall outside the 50 hot timeline cards
column: todo
status: tasked
created: 2026-10-27T19:20:13+0100
updated: 2026-10-27T19:20:13+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: spike
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-27T19:20:13+0100
---

# Check whether a top-5 burn session can fall outside the 50 hot timeline cards

Derived from TRDD-735Q3JF4 (open item (b)). Burn status counts only timeline api_request entries (burn/monitor.rs api_request_events), and demote_cold_timelines keeps timelines only on the timeline_hot_cards() = 50 most recently active cards (summarize/retention.rs). Question: can a session among the top 5 by burn in the 5h or 7d window be outside those 50, so its events are lost? Old and new builds share this, so it is not an old-vs-new defect. Suggested check: a fixture with more than 50 timelined cards, call demote_cold_timelines(50), and assert the top-5 burn sessions computed before demotion are still present after it; or a read-only query on a copy of the store.

## Approval log

- 2026-10-27T19:20:13+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
