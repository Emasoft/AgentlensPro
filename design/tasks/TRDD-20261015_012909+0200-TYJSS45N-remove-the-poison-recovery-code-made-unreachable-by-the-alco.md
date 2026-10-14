---
trdd-id: TYJSS45N
title: Remove the poison-recovery code made unreachable by the alcore panic hook
column: todo
status: tasked
created: 2026-10-15T01:29:09+0200
updated: 2026-10-15T01:50:31+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T01:29:09+0200
blocked-by: []
pre-block-column: 
project-id: agentlenspro
blocker-probe: 
blocker-holds-if: 
---

# Remove the poison-recovery code made unreachable by the alcore panic hook

## Problem
After TRDD-3RVTC1HY (a panic hook in the alcore binary that exits the process), the state mutex can no longer be observed poisoned in production. The poison-recovery code becomes unreachable: the `into_inner()` sites (chores.rs:226/234/249/383 per MEASURE section 5, chores.rs:695/1032/1251 per reports_dev/poison-fix-facts.md, summary_engine.rs:166, shutdown.rs:35, lib.rs:1241, and the poison branch of lock_timed at lib.rs:1386-1392) and the poison-to-error mappings in ui.rs (273/398/427/445/4411/4461/4524). Site list: reports_dev/da0gn1cs-measure.md section 5.

## Acceptance
- [ ] Only after TRDD-3RVTC1HY lands: each site is removed or rewritten, and each removal is justified by the hook's guarantee.
- [ ] `lib.rs` `lock_timed_tests::poisoned_mutex_still_yields_a_usable_guard` is kept (a library property) or rewritten to state the new contract.

## Approval log

- 2026-10-15T01:29:09+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-15T01:42:14+0200 — column → blocked by main-agent@agentlenspro. follows TRDD-3RVTC1HY
- 2026-10-15T01:50:19+0200 — column → todo by main-agent@agentlenspro. not blocked: it is an EHT of 3RVTC1HY; its body gates the work on 3RVTC1HY landing Cleared blocked-by (--clear-blocker override).
