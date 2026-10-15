---
trdd-id: WCG7I5D8
title: The card snapshot lags by days because hard-cap exits come before the first card save
column: todo
status: tasked
created: 2026-10-15T04:28:05+0200
updated: 2026-10-15T04:28:08+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T04:28:05+0200
project-id: agentlenspro
---

# The card snapshot lags by days because hard-cap exits come before the first card save

## Problem
The NDJSON card snapshot (log-sessions) saves only when dirty and at least 300 s after the previous save, counted from boot (log_reader.rs:834-836, 1260-1263); offsets save every 60 s (:833). Runs die at the RSS hard cap after about 4-11 minutes (per the facts report), and the hard-cap exit flushes the span store only (lib.rs:852-861, rss_guard.rs:554, per reports_dev/0bdov3wc-facts.md), so many runs save offsets several times and cards never. The snapshot count repeated across refusals days apart (41,053 on 2026-10-05 and 2026-10-07; 41,619 twice on 2026-10-14) while offsets advanced: the snapshot lagged by days. Evidence: reports_dev/0bdov3wc-facts.md Q4-Q5.

## Fix direction
Save the card snapshot early after boot and in the hard-cap exit path (bounded, off the state lock), or save cards whenever offsets are saved.

## Acceptance
- [ ] A run killed by the hard cap after its first offsets save leaves a card snapshot at least as fresh as those offsets.

## Approval log

- 2026-10-15T04:28:05+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
