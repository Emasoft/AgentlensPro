---
trdd-id: 60DMZD2N
title: alcore request handlers block async workers with sleeps and fsyncs under the state mutex
column: todo
status: tasked
created: 2026-10-22T03:49:02+0200
updated: 2026-10-22T03:49:06+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-22T03:49:02+0200
project-id: agentlenspro
---

# alcore request handlers block async workers with sleeps and fsyncs under the state mutex

## Problem (read from code 2026-10-22, not measured; source docs_dev/20261022-core-cap-report.md Round 3 item D)

TRDD-YH822LDI caps the request runtime at 2 async workers, the user's "2 cores, strict" ruling. With 14 workers the following were hidden. With 2 they can stall OTLP ingest and the dashboard:
- ui.rs:321 summary_now: a stale-wait loop sleeps 2 ms per iteration for up to STALE_BUDGET_MS = 500 (ui.rs:138, :370) on the calling async worker, and does an inline rebuild on cold boot (ui.rs:397, :417). It is called synchronously from about 23 routes in ui.rs, from push_update (ui.rs:525, called at :4394 from run_push_loop) and from run_burn_tick (ui.rs:4219).
- run_burn_tick, ui.rs:4209, runs on the request runtime. Under the state mutex: st.burn.bodies.poll (bodies_activity.rs:247: read_dir, metadata, file reads; its comment cites 100 to 400 ms) and st.statusline.flush (statusline_store.rs:325-345: open, write_all, sync_all). On a 60 s cache miss: burn/runtime.rs slow() reads files under the mutex.
- OTLP handle, lib.rs:1216: ingest_parsed runs under a std Mutex on the async worker. body_links.append_changed (delta_log.rs:837) and persist_dropped_log_event do synchronous file appends, and writer.append at its high-water mark calls flush (agentlens-spanstore writer.rs:476-537), which runs sync_all under the lock.

## Fix direction

Move blocking work off the async workers. Call summary_now and push_update through spawn_blocking, or make the stale wait async with tokio::time::sleep. Move the fsyncs and file reads out of the mutex. Each move needs its own measured before and after.

## Acceptance

- Under a burst of dashboard and MCP requests at AGENTLENS_MAX_CORES=2, OTLP POST latency p99 stays under 1 s and the exporter shows no drops or retries.
- No std::thread::sleep and no sync_all is reachable from an async fn on the request runtime. Verify with a grep, plus a guard test if practical.

## Approval log

- 2026-10-22T03:49:02+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
