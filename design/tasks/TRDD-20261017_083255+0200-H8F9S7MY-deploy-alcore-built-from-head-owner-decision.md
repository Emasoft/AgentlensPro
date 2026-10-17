---
trdd-id: H8F9S7MY
title: Deploy alcore built from HEAD (owner decision)
column: approval
status: tasked
created: 2026-10-17T08:32:55+0200
updated: 2026-10-17T08:42:54+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: infra
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-17T08:32:55+0200

---

# Deploy alcore built from HEAD (owner decision)

Owner-decision card. Several cards wait on a deploy of alcore built from the current tree, with codesign (see TRDD-M2VK8T4P for the codesign step): TRDD-N6A8VX3G box 3, the live boxes of TRDD-GVA8TTJF, TRDD-ZIWEB0UW and TRDD-9SOYXKNE. Measured 2026-10-17 by a read-only check: the deployed bin-native/darwin-arm64/alcore is dated 2026-10-03 13:04, so none of this month's fixes are live (including TRDD-1RJBOEI1's streaming boot compaction). The live collector is crash-looping: each run exits after about 2.5 minutes on 'RSS HARD CAP — phys_footprint 2206 MB > cap 2048 MB', after a state lock held 133077 ms at ui.rs:4173, and agentlenspro server status reported 20 quick crashes in revive backoff. TRDD-2JOIAH2G tracks the crash loop. A deploy and restart of the live collector is the owner's call; no agent does it without the owner's word.

## Approval log

- 2026-10-17T08:32:55+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-17T08:38:03+0200 — column → approval by main-agent@agentlenspro. waiting on the owner's decision to deploy alcore from HEAD; no agent acts on it

## Owner decision pending (2026-10-17)

- In approval because it waits on the owner's decision. Outside the ai-maestro harness the owner is the approver; min-approval-requirement stays none because the mandate was issued at none, and raising it is flagged MANDATE-FORGED by lint.
