---
trdd-id: OLKITCS7
title: A client request or a dependency's caught panic can still kill or restart-storm alcore after exit-on-panic
column: todo
status: tasked
created: 2026-10-16T09:26:09+0200
updated: 2026-10-16T09:26:28+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-16T09:26:09+0200
project-id: agentlenspro
---

# A client request or a dependency's caught panic can still kill or restart-storm alcore after exit-on-panic

Residual risks of TRDD-3RVTC1HY (542ceca2), which made every panic exit alcore; that card is complete and frozen, so they live here. (1) TRDD-HFY30YBT classified only the unwrap and expect sites a residual survey listed. Other request-path panic forms were never surveyed in ui.rs, mcp.rs, mcp_tools.rs and lib.rs ingest_post and ingest_parsed: str slicing at a byte index that is not a char boundary on client text, slice and array indexing, integer division or remainder by a client-supplied zero, explicit panic!, unreachable! and assert!, and arithmetic overflow if overflow-checks is on in the release profile. (2) UNDECIDED since 3RVTC1HY: whether a dependency (duckdb-rs, hyper, notify, tokio) panics and catches it internally as normal control flow; the hook exits before any unwind, so such a panic would now kill the process. (3) A deterministic panic more than 5 minutes after start escapes REVIVE_CRASH_WINDOW_MS (src/cli/hookHandlers.ts:159) and restarts with no backoff, so one repeatable request-triggered panic could cause a restart storm, each restart re-running the boot sweep. (4) The tools asset check (tests/ui.rs, mcp_endpoint_serves_the_frozen_tool_schemas_and_implements_every_one) runs in ci.yml:299 only; publish.yml builds release binaries without cargo test, so a publish from a commit that CI never passed would skip it.

## Approval log

- 2026-10-16T09:26:09+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Acceptance

- [ ] Every request-path panic source of the forms in (1) is classified reachable or not, with file:line.
- [ ] Every reachable one returns an error response instead, with a test that sends that input.
- [ ] Question (2) is answered with evidence from the dependencies' source (catch_unwind uses on threads alcore shares).
- [ ] The late-panic restart has a backoff, or a recorded measured reason why none is needed.

## Notes and lessons learned

2026-10-16: created from the review of c5136f6d: closing 3RVTC1HY and HFY30YBT would otherwise have frozen these risks out of sight.
