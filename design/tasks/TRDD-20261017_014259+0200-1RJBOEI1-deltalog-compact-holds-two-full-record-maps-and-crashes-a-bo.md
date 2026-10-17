---
trdd-id: 1RJBOEI1
title: DeltaLog compact holds two full record maps and crashes a boot once body-links passes roughly 430k records
column: todo
status: tasked
created: 2026-10-17T01:42:59+0200
updated: 2026-10-17T02:27:00+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-17T01:42:59+0200
implementation-commits: [5e39aa3b]
---

# DeltaLog compact holds two full record maps and crashes a boot once body-links passes roughly 430k records

MEASURED 2026-10-17 (docs_dev/20261017-ajgtq007-streaming-report.md, worker-run in a separate process on the 700k-record body-links dataset): DeltaLog::compact() peaks at 3337.3 MiB, over alcore's 2048 MiB RSS cap. It holds the records, the whole new snapshot body as one String, and a second full map from replaying the temp snapshot for verification.

Why it is release-critical: N6A8VX3G's body-links writer is in HEAD, the log has no retention, and boot compaction (log_reader.rs, the body-links compact at boot) runs at every start. A linear estimate, inferred and not measured, puts the cap crossing near 430k records, lower once alcore's own resident footprint is counted. Past that point every boot dies during compaction: a new crash loop with a predictable arrival. Live ~/.agentlens has no body-links file today.

Fix direction: stream compaction. Write the new snapshot line by line from the streaming replay (TRDD-AJGTQ007's index_files/visit_winners) into the temp file, and verify by re-indexing the temp file and comparing count plus a per-record hash, instead of holding a second map.

## Approval log

- 2026-10-17T01:42:59+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Acceptance

- [ ] compact() on the 700k-record body-links dataset peaks under 1024 MiB phys_footprint (half the 2048 MiB cap, leaving room for alcore's resident footprint), measured in a separate process; the target may only be tightened.
- [ ] Compaction still verifies the new snapshot from disk before replacing the old one (count and every record), and the delta_log and card_reuse tests pass.
