---
trdd-id: H3D5ZBO1
title: The burn tick holds the state lock across bodies.poll, for 130-576 s on the first pass after boot
column: todo
status: tasked
created: 2026-10-15T00:41:29+0200
updated: 2026-10-28T21:24:07+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T00:41:29+0200
---

# The burn tick holds the state lock across bodies.poll, for 130-576 s on the first pass after boot

## Approval log

- 2026-10-15T00:41:29+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Findings (2026-10-15)

- bodies.poll is called at ui.rs:4173, under the state lock.
- The bodies store holds about 588k files (147 GB) in ~/.agentlens/otel-bodies.
- On the first pass after each boot it takes 130-576 s; after that it takes about 7.5 s per tick.
- It is still under the state lock at HEAD.
- It is the dominant long holder of the state lock today; TRDD-N60JUWU3's stop path starves behind it.

## Findings (2026-10-18)

2026-10-18: the 55 s hold is BodiesActivityTracker::poll (burn/bodies_activity.rs:247), which stats every unseen name on its first poll before the 15-min seed skip; it is also called from lib.rs:647. Footprint grew only ~55 MB during the hold, so moving it off the lock relieves lock starvation but is not shown to lower the memory peak. Skipping the first-poll stat would empty the burn-risk and warm-disarm evidence for 15 min after each restart.

## Live evidence 2026-10-28

735Q3JF4 deferred run A (real-data copy, log scan on, 185636 body files): a 12.6 s state-lock hold at ui.rs:4426 at up ~0 made three waiters (ui.rs:948, ui.rs:262, chores.rs:69) wait 12.5 s (docs_dev/20261028_211829+0100-735Q3JF4-deferred-measurements.md).
