---
trdd-id: 23TSWT9M
title: A body present in two parts files reconstructs with every row doubled and is parked forever
column: backburner
status: tasked
created: 2026-10-23T02:43:20+0200
updated: 2026-10-23T03:28:43+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-23T02:43:20+0200
---

# A body present in two parts files reconstructs with every row doubled and is parked forever

Reachable when a bodies part is deleted out of band (its body_durable rows leave), the body is re-ingested and its sections are written into a second parts file. all_of(part) and part_fetch_sql then return both files' rows, reconstruct doubles every section, the sha gate refuses (RECONSTRUCTION MISMATCH) and the source file is kept, so no data is lost but the body never verifies. Pinned by tests/known_part.rs a_body_in_two_parts_files_is_named_by_both_and_the_gate_refuses_the_doubled_rows; the reachable path is pinned by `a_vanished_bodies_file_makes_a_re_ingest_write_the_parts_again`. Fix candidates: dedup rows per (body_id, pos) in the statements A and C queries, or skip writing parts for a body whose parts are already indexed. Found during TRDD-1FWN9XBS Change 1.

## Approval log

- 2026-10-23T02:43:20+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Out-of-band delete family

Same out-of-band-delete family: when a parts file vanishes, sync removes its known_part rows but the body's body_durable row (keyed by the bodies file) survives, so ingest dedup never re-writes its parts and every later reconstruct of that body falls back to the full parts scan, logs a line and returns unknown body, permanently (TRDD-1FWN9XBS Change 1 review).
Status of the mechanism: VERIFIED by tests in tests/known_part.rs, in process only (not tested across a store reopen). Bodies file deleted: a_vanished_bodies_file_makes_a_re_ingest_write_the_parts_again passes; the re-ingest writes its parts to a second file, the body is named by both files, the original file survives, and reconstruct refuses the doubled rows with RECONSTRUCTION MISMATCH. Parts file deleted: a_vanished_parts_file_leaves_its_body_unknown_and_a_re_ingest_writes_nothing passes; the read falls back once and returns unknown body, and the re-ingest stages no parts. No test asserts the fallback log line.
