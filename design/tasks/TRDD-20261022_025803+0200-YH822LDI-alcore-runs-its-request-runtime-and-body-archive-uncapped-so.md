---
trdd-id: YH822LDI
title: alcore runs its request runtime and body archive uncapped so digestion takes every core
column: dev
status: tasked
created: 2026-10-22T02:58:03+0200
updated: 2026-10-22T04:05:34+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-22T02:58:03+0200
project-id: agentlenspro
---

# alcore runs its request runtime and body archive uncapped so digestion takes every core

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-10-22

USER, 2026-10-21, verbatim: "give priority to the TRDD involving the issue of memory exhaustion and cpu core usage at 100%, because clearly those agentlenspro processes digesting the logs and the row bodies are still inefficient, slow and not capped in terms of cores." Decision, verbatim answer to "How many cores may alcore use in total?": "2 cores, strict".

Implementation in progress per docs_dev/20261022-core-cap-spec.md, AMENDED 2026-10-22 after review: one knob AGENTLENS_MAX_CORES (default 2, 1-64, invalid exits). Derived: rayon pool n; request runtime workers n with blocking ceiling 64 (blocking threads mostly wait; a ceiling of 2n could starve the span/account flushes); background runtime workers max(n/2,1), blocking n; every alcore DuckDB connection's threads = duckdb_threads() = max(n/2,1) (DuckDB threads multiply with concurrent connections, so pool sizes alone do not bound CPU). A shutdown_flush test failure blocks the change. Boot-to-listen time is measured at n=2 and n=4. Code comments carry the placeholder TRDD-CORECAP, to be replaced by TRDD-YH822LDI before commit.

STATUS 2026-10-22: per-pool caps landed (commit carries this id). The knob lives in agentlens-store::cores, re-exported by agentlens-core, because agentlens-core depends on the store and not the reverse. transcript_sql.rs keeps threads = 1 (a memory bound; 1 is at or under any cap). Guard test tests/core_cap_guard.rs (5 tests, each rule shown to fail). NOT established: the process total. Per-pool caps sum above 2 (rayon n + request workers n + background max(n/2,1) + max(n/2,1) per DuckDB connection), request blocking threads (up to 64) are uncapped, and child processes (security, ps, lsof, claude --version, aldigest under --ingest-manifest) are outside the cap. Trade-offs accepted under the ruling: the boot scan runs on 2 rayon threads (was 4), and at the default the bodies pass, card compaction and archive export run DuckDB on 1 thread (were 2, 2 and 12); the background blocking pool is 2 (was 4). The request runtime is held at 2 workers per the ruling; blocking work on those workers is TRDD-60DMZD2N. Review recommended 4 workers until 60DMZD2N lands, rejected because it overrides the user's 2-core ruling. NEXT: build into bin-native, codesign, deploy with WKLD508O. The live gate is CPU at or under 200% in ps over a bodies pass AND a burst of dashboard and MCP requests, plus OTLP POST latency and exporter drops/retries, plus dashboard/MCP response time and boot-to-listen time; CPU alone cannot see a stall.

## Problem (verified 2026-10-21 by reading code)

- bin/alcore.rs:420 `tokio::runtime::Runtime::new()`: 14 workers and up to 512 blocking threads on a 14-core machine; it hosts the summary rebuild, push loop, burn tick and every spawn_blocking request handler.
- body_archive.rs:134: DuckDB at max(ncpu-2, 4) = 12 threads.
- rayon global pool pinned to 4, background runtime 2 workers + 4 blocking.

No open card owned a cap on total cores (triage report docs_dev/20261021-mem-cpu-triage.md, section 4). Nearest: RVKQDLRD (QoS, not a cap), HFV4AIT7 (the opposite goal).
- About a dozen DuckDB sites each set threads=1 or 2 per connection (triage report section 2.1); with several concurrent connections they alone exceed 2 cores, so they are in scope.

## Acceptance

- One env knob; every pool size in agentlens-core derives from it; a grep shows no remaining pool sized from available_parallelism.
- Invalid AGENTLENS_MAX_CORES exits with a clear message (unit-tested).
- Live: alcore's CPU stays at or under ~200% (2 cores) in `ps` samples over a bodies pass.
- Grep check: every DuckDB threads setting reachable from alcore (SET threads / a threads argument in rust-core/crates/agentlens-core/src and the agentlens-store calls alcore makes) takes crate::cores::duckdb_threads(); the alstore and aldigest CLI binaries are excluded.

## Approval log

- 2026-10-22T02:58:03+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
