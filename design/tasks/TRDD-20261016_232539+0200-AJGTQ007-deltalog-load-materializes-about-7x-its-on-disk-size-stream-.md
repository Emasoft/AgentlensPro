---
trdd-id: AJGTQ007
title: DeltaLog load materializes about 7x its on-disk size, stream the replay
column: todo
status: tasked
created: 2026-10-16T23:25:39+0200
updated: 2026-10-16T23:29:37+0200
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

- [ ] DeltaLog::load on a 700k-record body-links log peaks under 300 MiB phys_footprint (baseline 1993 MiB; 300 = the streaming sketch's ~50 MB pass-1 index + DuckDB table up to ~225 MiB, both from the memory-gate report, rounded up), measured in a separate process with alcore's metric.
- [ ] load() still seeds self.written with hashes identical to hash_json(to_string(v)) for records written by append_changed, compact and heal_torn_tail (a test per writer).
- [ ] The TRDD-6B7VV2Z7 card_reuse tests (stale-version tombstone, lagging positions, no double count) and the delta_log tests all still pass.
- [ ] The real log-sessions card snapshot's load() peak is measured before and after the change (read-only, separate process).
Baseline, a fact and not a criterion (2026-10-16, docs_dev/20261016-ajgtq007-real-snapshot-report.md, copies in tmp, separate process): the real log-sessions log (74.8 MB, 41,714 records) peaks at 478.0 MiB under load(), 6.70x on disk; log-offsets (11.3 MB) peaks at 91.1 MiB. The 'after' half of this box's measurement is box 4.

## Notes and lessons learned

2026-10-16: priority. The real card-snapshot load costs 478 MiB, about 23% of the 2048 MiB cap, on every refused-reuse boot. It is not the IMMEDIATE trigger: the load-time spike rarely coincides with a death, since only 28 of 1,539 logged cap deaths fall in the first 30 s of uptime (worker count from server.log, read-only). Unmeasured: its share of the steady footprint, and the death rate on refused-reuse boots specifically (load() runs only on those; the 1,539 mix reused and refused boots, and splitting them by the refusal or cold-rescan log lines would answer it). It stays an open hypothesis for the collector's crash loop. Whether its freed pages stay committed in mimalloc and raise the steady footprint is inferred, not measured. So the card is not by itself a release blocker, but it eats about a quarter of the headroom on the upgrade boot HSPUF5XH gates. The 1.1 GB synthetic 700k/1.4M dataset is at $TMPDIR/gva8-memgate (OS tmp, may be purged); the harness that rebuilds it is scripts_dev/gva8ttjf_memgate/.
