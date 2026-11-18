---
trdd-id: NY373D41
title: cache-state and cache-expired can answer from an older write-ahead row when a newer sample of the session is in a sealed part
column: backburner
status: tasked
created: 2026-11-18T09:19:39+0100
updated: 2026-11-18T09:19:39+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-18T09:19:39+0100
parent-trdd: ETFX9JFM
---

# cache-state and cache-expired can answer from an older write-ahead row when a newer sample of the session is in a sealed part

Found while designing TRDD-ETFX9JFM (2026-11-18), not observed. The status-line store has two writers (the server and the hook), each with its own write-ahead file. The cache verbs take the newest row of the write-ahead files and ask the sealed parts only when no write-ahead row matches. If the newest sample of a session was written by one writer and sealed into a part, while an older sample of the same session still sits in the write-ahead file of the other writer, the verbs answer from the older row. Needs: a reproduction on a fixture store (one older row in wal-cli.ndjson, one newer row only in a part), then either a check of part mtimes against the newest write-ahead row or always asking the store. Cost of always asking the store was measured at about 0.1 s CPU on 2026-11-18 (TRDD-ETFX9JFM).

## Approval log

- 2026-11-18T09:19:39+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
