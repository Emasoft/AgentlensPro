---
trdd-id: AJGTQ007
title: DeltaLog load materializes about 7x its on-disk size, stream the replay
column: todo
status: tasked
created: 2026-10-16T23:25:39+0200
updated: 2026-10-16T23:26:02+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-16T23:25:39+0200
---

# DeltaLog load materializes about 7x its on-disk size, stream the replay

MEASURED 2026-10-16 (docs_dev/20261016-gva8ttjf-memory-gate-report.md, separate process, alcore's phys_footprint metric): DeltaLog::load on a 700k-record body-links log (271 MB on disk) peaks at 1993 MiB, about 2.85 KB per record against 387 B on disk. Cause, traced in delta_log.rs: read_lines holds the whole file plus a Vec<Value> of every line, replay clones every v into the IndexMap, and load re-serializes every value to hash it into self.written.

load() is shared infrastructure: it also runs on the log-sessions card snapshot in restore_from_snapshot (the refused-reuse boot path, and the first boot after upgrading from v2.33.1, per HSPUF5XH's gate box) and on the offsets log. Whether card-snapshot records inflate the same way is NOT yet measured (inferred only).

Fix direction: a streaming visitor on DeltaLog. Pass 1 indexes k to the winning file and offset and validates (one torn trailing line tolerated, as today). Pass 2 visits only winning lines. load() is rebuilt on the visitor so replay keeps ONE definition. TRDD-GVA8TTJF's install_body_links appends straight from the visitor into DuckDB.

TRAP: load() seeds self.written, and save(empty) tombstones only keys that seeding put there; the TRDD-6B7VV2Z7 B' fix depends on that. A streaming load must still seed written with hashes equal to hash_json(to_string(v)) for every writer (append, compact, heal).

## Approval log

- 2026-10-16T23:25:39+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Acceptance

- [ ] DeltaLog::load on a 700k-record body-links log peaks under 300 MiB phys_footprint (baseline 1993 MiB), measured in a separate process with alcore's metric.
- [ ] load() still seeds self.written with hashes identical to hash_json(to_string(v)) for records written by append_changed, compact and heal_torn_tail (a test per writer).
- [ ] The TRDD-6B7VV2Z7 card_reuse tests (stale-version tombstone, lagging positions, no double count) and the delta_log tests all still pass.
- [ ] The real log-sessions card snapshot's load() peak is measured before and after the change (read-only, separate process).
