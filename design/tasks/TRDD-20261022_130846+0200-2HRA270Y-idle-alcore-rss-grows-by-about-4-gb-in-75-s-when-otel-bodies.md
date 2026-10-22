---
trdd-id: 2HRA270Y
title: Idle alcore RSS grows by about 4 GB in 75 s when otel-bodies is present
column: todo
status: tasked
created: 2026-10-22T13:08:46+0200
updated: 2026-10-22T13:22:29+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-22T13:08:46+0200
---

# Idle alcore RSS grows by about 4 GB in 75 s when otel-bodies is present

Measured 2026-10-22 (docs_dev/20261022-bodies-discriminator.md, isolated clones, --no-log-scan, no ingest, one run per arm): RSS +4255 MB over 2-75 s with <data_dir>/otel-bodies present (21,495 files, 2.92 GB), +50 MB with it moved out. The burn bodies watcher retains only a few MB, so the reader responsible is not identified; code trace in progress (docs_dev/20261022-idle-bodies-reader.md). This is step 1 of the conversion order on TRDD-KBM09XHB and the largest single contributor to the TRDD-2JOIAH2G crash loop measured so far. Owner rule (KBM09XHB, 2026-10-22): body data is digested into DuckDB tables and read back as query answers; nothing corpus-sized resident in alcore's heap.

## Approval log

- 2026-10-22T13:08:46+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## STATE

2026-10-22: all measurements are RSS (not phys_footprint, which the guard kills on), one run per arm; heap attribution waits for docs_dev/20261022-climb-stacks.md.
File counts are per clone: 21,495 (discriminator clone), 21,820 (live count at MEASURE time), 21,948 (arm-C clone); files keep arriving live.
Arm B (otel-bodies moved out) does NOT isolate the reader: with no staged bodies, bodies_pass returns at chores.rs:324 before open_store and before load_pass_state, so arm B removes the files, the store open, and the 75 MB load of store/.pass-state.json together.
Arm C (every clone body future-dated, so the 10 s age gate admits none) still climbed to 5,576 MB. Confounds: staged bytes are non-zero so the pass still opens the store and parses the 75 MB .pass-state.json; future mtimes also make the bodies watcher see every file as fresh and make retention-by-age skip them. Candidates left: load_pass_state, open_store, the bodies watcher.
