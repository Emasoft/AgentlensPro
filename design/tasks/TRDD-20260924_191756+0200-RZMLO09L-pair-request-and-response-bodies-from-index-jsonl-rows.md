---
trdd-id: RZMLO09L
title: Pair request and response bodies from index.jsonl rows
column: todo
status: tasked
created: 2026-09-24T19:17:56+0200
updated: 2026-09-24T19:17:56+0200
current-owner: emanuelesabetta
created-by: emanuelesabetta
task-type: feature
min-approval-requirement: none
assignee: emanuelesabetta
mandate: true
mandated-by: none
approved: true
approval-judge: emanuelesabetta
approval-datetime: 2026-09-24T19:17:56+0200
parent-trdd: ZQQYRYBO
---

# Pair request and response bodies from index.jsonl rows

Pair each captured request body with its response body using index.jsonl rows (request_id, message_id, message_uuid, request_file, response_file) instead of a request_body_id field - I12a found no such field exists. Parent: TRDD-ZQQYRYBO (I12). Caveats to design around: (1) rows exist for errored/aborted calls too, not just successful pairs; (2) our own drain process moves files out from under a reader mid-scan; (3) concurrent writers can produce torn/partial lines; (4) reads must be incremental via a persisted byte offset, never a full re-read of index.jsonl; (5) CC versions before 2.1.274 have no index.jsonl at all and need a fallback path; (6) index.jsonl's request_file/response_file paths are relative and must be resolved against the transcript's own directory.

## Approval log

- 2026-09-24T19:17:56+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
