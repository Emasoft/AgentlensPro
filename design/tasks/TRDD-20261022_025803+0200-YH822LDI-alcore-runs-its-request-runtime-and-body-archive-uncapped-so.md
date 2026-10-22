---
trdd-id: YH822LDI
title: alcore runs its request runtime and body archive uncapped so digestion takes every core
column: dev
status: tasked
created: 2026-10-22T02:58:03+0200
updated: 2026-10-22T02:58:07+0200
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

Implementation in progress per docs_dev/20261022-core-cap-spec.md: one knob AGENTLENS_MAX_CORES (default 2, 1-64, invalid exits), from which the rayon pool, the request runtime (workers n, blocking 2n), the background runtime (workers n/2 min 1, blocking n) and the body-archive DuckDB threads all derive.

NEXT: build, test, deploy together with WKLD508O, then measure CPU on the live collector.

## Problem (verified 2026-10-21 by reading code)

- bin/alcore.rs:420 `tokio::runtime::Runtime::new()`: 14 workers and up to 512 blocking threads on a 14-core machine; it hosts the summary rebuild, push loop, burn tick and every spawn_blocking request handler.
- body_archive.rs:134: DuckDB at max(ncpu-2, 4) = 12 threads.
- rayon global pool pinned to 4, background runtime 2 workers + 4 blocking.

No open card owned a cap on total cores (triage report docs_dev/20261021-mem-cpu-triage.md, section 4). Nearest: RVKQDLRD (QoS, not a cap), HFV4AIT7 (the opposite goal).

## Acceptance

- One env knob; every pool size in agentlens-core derives from it; a grep shows no remaining pool sized from available_parallelism.
- Invalid AGENTLENS_MAX_CORES exits with a clear message (unit-tested).
- Live: alcore's CPU stays at or under ~200% (2 cores) in `ps` samples over a bodies pass.

## Approval log

- 2026-10-22T02:58:03+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
