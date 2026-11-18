---
trdd-id: L9F3I0TC
title: Disk monitor records purgeable and important-usage available space
column: complete
status: archived
created: 2026-11-16T19:02:50+0100
updated: 2026-11-16T20:02:01+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-16T19:02:50+0100
---

# Disk monitor records purgeable and important-usage available space

Derived from TRDD-HTARKH87. The disk_volume columns purgeable_b and important_avail_b are written as NULL. The owner's order asked for used and free space 'real and virtual'; the purgeable / important-usage figures (what Finder shows, e.g. 137 GB available vs 45 GB free on 2026-11-16) are the most likely meaning of 'virtual' and are missing. Source: URLResourceValues volumeAvailableCapacityForImportantUsageKey (and ForOpportunisticUsage); needs a fast path inside the 60 s sample (a swift -e call costs seconds). Owner order verbatim: 'saving in a new dedicated duckdb table every 1 minute the datetime and the used and free disk space, real and virtual, with and without symlinks, with and without the trashbin'.

## Approval log

- 2026-11-16T19:02:50+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
2026-11-16T20:01+0100 — verified live: important_avail_b and purgeable_b populated since 4fdee385 (/System/Volumes/Data 20:00:58: avail 50.47 GB, important 141.32 GB, purgeable 90.85 GB; external volumes purgeable 0). NULL by design for /System/Volumes/VM (no important-usage value) and for one row where important < avail (a read race). Closing.
- 2026-11-16T20:02:01+0100 — COMPLETE by main-agent@agentlenspro. measured and verified live.

## Acceptance

- [x] disk_volume.important_avail_b is written from NSURL volumeAvailableCapacityForImportantUsage (4fdee385)
- [x] disk_volume.purgeable_b is written as important minus avail, NULL when the read is invalid (verified live 20:00:58: 90.85 GB on /System/Volumes/Data)
