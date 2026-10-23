---
trdd-id: XRTH2MEI
title: a failed bodies store open is retried every tick at full parts-corpus read cost
column: todo
status: tasked
created: 2026-10-23T03:25:24+0200
updated: 2026-10-23T03:31:47+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-23T03:25:24+0200
---

# a failed bodies store open is retried every tick at full parts-corpus read cost

Since TRDD-1FWN9XBS Change 1, open_store reads every parts file to seed known_part (27-72 s warm on the clone, measured in a Python DuckDB process, not inside alcore). A failed open leaves the shared slot empty, so every non-idle tick retries it (chores.rs). One permanently unreadable or body_id-less parts file therefore makes every tick do a full parts-corpus read and fail; the bodies pass never runs. Same loop existed before for a bad blob/bodies file, but parts are the largest corpus and a bad parts file previously did not fail the open. Fix: back off / rate-limit the failed-open retry, log the failing path once; add the missing retry test. Do before the clone re-run so a bad file there is not read as the fix being slow. Found by the Change 1 final review.

## Approval log

- 2026-10-23T03:25:24+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
