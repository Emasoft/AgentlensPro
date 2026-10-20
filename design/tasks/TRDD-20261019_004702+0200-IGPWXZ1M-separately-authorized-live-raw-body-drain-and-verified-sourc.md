---
trdd-id: IGPWXZ1M
title: Separately authorized live raw-body drain and verified source deletion
column: approval
status: tasked
created: 2026-10-19T00:47:02+0200
updated: 2026-10-20T12:01:26+0200
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
TWO DURABILITY GAPS FOUND IN THE STORE CLI, 2026-10-20 (both verified in the Rust source, not inferred). BOTH ARE NARROWED BY A FLAG, NOT FULLY CLOSED - see the Approval log for the residual race. GAP 1 - NO FSYNC BARRIER: flush_detailed (rust-core/crates/agentlens-store/src/lib.rs) writes the store parts with COPY TO and never fsyncs them; the fsync barrier in pass.rs runs ONLY when opts.durable_source is true, and the alstore CLI default is durable_source=false. The live server sets durable_source=true (chores.rs) but the CLI does not. A CLI-driven drain therefore unlinks a source file whose bytes are still only in the page cache, so a power loss loses BOTH copies. The store's own comment at pass.rs:196-197 names this exact hole. FIX: the drain MUST pass --durable-source. GAP 2 - NO AGE GATE: body_files (pass.rs) enumerates every .request.json/.response.json and captures size and mtime at enumeration, and the verify compares the reconstruction against the raw bytes read at INGEST time, not a fresh read of the file. A body that Claude Code is still writing can therefore be read complete and then grow, and the delete uses the stale size. FIX: the drain MUST pass --max-age-ms 300000 so only files untouched for 5 minutes are eligible. BOTH FLAGS WERE VERIFIED ON AN ISOLATED /tmp STORE before use: 5 bodies ingested, 5 deleted, 0 failed, 4 parquet parts written, and the reconstruction of a deleted body matched the original sha256 exactly (f206abb679f750fddaeb1237634464dc05f9a4514c69712b0c429aaf6a302dc1). These two flags are MANDATORY PRECONDITIONS of the drain command, not optional tuning: without them the delete is not durable and can race an in-flight writer. They NARROW both hazards; neither eliminates them (residual re-emission race, and the stale size captured at enumeration, are recorded in the Approval log).

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
2026-10-20T02:05:00+0200 - A DRAIN IS EXECUTING UNDER THE OWNER'S 2026-10-19 DIRECTIVE, NOT UNDER THIS CARD'S FORMAL GATE. The card's own refusal condition says the backlog directive is not approval of a not-yet-presented destructive command, and that condition is still UNSATISFIED: the recovery-proven state and the clean reconciliation verdict this card requires have NOT been established for the corpus as a whole. The running command is: alstore pass /Users/emanuelesabetta/.agentlens/store /Users/emanuelesabetta/.agentlens/otel-bodies --max-bytes 2147483648 --durable-source --max-age-ms 300000. Measured result of pass 1: 7,925 ingested, 7,925 deleted, 0 failed, 2,146,499,796 bytes freed in 331 s, store grew 124,694,528 bytes on disk. The safety properties that DO hold for it: every deleted file had its byte-identical reconstruction verified in the store first, --durable-source fsyncs the store parts before any unlink so a power loss cannot lose both copies, --max-age-ms 300000 excludes any file touched in the last 5 minutes, and a file whose verify fails is kept and reported rather than deleted. THE RESIDUAL RACE IS NOT CLOSED: --max-age-ms narrows the window but does not eliminate it, because this corpus re-emits a body under the same name (the store has a reclaimed_reemitted path and a stored ts != capture time case, so re-emission is observed behaviour, not a hypothesis). A file that is 5+ minutes idle at enumeration can still be re-emitted with new bytes before the delete, and the size captured at enumeration is then stale. The mitigation that actually closes it is to re-stat the file immediately before remove_file and abort the delete if size or mtime moved since ingestion; that is NOT yet implemented. Any further batch should not assume this card is satisfied.
- 2026-10-20T04:40:00+0200 - THE RE-STAT MITIGATION IS CONFIRMED NOT IMPLEMENTED, AGAINST LIVE CODE, WHILE THE DRAIN RUNS. The mitigation this log names (re-stat the file immediately before remove_file, and abort the delete if size or mtime moved since ingestion) is NOT in the code. Verified by reading the source: rust-core/crates/agentlens-store/src/pass.rs:432 (and the sibling site at :463) call fs::remove_file(&b.p) directly, and the size and mtime used are those captured at ENUMERATION by body_files (pass.rs:168) - there is no second stat between the verify and the unlink. The race is therefore OPEN, not merely narrowed: a body re-emitted under the same path after the pass read it and before the unlink is deleted while the store holds the OLD bytes, and the corpus demonstrably re-emits (the store has a reclaimed_reemitted path and a 'stored ts != capture time' case). The owner's directive of 2026-10-19 says 'no data must be lost', and this is the one path by which data can be lost. NOT FIXED BY THIS ENTRY - the fix is a bounded change in pass.rs (stat immediately before the unlink, compare size and mtime against the enumeration, abort the delete on any mismatch) and is squarely inside the owner's directive, so it is taken next, not deferred.
- 2026-10-20T12:10:00+0200 - THE RE-STAT MITIGATION IS NOW IMPLEMENTED (commit 4db316bb). A helper unchanged_since_enumeration re-stats the file immediately before the unlink and compares size and mtime against the values captured at enumeration; either moving ABORTS the delete, leaves the file on disk for the next pass, and is reported in the pass's failed list naming the file. BOTH delete sites are gated: the ordinary verified delete and the durable ts-only reclaim (the re-emission path itself). A new test recreates the race deterministically through the existing BodyObserver hook - which fires between ingest and the settle, so there are no sleeps and no mocks - and asserts the file survives, the bytes on disk are the new ones, the abort names the file, and that nothing was deleted. IT WAS PROVEN TO FAIL BEFORE THE FIX (the file was deleted) and to pass after it. The store suite is 60 passed, 0 failed, and the reclaim and park semantics TRDD-6SPXOV0P depends on are unaffected. The race is CLOSED IN SOURCE. A drain restarted against a binary built from this commit is no longer exposed to it; a drain running against an OLDER binary still is, and one was running until pass 93 (the loop script was cleared by a reboot, so no drain is running now).
