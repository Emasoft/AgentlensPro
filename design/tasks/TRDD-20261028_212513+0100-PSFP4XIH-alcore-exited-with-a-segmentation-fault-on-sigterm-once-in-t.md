---
trdd-id: PSFP4XIH
title: alcore exited with a segmentation fault on SIGTERM (once in two graceful stops, 2026-10-28)
column: backburner
status: tasked
created: 2026-10-28T21:25:13+0100
updated: 2026-10-28T21:29:48+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-28T21:25:13+0100
---

# alcore exited with a segmentation fault on SIGTERM (once in two graceful stops, 2026-10-28)

One occurrence, 2026-10-28, in the TRDD-735Q3JF4 deferred run A (real-data copy, log scan on, otel-bodies with 185636 entries present): SIGTERM was sent after 180 s, the process exited with code 139 (segmentation fault) 8 s after the signal, and the ports were freed.
Run B (same harness, otel-bodies emptied) exited 0 on SIGTERM.
n=1 for each run. The cause is not investigated and the crash is not shown to depend on otel-bodies.
Binary: rust-core/target/release/alcore built 2026-10-27 20:47, sha256 56ad6bc044effc6c2ebd5c4e3ebef40a71b034a042cd1be2633dbdb3d44b7793 (copy ad-hoc codesigned; scratch copies left on the measuring host, see the session report).
Evidence: docs_dev/20261028_211829+0100-735Q3JF4-deferred-measurements.md (Part 2, the run A row, and the Run A lock and exit lines).
Acceptance: reproduce, or bound the occurrence rate over N graceful stops; if reproduced, capture a backtrace (lldb or a core file) naming the faulting frame.
Related: TRDD-N60JUWU3 (graceful shutdown has no lock timeout); TRDD-735Q3JF4 (the deferred measurements where it occurred).

## Approval log

- 2026-10-28T21:25:13+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Conditions

Conditions: both runs had log scan on; the A/B difference was otel-bodies present (A) vs emptied (B). Binary built 2026-10-27 (not HEAD 18bdd70c). The fault came 8 s after SIGTERM, i.e. during shutdown teardown (inferred).
