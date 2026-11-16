---
trdd-id: O8MGRU72
title: DeltaLog compaction renames the new snapshot without fsync and then deletes the delta
column: complete
status: archived
created: 2026-10-17T02:27:39+0200
updated: 2026-10-17T04:50:18+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-17T02:27:39+0200
implementation-commits: [3a9ec263, 45a7711a, 14e33321]
---

# DeltaLog compaction renames the new snapshot without fsync and then deletes the delta

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-10-17

- Implemented in 3a9ec263 (sync the temp snapshot and the directory before the delta is dropped), 45a7711a (a filesystem that cannot sync a directory logs and proceeds), 14e33321 (the log line carries the alcore timestamp prefix).
- Acceptance 1 met: both compaction paths (compact via save/compact_now, and compact_from_disk) go through commit_verified, the one fs::rename site; temp sync_all before the rename, directory sync after the rename and before the delta removal. Evidence: docs_dev/20261017-o8mgru72-fsync-report.md.
- Acceptance 2 met: boot cost of compact_from_disk on the 700k body-links dataset (271 MB snapshot) is about +40 ms on the minimum and +65 ms on the median (about 2%); peak memory unchanged. Evidence: same report, section "Boot cost".
- Final checks (docs_dev/20261017-o8mgru72-final-checks.md): card_reuse 20 passed 0 failed; agentlens-core --no-fail-fast 859 passed 0 failed; clippy -D warnings clean.
- NOT RESOLVED (a): a plain run had one intermittent failure of watcher_advances_a_card_on_growth_without_waiting_for_the_backstop (assertion "re-read from byte 0 sees the grown file", left None right Some(4)); it passed on rerun. TRDD-WBYDQH8K tracks that test's intermittent failures, but its card does not name this exact assertion.
- NOT RESOLVED (b): one earlier full run was SIGKILLed (exit 137) inside tests/card_store.rs a_restore_sized_bulk_load_stays_inside_the_memory_limit at load average about 240. Cause unmeasured: a memory limiter, the harness RSS guard, or a regression from the added sync/read-back are all unexcluded. The same test passed in the 859-pass run. Partial log: reports_dev/o8mgru72-agentlens-core-test-killed-run1.txt (repo-relative). Recorded also on TRDD-9VX3WTGU.
- NOT RESOLVED (c): the Linux behaviour of the /dev/null sync test is unmeasured (CI runs on main only).
- NOT RESOLVED (d): the running alcore binary on this machine is NOT redeployed.
- NEXT ACTION: none, closed.

Found 2026-10-17 in the review of 5e39aa3b (TRDD-1RJBOEI1). It predates that commit: the old fs::write path had the same gap. DeltaLog compaction writes <snapshot>.tmp, verifies it by reading it back (which can be served from the page cache), renames it over the snapshot, then removes the delta. Nothing calls sync_all on the temp file before the rename or fsyncs the directory after. A power loss or kernel crash right after the rename can leave an empty or partial snapshot while the delta is already gone. For body-links that is the only copy of the request-response pairing data, and for log-sessions it is the card snapshot.

Fix direction: sync_all the temp file before the rename, fsync the parent directory after the rename and before removing the delta, and comment WHY. Measure the added time at boot on the 700k dataset.

## Approval log

- 2026-10-17T02:27:39+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-17T04:50:18+0200 — COMPLETE by main-agent@agentlenspro. Fsync fix landed in 3a9ec263, 45a7711a, 14e33321; both acceptance boxes met; open residue recorded on the STATE block..

## Acceptance

- [x] The temp snapshot is synced before the rename, and the directory is synced after the rename and before the delta is removed, in every compaction path (compact, compact_from_disk).
- [x] The boot-time cost of the syncs on the 700k body-links dataset is measured and recorded.
