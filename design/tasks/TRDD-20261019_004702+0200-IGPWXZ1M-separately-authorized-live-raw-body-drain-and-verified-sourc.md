---
trdd-id: IGPWXZ1M
title: Separately authorized live raw-body drain and verified source deletion
column: approval
status: tasked
created: 2026-10-19T00:47:02+0200
updated: 2026-10-20T01:47:15+0200
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
TWO DURABILITY GAPS FOUND AND CLOSED IN THE STORE CLI, 2026-10-20 (both verified in the Rust source, not inferred). GAP 1 - NO FSYNC BARRIER: flush_detailed (rust-core/crates/agentlens-store/src/lib.rs) writes the store parts with COPY TO and never fsyncs them; the fsync barrier in pass.rs runs ONLY when opts.durable_source is true, and the alstore CLI default is durable_source=false. The live server sets durable_source=true (chores.rs) but the CLI does not. A CLI-driven drain therefore unlinks a source file whose bytes are still only in the page cache, so a power loss loses BOTH copies. The store's own comment at pass.rs:196-197 names this exact hole. FIX: the drain MUST pass --durable-source. GAP 2 - NO AGE GATE: body_files (pass.rs) enumerates every .request.json/.response.json and captures size and mtime at enumeration, and the verify compares the reconstruction against the raw bytes read at INGEST time, not a fresh read of the file. A body that Claude Code is still writing can therefore be read complete and then grow, and the delete uses the stale size. FIX: the drain MUST pass --max-age-ms 300000 so only files untouched for 5 minutes are eligible. BOTH FLAGS WERE VERIFIED ON AN ISOLATED /tmp STORE before use: 5 bodies ingested, 5 deleted, 0 failed, 4 parquet parts written, and the reconstruction of a deleted body matched the original sha256 exactly (f206abb679f750fddaeb1237634464dc05f9a4514c69712b0c429aaf6a302dc1). These two flags are MANDATORY PRECONDITIONS of the drain command, not optional tuning: without them the delete is not durable and can race an in-flight writer.

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
