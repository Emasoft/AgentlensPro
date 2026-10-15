---
trdd-id: MEPIRHI4
title: demote_cold can stall silently when one card keeps failing and its UPDATE memory at 256 MiB is unmeasured
column: todo
status: tasked
created: 2026-10-15T11:13:54+0200
updated: 2026-10-15T11:13:54+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T11:13:54+0200
---

# demote_cold can stall silently when one card keeps failing and its UPDATE memory at 256 MiB is unmeasured

## Problem
Derived from the f9e0742e review (TRDD-KMF02UEX, now archived; these residuals had no open card). (1) demote_cold aborts its loop on the first failing card, so one card that cannot be fetched, parsed or UPDATEd fails every ingest batch forever, ahead of every later candidate; while it lasts no timeline is stripped and resident memory grows; the only signals are one log line and the degradations counter alcore.demoteColdError. (2) The per-card UPDATE memory at the production limit of 256 MiB with 80 KB to 2.3 MB cards is unmeasured; with 4 KB timeline entries, no tested memory limit let the old read fail while demote_cold succeeded, because the per-card UPDATEs needed more (reports_dev/kmf02uex-impl-report.md, T4 probe). (3) A resident entry missing from parsed is skipped silently after its UPDATE (unchanged behaviour).

## Fix direction
Measure the UPDATE path at 256 MiB on a large-r30 copy. Decide skip-and-continue (count the bad card, demote the rest) versus abort, and pin the choice with a test that makes one card fail.

## Acceptance
- [ ] demote_cold UPDATE-path memory at 256 MiB is measured on a large-r30 copy and recorded.
- [ ] One failing card does not stop the demotion of the others, or the card records why aborting is kept; a test pins the behaviour.

## Approval log

- 2026-10-15T11:13:54+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
