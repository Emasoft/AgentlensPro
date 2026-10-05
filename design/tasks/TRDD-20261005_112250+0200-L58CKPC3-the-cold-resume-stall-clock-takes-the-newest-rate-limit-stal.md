---
trdd-id: L58CKPC3
title: The cold-resume stall clock takes the newest rate-limit stall from any session on the machine
column: todo
status: tasked
created: 2026-10-05T11:22:50+0200
updated: 2026-10-05T11:23:16+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: spike
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-05T11:22:50+0200
related: [HNPT6JRG]
---

# The cold-resume stall clock takes the newest rate-limit stall from any session on the machine

Named as an open follow-up on TRDD-HNPT6JRG and not actioned. last_rate_limit_stop (rust-core/crates/agentlens-core/src/burn/agent_gate.rs) has no session or account condition (read 2026-10-05). By a worker's read, hook event records carry no account field; the account is looked up only at calibration time. TRDD-0D6QK5CW covers fork exemption and does not own this (worker's read; that card is blocked). Whether a stall on one account should hold back launches on another is a design question, not shown to be a defect. Done when that is decided and recorded here, with a test if the scope changes.

## Approval log

- 2026-10-05T11:22:50+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
