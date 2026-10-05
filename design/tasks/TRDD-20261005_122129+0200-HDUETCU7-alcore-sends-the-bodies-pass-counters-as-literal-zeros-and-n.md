---
trdd-id: HDUETCU7
title: alcore sends the bodies pass counters as literal zeros and never sends the cumulative reclaim fields the status line was built to render
column: todo
status: tasked
created: 2026-10-05T12:21:29+0200
updated: 2026-10-05T12:21:37+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-05T12:21:29+0200
related: [FGN5TY7E, C5L779YI, U0L78B3Z]
---

# alcore sends the bodies pass counters as literal zeros and never sends the cumulative reclaim fields the status line was built to render

Split out of TRDD-FGN5TY7E box 4 on 2026-10-05, by the reviewing session under the owner order of that date.

Read by the main agent at commit 508f023d: rust-core/crates/agentlens-core/src/server_stats.rs sends bodies.lastPass and persistence.bodiesLastPurge as literal zeros (about lines 548 and 542) and sends neither reclaimedSinceBoot nor lastNonZeroPassAt. A comment in the persistence block (about line 538) says the bodies purge is not ported; by a worker's read on 2026-10-05 that comment is stale. src/cli/serverControl.ts declares both cumulative fields as optional (about lines 632 and 633) and renders them only when present (about lines 837 to 839); by the source, under alcore the status line would therefore read "last pass archived 0" on every call. Nobody rendered it for this card and the live collector was not queried.

By the same worker's read (docs_dev, gitignored; not re-read by the main agent): bodies_pass in chores.rs (about line 250) runs on the 60-second tick, ingests each live body into the store and deletes the raw file, and drains at age 0 over the bodiesMaxGb cap. It counts ingested, deleted, bytes freed, re-emitted and failed as local variables that reach only a log line; no struct, atomic or timestamp holds them, and kept files and bytes are not counted. bodies_purge in body_archive.rs runs only on POST /api/bodies/purge. TRDD-C5L779YI (archived, complete) ticked "server status stops inviting this misreading" on the cumulative line; its own text says the server tracks and serves both fields, which was the TypeScript server retired in commit 567fc5c2. Whether that misreading can still occur now that TRDD-Z53IJFE9 is removing the spool was not established. No open card was found owning these counters (a search of purge, reclaim, lastPass and body_archive; the purge search was cut at 40 rows).

## Acceptance

- [ ] bodies_pass publishes the files deleted and bytes freed that it counts today, and records the time of the last pass that deleted anything (not held anywhere today), where server_stats.rs can read it; the emitter sends real values for lastPass, reclaimedSinceBoot and lastNonZeroPassAt in place of the literals. Kept files and bytes are not counted today; either count them or stop sending them.
- [ ] A Rust test runs a pass that deletes at least one file and asserts the emitted figures are non-zero; it goes red when the literals are restored.
- [ ] The stale comment at server_stats.rs about line 538 says what is and is not ported.
- [ ] persistence.bodiesLastPurge is either fed from the same counts or removed, with every reader of it named here first.

Removing the cumulative line and its two declarations instead is the owner's decision; record it here and on TRDD-FGN5TY7E before any declaration is removed. No priority was chosen for this card; TRDD-FGN5TY7E, which it was split from, is high.

## Approval log

- 2026-10-05T12:21:29+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
