---
trdd-id: PQ40PZ9D
title: The flood bench cannot grow a transcript so no arm drives log-sweeper rebuilds
column: todo
created: 2026-09-23T20:20:27+0200
updated: 2026-09-23T20:20:27+0200
current-owner: main-session
created-by: main-session
task-type: infra
min-approval-requirement: none
assignee: main-session
mandate: true
mandated-by: none
approved: true
approval-judge: main-session
approval-datetime: 2026-09-23T20:20:27+0200
---

# The flood bench cannot grow a transcript so no arm drives log-sweeper rebuilds

EQCGAVGV's arms need a log-growth driver: put_log_session (rust-core/crates/agentlens-core/src/lib.rs:292) bumps data_version whenever the log sweeper updates a session card, so transcript growth drives summary rebuilds, and no current flood-bench mode grows a transcript.

Add a mode to scripts/bench/alcore-ingest-flood.mjs that appends synthetic Claude Code JSONL (assistant turns carrying usage) to <isolated HOME>/.claude/projects/<slug>/<session>.jsonl at a configurable lines/s, refusing the passwd user's real ~/.claude (os.userInfo().homedir).

Acceptance: [ ] the isolated instance's summary misses and session-card count rise with the appended lines; [ ] refuses the real home; [ ] the line shape is parsed by agentlens-logscan's Claude parser (cite it). related: [EQCGAVGV, C19SUVPH].

## Approval log

- 2026-09-23T20:20:27+0200 — MANDATE issued by main-session (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
