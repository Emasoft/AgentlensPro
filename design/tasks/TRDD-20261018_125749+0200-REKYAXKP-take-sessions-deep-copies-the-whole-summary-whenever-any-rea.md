---
trdd-id: REKYAXKP
title: take_sessions deep-copies the whole summary whenever any reader holds the previous one
column: todo
status: tasked
created: 2026-10-18T12:57:49+0200
updated: 2026-10-18T12:57:54+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-18T12:57:49+0200
related-trdd: 2JOIAH2G
---

# take_sessions deep-copies the whole summary whenever any reader holds the previous one

## Mechanism

`take_sessions` (rust-core/crates/agentlens-core/src/summary_engine.rs:127-138) moves the previous summary sessions array out of its `Arc` with `Arc::try_unwrap`. When any reader still holds the previous summary (or its stripped twin), `try_unwrap` fails and the WHOLE `sessions` array is cloned instead (`SHARED_COPIES` counts it) — up to two full arrays per rebuild (summary + stripped). Every reader that holds the summary `Arc` while a rebuild lands therefore costs a full deep copy of the corpus summary.

## Measured (rig, scratchpad sharedcopies-run.txt, recorded on TRDD-2JOIAH2G)

- sharedCopies 0 -> 2 at +71 s, with footprint 1,590 -> 2,365 MB
- 3 at +116 s
- 5 at +132 s

## Holders found

- `composition_tick` (chores.rs): cloned both cache `Arc`s and serialized the ~70/63 MB caches off the lock — REMOVED under TRDD-2JOIAH2G (session counts now computed inside the lock block, no `Arc` leaves it).
- the burn tick (`run_burn_tick`, ui.rs): held `tick_summary` to the end of each 4 s tick — now dropped right after `burn_status_for` under TRDD-2JOIAH2G.
- every GET /api route handler calling `summary_now` on the live collector — still a holder; not addressed. Removing the two periodic holders is NOT claimed to fix the live collector.

## Candidate fixes

- store `sessions` as `Vec<Arc<Value>>` so a shared copy is refcount bumps, not a deep copy;
- or, when the previous summary is shared, do a fresh build instead of cloning the array.

Related: TRDD-2JOIAH2G (the crash-loop investigation that measured this).

## Approval log

- 2026-10-18T12:57:49+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
