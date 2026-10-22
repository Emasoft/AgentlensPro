---
trdd-id: JZU3Z4EE
title: Re-tune pressure ladder fractions and update specs after the cap moved to mimalloc commit
column: backburner
status: tasked
created: 2026-10-22T19:35:30+0200
updated: 2026-10-22T19:35:30+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-22T19:35:30+0200
---

# Re-tune pressure ladder fractions and update specs after the cap moved to mimalloc commit

The ladder fractions in rss_guard.rs pressure_fracs (macOS 0.70/0.80/0.90) were tuned against phys_footprint; the ladder now reads mi_commit_bytes, so stages fire much later relative to process size. Re-tune in a soak. Also no test asserts the ladder reads commit (reverting lib.rs ~811 to primary_metric passes every test). Specs that still state the metric is phys_footprint: design/specs/duckplan/SPEC-interim-stabilization.md line 25, SPEC-cutover-and-release.md lines 67, 132, 204. Update via specgrep. Also KBM09XHB step-5 line and WKLD508O line. Parent TRDD-2HRA270Y step 4.

## Approval log

- 2026-10-22T19:35:30+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
