---
trdd-id: N4ZXDCA8
title: bodies_evidence reads every parts file per chunk
column: backburner
status: tasked
created: 2026-10-23T02:43:20+0200
updated: 2026-10-23T02:43:20+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-23T02:43:20+0200
---

# bodies_evidence reads every parts file per chunk

agentlens-store/src/bodies_evidence.rs:252 and :298 run parquet_scan(store_dir, PARTS_DIR) WHERE body_id IN (...) per chunk, the same O(files) shape TRDD-1FWN9XBS removed from reconstruct_body and reconstruct_chunk. It takes store_dir, not &Store, so it needs the Store (or a known_part lookup) handed in. Check which callers use it (export data-loss proof?) before choosing. Found during TRDD-1FWN9XBS Change 1.

## Approval log

- 2026-10-23T02:43:20+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
