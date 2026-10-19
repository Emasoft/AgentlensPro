---
trdd-id: IGPWXZ1M
title: Separately authorized live raw-body drain and verified source deletion
column: approval
status: tasked
created: 2026-10-19T00:47:02+0200
updated: 2026-10-19T00:57:57+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: infra
min-approval-requirement: user
assignee: main-agent@agentlenspro
approved: false
approval-judge: user
approval-datetime: 2026-10-19T00:47:16+0200
derived: true
npt: []
eht: []
---

# Separately authorized live raw-body drain and verified source deletion

## WHY
Deleting the only filesystem copies is destructive even after migration succeeds; execution must therefore remain a separately user-authorized operation that deletes only individually reconciled and recovery-proven sources with an exact confirmed command.

## Scope
- Define the bounded live-drain procedure for sources whose persisted state is exactly `recovery-proven` and whose latest full reconciliation is clean.
- Recheck capacity, DuckDB checkpoint durability, byte-identical reconstruction, recovery procedure, corpus growth watermark, and source identity immediately before each deletion batch.
- Produce an exact deletion candidate manifest and exact destructive command for final user confirmation under RULE 0.
- After confirmed execution, verify each absence and persist `source-deleted` plus a deletion receipt; never infer deletion from command success alone.

## Acceptance criteria
- [ ] Card remains unapproved in `approval` until the user explicitly authorizes the exact destructive command and affected candidate manifest.
- [ ] Dry-run output lists only sources at `discovered → committed → checkpointed → reconstructed → recovery-proven` with a clean current reconciliation verdict.
- [ ] Recovery from the committed database is proven independently before deletion eligibility.
- [ ] Each executed bounded batch records exact authorization, command, timestamp, identities, bytes, pre/post free space, and post-delete verification.
- [ ] New or changed files after the audit watermark are excluded and rediscovered rather than deleted.

## Failure and refusal conditions
- Refuse without explicit final user confirmation of the exact command and affected sources.
- Refuse any source missing a state, checkpoint, reconstruction hash, recovery proof, or clean reconciliation record.
- Refuse if capacity/recovery evidence changed since approval, if the source changed, or if free-space and filesystem probes disagree.
- Stop on the first unexplained command or verification failure; never bulk-mark later sources deleted.
- The user directive to eliminate the backlog is not itself recorded as approval of a not-yet-presented destructive command.

## Out of scope
- Source discovery, schema implementation, migration execution, consumer cutover, retention policy, and deleting post-watermark arrivals.

## Relevant links
- Parent architecture: TRDD-LHCHVK9Z.
- Source identity/index: TRDD-U50JCH0J.
- DuckDB reconstruction/provenance: TRDD-TC8HW857.
- Capacity gate: TRDD-TXRRF34L.
- Migration state machine: TRDD-IFOQAQYV.
- Full reconciliation: TRDD-JK4I9MFY.
- Retention policy remains owned by TRDD-Y1M56VMY.
- Existing consumer cutover is TRDD-QSFYIHUO and is not a deletion prerequisite.

## Dependency semantics
This is a depth-one atomic execution card: `npt` and `eht` are empty and it has no `parent-trdd`.

## Approval log
- 2026-10-19T00:47:16+0200 — DESIGN CARD AUTHORIZED by user; `approved: false` means destructive execution remains unapproved pending the exact command and affected-source manifest.
- 2026-10-19T00:47:28+0200 — column → approval. Await exact final destructive command confirmation; this transition does not approve or execute deletion
