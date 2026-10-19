---
trdd-id: U50JCH0J
title: Raw-body source identity and incremental index checkpoint substrate
column: todo
status: tasked
created: 2026-10-19T00:45:50+0200
updated: 2026-10-19T00:57:55+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: user
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-19T00:45:50+0200
derived: true
npt: []
eht: []
---

# Raw-body source identity and incremental index checkpoint substrate

## WHY
The actively growing raw-body corpus needs stable source identity and restartable discovery before any byte can be migrated or safely removed; rescanning hundreds of thousands of files without a durable checkpoint is neither bounded nor auditable.

## Scope
- Define a collision-resistant source identity from canonical provenance and content evidence, independent of mutable path names.
- Build and maintain an append-safe incremental `index.jsonl` checkpoint substrate that discovers new and changed raw-body sources without a full rescan on every run.
- Persist enough source metadata to resume after interruption and to distinguish unchanged, replaced, truncated, and newly appended inputs.
- Make discovery idempotent and deterministic under concurrent corpus growth.

## Acceptance criteria
- [ ] Repeated discovery over an unchanged corpus emits no duplicate source identities or work.
- [ ] A crash at every checkpoint boundary resumes without omitting or duplicating a source.
- [ ] Changed, truncated, replaced, and newly created sources are classified deterministically.
- [ ] Each checkpoint is durable before later migration stages may rely on it.
- [ ] The index format is versioned, incrementally readable, and validated against a representative corpus slice.

## Failure and refusal conditions
- Refuse ambiguous identity collisions rather than choosing a source silently.
- Refuse malformed or internally inconsistent checkpoint records.
- Never mark a source discovered from path existence alone when required identity evidence cannot be read.
- Never advance a checkpoint past unpersisted discovery records.

## Out of scope
- DuckDB schema and reconstruction.
- Capacity approval, migration execution, consumer cutover, retention policy, and source deletion.

## Relevant links
- Parent architecture and backlog decomposition: TRDD-LHCHVK9Z.
- Typed storage and reconstruction card: to be linked after minting.
- Migration state-machine card: to be linked after minting.
- Reconciliation and audit card: to be linked after minting.
- Direct DuckDB schema/reconstruction: TRDD-TC8HW857; capacity gate: TRDD-TXRRF34L; migration runner: TRDD-IFOQAQYV; reconciliation: TRDD-JK4I9MFY; live drain: TRDD-IGPWXZ1M.

## Dependency semantics
This is a depth-one atomic implementation card: `npt` and `eht` are empty and it has no `parent-trdd`. Links describe coordination, not hierarchy.

## Approval log

- 2026-10-19T00:45:50+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
