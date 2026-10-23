---
trdd-id: R36S0PS9
title: known_part seed in open_store exhausts the 4 GB DuckDB spill cap on the real store so every store open fails
column: testing
status: tasked
created: 2026-10-23T03:42:13+0200
updated: 2026-10-23T04:18:43+0200
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
implementation-commits: [2405b7b3]
---

# known_part seed in open_store exhausts the 4 GB DuckDB spill cap on the real store so every store open fails

Regression from TRDD-1FWN9XBS Change 1 (685bf1fe). Measured 2026-10-23 on the clone (docs_dev/20261023-change1-export-remeasure-report.md): both narrowed exports returned HTTP 500 after 22 s cold / 15 s warm with DuckDB 'Out of Memory Error: failed to offload data block ... (3.7 GiB/3.7 GiB used) ... max_temp_directory_size'; the 'known_part seeded' line never printed; RSS reached 4,584,160 KB. The prior binary opened the store in the narrowed run (2026-10-22 23:51); that the store state is unchanged since is INFERRED (no store-dir counts or tmp-dir size were recorded). So the store appears unable to open (INFERRED from the missing seed line and the HTTP 500; nothing logs an open failure on the export path), which, if the failure is deterministic, also blocks the bodies pass (see TRDD-XRTH2MEI: retried every tick). Spiller INFERRED to be index_part_bodies (lib.rs:534): no stack was taken. Its SQL differs from the shape measured in Python (docs_dev/20261023-known-part-measure.md, 175 MiB peak) by a LEFT JOIN instead of JOIN and a correlated WHERE NOT EXISTS against known_part evaluated per parts ROW before DISTINCT; parts rows are many per body, so the anti-join materializes far more than the 1.5M distinct pairs (INFERRED). Deploy-blocking. Fix candidates to measure first: DISTINCT body_id, filename in a subquery before the join; drop NOT EXISTS (sync indexes only newly listed files); per-batch seeding. Tests missed it because fixtures are tiny: add a gate that the seed SQL runs within the store memory and spill limits on the clone.

## Approval log

- 2026-10-23T03:42:13+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Review 2026-10-23

Discriminating checks running: alstore pre/post-Change-1 open A/B on fresh store copies with tmp cleared (docs_dev/20261023-alstore-open-ab-report.md, pending), and per-step open_store timing plus seed variants V0-V4 incl. an inner-join/no-NOT-EXISTS baseline under alcore's SETs (docs_dev/20261023-seed-spill-measure-report.md, pending). Regression gate to add with the fix: a synthetic store test with many parts rows per body under a small memory_limit and max_temp_directory_size, mutation-checked against the current seed SQL.
Both reports are done; results in the Fix section below.

## Fix 2026-10-23

- Cause established: the original seed SQL (DISTINCT outside the join plus a correlated NOT EXISTS on known_part) fails alone in a bare DuckDB under alcore's SETs (V0 fails; V1/V2/V4 without NOT EXISTS pass); alstore opened before Change 1 and fails after it.
- Fix: INSERT INTO known_part SELECT unhex(s.body_id), pf.id FROM (SELECT DISTINCT body_id, filename FROM read_parquet(...)) s LEFT JOIN part_file pf ON pf.path = s.filename; no NOT EXISTS. Regression test: index_part_bodies_spill_tests::seeding_many_rows_per_body_stays_within_a_tiny_spill_cap (4 files x 1.25M rows, 1000 bodies, 32MB spill cap; mutation-verified: the old SQL fails it with a max_temp_directory_size error).
- Real-store gate re-run (alstore, 1536MB, 2 threads, cloned store, valid-hex absent id of 64 zeros): opens OK, 'known_part seeded: 1508499 rows from 10048 parts files in 10.0s', peak tmp 0 KB, wall 23.95s, max RSS (whole-process alstore, includes DuckDB at its 1536MB limit) 2944614400 bytes, exit 2 (stderr 'alstore: unknown body 0000000000000000000000000000000000000000000000000000000000000000').
- Cost note: every open now scans all ~438.8M parts rows (8.7-10.0s across the two alstore gates); at DuckDB's limit the later open steps run at 1455-1465 MiB with no spill (Python measure, pre-existing, recorded for TRDD-12FGMAEP).
