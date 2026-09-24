---
trdd-id: HNPT6JRG
title: The burn-gate treats every StopFailure as a rate-limit stall and blocks fresh agents machine-wide
column: dev
created: 2026-09-24T08:43:54+0200
updated: 2026-09-24T08:44:20+0200
current-owner: emanuelesabetta
created-by: emanuelesabetta
task-type: bugfix
min-approval-requirement: none
assignee: emanuelesabetta
mandate: true
mandated-by: none
approved: true
approval-judge: emanuelesabetta
approval-datetime: 2026-09-24T08:43:54+0200
related: [0D6QK5CW, 8ENYLEIO]
---

# The burn-gate treats every StopFailure as a rate-limit stall and blocks fresh agents machine-wide

## Approval log

- 2026-09-24T08:43:54+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Defect

rust-core/crates/agentlens-core/src/burn/agent_gate.rs:751 (build_gate_state) took ANY StopFailure hook event, from any session on the machine, as the last rate-limit stall (lastStopFailureMs, agent_gate.rs:813). That arms COLD_RESUME_FANOUT and denies fresh agent launches machine-wide for the cold-resume window. The same server's calibrator already classifies these events (burn_calibration.rs:45 is_rate_limit_stop_failure; burn_calibration.rs:136 logs 'StopFailure error is not rate-limit-class'). Observed 2026-09-24: every lean-worker launch refused for 20+ minutes while server.log showed only non-rate-limit-class StopFailures.

## Acceptance

- [ ] (a) a non-rate-limit StopFailure no longer sets lastStopFailureMs
- [ ] (b) a rate-limit-class StopFailure still does (newest wins)
- [ ] (c) unit tests pin both, and fail with the filter removed
- [ ] (d) clippy on agentlens-core with -D warnings is clean
