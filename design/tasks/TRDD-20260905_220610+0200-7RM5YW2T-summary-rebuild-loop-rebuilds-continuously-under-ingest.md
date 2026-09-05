---
trdd-id: 7RM5YW2T
title: The 25 ms summary rebuild loop rebuilds the whole window continuously under ingest and is the mimalloc churn
column: dev
created: 2026-09-05T22:06:10+0200
updated: 2026-09-05T22:06:10+0200
current-owner: main-session
task-type: bugfix
priority: critical
min-approval-requirement: none
scope: project
project-id: agentlenspro
parent-trdd: 7YPQWKPG
related: [7YPQWKPG, 768NEX6E, 2R36W8Q1, YILE6N3T]
relevant-files: [rust-core/crates/agentlens-core/src/ui.rs]
labels: [rust-core, memory, cpu, summary-rebuild]
---

# The 25 ms summary rebuild loop rebuilds the whole window continuously under ingest and is the mimalloc churn

Same USER directive as TRDD-YILE6N3T (2026-09-05 22:00, "why is alcore using 17 GB … why is it so
slow … fix all this"). This is the second same-day slice; the architecture is TRDD-7YPQWKPG,
advisor step 1.

## Measured / read — ✓ VERIFIED

- `run_summary_rebuild` (`ui.rs:117-129`) ticks every **25 ms** and calls `rebuild_once`, which
  rebuilds whenever `data_version` moved since the cached summary. Ingest bumps `data_version` on
  every payload (~22 spans/s today, ~6.7 bumps/s measured by UTFVMVT8), so under any ingest the
  loop rebuilds **back-to-back**: each pass snapshots the whole window (570k `Arc<Value>` today,
  TRDD-YILE6N3T) plus a clone of `log_sessions` (32.6k cards), builds a full card summary, swaps it
  in, drops the previous one.
- The 768NEX6E box-4 sizing (`reports/trdd-768nex6e/20260902_220716+0200-box4-heap-by-structure.md`)
  found every bounded structure sums to < 1 GB and named this churn as the dominant holder of the
  7.5–8.8 GB mimalloc heap, which mimalloc never decommits. Today: 8.7 GB resident mimalloc,
  13.1 GB footprint, 21.3 GB peak, 84% of a core 20 min after boot.
- The read-your-writes contract that constrains any fix: `POST /v1/traces` then `GET /api/summary`
  within `STALE_BUDGET_MS` = 500 ms must see the write (`ui.rs:134`, the CI test cited at
  `ui.rs:289-300`). A reader that misses the cache waits up to 500 ms for an in-flight rebuild,
  else serves `cached_any`.

## The fix (advisor step 1, ponytail-sized)

Rate-limit rebuilds by their own cost instead of polling every 25 ms: after a pass that took `d`,
do not start another for `max(250 ms, k × d)` (k = 4, one constant) unless a READER is waiting on
the gate (the RYW path already blocks on the gate for up to 500 ms — a reader arriving inside the
back-off must trigger the rebuild it needs, so RYW keeps holding at small windows where `d` is
milliseconds). At today's sizes a 20 s rebuild gets an 80 s gap: churn ÷ ~4000, CPU released. No
new thread, no new lock: one `Instant` + one `Duration` next to the existing gate. Do NOT move the
trigger to the 5 s chores tick alone — that breaks RYW at small windows.

Keep the rebuild OFF the state lock as today. Add a unit test on the back-off arithmetic and keep
the existing RYW CI test green.

## Acceptance

- [ ] `rebuild_once` is skipped while inside the cost-scaled back-off unless a reader is waiting;
      unit-tested.
- [ ] `pnpm`/cargo RYW test (`POST /v1/traces` → `GET /api/summary` ≤ 500 ms) still green.
- [ ] Live after deploy, 15 min: CPU of alcore ≤ 15% of a core at today's ingest rate (was 84%),
      mimalloc resident ≤ 2 GB (was 8.7 GB) — `vmmap --summary` and `ps`, numbers recorded here.

## Notes and lessons learned

## Approval log

- 2026-09-05T22:06:10+0200 — Authored into `dev` (Tier 0 bugfix under the USER-approved parent
  7YPQWKPG; worker dispatched the same turn).
