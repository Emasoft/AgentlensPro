---
trdd-id: Z8B5BDB5
title: The rustOpenCode REAL opencode db parity test depends on this machine's live database and fails nondeterministically
column: todo
status: tasked
created: 2026-10-02T17:18:31+0200
updated: 2026-10-04T13:02:15+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-02T17:18:31+0200
---

# The rustOpenCode REAL opencode db parity test depends on this machine's live database and fails nondeterministically

The test 'rustOpenCode P3d cross-engine parity: the REAL opencode db on this machine parses identically (native WAL vs _mergeWal)' reads the live OpenCode database via the Rust parser. It failed when run ALONE on 2026-10-02 in a tree where no touched file relates to it. Pre-existence unproven: re-running it on commit e4dd8c0a's state is not possible without a git checkout, so it is not known whether it failed before. Proposal: skip the test when the live db is missing or WAL-active, or gate it behind an opt-in environment variable, so the suite is hermetic.

## Approval log

- 2026-10-02T17:18:31+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

- 2026-10-04T13:02:12+0200 — worker wB: NOT gated. After the YVQI5DYD snip fix the real-db test passes; the 2026-10-02 failure is most likely the same one-char divergence (unproven). No evidence of live-db drift, so no opt-in skip added; owner may still choose to gate it.
