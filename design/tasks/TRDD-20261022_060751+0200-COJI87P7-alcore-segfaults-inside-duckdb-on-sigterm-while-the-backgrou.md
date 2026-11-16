---
trdd-id: COJI87P7
title: alcore segfaults inside DuckDB on SIGTERM while the background thread is still scanning
column: todo
status: tasked
created: 2026-10-22T06:07:51+0200
updated: 2026-10-22T06:07:51+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-22T06:07:51+0200
---

# alcore segfaults inside DuckDB on SIGTERM while the background thread is still scanning

Measured 2026-10-22 (docs_dev/20261022-091Z1FU0-ab-result.md section 4): all four isolated alcore runs, binaries 44bc67e1 and 04988cef alike, ended by SIGSEGV about 8 s after SIGTERM (Popen return code -11). macOS crash reports ~/Library/Logs/DiagnosticReports/alcore-2026-10-22-055446.ips, -055739, -060031, -060323: EXC_BAD_ACCESS KERN_INVALID_ADDRESS at 0x0, faulting thread alcore-bg, top frames duckdb::Allocator::AllocateData / AllocatedData destructor, old1 stack through PhysicalTableScan and ParquetReader::Scan. Two earlier crashes the same day (alcore-2026-10-22-041709.ips, -043338.ips) fault in duckdb_parquet PageHeader::read on the same thread. INFERRED, not verified: the shutdown path tears down the DuckDB database or allocator while alcore-bg is mid-query (a parquet scan), i.e. a missing join or cancel of the background runtime before the store is dropped. Consequences: every stop and restart of the live collector may end in a crash rather than a clean exit, and a crash mid-write could tear a store. NEXT ACTION: read the shutdown sequence in rust-core/crates/agentlens-core/src/bin/alcore.rs and lib.rs (signal handling, background runtime shutdown, store drop order), and check whether the live collector's own exits (TRDD-2JOIAH2G culprit log) also end in SIGSEGV.

## Approval log

- 2026-10-22T06:07:51+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
