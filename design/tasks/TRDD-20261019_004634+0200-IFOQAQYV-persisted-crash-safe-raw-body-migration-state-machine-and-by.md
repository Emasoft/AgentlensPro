---
trdd-id: IFOQAQYV
title: Persisted crash-safe raw-body migration state machine and byte-bounded runner
column: todo
status: tasked
created: 2026-10-19T00:46:34+0200
updated: 2026-10-19T00:57:56+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: user
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-19T00:46:34+0200
derived: true
npt: []
eht: []
---

# Persisted crash-safe raw-body migration state machine and byte-bounded runner

## WHY
A 191.84 GiB actively growing corpus cannot be migrated as one fragile run; progress must survive process and machine failure, remain capacity-bounded, and make every source transition explicit and replay-safe.

## Scope
- Implement persisted per-source states `discovered`, `committed`, `checkpointed`, `reconstructed`, `recovery-proven`, and `source-deleted` with monotonic guarded transitions.
- Build a byte-bounded runner that selects only work admitted by the measured capacity gate and commits bounded batches directly to native DuckDB.
- Resume idempotently after crashes at every transition and DuckDB transaction/checkpoint boundary.
- Separate migration completion from deletion authorization so the runner cannot delete merely because ingestion succeeded.

## Acceptance criteria
- [ ] Fault injection at every state transition and transaction/checkpoint boundary resumes without data loss, double-accounting, or invalid advancement.
- [ ] Every source follows `discovered → committed → checkpointed → reconstructed → recovery-proven`; `source-deleted` is impossible without the separately authorized drain.
- [ ] Work selection is bounded by source bytes and projected peak bytes, not only by file count.
- [ ] The runner tolerates corpus growth and converges over a stable snapshot while admitting later discoveries separately.
- [ ] Progress, refusal reason, retry state, and last durable boundary are inspectable without reading transient logs.

## Failure and refusal conditions
- Refuse backward, skipped, or ambiguous transitions.
- Refuse a batch not admitted by the current capacity gate.
- Stop before later work on a checkpoint, reconstruction, provenance, or recovery-proof mismatch.
- Never delete a source and never treat consumer cutover as a prerequisite for migration.

## Out of scope
- Storage schema, source discovery implementation, capacity benchmarking, consumer cutover, retention policy, final reconciliation, and live deletion execution.

## Relevant links
- Parent architecture: TRDD-LHCHVK9Z.
- Source identity/checkpoints: TRDD-U50JCH0J.
- Direct DuckDB schema/reconstruction: TRDD-TC8HW857.
- Capacity gate: TRDD-TXRRF34L.
- Existing consumer cutover, not critical path: TRDD-QSFYIHUO.
- Reconciliation and live-drain cards will be linked after minting.
- Full reconciliation: TRDD-JK4I9MFY; separately authorized live drain: TRDD-IGPWXZ1M; retention owner: TRDD-Y1M56VMY.

## Dependency semantics
This is a depth-one atomic implementation card: `npt` and `eht` are empty and it has no `parent-trdd`.

## Approval log

- 2026-10-19T00:46:34+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
