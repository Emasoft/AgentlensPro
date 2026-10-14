---
trdd-id: 0BDOV3WC
title: A DuckDB out-of-memory read at boot makes the card store delete cards.duckdb and can lose cards
column: todo
status: tasked
created: 2026-10-15T01:29:03+0200
updated: 2026-10-15T01:43:36+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T01:29:03+0200
project-id: agentlenspro
---

# A DuckDB out-of-memory read at boot makes the card store delete cards.duckdb and can lose cards

## Problem
At boot, `try_reuse`/`load_resident` read the cards table at the 256 MiB DuckDB memory limit. When that read hits DuckDB out-of-memory, the store logs "card store NOT reusing cards.duckdb (the cards table is unreadable: Out of Memory ...)", DELETES the database and rebuilds it from the NDJSON snapshot plus delta. That snapshot can lag the offsets (offsets save every 60 s and cards every 5 min (log_reader.rs:833-834, read); recent runs died at 5-11 min under the RSS hard cap (per the facts fork)), so the rebuild can lose cards whose files read as unchanged.

## Evidence (main-agent reads of server.log and the code, plus reports_dev/poison-fix-facts.md, 2026-10-15)
- VERIFIED by the main agent (server.log read 2026-10-15): 8 of the last 10 "NOT reusing" decisions were out-of-memory (2026-10-03 16:43 through 2026-10-14 14:13); the other two (2026-10-03) were a missing meta table.
- VERIFIED by the main agent: at 11:00:39 the store reused 42,637 cards; the 11:06:04 refusal was followed by "restored 41,619 session cards" at 11:08:08, and the 14:13:14 refusal again by "restored 41,619 session cards" at 14:14:27, the same count both times, so the NDJSON fallback had apparently not advanced between those restores (equal counts do not prove equal content) (why is INFERRED: runs dying before their first 5-minute cards save).
- INFERRED: that those cards were lost rather than legitimately pruned, and that the cause is the snapshot lagging the offsets. TRDD-9VX3WTGU's ordering contract protects only the REUSE path, not this fallback.
- INFERRED: which statement hit the OOM (`try_reuse` count or `load_resident` scan); both emit the same message.

## Fix direction (to be proposed and reviewed)
- Treat a DuckDB out-of-memory error as transient, never as corruption: do not delete a database that failed to READ for lack of memory.
- Avoid the SQL `ORDER BY seq` over the whole table at boot (sort by seq in Rust, or stream).
- TRDD-DA0GN1CS commit 2 (exit on any panic) must not land before this card: every restart re-runs this path.

## Acceptance
- [ ] The failing statement is identified from a reproduction, not inferred.
- [ ] An out-of-memory read never deletes cards.duckdb; a test forces the OOM (small memory_limit) and asserts the file survives and the next boot reuses it.
- [ ] A test proves no card is lost across an OOM refusal.

## Approval log

- 2026-10-15T01:29:03+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
