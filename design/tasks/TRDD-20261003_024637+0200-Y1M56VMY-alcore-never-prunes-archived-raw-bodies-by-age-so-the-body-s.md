---
trdd-id: Y1M56VMY
title: alcore never prunes archived raw bodies by age so the body store grows without bound now that capture is mandatory
column: todo
status: tasked
created: 2026-10-03T02:46:37+0200
updated: 2026-10-19T00:53:07+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-03T02:46:37+0200
derived: false
npt: []
eht: []
---

# alcore never prunes archived raw bodies by age so the body store grows without bound now that capture is mandatory

## Problem
Owner order 2026-10-02: raw body dumps are MANDATORY (reverses TRDD-BKF5NZD3; TS side b867797a, Rust side in flight under TRDD-9VX3WTGU). With capture always on, the only bound on body data is `bodiesMaxGb` (default 8 GB, rust-core/crates/agentlens-core/src/retention_config.rs:23), and it bounds only the LIVE otel-bodies dir: over the cap, chores.rs bodies_pass ingests at age 0 into the store and deletes the live files. Nothing prunes the store itself.
`bodiesRetentionDays` (default 31, retention_config.rs:24) has NO Rust consumer: grep for BODIES_RETENTION_DAYS finds only its definition and its entry in the knob table (retention_config.rs:31). The TS side reads it (src/retentionConfig.ts) but the TS server is retired (567fc5c2). So the configured 31-day body retention is advertised and not enforced.
Comparable enforced knobs to copy the shape from: spans `run_retention` (agentlens-spanstore/src/writer.rs:578, whole expired segments only, floor of 1 day) and hook events `purge_buckets` (hook_events.rs:59).
## Also missing
The over-cap valve (bodiesMaxGb) has no dedicated test; chores_bodies_spool_drain.rs covers only the 10 s age drain.
## Done when
1. alcore deletes stored body data older than bodiesRetentionDays (whole units only, never a partial one, floor 1 day), on the chores tick. BEFORE coding, name the store's deletable unit (is the Parquet store partitioned by day?) and whether a newer kept turn can reference content stored in an older unit (pass.rs dedups consecutive turns against each other via span_cache); an age prune must never delete a unit a kept turn still needs.
2. A test fails if the age prune is disabled.
3. src/telemetryConfig.ts:136-139 comment made true.

## Approval log

- 2026-10-03T02:46:37+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Premise verification (2026-10-03)

- Round 1 (keyword-filtered grep) was too narrow; round 2 listed EVERY non-test remove_file/remove_dir/fs::rename/DROP TABLE/TRUNCATE across all five crates (hits above each file's #[cfg(test)] line). Body-relevant hits: agentlens-store/src/pass.rs:381,412 delete LIVE body files after store-proof (ingest); pass.rs:225,230 are relocate_stranded_file (225 removes a bad copy, 230 unlinks the source after a byte-verified copy); agentlens-core/src/body_archive.rs:353 bodies_purge (manual POST /api/bodies/purge, deletes legacy archive volumes once proven in the store); agentlens-store/src/lib.rs:296 DELETE FROM empties the in-memory table after COPY to Parquet. Age-based deletions seen: chores.rs:242 clean_spill_dirs (DuckDB spill files), agentlens-spanstore writer.rs run_retention (day-keyed span segments), hook_events.rs:91 purge_buckets (hook ndjson buckets); statusline_store.rs:549 and hook_events.rs:340/359 were not read. None touches the body store. SQL check: every non-test DELETE FROM/OVERWRITE in all crates is per-call forensics row replacement, a session_summary/cards clear, or the in-memory staging table emptied after COPY; the body store refuses to overwrite a part (agentlens-store/src/lib.rs:263-265). Not covered: production code that follows an inline #[cfg(test)] item (the scan cut each file at its first #[cfg(test)]). Conclusion: no code deletes stored body Parquet data by age.
- INFERRED, not read: TRDD-7NHUU6GK's "archive retention gate" is probably the bodies_purge proof gate; read that card before implementing.
- False doctrine to fix with this card: src/telemetryConfig.ts:136-139 comment says "archives are deleted after bodiesRetentionDays" — not true under alcore.

## Field provenance

- mandate: true was written by `trddgrep new` at mint; it is NOT an owner mandate for this card (trddgrep refuses to change it outside create/approve). The owner order behind it is only the 2026-10-02 order making raw-body capture mandatory.

## STATE

2026-10-19T00:47:39+0200 — OWNER: this card owns the unbounded archive failure. `bodiesMaxGb` caps only the live raw-body spool; `bodiesRetentionDays` has no Rust consumer, so archived/store data remains unbounded.
Related migration architecture: TRDD-LHCHVK9Z. Capacity and reserve proof: TRDD-TXRRF34L. Full manifest reconciliation: TRDD-JK4I9MFY. Separately authorized live drain and verified deletion: TRDD-IGPWXZ1M. This retention card is not replaced by those cards.
Execution state: no migration and no deletion has run. The 2026-10-19 card work documents the approved design breakdown only; TRDD-IGPWXZ1M still requires final user confirmation of the exact destructive command and affected sources.
