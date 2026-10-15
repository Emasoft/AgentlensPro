---
trdd-id: 0R0NGVK6
title: A torn delta-log tail followed by any append makes every later boot fail
column: todo
status: tasked
created: 2026-10-15T05:17:50+0200
updated: 2026-10-15T05:17:50+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T05:17:50+0200
---

# A torn delta-log tail followed by any append makes every later boot fail

## Problem
`DeltaLog::read_lines` (rust-core/crates/agentlens-core/src/delta_log.rs:63-83) tolerates ONE torn trailing line and returns Err for a corrupt line anywhere else. `save` and `append_changed` (174-229) append and never check that the file ends with a newline. A process killed mid-append (RSS hard-cap exit, SIGKILL) leaves a torn last line. The next start loads fine (torn tail tolerated), but its next append is glued onto the fragment; the glued line is then mid-file and every later `load()` returns Err. For log-offsets and log-sessions that Err propagates out of `DurableState::restore` (log_reader.rs 874-875, 986), the sweeper reports it died during the boot sweep, and every later start fails the same way — a permanent start loop. body-links is healed by its boot compaction (TRDD-N6A8VX3G); log-offsets and log-sessions are not.

Evidence: VERIFIED by reading the code (main, 2026-10-15); not reproduced; whether it has happened on this machine is unchecked. TRDD-6B7VV2Z7 commit 1 adds appends during the startup sweep, where cap kills cluster, so this lands first.

## Fix direction
Before any append in `save`/`append_changed`, if the delta file is non-empty and does not end with a newline, truncate it to just after its last newline (0 if none). The dropped fragment is exactly what replay already ignores, so no record is lost; `load()` stays read-only. Test: write records, append a raw torn fragment, append again through the API, assert `load()` succeeds with every complete record. Mutation: remove the heal and `load()` returns Err.

## Acceptance
- [ ] heal before append in both append paths
- [ ] test plus recorded mutation result
- [ ] clippy -D warnings clean and cargo test -p agentlens-core green

## Approval log

- 2026-10-15T05:17:50+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
