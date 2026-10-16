---
trdd-id: AJGTQ007
title: DeltaLog load materializes about 7x its on-disk size, stream the replay
column: dev
status: tasked
created: 2026-10-16T23:25:39+0200
updated: 2026-10-17T01:42:19+0200
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
implementation-commits: [4493f824]
---

# DeltaLog load materializes about 7x its on-disk size, stream the replay

MEASURED 2026-10-16 (docs_dev/20261016-gva8ttjf-memory-gate-report.md, separate process, alcore's phys_footprint metric): DeltaLog::load on a 700k-record body-links log (271 MB on disk) peaks at 1993 MiB, about 2.85 KB per record against 387 B on disk. Cause, traced in delta_log.rs: read_lines holds the whole file plus a Vec<Value> of every line, replay clones every v into the IndexMap, and load re-serializes every value to hash it into self.written.

load() is shared infrastructure: it also runs on the log-sessions card snapshot in restore_from_snapshot (the refused-reuse boot path, and the first boot after upgrading from v2.33.1, per HSPUF5XH's gate box) and on the offsets log. Whether card-snapshot records inflate the same way is NOT yet measured (inferred only).

Fix direction: a streaming visitor on DeltaLog. Pass 1 indexes k to the winning file and offset and validates (one torn trailing line tolerated, as today). Pass 2 visits only winning lines. load() is rebuilt on the visitor so replay keeps ONE definition. TRDD-GVA8TTJF's install_body_links appends straight from the visitor into DuckDB.

TRAP: load() seeds self.written, and save(empty) tombstones only keys that seeding put there; the TRDD-6B7VV2Z7 B' fix depends on that. A streaming load must still seed written with hashes equal to hash_json(to_string(v)) for every writer (append, compact, heal).

## Approval log

- 2026-10-16T23:25:39+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-17T01:31:26+0200 — column → dev by main-agent@agentlenspro. a worker is implementing the streaming replay (uncommitted diff in delta_log.rs and cache_turns_sql.rs; tests running)

## Acceptance

- [ ] One cache-turns query on a 700k-record body-links log (the streamed for_each_live path into DuckDB) peaks under 300 MiB phys_footprint, and load()'s own peak is reported as a separate figure that this box does not cover (baseline: load 1993 MiB, query 2217 MiB; 300 = the streaming sketch's ~50 MB pass-1 index + DuckDB table up to ~225 MiB, both from the memory-gate report, rounded up), measured in a separate process with alcore's metric.
- [ ] load() still seeds self.written with hashes identical to hash_json(to_string(v)) for records written by append_changed, compact and heal_torn_tail (a test per writer).
- [ ] The TRDD-6B7VV2Z7 card_reuse tests (stale-version tombstone, lagging positions, no double count) and the delta_log tests all still pass.
- [ ] The real log-sessions card snapshot's load() peak is measured before and after the change (read-only, separate process).
Baseline, a fact and not a criterion (2026-10-16, docs_dev/20261016-ajgtq007-real-snapshot-report.md, copies in tmp, separate process): the real log-sessions log (74.8 MB, 41,714 records) peaks at 478.0 MiB under load(), 6.70x on disk; log-offsets (11.3 MB) peaks at 91.1 MiB. The 'after' half of this box's measurement is box 4.
- [ ] DeltaLog::load()'s own peak on n700000 is measured and is at most half its 1993 MiB baseline, since the old peak held the raw bytes, every line's Value and a clone of each v, and the streamed replay holds one map (at most 997 MiB; the target is reasoned, not measured, and may only be made STRICTER after measuring — loosening it needs a separate owner decision recorded on this card before the box can be ticked).

## Notes and lessons learned

2026-10-16: priority. The real card-snapshot load costs 478 MiB, about 23% of the 2048 MiB cap, on every refused-reuse boot. It is not the IMMEDIATE trigger: the load-time spike rarely coincides with a death, since only 28 of 1,539 logged cap deaths fall in the first 30 s of uptime (worker count from server.log, read-only). Unmeasured: its share of the steady footprint, and the death rate on refused-reuse boots specifically (load() runs only on those; the 1,539 mix reused and refused boots, and splitting them by the refusal or cold-rescan log lines would answer it). It stays an open hypothesis for the collector's crash loop. Whether its freed pages stay committed in mimalloc and raise the steady footprint is inferred, not measured. So the card is not by itself a release blocker, but it eats about a quarter of the headroom on the upgrade boot HSPUF5XH gates. The 1.1 GB synthetic 700k/1.4M dataset is at $TMPDIR/gva8-memgate (OS tmp, may be purged); the harness that rebuilds it is scripts_dev/gva8ttjf_memgate/.
2026-10-16: deaths split by boot type (read-only, a copy of server.log; docs_dev/20261016-ajgtq007-deaths-by-boot-type.md, worker-parsed). Boots that REUSED cards.duckdb died at the cap in 565 of 569 starts (median uptime 1.9 min); boots that REFUSED it, the only ones that run load() on the card snapshot, died in 10 of 11 (median 2.4 min). The crash loop happens without this card's load, so this card is not its cause. 11 refused boots are too few to rule out a moderate added effect.
2026-10-17: box 1 reworded the same day it was written. load() returns the whole map by contract, so only the streamed query path can reach 300 MiB; load()'s reduction is measured separately. Out of scope but recorded: compact() holds the records, the whole new snapshot body and a second replayed map, which is likely about 2 GB for a 700k body-links log at boot (inferred, being measured).
2026-10-17 after 4493f824 (two-pass streaming replay), worker-measured on n700000 in separate processes, docs_dev/20261017-ajgtq007-streaming-report.md. Query 2311.6 to 780.7 MiB: the replay is 98.6 MiB and the remaining roughly 680 MiB is DuckDB (the in-memory body_links table and query). Box 1 is NOT met. load() 1995.2 to 1564.5 MiB, because it still returns a map of serde Values; box at 997 MiB NOT met. compact() peaks at 3337.3 MiB, unchanged and over the cap: a boot that compacts a 700k body-links log would die. That is a real boot risk once body-links grows (live has none today). Next candidates, none started: (a) DuckDB, with a memory_limit and temp spill, or not materializing the table; (b) load() holding raw JSON strings or RawValue instead of Value, if callers allow; (c) compact() streaming from the replay into the new snapshot without a second full map. The review's heal-between-passes concern does not hold: heal only appends a newline, and pass 2 reads up to pass 1's length (worker's reading of the code). CI installs toolchain stable and local rustc is 1.97, so is_none_or is fine.
