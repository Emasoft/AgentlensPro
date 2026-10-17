---
trdd-id: O8MGRU72
title: DeltaLog compaction renames the new snapshot without fsync and then deletes the delta
column: todo
status: tasked
created: 2026-10-17T02:27:39+0200
updated: 2026-10-17T02:27:42+0200
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
---

# DeltaLog compaction renames the new snapshot without fsync and then deletes the delta

Found 2026-10-17 in the review of 5e39aa3b (TRDD-1RJBOEI1). It predates that commit: the old fs::write path had the same gap. DeltaLog compaction writes <snapshot>.tmp, verifies it by reading it back (which can be served from the page cache), renames it over the snapshot, then removes the delta. Nothing calls sync_all on the temp file before the rename or fsyncs the directory after. A power loss or kernel crash right after the rename can leave an empty or partial snapshot while the delta is already gone. For body-links that is the only copy of the request-response pairing data, and for log-sessions it is the card snapshot.

Fix direction: sync_all the temp file before the rename, fsync the parent directory after the rename and before removing the delta, and comment WHY. Measure the added time at boot on the 700k dataset.

## Approval log

- 2026-10-17T02:27:39+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Acceptance

- [ ] The temp snapshot is synced before the rename, and the directory is synced after the rename and before the delta is removed, in every compaction path (compact, compact_from_disk).
- [ ] The boot-time cost of the syncs on the 700k body-links dataset is measured and recorded.
