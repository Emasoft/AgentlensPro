---
trdd-id: 058RS3FB
title: Four single-card handlers still reparse a transcript under the state lock
column: backburner
status: tasked
created: 2026-11-19T00:50:36+0100
updated: 2026-11-19T00:50:36+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T00:50:36+0100
---

# Four single-card handlers still reparse a transcript under the state lock

Found by the MVR6PXC0 triage (reports_dev/sonnet-worker/20261119_w63-triage-mvr6-n60j/report.md). ui.rs:2669 (get_agent_tokens), 2767, 2854 and 4213 (/api/timeline/<id>) call the plain resolve_session_card(&mut st, ..) inside a lock_timed() block; when the card timeline is empty that reparses the whole transcript with the CoreState guard alive. VERIFIED only that the calls sit inside the lock blocks; the per-request cost (1-4 s on a multi-MB transcript) is INFERRED from MVR6PXC0, not measured on these paths. Fix shape if measured worth it: the snapshot-then-reparse helper resolve_session_card_offlock (ea9882c9). Measure first.

## Approval log

- 2026-11-19T00:50:36+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
