---
trdd-id: JK4I9MFY
title: Full raw-body migration manifest reconciliation and audit tooling
column: todo
status: tasked
created: 2026-10-19T00:46:49+0200
updated: 2026-10-19T00:57:56+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: audit
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: user
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-19T00:46:49+0200
derived: true
npt: []
eht: []
---

# Full raw-body migration manifest reconciliation and audit tooling

## WHY
Per-source success is insufficient for a destructive drain: an independent full reconciliation must prove that the discovery manifest, persisted migration states, DuckDB provenance, reconstruction evidence, and remaining filesystem sources describe exactly the same corpus.

## Scope
- Build full manifest reconciliation across the incremental source index, on-disk corpus, migration state machine, DuckDB raw/typed provenance, reconstruction proofs, and deletion receipts.
- Detect omissions, duplicates, identity collisions, stale checkpoints, unexpected sources, byte/hash/count mismatches, and illegal state combinations.
- Produce a deterministic machine-readable audit artifact and a concise human gate summary before and after any drain batch.
- Reconcile a fixed audit watermark separately from files that arrive after it.

## Acceptance criteria
- [ ] A clean fixed-watermark corpus reconciles source-for-source, byte-for-byte, and state-for-state.
- [ ] Seeded omission, duplicate, hash mismatch, stale index, illegal transition, post-watermark arrival, and orphaned DuckDB row are each detected.
- [ ] Audit output names every discrepant source identity and the evidence sets that disagree.
- [ ] The audit can be rerun idempotently after a crash and yields the same verdict for the same durable state.
- [ ] Live drain cannot select a source unless the latest full reconciliation marks it recovery-proven and deletion-eligible.

## Failure and refusal conditions
- Any unexplained mismatch is a hard refusal, never a warning or sampled exception.
- Refuse reconciliation when an evidence set is unavailable, stale, partially read, or lacks a fixed watermark.
- Refuse aggregate-only proof that cannot identify each source.
- Never repair, migrate, or delete data as a side effect of audit.

## Out of scope
- Source discovery, DuckDB schema, migration execution, consumer cutover, retention implementation, and deletion itself.

## Relevant links
- Parent architecture: TRDD-LHCHVK9Z.
- Source index: TRDD-U50JCH0J.
- DuckDB reconstruction/provenance: TRDD-TC8HW857.
- Capacity gate: TRDD-TXRRF34L.
- Migration state machine: TRDD-IFOQAQYV.
- Retention owner: TRDD-Y1M56VMY.
- Live-drain card will be linked after minting.
- Separately authorized live drain: TRDD-IGPWXZ1M; existing consumer cutover, not critical path: TRDD-QSFYIHUO.

## Dependency semantics
This is a depth-one atomic implementation card: `npt` and `eht` are empty and it has no `parent-trdd`.

## Approval log

- 2026-10-19T00:46:49+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
