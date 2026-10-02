---
trdd-id: 23PV56JJ
title: A panic while holding the CoreState lock kills the log sweeper permanently
column: todo
status: tasked
created: 2026-10-02T22:15:49+0200
updated: 2026-10-02T22:16:07+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-02T22:15:49+0200
---

# A panic while holding the CoreState lock kills the log sweeper permanently

## Approval log

- 2026-10-02T22:15:49+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-02T22:16:07+0200 — column → todo by main-agent@agentlenspro. real production risk: silent permanent loss of log ingestion

## Problem

CoreState::lock_timed (rust-core/crates/agentlens-core/src/lib.rs:1231) returns LockResult and propagates poisoning; the log sweeper calls state.lock_timed().expect("core state") (log_reader.rs:1506). Any panic by any thread while holding the CoreState lock poisons it, and the sweeper thread then panics and never restarts: log ingestion stops silently while the server keeps answering HTTP — the RSS guard and the supervisor only watch process exit, so nothing recovers it. Reproduced in tests: log_reader_parity's watcher test asserts while holding the lock and the 'log-sweeper' thread then panics with PoisonError (seen on unmodified main and on branches, 2026-10-02). Smallest fix: recover the poisoned guard inside lock_timed (the shared function every caller routes through) with into_inner(), log the poisoning once at warn, and add a test that panics while holding the lock and proves the next lock_timed succeeds and the sweeper keeps sweeping.
