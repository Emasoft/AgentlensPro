---
trdd-id: R36S0PS9
title: known_part seed in open_store exhausts the 4 GB DuckDB spill cap on the real store so every store open fails
column: backburner
status: tasked
created: 2026-10-23T03:42:13+0200
updated: 2026-10-23T03:42:13+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-23T03:42:13+0200
---

# known_part seed in open_store exhausts the 4 GB DuckDB spill cap on the real store so every store open fails

Regression from TRDD-1FWN9XBS Change 1 (685bf1fe). Measured 2026-10-23 on the clone (docs_dev/20261023-change1-export-remeasure-report.md): both narrowed exports returned HTTP 500 after 22 s cold / 15 s warm with DuckDB 'Out of Memory Error: failed to offload data block ... (3.7 GiB/3.7 GiB used) ... max_temp_directory_size'; the 'known_part seeded' line never printed; RSS reached 4,584,160 KB. The prior binary opened the same store. So the store cannot open at all, which also blocks the bodies pass (see TRDD-XRTH2MEI: retried every tick). Spiller INFERRED to be index_part_bodies (lib.rs:534): no stack was taken. Its SQL differs from the shape measured in Python (docs_dev/20261023-known-part-measure.md, 175 MiB peak) by a LEFT JOIN instead of JOIN and a correlated WHERE NOT EXISTS against known_part evaluated per parts ROW before DISTINCT; parts rows are many per body, so the anti-join materializes far more than the 1.5M distinct pairs (INFERRED). Deploy-blocking. Fix candidates to measure first: DISTINCT body_id, filename in a subquery before the join; drop NOT EXISTS (sync indexes only newly listed files); per-batch seeding. Tests missed it because fixtures are tiny: add a gate that the seed SQL runs within the store memory and spill limits on the clone.

## Approval log

- 2026-10-23T03:42:13+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
